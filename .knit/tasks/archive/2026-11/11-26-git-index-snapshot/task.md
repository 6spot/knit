---
id: k-f6a5650334d8
title: 优化工作区快照为 Git 索引增量指纹
status: delivered
stage: null
verification: independent
parent: k-b7380720fbf3
dependsOn: []
priority: P1
createdAt: 2026-11-26T14:23:18.361Z
---

## 目标与范围

**要解决的问题**：目前 `src/application/workspace.ts` 中的 `takeSnapshot(root)` 每次派发前、结算后都会执行 `git ls-files -tco --exclude-standard -z`，并对**全仓库每一个文件**同步读盘计算 SHA-256（包括完全没有改动的已跟踪文件）。在本仓库耗时 ~118 ms，而在 10,000+ 文件的中大型仓库中，每次派发和结算都会卡顿数秒。

**改动目标（高风险改动对比链路，本任务要求独立审查）**：
- 优化 `src/application/workspace.ts` 中的 `takeSnapshot(root)`，利用 Git 索引与工作区状态避免对干净的已跟踪文件全量读盘算 SHA-256，同时**100% 保持快照对比语义等价**（不遗漏任何新增、修改、删除、类型变化、可执行权限位变化、符号链接变化、暂存区改动或未跟踪文件）：
  - **推荐实现思路**：
    1. 读取 `HEAD`（同现有逻辑）。
    2. 先通过 `git ls-files --stage -z`（或 `git ls-files -s -z`）一次拿到所有已跟踪文件的索引模式（`100644`/`100755`/`120000`/`160000`）与 Git blob OID（已包含内容摘要），并排除 `.knit/.runtime/` 前缀；对干净的已跟踪文件，直接以稳定指纹（例如 `git <mode> <oid>`）记录，无需逐个读盘算 SHA-256。
    3. 再通过 `git status --porcelain=v1 --no-renames --untracked-files=all -z`（或 `git diff-files --name-only -z` + `git ls-files --others --exclude-standard -z`）找出所有**工作区与索引有差异的文件**（修改、删除、类型/权限变化、暂存态但工作区不一致等）以及**所有未跟踪（未忽略）的新文件**，只对这部分脏文件和未跟踪文件调用原有的 `fingerprint(root, path)` 读盘算真实 `kind mode sha256`（并继续处理未跟踪文件拍照瞬间消失 `ENOENT` 时忽略的竞态保护）。
    4. **关键边界核验**：
       - **同一文件在 `before` 时干净（`git <mode> <oid>`），在 `after` 时被改过又改回原样（再次干净）**：两边都是同一个 `git <mode> <oid>`，不误报改动！
       - **同一文件在 `before` 时是脏文件（`file 644 <sha256>`），在 `after` 时仍为同一份未提交内容**：两边都是同一个 `file 644 <sha256>`，不误报改动！
       - **同一文件在 `before` 时是脏文件（工作区改动未暂存），在执行期间被执行者 `git add` 暂存了但内容没变**（或反之 `before` 时已暂存、执行期间 `git reset` 了但工作区内容没变）：
         - **注意这个经典陷阱！** 如果 `before` 是未暂存脏文件（指纹为 `file 644 <sha256>`），执行者运行了 `git add` 后它变成相对索引干净（指纹变成 `git 100644 <oid>`），如果两种指纹格式不同，就会误报它改过内容！或者如果在 `before` 时把已暂存文件也纳入脏集合，反过来 `after` 被 `git add` 就会出现格式不一致。
         - **怎么彻底避免格式不一致？** 两种简单干净的解法（实现者选其一并用测试证明）：
           - **方案 A**：利用 `git hash-object` / Git 索引格式统一——不对，Git blob SHA-1 与 `fileFacts` 的 SHA-256 算法不同；要让 `fingerprint(root, path)` 与索引条目可比，或者只在「文件在 `before` 和 `after` 相对索引均干净」时直接对比 `git <mode> <oid>`，而一旦 `changesBetween` 或 `takeSnapshot` 需要对比：注意 `after.json` 还会被 `previewDelivery`（`src/application/delivery.ts` 第 211 行！）拿来直接和 `fingerprint(workspace, path)` 对比！！
           - **OH！看 `src/application/delivery.ts` 第 211 行**：`changedAfterReview: passed !== null && passed[path] !== fingerprint(workspace, path)`！
           - **极其关键的约束**：`delivery.ts` 直接用 `fingerprint(workspace, path)` 和 `after.json` 里的 `passed[path]` 做字符串相等比较！如果 `after.json` 存的是 `git 100644 <sha1>` 而 `delivery.ts` 算出来的是 `file 644 <sha256>`，会导致 `previewDelivery` 把**审查通过后根本没改过的文件误标成「审查通过之后又改过」**！
           - 因此：
             - `delivery.ts` 第 211 行只对 `files`（即 `changedAmong(workspace, recorded)`，在任务分支上相对 `HEAD` 有改动的待提交文件）做比对；或者更彻底：**在 `workspace.ts` 封装统一的快照/单路径比对或 `fileFingerprint` 逻辑**——若干净的已跟踪文件在快照里用 `git <mode> <oid>`，那么：
               - 对工作区里**相对 `HEAD` 有改动（含已暂存但未提交）**的文件，全部用 `fingerprint(root, path)`（即只有同时满足“工作区=索引=HEAD”的完全干净文件，才用 `git <mode> <oid>` 跳过读盘！）；
               - 这样一来：
                 1. 任何已经改过（无论暂存与否）的文件永远走 `fingerprint()`（`kind mode sha256`），所以 `git add` / `git reset` 绝不会改变其指纹，且 `delivery.ts` 对比 `changedAmong` 里的待提交文件时，`passed[path]` 永远是 `fingerprint()` 格式，100% 匹配！
                 2. 任何未被改动且与 `HEAD` 一致的干净文件，在 `before` 和 `after` 都是 `git <mode> <oid>`，如果执行者没动它（哪怕文件数有 50,000 个），零读盘、毫秒级完成！如果执行者动了它，它就进入 `status` 脏集合变成 `file ... <sha256>`，必然和 `git <mode> <oid>` 不同，100% 检出！如果执行者改完又改回 `HEAD` 一致，它又变回完全干净的 `git <mode> <oid>`，与 `before` 一致，不误报！
                 3. 唯一剩下的边角：如果一个文件在 `before` 时和 `HEAD` 一致（`git <mode> <oid>`），执行期间没改、但因为 `core.filemode` 或换行符等原因被 `git status` 标成脏？因为 `git status` 会把它列出来，只对极少数标脏文件调用 `fingerprint()`，不会漏检；若 `review` `pass` 时记录了 `after.json` 且某文件在 `recorded` 中但恰好和 `HEAD` 一致，`changedAmong` 本来就不包含它。
                 4. 还有 `run-finish.ts` 第 55 行：`after.files[path] === fingerprint(memberDir, copy)`（用于剔除 `agy-hooks.json` 这种未跟踪临时文件）——因为未跟踪文件永远走 `fingerprint()`，所以与 `run-finish.ts` 也 100% 兼容！
                 5. **已明确的 clean-filter 与受保护路径边界**：受保护路径（所有 `.knit/` 下的非运行时文件，以及调用方通过可选参数传入的流程角色文件路径）**始终直接走逐字节 `fingerprint(root, path)`**，绝不依赖 Git 索引干净状态，从而彻底杜绝移除 Git clean filter 导致受保护文件漏检的风险；对于其余普通仓库已跟踪文件，接受 Git 标准的干净状态语义（当“工作区=索引=HEAD”时直接复用 `git ls-files -s` OID，无需首次全量读盘哈希）。

