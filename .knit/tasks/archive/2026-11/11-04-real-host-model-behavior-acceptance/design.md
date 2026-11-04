# 设计：真实宿主与模型跨功能行为验收（k-da599e3b5cd4）

## 已执行（主会话，真实环境）

- 隔离项目 `/tmp/knit-accept`（12 轮单一会话）与 `/tmp/knit-check`（检查夹具），真实 Pi + magpie/group/deepseek。
- 场景与证据整理为 `validation/real-host-acceptance-2026-11/README.md`，附：
  - `sessions/accept-s1.jsonl`：原始会话（用户输入、模型文本、工具调用）；
  - `runs/`：CSV 实施 run 与检查夹具 run 的 request/result/state；
  - `fixtures/`：任务正文、规范正文与检查修复后的代码/测试副本。
- 结论：14 项场景中 12 项通过、2 项部分/未覆盖（明确不建任务的持续有效、规范候选路径）；另记录环境版本错配与一次 run 证据被移动的过程问题。

## 本 run 的职责（worker）

1. 逐条核对 README 的场景结论与 `sessions/`、`runs/`、`fixtures/` 证据是否一致：轮次、命令输出、run 状态、提交号；不一致处按证据修正 README，不美化结论。
2. 核对“无意愿不检索”的统计方法与实际工具调用一致；核对检查 run 的 `changedPaths`/`actualChangedPaths`、blocked 的 `actualChangedPaths: []`。
3. 保持未覆盖项与限制如实列出；不得把未跑场景改成通过，不得补写未发生的证据。
4. 运行 `npm test`（全量）与 `npm run pack:check`，把实际命令与结果写入 README「验证」小节或任务记录；失败如实报告。
5. 不重跑真实对话、不修改 `.knit/`、不提交 Git；只改 `validation/real-host-acceptance-2026-11/README.md`（必要时补索引说明）。

## 边界

- 本任务不改产品代码、模板或 schema；发现产品缺陷只记录并指出对应任务，不顺手修。
- 真实 Rex GUI、macOS 安装与发布验收不在范围。

## 验证

- README 的每条结论都能在固化的会话/运行/夹具中找到对应证据；修正项有 diff 可核对。
- `npm test` 与 `pack:check` 通过；未覆盖项、环境问题与过程异常仍在报告中。
- 交付后 `validation/real-host-acceptance-2026-11/` 完整入库；不宣称发布或完整安装验收完成。
