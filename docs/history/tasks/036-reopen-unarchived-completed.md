# 036 允许更新尚未完整归档的 completed 任务

- 里程碑：审计修复（P2）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../../../validation/design-implementation-audit/README.md)，发现 F036。
- 受影响原任务：006、009、014、018。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../../../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §3.6（约164行）；STATES §3：未完整归档且非 cancelled/superseded 的输入更新 为验收依据；按需阅读对应章节。

## 已核实偏差

closedGuard 对全部 completed 返回 outcome_completed，onInputsUpdated 与草案应用沿用该拒绝，没有规定的未归档 completed 入口。纯领域探针返回 allowed=false／outcome_completed。

- 代码位置（审计基线）：src/domain/task.ts:68–71、103；src/application/task-service.ts:736。
- 证据等级：领域动态复现 + 应用层源码核实。
- 实际证据：probes.json：completed-input-update-domain.decision.allowed=false、reason=outcome_completed；应用层归档条件由源码核实。
- 最小场景：对 closed/completed/deliver 调 onInputsUpdated(change,true)；修复时再构造未归档 completed 应用夹具与已归档对照。
- 证据文件：[审计记录目录](../../../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 区分已完成、完整归档与取消／取代，按规范允许未归档 completed 的输入变更。
- 正确清除完成结果、过期检查及收尾事实，change 回 discuss、clarify 按摘要和阶段处理。
- 与030保持草案返回和任务文件一致；禁止任意复活已归档或 cancelled/superseded 任务。

## 完成前必须验证

- 未归档 completed 可按规定重新打开；已完整归档、cancelled、superseded 仍拒绝。
- 直接更新与草案应用行为一致，完成结果与检查资格不会残留。
- 优先复用 test/task.test.mjs、test/delivery.test.mjs、test/domain.test.mjs，新增测试仅覆盖有业务后果的不变量。
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
  - `src/domain/task.ts`：新增 `inputsClosedGuard`／`inputsUpdateRefusal`——输入更新（onInputsUpdated／onPendingResolved）对未归档 completed 放宽为可重开；已完整归档与 cancelled/superseded 沿旧拒绝；应用草案路径不再被 pendingGuard 自拦（应用即解决路径）。其余事件（ready、实施、检查、交付、关闭）仍用 closedGuard，completed 一律拒绝。
  - `src/application/task-service.ts`：update 直接更新与 applyPending 把 `located.archived` 传入领域裁决；归档任务由任务定位层先行拦截（io_error/task_archived）。
  - 重开效果：change 回 open/discuss、deliver 上摘要变化的 clarify 回 open/check，status 复 open、outcome 清 null，与磁盘写入一致（030 修复的写回路径复用）。
  - 测试：`test/task.test.mjs` 新增四场景：未归档 completed 的 clarify/change 重开（磁盘断言）、已完整归档拒绝、cancelled 拒绝、superseded 拒绝。既有“待应用草案阻止代码阶段”等领域断言不变。
  - 验证：`npm run typecheck`、`npm run build`、`node --test test/*.test.mjs` 连续全量 222 项全过（Linux + Node v24.21.0；B002 偶发口径不变）；审计探针 `completed-input-update-domain` 更新为双向断言：未归档 change 回 open/discuss、归档拒绝 outcome_completed（原探针只断言旧行为且 TaskFacts 缺字段，随审计工具同步修正）。
  - 设计同步：DESIGN §3.6“输入变更迁移仅用于未归档且 outcome 不是 cancelled/superseded 的任务”现与实现一致；与 030 的草案返回／磁盘一致性继续成立。
- 后续执行者须补充实际修改、验证、未解决事项和交接，不以任务创建视为修复完成。
