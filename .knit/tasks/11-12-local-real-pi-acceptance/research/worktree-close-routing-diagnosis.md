# 本轮 Worktree close 路由诊断

来源：DeepSeek 宿主只读子 Agent `638e4c42-e623-487f-ad40-d6cc2d4048a8`，完成于 2026-11-13T01:24:05.762Z。它是诊断材料，不是正式 independent 检查凭据；未修源码、未改 scope/completion/checkpoint。

## 结论

两个任务本身没有 stale 的实施事实。`implementation_stale` 是 **close 调用把 worktree 当成了 evidenceRoot** 导致证据读错目录；同时又暴露出 **`task close` 的公共入口（CLI／桥接）无法表达 worktree 路由所需的 executionDir／evidenceRoot 拆分**，属于产品缺口，不只是操作者选错目录。

只读复现（未写任何文件）：

- `--dir` = worktree（实际发生的组合）→ `implementation_stale`
- `evidenceRoot` = 主检出、`executionDir` = worktree（设计组合）→ `allowed`（self／run）
- `--dir` = 主检出 → 先因 `task.md` 不在主检出 `.knit/tasks` 而 `任务不存在`

---

## 一、事实证据

### 1. 两次 run 均正常接收，实施事实在 shared main runtime

| 项 | wt-one | wt-two |
|---|---|---|
| task / run | `k-c54ad46f83b7` / `run-a231d1f9762a` | `k-5973fe1927c2` / `run-513382f12249` |
| request `expected.branch` | `refs/heads/knit/11-13-wt-one` | `refs/heads/knit/11-13-wt-two` |
| binding `branch` / `worktree.branch` | 同上 | 同上 |
| task.md frontmatter `branch` | `refs/heads/main` | `refs/heads/main` |
| task.md `stage` / `status` / `outcome` | `deliver` / `open` / `null` | 同左 |
| run 接收事件 | `accepted:true, implementation_accepted` | 同左 |
| `binding.confirmedInputsDigest` | `5eeaf69f…` | `575ad5b6…` |
| 当前 task.md `inputsDigest` | `5eeaf69f…`（相等） | `575ad5b6…`（相等） |
| `binding.lastImplement.scopeDigest` | `ee8b190a…` | `9acd734e…` |
| main runtime `scope.json` digest | `ee8b190a…`（相等） | `9acd734e…`（相等） |
| scope 条目 | `one.txt`, `2c8b08da…`, mode `100644` | `two.txt`, `27dd8ed4…`, mode `100644` |
| 当前文件 sha256 | `2c8b08da…`（一致） | `27dd8ed4…`（一致） |
| `implementations/<task>.json` | 主/工作树均无 | 主/工作树均无 |

具体位置：

- 接收事件：`.knit/.runtime/runs/run-a231d1f9762a/events.jsonl:14`、`run-513382f12249/events.jsonl:14`
- 请求冻结：`…/run-a231d1f9762a/request.json:42-48`（branch、executionDir、inputsDigest；`scopeDigest:null` 是准备时尚无 scope，正常）
- scope（仅主 runtime）：`.knit/.runtime/tasks/k-c54ad46f83b7/scope.json:9-16`、`k-5973fe1927c2/scope.json:9-16`
- task 文档：`.knit/worktrees/11-13-wt-one/.knit/tasks/11-13-wt-one/task.md:2-7`、`…wt-two/…/task.md:2-7`
- `a6-stale-evidence.json`：`runId` 3-4、`branch` 6、`executionDir` 7、`implementation: null` 15（第二个任务 43-55）

### 2. `implementation: null` 是正常的，不是丢凭据

run 接收只把实施事实写入 `binding.lastImplement`（`src/application/run-acceptance.ts:437-441`）；`implementations/<task>.json` 只由 `task implement` 写（`src/application/task-service.ts:2509`）。本轮实施证据是用 `task record` 追加的（`a6-stale-evidence.json:24`），没有 `task implement`，所以主 runtime 没有 implementation 文件并不表示实施凭据过期。`audit-worktree-stale.mjs:6,9` 用主 runtime 的 `RunStore.readImplementation` 读到 `null`，这只是该快照字段，不能单独解释 close 报错。

### 3. 两个 worktree 内都没有 `.knit/.runtime`，符合设计

