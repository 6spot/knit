---
id: k-ef5cf824ebb7
title: 全局安装提示词缓存修复并刷新本仓库 Pi 桥接
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-28T06:09:08.132Z
---

## 目标与范围

按用户授权，从通过复审的提示词缓存修复工作树打包并安装到本机默认 npm 全局位置，刷新本仓库实际使用的 Pi 桥接。恢复本仓库已有的工作流、模型与角色定制。

## 完成条件

- Rex 终端和独立的普通终端均在打包源树运行全量测试，覆盖跨文件系统用例。
- `npm run pack:install` 完成，PATH 上的 Knit、包内 Pi 模板与分块 CLI 均来自受审查的源码。
- 本仓库执行 `knit init --force` 后，实际加载的 Pi 文件与安装模板逐字相同，安装前工作流按字节复原，`knit workflow validate` 通过。记录安装入口、版本和验证结果。

## 待澄清

## 相关资料

- `.knit/tasks/11-28-pi-dynamic-context-prompt-cache/task.md`
- `scripts/pack-install.mjs`
- `.knit/tasks/archive/2026-11/11-27-reinstall-and-dual-terminal-verify/task.md`

## 结果

从独立复审通过的缓存修复工作树以 npm run pack:install 全局安装 Knit 0.1.0，PATH 入口指向 Node 26.3.0 的全局包。普通终端与 Rex 终端各自通过 679/679 项测试（含跨卷，0 跳过）；pack:check 通过，包内 77 个文件逐字核对通过。knit init --force 刷新项目 .pi/extensions/knit.ts，源码、全局模板和项目桥接一致（SHA-256 9ebfe7ccb891cf5f6d350b7bc4f58d7086088b89fa7a9fa815bfd4dd02b4b1ec）。恢复已有工作流后 SHA-256 与安装前相同（a5b9a7741ef8293c0693b5c863e2888aec9290c26cabdf8c5ea0459048934ee7）。workflow validate --env（Antigravity 1.5.13）、归档列表、实际 context --json 通过。证据保存在 .knit/.runtime/cache-install-8h8n6ahg/。
