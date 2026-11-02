# Knit M2 第五次独立验收检查

- 检查者：独立上下文／独立 Session（第五次验收 Agent）
- 工作区：`/home/opc/work/knit`
- 检查时间：2026-11-02（UTC）
- 结论：**M2 PASS**（针对 M2 交付／归档与故障恢复门槛）
- 上一轮唯一阻塞项（归档额外同 message 提交被保存／返回为 `archiveCommit`，用户清理后无法恢复）**已修复并经真实 Git hook 独立复现通过**。
- 未修改仓库源码／测试／文档；未提交／推送；未在当前工程初始化 `.knit`／`.pi`；未操作其它真实仓库；未调用真实付费模型。

本轮不采信主 Agent 与前几份 `/tmp/knit-m2-audit-*.md` 的结论。所有结论来自当前源码、当前 `dist` CLI 和本轮新写的 `/tmp/m2a5` 夹具。

---

## 1. 工作区与仓库事实

```text
HEAD=dde49bbaeb7fb0fe915d615ddb3f316645bafe82
branch=main（与 origin/main 同步，无新提交）
git status --porcelain | wc -l = 139（106 个 ??、32 个 M、1 个 D；与检查开始时一致）
find . -maxdepth 2 \( -name .knit -o -name .pi \) = 无输出
TASKS.md / BLOCKERS.md 未修改（mtime 仍为 2026-11-02 04:34 / 2026-11-01 17:15）
```

- 产品实现仍是未提交工作区内容；当前工程没有被测试或本轮检查初始化产品状态。
- 本轮只重建了 `dist/`（`.gitignore` 已忽略）；测试夹具、打包与数据库全部在 `/tmp/m2a5`。
- Node `v24.21.0`，npm `11.19.0`，git `2.52.0`。

证据：本节命令输出；`/tmp/m2a5/scenarios-final.log`。

---

## 2. 构建、测试与打包

| 命令 | 结果 |
|---|---|
| `npm run -s typecheck` | PASS（exit 0） |
| `npm run -s build` | PASS；生成 `dist/contracts/bridge-tools.json` |
| `npm run -s pack:check` | PASS（“pack 检查通过”） |
| `npm test` 第 1 次 | **194/194 pass，0 fail**，53.03s |
| `npm test` 第 2 次（flake 重复） | **193/194**，1 fail（见 8.3，无关 flake） |
| `npm test` 第 3 次 | **194/194 pass，0 fail**，52.58s |
| `node --test test/delivery.test.mjs` | **27/27 pass**，7.31s |
| 单独重复失败用例 5 次 | 5/5 pass |
| 新增回归用例本身 | PASS（`归档提交后出现同 message 额外提交：不落盘错误候选，清理后可恢复真实归档提交`） |

日志：

- `/tmp/m2a5/typecheck.log`、`/tmp/m2a5/build.log`、`/tmp/m2a5/pack-check.log`
- `/tmp/m2a5/test1.log`、`/tmp/m2a5/test2.log`、`/tmp/m2a5/test3.log`
- `/tmp/m2a5/delivery.log`、`/tmp/m2a5/flake-1..5.log`

打包卫生：

```text
npm pack --pack-destination /tmp/m2a5/pack
=> knit-0.1.0.tgz，162 个文件（assets 9 + dist 151）
包内不含 src/ test/ tasks/ validation/ scripts/ node_modules/ .git/ AGENTS.md TASKS.md
BLOCKERS.md 设计文档、*.tgz、本机 /home/opc、/tmp/knit-* 夹具内容
```

`npm run pack:check` 与 `tar -tzf` 独立核对一致；证据 `/tmp/m2a5/pack/`、`/tmp/m2a5/tar-list.txt`。

---

## 3. 上一轮唯一阻塞项的独立复现（核心）

### 3.1 复现方法（真实 Git hook，不做 DB 改写）

夹具：`/tmp/m2a5/scenarios.mjs` 的 `archiveExtraHook`；使用当前 `dist/cli/knit.js`。

