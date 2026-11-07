---
id: k-b88e4a80906d
status: open
stage: start
outcome: null
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

<!-- knit:progress:end -->
