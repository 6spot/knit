---
id: k-2c0d10318898
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: null
priority: P0
dependsOn: []
order: 10
createdAt: 2026-11-07T11:44:04.726Z
title: 审计修复总计划：成果认定、归属、出口与信任边界
---

# 审计修复总计划：成果认定、归属、出口与信任边界

## 目标与边界

### 背景与问题

2026-11-07 主会话只读审计（隔离仓库 `/tmp/kx` + fake-pi 实测）发现：run 成果的认定、改动归属与卡住后的出口三处基础不可靠，导致完成凭据、"independent" 标记与交付提交可能与事实不符。完整问题清单与复现证据见本任务 `plan.md`。

### 交付范围

- 统筹以下子任务的范围、优先级与依赖；子任务各自承担实现、文档与测试。
- 已有任务 `k-f0d9a8952aff`（锁收窄与状态写归属）覆盖审计 S4／S5，纳入本计划，不重复建任务。
- 每个子任务把对应审计复现场景写成自动化测试，作为回归集。

### 非目标

- 不建设操作系统级沙箱；有 exec 的阶段进程仍可能产生未声明副作用，目标是"检测并如实标注"，而非"绝对阻止"。
- 不在本计划内做真实模型、真机或 NPM 发布验收。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 子任务的取舍已按审计推荐项确认（2026-11-07 用户「按推荐」）；各子任务「关键决定」为准。

## 完成条件

- 全部子任务 closed（completed／superseded 需写明原因）。
- 在隔离夹具中按 `plan.md`「回归场景」逐条复跑：F1–F4、S1–S8 均不再复现，或按子任务决定以 needs_attention／明确标注呈现。
- 设计文档（DESIGN／STATES／OPERATIONS／ROLE-CONTRACT）与实现一致，无残留旧语义。

## 输入引用

- 本任务 `plan.md`：问题清单、根因、修复原则、任务分解与回归场景。
- [AGENTS.md](../../../AGENTS.md) 开发约定与交付检查。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
