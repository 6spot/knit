<task path=".knit/tasks/11-17-greet-word/task.md">
# greet 支持自定义问候语

## 目标与范围

`greet.mjs` 里的 `greet(name)` 现在固定返回 `hello <name>`。做完之后可以传第二个参数换掉问候语。

产出：

- `greet.mjs`（修改）：`greet(name, word)`，`word` 不传时是 `hello`。
- `greet.test.mjs`（新增）：用 `node:test` 写下面两个场景的测试。

不改别的文件，不加依赖。

验证：运行 `node --test`，输出里 `fail 0`。

## 完成条件

### Requirement: 问候语可以换

#### Scenario: 不传问候语

- WHEN 调用 `greet("knit")`
- THEN 返回 `hello knit`

#### Scenario: 传了问候语

- WHEN 调用 `greet("knit", "hi")`
- THEN 返回 `hi knit`

## 待澄清

## 相关资料

- `greet.mjs` — 要改的文件
</task>

<material path="greet.mjs">
export function greet(name, word = 'hello') {
  return `${word} ${name}`;
}
</material>

<previous-report stage="implement" path=".knit/.runtime/runs/r-e18ea1d40cbc/report.md">
改动的文件：
- greet.mjs
- greet.test.mjs

AGENTS-MARK: 7f3a

## 做了什么

- 修改 `greet.mjs`：把函数签名改成 `greet(name, word = 'hello')`，返回 `` `${word} ${name}` ``；不传 `word` 时仍返回 `hello <name>`。
- 新增 `greet.test.mjs`：用 `node:test` + `node:assert/strict` 写了两条中文名测试，分别覆盖“不传问候语”和“传了问候语”两个场景。
- 没有加依赖，没有改动其他文件。

## 场景验证

两个场景由新增的两条测试覆盖，统一运行需求指定的命令：

```
$ node --test
✔ 不传问候语时使用 hello (0.4ms)
✔ 传了问候语时使用传入的词 (0.064417ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 52.732167
EXIT=0
```

- 场景“不传问候语”：`greet("knit")` 断言等于 `hello knit`，通过。
- 场景“传了问候语”：`greet("knit", "hi")` 断言等于 `hi knit`，通过。
- 输出中 `fail 0`，满足验证要求。

## 工作区状态

- 未提交，HEAD 仍为 `49515fb00372d2df34c930d40e0924e02f8486fa`。
- 变更：`M greet.mjs`、`?? greet.test.mjs`；`.knit/tasks/` 为任务自带的未跟踪目录，未触碰。

## 未验证的内容

无。两个完成条件场景均已实际运行验证。
</previous-report>