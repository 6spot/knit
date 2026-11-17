# 小核心的全流程演练（2026-11-17，任务 k-62ebc05deb50）

用真的 Pi 和真的模型，把 `next/` 里的新 Knit 从创建任务走到交付。在这之前，新代码的测试全部用假的 Pi，桥接也没有被真的 Pi 加载过。

结论：三个场景都通过。发现两个问题，都不挡流程，见「发现的问题」。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 | macOS 27.2.1，arm64 |
| Node | 26.3.0 |
| Git | 2.54.0 (Apple Git-157) |
| Pi | 1.5.2 |
| 模型 | `magpie/group/deepseek`，主会话和执行者都用它 |
| 本仓库 | `main`，提交 `d9d5b76`；演练前 `npm run test:next` 是 211 个全部通过 |
| 新的 Knit | 没有安装：`PATH` 最前面放一个 `knit`，内容是用 `node` 运行本仓库的 `next/dist/cli/knit.js` |

演练都在 `/tmp/knit-h1/<场景>/proj` 里做，每次重建。项目由 `setup.sh` 建：一个 `greet.mjs`，一个 `AGENTS.md`，`knit init`，流程里写上模型，两份规范（一份给实现和审查环节，一份给收尾环节）。演练的任务在 `task-body.md`，要求独立审查，两个场景。

## 结果

| 场景 | 结果 | 脚本 | 证据 |
| --- | --- | --- | --- |
| 用命令行走完，执行者是真的 Pi | 通过 | `cli-flow.sh` | `logs/cli-flow.log`、`logs/cli/` |
| 主会话通过桥接走完 | 通过 | `bridge-flow.mjs` | `logs/bridge-flow.log`、`logs/bridge/` |
| 取消正在跑的执行 | 通过 | `cancel.sh` | `logs/cancel.log` |

### 用命令行走完

`task new`、写需求、`task ready`、`run start` 加 `run wait`（实现）、`run start` 加 `run wait`（审查）、`task close`、`deliver --preview`、`deliver`。

- 两次执行都正常结束：实现 14.5 秒，改了 `greet.mjs`、`greet.test.mjs`；审查 19.4 秒，结论 `pass`，没有改文件。`node --test` 是 2 个通过。
- 执行者读到了 `AGENTS.md`：两次执行的会话记录里，系统提示都带着这个项目的 `AGENTS.md`；两份报告的第一行都是它要求的 `AGENTS-MARK: 7f3a`。
- Knit 准备的 `system.md`（角色文件、规范、规则）整份在 Pi 的系统提示里；里面只有这个环节的规范，没有收尾环节的那一份。
- 执行者拿到的工具正好是流程里 `tools: [read, write, exec]` 对出来的七个：`read`、`grep`、`find`、`ls`、`write`、`edit`、`bash`。
- 审查的执行者收到了实现报告（`logs/cli/<审查的执行>/message.md` 里的 `previous-report`）。
- 交付产生一次提交 `f9bbedb feat: let greet take a greeting word`，里面是 `greet.mjs`、`greet.test.mjs` 和归档之后的 `task.md`、`record.json`，最后一行是 `Knit-Task: k-c216b7b003d6`。之后工作区是干净的，`knit task show` 的状态是 `delivered`，并且查得出这次提交。

### 主会话通过桥接走完

主会话是 `pi --mode rpc --approve`，脚本当用户发了五条消息，最后一条只有「可以交付」。

- 桥接由 Pi 从项目的 `.pi/extensions/knit.ts` 自己发现并加载。模型调用了 `knit_task`（`new`、`use`、`ready`、`close`）、`knit_run`（`start` 两次）、`knit_deliver`（预览一次、交付一次），`task.md` 的正文是它用普通的 `read`、`write` 改的。
- 每轮注入：会话记录里系统提示的 `knit` 那一段先后是六个样子，从「没有选中 Knit 任务」到 `draft`、`ready`、`active(implement)`、`active(review)`、`done`。五条用户消息加两条结束消息一共开始了七轮，这一段只在内容变了的时候补发。
- 规范按环节给了主会话：任务是 `ready` 和实现做完之后，那一段里是给实现、审查环节的规范；审查通过之后和 `done` 的时候，换成给收尾环节的规范。
- 执行结束的通知：发完第三条消息之后脚本没有再说话。实现结束时主会话收到一条 `knit.run-ended` 消息并自己开始一轮，在这一轮里派发了审查；审查结束时又收到一条、又开始一轮，然后按要求停下来。这一段一共 32.2 秒。事件记录里七轮中有两轮是由 `knit.run-ended` 消息开始的。
- 预览没有改任何东西：预览之后任务是 `done`，没有新提交。
- 授权核对：说「可以交付」之后产生一次提交 `95f156b`；`record.json` 里的授权是 `user:88323443 可以交付`，`88323443` 就是会话记录里那条用户消息的条目 id。
- 真的 Pi 里用户消息的 `content` 是一个数组（`[{type: "text", …}]`），桥接两种写法都认，这次走的是数组这一支。

### 取消正在跑的执行

任务让执行者在前台运行 `sleep 613`。派发 3.5 秒后它开始运行，这时有三个进程：Knit 的后台进程、它启动的 Pi、`sleep 613`。

- `knit run cancel` 以退出码 0 返回，用了 0.4 秒。
- 三个进程都不在了；这次执行记为失败，原因是「已取消」；`knit run status` 的下一步是重新派发实现环节。

## 另外记下的

