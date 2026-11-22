---
id: k-c84dae7772e7
title: 隔离 Antigravity 命令临时目录、保留执行环境并加固进程回收与结算
status: delivered
stage: null
verification: independent
parent: k-cdf8de80d14c
dependsOn:
  - k-27f80e26adee
priority: P1
createdAt: 2026-11-22T05:40:36.605Z
---

## 目标与范围

修复 Antigravity 独立命令进程执行（`AgyBroker.runCommand`）与运行收尾清理（`cleanAgyRuntime`／`finishRun`）中的四项缺陷：

1. **为命令进程提供沙箱内独立的临时目录，不再把 `TMPDIR` 指向 Worktree 根**：
   - 现状：`src/adapters/antigravity/broker.ts` 第 167 行将命令进程的 `TMPDIR` 设为 `this.launch.cwd`（任务 Worktree 根目录），且 `src/adapters/antigravity/isolation.ts` 的命令沙箱仅在 `write: true` 时允许写 `this.launch.cwd`。这导致两点问题：
     1. 在 `tools: [read, exec]`（无 `write` 能力的只读测试／验证环节，`agyPreflight` 明确支持该组合）下，`this.launch.cwd` 不可写，命令进程没有任何可写的 `$TMPDIR`，导致 bash here-doc（`<<EOF`）、`node --test`、编译器等需要临时目录的命令均报 `Operation not permitted` 失败。
     2. 在 `tools: [read, write, exec]` 下，命令或测试使用 `os.tmpdir()`／`$TMPDIR` 创建的临时文件直接落在 Worktree 根目录下，若未删除会被 `takeSnapshot` 误记为任务的改动文件（`changedPaths`）。
   - 做法：在本次执行的临时目录 `this.temp`（`/private/tmp/knit-agy-exec-...`）下创建专供命令使用的子目录（如 `join(dirname(this.socketPath), "tmp")`），将命令进程的 `TMPDIR` 指向该子目录，并在命令沙箱 `sandboxProfile` 中允许对该 `tmp` 子目录 `file-write*`（同时保持对 `tool.sock` 和 `run-command` 入口的保护，随 `cleanAgyRuntime` 一起删除）。这样 `tools: [read, exec]` 下命令可以使用 `$TMPDIR` 而无法写 Worktree，`tools: [read, write, exec]` 下 `$TMPDIR` 中的临时文件也不会污染 Worktree 快照。
2. **保留宿主的环境变量（仅剔除主会话私有变量）**：
   - 现状：`AgyBroker.runCommand` 只向命令进程传入 `{ PATH, LANG, LC_ALL, HOME, TMPDIR }`，丢弃了 `USER`、`LOGNAME`、`SHELL`、`TERM` 以及语言工具链变量（如 `GOPATH`、`CARGO_HOME`、`RUSTUP_HOME`、`JAVA_HOME`、`PYENV_ROOT`、`NVM_DIR` 等），与 Pi 适配器 `isolatedEnv`（`src/adapters/pi/runtime.ts`）和 `worktree.setup` 的做法不一致。
   - 做法：命令进程以 `process.env` 为基础，剔除 Pi 主会话遗留变量（复用或对齐 `MAIN_SESSION_KEYS`）并覆盖 `TMPDIR` 为上述独立临时子目录。
3. **处理 macOS 下 `killpg` 的 `EPERM` 错误**：
   - 现状：`AgyBroker.stopCommand()` 在 `child.on("exit")` 和 `socket.on("close")` 中调用 `process.kill(-child.pid, "SIGKILL")` 时只忽略 `ESRCH`。在 macOS／BSD 上，当进程组长已退出或组内仅剩僵尸进程时，`killpg` 会返回 `EPERM`（参考 `src/adapters/pi/connection.ts` 的 `signalProcessGroup` 注释与实现）。未忽略 `EPERM` 会在事件回调中抛出未捕获异常，导致 `worker` 进程崩溃、无法执行 `finishRun`。
   - 做法：`stopCommand()` 同时忽略 `ESRCH` 与 `EPERM`。
