---
id: k-25933a16b9f6
title: 适配桥接汇总续修入口并实机验收多模型对抗审查闭环
status: delivered
stage: null
verification: self
parent: k-8ac399027fac
dependsOn:
  - k-3bead0494c8e
priority: P2
createdAt: 2026-11-22T07:28:40.737Z
---

## 目标与范围

补齐面向主会话的桥接工具入口、模板与设计文档，并在经用户授权后用真实 Pi 与 Antigravity 模型完成端到端实机闭环验收：

1. **更新模板与设计文档**：
   - 更新 `assets/templates/pi/extensions/knit.ts`：为 `knit_run` 工具的 `start` 动作增加可选 `instruction`（主会话裁决汇总的修改清单）与 `fresh`（强制新会话）参数，确保 `notifyWhenEnded` 通过 `knit run wait` 等整批并行审查全部结束后一次性将各审查报告路径与结论通知回主会话。
   - 更新 `assets/templates/agents/review.md`：兼容只读审查模式（当环节无 `write` 能力时只输出可定位的问题清单、完成条件对照与 `verdict`，不尝试改代码；单模型具备 `write` 时保留原有直接修规则）。
   - 同步更新 `docs/design/DESIGN.md`（第 5、6、7、9 节）：写清多执行器配置、只读并行审查、批次 Join 交回主会话裁决、原生 Resume 续聊与自动回退规则，同时更新第 11 节中关于「续用执行者的旧会话」的旧说明。
2. **实机闭环验收（已获用户明确授权调用真实模型）**：
   - 在临时隔离 Git 夹具仓库中配置「`implement`（开启 `resume: true`）→ `review`（`tools: [read, exec]`，`executors` 同时配置 1 个真实 Pi 模型与 1 个真实 Antigravity 模型）」。
   - 实机走通完整闭环：首轮实现 → 双模型并行只读对抗审查并等待两者全部结束 → 模拟或触发主会话汇总修改指令 → 实现者以原生 Resume 恢复上下文继续修改 → 复审双模型通过 → 核对 Worktree 快照与会话记录，并把验收证据记入 `validation/`。

边界：
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，模板修改一律写在 `assets/templates/`，不直接改本仓库生成的副本。
- 已获用户明确授权调用真实 Pi 与 Antigravity 模型进行实机验收；验收在临时目录夹具中完成，不污染本仓库工作区与历史。

## 完成条件

### Requirement: 桥接模板、角色模板与设计文档与新能力保持一致

#### Scenario: 桥接参数透传、角色指引与设计文档通过校验和测试

- GIVEN 更新后的 `assets/templates/pi/extensions/knit.ts`、`assets/templates/agents/review.md` 与 `docs/design/DESIGN.md`
- WHEN 运行 `npm run typecheck`、`npm run pack:check` 与 `npm test`（macOS 普通终端与 Rex 终端各一次）
- THEN `knit_run` 透传 `instruction` 与 `fresh` 并等待并行批次全部结束后发出单次 `knit.run-ended` 通知，设计文档章节与实际实现一致，全部测试通过

### Requirement: 真实双模型对抗审查与原会话 Resume 续修实机跑通

#### Scenario: 临时夹具中完成实现、双模型并行只读审查与原生 Resume 返工闭环

- GIVEN 用户已明确授权调用真实 Pi 与 Antigravity 模型，且本机 `pi` 与 `agy` 均可用
- WHEN 在临时 Git 夹具运行全链路实机验收（覆盖首轮实现 → Pi + AGY 并行只读审查 → 带主会话修改指令触发实现者原会话 Resume 续修 → 复审通过）
- THEN 双模型审查并行完成且未修改 Worktree 文件，返工实现成功命中原生 Resume（并在另一次用例验证会话失效时自动回退新会话），验收记录保存在 `validation/` 中

## 待澄清

## 相关资料

- `assets/templates/pi/extensions/knit.ts` — Pi 主会话桥接模板
- `assets/templates/agents/review.md` — 审查角色模板
- `docs/design/DESIGN.md` — 现行设计文档（第 5、6、7、9、11 节）
- `test/bridge-run.test.mjs` — Pi 桥接 `knit_run` 参数透传回归测试
- `test/bridge-notice.test.mjs` — Pi 桥接执行结束通知回归测试
- `validation/` — 历史实机验收记录目录

## 结果

已更新 assets/templates/pi/extensions/knit.ts（支持 instruction、fresh 透传与整批单次通知）、assets/templates/agents/review.md（明确只读审查与可写直接修分流）及 docs/design/DESIGN.md 第 5/6/7/9/11 节，补充桥接回归测试；在临时隔离夹具中用真实 Pi 与 Antigravity 模型跑通双模型并行只读首审 → 主会话修改指令触发原会话 Resume 续修 → 双模型复审 pass 及原生会话失效自动回退新会话全链路，证据记入 validation/adversarial-review-resume/。完成条件全部满足。npm run typecheck、npm run pack:check、knit workflow validate 均通过，macOS Terminal.app 与 Rex 终端 npm test 各 474/474 通过（0 失败，0 跳过）。
