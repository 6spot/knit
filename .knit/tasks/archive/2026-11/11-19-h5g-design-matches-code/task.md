---
id: k-0ce8d7897b35
title: H5g 设计里四处和代码对不上的地方改对
status: delivered
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn:
  - k-c0000beef2eb
priority: P1
createdAt: 2026-11-19T06:59:41.592Z
---

## 目标与范围

H5b 把现行设计搬到 `docs/design/DESIGN.md` 之后通读了一遍，对照 `src/` 发现四处和代码对不上（记在 H5b 的「结果」里）。本任务把它们改对。前三处是设计写错或写漏，改成和代码一致；第四处是一条没有落地的要求，用户 2026-11-19 决定要这个行为（「需要这个行为，我们是需要沉淀规范的」），所以写进交付规范。

| 位置 | 现在写的 | 改成什么 |
| --- | --- | --- |
| 第 3.2 节，`active` 一行的「怎样进入」 | 「派发第一个环节，或主会话开始做」 | 只有派发会进入 `active`。主会话直接做的任务没有开始命令，从 `ready` 直接 `task close` 到 `done`（用户 2026-11-15 定的），这一点在表的下面写一句 |
| 第 3.3 节 | 一次执行结束后「`.runtime/runs/` 下只留日志和报告原文」 | 执行目录里留着的东西照实写：交接内容、日志、报告原文、派发前后的工作区记录和会话记录，和第 2 节的目录树、第 7.3 节一致 |
| 第 6.1 节，`maxVisits` | 只写了「最多进入几次」 | 补上可以写 `null`，表示不设上限；回退环上每个环节都是 `null` 时校验报错 |
| 第 7.1 节最后一句 | 「任务完成时如果返工过，主会话问用户要不要把原因记进避坑清单或规范」，但主会话收不到 | 这句话留着，写明它由交付规范给主会话、程序不检查；`.knit/standards/delivery.md` 的「完成与汇报」里加这一条 |

只改 `docs/design/DESIGN.md` 和 `.knit/standards/delivery.md` 两个文件。

不能动的：

- `src/`、`test/`：代码的行为是对的，不改。
- 设计里别的内容。
- `assets/templates/`：交付规范进模板是 I1a 的事，它照搬「完成与汇报」一节时会带上新加的这一条。

## 完成条件

- 上面四处在 `docs/design/DESIGN.md` 里都按表改了，改后的每句话和代码的行为一致：`grep -c '或主会话开始做' docs/design/DESIGN.md` 和 `grep -c '只留日志和报告原文' docs/design/DESIGN.md` 都输出 `0`；第 6.1 节讲 `maxVisits` 的地方提到了 `null`。
- 一个环节都做完、等主会话核对的任务，`knit context <任务>` 的输出里有返工过要问用户的那一条。
- `knit standards list` 没有警告；`node validation/slim-h5-2026-11/check-links.mjs docs README.md AGENTS.md` 没有输出，退出码 0。

## 待澄清

无。

## 相关资料

- `.knit/tasks/archive/2026-11/11-18-h5b-current-design/task.md#结果` — 四处不一致的原文和依据
- `.knit/standards/delivery.md` — 第四处要加一条的规范

交付：`--paths docs/design/DESIGN.md .knit/standards/delivery.md .knit/tasks/11-14-slim-refactor/plan.md`。之后是 H5c、H5d。

## 结果

`docs/design/DESIGN.md` 的四处按任务里的表改了：第 3.2 节 `active` 只由派发进入，表下面加一句说明主会话直接做的任务从 `ready` 直接到 `done`；第 3.3 节照实写执行目录里留着什么；第 6.1 节两处讲 `maxVisits` 的地方补上 `null`；第 7.1 节那句话注明由交付规范给主会话、程序不检查。`.knit/standards/delivery.md`「完成与汇报」加了一条：任务返工过时汇报里写出原因，问用户要不要记进避坑清单或规范。主任务的 `plan.md` 加了一行登记这个任务。

三条完成条件都满足：两个旧说法各搜到 0 处，`maxVisits` 和 `null` 同在一行的有 2 处；在临时仓库里用本仓库现在的交付规范试过，任务在实现环节做完、下一步是「核对之后运行 knit task close」时，`knit context` 的输出里有新加的那一条，刚确认、下一步是实现时没有；`knit standards list` 列出七份规范，没有警告；`check-links.mjs` 没有输出，退出码 0。

没有验证的：新加的规范还没有在一个真的返工过的任务上用过。主会话是否返工过，要它自己从执行记录里看，程序不提示。
