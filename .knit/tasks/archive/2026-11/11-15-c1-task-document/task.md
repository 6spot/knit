---
id: k-d5b1b45edf09
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-15T07:47:25.851Z
title: C1 任务文档：解析和写回 task.md、record.json
---

# C1 任务文档：解析和写回 task.md、record.json

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。小核心里一个任务是 `.knit/tasks/<目录>/` 下的两个文件：`task.md` 放需求、状态和结果，人和程序都读；`record.json` 放人不需要读的运行记录；两个文件的内容不重复（`.knit/tasks/11-14-slim-refactor/design.md` 第 3 节）。新格式和旧代码用的不一样：旧的 `task.md` 用 `status: open|closed` 加 `outcome`，正文里有 `

<!-- knit:progress:start -->
` 记录区，新的都没有。所以本任务是新写，不搬 `src/application/task-document.ts`。

做完之后的不同：`next/` 里有了把 `task.md`、`record.json` 的文本解析成数据、再写回文本的函数，以及算“需求部分的摘要”和“任务现在的状态”的函数。只处理文本，不读写文件（读写文件在 C3）。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/contracts/task.ts`（新增） | `task.md` 开头字段和 `record.json` 的结构定义，状态、验证方式、优先级的取值 |
| `next/src/domain/task-document.ts`（新增） | `parseTaskDocument`、`renderTaskDocument`、`requirementDigest`、`currentStatus` |
| `next/src/domain/task-record.ts`（新增） | `parseTaskRecord`、`renderTaskRecord` |
| `next/test/task-document.test.mjs`（新增） | 见「测试」 |

`task.md` 的格式：

```markdown
---
id: k-19c962be9fb8
title: 交接只传需求部分
status: draft
stage: null
verification: self
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-14T13:36:56.000Z
---

## 目标与范围

## 完成条件

## 待澄清

## 相关资料

## 结果

交接改为只传需求部分。
```

- 开头的九个字段都必须有，不能有别的字段。`id` 是 `k-` 加 12 位十六进制；`parent` 是任务 id 或 `null`；`dependsOn` 是任务 id 的数组；`status` 取 `draft`、`ready`、`active`、`done`、`delivered`、`cancelled`；`verification` 取 `none`、`self`、`independent`；`priority` 取 `P0`–`P3`；`title`、`createdAt` 是非空字符串。
- `stage` 在 `status` 是 `active` 时是环节 id（规则同 `next/src/contracts/workflow.ts` 的 `WORKFLOW_STAGE_ID_PATTERN`），其它状态时是 `null`。两者对不上算格式问题。
- 正文分两部分。**需求部分**是开头字段之后、`## 结果` 这一行之前的全部内容；**结果**是这一行之后的内容。没有 `## 结果` 这一行时结果是 `null`。写在代码围栏（三个以上反引号或波浪号）里面的 `## 结果` 不算。
- 需求部分去掉开头的空行和末尾的空白后保存；结果同样处理。

函数：

- `parseTaskDocument(markdown)` 返回 `{ document, problems }`。没有问题时 `document` 是 `{ frontmatter, requirement, result }`，`problems` 是空数组；有问题时 `document` 是 `null`，`problems` 里每条用一句话写明哪里不对（没有开头字段、不是合法的 YAML 及原因、缺哪个字段、多了哪个字段、哪个字段的值不对）。不抛异常。
- `renderTaskDocument(document)` 写回文本：字段按上面示例的顺序；需求部分之后空一行；有结果时再写 `## 结果`、空一行、结果正文。按这个格式写出的文件，解析后再渲染与原文逐字相同。
- `requirementDigest(document)`：需求部分的 SHA-256 十六进制串，用 `next/src/contracts/digest.ts` 的 `sha256Text`。只算需求部分，不含开头字段和结果。
- `currentStatus(document, record)`：文件里的 `status` 是 `ready` 或 `active`，而 `record.confirmedDigest` 和现在的需求摘要不一样时，返回 `draft`（确认之后需求被改过，要重新确认）；其它情况返回文件里的 `status`。

`record.json` 的格式：

```json
{
  "confirmedDigest": null,
  "changedPaths": [],
  "runs": [],
  "authorization": null
}
```

