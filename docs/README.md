# 文档索引

开发入口是 [AGENTS.md](../AGENTS.md)。任务在 [.knit/tasks/](../.knit/tasks/)，流程在 [.knit/workflow.yaml](../.knit/workflow.yaml)，规范在 [.knit/standards/](../.knit/standards/)。`AGENTS.md` 里的规则这里不重复。

## 现行设计

只有 [design/DESIGN.md](design/DESIGN.md) 一份，共 11 节：

- 第 1 节「要做的事」：Knit 只做的五件事和四条原则。
- 第 2 节「目录布局」：项目里的文件和目录，以及 `config.json` 的字段。
- 第 3 节「任务资料」：`task.md`、任务的状态和 `record.json`。
- 第 4 节「规范」：`.knit/standards/` 的写法、适用环节和注入规则。
- 第 5 节「交接」：给主会话和执行者各传什么、放在哪里、字节上限。
- 第 6 节「流程与角色文件」：`workflow.yaml` 的字段、下一步怎么推、角色文件的位置。
- 第 7 节「执行」：派发、Rex 窗格、返工和执行目录里的文件坏了怎么恢复。
- 第 8 节「完成与交付」：完成的条件，交付的预览、归档和提交。
- 第 9 节「命令与工具」：命令行和桥接的三个工具、每轮注入什么。
- 第 10 节「用 Knit 开发 Knit」：安装版、模板来源和 `knit init --force` 的行为。
- 第 11 节「不做与延后」：延后的 Worktree 并行和自带通用规范，以及去掉的功能。

## 研究

- [research/RESEARCH.md](research/RESEARCH.md)：旧 Knit 的调研依据。
- [research/WORKTREE.md](research/WORKTREE.md)：旧 Knit 的 Worktree 规则，Worktree 并行加回时参考。
- [research/REX-PANE.md](research/REX-PANE.md)：Rex 窗格的接口和核实记录，现行。

## 验证记录

[validation/](../validation/) 下以 `slim-` 开头的目录是现在这个 Knit 的：

- [slim-h1-2026-11](../validation/slim-h1-2026-11/)：用真的 Pi 和真的模型，从创建任务走到交付的全流程演练（2026-11-17）。
- [slim-h5-2026-11](../validation/slim-h5-2026-11/)：设计文档整理用的脚本和核实，含链接检查与执行目录文件损坏后的恢复测试（2026-11-18）。
- [slim-rex-2026-11](../validation/slim-rex-2026-11/)：在真的 Rex 窗格里用真的模型走一遍，含失败与回退（2026-11-17）。

其余目录是旧 Knit 的，只作历史证据。

## 历史

- [history/design/](history/design/)：旧设计七份（设计、架构、状态、技术选型、运行规则、阶段契约与术语）。
- [history/TASKS.md](history/TASKS.md)：旧任务索引。
- [history/tasks/](history/tasks/)：旧任务的执行记录。
- [history/BLOCKERS.md](history/BLOCKERS.md)：旧阻塞记录。

文档整理只调整文件位置与可导航的引用；历史执行日志、固定提交来源、任务身份和运行证据保留原值。旧档案里的命令、路径或启动指令按记录产生时的布局理解，不回填：复跑前用 `knit <命令> --help` 核对当前参数。当前目录与协作方式以本索引和 `AGENTS.md` 为准。
