import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_SPECS } from "../../contracts/host.js";
import type { ToolCapability } from "../../contracts/workflow.js";
import { findExecutable, gitSync } from "../../infrastructure/process.js";

export const SANDBOX = "/usr/bin/sandbox-exec";
export const COMMAND_TEMP_PREFIX = "knit-agy-exec-";
export const COMMAND_CLIENT = "run-command";
const COMMAND_STOP_TIMEOUT = 5000;
const COMMAND_TRACKER = fileURLToPath(new URL("./command-processes", import.meta.url));
const CUSTOMIZATION_DIR = ".agents";
const COMPAT_CUSTOMIZATION_DIRS = [".agent", "_agents", "_agent"];
const CUSTOMIZATION_DIRS = [CUSTOMIZATION_DIR, ...COMPAT_CUSTOMIZATION_DIRS];
export const HOOKS = join(CUSTOMIZATION_DIR, "hooks.json");
const WORKSPACE_PLUGINS = join(CUSTOMIZATION_DIR, "plugins");
const KNIT_PLUGIN = join(WORKSPACE_PLUGINS, "knit");
const TEXT_SOURCES = new Set(["skills", "skills.json", "workflows", "agents", "agents.json", "rules", "rules.json"]);
const SOURCE_NAMES = ["mcp_config.json", "plugins", "plugins.json", "hooks.json", ...TEXT_SOURCES];
const WORKSPACE_EXTERNAL = [
  ...CUSTOMIZATION_DIRS.flatMap((dir) => SOURCE_NAMES.map((name) => join(dir, name))).filter((path) => path !== HOOKS),
  ".gemini/config.json", ".mcp.json",
];
const HOME_EXTERNAL = [
  ...SOURCE_NAMES.map((name) => join(".gemini/config", name)),
  ".gemini/antigravity-cli/skills", ".gemini/skills",
];
const startupSource = (path: string) => !TEXT_SOURCES.has(basename(path));
const WORKSPACE_STARTUP = WORKSPACE_EXTERNAL.filter(startupSource);
const HOME_STARTUP = HOME_EXTERNAL.filter(startupSource);
export const WORKSPACE_CONTROL = [...new Set([
  ".git", ".knit", ...HOST_SPECS.flatMap<string>((host) => host.controlDirs), ...CUSTOMIZATION_DIRS, ".gemini/config.json", ".mcp.json",
])];

export function agyExecutable(): string | null {
  return findExecutable(process.env.KNIT_AGY_BIN ?? "agy");
}

export function permits(tools: readonly ToolCapability[] | null, tool: ToolCapability): boolean {
  return tools === null || tools.includes(tool);
}

// The isolation hook can be missing until startup. Follow existing directory links
// before interpreting `..`, even when the final component does not exist yet.
function diskTarget(path: string, linksLeft = 40): string | null {
  if (existsSync(path)) return realpathSync.native(path);
  if (linksLeft === 0) return null;
  const parent = diskTarget(dirname(path), linksLeft);
  if (parent === null) return null;
  const entry = join(parent, basename(path));
  if (!existsSync(parent) || !lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink()) return entry;
  const target = readlinkSync(entry);
  return diskTarget(isAbsolute(target) ? target : `${parent}${sep}${target}`, linksLeft - 1);
}

function configuredSource(path: string, source = path, directoryConflict?: (names: string[]) => string | undefined): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    if (statSync(path).isDirectory()) {
      const names = readdirSync(path);
      return directoryConflict ? directoryConflict(names) : names.length > 0 ? source : undefined;
    }
    return configuredFile(source, () => readFileSync(path, "utf8")) ? source : undefined;
  } catch {
    return source;
  }
}

