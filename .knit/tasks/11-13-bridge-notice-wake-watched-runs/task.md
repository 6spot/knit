---
id: k-b9ea41e9eec0
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: null
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-13T13:46:10.621Z
title: 桥接通知：本会话跟踪的 run 完成后唤醒主会话
---

## 目标与边界

本会话派发并跟踪的 run 正常完成后，主会话必须被唤醒并接手下一步；当前实现把这类通知当成只展示的被动通知，主会话停住，直到用户追问。

用户于 2026-11-13 指出问题（run-df1727de11fb，任务 k-185ace3b9556 实现阶段完成后主会话未继续），并选定方案 A：由桥接按“本会话是否跟踪过该 run”决定是否唤醒，不改核心接口。用户同日确认范围并授权实施：代码由主会话直接编写，完成验证为 independent，独立检查使用 DeepSeek 模型。授权不含 Git 提交、推送与真实 Pi 验收。

### 现状与根因

- `.pi/extensions/knit.ts:715`：`needsAction = failed || cancelled || (completed && acceptance !== completed)`，只有它为真才 `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`；否则只 `pi.appendEntry` 展示。
- `src/worker/knit-worker.ts:426`：worker 发布结果后立即自行接收。run-df1727de11fb 的结果记于 13:28:49.207，接收完成于 13:28:49.681。正常成功的 run 被桥接扫描到时几乎总是“完成且已接收”，因此落入被动分支。
- “已接收”只表示结果已记入任务，不表示没有后续：该任务随后停在 check 阶段，`knit status k-185ace3b9556` 的 nextAction 为“当前阶段 check：派发本阶段 run”。
- 通知文案对已接收的完成 run 仍写“下一步：knit status --run … 查看，或 resume”，不是任务真正的下一步。
- `docs/design/DESIGN.md` §9.3 把被动通知限定为“首次观察时已完成且已接收的 run”；代码没有区分“本会话看着它跑完”与“首次看到就已收尾”，两者都当被动。`docs/design/ARCHITECTURE.md:87` 写终态可唤醒主 Agent 由它决定下一步。

### 目标规则

1. 桥接在内存中维护本会话的“跟踪中 run”集合。以下任一情况加入集合：
   - 本桥接实例经 `knit_run` 的阶段动作派发成功（取得 runId 后）；
   - 本桥接实例经 `knit_run action=resume` 生成新 run；
   - 某次扫描观察到本会话发起的 run 尚未到终态。
2. 唤醒条件改为：`needsAction（现有三种情况，不变） || 该 run 在跟踪集合中`。唤醒方式不变：`pi.sendMessage({ customType: "knit.notice", … }, { deliverAs: "followUp", triggerTurn: true })`，另写不带 `text` 的去重条目。
3. 不在跟踪集合中的“完成且已接收”run 保持被动：只追加带展示文案的 `knit.notice` 条目，不进上下文、不触发轮次。
4. 例外（用户 2026-11-13 确认：有需要才唤醒）：`knit_run` 带 `wait: true` 且工具结果已返回该 run 的终态时，结果已在当前轮上下文中，该 run 移出跟踪集合，其“完成且已接收”通知按被动处理；失败、取消、结果待接收仍按 needsAction 唤醒。等待超时或中止不算已返回终态。
5. 跟踪集合只存内存：通知投递后移除对应 run；原生会话切换时清空；不新增持久字段、条目类型或配置项。reload／重启后集合丢失，仍在运行的 run 由下一次扫描重新加入。
6. 文案：完成且已接收的通知（唤醒与被动两种）写明结果已接收，并给出核心推导的任务级下一步（`knit status <taskId>` 的 `nextAction.summary`），保留完整 run ID 供查看报告，不再建议 resume。取不到任务级下一步时退回“knit status --run <runId> 查看”。失败、取消、结果待接收的文案不变。
7. 去重、会话与分支过滤、`--since` 过滤、轮询节奏与退避、边界注记、entry renderer 均不变。

### 范围

- `.pi/extensions/knit.ts` 与 `assets/templates/pi/extensions/knit.ts`：两份保持逐字一致。
- `docs/design/DESIGN.md` §9.3：通知分流规则改为上述规则；核对 `docs/design/ARCHITECTURE.md:87` 与 `docs/design/OPERATIONS.md` 的相关描述，不一致处同步。
- `test/bridge-query.test.mjs`、`test/host-selection.test.mjs`：终态通知与分流规则用例。

