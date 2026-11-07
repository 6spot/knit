---
id: k-836997c84864
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: independent
parent: k-2c0d10318898
priority: P1
dependsOn:
  - k-6f0616f3779d
order: 20
createdAt: 2026-11-07T11:44:08.571Z
title: resume 真启动、Rex 自动回退与下一步出口
---

# resume 真启动、Rex 自动回退与下一步出口

## 目标与边界

### 背景与问题

审计复现：
- **resume 只登记不启动：** `run resume <id>` 返回 `resumed: true` 和新 runId，但新 run 的 launch 一直停在 `planned`、`attempts: 0`，worker 没起来。桥接 `knit_run action=resume` 只调这一条命令，主 Agent 会以为已经恢复（`run-coordinator.ts:752-778` 只调 `prepare`）。
- **Rex 失败不回退：** 在 Rex 终端里 `execution.host=auto` 选中 Rex，36 秒后报 `rex_worker_not_started`，没有回退到 local。
- **stale 没有出口：** 任务停在 deliver、输入已变化时，`status`／`context` 给出 `blockers: []`，`ready` 报 `phase_mismatch`，用户不知道下一步。

### 交付范围

1. `resume`：
   - CLI `resume`／`run resume` 在 prepare 之后执行与 `run implement` 相同的 start 流程，返回 launch 已确认的状态；新增 `--no-start` 保留只准备的行为。
   - 桥接 `knit_run action=resume` 同步，支持 `wait`。
2. Rex：
   - 自动选中 Rex 后，若 worker 在启动超时内从未报到，且本 run 未产生任何阶段副作用（无 claim 之后的事件），自动以 local 重启同一 run，记录 `presentationFallbackReason: rex_worker_not_started`；
   - 显式 `--rex` 不回退；
   - 补根因诊断：Rex 侧 stderr、块状态写进 run 诊断。
3. 下一步提示：`status <task>` 与 `knit_context` 给出确定性的 `nextAction`，覆盖：
   - 输入已变 → `update --kind clarify/change`；
   - run 待接收 → `run accept`；
   - needs_attention → 原因与可用命令；
   - 锁残留 → `unlock`；
   - 无绑定 → 参见跨机任务。
   桥接每轮上下文同步显示。
4. `--runs-settled`：去掉必须手传的要求，由核心直接核对；保留该参数作为兼容（无操作）。
5. 同步 OPERATIONS 恢复章节与桥接 README。

### 非目标

- 不改恢复的会话选择策略（prefer／new）。
- 不修 Rex 自身的 bug。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- Rex 回退只在"worker 从未报到"时自动进行，已报到后的失败不回退

## 完成条件

- 自动化测试：worker 被杀 → `resume` 后新 run 真实执行并接收（结合锁任务的自动回收）；auto 模式模拟 Rex 未报到 → 回退 local 并完成；显式 `--rex` 不回退。
- `status` 对审计中的 stale／deliver 场景给出非空 `nextAction`。
- `task close --outcome completed` 不带 `--runs-settled` 也能在已收敛时成功。

## 输入引用

- 审计 S2、S7、中等问题 9；S3 的出口提示。
- `src/application/run-coordinator.ts:690-780`、`src/cli/resume.ts`、`src/cli/run.ts:488-505`、`src/application/rex-launcher.ts:640-680`、`src/application/host-selection.ts`、`.pi/extensions/knit.ts:962-964`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