function configuredFile(path: string, read: () => string): boolean {
  const name = basename(path);
  if (name !== "mcp_config.json" && name !== ".mcp.json" && name !== "plugins.json") return true;
  try {
    const config: unknown = JSON.parse(read());
    if (config === null || typeof config !== "object") return true;
    const hasEntries = (value: unknown) => value === null || typeof value !== "object" || Object.keys(value).length > 0;
    if (name === "plugins.json") {
      return hasEntries("plugins" in config && Object.keys(config).length === 1 ? config.plugins : config);
    }
    if (Array.isArray(config)) return true;
    if ("mcpServers" in config) return hasEntries(config.mcpServers ?? {});
    return name === ".mcp.json" && hasEntries(config);
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
    const [mode, , oid] = line.slice(0, tab).split(" ");
    return { mode: mode!, oid: oid!, name: line.slice(tab + 1) };
  });
  const trees = new Map([["", existing ? [] : treeEntries(ref)]]);
  const trackedChildren = (parent: string): ReturnType<typeof treeEntries> => {
    const cached = trees.get(parent);
    if (cached !== undefined) return cached;
    const base = dirname(parent);
    // A case-insensitive checkout merges directories whose Git paths differ only in case.
    const children = trackedChildren(base === "." ? "" : base)
      .filter((item) => item.mode === "040000" && samePath(item.name, basename(parent)))
      .flatMap((item) => treeEntries(item.oid));
    trees.set(parent, children);
    return children;
  };
  const trackedChild = (parent: string, name: string) => trackedChildren(parent).find((item) => samePath(item.name, name));
  const directory = diskTarget(cwd) ?? cwd;
  const agents = join(directory, CUSTOMIZATION_DIR);
  const custom = existing ? lstatSync(agents, { throwIfNoEntry: false }) : undefined;
  const trackedAgents = trackedChild("", CUSTOMIZATION_DIR);
  const hasHook = existing ? custom?.isDirectory() && lstatSync(join(cwd, HOOKS), { throwIfNoEntry: false }) !== undefined :
    trackedAgents?.mode === "040000" && trackedChild(trackedAgents.name, "hooks.json") !== undefined;
  if ((custom !== undefined && !custom.isDirectory()) || (trackedAgents !== undefined && trackedAgents.mode !== "040000") || hasHook) {
    return `Antigravity 无法安装隔离钩子，Worktree 中已有 ${HOOKS} 或 .agents 不是普通目录`;
  }
  const canonicalAgents = custom === undefined ? agents : realpathSync.native(agents);
  const hidesKnitHook = (target: string, source: string) => samePath(target, canonicalAgents) || samePath(target, join(canonicalAgents, "hooks.json")) ||
    (source === KNIT_PLUGIN && inside(target, directory));
  const trackedTarget = (parts: readonly string[], parent = "", linksLeft = 40): string | null => {
    const [name, ...rest] = parts;
    if (name === undefined) return join(directory, parent);
    if (name === "" || name === ".") return trackedTarget(rest, parent, linksLeft);
    if (name === "..") {
      return parent === "" ? trackedDiskTarget(dirname(directory), rest, linksLeft) : trackedTarget(rest, parent.split(sep).slice(0, -1).join(sep), linksLeft);
    }
    const item = trackedChild(parent, name);
    const path = join(parent, item?.name ?? name);
    if (item?.mode === "120000") {
      if (linksLeft === 0) return null;
      const link = gitSync(["cat-file", "blob", item.oid], root).stdout;
      return isAbsolute(link) ? trackedDiskTarget(sep, [...link.split(sep), ...rest], linksLeft - 1)
        : trackedTarget([...link.split(sep), ...rest], parent, linksLeft - 1);
    }
    if (rest.length === 0) return join(directory, path);
    if (item?.mode === "040000" || (item === undefined && samePath(join(directory, path), canonicalAgents))) {
      return trackedTarget(rest, path, linksLeft);
    }
    return null;
  };
  const trackedDiskTarget = (parent: string, parts: readonly string[], linksLeft: number): string | null => {
    if (samePath(parent, directory)) return trackedTarget(parts, "", linksLeft);
    const [name, ...rest] = parts;
    if (name === undefined) return parent;
    const path = join(parent, name);
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) {
      if (linksLeft === 0) return null;
      const link = readlinkSync(path);
      return trackedDiskTarget(isAbsolute(link) ? sep : parent, [...link.split(sep), ...rest], linksLeft - 1);
    }
    if (entry && !entry.isDirectory() && rest.length) return null;
    return trackedDiskTarget(entry ? realpathSync.native(path) : path, rest, linksLeft);
  };
  const workspaceTarget = (path: string) => existing ? join(directory, path) : trackedTarget(path.split(sep));
  const blockedWorkspaceInputs = permits(tools, "external") ? WORKSPACE_STARTUP : WORKSPACE_EXTERNAL;
  const alias = [...COMPAT_CUSTOMIZATION_DIRS, ...blockedWorkspaceInputs, KNIT_PLUGIN].find((path) => {
    if (!existing) {
      const target = trackedTarget(path.split(sep));
      return target !== null && hidesKnitHook(target, path);
    }
    const link = join(directory, path);
    if (!existsSync(dirname(link)) || !statSync(dirname(link)).isDirectory() ||
        !lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
    const target = diskTarget(link);
    if (target === null) return false;
    if (hidesKnitHook(target, path)) return true;
    // The hook may not exist until session startup. Resolve its parent on disk first.
    const upperAgents = join(directory, CUSTOMIZATION_DIR.toUpperCase());
    return basename(target).toLowerCase() === "hooks.json" && dirname(target) === canonicalAgents &&
      existsSync(upperAgents) && realpathSync.native(upperAgents) === canonicalAgents;
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
    const trackedItem = (target: string) => trackedChild(relative(directory, dirname(target)), basename(target));
    const pluginConflict = (names: string[]) => {
      const target = workspaceTarget(KNIT_PLUGIN);
      const directoryEntry = target !== null && (existing || !inside(directory, target)
        ? existsSync(target) && statSync(target).isDirectory() : trackedItem(target)?.mode === "040000");
      // On a case-sensitive volume a separate entry named KNIT must still conflict.
      const knit = directoryEntry ? names.find((name) => name === "knit") ?? names.find((name) => name.toLowerCase() === "knit") : undefined;
      const other = names.find((name) => name !== knit);
      return other === undefined ? undefined : join(WORKSPACE_PLUGINS, other);
    };
    const workspaceSource = (path: string) => {
      const target = workspaceTarget(path);
      if (target === null) return undefined;
      if (existing || !inside(directory, target)) return configuredSource(target, path, path === WORKSPACE_PLUGINS ? pluginConflict : undefined);
      if (samePath(target, directory)) return trackedChildren("").length > 0 ? path : undefined;
      const item = trackedItem(target);
      if (item === undefined) return undefined;
      if (item.mode === "040000") {
        const children = trackedChildren(relative(directory, target));
        if (path !== WORKSPACE_PLUGINS) return children.length > 0 ? path : undefined;
        return pluginConflict(children.map((child) => child.name));
      }
      return !item.mode.startsWith("100") || configuredFile(path, () => gitSync(["cat-file", "blob", item.oid], root).stdout) ? path : undefined;
    };
    for (const path of [...HOME_STARTUP.map((name) => join(homedir(), name)), ...WORKSPACE_STARTUP]) {
      const source = isAbsolute(path) ? configuredSource(path) : workspaceSource(path);
      if (source !== undefined) return `Antigravity 无法隔离已配置的外部工具及其运行时写入：${source}`;
    }
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
  const result = spawnSync(COMMAND_TRACKER, ["stop", scope], { encoding: "utf8", timeout: COMMAND_STOP_TIMEOUT });
  return result.status === 0 ? null : `Antigravity 命令进程回收失败：${result.error?.message ?? (result.stderr?.trim() || result.signal || result.status)}`;
}

export function stopCommandProcessesAsync(scope: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(COMMAND_TRACKER, ["stop", scope], { encoding: "utf8", timeout: COMMAND_STOP_TIMEOUT }, (error, _stdout, stderr) => {
      if (!error) return resolve(null);
      // execFile 超时时只报告 killed，沿用同步回收已有的超时诊断。
      const reason = typeof error.code === "string" ? error.message : error.killed ? `spawnSync ${COMMAND_TRACKER} ETIMEDOUT`
        : stderr.trim() || error.signal || error.code;
      resolve(`Antigravity 命令进程回收失败：${reason}`);
    });
  });
}

