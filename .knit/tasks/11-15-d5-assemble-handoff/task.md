---
id: k-57d543a6c0f6
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-6724429685d5
order: null
createdAt: 2026-11-15T10:00:36.365Z
title: D5 拼出交给环节执行者的内容
---

# D5 拼出交给环节执行者的内容

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。派发一个环节时，程序把执行者需要的内容拼好交给它：角色文件和适用本环节的规范放在系统提示里，需求部分、点名的资料、计划和上一个环节的报告放在第一条消息里。「结果」、`record.json`、其它任务和没有点名的资料都不给（`.knit/tasks/11-14-slim-refactor/design.md` 第 5 节）。前面的任务已经能挑规范（D1）和读点名的资料（D4），本任务把它们拼起来。启动执行者不在本任务里，由后面做执行的任务调用本任务的函数。

做完之后的不同：`next/` 里有了 `assembleHandoff`，给它任务和环节，得到系统提示和第一条消息两段文本。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/handoff.ts`（新增） | `assembleHandoff(input)` |
| `next/test/handoff.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`assembleHandoff(input)` 的参数：

| 字段 | 内容 |
| --- | --- |
| `root` | 项目根 |
| `task` | `{ dir, document }`：任务目录（项目内的相对路径）和解析出的 `task.md`，就是 `task-store.ts` 的 `findTask` 给出的那两项 |
| `stage` | `{ id, prompt }`：环节 id 和角色文件的路径（可以是 `null`），就是流程定义里的一个环节 |
| `previous` | 上一个环节的报告，没有时是 `null`：`{ stage, path, changedPaths, text }`，分别是环节 id、报告原文的路径、改动的文件、报告原文 |

返回 `{ systemPrompt, firstMessage, problems }`。

系统提示，各块之间空一行：

1. 角色文件的全文（`stage.prompt` 不是 `null` 时）。
2. 规范，一份一块，按路径排序：

   ```
   <standard path=".knit/standards/development.md" title="开发规范">
   规范的正文，不带开头声明
   </standard>
   ```

   给哪些规范：D1 的 `standardsForStage` 挑出的适用本环节的规范，加上任务在「相关资料」里点名的规范（路径是 `loadStandards` 读出的某一份规范，带不带 `#标题` 都按整份算）。同一份只给一次。

第一条消息，各块之间空一行，按下面的顺序；没有的块不出现：

1. 任务：

   ```
   <task path=".knit/tasks/11-15-handoff/task.md">
   # 任务标题

   需求部分的全文
   </task>
   ```

2. 点名的资料，一份一块，按「相关资料」里的先后。`path` 照任务里的写法，带着 `#标题`。目录没有内容，块里写一句 `这是一个目录，没有附上内容。`。点名的规范已经在系统提示里，这里不再出现。

   ```
   <material path=".knit/tasks/11-14-slim-refactor/design.md#5-交接">
   内容
   </material>
   ```

3. 计划：任务目录里有 `plan.md` 时给全文，块是 `<plan path="…">`。「相关资料」里已经点名了这份 `plan.md` 时不重复给。
4. 上一个环节的报告（`previous` 不是 `null` 时）：

   ```
   <previous-report stage="implement" path=".knit/.runtime/runs/r-1/report.md">
   改动的文件：
   - next/src/a.ts
   - next/src/b.ts

   报告原文
   </previous-report>
   ```

   没有改动的文件时，那一段写 `改动的文件：无`。

`problems`：D4 的 `readMaterials` 给出的问题，加上角色文件不存在时的一句 `环节 <环节 id> 的角色文件不存在：<路径>`。有问题时两段文本照样拼出来（有问题的那份资料不在里面），由调用方决定要不要派发。

- 每块的内容去掉首尾的空行。
- 同样的输入得到逐字相同的输出：不放时间、编号这类每次不同的内容。
- 对所有环节都成立的硬规则（不能提交、不能改受保护的路径、报告的格式）不在本任务里，由做执行的任务加。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里已有的文件：本任务只新增文件，只调用已有的函数。发现问题写进报告，不在本任务里改。
- 不启动 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：D1、D4 已完成。运行 `npm run test:next` 能通过，并且 `grep -n "export function" next/src/application/standards-store.ts next/src/application/task-materials.ts` 有两行输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `application/handoff.ts`。
4. 写测试：用 `next/test/helpers/cli.mjs` 的 `project` 建临时项目，用 `knit` 运行 `task new` 建任务，再往临时项目里写规范、角色文件、资料和 `plan.md`；用 `findTask` 取出任务后调用 `assembleHandoff`。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出上表的 2 个新文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): assemble the handoff for a stage`。

## 完成条件

### Requirement: 拼出交接内容

#### Scenario: 系统提示里是角色文件和规范

- GIVEN 环节 `implement` 有角色文件；规范 `a.md` 声明 `implement`，`b.md` 声明 `deliver`，`c.md` 没有声明环节；任务在「相关资料」里点名了 `c.md`
- WHEN 为 `implement` 环节拼交接内容
- THEN 系统提示以角色文件的全文开头，后面是 `a.md` 和 `c.md` 两块规范，按路径排序，没有 `b.md`
- AND 第一条消息里没有这三份规范的正文

#### Scenario: 第一条消息里是需求、资料、计划和上一环节的报告

- GIVEN 一个写了「结果」的任务，「相关资料」点名了一个文件和一份文档的一节，任务目录里有 `plan.md` 和 `record.json`，并给了上一个环节的报告
- WHEN 拼交接内容
- THEN 第一条消息依次是任务块、两块资料、计划块、报告块；文档只有点名的那一节
- AND 两段文本里都没有「结果」的内容和 `record.json` 的内容；连续拼两次得到逐字相同的结果

#### Scenario: 缺少文件时说明问题

- GIVEN 环节的角色文件不存在，任务点名的一个文件也不存在
- WHEN 拼交接内容
- THEN `problems` 里有两句话，分别带着角色文件的路径和那个文件的路径
- AND 任务没有 `plan.md`、没有上一环节的报告时，第一条消息里没有计划块和报告块

## 待澄清


## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#5-交接` — 给谁什么、放在哪里
- `.knit/standards/development.md` — 开发规范
- `next/src/domain/standards.ts`、`next/src/application/standards-store.ts` — D1 的 `standardsForStage`、`loadStandards`
- `next/src/domain/task-references.ts`、`next/src/application/task-materials.ts` — D4 的 `referencesOf`、`readMaterials`
- `next/src/application/task-store.ts` — `findTask` 给出的任务数据
- `next/src/domain/task-document.ts` — 任务文档的数据：标题、需求部分
- `next/test/helpers/cli.mjs`、`next/test/task-ready.test.mjs` — 在临时项目里建任务、改写任务文件的现有写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
