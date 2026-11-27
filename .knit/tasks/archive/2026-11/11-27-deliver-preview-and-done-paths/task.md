---
id: k-ea81fa709d27
title: 增强交付预览提示并支持 done 任务补录改动路径
status: delivered
stage: null
verification: independent
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P0
createdAt: 2026-11-27T08:07:03.633Z
---

## 目标与范围

补齐交付预览与任务完成后的三项高频体验短板，减少漏提交与自动合并意外中断：

1. **交付预览列出未归属改动文件名（`src/application/delivery.ts`、`src/cli/deliver.ts`）**：
   - `previewDelivery()` 保留未归属改动（工作区中不属于本任务、也不在 `.knit/.runtime/` 或任务目录内的改动）的有序路径列表。
   - `knit deliver --preview` 的 `提示:` 段展示具体路径（最多列出前 10 条；超过 10 条时末尾加 `等共 N 处`），方便一眼辨认是无关改动还是漏登记的任务文件。

2. **允许对 `done` 任务补录漏登记的 `--paths`（`src/application/task-lifecycle.ts`、`src/cli/task.ts`、`assets/templates/pi/extensions/knit.ts`）**：
   - 复用 `knit task close <id>`，不新增顶层命令或新开关：
     - 当任务为 `ready` 或 `active` 时，行为不变，仍要求非空 `--result`（`independent` 未审查通过时仍要求 `--reason`）。
     - 当任务为 `done`（且需求未在确认后变更）且**仅传入非空 `--paths`**（未传 `--result` 与 `--reason`）时，校验路径为项目内相对路径后去重并排序合并到 `record.changedPaths`，保持 `status: done` 与 `## 结果` 原样不变，并明确输出已补录的登记结果。
     - 当任务为 `done` 但传了 `--result`/`--reason` 或未传 `--paths` 时，仍拒绝并提示：改总结直接编辑 `task.md` 的「结果」，补录改动文件仅传 `--paths <path...>`。
     - 若任务已 `delivered`/`cancelled`/`draft`，或存在未结束执行，保持原有拒绝规则，绝不绕过既有门禁。
   - 同步调整 Pi 桥接源模板 `assets/templates/pi/extensions/knit.ts`：`knit_task` 的 `close` 动作在传了 `paths` 时允许省略 `result`，透传给 CLI 校验；同步更新工具说明。

3. **开启 `worktree.autoMerge` 时交付预览做只读合并风险提示（`src/application/delivery.ts`、`src/cli/deliver.ts`）**：
   - 仅在项目开启 `worktree.autoMerge: true` 且任务存在 Worktree 时运行，全程只读（不修改索引或工作区），**只提示不拦截**：
     - **主检出脏工作区提示**：检查主检出是否存在未提交改动（排除 `.knit/.runtime/` 及当前任务自身的原任务目录），存在时在 `提示:` 段提示主检出未提交改动可能挡住交付后的自动合并，并列出路径（最多前 10 条）。
     - **主分支前进路径重叠提示**：注意预览阶段任务 Worktree 中的最新改动尚未提交到任务分支，因此先在主检出计算 `git merge-base HEAD <worktree.branch>`；若主检出 `HEAD` 已相对 `merge-base` 前进，则取 `git diff --name-only -z <base>..HEAD`，与本任务待提交路径（`preview.commit.files`、任务分支自 `base` 以来已有提交改动路径，以及未被忽略时的原任务目录/归档路径）求交集；存在交集时在 `提示:` 段提示主分支与本任务都修改了这些路径、自动合并可能冲突，并列出重叠路径（最多前 10 条）。
   - `worktree.autoMerge` 关闭、没有 Worktree 或不在 Git 仓库时不做此检查。

4. **设计文档同步（`docs/design/DESIGN.md`）**：
   - 同步更新第 8.2 节（交付预览提示项，含未归属路径与自动合并风险只读提示）与第 3.2/9 节（`done` 任务通过 `knit task close <id> --paths` 补录改动文件）。

### 范围外
- 不拦截任何交付操作（延续“预览提示、不加新拦截”原则）。
- 不修改实际交付提交、回滚及 `mergeAndCleanWorktree` 的执行逻辑。
- 不修改本仓库已生成的 `.pi/extensions/knit.ts`（按开发规范只改 `assets/templates/` 源模板）。

## 完成条件

### Requirement: 交付预览展示未归属改动具体路径
#### Scenario: 工作区存在不属于本任务的改动时列明路径并截断超长列表
- WHEN 任务 Worktree 或主检出存在不属于本任务的改动并运行 `knit deliver <id> --preview`
- THEN 预览的 `提示:` 段列出未归属改动的具体路径（≤10 条全部展示；>10 条展示前 10 条并注明总数）

