# 027 按当前成果指纹核实检查与交付资格

- 里程碑：审计修复（P1）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../validation/design-implementation-audit/README.md)，发现 F027。
- 受影响原任务：006、013、014、016、018、019。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §5.3、§5.6、§11；STATES §8（成果变化使检查过期） 为验收依据；按需阅读对应章节。

## 已核实偏差

检查接收和交付比较持久化 scope 摘要，没有对其路径重新采样。外部编辑后，旧 pass 仍能通过 validCheck。currentEntry 还沿 stat 读取内容，scopeDigest 没有文件类型／执行位，chmod 0644→0755 不改变摘要。

- 代码位置（审计基线）：src/application/run-acceptance.ts:191、src/application/delivery-service.ts:911–936、src/application/scope.ts:24–65、src/infrastructure/fingerprint.ts。
- 证据等级：动态复现 + 源码核实。
- 实际证据：data-probes.log：scope-current-content-validation.acceptedAfterExternalEdit=true；probes.json：scope-mode-change.fingerprintChanged=false。
- 最小场景：用 delivery 测试夹具建立匹配 scope/pass；只改 app.txt，再调用交付守卫。另对 scope 中脚本 chmod 后比较摘要。
- 证据文件：[审计记录目录](../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 在正式检查接收、交付及重试边界重新核实当前 scope 路径，包含新增／删除与约定的文件类型、链接、执行位。
- 文件发生变化时使检查过期并要求重新检查；不要仅改存量 scope 摘要以让旧 pass 继续有效。
- 同步 scope／成果凭据契约及已有记录兼容策略，保持限定提交与无关 index 保护。

## 完成前必须验证

- 检查后改字节、删除、换链接或改执行位均不能复用旧 pass；检查接收窗口的外部变化同样拒绝。
- 未变化的正常交付、失败后幂等重试和无关路径改动继续符合现有语义。
- 优先复用 test/stage.test.mjs、test/delivery.test.mjs、test/restore.test.mjs；文件名按实际测试树定位，新增测试仅覆盖有业务后果的不变量。
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
