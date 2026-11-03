# 033 阻止规范采纳沿符号链接越出项目

- 里程碑：审计修复（P1）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../../../validation/design-implementation-audit/README.md)，发现 F033。
- 受影响原任务：007、011、016。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../../../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §14.1；ARCHITECTURE §6；规范目标必须位于项目内 为验收依据；按需阅读对应章节。

## 已核实偏差

采纳目标仅做字符串校验，再 join 到项目根；未核实父目录真实路径。父目录链接到另一个临时目录时，apply 成功并修改外部 rules.md。

- 代码位置（审计基线）：src/application/standards-service.ts:318、337；src/application/standards.ts:110；src/infrastructure/atomic.ts。
- 证据等级：动态复现 + 源码核实。
- 实际证据：data-probes.log：standards-parent-symlink.applied=true、outsideChanged=true。
- 最小场景：临时 A 项目 .knit/standards/ext 链接到临时 B，目标 ext/rules.md 经审阅后采纳，检查 B 的变化。
- 证据文件：[审计记录目录](../../../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 发布前逐段核实目标及父目录，复用已验证的路径边界／链接拒绝策略。
- 覆盖正文、索引、临时文件的真实写入位置；不能仅靠文本前缀判断。
- 保留合法的项目内规范采纳与原子版本核实，不把路径冲突当已采纳。

## 完成前必须验证

- 父链接、目标链接、替换为链接、.. 或绝对路径等不允许的输入被拒绝且项目外无变化。
- 正常正文与索引更新及重复采纳通过。
- 优先复用 test/standards.test.mjs、test/restore.test.mjs；文件名按实际测试树定位，新增测试仅覆盖有业务后果的不变量。
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
  - `src/application/standards-service.ts`：apply 的目标解析由裸 `join(root, target)` 改为 `safeJoin(root, target)`——复用 paths.ts 已验证的边界策略：拒绝绝对路径／NUL／`..` 越界，用 realpath 核实目标与最近存在祖先未经符号链接逃出项目；临时文件与原子版本核实不变（同一 targetPath）。
  - review 阶段沿用 `normalizeTargetPath` 的前置拒绝（非 standards/、候选目录、非 .md、段级 `..`）；本次修复补上的是“表面合法但父目录／目标本身是符号链接”的逃逸。
  - 测试：`test/standards.test.mjs` 新增参数化边界用例：父目录链接、目标替换为链接、`..`、绝对路径四场景拒绝且项目外文件无变化；项目内正常采纳与重复采纳通过。
  - 验证：`npm run typecheck`、`npm run build`、`node --test test/*.test.mjs` 连续两轮 219 项全过（Linux + Node v24.21.0；中间一次单例偶发见 B002）；审计探针 `standards-parent-symlink` 由 `applied=true, outsideChanged=true` 变为 `applied=false, outsideChanged=false, reason=symlink escapes project root`。
  - 设计同步：DESIGN §14.1 与 ARCHITECTURE §6“规范目标必须位于项目内”现与实现一致。
- 后续执行者须补充实际修改、验证、未解决事项和交接，不以任务创建视为修复完成。
