---
id: k-8d244665f694
title: Knit 安全门禁加固、稳定性治理、体验打磨与性能优化
status: delivered
stage: null
verification: none
parent: null
dependsOn: []
priority: P1
createdAt: 2026-11-27T13:25:55.958Z
---

## 目标与范围

在严格守住现行设计第 11 节小核心边界（不引入常驻守护进程、不建 SQLite 任务元数据库、不堆砌冗余配置子命令）的前提下，系统性消除本轮全仓审计核实出的 **P0 安全门禁/数据完整性/进程死锁漏洞**、**多宿主体验断层与高频误伤**、**并发与底层边界缺陷** 以及 **热路径/规模性能瓶颈**。本任务为主任务，只放总体方向、已定下的产品取舍、完整子任务分配与具体处理方案，不直接产出代码；所有改动均在子任务中实施、验证与交付。

### 已确认的核心决定

1. **旧版历史归档不做兼容，直接清理**：Knit 尚为新项目，无历史包袱，可以做破坏性清理。直接删除本仓库 `.knit/tasks/archive/2026-11/` 下 169 份 11 月重写前的旧格式归档（已核实 `11-02-acceptance-gaps` 至 `11-18-h2b-move-next-to-root` 与现存 111 份有效归档零 `parent`/`dependsOn` 依赖，全仓仅 `docs/research/REX-PANE.md` 有一处纯文本提及），不在代码中维护旧版 schema 兼容层。
2. **交接预算优先级重排 + 短文档内联阈值升至 8KB**：保持交接消息展示顺序不变，将 64KB `totalBytes` 的预算分配顺序调整为 `previous-report` > `<worktree-changes>` > `own-last-report` > `plan.md` > `materials`；同时将有 `read` 权限时的短文档内联阈值由 `min(4096, handoff.fileBytes)` 放宽至 `min(8192, handoff.fileBytes)`，并同步更新 `docs/design/DESIGN.md`。
3. **先完成全盘任务分配与处理方案讨论，再启动执行**：先把全部子任务的边界、依赖关系和具体修法讨论定稿，确认主任务 `ready` 后**一次性建好全部 12 个子任务草稿（带完整 `dependsOn`）**供统一审阅，再按波次（无冲突轨道可并行）确认派发；涉及状态推进、改动对比、受保护路径、提交、报告门禁或授权核对的改动单独成任务并设为 `verification: independent`，全局重装与双终端验收单独成收官任务并另行授权。
4. **`worktree.setup` 保持默认不设硬超时，补齐可观测与恢复能力**：遵循现行设计默认不强加硬超时（避免大型项目首次依赖安装被误杀），新增可选配置 `worktree.setupTimeoutSeconds`（正整数秒，缺省不限时）；同时落地 setup 完成标记（防中断后下次派发永久跳过）、实时进度透传以及失败输出尾部截断防 OOM，并同步更新 `docs/design/DESIGN.md` 与 `config.json` 校验。
5. **`task list` 损坏目录展示策略区分活跃与归档**：活跃任务列表（`knit task list`）继续保留损坏目录提示，但最多显示前 5 条，超出时折叠为 `另有 N 个损坏目录未列出`；归档任务列表（`knit task list --archive`）静默跳过损坏目录不展示（按 ID 跑 `knit task show <id>` 仍可精准诊断）；同步更新 `docs/design/DESIGN.md` 第 9 节与对应测试。

### 明确不做的边界

- 不引入常驻后台服务或任务元数据库（靠懒加载、零依赖前置判定和轻量扫描优化耗时）。
- 不对 `python -c`、`node -e` 等通用脚本解释器做静态交付命令拦截（Shell 钩子仅封堵标准 Shell 语法层绕过与误伤）。
- 不新增 `workflow` 修改子命令、交互式 TUI 或看板功能。

### 子任务全盘分配与具体处理方案（共 12 项，分四波）

#### 并行与依赖拓扑

```text
Wave 1（全 independent，P0）：
  T1（k-3ad44485c09e）──▶ T2（k-fc88509c221b）──▶ T3（k-566ade3a274d）
  T4（k-98e125987b31）[与 T1/T2/T3 无文件重叠，可并行]

Wave 2（全 independent，P1）：
  T2 ──▶ T5（k-1dcd5457fc9c）
  T1 + T3 ──▶ T7（k-3e85bbaa5d20）
  T1 + T5 + T7 ──▶ T6（k-223a8907d4e5）

Wave 3（全 independent，P1）：
  T3 ──▶ T8（k-d35eccd06f9d）[可与 T6/T7 并行]
  T1 + T7 + T8 ──▶ T9（k-3b3852762282）
  T4 + T7 + T9 ──▶ T10（k-48ccd026c70d）

Wave 4（收口与发版，P2）：
  T1 + T4 + T10 ──▶ T11（k-f331f86e46a8）
  T6 + T11 ──▶ T12（k-e8f223bea531，verification: none，需单独授权）
```

---

#### 第一波：P0 安全门禁与核心数据完整性止血（全部 `verification: independent`）

- [x] **T1 · `加固受保护路径大小写校验、路径安全与子模块快照（k-3ad44485c09e）`**（`independent`，`P0`，无依赖，`.knit/tasks/archive/2026-11/11-27-protect-paths-and-submodules/task.md`）
- [x] **T2 · `加固报告门禁解析、状态推进与生命周期校验（k-fc88509c221b）`**（`independent`，`P0`，依赖 `k-3ad44485c09e`，`.knit/tasks/archive/2026-11/11-27-harden-report-progress-lifecycle/task.md`）
  - [x] 补充子任务：仅将环节声明的有效 verdict 记为审查结论（k-907f49ffc929），独立审查后先行交付，提交 `660dce0`。两份改动合并后全量测试 615/615 通过。
