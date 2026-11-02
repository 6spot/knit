# 030 持久化应用草案后的业务状态转移

- 里程碑：审计修复（P1）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../validation/design-implementation-audit/README.md)，发现 F030。
- 受影响原任务：006、009、018。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §3.6；STATES §3 输入应用后的 phase／status 转移 为验收依据；按需阅读对应章节。

## 已核实偏差

applyPending 计算了 transition，却渲染仅合并正文的 merged，未把 transition 写回 frontmatter；同时清空草案并返回新阶段。动态观察响应为 discuss、磁盘仍为 implement、草案已清空。

- 代码位置（审计基线）：src/application/task-service.ts:814–815；src/domain/task.ts:onPendingResolved。
- 证据等级：动态复现 + 源码核实。
- 实际证据：probes.json：pending-phase-persistence.responsePhase=discuss、diskPhase=implement、pendingCleared=true。
- 最小场景：ready 到 implement 后模拟保存 change 草案，应用后重新解析 task.md，而不是只断言返回对象。
- 证据文件：[审计记录目录](../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 把允许的 transition 与正文一起按版本核实写入权威任务文件。
- 核对正文发布、绑定摘要、草案清除的断点重试，响应与磁盘一致后才视为应用完成。
- 同步 clarify／change 对 check、deliver、completed 的规定行为；与036协作。

## 完成前必须验证

- change 实际回 open/discuss；deliver 上摘要变化的 clarify 实际回 open/check。
- 重读磁盘、重开仓储与重试后阶段、检查资格和草案状态一致。
- 优先复用 test/task.test.mjs、test/stage.test.mjs；文件名按实际测试树定位，新增测试仅覆盖有业务后果的不变量。
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
  - `src/application/task-service.ts`：`applyPending` 把 `onPendingResolved` 允许的转移（status/phase/outcome）与合并后的输入正文一起渲染并原子写回 task.md（此前只写正文，frontmatter 转移丢失）；响应仅在写盘后返回，与磁盘一致；确认摘要、草案清除与断点重试语义不变。
  - 测试：`test/task.test.mjs` 新增“应用草案持久化转移”：implement 后 change 实际回 open/discuss；deliver 上摘要变化的 clarify 实际回 open/check；均重读磁盘断言 frontmatter、outcome、草案清除与响应一致。
  - 验证：`npm run typecheck`、`npm run build`、`node --test test/*.test.mjs` 215 项全部通过（Linux + Node v24.21.0）；审计探针 `pending-phase-persistence` 由 `responsePhase=discuss, diskPhase=implement` 变为 `responsePhase=discuss, diskPhase=discuss, pendingCleared=true`。
  - 设计同步：DESIGN §3.6 / STATES §3（PendingApplied 按 kind 应用 InputsUpdated 转移）现与实现一致；与 036 的衔接点（completed 上的输入更新）由 036 单独处理。
- 后续执行者须补充实际修改、验证、未解决事项和交接，不以任务创建视为修复完成。
