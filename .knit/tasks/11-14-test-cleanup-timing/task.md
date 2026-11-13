---
id: k-0893a9b03544
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-13T23:17:19.995Z
title: 测试清理时序：锁目录轮询与临时目录删除不再偶发失败
---

# 测试清理时序：锁目录轮询与临时目录删除不再偶发失败

## 目标

消除全量 `npm test` 中两类与产品行为无关的偶发失败，使本机验收的工程校验不因时序运气失败。

1. `test/run.test.mjs`「prepare 只发布请求…」用外部 `find` 列举 `.locks/projects`；worker 释放占用时目录在遍历途中被删除，`find` 以非零退出，用例报 `Command failed: find … No such file or directory`（2026-11-14 Terminal.app 全量 781/782，单独重跑 6/6 通过）。
2. `test/bridge-query.test.mjs` 与 `test/stage.test.mjs` 收尾用 `rmSync(dir, { recursive: true, force: true })`；后台子进程仍在写临时目录时报 `ENOTEMPTY`（2026-11-12 验收基线上「观察器：无活动 run 退避…」「桥接诊断：cli_version…」失败；2026-11-13 本会话「心跳丢失后 worker 停止新动作」失败一次）。

## 范围与边界

- 只改三个测试文件：`test/run.test.mjs`、`test/bridge-query.test.mjs`、`test/stage.test.mjs`。
- 锁目录列举改为进程内读取，列举途中条目消失时重读，不把读取失败当成“目录为空”；原有三处断言（prepare 后为空、轮询、最终为空）语义不变。
- 临时项目目录删除沿用仓库既有写法 `maxRetries: 20, retryDelay: 50`（其它测试文件已有 80 处）。
- 不改 `src/`、`assets/`、桥接、文档与任何断言的业务含义；不放宽、不跳过、不删除用例。
- 主会话直接实施；本地提交与归档在用户消息 9698c2d8 的持续授权内，推送另行确认。

## 影响路径

- test/run.test.mjs
- test/bridge-query.test.mjs
- test/stage.test.mjs

## 完成条件

- 三个文件的用例数量与名称不变，`npm run typecheck` 通过。
- 三个受影响文件单独连续运行 3 轮全部通过。
- `npm test` 在 Rex 终端与普通 Terminal.app 各一次全绿。
- `test/run.test.mjs` 不再调用外部 `find`；`test/bridge-query.test.mjs`、`test/stage.test.mjs` 中删除临时项目目录的调用都带重试参数。

## 记录

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-3e52f71279c4 -->
- 操作: op-3e52f71279c4
- 时间: 2026-11-13T23:35:50.571Z
- 分支: refs/heads/main
- 授权来源: user:387707d9
- 调用: bridge
- 工作提交: 039bd19629e45876d593c4e082aa9a5fb342e968
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-14-test-cleanup-timing

<!-- knit:progress:end -->
