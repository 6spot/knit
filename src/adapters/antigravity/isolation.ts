import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCapability } from "../../contracts/workflow.js";
import { gitSync } from "../../infrastructure/process.js";

export const SANDBOX = "/usr/bin/sandbox-exec";
export const COMMAND_TEMP_PREFIX = "knit-agy-exec-";
export const COMMAND_CLIENT = "run-command";
const COMMAND_TRACKER = fileURLToPath(new URL("./command-processes", import.meta.url));
const CUSTOMIZATION_DIR = ".agents";
const COMPAT_CUSTOMIZATION_DIRS = [".agent", "_agents", "_agent"];
const CUSTOMIZATION_DIRS = [CUSTOMIZATION_DIR, ...COMPAT_CUSTOMIZATION_DIRS];
export const HOOKS = join(CUSTOMIZATION_DIR, "hooks.json");
const SOURCE_NAMES = ["mcp_config.json", "plugins", "plugins.json", "skills", "skills.json", "workflows", "agents", "agents.json", "rules", "rules.json", "hooks.json"];
const WORKSPACE_EXTERNAL = [
  ...CUSTOMIZATION_DIRS.flatMap((dir) => SOURCE_NAMES.map((name) => join(dir, name))).filter((path) => path !== HOOKS),
  ".gemini/config.json", ".mcp.json",
];
const HOME_EXTERNAL = [
  ...SOURCE_NAMES.map((name) => join(".gemini/config", name)),
  ".gemini/antigravity-cli/skills", ".gemini/skills",
];
export const WORKSPACE_CONTROL = [".git", ".knit", ".pi", ...CUSTOMIZATION_DIRS, ".gemini/config.json", ".mcp.json"];

export function agyExecutable(): string | null {
  const name = process.env.KNIT_AGY_BIN ?? "agy";
  return (name.includes(sep) ? [resolve(name)] : (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, name)))
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
      } catch { return false; }
    }) ?? null;
}

export function permits(tools: readonly ToolCapability[] | null, tool: ToolCapability): boolean {
  return tools === null || tools.includes(tool);
}

function configured(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    if (statSync(path).isDirectory()) return readdirSync(path).length > 0;
    if (!path.endsWith("/mcp_config.json")) return true;
    return Object.keys(JSON.parse(readFileSync(path, "utf8")).mcpServers ?? {}).length > 0;
  } catch {
    return true;
  }
}

