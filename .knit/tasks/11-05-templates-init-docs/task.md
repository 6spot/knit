---
id: k-402485d91cd6
status: closed
outcome: completed
branch: refs/heads/main
verification: self
parent: k-8ed2dceaaa4d
priority: P2
dependsOn:
  - k-63006e478faa
  - k-9a6dcc91e184
  - k-6c7e0d19a830
order: null
createdAt: 2026-11-05T11:07:48.404Z
title: 模板与 init、删除 workflow.md、文档重写
stage: deliver
---

## 目标

模板、init 与文档收口：生成带注释的 `workflow.yaml`，删除 `.knit/workflow.md`，补上"模板已移除文件"的孤儿报告，并把设计文档改写为配置解释规则。

依据：`../11-05-role-contract-single-source/design.md` §9／§12。

## 交付物

- `assets/templates/.knit/workflow.yaml`（顶部注释写全字段、能力表与常见错误）；`TEMPLATE_SPECS` 增删。
- 删除 `assets/templates/.knit/workflow.md` 与本仓库 `.knit/workflow.md`（内容按 §12 三分搬家，主会话规则已在 `AGENTS.md` 受管块）。
- `src/application/initialization.ts`：新增"模板已移除文件"的孤儿报告（默认只报不删）。
- `docs/design/DESIGN.md` §15.1／§5／§6、`STATES.md` §3/§8、`OPERATIONS.md`、`GLOSSARY.md`、`ROLE-CONTRACT.md`、`docs/README.md`、`README.md` 改写。
- 全文检索 `workflow.md`、`advisory`、`assist`、`四环节`、`role` 残留，逐条判断删除或标注为历史。

## 规则

- 本仓库 `.knit/` 下的项目级文件（`workflow.md`、`workflow.yaml`、`config.json`、`agents/*`）由主会话在实施 run 之外同步；实施 run 不得改 `.knit/`（保护路径，改了就整 run 失败）。
- 实施 run 的改动范围：`assets/templates/**`、`src/**`、`test/**`、`docs/**`、根 `README.md`／`AGENTS.md`。

## 依赖

`k-63006e478faa`、`k-9a6dcc91e184`、`k-6c7e0d19a830`。验证：`npm test` + `knit init --check` 在临时目录实跑。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 实施结果

两次实施 run：`run-d7ad55189d33`（失败：`protected_path_modified`，原因是它同时改了 `.knit/workflow.md`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/*`）与 `run-6140af395b2a`（完成并接收）。`.knit/` 下的项目级迁移按保护路径规则改由主会话在 run 之外完成，并已随本任务提交；实施 run 的内容保持不变。

- `assets/templates/.knit/workflow.yaml`（新增，61 行）：全字段注释、能力表与常见错误说明；`assets/templates/.knit/workflow.md` 删除。
- `.knit/workflow.yaml`（新增）与模板同文；`.knit/workflow.md` 删除；`.knit/config.json` 去掉 `phases.advisory`；`.knit/agents/*` 与模板同步（含 runtimes/pi.md 的 advisory 行）。
- `src/application/initialization.ts`：新增 `orphans`（上次清单记录、当前模板不再生成、文件中仍存在），`init --check` 与执行都只报告不删除，不阻断 ready；`src/cli/init.ts` 输出该报告。
- `src/application/templates.ts`：`TEMPLATE_SPECS` 以 `.knit/workflow.yaml` 取代 `.knit/workflow.md`；受管入口块改写为“流程配置 + 主会话规则”，不再指向 workflow.md。
- `src/application/delivery.ts`：授权来源缺省路径 `.knit/workflow.md` → `AGENTS.md`（优先“Knit 受管入口”段）；`policyVersion` 同源。
- `src/application/informal-check.ts`、`session-service.ts`、`standards.ts`、`contracts/session.ts`、`contracts/context-plan.ts`、`src/ports/infrastructure.ts`：只改口径与注释（角色 → 阶段），行为不变。
- `docs/design/DESIGN.md`（新增 §4“阶段编排（配置驱动）”、§15.1 第 4 条、`phases.<stage>` 说明）、`STATES.md`、`OPERATIONS.md`、`GLOSSARY.md`、`ROLE-CONTRACT.md`、`ARCHITECTURE.md`、`docs/README.md`、根 `README.md`、`docs/history/TASKS.md` 改写为配置解释规则；`ROLE-CONTRACT.md` 文件名保留并注明历史命名。
- `src/domain/workflow.ts`、`test/init.test.mjs`：模板/孤儿报告相关补充与用例。

### 验证（主会话复核 2026-11-05）

- `npm test`：502/502 通过（多次复跑；其中两次出现 1 例间歇失败，见下）。
- `knit workflow validate`：`配置有效；准备 → 实现 → 检查 → 收尾`。
- 仓库内 `knit init --check`：`.knit/workflow.yaml` 与 `.knit/agents/*` 均为“沿用”，`.pi/extensions/knit.ts` 与模板一致，`AGENTS.md` 受管块与 `agentsManagedBlock()` 生成内容逐字一致。
- 临时仓库 `/tmp/knit-p7-init` 实跑 `knit init`：生成 `.knit/workflow.yaml`、无 `.knit/workflow.md`，清单 ready，`workflow validate` 有效。
- `test/init.test.mjs` 覆盖孤儿报告（`.knit/agents/deliver.md`、`.knit/workflow.md` 只报告不删除、不阻断 ready）。
- 全文检索：`workflow.md` 仅剩 `validation/**` 历史证据（按归档材料保留）；`advisory`／`assist` 在 `src/`、`docs/design/`、`assets/` 中已无残留。

### 已知边界

- 本任务的历史分成三个提交：`.knit/` 项目级迁移（主会话，`496d59b`）、文档／模板／代码主体（主会话代提交，`4643bff`）、实施 run 增量与元数据／归档（`knit deliver`）。原因是保护路径不能由 run 修改、且首个失败 run 的改动已落在工作区，`knit deliver` 只收录本次 run 的差异。
- 间歇失败：`test/stage.test.mjs` “runtime 启动失败保留 pi 侧错误细节”偶发在 `stderrTail` 为空时断言失败（约 1/3 全量运行）。该断言依赖 fake-pi 写 stderr 与核心读取之间的时序；`src/adapters/pi/connection.ts` 的 stderr 捕获路径在 P3/P7 未改动，P6 基线 5 次全量通过，本任务未修改该测试。判断为既有竞态，记录待后续单独修复，不阻塞本任务。
- `validation/**` 中的 `workflow.md` 授权示例是历史执行记录（含当时 commit），按约定不改写。

### 交付记录

<!-- knit:delivery:op-410d6e7e2565 -->
- 操作: op-410d6e7e2565
- 时间: 2026-11-05T16:04:19.071Z
- 分支: refs/heads/main
- 授权来源: user 2026-11-05 本会话明确授权：整条链逐任务本地提交（选项 A），不含 push／发布／归档
- 工作提交: 03c61f731f4d94124bf05112e05e194f9b681701
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-05-templates-init-docs

<!-- knit:progress:end -->
