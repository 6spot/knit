---
id: k-22ba3b46dab8
title: H5f 设计里写上执行目录的文件坏了怎么恢复
status: draft
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn:
  - k-1a73047ca4d5
priority: P1
createdAt: 2026-11-18T16:55:55.408Z
---

## 目标与范围

执行目录 `.knit/.runtime/runs/<执行 id>/` 里的 `worker.json`、`before.json`、`after.json` 写坏时，读它们的命令直接报 `SyntaxError` 退出。用户 2026-11-16 决定不在代码里处理（要写到一半崩溃或磁盘写满才会出现），只在文档里写清怎么手工恢复。本任务把这一节加进现行设计。

只改一个文件：`docs/design/DESIGN.md`。

步骤：

1. 把 `validation/slim-h5-2026-11/design-7.3.md` 的全文插到 `docs/design/DESIGN.md` 的「### 7.2 Rex 窗格」一节之后、「## 8. 完成与交付」之前，前后各留一个空行。内容不改。
2. 在第 7 节开头的列表里，找到以「执行进程意外退出时不自动恢复」开头的那一条，在它后面加一条：`- 执行目录里的文件坏了时命令会报错退出，恢复办法见第 7.3 节。`
3. 运行核实用的测试（用假的 Pi，不调用模型）：

   ```bash
   npm run -s build && node --test validation/slim-h5-2026-11/broken-run-files.test.mjs
   ```

   6 个测试对应第 7.3 节的每一条说法。有测试失败时，说明文档写的和代码的表现不一致：不改文档去凑，把失败的输出写进报告，停下来。

不能动的：

- `src/`：不加对坏文件的处理，这是用户已经定的。
- `validation/slim-h5-2026-11/design-7.3.md`：留着，它是这一节的来源。
- 不提交、不推送。

没有核实的（写进「结果」）：第 7.3 节里「执行者在 Rex 的窗格里跑时，另外关掉那个窗格」没有试过，测试只覆盖后台执行。

## 完成条件

- `grep -c '^### 7\.3 执行目录里的文件坏了$' docs/design/DESIGN.md` 输出 `1`，并且这一行在「### 7.2」之后、「## 8.」之前：`grep -nE '^### 7\.[23] |^## 8\. ' docs/design/DESIGN.md` 输出的三行行号递增。
- `grep -c '恢复办法见第 7.3 节' docs/design/DESIGN.md` 输出 `1`。
- 上面第 3 步的测试输出里有 `ℹ pass 6` 和 `ℹ fail 0`。
- `git status --short` 里除了任务目录只有 `docs/design/DESIGN.md`。

## 待澄清

无。

## 相关资料

- `validation/slim-h5-2026-11/design-7.3.md` — 要插进去的一节
- `validation/slim-h5-2026-11/broken-run-files.test.mjs` — 核实这一节的测试

交付：`--paths docs/design/DESIGN.md`。提交文案首行建议 `docs: describe how to recover from broken run files`。