export function agyPreflight(root: string, cwd: string, branch: string, tools: readonly ToolCapability[] | null): string | null {
  if (process.platform !== "darwin" || !existsSync(SANDBOX)) return "Antigravity 缺少 macOS sandbox-exec，无法限制工具写入和联网";
  const executable = agyExecutable();
  if (executable === null) return "找不到 Antigravity CLI（agy）";
  const version = spawnSync(SANDBOX, ["-p", '(version 1)(allow default)(deny file-write*)(deny network*)', executable, "--version"], { encoding: "utf8", timeout: 5000 });
  if (version.status !== 0 || version.stdout.trim() !== "1.5.13") {
    return `Antigravity 需要经过隔离验证的 agy 1.5.13 和可用的 sandbox-exec（${version.error?.message ?? (version.stderr?.trim() || version.stdout?.trim() || "无法启动")}）`;
  }
  const existing = existsSync(join(cwd, ".git"));
  const ref = gitSync(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root).code === 0 ? `refs/heads/${branch}` : "HEAD";
  const ignoreCase = !existing && gitSync(["config", "--type=bool", "--get", "core.ignoreCase"], root).stdout.trim() === "true";
  const samePath = (a: string, b: string) => ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
  const treeEntries = (tree: string) => gitSync(["ls-tree", "-z", tree], root).stdout.split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    return { mode: line.slice(0, 6), name: line.slice(tab + 1) };
  });
  const tracked = existing ? [] : treeEntries(ref);
  const entry = (path: string) => tracked.find((item) => samePath(item.name, path));
  const has = (path: string) => {
    if (existing) return lstatSync(join(cwd, path), { throwIfNoEntry: false }) !== undefined;
    if (!ignoreCase) return gitSync(["cat-file", "-e", `${ref}:${path}`], root).code === 0;
    const top = entry(path.split(sep, 1)[0]!);
    if (!top) return false;
    if (!path.includes(sep)) return true;
    return top.mode === "040000" && treeEntries(`${ref}:${top.name}`).some((item) => samePath(item.name, basename(path)));
  };
  const directory = existing ? realpathSync.native(cwd) : cwd;
  const agents = join(directory, CUSTOMIZATION_DIR);
  const custom = existing ? lstatSync(agents, { throwIfNoEntry: false }) : undefined;
  const trackedAgents = entry(CUSTOMIZATION_DIR);
  if ((custom !== undefined && !custom.isDirectory()) || (trackedAgents !== undefined && trackedAgents.mode !== "040000") || has(HOOKS)) {
    return `Antigravity 无法安装隔离钩子，Worktree 中已有 ${HOOKS} 或 .agents 不是普通目录`;
  }
  const trees = new Map([["", tracked]]);
  const trackedChildren = (parent: string) => {
    const cached = trees.get(parent);
    if (cached !== undefined) return cached;
    const children = treeEntries(`${ref}:${parent}`);
    trees.set(parent, children);
    return children;
  };
  const canonicalAgents = custom === undefined ? agents : realpathSync.native(agents);
  const hidesKnitHook = (path: string) => samePath(path, canonicalAgents) || samePath(path, join(canonicalAgents, "hooks.json"));
  const trackedAliasToHook = (parts: readonly string[], parent = "", linksLeft = 40): boolean => {
    const [name, ...rest] = parts;
    if (name === undefined) return hidesKnitHook(join(directory, parent));
    if (name === "" || name === ".") return trackedAliasToHook(rest, parent, linksLeft);
    if (name === "..") return parent !== "" && trackedAliasToHook(rest, parent.split(sep).slice(0, -1).join(sep), linksLeft);
    const item = trackedChildren(parent).find((entry) => samePath(entry.name, name));
    const path = join(parent, item?.name ?? name);
    if (item?.mode === "120000") {
      if (linksLeft === 0) return false;
      const link = gitSync(["cat-file", "blob", `${ref}:${path}`], root).stdout;
      if (!isAbsolute(link)) return trackedAliasToHook([...link.split(sep), ...rest], parent, linksLeft - 1);
      return inside(directory, link) && trackedAliasToHook([...relative(directory, link).split(sep), ...rest], "", linksLeft - 1);
    }
    if (item?.mode === "040000" || (item === undefined && samePath(join(directory, path), canonicalAgents))) {
      return trackedAliasToHook(rest, path, linksLeft);
    }
    return item === undefined && rest.length === 0 && hidesKnitHook(join(directory, path));
  };
  const alias = [...COMPAT_CUSTOMIZATION_DIRS, ...WORKSPACE_EXTERNAL].find((path) => {
    if (!existing) return trackedAliasToHook(path.split(sep));
    const link = join(directory, path);
    if (!statSync(dirname(link), { throwIfNoEntry: false })?.isDirectory() ||
        !lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
    const target = resolve(dirname(link), readlinkSync(link));
    return hidesKnitHook(target) || (existsSync(link) && hidesKnitHook(realpathSync.native(link))) ||
      (existsSync(dirname(target)) && hidesKnitHook(join(realpathSync.native(dirname(target)), basename(target))));
  });
  if (alias !== undefined) return `Antigravity 的 ${alias} 指向 ${CUSTOMIZATION_DIR}，无法屏蔽兼容钩子而保留 Knit 隔离钩子`;
  if (permits(tools, "exec")) {
    if (!permits(tools, "read")) return "Antigravity 的通用命令需要 read，命令进程无法关闭文件读取";
    if (!existsSync(COMMAND_TRACKER)) return "Antigravity 缺少 macOS 命令进程跟踪器，无法回收通用命令的子进程";
    const scope = commandScope(`probe-${randomUUID()}`);
    const probe = spawnSync(SANDBOX, ["-p", `(version 1)(allow default)${commandScopeRule(scope)}`, COMMAND_TRACKER, "probe", scope],
      { encoding: "utf8", timeout: 5000 });
    if (probe.status !== 0) return `Antigravity 无法验证 macOS 命令进程跟踪（${probe.error?.message ?? (probe.stderr?.trim() || "沙箱标识不可用")}）`;
  }
  if (permits(tools, "external")) {
    if (!permits(tools, "network")) return "Antigravity 无法在开放 external 时限制外部工具联网";
    const source = HOME_EXTERNAL.map((path) => join(homedir(), path)).find(configured) ??
      WORKSPACE_EXTERNAL.find((path) => existing ? configured(join(cwd, path)) : has(path));
    if (source !== undefined) return `Antigravity 无法隔离已配置的外部工具及其运行时写入：${source}`;
  }
  return null;
}

