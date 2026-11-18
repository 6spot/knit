---
id: k-c3f36d6f7019
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-18T00:56:25.915Z
title: F6 交付预览里标出审查通过之后又改过的文件
---


# F6 交付预览里标出审查通过之后又改过的文件

## 目标与范围

背景：`independent` 的任务要审查通过才能完成。审查通过之后再改文件，新 Knit 照样让它完成、交付，没有任何提示：`knit deliver --preview` 里只标「审查改过」（给出过结论的执行改过的文件），看不出哪些改动是审查没有看过的。旧 Knit 这时不让交付（`check_stale`），那一套随旧代码删掉了。

用户 2026-11-18 决定（记在 `.knit/tasks/11-14-slim-refactor/plan.md` 的 H 段「H2a 第一次审查」一条）：不拦，在交付预览里标出审查通过之后又改过的文件。本任务做这件事。

做完之后的不同：

- 一次执行以结论 `pass` 结束时，把结束时的工作区记录存进执行目录：`.knit/.runtime/runs/<执行 id>/after.json`，格式和派发时存的 `before.json` 一样（`WorkspaceSnapshot`：每个文件的类型、权限和内容摘要）。
- `knit deliver <任务> --preview` 的「提交的文件」里，现在的样子和那份记录不一样的文件后面标 `审查通过之后又改过`；同时也是「审查改过」的写成 `（审查改过，审查通过之后又改过）`。「提示」里多一条 `有 N 个文件在审查通过之后又改过（上面标出来的），这些改动审查没有看过`，排在最前面。
- 只提示，不拦：`knit deliver` 和 `knit task close` 的行为不变。

哪一次算“审查通过”：和 `knit task close` 判断能不能完成时一样，取算数的执行（`countedRuns`：已经结束、没有失败、按现在的需求做的）里最后一次给出过结论的；它的结论是 `pass` 才比。

不标的情况：

- 最后一次给出结论的执行不是 `pass`，或者任务没有审查过（`self`、`none` 的任务）。
- 那一次的 `after.json` 不在了。`.knit/.runtime/` 是本机的运行时资料，被 Git 忽略，可以清掉，换一台机器也没有。这时不标也不出错。
- 改了又改回审查结束时的样子的文件。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `src/application/workspace.ts` | `changesSince(root, before)` 换成 `changesBetween(before, after)`，两份记录都由调用方给；取一个文件指纹的那三行提成 `fingerprint(root, path)`，`takeSnapshot` 和交付预览都用 |
| `src/application/run-finish.ts` | 结束时的工作区只拍一次，既用来比出改动文件，也在这次执行没有失败、结论是 `pass`、记录已经存好时写成 `after.json` |
| `src/application/delivery.ts` | `DeliveryPreview` 的 `commit.files` 每项加 `changedAfterReview: boolean`，按上面的规则算 |
| `src/cli/deliver.ts` | 预览里按上面的写法输出标记和提示 |
| `test/deliver-preview.test.mjs` | 加两个测试，见场景 |
| `test/workspace.test.mjs` | 跟着 `changesBetween` 改调用，断言不变 |

不做的：

- 不拦交付，不改任务的状态。
- 不比不在「提交的文件」里的文件：别的改动本来就不进这次提交。
- 不把 `after.json` 搬出运行时目录，也不提交它。

不能动的：

- 上表以外的文件。工作区里另有一个任务（G16，三个问题）的改动，在 `src/domain/report.ts`、`src/adapters/pi/pane-worker.ts`、`src/adapters/pi/runtime.ts`、`src/application/run-execute.ts`、`src/cli/run.ts`、`src/cli/knit.ts`、`test/helpers/fake-pi.mjs`、`test/run-execute-edges.test.mjs`、`test/run-pane.test.mjs`、`test/cli.test.mjs`，不属于本任务，不看、不改。
- `.knit/`（除本任务的资料）、`.pi/extensions/knit.ts`、`assets/templates/pi/extensions/knit.ts`、`docs/`、`AGENTS.md`。桥接的 `knit_deliver` 预览直接转交命令的输出，不用改。
- 测试只在临时目录里做，不调用真的 Pi 和模型。不加依赖，不提交、不推送。
- 不运行 `npm run pack:install`。

前置条件：macOS 或 Linux，Node 24 以上；`npm test` 能通过。`npm test` 会先删掉再生成 `dist`，不要同时运行两次。

验证：

