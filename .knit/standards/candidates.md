# 规范候选

<!-- knit:candidate:start id=c-9bb9ed19ed83 -->
## 任务里的路径限制必须有强制依据，成对副本同改

### 来源

run-d0b0bc1ffacb 实施中 worker 报告的约束冲突；用户要求制定不再出现此类冲突的规范

### 问题

主会话在任务 k-185ace3b9556 里写了“worker 不改 .pi/extensions/knit.ts”，理由是凭印象写的，没有对照代码。实际上核心不保护该路径，而四处测试要求它与模板逐字一致。于是任务约束和“npm test 全通过”这条验收互相矛盾，worker 照约束做就无法通过验收。

### 证据

核心只拒绝 .knit/ 前缀下的改动（src/application/stage-runner.ts:1363）。逐字比对两份桥接的测试：test/m1-cli.test.mjs:362、test/host-selection.test.mjs:427 与 438、test/init.test.mjs:680。逐字比对 AGENTS 受管块：test/init.test.mjs:617。逐字比对流程模板与内置默认流程：test/init.test.mjs:112。

### 适用范围

本仓库（Knit 自身开发）的任务编写与派发；不进入 knit init 的产品模板

### 建议规则

1. 任务里写“不得改某路径”时，必须写出强制它的机制和位置（核心守卫的代码位置，或失败的测试）。找不到强制机制的限制不写。开发阶段不对 worker 另设路径限制。
2. 成对副本在同一次改动里由同一个执行者一起改，不拆给两方先后做。目前有三对：assets/templates/pi/extensions/knit.ts 与 .pi/extensions/knit.ts；agentsManagedBlock() 与 AGENTS.md 受管块；assets/templates/.knit/workflow.yaml 与内置默认流程。新增由测试逐字比对的副本时补进这份清单。
3. task ready 之前，把每条限制和每条验收对一遍：遵守全部限制时，全部验收是否仍能通过。“npm test 全通过”要单独核对，方法是搜索测试里对受限路径的读取。
4. 任务需要改 .knit/ 下受核心保护的文件时，由主会话改，并在任务里写明没有测试依赖这些文件；有测试依赖时先解决依赖再派发。

### 验证／示例

派发前执行 grep -n '"\.pi"\|"AGENTS.md"\|"\.knit"' test/*.mjs，确认任务限制的路径没有被测试读取；任务的「依赖与交接」里每条限制后面都带代码位置或测试位置。
<!-- knit:candidate:end -->
