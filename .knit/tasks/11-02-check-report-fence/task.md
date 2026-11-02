---
id: k-4bd444339302
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
createdAt: 2026-11-02T11:30:19.154Z
title: 检查报告解析健壮化：代码围栏容错或修复轮次提示
---

# 检查报告解析健壮化：代码围栏容错或修复轮次提示

## 目标与边界

<!-- 待讨论确认：目的、范围、约束与必要设计 -->

## 完成条件

<!-- 可验证结果与必需验收 -->

## 输入引用

<!-- 适用规范、设计材料、代码范围与验证入口 -->

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

讨论结论（2026-11-02，用户授权完成剩余任务）：

问题：独立检查 worker 实际完成核验且结论为 pass，但把报告 JSON 包进 ```json 围栏输出（run-b8e419cbc914），schema 解析失败 → run failed（report_schema_invalid），白耗一轮检查。运行实例：run-b8e419cbc914 的 reportSummary 以「```json」开头。

方向（最小容错，不改协议语义）：
1. 检查报告解析前做围栏剥离：若原始文本含被 ```（json 可选标注）包裹的子串，且剥离后的子串能解析为合法 JSON 对象并通过 schema，则采用之；否则维持 report_schema_invalid 失败不变。
2. schema 校验失败时的失败原因细节保留（与 k-af4f5aafa6d7 的诊断改进一致，便于看到「围栏」这类根因）。
3. 补确定性测试：fake-pi 输出带围栏的报告 → run 通过；输出畸形 JSON → 仍 report_schema_invalid。
4. 不在修复轮次上加自动重试（避免静默增加模型轮次，遵守 AGENTS 约定）。

验收标准：带围栏报告的检查 run 以 pass 接收；畸形报告仍失败；npm test 全绿。

<!-- knit:progress:end -->
