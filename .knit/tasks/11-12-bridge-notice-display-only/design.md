# 实施设计：通知按类型投递

目标、范围与验收以 task.md 为准；本文件只定实现方式与已核实的宿主事实。

## 已核实的宿主事实（Pi 1.5.2，本机）

- `pi.appendEntry(customType, data)` 写入 custom entry 并发出 `entry_appended`；交互模式收到后调用 `addCustomEntryToChat`，流式期间插到流式组件之前，不产生消息、不触发轮次（`dist/core/agent-session.js:2879`、`dist/modes/interactive/interactive-mode.js:2883`、`:3242`）。custom entry 不进入 LLM 上下文（`docs/extensions.md:1685`）。
- 续接／reload 重建会话记录时同样对每条 custom entry 调 `addCustomEntryToChat`（`interactive-mode.js:3354`），所以被动卡片可重现。
- `CustomEntryComponent`（`dist/modes/interactive/components/custom-entry.js`）调用 `renderer(entry, { expanded, keyText, keyHint }, theme)`：返回 `undefined` 时整条不显示；有返回值时宿主自己在前面加一行 `Spacer(1)`，渲染器只提供内容；渲染器抛错时宿主显示错误卡片。
- 默认 custom message 卡片外观（`components/custom-message.js`）：`Box(outputPad=1, 1, bg customMessageBg)`，内含粗体标签 `[customType]`（`customMessageLabel` 色）、`Spacer(1)`、正文（`customMessageText` 色）。
- 探针（主会话 2026-11-12 实测，`pi --no-extensions -e probe.ts -p`）：扩展内 `await import("@earendil-works/pi-tui")` 字面量与变量说明符都能解析到宿主副本，`Box`／`Text`／`Spacer` 可用，`box.render(40)` 按 CJK 宽度正确折行；`pi.registerEntryRenderer` 在 print 模式下也是函数。
- entry renderer 自 Pi 0.80.4 起提供，早于 Knit 验证过的 1.4.0／1.5.x，不加版本守卫。

## 约束

- 桥接模板目前只依赖 node 内建模块；`test/bridge-query.test.mjs` 的 `loadBridge` 用 `tsc --moduleResolution node10` 编译模板，再在测试项目里直接 `import`，仓库 `node_modules` 没有 `@earendil-works/pi-tui`。所以不能写静态 `import … from "@earendil-works/pi-tui"`（编译与加载都会失败），也不为此新增依赖。

## 实现

两份桥接（`assets/templates/pi/extensions/knit.ts`、`.pi/extensions/knit.ts`）逐字一致，先改模板再原样复制。

1. 宿主 TUI 组件按需加载：工厂函数内（已是 `async`）用非字面量说明符动态导入，失败返回 `null`，不抛出。

   ```ts
   const TUI_MODULE = "@earendil-works/pi-tui";
   async function loadTui(): Promise<any | null> {
     try {
       const tui: any = await import(TUI_MODULE);
       return typeof tui?.Box === "function" && typeof tui?.Text === "function" && typeof tui?.Spacer === "function" ? tui : null;
     } catch {
       return null;
     }
   }
   ```

2. 注册渲染器（工厂内、注册命令／事件处附近）：

   ```ts
   pi.registerEntryRenderer(NOTICE_ENTRY, (entry: any, _options: any, theme: any) => noticeCard(tui, entry?.data, theme));
   ```

   `noticeCard(tui, data, theme)`：
   - `data.text` 不是非空字符串 → 返回 `undefined`（需处理通知的去重条目、旧去重条目不渲染）。
   - `tui !== null` → `new tui.Box(1, 1, (t) => theme.bg("customMessageBg", t))`，依次加 `Text(theme.fg("customMessageLabel", theme.bold("[knit.notice]")), 0, 0)`、`Spacer(1)`、`Text(theme.fg("customMessageText", data.text), 0, 0)`；不自己加前置空行。
   - `tui === null`（非 Pi 加载器、测试替身）→ 返回无依赖的最小组件 `{ render: () => ["[knit.notice]", "", ...data.text.split("\n")], invalidate: () => {} }`。
   - `theme` 的 `fg`／`bg`／`bold` 缺失时按原文输出（替身里 theme 可为空对象），不抛错。

