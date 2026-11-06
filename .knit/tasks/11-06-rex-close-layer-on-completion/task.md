---
id: k-1b0c477f4bc6
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-06T09:15:06.037Z
title: Rex 阶段结束自动关闭浮层
---

# Rex 阶段结束自动关闭浮层

## 目标与边界

用户报告：Rex 呈现的阶段 run 正常结束后，Rex 浮层没有关闭。本轮决定建任务修复，默认在正常结束后自动关闭本次 run 的浮层。

已定位的根因（实施前复核，不直接当结论）：

- `src/application/stage-runner.ts` 的 `executeRexStage` 收尾只调用 `launcher.dispose()`。
- `src/application/rex-launcher.ts` 的 `dispose()` 明确“不改变浮层”，只停 watch、关 bridge。
- `session.close_layer` 只在 `terminate()` 中调用；`terminate()` 仅由创建失败、取消宽限、启动超时、stop 等异常／取消路径触发。
- worker 扩展的 `closeOnSettle` 只调用 `context.shutdown()` 结束 Pi TUI；`newLayer` 使用 `onCompletion: false`，Rex 不会自动关闭 layer。

目标：阶段 run 到达终态（completed／aborted／error，含恢复发现已完成的路径）后，自动关闭本次 run 的 Rex 浮层；取消与终止语义保持不变。

边界：

- 只关闭本 run 通过 `rex.json` 关联的 layer（优先 `layerId`，缺失时按 `blockId` 反查），不按 label 冒认、不关闭其他窗口或 layer。
- 不改 run 状态机、结果文件、恢复发现、`knit doctor` 与 local 路径；不引入新依赖。
- `closeOnSettle`（默认 true）为 true 时关闭；显式 false 时保留（测试／调试）。若实施发现该开关语义不适合承载浮层关闭，可在任务记录说明并采用等价命名，但默认行为必须是关闭。
- 关闭失败只记录／忽略，不把已经完成的 run 改成失败，也不覆盖已落盘结果。

## 完成条件

- 新增或复用关闭浮层方法：按 association 的 `layerId` 或 `findLayerForBlock(blockId)` 调用 `session.close_layer`；幂等；`terminate()` 已关闭时不重复调用。
- StageRunner 的 Rex 分支在终态收尾调用关闭；正常 completed、aborted／cancelled、`rex_worker_error`、discovery completed／exited 路径都覆盖；取消路径不重复关闭。
- 取消仍先走 stop／terminate；`dispose()` 仍只释放 bridge／watch，不复用为关闭语义。
- 测试（`node --test`）：
  - 正常完成时 fake rex 收到一次 `session.close_layer`；
  - `closeOnSettle=false` 或 `terminate()` 已执行时不重复调用；
  - 取消／超时路径仍关闭一次；
  - 关闭失败不使已完成 run 变成失败。
- 文档：在 DESIGN.md／OPERATIONS.md 现有 Rex 段落补一句浮层生命周期（创建即 minimized；终态关闭；取消／失败同路径），不新增设计概念。
- 回归：`npm test` 通过，至少覆盖 `test/rex.test.mjs` 的相关用例。

## 输入引用

- 用户报告：“集成的 Rex 存在一点问题，就是结束了没给关掉”；本轮选择：建任务，正常结束后自动关闭浮层。
- 代码：`src/application/rex-launcher.ts`（execute／dispose／terminate、newLayer 的 onCompletion）、`src/application/stage-runner.ts`（executeRexStage）、`src/adapters/rex/worker-extension.ts`（closeOnSettle）、`src/adapters/rex/host.ts`（closeLayer）。
- 规范：`docs/design/DESIGN.md` 第 5 节 REX 呈现、`docs/design/OPERATIONS.md` 第 5 节、`docs/design/ARCHITECTURE.md` 模块职责、`AGENTS.md` 的验证与提交边界。
- 现有测试：`test/rex.test.mjs`（正常完成、取消、恢复发现与 fake rex 调用记录）。

## 验证方式

self：实施者运行 `npm test`，在报告写 `changedPaths` 与 `validation`；独立复核不强制。

## 交付阻塞修复（change）

