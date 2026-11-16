---
id: k-4b35e8771a3e
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-d9b439fae8ac
order: null
createdAt: 2026-11-16T15:19:30.366Z
title: G2 初始化：knit init
---

# G2 初始化：knit init

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。模板已经在 `next/assets/templates/`。本任务做 `knit init`：把模板生成到项目里。已有的文件不动；强制恢复（`--force`）和桥接在后面的任务里做。

做完之后的不同：在一个空目录里运行 `knit init`，接着就能 `knit workflow validate`、`knit task new`。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/init.ts`（新增） | `TEMPLATES` 和 `initProject(root)`，见下 |
| `next/src/cli/init.ts`（新增） | `registerInitCommand(program)`：命令 `knit init`，选项 `--dir <目录>` |
| `next/src/cli/knit.ts`（修改） | 注册这个命令，放在最前面 |
| `next/test/init.test.mjs`（新增） | 见「完成条件」的两个场景，各一个测试 |

`TEMPLATES` 是导出的常量，一项是 `{ template, target }`，顺序固定：

| `template`（相对模板目录） | `target`（相对项目根） |
| --- | --- |
| `workflow.yaml` | `.knit/workflow.yaml` |
| `agents/implement.md` | `.knit/agents/implement.md` |
| `agents/review.md` | `.knit/agents/review.md` |
| `config.json` | `.knit/config.json` |
| `gitignore` | `.knit/.gitignore` |

模板目录用 `new URL("../../assets/templates/", import.meta.url)` 找：编译后的 `next/dist/application/init.js` 往上两级是 `next/`。

`initProject(root)`：建好 `.knit/standards/` 和 `.knit/tasks/` 两个目录（已有就不动）；按顺序看每一项，`target` 不存在就把模板的内容原样写过去（上级目录不存在就建），存在就不动。返回 `{ created, kept }`，各是 `target` 的数组，保持 `TEMPLATES` 的顺序。不写 `AGENTS.md`，不往 `.knit/standards/` 里放任何文件。

`knit init` 的项目根用 `projectRoot(dir)`（`next/src/cli/root.ts`）：在 Git 仓库里是仓库的顶层，否则就是这个目录。不要求 `.knit/` 已经存在。输出，哪一段没有内容就整段不出现：

```
已生成:
  .knit/workflow.yaml
  .knit/agents/implement.md
已有，没有动:
  .knit/config.json
下一步: 在 .knit/workflow.yaml 里写上执行者的模型（model: provider/模型），再运行 knit workflow validate
```

`下一步` 一行只在这一次生成了 `.knit/workflow.yaml` 时有。退出码是 0。

测试里要比对的文件清单从 `next/dist/application/init.js` 导出的 `TEMPLATES` 取，不把五个路径写死：后面的任务还会往里加一项。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `ls next/assets/templates/workflow.yaml` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `application/init.ts`、`cli/init.ts`，在 `cli/knit.ts` 里注册。
4. 写测试：空目录用 `mkdtempSync` 建，测试结束时删除；命令用 `next/test/helpers/cli.mjs` 的 `knit`。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add knit init`。

## 完成条件

### Requirement: 初始化一个项目

#### Scenario: 在空目录里初始化

- GIVEN 一个空的临时目录，不在 Git 仓库里
- WHEN 运行 `knit init`
- THEN 退出码是 0；输出是 `已生成:` 加 `TEMPLATES` 里的每个 `target`，最后是 `下一步` 那一行，没有 `已有，没有动:`
- AND 每个 `target` 的内容和它的模板逐字相同；`.knit/standards/` 和 `.knit/tasks/` 是空目录；项目里没有 `AGENTS.md`
- AND 接着运行 `knit workflow validate` 退出码是 0，`knit task new --title 试一下` 退出码是 0

#### Scenario: 已有的文件不动，缺的补上

- GIVEN 初始化过的项目：`.knit/workflow.yaml` 末尾加了一行注释，`.knit/agents/review.md` 被删掉，`.knit/standards/a.md` 是项目自己写的
- WHEN 再运行一次 `knit init`
- THEN 退出码是 0；`已生成:` 下只有 `.knit/agents/review.md`，`已有，没有动:` 下是其余的 `target`，没有 `下一步` 一行
- AND `.knit/workflow.yaml` 和 `.knit/standards/a.md` 逐字没有变，`.knit/agents/review.md` 和模板相同
- AND 第三次运行时输出只有 `已有，没有动:` 和全部 `target`，文件都没有变

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#2-目录布局` — 项目里有哪些文件
- `.knit/tasks/11-14-slim-refactor/design.md#10-用-knit-开发-knit` — 第 6 条：哪些文件由初始化生成、哪些任何时候都不覆盖
- `next/src/cli/root.ts` — `projectRoot`
- `next/src/cli/knit.ts` — 要改的文件
- `next/src/cli/workflow.ts` — 一个命令文件的写法
- `next/test/helpers/cli.mjs` — `knit`
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
