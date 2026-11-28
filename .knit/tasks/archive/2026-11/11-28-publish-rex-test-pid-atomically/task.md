---
id: k-226088480237
title: 原子写入 Rex 中止测试的 PID 文件
status: delivered
stage: null
verification: independent
parent: k-e8f223bea531
dependsOn: []
priority: P1
createdAt: 2026-11-28T00:06:30.566Z
---

## 目标与范围

双终端验收中，普通终端有 670 项通过，1 项因五秒超时取消。出问题的是 `test/run-pane.test.mjs` 中验证 `RexPaneHost.waitClosed` 中止真实子进程的用例。夹具先创建 `wait.pid` 再写入内容，父进程只检查文件存在。主会话在创建和写入之间加入 180 ms 延迟，实际观测到读取值为 `""`，转换为 PID `0` 后同样在五秒时超时。

让假 `rex` 进程在同目录写完自己的 PID 后，以原子改名发布 `wait.pid`。改动限于该测试夹具，保留真实子进程、`AbortController`、五秒时限和轮询 `ESRCH` 的退出断言。生产适配器与已安装的包沿用现有实现。

## 完成条件

### Requirement: 读取端只会得到完整的子进程 PID

#### Scenario: 创建 PID 文件与写完内容之间发生调度切换
- WHEN 假 `rex wait` 进程写入 PID 时故意停顿，让读取端有机会轮询
- THEN 最终路径出现时即可读到正确的正整数 PID，中止后该子进程确实退出，定向测试在原时限内通过。

在实现和独立审查中分别用临时夹具验证上述时序，记录 PID 与定向用例结果。主会话在修复合入 `main` 后用 Rex 和普通终端分别完成跨卷全量验收。

## 待澄清

## 相关资料

- `test/run-pane.test.mjs` 中的 `RexPaneHost.waitClosed 收到中止信号时立即终止 rex wait 进程`
- `src/adapters/rex/pane.ts` 中的 `RexPaneHost.waitClosed`
- `.knit/standards/pitfalls.md` 的「读到写了一半的文件」

## 结果

仅修改 test/run-pane.test.mjs 的假 rex，先完整写入临时文件，再通过原子改名发布 PID。主会话在真实进程的创建和写入间延迟 180 ms，原版读到空串后超时，修正版读到完整正整数且中止后进程确实退出。独立审查 r-d1776c4bb49a 另覆盖了仅写入部分 PID 的时序，通过。定向文件在实现环境 35/35，修复后的宿主跨卷全量 671/671，0 失败、0 取消、0 跳过。
