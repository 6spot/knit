// 旧设计文档移到 docs/history/design/ 之后，把指向它们的链接和它们往外指的链接改对。
// 在仓库根目录运行，先做完 git mv：node validation/slim-h5-2026-11/relink-old-design.mjs
// 只做固定的字符串替换，运行第二次不会再改（输出「改了 0 处」）。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const md = (dir) => readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => join(dir, name));
const rules = [
  [md("docs/history/tasks"), [["](../../design/", "](../design/"]]],
  [md("docs/history"), [["](../design/", "](design/"]]],
  [md("docs/research"), [["](../design/", "](../history/design/"]]],
  [md("docs/history/design"), [
    ["](../research/", "](../../research/"],
    ["](../history/", "](../"],
    ["](../../validation/", "](../../../validation/"],
    ["](../../AGENTS.md", "](../../../AGENTS.md"],
  ]],
  [["docs/README.md"], [["](design/", "](history/design/"]]],
  [["AGENTS.md"], [["[docs/design/](docs/design/)", "[docs/history/design/](docs/history/design/)"]]],
  [["README.md"], [["/blob/main/docs/design/", "/blob/main/docs/history/design/"]]],
  [[".knit/tasks/11-14-slim-refactor/task.md"], [[
    "`docs/design/DESIGN.md` 第 3.3 节、第 8 节、第 15.1 节 — 现行的任务结构、规范与范围",
    "`docs/history/design/DESIGN.md` 第 3.3 节、第 8 节、第 15.1 节 — 重构之前的任务结构、规范与范围",
  ]]],
];
let total = 0;
for (const [files, pairs] of rules) {
  for (const file of files) {
    const before = readFileSync(file, "utf8");
    let after = before;
    for (const [from, to] of pairs) {
      total += after.split(from).length - 1;
      after = after.replaceAll(from, to);
    }
    if (after !== before) writeFileSync(file, after);
  }
}
console.log(`改了 ${total} 处`);
