# 任务016 快照逐路径恢复验证

环境：Node v24.21.0、Git 2.x、真实 Git 仓库 `/tmp/knit-016-e2e`（临时项目，已不纳入当前工作区）。未调用真实模型；使用 `test/fixtures/fake-pi.mjs` 生成一次真实 Git 快照，随后用 `dist/cli/knit.js` 执行预览与恢复。

## 场景与结果

1. `test/fixtures/fake-pi.mjs` 实施前快照 ready；`snapshot/index/` 保存与工作区不同的 `app.txt` index blob，manifest 记录 `indexDigest`。
2. 快照后修改工作区与 index、改变 `tool.sh` 执行位、删除文件并新建 `created.txt`；`snapshot show` 只读输出元数据。
3. `snapshot restore` 默认预览；按三条 `--expect <path=指纹>` 执行，`--index --remove-created`：
   - `app.txt` 恢复快照字节，index 恢复为快照 blob；
   - `tool.sh` 恢复 0755；
   - `created.txt` 被删除。
4. Task 输入恢复：先经 task update 改为后来输入，再从快照路径恢复；实际调用 task update（保留 frontmatter／记录），结果 `taskInputUpdated=true`。
5. 切换分支后恢复被拒绝（`stale_input`），不写文件。
6. 真实 Git／文件断言见 `report.json`；CLI 协议输出见 `show.json`、`restore.json`、`task-input-*.json`、`branch-rejected.json`；操作记录在 `restores/`。

## 未覆盖／边界

- 子模块不恢复；目录不递归删除；ignored 路径不进入快照；同一文件不提供分块恢复。
- 旧快照没有 `indexDigest` 时，`--index` 明确拒绝，不伪造 index 内容。
- 快照不是外部服务回滚，不自动 stash／reset；本次不推送、不提交当前 Knit 工作区。
