---
id: k-4b534dded53d
title: L0 取消任务的测试不依赖 shasum 命令
status: delivered
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn:
  - k-22ba3b46dab8
priority: P1
createdAt: 2026-11-19T02:49:26.759Z
---

## 目标与范围

`test/task-cancel.test.mjs` 的「已经结束的任务不能取消，文件和目录都不变」用外部命令 `find … -exec shasum` 给 `.knit` 下的文件算摘要，用来比较前后有没有变。`shasum` 是 Perl 的脚本，macOS 自带，很多 Linux 发行版默认不装：在一台没有它的 Linux 机器上（Oracle Linux，aarch64，Node 26.3.0）`npm test` 是 `tests 227`、`pass 226`、`fail 1`，错误是 `find: 'shasum': No such file or directory`。用户 2026-11-19 决定让这个测试不依赖 `shasum`。

做完之后这个测试只用 Node 自带的模块，比较的内容不变：`.knit` 下每个文件的路径和内容，前后要一样。

只改 `test/task-cancel.test.mjs` 里算摘要的那个辅助函数和它用到的 `import`。断言不改，测试的个数不变。

不能动的：

- `src/`：被测的代码没有问题。
- 别的测试文件：`test/` 里只有这一处用 `shasum`。
- `validation/local-real-pi-acceptance-2026-11/` 下两个脚本里的 `shasum`：那是旧 Knit 验收时留下的记录，不改。

## 完成条件

- `grep -rn shasum test` 没有输出。
- 在一台没有 `shasum` 的机器上（`command -v shasum` 没有输出）`npm test` 的输出里是 `ℹ tests 227`、`ℹ fail 0`。
- 新的辅助函数真的能看出变化：改掉 `.knit` 下任意一个文件的内容，或者加一个文件，它的返回值就不一样。

## 待澄清

无。

## 相关资料

- `test/task-cancel.test.mjs` — 要改的测试

交付：`--paths test/task-cancel.test.mjs`。之后回到 H5e（`k-c0000beef2eb`）核对它的第四条完成条件。

## 结果

`test/task-cancel.test.mjs` 里算摘要的辅助函数改成用 Node 自带的 `fs` 和 `crypto`：列出 `.knit` 下的每个文件，算 SHA-256，和路径一起排序。断言没有改。主任务的 `plan.md` 加了一行登记这个任务。

三条完成条件都满足，在一台没有 `shasum` 的 Linux 机器上（Oracle Linux，aarch64，Node 26.3.0）核对：`grep -rn shasum test` 没有输出；`npm test` 是 `tests 227`、`pass 227`、`fail 0`（改之前是 `pass 226`、`fail 1`）；把辅助函数的原文取出来在临时目录里跑，改一个文件的内容、加一个文件，返回值都不一样，改回去之后又一样。

没有验证的：macOS 上没有跑过改后的测试。
