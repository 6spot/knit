# 重写怎么进行

现行的设计在 `docs/design/DESIGN.md`：它是这份文件原来的第 1–11 节，章节号没有变。这里只留重写过程用到的三节，里面说的「第 11 节」指 `docs/design/DESIGN.md` 的第 11 节。

## 12. 可以搬的现有代码

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `src/adapters/pi/connection.ts` | 320 | Pi 进程连接，只依赖 31 行的帧定义 |
| `src/adapters/pi/runtime.ts` | 402 | 启动参数与对话，改掉 `--no-context-files` |
| `src/adapters/pi/native-file.ts` | 124 | 会话文件定位。`resume.ts`（续用旧会话）和 `native-entries.ts`（按会话记录判定改动来源）不搬，见第 11 节 |
| `src/infrastructure/paths.ts`、`atomic.ts`、`fingerprint.ts`、`errors.ts` | 284 | 路径规范化（含 macOS 别名）、带版本核对的原子写 |
| `src/infrastructure/process.ts` | 350 | 进程启动、进程树清理和同步的 Git 调用；锁的持有者身份和 Git hook 隔离不搬 |
| `src/domain/workflow.ts`、`src/contracts/workflow.ts` | 878 | 流程文件的解析与校验；去掉降级、`task` 能力和内置的默认流程文本 |
| `src/contracts/task-inputs.ts` 里的场景与待澄清解析 | 约 250 | 抽出两个函数 |
| `src/domain/report.ts` 里的报告解析 | 部分 | 抽出解析部分 |
| `src/application/history-search.ts` | 354 | 检索，稍后搬 |
| `src/cli/output.ts` | 139 | 命令行输出 |

对应的测试可以一起搬：`pi-runtime`（9 个）、`scenarios`（9 个）、`macos-compat`（7 个），以及 `infrastructure` 和 `workflow` 里与搬过来的代码有关的部分。

## 13. 规模估算

以下是粗估，没有经过验证：

| 部分 | 估算行数 |
| --- | --- |
| 命令行入口与输出 | 500 |
| 任务：文档解析、状态、列表、检索 | 1,000 |
| 规范：声明解析与挑选 | 200 |
| 交接：拼装与字节上限 | 300 |
| 流程：解析、校验、环节推进、返工 | 800 |
| 执行：启动、状态、报告、改动对比 | 900 |
| Pi 连接 | 900 |
| 交付 | 300 |
| 初始化与模板 | 300 |
| 路径、原子写、进程、Git 调用 | 500 |
| 桥接 | 600 |
| 合计 | 约 6,300 |

现在是 `src` 44,642 行加桥接 1,974 行。

## 14. 重写怎么进行

- 在新目录（暂定 `next/`）里写小核心和它的测试，搬用第 12 节的代码。旧代码在此期间不动。
- 四份规范先写。旧 Knit 会把 `.knit/standards/` 下的文件全文交给执行者，所以它们从第一个代码任务起就对执行者生效；旧 Knit 不按环节挑选，每份都要短。
- `AGENTS.md` 在切换时清理。旧 Knit 拿它的内容算交付策略版本，切换前改它会让进行中的交付失效。
- 期间用安装版的旧 Knit 管理这些子任务。
- 小核心能完成一个任务的全过程（创建、确认、执行、审查、交付）之后切换：重新安装，重新生成桥接和模板，删除旧代码和旧测试。
- 切换时，没结束的任务手工转成新格式；已归档的任务保持旧格式不动（写这一条时是 93 个，切换时是 169 个）。新 Knit 读不了旧格式，`knit task list --archive` 会对每个旧任务打印一行原因。
- 已知代价：macOS 验收证据作废；现有 734 个测试大部分不搬；已经修过的问题（路径别名、进程清理时序等）可能重犯。
