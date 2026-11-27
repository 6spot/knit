---
id: k-2bc7f6d855dd
title: 修复 WorkBuddy 钩子改写命令丢失 tool_input 字段
status: delivered
stage: null
verification: independent
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P0
createdAt: 2026-11-27T07:45:24.211Z
---

## 目标与范围

修复 WorkBuddy 桌面端主会话 `PreToolUse` 钩子改写 Bash 命令（注入 `KNIT_HOST=workbuddy` 与 `KNIT_HOST_SESSION`）时丢失 `tool_input` 其余原始字段的问题：

- 当前 `src/adapters/workbuddy/host-hook.ts` 在命令发生改写时只返回 `updatedInput: { command: checked.command }`，会静默丢弃原始 `tool_input` 中的 `timeout`、`description` 等其余字段。
- 改为与同协议的 `src/adapters/qoder/host-hook.ts` 保持一致，返回 `{ ...toolInput, command: checked.command }`。
- 保持原有交付授权核对、`knit run start` 拒绝拦截以及未改写时返回 `null` 的行为不变。

### 范围外
- 不抽取 WorkBuddy 与 Qoder 的公共钩子基架（后续按需单独评估）。
- 不修改 WorkBuddy 的 `<system-reminder>` 或 `<user_query>` 转录解析逻辑。
- 不修改 `src/application/host-command.ts` 或 `docs/design/DESIGN.md`（若设计第 5.2 节对 WorkBuddy `updatedInput` 行为描述需要补齐一句说明，可核对 `docs/design/DESIGN.md#5-交接` 后按需同步，不改变既有授权与拒绝规则）。

## 完成条件

### Requirement: WorkBuddy 改写 Bash 命令时保留其余 `tool_input` 字段
#### Scenario: 改写 `knit context --use` / `--unuse` 或 `knit task new` 时保留原始附加字段
- WHEN WorkBuddy `pre-tool-use` 收到 `tool_name: "Bash"` 且 `tool_input` 除 `command` 外还包含额外字段（如 `timeout`、`description`），且命令命中需要注入宿主会话变量的改写条件
- THEN 钩子返回的 `hookSpecificOutput.updatedInput` 包含改写后的 `command` 以及原始 `tool_input` 中的全部其余字段，且不修改原输入对象

#### Scenario: 未发生改写或触发拒绝时行为不变
- WHEN 命令不需要改写，或触发 `knit run start` 拒绝、或交付授权核对失败
- THEN 未改写时仍返回 `null`；拒绝场景仍返回 `permissionDecision: "deny"` 及原拒绝原因，不返回 `updatedInput`

### Requirement: 验证与交付
#### Scenario: 类型检查、构建与定向测试通过并完成独立审查
- WHEN 运行 `npm run typecheck`、`npm run build` 及 `node --test test/host-hook.test.mjs`（并按需核对全量 `npm test`）
- THEN 新增回归用例覆盖上述场景且全部通过；改动保留在任务 Worktree 中，不自行提交，交由独立审查环节核验

## 待澄清

## 相关资料

- `src/adapters/workbuddy/host-hook.ts` — WorkBuddy 桌面主会话钩子适配器
- `src/adapters/qoder/host-hook.ts` — Qoder 同协议 `updatedInput` 实现参照
- `test/host-hook.test.mjs` — 宿主钩子测试套件
- `docs/design/DESIGN.md#5-交接` — WorkBuddy `PreToolUse` 钩子设计说明

## 结果

已修复 WorkBuddy PreToolUse 钩子在改写 Bash 命令时丢失其余 tool_input 字段的问题，改为保留原始 tool_input 全部字段并仅覆盖 command，同时在 docs/design/DESIGN.md 第 5.2 节同步说明并在 test/host-hook.test.mjs 补齐回归用例（含冻结原对象及拒绝场景无 updatedInput 断言）。3 条完成条件全部满足。独立审查（r-17fe63c32929）结论为 pass，审查者独立验证通过 npm run typecheck、npm run build、git diff HEAD --check 与 node --test test/host-hook.test.mjs（17/17 通过，0 失败，0 跳过）。未验证：未运行全量 npm test（按局部改动规则仅运行定向测试）及未在真实 WorkBuddy Desktop 窗口复测。
