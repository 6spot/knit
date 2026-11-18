---
id: k-d8b5009c9981
title: L2 演练脚本能在 Linux 上跑，模型和日志目录可以指定
status: draft
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
