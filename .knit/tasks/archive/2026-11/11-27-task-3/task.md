---
id: k-da512fe91c28
title: 优化 takeSnapshot 归档扫描、previewDelivery 批量哈希与归档查找
status: delivered
stage: null
verification: independent
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P1
createdAt: 2026-11-27T09:16:21.258Z
---

## 目标与范围

背景：
- `src/application/workspace.ts` 中的 `takeSnapshot` 将所有 `path.startsWith(".knit/")` 文件一律纳入强制原始字节指纹，导致仓库积累数百份干净的已归档任务（`.knit/tasks/archive/**`）时，每次派发与结算都要对所有干净归档文件逐个做 `lstatSync + readFileSync + SHA-256`。
- `src/application/delivery.ts` 中的 `previewDelivery` 对每个待提交文件逐一调用 `matchesFingerprint`，每个命中 `git ` 指纹的文件都会单独拉起一次 `git hash-object` 子进程；同时对同一工作区连续执行两次 `git status`（一次按 `recorded`，一次按 `.`），并重复执行 `insideGit(root)`。
- `src/application/task-store.ts` 中的 `archiveDirectories` 按月份升序扫描（最旧月份在前），且按 ID 查找归档任务时逐份全文读入 `task.md`；`createTask` 校验 `parent` 与 `dependsOn` 时对每个 ID 重复调用 `findTask`。

范围：
1. **`takeSnapshot` 放过干净的已归档任务文件**（`src/application/workspace.ts`）：
   - 保持 `.knit/` 下的受保护路径（`workflow.yaml`、`config.json`、`standards/`、流程引用的角色文件等）与活跃任务目录（`.knit/tasks/<active>/**`）的强制原始字节指纹不变。
   - 干净的 `.knit/tasks/archive/**` 文件改用 `git <mode> <oid>`（不读盘计算 SHA-256）；若归档文件处于脏状态、非普通索引条目、位于 `protectedPaths` 或在 `before` 旧快照中记录为纯字节指纹，仍保持原始字节读取与比对，确保改动检测与旧快照结算兼容不退化。
2. **`previewDelivery` 批量指纹校验与去重 Git 调用**（`src/application/workspace.ts`、`src/application/delivery.ts`）：
   - 在 `src/application/workspace.ts` 新增批量比对函数（复用既有 `gitFingerprints` 分批调用 `git hash-object`，同时保留既有 `matchesFingerprint` 导出不破坏兼容）。
   - `previewDelivery` 改为一次性批量比对 `files` 相对 `passed` 审查快照的指纹，消除逐文件串行 `git hash-object` 子进程开销。
   - 合并 `previewDelivery` 对同一 `workspace` 的两次 `changedAmong` 调用为一次工作区全量状态采集，在内存中按与既有规则一致的精确路径/目录前缀规则拆分 `files`、`unchanged` 与 `others`；同时避免重复调用 `insideGit(root)`。
3. **归档查找降序扫描、头部初筛与多 ID 批量查询**（`src/application/task-store.ts`）：
   - `findTask` 与 `findArchivedTasks` 按归档月份**降序**（最近月份优先）扫描；`scanTasks` 保持既有排序语义不回归。
   - 在 `storedTasks` 带 `ids` 过滤时，先读取 `task.md` 前段字节（如 2KB）；当该前段已包含完整 frontmatter（`--- ... ---`）且 `taskDocumentMayHaveId` 判定不匹配时直接跳过全文读取；若 frontmatter 超出预读长度或无法确定，回退读取全文确保零漏检。
   - `createTask` 校验 `parent` 与 `dependsOn` 多个引用 ID 时合并为一次扫描，不再按 ID 逐个重复调用 `findTask`。
4. **测试补充**（`test/workspace.test.mjs`、`test/deliver.test.mjs`、`test/task-lifecycle.test.mjs`）：
   - 补充 `takeSnapshot` 对干净归档文件免读内容、对脏归档文件与活跃任务文件仍准确检出改动，以及旧字节快照兼容的测试。
   - 补充批量指纹校验（涵盖 `git` 指纹、原始字节指纹、符号链接、新增/删除及旧快照格式）与 `previewDelivery` 行为一致性测试（含单路径、目录路径、混合 `files`/`unchanged`/`others`）。
   - 补充归档查找最近月份优先、超长 frontmatter 回退不漏检，以及 `createTask` 批量引用校验的回归测试。

不在范围内：
- 不修改 `record.json` 持久化字段（不在 `record.json` 中写入提交哈希）。
- 不修改 `knit task list --archive` 的展示排序或 CLI 参数（留待第三波单独处理）。

## 完成条件

