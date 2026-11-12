/** 受管入口命令：init 按 PATH 中 knit 的版本选 `knit`，否则回退当前 CLI 绝对路径（k-731a13eab2f1）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    writeFileSync(fakeKnit, `#!${process.execPath}\nconsole.log(${JSON.stringify(VERSION)});\n`);
    chmodSync(fakeKnit, 0o755);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;

    const matchedService = new InitializationService({ locksRoot: join(matched, ".locks-root") });
    assert.equal((await matchedService.execute({ dir: matched, client: "pi" })).ready, true);
    const matchedAgents = readFileSync(join(matched, "AGENTS.md"), "utf8");
    assert.ok(matchedAgents.includes("`knit task list`"), "版本一致时受管入口写 knit");
    assert.equal(matchedAgents.includes("npx --no-install knit"), false, "受管入口不写项目内 npx");

    // 版本不一致：回退当前 CLI 入口绝对路径。PATH 只留假命令，init 按非 Git 目录准备。
    writeFileSync(fakeKnit, `#!${process.execPath}\nconsole.log("9.9.9");\n`);
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
    const laterBin = join(bin, "later");
    mkdirSync(laterBin);
    const laterMarker = join(bin, "later-probed");
    writeFileSync(join(laterBin, "knit"), `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(laterMarker)}, "unexpected");\nconsole.log(${JSON.stringify(VERSION)});\n`);
    chmodSync(join(laterBin, "knit"), 0o755);
    assert.equal(
      resolveManagedKnitCommand(installation.cliEntry, VERSION, { env: { PATH: `${bin}${delimiter}${laterBin}` } }),
      installation.cliEntry,
      "首个 knit 版本不一致时不采用后面的匹配命令",
    );
    assert.equal(existsSync(laterMarker), false, "不探测后面的匹配命令");
    writeFileSync(fakeKnit, `#!${process.execPath}\nconsole.log(${JSON.stringify(VERSION)});\n`);
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

function isolatedEnv(root, bin) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:KNIT_|REX_|TERM_PROGRAM)/.test(key),
  ));
  return {
    ...env,
    PATH: bin,
    KNIT_KEYS_ROOT: join(root, "keys"),
    KNIT_LOCKS_ROOT: join(root, "locks"),
    KNIT_QUOTE_VALUE: "expanded-value-must-not-be-used",
  };
}

// Each installation is a real copy: a symlink to the CLI would resolve back to the ordinary path.
for (const [label, directory] of [
  ["ordinary", "installation-plain"],
  ["spaces", "installation with spaces"],
  ["special", "installation ' \"$KNIT_QUOTE_VALUE\" $(touch injected)"],
]) {
  for (const branch of ["missing", "mismatch", "failed"]) {
    test(`受管回退实际执行：${label}/${branch}`, { skip: process.platform === "win32" }, (t) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "knit-managed-quote-")));
      try {
        const installationRoot = join(root, directory);
        const project = join(root, "project");
        const bin = join(root, "bin");
        mkdirSync(project);
        mkdirSync(bin);
        cpSync(join(ROOT, "dist"), join(installationRoot, "dist"), { recursive: true });
        for (const name of ["assets", "node_modules", "package.json"]) {
          symlinkSync(join(ROOT, name), join(installationRoot, name));
        }
        const cli = join(installationRoot, "dist", "cli", "knit.js");
        chmodSync(cli, 0o755);
        // The installed CLI's env-node shebang still resolves under the deliberately restricted PATH.
        symlinkSync(process.execPath, join(bin, "node"));
        if (branch !== "missing") {
          writeFileSync(join(bin, "knit"), `#!${process.execPath}\n${branch === "failed" ? "process.exit(1);" : 'console.log("9.9.9");'}\n`);
          chmodSync(join(bin, "knit"), 0o755);
        }
        const env = isolatedEnv(root, bin);
        const init = spawnSync(process.execPath, [cli, "init", "--dir", project], {
          cwd: project, env, encoding: "utf8", timeout: 30_000,
        });
        assert.equal(init.status, 0, `${init.error ?? ""}\n${init.stdout}\n${init.stderr}`);
        const installation = JSON.parse(readFileSync(join(project, ".knit", ".runtime", "installation.json"), "utf8"));
        assert.equal(installation.cliEntry, realpathSync(cli), "R2.S1: installation retains the real file path");
        assert.ok(readFileSync(installation.cliEntry, "utf8").startsWith("#!/usr/bin/env node"));
        const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
        const command = agents.match(/活跃用 `(.+?) task list`/)?.[1];
        assert.ok(command, "extract the command actually generated in AGENTS");
        assert.equal(agents.includes("npx --no-install knit"), false);
        if (label === "ordinary") assert.equal(command, cli, "ordinary paths keep their command spelling");
        t.diagnostic(JSON.stringify({ label, branch, command, cliEntry: installation.cliEntry }));
        if (label === "spaces" && branch === "missing") {
          const baseline = spawnSync("/bin/sh", ["-c", `${installation.cliEntry} --version`], {
            cwd: project, env, encoding: "utf8", timeout: 30_000,
          });
          assert.equal(baseline.status, 127, "the original bare-path fallback reproduces truncation");
          t.diagnostic(JSON.stringify({ baseline: "bare-path", status: baseline.status, stderr: baseline.stderr.trim() }));
        }
        for (const args of ["--version", "task list", "task list --archive"]) {
          const result = spawnSync("/bin/sh", ["-c", `${command} ${args}`], {
            cwd: project, env, encoding: "utf8", timeout: 30_000,
          });
          assert.equal(result.status, 0, `${command} ${args}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
          if (args === "--version") assert.equal(result.stdout.trim(), VERSION);
          t.diagnostic(JSON.stringify({ args, status: result.status, stdout: result.stdout.trim() }));
        }
        assert.equal(existsSync(join(project, "injected")), false, "R1.S2: command substitution never runs");
        assert.equal(existsSync(join(project, "node_modules")), false, "no local packages installed");
        // Re-init exercises installation identity comparison without passing the shell token as argv.
        const check = spawnSync(process.execPath, [installation.cliEntry, "init", "--check", "--dir", project], {
          cwd: project, env, encoding: "utf8", timeout: 30_000,
        });
        assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
        assert.equal(JSON.parse(readFileSync(join(project, ".knit", ".runtime", "installation.json"), "utf8")).cliEntry, realpathSync(cli));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

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
