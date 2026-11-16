---
id: k-d9b439fae8ac
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-16T15:19:29.659Z
title: G1 模板：流程、角色文件和配置
---

# G1 模板：流程、角色文件和配置

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。`knit init` 要往项目里生成流程、角色文件和配置，这些文件的模板随 Knit 发布。本任务只把模板放好，`knit init` 在下一个任务里做。

做完之后的不同：`next/assets/templates/` 里有四份模板和一份忽略规则，流程模板能通过校验。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/assets/templates/workflow.yaml`（新增） | 逐字复制 `.knit/tasks/11-14-slim-refactor/research/templates/workflow.yaml.md`（来源的文件名多一个 `.md`，是因为任务资料只收 Markdown 文件；内容就是 YAML，复制时文件名用 `workflow.yaml`） |
| `next/assets/templates/agents/implement.md`（新增） | 逐字复制 `.knit/tasks/11-14-slim-refactor/research/templates/implement.md` |
| `next/assets/templates/agents/review.md`（新增） | 逐字复制 `.knit/tasks/11-14-slim-refactor/research/templates/review.md` |
| `next/assets/templates/config.json`（新增） | 三行：`{`、`  "handoff": { "fileBytes": 16384, "totalBytes": 65536 }`、`}`，结尾一个换行 |
| `next/assets/templates/gitignore`（新增） | 一行 `.runtime/`，结尾一个换行。以后生成为 `.knit/.gitignore`；文件名不带点，是因为 npm 打包时不收名叫 `.gitignore` 的文件 |
| `next/test/templates.test.mjs`（新增） | 见「完成条件」的两个场景，各一个测试 |

要求：

- 流程模板的顶层不写生效的 `model`（只有一行注释掉的示例）：用哪个模型由项目自己定，没写时派发会被拒绝并提示怎么写。
- 角色文件只写这个角色在 Knit 里怎么工作，不写任何项目的规范；不能提交、不能改哪些文件、报告结尾的格式由程序另外给（`next/src/domain/stage-rules.ts`），角色文件里不重复。
- 复制之后不改内容。读下来发现和 `design.md` 第 6.2、7.1 节对不上的地方，写进报告，不自己改。

测试用 `new URL("../assets/templates/", import.meta.url)` 找到模板目录，用 `next/dist/domain/workflow.js` 的 `parseWorkflow` 和 `next/dist/application/config.js` 的 `loadConfig`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `ls next/assets` 报没有这个目录。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 建目录，复制三份模板，写 `config.json` 和 `gitignore`。
4. 用 `cmp` 核对三份复制的文件和来源逐字相同。
5. 写测试。
6. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add the workflow, role and config templates`。

## 完成条件

### Requirement: 模板可以直接使用

#### Scenario: 流程模板通过校验

- WHEN 用 `parseWorkflow` 解析流程模板
- THEN 没有问题；环节依次是 `implement`、`review`，每个环节的模型都是空的
- AND `review` 的报告声明了 `verdict`，值是 `pass`、`changes_requested`、`blocked`；`changes_requested` 去 `implement`，`blocked` 去 `review`
- AND 两个环节的 `prompt` 分别是 `.knit/agents/implement.md`、`.knit/agents/review.md`，模板目录里有对应的 `agents/implement.md`、`agents/review.md`，内容不是空的

#### Scenario: 配置模板等于缺省值

- GIVEN 一个临时项目，`.knit/config.json` 是配置模板的内容
- WHEN 用 `loadConfig` 读它
- THEN 没有问题，读出的配置和没有这个文件时读出的相同

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#61-流程` — 流程文件的格式
- `.knit/tasks/11-14-slim-refactor/design.md#62-角色文件` — 角色文件写什么、不写什么
- `.knit/tasks/11-14-slim-refactor/design.md#71-返工` — 审查和返工对报告的要求
- `.knit/tasks/11-14-slim-refactor/research/templates/workflow.yaml.md` — 流程模板的来源
- `.knit/tasks/11-14-slim-refactor/research/templates/implement.md` — 实现角色文件的来源
- `.knit/tasks/11-14-slim-refactor/research/templates/review.md` — 审查角色文件的来源
- `next/src/domain/stage-rules.ts` — 程序给每个环节的规则，角色文件不重复
- `next/src/application/config.ts` — `loadConfig`
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
