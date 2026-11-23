import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sha256Text } from "../contracts/digest.js";
import { WORKFLOW_CONFIG_PATH } from "../contracts/workflow.js";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import { withRunLock } from "./run-lock.js";
import { buildSessionContext } from "./session-context.js";
import { contextLines } from "./session-output.js";
import { checkHostCommand } from "./host-command.js";
import { toolEffects, workGuidance, workQuestion, workTurn, type WorkMessage } from "./work-choice.js";
import { createTask, readTask, type NewTask } from "./task-store.js";
import { shellQuote } from "../infrastructure/process.js";

export { checkHostCommand } from "./host-command.js";

export interface HostSession {
  host: string;
  sessionId: string;
}

interface SessionState {
  taskId: string | null;
  lastDigest: string | null;
  draft?: { choice: string; id: string; file: string };
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

function readState(path: string): SessionState {
  const file = readWithVersion(path);
  return file === null ? { taskId: null, lastDigest: null } : JSON.parse(file.data.toString());
}

export function createSessionDraft(root: string, session: HostSession, choice: string, input: NewTask) {
  return withSession(root, session, (path) => {
    const state = readState(path);
    if (state.draft?.choice === choice) {
      const found = readTask(root, state.draft.id);
      if (found.kind === "refused") return { created: null, problems: found.problems };
      return { created: { id: state.draft.id, file: join(found.task.stored.dir, "task.md") }, problems: [],
        title: found.task.document.frontmatter.title, status: found.task.document.frontmatter.status, selected: state.taskId === state.draft.id };
    }
    const result = createTask(root, input);
    if (result.created) saveState(path, { ...state, draft: { choice, ...result.created } });
    return result;
  });
}

export function selectHostTask(root: string, session: HostSession, taskId: string | null): readonly string[] {
  if (taskId !== null) {
    const loaded = readTask(root, taskId);
    if (loaded.kind === "refused") return loaded.problems;
  }
  withSession(root, session, (path) => saveState(path, { ...readState(path), taskId, lastDigest: null }));
  return [];
}

export async function checkSessionTool(root: string | null, session: HostSession | null, name: string, input: Record<string, unknown>,
  command: string | undefined, transcript: () => WorkMessage[], environment: Partial<Record<"select" | "start", string>> = {}, selected?: string | null) {
  const effects = toolEffects(name, input);
  const initialized = root !== null && existsSync(join(root, WORKFLOW_CONFIG_PATH));
  const checked = command === undefined ? { command, reason: null } : await checkHostCommand(command,
    () => transcript().filter((message) => message.role === "user").map((message) => message.text), {
      ...environment,
      draft: () => initialized && session ? `KNIT_HOST=${shellQuote(session.host)} KNIT_HOST_SESSION=${shellQuote(session.sessionId)} KNIT_DRAFT_CHOICE=${workTurn(transcript()).key}` : undefined,
    }, initialized ? effects : undefined);
  if (checked.reason || !initialized || !effects.length) return { ...checked, draftChoice: undefined };
  const turn = workTurn(transcript());
  const state = session ? withSession(root, session, readState) : null;
  const id = selected === undefined ? state?.taskId : selected;
  const loaded = id ? readTask(root, id) : null;
  const task = loaded?.kind === "loaded" ? loaded.task.document.frontmatter : null;
  return { command: checked.command, reason: workQuestion(root, effects, turn, task, state?.draft?.choice === turn.key ? state.draft : undefined),
    draftChoice: effects.some((effect) => effect.kind === "draft") ? turn.key : undefined };
}

export function hostContext(dirs: readonly string[], session: HostSession): string | null {
  const root = dirs.map(hostProjectRoot).find((path) => path !== null);
  if (root === undefined) return null;
  return withSession(root, session, (path) => {
    const state = readState(path);
    const text = sessionText(root, state.taskId);
    const lastDigest = sha256Text(text);
    if (lastDigest === state.lastDigest) return null;
    saveState(path, { ...state, lastDigest });
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
  if (taskId === null) lines.push(`没有选中 Knit 任务。${workGuidance} 用 knit task list 查看任务，用 knit context --use <id> 选中任务。`);
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
