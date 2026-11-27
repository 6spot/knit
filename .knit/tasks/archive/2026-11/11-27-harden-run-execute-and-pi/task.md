---
id: k-1dcd5457fc9c
title: 加固执行主循环异常兜底与 Pi 适配器死锁、断连与续聊
status: delivered
stage: null
verification: independent
parent: k-8d244665f694
dependsOn:
  - k-fc88509c221b
priority: P1
createdAt: 2026-11-27T13:37:26.070Z
---

## 目标与范围

加固执行主循环、Rex 窗格宿主与 Pi 执行适配器的异常兜底、死锁防护、续聊正确性与长会话性能，确保任何运行时异常都不会导致后台 worker 裸崩卡死任务，消除 Pi 的永久死锁与内存膨胀隐患。

### 具体改动与思路

1. **执行主循环与 Rex 窗格加固（`src/application/run-execute.ts`、`src/adapters/rex/pane.ts`）**：
   - 为 `executeRun`、`runAgentSession` 及 `runInPane` 补充外层 `try/catch`：任何非预期同步/异步异常（如 `get_last_assistant_text` 拒绝、读取文件失败、`outcome.json` 损坏）均转为明确失败结算并保证 `finishRun`、`session.stop()` 与清理必执行，同时将原始错误栈记录到 `worker.log`。
   - 续聊失败回退全量会话前，清理残留的 `agy-cleanup-error` 等本次执行临时错误文件，避免毒化随后成功的新会话；区分确定性启动失败（如模型不存在、找不到客户端、钩子冲突）与续聊恢复失败，不对确定性错误盲目再起一遍新会话。
   - `RexPaneHost.call()` 增加命令超时（如 `timeout: 5_000`）；`runInPane` 关闭窗格后对 `await closed` 增加有界超时（超时则终止 `rex wait` 并记入诊断），防止 Rex 守护无响应时永久卡死。
2. **Pi RPC 连接与运行时死锁/断连/性能修复（`src/adapters/pi/connection.ts`、`src/adapters/pi/runtime.ts`）**：
   - 给 `child.stdin` 绑定 `error` 监听器转为 `handleEof()`，消除写入瞬间进程退出触发未捕获 `EPIPE` 崩掉 worker；保留 `child.on("error")` 的 `spawnError` 并在 `PiConnectionClosedError` 与 `diagnostics` 中透出原始原因（如 `ENOENT`）。
   - `handleEof()` 中同步唤醒并清空 `settledWaiters`，`waitForSettled()` 开头同时判断 `this.eofSeen || this.exitInfo !== null`；`PiAgentRuntime.prompt()` 在 `connection.call("prompt", ...)` 明确返回 `response.success === false` 时立即以明确错误结束等待，彻底消除无超时 `waitSettled(null)` 的永久死锁（仍保留 RPC 超时但事件流活跃时的既有等待语义）。
   - 修复 `PiAgentRuntime.start()` 模型校验时机：在 `set_model` 成功后再核对实际生效模型（不再拿 `set_model` 之前的旧 `get_state` 值误报 `model_mismatch`），使续聊期间通过 `--model` 切换模型正常生效；`get_state` 30s 超时抛出异常时附加 `connection.diagnostics`。
   - `PiAgentRuntime.dispose()` 在 `clear_queue` 超时或失败后短路跳过 `abort` 并压缩控制超时，避免卡死进程串行白等 32 秒；`pumpStdout` 改用事件驱动 `waitExit(2_000)` 替代 200 次 10ms 轮询；清理 `runtime.ts` 中生产与测试均未使用的死方法。
   - **长会话内存与事件循环优化**：生产环境默认 `eventLimit: 0`（单测按需传参启用），消除常驻 10 万条无用事件与满额后 `Array.shift()` O(N) 卡顿；`LfFrameDecoder.push` 改用游标推进 + 末尾单次 `slice`，消除大 chunk 多行 $O(N^2)$ 字符串拷贝。
3. **Pi 窗格扩展、原生文件与注册预检（`src/adapters/pi/execution.ts`、`src/adapters/pi/pane-worker.ts`、`src/adapters/pi/native-file.ts`、`src/adapters/agents.ts`）**：
   - `pi/execution.ts` 后台非续聊模式与窗格/续聊保持一致，改为传 `systemFile` 路径替代把 `system.md` 全文塞进 CLI argv，规避 Linux 128KB `MAX_ARG_STRLEN` (`E2BIG`)。
   - `pi/pane-worker.ts` 在 `prompt()` 记录 `sendUserMessage` 前的分支长度，`agent_settled` 仅在新增消息切片中查找助手回复，防止续聊异常无新回复时误把上一轮历史报告当作本轮提交；给 `runPaneSession(...)` 补 `.catch()` 并在异常时 `ctx.shutdown()`。
   - `pi/native-file.ts` 区分空文件（`"empty"`）与非空损坏首行（`"no_session_header"`）；删除全仓零引用的 45 行废弃会话查找死代码。
   - `src/adapters/agents.ts` 为 `pi` 补充 `checkDispatch` 预检可执行文件是否存在，避免建完 Worktree 和跑完 `setup` 后才启动失败。

