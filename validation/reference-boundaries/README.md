# Trellis、GSD Core、Spec Kit 如何处理四项边界

本轮是固定源码核查，未运行参考项目的模型任务或测试套件。只核查与 Knit 当前 Pi 入口、恢复、模型、取消、提交相关的实际路径；不同平台、可选扩展和其它入口不相互外推。

固定版本：Trellis 0.6.17 / `f089cb3286071199e84118dee86b6d76aab032f1`；GSD Core next 1.19.0 快照 / `1ec5c812b79dc1cc487d0873d18b03449b11c106`；Spec Kit 1.2.6.dev0 快照 / `7370e592f3cd9c06e5b698983957e227c75b30e2`。不把开发快照称为当前稳定版。

**结论：它们承担的保证各不相同。Trellis、GSD 的 Pi 子任务主要用一次性会话，Spec Kit 的恢复主要是工作流步骤续跑；取消有实际代码，但边界有限；模型可用性和任意 hook 下的提交隔离并没有统一强保证。** 不能说它们什么都没有，也不能把它们当作已经完整解决这四项限制的证明。

## 对照

| 问题 | Trellis | GSD Core | Spec Kit |
| --- | --- | --- | --- |
| 原生会话缺失却新建空会话 | Pi 扩展的子任务显式 `--no-session`；该路径不恢复持久 worker 会话。另有通用 CLI 适配器拼接恢复命令，不能外推为文件／ID 校验已完成 | Pi `gsd_dispatch` 同样 `--no-session`。`resume-project` 读项目状态和计划、继续任务，不等于重新打开原 worker 原生记录 | Pi integration 启动 `pi -p`，没有在该调用里绑定旧原生 Session；workflow resume 复用／跳过步骤检查点。默认 CLI 可能保存记录，但这不是 workflow 恢复协议 |
| 指定模型是否真的可用 | 输入 model → 角色配置 → 当前宿主实际 provider/id，然后传 `--model`；这条路径没查本机可用模型清单 | 有 profile、tier、override 和运行时映射；Pi 主请求 steering 在未显式配置或解析失败时保留客户端模型，属于 fail-open。子任务传角色 model；不是 Knit 的“指定不可用即阻塞”协议 | step 参数／执行上下文解析 model，然后 Pi integration 传 `--model`；该路径无 Pi 可用清单或 `set_model` 前置校验 |
| 取消 CLI 是否连工具一起结束 | Pi 扩展处理 AbortSignal，向直接 CLI 子进程发 SIGTERM，宽限后 SIGKILL；不是跨进程树保证。其它 hook helper 的进程组处理不等于此入口也具备 | Pi dispatcher 以独立组启动，POSIX 杀进程组，Windows 使用 taskkill /T；有超时及升级杀。覆盖它控制的组，不能保证已脱离该组的程序 | capture executor 有 `_ProcessTree`：POSIX 新会话／killpg，Windows Job；Ctrl+C 取消活动 capture。源码明确说明脱离组／Job 的 helper 能存活 |
| Git 限定提交及 hook 越界 | archive 自动提交先选择资料路径，commit 带 pathspec，减少无关暂存混入；archive 目录可能作为整个子树纳入，并非严格仅本任务。safe-add 不强行加入用户忽略的目录；但不是任意 hook 副作用隔离 | `cmdCommit` 选路径，用独立 `GIT_INDEX_FILE` 并 `commit --only`，保护普通预暂存现场。成功后返回 HEAD hash，未在这个成功路径核对实际 commit 路径仍等于请求集合 | 有可选 Git 扩展，自动提交默认关闭；启用后脚本在项目目录执行 `git add .` + `git commit`，不是单任务范围提交 |

## 1. 会话恢复：恢复的对象不同

Trellis `buildPiArgs` 和 GSD dispatcher 都明确加 `--no-session`，因此没有在这些 Pi worker 路径上建立“worker 原生文件存在、原 ID 不变、缺失不得新建”的承诺。它们让新进程重新获得任务／角色上下文。

Trellis 的 `cli_adapter.py` 另有 `build_resume_command`，会按平台拼接原生恢复命令。不能据 Pi worker 的 `--no-session` 宣称整个 Trellis 完全没有原生恢复入口；也不能把拼命令当成已经做了原生文件和身份校验。具体命令还须按本机客户端版本验证。

GSD 的 resume 工作流从 `.planning/STATE.md`、计划／总结及中断标记重建工作进度。Spec Kit 的 prompt step 用内容／集成／模型等元数据匹配检查点，符合时跳过已完成执行；`--resume-from` 处理的是 workflow step。二者与 Knit 之前设计的“打开同一个 worker 原生对话”不是同一功能。

Knit 若保留原生恢复，可以直接使用已实测的 CLI，增加记录存在和实际 ID／历史校验；失败明确报告。参考项目不构成引入 SDK 的理由，也不授权静默新建替代会话。

依据：

