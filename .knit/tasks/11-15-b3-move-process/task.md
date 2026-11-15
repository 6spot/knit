---
id: k-7c1fde35390f
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-527125c2184c
order: null
createdAt: 2026-11-15T04:47:49.333Z
title: B3 搬进程启动、清理和 Git 调用到 next/
---

# B3 搬进程启动、清理和 Git 调用到 next/

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动（见 `.knit/tasks/11-14-slim-refactor/design.md` 第 7、11、12 节）。小核心同一时间只跑一个执行者，没有锁；它需要启动后台进程、判断一个进程是否还是原来那个、取消时清理整棵进程树，以及调用 Git。这些在 `src/infrastructure/process.ts` 里已经有，并在 macOS 和 Linux 上验证过。

做完之后的不同：`next/` 里有进程启动与清理、Git 调用的基础模块，不依赖锁。

产出：

| 新文件 | 来源 |
| --- | --- |
| `next/src/infrastructure/process.ts` | `src/infrastructure/process.ts` 的一部分，见下 |
| `next/test/process.test.mjs` | 见下面的测试清单 |

从 `process.ts` 搬这些：

- `procStartTicks`、`sameProcessStart`：进程的启动标识和比较。
- `processTable`、`parseProcessTablePs`、`processTreePids`、`signalProcessTree`：进程表、进程树和整树发信号。
- `NodeProcessPort`：启动子进程、等待退出、向进程组发信号。它用到的 `ManagedProcess` 类型（现在在 `src/ports/infrastructure.ts`）直接写在 `process.ts` 里；不建 `ports/` 目录，`NodeProcessPort` 不再声明实现某个接口。
- `gitSync` 和它用的固定 Git 环境变量。

不搬这些：

| 不搬的 | 原因 |
| --- | --- |
| `currentIdentity`（从 `locks.js` 转出） | 小核心没有锁 |
| `machineBootId` | 只给锁的持有者身份用 |
| `withGitHooksPath`、`scopedGitHooksPath` 和它们用的 `AsyncLocalStorage` | 小核心交付时不隔离 Git hook，hook 失败就照实报告 |
| `ArgvGitPort`、`gitBufferSync` | 小核心目前只需要同步的文本调用；以后有任务用到再搬 |

怎么搬：

- 旧文件保持原样。搬过来的函数除了去掉上表的内容，不改写法。`.knit/standards/development.md` 的「写法」一节只约束新写的代码。
- 下面点名的每个旧测试，要么搬过来，要么在报告里写明没搬的原因。测试用到的小工具（如 `isProcessAlive`，在 `test/helpers/run-settled.mjs`）直接写在新测试文件里。

要搬的测试：

- `test/infrastructure.test.mjs`：
  - 「进程：procStartTicks 是当前进程的稳定启动身份」
  - 「进程：spawn/wait/killProcessGroup 对真实子进程」
  - 「进程树：取消时清理工具自建进程组的后代」
  - 「进程身份：ps 回退带可执行名；同秒不同命令视为不同进程，旧格式只比 lstart」
  - 「Git：argv 调用与 NUL 解析、固定环境」：原测试用 `ArgvGitPort`。改成只用 `gitSync`，保留这几项断言：提交说明里的引号和 `$VAR` 原样保留（参数不经过 shell）；`rev-parse HEAD` 返回 40 位十六进制；不存在的引用返回非零退出码和错误输出，不抛异常。
- `test/process-regression.test.mjs`：
  - 「进程059：ps解析兼容24字符日期、单日空白和多位日，忽略残缺行」
  - 「进程059：wait取得真实退出码，快速退出后重复wait仍可读取」

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里已有的文件。`next/src/infrastructure/errors.ts` 例外：搬过来的代码抛出了它没有的错误码时，补上这个错误码。
- 不加依赖，不提交、不推送。

前置条件：B2 已完成。运行 `npm run test:next` 能通过，并且 `ls next/src/infrastructure/errors.ts` 存在。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」和来源文件。
3. 新建 `next/src/infrastructure/process.ts`，搬入点名的内容。
4. 新建测试文件，搬入点名的测试。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`，并且包含上面点名的 7 个测试。
- `grep -n "locks\|AsyncLocalStorage\|ports/" next/src/infrastructure/process.ts`：没有输出。
- `git status --short`：和开始前相比，只多出上面两个文件（改了 `errors.ts` 时多一行修改）。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件（照 `git status --short` 抄）、运行过的命令和最后一次完整运行的测试数、没有验证的内容、没搬的测试及原因。测试是在哪个系统上跑的也写上（macOS 还是 Linux）：进程表在两个系统上走不同的代码。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): move process and git helpers without locks`。另一个系统上的验证没有做，留到切换前的全流程演练（H1）。

## 完成条件

- `next/src/infrastructure/process.ts` 含有点名要搬的全部内容，不含点名不搬的内容，不引用锁。
- 点名的 7 个测试都在 `next/test/process.test.mjs` 里并通过，或在报告里写明没搬的原因。
- `next/` 以外没有改动。

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md` 第 7 节、第 11 节、第 12 节 — 执行方式；不做的功能；可以搬的代码
- `.knit/standards/development.md` — 开发规范
- `src/infrastructure/process.ts`、`src/ports/infrastructure.ts` — 来源
- `test/infrastructure.test.mjs`、`test/process-regression.test.mjs`、`test/helpers/run-settled.mjs` — 来源测试

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-9fe0e4b9d567 -->
- 操作: op-9fe0e4b9d567
- 时间: 2026-11-15T06:45:56.681Z
- 分支: refs/heads/main
- 授权来源: user:1f7f9eea
- 调用: bridge
- 工作提交: 6a620ae5fc9ebab47666901f086ab640a80f0a5c
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-b3-move-process

<!-- knit:progress:end -->
