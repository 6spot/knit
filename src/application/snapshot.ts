/**
 * 实施前快照（DESIGN.md 第5.6节；M1 基本完整，逐路径恢复强化归 016）。
 * 保存 tracked 工作区与 index 层、未忽略 untracked、模式与指纹、缺失路径。
 * 覆盖不完整或超限时 manifest 置 failed，不能当作 ready。
 *
 * HEAD 基线去重：tracked 文件／符号链接的内容若与 `HEAD:<path>` 的 blob 字节完全一致
 * （git blob SHA-1 相同），只记 `source:"head"` 与 `headOid`，不写 files/ 副本；
 * index blob 与 HEAD 树 OID 相同时记 `indexSource:"head"` 与 `indexHeadOid`。
 * 引用按记录时的 OID 恢复，不依赖恢复时的 HEAD。约束：快照只引用 Git 对象，
 * 这些 blob 被 GC／prune 清除后恢复必须报 snapshot_baseline_unavailable；
 * 不得在仍需恢复的快照上执行 reflog expire／gc --prune=now。本任务不自动 GC。
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { SnapshotEntry, SnapshotManifest } from "../contracts/run.js";
import { sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";
import { gitBufferSync, gitSync } from "../infrastructure/process.js";
import { RunStore } from "../infrastructure/run-store.js";
import { normalizeRoot } from "../infrastructure/paths.js";

/**
 * 快照内容总量上限（实际写入快照目录的 tracked 工作区内容＋与工作区不同的 index blob＋
 * 未忽略 untracked 文件），不是单文件上限；引用 HEAD 基线的字节不计费，记入 savedBytes。
 * 超出即 snapshot_too_large，不悄悄降级。
 */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const RUNTIME_PREFIX = ".knit/.runtime/";

export type GitRunner = (args: string[], cwd: string) => { code: number; stdout: string; stderr: string };

export interface SnapshotServiceOptions {
  git?: GitRunner;
  /** 读取 index blob 的原始字节；生产默认 git cat-file。 */
  gitBuffer?: (args: string[], cwd: string) => { code: number; stdout: Buffer; stderr: string };
  now?: () => Date;
  randomHex?: (bytes: number) => string;
}

export interface SnapshotResult {
  state: "ready" | "failed";
  reason: string | null;
  manifest: SnapshotManifest;
  directory: string;
}

interface IndexEntry {
  mode: number;
  oid: string;
  path: string;
}

interface HeadEntry {
  mode: number;
  kind: "file" | "symlink" | "submodule";
  oid: string;
}

/** git blob 对象 ID：`sha1("blob " + len + "\0" + bytes)`，与工作区／index 字节直接比较。 */
function gitBlobSha1(data: Buffer): string {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

function headKind(mode: number): HeadEntry["kind"] {
  if (mode === 0o120000) return "symlink";
  if (mode === 0o160000) return "submodule";
  return "file";
}

/** `git ls-tree -r -z HEAD`：路径 → 基线 blob。解析失败或路径异常时保守地不引用基线。 */
function parseHeadTree(stdout: string): Map<string, HeadEntry> {
  const result = new Map<string, HeadEntry>();
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [rawMode, type, oid] = record.slice(0, tab).split(" ");
    if (rawMode === undefined || type === undefined || oid === undefined) continue;
    if (type !== "blob" && type !== "commit") continue;
    const mode = Number.parseInt(rawMode, 8);
    result.set(record.slice(tab + 1), { mode, kind: headKind(mode), oid });
  }
  return result;
}

function parseIndex(stdout: string): { entries: IndexEntry[]; unmerged: boolean } {
  const entries: IndexEntry[] = [];
  let unmerged = false;
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    if (mode === undefined || oid === undefined || stage === undefined) continue;
    if (stage !== "0") unmerged = true;
    entries.push({ mode: Number.parseInt(mode, 8), oid, path: record.slice(tab + 1) });
  }
  return { entries, unmerged };
}

function splitZ(stdout: string): string[] {
  return stdout.split("\0").filter((item) => item !== "");
}

function modeOf(kind: "file" | "symlink", executable: boolean): number {
  if (kind === "symlink") return 0o120000;
  return executable ? 0o100755 : 0o100644;
}

export class SnapshotService {
  private readonly git: GitRunner;
  private readonly gitBuffer: (args: string[], cwd: string) => { code: number; stdout: Buffer; stderr: string };
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;

