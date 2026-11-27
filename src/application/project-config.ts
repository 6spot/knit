import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { arr, bool, int, nullable, obj, opt, str, type Static } from "@earendil-works/pi-schema";
import { schemaProblems } from "../contracts/primitives.js";
import { WORKFLOW_CONFIG_PATH } from "../contracts/workflow.js";
import { PITFALLS_PATH, recordPitfall } from "../domain/pitfalls.js";
import { BUILTIN_STANDARDS, builtinPath, parseStandard, standardReference, STANDARDS_DIR, type Standard } from "../domain/standards.js";
import { parseWorkflow, type WorkflowDefinition } from "../domain/workflow.js";
import { atomicWrite, readWithVersion } from "../infrastructure/fs.js";
import { safeJoin } from "../infrastructure/paths.js";
import { withFileLock } from "../infrastructure/process.js";

export const CONFIG_PATH = ".knit/config.json";
export const DEFAULT_RUNTIME_RETAIN_DAYS = 14;

/** 字段都可以不写；不认识的字段算问题，写错字段名时能马上发现。 */
const ConfigFileSchema = obj({
  handoff: opt(obj({ fileBytes: opt(int({ minimum: 1 })), totalBytes: opt(int({ minimum: 1 })) })),
  runtime: opt(obj({ retainDays: opt(nullable(int({ minimum: 0 }))) })),
  worktree: opt(obj({ setup: opt(arr(str({ pattern: "\\S" }))), setupTimeoutSeconds: opt(nullable(int({ minimum: 1 }))), autoMerge: opt(bool()) })),
});

/** 按内容的 UTF-8 字节数算，不算块外面的标记行。 */
export interface HandoffLimits {
  /** 点名的资料、计划、每份报告，单独一块的上限。 */
  readonly fileBytes: number;
  /** 一次交接合计的上限；角色文件、规范和需求部分计入合计，但任何时候都全文给。 */
  readonly totalBytes: number;
}

export const DEFAULT_HANDOFF_LIMITS: HandoffLimits = { fileBytes: 16384, totalBytes: 65536 };

export interface ProjectConfig {
  readonly handoff: HandoffLimits;
  readonly runtime?: { readonly retainDays?: number | null };
  readonly worktree?: { readonly setup?: readonly string[]; readonly setupTimeoutSeconds?: number | null; readonly autoMerge?: boolean };
}

export interface ConfigLoadResult {
  /** 有问题时是 null。 */
  readonly config: ProjectConfig | null;
  /** 一处一句，每句以配置文件的路径开头。 */
  readonly problems: readonly string[];
}

/** 文件不存在时是全部缺省值，没有问题。 */
export function loadConfig(root: string): ConfigLoadResult {
  const file = join(root, CONFIG_PATH);
  if (!existsSync(file)) return { config: { handoff: DEFAULT_HANDOFF_LIMITS }, problems: [] };
  const raw = parseJson(readFileSync(file, "utf8"));
  if (raw instanceof SyntaxError) {
    return { config: null, problems: [`${CONFIG_PATH}：不是合法的 JSON：${raw.message}`] };
  }
  const problems = schemaProblems(ConfigFileSchema, raw);
  if (problems.length > 0) {
    return { config: null, problems: problems.map((problem) => `${CONFIG_PATH}：${problem}`) };
  }
  const config = raw as Static<typeof ConfigFileSchema>;
  return {
    config: {
      handoff: { ...DEFAULT_HANDOFF_LIMITS, ...config.handoff },
      ...(config.runtime === undefined ? {} : { runtime: config.runtime }),
      ...(config.worktree === undefined ? {} : { worktree: config.worktree }),
    },
    problems: [],
  };
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) return error;
    throw error;
  }
}

export function readWorkflow(root: string): {
  readonly workflow: WorkflowDefinition | null;
  readonly problems: readonly string[];
} {
  const file = join(root, WORKFLOW_CONFIG_PATH);
  if (!existsSync(file)) return { workflow: null, problems: [`${WORKFLOW_CONFIG_PATH} 不存在；运行 knit init 生成`] };
  const loaded = parseWorkflow(readFileSync(file, "utf8"));
  return { workflow: loaded.workflow, problems: loaded.validation.issues.map((issue) => issue.message) };
}

export { STANDARDS_DIR };

const builtinDirectory = new URL("../../assets/standards/", import.meta.url);

/** 内置规范来自运行中的安装包。两组各按路径排序，项目中的旧副本不参与注入。 */
export function loadStandards(root: string): Standard[] {
  const builtin = BUILTIN_STANDARDS.map((file) =>
    parseStandard(builtinPath(file), readFileSync(new URL(file, builtinDirectory), "utf8")));
  const dir = join(root, STANDARDS_DIR);
  if (!existsSync(dir)) return builtin;
  const project = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((path) => standardReference(path) === path)
    .sort()
    .map((path) => parseStandard(path, readFileSync(join(root, path), "utf8")));
  return [...builtin, ...project];
}

/** 旧版 init 的文件保留给项目核对、迁出定制。 */
export function legacyStandardCopies(root: string): string[] {
  return BUILTIN_STANDARDS.map((name) => `${STANDARDS_DIR}/${name}`).filter((path) => existsSync(join(root, path)));
}

export function savePitfall(root: string, scope: string, title: string, detail: string): void {
  const path = safeJoin(root, PITFALLS_PATH);
  withFileLock(join(root, ".knit/.runtime/locks/pitfalls.lock"), 5000, () => {
    const current = readWithVersion(path);
    const original = current?.data.toString("utf8") ?? "";
    const standard = parseStandard(PITFALLS_PATH, original);
    if (standard.problems.length) throw new Error(standard.problems.join("\n"));
    const updated = recordPitfall(original, scope, title, detail);
    if (updated !== original) atomicWrite({ path, data: Buffer.from(updated), expectedSha256: current?.sha256 ?? null, mode: 0o644 });
  }, () => { throw new Error("避坑清单正在写入，请重试"); });
}