export function handoffReadPaths(root: string): string[] {
  return [join(root, ".knit/tasks"), join(root, ".knit/.runtime/runs")];
}

export function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
const protectedPath = (path: string) => existsSync(path) ? [subpath(path), subpath(realpathSync.native(path))] : [subpath(path)];

type SandboxInput = {
  cwd: string; dir: string; paths: readonly string[]; cli?: { home: string; temporary: string; external: boolean }; command?: { socket: string; temporary: string }; network: boolean; write: boolean;
};

export function commandSandboxProfile(input: SandboxInput & { cli?: never; command: { socket: string; temporary: string } }): () => string {
  const paths = new Set<string>();
  const base = sandboxProfile(input, (path) => {
    paths.add(path);
    return [subpath(path)];
  });
  const plugin = join(input.cwd, KNIT_PLUGIN);
  return () => {
    // 真实目标可能在两条命令之间变化；固定规则可复用，链接目标按当前路径保护。
    const linked = Array.from(paths).flatMap((path) => {
      const target = existsSync(path) ? realpathSync.native(path) : path;
      if (target === path) return [];
      return [`(deny file-write* ${subpath(target)})`, ...(path === plugin ? [`(deny file-read-data ${subpath(target)})`] : [])];
    });
    return linked.length ? [base, ...linked].join("\n") : base;
  };
}

