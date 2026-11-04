# 设计：检查角色支持范围内修复（k-ff7dd090e64b）

## 规则

检查阶段可以修改文件并运行验证，但只在「问题与修复方向都由既定需求明确」时直接修复。涉及需求解释、取舍、验收变化或扩大范围时不动代码，用 `verdict=blocked` 与 findings 交回主会话。

## 代码改动点

1. `src/application/stage-runner.ts`
   - 删除 check／advisory 的 `*_side_effects` 一律失败；advisory 仍只读（保持现行为）。
   - check 的改动受结构与报告约束：`.knit/` 保护路径仍拒绝；有实际改动时报告 `changedPaths` 必须与实际 diff 完全一致（复用 implement 的比对，失败原因 `changed_paths_mismatch:<paths>`）。
2. `src/application/stage.ts`
   - `buildUserPrompt` 的 check 指令改为允许范围内修复，说明交回条件、报告字段与「自检不等于独立检查」。
   - `validateReportForPhase`：check 报告在有改动时要求 `changedPaths`；verdict／coverage 保持必填。
3. `src/application/run-acceptance.ts`
   - check pass 且带改动时，把改动路径并入任务 scope（append 语义，含 digest），供交付分类使用；scope 并入不得清空既有条目。
   - `CheckFile`（`src/contracts/run.ts`）新增可选 `changedPaths` 与 `selfVerified`（true 表示检查者自行验证了自身修改）；接收回执读取并保存。
   - 完成资格不变：仍需最新 check 通过；self 任务不因检查修复而多派一轮独立检查。
4. `src/application/context-planner.ts` / `stage-runner.ts` 工具策略
   - check 不再过滤 `write`／`edit`；advisory 继续只读。
5. 提示词
   - `.knit/agents/check.md` 与 `assets/templates/.knit/agents/check.md`：写明可修复范围、交回条件、报告要素（发现的问题、实际修改、执行的验证、未解决、未验证）、自检表述边界。
   - 检查 runtime 补充段（若存在 runtime/check 指令）同步。

## 规范

- DESIGN §4 检查环节、STATES（CheckAccepted 允许修复与 scope 并入）、OPERATIONS、GLOSSARY 同步；删除「检查只读」「检查有改动一律拒绝」的过期表述。
- 保留：检查不改需求、不改 `.knit` 元数据、不提交 Git、不推进交付。

## 验证

- 检查发现范围内缺陷 → 修改落盘、验证通过、接收成功，改动路径进入 scope 并计入交付产物。
- 报告 changedPaths 与实际不符 → 拒绝（`changed_paths_mismatch`）。
- 触碰 `.knit/` 元数据 → 拒绝（`protected_path_modified`）。
- advisory 仍不能写文件。
- 超范围／需决策情形在指令与测试中体现为 `blocked` 交回，不自行决定。
- `npm test` 全量通过（含 typecheck/build）。
