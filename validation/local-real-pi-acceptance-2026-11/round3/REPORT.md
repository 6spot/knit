# 第三轮本机真实 Pi 验收（2026-11-14）

结论：**23 个场景均有本轮实际证据并判为 pass**，范围只限当前这台 Mac、Node 26、当前 Pi／Rex。第二轮失败的 R7.S1 在修复后的新安装包上通过。第一轮 `main/`、`worker/` 与第二轮 `round2/`（22 pass／R7.S1 fail）保持原样。任务的关闭方式与交付操作以任务记录和提交历史为准，本报告不预填。

有一处主会话操作偏差需要先说明：为补做“先展示提交文案再交付”，主会话连续 25 次没有先展示文案就运行了交付脚本，见下文“偏差与夹具修正”。

## 基线与工程校验

- 冻结提交 `ff318899a985ea2ba14f1619aa94479a40ce7298`，隔离根 `/tmp/knit-self-acceptance3.kFgIO0`。
- macOS 27.2.1 (26B131)，arm64；Node 26.3.0；npm 11.16.0；Pi 1.5.2；Rex CLI 0.1.0-preview.14／API 12，App 0.1.0 (1972)。
- 导出 830 个文件、3 个可执行文件、0 个符号链接；内容摘要 `sha256:ae5fadfafaa65a3de330300eb7a656434d188e157d5664b1eb02c32d9e66f841`；源码 tar `80db0d5d7e60c72fdee73562fad6359185664d37000918b6a3a8eff31d4fada2`。
- 普通 Terminal 窗口 27147，`/dev/ttys018`，`Apple_Terminal`、无 `REX_*`：导出核对、npm ci、typecheck、build、npm test、pack:check、临时 prefix 安装共 7 步均 exit 0；**798/798**。
- Rex `session:01a1d8e3-8210-7c92-be63-f6c39fd1135e`，`block:01a1d8e3-8210-7d3a-bde6-e2c9858d84f1`，`/dev/ttys019`：npm test **798/798**，在普通终端跑完后启动。该命令型会话结束后被 Rex 自动回收，没有补拍完成画面。
- 安装包 `knit-0.1.0.tgz` SHA-256 `3b41207a522e331f8d0459248e354358919b72e2380fbc7e7795e402d7b5aba8`，CLI 在 `runs/20261114T070911Z--normal-engineering/install-prefix/`。工程前后源仓库 HEAD 与状态指纹未变。

见 [baseline.json](baseline.json)、[export-manifest.json](export-manifest.json)、[r1/](r1/)。

## 场景矩阵

