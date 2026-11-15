---
id: k-3c11f4dd9757
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-15T15:56:10.797Z
title: E0 流程文件里配执行者的模型和返工上限
---

# E0 流程文件里配执行者的模型和返工上限

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。一个环节用什么角色文件、什么工具、报告带哪些字段，都写在 `.knit/workflow.yaml` 里；执行者用哪个模型、返工最多几轮也是流程的设置，和它们写在一起（`.knit/tasks/11-14-slim-refactor/design.md` 第 6.1 节）。现在 `next/` 里流程文件不认这两项：模型没有地方写，返工上限要由调用方当参数传给 `parseWorkflow`，实际上没有人传，固定是 5。

做完之后的不同：`workflow.yaml` 顶层可以写 `model` 和 `maxRepairRounds`，环节可以写自己的 `model`；解析出来的每个环节带着它生效的模型，写错时 `knit workflow validate` 指出行号。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/contracts/workflow.ts`（修改） | 文件的结构多出顶层的 `model`、`maxRepairRounds` 和环节的 `model`；多两个问题码 |
| `next/src/domain/workflow.ts`（修改） | 环节带上生效的模型；缺省的进入次数上限来自文件；`parseWorkflow` 去掉第二个参数 |
| `next/src/cli/workflow.ts`（修改） | `workflow show` 每个环节多一行模型 |
| `next/test/workflow-model.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |
| `next/test/workflow.test.mjs`、`next/test/workflow-cli.test.mjs`（修改） | 只改因为下面的变化而不再成立的地方 |

写法：

```yaml
version: 1
model: provider/模型        # 可以不写：所有环节的执行者缺省用的模型
maxRepairRounds: 5          # 可以不写：返工上限，缺省 5
stages:
  - id: implement
  - id: review
    model: provider/另一个   # 可以不写：只管这个环节
```

| 字段 | 要求 | 没写时 |
| --- | --- | --- |
| 顶层 `model`、环节的 `model` | 字符串，写成 `provider/模型`：第一个 `/` 的前后都不为空（`a/b/c` 合法，provider 是 `a`） | 环节的没写用顶层的；顶层也没写是 `null` |
| 顶层 `maxRepairRounds` | 不小于 0 的整数 | `DEFAULT_MAX_REPAIR_ROUNDS`（值是 5） |

解析的结果：

- `WorkflowStage` 多一个 `model`（字符串或 `null`），是这个环节生效的模型：环节自己写了就用自己的，否则用顶层的，都没写是 `null`。顶层的值不在 `WorkflowDefinition` 里另存一份。
- 没写模型不算问题：流程照样有效，派发时可以临时指定。
- `WorkflowDefinition.defaultMaxVisits` 来自文件里的 `maxRepairRounds`，没写时是 5；它不再可能是 `null`，类型改成 `number`。没写 `maxVisits` 的环节用它，这一点不变。
- `parseWorkflow(source)` 只收一个参数：去掉 `ParseWorkflowOptions` 和 `resolveDefaultMaxVisits`。

写错时（都使整份流程无效，和别的问题一样带行号）：

| 情况 | 问题码 | 说明（前面照旧有“第 N 行：”） |
| --- | --- | --- |
| `model` 不是字符串，或不是 `provider/模型` 的写法 | `invalid_model` | `<位置> 要写成 provider/模型`，位置是 `model` 或 `stages[1].model` 这样的写法 |
| `maxRepairRounds` 不是不小于 0 的整数 | `invalid_max_repair_rounds` | `maxRepairRounds 必须是非负整数` |

- 回退环上每个环节都写了 `maxVisits: null` 时仍然报 `unbounded_repair_cycle`，说明改成 `阶段 "<id>" 所在回退环上每个环节的 maxVisits 都是 null，返工停不下来`（原来的说明里提到的 `workflow.maxRepairRounds 均为 null` 已经不会发生）。
- 代码注释里说“缺省用 config.workflow.maxRepairRounds”的地方改成现在的说法。

`knit workflow show`：每个环节在“角色文件”一行之后多一行，`     模型: <provider/模型>`；没有时是 `     模型: （没有指定，派发时加 --model）`。

已有测试要跟着改的地方，只有这三类，别的不改：

