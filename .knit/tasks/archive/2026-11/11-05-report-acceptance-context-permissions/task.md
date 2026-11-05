---
id: k-9a6dcc91e184
status: closed
outcome: completed
branch: refs/heads/main
verification: self
parent: k-8ed2dceaaa4d
priority: P2
dependsOn:
  - k-63006e478faa
order: null
createdAt: 2026-11-05T11:07:42.767Z
title: 报告声明校验、接收流转、顶部提示行与能力权限
stage: deliver
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

### 实施结果（run-82f2ad3030c1，51 分钟）

- `src/domain/report.ts`（新增，174 行）：固定字段 `summary`／`validation`／`blockers` + 阶段声明字段校验；`paths` 与真实 diff 严格一致；枚举必填并给出 `report_verdict_missing`／`report_field_value`；未声明字段不参与判定；`isDecisionStage` 由“声明里有枚举”推导，替代角色特判。
- `src/contracts/run.ts`：`RunPhaseSchema` 改为阶段 id（锚点 + 配置阶段）；报告 schema 开放，固定字段之外按声明校验；`run-result`／`run-request`／状态记录增 `workflowMode`。
- `src/application/run-acceptance.ts`：删除 `advisory` 早退分支；按 `validateReportForStage` 校验、按 `transition(workflow…)` 流转并写 `stageVisits`；`stage_not_in_workflow` 单独回报；降级流程保留旧固定字段接收。
- `src/application/context-planner.ts`：删除 `workflow.md` 分节；`stage` 取代 `role`；能力 → `ToolPolicy`（`read/write/exec/task/external/network`）；阶段 `prompt` 缺失不阻断（仅记 `stage_prompt_file_missing`）。
- `src/application/stage.ts`：报告示例与完成条件按阶段声明生成（`reportTemplateOf`、`stageRequirementOf`）。
- `src/application/stage-runner.ts`：删除 `roleOf`；`stageRuntimeTools` 把能力展开成 `--tools`／`--extension`／`--exclude-tools`；声明 `task` 但项目扩展缺失时以 `tool_capability_unavailable` 明确失败。
- `src/adapters/pi/runtime.ts`：`capabilitySwitches`（`external` 放开扩展／MCP／技能，`network` 放开 `--offline`），`--tools +名字` 只增项、`--exclude-tools` 排除内置；`tools: null` 表示不限制。
- `src/worker/knit-worker.ts`：删除 `advisory` 特判；启动时比较 `workflowMode` 并回写状态。
- 顶部提示行由 `stageBriefOf` 生成（`流程：… ｜ 当前：…` / `本步目标` / `完成条件`），用 `name`／`description` 渲染。

### 验证（主会话复核 2026-11-05）

- `npm test`：494/494 通过（含 typecheck、build）。
- `node --test test/stage-contract.test.mjs`：4/4 通过。
- 独立探针（本地 dist，`buildPiArgs`）：
  - `[read]` → `--offline --no-mcp --no-skills --no-extensions --tools read,grep,find,ls`
  - `[read,external]` → 无 `--no-extensions/--no-mcp/--no-skills`，`--tools +read,+grep,+find,+ls`，`--exclude-tools write,edit,bash`
  - `[read,network]` → 无 `--offline`，其余收紧
  - `null`（未写 `tools`）→ 不传 `--tools`／`--no-tools`
  - `task` 能力 + 显式扩展路径 → `--extension <项目>/.pi/extensions/knit.ts`
- 独立探针（`stageBriefOf`／`validateReportForStage`）：自定义 `build → verify` 流程渲染“流程：准备 → 构建 → 检查 → 收尾 ｜ 当前：检查”；`report_verdict_missing`、`report_field_value`、`changed_paths_mismatch:b.ts`、未声明字段放行、`blockers` 类型错误均按预期。
- 受保护路径无改动：`.knit/agents/*`、`.knit/workflow.md`、`.knit/standards/*` 无 diff。

### 已知边界（后续任务承担）

- `advisory`／`assist <mode>` 的 CLI 与桥接入口、`knit_workflow`、`--stage` 在 P5 删除／新增；本任务已使 `advisory` 无法再作为阶段流转（准备被拒）。
- 降级可见性的四处展示（`knit workflow show`、提示行、run 记录、`knit doctor`）中，`workflow show`／`doctor` 由 P5 补齐；提示行与 run 记录本任务已完成。
- 在途旧 run 无 `workflowMode` 字段（P3 之前启动），新 run 起记录。

### 交付记录

<!-- knit:delivery:op-1f69577dd980 -->
- 操作: op-1f69577dd980
- 时间: 2026-11-05T13:59:36.971Z
- 分支: refs/heads/main
- 授权来源: user 2026-11-05 本会话明确授权：整条链逐任务本地提交（选项 A），不含 push／发布／归档
- 工作提交: 873f79efe57529694bfd7fcd8cca3ff0b7a2a78b
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-05-report-acceptance-context-permissions

### 任务资料提交记录

<!-- knit:metadata-commit:op-1f69577dd980 -->
- 任务资料提交: 51ec4f151a37f0ba4432b861b9d0c2363e551fc0
- 归档目标: .knit/tasks/archive/2026-11/11-05-report-acceptance-context-permissions

<!-- knit:progress:end -->
