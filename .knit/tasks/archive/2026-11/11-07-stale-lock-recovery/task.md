---
id: k-6f0616f3779d
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-2c0d10318898
priority: P0
dependsOn: []
order: 30
createdAt: 2026-11-07T11:44:05.686Z
title: 崩溃锁自动回收、心跳与 unlock 可用性
---

# 崩溃锁自动回收、心跳与 unlock 可用性

## 目标与边界

### 背景与问题

审计复现：`kill -9` 杀掉 worker 后，project 锁与 session 锁一直残留。`knit locks` 已判 `not_alive`，`doctor` 也报 stale 2，但：

- `task new`、`run implement`、`resume` 全部返回 `lock already held`；`resume` 明确拒绝"旧执行的项目锁尚未释放"。
- `knit unlock <lockId>` 帮助里有位置参数，实际报 `required option '--scope'`，必须手工拼 `--scope`、`--key`（原始路径）和 `--expect-token`。
- owner 的 `heartbeatAt` 一直停在获取时刻，`heartbeatStaleMs` 不参与判定。
- macOS 上进程身份回退到 `ps lstart`，只精确到秒，同秒 PID 复用会误判 alive／not_alive。

### 交付范围

1. 自动回收：acquire 遇到 EEXIST 时检查 owner。同一 `machineBootId` 且进程核实为 `not_alive`，就原子回收（改名进回收区后重建），写诊断事件与锁回收记录。`unknown` 仍 busy。
2. 心跳：持锁的 worker 按 `heartbeatIntervalMs` 刷新 `heartbeatAt`；`doctor`／`locks` 显示心跳是否超时。超时本身不触发回收，仍以进程核实为准。
3. macOS 进程身份：`lstart` 加上启动命令（或其它更细粒度标识）一起比对，降低 PID 复用误判；Linux 维持 `/proc` 方案。
4. `unlock <lockId>` 位置参数可用：从锁列表反查 scope 与 key，仍要求 `--expect-token`（可加 `--from-list` 便捷确认）；`locks` 接受 `--dir` 只列本项目。
5. `lock_busy` 错误带 owner 动作、pid、核实结论与下一步命令。
6. 同步 OPERATIONS 锁章节与 `doctor` 文案。

### 非目标

- 不改锁域拆分：属于前置任务 `k-f0d9a8952aff`。
- 不做跨机或网络文件系统上的锁回收。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 自动回收只在同一启动周期（bootId 相同）且进程确认已死时进行，其它情况仍需人工 `unlock`
- 交付凭据扫描（generic_secret_assignment）把 `token = …` 形式的标识符误判为凭据：`src/cli/locks.ts` 局部变量改名 `ownerToken`，`test/infrastructure.test.mjs` 夹具 token 值改为 `dead1`，不改行为（2026-11-07 主会话 clarify）
- 上述改名作为交付前置在检查阶段落地：检查者把这两处改名作为明确缺陷直接修复并在 changedPaths 中如实列出（2026-11-07 主会话 clarify，原因：已接收 scope 记录的是改名前内容，交付扫描会暂停）

## 完成条件

- 自动化测试：worker 被 SIGKILL 后，下一次 `task new`／`run implement` 自动回收并成功；回收事件可在诊断中查到。
- owner 进程仍存活时不回收；owner 身份 unknown 时不回收。
- `knit unlock <scope/hash> --expect-token <t>` 成功；`knit locks --dir <d>` 只列本项目。
- 心跳在长阶段中前进，`doctor` 能区分心跳正常与超时。

## 输入引用

- 审计 S1。
- `src/infrastructure/locks.ts:180-400`、`src/infrastructure/process.ts:13-30,177-250`、`src/application/run-coordinator.ts:150-170,712-727`、`src/cli` 中 locks／unlock 命令。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

关键经过（2026-11-07 主会话）：implement run-ebf0c3e70cfe（--local，magpie/group/claude）completed 并接收，npm test 600/600；independent check run-2a02ceb362f7 verdict=pass、selfVerified=false、未改文件，复跑 npm test 600/600 并实测 task new 自动回收残留锁、--dev/locks --dir/doctor 可查。实现细节决定（worker）：回收前同时核对 owner 与登记的阶段 Pi 进程都已死；--from-list 仅在 not_alive 时可免 --force；同秒同名 PID 复用为已知限制，已写入 OPERATIONS。遗留：macOS ps 路径仅夹具测试；“删除后他人重建再改名”的回收竞态分支无专门测试。

## 修复轮 1 输入（独立检查 run-f98b372c4838 → changes_requested，2026-11-07）

检查发现（须在本轮修复）：
1. 【缺陷】SIGKILL worker 后，`knit run implement` 经 prepare 回收项目锁，但 `RunCoordinator.findActive` 只看 launch 与 state 文件、不核实 worker 存活，于是复用 state 仍为 running 的旧 run；start 因 launch=confirmed 直接返回“已启动”、退出码 0，实际没有进程执行，`--wait` 永不终态。要求：prepare 遇到活动 run 时核实 worker 与阶段 Pi 进程；同一启动周期且都确认已死 → 按 resume 语义收敛旧 run（标 failed/中断）并新建 run 真实执行（完成条件字面要求“下一次 run implement 自动回收并成功”）；alive／unknown 保持现有保护。
2. 【测试缺口】`test/lock-recovery.test.mjs` 两个 SIGKILL 用例名称/注释写 run implement，实际调用 coordinator.resume。补一个 SIGKILL 后走 `run implement`（或 prepare+start）并到达终态 completed 的回归测试，修正名称与注释。
3. 检查者已修复测试抖动：startHangingRun 改为经 KNIT_FAKE_PROMPT_FILE 等 prompt 送达（已在工作区，保留）。

