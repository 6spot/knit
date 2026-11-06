---
id: k-c06c5a41092f
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-06T13:18:05.804Z
title: task list 默认只列活跃任务，归档走专门入口
---

# task list 默认只列活跃任务，归档走专门入口

## 目标与边界

`knit task list` 默认不再同时打印归档，只列未归档任务并按业务状态分段；归档改由 `--archive` 专门查看。行内字段精简为固定列并对齐，减少噪声。

边界与不变量：

- 不改任务派生结果：`TaskService.list` 仍按 `tasks/` 与 `tasks/archive/` 返回 `{active, archived}`，`task next`、依赖阻塞、父子进度与交付判定继续读同一份数据。
- 不改目录结构、归档／取消／替代动作，也不新增分页存储或索引。
- 不改 `knit status` 项目概览的 `tasks` 集合。
- 列表读取成本（缓存指纹对全部 task.md 做 stat）不在本任务范围，另立任务跟进。
- 输出是只读展示：不写任务文件、不打开写路径。

## 输出规格

### 默认视图（无参数）

- 三分区，均取自未归档任务：
  - 进行中：`status=open`；
  - 待归档：`status=closed` 且 `outcome` 不是 `cancelled`／`superseded`；
  - 已取消：`status=closed` 且 `outcome` 是 `cancelled`／`superseded`。
- 分区标题带条数，例如 `进行中（1）`；空分区只打标题、不打行。
- 行：`优先级`、`ID`、`阶段`、`标题` 四列，按显示宽度定宽补齐（CJK 计 2），列间两个空格。
- 表头 `优先级  ID  阶段  标题` 在第一个非空分区标题之后打印一次；分区全空时不打表头。
- 阶段显示名：锚点 `start`／`deliver` 用内置名，配置阶段用 workflow 的 `name`，缺失或未声明退回阶段 id。
- 不打印每行阻塞原因、路径、verify、父任务引用与子任务进度；这些留在 `knit status <taskId>`。
- 末尾汇总行：`进行中 1 · 待归档 0 · 已取消 6 · 阻塞 1 · 归档 53（knit task list --archive）`。阻塞只统计 `status=open` 且被前置依赖挡住的进行中任务。

### 归档视图（`--archive`）

- 只列归档任务，按月分组：`归档 2026-11（53）`；组内行：`日期`、`ID`、`结论`、`标题`，日期取归档路径里的 `MM-DD`，结论为该任务 `outcome`。
- 表头 `日期  ID  结论  标题` 打印一次。
- `--month YYYY-MM` 只列指定归档月份（隐含 `--archive`）；格式非法时报错并以非零码退出；无匹配时打印 `归档 YYYY-MM（0）`。
- 末尾仅在存在时打印汇总：`跨机历史 3 条 · 档案异常 1 条`，并为档案异常逐条打印 `相对路径  原因`；给出 `--month` 时明细按该月过滤。
- 不提供 `--all`。

## JSON 输出

- `knit task list --json`：`{root, scope:"active", active:[…], archivedCount, problems}`；不含归档条目数组。
- `knit task list --archive --json`：`{root, scope:"archive", archived:[…], archivedCount, month?, problems}`；`archivedCount` 始终是全部归档条数，`--month` 只过滤 `archived` 数组。
- `active` 条目字段保持现状（含 `status`／`outcome`／`stage` 等），消费方按需自行分段。

## 文案同步

- 受管块模板 `src/application/templates.ts`、本仓库 `AGENTS.md` 受管块与开发入口首段、`README.md`、`docs/README.md`：任务列表写为“活跃用 `knit task list`，归档用 `knit task list --archive`”。
- 桥接资产 `assets/templates/pi/extensions/knit.ts`：`knit_task` 列表渲染按新分区输出、只提示归档条数，不再展开归档明细；JSON 分支按 `scope` 判定，归档视图走 `task list --archive --json`。
- DESIGN 的能力表、§3.10／§3.11 展示与命令表，OPERATIONS 的实现说明同步更新；历史档案与 validation 记录不改。

## 完成条件

