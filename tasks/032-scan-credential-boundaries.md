# 032 落实规定的写入与限定提交凭据扫描

- 里程碑：审计修复（P1）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../validation/design-implementation-audit/README.md)，发现 F032。
- 受影响原任务：007、009、011、014、019、026。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §5.6（约346行）及 §15.1 第6项；规定的 token／私钥模式扫描 为验收依据；按需阅读对应章节。

## 已核实偏差

任务／规范写入及限定提交调用链没有规定扫描。合成私钥标记能写入任务；为合成内容建立匹配 scope/pass 后交付 completed 且创建工作提交，排除了027的旧检查问题。

- 代码位置（审计基线）：src/application/task-service.ts:402、src/application/standards-service.ts:337、src/application/delivery-service.ts:655；相关配置写入入口。
- 证据等级：动态复现 + 源码核实。
- 实际证据：data-probes.log：synthetic-credential-boundaries.taskWritten=true、deliveryState=completed、workCommitCreated=true；内容全部为审计合成标记。
- 最小场景：仅在临时仓库使用无真实密钥的 PEM 标记；提交侧先建立与该合成正文完全匹配的检查凭据，再交付。
- 证据文件：[审计记录目录](../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 在规范要求的任务、规范、配置持久化及限定提交前执行共用扫描，覆盖实际拟发布内容。
- 命中时暂停该副作用，只报告类型和位置；错误、日志、诊断及报告不得回显完整敏感值。
- 保留用户已有正文和 index；若需授权例外，其语义须来自现有规范或另行明确决定。

## 完成前必须验证

- 用合成 token／私钥模式覆盖写入与提交边界；无命中正常写入不受影响。
- 命中后无新正文发布／提交，stdout、stderr、诊断不包含被检测完整值。
- 优先复用 test/task.test.mjs、test/standards.test.mjs、test/delivery.test.mjs；按设计列出的配置入口补对应验证；文件名按实际测试树定位，新增测试仅覆盖有业务后果的不变量。
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
