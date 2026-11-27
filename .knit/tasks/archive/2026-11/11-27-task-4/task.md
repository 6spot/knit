---
id: k-63d7d10c7b6a
title: 优化 Antigravity 与 Pi 执行适配器后台 I/O 与事件循环阻塞
status: delivered
stage: null
verification: self
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P1
createdAt: 2026-11-27T09:32:24.160Z
---

## 目标与范围

背景：
- `src/adapters/antigravity/execution.ts` 在后台流模式中每收到一行 `agy` 事件就调用同步 `appendFileSync(this.streamFile!, ...)`，高频事件下反复执行同步开/写/关系统调用并阻塞事件循环。
- `src/adapters/antigravity/broker.ts` 在每次 `runCommand` 中都重新构建不变的基础 `sandboxProfile(...)`，并在 `child.on("exit")` 回调内调用同步 `stopCommandProcesses(command)`（内部 `spawnSync` 超时上限 5 秒），会直接冻结整个 Broker 事件循环导致并发工具调用与钩子请求卡顿；同时 `stdout`/`stderr` 转发未检查 socket 是否已关闭或销毁。
- `src/adapters/pi/native-file.ts` 在一次恢复流程中会被 `execution.ts`、`piResumeSystemPrompt`、`runtime.ts` 和 `verifiedPiResumeId` 连续调用多次，对同一份未变化的 1–4 MB 原生会话 JSONL 文件重复全量 `readFileSync` + 逐行 `JSON.parse`。

范围：
1. **Antigravity 流日志异步写入**（`src/adapters/antigravity/execution.ts`）：
   - 后台流模式改用 `createWriteStream(this.streamFile, { flags: "a" })` 顺序写入 `agy.jsonl`（绑定错误防崩溃处理），替代每行同步 `appendFileSync`。
   - 在 `close()` 中等子进程结束与 `stdoutLines.close()` 后，关闭并等待写入流 `finish`/`close` 落盘，确保关闭后读取 `agy.jsonl` 不丢失最后事件。
2. **Antigravity Broker 策略缓存、异步后代回收与 socket 保护**（`src/adapters/antigravity/broker.ts`、`src/adapters/antigravity/isolation.ts`）：
   - 在 `AgyBroker` 实例内缓存基础 `sandboxProfile`（基于不变的 `launch`、`socketPath`、`commandTemp`），仅构建一次供所有 `runCommand` 复用。
   - 在 `src/adapters/antigravity/isolation.ts` 增加异步版 `stopCommandProcessesAsync(scope: string)`（保留既有同步 `stopCommandProcesses` 供同步 `removeAgyRuntime` 使用），错误格式和 5 秒超时与同步版一致。
   - `AgyBroker.runCommand` 在 `child.on("exit")` 中触发异步回收并记下 Promise，`child.on("close")` 等待回收完成后再按既有协议输出 `{ error }` 或 `{ code }` 并结束 socket，避免冻结事件循环且不破坏「先回收脱离父进程的后代再返回退出码」的契约。
   - 向 socket 写入 `stdout`/`stderr`/`error`/`code` 前检查 `!socket.destroyed && !socket.writableEnded`。
3. **Pi 原生会话检查按文件指纹缓存复用**（`src/adapters/pi/native-file.ts`）：
   - 为 `inspectNativeSessionFile` 增加轻量单文件 `stat` 指纹（`dev:ino:size:mtimeNs:ctimeNs`）缓存（可限容如最近 8 条避免常驻内存增长），当目标文件未变更时直接复用解析结果并按需核对 `expectedNativeId`（返回新的结果对象或不可变结果），文件一旦发生任何变更自动重新读取解析。
   - `checkNativeSessionFile`、`piResumeSystemPrompt`、`verifiedPiResumeId` 自动受益，同时保持全部对外签名与返回值语义不变。
4. **测试补充**（`test/antigravity.test.mjs`、`test/pi-runtime.test.mjs`）：
   - 验证 Antigravity 后台流模式写入 `agy.jsonl` 完整不丢行，以及 Broker 回收后代时不阻塞并发请求、socket 提前关闭时不抛错。
   - 验证 `inspectNativeSessionFile` 在同一文件未修改时连续调用（含不同 `expectedNativeId`、`piResumeSystemPrompt`、`verifiedPiResumeId`）只读盘一次，且文件修改后立即重新解析不返回过期缓存。

不在范围内：
- 不改动 `src/infrastructure/fs.ts` 与 `src/application/runtime-cleanup.ts`（留作 4b 单独任务）。
- 不改动 Antigravity 沙箱隔离策略规则本身，只缓存相同的生成结果。

## 完成条件

- `AgySession` 后台流模式不再在每行事件调用 `appendFileSync`，且 `stop()` 返回后 `agy.jsonl` 已完整落盘。
- `AgyBroker` 不再在每次 `runCommand` 重算基础 `sandboxProfile`，`child.on("exit")` 不再同步阻塞事件循环，socket 关闭保护生效且既有后代回收与错误协议测试全部通过。
- `inspectNativeSessionFile` 在文件未变时复用缓存（实测免重复读盘），文件修改后立即失效并重新解析。
- `npm run typecheck`、`npm run build` 及 `node --test test/antigravity.test.mjs test/pi-runtime.test.mjs test/run-pane.test.mjs` 全部通过（如改动影响更多测试一并验证）。

## 待澄清

无。

## 相关资料

- [src/adapters/antigravity/execution.ts](src/adapters/antigravity/execution.ts)
- [src/adapters/antigravity/broker.ts](src/adapters/antigravity/broker.ts)
- [src/adapters/antigravity/isolation.ts](src/adapters/antigravity/isolation.ts)
- [src/adapters/pi/native-file.ts](src/adapters/pi/native-file.ts)
- [test/antigravity.test.mjs](test/antigravity.test.mjs)
- [test/pi-runtime.test.mjs](test/pi-runtime.test.mjs)

## 结果

完成 Antigravity 后台日志流式写入（带背压与关闭落盘）、Broker 基础沙箱策略缓存与异步后代回收及 socket 状态保护，以及 Pi 原生会话检查按 stat 指纹缓存复用；npm run typecheck && npm run build && npm test 全部通过（566/573 通过，0 失败，7 项跨文件系统测试跳过）。
