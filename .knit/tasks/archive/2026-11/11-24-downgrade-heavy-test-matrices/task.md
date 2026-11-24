---
id: k-47bf688a1643
title: 降级重型测试矩阵并修复沙箱临时目录硬编码，压缩全量测试耗时
status: delivered
stage: null
verification: independent
parent: k-8f1c264937ee
dependsOn:
  - k-518fec960508
priority: P2
createdAt: 2026-11-23T23:26:26.053Z
---

## 目标与范围

落地 `docs/research/file-granularity-and-test-review.md` 第 5.3–5.4 节中“Batch 1b”的核心慢测试重构：将 `work-choice.test.mjs` 与 `run-pane.test.mjs` 中错配在重型 E2E 子进程矩阵里的纯逻辑分支降级为内存/轻夹具直测，并修复 `antigravity.test.mjs` 硬编码 `/private/tmp` 导致沙箱无法运行的缺陷，使全量 `npm test` 耗时稳定压至 ~25–35 秒量级。

**为什么做**：
实测显示 `work-choice.test.mjs`（85.63s+，且因通过 `/bin/sh` 调 `rg` 在无 `rg` 环境下 42/84 用例直接失败）与 `run-pane.test.mjs`（93.16s，10 路 resume 模式全走 3 轮假 Pi E2E）是压死全量测试墙钟时间的两大长尾；同时 `antigravity.test.mjs` 硬编码 `/private/tmp/knit-test-agy-` 导致在受限沙箱环境无法跑通。

**改动范围（范围内）**：
1. **`test/work-choice.test.mjs` 矩阵降级**：
   - 将 28 组对话意图、搜索范围、单点直通、澄清、恢复、范围扩大与换话题重判矩阵改为直接内存调用 `workTurn`、`workQuestion`、`checkSessionTool` 等应用层函数（耗时压至亚秒级），且不依赖宿主机外部 `rg` 二进制即可稳定跑通全部场景。
   - 对 `pi`、`agy`、`workbuddy` 三宿主各保留 2–3 条真实协议端到端冒烟（共 6–9 条），覆盖转录读取、hook 拒绝文案与草稿幂等，不丢弃任何核心不变量。
2. **`test/run-pane.test.mjs` resume 10 路拆分**：
   - 将 `["rpc", "pane", "deleted", "corrupt", "truncated", "rejected", "fresh", "changed", "legacy", "other-agent"]` 10 路全链路循环拆分为：
     - 6 路纯回退条件（`deleted`、`corrupt`、`truncated`、`changed`、`legacy`、`other-agent`）直接调用 `inspectNativeSessionFile` / `prepareRun` 等轻夹具单测验证回退逻辑；
     - 4 路真实进程 E2E（`rpc`、`pane`、`rejected`、`fresh`）继续跑完整 Rex/Pi 进程链路。
   - 保持窗格开窗/最小化/关窗、超时与失败回退后台、Esc 中止续跑、窗格意外关闭记失败、进程树取消与原生续聊系统提示一致等核心不变量全部完整覆盖。
3. **`test/antigravity.test.mjs` 临时目录修复与夹具复用**：
   - 修复第 45 行附近硬编码 `/private/tmp/knit-test-agy-`，改为优先遵循 `os.tmpdir()`（若路径长度触发 macOS Unix socket / sandbox 限制则做受控短路径回退），并按需复用 `k-518fec960508` 提供的模板仓库夹具。

**边界（范围外）**：
- 本任务不合并 68 个测试文件（在 Batch 5 处理），也不重构 `src/` 模块目录结构（在 Batch 2–4 处理）。
- 若需从 `src/application/work-choice.ts` 或 `src/application/run-prepare.ts` 仅导出已有内部纯函数供单测直调，须保持运行行为零变化，不得修改业务语义或削弱安全校验。
- 不修改受保护路径（`.knit/standards/`、`.knit/agents/`、`.knit/workflow.yaml`、`.knit/config.json`）。
- 不运行 `npm run pack:install`。

**验证与交付**：
- 运行 `npm run typecheck` 与全量 `npm test`（实测并汇报改造后 `work-choice.test.mjs`、`run-pane.test.mjs`、`antigravity.test.mjs` 单跑耗时及全量 `npm test` 总耗时）。
- 需独立审查（`verification: independent`），重点核对：降级后的单测与保留的宿主 E2E 冒烟覆盖了原有全部核心不变量，无“偷删断言换速度”现象。
- 完成后改动留在任务分支，待审查通过并由用户授权后交付合并。

