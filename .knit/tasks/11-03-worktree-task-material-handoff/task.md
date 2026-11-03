---
id: k-19b5cad5c106
status: open
phase: discuss
outcome: null
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:07.359Z
title: Worktree：任务资料完整交接与中断恢复
---

# Worktree：任务资料完整交接与中断恢复

## 目标与边界

在执行目录之间交接完整任务资料，保留 taskId 与需求权威，避免只复制 task.md 或只依赖 Git 已提交状态造成资料丢失。

这是用户要求盘点并拆分的设计后续能力，属于后续规划。本轮仅登记任务和边界，保持 open／discuss；不开始技术实施，不调用模型、Rex 或真实项目操作，不改变首版范围。具体方案和完成条件按下述设计来源及待验证事项继续澄清，不把规划建议或尚未核查的能力当作事实。

### 本任务的交付范围

- 为 task.md、plan.md、design.md、research/ 等完整资料建立来源快照和交接范围，包含设计要求的未提交、删除及改名。
- 交接期间核对来源版本、目标冲突和实际效果；输入与运行资料各按现有归属处理，不将 .runtime 全目录机械复制。
- 中断后按可核实记录继续；在交接完整性得到确认前不把不完整副本当作当前权威或启动阶段。

## 完成条件

以下是依据现行设计拟定的可验证交付方向；Planner 在实施前对照真实方案复核，范围变化按 Knit 输入更新规则处理。本轮没有执行这些验收。

- 验证辅助资料、嵌套研究、未提交内容、删除／改名、来源变化、目标冲突和交接中断。
- 成功交接保留任务稳定身份与必要来源；失败不静默覆盖目标或丢弃来源，并可明确报告恢复入口。

保留 Task／Run／Session 的既有权威、授权和恢复规则；按影响范围选择实际检查。历史真机／真实模型验收继续沿用用户的延期决定，何时进行由后续授权安排，不能以隔离测试冒充真实验收。业务完成、Git 提交、归档、push 和发布分别处理，本轮不进行这些操作。

## 输入引用

- 用户要求：把设计预留的 Worktree、Rex 等后续实现盘点并合理拆分；本轮不实施。
- [仓库规范](../../../AGENTS.md)、[文档索引](../../../docs/README.md)、[工作流](../../workflow.md)。
- [docs/research/WORKTREE.md](../../../docs/research/WORKTREE.md) 第 6.1 节
- [docs/design/DESIGN.md](../../../docs/design/DESIGN.md) 第 3.4–3.6、16.3 节
- [src/application/task-materials.ts](../../../src/application/task-materials.ts)

## 依赖与交接

- [Worktree：创建、连接与本机绑定](../11-03-worktree-create-connect-binding/task.md)（k-248eafc8fb31）：以其实际完成并验证的交付物为输入。

后续使用本任务交付的任务：

- [Worktree：公共资料白名单复制与环境初始化](../11-03-worktree-material-copy-environment-init/task.md)（k-e48b7df14115）。
- [Worktree：执行路由、跨目录查询与会话续做](../11-03-worktree-execution-query-session-resume/task.md)（k-1910551e4f50）。

依赖描述是规划交接关系，不新增调度字段或状态机。各任务只带自身需要的上游结果；研究若证明依赖或粒度应调整，先说明并更新任务，不因任务已登记而自动派发。

## 待讨论与待验证事项

- 交接清单、版本核对、权威位置切换的精确顺序及最小持久记录由 Planner 对照当前 task-materials 和 binding 实现设计。

后续 Planner 把本任务的必要方案及可执行步骤保存在本任务目录，继续识别可独立验收的拆分边界；任务登记不替代需求澄清或实施授权。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
