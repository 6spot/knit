---
id: k-6b6f6c9d8aaa
title: L3 在 Linux 上用真的 Pi 和模型跑全流程演练
status: draft
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn:
  - k-6dadc77b2d18
  - k-d8b5009c9981
priority: P2
createdAt: 2026-11-18T16:55:56.049Z
---

## 目标与范围

新 Knit 用真的 Pi 和真的模型从创建任务走到交付，只在 macOS 上演练过（2026-11-17，`validation/slim-h1-2026-11/`）。本任务在 Linux 上把同一套演练跑一遍，把结果记下来。

本任务会调用真的模型。用户 2026-11-19 同意，模型和 macOS 那次一样：`magpie/group/deepseek`（`user:4eb94f6e`）。

前置条件（不满足就停下报告）：

- `uname -s` 输出 `Linux`；L1 已经做完，`validation/slim-linux-2026-11/README.md` 存在。
- L2 已经做完：演练脚本认 `KNIT_H1_MODEL` 和 `KNIT_H1_LOGS`。
- 本机有 Pi（`pi --version`），里面配好了 `magpie` 这个 provider，`group/deepseek` 可以用。没有配时停下报告，不换成别的模型。
- 有 `python3`（`cancel.sh` 用它计时）、`pgrep`、`pkill`。
- `git status --short` 没有输出。

步骤（在仓库根目录）：

1. `npm ci --include=dev && npm run -s build`。演练进行时不要再运行 `npm test`：它会重建 `dist/`，而演练用的 `knit` 就是 `dist/`。
2. 设环境变量，日志写到新目录，不碰 macOS 的证据：

   ```bash
   export KNIT_H1_MODEL=magpie/group/deepseek
   export KNIT_H1_LOGS="$PWD/validation/slim-linux-2026-11/h1-logs"
   mkdir -p "$KNIT_H1_LOGS"
   cd validation/slim-h1-2026-11
   ```

3. 依次运行，每个脚本的输出用 `2>&1 | tee "$KNIT_H1_LOGS/<名字>.log"` 存下来，并记下退出码（`${PIPESTATUS[0]}`）：`./refusals.sh`、`node trust.mjs`、`./cli-flow.sh`、`./cancel.sh`、`node bridge-flow.mjs`。
4. 有脚本失败时：不改脚本，不改代码。原样再跑一次；两次都失败就停下，把两次的输出都留着。同一个脚本不跑第三次。
5. 提交之前看一遍 `h1-logs/` 里有没有不该进仓库的内容：密钥、令牌、用户主目录下 `AGENTS.md` 的全文。有就删掉那个文件，在记录里写明删了什么。
6. 在 `validation/slim-linux-2026-11/README.md` 末尾加一节「用真的 Pi 和模型演练」：Pi 的版本、用的模型、五个脚本各自的退出码和用时、和 macOS 那次不一样的地方、没有验证的。

不能动的：

- `validation/slim-h1-2026-11/` 下的任何文件，包括 `logs/`。
- `src/`、`test/`。
- 不安装全局的 `knit`，不提交、不推送。

## 完成条件

- `validation/slim-linux-2026-11/h1-logs/` 下有 `refusals.log`、`trust.log`、`cli-flow.log`、`cancel.log`、`bridge-flow.log`。
- `validation/slim-linux-2026-11/README.md` 有「用真的 Pi 和模型演练」一节，五个脚本都有退出码。
- `git status --short validation/slim-h1-2026-11` 没有输出。
- 演练没有留下进程：`pgrep -fl 'sleep 613|knit.js run (worker|wait)'` 没有输出。

脚本有失败不算本任务没完成：如实记下来就算完成，「结果」里写清哪个脚本失败、失败在哪一条核对上。

## 待澄清

无。

## 相关资料

- `validation/slim-h1-2026-11/README.md` — 每个脚本核对什么、macOS 上的结果
- `validation/slim-linux-2026-11/README.md` — 要接着写的记录

交付：`--paths validation/slim-linux-2026-11`。提交文案首行建议 `test: record the Linux rehearsal with a real model`。
