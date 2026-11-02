# 043 独立复验：一致性审计修复（F027–F042）与当前就绪结论

- 复验执行者：043 独立检查 Agent（与 027–042 修复执行者不同上下文），2026-11-02。
- 基线：工作区基于提交 `b75a80fb0986b416aac7cb67dfa315f77192b274`（含 027–042 未提交修复产物；原审计基线 `50936d71` 证据按事实保留于 [design-implementation-audit](../design-implementation-audit/README.md)）。
- 本目录为新增验证证据，未提交；未修改 `src/`、`test/`；探针脚本在系统临时目录与 `dist/` 产物上运行。

## 环境

- Linux aarch64（kernel 6.12.0-201.74.2.2.el9uek.aarch64）、Node v24.21.0、npm 11.19.0、git 2.x。
- 验证均在仓库源码 `dist/` 编译产物与临时目录夹具上执行；Git 实验仅用临时目录。

## 完整验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（tsc --noEmit 无输出） |
| `npm run build` | 通过（rm -rf dist && tsc -p tsconfig.build.json && node scripts/build-bridge-schema.mjs） |
| `node --test test/*.test.mjs` | **229/229 全过**，连续 3 轮全过（第三轮为复验执行者重跑确认），duration ≈ 89s/轮 |
| `npm run pack:check` | 通过（pack 检查通过，含 assets/ 与全部 dist 文件清单） |
| B002 口径 | 复验 3 轮全量未复现单例偶发失败；如偶发按 BLOCKERS.md B002 处理（单跑通过即计入），本轮无需启用 |

## 逐发现验收映射（F027–F042）

方法说明：审计探针（`validation/design-implementation-audit/*.mjs`）已更新为双向断言，探针框架 pass 不作为修复成功依据；以下每项都以原审计最小复现条件独立验证（源码核实 + 动态断言/单用例复跑）。

