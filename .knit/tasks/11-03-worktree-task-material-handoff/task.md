---
id: k-19b5cad5c106
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:07.359Z
title: Worktree：任务资料完整交接与中断恢复
---

需求冻结（主会话核对 WORKTREE.md §6.1、DESIGN §3.4–3.6、任务10交付的 worktree-manager/TaskBindingSchema.worktree 后决策）：

命令：`knit worktree handoff --task <id> [--to <worktree-path>]`。默认目标取 binding.worktree.path；未登记 worktree时报错指引先 create/connect。仅从主检出（源）执行；不改 RPC/阶段/模型链路。

流程（§6.1 五步，快照语义）：
1. 预检：任务存在且未归档；无活动 run（有则拒绝）；持任务锁；目标目录为已登记 worktree（porcelain+仓库归属+分支核对，复用任务10校验）。
2. 源快照：源任务目录 `.knit/tasks/<任务目录>/` 全量复制到 `.knit/.runtime/transfers/<opId>/source/`（含未跟踪、嵌套 research/、plan/design 辅助资料），manifest.json 记录每项 relativePath/kind(file|directory|symlink|absent)/sha256/mode，及相对源 Git HEAD 的删除项与未跟踪清单；快照落盘后以备份副本为准，源中途变化不影响本次交接（下次核对发现）。快照复制失败即停，目标不动。
3. 目标定位：扫描目标 `.knit/tasks/*/task.md` frontmatter id 定位同任务旧版本（目录名可不同）。目标当前内容与目标基线（git show <baseline>:path，基线取 binding.worktree.baseline）一致 → 应用源版本+删除项+目录改名，使目标任务资料只位于选定路径；目标存在与基线不同的本地修改或来源不明额外资料 → 停止，保留两边（目标不动、源备份留在 transfers），报告冲突待核实。
4. 应用与核验：按 manifest 写入目标（建目录/写内容/保留可执行位），应用删除项（目标基线跟踪但源清单缺席的路径删除）；完成后逐项重算目标 sha256 与 manifest 比对，全部一致才视为交接完整。
5. 回执与绑定：receipt.json 写 `.knit/.runtime/transfers/<opId>/`（taskId/opId/源目标路径/分支/基线/文件与删除指纹/步骤 journal/sourceHeadAtStart/finishedAt）。核验成功后原子更新主库 binding：worktree.active=true、worktree.handoffAt、worktree.lastHandoffOp、binding.branch=worktree.branch（任务10留下的主字段切换在此完成；relativePath 不变）。

中断恢复：journal 每个破坏性步骤前落盘；再次执行同命令发现未完成 receipt → 核对备份完整性（逐项 sha256）→ 完好则从断点继续，损坏则报错并给出恢复入口（transfers 路径），不静默覆盖目标、不丢弃源。源资料处置：跟踪文件与暂存保持原样（迁出前副本）；源任务目录无任何 Git 跟踪文件时，成功后将整个目录移入 transfers/<opId>/source-original/（避免主目录双权威）；混合时整目录保留并报告「旧副本保留在源目录，待清理」（清理属任务15/交付）。幂等：成功后重跑，源与 receipt 快照一致 → no-op 报告已一致；源已变化 → 报错说明权威已在目标。

边界：不复制 .knit/.runtime（目标侧运行资料属任务13）；不产生任何 Git 提交；不启动模型；worktree 内任务资料为未提交状态，交付链路不变。

测试（隔离夹具：主检出含 task.md+plan.md+research/嵌套+未提交新文件+已跟踪删除+目录改名；worktree create 建目标）：a) 完整交接落位+回执+binding 切换+源跟踪副本保留；b) 未跟踪任务目录移入 transfers；c) 嵌套 research 与未跟踪文件转移；d) 删除项与改名在目标应用；e) 目标冲突：目标被本地修改→停止报告两边保留；f) 目标无同 ID→全新写入；g) 中断恢复：未完成 receipt+完好备份→续做完成；备份损坏→报错给恢复入口；h) 活动运行/未登记 worktree/归档任务拒绝；i) 目标无 .runtime 副本、无 Git 提交产生；j) 幂等 no-op 与源变化报错。全量 npm test 绿。

模型：deepseek 429 限流中，派发显式 --provider magpie --model auto/glm-5.3-flash。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施（run-42961dc5092c，已接收 implementation_accepted；模型 magpie/auto/glm-5.3-flash）：新增 src/application/worktree-handoff.ts（851 行：源快照至 .knit/.runtime/transfers/<opId>/source/ 含未跟踪/嵌套资料，manifest.json 记 relativePath/kind/sha256/mode+删除项；目标按 frontmatter id 定位同任务旧版本，与 git show <baseline>:path 基线核对——一致则应用源版本+删除项+目录改名，本地修改或来源不明→停止保留两边；逐项 sha256 重算核验完整后才算交接成功；receipt.json 步骤 journal+中断恢复：未完成 receipt 核对备份完好从断点续做、损坏报错给恢复入口；幂等 no-op/源已变化报错；源处置：无跟踪文件整目录移入 source-original/，混合保留报告）+ `knit worktree handoff` CLI + TaskBindingSchema.worktree 扩展 active/handoffAt/lastHandoffOp（binding.branch=worktree.branch 切换在此生效）。验证（self）：npm test 346/346 绿，新增 12 组用例覆盖冻结 a–j 全场景+可执行位/符号链接/目标 task.md 不可解析冲突。另发现并独立修复：任务9交付遗漏 src/adapters/rex/*、worker 模板及 5 个集成文件未入库致 HEAD 构建损坏，补交 c1e11a2（连带任务10改动 334 测试验证），本任务测试库 346。

### 交付记录

<!-- knit:delivery:op-ecef73210e25 -->
- 操作: op-ecef73210e25
- 时间: 2026-11-04T00:03:47.714Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: ec6484f7c2fb549981205573d1f4d648ef6132cf
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-worktree-task-material-handoff

<!-- knit:progress:end -->
