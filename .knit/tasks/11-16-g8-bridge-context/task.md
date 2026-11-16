---
id: k-cca21fa02b23
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-952f2f199c14
order: null
createdAt: 2026-11-16T15:19:34.813Z
title: G8 每轮注入：桥接把 knit context 的输出放进系统提示
---

# G8 每轮注入：桥接把 knit context 的输出放进系统提示

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。桥接是 Pi 的一个扩展文件，`knit init` 把它生成到项目的 `.pi/extensions/knit.ts`，模板在 `next/assets/templates/pi/extensions/knit.ts`。它只做转交：工具的每个动作对应一条 `knit` 命令，工具的结果就是命令的输出。Pi 的扩展接口见 `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md`，不需要另外读 Pi 的文档。

`knit context <任务>` 已经能输出一个任务的状态、下一步和当前环节的规范；`knit_task` 的 `use` 已经能把选中的任务记进会话记录（桥接里的 `selectedTask`）。本任务把两者接起来：每一轮开始之前，桥接把选中任务的 `knit context` 输出放进系统提示里它自己的那一段。

做完之后的不同：主会话每一轮都能看到选中任务的状态、下一步和当前环节的规范；这就是项目规范按环节交给主会话的地方。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/assets/templates/pi/extensions/knit.ts`（修改） | 加 `before_agent_start` 的处理函数 |
| `next/test/bridge-context.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`before_agent_start` 的处理函数：

1. `event.systemPromptOptions.sections` 不存在时什么都不做。
2. `selectedTask(ctx)` 是 `null`：`sections.knit` 是这一行：`没有选中 Knit 任务。用 knit_task 的 list 查看任务，use 选中一个。`
3. 否则运行 `knit context <id>`。退出码是 0：`sections.knit` 是标准输出去掉结尾的空白。不是 0：`sections.knit` 是 `选中的 Knit 任务 <id> 读不出来：`，换行，接着是标准错误去掉结尾的空白。
4. 只写 `knit` 这一段，别的段不碰；不返回任何东西。

不管这一轮是用户的输入触发的还是一条通知触发的，都这样做。放在系统提示里而不是消息里：Pi 压缩会话时保留系统提示；内容没变时 Pi 不会重发这一段。

桥接不缓存输出：每一轮运行一次命令，本机上一次大约 0.1 秒。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "registerContextCommand" next/src/cli/knit.ts` 和 `grep -n "selectedTask" next/assets/templates/pi/extensions/knit.ts` 都有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改桥接模板。
4. 写测试，用 `loadBridge` 返回的 `fire("before_agent_start", event)` 触发，`event` 是 `{ systemPromptOptions: { sections: { … } } }`，触发之后看 `event.systemPromptOptions.sections`。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): inject the task context into every turn`。

## 完成条件

### Requirement: 每一轮都能看到选中任务的状态和规范

#### Scenario: 选中任务之后每一轮写入

- GIVEN 加载了桥接的临时项目，有一份适用 `discuss` 的规范；用 `knit_task` 的 `new` 建了一个任务，再用 `use` 选中它
- WHEN 触发 `before_agent_start`，`sections` 里原来有一段 `other`
- THEN `sections.knit` 和直接运行 `knit context <id>` 的标准输出（去掉结尾的空白）相同，里面有那份规范的正文；`other` 没有变
- AND 再触发一次，`sections.knit` 和上一次逐字相同
- AND 用 `use` 选中另一个任务之后再触发，`sections.knit` 是另一个任务的

#### Scenario: 没有选中任务

- GIVEN 加载了桥接的临时项目，会话记录是空的
- WHEN 触发 `before_agent_start`
- THEN `sections.knit` 是 `没有选中 Knit 任务。用 knit_task 的 list 查看任务，use 选中一个。`
- AND 选中一个任务、再用不带 `taskId` 的 `use` 取消之后触发，`sections.knit` 还是这一行

#### Scenario: 选中的任务读不出来

- GIVEN 加载了桥接的临时项目，选中了一个任务，之后它的目录被删掉了
- WHEN 触发 `before_agent_start`
- THEN `sections.knit` 的第一行是 `选中的 Knit 任务 <id> 读不出来：`，后面是直接运行 `knit context <id>` 的标准错误（去掉结尾的空白）
- AND 用一个没有 `systemPromptOptions` 的事件触发时不抛错

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md` — Pi 的扩展接口：工具、事件、会话记录、发消息
- `.knit/tasks/11-14-slim-refactor/design.md#52-放在哪里` — 主会话的规范放在系统提示里，以及理由
- `.knit/tasks/11-14-slim-refactor/design.md#9-命令与工具` — 每轮注入什么；没有选中任务时只有一行
- `next/assets/templates/pi/extensions/knit.ts` — 要改的文件
- `next/src/cli/context.ts` — `knit context` 的输出
- `next/test/helpers/bridge.mjs` — `loadBridge`
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
