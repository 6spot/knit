# 012 实现快照准备、local启动与worker认领

- 里程碑：M1
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[011 实现规范候选到正式规则的闭环](011-standards-evolution.md)
- 实际依赖：[002](002-contracts-and-ports.md)、[007](007-local-infrastructure.md)、[009](009-task-files-and-inputs.md)、[010](010-session-context.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

让可信worker持有执行占用、冻结输入并在正式写代码前建立恢复对照。

## 先读

先遵守根 [AGENTS.md](../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../DESIGN.md)：第5.6、13节。
- [ARCHITECTURE.md](../ARCHITECTURE.md)：第5、7节。
- [OPERATIONS.md](../OPERATIONS.md)：第2–3节。
- [STATES.md](../STATES.md)：初始化、launch与run准备。

## 实施范围

- 实现prepare/start内部握手、launch状态和进程实例；入口取得ID后确认，不要求用户重复许可。
- worker原子认领request，自行持锁，冻结inputs/instructions，正式implement先建立snapshot ready。
- 快照保存tracked工作与index层、未忽略untracked、模式／指纹和不存在起点；超限／未知覆盖不能假装完整。
- 写必要state/events并保证日志非权威；启动响应丢失查原句柄，不再生成替代运行。

## 交付物

- local host、worker入口与RunCoordinator准备路径
- M1基本完整快照和启动故障测试

## 完成前必须验证

- 无ID前无模型／业务写；无CLI→worker长锁交接；未ready不启动正式代码。
- 部分启动、重复start和父观察断开不重复运行；并行纯记录保留而不破坏快照冻结。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- M2继续强化故障注入，不得因此在M1省略基本快照／身份保护。
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

- 执行者／Session：尚未认领。
- 开始／结束时间：未开始。
- 实际修改：未实施。
- 实际验证命令与结果：未执行。
- 证据位置：无。
- 未解决问题／决定：无已知新增项；实施时据实补充。
- 对下一项的交接：待本项完成后填写。

优先扫描下一编号（阻塞时可继续跳过）：[013 实现实施、检查、结果接收与恢复续做](013-stage-execution-and-recovery.md)。
