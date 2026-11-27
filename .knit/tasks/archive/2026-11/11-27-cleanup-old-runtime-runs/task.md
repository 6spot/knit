---
id: k-3784428adeda
title: 交付成功后清理已归档任务的超期运行目录
status: delivered
stage: null
verification: independent
parent: k-b7380720fbf3
dependsOn: []
priority: P1
createdAt: 2026-11-27T00:42:26.571Z
---

## 目标与范围

**要解决的问题**：`.knit/.runtime/runs/` 目录只增不减（仅半个月已堆积 109 个目录、超 100 MB），但按现行设计第 11 节不希望恢复重型的 `knit gc` 命令。需要一种克制、安全的内嵌清理机制，避免本机运行目录无限膨胀。

**改动目标（涉及交付链路与文件删除，本任务要求独立审查）**：
1. **在 `knit deliver` 成功后轻量化清理已归档任务的超期运行目录（`src/application/delivery.ts`、`src/cli/deliver.ts`、`src/application/project-config.ts`）**：
   - 不新增 CLI 子命令。仅在实际交付成功（`deliverTask` 返回 `delivered`，非 `--preview`，非回滚/拒绝）后执行清理。
   - **安全筛选规则（宁可漏删、绝不误删）**：
     - 只扫描 `.knit/.runtime/runs/<run-id>/` 下的直接子目录；
     - 仅当某个 `run-id` **明确归属于主检出已归档任务**（即位于 `.knit/tasks/archive/` 下且状态为 `delivered` 或 `cancelled` 的任务，其 `record.json` 包含该 `run-id`），且该任务**不是本次刚交付的任务**，且该运行记录的 `endedAt` 距当前时间超过保留天数（默认 **14 天**），且该目录不处于任何活跃任务记录中、没有存活的 worker/pane 进程时，才删除 `.knit/.runtime/runs/<run-id>/`。
     - **保护项**：
       - 未归档活跃任务的运行目录绝对不删；
       - 本次刚交付任务的运行目录不删（即使旧执行超过 14 天，也留给用户事后查阅，下次交付其他任务后再按天数自然清理）；
       - 无主目录或无法确认归属的目录（例如不属于任何已归档任务 `record.json` 的目录、或损坏无法解析的记录对应的目录）绝对不删，避免误删 Worktree 尚未合并的任务或手工保留资料；
       - 正在运行（`endedAt === null`）或存在存活 worker/pane 进程的目录绝对不删。
   - **可选配置**：在 `.knit/config.json`（`src/application/project-config.ts`）中支持可选字段 `runtime: { retainDays: <非负整数或 null> }`（缺省 `14`；设为 `null` 或 `0` 关闭自动清理；写错类型或负数时按现有 `config.json` 校验规则报错）。默认 `assets/templates/config.json` 保持简洁不强加该字段。
   - **容错与输出**：清理失败（例如权限或瞬时 IO 错误）**绝不撤回已成功的交付、不改变退出码 0**，只把清理结果或告警附在 `deliver` 标准输出中；成功清理了 ≥1 个目录时在输出末尾加一行简明摘要（如 `已清理超期运行目录：N 个（保留 14 天）`），清理 0 个时不输出额外噪音。
2. **同步文档**：更新 `docs/design/DESIGN.md` 第 2 节（`config.json` 可选字段）、第 8.2 节（交付成功后顺带清理说明）与第 11 节对应备注。

**明确不做 / 边界**：
- 不新增 `knit gc` / `knit clean` 子命令。
- 不清理 `.knit/.runtime/backups/`、`.knit/.runtime/host-sessions/`、`.knit/.runtime/validation/` 或 `.knit/tasks/archive/` 中的归档任务本身。
- 不在 `--preview` 预览阶段删除任何文件。
- 不修改 Worktree 中的受保护路径（`.knit/workflow.yaml`、`.knit/config.json`、`.knit/standards/`、`.knit/agents/`）。

## 完成条件

### Requirement: 交付成功后安全清理超期已归档任务的旧运行目录
#### Scenario: 超期已归档任务的运行目录被清理，活跃任务、未超期、本次任务及无主目录全被保留
- WHEN 项目 `.knit/.runtime/runs/` 中同时存在：(a) 已归档任务超过 14 天结束的运行目录、(b) 已归档任务 14 天内结束的运行目录、(c) 活跃任务超过 14 天的运行目录、(d) 本次刚交付任务超过 14 天的运行目录、(e) 不属于任何已归档任务的无主运行目录，运行 `knit deliver` 完成交付
- THEN 仅 (a) 被删除并在输出中报告清理数量；(b)(c)(d)(e) 全部完好保留；运行 `knit deliver --preview` 不删除任何目录

#### Scenario: 可通过 `config.json` 配置 `runtime.retainDays` 或关闭清理，且清理异常不影响交付成功
- WHEN 在 `.knit/config.json` 配置 `runtime.retainDays` 为自定义正整数、`null`/`0`（关闭）或非法值（如负数/字符串）
- THEN 非法配置被校验拒绝；设为 `null` 或 `0` 时跳过清理；自定义天数按该天数清理；当清理阶段遇到删除错误时交付仍保持 `delivered` 且退出码为 0，输出告警原因

## 待澄清

## 相关资料

- `docs/design/DESIGN.md#2-目录布局` — `config.json` 字段定义
- `docs/design/DESIGN.md#82-交付` — 交付步骤与交付后动作规则
- `docs/design/DESIGN.md#11-不做与延后` — `gc` 精简边界说明
- `src/application/project-config.ts` — `config.json` 解析与校验
- `src/application/delivery.ts` — `deliverTask` 交付主流程
- `src/cli/deliver.ts` — 交付命令输出格式化
- `test/deliver.test.mjs` — 交付核心回归测试
- `test/config.test.mjs` — 项目配置校验测试

## 验证与交付

- 运行 `npm run typecheck`、`npm run build`、`node --test test/deliver.test.mjs test/deliver-worktree.test.mjs test/config.test.mjs` 与全量 `npm test`（因涉及高风险交付路径与文件删除），全部通过。
- 本任务为 `independent` 独立审查任务，实现后将派发独立审查环节核对全部安全边界；改动留在任务 Worktree 分支，不自行提交。

## 结果

已实现 knit deliver 成功后安全清理主检出已归档任务的超期运行目录（默认保留 14 天，支持 config.json 可选 runtime.retainDays 配置及 null/0 关闭，活跃/本次/近期/无主/重复归属/存活进程目录全受保护，清理错误不撤回交付且退出码为 0），并同步更新 docs/design/DESIGN.md 第 2、8.2、11 节。独立审查 r-5fe245880645 结论 pass，并在审查中直接修复了 Git 探测失败误判为非 Git 项目的归属边界（src/application/runtime-cleanup.ts、test/deliver.test.mjs）。验证：npm run typecheck、npm run build、git diff --check 通过；定向测试 73/73 通过；含临时 APFS 跨卷测试的全量 npm test 536/536 通过、0 跳过。
