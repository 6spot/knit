---
id: k-1910551e4f50
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:08.155Z
title: Worktree：执行路由、跨目录查询与会话续做
---

需求冻结（核对 WORKTREE §6.3、DESIGN §3.5/§9.4、现有 run/session/delivery 根路径用法、任务10–12 交付物后决策）：

根模型（关键）：`mainRoot`＝主检出（`.knit/` 元数据库、run 产物、锁、pi-sessions 的唯一位置）；`executionDir`＝任务实际执行目录（binding.worktree.active 时为 worktree 路径，否则等于 mainRoot）。任务资料（task.md/plan/design/research）按任务11 交接后以 executionDir 为准；`.knit/.runtime` 只在 mainRoot，worktree 内不产生。

1. 新增 `src/application/worktree-routing.ts`：
   - `resolveProjectStart(startDir)`：`git rev-parse --show-toplevel` + `--git-common-dir`；commonDir 的父目录≠toplevel 判定为关联 worktree → mainRoot=dirname(commonDir)，executionDir=toplevel；否则二者相同。非 Git 目录按 `normalizeRoot` 原样处理。
   - `executionRouteOf(binding, mainRoot)` → `{ state: "main" | "worktree" | "invalid", dir, branch, layout, prepared, problem }`；`invalid` 含目录缺失／不在 `git worktree list --porcelain`／分支不符／归属不符，带具体 problem，绝不静默回退主检出。
   - `assertExecutionRoute(route, startDir)`：`state=invalid` → `worktree_invalid:<problem>`；`state=worktree` 且 startDir 不在该目录 → `execution_dir_mismatch`（提示 cd 到实际目录）；`worktree` 且未 prepared → `worktree_not_ready`（提示先 `knit worktree prepare`）。

2. CLI：`knit worktree status --task <id>`（只读路由报告：state/dir/branch/layout/prepared/active/problem）；`knit worktree list`（枚举 binding 中全部 worktree 登记，含 invalid 条目与原因，不隐藏；跨目录可见）。

3. run 路由：`run prepare|implement|check|start|status|accept|cancel|resume|assist` 在 CLI 入口用 `resolveProjectStart(--dir)` 得到 mainRoot（元数据库与 RunStore 位置不变）与当前 checkout；coordinator 新增 `executionDir`（缺省=root），用于 `locateTaskDocument`、`loadSectionContents`、`currentBranch`、context planner dir、快照基线与 `worktreeSignature`、阶段进程 cwd。分支三方核对在本任务改用 route 分支：worktree 路由下 expected.branch=`binding.worktree.branch`（frontmatter 保留源分支 refs/heads/main，不作否决依据），并写入 request.expected/result 便于核对；`binding.branch` 已由任务11 切换为 worktree 分支。

4. 会话与恢复：pi-sessions 目录与登记仍以 mainRoot 为准；会话记录的 cwd 改为执行目录。executionDir 变化时 `session-service` 既有 cwd 核对返回 `cwd_mismatch`／`project_conflict`，按 agent.resume=prefer 语义回退新会话并读交接文件续做，保留阶段、修复轮次与 scope，不改 completed 来源。活动 run 观察/取消/接收仍按 runId + mainRoot 定位（结果归属不随目录变化）。

5. 边界：不实现跨目录合入交付（任务16）、清理（15）、移动修复（14）与并行调度（17）；不复制 `.knit/.runtime` 到 worktree；单执行者与冻结输入不变量不变；worktree 内不得开新元数据库（检测到 worktree 缺 binding 时按 mainRoot 读取）。

