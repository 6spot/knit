---
id: k-2e387ab34f42
title: Pi 重试之后成功的执行不记成模型出错（回归测试）
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P3
createdAt: 2026-11-20T02:57:16.861Z
---

## 目标与范围

Pi 在模型请求出错时会自己重试。重试之后做完的执行，Knit 应该照常读报告、记结论；只有重试用完、最后一条助手消息仍然是出错的，才记成 `执行者出错：<原因>`（`docs/design/DESIGN.md` 第 7 节）。现在的代码是这样做的，但没有测试守着：假 Pi（`test/helpers/fake-pi.mjs`）的 `modelError` 只能让一轮的最后一条消息出错，模拟不了「先出错、后来做完」。这种情况真实发生过（见「相关资料」），判断错了的代价是把一次做完的执行记成失败。用户 2026-11-20 同意补这条回归测试。

要做的：

1. 假 Pi 加一个选项：一轮里先出现若干条出错的助手消息，再照常做完。两种运行方式都要支持，并且照真的 Pi 的样子来：
   - 后台执行（`--mode rpc`）：出错的消息和之后成功的消息都发 `message_end`，出错之后发 `auto_retry_start`，成功之后发 `auto_retry_end`，`agent_settled` 只在最后发一次。假 Pi 现在不给成功的消息发 `message_end`；这个选项打开时要发，否则 Knit 看到的最后一条助手消息还是出错的那条，测的就不是真实情况。
   - 窗格执行（加载扩展）：会话分支里先有出错的消息，再有成功的消息，`agent_settled` 只在最后触发一次。
2. 后台执行和窗格执行各加一条测试：先出错、重试之后做完的执行照常结束。放在现有两条「模型请求出错」测试旁边（`test/run-execute-edges.test.mjs`、`test/run-pane.test.mjs`）。

两种运行方式各自怎么判断模型出错：后台执行在 `src/adapters/pi/runtime.ts` 的 `lastModelError`，窗格执行在 `src/adapters/pi/pane-worker.ts` 处理 `agent_settled` 的地方。

不在范围内：

- 不改 `src/` 里判断结果的代码。新测试在现在的代码上通不过时，说明判断真的有问题：停下来报告现象和原因，不在这个任务里修（改结果的判断要单独审查）。
- 不让 Knit 读 `auto_retry_start`、`auto_retry_end`：现在的判断只看最后一条助手消息，这两个事件只是假 Pi 照样子发出来。
- 不动现有的 `modelError` 选项和用它的测试。被中止之后接着做的情况已有测试，不在这里重复。
- 不加依赖，不提交、不推送。

## 完成条件

- 后台执行：假 Pi 一轮里先有两条出错的消息、再做完时，这次执行没有失败原因，报告存了下来，结论读得出来，发给执行者的消息只有一条。
- 窗格执行：同样的脚本，结果和后台执行一样。
- 新测试守得住：临时把判断改成「出现过出错的消息就记失败」，两条新测试都失败；还原之后都通过。报告里写这一步实际看到的结果，`git diff src` 在结束时没有输出。
- 现有两条「模型请求出错」的测试不改，仍然通过。`npm test` 全部通过，测试个数比改之前多（改之前先运行一次记下个数；改之前就有失败时停下来报告）；`npm run typecheck` 退出码 0。

## 待澄清

无。

## 相关资料

- `.knit/tasks/11-20-retry-success-test/retry-evidence.md` — 真实发生的那一次的摘录，和 Pi 1.5.2 文档里重试事件的原文

## 结果

假 Pi 加了 `retryErrors` 选项（一轮里先出现若干条出错的助手消息，再照常做完），后台执行和窗格执行各加一条回归测试。改了 3 个文件，都在 `test/` 下：`test/helpers/fake-pi.mjs`、`test/run-execute-edges.test.mjs`、`test/run-pane.test.mjs`；`src/` 没有改动。

实现由执行 `r-c57e831647bc` 做（magpie/group/openai）。主会话核对时自己重跑的检查和结果：

- 新测试守得住：临时把两处判断改成「出现过出错的消息就记失败」（`runtime.ts` 的 `lastModelError`、`pane-worker.ts` 处理 `agent_settled` 的地方），重新构建后两条新测试都失败，实际得到 `failure: '执行者出错：Claude: Service Unavailable (error)'`、`verdict: null`，预期是 `failure: null`、`verdict: 'pass'`。还原后 `git diff src` 没有输出，「模型请求」相关的 4 条测试（新旧各 2 条）都通过。
- `npm test`：Rex 终端里 279/279 通过；去掉 Rex 环境变量再跑一次 279/279 通过。改之前是 277 条（执行者报告的基线）。
- `npm run typecheck` 退出码 0；`git diff --check` 退出码 0；没有残留进程。

假 Pi 在 rpc 方式下的事件顺序没有由主会话单独核对，依据是 diff：出错消息的 `message_end` → `auto_retry_start`（每条出错各一次）→ 成功消息的 `message_end` → `auto_retry_end` → `agent_settled` 一次。执行者报告它用临时脚本核对过实际输出。

没有验证的：真实的模型服务和真实的 Rex 窗格，这个任务用的是假 Pi 和假 Rex。

现有的 `modelError` 选项和用它的两条测试没有改。
