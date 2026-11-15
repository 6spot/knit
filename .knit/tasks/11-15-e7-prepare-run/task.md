---
id: k-0fd45900b7bf
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-1720b3176696
order: null
createdAt: 2026-11-15T15:02:41.399Z
title: E7 准备一次执行：派发前的检查和交接内容落盘
---

# E7 准备一次执行：派发前的检查和交接内容落盘

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。派发一个环节分两步：先准备（检查能不能派发，把交给执行者的内容和工作区的记录存下来，在任务的执行记录里登记这一次），再启动后台进程去做（`.knit/tasks/11-14-slim-refactor/design.md` 第 7 节）。本任务做第一步，写成一个函数；命令行和后台进程由后面的任务加。

做完之后的不同：`next/` 里有了 `prepareRun`：能派发时在 `.knit/.runtime/runs/<run-id>/` 下存好交接内容并登记一次执行；不能派发时说明原因，什么都不写。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/run-prepare.ts`（新增） | `RUNS_DIR`、`unfinishedRun(root)`、`prepareRun(input)` |
| `next/test/helpers/run.mjs`（新增） | `runProject(t)`、`readyTask(dir, options)`，后面的任务也用它们 |
| `next/test/run-prepare.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`RUNS_DIR` 是 `.knit/.runtime/runs`。一次执行的目录是 `<RUNS_DIR>/<run-id>`，`run-id` 是 `r-` 加 12 位十六进制随机数。

`unfinishedRun(root)`：在所有没归档的任务里找一次还没结束的执行（`endedAt` 是 `null`），返回 `{ taskId, runId }`，没有时是 `null`。

`prepareRun({ root, taskId, workflow, config, model })`：`workflow` 是解析好的流程，`config` 是 `loadConfig` 读出的配置，`model` 是调用方临时指定的模型（`provider/模型`）或 `null`：给了就用它，没给用流程里这个环节的 `model`。返回 `{ run, problems }`：能派发时 `run` 是 `{ id, dir, stage, model }`（`dir` 相对项目根，`stage` 是流程里的那个环节，`model` 是最后用的模型），`problems` 是空的；不能派发时 `run` 是 `null`。

按下面的先后检查，遇到第一类问题就返回，这时不写任何文件：

| 情况 | `problems` |
| --- | --- |
| 没有这个任务 | `没有任务 <id>；用 knit task list 查看现有任务` |
| 任务文件写坏了 | `scanTasks` 给出的问题 |
| 项目不在 Git 仓库里（`git rev-parse --is-inside-work-tree` 失败） | `这个目录不在 Git 仓库里，不能派发执行者` |
| 状态（`currentStatus`）是 `draft` | `需求还没有确认，或确认之后改过；先运行 knit task ready <id>` |
| 状态是 `done`、`delivered`、`cancelled` | `任务已经结束（<状态>），不能再派发` |
| `dependsOn` 里有任务不是 `done` 或 `delivered`（已归档的也算在内） | 每个一句：`依赖的任务还没有完成：<id>（<状态>）`；找不到的是 `依赖的任务不存在：<id>` |
| `unfinishedRun` 不是 `null`：同一时间只跑一个执行者 | `任务 <taskId> 的执行 <runId> 还没有结束；等它结束，或运行 knit run cancel <taskId>` |
| `nextStep` 是 `close` | `所有环节都做完了；核对之后运行 knit task close <id>` |
| `nextStep` 是 `limit` | `<环节名>环节已经进入 <次数> 次，到了上限，不再派发` |
| `model` 没给，要派发的环节在流程里也没有 `model` | `没有指定执行者的模型：在 .knit/workflow.yaml 里写 model，或加 --model provider/模型` |
| 给了 `model`，但不是 `provider/模型` 的写法 | `--model 要写成 provider/模型：<值>` |
| `assembleHandoff` 的 `problems` 不为空 | 照原样返回 |

都通过之后，按这个先后做：

