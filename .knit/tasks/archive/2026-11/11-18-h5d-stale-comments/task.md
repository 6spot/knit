---
id: k-7a206502394e
title: H5d 清理注释里指向旧文档和旧任务的说法
status: delivered
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn:
  - k-c0000beef2eb
priority: P1
createdAt: 2026-11-18T15:28:36.835Z
---

## 目标与范围

`src/` 和 `test/` 里有 19 行注释还指着重构之前的东西：旧设计文档的章节号（`TECHNOLOGY.md 第4节`、`DESIGN.md 5.6` 等，这些文档已经移到 `docs/history/design/`，章节号和现行设计对不上）、旧任务编号（`任务034`、`B001`）、已经删掉的锁和 Worktree。本任务只改这些注释，不改代码。

前置条件：`docs/design/DESIGN.md` 是现行设计（H5b 已做完）；H5e 已做完（它也改 `src/` 里的注释，两个任务不同时进行）。

逐处怎么改（行号是写这个任务时的，以内容为准）：

| 文件 | 原来 | 改成 |
| --- | --- | --- |
| `src/contracts/digest.ts` 第 2 行 | `确定性摘要（TECHNOLOGY.md 第4节）：` | `确定性摘要：` |
| `src/contracts/digest.ts` 第 4 行 | `不反向依赖 infrastructure（DESIGN.md 第2节分层）。` | `不反向依赖 infrastructure。` |
| `src/adapters/pi/connection.ts` 第 2 行 | `RPC 连接（DESIGN.md 5.6）。` | `RPC 连接。` |
| `src/adapters/pi/runtime.ts` 第 2 行 | `最小实现（DESIGN.md 5.4–5.6、9.4）。` | `最小实现。` |
| `src/adapters/pi/runtime.ts` 第 235 行 | `// 不一致带错误会话锁继续执行会把成果写进错误对象（任务035）。` | `// 不一致还继续执行，会把成果写进错误的对象。` |
| `src/adapters/pi/runtime.ts` 第 291、305 行 | `（任务034）` | 删掉这个括号 |
| `src/infrastructure/atomic.ts` 第 2 行 | `原子发布（TECHNOLOGY.md 第4节）：锁内读取预期版本、` | `原子发布：读取预期版本、` |
| `src/infrastructure/process.ts` 第 2–3 行 | `POSIX 进程与 Git argv 基础（TECHNOLOGY.md 第5节）。`／`进程身份含机器／启动标识、PID starttime 与本次实例信息；旧 PID 不足以判断存活。` | `POSIX 进程与 Git argv 基础。`／`进程身份是进程号加启动标识；只凭进程号判断不了是不是原来那个进程。` |
| `src/infrastructure/process.ts` 第 21 行 | `同平台自洽，任务052/B001）。` | `同平台自洽）。` |
| `src/infrastructure/process.ts` 第 43 行 | `避免升级前写入的 owner 因格式不同被误判为 PID 复用而遭回收。` | `避免升级前写入的记录因格式不同被误判为 PID 复用。` |
| `src/infrastructure/process.ts` 第 166 行 | `（跨平台混用同一锁目录不受支持）` | `（同一份运行资料不支持跨平台混用）` |
| `src/infrastructure/fingerprint.ts` 第 2 行 | `文件身份与指纹（TECHNOLOGY.md 第4节）。` | `文件身份与指纹。` |
| `src/infrastructure/paths.ts` 第 2 行 | `路径规范化与稳定键（OPERATIONS.md 第2节）。` | `路径规范化与稳定键。` |
| `src/infrastructure/paths.ts` 第 18 行 | `（git worktree list／rev-parse 均给真实路径）比较或落库，` | `（rev-parse 给的是真实路径）比较，` |
| `test/infrastructure.test.mjs` 第 115 行 | 测试名字末尾的 `（任务027）` | 删掉这个括号 |
| `test/workflow.test.mjs` 第 16 行、`test/workflow-cli.test.mjs` 第 11 行 | `design.md 第 6.1 节的示例流程。` | `docs/design/DESIGN.md 第 6.1 节的示例流程。` |

做之前先核实两处说法（核实不了就不改那一行，写进报告）：

- `src/infrastructure/process.ts` 里确实没有读机器标识或实例信息的代码（`grep -nE 'machine|boot|hostname|instance' src/infrastructure/process.ts` 没有输出）。
- `src/infrastructure/atomic.ts` 里确实没有加锁（`grep -n 'lock' src/infrastructure/atomic.ts` 没有输出）。

不能动的：

- 代码：只改注释和一个测试的名字。发现注释以外的问题写进报告，不顺手改。
- `src/adapters/rex/pane.ts` 和 `test/helpers/fake-rex.mjs` 第 3 行的注释：H5e 已经改过。
- `scripts/pack-check.mjs` 里的 `DESIGN.md` 等文件名：那是「安装包里不能有这些文件」的清单，不是指向文档的引用。
- 不提交、不推送。

## 完成条件

- 改之前先运行一次 `npm test`，记下测试个数（写这个任务时是 227 个，全部通过）。改之前就有失败时停下来报告，不接着做。
- 下面的命令输出 `0`：

  ```bash
  grep -rnE '(TECHNOLOGY|OPERATIONS)\.md|（DESIGN\.md|任务0[0-9]{2}|B00[0-9]|锁内|锁目录|会话锁|git worktree|写入的 owner|机器／启动标识|\*\* design\.md 第' src test | wc -l
  ```

- 改动的都是注释，另加一个测试的名字。下面的命令正好输出两行，都含 `test("文件事实`：

  ```bash
  git diff -U0 -- src test | grep -E '^[+-][^+-]' | grep -vE '^[+-][[:space:]]*(\*|//|/\*\*)'
  ```

- `npm test` 的测试个数和改之前一样，`ℹ fail 0`；`npm run typecheck` 退出码 0。

## 待澄清

无。

## 相关资料

- `docs/design/DESIGN.md#11. 不做与延后` — 锁、Worktree 已经去掉的依据

交付：`--paths` 写上表里的 10 个文件。提交文案首行建议 `chore: drop comments that point at the old design and tasks`。

## 结果

`src/` 和 `test/` 里 19 行指向旧设计文档章节、旧任务编号、锁和 Worktree 的注释按任务里的表改了，共 10 个文件，19 行换 19 行。由执行者（magpie/group/deepseek，执行 r-e0914a28cab7）做，主会话对照差异逐行核对过，和表一致。代码没有改，只有一个测试的名字去掉了末尾的括号。

完成条件都满足，主会话在 Linux（Oracle Linux，aarch64，Node 26.3.0）上重新跑过：改之前 `npm test` 是 227 个全部通过（执行者跑的，主会话在上一个任务交付前也跑到同样的数）；残留说法的计数是 `0`；不是注释的改动正好两行，都是 `test("文件事实` 那个名字；改之后 `npm test` 是 `tests 227`、`pass 227`、`fail 0`；`npm run typecheck` 退出码 0。做之前要核实的两处也成立：`process.ts` 里没有读机器标识或实例信息的代码，`atomic.ts` 里没有加锁。

没有验证的：无。
