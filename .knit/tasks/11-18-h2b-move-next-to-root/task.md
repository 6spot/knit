---
id: k-f77e261cf257
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-e281f44cdf86
order: null
createdAt: 2026-11-17T16:34:05.357Z
title: H2b 新代码移到根目录：next/ 的 src、test、assets 移上来，脚本和路径跟着改
---


# H2b 新代码移到根目录：next/ 的 src、test、assets 移上来，脚本和路径跟着改

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`。上一个任务（H2a `k-e281f44cdf86`）删掉了根目录的旧代码，本任务在它提交之后做：把新代码移到根目录，让 `npm test`、`npm run build`、打包和安装用的都是新代码。分成两个任务的原因见 H2a：新旧代码有 34 个文件同名，删和移分开提交，`git blame` 才归到当初写每一行的提交。

做完之后的不同：没有 `next/` 目录；`npm test` 构建并测试新代码；`npm run pack:install` 装出来的是新的 Knit。

产出：

| 路径 | 做成什么样 |
| --- | --- |
| `next/src`、`next/test`、`next/assets` | 移到 `src`、`test`、`assets`，文件内容除下面点名的几行以外不变 |
| `next/tsconfig.templates.json` | 移到 `tsconfig.templates.json`，`extends` 改成 `./tsconfig.json` |
| `next/tsconfig.json` | 删除：根目录的 `tsconfig.build.json` 做同一件事 |
| `package.json` | `scripts` 换成：`typecheck`（`tsc --noEmit`）、`build`（`rm -rf dist && tsc -p tsconfig.build.json && chmod +x dist/cli/knit.js`）、`test`（`npm run -s build && node --test "test/*.test.mjs"`）、`pack:check`、`pack:install`、`prepack`（这三项和删除之前一样）；`build:next`、`test:next` 删掉 |
| `tsconfig.build.json` | 去掉 `declaration`：新代码不当库用，原来的 `next/tsconfig.json` 也不生成声明文件 |
| `.gitignore` | 去掉 `/next/dist/` |
| `src/cli/knit.ts` | 读 `package.json` 的相对路径少一级（`../../package.json`），注释跟着改 |
| `src/application/init.ts` | 只改注释里的路径 |
| `test/cli.test.mjs`、`test/bridge-task.test.mjs` | 指向根目录 `package.json`、`node_modules` 的相对路径少一级 |
| `test/helpers/cli.mjs`、`test/helpers/bridge.mjs` | 只改注释里的路径 |
| `scripts/pack-check.mjs` | 必须在包里的文件换成新代码的：`assets/templates/workflow.yaml`、`assets/templates/pi/extensions/knit.ts`、`dist/adapters/pi/pane-worker.js`、`dist/cli/knit.js` |
| `validation/slim-h1-2026-11/setup.sh`、`README.md` 的「怎么重跑」 | `next/dist` 改成 `dist`，`npm run test:next` 改成 `npm test` |
| `validation/slim-rex-2026-11/no-model.sh`、`rex-flow.sh`、`README.md` 的「怎么重跑」 | `build:next` 改成 `build`，假 Pi 的路径改成 `test/helpers/fake-pi.mjs` |

`build` 里的 `chmod +x`：`tsc` 生成的文件没有执行位。实际试过，`npm install -g` 会给 `bin` 指到的文件加上执行位，所以装出来的能用；加这一步是让仓库里的 `dist/cli/knit.js` 也能直接运行，`scripts/pack-check.mjs` 有一条检查它。

步骤：

1. 确认 H2a 已经提交：`git ls-files src test assets` 没有输出。
2. `mv next/src src && mv next/test test && mv next/assets assets && mv next/tsconfig.templates.json tsconfig.templates.json && rm -rf next`
3. 按上表改其余的文件。
4. 运行「验证」里的命令。

不能动的：

- 移过来的文件里，上表没有点名的行：本任务只移动和改路径，不借机改代码。测试里当作样例数据出现的 `next/src/a.ts` 之类的字符串不是真的路径，不改。
- `validation/slim-h1-2026-11/README.md`、`validation/slim-rex-2026-11/README.md` 里「怎么重跑」以外的部分和两个 `logs/`：它们记的是当时的情况（当时 `knit` 指到 `next/dist`）。
- `README.md`、`AGENTS.md`、`docs/`：分别在 H4、H5 改。
- `.knit/`（除本任务的资料）、`.pi/extensions/knit.ts`：还是旧 Knit 的，换成新的是 H3。旧桥接启动时会比较安装版和仓库里 `dist/cli/knit.js` 的内容，不一样就提示一次“改用本地 dist”；这只是一条提示，不要照做，H3 之前都会有。
- 不运行 `npm run pack:install`（它会把新 Knit 装到全局位置，替换掉正在管理本仓库任务的旧 Knit；那是 H3 的事）。要试安装就用 `--prefix` 装到临时目录。
- 不加依赖，不提交、不推送。

验证：

- `npm test`：通过，输出里 `tests 221`、`fail 0`。它会先删掉再生成 `dist`，不要同时运行两次。
- `npm run typecheck`、`npx tsc -p tsconfig.templates.json`：退出码都是 0。
- `npm run pack:check`：最后一行是 `pack 检查通过`。
- `test ! -e next`；`git status --short` 里没有 `next/dist`。
- `grep -rnE "next/(dist|assets|test|tsconfig)|test:next|build:next" src test assets scripts package.json tsconfig*.json .gitignore validation/slim-rex-2026-11/*.sh validation/slim-h1-2026-11/*.sh validation/slim-h1-2026-11/*.mjs`：没有输出。
- 装到临时目录试一次：`npm pack` 之后 `npm install -g --prefix <临时目录> ./knit-0.1.0.tgz`，再用 `<临时目录>/bin/knit` 在一个空目录里运行 `--version`、`init`、`workflow validate`，退出码都是 0。做完把仓库里新生成的 `knit-0.1.0.tgz` 换回原来那份（原来那份是旧 Knit 的安装包，先备份）。
- `git diff -M --stat HEAD`：`next/` 下的文件都显示为移动；有内容变化的只有上表点名的文件。
- `pgrep -fl "fake-pi|fake-rex|run worker|run wait"`：没有输出。

审查时请特别看：

- 移过来的文件有没有上表之外的内容变化。
- 还有没有指向 `next/` 的真路径。
- 包里的文件对不对：模板、`dist/adapters/pi/pane-worker.js`（Rex 窗格里的 Pi 要加载它）都在，没有带进源码、测试和任务资料。

做完之后：本任务要求独立审查；提交由用户另行授权，文案首行建议 `chore: move the new code to the repository root`。之后是 H3（在本仓库装上新 Knit、换桥接和模板、把没结束的任务转成新格式）。

## 完成条件

### Requirement: 新代码在根目录构建、测试、打包

#### Scenario: 测试在根目录跑

- GIVEN H2a 提交之后的工作区
- WHEN 运行 `npm test`
- THEN 输出里 `tests 221`、`fail 0`
- AND `npm run typecheck` 和 `npx tsc -p tsconfig.templates.json` 的退出码是 0
- AND 仓库里没有 `next/`

#### Scenario: 打包出来的能安装、能运行

- GIVEN 同上
- WHEN 运行 `npm run pack:check`
- THEN 最后一行是 `pack 检查通过`
- AND 把包装到一个临时目录之后，那里的 `knit --version` 输出 `0.1.0`，在空目录里 `knit init` 和 `knit workflow validate` 的退出码是 0

#### Scenario: 只是移动

- GIVEN 同上
- WHEN 运行 `git diff -M --stat HEAD`（改动加进暂存区之后看）
- THEN `next/src`、`next/test`、`next/assets` 下的文件都显示为移动到 `src`、`test`、`assets`
- AND 内容有变化的移动文件只有 `src/cli/knit.ts`、`src/application/init.ts`、`test/cli.test.mjs`、`test/bridge-task.test.mjs`、`test/helpers/cli.mjs`、`test/helpers/bridge.mjs`、`tsconfig.templates.json`

## 待澄清

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#14-重写怎么进行` — 切换的做法
- `.knit/tasks/11-14-slim-refactor/plan.md` — 子任务清单，H 段
- `package.json` — 脚本
- `tsconfig.json`、`tsconfig.build.json` — 根目录的构建配置
- `scripts/pack-check.mjs` — 打包检查
- `scripts/pack-install.mjs` — 打包安装，不改，本任务不运行
- `validation/slim-h1-2026-11/setup.sh` — 演练用它建临时项目，里面写着 `next/dist`
- `validation/slim-rex-2026-11/no-model.sh` — 用到假 Pi 的路径

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-17T16:39:27.631Z
- 方式: self → independent

### 交付记录

<!-- knit:delivery:op-e22047b3b266 -->
- 操作: op-e22047b3b266
- 时间: 2026-11-17T23:21:00.997Z
- 分支: refs/heads/main
- 授权来源: user:sha256:3ac62bbe35c0a373
- 调用: bridge
- 工作提交: 1dc1e153e2cb2a27aa50e1fff336c699c6bf60bb
- 结果: 正常交付；检查 run-e8a1d4aa4d90 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-18-h2b-move-next-to-root

<!-- knit:progress:end -->
