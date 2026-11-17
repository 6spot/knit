---
id: k-074a8e6cbccf
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-17T14:27:20.450Z
title: R1 Rex 窗格：主会话在 Rex 里时执行者在窗格里跑，用不了就回退到后台
---


# R1 Rex 窗格：主会话在 Rex 里时执行者在窗格里跑，用不了就回退到后台

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。`knit run start` 派发一个环节：启动一个后台进程（`knit run worker`），它启动 `pi --mode rpc`，发第一条消息，等执行者做完，把最后一条消息存成 `report.md`，记下结果。用户看不到过程，也插不上话。

用户 2026-11-17 决定在切换之前把 Rex 窗格加回来：「Rex用B实现，Rex是额外扩展，Rex有问题时回退到当前的方式里面，所以代码完全不多余」。Rex 是一个终端程序，可以用命令在窗口里开浮动窗格。

做完之后的不同：主会话在 Rex 里时（环境里有 `REX_SESSION` 和 `REX_BLOCK`），执行者在 Rex 的一个浮动窗格里跑 Pi 的交互界面，用户看得到过程，也可以直接在里面说话；窗格用不了就照旧在后台执行。不在 Rex 里时一切照旧。规则写在 `.knit/tasks/11-14-slim-refactor/design.md` 第 7.2 节，Rex 和 Pi 的接口摘录在 `.knit/tasks/11-14-slim-refactor/research/rex-pane.md`，不需要另外读 Rex 和 Pi 的文档。

本任务的代码已经由主会话写完（用户催促之后直接做的，事后登记），这里登记是为了独立审查。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/adapters/rex/pane.ts`（新增） | `openPane`、`paneGone`、`closePane`：运行 `PATH` 上的 `rex` 开窗格、等窗格里的程序结束、关窗格 |
| `next/src/adapters/pi/pane-worker.ts`（新增） | 窗格里的 Pi 加载的扩展：登记自己（`pane.json`）、发第一条消息、存报告、补报一次、写结果（`outcome.json`）、让 Pi 退出 |
| `next/src/application/run-pane.ts`（新增） | `runInPane`：开窗格、等执行者开始、等窗格结束、读结果；没能开始时返回 null |
| `next/src/application/run-execute.ts`（修改） | `executeRun` 多一个可选的 `rex`；给了就先 `runInPane`，返回 null 再照旧在后台执行（`runInBackground`，原来的代码） |
| `next/src/adapters/pi/runtime.ts`（修改） | `PiRuntimeOptions.interactive`；`interactivePiCommand` 拼出窗格里的完整命令 |
| `next/src/domain/report.ts`（修改） | `reportOutcome`、`reportRetryMessage`：从 `run-execute.ts` 挪过来，后台执行和窗格共用 |
| `next/src/application/run-process.ts`（修改） | `livePane`；`workerProcesses` 把窗格里的 Pi 和它的后代也算进去 |
| `next/src/infrastructure/process.ts`（修改） | `recordedProcess`：从 `run-process.ts` 挪过来，扩展也要用 |
| `next/src/cli/run.ts`（修改） | `run worker` 从环境变量得出 `rex`；`run status` 在执行者在窗格里跑着时多一行；`run cancel` 连窗格里的 Pi 一起停 |
| `next/test/run-pane.test.mjs`、`next/test/helpers/fake-rex.mjs`（新增） | 见「完成条件」，每个场景一个测试；假的 `rex` |
| `next/test/helpers/fake-pi.mjs`（修改） | 命令行里没有 `--mode` 时扮演交互界面：加载扩展、触发事件 |
| `next/test/helpers/cli.mjs`（修改） | 去掉环境里的 `REX_SESSION`、`REX_BLOCK`：在 Rex 的终端里跑测试时不能开出真的窗格 |
| `validation/slim-rex-2026-11/`（新增） | 在真的 Rex 里用真的模型走一遍的脚本和记录 |

规则（`design.md` 第 7.2 节的要点）：

- 派发、等待、通知、状态、取消的命令都不变。后台进程照旧启动，由它开窗格、等窗格里的程序结束、记结果。
- 窗格里的命令是 `/usr/bin/env -u <主会话留下的 PI_* 变量>… KEY=VALUE… pi <参数>`。参数除了没有 `--mode rpc` 和 `--no-themes`，和后台执行一样；系统提示给的是 `system.md` 的路径。
- 回退：`rex` 运行不了、窗格开不了、窗格开出来 20 秒内执行者没有开始（执行目录里没有 `pane.json`），都先关窗格，再照旧在后台执行，原因写到标准错误（进 `worker.log`）。执行者已经在窗格里开始之后不回退：同一个环节不能做两遍。
- 模型在 Pi 里找不到：不发消息，记为失败 `执行者启动失败：Pi 里没有模型 <provider/模型>`。
- 用户在窗格里按 Esc 中止（用户 2026-11-17 决定）：这次执行不结束，窗格留着，界面上提示可以接着输入；输入之后执行者接着做，最后照常交报告。
- 窗格在执行者交报告之前被关掉：记为失败 `执行者的窗格关掉了，没有交报告`。
- 窗格里的 Pi 是 Rex 启动的，不是后台进程的后代；取消时靠 `pane.json` 里登记的进程号和启动标识找到它。
- 窗格开出来到 Pi 登记之间有零点几秒，这时取消还找不到它（第二次独立审查 `run-b122f9fbf686` 指出，在真的 Rex 里复现了）。两边各做一步：取消等后台进程退出之后再找一次登记；窗格里的 Pi 登记之后先看后台进程（`worker.json`）还在不在，不在就不发消息、直接退出。

不做的：旧实现（`src/adapters/rex/`、`src/application/rex-launcher.ts`，2,377 行）的其余功能，包括主会话和窗格之间的通道（从主会话给执行者发话、停止）、执行者状态机、恢复时找回已有的窗格、用选项或配置指定在哪里显示。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 和 `validation/slim-rex-2026-11/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi、真的 Rex 和模型。
- 不加依赖，不提交、不推送。

