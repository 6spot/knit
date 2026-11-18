import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import process from "node:process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
import { project } from "./helpers/cli.mjs";

const cli = new URL("../dist/cli/knit.js", import.meta.url).pathname;

/** 运行 knit，`closed` 那一路输出在它写之前就关掉；返回退出码和另一路输出的内容。 */
async function withClosedPipe(args, closed) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  child[closed].destroy();
  const other = child[closed === "stdout" ? "stderr" : "stdout"];
  let text = "";
  other.setEncoding("utf8").on("data", (chunk) => (text += chunk));
  const [code] = await once(child, "close");
  return { code, text };
}

test("--version 输出根目录 package.json 的版本且退出码为 0", () => {
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("输出接在已经关掉的管道上时不报错，退出码照旧", async (t) => {
  const dir = project(t);

  // 像 `knit task list | grep -q …`：命令成功，标准输出没有人读了。
  assert.deepEqual(await withClosedPipe(["task", "list", "--dir", dir], "stdout"), { code: 0, text: "" });
  // 命令失败、标准错误没有人读了：退出码还是 1。
  assert.deepEqual(await withClosedPipe(["task", "show", "k-nope", "--dir", dir], "stderr"), { code: 1, text: "" });
});