1. 临时 Git 仓库 + 可交付任务（真实任务文件、binding、check 记录）。
2. 安装真实 `post-commit` hook：当提交 subject 以 `knit: archive ` 开头时，用相同 message 在归档提交之上创建空提交并 `git update-ref HEAD`：

   ```sh
   old=$(git rev-parse HEAD)
   tree=$(git rev-parse HEAD^{tree})
   new=$(git commit-tree "$tree" -p "$old" -m "$msg")
   git update-ref HEAD "$new" "$old"
   ```

3. 首次 `knit deliver`（无 `--retry`）。
4. 直接 `knit deliver --retry`（用户尚未清理）。
5. 用户清理：`git reset --hard <真实归档提交>`（额外提交变为不可达），再 `knit deliver --retry`。
6. 再次 `--retry` 验证 completed 后幂等。
7. 另用 `knit archive --retry` 重跑 4–6，覆盖另一个入口。

### 3.2 实际结果（`/tmp/m2a5/results.json`、`scenarios-final.log`）

首次 `deliver`：

```text
state=needs_attention          reason=archive_parent_mismatch
returned archiveCommit=null    persisted archiveCommit=null
archive step state=needs_attention
workCommit=bc7a1862466d884e53b81d57a269b288b2f69a1d
HEAD=额外空提交 d84521ff…（父=真实归档提交 06e4352e…）
step evidence 保留 before/expectedPaths/expectedTree（未覆盖为额外提交）
```

未清理 retry：

```text
state=needs_attention          reason=archive_parent_mismatch
returned archiveCommit=null    persisted archiveCommit=null
HEAD 不变（未新建提交）
```

清理后 retry：

```text
state=completed                reason=null
archiveCommit=06e4352e…（真实归档提交；返回与落盘一致）
HEAD=06e4352e…；archive step=completed
可达 "knit: archive" 提交数=1；"knit: deliver" 提交数=1
任务已移入 .knit/tasks/archive/2026-11/11-02-audit；.knit-sealed 已清理
completed 后第三次 retry：仍 completed、同一 archiveCommit、HEAD 不变
```

`archive --retry` 入口同样：首次失败 `archiveCommit=null`（返回与持久化），清理后 `completed` 且恢复到真实归档提交 `629330e8…`，可达归档提交 1 个。

### 3.3 结论

- 归档提交核验失败时**不再落盘、也不再返回**错误候选 `archiveCommit`：`src/application/delivery-service.ts:547` 只在 `attention === null && commit !== ""` 时 `save({ archiveCommit })`；失败分支 `:548` 直接返回 attention。
- 用户清理额外历史后，同一操作通过 `findOperationCommit` 找回真实归档提交并完成，**不需要人工清 DB**，也没有新建第二次归档提交。
- 上一轮阻塞项：**已修复**。

对应回归测试：`test/delivery.test.mjs:551-588`（断言 `:575` 返回 null、`:577` 持久化 null、`:579-583` 清理后恢复真实提交）。

---

## 4. 第 4 轮四项缺陷重跑

夹具：`/tmp/m2a5/scenarios.mjs`（10 个 CLI 场景全通过）。

| 缺陷 | 本轮独立结果 | 关键事实 |
|---|---|---|
| 1. work completed 后外部提交 | **PASS** | 先制造 `archive_target_exists`（外来目标文件保留），work 已完成；删除目标后外部提交 `external after work completed`；retry `needs_attention: work_commit_head_advanced`，`archiveCommit=null`（返回与落盘），HEAD 保持外部提交，归档提交 0 |
| 2. work pre-commit 拒绝后删除／rename retry | **PASS** | 首次 `git_commit_failed`、`workCommit=null`；删 hook 后 rename `old.txt→new.txt` 再 retry：completed，work commit 实际含 `M app.txt`、`A new.txt`、`D old.txt`、`A 任务文件`；HEAD 无 old.txt，new 内容正确，deliver 提交仅 1 个，工作区 clean |
| 3. archive pre-commit 拒绝 retry | **PASS** | 首次 `archive_commit_failed`、`archiveCommit=null`；retry completed，归档提交含 `D .knit/tasks/11-02-audit/task.md`、`A .knit/tasks/archive/2026-11/11-02-audit/task.md`；旧路径不在 HEAD；第二次 retry completed、HEAD 不变、归档提交 1 个 |
| 4. 额外同 message 归档提交 | **PASS（已修复）** | 见第 3 节：首次与未清理 retry 均 attention 且 archiveCommit=null；清理后 completed 并恢复真实归档提交；无重复归档提交 |

