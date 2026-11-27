---
id: k-87a8f1cc068d
title: 全局安装新版 Knit、刷新本仓库副本并完成双终端验收
status: delivered
stage: null
verification: none
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P1
createdAt: 2026-11-27T11:42:35.916Z
---

## 目标与范围

在三波 14 项体验打磨、缺陷修复与性能优化全部合入 `main` 后，执行本仓库发版前验收与本机升级（已获用户授权）：

1. 运行 `npm run pack:check` 与 `npm run pack:install`，将当前构建安装为本机全局 `knit`。
2. 运行 `knit init --force` 刷新本仓库生成的桥接、角色文件与默认流程副本，核对 `.knit/.runtime/backups/<时间>/` 备份并恢复本仓库定制的 `.knit/workflow.yaml` 配置（模型 `magpie/remote/group/astra`、`thinking: high` 等环节设置），随后运行 `knit workflow validate --env` 验证通过。
3. 按 `AGENTS.md` 要求，在 **Rex 终端环境** 与 **普通终端环境**（清除 `REX_*` / `TERM_PROGRAM`）下各跑一次全量 `npm test`，并抽检新功能（`knit task list --archive --limit 3`、`knit standards list`、`knit workflow validate --env`）。

## 完成条件

- `npm run pack:check` 与 `npm run pack:install` 执行成功，全局 `knit` 已更新到当前 `main` 代码。
- `knit init --force` 刷新了本仓库生成副本，`.knit/workflow.yaml` 中的本仓库定制模型与环节配置已完整恢复，且 `knit workflow validate --env` 通过。
- Rex 终端与普通终端两次全量 `npm test` 均 0 失败通过。
- 本任务归档交付前确认没有把意外文件纳入提交。

## 待澄清

## 相关资料

- `AGENTS.md` — 本仓库开发、刷新副本与发版前验收规范
- `.knit/workflow.yaml` — 本仓库定制工作流配置
- `.knit/standards/pitfalls.md` — 防止覆盖流程配置避坑项

## 结果

已完成 npm run pack:check（73 个文件全部 PASS）与 npm run pack:install（全局安装 knit 0.1.0）；执行 knit init --force 刷新本仓库生成副本（更新 .agents/plugins/knit/rules/AGENTS.md 与 .pi/extensions/knit.ts），从 .knit/.runtime/backups/20261127-194329-472/ 恢复本仓库定制 .knit/workflow.yaml 并通过 knit workflow validate --env；抽检新版 knit task list --archive --limit 3、knit standards list 与 knit task show 正常；Rex 终端（584/591 通过，0 失败，7 跨卷跳过，33.6s）与普通终端（584/591 通过，0 失败，7 跨卷跳过，33.2s）两次全量 npm test 均通过。
