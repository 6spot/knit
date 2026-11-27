---
id: k-d35eccd06f9d
title: 清理旧版历史归档并优化归档列表扫描与损坏诊断
status: delivered
stage: null
verification: independent
parent: k-8d244665f694
dependsOn:
  - k-566ade3a274d
priority: P1
createdAt: 2026-11-27T13:37:26.395Z
---

## 目标与范围

按“新项目无历史兼容包袱”的产品决定，彻底清理本仓库 11 月重写前遗留的旧格式归档目录，落实新的 `task list` 损坏目录展示策略（活跃列表超 5 条折叠、归档列表静默跳过），并大幅优化归档列表扫描性能、提交查询与损坏任务按 ID 诊断能力。

### 具体改动与思路

1. **清理本仓库旧格式历史归档（`.knit/tasks/archive/2026-11/`）**：
   - 删除 `.knit/tasks/archive/2026-11/` 中所有不满足现行 `TaskFrontmatterSchema` 的 11 月重写前旧格式归档目录（`11-02-acceptance-gaps` 至 `11-18-h2b-move-next-to-root`），保留所有现行有效归档。
   - 不在生产代码中引入旧版 schema 兼容层。
2. **`task list` 损坏目录策略与扫描/显示优化（`src/application/task-store.ts`、`src/cli/task.ts`、`docs/design/DESIGN.md`）**：
   - **已定下的损坏目录策略**：
     - 活跃任务列表（`knit task list`）继续在末尾报告损坏目录，但**最多显示前 5 条**，超出时追加 `另有 N 个损坏目录未列出`，防止异常时刷爆主会话上下文；
     - 归档任务列表（`knit task list --archive`）**静默跳过损坏目录，不展示**（如需排查具体归档，仍可通过 `knit task show <id>` 诊断）。
     - 同步更新 `docs/design/DESIGN.md` 第 9 节与相关测试。
   - `task-store.ts` 新增轻量列表扫描路径：归档列表仅解析 `task.md` 头部所需字段，跳过无用的 `sha256Bytes` 计算与对已结束归档无意义的 `record.json` 全量读取/校验，显著降低归档规模增长后的列表耗时。
   - `hasTasks` 改用 `existsSync` 判存在，不再读入整份 `task.md`；`taskCommit` 改为单次 `git log -n 20` 带记录分隔符查询，消除正文命中标记行时按 `skip + 1` 递归 spawn 多个 `git` 进程。
   - `cli/task.ts`：统一用 `Date.parse` 比较时间排序（修复活跃列表不同时区字符串排序误差）；`--limit` 校验对齐 `run wait --timeout`（`/^[1-9]\d*$/` 且 `Number.isSafeInteger`）；未合并分支提示改为 `git merge --no-edit`；活跃列表对所有运行中成员批量调用一次 `processIdentities` 替代逐个 spawn `ps`；复用 `recordedPaths` 与 `DEFAULT_AGENT`。
3. **YAML 别名保护与损坏任务按 ID 诊断（`src/domain/task.ts`）**：
   - `parseTaskFrontmatter` 对 `yaml.toJS({ maxAliasCount: 100 })` 包裹 `try/catch`，非法或超限 YAML 别名转为 `problems` 而不崩溃整次列表或上下文读取。
   - `taskDocumentMayHaveId` 与 `unparsedTaskId` 的慢路径仅从 `parseDocument(header).toJS({ maxAliasCount: 100 })`（带 `try/catch`）读取原始 `id` 字段，不依赖全量 schema 校验通过，修复损坏 `task.md` 中 `id` 带引号或行尾注释时无法被 `knit task show <id>` 找到并诊断的缺陷。

### 边界与约束

- 不在本次任务中重构 Markdown 代码围栏公共模块（归 `k-3b3852762282`），不修改 `session-context.ts`（归 `k-48ccd026c70d`）。
- 仅删除解析失败的旧格式历史归档，不得误删任何现行有效归档（删除前用脚本核验零误删、删除后确认 `knit task list --archive` 零报错）。
- 测试追加到 `test/task-domain.test.mjs`、`test/task-lifecycle.test.mjs`，运行 `npm run typecheck`、`npm run build` 及受影响测试文件（`node --test test/task-domain.test.mjs test/task-lifecycle.test.mjs`）。

## 完成条件

### Requirement: 清理旧归档与新损坏目录展示策略
#### Scenario: 本仓库旧格式归档清理干净且归档列表静默跳过损坏目录
- WHEN 在本仓库运行 `knit task list --archive --limit 5`，以及在测试夹具中向归档目录放入损坏任务再运行 `knit task list --archive`
- THEN 本仓库归档列表零报错；夹具归档列表静默跳过损坏目录且不输出损坏报错行

#### Scenario: 活跃列表损坏目录超过 5 条时折叠摘要
- WHEN 测试夹具的活跃任务目录中存在超过 5 个损坏任务并运行 `knit task list`
- THEN 仅展示前 5 条损坏提示并在末尾给出剩余数量折叠行

### Requirement: 归档轻量扫描、YAML 容错与损坏任务按 ID 诊断
#### Scenario: 带引号或注释 ID 的损坏任务与 YAML 别名炸弹均安全处理
- WHEN `task.md` 包含非法的 `priority` 且 `id` 带引号或行尾注释，或包含循环/超限 YAML 别名
- THEN `knit task show <id>` 仍能定位并报出具体字段问题；非法 YAML 别名转为任务 `problems` 而不抛未捕获异常崩溃

#### Scenario: --limit 严格校验与单次提交反查
- WHEN 传入前导零或超安全整数的 `--limit`，以及对正文含 `Knit-Task:` 文本的已交付任务执行 `taskCommit`
- THEN 非法 `--limit` 被明确拒绝；`taskCommit` 正确命中真正末尾 trailer 的交付提交

### Requirement: 构建与回归验证通过
#### Scenario: 类型检查、构建与任务领域/生命周期测试通过
- WHEN 运行 `npm run typecheck`、`npm run build` 及 `node --test test/task-domain.test.mjs test/task-lifecycle.test.mjs`
- THEN 全部通过且 `docs/design/DESIGN.md` 已同步更新

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 第 3、9 节任务格式与 `task list` 展示规则
- `.knit/standards/development.md` — 编码规范与测试分层规范
- `src/domain/task.ts` — 任务文档解析与 ID 提取
- `src/application/task-store.ts` — 任务扫描、`hasTasks` 与 `taskCommit`
- `src/cli/task.ts` — `task list`/`show` 渲染与参数校验
- `test/task-lifecycle.test.mjs` — 现有列表与损坏任务测试套

## 结果

按现行解析结果清理 169 个旧格式归档，共 214 个跟踪文件；119 份保留归档共 264 个文件按 SHA-256 与基线一致，现行 parent 与 dependsOn 均可解析。归档列表跳过损坏目录，活跃列表超过 5 个时折叠，按 ID 可诊断损坏字段。119 份归档扫描中位数从 14.20 ms 降至 9.24 ms。历史计划内 G13、R1 两条路径原文可分别从提交 46ab50b、8218c56 读取。五个验收场景和独立审查 r-fde3e9149d93 通过。定向 60/60，宿主最终类型检查、构建、打包、git diff --check 与跨卷全量 660/660 通过，0 失败、0 跳过。
