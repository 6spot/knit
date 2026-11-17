---
id: k-f188e4cfb0a1
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-cca21fa02b23
order: null
createdAt: 2026-11-16T15:19:35.557Z
title: G9 knit run wait：等任务正在跑的执行结束
---

# G9 knit run wait：等任务正在跑的执行结束

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。`knit run start` 派发之后立即返回，执行者在后台做。要知道它什么时候做完，现在只能反复运行 `knit run status`。本任务加一条命令，一直等到执行结束再返回。桥接在下一个任务里用它在执行结束时通知主会话。

做完之后的不同：`knit run wait <任务>` 等这个任务正在跑的执行结束，然后输出和 `knit run status` 一样的内容。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/cli/run.ts`（修改） | 加命令 `knit run wait <id>`，选项 `--dir <目录>` |
| `next/test/run-wait.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`knit run wait <id>`：

1. 读任务和流程，读不出来时和 `knit run status` 一样报错，退出码 1。
2. 任务有一次执行还没结束（记录里 `endedAt` 是 `null`），并且它的后台进程还在（`liveWorker`）：等 1 秒，从第 1 步重新来。每次都重新读任务文件。
3. 否则输出 `statusLines` 的结果（和 `knit run status <id>` 相同），退出码 0。这包括三种情况：没有执行在跑；等到了执行结束；执行没有结束但后台进程已经不在了（输出里会有那一行让人运行 `knit run cancel` 的提示）。

不设超时：执行者卡住时它一直等，要停就停掉这个命令或者 `knit run cancel`。等的写法照 `run.ts` 里 `stillAlive` 的样子（异步函数调用自己），不写循环语句。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function statusLines" next/src/cli/run.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `cli/run.ts`。
4. 写测试。要一次正在跑的执行时照 `next/test/run-start.test.mjs` 的做法用假 Pi 派发，假 Pi 的 `waitFor` 指向一个还不存在的文件，建出这个文件它就结束；`knit run wait` 用 `spawn` 在后台运行，收集它的输出和退出码。要一次没有结束、后台进程也不在的执行时，照 `next/test/run-status.test.mjs` 的做法只调用 `prepareRun`。测试结束时不能留下后台进程。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- `pgrep -f fake-pi`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add knit run wait`。

## 完成条件

### Requirement: 等到执行结束

#### Scenario: 等到正在跑的执行结束

- GIVEN 临时仓库里一个已经派发的任务，假 Pi 在等一个还不存在的文件
- WHEN 在后台运行 `knit run wait <id>`，过 1.5 秒再建出那个文件
- THEN 建出文件之前 `knit run wait` 没有退出、没有输出
- AND 之后它以退出码 0 退出，标准输出和这时候运行 `knit run status <id>` 的相同，里面有 `上一次: 实现`

#### Scenario: 没有执行在跑时立即返回

- GIVEN 临时仓库里一个已经确认、还没有派发过的任务
- WHEN 运行 `knit run wait <id>`
- THEN 退出码是 0，标准输出和 `knit run status <id>` 的相同
- AND 对一个不存在的任务运行：退出码是 1，标准错误和 `knit run status` 对不存在的任务报的相同

#### Scenario: 后台进程不在了也返回

- GIVEN 临时仓库里一个任务，记录里有一次没有结束的执行，但没有后台进程
- WHEN 运行 `knit run wait <id>`
- THEN 它在 5 秒内以退出码 0 退出，标准输出和 `knit run status <id>` 的相同，里面有 `knit run cancel` 的提示

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 执行者在后台跑；进程意外退出时怎么办
- `.knit/tasks/11-14-slim-refactor/design.md#9-命令与工具` — `knit run wait` 给执行结束的通知用
- `next/src/cli/run.ts` — 要改的文件：`statusLines`、`stillAlive`
- `next/src/application/run-process.ts` — `liveWorker`
- `next/test/run-start.test.mjs` — 用假 Pi 派发的例子
- `next/test/run-status.test.mjs` — 没有后台进程的执行的做法
- `next/test/helpers/fake-pi.mjs` — 假的 Pi：`waitFor`
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-fed6d590bbc4 -->
- 操作: op-fed6d590bbc4
- 时间: 2026-11-17T01:02:15.874Z
- 分支: refs/heads/main
- 授权来源: user:a743f72d
- 调用: bridge
- 工作提交: 562ae83f46f43bb9b91d62da6bd3ca9fc6965429
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-16-g9-run-wait

<!-- knit:progress:end -->
