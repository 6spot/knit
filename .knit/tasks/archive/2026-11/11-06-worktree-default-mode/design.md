# Worktree 默认开关与收尾配置：设计

状态：2026-11-06 讨论定稿，未实施。默认 OFF；开关只覆盖 worker 派发（用户选定 B）。

## 1. 配置

`.knit/config.json`（`src/application/config.ts`）新增/收紧：

```json
"worktree": {
  "default": "off",          // off | on
  "cleanup": "manual"        // manual | after-merge
},
"delivery": {
  "mode": "local"            // local | merge
}
```

- 缺省：`worktree.default: "off"`、`worktree.cleanup: "manual"`、`delivery.mode: "local"`；旧配置不受影响。
- schema 收紧为枚举，非法值按现有全量校验拒绝。
- init 生成的 `defaultConfig()` 输出上述默认值（config.json 是严格 JSON，不加注释）。
- `doctor` 报告解析/取值错误；不因配置缺失改变既有行为。

## 2. 生效范围（选择了 B）

- **只覆盖 worker 派发**：开关 ON 时，任务派发第一个配置阶段前自动准备 worktree。
- **不覆盖主会话实施**：`task implement` 的任务仍在主检出执行；`delivery.mode: "merge"` 对它没有可合入的分支，按 local 完成并说明（`noop`）。
- 任务级覆盖两个方向：
  - 显式 `worktree create` / `connect` 建立绑定后，派发使用该绑定（等价于对当前任务开启，即使项目默认 off）。
  - `run prepare --worktree off` 只在本次派发抑制自动创建；不删除已有绑定，不改项目配置。已有绑定时直接使用绑定，不受 `off` 影响。
  - `--worktree on` 在项目默认 off 时触发自动创建。
- 有效策略写入 run 请求，恢复与重试沿用；不新增第二套任务状态。

## 3. 触发点

`run prepare`（`RunCoordinator.prepare`）在以下条件全部成立时先执行「确保 worktree」：

1. 阶段是当前生效流程的第一个阶段（`workflow.stages[0]`）；
2. 任务绑定没有 worktree；
3. 有效策略为 on（`--worktree on` 或项目默认 on 且未传 `off`）。

已存在绑定、后续阶段、`run check --scope` 均不触发创建。

确保流程与 `worktree create` + handoff + prepare 一致：脏守卫（见下）→ Git 创建 → 交接任务资料 → `worktree.copy`／`postCreate` → 绑定更新。失败时 prepare 返回明确原因（`worktree_dirty_source`、`git_head_required`、`detached_head`、`branch_occupied` 等），**不写 request、不创建 run**；无部分状态。

prepare 的文档描述同步改为「可能准备执行环境（worktree）」，不再声称完全无副作用。

## 4. 脏守卫（选 A）

自动创建前检查主检出：

- 收集 `git status --porcelain=v1 -z --untracked-files=all`，排除当前任务目录 `.knit/tasks/<task-dir>/`（该目录由 handoff 带走）与 ignored 内容。
- 存在其它改动 → 失败 `worktree_dirty_source`，消息列出数量与前 8 个路径。
- 用户选择：提交、stash，或先显式执行 `worktree create --allow-dirty`（该标志只属于手动命令，自动路径不加）。
- 不搬运、不 stash、不丢弃任何改动。

## 5. 交付、合入与清理

`delivery.mode: "merge"`（仅对有 worktree 绑定的任务）：

1. 若本次授权覆盖合入：先执行 `worktree merge` 的既有步骤（源 worktree 干净检查、目标 index 干净、无冲突合入、任务资料与绑定转交）；
2. 在主检出完成 artifact → metadata → seal → move → archive 提交；
3. 若 `worktree.cleanup: "after-merge"` 且合入成功、工作区干净、授权覆盖清理：执行 `worktree cleanup`；
4. 任一步失败：保留已有提交、worktree、分支与现场，按步骤报告；不执行后续清理。

顺序说明（2026-11-06 用户确认）：合入必须先于交付提交。worktree 路由下任务资料在主检出缺席，deliver 又要求资料在主检出；同时既有 `worktree merge` 拒绝已归档任务。原稿写成「先交付归档、再合入」，按字面执行会卡在这两条守卫上；保持合入先行不改变授权、守卫与回执语义。

授权（2026-11-06 更新，与 `k-9cd9a63bd5c5` 调度口径一致）：

- **配置了** `delivery.mode: "merge"` 或 `worktree.cleanup: "after-merge"` 时，视为用户对合入／清理的授权，记录 `config:<路径>@<sha256>`；不再单独要求合入／清理授权。提交与归档仍需 deliver 的授权来源。
- **用户显式授权**合入／清理时按授权执行，不要求先改配置。
- 两者都没有：完成本地提交，报告「待合入／待清理」，不失败、不擅自执行。
- 清理沿用既有 `blocked_dirty` 与显式 `--discard-changes`；自动路径永不丢弃改动。
- 合入目标沿用 `worktree merge --into`：主检出当前分支，必须与目标一致；配置不提供目标。
- 无 worktree 绑定：`merge` 记为 `noop` 并说明，不报错。

## 6. 与现有实现的关系

- `worktree create/connect/handoff/prepare/merge/cleanup` 的行为与守卫不变；本任务只增加「自动触发 + 收尾串联 + 默认值」。
- `delivery.mode` 从占位变为实际读取；`worktree.cleanup` 新键。
- `run prepare` 的只读描述需要更正，并在 OPERATIONS 写明可能产生的环境副作用与失败语义。
- 完成资格、授权来源、scope 与检查规则不变。

## 7. 测试

- 配置：缺省值、枚举非法值、旧配置兼容、doctor 报告。
- 触发：默认 off 不建；默认 on 建并交接；`--worktree on/off` 覆盖；已有绑定复用；非首阶段不建；`run check --scope` 不建。
- 脏守卫：干净通过；任务目录之外脏 → `worktree_dirty_source` 且不写 request；`worktree create --allow-dirty` 可手动继续。
- 失败路径：无 HEAD／detached／分支占用 → 原因明确、无 run。
- 交付串联（夹具仓库）：授权覆盖 → merge + transfer（+ cleanup）；未覆盖 → local + 待办报告；源脏／目标脏／冲突 → 停止且不清理；无绑定 → noop。
- 幂等：重试 prepare 不重复创建；合入回执丢失按既有恢复核对，不重复合入。
- 真实 worktree + 真实模型端到端验收另记，不冒充已完成。

## 8. 文档

- DESIGN §6（开关、触发、脏守卫、收尾顺序）、§10（merge/cleanup 串联与授权）、§13（配置键）。
- OPERATIONS：prepare 的环境准备副作用、失败原因；deliver 的 merge 步骤。
- README/AGENTS 的 Worktree 口径由 `k-a6a220185827` 统一回写，本任务只补新增键与行为。

## 9. 不纳入

- 主会话实施也强制 worktree（B 的边界）。
- 自动搬运未提交改动、自动 stash、自动丢弃改动。
- 可配置合入目标、自动推送／发布。
- config.json 注释（另行在功能梳理与使用手册任务处理）。
