---
id: k-5d624ec3f0c7
title: 优化 atomicWrite 写入路径与 .runtime 清理剪枝及残留回收
status: delivered
stage: null
verification: self
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P1
createdAt: 2026-11-27T09:49:09.106Z
---

## 目标与范围

背景：
- `src/infrastructure/fs.ts` 的 `atomicWrite` 在 `expectedSha256 === undefined`（无条件覆写）时依然同步读取整个目标文件并计算 SHA-256；且仅在 `renameSync` 失败时清理 `.knit-tmp-*` 临时文件，`writeSync` / `fsyncSync` 失败时会遗留临时碎片。
- `src/application/runtime-cleanup.ts` 的 `expiredRunIds` 扫描全部任务目录，即使绝大多数历史归档任务对应的运行目录早已不在 `.knit/.runtime/runs/` 中，依然逐份读取并完整解析每个归档任务的 `task.md`；此外 `.knit/.runtime/host-sessions/` 下的历史宿主会话状态文件及已结束任务的 `.knit/.runtime/k-*.lock` 锁文件缺少过期清理机制。

范围：
1. **`atomicWrite` 按需校验旧版本并清理写失败临时文件**（`src/infrastructure/fs.ts`）：
   - 当 `request.expectedSha256 === undefined` 时跳过读取目标文件与计算旧 SHA-256（当 `expectedSha256 === null` 或字符串时保持既有乐观锁校验与错误类型 `InfrastructureError("version_conflict")` 完全不变）。
   - 在 `openSync` 成功创建 `.knit-tmp-*` 之后，若后续 `writeSync`、`fsyncSync` 或 `renameSync` 任一步骤失败，均尝试 `unlinkSync(temp)` 清理临时文件且不掩盖原始错误。
2. **`.runtime` 清理剪枝与过期会话/锁文件回收**（`src/application/runtime-cleanup.ts`、`docs/design/DESIGN.md`）：
   - 将 `.knit/.runtime/runs/` 实际存在的目录名集合 `present` 传入 `expiredRunIds`：仍保留对各任务 `record.json` 合法性的检查（满足「损坏的 `record.json` 报错并保留运行目录」的既有安全语义），但当某个任务的 `record.json` 中没有任何 `run.id` 位于 `present` 集合内时，直接跳过该任务 `task.md` 的读取与 YAML 解析；同时保留「重复 run ID 归属不明一律保留」的既有语义。
   - 在 `retainDays` 启用且已确认位于主检出时，顺带回收超过 `retainDays`（按文件 `mtimeMs < cutoff`）、非符号链接且未被持锁的：
     - `.knit/.runtime/host-sessions/` 下的过期会话状态文件（`*.json` 与对应 `*.json.lock` 及孤立超期 `*.lock`）：若锁正在被占用（非阻塞 `withFileLock(..., 0, ...)` 返回忙）或对应 `.json` 尚未超期，则跳过不删。
     - `.knit/.runtime/` 下不再对应活跃任务的超期任务锁文件（`k-*.lock`）：跳过当前活跃任务、本次交付任务以及正在被持锁的文件。
   - 保持 `result.removed` 仅统计删除的过期运行目录数，避免破坏既有输出文案与断言；若 `.knit/.runtime/runs/`、`host-sessions/` 和任务锁均无待评估项，则直接跳过主检出检查与扫描。
   - 同步更新 `docs/design/DESIGN.md` 第 8.2 节（约第 476 行）关于 `runtime.retainDays` 清理范围的说明。
3. **测试补充**（`test/infrastructure.test.mjs`、`test/deliver.test.mjs`）：
   - 在 `test/infrastructure.test.mjs` 补充验证：`atomicWrite` 在 `expectedSha256 === undefined` 时不调用 `readFileSync` 读取既有目标文件；`writeSync`/`fsyncSync` 失败时不残留 `.knit-tmp-*` 文件且原错误透传。
   - 在 `test/deliver.test.mjs` 补充验证：大量已归档任务无现存运行目录时，`cleanArchivedRuns` 跳过读取它们的 `task.md`；超期的 `host-sessions/` 文件与非活跃任务 `.lock` 文件在交付后被回收，而未超期会话、活跃任务锁、正在持锁的文件及 `retainDays: 0 / null` 时均保留。

不在范围内：
- 不修改 `atomicWrite` 对 `expectedSha256 === null` 或字符串时的版本冲突行为（`saveTask` 捕获 `version_conflict` 留待第三波单独处理）。
- 不新增独立清理子命令（恪守 `DESIGN.md` §11 轻核心边界）。

## 完成条件

- `atomicWrite` 在 `expectedSha256 === undefined` 时不读盘校验旧文件；写入或 `fsync` 失败时无 `.knit-tmp-*` 残留。
- `cleanArchivedRuns` 对不含现存运行目录的归档任务跳过读取与解析 `task.md`，同时保留损坏 `record.json` 告警与重复 run ID 保护。
- 交付后按 `runtime.retainDays` 安全回收超期的 `host-sessions/` 与非活跃任务锁文件，不误删活跃或持锁文件，`result.removed` 既有语义不变。
- `docs/design/DESIGN.md` 第 8.2 节与实现一致。
- `npm run typecheck`、`npm run build` 和全量 `npm test` 全部通过（涉及共享底层 `src/infrastructure/fs.ts`）。

## 待澄清

无。

## 相关资料

- [src/infrastructure/fs.ts](src/infrastructure/fs.ts)
- [src/application/runtime-cleanup.ts](src/application/runtime-cleanup.ts)
- [docs/design/DESIGN.md](docs/design/DESIGN.md)
- [test/infrastructure.test.mjs](test/infrastructure.test.mjs)
- [test/deliver.test.mjs](test/deliver.test.mjs)

## 结果

完成 atomicWrite 在 expectedSha256 === undefined 时跳过旧文件读盘与写/fsync 失败临时文件清理，以及 runtime-cleanup 按现存运行目录剪枝、超期宿主会话与非活跃任务锁回收并同步 docs/design/DESIGN.md §8.2；npm run typecheck && npm run build && npm test（含跨文件系统卷）577/577 全部通过。
