---
id: k-325d9a0ad142
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-2fe0d72671ef
order: null
createdAt: 2026-11-16T15:19:32.606Z
title: G5 任务选择：knit_task 的 use
---

# G5 任务选择：knit_task 的 use

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。桥接是 Pi 的一个扩展文件，`knit init` 把它生成到项目的 `.pi/extensions/knit.ts`，模板在 `next/assets/templates/pi/extensions/knit.ts`。它只做转交：工具的每个动作对应一条 `knit` 命令，工具的结果就是命令的输出。Pi 的扩展接口见 `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md`，不需要另外读 Pi 的文档。

主会话每一轮会收到一个任务的状态和规范（后面的任务做）。是哪个任务，由「选中的任务」决定。本任务做选中：把选择写进 Pi 的会话记录，会话重开之后还在。

做完之后的不同：`knit_task` 多一个动作 `use`。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/assets/templates/pi/extensions/knit.ts`（修改） | `knit_task` 加动作 `use`；加内部函数 `selectedTask` |
| `next/test/bridge-use.test.mjs`（新增） | 见「完成条件」的两个场景，各一个测试 |

- 选择记成一条会话记录：`pi.appendEntry("knit.selection", { taskId })`，`taskId` 是任务 id，取消选中时是 `null`。这种记录不进模型的上下文。
- `use` 带 `taskId`：先运行 `knit task show <taskId>`。退出码不是 0 时结果是错误，文本是命令的标准错误，不写记录。是 0 时写记录，结果的文本是 `已选中 <taskId>`，换行，接着是命令的标准输出（去掉结尾的空白）。
- `use` 不带 `taskId`：取消选中。写一条 `taskId` 是 `null` 的记录，文本是 `已取消选中`。
- `new` 不选中新建的任务，也不写记录：选中哪个任务只由 `use` 决定。一次建一批任务时，选中的不会被最后建的那个换掉。
- `selectedTask(ctx)`：`ctx.sessionManager.getBranch()` 里最后一条 `type` 是 `custom`、`customType` 是 `knit.selection` 的记录的 `data.taskId`；没有这样的记录时是 `null`。本任务里没有地方用它，测试也测不到；后面做每轮注入的任务会用。
- `parameters` 的 `action` 的 `enum` 加上 `use`；`description` 改成 `管理 Knit 任务。new 创建任务（要有 title），use 选中一个任务（之后每一轮都能看到它的状态和当前环节的规范；不带 taskId 是取消选中；新建的任务不会自动选中），ready 确认需求，close 把任务记为完成并写下结果（要有 result），list 列出任务。task.md 的正文用普通的读写工具直接改。`

命令行没有 `knit task use`：选择写在 Pi 的会话记录里，命令行写不了。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "knit_task" next/assets/templates/pi/extensions/knit.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改桥接模板。
4. 写测试，用 `next/test/helpers/bridge.mjs` 的 `loadBridge`，从它返回的 `entries` 看写了什么记录。`next/test/bridge-task.test.mjs` 不需要改；改了它才能通过就停下报告。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): select a task with knit_task use`。

## 完成条件

### Requirement: 选中的任务记在会话记录里

#### Scenario: 选中和取消选中

- GIVEN 加载了桥接的临时项目，里面有一个任务，会话记录是空的
- WHEN 调用 `knit_task` 的 `use`，`taskId` 是这个任务
- THEN 结果不是错误，文本是 `已选中 <id>` 一行加直接运行 `knit task show <id>` 的标准输出（去掉结尾的空白）
- AND 会话记录多了一条：`customType` 是 `knit.selection`，`data` 是 `{ taskId: <id> }`
- AND 再调用不带 `taskId` 的 `use`：文本是 `已取消选中`，会话记录又多一条，`data` 是 `{ taskId: null }`
- AND 再用 `new` 建一个任务：会话记录没有增加

#### Scenario: 选一个不存在的任务

- GIVEN 加载了桥接的临时项目，会话记录是空的
- WHEN 调用 `use`，`taskId` 是 `k-000000000000`
- THEN 结果是错误，文本和直接运行 `knit task show k-000000000000` 的标准错误（去掉结尾的空白）相同
- AND 会话记录还是空的

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md` — Pi 的扩展接口：工具、事件、会话记录、发消息
- `.knit/tasks/11-14-slim-refactor/design.md#9-命令与工具` — `use` 只有工具有；选择写在 Pi 会话记录里
- `next/assets/templates/pi/extensions/knit.ts` — 要改的文件
- `next/src/cli/task.ts` — `task show`、`task new` 的输出
- `next/test/helpers/bridge.mjs` — `loadBridge`
- `next/test/bridge-task.test.mjs` — 上一个任务的测试，不改
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-f8659f246777 -->
- 操作: op-f8659f246777
- 时间: 2026-11-17T01:01:15.626Z
- 分支: refs/heads/main
- 授权来源: user:a743f72d
- 调用: bridge
- 工作提交: ca6b50cc9ff864524b8bb67ae37d9a33ca80abab
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-16-g5-bridge-use

<!-- knit:progress:end -->
