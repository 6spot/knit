---
id: k-e88d2172821f
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-17T06:37:36.753Z
title: G14 task.md 写坏时按 id 的命令说出哪里坏了
---

# G14 task.md 写坏时按 id 的命令说出哪里坏了

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。按 id 找任务的命令（`knit task show`、`knit context`、`knit run status`、`knit run start` 等）都是先把所有任务读一遍，再拿开头字段里解析出来的 `id` 去比。

`task.md` 的开头字段写坏时解析不出文档，也就没有 `id` 可比，这些命令都输出：

```
没有任务 <id>；用 knit task list 查看现有任务
```

照着提示运行 `knit task list`，最后一行才有原因（`<目录>：task.md：字段 priority 的值不对：…`）。H1 演练（`validation/slim-h1-2026-11/README.md`「发现的问题」第 1 条）里手工把 `priority` 改成不认识的值就是这样。`record.json` 写坏时没有这个问题：`id` 在 `task.md` 里，命令输出的是 `record.json：…`。

做完之后的不同：`task.md` 写坏了、但开头字段里还找得到 `id:` 那一行时，按 id 的命令输出文件哪里坏了（和 `record.json` 写坏时一样的写法），不再说“没有任务”。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/task-store.ts`（修改） | `StoredTask` 加字段 `id: string \| null`：文档解析得出来时是开头字段里的 `id`；解析不出来时在开头字段（文件开头的 `---` 和下一行 `---` 之间）里按行找 `id: <值>`，找不到是 `null`。`findTask` 按这个字段比 |
| `next/src/application/run-prepare.ts`（修改） | `prepareRun` 找要派发的任务时按 `StoredTask` 的 `id` 比；后面原有的“文档或记录是 null 就用 `problems` 拒绝”不改 |
| `next/test/task-view.test.mjs`（修改） | 加一个测试，见场景一 |
| `next/test/run-prepare.test.mjs`（修改） | 加一个测试，见场景二 |

不做的：

- 开头字段里连 `id:` 那一行都找不到的（比如整个文件没有开头字段），仍然输出“没有任务”，`knit task list` 里有原因。
- `prepareRun` 里查依赖的任务那一行不改：依赖的任务 `task.md` 写坏时仍然说“依赖的任务不存在”。
- 输出的写法不改：`task.md：<原因>`，前面不加目录。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：macOS 或 Linux；运行 `npm run test:next` 能通过（211 个）；`grep -n "export function findTask" next/src/application/task-store.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 先写两个测试，运行 `npm run test:next`：两个新测试应当失败，输出里是“没有任务”那一行。
4. 改 `task-store.ts` 和 `run-prepare.ts`。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`，测试数比开始前多 2。
- `npx tsc -p next/tsconfig.templates.json`：退出码 0。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `fix(next): say what is wrong with task.md instead of "no such task"`。

## 完成条件

### Requirement: 按 id 找得到写坏的任务

#### Scenario: 查看写坏的任务

- GIVEN 临时项目里一个任务，它的 `task.md` 开头字段里 `priority` 被改成 `PX`，`id` 那一行没有动
- WHEN 分别运行 `knit task show <id>`、`knit context <id>`、`knit run status <id>`
- THEN 三条命令都以退出码 1 结束，标准输出是空的，标准错误是 `task.md：` 开头、说 `priority` 的值不对的那一行，里面没有“没有任务”

#### Scenario: 派发写坏的任务

- GIVEN 临时仓库里一个已经确认的任务，之后它的 `task.md` 开头字段里 `priority` 被改成 `PX`
- WHEN 对它调用 `prepareRun`
- THEN 结果里没有执行，`problems` 是 `task.md：` 开头、说 `priority` 的值不对的那一条
- AND 没有建出执行目录

## 待澄清



## 相关资料

- `validation/slim-h1-2026-11/README.md#发现的问题` — 演练里看到的现象
- `next/src/application/task-store.ts` — 要改的文件：`StoredTask`、`scanTasks`、`findTask`
- `next/src/application/run-prepare.ts` — 要改的文件：`prepareRun`
- `next/src/domain/task-document.ts` — `parseTaskDocument`：开头字段怎么读、有哪些问题
- `next/src/cli/task.ts` — `loadTask`：找不到和读不出来时各输出什么
- `next/test/task-view.test.mjs` — 要改的测试文件：`create`、`rewrite` 和现有的写法
- `next/test/run-prepare.test.mjs` — 要改的测试文件：现有的拒绝测试
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-928978bcfff1 -->
- 操作: op-928978bcfff1
- 时间: 2026-11-17T07:33:46.717Z
- 分支: refs/heads/main
- 授权来源: user:sha256:274bf34bceb44252
- 调用: bridge
- 工作提交: 9aa887f2db845151b4ba00463c3d30e99fcd23bf
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-17-g14-broken-task-by-id

<!-- knit:progress:end -->
