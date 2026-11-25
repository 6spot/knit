---
id: k-bd5ab0c85d2c
title: 规范与 CLI 输出任务时统一带上标题
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-25T08:57:40.276Z
---

## 目标与范围

解决任务 ID（`k-<hex>`）本身不可读、导致主会话回复用户或 CLI 回显时仅输出 ID 而看不出任务内容的问题。

范围内：
- 内置讨论规范（`assets/standards/discussion.md`，每轮主会话必注入，规则只写一处）补充约定：主会话向用户提到任何任务时，统一带上任务标题并括号附 ID，格式为 `标题（k-xxxx）`，不单独只报 ID。
- 补齐目前只输出任务 ID 的 CLI 命令回显，统一带上任务标题（`标题（id）`）：
  - `knit task new` / `ready` / `close` / `cancel`
  - `knit run start` / `cancel`
  - `knit deliver` 及 `--preview` 中的未结束子任务提示
  - `knit context --use`、`knit init` 的初始化任务行
  - Pi 桥接模板（`assets/templates/pi/extensions/knit.ts`）的 `knit_task` `use` 返回首行与 `context --use` 保持一致
- 同步更新受影响的测试断言与 `docs/design/DESIGN.md` 中的相关说明。

范围外：
- 不改变任务 ID 生成规则（保持 `k-<hex>`）。
- 不在本任务中执行全局重装（`npm run pack:install`）或刷新本仓库生成副本（`knit init --force`），交付后另行由用户授权决定。

## 完成条件

### Requirement: 内置规范明确要求带标题指称任务
#### Scenario: 主会话每轮收到的讨论规范包含任务指称约定
- WHEN 主会话读取 `knit:standards/discussion.md`（通过 `knit context` 或直接读取 `assets/standards/discussion.md`）
- THEN 规范中明确约定主会话向用户提到任务时使用 `标题（ID）` 格式，不单独只报任务 ID

### Requirement: CLI 命令回显任务时统一带上标题
#### Scenario: 任务生命周期、派发、交付、选中与初始化命令均输出标题和 ID
- WHEN 运行 `knit task new`、`knit task ready`、`knit task close`、`knit task cancel`、`knit run start`、`knit run cancel`、`knit deliver`、`knit deliver --preview`（存在未结束子任务）、`knit context --use`、`knit init`（首次创建初始化任务）以及 Pi 桥接的 `knit_task(use)`
- THEN 输出中均包含对应任务的标题和 ID（`标题（id）` 格式，带附加字段时放在同一括号或紧随其后），不再只输出裸 ID

### Requirement: 类型检查、构建与测试全部通过
#### Scenario: 修改完成后仓库验证全绿
- WHEN 运行 `npm run typecheck`、`npm run build` 和 `npm test`
- THEN 全部退出码为 0，无类型错误、构建错误或测试失败

## 待澄清

## 相关资料

- `assets/standards/discussion.md` — 每轮注入主会话的内置讨论规范
- `src/cli/task.ts` — 任务创建、确认、完成、取消命令输出
- `src/cli/run.ts` — 派发与取消执行命令输出
- `src/cli/deliver.ts` — 交付预览与交付结果输出
- `src/cli/project.ts` — 初始化与会话选任务命令输出
- `assets/templates/pi/extensions/knit.ts` — Pi 宿主桥接模板
- `docs/design/DESIGN.md` — 现行设计文档

## 结果

已完成规范与 CLI 任务输出统一带上标题（标题（ID）格式）：
1. 在内置讨论规范 assets/standards/discussion.md 新增「指称任务」条款，要求主会话向用户提到任务时统一使用 标题（ID） 格式。
2. 补齐 task new/ready/close/cancel、run start/cancel、deliver、deliver --preview（未结束子任务）、context --use、init 初始化任务行以及 Pi 桥接 knit_task(use) 的任务标题回显，并同步更新 docs/design/DESIGN.md。
3. 验证：npm run typecheck、npm run build 通过；全量 npm test 共 508 项，501 通过、0 失败、7 跳过（环境条件跳过）。

未执行：全局重装（npm run pack:install）留待交付后另行授权。