### Requirement: takeSnapshot 放过干净归档文件同时保持改动检测语义
干净的 `.knit/tasks/archive/**` 文件在 `takeSnapshot` 中使用 `git <mode> <oid>` 免读盘，而受保护路径、活跃任务、脏归档文件与旧快照兼容语义全部保持。

#### Scenario: 干净归档文件免读内容，活跃任务与受保护路径仍保留字节指纹
- GIVEN 一个 Git 仓库包含已提交的 `.knit/tasks/archive/2026-10/old/task.md`、`.knit/tasks/11-27-active/task.md`、`.knit/workflow.yaml` 和 `.knit/standards/a.md`
- WHEN 运行 `takeSnapshot(dir, protectedPaths)`
- THEN 干净的归档文件记录为 `git <mode> <oid>` 且快照过程未调用 `readFileSync` 读取它
- AND 活跃任务文件与受保护路径仍记录为原始字节指纹

#### Scenario: 归档文件被修改或旧快照结算仍准确检出
- GIVEN 已拍下 `before = takeSnapshot(dir)`（或归档文件存为纯字节的旧快照）
- WHEN 修改或删除 `.knit/tasks/archive/...` 下的文件后再次拍快照
- THEN `changesBetween` 准确包含该归档文件路径

### Requirement: previewDelivery 批量校验审查后改动并合并工作区状态查询
`previewDelivery` 对多文件审查后改动核对使用批量指纹比对，且同一工作区仅查一次状态。

#### Scenario: 多文件审查后改动批量核对结果准确且减少子进程
- GIVEN 任务已完成审查并生成包含多个 `git ` 指纹与字节指纹文件的 `after.json`，且部分文件在审查后被修改或保持未改
- WHEN 调用 `previewDelivery(root, stored)`
- THEN 每个文件的 `changedAfterReview`、`reviewed`、`unchanged` 与 `others` 判定与改造前完全一致
- AND 对多个需 `git hash-object` 的文件按批次合并调用，不逐文件串行拉起子进程

#### Scenario: 合并工作区状态查询保持精确路径与目录前缀匹配语义
- GIVEN 任务 `recorded` 同时包含单个文件路径、目录路径（带或不带尾随 `/`）、未改动路径及工作区外其他脏文件
- WHEN 调用 `previewDelivery(root, stored)`
- THEN `commit.files`、`commit.unchanged` 和 `commit.others` 与改造前完全一致

### Requirement: 归档查找降序扫描、头部初筛与批量校验引用
归档 ID 查找优先扫描最近月份并跳过明显不匹配的全文读取，多引用校验不重复扫全库。

#### Scenario: 按 ID 查找归档任务优先最近月份且超长 frontmatter 不漏检
- GIVEN 仓库中存在跨多个月份的归档任务，以及一个 frontmatter 超过预读缓冲长度的归档任务
- WHEN 通过 `findTask` / `findArchivedTasks` 按 ID 查找
- THEN 优先命中最近月份，无需读取更早月份的归档文件
- AND frontmatter 超出预读长度的归档任务仍能准确找到

#### Scenario: createTask 校验多个 parent 与 dependsOn 引用正确无回归
- GIVEN 同时指定存在和不存在的 `parent` 与多个 `dependsOn`（含活跃任务、归档任务和 Worktree 已交付任务）
- WHEN 调用 `createTask`
- THEN 存在校验结果与错误提示与改造前完全一致，且不会为每个引用重复全库扫描

### Requirement: 全量构建与测试验证通过
改造后类型检查、编译与全量测试全部通过。

#### Scenario: 完整验证回归
- WHEN 运行 `npm run typecheck && npm run build && npm test`
- THEN 类型检查、编译和所有非跳过用例全部通过

## 待澄清

无。

## 相关资料

- [src/application/workspace.ts](src/application/workspace.ts)
- [src/application/delivery.ts](src/application/delivery.ts)
- [src/application/task-store.ts](src/application/task-store.ts)
- [src/domain/task.ts](src/domain/task.ts)
- [test/workspace.test.mjs](test/workspace.test.mjs)
- [test/deliver.test.mjs](test/deliver.test.mjs)
- [test/task-lifecycle.test.mjs](test/task-lifecycle.test.mjs)

## 结果

完成 takeSnapshot 放过干净归档文件、previewDelivery 批量指纹比对与合并工作区状态查询、以及归档月份降序扫描与头部预读/多引用批量查找；独立审查中修复了子模块路径归类与 frontmatter 结束标记边界并补充回归用例，npm run typecheck && npm run build && npm test 全部通过（562/569 通过，0 失败，7 项跨文件系统测试跳过），独立审查 pass。
