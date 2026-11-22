---
id: k-70ec54c7daf9
title: 补齐打包检查的 Antigravity 产物
status: delivered
stage: null
verification: self
parent: k-cdf8de80d14c
dependsOn:
  - k-187f77a762fa
priority: P2
createdAt: 2026-11-22T05:40:37.017Z
---

## 目标与范围

补齐打包检查脚本 `scripts/pack-check.mjs` 对 Antigravity 运行时产物的覆盖（原任务中需要用户单独授权的全局安装与本仓库模板同步操作已按 `.knit/standards/task-splitting.md` 拆出为独立任务 `k-4f3398a3ec99`）：

- **现状**：`scripts/pack-check.mjs` 的 `required` 列表只检查了 `dist/adapters/pi/pane-worker.js`，未检查 `dist/adapters/antigravity/pane.js`、`dist/adapters/antigravity/client.js`，以及在 macOS（Darwin）构建环境下必须随包发布的命令进程跟踪器 `dist/adapters/antigravity/command-processes`（及其可执行位）。
- **做法**：在 `scripts/pack-check.mjs` 的 `required` 中加入 `dist/adapters/antigravity/pane.js` 与 `dist/adapters/antigravity/client.js`；当运行平台为 `darwin` 时，额外核对 tarball 包含 `dist/adapters/antigravity/command-processes` 且编译产物具备可执行权限位（`0o111`）。

边界：
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，不得修改。
- 本任务不运行 `npm run pack:install` 或 `knit init --force`（由后续独立授权任务 `k-4f3398a3ec99` 负责）。

## 完成条件

### Requirement: 打包检查覆盖 Antigravity 运行时入口与 macOS 进程跟踪器

#### Scenario: 运行 npm run pack:check 校验 tarball 内容与可执行权限

- GIVEN 完成构建的 Knit 工作区
- WHEN 运行 `npm run pack:check`
- THEN 检查脚本验证 tarball 中包含 `dist/adapters/antigravity/pane.js`、`dist/adapters/antigravity/client.js`，并在 macOS 上验证包含 `dist/adapters/antigravity/command-processes` 且具有可执行位
- AND `npm run pack:check` 退出码为 `0`

## 待澄清

## 相关资料

- `scripts/pack-check.mjs` — npm 打包内容与入口可执行位检查脚本
- `package.json` — `build`、`build:agy-tracker` 与 `pack:check` 脚本定义

## 结果

已在 scripts/pack-check.mjs 中补齐 dist/adapters/antigravity/client.js 与 dist/adapters/antigravity/pane.js 必需文件检查，并在 macOS（darwin）下核对 tarball 包含 dist/adapters/antigravity/command-processes 且产物保留可执行权限位（0o111）。完成条件满足。验证：npm run typecheck 与 npm run pack:check 全部通过（17 项全过，共 82 个文件）。
