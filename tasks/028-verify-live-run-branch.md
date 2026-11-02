# 028 在运行边界核对实际 Git 分支

- 里程碑：审计修复（P1）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../validation/design-implementation-audit/README.md)，发现 F028。
- 受影响原任务：012、013、018、021。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

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
- 后续执行者须补充实际修改、验证、未解决事项和交接，不以任务创建视为修复完成。
