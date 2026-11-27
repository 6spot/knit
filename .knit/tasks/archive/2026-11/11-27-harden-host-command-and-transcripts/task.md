---
id: k-98e125987b31
title: 封堵 Shell 交付与派发钩子绕过、消除误伤并加固桌面转录
status: delivered
stage: null
verification: independent
parent: k-8d244665f694
dependsOn: []
priority: P0
createdAt: 2026-11-27T13:37:25.722Z
---

## 目标与范围

全面加固四大主会话宿主（Pi、Antigravity、WorkBuddy、Qoder）的命令拦截、交付授权核对与会话状态容错：封堵 `host-command.ts` 中标准 Shell 语法层面的门禁绕过，消除对 `--help`、ANSI-C `$'...'`、`--dir $VAR` 等正常命令的高频误伤，统一并加固 WorkBuddy/Qoder 桌面转录解析，以及修补 Pi 桥接并行取消监听与 Antigravity 规则文案错误。

### 具体改动与思路

1. **Shell 钩子绕过封堵与误伤解耦（`src/application/host-command.ts`）**：
   - **封堵绕过**：`eval` 跳过前导 `--`；`executableIndex` 补齐 `env`（`-S`/`--split-string`/`-P`/`-a`/`--argv0`）、`exec -a` 及常见包装器（`nohup`/`nice`/`timeout`/`caffeinate`），遇 `env -S` 递归检查拆分字符串；对非 `-c` 的 `sh`/`bash`/`zsh`/`dash`/`ksh`（如 here-string `<<<`、here-doc `<<EOF`、管道输入）、`source`/`.` 以及动态可执行名（`$CMD`），若调用上下文包含 `knit` 则保守按 `deliver`/`start` 拦截。
   - **消除高频误伤**：识别纯 `--help`/`-h` 子命令放行（避免 `knit deliver --help` 被报无授权、`knit run start --help` 在桌面宿主被拒）；`literal()` 支持静态无展开风险的 ANSI-C `$'...'` 解码；将 `--message`/`--dir` 的动态不确定性与静态 `--authorization` 解耦，不因 `--dir $ROOT` 或 `--message "${X:-y}"` 否定合法的静态原话；使 `knit deliver "$ID" --preview` 也能在确认安全前提下正常识别 `--preview`（或与参数顺序无关地准确识别明确静态 `--preview`）；使 `canSkipHostCommand` 与 `inspectCall` 实际检查集合保持一致，避免无意义的 `sh-syntax` WASM 空转。
2. **WorkBuddy 与 Qoder 共享桌面转录解析与容错（`src/adapters/qoder/host-hook.ts`、`src/adapters/workbuddy/host-hook.ts`）**：
   - 抽取两套桌面钩子中约 70% 重复的公共逻辑（转录读取、事件分发、`PreToolUse` 包装），避免后续修复再次漂移。
   - 转录 JSONL 改为**逐行 `try/catch JSON.parse`**（与 Antigravity 一致），单行半刷盘或损坏时仅跳过坏行而不清空整场会话的真实用户原话；统一支持 `~/` 路径展开。
   - 统一使用大小写不敏感的栈式宿主标签剥离函数；修复 WorkBuddy `<user_query>` 解析：块内出现 `<user_query>` 时只提取其内部文本，不闭合则 fail-closed，不再回退到 `visible.join("\n")` 导致漏匹配和暴露附件块。
3. **Antigravity、会话状态与 Pi 桥接加固（`src/adapters/antigravity/host-hook.ts`、`src/application/host-hook.ts`、`assets/templates/pi/extensions/knit.ts`、`assets/templates/agents/plugins/knit/rules/AGENTS.md`）**：
   - `antigravity/host-hook.ts` 将 `KNIT_SESSION_AGENT` 判空由 `=== undefined` + `-` 改为 `!process.env.KNIT_SESSION_AGENT` + `:-`，防止空串环境变量退化为 `pi`。
   - `host-hook.ts` 的 `readState()` 对损坏的会话状态 JSON 捕获异常并安全退回初始态 `{ taskId: null }`；删除全仓零引用的死重导出 `export { checkHostCommand }`。
   - Pi 桥接模板 `assets/templates/pi/extensions/knit.ts`：同步更新 `canSkipHostCommand`；为 `tool_call` 中 `JSON.parse(checked.stdout)` 增加异常防护；`withMessageFile` 用 `try/finally` 确保 `writeFile` 异常时也清理临时目录；`dependsOn` 改用 `--depends-on=...` 防值以 `-` 开头被误解析；修复 `knit_run(cancel)` 仅在取消成功且未指定单 `runId`（或取消后任务已无运行中成员）时才 `stopWaiting`，防止取消并行批次单个成员时错杀整批完成通知。
   - 同步更新 `assets/templates/agents/plugins/knit/rules/AGENTS.md`：修正 `knit deliver --preview <id>` 示例顺序、补充 `knit task close`/`cancel` 用法，并修正“用 `knit task show <id>` 读需求正文”为“查看元信息与状态、读 `task.md` 看需求正文”。

