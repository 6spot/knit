# 021 完善分支接管、对话树和多会话关联

- 里程碑：M3A
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[020 独立检查真实项目使用门槛](020-m2-independent-gate.md)
- 实际依赖：[006](006-domain-rules.md)、[007](007-local-infrastructure.md)、[009](009-task-files-and-inputs.md)、[010](010-session-context.md)、[013](013-stage-execution-and-recovery.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

完善日常跨会话接续和树切换，保持单用户防错范围。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../../design/DESIGN.md)：第3.5、9、12节。
- [STATES.md](../../design/STATES.md)：adopt／选择与输入失效。
- [OPERATIONS.md](../../design/OPERATIONS.md)：身份、占用和只读查询。

## 实施范围

- 完善task adopt当前可见分支，不创建或切分支，保早期phase、失效旧检查且不把接管当提交授权。
- 完善use/clear、reload、fork／树路径重建和当前选择投影，不复活早期选择。
- 完善发起上下文核对、已有通知去重、重载后观察恢复、忙时安全排队；不加持久观察者状态机。
- 完善记录缺失／多机仅Task可见时的显式限制与检查missing，不做共享调度或全分支任务库。

## 交付物

- 日常分支／树／多会话接续能力
- 真实原生路径与分支夹具验证

## 完成前必须验证

- 无活动／未知run、无未核实Git效果才adopt；纯分支变动不强制重新讨论。
- 换树／会话后结果不误投后来上下文，clear不复活，当前模型事实不从旧默认猜。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不实现Worktree、REX或多人协作。
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

- 执行者／Session：ZCode / Pi session `01a1981c-6f75-749d-b9c2-7e5c897950a6`（用户已授权本仓库提交／推送，提交另行执行）。
- 开始／结束时间：2026-11-02。
- 实际修改：
  - `src/application/task-service.ts`：重写 `adopt`。项目＋任务锁内复核当前分支、Task 版本；只允许改绑当前检出分支；拒绝非 open、活动／未知 run、未完成 delivery 操作；旧分支→当前分支保持 discuss／implement／check，deliver 回 open/check 并清 outcome；清 `lastCheckRunId` 保留检查历史；返回 `adopted`／`previousBranch`／`checkInvalidated`／`phase`；同一分支重复 adopt 不重复失效。
  - `src/cli/task.ts`：adopt 人类输出显示原分支与检查失效。
  - `src/application/session-service.ts`：`task use` 拒绝选择分支与当前分支不一致；`clear` 分支回退当前分支；`resolveSelection` 在原生选择分支变化时返回 `branch_changed`，不生效且不复活旧树选择。
  - `src/application/run-coordinator.ts`：`RunStatusProjection` 新增 `branch`，来自冻结请求 `expected.branch`，不从当前默认分支猜。
  - `assets/templates/pi/extensions/knit.ts`：观察通知轮询核对 run 发起分支与当前分支，不一致跳过并记 `notice_skipped_branch`；保留通知去重与忙时 `followUp`。
  - `test/task.test.mjs`、`test/m1-cli.test.mjs`、`test/session.test.mjs`：新增 adopt 分支改绑／检查失效／活动 run／未核实 Git 操作守卫、CLI adopt、选择分支不一致、status branch 断言；桥接模板断言。
  - `validation/m3a-adopt-tree/`：测试输出与报告。
  - `DESIGN.md`、`STATES.md`、`OPERATIONS.md`：回写 adopt／选择／通知分支语义。
- 实际验证命令与结果：
  - `npm run -s typecheck`：通过。
  - `npm run -s build`：通过。
  - `npm test`：**197/197**（构建＋全套；含新增测试）。
  - `node --test --test-name-pattern "task adopt" test/task.test.mjs`：2/2。
  - `node --test --test-name-pattern "task adopt" test/m1-cli.test.mjs`：1/1。
  - `node --test --test-name-pattern "选择分支与当前分支|task use/clear" test/session.test.mjs`：2/2。
- 任务书必需验证逐项：
  - 无活动／未知 run、无未核实 Git 效果才 adopt：测试覆盖活动 run 与 `needs_attention` delivery 操作均拒绝且不写 Task；锁内重核当前分支。
  - 纯分支变动不强制重新讨论：discuss／implement／check 保持；deliver 回 open/check；旧检查失效但历史文件保留。
  - 换树／会话后结果不误投后来上下文：原生选择分支不一致返回 `branch_changed` 不生效；`task use` 拒绝旧分支；status 投影保存 run 发起分支，桥接跳过跨分支通知。
  - clear 不复活：既有有效路径测试与新分支测试通过。
  - 当前模型事实不从旧默认猜：本项未改模型选择；沿用 015 显式模型请求。
  - 记录缺失／多机仅 Task 可见：原生文件缺失仍返回 `missing`／`native_file_missing`，不凭索引伪造可恢复；未实现共享调度或全分支任务库。
- 证据位置：`validation/m3a-adopt-tree/README.md`、`report.json`、`tests/`；`test/task.test.mjs`、`test/session.test.mjs`、`test/m1-cli.test.mjs`、`assets/templates/pi/extensions/knit.ts`。
- 未解决问题／决定：
  1. 未新增完整树可视化命令或共享全分支任务库；fork 关系沿用 Session `source`／`parent` 接口，不复制父历史。
  2. 真实 Pi reload／多会话通知路径沿用任务015 的真实桥接证据；本项新增的是分支防误投与模板断言，未重跑完整 Pi 多会话长链路。
  3. 选择记录分支为 null 时仍允许按当前分支生效（兼容早期记录），不按目录名猜分支。
  4. adopt 只接受 open 任务；已取消／替代／归档不通过 adopt 重开。
- 对下一项的交接：022 可复用 adopt 的锁内守卫、检查失效与分支投影；初始化升级不要绕过当前分支／run 事实。
优先扫描下一编号（阻塞时可继续跳过）：[022 完善初始化升级与指令生效核对](022-upgrades-and-instructions.md)。
