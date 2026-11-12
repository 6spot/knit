/** 受管入口命令：init 按 PATH 中 knit 的版本选 `knit`，否则回退当前 CLI 绝对路径（k-731a13eab2f1）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { InitializationService, resolveManagedKnitCommand } from "../dist/application/initialization.js";

const ROOT = join(import.meta.dirname, "..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

function freshProject(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-managed-${prefix}-`)));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# demo\n");
  return dir;
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test("受管入口：PATH 中的 knit 版本一致时写 knit，不一致或缺失回退 CLI 绝对路径", async () => {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "knit-managed-bin-")));
  const matched = freshProject("match");
  const fallback = freshProject("fallback");
  const originalPath = process.env.PATH;
  const fakeKnit = join(bin, "knit");
  try {
    mkdirSync(join(bin, "empty"));
    writeFileSync(fakeKnit, `#!/bin/sh\nprintf '${VERSION}\\n'\n`);
    chmodSync(fakeKnit, 0o755);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;

    const matchedService = new InitializationService({ locksRoot: join(matched, ".locks-root") });
    assert.equal((await matchedService.execute({ dir: matched, client: "pi" })).ready, true);
    const matchedAgents = readFileSync(join(matched, "AGENTS.md"), "utf8");
    assert.ok(matchedAgents.includes("`knit task list`"), "版本一致时受管入口写 knit");
    assert.equal(matchedAgents.includes("npx --no-install knit"), false, "受管入口不写项目内 npx");

    // 版本不一致：回退当前 CLI 入口绝对路径。PATH 只留假命令，init 按非 Git 目录准备。
    writeFileSync(fakeKnit, "#!/bin/sh\nprintf '9.9.9\\n'\n");
    process.env.PATH = bin;
    const fallbackService = new InitializationService({ locksRoot: join(fallback, ".locks-root") });
    const fallbackResult = await fallbackService.execute({ dir: fallback, client: "pi" });
    assert.equal(fallbackResult.ready, true, fallbackResult.failed.map((item) => item.path).join(","));
    const installation = JSON.parse(readFileSync(join(fallback, ".knit", ".runtime", "installation.json"), "utf8"));
    assert.ok(installation.cliEntry.endsWith(join("dist", "cli", "knit.js")), installation.cliEntry);
    const fallbackAgents = readFileSync(join(fallback, "AGENTS.md"), "utf8");
    assert.ok(fallbackAgents.includes(`\`${installation.cliEntry} task list\``), "版本不一致时写 CLI 绝对路径");
    assert.equal(fallbackAgents.includes("npx --no-install knit"), false, "回退也不写项目内 npx");

    assert.equal(
      resolveManagedKnitCommand(installation.cliEntry, VERSION, { env: { PATH: join(bin, "empty") } }),
      installation.cliEntry,
      "PATH 中没有 knit 时回退",
    );
    assert.equal(
      resolveManagedKnitCommand(installation.cliEntry, VERSION, { env: { PATH: bin } }),
      installation.cliEntry,
      "版本不一致时回退",
    );
    assert.equal(
      resolveManagedKnitCommand(installation.cliEntry, VERSION, { env: { PATH: `${bin}${delimiter}${originalPath ?? ""}` } }),
      installation.cliEntry,
      "首个 knit 版本不一致时不采用后面的同名命令",
    );
    writeFileSync(fakeKnit, `#!/bin/sh\nprintf '${VERSION}\\n'\n`);
    assert.equal(
      resolveManagedKnitCommand("/opt/knit/dist/cli/knit.js", VERSION, { env: { PATH: `${bin}${delimiter}${originalPath ?? ""}` } }),
      "knit",
      "版本一致时返回 knit",
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(matched, { recursive: true, force: true });
    rmSync(fallback, { recursive: true, force: true });
  }
});

test("模板与现行文档不写项目内 npx 入口", () => {
  const currentFiles = [
    join(ROOT, "README.md"),
    join(ROOT, "AGENTS.md"),
    join(ROOT, "docs", "README.md"),
    ...filesUnder(join(ROOT, "docs", "design")),
    ...filesUnder(join(ROOT, "docs", "research")),
    ...filesUnder(join(ROOT, "assets", "templates")),
  ];
  for (const file of currentFiles) {
    assert.equal(readFileSync(file, "utf8").includes("npx --no-install knit"), false, `${file} 不写项目内 npx 入口`);
  }
});
