---
id: k-723a69491855
title: H5a 旧设计文档移到 docs/history/design
status: draft
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn: []
priority: P1
createdAt: 2026-11-18T15:28:36.427Z
---

## 目标与范围

`docs/design/` 下的七份文档（`ARCHITECTURE.md`、`DESIGN.md`、`GLOSSARY.md`、`OPERATIONS.md`、`ROLE-CONTRACT.md`、`STATES.md`、`TECHNOLOGY.md`）讲的是重构之前的旧 Knit。本任务把它们原样移到 `docs/history/design/`，并把指向它们的链接、它们往外指的链接改对。做完之后 `docs/design/` 是空的，留给下一个任务放现行设计。

步骤（在仓库根目录）：

1. 移动文件。用普通的 `mv`，不要用 `git mv`：任务里有已经暂存的删除时，`knit deliver` 第一次会失败（见 `validation/slim-h5-2026-11/README.md`「做这些时发现的问题」）。

   ```bash
   mkdir -p docs/history/design
   mv docs/design/*.md docs/history/design/
   ```

2. 改链接：

   ```bash
   node validation/slim-h5-2026-11/relink-old-design.mjs
   ```

   预期输出 `改了 142 处`。数字不一样时不要接着做：先用 `git diff --stat` 看改了哪些文件，把数字和原因写进报告。脚本只做固定的字符串替换，改的是：`docs/history/tasks/`、`docs/history/TASKS.md`、`docs/research/` 里指向这七份文件的相对链接；七份文件自己往外指的相对链接；`docs/README.md`、`README.md`、`AGENTS.md` 里指向 `docs/design/` 的链接；主任务 `task.md`「相关资料」里的一行。

不能动的：

- 七份文件的正文：只改链接的目标，别的字不改。它们是历史档案。
- `.knit/tasks/archive/` 下的任务：里面指向 `docs/design/` 的文字是当时的记录，不改。
- `validation/` 下的文件：里面没有指向 `docs/design/` 的相对链接（已核实），不用改。
- `src/`、`test/`、`scripts/`：注释里提到旧文档的地方由 H5d 处理。
- 不提交、不推送。

## 完成条件

- `ls docs/history/design/*.md | wc -l` 输出 `7`；`ls docs/design 2>/dev/null | wc -l` 输出 `0`。
- 七份文件除链接的目标以外逐行相同。下面的命令没有输出：

  ```bash
  for f in ARCHITECTURE DESIGN GLOSSARY OPERATIONS ROLE-CONTRACT STATES TECHNOLOGY; do
    diff <(git show HEAD:docs/design/$f.md | sed -E 's/\]\([^)]*\)//g') <(sed -E 's/\]\([^)]*\)//g' docs/history/design/$f.md)
  done
  ```

- `node validation/slim-h5-2026-11/check-links.mjs docs README.md AGENTS.md` 没有输出，退出码 0。
- 别处没有动。下面的命令没有输出：

  ```bash
  git status --short | awk '{print $NF}' | grep -vE '^(docs/|README\.md$|AGENTS\.md$|\.knit/tasks/)'
  ```

## 待澄清

无。

## 相关资料

- `validation/slim-h5-2026-11/README.md` — 两个脚本的用途，和在克隆里演练的结果
- `validation/slim-h5-2026-11/relink-old-design.mjs` — 改链接的脚本，替换的规则都在里面

交付：主会话直接做时，`knit task close` 的 `--paths` 写 `docs README.md AGENTS.md .knit/tasks/11-14-slim-refactor/task.md`。提交文案首行建议 `docs: move the old design documents to docs/history/design`。之后是 H5b（写现行设计）。
