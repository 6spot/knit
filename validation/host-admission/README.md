# 宿主桥接准入验证（任务005）

结果：通过。验证日期 2026-11-01；pi 1.4.0（`/home/opc/.pi/agent/bin/pi`）、Node v24.21.0、模型 `magpie/auto/glm-5.3-flash`（本机已选配置，共 4 次真实模型轮次，其余为零模型）。夹具位于 [scripts/](scripts/)，复跑：`python3 scripts/run_admission.py [用例名]`；过程数据在 `.work/`（Git 忽略），结果在 [results.json](results.json)。本目录是隔离验证，不是 Knit 产品桥接；init 生成的最终桥接仍须任务015再次验收。

## 用例与结果

| 用例 | 结果 | 真实模型轮次 | 覆盖 |
| --- | --- | --- | --- |
| schema-and-trust | 通过 | 2 | schema 派生、受信加载、宿主校验语义、真实调用、未受信不加载、ready≠信任 |
| reload-no-duplicate | 通过 | 0 | 公开 reload API、旧监听不重复 |
| result-pipeline | 通过 | 2 | 完整结果连接链路 |

## schema-and-trust

- 参数 schema 由驱动脚本从 `dist/contracts/run.js` 派生（`Type.Object({ runId: Type.String(), phase: Type.Optional(RunPhaseSchema) })`），写入 `/tmp/knit-005-schema.json`，桥接加载时读取注册；派生前先用 `Value.Check` 验证探针（合法/非法相位/错误类型）。证明核心 JSON schema 可从同一 TypeBox 定义生成，无需 SDK。
- 受信项目扩展（`.pi/extensions/knit-bridge.js` + `--approve`）自动加载：`knit-bridge-selftest` 等命令出现在 `get_commands`。
- **宿主校验语义（实测）**：`ctx.executeTool("knit_status", args)` 走宿主校验层（pi-ai `validateToolArguments`）。`runId: {deep:1}`（对象）与 `phase: "nope"`（超出联合字面量）被拒：返回 `isError: true` 的 error result，不抛错、不到达工具 execute；但 `runId: 123` 被 `Value.Convert` **强转为 `"123"` 后放行**。结论：宿主参数校验不是严格拒绝语义，桥接工具对强标识字段（run ID 等）必须在 execute 内再做白名单/格式校验（本桥 `readRunResult` 的 `^[A-Za-z0-9_-]+$` 即此用途）。
- 真实模型按 schema 成功调用注册的 `knit_status` 工具（`tool_execution_end` 无错误），TypeBox 内存自测不代替的宿主兼容验证由此覆盖。
- 未受信同项目（`--no-extensions --no-approve`）不自动加载桥接；`.knit/.runtime/installation.json` 的 ready 标记存在但不改变加载行为——安装 ready 不冒充项目信任。

## reload-no-duplicate

- 命令处理回调里 `await ctx.reload()` 公开 API 重载成功；重载后每条命令仍只产生一条事件（旧监听未重复）、工具注册计数为每次加载一次。零模型调用。

## result-pipeline（worker 结果 → 宿主通知完整链路）

夹具链路：worker 回执文件 `.knit/.runtime/runs/<runId>/result.json` → 桥接 1s 只读轮询 `status.json` → 来源核对（`originSession` 必须等于当前会话）→ 终态判定（completed/cancelled/failed）→ 按会话内 `knit-005-evt` 条目去重 → `sendMessage` 投递 → `appendEntry` 持久化通知回执。全部验证通过：

1. 无结果/非终态不投递；
2. 终态被动通知（`triggerTurn: false`）真实到达会话消息且**零模型轮次**；
3. 同一 run 重复轮询只投一次（去重依据会话持久化条目）；
4. wake 通知（`triggerTurn: true`）实际启动模型回合（token 从 0 增长，模型回复确认）；
5. 忙时走 follow-up 队列：当前工具回答先于排队通知，不抢输入；
6. `originSession` 不匹配的结果不投递（来源守卫）；
7. 回调前切换会话：新会话收不到旧会话通知，旧轮询随 `session_shutdown`/上下文变化停止。

## 实测发现的宿主约束（产品桥接设计输入）

| 约束 | 证据 | 产品处理 |
| --- | --- | --- |
| 项目扩展发现只认 `.ts`/`.js`，不认 `.mjs` | pi loader.js:585；`.mjs` 放入项目目录未被加载 | init 模板生成 `.ts`/`.js` 桥接文件 |
| 校验层 `Value.Convert` 强转兼容原始类型 | `runId: 123` 放行为 `"123"` | 强标识字段在工具 execute 内二次校验 |
| 校验失败返回 `isError` result 而非抛错 | `AgentToolCallOutcome.isError`（pi-agent-core types.d.ts:394） | 错误呈现按 outcome 判定，不用 try/catch 包 executeTool |
| 命令回调 ctx 无 `executeTool`（仅工具 execute 的 ctx 有） | types.d.ts:280 vs ExtensionCommandContext | 参数自测须放在工具内部，不能挂命令 |
| 扩展运行时可解析宿主提供的 `typebox` 模块 | 桥接 `import { Type } from "typebox"` 实测可用 | 桥接 schema 构造不需额外依赖，但仍不引入 Pi SDK |

## 边界

- 桥接轮询读取的 `status.json`/`result.json` 由验证驱动模拟 worker 与核心写入；`knit status --run --json` 产品命令与 run 证据真实落盘在产品实现后按同一链路验收。
- 会话切换只验证了 `new_session`；树切换/分支切换在产品桥接实现后复验。
- 本夹具的桥不处理并行 run、通知重发窗口与持久化未知场景（产品按 DESIGN 9.3 实现）。
