# 交接内容和 Worktree 对不上：实际看到的

2026-11-20，主会话从 W2、W3 四次真实执行留下的运行资料里查的（主检出的 `.knit/.runtime/runs/<执行>/message.md` 是执行者收到的第一条消息）。

## 1. 仓库资料附的是主检出里的那一份

W3 的任务点名了设计第 8 节。实现环节（`r-e7b9386ea6c9`）在 Worktree 里把这一节里的一行表格

    | Git 自己拒绝提交，例如 hook 失败 | 撤回：…

改成了

    | 移动任务目录失败，或 Git 自己拒绝提交（例如 hook 失败） | 撤回：…

之后派发的审查环节（`r-29d66a7820b3`）收到的第一条消息里，这一节仍然是改之前的：旧的那一句出现 1 次，新的那一句出现 0 次。审查拿到的设计不是它要审的那一份。

## 2. 任务目录和报告的路径在 Worktree 里读不到

同一条消息里各块的路径：

    <task path=".knit/tasks/11-20-w3-deliver-move-failures/task.md">
    <material path=".knit/tasks/11-20-w3-deliver-move-failures/reproduction.md">
    <material path="docs/design/DESIGN.md#8. 完成与交付">
    <previous-report stage="implement" path=".knit/.runtime/runs/r-e7b9386ea6c9/report.md">

执行者的工作目录是任务的 Worktree。Worktree 是从提交建出来的：`.knit/.runtime/` 被 Git 忽略，里面没有；任务目录交付之前没有入库，里面也没有（W2 的 Worktree 里 `.knit/tasks/` 下只有入过库的 `archive/`）。所以前两个和最后一个路径在 Worktree 里都不存在。

这四次执行里内容都附上了，没有超过上限，所以没有出事。超过上限时块里只有一句「没有附上；需要时按路径自己读」，执行者按相对路径就读不到。

任务目录入过库的任务更容易弄错：Worktree 里有一份建分支时的旧任务目录，相对路径读得到，但不是现在的内容。

## 3. 现在的代码

- `src/application/run-prepare.ts`：`assembleHandoff` 的 `root` 传的是主检出；它在建 Worktree（`ensureWorktree`）之前调用，交接有问题时直接拒绝。`reportOf` 给报告的是相对路径。
- `src/application/handoff.ts`：`task`、`plan` 块的路径用任务目录的相对路径拼；资料经 `readMaterials(input.root, …)` 读。
- `src/application/task-materials.ts`：`readMaterial` 在 `root` 下按相对路径读，读不出时返回「相关资料里点名的文件不存在：…」。
- 调用 `assembleHandoff` 的只有派发这一处；派发一定有 Worktree。