| 发现 | 结论 | 证据（命令/断言） |
| --- | --- | --- |
| F027 按当前成果指纹核实检查与交付资格 | **通过** | 独立探针 `f027-fingerprint.mjs`（11/11）：外部编辑字节、chmod 0644→0755、file→symlink、symlink 目标变化、路径删除均检出漂移；旧记录（无 factsKind）仅核内容不追溯失效。端到端 `node --test --test-name-pattern="scope 现状重核" test/delivery.test.mjs` 通过（改字节/换类型/改执行位/删除后旧 pass 拒绝 check_stale，恢复 mode 后可用）。`validCheck`（delivery-service.ts:960）与接收（run-acceptance.ts:346）都重核 scope 现状；审计探针 `scope-current-content-validation` 返回 `acceptedAfterExternalEdit=false, reason=check_stale`。 |
| F028 在运行边界核对实际 Git 分支 | **通过** | `node --test --test-name-pattern="运行边界核对实际分支" test/stage.test.mjs` 通过：prepare 前换分支拒绝且不改绑、detached HEAD 拒绝、prepare 后启动前 worker 拒绝（branch_mismatch）、结果待接收时换分支接收拒绝（branch_changed）、adopt 显式接管后新运行在新分支正常且绑定不被悄悄改回。补充探针 `f028-stage-boundary.mjs`（4/4）：`liveBranchMatches` 同分支/换分支/detached/advisory-null 语义正确。三方核对（task frontmatter、binding、request.expected.branch）与 worker 入口（knit-worker.ts:201–205）、StageRunner 启动前后核对（stage-runner.ts:231–235、385–387）源码一致。 |
| F029 真实活动运行期间保存与撤回输入草案 | **通过** | `node --test --test-name-pattern="真实 worker 持项目占用" test/stage.test.mjs` 通过：真实 worker 持项目锁期间草案保存/按摘要撤回成功、旧 run 沿冻结输入、接收不丢草案；`node --test --test-name-pattern="任务030\|未归档" test/task.test.mjs` 草案竞争与摘要语义通过。审计探针 `active-run-input-draft` 返回 `saved=true`。 |
| F030 持久化应用草案后的业务状态转移 | **通过** | `node --test --test-name-pattern="应用草案持久化转移" test/task.test.mjs` 通过：change 应用后磁盘 phase=open/discuss、deliver 上 clarify 应用后磁盘 open/check，响应与磁盘一致，pendingDraft 清空。审计探针 `pending-phase-persistence` responsePhase=diskPhase=discuss、pendingCleared=true。 |
| F031 全部生效指令版本纳入检查身份 | **通过** | 审计探针 `role-instructions-digest`：角色指令变化后 role digest 与 effectiveInputsDigest 变化、standardsDigest 不变。`node --test --test-name-pattern="生效指令变化纳入检查身份" test/standards.test.mjs` 通过；`validCheck` 校验 inputs/standards/effectiveInputs 三个摘要（delivery-service.ts:948–951）。 |
| F032 写入与限定提交凭据扫描 | **通过** | `node --test --test-name-pattern="凭据扫描" test/delivery.test.mjs test/task.test.mjs` 通过：任务写入、输入更新、规范写入（standards-service.ts:343）、限定提交前（delivery-service.ts:281–302）命中即暂停，无交付提交，错误信息不回显完整值；移除命中后 retry 可继续。审计探针 `synthetic-credential-boundaries` 返回 `taskRejected=credential_scan_hit, deliveryRejected=credential_scan_hit, workCommitCreated=false`。 |
| F033 阻止规范采纳沿符号链接越出项目 | **通过** | `node --test --test-name-pattern="采纳目标边界" test/standards.test.mjs` 通过：父链接、目标链接、`..`、绝对路径全部拒绝且项目外文件无变化；项目内采纳与幂等不受影响。审计探针 `standards-parent-symlink` 返回 `applied=false, outsideChanged=false, reason=symlink escapes project root`。safeJoin（paths.ts:25–43）以 realpath 核实既有路径。 |
| F034 取消固定阶段总时限 | **通过（源码核实）** | `StageRunner.promptTimeoutMs` 默认 `null`（stage-runner.ts:155），worker 路径未传该参数；`runtime.prompt`/`waitSettled` timeoutMs=null 时无截止，终态只由 agent_settled/进程退出/abort/连接失败决定（runtime.ts:223–261）。`node --test --test-name-pattern="无固定阶段总时限" test/stage.test.mjs` 通过（长阶段跨原 15 分钟截止仍完成，显式取消仍收敛）。 |
| F035 prefer 恢复身份核对与新会话切换 | **通过（源码核实+单用例）** | `node --test --test-name-pattern="prefer 恢复身份核对与回退" test/stage.test.mjs` 通过：注入 `session_identity_mismatch` 后回退新建（runtime.ts 三个恢复类失败码：session_identity_mismatch/connection_closed/no_session_state），旧会话标记 incompatible 保留引用，新会话独立 knitSessionId、`source.kind=resume_fallback` 可追溯；模型配置错误不重试。会话锁释放旧锁再取新锁，取不到按 session_lock_unavailable 终止。scope/冻结摘要不重置。 |
| F036 允许更新未完整归档的 completed 任务 | **通过** | `node --test --test-name-pattern="未归档 completed 可按规定重新打开" test/task.test.mjs` 通过：未归档 completed 的 clarify/change 重新打开（清 outcome、deliver 上 clarify 回 check）；物理归档后拒绝；cancelled/superseded 拒绝。审计探针 `completed-input-update-domain` 双向断言：unarchived→open/discuss，archived→`allowed=false(outcome_completed)`。 |
| F037 正式规范作为明确授权成果的路径 | **通过** | `node --test --test-name-pattern="授权规范成果" test/stage.test.mjs` 通过：未授权改规范被 protected_path_modified 拒绝；显式授权后可改并进 scope，冻结旧版本内容入请求。全链路独立探针 `f037-delivery.mjs`：prepare（authorizedStandardPaths）→ 改规范 → check digest（授权冻结口径）→ 接收收敛 → `DELIVER completed`。授权传递链 worker/acceptance/validCheck 均按 `expected.authorizedStandardOutputs` 重建 plan（worker:214–221、acceptance:182–183、stage-runner:391–394）；validCheck 两侧同读磁盘当前内容，语义一致。 |
| F038 按候选版本与实际效果恢复规范采纳 | **通过** | `node --test --test-name-pattern="采纳按实际效果恢复" test/standards.test.mjs` 通过：正文成功索引失败可补齐、候选同 ID 新版本不假成功（正文须含完整规则块）；`delivery.standardsGate`（delivery-service.ts:969–981）改用 `candidateRuleText` 全文比对，替代旧"只有来源行"判定。审计探针 `adoption-index-recovery`（indexRepaired=true）、`adoption-candidate-version`（alreadyApplied=false, containsV2=true）。 |
| F039 init 升级中断保留旧受管基线 | **通过（源码核实+单用例）** | `node --test --test-name-pattern="任务039" test/init.test.mjs` 通过：preparing 中断重试保留旧桥接基线不判未知来源；外部清空的清单项重试准确报告真实冲突不冒充升级成功。 |
| F040 收紧既有运行目录及 SQLite 文件权限 | **通过** | `node --test --test-name-pattern="任务040" test/infrastructure.test.mjs` 通过：umask 022 下新建与既有 0755 目录/0644 数据库（含 WAL/SHM）收紧到 0700/0600，重开不受影响；init 首次初始化权限断言通过。审计探针 `preexisting-runtime-permissions` 返回 700/600/600。`readOnly` 打开不动权限；失败抛准确 io_error 保留资料。 |
| F041 项目状态概览列出按月归档任务 | **通过** | `node --test --test-name-pattern="按月归档任务进入项目概览" test/m1-cli.test.mjs` 通过：归档任务出现在 status 概览（archived=true、archive 路径）、与 task list/按 ID status 一致，损坏目录不阻塞。`listTaskDirectories`（task-service.ts:262–284）统一发现活动与归档任务。审计探针 `archived-task-status` 三项一致 true。 |
| F042 Pi 命令展示结构化查询结果 | **通过** | `node --test test/bridge-query.test.mjs` 通过：用公开 Extension API 替身加载安装后的真实桥接模板，断言 task new/task list/status/别名/按任务查询通知内容可见、失败响应有准确提示、空列表显示"（无）"。生成模板与 `assets/templates/pi/extensions/knit.ts` 逐字节一致（含占位）。 |

