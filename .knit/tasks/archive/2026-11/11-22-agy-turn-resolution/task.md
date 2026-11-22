---
id: k-77935d729cf5
title: Antigravity 回执优先认提交报告并在后台或漏标时闭合轮次
status: delivered
stage: null
verification: independent
parent: k-cdf8de80d14c
dependsOn:
  - k-053fe369b3ec
priority: P1
createdAt: 2026-11-22T05:40:36.326Z
---

## 目标与范围

修复 Antigravity 适配器在判定轮次回执时的两处缺陷，并补齐早期原生会话文件记录：

1. **最终提交有效报告时不被同轮早期的工具拒绝误判为权限阻塞**：
   - 现状：`src/adapters/antigravity/protocol.ts` 的 `resultOf()` 将 `errors.some(permissionError) || denial.length > 0` 放在 `marker === SUBMIT` 之前；而 `permissionError` 匹配 `user declined`、`Knit：` 等。在真实 `agy` 会话中，只要当轮发生过一次被用户拒批的非必要命令，或发生过一次被 `PreToolUse` 拒绝的工具调用（转录或 `step_update` 记录了 `ERROR`），即便智能体随后换用合法方式完成了任务并在回复首行写了 `KNIT_AGY_SUBMIT` 及完整报告，`resultOf()` 也会丢弃报告，直接判为 `Antigravity 权限阻塞` 失败。
   - 做法：在 `resultOf()` 中，当 `failure` 为空时，若 `marker === SUBMIT`，优先返回 `{ report: text.slice(SUBMIT.length).trimStart(), failure: null }`；只有当 `marker === BLOCKED`，或模型未给出 `SUBMIT`／`WAITING` 且当轮存在 `errors.some(permissionError) || denial.length > 0` 时，才返回 `Antigravity 权限阻塞`。同步修正 `test/helpers/fake-agy.mjs`：在 `script.denied` 场景下模拟真实的权限阻塞回复（或非 `SUBMIT` 回复），在 `spec.decline` 场景下向转录写入真实的 `status: "ERROR"`（`User declined the tool call`），确保测试夹具与真实 `agy` 行为一致。
2. **后台无交互模式收到 `result` 事件时必须闭合当轮，且不得把无 `SUBMIT` 标记或 `WAITING` 误判为成功**：
   - 现状：`src/adapters/antigravity/execution.ts` 的 `background()` 在收到 `event === "result"` 时，若 `resultOf()` 返回 `null`（例如模型漏写首行 `KNIT_AGY_SUBMIT` 直接输出了报告正文，或在后台无交互模式下输出了 `KNIT_AGY_WAITING`），`this.turn` 不会被 resolve，也不会触发补报，后台进程在打开的 `stdin` 上永久死锁。
   - 关键约束：如果环节没有声明 `report` 字段（例如默认的 `implement` 环节，`declared` 为 `{}`），`runAgentSession` 中的 `reportOutcome({}, text)` 只要拿到任意非空文本就会直接判定成功，**不会触发补报**。因此绝不能在后台模式直接把无 `KNIT_AGY_SUBMIT` 或 `KNIT_AGY_WAITING` 的回复当成合法 `report` 交回 `runAgentSession`，否则模型输出 `KNIT_AGY_WAITING` 询问用户时会被误判为“实现成功完成”。
   - 做法：在后台模式（`!this.pane`）收到 `event === "result"` 且 `resultOf()` 返回 `null` 时，必须在 `AgySession` 内部（同一 stream 会话中）或经显式补报机制向模型追问**至多一次**（提示后台无交互输入，要求完成工作并在回复首行写 `KNIT_AGY_SUBMIT` 输出完整报告）；若追问后仍未给出 `KNIT_AGY_SUBMIT`（含再次输出 `KNIT_AGY_WAITING` 或空文本），返回明确 `failure`（例如说明后台模式未按约定提交报告或要求交互输入）并闭合当轮、退出进程；若追问后给出了带 `KNIT_AGY_SUBMIT` 的报告，则交回 `runAgentSession` 按常规校验字段（必要时再走 `runAgentSession` 的字段补报）。
3. **尽早持久化原生会话文件路径 `sessionFile`，确保关窗与 `knit run cancel` 也能记录**：
   - 现状：两处缺口叠加导致提前终止时 `sessionFile` 必为 `null`：
     1. `AgySession.hook()` 只在 `Stop` 且 `fullyIdle === true` 时才记录内存字段 `this.nativeFile`，在 `SessionStart` 或 `PreToolUse` 后被关窗或取消时未捕获 `payload.transcriptPath`；
     2. 即使写入了内存字段，`src/application/run-pane.ts` 在窗格关闭且无 `outcome.json` 时硬编码返回 `sessionFile: null`，`src/application/run-control.ts` 的 `cancelRun` 调用 `finishRun` 时也硬编码传 `sessionFile: null`，两者都无法读到已退出进程的内存状态。
   - 做法：在 `AgySession.hook()` 入口处（任意钩子事件）一旦收到非空字符串 `payload.transcriptPath`，既更新 `this.nativeFile`，又通过 `atomicWrite` 将该路径持久化到执行目录的定位文件（例如 `session-file.txt` 或类似小文件）；在 `runInPane` 关窗无 `outcome.json` 分支及 `cancelRun`／`finishRun` 收到 `sessionFile === null` 时，若执行目录存在该定位文件则读取并按既有相对/绝对路径规则写入 `record.json`（后台模式建立 `session/agy.jsonl` 时亦可按需复用同一机制）。

