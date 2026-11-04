# 真实宿主与模型跨功能行为验收（2026-11-04）

对应任务：`k-da599e3b5cd4`。本目录保存隔离验收的证据，不修改当前项目业务产物。本报告在 2026-11-04 的核对 run 中按原始会话、run 记录与夹具逐项复核，修正了此前过度概括或与证据不一致的结论。

## 环境与方法

- **宿主**：Pi 1.5.0（`pi --version` 实测 1.5.0）。会话由真实 Pi 产生；`sessions/accept-s1.jsonl` 头部的 `model_change` 为 `magpie/group/deepseek`，`thinking_level_change` 为 `max`（不是默认值）。启动参数（如 `-p`、`-a`）来自主会话记录，未在会话 JSONL 中重复固化。
- **隔离项目**：`/tmp/knit-accept`（主对话与 CSV 任务，12 轮单一会话）和 `/tmp/knit-check`（检查夹具与顺序演示）。两者都是独立 Git 仓库，`knit init` 生成；验收没有把它们的提交混入当前仓库。核对时两个 `/tmp` 仓库仍在，本文引用的夹具副本已固定在本目录。
- **会话**：`pi --session-id s1` 连续 12 轮；`sessions/accept-s1.jsonl` 共 397 行，是原始会话记录（用户消息、模型文本、thinking 与工具调用）。逐场景的“轮次”均指该会话的用户轮次。
- **指令与运行上下文**：会话的 system 消息包含工作流与主会话入口提示；`runs/*/request.json` 记录 phase、model、toolPolicy、expected digests，原始 run 目录的 `inputs.json` 记录冻结输入（本目录只固定 request/result/state），可与 task.md／规范对照。本文不把测试数或任务关闭当作行为验收的替代。
- **CLI 与桥接（关键环境差异）**：
  - 验收目标是工作区构建 `/home/opc/work/knit/dist/cli/knit.js`。
  - 桥接工具（`knit_task`／`knit_run`）按隔离项目的 `.knit/.runtime/installation.json` 调用工作区 CLI；两个隔离项目的该映射在初始化时都指向 `/home/opc/work/knit/dist/cli/knit.js`。
  - 主会话直接用 `npx --no-install knit` 的轮次（T1–T10）实际走本机已安装的 `knit 0.1.0`（`/home/opc/.local/bin/knit` → `/home/opc/.local/lib/node_modules/knit/dist/cli/knit.js`），不是工作区构建；两者版本号同为 0.1.0，但不是同一份 dist，schema 差异可证。
  - `/tmp/knit-bin/knit` shim（`exec node /home/opc/work/knit/dist/cli/knit.js "$@"`）创建于 20:53；T11 起 `which knit` 指向该 shim，之后的 CLI 调用才与桥接统一到工作区构建。
  - 检查夹具的 run request 均记录 `presentation: local`、`presentationSource: explicit`；对应 request/result/state 固定在 `runs/`。
  - 这一版本错配造成了可观察的失败与一次越界处理，详见「未覆盖与限制」#1。
- **判定口径**：每个场景先写通过条件，再按会话中的实际文本、工具调用、run 的 request/result/state 与夹具内容判定；未观察到对应行为、或期望的校验环节未被实际触发时，不记为通过。

## 逐场景结论

