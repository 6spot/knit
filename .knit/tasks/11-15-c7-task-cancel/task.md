---
id: k-40f9896ebaef
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-3f57f98713a8
order: null
createdAt: 2026-11-15T07:48:54.430Z
title: C7 next 的 knit task cancel：取消任务
---

# C7 next 的 knit task cancel：取消任务

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。不再做的任务要能取消，取消的任务放进归档目录，不留在任务列表里（`.knit/tasks/11-14-slim-refactor/design.md` 第 2 节、第 3.2 节）。

做完之后的不同：`node next/dist/cli/knit.js task cancel <id> --reason <原因>` 可以取消一个任务。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/task-store.ts`（修改） | 新增 `archiveTask`：把任务目录移到 `.knit/tasks/archive/<YYYY-MM>/` |
| `next/src/cli/task.ts`（修改） | 注册 `task cancel` |
| `next/test/task-cancel.test.mjs`（新增） | 见「完成条件」的两个场景，各一个测试 |

`task cancel <id>` 的选项：`--reason <原因>`（必填）、`--dir <目录>`（默认当前目录）。

行为：

1. 找不到任务，或 `task.md` 有格式问题：同 `task ready`，退出码 1。
2. `--reason` 去掉首尾空白后是空的：标准错误 `--reason 不能为空：写为什么不做了`，退出码 1。
3. 状态是 `delivered` 或 `cancelled`：标准错误说明任务已经结束（带上状态），退出码 1。其它状态（`draft`、`ready`、`active`、`done`）都可以取消。
4. `task.md` 的 `status` 改成 `cancelled`，`stage` 改成 `null`；「结果」写成 `已取消：<原因>`，原来有「结果」时接在它后面另起一段。用 `saveTask` 写回。需求部分不动。
5. 把任务目录移到 `.knit/tasks/archive/<YYYY-MM>/<原目录名>`，月份取本机当月；归档目录不存在时创建。
6. 打印两行：`已取消 <id>` 和归档后的目录。退出码 0。

- 第 1–3 步里任何一步拒绝时都不写文件、不移动目录。
- 不提交：移动之后工作区里是未提交的改动。
- 子任务不跟着取消：取消一个任务不改动别的任务。
- 不检查“有没有执行者还在跑”：执行的记录由做执行的任务加，到时候在那里补上这一条。
- 只做人读的输出，不做 `--json`。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- C1、C2 的文件：本任务只调用。发现问题写进报告，不在本任务里改。
- 其它 `task` 命令的行为不变，它们的测试继续通过。
- 所有验证都在临时目录里做，不对本仓库运行 `task cancel`：本仓库的任务还是旧格式。
- 不加依赖，不提交、不推送。

前置条件：C6 已完成。运行 `npm run test:next` 能通过，并且 `grep -n "saveTask" next/src/application/task-store.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 在 `task-store.ts` 里加 `archiveTask`，在 `cli/task.ts` 里加 `task cancel`。
4. 写测试：用 `next/test/helpers/cli.mjs` 建临时项目，用 `task new` 建任务。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件和上表两个文件的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add task cancel`。

## 完成条件

### Requirement: 取消任务

#### Scenario: 取消并归档

- GIVEN 一个 `draft` 任务
- WHEN 运行 `task cancel <id> --reason 不做了`
- THEN 任务目录移到了 `.knit/tasks/archive/<YYYY-MM>/` 下，`task.md` 的状态是 `cancelled`，「结果」是 `已取消：不做了`
- AND `task list` 里没有它，`task list --archive` 和 `task show <id>` 里有它

#### Scenario: 已经结束的任务不能取消

- GIVEN 一个已经取消的任务
- WHEN 再运行一次 `task cancel <id> --reason 不做了`
- THEN 标准错误里说明任务已经结束，退出码为 1
- AND 文件和目录都没有变化

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md` 第 2 节、第 3.2 节 — 目录布局里的归档目录；状态
- `.knit/standards/development.md` — 开发规范
- `next/src/application/task-store.ts` — 要改的文件：`findTask`、`saveTask`、目录名怎么避开重名
- `next/src/cli/task.ts`、`next/test/task-close.test.mjs`、`next/test/helpers/cli.mjs` — 命令和命令测试的现有写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
