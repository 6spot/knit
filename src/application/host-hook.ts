import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sha256Text } from "../contracts/digest.js";
import { WORKFLOW_CONFIG_PATH } from "../contracts/workflow.js";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import { withRunLock } from "./run-lock.js";
import { buildSessionContext } from "./session-context.js";
import { contextLines } from "./session-output.js";
import { readTask } from "./task-store.js";

export { checkHostCommand } from "./host-command.js";

export interface HostSession {
  host: string;
  sessionId: string;
}

interface SessionState {
  taskId: string | null;
  lastDigest: string | null;
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
  return withRunLock(`${path}.lock`, 5000, () => action(path), () => { throw new Error("会话状态正忙，请重试"); });
}

function saveState(path: string, state: SessionState) {
  atomicWrite({ path, data: Buffer.from(`${JSON.stringify(state)}\n`) });
}

export function selectHostTask(root: string, session: HostSession, taskId: string | null): readonly string[] {
  if (taskId !== null) {
    const loaded = readTask(root, taskId);
    if (loaded.kind === "refused") return loaded.problems;
  }
  withSession(root, session, (path) => saveState(path, { taskId, lastDigest: null }));
  return [];
}

export function hostContext(dirs: readonly string[], session: HostSession): string | null {
  const root = dirs.map(hostProjectRoot).find((path) => path !== null);
  if (root === undefined) return null;
  return withSession(root, session, (path) => {
    const file = readWithVersion(path);
    const state: SessionState = file === null ? { taskId: null, lastDigest: null } : JSON.parse(file.data.toString());
    const text = sessionText(root, state.taskId);
    const lastDigest = sha256Text(text);
    if (lastDigest === state.lastDigest) return null;
    saveState(path, { taskId: state.taskId, lastDigest });
    return text;
  });
}

function sessionText(root: string, taskId: string | null): string {
  const context = readContext(root, taskId);
  if (context.kind === "refused") {
    const discussion = buildSessionContext(root);
    const lines = discussion.kind === "context" ? contextLines(discussion) : discussion.problems;
    return [...lines, `选中的 Knit 任务 ${taskId} 读不出来`, ...context.problems].join("\n");
  }
  const lines = contextLines(context);
  if (taskId === null) lines.push("没有选中 Knit 任务。可以直接讨论需求，用 knit task list 查看任务，用 knit context --use <id> 选中任务。");
  return lines.join("\n");
}

function readContext(root: string, taskId: string | null) {
  try {
    return buildSessionContext(root, taskId ?? undefined);
  } catch (error) {
    if (taskId === null) throw error;
    return { kind: "refused", problems: [String(error)] } as const;
  }
}