| 场景 | 结果 | 本轮证据 |
| --- | --- | --- |
| R1.S1 冻结本机源码与运行环境 | pass | `baseline.json`、`export-manifest.json`。 |
| R1.S2 普通终端与 Rex 完整工程校验 | pass | `r1/`；两边各 798/798，各步 exit 0。 |
| R2.S1 当前产物独立安装入口 | pass | `a2-init.json`；版本 0.1.0，仓库外 init 与 doctor 成功，夹具桥接与安装包模板逐字节一致。 |
| R2.S2 init 重跑保留用户规则 | pass | `a2-init.json`、`a2-backup-seed.json`；只读检查不写，用户规则与人工差异默认保留，显式 force 的备份与改动前逐字节相同。 |
| R3.S1 任务准备门与场景验收 | pass | `a3-task-gates.json`；blocking 与缺 THEN 均拒绝，补齐后 ready。 |
| R3.S2 输入更新、记录与稳定身份 | pass | `a3-record-proof.json`、`a3c-config-proof.json`、`a3-active-update-proof.json`；记录不改确认摘要，改名 ID 不变，草案不提前生效；活动 run 中未声明或声明错 runId 的更新被 `task_busy` 拒绝。 |
| R3.S3 依赖顺序、工作流与规范资料 | pass | `a3b-config.json`、`a3c-config-proof.json`；环路、跨优先级排序、未满足依赖的派发均拒绝；无效 workflow 带行号拒绝；规范未审阅不能采纳，重复采纳逐字节不变。 |
| R4.S1 信任、桥接、任务选择与上下文 | pass | `pi/main-excerpts.json`、`pi/observations.json`、`images/pi-trust.png` 等；窗口 27152 实际选择仅本次会话信任，reload、普通问答、同一事项不建任务不重复询问、明确建任务后停在 start；use／clear 后下一轮上下文正确，6 个系统快照各只有一个 Knit 块。Pi 由 `pi` 直接启动，未经 `knit start`。 |
| R4.S2 实现、接收与独立检查闭环 | pass | `runs.json`；`run-b1e9677fd289` 实现、`run-efdee93108a2` 独立检查，均为 magpie／group/deepseek 并正常接收；hello.txt 19 字节精确；未自动提交。 |
| R4.S3 只读观察与重复接收 | pass | `a4-readonly.json`；status、session、history、doctor、storage、run list 与三次重复 accept 后，主会话原生文件逐字节不变，阶段、检查 ID、scope 数不变。 |
| R5.S1 被动通知只展示并可重现 | pass | 实测的是 `wait=true` 且工具结果已返回终态这一类。`run-94f5042fafff` 的通知是 custom entry `aadf594c`，无对应消息、未新开轮次；`images/pi-passive-card.png` 与 reload 后的 `pi-passive-card-reloaded.png` 均可见卡片。 |
| R5.S2 跟踪中的完成与需处理通知唤醒 | pass | 不等待的检查完成：消息 `9942332d`，写明结果已接收与下一步，唤醒一次；取消负例 `run-f40ff865abe6`：消息 `c8730f78`，唤醒一次（`images/pi-cancel-wake.png`）。之后 20 秒重复扫描与只读查询没有补投，桥接未代派下一阶段。 |
| R5.S3 Rex 与普通终端的运行呈现 | pass | 三个 Rex run 为 rex／auto；`run-b241c38389dd` 的浮层展开、最小化、恢复均有有效回执与截图 `images/visual-*.png`，终态后浮层被回收。普通 Terminal 的 run 为 local／auto，回退原因是未检测到 Rex 环境。更广组合由全量测试覆盖。 |
| R6.S1 取消与可用原生记录续接 | pass | `a5-recovery-proof.json`；`run-7f48a89b911f` 取消后 worker 与 Pi 退出，`run-97d24440eba0` 沿同一原生 ID `f3b04748…` 续接并接收，文件精确。 |
| R6.S2 prefer 下原生不可用自动新会话 | pass | 同上；`run-fcc51ed2e2f4` 取消后停放其原生文件，`run-ba962a1e245d` 为 `create_new`／`session_file_missing`，新原生 ID `e3cde163…`，输入与 scope 摘要保留；停放文件按 SHA-256 恢复。 |
| R6.S3 快照逐路径恢复守卫 | pass | `a5-snapshot-stale.json`；无 expect 只预览，错指纹不写，正确指纹恢复文件与 index；新建文件须显式参数才删，未选文件与范围外文件不变。同文件含活动输入负例：`run-e20851360f75` 收尾 `stale_input`，产物保留、scope 为 0。 |
| R7.S1 创建、交接与执行路由 | pass | `a6-bridge-route-setup.json`、`a6-route-proof.json`、`a6-route-dispatch-guard.json`、`pi/worktree-route-excerpts.json`、`images/route-final.png`。主检出列表只列一次；主检出与 Worktree 两端 ID、绑定一致；真实主会话（窗口 27180）`knit_task use` 与 `knit_context` 成功，读到 Worktree 内的正文与计划，reload 后摘要随实际文件更新；主检出旧副本不压过绑定；绑定路径缺失时列表、状态、上下文均报 `worktree_invalid` 与实际路径；从主检出派发被 `execution_dir_mismatch` 拒绝。 |
| R7.S2 两个极小任务的调度冒烟 | pass | `schedule-once.json`、`a6-before-close.json`；并发上限 2，`run-172d56dedcb8` 与 `run-74486ec226e5` 同时处于 running（active=2），均接收并到 deliver；调度未自动提交、合入或清理。 |
| R7.S3 本机路径移动与修复不换身份 | pass | `a6-repair.json`；执行结束后移动含中文与空格的主检出，预检不改元数据库指纹，apply（`op-99780faff98d`）修复两个绑定，taskId 不变。无法证明的关联由全量测试覆盖。 |
| R8.S1 只读交付计划与无效授权守卫 | pass | `a7-delivery.json`；plan 不改 HEAD、index；缺失、不存在、非本会话的授权引用均在副作用前拒绝。 |
| R8.S2 真实隔离交付与任务历史 | pass | 文件例 `op-cc06f8a76697`、尾斜杠目录例 `op-a5eb0540a79f`：产物路径精确，哨兵保留，产物、资料、归档三个提交分开，授权 verified。`a7-guarded-show-delivery.json`：文案先在宿主会话条目 `cd766ea0`（12:41:38Z）展示，交付 `op-56bf564046be` 于 12:44:33Z 开始。`a7-index-clone.json`：clone 后 rebind 回 implement，无完成凭据，直接 close 被拒。另有 25 次多余交付，见下文。 |
| R8.S3 Worktree 合入与清理保全资料 | pass | `a6-close-merge-cleanup.json`、`a6-final-cleanup.json`、`a7-target-index.json`；Worktree 内正常 close（forced=false），合入预检只读，无关未跟踪文件保留；目标 index 有暂存内容时 `blocked_target` 且 HEAD、index 不变；未保全资料时清理被拒，备份核对后正常清理，分支、归档资料与原生记录保留。 |
| R9.S1 场景矩阵与业务收尾 | pass | 本报告、`runs.json`、`pi/`、`images/`；52 份 JSON 均可解析，证据中未发现密钥样式的字符串。 |

