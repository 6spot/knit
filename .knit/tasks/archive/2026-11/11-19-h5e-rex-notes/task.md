---
id: k-c0000beef2eb
title: H5e Rex 窗格的核实记录移到 docs/research
status: delivered
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn:
  - k-22ba3b46dab8
priority: P1
createdAt: 2026-11-18T16:55:55.540Z
---

## 目标与范围

Rex 的接口和本机核实过的表现记在主任务的资料 `.knit/tasks/11-14-slim-refactor/research/rex-pane.md` 里。现行设计（`docs/design/DESIGN.md` 第 7.2 节）和两处代码注释都指着它，主任务归档时这个路径会失效。本任务把它移到 `docs/research/REX-PANE.md`，并把指向它的地方改过来。

步骤（在仓库根目录）：

1. 移动文件。用普通的 `mv`，不要用 `git mv`（任务里有已经暂存的删除时，`knit deliver` 第一次会失败，见 `validation/slim-h5-2026-11/README.md`）：

   ```bash
   mv .knit/tasks/11-14-slim-refactor/research/rex-pane.md docs/research/REX-PANE.md
   ```

2. 改 `docs/research/REX-PANE.md` 里过期的路径，别的内容不改：
   - 第 3 行：`` `design.md` 第 7.2 节 `` 改成 `` `docs/design/DESIGN.md` 第 7.2 节 ``；四个 `next/src/…`、`next/test/…` 路径去掉前面的 `next/`；最后一句「旧实现在 `src/adapters/rex/`、`src/application/rex-launcher.ts`（共 2,377 行），只作参考，没有搬。」改成「重构之前的旧实现（2,377 行）已经随旧代码删除，没有搬。」
   - 第 140 行：`next/src/infrastructure/process.ts` 去掉前面的 `next/`。
3. 改指向它的三处：
   - `docs/design/DESIGN.md` 第 7.2 节最后一条里的 `.knit/tasks/11-14-slim-refactor/research/rex-pane.md` 改成 `docs/research/REX-PANE.md`。
   - `src/adapters/rex/pane.ts` 第 3 行和 `test/helpers/fake-rex.mjs` 第 3 行注释里的「任务资料 research/rex-pane.md」改成「docs/research/REX-PANE.md」。

不能动的：

- 主任务 `plan.md` 里提到 `research/rex-pane.md` 的进度记录：那是当时的记录，不改。
- `.knit/tasks/archive/` 下的任务。
- 代码：`src/`、`test/` 里只改上面两行注释。
- 不提交、不推送。

## 完成条件

- `test -f docs/research/REX-PANE.md && ! test -e .knit/tasks/11-14-slim-refactor/research/rex-pane.md && echo ok` 输出 `ok`。
- `grep -c 'next/' docs/research/REX-PANE.md` 输出 `0`；这个文件里反引号包着的 `src/`、`test/`、`docs/`、`validation/` 路径都存在。下面的命令没有输出：

  ```bash
  grep -oE '`(src|test|docs|validation)/[^`#]*`' docs/research/REX-PANE.md | tr -d '`' | sort -u | while read -r p; do [ -e "$p" ] || echo "$p"; done
  ```

- `grep -rn 'rex-pane\.md' src test docs README.md AGENTS.md` 没有输出。
- `npm test` 的输出里 `ℹ fail 0`，测试个数和改之前一样（改之前先运行一次记下个数；写这个任务时是 227）。

## 待澄清

无。

## 相关资料

- `docs/design/DESIGN.md#7.2 Rex 窗格` — 指向这份记录的那一节

交付：`--paths docs/research/REX-PANE.md docs/design/DESIGN.md src/adapters/rex/pane.ts test/helpers/fake-rex.mjs .knit/tasks/11-14-slim-refactor/research/rex-pane.md`。提交文案首行建议 `docs: move the Rex pane notes to docs/research`。

## 结果

Rex 窗格的核实记录用 mv 移到 docs/research/REX-PANE.md，里面过期的路径按任务改了（`design.md` 改成 `docs/design/DESIGN.md`，五处 `next/` 去掉，讲旧实现的一句换掉），别的内容没有动；docs/design/DESIGN.md 第 7.2 节和两处代码注释指向新位置。

四条完成条件都满足，在 Linux（Oracle Linux，aarch64，Node 26.3.0）上核对：文件在新位置、旧位置没有了；`next/` 出现 0 次，反引号里的路径都存在；`rex-pane.md` 在 src、test、docs、README.md、AGENTS.md 里搜不到；`npm test` 是 `tests 227`、`pass 227`、`fail 0`，个数和改之前一样。

第四条第一次核对时是 `fail 1`：`test/task-cancel.test.mjs` 用了这台机器上没有的 `shasum` 命令，改之前就失败，和本任务无关。用户决定先修那个测试（任务 k-4b534dded53d，提交 af3c69a），修完之后带着本任务的改动重跑，全部通过。

没有验证的：无。
