# 041 在项目状态概览中列出按月归档任务

- 里程碑：审计修复（P2）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../validation/design-implementation-audit/README.md)，发现 F041。
- 受影响原任务：014、023。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §12 的项目／任务状态查询与归档可追溯要求；CLI status 既有 tasks 概览契约 为验收依据；按需阅读对应章节。

## 已核实偏差

status 枚举 archive 后不会继续递归年月目录下的任务，只检查月目录自身 task.md。task list 能找到已归档任务，按ID status 也能定位，但项目 status.tasks 中遗漏该任务。

- 代码位置（审计基线）：src/application/status-service.ts:174 附近 listTasks；对照 src/application/task-service.ts:taskDirectories。
- 证据等级：动态复现 + 源码核实。
- 实际证据：probes.json：archived-task-status.listedByTasks=true、listedByStatus=false、taskStatus 可返回同一ID。
- 最小场景：临时任务关闭后放入 .knit/tasks/archive/YYYY-MM/<task>/，对比 task list、项目 status 和按ID status。
- 证据文件：[审计记录目录](../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 复用统一任务发现逻辑或严格实现约定归档层级，保持稳定ID与路径一致。
- 概览包括或明确按契约展示归档结果，处理重复ID、损坏文件和未知目录。
- 避免跟随越界链接或无界遍历。

## 完成前必须验证

- 正常按月归档后概览与 task list／按ID status 一致。
- 活动与归档混合、重复ID、非任务目录的行为有确定断言。
- 优先复用 test/m1-cli.test.mjs、test/delivery.test.mjs，新增测试仅覆盖有业务后果的不变量。
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
