---
id: k-8ac399027fac
title: 支持单环节多模型并行对抗审查与原会话续修（主任务）
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P1
createdAt: 2026-11-22T07:28:40.127Z
---

## 目标与范围

这是主任务，用于在架构加固（`k-d123fec5fa11`）与 Antigravity 基础边界修复（`k-cdf8de80d14c`）之后，为 Knit 补齐两项互补的核心能力，形成「单实现者上下文连续修改 + 多模型只读并行对抗审查 + 主会话裁决汇总」的工作流闭环：

1. **已与用户确认的三项核心架构决定**：
   - **并行对抗审查强制只读**：单环节配置多个执行器并行跑时，禁止包含 `write` 能力，只做只读审查与给结论，所有代码修改统一交回实现者执行，避免同 Worktree 并发写冲突与改动快照污染。
   - **并行全员结束后交回主会话裁决汇总**：同一批次的所有并行审查者全部结束后，将全部报告交给主会话过滤误报、解决模型间分歧并整理明确修改清单，再由主会话带修改指令派发返工。
   - **返工保留上下文采用原生 Resume 续聊（而非常驻进程/不关窗）**：执行结束照常退出进程；再次进入可续聊环节时，通过原生恢复参数（实测本机 CLI：`pi --session <path>`、`agy --conversation <id>`）恢复该环节上次算数的原生会话并发送增量修改指令；客户端不支持、原生会话缺失/损坏或指定 `--fresh` 时自动回退为全新会话。
2. **子任务拆解（详见 `.knit/tasks/11-22-multi-agent-review-and-resume/plan.md`）**：
   - `k-f3d79c718b3e`：在 `workflow.yaml` 契约与校验层支持环节配置多执行器列表，并强制多执行器环节禁止 `write` 能力。
   - `k-a629b7913d9b`：扩展 `TaskRun` 与进度/派发/等待/取消/交接逻辑，支持单任务按批次并行派发多个只读审查者、Join 全员结算、多报告与主会话修改指令交接。
   - `k-3bead0494c8e`：记录原生可恢复会话标识，支持返工时按原生 Resume 续聊与增量交接，不可恢复时自动回退新会话。
   - `k-25933a16b9f6`：同步 Pi 桥接模板、只读审查角色模板与 `docs/design/DESIGN.md`，并在经用户授权后用真实 Pi + Antigravity 模型完成全链路实机验收。

不在本主任务范围内：常驻后台 worker 守护进程、窗口全程不关闭的双向 IPC 推送、多审查者并发改代码及独立审查 Worktree 合并。

## 完成条件

### Requirement: 多模型对抗审查与原会话续修全部子任务交付且验证通过

#### Scenario: 4 个子任务按序完成交付并通过全量测试与闭环验收

- GIVEN `.knit/tasks/11-22-multi-agent-review-and-resume/plan.md` 列出的 4 个子任务
- WHEN 各子任务按依赖顺序完成实现、审查与交付，且主任务汇总各子任务的交付提交与验证记录
- THEN 4 个子任务全部处于 `delivered`（或经用户决定 `cancelled`），主任务自身无代码改动
- AND 在 macOS 普通终端与 Rex 终端运行 `npm test` 全部通过，`npm run typecheck` 与 `npm run pack:check` 均通过

## 待澄清

## 相关资料

- `.knit/tasks/11-22-multi-agent-review-and-resume/plan.md` — 子任务拆解、依赖顺序与验证约定
- `.knit/tasks/11-22-architecture-hardening/plan.md` — 前置架构加固任务清单（已为本主任务预留 `AgentSpec` 三元组校验与 `AgentLaunch` 口子）
- `.knit/tasks/11-22-agy-and-worktree-fixes/plan.md` — 前置 Antigravity 边界修复任务清单
- `docs/design/DESIGN.md` — 现行设计文档（交接、流程、执行与返工）
- `src/adapters/pi/native-file.ts` — 现有 Pi 原生会话文件只读核验辅助
- `src/adapters/pi/runtime.ts` — 现有 Pi `--session` 启动参数支持

## 结果

4 个多模型并行对抗审查与原生 Resume 续修子任务全部交付并合并至 main：k-f3d79c718b3e（0a837a4）、k-a629b7913d9b（031cb8b）、k-3bead0494c8e（9c53e85）、k-25933a16b9f6（见最近提交）。主任务无代码改动。验证：npm run typecheck、npm run pack:check 均通过，macOS Terminal.app 与 Rex 终端 npm test 各 474/474 通过，实机双模型闭环验收证据已归档至 validation/adversarial-review-resume/。
