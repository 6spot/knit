---
id: k-06707c35d5d9
title: 支持从瞬时失败执行恢复续聊会话
status: delivered
stage: null
verification: independent
parent: k-b7380720fbf3
dependsOn:
  - k-33bf1cdb4953
priority: P1
createdAt: 2026-11-26T14:23:18.477Z
---

## 目标与范围

**要解决的问题**：实测近期 10 次执行失败中有 6 次是上游 API 瞬时错误（HTTP 429、`server_error`、SSE 解析错误等），其中半数发生在执行者已经完成大量工作与文件改动之后。但目前 `src/application/run-prepare.ts` 的 `prepareResumeHandoff` 只从 `countedRuns(record)`（要求 `failure === null`）中查找可恢复的 `resumeId`，导致开启 `resume: true` 的环节遇到瞬时失败后只能放弃原会话、重开全新会话从头读代码并重烧一遍 token。

**改动目标（高风险状态推进与派发链路，本任务要求独立审查）**：
1. **允许从可恢复的失败执行续聊（`src/domain/progress.ts` 与 `src/application/run-prepare.ts`）**：
   - 在 `progress.ts` 中提供专门的纯函数（如 `resumableRun(record, target)`）查找同一需求摘要（`requirementDigest === record.confirmedDigest`）、同一环节、同一执行器、同一 Agent 下最近一次已结束且带有效 `resumeId` 的执行：
     - 保持 `countedRuns`、`completedBatches`、`stageEntries`、`dispatchLimit` 和 `nextStep` 的状态推进与计数规则**完全不变**（失败的单执行器执行仍然不算进入次数、仍然原地重试、仍然不算审查通过）。
     - 允许作为续聊候选的失败执行：要求 `endedAt !== null && resumeId != null`，且失败原因**不是**破坏性/越权违规或清理失败（即排除「执行者提交了改动」「执行者改了受保护的文件」「执行清理失败」等违规失败；像模型服务出错、报告读不出来、中途退出/中止等带有效 `resumeId` 的失败均允许尝试恢复）。
     - 规范摘要校验（`standards.sha256`）、`--fresh` 强制新会话、需求变更重新确认后摘要不一致、以及执行时的 `agent.checkResume` 校验与启动失败自动回退全新会话的机制全部沿用不变。
2. **明确续聊恢复消息内容（`src/application/handoff.ts` 与 `src/application/run-prepare.ts`）**：
   - 当本次续聊恢复的是**上一次同环节失败的执行**时，`resume-message.md` 中明确告知执行者：上一次执行因 `<failure>` 中断，工作区保留了当时的改动，请检查当前 Worktree 状态、接着完成剩余实现/验证并按格式提交完整报告（若主会话提供了 `--instruction` 也一并附上，审查环节照常附带最新的 `reviewChanges` 改动摘要）。
   - 当本次续聊恢复的是**正常结束后的返工/复审**（非同环节失败重试）时，保持原有 `resumeMessage` 行为不变。
3. **同步更新文档**：更新 `docs/design/DESIGN.md` 第 7.1 节关于原生续聊查找条件与失败重试恢复的说明。

**明确不做 / 边界**：
- 不自动重试失败的执行（仍由主会话/用户显式运行 `knit run start` 决定是否重派）。
- 不改变 `countedRuns`、`completedBatches`、`stageEntries`、`lastPassedReview` 或 `nextStep` 的既有状态机判定。
- 不修改 Worktree 中的受保护路径（`.knit/workflow.yaml`、`.knit/config.json`、`.knit/standards/`、`.knit/agents/`）。

## 完成条件

### Requirement: 瞬时失败后重派支持恢复原原生会话
#### Scenario: 同需求下 API 失败且留有 `resumeId` 的执行，重派时生成续聊消息并恢复会话
- WHEN 开启 `resume: true` 的环节执行因模型错误（如 `执行者出错：HTTP 429`）或报告读不出来失败，且记录中保存了有效的 `resumeId` 与一致的 `standards.sha256`，随后再次派发该环节
- THEN `prepareRun` 写出 `resume-id.txt`（指向该失败执行的 `resumeId`）和包含失败原因与续做指引的 `resume-message.md`；`executeRun` 优先恢复该原会话；若恢复检查不通过或启动失败，仍自动回退为完整交接新会话

#### Scenario: 违规失败、需求变更、`--fresh` 或规范变更时不恢复失败会话
- WHEN 上一次失败是因为提交了改动、修改受保护文件或执行清理失败，或者需求已修改重确认、规范摘要变化、或命令行指定 `--fresh`
- THEN 不恢复该失败执行的会话，直接使用完整交接开启全新会话，并在 `worker.log` 记录清晰的会话模式/回退原因

### Requirement: 状态推进与返工计数语义不变
#### Scenario: 失败重试不消耗返工上限且不影响 `nextStep` 与 `lastPassedReview`
- WHEN 单执行器环节连续失败并续聊重试，随后成功结束
- THEN 失败执行不计入 `stageEntries` 与 `maxVisits` 上限，不改变 `nextStep` 与 `lastPassedReview` 的既有判定；审查环节从失败续聊恢复时仍附带当前 Worktree 改动摘要

## 待澄清

## 相关资料

- `docs/design/DESIGN.md#71-返工` — 现行原生续聊、匹配条件与回退设计
- `src/domain/progress.ts` — `countedRuns`、`completedBatches`、`nextStep` 与计数逻辑
- `src/application/run-prepare.ts` — `prepareResumeHandoff` 续聊查找与消息写出
- `src/application/handoff.ts` — `resumeMessage` 与 `appendReviewChanges`
- `src/application/run-execute.ts` — 原生续聊检查、启动与失败回退
- `test/progress.test.mjs` — 状态推进与计数单元测试
- `test/run-prepare.test.mjs` — 派发与续聊准备测试
- `test/run-execute.test.mjs` — 执行与续聊回退测试

## 验证与交付

- 运行 `npm run typecheck`、`npm run build`、`node --test test/progress.test.mjs test/handoff.test.mjs test/run-prepare.test.mjs test/run-execute.test.mjs`，以及全量 `npm test`（因涉及高风险核心链路状态推进与派发），全部通过。
- 本任务为 `independent` 独立审查任务，实现后将派发独立审查环节核对全部边界；改动留在任务 Worktree 分支，不自行提交。

## 结果

已支持从瞬时失败执行恢复续聊会话：在 progress.ts 新增 resumableRun 独立查找同需求、同环节、同执行器、同 Agent 且带有效 resumeId 的可恢复执行（排除提交改动、修改受保护文件、清理失败等违规失败，且不改 countedRuns/stageEntries/nextStep/lastPassedReview 既有计数与状态推进），run-finish.ts 保留模型错误与违规原因并存，handoff.ts 在失败续聊消息中附带失败原因与续做指引（审查环节照常附带最新改动摘要），同步更新 docs/design/DESIGN.md 第 7.1 节。验证：独立审查 r-28d073f9c23b 结论 pass；npm run typecheck、npm run build、git diff --check 通过；定向测试 64/64 通过；全量 npm test 514 通过、0 失败、7 项跨文件系统跳过。未验证：未调用真实模型服务。
