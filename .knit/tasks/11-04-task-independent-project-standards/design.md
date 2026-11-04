# 设计：规范沉淀独立于任务（k-5dd19bb9b84c）

## 作用域

规范是项目事实，不是任务附属物。候选、回执与采纳全部以项目为作用域，任何命令都不要求 `taskId`、任务存在、阶段或收尾状态。

## 存储

- 新候选写入项目级 `.knit/standards/candidates.md`，复用现有候选标记块格式（`<!-- knit:candidate:start id=c-... -->`），一个文件保存全部当前候选。
- 旧任务目录的 `standards.md` 保持只读兼容：`standards list --task <id>` 仍可列出其候选与最近回执；新写入不再落到任务目录。
- 回执仍存 `metadata.db` 的 `standards_reviews`。`task_id` 列存项目作用域键 `project`；记录新增可选 `sourceTaskId`（仅标注来源，不参与匹配），原 `taskId` 字段保留为可选以读取旧记录。
- 候选 `StandardsCandidate` 新增可选 `source`（来源说明，如 `任务 k-...`／`讨论`），渲染进候选块；`source` 不参与 `candidateDigestOf`，迁移不致既有回执失配。

## 审阅与匹配

- `review` 记录 `candidateDigest`、`candidateIds`、`decision`、`reason`、`targets`、`branch`（审阅时当前分支，仅作记录）。项目级匹配只看候选集合摘要，不要求分支一致；旧的「分支变化需重新审阅」只保留在按任务过滤的兼容视图里。
- `pending` 在项目作用域返回 `needsReview`，`reason` 沿用 `no_candidates`／`review_matched`／`review_required`／`candidate_changed`。
- `apply` 仍核对候选规则确实写入目标正式规范，并保持索引追加与摘要更新；不要求任务。

## 交付

- `delivery-service` 删除 `standardsGate` 调用与对应 `standards_review_required`／`standards_apply_required` 抛错路径；交付不因规范候选未审阅而阻塞，也不把规范处理重新绑定任务。reason code 保留供 `standards apply` 自身使用。
- 旧任务即使留有未审阅候选，其交付、关闭、归档不受影响。

## 迁移

- 新增 `standards migrate`（幂等）：扫描 `.knit/tasks/**/standards.md` 的候选块，把项目候选文件中不存在的 `candidateId` 追加进去，`source` 记为来源任务，原文件不删除、不改写。输出迁移条数与来源。
- 迁移不自动创建任务，不改变正式规范摘要；`standards list` 在检测到未迁移旧候选时给出只读提示。

## 指令与模板

- `.knit/workflow.md` 与 `.knit/agents/{implement,check,deliver}.md`（及 `assets/templates/.knit/` 对应文件）加入规范沉淀规则：用户明确长期规则直接整理采纳；Agent 判断足够明确时可自行采纳并说明依据；冲突先提决定；未明确内容存候选；一次性要求只留本次范围；正常回复末尾简短告知内容、适用范围与位置。
- DESIGN §8.2、STATES §9、GLOSSARY 与 CLI 帮助同步；删除「候选写在任务资料」「交付前候选守卫」等过期描述。

## 接口

- CLI：`standards list [--task <id>]`、`propose`（`--task` 可选，仅标注来源）、`review`（`--task` 可选）、`apply`、`pending`、`migrate`。
- 桥接 `knit_standards`：`taskId` 保持可选；新增 `migrate` action。
- 服务：`propose`/`review`/`apply`/`pending` 的 `taskId` 改为可选 `sourceTaskId`；新增 `migrate`。

## 验证

- 空项目（无任何任务）可 `propose` → `review --decision applied` → `apply`，正式规范与索引更新，回执可按候选摘要匹配。
- 明确采纳、自行采纳（同 applied，依据写在 reason）、冲突等待决定（deferred）、一次性例外（不提议）、候选保留（propose 后未审阅）各有可观察结果。
- `migrate` 幂等；旧任务候选迁移后仍可按 ID 审阅；原 `standards.md` 未改动。
- 交付不因候选未审阅阻塞：保留旧任务未审阅候选时 `deliver` 正常完成。
- 兼容：旧回执（含 `taskId`）仍可读取，`standards list --task` 仍显示旧候选。
- `npm test` 全量通过（含 typecheck/build）。
