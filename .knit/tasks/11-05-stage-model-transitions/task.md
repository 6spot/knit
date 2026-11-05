---
id: k-63006e478faa
status: open
phase: discuss
outcome: null
branch: refs/heads/main
verification: self
parent: k-8ed2dceaaa4d
priority: P2
dependsOn:
  - k-4ef4cfc4095c
order: null
createdAt: 2026-11-05T11:07:42.298Z
title: 阶段模型与状态机：stage 字段、锚点、转移与回退上限
---

## 目标

把任务阶段从固定四值改为「锚点 + 配置阶段」：`phase` → `stage`，转移由 `WorkflowDefinition` 驱动，回退计数与上限落到转移层。

依据：`../11-05-role-contract-single-source/design.md` §3／§5／§13。

## 交付物

- `src/contracts/task-inputs.ts`：`TaskPhase` → `TaskStage`（`start`／`deliver` 锚点 + 阶段 id）。
- `src/domain/task.ts`：删除逐阶段 `onXxx`，改为 `transition(workflow, stage, event)`；访问计数、`repair_round_limit` 迁入。
- `task.md` frontmatter 写入端：`phase` → `stage`；旧值只读原样展示，写操作拒绝并提示。
- `test/domain.test.mjs`、`test/task.test.mjs`：更新 + 新增自定义阶段流转／回退上限用例。

## 规则

- 阶段值只能是内置锚点或当前配置里的阶段 id；配置降级时按 `start → deliver` 判定。
- 不做旧任务迁移；不批量改写现有任务的 `phase` 值。

## 依赖

`k-4ef4cfc4095c`（配置层）。验证：`npm run typecheck` + `npm test`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
