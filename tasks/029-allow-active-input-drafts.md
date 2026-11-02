# 029 允许真实活动运行期间保存与撤回输入草案

- 里程碑：审计修复（P1）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../validation/design-implementation-audit/README.md)，发现 F029。
- 受影响原任务：009、017、018。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §3.6；STATES §3 InputsUpdateProposed；项目长占用与任务短锁约定 为验收依据；按需阅读对应章节。

## 已核实偏差

update／withdraw 在草案分支之前取得项目执行锁。真实 worker 持该锁时草案保存直接报 lock_busy；已有 prepareOnly 夹具保存草案时已释放锁，未覆盖真实活动状态。

- 代码位置（审计基线）：src/application/task-service.ts:685–688、838–843；src/worker/knit-worker.ts:172。
- 证据等级：动态复现 + 源码核实。
- 实际证据：stage-probes.log：active-run-input-draft.saved=false、reason=lock_busy。
- 最小场景：启动有短暂延迟的 fake Pi worker，在运行终止前提交 clarify 草案。
- 证据文件：[审计记录目录](../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 为仅保存／撤回草案使用稳定任务身份的短锁与版本校验，不与 worker 项目长占用互斥。
- 应用草案仍核实旧 run、待接收结果及摘要，不能在运行中替换冻结输入。
- 核对保存、撤回、运行结束及接收并发顺序，不丢失草案或覆盖 task.md。

## 完成前必须验证

- 真实 worker 持锁时保存和按摘要撤回成功，旧 run 使用原冻结输入。
- 并发两个草案、错误 expectPending、撤回与接收竞争均有确定结果。
- 优先复用 test/task.test.mjs、test/stage.test.mjs、test/infrastructure.test.mjs，新增测试仅覆盖有业务后果的不变量。
- 运行受影响测试、类型检查及构建；记录命令、环境和结果。需要真实宿主的条目不可用替身冒充完成。
- 同步相关契约／规范中的实现与验证说明，不能通过删掉原要求宣称修复。

## 边界与交接

- Git／故障实验仅在隔离夹具执行；不提交、推送、发布或修改真实仓库历史。
- 保留其他执行者改动；现有产品任务 check-report-fence 不属于本项。
- 阻塞按 BLOCKERS.md 记录事实并继续独立工作；依赖按接口与产物判断，不把编号当硬依赖。
- 修复后交给 [043 独立复验](043-audit-independent-regression.md)；本任务文件不另存一份状态。

## 执行记录

- 2026-11-02：审计主执行者创建任务，记录上述偏差、证据与验收条件；尚未实施本项修复。
- 后续执行者须补充实际修改、验证、未解决事项和交接，不以任务创建视为修复完成。
