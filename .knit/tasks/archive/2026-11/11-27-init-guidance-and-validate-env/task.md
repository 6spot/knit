---
id: k-4b380aa4d634
title: 完善冷启动引导与 workflow validate --env 检查
status: delivered
stage: null
verification: independent
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P0
createdAt: 2026-11-27T08:27:39.339Z
---

## 目标与范围

消除 Knit 首次初始化与环境预检中的三处冷启动断层，让新项目与新协作者按输出指引就能一次配通：

1. **`knit init` 缺少宿主引导与 `sharedSettings` 未接入告警（`src/application/init.ts`、`src/cli/project.ts`）**：
   - **未启用任何宿主桥接的引导**：`knit init` 执行结束后，若项目内仍不存在任何有效宿主桥接（按 `HOST_SPECS` 与 `installedBridge` 判定），输出一行后续指引，提示按客户端运行 `knit init --pi` / `--agy` / `--workbuddy` / `--qoder` 安装主会话桥接，再运行 `knit workflow validate --env` 检查派发环境。已有任一有效宿主桥接时不显示该提示。
   - **`sharedSettings` 静默跳过告警**：本次显式指定带 `sharedSettings` 的宿主（`--workbuddy` / `--qoder`）且未带 `--force` 时，若其 `settings.json` 已存在被归入「已有，没有动」且 `installedBridge()` 判定尚未包含 Knit 钩子，明确输出告警：指出该文件保留了已有配置、Knit 钩子尚未接入，提示手工合入 `SessionStart`、`UserPromptSubmit`、`PreToolUse` 钩子，或运行 `knit init --force --<host>` 备份后恢复模板。
   - **保持既有输出契约**：上述引导与告警放在 `初始化任务:` 之前，确保首次初始化建出引导任务时 `初始化任务:` 仍严格处于输出最后一行（遵守 `docs/design/DESIGN.md#4-规范`）。

2. **`knit workflow validate --env` 检查角色文件存在性（`src/cli/project.ts`）**：
   - 在 `reportEnvironment()` 中通过 `workflowPrompts(workflow)` 检查流程引用的全部角色文件在项目根下是否存在且为普通文件；全部存在时输出通过项，缺失或非普通文件时列出问题路径与修复建议（补齐角色文件或运行 `knit init`）并返回退出码 1。

3. **Antigravity 主会话为 `knit workflow validate --env` 注入默认 `KNIT_SESSION_AGENT`（`src/application/host-command.ts`、`src/adapters/antigravity/host-hook.ts`）**：
   - 当命令为 `knit workflow validate` 且带有 `--env` 时，若命令行未显式设置 `KNIT_SESSION_AGENT`，在提供宿主默认执行者变量的宿主（Antigravity）下同样注入 `KNIT_SESSION_AGENT="${KNIT_SESSION_AGENT-antigravity}"`，使纯 Antigravity 用户在主会话运行 `knit workflow validate --env` 时按 Antigravity 检查而非误报缺少 `pi`。
   - **关键约束**：`knit workflow validate --env` 不是 `knit run start`，绝不得触发 `hasStart` / `rejectStartReason`（WorkBuddy 与 Qoder 桌面端必须继续放行 `knit workflow validate --env`，同时继续拦截 `knit run start`），且不得影响交付授权核对的任何边界。

4. **设计文档同步（`docs/design/DESIGN.md`）**：
   - 同步更新第 5.2 / 9 / 10 节对应说明：`knit workflow validate --env` 的角色文件检查与 Antigravity 钩子注入，以及 `knit init` 的宿主引导和未接入 `settings.json` 告警。

### 范围外
- 不自动修改或合入用户已有的 `.workbuddy/settings.json` / `.qoder/settings.json`。
- 不新增 `knit doctor` 等新命令（遵守第 11 节克制边界）。
- 不修改 WorkBuddy / Qoder 的 `knit run start` 拒绝策略或交付授权核对规则。

## 完成条件

### Requirement: `knit init` 给出缺失宿主引导与未接入 `settings.json` 告警
#### Scenario: 无任何已安装宿主桥接时输出后续引导且不破坏初始化任务末行位置
- WHEN 在空项目运行不带宿主选项的 `knit init`
- THEN 输出包含安装宿主桥接（`--pi`、`--agy`、`--workbuddy`、`--qoder`）与 `knit workflow validate --env` 的提示，且最后一行仍是 `初始化任务: 完善项目的开发规范（...）`；当项目已有有效宿主桥接时不再显示该提示