`ls -la .knit/worktrees/11-13-wt-one/.knit` 只有 `agents/config.json/standards/tasks/workflow.yaml/.gitignore`，无 `.runtime`；这与 `src/application/worktree-routing.ts:4-6` 的“mainRoot 是元数据库、run 产物、锁与 pi-sessions 的唯一位置；worktree 内不产生 `.knit/.runtime`”一致。因此 worktree 作为 evidenceRoot 时，scope 必然是空 scope，implementation 必然缺失。

---

## 二、代码路径与判定

### 实际调用链

1. `knit task close` 只传 `dir`，没有 executionDir／evidenceRoot 参数：
   `src/cli/task.ts:754-789`（`service.close({ dir: options.dir, … })`）。
   `openStore` 虽明确把元数据库定位到主检出（`src/cli/task.ts:139-141`），但 close 的业务参数没有同样拆分。
2. `TaskService.close` 缺省把两者都设成 `dir`：
   `src/application/task-service.ts:2545-2546`，并在 `executionRoot` 定位 task.md（`:2549`）。
3. `CompletionService.assess`：
   - `root` 用来读 scope 与 implementation：`src/application/completion-service.ts:63-66, 98-101`
   - `executionDir` 用来核对 scope 路径是否漂移：`:116`
   - implementation 记录的路径核对用 `root`：`:123`
4. 完成裁决：
   `src/domain/completion.ts:157-161` 要求 `stage=deliver`、`run.inputsDigest=当前输入`、`run.scopeDigest=当前 scope`；
   不成立后走 implementation 记录；记录为 `null` 且 run 非空时落到 `implementation_stale`（`:186-188`）。

### 只读复现结果（用 `dist` 的 `locateTaskDocument`、`RunStore`、`loadScope`、`completionDecision`，不写文件）

对两个任务结果一致：

- worktree 作为 evidenceRoot／executionDir：
  `currentInputsDigest` 正确，空 scope digest 为 `4f53cda1…`，不等于 `lastImplement.scopeDigest` → runFresh 失败 → `implementation_stale`
- 主检出作为 evidenceRoot、worktree 作为 executionDir：
  `allowed`，`implementedBy: run`（即正常 self 完成）
- 主检出同时作为两者：
  `scope_changed`（scope 条目在工作树，主检出文件缺失）
- 从主检出定位任务：
  `任务不存在: k-c54ad46f83b7` / `k-5973fe1927c2`（主检出 `.knit/tasks` 为空）

这与预检文件 `a6-worktree-closed-preflight.txt` 的两个 `task-close-…` 错误完全吻合：报错不是 `任务不存在`，说明 close 的 `--dir` 实际解析到了 worktree（只有那里能定位 task.md），于是 evidenceRoot 也落在 worktree；scope 读成空、implementation 读成 null，最终命中 `implementation_stale`。

### 路由／调度侧本来就支持正确组合

`RunScheduler` 自动收尾会传：

- `executionDir: fact.executionDir`（worktree）
- `evidenceRoot: root`（主检出）
- `src/application/run-scheduler.ts:905-913`

`TaskCloseInput` 的注释也明确“worktree 内关闭能核对主检出中的实施事实”（`src/application/task-service.ts:435-441`）。也就是说服务层能力存在，但 **CLI 与桥接没有暴露或传递这组参数**：

- 桥接根路径取自扩展所在目录：`assets/templates/pi/extensions/knit.ts:84, 254`；close 分支只拼 `--dir root`：`:1549-1557`。在 worktree 会话里 `root` 就是 worktree。
- CLI 没有 `--execution-dir`／`--evidence-root` 选项（全仓检索无这两个参数）。

---

## 三、判定：调用位置触发，产品缺口成立

- **直接原因**：本轮 close 在 worktree 目录下执行，`TaskService.close` 缺省把 `evidenceRoot` 设成同一个 worktree；主 runtime 的 scope（`ee8b/9acd`）和 binding 的 `lastImplement` 根本没参与 runFresh 比较，导致空 scope 摘要与 `lastImplement.scopeDigest` 不一致。
- **不是数据问题**：输入摘要一致；scope 文件、文件指纹与 mode 一致；run 已 `accepted:true`；task 仍 `open/deliver`；没有完成凭据。
- **产品问题成立**：在现有公共入口下，worktree 任务没有正确 close 的位置：
  - 在主检出运行 → 无法定位 task.md（`任务不存在`）；
  - 在 worktree 运行 → 读不到主 runtime 的 scope／implementation（本次错误）；
  - 桥接同样只能传 `--dir root`。
  调度器是唯一传对拆分的调用方，说明这是 CLI／桥接的路由缺口，而不是完成规则本身错误。
