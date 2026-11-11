# 场景化完成条件实施与检查计划

需求权威为 task.md「目标与边界／关键决定／完成条件」，已获用户批准；本计划只记录方案、进度与交接，不新增验收。

此前交接计划保留了早期“中文前置／操作／预期、按名称匹配”的提议，与 task.md 最终确认方案不符，现予替换。最终方案是 OpenSpec 兼容的 Requirement／Scenario 与 GIVEN／WHEN／THEN／AND 写法，编号 Rn.Sm；只借用格式，不接入 OpenSpec CLI、依赖、长期 specs／change／proposal 目录或归档合并模型。worker 的实际实现与报告按最终 task.md 执行。

## 实施方案

1. 在任务输入区的 `## 完成条件` 内解析三级 `Requirement: `、四级 `Scenario: ` 标题与顶格步骤；忽略围栏代码块和普通自由内容，按文档顺序生成 Rn.Sm 编号，报告 task.md 指定的全部结构错误。
2. `task ready` 统一结构守卫：结构错误报 `scenarios_invalid`；independent 且场景为零报 `scenarios_required`；self／none 可用自由列表，成功输出数量。原有 blocking 核对与输入冻结保持不变。
3. 阶段提示从本 run 冻结的任务输入生成场景清单；仅声明 `scenarios` 且任务有场景的阶段要求逐场景报告。
4. 共用报告核对：条目为 `<编号> <pass／fail／not_verified>：<证据>`，所有结论都须完整覆盖，整体 pass 要求全部条目 pass；格式、漏项、不一致分别用 task.md 指定的三个原因码；不改变 coverage 与 check_scope_incomplete。
5. 同步默认 workflow、任务模板、实施／检查／Pi runtime 模板、AGENTS 受管块、成对 Pi 桥接与设计／操作／术语／研究文档；不建设旧任务迁移或兼容分支。
6. 补充 R1–R6 正反例与接收／补报测试，适配旧夹具；Rex 与普通终端分别全量 npm test，另起全新正式 independent check，不用非正式 --scope 或 task implement 代替。

## 当前进度

- [x] 任务已创建，最终需求与完成条件已批准、ready 已完成；verification=independent。
- [x] 本仓库 `.knit/workflow.yaml` 检查报告已声明 `scenarios: string[]`；模板 tools 放宽漂移按用户决定还原。
- [x] 已取证并移除桥接 `.pi` 禁改的错误文案；`.knit/` 受管规范／配置／流程／提示词与 `.git` 敏感区的真实核心保护保持不变。
- [x] 原 run `run-d0b0bc1ffacb` 因 `rex_worker_error:Claude: Service Unavailable` 失败并已接收 run_failed。原执行已停止，失败后追加代码保留，不因失败结果 actualChangedPaths=[] 认定没有产物。
- [x] 新实施 run `run-4725f81f73af` 已 completed 并接收 implementation_accepted；Pi 原生会话 `2f419d04-acfb-43b6-bf71-3ead8e454530`，resumeAction=create_new。37 个实际路径均有原生会话归属，无未知／外部路径，无 protectedPaths，HEAD 与 index 未变；忽略区仅报告 dist/ 修改。
- [x] worker Rex 终端 npm test：719 tests、719 pass、0 fail，245132.699459ms；日志 `/tmp/knit-scenarios-verified-test.log`，实施记录已写入 task.md 进度区。
- [x] 主会话核对四个本轮未修改的旧成果：当前差异与接续前备份的对应补丁反向 check 一致（exit=0）；已通读四文件差异及其与最终任务场景的对应。
- [x] 主会话普通终端全量 npm test 复验退出 0：719/719 pass、0 fail、236874.347792ms；首次 718/719 的观察器清理 ENOTEMPTY 失败原始日志保留。相关单例五次独立复验均 pass；没有改代码，不宣称清理竞态已修复。
- [x] 已通过 Knit task implement 仅补录四条遗留成果和四项实际验证；记录 scopeDigest=7a4308aa137b8c8943a35272a0d7ac715fa15a2702fdabaac728e1b46bb13fd0。和正式新 run 的 37 路径合计核对 41 条业务成果，verification 仍 independent；未改失败结果或 native scope。
- [x] 已用本次构建的本仓库 CLI 派发正式独立 check `run-bc7506733800`，显式 resume=new，Pi 原生会话 24655541-fa0c-42b1-990f-76fd430cfc1a，与实施会话不同；未用 --scope。
- [x] 正式独立检查 completed/pass，接收 check_pass；35/35 场景均 pass，coverage 41 路径，changedPaths=[]，无 findings／blockers／protectedPaths／忽略区变化。主会话已通读报告，核对全部编号、证据与边界。检查在与成果逐字节一致的 Rex 隔离副本再次全量 npm test：719/719 pass、0 skipped、退出 0，271257.966625ms。
- [x] 业务完成后正常关闭任务，按模板同步受保护的 `.knit/agents/` 副本，核对成对副本与规范候选，完成实际普通终端／Rex 验证并展示提交文案。
- Git 交付独立于业务完成：按用户授权分开提交产物与任务资料并推送；实际执行状态由主会话工作计划和 Git 记录反映，本行不是预填的成功回执。

