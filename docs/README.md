# 文档索引

开发入口是 [AGENTS.md](../AGENTS.md)。后续正式任务使用 [.knit/workflow.md](../.knit/workflow.md) 和 `.knit/tasks/`，通过 `npx --no-install knit task list` 查询；各任务的 `task.md` 是需求与业务状态唯一权威。是否建任务由用户决定，未建任务时可直接执行。

## 现行设计与规则

| 文档 | 内容 |
| --- | --- |
| [DESIGN.md](design/DESIGN.md) | 产品规范、能力边界、任务与工作流；首版范围见第 15.1 节 |
| [ARCHITECTURE.md](design/ARCHITECTURE.md) | 模块职责、协议与目录结构 |
| [STATES.md](design/STATES.md) | 状态枚举、不变量与转移 |
| [TECHNOLOGY.md](design/TECHNOLOGY.md) | 依赖、技术选型与版本边界 |
| [OPERATIONS.md](design/OPERATIONS.md) | 命令行为、执行、恢复、授权与交付规则 |
| [GLOSSARY.md](design/GLOSSARY.md) | 术语与稳定身份的含义 |
| [ROLE-CONTRACT.md](design/ROLE-CONTRACT.md) | 主会话／实施／检查／advisory 的职责、停止条件、报告字段与工具边界；含 Trellis／GSD 来源映射 |

这些文档定义当前设计；各项能力的实现与验收结论以对应任务记录和验证证据为准。

## 研究与验证

| 入口 | 内容 |
| --- | --- |
| [RESEARCH.md](research/RESEARCH.md) | 调研依据、比较与实验索引 |
| [WORKTREE.md](research/WORKTREE.md) | Worktree 后续设计，首版不实现 |
| [validation/](../validation/) | 原始日志、实验夹具、验收与独立复核证据 |

后续真机／真实模型验收按用户决定延期；本地隔离测试不替代 macOS 完整安装与运行验收。

## 开发历史

[历史任务索引](history/TASKS.md)保存原 001–060 的状态与阶段记录，[tasks/](history/tasks/)保存各任务的执行事实，[旧阻塞记录](history/BLOCKERS.md)保存当时的问题、修复依据与延期项。这些档案不再接收新任务或维护后续状态。新的阻塞和交接信息写入对应 Knit 任务。

文档整理仅调整文件位置与可导航引用；历史执行日志、固定提交来源、任务身份和运行证据保留原值。旧档案中的命令、路径或启动指令按记录产生时的布局理解，当前目录与协作方式以本索引和 `AGENTS.md` 为准。
