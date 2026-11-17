---
id: k-e281f44cdf86
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-17T16:34:04.484Z
title: H2a 删除旧代码：旧的 src、test、assets 和只有旧代码用的脚本
---


# H2a 删除旧代码：旧的 src、test、assets 和只有旧代码用的脚本

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心。新代码在 `next/`（`next/src` 48 个文件 5,465 行、`next/test` 63 个文件、`next/assets` 6 个文件），已经能走完一个任务的全过程，并在真的 Pi 和真的 Rex 里演练过（`validation/slim-h1-2026-11/`、`validation/slim-rex-2026-11/`）。旧代码在根目录的 `src/`、`test/`、`assets/`，重写期间一直没有动。用户 2026-11-17 决定现在删（「我们先删代码，修复的问题，等我确认之后你再修复。」「继续。」）。

本任务只删旧代码。把 `next/` 移到根目录是下一个任务（H2b `k-f77e261cf257`）。分成两个任务是因为新旧代码有 34 个文件同名（例如 `src/cli/run.ts` 和 `next/src/cli/run.ts`）：在一份克隆里试过，删和移放在同一次提交里时，Git 把这些文件当成“改了旧文件”，`git blame src/cli/run.ts` 的 252 行里有 217 行归到那一次提交，`git log --follow` 接到旧文件的历史上；先提交删除、再提交移动时，每一行都归到当初写它的提交。

做完之后的不同：仓库里没有旧代码；`npm test`、`npm run build` 这些旧脚本没有了，在 H2b 做完之前只有 `npm run test:next` 和 `npm run build:next`。

产出：

| 路径 | 做成什么样 |
| --- | --- |
| `src/`（139 个文件）、`test/`（63 个）、`assets/`（9 个） | 删除，共 211 个文件、78,997 行 |
| `scripts/build-bridge-schema.mjs` | 删除：它从旧代码的 `dist/contracts/bridge-tools.js` 生成一份 JSON，新代码没有这个文件 |
| `package.json` | `scripts` 里删掉 `typecheck`、`build`、`test`、`pack:check`、`pack:install`、`prepack` 六项（它们构建和测试的是旧代码），留下 `build:next`、`test:next`；别的字段不动 |

步骤：

1. `rm -rf src test assets scripts/build-bridge-schema.mjs`
2. 改 `package.json`，只删上面六行。
3. 运行「验证」里的命令。

不能动的：

- `next/` 下的所有文件：本任务只删，不移，这样删除单独是一次提交。
- `scripts/pack-check.mjs`、`scripts/pack-install.mjs`、`tsconfig.json`、`tsconfig.build.json`、`.gitignore`：H2b 接着用，在那里改。这期间 `tsconfig.json` 的 `include` 指着不存在的 `src`，没有命令用到它（`next/tsconfig.json` 自己写了 `include`）。
- `README.md`、`AGENTS.md`、`docs/`：它们讲的还是旧代码，分别在 H4、H5 改。
- `.knit/`（除本任务的资料）、`.pi/extensions/knit.ts`：本仓库的任务现在由安装在仓库外面的旧 Knit 管理（`.knit/.runtime/installation.json` 的 `cliEntry` 指向它），桥接也是它的；换成新的是 H3。删掉仓库里的旧代码不影响它。
- `validation/` 里 `slim-` 开头的两个目录以外的记录：其中一些脚本导入旧代码构建出来的 `dist/`（例如 `validation/metadata-storage/fixture/scenarios.mjs`、`validation/audit-fix-verification/lock-reentry.mjs`），旧代码删掉、`dist/` 换成新代码之后不能重跑。它们是旧实现的历史记录，不改，也不删。
- `dependencies`、`devDependencies` 和 `package-lock.json`：`commander`、`yaml`、`@earendil-works/pi-schema` 新代码都在用。
- 被 Git 忽略的本机文件 `dist/`（旧代码上一次构建出来的）和 `knit-0.1.0.tgz`（旧 Knit 的安装包，要退回旧 Knit 时用它重装）：留着。
- 不加依赖，不提交、不推送。

验证：

