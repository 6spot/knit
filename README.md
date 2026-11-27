# Knit

Knit 管一个项目的开发周期。它记录任务的需求、可验证的完成条件和进度，保存并按环节提供项目规范，为执行者准备当前环节所需的资料，在主会话里提供项目上下文和任务操作入口。用户授权交付后，Knit 归档任务，项目使用 Git 时再把该任务的改动提交成一次提交。

## 现在的情况

2026-11 重写为小核心。主会话已接入 Pi、Antigravity CLI 和 WorkBuddy Desktop，工作流可派发 Pi 或 Antigravity CLI。项目尚未发布到 NPM（`private: true`），目前没有 LICENSE。[平台验证记录](https://github.com/6spot/knit/blob/main/docs/README.md#验证记录)

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

1. 在项目里运行 `knit init` 生成核心文件。首次启用主会话桥接时，按客户端运行 `knit init --pi`、`knit init --agy` 或 `knit init --workbuddy`。选项可以组合。
2. 在 `.knit/workflow.yaml` 的环节用 `agent` 指定执行者。Pi 的 `model` 写成 `provider/模型`，`thinking` 可取 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。派发时分别取命令行覆盖、环节或执行器、流程顶层、主会话中首个有值的设置。Antigravity 使用自己的模型 ID，模型及思考等级取命令行覆盖或环节、执行器配置，缺省时由 `agy` 决定。
3. 运行 `knit workflow validate` 校验流程文件，有问题时逐条给出行号。首次接入、换机器或升级客户端后，可运行 `knit workflow validate --env` 一次查看 Node、项目配置、Git 初始提交和流程所用执行者的派发条件。
4. 在选定的客户端打开项目。Pi 加载项目扩展后提供 `knit_task`、`knit_run`、`knit_deliver` 三个工具，Antigravity 和 WorkBuddy 通过项目钩子与 CLI 接入。主会话从第一轮起即可按 `discuss` 规范讨论需求。什么时候建任务、怎么确认需求和开始实施，按内置讨论规范处理。新建的任务是草稿，不改变当前选择。

讨论、任务编写、任务拆分和交付四份规范由当前 Knit 安装包提供，升级即可生效。`knit standards list` 列出 `knit:standards/` 标识的内置规范，以及 `.knit/standards/` 下的项目规范。旧版 `init` 生成的同名文件会保留并标为停用，可将其中的团队约定迁入另名的项目规范。

项目避坑清单用一个文件 `.knit/standards/pitfalls.md`。二级标题 `## 通用` 对所有环节生效，`## implement, review` 对列出的环节生效。每条经验用三级标题。主会话和执行者只收到通用和当前环节的条目。

派发 Pi 执行者时，主会话的模型从 `PI_PROVIDER`、`PI_MODEL` 读取，思考等级从 `PI_REASONING_LEVEL` 读取；桥接的 start 则从当前的 `ctx.model`、`ctx.thinkingLevel` 取值。不在 Pi 会话里时，要在流程里配置模型或加 `--model`，思考等级仍可不指定。Pi 会按模型能力收窄思考等级。

## 命令

```text
knit init                        生成项目的流程、角色文件和配置
knit workflow show               显示流程和每个环节的配置
knit workflow validate           校验流程文件，有问题时逐条给出行号
knit workflow validate --env     流程有效后只读检查本机派发环境，列出问题和修复建议
knit task new                    创建一个任务
knit task list                   列出任务（--archive 改列已归档的任务）
knit task show <id>              显示一个任务的情况
knit task ready <id>             确认一个任务的需求
knit task close <id>             把一个任务记为完成，并写下结果
knit task cancel <id>            取消一个任务并归档
knit standards list              列出内置规范、项目规范、避坑分区和旧版副本
knit standards pitfalls <stage>   查看通用区和适用于该环节的避坑条目
knit standards record --section <分区> --title <标题> --body <正文>    新增或补充条目
knit run start <id>              派发任务的下一个环节；执行者在后台跑，命令立即返回
knit run status <id>             显示任务上一次或正在跑的执行，以及下一步
knit run wait <id>               等任务正在跑的执行结束，然后显示和 status 一样的内容；没有执行在跑时立即返回
knit run cancel <id>             停掉任务正在跑的执行，记为失败；后台进程已经不在的也用它记为失败
knit context [id]                每轮的讨论规范；指定任务时追加状态、下一步和当前环节的补充规范
knit deliver <id>                交付一个完成的任务：归档；项目在 Git 仓库里时再提交一次
knit help                        显示帮助
```

`knit run start <id> [--model <模型>] [--thinking <等级>]` 可以覆盖这一次派发的设置。Pi 桥接工具 `knit_run` 的 `start` 对应参数是 `model`、`thinking`。`knit workflow show` 按环节显示执行者、模型和思考等级。

## 仓库里有什么

```text
AGENTS.md          开发协作入口
src/               CLI、契约、领域、用例、适配与基础设施
assets/standards/  安装包内置的四份通用规范
assets/templates/  knit init 的流程、角色、配置和各宿主桥接模板
test/              单元测试与隔离集成测试
scripts/           构建、打包检查与本地安装
.knit/             当前任务、流程配置、规范与运行资料
.pi/extensions/    项目级 Pi 桥接
docs/
  README.md        文档索引
  design/          现行设计
  research/        研究依据
validation/        流程演练、平台验证与客户端接入记录
```

## 接着读

- [AGENTS.md](https://github.com/6spot/knit/blob/main/AGENTS.md)：开发协作入口。
- [docs/README.md](https://github.com/6spot/knit/blob/main/docs/README.md)：文档索引。
- 新增主会话宿主或执行者时，按角色查阅接入流程和验收场景。[Agent 接入规范](https://github.com/6spot/knit/blob/main/docs/AGENT-INTEGRATION.md)
- [docs/design/DESIGN.md](https://github.com/6spot/knit/blob/main/docs/design/DESIGN.md)：现行设计。
