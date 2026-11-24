---
id: k-a0da2e253853
title: 内置规范和角色模板去掉本仓库的开发经验
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P1
createdAt: 2026-11-24T15:47:45.539Z
---

## 目标与范围

Knit 随安装包发布的内置规范和角色模板会进入每个使用 Knit 的项目。它们只管任务怎么讨论、拆分、编写和交付，不替项目决定代码和测试怎么写。11-24 这一天有几条本仓库自己的开发教训被写了进去，本任务把它们删掉，并把「完成条件不超过 3 个场景」这条硬上限换成按能否分开交付来判断。做完后，新项目拿到的内置文本里不再有 Knit 仓库的分层、测试策略和模块名。

用户已定的边界：

- 内置规范不允许项目用同名文件覆盖，这是现有行为，保持不变。内容有偏差就直接改内置文本。
- 项目自己的开发要求写在项目的 `.knit/standards/` 和 `AGENTS.md`。
- 本任务由主会话直接完成，不运行 `knit run start`，不用子智能体。

改动范围：

- `assets/standards/task-splitting.md`
  - 删掉「一个任务的完成条件不超过 3 个场景，超过就拆」。调查报告把它列为文件碎片化的第一根因，见相关资料。
  - 在原位置补两条防止任务过大的规则。用户已确认这两条，措辞可调整，意思不变：
    - 任务要小到一次能做完、一次能审完：审查的人对照完成条件能逐条核对实际改动。做不到就拆。
    - 按能不能分开交付来拆，不按场景数量拆：完成条件里有两组场景互不依赖、各自做完都能单独验证并交给用户，就拆成两个任务；同一个行为变化的多个边界情况留在同一个任务里。
  - 「拆分的是交付节奏与验收范围，不是源码模块或测试文件」保留，删掉冒号后面关于既有源码文件和主题测试文件的做法。
  - 「正确性没法自证的改动单独成一个任务，并要求独立审查」和「需要用户单独授权的操作单独成一个任务」两条保留，删掉其中 Knit 仓库自己的例子，改成由项目在自己的规范里列出。
- `assets/standards/task-writing.md`：「写清产出」一条只留到「不逐个文件、逐行列出」，删掉后面关于既有测试文件、领域层和应用层直测、CLI 冒烟的内容。
- `assets/templates/agents/implement.md` 和 `review.md`：各删掉第 3 步（碎片文件、重型 CLI 和子进程矩阵），后面的步骤重新编号。设计 6.2 已经写明角色文件和项目规范无关。
- `assets/templates/pi/extensions/knit.ts` 里 `knit_deliver` 的说明：`worktree.autoMerge` 关闭时写成按 `knit deliver` 输出给出的命令合并和清理。交付规范里那段操作说明已在 c87c529 删除，现在的「由主会话按交付规范用 Git 做」指向不存在的内容。
- `AGENTS.md`「本仓库开发与验证」：补上从内置规范删掉、而项目层还没有的两条，意思不变。状态推进、改动对比、受保护的路径、提交、授权核对的改动单独成任务并要求独立审查；全局安装、调用真实模型、手工提交各自单独成任务并取得授权。其余删掉的内容在 `.knit/standards/development.md` 和避坑清单里已有，不重复添加。
- `docs/design/DESIGN.md` 第 4 节：写明内置规范只管流程，项目的开发要求不进内置规范和角色模板。
- 有测试断言了被改的文本时，在原测试文件里更新。

不包含与延后：

- `assets/standards/discussion.md` 不在本任务里改，由 k-02534d8ecf04 处理。
- `assets/standards/delivery.md` 不改。
- 规范加载、初始化和交接的代码不改。
- `.knit/agents/`、`.pi/extensions/`、`.agents/` 下的生成副本不手改。本任务交付后要运行 `npm run pack:install` 和 `knit init --force` 刷新，再从备份恢复 `.knit/workflow.yaml` 的模型配置并运行 `knit workflow validate`，新文本才会在本机生效。这一步由主会话在用户单独同意后做。

## 完成条件

### Requirement: 内置规范只含流程管控的内容

#### Scenario: 拆分和编写规范不再带本仓库的开发做法