### 非目标

- 不改核心：`run list` 输出与 `--since` 过滤、worker 自动接收、run／任务状态机、`nextAction` 推导。
- 不让桥接代替主会话派发下一阶段；唤醒后做什么仍由主会话决定。
- 不恢复按 busy／idle 无差别唤醒，不使用 `nextTurn`。
- 不处理 reload／重启期间已完成 run 的补通知。

### 延期验收

- 真实 Pi `/reload` 后观察：跟踪中的 run 完成会唤醒主会话；首次看到就已收尾的 run 只展示。按 AGENTS.md 真机／真实模型验收延期，不在本任务宣称完成。

## 完成条件

### Requirement: 跟踪中的 run 完成后唤醒主会话

#### Scenario: 扫描期间看到运行中、随后完成且已接收
- GIVEN 本会话发起的 run 在某次扫描中尚未到终态
- WHEN 后续扫描看到它 `completed` 且结果已接收
- THEN 以 `{ deliverAs: "followUp", triggerTurn: true }` 调用 `pi.sendMessage`，通知进入上下文并唤醒
- AND 另写一条不带 `text` 的 `knit.notice` 去重条目，不出现第二张卡片

#### Scenario: 派发后未被扫描到运行中就已完成
- GIVEN 本桥接实例经 `knit_run` 阶段动作或 resume 派发了 run，且没有任何扫描看到它处于运行中
- WHEN 首次扫描就看到它 `completed` 且结果已接收
- THEN 仍唤醒主会话

#### Scenario: 重复扫描不重复唤醒
- GIVEN 某 run 的完成通知已投递
- WHEN 后续扫描再次看到同一终态
- THEN 不再调用 `pi.sendMessage`，不再追加条目

### Requirement: 未跟踪的已收尾 run 保持被动

#### Scenario: 首次看到就已完成且已接收
- GIVEN 本会话发起的 run 不在跟踪集合中
- WHEN 扫描首次看到它时已 `completed` 且结果已接收
- THEN 不调用 `pi.sendMessage`，只追加带展示文案的 `knit.notice` 条目

#### Scenario: wait 已返回终态
- GIVEN `knit_run` 带 `wait: true`，工具结果已返回该 run 的 `completed` 终态且结果已接收
- WHEN 扫描看到该终态
- THEN 不调用 `pi.sendMessage`，只追加带展示文案的 `knit.notice` 条目

#### Scenario: wait 超时或中止后完成
- GIVEN `knit_run` 带 `wait: true`，等待超时或中止，工具结果未返回终态
- WHEN run 随后 `completed` 且结果已接收
- THEN 唤醒主会话

### Requirement: 需处理通知保持现状

#### Scenario: 失败、取消或结果待接收
- WHEN 扫描到 run `failed`／`cancelled`，或 `completed` 且结果未接收
- THEN 无论是否在跟踪集合、是否经 wait 返回，仍以 `followUp` + `triggerTurn: true` 唤醒
- AND 文案与现状一致

### Requirement: 完成通知给出任务级下一步

#### Scenario: 能取到任务级下一步
- GIVEN run `completed` 且结果已接收，核心返回该任务的 `nextAction`
- WHEN 生成通知文案
- THEN 文案写明结果已接收，包含 `nextAction.summary` 与完整 run ID
- AND 不包含“或 resume”

#### Scenario: 取不到任务级下一步
- GIVEN 查询任务状态失败或无 `nextAction`
- WHEN 生成通知文案
- THEN 退回“knit status --run <完整 runId> 查看”，通知照常投递或展示

### Requirement: 实现与规范一致

#### Scenario: 双份桥接与文档
- WHEN 核对 `.pi/extensions/knit.ts`、`assets/templates/pi/extensions/knit.ts`、`DESIGN.md` §9.3、`ARCHITECTURE.md` 的通知描述
- THEN 两份桥接逐字一致
- AND 文档写明“跟踪中的 run 完成即唤醒；首次观察时已收尾的才被动；wait 已返回终态的不重复唤醒”，与代码、测试一致

#### Scenario: 回归
- WHEN 运行 `npm run -s typecheck`、`npm run -s build`、`node --test test/bridge-query.test.mjs test/host-selection.test.mjs` 与 `npm test`（Rex 终端与普通终端各一次）
- THEN 全部通过

## 验证安排

