---
id: k-1d417ae1a322
title: 统一纯桌面宿主上下文引导与 independent 无记录收尾文案
status: delivered
stage: null
verification: self
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P1
createdAt: 2026-11-27T10:45:29.591Z
---

## 目标与范围

背景：
- 在 WorkBuddy 与 Qoder 等纯桌面 GUI 主会话宿主中，`guidance` 与 `PreToolUse` 钩子明确拒绝 `knit run start` 并要求使用宿主自身工具与原生子 Agent 完成实现和检查。但 `src/application/session-context.ts` 的 `nextLine` 目前无差别输出 `下一步: 派发${step.stage.name}环节（knit run start ${id}）`，导致同一份注入上下文中 `status` 块与 `guidance` 块自相矛盾，误导模型触发被拒绝的命令。
- 在纯桌面宿主中，`verification: independent` 任务由宿主原生子 Agent 完成独立审查，Knit 的 `record.json` 中没有外部 `review` 执行记录，关闭任务只能走 `knit task close <id> --result ... --reason ...`。但 `src/application/task-lifecycle.ts` 当前在无 `lastPassedReview` 时硬编码拒绝提示「独立审查的任务要在审查通过后才能完成；用户明确要求直接完成时，加 --reason <理由>」，并在 `task.md` 的 `## 结果` 末尾写入失实的「没有经过独立审查，直接完成：<reason>」。

范围：
1. **纯桌面宿主原生派发模式的上下文「下一步」引导**（`src/application/session-context.ts`、`src/application/host-hook.ts`、`src/adapters/workbuddy/host-hook.ts`、`src/adapters/qoder/host-hook.ts`）：
   - 为 `hostContext`、`contextBlocks`、`statusLines`、`nextLine` 增加可选的纯原生派发选项（如 `nativeDispatch?: boolean` 或 `dispatchMode?: "external" | "native"`，默认保持原有外部派发行为不变）。
   - WorkBuddy 和 Qoder 在调用 `hostContext` 时启用原生模式；Antigravity、Pi 和普通 CLI (`knit context` / `knit run status` / `knit run wait`) 保持外部派发行为不变。
   - 在原生模式下，当 `step.kind === "dispatch"` 时，`nextLine` 不再提示 `knit run start <id>`，而是提示使用当前宿主自身工具与原生子 Agent 完成该环节，并在完成后运行 `knit task close <id>`；若该任务为 `verification: independent` 且没有已通过的 Knit 审查记录，一并提示完成原生独立检查后在 `knit task close` 中通过 `--reason` 写明检查说明。
   - 当任务状态为 `draft`、`done`、或 `step.kind` 为 `close` / `arbitrate` / `limit` 等其它状态时保持既有提示逻辑。
2. **修正 `independent` 任务无 Knit 审查记录时的拒绝与落盘文案**（`src/application/task-lifecycle.ts`）：
   - 拒绝提示改为：`独立审查的任务需要在 Knit 审查通过后才能完成；如已通过其他方式完成审查或用户明确要求直接完成，加 --reason <说明>`。
   - 落盘写入 `task.md` 的补充行改为：`未通过 Knit 独立审查记录，按说明完成：${options.reason}`。
   - 保持 `closeTask` 的所有校验条件与状态推进规则不变（仅调整提示与落盘措辞）。
3. **同步文档与测试**（`docs/design/DESIGN.md`、`test/host-hook.test.mjs`、`test/context.test.mjs`、`test/task-lifecycle.test.mjs`）：
   - 核对 `docs/design/DESIGN.md` 中关于 `knit task close --reason` 与 WorkBuddy / Qoder 上下文注入的描述，确保与新行为一致。
   - 更新 `test/task-lifecycle.test.mjs` 中对应旧文案的断言（第 391、403、800 行附近），并在 `test/host-hook.test.mjs` 和 `test/context.test.mjs` 补充验证：WorkBuddy / Qoder 选中 `ready`（含 `self` 与 `independent`）任务时注入上下文不再出现 `knit run start <id>` 的下一步建议，而 Antigravity / 默认上下文仍保留 `knit run start <id>`。

不在范围内：
- 不改变 `closeTask` 的 `--reason` 必填门槛、状态流转或权限校验逻辑。
- 不改变 WorkBuddy / Qoder `PreToolUse` 对 `knit run start` 的拒绝行为。

## 完成条件

- WorkBuddy 与 Qoder 宿主选中 `ready` / `active` 任务注入上下文时，「下一步」不再提示运行 `knit run start <id>`，而是引导原生工具/子 Agent 推进并收尾（`independent` 任务明确提示用 `--reason` 写明原生独立检查说明）。
- Antigravity、Pi 与普通 CLI 上下文及 `knit run status` / `knit run wait` 的既有输出保持不变。
- `closeTask` 对无 Knit 审查记录的 `independent` 任务使用准确的拒绝提示与 `未通过 Knit 独立审查记录，按说明完成：<reason>` 落盘文案。
- `docs/design/DESIGN.md` 与实现保持一致。
- `npm run typecheck`、`npm run build` 和受影响测试（`node --test test/host-hook.test.mjs test/context.test.mjs test/task-lifecycle.test.mjs test/run-control.test.mjs test/run-prepare.test.mjs`）全部通过。

## 待澄清

无。

## 相关资料

- [src/application/session-context.ts](src/application/session-context.ts)
- [src/application/host-hook.ts](src/application/host-hook.ts)
- [src/adapters/workbuddy/host-hook.ts](src/adapters/workbuddy/host-hook.ts)
- [src/adapters/qoder/host-hook.ts](src/adapters/qoder/host-hook.ts)
- [src/application/task-lifecycle.ts](src/application/task-lifecycle.ts)
- [docs/design/DESIGN.md](docs/design/DESIGN.md)
- [test/host-hook.test.mjs](test/host-hook.test.mjs)
- [test/context.test.mjs](test/context.test.mjs)
- [test/task-lifecycle.test.mjs](test/task-lifecycle.test.mjs)

## 结果

完成 WorkBuddy 与 Qoder 纯桌面宿主原生派发模式的上下文下一步引导统一，避免再提示会被 PreToolUse 拒绝的 knit run start；同步更新 independent 无 Knit 审查记录时的拒绝与落盘文案及 docs/design/DESIGN.md；npm run typecheck && npm run build && npm test 通过（572/579 通过，0 失败，7 项跨文件系统测试跳过）。
