---
id: k-61fe4382151a
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-931fbb8059e0
order: null
createdAt: 2026-11-15T15:02:46.170Z
title: E11 run status：查看任务的执行情况
---

# E11 run status：查看任务的执行情况

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。执行者在后台跑，第一版看它的情况靠日志文件和 `knit run status`（`.knit/tasks/11-14-slim-refactor/design.md` 第 7 节）。后台进程意外退出时不自动恢复，要由这个命令指出来。

做完之后的不同：有了 `knit run status <任务>`：显示上一次或正在跑的执行、它的结论或失败原因、报告在哪里，以及下一步该做什么。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/run-process.ts`（新增） | `liveWorker(root, runId)`：后台进程还在时返回它的进程号，不在时是 `null` |
| `next/src/cli/run.ts`（修改） | 加 `run status` |
| `next/test/run-status.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`liveWorker(root, runId)`：读 `<执行目录>/worker.json`；文件不在、进程号对应的进程不在，或它的启动标识和记下的不一样（`procStartTicks`、`sameProcessStart`），都返回 `null`。后面取消的任务也用它。

`knit run status <任务 id> [--dir <目录>]` 只读，退出码 0（没有这个任务时照 `task show` 的做法报错）。输出：

```
任务: <标题>（<id>）
状态: <和 task list 里一样的写法，例如 active(review)>
```

接着是执行情况，看执行记录的最后一项：

| 情况 | 输出 |
| --- | --- |
| 没有执行记录 | `还没有派发过` |
| 没结束，后台进程还在 | `正在跑: <环节名>（<run-id>），开始于 <startedAt>` 和 `日志: <执行目录>/worker.log` |
| 没结束，后台进程不在了 | `执行 <run-id> 的进程已经不在了，没有正常结束；运行 knit run cancel <id> 记为失败` |
| 已结束 | `上一次: <环节名>（<run-id>）`；有失败原因时 `失败: <原因>`，否则有结论时 `结论: <结论>`，都没有时 `结果: 正常结束`；`报告: <执行目录>/report.md`（文件存在时才有这一行）；`改动文件: <个数> 个` |

最后一行是下一步，只在没有执行还没结束时给：

| 情况 | 输出 |
| --- | --- |
| 状态是 `draft` | `下一步: 先确认需求（knit task ready <id>）` |
| 状态是 `ready` 或 `active`，`nextStep` 是某个环节 | `下一步: 派发<环节名>环节（knit run start <id>）` |
| `nextStep` 是 `close` | `下一步: 核对之后运行 knit task close <id>` |
| `nextStep` 是 `limit` | `下一步: <环节名>环节已经进入 <次数> 次，到了上限` |
| 状态是 `done`、`delivered`、`cancelled` | 没有这一行 |

环节名用流程里的 `name`；执行记录里的环节已经不在流程里时用它的 id。读任务和显示状态用 `next/src/cli/task.ts` 已经导出的 `loadTask`、`shownStatus`。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "worker.json" next/src/cli/run.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `application/run-process.ts`，在 `cli/run.ts` 里加 `run status`。
4. 写测试。“进程不在了”的情况可以直接用 `prepareRun` 准备一次执行而不启动后台进程；“正在跑”用 `run start` 加假 Pi 的 `waitFor`，测试结束前让它做完。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 2 个新文件和 `next/src/cli/run.ts` 的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add run status`。

## 完成条件

### Requirement: 查看执行情况

#### Scenario: 没派发过时给出下一步

- GIVEN 一个需求还没确认的任务和一个已确认的任务，都没有派发过
- WHEN 分别运行 `knit run status`
- THEN 两个都有 `还没有派发过`
- AND 下一步分别是 `先确认需求（knit task ready <id>）` 和 `派发实现环节（knit run start <id>）`

#### Scenario: 正在跑和进程不在了分得出来

- GIVEN 任务甲的执行者正在跑（假 Pi 在等文件）；任务乙有一次没结束的执行，但没有后台进程
- WHEN 分别运行 `knit run status`
- THEN 甲的输出里有 `正在跑: 实现（<run-id>）` 和日志的路径；乙的输出里有 `执行 <run-id> 的进程已经不在了`
- AND 两个都没有“下一步”这一行

#### Scenario: 结束之后显示结果和下一步

- GIVEN 一个 `independent` 任务：实现正常结束、改了 2 个文件；之后审查结论 `changes_requested`；另一个任务的实现以失败结束
- WHEN 在实现结束后、审查结束后各运行一次 `knit run status`，再对失败的那个任务运行一次
- THEN 依次有 `结果: 正常结束` 和 `改动文件: 2 个`、`结论: changes_requested`、`失败: <原因>`
- AND 下一步依次是派发审查环节、派发实现环节、派发实现环节

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 看执行过程靠什么
- `.knit/standards/development.md` — 开发规范
- `next/src/cli/run.ts` — 要改的文件；`worker.json` 的写法
- `next/src/cli/task.ts` — `task show` 的写法、状态的显示
- `next/src/domain/progress.ts` — `nextStep`
- `next/src/infrastructure/process.ts` — `procStartTicks`、`sameProcessStart`
- `next/test/run-start.test.mjs` — 带环境变量运行命令、等后台做完的写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
