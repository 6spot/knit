---
id: k-f0af41e0619b
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-355b59a06e15
order: null
createdAt: 2026-11-15T07:48:50.754Z
title: C3 next 的 knit task new：创建任务
---

# C3 next 的 knit task new：创建任务

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。C1 定了任务两个文件的格式，C2 搬了完成条件的解析。本任务加上读写任务目录的代码和第一个任务命令。

做完之后的不同：`node next/dist/cli/knit.js task new --title <标题>` 可以在项目的 `.knit/tasks/` 下创建一个任务。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/task-store.ts`（新增） | 扫描任务目录、按 id 找任务、创建任务 |
| `next/src/cli/task.ts`（新增） | 注册 `task new` |
| `next/src/cli/knit.ts`（修改） | 注册 `task` 命令组 |
| `next/test/helpers/cli.mjs`（新增） | 两个测试用的函数：建一个带 `.knit/` 的临时项目（测试结束时删除）；运行 `node next/dist/cli/knit.js <参数>` 并返回退出码和输出 |
| `next/test/task-new.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`task-store.ts`：

- 任务在 `.knit/tasks/<目录>/`，已归档的在 `.knit/tasks/archive/<YYYY-MM>/<目录>/`。
- `scanTasks(root)`：读出所有任务（含已归档的）。每个任务给出：项目内的相对目录、是否已归档、用 C1 的函数解析出的 `document` 和 `record`、解析时的问题。`task.md` 读不出来的任务也要列出来，带着问题，不能让一个写坏的文件挡住其它任务。没有 `record.json` 时按 C1 的规则得到空记录。
- `findTask(root, id)`：按 `id` 找一个任务，找不到返回 `null`。
- `createTask(root, input)`：建目录并写入 `task.md`，不写 `record.json`（第一次有内容要记时再建）。写文件用 `next/src/infrastructure/atomic.ts` 的 `atomicWrite`，`expectedSha256` 传 `null`（要求文件还不存在），`mode` 传 `0o644`（默认是 `0600`，而这个文件要入库）。

`task new` 的行为：

- 选项：`--title <标题>`（必填）、`--slug <名称>`（默认 `task`）、`--verification <方式>`（`none`、`self`、`independent`，默认 `self`）、`--priority <优先级>`（`P0`–`P3`，默认 `P2`）、`--parent <任务 id>`、`--depends-on <任务 id...>`（可以给多个）、`--dir <目录>`（默认当前目录）。项目根用 `next/src/cli/root.ts` 的 `projectRoot`。
- 目录名是 `MM-DD-<名称>`，日期取本机当天。名称里字母、数字、`_`、`-` 以外的字符换成 `-`，去掉首尾的 `-`，结果为空时用 `task`。`.knit/tasks/` 或任何一个归档月份里已有同名目录时，在后面加 `-2`、`-3`……
- 新任务的 `id` 是 `k-` 加 12 位随机十六进制，`status` 是 `draft`，`stage` 是 `null`，`createdAt` 是当前时间的 ISO 字符串。正文是四个空的小节：`## 目标与范围`、`## 完成条件`、`## 待澄清`、`## 相关资料`，没有 `## 结果`。
- 成功时在标准输出打印两行：`已创建 <id>` 和 `task.md` 的项目内相对路径。退出码 0。
- 以下情况不创建任何文件，在标准错误里说明原因，退出码 1：项目里没有 `.knit/` 目录（提示运行 `knit init`）；`--verification` 或 `--priority` 的值不认识（列出可用的值）；`--parent` 或 `--depends-on` 给的任务不存在（点出是哪个 id；已归档的任务算存在）。
- 只做人读的输出，不做 `--json`。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- C1、C2 的文件（`next/src/contracts/task.ts`、`next/src/domain/task-document.ts`、`next/src/domain/task-record.ts`、`next/src/domain/task-requirements.ts`）：格式由它们定，本任务只调用。发现问题写进报告，不在本任务里改。
- 不要对本仓库运行 `task new`：本仓库的 `.knit/tasks/` 还由旧的 Knit 管理，里面多出一个新格式的任务会让旧的 Knit 报错。所有验证都在临时目录里做。
- 不加依赖，不提交、不推送。

前置条件：C1、C2 已完成。运行 `npm run test:next` 能通过，并且 `ls next/src/domain/task-document.ts next/src/domain/task-record.ts` 都存在。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 新增 `task-store.ts` 和 `cli/task.ts`，在 `knit.ts` 里注册。
4. 新增测试用的 `helpers/cli.mjs` 和测试文件。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出上表的 4 个新文件和 `next/src/cli/knit.ts` 的修改；`.knit/tasks/` 下没有多出目录。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add task new`。

## 完成条件

### Requirement: 创建任务

#### Scenario: 创建一个任务

- GIVEN 一个有 `.knit/` 目录的项目
- WHEN 运行 `task new --title 交接只传需求部分 --slug handoff`
- THEN `.knit/tasks/<MM-DD>-handoff/task.md` 存在，能被 C1 的 `parseTaskDocument` 解析，状态是 `draft`，标题是给定的标题
- AND 标准输出里有新任务的 id 和这个文件的路径，退出码为 0

#### Scenario: 同名目录加序号

- GIVEN 已经用 `--slug handoff` 创建过一个任务
- WHEN 同一天再用 `--slug handoff` 创建一个
- THEN 第二个任务的目录是 `<MM-DD>-handoff-2`，两个任务的 id 不同

#### Scenario: 参数不对时不创建

- WHEN 运行 `task new`，`--parent` 给了一个不存在的任务，或 `--verification` 给了不认识的值
- THEN 标准错误里说明是哪个参数的问题，退出码为 1
- AND `.knit/tasks/` 下没有多出目录

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md` 第 2 节、第 3 节、第 9 节 — 目录布局；任务资料；命令清单
- `.knit/standards/development.md` — 开发规范
- `next/src/domain/task-document.ts`、`next/src/domain/task-record.ts`、`next/src/contracts/task.ts` — 要调用的解析和渲染
- `next/src/infrastructure/atomic.ts` — `atomicWrite`
- `next/src/cli/root.ts`、`next/src/cli/workflow.ts`、`next/test/workflow-cli.test.mjs` — 项目根；命令和命令测试的现有写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-7764eea1fe2f -->
- 操作: op-7764eea1fe2f
- 时间: 2026-11-15T09:06:43.463Z
- 分支: refs/heads/main
- 授权来源: user:0f1c5bab
- 调用: bridge
- 工作提交: e51b1c07ac7cfa89b87793f0312517ce4cd8fb62
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-c3-task-new

### 任务资料提交记录

<!-- knit:metadata-commit:op-7764eea1fe2f -->
- 任务资料提交: 285f5721f28a4948c1e1467c51d8bdf349bf6746
- 归档目标: .knit/tasks/archive/2026-11/11-15-c3-task-new

<!-- knit:progress:end -->
