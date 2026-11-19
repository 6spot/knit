<task path=".knit/tasks/11-19-greet-word/task.md">
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
export function greet(name, word = "hello") {
  return `${word} ${name}`;
}
</material>

<previous-report stage="implement" path=".knit/.runtime/runs/r-e0669e5cedf3/report.md">
改动的文件：
- greet.mjs
- greet.test.mjs

AGENTS-MARK: 7f3a

## 做了什么

- `greet.mjs`：将 `greet(name)` 改为 `greet(name, word = "hello")`，返回 `` `${word} ${name}` ``。
- `greet.test.mjs`（新增）：使用 `node:test` + `node:assert/strict`，包含两个中文命名的用例（符合 `.knit/standards/testing.md`）。
- 未改其他文件，未加依赖，未提交，HEAD 保持 `171910d87ddecf4102b80a49a4ce33e9375327c2`。

## 验证

运行 `node --test`：

```
✔ 不传问候语时返回 hello 加名字 (0.9586ms)
✔ 传了问候语时使用传入的问候语 (0.2132ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
exit=0
```

- 场景「不传问候语」：`greet("knit")` 断言等于 `hello knit`，通过。
- 场景「传了问候语」：`greet("knit", "hi")` 断言等于 `hi knit`，通过。
- 完成条件的 `fail 0` 已满足。

## 未验证内容

无。测试未覆盖空字符串等边界值，但需求未要求。

## 备注

`git status` 显示 `?? .knit/tasks/`（任务文件本身未被跟踪，非本次改动）。
</previous-report>