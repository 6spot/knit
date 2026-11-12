# F1 复验：Rex 阶段终态关闭浮层并结束阶段 Pi（任务 k-da46a698c3ab）

本文件记录 F1（`--rex` 阶段终态浮层不关闭、阶段 Pi 进程残留）修复后的本机 Rex 真机复验；环境与
`README.md` 同一台 macOS 开发机，使用当前工作区构建的 `dist/` 与 Rex 真机 session，业务验证在临时
Git 项目 `/private/tmp/knit-f1-verify/proj` 内进行，不触碰本仓库业务产物。

## 修复责任与触发时机

- 选择“补报结束后由核心关闭浮层并终止 worker”：worker 在 settle 后必须保持存活，报告补报才能继续
  通过同一 bridge steer；只有核心知道补报窗口何时结束。
- `StageRunner` 仍传 `closeOnSettle: false`，含义收窄为“worker 不自行退出以承接补报”，不再表示终态
  保留浮层。
- `completeWithRetries` 返回（接收、失败或取消）后，`executeRexStage` 的 `finally` 统一调用
  `RexLauncher.terminate()`：按 `rex.json` 关闭本次 layer、终止本 run 的 Pi 进程树并释放 bridge；
  `terminate()` 幂等，关闭失败不改变已落盘结果。
- 取消路径：`stop()` 经 bridge 发送 stop 后，以 `cancelGraceMs` 宽限强制 `terminate()`；bridge 不可用时
  直接 `terminate()`。`waitForTerminal` 的取消宽限仍是同一终态路径。
- 结果可能先于 bridge 状态到达：`waitForTerminal`／恢复发现会先读本 run 的 `state.json` 补齐 pid，
  `terminate()` 也以“runId 与实例一致”的落盘状态兜底，避免 pid 未知导致进程残留。

## 工程验证

```text
$ npm test
ℹ tests 724
ℹ pass 724
ℹ fail 0
ℹ duration_ms 250719.348791
```

`test/rex.test.mjs` 直接覆盖 StageRunner 的实际取值与两条终态路径：

- `StageRunner Rex：实际 closeOnSettle=false，补报窗口结束后关闭浮层并结束阶段 Pi`
  - 捕获 `rexLauncherFactory` 的实际 options，断言 `closeOnSettle === false`；
  - 用真实 `RexLauncher`（fake RexApi）完成 `completed`，断言 `session.close_layer` 只调用一次；
  - 用真实子进程代表阶段 Pi，断言终态后进程退出。
- `StageRunner Rex：取消时 bridge stop 成功后仍关闭浮层并结束阶段 Pi`
  - 真实 `BridgeServer` 接受 `stop` 并返回 accepted，worker 不自退；
  - 断言 run 收敛为 `cancelled`、layer 关闭、阶段 Pi 退出。
- `RexLauncher：建层期间收到 stop，层落地后仍关闭一次`
  - 覆盖“先终止、后建层”的取消竞态：新层落地后再次收口，不因第一次 terminate 而残留。
- 原有注入 fake launcher 的 StageRunner 测试改为断言 `terminate()` 收口（而非被 `closeOnSettle`
  门控的 `closeLayer()`），覆盖 `rex_worker_error`、取消与收尾抛错不改写结果。

## 真机复验一：实施完成接收后浮层关闭

```text
$ node /Users/me/IdeaProjects/knit/dist/cli/knit.js run implement \
    --task k-abcca7680fed --rex --provider magpie --model group/deepseek \
    --dir /tmp/knit-f1-verify/proj
run run-15ad9ec2b86e: implement 已启动（启动 confirmed，准备 true，呈现 rex/explicit）

$ knit run status run-15ad9ec2b86e
run run-15ad9ec2b86e: completed（启动 confirmed，尝试 1）
呈现: rex（来源 explicit）
结果: completed
接收: completed（implementation_accepted）
```

终态后观察（同一 run 目录与 Rex session）：

```text
rex/state.json:            "status": "closed", "pid": 96394
stage-process.json:        "state": "exited", "piPid": 96394
kill -0 96394:             96394 not running
session.list_blocks:       knit run-15ad9ec2b86e 不在列表中（仅剩复验前已存在的其它层）
events.jsonl:              result_published completed → acceptance accepted（implementation_accepted）
```

结论：浮层在补报窗口结束后自动关闭，阶段 Pi 进程退出，无残留进程。

## 真机复验二：取消后收敛

```text
$ knit run implement --task k-b6d6c7ea0389 --rex ...   # run run-54e0d71275c0
run run-54e0d71275c0: implement 已启动（启动 confirmed，准备 true，呈现 rex/explicit）
layer visible after 2 polls（label: knit run-54e0d71275c0）
rex/state.json:            "status": "running", "pid": 89555
$ knit cancel --run run-54e0d71275c0 --reason "复验取消路径"
run run-54e0d71275c0: 已记录取消意图；worker=alive stage=alive

$ knit run status run-54e0d71275c0
run run-54e0d71275c0: cancelled（启动 confirmed，尝试 1）
呈现: rex（来源 explicit）
原因: agent_aborted
结果: cancelled
接收: completed（run_cancelled）
```

取消收敛后：

```text
rex/state.json:            "status": "closed", "pid": 89555
stage-process.json:        "state": "exited", "piPid": 89555
kill -0 89555:             89555 not running
session.list_blocks:       knit run-54e0d71275c0 不在列表中
events.jsonl:              cancel_requested → result_published cancelled → acceptance accepted（run_cancelled）
```

结论：取消经 bridge stop 后仍收敛为 cancelled 并完成接收，浮层关闭、阶段 Pi 退出。

## 最终构建复跑（含建层期取消重入加固）

最后一处代码加固后重新构建 `dist/` 并用同一临时项目复跑两终态，排除只对旧构建有效的可能：

| run | 场景 | 结果 | 浮层／进程证据 |
| --- | --- | --- | --- |
| `run-441d285839d0` | 实施完成 | completed 27.4s，接收 `implementation_accepted` | `rex/state.json` status=closed pid=84927；`kill -0 84927` → not running；`stage-process` state=exited；`knit run-441d285839d0` 不在 block 列表 |
| `run-05022d5e2d23` | 运行中取消 | cancelled（`agent_aborted`），接收 `run_cancelled` | 取消前 layer 可见、status=running pid=873；取消后 state status=closed pid=873、not running；`stage-process` state=exited；layer 关闭 |

最终树工程验证：`npm test` → 724/724 pass（含新增的建层期间 stop 重入测试）。

## 未覆盖／限制

- 本轮只复验 completed 与 cancelled 两个终态；失败终态由单测覆盖（`rex_worker_error`）。
- 真机复验使用工作区 `dist/` 与临时项目，未重新打包安装；安装流程本身不属于本任务范围。
- 复验期间同一 Rex session 中仍可见复验前遗留的其它 `knit run-*` 层（`run-bc7506733800`、
  `run-c51e9f409df6`、当前实施 run `run-b55306b1d999`），它们由旧代码启动，不在本任务清理范围。
