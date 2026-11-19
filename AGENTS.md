# Knit 工程协作规范

## 开发入口与任务管理

本仓库用 Knit 管理开发任务。管理本仓库的是装在全局的安装版（`npm run pack:install`），不是工作区里的 `dist/`。流程在 [.knit/workflow.yaml](.knit/workflow.yaml)，任务在 `.knit/tasks/`，用 `knit task list` 查看（归档用 `knit task list --archive`）。规范在 [.knit/standards/](.knit/standards/)，由 Knit 按环节交给主会话和执行者，这里不重复。

- 是否建任务由用户决定，已有的明确授权可以沿用。研究、改代码、委派和保存报告都不要求先建任务；没有任务时直接用宿主的工具和子 Agent，不为了委派去建任务。
- 各任务的 `task.md` 是需求的入口。复杂任务按需在任务目录里补 `plan.md`、`design.md` 或 `research/`，不另建一份全局的任务状态表。
- 用户指定任务时按指定的任务推进。接手已有任务前先看它的状态、需求和执行记录，确认原来的执行已经结束；不凭旧目录、总结或 todo 完成认定实现成功。
- 验证方式按任务的目标、影响范围和风险选 `none`、`self` 或 `independent`，用户明确要求的优先。独立审查由没有参与实现的执行者做，如实记录运行过的检查和结果。
- 遇到阻塞时，把根因、证据和要用户决定的事写进对应任务的「待澄清」。不依赖这个缺口、又已经得到授权的工作可以继续，有新事实再复验。
- Knit 自身的故障阻碍任务推进时，主会话可以用宿主工具直接修复并保留证据，恢复后把实际的修改和验证记回任务；不靠出了故障的那条链路来修它自己。
- 禁止过度思考、过度设计、过多的防御性编程，不为未遇到的事情设计过多的防御性编程。

[旧任务索引](docs/history/TASKS.md)、[001–060 执行记录](docs/history/tasks/)和[旧阻塞记录](docs/history/BLOCKERS.md)保留为历史档案，不再排新任务或维护后续任务状态。其旧启动指令、编号顺序和各任务执行时的边界只说明当时约定。历史证据保留在 [validation/](validation/)。

macOS 的支持级别是开发环境：在 macOS 开发机上 `npm test` 必须全绿（Rex 终端与普通终端各跑一次）。开发机测试通过不等于完成了 macOS 的安装与运行验收；Linux 上 `npm test` 跑过一次（见 `validation/slim-linux-2026-11/`），没有用真的 Pi 和模型走过。NPM 发布、外部部署和其它真实项目操作尚未进行。

本文件是本仓库自己的。Knit 不写入项目的 `AGENTS.md`。

## 文档与目录

- [docs/design/DESIGN.md](docs/design/DESIGN.md)：现行设计。
- [.knit/tasks/11-14-slim-refactor/plan.md](.knit/tasks/11-14-slim-refactor/plan.md)：重构的子任务清单和进度。
- [docs/history/design/](docs/history/design/)：重构之前的旧 Knit 的规范、架构和状态说明，只作历史档案。
- [docs/research/](docs/research/)：研究依据。研究不自动扩大范围。
- [docs/history/](docs/history/)：旧开发队列、阻塞与执行档案。
- [validation/](validation/)：可追溯的实验、验收、复核材料与夹具。
- `.knit/`：本仓库的任务、流程、规范和运行资料。`.knit/agents/`、`.knit/workflow.yaml` 和 `.pi/extensions/knit.ts` 是安装版 `knit init` 生成的副本，模板只有 `assets/templates/` 一份来源：改模板，不改副本，升级安装版之后重新生成。

设计正文直接定义当前方案：目录结构、字段、职责、默认值、触发条件、操作顺序和实际结果。每段围绕一个具体问题展开，规则适合用目录树、示例或字段表表达时，正文补充必要语义。讨论结论写回对应章节并替换过期方案，讨论经过保留在会话中。

说明取舍时写出与需求直接相关的理由，研究依据集中在 [RESEARCH.md](docs/research/RESEARCH.md)。权限、数据保护、并发和恢复规则放在对应操作旁，写清触发条件和处理行为。假设和待定项指向影响实施的具体问题；验证记录区分已验证事实、实验范围与待验收行为。