- [x] **T3 · `加固交付 Git 门禁、空仓库首提交、事务回滚与任务锁（k-566ade3a274d）`**（`independent`，`P0`，依赖 `k-fc88509c221b`，`.knit/tasks/archive/2026-11/11-27-harden-delivery-and-task-locks/task.md`）
- [x] **T4 · `封堵 Shell 交付与派发钩子绕过、消除误伤并加固桌面转录（k-98e125987b31）`**（`independent`，`P0`，无依赖，`.knit/tasks/archive/2026-11/11-27-harden-host-command-and-transcripts/task.md`）

#### 第二波：执行引擎死锁消除、适配器与底层基础设施加固（全部 `verification: independent`）

- [x] **T5 · `加固执行主循环异常兜底与 Pi 适配器死锁、断连与续聊（k-1dcd5457fc9c）`**（`independent`，`P1`，依赖 `k-fc88509c221b`，`.knit/tasks/archive/2026-11/11-27-harden-run-execute-and-pi/task.md`）
- [x] **T6 · `加固 Antigravity 适配器退出、原子卸载、沙箱、背压与 C 跟踪器（k-223a8907d4e5）`**（`independent`，`P1`，依赖 `k-3ad44485c09e`、`k-1dcd5457fc9c`、`k-3e85bbaa5d20`，`.knit/tasks/archive/2026-11/11-27-harden-antigravity-adapter/task.md`）
- [x] **T7 · `加固进程身份校验、文件锁、损坏容错与 setup 恢复（k-3e85bbaa5d20）`**（`independent`，`P1`，依赖 `k-3ad44485c09e`、`k-566ade3a274d`，`.knit/tasks/archive/2026-11/11-27-harden-process-locks-and-setup/task.md`）

#### 第三波：清理旧归档、交接预算升级与多宿主体验对齐（全部 `verification: independent`）

- [x] **T8 · `清理旧版历史归档并优化归档列表扫描与损坏诊断（k-d35eccd06f9d）`**（`independent`，`P1`，依赖 `k-566ade3a274d`，`.knit/tasks/archive/2026-11/11-27-clean-legacy-archive-and-list/task.md`）
- [x] **T9 · `升级交接预算优先级与 8KB 阈值、优化读盘并统一围栏解析（k-3b3852762282）`**（`independent`，`P1`，依赖 `k-3ad44485c09e`、`k-3e85bbaa5d20`、`k-d35eccd06f9d`，`.knit/tasks/archive/2026-11/11-27-handoff-budget-and-markdown-fences/task.md`）
- [x] **T10 · `对齐多宿主上下文与规范指引、补齐预检初始化并修复文档死链（k-48ccd026c70d）`**（`independent`，`P1`，依赖 `k-98e125987b31`、`k-3e85bbaa5d20`、`k-3b3852762282`，`.knit/tasks/archive/2026-11/11-27-align-multi-host-ux-and-preflight/task.md`）

#### 第四波：热路径性能优化、跨环境兼容与收官验收

- [x] **T11 · `优化 CLI 与钩子冷启动懒加载、快照免重算哈希与桌面脚本兼容（k-f331f86e46a8）`**（`independent`，`P2`，依赖 `k-3ad44485c09e`、`k-98e125987b31`、`k-48ccd026c70d`，`.knit/tasks/archive/2026-11/11-27-optimize-cli-startup-and-snapshot/task.md`）
- [x] **T12 · `全局安装新版 Knit、刷新本仓库副本并完成双终端验收（k-e8f223bea531）`**（`none`，`P2`，依赖 `k-223a8907d4e5`、`k-f331f86e46a8`，`.knit/tasks/archive/2026-11/11-27-reinstall-and-dual-terminal-verify/task.md`，执行前须单独取得用户授权）

## 完成条件

- 清单中确认要做的 12 个子任务全部完成交付（有调整或取消的项在清单中标明原因）。
- 本仓库 169 份旧版历史归档已清理，`knit task list --archive` 零报错。
- 现行设计文档（`docs/design/DESIGN.md`、`docs/AGENT-INTEGRATION.md`）、模板、本仓库刷新副本与测试保持一致，双终端全量 `npm test` 通过。

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 现行设计、交接预算、执行、交付与第 11 节不做边界
- `docs/AGENT-INTEGRATION.md` — 多宿主与执行者接入协议及 3 处待修死链
- `AGENTS.md` — 本仓库拆分、高风险独立审查与验证规范
- `.knit/standards/development.md` — 编码风格、文件粒度与测试分层规范
- `.knit/tasks/archive/2026-11/11-27-polish-fixes-and-perf/task.md` — 上一轮三波优化主任务参考

## 结果

原计划 12 个子任务与两项补充修复均已归档并交付本地 main。11 项原定实现及两项补充修复均有独立审查通过记录。已核对交付提交、任务清单、归档及审查结果。改动覆盖受保护路径、报告和交付授权、交付回滚、任务锁、Pi 与 Antigravity 运行、四种宿主指引、交接预算与 CLI 冷启动。旧格式归档清理 169 份（214 个跟踪文件），保留文件经核对一致，完整归档列表零报错。全局 Knit 0.1.0 的 77 个文件与本次构建一致，4 份受管副本刷新，定制工作流已从备份恢复。以项目限定的 Antigravity 1.5.13 通过派发环境预检，PATH 中的 1.5.16 会被拒绝。普通终端首轮的一项超时已通过原子写入夹具 PID 修复。Rex 最终跨卷全量 671/671（36.84 秒），普通终端 671/671（36.64 秒），均为 0 失败、0 取消、0 跳过。各提交、日志与适用环境见同目录 plan.md。
