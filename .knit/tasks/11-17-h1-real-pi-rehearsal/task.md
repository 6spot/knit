---
id: k-62ebc05deb50
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-17T04:35:03.882Z
title: H1 全流程演练：用真的 Pi 走完一个任务
---

# H1 全流程演练：用真的 Pi 走完一个任务

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`。到现在为止，新代码的测试全部用假的 Pi（`next/test/helpers/fake-pi.mjs`），没有调用过模型，桥接（`next/assets/templates/pi/extensions/knit.ts`）也没有被真的 Pi 加载过。切换（删除旧代码，H2）之前，要用真的 Pi 和真的模型把一个任务从创建走到交付，并把过程留成记录。

做完之后的不同：仓库里有一份记录，写明新的 Knit 用真的 Pi 能不能走完一个任务，哪里不行。

本任务调用真实模型，用户已经同意（2026-11-17「提交，推送归档，然后继续按你推荐的来」，当时说明的下一步就是 H1）。Linux 上的测试不在本任务里：用户决定放到最后，本机 macOS 全部走通之后再跑。

产出，都在新目录 `validation/slim-h1-2026-11/` 里：

| 文件 | 做成什么样 |
| --- | --- |
| `README.md` | 环境（系统、Node、Pi、Git 的版本，模型，演练时本仓库的提交）、每个场景的结果和证据文件、「另外记下的」各项的结果、发现的问题、没有验证的内容 |
| `setup.sh` | 建一个演练用的项目，见下面「演练用的项目」 |
| `task-body.md` | 演练任务的需求正文，场景一、二共用 |
| `rpc.mjs` | 启动一个 rpc 模式的 Pi，发命令、收事件，把收到的每一行存成 jsonl |
| `cli-flow.sh` | 场景一 |
| `bridge-flow.mjs` | 场景二，和「另外记下的」第 3 项 |
| `cancel.sh` | 场景三 |
| `refusals.sh` | 「另外记下的」第 1 项 |
| `trust.mjs`、`tools-ext.ts` | 「另外记下的」第 2 项：一个只用来列出已注册工具的扩展，和运行它的脚本 |
| `logs/` | 各脚本的输出、主会话的事件记录和会话记录、两个临时项目里的 `record.json` 和执行报告 |

脚本怎么找到新的 Knit：在临时目录里建一个 `bin/knit`，内容是用 `node` 运行本仓库的 `next/dist/cli/knit.js`，把这个 `bin` 放在 `PATH` 最前面。桥接运行的是 `PATH` 上的 `knit`，所以主会话和命令行用的是同一份。

演练用的项目：在 `/tmp/knit-h1/<场景>/proj` 新建 Git 仓库，里面一个文件 `greet.mjs`：

```js
export function greet(name) {
  return `hello ${name}`;
}
```

和一个 `AGENTS.md`，其中一条是「每份报告正文的第一行写 `AGENTS-MARK: 7f3a`」，用来看执行者有没有读到它。核对的是报告里有没有单独的这一行，不要求正好在第一行：模型有时会在前面加一个标题，那是模型照不照办的事，不是 Knit 有没有把文件交给它；在第几行记进 `README.md`。`knit init` 之后在 `.knit/workflow.yaml` 里写 `model: magpie/group/deepseek`，再放两份规范（一份 `stages: [implement, review]`，一份 `stages: [deliver]`），用来看规范有没有按环节交到执行者和主会话手里，然后提交一次。演练的任务是「`greet(name, word)`：`word` 不传时是 `hello`；新增 `greet.test.mjs`，`node --test` 通过」，验证方式 `independent`，两个场景。

场景二里主会话怎么启动：`pi --mode rpc --approve --no-mcp --no-skills --no-prompt-templates --no-themes --no-context-files --provider magpie --model group/deepseek --session-dir <临时目录>`，工作目录是演练的项目，工具用 `--tools` 限成 `read,write,edit,bash,ls,grep,find,knit_task,knit_run,knit_deliver`。环境变量里去掉 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`。桥接由 Pi 自己从项目的 `.pi/extensions/` 里发现，不用 `--extension` 指定。`--no-context-files` 是为了记录：不加它，Pi 会把用户主目录下 `AGENTS.md` 的全文放进系统提示，跟着会话记录存进这个公开的仓库；执行者不受影响，它们由 Knit 启动，照常读 `AGENTS.md`（场景一核对）。事件记录不存流式输出的增量和 `get_entries` 的响应。收到要人回答的 `extension_ui_request`（`select`、`confirm`、`input`、`editor`）时一律回答取消，免得卡住。

场景二里用户说的话（脚本当用户，一条一条发，等这一轮结束再发下一条）：

1. 让它用 `knit_task` 建任务（给出标题和 `independent`），再用 `use` 选中。
2. 让它把给出的需求正文写进这个任务的 `task.md`（保留文件开头的元数据），再用 `knit_task` 的 `ready` 确认。
3. 让它用 `knit_run` 派发；说明派发之后不要轮询，执行结束时会收到消息，收到之后下一步还是派发就接着派发。发完这条脚本不再说话，等到 `record.json` 里有两次已经结束的执行、并且主会话停下来。
4. 让它核对成果，没有问题就用 `knit_task` 的 `close` 记为完成，再用 `knit_deliver` 预览，文案 `feat: let greet take a greeting word`；说明先不要真的交付。
5. 只说「可以交付」。

不能动的：

- `validation/slim-h1-2026-11/` 以外的文件。演练里发现新代码的问题时写进 `README.md`，不在本任务里改：改代码要另建任务、另取得授权。
- 演练只在 `/tmp/knit-h1/` 里做，不读写本仓库的 `.knit/` 和 `.pi/`。
- 不加依赖，不提交、不推送本仓库。
- 记录里不放密钥和用户主目录下文件的内容：只存脚本的输出、事件记录和会话记录；存之前用 `grep -rilE "api[_-]?key|authorization: bearer|Todo Management" logs/` 查一遍（后一个词是本机 `~/.pi/agent/AGENTS.md` 的标题），有输出就先处理。