- GIVEN 读取 `assets/standards/task-splitting.md` 和 `assets/standards/task-writing.md`
- WHEN 运行 `grep -nE "不超过 3 个场景|主题测试文件|既有测试文件|领域层|应用层|CLI 仅做冒烟|状态推进|受保护的路径|全局安装|调用真实模型" assets/standards/`
- THEN 没有输出；拆分规范里有按能否分开交付判断任务大小的两条规则；两份文件的 `title` 和 `stages` 声明不变；`knit standards list` 仍列出四份内置规范

#### Scenario: 角色模板不再带碎片文件和测试成本的条款

- GIVEN 读取 `assets/templates/agents/implement.md` 和 `assets/templates/agents/review.md`
- WHEN 运行 `grep -nE "碎片|同主题|重型 CLI|子进程矩阵" assets/templates/agents/`
- THEN 没有输出；两份文件的步骤编号连续；报告格式、返工要求和结论定义不变

### Requirement: 工具说明和项目规范与删改后的内置文本一致

#### Scenario: 交付工具说明不再指向已删除的规范内容，项目层没有丢规则

- GIVEN 读取 `assets/templates/pi/extensions/knit.ts` 里 `knit_deliver` 的说明和根目录 `AGENTS.md`
- WHEN 核对文本并运行 `npm run typecheck`、`npm test`、`npm run pack:check`
- THEN `knit_deliver` 的说明不再出现「按交付规范用 Git 做」；`AGENTS.md` 写有哪些改动要单独成任务并独立审查、哪些操作要单独授权；三条命令都通过

## 待澄清


## 相关资料

- `docs/research/file-granularity-and-test-review.md` 第 7.1 节：把「不超过 3 个场景」列为碎片化第一根因的证据
- `docs/design/DESIGN.md` 第 4 节、第 6.2 节：规范和角色文件的现行设计
- `.knit/standards/development.md`：项目层已有的文件粒度和测试分层规则
- `.knit/standards/pitfalls.md`：项目层已有的测试成本经验

## 结果

主会话直接完成，没有派发执行者。

改动：
- task-splitting.md：删掉「完成条件不超过 3 个场景」，换成两条（一次能做完、一次能审完；按能否分开交付来拆）。删掉既有源码文件和主题测试文件的做法，以及独立审查、单独授权两条里 Knit 仓库自己的例子，改成由项目在自己的规范里列出。
- task-writing.md：「写清产出」只留到「不逐个文件、逐行列出」。
- implement.md、review.md：各删掉第 3 步，后面重新编号为 1 到 5。
- Pi 桥接模板里 knit_deliver 的说明：autoMerge 关闭时写成按 knit deliver 输出给出的命令合并和清理。
- AGENTS.md：补上哪些改动要单独成任务并独立审查、哪些操作要单独授权。
- DESIGN.md 第 4 节：写明内置规范和角色模板只管流程，项目不能同名覆盖。
- 没有测试断言被改的文本，测试文件未改。

验证：
- 场景 1：grep -rnE 对 assets/standards/ 无输出；两份文件的 title 和 stages 未变；用仓库构建运行 standards list 仍列出四份内置规范。
- 场景 2：grep -rnE 对 assets/templates/agents/ 无输出；两份文件步骤编号 1 到 5 连续；报告格式、返工要求和结论定义未改。
- 场景 3：knit_deliver 说明里「按交付规范用 Git 做」出现 0 次；npm run typecheck 通过；npm test 508 项 501 通过、0 失败、7 跳过；npm run pack:check 通过。

要说明的：
- 完成条件里写的 grep 命令缺 -r，对目录原样运行会报「Is a directory」。验证时加了 -r，匹配的表达式没变。
- npm test 第一次运行有失败，出在 test/run-pane.test.mjs（Rex 窗格测试，本次没有改它，也没有改它测的代码），没有记下失败数；原样重跑一次 0 失败。这个文件此前在 Rex 终端里也偶发失败过。

Not verified：全局安装包和本仓库的生成副本（.knit/agents/、.pi/extensions/）还是旧文本，要等用户同意后运行 npm run pack:install 和 knit init --force 才生效。
