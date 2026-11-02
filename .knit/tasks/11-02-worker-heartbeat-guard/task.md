---
id: k-c28cf2b63362
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
createdAt: 2026-11-02T08:48:52.485Z
title: worker 心跳丢失后停止新动作
---

# worker 心跳丢失后停止新动作

## 目标与边界

<!-- 待讨论确认：目的、范围、约束与必要设计 -->

## 完成条件

<!-- 可验证结果与必需验收 -->

## 输入引用

<!-- 适用规范、设计材料、代码范围与验证入口 -->

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

架构审查确认的 worker 占用守卫缺口：

【中】心跳丢失后 worker 不停止阶段执行：src/worker/knit-worker.ts:176-186 心跳失败只置 heartbeatError 并继续整个 StageRunner（stage-runner 不感知心跳状态），直到阶段结束后才 return fail("lock_ownership_lost:...")（300-303 行）。OPERATIONS.md:65 明确要求「worker 在心跳、工具边界和写回前校验 token；丢失占用后停止新动作」。窗口内旧 worker 仍在写代码：若用户已 knit unlock --force 并启动新 run，出现两个并发执行者。

建议方向：把 heartbeatError（或 token 校验函数）注入 StageRunner，在工具边界／写回前检查；至少在检测到丢失后立即 abort runtime 并走 fail 路径。

验收标准：
- 丢失占用后 worker 不再执行任何新的工具调用或写回（隔离夹具可复现）。
- 新增测试：模拟心跳失败后，fake-pi 的下一次调用被拒绝且 run 以 lock_ownership_lost 终止。

<!-- knit:progress:end -->