---

## 5. 正常与拒绝恢复回归（未破坏）

| 场景 | 结果 | 证据 |
|---|---|---|
| 正常交付 | completed；work/archive 各 1 个提交；任务移入归档；seal 清理；工作区 clean；completed 后 retry 幂等 | `normal` |
| work pre-commit 拒绝 retry | completed；不重复 work 提交；删除／rename 进入提交 | `workRejectRename` |
| archive pre-commit 拒绝 retry | completed；旧任务路径删除 + 新路径新增；重复 retry 幂等 | `archiveRejectRetry` |
| work 回执丢失（真实 SIGKILL） | 进程被 post-commit hook `kill -9`；操作停在 planned、workCommit=null；retry 找回真实 work 提交；completed；deliver/archive 各 1 个提交 | `receiptLost("work")` |
| archive 回执丢失（真实 SIGKILL） | 进程被 kill；work 完成、archiveCommit=null；retry 找回真实归档提交；completed；各 1 个提交 | `receiptLost("archive")` |
| move 检查点丢失 | 目标已存在、源已消失；clear move checkpoint 模拟崩溃；retry 核实目标后继续；archivePath 不变；归档提交 1 个 | `moveCheckpointLost` |
| 同 message amend（真实换 hash） | 操作回执丢失后 retry 接受 amend 后的同 message 提交；completed；HEAD 不变；归档提交 1 个 | `sameMessageAmend` |
| 目标冲突 | 外来文件保留、不覆盖、不移动；`archive_target_exists` | `workExtraCommit` 前置 |
| 外部额外提交在 work 后 | `work_commit_head_advanced`；不产生归档提交；HEAD 保持外部提交 | `workExtraCommit` |
| completed 后重复 retry | 仍 completed；同一提交；HEAD 不变；不新增提交 | `normal`、`archiveExtraHook` |

说明：SIGKILL 场景中进程被杀会遗留 `.cli-locks`；夹具在确认 CLI 已被杀后删除该临时锁根（等价用户核实后 `unlock`），未改业务状态。`moveCheckpointLost` 与 `sameMessageAmend` 通过清空步骤检查点模拟“效果已发生但回执未落盘”，与仓库测试的故障注入方式一致。

---

## 6. C1 语义矩阵（独立脚本）

脚本：`/tmp/m2a5/c1.mjs`，直接调用当前 `dist/application/run-activity.js` 的 `runSettled`，使用真实 `RunStore` 文件与 stub 的 acceptance operation。

| 场景 | 期望 settled | 实际 |
|---|---|---|
| `completed` 无 result | false | false |
| `completed` + result + acceptance 未 completed | false | false |
| `completed` + result + acceptance completed | true | true |
| `failed` 无 result | true | true |
| `cancelled` 无 result | true | true |
| `running` + result | false | false |

```text
C1 match: true
```

重复接收幂等：`test/stage.test.mjs` 中“结果与原生范围保存，重复接收幂等”与“接收检查点”在全套测试中通过；`src/application/run-acceptance.ts` 对已完成 operation 返回 `duplicate=true`（未在本轮改动）。
**C1：PASS。**

---

## 7. M2 门槛／安装／桥接／诊断

### 7.1 M2 状态与证据

- `TASKS.md`：016–019 `completed`，020 `pending`（020 仍由独立门槛任务持有；本轮不修改任务表）。
- `TASKS.md:76` 定义 M2 = 016–020，需独立检查。本轮覆盖 019 的交付／Git 故障与 017 的部分回执／SIGKILL 行为，并提供独立 CLI 证据。
- `BLOCKERS.md` 无实际阻塞条目。

