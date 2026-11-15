---
id: k-3f57f98713a8
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-6ee0f30669c2
order: null
createdAt: 2026-11-15T07:48:53.540Z
title: C6 next 的 knit task close：完成任务并写结果
---

# C6 next 的 knit task close：完成任务并写结果

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。任务做完之后由主会话把它记为完成，并在 `task.md` 末尾写「结果」：一段总结，说明做成了什么、完成条件是否都满足、怎么验证的。质量的门在这一步，之后的交付只管提交（`.knit/tasks/11-14-slim-refactor/design.md` 第 3.1 节、第 8.1 节）。

做完之后的不同：`node next/dist/cli/knit.js task close <id> --result <总结>` 可以把一个任务记为完成。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/cli/task.ts`（修改） | 注册 `task close` |
| `next/test/task-close.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`task close <id>` 的选项：`--result <总结>`（必填）、`--paths <路径...>`（主会话自己改动的文件，可以给多个，可以不给）、`--reason <理由>`（见第 4 步）、`--dir <目录>`（默认当前目录）。

行为：

1. 找不到任务，或 `task.md` 有格式问题：同 `task ready`，退出码 1。
2. `--result` 去掉首尾空白后是空的：标准错误 `--result 不能为空：写做成了什么、完成条件是否都满足、怎么验证的`，退出码 1。
3. 用 `currentStatus` 算任务现在的状态。`ready` 和 `active` 可以完成；其它状态拒绝，在标准错误里说明原因和下一步，退出码 1：
   - `draft`：`需求还没有确认，或确认之后改过；先运行 knit task ready <id>`。
   - `done`：`任务已经完成；要改总结直接编辑 task.md 的「结果」`。
   - `delivered`、`cancelled`：说明任务已经结束（带上状态）。
4. `verification` 是 `independent` 的任务，要有审查通过的记录才能完成：`record.json` 的 `runs` 里，最后一条带结论的执行，结论是 `pass`。没有这样的记录时：
   - 没给 `--reason`：标准错误 `独立审查的任务要在审查通过后才能完成；用户明确要求直接完成时，加 --reason <理由>`，退出码 1。
   - 给了 `--reason`：可以完成，并在「结果」的末尾另起一段写 `没有经过独立审查，直接完成：<理由>`。
   - `self`、`none` 的任务不看这一条，给了 `--reason` 也不写进「结果」。
5. `--paths` 里的每个路径都必须是项目内的相对路径；绝对路径和跑出项目根的路径拒绝，点出是哪一个，退出码 1。不要求文件存在（改动可以是删除）。
6. 通过：`--paths` 给的路径并入 `record.json` 的 `changedPaths`，去重后按路径排序；`task.md` 的 `status` 改成 `done`，`stage` 改成 `null`，「结果」写成 `--result` 的内容（原来有「结果」时替换掉）。用 `saveTask` 写回。
7. 打印 `已完成 <id>`，退出码 0。

- 主会话直接做的任务没有单独的开始和登记命令：确认之后直接 `task close`，不经过 `active`，改动的文件就在这时用 `--paths` 登记。
- 第 1–5 步里任何一步拒绝时都不写文件。
- 需求部分不动：完成前后需求摘要相同。
- 不检查“有没有执行者还在跑”：执行的记录由做执行的任务加，到时候在那里补上这一条。
- 只做人读的输出，不做 `--json`。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- C1、C2 的文件和 `next/src/application/task-store.ts`：本任务只调用。发现问题写进报告，不在本任务里改。
- 其它 `task` 命令的行为不变，它们的测试继续通过。
- 所有验证都在临时目录里做，不对本仓库运行 `task close`：本仓库的任务还是旧格式。
- 不加依赖，不提交、不推送。

前置条件：C5 已完成。运行 `npm run test:next` 能通过，并且 `grep -n "saveTask" next/src/application/task-store.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 在 `cli/task.ts` 里加 `task close`。
4. 写测试：用 `next/test/helpers/cli.mjs` 建临时项目，用 `task new` 和 `task ready` 把任务带到 `ready`；需要 `independent` 或执行记录时直接改写临时项目里的 `task.md`、`record.json`。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件和 `next/src/cli/task.ts` 的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add task close`。

## 完成条件

### Requirement: 完成任务

#### Scenario: 完成一个已确认的任务

- GIVEN 一个 `ready` 的 `self` 任务
- WHEN 运行 `task close <id> --result 做完了 --paths next/src/a.ts next/src/b.ts`
- THEN `task.md` 的状态是 `done`，「结果」是 `做完了`，需求部分逐字不变
- AND `record.json` 的 `changedPaths` 是这两个路径，退出码为 0

#### Scenario: 不能完成时说明下一步

- WHEN 对一个 `draft` 任务、或确认之后改过需求的任务运行 `task close <id> --result 做完了`
- THEN 标准错误里提示先运行 `knit task ready <id>`，退出码为 1
- AND `task.md` 和 `record.json` 都没有变化

#### Scenario: 独立审查的任务要先审查通过

- GIVEN 一个 `ready` 的 `independent` 任务，没有审查通过的记录
- WHEN 运行 `task close <id> --result 做完了`
- THEN 被拒绝，标准错误里提到 `--reason`，退出码为 1
- AND 加上 `--reason 用户要求` 再运行时完成，「结果」的末尾有 `没有经过独立审查，直接完成：用户要求`

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md` 第 3 节、第 8.1 节 — 「结果」写什么、状态、`record.json` 的字段；什么时候算完成
- `.knit/standards/development.md` — 开发规范
- `next/src/application/task-store.ts` — `findTask`、`saveTask`
- `next/src/domain/task-document.ts`、`next/src/domain/task-record.ts` — `currentStatus`、数据的形状
- `next/src/cli/task.ts`、`next/test/task-ready.test.mjs`、`next/test/helpers/cli.mjs` — 命令和命令测试的现有写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-bb97de2b4218 -->
- 操作: op-bb97de2b4218
- 时间: 2026-11-15T09:06:47.243Z
- 分支: refs/heads/main
- 授权来源: user:0f1c5bab
- 调用: bridge
- 工作提交: eda894961e7873d806b3fe5ef683a0afbe214118
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-c6-task-close

<!-- knit:progress:end -->
