---
id: k-33bf1cdb4953
title: 优化任务扫描避免默认全量读归档
status: delivered
stage: null
verification: self
parent: k-b7380720fbf3
dependsOn: []
priority: P1
createdAt: 2026-11-26T14:23:18.125Z
---

## 目标与范围

**要解决的问题**：目前 `src/application/task-store.ts` 的 `scanTasks(root)` 每次调用都会扫描 `.knit/tasks/` 与 `.knit/tasks/archive/<YYYY-MM>/` 下的全部任务，把数百个已归档任务的 `task.md` 和 `record.json` 全部读盘、算 SHA-256 并解析 YAML。导致默认只列活跃任务的 `knit task list`（不含 `--archive`）、`previewDelivery`、`initProject` 和 `prepareRun` 都会随着归档任务累积线性变慢。

**改动目标**：
- 在 `src/application/task-store.ts` 中为 `scanTasks` 增加可选参数（如 `{ includeArchived?: boolean }`），或提供只扫活跃任务 / 只扫归档任务的选项，避免不需要归档的调用方读盘解析整个归档目录：
  - `knit task list` 不带 `--archive` 时，只扫描 `.knit/tasks/` 下的活跃任务；带 `--archive` 时，只扫描 `.knit/tasks/archive/` 下的归档任务。
  - `initProject`（`src/application/init.ts`）只需判断项目是否“已有任意任务（含归档）”，发现第一个可读任务目录即可早停，不再全量解析几百个归档文件。
  - `previewDelivery`（`src/application/delivery.ts`）检查未关闭子任务（`openChildren`）时，只需扫描活跃任务（已归档任务必为 `delivered` 或 `cancelled`，不可能为未关闭子任务）。
  - `prepareRun`（`src/application/run-prepare.ts`）改为按需用 `findTask` 定位当前任务及 `dependsOn` 依赖任务，不再全量 `scanTasks(root)`。
- 优化 `findTask(root, id)` 的归档查找路径：先扫活跃任务目录；未命中时再扫归档目录，扫归档时优先从 `task.md` 头部快速匹配 `id:` 字段，只有 `id` 命中时才读取 `record.json`、算 SHA-256 和完整解析 YAML，降低查找单个归档任务或不存在 ID 的开销。

**明确不做 / 边界**：
- 不改变 `knit task list`、`knit task list --archive`、`knit task show`、`knit deliver --preview`、`knit run start` 的任何输出格式和语义（包括损坏任务仍能被定位并报告错误）。
- 不引入缓存文件、索引文件或本机数据库（保持「一个事实只存一处」原则）。
- 不修改 Worktree 中的受保护路径（`.knit/workflow.yaml`、`.knit/config.json`、`.knit/standards/`、`.knit/agents/`）。

## 完成条件

### Requirement: 按需扫描活跃任务与归档任务
#### Scenario: `knit task list` 默认只扫描活跃任务，带 `--archive` 只扫描归档任务
- WHEN 项目同时存在活跃任务和已归档任务，分别调用 `scanTasks`（仅活跃/仅归档/全部）与 `knit task list` / `knit task list --archive`
- THEN 默认列表只包含活跃任务且不读取归档目录中的文件；`--archive` 列表只包含归档任务且输出排序、格式与损坏任务提示与原有行为一致

#### Scenario: `previewDelivery`、`initProject` 和 `prepareRun` 不再全量解析归档任务
- WHEN 项目存在大量归档任务（含损坏或正常归档），运行交付预览、重复 `knit init` 检查及带归档依赖的 `prepareRun`
- THEN `previewDelivery` 仍准确列出未关闭子任务；`initProject` 在仅有归档任务时不重复建初始化任务；`prepareRun` 对存在、未合并、已取消及缺失的依赖检查结果与原有行为完全一致

### Requirement: `findTask` 按 ID 查找归档任务时跳过无关归档的完整解析
#### Scenario: 查找活跃任务、归档任务、损坏任务及不存在的 ID
- WHEN 调用 `findTask` 查找活跃任务、位于归档中的任务、frontmatter 损坏但保留 `id:` 行的归档任务，以及 Worktree 归档任务或不存在的 ID
- THEN 均返回与原有行为完全一致的结果，且对无关归档任务不执行完整的 `record.json` 读取与完整文档解析

## 待澄清

## 相关资料

- `src/application/task-store.ts` — 任务扫描、按 ID 查找与读写核心
- `src/cli/task.ts` — `knit task list` 调用入口
- `src/application/delivery.ts` — `previewDelivery` 的 `openChildren` 扫描
- `src/application/init.ts` — `initProject` 判断是否已有任务
- `src/application/run-prepare.ts` — `prepareRun` 的任务与依赖查找
- `test/task-lifecycle.test.mjs` — 任务列表与生命周期测试

## 验证与交付

- 运行 `npm run typecheck`、`npm run build`、`node --test test/task-lifecycle.test.mjs test/deliver.test.mjs test/init.test.mjs test/run-prepare.test.mjs`，再补跑全量 `npm test`（因修改核心共享存储层 `task-store.ts`），全部通过。
- 改动留在任务 Worktree 分支，不自行提交，交由主会话核对并交付。

## 结果

已优化任务扫描与查找：scanTasks 支持 active/archived/all 三种范围，knit task list、previewDelivery 按需只扫活跃或归档，initProject 改用 hasTasks 首条早停，prepareRun 按 ID 查找任务与依赖，findTask 扫归档先按 task.md 头部快速筛选 ID，命中后再读 record.json 与完整解析。验证：npm run typecheck、npm run build、git diff --check 通过；定向测试 71/71 通过；全量 npm test 506 通过、0 失败、7 项跨文件系统跳过。
