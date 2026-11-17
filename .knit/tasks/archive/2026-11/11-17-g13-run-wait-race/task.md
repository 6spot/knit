---
id: k-7771ab41bbc4
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-17T03:00:57.590Z
title: G13 knit run wait：执行正好在两步检查之间结束时输出实际结果
---

# G13 knit run wait：执行正好在两步检查之间结束时输出实际结果

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。`knit run wait <任务>`（G9）等任务正在跑的执行结束，再输出和 `knit run status` 一样的内容；桥接用它在执行结束时通知主会话（G10）。

它每一轮做两步：先读任务记录，看有没有还没结束的执行；再看这次执行的后台进程在不在（`liveWorker`，读执行目录里的 `worker.json`）。后台进程是先把结果写进任务记录、再退出的。执行正好在这两步之间正常结束时，第一步读到的是“还没结束”，第二步看到的是“进程不在了”，它就输出：

```
执行 <执行> 的进程已经不在了，没有正常结束；运行 knit run cancel <任务> 记为失败
```

实际上这次执行是正常结束的，主会话收到的结束通知也就是错的。2026-11-17 全量测试在机器负载高时出现过一次（`next/test/bridge-notice.test.mjs`「结束时发一条消息」）。

做完之后的不同：执行在这两步之间结束时，`knit run wait` 输出它实际的结果。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/cli/run.ts`（修改） | `waitForRun`：有一次没结束的执行、而它的后台进程不在了时，重新读一次任务，用重新读到的内容输出 |
| `next/test/run-wait.test.mjs`（修改） | 加一个测试，见「完成条件」；原有的三个测试不改 |

改法的依据：后台进程不在了以后，不会再有人替它改这次执行的记录，所以这时重新读到的就是最后的样子。执行正常结束的，记录里已经有结束时间，输出是它的结果。后台进程意外退出的，记录里仍然没有结束时间，输出里仍然是让人运行 `knit run cancel` 的那一行（G9 的场景「后台进程不在了也返回」，不能变）。重新读不出任务时和第一步一样报错、返回。

不做的：`knit run status` 和 `knit context` 也是先读记录再看进程，同样会在这个时间差里输出那一行。它们只查一次，再运行一次就是对的，本任务不改。

测试怎么让执行正好在两步之间结束（不靠时间碰运气）：

1. 照本文件里「等到正在跑的执行结束」的做法派发：假 Pi 的 `waitFor` 指向一个还不存在的文件。
2. 读出这次执行的 `.knit/.runtime/runs/<执行>/worker.json` 的内容，删掉它，在同一个路径上用 `mkfifo` 建一个命名管道。
3. 在后台运行 `knit run wait`。它读完任务记录之后去读 `worker.json`，会停在管道上。
4. 测试以只写方式打开这个管道（`fs/promises` 的 `open`，标志 `O_WRONLY`）。只写方式打开会一直等到有人来读，所以它返回就说明 `knit run wait` 已经停在第二步上了。
5. 把这个路径换回普通文件（删掉管道，写回原来的内容）：`knit run wait` 手里那个已经打开的管道不受影响，之后别的读取不会再停住。
6. 建出假 Pi 等的那个文件，等任务记录里这次执行有了结束时间、命令行里带这次执行 id 的进程都退出。
7. 往管道里写原来的内容并关闭，`knit run wait` 接着往下走。

第 4 步要有退路：20 秒之内没有打开成功，就用读写方式（`"r+"`）打开一次管道让那次等待返回，然后报失败，免得测试进程退不出去。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：macOS 或 Linux（测试用 `mkfifo` 和 `pgrep`）；运行 `npm run test:next` 能通过；`grep -n "async function waitForRun" next/src/cli/run.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 先写测试，运行 `npm run test:next`：新测试应当失败，输出里是“进程已经不在了”那一行。没有失败说明测试没有停在那两步之间，先改测试。
4. 改 `cli/run.ts`。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`，测试数比开始前多 1。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- `pgrep -f fake-pi`、`pgrep -f "run wait"`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `fix(next): report the real result when a run ends during knit run wait`。

## 完成条件

### Requirement: 输出执行实际的结果

#### Scenario: 执行在读完记录之后、看后台进程之前正常结束

- GIVEN 临时仓库里一个已经派发的任务，假 Pi 在等一个还不存在的文件，这次执行的 `worker.json` 换成了一个命名管道
- WHEN 在后台运行 `knit run wait <id>`，等它停在读 `worker.json` 上，这时让执行正常结束、后台进程退出，再把原来的内容写进管道
- THEN 写进管道之前 `knit run wait` 没有退出、没有输出
- AND 之后它以退出码 0 退出，标准输出和这时候运行 `knit run status <id>` 的相同，里面有 `结果: 正常结束`

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 执行者在后台跑；进程意外退出时怎么办
- `next/src/cli/run.ts` — 要改的文件：`waitForRun`、`statusLines`、`runLines`
- `next/src/application/run-process.ts` — `liveWorker`：读 `worker.json`
- `next/src/application/run-finish.ts` — 后台进程结束一次执行时怎么写记录
- `next/test/run-wait.test.mjs` — 要改的测试文件：现有的三个测试和它们的写法
- `next/test/helpers/fake-pi.mjs` — 假的 Pi：`waitFor`
- `next/test/helpers/run.mjs` — `runProject`、`readyTask`
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-310d46e1f29a -->
- 操作: op-310d46e1f29a
- 时间: 2026-11-17T03:20:59.242Z
- 分支: refs/heads/main
- 授权来源: user:sha256:e5e86877f5858942
- 调用: bridge
- 工作提交: d8d73f7b70eba0a7c5a619b8a6333723758cbca8
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-17-g13-run-wait-race

### 任务资料提交记录

<!-- knit:metadata-commit:op-310d46e1f29a -->
- 任务资料提交: 133bfc241a52cdef7bbdb2d03438060e48305b48
- 归档目标: .knit/tasks/archive/2026-11/11-17-g13-run-wait-race

<!-- knit:progress:end -->
