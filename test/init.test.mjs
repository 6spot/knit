import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TEMPLATES } from "../dist/application/init.js";
import { knit } from "./helpers/cli.mjs";

const NEXT_STEP =
  "下一步: 在 .knit/workflow.yaml 里写上执行者的模型（model: provider/模型），再运行 knit workflow validate";
const targets = TEMPLATES.map((item) => item.target);
const template = (name) => readFileSync(new URL(`../assets/templates/${name}`, import.meta.url), "utf8");
const listed = (title, paths) => [title, ...paths.map((path) => `  ${path}`)];

/** 一个空的临时目录，不在 Git 仓库里。 */
function emptyDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("在空目录里初始化", (t) => {
  const dir = emptyDir(t);
  const result = knit(dir, "init");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${[...listed("已生成:", targets), NEXT_STEP].join("\n")}\n`);
  for (const item of TEMPLATES) assert.equal(readFileSync(join(dir, item.target), "utf8"), template(item.template));
  assert.deepEqual(readdirSync(join(dir, ".knit", "standards")), []);
  assert.deepEqual(readdirSync(join(dir, ".knit", "tasks")), []);
  assert.equal(existsSync(join(dir, "AGENTS.md")), false);

  assert.equal(knit(dir, "workflow", "validate").code, 0);
  assert.equal(knit(dir, "task", "new", "--title", "试一下").code, 0);
});

test("已有的文件不动，缺的补上", (t) => {
  const dir = emptyDir(t);
  knit(dir, "init");
  appendFileSync(join(dir, ".knit", "workflow.yaml"), "# 项目自己加的\n");
  rmSync(join(dir, ".knit", "agents", "review.md"));
  writeFileSync(join(dir, ".knit", "standards", "a.md"), "项目自己写的\n");
  const contents = () => [...targets, ".knit/standards/a.md"].map((path) => readFileSync(join(dir, path), "utf8"));

  const second = knit(dir, "init");
  assert.equal(second.code, 0, second.stderr);
  assert.equal(
    second.stdout,
    `${[
      ...listed("已生成:", [".knit/agents/review.md"]),
      ...listed("已有，没有动:", targets.filter((target) => target !== ".knit/agents/review.md")),
    ].join("\n")}\n`,
  );
  assert.equal(readFileSync(join(dir, ".knit", "workflow.yaml"), "utf8"), `${template("workflow.yaml")}# 项目自己加的\n`);
  assert.equal(readFileSync(join(dir, ".knit", "standards", "a.md"), "utf8"), "项目自己写的\n");
  assert.equal(readFileSync(join(dir, ".knit", "agents", "review.md"), "utf8"), template("agents/review.md"));

  const before = contents();
  const third = knit(dir, "init");
  assert.equal(third.code, 0, third.stderr);
  assert.equal(third.stdout, `${listed("已有，没有动:", targets).join("\n")}\n`);
  assert.deepEqual(contents(), before);
});
