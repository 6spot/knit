# 阶段执行、检查与接收实测

结果：通过。验证日期 2026-11-02；使用本机 Pi 1.4.0 与 `magpie / auto/glm-5.3-flash`，不导入 SDK，不调用其它真实仓库。这是隔离临时仓库中的开发验收，不是产品发布测试。

## 场景

临时仓库 `/tmp/knit-013-real2`：`knit init` → 任务 `k-99e6c4fd3314`（目标：把 `app.txt` 从 `old` 改为 `new`，验收命令 `grep -q "^new$" app.txt`）→ task ready → 真实 worker implement → 独立 check。

- implement `run-ab2002d0d74d`：模型实际用 bash 读取任务资料并写入 `app.txt`；结果 completed，实际改动 `["app.txt"]`，增量用量 input 16295 / output 713，原生条目范围 `6e864691..1afa6a1a`。接收后 Task 转 `check`，scope 记录 `app.txt` 指纹。
- check `run-c7319a3be882`：独立原生 Session，模型实际执行 `cat app.txt`、`git status`、`git diff -- app.txt`、`node`／grep 验证；报告 verdict `pass`，coverage 覆盖 `app.txt` 与两项完成条件。检查前后文件签名一致；接收后 Task 转 `deliver`，`checks/run-c7319a3be882.json` 保存输入／规范／scope 摘要与结论。
- `run resume run-c7319a3be882` 返回 `resumed=false, reason=already_accepted`，未新建 run、未重跑模型。
- `git log` 只有 init 提交；`.knit/`、`.pi/`、`AGENTS.md` 未跟踪。

## 资料

- [report.json](report.json)：两次 run 的模型、用量、原生条目范围、工具调用与最终阶段。
- [runs/implement.result.json](runs/implement.result.json)、[runs/check.result.json](runs/check.result.json)：不可变 run 结果副本。
- [check.json](check.json)：检查凭据副本。
- 原生会话 JSONL 留在临时项目 `.knit/.runtime/pi-sessions/`，不复制进仓库。

## 边界

模型报告不是 Task 权威：接收服务另行核对输入／规范／scope／分支与实际文件差异后才写 Task。检查者若改动文件，该次结果判失败（由测试覆盖）。完整崩溃矩阵、Git 提交／归档与发布验收不在本实验范围。
