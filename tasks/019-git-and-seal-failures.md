# 019 验证Git、归档与封存的关键故障

- 里程碑：M2
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[018 验证接收、草案和业务状态的竞争恢复](018-acceptance-and-state-races.md)
- 实际依赖：[007](007-local-infrastructure.md)、[009](009-task-files-and-inputs.md)、[014](014-delivery-and-archive.md)、[016](016-path-restore-and-fingerprints.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

把真实项目已有修改、hook和Git成功回执丢失纳入可核验收尾。

## 先读

先遵守根 [AGENTS.md](../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [OPERATIONS.md](../OPERATIONS.md)：快照、授权与补记细则。
- [STATES.md](../STATES.md)：第7、10节。
- [DESIGN.md](../DESIGN.md)：第10–11、16节。
- [validation/pi-cli-1.4.0/03-edge-cases/git/results.json](../validation/pi-cli-1.4.0/03-edge-cases/git/results.json)：已知Git原生边界。

## 实施范围

- 覆盖同路径混改、分块/模式/删除/重命名、无关staged／unstaged和验证产生的实际变化。
- 覆盖hook拒绝、改内容、扩提交范围及改index；实际效果与预期不符保事实并needs_attention。
- 覆盖commit成功后执行者退出、移动后检查点丢失、跨月恢复和目标冲突，不重复commit/move。
- 覆盖seal中记录明确未保存、之后按稳定Task ID补记、归档资料维护与取消／替代仅资料提交。

## 交付物

- 交付／seal故障保护
- 真实临时仓库中的提交树、index与恢复证据

## 完成前必须验证

- 限定路径的实际commit和检查目标内容一致；未检查的新变动不能冒充已交付。
- 重复恢复不产生空commit或丢后来输入；无自动reset/amend/stash apply。
- 授权来源与目标完整ref按操作版本保存，defaultBranch unknown不猜main/master。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 任意外部并发／hook副作用不是隔离保证，检测到异常不悄悄修历史。
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

- 执行者／Session：ZCode / Pi session `01a1981c-6f75-749d-b9c2-7e5c897950a6`。
- 开始／结束时间：2026-11-02（本会话）。
- 实际修改：
  - `src/application/delivery.ts`：新增 `treeSnapshot`／`indexTreeFor`／`sameTree`，按提交树模式与 blob 核对实际内容。
  - `src/application/delivery-service.ts`：工作／归档提交前记录预期 index 树，提交后核对路径集合与模式／blob；hook 拒绝／改 index／扩范围／改内容保留已产生提交并 needs_attention；显式 retry 重核 expectedPaths／expectedTree，不盲目完成；首次创建操作即固定 `archivePath`，跨月恢复不改目标；move 检查点丢失时按目标 Task ID／封存摘要恢复，源／目标冲突与外来目标保留现场；兼容旧操作 `tasks/...` 路径。
  - `test/delivery.test.mjs`：新增混改（内容／100755／重命名／删除）、hook 拒绝、hook 加 index／扩范围、hook 改内容后 retry、move 检查点丢失、目标冲突、跨月 archivePath 测试；适配 hook 内容核对。
  - `validation/m2-git-failures/`：真实临时 Git 测试输出与报告。
  - `DESIGN.md`、`STATES.md`、`OPERATIONS.md`、`ARCHITECTURE.md`：回写 019 语义。
- 实际验证命令与结果：
  - `npm run -s typecheck`：通过。
  - `npm run -s build`：通过。
  - `npm run -s pack:check`：通过。
  - `npm test`：**185/185**（任务完成时；任务020复验后全套 **194/194**）。
  - `node --test test/delivery.test.mjs`：**19/19**（任务完成时；任务020复验后 **27/27**，真实临时 Git 仓库；提交树、index、路径、hook、move 恢复）。
  - `node --test --test-name-pattern "同任务混改" test/delivery.test.mjs`：1/1；实际提交 `app.txt` 内容 `mixed
`、`mode.sh` 100755、重命名 old→new、删除 staged.txt/other.txt。
  - `node --test --test-name-pattern "hook 拒绝提交" ...`：1/1；无工作／归档提交、任务原位。
  - `node --test --test-name-pattern "hook 把无关文件" ...`：1/1；提交范围／index 变化保留提交并 needs_attention。
  - `node --test --test-name-pattern "移动成功但 move" ...`：1/1；目标 Task ID 核实，不重复移动，归档提交一次。
  - `node --test --test-name-pattern "跨月重试" ...`：1/1；失败操作 archivePath 2026-11 在 2026-12 retry 后仍为 2026-11。
  - `node --test --test-name-pattern "归档目标已存在" ...`：1/1；外来目标文件不被覆盖，任务不移动，无归档提交。
- 证据位置：`validation/m2-git-failures/README.md`、`report.json`、`tests/`（delivery-all、mixed-paths、hook-reject、hook-index、move-recovery、cross-month、target-conflict、git-version）。
- 任务书必需验证逐项：
  - 同路径混改、模式、删除、重命名、无关 staged／unstaged 与验证产生变化：混改测试与既有 normal 测试覆盖；提交树按 mode/blob 核对，未检查的新变动不能进入交付。
  - hook 拒绝／改内容／扩提交范围／改 index：拒绝、加入无关文件、越界写文件、改选中文件、改内容后 retry 均保留现场并 needs_attention。
  - commit 成功后执行者退出：按操作 ID／提交 message 恢复，不重复工作提交（既有 receipt 测试）；父节点、范围、树核对。
  - move 后检查点丢失：按目标 Task ID 与封存摘要核实并继续，不重复移动。
  - 跨月恢复／目标冲突：首次 archivePath 固定；目标已存在不覆盖。
  - seal 中记录未保存、按稳定 Task ID 补记、取消／替代仅资料：沿用 014 测试（record sealed、归档后补记、取消归档）。
  - 授权来源与完整 ref、unknown defaultBranch 不猜：沿用 014 实现与测试。
  - 无自动 reset／amend／stash：实现只做限定 add／commit／move，失败即保留现场。
- 未解决问题／决定：
  1. 未在 Git commit 子进程运行中强制 SIGKILL；以检查点丢失／hook 失败重入模拟，覆盖提交已生效但回执丢失。
  2. 目标冲突检测在 work commit 之后才发生，可能已留下工作提交；保守保留该事实，不自动回滚（目标目录外来文件不覆盖）。
  3. hook 内容核对只比较提交树 mode／blob，不核对签名、提交者字段或 reflog。
  4. 外部并发进程、fetch／push／merge／rebase／冲突与历史改写不在本项范围；检测异常只保留现场。
  5. 旧操作 `taskPath` 以 `.knit/` 前缀归一化兼容；旧 schema 无树证据时 retry 只能按路径／提交存在核实。
- 任务020复验修正：提交前 checkpoint 保存 before／expectedPaths／expectedTree；恢复核验 HEAD、父节点、message、路径集合与树；删除／重命名路径已在 index 删除时不重复 add；归档核验失败不落盘错误 archiveCommit，清理额外历史后同一操作可恢复真实提交；work 提交后出现外部额外提交拒绝归档。新增回归测试覆盖 message 改写、祖先额外提交、clean worktree false-skip、归档 pre-commit retry、同 message 额外归档提交清理恢复。
- 对下一项的交接：020 可引用 `validation/m2-git-failures`、`validation/m2-state-races`、`validation/m2-safety`、`validation/snapshot-restore`；独立门槛仍需真实项目保护、故障矩阵与未测外部并发说明，不能把本地临时仓库结果外推为生产保证。

优先扫描下一编号（阻塞时可继续跳过）：[020 独立检查真实项目使用门槛](020-m2-independent-gate.md)。
