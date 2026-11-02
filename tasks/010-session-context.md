# 010 实现Session索引、当前选择与上下文计划

- 里程碑：M1
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[009 实现Task文件与输入草案操作](009-task-files-and-inputs.md)
- 实际依赖：[002](002-contracts-and-ports.md)、[003](003-pi-cli-runtime.md)、[004](004-metadata-storage-decision.md)、[007](007-local-infrastructure.md)、[009](009-task-files-and-inputs.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

统一主／子会话身份和当前任务选择，为阶段冻结可追溯输入。

## 先读

先遵守根 [AGENTS.md](../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../DESIGN.md)：第9节。
- [STATES.md](../STATES.md)：第6节。
- [ARCHITECTURE.md](../ARCHITECTURE.md)：SessionService、ContextPlanner与数据权威。

## 实施范围

- 实现session attach/list、task use/clear、context，区分索引快照与原生有效路径权威。
- 主会话条目经宿主API追加并确认；未落盘只待确认，不伪造消息强制保存；切树后不复活旧选择。
- 实现ContextPlanner分层输入、正式规范／角色版本、指纹和注入清单；待应用草案和候选只作背景。
- 连接003原生ID预分配、opening/available、稳定记录路径、来源关系与只读历史能力边界。

## 交付物

- Session/context用例及必要桥接接线
- 选择、clear、空原生记录与指令冻结证据

## 完成前必须验证

- Task ID／原生Session／项目／角色不混淆，活跃主会话不被worker复用。
- 清除、路径切换与临时cwd不误选；参数／指令就绪可首轮调用，未落盘不可声称可恢复。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不在索引或数据库复制聊天正文，未知原生格式只报告限制。
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

- 执行者／Session：ZCode（Pi session 01a1981c-6f75-749d-b9c2-7e5c897950a6）。
- 开始／结束时间：2026-11-02。
- 实际修改：
  - `src/contracts/session.ts`：索引记录升级为 DESIGN9.5 字段（Knit Session ID、kind、sessionFile、parent、source、task/branch/run、cwd、checkpoint、selection 快照、lastVerifiedAt、nativeReadable、relatedRunState）；`newKnitSessionId` 为 s-+12hex。
  - `src/contracts/context-plan.ts`（新）：分层 section（task-inputs／progress／workflow／role／runtime／standard／pending-draft／standard-candidate）、注入途径、排除项、工具策略与就绪／阻塞字段。
  - `src/adapters/pi/native-entries.ts`：新增 `readActiveEntryIds`（按 parentId 回溯当前有效分支）、`readCustomEntries`（只读选择事件）、`readEntrySummaries`（只读历史摘要，不含正文）；`native-file.ts`：`piSessionDir`（与 Pi 1.4.0 编码一致）与 `findNativeSessionFile`（按 `<timestamp>_<id>.jsonl` 稳定查找）。
  - `src/application/session-service.ts`（新）：attach／verify／list／useTask／clearTask／resolveSelection／history；未落盘只记待确认，原生有效路径为选择权威，树切换不复活旧条目，cwd 不一致不误选，子会话不得复用主会话原生文件。
  - `src/application/context-planner.ts`（新）：分层计划；只有任务输入区与正式规范／角色计入 inputsDigest，记录区、未生效草案、候选规范只作背景；role 文件缺失时 implement/check 不就绪。
  - `src/application/guard-error.ts`（新）与 TaskGuardError 继承；`src/cli/output.ts` 统一映射（pending/runs_unsettled → needs_review，其余业务拒绝 → invalid_request）。
  - `src/ports/infrastructure.ts` 与 `src/infrastructure/sqlite-metadata-store.ts`：sessions 增列（knit_session_id／kind／task_id／parent_session_id）与索引，新增 save／getByKnitId／list／setSelection，旧库按 PRAGMA table_info 补列。
  - `src/application/task-service.ts`：导出 `tasksRootOf`／`listTaskDirectories`／`locateTaskDocument`（返回原文供指纹）供上下文计划复用；`src/cli/task.ts` 新增 task use／clear，`src/cli/session.ts`（新）注册 session attach／list／verify／resolve／history 与 context。
  - `test/session.test.mjs`（新 7 项）；`test/contracts.test.mjs`、`test/metadata.test.mjs` 夹具适配完整索引记录。
- 实际验证命令与结果：`npm test` 111/111（session 7 + task 17 + init 11 + infrastructure 18 + domain 23 + contracts 17 + cli 5 + pi-runtime 12 + metadata 6）；`npm run pack:check` 通过；`npm run typecheck` 通过。临时真实项目（/tmp/knit-010-e2e，已清理）用真实 CLI 实测：init → task new → session attach（真实 Pi 格式 JSONL，available 与稳定路径）→ session resolve（原生事件 k-9a3779361378 / entry e2）→ context --json（ready、inputsDigest b949b7cfd8ef、6 层 section、progress 背景、toolPolicy write）→ task clear --persisted（resolve 清除生效，entry e3）→ task use 未落盘（只待确认，resolve 仍无选择）→ 删除原生文件后 verify=missing/native_file_missing、恢复后 available；全程零 Git 提交、零模型调用。
- 任务书必需验证逐项：
  - Task ID／原生 Session／项目／角色不混淆：索引按（client、原生 ID、角色）定位，任务按稳定 ID；同原生 ID 不同角色得不同 Knit Session ID；同原生 ID 跨项目 attach 拒绝 project_conflict；子会话复用主会话原生文件拒绝 main_session_reuse；子会话必填父会话。
  - 活跃主会话不被 worker 复用：同上 main_session_reuse 断言（测试）。
  - 清除、路径切换与临时 cwd 不误选：clear 事件（taskId=null）生效后 resolve 返回无选择且不复活更早条目；新叶挂到更早父条目后旧分支选择不在 activeIds，返回 selection_entry_not_on_active_path；cwd 不一致返回 cwd_mismatch。
  - 参数／指令就绪可首轮调用，未落盘不可声称可恢复：context 在模板齐全时 ready=true 且 toolPolicy 按角色；attach 未落盘为 opening/native_file_not_persisted、nativeReadable=false，不置 available。
- 实施中纠正的事实：JSON 错误响应最初未设置非零退出码（协议错误被当成功）；子会话复用主会话时先报 kind 冲突而非 main_session_reuse；文件从已落盘变为缺失时状态应为 missing 而非 opening（按曾有记录区分）；`task clear` 人类可读输出按 persisted 判定。
- 未解决问题／决定：① 主会话选择条目的写入由桥接经宿主 API 完成（015 验收），本任务实现核心侧的落盘确认（persisted+entryRef）、有效路径解析与索引更新；② ContextPlanner 生成的 plan 尚未写 `inputs.json`（run 发布归 012/013）；③ 候选规范目录约定 `.knit/standards/candidates/`，正式闭环归 011；④ 角色枚举无 deliver，收尾阶段使用 advisory 或主会话指令（DESIGN 8.1），如需独立 deliver 角色在 011 后再定。
- 对下一项的交接：011 可直接用 `ContextPlanner.plan` 的 section 指纹与 excluded 理由区分“候选/正式”；SessionService.attach 已支持 source=fork/switch/resume_fallback 与 parent 关系，恢复兜底原因可写入 source.reason；`readActiveEntryIds`／`readEntrySummaries` 可复用于 run 条目范围核实；store.sessions.list({taskId}) 支持按任务查会话。

优先扫描下一编号（阻塞时可继续跳过）：[011 实现规范候选到正式规则的闭环](011-standards-evolution.md)。
