---
id: k-931fbb8059e0
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-0c4b2db4eb65
order: null
createdAt: 2026-11-15T15:02:45.012Z
title: E10 run start：在后台派发任务当前的环节
---

# E10 run start：在后台派发任务当前的环节

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。前面的任务已经能准备一次执行（`prepareRun`）和把它做完（`executeRun`）。派发要立即返回，执行者在后台跑，主会话可以接着做别的（`.knit/tasks/11-14-slim-refactor/design.md` 第 7、9 节）。

做完之后的不同：有了 `knit run start <任务>`：准备好之后启动一个后台进程去执行，自己立即返回。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/cli/run.ts`（新增） | `registerRunCommands(program)`：`run start` 和不出现在帮助里的 `run worker` |
| `next/src/cli/knit.ts`（修改） | 注册 `run` 命令 |
| `next/src/cli/task.ts`（修改） | 只给 `fail`、`knitRoot`、`loadTask`、`shownStatus` 四个函数加上 `export`，供 `run` 的几个命令用；别的不改 |
| `next/test/run-start.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`knit run start <任务 id> [--model <provider/模型>] [--dir <目录>]`：

1. `loadConfig`、`loadWorkflow`、`prepareRun`；有问题时逐行写到标准错误，退出码 1，不启动进程。
2. 启动后台进程：用 `node:child_process` 的 `spawn` 运行 `process.execPath`，参数是 `process.argv[1]`、`run`、`worker`、`<run-id>`、`--task <任务 id>`、`--model <最后用的模型>`、`--dir <项目根>`；`detached: true`，标准输出和标准错误都接到 `<执行目录>/worker.log`，标准输入不接；之后 `unref()`，不等它结束。
3. 把 `{ "pid": 进程号, "start": 启动标识 }` 写进 `<执行目录>/worker.json`。启动标识用 `next/src/infrastructure/process.ts` 的 `procStartTicks`：以后靠它确认这个进程号还是原来那个进程。
4. 打印两行并以退出码 0 结束：

   ```
   已派发 <任务 id>：<环节名>（<run-id>）
   日志：<执行目录>/worker.log
   ```

`knit run worker <run-id> --task <任务 id> --model <provider/模型> --dir <目录>`（用 commander 的 `{ hidden: true }`）：读流程，调用 `executeRun`，`piExecutable` 用环境变量 `KNIT_PI_BIN`，没有时是 `pi`。`executeRun` 返回了问题时逐行写到标准错误，退出码 1。

同一时间只跑一个执行者：有执行还没结束时 `prepareRun` 会拒绝，本任务不另加检查。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function executeRun" next/src/application/run-execute.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `cli/run.ts`，在 `cli/knit.ts` 里注册。
4. 写测试：`helpers/cli.mjs` 的 `knit` 不能设环境变量，测试里自己用 `spawnSync` 运行 `next/dist/cli/knit.js`，在 `env` 里带上 `KNIT_PI_BIN`（假 Pi 的路径）和 `KNIT_FAKE_PI`。等后台做完的办法：每 100 毫秒读一次 `record.json`，最多等 20 秒。测试结束前确认后台进程已经退出。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 2 个新文件和 `next/src/cli/knit.ts`、`next/src/cli/task.ts` 的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add run start`。

## 完成条件

### Requirement: 在后台派发

#### Scenario: 派发后立即返回，执行者在后台做完

- GIVEN 一个已确认的任务；假 Pi 的脚本写一个文件 `src/a.ts`
- WHEN 运行 `knit run start <任务>`
- THEN 命令以退出码 0 结束，输出是 `已派发 …` 和 `日志：…` 两行；这时或稍后 `record.json` 里这次执行有了结束时间，`changedPaths` 是 `src/a.ts`
- AND 执行目录里有 `worker.json`（带 `pid` 和 `start`）、`worker.log` 和 `report.md`

#### Scenario: 不能派发时不启动进程

- GIVEN 一个需求还没确认的任务
- WHEN 运行 `knit run start <任务>`
- THEN 退出码是 1，标准错误里是 `需求还没有确认，或确认之后改过；先运行 knit task ready <id>`
- AND `.knit/.runtime/runs/` 下没有建出执行目录

#### Scenario: 执行者还在跑时不能再派发

- GIVEN 任务甲派发之后，假 Pi 在等一个还不存在的文件
- WHEN 对任务乙运行 `knit run start`
- THEN 退出码是 1，标准错误里是 `任务 <甲> 的执行 <run-id> 还没有结束；等它结束，或运行 knit run cancel <甲>`
- AND 把那个文件建出来之后甲的执行结束，这时再派发乙成功

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 执行者在后台跑
- `.knit/tasks/11-14-slim-refactor/design.md#9-命令与工具` — 命令行
- `.knit/standards/development.md` — 开发规范
- `next/src/application/run-prepare.ts` — `prepareRun`
- `next/src/application/run-execute.ts` — `executeRun`
- `next/src/application/config.ts` — `loadConfig`
- `next/src/cli/workflow.ts` — `loadWorkflow`
- `next/src/cli/task.ts` — 命令的写法、`--dir` 的处理、出错时的输出
- `next/src/infrastructure/process.ts` — `procStartTicks`
- `next/test/helpers/fake-pi.mjs` — 假 Pi 的脚本字段
- `next/test/helpers/run.mjs` — `runProject`、`readyTask`

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
