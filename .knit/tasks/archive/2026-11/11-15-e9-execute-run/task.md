---
id: k-0c4b2db4eb65
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-e10d8ff38744
order: null
createdAt: 2026-11-15T15:02:43.883Z
title: E9 启动 Pi 执行一个环节
---

# E9 启动 Pi 执行一个环节

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。执行者是一个 `pi --mode rpc` 进程：把准备好的系统提示和第一条消息交给它，等它做完，它的最后一条消息就是报告（`.knit/tasks/11-14-slim-refactor/design.md` 第 7 节）。和 Pi 进程打交道的代码已经在 `next/src/adapters/pi/` 里（`PiAgentRuntime`）。本任务把“准备好的一次执行”和“记下结果”接起来；放到后台去跑由下一个任务做。

做完之后的不同：`next/` 里有了 `executeRun`：给它一次准备好的执行，它启动 Pi、交出交接内容、存下报告，并用 `finishRun` 记下结果。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/run-execute.ts`（新增） | `executeRun(input)` |
| `next/test/helpers/fake-pi.mjs`（新增，可执行） | 测试用的假 Pi，后面的任务也用它 |
| `next/test/run-execute.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`executeRun({ root, taskId, runId, workflow, model, piExecutable })`：`model` 是 `provider/模型`，`piExecutable` 是 Pi 可执行文件的路径。返回 `finishRun` 的结果。

1. 从任务的执行记录里找到这次执行，按它的 `stage` 在流程里找到环节；读执行目录里的 `system.md`、`message.md`。
2. 启动 `PiAgentRuntime`：`cwd` 是项目根，`sessionDir` 是 `<执行目录>/session`，`appendSystemPrompt` 是 `system.md` 的内容，`provider`、`modelId` 从 `model` 的第一个 `/` 分开。工具按环节的 `tools` 给：

   | 环节的 `tools` | 给 `PiAgentRuntime` 的 |
   | --- | --- |
   | `null`（全部放开） | `capabilities: null`、`tools: null` |
   | 不含 `external` 的列表 | `capabilities` 是这个列表；`tools` 是对出的工具名：`read` 对 `read`、`grep`、`find`、`ls`，`write` 对 `write`、`edit`，`exec` 对 `bash`。空列表得到空的 `tools` |
   | 含 `external` 的列表 | `capabilities` 是这个列表；`tools: null`；`toolAdditions` 是对出的工具名，`excludeTools` 是这七个内置工具里没对出的。照旧代码 `src/application/stage-runner.ts` 第 197–243 行的 `stageRuntimeTools`，去掉其中的 `task` 能力 |

3. `start()` 不成功：失败原因是 `执行者启动失败：<它给的 detail>`。
4. `prompt(message.md 的内容)`。没有等到稳定结束（进程退出了）：失败原因是 `执行者中途退出`；被中止：`执行者被中止`。
5. 用 `getLastAssistantText()` 取最后一条消息，原样写进 `<执行目录>/report.md`。是空的：失败原因是 `执行者没有给出报告`。
6. 用 `readReport(环节的 report, 报告原文)` 读声明的字段。有问题：失败原因是 `报告读不出来：<各个问题，用分号隔开>`，`report.md` 保留。读得出：结论是其中的 `verdict`（是字符串时），没有就是 `null`。
7. 不管走到哪一步，先 `dispose()` 结束 Pi 进程，再调用 `finishRun`；`sessionFile` 用 `PiAgentRuntime` 给出的会话文件位置（在项目里时写成相对项目根的路径），没有就是 `null`。

报告读不出时的补报不在本任务里，由后面的任务加。

假 Pi（`next/test/helpers/fake-pi.mjs`，开头是 `#!/usr/bin/env node`，要有可执行权限）：从标准输入一行一个 JSON 请求（`{ id, type, … }`），往标准输出一行一个 JSON 回答（`{ type: "response", id, success: true, data }`）。可以参考旧的 `test/fixtures/fake-pi.mjs`，只留用得到的部分。

