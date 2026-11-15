---
id: k-1720b3176696
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-8ffe28f210d4
order: null
createdAt: 2026-11-15T15:02:40.006Z
title: E6 对比工作区得出改动文件，认出提交和受保护的路径
---

# E6 对比工作区得出改动文件，认出提交和受保护的路径

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。一次执行改了哪些文件，不听执行者自己报，由程序对比派发时和结束时的工作区得出；执行者不能提交，也不能改规范、流程、配置和角色文件，改了这次执行记为失败（`.knit/tasks/11-14-slim-refactor/design.md` 第 7 节）。本任务只写对比用的三个函数，由后面的任务调用。

做完之后的不同：`next/` 里能给工作区拍一份记录，之后说出哪些文件变了、HEAD 有没有动、变了的文件里哪些是受保护的。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/workspace.ts`（新增） | `takeSnapshot(root)`、`changesSince(root, before)`、`protectedChanges(changedPaths, workflow)` |
| `next/test/helpers/git.mjs`（新增） | `gitProject(t)`：在 `project(t)` 建的临时项目里 `git init` 并做第一次提交，返回目录；后面的任务也用它 |
| `next/test/workspace.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`takeSnapshot(root)` 返回 `{ head, files }`，要能直接用 `JSON.stringify` 存成文件再读回来用：

- `head`：`git rev-parse HEAD` 的结果；仓库还没有提交时是 `null`。
- `files`：路径到指纹的对照。路径来自 `git ls-files -co --exclude-standard -z`（已跟踪的文件加上没被忽略的新文件），相对项目根、用 `/` 分隔，去掉 `.knit/.runtime/` 下的。指纹由文件的类型、权限和内容摘要组成，用 `next/src/infrastructure/fingerprint.ts` 的 `fileFacts`；已跟踪但磁盘上已经删掉的文件按“不存在”记。
- Git 命令用 `next/src/infrastructure/process.ts` 的 `gitSync`。

`changesSince(root, before)` 现在再拍一次，和 `before` 比，返回 `{ changedPaths, head }`：

- `changedPaths`：两边指纹不同的路径，含只在一边出现的（新增、删除），按路径排序。
- `head`：没变时是 `null`，变了是 `{ before, after }`。

`protectedChanges(changedPaths, workflow)` 返回 `changedPaths` 里受保护的那些：`.knit/standards/` 下的文件、`.knit/workflow.yaml`、`.knit/config.json`，以及流程里各环节的角色文件（`stage.prompt`，用 `next/src/infrastructure/paths.ts` 的 `projectRelative` 规整后再比）。

边界：

- 三个函数都假定 `root` 是 Git 仓库的顶层目录；不是仓库时怎么办由调用方处理，不在本任务里。
- 只对比，不恢复：小核心不做快照恢复。
- 执行期间别人（主会话、用户）改的文件也会出现在 `changedPaths` 里，小核心不区分改动是谁做的。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function projectRelative" next/src/infrastructure/paths.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `application/workspace.ts`。
4. 写 `helpers/git.mjs` 和测试。提交时用 `git -c user.name=knit -c user.email=knit@example.invalid -c commit.gpgsign=false commit`，不依赖机器上的 Git 配置。流程用 `parseWorkflow` 解析一段 YAML 得到。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 3 个新文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：本任务要求独立审查，由另一个执行者对照完成条件审查；提交由用户另行授权，文案首行建议 `feat(next): detect what a run changed`。

## 完成条件

### Requirement: 对比工作区

#### Scenario: 新增、修改、删除的文件都算改动

- GIVEN 一个有提交的仓库，`.gitignore` 忽略了 `ignored/`；拍一份记录
- WHEN 之后新增一个文件、改一个已跟踪的文件、删一个已跟踪的文件、给一个文件加上可执行权限，并在 `ignored/` 和 `.knit/.runtime/` 下各写一个文件
- THEN `changedPaths` 正好是前四个文件，按路径排序；`head` 是 `null`
- AND 记录经过 `JSON.parse(JSON.stringify(…))` 之后再比，结果相同；什么都没改时 `changedPaths` 是空的

#### Scenario: HEAD 动了能看出来

- GIVEN 拍一份记录之后，改一个文件并提交
- WHEN 和记录对比
- THEN `head` 是 `{ before, after }`，两个都是完整的提交号且不相同
- AND 提交过的那个文件仍然在 `changedPaths` 里

#### Scenario: 认出受保护的路径

- GIVEN 流程里实现环节的角色文件是 `.knit/agents/implement.md`
- WHEN 把 `.knit/standards/a.md`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/implement.md`、`.knit/agents/other.md`、`src/a.ts` 交给 `protectedChanges`
- THEN 返回前四个
- AND `.knit/agents/other.md` 不是流程用到的角色文件，不算

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 改动文件怎么得出、哪些路径受保护
- `.knit/standards/development.md` — 开发规范
- `next/src/infrastructure/fingerprint.ts` — `fileFacts`
- `next/src/infrastructure/process.ts` — `gitSync`
- `next/src/infrastructure/paths.ts` — `projectRelative`
- `next/src/domain/workflow.ts` — `WorkflowDefinition`、`parseWorkflow`
- `next/test/helpers/cli.mjs` — `project(t)`

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-15T15:02:40.859Z
- 方式: self → independent；理由: 状态推进、改动对比、受保护的路径属于正确性没法自证的改动

### 交付记录

<!-- knit:delivery:op-77c9a25ab806 -->
- 操作: op-77c9a25ab806
- 时间: 2026-11-15T23:03:31.749Z
- 分支: refs/heads/main
- 授权来源: user:1d2d626e
- 调用: bridge
- 工作提交: f27c77a64fc0b83924978630b7329cf3097d7406
- 结果: 正常交付；检查 run-ad9b8765a65d 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-15-e6-workspace-changes

### 任务资料提交记录

<!-- knit:metadata-commit:op-77c9a25ab806 -->
- 任务资料提交: bf6d634f131f6af0862778507a2a49069faee158
- 归档目标: .knit/tasks/archive/2026-11/11-15-e6-workspace-changes

<!-- knit:progress:end -->
