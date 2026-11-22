---
id: k-f3d79c718b3e
title: 支持环节配置多执行器并强制并行审查只读
status: delivered
stage: null
verification: independent
parent: k-8ac399027fac
dependsOn:
  - k-70ec54c7daf9
priority: P1
createdAt: 2026-11-22T07:28:40.283Z
---

## 目标与范围

在 `workflow.yaml` 配置契约、解析校验与展示层支持单个环节配置多个并行执行器（例如 `review` 环节同时配一个 Pi 模型和一个 Antigravity 模型做对抗验证），并静态强制并行环节只读：

1. **扩展环节配置契约（`src/contracts/workflow.ts`、`src/domain/workflow.ts`）**：
   - 允许在 `stages[]` 的单个环节中声明 `executors` 非空数组，每项描述一个执行器目标：`id`（环节内唯一标识，可选，省略时按序号生成稳定标识）、`agent`、`model`、`thinking`、`prompt`（可选，省略时继承环节的 `prompt`）。
   - 向后兼容现有单执行器写法：未写 `executors` 时，环节仍沿用现有的顶层 `agent`/`model`/`thinking`/`prompt`，解析为统一的 `WorkflowStage.executors`（长度为 1 的数组，同时保留或统一读取方式以平滑过渡）。
   - 校验规则（带准确 YAML 行号与稳定 `WorkflowIssueCode`）：
     - 同一环节中写 `executors` 时，不能同时写顶层 `agent`/`model`/`thinking`（避免歧义）；
     - `executors` 内 `id` 合法且在环节内不重复；
     - 每个执行器项复用前置任务 `k-84165a4f76ee` 的 `AgentSpec` 三元组校验规则校验 `agent`、`model`、`thinking`；
     - **并行只读硬约束**：当一个环节配置了 2 个及以上执行器时，`tools` **必须显式配置且不能包含 `write`**（省略 `tools` 或写 `tools: all` 默认包含 `write`，亦必须拒绝并给出清晰修改建议，例如改写成 `tools: [read, exec]` 或 `[read]`）。
2. **更新 `knit workflow show` 展示（`src/cli/workflow.ts`）**：
   - 多执行器环节在 `knit workflow show` 中清晰列出每个执行器的标识、Agent、模型、思考等级及角色文件，单执行器环节保持原有简洁输出。

边界：
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，不得修改。
- 本任务只改配置契约、解析校验与 `workflow show` 展示，不改派发、批次执行与进度推进逻辑（由后续子任务 `k-a629b7913d9b` 负责）。

## 完成条件

### Requirement: 环节支持声明多执行器列表且单执行器写法完全兼容

#### Scenario: 合法的多执行器只读审查环节通过校验并正确展示

- GIVEN 一份 `.knit/workflow.yaml`，其中 `implement` 使用传统单执行器写法，`review` 配置 `tools: [read, exec]` 和 `executors` 数组（同时包含一个 `pi` 模型和一个 `antigravity` 模型）
- WHEN 运行 `parseWorkflow`（`knit workflow validate`）与 `knit workflow show`
- THEN 配置校验通过，`review` 环节解析出两个带完整参数与默认角色文件的执行器定义，`workflow show` 清晰列出两者的 Agent 与模型配置，且现有单执行器工作流测试全部兼容通过

### Requirement: 多执行器环节静态禁止写权限及字段混写

#### Scenario: 多执行器环节包含 write、省略 tools 或混写顶层 agent/model 时拒绝并指出行号

- GIVEN 配置了 2 个执行器的环节，分别出现以下非法情况：`tools: [read, write, exec]`、省略 `tools`（或 `tools: all`）、同时声明顶层 `model` 与 `executors`、`executors` 内 `id` 重复或某项模型格式非法
- WHEN 运行 `parseWorkflow`（`knit workflow validate`）
- THEN 校验全部失败并给出对应 YAML 行号与可继续操作的错误说明，其中包含写权限的情况明确提示并行环节必须只读（不得含 `write`）

## 待澄清

- [assumed] 多执行器配置字段名定为 `executors`（数组项字段：`id?`、`agent?`、`model?`、`thinking?`、`prompt?`），与环节顶层的 `agent`/`model`/`thinking` 互斥；环节顶层 `prompt` 可作为 `executors` 中未单独指定 `prompt` 时的共享缺省角色文件。

## 相关资料

- `src/contracts/workflow.ts` — 工作流 Schema 与问题码定义
- `src/domain/workflow.ts` — `parseWorkflow`、`WorkflowStage` 与语义校验
- `src/cli/workflow.ts` — `knit workflow show` 与 `validate` 展示逻辑
- `docs/design/DESIGN.md#6-流程与角色文件` — 现行工作流配置设计

## 结果

已在 contracts/workflow.ts、domain/workflow.ts 与 cli/workflow.ts 支持单个环节配置非空 executors 数组（与单执行器写法归一化并保持完全兼容），校验环节内 ID 唯一性、禁止混写顶层 agent/model/thinking 与 executors，并静态强制 2 个及以上执行器的并行环节必须显式声明 tools 且不含 write（含准确行号与稳定问题码）；workflow show 清晰展示各执行器配置。完成条件全部满足。独立审查（r-4c53fb9bee5a）结论 pass（审查补修并行环节 tools: [all] 提示及多问题同时诊断）：npm run typecheck 通过，工作流测试 74/74 通过，普通终端启用临时 APFS 卷 npm test 444/444 全过，Rex 默认环境 437/444（0 失败，7 跨文件系统跳过）。未验证：实际并行派发与批次推进（归后续任务 k-a629b7913d9b）。
