# Worktree：用真实的 Pi 和模型演练并行、依赖和取消（2026-11-21）

W1 到 W9 做完之后，每个任务在自己的 Worktree 里执行，可以同时跑多个。自动测试里的并行、依赖和取消用的是假 Pi 和临时仓库；这里用真实的 Pi 和模型把这三件事各走一遍（任务 `k-0aff458174d6`）。

环境：macOS 27.2.1，Knit 0.1.0（安装版，`main` 在 `215593a` 时打的包），`pi --version` 输出 1.6.0，Node 26.3.0，Git 2.54.0。执行者的模型是 `magpie/group/deepseek`，派发时用 `--model` 指定；六次执行里核对了五次的会话记录（甲、乙和本仓库的三次），`provider` 都是 `magpie`、`modelId` 都是 `group/deepseek`；丙那一次同样用 `--model` 派发，会话记录在临时仓库删掉之前没有看。主会话在 Rex 里，本仓库那三次执行在 Rex 的浮动窗格里跑（`knit run status` 有「窗格」一行）；临时仓库那三次是在窗格里还是在后台跑的没有记下来。

命令是主会话一条条运行的，没有脚本。每一步的命令和原样输出在 `logs/` 下，按编号对应下面的步骤。

## 结果

三个场景都和预期一致，没有发现 Knit 的问题。

### 场景一：两个任务同时执行，各自交付并自动合并（临时仓库）

临时仓库用 `mktemp -d` 建，`git init`、提交一次、运行 `knit init`；`.knit/config.json` 打开 `worktree.autoMerge`（`logs/temp-repo-config.json`），没有配准备命令；`KNIT_HOME` 指到另一个临时目录。任务甲加 `src/greet.mjs`，任务乙加 `NOTES.md`，验证方式都是 `self`。

| 看的是什么 | 结果 | 日志 |
| --- | --- | --- |
| 甲在跑时派发乙 | 两次派发都成功，退出码 0，前后不到 1 秒；`git worktree list` 里是主检出加两个 Worktree，各在自己的分支上；两个 `knit run worker` 进程同时在 | `01-parallel-start.log`、`02-parallel-wait.log` |
| 各自结束 | 甲 13.6 秒、乙 9.9 秒，都正常结束；执行时间重叠（甲 23:48:15.745–29.371，乙 23:48:15.979–25.914，UTC）；甲只记了 `src/greet.mjs`，乙只记了 `NOTES.md`，两个 Worktree 里也各只有自己的那个文件 | `03-parallel-result.log` |
| 交付甲 | 预览列出目标分支 `main` 和要删的 Worktree、分支；交付输出「已合并 knit/11-21-drill-a → main」「已删除 Worktree」「已删除分支」；快进合并 | `05-deliver-a-b.log` |
| 交付乙 | 同样三行；这时 `main` 已经往前走了，合并落成一个合并提交 `Merge branch 'knit/11-21-drill-b'` | `05-deliver-a-b.log` |
| 交付之后 | `git worktree list` 只剩主检出，没有 `knit/*` 分支，`git status --short` 是空的；主分支上有 `src/greet.mjs` 和 `NOTES.md`；两个任务都是 `delivered` | `05-deliver-a-b.log` |

### 场景二：依赖的任务没交付时拒绝，交付并合并之后放行（临时仓库）

任务丙依赖任务甲，要用甲加的 `greet` 写 `hello.mjs`。

| 看的是什么 | 结果 | 日志 |
| --- | --- | --- |
| 甲是 `done`、还没交付时派发丙 | 拒绝，退出码 1：`依赖的任务还没有交付：k-b876ece446b2（done）；交付并合并之后再派发`；`git worktree list` 和 `knit/*` 分支前后一样，丙的执行记录是空的，没有新的执行目录 | `04-dependency-refused.log` |
| 甲交付并自动合并之后派发丙 | 派发成功；派发刚返回时丙的 Worktree 里就有 `src/greet.mjs`，Worktree 的 `HEAD` 是主分支当时的合并提交 | `06-dependency-allowed.log` |
| 丙做完 | 正常结束（用时没有记），只加了 `hello.mjs`（从 `./src/greet.mjs` 导入），没有改 `src/greet.mjs`；`node hello.mjs` 输出 `你好，Knit` | `06-dependency-allowed.log` |
| 交付丙 | 自动合并、删除 Worktree 和分支；之后主检出里 `node hello.mjs` 输出 `你好，Knit`，`git worktree list` 只剩主检出，临时的 `KNIT_HOME` 下没有剩下的 Worktree 目录 | `07-deliver-c.log` |

### 场景三：几个任务同时跑，各通知一次，取消后不留东西（本仓库）

在本仓库用主会话的 Knit 工具做，只派发和取消，不交付。建了三个演练任务，不是原定的两个：经主会话的工具取消一次执行时，等通知的那个进程会先被停掉，被取消的任务不发通知；要同时看到「各通知一次」和「中途取消一个」，得有两个正常结束的和一个被取消的。三个任务分别是：快的（加一个文件）、中的（先 `sleep 120` 再加文件）、慢的（先 `sleep 600` 再加文件）。

