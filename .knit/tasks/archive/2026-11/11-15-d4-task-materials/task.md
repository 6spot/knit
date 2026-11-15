---
id: k-6724429685d5
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-da1a903f94f0
order: null
createdAt: 2026-11-15T10:00:35.444Z
title: D4 读出任务「相关资料」点名的文件和章节
---

# D4 读出任务「相关资料」点名的文件和章节

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。任务的需求部分里有一节「相关资料」，一行一个路径加理由，可以用 `路径#标题` 只点文件里的一节。派发环节时，程序把点名的文件或章节一起交给执行者，没有点名的资料不给（`.knit/tasks/11-14-slim-refactor/design.md` 第 3.1 节、第 5.1 节）。本任务做“读出点名了什么”和“把内容读出来”这两步，拼交接内容的任务（D5）调用它。

做完之后的不同：`next/` 里有了从需求部分读出点名的资料、并读出它们内容的函数。

「相关资料」的样子：

```markdown
## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#5-交接` — 本任务依据的设计
- `next/src/domain/task-document.ts`、`next/src/domain/task-record.ts` — `currentStatus`、渲染
- `next/src/adapters/pi/` — 搬来的代码
```

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/domain/task-references.ts`（新增） | `referencesOf(requirement)`：从需求部分读出点名的资料。只处理文本 |
| `next/src/application/task-materials.ts`（新增） | `readMaterials(root, references)`：读出每份资料的内容 |
| `next/src/infrastructure/paths.ts`（修改） | 新增 `projectRelative(path)`：项目内的相对路径返回规整后的写法（用 `/` 分隔，去掉开头的 `./`），绝对路径和跑出项目根的路径返回 `null` |
| `next/src/cli/task.ts`（修改） | `task close` 判断 `--paths` 的那几行改为调用 `projectRelative`，行为不变 |
| `next/test/task-materials.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`referencesOf(requirement)` 返回一组 `{ path, anchor }`，`anchor` 没有时是 `null`。规则：

- 「相关资料」这一节从正好是 `## 相关资料` 的一行开始，到下一个一级或二级标题之前结束。没有这一节时返回空数组。
- 只看以 `- ` 顶格开头的行。
- 每行只看第一个 ` — `（空格、破折号 U+2014、空格）之前的部分；没有破折号时看整行。破折号之后是理由，理由里的反引号内容不算。
- 这一部分里每一对反引号之间的内容是一份资料。内容里第一个 `#` 之前是路径，之后是标题；`#` 之后是空的时按没有标题算。一行里可以点名多份。
- 路径和标题都相同的只留第一次出现的，顺序按出现的先后。

`readMaterials(root, references)` 返回 `{ materials, problems }`。`materials` 的每一项是 `{ reference, kind, text }`，顺序和 `references` 相同：

| 情形 | 结果 |
| --- | --- |
| 路径是文件，没有标题 | `kind` 是 `file`，`text` 是文件全文 |
| 路径是文件，有标题 | `kind` 是 `section`，`text` 是 D3 的 `sectionOf` 取出的一节 |
| 路径是目录 | `kind` 是 `directory`，`text` 是 `null` |
| 路径不是项目内的相对路径 | 不进 `materials`；`problems` 里加一句 `相关资料里的路径要写项目内的相对路径：<路径>` |
| 文件不存在 | 不进 `materials`；`problems` 里加一句 `相关资料里点名的文件不存在：<路径>` |
| 文件里没有这个标题 | 不进 `materials`；`problems` 里加一句 `<路径> 里没有标题「<标题>」` |

路径一律相对项目根。一份资料有问题不影响其它资料照常读出。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `task close` 的行为：`next/test/task-close.test.mjs` 不改、继续通过。
- `next/src/domain/task-requirements.ts`、D3 的 `next/src/domain/markdown.ts`：本任务只调用。发现问题写进报告，不在本任务里改。
- 不加依赖，不提交、不推送。

前置条件：D3 已完成。运行 `npm run test:next` 能通过，并且 `grep -n "export function sectionOf" next/src/domain/markdown.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 在 `infrastructure/paths.ts` 里加 `projectRelative`，把 `cli/task.ts` 里 `task close` 的路径判断换成它，运行 `npm run test:next` 确认仍然通过。
4. 写 `domain/task-references.ts` 和 `application/task-materials.ts`。
5. 写测试：`referencesOf` 直接给文本；`readMaterials` 在临时目录里建几个文件再调用。
6. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 3 个新文件和上表两个文件的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): read the materials a task names`。

## 完成条件

### Requirement: 读出点名的资料

#### Scenario: 从「相关资料」读出路径和标题

- GIVEN 「相关资料」里有三行：一行点名一个文件，一行用 `、` 隔开点名两个文件，一行是 `路径#标题`；每行的理由里都有反引号内容
- WHEN 调用 `referencesOf`
- THEN 得到四份资料，顺序和出现的先后相同，第四份带着标题，理由里的反引号内容都不在其中
- AND 同一个路径写了两次时只得到一份；需求部分没有「相关资料」时得到空数组

#### Scenario: 读出文件、章节和目录

- GIVEN 项目里有一个文件、一份带两个二级标题的文档和一个目录
- WHEN 对这三者（文档带着第一个标题）调用 `readMaterials`
- THEN 文件得到全文，文档只得到点名的那一节，目录的 `text` 是 `null`
- AND `problems` 是空数组

#### Scenario: 找不到时说明是哪一份

- WHEN 对一个不存在的文件、一个文档里没有的标题、一个 `../outside.md` 调用 `readMaterials`
- THEN `problems` 里有三句话，各自带着对应的路径
- AND 同一次调用里另一份存在的文件照常读出

## 待澄清


## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#5-交接` — 交接给执行者什么、不给什么
- `.knit/standards/development.md` — 开发规范
- `next/src/domain/markdown.ts` — D3 的 `sectionOf`
- `next/src/domain/task-requirements.ts` — `clarifyStateOf` 里“一节到下一个一级或二级标题为止”的现有写法
- `next/src/infrastructure/paths.ts` — 要改的文件
- `next/src/cli/task.ts` — `task close` 里现有的路径判断
- `next/test/task-close.test.mjs` — 修改后要继续通过的测试，含路径被拒绝的情形

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-fe9709097b1c -->
- 操作: op-fe9709097b1c
- 时间: 2026-11-15T11:01:49.429Z
- 分支: refs/heads/main
- 授权来源: user:5c30905e
- 调用: bridge
- 工作提交: a70bea28cfba10338fa23f57de1721c59fef495c
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-d4-task-materials

### 任务资料提交记录

<!-- knit:metadata-commit:op-fe9709097b1c -->
- 任务资料提交: 113f5de5735e6db7b85a14638335f44ac663d490
- 归档目标: .knit/tasks/archive/2026-11/11-15-d4-task-materials

<!-- knit:progress:end -->