## 完整成果与归属

新实施 run 的 37 个 actualChangedPaths 与 native toolPaths 完全一致，详情见其正式 result.json。以下四个文件是前一 run 失败后继续写入的既有成果，新 run 仅检查未编辑，不能虚报为新 run 的改动：

- `src/application/stage.ts`：冻结输入场景清单、阶段要求、报告形状与补报提示。
- `src/domain/workflow.ts`：内置默认检查阶段声明 scenarios 及条目注释。
- `src/cli/task.ts`：ready 成功时输出场景数量。
- `assets/templates/.knit/workflow.yaml`：与内置默认流程保持一致。

主会话保留原会话取证与差异备份 `/tmp/knit-session-handoff-ts14l3da/`，以 Knit 的实际记录补齐遗留成果，不通过无意义编辑或手改 runtime 来造归属。`task implement` 仅补录已接管的四条遗留成果与实际验证，不替代正式实施 run，不取消 independent，不跳过场景验收。

## 独立检查交接

- 以最终 task.md 为权威，逐个验收 R1–R11 的每个场景，不把本计划旧稿、worker 自检或 todo 当作通过证据。
- 检查范围是全部 41 条业务成果：已接收的新 run 37 路径，以及上述四个由主会话补录的旧成果。coverage 应包含全部实际核对路径，不遗漏旧成果；scenarios 按核心注入清单完整逐项报告。不得用 --scope 的非正式检查替代。
- 本次产品源代码及 dist 已有新的解析、提示与报告守卫；项目安装记录仍指向未更新的全局 CLI。因此主会话用 `node dist/cli/knit.js run check --task ... --resume new` 启动本次构建的正式 worker，确保本任务自身检查使用新规则；不执行全局安装、不改 installation.json。
- 模型可沿用本次可用的 `magpie/group/openai`，实施与检查必须不同的新 Pi 原生会话。不要恢复旧实施会话，也不对旧长会话发送 compact。
- 只读检查，不修改产品、测试、文档、受管配置或输入；验证可在隔离夹具和 /tmp 执行。发现问题据证给 changes_requested／blocked，不自行修复或为了 pass 弱化验证。
- 必查 task.md 每项边界：围栏、输入区终点、近似标题、重名、空名、空步骤、结构错误 ready 不冻结、self／none 自由列表、声明字段生效边界、三种报告错误、既有路径覆盖保持、补报同会话及编号名称提示、成对模板与文档事实。
- 普通终端与 Rex 的全量 npm test 应记录真实命令、退出码和计数。测试脚本主动清理 Rex 环境是既有测试隔离规则，不能据此混淆命令实际运行在哪个终端。

## 主会话收尾边界

