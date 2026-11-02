# 028 在运行边界核对实际 Git 分支

- 里程碑：审计修复（P1）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../validation/design-implementation-audit/README.md)，发现 F028。
- 受影响原任务：012、013、018、021。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。
- 044排程核对：本任务已有下方实施验证记录，并经043的F028复验通过；2026-11-02 创建044时将根表残留的 `in_progress` 更正为 `completed`，没有新增实现或重写历史验收。

## 先读

先遵守 [AGENTS.md](../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §3.5、§14.1；STATES 的分支接管与运行身份约束 为验收依据；按需阅读对应章节。

## 已核实偏差

request.expected.branch 来源于任务文件；worker 与接收只比较两份已记录值，未与实际检出分支比较。绑定 main 的任务在 unrelated 分支仍能启动并完成阶段。

- 代码位置（审计基线）：src/application/run-coordinator.ts:204、src/worker/knit-worker.ts:199、src/application/run-acceptance.ts:187。
- 证据等级：动态复现 + 源码核实。
- 实际证据：stage-probes.log：task-run-branch.started=true、taskBranch=main、head=unrelated。
- 最小场景：临时仓库创建绑定 main 的 ready 任务，切到 unrelated，保留任务文件，再用 fake Pi prepare/start。
- 证据文件：[审计记录目录](../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 在准备、执行副作用前、结果接收处核对实际本地完整分支 ref、绑定与 request，处理 detached HEAD。
- 明确区分显示短名与持久完整 ref；分支不匹配要求按既有 adopt 流程接管。
- 运行中外部换分支时停止后续副作用并保留可核实证据。

## 完成前必须验证

- 准备前换分支、prepare 后启动前换分支、结果待接收时换分支均被拒绝。
- 同分支正常路径及明确 adopt 后新运行通过；不会把任务绑定悄悄改为当前分支。
- 优先复用 test/stage.test.mjs、test/run.test.mjs、test/session.test.mjs，新增测试仅覆盖有业务后果的不变量。
- 运行受影响测试、类型检查及构建；记录命令、环境和结果。需要真实宿主的条目不可用替身冒充完成。
- 同步相关契约／规范中的实现与验证说明，不能通过删掉原要求宣称修复。

## 边界与交接

- Git／故障实验仅在隔离夹具执行；不提交、推送、发布或修改真实仓库历史。
- 保留其他执行者改动；现有产品任务 check-report-fence 不属于本项。
- 阻塞按 BLOCKERS.md 记录事实并继续独立工作；依赖按接口与产物判断，不把编号当硬依赖。
- 修复后交给 [043 独立复验](043-audit-independent-regression.md)；本任务文件不另存一份状态。

## 执行记录

- 2026-11-02：审计主执行者创建任务，记录上述偏差、证据与验收条件；尚未实施本项修复。
- 2026-11-02：开发 Agent 实施修复并验证完成。
  - `src/application/run-coordinator.ts`：prepare 在读取绑定后核对实际检出分支（`currentBranch`）；与任务绑定或绑定分支不一致抛 `branch_mismatch`，detached HEAD 同样拒绝；advisory 与未绑定任务不套此门。
  - `src/worker/knit-worker.ts`：认领后、执行前重核实际 HEAD（detached 时 `currentBranch` 为 null 自然不等于预期），不符 `fail("branch_mismatch")`。
  - `src/application/stage-runner.ts`：新增 `liveBranchMatches`（symbolic-ref -q，detached 返回 false）；启动 Pi 前不符转 `branch_mismatch_at_start` 失败；阶段结束、结果发布前重核，运行中外部换分支转 `branch_mismatch_after_run` 失败并保留模型文本／用量／原生条目证据。
  - `src/application/run-acceptance.ts`：接收前重核实际 HEAD，结果待接收期间换分支转 `branch_changed` attention；切回后接收恢复。
  - 测试：`test/stage.test.mjs` 新增“运行边界核对实际分支”端到端用例：prepare 前换分支拒绝且不改绑、detached 拒绝、prepare 后启动前换分支阶段失败、接收窗口换分支拒绝切回后可收、显式 adopt 接管后新运行按新分支准备。旧路径（同分支正常流、无绑定分支）由既有 213 项测试覆盖。
  - 验证：`npm run typecheck`、`npm run build`、`node --test test/*.test.mjs` 连续两轮 213 项全部通过（Linux + Node v24.21.0）；审计探针 `task-run-branch` 由 `started=true` 变为 `started=false, reason=branch_mismatch`。全量偶发：多进程并行负载下一次 implement 会话超时失败，单跑与连续两轮全量均通过，非本改动引入；交由 043 复验观察。
  - 设计同步：DESIGN §3.5/§14.1 与 STATES 分支接管约束现与实现一致；分支不匹配不静默改绑，按既有 task adopt 流程接管。
- 后续执行者须补充实际修改、验证、未解决事项和交接，不以任务创建视为修复完成。
