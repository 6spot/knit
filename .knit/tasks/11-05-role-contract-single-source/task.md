---
id: k-8ed2dceaaa4d
status: open
phase: discuss
outcome: null
branch: refs/heads/main
verification: independent
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-05T08:45:16.626Z
title: 角色契约单一来源：消除增删角色的硬编码面
---

## 拆分（5 个子任务，按依赖顺序执行；父任务负责总体验收）

| 子任务目录 | 内容 | 前置 |
| --- | --- | --- |
| `11-05-config-layer-yaml-workflow` | 配置层：YAML 解析、校验、降级、默认模板（plan P1） | — |
| `11-05-stage-model-transitions` | 阶段模型与状态机：`stage` 字段、锚点、转移与回退上限（P2） | 配置层 |
| `11-05-report-acceptance-context-permissions` | 报告声明校验、接收流转、顶部提示行、能力权限（P3、P4） | 阶段模型 |
| `11-05-workflow-cli-and-bridge` | `workflow` 命令组、`--stage`、桥接去静态枚举、删 `assist`／`advisory`（P5、P6） | 配置层、阶段模型 |
| `11-05-templates-init-docs` | 模板与 init、删 `workflow.md`、孤儿报告、文档重写（P7、P8） | 阶段模型、报告、CLI |

- 每个子任务验证：`self`（`npm test` + 各自场景）。
- 父任务验证：`independent`，全部子任务完成后按 `design.md` §14 场景 1–10 复核。
- 实施按子任务逐个授权；未授权的子任务保持 discuss。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-05T11:07:41.378Z
- 方式: self → independent；理由: 改动横跨状态机、契约、CLI、桥接、模板与文档，自检兜不住

<!-- knit:progress:end -->
