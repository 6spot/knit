---
id: k-48371746f589
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
createdAt: 2026-11-02T12:59:07.904Z
title: changed_paths_mismatch 失败应记录实际 diff 路径清单
---

需求冻结（讨论结论，来源：任务 k-4bd444339302 实施排障证据 + 用户方向确认）：

1. changed_paths_mismatch 失败时，failureReason 直接携带实际 diff 的路径清单，风格与 protected_path_modified / *_side_effects 一致（如 changed_paths_mismatch:src/application/stage.ts,test/stage.test.mjs）；只含路径，不含内容。
2. 实际 diff 为空（树基线已含改动、重派零 diff）时，reason 标注 zero-diff 形态（如 changed_paths_mismatch:zero_diff），提示先还原基线再重派；mismatch 拒绝行为本身不变。
3. 失败 result 的 actualChangedPaths 如实记录实际 diff 路径（不再固定空数组），与 failureReason 一致；不新增状态机字段、不改协议结构。
4. run-acceptance 接收侧的 mismatch 判断行为不变。
5. 验收：在隔离夹具构造「报告路径≠实际路径」与「零 diff 重派」两类场景，失败原因可直接读出实际路径清单或 zero-diff 标注；npm test 全绿。

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

实施（run-bacb459a9710，已接收 implementation_accepted）：stage-runner 失败路径带上实际 diff 路径清单与 zero_diff 标注；failure() 增加 actualChangedPaths 参数，失败 result 如实记录。check（run-e345b580d19f）结论 pass。验证：npm test 276/276 绿（心跳丢失用例为既有负载敏感用例，单跑 4/4 通过，与本次改动无关）；隔离夹具覆盖「报告≠实际」与「零 diff 重派」两类场景，failureReason 分别为 changed_paths_mismatch:alpha.txt,notes.txt 与 changed_paths_mismatch:zero_diff。

### 交付记录

<!-- knit:delivery:op-91ed9632f691 -->
- 操作: op-91ed9632f691
- 时间: 2026-11-03T16:00:16.160Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: e2a20df504ebeb80d7005526ed3c25179938a906
- 结果: 正常交付；检查 run-e345b580d19f 通过
- 归档目标: .knit/tasks/archive/2026-11/11-02-mismatch-diagnostics

### 任务资料提交记录

<!-- knit:metadata-commit:op-91ed9632f691 -->
- 任务资料提交: 4a5b58637e05a59e51f1c0dd4a3887a8a9e9c6f8
- 归档目标: .knit/tasks/archive/2026-11/11-02-mismatch-diagnostics

<!-- knit:progress:end -->
