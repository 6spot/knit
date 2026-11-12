# 执行计划

## 续接事实与边界

- 续接用户指定会话及任务 k-e8730699375d。用户要求子 Agent 使用 DeepSeek 实施并测试，主会话只验收。
- run-157bf768958f 与 run-2c54709c7fe4 已失败并完成接收；后者遗留部分实现。继续当前工作区，不重置或覆盖其它任务改动。
- 模型逐 run 显式指定 provider=magpie、model=group/deepseek；不改 `.knit/config.json`、工作流、提示词、规范或全局 Pi 配置。
- 目标与完成条件只以 task.md 为准，实现建议以 design.md 为准。本计划不增加或改写需求。
- 授权不含 Git commit/push、真实 Pi 体验验收、发布或部署。普通 npm 测试与 Rex 终端中的 npm 测试不等同于真实 Pi 验收。

## 步骤

- [x] s1 核对任务与既有实现；两份桥接当前逐字一致。
- [x] s2 当前 implement 上下文 ready=true，无 blockers；沿用已确认输入。
- [x] s3 DeepSeek 实施者读取 task.md/design.md、仓库规则及相关 Pi 文档；核对失败 run 的残留，补齐实现、测试及文档。目标路径为 `assets/templates/pi/extensions/knit.ts`、`.pi/extensions/knit.ts`、`test/bridge-query.test.mjs`、`test/host-selection.test.mjs`、`docs/design/DESIGN.md`；需要的验证记录可放 `validation/bridge-notice-display-only/`。其它文件已有改动并不属于本任务，不得顺手修改。最终 changedPaths 如实声明继承的失败 run 残留路径（即使本 run 不必再修改且指纹未变），并列出本 run 实际写入路径。
- [x] s4 主会话已核对实施结果、任务相关差异、桥接一致性与全量日志；细节交独立检查复核。
- [x] s5 独立 DeepSeek check 已接收 check_pass：六个场景全部 pass，未改项目文件。
- [x] s6 已核对业务状态 closed/completed，验收事实已记录，提交文案已起草并随结果汇报展示；未提交、未归档。

## 实施与验证要求

- 先检查当前部分改动，不为产生 diff 而修改；模板与项目桥接必须逐字一致，保留同文件其它任务既有改动。
- 保持 needsAction 分类、followUp/triggerTurn 与去重语义；被动通知只 appendEntry，entry renderer 只渲染带 text 的记录。完整验收按 task.md 的 6 个场景。
- 执行任务声明的 `node --test test/bridge-query.test.mjs test/host-selection.test.mjs`、`git diff --check` 和桥接 cmp。遵守 AGENTS.md，在普通终端和 Rex 终端各实际运行一次 `npm test`，保留退出码与汇总；Rex 操作先读 `/Users/me/.agents/skills/rex/SKILL.md`，使用新建专用测试块，不打扰用户其它终端。环境不支持或命令失败如实记录，不能宣称全绿。
- 修改前按 harness 规则读相关 Pi extensions 文档及示例；无需静态引入外部 TUI 依赖或修改 package.json。
- 最终报告记录逐场景证据、实际测试命令/结果/日志路径、changedPaths、未验证项，以及未做真实 Pi 验收的边界。

## 实施与主会话验收证据（run-0b840b46685b）

- run completed，implementation_accepted，阶段进程 exited/not_alive；实际 provider/model 为 magpie/group/deepseek。
- 本 run 实际新增验证记录 `validation/bridge-notice-display-only/README.md`；接收明确继承前次失败 run 的五个残留路径（两份桥接、DESIGN、两份测试）。externalChanges 为空，dist/ 只报告构建产物变化。工作区其它任务改动保留。
- 对照 run-2c54709c7fe4 快照，任务相关差异是 noticeCard/renderer、通知分流、桥接测试与 DESIGN §9.3；host-selection 的基线来自 HEAD（快照标注 source=head，无额外 files/ 副本）。两份桥接 cmp 返回 0。
- 原生实施会话实际分别执行定向测试：bridge-query 23/23 pass，host-selection 11/11 pass，均 exit 0（合计 34）。另组三文件测试 52/52 pass；typecheck、build、diff --check 均 exit 0。result.json 中的“40 passed”是计数误记，不采信该数字；验证 README 与原生输出均为正确的 23＋11。
- 已读普通终端日志 `/tmp/knit-npm-test-normal-1794497851.log`：739 tests，739 pass，0 fail，0 skipped。实施报告及 Rex 捕获记录记 exit 0。
- 已读 Rex 终端日志 `/tmp/knit-npm-test-rex.log`：739 tests，739 pass，0 fail，0 skipped，末尾 `REX_TEST_EXIT:0`。使用了专用新测试块；块结束后已关闭，不再次发送输入。
- 真实 Pi `/reload` 与目视卡片仍属延期项，不宣称已验证。

