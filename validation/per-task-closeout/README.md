# 055–057 任务创建、完成与逐任务收尾验收

## 状态

本目录记录 055–057 的实现与隔离验证事实。当前工作区未提交；本轮没有操作真实项目、没有运行真实模型、没有推送／发布。

- 任务 055：用户决定是否建任务、无任务直接执行／宿主委派、按范围验证。
- 任务 056：业务完成资格守卫；完成与 Git 收尾分离。
- 任务 057：业务产物与任务资料分开提交；多任务逐项收尾与只读计划。

## Trellis 固定来源核对（057）

固定基线：`mindfold-ai/Trellis@f089cb3286071199e84118dee86b6d76aab032f1`（CLI 0.6.17），沿用 [054 来源](../trellis-prompts-and-roles/sources.md)。

核对位置与事实：

- `packages/cli/src/templates/trellis/workflow.md` L600-640：Phase 3.4 先按“本会话 AI 编辑过／未识别”分类 dirty paths，按逻辑工作单元形成 work commits；要求 work commits 先于 archive／journal bookkeeping 提交。
- `packages/cli/src/templates/common/commands/finish-work.md` L1-55：明确代码工作提交**不在** finish-work 内完成；finish-work 过滤 `.trellis/workspace/` 与 `.trellis/tasks/`，交给 `add_session.py`／`task.py archive` 的自动提交处理；最后顺序是 work commits → archive → journal。
- 同文件 L12-32：无法识别归属的 dirty path 不静默并入，要求返回工作提交阶段或询问用户；这支持“先分类、冲突停止”，不是整仓提交。

结论：Trellis 的可借鉴点是**工作提交先于任务归档／记录 bookkeeping**，并明确过滤任务管理目录；它不等于“一个任务一个自动混合提交”。Knit 采用更严格的业务产物与任务资料两类提交，保留逐任务记录。

## Knit 实现

### 完成资格

- `task.md` 新增可选 `verification: none|self|independent`。新任务默认 `self`；旧记录缺省按 `independent` 兼容，不追溯改写。
- `task new --verification` 创建时选择；`task verification <id> --mode` 只在讨论阶段调整，作为输入变化并清除旧完成／检查资格。
- `independent`：实施接收进入 `check`，完成必须持有当前有效的 pass 检查。
- `self`：实施接收进入 `deliver`；完成要求最近获准实施及其输入／scope 仍匹配，不要求独立检查。
- `none`：用户明确选择；完成记录未验证项，不把跳过记成 pass。
- 完成不要求 Git 提交、交付回执或归档。完成凭据写 `.knit/.runtime/completions/<task-id>.json`，冻结输入、scope、验证方式与来源。
- 完成凭据在输入或成果变化后失效，后续 `deliver` 拒绝沿用旧完成。

### 提交分离与批量收尾

- `deliver <taskId...>` 支持多个已完成任务逐项处理；单个任务仍返回原单结果形状，多个返回 `results`，任一项失败保留已生效结果并停止后续执行。
- `--plan` 只读预检：列出每个任务的业务产物、任务资料、已暂存业务路径、跨任务同路径冲突（产物或共享资料）；有冲突时不执行。
- 每个任务：
  1. `knit: artifact` 业务产物提交（scope 中除任务目录外的路径）；
  2. 写最终记录；
  3. `knit: metadata` 任务资料提交（任务目录及必要的共享元数据）；
  4. 封存、移动；
  5. `knit: archive` 归档提交。
- 旧操作记录中的 `work_commit` 仍可恢复；新记录增加 `metadataCommit`，旧记录缺省不为空时按旧合并语义处理。

### 已知限制

- 同一业务文件同时被多个任务修改时，仅凭路径和当前内容不能可靠拆分同一 diff。`--plan` 会报告 `path_shared_by_tasks` 并停止。
- 业务路径在计划时已有 staged 内容，所属关系不可靠；`--plan` 报告 `preexisting_staged` 并停止，要求用户先整理 index。
- 未暂存的任务开始前改动仍无法仅靠当前实现自动判定归属；实现不声称能分离同文件历史 diff。需要精确归属时，应由用户先整理工作区或拆分任务。
- 本轮未运行真实模型、真实项目或推送；Git 行为只在隔离仓库验证。

## 隔离验证

新增 `test/closeout.test.mjs`（11 项），覆盖：

1. self 任务完成后不产生 Git 提交；完成凭据记录验证方式。
2. independent 缺少有效检查时拒绝完成；none 显式完成并记录未验证项。
3. 完成后成果变化使完成凭据失效，交付拒绝旧完成。
4. 单任务产物／资料／归档三次提交范围分离。
5. 两个任务批量收尾逐任务提交，产物与资料提交各自独立。
6. plan 报告跨任务同路径冲突。
7. plan 报告已暂存业务路径冲突。
8. CLI `task close completed` 被完成守卫拒绝，任务保持 open。
9. `task verification` 只在讨论阶段可调整。
10. CLI `deliver --plan` 只读预检，不创建提交。
11. self 任务在 deliver 上澄清回实施，不强制独立检查。

验证命令（实现完成后运行）：

```bash
npm run typecheck
npm run build
node --test test/*.test.mjs
npm run pack:check
```

本轮 `node --test test/*.test.mjs` 全量 **255 项通过**（其中 closeout 11 项）；`npm run typecheck`、`npm run build`、`npm run pack:check` 通过。真机／真实模型验收按用户要求暂缓；以上是静态检查与隔离夹具事实。
