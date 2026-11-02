---
id: k-1b2305b52b5e
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
createdAt: 2026-11-02T08:49:00.064Z
title: 补验收与测试缺口
---

# 补验收与测试缺口

## 目标与边界

<!-- 待讨论确认：目的、范围、约束与必要设计 -->

## 完成条件

<!-- 可验证结果与必需验收 -->

## 输入引用

<!-- 适用规范、设计材料、代码范围与验证入口 -->

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

架构审查确认的验收与测试缺口：

1.【中】DESIGN §16.1「归档历史 M3A」行（约 716 行）是首版验收表中唯一既无实现标记、也无测试/validation 支撑的项：「跨机历史可读但非新执行凭据」（§12 约 564 行的行为描述）在 src/ 无实现痕迹（src/cli/status.ts:85 只有「（已归档）」后缀；test/task.test.mjs:135 仅按目录派生归档分区）。「补记不重开业务」部分有测试（test/delivery.test.mjs:206、task.test.mjs:532）。修法：补实现与测试，或把「跨机历史可读」移到 §16.3 并在 §16.1 如实标注未实现范围。
2.【中】取消/完成竞争缺确定性测试：test/stage.test.mjs:639-677 靠真实时序偶然命中（667 行自注「取消可能发生在模型前或模型后」）；fake-pi（test/fixtures/fake-pi.mjs）没有「收到取消请求的同一 tick 发布 completed result」的确定性注入模式；validation/m2-safety/real-cancel/ 只有单次运行。修法：给 fake-pi 增加该模式，断言终态唯一。
3.【低】m2-git-failures 未注入 Git 子进程 SIGKILL/杀进程场景，故障覆盖记录应如实标注该边界。
4.【低】026 的 Git 守卫场景缺 .txt 原始输出（validation/release-independent-gate 中为整理后的记录），补齐或注明原因。

验收标准：npm test 全绿且新增确定性用例通过；DESIGN §16.1 无无证据的验收行；缺口在文档中如实标注。

讨论结论（2026-11-02，架构师决策，用户已授权按序推进）：

各项处理方向：
1. 归档历史「跨机历史可读」：v1 不补实现，将该验收项从 §16.1 移到 §16.3 后续能力，§16.1 原行如实标注「未实现，仅归档分区与补记已实现（任务014/015 证据）」；§12 行同步收敛。
2. 取消/完成竞争确定性测试：给 test/fixtures/fake-pi.mjs 增加「收到取消请求的同一 tick 发布 completed result」模式，新增用例断言终态唯一（不出现 completed 与 cancelled 并存或双 result）。
3. m2-git-failures 边界：在 validation/m2-safety/README（或对应文档）如实标注「未注入 Git 子进程 SIGKILL」，属记录边界不是缺陷。
4. 026 守卫场景原始输出：补 .txt 原始记录或在 report 中注明整理原因，二选一以小改动为准。

验收标准：npm test 全绿且新增确定性用例通过；DESIGN §16.1 无无证据验收行；validation 记录无未标注的覆盖缺口。

<!-- knit:progress:end -->
