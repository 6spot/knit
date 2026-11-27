---
id: k-8a5e3ac33953
title: 消除 run-pane 取消前启动时序用例的并行偶发抖动
status: delivered
stage: null
verification: self
parent: k-b7380720fbf3
dependsOn: []
priority: P2
createdAt: 2026-11-27T00:42:26.810Z
---

## 目标与范围

**要解决的问题**：在全量 `npm test` 并行高负载运行时，`test/run-pane.test.mjs` 中的用例「执行者还没有在窗格里开始就取消时，它不会再开始」多次偶发失败（断言 `!existsSync(join(dir, RUNS_DIR, run.id, "pane.json"))` 失败）。

**根因**：该用例依赖固定 `startDelay: 1500`（1.5 秒睡眠）来制造“窗格已打开但假 Pi 尚未启动登记”的窗口；当 29 个测试文件并发争抢 CPU 时，`start()` + `waitUntil(panes().length === 1)` + `rex.knit("run", "cancel", task.id)` 偶尔超过 1.5 秒，假 Pi 在取消完成前就已经醒来并写出 `pane.json`。

**改动目标**：
- 在 `test/run-pane.test.mjs`（及假 Pi 脚本夹具，如需）中，将该用例改为**确定性门控同步**（例如使用类似已有 `resumeOn` / `waitFor` 的文件信号门控 `startOn`，在取消完成并断言 `!existsSync(pane.json)` 之后才放行假 Pi 继续启动），彻底消除墙钟时间竞态，同时保留完整真实的「窗格已开 → 取消后台进程 → 窗格客户端随后启动发现后台已退出、不发消息也不改文件即退出」路径验证。
- 顺带缩短该用例自身的无意义等待耗时（不再固定空等 1500 ms）。

**明确不做 / 边界**：
- 不削弱被测断言，不跳过真实的 `knit run start` / `knit run cancel` / 假 Rex / 假 Pi 进程登记路径（遵守避坑清单「提速测试时只看单文件耗时或省掉真实登记路径」）。
- 不修改生产代码 `src/`（除非查证发现生产取消竞态本身有 bug，若发现则停止并在报告中说明证据）。
- 不修改 Worktree 中的受保护路径。

## 完成条件

### Requirement: 窗格未启动即取消用例在高并发下稳定通过
#### Scenario: 用例改用确定性信号门控并连续多次全量测试零抖动
- WHEN 连续运行多次 `node --test test/run-pane.test.mjs` 以及全量 `npm test`
- THEN 「执行者还没有在窗格里开始就取消时，它不会再开始」稳定验证取消时 `pane.json` 尚未出现、随后晚启动的窗格进程自动退出且不发消息不写文件，连续复跑全部通过且无固定 1.5 秒墙钟竞态

## 待澄清

## 相关资料

- `test/run-pane.test.mjs` — Rex 窗格执行与取消回归测试

## 验证与交付

- 运行 `node --test test/run-pane.test.mjs`（连续跑 3 次验证稳定性）及全量 `npm test`，全部通过。
- 改动留在任务 Worktree 分支，不自行提交，交由主会话核对并交付。

## 结果

已将 test/run-pane.test.mjs 窗格未启动即取消用例由固定 startDelay: 1500 改为确定性文件信号门控 startOn（同步更新 test/helpers/fake-pi.mjs），并在放行后补充校验晚启动窗格客户端确实登记后自行退出、不发消息也不写文件。验证：node --test test/run-pane.test.mjs 连续 3 轮 30/30 通过；全量 npm test 连续 2 轮 522 通过、0 失败、7 项跨文件系统跳过；npm run typecheck、npm run build、git diff --check 通过。
