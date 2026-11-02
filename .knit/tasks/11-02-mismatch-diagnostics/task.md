---
id: k-48371746f589
status: open
phase: discuss
outcome: null
branch: refs/heads/main
createdAt: 2026-11-02T12:59:07.904Z
title: changed_paths_mismatch 失败应记录实际 diff 路径清单
---

# changed_paths_mismatch 失败应记录实际 diff 路径清单

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

证据（2026-11-02，任务 k-4bd444339302 的实施排障）：

run-a98bb2a0941e：worker 真实完成实施（git diff 与报告 changedPaths 均为 src/application/stage.ts + test/stage.test.mjs，npm test 210 绿），但 guard 判 changed_paths_mismatch。因 stage-runner.failure() 固定以 actualChangedPaths=[] 落盘（src/application/stage-runner.ts:570 附近），失败时无法看到实际 diff 清单，排障只能靠反复重派（重派又因树已含未验收改动而零 diff → 再次 mismatch，形成死循环）。

方向：
1. changed_paths_mismatch 失败时，在 failureReason 或诊断字段中带实际 diff 路径清单（受白名单规则约束，注意不含内容）。
2. 顺带定义「树中已存在未验收改动时重派」的预期行为（快照基线已含改动 → 零 diff → mismatch 是正确拒绝，但应在失败原因中说明 zero-diff 形态，提示先还原基线）。

验收标准：构造 mismatch 场景后，失败原因可直接读出实际路径清单；npm test 全绿。

<!-- knit:progress:end -->
