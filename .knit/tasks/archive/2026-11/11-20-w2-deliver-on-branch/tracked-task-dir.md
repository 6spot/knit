# 任务目录入过库时：在分支上交付再合并

2026-11-20 在临时仓库里试的，Git 2.54.0，macOS。只试了下面这一种顺序。

做法：

1. 主分支上提交了 `.knit/tasks/11-20-x/task.md`（内容 `v1`）和 `src/a.txt`。
2. `git worktree add -b knit/11-20-x <位置> HEAD`：任务分支上也带着 `v1` 的那一份。
3. 主检出里把 `task.md` 改成 `v2`，不提交（任务记录在执行期间一直在主检出里变）。
4. Worktree 里新建 `src/b.txt`。
5. 删掉 Worktree 里原位置的任务目录，把主检出里的任务目录移到 Worktree 的 `.knit/tasks/archive/2026-11/11-20-x/`。
6. 在 Worktree 里 `git add -A -- src/b.txt .knit/tasks/11-20-x .knit/tasks/archive/2026-11/11-20-x`，提交。

结果：

- 提交里有三处：原位置的 `task.md` 删除、归档位置的 `task.md` 新增（内容 `v2`）、`src/b.txt` 新增。
- 这时主检出的 `git status --short` 是 ` D .knit/tasks/11-20-x/task.md`：文件被移走了，主分支上还记着它。
- 在主检出里 `git merge knit/11-20-x`：退出码 0，快进。
- 合并之后主检出的 `git status --short` 没有输出；`.knit/tasks/` 下只剩 `archive`；归档里的 `task.md` 是 `v2`。

没有试过的：主分支在建分支之后又提交过这个任务目录的情况（这时不能快进，原位置的文件一边改了、一边删了）。

另外试过：主仓库的 `pre-commit` hook 在 Worktree 里提交时照样运行，hook 以非零退出时提交被拒绝，退出码 1。
