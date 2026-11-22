# 子任务清单

主任务 `k-8ac399027fac`。承接架构加固（`k-d123fec5fa11`）与 Antigravity 基础修复（`k-cdf8de80d14c` / `k-70ec54c7daf9`），落地「单环节多模型只读并行对抗审查 + 主会话汇总裁决 + 实现者原会话原生 Resume 续修」能力，拆分为 4 个顺序执行的子任务。

| 顺序 | 子任务 | 编号 | 验证 | 前置依赖 | 做完之后有什么不同 |
| --- | --- | --- | --- | --- | --- |
| 1 | [支持环节配置多执行器并强制并行审查只读](../11-22-workflow-stage-executors/task.md) | `k-f3d79c718b3e` | `independent` | `k-70ec54c7daf9` | `workflow.yaml` 单个环节支持 `executors` 多执行器数组（可混配 `pi` 与 `antigravity` 及不同模型/角色），并静态禁止多执行器环节包含 `write` 能力；单执行器配置完全向后兼容 |
| 2 | [支持单任务并行批次派发、Join 进度推导与主会话汇总交接](../11-22-parallel-batch-dispatch-and-join/task.md) | `k-a629b7913d9b` | `independent` | `k-f3d79c718b3e` | `knit run start` 可对多执行器环节一次派发并行批次；`progress` 按批次 Join（全员 `pass` 才通过，否则交回主会话汇总）；`run status/wait/cancel` 支持多 run 批次；交接支持传入上一批次多份报告与主会话 `--instruction` 修改清单 |
| 3 | [支持返工时原生 Resume 续聊与增量交接并支持自动回退新会话](../11-22-session-resume-and-incremental-handoff/task.md) | `k-3bead0494c8e` | `independent` | `k-a629b7913d9b` | 执行记录保存客户端原生可恢复标识（Pi 用 `--session <path>`，Antigravity 用 `--conversation <id>`）；返工再进入同一环节时按原生会话续聊并只发送增量修改指令，不支持、会话失效或加 `--fresh` 时自动回退新会话 |
| 4 | [适配桥接汇总续修入口并实机验收多模型对抗审查闭环](../11-22-verify-adversarial-review-and-resume/task.md) | `k-25933a16b9f6` | `self` | `k-3bead0494c8e` | 更新 Pi 桥接模板（支持 `instruction`、`fresh` 与批次完成通知）、只读审查角色模板和 `DESIGN.md`；经用户授权后用真实 Pi + Antigravity 模型跑通对抗审查与原会话续修闭环 |

## 依赖与执行约定

- 第 1 项依赖 `k-70ec54c7daf9`（保证前置架构加固与 AGY 基础边界修复全部落稳后再改工作流与执行模型，不强依赖需人工单独授权的 `k-4f3398a3ec99`）。
- 模板改动统一写在 `assets/templates/`，不得直接改本仓库的 `.knit/agents/`、`.knit/workflow.yaml` 或 `.pi/extensions/knit.ts` 副本（受保护路径由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查）。
- 每个子任务完成后在 macOS 普通终端与 Rex 终端各跑一次 `npm test`，并运行 `npm run typecheck`。
