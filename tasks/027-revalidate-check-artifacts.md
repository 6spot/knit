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
- 2026-11-02：开发 Agent 实施修复并验证完成。
  - `src/infrastructure/fingerprint.ts`：`fileFacts` 改用 lstat，符号链接记 `link`（`mode` 存目标字符串，不追踪内容）；`listFiles` 同步；导出面不变。
  - `src/application/scope.ts`：`currentEntry` 增加 `factsKind` 选项，新条目带类型与模式（目录按子项数、链接按目标、文件按字节+八进制模式）；新增 `entryDrifts`／`scopeEntriesCurrent` 按当前事实重核；无 `factsKind` 的旧记录按原语义仅核内容（stat 沿链接），升级不追溯失效。`mergeScope` 新条目均带事实字段。
  - `src/contracts/run.ts`：`ScopeFileSchema.entries` 与 `RunResultFileSchema.actualEntries` 增加可选 `factsKind`／`mode`。
  - `src/contracts/metadata.ts`：binding.scope 条目同步可选字段。
  - `src/application/run-acceptance.ts`：检查接收前 `scopeEntriesCurrent` 重核，不符转 `scope_changed`；实施接收逐路径 `entryDrifts` 复核 `actualEntries`（类型、模式、内容、缺失）。
  - `src/application/delivery-service.ts`：`validCheck` 在 scope 摘要一致后追加现场重核，不符拒绝 `check_stale`（“检查后成果路径现状与记录不符”）。
  - `src/application/stage-runner.ts`：结果发布 `actualEntries` 带事实字段。
  - 测试：`test/delivery.test.mjs` 夹具改用事实条目；新增“scope 现状重核”参数化测试（改字节／换链接／chmod／删除均拒，恢复后旧 pass 可用）；hook 改内容场景预期改为拒绝（旧 pass 不复用，与 027 语义一致）；`test/stage.test.mjs` 新增接收窗口外部改动转 `scope_changed` 且可恢复；`test/infrastructure.test.mjs` 补 fileFacts 链接／模式事实。
  - 验证：`npm run typecheck`、`npm run build`、`node --test test/*.test.mjs` 全部通过（212 项，0 失败，Linux + Node v24.21.0）。交付守卫与接收窗口拒绝均由真实夹具验证；未涉及真实宿主条目。
  - 设计同步：DESIGN §5.3 “指纹按版本化 SHA-256 规则保存路径、类型、模式和内容” 现与实现一致；scopeDigest 本身仍只冻结路径与内容摘要（检查凭据身份不变），模式／类型过期由逐路径重核拦截，不属本次偏差范围。
  - 未竟事项：审计探针 `scope-mode-change.fingerprintChanged=false` 按上述分工保留（由重核拒绝而非摘要变化体现）；已由 delivery/stage 测试覆盖等价不变量。
- 后续执行者须补充实际修改、验证、未解决事项和交接，不以任务创建视为修复完成。
