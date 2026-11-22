# 子任务清单

四个子任务均已交付。第 3 项接入按环节选择 Agent，第 4 项交付实机发现的两项修复和验收证据。

| 顺序 | 子任务 | 前置 |
| --- | --- | --- |
| 1 | 提取 Knit 共用执行流程并保持 Pi 现有行为 · `k-19da925fecc2` · `fd4ed3d` · [任务](../11-21-shared-agent-execution/task.md) | 无 |
| 2 | 实测 Antigravity CLI 的工具边界与原会话补报 · `k-eb039beccd06` · `983c750` · [任务](../11-21-agy-feasibility/task.md) | 调用真实模型须有单独授权 |
| 3 | 接入 Antigravity CLI 并开放按环节选择 Agent · `k-8f2a69252930` · `a1fecbb` · [任务](../11-22-antigravity-cli-integration/task.md) | 第 1 项和第 2 项。[运行隔离复验](research/agy-isolation.md) |
| 4 | 实机验收 Pi 实现、Antigravity CLI 审查和主会话唤醒 · `k-23245e3928c9` · `3cd9e5e` · [任务](../11-22-antigravity-cli-live-acceptance/task.md) | 第 3 项 |

## 验收记录

旧工作流的兼容回归覆盖 Pi 缺省派发、历史执行记录、Rex 窗格与后台回退。接入回归覆盖按环节选择 Agent、模型和思考等级、权限映射、运行隔离、失败与取消、报告补交及结束通知。

接入独立审查 `r-7c996cd5a2f1` 的结论为 `pass`。首次审查发现命令启动的独立进程组在结算后仍存活，返工增加跟踪与回收后，通过 Rex 与普通终端的全量回归和三个额外夹具。

第 4 项在真实 Rex 中验证 Pi 实现 `r-8d4fd37949f8` 和 AGY 审查 `r-feebf05976e6`。`gemini-3.8-flash-low` 在同一 Worktree 完成原生审批、测试和补报。原 Pi 会话收到结束通知后自动读取报告并完成夹具。叠加实机修复后的 `npm test` 在普通终端和 Rex 各通过 402 项，0 失败、0 跳过。[实机验收证据](../11-22-antigravity-cli-live-acceptance/evidence.md)

显式开放 `external` 或 `network` 的真实模型运行留待后续验证。
