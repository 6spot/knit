---
id: k-06c7bb05aa38
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
createdAt: 2026-11-02T08:48:50.902Z
title: 同步自管接入约定与文档现实
---

# 同步自管接入约定与文档现实

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

架构审查（2026-11-02，四路独立审查+本人核读）确认的问题：

1.【高】AGENTS.md「顺序开发任务」节与 TASKS.md 开头仍写「不在当前工程提前运行产品 init 或创建 .knit/.pi」，但用户已于 2026-11-02 授权在本工程运行 knit init：.knit/、.pi/extensions/knit.ts 存在，AGENTS.md 被追加受管块（均未提交）。规则与可见现实相反，且 026 执行记录中「确认当前工程没有被自动 commit／初始化产品状态」的结论不再描述当前工作区。
2.【高】受管块声明「任务列表：.knit/tasks/（npx --no-install knit task list）」，但开发任务在根 tasks/，.knit/tasks/ 不存在，该入口在本仓库指向失效（本次审查建任务后才有 .knit 元数据）。
3.【中】版本口径：DESIGN.md:4/753、TECHNOLOGY.md:3、ARCHITECTURE.md:3、AGENTS.md:5 写「已实现至 Linux 候选（001–025）」，但 TASKS.md 026（M3B 独立发布就绪审查）已 completed，DESIGN §16.1 M3B 行自己也写「任务026 独立审查通过」。

验收标准：
- grep 全仓不再存在与现实相反的 init 禁令；自管接入约定如实记录（含用户授权事实与未提交改动去留）。
- 受管块／说明在本仓库指向真实任务位置，或注明产品模板示例性质。
- 001–026 口径在各文档统一（或在 026 结论处统一注明其覆盖范围）。

### 交付记录

<!-- knit:delivery:op-911829c19b18 -->
- 操作: op-911829c19b18
- 时间: 2026-11-02T09:52:53.789Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-02-对话授权交付
- 工作提交: 9a345c14a5741673a62bea20e34268d922774010
- 结果: 正常交付；检查 run-865dba61e50e 通过
- 归档目标: .knit/tasks/archive/2026-11/11-02-self-hosting-docs

<!-- knit:progress:end -->
