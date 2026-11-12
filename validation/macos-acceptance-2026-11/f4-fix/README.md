# F4 修复真机复验（续接会话每轮 knit 上下文）

任务：`k-50d398bff55f`。环境：macOS 27.2.1、Node 26.3.0、Pi 1.5.2、Rex preview.14、模型 magpie/group/deepseek。
被测包：修复后 `npm pack` 266 文件 620.5 kB → `/tmp/knit-f4/app`；项目 `/tmp/knit-f4/proj`（`knit init` ready）。

## 探针

```text
pi -p --approve --session-id f4-probe "调用 knit_task action=use 选中 k-013300e4cd3e …"   # 第 1 轮：无选定任务
pi -p --approve -c "回复 OK"                                                              # 第 2 轮：已选中 A
pi -p --approve -c "调用 knit_task action=use 选中 k-72ac9922b1aa …"                      # 第 3 轮：改选 B
pi -p --approve -c "回复 OK"                                                              # 第 4 轮：应为 B
```

会话文件：`~/.pi/agent/sessions/--private-tmp-knit-f4-proj--/2026-11-11T16-25-11-697Z_f4-probe.jsonl`

## 结果（`injection-after.txt`）

```text
system#3 : TEXT: 当前无选定任务。…
system#11: TEXT: 当前任务：「F4 注入探针」（k-013300）…
system#25: TEXT: 当前任务：「F4 注入探针 B」（k-72ac99）…
```

- 每次任务上下文变化后的下一轮都拿到新上下文；选择改到 B 后下一轮即为 B，说明每轮刷新生效。
- 上下文未变化的轮次（第 3→4 轮之间内容相同）Pi 不重复持久化 system 分节，属分节 diff 行为，不代表未注入。
- 修复前同类探针（`../r3-bridge-injection.txt`）在续接轮出现 `knit=NULL`。

## 已知失败项（与本修复无关）

`test/run.test.mjs`「prepare 只发布请求；start 后 worker 自行持锁…」在本机稳定失败：worker 退出后 1s 内 `.locks/projects/<id>/owner.json` 仍在。已在 `58a2dc2` 干净 worktree 复现（同失败），与本机当前状态相关，非本次改动引入。
