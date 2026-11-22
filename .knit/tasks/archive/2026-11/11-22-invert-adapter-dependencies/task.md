---
id: k-0821df285a6f
title: 反转应用层对适配器的依赖并抽出窗格宿主端口
status: delivered
stage: null
verification: independent
parent: k-d123fec5fa11
dependsOn:
  - k-84165a4f76ee
priority: P1
createdAt: 2026-11-22T06:32:51.619Z
---

## 目标与范围

打断 `src/application/` 与 `src/adapters/` 之间的层级双向依赖，将终端窗格（Rex）抽象为可替换端口，并收口窗格执行外壳与执行器上下文传递：

1. **在 `contracts/` 定义窗格宿主端口与执行器注册表接口，反转 `application -> adapters` 依赖**：
   - 现状：`src/application/run-execute.ts`、`src/application/run-finish.ts` 直接静态 import `src/adapters/agents.ts`；`src/application/run-execute.ts` 和 `src/application/run-pane.ts` 直接静态 import `src/adapters/rex/pane.ts`；同时 `src/adapters/antigravity/execution.ts` 和 `src/adapters/pi/pane-worker.ts` 又反向 import `src/application/run-session.ts` 和 `src/application/run-process.ts`，导致 `application` 与 `adapters` 互指成环。
   - 做法：
     - 在 `src/contracts/` 定义极薄的 `PaneHost` 端口接口（`open`、`waitClosed`、`close`，不假设单任务同时只存在一个窗格，为后续多模型并行审查多窗格共存预留干净形态）与执行器端口/注册表类型（含 `createAdapter`、`sessionDefaults`、`checkDispatch`、`cleanRun`），`src/adapters/rex/pane.ts` 提供 `RexPaneHost` 实现（由入口检测 `REX_SESSION`/`REX_BLOCK` 创建，不把 Rex 环境变量和类型泄漏进 `application`）。
     - `executeRun`、`finishRun`、`cancelRun`、`runInPane` 只依赖 `contracts/` 中的端口接口，由组合根（`src/cli/run.ts` 等调用入口）注入 `agents` 注册表与 `paneHost`（测试仍可直接传 fake 端口，零重型 DI 框架）。
2. **收口通用窗格执行外壳，避免各适配器重复拼装协议时序**：
   - 现状：`src/adapters/antigravity/execution.ts`（`runAgyPane`）和 `src/adapters/pi/pane-worker.ts` 各自手写调用 `registerPane`、监听退出信号、`runAgentSession`、`writePaneOutcome`。
   - 做法：在 `src/application/run-session.ts` 提供通用的窗格会话执行外壳（如 `runPaneSession`），统一封装 `registerPane` 核对后台存活、信号处理、`runAgentSession` 与 `writePaneOutcome`，让 Pi 和 Antigravity 窗格入口只需构造 `AgentSession` 并委托该外壳；同时在 `AgentLaunch` 中补充显式 `root`（主检出路径，为后续执行器按契约定位主检出只读资料提供干净入口，避免靠 `dir` 反推目录层级），保持 `AgentLaunch` 与 `AgentSession` 接口清晰可扩展，方便后续接入原生 Resume 恢复标识（`k-3bead0494c8e`）。

边界：
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，不得修改。
- 保持 Pi 与 Antigravity 在后台模式、Rex 窗格模式、回退后台和取消结算下的全部现有行为不变；不新增第二个真实终端窗格实现（只抽接口并用 Rex 实现）。

## 完成条件

### Requirement: application 层不再静态导入 adapters 层任何模块

#### Scenario: 静态依赖方向单向化且可通过注入自定义 PaneHost 与 Agent 运行

- GIVEN 重构后的 `src/application/`、`src/contracts/`、`src/adapters/` 与 `src/cli/run.ts`
- WHEN 检查 `src/application/*.ts` 的全部 import 语句，并用内存 fake `PaneHost` 与 fake `AgentAdapter` 调用 `executeRun`、`runInPane` 与 `finishRun`
- THEN `src/application/` 中不存在任何指向 `../adapters/` 的 import（含 type import），`executeRun`／`runInPane`／`finishRun` 均通过注入的端口正常工作并在窗格无法打开或超时未启动时按原规则回退后台执行

### Requirement: Pi 与 Antigravity 窗格模式与结算行为完全兼容

#### Scenario: Rex 窗格启动、交报、关窗、取消及回退测试全部通过

- GIVEN 现有 `test/` 中涵盖 Rex 窗格、Pi 适配器、Antigravity 适配器与执行控制的全部测试套件
- WHEN 运行 `npm run typecheck` 与 `npm test`（macOS 普通终端与 Rex 终端各一次）
- THEN `AgentLaunch` 携带主检出 `root`，Pi 与 Antigravity 窗格入口均复用统一窗格外壳，且全部测试通过无回归

## 待澄清

## 相关资料

- `src/contracts/agent.ts` — 执行器适配器与 `AgentLaunch` 契约
- `src/adapters/agents.ts` — 当前内置执行器注册表
- `src/adapters/rex/pane.ts` — Rex 浮动窗格适配器实现
- `src/application/run-execute.ts` — 共用执行入口（当前直接 import `adapters`）
- `src/application/run-finish.ts` — 执行结算（当前直接 import `adapters/agents.ts`）
- `src/application/run-pane.ts` — 窗格执行编排（当前直接 import `adapters/rex/pane.ts`）
- `src/application/run-session.ts` — 后台与窗格共用会话执行
- `src/application/run-control.ts` — `cancelRun` 调用 `finishRun` 处
- `src/adapters/pi/pane-worker.ts` — Pi 窗格扩展入口
- `src/adapters/antigravity/execution.ts` — Antigravity 窗格入口 `runAgyPane`
- `src/cli/run.ts` — CLI 组合根入口

## 结果

已在 src/contracts/pane.ts 定义 PaneHost 端口并在 src/contracts/agent.ts 扩展执行器注册表接口与 AgentLaunch.root，executeRun/runInPane/finishRun/cancelRun 通过组合根注入工作，src/application/ 对 src/adapters/ 的静态引用归零；Pi 与 Antigravity 窗格入口均委托 runPaneSession 外壳。完成条件全部满足。独立审查（r-6361e253c31b）结论 pass（审查补修 Pi 终端信号退出截断 session_shutdown 回调及非 Error 异常回退两处问题）：npm run typecheck 通过，macOS 普通终端与 Rex 终端 npm test 各 410/410 通过，AST 扫描 19 个应用层文件指向 adapters 为 0，并用真实 Rex + Pi 1.6.0 验证信号关闭回调。未验证：在线模型推理（交报与补报使用本地协议夹具验证）。
