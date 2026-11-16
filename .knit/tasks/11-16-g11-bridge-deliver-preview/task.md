---
id: k-caf64b6b3d2f
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-64aed19aea6c
order: null
createdAt: 2026-11-16T15:19:37.041Z
title: G11 knit_deliver：预览
---

# G11 knit_deliver：预览

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。桥接是 Pi 的一个扩展文件，`knit init` 把它生成到项目的 `.pi/extensions/knit.ts`，模板在 `next/assets/templates/pi/extensions/knit.ts`。它只做转交：工具的每个动作对应一条 `knit` 命令，工具的结果就是命令的输出。Pi 的扩展接口见 `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md`，不需要另外读 Pi 的文档。

`knit deliver <任务> --preview [--message-file <文件>]` 列出交付会做什么，什么都不改。本任务加第三个工具 `knit_deliver`，先做预览。真的交付要核对用户的授权，在下一个任务里做。

做完之后的不同：主会话能用 `knit_deliver` 预览一个任务的交付，提交文案直接作为参数给。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/assets/templates/pi/extensions/knit.ts`（修改） | 注册 `knit_deliver` |
| `next/test/bridge-deliver-preview.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`knit_deliver`：`label` 是 `Knit deliver`，`description` 是 `交付一个完成的任务：归档；项目在 Git 仓库里时再提交一次，不推送。preview 为真时只列出会做什么。message 是提交文案，在 Git 仓库里交付时要有。`，`parameters`：

```json
{
  "type": "object",
  "properties": {
    "taskId": { "type": "string" },
    "preview": { "type": "boolean" },
    "message": { "type": "string" }
  },
  "required": ["taskId"]
}
```

- `taskId` 是空字符串：结果是错误，文本 `knit_deliver 要有 taskId`。
- `preview` 不为真：结果是错误，文本 `knit_deliver 现在只能预览：加 preview: true`。下一个任务会把这一条换成真的交付。
- 预览运行 `knit deliver <taskId> --preview`，给了 `message`（去掉首尾空白之后不是空的）时再加 `--message-file=<文件>`。
- 提交文案的文件：用 `mkdtemp` 在系统的临时目录（`os.tmpdir()`）下建一个 `knit-message-` 开头的目录，把 `message` 原样写进里面的 `message.txt`；命令做完之后不管成败都把这个目录删掉。文件不能放在项目里：放在项目里它自己就成了工作区的一处改动。
- 命令的结果怎样变成工具的结果，和另外两个工具用同一个内部函数。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "knit.run-ended" next/assets/templates/pi/extensions/knit.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改桥接模板。
4. 写测试。完成的任务用 `next/test/helpers/deliver.mjs` 的 `doneTask`；Git 仓库用 `helpers/git.mjs` 的 `gitProject`，`loadBridge` 之后先 `commitAll`。要看临时文件有没有删掉：调用工具之前把 `process.env.TMPDIR` 指到测试自己建的一个空目录，调用之后看它还是不是空的，测试结束时改回去。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): preview a delivery with the knit_deliver tool`。

## 完成条件

### Requirement: 用工具预览交付

#### Scenario: 带提交文案预览

- GIVEN 加载了桥接的临时 Git 仓库，里面有一个已经完成的任务
- WHEN 调用 `knit_deliver`：`preview` 为真，`message` 是两段文本
- THEN 结果不是错误，文本的最后是 `提交文案:` 一行和缩进的那两段文本；这之前的行和直接运行 `knit deliver <id> --preview` 的输出去掉最后一行（`提交文案: 没有给…`）之后相同
- AND 任务还在原处、状态是 `done`，`git status --porcelain` 和调用之前相同
- AND 临时目录里没有留下 `knit-message-` 开头的目录

#### Scenario: 不带提交文案预览

- GIVEN 同上
- WHEN 调用 `knit_deliver`：`preview` 为真，不给 `message`；再调用一次，`message` 是几个空格
- THEN 两次的文本都和直接运行 `knit deliver <id> --preview` 的标准输出（去掉结尾的空白）相同
- AND 临时目录里没有建过东西

#### Scenario: 不能预览时

- GIVEN 加载了桥接的临时项目，里面有一个还没完成的任务
- WHEN 对它调用 `knit_deliver`，`preview` 为真
- THEN 结果是错误，文本和直接运行 `knit deliver <id> --preview` 的标准错误（去掉结尾的空白）相同
- AND 不带 `preview` 调用：结果是错误，文本是 `knit_deliver 现在只能预览：加 preview: true`
- AND `taskId` 是空字符串：结果是错误，文本是 `knit_deliver 要有 taskId`

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md` — Pi 的扩展接口：工具、事件、会话记录、发消息
- `.knit/tasks/11-14-slim-refactor/design.md#82-交付` — 交付做什么；预览列出什么
- `.knit/tasks/11-14-slim-refactor/design.md#9-命令与工具` — `knit_deliver`
- `next/assets/templates/pi/extensions/knit.ts` — 要改的文件
- `next/src/cli/deliver.ts` — `knit deliver` 的选项和输出
- `next/test/helpers/bridge.mjs` — `loadBridge`
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
