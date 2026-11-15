---
id: k-54553f65659d
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-61fe4382151a
order: null
createdAt: 2026-11-15T15:02:47.312Z
title: E12 报告读不出来时要求执行者补报一次
---

# E12 报告读不出来时要求执行者补报一次

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。环节声明了报告字段、而执行者的报告里读不出这些字段时，现在直接记为失败。活已经干完了，只因为报告的格式不对就重做一遍不划算，所以先让执行者在同一个会话里补报一次；仍然读不出才记为失败，报告原文保留（`.knit/tasks/11-14-slim-refactor/design.md` 第 7 节）。

做完之后的不同：`executeRun` 在报告读不出来时多问一次，读得出就按正常结束处理。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/run-execute.ts`（修改） | 加上补报 |
| `next/test/run-report-retry.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`readReport` 给出问题时，不马上记为失败，而是在同一个 Pi 会话里再发一条消息（`prompt`）：

```
上一条消息里的报告读不出来：
- <问题一>
- <问题二>
请只重新输出完整的报告，结尾带上 json 代码块。不要修改文件，不要重新做一遍。
```

- 等它结束后再取最后一条消息，覆盖写进 `report.md`，再 `readReport` 一次。读得出：按正常结束处理，结论照记。仍有问题：失败原因是 `报告读不出来：<第二次的各个问题，用分号隔开>`，`report.md` 里是第二次的原文。
- 只补一次。
- 补报的那一轮没有等到稳定结束时，失败原因和第一轮一样：`执行者中途退出` 或 `执行者被中止`。
- 最后一条消息是空的（`执行者没有给出报告`）不补报。没有声明字段的环节 `readReport` 不会给出问题，也就不会补报。
- 改动文件在全部结束之后才对比，所以补报那一轮里改的文件也会记下来。

已有的 `next/test/run-execute.test.mjs` 里“报告读不出来时记为失败”的测试继续通过：假 Pi 两次给的是同一条消息。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "报告读不出来" next/src/application/run-execute.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `application/run-execute.ts`。
4. 写测试：假 Pi 的 `texts` 给两项，分别是第一次和补报时的最后一条消息；用 `KNIT_FAKE_PI_LOG` 核对执行者一共收到几条消息。同一时间只能有一次没结束的执行：要用到几次执行的测试，结束一次再准备下一次，或者各用一个临时项目。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件和 `next/src/application/run-execute.ts` 的修改。
- `git diff --stat -- src test assets scripts package.json next/test/run-execute.test.mjs`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): ask once more for an unreadable report`。

## 完成条件

### Requirement: 补报一次

#### Scenario: 补报之后读得出就按正常结束

- GIVEN 一次准备好的审查执行；假 Pi 第一次的消息没有 json 代码块，第二次的结尾带 `verdict: pass`
- WHEN 执行它
- THEN 记录里 `verdict` 是 `pass`，`failure` 是 `null`；`report.md` 是第二次的原文
- AND 执行者一共收到两条消息，第二条里有 `报告结尾没有能解析的 json 代码块`

#### Scenario: 补报之后仍读不出就记为失败

- GIVEN 假 Pi 两次的消息都没有 json 代码块，内容不同
- WHEN 执行它
- THEN `failure` 以 `报告读不出来：` 开头，`verdict` 是 `null`；`report.md` 是第二次的原文
- AND 执行者一共只收到两条消息

#### Scenario: 读得出时不补报

- GIVEN 两次准备好的执行：一次是审查，第一次的消息就带着 `verdict: pass`；一次是实现，环节没有声明报告字段，消息只有文字
- WHEN 执行它们
- THEN 两次都正常结束
- AND 执行者各只收到一条消息

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 报告读不出来时怎么办
- `.knit/standards/development.md` — 开发规范
- `next/src/application/run-execute.ts` — 要改的文件
- `next/src/adapters/pi/runtime.ts` — `prompt`、`getLastAssistantText`
- `next/src/domain/report.ts` — `readReport` 给出的问题
- `next/test/run-execute.test.mjs` — 测试的写法；修改后要继续通过
- `next/test/helpers/fake-pi.mjs` — `texts` 和记录文件

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-f0dd4feaecea -->
- 操作: op-f0dd4feaecea
- 时间: 2026-11-15T23:04:09.401Z
- 分支: refs/heads/main
- 授权来源: user:1d2d626e
- 调用: bridge
- 工作提交: 6f022e6f05dad366682d616110cc1970b6b83835
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-e12-report-retry

<!-- knit:progress:end -->
