# Knit 侧改造方案建议（待确认）

> 本文件是任务 `k-2edd6475a67c` 的**建议**，不是已确认需求，也不构成实施授权。
> 每个选项标注"Agent 建议，待确认"。Trellis 事实依据见 [README.md](README.md) 与 [sources.md](sources.md)。

## 前提：Knit 现在到底哪一层是死的

| 层 | 现状 | 改它需要动什么 |
| --- | --- | --- |
| 阶段集合 | `discuss/implement/check/deliver` 枚举，`src/contracts/task-inputs.ts:17-22`、`src/domain/task.ts:13` | 枚举 + 转移函数 + STATES.md + 历史 task.md 兼容 |
| 阶段转移 | `src/domain/task.ts` 的 `onXxx` 函数、`check.ts` 资格推导 | 代码 + 状态文档 |
| run 阶段 | `implement/check/advisory`，CLI 只收这三个（`src/cli/run.ts:135, 151`） | 契约 + 验收 + 上下文工具策略 |
| 角色文件 | `.knit/agents/<role>.md`，role 取自上面三个（`src/application/context-planner.ts:204`） | 模板清单 + 角色策略 |
| 工具策略 | `toolPolicyFor` 按 role 硬编码写权限（`context-planner.ts:62-70`） | 代码 |
| 流程叙事 | `.knit/workflow.md`，project 所有权，init 只补缺 | 直接改文件，无代码 |
| 角色指令 | `.knit/agents/implement.md`、`check.md`、`runtimes/pi.md` | 直接改文件 |
| 流程叙事改动的副作用 | 计入 `inputsDigest`，使在途检查 stale（`context-planner.ts:405-431`） | — |
| 配置改动 | `config.json` **不参与** `inputsDigest`（`context-planner.ts` 分节只有 task-inputs／workflow／role／runtime／standard／材料） | — |

最后两行决定了很多设计取舍：**改 `.knit/workflow.md` 会让检查失效，改 `.knit/config.json` 不会。** 任何"把流程挪进配置"的方案都会顺带丢掉"流程变了，旧检查作废"这条保护，除非另行把配置纳入摘要。

## 选项

### A. 维持现状，把边界写清楚（Agent 建议，待确认）

**做**：在 `docs/design/DESIGN.md` 第 4 节与 `GLOSSARY.md` 明确"四环节是产品合同，不是项目配置项"；在 `.knit/workflow.md` 模板里加一句"本文件可改职责与操作细节，不能增删阶段"。

**影响面**：纯文档，零代码，不改摘要语义。

**理由**：现状下项目已经能改全部流程叙事，缺的只是"能不能改阶段数"。Knit 的检查资格、交付授权、修复轮次都挂在阶段语义上，把阶段做成配置会把产品合同交给项目配置。

**不做的代价**：确实存在"想加一个 review 环节"或"想去掉 check"的项目，只能自建外部流程。

### B. 步骤化约定，核心零改动（Agent 建议，待确认）

**做**：在 `.knit/workflow.md` 引入可选的步骤编号小节（`#### X.Y`）与"步骤索引"，作为**项目内约定**。核心仍整段注入 workflow.md，不解析编号，不新增命令。

**影响面**：模板与 `docs/design/DESIGN.md` 第 4 节补充说明；无代码改动；摘要语义不变（全文仍计入）。

**收益**：项目能在四环节内部组织"讨论→澄清→写方案→ready"这类子步骤，人和 agent 都有稳定编号可引用。

**风险**：编号只是文本约定，核心不知道哪些步骤必过，不产生任何门槛。写多了会有"看起来像状态机其实不是"的误读。

### C. 核心支持步骤抽取与按需加载（Agent 建议，待确认）

**做**：参照 Trellis 的 `get_context.py --mode phase --step X.Y`，让 Knit 能按步骤取上下文：

- `context-planner` 增加步骤分节：解析 `.knit/workflow.md` 的 `#### X.Y`，按当前请求的 step 只注入对应小节（其余步骤只留标题）。
- 新增只读入口 `knit context --step <X.Y>`（CLI 与桥接工具各一条），供主会话或阶段执行器取用。
- `run` 请求可选携带 `step`，仅用于上下文装配与报告标注，**不改变** phase、不产生新的门槛。

**影响面**：`contracts/context-plan.ts`（新分节类型）、`context-planner.ts`、`src/cli/*`、桥接工具表、`docs/design/ARCHITECTURE.md` 与第 4 节；`STATES.md` 不变。

**兼容**：旧任务与旧 workflow.md 没有步骤小节 → 抽取为空，退回整段注入，行为等价；`inputsDigest` 继续按 workflow.md 全文计算，语义不变。

**风险**：需要防"两套阶段"混淆——step 必须明确写成"四环节内部的步骤，不携带状态、不产生资格"，否则会诱导主会话把 step 当成 phase 推进。

**适用条件**：有真实的"长任务需要分步加载上下文"诉求时再做。当前 Knit 的 workflow.md 只有几百行，整段注入不构成压力。

