---
id: k-223a8907d4e5
title: 加固 Antigravity 适配器退出、原子卸载、沙箱、背压与 C 跟踪器
status: delivered
stage: null
verification: independent
parent: k-8d244665f694
dependsOn:
  - k-3ad44485c09e
  - k-1dcd5457fc9c
  - k-3e85bbaa5d20
priority: P1
createdAt: 2026-11-27T13:37:26.289Z
---

## 目标与范围

全面加固 Antigravity 执行者适配器（含 macOS 命令进程跟踪器 `command-processes.c`），消除进程关闭挂死、Worktree 钩子卸载崩溃锁死、Seatbelt 写权限倒置、转录空行游标偏移、高吞吐命令无背压 OOM 以及进程跟踪器缓冲区溢出与 100Hz 忙等缺陷。

### 具体改动与思路

1. **会话生命周期与共享钩子原子卸载（`src/adapters/antigravity/execution.ts`）**：
   - 后台模式启用 `detached: true`，`close()` 复用 `src/infrastructure/process.ts` 的进程组终止原语，等待 `exit` 事件（而非等待所有孙进程释放管道才触发的 `close`）并在短超时后主动 `destroy()` stdout/stderr 流，彻底消除孙进程继承 stdio 导致 worker 永久挂死。
   - 调整 `updateHook` 卸载顺序：当 `owners` 仅剩当前 `owner`（或为空目录）时，**先 `unlinkSync(hook)` 再删除 `owner` 与空 `owners` 目录**，并允许清理空 `owners` 目录与匹配钩子，确保任意时刻被 `SIGKILL` 中断后仍完全幂等可恢复，不再永久锁死后续派发。
   - 追踪 `childExited` 状态：进程已退出后若再次调用 `prompt()`（如补报）立即返回明确失败而非挂死在新 Promise 上。
   - 后台启动改用 `executorEnv()` 隔离 `PI_*` 等主会话环境变量；加强 `checkResume` 校验（拒绝 `"."`/`".."`、校验会话文件非空/合法）；非续聊模式增加合理的启动健康诊断提示。
2. **转录解析与增量读取（`src/adapters/antigravity/protocol.ts`）**：
   - 修复 `transcriptTurn` 对空文件执行 `"".trimEnd().split("\n")` 得到 `[""]` 将游标错推为 1 从而永久跳过首行的缺陷（先过滤空行或按字节增量）。
   - 将 `transcriptTurn` 升级为基于**字节偏移量**的增量读取（仅读上次偏移之后的新增字节），消除长会话每次 `Stop` 钩子全量重读并解析整份转录的开销。
3. **Seatbelt 沙箱修正与 `agyPreflight` 整理（`src/adapters/antigravity/isolation.ts`）**：
   - 修正 `external=false` 时的写权限倒置：无论 `external` 开关如何，均对 `~/.gemini/antigravity-cli/skills` 禁止写入（或将其移出 `state` 的可写白名单），不留写穿洞。
   - `protectedPath` 与动态链接规则复用 `infrastructure/paths.ts` 悬空符号链接安全语义并容错并发 `ENOENT`。
   - 将过长的 `agyPreflight` 函数按内聚子职责拆理清晰（遵循 `.knit/standards/development.md` 复杂度与文件粒度原则）。
4. **本地命令代理背压与资源防泄漏（`src/adapters/antigravity/broker.ts`）**：
   - `runCommand` 为 stdout/stderr 写入 Unix socket 补充 `pause()`/`drain` 背压控制（与 `execution.ts` 日志流一致），消除大输出命令撑爆 worker 内存的风险。
   - 按进程组终止命令子进程；`spawn` 触发 `"error"` 时及时从 `this.commands` 移除；`accept()` 单行命令完成后关闭 `readline` 接口；清理无主 `pending` 项；`READ_TOOLS` 缺少路径参数时 fail-closed 拒绝而不静默回退为 `cwd`；记录断开连接后的回收错误而不是静默丢弃。
