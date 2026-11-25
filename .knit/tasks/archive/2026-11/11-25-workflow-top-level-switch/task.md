---
id: k-c0aaabac429a
title: 流程文件顶层加开关，关闭后任务都由主会话直接做
status: cancelled
stage: null
verification: self
parent: null
dependsOn:
  - k-02534d8ecf04
priority: P1
createdAt: 2026-11-24T16:06:18.110Z
---

## 目标与范围

用户有时希望任务全部由主会话自己做，不派发执行者。现在只能每次在对话里说一遍，而 Knit 同时还在往相反的方向提示：选中一个已确认的任务时，每轮注入里写着「下一步: 派发实现环节（knit run start <id>）」，讨论规范的「谁来做」也按文件数和模块数要求派发。写一份项目规范说「不派发」解决不了这个冲突，`knit run start` 也照样能跑。

做完后，`.knit/workflow.yaml` 顶层有一个开关。关闭时不派发任何环节，任务走「讨论 → 主会话直接做 → 收尾」：`knit run start` 拒绝并说明原因，每轮注入写明流程已关闭、下一步是直接做完再 `knit task close`。开关不写或打开时，行为和现在完全一样。

已经定下的做法：

- 开关是 `.knit/workflow.yaml` 顶层的布尔字段 `enabled`，不写时是 `true`，和 `model`、`maxRepairRounds` 并列。字段名用户已确认。用单独的字段而不是把 `stages` 清空，是为了关闭时保留环节配置，再打开不用重写。
- 关闭只挡新的派发。已经在跑的执行照常结束，`knit run status`、`knit run wait`、`knit run cancel` 不受影响。
- 关闭时，主会话选中已确认的任务，仍然收到流程第一个环节声明的项目规范，因为这时是主会话在做这个环节的事。现在主会话直接做任务时就是这样给的，见设计 5.1 节。
- 不改 `nextStep` 的推导和 `record.json` 的结构。开关只影响能不能派发和给主会话的提示，这样任务状态怎么推进不受这次改动影响。
- 讨论规范「谁来做」一节补一句：流程关闭时不派发，本节的派发条件不适用。是否关闭由每轮注入的内容告诉主会话。

改动范围：

- 流程配置的定义、解析和校验：`src/contracts/workflow.ts`、`src/domain/workflow.ts`。
- 派发前的核对：`src/application/run-prepare.ts`。
- 给主会话的任务状态和下一步：`src/application/session-context.ts`，以及 `knit run status` 用到的同一段。
- `knit workflow show` 和 `knit workflow validate` 的输出写出流程是否关闭。
- 默认流程模板 `assets/templates/workflow.yaml` 的注释、`assets/standards/discussion.md`「谁来做」、`docs/design/DESIGN.md` 第 6.1 节和 `README.md`。
- 测试追加到 `test/workflow.test.mjs`、`test/run-prepare.test.mjs`、`test/context.test.mjs`，命令行只在 `test/workflow-cli.test.mjs` 做冒烟。

不包含与延后：

- 开关管的是 Knit 的环节派发。宿主自己的子智能体不归 Knit 管，本任务不处理。
- 不做按任务、按会话的单独开关。
- 本任务由主会话直接完成，不运行 `knit run start`，不用子智能体。
- `.knit/workflow.yaml`、`.pi/extensions/knit.ts` 等本仓库的生成副本不在本任务里改。交付后要运行 `npm run pack:install` 才会在本机生效，这一步由主会话在用户单独同意后做。本仓库要不要把开关关上，由用户到时候定。

## 完成条件

### Requirement: 流程关闭时不派发，任务由主会话直接做

#### Scenario: 关闭后拒绝新的派发，正在跑的执行不受影响

- GIVEN 一个流程开关写成关闭的项目，里面有一个已确认的任务
- WHEN 运行 `knit run start <id>`
- THEN 命令拒绝，输出说明流程已关闭、任务由主会话直接做、做完运行 `knit task close <id>`；`record.json` 里没有新增执行；任务有执行在跑时再关闭开关，`knit run status` 和 `knit run cancel` 照常工作

#### Scenario: 关闭后主会话收到的下一步是直接做，任务能走到交付

- GIVEN 同一个项目，主会话选中这个已确认的任务
- WHEN 读取 `knit context <id>`，然后依次运行 `knit task close <id> --result <结果>` 和 `knit deliver <id>`
- THEN 上下文写明流程已关闭，下一步不出现 `knit run start`，并带有流程第一个环节声明的项目规范；任务从 `ready` 到 `done` 再到 `delivered`

### Requirement: 开关缺省打开，写错能查出来

#### Scenario: 不写开关时行为不变，写成非布尔值时校验报错

- GIVEN 一份不含开关字段的流程文件，和一份把开关写成字符串的流程文件
- WHEN 分别运行 `knit workflow validate`，再运行 `npm run typecheck`、`npm test`、`npm run pack:check`
- THEN 前一份校验通过，`knit workflow show` 的输出和改动前一致；后一份校验失败并给出行号；三条命令都通过

## 待澄清

- [blocking] 流程关闭时，要求独立审查（`verification: independent`）的任务怎么处理。主会话建议在确认需求时就定：流程关闭期间 `knit task ready` 拒绝这类任务，提示改成 `self` 或打开流程；确认之后才关闭流程的任务，`knit task close` 沿用现有规则，要加 `--reason`。另一种做法是确认时不拦，只在 `knit task close` 时要 `--reason`。用户还没有选。

## 相关资料

- `docs/design/DESIGN.md` 第 3.2 节：主会话直接做的任务不经过 `active`，确认后直接 `task close`
- `docs/design/DESIGN.md` 第 5.1 节：主会话直接做某个环节时收到该环节的规范
- `docs/design/DESIGN.md` 第 6.1 节：流程文件的字段和校验
- `docs/design/DESIGN.md` 第 8.1 节：独立审查任务完成时的规则

## 结果

已取消：用户决定不加流程开关：需要主会话直接做时，在对话里说明即可，不值得为此加配置。
