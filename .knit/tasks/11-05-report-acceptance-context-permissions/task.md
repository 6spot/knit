---
id: k-9a6dcc91e184
status: open
phase: discuss
outcome: null
branch: refs/heads/main
verification: self
parent: k-8ed2dceaaa4d
priority: P2
dependsOn:
  - k-63006e478faa
order: null
createdAt: 2026-11-05T11:07:42.767Z
title: 报告声明校验、接收流转、顶部提示行与能力权限
---

## 目标

报告按阶段声明校验、接收后按配置流转；每轮上下文顶部生成"流程 + 当前阶段 + 本步目标 + 完成条件"；工具能力映射到 Pi 参数。

依据：`../11-05-role-contract-single-source/design.md` §5／§6／§7／§12。

## 交付物

- `src/contracts/run.ts`：`RunPhaseSchema` → 阶段 id；报告改为固定字段 + 声明字段；`workflowMode`。
- `src/application/run-acceptance.ts`：按声明校验、按配置转移、写访问计数；删除 `advisory` 早退分支。
- `src/application/context-planner.ts`：删除 `workflow` 分节；`--stage`；能力 → `ToolPolicy`；生成顶部提示行（用 `name`／`description` 渲染）。
- `src/application/stage-runner.ts`：删除 `roleOf` 特判。
- `src/adapters/pi/runtime.ts`：能力展开为 `--tools` 与 `--no-extensions`／`--no-mcp`／`--no-skills`／`--offline` 开关。
- `src/worker/knit-worker.ts`：删除 `advisory` 特判。

## 规则

- 固定报告字段 `summary`／`validation`／`blockers`；`paths` 沿用"必须与真实 diff 一致"。
- 不写 `tools` = 全部放开；`external` 放开扩展／MCP／技能；`network` 放开 `--offline`。
- 非正式检查 `knit run check --scope` 保留，用独立固定格式，不依赖阶段声明。

## 依赖

`k-63006e478faa`（阶段模型）。验证：`npm run typecheck` + `npm test`，含能力→参数单测（假 runtime 记录参数）。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
