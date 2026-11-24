import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readMaterials } from "../dist/application/task-materials.js";
import { referencesOf } from "../dist/domain/task.js";
import { project } from "./helpers/cli.mjs";

test("从「相关资料」读出路径和标题", () => {
  const requirement = [
    "## 目标与范围",
    "",
    "正文里提到的 `next/src/not-a-reference.ts` 不算。",
    "",
    "```markdown",
    "## 相关资料",
    "",
    "- `docs/example.md` — 围栏里的示例不算",
    "```",
    "",
    "## 相关资料",
    "",
    "- `.knit/standards/development.md` — 开发规范，里面的 `stages` 不算",
    "- `next/src/a.ts`、`next/src/b.ts` — `currentStatus`、渲染",
    "  - `next/src/indented.ts` — 缩进的行不算",
    "- `docs/design.md#5-交接` — 设计的 `5.1` 小节",
    "- `next/src/a.ts` — 写了第二次",
    "- `docs/design.md#` — 井号后面是空的",
    "",
    "## 结尾",
    "",
    "- `next/src/after.ts` — 下一节里的不算",
  ].join("\n");
  assert.deepEqual(referencesOf(requirement), [
    { path: ".knit/standards/development.md", anchor: null },
    { path: "next/src/a.ts", anchor: null },
    { path: "next/src/b.ts", anchor: null },
    { path: "docs/design.md", anchor: "5-交接" },
    { path: "docs/design.md", anchor: null },
  ]);
  assert.deepEqual(referencesOf("## 目标与范围\n\n- `next/src/a.ts` — 没有相关资料这一节"), []);
});

test("读出文件、章节和目录", (t) => {
  const root = project(t);
  mkdirSync(join(root, "src/pi"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "design.md"), "# 设计\n\n## 5. 交接\n\n只给需求部分。\n\n## 6. 流程\n\n可以配置。\n");
  const references = [
    { path: "./src/a.ts", anchor: null },
    { path: "design.md", anchor: "5-交接" },
    { path: "src/pi/", anchor: null },
  ];
  assert.deepEqual(readMaterials(root, references), {
    materials: [
      { reference: references[0], kind: "file", text: "export const a = 1;\n" },
      { reference: references[1], kind: "section", text: "## 5. 交接\n\n只给需求部分。" },
      { reference: references[2], kind: "directory", text: null },
    ],
    problems: [],
  });
});

test("找不到时说明是哪一份", (t) => {
  const root = project(t);
  writeFileSync(join(root, "design.md"), "## 5. 交接\n\n只给需求部分。\n");
  const existing = { path: "design.md", anchor: null };
  const result = readMaterials(root, [
    { path: "src/missing.ts", anchor: null },
    { path: "design.md", anchor: "7-返工" },
    existing,
    { path: "../outside.md", anchor: null },
  ]);
  assert.deepEqual(result.problems, [
    "相关资料里点名的文件不存在：src/missing.ts",
    "design.md 里没有标题「7-返工」",
    "相关资料里的路径要写项目内的相对路径：../outside.md",
  ]);
  assert.deepEqual(result.materials, [{ reference: existing, kind: "file", text: "## 5. 交接\n\n只给需求部分。\n" }]);
});
