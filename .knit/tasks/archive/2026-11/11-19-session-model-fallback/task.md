---
id: k-6c41a06949e1
title: 不配置模型时用主会话的模型派发
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P1
createdAt: 2026-11-19T11:52:05.550Z
---

## 目标与范围

现在 `knit run start` 取模型的先后是 `--model`、环节的 `model`、顶层的 `model`，都没有就拒绝派发。用户决定（2026-11-19，`user:e02135d7`）：不配置模型不能报错，要用主会话当前的模型去启动执行者。

做完之后取值的先后是：`--model` → 环节的 → 顶层的 → 主会话当前的模型。只有四处都没有（不在 Pi 会话里，又哪里都没写）时才拒绝。

做法：

- 主会话的模型从环境变量 `PI_PROVIDER`、`PI_MODEL` 读，拼成 `provider/模型`。Pi 的 bash 工具会带上这两个变量，所以在 Pi 里手敲 `knit run start` 直接可用。
- 桥接（`assets/templates/pi/extensions/knit.ts`）是直接 `spawn` 的，拿不到这两个变量：`knit_run` 的 start 从 `ctx.model`（有 `provider` 和 `id`）取值，启动 `knit run start` 时放进子进程的这两个环境变量。只有一条读取路径，不另加命令行参数。
- 拒绝时的文案改成：`没有指定执行者的模型：不在 Pi 会话里时，在 .knit/workflow.yaml 里写 model，或加 --model provider/模型`。

跟着改的：

- `assets/templates/workflow.yaml` 开头的注释（“哪里都没写时派发会被拒绝”）。
- `knit workflow show` 没有模型时显示 `（没有指定，用主会话的模型）`。
- `knit init` 输出里“下一步：写上执行者的模型”那一行去掉。
- `README.md` 讲写 `model` 的那一步、`docs/design/DESIGN.md` 第 6.1 节和第 7 节里讲取值先后和派发前检查的地方。
- `validation/slim-h1-2026-11/refusals.sh` 的“流程里没有写模型”一项：运行时去掉 `PI_PROVIDER`、`PI_MODEL`，同目录 `README.md` 表里的文案跟着改；`logs/` 不重新生成。

注意：测试可能在 Pi 的 bash 里跑，环境里已经有 `PI_PROVIDER`、`PI_MODEL`。测“没有模型时拒绝”要去掉这两个变量，测“用主会话的模型”要自己设。

不在范围内：

- 不沿用主会话的思考级别，不处理虚拟模型。执行者用这个名字启动不了时，照现有的“执行者启动失败”报。
- 不改 `.knit/workflow.yaml`、`.knit/agents/`、`.pi/extensions/knit.ts` 这些副本，不改 `.knit/standards/`，不运行 `npm run pack:install`，不提交。

## 完成条件

- 流程里没写模型、环境里有 `PI_PROVIDER=p`、`PI_MODEL=m` 时，`knit run start` 派发成功，执行者用的是 `p/m`；`--model`、环节的、顶层的仍然优先于它。
- 流程里没写模型、环境里也没有这两个变量时，`knit run start` 以退出码 1 拒绝，输出是上面的新文案。
- 通过桥接调用 `knit_run` 的 start、`ctx.model` 是 `{ provider: "p", id: "m" }`、流程里没写模型时，派发成功，执行者用的是 `p/m`。
- 上面三条各有测试。`npm test` 全部通过，`npm run typecheck` 退出码 0，`npm run pack:check` 通过。

## 待澄清

无。

## 相关资料

- `src/application/run-prepare.ts` — 定下模型和拒绝派发的地方
- `src/cli/run.ts` — `knit run start`
- `assets/templates/pi/extensions/knit.ts` — 桥接的 `knit_run`
- `docs/design/DESIGN.md#6.1 流程` — 取值先后的现行说法

交付：提交文案首行建议 `feat: fall back to the session model when no model is configured`。做完之后剩下的由主会话做：用户同意后运行 `npm run pack:install` 并重新生成副本；改 `.knit/standards/pitfalls-main.md` 里“流程配置被覆盖”一条（`model` 不再需要写回）。

## 结果

派发时取模型的先后改成 `--model` → 环节的 → 顶层的 → 主会话当前的模型（环境变量 `PI_PROVIDER`、`PI_MODEL`）；四处都没有才拒绝，文案改成新的。桥接的 `knit_run` start 把 `ctx.model` 放进子进程的这两个变量。模板注释、`knit workflow show`、`knit init` 的输出、`README.md`、`DESIGN.md` 和演练脚本 `refusals.sh` 跟着改了。本仓库 `.knit/workflow.yaml` 里的 `model: magpie/group/deepseek` 由主会话删掉（用户 2026-11-19 决定）。

四条完成条件都满足：三种情况各有测试（`test/run-start.test.mjs`、`test/bridge-run.test.mjs`），用假 Pi 核对执行者实际收到的 `--provider`、`--model`。主会话读过全部改动，重跑 `npm test` 240 个全部通过、`npm run typecheck` 退出码 0；`npm run pack:check` 在思考等级的任务（`k-16dd4270f599`）做完之后和它的改动一起跑过，通过。

安装之后运行过 `validation/slim-h1-2026-11/refusals.sh`（去掉 `REX_SESSION`、`REX_BLOCK`，日志写到临时目录）：退出码 0，“流程里没有写模型，环境里也没有主会话模型”一项输出新文案。带着 Rex 的变量运行时它在最后“模型不存在”一步失败：窗格里的执行者报的是 `Pi 里没有模型 …`，脚本找的是 `Model not found`；这一步的脚本和窗格里的说法都不是本任务改的。

未验证：没有用真的模型走完一次“不配置模型、用主会话的模型派发”。

之后做了（2026-11-19，主会话）：`npm run pack:install`，`knit init --force` 重新生成 `.knit/workflow.yaml` 和 `.pi/extensions/knit.ts`，改了 `.knit/standards/pitfalls-main.md` 里“流程配置被覆盖”一条。后两个文件是任务记为完成之后改的，不在本任务的改动记录里。
