# 040 收紧既有运行目录及 SQLite 文件权限

- 里程碑：审计修复（P2）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../validation/design-implementation-audit/README.md)，发现 F040。
- 受影响原任务：004、007、008、024。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 OPERATIONS §3（约75行）：目录0700／文件0600；ARCHITECTURE 私有本机索引与运行资料 为验收依据；按需阅读对应章节。

## 已核实偏差

mkdir(mode) 不会修正既有目录；SQLite 仓储未指定／修正数据库权限。在 umask022、预建0755 runtime 下，初始化和仓储打开后 runtime=755、metadata.db=644、WAL=644。RunStore.create 的私有处理不能覆盖这些入口。

- 代码位置（审计基线）：src/infrastructure/sqlite-metadata-store.ts:47；src/application/initialization.ts:263；WAL／SHM 创建与现有目录路径。
- 证据等级：动态复现 + 源码核实。
- 实际证据：probes.json：preexisting-runtime-permissions.runtimeMode=755、databaseMode=644、walMode=644。
- 最小场景：仅在临时项目预建0755 .knit/.runtime，umask022，执行 init 并打开仓储，stat runtime／db／WAL。
- 证据文件：[审计记录目录](../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 对已有运行根及敏感子目录明确收紧权限，对数据库与其 sidecar 采用可验证私有创建／修复方式。
- 覆盖先打开仓储、初始化和重开等实际入口，避免只修 RunStore.create。
- 权限失败应给出准确错误并保留资料，不能宣称已落实私有模式。

## 完成前必须验证

- 新建与既有0755目录、0644数据库在不同 umask 下满足0700／0600。
- 数据库、WAL、SHM 实际存在时均核实；正常重开与SQLite一致性不受影响。
- 优先复用 test/init.test.mjs、test/metadata.test.mjs、test/infrastructure.test.mjs，新增测试仅覆盖有业务后果的不变量。
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
