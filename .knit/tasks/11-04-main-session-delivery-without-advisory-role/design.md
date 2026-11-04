# 设计：取消交付辅助角色并归入主会话（k-aeda178a77b5）

## 规则

交付协调由主会话完成，不启动 dedicated 交付 worker。`assist discuss` 保留（自愿的讨论建议）；`assist deliver` 撤除。业务完成、`knit deliver`、归档、授权边界保持不变，历史 advisory／deliver 运行记录只读保留。

## 代码改动点

1. `src/cli/run.ts`
   - `run assist <mode>` 只接受 `discuss`；`deliver` 返回 `invalid_request`（原因 `assist_deliver_removed`），不创建 run。
2. `src/contracts/bridge-tools.ts` + 两个 `.pi/extensions/knit.ts`
   - `knit_run` 的 assist mode 枚举改为仅 `discuss`。
3. `src/application/context-planner.ts`
   - 角色文件集合去掉 deliver（advisory 继续读 `.knit/agents/advisory.md`，可缺省）。
4. `src/application/templates.ts` 与 `assets/templates/.knit/`
   - 删除 `.knit/agents/deliver.md`；AGENTS 受管块入口由 "implement / check / deliver" 改为 "implement / check（交付由主会话协调）"；依赖该文件的清单／测试同步。
   - 交付汇总与授权要求写入主会话模板（workflow 交付段），不新增角色文件。
5. 本仓库 `.knit/agents/deliver.md` 删除，`.knit/workflow.md` 交付段确认已含主会话协调要求（汇总、核对、范围、授权、恢复）。

## 保留

- `knit deliver`、归档、提交分类、`readOnly` 预检、恢复与授权判断。
- 子进程／worker 完成不代表提交或推送已授权；已明确授权不重复确认。
- 旧运行记录、advisory 回执、`.knit/runs/` 与历史归档可继续读取，不迁移、不删除。

## 规范

- DESIGN §10.1（交付协调）、§4.3 命令表、AGENTS/模板说明、OPERATIONS、GLOSSARY 同步；删除 "assist deliver" 的现行描述，历史说明保留为历史。

## 验证

- `knit run assist deliver` 被拒绝且不产生 run；`assist discuss` 行为不变。
- 桥接 schema 不再暴露 deliver mode；初始化产物不含 `deliver.md`，AGENTS 受管块文案一致。
- `knit deliver` 计划／预检／归档路径与授权约束回归测试通过。
- `npm test` 全量通过（含 typecheck/build）。
