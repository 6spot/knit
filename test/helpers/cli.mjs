import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

// 在 Rex 或宿主终端里跑测试时隔离外层宿主环境，避免带进普通 CLI 夹具；需要的测试自行设置。
for (const key of ["REX_SESSION", "REX_BLOCK", "PI_CODING_AGENT", "KNIT_HOST", "KNIT_HOST_SESSION", "KNIT_SESSION_AGENT", "KNIT_PI_EXECUTOR"]) {
  delete process.env[key];
}

const cli = new URL("../../dist/cli/knit.js", import.meta.url).pathname;

const homes = new WeakMap();

/** 在临时目录里建一个带 `.knit/` 的项目，测试结束时删除。 */
export function project(t) {
  if (!homes.has(t)) {
    const home = mkdtempSync(join(tmpdir(), "knit-test-home-"));
    const previous = process.env.KNIT_HOME;
    homes.set(t, home);
    process.env.KNIT_HOME = home;
    t.after(() => {
      if (previous === undefined) delete process.env.KNIT_HOME;
      if (previous !== undefined) process.env.KNIT_HOME = previous;
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
  }
  const dir = mkdtempSync(join(tmpdir(), "knit-next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(join(dir, ".knit"));
  return dir;
}

/** 在项目 `dir` 里运行 `node dist/cli/knit.js <参数>`。 */
export function knit(dir, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args, "--dir", dir], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