export function sandboxProfile(input: SandboxInput, pathRules = protectedPath): string {
  const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
  const state = input.cli === undefined ? [] : [
    ...["annotations", "bin", "brain", "builtin", "cache", "conversations", "crashes", "implicit", "log", "mcp", "persistent_terminals", "presence", "skills"].map((path) => subpath(join(input.cli!.home, ".gemini/antigravity-cli", path))),
    ...["cli.log", "conversation_summaries.db", "conversation_summaries.db-shm", "conversation_summaries.db-wal", "history.jsonl", "installation_id", "jetbox_summaries_proto.pb", "jetski_state.pbtxt"].map((path) => literal(join(input.cli!.home, ".gemini/antigravity-cli", path))),
    subpath(input.cli.temporary), '(literal "/dev/ptmx")', '(regex #"^/dev/ttys[0-9]+$")',
  ];
  const knitPlugin = pathRules(join(input.cwd, KNIT_PLUGIN)).join(" ");
  const controls = [...WORKSPACE_CONTROL, ...input.paths].map((path) => resolve(input.cwd, path)).filter((path) => inside(input.cwd, path));
  const externalInputs = input.cli === undefined ? [] : [
    ...WORKSPACE_EXTERNAL.map((path) => join(input.cwd, path)),
    ...[...HOME_EXTERNAL, ".gemini/config/config.json"].map((path) => join(input.cli!.home, path)),
  ];
  const readable = new Set(input.cli?.external ? externalInputs.filter((path) => !startupSource(path)) : []);
  return [
    "(version 1)", "(allow default)", "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") ${state.join(" ")} ${input.write ? subpath(input.cwd) : ""})`,
    ...(input.command ? [`(allow file-write* ${subpath(input.command.temporary)})`] : []),
    `(deny file-write* ${knitPlugin} ${[...controls, ...readable].flatMap(pathRules).join(" ")})`,
    `(deny file-read-data ${knitPlugin})`,
    "(deny file-link)",
    ...(input.cli === undefined ? [
      `(deny file-read-data ${subpath(input.dir)})`,
      ...(input.command === undefined ? [] : [`(deny network-outbound (remote unix-socket ${literal(input.command.socket)}))`]),
    ] : [
      `(deny file-write* ${literal(join(input.cli.temporary, COMMAND_CLIENT))})`,
      `(deny file-read-data ${externalInputs.filter((path) => !readable.has(path)).flatMap(pathRules).join(" ")})`,
    ]),
    ...(input.network ? [] : ["(deny network*)"]),
  ].join("\n");
}
