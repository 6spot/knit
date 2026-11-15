---
id: k-3672a86b11b9
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-57d543a6c0f6
order: null
createdAt: 2026-11-15T10:00:37.256Z
title: D6 交接内容超出字节上限时只给路径
---

# D6 交接内容超出字节上限时只给路径

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。D5 的 `assembleHandoff` 把点名的资料、计划和上一个环节的报告全文拼进第一条消息。资料很大时会把执行者的上下文占满，所以要有上限：单个文件 16 KB，一次交接合计 64 KB；超出的只给路径和一句说明，由执行者自己读（`.knit/tasks/11-14-slim-refactor/design.md` 第 5.1 节）。

做完之后的不同：`assembleHandoff` 拼出的内容不超过上限，超出的部分换成路径和一句说明。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/handoff.ts`（修改） | 加上字节上限 |
| `next/test/handoff-limits.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`assembleHandoff` 的参数多一项 `limits`，可以不给：`{ fileBytes, totalBytes }`。不给时用新导出的常量 `DEFAULT_HANDOFF_LIMITS`：`fileBytes` 是 16384，`totalBytes` 是 65536。

规则：

- 字节数按内容的 UTF-8 字节数算，只算内容，不算外面的 `<material …>` 这类标记行。
- 受上限约束的是第一条消息里的三类块：点名的资料（文件和章节）、计划、上一个环节的报告。目录块本来就没有内容，不受影响。
- 角色文件、规范和任务块（需求部分）任何时候都全文给，不受上限约束，但计入合计。
- 按第一条消息里的先后逐块判断：
  1. 这一块的内容超过 `fileBytes`：块里的内容换成一句 `这份资料有 <字节数> 字节，超过单个文件的上限 <fileBytes> 字节，没有附上；需要时按路径自己读。`
  2. 否则，已经放进去的内容（系统提示、任务块和前面全文给出的块）加上这一块会超过 `totalBytes`：块里的内容换成一句 `加上这份资料会超过一次交接的上限 <totalBytes> 字节，没有附上；需要时按路径自己读。`
  3. 否则全文给，计入合计。
- 一块被换成说明之后，后面的块继续按同样的规则判断：后面较小的块仍然可能放得下。说明文字不计入合计。
- 块的标记行和 `path` 不变，执行者靠它知道去读哪里。
- 被换成说明不算问题，不进 `problems`。
- 没有任何一块超出时，输出和加上限之前逐字相同：`next/test/handoff.test.mjs` 不改、继续通过。

上限以后从 `.knit/config.json` 读；读配置不在本任务里，由做执行的任务加，到时候把读到的值传给 `limits`。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里其它已有的文件和测试。发现问题写进报告，不在本任务里改。
- 不加依赖，不提交、不推送。

前置条件：D5 已完成。运行 `npm run test:next` 能通过，并且 `grep -n "export function assembleHandoff" next/src/application/handoff.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `application/handoff.ts`。
4. 写测试：建临时项目和任务的写法照 `next/test/handoff.test.mjs`；测试里给很小的 `limits`（例如 `fileBytes` 200、`totalBytes` 1000），不用真的写几十 KB 的文件。至少有一份资料的内容是汉字，核对算的是字节数而不是字符数。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件和 `next/src/application/handoff.ts` 的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): cap the size of a handoff`。

## 完成条件

### Requirement: 交接内容的字节上限

#### Scenario: 单个文件超过上限时只给路径

- GIVEN 任务点名了两个文件，一个超过 `fileBytes`，一个没有超过
- WHEN 拼交接内容
- THEN 超过的那一块保留 `path`，内容是一句带着它的字节数和上限的说明；另一块是全文
- AND 一份 100 个汉字的资料按 300 字节算

#### Scenario: 合计超过上限时后面的只给路径

- GIVEN 任务点名了三个文件，每个都不超过 `fileBytes`，前两个加起来放得下，加上第三个会超过 `totalBytes`；任务目录里有一份很小的 `plan.md`
- WHEN 拼交接内容
- THEN 前两块是全文，第三块的内容是一句带着合计上限的说明
- AND 计划块放得下，是全文；系统提示和任务块是全文

#### Scenario: 没有超出时和原来相同

- GIVEN 所有资料都在上限以内
- WHEN 分别不给 `limits` 和给一组很大的 `limits` 拼交接内容
- THEN 两次的结果逐字相同，里面没有“没有附上”
- AND `DEFAULT_HANDOFF_LIMITS` 是 `{ fileBytes: 16384, totalBytes: 65536 }`

## 待澄清


## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#5-交接` — 字节上限的初始值和超出时的做法
- `.knit/standards/development.md` — 开发规范
- `next/src/application/handoff.ts` — 要改的文件
- `next/test/handoff.test.mjs` — 修改后要继续通过的测试；建临时项目和任务的写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-453ef649cd3f -->
- 操作: op-453ef649cd3f
- 时间: 2026-11-15T11:01:59.061Z
- 分支: refs/heads/main
- 授权来源: user:5c30905e
- 调用: bridge
- 工作提交: d32b8da7fd869713da2fd627e86f5e075108f72d
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-d6-handoff-limits

### 任务资料提交记录

<!-- knit:metadata-commit:op-453ef649cd3f -->
- 任务资料提交: 2f4e6c7bac46d1c8e8e6a7dfc1137d7d682cb0c1
- 归档目标: .knit/tasks/archive/2026-11/11-15-d6-handoff-limits

<!-- knit:progress:end -->
