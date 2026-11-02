# 任务053：锁混合重入失败的对称回滚

## 目标

修复 B003：同一 LockManager 实例已持有 A 时，申请包含重入 A 与其它键的锁集合，后续键获取失败不得删除外层 A、遗留本次重入引用或遗留本次新建锁的内存持有记录。失败后跨实例互斥与最终释放均须正常。

## 依赖与依据

- 依赖：029 的同实例同动作锁重入实现、043 的独立复验发现 N1；不依赖 macOS 实测或 B002 测试偶发问题。
- 用户授权：2026-11-02 本会话明确要求创建 053、写清修复方法并交由其他 Agent 实施。
- 入口：`src/infrastructure/locks.ts` 的 `acquire`、`rollbackAcquire`、`heldBySelf` 与 `release`；回归放在 `test/infrastructure.test.mjs`。
- 按需阅读：`OPERATIONS.md` 的锁与失败回滚规则、`ARCHITECTURE.md` 的基础设施约定、`tasks/029-allow-active-input-drafts.md`、`validation/audit-fix-verification/report.md` 的 N1。
- 现有探针：`validation/audit-fix-verification/lock-reentry.mjs`、`lock-reentry-consequence.mjs`。

## 已确认事实与证据边界

- 委派前重跑旧探针，输出 14 项检查、2 项失败；后果探针确认回滚后 rival 可获取外层 A，而原实例仍自认持有。
- 旧记录写成 12 项，应按实际产物更正。
- 本轮后果探针没有复现“后续 release 误删 rival owner”；这项只能作为需防止和测试的风险，不再写成已确认后果。
- 旧主探针多场景共用 root，存在未释放锁、漏 await、缺 token 的 release；其 owner 写失败场景可能在写入前就遇到前一场景残留。原始失败可支持外层锁被误删，不能替代隔离故障注入验收。

## 实现要求

1. 以本次 `acquire` 的实际成功步骤建立内部回滚记录，明确区分：
   - `reentered`：对既有同实例、同动作锁成功增加了一次引用；
   - `created`：本次成功新建的锁目录、owner 与内存持有记录；
   - `created` 的中间阶段：目录创建成功但 owner 写入失败，须能清理本次残留。
2. 整体获取失败时逆序撤销本次实际完成的步骤：
   - 重入键只撤销本次 `count += 1`，保留调用前的引用数、token、owner 与锁目录；
   - 本次新建键清理本次拥有的磁盘资源，并移除匹配的内存持有记录；
   - 尚未获取的键和其它实例持有的键保持原样；owner 核验遵守现有 token/身份边界；
   - 部分失败的键不得因漏记 ownerPaths 或引用计数而绕过回滚。
3. 不可只在旧 `rollbackAcquire` 添加 `held.count > 0` 跳过删除：新建锁的 count 同样为 1，必须区分此次新建和既有重入。
4. 具体内部结构由实施 Agent 判断，可使用私有撤销记录/辅助函数；保持现有公共 API、锁路径、owner 协议、重入授权范围及 acquire 错误语义。若发现必须改变公共契约的另一个缺陷，先记录证据，不自行扩大范围。
5. 修复后必须满足：失败 acquire 的引用、磁盘与内存持有状态等价于调用前；外层仍持有时 rival 必须 busy；释放真实外层次数后 rival 可获取；原实例随后可以正常重新获取、释放。

伪代码（仅表达语义，实施可调整）：

```text
undo = []
try:
  for key in orderedKeys:
    if sameInstanceSameActionHeld(key):
      incrementReference(key)
      undo.push(reentered(key, existingToken))
    else:
      createDirectory(key)
      undo.push(created(key, token, directoryCreated=true))
      writeOwner(key)
      registerHeldReference(key)
  return acquiredLock
catch error:
  for entry in reverse(undo):
    if entry.kind == reentered:
      undoExactlyOneMatchingReference(entry)
    else:
      removeOnlyResourcesCreatedByThisAttempt(entry)
      clearMatchingHeldReference(entry)
  rethrowUsingExistingErrorContract(error)
```

