## 报告

**做了什么**

- 新建 `hello.mjs`（仓库根目录），内容为：

  ```js
  import { greet } from "./src/greet.mjs";

  console.log(greet("Knit"));
  ```

- 未改 `src/greet.mjs`，未动其他文件，未提交。

**验证**

- 前置确认 `src/greet.mjs` 存在且导出 `greet`：`export function greet(name) { return \`你好，${name}\`; }`
- 运行 `node hello.mjs`，输出：

  ```
  你好，Knit
  ```
  退出码 `exit=0`，与完成条件一致。
- `git status --short` 仅显示 `?? hello.mjs`；`git diff -- src/greet.mjs` 为空，确认 `src/greet.mjs` 未被修改。HEAD 仍为 `1ecc0af5784937538284722a2dbec9e7c5dc9d90`。

**未验证/备注**

- 无未验证项。
- 未做的事：未提交（任务未要求且无授权）。