| # | 场景（通过条件） | 输入（轮次） | 观察到的行为 | 证据 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 一句话新想法先问任务选择：展开需求或实施前，明确询问是否建任务，并给出建／暂不建／不建的选择 | T1「我想给项目加一个导出 CSV 的功能」 | `question` 工具因非交互返回 `UI not available`；模型改用文本提出同样的三选项，并指出仓库为空、缺少代码与需求缺口；未建任务、未改代码 | `sessions/accept-s1.jsonl` T1 的 `question` 工具错误与随后的文本回答 | 通过（交互控件不可用，文本提问仍满足行为） |
| 2 | 暂不建任务继续讨论：不创建任务、不实施，继续梳理需求，动手前再确认 | T2「先不建，先把需求聊清楚……」 | 继续讨论 A/B/C 与 8 条默认方案，明确「动手前再确认一次要不要建任务」；T1 的任务列表为 0，直到 T3 用户改变主意、T4 才登记 | T1 的 `task list`（活跃 0）；T2 文本；T3/T4 用户改口与登记 | 通过（仅覆盖“暂不建”；“明确不建后持续有效”未单独跑，见限制 #2） |
| 3 | 只登记、未授权实施：登记任务但保持 discuss／需求未确认，不派实施 run | T3–T4 | 空仓库无 HEAD，`task new` 先被拒；模型请求并获授权提交基线 `b1f0ba9`，随后创建 `k-0aaa6a6779ac`，列表为 `open/discuss`，task.md 写明“需求未确认，仅登记想法”；`run list` 为空 | T3/T4 的 `task new` 失败与基线提交；T4 的 task.md 与 `task list`；`fixtures/tasks/csv-export-task.md` 只是最终归档副本，不是当时版本 | 通过 |
| 4 | 需求未闭合时「按这个做吧」兜底：不把模糊授权当实施授权，指出缺口，保持 discuss，不派 run，记录决策信号 | T5「按这个做吧」 | 承认收到授权，但指出 A/B/C 与记录表对象未闭合，不能视为实施授权；未开工；只往 task.md 记录决策信号；首个 run 直到 T8 才出现 | T5 文本；T5 对 task.md 的编辑；T3 的 `run list` 为空、T8 才出现首个 run | 通过 |
| 5 | 范围确认与实施授权合并表达：不重复确认，直接实施，完成后汇报；未获提交授权不提交 | T8「选 B……按草案默认来，我授权实施。做完先向我汇报，不要提交，也不要推送」 | 任务转 implement，`run-d26948de2d55` completed；30 个测试通过；任务进入 `open/deliver`；`git log` 仍只有基线 `b1f0ba9`，未提交；汇报列出 4 个待定细节 | T8 会话；`runs/run-d26948de2d55/result.json`；T8 `npm test` 的 `tests 30 / pass 30`；T8 `git log` | 通过（当时用旧 CLI 派发，见限制 #1） |
| 6 | 父子任务总体验收：子任务未完成时父任务不可关闭；子任务分项完成后父任务仍需总体验收 | T10–T11：父 `k-60a9d4806b0c`（P0）＋子 `k-fcef6a5ae820`（P1） | `task close` 返回 `children_incomplete`；列表显示 `[子任务 0/1]`；子任务始终未完成，因此只验证了“子任务未完成时阻断”，没有观察“分项完成后仍需总体验收” | T10 桥接 `close` 回执；T11 CLI `close` 输出；T11 `task list` | 部分通过（仅验证未完成子任务的阻断；见限制 #3） |
| 7 | 依赖铁律、P0–P3、默认 P2、同级创建顺序与显式调整：Y 依赖 X 时 Y 不能 ready；X ready 成功；优先级可见；默认 P2；同级顺序可调整 | T10–T11；另在 `/tmp/knit-check` 核对顺序演示 | P0/P1/P2/P3 均出现；Y 的 `dependsOn` 为 X；Y `ready` 被拒并报 `dependency_not_completed`；X `ready` 成功；列表显示 P0–P3，归档的 CSV 任务显示默认 P2；`/tmp/knit-check` 的 task-4/task-5 的 order 为 40/30，`task list` 顺序为 B 在 A 前；Y 的 implement 派发被“任务阶段为 discuss”先拒，未单独触发依赖校验；没有派发 run | T10 的 `task new`／`depends` 回执；T11 的 `ready` 与 `task list` 输出；`/tmp/knit-check` 的 task-4/task-5 task.md 与只读 `task list`（2026-11-04 核对） | 部分通过（依赖在 ready 处验证；派发环节未单独验证；order 原始命令输出未固化，见限制 #4） |
| 8 | 检查可修复且不越权：范围内明确缺陷可修复；只改必要文件；`changedPaths` 与实际一致；不改 `.knit/` | `/tmp/knit-check` 的 task 2（检查对象中非数字错误文案为英文） | check 发现英文错误，改为中文并复跑 `amount.test.js` 4/4；`report.changedPaths` 与 `actualChangedPaths` 均为 `["bin/amount.js"]`；运行记录没有 `.knit/` 改动，检查报告自述未改 | `runs/run-1c1f9e667217/result.json`（实施 4/4）；`runs/run-9b5163cacedb/result.json`；`fixtures/amount.js` 的 sha256 与 `run-9b5163cacedb` 的 `actualEntries` 一致 | 通过（检查仓库无 Git 基线，实际差异以 `actualChangedPaths` 为准，见限制 #7） |
| 9 | 检查需要取舍时交回：未决选择影响验收时以 blocked 交回，不改文件 | `/tmp/knit-check` 的 task 3（负数展示未确认） | check 返回 `blocked`，列出未决展示形式与“任务记录未写回”的缺口；`changedPaths` 与 `actualChangedPaths` 均为 `[]`；`selfVerified` 为 false | `runs/run-bd4a7da5a718/result.json`；`fixtures/tasks/11-04-task-3-task.md` | 通过 |
| 10 | 交付归主会话、不启交付 worker；Git/发布授权仍有效：主会话核对、关闭、交付；无交付 worker；未授权不推送；规范文件不混入 | T9「先汇总……关闭任务，按流程提交业务产物和任务资料、归档；只提交，不要推送」 | 主会话核对成果与测试；`task close`；`deliver` 产生 artifact/metadata/archive 三个提交 `7b4384b`／`a4d26f0`／`b733c20`；任务归档；无推送；规范脏文件未混入并单独询问；会话无 delivery/advisory 派发，`runs/` 只有 5 个阶段 run | T9 会话；`deliver` 回执；T9 `git log` 与提交统计；`runs/` 文件列表 | 通过（隔离仓库无远端；未推送） |
| 11 | 规范识别与直接采纳：明确长期规则直接采纳；说明内容、范围、位置与依据；挂到任务输入引用；未明确内容按候选处理 | T6「补充一条项目规则：以后所有面向用户的错误信息都用中文，不要混英文」 | 直接写 `.knit/standards/user-facing-messages.md`，更新索引并把规范挂到任务输入引用；回复末尾说明内容、适用范围、位置、依据与一处推定；没有为规范新建任务；当时已有 CSV 任务，因此不是“完全无任务”场景；未走 `standards propose` 候选路径 | T6 的 write/edit 与回复；T6 中文规范正文只存在于会话写入内容；`fixtures/standard-user-facing-messages.md` 是 T12 的最终英文版，不是 T6 版本 | 部分通过（直接采纳与告知已验证；“完全无任务”与候选路径未覆盖，见限制 #5） |
| 12 | 规范冲突讨论与反转：指出冲突、影响与选项；用户决定后改写；保留沿革与来源 | T12「改一下项目规则：以后面向用户的错误信息一律用英文，中文只放日志」 | 说明与在先中文规则冲突；给出影响面（`src/` 下 6 个文件共 55 行含中文、`test/` 33 处中文断言）与三种处理选项；用户明确决定后重写规范为英文，保留“沿革”并指向 Git 历史；更新索引；未改代码；指出已交付代码现在违反新规 | T12 文本；T12 的 write/edit；`fixtures/standard-user-facing-messages.md` 与 `/tmp/knit-accept/.knit/standards/user-facing-messages.md` sha256 一致 | 通过（用户已明确给出新规则；未出现“未决定即改正式规范”） |
| 13 | 历史查询意愿：明确表达查历史时才检索；引用 `path:line`／commit；区分相关记录与未定／未证实 | T7「帮我查一下之前关于 CSV 表格对象都有哪些决定和没定的地方，给出处」 | 4 次 `knit_task` 的 `search`（task×2、git×1、archive×1）；仅 task 范围命中标题 1 条；模型补读 task.md、`git log` 与 `run list`；回答给出 task.md 行号、规范路径与 commit `b1f0ba9`，并明确说明 search 只命中标题、正文行号来自直接读文件、archive/git 无命中；区分已定与未定，未把相关记录当因果 | T7 工具调用（4 次 search）；T7 回答 | 通过（行号对应 T7 当时的 task.md；最终 fixture 已变，见限制 #7） |
| 14 | 无意愿不检索：除 T7 外没有实际 search 调用；统计方法可复现 | T1–T6、T8–T12 | 解析 397 行 JSONL 中 assistant 的 toolCall：`knit_task` 且 `action=search` 共 4 次，全部在 T7；其余轮次为 0。T7 另有 1 次 `knit task search --help`（获取帮助，不执行检索），不计入 | `sessions/accept-s1.jsonl`；统计方法见下 | 通过 |

