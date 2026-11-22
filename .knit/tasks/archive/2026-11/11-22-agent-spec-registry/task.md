---
id: k-84165a4f76ee
title: 收敛 Agent 规格描述表，消除业务层对具体 Agent 名的分支硬编码
status: delivered
stage: null
verification: independent
parent: k-d123fec5fa11
dependsOn: []
priority: P1
createdAt: 2026-11-22T06:32:51.331Z
---

## 目标与范围

将目前分散在 `contracts`、`domain`、`application`、`cli` 四层中的具体执行器（`pi`、`antigravity`）参数校验与缺省规则收敛为单一规格描述表，并清理 `schemaProblems` 的模块归属：

1. **建立统一的 `AgentSpec` 描述表**：
   - 现状：`src/contracts/workflow.ts` 硬编码了 `WORKFLOW_MODEL_PATTERN`、`AGY_MODEL_PATTERN`、`THINKING_LEVELS`、`AGY_EFFORT_LEVELS`；`src/domain/workflow.ts`（`agentParameterIssues`）和 `src/application/run-prepare.ts` 各自重复写了一套 `agent === "pi"` / `agent === "antigravity"` 的模型正则、思考等级范围、是否必填模型、是否继承流程顶层缺省的分支判断；`src/cli/workflow.ts` 展示缺省值时又写了一遍 `stage.agent === "antigravity"` 分支。
   - 做法：在 `src/contracts/workflow.ts`（或独立的 `src/contracts/agent-spec.ts`）中以 `AGENT_SPECS: Readonly<Record<AgentName, AgentSpec>>` 描述每个内置 Agent 的静态规格：
     - 模型格式正则与格式说明文案（如 `provider/模型`、`Antigravity 模型 ID`）；
     - 是否允许省略模型（`modelRequired`）及缺省缺失时的拒绝提示；
     - 允许的思考等级集合；
     - 是否继承流程顶层 `model`／`thinking` 及主会话缺省（`inheritsWorkflowDefaults`）；
     - `workflow show` 在未指定模型／思考等级时的展示说明。
   - 同时抽出一份纯校验/解析函数（放在 `domain/` 或 `contracts/`），**面向独立的 `{ agent, model, thinking }` 执行器目标三元组设计**（不耦合到 `WorkflowStage` 顶层字段，为后续单环节多执行器对抗审查 `k-f3d79c718b3e` 直接复用预留干净入口），由 `src/domain/workflow.ts`（解析阶段校验显式配置及省略 `agent` 时的联合匹配）和 `src/application/run-prepare.ts`（派发阶段按实际 Agent 解析与校验模型／思考等级）共同调用，彻底消除两处重复规则和业务层里的具体 Agent 名分支。
   - `src/cli/workflow.ts` 通过 `AGENT_SPECS` 渲染各环节的模型与思考等级说明，不再直接判断 `=== "antigravity"`。
2. **顺手归位 `schemaProblems`**：
   - 现状：`src/application/config.ts` 从 `src/contracts/task.ts` 导入通用校验错误格式化函数 `schemaProblems`。
   - 做法：将 `schemaProblems` 移入 `src/contracts/schema.ts`（按需在 `contracts/task.ts` 保留或更新引用），让 `config.ts`、`task-document.ts`、`task-record.ts` 统一从 `contracts/schema.ts` 导入。

边界：
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，不得修改。
- 保持 `pi` 与 `antigravity` 现有的全部校验语义、问题码（`WorkflowIssueCode`）和命令行提示语向后兼容，不新增第三个 Agent 实现，不修改 `src/adapters/antigravity/*` 或 `src/adapters/pi/*`。

## 完成条件

### Requirement: 业务层通过 AgentSpec 统一校验与解析 Agent 参数

#### Scenario: 工作流校验与派发前校验复用同一套规格且行为保持兼容

- GIVEN 包含 `pi`、`antigravity` 及省略 `agent` 环节的 `.knit/workflow.yaml` 与派发输入（含合法与非法模型名、非法思考等级、省略模型等组合）
- WHEN 分别运行 `parseWorkflow`（`knit workflow validate`）与 `prepareRun`（`knit run start`）
- THEN `pi` 要求 `provider/模型`、支持 `off`～`max`、继承流程顶层与主会话缺省、四处均缺时拒绝；`antigravity` 按 `agy` 模型 ID 与 `low`～`max` 校验、允许省略模型与思考等级；省略 `agent` 时在校验期接受任一合法规格并在派发期按实际客户端核对
- AND `src/domain/workflow.ts`、`src/application/run-prepare.ts` 与 `src/cli/workflow.ts` 中不再出现对 `"pi"` 或 `"antigravity"` 的分支硬编码（除缺省入口 Agent 常量 `DEFAULT_AGENT` 外）

### Requirement: schemaProblems 归位且全量测试通过

#### Scenario: 通用 schema 错误格式化移至 contracts/schema.ts

- GIVEN `src/application/config.ts` 与 `src/domain/task-*.ts` 的配置和任务校验路径
- WHEN 从 `src/contracts/schema.ts` 导入 `schemaProblems` 并运行 `npm run typecheck` 与 `npm test`
- THEN `config.ts` 不再依赖 `contracts/task.ts`，全部现有与新增单测在 macOS 普通终端与 Rex 终端均通过

## 待澄清

## 相关资料

- `src/contracts/workflow.ts` — 当前 Agent 名、模型正则与思考等级常量定义
- `src/contracts/schema.ts` — 通用 JSON Schema 校验封装
- `src/contracts/task.ts` — 当前错放的 `schemaProblems` 定义
- `src/domain/workflow.ts` — `agentParameterIssues` 工作流参数校验
- `src/application/run-prepare.ts` — 派发阶段模型与思考等级解析校验
- `src/application/config.ts` — 引用 `schemaProblems` 的配置加载模块
- `src/cli/workflow.ts` — `knit workflow show` 展示逻辑
- `docs/design/DESIGN.md#6-流程与角色文件` — 流程与各 Agent 模型/思考等级规则

## 结果

已建立 AGENT_SPECS 描述表与面向 { agent, model, thinking } 目标三元组的共享校验/解析函数（src/domain/agent-target.ts），workflow.ts、run-prepare.ts、cli/workflow.ts 和 cli/run.ts 不再硬编码具体 Agent 分支；schemaProblems 已归位至 src/contracts/schema.ts，config.ts 不再依赖 contracts/task.ts。完成条件全部满足。独立审查（r-a31f99530ca7）结论 pass：npm run typecheck 退出 0，macOS 普通终端与 Rex 终端 npm test 各 404/404 通过，并完成 1,680 组 parseWorkflow 兼容性对照与派发边界核验。
