---
id: k-4ef4cfc4095c
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-8ed2dceaaa4d
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-05T11:07:41.823Z
title: 配置层：workflow.yaml 解析、校验与降级
---

## 目标

把 `.knit/workflow.yaml` 读成 `WorkflowDefinition`：解析、校验、非法配置降级。本任务只做数据层，不接线到状态机、CLI、桥接。

依据：`../11-05-role-contract-single-source/design.md` §4／§9／§10。

## 交付物

- `src/domain/workflow.ts`：YAML 解析（复用 `yaml@2.9.0`）、校验、`WorkflowDefinition`、降级推导与原因码、内置默认模板常量（顶部注释写全字段说明与常见错误）。
- `src/contracts/workflow.ts`：配置 schema、校验结果结构、`workflowMode`。
- `test/workflow.test.mjs`：合法／非法用例各 10+，含行号与降级原因。

## 规则

- `version` 只支持 `1`；`stages` 非空且有序；`id` 限 `^[a-z][a-z0-9-]{0,31}$` 且唯一。
- `onVerdict` 目标必须存在；回退环必须有上限（阶段 `maxVisits`，缺省 `config.workflow.maxRepairRounds`）。
- `tools` 取值仅 `read`／`write`／`exec`／`task`／`external`／`network`；`report` 类型仅 `string`／`string[]`／`paths`／`bool`／枚举数组。
- 降级目标：`start → deliver`，附原因码；注释不参与解析结果与任何比较；错误消息带 YAML 行号。

## 验证

`npm run typecheck` + `npm test`（新测试通过）。不修改现有行为，不新增依赖。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 实施结果（run-5401d5cbb238）

- 新增 `src/domain/workflow.ts`：`parseWorkflow`（YAML 解析 → 结构 schema → 语义校验 → `WorkflowDefinition`）、`fallbackWorkflowDefinition`、`DEFAULT_WORKFLOW_YAML`（带完整字段注释与常见错误说明）。
- 新增 `src/contracts/workflow.ts`：配置 schema、`WorkflowMode`（config/fallback）、能力名、报告字段类型、问题码与校验结果结构。
- 新增 `test/workflow.test.mjs`：38 例合法／非法用例。
- `src/domain/README.md`：索引补 `workflow.ts` 一行。

判定要点：`version` 只接受 1；`stages` 非空有序；`id` 限 `^[a-z][a-z0-9-]{0,31}$`、唯一且不可占用锚点 `start`／`deliver`；`onVerdict` 目标限已声明阶段 id 或 `deliver`（`start` 被拒），键必须在 `report` 枚举中声明；回退环上所有阶段都无有限上限时降级为 `unbounded_repair_cycle`。非法配置一律返回 `start → deliver` 的降级定义并附问题码与 YAML 行号，不抛异常。

### 验证（主会话复核 2026-11-05）

- `npm run typecheck`：通过。
- `node --test test/workflow.test.mjs`：38/38 通过。
- `npm test`：482/482 通过（含既有全部用例）。
- 主会话独立探针（临时脚本，不入库）：默认模板 → `mode=config`、`stages=[implement,check]`、`defaultMaxVisits=2`；缩进错误 → `fallback/yaml_parse_error@L4`；重复 id → `duplicate_stage_id@L4`；`version: 2` → `unsupported_version@L1`；`stages: []` → `empty_stages@L2`；`onVerdict` 指向不存在阶段 → `unknown_on_verdict_target@L7`；`maxVisits: null` 双向环 → `unbounded_repair_cycle@L4,L10`；`maxRepairRounds: null` + 双向环 → 降级；未传或为 0 时按 2 处理、不降级；`prompt` 文件缺失不降级；未知能力 → `invalid_tools@L4`；未声明字段 → `invalid_structure@L4`。

未覆盖（后续任务承担）：CLI `workflow` 命令组与 `show`／`doctor` 降级可见性（P5）、阶段流转接线（P2）、报告声明与接收（P3）。

### 交付记录

<!-- knit:delivery:op-f8c6417d893b -->
- 操作: op-f8c6417d893b
- 时间: 2026-11-05T11:42:51.851Z
- 分支: refs/heads/main
- 授权来源: user 2026-11-05 本会话明确授权：整条链逐任务本地提交（选项 A），不含 push／发布／归档
- 工作提交: 0b394bf51670bbefd8cca46d153109aff1c4223f
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-05-config-layer-yaml-workflow

### 任务资料提交记录

<!-- knit:metadata-commit:op-f8c6417d893b -->
- 任务资料提交: 2eb4c18e06a89dcaa69ebd57a98c915755dac273
- 归档目标: .knit/tasks/archive/2026-11/11-05-config-layer-yaml-workflow

<!-- knit:progress:end -->