| 字段 | 内容 |
| --- | --- |
| `confirmedDigest` | 需求确认时的需求摘要；没确认过是 `null` |
| `changedPaths` | 主会话直接做时登记的改动文件，项目内的相对路径 |
| `runs` | 每次执行一条：`id`、`stage`、`startedAt`、`endedAt`（没结束是 `null`）、`verdict`（审查环节的结论，其它情况是 `null`）、`requirementDigest`、`changedPaths`、`sessionFile`（没有是 `null`） |
| `authorization` | 交付时用户授权的引用；没有是 `null` |

- `parseTaskRecord(json)` 返回 `{ record, problems }`，规则同 `parseTaskDocument`。传入 `null`（文件不存在）时返回上面这份空记录。不能有别的字段。
- `renderTaskRecord(record)`：两个空格缩进的 JSON，字段按上表的顺序，末尾一个换行。
- `runs` 的字段照 `design.md` 第 3.3 节定；做执行的任务可以按需要调整。

测试（都是对文本和数据的测试，不碰文件）：

1. 解析上面的示例，得到九个字段、需求部分和结果。
2. 上面的示例解析后再渲染，与原文逐字相同。
3. 把 `status` 改成 `done` 并写入结果后渲染、再解析：需求部分逐字不变，需求摘要不变。
4. 需求部分的代码围栏里有一行 `## 结果`：它留在需求部分里。
5. 没有 `## 结果` 时结果是 `null`，渲染出的文本里没有这一节。
6. 格式问题各一例：没有开头字段、YAML 写错、缺 `title`、多一个字段、`status` 的值不认识、`status: active` 但 `stage: null`。每例 `document` 是 `null`，`problems` 里点到了对应的字段。
7. `currentStatus`：`ready` 且摘要一致是 `ready`；`ready` 或 `active` 且摘要不一致是 `draft`；`done` 且摘要不一致仍是 `done`；`draft` 是 `draft`。
8. `record.json`：`null` 得到空记录；渲染后再解析与原数据相同；JSON 写错、多一个字段、`changedPaths` 不是数组各一例，`record` 是 `null` 且有问题说明。

新写的代码遵守 `.knit/standards/development.md`。YAML 用 `yaml` 包的 `parseDocument`（不抛异常，问题在 `errors` 里），写法可以参考 `next/src/domain/workflow.ts`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里已有的文件：本任务只新增。
- 不加依赖，不提交、不推送。

前置条件：`npm run test:next` 能通过。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 新增三个源文件和测试文件。
4. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出上表的 4 个新文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件（照 `git status --short` 抄）、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add the task document and record formats`。

## 完成条件

### Requirement: 读写任务的两个文件

#### Scenario: 写回时不改动没动的部分

- GIVEN 一份按格式写的 `task.md` 文本
- WHEN 解析它，把状态改成 `done` 并写入结果，再渲染
- THEN 需求部分逐字不变，需求摘要不变
- AND 不做修改直接渲染时，与原文逐字相同

#### Scenario: 格式不对时指出问题

- WHEN 解析缺字段的 `task.md` 文本，或多了字段的 `record.json` 文本
- THEN 得不到数据，问题说明里点到了出问题的字段

#### Scenario: 确认后改了需求按 draft 算

- GIVEN 文件里的状态是 `ready`，`record.json` 里记着确认时的需求摘要
- WHEN 需求部分被改动后调用 `currentStatus`
- THEN 返回 `draft`

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md` 第 3 节 — 任务资料：两个文件的分工、`task.md` 的格式、状态、`record.json` 的字段
- `.knit/standards/development.md` — 开发规范
- `next/src/contracts/workflow.ts`、`next/src/contracts/schema.ts` — 结构定义和校验的写法；环节 id 的规则
- `next/src/domain/workflow.ts` — 用 `parseDocument` 解析 YAML、返回问题清单的写法
- `next/src/contracts/digest.ts` — `sha256Text`

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-ffd9afdb3162 -->
- 操作: op-ffd9afdb3162
- 时间: 2026-11-15T09:06:40.973Z
- 分支: refs/heads/main
- 授权来源: user:0f1c5bab
- 调用: bridge
- 工作提交: 7fd8feca3761c455d860ae3fc9fc5b9364d89d9f
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-c1-task-document

### 任务资料提交记录

<!-- knit:metadata-commit:op-ffd9afdb3162 -->
- 任务资料提交: badc763cc607adb078561707794fe1fc884db393
- 归档目标: .knit/tasks/archive/2026-11/11-15-c1-task-document

<!-- knit:progress:end -->