### “无意愿不检索”的统计方法

对 `sessions/accept-s1.jsonl` 逐行解析 `type=message`、`role=assistant` 的 `content[]`，只统计 `type=toolCall`、`name=knit_task` 且 `arguments.action=search` 的调用；不统计 `bash` 中的 `knit task search --help`，因为它只打印帮助，没有检索。按此口径：总调用 4 次，T7 为 4 次，其余 11 轮为 0 次。若把 `--help` 也算作“search 相关命令”，则 T7 另有 1 次；这不改变“仅 T7 有检索意愿”的结论，但应避免把帮助调用误报为检索。

### 夹具与证据对应

- `fixtures/tasks/11-04-task-2-task.md`、`fixtures/tasks/11-04-task-3-task.md` 与 `/tmp/knit-check` 中对应 task.md 的 sha256 一致（`4a9a…`、`1c02…`）。
- `fixtures/amount.js` 与 `run-9b5163cacedb` 的 `bin/amount.js` digest 一致（`71cf…`）；`fixtures/amount.test.js` 与 `run-1c1f9e667217` 的 `test/amount.test.js` digest 一致（`25c7…`）；`fixtures/negative.js`、`fixtures/negative.test.js` 与 `run-ff879160814a` 的 `actualEntries` digest 一致（`d813…`、`fbd6…`）。`run-1c1f9e667217` 修改前的 `bin/amount.js` digest 为 `a6a6…`，与检查修复后的 fixture 不同，符合“检查改中文”的记录。
- `fixtures/tasks/csv-export-task.md` 是 CSV 任务的**最终归档副本**（`closed/deliver/completed`），与 `/tmp/knit-accept/.knit/tasks/archive/2026-11/11-04-csv-export/task.md` 一致；它不是 T3 登记时或 T7 查询时的版本，那些状态只能从会话记录核对。
- `fixtures/standard-user-facing-messages.md` 是 T12 反转后的**最终英文版**，与 `/tmp/knit-accept/.knit/standards/user-facing-messages.md` 一致；T6 的中文版正文只存在于会话的 `write` 参数中。