- `ls -d src test assets scripts/build-bridge-schema.mjs`：四个都报不存在。
- `git ls-files -- src test assets scripts/build-bridge-schema.mjs | wc -l` 和 `git ls-files --deleted -- src test assets scripts/build-bridge-schema.mjs | wc -l`：都是 212，也就是 Git 里记着的这些文件在工作区里全都删了。本任务不暂存、不提交，所以 `git ls-files` 这时还列着它们；提交之后它没有输出，由主会话在提交之后核对。
- `git status --short | grep -v '^ D \(src\|test\|assets\)/'`：只有 ` D scripts/build-bridge-schema.mjs`、` M package.json` 和 `.knit/tasks/` 下的任务资料。其中 `.knit/tasks/11-14-slim-refactor/plan.md` 的改动是主任务的清单（记下 H2 的登记和几个待修的问题），主会话改的，不是本任务的成果，单独提交。
- `git diff -- package.json`：只删了六行。
- `npm run test:next`：通过，输出里 `tests 221`、`fail 0`。开始前也是 221 个：上一个任务 R1 交付时记的数，见 `.knit/tasks/11-14-slim-refactor/plan.md` 的 H 段。这条命令会先删掉再生成 `next/dist`，不要同时运行两次。
- `npx tsc -p next/tsconfig.templates.json`：退出码 0。
- `grep -rnE '\.\./\.\./(src|assets|test|scripts)/' next/src next/test next/assets`：只有一行，`next/src/application/init.ts` 里的 `../../assets/templates/`。它编译之后在 `next/dist/application/`，往上两级是 `next/`，指的是 `next/assets`，不是被删掉的 `assets`。新代码没有引用旧代码的实际依据是上面的测试在旧代码删掉之后照样通过。
- `pgrep -fl "fake-pi|fake-rex|run worker|run wait"`：没有输出。

审查时请特别看：

- 新代码、新测试、两份演练脚本有没有用到被删掉的文件。
- 被删掉的文件在工作区里已经没有了，要看内容用 `git show HEAD:<路径>`（例如 `git show HEAD:scripts/build-bridge-schema.mjs`），清单用 `git ls-tree -r --name-only HEAD -- src test assets`。
- 被删掉的东西里有没有新代码没有、而 `.knit/tasks/11-14-slim-refactor/design.md` 第 11 节又没有写明“不做”或“延后”的。第一次审查（`run-60ee8e39b4a1`）提了六项，主会话逐项核对过，结果记在 `plan.md` 的 H 段「H2a 第一次审查」一条里，不用重复提：`task search` 在第 12 节和 `plan.md` 的「之后」里写着切换之后再做；失败残留继承、历史成果复核、归档任务历史分类分别属于第 11 节已经写明不做的「改动来源归属」「分支绑定、adopt、rebind」和本机数据库；非正式检查（`run check --scope`）和“审查通过之后成果又变了就不让交付”这两项第 11 节确实没有点名，已经记下来等用户决定。这两项的旧实现建在已经决定不做的部分上（绑定、成果范围、检查凭据），搬不过来，要的话得在新代码上重写，所以不影响现在删。
- `package.json` 有没有多删或少删。

做完之后：本任务要求独立审查；提交由用户另行授权，文案首行建议 `chore: delete the old code`。提交之后做 H2b。

## 完成条件

### Requirement: 旧代码删掉，新代码不受影响

#### Scenario: 旧代码不在了

- GIVEN 本仓库的工作区（改动没有暂存、没有提交）
- WHEN 运行 `ls -d src test assets scripts/build-bridge-schema.mjs`
- THEN 四个都报不存在
- AND `git ls-files -- src test assets scripts/build-bridge-schema.mjs | wc -l` 和加上 `--deleted` 的结果都是 212
- AND `package.json` 的 `scripts` 只有 `build:next` 和 `test:next` 两项，别的字段和原来一样

#### Scenario: 新代码照常构建和测试

- GIVEN 同上
- WHEN 运行 `npm run test:next`
- THEN 输出里 `tests 221`、`fail 0`
- AND `npx tsc -p next/tsconfig.templates.json` 的退出码是 0
- AND `git status --short -- next` 没有输出

## 待澄清

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#14-重写怎么进行` — 切换的做法
- `.knit/tasks/11-14-slim-refactor/design.md#11-不做与延后` — 旧代码里哪些功能不搬、哪些以后再做
- `.knit/tasks/11-14-slim-refactor/plan.md` — 子任务清单，H 段
- `package.json` — 要改的脚本
- `next/tsconfig.json` — 新代码的构建配置，自己写了 `include`
- `validation/slim-h1-2026-11/README.md` — 新代码用真的 Pi 走完一个任务的记录

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-17T16:39:27.025Z
- 方式: self → independent

### 交付记录

<!-- knit:delivery:op-d7638fdb4c3b -->
- 操作: op-d7638fdb4c3b
- 时间: 2026-11-17T22:55:52.250Z
- 分支: refs/heads/main
- 授权来源: user:sha256:83b5b2f881dbf55e
- 调用: bridge
- 工作提交: d2ab336bae538eca434ce4fdc32b583159370da1
- 结果: 正常交付；检查 run-be7e07daaa99 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-18-h2a-delete-old-code

<!-- knit:progress:end -->
