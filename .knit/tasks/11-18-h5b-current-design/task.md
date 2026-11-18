---
id: k-1a73047ca4d5
title: H5b 现行设计写成 docs/design/DESIGN.md
status: draft
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn:
  - k-723a69491855
priority: P1
createdAt: 2026-11-18T15:28:36.570Z
---

## 目标与范围

Knit 现行的设计写在主任务的资料 `.knit/tasks/11-14-slim-refactor/design.md` 里。主任务归档时它会跟着进归档目录。本任务把它的第 1–11 节搬成 `docs/design/DESIGN.md`，主任务的 `design.md` 只留讲重写过程的第 12–14 节（可搬代码、规模估算、重写怎么进行）；第 15 节「还没定的内容」现在是空的，删掉。章节号不变。

前置条件：H5a 已经做完，`docs/design/` 是空的（`ls docs/design 2>/dev/null | wc -l` 输出 `0`）。

步骤（在仓库根目录）：

1. 运行脚本：

   ```bash
   node validation/slim-h5-2026-11/split-design.mjs
   ```

   预期输出 `已写出 docs/design/DESIGN.md（替换 29 处）；.knit/tasks/11-14-slim-refactor/design.md 只留第 12–14 节；另外改了 2 个文件`。

   脚本做三件事：

   - 把第 1–11 节写成 `docs/design/DESIGN.md`，同时按脚本里的 `EDITS` 表逐条替换掉讲重写过程和旧 Knit 的说法（“沿用现在的”“第一版”“切换之后”“用户某日决定”、还没有的 `task search` 命令、指向任务资料的路径等）。每一条都要求在原文里正好出现一次，对不上就报错退出、什么都不写。
   - 把主任务的 `design.md` 改成只有第 12–14 节，开头加一段说明现行设计搬到了哪里。
   - 改 `AGENTS.md`「文档与目录」的头两行和主任务 `task.md`「相关资料」的一行，让它们指向新位置。

2. 脚本报错时不要手工照着做：把报错原文写进报告，停下来。报错说明 `design.md`、`AGENTS.md` 或主任务的 `task.md` 在脚本写好之后被改过。

3. 通读一遍 `docs/design/DESIGN.md`。发现和代码不符、或者还在讲重写过程的句子时，不在本任务里改，逐条写进报告（第几节、原文、为什么不对）。

不能动的：

- `docs/design/DESIGN.md` 里脚本没有替换的内容：本任务只搬，不改设计。
- 主任务 `plan.md` 里写着「`design.md` 第 N 节」的进度记录：那是当时的记录，章节号没有变，不改。
- `.knit/tasks/archive/` 下的任务。
- `src/`、`test/`、`README.md`、`docs/README.md`（后两个由 H5c 改写）。
- 不提交、不推送。

## 完成条件

- `docs/design/DESIGN.md` 有 11 个带编号的二级标题，任务里列的旧说法一条都没有；主任务的 `design.md` 只剩第 12–14 节。下面的命令输出 `0 11 3 0`：

  ```bash
  T=.knit/tasks/11-14-slim-refactor
  RE='沿用|第一版|切换|next/|减到|代替现在|去掉现在|像现在|现在叫|现在拼|用户 20|已于 20|show \| search|检索用命令行|第 1[2-5] 节|11-14-slim-refactor/design|findings\.md|stage\.ts|--retry|不保留'
  echo "$(grep -cE "$RE" docs/design/DESIGN.md) $(grep -cE '^## [0-9]+\. ' docs/design/DESIGN.md) $(grep -cE '^## 1[234]\. ' $T/design.md) $(grep -cE '^## ([1-9]|1[015])\. ' $T/design.md)"
  ```

- 第 12–14 节和原来逐行相同。下面的命令没有输出，退出码 0：

  ```bash
  T=.knit/tasks/11-14-slim-refactor
  diff -B <(git show HEAD:$T/design.md | sed -n '/^## 12\. /,$p' | sed -n '/^## 15\. /q;p') <(sed -n '/^## 12\. /,$p' $T/design.md)
  ```

- `node validation/slim-h5-2026-11/check-links.mjs docs README.md AGENTS.md` 没有输出，退出码 0；`grep -c '11-14-slim-refactor/design.md' AGENTS.md` 输出 `0`。

## 待澄清

无。

## 相关资料

- `validation/slim-h5-2026-11/README.md` — 脚本的用途，和在克隆里演练的结果
- `validation/slim-h5-2026-11/split-design.mjs` — 拆分的脚本，要替换的 29 处都在 `EDITS` 表里

交付：主会话直接做时，`knit task close` 的 `--paths` 写 `docs/design/DESIGN.md AGENTS.md .knit/tasks/11-14-slim-refactor/design.md .knit/tasks/11-14-slim-refactor/task.md`。提交文案首行建议 `docs: make docs/design/DESIGN.md the current design`。之后依次是 H5f（加第 7.3 节）、H5e（移 Rex 的记录），再之后 H5c、H5d 互不依赖。
