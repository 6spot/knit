---
id: k-d8b5009c9981
title: L2 演练脚本能在 Linux 上跑，模型和日志目录可以指定
status: delivered
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn: []
priority: P2
createdAt: 2026-11-18T16:55:55.920Z
---

## 目标与范围

`validation/slim-h1-2026-11/` 里的演练脚本（公用的 `setup.sh`、`rpc.mjs`，和五个演练 `refusals.sh`、`trust.mjs`、`cli-flow.sh`、`cancel.sh`、`bridge-flow.mjs`）是在 macOS 上写的，有三处让它们不能直接拿到别的机器上跑：

1. `sed -i ''` 是 macOS 的写法，Linux 的 `sed` 不认（`setup.sh` 1 处、`refusals.sh` 7 处）。
2. 模型写死成 `magpie/group/deepseek`（`setup.sh`、`refusals.sh`、`bridge-flow.mjs`、`trust.mjs`）。
3. 日志写进脚本旁边的 `logs/`（`cli-flow.sh`、`bridge-flow.mjs`、`trust.mjs`）。那里是 2026-11-17 在 macOS 上演练的证据，在别的机器上重跑会把它盖掉。

本任务改掉这三处，不设环境变量时脚本的行为和现在一样。

怎么改：

- `sed -i ''` 换成两种 `sed` 都认的写法：`sed -i.bak '…' 文件 && rm 文件.bak`。
- 模型从环境变量 `KNIT_H1_MODEL` 取，写成 `provider/模型`，不设时是 `magpie/group/deepseek`。`bridge-flow.mjs` 和 `trust.mjs` 里 Pi 的参数 `--provider`、`--model` 从它拆出来（第一个 `/` 之前是 provider）。`refusals.sh` 里「模型不存在」那一种，用同一个 provider 加 `no-such-model`。
- 日志目录从环境变量 `KNIT_H1_LOGS` 取，不设时是脚本旁边的 `logs`。
- `README.md` 的「怎么重跑」一段加上这两个变量的说明，别的段落不改。

不能动的：

- `validation/slim-h1-2026-11/logs/` 下的文件：那是证据。验证时一律设 `KNIT_H1_LOGS` 指到临时目录。
- 脚本核对的内容（每个 `fail "…"` 和 `check(…)`）：只改上面三处，不加也不减核对。
- `src/`、`test/`。
- 不提交、不推送。

验证时不调用模型：只跑 `refusals.sh` 和 `trust.mjs`（它们会启动本机的 Pi，但不开始模型轮次）。`cli-flow.sh`、`cancel.sh`、`bridge-flow.mjs` 要调用真的模型，本任务不跑，留给 L3。

前置条件：本机有 Pi（`pi --version` 有输出），并且 Pi 里有 `KNIT_H1_MODEL` 那个 provider。没有时停下报告。

## 完成条件

- `grep -c "sed -i ''" validation/slim-h1-2026-11/*.sh` 每个文件都是 `0`。
- 脚本和 `.mjs` 里写死的模型只剩缺省值：`grep -n 'magpie' validation/slim-h1-2026-11/*.sh validation/slim-h1-2026-11/*.mjs` 的每一行都是给 `KNIT_H1_MODEL` 设缺省值的那一行。
- 先 `npm run -s build`，再运行下面的命令，两个脚本都以退出码 0 结束，日志写在临时目录里：

  ```bash
  cd validation/slim-h1-2026-11
  export KNIT_H1_LOGS="$(mktemp -d)"
  ./refusals.sh && node trust.mjs && ls "$KNIT_H1_LOGS"
  ```

- 证据没有被动过：`git status --short validation/slim-h1-2026-11/logs` 没有输出。
- 没有运行的三个脚本用 `bash -n cli-flow.sh cancel.sh` 和 `node --check bridge-flow.mjs` 查过语法，都以退出码 0 返回。「结果」里写明这三个没有真的跑。

## 待澄清

无。

## 相关资料

- `validation/slim-h1-2026-11/README.md` — 每个脚本核对什么、原来怎么重跑

交付：`--paths validation/slim-h1-2026-11`。提交文案首行建议 `test: let the rehearsal scripts take the model and log directory`。

## 结果

`validation/slim-h1-2026-11/` 的演练脚本改了三处：`sed -i ''` 换成 `sed -i.bak … && rm …bak`（`setup.sh` 1 处、`refusals.sh` 7 处）；模型从 `KNIT_H1_MODEL` 取，不设时是 `magpie/group/deepseek`；日志目录从 `KNIT_H1_LOGS` 取，不设时是脚本旁边的 `logs`。`README.md`「怎么重跑」一段加了这两个变量的说明。改了 6 个文件，由执行者（magpie/group/deepseek，执行 r-31071ce9c113）做，主会话对照差异核对过；各脚本里 `fail`、`check`、`refused` 的条数和改之前一样。

五条完成条件主会话都在 Linux（Oracle Linux 9.8，aarch64，Pi 1.5.2）上重新跑过，都满足：四个 `.sh` 里 `sed -i ''` 都是 0 处；`magpie` 只剩四行，都是给 `KNIT_H1_MODEL` 设缺省值的；`npm run -s build` 之后设了 `KNIT_H1_LOGS` 运行 `./refusals.sh` 和 `node trust.mjs`，退出码都是 0，九种拒绝和「模型不存在」都和预期一样，日志 `trust--approve.jsonl`、`trust--no-approve.jsonl` 写在临时目录里；`git status --short validation/slim-h1-2026-11/logs` 没有输出；`bash -n cli-flow.sh cancel.sh` 和 `node --check bridge-flow.mjs` 退出码都是 0。

没有验证的：`cli-flow.sh`、`cancel.sh`、`bridge-flow.mjs` 没有真的跑，只查了语法，留给 L3。`refusals.sh` 没有在 `KNIT_H1_MODEL` 设成别的模型时跑过（执行者只用 `magpie/group/claude` 跑过 `trust.mjs`）。macOS 上没有跑过改后的脚本。

执行者顺带看到、没有改的：README「发现的问题」里有两处和现在的表现对不上。`task.md` 写坏时 `knit run start` 现在直接说出哪个字段不对，不再是「没有任务」；「模型不存在」那次的 `worker.log` 有 213 字节（Rex 窗格开不了、改在后台执行的那一行），不是 0 字节。