交付预检的限定范围凭据扫描在 `test/rex.test.mjs` 命中 `generic_secret_assignment`：取消用例给 `writeCancel` 的 `token` 字段写了可被模式识别的合成字面量。它不是真实凭据；不修改扫描器，也不保留会被误判的写法。

实施范围：

- 只改该处测试值，改成运行时拼接的短段组合（保持 `writeCancel` 收到非空字符串），取消用例的语义与断言不变。
- 不修改 `src/contracts/credentials.ts`，不改其他测试与业务代码。
- 重新运行 `TMPDIR=/tmp node --test test/rex.test.mjs` 与 typecheck；`changedPaths` 仍应只包含本任务既有文件。

## 增量实施约束（clarify）

工作区已包含上一轮 5 个文件的改动，上一轮实施结果已接收并进入 scope。本次 run 为增量修复，重新派发原因是 `changed_paths_mismatch`：报告列出了 5 个路径，但本轮实际只改 `test/rex.test.mjs`。

- 只把取消用例中被扫描器命中的合成 token 字面量改为运行时拼接（保持 `writeCancel` 收到非空字符串），其他测试与业务代码不动。
- `changedPaths` 必须且只能列 `["test/rex.test.mjs"]`；不要列出另外四个已在 scope 中的路径。
- 验证以 `TMPDIR=/tmp node --test test/rex.test.mjs`、typecheck 和凭据扫描为准；不需要重复跑全量套件。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## 主会话复核（verification=self）

- `npm run -s typecheck`：pass。
- `env TMPDIR=/tmp -u REX_SESSION -u REX_BLOCK node --test test/rex.test.mjs`：15/15 pass。默认 macOS `TMPDIR` 下 3 个 Rex bridge 用例因 Unix socket 路径过长失败，与本次改动无关。
- `env TMPDIR=/tmp npm test`：522 tests，518 pass，4 fail；失败集中在 pi-runtime（kill EPERM）、host-selection（fake rex 环境）、task adopt（/tmp 与 /private/tmp）与 worktree connect（/var 与 /private/var），均为未改动模块的 macOS 环境问题。
- 真实 Rex 核对：实现 run `run-075baf73a565` 完成后其 layer／block 仍在（复现原问题，该 run 使用修复前 dist）；对该 layer 调用 `session.close_layer` 后，`session.list_blocks` 不再返回该块，确认关闭 API 在真机可用。
- 未观察项：尚未用修复后代码跑一次完整的真实 Rex 阶段并观察自动关闭；自动化测试已断言 StageRunner 终态调用一次 `closeLayer`。
- 范围核对：改动仅 `src/application/rex-launcher.ts`、`src/application/stage-runner.ts`、`test/rex.test.mjs`、`DESIGN.md`、`OPERATIONS.md`；无提交／推送。

## 真机端到端复核与交付准备

- 增量 run `run-95142c769fdb`（本地修复后 dist，`--rex` 显式）completed／implementation_accepted；终态后 `session.list_blocks` 不再包含 `knit run-95142c769fdb`，自动关闭浮层在真实 Rex 上生效。
- 之前由全局安装版本派发的 `run-5c6d69d23f06` 终态后浮层仍在，已手动关闭；根因是桥接 `knit_run` 使用 `.knit/.runtime/installation.json` 的 `cliEntry`（全局安装），不是仓库 `dist/`。后续需要用含修复的包刷新全局安装，`knit_run` 才会走新代码。
- 凭据扫描：5 个改动文件 `scanCredentials` 均为 0 命中。
- scope：5 个路径 digest 与当前工作区一致；`test/rex.test.mjs` 已更新为运行时拼接值。
- 全量 `npm test` 仍有 4 个既有 macOS 环境失败（pi-runtime EPERM、host-selection PATH、task adopt／worktree 的 /private 路径），与本次改动无关。
- 交付前工作区改动未提交；下一步按用户授权提交、推送、归档。

### 交付记录

<!-- knit:delivery:op-ac2b10a52869 -->
- 操作: op-ac2b10a52869
- 时间: 2026-11-06T09:42:58.985Z
- 分支: refs/heads/main
- 授权来源: user:chat#提交推送归档
- 工作提交: 199004d68a5e5bb6ddcc656672a10581c6a03050
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-rex-close-layer-on-completion

<!-- knit:progress:end -->
