# 开发阻塞与待决定事项

这里记录Knit开发阶段的阻塞，供用户之后集中处理。任务执行状态仍只在 [TASKS.md](TASKS.md) 维护；本文件不替代进度表，也不是产品的运行状态库。

初建时没有真实阻塞条目。遇到阻塞后按以下规则追加，不为演示创建虚假问题。

## 记录与继续规则

- 为根因分配稳定编号B001、B002等；下游依赖同一问题时引用原编号，不重复开一串相同阻塞。
- 记录现象、证据、已尝试方法、实际缺失能力和受影响任务。需要用户取舍的问题写清选项与影响，建议不等于用户决定。
- 在对应任务文件补伪代码／暂定接口、输入输出、错误边界、关键步骤和恢复条件，保留已完成代码及验证。伪代码存任务说明；需要在代码中留暂定接口／未实现分支时引用同一阻塞编号并明确报未实现，不吞异常或返回通用成功。
- 后续Agent可按暂定契约编写独立部分、使用最小测试替身做局部验证。真实存储、CLI、模型、Git效果或授权缺失仍标明未实现／未验证，不把替身算作集成验收。
- 每记一项就继续扫描后续可推进任务，不因等待用户决定暂停整轮。没有新事实时不反复重试同一阻塞，也不不断向用户重复询问。
- 若仅环境／前置产物缺失且后来事实已补齐，可以回头复验并记录证据；需用户决定的项保留到用户明确选择，不能用暂定方案当作决定。
- 用户给出决定后，在原条目记录决定、来源和日期，回到关联任务补实现／验证，保留历史记录。阶段和发布验收仍要求必需阻塞真正解决。
- 只有所有剩余任务已完成，或都已记录阻塞／伪代码且当前无可推进工作时，汇总已做与待决定事项交还用户；不为“继续”无限空转。

## 条目模板

复制以下模板并填写真实事实；不要把模板视为已发生阻塞。

```text
## B编号 简短问题标题

- 关联任务：任务ID及链接；下游影响列表。
- 问题与证据：现象、实际命令／结果、证据文件。
- 已尝试：已做的排查和原因；不要填未执行动作。
- 尚不能完成：具体缺失实现／验证。
- 仍可继续：可独立开发的部分和任务。
- 伪代码／暂定接口：对应任务文件章节链接。
- 待用户决定：明确问题；若只是环境／依赖问题也说明。
- 参考选项与影响：保持当前选择、替代方案或延期的实际代价。
- 用户决定及来源：尚未决定；收到明确指令后再填写。
- 恢复与验证：后续补做、实际结果和证据。
```

## 实际记录

后续在此追加真实条目。

## B001 macOS 安装／运行矩阵未实测

- 关联任务：任务025（Linux 候选已完成，macOS 后续补测）、任务026（按 Linux 候选审查）。
- 问题与证据：Linux + Node v24.21.0 已完成 `npm pack`、本地安装、`init`、`start -- --version`（`validation/release-candidate-linux/`）；当前没有 macOS 机器或可实际运行的 macOS runner，未执行构建、安装、init、start、桥接加载。
- 已尝试：检查现有工作区和 CI 资源；没有可用的 macOS 执行环境，未创建只声明不运行的 CI 兼容矩阵。
- 尚不能完成：macOS 平台实测、跨平台安装路径／进程／锁／原生 Session 行为验证、首版跨平台发布声明。
- 仍可继续：Linux 候选包与文档已验证；026 可按 Linux 候选审查，不等待 macOS 事实。
- 伪代码／暂定接口：任务025文件记录当前只能声明 Linux 候选，不新增平台代码分支。
- 待用户决定：无当前阻塞；macOS 执行环境后续提供时补测并更新平台声明。
- 参考选项与影响：提供 macOS 机器／runner 可补齐实测；仅 Linux 候选可先形成单平台预览，但不能宣称 macOS 兼容；延期不阻塞 Linux 证据保留。
- 用户决定及来源：用户于 2026-11-02 明确“目前就以 Linux 通过为准，记录 macOS 后续验证”；接受首版候选仅声明 Linux，macOS 后续补测，不阻塞 025／026 的 Linux 发布就绪结论。
- 恢复与验证：macOS 后续实测后回填任务025矩阵和证据，再更新跨平台声明；当前 Linux 候选按用户范围通过。
## B002 全量并行测试偶发单例失败（负载型，非功能回归）

