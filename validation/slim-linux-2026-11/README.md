# 在 Linux 上跑测试（2026-11-19，任务 k-6dadc77b2d18）

新 Knit 的测试原来只在 macOS 上跑过。这里是在一台 Linux 机器上把测试跑一遍的记录。测试用假的 Pi 和假的 `rex`，不调用模型。

## 环境

| 项目 | 值 |
| --- | --- |
| 发行版 | Oracle Linux Server 9.8（`/etc/os-release`） |
| 内核 | `6.12.0-208.112.5.el9uek.aarch64` |
| CPU 架构 | aarch64 |
| Node | v26.3.0 |
| npm | 11.16.0 |
| Git | 2.52.0 |
| 仓库的提交 | `d163f18` |
| 是不是在容器里 | 不是。KVM 虚拟机（`systemd-detect-virt` 输出 `kvm`，`systemd-detect-virt -c` 输出 `none`） |

开始之前 `git status --short` 没有输出。

## 结果

在仓库根目录按顺序运行，每条命令的完整输出在 `logs/` 下。

| 步 | 命令 | 退出码 | 关键数字 | 日志 |
| --- | --- | --- | --- | --- |
| 1 | `npm ci --include=dev` | 0 | 装了 6 个包 | `logs/npm-ci.log` |
| 2 | `npm run typecheck` | 0 | — | `logs/typecheck.log` |
| 3 | `npm test` | 0 | `tests 230`、`pass 230`、`fail 0` | `logs/npm-test.log` |
| 4 | `node --test validation/slim-h5-2026-11/broken-run-files.test.mjs` | 0 | `tests 6`、`pass 6`、`fail 0` | `logs/broken-run-files.log` |
| 5 | `npm run pack:check` | 0 | 13 项 `PASS`，最后一行「pack 检查通过」 | `logs/pack-check.log` |
| 6 | `pgrep -fl 'fake-pi\|knit.js run (worker\|wait)'` | 1（没有找到进程） | 没有输出 | `logs/leftover.log` |

第 6 步做了两次。第一次把六步写在一个脚本里用 `bash` 运行，`pgrep` 输出了一行 `2735515 bash`（`logs/leftover-first-attempt.log`）。那时没有记下这个进程的命令行，它是谁没有核实；之后直接在命令行里运行同一条 `pgrep`，找到的是运行这条命令的 shell 自己，它的命令行里带着要找的字样。第二次把 `pgrep` 单独放进一个脚本文件再运行，没有输出，退出码 1，`logs/leftover.log` 里是这一次的结果。

## 失败的测试

没有。

这次运行之前，同一台机器上 `npm test` 有过一个失败：`test/task-cancel.test.mjs` 的「已经结束的任务不能取消，文件和目录都不变」调用了外部命令 `shasum`，这台机器上没有。已经改成用 Node 自带的模块（任务 `k-4b534dded53d`，提交 `af3c69a`），上面的结果是改过之后的。

## 没有验证的

- 真的 Pi 和模型：这些测试用假的 Pi，不调用模型。用真的 Pi 和模型的全流程演练见下面「用真的 Pi 和模型演练」一节。
- Rex：测试用假的 `rex`。这台机器上有 `rex` 命令，但没有用真的 Rex 窗格跑过执行者。
- Node 的其它版本：只跑了 v26.3.0。`package.json` 要求的是 24 或更高。
- 别的发行版和 x86_64：只跑了这一台。
- 只跑了一次，没有重复跑来看有没有偶尔失败的测试。

## 用真的 Pi 和模型演练

2026-11-19，任务 `k-6b6f6c9d8aaa`。把 `validation/slim-h1-2026-11/` 里的五个演练脚本在同一台机器上跑了一遍：真的 Pi，真的模型，从创建任务走到交付。每个脚本核对什么见那里的 `README.md`。

| 项目 | 值 |
| --- | --- |
| Pi | 1.5.2 |
| 模型 | `magpie/group/deepseek`（和 macOS 那次一样） |
| 仓库的提交 | `72866e1` |
| 用的 `knit` | 本仓库的 `dist/`（`npm ci --include=dev && npm run -s build` 之后） |
| 日志 | `h1-logs/` |