- CLI 测试覆盖：三分区与空分区、定宽列与表头、汇总计数（含阻塞）、`--archive` 按月分组、`--month`、归档问题汇总、JSON `scope`／`archivedCount`、无 `--all`。
- 桥接测试覆盖：`knit_task` 列表渲染分组与归档条数提示、归档视图路径。
- 现有测试全绿，`npm run -s typecheck` 与 `npm run -s build` 通过。
- 在仓库实跑 `knit task list`、`knit task list --archive`、`knit --json task list`，输出符合上述规格。

## 输入引用

- 本次会话讨论结论：默认只列活跃；归档有专门入口；行只留优先级／ID／阶段／标题（阶段放标题前一列）；列间采用定宽对齐 + 表头；归档视图保留结论列；已取消单独一段；JSON 跟随收紧；读取成本单独立项。
- [仓库规范](../../../AGENTS.md)、[DESIGN](../../../docs/design/DESIGN.md) §3.10／§3.11、[OPERATIONS](../../../docs/design/OPERATIONS.md) 第 3 节。
- 实现范围：`src/cli/task.ts`、`assets/templates/pi/extensions/knit.ts`、`src/application/templates.ts`、`test/task.test.mjs`、`test/bridge-query.test.mjs`、`test/task-history.test.mjs`、`test/m1-cli.test.mjs`、`test/task-schedule.test.mjs`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 实现与验证（当前会话）

- `knit task list` 默认只列未归档任务，按 进行中（`open`）／待归档（`closed` 且非取消）／已取消（`cancelled`／`superseded`）分段；行内固定四列（优先级、ID、阶段显示名、标题），按显示宽度补齐，表头只打一次，阻塞只在汇总行计数。
- 新增 `--archive`（按月分组，行内给日期、ID、结论、标题）与 `--month YYYY-MM`（隐含归档视图，非法格式拒绝）；跨机历史与档案异常只在归档视图末尾汇总，档案问题逐条给出路径与原因。
- `--json` 增加 `scope` 与 `archivedCount`，默认不返回归档数组；`TaskService.list` 的派生结果与 `task next`／依赖阻塞／父子判定不变。
- 同步桥接模板与仓库副本、`knit_task` 的 list 渲染与 `archive`／`month` 参数、受管块文案、README／docs 索引、DESIGN 与 OPERATIONS；读取成本单独立项为 k-3d730c8907b3。

验证：

- `npm test`：526 项、519 通过、7 失败。失败均为本机环境既有问题：TMPDIR 指向 `/var` 而服务端 realpath 为 `/private/var`（task adopt、worktree connect）、Unix socket 路径超长（rex worker）、Rex 自动探测（已在 HEAD 上复核同失败）。
- 新增用例覆盖三分区与空分区、定宽列与表头、阻塞计数、`--archive` 月度分组、`--month` 过滤与非法月份、JSON `scope`／`archivedCount`、桥接默认与归档视图。
- 实跑 `node dist/cli/knit.js task list`：进行中 2 · 待归档 0 · 已取消 6 · 阻塞 0 · 归档 53；`--archive`、`--archive --month 2026-11`、`--json task list` 输出符合规格。

已知限制：本机 `installation.json` 仍指向全局安装的 0.1.0 CLI，桥接实际调用要等重新安装／重新 init 才用上新代码；本次未做安装或发布操作。

### 强制归档说明（无 delivery 操作）

用户要求直接提交、归档、推送。本任务由主会话直接实施，没有已接收的 implement run，完成守卫（`verification: self`）要求阶段到收尾且有匹配的 implement run，`knit task close` 与 `knit deliver` 均被拒绝。经用户明确要求本次强制手工完成：

- 手工把 frontmatter 改为 `status: closed`、`stage: deliver`、`outcome: completed`；
- 未生成 `.knit/.runtime/completions/<taskId>.json`，`metadata.db` 绑定未更新；
- 业务产物、任务资料、归档移动按 artifact／metadata／archive 三次提交完成，提交信息标 `(forced)`；
- 流程缺口（主会话实施的任务无法走 self 完成）留作后续处理。

<!-- knit:progress:end -->
