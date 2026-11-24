---
id: k-e79d357c7827
title: 收敛 contracts、infrastructure、cli 与 adapters 薄文件并消除分层违例
status: delivered
stage: null
verification: self
parent: k-8f1c264937ee
dependsOn:
  - k-47bf688a1643
priority: P2
createdAt: 2026-11-24T00:46:58.160Z
---

## 目标与范围

落地 `docs/research/file-granularity-and-test-review.md` 第 3.1、3.2、3.5、3.6 节与第 9 节的 **Batch 2**：在不改变任何对外命令行、运行时行为和 6 层顶层架构的前提下，收敛 `contracts`、`infrastructure`、`cli`、`adapters` 四层的 13 个过碎／空壳文件，并消除 2 处既有分层违例。

**为什么做**：
这四层存在大量 6–48 行的极薄文件、零引用 barrel 与跨层错位原语（例如 `adapters/antigravity/execution.ts` 反向导入 `application/run-lock.ts`，`adapters/antigravity/broker.ts` 跨适配器导入 `adapters/pi/session-env.ts`，以及 `cli/task.ts` 被其他 CLI 文件跨引用）。先收口底层、适配层与 CLI 层，可为后续 Batch 3（`domain/`）与 Batch 4（`application/`）建立干净的依赖底盘。

**改动范围（范围内）**：
1. **`src/contracts/`（7 → 4 文件，-3）**：
   - `contracts/pane.ts`（15 行）并入 `contracts/agent.ts`。
   - `contracts/digest.ts`（15 行）+ `contracts/schema.ts`（36 行）合并为 `contracts/primitives.ts`（严禁引入 `node:fs` 或依赖 `infrastructure/`）。
   - `contracts/frames.ts`（31 行，仅被 `adapters/pi/connection.ts` 调用）迁回并入 `adapters/pi/connection.ts`。
   - 保留 `contracts/agent.ts`、`contracts/task.ts`、`contracts/workflow.ts`、`contracts/primitives.ts`。
2. **`src/infrastructure/`（6 → 3 文件，-3）与消除 2 处分层违例**：
   - `infrastructure/atomic.ts` + `directory.ts` + `fingerprint.ts` + `errors.ts` 合并为 `infrastructure/fs.ts`（保留 `EXDEV` 跨文件系统移动与补回、`lstatSync` 不追踪符号链接、`expectedSha256` 乐观锁与 `fsync` 原子写不变量）。
   - 保留 `infrastructure/paths.ts` 与 `infrastructure/process.ts`。
   - 将 `adapters/pi/session-env.ts`（7 行）与 `application/run-lock.ts` 中通用的文件锁原语 `withFileLock`（保持锁机制和超时行为等价）下沉至 `infrastructure/process.ts`；更新 `adapters/antigravity/execution.ts` 直接使用 `infrastructure/process.ts` 的 `withFileLock`、`adapters/antigravity/broker.ts` 与 `adapters/pi/runtime.ts` 直接使用 `infrastructure/process.ts` 的环境清理函数，彻底消除 `adapters -> application` 反向依赖与 `antigravity -> pi` 跨适配器依赖（`application/run-lock.ts` 暂改为复用 `withFileLock`，其本身并入 `run-control.ts` 留到 Batch 4）。
3. **`src/cli/`（10 → 6 文件，-4）**：
   - `cli/root.ts`（8 行）+ `cli/worktree.ts`（29 行）+ 当前散落在 `cli/task.ts` 中被其他 CLI 文件跨引用的公共辅助（`fail`、`knitRoot`、`loadTask`、`shownStatus` 等）收拢为 `cli/shared.ts`，消除其他 CLI 文件跨引 `cli/task.ts`。
   - `cli/init.ts` + `cli/context.ts` + `cli/standards.ts` + `cli/workflow.ts` 合并为 `cli/project.ts`（保留对外的 `loadWorkflow` 导出或移至 `cli/shared.ts`）。
   - 保留 `cli/knit.ts`、`cli/task.ts`、`cli/run.ts`、`cli/deliver.ts`、`cli/shared.ts`、`cli/project.ts`。
4. **`src/adapters/`（18 → 15 文件，-3）**：
   - 删除零源码引用的 `adapters/pi/index.ts`（更新 `test/pi-runtime.test.mjs` 直接导入具体模块）。
   - 删除迁出后的 `adapters/pi/session-env.ts`。
   - 将 6 行 `adapters/antigravity/pane.ts` 并入 `adapters/antigravity/client.ts`（统一支持 `hook`/`command`/`pane` 三种 `kind`，注意 `pane` 分支按需动态导入 `./execution.js` 以免 `hook`/`command` 短进程加载重型沙箱与执行模块），同步更新启动它的调用方及 `scripts/pack-check.mjs` 中对 `dist/adapters/antigravity/pane.js` 的条目检查。
5. 同步更新全仓库 `src/` 与 `test/` 中受影响的导入路径（行为零变化）。