- 关联任务：027（实施中发现）、029、031；下游影响 043 复验的判定口径。
- 问题与证据：`node --test test/*.test.mjs` 多进程并行全量时，个别真实 worker 子进程用例（implement→check 独立会话、心跳丢失、运行边界等）偶发超时或断言失败，失败项每轮不同；同一提交单跑该文件或连续多轮全量大多 100% 通过。2026-11-02 在基线（未含 027–031 修复，git stash 对照）同样复现 `test/stage.test.mjs` 单例失败 1 次，证明与本次改动无关。
- 已尝试：单跑失败用例均通过；连续 4 轮全量全过；基线对照仍偶发。未修改测试超时或并行度，保持既有口径。
- 尚不能完成：将"全量并行零偶发"作为每轮验收的确定性标准；需定位是并行负载（fake-pi 子进程延迟 × 多用例同时启动）导致 waitTerminal 15s 边界偶发超时，还是用例间隔离问题。
- 仍可继续：027–031 修复由单文件复跑、连续多轮全量与审计探针验证；各任务验收以"连续两轮全量通过 + 单跑失败用例通过 + 探针复核"为准。
- 伪代码／暂定接口：无需代码占位。若 043 复验再命中，可考虑放大 `waitTerminal` 超时或显式降低 `node --test` 并行度；属测试基础设施调整，不改业务语义。
- 待用户决定：是否接受"偶发单例失败不阻塞修复验收，由 043 汇总观察"的口径；或要求先做测试并行度调整。
- 参考选项与影响：接受口径——修复推进不被测试基础设施波动阻塞；调整并行度——增加独立改动并需单独验证；串行全量——时间成本高。
- 用户决定及来源：尚未决定；按 AGENTS.md 既有授权默认采用"接受口径、043 汇总观察"。
- 恢复与验证：043 独立复验时统计全量通过率与失败项分布；若同一用例反复失败则升级为确定缺陷另行登记。

## B003（已修复，053待主 Agent 复核）029 锁混合重入失败回滚误删外层占用

- 关联任务：029（修复引入的实现缺口）、043（复验发现）、[053](tasks/053-lock-reentry-rollback.md)（授权修复）；下游影响：任何未来在同实例内混合重入键与新建键的 acquire 调用。
- 发现时问题与历史证据：修复前 `src/infrastructure/locks.ts` 的 `rollbackAcquire` 只按 owner 文件 token 匹配删除，不查 `heldBySelf` 重入计数。同一实例已持键 K（外层）时，`acquire({ keys: [K, 其他键], action 与外层相同 })` 中 K 计数 +1，其他键失败触发回滚会把 K 的锁目录整个删除。隔离探针实测（`validation/audit-fix-verification/lock-reentry.mjs`，委派053前重跑为14断言中2失败；后果探针 `lock-reentry-consequence.mjs`）：回滚后 `inspect(K).owner === null`，rival 实例可立即抢占该键，本实例重入仍自认持有（计数残留）。旧记录声称后续 release 链会误删 rival owner，未复现，已撤回该已确认后果表述；053已通过 token 保护回归。旧主探针场景间残留已由053修正隔离，并真实命中 owner 写失败。
- 现实触发面：当前产品代码中重入 acquire 均为单键调用（run-acceptance.ts 的 `run.accept.stage`、task-service 草案锁）；`orderKeys` 混合 [project, task] 的调用彼此 action 不同，不构成同键重入。因此当前主流程不可达，不推翻 029 修复与 043 复验结论，但破坏"跨实例仍互斥"承诺。
- 已尝试与结果（053，2026-11-02）：按本次实际完成步骤记录 `reentered`／`created`；mkdir 成功立即登记；失败逆序撤销重入引用、清理本次匹配内存持有记录与 token 允许删除的目录。新建 count=1 不会被当作既有重入跳过。
- 修复状态：053实施及规定验证已完成，B003已修复并经主 Agent 代码与证据复核通过；不扩大公共 API、owner 协议或成功路径 token 契约。M2中针对B003的临时混合重入限制已移除。
- 验证证据：新增核心回归修复前7项中4失败，修复后 typecheck/build通过、基础设施31/31、全量236/236（0跳过，本轮未出现B002）、`git diff --check`通过；隔离主探针47/47、后果探针8/8通过。mkdir 后 owner 写失败真实命中且原错误透传；外层 owner 不变、rival busy、真实外层释放后可重获，以及其它 token owner 不被 release 删除均已核验。原始日志保存在 `validation/audit-fix-verification/053/`；历史043验收报告不改写。
- 用户决定及来源：2026-11-02 本会话用户明确“重新创建一个新的任务，也就是44号……写清楚要怎么做……让其他的agent去改”；由独立 worker Agent 实施，主 Agent 复核。
- 后续独立缺口：成功混合申请时的新键先行多 token 问题另记 B004；它不属于本次失败回滚修复。

