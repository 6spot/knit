---
id: k-b25812a6636a
status: closed
phase: discuss
outcome: cancelled
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:10.155Z
title: Claude Code：CLI Runtime 与阶段协议适配
---

# Claude Code：CLI Runtime 与阶段协议适配

## 目标与边界

为 Knit 增加设计预留的 Claude Code Runtime，保持统一 Task／Run／Session 与核心验收，而由所属客户端处理原生执行和恢复。

这是用户要求盘点并拆分的设计后续能力，属于后续规划。本轮仅登记任务和边界，保持 open／discuss；不开始技术实施，不调用模型、Rex 或真实项目操作，不改变首版范围。具体方案和完成条件按下述设计来源及待验证事项继续澄清，不把规划建议或尚未核查的能力当作事实。

### 本任务的交付范围

- 核查官方 CLI／公开协议、模型、工具、结构化结果、增量用量、取消和原生记录能力及版本。
- 只按当前真实需要扩展装配及适配契约，复用已有 Runtime 实现后形成的契约；不强制依赖 Codex 先行。
- 保留现有 Pi／Local，客户端与 Session 归属不随配置切换，未知状态不借新会话规避。

## 完成条件

以下是依据现行设计拟定的可验证交付方向；Planner 在实施前对照真实方案复核，范围变化按 Knit 输入更新规则处理。本轮没有执行这些验收。

- 记录实证能力与阻塞，按公开协议覆盖阶段执行／验收、取消、原生持久化和恢复。
- 适当隔离测试及现有路径回归通过；真实模型能力另按实际环境和授权验证，区分 Mock 与真实事实。

保留 Task／Run／Session 的既有权威、授权和恢复规则；按影响范围选择实际检查。历史真机／真实模型验收继续沿用用户的延期决定，何时进行由后续授权安排，不能以隔离测试冒充真实验收。业务完成、Git 提交、归档、push 和发布分别处理，本轮不进行这些操作。

## 输入引用

- 用户要求：把设计预留的 Worktree、Rex 等后续实现盘点并合理拆分；本轮不实施。
- [仓库规范](../../../AGENTS.md)、[文档索引](../../../docs/README.md)、[工作流](../../workflow.md)。
- [docs/design/DESIGN.md](../../../docs/design/DESIGN.md) 第 2、7、15.2、16.3 节
- [docs/design/ARCHITECTURE.md](../../../docs/design/ARCHITECTURE.md) 的 Runtime 与恢复约定
- [src/ports/README.md](../../../src/ports/README.md)

## 依赖与交接

- 无其它新规划任务的硬前置；实施前仍须阅读当前架构、任务状态及适用规范。

后续使用本任务交付的任务：

- [Claude Code：主会话项目集成与客户端能力映射](../11-03-claude-code-main-session-client-integration/task.md)（k-0f924a30d9a9）。

依赖描述是规划交接关系，不新增调度字段或状态机。各任务只带自身需要的上游结果；研究若证明依赖或粒度应调整，先说明并更新任务，不因任务已登记而自动派发。

## 待讨论与待验证事项

- 所选版本／协议、原生 Session ID／定位、模型映射、可恢复条件及验收环境待核查。

后续 Planner 把本任务的必要方案及可执行步骤保存在本任务目录，继续识别可独立验收的拆分边界；任务登记不替代需求澄清或实施授权。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
