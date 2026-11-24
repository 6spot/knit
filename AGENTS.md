# Knit 工程协作规范

## 新增功能的取舍

给 Knit 增加功能前，先和用户把必要性问透。谁在什么场景下遇到了什么问题？现有功能单独或组合使用，能解决到哪一步？加上这项功能，使用者会得到什么具体改善？如果不加，实际影响有多大？理由还笼统，就拿具体例子继续追问。现有办法够用就沿用，确有值得解决的缺口再新增。

## 架构与源码入口

以 `knit run start` 为例。`src/cli/` 接收命令，`src/application/` 读取任务目录里的 `task.md` 和 `record.json`，核对需求是否已确认、依赖是否满足、上一次执行是否结束。`src/domain/` 的 `nextStep` 根据工作流、任务的验证方式和执行记录，判断接下来该派哪个环节，或该由主会话裁决、收尾。[派发准备](src/application/run-prepare.ts) · [下一步判断](src/domain/progress.ts)

派发时，应用层准备任务工作树和交接内容，调用执行者，结束后保存报告并把执行结果记回 `record.json`。`src/contracts/` 定义任务、工作流和执行者接口，`src/adapters/` 对接具体客户端和 Rex 窗格，`src/infrastructure/` 提供文件、路径和进程操作。[执行过程](src/application/run-execute.ts) · [结果记录](src/application/run-finish.ts)

改主会话里的工具、钩子或上下文注入，从宿主桥接模板看起。接入能跑工作流环节的客户端，从 `AgentAdapter` 接口和内置执行者注册表看起，Pi 和 Antigravity 都有现成实现。[宿主模板](assets/templates/) · [执行者接口](src/contracts/agent.ts) · [注册表](src/adapters/agents.ts)

## 本仓库开发与验证

本仓库由全局安装的 `knit` 管理。改桥接、角色文件或默认工作流时，编辑 `assets/templates/` 中的源文件。要在本仓库试用新版本，先运行 `npm run pack:install`，再用 `knit init --force` 刷新生成副本。刷新前有差异的副本会备份到 `.knit/.runtime/backups/<时间>/`。从备份恢复本仓库定制的模型配置后，用 `knit workflow validate` 核对。[仓库工作流](.knit/workflow.yaml)

- 接手用户指定的任务，先看 `task.md`、当前状态和执行记录。需求、计划和补充研究放在该任务目录，完成情况用实际改动和验证结果核实。验证方式按用户要求、目标和风险确定，独立审查交给未参与实现的执行者。
- 遇到阻塞，把根因、证据和需要用户决定的事项记入任务的「待澄清」。可独立完成且已获授权的工作继续推进。Knit 自身故障阻碍任务推进时，主会话可用宿主工具直接修复，保留证据，恢复后把修改和验证记回任务。
- 优先用能解决当前问题的简单实现，按实际风险决定需要的防御措施。编码和测试约定按环节加载，遇到的项目问题按适用环节记入避坑清单。[开发规范](.knit/standards/development.md) · [避坑清单](.knit/standards/pitfalls.md)
- macOS 是开发环境。`npm test` 在 Rex 终端和普通终端各跑一次，两次都须通过。平台安装、真实客户端和模型的验收情况查对应的[验证记录](docs/README.md#验证记录)。

## 文档入口与写法

查任务、工作流和交付机制，读现行设计。接入客户端时，读宿主和执行者各自的协议与验收场景。研究、演练和平台验证按文档索引查找。根目录 `AGENTS.md` 由本仓库维护。[现行设计](docs/design/DESIGN.md) · [Agent 接入规范](docs/AGENT-INTEGRATION.md) · [文档索引](docs/README.md)

设计正文一段回答一个问题，写明字段、默认值、触发条件和操作结果。把权限、并发与恢复规则放在相应操作旁。取舍说明写与需求直接相关的理由，研究和验证给出出处。讨论定稿后直接更新对应章节，待定项写清影响哪项实施，验收记录写清观察到的结果、实验范围和待验证项。
