---
id: k-9c0e2fa7c112
title: 提供宿主无关的零 MCP 钩子内核与 AGY 协议入口
status: delivered
stage: null
verification: independent
parent: k-a9c3c3ddec63
dependsOn: []
priority: P1
createdAt: 2026-11-22T16:08:53.022Z
---

## 目标与范围

在不引入 MCP Server 或常驻守护进程的前提下，构建一套**宿主无关的零 MCP 主会话钩子内核**（供 AGY、WorkBuddy 及未来其它支持 Hook 的宿主复用），实现第一份薄协议入口 `knit hook agy <event>`，并为不支持后台自动唤醒的宿主补齐 `knit run wait --timeout` 降级能力：

1. **宿主无关的共用主会话钩子内核（`src/application/host-hook.ts`）**：
   - **按 `(host, sessionId)` 管理会话状态**：在本机运行目录 `.knit/.runtime/host-sessions/<host>-<安全化的 sessionId>.json` 中用 `atomicWrite` 保存 `{ taskId: string | null, lastDigest: string | null }`（不入库、不改 `task.md`/`record.json`）。
   - **免关键词去重注入 `knit context`**：定位项目根，无 `.knit/` 目录时返回无注入；有 `.knit/` 时复用 `src/application/session-context.ts` 的 `buildSessionContext` 生成当前上下文（无选中任务给讨论规范 + 未选中提示；选中任务给讨论规范、状态、下一步、目录及补充环节规范；选中任务读不出时显示错误并保留讨论规范）。计算内容 SHA-256，与 `lastDigest` 相同时返回 `null`（跳过注入，防止宿主轨迹膨胀），首次或变化时更新 `lastDigest` 并返回待注入文本。
   - **轻量任务选择切换**：提供 `knit context --use <id>`／`knit context --unuse`（或等价入口），核实任务存在后更新当前会话状态中的 `taskId`（清除或刷新 `lastDigest` 使下一轮立即注入新任务上下文）。
   - **通用命令检查与交付原话授权核对**：解析 shell 命令是否调用非 `--preview` 的 `knit deliver`（兼容复合命令、环境变量前缀、`--dir`、引号参数；解析不出合法原话授权时宁可拒绝并给出明确改法），对比宿主传入的当前会话用户消息列表，按与 `assets/templates/pi/extensions/knit.ts` 相同的规则校验 `--authorization` 是否完整匹配某条用户消息整条或完整一行（去首尾空白，拒绝子串匹配），不通过返回拒绝原因。
2. **Antigravity 薄协议入口（`knit hook agy <event>`，隐藏子命令）**：
   - 仅做协议翻译（读 stdin camelCase JSON、写 stdout JSON）：
     - `SessionStart` / `PreInvocation`：从 `conversationId`、`cwd`、`workspacePaths` 调共用内核，有更新时返回 `{ injectSteps: [{ systemMessage: { systemMessage: text } }] }`，无变化或无 `.knit/` 返回 `{}`。
     - `PreToolUse`（`matcher: "run_command"`）：
       - 识别 `knit deliver`（非 `--preview`）时，从 `transcriptPath` 只读提取 AGY 原生 `transcript.jsonl` 的 `USER_INPUT` 消息列表交由共用内核核对，未通过返回 `{ decision: "deny", reason: "..." }`；
       - 识别 `knit context --use`／`--unuse` 时自动透传当前会话标识（`KNIT_HOST=agy`、`KNIT_HOST_SESSION=<conversationId>`）；
       - 识别 `knit run start` 且未显式设置 `KNIT_SESSION_AGENT` 时自动透传 `KNIT_SESSION_AGENT=antigravity`；
       - 与 `knit` 无关的普通命令一律返回 `{}`，不干扰正常审批。
