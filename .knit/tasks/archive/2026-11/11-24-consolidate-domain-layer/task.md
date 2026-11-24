---
id: k-5ef09986911a
title: 收敛 domain 层任务与规则碎文件
status: delivered
stage: null
verification: self
parent: k-8f1c264937ee
dependsOn:
  - k-e79d357c7827
priority: P2
createdAt: 2026-11-24T00:46:58.299Z
---

## 目标与范围

落地 `docs/research/file-granularity-and-test-review.md` 第 3.3 节与第 9 节的 **Batch 3**：将 `src/domain/` 从 12 个文件（含 `pitfalls.ts`）收敛至 7 个文件（净减少 5 个），保持纯领域逻辑与全部不变量零变化。

**为什么做**：
`src/domain/` 中任务文档编解码与 Markdown 标题切分分散在 4 个 39–97 行的文件里，`agent-target.ts`（22 行）和 `stage-rules.ts`（40 行）均为极薄的单主题碎片。将其按领域聚合归位，减少跨文件跳转并保持纯领域零 IO 边界。

**改动范围（范围内）**：
1. **`domain/agent-target.ts`（22 行）→ 并入 `domain/workflow.ts`**：集中管理工作流与派发阶段的 `(agent, model, thinking)` 校验。
2. **`domain/stage-rules.ts`（40 行）→ 并入 `domain/report.ts`**：与报告 JSON 代码块解析及校验形成环节规则与报告契约闭环（保持 `stageRules` 受保护路径列表与 `application/workspace.ts:protectedChanges` 一致，避免扩大 731 行的 `workflow.ts`）。
3. **`domain/task-document.ts`（97 行）+ `domain/task-record.ts`（51 行）+ `domain/task-references.ts`（39 行）+ `domain/markdown.ts`（56 行）→ 合并为 `domain/task.ts`**（合计约 243 行，清晰收口任务双文件编解码、相关资料解析与 `#标题` 章节提取）。
4. **保持独立**：`domain/workflow.ts`、`domain/report.ts`、`domain/task.ts`、`domain/task-requirements.ts`、`domain/progress.ts`、`domain/standards.ts`、`domain/pitfalls.ts`（共 7 个文件）。
5. 同步更新全仓库 `src/` 与 `test/` 中受影响的导入路径（行为与导出语义保持等价）。

**边界（范围外）**：
- 本任务**不做** `src/application/` 文件合并（Batch 4），也**不做** `test/*.test.mjs` 文件合并（Batch 5，仅更新导入路径）。
- `src/domain/` 保持纯领域无文件 IO 边界，不引入 `node:fs` 或依赖 `application/`、`adapters/`、`cli/`。
- 不修改受保护路径（`.knit/standards/`、`.knit/agents/`、`.knit/workflow.yaml`、`.knit/config.json`）。
- 不运行 `npm run pack:install`。

**验证与交付**：
- 运行 `npm run typecheck`、`npm run pack:check` 与 `npm test`（并特别确认任务与领域相关单测全绿），核对 `src/domain/` 仅余 7 个文件且全仓库无已删除旧路径的残留导入。
- 完成后改动留在任务分支，由主会话复验并待用户授权后交付合并。

## 完成条件

### Requirement: domain 层从 12 文件收敛至 7 文件且保持纯领域边界
#### Scenario: 6 个碎文件归位且无旧路径残留
- WHEN 完成 `agent-target`、`stage-rules` 与任务文档 4 文件的合并并更新所有导入路径
- THEN `src/domain/` 仅保留 7 个文件（`workflow.ts`、`report.ts`、`task.ts`、`task-requirements.ts`、`progress.ts`、`standards.ts`、`pitfalls.ts`），全仓库不存在对已删除旧路径的导入，且 `src/domain/` 不依赖 `node:fs` 或上层目录。

### Requirement: 行为等价与检查通过
#### Scenario: 类型检查、打包检查与测试通过
- WHEN 运行 `npm run typecheck`、`npm run pack:check` 与 `npm test`
- THEN 类型检查与打包检查通过，全部未受沙箱限制的测试通过（如有沙箱受限测试须如实写明具体用例），且领域层全部单测通过。

## 待澄清

## 相关资料

- `docs/research/file-granularity-and-test-review.md#3-src-全量-6-层诊断与收敛方案` — `domain/` 层合并清单与理由
- `src/domain/` — 领域层目录

## 结果

已完成 Batch 3（src/domain/ 层 12 → 7 文件收敛），2 个完成条件均已满足。将 task-document.ts、task-record.ts、task-references.ts、markdown.ts 合并为 src/domain/task.ts，agent-target.ts 并入 workflow.ts，stage-rules.ts 并入 report.ts，保留 pitfalls.ts、standards.ts、progress.ts、task-requirements.ts 共 7 个纯领域文件，同步更新全仓库导入路径。

已验证：主会话复核 src/domain/ 仅余 7 个文件、零旧模块导入残留、零 node:fs 或上层导入；npm run typecheck 与 npm run pack:check 通过；执行者在 Rex 环境与清除 Rex 变量的独立伪终端各跑一次 npm test 均为 531 pass / 0 fail / 7 skip，另挂载临时 APFS 卷补跑 7 条跨文件系统用例 7/7 通过（合计 538/538 全绿）。
