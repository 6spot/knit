# 035 补齐 prefer 恢复的身份核对与新会话切换

- 里程碑：审计修复（P2）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../validation/design-implementation-audit/README.md)，发现 F035。
- 受影响原任务：003、010、013、017、021。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §9.4 第3–5项；STATES §7 的原生恢复／fallback 为验收依据；按需阅读对应章节。

## 已核实偏差

runtime 仅要求 sessionId 非空，未与恢复目标／预分配身份比较；实际启动恢复失败直接失败，未沿同客户端新建。预检 fallback 创建新原生会话却沿用旧 knitSessionId 和 source，形成多个原生对象共用稳定身份，getByKnitId 查询有歧义。

- 代码位置（审计基线）：src/adapters/pi/runtime.ts:156；src/application/stage-runner.ts:178、225、452、464；src/infrastructure/sqlite-metadata-store.ts:138。
- 证据等级：源码核实，未动态复现。
- 实际证据：源码调用链核实；本轮未动态执行身份不符、启动失败和文件缺失三种 RPC stub 场景。
- 最小场景：RPC stub 分别返回意外 sessionId、仅拒绝 --session 恢复、旧文件缺失触发 fallback；检查是否发 prompt、锁身份、SQLite 映射及来源。
- 证据文件：[审计记录目录](../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 发 prompt 前核对实际原生身份与预期，并确认旧实例终止。
- prefer 恢复失败在保持项目占用下沿原客户端创建新 Session，切换对应会话锁。
- 新会话使用独立 Knit 身份并关联旧来源；不覆盖旧引用，不重置阶段、修复计数和 scope。

## 完成前必须验证

- 身份不符不会带错误 Session 锁继续执行。
- 恢复失败可新建续做，新旧查询不歧义且来源可追溯；显式取消不被误判成恢复失败后重启。
- 优先复用 test/pi-runtime.test.mjs、test/stage.test.mjs、test/session.test.mjs、test/metadata.test.mjs，新增测试仅覆盖有业务后果的不变量。
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
