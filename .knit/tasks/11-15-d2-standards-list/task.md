---
id: k-b288b073f0c0
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-adfe1afc79ec
order: null
createdAt: 2026-11-15T10:00:33.564Z
title: D2 next 的 knit standards list：列出规范
---

# D2 next 的 knit standards list：列出规范

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。D1 已经能读出项目的全部规范和它们声明的适用环节。规范文件由人直接写，写完要有一个地方能看到“哪份规范会交给哪个环节、哪份不会被交出去”（`.knit/tasks/11-14-slim-refactor/design.md` 第 4 节、第 9 节）。

做完之后的不同：`node next/dist/cli/knit.js standards list` 列出项目的规范，标出不会被交出去的和环节名写错的。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/cli/standards.ts`（新增） | 注册 `standards list` |
| `next/src/cli/knit.ts`（修改） | 注册上面的命令 |
| `next/src/cli/workflow.ts`（修改） | 只把已有的 `loadWorkflow` 改成导出，供本命令读流程 |
| `next/test/standards-cli.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`standards list` 接受 `--dir <目录>`（默认当前目录），只读、不改任何文件，只做人读的输出，不做 `--json`。

行为：

1. 用 `loadWorkflow` 读流程。流程文件不存在或有问题时，它已经把原因写到标准错误；本命令退出码 1，不列规范。
2. 用 D1 的 `loadStandards` 读出全部规范。一份都没有时打印 `没有规范`，退出码 0。
3. 一份规范一行，按路径排序，三项之间用两个空格隔开：路径、标题、适用环节（用 `, ` 连接）。例如：

   ```
   .knit/standards/delivery.md  交付规范  deliver
   .knit/standards/development.md  开发规范  implement, review
   ```

4. 第三项在下面三种情况下换一种写法：
   - 没有声明环节（`stages` 是空数组、`problems` 也是空的）：`没有声明适用的环节，不会注入`。
   - 声明写坏了（`problems` 不是空的）：`开头声明有问题，不会注入：<第一条问题>`。
   - 声明的环节里有流程里没有的：在环节后面加 `（流程里没有的环节：<环节名，用、连接>）`。流程里有的环节是 `workflow.yaml` 里各环节的 id，加上固定的 `discuss` 和 `deliver`。这份规范对它声明的其它环节仍然有效。
5. 有标注也是正常列出，退出码 0。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- D1 的文件：本任务只调用。`next/src/cli/workflow.ts` 只加 `export`，`workflow show`、`workflow validate` 的行为不变，它们的测试继续通过。
- 不加依赖，不提交、不推送。

前置条件：D1 已完成。运行 `npm run test:next` 能通过，并且 `grep -n "loadStandards" next/src/application/standards-store.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `cli/standards.ts`，在 `cli/knit.ts` 里注册。
4. 写测试：用 `next/test/helpers/cli.mjs` 的 `project` 建临时项目，往里写 `.knit/workflow.yaml`（内容照 `next/test/workflow-cli.test.mjs` 里的示例流程，环节是 `implement` 和 `review`）和 `.knit/standards/` 下的文件，用 `knit` 运行命令。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- 在本仓库运行 `node next/dist/cli/knit.js standards list`（只读）：打印 8 行，退出码 0。`development.md` 和 `pitfalls-worker.md` 两行带 `（流程里没有的环节：review）`，因为本仓库的流程里审查环节现在还叫 `check`；`candidates.md` 和 `index.md` 两行是 `没有声明适用的环节，不会注入`，它们是旧 Knit 的文件。
- `git status --short`：和开始前相比，只多出 2 个新文件和上表两个文件的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add standards list`。

## 完成条件

### Requirement: 列出规范

#### Scenario: 列出规范和各自适用的环节

- GIVEN 流程里有 `implement`、`review` 两个环节，`.knit/standards/` 下有 `development.md`（声明 `implement`、`review`）和 `delivery.md`（声明 `deliver`）
- WHEN 运行 `standards list`
- THEN 标准输出是两行，按路径排序，每行是路径、标题和适用环节，退出码为 0
- AND 一份规范都没有时打印 `没有规范`

#### Scenario: 标出不会注入的规范

- GIVEN 一份规范没有开头声明，一份的声明写着 `stages: implement`
- WHEN 运行 `standards list`
- THEN 前一份的那行写着 `没有声明适用的环节，不会注入`
- AND 后一份的那行写着 `开头声明有问题，不会注入`，后面跟着问题，退出码为 0

#### Scenario: 标出流程里没有的环节

- GIVEN 流程里有 `implement`、`review` 两个环节，一份规范声明 `implement`、`check`、`discuss`
- WHEN 运行 `standards list`
- THEN 那一行的环节后面带着 `（流程里没有的环节：check）`
- AND 流程文件不存在时不列规范，标准错误里提示运行 `knit init`，退出码为 1

## 待澄清

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#4-规范` — 规范的写法：没有声明环节的不注入，声明了流程里没有的环节要标出来
- `.knit/standards/development.md` — 开发规范
- `next/src/domain/standards.ts` — D1 的规范数据：`path`、`title`、`stages`、`problems`
- `next/src/application/standards-store.ts` — `loadStandards`
- `next/src/cli/workflow.ts` — `loadWorkflow` 和命令的现有写法
- `next/src/contracts/workflow.ts` — `WORKFLOW_ANCHORS`：固定的 `discuss`、`deliver`
- `next/test/workflow-cli.test.mjs` — 示例流程的内容
- `next/test/helpers/cli.mjs` — `project`、`knit`
- `next/test/task-view.test.mjs` — 命令测试的现有写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-e7050dabf05c -->
- 操作: op-e7050dabf05c
- 时间: 2026-11-15T11:01:39.870Z
- 分支: refs/heads/main
- 授权来源: user:5c30905e
- 调用: bridge
- 工作提交: a4d23638ce8028593effda6f25c39e3583071adc
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-d2-standards-list

<!-- knit:progress:end -->
