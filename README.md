# Knit

轻量项目辅助 CLI。日常由主 Agent 在 Pi 对话中调用，负责项目资料、任务、规范演进、实施／检查、提交归档与恢复。

当前已完成 001–025（Linux 候选）：M1 临时闭环、M2 真实项目保护（快照／恢复、锁／取消、接收竞争、Git／归档断点）和 M3A 日常接续（分支接管、树选择、初始化升级、私有诊断、用量／查询）。真实桥接、M2 与 M3A 证据分别在 [validation/m1-bridge](https://github.com/6spot/knit/tree/main/validation/m1-bridge)、[validation/m2-independent-gate](https://github.com/6spot/knit/tree/main/validation/m2-independent-gate)、[validation/m3a-developer](https://github.com/6spot/knit/tree/main/validation/m3a-developer)。首版候选已完成 Linux + Node 24 + Pi 1.4.0 本地安装验证；macOS 后续补测（B001），当前不声明 macOS 兼容。任务026 将做独立发布就绪审查；Linux 候选通过后才进入可审阅交付，不自动 npm publish。

开发 Agent 从 [AGENTS.md](https://github.com/6spot/knit/blob/main/AGENTS.md)、[TASKS.md](https://github.com/6spot/knit/blob/main/TASKS.md) 和 [BLOCKERS.md](https://github.com/6spot/knit/blob/main/BLOCKERS.md) 开始，按编号优先推进。阻塞处记录伪代码／暂定接口和待决定问题后继续其它可做任务；真实交付／验证完成才标completed。具体范围写在各任务文件中。

设计入口：[产品规范](https://github.com/6spot/knit/blob/main/DESIGN.md)、[架构](https://github.com/6spot/knit/blob/main/ARCHITECTURE.md)、[状态](https://github.com/6spot/knit/blob/main/STATES.md)、[技术选型](https://github.com/6spot/knit/blob/main/TECHNOLOGY.md)、[运行规则](https://github.com/6spot/knit/blob/main/OPERATIONS.md)。研究与既有实验见 [RESEARCH.md](https://github.com/6spot/knit/blob/main/RESEARCH.md) 和 [validation](https://github.com/6spot/knit/tree/main/validation)。

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
./node_modules/.bin/knit init --client pi --dir <项目>
./node_modules/.bin/knit start --dir <项目>
```

候选包当前为 `private: true`，未附 LICENSE；公共 npm 发布前需确认名称／scope、版本和许可证。

首版不实现 Worktree、REX、其它 Agent 客户端、并行调度或对外插件平台。不依赖 Pi SDK，阶段执行直接复用本机 Pi CLI。Linux + Node 24 + Pi 1.4.0 已完成本地 `npm pack` 安装／init／start 冒烟；macOS 未实测，不作为已支持平台声明。
