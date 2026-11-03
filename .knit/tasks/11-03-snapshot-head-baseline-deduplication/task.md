---
id: k-7b87d04e9e32
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:11.757Z
title: 快照：HEAD 基线引用与内容去重
---

需求冻结（主会话核查 src/application/snapshot.ts、restore.ts、run.ts 契约后决策）：

现状：快照全量复制 worktree/index/untracked 到 snapshot/files/、snapshot/index/，manifest 记录 size/digest/mode/absent/indexOid/indexDigest，恢复逐条 sha256 校验；base.head 已记录。

设计决策：
1. 写入侧（snapshot.ts）：一次 `git ls-tree -r -z HEAD` 得 path→oid 映射（baseAbsent 时不引用）。对每个 tracked worktree 条目，用已读内容 buffer 同时算 sha256（manifest）与 git blob sha1（`sha1("blob "+len+"\0"+bytes)`），sha1 === HEAD 树中该路径 oid 且 kind 为 file/symlink 时引用基线：记 `source:"head"` 与 `headOid`，不写 files/ 副本，内容字节计入新字段 savedBytes 不计入 bytes。symlink 用链接目标字节参与比较。submodule（kind=submodule）不引用。untracked 无基线，全存。字节级精确同一；autocrlf 导致 blob 与工作区字节不同时自然回退为复制。
2. index 层：index blob oid === HEAD 树 oid 时引用基线（记 `indexSource:"head"`+`indexHeadOid`，不写 index/ 副本，计 savedBytes）；否则按现状复制。
3. manifest：schemaVersion 2（union 兼容读 1）；新增条目可选字段 source/indexSource（opt(lit("head"))）、headOid/indexHeadOid（opt(str)），manifest 新增 savedBytes opt(int)。旧 v1 无这些字段=stored 语义，恢复行为不变。
4. 恢复侧（restore.ts）：validatedWorktreeBytes/validatedIndexBytes 在 source==="head" 时改用 `git cat-file blob <oid>` 取字节，sha256 校验不变；cat-file 失败抛 GuardError("snapshot_baseline_unavailable"，含路径)，不静默跳过不部分恢复。恢复引用的是记录时 oid，不依赖恢复时 HEAD（"HEAD 改变"验证即：amend 后 oid 仍在则恢复成功）。
5. 不做隐式 stash，不改写用户工作区/index；本任务不开启自动 GC。保留约束写入 snapshot.ts 头注释与 OPERATIONS.md 第3节：快照仅引用 blob oid，对象被 GC 清除后恢复报 snapshot_baseline_unavailable，需恢复不得 prune 引用对象。
6. 验收测试（test/snapshot.test.mjs、test/restore.test.mjs）：a) HEAD 同内容→无 files/ 副本、source=head、savedBytes>0、恢复内容与 mode 一致；b) 同内容+改动混合→各自正确；c) 暂存==HEAD 引用、暂存≠HEAD 复制，--index 恢复校验通过；d) amend 后 oid 仍在→恢复成功；e) amend+reflog expire+gc --prune=now 清除对象→恢复报 snapshot_baseline_unavailable；f) v1 形状 manifest（去 source 字段）恢复行为与旧版一致；g) file→symlink 类型变化正确；h) maxBytes 下引用不计费（HEAD 同内容大文件在低上限下 ready）；i) 未跟踪文件仍全存。全量 npm test 绿。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施（run-991be693df91，已接收 implementation_accepted）：按冻结设计落地 HEAD 基线引用与内容去重——snapshot 写入侧 ls-tree -r 对比 + blob sha1 精确同一判定，引用条目不写 files/／index/ 副本、字节计 savedBytes 不计 bytes/maxBytes；manifest schemaVersion 2（兼容读 1），条目新增 source/headOid/indexSource/indexHeadOid；恢复侧 source=head 走 cat-file blob 取字节并保持 sha256 校验，对象缺失报 snapshot_baseline_unavailable（含路径），恢复依赖记录时 oid 不依赖恢复时 HEAD。保留约束写入 OPERATIONS.md 第3节。验证（self）：npm test 289/289 绿（新增 9 项：引用条目无副本、混合快照、暂存层引用/复制、amend 后恢复、GC 清除对象报错、v1 兼容、类型变化、maxBytes 不计费、untracked 全存）。

### 交付记录

<!-- knit:delivery:op-7e4e829bf91d -->
- 操作: op-7e4e829bf91d
- 时间: 2026-11-03T17:01:32.396Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: 5bcd1b8d22a18cf315a30a50b2fdd22b73c4da84
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-snapshot-head-baseline-deduplication

<!-- knit:progress:end -->