- `.knit/config.json` 的既有 reportRetries: 1 来源未确认，保持原样，不计入本任务成果。
- `.knit/workflow.yaml` 的 scenarios 字段为先前主会话获批的配置改动，任务检查继续按该字段执行；worker 不改受保护的 .knit 副本。
- 关闭后按最终模板直接覆盖 `.knit/agents/check.md`、`.knit/agents/implement.md`，必要时同步已修改的 Pi runtime 副本；这些本仓库配置与任务资料和工作产物分开提交。
- 旧会话“约束须注明强制来源”候选已审阅，回执 r-7afda7cc131a，decision=deferred：代码／测试不是用户授权与业务约束的唯一来源，同一执行者同步副本也须区分受保护的阶段资料和关闭后主会话同步。不原样采纳，不改正式规范摘要，候选不阻塞本任务提交推送；本任务 .pi 错误限制已修正，真实保护保持。
- 真实用户项目／外部模型、macOS 安装运行验收仍按用户决定延期；开发机 npm test 通过不代表已完成它们。
- Knit deliver 会同时封存与归档；用户本次仅授权提交推送，任务不自动归档。因此在有效业务关闭后用宿主 Git 定向提交 41 条产物及本任务资料／主会话已批准的配置副本，保留无关改动，并在提交文案中注明 Task／Stage／Verification。不得伪造 Knit delivery 操作或归档回执。
- 用户在本会话明确授权“测试通过就提交推送”，authorizationRef=user:sha256:92b97b54f1671078daa8b0bf70607fed266b83ac70a6c4fe21c7cc34ddd8d20c。在全部实际测试与正式独立检查通过后提交、推送当前任务；产物与任务资料分开提交，不混入来源不明的 `.knit/config.json` 修改，不强制推送。发布、部署和全局安装仍未授权，不执行。

## 收尾实际验证（2026-11-11 11:32）

- 本次构建 CLI 正常关闭任务：closed／completed／deliver，verification=independent，forced=false、unverified=[]；未归档。
- 关闭后由主会话同步 .knit/agents/check.md、implement.md、runtimes/pi.md，三文件与已独立检查的模板逐字节一致，workflow validate 通过；原副本备份在 /tmp/knit-session-handoff-ts14l3da/protected-copies-before/。
- 额外直接 node --test 的调用没有遵循仓库脚本的环境／密钥隔离，6/8 pass、两个 fake-worker 用例未收敛；不能记为通过，日志 post-sync-scenarios-test.log 保留。其后标准 npm test 已包含并通过这些用例，不改代码、不虚构修复。
- 之前 env -u REX_* 的 719/719 数据是真实脚本复验，但仅凭清空变量不足以证明物理普通终端。补充实际 Terminal.app：窗口 12635，TERM_PROGRAM=Apple_Terminal（488.9）、tty=/dev/ttys007，cwd 为本仓库，Node v26.3.0，执行原 npm test（typecheck／build／独立 KNIT_KEYS_ROOT／env 清理）；719 tests／719 pass／0 fail／0 skipped，238869.374ms，退出 0。用户允许 Terminal 自动化后才启动，未绕过系统许可。
- 实际普通终端日志 /tmp/knit-session-handoff-ts14l3da/ordinary-terminal-npm-test-final.log，结果 ordinary-terminal-npm-test-final.json；此前 Rex 实施全量 719/719、独立 checker Rex 隔离副本全量 719/719 的证据保留。原 ENOTEMPTY 清理竞态未修复，真实项目／模型和 macOS 安装验收仍延期。
- 提交前范围核对：41 条业务成果、8 条任务／流程／提示词／候选资料，另 1 条来源不明 .knit/config.json 排除；无未知或缺失路径，未使用 git add -A。
- Git 使用真实宿主操作，按配置缺省 skip 使用私有空 hooks 目录，不更改仓库配置；遵循 Knit-Task、Knit-Stage（artifact／metadata）、Knit-Verification 来源。未创建 Knit delivery，因此不伪造 Knit-Operation、封存或归档回执。实际提交与推送结果以主会话及 Git 记录为准，不预填成功。

## Git 产物实际提交

- 宿主 Git artifact 提交：66f2d3f1c4e585e04efb214817166cd441aad139（66f2d3f），父节点 c5dab24573a44d34a500d41ebd2db5b20a9d3471；41 路径集合和全部提交 blob 已逐项核对，未混入元数据或 config。
- 采用原用户授权，hooks skip；不冒充 Knit delivery operation。元数据另行提交，推送随后执行，实际结果以主会话与 Git 为准。
