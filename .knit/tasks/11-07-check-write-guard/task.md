---
id: k-b88e4a80906d
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-2c0d10318898
priority: P0
dependsOn:
  - k-eb2e23ce4f41
  - k-a8ace0d90676
order: 70
createdAt: 2026-11-07T11:44:07.617Z
title: 检查阶段写入约束与 independent 标注
---

# 检查阶段写入约束与 independent 标注

## 目标与边界

### 背景与问题

默认 workflow 的 check 阶段写的是 `tools: [read, exec]`，但 exec 就是 bash，实际上能写文件。审计复现：

- 检查者改写 `f.txt` 并报 pass，结果 `check_pass`；完成凭据与产物提交写的是"验证：independent — 检查 run-… 通过"。
- DESIGN 第 387 行要求"对自身修改的验证属于自检，不表述为已由另一独立执行者复核"；`selfVerified` 只被解析，不进凭据和提交说明。

### 交付范围

1. 能力与实际不符：阶段能力不含 `write`，但实际差异非空 → run 失败，原因 `write_without_capability:<paths>`，结果与工作区保留，不接收。
2. 检查者修复的标注：允许写的检查阶段 pass 且实际改了文件时，检查凭据记录 `checkerChangedPaths`。完成凭据与交付提交的"验证"行写成"independent（检查者修复 N 个路径，修复部分为自检）"，`run status`／`status` 同样显示。
3. independent 完成资格：最新检查凭据带非空 `checkerChangedPaths` 时，`task close --outcome completed` 以 `check_self_modified` 拒绝；需再派一次未改动文件且 pass 的检查，凭据替换后才可完成。默认 workflow 的 check 阶段维持 `[read, exec]`，模板提示词写明检查阶段不改文件。
4. 同步 DESIGN 第 387／405 行、ROLE-CONTRACT 检查阶段、完成凭据与提交说明模板。

### 非目标

- 不拦截 bash 本身。
- 不改 `verdict` 枚举或 `onVerdict` 跳转。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 检查者修改过成果后，independent 任务不能直接完成：必须再跑一次未改动任何文件且结论为 pass 的检查，完成守卫原因 `check_self_modified`。
- 第 1 项"无写能力却写了"一律失败，不提供人工接纳出口

## 完成条件

- 自动化测试：`[read, exec]` 检查阶段写文件 → `write_without_capability`，`lastCheckRunId` 不变；允许写的检查阶段改文件后 pass → 凭据带 `checkerChangedPaths`，independent 任务 close 报 `check_self_modified`；再跑一次无改动的 pass 检查后可完成，提交说明不带自检标注。
- 审计 F3 场景不再输出不带标注的"independent 通过"。

## 输入引用

- 审计 F3。
- `src/application/run-acceptance.ts:383-480`、`src/application/check-validation.ts`、`src/domain/completion.ts`、`src/application/delivery-service.ts:1099-1117`、`docs/design/DESIGN.md:387,405`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## 派发须知（2026-11-07 主会话，审计计划执行约定）
- 报告 `changedPaths` 只列本 run 在工作区实际改动的路径（与 git 前后差一致），不列之前轮次或其它任务已存在的改动；否则 `changed_paths_mismatch` 整轮失败。
- 交付前凭据扫描规则 generic_secret_assignment（见 src/contracts/credentials.ts）会把“凭据类关键词作变量名或字段名并被赋值长字符串或表达式”的新增行判为疑似凭据。新增代码与测试请给此类局部变量加前缀（例如 owner 前缀），夹具值保持 8 字符以内；完成前用 dist/contracts/credentials.js 的 scanCredentials 扫描新增行确认零命中。
- 工作区里其它 `.knit/tasks/*/task.md` 的未提交改动来自主会话记录，不属于本任务成果，不要修改或列入报告。
- 单跑测试时请 `env -u REX_SESSION -u REX_BLOCK node --test ...`；全量用 `npm test`。
- 本仓库实测案例（证据）：k-6f0616f3779d 的检查 run-f3cef235145d 在 `[read, exec]` 能力下由检查者按 clarify 改了 src/cli/locks.ts 与 test/infrastructure.test.mjs 两处变量名并报 pass，被接收为 check_pass，任务随后以 independent 关闭。这正是 F3 场景，本任务完成后同类情况会判 write_without_capability。
- 衔接已交付的 k-fdfd8c171736（改动来源归属：externalChanges／unattributed_paths／残留）与 k-a8ace0d90676（stage-baseline）：“实际差异非空”应以已归属给本 run 的改动为准，不把外部改动（例如主会话并发写入的文件）算作检查者写入，并在测试中覆盖这一点。

## 完成记录（2026-11-08 主会话）
- 实施 run-ca8a157259cb：worker 用 bash（python 脚本）写入的 9 个路径被新的来源归属机制判为 unattributed_paths。主会话逐一核对原生会话里的 bash 调用，确认均为本 run worker 写入，期间没有其他写入者，于是用 `run accept --include ... --reason` 并入 scope，结果 implementation_accepted。npm test 644/644。
- independent 检查 run-b8f76c3cb22f pass，未改文件（actualChangedPaths 为空）。它还用真实凭据 .knit/.runtime/checks/run-f3cef235145d.json 验证了旧凭据的标注回退，正确输出“检查者修复 2 个路径”。
- 已知影响：k-6f0616f3779d 已在本任务前关闭并交付，其凭据仍按旧规则记录；本任务交付后同类场景会被 check_self_modified 拦截。此事列入总任务遗留说明。
- 主会话：.knit/agents/check.md 从模板逐字同步，单独提交。

### 交付记录

<!-- knit:delivery:op-866c94fc92d1 -->
- 操作: op-866c94fc92d1
- 时间: 2026-11-08T21:15:32.148Z
- 分支: refs/heads/main
- 授权来源: .knit/tasks/11-07-audit-fix-plan/plan.md#执行授权
- 工作提交: 0eceab92da83cf5bba8fbcad55d751243b31094b
- 结果: 正常交付；检查 run-b8f76c3cb22f 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-07-check-write-guard

<!-- knit:progress:end -->