### 边界与约束

- 不对 `python -c`、`node -e` 等通用脚本解释器做静态交付命令分析。
- 不修改 `hostProjectRoot` 懒加载结构（归 `k-f331f86e46a8`），不修改 `session-context.ts`（归 `k-48ccd026c70d`）。
- 涉及交付授权核对与公共桥接模板，须运行 `npm run typecheck`、`npm run build`、`npm run pack:check` 及全量 `npm test`。

## 完成条件

### Requirement: Shell 门禁封堵绕过且不误伤常规命令
#### Scenario: 常见 Shell 包装与间接执行无法绕过交付与禁派发拦截
- WHEN 命令使用 `eval -- 'knit deliver ...'`、`env -S "knit deliver ..."`、`env -P /bin knit deliver ...`、`exec -a x knit deliver ...`、`nohup knit deliver ...`、`nice knit deliver ...`、`sh <<< 'knit deliver ...'`、`sh <<EOF`、管道给 `sh`、`source` 或 `CMD=knit; $CMD deliver ...`（以及对应的 `knit run start`）
- THEN `checkHostCommand` 均能识别并按授权规则或桌面端禁派发规则拦截

#### Scenario: 只读帮助、ANSI-C 多行文案与常见动态非授权参数不被误杀
- WHEN 命令为 `knit deliver --help`、`knit deliver -h`、`knit run start --help`、`knit deliver k-123 --authorization '同意交付' --message $'feat: a\n\nb'`、`knit deliver k-123 --dir $ROOT --authorization '同意交付'` 或 `knit deliver "$ID" --preview`
- THEN 帮助与预览命令正常放行，合法静态 `--authorization` 正常进入原话核对且通过

### Requirement: 桌面宿主转录容错与标签安全提取
#### Scenario: 转录含损坏行或半行落盘时不清空合法用户原话
- WHEN WorkBuddy 或 Qoder 的 `transcript_path` 中存在半行截断或非法 JSON 行，且其他行包含用户的同意原话
- THEN 仅跳过坏行，仍能提取有效用户原话并放行授权交付；支持 `~/` 路径展开

#### Scenario: WorkBuddy 大小写提醒标签与混合 `<user_query>` 安全处理
- WHEN WorkBuddy 转录消息包含大写 `<SYSTEM-REMINDER>` 或在同一文本块中含 `<user_query>` 与其他附加信息，或 `<user_query>` 未闭合
- THEN 提醒标签被正确剥离，闭合 `<user_query>` 仅提取内部用户输入且不泄露附件块，残缺标签安全拒绝

### Requirement: 宿主会话容错与 Pi 桥接并行取消修复
#### Scenario: 损坏会话状态自愈与 Pi 单成员取消保留批次通知
- WHEN `.knit/.runtime/host-sessions/*.json` 内容损坏时调用 `hostContext`；或在 Pi 桥接中对并行批次仅传 `runId` 取消单个成员
- THEN 损坏会话状态自动恢复初始态而不崩溃；Pi 保留对其余仍在运行成员的 `run wait` 监听并在整批结束时发送通知

### Requirement: 构建、打包校验与全量回归通过
#### Scenario: 类型检查、打包校验与全量测试通过
- WHEN 运行 `npm run typecheck`、`npm run build`、`npm run pack:check` 及全量 `npm test`
- THEN 全部通过且无新增失败

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 第 5.2、8.2、9 节多宿主钩子、授权原话核对与 Pi 桥接规范
- `docs/AGENT-INTEGRATION.md` — 主会话宿主命令协议与验收要点
- `AGENTS.md` — 高风险独立审查与模板修改约定
- `src/application/host-command.ts` — Shell 命令 AST 解析与门禁核对
- `src/application/host-hook.ts` — 会话状态持久化
- `src/adapters/qoder/host-hook.ts` — Qoder 宿主钩子
- `src/adapters/workbuddy/host-hook.ts` — WorkBuddy 宿主钩子
- `src/adapters/antigravity/host-hook.ts` — Antigravity 宿主钩子
- `assets/templates/pi/extensions/knit.ts` — Pi 桥接扩展模板
- `assets/templates/agents/plugins/knit/rules/AGENTS.md` — Antigravity 主会话规则模板

## 结果

6 个验收场景已满足。四个宿主的命令解析与授权核对已加固；WorkBuddy、Qoder 可从含损坏行的转录中提取合法用户原话，Pi 在取消单个执行时保留其余成员的通知。独立审查修正了组合短选项解析，并给出 pass。审查定向测试 52/52 通过。主会话已对审查修正后的工作树运行类型检查、构建、打包校验、git diff --check 和使用第二个可写卷的全量 npm test，596/596 通过，0 失败、0 跳过。
