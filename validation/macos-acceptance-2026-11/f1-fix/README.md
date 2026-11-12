# F1 修复真机复验（Rex 浮层终态关闭与 worker 收敛）

任务：`k-da46a698c3ab`（修复 Rex 阶段浮层终态不关闭与 worker 残留）。
环境：macOS 27.2.1（Darwin 27.2.0 arm64）、Node 26.3.0、Pi 1.5.2、Rex preview.14（真实 `REX_SESSION`）、模型 magpie/group/deepseek。
被测包：修复后 `npm pack` 266 文件 618.8 kB，装入 `/tmp/knit-f1/app`；项目 `/tmp/knit-f1/proj`（`knit init` ready）。

## 用例 A：终态关闭（实施完成）

```text
knit run implement --task k-c0d1fbcfe996 --rex --provider magpie --model group/deepseek --wait
run run-c065241af1ef: implement 已启动（启动 confirmed，呈现 rex/explicit）→ completed，9760ms
stage-process.json piPid=68754 → alive=no
run accept → implementation_accepted
接收后 rex 浮层：absent；pid 68754 alive=no
```

## 用例 B：取消收敛

```text
knit run implement --task k-1e411bc9f3e2 --rex ...（后台）→ run-fbacbb32f8d2
knit cancel --run run-fbacbb32f8d2 → 已接收（run_cancelled）
stage-process.json piPid=71833 → alive=no
取消收敛后 rex 浮层：absent；pid 71833 alive=no
```

## 对照

修复前三轮验收中同一流程均出现浮层常驻与 worker 存活（`../README.md` F1 与 `r2-*`、`r3-*`）；修复后两种终态都自动关闭且进程退出。
日志：`a-run.log`、`a-status.log`、`a-accept.log`、`b-run.log`、`b-cancel.log`、`b-accept.log`。