## 生成模板与源码装配一致性

- `init` 生成 `.pi/extensions/knit.ts` 与 `assets/templates/pi/extensions/knit.ts` 逐字节一致（占位 `__BRIDGE_BASELINE__` 原样保留，安装时注入指纹）。
- `TEMPLATE_SPECS` 其余 6 项模板生成内容逐字节一致；`.knit/config.json` 由 `defaultConfig()` 渲染，内容与 `assets/templates/.knit/config.json` 参照语义一致（JSON 相同）。
- `pack:check` 通过，`assets/` 与 dist 装配完整。
- 审计探针在修复后工作区全部通过（双向断言取预期方向）。

## 复验中发现的新问题

### N1（缺陷，记入 BLOCKERS）029 锁重入回滚不查引用计数，混合键 acquire 失败时误删外层仍持有的锁目录

- 位置：`src/infrastructure/locks.ts` `rollbackAcquire`（约 247–268 行）与 `acquire` 的重入分支（约 182–189 行）。
- 条件：同一 LockManager 实例已持键 K（外层），随后一次 `acquire({ keys: [K, …其他键], action: 与外层相同 })` 中 K 走重入计数 +1，而"其他键"失败（busy 或 owner 写失败）触发 `rollbackAcquire`。回滚按 token 匹配 owner 文件并删除目录，但不知道 K 的外层引用仍在。
- 实测（隔离探针 `lock-reentry.mjs` 12 断言中 2 失败；后果探针 `lock-reentry-consequence.mjs`）：
  - 混合请求失败后 `inspect(K).owner === null`（外层锁保护丢失）；
  - 此后 rival 实例可立即抢占 K 目录；本实例重入仍自认持有（heldBySelf 计数未回退）；
  - 后续 `release` 链条还会把 rival 写入的 owner 目录误删（token 均为本实例旧 token 的引用计数残留路径）。
- 现实触发面：当前产品代码中重入 acquire 均为单键调用（run-acceptance.ts:219/444 的 `run.accept.stage`、task-service 的 draft 锁），`orderKeys` 混合 [project, task] 的调用（deliver/adopt/ready/close/update/apply-pending/rename/standards.apply）彼此 action 不同，不构成同键重入。因此**当前主流程无可达触发路径**；但该缺陷破坏"跨实例仍互斥"的承诺，属 029 修复引入的实现缺口，任何后续在同实例内混合重入键的改动都可能触发。
- 处理建议（伪代码）：`rollbackAcquire` 在删目录前查 `heldBySelf`：`const held = this.heldBySelf.get(heldKey); if (held && held.token === lock.token && held.count > 0) continue;` 并对本次重入 +1 的键在回滚时 -1；同键多键回滚顺序与计数对称。
- 验收修复时：运行 `validation/audit-fix-verification/lock-reentry.mjs` 应 12/12 通过。

### N2（卫生，非缺陷）测试残留目录 `.bridge-build-tmp/`

- 043 复验期间工作区根曾出现 `.bridge-build-tmp/.bridge-stub.js`（042 桥接测试 tsc 编译的一次性残留）。删除后重跑单用例与全量套件均未复现，不影响产品行为；建议后续给 `.gitignore` 增补该名或在测试收尾清理。

### 观察（不阻塞）040 收紧范围略宽于依据文字

- `ensurePrivateRuntimeRoot` 在收紧 `.knit/.runtime` 的同时也把 `.knit` 本身收紧到 0700。OPERATIONS §3 只规定"运行目录"私有；`.knit` 受管元数据整体私有属更严格方向，不破坏任何现有验收（任务资料协作经 Git 而非本地跨用户读），记录为设计口径备注，不需要改动。

## 就绪结论（043 建议）

- 16 项发现 F027–F042 的修复全部真实生效，未发现"假完成"或探针框架假 pass；完整验证（typecheck/build/全量 229×3 轮/pack:check）通过。
- 029 的锁重入实现存在一处当前主流程不可达的实现缺口（N1），不推翻 027–042 的修复结论，但应作为后续修复项登记（建议编号 053 或并入现有队列）；在此之前，任何新增"同实例混合键重入"代码路径都会踩中该缺口。
- 就绪结论建议：**M2/M3B 的"027–042 修复已收敛、由 043 独立复验通过"成立**；Linux 首版候选就绪结论恢复（macOS 仍按 B001 延期，真实发布/提交仍需用户授权）。当前唯一新增欠账为 N1 登记与后续修复。
