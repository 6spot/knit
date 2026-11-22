---
id: k-3bead0494c8e
title: 支持返工时原生 Resume 续聊与增量交接并支持自动回退新会话
status: delivered
stage: null
verification: independent
parent: k-8ac399027fac
dependsOn:
  - k-a629b7913d9b
priority: P1
createdAt: 2026-11-22T07:28:40.586Z
---

## 目标与范围

支持任务在返工再次进入同一环节（例如对抗审查汇总后回到 `implement`）时，复用该环节上一次算数执行的原生会话继续修改（无需重新读取项目上下文），并在原会话不可用、需求已变更或客户端不支持时自动安全回退为全新会话：

1. **保存客户端原生可恢复标识（`TaskRun` 与 `AgentSession`）**：
   - 事实核实（已通过本机 `pi --help` 与 `agy --help` 核验）：
     - Pi 通过 `--session <path>` 按原生 JSONL 会话文件路径恢复（`src/adapters/pi/runtime.ts` 与 `src/adapters/pi/native-file.ts` 已有基础校验与参数支持）；
     - Antigravity（`agy`）通过 `--conversation <ID>` 按原生对话 ID 恢复（而非日志文件路径）。
   - 做法：在 `TaskRunSchema` 增加可选 `resumeId: nullable(str({ minLength: 1 }))`（旧记录省略按 `null` 读），在 `AgentSession`／`SessionOutcome` 暴露原生可恢复标识（Pi 返回经核验的原生会话文件/标识，Antigravity 从原生事件或钩子提取并保存原生 conversation ID；不支持 resume 的适配器返回 `null`）。
2. **续聊判定、增量交接与强制新会话开关**：
   - 在 `workflow.yaml` 环节增加可选布尔字段 `resume`（如 `implement` 环节可配 `resume: true`），并在 `knit run start <id>` 增加 `--fresh` 参数用于强制新开会话。
   - 派发前查找该环节最后一次**算数**执行（同一 `confirmedDigest`、非失败、同一 `agent` 且 `resumeId !== null`；需求变更重新 `task ready` 后摘要变化，自动不续聊）。
   - **增量交接**：决定续聊时，不再把完整角色文件、规范、需求和全部点名资料再灌一遍，而是生成一份精简的增量消息（包含：主会话裁决的修改指令、上一轮审查批次的各份报告或路径、以及本轮报告格式要求），同时在执行目录仍落盘一份完整回退交接（`system.md` + `message.md`）供自动回退新会话时使用。
3. **适配器原生 Resume 实现与自动回退新会话**：
   - 在 `AgentLaunch` 中增加可选 `resume` 信息（含 `resumeId` 与增量消息文件路径，如 `resume-message.md`）。
   - **Pi 适配器**：恢复前通过 `checkNativeSessionFile`（或文件存在+会话头校验）检查目标会话文件；有效时传 `--session <path>`（后台 RPC 与 Rex 窗格均支持）并只发送增量消息；文件缺失、损坏或启动恢复失败时，写明原因至 `worker.log`，自动回退为全新会话（使用完整 `system.md` + `message.md`），不让任务直接失败。
   - **Antigravity 适配器**：支持时通过 `--conversation <resumeId>` 启动（后台 stream-json 与 Rex 交互窗格均核实其在 `sandbox-exec` 下的恢复行为）并发送增量消息；若会话不存在、恢复启动失败或参数不兼容，写明原因至 `worker.log` 并自动回退为全新会话。
   - 在 `run status`／执行记录或日志中明确反映本次是「续聊原会话」还是「已自动回退新会话」。

边界：
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，不得修改。
- 不实现常驻不关窗的后台进程；每次执行结束照常退出客户端进程并拍快照结算。

## 完成条件

### Requirement: 同需求返工时可按原生会话 Resume 续聊并发送增量修改指令

#### Scenario: 审查打回后实现者恢复原原生会话且只收到增量消息

- GIVEN `implement` 环节开启 `resume: true`，首轮实现成功结束并记下有效的 `resumeId`（分别覆盖 Pi 与 Antigravity 适配器），审查后任务回到 `implement` 且需求未改动
- WHEN 运行 `knit run start <id> --instruction "修复两处边界"`（未带 `--fresh`）
- THEN 执行者以原生恢复参数启动（Pi 带 `--session`，Antigravity 带 `--conversation`），发送的是精简增量消息（含主会话指令与审查报告）而非完整重灌需求与资料，并正常完成报告结算与改动快照对比

### Requirement: 不可恢复、需求变更或指定 --fresh 时自动回退为全新会话

#### Scenario: 原会话丢失、恢复失败、需求改过或加 --fresh 时无缝降级新会话

- GIVEN 上一轮实现的 `resumeId` 对应会话文件被删除／启动恢复返回失败，或任务需求修改后重新 `task ready`，或派发时指定 `--fresh`
- WHEN 运行 `knit run start <id>`
- THEN 系统不因无法恢复而中止任务，而是自动回退使用完整 `system.md` 与 `message.md` 启动全新会话并正常完成执行；日志与状态说明回退原因

## 待澄清

- [assumed] `workflow.yaml` 环节的 `resume` 缺省值为 `false`（显式写 `resume: true` 才启用原生续聊，避免默认对无状态审查环节产生上下文污染；默认模板可在后续 `k-25933a16b9f6` 中为 `implement` 环节开启或保持可选项）。

## 相关资料

- `src/contracts/agent.ts` — `AgentLaunch` 与 `AgentSession` 接口
- `src/contracts/task.ts` — `TaskRunSchema` 执行记录契约
- `src/application/handoff.ts` — 全量与增量交接消息生成
- `src/application/run-prepare.ts` — 续聊判定与交接落盘
- `src/application/run-session.ts` — 启动失败回退新会话与报告采集
- `src/adapters/pi/execution.ts` — Pi 执行适配器
- `src/adapters/pi/runtime.ts` — 现有 `--session` 启动参数支持
- `src/adapters/pi/native-file.ts` — 现有 Pi 原生会话文件核验工具
- `src/adapters/antigravity/execution.ts` — Antigravity 启动参数与原生对话 ID 提取
- `src/adapters/antigravity/isolation.ts` — `sandbox-exec` 对 `agy` 历史对话状态的读写范围

## 结果

已实现返工时的原生会话 Resume 续聊、增量交接与自动回退新会话：TaskRun 新增可选 resumeId，workflow 环节支持 resume 开关（默认 false），knit run start 支持 --fresh 强制新开；同需求摘要与同 Agent 返工时，Pi 经 JSONL 内容核验以 --session 恢复并还原首轮系统提示，Antigravity 以 --conversation 在 sandbox-exec 下恢复，均只发送增量修改消息（含主会话指令与上批审查报告）；会话缺失、截断、恢复启动失败或需求变更时自动回退完整交接的新会话并在状态与 worker.log 说明原因。完成条件全部满足。独立审查（r-e1fbe5744948）结论 pass（审查补修 5 处细节含 Pi 截断文件核验、恢复系统提示与假 Pi 信号时序）：npm run typecheck 通过，macOS 普通终端与 Rex 终端 npm test 各 472/472 通过（0 失败，0 跳过），并在真实 Pi 与 agy 1.5.13 下验证了后台与 Rex 全部 4 条原生续聊与回退路径。
