---
id: k-b9df107db53a
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-2c0d10318898
priority: P2
dependsOn:
  - k-fdfd8c171736
order: 30
createdAt: 2026-11-07T11:44:09.997Z
title: 阶段报告补报轮次
---

# 阶段报告补报轮次

## 目标与边界

### 背景与问题

审计结论：
- **报告格式要求太死：** `changedPaths` 必须与 diff 逐字一致；`coverage` 必须逐路径列出（`["all"]` 会报 `check_scope_incomplete`）；不符就整轮作废，默认 `maxAttempts=1`，每次都要付整轮模型费用。
- **原因误导：** 用户编辑任务资料被报成 Agent 违规（该部分由 `k-f0d9a8952aff` 处理）。

### 交付范围

1. 补报轮次：报告校验失败时（`report_invalid`、`changed_paths_mismatch`（不含外部改动）、`check_scope_incomplete`、`report_verdict_missing`），worker 在同一会话追加一条纠正提示，列出实际差异或缺失的 coverage，请模型只重发报告、不改文件。
   - 最多 `limits.reportRetries` 次，默认 1；
   - 补报期间工作区如有新改动，判失败；
   - 补报次数与用量写进结果。
2. 错误文案：每种报告失败原因都附"实际 vs 报告"的对照，供主会话与用户阅读。
3. 同步 ROLE-CONTRACT 报告约定与 OPERATIONS。

### 非目标

- 不放宽路径一致性本身：补报后仍必须一致。
- 不改 `maxAttempts` 语义。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 补报默认开启 1 次，开发者模式不改变该行为

## 完成条件

- 自动化测试：fake-pi 首次报告缺路径、补报后正确 → run 接收；补报期间写文件 → 失败；`reportRetries=0` 时维持现状。

## 依赖说明

在改动归属任务之后实施，避免外部改动被当成报告错误去补报。

## 输入引用

- 审计中等问题 3。
- `src/application/stage-runner.ts:946-990`、`src/application/stage.ts`、`src/application/run-acceptance.ts:383-404`、fake-pi 夹具。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
