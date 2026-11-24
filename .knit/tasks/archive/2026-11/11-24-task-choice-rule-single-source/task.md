---
id: k-02534d8ecf04
title: 「要不要建任务」的规则只留在讨论规范一处
status: delivered
stage: null
verification: self
parent: null
dependsOn:
  - k-a0da2e253853
priority: P1
createdAt: 2026-11-24T15:56:16.585Z
---

## 目标与范围

主会话什么时候该问用户「要不要建 Knit 任务」，现在写在三处：内置讨论规范的「从讨论转入实施」和「谁来做」两节、没有选中任务时每轮注入的结尾提示、Pi 的 `knit_task` 工具说明。三处文字不同，改一处就要同步另外两处，bf0108a、8595bef、c1c58f4 两天内为它改了三次。讨论规范本来就每轮注入主会话，另外两处是重复。

做完后，这条规则只在 `assets/standards/discussion.md` 里有，另外两处只说各自的事。规则的意思不变：哪些情况直接做、哪些情况先问、用户答复之后怎么处理，都照现在的讨论规范。

用户已定的边界：

- 本任务由主会话直接完成，不运行 `knit run start`，不用子智能体。验证方式是 `self`。
- 内置规范只管流程，不带 Knit 仓库自己的例子。

改动范围：

- `assets/standards/discussion.md`
  - 「从讨论转入实施」和「谁来做」两节是规则的唯一出处。合并时发现两节之间、或者和另外两处之间有互相矛盾的说法，停下来报告，由用户定以哪个为准，不自己选。
  - 例句「这次会改到规范加载、初始化和执行者交接，要为它建一个 Knit 任务吗？」换成不带 Knit 仓库模块名的说法。
  - 「谁来做」补一条，用户已确认：用户说由主会话直接做时就直接做，不派执行者，本节的派发条件不再适用。要求独立审查的任务这时先问用户：改成主会话自查，还是只派审查。这条规则来自一次取消的设计：原想在 `.knit/workflow.yaml` 加开关来关闭派发，用户判断在对话里说明就够，不加配置（k-c0aaabac429a 已取消）。
- 每轮注入的结尾提示：没有选中任务时只说没有选中任务、怎么查看和选中。涉及 `src/application/work-choice.ts` 和 `src/application/host-hook.ts`，以及 Pi 桥接模板 `assets/templates/pi/extensions/knit.ts` 里的同一段。`work-choice.ts` 只导出这一段文字，没有内容了就删掉这个文件。
- `knit_task` 工具说明：只写每个动作做什么、要哪些参数、返回什么，包括 `new` 建的是草稿、不改变当前选择。什么时候该建、建了之后怎么确认，不在这里写。
- `docs/design/DESIGN.md` 第 9 节里描述每轮注入和工具说明的两段、`README.md` 里对应的说明，按改后的行为更新。
- 断言这段文字的测试在原文件里更新：`test/bridge.test.mjs`、`test/host-hook.test.mjs`、`test/work-choice.test.mjs`。

不包含与延后：

- 不改三个宿主的建草稿入口、任务选择、交付授权核对的行为，只改文字放在哪里。
- 不用真实模型验证主会话是否照规范提问。少了结尾提示和工具说明里的重复之后，模型是否仍然会在该问的时候问，只能在日常使用里观察；发现变差时再议，不在本任务里补回重复。
- `.pi/extensions/knit.ts` 等生成副本不手改。交付后要运行 `npm run pack:install` 和 `knit init --force` 才会在本机生效，这一步由主会话在用户单独同意后做。

## 完成条件

### Requirement: 建任务的规则只有一个出处

#### Scenario: 源码和宿主模板里不再有这条规则

- GIVEN 本任务的改动已完成
- WHEN 运行 `grep -rnE "是否建 Knit 任务|委派条件|建任务选择" src assets/templates`
- THEN 没有输出；同样的关键词在 `assets/standards/discussion.md` 里能找到

#### Scenario: 没有选中任务时，注入内容仍带讨论规范，结尾只说怎么查看和选中任务

- GIVEN 一个 `knit init` 过、没有选中任务的临时项目
- WHEN 通过宿主钩子和 Pi 桥接取每轮注入的内容
- THEN 内容里有讨论规范全文；结尾提示只有「没有选中 Knit 任务」和查看、选中任务的办法；`knit_task` 的说明里每个动作的用法都在，没有何时该建任务的判断条件

### Requirement: 改动不影响现有行为

#### Scenario: 全量验证通过

- GIVEN 本任务的改动已完成
- WHEN 运行 `npm run typecheck`、`npm test`、`npm run pack:check`
- THEN 三条命令都通过；`assets/standards/discussion.md` 里没有「规范加载、初始化和执行者交接」，「谁来做」一节写有用户说由主会话直接做时不派发

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` 第 5.1 节：主会话每轮收到讨论规范的设计
- `docs/design/DESIGN.md` 第 9 节：每轮注入和工具说明的现行描述
- `assets/standards/discussion.md`：规则的唯一出处

## 结果

主会话直接完成，没有派发执行者。

改动：
- Pi 桥接模板：删掉 WORK_GUIDANCE 常量。knit_task 的说明只写每个动作做什么、要什么参数、返回什么。没有选中任务时的结尾提示只剩「没有选中 Knit 任务」和怎么查看、选中。
- src/application/host-hook.ts：结尾提示同样只剩查看和选中的办法。src/application/work-choice.ts 只导出那段文字，已删除。
- discussion.md：例句换成不带 Knit 仓库模块名的说法。「谁来做」补一条：用户说由主会话直接做时不派执行者，任务要求独立审查时先问用户改成自查还是只派审查。
- 工具说明里有两句是讨论规范原来没有的，移进了「从讨论转入实施」：用户明确要建任务时才建草稿；创建失败时说明原因，讨论照常继续。
- DESIGN.md 第 9 节、README.md：按改后的行为更新。
- test/bridge.test.mjs、test/host-hook.test.mjs：按新文本更新断言。test/work-choice.test.mjs 没有断言这段文字，未改。

合并时没有发现三处之间互相矛盾的说法。

验证：
- 场景 1：grep -rnE "是否建 Knit 任务|委派条件|建任务选择" src assets/templates 无输出；同样的关键词在 discussion.md 里有 1 行命中。
- 场景 2：test/bridge.test.mjs 断言 Pi 注入内容等于 knit context 的输出加新的结尾提示，并断言 knit_task 说明含六个动作的用法、不含建任务的判断条件；test/host-hook.test.mjs 断言钩子注入含讨论规范、最后一行是新的结尾提示。两个文件连同 work-choice、context、standards 共 46 项全部通过。
- 场景 3：npm run typecheck 通过；npm test 508 项 501 通过、0 失败、7 跳过；npm run pack:check 通过；discussion.md 里「规范加载、初始化和执行者交接」出现 0 次，「谁来做」有新补的一条。

Not verified：
- 没有用真实模型验证主会话在少了重复提示之后是否仍然会在该问的时候问，这一项在任务里写明延后到日常使用中观察。
- 全局安装包和本仓库的生成副本（.pi/extensions/knit.ts）还是旧文本，要等用户同意后运行 npm run pack:install 和 knit init --force 才生效。
