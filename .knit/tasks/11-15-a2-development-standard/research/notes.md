# 开发规范：来源对照

规范文件：`.knit/standards/development.md`，2,783 字节。

## 来源一：`AGENTS.md`「开发约定」

| 条目 | 结论 | 去处或理由 |
| --- | --- | --- |
| 1 实现范围以 DESIGN 15.1 为准；独立 CLI；Worktree 链路 | 改写后采纳 | 「范围」第 1 条。DESIGN 15.1 和 Worktree 链路会随重构变化，改成“以任务和它点名的设计为准” |
| 2 先找出受影响的结构再同步修改；按各设计文档；只加载所需资料 | 采纳 | 「范围」第 2 条。逐个点名的设计文档没收：切换时会被替换 |
| 3 改命名或路径时核对完整链路；区分名称、身份、位置 | 采纳 | 「范围」第 3 条。链路里去掉了 Worktree、调度、绑定、恢复 |
| 4 只持久化必要事实；clarify/change；测试按副作用和不变量选 | 部分采纳 | 「范围」第 4 条、「测试」第 1 条。clarify／change 不收：重构后不做 |
| 5 主会话用 `task implement` 登记再 `task close`；`--force` | 不采纳 | 给主会话的规则，且只在旧 Knit 下成立 |
| 6 复用本机 Pi CLI 和公开协议；不引 SDK；缺能力先报告 | 采纳 | 「范围」第 5 条 |
| 7 原生恢复默认 prefer | 不采纳 | 续用旧会话在重构后不做 |
| 8 开发者模式只增诊断 | 不采纳 | 开发者模式不在小核心范围内 |
| 9 Knit 自身故障时主会话可直接修复 | 不采纳 | 给主会话的规则；针对的锁、调度、恢复在重构后不做 |
| 10 Git／模型／故障测试在隔离夹具；文风整理保持行为 | 采纳 | 「测试」第 3 条、「文档」第 4 条 |
| 11 禁止防御性过度设计；只留必要测试 | 采纳 | 「复杂度」第 1 条、「测试」第 1 条 |
| 12 功能保持独立，除非可组合或可重用 | 采纳 | 「复杂度」第 3 条，与 opencode 的同一条合并 |
| 13 不预先提取只用一次的辅助函数 | 采纳 | 「复杂度」第 4 条，与 opencode 的同一条合并 |
| 14 极不可能的场景先向用户说明再做 | 采纳 | 「复杂度」第 2 条，与 opencode 的同一条合并 |

## 来源一：`AGENTS.md`「交付检查」

| 条目 | 结论 | 去处或理由 |
| --- | --- | --- |
| 1 通读修改后的章节，核对一致性 | 采纳 | 「文档」第 1 条 |
| 2 搜索旧名称、旧路径和被替代措辞 | 采纳 | 「文档」第 2 条 |
| 3 核对章节编号、交叉引用、Markdown 结构 | 采纳 | 「文档」第 3 条。“固定提交来源”没收：是历史文档的做法 |
| 4 汇报实际修改和验证；完成不自动触发提交 | 不采纳 | 给主会话的规则，写在交付规范里 |

## 来源二：opencode AGENTS.md 摘录

| 条目 | 结论 | 去处或理由 |
| --- | --- | --- |
| Commits and PR Titles | 不采纳 | 属于交付规范 |
| Keep things in one function | 采纳 | 「复杂度」第 3 条 |
| Validate unknown values once at the boundary | 采纳 | 「复杂度」第 6 条 |
| Do not extract single-use helpers | 采纳 | 「复杂度」第 4 条 |
| Explain speculative complexity first | 采纳 | 「复杂度」第 2 条 |
| Avoid try/catch | 采纳 | 「写法」第 1 条。现有代码 527 处，只约束新代码 |
| Avoid any | 采纳 | 「写法」第 2 条。现有 17 处 |
| Use Bun APIs | 不采纳 | 本项目用 Node |
| Rely on type inference | 采纳 | 「写法」第 3 条 |
| Prefer functional array methods | 采纳 | 「写法」第 8 条 |
| `src/config` self-export pattern | 不采纳 | opencode 自己的目录约定 |
| Effect generators: bind services | 不采纳 | 本项目不用 Effect |
| Inline single-use values | 采纳 | 「写法」第 6 条 |
| Avoid unnecessary destructuring | 采纳 | 「写法」第 7 条 |
| Never alias imports | 采纳 | 「写法」第 9 条。现有 5 处 |
| Never use type-position `import("…")` | 采纳 | 「写法」第 9 条。现有 2 处 |
| Never use star imports | 采纳 | 「写法」第 9 条。现有 0 处 |
| Import the module's own namespace by name | 不采纳 | 依赖 opencode 的命名空间导出写法 |
| Prefer dynamic imports for heavy modules | 采纳 | 「写法」第 10 条。现有 23 处动态导入 |
| Prefer const over let | 采纳 | 「写法」第 4 条。现有 `let` 405 处 |
| Avoid else, prefer early returns | 采纳 | 「写法」第 5 条。现有 `} else ` 207 处 |
| Complex Logic: main function reads as the happy path | 采纳 | 「复杂度」第 5 条 |
| Keep helpers close, below the main export | 采纳 | 并入「复杂度」第 5 条 |
| Do not over-abstract into single-use helpers | 采纳 | 并入「复杂度」第 4 条 |
| Do not return Effect from helpers; prefer Effect schema helpers | 不采纳 | 本项目不用 Effect |
| Comments for non-obvious constraints only | 采纳 | 「写法」第 11 条 |
| Avoid mocks | 采纳 | 「测试」第 2 条 |
| Test actual implementation | 采纳 | 「测试」第 2 条 |
| Tests cannot run from repo root | 不采纳 | opencode 的仓库结构 |
| Read the matching skill before writing tests | 不采纳 | opencode 的技能目录 |

## 验证

- `wc -c`：2,783 字节，上限 4,096。
- `node dist/cli/knit.js standards list`：列出了 `development.md`，带“（索引未引用）”。

## 待用户确认

- 「写法」一节的 11 条全部来自 opencode，和现有代码的写法差别很大。规范里写明只约束新代码。不想要其中某几条的话直接删。