3. **为 `knit run wait` 增加可选 `--timeout <秒>` 降级参数（`src/application/run-control.ts`、`src/cli/run.ts`）**：
   - 不带 `--timeout` 时保持原行为（无总超时，一直等到整批结束）；
   - 带正整数 `--timeout <秒>` 时，若在时限内批次仍未结束，以退出码 `0` 返回当前 `statusLines` 并附带仍在运行的提示（供同步 Bash 宿主如 WorkBuddy 短等降级使用，不把未完成当错误）。

边界：
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json` 及流程引用的 `.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，不得修改。
- 本任务不改 `src/application/init.ts` 或模板文件（由 `k-ea0e6d690522` 负责），也不写 WorkBuddy 协议翻译层（待 `k-fdb8c6110481` 探针核实后由 `k-eaa1664e9b5f` 负责）。

## 完成条件

### Requirement: 共用钩子内核与 knit hook agy 实现免关键词去重注入与任务选择

#### Scenario: 首次注入、不变跳过、选任务与状态变更后自动更新注入

- GIVEN 含 `.knit/` 的临时项目与不含 `.knit/` 的普通目录，通过 stdin 向 `knit hook agy SessionStart` 与 `PreInvocation` 发送真实形状负载
- WHEN 首次触发、未变更时再次触发、执行任务选择命令选中任务后再次触发、以及任务状态变化后再次触发
- THEN 普通目录始终返回 `{}`；含 `.knit/` 项目首次返回含讨论规范的 `injectSteps.systemMessage`，内容不变时返回 `{}`，选中任务与状态推进后各自返回更新后的上下文，状态原子保存于 `.knit/.runtime/host-sessions/`

### Requirement: PreToolUse 核对交付原话授权并支持 knit run wait --timeout 降级

#### Scenario: 原话授权精确匹配放行、伪造或子串拒绝，且 wait --timeout 超时平滑返回状态

- GIVEN 包含“先不要交付”与“同意交付这个任务”两条 `USER_INPUT` 的 AGY `transcript.jsonl` 夹具，以及一个正在运行的执行批次
- WHEN 分别测试普通命令、`knit deliver --preview`、缺授权/子串“交付”/伪造授权的 `knit deliver`、完整匹配原话的 `knit deliver`，以及 `knit run wait <id> --timeout 1`
- THEN 普通命令与 `--preview` 返回 `{}`；非法交付返回 `decision: "deny"`；完整原话匹配放行；`knit run wait --timeout 1` 在超时后以退出码 `0` 输出当前在跑状态且不取消后台执行者

## 待澄清

- [assumed] 会话任务选择命令定为 `knit context --use <id>` / `knit context --unuse`（也可通过 `KNIT_HOST` + `KNIT_HOST_SESSION` 显式传参，钩子在 `PreToolUse` 自动补全，免用户手工传会话 ID）。

## 相关资料

- `src/application/session-context.ts` — 现有主会话上下文构建逻辑
- `src/application/run-control.ts` — `waitRun` 轮询实现
- `src/adapters/antigravity/protocol.ts` — AGY `transcript.jsonl` 行结构读取参考
- `assets/templates/pi/extensions/knit.ts` — Pi 桥接 `userMessageSaying` 原话授权核对参考
- `src/cli/context.ts` — `knit context` 命令入口
- `src/cli/run.ts` — `knit run wait` 命令入口
- `src/cli/knit.ts` — CLI 根命令注册
- `src/infrastructure/atomic.ts` — `atomicWrite` 原子写入

## 结果

已完成宿主无关钩子内核（host-hook.ts / host-command.ts / session-output.ts）、隐藏子命令 knit hook agy <event>、knit context --use/--unuse 以及 knit run wait --timeout <秒>，经独立审查（r-4fd280a05839）修复项目根识别、预览判断和 shell 透传边界并复验通过：npm run typecheck、npm run pack:check、git diff --check、定向 12/12 与 macOS 双终端 npm test（471 通过、0 失败、7 跨文件系统跳过）全绿。
