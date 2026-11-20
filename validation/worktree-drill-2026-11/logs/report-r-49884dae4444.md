## 报告

**做了什么**

- 新建 `src/greet.mjs`，导出 `greet(name)`，返回 `` `你好，${name}` ``（中文逗号，无空格）。
- 未改动其他文件，未提交。HEAD 保持 `a111b3a`。

**验证**

- 运行任务指定的命令：

  ```
  node -e 'import("./src/greet.mjs").then((m) => console.log(m.greet("Knit")))'
  ```

  实际输出：

  ```
  你好，Knit
  ```

  与完成条件一致。另用 `od -c` 核对了字节，为 UTF-8 的 `你好，Knit` 加换行。
- `git status --short` 只显示 `?? src/`（新增文件），没有其他改动。

**未验证的内容**

- 无。任务只要求这一个场景，已按指定命令验证通过。