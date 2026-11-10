# 领域规则

依据 STATES.md 实现 Task、检查资格、修复计数和必要状态守卫。保持纯 TypeScript：不导入 fs、Git、进程、Pi 或 UI，不由模型报告直接修改业务状态。

| 模块 | 职责 |
| --- | --- |
| [task.ts](task.ts) | Task status/stage/outcome 转移、配置驱动的顺序与 `onVerdict` 跳转、阶段访问上限、clarify/change、待应用草案守卫、adopt 与摘要覆盖范围 |
| [check.ts](check.ts) | 检查资格推导（missing/pending/valid/stale/blocked）与事件降级 |
| [repair.ts](repair.ts) | 修复周期计数、上限与停止原因；clarify/resume 不重置 |
| [schedule.ts](schedule.ts) | 优先级、前置依赖阻塞与成环检测、同优先级业务顺序重排 |
| [workflow.ts](workflow.ts) | `workflow.yaml` 解析、阶段语义校验、回退环上限与降级；默认模板常量 |
| [report.ts](report.ts) | 阶段报告声明校验：固定字段、声明字段类型、枚举结论、`paths` 与实际 diff 一致；可补报原因判定与 coverage 覆盖核对 |

决定一律返回 `{ allowed, reason }` 或转移对象，原因码稳定可测；应用层把领域原因映射到协议 ReasonCode。所有函数输入为已核实事实，输出为决定，不保存状态。