## 独立检查交接（s5）

- 使用新的 magpie/group/deepseek check run，主会话只验收；只读项目，不提交、不改配置，不做真实 Pi 体验验收。
- 以 task.md 的 R1.S1、R1.S2、R1.S3、R2.S1、R2.S2、R3.S1 为准逐项给出证据；必须独立核对实现，不能仅转述实施报告。
- 重新跑定向测试、diff --check、cmp，并核对上述两份全量测试日志与退出状态。默认不重复两遍全量测试，发现相关风险再自行选择必要验证。
- 核对被动通知无 sendMessage、原生 custom entry 不进入任何轮上下文、需处理 followUp/triggerTurn 未改变、条目与消息不重复；核对失败、取消及结果待接收分类、去重和续接。
- 现有 loader 测试主要走无 TUI 包的 fallback；独立核对实际 TUI Box/Text/Spacer 分支与宿主默认 custom message 的一致性，关注缺少 theme 方法、窄宽度、无 text 条目与前置空行。可使用安装包库做临时隔离探针，但不得启动真实 Pi 或把延期目视验收说成已完成，不增加仓库依赖。
- 发现缺陷返回 changes_requested，交实施者修复，主会话不代改；没有执行或不能验证的项目如实列入 unverified。

## 独立检查与最终验收（run-adaac0bd1a31）

- 新原生会话 f81b571c-6d08-47ca-bc19-5b5ef067173d，实际 magpie/group/deepseek，与实施上下文独立；终态 completed/pass，接收 check_pass，进程 exited/not_alive。
- R1.S1、R1.S2、R1.S3、R2.S1、R2.S2、R3.S1 全部 pass；scope 六个路径分别覆盖，actualChangedPaths 与 externalChanges 为空，selfVerified=false。
- 独立实际测试输出：bridge-query 23/23、host-selection 11/11；m1-cli/scenarios/init 合计 52/52；typecheck、diff --check、cmp 均通过。
- 初次在 check worker 环境下出现 stage_context_forbidden；清除 KNIT_RUN/KNIT_STAGE_RUN_ID 与 Rex 测试环境变量后通过，根因是隔离夹具继承检查阶段约束，并非通知实现错误。首次失败与后续通过均保留在原生会话，不隐去。
- 使用临时 jiti 安装包库探针核对实际 TUI、空/旧条目隐藏、Theme 方法缺失容错；加 FORCE_COLOR 后标签样式与宿主默认一致，文本、间距与背景布局一致。并未执行真实 Pi 或目视验收；不声称 ANSI 字节完全相同。临时探针已清理。
- 主会话复核原始测试摘要，确认 34 而非实施结果文字中的 40；验证 README 不需修复。输入与实现范围不变，无需新修复周期。
- 真实 Pi /reload、卡片目视及流式插入位置仍按 task.md 延期；Git 提交/推送/归档尚未授权，不执行。

## 收尾状态与提交草案

- task.md 已为 status=closed、stage=deliver、outcome=completed、verification=independent；正常 close 查询返回 task_not_open，没有重复关闭，也没有使用 force。
- 本次只完成业务与验收；既有脏工作区保留。没有 Git commit/push、发布、部署、归档或真实 Pi 验收操作。

提交文案草案（尚未执行）：

```text
fix(pi): 被动 Knit 通知只展示，不进入模型上下文

- 通过 custom entry 与 entry renderer 展示被动通知
- 保持需处理通知的 followUp/triggerTurn 及去重语义
- 同步桥接测试与 DESIGN §9.3
```