前置条件：

- macOS；`pi --version` 是 1.5.2；`pi --list-models | grep "^magpie *group/deepseek"` 有输出。
- `npm run test:next` 通过（之后不要在演练进行时再运行它：它会先删掉 `next/dist`）。

步骤：

1. 运行 `git status --short`，记下开始前的状态；运行 `npm run test:next`。
2. 读「相关资料」。
3. 写上面的脚本，依次运行 `refusals.sh`、`trust.mjs`、`cli-flow.sh`、`cancel.sh`、`bridge-flow.mjs`，输出存进 `logs/`。
4. 每个脚本跑完运行 `pgrep -fl "mode rpc|run worker|run wait"`，把属于演练的残留进程写进记录。
5. 写 `README.md`。
6. 按「验证」核对。

验证：

- 三个场景各自的脚本以退出码 0 结束，脚本里逐条核对「完成条件」写的结果，不满足就以非 0 退出并说明是哪一条。
- `git status --short`：和开始前相比只多出 `validation/slim-h1-2026-11/`。
- 同一个脚本因同一原因失败两次就停下，把现象写进 `README.md` 的「发现的问题」，任务不记为完成。

另外记下的（结果写进 `README.md`，不是完成条件；不调用模型的用命令行直接做）：

1. 派发之前的几种拒绝，各运行一次 `knit run start`，记下输出：需求还没有确认；项目不在 Git 仓库里；任务已经结束；依赖的任务没有完成或不存在；流程里没有写模型；`task.md`、`workflow.yaml`、`config.json` 写坏了。再加一种派发之后才失败的：模型不存在。
2. 项目信任：`--approve` 时桥接的三个工具都在，`--no-approve` 时一个都没有。
3. 场景二做完之后用 `--session <会话文件>` 重开主会话，问一句话，看系统提示里 Knit 那一段是不是还带着选中的任务。
4. 场景三里 `knit run cancel` 用了多久。
5. 两个场景里每次执行用了多久。
6. 规范按环节给：执行者的 `system.md` 里只有它那个环节的规范；主会话每轮收到的那一段里，规范随任务走到的环节换。

交回：改动留在工作区。报告里写：三个场景的结果、发现的问题、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `docs: record the real-Pi rehearsal of the slim core`。发现的问题由用户决定哪些在切换之前修。

## 完成条件

### Requirement: 用真的 Pi 走完一个任务

#### Scenario: 用命令行走完，执行者是真的 Pi

- GIVEN 一个 `knit init` 过的临时 Git 仓库，流程里写了模型，里面有一个要求独立审查的任务
- WHEN 依次运行 `knit task ready`、`knit run start` 加 `knit run wait`（实现）、`knit run start` 加 `knit run wait`（审查）、`knit task close`、`knit deliver`
- THEN 两次执行都正常结束，审查的结论是 `pass`，`node --test` 输出里 `fail 0`
- AND 两次执行的会话记录里，系统提示带着这个项目的 `AGENTS.md`；两份报告里都有单独的一行 `AGENTS-MARK: 7f3a`
- AND 交付产生一次提交，里面有 `greet.mjs`、`greet.test.mjs` 和归档之后的任务目录，提交说明的最后一行是 `Knit-Task: <id>`，`knit task show` 的状态是 `delivered`

#### Scenario: 主会话通过桥接走完

- GIVEN 另一个 `knit init` 过的临时 Git 仓库，和在里面用 `--approve` 启动的 rpc 模式的 Pi 主会话
- WHEN 按「场景二里用户说的话」一条一条发给它
- THEN 模型调用过 `knit_task`、`knit_run` 和 `knit_deliver`；会话记录里系统提示的 `knit` 那一段出现过这个任务的 id；每次执行结束之后，没有新的用户消息，主会话也开始了一轮，这一轮由 `knit.run-ended` 消息开始
- AND 交付产生一次提交；`record.json` 里的授权是 `user:<条目 id> 可以交付`，这个条目 id 在会话记录里是内容为「可以交付」的那条用户消息

#### Scenario: 取消正在跑的执行

- GIVEN 一个任务的执行者（真的 Pi）正在运行一条要很久的命令
- WHEN 运行 `knit run cancel <id>`
- THEN 命令以退出码 0 返回，这次执行记为失败，原因是「已取消」
- AND 这次执行的后台进程、它启动的 Pi 和那条要很久的命令都不在了

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 执行者怎么跑、怎么结束
- `.knit/tasks/11-14-slim-refactor/design.md#8-完成与交付` — 完成、交付和授权
- `.knit/tasks/11-14-slim-refactor/design.md#9-命令与工具` — 命令行和桥接的三个工具
- `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md` — Pi 扩展接口摘录：工具、事件、会话记录的样子
- `next/assets/templates/pi/extensions/knit.ts` — 桥接
- `next/assets/templates/workflow.yaml` — 流程模板
- `next/src/application/run-execute.ts` — 执行者是怎么启动 Pi 的
- `next/src/adapters/pi/runtime.ts` — 启动 Pi 的参数和环境变量

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-e66480b3a414 -->
- 操作: op-e66480b3a414
- 时间: 2026-11-17T06:19:57.640Z
- 分支: refs/heads/main
- 授权来源: user:sha256:b9cae62539f8a4f1
- 调用: bridge
- 工作提交: e74bd6a29699f5198363b10e57406b6eb7870920
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-17-h1-real-pi-rehearsal

<!-- knit:progress:end -->