- **附带性质**：`implementation_stale` 这个错误名具有误导性。这里的 implementation 文件缺失是预期的，真正失败点是“evidenceRoot 下 scope 为空导致 runFresh 失败”；如果产品要改，建议单独区分 `evidence_root_mismatch`／`scope_evidence_missing`，不要把两种情况都压到 `implementation_stale`。

### 明确排除的项

- 不是 `inputs_changed`：两个 task.md 当前输入摘要分别等于 `5eeaf69f…` / `575ad5b6…`，也与 binding 确认摘要一致。
- 不是 `scope_changed`：scope 条目与 worktree 文件 sha256、mode 完全一致；主 runtime 的 scope digest 等于 `lastImplement.scopeDigest`。
- 不是 `task_not_open` / `pending_draft`：task 为 `open/deliver`，binding `pendingDraft:null`。
- **branch 字段看似不一致但不是原因**：task.md 的 `branch` 保持 `refs/heads/main`，binding／worktree 是 `knit/*`。接收代码明确说明 worktree 路由下 frontmatter 保留源分支、不作否决依据（`src/application/run-acceptance.ts:255-257`，`applyJournal` 的同口径检查 `:621-623`）。它不影响 close 的 inputs／scope 判定。
- 不是 Git／提交问题：两次 run 的 mainHead、worktreeHead 都是 `5a13c437…`，run 报告无提交；close 本身不要求提交。

---

## 四、合法后续建议（不改凭据、不伪造来源）

1. **不要做的事**
   - 不要 `--force`、不要手工写 `completions/<task>.json`、不要改 binding／scope 摘要。
   - 不要在 worktree 里用 `task implement` “补一个记录”：`TaskService.implement` 以 `input.dir` 为根写 implementation（`src/application/task-service.ts:2509` 附近的 `RunStore(root)`），会在 worktree 生成 `.knit/.runtime`，把证据进一步分裂到两个 runtime，之后主检出的合入仍读不到。
   - 当前 `worktree merge` / `cleanup` 返回 `blocked_task_open` 是正确的，不要绕过。

2. **若本轮验收需要完成这两个任务**（属于写操作，需用户／主会话授权）
   使用调度器已采用的拆分根调用，不制造新证据：
   - `dir` = 主检出
   - `executionDir` = 对应 worktree
   - `evidenceRoot` = 主检出
   - `outcome:"completed"`、`runsSettled:true`
   这可经一个受控脚本调用 `TaskService.close`（等价 `src/application/run-scheduler.ts:905-913` 的组合）。它会用现有已接收 run + 主 runtime scope 正常写完成凭据，来源仍是 `lastImplement`，不需要修改任何凭据。执行前应确认主检出分支、任务仍 open、无其它活动 run。

3. **产品修复（建议另立任务，不在本诊断内实施）**
   - 让 `task close` 具备路由感知：根据 binding 的 `executionRouteOf` 定位 task.md（而不是调用者 `--dir`），并固定 `evidenceRoot = mainRootOf(dir)`；或显式提供 `--execution-dir` / `--evidence-root`（桥接同步）。
   - 同样检查 `task implement`／其它需要 RunStore 的 task 子命令是否有同样的 `--dir` 误用。
   - 增加回归场景：
     - worktree 内 `run accept` 后从 worktree close → 成功，completion 只写主 runtime，worktree 不产生 `.knit/.runtime`；
     - 从主检出 close worktree 任务 → 路由成功，或至少返回带路径的 `execution_dir_mismatch`，而不是 `任务不存在`；
     - 断言 `binding.lastImplement`、scope digest、completion `scopeDigest` 三者一致。
   - 错误码建议区分“证据根不对／scope 读不到”与真正的实施记录过期，避免后续验收误判。

4. **若暂不修复**
   保持两个任务 open／deliver 即可；现有证据完整、无伪凭据，后续用修复后的入口重试 close 不会丢事实。也可将该场景作为 worktree 路由的已知验收缺陷登记，而不是把责任归为实施 run 过期。

---

本会话仅做只读诊断：读取了证据 JSON、预检输出、fixture 的 binding／scope／run 文件与源码，并用只读函数复现了三种调用组合；未修改任何文件、配置、task、scope、check、completion，未执行 Git 写、force、模型重派或交付。该结论不是正式独立检查凭据。