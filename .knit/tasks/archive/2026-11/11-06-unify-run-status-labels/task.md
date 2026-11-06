---
id: k-80202ada97d0
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-06T00:01:43.862Z
title: 统一 run status 展示口径：标题与阶段名、去掉重复的旧任务行
---

# 统一 run status 展示口径：标题与阶段名、去掉重复的旧任务行

## 目标与边界

`knit status --run` 已按“标题 + 短 ID + 阶段显示名”展示，但 `knit run status`（`src/cli/run.ts`）仍是 `任务: <taskId> / <phase>`，且 `knit status --run` 里还残留同一行的旧文案。本任务统一两处口径，只改展示。

## 完成条件

- `knit run status <runId>` 首行输出 `任务：「标题」k-8ed2d4（阶段：检查 check）`（标题缺失退 slug，再缺退短 ID），并删除旧的 `任务: <taskId> / <phase>` 行。
- `knit status --run <runId>` 删除重复的旧 `任务: <taskId> / <phase>` 行，只保留首行任务标签。
- 锚点阶段显示名：`start` → `准备（start）`、`deliver` → `收尾（deliver）`；配置阶段仍用 `name`，缺失退回 id。实现上优先复用 `domain/workflow` 的锚点名（如未导出则补导出，避免重复字面量）。
- 测试：`test/status-display.test.mjs` 覆盖 `knit run status` 与 `knit status --run` 的输出（含标题缺失与锚点阶段），既有 run 测试随文案更新。
- 边界：不改状态、接收与 JSON 字段语义；不改 `.knit/` 下文件。

## 输入引用

- 代码：`src/cli/run.ts`（run status 输出）、`src/cli/status.ts`（`--run` 输出）、`src/application/status-service.ts`（`stageName`）、`src/domain/workflow.ts` 或 `src/contracts/workflow.ts`（锚点名）。
- 测试：`test/status-display.test.mjs`、`test/m1-cli.test.mjs`、`test/run.test.mjs`。
- 验证入口：`npm run typecheck`、`npm test`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 实施结果（run-4b34328d324d，9 分钟）

- 新增 `src/cli/display.ts`：共享 `shortId`／`taskLabel`／`stageLabel`，`knit status` 与 `knit run status` 同口径。
- `src/cli/run.ts`：`run status` 首行输出 `任务：「标题」k-8ed2d4（阶段：检查 check）`（无标题退 slug，再退短 ID），删除旧的 `任务: <taskId> / <phase>` 行。
- `src/cli/status.ts`：`--run` 删除重复的旧任务行与单独的耗时行，耗时并入 `run …: state（启动 …；耗时 …）`。
- `src/domain/workflow.ts`：导出 `WORKFLOW_ANCHOR_NAMES` 与 `workflowStageDisplayName()`；`src/application/workflow.ts` 改用导出，锚点名不再有第二份字面量；状态投影的 `stageName` 对 `start`／`deliver` 显示“准备／收尾”。
- 测试：`test/status-display.test.mjs` 覆盖两处 `run status` 输出、标题／slug／短 ID 回退与锚点；`test/bridge-query.test.mjs` 期望更新为 `阶段：准备（start）`。

### 验证（主会话复核 2026-11-06）

- `npm test`：514/514 通过。
- 实跑：`knit run status run-174fbaee6247` 首行 `任务：「展示标签：任务标题与阶段名优先，ID 退…」k-c8e440（阶段：实现 implement）`；`knit status --run` 同首行且无重复旧行（`grep -c "^任务: "` 均为 0）。
- 实跑：`knit status k-80202ada97d0` → `阶段：收尾（deliver）`；JSON 仍为 `phase: implement`、`stageName: 实现`，字段只增不改。
- 桥接两份文件本任务未改动（`git diff` 无 `extensions/knit.ts`），turn context 测试通过说明其取自 `knit status --json` 的 `stageName`。

### 已知边界

- 标题截断 20 字只作用于人读文本；JSON 保留全文。

### 交付记录

<!-- knit:delivery:op-402e41c8e813 -->
- 操作: op-402e41c8e813
- 时间: 2026-11-06T00:27:00.731Z
- 分支: refs/heads/main
- 授权来源: user 2026-11-05 本会话明确授权：继续按讨论方案完成展示口径统一并本地提交，不含 push／发布
- 工作提交: 242b78900c6dd9ec13e53ced27e30436a3878f29
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-unify-run-status-labels

### 任务资料提交记录

<!-- knit:metadata-commit:op-402e41c8e813 -->
- 任务资料提交: 480a4694b2c2a2e76817546d7b0e939035d20439
- 归档目标: .knit/tasks/archive/2026-11/11-06-unify-run-status-labels

<!-- knit:progress:end -->
