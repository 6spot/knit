---
id: k-1910551e4f50
status: open
phase: discuss
outcome: null
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:08.155Z
title: Worktree：执行路由、跨目录查询与会话续做
---

# Worktree：执行路由、跨目录查询与会话续做

## 目标与边界

在创建、交接和准备能力之上，让 Knit 从任务实际绑定的执行目录运行、查询及恢复，并提供可核对的跨目录任务视图。

这是用户要求盘点并拆分的设计后续能力，属于后续规划。本轮仅登记任务和边界，保持 open／discuss；不开始技术实施，不调用模型、Rex 或真实项目操作，不改变首版范围。具体方案和完成条件按下述设计来源及待验证事项继续澄清，不把规划建议或尚未核查的能力当作事实。

### 本任务的交付范围

- 按真实执行目录解析 cwd、分支、项目规则、执行锁、输入、成果及验收，不用可读名称代替位置。
- 注册并枚举关联目录；跨目录列表保留失效关联条目和原因，不因失效而隐藏任务。
- 续做核实原执行已结束及原生引用／cwd 兼容性；无法原生续做时沿既有 prefer 语义保留来源，不重置阶段、修复次数或 scope。

## 完成条件

以下是依据现行设计拟定的可验证交付方向；Planner 在实施前对照真实方案复核，范围变化按 Knit 输入更新规则处理。本轮没有执行这些验收。

- 覆盖跨目录派发、规则隔离、列表、失效 binding、取消和结果归属，保留单执行者与冻结输入不变量。
- 覆盖原生恢复及有依据的新会话文件续做，不能因目录切换重复执行或把缺失记录称为可恢复。

保留 Task／Run／Session 的既有权威、授权和恢复规则；按影响范围选择实际检查。历史真机／真实模型验收继续沿用用户的延期决定，何时进行由后续授权安排，不能以隔离测试冒充真实验收。业务完成、Git 提交、归档、push 和发布分别处理，本轮不进行这些操作。

## 输入引用

- 用户要求：把设计预留的 Worktree、Rex 等后续实现盘点并合理拆分；本轮不实施。
- [仓库规范](../../../AGENTS.md)、[文档索引](../../../docs/README.md)、[工作流](../../workflow.md)。
- [docs/research/WORKTREE.md](../../../docs/research/WORKTREE.md)
- [docs/design/DESIGN.md](../../../docs/design/DESIGN.md) 第 3.5、7、15.2、16.3 节
- [docs/design/ARCHITECTURE.md](../../../docs/design/ARCHITECTURE.md) 的恢复约定

## 依赖与交接

- [Worktree：创建、连接与本机绑定](../11-03-worktree-create-connect-binding/task.md)（k-248eafc8fb31）：以其实际完成并验证的交付物为输入。
- [Worktree：任务资料完整交接与中断恢复](../11-03-worktree-task-material-handoff/task.md)（k-19b5cad5c106）：以其实际完成并验证的交付物为输入。
- [Worktree：公共资料白名单复制与环境初始化](../11-03-worktree-material-copy-environment-init/task.md)（k-e48b7df14115）：以其实际完成并验证的交付物为输入。

后续使用本任务交付的任务：

- [Worktree：项目移动与关联修复](../11-03-worktree-move-binding-repair/task.md)（k-d10f8d4c2833）。
- [Worktree：授权清理与恢复引用保全](../11-03-worktree-authorized-cleanup-reference-preservation/task.md)（k-7e09de42a7a3）。
- [跨目录交付：授权合入与归档接续](../11-03-cross-directory-authorized-merge-delivery/task.md)（k-200ec35a4ae0）。
- [多任务并行：按执行目录调度与冲突保护](../11-03-multi-task-parallel-execution-coordination/task.md)（k-2cbd2f312298）。

依赖描述是规划交接关系，不新增调度字段或状态机。各任务只带自身需要的上游结果；研究若证明依赖或粒度应调整，先说明并更新任务，不因任务已登记而自动派发。

## 待讨论与待验证事项

- 客户端原生记录的目录兼容性须逐个验证；跨目录共享锁和查找范围按实际仓库结构确定。

后续 Planner 把本任务的必要方案及可执行步骤保存在本任务目录，继续识别可独立验收的拆分边界；任务登记不替代需求澄清或实施授权。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