验证：

- `npm run test:next`：通过，输出里 `tests 221`、`fail 0`（开始前是 213 个）。这条命令会先删掉再生成 `next/dist`，不要同时运行两次。
- `npx tsc -p next/tsconfig.templates.json`：退出码 0。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- `pgrep -fl "fake-pi|fake-rex|run worker|run wait"`：没有输出。
- `validation/slim-rex-2026-11/rex-flow.sh`、`no-model.sh` 要真的 Rex（前一个还要模型），审查时不运行，看 `logs/` 和 `README.md`。

审查时请特别看：

- 回退会不会让同一个环节做两遍（窗格里的执行者已经开始，后台又做一次）。
- 取消之后会不会留下进程；`pane.json` 里的进程号被别的进程重新用上时会不会杀错。
- 不在 Rex 里时，后台执行的行为有没有变（`run-execute.ts` 是挪动，不是改写）。
- 新代码里有没有用不到的、多余的东西。

做完之后：本任务要求独立审查，由另一个执行者对照完成条件审查；提交由用户另行授权，文案首行建议 `feat(next): run the worker in a Rex pane when the main session is in Rex`。

## 完成条件

### Requirement: 在 Rex 里时执行者在窗格里跑

#### Scenario: 在窗格里做完

- GIVEN 临时仓库里一个已经确认的任务；环境里有 `REX_SESSION`、`REX_BLOCK`，`PATH` 上是假的 `rex`
- WHEN 运行 `knit run start <id>`，等执行结束
- THEN 这次执行正常结束，记下了改动的文件和会话文件，`report.md` 是执行者的最后一条消息
- AND 对 Rex 的调用依次是 `session.describe_block`、`session.new_layer`、`session.set_layer_state`（最小化）、`session.close_layer`；窗格的标签是 `knit <执行 id>`，不抢焦点，没有写 `shell`，程序结束时自己关
- AND 窗格里的命令以 `/usr/bin/env -u PI_SESSION_ID` 开头，没有 `--mode` 和 `--no-themes`，系统提示给的是 `system.md` 的路径，工具和后台执行一样
- AND 执行者收到的第一条消息是 `message.md` 的全文，只有这一条

#### Scenario: 报告读不出来时补报一次

- GIVEN 同上，任务在审查环节，执行者的第一次报告没有结论，第二次有
- WHEN 派发并等执行结束
- THEN 结论是 `pass`，`report.md` 是第二次的报告，执行者收到的最后一条消息以 `上一条消息里的报告读不出来：` 开头

#### Scenario: 模型不认识

