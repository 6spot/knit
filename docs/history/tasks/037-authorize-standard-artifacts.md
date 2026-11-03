# 037 实现正式规范作为明确授权成果的路径

- 里程碑：审计修复（P2）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../../../validation/design-implementation-audit/README.md)，发现 F037。
- 受影响原任务：010、011、013、018。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../../../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §5.3；STATES §8（约133行）；ARCHITECTURE §8（约140行）：旧规范作输入、新规范作授权成果 为验收依据；按需阅读对应章节。

## 已核实偏差

runner 无条件拒绝 .knit 下修改，含正式规范；上下文没有授权规范输出与冻结旧规范版本的表示，接收把当前规范变化统一判 stale_input。原011范围要求该能力，未发现延期决定。

- 代码位置（审计基线）：src/application/stage-runner.ts:331–333；src/application/run-acceptance.ts:174 附近；src/contracts/context-plan.ts。
- 证据等级：源码核实，未动态复现。
- 实际证据：源码及原任务范围交叉核实；本轮未执行授权规范输出 fake runtime 场景。
- 最小场景：构造明确以某个正式规范文件为成果的任务，冻结旧规则，fake runtime 只改授权文件；现路径会 protected_path_modified／stale_input。
- 证据文件：[审计记录目录](../../../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 增加范围明确且可审计的规范成果授权及旧输入版本表示。
- 检查按冻结旧规则判定新内容；由主 Agent 明确是否追用新规则，按规范处理后续检查资格。
- 继续保护未授权 .knit 元数据、候选与正式规范边界；不整体放开 .knit 写入。

## 完成前必须验证

- 明确授权的规范成果可按旧规范完成检查；未授权规则变化仍拒绝。
- 是否追用新规则的决定、来源、恢复与资格变更均可核实。
- 优先复用 test/standards.test.mjs、test/stage.test.mjs，新增测试仅覆盖有业务后果的不变量。
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
  - `src/contracts/context-plan.ts`：新增 `AuthorizedStandardOutputSchema`（path／frozenDigest／frozenContent），`ContextPlan.authorizedStandardOutputs` 列出本任务明确授权为成果的正式规范及冻结旧版本。
  - `src/application/context-planner.ts`：plan 支持授权输入——路径校验（仅 .knit/standards/、非候选、无 ..）；磁盘当前内容冻结为授权分节（`standard-frozen:<path>`，countsTowardInputs）；接收／恢复可传已冻结 outputs 按请求快照重建，不读磁盘；`standardsDigest` 中授权文件按冻结摘要计算，新内容不使需求身份变化。无授权路径行为不变。
  - `src/contracts/run.ts`：`RunExpectation.authorizedStandardOutputs` 持久化冻结快照；`src/application/run-coordinator.ts` 从 plan 复制到请求；`src/worker/knit-worker.ts`、`src/application/run-acceptance.ts` 用请求快照重建 plan；`src/application/stage-runner.ts` 的 .knit 保护对授权路径放行，其余 .knit 仍拒。
  - `src/cli/run.ts`：新增 `--authorize-standard <path>`（可重复）。
  - 接收语义：实施接收把授权文件改动照常纳入 scope（逐路径指纹重核）；检查资格由冻结旧规则判定新内容；新规则是否追用于本任务由主 Agent 后续按 §5.3 明确（不计入本任务自动验收）。
  - 测试：`test/stage.test.mjs` 新增授权规范成果用例：未授权改正式规范 `protected_path_modified`；授权后同改动完成接收并进 scope；请求携带冻结内容；未授权 .knit 保护由既有用例覆盖。
  - 验证：`npm run typecheck`、`npm run build`、`node --test test/*.test.mjs` 连续两轮 223 项全过（Linux + Node v24.21.0）。
  - 设计同步：DESIGN §5.3、STATES §8、ARCHITECTURE §8 的“规范本身为明确输出时以冻结旧版本为输入、新内容为成果”现与实现一致；未授权 .knit 写入保护不变。
- 后续执行者须补充实际修改、验证、未解决事项和交接，不以任务创建视为修复完成。
