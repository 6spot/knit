# 文件粒度收敛、测试提速与制度修正子任务清单

主任务 `k-8f1c264937ee`（基线 `8595bef`）。依据 [file-granularity-and-test-review.md](../../../docs/research/file-granularity-and-test-review.md) 分批推进：**先立规矩与提速测试，再按低风险到高风险逐层收敛源码，最后合并碎片测试文件**。

按任务拆分规范分批登记子任务：全部 7 个子任务（Batch 0、1a、1b、2、3、4、5）均已完成验收并交付合入 `main`。

| 批次 | 子任务主题 | 编号 / 状态 | 验证 | 前置依赖 | 改动范围与做完后的不同 |
| --- | --- | --- | --- | --- | --- |
| **Batch 0** | [补齐防过碎文件与测试分层规范、角色模板与设计约定](../archive/2026-11/11-24-standards-anti-fragmentation/task.md) | `k-ef4500bb69c6`（delivered，`10fbcaf`） | `self` | 无 | 更新 `.knit/standards/development.md`、`.knit/standards/pitfalls.md`、`assets/standards/{task-splitting,task-writing}.md`、`assets/templates/agents/{implement,review}.md` 与 `docs/design/DESIGN.md`，堵住继续产生碎片文件和慢测试的制度漏口 |
| **Batch 1a** | [改造测试等待机制与公共夹具，降低集成测试子进程开销](../archive/2026-11/11-24-speed-up-test-wait-and-helpers/task.md) | `k-518fec960508`（delivered，`9208800`） | `independent` | `k-ef4500bb69c6` | `waitRun` 轮询退避/可配、`stopProcesses` 测试宽限期可注入；`test/helpers/` 9→7（合并 `setup`/`deliver` 至 `run.mjs`）、`gitProject`/`runProject` 改模板仓库 `cpSync`、`readyTask`/`doneTask` 改调应用层函数 |
| **Batch 1b** | [降级重型测试矩阵并修复沙箱临时目录硬编码，压缩全量测试耗时](../archive/2026-11/11-24-downgrade-heavy-test-matrices/task.md) | `k-47bf688a1643`（delivered，`cc9dc54`） | `independent` | `k-518fec960508` | `work-choice.test.mjs` 28 组纯判定改内存直调 + 3 宿主少量协议冒烟、`run-pane.test.mjs` 7 路纯回退降级、`antigravity.test.mjs` 临时目录遵循 `os.tmpdir()`；无沙箱全量 `npm test` 531/531 全绿（`user` CPU `-55%`） |
| **Batch 2** | [收敛 contracts、infrastructure、cli 与 adapters 薄文件并消除分层违例](../archive/2026-11/11-24-consolidate-low-layers-and-cli/task.md) | `k-e79d357c7827`（delivered，`e6a0dd1`） | `self` | `k-47bf688a1643` | `contracts` 7→4（`frames` 迁回 `pi/connection`，`pane`→`agent`，`digest+schema`→`primitives`）、`infrastructure` 6→3（`fs.ts`，`process.ts` 吸收 `session-env` 与 `withFileLock`）、`cli` 10→6（`shared.ts`/`project.ts`）、`adapters` 18→15（删 `pi/index.ts`，`antigravity/pane.ts`→`client.ts`） |
| **Batch 3** | [收敛 domain 层任务与规则碎文件](../archive/2026-11/11-24-consolidate-domain-layer/task.md) | `k-5ef09986911a`（delivered，`54de988`） | `self` | `k-e79d357c7827` | `domain` 12→7（保留独立 `pitfalls.ts`）：`agent-target`→`workflow.ts`、`stage-rules`→`report.ts`、`task-document+task-record+task-references+markdown`→`task.ts` |
| **Batch 4** | [收敛 application 层运行控制、配置与交接碎文件](../archive/2026-11/11-24-consolidate-application-layer/task.md) | `k-353d74968068`（delivered，`f576ff5`） | `independent` | `k-5ef09986911a` | `application` 24→16：`config+standards-store+workflow-store`→`project-config.ts`、`task-materials`→`handoff.ts`、`run-execute+run-pane+run-session`→`run-execute.ts`、`run-control+run-process+run-lock`→`run-control.ts`、`session-context+session-output`→`session-context.ts` |
| **Batch 5** | [按主题合并碎片测试文件、降级冗余 CLI 用例并提速 antigravity 套件](../archive/2026-11/11-24-consolidate-test-suites/task.md) | `k-280ab15c2a93`（delivered，`073ffe38`） | `independent` | `k-353d74968068` | `test/*.test.mjs` 68→29（`test/helpers/` 保持 7 个），降级剩余只读/校验 CLI 子进程用例并保留全命令与三宿主冒烟，`antigravity.test.mjs` 受控并发提速至 16.5–16.8s；全量 `npm test` 压至 Rex 34.58s / 普通终端 34.51s（526 通过 + 7 跨卷独立复验通过） |

## 执行与衔接约束

- **受保护路径**：`.knit/standards/`、`.knit/agents/`、`.knit/workflow.yaml`、`.knit/config.json` 由 `workspace.ts:protectedChanges` 保护，派发的执行者不可修改；Batch 0 由主会话直接完成。
- **全局安装与旧副本清理**：Batch 0 交付后如需让新内置规范与角色模板生效到全局 `knit`，另行请示用户授权运行 `npm run pack:install`、重生成 `.knit/agents/` 副本，并在全局安装版切换至内置 `assets/standards/` 后再删除 `.knit/standards/{delivery,discussion,task-splitting,task-writing}.md` 旧副本。
- **验证要求**：每个代码/测试子任务完成后必须保持 `npm run typecheck`、`npm test`（macOS 普通终端与 Rex 终端各跑一次）和 `npm run pack:check`（触及模板或构建产物时）全绿。
