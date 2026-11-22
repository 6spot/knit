---
id: k-4f3398a3ec99
title: 升级全局安装版并同步本仓库模板副本
status: delivered
stage: null
verification: self
parent: k-cdf8de80d14c
dependsOn:
  - k-70ec54c7daf9
priority: P2
createdAt: 2026-11-22T06:32:51.897Z
---

## 目标与范围

将原混合在 `k-70ec54c7daf9` 中的“需用户单独授权的全局安装与模板同步”操作拆分为独立收尾任务（遵循 `.knit/standards/task-splitting.md`：需要用户单独授权的全局安装操作单独成任务）：

- **现状**：当前全局安装的 `knit`（`/Users/me/.local/share/mise/installs/node/latest/bin/knit`）和本仓库由 `knit init` 生成的 `.pi/extensions/knit.ts` 仍停留在接入 Antigravity 之前的旧版本；仓库根目录残留了未清理的 `knit-0.1.0.tgz`。
- **做法**：在前置架构加固（`k-d123fec5fa11`）及 Antigravity 修复、Worktree 安全与打包检查（`k-70ec54c7daf9`）全部交付合并后，经用户明确授权：
  1. 清理根目录残留的 `knit-*.tgz` 文件；
  2. 运行 `npm run pack:install` 升级全局安装版；
  3. 运行 `knit init --force` 重新生成本仓库的 `.pi/extensions/knit.ts` 与 `.knit/agents/` 副本，并按 `.knit/standards/pitfalls-main.md` 提醒从 `.knit/.runtime/backups/` 恢复本仓库手工改过的 `.knit/workflow.yaml` 配置；
  4. 核对全局安装目录中的 `dist/` 与工作区 `dist/` 一致、`.pi/extensions/knit.ts` 与 `assets/templates/pi/extensions/knit.ts` 一致。

边界：
- 全局安装（`npm run pack:install`）和 `knit init --force` 均须在用户明确授权后由主会话执行（本仓库的 `.knit/workflow.yaml` 和 `.knit/agents/` 由 `src/application/workspace.ts` 的 `protectedChanges` 保护，不派发给 Worktree 执行者修改）。
- 本仓库 `.knit/standards/pitfalls-worker.md` 与 `.knit/workflow.yaml` 的既有未提交改动按用户决定保留或单独提交，不擅自丢弃。

## 完成条件

### Requirement: 全局安装版与本仓库桥接模板副本同步到最新基线

#### Scenario: 经用户授权执行全局安装、模板重新生成并恢复流程配置

- GIVEN 前置代码子任务均已交付并合并，且用户已明确授权升级全局安装版与运行 `knit init --force`
- WHEN 清理根目录残留的 `.tgz`，运行 `npm run pack:install` 与 `knit init --force`（并从备份恢复本仓库的 `.knit/workflow.yaml` 设置）
- THEN 全局安装目录中的 `dist/` 与工作区 `dist/` 内容一致，`.pi/extensions/knit.ts` 与 `assets/templates/pi/extensions/knit.ts` 逐字一致，根目录无残留 `.tgz`
- AND 在 macOS 普通终端与 Rex 终端运行 `npm test` 全部通过

## 待澄清

## 相关资料

- `scripts/pack-install.mjs` — 全局打包安装脚本
- `assets/templates/pi/extensions/knit.ts` — Pi 桥接扩展模板唯一来源
- `.knit/standards/pitfalls-main.md` — `knit init --force` 覆盖 `.knit/workflow.yaml` 的恢复做法
- `docs/design/DESIGN.md#10-用-knit-开发-knit` — 安装版升级与模板重新生成规范

## 结果

已完成全局安装版升级与本仓库副本同步：1）运行 npm run pack:install 升级全局 knit（/Users/me/.local/share/mise/installs/node/26.3.0/lib/node_modules/knit）并清理根目录 knit-0.1.0.tgz；2）运行 knit init --force 同步 .pi/extensions/knit.ts 与 .knit/agents/review.md，并从备份恢复本仓库 .knit/workflow.yaml（保留未提交的 pitfalls-worker.md 与 workflow.yaml 不动）。核对：全局 dist/ 与工作区 dist/ 完全一致，.pi/extensions/knit.ts、.knit/agents/implement.md、.knit/agents/review.md 与模板逐字一致，根目录无残留 .tgz，knit workflow validate 通过；npm run typecheck、npm run pack:check 通过，macOS Rex 与普通环境 npm test 各 467/474 通过（0 失败，7 跨文件系统用例按环境跳过）。