4. **加固 `cleanAgyRuntime` 与 `finishRun`，防止并发清理或回收报错阻断终态入账**：
   - 现状：`cleanAgyRuntime` 在 `AgySession.close()`（含 `pane.js` 收到信号退出时）和 `finishRun()` 中都会调用。其中 `unlinkSync(hook)` 和 `readFileSync(locator)` 未容忍并发删除导致的 `ENOENT`；且当 `stopCommandProcesses` 返回非 `null` 时，`cleanAgyRuntime` 直接 `throw new Error(problem)`，在退回 `finishRun` 时未做保护，导致临时目录未删、更严重的是中断了 `saveTask`，使任务永久卡在 `active`（`endedAt: null`）。
   - 做法：`cleanAgyRuntime` 中删除钩子和读取／删除 `agy-temp-path` 时容忍 `ENOENT`；即使 `stopCommandProcesses` 报错，也先继续清理临时目录和定位文件，并在 `finishRun` 中妥善处理 `cleanRun` 异常（例如记录为执行失败原因或写入日志，而不阻断 `saveTask` 写入 `endedAt` 终态）。

边界：不修改受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）。

## 完成条件

### Requirement: 命令进程拥有隔离的可写 TMPDIR 与完整工具链环境变量

#### Scenario: tools 为 [read, exec] 时命令可写 TMPDIR 但不可写 Worktree，且 TMPDIR 文件不计入改动

- GIVEN 环节配置 `agent: antigravity` 与 `tools: [read, exec]`（以及 `[read, write, exec]` 对照）
- WHEN `agy` 通过 `run_command` 在 `$TMPDIR` 中创建临时文件、读取宿主环境变量，并尝试向 Worktree 写入文件
- THEN `[read, exec]` 下写 `$TMPDIR` 和读宿主环境变量成功、写 Worktree 报 `Operation not permitted`；`[read, write, exec]` 下留在 `$TMPDIR` 的文件不出现在执行结算的 `changedPaths` 中

### Requirement: 进程组回收与运行清理不因 EPERM 或并发清理阻断结算

#### Scenario: macOS 进程组信号返回 EPERM 或重复调用 cleanAgyRuntime 时正常完成结算

- GIVEN Antigravity 命令进程退出触发 `stopCommand`，或窗格退出与 `finishRun` 先后／并发执行 `cleanAgyRuntime`
- WHEN `process.kill(-pid, "SIGKILL")` 遇到 `EPERM`，或钩子文件已被前一次清理删除，或进程跟踪器返回非零状态
- THEN 执行进程不抛未捕获异常崩溃，临时目录与钩子文件被清理，`finishRun` 仍将本次执行的终态（`endedAt` 及失败原因）写入 `record.json`

## 待澄清

## 相关资料

- `src/adapters/antigravity/broker.ts` — `runCommand` 的环境变量、`TMPDIR` 与 `stopCommand`
- `src/adapters/antigravity/isolation.ts` — `sandboxProfile` 对命令进程的可写路径限制
- `src/adapters/antigravity/execution.ts` — `cleanAgyRuntime` 的钩子、进程回收与临时目录清理
- `src/application/run-finish.ts` — `finishRun` 调用 `cleanRun` 与写入 `record.json` 终态
- `src/adapters/pi/connection.ts` — macOS `killpg` 返回 `EPERM` 的参考说明与处理
- `src/adapters/pi/runtime.ts` — `isolatedEnv` 剔除主会话私有变量的做法
- `test/antigravity.test.mjs` — Antigravity 沙箱与进程回收回归测试
- `docs/design/DESIGN.md#7-执行` — Antigravity 工具隔离与命令沙箱说明

## 结果

已完成四项加固：1）为 Antigravity 命令进程分配沙箱内独立 TMPDIR 并将默认命令解释器切换为 /bin/ksh -c（设 PWD），使 [read, exec] 下 here-doc 与 /var/folders/25/wn233x_93rv9z2jjm9xzfm_00000gn/T/ 正常可用且不污染 Worktree 快照（同时记录显式调用系统 Bash 3.2 的已知限制）；2）继承宿主环境变量并复用 src/adapters/pi/session-env.ts 剔除 Pi 主会话私有变量；3）加固 cleanAgyRuntime 容忍 ENOENT 并发清理，在删除定位文件前原子落盘回收错误，finishRun 保留错误且不阻断终态入账。完成条件全部满足。独立复审（r-2f63c5cddf64）结论 pass：npm run typecheck 通过，Rex 与普通环境 npm test 各 416/423 通过（0 失败，7 项跨文件系统按环境跳过），真实 macOS 沙箱与跟踪器验证了 here-doc、EPERM 回收与并发清理。未验证：在线模型服务推理（使用协议夹具与真实沙箱/跟踪器验证）。
