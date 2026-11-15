---
id: k-ddc268063a5a
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-15T04:47:47.507Z
title: B1 脚手架：next/ 的构建、测试脚本和 knit --version
---

# B1 脚手架：next/ 的构建、测试脚本和 knit --version

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心（见 `.knit/tasks/11-14-slim-refactor/design.md` 第 14 节）。新代码写在 `next/` 目录里，旧代码（`src/`、`test/`、`assets/`）在切换之前不动。本任务建立 `next/` 的骨架，后面的任务往里加代码。

做完之后的不同：`npm run test:next` 能构建并测试 `next/` 里的代码，`node next/dist/cli/knit.js --version` 能打印版本号。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/tsconfig.json`（新增） | 继承根目录的 `tsconfig.json`，只编译 `next/src`，输出到 `next/dist` |
| `next/src/cli/knit.ts`（新增） | 命令行入口：用 `commander` 建一个名为 `knit` 的程序，`--version` 打印根目录 `package.json` 的 `version`。不注册任何子命令 |
| `next/test/cli.test.mjs`（新增） | 一个测试：运行 `node next/dist/cli/knit.js --version`，输出等于根目录 `package.json` 的 `version`，退出码 0 |
| `package.json`（修改） | `scripts` 里新增两项：`build:next`（删除 `next/dist` 后用 `tsc -p next/tsconfig.json` 编译）和 `test:next`（先 `build:next`，再 `node --test "next/test/*.test.mjs"`） |
| `.gitignore`（修改） | 新增一行 `/next/dist/` |

- 测试文件用 `node:test` 和 `node:assert/strict`，从 `../dist/…` 导入编译后的代码，和 `test/` 下现有测试的写法一致。
- 新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `src/`、`test/`、`assets/`、`scripts/`、`docs/`：旧代码在切换前保持原样。
- `tsconfig.json`、`tsconfig.build.json`：旧代码的类型检查和构建在用。
- `package.json` 里已有的内容（`bin`、`files`、`dependencies`、已有的 `scripts`）：正在管理本仓库的安装版 Knit 是按它们打包的。只新增上面两个脚本，不加依赖。
- `.knit/`、`AGENTS.md`：流程配置、规范和任务资料。
- 不提交、不推送。

前置条件：Node 24 以上，已运行过 `npm ci`。用 `node --version` 和 `ls node_modules/.bin/tsc` 确认。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 新增和修改上表的文件。
4. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `node next/dist/cli/knit.js --version`：打印的版本号与 `package.json` 的 `version` 相同。
- `npm test`：旧测试仍然通过。它要跑约 5 分钟，其中 5 个名字带“真实模型冒烟”的测试会调用本机的 Pi（这是现有行为）。
  - 已知情况：2026-11-15 的一次完整运行里，798 个测试有 1 个失败，是 `test/worktree-parallel.test.mjs` 的「不同 worktree 并行：两个执行目录锁同时存在…」；单独运行这个文件 3 次都通过。如果只有这一个失败，单独运行 `node --test test/worktree-parallel.test.mjs`，通过就算通过，并在报告里写明。
- `npm run pack:check`：通过。发布包只含 `assets/` 和 `dist/`，`next/` 不应进入发布包。
- `git status --short`：和开始前相比，只多出上表的五个文件（`next/dist/` 已被忽略，不应出现）。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件（照 `git status --short` 抄）、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add the build and test scaffold`。`next/` 里还没有任何功能，由 B2 起的任务加入。

## 完成条件

### Requirement: next 目录可以独立构建和测试

#### Scenario: 构建并运行测试

- WHEN 在仓库根目录运行 `npm run test:next`
- THEN `next/src` 被编译到 `next/dist`
- AND `next/test` 下的测试全部通过

#### Scenario: 打印版本号

- WHEN 运行 `node next/dist/cli/knit.js --version`
- THEN 输出根目录 `package.json` 的 `version`，退出码为 0

#### Scenario: 旧代码不受影响

- WHEN 运行 `npm test`
- THEN 旧测试的结果和本任务开始前一样

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md` 第 14 节 — 重写怎么进行
- `.knit/standards/development.md` — 开发规范
- `package.json`、`tsconfig.json`、`tsconfig.build.json` — 现有的构建和测试配置
- `src/cli/knit.ts` 第 1–15 行 — 旧入口读取版本号的写法，可以参考

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-b3609ac5afe0 -->
- 操作: op-b3609ac5afe0
- 时间: 2026-11-15T06:44:12.674Z
- 分支: refs/heads/main
- 授权来源: user:1f7f9eea
- 调用: bridge
- 工作提交: 27b9939b618e58c4f984d558b3e8e73d7decb98f
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-b1-next-scaffold

### 任务资料提交记录

<!-- knit:metadata-commit:op-b3609ac5afe0 -->
- 任务资料提交: d47dbc4a4373a82e9b0d7a75bff1281de1d44633
- 归档目标: .knit/tasks/archive/2026-11/11-15-b1-next-scaffold

<!-- knit:progress:end -->
