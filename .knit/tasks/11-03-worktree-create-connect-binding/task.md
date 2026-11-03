---
id: k-248eafc8fb31
status: open
phase: discuss
outcome: null
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:06.963Z
title: Worktree：创建、连接与本机绑定
---

# Worktree：创建、连接与本机绑定

## 目标与边界

实现设计预留的 Worktree 创建与已有目录连接，建立可核实的仓库、分支和本机执行目录关系，为后续交接与执行接入提供基础。

这是用户要求盘点并拆分的设计后续能力，属于后续规划。本轮仅登记任务和边界，保持 open／discuss；不开始技术实施，不调用模型、Rex 或真实项目操作，不改变首版范围。具体方案和完成条件按下述设计来源及待验证事项继续澄清，不把规划建议或尚未核查的能力当作事实。

### 本任务的交付范围

- 按 Worktree 设计处理现有分支／新分支、路径和可读名称占用；区分稳定任务身份、可读名称及实际执行目录。
- 核实 Git 仓库关系、目录／分支占用和已存在关联，幂等重试；失败保留可诊断的实际效果。
- 本任务交付创建／连接基础，不提前把资料尚未交接完的任务切到新目录执行。

## 完成条件

以下是依据现行设计拟定的可验证交付方向；Planner 在实施前对照真实方案复核，范围变化按 Knit 输入更新规则处理。本轮没有执行这些验收。

- 隔离 Git 夹具覆盖创建、连接已有目录、命名占用、错误仓库和失败重试，保留用户原有目录及分支。
- 绑定资料与真实 Git／目录关系一致；不复制另一套任务身份，也不默认启动模型或切换活动执行位置。

保留 Task／Run／Session 的既有权威、授权和恢复规则；按影响范围选择实际检查。历史真机／真实模型验收继续沿用用户的延期决定，何时进行由后续授权安排，不能以隔离测试冒充真实验收。业务完成、Git 提交、归档、push 和发布分别处理，本轮不进行这些操作。

## 输入引用

- 用户要求：把设计预留的 Worktree、Rex 等后续实现盘点并合理拆分；本轮不实施。
- [仓库规范](../../../AGENTS.md)、[文档索引](../../../docs/README.md)、[工作流](../../workflow.md)。
- [docs/research/WORKTREE.md](../../../docs/research/WORKTREE.md) 第 6.2、6.3、6.6 节
- [docs/design/DESIGN.md](../../../docs/design/DESIGN.md) 第 3.5、15.2、16.3 节
- [docs/design/ARCHITECTURE.md](../../../docs/design/ARCHITECTURE.md) 的 binding／operation 约定

## 依赖与交接

- 无其它新规划任务的硬前置；实施前仍须阅读当前架构、任务状态及适用规范。

后续使用本任务交付的任务：

- [Worktree：任务资料完整交接与中断恢复](../11-03-worktree-task-material-handoff/task.md)（k-19b5cad5c106）。
- [Worktree：公共资料白名单复制与环境初始化](../11-03-worktree-material-copy-environment-init/task.md)（k-e48b7df14115）。
- [Worktree：执行路由、跨目录查询与会话续做](../11-03-worktree-execution-query-session-resume/task.md)（k-1910551e4f50）。

依赖描述是规划交接关系，不新增调度字段或状态机。各任务只带自身需要的上游结果；研究若证明依赖或粒度应调整，先说明并更新任务，不因任务已登记而自动派发。

## 待讨论与待验证事项

- 按现有 binding 仓储实际字段设计最小扩展及迁移；具体命令和参数由后续 Planner 确认。

后续 Planner 把本任务的必要方案及可执行步骤保存在本任务目录，继续识别可独立验收的拆分边界；任务登记不替代需求澄清或实施授权。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
