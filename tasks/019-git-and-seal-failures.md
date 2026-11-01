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

- 执行者／Session：尚未认领。
- 开始／结束时间：未开始。
- 实际修改：未实施。
- 实际验证命令与结果：未执行。
- 证据位置：无。
- 未解决问题／决定：无已知新增项；实施时据实补充。
- 对下一项的交接：待本项完成后填写。

优先扫描下一编号（阻塞时可继续跳过）：[020 独立检查真实项目使用门槛](020-m2-independent-gate.md)。