- verification 为 `independent`：通知是否进入上下文、是否唤醒属于宿主协议行为，自证不足。
- 实施者：主会话直接编写（用户指定），收尾前用 `knit task implement` 记录改动路径与实际验证。
- 独立检查：派 Knit 检查 run，模型用 DeepSeek（`magpie` / `group/deepseek`，用户指定）；检查者在独立上下文核对两份桥接、文档与回归测试，不由主会话自检代替。

## 输入引用

- 用户观察（2026-11-13）：run-df1727de11fb 完成后收到的 `[knit.notice]` 未唤醒主会话；“明明是需要出会话响应的”。
- 用户决定（2026-11-13）：建任务，采用方案 A；`wait` 已返回终态的 run 不唤醒；验证用 independent；代码由主会话编写；检查子 Agent 用 DeepSeek。
- 历史决定：`k-0ca555299a57`（`.knit/tasks/archive/2026-11/11-06-bridge-notice-wake-only-actionable/task.md`）定“完成且已接收不唤醒”；`k-e8730699375d`（`.knit/tasks/archive/2026-11/11-12-bridge-notice-display-only/task.md`，提交 9707e98）定“被动通知只展示、不进上下文”。本任务收窄“被动”的适用范围，不改变被动通知的展示方式。
- 代码：`.pi/extensions/knit.ts` 的 `scanRuns`（:685–748）、`startObserver`（:788）、`waitForRun`／`mergeWaitStatus`（:1583–1616）、`knit_run` 工具的 resume 与阶段派发（:1644–1724）、`nextActionLines`（:561）；会话切换重置（:589–594）。
- 核心（只读参考）：`src/worker/knit-worker.ts:426`、`src/cli/run.ts:608`（`activeRunOf`）、`src/application/status-service.ts`（`taskNextAction`）。
- 规范：`docs/design/DESIGN.md` §9.3（:658）、`docs/design/ARCHITECTURE.md:87`、`docs/design/OPERATIONS.md`。
- 测试：`test/bridge-query.test.mjs:466–563`、`test/host-selection.test.mjs:436–469`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-13T13:55:01.422Z
- 方式: self → independent；理由: 用户确认采用建议：通知是否进上下文与唤醒属宿主协议行为，自证不足

## 当前位置

主会话实施与自检已完成并用 `task implement` 记录；正式独立检查派不出去，任务停在 implement，待用户决定检查路径。

## 关键经过

- 2026-11-13 主会话实施：两份桥接加内存跟踪集合（`watchedRuns`）与等待登记（`waitingRuns`），唤醒条件改为 `needsAction || 在跟踪集合`；wait 已返回终态移出集合，扫描遇到仍在等待的 run 先等 wait 结束再分流；完成且已接收的通知写明结果已接收并给任务级下一步。DESIGN §9.3、ARCHITECTURE 同步；OPERATIONS 只引用 §9.3，未改。
- 验证：typecheck、build 通过；`node --test test/bridge-query.test.mjs test/host-selection.test.mjs` 36/36；`npm test` 在 Rex 终端与去掉 REX_*／TERM_PROGRAM 的环境各 745/745。第一次全量为 744/745：`test/stage.test.mjs`「心跳丢失后 worker 停止新动作」在 finally 清理临时目录时报 ENOTEMPTY，该文件不加载桥接，单独重跑 3 次与之后两次全量均通过，未修改该用例。
- 阻塞（正式独立检查）：`knit_run action=check` 与 `knit run check --task` 均返回 `invalid_request`／“任务阶段为 implement，不能准备 check”。原因：`task implement` 只写实施记录，不推进阶段（`src/application/task-service.ts:2485`）；阶段只在接收 run 时推进（`src/application/run-acceptance.ts:405`）；`run check --task` 在工作阶段按 STATES.md:47 明确拒绝，不自动跳过实施；`task rebind` 在已有绑定时不改阶段。主会话实施的 independent 任务目前没有进入检查阶段的公开入口。
- 未采取的绕过方式：手改 task.md 的 stage、删除本机绑定触发 rebind、派一个不做事的 implement run。三者都越过上面的守卫，未经用户同意不做。
- 另一点（按代码阅读，未实测）：本任务 scope 为 0 条，检查的 coverage 核对按 scope 计算（`src/application/stage-runner.ts:1463`），即使进入检查阶段，检查凭据也不绑定实施记录里的 6 个路径。

## 结果与验证

