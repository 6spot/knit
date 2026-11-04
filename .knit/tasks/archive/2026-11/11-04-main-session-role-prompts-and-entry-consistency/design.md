# 设计：主会话与角色提示词及项目入口统一（k-20bdb1709d7e）

## 现状缺口（已核对）

- 模板 `.knit/workflow.md` 已含「新正式需求与需求澄清门」与「规范沉淀」；本仓库 `.knit/workflow.md` 仍是旧「新正式需求」+ 自定义「规范沉淀（不依附任务）」且顺序不同 → 实际项目与模板规则不一致。
- `.knit/agents/implement.md` 与模板条目顺序不同；check 已一致。
- 桥接注入文本在任务/无任务两个分支重复「历史查询」行，且未覆盖任务选择与授权、交付归主会话。
- 角色文件未集中说明停止条件、报告字段与可用工具；缺少 Trellis/GSD 参考到现行职责的逐项映射。

## 统一后的单一权威

1. `assets/templates/.knit/workflow.md`（模板为唯一源）：
   - 主会话：任务选择（先问是否建任务、不建持续有效、实施前补问）、需求澄清门、创建≠确认/授权、规范沉淀、按意愿检索历史、继续已有任务。
   - 环节顺序固定为 讨论 → 规范沉淀 → 实施 → 检查 → 交付；规范沉淀独立成节，不绑任务。
   - 交付：主会话接收结果、核对、汇总、报告与授权边界；无交付辅助角色。
2. 角色模板 `assets/templates/.knit/agents/implement.md`／`check.md`／`runtimes/pi.md`：
   - 写清职责、停止条件（blocked／需求不明／保护路径）、报告字段（对应 `StageReportSchema`）与工具事实（check 可写；advisory 只读；`.knit/` 保护）。
3. `AGENTS.md` 受管块：只列入口与授权要点，不重复 workflow 全文；初始化生成同文。
4. 桥接注入：任务与无任务分支共用同一「行为引导」文本，历史查询只出现一次；补充任务选择/授权、规范沉淀、交付归主会话的一句话指引，并指向 workflow.md。
5. 新增 `docs/design/ROLE-CONTRACT.md`：角色 × 职责／停止条件／报告／工具 表，附 Trellis（validation/trellis-prompts-and-roles/，f089cb3）与 GSD（RESEARCH §17.5，1ec5c81）逐项来源、采用理由与差异；docs/README、DESIGN 引用。
6. 本仓库 `.knit/workflow.md`、`.knit/agents/*` 的同步由主会话在 run 接收后按模板完成并单独提交；**run 阶段禁止修改 `.knit/`（受保护路径，改动会使 run 失败）**。旧项目：init 只补缺、受管块按基线更新并报告差异，不静默覆盖项目文件。
7. 行为场景（机械可核对）：任务选择与实施授权、规范沉淀（无任务可用）、历史按意愿、交付归主会话、检查范围内修复；真实对话验收留任务 k-da599e3b5cd4。

## 边界

- 不改业务状态机、工具策略、schema 语义；不改既有 CLI/桥接参数；不新增角色或动作。
- 不引入新的提示词框架；不整段重写与现状一致的规则。
- 本任务不替代前置任务的测试；只补整合一致性与初始化回归。

## 验证

- `npm test` 全量；init 回归：新项目生成同文 workflow/角色/受管块；旧项目保留项目文件、受管块差异可见、桥接更新。
- 桥接注入两分支一致且无重复；`knit_task`/`knit_run` 动作与 CLI 命令一致。
- 角色文件与工具事实一致（check 可写、advisory 只读、保护路径），报告字段与 `StageReportSchema` 对齐。
- 文档：ROLE-CONTRACT 映射可逐项追溯到 Trellis/GSD 来源。
- 真实宿主对话行为不在此任务验收。
