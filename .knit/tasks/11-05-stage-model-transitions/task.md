---
id: k-63006e478faa
status: closed
outcome: completed
branch: refs/heads/main
verification: self
parent: k-8ed2dceaaa4d
priority: P2
dependsOn:
  - k-4ef4cfc4095c
order: null
createdAt: 2026-11-05T11:07:42.298Z
title: 阶段模型与状态机：stage 字段、锚点、转移与回退上限
stage: deliver
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

### 实施结果（run-c918252a8a8e）

- `src/contracts/task-inputs.ts`：`TaskPhase` → `TaskStage`（锚点 + 配置阶段 id）；`legacyPhaseToStage`（`discuss` → `start`，其余原样）；需求摘要排除字段加入 `stage`。
- `src/domain/task.ts`：删除逐阶段 `onXxx`，统一 `transition(workflow, task, event)`；顺序边、`onVerdict` 回退边都按 `WorkflowDefinition` 推导；阶段访问计数与 `maxVisits` 上限落到转移层（`repair_round_limit`）；新增 `stage_not_in_workflow` 原因码。
- `src/application/workflow.ts`（新增）：`loadWorkflow`／`workflowOf`，文件缺失用内置默认模板，非法配置按 domain 降级。
- 写回链路：`task.md` frontmatter 只写 `stage`，旧 `phase` 读时映射、首次写入即改名并清旧键；`contracts/metadata.ts` binding 增 `stageVisits`；run 接收、交付、恢复、状态服务同步改读 `stage`。
- 桥接 `.pi/extensions/knit.ts` 与初始化模板同步字段名（枚举派生留给 P5）。

### 验证（主会话复核 2026-11-05）

- `npm test`：488/488 通过（含 typecheck 与 build）。
- 未改动受保护路径：`.knit/agents/*`、`.knit/workflow.md`、`.knit/standards/*` 无 diff。
- 临时项目 `/tmp/knit-p2-probe` 端到端探针（本地 dist CLI）：
  - `task new` 写 `stage: start`；`task ready` → `stage: implement`。
  - 自定义 `workflow.yaml`（`build` → `verify`，`onVerdict.fail: build`）：`task ready` → `stage: build`。
  - 非法配置（`version: 2`）：`task ready` 走降级流程 → `stage: deliver`。
  - 旧值 `phase: discuss` 的手写文档：`task priority` 写入后字段变为 `stage: start` 且 `phase` 被清掉。
  - 未知阶段值 `legacy-x`：写操作被拒绝并提示“旧值只读展示”，`task list` 仍原样显示该值。
- `test/domain.test.mjs` 覆盖自定义流程流转、`onVerdict` 回退、`maxVisits` 超限 `repair_round_limit`、`phase_mismatch`、`stage_not_in_workflow`。

### 已知边界

- 自定义阶段暂不能直接派 run：`knit run <phase>` 仍要求阶段 id 与运行角色同名，`--stage` 与 CLI／桥接去静态枚举由 P5 完成。
- 本 run 的接收发生在长驻 worker 进程内，用的是启动时的旧模块，故 task.md 仍写 `phase: deliver`；新代码按旧值映射读取，已用探针验证该路径。

未覆盖（后续任务承担）：`knit workflow` 命令组与降级可见性（P5）、报告字段声明校验与能力权限（P3）、模板与文档重写（P7）。

### 交付记录

<!-- knit:delivery:op-aff741f2e705 -->
- 操作: op-aff741f2e705
- 时间: 2026-11-05T12:50:59.849Z
- 分支: refs/heads/main
- 授权来源: user 2026-11-05 本会话明确授权：整条链逐任务本地提交（选项 A），不含 push／发布／归档
- 工作提交: 9d1ba598fcc2b223f1c97091e51100f02162a8b5
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-05-stage-model-transitions

<!-- knit:progress:end -->
