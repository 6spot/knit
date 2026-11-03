# 009 实现Task文件与输入草案操作

- 里程碑：M1
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[008 实现init与项目受管资料所有权](008-project-initialization.md)
- 实际依赖：[004](004-metadata-storage-decision.md)、[006](006-domain-rules.md)、[007](007-local-infrastructure.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

实现稳定任务身份、Markdown输入／记录分区和可执行的阶段入口。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../../design/DESIGN.md)：第3–4、11、14.1节。
- [STATES.md](../../design/STATES.md)：第3–4、8–10节。
- [OPERATIONS.md](../../design/OPERATIONS.md)：记录、草案和封存规则。

## 实施范围

- 实现task new/rename/list/record/ready/update/close及稳定ID、目录冲突和首次归档月份所需信息。
- 使用YAML Document维护frontmatter，正文／人工内容按所有权保留；记录区不进入业务摘要。
- 实现单份pendingInput、kind／理由／基线／含操作ID的版本摘要，apply/withdraw-pending与stale保护。
- 实现Task关闭与该任务启动／接收的短临界区守卫；取消／替代先收敛事实、撤回草案，不重开旧任务。

## 交付物

- TaskService与核心命令
- Markdown输入、记录、草案及生命周期测试

## 完成前必须验证

- 同ID歧义、改名、记录并行和封存返回未保存；纯记录／等价移动不失效检查。
- 旧草案撤回不能伤害后来同内容草案；基线变化不覆盖；关闭不被迟到结果复活。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- use/clear与原生选择由010接入，不伪造选择事件；不实现全分支任务库。
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
  - 新增 src/contracts/task-inputs.ts（frontmatter／输入区分区 schema、inputsDigestOf、pendingDraftDigest 含更新操作 ID、PROGRESS 标记、newTaskId）；新增 src/application/task-document.ts（YAML Document frontmatter 读写、记录区标记分区、结构错误报 io_error）；新增 src/application/task-service.ts（TaskService：new/rename/list/record/ready/update/close，TaskGuardError 带稳定领域原因码）；新增 src/cli/task.ts（task 命令组，--json 协议输出）。
  - src/infrastructure/locks.ts：LockScope 增加 "task"（tasks/<摘要>），orderKeys 顺序 project → task → session；src/contracts/metadata.ts：TaskBindingSchema 增加 confirmedInputsDigest 与 pendingDraft（kind/reason/content/baselineDigest/digest/createdAt）。
  - src/cli/output.ts：reasonForError 增加 TaskGuardError 映射（phase_mismatch／outcome_* → invalid_request；pending_draft／runs_unsettled → needs_review）；test/contracts.test.mjs 与 test/metadata.test.mjs 夹具补齐新 binding 字段。
- 实际验证命令与结果：`npm test` 104/104（task 17 + init 11 + infrastructure 18 + domain 23 + contracts 17 + cli 5 + pi-runtime 12 + metadata 6，先 build）；`npm run pack:check` 通过；临时 Git 项目真实 CLI 实测（/tmp/knit-009-e2e，已清理）：task new 生成 k- 前缀 ID 与 MM-DD-slug 目录、task ready 冻结输入摘要 discuss → implement、task record 写记录区、task rename 等价移动更新 binding 路径、task update --kind change 回 discuss、task close --outcome cancelled 撤回草案留记录；全程零 Git 提交、零模型调用。
- 任务书必需验证逐项：
  - 同 ID 歧义：newTaskId 生成后对全部活动＋归档 frontmatter ID 去重重生成；list 分区读 frontmatter，同目录不等于同任务（按 ID 定位）。
  - 改名：等价移动输入摘要不变（测试断言），binding.relativePath 更新；目标重名追加序号；无 MM-DD 前缀目录拒绝。
  - 记录并行：record 用任务短锁，与持有项目执行占用的长阶段并存（测试：持项目锁后 record 成功）；record 只改记录区，输入摘要不变。
  - 封存返回未保存：.knit-sealed 标记文件存在时 record 返回 sealed=true 不写文件（测试断言原文不变）。
  - 纯记录／等价移动不失效检查：inputsDigestOf 排除记录区（digestImpact "record"→null 已在 domain/task.ts，006）；rename equivalent=true 摘要不变。
  - 旧草案撤回不伤害后来同内容草案：digest = SHA-256(kind, reason, content, baselineDigest, updateOperationId, createdAt)，同内容不同操作 ID／时间得不同版本；错误 expectPending 拒绝后草案仍在（测试断言）。
  - 基线变化不覆盖：apply 前核对 draft.baselineDigest === 当前输入摘要，不符抛 version_conflict（消息含"基线"），后来输入保留（测试断言）。
  - 关闭不被迟到结果复活：close 后 update/close 均被 closedGuard 拒绝（outcome_cancelled）；completed 需 runsSettled=true。
- 实施中纠正的事实：测试夹具 git commit 漏传 cwd（commit 落在 knit 仓库工作目录而非夹具，报 nothing to commit）——修复后 14 项转绿；CLI 参数校验在 json 模式下改走协议响应（stdout JSON + exit 1）。
- 未解决问题／决定：① run 活跃状态（runActive）当前由调用方传入，真实 run 注册表在 012/013 落地后由 run 仓储查询替代——TaskService.update 接口已预留 updateOperationId；② 封存标记 .knit-sealed 的落盘／清理属 deliver/archive 流程（014），本任务只消费；③ close 的 runsSettled 收敛核对（活动／未知 run、未核实 Git 效果）同样待 run 仓储，当前为显式布尔入口；④ pendingDraft 只存 binding（SQLite），不另建草案文件——与 DESIGN 3.6 "至多一份"一致，012 元数据层迁移时复核。
- 对下一项的交接：010 Session/上下文可复用 TaskService.readInputs（返回 inputsDigest 与 binding）；任务定位入口 locate(root, taskId)（按 ID 扫描活动＋归档）；锁顺序 project → task → session 已在 orderKeys 固定，010 建 Session 锁时直接拼接；store.bindings 含 pendingDraft/confirmedInputsDigest，检查资格推导可直接用 confirmedInputsDigest 与 inputsDigestOf(task.md) 对比得 stale。

优先扫描下一编号（阻塞时可继续跳过）：[010 实现Session索引、当前选择与上下文计划](010-session-context.md)。
