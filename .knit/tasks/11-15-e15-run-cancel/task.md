---
id: k-959c96d0b4ae
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-7d0b4cd7be3b
order: null
createdAt: 2026-11-15T15:02:50.726Z
title: E15 run cancel：停掉正在跑的执行
---

# E15 run cancel：停掉正在跑的执行

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。执行者在后台跑，要有办法停掉它；后台进程意外退出时不自动恢复，也要有办法把那次执行记为失败，之后才能再派发（`.knit/tasks/11-14-slim-refactor/design.md` 第 7 节）。这两件事都由 `knit run cancel` 做。

做完之后的不同：有了 `knit run cancel <任务>`：结束后台进程和它启动的 Pi，把这次执行记为失败，改动文件照样记下。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/cli/run.ts`（修改） | 加 `run cancel` |
| `next/test/run-cancel.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`knit run cancel <任务 id> [--dir <目录>]`：

1. 在任务的执行记录里找没结束的那一次。没有：标准错误 `任务 <id> 没有正在跑的执行`，退出码 1。
2. 后台进程还在（`liveWorker`）：用 `next/src/infrastructure/process.ts` 的 `signalProcessTree` 向它和它的后代发 `SIGTERM`；每 100 毫秒看一次，最多等 5 秒，还在就发 `SIGKILL`，再等到它不在为止（最多 5 秒）。失败原因是 `已取消`。
3. 后台进程已经不在：失败原因是 `执行进程意外退出`。
4. 调用 `finishRun`，结论是 `null`，失败原因是上面定下的。它会对比工作区，把这次执行已经改了的文件记下来。
5. 打印并以退出码 0 结束：

   ```
   已取消 <任务 id> 的执行 <run-id>
   改动文件: <个数> 个
   ```

   进程已经不在的情况，第一行是 `执行 <run-id> 的进程已经不在了，已记为失败`。

- `finishRun` 返回了问题时（例如后台进程正好在这时自己结束并记好了），把问题写到标准错误，退出码 1。
- 已经改了的文件留在工作区里，不恢复；取消之后任务的状态和环节不变，再派发时做的还是这个环节。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function liveWorker" next/src/application/run-process.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 在 `cli/run.ts` 里加 `run cancel`。
4. 写测试：“正在跑”用 `run start` 加假 Pi 的 `writes` 和 `waitFor`（先写文件，再等一个不会出现的文件）；“进程不在了”用 `prepareRun` 准备一次执行而不启动后台进程。测试结束前确认没有留下后台进程。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件和 `next/src/cli/run.ts` 的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add run cancel`。

## 完成条件

### Requirement: 取消执行

#### Scenario: 停掉正在跑的执行

- GIVEN 任务派发之后，假 Pi 写了 `src/a.ts`，然后一直在等
- WHEN 运行 `knit run cancel <任务>`
- THEN 退出码是 0，输出是 `已取消 <id> 的执行 <run-id>` 和 `改动文件: 1 个`；记录里这次执行有结束时间，`failure` 是 `已取消`，`changedPaths` 是 `src/a.ts`
- AND `worker.json` 里的进程已经不在；之后 `knit run start <任务>` 能再次派发同一个环节

#### Scenario: 进程已经不在时记为失败

- GIVEN 任务有一次没结束的执行，但没有后台进程
- WHEN 运行 `knit run cancel <任务>`
- THEN 退出码是 0，第一行是 `执行 <run-id> 的进程已经不在了，已记为失败`
- AND 记录里 `failure` 是 `执行进程意外退出`

#### Scenario: 没有正在跑的执行时说明

- GIVEN 一个没派发过的任务，和一个上一次执行已经结束的任务
- WHEN 分别运行 `knit run cancel`
- THEN 退出码都是 1，标准错误是 `任务 <id> 没有正在跑的执行`
- AND 两个任务的记录都没有变化

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 取消和进程意外退出时怎么办
- `.knit/standards/development.md` — 开发规范
- `next/src/cli/run.ts` — 要改的文件
- `next/src/application/run-process.ts` — `liveWorker`
- `next/src/application/run-finish.ts` — `finishRun`
- `next/src/infrastructure/process.ts` — `signalProcessTree`
- `next/test/run-status.test.mjs` — 让执行者停在半路的测试写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
