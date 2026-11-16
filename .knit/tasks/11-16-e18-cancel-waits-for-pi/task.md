---
id: k-6f79d543a580
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-16T00:03:55.030Z
title: E18 run cancel：等执行者的进程都退出之后再记录
---

# E18 run cancel：等执行者的进程都退出之后再记录

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。`knit run cancel`（`next/src/cli/run.ts`）现在向后台进程和它启动的 Pi 发 `SIGTERM`，然后只等后台进程退出。后台进程收到 `SIGTERM` 立刻就退出了，所以：

- Pi 退出得慢时，取消已经对比完工作区、记下了改动文件，Pi 可能还在写文件；紧接着再派发，新的执行者会和它同时改工作区。
- “5 秒之后还在就发 `SIGKILL`”这一步实际走不到，也没有测试。

做完之后的不同：`knit run cancel` 返回时，后台进程和它启动的 Pi 都已经不在了；改动文件是在它们都退出之后对比出来的。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/run-process.ts`（修改） | 加两个函数：取后台进程这一串进程、看其中哪些还在 |
| `next/src/cli/run.ts`（修改） | `run cancel` 改成等这一串进程都退出 |
| `next/test/helpers/fake-pi.mjs`（修改） | 脚本多一个字段 `stubborn` |
| `next/test/run-cancel.test.mjs`（修改） | 加一个测试，改一处断言 |

`run-process.ts` 新增：

- `workerProcesses(root, runId)`：后台进程还在（`liveWorker`）时，返回它和它所有的后代，每项是进程号和启动标识（`next/src/infrastructure/process.ts` 的 `processTreePids`、`processTable`）；不在时返回空数组。
- `aliveAmong(processes)`：重新读一次进程表，返回其中还在的：进程号还在，启动标识也和记下的一样（`sameProcessStart`）。记下的启动标识是 `null` 的不算还在。进程号会被别的进程重新用上，所以要比启动标识。

`knit run cancel` 里“后台进程还在”的那一步改成：

1. 用 `workerProcesses` 取这一串进程。要在发信号之前取：后台进程先退出的话，就找不到它启动的 Pi 了。
2. 向这一串发 `SIGTERM`（`signalProcessTree`）。
3. 每 100 毫秒用 `aliveAmong` 看一次，最多看 5 秒，等到一个都不在。
4. 5 秒之后还有在的：只向还在的那些发 `SIGKILL`，再同样等最多 5 秒。
5. 之后调用 `finishRun`，失败原因是 `已取消`。第 4 步等完还有进程在时也照样往下做：不记的话这次执行结束不了，别的任务也派发不了。

别的都不变：没有正在跑的执行时的报错、后台进程已经不在时记为 `执行进程意外退出`、输出的两行、`finishRun` 返回问题时的处理。

假 Pi 的 `stubborn`：为真时不理会 `SIGTERM`，输入关闭时也不退出，只有 `SIGKILL` 能结束它。用它的测试要登记清理：测试结束时用 `pkill -9 -f <run-id>` 结束还留着的进程，免得测试失败时留下不会退出的进程。

不做的：后台进程已经意外退出、而它启动的 Pi 还在的情况。这时从 `worker.json` 找不到 Pi，本任务不处理。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "processTreePids" next/src/cli/run.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `run-process.ts`、`cli/run.ts`。
4. 改假 Pi，写测试。已有的测试「停掉正在跑的执行」里，取消之后等假 Pi 退出的那一处改成直接断言已经没有进程。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出上面 4 个文件的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- `pgrep -f fake-pi`：没有输出（没有留下进程）。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `fix(next): wait for the whole process chain when cancelling a run`。

## 完成条件

### Requirement: 取消时等执行者的进程都退出

#### Scenario: 执行者收到 SIGTERM 就退出

- GIVEN 任务派发之后，假 Pi 写了 `src/a.ts`，然后一直在等
- WHEN 运行 `knit run cancel <任务>`
- THEN 退出码是 0，输出是 `已取消 <id> 的执行 <run-id>` 和 `改动文件: 1 个`；记录里 `failure` 是 `已取消`，`changedPaths` 是 `src/a.ts`
- AND 命令一返回，命令行里带着这次执行 id 的进程就一个都没有了，不需要再等

#### Scenario: 执行者不理会 SIGTERM

- GIVEN 假 Pi 的脚本带 `stubborn`，写了 `src/a.ts`，然后一直在等
- WHEN 运行 `knit run cancel <任务>`
- THEN 退出码是 0，输出和记录同上一个场景
- AND 命令一返回，命令行里带着这次执行 id 的进程就一个都没有了

## 待澄清

- [assumed] 发了 `SIGKILL` 再等 5 秒之后还有进程在时，照样把这次执行记为失败并返回，不报错（Agent 建议，待确认）。另一种做法是报错、不记；那样这次执行结束不了，所有任务都派发不了。

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 取消和进程意外退出时怎么办
- `.knit/standards/development.md` — 开发规范
- `next/src/cli/run.ts` — 要改的文件
- `next/src/application/run-process.ts` — 要改的文件；`liveWorker`
- `next/src/infrastructure/process.ts` — `processTable`、`processTreePids`、`signalProcessTree`、`sameProcessStart`
- `next/test/helpers/fake-pi.mjs` — 假 Pi
- `next/test/run-cancel.test.mjs` — 要改的测试

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-b8448cfecf3a -->
- 操作: op-b8448cfecf3a
- 时间: 2026-11-16T06:48:55.977Z
- 分支: refs/heads/main
- 授权来源: user:28d14c89
- 调用: bridge
- 工作提交: 499d4fb0c28168714c5af36f6b0329ac35263d8e
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-16-e18-cancel-waits-for-pi

<!-- knit:progress:end -->