### D. 阶段与转移配置化（Agent 建议，待确认；成本最高）

**做**：`config.workflow.phases` 声明阶段与转移，例如

```json
{
  "workflow": {
    "phases": [
      { "id": "discuss", "next": ["implement"] },
      { "id": "implement", "next": ["check", "deliver"], "requiresCheck": true },
      { "id": "check", "next": ["deliver", "implement"] },
      { "id": "deliver", "next": [] }
    ]
  }
}
```

**影响面（这是本选项的主要成本）**：

- `TaskPhaseSchema` 从枚举变成"按项目配置校验的字符串集合"；`domain/task.ts` 全部转移函数改为按配置裁决；`STATES.md` 第 3 节需重写为"配置解释规则"。
- **完成资格**：现有语义是"有一份对各阶段都成立的检查才能交付"（`domain/check.ts`、`STATES.md` 第 8 节）。配置化后核心不知道哪个阶段算"已检查"，必须在配置里显式声明节点类型，否则交付守卫失效或过度收紧。
- `run --phase` 取值、`.knit/agents/<phase>.md` 查找、`toolPolicyFor` 写权限、桥接上下文、报告字段校验都要跟着阶段集合走。
- **历史兼容**：已归档与在途任务的 `phase` 值若不在新配置里，需要明确降级读法（只读展示？拒绝写入？），不能静默当 `unknown` 吞掉。
- **摘要语义**：`config.json` 不参与 `inputsDigest`，改阶段定义不会使在途检查 stale。要保住现有的"流程变了检查作废"，必须把 `workflow` 配置并入身份摘要，这会牵动所有已冻结摘要的比较逻辑。
- 与 `DESIGN.md` 15.1「首版固定四环节」直接冲突，需要同时改产品范围声明。

**风险**：非法配置（成环、无终态、多入口）会生成核心无法判定完成的流程；用户配置错误会以"任务做完了但不能交付"的形式暴露，诊断成本高。

### E. 整份流程模板切换（Agent 建议，待确认；可搭在 B/C 上）

**做**：`knit workflow --list` / `knit workflow --template <id>` 替换 `.knit/workflow.md`（可选同时替换 `.knit/agents/*`），并在 init manifest 里记录 workflow 基线，使 `knit init` 能判断"这是我上次放的模板"还是"用户手改过"。

**影响面**：`application/init-manifest.ts`（新增非受管文件的基线追踪语义）、`initialization.ts` 的 project 分支（`keep` 前先核对模板基线）、新 CLI 命令与桥接工具；不触碰状态机。

**注意**：现在 project 所有权是**无条件 keep**（`initialization.ts:181-183`），`--force` 只作用于 managed，所以这不是加个命令的事，要先定义"project 文件也可以有模板基线"的语义，否则切换完下一次 init 无从判断冲突。

**收益**：能给团队维护一套流程模板库，换流程不用手抄；与 C 组合后就是 Trellis 那种"步骤清单 + 整份模板"的形态。

## 对比

| 选项 | 改动面 | 是否需要改产品合同 | 历史兼容 | 解决什么 |
| --- | --- | --- | --- | --- |
| A | 文档 | 否 | 无影响 | 消除"能不能配置"的含糊 |
| B | 模板 + 文档 | 否 | 无影响 | 团队看清子步骤，零风险 |
| C | 上下文装配 + CLI | 否 | 向后兼容 | 长流程按需加载，逼近 Trellis |
| D | 枚举 + 状态机 + 文档 + 摘要 | **是** | 需要迁移设计 | 真正自定义阶段 |
| E | init 语义 + 命令 | 否 | 向后兼容 | 流程模板库、一键换流程 |

## 建议（Agent 建议，待确认）

1. **先做 A。** 它成本最低，并且直接回答本轮问题——把"哪层是合同、哪层是配置"写进现行规范，避免以后再靠读代码确认。
2. **只有在出现真实诉求时再做 B 或 C。** B 零风险，可以先当约定试用；C 应当由"步骤太多、整段注入开始失控"这类具体证据触发，而不是为了对齐 Trellis。
3. **D 单独立项，不要与本任务合并。** 它需要同时改 `DESIGN.md` 15.1、`STATES.md` 第 3／8 节，并新写一份"配置合法性 + 完成资格"契约；还要先解决"配置不进摘要 → 改流程不作废旧检查"这个缺口。在没有该契约前实施 D，会把现有的可静态核对性换成不可枚举的运行时判定。
4. **E 与 B 一起做成本最低**，因为它改的是 init 的判定语义，与流程内容无关；但它对"能不能增删阶段"没有帮助，不要拿它代替 D。

## 待用户决定

- 是否有"项目需要增删阶段（而非仅调整步骤与职责）"的真实诉求？没有的话，D 可以直接不做。
- 若要做 C：步骤信息是否需要进入 run 报告与交付记录（影响 `contracts/run.ts` 与报告校验），还是只作为上下文。
- 若要做 D：是否接受"配置纳入输入摘要"，即改阶段定义会让在途检查失效。
