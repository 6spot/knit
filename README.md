# Knit

轻量项目辅助 CLI。日常由主 Agent 在 Pi 对话中调用，负责项目资料、任务、规范演进、实施／检查、提交归档与恢复。

现有开发已完成 001–060 的实现、复核与阻塞修复，记录保留在[开发历史](https://github.com/6spot/knit/blob/main/docs/history/TASKS.md)，验证依据见 [validation](https://github.com/6spot/knit/tree/main/validation)。Linux 候选安装验收记录已保留；后续真机／真实模型验收按用户决定延期，macOS 完整安装与运行验收仍待进行，当前不声明 macOS 兼容。NPM 发布和外部部署尚未进行。

开发 Agent 从 [AGENTS.md](https://github.com/6spot/knit/blob/main/AGENTS.md) 和[文档索引](https://github.com/6spot/knit/blob/main/docs/README.md)开始。后续正式任务由本仓库的 Knit 管理，用 `npx --no-install knit task list` 查询；用户决定是否建任务，各任务的 `task.md` 保存需求与业务状态。旧编号任务保留为历史档案。

设计入口：[产品规范](https://github.com/6spot/knit/blob/main/docs/design/DESIGN.md)、[架构](https://github.com/6spot/knit/blob/main/docs/design/ARCHITECTURE.md)、[状态](https://github.com/6spot/knit/blob/main/docs/design/STATES.md)、[技术选型](https://github.com/6spot/knit/blob/main/docs/design/TECHNOLOGY.md)、[运行规则](https://github.com/6spot/knit/blob/main/docs/design/OPERATIONS.md)与[术语](https://github.com/6spot/knit/blob/main/docs/design/GLOSSARY.md)。研究依据见 [RESEARCH.md](https://github.com/6spot/knit/blob/main/docs/research/RESEARCH.md)。

```text
AGENTS.md          本仓库的开发协作入口
src/               CLI、契约、领域、用例、适配与基础设施
assets/templates/  init 模板：项目资料与薄桥接
test/              单元与隔离集成测试
scripts/           构建与打包检查
.knit/             当前任务、工作流、规范与受管运行资料
.pi/extensions/    项目级 Pi 桥接
docs/
  README.md        文档导航
  design/          现行产品规范、架构、状态与运行规则
  research/        研究依据与后续设计
  history/         旧任务索引、阻塞与 001–060 执行记录
validation/        可追溯研究、实验与验收材料
```

安装（候选包尚未发布）：

```text
npm pack
npm install ./knit-0.1.0.tgz
./node_modules/.bin/knit init --client pi --dir <项目>
./node_modules/.bin/knit start --dir <项目>
```

候选包当前为 `private: true`，未附 LICENSE；公共 npm 发布前需确认名称／scope、版本和许可证。

首版不实现 Worktree、REX、其它 Agent 客户端、并行调度或对外插件平台。不依赖 Pi SDK，阶段执行直接复用本机 Pi CLI。Linux + Node 24 + Pi 1.4.0 已完成本地 `npm pack` 安装／init／start 冒烟；后续客户端兼容与回归证据按 [validation](https://github.com/6spot/knit/tree/main/validation) 中的实际范围解读。
