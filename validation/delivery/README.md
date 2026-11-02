# 交付与归档实测

结果：通过。验证日期 2026-11-02；临时仓库 `/tmp/knit-014-e2e2`，真实本机 Pi 1.4.0 与 `magpie / auto/glm-5.3-flash`。不推送、不操作其它真实仓库。

## 链路

1. `git init` + 一次基线提交 → `knit init --client pi`。
2. `knit task new --branch refs/heads/main` → clarify 输入 → `task ready`。
3. 真实 implement `run-58955e29b433`（usage 21202/620）→ 接收后 phase check。
4. 真实 check `run-8a2675075912`（verdict pass）→ 接收后 phase deliver。
5. `knit deliver --branch refs/heads/main --authorization-ref workflow:.knit/workflow.md#交付` → 操作 `op-6ca6e77ca8f5`。
   - 工作提交 `46e405e`：`app.txt` 修改 + 任务目录新增。
   - 归档提交 `4ad556c`：旧任务路径删除 + `archive/2026-11/11-02-app-new` 新增。
   - 归档目录 `.knit/tasks/archive/2026-11/11-02-app-new`；封存标记在归档提交后移除。
6. 归档后 `task record` 补记：追加新资料，保留原交付记录；工作区仅该档案文件变化。

## 资料

- [report.json](report.json)：真实 run、交付结果、Git 日志与两个提交的范围。
- [deliver.json](deliver.json)、[implement.status.json](implement.status.json)、[check.status.json](check.status.json)：协议与 run 状态副本。
- [archived-task.md](archived-task.md)：归档任务正文（含交付记录与后补记录）。

## 边界

本实验不覆盖推送、合并、冲突解决、历史改写或完整崩溃矩阵；这些不属于任务 014 的本地交付范围。真实检查凭据与原生会话留在临时项目 `.knit/.runtime/`，不复制进仓库。
