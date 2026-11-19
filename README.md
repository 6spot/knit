# Knit

Knit 管一个项目的开发周期，只做五件事：把一件事写成任务的需求和可验证的完成条件，记录做到哪一步、结果如何；保存项目的开发规范，按环节交给智能体；派执行者做某个环节时，只给它这个环节需要的内容；用户授权后归档任务，项目在 Git 仓库里时再把这个任务的改动提交成一次提交；接入 Pi，在主会话里提供少量工具和一小段每轮状态。

## 现在的情况

2026-11 重写成了小核心：旧实现的设计和记录在 [docs/history/](https://github.com/6spot/knit/tree/main/docs/history)，只支持 Pi，还没有发布到 NPM（`private: true`，没有 LICENSE）。平台的验证情况见 [AGENTS.md](https://github.com/6spot/knit/blob/main/AGENTS.md)。

## 安装

从源码一键打包安装（需要 Node.js >=24 和 npm）：

```sh
npm run pack:install
knit --version
```

在仓库根目录执行。脚本先通过 `npm ci --include=dev` 按锁文件重新安装依赖，再由 `npm pack` 的 `prepack` 构建，生成并保留根目录的 `knit-<版本>.tgz`，最后从 tgz 安装到 npm 全局位置并校验安装版本。需要下载依赖；任一步失败会停止并返回非零退出码。重复执行会更新该位置已安装的 Knit。`knit init` 不带 `--force` 时只补上没有的文件，已有的不动；`knit init --force` 只重新生成桥接、`workflow.yaml` 和角色文件，覆盖前把和模板不一样的文件备份到 `.knit/.runtime/backups/<时间>/`，`config.json`、`standards/` 和 `tasks/` 任何时候都不覆盖。

指定安装位置（例如使用用户目录，避免全局目录权限问题）：

```sh
npm run pack:install -- --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
knit --version
```

默认安装也需要 npm 全局命令目录在 `PATH` 中；脚本完成后会打印安装入口。此脚本安装 Knit CLI；运行 Pi 前还需安装并配置本机 Pi CLI。

只打包或在其它项目中局部安装时，可继续使用：

```sh
npm ci --include=dev
npm pack
# 在目标项目目录中执行，路径替换为生成的 tgz
npm install /path/to/knit-0.1.0.tgz
./node_modules/.bin/knit --version
```

## 开始用

1. `knit init`：把流程、角色文件、配置和通用规范生成到项目里，已有的文件不动。
2. 在 `.knit/workflow.yaml` 里写 `model`：写 `provider/模型`，所有环节缺省用它。
3. `knit workflow validate`：校验流程文件，有问题时逐条给出行号。
4. 在项目里打开 Pi 并同意加载项目扩展：主会话就有 `knit_task`、`knit_run`、`knit_deliver` 三个工具。

## 命令

```text
knit init                        把流程、角色文件、配置和通用规范生成到项目里；已有的文件不动
knit workflow show               显示流程和每个环节的配置
knit workflow validate           校验流程文件，有问题时逐条给出行号
knit task new                    创建一个任务
knit task list                   列出任务（--archive 改列已归档的任务）
knit task show <id>              显示一个任务的情况
knit task ready <id>             确认一个任务的需求
knit task close <id>             把一个任务记为完成，并写下结果
knit task cancel <id>            取消一个任务并归档
knit standards list              列出规范和各自适用的环节，标出不会注入的
knit run start <id>              派发任务的下一个环节；执行者在后台跑，命令立即返回
knit run status <id>             显示任务上一次或正在跑的执行，以及下一步
knit run wait <id>               等任务正在跑的执行结束，然后显示和 status 一样的内容；没有执行在跑时立即返回
knit run cancel <id>             停掉任务正在跑的执行，记为失败；后台进程已经不在的也用它记为失败
knit context <id>                主会话每轮收到的内容：任务的状态、下一步和当前环节的规范
knit deliver <id>                交付一个完成的任务：归档；项目在 Git 仓库里时再提交一次
knit help                        显示帮助
```

## 仓库里有什么

```text
AGENTS.md          开发协作入口
src/               CLI、契约、领域、用例、适配与基础设施
assets/templates/  knit init 的模板：流程、角色文件、通用规范与 Pi 桥接
test/              单元测试与隔离集成测试
scripts/           构建、打包检查与本地安装
.knit/             当前任务、流程配置、规范与运行资料
.pi/extensions/    项目级 Pi 桥接
docs/
  README.md        文档索引
  design/          现行设计
  history/         旧 Knit 的设计、任务索引和执行记录
  research/        研究依据
validation/        验证材料：slim-* 是现在这个 Knit 的，其余是旧 Knit 的
```

## 接着读

- [AGENTS.md](https://github.com/6spot/knit/blob/main/AGENTS.md)：开发协作入口。
- [docs/README.md](https://github.com/6spot/knit/blob/main/docs/README.md)：文档索引。
- [docs/design/DESIGN.md](https://github.com/6spot/knit/blob/main/docs/design/DESIGN.md)：现行设计。
