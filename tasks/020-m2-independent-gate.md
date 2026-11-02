# 020 独立检查真实项目使用门槛

- 里程碑：M2
- 执行角色：独立检查 Agent
- 顺序参考（非硬依赖）：[019 验证Git、归档与封存的关键故障](019-git-and-seal-failures.md)
- 实际依赖：[任务表](../TASKS.md)中001–019的可用成果／证据；缺项先审并记录，全部必需项通过才可验收。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

由独立上下文按实际代码和证据验收M2，决定能否用于真实项目。

## 先读

先遵守根 [AGENTS.md](../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../DESIGN.md)：第15.1、16.1、16.4节。
- [STATES.md](../STATES.md)：数据权威、检查、取消及恢复守卫。
- [TASKS.md](../TASKS.md)：001–019执行记录与当前阻塞。

## 实施范围

- 直接检查实现及实际测试结果，不凭前面Agent总结判通过；模型可以相同，上下文／Session必须独立。
- 在受控但逼真的临时项目验证脏index、部分失败、取消恢复、文件续做、规范演进与限定归档。
- 核对M0/M1/M2现有证据；缺口登记到关联任务和BLOCKERS，先完成可独立审查部分。需用户决定时保持blocked，后续独立开发继续，补齐真实实现／验证后再复查。
- 保存可用范围、未验证边界、失败与修复引用；通过前不指导用户在外部真实项目试危险路径。

## 交付物

- 独立M2验收结论与证据索引
- 剩余阻塞／已修复问题和真实项目使用边界

## 完成前必须验证

- 关键数据保护无未解决阻塞，测试不是仅mock实现；原生引用失效与有效执行不重复。
- 确认当前工程没有被测试自动commit／初始化产品状态，研究与私有记录未打包泄露。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 本任务本身不授权操作用户其它仓库，不自动创建真实项目试用或提交。
- 保留现有工作区和前置任务记录；不自动提交／推送当前仓库，不操作其它真实仓库，不初始化当前工程的产品 .knit/ 或 .pi/。
- 本文件是开发排程，不是Knit产品Task；文件任务不预定产品元数据后端。

## 阻塞时的伪代码交接

遇阻塞先保留已做工作，按 [BLOCKERS.md](../BLOCKERS.md) 记录后继续其它可做任务。未定部分可写伪代码／暂定接口供下游开发，但不能当真实实现或验收成功。

- 关联阻塞编号：无；发生后引用真实编号。
- 未实现部分与影响：尚无记录。
- 暂定输入／输出／错误边界：需要时据实填写。
- 伪代码与关键步骤：需要时填写，明确哪些只是设计。
- 解除阻塞后补做与真实验证：需要时填写。
- 使用该暂定接口的下游任务：需要时记录，便于后续回补。

## 执行记录

以下是事实记录，不另存一份任务状态；状态只改根 TASKS.md。

- 执行者／Session：独立验收 Agent（独立上下文／Session，多轮；最终检查未复用主 Agent 上下文）。最终报告与场景结果见 `validation/m2-independent-gate/`。
- 开始／结束时间：2026-11-02（本会话）。
- 实际修改：
  - **接收收敛**：`src/application/run-activity.ts` 的 `runSettled` 改为：`completed` 必须有 result 与 completed 接收回执；`failed`／`cancelled` 已裁决终态不因 result 缺失或 acceptance needs_attention 永久阻塞。`DeliveryService.runsSettled` 复用同一函数。
  - **Git／归档恢复**：`src/application/delivery-service.ts` 提交前 checkpoint 保存 before／expectedPaths／expectedTree；恢复核验 HEAD、父节点、message、路径集合与提交树；找不到操作提交但 HEAD 已前进返回 `commit_unverified`，不误判 `no_selected_changes`；`addable` 识别 HEAD 已跟踪路径，`stageable` 避免对已在 index 删除的路径重复 `git add`；归档核验失败不落盘错误 `archiveCommit`，清理额外历史后同操作恢复真实提交；work completed 后出现外部额外提交拒绝归档。
  - **配置与警告**：`cancelGraceMs` 默认／模板改为 5000 并由 worker 传给 StageRunner；`snapshotsMaxBytes` 与 `heartbeatIntervalMs` 从配置读取；doctor 使用 `heartbeatStaleMs`；锁根拒绝列表增加 SMB2；`task record` 在任务锁内重读封存标记，JSON 未保存退出 1；移除测试恒真断言。
  - **测试**：`test/delivery.test.mjs` 增至 27 项；`test/stage.test.mjs` 增取消无 result 关闭与失败检查关闭；`test/task.test.mjs` 修正外部编辑断言；全套 **194/194**。
  - **文档／证据**：`DESIGN.md`、`OPERATIONS.md`、`TASKS.md`；新增 `validation/m2-independent-gate/`；更新 `validation/m2-git-failures/` 计数与场景。
