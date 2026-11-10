---
id: k-b9df107db53a
status: closed
stage: deliver
outcome: completed
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

### 实施与接收（2026-11-10）

- run-584fab9d64a1（implement，magpie group/deepseek）：worker 在 07:42:38 后无心跳、无 result.json 退出；同一时刻（07:42:39）本机 Rex server 进程重启，时间吻合，推断 worker 随宿主进程树被终止（未另行取证，不作因果结论）。工作区留下 20 个文件的未收尾改动。
- 主会话接续原会话 01a1b5fe 的授权，`knit run resume run-584fab9d64a1`：旧 run 收敛为 failed（worker_exited_before_result），残留锁（project／session）自动回收，新 run run-417ebb01f510 续用原生会话 082516aa 真实启动并完成。验证了本计划 S1／S2 的修复在真实现场可用。
- run-417ebb01f510 未再改文件，只补完验证与报告，报告列出的 20 个路径因非本 run 工具写入挂起为 `unattributed_paths`。主会话逐文件读 diff 后 `run accept --include` 全部并入（operation accept-09b607da8ab3）。

### 未覆盖细节的决定

- task.md 列的可补报原因是 4 类；实现按“只涉及报告本身”扩到解析／结构类（`report_not_json`、`report_schema_invalid`、`report_field_*`、`report_changed_paths_missing`），与 plan.md 实施要点一致，不放宽路径一致性。
- `check_scope_incomplete` 原先只在接收侧判定；为能补报，worker 侧用同一函数 `uncoveredScopePaths` 先判，接收侧保留同一规则作兜底。
- 补报期间工作区有新改动记 `report_retry_worktree_changed:<paths>`；HEAD／敏感区变化优先按原边界原因失败。

### 主会话核验

- 读完 20 个路径的 diff：补报只在阶段工作成功结束、边界／保护路径／能力核对之后触发；取消、占用丢失、进程退出、补报机制不可用都不走补报成功路径；`reportRetries`／`reportRetryUsage`／`reportIssue` 写入结果，CLI `status`／`run status` 显示。
- 全量 `npm test`（清除 Rex 呈现环境）：696/696 通过，耗时约 8.5 分钟。
- 完成条件三项均有自动化测试：首轮缺路径补报后接收；补报期间写文件失败；`reportRetries=0` 维持现状。另有畸形 JSON、首轮有效不追加、coverage 补报三项。
- 未验证：真实 Rex TUI 与真实模型下的补报轮端到端（按总计划延期，不在授权范围内）。

### 交付记录

<!-- knit:delivery:op-78ae72340a17 -->
- 操作: op-78ae72340a17
- 时间: 2026-11-10T10:16:10.912Z
- 分支: refs/heads/main
- 授权来源: user:b527d46a
- 调用: bridge
- 工作提交: 1123a0e16e4235d50609acc244d8b1aa3c73bc97
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-07-report-retry

### 任务资料提交记录

<!-- knit:metadata-commit:op-78ae72340a17 -->
- 任务资料提交: 4277669dfddbf227c2f38d965404206a8c772126
- 归档目标: .knit/tasks/archive/2026-11/11-07-report-retry

<!-- knit:progress:end -->
