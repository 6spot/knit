---
id: k-3e355531eadb
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-325d9a0ad142
order: null
createdAt: 2026-11-16T15:19:33.334Z
title: G6 knit_run：start、status、cancel
---

# G6 knit_run：start、status、cancel

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。桥接是 Pi 的一个扩展文件，`knit init` 把它生成到项目的 `.pi/extensions/knit.ts`，模板在 `next/assets/templates/pi/extensions/knit.ts`。它只做转交：工具的每个动作对应一条 `knit` 命令，工具的结果就是命令的输出。Pi 的扩展接口见 `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md`，不需要另外读 Pi 的文档。

本任务加第二个工具 `knit_run`：派发执行者、看执行的情况、取消。执行结束时通知主会话在后面的任务里做。

做完之后的不同：主会话能用 `knit_run` 派发任务的下一个环节，工具立即返回，执行者在后台做。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/assets/templates/pi/extensions/knit.ts`（修改） | 注册 `knit_run` |
| `next/test/bridge-run.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`knit_run`：`label` 是 `Knit run`，`description` 是 `派发和查看执行者。start 派发任务的下一个环节，立即返回，执行者在后台做；status 看上一次或正在跑的执行和下一步；cancel 停掉正在跑的执行并记为失败。`，`parameters`：

```json
{
  "type": "object",
  "properties": {
    "action": { "type": "string", "enum": ["start", "status", "cancel"] },
    "taskId": { "type": "string" },
    "model": { "type": "string" }
  },
  "required": ["action", "taskId"]
}
```

| 动作 | 命令 |
| --- | --- |
| `start` | `knit run start <taskId> [--model=<model>]` |
| `status` | `knit run status <taskId>` |
| `cancel` | `knit run cancel <taskId>` |

`taskId` 是空字符串时不运行命令，结果是错误，文本 `knit_run 的 <动作> 要有 taskId`。命令的结果怎样变成工具的结果，和 `knit_task` 用同一个内部函数。`knit run cancel` 最多要等十秒左右，工具等它做完，不设超时。

测试的做法：

- 项目用 `next/test/helpers/run.mjs` 的 `runProject`（临时 Git 仓库，流程里写了模型），`loadBridge` 之后用 `helpers/git.mjs` 的 `commitAll` 把初始化生成的文件提交掉，再用 `readyTask` 建任务。
- 执行者用假的 Pi：把 `process.env.KNIT_PI_BIN` 设成 `next/test/helpers/fake-pi.mjs` 的路径，`KNIT_FAKE_PI` 设成一个放在项目外面的 JSON 文件，测试结束时改回去。桥接运行的 `knit` 继承这些环境变量。假 Pi 认哪些字段见它开头的注释；`next/test/run-start.test.mjs` 是现成的例子。
- 等后台做完：每 100 毫秒看一次 `record.json` 里那次执行的 `endedAt`，最多等 20 秒；还要等后台进程退出，测试才能结束。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "knit.selection" next/assets/templates/pi/extensions/knit.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改桥接模板。
4. 写测试。测试结束时不能留下后台进程：`pgrep -f fake-pi` 没有输出。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- `pgrep -f fake-pi`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add the knit_run tool to the bridge`。

## 完成条件

### Requirement: 桥接转交 knit run 的命令

#### Scenario: 派发后立即返回，之后能看到结果

- GIVEN 加载了桥接的临时仓库，里面有一个已经确认的任务；假 Pi 会写一个文件再结束
- WHEN 调用 `knit_run` 的 `start`
- THEN 结果不是错误，文本是 `已派发 <id>：实现（<执行 id>）` 和 `日志：<路径>` 两行
- AND 等这次执行结束之后调用 `status`：文本和直接运行 `knit run status <id>` 的标准输出（去掉结尾的空白）相同，里面有 `上一次: 实现`

#### Scenario: 取消正在跑的执行

- GIVEN 同上，假 Pi 一直等一个不存在的文件
- WHEN 调用 `start`，再调用 `cancel`
- THEN `cancel` 的结果不是错误，文本的第一行是 `已取消 <id> 的执行 <执行 id>`
- AND 记录里这次执行已经结束，失败原因是 `已取消`；假 Pi 的进程不在了

#### Scenario: 命令拒绝时原样转交

- GIVEN 加载了桥接的临时仓库，里面有一个还没确认的任务
- WHEN 对它调用 `start`
- THEN 结果是错误，文本和直接运行 `knit run start <id>` 的标准错误（去掉结尾的空白）相同
- AND `taskId` 是空字符串时调用 `status`：结果是错误，文本是 `knit_run 的 status 要有 taskId`

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md` — Pi 的扩展接口：工具、事件、会话记录、发消息
- `.knit/tasks/11-14-slim-refactor/design.md#9-命令与工具` — `knit_run` 的动作
- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 派发、结束和取消各做什么
- `next/assets/templates/pi/extensions/knit.ts` — 要改的文件
- `next/src/cli/run.ts` — `run start`、`status`、`cancel` 的选项和输出
- `next/test/helpers/bridge.mjs` — `loadBridge`
- `next/test/helpers/run.mjs` — `runProject`、`readyTask`
- `next/test/helpers/fake-pi.mjs` — 假的 Pi
- `next/test/run-start.test.mjs` — 用假 Pi 派发和等待的例子
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
