---
id: k-8f1c264937ee
title: 收敛项目文件粒度、提速测试并修正过度拆分制度（主任务）
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-24T07:21:19Z
---

## 目标与范围

本主任务负责统筹落实 `docs/research/file-granularity-and-test-review.md` 的全部收敛与提速方案：先补齐防过度拆分的规范与角色提示，再做测试提速核心改造，随后按低风险到高风险逐层收敛源码文件并合并碎片测试文件。

**主任务不直接产出代码**，所有具体改动均落在子任务中分批推进与独立验证（清单与批次顺序见 `.knit/tasks/11-24-consolidate-files-and-speed-tests/plan.md`）。工作基线为已合入内置规范与统一避坑清单的 `8595bef`。

**整体目标与原则**：
1. **堵住制度漏口（Batch 0）**：补齐文件粒度门槛、测试分层与性能预算条款，修正“拆场景即建新文件”的惯性；更新通用规范、角色模板、项目开发规范、统一避坑清单与设计约定。
2. **先提速测试（Batch 1a / 1b）**：将全量 `npm test` 从 ~100–120s 压至 ~25–35s，让后续每一批源码收敛都能快速回归验证。
3. **保留 6 层架构，专注层内收敛（Batch 2–4）**：`src/` 从 77 文件（含新合入的 `src/domain/pitfalls.ts`）收至 ~51 文件，大幅减少 `<50` 行碎片文件，并消除 `adapters -> application` 反向依赖及 `antigravity -> pi` 跨适配器依赖。
4. **合并碎片测试（Batch 5）**：`test/*.test.mjs` 从 68 文件收至 ~29 文件，降级剩余只读/校验 CLI 子进程用例，预计全量 `npm test` 进一步收敛至 ~20–25s，且不削弱核心不变量。

**边界与约束**：
- 受保护文件（`.knit/standards/`、`.knit/agents/`、`.knit/workflow.yaml`、`.knit/config.json`）不能由派发的执行者修改（`workspace.ts` 的 `protectedChanges` 会拦），Batch 0 由主会话直接修改，通用模板改在 `assets/`。
- 全局安装（`npm run pack:install`）、重生成 `.knit/agents/` 副本以及随之删除 `.knit/standards/` 下 4 份旧版同名副本需单独获得用户授权，不夹带在普通子任务里（在全局 `knit` 升级前不得提前删除这 4 份旧副本）。
- 子任务分批登记：首批先登记 Batch 0、Batch 1a、Batch 1b，其余留在 `plan.md` 清单中，随前序结果按需调整。

## 完成条件

### Requirement: 全部计划批次完成并验收通过
#### Scenario: 子任务按计划顺序全部交付且全量验证通过
- WHEN `plan.md` 中列出的 Batch 0 至 Batch 5 子任务（含按需调整后的实际批次）全部完成并交付合并
- THEN 防过碎规范与角色模板已生效，`src/` 与 `test/` 文件数及全量 `npm test` 耗时达到收敛预期，且在 macOS 普通终端与 Rex 终端运行 `npm test`、`npm run typecheck`、`npm run pack:check` 均通过。

## 待澄清

## 相关资料

- `docs/research/file-granularity-and-test-review.md` — 本次收敛与提速的完整诊断、文件清单、根因与路线依据
- `.knit/tasks/11-24-consolidate-files-and-speed-tests/plan.md` — 分批子任务清单、依赖与登记状态
- `docs/design/DESIGN.md` — 现行架构与目录约定
- `.knit/standards/development.md` — 项目开发、复杂度与测试规范

## 结果

全部 7 个子任务（Batch 0–5）均已完成验收并交付合入 main（10fbcaf、9208800、cc9dc54、e6a0dd1、54de988、f576ff5、073ffe38）：防过碎规范、角色模板与设计约定已落盘；src/ 从 77 文件（76 .ts + 1 .c）收敛至 51 文件（50 .ts + 1 .c，-33.8%），消除了 adapters->application/run-lock 与 antigravity->pi 依赖违例；test/*.test.mjs 从 68 个收敛至 29 个主题文件（test/helpers/ 9→7）；npm pack 产物从 95 文件收敛至 69 文件；最终 Batch 5 独立审查验证全量 npm test 在 Rex 34.58s、普通 Apple Terminal 34.51s（526 通过、0 失败、7 跨卷在独立 APFS 卷 35/35 全绿），npm run typecheck 与 npm run pack:check 全绿。全局 npm run pack:install、重生成 .knit/agents/ 与清理 4 份旧规范副本按边界延后待用户单独授权。
