---
id: k-353d74968068
title: 收敛 application 层运行控制、配置与交接碎文件
status: delivered
stage: null
verification: independent
parent: k-8f1c264937ee
dependsOn:
  - k-5ef09986911a
priority: P2
createdAt: 2026-11-24T01:07:19.385Z
---

## 目标与范围

落地 `docs/research/file-granularity-and-test-review.md` 第 3.4 节与第 9 节的 **Batch 4**：将 `src/application/` 从 24 个文件收敛至 **16 个文件（净减少 8 个）**，收口高度分散的 `run-*`（9→4）、项目配置加载（3→1）、交接资料（2→1）与会话上下文渲染（2→1），同时严守高风险执行控制、锁与结算逻辑的零行为退化。

**为什么做**：
`src/application/` 仅 `run-*.ts` 就拆了 9 个小文件，且存在 `workflow-store.ts`（15 行）、`run-lock.ts`（已下沉底层 `withFileLock` 后仅余薄任务锁封装）、`task-materials.ts`（56 行，仅 `handoff.ts` 单调用方）、`session-output.ts`（与 `session-context.ts` 互为构造与渲染）等碎片。收敛后模块边界清晰，消除同层碎文件间互相导出内部常量与类型。

**改动范围（范围内）**：
1. **项目配置与规范加载（3 → 1）**：
   - `application/config.ts` + `application/standards-store.ts` + `application/workflow-store.ts` 合并为 `application/project-config.ts`。
   - 必须完整保留：内置 `assets/standards/` 加载与旧副本迁移提示、`.knit/standards/pitfalls.md` 锁保护写入（`recordPitfall`）、按路径排序递归扫描项目规范、`workflow.yaml` 缺失提示 `knit init`、`config.json` 字段校验。
2. **交接与上下文（4 → 2）**：
   - `application/task-materials.ts` 并入 `application/handoff.ts`（保持仓库资料读 Worktree、`.knit/tasks/` 读主检出绝对路径、字节上限裁剪与避坑分区选取不变量）。
   - `application/session-output.ts` 并入 `application/session-context.ts`（保持任务状态不变时输出逐字不变的不变量）。
3. **执行运行时与进程控制（6 → 2，`run-*` 总计 9 → 4）**：
   - `application/run-pane.ts` + `application/run-session.ts` 并入 `application/run-execute.ts`（保持窗格先发布 `outcome.json` 再退出、仅补报一次、续聊写入 `session-file.txt`、失败回退后台与完整交接不变量）。
   - `application/run-process.ts` + `application/run-lock.ts` 并入 `application/run-control.ts`（保持 `DEFAULT_STOP_GRACE_MS = 5000`、`KNIT_STOP_GRACE_MS`、`waitRun` 退避轮询与 `pollMs`、`withTaskRunLock` / `taskRunLockHeld`、进程树取消与竞态处理不变量）。
4. **明确保留独立的 11 个核心文件**：
   - `run-prepare.ts`、`run-finish.ts`、`delivery.ts`、`task-store.ts`、`task-lifecycle.ts`、`worktree.ts`、`workspace.ts`、`init.ts`、`host-hook.ts`、`host-command.ts`、`work-choice.ts`（加上上述 5 个合并目标，总计 **16 个文件**）。
5. 同步更新全仓库 `src/`（含 `adapters/` 中调用 `runPaneSession`/`SESSION_FILE_LOCATOR` 的入口与 `cli/`）及 `test/` 中受影响的导入路径，行为与外部接口保持完全等价。

**边界（范围外）**：
- 本任务**不做** `test/*.test.mjs` 文件合并（留 Batch 5，仅更新测试导入路径），不删减任何测试用例。
- 不修改受保护路径（`.knit/standards/`、`.knit/agents/`、`.knit/workflow.yaml`、`.knit/config.json`）。
- 不改动 `run-prepare`、`run-finish`、`delivery`、`workspace` 的既有业务语义、快照保护与事务回滚逻辑。
- 不运行 `npm run pack:install`。

**验证与交付**：
- 运行 `npm run typecheck`、`npm run pack:check` 与全量 `npm test`（Rex 与清除 Rex 环境变量的普通终端各跑一次；如有跨文件系统测试按环境情况说明）；核对 `src/application/` 仅余 16 个文件且全仓库无已删除旧路径的残留引用。
- 需独立审查（`verification: independent`），重点核对执行控制、锁、窗格/续聊结算、内置规范与避坑清单读写无任何行为漂移。
- 完成后改动留在任务分支，待独立审查通过后交付合并。

## 完成条件

### Requirement: application 层从 24 文件收敛至 16 文件且无旧路径残留
#### Scenario: 5 组同主题碎文件合并完成且高风险独立模块边界保留
- WHEN 完成 `project-config.ts`、`handoff.ts`、`session-context.ts`、`run-execute.ts`、`run-control.ts` 的合并并删除 8 个已合并旧文件
- THEN `src/application/` 仅保留预期 16 个文件，全仓库（`src/`、`test/`、`scripts/`）无对 8 个已删旧路径的残留引用，且不引入 `adapters -> application/run-lock` 或其他新增分层违例。

### Requirement: 执行控制、锁、交接与内置规范行为完全等价
#### Scenario: 类型检查、打包检查与全量测试回归通过
- WHEN 运行 `npm run typecheck`、`npm run pack:check` 与全量 `npm test`
- THEN 类型检查、打包检查与测试全部通过（含 `run-*`、`handoff*`、`context`、`standards*`、`deliver*`、`bridge-*`、`antigravity` 等全部套件；如受环境限制仅限跨文件系统 skip 须如实注明）。

## 待澄清

## 相关资料

- `docs/research/file-granularity-and-test-review.md#3-src-全量-6-层诊断与收敛方案` — `application/` 层逐文件合并清单与不变量说明
- `src/application/` — 应用层目录
- `src/adapters/` — 需同步更新 `runPaneSession` 等入站驱动导入的适配器目录
- `src/cli/` — 需同步更新应用层导入的 CLI 目录

## 结果

已完成 Batch 4（src/application/ 层 24 → 16 文件收敛），2 个完成条件均已满足并通过独立审查（r-85439bedb39c，verdict: pass）。将 config/standards-store/workflow-store 合并为 project-config.ts，task-materials 并入 handoff.ts，session-output 并入 session-context.ts，run-pane/run-session 并入 run-execute.ts，run-process/run-lock 并入 run-control.ts（run-* 从 8 个收至 4 个），保留 11 个独立核心模块，同步更新全仓库导入路径。

已验证：独立审查在 Rex 环境与清除 Rex 变量的普通终端各运行一次全量 npm test（含独立临时卷上的 7 条跨文件系统用例），两轮均为 538/538 通过、0 失败、0 跳过；npm run typecheck 与 npm run pack:check（包内 69 个文件）通过；214 个应用层声明除导出标记外与基线逐字一致，17 组 CLI 退出码/输出逐字节一致，零旧路径残留。