边界：受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，不得修改；不改变 Pi 适配器的既有行为。

## 完成条件

### Requirement: 区分当轮已恢复的提交报告与真实的权限阻塞

#### Scenario: 当轮有被拒或拒批的工具调用但最终提交报告时按报告结算

- GIVEN Antigravity 会话在当轮中发生过被 `PreToolUse` 拒绝的工具调用，或用户在 Rex 中拒批了某条命令并在转录中留下 `status: "ERROR"`（`User declined the tool call`）
- WHEN 智能体在同一轮调整做法后输出以 `KNIT_AGY_SUBMIT` 开头的有效报告
- THEN `resultOf()` 返回该报告文本且 `failure` 为 `null`，执行按报告结论正常入账，不误报 `Antigravity 权限阻塞`
- AND 当智能体输出 `KNIT_AGY_PERMISSION_BLOCKED`，或未输出 `KNIT_AGY_SUBMIT`／`KNIT_AGY_WAITING` 且当轮存在权限错误或 `denied_actions` 时，仍记为 `Antigravity 权限阻塞` 并保留错误详情

### Requirement: 后台模式收到 result 事件必不死锁，且提前结束时保留 sessionFile

#### Scenario: 后台模式漏写提交标记或输出等待标记时触发补报且不在无字段环节误判成功

- GIVEN 后台模式（`!this.pane`）运行的 Antigravity 会话（分别覆盖无 `report` 字段的 `implement` 环节与带 `verdict` 字段的 `review` 环节）
- WHEN 首轮 `result` 事件的回复漏写了 `KNIT_AGY_SUBMIT` 前缀或误写了 `KNIT_AGY_WAITING`
- THEN 会话不挂起，且在无 `report` 字段的环节不会将 `KNIT_AGY_WAITING` 或无标记回复直接判定为成功；在同一 stream 会话中发起至多一次追问补报，补报给出带 `KNIT_AGY_SUBMIT` 与合法字段的报告时正常入账，补报仍无 `KNIT_AGY_SUBMIT` 或继续输出 `KNIT_AGY_WAITING` 时记为失败并退出进程

#### Scenario: Rex 窗格在 Stop 完成前关窗或取消仍记录 sessionFile

- GIVEN Rex 窗格中的 Antigravity 会话已触发过携带 `transcriptPath` 的 `SessionStart` 或 `PreToolUse` 钩子并将路径持久化到执行目录
- WHEN 窗格在提交报告前被关闭或执行被 `knit run cancel` 取消
- THEN 执行结算后的 `record.json` 中 `sessionFile` 通过执行目录定位文件回填为该原生转录路径（相对项目根或绝对路径），不为 `null`

## 待澄清

- [assumed] 后台模式下若模型首轮未写 `KNIT_AGY_SUBMIT` 或写了 `KNIT_AGY_WAITING`，由 `AgySession` 在同会话内发起至多一次追问要求以 `KNIT_AGY_SUBMIT` 开头提交完整报告，仍未提交则记为失败结束；Rex 窗格模式保留无 `SUBMIT`／`BLOCKED` 时继续等待用户在窗格内交互的现有行为。

## 相关资料

- `src/adapters/antigravity/protocol.ts` — `resultOf` 回执判定与 `transcriptTurn` 转录提取
- `src/adapters/antigravity/execution.ts` — `AgySession` 的 `background`、`hook` 与 `prompt` 补报逻辑
- `src/application/run-session.ts` — `runAgentSession` 共用报告校验与单次补报流程
- `src/application/run-pane.ts` — 窗格关闭无 `outcome.json` 时的结算路径
- `src/application/run-control.ts` — `cancelRun` 结算传参路径
- `src/application/run-finish.ts` — `finishRun` 写入 `sessionFile` 逻辑
- `test/antigravity.test.mjs` — Antigravity 适配器回归测试
- `test/helpers/fake-agy.mjs` — Antigravity 模拟客户端夹具
- `docs/design/DESIGN.md#7-执行` — 执行、报告补报与 Rex 窗格设计说明

## 结果

已修复 Antigravity 回执判定（有效 KNIT_AGY_SUBMIT 优先于当轮早期被拒工具调用）、后台无交互模式漏标或 WAITING 时同会话追问一次并可靠闭合（避免死锁和无字段环节误判成功），以及通过执行目录定位文件尽早持久化并在关窗/取消时回填原生 sessionFile。完成条件全部满足。独立审查（r-5464f695c20f）结论 pass（审查微调 1 处设计文档表述）：npm run typecheck 通过，macOS Rex 与普通环境 npm test 各 409/416 通过（0 失败，7 项跨文件系统测试按环境跳过）。未验证：真实在线模型与人工 Rex 窗口交互（使用 fake-agy 与 fake-rex 夹具验证）。