**边界（范围外）**：
- 本任务**不做** `src/domain/` 收敛（Batch 3）、**不做** `src/application/` 文件合并（Batch 4，除 `run-lock.ts` 复用下沉的 `withFileLock` 及更新导入外）、**不做** `test/*.test.mjs` 文件合并（Batch 5）。
- 不修改受保护路径（`.knit/standards/`、`.knit/agents/`、`.knit/workflow.yaml`、`.knit/config.json`）。
- 不修改对外 CLI 命令行参数、退出码、输出文案、持久化格式或沙箱策略。
- 不运行 `npm run pack:install`。

**验证与交付**：
- 运行 `npm run typecheck`、`npm run pack:check` 与 `npm test`（若运行环境受沙箱限制，如实列出受限用例，所有无受限测试须全绿）；核对合并后的目录文件数（`contracts` 4、`infrastructure` 3、`cli` 6、`adapters` 15）以及 `grep` 确认 `src/adapters/` 不再导入 `../application/run-lock` 且 `src/adapters/antigravity/` 不再导入 `../pi/`（`host-hook.ts`、`pane-worker.ts` 与窗格入口调用应用层用例属于既定入站驱动方向，保持不动）。
- 完成后改动留在任务分支，由主会话在无沙箱环境复验并待用户授权后交付合并。

## 完成条件

### Requirement: contracts、infrastructure 与 adapters 收敛并消除两处分层违例
#### Scenario: 文件数达标且两处目标依赖违例消除
- WHEN 完成 `contracts`（7→4）、`infrastructure`（6→3）与 `adapters`（18→15）的文件合并与原语下沉
- THEN `src/contracts/`、`src/infrastructure/`、`src/adapters/` 文件数分别为 4、3、15，已删除旧碎片文件无残留引用，`src/adapters/` 不再导入 `../application/run-lock`（入站驱动适配如 `host-hook` / `runPaneSession` 对应用层用例的调用按现行架构保留），`src/adapters/antigravity/` 不存在对 `../pi/` 的导入，且 `contracts/primitives.ts` 不依赖 `node:fs` 或 `infrastructure/`。

### Requirement: cli 层收敛并理顺内部依赖
#### Scenario: cli 从 10 文件收至 6 文件且不再跨引 cli/task.ts
- WHEN 将 `cli/root.ts`、`cli/worktree.ts` 与共享辅助收拢至 `cli/shared.ts`，并将 4 个轻量项目命令合并为 `cli/project.ts`
- THEN `src/cli/` 仅保留 6 个文件（`knit.ts`、`shared.ts`、`project.ts`、`task.ts`、`run.ts`、`deliver.ts`），除 `cli/knit.ts` 注册子命令外无其他 CLI 文件跨引 `cli/task.ts`。

### Requirement: 行为等价与全链路检查通过
#### Scenario: 类型检查、打包检查与测试回归全部通过
- WHEN 运行 `npm run typecheck`、`npm run pack:check` 与 `npm test`
- THEN 类型检查与打包检查（含更新后的 `scripts/pack-check.mjs`）均通过，全部未受环境沙箱限制的测试通过且无任何行为退化（如有沙箱受限测试须如实写明具体用例）。

## 待澄清

## 相关资料

- `docs/research/file-granularity-and-test-review.md#3-src-全量-6-层诊断与收敛方案` — 逐文件合并清单与不变量说明
- `src/contracts/` — 契约层目录
- `src/infrastructure/` — 基础设施层目录
- `src/cli/` — CLI 层目录
- `src/adapters/` — 适配器层目录
- `src/application/run-lock.ts` — 需下沉通用 `withFileLock` 的锁实现
- `scripts/pack-check.mjs` — 打包产物检查清单

## 结果

已完成 Batch 2（contracts、infrastructure、cli 与 adapters 层薄文件收敛并消除两处分层违例），3 个完成条件均已满足。四层源码净减少 13 个文件：contracts 7→4（agent.ts、primitives.ts、task.ts、workflow.ts；frames.ts 迁入 adapters/pi/connection.ts）、infrastructure 6→3（fs.ts、paths.ts、process.ts；下沉 withFileLock 与执行器环境清理）、cli 10→6（knit.ts、shared.ts、project.ts、task.ts、run.ts、deliver.ts）、adapters 18→15（删 pi/index.ts 与 pi/session-env.ts，antigravity/pane.ts 并入 client.ts 并同步更新 scripts/pack-check.mjs）。

已验证：主会话复核目录文件数（4/3/6/15）、零目标分层违例（无 adapters→application/run-lock、无 antigravity→pi、primitives.ts 无 fs/infrastructure 依赖、cli 无跨引 task.js）、npm run typecheck 通过、npm run pack:check 通过（包内文件 95→82）；执行者（无沙箱）运行全量 npm test 531 pass / 0 fail / 7 skip，另挂载临时 APFS 卷补跑 7 条跨文件系统用例 7/7 通过（合计 538/538 通过）。

未验证：尚未在普通终端与 Rex 终端双跑复验全量 npm test（本次已在 Rex 窗格下的 Pi 环境完整跑通 538/538）。
