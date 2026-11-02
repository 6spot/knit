---
id: k-0a8e97ea1b89
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
createdAt: 2026-11-02T08:48:51.433Z
title: 状态机文档与实现对齐
---

# 状态机文档与实现对齐

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

架构审查确认的状态机文档-实现偏差：

1.【中】finalizing/cancelling 为死状态：STATES.md:79-85 与 src/contracts/run.ts:17-18 声明，但 src/worker/knit-worker.ts:245/257/312/327、src/application/run-coordinator.ts:462-470、src/application/run-acceptance.ts:535-541 从未把 state.json 写成这两个值。
2.【中】failed → completed（acceptance_ 前缀）转移实际存在（run-acceptance.ts:535-541），STATES.md 状态图未声明。
3.【中】检查凭据位置与写入方口径：DESIGN §2 目录树、§5.3、§5.6 表与 GLOSSARY.md:31、ARCHITECTURE.md:101 写 run 目录内 check.json／scope.json、由 CheckService 写入；实际 run-store.ts:266 写 .runtime/checks/<runId>.json、run-store.ts:245 写 .runtime/tasks/<taskId>/scope.json，写入方为 run-acceptance.ts:449/452（接收阶段）。应以 STATES/OPERATIONS/代码为准修 DESIGN/GLOSSARY/ARCHITECTURE。
4.【中】cancel 产物名：DESIGN §5.6 写 cancel.request；实际 run-store.ts:223/228/382 为 cancel.json。

验收标准：
- STATES.md 与代码转移一一对应：删除或落地 finalizing/cancelling；声明 failed→completed。
- DESIGN/GLOSSARY/ARCHITECTURE 中检查凭据位置、写入方、cancel 文件名与实现一致。
- 搜索旧名（cancel.request、CheckService 写 check.json 等）确认每处命中归属。

### 交付记录

<!-- knit:delivery:op-d46b136626ec -->
- 操作: op-d46b136626ec
- 时间: 2026-11-02T10:45:32.619Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-02-授权逐任务顺序交付
- 工作提交: ce9d16297d2005e10e546d2611517e055a41563e
- 结果: 正常交付；检查 run-63be33c66664 通过
- 归档目标: .knit/tasks/archive/2026-11/11-02-states-doc-alignment

<!-- knit:progress:end -->
