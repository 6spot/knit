# 设计文档整理用的脚本和核实（2026-11-18）

重构之后要把 `docs/design/` 从旧 Knit 的七份文档换成现行设计。这里是几个任务要用的脚本，和一份核实用的测试。脚本都在仓库根目录运行，只用 Node 自带的模块。

| 文件 | 用途 | 哪个任务用 |
| --- | --- | --- |
| `check-links.mjs` | 列出 Markdown 里指向不存在路径的链接；没有断链时退出码 0 | 几个任务的验证 |
| `relink-old-design.mjs` | 旧设计文档移到 `docs/history/design/` 之后，把指向它们的链接和它们往外指的链接改对 | H5a |
| `split-design.mjs` | 把主任务的 `design.md` 拆成 `docs/design/DESIGN.md`（第 1–11 节）和留在原处的第 12–14 节 | H5b |
| `design-7.3.md` | 要插进 `docs/design/DESIGN.md` 的第 7.3 节：执行目录里的文件坏了怎么恢复 | H5f |
| `broken-run-files.test.mjs` | 核实第 7.3 节写的表现和恢复办法；用假的 Pi，不调用模型 | H5f、L1 |

## 已经核实的

环境：macOS 27.2.1（arm64）、Node 26.3.0、Git 2.54.0，提交 `7e4b388`。

- `check-links.mjs docs README.md AGENTS.md`：现在没有断链，退出码 0。写一个带两条断链的文件试过，两条都列出来，退出码 1。
- 在一份克隆里依次做了 H5a 和 H5b 的步骤：
  - 七份文件用 `mv` 移走之后有 139 条断链；`relink-old-design.mjs` 输出「改了 142 处」，之后没有断链；再运行一次输出「改了 0 处」。七份文件除链接的目标以外逐行相同。改动的文件都在 `docs/`、`README.md`、`AGENTS.md` 和主任务的 `task.md` 里。
  - `split-design.mjs` 输出「替换 29 处」。`docs/design/DESIGN.md` 有 11 个带编号的二级标题，任务里列的旧说法一条都搜不到；主任务的 `design.md` 只剩第 12–14 节，和原来逐行相同；之后没有断链。再运行一次报错退出，什么都不写。
- `node --test validation/slim-h5-2026-11/broken-run-files.test.mjs`：6 个测试都通过。

## 没有核实的

- Linux 上都没有跑过。
- `design-7.3.md` 里「执行者在 Rex 的窗格里跑时，另外关掉那个窗格」没有试过：测试只覆盖后台执行。
- `relink-old-design.mjs` 和 `split-design.mjs` 按 `7e4b388` 时的文件内容写的。在那之后改过 `README.md`、`AGENTS.md`、`docs/` 或主任务的 `design.md`，替换的次数会变，`split-design.mjs` 可能报错退出。

## 做这些时发现的问题

任务里的文件用 `git mv` 或 `git rm` 改过（删除已经暂存）时，`knit deliver` 第一次会失败：`fatal: pathspec '…' did not match any files`，交付撤回；撤回时暂存被撤掉，第二次就成功。所以 H5a、H5e 的步骤里移动文件用普通的 `mv`。修这个问题是任务 F7。