测试（隔离夹具：临时 Git 仓库 + create/handoff/prepare 的 worktree）：a) worktree 内派发实施：cwd=worktree、run 产物与 pi-sessions 仍在 mainRoot、worktree 无 `.knit/.runtime`；b) 主检出对 worktree-active 任务派发 → `execution_dir_mismatch`；c) 未 prepare 的任务派发 → `worktree_not_ready`；d) worktree 目录被删除/未登记/分支不符 → `worktree_invalid:<原因>` 且不回退主检出；e) 规则隔离：worktree 各自 HEAD 的 .knit 规则生效，主检出未提交改动不进入；f) `worktree list` 含 invalid 条目与原因、`worktree status` 字段完整；g) 取消与结果归属：从主检出按 runId 取消/接收 worktree 内 run 成功；h) 会话续做：cwd 变化 → 新会话 + 保留阶段/修复轮次/scope；cwd 不变 → 原会话恢复；i) 单执行者：同一任务在主检出与 worktree 同时派发被锁拒绝；j) 非 Git 与主检出常规路径回归。全量 npm test 绿。

模型：deepseek 429，派发显式 --provider magpie --model auto/glm-5.3-flash。

<!-- knit:progress:start -->
## 当前位置

deliver：实施已接收，self 自检通过；业务完成凭据已写入，Git 提交／归档待授权。

## 关键经过

实施（run-a235da6de8d1，implementation_accepted；模型 magpie/auto/glm-5.3-flash）：新增 `src/application/worktree-routing.ts`（resolveProjectStart／executionRouteOf／assertExecutionRoute，登记核实与 invalid 原因）；`src/cli/root.ts` 统一 CLI 主检出解析；run 命令组按 mainRoot 定位元数据库／RunStore／锁，coordinator、worker、stage-runner、acceptance 引入 executionDir（任务资料、planner、分支核对、快照基线与签名、阶段 cwd），pi-sessions 与会话登记保留 mainRoot 并把会话 cwd 改为执行目录；新增只读 `knit worktree status/list`；补充 a–j 隔离夹具测试。

自检（主 Agent，self）：`npm test` 全量通过；另核对发现两项未列入冻结验收的后续问题，未在本任务内夹带修改（保持已接收 scope）：

1. 顶层 `knit status --run/--events` 在 worktree 内仍按当前目录找 run 产物（`run status` 已正确按 mainRoot），属完整跨目录状态视图缺口。
2. `run-acceptance` 的修复轮次上限从 executionDir 读 config，而 `run-coordinator.prepare` 从 mainRoot 读，两处口径待统一；当前仅在 worktree HEAD 与主检出 config 不一致时影响上限判定。

两项留待后续任务/讨论，不阻塞本任务冻结条款。

## 结果与验证

- `npm test`（含 typecheck、build）全量 370 项通过；a–j 场景全绿（worktree 内派发、主检出拒绝、未 prepare、现场失效不回退、规则隔离、status/list、跨目录取消与接收、会话 cwd 变化回退、单执行者锁、常规路径）。
- 已知边界（未验证／待后续任务）：真实模型与真实多机 worktree 未验收；`knit status <taskId>`、overview 与 `status --run/--events` 从 worktree 的完整跨目录视图未实现（见自检发现）；跨目录合入交付、清理、移动修复、并行调度未实现。
- 修改文件：worktree-routing.ts、root.ts、run-coordinator.ts、run-acceptance.ts、stage-runner.ts、snapshot.ts、worktree-prepare.ts、knit-worker.ts、contracts/run.ts、cli/{run,worktree,status,resume,session,snapshot,task,standards,deliver,output}.ts、test/fixtures/fake-pi.mjs、test/worktree-routing.test.mjs。

## 运行引用

- 实施 run：run-a235da6de8d1（snapshot ready，597 entries；结果已接收）。
- 会话：s-7f285b23bc1d / 1177a96f-e64f-4946-a97a-a85a434d0ca0（resumeAction=create_new，no_previous_session）。
- 未提交：工作区改动与任务资料均未提交（无提交授权）。

### 交付记录

<!-- knit:delivery:op-088248b7b73e -->
- 操作: op-088248b7b73e
- 时间: 2026-11-04T08:19:56.607Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: 4828d1f3554f6b2ee8a67baa4286482b28bdae3d
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-worktree-execution-query-session-resume

<!-- knit:progress:end -->
