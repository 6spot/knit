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