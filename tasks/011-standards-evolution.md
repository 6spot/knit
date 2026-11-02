# 011 实现规范候选到正式规则的闭环

- 里程碑：M1
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[010 实现Session索引、当前选择与上下文计划](010-session-context.md)
- 实际依赖：[007](007-local-infrastructure.md)、[009](009-task-files-and-inputs.md)、[010](010-session-context.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

让规范持续演进成为首版工作流的一部分，而非只生成静态模板。

## 先读

先遵守根 [AGENTS.md](../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../DESIGN.md)：第8、9.2、10.1节。
- [ARCHITECTURE.md](../ARCHITECTURE.md)：输入／输出边界与规范权威。
- [STATES.md](../STATES.md)：规范候选、输入失效和正式合入规则。

## 实施范围

- 实现standards list/propose/review及机械发现，Task的standards.md保存未生效候选。
- 保存主Agent的接受／延期／拒绝决定、理由与来源版本；程序不替代语义审阅。
- 接受后在执行占用内更新正式正文与索引，后续ContextPlanner按当前版本读取。
- 规范本身为任务产物时区分冻结旧输入与新成果，不追溯新增规则；纳入累计scope和检查。

## 交付物

- 规范用例、模板与索引更新
- 候选／审阅／生效／后续读取的端到端证据

## 完成前必须验证

- 候选不自动生效，延期可继续，不要求每任务新增规范。
- 版本变化重新提示；正式规则变化按守卫失效相关检查，不把记录或候选当输入变更。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不用提示词声称程序已理解候选，不建设自动规范生成服务。
- 保留现有工作区和前置任务记录；不自动提交／推送当前仓库，不操作其它真实仓库，不初始化当前工程的产品 .knit/ 或 .pi/。
- 本文件是开发排程，不是Knit产品Task；文件任务不预定产品元数据后端。

## 阻塞时的伪代码交接

遇阻塞先保留已做工作，按 [BLOCKERS.md](../BLOCKERS.md) 记录后继续其它可做任务。未定部分可写伪代码／暂定接口供下游开发，但不能当真实实现或验收成功。

- 关联阻塞编号：无；发生后引用真实编号。
- 未实现部分与影响：尚无记录。
- 暂定输入／输出／错误边界：需要时据实填写。
- 伪代码与关键步骤：需要时填写，明确哪些只是设计。
- 解除阻塞后补做与真实验证：需要时填写。
- 使用该暂定接口的下游任务：需要时记录，便于后续回补。

## 执行记录

以下是事实记录，不另存一份任务状态；状态只改根 TASKS.md。

- 执行者／Session：ZCode（Pi session 01a1981c-6f75-749d-b9c2-7e5c897950a6）。
- 开始／结束时间：2026-11-02。
- 实际修改：
  - `src/contracts/standards.ts`（新）：候选与审阅回执 schema、`<!-- knit:candidate:start id=… -->` 标记块解析／渲染、候选摘要与候选集合摘要；候选 ID 为 `c-`+12hex，回执为 `r-`+12hex。
  - `src/application/standards.ts`（新）：正式规范文件枚举（排除 `candidates/`）、整体摘要、索引引用解析、目标路径规范化、`effectiveInputsDigest`（任务输入区 + 正式规范）。
  - `src/application/standards-service.ts`（新）：list／propose／review／apply／pending；propose 用任务短锁；apply 用项目执行占用 + 任务短锁，核对匹配回执、目标与文件版本后追加正文、补索引、重复采纳幂等；回执与操作记录同事务保存；返回受正式规则变化影响的冻结任务。
  - `src/contracts/metadata.ts`：TaskBinding 增加 `confirmedStandardsDigest`；`src/ports/infrastructure.ts` 增加 `bindings.list` 与 `standardsReviews`；`src/infrastructure/sqlite-metadata-store.ts` 增加 `standards_reviews` 表与索引（旧库自动建表）。
  - `src/application/task-service.ts`：ready 同时冻结正式规范摘要并返回；newTask 初始化新字段。
  - `src/contracts/context-plan.ts` 与 `src/application/context-planner.ts`：计划增加 `standardsDigest` 与 `effectiveInputsDigest`；候选改读任务 `standards.md`，只作背景并列入 excluded；正式规范循环排除 `candidates/`。
  - `src/cli/standards.ts`（新）与 `src/cli/knit.ts`：standards list／propose（支持 `--file` JSON 多行）／review／apply／pending，`--json` 协议输出与错误非零退出。
  - `test/standards.test.mjs`（新 6 项）；`test/contracts.test.mjs`、`test/metadata.test.mjs` 夹具补 `confirmedStandardsDigest`；`test/session.test.mjs` 候选夹具改任务 `standards.md`。
- 实际验证命令与结果：`npm test` 117/117（standards 6 + session 7 + task 17 + init 11 + infrastructure 18 + domain 23 + contracts 17 + cli 5 + pi-runtime 12 + metadata 6）；`npm run pack:check` 通过；`npm run typecheck` 通过。临时真实项目（/tmp/knit-011-e2e，已清理）用真实 CLI 实测：init → task new → task ready（冻结输入 cd574d330ad3）→ standards propose（候选 c-c3ea7d2627dc，写入 `.knit/tasks/11-02-std-e2e/standards.md`）→ pending=review_required → context（ready、candidate 背景且不计入、excluded candidate_not_applied、stdDigest d4d82dc4ff79）→ review applied（目标不存在时拒绝）→ 建 `.knit/standards/errors.md` 后 review 成功 → apply 写入正文与索引、stdDigest 变为 14bf7eba4134、列出受影响任务 → context 正式规范 section 与摘要更新 → task record 后摘要不变 → 重复 apply 幂等（标题仅 1 处）→ standards list indexed=true；全程零 Git 提交、零模型调用。
- 任务书必需验证逐项：
  - 候选不自动生效，延期可继续，不要求每任务新增规范：propose 只写任务资料，正式规范摘要、inputsDigest 与 effectiveInputsDigest 不变；无候选时 pending=no_candidates 且 needsReview=false；deferred 有理由即匹配并可继续，不要求 targets。
  - 版本变化重新提示：新增候选后 reason=candidate_changed；只覆盖部分候选不匹配当前集合；任务分支变化后 reason=branch_changed；覆盖全部候选后 review_matched。
  - 正式规则变化按守卫失效相关检查，不把记录或候选当输入变更：ready 冻结 `confirmedStandardsDigest`；apply 改变 `standardsDigest` 与 `effectiveInputsDigest` 并返回 `affectedTasks`；纯记录与候选不改变两者。检查凭据在 013 以 `effectiveInputsDigest` 对照。
- 实施中纠正的事实：010 的候选层误读项目 `.knit/standards/candidates/`，按 DESIGN 8.2 改为任务辅助资料 `standards.md`（同时修复正式规范遍历会把 `candidates/` 当正式规则的问题）；审阅回执不能塞进最小 operations 记录，新增 `standards_reviews` 表；候选集合摘要按本次审阅覆盖的候选计算，未覆盖全部时 apply 拒绝。
- 未解决问题／决定：① 检查 run 的凭据与 stale 判定归 013，本任务提供 `effectiveInputsDigest`、`affectedTasks` 与 binding 冻结值；② 采纳的正文按候选“建议规则”机械追加，语义润色由主 Agent 在 review 前完成候选文本；③ `standards review` 不做自然语言分类，mixed 的子集采纳通过多次 apply 表达；④ 收尾／归档的机械提示与 `--dev` 展示归 014。
- 对下一项的交接：012／013 用 `ContextPlanner.plan().effectiveInputsDigest` 作为检查凭据的输入身份；`StandardsService.pending` 可在收尾前调用；`formalStandardFiles` 可复用于成果范围；`standards_reviews` 的 latest 按 reviewId 排序（同毫秒也稳定）。

优先扫描下一编号（阻塞时可继续跳过）：[012 实现快照准备、local启动与worker认领](012-snapshots-and-workers.md)。
