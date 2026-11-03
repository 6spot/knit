# Rex 交互式 Pi Worker 架构方案（冻结 2026-11-03）

研究依据：本机实证 + 参考项目固定版本，详见 research/。本文件是本任务实施的唯一架构依据。

## 实证能力（本机 rex CLI 2026-11-03）

- `rex api list --json` 返回 74 个方法；浮层 API 齐全：`session.new_layer`（带 `layout.block` 直接创建终端块）、`session.set_layer_state`（minimized/normal/focus）、`session.float_block`、`session.view`、`session.list_blocks`、`session.describe_block`、`session.close_layer`。
- `com.superlogical.terminal.process` 方法读块内进程 `last_exit`（null=运行中）。
- `rex api call METHOD JSON`（`--autostart=false`）同步调用；`rex api events`（子进程长驻 stdout JSONL）订阅事件。
- 块 label 可携带身份；`session.list_blocks` 按 label 匹配可恢复发现。

## 参考项目（pi-rexagents @ a2c37938847183e1bee6dca98528ec377052eb47，MIT）

- parent 扩展（controller）与 worker 扩展（child.ts）通过 worker 侧 Unix Socket JSON-RPC 通信：`stop`（ctx.abort()，suppress 本轮）与 `steer`（pi.sendUserMessage(msg, {deliverAs:"steer"})，busy 时并入当前轮、idle 时开新轮）。
- worker 扩展以 `PI_REX_WORKER` 环境变量激活；session_start 校验 `ctx.mode === "tui"` 与 manifest.sessionId 一致，owner.json 进程锁保证单实例。
- 状态文件 state.json（status: idle/running/blocked/completed/error/aborted、run 计数、sessionFile、resultRevision）；每轮结束 settle 写 result 文件（从 session 分支条目提取最后 assistant 消息判定 outcome）。
- 事件驱动：`before_agent_start`/`agent_start` 记轮开始，`agent_settled` 记轮结束（aborted 区分），`ui_prompt_start` 置 blocked；parent 通过 `rex api events` 订阅 + state.json 轮询兜底。
- 复用判定：worker 侧 identity（instance id）+ socket 端口文件；parent 侧按 label 恢复发现浮窗。

## 与 Knit 现有链路的关系（关键决策）

1. **Rex 模式 = stage-runner 的另一种 runtime 呈现，不是第二套调度器**：task/run/session 状态机、输入冻结、快照、锁、验收、completion 全部复用现有实现。区别仅在 worker Pi 进程以 TUI 模式运行于 Rex 浮层，prompt 输入经 worker 扩展注入（等效 runtime.prompt），结果仍走既有验收链。
2. **阶段报告协议不变**：worker 扩展加载项目 .knit/agents/ 角色指令（knit.ts 桥接已在项目中），阶段完成的结构化报告仍由 worker 在其 TUI 会话内按现有报告约定产出并由核心按 run-acceptance 接收。Rex 通道只承载：steer 指令、stop 取消、blocked 请求、状态/结果回传。
3. **进程组织**：主会话（host pi + knit.ts 扩展）经 `knit run implement --rex` 派发 → knit core 校验/冻结/建 run（现有逻辑）→ spawn `rex api call session.new_layer`（命令：`pi --session-id <预分配UUID> --session-dir <root>/.knit/.runtime/pi-sessions --mode text` + worker 扩展 + KNIT_RUN 环境变量）→ 浮层默认 minimized 于右下 bounds。
4. **身份关联**：run 目录（.knit/.runtime/runs/<runId>/）存 rex.json：{sessionId, blockId, layerId, label, socketPath}。label = `knit <runId>`（截断 60 字符）保证 list_blocks 可恢复发现。worker 扩展 session_start 校验 manifest.sessionId === ctx 会话 ID。
5. **恢复语义**：主会话重入时 knit core 读 run 状态 + rex.json → `session.list_blocks` 按 label 发现浮窗；发现且进程活 → 重新关联（不重启）；发现但进程退出 → 按 run 状态判终态；未发现 → 按 run 目录记录判终态（进程已死不误记失败，先读结果文件）。
6. **Local 不退化**：不传 `--rex` 时走现有 RPC 链路，零改动。Rex 模式为独立 adapter（src/adapters/rex/），不修改现有 PiAgentRuntime 行为。
7. **真机验收边界**（按任务定义维持延期）：本机为 Linux 无 GUI Rex 客户端，浮层创建/最小化/展开/焦点等 UI 行为本轮仅代码路径 + 单元级验证（rex CLI 调用层 mock/记录），真实验收场景表在用户指定的 macOS 环境执行；对应验收步骤在本任务关闭时按既有决策记 blocked，不宣称通过。

## 实施拆分（本任务内三步，逐项可验收）

- **S1 通信层**：`src/adapters/rex/bridge.ts`（worker 侧 Unix socket JSON-RPC server：steer/stop/status；帧协议参考 transport.ts，MAX_FRAME 校验）+ state.json/result 文件读写（`src/adapters/rex/state.ts`）。
- **S2 worker 扩展**：`src/adapters/rex/worker-extension.ts`（编译产物 + assets 模板双注册：PI_KNIT_REX_WORKER 激活；session_start 校验 mode=session 身份、acquire owner 锁、起 bridge；before_agent_start/agent_settled/ui_prompt_start 生命周期映射；settle 提取 assistant 消息按现有报告文件约定写结果）。
- **S3 rex host 层**：`src/adapters/rex/host.ts`（RexApi 封装：api call/list/events、newLayer/setLayerState/floatBlock/view/listBlocks/process；能力探测缺方法报错）+ `src/application/rex-launcher.ts`（stage-runner 的 Rex 分支：冻结校验后 spawn 浮层、写 rex.json、事件驱动等待结果、恢复发现；`knit run <phase> --rex` CLI 开关）+ 测试。

## 不做

- 不建第二套 Run/Session 状态机；不改 completion/验收资格；不引 Pi SDK；不建守护进程；不做非 Rex 环境的浮窗模拟；不实现录屏复刻 UI。
