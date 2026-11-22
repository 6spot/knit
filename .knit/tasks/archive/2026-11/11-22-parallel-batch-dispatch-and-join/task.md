---
id: k-a629b7913d9b
title: 支持单任务并行批次派发、Join 进度推导与主会话汇总交接
status: delivered
stage: null
verification: independent
parent: k-8ac399027fac
dependsOn:
  - k-f3d79c718b3e
priority: P1
createdAt: 2026-11-22T07:28:40.435Z
---

## 目标与范围

将 Knit 的派发、进度推导、等待/状态/取消控制与交接模型从「单任务同一时间只能跑 1 个 run」升级为「支持单环节按批次并行派发多个只读执行者，全员结束后交回主会话裁决汇总，再带修改指令派发返工」：

1. **扩展 `TaskRun` 与按批次（Batch）的进度推导（`src/contracts/task.ts`、`src/domain/progress.ts`）**：
   - `TaskRunSchema` 增加可选字段：`batchId`（同一轮并行派发共享的批次 ID，单执行器 run 可省略）与 `executor`（执行器标识，如 `pi-codex`、`agy-gemini`，旧记录省略时保持兼容）。
   - `domain/progress.ts` 改为按批次推导状态与下一步：
     - 若任务存在任意 `endedAt === null` 的 run（单个或同一批次内部分仍在跑），不允许派发新批次，任务仍处于当前环节进行中；
     - 返工进入次数（`stageEntries`）按批次计算——同一批次并行跑 2 个审查者只算进入审查环节 **1 次**，不重复计次；
     - 多执行器批次全员结束后（Join）：
       - 仅当批次内所有成员均无失败且全部给出 `pass`（或按配置无 `verdict` 且全员正常结束）时，本批次视为通过并按顺序进入下一环节／`close`；
       - 只要批次内存在任一 `changes_requested`、`blocked`、执行失败，或成员结论分歧，即停下来**交回主会话裁决汇总**（`nextStep` 给出明确聚合状态与各成员报告路径；主会话裁决后可通过指定跳转或带修改指令派发下一轮返工，例如回到 `implement` 或重跑审查）。
2. **并行批次派发、等待、状态与取消（`src/application/run-prepare.ts`、`run-control.ts`、`run-execute.ts`、`src/cli/run.ts`）**：
   - `prepareRun`／`startRun`：当下一环节配置了多个执行器时，一次准备共用 Worktree 并为每个执行器分别做派发前校验（含各自的 `AgentSpec` 与隔离预检 `checkDispatch`），全部通过后再一次性登记该批次的全部 `TaskRun`（共享 `batchId`，各自独立 `run-id` 与 `.knit/.runtime/runs/<run-id>/` 目录），并行拉起各自的后台 worker（Rex 环境下各自打开独立最小化窗格，标签含 `run-id` 或执行器标识）；任一成员准备失败时回滚本次新建 Worktree 且不登记任何 run。
   - **同批次双 Antigravity 并行支持**：允许同一批次同时运行 2 个及以上 `agent: antigravity` 实例并共用同一 Worktree——通过共享静态 `.agents/hooks.json`（由每个 `agy` 子进程通过各自环境变量向 `client.js` 传递独立的 socket 路径与 hooks 密钥，且命令子进程 `runCommand` 剔除这些内部环境变量），多个 `agy` 实例可幂等复用同一份 Knit 生成的 `.agents/hooks.json`，仅在同 Worktree 最后一个 `agy` 实例收尾时删除它，确保取消其中一个实例不影响另一个继续完成交报。
   - **受保护角色文件范围（严格沿用 `DESIGN.md §7` 与 `test/workspace.test.mjs`）**：`src/application/workspace.ts` 的 `protectedChanges` 与 `src/application/run-execute.ts` 的 `protectedPaths` 只保护流程实际引用的角色文件（各环节的共享 `prompt` 以及各 `executors[].prompt` 有效路径），**不保护未被流程引用的 `.knit/agents/` 其它文件**（保持 `test/workspace.test.mjs:95` 与 `test/workflow.test.mjs:115` 既有契约）。
   - **历史单执行器未结束记录的进度推导兼容**：保持 `test/progress.test.mjs:105-118` 既有契约——对于无 `batchId` 的历史单执行器记录，`nextStep` 沿用「不算数的执行不影响纯推导、由 `prepareRun` 统一拒绝任意未结束执行」的规则；对于带 `batchId` 的并行批次，批次内存在任意未结束成员时保持进行中、等待 Join 完成后再推进或交回主会话裁决。
   - 派发命令增加可选主会话裁决指令参数：`knit run start <id> [--instruction <文本> | --instruction-file <文件>]`（支持主会话把对抗审查汇总后的最终修改清单写入本次交接）。
   - `waitRun`：等待当前在跑批次的**全部** run 结束（或进程消失）后才返回，确保主会话一次性收到全部对抗审查结果；
   - `statusLines`（`knit run status`／`knit context`）：清晰展示在跑或最近一批次中每个执行者的 `run-id`、Agent、状态／结论与 `report.md` 路径；
   - `cancelRun`（`knit run cancel <id> [--run <run-id>]`）：默认停止并结算当前批次中所有未结束的 run，指定 `--run <run-id>` 时只取消该单个 run。