#### Scenario: 显式指定 `--workbuddy` 或 `--qoder` 但已有自定义 `settings.json` 未含 Knit 钩子时给出告警
- WHEN 项目已存在不含 Knit 钩子的 `.workbuddy/settings.json`（或 `.qoder/settings.json`），运行 `knit init --workbuddy`（或 `--qoder`，不带 `--force`）
- THEN 原 `settings.json` 保持逐字节不变，输出明确告警该文件尚未接入 Knit 钩子并给出手工合入或 `--force` 备份覆盖建议；当该文件已含 Knit 钩子时不出告警

### Requirement: `knit workflow validate --env` 检查角色文件存在性
#### Scenario: 角色文件存在时通过，缺失时失败并指出路径与修复建议
- WHEN 在流程有效的项目中运行 `knit workflow validate --env`，分别在所有 `prompt` 文件齐全与删去某个 `prompt` 文件后检查
- THEN 文件齐全时角色文件检查项通过；缺失时该项失败、列出缺失路径与修复建议且命令返回退出码 `1`

### Requirement: Antigravity 主会话钩子为 `knit workflow validate --env` 注入默认 `KNIT_SESSION_AGENT`
#### Scenario: Antigravity 注入默认 Agent 且 WorkBuddy/Qoder 放行不拦截
- WHEN `knit workflow validate --env`（含显式 `KNIT_SESSION_AGENT=pi ...` 与未显式指定两种情况）经过 Antigravity、WorkBuddy、Qoder 的 `PreToolUse` 钩子
- THEN Antigravity 在未显式指定时改写命令注入 `KNIT_SESSION_AGENT="${KNIT_SESSION_AGENT-antigravity}"`，显式指定时保持原命令不变；不带 `--env` 的 `knit workflow validate` 不改写；WorkBuddy 与 Qoder 均放行不触发 `knit run start` 拒绝；交付授权核对行为全部保持不变

### Requirement: 文档同步且全量验证通过并经独立审查
#### Scenario: 设计同步、测试全绿并交由独立审查核验
- WHEN 核对 `docs/design/DESIGN.md`，并运行 `npm run typecheck`、`npm run build`、受影响测试（`test/init.test.mjs`、`test/workflow-cli.test.mjs`、`test/host-hook.test.mjs`）以及全量 `npm test`
- THEN 文档与实现一致，新增回归用例与既有测试全部通过（环境受限跳过的跨文件系统用例除外）；改动保留在任务 Worktree 中，不自行提交，交由独立审查核验

## 待澄清

## 相关资料

- `src/application/init.ts` — `initProject` 与 `installedBridge` 检测
- `src/cli/project.ts` — `knit init` 输出与 `knit workflow validate --env`（`reportEnvironment`）
- `src/application/host-command.ts` — 宿主命令识别、环境变量改写与交付授权核对
- `src/adapters/antigravity/host-hook.ts` — Antigravity `PreToolUse` 钩子
- `src/contracts/host.ts` — `HOST_SPECS` 宿主定义
- `docs/design/DESIGN.md#4-规范` — `knit init` 初始化任务输出位置约束
- `docs/design/DESIGN.md#9-命令与工具` — `workflow validate --env` 与 `init` 说明
- `test/init.test.mjs` — `knit init` 测试套件
- `test/workflow-cli.test.mjs` — `workflow show/validate --env` 测试套件
- `test/host-hook.test.mjs` — 多宿主钩子与命令解析测试套件

## 结果

已完成冷启动引导与 workflow validate --env 检查完善：knit init 在无已安装宿主桥接时输出后续安装与预检指引（保持初始化任务仍在末行），显式指定 WorkBuddy/Qoder 且已有自定义 settings.json 缺 Knit 钩子时明确告警并保持原文件不变；knit workflow validate --env 新增角色文件普通文件存在性检查；Antigravity PreToolUse 为未显式指定执行者的 knit workflow validate --env 注入默认 KNIT_SESSION_AGENT，且 WorkBuddy/Qoder 照常放行、交付授权核对不受影响；设计文档第 5.2、9、10 节已同步。5 条完成条件全部满足。独立审查（r-9de9ebd9cff7）结论为 pass，审查者独立验证通过 npm run typecheck、npm run build、git diff --check、3 份定向测试（46/46 通过、0 失败、0 跳过）及全量 npm test（552/559 通过、0 失败、7 项跨文件系统跳过）。未验证：7 项跨文件系统测试因环境未配置 KNIT_TEST_CROSS_DEVICE_DIR 跳过。
