# 文档索引

开发入口是 [AGENTS.md](../AGENTS.md)。任务在 [.knit/tasks/](../.knit/tasks/)，流程在 [.knit/workflow.yaml](../.knit/workflow.yaml)。安装包提供[通用规范](../assets/standards/)，项目维护自己的[协作约定与避坑清单](../.knit/standards/)。

## 现行设计

只有 [design/DESIGN.md](design/DESIGN.md) 一份，共 11 节：

- 第 1 节「要做的事」：Knit 只做的五件事和四条原则。
- 第 2 节「目录布局」：项目里的文件和目录，以及 `config.json` 的字段。
- 第 3 节「任务资料」：`task.md`、任务的状态和 `record.json`。
- 第 4 节「规范」说明内置资源、旧副本迁移、项目规范的写法和避坑分区的选取。
- 第 5 节「交接」：给主会话和执行者各传什么、放在哪里、字节上限。
- 第 6 节「流程与角色文件」：`workflow.yaml` 的字段、下一步怎么推、角色文件的位置。
- 第 7 节「执行」：派发、Rex 窗格、返工和执行目录里的文件坏了怎么恢复。
- 第 8 节「完成与交付」：完成的条件，交付的预览、归档和提交。
- 第 9 节「命令与工具」：命令行和桥接的三个工具、每轮注入什么。
- 第 10 节「用 Knit 开发 Knit」：安装版、模板来源和 `knit init --force` 的行为。
- 第 11 节「不做与延后」：Worktree 隔离、并行与交付已实现，以及不再做的功能。

## Agent 接入

新增主会话宿主或工作流执行者时，可按角色查阅协议探针、适配器入口、工作流示例和实机验收场景。[Agent 接入规范](AGENT-INTEGRATION.md)

## 研究

- Rex 窗格的接口和核实记录见 [REX-PANE.md](research/REX-PANE.md)。
- 源码拆分和测试耗时的实测依据见[文件粒度与测试效率研究](research/file-granularity-and-test-review.md)。

## 验证记录

以下记录可用于复核现行设计和接入行为。

- [slim-h1-2026-11](../validation/slim-h1-2026-11/)：用真的 Pi 和真的模型，从创建任务走到交付的全流程演练（2026-11-17）。
- [slim-h5-2026-11](../validation/slim-h5-2026-11/)：设计文档整理用的脚本和核实，含链接检查与执行目录文件损坏后的恢复测试（2026-11-18）。
- [slim-rex-2026-11](../validation/slim-rex-2026-11/)：在真的 Rex 窗格里用真的模型走一遍，含失败与回退（2026-11-17）。
- Linux 上既跑过自动测试，也用真实 Pi 和模型走过从建任务到交付的流程。[Linux 验证记录](../validation/slim-linux-2026-11/README.md)
- macOS 上用真实 Pi 和模型演练了任务工作树的并行执行、依赖和取消。[Worktree 演练](../validation/worktree-drill-2026-11/README.md)
- 多宿主主会话的验收范围包括真实 Antigravity 会话和 WorkBuddy 安装桥接的协议验证。[多宿主验收记录](../validation/multi-host-main-session/README.md)
- 真实 Pi 与 Antigravity 执行者的并行审查、原生续聊和回退在临时项目内验证。[并行审查与续聊记录](../validation/adversarial-review-resume/README.md)
