/**
 * HEAD 基线引用与内容去重（写侧）：真实 Git、真实文件与真实 index。
 * 不使用 mock fs；恢复侧（cat-file、GC 失效、v1 兼容、类型变化）在 restore.test.mjs。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotService } from "../dist/application/snapshot.js";
import { RunStore } from "../dist/infrastructure/run-store.js";

const RUNTIME_GITIGNORE = ".knit/.runtime/\n";

let counter = 0;
const nextRunId = () => {
  counter += 1;
  return `run-${counter.toString(16).padStart(12, "0")}`;
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-snapshot-${prefix}-`));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, ".gitignore"), RUNTIME_GITIGNORE);
  return dir;
}

function commitAll(dir, message = "base") {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

function create(dir, runId, options = {}) {
  return new SnapshotService(options).create({ root: dir, runId, ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) });
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function byPath(manifest) {
  return new Map(manifest.entries.map((entry) => [entry.path, entry]));
}

test("HEAD 同内容引用基线：不写副本、source=head、savedBytes 不计入上限", () => {
  const dir = project("same");
  try {
    writeFileSync(join(dir, "README.md"), "# demo\n");
    writeFileSync(join(dir, "data.bin"), Buffer.from([0, 1, 255, 2]));
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(dir, "run.sh"), 0o755);
    symlinkSync("README.md", join(dir, "link"));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "keep.txt"), "keep\n");
    commitAll(dir);

    const runId = nextRunId();
    const result = create(dir, runId);
    assert.equal(result.state, "ready", result.reason ?? "");
    const manifest = result.manifest;
    assert.equal(manifest.schemaVersion, 2);
    const entries = byPath(manifest);
    const snapshotFiles = join(dir, ".knit", ".runtime", "runs", runId, "snapshot", "files");

    for (const path of ["README.md", "data.bin", "run.sh", "nested/keep.txt"]) {
      const entry = entries.get(path);
      assert.equal(entry.source, "head", `${path} 应引用 HEAD 基线`);
      assert.equal(entry.headOid, git(dir, ["rev-parse", `HEAD:${path}`]).trim());
      assert.equal(existsSync(join(snapshotFiles, path)), false, `${path} 不应写副本`);
    }
    assert.equal(entries.get("link").source, "head", "符号链接按目标字节引用基线");
    assert.equal(existsSync(join(snapshotFiles, "link")), false);
    assert.equal(entries.get("run.sh").mode, 0o100755);

    const referencedFileBytes = manifest.entries
      .filter((entry) => entry.source === "head" && entry.kind === "file")
      .reduce((sum, entry) => sum + entry.size, 0);
    // 符号链接的 index 副本在 v1 也会计费，引用后同样计入 savedBytes。
    const referencedSymlinkIndexBytes = manifest.entries
      .filter((entry) => entry.indexSource === "head" && entry.kind === "symlink")
      .reduce((sum, entry) => sum + entry.size, 0);
    assert.equal(manifest.savedBytes, referencedFileBytes + referencedSymlinkIndexBytes);
    assert.equal(manifest.bytes, 0, "全部引用时不产生实际保存字节");
    assert.equal(manifest.savedBytes > 0, true);

    // manifest 落盘后可被 RunStore 按 v2 schema 重新读取。
    const stored = new RunStore(dir).readSnapshot(runId);
    assert.equal(stored.schemaVersion, 2);
    assert.equal(stored.savedBytes, manifest.savedBytes);
  } finally {
    cleanup(dir);
  }
});

test("同内容与改动混合：引用与复制各自正确，未跟踪始终复制", () => {
  const dir = project("mixed");
  try {
    writeFileSync(join(dir, "same.txt"), "same\n");
    writeFileSync(join(dir, "changed.txt"), "base\n");
    commitAll(dir);
    writeFileSync(join(dir, "changed.txt"), "changed-worktree\n");
    writeFileSync(join(dir, "untracked.txt"), "untracked\n");
    symlinkSync("changed.txt", join(dir, "untracked-link"));

    const runId = nextRunId();
    const result = create(dir, runId);
    assert.equal(result.state, "ready", result.reason ?? "");
    const entries = byPath(result.manifest);
    const snapshotDir = join(dir, ".knit", ".runtime", "runs", runId, "snapshot");

    assert.equal(entries.get("same.txt").source, "head");
    assert.equal(existsSync(join(snapshotDir, "files", "same.txt")), false);
    assert.equal(entries.get("changed.txt").source, undefined);
    assert.equal(readFileSync(join(snapshotDir, "files", "changed.txt"), "utf8"), "changed-worktree\n");
    assert.equal(entries.get("untracked.txt").layer, "untracked");
    assert.equal(readFileSync(join(snapshotDir, "files", "untracked.txt"), "utf8"), "untracked\n");
    assert.equal(lstatSync(join(snapshotDir, "files", "untracked-link")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(snapshotDir, "files", "untracked-link")), "changed.txt");

    assert.equal(entries.get("changed.txt").indexSource, "head", "index 仍指向 HEAD blob");
    const changedBytes = Buffer.byteLength("changed-worktree\n");
    const untrackedBytes = Buffer.byteLength("untracked\n");
    assert.equal(result.manifest.bytes, changedBytes + untrackedBytes);
    assert.equal(
      result.manifest.savedBytes,
      Buffer.byteLength("same\n") + Buffer.byteLength(RUNTIME_GITIGNORE) + Buffer.byteLength("base\n"),
    );
  } finally {
    cleanup(dir);
  }
});

test("index 层：与 HEAD 同 blob 引用，不同则复制", () => {
  const dir = project("index");
  try {
    writeFileSync(join(dir, "clean.txt"), "base\n");
    writeFileSync(join(dir, "staged.txt"), "base\n");
    commitAll(dir);
    // clean：index 仍是 HEAD，工作区改成别的 → index 引用基线、工作区复制。
    writeFileSync(join(dir, "clean.txt"), "worktree-clean\n");
    // staged：index 与工作区都是另一份内容 → index 与工作区各存一份。
    writeFileSync(join(dir, "staged.txt"), "staged-only\n");
    git(dir, ["add", "staged.txt"]);
    writeFileSync(join(dir, "staged.txt"), "worktree-staged\n");

    const runId = nextRunId();
    const result = create(dir, runId);
    assert.equal(result.state, "ready", result.reason ?? "");
    const entries = byPath(result.manifest);
    const snapshotDir = join(dir, ".knit", ".runtime", "runs", runId, "snapshot");

    const clean = entries.get("clean.txt");
    assert.equal(clean.indexSource, "head");
    assert.equal(clean.indexHeadOid, git(dir, ["rev-parse", "HEAD:clean.txt"]).trim());
    assert.equal(clean.indexOid, clean.indexHeadOid);
    assert.equal(existsSync(join(snapshotDir, "index", "clean.txt")), false);
    assert.equal(readFileSync(join(snapshotDir, "files", "clean.txt"), "utf8"), "worktree-clean\n");

    const staged = entries.get("staged.txt");
    assert.equal(staged.indexSource, undefined, "暂存内容不等于 HEAD 时不引用");
    assert.equal(readFileSync(join(snapshotDir, "index", "staged.txt"), "utf8"), "staged-only\n");
    assert.equal(readFileSync(join(snapshotDir, "files", "staged.txt"), "utf8"), "worktree-staged\n");
    assert.notEqual(staged.indexOid, git(dir, ["rev-parse", "HEAD:staged.txt"]).trim());
    // 引用省略的 index 字节计入 savedBytes。
    assert.equal(
      result.manifest.savedBytes,
      Buffer.byteLength("base\n") + Buffer.byteLength(RUNTIME_GITIGNORE),
    );
  } finally {
    cleanup(dir);
  }
});

test("maxBytes 下 HEAD 同内容不计费；未引用的大文件仍超限失败", () => {
  const dir = project("limit");
  try {
    writeFileSync(join(dir, "big.txt"), "x".repeat(4096));
    writeFileSync(join(dir, "small.txt"), "small\n");
    commitAll(dir);

    const referenced = create(dir, nextRunId(), { maxBytes: 100 });
    assert.equal(referenced.state, "ready", "HEAD 同内容引用不计入上限");
    assert.equal(referenced.manifest.bytes, 0);
    assert.equal(referenced.manifest.savedBytes >= 4096, true);
    const bigEntry = byPath(referenced.manifest).get("big.txt");
    assert.equal(bigEntry.source, "head");
    assert.equal(existsSync(join(referenced.directory, "files", "big.txt")), false);

    writeFileSync(join(dir, "big.txt"), "y".repeat(4096));
    const tooLarge = create(dir, nextRunId(), { maxBytes: 100 });
    assert.equal(tooLarge.state, "failed");
    assert.equal(tooLarge.manifest.reason, "snapshot_too_large");
  } finally {
    cleanup(dir);
  }
});

test("未知较新版本 manifest（v3）：重建快照报 version_conflict 且不删除／覆盖原文件", () => {
  const dir = project("v3");
  try {
    writeFileSync(join(dir, "README.md"), "# demo\n");
    commitAll(dir);
    const runId = nextRunId();
    assert.equal(create(dir, runId).state, "ready", "初始快照应 ready");

    const snapshotDir = join(dir, ".knit", ".runtime", "runs", runId, "snapshot");
    const manifestPath = join(snapshotDir, "manifest.json");
    const newer = JSON.parse(readFileSync(manifestPath, "utf8"));
    newer.schemaVersion = 3;
    newer.addedInLaterVersion = { note: "future format" };
    writeFileSync(manifestPath, JSON.stringify(newer, null, 2) + "\n");
    const original = readFileSync(manifestPath);
    const store = new RunStore(dir);

    assert.throws(
      () => create(dir, runId),
      (error) => {
        assert.equal(error.code, "version_conflict");
        assert.equal(error.details.found, 3);
        assert.equal(error.details.expected, 2);
        assert.match(error.details.path, /snapshot[/\\]manifest\.json$/);
        return true;
      },
      "未知较新版本不得降级为重新快照",
    );
    assert.deepEqual(readFileSync(manifestPath), original, "原 manifest 字节必须不变");
    assert.equal(existsSync(join(snapshotDir, "files")), true, "原快照目录不得被删除");

    assert.throws(() => store.readSnapshot(runId), (error) => error.code === "version_conflict");
    const candidate = { ...JSON.parse(original.toString("utf8")), schemaVersion: 2 };
    delete candidate.addedInLaterVersion;
    assert.throws(
      () => store.writeSnapshotManifest(runId, candidate),
      (error) => error.code === "version_conflict",
      "写入路径同样拒绝覆盖较新版本",
    );
    assert.deepEqual(readFileSync(manifestPath), original, "写入失败后原字节仍不变");
  } finally {
    cleanup(dir);
  }
});

test("损坏 manifest 维持 io_error：结构不符、缺 schemaVersion 与非法 JSON 都不算格式演进", () => {
  const dir = project("corrupt");
  try {
    writeFileSync(join(dir, "README.md"), "# demo\n");
    commitAll(dir);
    const runId = nextRunId();
    assert.equal(create(dir, runId).state, "ready");
    const store = new RunStore(dir);
    const manifestPath = join(dir, ".knit", ".runtime", "runs", runId, "snapshot", "manifest.json");

    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 2, runId }, null, 2) + "\n");
    assert.throws(
      () => store.readSnapshot(runId),
      (error) => error.code === "io_error",
      "已知 schemaVersion 但结构不符按损坏处理",
    );

    writeFileSync(manifestPath, JSON.stringify({ runId }, null, 2) + "\n");
    assert.throws(
      () => store.readSnapshot(runId),
      (error) => error.code === "io_error",
      "缺 schemaVersion 不猜测旧版",
    );

    writeFileSync(manifestPath, "{ not json\n");
    assert.throws(
      () => store.readSnapshot(runId),
      (error) => error.code === "io_error",
      "非法 JSON 仍是 io_error",
    );
  } finally {
    cleanup(dir);
  }
});