五个脚本各跑了一次，都以退出码 0 结束，没有重跑：

| 脚本 | 退出码 | 用时 | 输出 |
| --- | --- | --- | --- |
| `./refusals.sh` | 0 | 5.2 秒 | `h1-logs/refusals.log` |
| `node trust.mjs` | 0 | 1.7 秒 | `h1-logs/trust.log` |
| `./cli-flow.sh` | 0 | 36.7 秒 | `h1-logs/cli-flow.log` |
| `./cancel.sh` | 0 | 5.6 秒 | `h1-logs/cancel.log` |
| `node bridge-flow.mjs` | 0 | 64.4 秒 | `h1-logs/bridge-flow.log` |

跑完之后 `pgrep -fl 'sleep 613|knit.js run (worker|wait)'` 没有输出，退出码 1（放在脚本文件里运行的；直接在命令行里运行会匹配到运行它的 shell 自己，见上面第 6 步）。`git status --short validation/slim-h1-2026-11` 没有输出，macOS 的证据没有动。

### 和任务写的步骤不一样的地方

运行脚本之前去掉了环境变量 `REX_SESSION` 和 `REX_BLOCK`。跑演练的这个会话的环境里留着这两个变量，指着一个已经不存在的 Rex 会话；留着的话每次派发都会先试着开窗格、失败之后再回退到后台执行。去掉之后演练走的是没有 Rex 的后台执行，和 macOS 那次一样（两边「模型不存在」那次的 `worker.log` 都是 0 字节）。

### 和 macOS 那次不一样的地方

把两边的 `refusals.log`、`trust.log`、`cli-flow.log`、`cancel.log` 去掉任务 id、执行 id、提交号、日期和用时之后逐行比过，`bridge-flow.log` 比的是「符合」那几行。核对的结果都一样，不一样的只有下面这些：

- 派发成功时第二行是 `会话记录：…/session/`，macOS 那次是 `日志：…/worker.log`。`task.md` 写坏了时 `knit run start` 说的是 `task.md：字段 priority 的值不对：…`，macOS 那次是 `没有任务 <id>`。这两处是那次演练之后代码改过，和平台无关。
- 取消演练里，Knit 后台进程的父进程是 `systemd --user`（进程号 2504），macOS 上是 1。三个进程（后台进程、它启动的 Pi、`sleep 613`）的父子关系一样，取消之后都不在了。
- 用时：

  | | Linux | macOS |
  | --- | --- | --- |
  | 命令行流程：实现、审查 | 14.3 秒、20.1 秒 | 14.5 秒、19.4 秒 |
  | 桥接流程：实现、审查 | 8.7 秒、10.5 秒 | 14.0 秒、9.9 秒 |
  | 桥接流程：派发之后到主会话停下来 | 25.1 秒 | 32.2 秒 |
  | 取消：派发到执行者开始 `sleep 613` | 4.2 秒 | 3.5 秒 |
  | 取消：`knit run cancel` | 0.3 秒 | 0.4 秒 |

### 日志里有什么

提交之前看过 `h1-logs/`：没有搜到密钥和令牌的样子（`api key`、`token`、`bearer`、`sk-`、JWT、私钥头）。这台机器的用户主目录下没有 `AGENTS.md`，主会话启动时也带着 `--no-context-files`。没有删文件。

里面有的本机内容和 macOS 那份证据是同一类：模型服务的本地地址 `http://127.0.0.1:3425/v1`（在 `bridge/events.jsonl`、`bridge/session.jsonl` 的模型信息里），和 `/home/opc` 开头的路径（Pi 的安装位置、本仓库的位置）。

### 没有验证的

- 每个脚本只跑了一次。模型的回答每次不一样，一次通过不说明每次都通过。
- 演练里没有走 Rex：真的 Rex 窗格没有试，「窗格开不了、回退到后台」这条路也不在这次演练里。同一天在这台机器上用安装版的 Knit 派发过五次执行者，`worker.log` 里都是「Rex 窗格用不了（…session_not_found…），改在后台执行」，之后都正常结束；那是做别的任务时出现的，不是按演练核对的。
- 别的模型、Pi 的其它版本、别的发行版和 x86_64。
