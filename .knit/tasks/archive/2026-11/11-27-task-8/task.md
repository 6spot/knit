---
id: k-9cee30b3431f
title: 修复 task.md 解析（CRLF 与代码围栏）、savePitfall 权限与 archiveTask 跨卷移动
status: delivered
stage: null
verification: self
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P1
createdAt: 2026-11-27T11:24:07.882Z
---

## 目标与范围

背景：
- `src/domain/task-requirements.ts` 中 `scenarioStateOf` 已完整跟踪 Markdown 代码围栏（`` ``` `` / `~~~`），但同文件中的 `clarifyStateOf` 未跳过代码围栏，导致任务正文示例代码块中的 `## 待澄清`、`## ...`、`- [blocking] ` 或 `- [assumed] ` 会干扰待澄清解析甚至错误阻塞 `knit task ready`。
- `src/domain/task.ts` 的 `taskFrontmatter` 仅匹配 LF（`/^---\n([\s\S]*?)\n---(?:\n|$)/`），且 `src/application/task-store.ts` 的 2 KiB 头部预读也只检查 `---\n` / `\n---\n`，导致使用 CRLF（`\r\n`）保存的 `task.md` 解析失败或无法按 ID 命中。
- `src/application/project-config.ts` 的 `savePitfall` 调用 `atomicWrite` 未显式传 `mode: 0o644`，默认以 `0o600` 权限落盘，与 `task.md` / `record.json` 等入库文件权限不一致。
- `src/application/task-store.ts` 的 `archiveTask` 直接调用 `renameSync`，在主检出与目标归档目录位于不同文件系统时会抛出 `EXDEV` 错误，而 `src/infrastructure/fs.ts` 已有现成的 `moveDirectory`。

范围：
1. **`clarifyStateOf` 感知代码围栏**（`src/domain/task-requirements.ts`）：
   - 抽取或复用与 `scenarioStateOf` 相同的代码围栏（`^ {0,3}(`{3,}|~{3,})(.*)$`）状态跟踪逻辑，从文档开头跟踪围栏，忽略围栏内的 `## 待澄清` 标题、后续一级/二级标题以及 `- [blocking] ` / `- [assumed] ` 列表项。
2. **`task.md` 解析与预读兼容 CRLF**（`src/domain/task.ts`、`src/application/task-store.ts`）：
   - `parseTaskDocument`、`taskDocumentMayHaveId`、`unparsedTaskId` 对输入文本统一先将 `\r\n` 规范化为 `\n`（保留文件原始字节用于 `stored.versions.task` 乐观锁哈希，不改动既有 LF 行为）。
   - `src/application/task-store.ts` 的 `readTaskBytes` 预读初筛同样兼容 `\r\n`（当 2 KiB 缓冲恰截断在结束标记处时保守回退读取全文）。
3. **`savePitfall` 使用 `0o644` 权限写入**（`src/application/project-config.ts`）：
   - 在 `savePitfall` 的 `atomicWrite` 调用中传入 `mode: 0o644`。
4. **`archiveTask` 改用 `moveDirectory`**（`src/application/task-store.ts`）：
   - 用 `src/infrastructure/fs.ts` 的 `moveDirectory` 替代 `renameSync`，并清理不再使用的 `renameSync` 导入。
5. **测试补充**（`test/task-domain.test.mjs`、`test/standards.test.mjs`、`test/task-lifecycle.test.mjs`）：
   - 在 `test/task-domain.test.mjs` 补充测试：围栏代码块内的 `## 待澄清`、`## 其它`、`- [blocking] `、`- [assumed] ` 不影响 `clarifyStateOf`；CRLF 格式的 `task.md` 能正常执行 `parseTaskDocument`、`taskDocumentMayHaveId`、`unparsedTaskId` 且 `requirementDigest` 与等价 LF 文档一致。
   - 在 `test/standards.test.mjs` 补充验证 `savePitfall` 生成或更新 `.knit/standards/pitfalls.md` 的文件权限为 `0o644`（按 `statSync(path).mode & 0o777` 核对）。
   - 在 `test/task-lifecycle.test.mjs` 补充测试：CRLF 归档/活跃 `task.md` 可经 `findTask` 正常命中（含 2 KiB 预读路径）；`archiveTask` 在 `renameSync` 抛出 `EXDEV`（或跨目标目录）时通过 `moveDirectory` 成功完成归档且不留残缺目录。

不在范围内：
- 不改变 `task.md` 渲染输出格式（写回仍统一输出 LF）。
- 不修改状态流转、任务锁或交付授权逻辑。

## 完成条件

- `clarifyStateOf` 与 `scenarioStateOf` 一致忽略 `` ``` `` / `~~~` 代码围栏内的标题与未决项。
- CRLF 格式的 `task.md` 在解析、ID 查找（含 2 KiB 预读）与需求摘要计算中与 LF 文档行为一致。
- `savePitfall` 写入的 `.knit/standards/pitfalls.md` 权限为 `0o644`。
- `archiveTask` 使用 `moveDirectory` 处理归档移动，跨文件系统 `EXDEV` 场景下可正常完成归档。
- `npm run typecheck`、`npm run build` 和受影响测试（`node --test test/task-domain.test.mjs test/standards.test.mjs test/task-lifecycle.test.mjs test/deliver.test.mjs`）全部通过。

## 待澄清

无。

## 相关资料

- [src/domain/task-requirements.ts](src/domain/task-requirements.ts)
- [src/domain/task.ts](src/domain/task.ts)
- [src/application/task-store.ts](src/application/task-store.ts)
- [src/application/project-config.ts](src/application/project-config.ts)
- [src/infrastructure/fs.ts](src/infrastructure/fs.ts)
- [test/task-domain.test.mjs](test/task-domain.test.mjs)
- [test/standards.test.mjs](test/standards.test.mjs)
- [test/task-lifecycle.test.mjs](test/task-lifecycle.test.mjs)

## 结果

完成 clarifyStateOf 共用代码围栏过滤、task.md 解析与 2 KiB 预读 CRLF 兼容、savePitfall 显式 0o644 权限写入与 archiveTask 改用 moveDirectory 跨卷支持；npm run typecheck && npm run build 及定向测试（task-domain/standards/task-lifecycle/deliver）89/89 通过。
