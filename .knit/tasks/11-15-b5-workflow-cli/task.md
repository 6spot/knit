---
id: k-267e1cc4ffc1
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-97f21437a364
order: null
createdAt: 2026-11-15T04:47:51.163Z
title: B5 next 的 knit workflow show 和 validate 命令
---

# B5 next 的 knit workflow show 和 validate 命令

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动（见 `.knit/tasks/11-14-slim-refactor/design.md` 第 6.1 节、第 9 节）。流程文件 `.knit/workflow.yaml` 由人手工修改，小核心只提供两个只读命令：查看和校验。B4 已经把解析和校验搬到 `next/src/domain/workflow.ts`。

做完之后的不同：`node next/dist/cli/knit.js workflow show` 和 `workflow validate` 可以用。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/cli/root.ts`（新增） | 一个函数：给定目录，返回项目根。目录在 Git 仓库里时是仓库的顶层目录，否则是这个目录本身 |
| `next/src/cli/workflow.ts`（新增） | 注册 `workflow show` 和 `workflow validate` |
| `next/src/cli/knit.ts`（修改） | 注册上面的命令组 |
| `next/test/workflow-cli.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

命令的行为：

- 两个命令都接受 `--dir <目录>`，默认是当前目录；流程文件是项目根下的 `.knit/workflow.yaml`。
- `workflow show`：配置正确时，第一行打印流程，格式为 `流程: 讨论 → <各环节的显示名> → 收尾`；之后每个环节打印 id、显示名、说明、角色文件、工具、额外的报告字段、按结论的跳转和进入次数上限。退出码 0。
- `workflow validate`：配置正确时打印两行，第一行 `配置有效`，第二行与 `workflow show` 的第一行相同（`流程: …`）。退出码 0。
- 配置有问题时，两个命令都把每个问题打印到标准错误（一行一个，带“第 N 行”），退出码 1，不打印流程。
- 流程文件不存在时，两个命令都在标准错误里说明文件不存在，并提示运行 `knit init` 生成，退出码 1。不使用内置的默认流程：默认流程只在模板里有一份。
- 只做人读的输出，不做 `--json`。
- 不做 `workflow init`、`add`、`remove`、`move`、`set-*`：小核心不保留这些修改命令。

可以参考 `src/cli/workflow.ts` 里 `renderView` 的输出写法，但不要搬那个文件：它大部分是修改命令。新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/src/domain/workflow.ts`、`next/src/contracts/`：解析的行为由 B4 定，本任务只调用。发现它有问题时写进报告，不在本任务里改。
- 不加依赖，不提交、不推送。

前置条件：B4 已完成。运行 `npm run test:next` 能通过，并且 `ls next/src/domain/workflow.ts next/src/infrastructure/process.ts` 都存在（项目根用 `gitSync` 取 Git 的顶层目录）。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 新增 `root.ts` 和 `workflow.ts`，在 `knit.ts` 里注册。
4. 写测试：每个测试在临时目录里建项目，写入流程文件，运行 `node next/dist/cli/knit.js workflow … --dir <临时目录>`，结束时删除临时目录。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- 在仓库根目录运行 `node next/dist/cli/knit.js workflow validate`：本仓库现在的 `.knit/workflow.yaml` 是旧格式，环节叫 `implement`、`check`，应当校验通过并打印 `流程: 讨论 → 实现 → 检查 → 收尾`。
- `git status --short`：和开始前相比，只多出上表的 3 个新文件和 `next/src/cli/knit.ts` 的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件（照 `git status --short` 抄）、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add workflow show and validate`。

## 完成条件

### Requirement: 查看和校验流程文件

#### Scenario: 配置正确

- GIVEN 项目的 `.knit/workflow.yaml` 是 `design.md` 第 6.1 节的示例
- WHEN 运行 `workflow show`
- THEN 第一行是 `流程: 讨论 → 实现 → 审查 → 收尾`，并列出两个环节
- AND `workflow validate` 的退出码为 0

#### Scenario: 配置有问题

- GIVEN 流程文件里有一个环节的 id 是 `Bad`
- WHEN 运行 `workflow validate` 或 `workflow show`
- THEN 标准错误里有带“第 N 行”的问题说明，退出码为 1
- AND 标准输出里没有流程

#### Scenario: 流程文件不存在

- GIVEN 项目里没有 `.knit/workflow.yaml`
- WHEN 运行 `workflow validate` 或 `workflow show`
- THEN 标准错误里说明文件不存在并提示运行 `knit init`，退出码为 1

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md` 第 6.1 节、第 9 节、第 10 节 — 流程文件的格式与示例；命令清单；模板只有一份来源
- `.knit/standards/development.md` — 开发规范
- `next/src/domain/workflow.ts`、`next/src/contracts/workflow.ts` — 要调用的解析与校验
- `next/src/infrastructure/process.ts` — `gitSync`
- `src/cli/workflow.ts` 的 `renderView` — 旧的输出写法，供参考

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-96edf4dc08e7 -->
- 操作: op-96edf4dc08e7
- 时间: 2026-11-15T06:46:31.962Z
- 分支: refs/heads/main
- 授权来源: user:1f7f9eea
- 调用: bridge
- 工作提交: 6048d44d8719723c212d689e0507520b454fedc3
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-b5-workflow-cli

<!-- knit:progress:end -->
