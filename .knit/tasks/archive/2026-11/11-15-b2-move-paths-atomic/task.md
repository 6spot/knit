---
id: k-527125c2184c
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-ddc268063a5a
order: null
createdAt: 2026-11-15T04:47:48.416Z
title: B2 搬路径、原子写和文件指纹到 next/
---

# B2 搬路径、原子写和文件指纹到 next/

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动（见 `.knit/tasks/11-14-slim-refactor/design.md` 第 12、14 节）。已经验证过的基础代码直接搬过去用。

做完之后的不同：`next/` 里有路径规范化、带版本核对的原子写和文件指纹这几个基础模块，并带着它们原有的测试。

产出：

| 新文件 | 来源 | 要改的地方 |
| --- | --- | --- |
| `next/src/infrastructure/errors.ts` | `src/infrastructure/errors.ts` | 错误码只保留搬到 `next/` 的代码实际抛出的那几个；和锁、凭据有关的错误码删掉 |
| `next/src/infrastructure/paths.ts` | `src/infrastructure/paths.ts` | 不改 |
| `next/src/infrastructure/atomic.ts` | `src/infrastructure/atomic.ts` | 不改 |
| `next/src/infrastructure/fingerprint.ts` | `src/infrastructure/fingerprint.ts` | 不改 |
| `next/src/contracts/digest.ts` | `src/contracts/digest.ts` | 不改（`fingerprint.ts` 依赖它） |
| `next/test/infrastructure.test.mjs` | 见下面的测试清单 | 导入路径改为 `../dist/…` |

怎么搬：

- “搬”是把旧文件复制到 `next/src/` 下相同的相对路径，旧文件保持原样。
- 搬过来的代码除了上表点名的地方不改。`.knit/standards/development.md` 的「写法」一节只约束新写的代码，不要为了符合它去重写搬过来的代码。
- 下面点名的每个旧测试，要么搬过来，要么在报告里写明没搬的原因。测试用到的小工具（如 `freshDir`、`aliasedTmp`）一起搬到新测试文件里。

要搬的测试：

- `test/infrastructure.test.mjs`：
  - 「原子写：预期版本不符不覆盖后来内容」
  - 「原子写：私有权限 0600 与嵌套目录创建」
  - 「原子写失败路径：临时文件清理后原文件保留」
  - 「指纹与路径：稳定键、safeJoin 拒绝越界与符号链接逃逸」
  - 「文件事实：absent 如实记录，不抛错；链接按目标、文件含模式（任务027）」
- `test/macos-compat.test.mjs`：
  - 「路径规范化：/var → /private/var 别名视为同一位置；不存在的尾段原样拼回」

不能动的：

- `next/` 以外的所有文件，包括 `src/`、`test/`、`assets/`、`package.json`、`.knit/`、`AGENTS.md`：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里已有的文件（`next/tsconfig.json`、`next/src/cli/knit.ts`、`next/test/cli.test.mjs`）：本任务用不到。
- 不加依赖，不提交、不推送。

前置条件：B1 已完成。运行 `npm run test:next`，能通过就说明具备。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」和上表的来源文件。
3. 复制源文件，按上表修改。
4. 新建测试文件，搬入点名的测试。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`，并且包含上面点名的 6 个测试。
- `git status --short`：和开始前相比，只多出上表的 6 个文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件（照 `git status --short` 抄）、运行过的命令和最后一次完整运行的测试数、没有验证的内容、没搬的测试及原因。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): move path, atomic write and fingerprint helpers`。

## 完成条件

- 上表的 5 个源文件存在于 `next/src/`，除 `errors.ts` 的错误码外内容与来源一致。
- 点名的 6 个测试都在 `next/test/infrastructure.test.mjs` 里并通过，或在报告里写明没搬的原因。
- `next/` 以外没有改动。

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md` 第 12 节 — 可以搬的现有代码
- `.knit/standards/development.md` — 开发规范
- `src/infrastructure/errors.ts`、`paths.ts`、`atomic.ts`、`fingerprint.ts`，`src/contracts/digest.ts` — 来源
- `test/infrastructure.test.mjs`、`test/macos-compat.test.mjs` — 来源测试

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-54ba7724c20e -->
- 操作: op-54ba7724c20e
- 时间: 2026-11-15T06:44:29.079Z
- 分支: refs/heads/main
- 授权来源: user:1f7f9eea
- 调用: bridge
- 工作提交: 86bf44d9c562a947d200da1fde3d3a12923d2254
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-b2-move-paths-atomic

### 任务资料提交记录

<!-- knit:metadata-commit:op-54ba7724c20e -->
- 任务资料提交: 593c93747e2b23dd267ab6f2f181eb7e231002d0
- 归档目标: .knit/tasks/archive/2026-11/11-15-b2-move-paths-atomic

<!-- knit:progress:end -->
