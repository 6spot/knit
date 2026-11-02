# 031 将全部生效指令版本纳入检查身份

- 里程碑：审计修复（P1）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../validation/design-implementation-audit/README.md)，发现 F031。
- 受影响原任务：010、013、022。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §5.3、§8.1；ARCHITECTURE 上下文计划与恢复指令生效清单 为验收依据；按需阅读对应章节。

## 已核实偏差

workflow、role、runtime 分节带摘要并标 countsTowardInputs，但 effectiveInputsDigest 仅由任务输入与正式规范计算。只改 check 角色后分节指纹改变，整体摘要保持不变，交付资格也没有另行核实这些版本。

- 代码位置（审计基线）：src/application/context-planner.ts:140–190、306；src/application/delivery-service.ts:923。
- 证据等级：动态复现 + 源码核实。
- 实际证据：probes.json：role-instructions-digest.roleDigestChanged=true、effectiveDigestChanged=false。
- 最小场景：同一任务生成 check 计划，仅修改 .knit/agents/check.md，再生成计划并比较分节及整体摘要。
- 证据文件：[审计记录目录](../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 按统一的生效清单计算稳定身份，覆盖工作流、所用角色和运行指令等实际输入。
- 在冻结、接收、恢复及交付边界核对当前计划；恢复时落实指令更新，而非仅把摘要写日志。
- 明确候选规范／纯进展等背景材料不计入输入，保留现有语义。

## 完成前必须验证

- 角色、工作流、运行指令变更使旧凭据过期；仅进展记录或未采纳候选变化不影响。
- request 发布到 worker 冻结之间的版本变化被拒绝或按既定策略重建。
- 优先复用 test/session.test.mjs、test/standards.test.mjs、test/stage.test.mjs、test/delivery.test.mjs，新增测试仅覆盖有业务后果的不变量。
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
