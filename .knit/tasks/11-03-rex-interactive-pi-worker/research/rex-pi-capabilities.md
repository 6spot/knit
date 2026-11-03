# Rex × Pi 能力研究（2026-11-03，本机实证）

## 本机 Rex CLI 实证

- 版本：`rex` 位于 /usr/bin/rex；`rex whoami --json` 连接正常（principal kind=peer, transport=unix）。
- `rex api list --json`：74 个方法。关键方法全部在列：`session.new_layer`、`session.set_layer_state`、`session.float_block`、`session.view`、`session.list_blocks`、`session.describe_block`、`session.close_layer`、`com.superlogical.terminal.process`。
- `rex __internal skill` 官方指南证实：`rex do` 可执行 action/Lua；`rex api events` 子进程长驻订阅；`rex block call process` 查 `last_exit`；label 可自定义并用于发现。
- 结论：参考项目依赖的浮层 API 与本机服务器版本完全兼容，无需上游升级。

## 参考项目 pi-rexagents（固定提交 a2c37938847183e1bee6dca98528ec377052eb47，2026-11-02，MIT License）

固定副本：/tmp/pi-rexagents-k9（研究用，不入库）。

| 文件 | 核对到的行为 |
| --- | --- |
| src/rex.ts | `rex api call`（--autostart=false，15s 超时）；check() 验证 new_layer/set_layer_state/float_block/view 四方法存在；create() 用 session.new_layer + layout.block（flavor com.superlogical.terminal.shell、label、command/cwd/path_prepend、exit.on_completion=false）建浮层（bounds [0.08,0.06,0.84,0.86]，focus:false）；present() 先 session.view 找层，tiled 则 float_block，再 set_layer_state(minimized/normal+focus)；recover() 用 session.list_blocks 按 label 精确匹配（多个匹配报错）；running() 用 terminal.process last_exit===null；watch() 用 `rex api events --json` 子进程。 |
| src/child.ts | worker 扩展：PI_REX_WORKER 环境变量激活；session_start 强制 ctx.mode==="tui" 且 sessionId 与 manifest 一致；owner.json 锁保证单进程；state.json 持久化（status/run 计数/sessionFile/resultRevision）；BridgeServer Unix socket 接受 stop（ctx.abort()+suppress 本轮）与 steer（idle 时 run++ 开新轮、busy 时 deliverAs:"steer" 并入当前轮）；before_agent_start/agent_start 记轮开始、agent_settled 记终态（finishRun 从 session 分支取最后 assistant 消息判定 completed/error/aborted）、ui_prompt_start 置 blocked。 |
| src/transport.ts | worker 侧 socket server：帧协议（长度前缀+JSON，MAX_FRAME 校验），publish() 广播状态，请求-响应带 5s 超时 pending map。 |
| src/state.ts | manifest/state/result 文件布局；reconstruct 从会话条目重建；ENTRY 常量区分 parent/worker。 |
| src/index.ts | parent 扩展：spawn worker（pi 子进程 + PI_REX_WORKER env + --session-id/--session-dir），CompletionOutbox 回传结果，Controller 管理 worker 表与恢复。 |
| src/controller.ts | worker 连接管理、恢复发现、事件订阅循环、consumed revision 去重。 |

## Pi CLI 1.5 公开接口（docs/cli.md、docs/extensions.md，本机 1.5.0）

- `pi --session-id <id> --session-dir <dir>`：预分配原生会话；`--mode text` 默认 TUI（stdin/stdout 为终端时）；`--extension <path>` 加载扩展。
- 扩展 API：pi.sendUserMessage(msg, {deliverAs:"steer"})（busy 并轮/idle 新轮）；ctx.abort()；ctx.mode；ctx.sessionManager（getSessionId/getSessionFile/getLeafId/getBranch）；事件 session_start/before_agent_start/agent_start/agent_settled（aborted 区分）/ui_prompt_start。
- 无 SDK createAgentSession 依赖；全部为 CLI 参数 + 公开 Extension API。

## 与 Knit 链路的映射

- 现有 RPC runtime（src/adapters/pi/runtime.ts）以 `--mode rpc` 驱动；Rex 模式换为 TUI 进程 + worker 扩展桥。阶段报告约定不变，验收链不变。
- 事件驱动：worker 侧状态文件 + socket；host 侧 rex api events 订阅，不用模型轮询；普通进度只更新 state.json 不通知主 Agent。