**明确不做 / 边界**：
- 不修改 `WorkspaceSnapshot` / `WorkspaceChanges` 对外 JSON 结构（`{ head, files: Record<string, string> }` 保持不变，旧 `before.json` / `after.json` 文件仍可读）。
- 不跳过任何 `.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json` 或角色文件的受保护路径检查。
- 不修改 Worktree 中的受保护路径。

## 完成条件

### Requirement: `takeSnapshot` 对干净已跟踪文件免全量读盘，且改动检测语义完全等价
#### Scenario: 准确检测新增、修改、删除、权限变更、符号链接变更、暂存改动与改回原样
- WHEN 在 Git 仓库中分别执行以下操作并对比前后快照：修改已跟踪文件、新增未跟踪文件、删除已跟踪文件、修改文件可执行权限位（`chmod +x`）、修改符号链接目标、修改后又还原为与 `HEAD` 一致、对已修改文件执行 `git add` 或 `git reset`（工作区内容不变）
- THEN 新增、修改、删除、权限变更和符号链接变更全部准确出现在 `changedPaths` 中；改回与 `HEAD` 一致以及仅改变暂存状态（内容与权限未变）不误报改动；`.knit/.runtime/` 下的文件仍被排除

#### Scenario: 与 `finishRun` 临时钩子剔除及 `previewDelivery` 审查后变更检测完全兼容
- WHEN 审查通过保存 `after.json` 后直接预览交付（文件未再改），以及审查通过后再修改待提交文件并预览交付；以及并行批次中存在 `workspaceCopies` 临时未跟踪文件时调用 `finishRun`
- THEN 审查通过后未再改动的文件不被误标 `changedAfterReview`；审查通过后再改动的文件准确标出 `changedAfterReview`；`workspaceCopies` 临时文件仍能被 `finishRun` 准确识别并剔除

