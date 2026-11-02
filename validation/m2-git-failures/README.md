# 任务019 Git、归档与封存故障验证

环境：Node v24.21.0、Git 2.52.0、临时真实 Git 仓库（测试结束删除）；未操作当前 Knit 工作区，未推送／合并／改写历史。

## 覆盖

- `tests/mixed-paths.txt`：同任务同时修改内容、新增可执行文件（100755）、重命名、删除；提交树与 index 只含实际范围。
- `tests/hook-reject.txt`：pre-commit 拒绝，保留未提交现场，任务不移动、无归档提交。
- `tests/hook-index.txt`：hook 把无关文件加入 index，实际提交范围／index 与预期不符，保留提交事实并 needs_attention。
- `tests/move-recovery.txt`：物理移动成功但 move 检查点丢失；按目标 Task ID 与封存摘要核实，不重复移动，归档提交仍只有一次。
- `tests/cross-month.txt`：失败后跨月重试沿用操作首次 archivePath（2026-11），不按当前月份改目标。
- `tests/target-conflict.txt`：目标已存在时保留外来文件，不覆盖、不移动。
- 任务020复验补充：work 提交后的外部提交被拒绝；归档 pre-commit 拒绝后 retry 补齐旧路径删除；归档额外同 message 提交不落盘为 archiveCommit，清理后可恢复。
- `tests/delivery-all.txt`：完整 27 项交付／归档测试。
- `report.json`：结果与边界摘要。

命令：

```text
node --test test/delivery.test.mjs
npm test
```

当前结果：delivery 27/27；全套 194/194。

## 边界

未强制 SIGKILL Git 子进程，未测试外部并发、fetch／push／merge、冲突或历史改写；hook 内容验证只覆盖提交树模式与 blob，不验证签名。授权来源、完整 refs/heads、unknown defaultBranch 不猜 main／master 沿用既有实现与测试。
