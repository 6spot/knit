---
id: k-adfe1afc79ec
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-15T09:58:53.168Z
title: D1 读规范的适用环节声明并按环节挑选
---

# D1 读规范的适用环节声明并按环节挑选

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。项目规范是 `.knit/standards/` 下的 Markdown，一份一个文件，每份在开头声明自己适用哪些环节；程序按环节把规范交给智能体（`.knit/tasks/11-14-slim-refactor/design.md` 第 4 节）。本任务做“读声明”和“按环节挑”这两步，后面的任务（列出规范、拼交接内容）调用它。

做完之后的不同：`next/` 里有了读出项目全部规范、并挑出适用某个环节的规范的函数。

规范文件的样子：

```markdown
---
title: 开发规范
stages: [implement, review]
---

## 范围

- 实现范围以任务和它点名的设计为准。
```

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/domain/standards.ts`（新增） | `parseStandard(path, markdown)`：把一份规范的文本解析成数据；`standardsForStage(standards, stage)`：挑出适用某个环节的规范。只处理文本，不读文件 |
| `next/src/application/standards-store.ts`（新增） | `loadStandards(root)`：读出 `.knit/standards/` 下的全部规范 |
| `next/test/standards.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

一份规范解析出的数据：

| 字段 | 内容 |
| --- | --- |
| `path` | 项目内的相对路径，用 `/` 分隔，如 `.knit/standards/development.md` |
| `title` | 开头声明里的 `title`；没有时是文件名去掉 `.md` |
| `stages` | 声明的适用环节；没有声明或声明有问题时是空数组 |
| `body` | 开头声明之后的正文，去掉首尾的空行；没有开头声明时是全文 |
| `problems` | 开头声明的格式问题，一处一句话；没有问题时是空数组 |

`parseStandard` 的规则：

- 开头声明是文件开头两行 `---` 之间的 YAML，和 `task.md` 的开头字段是同一种写法。
- 文件不以 `---` 开头，或声明里没有 `stages`，或 `stages` 是空数组：`stages` 是空数组，`problems` 是空数组。这是允许的状态，表示这份规范不交给任何环节。
- 文件以 `---` 开头却没有收尾的 `---`，或声明不是合法的 YAML，或 `title` 不是非空字符串，或 `stages` 不是字符串数组：`problems` 里写明是哪个字段、什么问题，`stages` 是空数组，`body` 是全文。
- 声明里其它的字段不管。
- 不核对环节名在流程里有没有：那是列出规范时做的事（D2）。

`standardsForStage(standards, stage)`：返回 `stages` 里包含 `stage` 的规范，按 `path` 排序。`stage` 可以是流程里的环节 id，也可以是固定的 `discuss`、`deliver`，这里不区分。

`loadStandards(root)`：读 `.knit/standards/` 下所有以 `.md` 结尾的文件，含子目录里的，按 `path` 排序返回。目录不存在时返回空数组。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里已有的文件：本任务只新增文件，只调用已有的函数。发现问题写进报告，不在本任务里改。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过（92 个测试）。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `domain/standards.ts` 和 `application/standards-store.ts`。
4. 写测试：文本解析直接调用 `parseStandard`；读目录的部分在临时目录里建 `.knit/standards/` 再调用 `loadStandards`。测试从 `next/dist/` 导入编译后的文件，写法照 `next/test/task-document.test.mjs`。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出上表的 3 个新文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): read and select standards by stage`。

## 完成条件

### Requirement: 按环节挑选规范

#### Scenario: 挑出适用某个环节的规范

- GIVEN `.knit/standards/` 下有三份规范：`a.md` 声明 `implement`、`review`，`b.md` 声明 `deliver`，`sub/c.md` 声明 `implement`
- WHEN 读出全部规范，再挑适用 `implement` 的
- THEN 得到 `a.md` 和 `sub/c.md`，按路径排序，`title` 是各自声明的标题，`body` 里没有开头声明
- AND 挑适用 `discuss` 的得到空数组

#### Scenario: 没有声明环节的规范不挑

- WHEN 解析三份规范：一份没有开头声明，一份的声明里没有 `stages`，一份写着 `stages: []`
- THEN 三份的 `stages` 都是空数组，`problems` 都是空数组，挑任何环节都挑不到它们
- AND 没有 `title` 的那份，`title` 是文件名去掉 `.md`

#### Scenario: 声明写坏的规范不挑并说明问题

- WHEN 解析两份规范：一份的声明不是合法的 YAML，一份写着 `stages: implement`
- THEN 两份的 `problems` 都不是空的，后一份的问题里提到 `stages`
- AND 两份的 `stages` 都是空数组

## 待澄清

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#4-规范` — 规范的写法和注入规则
- `.knit/standards/development.md` — 开发规范，同时是一份真实的规范文件
- `next/src/domain/task-document.ts` — 开头字段的解析写法：`parseDocument`、返回问题清单
- `next/src/contracts/task.ts` — 结构定义的写法；`schemaProblems` 把结构问题翻译成句子，可以直接用
- `next/src/application/task-store.ts` — 读目录、拼项目内相对路径的写法
- `next/test/task-document.test.mjs` — 测试的写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-5ec737a49d4a -->
- 操作: op-5ec737a49d4a
- 时间: 2026-11-15T11:01:35.126Z
- 分支: refs/heads/main
- 授权来源: user:5c30905e
- 调用: bridge
- 工作提交: ed21de07084f89d0fe13b52a32d7cdb8c5d88124
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-d1-standards-by-stage

<!-- knit:progress:end -->