- `npm test`：通过，输出里 `fail 0`。本任务加 2 个测试；同一个工作区里 G16 加 4 个，合起来是 227 个（开始前 221 个）。
- `npm run typecheck`、`npx tsc -p tsconfig.templates.json`：退出码都是 0。
- `grep -rn "changesSince" src test`：没有输出。
- `pgrep -fl "fake-pi|fake-rex|run worker|run wait"`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出。

审查时请特别看：

- 结束时的工作区从拍两次变成拍一次之后，改动文件、“执行者提交了改动”“执行者改了受保护的文件”这三项判断有没有变。
- `after.json` 会不会被算成执行者的改动（它在 `.knit/.runtime/` 下，拍记录时跳过这个目录）。
- 任务文件在读入之后被别人改过、`finishRun` 重新读一遍再做时，写下的 `after.json` 对不对。
- 没有审查过的任务、不在 Git 仓库里的项目，预览和原来一样不一样。

做完之后：本任务要求独立审查；提交由用户另行授权，文案首行建议 `feat: mark files changed after the passing review in the delivery preview`。

## 完成条件

### Requirement: 预览里标出审查通过之后又改过的文件

#### Scenario: 审查通过之后又改

- GIVEN 临时仓库里一个 `independent` 的任务：实现的执行写了 `src/a.ts`、`src/b.ts`，审查的执行写了 `src/c.ts` 并以 `pass` 结束；之后 `src/a.ts`、`src/c.ts` 被改了内容，新加了 `src/d.ts` 并在 `knit task close` 时用 `--paths` 登记
- WHEN 运行 `knit deliver <任务> --preview`
- THEN 「提交的文件」里依次是 `src/a.ts（审查通过之后又改过）`、`src/b.ts`、`src/c.ts（审查改过，审查通过之后又改过）`、`src/d.ts（审查通过之后又改过）` 和任务目录那一行
- AND 「提示」的第一条是 `有 3 个文件在审查通过之后又改过（上面标出来的），这些改动审查没有看过`
- AND 把 `src/a.ts` 改回审查结束时的内容之后，它不再有标记，提示里的个数变成 2

#### Scenario: 没有可比的记录时不标

- GIVEN 同上的任务，审查那一次执行目录里的 `after.json` 被删掉
- WHEN 运行 `knit deliver <任务> --preview`
- THEN 退出码是 0，「提交的文件」里只有 `src/c.ts` 带着 `（审查改过）`，没有「审查通过之后又改过」，也没有那一条提示
- AND 另一个任务最后一次审查的结论是 `blocked`、用 `--reason` 直接完成、之后改过 `src/a.ts` 时，预览里也没有「审查通过之后又改过」

## 待澄清

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#82-交付` — 交付和预览现在的规则
- `.knit/tasks/11-14-slim-refactor/plan.md` — H 段「H2a 第一次审查」一条：这个决定的由来
- `src/application/workspace.ts` — `takeSnapshot`、`changesSince`、`WorkspaceSnapshot`
- `src/application/run-finish.ts` — `finishRun`
- `src/application/run-prepare.ts` — 派发时写 `before.json` 的地方
- `src/application/delivery.ts` — `previewDelivery`
- `src/cli/deliver.ts` — `fileLines`、`hintLines`
- `src/domain/progress.ts` — `countedRuns`
- `src/cli/task.ts` — `task close` 怎么判断审查通过
- `test/deliver-preview.test.mjs` — 现有的预览测试和 `run` 辅助函数

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-18T01:00:57.693Z
- 方式: self → independent；理由: 改的是执行、交付这两处的判断，自己验证不够

### 交付记录

<!-- knit:delivery:op-1cf45dd0e4c4 -->
- 操作: op-1cf45dd0e4c4
- 时间: 2026-11-18T04:00:05.871Z
- 分支: refs/heads/main
- 授权来源: user:c3abaf42
- 调用: bridge
- 工作提交: e32426a6a8e4833af20a4c88b468f0c3b61cb455
- 结果: 正常交付；检查 run-44e4227a1298 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-18-f6-preview-changed-after-review

### 任务资料提交记录

<!-- knit:metadata-commit:op-1cf45dd0e4c4 -->
- 任务资料提交: 7cc29b0cc09e52bf879ecc351576e05f60e81bf3
- 归档目标: .knit/tasks/archive/2026-11/11-18-f6-preview-changed-after-review

<!-- knit:progress:end -->
