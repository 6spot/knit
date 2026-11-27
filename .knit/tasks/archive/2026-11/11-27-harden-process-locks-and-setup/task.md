---
id: k-3e85bbaa5d20
title: 加固进程身份校验、文件锁、损坏容错与 setup 恢复
status: delivered
stage: null
verification: independent
parent: k-8d244665f694
dependsOn:
  - k-3ad44485c09e
  - k-566ade3a274d
priority: P1
createdAt: 2026-11-27T13:37:26.179Z
---

## 目标与范围

加固进程身份校验、文件锁与快照基础设施的并发与容错边界，修复 `worktree.setup` 中断后永久跳过的状态缺陷并落地用户已确认的可选超时与进度/缓冲保护，同时修复 `runtime-cleanup` 的锁文件竞态与历史归档全量扫描问题。

### 具体改动与思路

1. **进程身份校验、文件锁与文件系统原语（`src/infrastructure/process.ts`、`src/infrastructure/fs.ts`）**：
   - `process.ts`：Linux `readProcStats` 过滤 `fields[0] === "Z"`、macOS `processTablePs` 增加 `stat=` 列过滤以 `Z` 开头的僵尸进程；区分 `ps` 不可用（`result.error != null` 或 `stderr` 非空）与无匹配进程（`status === 1 && !result.error && stderr === ""` 返回空 `Map`），避免已退出进程被误判为 `ps` 不可用；分离 `withFileLock` 中锁获取与 `action()` 的 `try/catch`，防止 `action` 内部 SQLite 错误误报为锁忙；下沉统一的进程组终止原语（供 `run-control`、`pi`、`antigravity` 共用）；`recordedProcess` 捕获 `ENOENT` 与损坏 JSON 安全降级为 `null`。
   - `fs.ts`：`fileFacts` 增加 `if (!stats.isFile())` 安全处理 FIFO/socket 等特殊文件防阻塞崩溃，大文件（如 > 1MB）采用 64KB 固定缓冲分块 `readSync` 流式计算 SHA-256 防高内存峰值；`atomicWrite` 逐段建父目录捕获并发 `EEXIST` 并确认确为目录；`removeCopy` 改用 `lstatSync` 对符号链接直接 `unlinkSync` 不篡改目标权限。
2. **执行控制与并行取消加固（`src/application/run-control.ts`）**：
   - `startRun` 为日志文件 fd 加 `try/finally { closeSync(log); }`，为 `spawn` 绑定 `error` 监听；区分“ps 不可用”与“worker 启动即极快退出”，极快退出时不写 `{ pid, start: null }`（避免退回纯 `kill(pid, 0)` 在 PID 复用后误杀无关进程）。
   - `waitRun` 将递归 `poll()` 改为迭代循环消除长任务 Promise 链增长；缓存稳定 `worker.json` 并在长耗时运行（如超过 30 秒）后适度放宽 `ps` 复核周期降低 setuid `/bin/ps` 频次。
   - `cancelRun` 为等待启动态循环增加有界超时；并行批次取消时共享单次 `processTable()` 并将 `finishRun` 串行化（本就互斥在同一任务锁）；若部分成员在取消前已自然结束，分别汇报“已取消”与“取消前已结束”而不误把整次取消判失败并隐藏其余已取消成员；`taskRunLockHeld` 捕获 `SQLITE_CANTOPEN` 返回 `false`，对 `SQLITE_NOTADB` 给出清晰恢复提示。
3. **`worktree.setup` 恢复、可选超时与派发/结算优化（`src/application/run-prepare.ts`、`src/application/run-finish.ts`、`src/application/project-config.ts`、`docs/design/DESIGN.md`）**：
   - **已定下的 `worktree.setup` 策略**：保持默认不设硬超时（避免大依赖项目首次安装被误杀）；在 `.knit/config.json` 的 `worktree` 下新增可选配置 `setupTimeoutSeconds`（正整数秒，缺省或 `null` 表示不限时，严格校验非法类型与非正数，同步更新 `docs/design/DESIGN.md` 第 2、7 节）。
   - 引入 setup 完成标记（含 `worktree.setup` 命令列表摘要，存在该 Worktree 对应的运行态标记或 Worktree 标记中），仅当标记不存在或 setup 配置变化时运行 setup，彻底修复 setup 中途被中断后因 `.git` 已存在而下次派发永久跳过 setup 的缺陷。
   - 执行 setup 时实时透传进度（避免长时间黑盒静默），并对捕获用于报错的输出做有界尾部截断（替换 `maxBuffer: Infinity`），避免大日志撑爆内存；配置超时且超限时终止 setup 进程组并走 Worktree 回滚。
   - 并行批次中某成员启动失败时兜底结算未启动成员，避免半残状态；同 Agent 并行成员在 `checkIsolation()` 按 Agent 去重（避免重复跑 $2N$ 次预检）；`dependencyProblems` 合并为单次多 ref `git grep` 减少子进程风暴；修正续聊回退日志按 `(stage, executor, agent)` 精确过滤并区分 `resumeBlocked`；修正 `limitNotice` 补齐必填 `--result <总结>` 及依赖合并提示补齐 `--no-edit` 与 `shellQuote`。
   - `before.json` 与 `after.json` 改写为紧凑 JSON 减小落盘体积；`finishRun` 遇损坏 `before.json` 时转为明确失败记录而非抛异常阻塞 `knit run cancel`。
