---
id: k-ef4500bb69c6
title: 补齐防过碎文件与测试分层规范、角色模板与设计约定
status: delivered
stage: null
verification: self
parent: k-8f1c264937ee
dependsOn: []
priority: P2
createdAt: 2026-11-23T23:26:25.798Z
---

## 目标与范围

落地 `docs/research/file-granularity-and-test-review.md#8-规范角色提示与设计的可执行修改建议`，在开始任何源码与测试合并前先补齐制度防线，消除“拆场景即建新文件”“为防漏测把纯逻辑全写成重型 CLI/子进程矩阵”“只增不并”的诱因。

**为什么做**：
梳理表明，当前 77 个源码文件与 68 个测试文件的碎片化及近 2 分钟的测试耗时，源于规范只约束函数粒度却缺失文件与测试分层约束、任务拆分上限被机械映射为文件拆分、以及角色提示缺少归并与慢测试把关。

**改动范围（范围内）**：
1. `.knit/standards/development.md`：在「复杂度」补齐文件与模块粒度门槛（优先在既有同主题文件扩展、新建文件需满足明确边界、禁止空壳 barrel 与单调用方极薄文件、共享原语下沉 `infrastructure/`）；在「测试」补齐测试分层、主题测试文件组织、应用层/模板仓库夹具优先与单文件耗时预算条款。
2. `.knit/standards/pitfalls.md`：在 `## implement, review` 分区增加平衡条目——“为防漏测把纯逻辑全写成重型 CLI / 子进程矩阵”，明确以真实样本直调领域层/应用层覆盖规则分支 + 少量端到端冒烟验证接线。
3. `assets/standards/task-splitting.md` 与 `assets/standards/task-writing.md`：在拆分规范中明确“拆分的是交付节奏与验收范围，不是源码模块或测试文件”；在编写规范中明确增量任务应点名归属模块与应追加的既有测试文件。
4. `assets/templates/agents/implement.md` 与 `assets/templates/agents/review.md`：实现提示要求新增代码和测试优先落入既有同主题文件，新文件需在报告说明理由；审查提示将无必要新增碎片文件/空壳重导出及纯逻辑滥用重型子进程测试纳入检查项。
5. `docs/design/DESIGN.md`：在第 7 节补充 `waitRun` 轮询策略（支持短退避或测试参数化）与第 10 节补充测试夹具复用应用层入口与模板仓库克隆的工程约定。

**执行方式与边界（范围外）**：
- 因 `.knit/standards/` 属于受保护路径（派发执行者不可改），本任务由主会话直接完成（不派执行者）。
- 不修改 `src/` 与 `test/` 源码，不修改 `.knit/agents/` 生成副本（模板唯一来源为 `assets/templates/agents/`）。
- **不删除** `.knit/standards/{delivery,discussion,task-splitting,task-writing}.md` 旧版副本：当前管理本仓库的全局安装版尚未通过 `npm run pack:install` 升级，删除旧副本需在用户单独授权全局安装之后进行。
- 不运行 `npm run pack:install`。

**验证与交付**：
- 运行 `node dist/cli/knit.js standards list`、`npm run pack:check` 与 `node --test test/templates.test.mjs test/standards.test.mjs test/standards-cli.test.mjs`，确认内置规范、模板与避坑清单解析无报错且打包检查全绿。
- 通读全部修改过的文档与规范，核对 Markdown 结构、章节编号和术语一致。
- 完成后由主会话汇报，取得用户授权后按本仓库提交规范归档交付。

## 完成条件

### Requirement: 项目规范与避坑清单补齐文件粒度与测试分层约束
#### Scenario: 开发规范与避坑清单生效且可被 Knit 正确解析
- WHEN 更新 `.knit/standards/development.md` 与 `.knit/standards/pitfalls.md` 并运行 `node dist/cli/knit.js standards list` 与 `node --test test/standards.test.mjs test/standards-cli.test.mjs`
- THEN 开发规范明确约束新建文件门槛、跨层原语归位、测试分层与单文件耗时预算，避坑清单 `## implement, review` 包含纯逻辑过度走重型子进程测试的反例条目，且规范列表与相关测试均通过。

### Requirement: 通用规范、角色模板与设计文档同步更新
#### Scenario: 内置规范模板、角色提示模板与设计文档无漂移且通过模板/打包检查
- WHEN 更新 `assets/standards/{task-splitting,task-writing}.md`、`assets/templates/agents/{implement,review}.md` 与 `docs/design/DESIGN.md` 并运行 `npm run pack:check` 与 `node --test test/templates.test.mjs`
- THEN 拆分与编写规范澄清“拆任务不等于拆文件”并要求点名归属测试文件，实现与审查模板补齐防过碎和防慢测试检查，设计文档第 7/10 节补齐等待与测试夹具约定，且模板测试与打包检查通过。

### Requirement: 严守只读与全局安装边界
#### Scenario: 未改业务源码、未提前删旧副本且未执行全局安装
- WHEN 检查本任务改动文件范围
- THEN 仅改动上述 7 个规范/模板/设计文档，未改动 `src/`、`test/`、`.knit/agents/` 副本，且保留 `.knit/standards/{delivery,discussion,task-splitting,task-writing}.md` 待后续授权 `pack:install` 后清理。

## 待澄清

## 相关资料

- `docs/research/file-granularity-and-test-review.md#8-规范角色提示与设计的可执行修改建议` — 本任务逐文件修改依据
- `.knit/standards/development.md` — 待更新的项目开发规范
- `.knit/standards/pitfalls.md` — 待补充的统一避坑清单
- `assets/standards/task-splitting.md` — 待更新的内置任务拆分规范
- `assets/standards/task-writing.md` — 待更新的内置任务编写规范
- `assets/templates/agents/implement.md` — 待更新的实现角色模板
- `assets/templates/agents/review.md` — 待更新的审查角色模板
- `docs/design/DESIGN.md` — 现行设计文档（第 7、10 节）

## 结果

已补齐防过碎文件与测试分层规范、避坑条目、角色模板与设计约定，3 个完成条件均已满足。改动 7 个文件：.knit/standards/development.md、.knit/standards/pitfalls.md、assets/standards/task-splitting.md、assets/standards/task-writing.md、assets/templates/agents/implement.md、assets/templates/agents/review.md、docs/design/DESIGN.md。已验证：npm run pack:check 通过（95 个文件，clean）；node dist/cli/knit.js standards list 与 standards pitfalls implement 解析正常；node --test test/templates.test.mjs test/standards.test.mjs test/standards-cli.test.mjs 10/10 通过。

未验证：未运行 npm run pack:install、未重生成 .knit/agents/ 副本，且未删除 .knit/standards/ 下 4 份旧版同名规范副本（需全局安装升级后再清理）。