## 完成条件

### Requirement: work-choice 测试矩阵降级为内存直调并保留三宿主冒烟
#### Scenario: 全部 28 组判定不变量保留且不再因缺少外部 rg 或反复子进程而超时/失败
- WHEN 改造 `test/work-choice.test.mjs` 并运行 `node --test test/work-choice.test.mjs`
- THEN 全部讨论/单点直通/委派询问/无关已选任务/同意草稿/澄清恢复/换话题重判不变量均由内存单测覆盖，`pi`/`agy`/`workbuddy` 各保留真实协议冒烟，用例全绿且单文件耗时大幅降至数秒内（不依赖外部 `rg`）。

### Requirement: run-pane 拆分 6 路纯回退逻辑并保留核心窗格与续聊 E2E
#### Scenario: 6 路纯回退条件改轻测且 4 路完整续聊与全部窗格行为测试通过
- WHEN 改造 `test/run-pane.test.mjs` 并运行 `node --test test/run-pane.test.mjs`
- THEN `deleted`/`corrupt`/`truncated`/`changed`/`legacy`/`other-agent` 回退条件均被精准断言，`rpc`/`pane`/`rejected`/`fresh` 及全部窗格生命周期与取消不变量保留真实进程覆盖，测试全绿且单文件耗时显著压缩。

### Requirement: antigravity 临时目录遵循 os.tmpdir 且全量测试回归通过
#### Scenario: 消除 /private/tmp 硬编码并验证全量测试耗时下降
- WHEN 改造 `test/antigravity.test.mjs` 并运行 `npm run typecheck` 与 `npm test`
- THEN 临时目录不再硬编码 `/private/tmp`，类型检查与测试通过（如遇沙箱自身限制须如实报告具体受限用例），报告给出 `work-choice`、`run-pane`、`antigravity` 及全量 `npm test` 的实测耗时。

## 待澄清

## 相关资料

- `docs/research/file-granularity-and-test-review.md#53-五大耗时根因精准定位` — `work-choice`、`run-pane`、`antigravity` 瓶颈与沙箱问题说明
- `docs/research/file-granularity-and-test-review.md#54-测试文件收敛与提速改造方案68-29-文件-39` — 具体降级清单与必须保留的不变量
- `test/work-choice.test.mjs` — 待降级的跨宿主工作选择测试
- `test/run-pane.test.mjs` — 待拆分 10 路 resume 的窗格与续聊测试
- `test/antigravity.test.mjs` — 待修复临时目录硬编码的 Antigravity 测试
- `src/application/work-choice.ts` — 工作选择判定逻辑
- `src/application/run-prepare.ts` — 续聊回退与派发准备逻辑
- `src/adapters/pi/native-file.ts` — Pi 原生 JSONL 会话核验逻辑

## 结果

已完成 Batch 1b（重型测试矩阵降级与 antigravity 临时目录去硬编码），3 个完成条件均已满足并通过独立审查（r-356a29ba58b2，verdict: pass）。主要改动：test/work-choice.test.mjs 将原 28 组跨宿主子进程矩阵降级为 26 条内存/应用层直测 + 三宿主各 2 条真实协议冒烟，并通过轻量 POSIX rg shim 消除对宿主机外部 rg 二进制的依赖；test/run-pane.test.mjs 将 11 路 resume 拆为 7 路纯回退轻测 + 4 路完整进程 E2E；test/antigravity.test.mjs 消除 /private/tmp/knit-test-agy- 硬编码改为遵循 os.tmpdir() 并复用 cachedGitProject；审查中直接修复了 test/helpers/git.mjs 多模板 key 触发 MaxListenersExceededWarning 的退出监听问题。

已验证：npm run typecheck 通过；独立审查单跑 test/work-choice.test.mjs 32/32 通过（real 13.72s，原 85.6s+）、test/run-pane.test.mjs 改造项全过（real 41.70s，原 93.2s）；主会话在无沙箱环境于任务 Worktree 内运行全量 /usr/bin/time -p npm test：538 用例中 531 pass、0 fail、7 跨文件系统 skip（real 86.12s，user CPU 从 360.78s 降至 161.77s，含 antigravity.test.mjs 全部 64 条真实 sandbox-exec 用例全绿）。

未验证：尚未在 Rex 终端单独再跑一次全量 npm test；7 条跨文件系统用例因未设 KNIT_TEST_CROSS_DEVICE_DIR 跳过。
