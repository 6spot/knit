import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const cli = new URL("../../dist/cli/knit.js", import.meta.url).pathname;

/** 在临时目录里建一个带 `.knit/` 的项目，测试结束时删除。 */
export function project(t) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".knit"));
  return dir;
}

/** 在项目 `dir` 里运行 `node next/dist/cli/knit.js <参数>`。 */
export function knit(dir, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args, "--dir", dir], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
