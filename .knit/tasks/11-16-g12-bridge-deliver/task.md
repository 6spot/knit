---
id: k-91ebb0cd2c01
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-caf64b6b3d2f
order: null
createdAt: 2026-11-16T15:19:37.777Z
title: G12 交付授权：knit_deliver 核对用户的原话之后交付
---

# G12 交付授权：knit_deliver 核对用户的原话之后交付

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。桥接是 Pi 的一个扩展文件，`knit init` 把它生成到项目的 `.pi/extensions/knit.ts`，模板在 `next/assets/templates/pi/extensions/knit.ts`。它只做转交：工具的每个动作对应一条 `knit` 命令，工具的结果就是命令的输出。Pi 的扩展接口见 `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md`，不需要另外读 Pi 的文档。

交付要有用户的授权。命令行的 `knit deliver <任务> --authorization <引用>` 只要求有引用，不核对它是不是真的；核对由桥接在调用命令之前做，因为只有桥接读得到会话记录。`knit_deliver` 现在只能预览（不带 `preview` 时报「只能预览」）。本任务做真的交付。

做完之后的不同：主会话用 `knit_deliver` 交付时，要给出用户同意交付的那句原话；桥接在当前会话里找到用户确实说过这句话，才运行命令，并把是哪一条消息记进任务。

桥接只证明用户说过这句话，不判断这句话是不是针对这个任务说的：后者机器判断不了，靠记下来的原话事后能查。用户可以在任务开始的时候就给授权，交付时引用那一句；这是允许的。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/assets/templates/pi/extensions/knit.ts`（修改） | `knit_deliver` 加参数 `authorization`；不带 `preview` 时核对并交付 |
| `next/test/bridge-deliver.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

- `parameters` 加 `"authorization": { "type": "string" }`。`description` 改成 `交付一个完成的任务：归档；项目在 Git 仓库里时再提交一次，不推送。preview 为真时只列出会做什么。真的交付要有用户的授权：authorization 写用户同意交付的那条消息的原话（整条，或者其中完整的一行），不要改写。message 是提交文案，在 Git 仓库里交付时要有。`
- 预览不变，不需要 `authorization`。
- 不带 `preview` 时，依次：
  1. `authorization` 没有给，或者去掉首尾空白之后是空的：结果是错误，文本 `交付要有用户的授权：authorization 写用户同意交付的那条消息的原话`。
  2. 在 `ctx.sessionManager.getBranch()` 里找用户消息：`type` 是 `message`，并且 `message.role` 是 `user` 的记录。别的记录都不算，包括智能体自己的消息和扩展发的消息（`custom_message`）。
  3. 一条用户消息的文本：`content` 是字符串时就是它；是数组时把其中 `type` 是 `text` 的块的 `text` 用换行连起来。
  4. `authorization`（去掉首尾空白）等于这条文本去掉首尾空白，或者等于它按换行拆开之后某一行去掉首尾空白，就算找到。只是一行里的一部分不算。有几条都对得上时取最后一条。
  5. 找不到：不运行命令，结果是错误，文本 `在这个会话里找不到用户说过这句话：<authorization>；authorization 要写用户同意交付的那条消息的原话（整条，或者其中完整的一行）`。
  6. 找到：运行 `knit deliver <taskId> --authorization=<引用>`，给了 `message` 时照预览的做法加 `--message-file=<文件>`，做完删掉。`<引用>` 是 `user:<那条记录的 id>`、一个空格、去掉首尾空白的 `authorization`。命令会把它记进任务的 `record.json`。
- 原来「只能预览」的那一句和 `next/test/bridge-deliver-preview.test.mjs` 里核对它的那一处断言去掉。

要求整条或整行，而不是随便一段：智能体只能引用用户实际说的一句完整的话。用户说「先不要交付」时，引不出「交付」两个字来当授权。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "knit_deliver 现在只能预览" next/assets/templates/pi/extensions/knit.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改桥接模板。
4. 写测试。用户消息直接加进 `loadBridge` 返回的 `entries`，样子照摘录里的会话记录。「产出」之外允许改的只有 `next/test/bridge-deliver-preview.test.mjs` 里那一处断言。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 「产出」之外允许改的只有 `next/test/bridge-deliver-preview.test.mjs` 里那一处断言。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：本任务要求独立审查，由另一个执行者对照完成条件审查；提交由用户另行授权，文案首行建议 `feat(next): deliver through the bridge only with the user's own words`。

## 完成条件

### Requirement: 找到用户的原话才交付

#### Scenario: 找到原话时交付并记下是哪一条

- GIVEN 加载了桥接的临时项目（不在 Git 仓库里），一个已经完成的任务；会话记录里有两条用户消息：一条的 `content` 是字符串 `可以交付，然后下一步G。`，后一条的 `content` 是一个文本块，两行，第二行是 `授权交付`
- WHEN 调用 `knit_deliver`，`authorization` 是前后带空格的 `授权交付`
- THEN 结果不是错误，文本和命令行交付的输出一样是三行：`已交付 <id>`、`归档: …`、`提交: 这个项目不在 Git 仓库里，没有提交`
- AND 任务目录移到了归档目录，状态是 `delivered`，`record.json` 的 `authorization` 是 `user:<后一条记录的 id> 授权交付`
- AND 对另一个完成的任务用 `可以交付，然后下一步G。` 交付：同样成功，记下的是前一条记录的 id

#### Scenario: 找不到原话时不交付

- GIVEN 同上的会话记录，另有一条智能体的消息和一条扩展发的消息（`custom_message`），内容都是 `同意交付`；一个已经完成的任务
- WHEN 调用 `knit_deliver`，`authorization` 依次是 `同意交付`、`交付`、`可以交付`
- THEN 三次的结果都是错误，文本是 `在这个会话里找不到用户说过这句话：` 加给的那句话，再加 `；authorization 要写用户同意交付的那条消息的原话（整条，或者其中完整的一行）`
- AND 不给 `authorization`，或者给几个空格：结果是错误，文本是 `交付要有用户的授权：authorization 写用户同意交付的那条消息的原话`
- AND 任务还在原处，`task.md` 和 `record.json` 逐字没有变

#### Scenario: 在 Git 仓库里带提交文案交付

- GIVEN 加载了桥接的临时 Git 仓库，一个已经完成的任务，会话记录里有一条用户消息 `可以交付`
- WHEN 调用 `knit_deliver`，`authorization` 是 `可以交付`，`message` 是 `feat: 加问候语`
- THEN 结果不是错误，文本的第三行是 `提交: <提交号> feat: 加问候语`
- AND 最新一次提交的说明是 `feat: 加问候语`、一个空行、`Knit-Task: <id>`
- AND 临时目录里没有留下 `knit-message-` 开头的目录

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md` — Pi 的扩展接口：工具、事件、会话记录、发消息
- `.knit/tasks/11-14-slim-refactor/design.md#82-交付` — 交付的授权：命令行只要求有，桥接核对
- `.knit/tasks/11-14-slim-refactor/design.md#33-recordjson` — `authorization` 字段
- `next/assets/templates/pi/extensions/knit.ts` — 要改的文件
- `next/src/cli/deliver.ts` — `knit deliver` 的选项、输出和拒绝的话
- `next/test/bridge-deliver-preview.test.mjs` — 要删一处断言
- `next/test/helpers/bridge.mjs` — `loadBridge`：`entries`
- `next/test/helpers/deliver.mjs` — `doneTask`、`gitIdentity`
- `next/test/helpers/git.mjs` — `gitProject`、`commitAll`、`git`
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