1. 拼交接内容：`assembleHandoff`，`limits` 用 `config.handoff`。`previous` 是最后一次算数的执行（`countedRuns` 的最后一项）：环节 id、报告路径 `<那次执行的目录>/report.md`、它的 `changedPaths` 和报告原文；报告文件不在时原文用一句 `报告原文不在这台机器上。`。没有算数的执行时是 `null`。
2. 用 `saveTask` 写回任务：`status` 改成 `active`，`stage` 改成这个环节的 id；执行记录末尾加一项，`endedAt`、`verdict`、`failure`、`sessionFile` 是 `null`，`changedPaths` 是空的，`requirementDigest` 是现在需求部分的摘要。`saveTask` 报文件被改过时照原样返回它的问题，不再往下做。
3. 建执行目录，写 `system.md`（系统提示）、`message.md`（第一条消息）和 `before.json`（`takeSnapshot` 的结果）。`before.json` 在第 2 步之后拍，任务自己的两个文件的变化就不会算成执行者的改动。

`helpers/run.mjs`：

- `runProject(t)`：用 `gitProject` 的做法建临时仓库，里面有实现、审查两个环节的 `.knit/workflow.yaml`（两个环节的 `tools` 都是 `[read, write, exec]`；审查环节声明 `verdict: [pass, changes_requested, blocked]`，`onVerdict` 是 `changes_requested: implement`、`blocked: review`）、两份角色文件，流程顶层写着 `model: fake/model`，并且都已提交。项目里没有 `.knit/config.json`。
- `readyTask(dir, options)`：用 `task new` 建任务，写上带一个场景的需求，再 `task ready`；`options` 可以指定验证方式和依赖。返回任务的 id 和目录。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function takeSnapshot" next/src/application/workspace.ts`、`grep -n "export function nextStep" next/src/domain/progress.ts`、`grep -n "export function loadConfig" next/src/application/config.ts`、`grep -n "invalid_model" next/src/contracts/workflow.ts` 都有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `application/run-prepare.ts`。
4. 写 `helpers/run.mjs` 和测试。测试直接调用 `next/dist/application/run-prepare.js` 的函数；流程和配置用 `parseWorkflow`、`loadConfig` 读出。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 3 个新文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): prepare a run`。

## 完成条件

### Requirement: 准备一次执行

#### Scenario: 能派发时存好交接内容并登记

- GIVEN 一个已确认的 `independent` 任务，还没有执行过
- WHEN 准备一次执行
- THEN 得到实现环节；执行目录里有 `system.md`、`message.md`、`before.json`，前两个的内容和 `assembleHandoff` 拼出的相同
- AND `task.md` 的状态是 `active`、环节是 `implement`；执行记录里多了一项，`endedAt` 是 `null`，`requirementDigest` 等于 `confirmedDigest`；用的是流程里这个环节的模型，另外给了 `model` 时用给的

#### Scenario: 不能派发时说明原因，什么都不写

- GIVEN 分别是：需求没确认的任务；依赖的任务还是 `ready` 的任务；另一个任务有一次没结束的执行；流程里没有写模型、也没给 `model`
- WHEN 准备一次执行
- THEN `run` 是 `null`，`problems` 分别是上表里对应的句子
- AND 没有建出执行目录，任务的两个文件没有变化

#### Scenario: 下一个环节拿到上一个环节的报告

- GIVEN 实现环节已经正常结束：执行记录里那一项有结束时间和改动文件，执行目录里有 `report.md`
- WHEN 再准备一次执行
- THEN 得到审查环节，`message.md` 里有 `<previous-report stage="implement" …>` 块，带着改动的文件和报告原文
- AND 把那份 `report.md` 删掉之后，块里的原文是 `报告原文不在这台机器上。`

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 派发前检查什么、执行目录里有哪些文件
- `.knit/tasks/11-14-slim-refactor/design.md#61-流程` — 下一步做哪个环节
- `.knit/standards/development.md` — 开发规范
- `next/src/application/handoff.ts` — `assembleHandoff`
- `next/src/application/task-store.ts` — `scanTasks`、`findTask`、`saveTask`
- `next/src/domain/task-document.ts` — `currentStatus`、`requirementDigest`
- `next/src/domain/progress.ts` — `countedRuns`、`nextStep`
- `next/src/application/workspace.ts` — `takeSnapshot`
- `next/src/application/config.ts` — `loadConfig`、`ProjectConfig`
- `next/test/helpers/git.mjs` — `gitProject`
- `next/test/task-ready.test.mjs` — 在测试里建任务并确认的写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
