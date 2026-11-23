import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CORE_TEMPLATES } from "../dist/application/init.js";
import { knit } from "./helpers/cli.mjs";

const targets = CORE_TEMPLATES.map((item) => item.target);
const template = (name) => readFileSync(new URL(`../assets/templates/${name}`, import.meta.url), "utf8");
const listed = (title, paths) => [title, ...paths.map((path) => `  ${path}`)];

/** 一个初始化过的临时项目，不在 Git 仓库里。 */
function initialized(t) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(knit(dir, "init").code, 0);
  return dir;
}

/** 目录下所有文件的相对路径，排过序。 */
const filesUnder = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();

test("改过的先备份再恢复", (t) => {
  const dir = initialized(t);
  const changed = [".knit/workflow.yaml", ".knit/agents/implement.md"];
  appendFileSync(join(dir, ".knit", "workflow.yaml"), "# 项目自己加的\n");
  writeFileSync(join(dir, ".knit", "agents", "implement.md"), "项目自己改的\n");
  rmSync(join(dir, ".knit", "agents", "review.md"));

  const result = knit(dir, "init", "--force");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readdirSync(dir), [".knit"]);
  for (const item of CORE_TEMPLATES) assert.equal(readFileSync(join(dir, item.target), "utf8"), template(item.template));

  const backups = readdirSync(join(dir, ".knit", ".runtime", "backups"));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^\d{8}-\d{6}-\d{3}$/);
  const backupDir = join(dir, ".knit", ".runtime", "backups", backups[0]);
  assert.deepEqual(filesUnder(backupDir), [...changed].sort());
  assert.equal(readFileSync(join(backupDir, ".knit", "workflow.yaml"), "utf8"), `${template("workflow.yaml")}# 项目自己加的\n`);
  assert.equal(readFileSync(join(backupDir, ".knit", "agents", "implement.md"), "utf8"), "项目自己改的\n");

  assert.equal(
    result.stdout,
    `${[
      ...listed("已生成:", [".knit/agents/review.md"]),
      ...listed("已恢复成模板:", changed),
      `备份: .knit/.runtime/backups/${backups[0]}/`,
      ...listed("已有，没有动:", targets.filter((target) => target !== ".knit/agents/review.md" && !changed.includes(target))),
    ].join("\n")}\n`,
  );

  const again = knit(dir, "init", "--force");
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, `${listed("已有，没有动:", targets).join("\n")}\n`);
  assert.deepEqual(readdirSync(join(dir, ".knit", ".runtime", "backups")), backups);
});

test("其它宿主文件不启用桥接，显式补装后按已有副本恢复整个插件", (t) => {
  const dir = initialized(t);
  const plugin = ".agents/plugins/knit";
  mkdirSync(join(dir, ".agents/plugins/other"), { recursive: true });
  mkdirSync(join(dir, ".pi/extensions"), { recursive: true });
  assert.equal(knit(dir, "init", "--force").code, 0);
  assert.equal(existsSync(join(dir, plugin)), false);
  assert.equal(existsSync(join(dir, ".pi/extensions/knit.ts")), false);

  assert.equal(knit(dir, "init", "--agy").code, 0);
  const rules = `${plugin}/rules/AGENTS.md`;
  writeFileSync(join(dir, rules), "项目的插件说明\n");
  rmSync(join(dir, plugin, "plugin.json"));
  rmSync(join(dir, plugin, "hooks.json"));
  assert.equal(knit(dir, "init").code, 0);
  assert.equal(existsSync(join(dir, plugin, "hooks.json")), false);

  const restored = knit(dir, "init", "--force", "--pi");
  assert.equal(restored.code, 0, restored.stderr);
  for (const path of ["plugin.json", "hooks.json", "rules/AGENTS.md"]) {
    assert.equal(readFileSync(join(dir, plugin, path), "utf8"), template(`${plugin.slice(1)}/${path}`));
  }
  assert.equal(readFileSync(join(dir, ".pi/extensions/knit.ts"), "utf8"), template("pi/extensions/knit.ts"));
  const backup = join(dir, restored.stdout.match(/^备份: (.+)\/$/m)[1]);
  assert.deepEqual(filesUnder(backup), [rules]);
  assert.equal(readFileSync(join(backup, rules), "utf8"), "项目的插件说明\n");
});

test("配置、规范和任务不动", (t) => {
  const dir = initialized(t);
  writeFileSync(join(dir, ".knit", "config.json"), '{ "handoff": { "fileBytes": 100 } }\n');
  appendFileSync(join(dir, ".knit", ".gitignore"), "notes/\n");
  writeFileSync(join(dir, ".knit", "standards", "a.md"), "项目自己写的\n");
  assert.equal(knit(dir, "task", "new", "--title", "试一下").code, 0);
  const own = [
    ".knit/config.json",
    ".knit/.gitignore",
    ".knit/standards/a.md",
    ...filesUnder(join(dir, ".knit", "tasks")).map((path) => `.knit/tasks/${path}`),
  ];
  assert.equal(own.length > 3, true);
  const contents = () => own.map((path) => readFileSync(join(dir, path), "utf8"));
  const before = contents();

  const result = knit(dir, "init", "--force");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(contents(), before);
  assert.deepEqual(filesUnder(join(dir, ".knit", "standards")), ["a.md"]);
  assert.equal(existsSync(join(dir, ".knit", ".runtime", "backups")), false);
  assert.doesNotMatch(result.stdout, /已恢复成模板:|备份:/);
});

test("已有的同名规范不覆盖", (t) => {
  const dir = initialized(t);
  const path = ".knit/standards/discussion.md";
  writeFileSync(join(dir, path), "项目自己改过的讨论规范。\n");

  for (const args of [["init"], ["init", "--force"]]) {
    const result = knit(dir, ...args);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.startsWith(`${listed("已有，没有动:", targets).join("\n")}\n`));
    assert.match(result.stdout, /旧版通用规范副本.*迁入另名的项目规范/);
    assert.ok(result.stdout.includes(path));
    assert.equal(readFileSync(join(dir, path), "utf8"), "项目自己改过的讨论规范。\n");
  }
  assert.equal(existsSync(join(dir, ".knit", ".runtime", "backups")), false);
});
