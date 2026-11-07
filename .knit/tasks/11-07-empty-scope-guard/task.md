---
id: k-86d01bf85274
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-2c0d10318898
priority: P0
dependsOn: []
order: 80
createdAt: 2026-11-07T11:44:08.090Z
title: 空成果完成守卫与无产物交付提示
---

# 空成果完成守卫与无产物交付提示

## 目标与边界

### 背景与问题

审计复现：实施报告 `changedPaths: []` 被接收，scope 为 0，任务按 self 完成；`deliver` 返回 completed、`workCommit: null`，任务随即归档。"本来就没产物"、"产物已被外部提交"和"产物还留在工作区没归属"三种情况在结果里分不出来。

### 交付范围

1. 完成守卫：verification 为 self／independent 且 scope 为空时，`task close --outcome completed` 拒绝，原因 `empty_scope`。显式 `--no-artifacts --reason <text>` 才能完成，凭据记 `artifacts: none` 和原因。`none` 模式与主会话 `task implement`（已登记路径）不受影响。
2. 交付：`workCommit` 为空时结果带 `noArtifactCommit: true`；人读输出与桥接通知明确写"本次交付没有产物提交"，并附上完成凭据中的原因。
3. 接收提示：空报告的实施 run 接收时，`run status` 提示"本轮未产生成果"。
4. 同步 DESIGN 第 202 行附近与 STATES 完成资格章节。

### 非目标

- 不改 cancelled／superseded 的关闭路径。
- 不判断外部提交是否属于本任务（属于审计 F1，由基线冻结任务处理）。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 父任务（总体验收）不受空 scope 守卫约束

## 完成条件

- 自动化测试：空 scope 的 self 任务 close 被 `empty_scope` 拒绝；加 `--no-artifacts --reason` 后成功，交付结果 `noArtifactCommit: true`。
- 审计 F4 场景不再静默完成。

## 输入引用

- 审计 F4。
- `src/domain/completion.ts`、`src/application/task-service.ts:2227+`、`src/application/delivery-service.ts`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