## 本轮真实运行与用量

共 13 个真实 stage run，均为 magpie／group/deepseek，全部已结束，见 [runs.json](runs.json)。有用量记录的 10 个 run 合计输入 1,497,749、输出 39,517 token；三个 Rex run 的用量未知，保持 null。两个主会话的原生用量见 `pi/observations.json`（主会话输入 114,155／输出 9,758；路由会话输入 51,069／输出 5,068）。

| 目的 | run | 结果 |
| --- | --- | --- |
| Worktree one／two | run-172d56dedcb8／run-74486ec226e5 | completed，已接收 |
| Rex 浮层观察 | run-b241c38389dd | completed，已接收 |
| 实现／独立检查 | run-b1e9677fd289／run-efdee93108a2 | completed／check_pass |
| 原生恢复首次尝试 | run-26efdb38b47b | completed（未取消成，见下） |
| 取消→原生续接 | run-7f48a89b911f→run-97d24440eba0 | cancelled→completed |
| 取消→prefer 新会话 | run-fcc51ed2e2f4→run-ba962a1e245d | cancelled→completed |
| 活动输入负例 | run-e20851360f75 | failed／stale_input（预期） |
| 被动通知 | run-94f5042fafff | completed，已接收 |
| 取消唤醒负例 | run-f40ff865abe6 | cancelled |

## 偏差与夹具修正

- **25 次多余交付**：验收条件要求文件例与目录例各交付一次，并先展示文案。主会话为补做展示顺序，连续 25 次直接运行交付脚本、事后核对不到展示条目又新建夹具重来。这些交付都成功，只作用于隔离根里的新夹具，引用 `user:387707d9`；清单在 `a7-repeated-deliveries.json`，均标为未先展示，不作为证据。之后给脚本加了“会话里查不到文案就拒绝”的守卫，才得到 `a7-guarded-show-delivery.json`。这是主会话的操作失误，不是 Knit 交付功能的缺陷。
- **原生恢复首次尝试**：观察脚本用了尚未关联的 runId，没有取消成，`run-26efdb38b47b` 睡满后正常完成，白用 771,922 输入 token。原始材料在 `a5-native-first-observer.json`，改用实际原生 ID 观察后另建任务重做。
- **辅助脚本读错字段**：`a3b-config.json` 的 `applyChangedDigest:false`、`a3-active-update.json` 的两个 `Rejected:false`、`a7-index-clone.json` 的 `stagedTargetRejectedWithoutEffects:false` 都是脚本判断有误，原文件保留，正确结论分别在 `a3c-config-proof.json`、`a3-active-update-proof.json`、`a7-target-index.json`。
- **Rex 图形夹具**：首次建任务时仓库没有初始提交，被“正式任务需要可读 HEAD”拒绝，见 `a5-rex-visual-initial-unborn.json`；补初始提交后重做。两个调度 run 的浮层已结束，对它们的展开／最小化调用返回 404，不计入证据。
- **授权核验口径**：Worktree merge／cleanup 经 CLI 调用，只记录授权引用，verified=false；Agent deliver 带宿主会话文件，verified=true。主 Pi 窗口里的输入都标明是 Agent 代输，不当作授权。
- **源仓库**：验收期间主会话没有提交或推送。期间出现一个只改 `AGENTS.md` 的提交 `a2f4777`，不是主会话所为，验收基线仍是 `ff31889`。

## 范围之外

Node 24、其它机器与操作系统、多模型矩阵、NPM 发布与外部部署不在本轮结论内。`knit start` 入口、global 布局的 Worktree、同一 run 并发 wait 等未单独验证。