  constructor(options: SnapshotServiceOptions = {}) {
    this.git = options.git ?? ((args, cwd) => gitSync(args, cwd));
    this.gitBuffer = options.gitBuffer ?? ((args, cwd) => gitBufferSync(args, cwd));
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes) => randomBytes(bytes).toString("hex"));
  }

  /** 幂等：已有 ready 快照直接返回；failed 或半成品重建。 */
  create(input: { root: string; runId: string; maxBytes?: number }): SnapshotResult {
    const root = normalizeRoot(input.root);
    const store = new RunStore(root);
    const runDir = store.runDir(input.runId);
    const target = join(runDir, "snapshot");
    const existing = store.readSnapshot(input.runId);
    if (existing !== null && existing.state === "ready") {
      return { state: "ready", reason: null, manifest: existing, directory: target };
    }
    rmSync(target, { recursive: true, force: true });
    // 回收上次中断残留的临时目录：快照创建持有项目执行占用，同 run 不会有并发构建。
    try {
      for (const stale of readdirSync(runDir)) {
        if (stale.startsWith("snapshot.tmp-")) {
          rmSync(join(runDir, stale), { recursive: true, force: true });
        }
      }
    } catch {
      // run 目录尚未创建时无残留可清。
    }
    const tmp = join(runDir, `snapshot.tmp-${this.randomHex(6)}`);
    mkdirSync(join(tmp, "files"), { recursive: true, mode: 0o700 });
    chmodSync(tmp, 0o700);
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
    const createdAt = this.now().toISOString();

    const finish = (state: "ready" | "failed", reason: string | null, manifest: Omit<SnapshotManifest, "state" | "reason" | "createdAt" | "runId" | "schemaVersion" | "maxBytes" | "digest"> & { digest?: string }): SnapshotResult => {
      const base = {
        schemaVersion: 2 as const,
        runId: input.runId,
        state,
        createdAt,
        maxBytes,
        ...manifest,
      };
      const digest = manifest.digest ?? sha256Text(JSON.stringify(base));
      const final: SnapshotManifest = { ...base, digest, reason };
      store.writeSnapshotManifest(input.runId, final, tmp);
      if (state === "ready") {
        renameSync(tmp, target);
      } else {
        // 失败也保留 manifest 与已复制证据，供诊断；不产生 ready 目录。
        rmSync(target, { recursive: true, force: true });
        renameSync(tmp, target);
      }
      return { state, reason, manifest: final, directory: target };
    };

    const head = this.git(["rev-parse", "--verify", "HEAD"], root);
    const branch = this.git(["symbolic-ref", "--short", "-q", "HEAD"], root);
    const baseAbsent = head.code !== 0;
    const baseHead = head.code === 0 ? head.stdout.trim() : null;
    // 一次读取 HEAD 树作为基线映射；无 HEAD 或读取失败时只做全量副本（保守降级，不影响可恢复性）。
    let headTree = new Map<string, HeadEntry>();
    if (!baseAbsent) {
      const tree = this.git(["ls-tree", "-r", "-z", "HEAD"], root);
      if (tree.code === 0) headTree = parseHeadTree(tree.stdout);
    }

    const index = this.git(["ls-files", "-s", "-z"], root);
    if (index.code !== 0) {
      return finish("failed", "snapshot_unknown", {
        base: { head: baseHead, branch: branch.code === 0 ? branch.stdout.trim() : null, absent: baseAbsent },
        coverage: { tracked: false, index: false, untracked: false, worktree: false },
        entries: [],
        counts: { tracked: 0, untracked: 0, absent: 0 },
        bytes: 0,
      });
    }
    const parsedIndex = parseIndex(index.stdout);
    if (parsedIndex.unmerged) {
      return finish("failed", "snapshot_unmerged_index", {
        base: { head: baseHead, branch: branch.code === 0 ? branch.stdout.trim() : null, absent: baseAbsent },
        coverage: { tracked: false, index: false, untracked: false, worktree: false },
        entries: [],
        counts: { tracked: 0, untracked: 0, absent: 0 },
        bytes: 0,
      });
    }
    const untracked = this.git(["ls-files", "--others", "--exclude-standard", "-z"], root);
    const untrackedPaths = untracked.code === 0 ? splitZ(untracked.stdout).filter((path) => !path.startsWith(RUNTIME_PREFIX)) : [];

    const entries: SnapshotEntry[] = [];
    const indexBytes = new Map<string, Buffer>();
    const indexOids = new Map<string, string>();
    let bytes = 0;
    let savedBytes = 0;
    let worktreeOk = true;
    const sortedIndex = [...parsedIndex.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const item of sortedIndex) {
      if (item.path.startsWith(RUNTIME_PREFIX)) continue;
      if (item.mode !== 0o160000) {
        const blob = this.gitBuffer(["cat-file", "blob", item.oid], root);
        if (blob.code !== 0) {
          return finish("failed", "snapshot_index_unknown", {
            base: { head: baseHead, branch: branch.code === 0 ? branch.stdout.trim() : null, absent: baseAbsent },
            coverage: { tracked: false, index: false, untracked: false, worktree: false },
            entries: [],
            counts: { tracked: 0, untracked: 0, absent: 0 },
            bytes,
          });
        }
        indexBytes.set(item.path, blob.stdout);
        indexOids.set(item.path, item.oid);
      }
    }
    for (const item of sortedIndex) {
      if (item.path.startsWith(RUNTIME_PREFIX)) continue;
      const absolute = join(root, item.path);
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch {
        entries.push({
          path: item.path,
          layer: "tracked",
          kind: "file",
          mode: item.mode,
          size: null,
          digest: null,
          linkTarget: null,
          absent: true,
          indexOid: item.oid,
        });
        continue;
      }
      if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(absolute);
        const data = Buffer.from(linkTarget, "utf8");
        const digest = sha256Text(linkTarget);
        const base = headTree.get(item.path);
        const referenced = base !== undefined && base.kind === "symlink" && gitBlobSha1(data) === base.oid;
        if (referenced) {
          // 符号链接原本不按内容字节计费，引用只省略副本，不增加 savedBytes。
          entries.push({ path: item.path, layer: "tracked", kind: "symlink", mode: 0o120000, size: stat.size, digest, linkTarget, absent: false, indexOid: item.oid, source: "head", headOid: base.oid });
        } else {
          this.copySymlink(tmp, item.path, linkTarget);
          entries.push({ path: item.path, layer: "tracked", kind: "symlink", mode: 0o120000, size: stat.size, digest, linkTarget, absent: false, indexOid: item.oid });
        }
      } else if (stat.isFile()) {
        const data = readFileSync(absolute);
        const digest = sha256Bytes(data);
        const base = headTree.get(item.path);
        const referenced = base !== undefined && base.kind === "file" && gitBlobSha1(data) === base.oid;
        if (referenced) {
          savedBytes += data.length;
          entries.push({ path: item.path, layer: "tracked", kind: "file", mode: modeOf("file", (stat.mode & 0o111) !== 0), size: stat.size, digest, linkTarget: null, absent: false, indexOid: item.oid, source: "head", headOid: base.oid });
        } else {
          bytes += data.length;
          if (bytes > maxBytes) {
            return finish("failed", "snapshot_too_large", {
              base: { head: baseHead, branch: branch.code === 0 ? branch.stdout.trim() : null, absent: baseAbsent },
              coverage: { tracked: true, index: true, untracked: untracked.code === 0, worktree: true },
              entries,
              counts: { tracked: entries.length, untracked: 0, absent: entries.filter((entry) => entry.absent).length },
              bytes,
              savedBytes,
            });
          }
          this.copyFile(tmp, item.path, data);
          entries.push({ path: item.path, layer: "tracked", kind: "file", mode: modeOf("file", (stat.mode & 0o111) !== 0), size: stat.size, digest, linkTarget: null, absent: false, indexOid: item.oid });
        }
      } else if (stat.isDirectory()) {
        entries.push({ path: item.path, layer: "tracked", kind: "submodule", mode: 0o160000, size: null, digest: null, linkTarget: null, absent: false, indexOid: item.oid });
      } else {
        worktreeOk = false;
      }
    }

    // 索引层内容独立保存：工作区版本与 index 可能不同；恢复 --index 必须能核对原字节。
    for (const entry of entries) {
      if (entry.layer !== "tracked" || entry.kind === "submodule") {
        entry.indexDigest = null;
        continue;
      }
      const bytesForIndex = indexBytes.get(entry.path);
      if (bytesForIndex === undefined) {
        entry.indexDigest = null;
        continue;
      }
      const indexDigest = sha256Bytes(bytesForIndex);
      entry.indexDigest = indexDigest;
      const indexOid = indexOids.get(entry.path);
      const base = headTree.get(entry.path);
      if (base !== undefined && base.kind !== "submodule" && indexOid !== undefined && base.oid === indexOid) {
        // index blob 与 HEAD 树对象相同：按 OID 引用，不写 index/ 副本。
        entry.indexSource = "head";
        entry.indexHeadOid = indexOid;
        // 与工作区副本同字节时旧实现也不另存 index；否则这些字节本应计入 bytes。
        if (!(indexDigest === entry.digest && entry.kind === "file")) savedBytes += bytesForIndex.length;
        continue;
      }
      if (indexDigest === entry.digest && entry.kind === "file") continue;
      bytes += bytesForIndex.length;
      if (bytes > maxBytes) {
        return finish("failed", "snapshot_too_large", {
          base: { head: baseHead, branch: branch.code === 0 ? branch.stdout.trim() : null, absent: baseAbsent },
          coverage: { tracked: true, index: true, untracked: false, worktree: false },
          entries,
          counts: { tracked: entries.length, untracked: 0, absent: entries.filter((item) => item.absent).length },
          bytes,
          savedBytes,
        });
      }
      this.copyIndexFile(tmp, entry.path, bytesForIndex);
    }

    const untrackedEntries: SnapshotEntry[] = [];
    for (const path of untrackedPaths) {
      const absolute = join(root, path);
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch {
        worktreeOk = false;
        continue;
      }
      if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(absolute);
        this.copySymlink(tmp, path, linkTarget);
        untrackedEntries.push({ path, layer: "untracked", kind: "symlink", mode: 0o120000, size: stat.size, digest: sha256Text(linkTarget), linkTarget, absent: false, indexOid: null, indexDigest: null });
      } else if (stat.isFile()) {
        const data = readFileSync(absolute);
        bytes += data.length;
        if (bytes > maxBytes) {
          return finish("failed", "snapshot_too_large", {
            base: { head: baseHead, branch: branch.code === 0 ? branch.stdout.trim() : null, absent: baseAbsent },
            coverage: { tracked: true, index: true, untracked: true, worktree: true },
            entries: [...entries, ...untrackedEntries],
            counts: { tracked: entries.length, untracked: untrackedEntries.length, absent: entries.filter((entry) => entry.absent).length },
            bytes,
            savedBytes,
          });
        }
        this.copyFile(tmp, path, data);
        untrackedEntries.push({ path, layer: "untracked", kind: "file", mode: modeOf("file", (stat.mode & 0o111) !== 0), size: stat.size, digest: sha256Bytes(data), linkTarget: null, absent: false, indexOid: null, indexDigest: null });
      }
    }

    const all = [...entries, ...untrackedEntries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const coverage = {
      tracked: true,
      index: true,
      untracked: untracked.code === 0,
      worktree: worktreeOk,
    };
    const reason = coverage.untracked && coverage.worktree ? null : "snapshot_unknown";
    return finish(reason === null ? "ready" : "failed", reason, {
      base: { head: baseHead, branch: branch.code === 0 ? branch.stdout.trim() : null, absent: baseAbsent },
      coverage,
      entries: all,
      counts: { tracked: entries.length, untracked: untrackedEntries.length, absent: entries.filter((entry) => entry.absent).length },
      bytes,
      savedBytes,
      digest: sha256Text(
        JSON.stringify({
          base: baseHead,
          index: sortedIndex.map((entry) => `${entry.mode} ${entry.oid} ${entry.path}`),
          entries: all,
        }),
      ),
    });
  }

  private copyFile(tmp: string, path: string, data: Buffer): void {
    const destination = join(tmp, "files", path);
    mkdirSync(join(destination, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(destination, data, { mode: 0o600 });
  }

  private copySymlink(tmp: string, path: string, target: string): void {
    const destination = join(tmp, "files", path);
    mkdirSync(join(destination, ".."), { recursive: true, mode: 0o700 });
    if (existsSync(destination)) rmSync(destination, { force: true });
    symlinkSync(target, destination);
  }

  private copyIndexFile(tmp: string, path: string, data: Buffer): void {
    const destination = join(tmp, "index", path);
    mkdirSync(join(destination, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(destination, data, { mode: 0o600 });
  }
}