## 测试与验收

每个故障场景使用独立临时锁根，正确 await acquire，并通过实际返回的锁句柄释放。对外可观察行为断言为主，避免只检查实现里的计数或布尔标记。

至少覆盖：

- A 已持有，`[A, B]` 在 B 被 rival 占用时失败：A 的 owner/token 不变，rival 不能获取 A，B 的 owner 不变；释放一次真实外层 A 后 rival 能获取 A，证明没有泄漏重入引用。
- 键排序使 busy 键先于重入键失败：尚未触达的外层键保持原样。
- 重入 A 后，新建 B 的目录成功但 `writeOwner(B)` 确实抛错：记录注入命中，验证 A 保留、B 本次目录清理；保留既有错误映射，不写死一个未经核验的 EIO 预期。
- 本次先成功新建一个键，后续键失败：该新建键磁盘与内存记录都清理，同实例及 rival 后续可重新获取/释放。
- 多层外部重入后混合 acquire 失败：只撤销失败调用自身增加的引用，所有真实外层释放完成后锁恰好释放。
- 正常单键重入/逐层释放、同键不同动作 busy、跨实例互斥、正常混合申请成功与最终释放继续成立；若发现其它 token 契约问题，记录并处理本次修复必需范围。
- release 不删除已变更为其它 token 的 owner；不得把未复现的旧记录当作该项已经失败的证据。

把上述核心回归纳入 `test/infrastructure.test.mjs`。修正既有隔离探针的夹具、漏 await 与无效释放，使其可重复运行并真正命中写 owner 故障；不得靠删除断言、削弱预期或跳过真实路径达成全绿。历史审计报告保留原验收时点，在 053 记录修复后事实。

执行并记录：

1. 先补回归，在修复前确认必要用例失败并保存简要证据。
2. `npm run -s typecheck && npm run -s build`。
3. `node --test test/infrastructure.test.mjs`。
4. 两个重入探针；主探针全部通过，后果探针不得再出现“外层锁保护丢失”。
5. `node --test test/*.test.mjs` 全量；如出现 B002，保留首次失败并定位/单跑，不静默忽略，也不顺手调整全局并行度或超时。
6. `git diff --check`。

## 边界

- 本任务由另一个实施 Agent 执行；主 Agent 创建任务、委派和复核。
- 一次一个执行者；允许既有未提交文件存在，禁止覆盖或回退无关工作。
- 不执行 git commit/push、发布、真实外部项目操作或 knit init，不修改模型/鉴权运行时，不扩展 Worktree 或公共锁协议。
- 允许同步本任务、TASKS.md、BLOCKERS.md、029/043 的必要交接说明；不把历史 043 验收改写成已经包含 053 的结果。
- 成功后更新 B003 为已修复并附真实证据，移除 M2 对后续混合重入的临时限制；若仍有必需缺口则保持未完成并说明。

## 实施记录

- 执行者：独立实施 worker Agent `a3e8cb06-1cf6-45c4-b98c-6d1aaa9a7520`（2026-11-02，053唯一实施执行者；主 Agent 负责复核）。
- 实际修改：`src/infrastructure/locks.ts` 新增内部 `HeldLock`／`AcquireUndo`，以实际完成步骤区分 `reentered` 和 `created`，mkdir 成功立即登记，失败逆序撤销本次重入引用及匹配的内存、磁盘资源；保留公共 API、owner 格式、原错误透传与 token 保护。`test/infrastructure.test.mjs` 新增7项隔离行为回归；两个重入探针改为相对 dist 导入、独立夹具、完整 await 和真实句柄释放，明确核验 mkdir 后故障命中。既有工作区改动保留，未提交／推送／发布。
- 验证结果：核心回归修复前7项中3通过、4失败；修复后 typecheck/build、基础设施31/31、主探针47/47与后果探针8/8通过；全量236/236通过，无跳过，本轮未出现B002；`git diff --check`通过。完整证据见下。
- 交接：053实施与规定验证已完成，B003已修复。主 Agent 已通读锁实现差异、7项回归、两个探针及归档的失败/成功证据，确认失败回滚按实际步骤撤销，owner 写故障真实注入且隔离；全量236/236为实施 Agent 的实际运行记录，主 Agent 未重复全量。文档复核后再次执行 `git diff --check` 通过，根 TASKS.md 已确认053完成。B004属成功路径的另一个token缺口，修复前不新增同动作混合键重入业务路径；没有自动开新任务或扩大本轮公共契约。