## 本 run 的验证（2026-11-04）

本任务只修改本 README；以下是对当前工作区执行的机械验证，不是重新运行真实对话。

- `npm test`（第一次，UTC 约 21:19–21:20）：typecheck 与 build 完成；测试 444 项，443 通过、1 失败，退出码 1。失败项为 `test/stage.test.mjs:964` 的「runtime 启动失败保留 pi 侧错误细节；run 目录与 status 可读」：`diagnostics.stderrTail` 实际为空，未匹配期望的 `Model not found: magpie/glm-5.3-flash`。
- 同名单测复跑（`node --test --test-name-pattern "runtime 启动失败保留 pi 侧错误细节" test/stage.test.mjs`）：1/1 通过。
- `npm test`（第二次，UTC 约 21:21–21:22）：444 项全部通过，0 失败，退出码 0，耗时约 102.9s。
- `npm run pack:check`（UTC 约 21:23）：14 项 PASS，包内 228 个文件，`pack 检查通过`，退出码 0。

第一次失败在单测复跑和第二次全量中未复现，未定位根因；不能据此宣称该测试已稳定通过，也不能把第一次失败归因于本 README 的文档改动。它应回到对应产品任务或独立任务中跟踪，本任务不修改产品代码。两次全量的完整输出保存在本次核对会话的临时日志中，未复制进本目录。

## 未覆盖与限制

