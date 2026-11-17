---
id: k-6294f5bafbd8
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-4b35e8771a3e
order: null
createdAt: 2026-11-16T15:19:31.119Z
title: G3 强制初始化：knit init --force
---

# G3 强制初始化：knit init --force

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。`knit init` 已经有了（`next/src/application/init.ts`、`next/src/cli/init.ts`）：只补上没有的文件。本任务加 `--force`：把流程和角色文件恢复成模板的内容，覆盖之前先备份。Knit 升级之后用它换上新的模板。

做完之后的不同：`knit init --force` 能把改过的流程和角色文件恢复成模板，原来的内容留在备份里；配置、规范和任务不受影响。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/init.ts`（修改） | `TEMPLATES` 每一项加 `restore`；`initProject(root, force)`，见下 |
| `next/src/cli/init.ts`（修改） | 加选项 `--force`；输出加两段 |
| `next/test/init-force.test.mjs`（新增） | 见「完成条件」的两个场景，各一个测试 |

`TEMPLATES` 每一项加 `restore`：`.knit/workflow.yaml` 和两份角色文件是 `true`，`.knit/config.json` 和 `.knit/.gitignore` 是 `false`（项目自己的设置，任何时候都不覆盖）。

`initProject(root, force)`，`force` 为假时和现在完全一样。为真时，按顺序看每一项：

1. `target` 不存在：写上模板的内容，算「生成」。
2. `restore` 是 `false`，或者 `target` 的内容和模板逐字相同：不动，算「没有动」。
3. 其余的（`restore` 是 `true`，内容和模板不一样）：先把 `target` 现在的内容复制到 `<备份目录>/<target>`，再写上模板的内容，算「恢复」。先复制、后覆盖，顺序不能反。

备份目录是 `.knit/.runtime/backups/<时间>/`，`<时间>` 是本机时间的 `YYYYMMDD-HHMMSS-mmm`（最后三位是毫秒）。只在第 3 种情况出现时才建，一次运行只有一个。它在 `.knit/.runtime/` 下：这个目录不入库，对比工作区改动时也不算。

返回值在 `created`、`kept` 之外加 `restored`（`target` 的数组）和 `backupDir`（相对项目根，结尾不带 `/`；没有备份时是 `null`）。

`.knit/standards/` 和 `.knit/tasks/` 里的文件任何时候都不读、不写、不删。

`knit init --force` 的输出在 `已生成:` 之后、`已有，没有动:` 之前加一段，没有恢复任何文件时整段不出现：

```
已恢复成模板:
  .knit/workflow.yaml
  .knit/agents/implement.md
备份: .knit/.runtime/backups/20261116-223045-123/
```

`下一步` 一行在这一次生成或恢复了 `.knit/workflow.yaml` 时有。

有执行者正在跑的时候强制初始化不做检查：角色文件变了，那次执行结束时会被记为失败，重新派发就行。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function initProject" next/src/application/init.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `application/init.ts`、`cli/init.ts`。
4. 写测试。`next/test/init.test.mjs` 不需要改；改了它才能通过就停下报告。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：本任务要求独立审查，由另一个执行者对照完成条件审查；提交由用户另行授权，文案首行建议 `feat(next): restore templates with knit init --force`。

## 完成条件

### Requirement: 强制恢复成模板

#### Scenario: 改过的先备份再恢复

- GIVEN 初始化过的项目：`.knit/workflow.yaml` 和 `.knit/agents/implement.md` 各改过内容，`.knit/agents/review.md` 被删掉
- WHEN 运行 `knit init --force`
- THEN 退出码是 0；三个文件都和模板逐字相同
- AND `.knit/.runtime/backups/` 下只有一个目录，名字是 `YYYYMMDD-HHMMSS-mmm` 的样子，里面只有 `.knit/workflow.yaml` 和 `.knit/agents/implement.md` 两个文件，内容是恢复之前的
- AND 输出依次是 `已生成:` 下的 `.knit/agents/review.md`，`已恢复成模板:` 下的那两个文件和 `备份:` 一行，`已有，没有动:` 下其余的 `target`，最后是 `下一步` 一行
- AND 再运行一次 `knit init --force`：输出只有 `已有，没有动:` 和全部 `target`，`.knit/.runtime/backups/` 下还是只有那一个目录

#### Scenario: 配置、规范和任务不动

- GIVEN 初始化过的项目：`.knit/config.json` 和 `.knit/.gitignore` 各改过内容，`.knit/standards/a.md` 是项目自己写的，用 `knit task new` 建了一个任务
- WHEN 运行 `knit init --force`
- THEN 退出码是 0；这四处（两个文件、规范、任务目录里的文件）逐字没有变
- AND 没有 `.knit/.runtime/backups/` 目录，输出里没有 `已恢复成模板:` 和 `备份:`

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#10-用-knit-开发-knit` — 第 6 条：强制初始化恢复什么、不动什么
- `.knit/tasks/11-14-slim-refactor/design.md#62-角色文件` — 角色文件升级时重新生成，覆盖前备份
- `next/src/application/init.ts` — 要改的文件
- `next/src/cli/init.ts` — 要改的文件
- `next/test/init.test.mjs` — 上一个任务的测试，不改
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-56ff38aef117 -->
- 操作: op-56ff38aef117
- 时间: 2026-11-17T01:00:47.322Z
- 分支: refs/heads/main
- 授权来源: user:a743f72d
- 调用: bridge
- 工作提交: d5fdacae8f53d67e9c1abfa22df1ac9afed99d8f
- 结果: 正常交付；检查 run-1f9f8eb69488 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-16-g3-init-force

### 任务资料提交记录

<!-- knit:metadata-commit:op-56ff38aef117 -->
- 任务资料提交: 6c4c7ea746fa97673aaac813f14804867674f4a7
- 归档目标: .knit/tasks/archive/2026-11/11-16-g3-init-force

<!-- knit:progress:end -->