- [Trellis Pi 参数](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/pi/extensions/trellis/index.ts.txt#L703)
- [Trellis 通用恢复命令](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/scripts/common/cli_adapter.py#L480)
- [GSD Pi dispatcher](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/pi/gsd.cjs#L1171)、[项目恢复](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/workflows/resume-project.md)
- [Spec Kit Pi 执行参数](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/src/specify_cli/integrations/pi/__init__.py)、[prompt 检查点](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/src/specify_cli/workflows/step/prompt/__init__.py#L144)

## 2. 模型：配置解析与真实可用性分开

Trellis 对显式值、角色值和当前宿主模型的优先级与 Knit 的方向相近；`contextModelRef` 直接取 `ctx.model.provider/id`。它仍把模型选择交给 CLI，未在所查执行路径检查 Pi 可用清单。

GSD 的模型映射代码很丰富，但其中有降级／保留客户端选择的策略。Pi `before_provider_request` 未显式配置相应 override 时不覆盖模型；解析失败也返回 undefined 保留 Pi 当前选择。这是它的策略，不满足 Knit 已选择的“明确指定不可用就阻塞”。该 hook 还注明只适用于相应 provider payload，不能外推至所有模型提供方。

Spec Kit 配置层的 model fallback 是从 step 取执行上下文默认值，不代表运行时模型失败会自动替换成另一个模型。所查 Pi 路径只透传参数，不能据此宣称它实现了可用模型验证或静默换模。

Knit 最小做法是启动后校验本地清单或受校验的 `set_model`，再核对实际选择，不建设自己的模型目录或鉴权运行时。

## 3. 取消：有实现，但没有无限保证

Trellis Pi 扩展的 abort 直接杀 CLI；GSD 的 Pi dispatcher 杀进程组，优于只杀一个 PID。GSD 还设默认 30 分钟调度超时；这与 Knit 已定的“不按固定总时长停止任务”不同，不照搬。

Spec Kit 写得最明确：`_ProcessTree` 管的是组／Job，脱离它的进程会存活。它还限制中断后等待 reader 线程的时间，避免逃离的 helper 持有 pipe 导致取消永远挂住。Windows Job 初始化失败时不会放任 CLI 继续运行。

这些都不是“操作系统任意后代／远端副作用已经结束”的保证。我们自己的 Pi 强杀实验已经出现受控工具脱离被杀范围而存活，因此不能只复制一段 killpg 就把 Knit 的该项风险标成解决。

Knit 可使用原生 RPC abort 处理正常取消；异常进程死亡则核实现场，对无法确认的占用阻塞并说明。不会为了自动接管未知工具而增加 SDK 或服务。

依据：[Trellis abort](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/pi/extensions/trellis/index.ts.txt#L1544)、[GSD terminate](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/pi/gsd.cjs#L1057)、[Spec Kit ProcessTree](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/src/specify_cli/integrations/_capture.py#L150)。

## 4. 提交：范围选择不等于隔离 hook

Trellis archive 会选择任务资料路径再带 pathspec 提交，保留普通未涉及路径的暂存变化。这里的白名单仍可包含整个 `.trellis/tasks/archive/` 子树与被更新的子任务目录，比 Knit 的严格单任务范围更宽。其 safe-add 特别防止忽略目录被 Agent 用 `git add -f .trellis/` 整体加入；但 safe-add 的职责不是校验 hook 最终写入了什么。

GSD `cmdCommit` 针对已有暂存内容有独立 index 和 `--only` 处理。这值得参考；但该成功路径只取 HEAD hash 返回，没有在成功后把真实 commit 路径重新与请求集合对账。其其它工作流还存在直接提示 Agent 使用 Git 的路径，不能把这个 helper 的保护推广到每一条提交。

Spec Kit 的自动提交是可选扩展并默认关闭。打开后 `git add .` 会按项目范围收集变化，明显不符合 Knit 的单任务限定提交规则。它也不是在替 Knit 解决这个问题。

Knit 保持限定路径与普通 index 保护，并核对实际 commit。hook 造成额外提交时保留事实、停止后续交付并报告；这不等于事先阻止了 hook 的任意副作用，不能自动 amend／reset 抹掉事实。

依据：[Trellis archive commit](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/scripts/common/task_store.py#L1490)、[safe-add](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/scripts/common/safe_commit.py)、[GSD scoped commit](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/src/commands.cts#L2350)、[Spec Kit 可选自动提交](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/extensions/git/scripts/bash/auto-commit.sh#L172)。

## 对 Knit 的含义

这些参考支持“复用客户端、任务资料恢复、少量确定性保护、能力不足明确报告”的方向。原生会话身份、明确模型和限定提交仍可保留，增加的是几个小守卫，而不是 Agent 运行平台。异常工具无法确认时阻塞，属于明确的失败边界；不自动加出一套接管平台。

本报告不改变首版范围或用户已定策略。源码片段保存在 [sources/](sources/)，完整源文件指纹、固定提交和原始链接见 [SOURCES.json](SOURCES.json)，核对结果见 [CHECK.json](CHECK.json)。本机 CLI 的实际能力以[既有验证材料](../pi-cli-1.4.0/README.md)为准。
