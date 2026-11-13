# 并行桥接任务导致独立检查接收失效（2026-11-13）

## 实际结果

新正式独立检查 run-8b454443fb55 的报告为 pass：52条coverage、41条scenarios、changedPaths=[]（检查者未改文件），报告未发现阻塞缺陷，并复验标准npm test 743/743。

主会话通过knit_status核对后，核心实际run状态为failed，failureReason为scope_changed；接收为needs_attention，未发布有效新检查凭据，不能把报告pass认定为已获准独立检查。

检查期间出现两条外部改动：`.pi/extensions/knit.ts`、`assets/templates/pi/extensions/knit.ts`。主会话未写这两条路径；Git diff显示它们是“本会话跟踪run完成后唤醒主会话”的实现。当前活跃任务k-b9ea41e9eec0（`.knit/tasks/11-13-bridge-notice-wake-watched-runs/task.md`）正在实现该功能；修改时间为2026-11-13 22:08:27本机时间，在检查期间。两条均属本P2既有成果范围，所以核心正确拒绝过期scope。

## 范围与权限

并行P1任务task.md第20行明确：用户授权主会话实施、independent/DeepSeek独立检查，但“授权不含 Git 提交、推送与真实 Pi 验收”。本P2既定范围也要求不提交其他任务及无关改动。

不能将并行P1的未提交修改合进本P2提交，也不能恢复/覆盖对方工作、伪造提交来源或跳过scope_changed。新的公开恢复入口要求可核验的提交来源，因此只有P1相关成果稳定且获得单独提交授权后，才能按其真实提交更新本P2相应scope，再获取新独立检查。

failed run在RunActivityService中已是收敛失败，不需要删除结果/操作或取消已结束执行；可保留本次检查报告和拒绝接收证据，再通过正常恢复与新check推进。

## 后续正规路径

1. 等并行P1执行结束并通过自己的独立检查；保持原执行者职责，不接管或修改其任务状态。
2. 如用户单独授权其本地提交，将P1产物按独立任务历史提交，不能混进本P2，不推送。
3. 用真实后续提交作为来源，在原仓库公开`task rebind --recover`复核本P2被更新的完整路径。
4. 对更新后的范围再发正式独立检查，接收通过后依既有授权完成本P2的close、策略重核、deliver与归档。

如果用户不授权P1提交，本P2保留业务成果已提交、当前检查未获准、尚未归档状态，等待具备真实提交来源。普通Terminal.app与Rex此前最终743/743结果保留，但不代表覆盖并行P1后续新增修改。
## 续接核对

用户选择“暂不授权P1提交”后，再次核对：HEAD仍为876dcefbdf8d73416cfedbd41169de300b698fad，没有新的真实提交来源；并行P1仍为open/implement、verification=independent。按scope.json的52条entries逐一读取实际文件并比较SHA-256，当前漂移增至3条：`.pi/extensions/knit.ts`、`assets/templates/pi/extensions/knit.ts`、`docs/design/DESIGN.md`。第三条的Git diff明确是桥接通知唤醒规则说明；另有P1改动`docs/design/ARCHITECTURE.md`，不属本P2当前52条scope。上述改动全部保留，没有覆盖或暂存、提交。

本P2继续等待受影响路径形成经授权的真实来源提交；不能使用旧检查报告、重复派发同样会失效的检查或把产物已提交当成已归档。用户当前没有授权提交P1，续接指令不改变这一明确选择。
