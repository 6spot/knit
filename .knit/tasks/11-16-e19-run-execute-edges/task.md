---
id: k-a76d19ce3863
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-6f79d543a580
order: null
createdAt: 2026-11-16T00:03:55.422Z
title: E19 补上执行一个环节时没测到的几种情况
---

# E19 补上执行一个环节时没测到的几种情况

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。`executeRun`（`next/src/application/run-execute.ts`）启动 Pi 执行一个环节。它有几种情况写了实现、没有测试：

- 环节的 `tools` 除了 `[read, write, exec]` 之外的写法，各自给 Pi 什么工具。对错了，只该读文件和运行命令的环节会拿到写文件的工具。
- 执行者的最后一条消息是空的。
- 执行者被中止。

做完之后的不同：这几种情况各有测试。实现不改。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/test/helpers/fake-pi.mjs`（修改） | 脚本多一个字段 `aborted`：为真时它发出的 `agent_settled` 里 `aborted` 是 `true` |
| `next/test/run-execute-edges.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

要核对的行为，现在的实现应当已经是这样：

工具。流程文件里实现环节的 `tools` 写成左边的样子时，假 Pi 收到的启动参数是右边的样子：

| 环节的 `tools` | 启动参数 |
| --- | --- |
| 不写（全部放开） | 没有 `--tools`、`--no-tools`、`--exclude-tools`、`--no-extensions` |
| `[read, exec]` | `--tools` 的值是 `read,grep,find,ls,bash`；没有 `--exclude-tools`；有 `--no-extensions` |
| `[]` | 有 `--no-tools`；没有 `--tools` |
| `[read, external]` | `--tools` 的值是 `+read,+grep,+find,+ls`；`--exclude-tools` 的值是 `write,edit,bash`；没有 `--no-extensions` |

没有给出报告。执行者的最后一条消息是空的或只有空白时：这次执行记为失败，原因是 `执行者没有给出报告`，结论是 `null`；不要求补报，假 Pi 只收到一条消息。

被中止。`agent_settled` 里 `aborted` 是 `true` 时：这次执行记为失败，原因是 `执行者被中止`，结论是 `null`；不要求补报。

发现实现和上面写的不一致时停下，在报告里写出是哪一条、实际是什么。不改实现，也不把期望改成实际的样子。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "执行者被中止" next/src/application/run-execute.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 给假 Pi 加 `aborted`。
4. 写测试。临时项目用 `next/test/helpers/run.mjs` 的 `runProject`、`readyTask`；改 `tools` 的办法是改临时项目的 `.knit/workflow.yaml` 再提交（`next/test/helpers/git.mjs` 的 `commitAll`），然后用 `prepareRun`、`executeRun` 跑一次，从假 Pi 的记录里读启动参数。四种写法在同一个测试里依次做，每种用一个新任务。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件和 `next/test/helpers/fake-pi.mjs` 的修改。
- `git diff --stat -- src test assets scripts package.json next/src`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `test(next): cover the tool mapping and missing reports of a run`。

## 完成条件

### Requirement: 执行一个环节时的几种情况

#### Scenario: 工具按环节的 tools 给

- GIVEN 实现环节的 `tools` 依次是不写、`[read, exec]`、`[]`、`[read, external]`
- WHEN 各执行一次实现环节
- THEN 假 Pi 收到的启动参数依次符合上面表里的四行
- AND 四次执行都正常结束

#### Scenario: 没有给出报告

- GIVEN 假 Pi 的最后一条消息只有空白
- WHEN 执行一次审查环节
- THEN 记录里 `failure` 是 `执行者没有给出报告`，`verdict` 是 `null`
- AND 假 Pi 只收到一条消息

#### Scenario: 被中止

- GIVEN 假 Pi 的脚本带 `aborted`
- WHEN 执行一次审查环节
- THEN 记录里 `failure` 是 `执行者被中止`，`verdict` 是 `null`
- AND 假 Pi 只收到一条消息

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 执行者能用哪些工具、报告读不出来时怎么办
- `.knit/standards/development.md` — 开发规范
- `next/src/application/run-execute.ts` — 被测的实现：`runtimeTools`、`askForReport`
- `next/src/adapters/pi/runtime.ts` — `buildPiArgs`：工具参数怎么变成启动参数
- `next/test/helpers/fake-pi.mjs` — 假 Pi
- `next/test/run-execute.test.mjs` — 执行一个环节的测试写法
- `next/test/run-limit.test.mjs` — 改临时项目的流程文件再提交的写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-6567385e0476 -->
- 操作: op-6567385e0476
- 时间: 2026-11-16T06:49:11.255Z
- 分支: refs/heads/main
- 授权来源: user:28d14c89
- 调用: bridge
- 工作提交: 261a47726fcf0598a2d42c192fa783c15f6be038
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-16-e19-run-execute-edges

<!-- knit:progress:end -->