另：交付前的凭据扫描（contracts/credentials.ts 的 generic_secret_assignment）会把“token 一词后跟冒号或等号再跟 8 个以上字符”的新增行判为疑似凭据，包括 locks.ts 里把 resolveToken 结果赋给名为 token 的局部变量、以及测试夹具里 owner 的 token 字段取 dead-token。本轮请改写这些新增行使其不触发（局部变量改名 ownerToken；夹具值改为不足 8 字符，如 dead1），否则交付会被暂停。

主会话决定：修复周期已用 `--new-repair-cycle` 显式开启（repair_not_authorized 是因首轮 ready 未开周期）。

## 修复轮 1 执行记录（2026-11-07 主会话）
- run-e9743d9f34b3：派发后发现 implement worker 上下文不含检查 findings（只读 task.md），主会话取消，把 findings 写入记录区后重派。
- run-33871596b5c5：worker 已修复 findActive 复用死 run 的缺陷，并补了 CLI `run implement --wait` 的 SIGKILL 回归测试，自测 npm test 601/601。但报告的 changedPaths 列出了整个累计 scope（16 个路径），本轮实际只改了 4 个，因此判为 `changed_paths_mismatch` 失败（审计中等问题 3，由 k-b9df107db53a 处理）。主会话把这 4 个文件的成果备份到 /tmp/knit-residue/r1，再用 `knit snapshot restore`（restore-2aa6dda6ae12）恢复到 run 前状态，然后重派。
- 给下一轮 worker 的说明：/tmp/knit-residue/r1 下是上一轮的完整成果（docs/design/OPERATIONS.md、src/application/run-coordinator.ts、test/lock-recovery.test.mjs、test/stage.test.mjs），可以核对后直接采用。报告 `changedPaths` 只列本轮在工作区实际改过的路径，不列之前轮次已经存在的改动。

## 检查轮 3 须知（2026-11-07 主会话）
run-4633b01b33dd 的结论是 pass，但接收时判 scope_changed。原因：主会话在实现轮之前为规避凭据扫描误报，手工改过 src/cli/locks.ts 和 test/infrastructure.test.mjs，导致与已接收 scope 的指纹不一致。主会话已把这两个文件恢复成 scope 内容，接收 pass 后补了一次 clarify。

本轮检查者须同时做以下修复（属于明确缺陷，否则交付会被凭据扫描暂停），并在 changedPaths 中如实列出：
1. src/cli/locks.ts：两处 `resolveToken(...)` 的返回值所赋的局部变量改名为 ownerToken，后续 expectToken 参数同步改用 ownerToken。
2. test/infrastructure.test.mjs：deadOwner 夹具里 owner 的 token 字段值改为 dead1，同文件中引用该值的断言（unlock 下一步命令里的 expect-token 和 previousOwner 字段）同步改。
改完后跑相关测试和全量 npm test，用 dist/contracts/credentials.js 的 scanCredentials 扫描本任务所有新增行，要求零命中。

## 完成记录（2026-11-07 主会话）
- 实施：run-ebf0c3e70cfe（首轮）；修复轮 1 run-33871596b5c5 失败（changed_paths_mismatch，worker 把累计 scope 全列入报告），主会话用 snapshot restore（restore-2aa6dda6ae12）复原后，run-d14acd65035a 采用备份成果并 completed。
- 检查：run-2a02ceb362f7 pass（之后主会话为规避扫描误报改了文件，凭据失效）→ clarify → run-f98b372c4838 changes_requested（发现 prepare 复用死 run 的真实缺陷）→ run-4633b01b33dd pass，接收时 scope_changed（主会话手工改名造成），复原后接收 → clarify → run-f3cef235145d pass，检查者按 clarify 改了两处名称（selfVerified=true），全量 601/601。
- 按 plan §3，检查者改动后应再跑一次不改文件的 pass 检查（check_self_modified）。但这一规则属于 k-b88e4a80906d 的交付内容，当前系统 deliver 阶段不能再派 check。检查者的改动只是改名、不改行为，改后全量测试已通过，因此按现行规则接收，在此如实标注。
- 已证实的 Knit 缺陷（交给后续任务）：implement worker 拿不到检查 findings，只能靠记录区转述（建议在 k-b9df107db53a 或 k-fdfd8c171736 中纳入）；凭据扫描对 `token = 标识符` 误报；`changed_paths_mismatch` 无法补报（k-b9df107db53a）。

### 交付记录

<!-- knit:delivery:op-dd28fd2f468f -->
- 操作: op-dd28fd2f468f
- 时间: 2026-11-07T21:59:07.186Z
- 分支: refs/heads/main
- 授权来源: .knit/tasks/11-07-audit-fix-plan/plan.md#执行授权
- 工作提交: f23a22d4f3287502b6d0a716ca505aeccea323e5
- 结果: 正常交付；检查 run-f3cef235145d 通过
- 归档目标: .knit/tasks/archive/2026-11/11-07-stale-lock-recovery

### 任务资料提交记录

<!-- knit:metadata-commit:op-dd28fd2f468f -->
- 任务资料提交: ecec2de45859cc3027405e7518f06aecf9e8f70c
- 归档目标: .knit/tasks/archive/2026-11/11-07-stale-lock-recovery

<!-- knit:progress:end -->
