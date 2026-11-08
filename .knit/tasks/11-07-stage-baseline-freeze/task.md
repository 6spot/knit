---
id: k-a8ace0d90676
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-2c0d10318898
priority: P0
dependsOn: []
order: 40
createdAt: 2026-11-07T11:44:06.155Z
title: 阶段基线冻结：HEAD／index 与敏感区核对
---

# 阶段基线冻结：HEAD／index 与敏感区核对

## 目标与边界

### 背景与问题

阶段改动只按 `git status --porcelain --untracked-files=all` 前后差认定（`src/application/worktree.ts:35`、`stage-runner.ts:960`），收尾只核对分支名（`liveBranchMatches`），HEAD、index 均未冻结。DESIGN 第 383 行要求"阶段边界核对 HEAD／分支、index 与实际成果"，实现未做到。审计复现：

- 阶段内 `git commit h.txt`，报告 `changedPaths: []` 被接收，任务 self 完成；提交绕过 scope、指纹与交付。
- 阶段写 `node_modules/x.js`（ignored）、`.git/hooks/pre-commit`、`.knit/.runtime/forged.json` 均未被发现；该 hook 在随后 `knit deliver` 的 3 次提交中各执行一次。

### 交付范围

1. 基线冻结：worker 开始阶段前记录 HEAD oid、符号引用、index 摘要（如 `git ls-files -s` 摘要）与现有工作区签名，写入 run 状态并进入结果。
2. HEAD 核对：收尾时 HEAD 与基线不同，结果为 `failed: head_moved_during_stage`，证据带 `git rev-list <base>..HEAD` 提交列表，不接收、不并入 scope。index 变化写进结果，单纯暂存不判失败。
3. 改动计算以"基线提交＋基线时脏文件指纹"为准，阶段内提交过的路径也能出现在实际差异里，供诊断与报告核对。
4. 敏感区核对：`.git/hooks/**`、`.git/config`、`.git/info/**`，以及 `.knit/.runtime/` 下的 `checks/`、`completions/`、`implementations/`、其它 run 目录、`installation.json`、`init-manifest.json`。阶段前后有变化即 `failed: protected_runtime_modified:<paths>`。本 run 自有目录、会话目录与列表缓存除外。
5. 忽略区摘要：阶段前后各取一次 `git status --ignored` 的目录级条目，变化写进结果的 `ignoredChanges`，`run status` 与桥接通知显示；不判失败。
6. 同步 DESIGN 第 383／413 行、STATES 第 141 行附近、OPERATIONS 运行边界章节和阶段提示词：说明阶段内禁止提交，敏感区改动会被拒绝。

### 非目标

- 不建设操作系统沙箱，也不拦截 shell 调用本身。
- 不对整个 ignored 目录做内容指纹：成本过高，只做目录级摘要。
- 不提供"接纳阶段内提交为成果"的出口。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 阶段内出现提交时直接判失败、保留现场，由用户自行处理提交后重派；首版不做"接纳提交"
- ignored 区只报告不阻断；`.git` 与 `.knit/.runtime` 敏感区阻断

## 完成条件

- 自动化测试复现并断言：阶段内提交 → `head_moved_during_stage`，任务不前进；写 `.git/hooks/pre-commit` 或 `.knit/.runtime/checks/x.json` → `protected_runtime_modified`；写 ignored 目录 → 结果 `ignoredChanges` 非空，run 正常接收。
- 原有正常实施／检查链路测试不回退；`npm test` 除已知 macOS 环境失败外通过。
- 文档中不再声称已核对 HEAD／index 而实际未核对。

## 输入引用

- 审计 F1（总任务 plan.md）。
- `src/application/worktree.ts`、`src/application/stage-runner.ts:946-990`、`src/application/git-status.ts`、`docs/design/DESIGN.md:383,413`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## 派发须知（2026-11-07 主会话，审计计划执行约定）
- 报告 `changedPaths` 只列本 run 在工作区实际改动的路径（与 git 前后差一致），不列之前轮次或其它任务已存在的改动；否则 `changed_paths_mismatch` 整轮失败。
- 交付前凭据扫描规则 generic_secret_assignment（见 src/contracts/credentials.ts）会把“凭据类关键词作变量名或字段名并被赋值长字符串或表达式”的新增行判为疑似凭据。新增代码与测试请给此类局部变量加前缀（例如 owner 前缀），夹具值保持 8 字符以内；完成前用 dist/contracts/credentials.js 的 scanCredentials 扫描新增行确认零命中。
- 工作区里其它 `.knit/tasks/*/task.md` 的未提交改动来自主会话记录，不属于本任务成果，不要修改或列入报告。
- 单跑测试时请 `env -u REX_SESSION -u REX_BLOCK node --test ...`；全量用 `npm test`。

## 完成记录（2026-11-07 主会话）
- 实施 run-468ddffdc1f1 completed（耗时约 3 小时），npm test 606/606。
- independent 检查 run-2f2731c63797 pass，未改文件。非阻塞建议：ignored 区只做目录级摘要；已结束 run 的受保护文件按 stat 比较。这两点均在非目标内且已写入文档。
- 主会话决定：worker 改的是 assets/templates/.knit/agents/{check,implement,runtimes/pi}.md 模板；本仓库自己的 .knit/agents/ 同名文件 worker 无权写入，由主会话逐字同步（改前除新增句外两边完全一致），作为模板同步单独提交，不进入本任务 worker scope。

### 交付记录

<!-- knit:delivery:op-2aac514e42f9 -->
- 操作: op-2aac514e42f9
- 时间: 2026-11-08T01:33:28.269Z
- 分支: refs/heads/main
- 授权来源: .knit/tasks/11-07-audit-fix-plan/plan.md#执行授权
- 工作提交: 5a159883bb8d474be24c620e41fdfbab84ced343
- 结果: 正常交付；检查 run-2f2731c63797 通过
- 归档目标: .knit/tasks/archive/2026-11/11-07-stage-baseline-freeze

<!-- knit:progress:end -->
