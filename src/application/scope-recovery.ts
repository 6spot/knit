/** 历史成果复核：核对既有实施来源与当前提交，不把复核记成实际写入。 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { ImplementationFileSchema, type ImplementationFile } from "../contracts/implementation.js";
import { checkSchema } from "../contracts/schema.js";
import type { ScopeFile } from "../contracts/run.js";
import { inspectSealed } from "../infrastructure/credential-seal.js";
import { sha256Bytes } from "../infrastructure/fingerprint.js";
import { safeJoin } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import { gitSync } from "../infrastructure/process.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { GuardError } from "./guard-error.js";
import { currentEntry, scopeDigest, scopeEntriesCurrent, type ScopeEntry } from "./scope.js";
import { RunActivityService } from "./run-activity.js";

export interface ScopeRecoveryInput {
  branch: string;
  commit: string;
  paths: string[];
  /** 原本机签名实施记录的只读备份；HMAC 仍绑定原项目、任务和凭据种类。 */
  implementationFile?: string;
}

export async function recoveredScope(input: ScopeRecoveryInput & {
  root: string; taskId: string; scope: ScopeFile; store: MetadataStore; now: string;
}): Promise<ScopeFile> {
  const { root, taskId, scope, store } = input;
  if (typeof input.branch !== "string" || typeof input.commit !== "string" || !Array.isArray(input.paths) ||
      input.paths.some(path => typeof path !== "string") ||
      (input.implementationFile !== undefined && typeof input.implementationFile !== "string")) {
    throw new GuardError("invalid_request", "复核需要 branch、完整 commit、paths 数组与可选实施记录路径");
  }
  if (!(await new RunActivityService({ store }).settled(root, taskId))) {
    throw new GuardError("runs_unsettled", "复核前须收敛全部运行和接收结果");
  }
  const git = (args: string[]): string => {
    const result = gitSync(args, root);
    if (result.code !== 0) throw new GuardError("recovery_source_invalid", result.stderr.trim() || "提交来源不可核验");
    return result.stdout.trim();
  };
  if (!/^refs\/heads\/.+/.test(input.branch) || git(["symbolic-ref", "HEAD"]) !== input.branch) {
    throw new GuardError("branch_mismatch", "复核分支必须是当前检出的完整本地分支");
  }
  if (!/^[0-9a-f]{40,64}$/.test(input.commit)) throw new GuardError("recovery_source_invalid", "来源须为完整提交对象 ID");
  const commit = git(["rev-parse", "--verify", `${input.commit}^{commit}`]);
  if (commit !== input.commit || gitSync(["merge-base", "--is-ancestor", commit, input.branch], root).code !== 0) {
    throw new GuardError("recovery_source_invalid", "来源提交不属于当前分支历史");
  }
  const paths = [...new Set(input.paths)];
  if (paths.length === 0 || paths.length !== input.paths.length) throw new GuardError("invalid_request", "复核路径须非空且无重复");
  const runs = new RunStore(root);
  let implementation: ImplementationFile | null = runs.readImplementation(taskId);
  let implementationPath = implementation === null ? undefined : join(root, ".knit/.runtime/implementations", `${taskId}.json`);
  let implementationSource: string | null = implementationPath === undefined ? null : sha256Bytes(readFileSync(implementationPath));
  if (input.implementationFile !== undefined) {
    const bytes = readFileSync(input.implementationFile);
    const inspected = inspectSealed(root, "implementation", taskId, JSON.parse(bytes.toString("utf8")));
    if (inspected.verdict !== "valid") throw new GuardError(inspected.verdict, "原实施记录签名不可核验");
    if (!checkSchema(ImplementationFileSchema, inspected.payload)) throw new GuardError("recovery_source_invalid", "原实施记录结构无效");
    implementation = inspected.payload as ImplementationFile;
    implementationSource = sha256Bytes(bytes);
    implementationPath = realpathSync(input.implementationFile);
  }
  if (implementation !== null && implementation.taskId !== taskId) throw new GuardError("recovery_source_invalid", "实施记录不属于本任务");
  const originals = new Map<string, ScopeEntry>(scope.entries.map(entry => [entry.path, entry]));
  for (const entry of implementation?.entries ?? []) if (!originals.has(entry.path)) originals.set(entry.path, entry);
  if (originals.size === 0) throw new GuardError("implementation_missing", "没有可恢复的既有成果范围");

  // 既有 scope 的实施来源须为同任务、已完成且已接收的真实结果；不接受任意路径声明。
  const sourced = new Set(implementation?.entries.map(entry => entry.path) ?? []);
  for (const recovery of scope.recoveries ?? []) {
    if (recovery.implementationSource !== null) for (const entry of recovery.after) sourced.add(entry.path);
  }
  for (const runId of scope.runIds) {
    const request = runs.readRequest(runId);
    const result = runs.readResult(runId);
    if (request?.taskId !== taskId || result?.taskId !== taskId || result.state !== "completed" ||
        (await store.operations.get(request.acceptanceOperationId))?.state !== "completed") {
      throw new GuardError("recovery_source_invalid", `实施来源未完成或未接收: ${runId}`);
    }
    for (const path of result.actualChangedPaths) sourced.add(path);
  }
  const validated = new Map<string, ScopeEntry>();
  for (const path of paths) {
    if (!originals.has(path) || !sourced.has(path)) throw new GuardError("recovery_path_unknown", `不是有来源的既有成果路径: ${path}`);
    safeJoin(root, path);
    const full = join(root, path);
    if (path.startsWith(".knit/") || path.startsWith(".git/") || path !== path.replaceAll("\\", "/") || path.split("/").some(part => part === ".." || part === "." || part === "")) {
      throw new GuardError("invalid_request", `复核路径无效: ${path}`);
    }
    let ancestor = dirname(full);
    while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
    if (realpathSync(ancestor) !== ancestor) throw new GuardError("recovery_source_invalid", `路径经过符号链接: ${path}`);
    const current = currentEntry(root, path, { factsKind: true });
    const tree = git(["ls-tree", "-z", commit, "--", path]);
    if (current.absent) {
      if (tree !== "") throw new GuardError("recovery_content_mismatch", `提交与本机缺失状态不同: ${path}`);
    } else {
      if (current.factsKind !== "file") throw new GuardError("recovery_source_invalid", `复核需要普通文件或已提交的删除路径: ${path}`);
      const bytes = readFileSync(full);
      if (sha256Bytes(bytes) !== current.digest) throw new GuardError("recovery_content_mismatch", `核验期间文件变化: ${path}`);
      const oid = createHash(commit.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      const mode = (parseInt(current.mode ?? "0", 8) & 0o100) !== 0 ? "100755" : "100644";
      if (tree !== `${mode} blob ${oid}\t${path}\0`) throw new GuardError("recovery_content_mismatch", `提交与本机内容或模式不同: ${path}`);
    }
    validated.set(path, current);
  }
  const before = paths.map(path => originals.get(path)!);
  const after = paths.map(path => validated.get(path)!);
  if (!scopeEntriesCurrent(root, after)) throw new GuardError("recovery_content_mismatch", "核验期间成果变化，未发布恢复范围");
  for (const entry of after) originals.set(entry.path, entry);
  const entries = [...originals.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { ...scope, entries, digest: scopeDigest(entries), updatedAt: input.now,
    recoveries: [...(scope.recoveries ?? []), { branch: input.branch, commit, recordedAt: input.now,
      previousDigest: scope.digest, implementationSource,
      ...(implementationPath === undefined ? {} : { implementationPath }), before, after }] };
}
