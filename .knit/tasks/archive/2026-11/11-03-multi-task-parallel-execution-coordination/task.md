---
id: k-2cbd2f312298
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:11.359Z
title: 多任务并行：按执行目录调度与冲突保护
---

# 任务 17 冻结输入：多任务并行——按执行目录调度与冲突保护

## 背景

任务 13–16 已交付 worktree 路由、移动修复、授权清理与授权合入。当前 worker 在阶段全程持主检出项目锁，任何两个 run 都串行。本任务只把阶段执行占用改为「按执行目录」：不同 worktree 的 run 可并行，同目录／同任务仍互斥；主检出路由保持原有串行行为。不建设第二套调度器，不新增持久化状态。

设计来源：DESIGN.md 第 7、15.2 节、STATES.md 占用／Run 规则、OPERATIONS.md 锁约定、WORKTREE.md 第 6.6 节。

## 并发范围（本次冻结）

- **允许**：不同任务、各自 `binding.worktree.active === true` 且执行目录（worktree 路径）不同的 run 同时运行。
- **保持串行**：主检出路由（无 worktree／worktree 未交接）的 run 仍以主检出根为执行占用键，同一主检出一次一个；这与当前行为等价。
- **拒绝**：同一执行目录的第二个 run（worker 获取执行目录锁失败，run 失败 `lock_busy`）；同一任务的第二个 run（prepare 复用活动 run／任务锁拦截）。
- 不新增并发上限配置、排队、依赖图、失败传播策略或后台调度器；不因「多个终端」自动视为并发许可。

## 锁语义

- `project` 锁键 = **执行目录**：主检出路由为 `mainRoot`；worktree 路由为 worktree 路径。owner 的 action 仍为 `run.prepare`（与现有诊断兼容）。
- worker 只增加执行目录 `project` 锁；不再持有主检出项目锁。prepare 仍按主检出＋任务短锁核实与冻结输入；同一任务的活动 run 由 prepare 复用。deliver／task 更新／cleanup 等既有操作的项目锁键不变（主检出），与 worktree run 的隔离由「执行目录锁 + prepare／接收的任务锁 + 活动／未知 run 检查」保证；运行中任务输入被更新时按既有接收核对报告，不静默覆盖。
- 锁内必须重新读取 binding 并重算执行路由；若路由或执行目录与获取锁前不同、worktree 失效、任务已归档，失败 `route_changed`（或既有 `worktree_invalid`／`task_archived`），不执行阶段。
- 未知／活动执行不得被新 run 绕过：同一执行目录锁被占用即失败；同一任务活动 run 由 prepare 复用，不创建并行 run。

## 代码范围

- `src/worker/knit-worker.ts`：
  - 获取锁前只读 binding 与 `executionRouteOf`，确定执行目录键；先取锁，再锁内重读 binding、重算路由并核对请求 `expected.executionDir`／branch。
  - 锁键：仅 `{ scope: "project", rawKey: executionDir }`，action 保持 `run.prepare`（阶段占用）；任务级互斥沿用 prepare／接收的 `task` 锁，不新增 worker 任务锁。
  - 仅在路由为 `main`／`worktree` 时进入；`invalid` 在取锁前失败。
  - 失败路径与 finally 释放执行目录锁，不改变现有 heartbeat／cancel／result 发布顺序。
- `src/application/status-service.ts` 或 `src/cli/status.ts`（只读诊断，可选最小改动）：项目锁展示同时报告主检出与已登记 worktree 执行目录的占用，不改变调度规则。
- 注释与文档：`OPERATIONS.md` 锁语义改为「project 锁按执行目录」，`WORKTREE.md` 补并行范围；不扩大首版 Worktree 范围。

## 完成条件（验收）

隔离夹具（真实 Git worktree、真实 worker 子进程、可用 stub `pi` 或 prepare-only 路径；不调用真实模型）：

1. 两个不同 worktree 的任务各 prepare 一个 run，worker 并行启动时两个执行目录 `project` 锁同时存在；主检出 `project` 锁不因 worktree run 被占用。
2. 同一 worktree 的第二个 worker 在锁被占用时失败 `lock_busy`，不进入阶段；锁释放后可按既有重试启动。
3. 同一任务的第二次派发复用活动 run（不新建并行 run）；prepare／接收的任务锁语义不变。
4. 主检出路由仍串行：主检出锁占用时 worker 失败 `lock_busy`；释放后重试成功（回归既有测试）。
5. 锁内绑定／执行目录被改动：worker 失败 `route_changed`，不执行阶段；现场与 run 状态可诊断。
6. 两个并行 run 的取消、失败、结果发布与接受互不影响；迟到结果仍按 runId／taskId 隔离；未知执行不被新 run 绕过。
7. `knit status`／`knit locks` 对执行目录锁可观察，文本与 JSON 不破坏既有字段；无 worktree 项目输出与现在等价。
8. `npm test` 全量（含 typecheck、build）通过，回归任务 13–16 测试与真实 Git 夹具。