3. `scanRuns` 投递分流（文案、签名、分支／会话过滤、诊断事件名不变）：

   ```ts
   const details = { runId: view.runId, state: noticeState, acceptance: acceptanceState, signature };
   try {
     if (needsAction) {
       pi.sendMessage({ customType: NOTICE_ENTRY, content: text, display: true, details }, { deliverAs: "followUp", triggerTurn: true });
       pi.appendEntry(NOTICE_ENTRY, { signature, runId: view.runId, state: noticeState });
     } else {
       pi.appendEntry(NOTICE_ENTRY, { ...details, text });
     }
     diag("notice_sent", { runId: view.runId, state: noticeState });
   } catch (error) {
     diag("notice_failed", { runId: view.runId, reason: String(error) });
   }
   ```

   全文件不再出现 `nextTurn`。同步修正 `scanRuns` 内两处注释（`--since` 说明与 `needsAction` 说明）：被动通知「只展示、不进上下文」。

4. `notified()` 不改：仍按 `knit.notice` 条目的 `data.signature` 去重，两种条目都带 `signature`。

## 测试

- `makeHostStub`（`test/bridge-query.test.mjs`）：补 `registerEntryRenderer: (customType, renderer) => entryRenderers.set(customType, renderer)`，并把 `entryRenderers` 暴露给用例。
- `test/bridge-query.test.mjs` 终态通知用例：
  - completed + 已接收：`host.messages.length === 0`；`host.entries` 中恰有一条 `knit.notice`，`data` 含 `signature`／`runId`／`state`／`acceptance`／`text`，`text` 满足原有标题、阶段、短 run ID、完整 run ID 断言；用捕获的渲染器渲染该条目，返回组件且 `render(80)` 输出含 `[knit.notice]` 与文案。
  - 再次 `agent_settled`：消息数与 `knit.notice` 条目数不变（去重）。
  - 结果待接收、failed：各新增一条消息，选项为 `{ deliverAs: "followUp", triggerTurn: true }`；对应去重条目不带 `text`，渲染器对其返回 `undefined`。
  - 原用例里按下标取 `host.messages[n]` 的断言随消息总数变化同步调整，不能只改断言文字。
- `test/host-selection.test.mjs` 通知规则用例：改标题；保留两份桥接一致与 `needsAction` 真值表；断言需处理分支 `followUp` + `triggerTurn: true`、全文无 `nextTurn`、被动分支为 `appendEntry` 且不含 `sendMessage`、注册了 `NOTICE_ENTRY` 的 entry renderer；DESIGN §9.3 断言改为「不再含 nextTurn，写明被动通知只展示、不进上下文」。
- 其它引用桥接文本的测试（`test/m1-cli.test.mjs`、`test/scenarios.test.mjs`、`test/init.test.mjs`）若因模板变化失败，按实际原因处理并在报告中说明。

## 文档

- `docs/design/DESIGN.md` §9.3：把「首次观察时已完成且已接收的 run 以 nextTurn 进入下一轮上下文，只展示、不启动模型轮次」替换为「只追加 `knit.notice` 条目并由桥接注册的 entry renderer 在会话记录中展示，不进入任何一轮模型上下文，也不启动模型轮次；续接／reload 后按条目重现」，并核对同段「按 run ID／终态版本检查已有原生通知去重」等措辞与新行为一致。
- `docs/design/OPERATIONS.md`：只核对是否有重复的被动通知描述，有则同步，没有不改。
- 历史档案（`docs/history/`、已归档任务）不改。

## 验证

`npm run -s typecheck`、`npm run -s build`、`node --test test/bridge-query.test.mjs`、`node --test test/host-selection.test.mjs`，另跑 `node --test test/m1-cli.test.mjs test/scenarios.test.mjs test/init.test.mjs` 确认模板相关断言。工作区有其它任务未提交的改动；出现与本任务无关的既有失败时，用 `git stash` 以外的方式说明基线（不得改动或还原他人改动），在报告里写清失败用例与原因。

延期项不变：真实 Pi `/reload` 与 Rex 终端下的目视验收不在本 run 宣称完成。
