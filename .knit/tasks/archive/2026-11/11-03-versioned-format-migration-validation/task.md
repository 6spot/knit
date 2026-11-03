---
id: k-98f144efbcac
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:14.169Z
title: 格式演进：版本迁移说明与校验器
---

需求冻结（主会话核查 run-store.ts parseJson、config.ts 既有版本模式、initialization.ts 版本检查后决策）：

事实：任务 k-7b87d04e9e32 已产生真实格式演进——快照 manifest v1→v2（新增可选 source/indexSource/headOid/indexHeadOid/savedBytes，兼容读）。按任务边界"没有实际格式差异时不制造无用迁移器"：v1 数据可被 v2 读取器完整解释（缺字段=全量副本语义），因此不建迁移器，迁移说明=兼容读取规则成文。config（incompatible_version/version_conflict+found/expected）与 init-manifest（未知版本不降级）已有版本模式，本任务把快照 manifest 对齐。

交付范围：
1. run-store.readSnapshot/writeSnapshotManifest：读取 manifest.json 时先宽松解析 schemaVersion；数值且大于已知版本 2 → InfrastructureError("version_conflict", 含 found/期望，携带路径)；结构不符但 schemaVersion 可识别为已知或缺失 → 维持 io_error（属损坏，非演进）；非法 JSON 维持 io_error。
2. snapshot()：run 已有未知较新版本 manifest 时重跑快照必须报 version_conflict 且不得覆盖原文件（验证 manifest.json 字节不变）；不得吞错降级为重新快照。
3. restore：未知较新版本 manifest 报 version_conflict（只读报告，不给内容）；v1/v2 正常。恢复 v1 夹具（无 source 字段+files 副本）行为与任务 4 前一致。
4. 文档：OPERATIONS.md 快照节补充版本迁移说明段——v1→v2 变更内容、兼容读取规则（缺 source=stored）、未知较新版本阻塞写入与只读报告、无迁移器及理由（缺字段可完整解释，重写无收益）。
5. 测试：a) v3 manifest 夹具→snapshot 报 version_conflict 且原字节不变；b) v3→restore 报 version_conflict；c) 手写 v1 manifest 夹具→restore 成功且语义=全量副本；d) 结构损坏 manifest 维持 io_error；e) v1 快照重复 snapshot/restore 幂等。全量 npm test 绿。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施（run-ee838347903d，已接收 implementation_accepted）：run-store.readSnapshot 先宽松解析 schemaVersion，数值大于 SNAPSHOT_MANIFEST_VERSION(2) 报 version_conflict（found/expected/path），已知 1/2 才按 schema 校验，非法 JSON／结构损坏维持 io_error；writeSnapshotManifest 目标存在未知较新版本时拒绝覆盖（字节不变）；snapshot() 在删除／重写之前读既有 manifest，未知版本直接 version_conflict，不吞错降级重新快照；restore 同步受限。OPERATIONS.md 快照节新增版本迁移说明：v1→v2 变更与兼容读取规则（缺 source=全量副本语义）、未知较新版本只读报告阻塞写入、不建迁移器及理由。验证（self）：npm test 294/294 绿（新增 v3 拒写不覆盖、v3 restore 拒读、手写 v1 夹具兼容恢复、损坏 io_error、v1 幂等等 5 项）。

### 交付记录

<!-- knit:delivery:op-b29fed09cd69 -->
- 操作: op-b29fed09cd69
- 时间: 2026-11-03T17:12:29.449Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: ccd2684bffd8d5d5404b709e93c1280857bd68b3
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-versioned-format-migration-validation

### 任务资料提交记录

<!-- knit:metadata-commit:op-b29fed09cd69 -->
- 任务资料提交: 64af3e418b8f3c10ecdea429779676f09253d2da
- 归档目标: .knit/tasks/archive/2026-11/11-03-versioned-format-migration-validation

<!-- knit:progress:end -->
