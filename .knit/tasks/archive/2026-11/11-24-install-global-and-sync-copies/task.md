---
id: k-8088538441ee
title: 升级全局 knit 安装、同步生成副本、清理旧规范副本并记录避坑项
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-24T06:31:09.250Z
---

## 目标与范围

将 `main` 上已完成收敛与内置规范改造的 Knit 打包并全局安装（`npm run pack:install`），让全局 `knit` 切换至内置 `assets/standards/` 与新版模板；随后用新版 `knit init --force` 刷新本仓库的生成副本（并按避坑清单还原 `.knit/workflow.yaml` 的本仓库定制项），删除 `.knit/standards/` 下 4 份已被内置规范替代的旧副本，并把 Batch 5 返工教训记入 `.knit/standards/pitfalls.md`。

**改动范围（范围内）**：
1. **全局安装**：运行 `npm run pack:install`，确认全局 `knit` 指向最新 0.1.0 构建并可加载内置规范。
2. **刷新生成副本并保住流程定制**：运行 `knit init --force` 更新 `.knit/agents/{implement,review}.md`、`.pi/extensions/knit.ts` 与 `.agents/plugins/knit/hooks.json`；立即从 `.knit/.runtime/backups/` 还原 `.knit/workflow.yaml`，确保本仓库本地流程配置不被覆盖。
3. **清理 4 份旧规范副本**：确认全局 `knit standards list` / `show` 已直接读取内置 `assets/standards/` 后，删除 `.knit/standards/{delivery,discussion,task-splitting,task-writing}.md`。
4. **记录避坑项**：在 `.knit/standards/pitfalls.md` 的 `implement, review` 分组补一条 Batch 5 返工教训（全量并行墙钟定位长尾，且不可为了提速跳过依赖 `run start` worker 身份的 Rex 窗格登记路径）。

**边界（范围外）**：
- 本任务由主会话直接执行（涉及全局安装与受保护路径 `.knit/standards/`、`.knit/agents/`，不派发工作树执行者）。
- 不提交或还原工作区里属于其它未完成项的改动（如 `.knit/workflow.yaml` 的既有本地修改、其它任务草稿目录）。
- 不运行 `git push`。

## 完成条件

### Requirement: 全局安装版切换至内置规范并刷新仓库生成副本
#### Scenario: 全局 knit 加载内置规范且生成副本与模板一致
- WHEN 运行 `npm run pack:install` 与 `knit init --force`（并从备份还原 `.knit/workflow.yaml`），随后删除 `.knit/standards/{delivery,discussion,task-splitting,task-writing}.md`
- THEN 全局 `knit --version` 输出 `0.1.0`，`knit standards list` 展示内置 4 份通用规范与本仓库项目规范（`development`、`commit-message`、`pitfalls`），`knit workflow validate` 通过，`.knit/agents/{implement,review}.md`、`.pi/extensions/knit.ts`、`.agents/plugins/knit/hooks.json` 与 `assets/templates/` 一致且 `.knit/workflow.yaml` 保留原有本地定制。

### Requirement: 避坑清单记录生效且回归测试通过
#### Scenario: pitfalls 可按环节检索且基础校验通过
- WHEN 在 `.knit/standards/pitfalls.md` 写入 Batch 5 返工教训后运行 `knit standards pitfalls implement`、`knit standards pitfalls review` 与相关测试
- THEN 新避坑项在 `implement` 与 `review` 环节均能检索到，相关测试与 `npm run typecheck` 通过。

## 待澄清

## 相关资料

- `.knit/standards/pitfalls.md` — 本仓库统一避坑清单（含 `knit init --force` 备份还原流程）
- `scripts/pack-install.mjs` — 全局打包安装脚本
- `assets/standards/` — 内置通用规范来源
- `assets/templates/` — 本仓库生成副本模板来源

## 结果

已完成全局安装与副本同步收尾：运行 npm run pack:install 升级全局 knit 0.1.0（/Users/me/.local/share/mise/installs/node/26.3.0/bin/knit）；运行 knit init --force 刷新 .knit/agents/{implement,review}.md、.pi/extensions/knit.ts 与 .agents/plugins/knit/hooks.json，并从 .knit/.runtime/backups/20261124-144052-874 还原 .knit/workflow.yaml 本地配置；删除 .knit/standards/{delivery,discussion,task-splitting,task-writing}.md 4 份旧规范副本；在 .knit/standards/pitfalls.md 的 implement, review 分组记录 Batch 5 返工避坑项。验证：knit --version 输出 0.1.0，knit standards list 列出 4 份内置 knit:standards/* 与 3 份项目规范，knit workflow validate 通过，knit standards pitfalls implement/review 均可检出新条目，4 份生成副本与 assets/templates/ 逐字节一致，npm run typecheck 与 standards/init/workflow 91/91 测试全绿（2.47s）。
