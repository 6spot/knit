import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const cli = new URL("../dist/cli/knit.js", import.meta.url).pathname;
const runCli = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("--version 输出 package.json 版本且退出码为 0", () => {
  const r = runCli(["--version"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("--help 输出用法且退出码为 0", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage/);
  assert.match(r.stdout, /knit/);
});

test("无参数时输出帮助且退出码为 0", () => {
  const r = runCli([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage/);
});

test("未知命令不回假成功", () => {
  const r = runCli(["definitely-not-a-command"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /error:/i);
});

test("未知选项不回假成功", () => {
  const r = runCli(["--definitely-not-an-option"]);
  assert.notEqual(r.status, 0);
});
