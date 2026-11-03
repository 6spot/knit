/**
 * 任务规划资料：plan.md／design.md／research/（DESIGN §3.4–3.6，任务044契约、045实现）。
 * task.md 仍是业务状态唯一权威；规划资料经本模块统一读写，覆盖创建、读取、保存、
 * 冻结快照、路径变化重定位与归档后阅读。要求性内容变化走 task update（等同输入更新），
 * 本模块只保存非需求性内容与记录需求引用版本。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join, relative, sep } from "node:path";
import { InfrastructureError } from "../infrastructure/errors.js";
import { GuardError } from "./guard-error.js";
import { normalizeRoot, safeJoin } from "../infrastructure/paths.js";
import { locateTaskDocument } from "./task-service.js";
import { sha256Text } from "../contracts/digest.js";

const TASKS_DIR = "tasks";
export const PLAN_FILE = "plan.md";
export const DESIGN_FILE = "design.md";
export const RESEARCH_DIR = "research";
const ALLOWED_TOP_LEVEL = new Set([PLAN_FILE, DESIGN_FILE]);
const MATERIAL_EXTENSIONS = [".md"];

/** 规划资料路径约束：任务目录内、白名单顶层或 research/ 下、Markdown。 */
export function normalizeMaterialPath(relativePath: string): string {
  const normalized = relativePath.replace(/^\.\//, "").split("\\").join("/");
  if (normalized.includes("\0") || normalized.includes("..")) {
    throw new GuardError("path_escape", `任务资料路径不得越界: ${relativePath}`);
  }
  const top = normalized.split("/")[0];
  if (top !== PLAN_FILE && top !== DESIGN_FILE && top !== RESEARCH_DIR) {
    throw new GuardError("invalid_request", `任务资料仅支持 ${PLAN_FILE}、${DESIGN_FILE} 与 ${RESEARCH_DIR}/: ${relativePath}`);
  }
  if (top === RESEARCH_DIR) {
    const rest = normalized.slice(RESEARCH_DIR.length + 1);
    if (rest === "" || rest.endsWith("/")) {
      throw new GuardError("invalid_request", `research 路径须指向文件: ${relativePath}`);
    }
  } else if (normalized !== top) {
    throw new GuardError("invalid_request", `${top} 是单文件，不接受子路径: ${relativePath}`);
  }
  if (!MATERIAL_EXTENSIONS.some((ext) => normalized.endsWith(ext))) {
    throw new GuardError("invalid_request", `任务资料仅支持 Markdown: ${relativePath}`);
  }
  return normalized;
}

export interface TaskMaterialFile {
  path: string;
  exists: boolean;
  digest: string | null;
  bytes: number | null;
  content: string | null;
}

export interface TaskMaterialEntry {
  path: string;
  digest: string | null;
  bytes: number | null;
}

export interface TaskMaterialsSnapshot {
  taskId: string;
  taskDir: string;
  files: TaskMaterialEntry[];
  digest: string;
}

function materialPaths(dir: string): string[] {
  const paths: string[] = [];
  for (const top of [PLAN_FILE, DESIGN_FILE]) {
    if (existsSync(join(dir, top))) paths.push(top);
  }
  const researchDir = join(dir, RESEARCH_DIR);
  if (existsSync(researchDir)) {
    const walk = (base: string, prefix: string): void => {
      for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(base, entry.name);
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(full, rel);
        else if (entry.isFile() && MATERIAL_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) paths.push(`${RESEARCH_DIR}/${rel}`);
      }
    };
    walk(researchDir, "");
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

function safeTaskDir(root: string, taskId: string): { dir: string; archived: boolean } {
  const located = locateTaskDocument(root, taskId);
  return { dir: located.dir, archived: located.archived };
}

function entryOf(dir: string, path: string): TaskMaterialEntry {
  const full = join(dir, path);
  if (!existsSync(full)) return { path, digest: null, bytes: null };
  const content = readFileSync(full, "utf8");
  return { path, digest: sha256Text(content), bytes: Buffer.byteLength(content, "utf8") };
}

/** 列出任务现有规划资料；不创建文件。 */
export function listTaskMaterials(root: string, taskId: string): TaskMaterialEntry[] {
  const resolved = normalizeRoot(root);
  const { dir } = safeTaskDir(resolved, taskId);
  return materialPaths(dir).map((path) => entryOf(dir, path));
}

/** 读取单个规划资料；缺失返回 exists=false，不抛错。 */
export function readTaskMaterial(root: string, taskId: string, relativePath: string): TaskMaterialFile {
  const resolved = normalizeRoot(root);
  const normalized = normalizeMaterialPath(relativePath);
  const { dir } = safeTaskDir(resolved, taskId);
  const full = safeJoin(dir, normalized);
  if (!existsSync(full)) return { path: normalized, exists: false, digest: null, bytes: null, content: null };
  const content = readFileSync(full, "utf8");
  return { path: normalized, exists: true, digest: sha256Text(content), bytes: Buffer.byteLength(content, "utf8"), content };
}

/**
 * 保存规划资料（创建或整体覆盖）。这是进度／方案更新的权威入口：
 * 要求性内容变化须走 task update --kind，调用方不得借本入口改需求。
 * expectDigest 提供乐观版本核对：不匹配报 version_conflict，不覆盖并发修改。
 */
export function saveTaskMaterial(
  root: string,
  taskId: string,
  input: { path: string; content: string; expectDigest?: string | null },
): { path: string; digest: string; created: boolean } {
  const resolved = normalizeRoot(root);
  const normalized = normalizeMaterialPath(input.path);
  const { dir } = safeTaskDir(resolved, taskId);
  const full = safeJoin(dir, normalized);
  const exists = existsSync(full);
  let previousDigest: string | null = null;
  if (exists) {
    const previous = readFileSync(full, "utf8");
    previousDigest = sha256Text(previous);
    if (input.expectDigest !== undefined && input.expectDigest !== previousDigest) {
      throw new InfrastructureError("version_conflict", `任务资料已被并发修改，按当前版本重新合并: ${normalized}`);
    }
  } else if (input.expectDigest !== undefined && input.expectDigest !== null) {
    throw new InfrastructureError("version_conflict", `任务资料不存在，与预期版本不符: ${normalized}`);
  }
  ensureDir(dirname(full));
  writeFileSync(full, input.content, "utf8");
  return { path: normalized, digest: sha256Text(readFileSync(full, "utf8")), created: !exists };
}

/** 删除研究文档等可重建资料；plan／design 不提供删除（历史证据），由任务归档整体处理。 */
export function deleteTaskMaterial(root: string, taskId: string, relativePath: string): { removed: boolean } {
  const resolved = normalizeRoot(root);
  const normalized = normalizeMaterialPath(relativePath);
  if (!normalized.startsWith(`${RESEARCH_DIR}/`)) {
    throw new GuardError("invalid_request", `仅 research/ 下的资料可单独删除: ${normalized}`);
  }
  const { dir } = safeTaskDir(resolved, taskId);
  const full = safeJoin(dir, normalized);
  if (!existsSync(full)) return { removed: false };
  rmSync(full);
  return { removed: true };
}

/**
 * 规划资料冻结快照：供 run 冻结与恢复核对（任务046使用）。
 * 只含当前存在的文件；空任务返回空列表与稳定摘要。
 */
export function snapshotTaskMaterials(root: string, taskId: string): TaskMaterialsSnapshot {
  const resolved = normalizeRoot(root);
  const { dir, archived } = safeTaskDir(resolved, taskId);
  const files = materialPaths(dir).map((path) => entryOf(dir, path));
  const digest = sha256Text(files.map((file) => `${file.path}\0${file.digest ?? "absent"}`).join("\n") || "empty");
  void archived;
  return { taskId, taskDir: relative(resolved, dir).split(sep).join("/"), files, digest };
}

/** research/ 资料的入口摘要：标题与首段，不整文注入（DESIGN §3.4 按需读取，任务046）。 */
export function researchDigestSummary(path: string, content: string): string {
  const lines = content.split(/\r?\n/);
  const title = lines.find((line) => line.startsWith("#")) ?? `# ${path}`;
  const body = lines.filter((line) => !line.startsWith("#") && line.trim() !== "").slice(0, 6);
  return [title, "", ...body, "", `（入口摘要；全文按需读取：.knit/tasks/…/${path}）`].join("\n");
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o755 });
}

