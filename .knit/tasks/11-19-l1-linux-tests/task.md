---
id: k-6dadc77b2d18
title: L1 在 Linux 上跑测试并记录
status: draft
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn:
  - k-b907eafe1bf4
  - k-7a206502394e
  - k-7c9ba52b575b
priority: P1
createdAt: 2026-11-18T16:55:55.795Z
---

## 目标与范围

新 Knit 的测试只在 macOS 上跑过。读进程启动标识有一条只有 Linux 才走的分支（`src/infrastructure/process.ts` 的 `procStartTicks` 读 `/proc/<pid>/stat`），后台进程、取消、等待这些测试在 Linux 上都没有跑过。本任务在一台 Linux 机器上把测试跑一遍，把结果记下来。

这些测试用假的 Pi 和假的 `rex`，不调用模型，不需要装 Pi。

前置条件（不满足就停下报告，不要换别的办法凑）：

- `uname -s` 输出 `Linux`。
- `node -v` 是 24 或更高；有 `npm`、`git`、`pgrep`、`pkill`（后两个在 `procps` 包里）。
- 仓库是干净的克隆：`git status --short` 没有输出。

步骤（在仓库根目录，按顺序；每条命令的完整输出存到 `validation/slim-linux-2026-11/logs/` 下，文件名见括号）：

1. `npm ci --include=dev`（`npm-ci.log`）
2. `npm run typecheck`（`typecheck.log`）
3. `npm test`（`npm-test.log`）
4. `node --test validation/slim-h5-2026-11/broken-run-files.test.mjs`（`broken-run-files.log`）
5. `npm run pack:check`（`pack-check.log`）
6. 测试跑完之后看有没有留下进程：`pgrep -fl 'fake-pi|knit.js run (worker|wait)'`，应当没有输出（`leftover.log`，没有输出时写一行「无」）。

有命令失败时：

- 不改代码，不改测试，不重跑到通过为止。同一条命令再跑一次，两次的结果都记下来，用来区分稳定失败和偶尔失败。
- 接着把后面的步骤跑完。
- 每个失败的测试在记录里写：测试名字、断言的原文、两次的结果、你认为的原因（没有把握就写「未核实」）。修它是另外的任务，由主会话登记。

写记录 `validation/slim-linux-2026-11/README.md`：

- 环境：发行版和版本（`/etc/os-release`）、内核（`uname -r`）、CPU 架构、Node、npm、Git 的版本，仓库的提交号，是不是在容器里。
- 结果：一张表，上面 6 步各一行：命令、退出码、关键数字（测试的 `tests`／`pass`／`fail`）、日志文件。
- 失败的测试（没有就写「没有」）。
- 没有验证的：真的 Pi 和模型（留给 L3）、Rex（Linux 上没有）、Node 的其它版本。

最后改 `AGENTS.md` 里讲平台的那一段：把「Linux 还没有跑过」换成实际的情况，指向这份记录。全部通过时写「Linux 上 `npm test` 跑过一次（见 `validation/slim-linux-2026-11/`），没有用真的 Pi 和模型走过」；有失败时写有几个失败、见哪里。别的句子不动。

不能动的：

- `src/`、`test/`、`scripts/`：本任务只跑、只记。
- 别的 `validation/` 目录。
- 不安装全局的 `knit`（`npm run pack:install` 不在本任务里），不提交、不推送。

## 完成条件

- `validation/slim-linux-2026-11/README.md` 存在，有「环境」「结果」「失败的测试」「没有验证的」四段；「结果」表里 6 步都有退出码。
- `validation/slim-linux-2026-11/logs/` 下有上面 6 个日志文件，`npm-test.log` 里有以 `ℹ tests`、`ℹ pass`、`ℹ fail` 开头的三行，数字和 README 表里写的一样。
- `grep -c 'Linux 还没有跑过' AGENTS.md` 输出 `0`；`grep -c 'slim-linux-2026-11' AGENTS.md` 输出 `1`。
- `git status --short` 里除了任务目录只有 `AGENTS.md` 和 `validation/slim-linux-2026-11/`。

测试有失败不算本任务没完成：如实记下来就算完成，「结果」里写清有几个失败。

## 待澄清

无。

## 相关资料

- `validation/slim-h5-2026-11/README.md` — 第 4 步那份测试是什么
- `src/infrastructure/process.ts` — 只有 Linux 才走的分支在 `procStartTicks` 和 `processTable`

交付：`--paths AGENTS.md validation/slim-linux-2026-11`。提交文案首行建议 `test: record the first Linux test run`。之后是 L3（用真的 Pi 和模型演练）。