### 边界与约束

- 不修改 Antigravity 适配器文件（归 `k-223a8907d4e5`），不修改 `infrastructure/process.ts` 或 `run-control.ts`（归 `k-3e85bbaa5d20`）。
- 遵循 `.knit/standards/development.md` 的测试分层原则，测试追加到 `test/pi-runtime.test.mjs`、`test/run-execute.test.mjs`、`test/run-pane.test.mjs`，避免引入不必要的整秒 `sleep`。
- 验证运行 `npm run typecheck`、`npm run build` 及受影响测试文件（`node --test test/pi-runtime.test.mjs test/run-execute.test.mjs test/run-pane.test.mjs`）；因涉及 `run-execute.ts` 执行主流程，建议补跑一次全量 `npm test`。

## 完成条件

### Requirement: 执行主循环与窗格异常兜底
#### Scenario: 会话执行或结果读取抛出异常时仍能完成结算与清理
- WHEN `session.prompt`、结果文件读取或 `outcome.json` 解析抛出异常
- THEN `executeRun` 与 `runAgentSession` 捕获异常、将错误栈写入 `worker.log` 并正常调用 `finishRun` 将执行记为失败，不会让任务永久停在运行中

#### Scenario: 续聊回退清理旧错误且确定性启动失败不盲目重跑
- WHEN 续聊启动前清理残留错误文件，或因模型不存在等确定性错误启动失败
- THEN 回退新会话不受旧 `agy-cleanup-error` 毒化，确定性启动失败直接失败结算不重复起一遍客户端

### Requirement: Pi 适配器无死锁、无 EPIPE 崩溃且续聊准确
#### Scenario: prompt 被拒绝、stdout 提前 EOF 或 stdin 遇 EPIPE 时立即失败不死锁
- WHEN 假 Pi 进程对 `prompt` 返回 `success: false`、提前关闭 stdout 不立即退出、或在写入瞬间退出触发 `EPIPE`
- THEN `PiAgentRuntime` 与 `PiRpcConnection` 干净结束并返回包含诊断/spawn 错误的失败结果，不永久挂死也不崩溃 worker

#### Scenario: 续聊切换模型与窗格分支游标防误交旧报告
- WHEN 续聊会话启动时通过 `--model` 切换模型且 `set_model` 成功；或窗格续聊触发 `agent_settled` 但本轮未产生新助手消息
- THEN 换模型校验通过；窗格不会把上一轮历史助手回复当作本轮新报告提交

#### Scenario: 长会话默认不留存无用事件数组且后台不把 system.md 全文塞进 argv
- WHEN 生产路径创建 `PiRpcConnection` 并处理大量事件与分帧，以及后台启动非续聊 Pi
- THEN 默认不累积 10 万条无用事件数组，且向 Pi 传递系统提示文件路径而非全文内容

### Requirement: 回归验证通过
#### Scenario: 类型检查、构建与测试通过
- WHEN 运行 `npm run typecheck`、`npm run build` 与相关测试（及全量 `npm test`）
- THEN 全部通过

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 第 7 节执行、续聊与 Rex 窗格规则
- `.knit/standards/development.md` — 编码规范与测试效率约定
- `src/application/run-execute.ts` — 执行运行时主流程
- `src/adapters/rex/pane.ts` — Rex 窗格宿主实现
- `src/adapters/agents.ts` — 执行者注册表
- `src/adapters/pi/connection.ts` — Pi RPC 连接与帧解码
- `src/adapters/pi/runtime.ts` — Pi 运行时驱动
- `src/adapters/pi/execution.ts` — Pi 执行适配器入口
- `src/adapters/pi/pane-worker.ts` — Pi 窗格扩展
- `src/adapters/pi/native-file.ts` — Pi 原生会话校验

## 结果

六个场景通过。断连、拒绝和异常均能及时结算并保留失败原因；续聊模型和报告游标准确，长会话按需留存事件。独立审查 r-73c888810800 通过并修正 Rex 等待超时覆盖回执、清理错误覆盖原始故障和 Pi 启动诊断竞态。修正后宿主含第二可写卷的全量测试 637/637，0 失败、0 跳过；类型检查、构建、打包核验及 git diff --check 通过。