| 看的是什么 | 结果 | 日志 |
| --- | --- | --- |
| 三个任务派发 | 主会话在同一轮里连着调用三次工具，都成功，各输出「已运行准备命令：1 条」（本仓库配了 `npm ci`）；三次执行的开始时间相差不到 0.1 秒；`git worktree list` 里是主检出加三个 Worktree | `08-local-three-running.log` |
| 同时在跑 | 快的 8.8 秒做完；这时中的和慢的还在跑，各有一个 `knit run worker` 和一个等通知的 `knit run wait` | `08-local-three-running.log` |
| 中途取消慢的那次执行 | 输出「已取消 k-f9efc24c3ec9 的执行 r-116a61a96372」；记为「失败: 已取消」，改动 0 个；它的 `knit run worker` 和等通知的 `knit run wait` 都不在了，`pgrep` 找不到 `sleep 600`，窗格里的 Pi 进程（`pane.json` 记的进程号）事后看也不在了 | `09-local-after-run-cancel.log` |
| 中的不受影响 | 取消之后中的还是「正在跑」，它的两个进程还在；131 秒后正常结束，只记了 `drill-mid.txt`；执行者的报告里 `sleep 120` 从 07:53:09 到 07:55:09，没有缩短 | `09-local-after-run-cancel.log`、`11-local-second-notice.log`、`logs/report-r-706a222302bc.md` |
| 结束通知 | 主会话一共收到两条：先是快的（`k-040659ece34f`／`r-dba282988a57`），再是中的（`k-f32e4c7b737f`／`r-706a222302bc`），各一条，没有重复；被取消的那个没有通知 | `10-local-first-notice.log`、`11-local-second-notice.log` |
| 取消三个任务 | 每个都输出「已删除 Worktree: <位置>」「已删除分支: <分支>」；快的和中的还多一行「已丢弃未提交的改动（1 个文件）」，慢的没有改动、没有这一行；退出码都是 0 | `12-local-task-cancel.log` |
| 之后 | `git worktree list` 只有主检出，没有 `knit/*` 分支，`~/.knit/worktrees/knit-058bcf1b/` 是空的；`main` 的 `HEAD` 还是 `215593a`；没有残留的 Knit、Pi 或 `sleep` 进程 | `12-local-task-cancel.log` |

第一条通知是在主会话那一轮回复结束之后才送到的：快的任务 23:53:13（UTC）就结束了，主会话当时正在连着调用工具（看状态、取消慢的那次执行），通知等这一轮结束才出现。这是通知的设计（智能体正在做事时等这一轮做完再送到），不是延迟的缺陷；要早点知道某个任务结束了，用 `knit_run` 的 `status`。

## 发现的问题

没有发现 Knit 的问题。演练过程中自己写错的地方：

- 第一次取消临时仓库里 `knit init` 生成的初始化任务时漏了 `--reason`，命令报 `required option '--reason <原因>' not specified`，补上之后重做。
- 主会话的一段改任务正文的脚本第一处断言没通过，整段没有执行，接着运行的 `knit_task ready` 确认的是没改的正文；改好脚本之后重新确认。派发是在重新确认之后做的。

## 收尾

- 临时仓库 `/private/tmp/knit-drill-repo-yCRh3P` 和临时的 `KNIT_HOME` `/private/tmp/knit-drill-home-aefdPa` 已删除。
- 本仓库三个演练任务取消之后留在 `.knit/tasks/archive/2026-11/` 下的目录已删除（没有入过库）。它们的运行资料在被 Git 忽略的 `.knit/.runtime/runs/` 下，没有动。
- 五份执行者的报告留在 `logs/report-*.md`（被取消的那次没有报告）：临时仓库的甲 `r-49884dae4444`、乙 `r-dc8bb4207e64`、丙 `r-9ac7b6e16fb8`，本仓库的快 `r-dba282988a57`、中 `r-706a222302bc`。

## 没有验证的事

- 合并冲突：这次没有演练。它只是交付时的 Git 操作，用真实 Git 的自动测试覆盖过；在本仓库里真的发生一次冲突仍然没有试过。
- 带独立审查的任务同时跑多个：演练任务都是 `self`，只有实现一个环节。单个任务的实现加独立审查在本仓库走过很多次（W5 到 W9）。
- 依赖的任务已经交付、但任务分支还没合并时的拒绝提示（关着 `autoMerge` 才会遇到）：这次开着 `autoMerge`，只走了「还没交付」这一种拒绝。
- 同时跑的任务多于三个；两个任务改同一个文件。
- 不在 Rex 里的主会话收通知。临时仓库里的执行是用 `knit` 命令派发、用 `knit run wait` 等的，没有经过主会话的工具。
- Linux、Windows。