## 边界与延期

- 不实现：并发上限、排队、依赖表达、失败传播策略、跨机调度、Rex 专用调度、自动清理、真实多机／真实模型验收。
- 不改变 run 请求／结果 schema、任务状态机、Session 恢复规则、交付与归档语义。
- 用户既有决定：真实模型与真实多机验收延期；隔离测试不冒充真实验收。业务完成、提交、归档、push 分别处理。

## 自检补充（clarify）：接收锁与执行目录一致

- `RunAcceptanceService.accept` 的项目锁键改为请求冻结的 `expected.executionDir`（缺省回退主检出 root）；外部 `run accept` 对 worktree run 也按执行目录取锁，不再与主检出 project 锁相互阻塞。
- worker 持有执行目录锁时直接 `lockHeld=true` 接收；未取得锁的失败路径以主检出 root 作为接收锁键，保留失败结果接收。不新增 worker 任务锁，不改变任务锁键（`${root}::${taskId}`）、接收幂等与未知处理。
- 新增夹具：主检出 project 锁被占用时 worktree run 仍可完成接收；两个 worktree 并行接收互不阻塞。

<!-- knit:progress:start -->
## 当前位置

交付阶段；任务 17 的实施 run 已接收，self 自检通过，待完成与交付。

## 关键经过

- 冻结输入：worker 按执行目录（主检出路由为主检出根，worktree 路由为 worktree 路径）取得 project 锁；锁前只读 binding／路由，锁内重读并核对，变化失败 `route_changed`；同目录／同任务仍互斥，不新增队列、上限或调度器。
- 自检发现 worktree run 的接收仍取主检出锁，会与主检出串行 run 长期冲突；补充 clarify 后改为接收按请求冻结的 `expected.executionDir` 取锁，worker 持锁直接复用，未取锁失败路径回退主检出键。首次补充实施因把前次成果计入 `changedPaths` 被接收拒绝，按基线重做全部范围后接收。
- 最终实施：`src/worker/knit-worker.ts` 执行目录锁与锁内路由复核；`src/application/run-acceptance.ts` 接收锁键按执行目录（保留 `lockDir` 失败回退）；`status` 按执行目录观察心跳并新增 `executionDir` 字段；OPERATIONS／WORKTREE 同步锁语义；新增并行夹具。
- self 自检：核对锁键与释放、锁内路由重核、失败接收回退、外部并行接收、status／locks 可观察；`npm test` 全量 408 项通过（含 typecheck、build）。

## 结果与验证

- `npm test`（含 typecheck、build）408 项通过。
- 新增 `test/worktree-parallel.test.mjs`：不同 worktree 并行且主检出锁不被占用、同目录 `lock_busy`、同任务复用、主检出锁占用下 worktree 仍接收、两个 worktree 外部并行接收、`route_changed`、并行取消／失败隔离、执行目录锁 status／locks 可观察；`test/worktree-routing.test.mjs` 锁键回归改为执行目录语义。
- 修改：`src/worker/knit-worker.ts`、`src/application/run-acceptance.ts`、`src/application/status-service.ts`、`src/cli/status.ts`、`docs/design/OPERATIONS.md`、`docs/research/WORKTREE.md`、`test/worktree-routing.test.mjs`；新增 `test/worktree-parallel.test.mjs`。
- 未执行：真实模型并行、真实多机 worktree 验收（按既有决定延期；隔离夹具不冒充）。

## 运行引用

- 实施 run：run-6f298ab42fa7（最终接收）；此前 run-b6f77537367a（首轮实施，后按基线重做）、run-f4efb6441a09（接收锁补充，因 changedPaths 不匹配未接收，仅作过程证据）。
- 会话：s-e10f1d5601dd / 5fadbf66-5d77-4bc9-add3-a99c1c06f564；本任务原无绑定行，派发前以 `knit task adopt` 补齐 refs/heads/main 绑定。

### 交付记录

<!-- knit:delivery:op-72b9b8f27599 -->
- 操作: op-72b9b8f27599
- 时间: 2026-11-04T10:48:29.566Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-04-message-commit-push-remaining
- 工作提交: 0092646eb8032755ebe9706c0f76316525cba248
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-multi-task-parallel-execution-coordination

### 任务资料提交记录

<!-- knit:metadata-commit:op-72b9b8f27599 -->
- 任务资料提交: 1704d5a223ad1d4561b34e31d877b2916b11b415
- 归档目标: .knit/tasks/archive/2026-11/11-03-multi-task-parallel-execution-coordination

<!-- knit:progress:end -->