- 按整个对象比较环节的地方，补上 `model: null`。
- 给 `parseWorkflow` 传第二个参数 `{ maxRepairRounds: … }` 的三个测试：前两个改成把值写进 YAML 的顶层；第三个（传 -1）改成核对文件里写 `maxRepairRounds: -1` 时报 `invalid_max_repair_rounds`。测试里 `assertValid`、`assertInvalid` 的 `options` 参数一起去掉。
- 按整段输出比较 `workflow show` 的地方（有的话），补上模型那一行。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库自己的 `.knit/workflow.yaml` 在切换时再改，本任务不动它。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "maxRepairRounds" next/src/domain/workflow.ts` 有输出、`grep -rn "model" next/src/contracts/workflow.ts` 没有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `contracts/workflow.ts`、`domain/workflow.ts`、`cli/workflow.ts`。
4. 运行 `npm run test:next`，按失败的测试改上面说的三类地方。
5. 写 `workflow-model.test.mjs`：解析用 `next/dist/domain/workflow.js` 的 `parseWorkflow`；运行命令的写法照 `next/test/workflow-cli.test.mjs`。
6. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `grep -rn "ParseWorkflowOptions\|resolveDefaultMaxVisits" next/src`：没有输出。
- `git status --short`：和开始前相比，只多出 1 个新文件和「产出」里五个文件的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): set the model and rework limit in the workflow file`。

## 完成条件

### Requirement: 流程文件里的模型和返工上限

#### Scenario: 顶层的模型是缺省，环节可以写自己的

- GIVEN 流程顶层写了 `model: p/a`，有实现、审查两个环节，审查环节写了 `model: p/b`
- WHEN 解析这份流程
- THEN 实现环节的 `model` 是 `p/a`，审查环节的是 `p/b`
- AND 顶层和环节都没写时，流程照样有效，两个环节的 `model` 都是 `null`；`knit workflow show` 里对应显示 `模型: p/a`、`模型: p/b` 和 `模型: （没有指定，派发时加 --model）`

#### Scenario: 返工上限写在流程文件里

- GIVEN 流程顶层写了 `maxRepairRounds: 2`，实现环节没写 `maxVisits`，审查环节写了 `maxVisits: 7`
- WHEN 解析这份流程
- THEN 实现环节的 `maxVisits` 是 2，审查环节的是 7，`defaultMaxVisits` 是 2
- AND 顶层没写 `maxRepairRounds` 时，没写 `maxVisits` 的环节是 5；`knit workflow show` 里实现环节显示 `进入次数上限: 2`

#### Scenario: 写错时指出行号

- GIVEN 流程分别是：顶层 `model: nomodel`；审查环节 `model: /m`；顶层 `maxRepairRounds: -1`；顶层 `maxRepairRounds: 1.5`
- WHEN 解析
- THEN 四种都得不到流程；问题码依次是 `invalid_model`、`invalid_model`、`invalid_max_repair_rounds`、`invalid_max_repair_rounds`，行号是写错的那一行
- AND 这时 `knit workflow validate` 以退出码 1 结束，标准错误里有带行号的同一句说明

## 待澄清


## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#61-流程` — 流程文件的写法，模型和返工上限怎么取
- `.knit/standards/development.md` — 开发规范
- `next/src/contracts/workflow.ts` — 要改的文件：文件的结构和问题码
- `next/src/domain/workflow.ts` — 要改的文件：`parseWorkflow`、`WorkflowStage`、`WorkflowDefinition`
- `next/src/cli/workflow.ts` — 要改的文件：`workflow show`
- `next/test/workflow.test.mjs` — 解析的测试写法；有几处要跟着改
- `next/test/workflow-cli.test.mjs` — 建临时项目、运行命令的写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-1416f59f6c3c -->
- 操作: op-1416f59f6c3c
- 时间: 2026-11-15T16:14:17.666Z
- 分支: refs/heads/main
- 授权来源: user:b81fb9d9
- 调用: bridge
- 工作提交: a2553384b7939b6a0291e4f48aa0767cbc4ea4c2
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-e0-workflow-model

### 任务资料提交记录

<!-- knit:metadata-commit:op-1416f59f6c3c -->
- 任务资料提交: 1587d467d8fd2aad04556d59d18d34b19c0ce6a8
- 归档目标: .knit/tasks/archive/2026-11/11-15-e0-workflow-model

<!-- knit:progress:end -->
