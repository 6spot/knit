---
id: k-b9a58d966cb8
status: closed
phase: discuss
outcome: cancelled
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:09.748Z
title: Codex：主会话项目集成与客户端能力映射
---

# Codex：主会话项目集成与客户端能力映射

## 目标与边界

将 Codex 纳入 Knit 的主会话项目集成，提供实际可支持的任务入口、上下文、身份和结果通知能力。

这是用户要求盘点并拆分的设计后续能力，属于后续规划。本轮仅登记任务和边界，保持 open／discuss；不开始技术实施，不调用模型、Rex 或真实项目操作，不改变首版范围。具体方案和完成条件按下述设计来源及待验证事项继续澄清，不把规划建议或尚未核查的能力当作事实。

### 本任务的交付范围

- 研究 Codex 的官方主会话扩展能力、项目入口、当前模型／Session 及消息能力；不能把 Pi Extension API 假设为可直接使用。
- 按真实支持情况接入 init／升级、任务入口、上下文、查询及结果通知，保留用户原有项目规则和信任边界。
- 客户端主会话与阶段 Runtime 的身份、原生历史、模型映射及切换关联可核对。

## 完成条件

以下是依据现行设计拟定的可验证交付方向；Planner 在实施前对照真实方案复核，范围变化按 Knit 输入更新规则处理。本轮没有执行这些验收。

- 输出能力及缺口说明；有可运行路径后核对安装入口、任务选择、上下文、通知和客户端切换。
- 缺少能力明确降级或阻塞，不通过隐藏的第二 Agent 模拟主会话集成；Pi 入口保持兼容。

保留 Task／Run／Session 的既有权威、授权和恢复规则；按影响范围选择实际检查。历史真机／真实模型验收继续沿用用户的延期决定，何时进行由后续授权安排，不能以隔离测试冒充真实验收。业务完成、Git 提交、归档、push 和发布分别处理，本轮不进行这些操作。

## 输入引用

- 用户要求：把设计预留的 Worktree、Rex 等后续实现盘点并合理拆分；本轮不实施。
- [仓库规范](../../../AGENTS.md)、[文档索引](../../../docs/README.md)、[工作流](../../workflow.md)。
- [docs/design/DESIGN.md](../../../docs/design/DESIGN.md) 第 2、9、15.2、16.3 节
- [docs/design/ARCHITECTURE.md](../../../docs/design/ARCHITECTURE.md) 的 ClientAdapter 说明
- [src/application/initialization.ts](../../../src/application/initialization.ts)
- [assets/templates/](../../../assets/templates/)

## 依赖与交接

- [Codex：CLI Runtime 与阶段协议适配](../11-03-codex-cli-runtime-stage-adapter/task.md)（k-e002356a1f50）：以其实际完成并验证的交付物为输入。

依赖描述是规划交接关系，不新增调度字段或状态机。各任务只带自身需要的上游结果；研究若证明依赖或粒度应调整，先说明并更新任务，不因任务已登记而自动派发。

## 待讨论与待验证事项

- 公开集成接口能否满足每轮注入、原生身份和事件通知，以及最低可交付范围须按实证讨论。

后续 Planner 把本任务的必要方案及可执行步骤保存在本任务目录，继续识别可独立验收的拆分边界；任务登记不替代需求澄清或实施授权。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
