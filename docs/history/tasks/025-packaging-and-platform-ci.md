# 025 完成平台、打包和使用文档

- 里程碑：M3B
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[024 完成私有诊断并验收日常使用](024-developer-mode-m3a-gate.md)
- 实际依赖：[001](001-engineering-baseline.md)、[008](008-project-initialization.md)、[015](015-cli-bridge-m1-gate.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

形成可在目标平台安装验证的候选包和准确使用说明。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [TECHNOLOGY.md](../../design/TECHNOLOGY.md)：第1、6节。
- [DESIGN.md](../../design/DESIGN.md)：第15–16节。
- [AGENTS.md](../../../AGENTS.md)：范围、授权及提交约束。

## 实施范围

- 完成macOS/Linux与Node24相同补丁组合的构建／测试／打包矩阵；必要CI仅创建配置文件，不自动push触发外部操作。
- 验证npm pack本地安装、bin/worker/模板/协议资源和init/start；检查安装位置变化及升级入口。
- 更新根README和使用文档，说明当前真实支持能力、原生客户端条件、任务／规范／恢复和限制。
- 从包中排除validation、开发任务、私有原生历史、日志、凭据和测试工作目录；保留合理许可证／资源。

## 交付物

- 候选包、平台矩阵和安装／操作文档
- 实际包文件清单与本地安装证据

## 完成前必须验证

- 可用平台实际跑过才标通过；另一平台未执行时如实blocked，不靠CI文件存在声称兼容。
- 目标Node24组合通过；其它Node不作自动降级替代，发布包没有全局Pi SDK或临时绝对路径。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不npm publish、部署、push或创建外部发布；未获明确授权不更改当前Git历史。
- 保留现有工作区和前置任务记录；不自动提交／推送当前仓库，不操作其它真实仓库，不初始化当前工程的产品 .knit/ 或 .pi/。
- 本文件是开发排程，不是Knit产品Task；文件任务不预定产品元数据后端。

## 阻塞时的伪代码交接

遇阻塞先保留已做工作，按 [BLOCKERS.md](../BLOCKERS.md) 记录后继续其它可做任务。未定部分可写伪代码／暂定接口供下游开发，但不能当真实实现或验收成功。

- 关联阻塞编号：无；发生后引用真实编号。
- 未实现部分与影响：尚无记录。
- 暂定输入／输出／错误边界：需要时据实填写。
- 伪代码与关键步骤：需要时填写，明确哪些只是设计。
- 解除阻塞后补做与真实验证：需要时填写。
- 使用该暂定接口的下游任务：需要时记录，便于后续回补。

## 执行记录

以下是事实记录，不另存一份任务状态；状态只改根 TASKS.md。

- 执行者／Session：ZCode / Pi session `01a1981c-6f75-749d-b9c2-7e5c897950a6`（用户已授权本仓库提交／推送）。
- 开始／结束时间：2026-11-02。
- 实际修改：更新 `README.md` 当前 M2／M3A 状态与本地安装方式；新增 `validation/release-candidate-linux/` 证据；未新增 CI 配置文件（没有可实际运行的 macOS runner，不以配置冒充兼容）。
- 实际验证命令与结果：
  - `npm pack --pack-destination /tmp/knit-025`：162 文件、214.5 kB，仅 README/package/assets/dist。
  - `/tmp/knit-025/app` 本地 `npm install knit-0.1.0.tgz`：成功。
  - `knit --version`：0.1.0。
  - `knit init --client pi`：ready。
  - `knit start --dir ... -- --version`：Pi 1.4.0。
  - `npm run -s pack:check`：通过。
- 任务书必需验证逐项：
  - Linux + Node24 + Pi1.4.0：PASS（实际安装、init、start）。
  - macOS：**未执行**，没有真实 macOS 环境；不标通过。
  - 复跑提示：现行 CLI 已无 `init --client`（`bcff877` 起 `knit init` 默认启用 `--pi`）；本记录保留当时的命令，矩阵复跑前先核对 `knit init --help`。
  - 包排除 validation／任务／私有历史／日志／凭据：PASS（162 文件清单）。
  - 不 npm publish／部署／push／外部发布：保持。
- 证据位置：`validation/release-candidate-linux/README.md`、`version.txt`、`init.txt`、`start.txt`、`start.err`。
- 未解决问题／决定：用户 2026-11-02 明确接受“目前以 Linux 通过为准，macOS 后续验证”。因此 025 以 Linux 候选完成，README 只声明 Linux；macOS 保留 B001 后续补测，不宣称跨平台兼容。未新增无 runner 的 CI 配置。
- 对下一项的交接：026 可按“Linux 候选首版”独立审查；不得把 macOS 写成已支持，发布说明需保留平台限制。
优先扫描下一编号（阻塞时可继续跳过）：[026 独立完成首版发布就绪审查](026-release-independent-gate.md)。
