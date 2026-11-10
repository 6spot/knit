# 桥接异步化：续做说明（2026-11-10 主会话）

## 现状

run-fbfdaa59b1bf 已取消。它留下的改动在工作区，续做时**在此基础上继续，不要重写**：

- `.pi/extensions/knit.ts`、`assets/templates/pi/extensions/knit.ts`：异步化（`runProcess`、`sleep`、`waitForRun`、观察器 `scheduleObserver`／`observerTick`、`buildTurnContext` 缓存、`cliVersionFacts`）。
- `src/application/session-context.ts`（新）、`src/cli/session.ts`（`session context`）、`src/cli/run.ts`（`run list --active --with-status`）、`src/cli/knit.ts`（命令组懒加载）、`src/application/diagnostics.ts`（`installation-version`）、`session-service.ts`、`status-service.ts`。
- `test/bridge-query.test.mjs`、`validation/main-workflow-gate/deterministic-probe.mjs`：只改了 `await module.default(host.pi)`。

## 取消原因（已由主会话修掉，勿回退）

上一轮两次执行 `node --test test/bridge-query.test.mjs` 各挂约 55 分钟，原因有三个：

1. 阶段环境带 `KNIT_STAGE_RUN_ID`，`task close`／`deliver` 用例按设计报 `stage_context_forbidden` 而提前失败，没走到 `session_shutdown`。
2. 观察器的 `setTimeout` 没有 `unref`，用例提前失败后定时器一直重排，`node --test` 不退出。主会话已在 `scheduleObserver` 加 `state.timer.unref?.()`（两个桥接文件都改了）。
3. 命令没带超时。

另外修了一处回归：`knit_workflow set-tools` 被改成传 `--tools <值>`，CLI 的 `workflow set-tools` 用的是位置参数（只有 `add` 用 `--tools`）；已改回位置参数。

## 跑测试的硬性约定

- 任何测试命令都必须带超时并去掉阶段环境变量，例如：
  `timeout 300 env -u KNIT_STAGE_RUN_ID -u KNIT_RUN -u REX_SESSION -u REX_BLOCK node --test --test-timeout=60000 test/bridge-query.test.mjs`
- 全量用 `timeout 1200 npm test`（脚本已去掉 `KNIT_STAGE_RUN_ID`）。
- 一条命令超时就读输出找原因，不要原样重跑。

## 还没做的事

1. **既有用例在默认预算下失败**：不设 `KNIT_BRIDGE_CONTEXT_TIMEOUT_MS` 时，`bridge-query.test.mjs` 有两个用例（“桥接通知与 turn context 优先标题与阶段名…”与“knit_run action=resume…”）因 `session context` 超过 300ms 且无缓存而拿不到 `sections.knit`。`npm test` 不会设这个变量。处理：测试文件顶部（加载桥接前）把 `process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS` 设成足够大的值，让既有用例走新鲜路径；超时走缓存的行为另写专门用例。不要改默认 300ms。
2. **完成条件要求的三项测试还没写**（写在 `test/bridge-query.test.mjs`，或新建 `test/bridge-async.test.mjs`）：
   - 上下文注入每轮只调一次 CLI（`session context`）：可用包一层的假 CLI／计数日志或环境变量记录调用，断言一次 `before_agent_start` 只产生一次 CLI 进程；并断言超时时返回上一轮缓存且文本含“上下文可能过期”。
   - `knit_run wait=true` 期间可中止：传入 `AbortSignal`，中止后工具及时返回当前状态，run 未被取消（状态仍非 cancelled）。
   - 观察器无活动 run 时退避到 30 秒、有活动 run 时 5 秒；用可注入的时钟或导出的延时函数验证，不要真等 30 秒。
3. **`doctor` 版本诊断测试**：`installation-version` 在版本或 dist 摘要不一致时给出 warn 与“改用本地 dist”提示，一致时 pass。
4. **`run list --active --with-status` 与 `session context` 的 CLI 测试**（放进现有对应测试文件）。
5. **受管基线**：模板与 `.pi/extensions/knit.ts` 必须只差 `__BRIDGE_BASELINE__` 一处；`knit init` 生成的桥接通过既有 bridge 测试。
6. **文档**：DESIGN（桥接每轮上下文、观察器节拍、wait 语义、doctor 项）、OPERATIONS、必要时 ARCHITECTURE 的命令面同步；搜索旧描述（“每 5 秒”“spawnSync”“session resolve、status、material list 三次调用”）并替换。
7. 收尾跑 `timeout 1200 npm test`，报告如实列出 changedPaths（包含上一轮留下的全部文件）。