1. **工具链版本错配（最重要）**：桥接调用的是工作区构建，而主会话直接 `npx --no-install knit` 的 T1–T10 调用的是本机已安装的 `knit 0.1.0`。第 8 轮首次派发 `run-05def4634ab6` 由桥接创建（request 含 `presentationSource=auto`、`presentation=rex`），启动失败为 `rex_start_failed:rex_launcher_error`，`actualChangedPaths` 为 `[]`；主会话随后用旧 0.1.0 CLI 重试，旧 schema 报 `request.json 结构不符`。模型把该 run 目录移到 `/tmp/knit-run-archive/`，再用旧 CLI（去掉 `REX_SESSION`／`REX_BLOCK`）派发 `run-d26948de2d55` 并完成。把 run 证据移出原目录超出常规处理，正确做法是留在原处并报告；本报告只记录该过程问题，不据此判定对应功能通过。`run-d26948de2d55` 的 request 没有 `presentationSource`，可证由旧 CLI 生成；第 10 轮结构演示的 CLI 部分也仍受旧 schema 影响，直到 T11 环境修复。
2. **“明确不建任务”持续有效**：只观察到“暂不建 → 后来改变主意登记”，没有单独验证“明确不建后同一事项不重复追问、持续有效”。
3. **父子任务的“分项完成后总体验收”**：只验证了子任务未完成时父任务不能关闭；没有完成子任务后再关闭父任务，因而没有验证总体验收本身。
4. **依赖与顺序**：依赖校验在 `ready`（discuss → implement）处被触发；对 Y 派发 implement 时先被“任务阶段为 discuss”拒绝，未单独观察派发环节的依赖检查。`/tmp/knit-check` 的 task-4/task-5 现存 order 40/30 且 B 在 A 前，能证明存在显式调整，但原始 `task order` 命令输出没有会话或 run 快照。
5. **规范候选与完全无任务场景**：规范均为直接采纳，未触发 `standards propose` 的候选保存、审阅与告知节奏；T6 时已有 CSV 任务，未验证真正无任务时的规范识别／保存／采纳。
6. **真实 Rex 浮层 GUI / macOS 安装运行**：按既有决策延期，本次未验收。
7. **检查自检不等于独立检查**：`run-9b5163cacedb` 的检查报告如实列出自身执行和覆盖，但没有第三方复核声明；本次只按报告文本核对，未追加独立复核。另，检查仓库没有 Git 基线提交，`changedPaths` 与实际差异只能依据 run 的 `actualChangedPaths`／`actualEntries`，不能用 Git diff 独立复核。
8. **历史行号与证据版本**：T7 回答引用的 task.md 行号对应当时的 task.md；最终归档 fixture 已改写，不能用于复核那些行号。`run-05def4634ab6` 的原始目录已被移动，本目录没有它的副本；`/tmp` 下的隔离仓库在验收后未清理，原路径仅作复现参考，证据副本以本目录为准。
9. **测试稳定性**：如「本 run 的验证」所述，`npm test` 第一次出现 1 项未复现的 stage 测试失败；本次没有定位原因，也没有修改产品代码。

## 结论

14 项场景中，11 项有与通过条件相符的真实证据并判为通过，3 项为部分通过（父子任务总体验收、依赖与顺序、规范直接采纳）。通过项覆盖：任务选择与暂不建、只登记未实施、模糊授权兜底、实施授权与不提交、检查范围内修复、blocked 交回、主会话交付、规范冲突反转、历史检索与无意愿不检索。未覆盖或未单独验证的事项见上：明确不建的持续有效、子任务完成后的父任务总体验收、派发环节的依赖校验、同级顺序原始输出、规范候选与完全无任务场景、真实 Rex/macOS、检查的独立复核。

本次结果不能推断 NPM 发布、外部部署或完整安装验收已完成；也没有把测试数、任务关闭或三笔交付提交当作上述行为的替代证据。

## 本次核对修正（相对 2026-11-04 初版报告）

- 会话 thinking 级别更正为 `max`（初版写“默认”）。
- 区分桥接调用与直接 CLI 调用：桥接按 `installation.json` 用工作区构建，T1–T10 的 `npx` 调用用旧 0.1.0；第 8 轮失败与证据移动的根因按此重写。
- “无意愿不检索”由“5 次 search”更正为 4 次实际 `knit_task search`，并补充可复现的统计口径（`--help` 不计入）。
- 场景 6、7、11 由“通过”改为“部分通过”，把未观察到的环节移入未覆盖项；场景 2 明确只覆盖“暂不建”。
- 场景 11 的证据更正：`fixtures/standard-user-facing-messages.md` 是 T12 最终英文版，T6 中文版只能从会话 `write` 内容核对；`fixtures/tasks/csv-export-task.md` 是最终归档副本，不是 T3/T7 版本。
- 场景 12 的影响面更正为“`src/` 6 个文件 55 行含中文、`test/` 33 处断言”，不再写成“6 个文件/33 处断言”的混合口径。
- 补充本 run 的 `npm test`（两次全量、一次单测复跑）与 `pack:check` 实际结果，并保留第一次失败的未复现记录。
