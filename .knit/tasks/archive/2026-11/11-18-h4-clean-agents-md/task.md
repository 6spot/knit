---
id: k-175d80171122
title: H4 清理 AGENTS.md
status: delivered
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn: []
priority: P1
createdAt: 2026-11-18T06:36:53.483Z
---

## 目标与范围

本仓库已经换用新的 Knit（H3，提交 `a9ce04e`）。根目录的 `AGENTS.md` 还在讲旧 Knit：末尾有旧 Knit 生成的受管块，「开发约定」「交付检查」两节的条目已经写进 `.knit/standards/`，其余条目里有新 Knit 没有的命令和文件。主会话和执行者都会读这个文件，读到的内容和实际不符。

本任务只改一个文件：`AGENTS.md`。做完之后它只留项目通用的说明，不重复规范里已有的内容，不提新 Knit 没有的东西。

逐项怎么处理：

1. 删除受管块：从 `<!-- knit:managed-begin -->` 到 `<!-- knit:managed-end -->`（含这两行）。新 Knit 不写、也不读这个块。
2. 删除「开发约定」整节。逐条的去向：
   - 已经在 `.knit/standards/development.md` 里的（实现范围、先找受影响的内容、改名称或路径、只持久化必要事实、测试的选取、Pi 命令行与不引 SDK、隔离夹具、文风整理、不做防御性过度设计、功能保持独立、不预先提取辅助函数、极不可能的场景先说明），删除。
   - 讲旧 Knit 才有的功能的（`knit task implement`、`task close --force`、clarify／change、原生恢复、开发者模式、Worktree 已实现、`docs/design/DESIGN.md` 第 15.1 节的范围），删除。
   - 「Knit 自身的故障阻碍任务推进时主会话可以直接修」这一条规范里没有，移到「开发入口与任务管理」，去掉“锁、调度或恢复”这几个旧 Knit 的词。
3. 删除「交付检查」整节：前三条在 `development.md` 的「文档」里，第四条在 `.knit/standards/delivery.md` 里。
4. 改写「开发入口与任务管理」：
   - 开头一段改成新 Knit 的入口：管理本仓库的是装在全局的安装版；流程在 `.knit/workflow.yaml`，任务在 `.knit/tasks/`，规范在 `.knit/standards/` 并由 Knit 按环节交给主会话和执行者。
   - 保留这几条的意思，去掉旧 Knit 的词（`rebind`、可交付资格、`in_progress`、`blocked`、stage 名义、检查凭据）：是否建任务由用户决定；`task.md` 是需求的入口，复杂任务按需补 `plan.md`、`design.md`、`research/`；按用户指定的任务推进，接手前确认原来的执行已经结束，不凭旧目录、总结或 todo 认定完成；验证方式的选择；遇到阻塞怎么记。
   - 删除「业务完成、Git 提交和归档分别处理…工作产物与任务元数据分开提交」：前半在 `delivery.md` 里，后半新 Knit 已经不这样做（一个任务一次提交）。
   - 历史档案那一段保留。
   - macOS 那一段保留支持级别和「`npm test` 必须全绿（Rex 终端与普通终端各跑一次）」；指向 `docs/design/TECHNOLOGY.md` 第 6 节的那半句删除（那一节讲的是旧代码的 socket 和锁）；写明 Linux 还没有跑。
   - 最后一段改成：本文件是本仓库自己的，Knit 不写入项目的 `AGENTS.md`。
5. 改写「文档与目录」的目录清单：
   - 现行设计是 `.knit/tasks/11-14-slim-refactor/design.md`，子任务清单和进度是同目录的 `plan.md`。
   - `docs/design/` 讲的是切换之前的旧 Knit，还没有换成小核心的说明。
   - `docs/research/`、`docs/history/`、`validation/` 照旧。
   - `.knit/agents/`、`.knit/workflow.yaml`、`.pi/extensions/knit.ts` 是安装版 `knit init` 生成的副本，模板只有 `assets/templates/` 一份来源；改模板，不改副本。
   - 清单后面讲设计文档怎么写的两段保留不动。

不能动的：

- `.knit/standards/` 下的文件：本任务只删 `AGENTS.md` 里重复的条目，不改规范。
- `README.md`、`docs/README.md`、`docs/design/`：它们也在讲旧 Knit，留给设计文档那个任务（主任务 `plan.md` 的 H5）。
- 不运行 `knit init`、不安装、不提交。

## 完成条件

### Requirement: AGENTS.md 只讲现在的 Knit

#### Scenario: 受管块和旧 Knit 的说法都不在了

- WHEN 运行 `grep -cE "knit:managed|knit_material|knit_context|knit_workflow|knit_snapshot|knit_standards|task implement|task rebind|task search|task update|knit start|candidates\.md|standards/index\.md|clarify|stale_input|Worktree 已实现|15\.1" AGENTS.md`
- THEN 输出 `0`

#### Scenario: 文件里的链接都指向存在的路径

- WHEN 取出 `AGENTS.md` 里每个 Markdown 链接的相对路径，逐个用 `test -e` 检查
- THEN 每个路径都存在

#### Scenario: 规范里已有的条目没有留在 AGENTS.md

- WHEN 运行 `grep -cE "^## 开发约定|^## 交付检查|防御性|辅助函数|Pi SDK|隔离夹具" AGENTS.md`
- THEN 输出 `0`
- AND `grep -c "故障阻碍任务推进" AGENTS.md` 输出 `1`

## 待澄清

无。

## 相关资料

- `AGENTS.md` — 要改的文件
- `.knit/standards/development.md`、`.knit/standards/delivery.md` — 核对哪些条目已经在规范里
- `.knit/tasks/11-14-slim-refactor/design.md` 第 4 节、第 10 节、第 11 节 — 规范放在哪、用 Knit 开发 Knit 的约定、去掉了哪些功能

## 结果

AGENTS.md 从 75 行、14,284 字节减到 31 行、4,072 字节：删掉受管块、「开发约定」和「交付检查」两节，入口和目录清单按新 Knit 改写，「Knit 自身故障可由主会话直接修」一条移到入口一节。三个场景都运行过：旧说法的 grep 输出 0；12 个链接路径逐个 test -e 都存在；规范里已有的条目 grep 输出 0、「故障阻碍任务推进」输出 1。没有改规范、README 和 docs。受管块里只有主会话才用的规则（先取证再提问、一轮最多 3 问、按改动面决定是否派发）现在哪里都没有写，没有补，等用户决定。
