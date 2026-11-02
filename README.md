# Knit

轻量项目辅助 CLI。日常由主 Agent 在 Pi 对话中调用，负责项目资料、任务、规范演进、实施／检查、提交归档与恢复。

当前已完成 001–024：M1 临时闭环、M2 真实项目保护（快照／恢复、锁／取消、接收竞争、Git／归档断点）和 M3A 日常接续（分支接管、树选择、初始化升级、私有诊断、用量／查询）。真实桥接、M2 与 M3A 证据分别在 [validation/m1-bridge](validation/m1-bridge/)、[validation/m2-independent-gate](validation/m2-independent-gate/)、[validation/m3a-developer](validation/m3a-developer/)。首版发布包仍待 macOS 平台实测与独立发布审查（任务025／026）。

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

安装（候选包尚未发布）：

```text
npm pack
npm install ./knit-0.1.0.tgz
knit init --client pi --dir <项目>
knit start --dir <项目>
```

首版不实现 Worktree、REX、其它 Agent 客户端、并行调度或对外插件平台。不依赖 Pi SDK，阶段执行直接复用本机 Pi CLI。Linux + Node 24 + Pi 1.4.0 已完成本地 `npm pack` 安装／init／start 冒烟；macOS 未实测，不作为已支持平台声明。