### Requirement: `done` 任务可通过 `knit task close --paths` 补录改动路径
#### Scenario: `done` 任务仅传 `--paths` 成功去重追加且不改状态与结果
- WHEN 已 `done` 的任务执行 `knit task close <id> --paths a.ts b.ts`（不传 `--result` 与 `--reason`）
- THEN `record.changedPaths` 去重并排序追加新路径，`task.md` 的 `status: done` 与 `## 结果` 保持不变，随后 `knit deliver <id> --preview` 将补录且确有改动的文件纳入待提交清单

#### Scenario: `done` 任务传 `--result`/`--reason`/空 `--paths` 或非法路径，以及 `ready`/`active` 缺 `--result` 均被拒绝
- WHEN 对 `done` 任务执行 `task close` 时带了 `--result`、带了 `--reason`、未传 `--paths` 或传了越界/绝对路径；或对 `ready`/`active` 任务执行 `task close` 未传 `--result`
- THEN 拒绝操作、返回非零退出码并给出明确提示，不修改任务文件与记录

### Requirement: 开启 `autoMerge` 时交付预览给出只读合并风险提示
#### Scenario: 主检出有未提交改动或主分支与本任务修改同一文件时预览提示风险
- WHEN 项目开启 `worktree.autoMerge: true` 且任务在 Worktree 中完成，在以下两种情况分别运行 `knit deliver <id> --preview`：（1）主检出存在无关未提交改动；（2）主检出分支在建 Worktree 后提交了对本任务待提交同一文件的修改
- THEN 预览的 `提示:` 段分别清晰提示主检出未提交改动风险与主分支/本任务共同修改路径的冲突风险（列明路径），预览正常成功且不修改主检出或 Worktree 状态；`autoMerge` 关闭时不出现上述合并风险提示

### Requirement: 模板、设计与验证完整一致
#### Scenario: Pi 源模板与设计文档同步且全量测试通过并经独立审查
- WHEN 核对 `assets/templates/pi/extensions/knit.ts` 与 `docs/design/DESIGN.md`，并运行 `npm run typecheck`、`npm run build`、受影响测试（`test/deliver.test.mjs`、`test/deliver-worktree.test.mjs`、`test/task-lifecycle.test.mjs`、`test/bridge.test.mjs`）及全量 `npm test`
- THEN 模板、设计与实现一致，新增回归用例与既有测试全部通过（环境受限跳过的跨文件系统用例除外）；改动保留在任务 Worktree 中，不自行提交，交由独立审查核验

## 待澄清

## 相关资料

- `src/application/delivery.ts` — 交付预览 `previewDelivery` 与交付入口
- `src/cli/deliver.ts` — 交付预览提示项渲染
- `src/application/task-lifecycle.ts` — `closeTask` 完成与路径登记逻辑
- `src/cli/task.ts` — `knit task close` 命令定义
- `assets/templates/pi/extensions/knit.ts` — Pi 桥接 `knit_task` 的 `close` 动作模板
- `docs/design/DESIGN.md#8-完成与交付` — 交付预览与提示规范
- `test/deliver.test.mjs` — 交付与预览测试
- `test/deliver-worktree.test.mjs` — Worktree 交付与自动合并测试
- `test/task-lifecycle.test.mjs` — 任务生命周期与 `closeTask` 测试
- `test/bridge.test.mjs` — Pi 桥接工具测试

## 结果

交付预览现按路径排序列明未归属改动（超 10 条截断并附总数），并在开启 worktree.autoMerge 时只读提示主检出未提交改动与主分支/本任务路径重叠冲突风险；knit task close 现支持对 done 任务仅传 --paths 去重追加改动路径且保持 task.md 逐字节不变（同时校验需求摘要与无未结束执行），Pi 源模板与 DESIGN.md 第 3.2、8.2、9 节同步更新。5 条完成条件全部满足。独立审查（r-9437e6dc1f96）结论为 pass，审查中直接修复了 Pi 桥接传递以 - 开头路径被 Commander 误判为选项的问题并补齐回归测试，独立验证通过 npm run typecheck、npm run build、git diff --check、4 份定向测试（95/102 通过、0 失败、7 项跨文件系统跳过）及全量 npm test（550/557 通过、0 失败、7 项跨文件系统跳过）。未验证：7 项跨文件系统测试因环境未配置 KNIT_TEST_CROSS_DEVICE_DIR 跳过。