#### Scenario: 仓库无初始提交（空 HEAD）及未跟踪临时文件拍照期间消失仍安全处理
- WHEN 在尚未提交的仓库中调用 `takeSnapshot`，或未跟踪文件在列出后、读取前被删除
- THEN 不抛错，正确返回 `head: null` 及现有文件指纹，消失的未跟踪文件不留下无效记录

## 待澄清

## 相关资料

- `src/application/workspace.ts` — 快照拍照、对比与受保护路径检查
- `src/application/run-finish.ts` — 结算快照对比与 `workspaceCopies` 剔除
- `src/application/delivery.ts` — `previewDelivery` 对比 `after.json` 逻辑
- `test/workspace.test.mjs` — 快照与受保护路径单元测试
- `test/deliver.test.mjs` — 交付预览 `changedAfterReview` 测试

## 验证与交付

- 运行 `npm run typecheck`、`npm run build`、`node --test test/workspace.test.mjs test/deliver.test.mjs test/deliver-worktree.test.mjs test/antigravity.test.mjs`，以及全量 `npm test`（因涉及高风险核心链路改动对比），全部通过。
- 本任务为 `independent` 独立审查任务，实现后将派发独立审查环节核对全部边界；改动留在任务 Worktree 分支，不自行提交。

## 结果

已优化工作区快照为 Git 索引增量指纹：干净普通已跟踪文件直接复用 Git 索引 OID 免全量读盘，脏文件、未跟踪文件、所有 .knit/ 受保护路径及流程角色文件始终逐字节计算 SHA-256 指纹，支持跨格式与旧快照兼容并统一交付审查后变更比较。实测 10,000 文件仓库快照由 266.4 ms 降至 55.7 ms（约 4.7 倍提速）。验证：独立审查 r-1f04e319ee14 结论 pass；npm run typecheck、npm run build、git diff --check 通过；定向测试 119 通过、0 失败、7 跳过；全量 npm test 510 通过、0 失败、7 跳过（未设跨文件系统环境变量）。未验证：未在其他实际大型仓库中实测性能。