1. 派发之前的拒绝（`refusals.sh`，`logs/refusals.log`）。九种情况 `knit run start` 都以退出码 1 拒绝，都没有留下执行目录：

   | 情况 | 输出 |
   | --- | --- |
   | 需求还没有确认 | `需求还没有确认，或确认之后改过；先运行 knit task ready <id>` |
   | 依赖的任务没有完成 | `依赖的任务还没有完成：<id>（draft）` |
   | 依赖的任务不存在 | `依赖的任务不存在：k-000000000000` |
   | 任务已经结束 | `任务已经结束（done），不能再派发` |
   | 流程里没有写模型 | `没有指定执行者的模型：在 .knit/workflow.yaml 里写 model，或加 --model provider/模型` |
   | `task.md` 写坏了 | `没有任务 <id>；用 knit task list 查看现有任务`（见「发现的问题」第 1 条） |
   | `workflow.yaml` 写坏了 | `第 32 行：YAML 解析失败：…` |
   | `config.json` 写坏了 | `.knit/config.json：不是合法的 JSON：…` |
   | 项目不在 Git 仓库里 | `这个目录不在 Git 仓库里，不能派发执行者` |

   模型不存在不是派发之前能发现的：派发成功，执行者启动 Pi 之后在选模型这一步失败，这次执行记为 `执行者启动失败：set_model 被拒绝: Model not found: magpie/no-such-model`，可以重新派发。

2. 项目信任（`trust.mjs`，`logs/trust.log`）：`--approve` 时桥接的三个工具都注册并启用，来源是项目；`--no-approve` 时一个都没有。这一项不调用模型。
3. 重开会话：场景二做完之后用 `--session <会话文件>` 重开，问现在选中的是哪个任务。系统提示里补发了 `knit` 那一段，主会话答出了任务的 id 和状态 `delivered`。选中的任务写在会话记录里（一条 `knit.selection`），重开之后还在。
4. 取消用了多久：0.4 秒。
5. 每次执行用了多久：留在 `logs/` 里的四次是 14.5、19.4、14.0、9.9 秒；调脚本时另外记下的十四次在 9.3 到 20.8 秒之间。
6. 规范按环节给：执行者的 `system.md` 里只有实现、审查环节的那一份；主会话每轮收到的那一段里，规范随任务走到的环节换（见上面两个场景）。任务还是 `draft` 时是讨论环节，演练的项目没有给这个环节的规范，那一段写的是「规范（discuss 环节）: 没有」。

## 发现的问题

1. `task.md` 的元数据写坏时，按 id 的命令都说「没有任务」。把 `priority` 改成不认识的值之后，`knit run start`、`knit task show`、`knit context`、`knit run status` 都输出 `没有任务 <id>；用 knit task list 查看现有任务`，不说文件哪里坏了。照着提示运行 `knit task list`，最后一行才有原因：`.knit/tasks/11-17-plain：task.md：字段 priority 的值不对：…`。原因是命令按元数据里的 id 找任务，文件读不出来就没有 id 可比。按桥接的代码，主会话选中的任务遇到这种情况时，每轮看到的会是「选中的 Knit 任务 <id> 读不出来：没有任务 <id>…」；这一条没有实际跑。
2. `worker.log` 一直是空的。派发的输出和 `knit run status` 都把它当作日志指给人看，但正常结束、启动失败、正在跑、被取消这四种情况下它都是 0 字节：后台进程只在自己出错时才往里写。执行过程实际能看的是执行目录里的 `session/*.jsonl`，执行者一边跑 Pi 一边写。

另有一件不是 Knit 的问题：调脚本和正式运行里核对过 18 份报告，其中 1 份审查报告没有把 `AGENTS-MARK: 7f3a` 写在第一行，前面多了一个标题（`logs/cli-flow-mark-on-line-3.log`，那一次脚本还要求它在第一行，所以以失败结束）。那次执行的系统提示里同样带着 `AGENTS.md`，是模型没有完全照办。脚本核对的因此是「系统提示里有 `AGENTS.md`」和「报告里有单独的这一行」。

## 没有验证的

- Linux。用户决定放到最后，本机 macOS 全部走通之后再跑。
- 交互界面：主会话只用 rpc 模式跑过。终端界面里第一次打开项目时的信任询问、`knit.run-ended` 消息显示成什么样，没有看。
- 返工：审查每次都是 `pass`，没有出现过 `changes_requested`，回到实现环节、到返工上限这两条路没有用真的模型走过。
- 主会话的这几条路：用 `knit_run` 的 `cancel` 取消（只用命令行取消过）；引用的授权原话在会话里找不到；会话在执行还没结束时重新加载。
- 流程里带 `external`、`network` 的环节：执行者这时会加载扩展、联网，没有跑。
- 别的模型：只用了 `group/deepseek`。
- 安装：`knit` 是指到 `next/dist` 的一个小脚本，不是安装出来的；安装留到切换时。

## 怎么重跑

```bash
npm test                               # 先生成 dist；演练进行时不要再运行它
cd validation/slim-h1-2026-11
./refusals.sh && node trust.mjs        # 这两个不调用模型
./cli-flow.sh && ./cancel.sh && node bridge-flow.mjs
```

每个脚本以退出码 0 结束就是通过，不满足的那一条会写在输出里。要求本机有 Pi 1.5.2 和 `magpie/group/deepseek`。

`logs/` 里的事件记录不含流式输出的增量和 `get_entries` 的响应。主会话启动时加了 `--no-context-files`：不加的话，用户主目录下 `AGENTS.md` 的全文会进系统提示，跟着会话记录存进仓库。执行者不受影响，它们由 Knit 启动，照常读 `AGENTS.md`。