## B004 成功混合申请中新键先行导致单 token 句柄无法释放所有重入引用

- 来源与关联：053实施期间隔离复现；涉及 `src/infrastructure/locks.ts` 的 `acquire` 返回单 `token` 与 `release` 按该 token 撤引用。按053“另一个公共契约缺陷先记录、不扩大范围”的边界交接，未改成功路径策略或公共 API，未自行创建后续开发任务。
- 根因与证据：同实例先持 `project:/tmp/z-held`（action=`same`），再成功调用 `acquire({keys: orderKeys([heldKey, project:/tmp/a-new]), action: 'same'})`。新键先创建并决定返回 token，后续重入的既有键保留原 token。隔离实测 `returnedTokenMatchesOuter=false`、`ownerTokensDiffer=true`；依次 `release(mixed)` 和 `release(outer)` 后 `newKeyRemains=false`、`heldKeyRemainsAfterAllRealReleases=true`。两键同为 project scope，不依赖跨 scope 逆序获取。完整最小复现见053实施记录。
- 影响：该成功调用的混合句柄不能代表所有键的 token，真实句柄全部释放后仍留原键引用。失败调用回滚由053逐步骤记录正确撤销；B003闭合不等同解决此成功路径问题。当前产品同动作重入仍为单键路径，未证实主流程可触达。
- 尚待处理：选定同一次成功申请的 token 归并／拒绝策略，或调整每键持有凭据契约；需补新键先行、多个既有不同 token 与正常 heartbeat/release 的验收。本轮仅保留证据，不自行选方案。
- 伪代码／暂定接口：`held A(token1); acquire([new B, A]) -> {token2, keys:[B,A]}; release(handle) -> releases B but not A reference; release(outer) -> A count remains 1`。后续实现须令成功句柄能对称撤销每个实际获取步骤，并同步 heartbeat／release，不可只改失败回滚。
- 待决定：安排独立修复范围；其它开发与053验收可继续。修复前不新增同动作混合键重入业务路径，避免引入已确认的成功释放缺口。

## B005 任务规划资料分节 path 错误且实施／检查 worker 提示不渲染 planning 分节

