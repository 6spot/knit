# Knit

轻量项目辅助 CLI。日常由主 Agent 在 Pi 对话中调用，负责项目资料、任务、规范演进、实施／检查、提交归档与恢复。

当前已完成 M1 临时闭环：任务 001–015 提供 init、Task／输入草案、Session／context、规范候选、快照与 worker、实施／检查／结果接收、限定交付归档，以及可本地安装的 Pi 薄桥接（真实桥接服务见 [validation/m1-bridge](validation/m1-bridge/)）。工作区本身仍未生成产品 `.knit/`／`.pi/`，也未提交或推送；M2 的真实项目保护与故障矩阵从任务016继续。

开发 Agent 从 [AGENTS.md](AGENTS.md)、[TASKS.md](TASKS.md) 和 [BLOCKERS.md](BLOCKERS.md) 开始，按编号优先推进。阻塞处记录伪代码／暂定接口和待决定问题后继续其它可做任务；真实交付／验证完成才标completed。具体范围写在各任务文件中。

设计入口：[产品规范](DESIGN.md)、[架构](ARCHITECTURE.md)、[状态](STATES.md)、[技术选型](TECHNOLOGY.md)、[运行规则](OPERATIONS.md)。研究与既有实验见 [RESEARCH.md](RESEARCH.md) 和 validation/。

```text
src/             CLI、契约、领域、用例、适配与基础设施
assets/templates/ init 模板：项目资料与薄桥接（任务008）
test/            单元与隔离集成测试
tasks/           当前工程的顺序开发任务
TASKS.md         唯一开发任务状态表
BLOCKERS.md      阻塞、伪代码交接与待用户决定事项
validation/      可追溯研究与实验材料
```

首版不实现 Worktree、REX、其它 Agent 客户端、并行调度或对外插件平台。不依赖 Pi SDK，阶段执行直接复用本机 Pi CLI。
