---
id: k-b907eafe1bf4
title: H5c 改写 README 和文档索引
status: delivered
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn:
  - k-c0000beef2eb
priority: P1
createdAt: 2026-11-18T16:55:55.669Z
---

## 目标与范围

`README.md` 和 `docs/README.md` 还在讲重构之前的旧 Knit：`knit start`、`--pi` 开关、`task rebind`、`execution.host`、`run schedule`、Worktree 已实现、默认流程「准备 → 实现 → 检查 → 收尾」。这些现在都没有了。本任务把这两个文件按现在的 Knit 重写。

前置条件：`docs/design/DESIGN.md` 是现行设计（H5b 已做完），`docs/research/REX-PANE.md` 存在（H5e 已做完）。

`README.md` 写成下面几段，按这个顺序。它会被打进安装包，所以指向仓库里文件的链接照旧写成 `https://github.com/6spot/knit/blob/main/<路径>`（目录用 `tree/main`），不用相对链接。

1. 标题和一段话：Knit 是什么。照 `docs/design/DESIGN.md` 第 1 节的五件事写，不超过五行。
2. 现在的情况：一句话说明 2026-11 重写成了小核心，旧实现的设计和记录在 `docs/history/`；只支持 Pi；没有发布到 NPM（`private: true`，没有 LICENSE）。平台的验证情况不在这里写，指向 `AGENTS.md`。
3. 安装：保留现在的三段（`npm run pack:install`、`--prefix`、`npm pack` 后在别的项目里局部安装），命令不变。说明文字里删掉 `--pi`、`knit start`、「受管入口」和 `init-backup` 这些说法；`knit init --force` 的说明照 `knit init --help` 和 `docs/design/DESIGN.md` 第 10 节第 6 条写（备份在 `.knit/.runtime/backups/<时间>/`）。
4. 开始用：`knit init` → 在 `.knit/workflow.yaml` 里写 `model` → `knit workflow validate` → 在项目里打开 Pi 并同意加载项目扩展，主会话就有 `knit_task`、`knit_run`、`knit_deliver` 三个工具。每一步一行。
5. 命令：一个代码块，列出 `knit --help` 和各子命令 `--help` 里的命令，一条一行加一句说明。以 `--help` 的实际输出为准，不要照设计文档抄。
6. 仓库里有什么：目录清单。`docs/design/` 写「现行设计」，`docs/history/` 写「旧 Knit 的设计、任务索引和执行记录」。
7. 接着读：`AGENTS.md`（开发协作入口）、`docs/README.md`（文档索引）、`docs/design/DESIGN.md`（设计）。

`docs/README.md` 写成下面几段，用相对链接：

1. 开头一段：开发入口是 `AGENTS.md`；任务在 `.knit/tasks/`，流程在 `.knit/workflow.yaml`，规范在 `.knit/standards/`。不重复 `AGENTS.md` 里的规则。
2. 现行设计：只有 `design/DESIGN.md` 一份，列出它的 11 节各讲什么（一节一行）。
3. 研究：`research/RESEARCH.md`（旧 Knit 的调研依据）、`research/WORKTREE.md`（旧 Knit 的 Worktree 规则，Worktree 并行加回时参考）、`research/REX-PANE.md`（Rex 窗格的接口和核实记录，现行）。
4. 验证记录：`validation/` 下以 `slim-` 开头的目录是现在这个 Knit 的（逐个列出目录名和一句说明，以 `ls -d validation/slim-*` 的结果为准）；其余是旧 Knit 的，只作历史证据。
5. 历史：`history/design/`（旧设计七份）、`history/TASKS.md`、`history/tasks/`、`history/BLOCKERS.md`。保留现在最后两段里「历史材料里的命令和路径按当时的布局理解、不回填」的意思，去掉指向 `design/` 的那半句。

不能动的：

- `AGENTS.md`、`docs/design/DESIGN.md`、`docs/history/`、`docs/research/`：本任务只改两个 README。
- `scripts/pack-check.mjs`：它要求包里有 `README.md`，不用改。
- 不提交、不推送。

## 完成条件

- 旧说法都不在了。下面的命令输出 `0`：

  ```bash
  cat README.md docs/README.md | grep -cE 'knit start|--pi|rebind|execution\.host|run schedule|run check|Worktree 与显式多任务调度已实现|受管|init-backup|准备 → 实现|可交付资格|ROLE-CONTRACT|OPERATIONS\.md|STATES\.md'
  ```

- `node validation/slim-h5-2026-11/check-links.mjs docs README.md AGENTS.md` 没有输出，退出码 0。
- `README.md` 的命令一段里每条命令都真的有：逐条运行 `knit <命令> --help`（用仓库里的 `node dist/cli/knit.js`，先 `npm run -s build`），都以退出码 0 返回；把运行过的命令列在报告里。
- `npm run pack:check` 通过。
- `git status --short` 里除了任务目录只有 `README.md` 和 `docs/README.md`。

## 待澄清

无。

## 相关资料

- `docs/design/DESIGN.md#1. 要做的事` — README 第一段的来源
- `docs/design/DESIGN.md#10. 用 Knit 开发 Knit` — `knit init --force` 的行为

交付：`--paths README.md docs/README.md`。提交文案首行建议 `docs: rewrite the README and the docs index for the new Knit`。

## 结果

`README.md` 和 `docs/README.md` 按现在的 Knit 重写，由执行者（magpie/group/deepseek，执行 r-2e4072223b79）做，主会话逐条核对。`README.md` 是任务要求的七段；安装一段的命令和原来一样，只少了 `knit init --pi`、`knit start --pi` 两行。`docs/README.md` 是五段，列了设计的 11 节和三个 `slim-` 验证目录。

五条完成条件主会话都重新跑过，都满足：旧说法的计数是 `0`；`check-links.mjs` 没有输出，退出码 0；`npm run -s build` 之后 README 命令一段的 17 条逐条运行 `node dist/cli/knit.js <命令> --help`，退出码都是 0（init、workflow show、workflow validate、task new、task list、task show、task ready、task close、task cancel、standards list、run start、run status、run wait、run cancel、context、deliver、help），除 `help` 以外的 16 条和各级 `--help` 列出的命令是同一批；`npm run pack:check` 输出「pack 检查通过」；任务目录之外只改了这两个文件。

没有验证的：三种安装方式没有实际走一遍，命令是照原文留下的。
