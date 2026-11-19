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

- 真的 Pi 和模型：这些测试用假的 Pi，不调用模型。从创建任务到交付的全流程演练留给 L3。同一天在这台机器上用安装版的 Knit 派发过四次执行者（真的 Pi，模型 `magpie/group/deepseek`；三次实现、一次审查，任务 `k-b907eafe1bf4`、`k-7a206502394e`、`k-7c9ba52b575b`），都正常结束，Rex 窗格开不了、回退到后台执行，但那是做别的任务时顺带用到的，没有按演练的清单逐项看。
- Rex：测试用假的 `rex`。这台机器上有 `rex` 命令，但没有用真的 Rex 窗格跑过执行者。
- Node 的其它版本：只跑了 v26.3.0。`package.json` 要求的是 24 或更高。
- 别的发行版和 x86_64：只跑了这一台。
- 只跑了一次，没有重复跑来看有没有偶尔失败的测试。
