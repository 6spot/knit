#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const npmCommand = process.env.npm_execpath ? process.execPath : "npm";
const npmArgs = process.env.npm_execpath ? [process.env.npm_execpath] : [];

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (capture && result.stdout) process.stderr.write(result.stdout);
    throw new Error(result.error?.message ?? `命令失败（${result.signal ?? result.status}）：${command} ${args.join(" ")}`);
  }
  return result.stdout?.trim();
}

function npm(args, capture = false) {
  return run(npmCommand, [...npmArgs, ...args], capture);
}

function main() {
  const { values } = parseArgs({
    options: {
      prefix: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`用法：npm run pack:install -- [--prefix <目录>]

安装构建依赖、构建并打包，再从 tgz 全局安装 ${pkg.name}。
默认使用 npm 全局安装位置；--prefix 可指定其它位置。
需要 Node.js >=24、npm，以及下载依赖所需的网络连接。`);
    return;
  }
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error("需要 Node.js >=24，请先升级 Node.js。");
  }
  if (values.prefix !== undefined && values.prefix.trim() === "") {
    throw new Error("--prefix 需要非空目录。");
  }
  // 相对 prefix 按调用者所在目录解释，内部 npm 命令始终在仓库根目录运行。
  const prefixArgs = values.prefix === undefined ? [] : ["--prefix", resolve(values.prefix)];

  console.log("[1/3] 安装构建依赖（npm ci）");
  npm(["ci", "--include=dev", "--no-audit", "--no-fund"]);

  console.log("[2/3] 构建并打包（npm pack，prepack 自动构建）");
  const [packed] = JSON.parse(npm(["pack", "--json", "--ignore-scripts=false", "--pack-destination", root], true));
  if (!packed?.filename || packed.name !== pkg.name || packed.version !== pkg.version) {
    throw new Error("npm pack 未返回预期的包名、版本或 tgz 文件名。");
  }
  const tarball = join(root, packed.filename);

  console.log(`[3/3] 从 ${tarball} 全局安装`);
  npm(["install", "--global", ...prefixArgs, "--no-audit", "--no-fund", tarball]);

  const installedRoot = npm(["root", "--global", ...prefixArgs], true);
  const installedEntry = join(installedRoot, pkg.name, pkg.bin.knit);
  const version = run(process.execPath, [installedEntry, "--version"], true);
  if (version !== pkg.version) {
    throw new Error(`安装版本校验失败：预期 ${pkg.version}，实际 ${version}`);
  }
  const binDir = process.platform === "win32" ? dirname(installedRoot) : resolve(installedRoot, "..", "..", "bin");
  console.log(`\n安装完成：${pkg.name} ${version}\n安装入口：${join(binDir, process.platform === "win32" ? "knit.cmd" : "knit")}\n保留安装包：${tarball}\n请确保 ${binDir} 已加入 PATH，然后运行 knit --version。`);
}

try {
  main();
} catch (error) {
  console.error(`\n打包安装失败：${error.message}`);
  process.exitCode = 1;
}