- 实际验证命令与结果：
  - `npm run -s typecheck`：通过。
  - `npm run -s build`：通过。
  - `npm run -s pack:check`：通过（162 文件，无 src/test/tasks/validation/研究/私有记录）。
  - `npm test`：**194/194**（多轮；一次 193/194 为无关 `stage.test.mjs:179` `lock_busy` flake，单测重跑通过）。
  - `node --test test/delivery.test.mjs`：**27/27**。
  - 独立最终审计：真实临时 Git 项目、真实 hook、真实 SIGKILL、CLI/fake-pi；M2 PASS，报告见 `validation/m2-independent-gate/audit-report.md`。
- 任务书必需验证逐项：
  - 关键数据保护无未解决阻塞：最终独立审计通过；快照/index、锁/取消、接收竞争、Git/move/封存、原生恢复 artifact、取消无 result、completed 未接收守卫均通过。
  - 测试不是仅 mock：关键用例使用真实 SQLite、文件锁、Git、子进程、SIGKILL/hook；真实付费模型链路本轮未重跑，沿用 `validation/m2-safety` 真实模型 artifact。
  - 当前工程未被测试自动 commit／初始化产品状态：`git status` 无新提交，HEAD 仍 `dde49bb`，无 `.knit/`／`.pi/`。
  - 打包无研究／私有记录：`pack:check` 与独立 `npm pack` 核对 162 文件仅 assets/dist/README/package。
  - bridge schema 同源：7 个 schema 与 `BRIDGE_TOOL_SCHEMAS` 一致。
  - 真实项目使用边界：临时项目 PASS；未验证真实 NFS/SMB/FUSE、SQLite 断电、Windows/macOS、fetch/push/merge/rebase/签名。
- 证据位置：`validation/m2-independent-gate/README.md`、`report.json`、`audit-report.md`、`scenarios.json`；`validation/m2-git-failures/`（27 项交付/归档）；`validation/m2-state-races/`；`validation/m2-safety/`；`validation/snapshot-restore/`。
- 未解决问题／决定：
  1. 真实付费模型链路未在本轮重跑；原生恢复仅核对既有真实 artifact。
  2. 未挂载真实 NFS／SMB／FUSE；仅静态核对 magic 与本地拒绝逻辑。
  3. 未模拟 SQLite WAL 断电、Windows/macOS、真实 fetch／push／merge／rebase／签名。
  4. 旧版本可能已落盘的错误 `archiveCommit` 不自动迁移；当前代码不会新产生，旧本地库需人工核实。
  5. `test/stage.test.mjs:179` 在负载下偶发 `lock_busy`，属 worker 终态与释放项目锁之间的可重试观察窗口，不改变业务事实。
- 对下一项的交接：M2 已通过独立临时项目门槛，可在受控真实项目中按任务020边界试用；不自动授权其它仓库、提交／推送或发布。下一编号 021（M3A 接管／树／多会话）。
优先扫描下一编号（阻塞时可继续跳过）：[021 完善分支接管、对话树和多会话关联](021-adopt-tree-and-sessions.md)。
