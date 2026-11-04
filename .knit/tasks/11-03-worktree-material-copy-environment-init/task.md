---
id: k-e48b7df14115
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:07.756Z
title: Worktree：公共资料白名单复制与环境初始化
---

需求冻结（主会话核对 WORKTREE.md §6.7/§6.2、DESIGN §13/678 行、任务10 create 与任务11 handoff 交付后决策）：

配置：`.knit/config.json` 新增 `worktree` 可选节（open obj，不升 schemaVersion）：`copy: opt(array(obj({path: str(), target: opt(str())})))`、`postCreate: opt(array(obj({name: opt(str()), command: str()})))`，默认空（无该节=无白名单无步骤）。

命令：`knit worktree prepare --task <id> [--rerun <stepName>]`。在 create/connect 与 handoff 之后执行；未登记 worktree binding 或任务归档→报错；持任务锁；仅主检出操作，目标为 binding.worktree.path。

白名单复制（逐项）：source 相对主项目根，target 默认同相对路径（显式 target 须仍在 worktree 内，路径越界拒绝）；记录来源/目标/基线指纹（git show <baseline>:path，baseline 取 binding.worktree.baseline）/源内容 sha256/处理结果。目标不存在或内容与基线一致→应用源快照（复制保留源文件）；目标与基线不同（本地修改）→停止报告；源为符号链接→停止报告；目录项递归展开、逐文件记录指纹，展开中遇符号链接停止。`.env` 等本机文件仅在显式列入时复制。全部复制完成且逐项 sha256 核验一致才进入下一步。

postCreate 步骤：按序以目标 worktree 为 cwd 执行（spawn shell 语义），每步执行前先落盘 journal（`--rerun <stepName>` 可显式重跑单步），记录 name/command/exit/stdout/stderr 截断；失败即停，保留目录、已复制资料与已成功步骤，报告失败步骤与恢复入口。

回执：manifest.json+journal 写 `.knit/.runtime/worktree-prepare/<opId>/`（taskId/opId/清单指纹/步骤结果/finishedAt）；全部成功后原子更新 binding：worktree.preparedAt、worktree.lastPrepareOp。

中断恢复与幂等：重跑同命令发现未完成 op → 核对已复制项（目标 sha256==manifest 源指纹）视为已完成跳过，未记录步骤继续执行；已成功步骤不盲目重跑（外部副作用按实际状态，重跑须 --rerun）；无可做工作时 no-op 报告已一致。导出 `worktreePrepareCurrent(binding)` 供执行前置检查复用（阶段启动拦截与路由在任务13接线）。

边界：不复制 .knit/.runtime 与凭据类默认内容；不产生 Git 提交；不改分支；失败不静默覆盖目标。

测试（隔离夹具：临时仓库+worktree create+config.worktree）：a) 完整 prepare：白名单复制+步骤执行+回执+binding.preparedAt；b) 目标被本地修改→停止保留两边；c) 目标不存在→复制落位；d) 符号链接条目→停止；e) target 越界（../）→拒绝；f) 未列入白名单的本机文件不复制；g) 步骤失败即停+journal 完整+已成功步骤保留；h) 中断恢复：未完成 op 续做，已复制/已成功跳过；--rerun 单步重跑；i) 幂等 no-op；j) 未登记 worktree/归档任务拒绝；k) 无 .runtime 复制、无 Git 提交产生；l) 目录白名单递归+逐文件指纹。全量 npm test 绿。

模型：deepseek 429，派发显式 --provider magpie --model auto/glm-5.3-flash。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施（run-e11eeeaeba69，已接收 implementation_accepted；模型 magpie/auto/glm-5.3-flash）：新增 src/application/worktree-prepare.ts（`knit worktree prepare`：白名单逐项 source/target 核对+基线/源 sha256 指纹+符号链接与路径越界拒绝+目标本地修改停止保留两边+journal 步骤落盘后执行+失败即停保留现场+--rerun 单步+中断续做跳过已复制/已成功项+幂等 no-op+空配置也落 preparedAt；.knit/.runtime 与 .git 白名单拒绝；worktreePrepareCurrent 供任务13前置检查）+ config.worktree 节（copy/postCreate，schema 归一缺省）+ TaskBindingSchema.worktree 扩展 preparedAt/lastPrepareOp。验证（self）：npm test 360/360 绿，14 组用例覆盖冻结 a–l 全场景+worktreePrepareCurrent+config schema。

过程记录（三次失败与修复，证据保留）：①run-1b3ca1e4f3a0 与 ②run-4dcba22815c8 均完成后死于 report_schema_invalid:/unverified expected array, got string——根因是 buildUserPrompt 实施阶段示例只给 {summary,changedPaths} 却在文字里要求写 unverified（check 示例才有数组形状）；修复 stage.ts 示例补 "unverified":["..."]（独立提交 b131db1，361 测试验证后推送）。②失败后 resume run-636d957135c1（原会话续跑）仍报同错；③resume 复用后改报 changed_paths_mismatch:zero_diff——恢复 run 的快照基线已含此前落盘成果，diff 为零，zero-diff 语义按设计拒绝；resume 只 prepare 不 start 亦为链路缺口（需手动 knit run start，本任务未改）。最终按干净基线全新派发 run-e11eeeaeba69 完成。备份：/tmp/knit-task12-backup（首次成果）、/tmp/knit-task12-run3（二次成果）。

### 交付记录

<!-- knit:delivery:op-1efad13cdb05 -->
- 操作: op-1efad13cdb05
- 时间: 2026-11-04T04:18:58.824Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: 02479029d1614c3b29a527264738b5c86d401313
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-worktree-material-copy-environment-init

<!-- knit:progress:end -->
