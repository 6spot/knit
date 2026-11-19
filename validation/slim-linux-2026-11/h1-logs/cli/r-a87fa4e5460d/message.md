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

<previous-report stage="implement" path=".knit/.runtime/runs/r-cba3da5b504e/report.md">
改动的文件：
- greet.mjs
- greet.test.mjs

AGENTS-MARK: 7f3a

## 做了什么

- 修改 `greet.mjs`：签名为 `greet(name, word = "hello")`，返回 `` `${word} ${name}` ``。
  - 不传 `word` 时默认值为 `hello`，原行为不变。
- 新增 `greet.test.mjs`：用 `node:test` + `node:assert/strict` 写两个场景的测试，测试名按测试规范用中文。
- 未改动其他文件，未加依赖，未提交（HEAD 仍为 `aa12428`）。

```diff
-export function greet(name) {
-  return `hello ${name}`;
+export function greet(name, word = "hello") {
+  return `${word} ${name}`;
 }
```

## 验证

1. 运行任务指定的命令 `node --test`：

```
✔ 不传问候语时使用 hello (0.9484ms)
✔ 传了问候语时使用传入的问候语 (0.18328ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

`fail 0`，退出码 `EXIT=0`。两个测试分别对应「不传问候语 → `hello knit`」和「传了问候语 → `hi knit`」。

2. 直接调用实际值确认（含 `undefined` 走默认值的边界）：

```
$ node -e 'import("./greet.mjs").then(m=>console.log(JSON.stringify([m.greet("knit"), m.greet("knit","hi"), m.greet("knit",undefined)])))'
["hello knit","hi knit","hello knit"]
```

3. 变更范围确认：

```
$ git status --short
 M greet.mjs
?? .knit/tasks/
?? greet.test.mjs
$ git rev-parse HEAD
aa124287f57b3cb0f1e55bb359f4b7cb8052a864
```

（`.knit/tasks/` 是任务开始时即存在的未跟踪目录，非本次产出。）

## 未验证/未做的事项

- 未覆盖 `word` 传空字符串、`null` 等异常输入：任务未定义这些行为，`word = "hello"` 只在 `undefined` 时生效，此点供审查知悉，未自行扩展需求。
- 未覆盖 `name` 为非字符串等其他类型：不在需求范围内。
</previous-report>