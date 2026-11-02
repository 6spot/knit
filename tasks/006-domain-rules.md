# 006 实现纯领域状态与检查资格

- 里程碑：M1
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[005 验证宿主桥接准入并收敛M0](005-pi-host-admission.md)
- 实际依赖：[002](002-contracts-and-ports.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。 不以005模型／宿主准入未过阻止纯领域开发。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

将既定Task、运行、检查与修复规则落为纯函数和可穷尽类型。

## 先读

先遵守根 [AGENTS.md](../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [STATES.md](../STATES.md)：第1–6、10–12节。
- [DESIGN.md](../DESIGN.md)：第3、5、10–11节。
- [ARCHITECTURE.md](../ARCHITECTURE.md)：领域层及写入权威。

## 实施范围

- 实现四环节、业务结束／交付区别、clarify/change与deliver stale回open/check。
- 实现最新检查候选不回退、scope累积、正式与advisory区别、两轮修复与显式新周期。
- 实现关闭／迟到结果、已取消／归档不隐式重开、待应用输入的必要守卫；新Session不改变业务状态。
- 区分业务摘要、分支／成果版本与运行事实，避免换模型／纯记录误使检查失效。

## 交付物

- 纯领域规则、明确的决定／原因码
- 以不变量为中心的单元验证

## 完成前必须验证

- 覆盖会改变业务或交付资格的合法／拒绝路径，避免为每事件机械造四倍矩阵。
- 验证不导入fs、Git、Pi或UI；模型自报phase／次数不能成为权威。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不把所有观察值升为持久状态，不写仓储或CLI处理器。
- 保留现有工作区和前置任务记录；不自动提交／推送当前仓库，不操作其它真实仓库，不初始化当前工程的产品 .knit/ 或 .pi/。
- 本文件是开发排程，不是Knit产品Task；文件任务不预定产品元数据后端。

## 阻塞时的伪代码交接

遇阻塞先保留已做工作，按 [BLOCKERS.md](../BLOCKERS.md) 记录后继续其它可做任务。未定部分可写伪代码／暂定接口供下游开发，但不能当真实实现或验收成功。

- 关联阻塞编号：无；发生后引用真实编号。
- 未实现部分与影响：尚无记录。
- 暂定输入／输出／错误边界：需要时据实填写。
- 伪代码与关键步骤：需要时填写，明确哪些只是设计。
- 解除阻塞后补做与真实验证：需要时填写。
- 使用该暂定接口的下游任务：需要时记录，便于后续回补。

## 执行记录

以下是事实记录，不另存一份任务状态；状态只改根 TASKS.md。

- 执行者／Session：ZCode（Pi session 01a1981c-6f75-749d-b9c2-7e5c897950a6）。
- 开始／结束时间：2026-11-01。
- 实际修改：新增 src/domain/{task,check,repair}.ts 与 src/domain/README.md 模块表；新增 test/domain.test.mjs；STATES.md 第 8 节补一句失败检查 run 资格语义（回到 missing）；TASKS.md 006 状态。
- 实际验证命令与结果：`npm test` 58/58（domain 23 + contracts 17 + cli 5 + pi-runtime 12 + metadata 6，其中 typecheck+build 先行）；`npm run pack:check` 通过。domain 模块导入仅类型互引（task↔check↔repair），无 fs/Git/Pi/UI 依赖。`node --test test/domain.test.mjs` 23/23。
- 覆盖说明（按不变量造用例，不机械四倍矩阵）：
  - Task 转移：ready/实施接受/检查接受仅合法 phase 推进；pass→deliver、changes_requested→implement、blocked 保留；clarify 保持早期 phase、deliver 摘要变化回 open/check 清 completed、摘要未变不迁移；change 回 open/discuss；recheck 仅 check/deliver 合法、discuss/implement 明确 phase_mismatch；未归档 completed 仅显式复查入口重开；取消／替代所有常规入口拒绝（稳定原因码）；待应用草案阻止代码阶段与交付，但草案应用自身不被草案守卫拦住；adopt 保持 discuss/implement/check、deliver 回 open/check 清 completed；关闭保留停止位置。
  - 不变量断言：每条转移验证 open 无 outcome、closed 必有 outcome（STATES §3）。
  - 检查资格：missing（无候选／凭据缺失／run 状态未知）、pending（检查未结束，不可借旧 pass 收尾、不可开实施）、valid（全匹配 pass）、blocked（changes_requested/blocked/证据缺失）、stale（任务／分支／输入摘要／成果版本任一失配）；候选错位返回 superseded_by_newer_check 不静默通过；失败检查 run 回 missing。
  - 修复计数：上限 2 时第三轮拒绝并写 stopReason=repair_round_limit；clarify/resume 不重置不累计；周期错位拒绝（取消旧 run 不影响新周期）；停止后迟到事件拒 cycle_stopped；新周期授权清零清 stopReason；上限 0 与非法上限。
- 实施中纠正的事实：转移函数初版守卫拒绝时返回 null，测试要求稳定原因码后改为返回 TaskTransitionResult；草案应用（onPendingResolved）不应被草案存在守卫拦截（应用是解决路径）；已接纳后失败的检查 run 资格语义在实现中定为回 missing（比"凭据本身判定"更保守），已回写 STATES §8；测试 .mjs 文件一度误用 TS type 导入语法（已知陷阱），改为纯 JS。
- 证据位置：test/domain.test.mjs、src/domain/、npm test 输出；领域原因码到协议 ReasonCode 的映射留给应用层任务（009/013）。
- 未解决问题／决定：无阻塞。待应用草案、adopt、关闭守卫中的"无活动 run、无未核实 Git 效果"等事实核对属于应用层（013），领域函数只裁决状态。
- 对下一项的交接：007 文件／占用基础可独立开发；009 应用本模块时把 CLI 参数映射到 onInputsUpdated(kind, digestChanged) 并把领域原因码映射到协议响应；scope 累积的实际记录由 009/013 落 binding。

优先扫描下一编号（阻塞时可继续跳过）：[007 实现文件、占用与操作检查点基础](007-local-infrastructure.md)。
