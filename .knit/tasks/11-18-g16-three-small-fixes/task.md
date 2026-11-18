---
id: k-c78512122584
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-18T00:56:25.047Z
title: G16 三个小问题：模型出错的失败原因、状态里指出还开着的窗格、管道提前关掉
---


# G16 三个小问题：模型出错的失败原因、状态里指出还开着的窗格、管道提前关掉

## 目标与范围

背景：H1、R1 两次演练和 R1 的第三次审查留下三个问题，记在 `.knit/tasks/11-14-slim-refactor/plan.md` 的 H 段（「记下、还没有修的三个问题」）。本任务把这三个都修掉。三处互不相干，各改各的文件。

**一、模型请求出错时，两种执行方式记下的失败原因不一样。** 执行者有两种跑法：后台的 `pi --mode rpc` 进程，和 Rex 窗格里的 Pi 界面（`.knit/tasks/11-14-slim-refactor/design.md` 第 7.2 节）。模型服务连不上时 Pi 自己重试三次，仍然失败就结束这一轮，最后一条助手消息的 `stopReason` 是 `error`、`errorMessage` 是原因、没有文字。窗格里记 `执行者出错：<原因>`；后台执行用 `get_last_assistant_text` 取最后一条消息的文字，取到的是空的，记成 `执行者没有给出报告`，看不出是模型服务的问题。

用真的 Pi（1.5.2）核实过事件的样子：把模型指到一个连不上的地址，`pi --mode rpc` 依次输出三轮 `message_end`（`message.role` 是 `assistant`、`stopReason` 是 `error`、`errorMessage` 是 `Connection error.: bad port`、`content` 是空数组）和 `auto_retry_start`，最后是 `agent_settled`（`aborted` 是 `false`）；之后 `get_last_assistant_text` 的回答里没有 `text`。

**二、后台进程不在了、窗格里的 Pi 还在时，`knit run status` 不提窗格。** 窗格里的 Pi 是 Rex 启动的，不是后台进程的后代；后台进程被杀掉之后它还在，还会接着改工作区。现在的输出只有「执行 … 的进程已经不在了…」一行，用户不知道还有一个执行者在跑。`knit run cancel` 本来就会把它一起停掉，不用改。

**三、输出接在已经关掉的管道上时，`knit` 报没有处理的错误。** `knit task list | grep -q …` 里 `grep -q` 找到之后就关掉管道，`knit` 再往里写就以 `Unhandled 'error' event … write EPIPE` 结束，退出码 1。本机上 `node dist/cli/knit.js task list | true` 每次都这样。

做完之后的不同：

- 模型请求出错时，两种执行方式都记 `执行者出错：<模型服务给的原因>`；没有原因时记 `执行者出错：没有给出原因`。不要求补报，不写 `report.md`。
- 后台进程不在了、窗格里的 Pi 还在时，`knit run status` 在原来那一行后面多一行：`窗格: Rex 里标着 knit <执行 id> 的浮动窗格还开着，执行者还在里面；knit run cancel 会把它一起停掉`。
- 标准输出或标准错误接在已经关掉的管道上时，`knit` 不输出错误，退出码和没有管道时一样。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `src/domain/report.ts` | 加 `modelFailure(reason)`：返回 `{ verdict: null, failure: "执行者出错：<原因>" }`，原因是空的或没有时写 `没有给出原因`。两种执行方式都用它，文案只在这一处 |
| `src/adapters/pi/pane-worker.ts` | `stopReason === "error"` 那一支改用 `modelFailure` |
| `src/adapters/pi/runtime.ts` | `PiAgentRuntime` 加 `lastModelError()`：最近一次 `prompt` 之后收到的最后一条助手消息（`message_end` 事件）是出错的，就返回它的 `errorMessage`（没有时是空字符串），否则是 `null` |
| `src/application/run-execute.ts` | `askForReport` 在“被中止”之后、取报告之前看 `lastModelError()`：不是 `null` 就用 `modelFailure` 结束，不取报告、不写 `report.md`、不要求补报 |
| `src/cli/run.ts` | `runLines`：后台进程不在了而 `livePane` 不是 `null` 时多输出上面那一行 |
| `src/cli/knit.ts` | 给 `process.stdout`、`process.stderr` 各加一个 `error` 处理：`EPIPE` 不管，别的错误照旧抛出 |
| `test/helpers/fake-pi.mjs` | 脚本加字段 `modelError`：有它时这一轮的最后一条消息是出错的（两种模式都支持） |
| `test/run-execute-edges.test.mjs`、`test/run-pane.test.mjs`、`test/cli.test.mjs` | 各加测试，见场景 |

不做的：

- 模型请求出错不重试、不回退到另一种执行方式：Pi 已经自己重试过三次。
- 后台进程不在了时不自动停掉窗格里的 Pi：停不停由用户决定，`knit run cancel` 做这件事。
- `EPIPE` 以外的写错误不处理。

不能动的：

