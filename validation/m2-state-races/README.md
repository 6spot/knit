# 任务018 接收、草案与业务状态竞争验证

环境：Node v24.21.0、Pi 1.4.0。真实 CLI 夹具 `/tmp/knit-018-cli`（临时 Git 仓库，未在当前 Knit 工作区初始化产品 `.knit/`／`.pi/`）。阶段使用 `test/fixtures/fake-pi.mjs` 的 prepare-only，不调用真实模型。

## 活动 run 与草案（`cli/`）

1. 创建任务 `k-4acee072e3a0` 并 ready，准备 run `run-35929a94ec42`，用 fake Pi 执行 `run start --prepare-only`。
2. `task update --kind clarify` 在活动 run 中返回 `applied:"pending_saved"`，未改冻结输入／phase；`task close --outcome cancelled --runs-settled` 返回 `outcome:error`、`reasonCode:needs_review`，进程 exit 1。
3. `task update --withdraw-pending --expect-pending ...` 在活动 run 中成功撤回；`task-after.md` 保留撤回记录，输入区未改变。
4. 文件：`task-new.json`、`task-ready.json`、`run-prepare.json`、`run-start.json`、`task-update-active.json`、`task-close-active.json`、`task-close-active.stderr`、`task-withdraw-active.json`、`task-after.md`、`ids.txt`、`close-exit.txt`。

## 独立进程接收检查点（`tests/acceptance-journal.txt`）

`test/fixtures/accept-once.mjs` 在独立 Node 进程执行一次接收，Task 写入后让 `bindings.save` 失败并退出；父进程用 `acceptance.json` 检查点重入，最终只追加一次 `lastRunIds`／scope，重复接收为 duplicate。命令：

```text
node --test --test-name-pattern "接收检查点" test/stage.test.mjs
```

## 其他状态竞争

- `tests/pending-races.txt`：草案存在时直接更新拒绝、同内容新版本、`runsSettled=false`、基线冲突、旧摘要不能撤回后来草案。
- `tests/scope-and-repair.txt`：scope 跨 run 累积、`scopeRunIds` 去重、换会话保留修复计数与最近检查事实。
- `tests/latest-check.txt`：旧 pass 文件保留，但 `lastCheckRunId` 指向 blocked 时交付拒绝。
- `tests/late-result.txt`：任务关闭后迟到结果不重开。

## 边界

未构造 SQLite 断电损坏；检查点重入覆盖进程退出后的半写入。CLI 直连库的调用者仍可自行传 `runsSettled`；生产 CLI 注入 `RunActivityService` 后按仓储核实。报告见 `report.json`。
