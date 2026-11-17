---
id: k-2fe0d72671ef
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-6294f5bafbd8
order: null
createdAt: 2026-11-16T15:19:31.863Z
title: G4 桥接：knit init 生成桥接，knit_task 的 new、ready、close、list
---

# G4 桥接：knit init 生成桥接，knit_task 的 new、ready、close、list

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。桥接是 Pi 的一个扩展文件，`knit init` 把它生成到项目的 `.pi/extensions/knit.ts`，模板在 `next/assets/templates/pi/extensions/knit.ts`。它只做转交：工具的每个动作对应一条 `knit` 命令，工具的结果就是命令的输出。Pi 的扩展接口见 `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md`，不需要另外读 Pi 的文档。

本任务写桥接的模板、让 `knit init` 生成它，并做第一个工具 `knit_task` 的四个动作。其它动作和另外两个工具在后面的任务里加。

做完之后的不同：`knit init` 多生成一份 `.pi/extensions/knit.ts`；Pi 加载它之后，主会话能用 `knit_task` 建任务、确认、记为完成、列出任务。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/assets/templates/pi/extensions/knit.ts`（新增） | 桥接的模板，见下 |
| `next/tsconfig.templates.json`（新增） | 只检查桥接模板的类型：`extends` 是 `../tsconfig.json`，`compilerOptions` 里 `erasableSyntaxOnly` 为 `true`，`include` 是 `["assets/templates/pi/extensions/knit.ts"]` |
| `next/src/application/init.ts`（修改） | `TEMPLATES` 末尾加一项：`pi/extensions/knit.ts` 生成到 `.pi/extensions/knit.ts`，`restore` 是 `true` |
| `next/test/helpers/bridge.mjs`（新增） | `loadBridge(t, dir)`，见下 |
| `next/test/bridge-task.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

桥接模板的写法：

- 只 `import` Node 自带的模块，不 `import` Pi 的包；用到的 Pi 接口的类型写在文件里（按摘录里的样子，只写用到的成员）。这样 Pi 和测试都能直接加载它。
- 只用去掉之后不影响运行的类型写法：不用 `enum`、`namespace`、构造函数参数属性。Pi 和 Node 都是去掉类型之后直接运行这个文件。
- 默认导出一个函数，参数是 `pi`。函数里不启动进程和定时器。
- 项目根从文件自己的位置算：`.pi/extensions/knit.ts` 往上三级。
- 一个内部函数运行 `knit` 命令：用 `spawn` 运行 `PATH` 上的 `knit`，参数后面加 `--dir <项目根>`，工作目录是项目根，收集标准输出和标准错误，返回退出码和两段文本。命令启动不了（例如 `PATH` 上没有 `knit`）时不抛错，当作退出码 1，标准错误是 `运行不了 knit 命令（<原因>）；确认 knit 已经安装并且在 PATH 上`。不设超时。
- 一个内部函数把命令的结果变成工具的结果：退出码是 0 时文本是标准输出去掉结尾的空白；否则 `isError` 是 `true`，文本是标准错误去掉结尾的空白，标准错误是空的就用标准输出。`details` 是 `undefined`。

`knit_task` 工具：`label` 是 `Knit task`，`description` 是 `管理 Knit 任务。new 创建任务（要有 title），ready 确认需求，close 把任务记为完成并写下结果（要有 result），list 列出任务。task.md 的正文用普通的读写工具直接改。`，`parameters`：

```json
{
  "type": "object",
  "properties": {
    "action": { "type": "string", "enum": ["new", "ready", "close", "list"] },
    "taskId": { "type": "string" },
    "title": { "type": "string" },
    "slug": { "type": "string" },
    "verification": { "type": "string", "enum": ["none", "self", "independent"] },
    "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"] },
    "parent": { "type": "string" },
    "dependsOn": { "type": "array", "items": { "type": "string" } },
    "result": { "type": "string" },
    "paths": { "type": "array", "items": { "type": "string" } },
    "reason": { "type": "string" },
    "archive": { "type": "boolean" }
  },
  "required": ["action"]
}
```

各动作运行的命令，没有给的可选参数不出现在命令里。单个值都写成 `--选项=值` 的一个参数：值以 `-` 开头时不会被当成别的选项。

| 动作 | 必须有 | 命令 |
| --- | --- | --- |
| `new` | `title` | `knit task new --title=<title> [--slug=<slug>] [--verification=<verification>] [--priority=<priority>] [--parent=<parent>] [--depends-on <dependsOn 的每一项>…]` |
| `ready` | `taskId` | `knit task ready <taskId>` |
| `close` | `taskId`、`result` | `knit task close <taskId> --result=<result> [--paths <paths 的每一项>…] [--reason=<reason>]` |
| `list` | — | `knit task list [--archive]`，`archive` 为真时带 `--archive` |

必须有的参数没有给（或者是空字符串）时不运行命令，结果是 `isError` 加文本 `knit_task 的 <动作> 要有 <参数名>`，缺几个只报第一个。`dependsOn`、`paths` 是空数组时和没有给一样。

`loadBridge(t, dir)`（`next/test/helpers/bridge.mjs`，异步）：

