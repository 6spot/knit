---
id: k-178c6368f30b
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-14T16:22:15.007Z
title: A1 固定安装版：桥接改用仓库外的 Knit
---

# A1 固定安装版：桥接改用仓库外的 Knit

## 目标与范围

背景：本仓库用 Knit 管理自己的开发任务。Pi 主会话里的桥接（`.pi/extensions/knit.ts`）通过 `.knit/.runtime/installation.json` 的 `cliEntry` 找到要调用的 Knit，现在它指向仓库里的 `dist/cli/knit.js`。`npm test` 每次先删掉 `dist` 再重建，重构期间旧代码还会被删除，所以要改为调用一份装在仓库外、不随工作区变化的 Knit。

产出：全局安装的 Knit 更新到当前提交；`installation.json` 的 `cliEntry` 指向它。两样都不入库，本任务没有任何进入 Git 的改动。

前置条件：

- 在运行 Pi 主会话、管理本仓库任务的那台机器的检出里执行。确认方法：`ls .knit/.runtime/installation.json` 有这个文件。全局安装和这个文件都只存在于那台机器上，在别的克隆里执行不会产生效果。
- 全局安装需要用户同意，开始前确认用户已经同意。
- Node 24 以上（`node --version`），能联网（安装脚本会运行 `npm ci`）。
- 没有正在进行的执行：`knit run list` 里没有活动的条目。

步骤：

1. 记下现状：`git status --short` 的输出、`git rev-parse --short HEAD` 的提交号、`cat .knit/.runtime/installation.json` 的内容。
2. 在仓库根目录运行 `npm run pack:install`。它依次做三件事：`npm ci`、打包（会自动构建）、把包全局安装。根目录会留下一个 `knit-0.1.0.tgz`，已被 Git 忽略。
3. 运行 `npm root -g` 得到全局安装目录，确认 `<该目录>/knit/dist/cli/knit.js` 存在。
4. 在仓库根目录运行 `knit init --check`，确认计划里没有要覆盖的项目文件；然后运行 `knit init`。不加 `--force`：加了会覆盖本仓库的 `config.json` 和流程文件。
5. 按下面的「验证」核对。
6. 收尾：`knit task ready k-178c6368f30b`，再 `knit task close k-178c6368f30b --outcome completed --no-artifacts --reason "<提交号、安装目录、验证结果>"`。被拒绝时照拒绝信息处理；同一原因被拒两次就停下报告。

不能动的：

- `.pi/extensions/knit.ts` 和 `assets/templates/` 下的桥接模板：两份由测试逐字比对，本任务不需要改它们。
- `.knit/config.json`、`.knit/workflow.yaml`、`.knit/agents/`：本仓库自己的配置，不能被模板覆盖。
- `src/`、`test/`：本任务不改代码。

验证：

- `cat .knit/.runtime/installation.json`：`cliEntry` 是第 3 步那个路径，不在仓库目录下。
- 运行 `rm -rf dist`，然后在 Pi 主会话里调用 `knit_task` 的 list，能正常返回任务列表。之后运行 `npm run build` 把 `dist` 恢复。
- `git status --short` 的输出和第 1 步记下的一致。不一致时停下报告多出来的改动，不自行还原。

已知影响：

- 桥接在每个新会话里会提示一次“桥接指向仓库外的安装”；旧代码再有改动后，还会提示安装版与本地 dist 的摘要不一致。两个提示都是预期的。
- 之后对 `src/` 的修改不会自动生效，要重新运行第 2 步。

撤回：在仓库根目录运行 `npm run build && node dist/cli/knit.js init`，`cliEntry` 回到仓库的 `dist`。

## 完成条件

- `installation.json` 的 `cliEntry` 指向仓库外的安装目录。
- 删掉仓库的 `dist` 之后，桥接的 `knit_task` list 仍正常返回。
- `git status --short` 里没有因本任务新增的改动。
- 收尾的说明里写明安装版对应的提交号和安装目录。

## 相关资料

- `scripts/pack-install.mjs` — 安装脚本
- `.pi/extensions/knit.ts` 第 426–475 行 — 桥接怎么找 Knit、什么时候提示
- `src/application/initialization.ts` 第 375–400 行 — `knit init` 怎么写 `installation.json`
- `.knit/tasks/11-14-slim-refactor/design.md` 第 10 节 — 用 Knit 开发 Knit

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-a7de18870b47 -->
- 操作: op-a7de18870b47
- 时间: 2026-11-15T05:17:33.617Z
- 分支: refs/heads/main
- 授权来源: user:467caa51
- 调用: bridge
- 工作提交: 无
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-a1-pin-installed-cli

### 任务资料提交记录

<!-- knit:metadata-commit:op-a7de18870b47 -->
- 任务资料提交: e278772e09f5ea413fc5a5387620c5c2dbc003e7
- 归档目标: .knit/tasks/archive/2026-11/11-15-a1-pin-installed-cli

<!-- knit:progress:end -->
