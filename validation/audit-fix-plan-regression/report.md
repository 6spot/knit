# 审计修复总计划回归复跑（k-2c0d10318898）

- 执行者：主会话，2026-11-10。
- 基线：提交 `de6b4c7a985596e71703615a9d01e937a10e2fa3`（13 个子任务与 `k-3cdf35cd9d45` 均已交付并推送）。
- 对象：`.knit/tasks/11-07-audit-fix-plan/plan.md` 第 5 节的 12 条回归场景，对应审计发现 F1–F4、S1–S8。

## 环境

- Linux aarch64（kernel 6.12.0-208.112.5.el9uek.aarch64）、Node v24.21.0、npm 11.19.0、git 2.52.0。
- 每条场景在系统临时目录新建 Git 项目，只通过编译产物 `dist/cli/knit.js` 的公开命令驱动。
- 阶段 Agent 用 `test/fixtures/fake-pi.mjs` 代替真实模型，Rex 用 `test/fixtures/fake-rex.mjs` 代替。
- `HOME` 与 `KNIT_KEYS_ROOT` 指向临时目录，不读写本机 `~/.knit` 下的锁与凭据密钥。

## 命令与结果

| 命令 | 结果 |
| --- | --- |
| `node validation/audit-fix-plan-regression/probe.mjs` | 61 条断言全部通过，退出码 0；同一提交上复跑一次，逐行输出相同 |
| `npm test`（typecheck、build、`node --test "test/*.test.mjs"`） | 711 项全部通过，退出码 0 |
| `git diff --check` | 通过 |

探针逐条输出见 [probe-output.txt](probe-output.txt)，带实际值的结构化结果见 [probe-output.json](probe-output.json)。

## 逐场景结果

| 场景 | 对应发现 | 断言 | 实际结果 |
| --- | --- | --- | --- |
| 1 阶段内 `git commit` | F1 | 4/4 | run 失败，原因 `head_moved_during_stage`；任务不前进，scope 不变 |
| 2 写受保护运行时路径与 ignored 目录 | F1 | 6/6 | 写 `.git/hooks/pre-commit`、`.knit/.runtime/checks/x.json` 均判 `protected_runtime_modified`；写 `node_modules/` 正常接收，`ignoredChanges` 有记录 |
| 3 改动归属 | F2 | 7/7 | 用户写入且 Agent 未列的文件进 `externalChanges`，不进 scope 和产物提交；Agent 列出但非工具写入的路径挂起为 `unattributed_paths`，`run accept --include` 确认后并入；`--include` 其它路径以 `path_not_unattributed` 拒绝 |
| 4 失败 run 残留 | S3 | 3/3 | 第一轮以 `changed_paths_mismatch` 失败，文件留在工作区；第二轮声明继承后接收成功 |
| 5 检查阶段写入约束 | F3 | 8/8 | `[read, exec]` 检查阶段写文件判 `write_without_capability`；允许写的检查阶段修复后 pass，完成与交付都被 `check_self_modified` 拒绝；无改动复查 pass 后可完成，提交标注 independent 与检查 run |
| 6 空 scope 的 self 任务 | F4 | 4/4 | `task close` 与 `deliver` 都报 `empty_scope`；`--no-artifacts --reason` 后可完成，交付标注无产物提交 |
| 7 杀掉 worker | S1、S2 | 5/5 | 下一条命令不需手工 unlock 即成功，残留锁有回收记录；`resume` 启动的新 run 真实执行并被接收 |
| 8 auto 模式 Rex 未报到 | S7 | 3/3 | 同一 run 回退 local 并完成接收，保留 Rex 启动失败诊断 |
| 9 clone 后 rebind | S6 | 5/5 | `task list` 指出绑定缺失，rebind 前不能派发；`task rebind` 后可实施、完成并交付 |
| 10 凭据、调用边界与 hooks | S8 | 8/8 | 篡改检查凭据或完成凭据，交付与关闭都以 `credential_tampered` 拒绝且无提交；worker 环境中调用 `deliver` 报 `stage_context_forbidden`；交付成功，植入的 hook 一次也没执行 |
| 11 运行中编辑输入区 | S4、S5 | 4/4 | run 期间可以 `task new`；未声明 `--run` 的 `task update` 报 `task_busy`；用户编辑输入区后接收判 `stale_input`，结果与工作区保留 |
| 12 tools 语义 | 中等 2 | 4/4 | `tools: []` 启动参数含 `--no-tools`；`tools: all` 与不写都不传 `--tools`／`--no-tools` |

## 设计文档一致性

核对范围是 `docs/design/` 下的 DESIGN、STATES、OPERATIONS、ROLE-CONTRACT。方法是把本计划引入的原因码逐个与 `src/` 对照，并搜索被替代的旧说法（tools 缺省、手工 unlock、resume 只准备、hooks 处理）。

发现并修正两处：

- `DESIGN.md` 第 14.1 节仍写“保留现有 Git hooks”，与第 10.2 节的 `delivery.hooks` 缺省 `skip` 矛盾。已改为：Knit 不修改、不删除仓库 hooks，是否执行由 `delivery.hooks` 决定。
- `path_not_unattributed`（`src/application/run-acceptance.ts`）在设计文档中没有出现。已在 `OPERATIONS.md` 的接收步骤补一句。

其余原因码在设计文档中都有对应说明：`head_moved_during_stage`、`protected_runtime_modified`、`unattributed_paths`、`write_without_capability`、`check_self_modified`、`empty_scope`、`credential_tampered`、`credential_unsigned`、`stage_context_forbidden`、`stale_input`、`rex_worker_not_started`、`changed_paths_mismatch`、`binding_missing`、`task_busy`、`workspace_busy`。

## 未覆盖

- 真实模型、真机、Rex 实机和 macOS 上的运行没有在本次复跑中验证；探针只用假 Pi 与假 Rex。
- `npm test` 中的真实模型冒烟用例（`受控工具取消`）在子任务阶段出现过一次 180 秒超时，单独重跑和之后的全量运行都通过；它依赖模型响应，仍可能偶发。