### 7.2 安装与桥接

- 在 `/tmp/m2a5/doctorproj`（隔离临时仓库）执行 `knit init`：成功生成 `.knit/*`、`AGENTS.md`、`.pi/extensions/knit.ts`、`.knit/.runtime/{installation,init-manifest}.json`。
- `knit doctor`：`[ok]` config／init-manifest／installation／bridge／worker／bridge-schema／git／branch／pi 1.4.0／protocol；仅 metadata 未建库与锁 stale 两条 warn（临时新项目预期）。
- 桥接 schema 同源核对：
  ```text
  dist/contracts/bridge-tools.js BRIDGE_TOOL_SCHEMAS
  vs dist/contracts/bridge-tools.json
  => 7 个工具（task,context,run,deliver,standards,snapshot,status）；canonical equal: true
  ```
- `assets/templates/pi/extensions/knit.ts:41` 从安装映射定位并读取同一份 `dist/contracts/bridge-tools.json`，无第二份手写 schema。

### 7.3 W1–W5 与心跳

| 项 | 结果 | 证据 |
|---|---|---|
| W1 `cancelGraceMs` 配置／模板／worker／stage-runner 一致 | PASS | `src/application/config.ts:26,56`；`assets/templates/.knit/config.json:11`；`src/worker/knit-worker.ts:293`；`src/application/stage-runner.ts:62,125,141,234` |
| W2 `snapshotsMaxBytes` 接线 | PASS | `src/worker/knit-worker.ts:79`；测试“快照超限或 Git 覆盖未知时 failed”通过 |
| W3 SMB2 远程 FS magic | PASS（仅静态） | `src/infrastructure/locks.ts:19` 同时含 `0xff534d42`、`0xfe534d42`；未在真实 SMB/NFS 挂载验证 |
| W4 `|| true`／恒真断言 | PASS | `src/`、`test/`、`scripts/`、`assets/` 未发现 `|| true`；测试使用真实 hook 与 `git cat-file` 类核对 |
| W5 封存 record 在锁内重读 marker | PASS | `src/application/task-service.ts:531-538`；封存两项测试通过 |
| 心跳间隔 | PASS | `src/worker/knit-worker.ts:186` 使用 `config.limits.heartbeatIntervalMs` |
| 心跳可疑阈值 | PASS | `src/application/diagnostics.ts:173` 使用 `config.limits.heartbeatStaleMs`（默认 30000 仅来自 config 默认值，不再硬编码判断） |

---

## 8. 计数同步与残余观察（warning，不阻塞）

### 8.1 validation 计数

- `validation/m2-git-failures/report.json`：`deliverySuite 27/27`、`fullSuite 194/194` — **已同步**。
- `validation/m2-git-failures/tests/delivery-all.txt`：27 项，含新增“归档提交后出现同 message 额外提交：不落盘错误候选，清理后可恢复真实归档提交” — **已同步**。
- `validation/m2-git-failures/README.md:24`：27/27、194/194 — 已同步。
- **warning**：`tasks/019-git-and-seal-failures.md:76-77` 仍写 `npm test 185/185`、`delivery.test.mjs 19/19`，且“实际修改／验证”段未记录本轮新增回归与修复。任务表状态未受影响，但证据链与仓库计数不一致，建议后续同步。

### 8.2 旧构建遗留 `archiveCommit` 不会自动修复（当前代码不可产生）

第四轮报告“必须修复项 1”的第二条（对旧构建已落盘错误候选的重入清除／修正）**未实现**：

- `src/application/delivery-service.ts:512-541`：当 `op.archiveCommit !== null` 且核验失败时只返回 attention，未清空或修正该字段。
- 独立验证（`/tmp/m2a5/scenarios.mjs legacy`）：把操作伪造成“旧构建已保存额外提交为 archiveCommit”，清理额外历史后 retry 仍 `needs_attention: archive_scope_mismatch`，持久化值仍是额外提交。