### 回归与验证证据

- 先新增核心回归，保持锁实现未改，执行 `npm run -s build` 与 `node --test --test-name-pattern='锁053' test/infrastructure.test.mjs`：7项，3通过、4失败。失败分别为“重入后遇 busy”外层 owner 文件 ENOENT、“mkdir 后 owner 写失败”外层 owner 文件 ENOENT、“新建键后遇 busy”同实例重新 acquire 仅返回残留 token 而无 owner、“多次重入混合失败”外层 owner 消失。日志：[before-tests.log](../validation/audit-fix-verification/053/before-tests.log)。写失败用例在检查 A 之前已断言注入恰好命中一次、B 目录在 writeOwner 时存在、原 EIO 错误对象透传，不能由旧场景残留冒充故障。
- 修正后、实施前运行主探针：47项，37通过、10失败；后果探针走缺陷分支6项，4通过、2失败（外层保护丢失、原实例虚假重获）。其它 token owner 的 release 保护通过，未复现历史已撤回的“release误删rival”。日志：[before-probe.json](../validation/audit-fix-verification/053/before-probe.json)、[before-consequence.json](../validation/audit-fix-verification/053/before-consequence.json)。旧主探针在053委派前实际为14项、2失败，历史“12项”的计数不能作为本轮结果。
- 实施后 `npm run -s typecheck && npm run -s build` 通过；`node --test test/infrastructure.test.mjs`：31项全部通过（原24项＋新增7项），无跳过。
- `node validation/audit-fix-verification/lock-reentry.mjs`：47项全部通过；`node validation/audit-fix-verification/lock-reentry-consequence.mjs`：8项全部通过，无外层保护丢失。后果探针修复前后数量不同来自故障／正常分支：修复后可额外核验真实内层重入、逐层释放及最终目录消失。日志：[after-probe.json](../validation/audit-fix-verification/053/after-probe.json)、[after-consequence.json](../validation/audit-fix-verification/053/after-consequence.json)。
- `node --test test/*.test.mjs`：236项全部通过（原229项＋新增7项），0失败、0跳过、0取消；首次运行即通过，本轮未出现B002，因此未调整全局并行度／超时，也未额外单跑。日志：[full-tests.log](../validation/audit-fix-verification/053/full-tests.log)。`git diff --check`通过；实现后的相关章节、路径链接和旧措辞已核对。macOS仍按原计划另验，不将Linux本轮结果外推。

### 范围外发现与复现（B004）

成功混合申请中的单 token 句柄已有另一个缺口，本次失败回滚不修改该公共契约／成功获取策略。独立临时 root 实测（结束后清理夹具）：

```js
const manager = new LockManager({ root });
const heldKey = { scope: 'project', rawKey: '/tmp/z-held' };
const newKey = { scope: 'project', rawKey: '/tmp/a-new' };
const outer = await manager.acquire({ keys: [heldKey], action: 'same' });
const mixed = await manager.acquire({ keys: orderKeys([heldKey, newKey]), action: 'same' });
// mixed.token !== outer.token；两个 owner token 不同。
manager.release(mixed);
manager.release(outer);
// inspect(newKey).exists === false；inspect(heldKey).exists === true。
```

同 scope 的固定排序使新键先行；成功句柄的单 token 不能撤销后续既有不同 token 的重入引用。记录于 [BLOCKERS B004](../BLOCKERS.md)，交主 Agent 另行安排，未扩大053。`release` 不删除其它 token owner 已单独通过真实替换 owner 的回归；B004不等同误删 rival owner。
