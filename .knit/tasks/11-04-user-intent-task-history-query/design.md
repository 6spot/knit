# 设计：按用户查询意愿检索任务历史与证据（k-322284b57ad9）

## 规则

- 只有用户表达「查历史／查上次决定、处理、修改／追溯问题」等意愿时才检索；不按固定关键词或任务编号判定，也不因话题与旧任务相关就自动检索。
- 检索结果必须带可核对来源（项目相对路径:行号、run ID、commit）。找不到就说明未找到与缺口，不编造。
- 「找到相关记录」与「证明某次修改引入问题」分开表述；缺少因果证据时明确说明只是时间／内容相关。

## 实现

1. 新增只读模块 `src/application/history-search.ts`
   - 输入：查询词（1 个或多个，全部命中或任一命中按 AND 语义）、可选范围 `task|archive|run|git`、`--limit`（默认 20，上限 100）。
   - 范围：
     - 活动任务：`.knit/tasks/<dir>/task.md`、`plan.md`、`design.md`、`research/**/*.md`；
     - 归档任务：`.knit/tasks/archive/**` 同上；
     - 运行记录：`.knit/runs/**`（run 摘要、报告、决策文本；只读）；
     - Git：`git log --all --format=... --grep`（只读，最多取 limit 条）。
   - 输出结构：`{ kind, taskId|null, path, line|null, snippet, ref }`，`ref` 为 `path:line`、`run:<id>` 或 `commit:<sha>`；不写任何索引／缓存文件。
   - 文本匹配大小写不敏感；二进制／超大文件跳过；无匹配返回空数组，不报错。
2. 入口
   - CLI：`knit task search <query...> [--scope task|archive|run|git] [--limit n] [--json]`；只读，不建任务、不改状态。
   - 桥接：`knit_task` 增加 action `search`（`query`、`scope`、`limit`，不要求 taskId），schema 与两个 `.pi/extensions/knit.ts` 同步。
3. 主会话规则
   - `.knit/workflow.md`（及模板）主会话段落写明：用户表达查询意愿时用该入口检索并引用来源；未表达意愿时不做主动检索；相关不等于因果。
   - 不新增持续索引、后台任务或第二套历史权威；任务、归档、运行、Git 仍是原始资料。
4. 文档
   - DESIGN §12 或相应历史章节、§4.3 命令表、OPERATIONS、GLOSSARY（历史检索、查询意愿、因果边界）。

## 验证

- 命中活动任务、归档任务、run 记录与 Git 提交，返回来源 path:line / run id / commit；无匹配返回空且不编造。
- 未提供范围时默认全范围；`--limit` 生效且结果有界。
- 检索不创建任务、不写 `.knit/`（除只读访问）、不产生索引文件；重复执行结果稳定。
- 意图规则进入指令文本；不存在「无意愿自动检索」的代码路径。
- `npm test` 全量通过（含 typecheck/build）。
