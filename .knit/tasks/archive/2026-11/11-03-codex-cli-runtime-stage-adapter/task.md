---
id: k-e002356a1f50
status: closed
phase: discuss
outcome: cancelled
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:09.348Z
title: Codex：CLI Runtime 与阶段协议适配
---

# Codex：CLI Runtime 与阶段协议适配

## 目标与边界

为 Knit 增加设计预留的 Codex 执行客户端对应 Runtime，复用核心阶段、结果验收、Session 及恢复语义。

这是用户要求盘点并拆分的设计后续能力，属于后续规划。本轮仅登记任务和边界，保持 open／discuss；不开始技术实施，不调用模型、Rex 或真实项目操作，不改变首版范围。具体方案和完成条件按下述设计来源及待验证事项继续澄清，不把规划建议或尚未核查的能力当作事实。

### 本任务的交付范围

- 核查官方公开 CLI／通信协议和适用版本，再确定启动、模型／工具设置、结构化结果、用量、取消及原生恢复方式。
- 按真实第二实现提炼所需 Runtime 契约，沿用 Knit Core／worker 协议，不新建模型鉴权系统、调度器或 Session 状态机。
- 保留 Pi／Local 路径；客户端归属不因配置变化被追溯替换。

## 完成条件

以下是依据现行设计拟定的可验证交付方向；Planner 在实施前对照真实方案复核，范围变化按 Knit 输入更新规则处理。本轮没有执行这些验收。

- 形成有来源的能力矩阵并处理必要缺口；覆盖阶段报告、结果路径、取消、持久化与恢复归属的协议验证。
- 通过适当隔离契约测试及 Pi 回归；真实模型验收的环境和授权另行安排，不凭 Mock 宣称完成原生能力验收。

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

- [Codex：主会话项目集成与客户端能力映射](../11-03-codex-main-session-client-integration/task.md)（k-b9a58d966cb8）。

依赖描述是规划交接关系，不新增调度字段或状态机。各任务只带自身需要的上游结果；研究若证明依赖或粒度应调整，先说明并更新任务，不因任务已登记而自动派发。

## 待讨论与待验证事项

- 采用的 Codex 版本、官方协议、模型映射、身份与原生记录定位、不可支持能力和验收环境均待核查。

后续 Planner 把本任务的必要方案及可执行步骤保存在本任务目录，继续识别可独立验收的拆分边界；任务登记不替代需求澄清或实施授权。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
