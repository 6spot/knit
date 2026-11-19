---
id: k-16dd4270f599
title: 执行者的思考等级可以配置，不配置时用主会话的
status: delivered
stage: null
verification: self
parent: null
dependsOn:
  - k-6c41a06949e1
priority: P1
createdAt: 2026-11-19T12:37:55.398Z
---

## 目标与范围

现在 Knit 里没有思考等级的设置：启动执行者时不传 `--thinking`，主会话的 `PI_REASONING_LEVEL` 又会从执行者的环境里去掉，所以执行者用的是 Pi 自己的缺省。实际看到的：主会话是 `max`，执行者是 `medium`。用户决定（2026-11-19，`user:bb180476`）：思考等级和模型用同一套规则，可以配置，不配置时用主会话的。

前置条件：`k-6c41a06949e1`（不配置模型时用主会话的模型）已经做完，它的改动在工作区里还没有提交。本任务在它之上接着改同一批文件，照它的写法做。

做完之后：

- `.knit/workflow.yaml` 顶层和环节都可以写 `thinking`，环节的只管那个环节。可以写的值是 Pi 的 `--thinking` 接受的：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；写错在 `knit workflow validate` 时指出，和 `model` 写错时一样带行号。
- `knit run start` 加 `--thinking <等级>`，桥接的 `knit_run` start 加同名参数 `thinking`。
- 派发时取值的先后：`--thinking` → 环节的 → 顶层的 → 主会话当前的等级。主会话的等级从环境变量 `PI_REASONING_LEVEL` 读；桥接的 start 从 `ctx.thinkingLevel` 取，和模型一样放进 `knit run start` 子进程的环境变量。
- 四处都没有时不传 `--thinking`，由 Pi 用自己的缺省，不拒绝派发。
- 定下来的等级作为 `--thinking` 传给执行者，后台执行和 Rex 窗格里执行都要传到。`src/adapters/pi/runtime.ts` 的 `PiRuntimeOptions.thinkingLevel` 已经会拼出 `--thinking`，现在没有人给它值。
- `knit workflow show` 每个环节多一行思考等级，没有时显示 `（没有指定，用主会话的等级）`。

跟着改的：`assets/templates/workflow.yaml` 开头的注释和注释掉的示例、`README.md`、`docs/design/DESIGN.md` 第 6.1 节（现在写着“不沿用主会话的思考级别”，改掉）和第 9 节的命令与工具表。

模型不支持这个等级时不用处理：Pi 的文档写明 `--thinking` 会按模型的能力收到它支持的等级（Pi 1.5.2 `docs/cli.md`）。

注意：测试可能在 Pi 的 bash 里跑，环境里已经有 `PI_REASONING_LEVEL`。测“没有等级时不传”要去掉它，测“用主会话的等级”要自己设。

不在范围内：

- 不把用过的思考等级记进 `record.json`，不在 `knit run status` 里显示。
- 不改 `.knit/workflow.yaml`、`.knit/agents/`、`.pi/extensions/knit.ts` 这些副本，不改 `.knit/standards/`，不运行 `npm run pack:install`，不提交。

## 完成条件

- 流程里没写 `thinking`、环境里有 `PI_REASONING_LEVEL=high` 时，执行者启动的参数里有 `--thinking high`；`--thinking`、环节的、顶层的仍然优先于它。
- 流程里没写、环境里也没有这个变量时，派发成功，执行者启动的参数里没有 `--thinking`。
- 通过桥接调用 `knit_run` 的 start、`ctx.thinkingLevel` 是 `high`、流程里没写时，执行者启动的参数里有 `--thinking high`。
- `thinking` 写了不认识的值时，`knit workflow validate` 以退出码 1 指出是哪一行。
- 上面四条各有测试。`npm test` 全部通过，`npm run typecheck` 退出码 0，`npm run pack:check` 通过。

## 待澄清

无。

## 相关资料

- `src/application/run-prepare.ts` — 定下模型的地方，思考等级照着做
- `src/application/run-execute.ts`、`src/application/run-pane.ts` — 启动执行者，后台和窗格两条路
- `src/adapters/pi/runtime.ts` — `PiRuntimeOptions.thinkingLevel` 和拼参数的地方
- `src/contracts/workflow.ts`、`src/domain/workflow.ts` — 流程的字段和校验
- `assets/templates/pi/extensions/knit.ts` — 桥接的 `knit_run`
- `docs/design/DESIGN.md#6.1 流程` — 取值先后的现行说法

交付：提交文案首行建议 `feat: make the worker thinking level configurable`。做完之后剩下的由主会话做：用户同意后运行 `npm run pack:install` 并重新生成副本，和 `k-6c41a06949e1` 一起。

## 结果

执行者的思考等级可以配置了：`workflow.yaml` 顶层和环节都可以写 `thinking`，`knit run start` 和桥接的 `knit_run` start 可以临时指定。派发时取值的先后是 `--thinking` → 环节的 → 顶层的 → 主会话当前的等级（环境变量 `PI_REASONING_LEVEL`，桥接从 `ctx.thinkingLevel` 取）；都没有时不传 `--thinking`，由 Pi 用自己的缺省，不拒绝派发。写了不认识的值在 `knit workflow validate` 时带行号指出。`knit workflow show` 多了思考等级一行，模板注释、`README.md` 和 `DESIGN.md` 跟着改了。

五条完成条件都满足：四种情况各有测试（`test/run-start.test.mjs`、`test/bridge-run.test.mjs`、`test/workflow-thinking.test.mjs`，另有 `test/run-pane.test.mjs` 核对窗格和后台两条路），用假 Pi 核对执行者实际收到的参数。主会话读过全部改动，重跑 `npm test` 275 个全部通过、`npm run typecheck` 退出码 0、`npm run pack:check` 通过。

未验证：没有用真的 Pi 和模型走过；模型不支持所给等级时由 Pi 收到它支持的等级，这一点只依据 Pi 1.5.2 的文档，没有实测。

之后做了（2026-11-19，主会话）：`npm run pack:install` 并用 `knit init --force` 重新生成副本，和 `k-6c41a06949e1` 一起。用安装版在临时仓库里核对过：`--thinking huge` 被拒绝并列出可以写的值。
