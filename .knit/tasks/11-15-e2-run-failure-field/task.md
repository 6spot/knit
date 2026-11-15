---
id: k-e75083172b7d
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-85f30b86c459
order: null
createdAt: 2026-11-15T15:02:34.977Z
title: E2 执行记录里记下失败原因
---

# E2 执行记录里记下失败原因

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。`record.json` 的 `runs` 里每次执行有一项记录（`.knit/tasks/11-14-slim-refactor/design.md` 第 3.3 节）。现在的记录分不出“正常结束、这个环节没有结论”和“失败了”：两种都是有结束时间、`verdict` 是 `null`。后面推下一步做哪个环节时，失败的执行不能算数，所以要有一个字段写明失败原因。

做完之后的不同：`record.json` 里每次执行多一个 `failure` 字段，失败时写原因，其余时候是 `null`。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/contracts/task.ts`（修改） | `TaskRunSchema` 加 `failure` |
| `next/src/domain/task-record.ts`（修改） | 写出时带上 `failure` |
| `next/test/task-record.test.mjs`（新增） | 见「完成条件」的两个场景，各一个测试 |
| `next/test/task-document.test.mjs`、`next/test/task-close.test.mjs`、`next/test/task-view.test.mjs`（修改） | 只给测试里手写的执行记录补上 `failure: null`，并在核对字段先后的地方加上 `failure`；别的不改 |

规则：

- `failure` 是非空字符串或 `null`，必须写；位置在 `verdict` 之后。一次执行的字段先后是 `id`、`stage`、`startedAt`、`endedAt`、`verdict`、`failure`、`requirementDigest`、`changedPaths`、`sessionFile`。
- 三种情况这样区分，本任务只定含义，不在读入时互相核对：

  | `endedAt` | `failure` | 含义 |
  | --- | --- | --- |
  | `null` | `null` | 正在跑 |
  | 有 | `null` | 正常结束；`verdict` 是它的结论，环节没有声明结论时是 `null` |
  | 有 | 有 | 失败；`verdict` 是 `null` |

- `task close` 对独立审查任务的判断（最后一次有结论的执行是不是 `pass`）不变。
- 本仓库 `.knit/tasks/` 下的任务还是旧格式，没有新格式的 `record.json`，不受影响。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export const TaskRunSchema" next/src/contracts/task.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `contracts/task.ts` 和 `domain/task-record.ts`。
4. 运行 `npm run test:next`，按失败的测试给三个已有测试文件里的执行记录补上 `failure: null`。
5. 写 `task-record.test.mjs`。
6. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件和「产出」里列的 5 个文件的修改。
- `git diff -- next/test/task-document.test.mjs next/test/task-close.test.mjs next/test/task-view.test.mjs`：改动的行都和 `failure` 有关。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): record why a run failed`。

## 完成条件

### Requirement: 执行记录的失败原因

#### Scenario: 带失败原因的记录写出再读回不变

- GIVEN 一份记录有两次执行，一次 `failure` 是 `执行者启动失败：模型不存在`，一次是 `null`
- WHEN 用 `renderTaskRecord` 写出，再用 `parseTaskRecord` 读回
- THEN 读回的记录和原来相同，没有问题
- AND 写出的每次执行的字段先后是 `id`、`stage`、`startedAt`、`endedAt`、`verdict`、`failure`、`requirementDigest`、`changedPaths`、`sessionFile`

#### Scenario: 缺少失败原因字段的记录读不进来

- GIVEN 一份 `record.json` 的某次执行没有 `failure` 字段
- WHEN 用 `parseTaskRecord` 读
- THEN `record` 是 `null`，`problems` 里有一句提到 `failure`

## 待澄清


## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#33-recordjson` — `record.json` 的字段
- `.knit/standards/development.md` — 开发规范
- `next/src/contracts/task.ts` — 要改的 `TaskRunSchema`
- `next/src/domain/task-record.ts` — 要改的 `renderTaskRecord`
- `next/test/task-document.test.mjs` — 已有的记录读写测试，照它的写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-8d29b2170b8a -->
- 操作: op-8d29b2170b8a
- 时间: 2026-11-15T23:03:09.511Z
- 分支: refs/heads/main
- 授权来源: user:1d2d626e
- 调用: bridge
- 工作提交: 3170a50839f00a063addf58fdf62c3176fc977d7
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-e2-run-failure-field

<!-- knit:progress:end -->