- 上表以外的文件。工作区里另有一个任务（F6，交付预览）的改动，在 `src/application/workspace.ts`、`run-finish.ts`、`delivery.ts`、`src/cli/deliver.ts`、`test/deliver-preview.test.mjs`、`test/workspace.test.mjs`，不属于本任务，不看、不改。
- `.knit/`（除本任务的资料）、`.pi/extensions/knit.ts`、`docs/`、`AGENTS.md`：还是旧 Knit 的，H3 之后才换。旧桥接启动时会提示一次“改用本地 dist”，不要照做。
- 测试只在临时目录里做，不调用真的模型。不加依赖，不提交、不推送。
- 不运行 `npm run pack:install`。

前置条件：macOS 或 Linux，Node 24 以上；`npm test` 能通过。`npm test` 会先删掉再生成 `dist`，不要同时运行两次。

验证：

- `npm test`：通过，输出里 `fail 0`。本任务加 4 个测试；同一个工作区里 F6 加 2 个，合起来是 227 个（开始前 221 个）。
- `npm run typecheck`、`npx tsc -p tsconfig.templates.json`：退出码都是 0。
- `node dist/cli/knit.js --help | true; echo ${PIPESTATUS[0]}`（bash）：输出 `0`，没有别的输出。
- `pgrep -fl "fake-pi|fake-rex|run worker|run wait"`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出。

审查时请特别看：

- `lastModelError()` 会不会把“先出错、Pi 重试之后成功”的一轮当成出错（它应当只看最后一条助手消息）。
- 后台执行补报的那一次（第二次 `prompt`）会不会读到第一次的出错消息。
- `EPIPE` 的处理会不会吞掉别的错误，会不会改变命令失败时的退出码。

做完之后：本任务要求独立审查；提交由用户另行授权，文案首行建议 `fix: report model errors the same way in both modes, show a leftover pane, survive a closed pipe`。

## 完成条件

### Requirement: 模型请求出错记成一样的失败原因

#### Scenario: 两种执行方式

- GIVEN 临时仓库里一次派发出去的执行，假 Pi 的脚本是 `{ "modelError": "Connection error." }`
- WHEN 执行者在后台做完这一轮；另一次在 Rex 窗格里（假的 `rex`）做完这一轮
- THEN 两次的执行记录里 `failure` 都是 `执行者出错：Connection error.`，`verdict` 是 `null`
- AND 执行者只收到过一条消息（没有要求补报），执行目录里没有 `report.md`
- AND `modelError` 是空字符串时，后台执行记的是 `执行者出错：没有给出原因`

### Requirement: 状态里指出还开着的窗格

#### Scenario: 后台进程被杀掉

- GIVEN 执行者在 Rex 窗格里开始之后（执行目录里有 `pane.json`），后台进程被 `SIGKILL` 结束，窗格里的假 Pi 还在
- WHEN 运行 `knit run status <任务>`
- THEN 标准输出的最后两行是 `执行 <执行 id> 的进程已经不在了，没有正常结束；运行 knit run cancel <任务> 记为失败` 和 `窗格: Rex 里标着 knit <执行 id> 的浮动窗格还开着，执行者还在里面；knit run cancel 会把它一起停掉`
- AND 之后运行 `knit run cancel <任务>`，输出 `执行 <执行 id> 的进程已经不在了，已记为失败` 和 `改动文件: 0 个`，这次执行的进程一个都不剩

### Requirement: 管道提前关掉不算出错

#### Scenario: 没有人读输出

- GIVEN 一个有 `.knit/` 的临时项目
- WHEN 运行 `knit task list`，它的标准输出在它写之前就被关掉
- THEN 退出码是 0，标准错误是空的
- AND 运行 `knit task show k-nope`（没有这个任务），它的标准错误在它写之前就被关掉时，退出码是 1，标准输出是空的

## 待澄清

## 相关资料

- `.knit/tasks/11-14-slim-refactor/plan.md` — H 段「记下、还没有修的三个问题」
- `.knit/tasks/11-14-slim-refactor/design.md#72-rex-窗格` — 窗格里的执行者怎么跑
- `src/domain/report.ts` — `reportOutcome`、`ReportOutcome`
- `src/adapters/pi/pane-worker.ts` — 窗格里的 Pi 加载的扩展
- `src/adapters/pi/runtime.ts` — `PiAgentRuntime`：`prompt`、`waitSettled`、`settledCursor`
- `src/application/run-execute.ts` — `runStage`、`askForReport`
- `src/cli/run.ts` — `runLines`
- `src/cli/knit.ts` — 命令行入口
- `test/helpers/fake-pi.mjs` — 假 Pi
- `test/run-pane.test.mjs` — 窗格的测试和 `inRex`

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-18T01:00:56.746Z
- 方式: self → independent；理由: 改的是执行、交付这两处的判断，自己验证不够

### 交付记录

<!-- knit:delivery:op-db517fb8f37a -->
- 操作: op-db517fb8f37a
- 时间: 2026-11-18T04:00:04.358Z
- 分支: refs/heads/main
- 授权来源: user:c3abaf42
- 调用: bridge
- 工作提交: b3e3befeba41ddf3ed28a351df4ec34260f08bdb
- 结果: 正常交付；检查 run-4eb876be0a15 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-18-g16-three-small-fixes

<!-- knit:progress:end -->