4. **运行目录清理竞态与剪枝修复（`src/application/runtime-cleanup.ts`）**：
   - 修复 `removeExpiredFiles` 在 POSIX 锁临界区内 `unlinkSync(lock)` 的经典 inode 竞态（通过锁内二次 inode 校验或安全回收策略保证互斥不失效）。
   - 隔离活跃任务损坏与 `runs/` 清理错误域（不因单个损坏活跃任务阻断整次清理）；放宽 `endedAt` 校验以兼容标准无毫秒 ISO-8601 时间戳；当 `runs/` 中不存在满足超期条件的候选目录时剪枝跳过全量历史归档 `record.json` 扫描。

### 边界与约束

- 不修改 `src/adapters/antigravity/*`（归 `k-223a8907d4e5`）与 `src/application/handoff.ts`（归 `k-3b3852762282`）。
- 涉及共享基础设施与执行结算核心链路，测试追加到 `test/process.test.mjs`、`test/infrastructure.test.mjs`、`test/config.test.mjs`、`test/run-control.test.mjs`、`test/run-prepare.test.mjs`、`test/run-worktree.test.mjs`、`test/run-execute.test.mjs`、`test/deliver.test.mjs`，并运行 `npm run typecheck`、`npm run build` 及全量 `npm test`。

## 完成条件

### Requirement: 进程判活、文件锁与文件系统原语健壮性
#### Scenario: 僵尸进程、ps 无匹配、FIFO 文件与并发建目录均正确处理
- WHEN 检测已退出的进程或僵尸进程、`fileFacts` 遇到非普通文件或大文件、或并发向新目录执行 `atomicWrite`
- THEN 已退出与僵尸进程均不判活、不误退回无身份校验；`fileFacts` 不阻塞且大文件分块哈希结果一致；并发 `atomicWrite` 不因 `EEXIST` 失败

#### Scenario: withFileLock 与 recordedProcess 容错
- WHEN `withFileLock` 回调内抛出错误，或 `worker.json`/`pane.json`/`before.json` 损坏或并发被删
- THEN `withFileLock` 原样透出业务错误而不误判为锁忙；`recordedProcess` 返回 `null`；损坏 `before.json` 不阻止 `knit run cancel` 将执行记为失败

### Requirement: worktree.setup 可恢复、可选超时与有界输出
#### Scenario: setup 中断后下次派发重新执行并支持可选超时
- WHEN 首次派发创建 Worktree 后 `setup` 中途失败或被中断、或 `.knit/config.json` 配置了 `worktree.setupTimeoutSeconds` 且命令超时
- THEN 仅在 `setup` 完整成功后才写完成标记，未完成时下次派发仍会重新执行；配置超时后超时命令被终止并回滚新建 Worktree；非法 `setupTimeoutSeconds` 值被 `loadConfig` 拒绝

### Requirement: 并行控制、依赖提示与运行目录清理加固
#### Scenario: 并行部分已结束取消、limitNotice 补全参数与清理剪枝
- WHEN 并行批次中部分成员刚自然结束而对其余成员执行 `cancelRun`；或触发返工上限/依赖未合并提示；或交付后执行 `cleanArchivedRuns`
- THEN `cancelRun` 准确汇报已取消与已自然结束的成员；`limitNotice` 命令含 `--result`、依赖合并提示含 `--no-edit` 且路径已引用；清理不因 POSIX 锁 `unlink` 破坏并发互斥并在无超期候选时跳过全量归档扫描

### Requirement: 构建与全量回归通过
#### Scenario: 类型检查、构建与全量测试通过
- WHEN 运行 `npm run typecheck`、`npm run build` 及全量 `npm test`
- THEN 全部通过且无新增失败

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 第 2、7、8.2 节关于 `config.json`、`worktree.setup`、执行恢复与运行目录清理的设计
- `AGENTS.md` — 开发与验证规范
- `.knit/standards/development.md` — 基础设施原语与测试分层规范
- `src/infrastructure/process.ts` — 进程身份、进程树与文件锁
- `src/infrastructure/fs.ts` — 原子写、文件指纹与目录清理
- `src/application/run-control.ts` — 启动、等待与取消控制
- `src/application/run-prepare.ts` — 派发准备、`setup` 与依赖校验
- `src/application/run-finish.ts` — 执行结算
- `src/application/runtime-cleanup.ts` — 运行目录与锁文件清理
- `src/application/project-config.ts` — `config.json` 校验

## 结果

五个场景通过。setup 支持在原工作树重做、配置可选超时，进程组退出后释放锁并保留有界输出；文件锁回收和损坏登记、并行取消及依赖提示均已验证。独立审查 r-4d74bed4d398 通过，宿主最终工作树类型检查、构建、打包核验、git diff --check 通过，跨卷全量 651/651，0 失败、0 跳过。Linux 与 Windows 分支未在对应系统实机运行。
