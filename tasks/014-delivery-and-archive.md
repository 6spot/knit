# 014 实现限定提交、归档与确定性收尾

- 里程碑：M1
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[013 实现实施、检查、结果接收与恢复续做](013-stage-execution-and-recovery.md)
- 实际依赖：[006](006-domain-rules.md)、[007](007-local-infrastructure.md)、[009](009-task-files-and-inputs.md)、[013](013-stage-execution-and-recovery.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

让主Agent判断与确定性工具共同完成真实交付，不让worker报告冒充Git事实。

## 先读

先遵守根 [AGENTS.md](../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../DESIGN.md)：第10–11节。
- [OPERATIONS.md](../OPERATIONS.md)：第4.1节：目标与授权。
- [ARCHITECTURE.md](../ARCHITECTURE.md)：确定性操作、seal和回执。
- [validation/pi-cli-1.4.0/README.md](../validation/pi-cli-1.4.0/README.md)：hook与回执限制。

## 实施范围

- 实现deliver/archive核心操作、完整refs/heads目标、authorizationRef版本与来源定位；默认分支候选只观察不授权。
- 使用限定路径／所选树保护普通无关index，保留项目hook，提交后核对真实commit内容和范围。
- 先记录完整收尾资料，再seal固定版本、提交、移动与检查点；已生效但回执丢失先核实，不重做。
- 正常完成使用有效检查；取消／替代仅归档实际资料，不默认提交半成品代码或造空commit。

## 交付物

- 交付／归档与授权接线
- 临时仓库限定工作提交、资料归档和已有脏index证据

## 完成前必须验证

- 工作commit和归档commit各自范围准确，无关staged／unstaged保留；hook越界记录真实事实并needs_attention。
- 封存中record明确未保存；后补按原Task ID写新资料，不伪称已进旧提交、不重开业务。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 绝不在当前工程自动commit/push；不自动stash、reset、amend或改写历史。
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

优先扫描下一编号（阻塞时可继续跳过）：[015 完成CLI与生产薄桥接并验收M1](015-cli-bridge-m1-gate.md)。
