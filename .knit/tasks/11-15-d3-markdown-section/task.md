---
id: k-da1a903f94f0
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-b288b073f0c0
order: null
createdAt: 2026-11-15T10:00:34.518Z
title: D3 按标题取 Markdown 文档的一节
---

# D3 按标题取 Markdown 文档的一节

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。任务在「相关资料」里点名要读的文件，可以用 `路径#标题` 只点文件里的一节，这样大文档不用整份交给执行者（`.knit/tasks/11-14-slim-refactor/design.md` 第 3.1 节、第 5.1 节）。本任务做“按标题取一节”这一步，拼交接内容的任务（D4）调用它。

做完之后的不同：`next/` 里有了从 Markdown 文本里按标题取出一节的函数。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/domain/markdown.ts`（新增） | `headingsOf(lines)`：找出不在代码围栏里的标题；`sectionOf(markdown, anchor)`：按标题取一节 |
| `next/src/domain/task-document.ts`（修改） | 找「结果」标题时改用 `headingsOf` 跳过代码围栏，不再自己带一份围栏判断；行为不变 |
| `next/test/markdown.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`headingsOf(lines)`：

- 参数是按行拆开的文本，返回每个标题所在的行号（从 0 起）、级别（1–6）和标题文字。
- 标题是顶格的 1–6 个 `#` 加空白再加文字的行。
- 代码围栏里的行不算标题。围栏的判断规则沿用 `task-document.ts` 里现有的 `resultHeadingLine`：开头是不超过 3 个空格加至少 3 个 `` ` `` 或 `~`；收尾是同一种字符起头、其后只有空白的行。把这段判断搬到这里，`task-document.ts` 里不再保留第二份。

`sectionOf(markdown, anchor)`：

- 按标题找到一节，返回从那个标题行开始、到下一个同级或更高级标题之前的文本，去掉末尾的空行。下级标题和它们的内容都在这一节里。
- 怎样算“标题对得上”：把 `anchor` 和标题文字各自按下面的规则转换，结果相同就算。规则是：去掉首尾空白，转小写，删掉字母、数字、空白、`-`、`_` 以外的字符（字母和数字按 Unicode 算，汉字保留），再把连续的空白换成一个 `-`。这样标题 `## 5. 交接` 用 `5-交接` 和 `5. 交接` 都能找到。
- 有多个标题对得上时取第一个。一个都对不上时返回 `null`。

`task-document.ts` 的修改：`parseTaskDocument` 对任何输入的结果都和修改前相同，`next/test/task-document.test.mjs` 的 8 个测试不改、继续通过。「结果」标题仍然要求那一行去掉行尾空白后正好是 `## 结果`。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/src/domain/task-requirements.ts`：它是从旧代码原样搬来的，有自己的解析，本任务不动它。
- `next/` 里其它已有的文件和测试。发现问题写进报告，不在本任务里改。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `domain/markdown.ts`，改 `domain/task-document.ts`。
4. 写测试，直接调用函数，文本写在测试里。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- 用一份真实的文档看一眼（只读）。运行：

  ```
  node --input-type=module -e 'import { readFileSync } from "node:fs"; import { sectionOf } from "./next/dist/domain/markdown.js"; const s = sectionOf(readFileSync(".knit/tasks/11-14-slim-refactor/design.md", "utf8"), "3-任务资料").split("\n"); console.log(s[0]); console.log(s.some((line) => line.startsWith("## 4.")));'
  ```

  打印 `## 3. 任务资料` 和 `false`。这一节里有一个代码围栏，围栏里有 `## 目标与范围` 这样的行，取出来的一节不能在那里断开：再运行同一条命令，把最后一个 `console.log` 换成 `console.log(s.includes("### 3.3 record.json"))`，打印 `true`。
- `git status --short`：和开始前相比，只多出 2 个新文件和 `next/src/domain/task-document.ts` 的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): take one section of a markdown document`。

## 完成条件

### Requirement: 按标题取一节

#### Scenario: 取出一节和它的下级内容

- GIVEN 一份文档里依次有 `## 5. 交接`、它下面的 `### 5.1 给谁什么` 和 `### 5.2 放在哪里`、再后面的 `## 6. 流程`
- WHEN 分别用 `5-交接` 和 `5. 交接` 取一节
- THEN 两次的结果相同：从 `## 5. 交接` 那一行开始，包含两个下级标题和它们的内容，不包含 `## 6. 流程`，末尾没有空行
- AND 用 `5.1 给谁什么` 取到的一节在 `### 5.2 放在哪里` 之前结束

#### Scenario: 代码围栏里的标题不算

- GIVEN 一节的正文里有一个代码围栏，围栏里有一行 `## 目标与范围`
- WHEN 取这一节
- THEN 结果包含整个围栏和围栏之后、下一个同级标题之前的内容
- AND 用 `目标与范围` 取一节得到 `null`

#### Scenario: 找不到和重名

- WHEN 用文档里没有的标题取一节
- THEN 得到 `null`
- AND 文档里有两个同名标题时，取到的是第一个

## 待澄清

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#3-任务资料` — 「相关资料」里 `#标题` 的用法；这一节本身也是验证用的样本
- `.knit/standards/development.md` — 开发规范
- `next/src/domain/task-document.ts` — 要改的文件：`resultHeadingLine` 里现有的围栏判断
- `next/test/task-document.test.mjs` — 修改后要继续通过的测试，含“围栏里的结果标题不算”

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
