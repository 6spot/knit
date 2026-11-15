# 已发生的故障（避坑清单的素材）

整理于 2026-11-15。来源是本机才有的记录（`.knit/.runtime/runs/`、主会话记录），克隆里看不到，所以摘在这里。每条只写查得到的事实；没核实的地方照写“未核实”。

标了「仅旧 Knit」的条目只在切换到小核心之前成立。

## 给执行者的（实现、审查）

| 编号 | 现象 | 原因 | 来源 |
| --- | --- | --- | --- |
| W1 | 执行被记为失败：`report_not_json` | 最终报告不是 JSON，开头是模型的工具调用标记（`<｜DSML｜…`） | run-235cb3f05624，任务 k-1d796caf7d12 |
| W2 | 执行被记为失败：`changed_paths_mismatch:test/rex.test.mjs` | 报告里自报的改动文件和实际改动不一致 | run-5c6d69d23f06，任务 k-1b0c477f4bc6 |
| W3 | 审查打回：报告的测试数不准 | 实现报告写 `npm test` 727/727，实际 726/727，有 1 个失败没写 | run-0c04b3e5c5ab，任务 k-50d398bff55f |
| W4 | 审查打回：测试全过但没覆盖真实路径 | 测试夹具用的是未包装的字符串，真实 Pi 给的是包了 `<knit>…</knit>` 的分节；20/20 通过证明不了失败路径 | 同上，`test/bridge-query.test.mjs:1109`、`:1019` |
| W5 | 审查打回：每轮多包一层 `<knit>` | 把 Pi 已经渲染过的分节当成原始内容写回，Pi 再包一层 | 同上，`.pi/extensions/knit.ts:871`、`:953`、`:977` |
| W6 | 审查打回：测试偶发失败 | 信号文件先创建再写内容，读的一方可能读到半个文件；应先写临时文件再改名 | run-07e589756c90，任务 k-8fc483a6e41e，`test/bridge-query.test.mjs:854`、`:910–914` |
| W7 | 测试偶发失败：`ENOTEMPTY` | 临时目录还在被写就删除；修复见提交 039bd19 | 任务 k-0893a9b03544；另见 `test/stage.test.mjs:2067` |
| W8 | 只改了成对副本中的一份，测试失败 | 三对文件由测试逐字比对：`assets/templates/pi/extensions/knit.ts` 与 `.pi/extensions/knit.ts`；`agentsManagedBlock()` 与 `AGENTS.md` 受管块；`assets/templates/.knit/workflow.yaml` 与内置默认流程 | `test/host-selection.test.mjs:427`、`test/init.test.mjs:112`、`:617`、`:680`、`test/m1-cli.test.mjs:362`。仅旧 Knit |
| W9 | 交付被凭据扫描拦下 | 命中 `test/rex.test.mjs` 第 322 行；是不是误报未核实 | 主会话记录 11-06。仅旧 Knit |

## 给主会话的（讨论、收尾）

| 编号 | 现象 | 原因 | 来源 |
| --- | --- | --- | --- |
| M1 | 执行者照任务的限制做就过不了验收 | 任务里写了“不改 `.pi/extensions/knit.ts`”，是凭印象写的；实际没有机制保护这个路径，而测试要求它和模板逐字一致，与“`npm test` 全通过”矛盾 | 任务 k-185ace3b9556，run-d0b0bc1ffacb；候选 c-9bb9ed19ed83（`.knit/standards/candidates.md`） |
| M2 | 两笔交付卡了约 28 小时 | 交付进行中时，一个修复提交（e717f95）改了 `AGENTS.md`；旧 Knit 拿它的内容算策略版本，于是 `--retry` 报 `policy_changed`，`--recover-policy` 报 `policy_recovery_effects`，互相拒绝 | 任务 k-185ace3b9556、k-7e4dbba9dca7；`.knit/tasks/archive/2026-11/11-14-policy-recovery-retry/task.md`。仅旧 Knit |
| M3 | 交付被拒：`stale_input` | 检查通过之后又改了任务输入或规范文件 | 主会话记录 11-12。仅旧 Knit |
| M4 | 交付被拒：读不到提交文案 | 传给工具的文案文件路径是错的 | 主会话记录 11-12 |
| M5 | 交付被拒：`hook_changed_selected` | 目录路径带了尾斜杠 | 主会话记录 11-12。仅旧 Knit |
| M6 | 本仓库的配置被覆盖 | 在本仓库运行 `knit init --force`，覆盖了 `config.json`、`workflow.yaml`、`runtimes/pi.md` | 11-07、11-11；备份在本机 `.knit/.runtime/init-backup/` |
| M7 | 创建任务失败 3 次 | `knit_task` 的 `new` 不接受 `verification`；要创建后再用 `verification` 动作设置 | 主会话记录。仅旧 Knit |
| M8 | 一天里为交付调用了 25 次工具 | 10 个任务完成后没有及时交付，积压到一起处理 | 主会话记录 11-12 |
| M9 | 同一个执行连续失败 | 3 次是模型服务不可用（`Claude: Service Unavailable`），2 次是启动时连接断开；重试解决不了 | run-157bf768958f、run-2c54709c7fe4、run-d0b0bc1ffacb；run-4a2ba08b89d8、run-a7cfe8ba24f6 |
| M11 | 每轮回复末尾都写一句“本轮没有写入正式规范” | 把“写入规范后要告知”理解成了每轮都要说；用户要求只有真的写入了规范才说 | 用户 2026-11-15 |
| M10 | 调查结论说错了三处，事后更正 | 没核实就下结论：把凭据扫描的拦截说成“误报”；说 Worktree“完全没用过”；说候选“未审阅”（实际 11-11 审阅为 deferred） | 本任务的调查，2026-11-14 |
