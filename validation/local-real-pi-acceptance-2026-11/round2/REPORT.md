# 第二轮本机真实 Pi 验收（2026-11-14）

结论：**22 个场景 pass，R7.S1 fail；本轮整体未通过，k-b9019179b424 保持 open，不生成完成凭据或强制关闭。** 修复任务为 k-3a7f2483b0d8，修复后另取基线复验，本报告保留第二轮原结果。

## 基线与工程校验

- 本地 main `2a2f6a0af69457d10bab18443a327261576dd434`，隔离根 `/tmp/knit-self-acceptance2.JyPWM8`。
- macOS 27.2.1 (26B131)，arm64；Node 26.3.0；npm 11.16.0；Pi 1.5.2；Rex CLI preview.14 / API 12。
- 导出 828 个文件、3 个可执行文件。内容摘要 `sha256:69a03479f6b554987d033a9b2e55785fdd27c5f6ad769098b836b2d0da25cbf3`；源码 tar SHA-256 `31849415a39873c4bc0ed0b2b2ab525dd1c218f256751c6c229266876a4e52cb`。
- 普通 Terminal 窗口 26766，`/dev/ttys002`，真实 `Apple_Terminal`、无 `REX_*`：typecheck、build、npm test、pack:check、带临时 prefix 的 pack:install 均 exit 0；**782 tests / 782 pass / 0 fail**。
- Rex session `session:01a1d764-9166-7ad9-9699-a39ca617c291`，block `block:01a1d764-9166-7b90-8148-cca9870e0e1e`，`/dev/ttys008`：npm test **782/782**；两次测试先后执行。两份源码导出摘要相同，运行前后当前仓库 HEAD/status 指纹未变。
- tarball SHA-256 `27f41ec8138677ac387b474b11c118d39139a2ac2a34d08e364197a1cb3170a0`，临时安装 CLI 位于 `runs/20261114T000949Z--normal-engineering/install-prefix/`。
- 工程阶段 Rex App 为 build 1970，功能目视阶段连接已变为 build 1972；CLI/API 版本未变。此版本变化如实保留，不宣称固定 App build 的整套认证。

见 [baseline.json](baseline.json)、[r1/normal-engineering/result.json](r1/normal-engineering/result.json)、[r1/rex-tests/result.json](r1/rex-tests/result.json)。原始日志留在隔离根，各命令、退出码、用例总数由真实日志生成，没有沿用旧结果。

## 场景矩阵

