---
id: k-f7272189af25
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-06T00:44:28.362Z
title: 修 stage 启动诊断的 stderr 竞态：先收敛子进程再读尾部
---

# 修 stage 启动诊断的 stderr 竞态：先收敛子进程再读尾部

## 现象与复现

`test/stage.test.mjs` 的「runtime 启动失败保留 pi 侧错误细节；run 目录与 status 可读」间歇失败：`diagnostics.stderrTail` 为空字符串，断言 `/Model not found: magpie\/glm-5\.3-flash/` 不匹配。主会话 2026-11-06 单测循环 25 次复现 3 次失败（3/25），只在全量或并发负载下出现。

## 根因（假设，实施时先核实）

fake pi 在 `set_model` 失败时先写 stderr 再回响应；响应经 stdout 解析后立刻进入失败路径，`StageRunner` 在子进程仍存活、stderr 管道数据尚未被 Node 读到时调用 `writeStartDiagnostics`，于是尾部为空。`PiAgentRuntime.dispose()` 先把 `this.connection = null` 再等退出，因此“先 dispose 再读”同样读不到。仅靠调换两行顺序不能消除竞态。

## 完成条件

- 读取启动诊断前，子进程 stderr 已收敛：连接层能感知 stderr 流结束（`end`／`close`），提供有界等待（超时返回，不无限阻塞）。
- `PiAgentRuntime.dispose()` 在连接释放前保存最终 stderr 快照；释放后 `stderrDiagnostics` 返回快照而不是空值；`dispose` 仍保证幂等与既有超时梯度。
- `StageRunner` 写启动诊断时拿到的是最终尾部；`failureReason`、`result.json`、session 标记等权威路径与顺序不变，诊断仍只作辅助证据。
- 失败语义不变：`runtime_start_failed:set_model_rejected`、`detail`、`truncated` 含义与 schema 不改；不得通过放宽断言、给 fake pi 加延迟或重试整段逻辑来“避开”竞态。
- 回归测试：单独循环该用例 ≥25 次零失败（`env -u REX_SESSION -u REX_BLOCK node --test --test-name-pattern ... test/stage.test.mjs`）；必要时补充连接层／runtime 层的确定性用例（dispose 后仍能读到尾部）。
- 全量 `npm test` 连续 3 次 514/514（或届时总数）全绿；`npm run typecheck` 通过。
- 边界：不改 run 状态机、接收规则、诊断 schema 与展示；不改 `.knit/` 下文件。

## 输入引用

- 代码：`src/adapters/pi/connection.ts`（`stderrTail`、`waitExit`、`handleEof`）、`src/adapters/pi/runtime.ts`（`stderrDiagnostics`、`dispose`、`failStart`）、`src/application/stage-runner.ts:400-410` 与 `:533`（`writeStartDiagnostics`）。
- 夹具：`test/fixtures/fake-pi.mjs`（`KNIT_FAKE_START_FAILURE=set_model`）。
- 测试：`test/stage.test.mjs:1438-1495`。
- 背景：`docs/design/DESIGN.md` §5.6（启动诊断只作辅助证据）、`docs/design/OPERATIONS.md` 中启动失败与诊断的描述。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 实施结果（run-7a829726f01c，20 分钟）

- `src/adapters/pi/connection.ts`：监听 stderr `end`／`close`／`error`，记录 `stderrSettled`；新增有界 `waitStderrClose(timeoutMs)`（超时返回 false）与 `snapshotStderr()` 冻结快照；`stderrDiagnostics` 收敛后返回快照，`diagnostics` 文本沿用截断标记。
- `src/adapters/pi/runtime.ts`：`dispose()` 在等待进程退出后再等 stderr 收敛（上限 1s），在 `finally` 冻结连接快照；连接释放后 `stderrDiagnostics` 回退到该快照，不再返回空值；重复 `dispose` 幂等。
- `src/application/stage-runner.ts`：启动失败分支改为先 `dispose` 收敛子进程、再 `writeStartDiagnostics`；`failureReason`、`result.json`、session 标记与既有顺序不变。
- `test/pi-runtime.test.mjs`：新增两个确定性用例——连接层有界等待与冻结、runtime 启动失败后 dispose 仍保留 stderr 尾部（独立假 pi 固定“响应早于 stderr 读取”的顺序）。

### 验证（主会话复核 2026-11-06）

- 复现基线：修前单测循环 25 次失败 3 次（`stderrTail` 空串，`test/stage.test.mjs:1458`）。
- 修后：同一用例循环 40 次 0 失败（`env -u REX_SESSION -u REX_BLOCK`）。
- `npm test` 连续 3 次：516/516 全绿（较修前 +2 个新用例）；构建与 typecheck 随 `npm test` 通过。
- 未修改 `test/stage.test.mjs`，断言未放宽；未改 fake pi 行为。

### 已知边界

- 诊断仍是辅助证据，不参与状态机；stderr 收敛等待上限 1s，超时保留当时尾部（不阻塞收尾）。
- 真实模型／真机验收由用户执行，不在本任务范围。

### 交付记录

<!-- knit:delivery:op-d2dc6bfab98c -->
- 操作: op-d2dc6bfab98c
- 时间: 2026-11-06T01:24:13.582Z
- 分支: refs/heads/main
- 授权来源: user 2026-11-05 本会话明确授权：整条链逐任务本地提交（选项 A），不含 push／发布／归档；2026-11-06 追加授权处理 stderr 竞态
- 工作提交: 2e3d76ae5863aacf0d87273b26b8efda0b15dfe8
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-startup-stderr-race

<!-- knit:progress:end -->
