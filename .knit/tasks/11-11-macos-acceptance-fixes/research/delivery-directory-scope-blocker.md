# 目录 scope 交付阻塞（2026-11-12）

- 正常交付 op-d2b8f5b40d91 在 artifact_commit 写入 8209aa13598a3fcb4bf2ba5c2c88cdad711e72d4 后停为 needs_attention / hook_changed_selected，尚无 metadataCommit 或 archiveCommit。
- 实际 Git 变更精确为原 expectedPaths 的 16 个路径；逐个 Git blob 的 SHA-256 均与受验胶囊相符，无额外路径。临时工作文件已原样恢复、index 为空；没有执行或改变 hooks（mode=skip，changes=[]）。
- 根因取证：expectedTree 仅有 6 个文档 blob，实际 tree 有 16 个；缺的 10 个都是 f1-fix/、f4-fix/ 内部文件。selectedPath("…/f1-fix/README.md", ["…/f1-fix/"]) 返回 false，而 Git 的目录 pathspec 会选中这些文件。故原检查点漏记目录叶文件，提交后被误报为 hook 改动。
- 不改原检查点、完成凭据或工作提交，不强制归档，不回退规则、不自动修改生产源码。保留该 operation 供后续正式修复与恢复；仅记录已经实际写入的合法成果提交。
- 其他资格仍有效、且不依赖此恢复缺口的任务可继续正常交付。后续完整本机验收在隔离 Git 夹具复现本问题，作为实际缺陷记录，不用旧测试冒充已修复。
