---
id: k-322284b57ad9
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-04T14:11:10.432Z
title: 按用户查询意愿检索任务历史与证据
---

当前状态：仅登记已确认需求，保持 discuss，不 ready、不启动实施。用户授权创建独立任务，不等于授权现在实施。

本任务为独立任务，不挂父任务，不复制总需求。规划优先级：默认 P2；当前版本尚无正式 priority 字段，本行是需求/规划说明，不伪造已实现的能力。建议清单位置：6/8；当前版本尚无原生执行排序，不能按文件夹名称推断。

## 目标与已确认范围

- 用户以自然语言表达查历史、查上次决定/处理/修改或追溯问题的意愿时才检索，不要求固定关键词和任务编号。
- 用户未表达查询意愿时，不因话题与旧任务相关就主动检索，避免不必要消耗。
- 从已有任务、归档、运行和 Git 等可用资料定位此前问答、决定、处理过程、修改与验证，返回可核对来源。
- 区分“找到相关记录”与“证明某次修改引入问题”；因果证据不足要明确说明。
- 任务作为可查询历史的价值不构成规范沉淀对任务的依赖；不默认增加持续全量索引或另一套历史权威。

## 完成条件与验证

- 无任务编号也能根据明确查询意愿找到相关资料及引用，未表达查询意愿时不检索。
- 归档与未归档资料能按实际可用性查询，来源缺失不编造答案。
- 相关性不被包装为根因结论，记录与 Git/验证证据的边界清楚。

默认完成验证 self；相关代码、接口、规范、模板和针对性测试随本任务更新。第 8 项单独执行跨功能真实对话验收，各项机械验证通过不等于整体行为已验收。

## 前置与执行说明

无已确认的业务硬前置；与其它独立任务的共享文件编辑需协调。

各任务分别维护自身输入、状态与成果；具体方案待细化，涉及新的用户取舍再讨论，常规技术细节不机械逐项询问。

## 受影响范围

task-history、任务/归档/运行资料查询入口、CLI/桥接、主会话意图规则与针对性验证。

## 来源与证据边界

需求来自本轮用户逐项确认；必要内容已迁入本任务，不依赖将撤去的原讨论任务。

src/application/task-history.ts、task-service.ts 及现有任务/归档/运行记录；用户明确否决无查询意愿时自动检索。

当前没有完成本任务实现或验收。Git 提交、推送、发布、归档等真实操作仍按明确授权处理。工作区一键打包安装脚本是触发案例，不混入本任务成果。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施完成（任务 k-322284b57ad9）

- 新增只读检索 `src/application/history-search.ts`：按 AND 语义检索活动任务（task/plan/design/research）、归档任务、`.knit/.runtime/runs` 与 `.knit/runs`、Git 提交说明；返回 `{kind, taskId, path, line, snippet, ref}`，来源为 `path:line`、`run:<id>` 或 `commit:<sha>`；无匹配返回空，不写索引/缓存/状态。
- 入口：`knit task search <query...> [--scope] [--limit] [--json]`；桥接 `knit_task` action=search（query/scope/limit，无需 taskId），schema 与两份扩展同步。
- 主会话规则：仅用户表达查询意愿时检索；未表达不主动检索；相关记录与因果结论分开；规则进入 workflow 模板、AGENTS 受管块与桥接注入；本仓库 `.knit/workflow.md` 已同步。
- 范围与上限：默认全范围，limit 默认 20、上限 100；跳过二进制/超大文件；Git 只读 `git log --grep`。
- 文档：DESIGN、OPERATIONS、GLOSSARY、templates 同步。
- 验证：`npm test` 431/431；`npm run pack:check` 通过；CLI 实测归档命中返回 `path:line` 与任务 ID。

### 交付记录

<!-- knit:delivery:op-b89548f31873 -->
- 操作: op-b89548f31873
- 时间: 2026-11-04T19:20:47.858Z
- 分支: refs/heads/main
- 授权来源: user:session-2026-11-04 全权授权逐个执行任务并每任务提交推送
- 工作提交: 7bf7f85959fba00d11fcb0a2fde04a7c9f1d8505
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-04-user-intent-task-history-query

### 任务资料提交记录

<!-- knit:metadata-commit:op-b89548f31873 -->
- 任务资料提交: bcde92a3e4e7e92e347e4806c44ce37e3e4f25fc
- 归档目标: .knit/tasks/archive/2026-11/11-04-user-intent-task-history-query

<!-- knit:progress:end -->
