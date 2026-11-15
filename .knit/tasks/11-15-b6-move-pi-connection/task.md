---
id: k-a8ee3812cd7b
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-267e1cc4ffc1
order: null
createdAt: 2026-11-15T04:47:52.074Z
title: B6 搬 Pi 连接到 next/，执行者照常读 AGENTS.md
---

# B6 搬 Pi 连接到 next/，执行者照常读 AGENTS.md

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动（见 `.knit/tasks/11-14-slim-refactor/design.md` 第 7 节、第 11 节、第 12 节）。Knit 通过本机的 `pi --mode rpc` 启动执行者，这部分连接代码已经验证过，直接搬。

现在启动执行者时带 `--no-context-files`，执行者读不到项目的 `AGENTS.md`。小核心去掉这个参数，让执行者像普通智能体一样读 `AGENTS.md`。

做完之后的不同：`next/` 里有 Pi 的连接和启动代码；启动参数里没有 `--no-context-files`。

产出：

| 新文件 | 来源 | 要改的地方 |
| --- | --- | --- |
| `next/src/contracts/frames.ts` | `src/contracts/frames.ts` | 不改 |
| `next/src/adapters/pi/connection.ts` | `src/adapters/pi/connection.ts` | 不改 |
| `next/src/adapters/pi/native-file.ts` | `src/adapters/pi/native-file.ts` | 不改 |
| `next/src/adapters/pi/runtime.ts` | `src/adapters/pi/runtime.ts` | 见下 |
| `next/src/adapters/pi/index.ts` | `src/adapters/pi/index.ts` | 只转出上面三个模块 |
| `next/test/pi-runtime.test.mjs` | 见下面的测试清单 | 导入路径改为 `../dist/…` |

`runtime.ts` 要改的地方：

1. `buildPiArgs` 去掉 `--no-context-files`。其余参数不变。
2. `isolatedEnv` 清除的环境变量里去掉 `KNIT_KEYS_ROOT`：小核心没有密钥目录。
3. `ToolCapability` 类型改从 `next/src/contracts/workflow.ts` 导入（B4 已搬，其中没有 `task`）。

不搬这些：

| 不搬的 | 原因 |
| --- | --- |
| `src/adapters/pi/resume.ts` | 小核心不续用执行者的旧会话，重新派发总是新会话 |
| `src/adapters/pi/native-entries.ts` | 只给“按会话记录判定改动来源”用，小核心改为前后对比 |

怎么搬：

- 旧文件保持原样。搬过来的代码除了上面点名的地方不改写法。`.knit/standards/development.md` 的「写法」一节只约束新写的代码。
- 下面点名的每个旧测试，要么搬过来，要么在报告里写明没搬的原因。

要搬的测试：

- `test/pi-runtime.test.mjs`：
  - 「checkNativeSessionFile 识别合法文件与损坏文件」
  - 「isolatedEnv 移除主会话变量并设置离线标志」
  - 「连接在进程被杀后以 PiConnectionClosedError 拒绝未决请求并给出真实信号」（本机没有 `pi` 命令时它会自己跳过；它不向模型发请求）
  - 「连接层把非 JSON 与非对象帧归入 invalidFrames，不作响应或事件」
  - 「连接层有界等待 stderr 收敛，流结束后冻结尾部」
  - 「runtime 启动失败后 dispose 保留 stderr 尾部快照且幂等」
- `test/macos-compat.test.mjs`：
  - 「进程组信号：ESRCH 视为已结束；EPERM 在已退出时视为已结束，未退出时回退组长 pid」
- `test/stage-contract.test.mjs`（三个测试都只调用 `buildPiArgs`；用到的小工具 `argsOf`、`valueOf` 一起搬）：
  - 「能力→Pi 参数：缺省收紧，external 放开扩展／MCP／技能，network 放开离线」
  - 「能力→Pi 参数：空能力全部禁用（--no-tools，离线并禁用扩展／MCP／技能）」：原测试后半段用 `parseWorkflow` 解析 `all`，改为直接传 `capabilities: null`。
  - 「能力→Pi 参数：未写 tools 表示全部放开；task 显式加载项目扩展」：后半段的 `capabilities: ["task"]` 改为 `["read"]`，保留对 `--extension` 和 `--no-extensions` 的断言。
- 新增一条断言：`buildPiArgs` 的结果里没有 `--no-context-files`。

不搬的测试：`test/pi-runtime.test.mjs` 里 5 个名字以“真实模型冒烟”开头的测试。它们会调用真实模型，其中两个测的是续用旧会话。真实模型上的验证留到切换前的全流程演练（H1），那个任务开始前要单独取得用户授权。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里已有的文件。
- 不引入 Pi SDK，不加依赖，不提交、不推送。
- 不在测试里调用真实模型。

前置条件：B5 已完成（本任务只用到 B4 搬来的 `next/src/contracts/workflow.ts`；排在 B5 之后是为了同一时间只有一个任务在改 `next/`）。运行 `npm run test:next` 能通过，并且 `ls next/src/contracts/workflow.ts` 存在。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」和来源文件。
3. 复制源文件，按上面修改。
4. 新建测试文件，搬入并修改测试。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。本机没有 `pi` 命令时有 1 个测试显示跳过，属于预期，在报告里写明。
- `grep -rn "no-context-files\|KNIT_KEYS_ROOT\|resume\|native-entries" next/src/adapters`：没有输出。
- `git status --short`：和开始前相比，只多出上表的 6 个文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件（照 `git status --short` 抄）、运行过的命令和最后一次完整运行的测试数（含跳过的）、没有验证的内容、没搬的测试及原因。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): move the Pi connection and let executors read AGENTS.md`。“执行者确实读到了 `AGENTS.md`”没有在真实模型上验证，留到 H1。

## 完成条件

- 上表的 5 个源文件存在于 `next/src/`，除点名的修改外内容与来源一致。
- `buildPiArgs` 的结果里没有 `--no-context-files`，有测试断言这一点。
- 点名的 10 个测试都在 `next/test/pi-runtime.test.mjs` 里并通过（或按预期跳过），或在报告里写明没搬的原因。
- `next/` 以外没有改动。

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md` 第 7 节、第 11 节、第 12 节 — 执行方式；不做的功能；可以搬的代码
- `.knit/standards/development.md` — 开发规范
- `src/adapters/pi/` 下的 `connection.ts`、`runtime.ts`、`native-file.ts`、`index.ts`，`src/contracts/frames.ts` — 来源
- `next/src/contracts/workflow.ts` — `ToolCapability` 类型
- `test/pi-runtime.test.mjs`、`test/macos-compat.test.mjs`、`test/stage-contract.test.mjs` — 来源测试

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
