---
id: k-8d2dc8c0ea82
title: 隔离层识别并始终屏蔽项目内 Knit 主会话插件 .agents/plugins/knit
status: delivered
stage: null
verification: independent
parent: k-a9c3c3ddec63
dependsOn: []
priority: P1
createdAt: 2026-11-22T16:08:52.917Z
---

## 目标与范围

使 Antigravity 执行者（Worker）的隔离预检与 macOS `sandbox-exec` 沙箱能够识别项目内由 `knit init` 生成的主会话插件目录 `.agents/plugins/knit/`，做到「派发不误拒、执行者永远看不到也改不了」：

1. **派发前预检（`agyPreflight`）排除 `.agents/plugins/knit`，继续拦截其它第三方插件**：
   - 现状：`src/adapters/antigravity/isolation.ts` 中，当环节声明 `external`（含 `tools: all` 或省略 `tools`）时，`agyPreflight` 检查工作区 `.agents/plugins` 只要非空（或在未建 Worktree 时 Git 树中存在 `.agents/plugins`）就直接拒绝派发，导致安装了 `.agents/plugins/knit/` 的项目无法派发带 `external` 的 AGY 执行者。
   - 做法：在检查工作区 `.agents/plugins`（同时覆盖已有 Worktree 的磁盘检查与新 Worktree 的 Git 树检查，以及大小写不敏感与符号链接检查）时，若 `.agents/plugins` 下**仅**包含 Knit 主会话插件目录 `knit`（且不是指向 `.agents` 或 `hooks.json` 的恶意别名链接），不将其判定为不可隔离的第三方外部插件；若 `.agents/plugins` 下同时存在其它任意插件条目，或兼容目录（`.agent/plugins` 等）存在插件，或存在 `plugins.json`，仍按原规则拒绝并指出具体路径。
2. **外层与命令沙箱始终屏蔽 `.agents/plugins/knit` 的读取与写入**：
   - 现状：未声明 `external` 时 `.agents/plugins` 已被外层沙箱拒绝读取；`.agents` 整体已在 `WORKSPACE_CONTROL` 中拒绝写入。
   - 做法：确保无论环节是否声明 `external`，外层沙箱和命令沙箱始终对 `.agents/plugins/knit`（及其 `realpath`）生成 `(deny file-read-data ...)` 与 `(deny file-write* ...)`，使执行者（Worker）在任何能力组合下都无法加载主会话 Knit 插件、也不会注入主会话讨论规范。
   - 同步更新 `docs/design/DESIGN.md` 第 7.4 节说明。

边界：
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json` 及流程引用的 `.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，不得修改。
- 不放松对第三方工作区插件、主目录插件、MCP、外部钩子或兼容目录链接的任何现有拒绝规则；不改变 `.agents/hooks.json` 的冲突拒绝规则。

## 完成条件

### Requirement: 含 .agents/plugins/knit 的项目可正常派发 AGY 执行者且不影响第三方插件拦截

#### Scenario: 仅存在 .agents/plugins/knit 时允许派发，存在其它插件时仍拒绝

- GIVEN 临时 Git 仓库（覆盖新 Worktree 与已有 Worktree 两种情况）仅包含 `.agents/plugins/knit/`（内含 `plugin.json`、`hooks.json`、`rules/AGENTS.md`），对照组另包含 `.agents/plugins/other/`
- WHEN 分别派发 `tools: [read, write, exec]` 与 `tools: all`（含 `external` 与 `network`）的 Antigravity 环节
- THEN 仅含 `.agents/plugins/knit/` 时两种配置均通过 `agyPreflight` 派发成功；同时存在 `.agents/plugins/other/` 时，`tools: all` 仍在派发前被拒绝并指出冲突路径

### Requirement: 执行者沙箱在任何能力组合下均屏蔽 .agents/plugins/knit 的读写

#### Scenario: 无论是否开放 external，外层与命令沙箱均拒绝读写 .agents/plugins/knit

- GIVEN 含 `.agents/plugins/knit/hooks.json` 与 `rules/AGENTS.md` 的 Worktree
- WHEN 在真实 macOS `sandbox-exec` 下分别以 `tools: [read, write, exec]` 和 `tools: all` 启动模拟 `agy` 进程并尝试读取与写入 `.agents/plugins/knit/` 内文件
- THEN 两种能力组合下读取与写入均返回 `EPERM`，而同目录中其它允许的只读文本定制（如 `.agents/skills/`）在开放 `external` 时仍按既有规则可读

## 待澄清

## 相关资料

- `src/adapters/antigravity/isolation.ts` — `WORKSPACE_EXTERNAL`、`WORKSPACE_CONTROL`、`agyPreflight` 与 `sandboxProfile`
- `src/adapters/antigravity/execution.ts` — 调用 `sandboxProfile` 的位置
- `test/antigravity.test.mjs` — Antigravity 预检与真实 `sandbox-exec` 回归测试
- `docs/design/DESIGN.md#7-执行` — 第 7.4 节 Antigravity 工具隔离设计

## 结果

已完成 AGY 隔离层对 .agents/plugins/knit 的派发豁免与两层沙箱无条件读写屏蔽，经独立审查（r-70b77770f452）修复两类预检边界并复验通过：npm run typecheck、git diff --check、专项沙箱与派发测试及 macOS 双终端 npm test（476 通过、0 失败、7 跨文件系统跳过）全绿。
