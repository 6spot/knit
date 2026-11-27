---
id: k-1d9ad44e3419
title: 修复 Pi 与 Antigravity 执行适配器会话采集缺陷
status: delivered
stage: null
verification: self
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P0
createdAt: 2026-11-27T07:35:34.478Z
---

## 目标与范围

修复 Pi 与 Antigravity 执行适配器中 3 处已核实的会话结果采集缺陷，消除长会话报告补报死循环、Pi 窗格纯字符串报告丢失以及 Antigravity 跨轮补报状态串扰：

1. **Pi 后台长会话事件截断与等待机制（`src/adapters/pi/connection.ts`、`src/adapters/pi/runtime.ts`）**：
   - `PiRpcConnection` 超过事件上限（默认 `100_000`）时丢弃最旧事件，导致数组下标左移；当前 `PiAgentRuntime` 用原始数组下标 `settledCursor` 过滤 `agent_settled` 和 `lastModelError()`，满上限后再发新 `prompt()`（如报告补报）会永远匹配不到新事件并挂死。
   - 改为维护单调递增的逻辑事件序号（或已丢弃计数偏移），使 `settledCursor`、`waitSettled()` 与 `lastModelError()` 在发生任意次数截断后仍准确只匹配本轮新事件。
   - 将 `waitSettled()` 由 50ms 轮询扫描改为事件驱动唤醒（收到 `agent_settled`、连接退出或到达超时立即返回），保持原有 `timeoutMs`、`aborted` 与进程退出语义不变。
   - 为 `invalidFrames` 增加有界保留上限（如最近 200 条），避免异常非 JSON 输出无限占内存。
   - 允许为测试传入较小的事件保留上限（生产默认仍为 `100_000`），使截断回归测试能快速稳定运行。

2. **Pi 窗格纯字符串助手回复采集（`src/adapters/pi/pane-worker.ts`）**：
   - 当前 `agent_settled` 回调把 `typeof last.content === "string"` 错转为空数组，导致纯字符串形态的助手报告被清空。
   - 改为直接提取 `last.content.trim()`；数组形态保持原有过滤 `type === "text"` 并拼接 `trim()` 的行为不变。

3. **Antigravity 后台跨轮 `requestedSubmit` 重置与 `readline` 关闭（`src/adapters/antigravity/execution.ts`）**：
   - `AgySession.requestedSubmit` 在首轮未写提交标记触发一次追问并置为 `true` 后，当 `runAgentSession` 因报告缺字段发起第二轮 `prompt()` 补报时未重置，导致第二轮漏写标记直接失败而无法追问。
   - 改为每次 `prompt()` 开启新回合时重置 `requestedSubmit = false`，并在 `close()` 中关闭后台 stdout 创建的 `readline.Interface`。

### 范围外
- 不修改 `src/adapters/workbuddy/host-hook.ts`（单独建独立审查任务）。
- 不修改 `agy.jsonl` 的文件写入策略或 `AgyBroker` 的进程回收逻辑（留待后续性能子任务）。
- 不修改状态推进（`src/domain/progress.ts`）、工作区快照对比、受保护路径或交付/授权逻辑。

## 完成条件

### Requirement: Pi 后台会话事件截断后仍可正常等待并采集结果
#### Scenario: 事件达到保留上限后发起新一轮 prompt 正常结算
- WHEN Pi RPC 连接接收的事件数量达到或超过保留上限并触发旧事件丢弃后，同一连接发起新一轮 `prompt()` 并收到新的 `agent_settled` 事件
- THEN `waitSettled()` 能立即识别新一轮 `agent_settled` 并返回 `{ settled: true }`，不发生死循环或误命中上一轮旧事件

#### Scenario: 事件截断后 `lastModelError` 仅匹配本轮错误
- WHEN 上一轮存在带 `stopReason: "error"` 的助手消息且后续发生事件截断，新一轮成功完成后调用 `lastModelError()`
- THEN 不会误返回上一轮的旧错误；当新一轮出现模型错误时仍准确返回本轮错误原因

#### Scenario: `invalidFrames` 保持有界
- WHEN Pi 子进程持续输出超过上限的非 JSON 行
- THEN `invalidFrames` 仅保留最近的受限条数，不无限增长

### Requirement: Pi 窗格扩展兼容纯字符串形态的助手报告
#### Scenario: 助手消息 `content` 为纯字符串时完整采集报告
- WHEN Pi 窗格 `agent_settled` 时分支最后一条助手消息的 `content` 为非空字符串
- THEN 窗格扩展提取并 `trim()` 该字符串作为本轮报告提交，不再判空

### Requirement: Antigravity 后台补报轮次独立计算提交追问次数
#### Scenario: 首轮触发过追问后，报告缺字段进入第二轮补报仍允许追问一次
- WHEN 第一轮因未带 `KNIT_AGY_SUBMIT` 触发过后台追问并最终交出缺字段报告，随后 `runAgentSession` 发起第二轮补报 `prompt()`，第二轮首次回复再次未带 `KNIT_AGY_SUBMIT`
- THEN `AgySession` 为第二轮重新发出一次追问并在执行者随后带标记回复时正常结算，而不是直接判失败

### Requirement: 验证与交付
#### Scenario: 类型检查、构建与定向测试全部通过
- WHEN 运行 `npm run typecheck`、`npm run build` 以及受影响测试文件（`test/pi-runtime.test.mjs`、`test/run-pane.test.mjs`、`test/antigravity.test.mjs`）
- THEN 全部通过，且新增回归用例覆盖上述三项缺陷；改动保留在任务 Worktree 中，不自行提交，交回主会话核对并交付

## 待澄清

## 相关资料

- `src/adapters/pi/connection.ts` — Pi RPC 事件队列与帧分发
- `src/adapters/pi/runtime.ts` — `prompt()`、`waitSettled()` 与 `lastModelError()`
- `src/adapters/pi/pane-worker.ts` — Pi Rex 窗格事件与报告采集
- `src/adapters/antigravity/execution.ts` — `AgySession` 后台回合与追问控制
- `test/pi-runtime.test.mjs` — Pi 运行时与连接测试
- `test/run-pane.test.mjs` — 窗格执行与报告采集测试
- `test/antigravity.test.mjs` — Antigravity 执行会话测试

## 结果

已修复 Pi 与 Antigravity 执行适配器的三处会话采集缺陷：Pi RPC 连接改为单调逻辑序号跟踪并在事件截断后准确匹配本轮 agent_settled 与 lastModelError、waitSettled 改为事件驱动唤醒、invalidFrames 上限收紧为 200 条；Pi 窗格扩展兼容纯字符串助手报告并 trim；Antigravity 每次 prompt 重置 requestedSubmit 并在 close 中关闭后台 stdout readline。6 条完成条件全部满足。主会话在任务 Worktree 复核通过 npm run typecheck、npm run build 及 3 份受影响测试（test/pi-runtime.test.mjs、test/run-pane.test.mjs、test/antigravity.test.mjs 共 109/109 通过，0 失败，0 跳过）；执行者另报告全量 npm test 544/551 通过、0 失败、7 项跨文件系统跳过。未验证：未调用真实模型，均通过协议夹具回归验证。
