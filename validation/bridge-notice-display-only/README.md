# 桥接被动通知只展示验证（2026-11-12）

任务：`k-e8730699375d`（run-0b840b46685b）。本记录覆盖隔离项目、真实本地 Knit CLI 与公开 Pi API 替身；不启动真实模型，不在真实 Pi `/reload` 或 Rex 卡片上做目视验收（任务已列为延期）。

本次实施继承失败 run-2c54709c7fe4 的残留：`.pi/extensions/knit.ts`、`assets/templates/pi/extensions/knit.ts`、`test/bridge-query.test.mjs`、`test/host-selection.test.mjs`、`docs/design/DESIGN.md`。开工前逐字核对两份桥接一致，残留改动与 design.md 的实施项一致，未重写无关部分。

## 实现要点

- `needsAction` 分类不变：`failed`／`cancelled`／`completed && acceptance !== completed`。
- 需处理：`pi.sendMessage({ customType: "knit.notice", … }, { deliverAs: "followUp", triggerTurn: true })`，成功后另追加不带 `text` 的去重条目。
- 被动：只 `pi.appendEntry(NOTICE_ENTRY, { runId, state, acceptance, signature, text })`，不调用 `pi.sendMessage`，不进任何一轮模型上下文，也不触发轮次。
- 桥接注册 `knit.notice` 的 entry renderer：带 `text` 的条目渲染为 `[knit.notice]` 标签＋正文卡片；去重条目、旧去重条目与异常数据返回 `undefined`，不出现第二张卡片。宿主 TUI 包用非字面量说明符动态导入，模板仍只静态依赖 node 内建模块。
- `docs/design/DESIGN.md` §9.3 同步为「被动只追加 `knit.notice` 条目并由 entry renderer 展示，不进模型上下文；只有需处理通知进入上下文并唤醒」；`docs/design/OPERATIONS.md` 核对后无重复的被动通知描述，未改动。

## 运行命令与结果

仓库根目录，2026-11-12（本地时间）：

```sh
npm run -s typecheck          # exit 0
npm run -s build              # exit 0
node --test test/bridge-query.test.mjs      # 23/23 pass
node --test test/host-selection.test.mjs    # 11/11 pass
node --test test/m1-cli.test.mjs test/scenarios.test.mjs test/init.test.mjs   # 52/52 pass
npm test                      # 普通终端：739/739 pass，exit 0（日志：/tmp/knit-npm-test-normal-1794497851.log）
npm test                      # Rex 终端新建专用窗口：739/739 pass，exit 0（日志：/tmp/knit-npm-test-rex.log）
```

`git diff --check` 无输出；`cmp .pi/extensions/knit.ts assets/templates/pi/extensions/knit.ts` 一致；桥接全文无 `nextTurn`。

## 场景对应

| 场景 | 实际证据 |
| --- | --- |
| R1.S1 完成且已接收 | `test/bridge-query.test.mjs` 终态通知用例：`host.messages.length === 0`；恰一条 `knit.notice` 条目，`data` 含 `signature`／`runId`／`state`／`acceptance`／`text`；renderer 组件输出含 `[knit.notice]` 与完整文案。 |
| R1.S2 流式期间到达的被动终态 | 被动路径只有 `appendEntry`（用例断言无 `sendMessage`），桥接不读 busy／idle 状态；不触发轮次与不进入上下文由宿主 custom entry 语义保证。真实流式目视未做（延期）。 |
| R1.S3 重复扫描不重复展示 | 同一 `agent_settled` 再执行一次：消息数 0、`knit.notice` 条目数仍为 1。 |
| R2.S1 失败、取消或结果待接收 | 待接收与 `failed` 用例均断言 `{ deliverAs: "followUp", triggerTurn: true }`，文案含标题、阶段、短 run ID、完整 run ID 与「不要重复实施」；`cancelled` 由 `needsAction` 真值表覆盖。 |
| R2.S2 去重条目不重复展示 | 待处理／失败去重条目 `data` 不含 `text`，renderer 返回 `undefined`；旧无 `text` 条目与空 `text` 数据同样不渲染。 |
| R3.S1 双份桥接与文档 | 两份桥接逐字一致；host-selection 用例断言被动分支无 `sendMessage`、注册了 `NOTICE_ENTRY` renderer、全文无 `nextTurn`；DESIGN §9.3 断言写明只展示、不进上下文。 |

## 未验证／延期

- 真实 Pi `/reload`（或重启）后被动通知可见、不唤醒、不进上下文。
- 真实 Rex 终端中的卡片目视与流式期间插入位置。
- 以上不影响本 run 的替身级与全量回归结果；不能据此宣称真实宿主验收完成。
