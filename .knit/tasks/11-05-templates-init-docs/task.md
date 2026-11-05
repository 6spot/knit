---
id: k-402485d91cd6
status: open
phase: discuss
outcome: null
branch: refs/heads/main
verification: self
parent: k-8ed2dceaaa4d
priority: P2
dependsOn:
  - k-63006e478faa
  - k-9a6dcc91e184
  - k-6c7e0d19a830
order: null
createdAt: 2026-11-05T11:07:48.404Z
title: 模板与 init、删除 workflow.md、文档重写
---

## 目标

模板、init 与文档收口：生成带注释的 `workflow.yaml`，删除 `.knit/workflow.md`，补上"模板已移除文件"的孤儿报告，并把设计文档改写为配置解释规则。

依据：`../11-05-role-contract-single-source/design.md` §9／§12。

## 交付物

- `assets/templates/.knit/workflow.yaml`（顶部注释写全字段、能力表与常见错误）；`TEMPLATE_SPECS` 增删。
- 删除 `assets/templates/.knit/workflow.md` 与本仓库 `.knit/workflow.md`（内容按 §12 三分搬家，主会话规则已在 `AGENTS.md` 受管块）。
- `src/application/initialization.ts`：新增"模板已移除文件"的孤儿报告（默认只报不删）。
- `docs/design/DESIGN.md` §15.1／§5／§6、`STATES.md` §3/§8、`OPERATIONS.md`、`GLOSSARY.md`、`ROLE-CONTRACT.md`、`docs/README.md`、`README.md` 改写。
- 全文检索 `workflow.md`、`advisory`、`assist`、`四环节`、`role` 残留，逐条判断删除或标注为历史。

## 依赖

`k-63006e478faa`、`k-9a6dcc91e184`、`k-6c7e0d19a830`。验证：`npm test` + `knit init --check` 在临时目录实跑。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
