---
id: k-4ef4cfc4095c
status: open
phase: discuss
outcome: null
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

<!-- knit:progress:end -->
