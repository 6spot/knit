---
id: k-802d3edc053c
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-04T14:11:09.452Z
title: 任务优先级、前置依赖与稳定执行顺序
---

当前状态：仅登记已确认需求，保持 discuss，不 ready、不启动实施。用户授权创建独立任务，不等于授权现在实施。

本任务为独立任务，不挂父任务，不复制总需求。规划优先级：默认 P2；当前版本尚无正式 priority 字段，本行是需求/规划说明，不伪造已实现的能力。建议清单位置：2/8；当前版本尚无原生执行排序，不能按文件夹名称推断。

## 目标与已确认范围

- 支持任务自身 P0/P1/P2/P3 优先级，P0 最高，未指定默认 P2。明确紧急对应 P0，明确可后置对应 P3；未说紧急不等于 P3。优先级与父子层级无关。
- 分别记录原始创建先后、可调整业务执行顺序与前置依赖，不能从目录字母或文件系统枚举顺序推断。
- 所有任务开始前，前置任务必须完成；优先级和用户指定任务都不能绕过此前置铁律。P0 依赖 P2 时先满足 P2 前置。
- 满足依赖后按 P0→P1→P2→P3；同优先级默认真实创建先后。用户明确调整顺序时保存新业务顺序，原始创建记录保持可追溯。
- 用户明确指定任务时按指定处理并核对依赖；泛指“按顺序执行”时使用明确规则。列表与执行选择保持一致，目录改名不改业务顺序。

## 完成条件与验证

- 未满足依赖时实际执行入口不能启动，不仅由提示词提醒；异常依赖可诊断。
- 默认 P2、优先选择、同级稳定排序、人工调整和改名不改序有验证。
- 旧任务兼容方式明确，原始创建事实不会被排序调整改写；缺少历史信息时不伪造真实先后。
- 任务列表与主会话执行入口能给出一致的安排和不能启动的原因。

默认完成验证 self；相关代码、接口、规范、模板和针对性测试随本任务更新。第 8 项单独执行跨功能真实对话验收，各项机械验证通过不等于整体行为已验收。

## 前置与执行说明

无已确认的业务硬前置；与其它独立任务的共享文件编辑需协调。

建议与第 1 项紧邻推进以统一任务结构；这只是推荐顺序，不冒充业务硬依赖。P1 具体判定及依赖链的细化规则需在方案中写清，涉及用户取舍时讨论。

## 受影响范围

任务契约/服务/列表、run 准备与实际启动链路、CLI/桥接、兼容迁移、设计及测试。

## 来源与证据边界

需求来自本轮用户逐项确认；必要内容已迁入本任务，不依赖将撤去的原讨论任务。

Trellis 固定提交 f089cb3 的 priority 默认 P2 可借鉴；其顶层列表按目录名排序、createdAt 只到日期，不具备本任务要求的完整顺序机制。来源 validation/trellis-prompts-and-roles/sources.md 及固定提交 scripts/task.py、scripts/common/task_store.py、tasks.py。

当前没有完成本任务实现或验收。Git 提交、推送、发布、归档等真实操作仍按明确授权处理。工作区一键打包安装脚本是触发案例，不混入本任务成果。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施完成（任务 k-802d3edc053c）

- 契约：frontmatter 增 `priority`（P0–P3，默认 P2）、`dependsOn`（稳定 ID 列表）、`order`（人工业务顺序）；三者不参与需求摘要。
- 领域：新增 `src/domain/schedule.ts`（稳定排序、依赖阻塞与成环检测、重排计划）。
- 服务：`task new --priority/--depends-on`；`task priority`、`task depends`、`task order`、`task next`；list 统一排序并派生阻塞原因。
- 入口：`task ready` 与 implement 的 `run prepare` 拒绝未满足依赖（`dependency_unmet`），优先级与用户指定不绕过；依赖结构错误在设置时拒绝。
- 展示：`task list`／`knit status` 输出优先级、依赖与阻塞原因；`task next` 给出一致安排。
- 规范：DESIGN §3.1／§3.11／§4.3、STATES、OPERATIONS、GLOSSARY 同步。
- 验证：`test/task-schedule.test.mjs` 5/5；全量 `npm test` 419/419；typecheck、build 通过。

### 交付记录

<!-- knit:delivery:op-1d9359fe4e07 -->
- 操作: op-1d9359fe4e07
- 时间: 2026-11-04T16:47:26.048Z
- 分支: refs/heads/main
- 授权来源: user:session-2026-11-04 全权授权逐个执行任务并每任务提交推送
- 工作提交: 88df0e2deb30dcda037dafe68cfa214bd6a08236
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-04-task-priority-dependencies-and-order

### 任务资料提交记录

<!-- knit:metadata-commit:op-1d9359fe4e07 -->
- 任务资料提交: 3fcf517c51daee8966a5d29dbd007ce4725bfd17
- 归档目标: .knit/tasks/archive/2026-11/11-04-task-priority-dependencies-and-order

<!-- knit:progress:end -->
