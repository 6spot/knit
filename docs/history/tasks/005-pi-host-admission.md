# 005 验证宿主桥接准入并收敛M0

- 里程碑：M0
- 执行角色：验证 Agent
- 顺序参考（非硬依赖）：[004 实证比较并确定唯一元数据仓储](004-metadata-storage-decision.md)
- 实际依赖：[002](002-contracts-and-ports.md)、[003](003-pi-cli-runtime.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

验证真正会用到的宿主接口和消息连接，关闭M0假设，不把类型存在当能力。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [TECHNOLOGY.md](../../design/TECHNOLOGY.md)：第6.1、8节完整放行条件。
- [DESIGN.md](../../design/DESIGN.md)：第7、9.1–9.3节：信任、当前路径与轮询。
- [validation/design-audit/README.md](../../../validation/design-audit/README.md)：尚待真实验收项目。
- [validation/pi-cli-1.4.0/MATRIX.md](../../../validation/pi-cli-1.4.0/MATRIX.md)：复用已有验证，不重复无关模型调用。

## 实施范围

- 使用受控临时扩展验证核心JSON schema派生工具的真实注册／参数校验，确认无需在Knit依赖SDK。
- 实际验证可信项目自动加载、未受信不加载、安装ready不等同信任、reload不重复监听。
- 用最小真实结果夹具贯通外部worker结果→只读查询→宿主观察→来源／去重核对→被动通知／主动唤醒和忙时follow-up。
- 验证切会话／树、关闭、重载、持久化未知及已通知结果；不将定时回调本身当整条连接通过。
- 结合003/004记录M0完成、能力限制与产品待验收项；更新事实来源，保留原始实验记录。

## 交付物

- M0准入报告及可复用桥接／测试片段
- 确认过的宿主schema与消息连接约束

## 完成前必须验证

- 最小必要真实Pi交互／RPC实验有原生证据、工具终态和用量；没有模型授权／配置时说明真实阻塞。
- 节点版本、仓储选型、CLI恢复／取消和本任务门槛逐项有结果；必要能力未定记blocked及待决定项，不假称M0通过。006领域等独立开发可以继续，不因本项阻塞停止。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- M0夹具不是第二套产品；init生成的最终桥接仍须015再次验收。
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
- 开始／结束时间：2026-11-01。
- 实际修改：新增 validation/host-admission/（README 报告、results.json、scripts/{run_admission.py,knit-bridge.js}）；TECHNOLOGY.md 第 6.1/7 节补宿主准入事实；DESIGN.md M0 验收行更新；TASKS.md 005 状态。
- 实际验证命令与结果：`python3 scripts/run_admission.py` 三用例全部 passed（schema-and-trust 18.2s 含 2 次真实模型轮次、reload-no-duplicate 2.4s 零模型、result-pipeline 34.8s 含 2 次真实模型轮次）：
  - schema-and-trust：dist/contracts TypeBox→JSON schema 派生并 Value.Check 探针；受信项目扩展自动加载（get_commands 含 knit-bridge-*）；knit_selftest 工具内部用宿主 ctx.executeTool 实测校验语义（对象 runId 与非法联合字面量被拒 isError 不到 execute；兼容原始类型被 Value.Convert 强转放行）；真实模型按 schema 成功调用 knit_status（tool_execution_end 无错误）；未受信不加载；ready 标记不冒充信任。
  - reload-no-duplicate：ctx.reload() 重载后每命令仍一条事件，旧监听不重复；零模型。
  - result-pipeline：回执文件→1s 只读轮询→来源核对→终态判定→按会话条目去重→投递→appendEntry 回执。无结果/非终态不投；被动通知零模型轮次；同 run 只投一次；wake 实际启动模型回合（token 0→非零）；忙时 follow-up 当前回答先于排队通知；originSession 不匹配不投；切会话不误投且旧轮询停止。
- 证据位置：validation/host-admission/results.json、scripts/ 与 .work/（含 stderr、RPC 事件日志）、README.md。
- 实施中发现并如实记录的宿主约束：项目扩展发现只认 .ts/.js（loader.js:585），不认 .mjs——夹具首版 .mjs 未被加载，已改 .js 并写入报告；校验层对兼容原始类型强转（123→"123"）而非拒绝——桥接强标识字段需 execute 内二次校验；executeTool 校验失败返回 isError result 而非抛错；命令回调 ctx 无 executeTool（仅工具 execute ctx 有）。
- 未解决问题／决定：产品 `knit status --run --json` 命令与 run 证据真实落盘后，按本 README 同一链路验收；树/分支切换复验留待产品桥接。
- 对下一项的交接：006 纯领域状态可独立开发，不依赖本夹具；桥接片段可复用 scripts/knit-bridge.js 的轮询/去重/来源守卫模式；M0 五项全部完成，无阻塞。

优先扫描下一编号（阻塞时可继续跳过）：[006 实现纯领域状态与检查资格](006-domain-rules.md)。
