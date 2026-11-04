---
id: k-5dd19bb9b84c
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-04T14:11:09.698Z
title: 项目规范沉淀独立于任务
---

当前状态：仅登记已确认需求，保持 discuss，不 ready、不启动实施。用户授权创建独立任务，不等于授权现在实施。

本任务为独立任务，不挂父任务，不复制总需求。规划优先级：默认 P2；当前版本尚无正式 priority 字段，本行是需求/规划说明，不伪造已实现的能力。建议清单位置：3/8；当前版本尚无原生执行排序，不能按文件夹名称推断。

## 目标与已确认范围

- 规范识别、候选保存、审阅、采纳不依赖 taskId、任务存在、阶段或任务收尾；无任务交流照常沉淀，不为保存规范暗建任务。
- 用户明确长期规则且含义清楚时直接整理采纳，不重复询问同一决定；Agent 判断足够明确时也可自行采纳。
- 自行采纳依据来自讨论决定、已验证实践或多次一致处理；适用范围清楚，区分长期约定与本次例外，不替用户填补未决目标或偏好。
- 推导出的规则与已有规范冲突时先提出冲突和建议，取得用户决定；用户明确更改旧规则时直接更新并说明替换内容。
- 未明确的可复用内容保存为项目级候选，保留来源、建议和待确认点；一次性要求仅保留本次适用范围。
- 明确规则及时保存，正常回复末尾简短说明内容、适用范围和位置；需决定的问题当场问，未明确候选在讨论告一段落时集中呈现。
- 梳理旧任务 standards.md、审阅回执与交付前候选守卫的兼容/迁移，不能让旧任务耦合继续阻碍规范沉淀。

## 完成条件与验证

- 没有任何任务时仍可保存候选并采纳正式规范，接口不强制 taskId。
- 明确采纳、自行采纳、冲突等待决定、一次性例外与候选保留分别有实际结果。
- 既有记录不静默丢失，正式规范索引与回执保持一致，交付不把规范处理重新绑定任务。
- 指令包含主动识别与告知规则，最终对话效果交第 8 项验证。

默认完成验证 self；相关代码、接口、规范、模板和针对性测试随本任务更新。第 8 项单独执行跨功能真实对话验收，各项机械验证通过不等于整体行为已验收。

## 前置与执行说明

无已确认的业务硬前置；与其它独立任务的共享文件编辑需协调。

各任务分别维护自身输入、状态与成果；具体方案待细化，涉及新的用户取舍再讨论，常规技术细节不机械逐项询问。

## 受影响范围

standards 契约/服务/元数据、正式规范读写、CLI/桥接、delivery-service 候选核对、模板与设计。

## 来源与证据边界

需求来自本轮用户逐项确认；必要内容已迁入本任务，不依赖将撤去的原讨论任务。

docs/design/DESIGN.md 第 8.2 节；src/application/standards-service.ts、standards.ts、delivery-service.ts；test/standards.test.mjs。此前该测试 9/9 通过仅证明既有机械流程，不证明聊天自动识别。

当前没有完成本任务实现或验收。Git 提交、推送、发布、归档等真实操作仍按明确授权处理。工作区一键打包安装脚本是触发案例，不混入本任务成果。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施完成（任务 k-5dd19bb9b84c）

- 作用域：候选、审阅、采纳改为项目级；`.knit/standards/candidates.md` 保存候选，回执以 `project` 键存 `standards_reviews`，`taskId` 不再必填。
- 兼容：旧任务 `standards.md` 只读可列；新增幂等 `standards migrate` 迁入项目候选并保留 candidateId 与来源，原文件不改写。
- 交付：移除交付前规范候选门禁，`standards_review_required`／`standards_apply_required` 不再由 deliver 触发；`standards apply` 仍核对规则实际写入正式规范。
- 接口：CLI `standards list/propose/review/apply/pending/migrate`，`--task` 仅作来源标注或旧资料过滤；桥接 `knit_standards` 同步，taskId 可选。
- 指令：模板 `assets/templates/.knit/{workflow.md,agents/*.md,standards/index.md}` 增加主动识别、采纳依据、冲突处理、候选保留与末尾告知规则；本仓库 `.knit/workflow.md`、`.knit/agents/*.md`、`.knit/standards/index.md` 同步更新。
- 规范：DESIGN §8.2、STATES §9、ARCHITECTURE、OPERATIONS、GLOSSARY 与 CLI 帮助同步。
- 验证：`test/standards.test.mjs`、`test/delivery.test.mjs` 覆盖无任务 propose→review→apply、migrate 幂等与旧回执兼容、交付不被候选阻塞；全量 `npm test` 424/424，`npm run pack:check` 通过。

### 交付记录

<!-- knit:delivery:op-8e94bc626288 -->
- 操作: op-8e94bc626288
- 时间: 2026-11-04T17:24:01.340Z
- 分支: refs/heads/main
- 授权来源: user:session-2026-11-04 全权授权逐个执行任务并每任务提交推送
- 工作提交: e61a86fd8db62556c5465420507a2c5e6440d719
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-04-task-independent-project-standards

<!-- knit:progress:end -->
