#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import process from "node:process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${message}`);
  if (!ok) failures.push(message);
};

const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (pack.status !== 0 || !pack.stdout) {
  console.error(pack.stderr || "npm pack --dry-run 未返回输出");
  process.exit(1);
}
const [tarball] = JSON.parse(pack.stdout);

check(tarball.name === pkg.name, `包名为 ${pkg.name}（实际 ${tarball.name}）`);
check(tarball.version === pkg.version, `版本为 ${pkg.version}（实际 ${tarball.version}）`);

const paths = tarball.files.map((f) => f.path);

const binTarget = pkg.bin?.knit;
check(binTarget !== undefined && paths.includes(binTarget), `包含 bin 入口 ${binTarget ?? "(未定义)"}`);
const required = [
  "package.json",
  "README.md",
  "assets/templates/workflow.yaml",
  "assets/templates/pi/extensions/knit.ts",
  "dist/adapters/antigravity/client.js",
  "dist/adapters/antigravity/pane.js",
  "dist/adapters/pi/pane-worker.js",
  "dist/cli/knit.js",
  ...(process.platform === "darwin" ? ["dist/adapters/antigravity/command-processes"] : []),
];
for (const path of required) {
  check(paths.includes(path), `包含 ${path}`);
}

const forbiddenPrefixes = ["src/", "test/", "docs/", "tasks/", "validation/", "scripts/", "node_modules/", ".git/"];
const forbiddenSuffixes = [".tsbuildinfo", ".tgz"];
const isTsSource = (p) => p.endsWith(".ts") && !p.endsWith(".d.ts");
/** 模板资产中的 .ts 是随包发布的生成模板，不是编译源码。 */
const templateAssets = (p) => p.startsWith("assets/templates/");
const forbiddenNames = [
  "AGENTS.md",
  "TASKS.md",
  "BLOCKERS.md",
  "DESIGN.md",
  "ARCHITECTURE.md",
  "STATES.md",
  "TECHNOLOGY.md",
  "OPERATIONS.md",
  "GLOSSARY.md",
  "RESEARCH.md",
  "WORKTREE.md",
];
const leaked = paths.filter(
  (p) =>
    forbiddenPrefixes.some((pre) => p.startsWith(pre)) ||
    forbiddenSuffixes.some((suf) => p.endsWith(suf)) ||
    (isTsSource(p) && !templateAssets(p)) ||
    forbiddenNames.includes(p),
);
check(leaked.length === 0, `无禁止文件（${leaked.length > 0 ? leaked.join(", ") : "clean"}）`);

const compiledEntry = readFileSync(new URL("../dist/cli/knit.js", import.meta.url), "utf8");
check(!compiledEntry.includes(process.cwd()), "编译入口不含本机仓库绝对路径");

const binMode = statSync(new URL("../dist/cli/knit.js", import.meta.url)).mode;
check((binMode & 0o111) === 0o111, "bin 入口保留执行位（可执行）");
if (process.platform === "darwin") {
  const trackerMode = statSync(new URL("../dist/adapters/antigravity/command-processes", import.meta.url)).mode;
  check((trackerMode & 0o111) === 0o111, "macOS 命令进程跟踪器保留执行位（可执行）");
}

const run = spawnSync(process.execPath, [new URL("../dist/cli/knit.js", import.meta.url).pathname, "--version"], {
  encoding: "utf8",
});
check(run.status === 0 && run.stdout.trim() === pkg.version, `编译入口可运行且 --version 输出 ${pkg.version}`);

console.log(`\n共 ${tarball.entryCount} 个文件：\n${paths.map((p) => `  ${p}`).join("\n")}`);
if (failures.length > 0) {
  console.error(`\npack 检查失败 ${failures.length} 项`);
  process.exit(1);
}
console.log("\npack 检查通过");
