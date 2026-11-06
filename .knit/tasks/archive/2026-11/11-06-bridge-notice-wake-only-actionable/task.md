---
id: k-0ca555299a57
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-06T09:46:23.871Z
title: 桥接通知仅需处理时唤醒模型
---

# 桥接通知仅需处理时唤醒模型

## 目标与边界

用户观察：每次 run 终态通知都会触发模型回复。希望 completed+accepted 的通知只展示并进入后续上下文，不启动模型轮次；只有失败、取消或结果待接收时才唤醒。

现状与根因（实施前复核）：

- `.pi/extensions/knit.ts` 的 `scanRuns` 先算 `busy`，再 `pi.sendMessage(..., busy ? { deliverAs: "followUp", triggerTurn: true } : { triggerTurn: false })`。
- 只要终态且 busy 就 followUp+triggerTurn，不区分 completed+accepted 与需要处理的终态，导致每个完成通知都叫模型。
- `DESIGN.md` §9.3 写的是“明确允许继续且无暂停／待应用输入时，完成消息可唤醒主 Agent”；当前实现没有落实该限制。

目标规则：

- `needsAction = resultState === "failed" || resultState === "cancelled" || (resultState === "completed" && acceptanceState !== "completed")`。
- `needsAction`：保持唤醒，`{ deliverAs: "followUp", triggerTurn: true }`。
- 否则（completed+accepted）：`{ deliverAs: "nextTurn", triggerTurn: false }`，仅展示并进入下一轮上下文，不启动模型轮次。
- 保留现有去重 signature、Session／分支核对、通知文本、`pi.appendEntry` 与诊断。
- `busy` 若不再需要则删除；若保留，必须只服务上述规则，不能继续无差别唤醒。

边界：

- 只改通知投递策略，不改变 run 状态、验收、轮询、去重、展示文本与错误处理。
- 两份桥接必须保持一致：`.pi/extensions/knit.ts` 与 `assets/templates/pi/extensions/knit.ts`。
- 更新 `docs/design/DESIGN.md` §9.3 的通知规则，与代码一致；不新增配置项，不改 worker／CLI。
- 桥接变更需要 `/reload` 或重启 Pi 才生效；任务只负责代码与文档，真实宿主的 reload 观察由主会话或用户执行。

## 完成条件

- 通知投递按 needsAction 分流；completed+accepted 使用 `nextTurn` + `triggerTurn: false`，不再因 busy 唤醒。
- failed／cancelled／结果待接收仍使用 `followUp` + `triggerTurn: true`。
- 两份桥接文件内容一致；`DESIGN.md` §9.3 规则同步。
- 测试：至少断言两份桥接保持一致且包含分流规则（`nextTurn` 用于被动、`followUp` 用于需处理）；运行受影响测试与 `npm test`（或说明范围）。若无法对 Pi 的 `sendMessage` 做行为级单测，在报告中说明，并把真实 Pi reload 后“完成通知不触发回复”列为后续验收项。
- 报告 `changedPaths`／`validation`；不提交、不推送。

## 输入引用

- 用户观察与选择：通知每次都触发模型回复；选择“仅需处理时唤醒”。
- 代码：`.pi/extensions/knit.ts` 的 `scanRuns`（约 340–385 行）、`assets/templates/pi/extensions/knit.ts`（同内容）。
- 规范：`docs/design/DESIGN.md` §9.3；`AGENTS.md` 的交付与提交边界。
- 现有测试：`test/host-selection.test.mjs` 已断言两份桥接一致；可扩展该测试或新增最小断言。

## 验证方式

self：实施者运行受影响测试、`npm test`（全量失败若是既有环境问题，按基线说明）；报告实际改动与未验证项。真实 Pi `/reload` 后的行为由主会话在接收后验证。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## 主会话复核（verification=self）

- `npm run -s typecheck`：pass。
- `TMPDIR=/tmp node --test test/bridge-query.test.mjs`：8/8 pass；新增断言验证 accepted→`nextTurn/false`、pending→`followUp/true`、failed→`followUp/true`。
- `TMPDIR=/tmp node --test --test-name-pattern 桥接通知 test/host-selection.test.mjs`：1/1 pass；两份桥接逐字节一致，`needsAction` 五组分支与投递三元组断言通过，无 `busy`／`isIdle` 残留。
- `test/host-selection.test.mjs` 全文件仍有 1 个既有 auto Rex 环境失败（fake rex PATH），与本次改动无关；实施报告的全量基线为 519/523，4 个失败均已在干净 HEAD 复现。
- 真实 Rex：本轮 `run-492b79cce459` completed／accepted，终态后无残留 `knit run-*` 浮层。
- 未验证：当前 Pi 会话仍加载旧桥接；需要 `/reload` 或重启后，才能观察 completed+accepted 通知不触发模型轮次、失败／待接收通知仍唤醒。
- 交付状态：代码、桥接副本、DESIGN §9.3 与测试已改；工作区未提交。

### 交付记录

<!-- knit:delivery:op-73d1ead907b5 -->
- 操作: op-73d1ead907b5
- 时间: 2026-11-06T09:57:37.883Z
- 分支: refs/heads/main
- 授权来源: user:chat#提交推送归档
- 工作提交: abbf4295ec3d3fcdf7790f8e46a3a29ff613f65c
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-bridge-notice-wake-only-actionable

### 任务资料提交记录

<!-- knit:metadata-commit:op-73d1ead907b5 -->
- 任务资料提交: 6ada8e0629ab1b05792607cbdab42012d6c09126
- 归档目标: .knit/tasks/archive/2026-11/11-06-bridge-notice-wake-only-actionable

<!-- knit:progress:end -->