- GIVEN 同上，Pi 里找不到这个模型
- WHEN 派发并等执行结束
- THEN 失败原因是 `执行者启动失败：Pi 里没有模型 fake/model`，执行者没有收到消息，`worker.log` 是空的（没有回退）

### Requirement: 窗格用不了时照旧在后台执行

#### Scenario: 窗格开不了

- GIVEN 同上，假的 `rex` 对 `session.new_layer` 报错
- WHEN 派发并等执行结束
- THEN 这次执行正常结束，Pi 是用 `--mode rpc` 启动的，执行目录里没有 `pane.json`
- AND `worker.log` 是一行 `Rex 窗格用不了（session.new_layer：…），改在后台执行`

#### Scenario: 执行者没有在窗格里开始

- GIVEN 同上，窗格里的 Pi 不加载扩展就退出
- WHEN 派发并等执行结束
- THEN 这次执行正常结束，`report.md` 是后台那一次的报告，没有留下窗格
- AND `worker.log` 是一行 `Rex 窗格用不了（执行者没有在窗格里开始），改在后台执行`

### Requirement: 中止、取消和关窗格

#### Scenario: 中止之后接着做

- GIVEN 同上，执行者的第一轮被中止
- WHEN 派发，等到界面上出现中止的提示
- THEN 这次执行还没有结束，没有 `report.md`；`knit run status` 的最后一行是 `窗格: Rex 里标着 knit <执行 id> 的浮动窗格（最小化着）`
- AND 用户接着输入之后，这次执行正常结束，`report.md` 是接着做完的报告

#### Scenario: 取消和关窗格

- GIVEN 同上，执行者在窗格里卡着
- WHEN 运行 `knit run cancel <id>`
- THEN 输出 `已取消 <id> 的执行 <执行 id>` 和改动文件数，失败原因是 `已取消`，后台进程和窗格里的 Pi 都退出了
- AND 再派发一次，执行者在窗格里开始之后把窗格关掉：失败原因是 `执行者的窗格关掉了，没有交报告`

#### Scenario: 执行者还没有在窗格里开始就取消

- GIVEN 同上，窗格里的 Pi 要过 1.5 秒才加载扩展
- WHEN 窗格开出来之后马上运行 `knit run cancel <id>`
- THEN 输出 `已取消 <id> 的执行 <执行 id>` 和 `改动文件: 0 个`，这时执行目录里没有 `pane.json`
- AND 窗格里的 Pi 起来之后自己退出：执行者没有收到消息，工作区没有被改

## 待澄清

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#72-rex-窗格` — 规则
- `.knit/tasks/11-14-slim-refactor/research/rex-pane.md` — Rex 的命令和 Pi 的扩展接口，本机核实过的表现
- `next/src/adapters/rex/pane.ts` — 开窗格、等、关
- `next/src/adapters/pi/pane-worker.ts` — 窗格里的扩展
- `next/src/application/run-pane.ts` — 在窗格里跑一次执行，回退
- `next/src/application/run-execute.ts` — 接入的地方；后台执行
- `next/src/application/run-process.ts` — 找这次执行的进程
- `next/src/infrastructure/process.ts` — `recordedProcess`
- `next/src/cli/run.ts` — `run worker`、`run status`、`run cancel`
- `next/src/adapters/pi/runtime.ts` — `interactivePiCommand`、`buildPiArgs`
- `next/src/domain/report.ts` — `reportOutcome`、`reportRetryMessage`
- `next/test/run-pane.test.mjs` — 八个测试
- `next/test/helpers/fake-rex.mjs` — 假的 `rex`
- `next/test/helpers/fake-pi.mjs` — 假的 Pi：交互界面的那一段
- `validation/slim-rex-2026-11/README.md` — 真的 Rex、真的模型走一遍的记录
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-17T14:28:56.077Z
- 方式: self → independent

### 交付记录

<!-- knit:delivery:op-1eeb424e599b -->
- 操作: op-1eeb424e599b
- 时间: 2026-11-17T15:40:26.659Z
- 分支: refs/heads/main
- 授权来源: user:sha256:f6e919f67df912c6
- 调用: bridge
- 工作提交: 7bf09f6e14e871f38d99ca23accb9ca69e041b66
- 结果: 正常交付；检查 run-90b2a87aaf98 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-17-r1-rex-pane

<!-- knit:progress:end -->
