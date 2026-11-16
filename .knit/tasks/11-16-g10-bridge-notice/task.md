---
id: k-64aed19aea6c
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-f188e4cfb0a1
order: null
createdAt: 2026-11-16T15:19:36.308Z
title: G10 结束通知：执行结束时桥接告诉主会话
---

# G10 结束通知：执行结束时桥接告诉主会话

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。桥接是 Pi 的一个扩展文件，`knit init` 把它生成到项目的 `.pi/extensions/knit.ts`，模板在 `next/assets/templates/pi/extensions/knit.ts`。它只做转交：工具的每个动作对应一条 `knit` 命令，工具的结果就是命令的输出。Pi 的扩展接口见 `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md`，不需要另外读 Pi 的文档。

`knit_run` 的 `start` 派发之后立即返回；`knit run wait <任务>` 能等到这次执行结束并输出结果。本任务把两者接起来：派发成功之后桥接在后台等，结束时给主会话发一条消息并触发一轮，主会话不用自己反复查。

做完之后的不同：用 `knit_run` 派发的执行结束时，主会话收到一条写着结果和下一步的消息，并接着往下做。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/assets/templates/pi/extensions/knit.ts`（修改） | 派发成功后在后台等；结束时发消息；取消和会话结束时不再等 |
| `next/test/bridge-notice.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

- `knit_run` 的 `start` 退出码是 0 时，桥接启动 `knit run wait <taskId>`（和别的命令一样加 `--dir <项目根>`），不等它，工具照常返回。正在等的子进程按任务 id 记在一个 `Map` 里。
- 这个子进程退出时，如果它还在 `Map` 里：从 `Map` 里去掉，然后

  ```typescript
  pi.sendMessage(
    { customType: "knit.run-ended", content, display: true },
    { deliverAs: "followUp", triggerTurn: true },
  );
  ```

  退出码是 0 时 `content` 是 `Knit 的执行结束了：`，换行，接着是它的标准输出去掉结尾的空白；不是 0 时是 `等不到 <taskId> 的执行结束：`，换行，接着是标准错误去掉结尾的空白。
- `knit_run` 的 `cancel`：运行命令之前，先把这个任务正在等的子进程从 `Map` 里去掉并杀掉。主会话自己取消的，不需要再收一条通知。
- `session_shutdown`：把 `Map` 里的子进程都去掉并杀掉。会话重新加载或重开之后不接着等：那次执行的结果在下一轮的系统提示里能看到（选中了这个任务的话），也可以用 `status` 查。
- 被杀掉的子进程退出时已经不在 `Map` 里，所以不发消息。
- `knit_run` 的 `description` 里 `立即返回，执行者在后台做` 后面加上 `，结束时你会收到一条消息`。

Pi 的文档要求扩展不要在入口函数里启动后台资源，要在用得着的工具里启动，并在 `session_shutdown` 里关掉；上面就是按这个做的。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n '"wait <id>"' next/src/cli/run.ts` 和 `grep -n "before_agent_start" next/assets/templates/pi/extensions/knit.ts` 都有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改桥接模板。
4. 写测试，项目和假 Pi 的做法同 `next/test/bridge-run.test.mjs`；发出的消息从 `loadBridge` 返回的 `messages` 看。要断言「没有发消息」时，在执行已经结束之后再等 2.5 秒才看（`knit run wait` 每秒看一次）。`next/test/bridge-run.test.mjs` 不需要改；改了它才能通过就停下报告。
5. 测试结束时不能留下后台进程。
6. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- `pgrep -f fake-pi` 和 `pgrep -f "run wait"`：都没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): notify the main session when a run ends`。

## 完成条件

### Requirement: 执行结束时通知主会话

#### Scenario: 结束时发一条消息

- GIVEN 加载了桥接的临时仓库，一个已经确认的任务；假 Pi 做完就结束
- WHEN 调用 `knit_run` 的 `start`
- THEN 工具立即返回，这时还没有消息
- AND 执行结束后 5 秒内 `messages` 里有且只有一条：`message` 是 `{ customType: "knit.run-ended", content, display: true }`，`options` 是 `{ deliverAs: "followUp", triggerTurn: true }`
- AND `content` 是 `Knit 的执行结束了：` 一行加这时候运行 `knit run status <id>` 的标准输出（去掉结尾的空白）

#### Scenario: 自己取消的不通知

- GIVEN 同上，假 Pi 一直等一个不存在的文件
- WHEN 调用 `start`，再调用 `cancel`
- THEN `cancel` 返回之后再等 2.5 秒，`messages` 还是空的
- AND 没有留下 `knit run wait` 的进程

#### Scenario: 会话结束之后不再等

- GIVEN 同上，假 Pi 在等一个还不存在的文件
- WHEN 调用 `start`，触发 `session_shutdown`，再建出那个文件让执行结束
- THEN 执行结束之后再等 2.5 秒，`messages` 还是空的
- AND 没有留下 `knit run wait` 的进程

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/research/pi-extension-api.md` — Pi 的扩展接口：工具、事件、会话记录、发消息
- `.knit/tasks/11-14-slim-refactor/design.md#9-命令与工具` — 执行结束的通知怎么做
- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 派发后工具立即返回，结束时桥接通知主会话
- `next/assets/templates/pi/extensions/knit.ts` — 要改的文件
- `next/src/cli/run.ts` — `run wait` 的行为
- `next/test/bridge-run.test.mjs` — 项目和假 Pi 的做法
- `next/test/helpers/bridge.mjs` — `loadBridge`：`fire`、`messages`
- `next/test/helpers/fake-pi.mjs` — 假的 Pi
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
