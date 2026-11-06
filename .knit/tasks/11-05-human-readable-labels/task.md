---
id: k-c8e440a3d4dd
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn:
  - k-4367ce59738d
order: null
createdAt: 2026-11-05T22:43:27.184Z
title: 展示标签：任务标题与阶段名优先，ID 退居次要
---

# 展示标签：任务标题与阶段名优先，ID 退居次要

## 目标与边界

人读标签优先：通知与状态行先给任务标题与阶段显示名，稳定 ID 退到次要位置。只改展示，不改状态、接收、授权语义。

## 完成条件

- `RunStatusView`（`src/application/status-service.ts`）增 `taskTitle`、`stageName`、`taskSlug`：标题读任务文档（含归档任务，缺失为 null）；`stageName = workflowStageOf(loadWorkflow(...), phase)?.name ?? phase`；`taskSlug` 为任务目录名去掉日期前缀。
- `src/cli/status.ts`：`run status` 首行形如 `任务：「标题」k-8ed2d（阶段：检查 check）`；标题缺失退到 slug，再缺退到 taskId；完整 ID 仍在输出中可复制。
- `knit status <task>` 的阶段行显示 `阶段：检查（check）`。
- 桥接（`.pi/extensions/knit.ts` 与模板一致）：
  - 通知：`「标题」检查：run-f991c4 pass；下一步：…`；待同步场景保留“不要重复实施”措辞。
  - turn context：`当前任务：「标题」（k-8ed2d）`；阶段行 `阶段：检查（check）`。
  - `knit_run`／`knit_status` 文本优先标题与阶段名。
- 兼容：JSON 只增字段；标题超 20 字截断加 `…`；短 ID 为类型前缀 + 前 6 位；标题缺失时退回 slug 与 ID。
- `src/cli/task.ts` 的三处拒绝信息改为人读文本并保留语义码：`缺少 taskId：knit task ready <taskId>；或先 knit task use <taskId> --session <id> 再用 --session 解析（task_id_required）`，`selection_pending`／`selection_missing` 同样给出下一步；JSON 保持 `data.reason` 为语义码、`reasonCode=invalid_request`，测试同步。
- 测试：状态服务新字段（正常、标题缺失、归档任务、降级流程 stageName 回退 id）；桥接通知与 turn context 文本断言；既有快照/契约测试随字段新增更新。

## 输入引用

- 设计：`docs/design/DESIGN.md` §3.9（状态与展示）、§5.6（运行协议与观察）；`docs/design/OPERATIONS.md` 的 `run status`／桥接通知条目。
- 代码：`src/application/status-service.ts`、`src/cli/status.ts`、`src/application/workflow.ts`、`.pi/extensions/knit.ts`、`assets/templates/pi/extensions/knit.ts`。
- 测试：`test/status*.test.mjs`（若无则 `test/m1-cli.test.mjs`）、`test/bridge-query.test.mjs`、`test/init.test.mjs`。
- 验证入口：`npm run typecheck`、`npm test`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 实施结果（run-174fbaee6247，12 分钟）

- `src/application/status-service.ts`：`RunStatusView` 增 `taskTitle`／`taskSlug`／`stageName`；`TaskStatusView`、`StatusOverview` 增 `stageName`；标题读任务文档（含归档任务），`stageName` 取生效流程 `name`，缺失退回阶段 id。
- `src/cli/status.ts`：`knit status --run` 首行 `任务：「标题」k-8ed2d4（阶段：检查 check）`；`knit status <task>` 改为 `任务：…`、`任务 ID: …；状态: …`、`阶段：检查（check）`；项目状态列表与活动 run 行使用标题与阶段显示名，run 用短 ID。
- `.pi/extensions/knit.ts` + `assets/templates/pi/extensions/knit.ts`（两份一致）：通知改为 `「标题」阶段名：run-f991c4 pass；下一步：…`（待同步场景保留“不要重复实施”）；turn context 改为 `当前任务：「标题」（k-8ed2d4）`、`阶段：检查（check）`；`knit_run`／`knit_status` 文本同口径。
- `src/cli/task.ts`：`task ready` 的 `task_id_required`／`selection_pending`／`selection_missing` 改为带操作提示的人读文本，保留 `data.reason` 语义码与 `reasonCode=invalid_request`。
- 新增 `test/status-display.test.mjs`，并同步 `test/bridge-query.test.mjs`、`test/session.test.mjs`。

### 验证（主会话复核 2026-11-05）

- `npm test`：514/514 通过。
- 实跑：`knit status --run run-174fbaee6247` 首行 `任务：「展示标签：任务标题与阶段名优先，ID 退…」k-c8e440（阶段：实现 implement）`；`knit status k-c8e440a3d4dd` 输出标题优先、`任务 ID` 与 `阶段：deliver`（锚点无显示名时退回 id）；归档任务的 run（`run-5f9c9ae9aff1`）也能取到标题。
- `knit task ready`（无参）：退出码 1，输出带下一步提示的 `task_id_required` 文案。
- 两份桥接 `diff` 一致。

### 已知边界（移交后续小任务）

- `knit run status`（`src/cli/run.ts` 的输出）仍是 `任务: k-… / implement`，没有采用新的标题／阶段名口径；`knit status --run` 里也残留一行旧的 `任务: k-… / phase`。两处属同一展示口径，建议另开小任务统一（本次 run 已接收，不在交付前改 scope 内文件）。
- 锚点 `start`／`deliver` 没有配置显示名，阶段行回退为 `deliver`；如需“收尾／准备”可再映射。

### 交付记录

<!-- knit:delivery:op-372e2fdf2ae1 -->
- 操作: op-372e2fdf2ae1
- 时间: 2026-11-06T00:00:10.436Z
- 分支: refs/heads/main
- 授权来源: user 2026-11-05 本会话明确授权：任务 B（展示标签）按讨论方案实施并本地提交，不含 push／发布
- 工作提交: 47ea25c970d2e392ef855fd13ab2290ea9be8745
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-05-human-readable-labels

<!-- knit:progress:end -->