未完成：independent 要求的正式检查尚未执行。未验证项：真实 Pi `/reload` 观察（延期）；wait 超时后完成的唤醒没有单独的超时用例；resume 新 run 加入跟踪集合只有源码断言。

## 当前位置

主会话实施与自检已完成并用 `task implement` 记录（最终代码，路径 6）。DeepSeek 非正式独立核对结论 pass。正式独立检查派不出去，任务停在 implement，不能按 independent 关闭，待用户决定。

## 关键经过

- 2026-11-13 主会话实施：两份桥接加内存跟踪集合（`watchedRuns`）与等待登记（`waitingRuns`），唤醒条件改为 `needsAction || 在跟踪集合`；wait 已返回终态移出集合，扫描遇到仍在等待的已接收完成 run 先等 wait 结束再分流；完成且已接收的通知写明结果已接收并给任务级下一步。DESIGN §9.3、ARCHITECTURE 同步；OPERATIONS 只引用 §9.3，未改。
- 阻塞（正式独立检查）：`knit_run action=check` 与 `knit run check --task` 均返回“任务阶段为 implement，不能准备 check”。原因：`task implement` 只写实施记录，不推进阶段（`src/application/task-service.ts:2485`）；阶段只在接收 run 时推进（`src/application/run-acceptance.ts:405`）；`run check --task` 在工作阶段按 STATES.md:47 明确拒绝；`task rebind` 在已有绑定时不改阶段。主会话实施的 independent 任务目前没有进入检查阶段的公开入口。
- 未采取的绕过方式：手改 task.md 的 stage、删除本机绑定触发 rebind、派一个不做事的 implement run。三者都越过上面的守卫，未经用户同意不做。
- 另一点（按代码阅读，未实测）：本任务 scope 为 0 条，检查的 coverage 核对按 scope 计算（`src/application/stage-runner.ts:1463`），即使进入检查阶段，检查凭据也不绑定实施记录里的 6 个路径。
- 用户选择先做非正式独立核对。2026-11-13 用 `.pi/agents/deepseek-reviewer.md`（magpie/group/deepseek，只读）核对：结论 pass，11 个场景均判满足，未发现违反非目标。它未运行测试，R5.S2 依据主会话日志。
- 据核对意见做的修改：`test/bridge-query.test.mjs` wait 中止用例把“run 留在跟踪集合”的断言提前到 run 仍在运行时（原位置在 run 完成之后，观察器节拍若先扫描会清空集合导致偶发失败），并补“投递后移出集合”的断言；DESIGN §9.3 写明“需处理的通知不等待 wait”。
- 核对提出但未处理的问题：
  - 扫描在 `await waiting`／`branchNow`／`taskNextSummary` 之后投递前不再核对原生会话；DESIGN §9.3 要求投递前再次核对。改动前已如此，本次新增的 await 拉长了窗口。按 Pi 扩展文档，会话切换后旧实例的 `pi` 调用会抛错并被现有 try/catch 接住，未实测。
  - 同一 run 并发两个 `knit_run wait` 时，先结束者会删掉后者的等待登记，可能重复通知；模型侧基本不会这样调用。
  - `waitTracked` 在工具结果构造完成前就把 run 移出集合；之后若工具被宿主中止，终态可能没进当前轮而通知只展示。
  - 被分支过滤跳过的 run 留在集合里不删除，只占内存。

## 结果与验证

- 最终代码下：受影响测试 36/36；`npm test` 在 Rex 终端 745/745、在 Terminal.app 窗口 745/745，均 exit 0。两份桥接 `cmp` 一致，`git diff --check` 无输出，`src/` 无改动。
- 更早一次全量 744/745：`test/stage.test.mjs`「心跳丢失后 worker 停止新动作」清理临时目录 ENOTEMPTY，该文件不加载桥接，之后未再出现，未修改该用例。
- 未完成／未验证：正式独立检查；真实 Pi `/reload` 观察（延期）；wait 超时后完成的唤醒无单独用例；resume 加入集合与会话切换清空只有源码断言。

### 交付记录

<!-- knit:delivery:op-31f86a7a2a00 -->
- 操作: op-31f86a7a2a00
- 时间: 2026-11-13T20:30:17.164Z
- 分支: refs/heads/main
- 授权来源: user:9698c2d8
- 调用: bridge
- 工作提交: 无
- 结果: 正常交付；检查 run-70d0e7f904db 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-13-bridge-notice-wake-watched-runs

<!-- knit:progress:end -->
