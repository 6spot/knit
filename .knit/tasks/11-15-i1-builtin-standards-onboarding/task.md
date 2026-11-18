---
id: k-966b2bf6ef60
title: I1a 通用规范进模板
status: draft
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn:
  - k-c0000beef2eb
priority: P3
createdAt: 2026-11-15T03:05:44.637Z
---

## 目标与范围

`knit init` 现在只生成一个空的规范目录，新项目要自己从头写怎么用 Knit 管任务的规范。用户 2026-11-15 决定：通用的规范由 Knit 自带，初始化时生成。本任务把通用规范放进模板。

本仓库 `.knit/standards/` 里有四份写的是“怎么用 Knit 管任务”，不只对本仓库成立：`discussion.md`（讨论）、`task-writing.md`（任务编写）、`task-splitting.md`（任务拆分）、`delivery.md`（交付）。

要做的：

1. 新增模板 `assets/templates/standards/` 下四个文件，文件名同上，开头的 `title` 和 `stages` 照本仓库的写。内容从本仓库的四份里取通用的部分：
   - `discussion.md`、`task-writing.md`、`task-splitting.md`：全文照搬。
   - `delivery.md`：「完成与汇报」「授权」「提交范围」「失败」四节照搬；「提交文案」一节只留三条：首行写这次改动的结果，不能只有任务编号；`Task: <任务 ID>` 一行必须有；不写以 `Knit-` 开头的行。语言、`type:` 列表、72 个字符的上限是本仓库自己的选择，不进模板。
2. `src/application/init.ts` 的 `TEMPLATES` 加四项，目标是 `.knit/standards/<文件名>`，`restore: false`：项目里没有同名文件时生成，已有的不动，`--force` 也不覆盖。
3. `knit init` 的输出照现在的格式自然多出四行（「已生成」或「已有，没有动」），不另加文字。
4. 设计跟着改：`docs/design/DESIGN.md` 第 4 节「`knit init` 不预置规范内容…」那一条改成现在的行为；第 11 节「延后」表里「自带通用规范与引导任务」一行只留引导任务。

不在范围内：

- 引导任务（I1b）。
- 本仓库的 `.knit/standards/`：不改。它们是按本仓库情况改过的，和模板不要求一致，不加逐字比对的测试。
- `development.md` 和两份 `pitfalls-*.md`：写的是具体项目的情况，不进模板。
- 规范的注入方式和文件格式（`docs/design/DESIGN.md` 第 4、5 节）。
- 不加依赖，不提交、不推送。

先改测试再改代码。会受影响的现有测试：`test/init.test.mjs`「在空目录里初始化」断言规范目录是空的；`test/init-force.test.mjs`「配置、规范和任务不动」。运行 `knit init` 之后看规范或 `knit context` 输出的别的测试，跑一遍 `npm test` 找出来，按新行为改断言，不删测试。

## 完成条件

- 在空目录里运行 `knit init`：`.knit/standards/` 下正好有这四个文件，内容和模板逐字相同；`knit standards list` 列出四份，各有环节，没有告警。
- 项目里已有同名规范（内容不同）时运行 `knit init` 和 `knit init --force`：这个文件的内容都不变，输出把它列在「已有，没有动」下面。
- 一个 `draft` 任务的 `knit context` 输出里有 `discussion.md`、`task-writing.md`、`task-splitting.md` 三份，没有 `delivery.md`。
- 上面三条各有测试。`npm test` 全部通过，测试个数不比改之前少（改之前先运行一次记下个数；改之前就有失败时停下来报告）；`npm run typecheck` 退出码 0；`npm run pack:check` 通过，并且包里有这四个模板（`npm pack --dry-run --json` 的文件列表里能看到）。

## 待澄清

- [assumed] 模板里放四份，比原来说的三份多一份 `discussion.md`（2026-11-18 才写出来，内容也是通用的）（Agent 建议，待确认）。
- [assumed] 交付规范只把上面说的通用部分放进模板，文案的语言和类型列表留给项目自己定（Agent 建议，待确认）。
- [assumed] 模板和本仓库的规范不要求一致，不加逐字比对的测试（Agent 建议，待确认）。
- [assumed] 模板里的规范以后更新时，已经初始化的项目不跟进、也不提示；`knit init --check` 已经没有了（Agent 建议，待确认）。

## 相关资料

- `.knit/standards/discussion.md`、`.knit/standards/task-writing.md`、`.knit/standards/task-splitting.md`、`.knit/standards/delivery.md` — 通用内容的来源
- `src/application/init.ts` — 模板清单 `TEMPLATES` 和生成的逻辑
- `docs/design/DESIGN.md#4. 规范` — 规范的格式
- `docs/design/DESIGN.md#10. 用 Knit 开发 Knit` — `knit init` 不覆盖哪些内容

交付：提交文案首行建议 `feat: ship the general standards with knit init`。交付之后，本仓库要不要重新安装并运行 `knit init`（会在本仓库生成它没有的模板文件；四份都已经有，不会被覆盖）由主会话另问用户。
