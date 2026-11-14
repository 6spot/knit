#!/usr/bin/env node
// 本机真实 Pi 验收 P0：源码导出清单核对。
// 从 `git ls-tree -r -z` 记录与导出目录逐文件比对 mode/内容，生成清单 JSON；
// 传入基线清单时，再核对 commit、文件数与内容摘要是否一致。
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const USAGE = `用法：node export-check.mjs --src <导出目录> --ls-tree <git-ls-tree 文件> --out <清单路径> [选项]

选项：
  --commit <sha>    记录的冻结提交
  --expect <路径>   基线清单；核对 commit / fileCount / contentDigest
  --label <说明>    清单标记（例如 normal-engineering）
  -h, --help        显示本帮助`;

function fail(message) {
  console.error(`export-check: ${message}`);
  process.exit(1);
}

function usageError(message) {
  console.error(`export-check: ${message}\n\n${USAGE}`);
  process.exit(2);
}

const options = { src: null, lsTree: null, out: null, commit: null, expect: null, label: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  const next = () => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usageError(`${arg} 缺少取值`);
    i += 1;
    return value;
  };
  switch (arg) {
    case "--src":
      options.src = next();
      break;
    case "--ls-tree":
      options.lsTree = next();
      break;
    case "--out":
      options.out = next();
      break;
    case "--commit":
      options.commit = next();
      break;
    case "--expect":
      options.expect = next();
      break;
    case "--label":
      options.label = next();
      break;
    case "-h":
    case "--help":
      console.log(USAGE);
      process.exit(0);
      break;
    default:
      usageError(`未知参数：${arg}`);
  }
}
if (!options.src || !options.lsTree || !options.out) usageError("--src、--ls-tree、--out 均为必填");

const src = resolve(options.src);
const lsTreePath = resolve(options.lsTree);
const outPath = resolve(options.out);

/** 读取 git ls-tree -z 记录：`<mode> <type> <sha>\t<path>\0`。 */
function readTreeRecords() {
  let raw;
  try {
    raw = readFileSync(lsTreePath);
  } catch (error) {
    fail(`无法读取 ls-tree 文件 ${lsTreePath}：${error.message}`);
  }
  const records = raw.toString("utf8").split("\0").filter((record) => record.length > 0);
  if (records.length === 0) fail(`${lsTreePath} 为空：拒绝用空树生成清单`);
  return records.map((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) fail(`ls-tree 记录缺少制表符：${JSON.stringify(record.slice(0, 80))}`);
    const [mode, type, gitSha] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (type !== "blob") fail(`不支持的对象类型 ${type}（${path}）`);
    if (mode !== "100644" && mode !== "100755") fail(`不支持的文件 mode ${mode}（${path}）`);
    if (!gitSha || !/^[0-9a-f]{40}$/.test(gitSha)) fail(`无效的 blob sha（${path}）`);
    return { mode, path, gitSha };
  });
}

const entries = readTreeRecords();
const seen = new Set();

for (const entry of entries) {
  const full = join(src, entry.path);
  let stats;
  try {
    stats = lstatSync(full);
  } catch {
    fail(`导出目录缺少文件：${entry.path}`);
  }
  if (!stats.isFile()) fail(`导出路径不是普通文件：${entry.path}`);
  const actualMode = (stats.mode & 0o777).toString(8).padStart(3, "0");
  if (`100${actualMode}` !== entry.mode) {
    fail(`mode 不一致：${entry.path} 期望 ${entry.mode}，实际 ${actualMode}`);
  }
  const content = readFileSync(full);
  entry.size = content.length;
  entry.sha256 = createHash("sha256").update(content).digest("hex");
  seen.add(entry.path);
}

/** 导出目录不允许有 git 未记录的文件（例如 .DS_Store、旧构建产物）。 */
const extras = [];
function walk(directory, prefix) {
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name);
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    const stats = lstatSync(full);
    if (stats.isSymbolicLink()) fail(`导出目录含符号链接（不支持）：${relative}`);
    if (stats.isDirectory()) {
      walk(full, relative);
      continue;
    }
    if (!seen.has(relative)) extras.push(relative);
  }
}
walk(src, "");
if (extras.length > 0) {
  fail(`导出目录含 ${extras.length} 个 git 未记录文件：${extras.slice(0, 10).join("、")}${extras.length > 10 ? "……" : ""}`);
}

// 按 path 的 UTF-8 字节序排序，保证不同机器生成同一摘要。
entries.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
const digest = createHash("sha256");
for (const entry of entries) digest.update(`${entry.mode} ${entry.sha256} ${entry.path}\n`);
const contentDigest = `sha256:${digest.digest("hex")}`;
const executableCount = entries.filter((entry) => entry.mode === "100755").length;

const manifest = {
  tool: "validation/local-real-pi-acceptance-2026-11/worker/export-check.mjs",
  label: options.label,
  generatedAt: new Date().toISOString(),
  commit: options.commit,
  fileCount: entries.length,
  executableCount,
  symlinkCount: 0,
  contentDigest,
  digestRecipe: "按 path 的 UTF-8 字节序排序后，对每行 `<gitMode> <fileSha256> <path>\\n` 拼接并取 sha256",
  files: entries.map((entry) => ({ path: entry.path, mode: entry.mode, sha256: entry.sha256, size: entry.size })),
};

if (options.expect) {
  let expected;
  try {
    expected = JSON.parse(readFileSync(resolve(options.expect), "utf8"));
  } catch (error) {
    fail(`无法读取基线清单 ${options.expect}：${error.message}`);
  }
  const problems = [];
  if (options.commit && expected.commit && expected.commit !== options.commit) {
    problems.push(`commit 不一致：基线 ${expected.commit}，本次 ${options.commit}`);
  }
  if (expected.fileCount !== manifest.fileCount) {
    problems.push(`文件数不一致：基线 ${expected.fileCount}，本次 ${manifest.fileCount}`);
  }
  if (expected.contentDigest !== manifest.contentDigest) {
    problems.push(`内容摘要不一致：基线 ${expected.contentDigest}，本次 ${manifest.contentDigest}`);
  }
  if (problems.length > 0) {
    console.error(`export-check: 导出与冻结基线不一致\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`export-check: 与基线一致（${manifest.fileCount} 个文件，${manifest.contentDigest}）`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  `export-check: ${manifest.fileCount} 个文件（可执行 ${manifest.executableCount}），commit ${manifest.commit ?? "未记录"}，摘要 ${manifest.contentDigest}`,
);
console.log(`export-check: 清单已写入 ${outPath}`);
