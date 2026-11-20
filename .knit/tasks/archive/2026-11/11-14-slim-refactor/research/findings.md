# 调查结论（只读，2026-11-14）

本文是 `task.md` 和 `design.md` 的依据。数字来自本机记录：主会话记录 `~/.pi/agent/sessions/--Users-me-IdeaProjects-knit--/`、`.knit/.runtime/metadata.db`、`.knit/.runtime/runs/`、`.knit/.runtime/pi-sessions/` 和 93 个归档任务。

## 1. 交付

- 主会话记录里 `knit_deliver` 共 36 次调用，5 次失败，原因各不相同：

  | 时间 | 原因 |
  | --- | --- |
  | 11-06 | 凭据扫描拦下 `test/rex.test.mjs` 第 322 行；是否误报未核实 |
  | 11-12 | `stale_input`：检查后输入或规范变了 |
  | 11-12 | 提交文案文件路径读不到（Agent 传错路径） |
  | 11-12 | `hook_changed_selected`：目录路径带尾斜杠 |
  | 11-13 | 交付策略在操作开始后变化 |

- 两笔交付（任务 k-185ace3b9556、k-7e4dbba9dca7）从 11-12 17 时卡到 11-13 21 时，约 28 小时。为解开它们新建了两个修复任务（`11-14-closeout-gaps`、`11-14-policy-recovery-retry`）。前一个的修复提交 e717f95 改了 `AGENTS.md`，策略版本随之变化，`--retry` 报 `policy_changed`，`--recover-policy` 报 `policy_recovery_effects`，互相拒绝。
- 一个任务的交付是 6 个步骤、3 次提交。27 笔交付操作最终都完成了。
- 没有找到“连续失败 20 多次”的提交；最接近的是 11-12 为交付 10 个积压任务调用了 25 次（14 次预检加 11 次交付）。

## 2. 规范

- 设计在 `DESIGN.md` 第 8 节与 8.2 节；沉淀走 `standards propose → review → apply`。
- `.knit/standards/` 下除候选外的全部 `.md` 全文进执行者的系统提示（`src/application/context-planner.ts:316`），不分环节。
- `index.md` 是占位，没有任何一条正式规范。唯一的候选 c-9bb9ed19ed83 在 11-11 被审阅为 deferred。
- 开发约定写在 `AGENTS.md` 的「开发约定」「交付检查」两节，共 18 条。
- 执行者以 `--no-context-files` 启动（`src/adapters/pi/runtime.ts:133`；`DESIGN.md` 第 465 行），抽查的 6 个执行者会话里都没有 `AGENTS.md`。
- `AGENTS.md` 受管块 6,052 字节，与桥接每轮注入的 `<knit>` 块（5,337 字节）大段重复。

## 3. 交接与任务资料

- `task.md` 输入区全文传给执行者，`plan.md`／`design.md` 全文进系统提示（`src/application/stage.ts:292`），没有按 Requirement 裁剪。
- 93 个归档任务的 `task.md`：输入区平均 4,285 字节，记录区平均 2,729 字节（占 38%）；最大的一份是 23KB 输入加 12KB 记录。
- 记录区：「关键经过」77 个为空，「结果与验证」83 个为空，「运行引用」47 个为空；81 个已关闭任务的「当前位置」仍是创建时的原话；非空行里 26% 带 ID、摘要或 HTML 标记。
- 检查结论与完成凭据只存在本机 `.knit/.runtime/`，不入库。

## 4. 工具与每轮上下文

| 工具 | 声明字节 | 历史调用（粗略） |
| --- | --- | --- |
| `knit_task`（19 个 action） | 3,081 | 约 130 |
| `knit_workflow` | 1,340 | 0 |
| `knit_run` | 1,177 | 约 52 |
| `knit_deliver` | 1,000 | 36 |
| `knit_standards` | 958 | 2 |
| `knit_material` | 744 | 约 83 |
| `knit_snapshot` | 722 | 6 |
| `knit_context` | 457 | 约 29 |
| `knit_status` | 346 | 约 59 |

- 9 个工具声明共 9,825 字节，占全部工具声明的 37%。
- `knit_task` 的参数表没有 `verification`，创建任务时无法指定，历史上 3 次因此失败；另有 2 次创建被“锁已占用”挡住。

## 5. 用 Knit 开发 Knit

- 交付策略版本取自 `AGENTS.md` 的摘要；受管块是产品模板的逐字副本。
- `.knit/` 下的流程与提示词禁止执行者修改，但它们是模板副本，测试逐字比对桥接文件和受管块（`test/host-selection.test.mjs:427`、`test/init.test.mjs:619` 等）。
- `knit init --force` 在 11-07、11-11 覆盖过本仓库的 `config.json`、`workflow.yaml`、`runtimes/pi.md`（备份在 `.knit/.runtime/init-backup/`）。
- 桥接调用仓库的 `dist/cli/knit.js`，`npm test` 每次先 `rm -rf dist` 再重建；终端里的全局 `knit` 是 11-11 的拷贝。没有找到这一点造成故障的记录。

## 6. 功能实际用量

- 49 次执行：实现 34，检查 15；全部在主检出（Worktree 策略都是 off），全部用 Rex 窗格展示；41 次完成，8 次失败（启动连接失败 2，模型服务错误 3，改动自报不符 1，报告不是 JSON 1，接收时范围变化 1）。
- 时长：中位 13 分钟，最长 141 分钟，30 次超过 10 分钟。派发时 26 次不等待，1 次等待。
- 续用旧会话 1 次。快照：桥接查看 5 次，命令行恢复 2 次。`doctor` 1 次。
- 主会话里手动调用过十余次 worktree 命令（merge 3、cleanup 3、repair 2 等），用途未核实，可能是验收夹具。
- 93 个任务：22 个有父任务，14 个有依赖，13 个设过 `order`；验证要求 `independent` 18 个、`self` 63 个；15 个用了场景写法；任务目录里有 `plan.md` 10 份、`design.md` 15 份。

