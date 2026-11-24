---
id: k-280ab15c2a93
title: 按主题合并碎片测试文件、降级冗余 CLI 用例并提速 antigravity 套件
status: delivered
stage: null
verification: independent
parent: k-8f1c264937ee
dependsOn:
  - k-353d74968068
priority: P2
createdAt: 2026-11-24T01:07:19.545Z
---

## 目标与范围

落地 `docs/research/file-granularity-and-test-review.md` 第 5.4 节与第 9 节的 **Batch 5**：按主题将 68 个碎片测试文件收敛至 **27–29 个主题测试文件**，降级剩余参数校验与只读 CLI 子进程重复覆盖用例，同时解决 Batch 1b 实测暴露出的最后一条单文件串行长尾（`test/antigravity.test.mjs` 64 条串行 `sandbox-exec` 用例占去 ~84s），在不削弱任何核心不变量的前提下把全量 `npm test` 墙钟压至 ~25–35 秒。

**为什么做**：
经过 Batch 1a/1b，测试总 CPU 已下降 55%（360s → 161s），但 `test/` 仍残留 68 个按历史子任务拆散的碎片测试文件（如 `task-*.test.mjs` 11 个、`run-*.test.mjs` 13 个、`bridge-*.test.mjs` 7 个、`deliver-*.test.mjs` 5 个），部分只读/参数校验仍反复起 CLI 子进程，且 `test/antigravity.test.mjs` 单文件串行执行锁死了约 86s 的全量墙钟时间。

**改动范围（范围内）**：
1. **按主题合并测试文件（68 → 27–29 个主题测试文件）**：
   - 严格对照 `docs/research/file-granularity-and-test-review.md#54-测试文件收敛与提速改造方案68-29-文件-39` 的 B 表清单合并同主题碎片测试（`workflow`、`task-domain`、`task-lifecycle`、`standards`、`handoff`、`progress`、`run-prepare`、`run-execute`、`run-control`、`deliver`、`bridge`、`bridge-run`、`host-hook`、`init` 等，保留 `test/helpers/` 7 个文件不变）。
   - 严禁在合并过程中丢弃 B 表「必须保留的核心不变量」中的任意一项。
2. **降级剩余冗余 CLI / 子进程用例**：
   - 将 `workflow-thinking` / `workflow-model`、`context`、`task-*`（`new`/`ready`/`close`/`cancel`/`view`）、`deliver-*`（`preview`/`problems`/`commit`）、`host-hook`（`agy` 与 `workbuddy` AST 校验与原话边界）中的纯解析、参数校验与只读分支改为直接调用领域层／应用层函数（毫秒级），各命令与宿主保留少量真实 CLI／钩子端到端冒烟，清除 `application-use-cases.test.mjs` 中已被对应主题文件覆盖的重复路径。
3. **压缩最后一条墙钟长尾 `test/antigravity.test.mjs`**：
   - 保持全部 64 条沙箱隔离、工具白名单、`external` 预检、共享钩子与进程回收不变量完整覆盖；
   - 对互相独立（各自使用独立临时目录、独立 Worktree、无共享全局状态）的用例启用受控文件内并发（如按分组 `describe(..., { concurrency })` 或 `test(..., { concurrency: 4 })`，注意排除或串行隔离可能修改 `process.env` 或共享资源的极少数用例），并将纯预检静态分支按需优化，确保零偶发竞态（至少连续运行 2 次验证稳定性）。

**边界（范围外）**：
- 本任务**不修改** `src/` 业务语义与对外行为（`src/` 收敛已在 Batch 2–4 完成），不修改 `package.json` 的测试入口约定（仍为 `node --test "test/*.test.mjs"`）。
- 不修改受保护路径（`.knit/standards/`、`.knit/agents/`、`.knit/workflow.yaml`、`.knit/config.json`）。
- 不通过跳过或删减核心不变量来凑提速指标；每项删减/合并必须在报告中能对照不变量清单核实。
- 不运行 `npm run pack:install`。

**验证与交付**：
- 运行 `npm run typecheck` 与全量 `/usr/bin/time -p npm test`（在 Rex 环境与普通终端各跑一次，且额外复跑一次 `test/antigravity.test.mjs` 验证并发稳定性），如实记录合并前后测试文件数、全量通过数与墙钟耗时。
- 需独立审查（`verification: independent`），重点对照研究报告 B 表逐组核查核心不变量零缺失、无并发偶发失败。
- 完成后改动留在任务分支，待独立审查通过后交付合并。

## 完成条件

### Requirement: 碎片测试文件按主题收敛且核心不变量零缺失
#### Scenario: 测试文件从 68 个收至 27–29 个并保留全部核心不变量
- WHEN 按研究报告第 5.4 节清单完成全部测试文件合并与冗余 CLI 用例降级
- THEN `test/*.test.mjs` 文件数落在 27–29 个区间（`test/helpers/` 保持 7 个），报告第 5.4 节 B 表列出的全部核心不变量均有对应断言覆盖，各命令与三宿主均保留真实 CLI／协议端到端冒烟。

### Requirement: 消除 antigravity 串行长尾并实现稳定全量提速
#### Scenario: antigravity 连续复跑稳定且全量 npm test 墙钟显著下降
- WHEN 优化 `test/antigravity.test.mjs` 并发／执行效率并连续运行 `node --test test/antigravity.test.mjs` 两次及全量 `/usr/bin/time -p npm test`
- THEN `test/antigravity.test.mjs` 两次运行均全绿无竞态警告或失败，全量 `npm test`（除需 `KNIT_TEST_CROSS_DEVICE_DIR` 的 7 条跨文件系统测试外）全部通过且墙钟耗时显著低于 Batch 1b 的 ~86s 基线（目标 ~25–35s）。

### Requirement: 类型与双终端回归通过
#### Scenario: typecheck 与 Rex／普通终端全量测试均通过
- WHEN 运行 `npm run typecheck` 并在 Rex 与普通终端各运行一次 `npm test`
- THEN 全部检查通过，无失效导入、残留临时文件或未跟踪测试垃圾。

## 待澄清

## 相关资料

- `docs/research/file-granularity-and-test-review.md#54-测试文件收敛与提速改造方案68-29-文件-39` — 测试合并清单、降级方案与必须保留的核心不变量表
- `test/` — 测试与公共夹具目录

## 结果

按研究报告第 5.4 节将 test/*.test.mjs 从 68 个收敛至 29 个主题文件（test/helpers/ 保持 7 个不变），将冗余只读与参数校验 CLI 子进程用例降级为领域/应用层直调并保留全部命令与三宿主端到端冒烟，同时对 test/antigravity.test.mjs 启用受控并发并消除串行长尾。首轮独立审查（r-4a60f715407c）因全量墙钟 52.8s 未达 25–35s 目标退回返工；返工（r-bebecb082e1d）与复审（r-8f896f7ec9a2，verdict: pass）完成后：npm run typecheck 与 git diff --check 通过；Rex 全量 npm test 34.58s（526 通过、0 失败、7 跨卷跳过），普通 Apple Terminal 全量 npm test 34.51s（526 通过、0 失败、7 跨卷跳过，相对原始 HEAD 隔离基线 118.84s 提速 71%）；test/antigravity.test.mjs 连续两次 16.48s/16.75s（65/65 全绿、0 竞态警告）；独立 APFS 卷 KNIT_TEST_CROSS_DEVICE_DIR 复验 deliver-worktree 35/35 全绿（覆盖全部 7 条跨卷跳过用例）；218 处相对导入可解析，残留进程与临时夹具为 0。
