/**
 * 非正式只读检查（DESIGN.md 第4.1节）：显式 --scope，不建 Task 绑定、不赋交付资格。
 * 直接启动一次只读 Pi 检查会话；不经过 worker、不写 Task／binding／scope／check 凭据。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { Value } from "typebox/value";
import { StageReportSchema, type StageReport } from "../contracts/run.js";
import { PiAgentRuntime, isolatedEnv } from "../adapters/pi/runtime.js";
import { parseStageReport } from "./stage.js";
import { worktreeSignature, type WorktreeSignature } from "./worktree.js";
import { safeJoin, normalizeRoot } from "../infrastructure/paths.js";
import { sha256Bytes } from "../infrastructure/fingerprint.js";
import { atomicWrite } from "../infrastructure/atomic.js";
import { GuardError } from "./guard-error.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { formalStandardFiles } from "./standards.js";
import type { PhaseModel } from "./model-selection.js";

const MAX_FILES = 200;
const MAX_BYTES = 512 * 1024;

export interface InformalCheckResult {
  checkId: string;
  state: "completed" | "failed" | "cancelled";
  scope: string[];
  report: StageReport | null;
  reportSummary: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  sessionFile: string | null;
  failureReason: string | null;
  recordedAt: string;
}

interface ScopedFile {
  path: string;
  content: string;
  bytes: number;
}

function expandScope(root: string, scope: string[]): { files: ScopedFile[]; absent: string[] } {
  const files: ScopedFile[] = [];
  const absent: string[] = [];
  let total = 0;
  const addFile = (relativePath: string): void => {
    const full = safeJoin(root, relativePath);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      absent.push(relativePath);
      return;
    }
    if (!stats.isFile()) return;
    if (relativePath === ".knit/.runtime" || relativePath.startsWith(".knit/.runtime/")) return;
    const content = readFileSync(full, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    if (files.length >= MAX_FILES || total + bytes > MAX_BYTES) {
      throw new GuardError("scope_too_large", `非正式检查范围超过 ${MAX_FILES} 个文件或 ${MAX_BYTES} 字节`);
    }
    total += bytes;
    files.push({ path: relativePath, content, bytes });
  };
  const walk = (relativePath: string): void => {
    const full = safeJoin(root, relativePath);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      absent.push(relativePath);
      return;
    }
    if (stats.isFile()) {
      addFile(relativePath);
      return;
    }
    if (!stats.isDirectory()) return;
    if (relativePath === ".git" || relativePath.startsWith(".git/") || relativePath === ".knit/.runtime" || relativePath.startsWith(".knit/.runtime/")) return;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".knit" && relativePath === "") continue;
      walk(relativePath === "." ? entry.name : `${relativePath}/${entry.name}`);
    }
  };
  for (const item of scope) walk(item);
  const unique = new Map(files.map((file) => [file.path, file]));
  return { files: [...unique.values()].sort((a, b) => a.path.localeCompare(b.path)), absent: [...new Set(absent)].sort() };
}

function scopeFingerprint(root: string, paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const path of paths.sort()) {
    try {
      const stats = statSync(safeJoin(root, path));
      result[path] = stats.isFile() ? `file:${sha256Bytes(readFileSync(safeJoin(root, path)))}` : "dir";
    } catch {
      result[path] = "absent";
    }
  }
  return result;
}

function standardsText(root: string): string {
  const parts: string[] = [];
  try {
    const workflow = readFileSync(join(root, ".knit", "workflow.md"), "utf8");
    parts.push(`# 工作流\n${workflow}`);
  } catch {
    // 无工作流。
  }
  for (const file of formalStandardFiles(root)) {
    try {
      parts.push(`# 正式规范 ${file.path}\n${readFileSync(join(root, file.path), "utf8")}`);
    } catch {
      // 跳过不可读规范。
    }
  }
  return parts.join("\n\n");
}

function buildPrompt(input: { scope: string[]; files: ScopedFile[]; absent: string[]; standards: string }): { system: string; user: string } {
  const system = [
    "你是 Knit 的非正式独立检查者，只读核对显式范围。",
    "不要修改任何文件，不要 git commit／push／rebase，不要推进 Task 或创建绑定。",
    "用工具读取实际内容；只报告可核实的事实。",
    '最终输出一个 fenced JSON 报告：{"summary":"...","verdict":"pass|changes_requested|blocked","coverage":["路径或条件"],"findings":["..."],"unverified":["..."]}',
    input.standards,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  const fileText = input.files.map((file) => `## ${file.path}\n\`\`\`\n${file.content}\n\`\`\``).join("\n\n");
  const user = [
    "显式检查范围：",
    input.scope.join("\n"),
    input.absent.length > 0 ? `范围内不存在：\n${input.absent.join("\n")}` : "",
    "范围内容：",
    fileText || "（无文件内容）",
    "请核对范围与相关正式规范，给出 verdict 和 coverage。",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  return { system, user };
}

export async function runInformalCheck(input: {
  dir: string;
  scope: string[];
  model: PhaseModel;
  locksRoot?: string;
}): Promise<InformalCheckResult> {
  const root = normalizeRoot(input.dir);
  if (input.model.runtime !== "pi") throw new GuardError("runtime_unsupported", `非正式检查只支持 pi，收到 ${input.model.runtime}`);
  const scope = [...new Set(input.scope)].sort();
  const expanded = expandScope(root, scope);
  const beforeWorktree = worktreeSignature(root);
  const beforeScope = scopeFingerprint(root, expanded.files.map((file) => file.path));
  const prompt = buildPrompt({ scope, files: expanded.files, absent: expanded.absent, standards: standardsText(root) });
  const checkId = `chk-${randomBytes(6).toString("hex")}`;
  const recordedAt = new Date().toISOString();
  const sessionDir = join(root, ".knit", ".runtime", "sessions");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const runtime = new PiAgentRuntime({
    executablePath: process.env.KNIT_PI_BIN ?? "pi",
    provider: input.model.provider,
    modelId: input.model.model,
    tools: ["read", "grep", "find", "ls", "bash"],
    cwd: root,
    sessionDir,
    sessionName: `Knit informal check ${checkId}`,
    appendSystemPrompt: prompt.system,
    env: isolatedEnv(),
  });
  let result: InformalCheckResult;
  try {
    const started = await runtime.start();
    if (!started.ok) {
      result = {
        checkId,
        state: "failed",
        scope,
        report: null,
        reportSummary: null,
        usage: { inputTokens: null, outputTokens: null },
        sessionFile: started.sessionFile,
        failureReason: started.failure ?? "start_failed",
        recordedAt,
      };
    } else {
      const before = await runtime.getStats().catch(() => null);
      const settled = await runtime.prompt(prompt.user);
      const text = await runtime.getLastAssistantText().catch(() => "");
      const after = await runtime.getStats().catch(() => null);
      const parsed = parseStageReport(text);
      const report = parsed.report;
      const afterWorktree = worktreeSignature(root);
      const afterScope = scopeFingerprint(root, expanded.files.map((file) => file.path));
      let failureReason: string | null = null;
      if (!settled.settled) failureReason = "not_settled";
      else if (parsed.error !== null || report === null || !Value.Check(StageReportSchema, report)) failureReason = "report_invalid";
      else if (afterWorktree !== null && beforeWorktree !== null && afterWorktree.digest !== beforeWorktree.digest) failureReason = "check_side_effect";
      else if (JSON.stringify(afterScope) !== JSON.stringify(beforeScope)) failureReason = "check_scope_changed";
      const usage = usageDelta(before, after);
      result = {
        checkId,
        state: failureReason === null ? "completed" : "failed",
        scope,
        report,
        reportSummary: report?.summary ?? null,
        usage,
        sessionFile: runtime.sessionFile,
        failureReason,
        recordedAt,
      };
    }
  } catch (error) {
    result = {
      checkId,
      state: "failed",
      scope,
      report: null,
      reportSummary: null,
      usage: { inputTokens: null, outputTokens: null },
      sessionFile: runtime.sessionFile,
      failureReason: error instanceof InfrastructureError ? error.code : error instanceof Error ? error.message : "check_error",
      recordedAt,
    };
  } finally {
    await runtime.dispose().catch(() => undefined);
  }
  const path = join(root, ".knit", ".runtime", "informal-checks", `${checkId}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWrite({ path, data: Buffer.from(JSON.stringify(result, null, 2) + "\n", "utf8"), expectedSha256: null, mode: 0o600 });
  return result;
}

function usageDelta(before: Record<string, unknown> | null, after: Record<string, unknown> | null): { inputTokens: number | null; outputTokens: number | null } {
  const token = (value: Record<string, unknown> | null, key: string): number | null => {
    if (value === null || typeof value.tokens !== "object" || value.tokens === null) return null;
    const item = (value.tokens as Record<string, unknown>)[key];
    return typeof item === "number" ? item : null;
  };
  const delta = (key: string): number | null => {
    const a = token(before, key);
    const b = token(after, key);
    return a === null || b === null ? null : Math.max(0, b - a);
  };
  return { inputTokens: delta("input"), outputTokens: delta("output") };
}
