---
id: k-85f30b86c459
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-3c11f4dd9757
order: null
createdAt: 2026-11-15T15:00:54.780Z
title: E1 读取项目配置 config.json
---

# E1 读取项目配置 config.json

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。小核心的项目配置 `.knit/config.json` 里只有一样：交接的字节上限（`.knit/tasks/11-14-slim-refactor/design.md` 第 2 节）。执行者的模型和返工上限写在流程文件里，不在这里。现在 `next/` 里还没有读配置的代码，字节上限固定用 `DEFAULT_HANDOFF_LIMITS`。

做完之后的不同：`next/` 里有了 `loadConfig`，能读出项目配置的字节上限；配置写错时说明哪里错了。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/config.ts`（新增） | `CONFIG_PATH`、`ProjectConfig`、`loadConfig(root)` |
| `next/test/config.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

配置文件 `.knit/config.json`（`CONFIG_PATH`），字段都可以不写：

```json
{
  "handoff": { "fileBytes": 16384, "totalBytes": 65536 }
}
```

| 字段 | 要求 | 没写时 |
| --- | --- | --- |
| `handoff.fileBytes`、`handoff.totalBytes` | 不小于 1 的整数，可以只写其中一个 | `DEFAULT_HANDOFF_LIMITS` 里对应的值（`next/src/application/handoff.ts`） |

`loadConfig(root)` 返回 `{ config, problems }`：

- 文件不存在：`config` 是全部缺省值，`problems` 是空的。
- 读得出：`config` 是 `{ handoff: { fileBytes, totalBytes } }`，没写的字段已经补上缺省值。`ProjectConfig` 就是这个形状。
- 有问题：`config` 是 `null`，`problems` 一处一句，每句以 `.knit/config.json：` 开头。不是合法的 JSON 时说明不是合法的 JSON；多了不认识的字段、字段的值不对时点出字段名（可以用 `next/src/contracts/task.ts` 的 `schemaProblems`）。
- 不认识的字段算问题，不忽略：写错字段名时能马上发现。`model`、`maxRepairRounds` 不属于这个文件，写了也按不认识的字段报。

本任务只把配置读出来，由后面做执行的任务使用；没有命令用到它，所以只用测试验证。

本仓库自己的 `.knit/config.json` 还是旧格式，按新规则读会报不认识的字段；它在切换时改写，本任务不动它，测试也不读它。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export const DEFAULT_HANDOFF_LIMITS" next/src/application/handoff.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `application/config.ts`。
4. 写测试：用 `next/test/helpers/cli.mjs` 的 `project(t)` 建临时项目，直接调用 `next/dist/application/config.js` 的 `loadConfig`。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 2 个新文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): read the project config`。

## 完成条件

### Requirement: 读取项目配置

#### Scenario: 没有配置文件时用缺省值

- GIVEN 项目里没有 `.knit/config.json`
- WHEN 读配置
- THEN 得到 `handoff` 是 `{ fileBytes: 16384, totalBytes: 65536 }`，没有问题
- AND 文件内容是 `{}` 时结果相同

#### Scenario: 写了的值生效

- GIVEN 配置是 `{ "handoff": { "fileBytes": 100 } }`
- WHEN 读配置
- THEN 得到 `handoff` 是 `{ fileBytes: 100, totalBytes: 65536 }`，没有问题
- AND 两个值都写了时，得到的就是写的两个值

#### Scenario: 配置写错时指出问题

- GIVEN 配置分别是：不是合法的 JSON；多了字段 `handof`；`handoff.fileBytes` 是 0；写了 `"model": "p/m"`
- WHEN 读配置
- THEN 每一种的 `config` 都是 `null`，`problems` 里的句子都以 `.knit/config.json：` 开头
- AND 后三种的句子里有出问题的字段名：`handof`、`fileBytes`、`model`

## 待澄清


## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#2-目录布局` — 配置文件的位置和字段
- `.knit/standards/development.md` — 开发规范
- `next/src/contracts/task.ts` — `schemaProblems` 和用 `obj`、`str` 写结构的例子
- `next/src/contracts/workflow.ts` — 用 `opt`、`int` 写可省字段和整数的例子
- `next/src/application/handoff.ts` — `HandoffLimits`、`DEFAULT_HANDOFF_LIMITS`
- `next/test/helpers/cli.mjs` — `project(t)`

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
