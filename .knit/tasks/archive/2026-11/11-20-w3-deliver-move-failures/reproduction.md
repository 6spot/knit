# 交付时的两个缺陷：复现办法和结果

2026-11-20，主会话在 W2 的 Worktree 里（提交 `93472d2` 的内容）试的。macOS，Git 2.54.0。测试脚本是临时写的，没有留下；下面是做法和实际看到的结果。

共同的准备：用测试辅助建一个临时 Git 项目（`runProject`、`readyTask`），`.gitignore` 里忽略 `.knit/.runtime/`；用 `prepareRun` 派发，在 Worktree 里新建 `src/a.txt`，用 `finishRun` 结束；`knit task close`；再带授权和提交文案运行 `knit deliver`。现成的写法见 `test/deliver-worktree.test.mjs` 开头的 `completed`。

## 内存盘

用来造一个和主目录不在同一个文件系统的可写位置：

```sh
DEV=$(hdiutil attach -nomount ram://65536 | awk '{print $1}')   # 32 MB
diskutil erasevolume HFS+ knitexdev "$DEV"                       # 挂在 /Volumes/knitexdev
# 用完：
hdiutil detach "$DEV" -force
```

试的时候三处的设备号：项目 16777230，内存盘 16777252。

## 1. 跨文件系统时交付失败并且卡住

情况 A：Knit 的用户目录在另一个文件系统（`KNIT_HOME=/Volumes/knitexdev/home`），任务目录没有入过库。

- 派发和结束都正常，记下的改动文件是 `src/a.txt`。
- `knit deliver` 退出码 1，标准错误里是 Node 的调用栈：`Error: EXDEV: cross-device link not permitted, rename '<主检出>/.knit/tasks/11-20-task' -> ...`。
- 之后：主检出里任务目录还在，`task.md` 的状态是 `delivered`；任务分支的 `HEAD` 没有变。
- 再运行一次 `knit deliver`：退出码 1，「任务 … 已经结束（delivered），不能交付」。

情况 B：系统临时目录在另一个文件系统（运行 `knit deliver` 时 `TMPDIR=/Volumes/knitexdev`），任务目录在派发之前入过库，项目和 Worktree 在同一个文件系统。

- `knit deliver` 退出码 1：`Error: EXDEV: cross-device link not permitted, rename '<Worktree>/.knit/tasks/11-20-task' -> '/Volumes/knitexdev/knit-delivery-…/task'`。
- 之后：主检出里任务目录还在，状态是 `delivered`；任务分支的 `HEAD` 没有变；Worktree 的 `git status --porcelain` 是 `?? src/`；内存盘上留下一个空的 `knit-delivery-*` 目录。

两种情况出错的位置都在 `src/cli/deliver.ts`：状态和授权已经写回之后，才移动目录；移动抛出异常时没有撤回。

## 2. 任务目录被 Git 忽略的项目丢任务记录

准备时 `.gitignore` 多写一行 `.knit/tasks/`，其余同上，都在同一个文件系统。

- `knit deliver` 退出码 0。任务分支上的提交里只有 `src/a.txt`。
- 这时任务记录在 Worktree 的归档位置下，主检出里没有。
- 主检出里 `git merge knit/<任务目录名>` 快进成功；主检出里仍然没有任务记录。
- `git worktree remove <位置>` 成功，没有输出（被忽略的文件不拦删除）。
- 之后任务记录不在任何地方；`knit task show <id>` 退出码 1，「没有任务 …；用 knit task list 查看现有任务」。