| 场景 | 结果 | 本轮证据及结论 |
| --- | --- | --- |
| R1.S1 冻结本机源码与运行环境 | pass | `baseline.json`、`export-manifest.json`；新基线、版本、入口与导出指纹已核对。 |
| R1.S2 普通终端与 Rex 完整工程校验 | pass | `r1/`；两次 npm test 均 782/782，工程各步和临时 prefix 安装 exit 0。 |
| R2.S1 当前产物独立安装入口 | pass | `a2-init.json`；安装 CLI、doctor、生成桥接与本轮包路径一致；包版 0.1.0。 |
| R2.S2 init 重跑保留用户规则 | pass | `a2-init.json`、`a2-backup-seed.json`；只读检查不写，用户规则和默认人工差异保留，显式 force 的资料备份逐字节相同；未装项目依赖、未启动模型或自动提交。 |
| R3.S1 任务准备门与场景验收 | pass | `a3-task-gates.json`；blocking 和缺 THEN 均拒绝，补齐后 ready 成功。 |
| R3.S2 输入更新、记录与稳定身份 | pass | `a3-record-proof.json`、`a3c-config.json`、`a3-active-update.json`、`a5-snapshot-stale.json`；记录前后确认摘要相同，改名 ID 不变，pending 不提前生效；真实活动 run 的无/错 runId 更新拒绝，声明正确 runId 后收尾 `stale_input`，产物保留、scope 仍 0。 |
| R3.S3 依赖顺序、工作流与规范资料 | pass | `a3b-config.json`、`a3d-standards.json`；依赖、环路拒绝、优先级、稳定业务顺序、父子、查询已实测；无效 workflow 带行号拒绝；候选审阅与采纳有回执，重复 apply 幂等。 |
| R4.S1 信任、桥接、任务选择与上下文 | pass | `pi/main-excerpts.json`、`pi/observations.json` 与 `images/pi-*`；真实 session-only 信任、reload、普通问答、新事项不建/建任务均观察；use/clear 后下一轮上下文正确，每个系统快照仅一个 Knit 块。此场景的常规主检出任务与 R7.S1 的 Worktree 任务区分。 |
| R4.S2 真实实现、接收与独立检查闭环 | pass | `runs.json`；`run-7899bf1d5f02` 实现、`run-4409b487228d` 独立检查，均真实 magpie/group/deepseek 并正常接收；hello.txt 19 字节精确，检查 pass。 |
| R4.S3 只读观察与重复接收 | pass | `a4-readonly.json`；status/session/history/doctor/storage 和重复 accept 不新增主会话原生消息，不推进阶段或改变检查 ID；用量按真实结果记录。 |
| R5.S1 被动通知只展示并可重现 | pass | `pi/main-excerpts.json` entry a135796b；wait=true 返回终态后是带文案的 custom `knit.notice`，无对应 custom_message、无额外模型轮次，reload 后卡片可见。`images/pi-14-*`、`pi-15-*`。覆盖的是 wait 已返回终态这类被动来源。 |
| R5.S2 跟踪完成与需处理通知唤醒 | pass | `pi/main-excerpts.json`；检查完成通知 entry 9a69741f 与取消通知 3b0842f1 各出现一次，各触发一次后续助手回复。重复观察未重复投递；文案有任务级下一步；仅通知，不代为派下一阶段。 |
| R5.S3 Rex 与普通终端运行呈现 | pass | 两个 Worktree 真实 run 为 rex/auto；`images/rex-02-expanded.png`、`rex-03-minimized.png` 实际展开、收起、恢复；终态后浮层被回收。普通 Terminal 的实现/检查为 local/auto，回退原因是无 Rex 环境。 |
| R6.S1 取消与原生记录续接 | pass | `a5-native-cancel.json`、`a4-readonly.json`、`a5-recovery-final.json`；run-a8d7a932f973 cancelled，Pi/worker 退出后 resume 为 run-905da5e67b25，沿同一原生 ID 427aa1f8… 完成 native.txt。 |
| R6.S2 prefer 原生不可用自动新会话 | pass | `a5-fresh-resume.json`、`a5-recovery-final.json`；旧执行终止后只停放该夹具自己的原生文件；核心结果明确 `resumeAction=create_new`、`resumeReason=session_file_missing`，新 native ID aca501c6…，request.recovery 保留旧 ID 8e88a243…，正常接收；旧文件按 SHA-256 恢复。 |
| R6.S3 快照逐路径恢复守卫 | pass | `a5-snapshot-stale.json`；show/无 expect 只预览，错 expect 不写，完整指纹恢复 AGENTS.md 与 index；新建文件无 remove-created 保留，显式参数才删除，未选文件保留。 |
| R7.S1 创建、交接与执行路由 | **fail** | 创建、交接、阶段执行、task close 已通过；但迁出正文后主检出普通 status 找不到任务，task list 隐藏活跃任务。真实 Pi 主桥接 knit_task use、knit_context 均返回“任务不存在”。`a6-bridge-route-setup.json`、`pi/worktree-route-excerpts.json`、`images/pi-wt-route-failure.png`。不能用专用 worktree status 查询成功掩盖主桥接无法继续。 |
| R7.S2 两个极小任务调度冒烟 | pass | `a6-setup.json`、`runs.json`、`a6-close-merge-cleanup.json`；最多并发 2 的调度分别派发两个真实阶段，均正常接收至 deliver；调度未自动提交/合入/清理。第一轮调度自动生成 ignore 规则后第二任务被 dirty_source 拦住；按夹具补交 ignore 规则后再次调度成功，因此实测未同时占用两个活跃执行槽，不声称实测了并行重叠排列。 |
| R7.S3 本机路径移动与修复 | pass | `a6-repair.json`；自有执行结束后移动带中文/空格的主检出和 Worktree，repair 预检保持元数据库指纹不变，apply 修复两个绑定和 Git 关联；taskId/执行路径可核对。 |
| R8.S1 交付计划与无效授权守卫 | pass | `a7-delivery.json`；两种夹具的 plan 不改 HEAD/index；Agent 缺失、不存在及非本会话 user 引用均在副作用前拒绝；有效交付引用 user:387707d9，verified=true。 |
| R8.S2 真实隔离交付与历史 | pass | 文件例 op-82f28c4280f2、尾 slash 目录例 op-f17e9b580738 均 completed，产物路径精确、哨兵保留、资料和归档独立提交。`a7-index-clone.json` 中 clone 后 rebind 回 implement，无源机完成凭据，直接 close 被拒绝。 |
| R8.S3 Worktree 合入与清理 | pass | `a6-close-merge-cleanup.json`、`a6-final-cleanup.json`、`a7-target-index.json`；显式 merge/cleanup 只作用于夹具。暂存目标 index 时拒绝且 HEAD/index 不变；移除夹具暂存改动后成功合入。未保全资料时拒绝，核对与备份重复任务资料后正常清理；分支、归档任务和原生引用保留。 |
| R9.S1 场景矩阵与业务收尾 | pass | 本报告、runs.json、原始证据齐备；R7.S1 如实 fail，验收任务保持 open，未写完成凭据、未 force、未提交当前仓库的本轮证据。该行表示报告及失败处理符合要求，不表示整体通过。 |