- `get_state` 回 `{ sessionId, sessionFile: null, model: { provider, id } }`，`sessionId`、`provider`、`id` 取自启动参数 `--session-id`、`--provider`、`--model`；`set_model`、`clear_queue`、`abort` 回成功；`get_last_assistant_text` 回 `{ text }`。
- `prompt`：先回成功，再按脚本动作，最后发一行 `{ "type": "agent_settled", "aborted": false }`。
- 脚本是环境变量 `KNIT_FAKE_PI` 指向的 JSON 文件，字段都可以不写：`failStart`（`set_model` 回失败）、`exitOnPrompt`（收到 `prompt` 就退出）、`writes`（`[{ path, content }]`，在工作目录里写文件）、`commands`（`[[程序, 参数…]]`，在工作目录里依次运行）、`waitFor`（一个绝对路径，等这个文件出现再往下；测试里把它放在项目目录之外）、`texts`（第 n 次 `prompt` 用第 n 项当最后一条消息，超出时用最后一项；不写时是 `做完了。`）。动作的先后是 `writes`、`commands`、`waitFor`、给出消息。
- 环境变量 `KNIT_FAKE_PI_LOG` 指向一个文件时，启动时往里追加一行 `{ "args": [启动参数] }`，每次 `prompt` 追加一行 `{ "message": "…" }`。
- 标准输入关闭时退出。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。`src/application/stage-runner.ts`、`test/fixtures/fake-pi.mjs` 只读，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function finishRun" next/src/application/run-finish.ts`、`grep -n "export function readReport" next/src/domain/report.ts` 都有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `helpers/fake-pi.mjs`，并 `chmod +x`。
4. 写 `application/run-execute.ts`。
5. 写测试：用 `runProject`、`readyTask`、`prepareRun` 准备一次执行，把假 Pi 的路径当 `piExecutable` 传进去；脚本和记录文件放在临时目录里、项目目录之外，通过 `process.env` 设置，测试结束时还原。同一时间只能有一次没结束的执行：要用到几次执行的测试，结束一次再准备下一次，或者各用一个临时项目。
6. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 3 个新文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): run a stage with Pi`。

## 完成条件

### Requirement: 执行一个环节

#### Scenario: 做完之后存下报告，记下结论和改动文件

- GIVEN 一次准备好的审查执行；假 Pi 的脚本写一个文件 `src/a.ts`，最后一条消息的结尾是带 `verdict: pass` 的 json 代码块
- WHEN 执行它
- THEN `report.md` 是那条消息的原文；记录里这一项有结束时间，`verdict` 是 `pass`，`failure` 是 `null`，`changedPaths` 是 `src/a.ts`
- AND 假 Pi 收到的启动参数里有 `--append-system-prompt` 和 `system.md` 的内容、`--tools read,grep,find,ls,write,edit,bash`，收到的消息是 `message.md` 的内容

#### Scenario: 启动不了或中途退出时记为失败

- GIVEN 两次准备好的执行；假 Pi 的脚本分别是 `failStart` 和 `exitOnPrompt`
- WHEN 执行它们
- THEN `failure` 分别以 `执行者启动失败：` 开头、是 `执行者中途退出`
- AND 两次都有结束时间，`verdict` 是 `null`

#### Scenario: 报告读不出来时记为失败并保留原文

- GIVEN 一次准备好的审查执行；假 Pi 的最后一条消息里没有 json 代码块
- WHEN 执行它
- THEN `failure` 以 `报告读不出来：` 开头，`verdict` 是 `null`
- AND `report.md` 里是那条消息的原文

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 执行者怎么启动、报告怎么处理
- `.knit/standards/development.md` — 开发规范
- `next/src/adapters/pi/runtime.ts` — `PiAgentRuntime` 和它的参数
- `next/src/application/run-prepare.ts` — `RUNS_DIR`、`prepareRun`
- `next/src/application/run-finish.ts` — `finishRun`
- `next/src/domain/report.ts` — `readReport`
- `next/test/pi-runtime.test.mjs` — 在测试里用假的 Pi 脚本的写法
- `next/test/helpers/run.mjs` — `runProject`、`readyTask`
- `src/application/stage-runner.ts` — 旧的 `stageRuntimeTools`（第 197–243 行），只读
- `test/fixtures/fake-pi.mjs` — 旧的假 Pi，只读

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-002795b3b0e8 -->
- 操作: op-002795b3b0e8
- 时间: 2026-11-15T23:03:49.304Z
- 分支: refs/heads/main
- 授权来源: user:1d2d626e
- 调用: bridge
- 工作提交: 3fb4927e627045e628137cb80fe10b7c49882a87
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-e9-execute-run

### 任务资料提交记录

<!-- knit:metadata-commit:op-002795b3b0e8 -->
- 任务资料提交: 35f802d5842c7bb4644cf86b8b2168d701437a73
- 归档目标: .knit/tasks/archive/2026-11/11-15-e9-execute-run

<!-- knit:progress:end -->