## 7. 代码规模与耦合

| 部分 | 行数 |
| --- | --- |
| 流程／阶段／执行 | 9,331 |
| Worktree | 8,031 |
| 锁／调度／恢复／清理／快照 | 6,873 |
| 任务 | 5,571 |
| 交付 | 3,727 |
| Rex 窗格 | 2,377 |
| 会话与桥接上下文 | 2,284 |
| 规范 | 1,290 |
| 初始化 | 1,078 |
| 其余 | 4,080 |
| `src` 合计 | 44,642 |

- 桥接文件另有 1,974 行；测试 57 个文件、31,781 行、734 个用例；11 月 fix 提交 22 个、feat 9 个。
- 锁被 27 个其它文件引用，Worktree 被 16 个，凭据封存被 6 个。`task-service`、`stage-runner`、`delivery-service`、`run-coordinator` 里都有 Worktree 分支。
- 约 11,000 行测试针对 Worktree、锁、恢复、凭据、快照。

## 8. 另外两个工具怎么传规范（读源码）

Trellis（commit f089cb3，CLI 0.6.17）：

- 规范在 `.trellis/spec/<包>/<层>/`。
- 每个任务目录有 `implement.jsonl` 和 `check.jsonl`，一行一个文件加理由；规划阶段挑好，没有真实条目不算就绪。
- 派子 Agent 时程序读对应清单，把文件正文连同 `prd.md` 等拼进提示（`shared-hooks/inject-subagent-context.py`）。上限：单文件 32KB，总计 128KB。
- 主会话只收到精简状态，规范只报“有几份索引”（`shared-hooks/session-start.py`）。这只对走 hook 的客户端成立；Pi 上的做法见第 9 节。
- `AGENTS.md` 里写一个 21 行、1,073 字节的受管块；它的 Pi 子 Agent 不关闭 `AGENTS.md` 加载。

OpenSpec（commit ea635dd，2.0.0）：

- 不再写 `AGENTS.md`，旧块当遗留清理（`src/core/legacy-cleanup.ts`）。
- 规则在 `openspec/config.yaml`：`context` 进所有环节（上限 50KB），`rules` 按产物类型分组（`src/core/project-config.ts`）。
- 智能体每步调用 `openspec instructions <产物> --change <名称>`，CLI 把 `<project_context>`、`<rules>` 和模板拼好返回。

两个仓库的本机临时副本在 `/tmp/knit-ref`。

## 9. 规范注入的位置、角色文件与返工（读源码与本机记录）

规范放在哪里：

- Trellis，走 hook 的客户端（Claude Code 等）：hook 改写派发子 Agent 的那条任务消息，把规范正文、需求和原任务拼在一起（`shared-hooks/inject-subagent-context.py` 的 `build_implement_prompt` 与 `updatedInput`）。
- Trellis，Pi：子 Agent 收到的是一条拼好的消息，顺序是角色说明、规范与需求、任务（`pi/extensions/trellis/index.ts.txt` 的 `buildPrompt`）。主会话在 `before_agent_start` 里把当前任务 `implement.jsonl` 列出的规范正文和需求放进系统提示，之后磁盘上有变化时用一条消息补发（同文件第 2066–2118 行）。
- OpenSpec：智能体按技能里的步骤运行 `openspec instructions`，规则包在 `<project_context>` 和 `<rules>` 里作为命令输出回到对话（`src/commands/workflow/instructions.ts`）。
- Knit 现状：执行者的规范和角色文件经 `--append-system-prompt` 进系统提示，需求在第一条消息里；主会话不带规范。
- Pi 压缩会话后模型看到的是：系统提示、摘要、保留的近期消息（Pi 文档 `compaction.md`）。

角色文件与规范：

- Trellis 的角色文件由初始化生成到各客户端的目录，18 个客户端各一份（`configurators/pi.ts` 写 `.pi/agents/<名称>.md`）。角色文件里不含规范，只有一段兜底：没有注入标记时自己去读任务清单里的文件。
- Trellis 的规范目录初始化时只给骨架，条目标为 “To fill”，要求写项目的实际约定（`templates/markdown/spec/`）。
- Pi 本身认的项目目录是 `extensions`、`skills`、`prompts`、`themes`；读 `.pi/agents/` 的是子 Agent 扩展。本机的 `subagent` 扩展默认范围是用户级（`agentScope ?? "user"`），子进程不关闭扩展和上下文文件的加载。
- 本仓库 `.pi/agents/` 现有两个用户自己的角色：`review-local.md`（已入库）和 `deepseek-reviewer.md`（未入库）。

返工：

- 本机保留的记录里 10 个任务做过检查，2 个被打回（k-8fc483a6e41e、k-50d398bff55f），都是返工 1 轮后通过；现在的 2 轮上限没有触发过。
- 4 条打回意见里，2 条是真实缺陷，1 条是测试没有覆盖真实形状，1 条是实现报告写的测试数与实际不符。
- Trellis 的检查角色直接修问题，没有轮数上限（`pi/agents/trellis-check.md`：“Fix issues directly when they are within scope”）；反复调试后有一个 `break-loop` 技能，分析原因并把预防办法写回规范。

交付的拒绝原因：

- 在 `delivery-service.ts`、`delivery.ts`、`completion-service.ts`、`completion.ts` 里数到 33 种，其中提交文案 7 种、分支与绑定 5 种、授权 4 种；另有 13 种完成资格的拒绝原因。
