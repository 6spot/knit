---
id: k-6c7e0d19a830
status: open
phase: discuss
outcome: null
branch: refs/heads/main
verification: self
parent: k-8ed2dceaaa4d
priority: P2
dependsOn:
  - k-4ef4cfc4095c
  - k-63006e478faa
order: null
createdAt: 2026-11-05T11:07:47.914Z
title: workflow 命令组、--stage 与桥接去静态枚举
---

## 目标

提供 `knit workflow` 命令组让 AI／用户改配置并当场校验；`run`／`context` 改用 `--stage`；桥接取消静态枚举；删除 `assist`／`advisory` 整条链路。

依据：`../11-05-role-contract-single-source/design.md` §11／§13。

## 交付物

- 新增 `src/cli/workflow.ts`：`init｜show｜validate｜add｜remove｜move｜set-prompt｜set-tools｜set-report｜set-next`；写入全量校验、失败带行号拒绝、成功回显新流程摘要。
- `src/cli/run.ts`：`--stage`；删除 `assist <mode>`、`assist_deliver_removed`、`advisory` 分支。
- `src/contracts/bridge-tools.ts`、`.pi/extensions/knit.ts`、`assets/templates/pi/extensions/knit.ts`：删除 `knit_run.action`／`knit_context.role`／`knit_run.mode` 静态枚举，按配置派生；新增 `knit_workflow`；修复 turn context 里"按 workflow.md 推进"的悬空提示。

## 规则

- 读取配置失败时退回字符串参数，由核心返回合法阶段清单，不静默通过。
- 两份桥接同步（现有测试会比对）。

## 依赖

`k-4ef4cfc4095c`、`k-63006e478faa`。验证：`npm run typecheck` + `npm test`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