3. **多报告与主会话汇总指令交接（`src/application/handoff.ts`）**：
   - `HandoffInput.previous` 扩展支持多份报告（上一批次多个审查者的报告各自带 `executor`、`stage`、`verdict` 和主检出绝对路径），受现有单文件与总字节上限约束；
   - 支持附带主会话传入的修改指令块（如 `<main-instruction>`），排在需求与审查报告旁供实现者优先遵循；单报告场景保持原有输出格式兼容。

边界：
- 本仓库的受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json` 及本仓库流程用到的 `.knit/agents/` 文件）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，执行者不得修改；但代码层面 `protectedChanges` 本身仍按 `DESIGN.md §7` 仅保护流程引用的角色文件，不保护未被引用的 `.knit/agents/` 其它文件。
- 单执行器流程的所有现有行为、记录格式与测试必须完全向后兼容；多执行器并行批次只允许在只读环节触发，且不做原生 Resume（Resume 由下一子任务 `k-3bead0494c8e` 实现）。

## 完成条件

### Requirement: 单环节可并行派发多执行器并按批次 Join 结算

#### Scenario: 双模型并行只读审查全员结束后才推进或交回主会话裁决

- GIVEN `review` 环节配置了 2 个只读执行器（如 fake Pi 与 fake Antigravity），任务已完成实现进入审查
- WHEN 运行 `knit run start <id>` 派发该批次，随后执行器 A 先以 `pass` 结束而执行器 B 仍在运行，之后执行器 B 分别以 `pass` 或 `changes_requested` 结束
- THEN 仅 A 结束、B 仍在跑时，`waitRun` 不提前返回且不允许派发新批次；两者都 `pass` 时本批次推进至 `close` 且审查进入次数只记 1 次；当 A 为 `pass`、B 为 `changes_requested`（或任一失败/`blocked`）时，批次在全员结束后交回主会话并列出两份报告路径与各自结论

### Requirement: 批次取消与多报告＋主会话修改指令交接工作正常

#### Scenario: 取消并行批次与带主会话汇总指令派发返工

- GIVEN 正在并行运行的 2 个审查执行器，以及审查分歧后由主会话整理出的修改清单
- WHEN 分别测试 `knit run cancel <id>`（整批取消）与 `knit run cancel <id> --run <run-id>`（单项取消），以及在审查汇总后带 `--instruction`（或 `--instruction-file`）派发返工实现
- THEN 取消能分别准确停止并结算整批或指定单个 run；返工实现的 `message.md` 中完整包含主会话修改指令以及上一批次各审查者的报告（超字节上限时退化为路径说明）

## 待澄清

- [assumed] 当多执行器审查批次存在 `changes_requested`、失败或分歧交回主会话时，默认下一可派发环节指向 `onVerdict.changes_requested` 对应的返工环节（如 `implement`），同时允许主会话直接 `knit task close --reason`（若用户决定忽略争议接受）或重派审查；具体是否需要额外的 `--stage` 手动覆盖参数在实现时保持最小接口，不额外增加复杂子命令。

## 相关资料

- `src/contracts/task.ts` — `TaskRunSchema` 执行记录契约
- `src/domain/progress.ts` — `countedRuns`、`stageEntries`、`nextStep` 与 `sessionStage`
- `src/application/run-prepare.ts` — 派发检查、交接生成与登记
- `src/application/run-control.ts` — `startRun`、`waitRun` 与 `cancelRun`
- `src/application/run-execute.ts` — 单次执行入口
- `src/application/run-finish.ts` — 并发结算与版本号重试（`saveTask` 冲突重试）
- `src/application/handoff.ts` — `assembleHandoff` 交接拼装
- `src/cli/run.ts` — `run start`/`status`/`wait`/`cancel` 命令与 `statusLines`

## 结果

已实现单任务多执行器并行批次派发、按批次 Join 进度推导、批次等待/状态/取消（含 --run 单项取消）以及多报告与主会话修改指令（--instruction / --instruction-file）交接；同时通过共享静态 .agents/hooks.json、进程环境变量路由与主检出锁/引用记录支持同批多 Antigravity 实例并行，并保持角色文件保护与历史单执行器进度推导的既有契约。完成条件全部满足。独立复审（r-556657103636）结论 pass（补齐启动态识别、共享钩子快照竞态与并发互斥等修复）：npm run typecheck 通过，37 项独立场景全部通过，macOS Rex 与普通终端 npm test 各 456/456 通过（0 失败，0 跳过）。未验证：真实在线模型与真实 Rex 窗格交互（使用可控 fake 客户端验证）。
