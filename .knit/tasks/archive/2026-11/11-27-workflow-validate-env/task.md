---
id: k-ad489b859bc0
title: 为 workflow validate 增加 --env 环境预检
status: delivered
stage: null
verification: self
parent: k-b7380720fbf3
dependsOn:
  - k-36389e742157
priority: P1
createdAt: 2026-11-27T00:42:26.692Z
---

## 目标与范围

**要解决的问题**：按现行设计第 11 节不单独恢复 `knit doctor` 命令，但身边少数人初次接入或在换机器、升级客户端后，如果缺少 Node ≥ 24、Git 仓库无初始提交、`pi`/`agy` 客户端不可用、模型未配置或 macOS Antigravity 隔离前置条件不满足，只能在首次 `knit run start` 时逐个踩报错。

**改动目标**：
1. **为 `knit workflow validate` 增加 `--env` 选项（`src/cli/project.ts` 及适配器环境检查复用）**：
   - 不带 `--env` 时，保持原有纯配置校验行为与输出 100% 不变（快、只读、无外部进程依赖）。
   - 带 `--env` 时，在工作流配置校验通过后，继续逐项检查本机运行前置条件并输出清晰清单（每项标出通过/失败及可继续的做法）：
     1. **Node 版本**：检查当前运行 Node 主版本 ≥ 24。
     2. **项目配置 `.knit/config.json`**：调用 `loadConfig(root)` 核对配置合法性。
     3. **Git 仓库状态**：检查是否在 Git 仓库内及是否存在初始提交 `HEAD`（若不在 Git 仓库则标出「仅支持主会话直接做，无法派发执行者」；在 Git 仓库但无提交则指出「先提交一次再派发」）。
     4. **流程中各环节实际用到的执行者环境**（按 `workflow.yaml` 去重汇总用到的 `agent` 及各自 `tools` 能力组合）：
        - 若用到 `pi`：检查 `pi` 可执行文件是否在 `PATH` 可用，并检查该环节/顶层是否配置了模型（未配置时提示「不在 Pi 主会话里派发时，需在 workflow.yaml 写 model 或传 --model」）。
        - 若用到 `antigravity`：复用现有 `builtinAgents.antigravity.checkDispatch`（或拆分/复用其中的环境前置检查逻辑），在只读条件下检查 `agy` 可执行文件、版本与隔离环境可用性（不创建 Worktree、不修改磁盘）。
   - 所有必须项通过时退出码为 0 并输出环境就绪摘要；存在阻碍派发的前置问题（如 `.knit/config.json` 有错、Git 仓库无初始提交、流程显式配置的 `pi`/`agy` 客户端不可用或隔离预检失败）时，列出全部问题和修复做法并返回非零退出码（1）。
2. **同步文档**：更新 `docs/design/DESIGN.md` 第 9 节命令行说明及 `README.md` 对应命令条目，说明 `knit workflow validate --env`。

**明确不做 / 边界**：
- 不新增 `knit doctor` 命令。
- `--env` 检查必须纯只读：不创建 Worktree、不修改仓库文件、不发起真实模型网络请求。
- 不修改 Worktree 中的受保护路径（`.knit/workflow.yaml`、`.knit/config.json`、`.knit/standards/`、`.knit/agents/`）。

## 完成条件

### Requirement: `knit workflow validate --env` 只读检查本机运行前置条件
#### Scenario: 不带 `--env` 保持原行为，带 `--env` 一次性报告配置、Git 与客户端就绪情况
- WHEN 在工作流有效且环境满足条件的临时项目运行 `knit workflow validate` 与 `knit workflow validate --env`
- THEN 不带 `--env` 输出与原有行为逐字一致；带 `--env` 检查并报告 Node、config.json、Git 状态与流程涉及的客户端环境，退出码为 0，且不创建 Worktree 或修改工作区

#### Scenario: 缺失前置条件时一次列出具体问题与修复建议并返回非零退出码
- WHEN 临时项目存在 `.knit/config.json` 格式错误、Git 仓库无初始提交、或流程配置的 `pi`/`antigravity` 客户端不可用时运行 `knit workflow validate --env`
- THEN 列出对应失败项及可继续的做法，返回退出码 1

## 待澄清

## 相关资料

- `docs/design/DESIGN.md#9-命令与工具` — 命令行接口定义
- `src/cli/project.ts` — `knit workflow validate` 命令实现
- `src/adapters/agents.ts` — 内置执行者注册表与 `checkDispatch`
- `src/adapters/antigravity/isolation.ts` — Antigravity 隔离前置条件检查
- `src/application/project-config.ts` — `loadConfig` 配置校验
- `test/workflow-cli.test.mjs` — 工作流 CLI 测试

## 验证与交付

- 运行 `npm run typecheck`、`npm run build`、`node --test test/workflow-cli.test.mjs test/workflow.test.mjs` 与全量 `npm test`，全部通过。
- 改动留在任务 Worktree 分支，不自行提交，交由主会话核对并交付。

## 结果

已为 knit workflow validate 增加 --env 只读环境预检：在流程有效后检查 Node >= 24、.knit/config.json、Git 仓库与初始提交以及流程实际用到的 Pi/Antigravity 客户端与隔离前置条件，全部通过输出派发环境就绪并返回 0，存在缺失项时一次列出问题与修复做法并返回 1；普通 validate 保持原行为不变；同步更新 README.md 与 docs/design/DESIGN.md 第 9 节。验证：npm run typecheck、npm run build、git diff --check 通过；定向测试 77/77 通过；全量 npm test 535 通过、0 失败、7 项跨文件系统跳过。未验证：未调用真实模型。