5. **macOS 进程跟踪器加固（`src/adapters/antigravity/command-processes.c`）**：
   - `proc_listpids` 遇 `bytes >= size` 时按 2 倍扩容重试（最多 4 次，使用 `size_t` 与合理上限防溢出），避免并发 fork 超过 64 个子进程即失败。
   - 过滤 `pid == getpid()`，校验 `snprintf` 返回值 `< 0`。
   - 停止循环改为指数退避（10ms → 20ms → 50ms → 100ms）并设最大等待/循环上限，避免遇到不可中断内核 `D` 状态进程时 100Hz 持续扫描烧 CPU。

### 边界与约束

- 不改变 `docs/design/DESIGN.md §7.4` 既定的 Antigravity 隔离模型与工具能力矩阵（`read`/`write`/`exec`/`network`/`external`）。
- 所有 C 代码改动须在 macOS 通过 `npm run build:agy-tracker`（`-Wall -Wextra` 零告警编译），测试追加到 `test/antigravity.test.mjs`。
- 验证运行 `npm run typecheck`、`npm run build`（含 `build:agy-tracker`）及 `node --test test/antigravity.test.mjs`。

## 完成条件

### Requirement: Antigravity 会话关闭、原子卸载与续聊边界
#### Scenario: 孙进程持管道退出不挂死且钩子卸载崩溃后可幂等恢复
- WHEN 后台 `agy` 派生继承 stdout/stderr 的孙进程时调用 `stop()`；或模拟 `updateHook` 卸载中途被中断残留空 `owners` 目录与 `.agents/hooks.json`
- THEN `stop()` 在有界时间内退出不挂死；再次清理或派发可幂等移除匹配钩子而不永久报错锁死 Worktree

#### Scenario: 进程已退出后补报不挂死且环境隔离生效
- WHEN `agy` 进程已退出后再次调用 `prompt()`，或启动后台 `agy` 时宿主环境含 `PI_MODEL` 等变量
- THEN 二次 `prompt()` 立即返回明确失败；后台 `agy` 进程不继承 `PI_*` 主会话变量

### Requirement: 转录增量读取、Seatbelt 写保护与 Broker 背压
#### Scenario: 空转录不跳首行且增量读取仅消费新增内容
- WHEN 首次调用 `transcriptTurn` 时转录文件为空，随后追加第 0 行及后续回合数据
- THEN 首轮后第 0 行完整被读取且不被跳过，后续调用按字节偏移增量读取

#### Scenario: Seatbelt 关闭 external 时 skills 仍禁止写入且 Broker 具备背压与防泄漏
- WHEN 生成 `external: false` 的 Seatbelt 配置，以及通过 `AgyBroker` 运行大输出命令或触发 `spawn` 错误
- THEN `skills` 目录在 `external: false` 下仍不可写；`AgyBroker` 正确施加 `pause`/`drain` 背压并在出错或断开后清理内部表项

### Requirement: macOS 进程跟踪器扩容、编译与退避
#### Scenario: C 跟踪器零告警编译并通过探针与停止回归
- WHEN 运行 `npm run build`（含 `build:agy-tracker`）与 `node --test test/antigravity.test.mjs`
- THEN 零编译告警且全部测试通过

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 第 7.4 节 Antigravity 工具隔离规范
- `.knit/standards/development.md` — 编码风格与文件粒度规范
- `src/adapters/antigravity/execution.ts` — Antigravity 会话与共享钩子
- `src/adapters/antigravity/protocol.ts` — 转录与标记解析
- `src/adapters/antigravity/isolation.ts` — Seatbelt 配置与预检
- `src/adapters/antigravity/broker.ts` — Unix socket 本地命令/钩子代理
- `src/adapters/antigravity/command-processes.c` — macOS 沙箱进程跟踪器源码
- `test/antigravity.test.mjs` — Antigravity 隔离与执行测试套

## 结果

五个验收场景完成。后台会话和持管道的后代有界退出，转录按字节读取，Broker 对慢读客户端施加背压并回收资源，C 跟踪器零告警编译。原生续聊预检校验 ID、普通文件及非空大小，原生客户端负责读取会话内容。独立审查 r-6833d84bae18 通过。专项 75/75，最终宿主类型检查、构建、打包、git diff --check 和跨卷全量 657/657 通过，0 失败、0 跳过。
