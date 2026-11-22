# 子任务清单

主任务 `k-cdf8de80d14c`。承接架构加固主任务 `k-d123fec5fa11`（先完成 `k-84165a4f76ee` → `k-e03319df1da4` → `k-0821df285a6f` → `k-053fe369b3ec`），围绕代码审查发现的 Antigravity（`agy`）执行器边界缺陷、Worktree 未合并任务的命名碰撞与主检出查找缺口，以及打包检查与本机安装版同步问题，拆分为 7 个顺序执行的子任务。

| 顺序 | 子任务 | 编号 | 验证 | 前置依赖 | 做完之后有什么不同 |
| --- | --- | --- | --- | --- | --- |
| 1 | [Antigravity 回执优先认提交报告并在后台或漏标时闭合轮次](../11-22-agy-turn-resolution/task.md) | `k-77935d729cf5` | `independent` | `k-053fe369b3ec` | 当轮有被拒工具调用但最终输出 `KNIT_AGY_SUBMIT` 时不再误判为权限阻塞；后台模式漏写标记或输出 `WAITING` 时可靠触发补报且不在无 `report` 字段环节误判成功；尽早持久化并在关窗/取消时回填原生 `sessionFile` |
| 2 | [Antigravity 放行主检出只读交接资料、补齐内置工具白名单并收敛会话权限](../11-22-agy-tools-and-handoff-read/task.md) | `k-27f80e26adee` | `independent` | `k-77935d729cf5` | `agy` 原生读取工具基于 `AgentLaunch.root` 读取主检出任务目录与历史报告（同时核实 `allowNonWorkspaceAccess`），支持缺省路径搜索、`edit_file` 与 `manage_task`（`status`/`list`/`kill`），且全局 `ask` 规则不再阻塞内部转发命令与后台读写 |
| 3 | [隔离 Antigravity 命令临时目录、保留执行环境并加固进程回收与结算](../11-22-agy-command-env-and-cleanup/task.md) | `k-c84dae7772e7` | `independent` | `k-27f80e26adee` | 命令进程使用沙箱内独立临时目录（`[read, exec]` 可写 `$TMPDIR` 且不污染 Worktree 快照），继承宿主工具链环境，忽略 macOS `killpg` 的 `EPERM`，清理异常不阻断 `finishRun` 入账 |
| 4 | [对齐 Antigravity 的 external 预检与沙箱读取规则](../11-22-agy-external-capability/task.md) | `k-050013968b09` | `independent` | `k-c84dae7772e7` | 消除 `external`（含 `tools: all`）在预检与 `sandboxProfile` 之间的矛盾，统一外部只读定制（技能、规则等）与不可隔离外部进程的准入及沙箱读取规则 |
| 5 | [防止新建任务与未合并的 Worktree 分支重名并支持读取未合并的归档任务](../11-22-worktree-unmerged-task-safety/task.md) | `k-187f77a762fa` | `independent` | `k-050013968b09` | `knit task new` 避开已存在但未合并的 `knit/*` 分支与 Worktree 目录名，防止覆盖或取消时误删未合并成果；`findTask`/`task show`/`context` 支持安全读取已交付在任务 Worktree 但尚未合并的归档任务 |
| 6 | [补齐打包检查的 Antigravity 产物](../11-22-pack-check-and-sync-install/task.md) | `k-70ec54c7daf9` | `self` | `k-187f77a762fa` | `scripts/pack-check.mjs` 覆盖 Antigravity 运行时入口与 macOS 命令进程跟踪器可执行权限检查 |
| 7 | [升级全局安装版并同步本仓库模板副本](../11-22-sync-global-install/task.md) | `k-4f3398a3ec99` | `self` | `k-70ec54c7daf9` | 独立授权操作：清理根目录残留 `.tgz`，运行 `npm run pack:install` 与 `knit init --force`（恢复 `.knit/workflow.yaml`），同步全局安装版及本仓库副本到最新基线 |

## 依赖与执行约定

- 本清单接在架构加固主任务 `k-d123fec5fa11`（`k-053fe369b3ec`）之后。第 1 至第 4 项均修改 `src/adapters/antigravity/`、`test/antigravity.test.mjs` 和 `docs/design/DESIGN.md`，第 5 项修改 `task-store.ts` 与 `docs/design/DESIGN.md`，第 6 项在代码交付后补齐打包校验，第 7 项单独授权升级全局安装版，因此按 `dependsOn` 串行推进。
- 执行者不得修改受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`，由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查）；模板改动写入 `assets/templates/`。
- 每个子任务完成后在 macOS 普通终端与 Rex 终端各跑一次 `npm test`，并运行 `npm run typecheck` 与 `npm run pack:check`。
