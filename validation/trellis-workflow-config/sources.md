# 固定来源（Trellis 0.6.17 / `f089cb3`）

## 来源固定

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/mindfold-ai/Trellis` |
| 提交 | `f089cb3286071199e84118dee86b6d76aab032f1` |
| 版本 | `packages/cli` version `0.6.17` |
| 检出方式 | 本地干净检出（`git status --porcelain` 为空），本报告全部 `path:line` 与 sha256 均取自该提交 |
| 核对日期 | 2026-11-05 |

同一提交已用于 [../reference-boundaries/SOURCES.json](../reference-boundaries/SOURCES.json)；本文件补充工作流可配置性相关的文件。

## 方法

1. 在干净检出上按 `grep -n` 定位行为入口，再读上下文确认调用链。
2. 对每个被引用的文件记录全文 sha256；`path:line` 与 sha256 组合可在同提交上复现定位。
3. 只读：未运行 `trellis` CLI、hook、channel 或任何脚本；未修改检出。
4. 用户侧行为以 `packages/cli/src/templates/**`（安装时写入项目的模板）为准；仓库自身 `.trellis/` 是 dogfood 副本，可能与模板有版本差，仅在说明运行时契约时引用。

## 文件与行号

来源 URL 形式：`https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/<path>`

| 文件 | sha256 | 引用行 | 用于证明 |
| --- | --- | --- | --- |
| `packages/cli/src/templates/trellis/workflow.md` | `eb4508a4f6792f3d53705c1f9e7d21807dabd774543bd7b01f56372a704f6ad0` | 147（Phase Index）、179-272（`[workflow-state:*]` 块）、260（编号即接口的说明）、308-316（按步骤取详情）、319/480/578（三阶段正文）、323/484/539/582/600（步骤小节）、658-720（Customizing for forks） | 流程叙事是项目文件；脚本只解析 |
| `packages/cli/src/templates/trellis/scripts/common/workflow_phase.py` | `146b69c1ec0e628aeb720d3e34d8333f16050225037fe4233da9bbc4d4ac99c1` | 32-38（`_MARKER_RE`、`^####\s+(\d+\.\d+)`、`## Phase Index`）、100-125（`get_step`） | 步骤按编号正则抽取 |
| `packages/cli/src/templates/trellis/scripts/common/git_context.py` | `fa30ced454f1a91ffc9f8b2abeb32225e3447cbdc90bad783797374eba07265d` | 31-34（导入 `get_step`/`get_phase_index`）、46-88（`main` 与 `get_step(args.step)`） | `get_context.py --mode phase --step` 的调用链 |
| `packages/core/src/task/phase.ts` | `8f26a36c6aa599cab918b201ab2cb685a97113eb91d4b2c315b3367951d09588` | 21-31（`TrellisTaskPhase`）、33-53（`inferTaskPhase`） | phase 投影硬编码，未知 status → `unknown` |
| `packages/core/src/task/schema.ts` | `884edfcff63075a8042e84444a5dce0649e5720a9818a0885888fd754c65258d` | 18（`status: string`） | 状态在数据层是自由字符串 |
| `.trellis/spec/cli/backend/workflow-state-contract.md` | `05967658ad772cefe869da6403be9fc8303937be70467ad4d12ad28760523c08` | 29-42（marker 语法）、67-85（解析与查表）、230-249（更新边界）、251-271（写入者表）、273-290（生命周期事件 ≠ 状态转移）、292-316（可达矩阵）、318-329（自定义状态）、332+（hook 可达矩阵） | 运行时契约、写入者封闭、自定义状态的实际条件 |
| `packages/cli/src/templates/common/commands/continue.md` | `13d399b206485643109f943e498473879a2529d120ab544d485350370d517953` | 25-34（按 status + 产物决定续做步骤的表） | 恢复路由是文件内容，加状态要手改 |
| `packages/cli/src/utils/workflow-resolver.ts` | `16d889cd7514199b83609f0fefc873de88453c0c625e39d7505982bbe111446f` | 1-20（模板解析职责与 hash 契约）、40（`NATIVE_WORKFLOW_ID`）、90-108（native 虚拟条目） | 只有 native 内置，其余走 marketplace |
| `packages/cli/src/commands/workflow.ts` | `01f4a90a3fd2c761e78b14d1bdd6bd5b912764bc59bc660447ba2e17db5d1685` | 1-20（hash 边界、改动保护、`--create-new`） | 整份流程模板切换的行为契约 |
| `packages/cli/src/commands/update.ts` | `315107ab86b4f2f42d18c6c5b7f4d157b2bc84b90bd619fca59c8623973510c2` | 882-903（channel agent 回填、`config.yaml` 保留、`workflow.md` 走模板更新路径与其为 runtime-parsed 的说明） | 手改 workflow.md 不会被静默覆盖 |
| `packages/cli/src/utils/template-fetcher.ts` | `b9154effa4f574490d1ce546f2a0bc6bdb71a4eb821f2b5e52e76edbdea5201f` | 19-22（marketplace 索引地址 `raw.githubusercontent.com/mindfold-ai/marketplace/main/index.json`） | 非 native 模板的来源 |
| `packages/cli/src/templates/common/bundled-skills/trellis-meta/references/customize-local/change-workflow.md` | `43fa780a2ca580de121b10893d49b99f978873deebbf45008c466e5ac6651519` | 全文（尤其"Common Needs And Edit Points"、"`/trellis:continue` Route Table"、"Notes"） | 官方 customize 指引：改流程即改文件；加自定义状态需同步路由表 |
| `.trellis/config.yaml` | `6fb6486fda0b16ecf7d19825b36f3d91bff28fe5b4d57ad9263e0540f89cfcc4` | 7-31（journal 与自动提交）、36-52（生命周期 hook）、54-85（packages）、88-117（channel worker）、119-139（Codex 派发）、141-155（子 Agent 上下文限额）、157-166（逐轮注入 skip 词） | 配置文件不含阶段/步骤开关 |

## Knit 侧引用（当前工作区，非固定提交）

| 位置 | 用于证明 |
| --- | --- |
| `src/contracts/task-inputs.ts:17-22` | `TaskPhaseSchema` 枚举 |
| `src/contracts/run.ts:20-24` | `RunPhaseSchema` 只有 `implement/check/advisory` |
| `src/domain/task.ts:13`，`136-138`，`151-169`，`179-200` | `TaskPhase` 与转移函数 |
| `src/cli/run.ts:135`，`151` | CLI 只接受三个 phase 值 |
| `src/application/config.ts:15-64` | config 顶层封闭、`workflow` 只有 `maxRepairRounds`、`phases` 为开放 map |
| `src/application/context-planner.ts:62-70`，`186-240`，`405-431` | 工具策略按 role 硬编码；workflow／role／runtime 分节；全部 `countsTowardInputs` 参与身份摘要 |
| `src/application/templates.ts:21-27` | 模板清单与 project／managed 所有权 |
| `src/application/initialization.ts:178-196` | project 所有权无条件 `keep`；`--force` 只作用于 managed |
| `src/application/delivery.ts:60-74`，`89`，`128-133` | `.knit/workflow.md` 兼任交付授权来源与策略版本 |

## 未取得项

- Trellis marketplace 上的 `tdd`、`channel-driven-subagent-dispatch` 等模板内容：本次没有网络取回，只核对了解析与切换代码路径。若要比较它们的流程差异，需要另行固定 marketplace 提交。
- Trellis 早期版本（< 0.6.17）是否已有 `trellis workflow` 命令：未核对，本报告不对此断言。