边界判断：该状态**只能由修复前的构建产生**；当前代码只在完整核验通过后写 `archiveCommit`（`:547`），本轮真实 hook 复现中首次失败即未落盘。当前仓库与临时项目均无旧 `archiveCommit` 记录，因此不构成本轮 M2 阻塞；但若要求兼容旧构建留下的本地元数据库，仍需在 `:512-541` 分支清除无效回执后按 `findOperationCommit` 重找，并补一个旧状态回归测试。

### 8.3 测试套件偶发 flake（与交付无关）

第 2 次 `npm test` 出现 1 次失败：

```text
✖ implement→check 独立会话；结果与原生范围保存，重复接收幂等
test/stage.test.mjs:179
Error [InfrastructureError]: lock already held: project/…
code: lock_busy
```

原因：`test/stage.test.mjs:100-108` 的 `waitTerminal` 只要读到 run 终态就返回；worker 在 `src/worker/knit-worker.ts:349` 写终态，`:368`（finally）才释放项目锁。测试随即在 `:179` 调 `task close`，可能撞上尚未退出的 worker 的锁。

- 单独重复该用例 5/5 pass；第 1、3 次全套 194/194。属低概率竞争 flake，与本次 `delivery-service.ts` 改动无关，未造成数据损坏。
- 用户侧同类窗口：run 终态后立即 `task close` 可能得到可重试的 `lock_busy`。建议后续在测试里等待 worker 退出，或让 close 对 alive owner 做一次短重试；本轮不作为 M2 阻塞。

### 8.4 其它范围限制

- 未执行真实付费模型长链路；未在真实 NFS／SMB／FUSE 验证 W3。
- 未验证外部并发进程改写历史／fetch／push／merge 冲突。
- 新增仓库回归（`test/delivery.test.mjs:551-588`）以“构造额外提交 + 手工复原操作状态”的方式模拟 hook 结果，未直接用真实 post-commit hook；本轮已用真实 hook 的 CLI 场景补足，故非功能缺口，报告 `report.json` 的 limitations 也已如实声明。
- `TASKS.md`／`BLOCKERS.md` 按本轮约定未改；020 仍 `pending`。

---

## 9. 结论

**M2 PASS。**

- 上一轮唯一阻塞项已修复：归档额外同 message 提交时，首次与未清理 retry 均为 `needs_attention` 且 `archiveCommit` 不落盘、不返回；用户清理额外历史后同一操作 completed 并恢复真实归档提交，无需改 DB、无重复归档提交。
- 第 4 轮四项缺陷全部独立复现通过；正常交付、pre-commit retry、work/archive 回执丢失（真实 SIGKILL）、move 恢复、同 message amend、completed 后幂等均通过。
- C1 矩阵、M2 状态、打包卫生、桥接 schema 同源、当前工程未初始化、W1–W5 与心跳诊断均通过。
- 剩余为 warning：`tasks/019` 计数未同步、旧构建遗留回执不自动修复（当前代码不可产生）、`stage.test.mjs` 低概率锁竞争 flake、真实外部并发／网络文件系统未验证。

复现材料（全部在 `/tmp`）：

- `/tmp/m2a5/scenarios.mjs`：10 个当前 dist CLI 场景（真实 Git hook、真实 SIGKILL、目标冲突、move/amend、两种 retry 入口、旧回执检查）。
- `/tmp/m2a5/scenarios-final.log`、`/tmp/m2a5/results.json`：最终 10/10 输出与事实。
- `/tmp/m2a5/cases/`：各场景临时仓库（保留供复核）。
- `/tmp/m2a5/c1.mjs`：C1 矩阵。
- `/tmp/m2a5/typecheck.log`、`build.log`、`test1-3.log`、`delivery.log`、`flake-*.log`、`pack-check.log`、`pack/`、`tar-list.txt`。
- `/tmp/m2a5/doctorproj/`、`init.log`、`doctor.log`：隔离安装与诊断。
