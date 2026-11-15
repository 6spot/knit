---
id: k-efa866531ee9
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-959c96d0b4ae
order: null
createdAt: 2026-11-15T15:02:51.861Z
title: E16 有执行者在跑时不能完成或取消任务
---

# E16 有执行者在跑时不能完成或取消任务

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。`task close`（记为完成）和 `task cancel`（取消并归档）是在还没有执行者的时候写的。现在有了后台执行者，要补上两处衔接（`.knit/tasks/11-14-slim-refactor/design.md` 第 3.3 节）：执行者还在跑时把任务记为完成或移进归档，它结束时就找不到地方写结果了；需求改过并重新确认之后，以前的审查通过不能再算数。

做完之后的不同：任务有执行还没结束时，`task close`、`task cancel` 拒绝并说明怎么办；独立审查的任务只认按现在的需求做出的审查结论。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/cli/task.ts`（修改） | `task close`、`task cancel` 加上检查；`task close` 判断审查通过时只看算数的执行 |
| `next/test/task-runs.test.mjs`（新增） | 见「完成条件」的两个场景，各一个测试 |

规则：

- `task close`、`task cancel`：这个任务的执行记录里有没结束的一项（`endedAt` 是 `null`）时拒绝，标准错误 `任务 <id> 的执行 <run-id> 还没有结束；等它结束，或运行 knit run cancel <id>`，退出码 1，不改任何文件。这项检查排在各自已有的检查（参数为空、任务已经结束等）之后、写文件之前。
- `task close` 对独立审查任务的判断，从“执行记录里最后一次有结论的执行是 `pass`”改成“算数的执行（`countedRuns`）里最后一次有结论的是 `pass`”。失败的执行、需求改之前的执行都不算。不满足时的要求不变：加 `--reason <理由>` 才能直接完成。
- 只看这个任务自己的执行；别的任务有执行者在跑不影响。

已有的 `next/test/task-close.test.mjs`、`next/test/task-cancel.test.mjs` 继续通过。它们手写的执行记录里 `requirementDigest` 如果和 `confirmedDigest` 对不上，按新规则不算数，会让原来“审查通过”的测试失败：这种情况只把测试里那一处的摘要改成和任务的 `confirmedDigest` 一致，别的不改。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function countedRuns" next/src/domain/progress.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `cli/task.ts`。
4. 运行 `npm run test:next`，已有测试因为摘要对不上而失败时，按上面说的改那一处。
5. 写测试：没结束的执行可以用 `prepareRun` 准备出来，也可以直接往 `record.json` 里写一项。
6. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件、`next/src/cli/task.ts` 的修改，以及 `next/test/task-close.test.mjs` 里摘要的改动（有的话）。
- `git diff --stat -- src test assets scripts package.json next/test/task-cancel.test.mjs`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): keep task close and cancel away from a live run`。

## 完成条件

### Requirement: 任务的结束和执行的衔接

#### Scenario: 有执行没结束时不能完成或取消

- GIVEN 一个已确认的任务，执行记录里有一项没结束的执行
- WHEN 分别运行 `knit task close <任务> --result 做完了` 和 `knit task cancel <任务> --reason 不做了`
- THEN 退出码都是 1，标准错误是 `任务 <id> 的执行 <run-id> 还没有结束；等它结束，或运行 knit run cancel <id>`
- AND 任务的两个文件没有变化，任务目录没有被移走；把那一项结束之后，`task close` 成功

#### Scenario: 需求改过之后以前的审查通过不算

- GIVEN 一个 `independent` 任务，审查结论 `pass`；之后改了需求部分并重新 `task ready`
- WHEN 运行 `knit task close <任务> --result 做完了`
- THEN 退出码是 1，标准错误是 `独立审查的任务要在审查通过后才能完成；用户明确要求直接完成时，加 --reason <理由>`
- AND 需求没改过的同样的任务，`task close` 成功；最后一次审查是失败的执行、再往前一次是 `pass` 时也成功

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#33-recordjson` — 有执行者在跑时不能做什么、需求改过之后以前的执行不算数
- `.knit/standards/development.md` — 开发规范
- `next/src/cli/task.ts` — 要改的文件
- `next/src/domain/progress.ts` — `countedRuns`
- `next/test/task-close.test.mjs` — `task close` 的测试写法；修改后要继续通过
- `next/test/task-cancel.test.mjs` — `task cancel` 的测试写法；修改后要继续通过

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