- 关联任务：[046](tasks/046-role-aware-task-context.md)（规划资料入上下文的实现）、[049](tasks/049-discussion-planning-readiness.md)（实施交接依赖该链路）、[051](tasks/051-main-workflow-independent-gate.md)（独立验收发现）；下游影响：复杂任务实施／检查 worker 实际收到的阶段上下文。
- 问题与证据（051 独立验收，2026-11-03）：两处叠加缺陷，使 ContextPlan 中的规划资料分节（046 声称"plan.md／design.md 全文注入"）从未真正进入实施／检查 worker 提示：
  1. `src/application/context-planner.ts:282` 用 `taskRelative.split("/").slice(1, -1)` 计算任务目录名，而 `taskRelative` 形如 `.knit/tasks/<dir>/task.md`，切出的 `taskIdDirName` 含多余 `tasks` 段，导致 `planning-material` 分节与 excluded 记录的 `path` 为 `.knit/tasks/tasks/<dir>/plan.md`（真实文件在 `.knit/tasks/<dir>/plan.md`）。
  2. `src/application/stage.ts` 的 `loadSectionContents`（59–77 行）按该错误 path 读文件失败后静默 `continue`（规划分节与 research 分节全部落空）；且 `buildSystemPrompt`／`buildUserPrompt`（120/140 行起）只渲染 role/workflow/runtime/standard/task-inputs/progress/background，从不渲染 `kind: "planning-material"` 分节——即使 path 正确，plan/design 全文也不会出现在 worker 提示中。
  探针证据：`validation/main-workflow-gate/deterministic-probe.mjs` 场景7（5 项 FAIL：两角色分节 path 不指向真实文件、loadSectionContents 载入 0 个规划分节、实施提示不含 plan/design 正文；分节 sourceId/digest/bytes 本身正确，digest 按正确内容计算，冻结摘要语义未受污染）。
- 已尝试：核对既有测试（test/session.test.mjs 只断言 planning 分节 sourceId/bytes/digest，未断言 path 与 worker 提示内容，故未拦截）；核对 046 执行记录"plan 注入任务规划资料分节——plan.md／design.md 全文（required、mode=resource）"与 DESIGN §3.4/§4.2 的实施入口要求；验证 digest／冻结 inputs 摘要不受影响（planning 分节 countsTowardInputs=false，inputsDigest 由 task.md 计算）。
- 尚不能完成：051 的"实施交接：ready 后实施／检查上下文实际含规划资料"项——worker 只能靠角色指令自行用工具读 plan.md（task-inputs 分节头含任务目录路径），规划资料的分节注入在最后一公里失效；`required: true` 的分节加载失败被静默跳过，无 blocker 报告，违背 051"必需资料缺失不会跳过"的核对意图。
- 仍可继续：051 其余确定性链路（入口规则、创建／拒绝、澄清、进度与需求变更分流、ready 核对、跨会话接续、每轮注入）与真实宿主最小验证均通过；主会话每轮注入（047，桥接侧）不经 stage.ts，不受本缺陷影响。
- 伪代码／暂定接口：`taskIdDirName = taskRelative.split("/").slice(2, -1).join("/")`（或以 `.knit/tasks/` 前缀剥离）；`buildUserPrompt` 增加规划分节渲染（如 `sectionText(plan.sections, ["planning-material"], contents)` 并按 required/background 分层），`loadSectionContents` 对 required 分节读取失败时返回可核对的缺口而非静默跳过。
- 待用户决定：修复范围按 046 归属安排（最小改 path + 渲染，或同时为 required 分节补加载失败 blocker）；修复后 051 场景7 五项需复验通过。
- 参考选项与影响：仅修 path——research 可进 worker 背景，但 plan/design 仍不进提示，046 交付语义打折；修 path + 渲染——与 046 记录声明一致，worker 提示长度增加（plan/design 全文），需确认与"避免复制正文多份权威"的取舍；两者都不改摘要与冻结语义。
- 用户决定及来源：尚未决定。
- 恢复与验证：修复后重跑 `validation/main-workflow-gate/deterministic-probe.mjs`（场景7 全过）并抽查一次真实 worker run 的实际提示（或等价 buildUserPrompt 断言）。

- 用户决定及来源：用户授权按任务列表顺序执行全部任务；051 复验发现后由主 Agent 当轮修复（2026-11-03）。
- 恢复与验证：修复 `context-planner.ts`（目录路径切片改为 `.knit/tasks/<dir>`，去重复前缀）与 `stage.ts`（worker 提示装配 planning 分节：plan/design 全文进系统提示，research 摘要进背景区，不再静默跳过）。`npm run typecheck`／`npm run build` 通过；`node --test test/*.test.mjs` 242 项全过；独立确定性探针复跑 **85/85 全过**（场景7 五项转 PASS）。B005 已解决并关闭。