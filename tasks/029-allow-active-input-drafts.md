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
- 2026-11-02：开发 Agent 实施修复并验证完成。
  - `src/application/task-service.ts`：update 直接更新拆为两段——活动 run 中仅用任务短锁（稳定 ID）保存草案（`saveDraftLocked`），不与 worker 项目执行占用互斥；非活动 run 的直接更新仍取项目＋任务双锁，且项目锁等待后锁内重读防止覆盖后来更新。`withdrawPending` 改为仅任务短锁；撤回记录改写 operations 表（`task.withdraw-pending`），不再写 task.md——活动运行中写盘会触发阶段执行器的 `.knit` 保护检查（`protected_path_modified`）。apply 仍要求 runsSettled 与摘要／基线核对不变。
  - `src/application/run-acceptance.ts`：`acceptStage` 与 `applyJournal` 分别在项目锁内再取同名任务短锁（`run.accept.stage`，与项目锁同序，无死锁），接收与草案保存／撤回串行，不丢失草案、不覆盖 task.md；草案存在时接收仍按既有 `pending_inputs` 暂停（待应用输入阻后续接收，DESIGN §3.6）。
  - `src/infrastructure/locks.ts`：`LockManager` 增加同实例、同键、同 action 的引用计数重入（沿用原 token），接收内部 acceptStage→applyJournal 嵌套取锁不再自锁；不同 action 或跨实例仍 `lock_busy`，token 校验、心跳、强杀清理语义不变。
  - 测试：`test/stage.test.mjs` 新增端到端用例（真实 fake-pi worker 持项目占用期间保存、撤回、再保存；旧 run 接收按草案状态暂停后恢复；错误摘要撤回拒绝；冻结输入不被草案覆盖）；夹具 `.gitignore` 增加 `.locks/`（锁目录在仓库内会进入运行前后签名，与生产默认锁根在 `~/.knit/locks` 不同）；`test/task.test.mjs` 撤回记录断言改为 operations 记录。
  - 验证：`npm run typecheck`、`npm run build`、`node --test test/*.test.mjs` 连续两轮 214 项全部通过（Linux + Node v24.21.0）；审计探针 `active-run-input-draft` 由 `saved=false, reason=lock_busy` 变为 `saved=true`。
  - 设计同步：DESIGN §3.6 / STATES §3 InputsUpdateProposed（运行中保存草案待工具终态后应用）现与实现一致；撤回留操作记录属于实现层落点调整，不改变“清草案、冻结输入不变”语义。
- 后续执行者须补充实际修改、验证、未解决事项和交接，不以任务创建视为修复完成。
