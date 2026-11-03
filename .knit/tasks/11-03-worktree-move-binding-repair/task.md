---
id: k-d10f8d4c2833
status: open
phase: discuss
outcome: null
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:08.552Z
title: Worktree：项目移动与关联修复
---

# Worktree：项目移动与关联修复

## 目标与边界

支持设计中的项目／Worktree 整体移动和关联修复，在目录变化后重新核实身份并恢复正确的本机定位。

这是用户要求盘点并拆分的设计后续能力，属于后续规划。本轮仅登记任务和边界，保持 open／discuss；不开始技术实施，不调用模型、Rex 或真实项目操作，不改变首版范围。具体方案和完成条件按下述设计来源及待验证事项继续澄清，不把规划建议或尚未核查的能力当作事实。

### 本任务的交付范围

- 发现和报告旧路径、Git 关联、本机 binding 与原生引用不一致。
- 按明确来源和实际目录关系修复可证明的关联，保留原 taskId、历史运行、来源及未知项。
- 存活或身份未知的执行不能借修复被接管；缺证据不猜测路径或覆盖后来合法绑定。

## 完成条件

以下是依据现行设计拟定的可验证交付方向；Planner 在实施前对照真实方案复核，范围变化按 Knit 输入更新规则处理。本轮没有执行这些验收。

- 隔离夹具覆盖整体移动、旧路径复用、失效关联、部分修复和中断重试。
- 修复后列表和执行定位一致；未知或冲突项保留可读诊断，不错误启动任务。

保留 Task／Run／Session 的既有权威、授权和恢复规则；按影响范围选择实际检查。历史真机／真实模型验收继续沿用用户的延期决定，何时进行由后续授权安排，不能以隔离测试冒充真实验收。业务完成、Git 提交、归档、push 和发布分别处理，本轮不进行这些操作。

## 输入引用

- 用户要求：把设计预留的 Worktree、Rex 等后续实现盘点并合理拆分；本轮不实施。
- [仓库规范](../../../AGENTS.md)、[文档索引](../../../docs/README.md)、[工作流](../../workflow.md)。
- [docs/research/WORKTREE.md](../../../docs/research/WORKTREE.md) 的迁移／修复约定
- [docs/design/DESIGN.md](../../../docs/design/DESIGN.md) 第 16.3 节
- [docs/design/OPERATIONS.md](../../../docs/design/OPERATIONS.md) 的恢复约定

## 依赖与交接

- [Worktree：执行路由、跨目录查询与会话续做](../11-03-worktree-execution-query-session-resume/task.md)（k-1910551e4f50）：以其实际完成并验证的交付物为输入。

依赖描述是规划交接关系，不新增调度字段或状态机。各任务只带自身需要的上游结果；研究若证明依赖或粒度应调整，先说明并更新任务，不因任务已登记而自动派发。

## 待讨论与待验证事项

- Git worktree repair 与本机索引修复的实际支持范围、操作顺序及原生 Session 路径兼容性由 Planner 验证。

后续 Planner 把本任务的必要方案及可执行步骤保存在本任务目录，继续识别可独立验收的拆分边界；任务登记不替代需求澄清或实施授权。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
