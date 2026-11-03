# 038 按候选版本与实际效果恢复规范采纳

- 里程碑：审计修复（P2）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../../../validation/design-implementation-audit/README.md)，发现 F038。
- 受影响原任务：007、011、014、019。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../../../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §8.2；STATES §9–10；OPERATIONS 规范正文／索引更新与幂等要求 为验收依据；按需阅读对应章节。

## 已核实偏差

正文包含任务ID／候选ID来源行就提前返回 alreadyApplied，未核对候选版本和索引。候选同ID改为v2后仍保留v1；正文成功、索引未发布时重试也不补索引，交付收尾只查来源标记。

- 代码位置（审计基线）：src/application/standards-service.ts:321–349；src/application/delivery-service.ts:951–955。
- 证据等级：动态复现 + 源码核实。
- 实际证据：data-probes.log：adoption-index-recovery.alreadyApplied=true、indexRepaired=false；adoption-candidate-version.alreadyApplied=true、containsV2=false。
- 最小场景：正常采纳后恢复旧索引模拟中断并重试；再修改同一候选规则、重新审阅采纳，检查正式正文。
- 证据文件：[审计记录目录](../../../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 以候选内容版本及已发布正文／索引实际效果确认采纳，不能把来源行当完整回执。
- 正文已写但索引未写的中间状态可补齐；候选更新不误判为旧版本已采纳。
- 收尾 gate 同步核实真正匹配的采纳效果，保留人工改动的冲突处理。

## 完成前必须验证

- 完整成功重试幂等；正文／索引任一步失败后可核实恢复。
- 同候选新版本不会返回假成功；索引链接、语义描述及正式摘要匹配新正文。
- 优先复用 test/standards.test.mjs、test/delivery.test.mjs；文件名按实际测试树定位，新增测试仅覆盖有业务后果的不变量。
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
  - `src/application/standards-service.ts`：`alreadyApplied` 判定改为实际效果——正文含完整当前版本规则块且索引已链接目标才幂等返回；只有来源行不算回执。正文已含当前版本而索引缺失时只补索引不重复正文（不重写同内容正文）；候选同 ID 更新后旧规则块不匹配新版本 → 真正追加新规则。
  - `src/application/delivery-service.ts`：`standardsGate` 改为按候选当前内容核对采纳效果（新增 `StandardsService.candidateRuleText`），只有来源行的正文不再通过收尾门。
  - 测试：`test/standards.test.mjs` 新增恢复用例：索引回滚后重试补齐且正文不重复；完整成功重试幂等；候选同 ID v2 不假成功且正文／索引都体现新版本。
  - 验证：`npm run typecheck`、`npm run build`、`node --test test/*.test.mjs` 连续两轮 224 项全过（Linux + Node v24.21.0）；审计探针 `adoption-index-recovery` 由 `alreadyApplied=true, indexRepaired=false` 变为 `alreadyApplied=false, indexRepaired=true`；`adoption-candidate-version` 由 `alreadyApplied=true, containsV2=false` 变为 `alreadyApplied=false, containsV2=true`。
  - 设计同步：DESIGN §8.2、STATES §9–10、OPERATIONS 规范正文／索引更新的幂等与实际效果要求现与实现一致；保留人工改动的冲突处理（targetContainsRule 判定不破坏非本流程写入的正文）。
- 后续执行者须补充实际修改、验证、未解决事项和交接，不以任务创建视为修复完成。
