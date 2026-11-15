---
id: k-e10d8ff38744
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-0fd45900b7bf
order: null
createdAt: 2026-11-15T15:02:42.537Z
title: E8 结束一次执行：记下结论、失败原因和改动文件
---

# E8 结束一次执行：记下结论、失败原因和改动文件

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。一次执行不管怎样收场（正常做完、启动失败、被取消、进程意外退出），都要在任务的执行记录里记下来：结束时间、结论或失败原因、改动的文件（`.knit/tasks/11-14-slim-refactor/design.md` 第 3.3、7 节）。执行者提交了改动，或者改了受保护的文件，这次执行记为失败。本任务把这一步写成一个函数，后面启动执行者的任务和取消的任务都调用它。

做完之后的不同：`next/` 里有了 `finishRun`：给它一次没结束的执行和它的结论或失败原因，它对比工作区、核对提交和受保护的路径，把结果写进 `record.json`。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/run-finish.ts`（新增） | `finishRun(input)` |
| `next/test/run-finish.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`finishRun({ root, taskId, runId, workflow, verdict, failure, sessionFile })`：`verdict` 是执行者给的结论或 `null`，`failure` 是调用方已经知道的失败原因或 `null`，`sessionFile` 是会话文件的位置或 `null`。返回问题的列表，空的表示记好了。

1. 读入任务，在执行记录里找到这一项，它要还没结束（`endedAt` 是 `null`）。找不到或已经结束：返回 `执行 <runId> 不在任务 <taskId> 的记录里，或者已经结束`，不改任何文件。
2. 读 `<RUNS_DIR>/<runId>/before.json`，用 `changesSince` 得出改动文件，去掉任务目录里的文件（任务目录在交付时整个提交，不逐个记）。`before.json` 不在时改动文件是空的，也不核对下面两条。
3. 定失败原因，按这个先后取第一个成立的：
   - 调用方给了 `failure`：用它。
   - HEAD 动了：`执行者提交了改动：HEAD 从 <前 7 位> 变成 <前 7 位>`。
   - 改动文件里有受保护的（`protectedChanges`）：`执行者改了受保护的文件：<路径，用顿号隔开>`。
   - 都不成立：`null`。
4. 写回这一项：`endedAt` 是现在的时间（ISO 格式），`failure` 是上一步的结果，`verdict` 在失败时是 `null`、否则是给的值，`changedPaths` 是第 2 步的结果，`sessionFile` 是给的值。任务的状态和环节不改。
5. 用 `saveTask` 写回。它报文件在读入之后被改过时，从第 1 步重新做，最多做三次；第三次还不行，返回它的问题。

失败了也照样记下改动文件：文件已经改在工作区里，交付时要知道它们。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function prepareRun" next/src/application/run-prepare.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `application/run-finish.ts`。
4. 写测试：用 `next/test/helpers/run.mjs` 的 `runProject`、`readyTask` 和 `prepareRun` 准备出一次没结束的执行，再改文件、调用 `finishRun`。同一时间只能有一次没结束的执行：要用到几次执行的测试，结束一次再准备下一次，或者各用一个临时项目。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 2 个新文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：本任务要求独立审查，由另一个执行者对照完成条件审查；提交由用户另行授权，文案首行建议 `feat(next): record the outcome of a run`。

## 完成条件

### Requirement: 结束一次执行

#### Scenario: 正常结束时记下结论和改动文件

- GIVEN 一次准备好的审查执行；之后新增了 `src/a.ts`，改了任务目录里的 `plan.md`，在 `.knit/.runtime/` 下写了一个文件
- WHEN 以结论 `pass`、没有失败原因结束它
- THEN 返回空列表；记录里这一项有结束时间，`verdict` 是 `pass`，`failure` 是 `null`，`changedPaths` 只有 `src/a.ts`
- AND `task.md` 的状态和环节没有变

#### Scenario: 提交了改动或改了受保护的文件时记为失败

- GIVEN 两次准备好的执行：一次期间改了文件并做了提交，一次期间改了 `.knit/standards/` 下的一个文件
- WHEN 都以结论 `pass`、没有失败原因结束
- THEN 两次的 `verdict` 都是 `null`；`failure` 分别以 `执行者提交了改动：` 和 `执行者改了受保护的文件：` 开头
- AND 改动文件照样记在 `changedPaths` 里

#### Scenario: 调用方给的失败原因照记，结束过的不能再结束

- GIVEN 一次准备好的执行
- WHEN 以失败原因 `已取消` 结束它，然后再结束一次
- THEN 第一次之后 `failure` 是 `已取消`、`verdict` 是 `null`
- AND 第二次返回 `执行 <runId> 不在任务 <taskId> 的记录里，或者已经结束`，记录没有再变

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 执行结束时做什么
- `.knit/tasks/11-14-slim-refactor/design.md#33-recordjson` — 执行记录的字段
- `.knit/standards/development.md` — 开发规范
- `next/src/application/run-prepare.ts` — `RUNS_DIR`、`prepareRun`
- `next/src/application/workspace.ts` — `changesSince`、`protectedChanges`
- `next/src/application/task-store.ts` — `findTask`、`saveTask`
- `next/test/helpers/run.mjs` — `runProject`、`readyTask`

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-15T15:02:43.370Z
- 方式: self → independent；理由: 状态推进、改动对比、受保护的路径属于正确性没法自证的改动

<!-- knit:progress:end -->
