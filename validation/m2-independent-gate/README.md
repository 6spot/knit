# M2 独立验收门槛（任务020）

结论：**M2 PASS**，具备在受控真实项目中试用的条件；这不是发布就绪结论，也不授权操作其它真实仓库或自动提交。

## 独立检查

检查者使用独立上下文／Session，未采信前面任务的总结，直接读取当前源码、运行当前 `dist` CLI，并在 `/tmp` 新建真实 Git／SQLite／锁夹具验证。最终报告见 [audit-report.md](audit-report.md)，场景原始结果见 [scenarios.json](scenarios.json)。

环境：Node v24.21.0、npm 11.19.0、Git 2.52.0、Linux。未运行真实付费模型链路；原生恢复沿用 `validation/m2-safety` 的真实模型 artifact 核对。

命令与结果：

```text
npm run -s typecheck                       PASS
npm run -s build                           PASS
npm run -s pack:check                      PASS（162 文件）
npm test                                   194/194 PASS（重复；一次 193/194 为无关 stage lock_busy flake）
node --test test/delivery.test.mjs         27/27 PASS
```

## M2 门槛

| 项 | 结果 |
| --- | --- |
| 快照／index／模式／删除／符号链接恢复 | PASS |
| 项目锁、Session 锁、token unlock、进程树取消 | PASS |
| 取消竞争、无 result 取消、completed 未接收守卫 | PASS |
| 重复接收／接收检查点／草案与 close 竞争 | PASS |
| 无关 index、hook 拒绝／改 index／扩范围、工作提交回执丢失 | PASS |
| work 提交后额外历史、删除／重命名重复提交、归档拒绝重试 | PASS |
| 归档额外同 message 提交不落盘错误候选，清理后恢复真实提交 | PASS |
| 封存补记、move 检查点丢失、跨月 archivePath | PASS |
| 打包不含 src/test/tasks/validation/研究/私有记录 | PASS |
| bridge schema 与 TypeScript 导出同源 | PASS |

## 本轮发现并修复

- 终态 `failed`／`cancelled` run 不再永久阻塞 close／deliver；`completed` 仍必须有 result 和 completed 接收回执。
- 工作／归档提交在提交前保存 before／expectedPaths／expectedTree；恢复核验 HEAD、父节点、message、路径集合和树。
- 删除／重命名在 pre-commit 失败后重试时，已在 index 删除的路径只进入 commit pathspec，不重复 add。
- 归档核验失败不持久化错误 `archiveCommit`；清理额外提交后同一操作可恢复真实归档提交。
- 取消宽限、快照上限、心跳间隔接入项目配置；SMB2 锁根拒绝；封存 record 在任务锁内重读标记。

## 未验证边界

- 未重跑真实付费模型；真实原生恢复使用既有 artifact。
- 未挂载真实 NFS／SMB／FUSE，仅静态核对文件系统 magic。
- 未模拟 SQLite WAL 断电损坏、Windows/macOS、真实 fetch／push／merge／rebase／签名。
- 旧版本可能已落盘的错误 `archiveCommit` 不自动迁移；当前代码不会新产生，旧本地库需人工核实。
- `test/stage.test.mjs:179` 在机器负载下偶发 `lock_busy`，不改变业务事实；重跑或显式重试即可。
