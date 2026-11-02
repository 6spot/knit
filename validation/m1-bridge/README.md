# M1 CLI 与真实桥接验收（任务015）

结果：通过。验证日期 2026-11-02；Node v24.21.0、Pi 1.4.0、模型 `magpie/auto/glm-5.3-flash`。项目 `/tmp/knit-015-final2` 是 `npm pack` 后本地安装的临时 Git 仓库；不推送、不操作其它真实仓库。

## 安装与初始化

1. 构建后 `npm pack` 生成 `knit-0.1.0.tgz`，在临时目录 `npm install` 本地包。
2. 安装包的 `bin/knit` 在临时 Git 仓库运行 `knit init --client pi`；生成 `.knit/` 项目资料、`.pi/extensions/knit.ts` 桥接和安装映射。
3. `knit doctor` 核对 config、manifest、installation、bridge、worker、bridge schema、Git、Pi；`knit storage` 只读统计元数据库、任务、run、快照与锁。
4. `knit start -- --version` 在本机 Pi 中真实启动；退出码 0。

包内容由 `pack:check` 检查：包含 CLI、worker、`dist/contracts/bridge-tools.json` 与模板；无 `src/`、`test/`、`tasks/`、`validation/`、研究文档、原生历史、缓存或凭据。

## 真实桥接闭环

主会话使用 Pi RPC 保持存活，桥接自动加载并登记 Session；模型实际调用以下工具：

- `knit_task` action `use`：追加 `knit.selection` 自定义条目，核心登记选择；主会话保持 `kind=main`，worker 阶段使用独立 `sub` 会话。
- `knit_run` action `implement`：真实 Pi 创建 `answer.txt`，内容 `forty-two\n`；run `run-0474f5a46603` completed，接收 `implementation_accepted`。
- `knit_run` action `check`：独立检查 `run-567f4f6f2c65`，verdict `pass`，接收 `check_pass`。
- `knit_standards` propose／review：候选 `c-c4bf51cc551b`、审阅 `r-184cf59478c0`（deferred），`standards pending` 为 `review_matched`。
- `knit_deliver` action `deliver`：操作 `op-0d0368b2bcb8`，工作提交 `a331f5b`、归档提交 `a676614`；任务移动到 `archive/2026-11/11-02-final-bridge`。
- 桥接观察器在 implement／check 终态各发送一次通知；重复轮询不重复投递，`status --run` 本身不接收结果。
- 真实主会话在 `sleep 55` 忙态中收到 implement 终态；观察器使用 follow-up，忙态结束后实际触发新回合并回答 run 状态，见 [busy-followup.txt](busy-followup.txt)。

`/knit-reload` 命令经 RPC 返回 `handled`；会话与原生 ID 不变，随后 `knit_status` 工具调用成功。`--json` 工具结果仍是单一协议响应；`--dev` 诊断只写 stderr，包含 command_start／command_end 与 worker diag，不进入 stdout。

## 原生恢复

- 显式 `--resume-session` 使用旧 check 会话文件：`resumeAction=resume`，真实模型继续同一原生会话并完成检查。
- 删除该会话文件后同一请求：`resumeAction=create_new`、`resumeReason=session_file_missing`，新会话读取当前任务与资料继续，未重置 Task 阶段。
- 主会话 `--native` 只作发起方上下文，不会被阶段 worker 当作恢复目标；主会话记录不被子会话覆盖。

## 资料

- [report.json](report.json)：包、任务／run／操作 ID、Git 范围、Session、通知、标准、恢复与检查结果。
- [doctor.json](doctor.json)、[storage.json](storage.json)、[sessions.json](sessions.json)：只读诊断与索引快照。
- [implement.status.json](implement.status.json)、[check.status.json](check.status.json)、对应 `*.result.json`：run 状态与不可变结果副本。
- [task.status.json](task.status.json)、[archived-task.md](archived-task.md)：归档任务与交付记录。
- [standards-pending.json](standards-pending.json)、[bridge-implement.txt](bridge-implement.txt)、[bridge-check-deliver.txt](bridge-check-deliver.txt)、[reload.txt](reload.txt)、[busy-followup.txt](busy-followup.txt)：桥接调用、reload 与忙时 follow-up 输出。
- [native-resume.json](native-resume.json)、[native-fallback.json](native-fallback.json)：真实原生恢复／文件缺失兜底的状态副本。

原生 JSONL 历史与凭据留在临时项目，不复制进仓库。

## 边界

本验收只证明 M1 临时仓库闭环；M2 的真实项目保护（完整快照恢复、占用／取消竞争、崩溃矩阵、Git 冲突与历史改写）仍需按任务016–020完成。`needs_attention`、外部效果未知与人工授权边界按既有规则保留，不因 M1 通过而放宽。