## 本轮真实运行与用量

共 9 个真实 stage run，均使用 magpie/group/deepseek。详见 [runs.json](runs.json)。两个 Rex run 的 token 用量为未知（null），没有填成零。主会话自身另有真实 Pi 交互，原生 usage 留在 `pi/main-excerpts.json` 与 `pi/worktree-route-excerpts.json`；不伪造总消耗或费用。

| 目的 | run | 结果 |
| --- | --- | --- |
| 实现 | run-7899bf1d5f02 | completed / implementation_accepted |
| 独立检查 | run-4409b487228d | completed / check_pass |
| 取消 | run-a8d7a932f973 | cancelled |
| 原生续接 | run-905da5e67b25 | completed / implementation_accepted |
| 原生不可用准备 | run-f8f166ff17fd | cancelled |
| prefer 新会话 | run-1226fdb9f4fa | completed / implementation_accepted |
| 输入变更负例 | run-4a811e568cf9 | failed / acceptance_stale_input（预期拒绝） |
| Worktree one | run-a7e494c1c7c6 | completed / implementation_accepted |
| Worktree two | run-a2e1ae56d032 | completed / implementation_accepted |

## 失败复现与后续修复

保留的夹具：`/tmp/knit-self-acceptance2.JyPWM8/projects/目标 index 与 clone`。真实主会话窗口 27094、native session `01a1d867-3251-71d0-8810-6f99ff7bb1c5`；任务 `k-d7b23bf7c326` 已 create → handoff → prepare。

- 主检出 `worktree status --task k-d7b23bf7c326` 正确给出活跃 Worktree。
- 同一任务在实际 Worktree 内 `status` 成功。
- 主检出 `status <taskId>`、真实桥接 `knit_task use`、`knit_context` 均报任务不存在；task list 不显示该活跃任务。
- `SessionService.assertTaskUsable` 与 `ContextPlanner` 从传入根定位 task.md，没有按活跃绑定选择 executionDir；任务列表也只枚举主检出正文。历史任务 k-1910551e4f50 已记录过普通 status 完整视图的未覆盖边界；本轮发现它实际影响主桥接选择/上下文，不能以“当时已完成”推定本轮通过。
- 修复任务 k-3a7f2483b0d8 将补齐主检出的任务定位与选择/上下文读取；维持 mainRoot 保存运行资料、executionDir 保存任务正文，失效绑定不回退，不更改 run 派发的执行目录守卫。

## 证据边界与夹具修正

- 第一轮 worker/、main/ 证据未改写；工程脚本原样复用，环境变量指向新基线。
- 第一个 Terminal 新窗口继承 REX_*，脚本守卫拒绝。没有 unset 冒充普通终端；经 Finder 重新启动真实 Terminal 后，新窗口环境无这些变量。详见 baseline.json 的 notes。
- 初始辅助脚本用了过时 record/rename 参数、错误 JSON 字段以及不存在的规范目标。原始拒绝结果保留；随后按实际 --help/响应修正并重测。不会把这些辅助脚本错误当产品缺陷，也不依赖其错误布尔值作为通过证据。
- 无关未跟踪哨兵不会阻挡合入。真正的 dirty-target 负例采用已暂存的 AGENTS.md，见 a7-target-index.json；首次 prepare 未 create 的辅助测试只作 clone 边界证据，不作 Worktree 合入负例通过证据。
- prefer 新会话的 worker 没有看到外层取消/停放操作，曾自报恢复“未验证”；主会话保留其报告，并按核心 result.session 中明确的 create_new/session_file_missing、新旧 request/native、实际文件指纹来判定外层恢复场景。
- 清理前守卫拒绝剩余任务副本；主会话核对主检出归档已存在，逐字节备份这些自有夹具副本后移除，再走正常 cleanup，没有 force 或改凭据/checkpoint。
- Worktree merge/cleanup CLI 只记录 caller=cli 的授权引用，不能核验本会话原生消息，故保留 verified=false；它们不冒充 Agent 已核对授权。Agent deliver 的授权核验为真实 verified=true。
- 当前工程源代码、两份桥接、全局安装/配置/鉴权资料未因验收而修改；仅保留任务与 validation 证据。已有 3 个本地提交仍未推送；本轮没有新增当前项目 Git 提交。

尚不能宣布整机本机自用通过。R7.S1 修复后需要新基线复验；Node 24、其它 OS、多机、发布与外部部署不在本轮结论内。
