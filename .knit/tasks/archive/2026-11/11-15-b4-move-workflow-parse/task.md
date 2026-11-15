---
id: k-97f21437a364
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-7c1fde35390f
order: null
createdAt: 2026-11-15T04:47:50.245Z
title: B4 搬流程文件解析到 next/，配置有错时不再降级
---

# B4 搬流程文件解析到 next/，配置有错时不再降级

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动（见 `.knit/tasks/11-14-slim-refactor/design.md` 第 6.1 节、第 12 节）。流程文件 `.knit/workflow.yaml` 的格式沿用现在的，解析和校验的代码直接搬。

现在的做法是：配置有任何问题，就“降级”成一个没有环节的流程继续运行。小核心改为：配置有问题就没有可用的流程，只给出问题清单，由调用方拒绝继续。

做完之后的不同：`next/` 里有流程文件的解析和校验；配置有问题时拿不到流程定义。

产出：

| 新文件 | 来源 |
| --- | --- |
| `next/src/contracts/schema.ts` | `src/contracts/schema.ts`，不改 |
| `next/src/contracts/workflow.ts` | `src/contracts/workflow.ts`，按下面修改 |
| `next/src/domain/workflow.ts` | `src/domain/workflow.ts`，按下面修改 |
| `next/test/workflow.test.mjs` | 见下面的测试清单 |

要改的行为：

1. 去掉降级。`parseWorkflow` 返回 `{ workflow, validation }`：配置正确时 `workflow` 是流程定义；有问题时 `workflow` 是 `null`，`validation.issues` 是问题清单（每个问题仍带错误码、行号、列号、位置和含“第 N 行”的说明）。删除 `fallbackWorkflowDefinition`、运行模式（`config`／`fallback`）和所有“降级”的说法。
2. 去掉内置的默认流程文本 `DEFAULT_WORKFLOW_YAML`。默认流程以后只在模板里有一份，源码里不再放副本。
3. 能力去掉 `task`，剩下 `read`、`write`、`exec`、`external`、`network` 五种。
4. 缺省的返工上限从 2 改为 5（`DEFAULT_MAX_REPAIR_ROUNDS`）。
5. 两个固定环节的名字从 `start`、`deliver` 改为 `discuss`（显示名“讨论”）、`deliver`（显示名“收尾”）。它们不能用作环节 id；`onVerdict` 的目标只能是已声明的环节 id 或 `deliver`。

其余规则不变：`version` 只支持 1；环节 id 的格式和唯一性；`tools` 不写或写 `all` 表示全部放开，`[]` 表示全部禁用；`report` 的字段类型；`onVerdict` 的键必须是 `report` 里声明过的枚举值；返工环上至少一个环节有有限的进入次数上限。

怎么搬：

- 旧文件保持原样。搬过来的代码除了上面五点不改写法。`.knit/standards/development.md` 的「写法」一节只约束新写的代码。
- 文件开头和函数上的注释里提到降级、默认模板的地方，按新行为改掉。

要搬的测试：

- `test/workflow.test.mjs` 的 38 个测试。其中：
  - 名字里带“降级”的测试：改为断言“没有流程定义、有问题清单、问题带行号”。
  - 「默认模板解析为 config 模式并保留全部语义字段」：改用下面这段流程文本（`design.md` 第 6.1 节的示例），断言两个环节的字段都解析出来。
  - 「六种能力全部可写，顺序保留」：改为五种，并补一条断言：写 `task` 报 `invalid_tools`。
  - 「按调用方的有效缺省解析回退定义」：测的是已删除的函数，不搬。
  - 涉及 `start` 的断言改为 `discuss`；涉及运行模式（`mode`）的断言删掉；缺省上限的断言随 `DEFAULT_MAX_REPAIR_ROUNDS` 走。
- `test/stage-contract.test.mjs`：
  - 「tools 解析：不写／all／ALL → 全部放开，[] → 全部禁用，非空列表 → 白名单」
  - 「tools 解析：列表混入 all、单元素 [all] 与非 all 标量都报 invalid_tools 并带行号」

  这两个测试用到的小工具 `stagesYaml` 一起搬。

```yaml
version: 1
stages:
  - id: implement
    name: 实现
    prompt: .knit/agents/implement.md
    tools: [read, write, exec]
  - id: review
    name: 审查
    prompt: .knit/agents/review.md
    tools: [read, write, exec]
    report:
      verdict: [pass, changes_requested, blocked]
    onVerdict:
      changes_requested: implement
      blocked: review
```

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里已有的文件。
- 不读文件、不加命令：`next/src/domain/workflow.ts` 仍然只接收文本。读文件和命令行由 B5 做。
- 不加依赖（`yaml` 和 `@earendil-works/pi-schema` 已在 `package.json` 里），不提交、不推送。

前置条件：B3 已完成。运行 `npm run test:next`，能通过就说明具备。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」和来源文件。
3. 复制三个源文件，按「要改的行为」修改。
4. 新建测试文件，搬入并修改测试。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `grep -n "fallback\|降级\|DEFAULT_WORKFLOW_YAML" next/src/contracts/workflow.ts next/src/domain/workflow.ts`：没有输出。
- `git status --short`：和开始前相比，只多出上表的 4 个文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件（照 `git status --short` 抄）、运行过的命令和最后一次完整运行的测试数、没有验证的内容、没搬的测试及原因。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): move workflow parsing and drop the fallback mode`。返工上限从 `.knit/config.json` 读取还没有接上，由以后的“环节推进”任务做。

## 完成条件

### Requirement: 流程文件的解析与校验

#### Scenario: 正确的配置

- WHEN 把上面那段流程文本交给 `parseWorkflow`
- THEN 得到两个环节 `implement`、`review`，字段与文本一致
- AND 没有声明进入次数上限的环节，上限为 5

#### Scenario: 有问题的配置

- WHEN 配置有语法错误、结构错误或语义错误
- THEN 得不到流程定义
- AND 每个问题带错误码和行号，说明以“第 N 行”开头

#### Scenario: 不再支持的写法

- WHEN `tools` 里写了 `task`，或环节 id 写成 `discuss`、`deliver`
- THEN 分别报 `invalid_tools`、`reserved_stage_id`

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md` 第 4 节、第 6.1 节、第 7.1 节 — 固定环节的名字；流程文件的格式；返工上限
- `.knit/standards/development.md` — 开发规范
- `src/contracts/schema.ts`、`src/contracts/workflow.ts`、`src/domain/workflow.ts` — 来源
- `test/workflow.test.mjs`、`test/stage-contract.test.mjs` — 来源测试

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-a8897dcb585b -->
- 操作: op-a8897dcb585b
- 时间: 2026-11-15T06:45:07.713Z
- 分支: refs/heads/main
- 授权来源: user:1f7f9eea
- 调用: bridge
- 工作提交: e64b0f5e0f44e7a92f62182fa2bfe4196e3d7271
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-b4-move-workflow-parse

### 任务资料提交记录

<!-- knit:metadata-commit:op-a8897dcb585b -->
- 任务资料提交: 240fe4a722fba271a04b7d1ce96c06e2300d311d
- 归档目标: .knit/tasks/archive/2026-11/11-15-b4-move-workflow-parse

<!-- knit:progress:end -->
