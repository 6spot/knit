---
id: k-86d01bf85274
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-2c0d10318898
priority: P0
dependsOn: []
order: 80
createdAt: 2026-11-07T11:44:08.090Z
title: 空成果完成守卫与无产物交付提示
---

# 空成果完成守卫与无产物交付提示

## 目标与边界

### 背景与问题

审计复现：实施报告 `changedPaths: []` 被接收，scope 为 0，任务按 self 完成；`deliver` 返回 completed、`workCommit: null`，任务随即归档。"本来就没产物"、"产物已被外部提交"和"产物还留在工作区没归属"三种情况在结果里分不出来。

### 交付范围

1. 完成守卫：verification 为 self／independent 且 scope 为空时，`task close --outcome completed` 拒绝，原因 `empty_scope`。显式 `--no-artifacts --reason <text>` 才能完成，凭据记 `artifacts: none` 和原因。`none` 模式与主会话 `task implement`（已登记路径）不受影响。
2. 交付：`workCommit` 为空时结果带 `noArtifactCommit: true`；人读输出与桥接通知明确写"本次交付没有产物提交"，并附上完成凭据中的原因。
3. 接收提示：空报告的实施 run 接收时，`run status` 提示"本轮未产生成果"。
4. 同步 DESIGN 第 202 行附近与 STATES 完成资格章节。

### 非目标

- 不改 cancelled／superseded 的关闭路径。
- 不判断外部提交是否属于本任务（属于审计 F1，由基线冻结任务处理）。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 父任务（总体验收）不受空 scope 守卫约束

## 完成条件

- 自动化测试：空 scope 的 self 任务 close 被 `empty_scope` 拒绝；加 `--no-artifacts --reason` 后成功，交付结果 `noArtifactCommit: true`。
- 审计 F4 场景不再静默完成。

## 输入引用

- 审计 F4。
- `src/domain/completion.ts`、`src/application/task-service.ts:2227+`、`src/application/delivery-service.ts`。

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
- 已交付的 k-fdfd8c171736 按原生会话的 write／edit 调用归属改动：用 bash（python／sed）写的文件会被判 unattributed_paths，需要主会话人工确认。请用 write／edit 工具改文件。
- “父任务不受空 scope 守卫约束”：父任务指存在子任务（其他任务的 parent 指向它）的任务。总任务 k-2c0d10318898 就是这种情况，它将由主会话以空 scope 关闭，请确保这条路径可用并有测试。

## 完成记录（2026-11-08 主会话，self 验证）
- 实施 run-b92d4e059ced completed／implementation_accepted（约 2.2 小时），worker 报告 npm test 650/650，empty-scope-guard 6/6，凭据扫描 0 命中。
- 主会话自检：复跑 npm test 650/650 通过；核对 actualChangedPaths 18 个路径与工作区一致。
- 未运行：真实 Pi 宿主里的桥接 deliveryNotice／noOutputNotice 通知。

### 交付记录

<!-- knit:delivery:op-695d4089adfd -->
- 操作: op-695d4089adfd
- 时间: 2026-11-08T23:44:45.153Z
- 分支: refs/heads/main
- 授权来源: .knit/tasks/11-07-audit-fix-plan/plan.md#执行授权
- 工作提交: 59b2ef0682fb26af52b41a86473bdc2dd9d60918
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-07-empty-scope-guard

<!-- knit:progress:end -->
