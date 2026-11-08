---
id: k-fdfd8c171736
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-2c0d10318898
priority: P0
dependsOn:
  - k-a8ace0d90676
  - k-f0d9a8952aff
order: 60
createdAt: 2026-11-07T11:44:07.143Z
title: 改动来源归属、外部改动隔离与失败残留继承
---

# 改动来源归属、外部改动隔离与失败残留继承

## 目标与边界

### 背景与问题

主检出是共享工作区，核心分不清"阶段 Agent 写的"和"用户同时写的"，归属只靠报告与 diff 字面一致。审计复现：

- run 期间用户写了 `user.txt`，Agent 把它列进报告，结果并入 scope，`deliver` 时进了 t5 的产物提交 `c8acf19`。
- 用户同时改了 `a.txt` 而 Agent 没列，整轮失败（`changed_paths_mismatch`），模型费用白花。
- 失败 run 写的文件留在工作区且没有归属。下一轮继续这份工作：
  - 不列这些文件 → `zero_diff`；
  - 列出它们 → `report_changed_paths_missing`；
  - 只有报告"什么都没改"才能通过，崩溃恢复也会落入这条死路。

### 交付范围

1. 工具调用归属：阶段结束后从本 run 的原生会话文件解析 `write`／`edit` 的目标路径，作为"Agent 确定写过"的集合；bash 等其它来源的改动记为"来源不明"。
2. 三类路径分开处理：
   - 报告列出且属 Agent 写入 → 正常接收；
   - 有差异但来源不明（含报告列出的 bash 产物）→ run 进入 `needs_attention: unattributed_paths`，列出路径，等主会话确认；
   - 报告未列出、也非 Agent 写入的外部改动 → 不并入 scope，写入结果的 `externalChanges`，不让整轮失败。
3. 确认出口：`run accept <runId> --include <path>...`／`--exclude <path>...`（桥接 `knit_run` 同步）。确认后按当前指纹并入 scope，记录确认人与原因；被排除的路径不进 scope、不进交付。
4. 失败 run 残留：失败或取消的 run 把 `actualChangedPaths` 与指纹记为任务的 `residue`（任务级，不进 scope）。下一个 run 的报告可以声明继承残留：
   - 指纹未变 → 按"沿用"并入；
   - 指纹已变 → 按本 run 改动处理。
   这样就不再出现 `zero_diff` 与 `report_changed_paths_missing`。
5. 交付：产物提交只包含 scope 路径（现状如此）。交付预检列出本任务的 `externalChanges` 与未处理 residue，提醒用户。
6. 同步 STATES 第 141 行附近、DESIGN 第 5.3／9.3 节、OPERATIONS 结果接收章节和实施提示词。

### 非目标

- 不把 worktree 改成默认开启（与 `k-f0d9a8952aff` 非目标一致）。worktree 模式本身隔离，不需要这套归属。
- 不监听文件系统事件，也不做 shell 级追踪。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 来源不明但报告列出的路径：挂起为 `needs_attention: unattributed_paths`，由主会话用 `run accept --include/--exclude` 确认；不直接接收，也不直接失败。
- 无法读取原生会话文件时，全部路径按"来源不明"处理

## 完成条件

- 自动化测试：
  - 用户并发写入且 Agent 未列 → run 接收成功，该路径出现在 `externalChanges`，不进 scope 和产物提交；
  - Agent 列出但非工具写入 → `needs_attention: unattributed_paths`，`--include` 后进 scope，`--exclude` 后不进；
  - 失败 run 留下文件，下一轮声明继承 → 接收成功，scope 含该路径。
- 审计 F2 与 S3 场景不再复现；`npm test` 通过。

## 输入引用

- 审计 F2、S3。
- `src/application/stage-runner.ts:946-990`、`src/application/run-acceptance.ts`、`src/application/scope.ts`、`src/adapters/pi/` 会话文件读取。

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
- 衔接已交付的 k-a8ace0d90676（stage-baseline：成果路径以基线提交加基线时已脏路径计算）与 k-f0d9a8952aff（.knit/tasks/** 从 changedPaths 剔除、stale_input）：来源归属须在这两者之上实现，三者结论一致。
- 本仓库此前实测案例（证据）：run-33871596b5c5 因 worker 把累计 scope 全部列入 changedPaths 而 changed_paths_mismatch 整轮失败，主会话只能先 snapshot restore 再重派；失败 run 的残留继承正是这一场景的出口。

## 完成记录（2026-11-08 主会话）
- 实施 run-06a9da9290a8 completed（约 6.2 小时），npm test 636/636。
- independent 检查 run-52dd314c6975 pass，未改文件。用真实 Pi 1.5.0 会话文件核对了 write/edit 的 toolCall.arguments.path 结构，与解析假设一致。
- 遗留：桥接 knit_run action=accept 透传 include/exclude 没有专门测试（底层 CLI 有覆盖）；没有用真实 Pi 跑完整条流程。
- 主会话决定：本仓库 .knit/agents/{implement,runtimes/pi}.md 由主会话从模板逐字同步，单独提交（新机制把这类改动识别为外部改动，不进 scope，结果符合预期）。

### 交付记录

<!-- knit:delivery:op-ea3b0021be70 -->
- 操作: op-ea3b0021be70
- 时间: 2026-11-08T18:11:06.939Z
- 分支: refs/heads/main
- 授权来源: .knit/tasks/11-07-audit-fix-plan/plan.md#执行授权
- 工作提交: bd7d5d42b5401d8d6a872b90872c3b5365c26dc7
- 结果: 正常交付；检查 run-52dd314c6975 通过
- 归档目标: .knit/tasks/archive/2026-11/11-07-change-attribution

<!-- knit:progress:end -->