export function commandScope(temp: string): string {
  return `org.knit.${basename(temp)}`;
}

// Sandbox rules survive exec, reparenting and a change of process group.
export function commandScopeRule(scope: string): string {
  return `(deny mach-lookup (global-name ${JSON.stringify(scope)}))`;
}

export function stopCommandProcesses(scope: string): string | null {
  const result = spawnSync(COMMAND_TRACKER, ["stop", scope], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? null : `Antigravity 命令进程回收失败：${result.error?.message ?? (result.stderr?.trim() || result.signal || result.status)}`;
}

export function handoffReadPaths(root: string): string[] {
  return [join(root, ".knit/tasks"), join(root, ".knit/.runtime/runs")];
}

export function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export function sandboxProfile(input: {
  cwd: string; dir: string; paths: readonly string[]; cli?: { home: string; temporary: string }; command?: { socket: string; temporary: string }; network: boolean; write: boolean;
}): string {
  const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
  const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
  const state = input.cli === undefined ? [] : [
    ...["annotations", "bin", "brain", "builtin", "cache", "conversations", "crashes", "implicit", "log", "mcp", "persistent_terminals", "presence", "skills"].map((path) => subpath(join(input.cli!.home, ".gemini/antigravity-cli", path))),
    ...["cli.log", "conversation_summaries.db", "conversation_summaries.db-shm", "conversation_summaries.db-wal", "history.jsonl", "installation_id", "jetbox_summaries_proto.pb", "jetski_state.pbtxt"].map((path) => literal(join(input.cli!.home, ".gemini/antigravity-cli", path))),
    subpath(input.cli.temporary), '(literal "/dev/ptmx")', '(regex #"^/dev/ttys[0-9]+$")',
  ];
  const protectedPath = (path: string) => existsSync(path) ? [subpath(path), subpath(realpathSync.native(path))] : [subpath(path)];
  const temporaryInputs = input.cli === undefined ? [] : [
    ...WORKSPACE_EXTERNAL.flatMap((path) => protectedPath(join(input.cwd, path))),
    ...[...HOME_EXTERNAL, ".gemini/config/config.json"].flatMap((path) => protectedPath(join(input.cli!.home, path))),
  ];
  return [
    "(version 1)", "(allow default)", "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") ${state.join(" ")} ${input.write ? subpath(input.cwd) : ""})`,
    ...(input.command ? [`(allow file-write* ${subpath(input.command.temporary)})`] : []),
    `(deny file-write* ${[...WORKSPACE_CONTROL, ...input.paths].flatMap((path) => {
      const absolute = resolve(input.cwd, path);
      return inside(input.cwd, absolute) ? protectedPath(absolute) : [];
    }).join(" ")})`,
    "(deny file-link)",
    ...(input.cli === undefined ? [
      `(deny file-read-data ${subpath(input.dir)})`,
      ...(input.command === undefined ? [] : [`(deny network-outbound (remote unix-socket ${literal(input.command.socket)}))`]),
    ] : [
      `(deny file-write* ${literal(join(input.cli.temporary, COMMAND_CLIENT))})`,
      `(deny file-read-data ${temporaryInputs.join(" ")})`,
    ]),
    ...(input.network ? [] : ["(deny network*)"]),
  ].join("\n");
}
