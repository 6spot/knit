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
export function greet(name) {
  return `hello ${name}`;
}
</material>