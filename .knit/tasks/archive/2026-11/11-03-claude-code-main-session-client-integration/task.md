---
id: k-0f924a30d9a9
status: closed
phase: discuss
outcome: cancelled
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:10.554Z
title: Claude Code：主会话项目集成与客户端能力映射
---

# Claude Code：主会话项目集成与客户端能力映射

## 目标与边界

将 Claude Code 纳入 Knit 的主会话项目集成，按官方公开能力落实项目入口、任务上下文和消息关联。

这是用户要求盘点并拆分的设计后续能力，属于后续规划。本轮仅登记任务和边界，保持 open／discuss；不开始技术实施，不调用模型、Rex 或真实项目操作，不改变首版范围。具体方案和完成条件按下述设计来源及待验证事项继续澄清，不把规划建议或尚未核查的能力当作事实。

### 本任务的交付范围

- 研究 Claude Code 官方项目指令、扩展／hook、原生 Session、模型和消息接口，核实权限与信任语义。
- 实现真实可支持的 init／升级入口、任务选择、上下文和结果通知，保护用户文件，不将 Pi 模板直接改名套用。
- 主会话和阶段 Runtime 共享核心身份约束；列出不支持的能力及实际限制。

## 完成条件

以下是依据现行设计拟定的可验证交付方向；Planner 在实施前对照真实方案复核，范围变化按 Knit 输入更新规则处理。本轮没有执行这些验收。

- 能力矩阵与来源明确，实际项目入口和任务上下文可核对，通知和原生历史归属正确。
- 当前 Pi 路径与用户规则保留；不能凭 hook 触发日志推断模型收到消息或任务完成。

保留 Task／Run／Session 的既有权威、授权和恢复规则；按影响范围选择实际检查。历史真机／真实模型验收继续沿用用户的延期决定，何时进行由后续授权安排，不能以隔离测试冒充真实验收。业务完成、Git 提交、归档、push 和发布分别处理，本轮不进行这些操作。

## 输入引用

- 用户要求：把设计预留的 Worktree、Rex 等后续实现盘点并合理拆分；本轮不实施。
- [仓库规范](../../../AGENTS.md)、[文档索引](../../../docs/README.md)、[工作流](../../workflow.md)。
- [docs/design/DESIGN.md](../../../docs/design/DESIGN.md) 第 2、9、15.2、16.3 节
- [docs/design/ARCHITECTURE.md](../../../docs/design/ARCHITECTURE.md) 的 ClientAdapter 说明
- [src/application/initialization.ts](../../../src/application/initialization.ts)
- [assets/templates/](../../../assets/templates/)

## 依赖与交接

- [Claude Code：CLI Runtime 与阶段协议适配](../11-03-claude-code-cli-runtime-stage-adapter/task.md)（k-b25812a6636a）：以其实际完成并验证的交付物为输入。

依赖描述是规划交接关系，不新增调度字段或状态机。各任务只带自身需要的上游结果；研究若证明依赖或粒度应调整，先说明并更新任务，不因任务已登记而自动派发。

## 待讨论与待验证事项

- 最低可交付集成范围、官方接口和版本、事件通知及模型／Session 定位均须后续实证。

后续 Planner 把本任务的必要方案及可执行步骤保存在本任务目录，继续识别可独立验收的拆分边界；任务登记不替代需求澄清或实施授权。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
