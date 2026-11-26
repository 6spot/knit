import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sha256Text } from "../contracts/primitives.js";
import { WORKFLOW_CONFIG_PATH } from "../contracts/workflow.js";
import { atomicWrite, readWithVersion } from "../infrastructure/fs.js";
import { withFileLock } from "../infrastructure/process.js";
import { buildSessionContext, contextBlocks } from "./session-context.js";
import { readTask } from "./task-store.js";

export { checkHostCommand } from "./host-command.js";

export interface HostSession {
  host: string;
  sessionId: string;
}

const blockNames = ["discussion", "status", "supplement", "pitfalls", "guidance"] as const;
type BlockName = (typeof blockNames)[number];

interface SessionState {
  taskId: string | null;
  // 旧会话的整段摘要不能拆分；没有分块摘要时按首次注入处理。
  digests?: Partial<Record<BlockName, string>>;
}

export function hostProjectRoot(dir: string): string | null {
  const path = resolve(dir);
  const knitDir = join(path, ".knit");
  if (statSync(knitDir, { throwIfNoEntry: false })?.isDirectory()) {
    // 用户目录也有 .knit/worktrees，只有初始化过的项目才在这里读取工作流。
    const userStore = path === homedir() || (process.env.KNIT_HOME && resolve(path, process.env.KNIT_HOME) === knitDir);
    if (userStore && existsSync(join(knitDir, "worktrees")) && !existsSync(join(path, WORKFLOW_CONFIG_PATH))) return null;
    return path;
  }
  if (dirname(path) === path || existsSync(join(path, ".git"))) return null;
  return hostProjectRoot(dirname(path));
}

function withSession<T>(root: string, session: HostSession, action: (path: string) => T): T {
  const host = /^[a-z0-9_]{1,64}$/.test(session.host) ? session.host : `~${sha256Text(session.host)}`;
  const id = /^[a-z0-9_-]{1,120}$/.test(session.sessionId) ? session.sessionId : `~${sha256Text(session.sessionId)}`;
  const path = join(root, ".knit/.runtime/host-sessions", `${host}-${id}.json`);
  return withFileLock(`${path}.lock`, 5000, () => action(path), () => { throw new Error("会话状态正忙，请重试"); });
}

function saveState(path: string, state: SessionState) {
  atomicWrite({ path, data: Buffer.from(`${JSON.stringify(state)}\n`) });
}

function readState(path: string): SessionState {
  const file = readWithVersion(path);
  return file === null ? { taskId: null } : JSON.parse(file.data.toString());
}

export function selectHostTask(root: string, session: HostSession, taskId: string | null):
  | { readonly kind: "selected"; readonly title: string | null }
  | { readonly kind: "refused"; readonly problems: readonly string[] } {
  const loaded = taskId === null ? null : readTask(root, taskId);
  if (loaded?.kind === "refused") return loaded;
  withSession(root, session, (path) => {
    const state = readState(path);
    if (state.taskId === taskId) return;
    saveState(path, { taskId, digests: { ...state.digests, status: undefined } });
  });
  return { kind: "selected", title: loaded?.task.document.frontmatter.title ?? null };
}

export function hostContext(dirs: readonly string[], session: HostSession, guidance?: string): string | null {
  const root = dirs.map(hostProjectRoot).find((path) => path !== null);
  if (root === undefined) return null;
  return withSession(root, session, (path) => {
    const state = readState(path);
    const blocks = sessionBlocks(root, state.taskId, guidance);
    const digests = { ...state.digests };
    const changed = blockNames.filter((name) => {
      const text = blocks[name];
      if (text === undefined) return false;
      const digest = sha256Text(text);
      if (digest === digests[name]) return false;
      digests[name] = digest;
      return true;
    });
    if (changed.length === 0) return null;
    saveState(path, { taskId: state.taskId, digests });
    return blockNames.filter((name) => name === "status" || changed.includes(name))
      .map((name) => blocks[name]).filter(Boolean).join("\n\n");
  });
}

function sessionBlocks(root: string, taskId: string | null, guidance: string | undefined): Partial<Record<BlockName, string>> {
  const context = readContext(root, taskId);
  if (context.kind === "refused") {
    const discussion = buildSessionContext(root);
    return {
      discussion: discussion.kind === "context" ? contextBlocks(discussion).discussion : undefined,
      status: [
        `选中的 Knit 任务 ${taskId} 读不出来`, ...context.problems,
        ...(discussion.kind === "refused" ? discussion.problems : []),
      ].join("\n"),
    };
  }
  const blocks = contextBlocks(context);
  return {
    ...blocks,
    status: taskId === null ? "没有选中 Knit 任务。用 knit task list 查看任务，用 knit context --use <id> 选中任务。" : blocks.status,
    guidance,
  };
}

function readContext(root: string, taskId: string | null) {
  try {
    return buildSessionContext(root, taskId ?? undefined);
  } catch (error) {
    if (taskId === null) throw error;
    return { kind: "refused", problems: [String(error)] } as const;
  }
}