1. 建一个临时目录，里面写一个可执行的 `knit` 脚本（`#!/bin/sh`，`exec "<process.execPath>" "<next/dist/cli/knit.js 的绝对路径>" "$@"`），把这个目录加到 `process.env.PATH` 的最前面；`t.after` 里把 `PATH` 改回去并删掉目录。
2. 在 `dir` 里运行 `knit init`（用 `helpers/cli.mjs` 的 `knit`），退出码要是 0。
3. `import()` 生成出来的 `<dir>/.pi/extensions/knit.ts`，调用它的默认导出，传一个假的 `pi`：`registerTool` 按名字记下工具；`on` 按事件名记下处理函数；`appendEntry(customType, data)` 往 `entries` 末尾加 `{ type: "custom", id, customType, data }`（`id` 每条不同）；`sendMessage(message, options)` 往 `messages` 末尾加 `{ message, options }`。
4. 返回 `{ tool, fire, entries, messages }`：`tool(name, params)` 调用那个工具的 `execute`，第五个参数是 `{ sessionManager: { getBranch: () => entries } }`，返回它的结果；`fire(event, payload)` 依次调用这个事件的处理函数（第二个参数同上）并等它们做完；`entries`、`messages` 就是上面那两个数组，测试可以直接往 `entries` 里加记录。

本任务只用到 `tool`；`fire`、`entries`、`messages` 是给后面的任务用的，现在就写好，后面的任务不再改这个文件。

类型检查放在测试里：运行 `node node_modules/typescript/bin/tsc -p next/tsconfig.templates.json`（路径从测试文件的位置算），退出码要是 0。`npm run build:next` 不编译模板，所以靠它发现类型错误。

新写的代码遵守 `.knit/standards/development.md`；桥接模板是产品代码，同样遵守。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "restore" next/src/application/init.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写桥接模板和 `next/tsconfig.templates.json`，运行上面的类型检查命令到退出码是 0。类型检查因为配置本身报错（不是模板的类型错误）时停下报告。
4. 在 `TEMPLATES` 里加一项。`next/test/init.test.mjs`、`next/test/init-force.test.mjs` 的清单是从 `TEMPLATES` 取的，不需要改；改了它们才能通过就停下报告。
5. 写 `helpers/bridge.mjs` 和测试。
6. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): generate the Pi bridge with the knit_task tool`。

## 完成条件

### Requirement: 桥接转交 knit task 的命令

#### Scenario: 初始化生成桥接

- GIVEN 一个空的临时目录
- WHEN 运行 `knit init`
- THEN `.pi/extensions/knit.ts` 和桥接模板逐字相同，输出的 `已生成:` 里有它
- AND 把它改掉之后运行 `knit init --force`，它恢复成模板，改过的内容在备份目录的 `.pi/extensions/knit.ts` 里
- AND 类型检查命令的退出码是 0

#### Scenario: 四个动作转交命令

- GIVEN 用 `loadBridge` 加载了桥接的临时项目
- WHEN 调用 `knit_task`：`new`（`title` 是 `- 以横线开头`，`verification` 是 `independent`，`priority` 是 `P1`）
- THEN 结果不是错误，文本是 `已创建 <id>` 和任务文件的路径两行；任务文件里的标题、验证方式和优先级和给的一样
- AND `list` 的文本和直接运行 `knit task list` 的标准输出（去掉结尾的空白）相同；`list` 带 `archive: true` 的文本和 `knit task list --archive` 的相同
- AND 对这个需求还是空的任务调用 `ready`：结果是错误，文本和直接运行 `knit task ready <id>` 的标准错误（去掉结尾的空白）相同
- AND 对一个已经确认、验证方式是 `self` 的任务调用 `close`（`result` 是两行文本，`paths` 是两个路径）：结果不是错误，任务的状态是 `done`，「结果」是那两行，记录里的改动路径是那两个

#### Scenario: 参数不全和命令运行不了

- GIVEN 用 `loadBridge` 加载了桥接的临时项目
- WHEN 调用 `ready` 不带 `taskId`、`new` 不带 `title`、`close` 只带 `taskId`
- THEN 结果都是错误，文本分别是 `knit_task 的 ready 要有 taskId`、`knit_task 的 new 要有 title`、`knit_task 的 close 要有 result`，项目里的文件没有变
- AND 把 `process.env.PATH` 改成一个没有 `knit` 的目录之后调用 `list`：结果是错误，文本以 `运行不了 knit 命令（` 开头，以 `确认 knit 已经安装并且在 PATH 上` 结尾

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md` — Pi 的扩展接口：工具、事件、会话记录、发消息
- `.knit/tasks/11-14-slim-refactor/design.md#9-命令与工具` — 三个工具和它们的动作；桥接只做转交
- `next/src/application/init.ts` — 要改的文件：`TEMPLATES`
- `next/src/cli/task.ts` — `task new`、`ready`、`close`、`list` 的选项和输出
- `next/test/helpers/cli.mjs` — `knit`、`project`
- `next/test/helpers/run.mjs` — `readyTask(dir, { verification: "self" })`：建一个已经确认的任务
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-8eaf170cfb6a -->
- 操作: op-8eaf170cfb6a
- 时间: 2026-11-17T01:01:01.354Z
- 分支: refs/heads/main
- 授权来源: user:a743f72d
- 调用: bridge
- 工作提交: 30fad6ff0a1690fe65a76aea1ac3dc6f9a4e29bd
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-16-g4-bridge-task

### 任务资料提交记录

<!-- knit:metadata-commit:op-8eaf170cfb6a -->
- 任务资料提交: b2dcfa87b78bfcb9015bdafa11cd0d4a1eb93d80
- 归档目标: .knit/tasks/archive/2026-11/11-16-g4-bridge-task

<!-- knit:progress:end -->
