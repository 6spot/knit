---
id: k-da46a698c3ab
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-7e4dbba9dca7
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-11T14:10:07.995Z
title: 修复 Rex 阶段浮层终态不关闭与 worker 残留
---

## 目标
修复 macOS 真机验收发现的 F1：`--rex` 阶段 run 到达终态后浮层不关闭，阶段 Pi 进程在接收后仍存活；取消路径同样残留。

## 现状与证据
- `src/application/stage-runner.ts:1041` 恒传 `closeOnSettle: false`（注释称“由核心决定再补一轮还是关闭浮层”）。
- `src/application/rex-launcher.ts:855` 的 `closeLayer()` 在 `closeOnSettle === false` 时直接返回，核心侧没有其它关闭路径。
- `src/adapters/rex/worker-extension.ts:113` 只在 `manifest.closeOnSettle` 为真时 `context.shutdown()`。
- 三轮真机复跑：实施完成、检查 pass、取消收敛三种终态浮层均 open，worker pid 71075／52939／71973／75038 存活；手工 `session.close_layer` 后恢复。
- 证据：`validation/macos-acceptance-2026-11/README.md` 与 `r2-*`、`r3-*` 日志。

## 范围
- 明确终态关闭责任：补报结束后由核心关闭浮层并终止 worker，或让 worker 在补报窗口结束时自行关闭；二选一并写清理由与触发时机。
- 取消路径：`stop()` 在 bridge stop 成功后仍须确保阶段进程与浮层收敛。
- 测试须覆盖 StageRunner 的实际取值，不能只测默认参数。

## 完成条件
### Requirement: 终态关闭
#### Scenario: 实施完成接收后浮层关闭
- GIVEN 临时项目派发 `run implement --rex`
- WHEN run 到达终态并接收结果
- THEN 浮层在补报窗口结束后自动关闭
- AND 阶段 Pi 进程退出，无残留进程

#### Scenario: 取消后收敛
- GIVEN 一个正在运行的 `--rex` 阶段
- WHEN 执行 `knit cancel --run`
- THEN run 收敛为 cancelled 并可接收
- AND 浮层关闭、阶段 Pi 进程退出

### Requirement: 回归覆盖
#### Scenario: 测试覆盖实际取值
- GIVEN 现有单测走默认 `closeOnSettle: true`
- WHEN 运行相关测试
- THEN 有测试直接覆盖 StageRunner 的关闭行为与取消路径

## 目标与边界
- 不改变补报语义；补报窗口与关闭时机在代码注释与文档中写清。
- 真机复验在本机 Rex 完成，证据落 `validation/`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## F1 修复真机复验（macOS 本机 Rex）

- 包与项目：修复后 `npm pack` 266 文件 618.8 kB → `/tmp/knit-f1/app` 安装；`/tmp/knit-f1/proj` 执行 `knit init` ready。
- 终态关闭：`run implement --rex --wait`（k-c0d1fbcfe996）completed 9760ms；`stage-process.json` pid 68754 退出（alive=no）；接收后 `rex block ls` 无对应浮层。
- 取消收敛：后台派发后 `cancel`（k-1e411bc9f3e2，run-fbacbb32f8d2）→ 已接收（run_cancelled）；pid 71833 退出；浮层 absent。
- 证据：`validation/macos-acceptance-2026-11/f1-fix/`（README 与 a-*/b-* 日志）。
- 单测：`npm test` 724/724 pass（226s）；期间观察器与心跳测试各出现 1 次临时目录 `rmSync ENOTEMPTY`（隔离/整文件重跑通过，属既有清理竞态）。

### 交付记录

<!-- knit:delivery:op-bfafe51bb6b3 -->
- 操作: op-bfafe51bb6b3
- 时间: 2026-11-12T17:30:58.891Z
- 分支: refs/heads/main
- 授权来源: user:sha256:022d9ea53babe7e8033f06eee04f16b45c91d3186198d2f54e989836fe25d3cc
- 调用: bridge
- 工作提交: 48ab370d03e51c2221a42a091b17f3d6f3fc626d
- 结果: 正常交付；检查 run-51a2aa731c69 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-11-rex-layer-close

<!-- knit:progress:end -->
