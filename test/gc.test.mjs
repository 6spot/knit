/**
 * 存储回收（gc）：引用核验、只读预览、显式执行与部分完成诊断。
 * 使用真实文件与 SQLite；不调用模型。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { GcService } from "../dist/application/gc.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
let sequence = 0;
const nextRunId = () => {
  sequence += 1;
  return `run-${sequence.toString(16).padStart(12, "0")}`;
};

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-gc-${prefix}-`)));
  mkdirSync(join(dir, ".knit", ".runtime"), { recursive: true, mode: 0o700 });
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function runtimePath(dir, ...parts) {
  return join(dir, ".knit", ".runtime", ...parts);
}

function runPath(dir, runId) {
  return runtimePath(dir, "runs", runId);
}

function makeRun(dir, runId, state, files = {}) {
  const runDir = runPath(dir, runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  if (state !== null) writeFileSync(join(runDir, "state.json"), JSON.stringify({ schemaVersion: 1, runId, state }, null, 2) + "\n");
  for (const [name, content] of Object.entries(files)) {
    const target = join(runDir, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return runDir;
}

function writeTask(dir, relativePath, body) {
  const file = join(dir, ".knit", "tasks", relativePath, "task.md");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`);
}

function taskWithRun(runId) {
  return `## 运行引用\n\n- run: ${runId}\n`;
}

function createIndex(dir, options = {}) {
  const dbPath = runtimePath(dir, "metadata.db");
  const store = new SqliteMetadataStore(dbPath);
  store.close();
  const db = new DatabaseSync(dbPath);
  try {
    for (const session of options.sessions ?? []) {
      db.prepare(
        "INSERT INTO sessions (client, native_session_id, role, record, knit_session_id, kind, task_id, parent_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "pi",
        session.nativeSessionId,
        session.role ?? "implement",
        JSON.stringify({
          knitSessionId: session.knitSessionId ?? "s-aaaaaaaaaaaa",
          ref: { client: "pi", nativeSessionId: session.nativeSessionId, role: session.role ?? "implement" },
          kind: "sub",
          sessionFile: session.sessionFile ?? null,
        }),
        session.knitSessionId ?? "s-aaaaaaaaaaaa",
        "sub",
        null,
        null,
      );
    }
    for (const binding of options.bindings ?? []) {
      db.prepare("INSERT INTO bindings (task_id, record) VALUES (?, ?)").run(binding.id, JSON.stringify(binding.record));
    }
    for (const operation of options.operations ?? []) {
      db.prepare("INSERT INTO operations (operation_id, record) VALUES (?, ?)").run(operation.id, JSON.stringify(operation.record));
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function cliJson(dir, args, locksRoot) {
  const result = spawnSync(process.execPath, [CLI, "--json", ...args, "--dir", dir, "--locks", locksRoot], {
    cwd: dir,
    encoding: "utf8",
  });
  const parsed = result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, parsed };
}

/** 条目与内容摘要：用于断言预览／storage 未改项目文件。 */
function treeFingerprint(dir) {
  const hash = createHash("sha256");
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const path = relative(dir, absolute).split(sep).join("/");
      hash.update(`entry:${path}:${entry.isDirectory() ? "dir" : "file"}\n`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) hash.update(readFileSync(absolute));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

test("a) 中断 snapshot.tmp 目录可预览并在 apply 后清除，被引用 run 主数据完整", () => {
  const dir = project("tmp");
  const locks = join(dir, ".locks");
  try {
    const runId = nextRunId();
    const runDir = makeRun(dir, runId, "completed", { "request.json": '{"runId":"keep"}\n' });
    const tmp = join(runDir, "snapshot.tmp-deadbeef");
    mkdirSync(join(tmp, "files"), { recursive: true });
    writeFileSync(join(tmp, "files", "payload.txt"), "partial\n");
    writeTask(dir, "11-03-referenced", taskWithRun(runId));

    const preview = cliJson(dir, ["gc"], locks);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.parsed.outcome, "completed");
    const tmpCandidate = preview.parsed.data.candidates.find((item) => item.kind === "snapshot-tmp");
    assert.ok(tmpCandidate, JSON.stringify(preview.parsed.data));
    assert.equal(tmpCandidate.path, `.knit/.runtime/runs/${runId}/snapshot.tmp-deadbeef`);
    assert.ok(tmpCandidate.evidence.some((line) => line.includes("snapshot manifest")));
    assert.equal(preview.parsed.data.candidates.some((item) => item.kind === "run"), false, "被任务引用的 run 不是候选");

    const applied = cliJson(dir, ["gc", "--apply"], locks);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.parsed.data.state, "completed");
    assert.equal(existsSync(tmp), false, "临时快照目录应被清除");
    assert.equal(readFileSync(join(runDir, "request.json"), "utf8"), '{"runId":"keep"}\n', "run 主数据保持");
    assert.equal(existsSync(join(runDir, "state.json")), true);
  } finally {
    cleanup(dir);
  }
});

test("b) 被 Session 索引引用的目录保留，孤儿会话目录在 apply 后清除", () => {
  const dir = project("sessions");
  const locks = join(dir, ".locks");
  try {
    const piSessions = runtimePath(dir, "pi-sessions");
    const referenced = join(piSessions, "ref-dir");
    const orphan = join(piSessions, "orphan-dir");
    mkdirSync(referenced, { recursive: true });
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(referenced, "native.jsonl"), '{"type":"session"}\n');
    writeFileSync(join(orphan, "native.jsonl"), '{"type":"session"}\n');
    createIndex(dir, {
      sessions: [{ nativeSessionId: "ref-dir", sessionFile: join(referenced, "native.jsonl") }],
    });

    const preview = cliJson(dir, ["gc"], locks);
    assert.equal(preview.status, 0, preview.stderr);
    const paths = preview.parsed.data.candidates.filter((item) => item.kind === "native-session").map((item) => item.path);
    assert.deepEqual(paths, [".knit/.runtime/pi-sessions/orphan-dir"]);

    const applied = cliJson(dir, ["gc", "--apply"], locks);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(existsSync(referenced), true, "有索引行引用的目录必须保留");
    assert.equal(existsSync(join(referenced, "native.jsonl")), true);
    assert.equal(existsSync(orphan), false, "孤儿会话目录应被清除");
  } finally {
    cleanup(dir);
  }
});

test("c) 活动／归档任务与 metadata 引用的终态 run 保留；无引用终态 run 清除；非终态与未知跳过并报告", () => {
  const dir = project("runs");
  const locks = join(dir, ".locks");
  try {
    const activeRef = nextRunId();
    const archiveRef = nextRunId();
    const bindingRef = nextRunId();
    const operationRef = nextRunId();
    const orphan = nextRunId();
    const activeOrphan = nextRunId();
    const unknownOrphan = nextRunId();
    for (const runId of [activeRef, archiveRef, bindingRef, operationRef, orphan, activeOrphan]) {
      makeRun(dir, runId, "completed", { "result.json": "{}\n" });
    }
    makeRun(dir, activeOrphan, "running");
    makeRun(dir, unknownOrphan, null);
    writeTask(dir, "11-03-active", taskWithRun(activeRef));
    writeTask(dir, "archive/2026-11/11-02-archived", taskWithRun(archiveRef));
    createIndex(dir, {
      bindings: [{ id: "k-aaaaaaaaaaaa", record: { taskId: "k-aaaaaaaaaaaa", lastRunIds: [bindingRef] } }],
      operations: [{ id: "op-aaaaaaaaaaaa", record: { operationId: "op-aaaaaaaaaaaa", kind: "restore", state: "completed", reason: `快照 ${operationRef}` } }],
    });

    const preview = cliJson(dir, ["gc"], locks);
    assert.equal(preview.status, 0, preview.stderr);
    const runCandidates = preview.parsed.data.candidates.filter((item) => item.kind === "run").map((item) => item.path);
    assert.deepEqual(runCandidates, [`.knit/.runtime/runs/${orphan}`]);
    const skippedRuns = preview.parsed.data.skipped.filter((item) => item.kind === "run");
    assert.ok(skippedRuns.some((item) => item.path.endsWith(activeOrphan) && /非终态/.test(item.reason)), JSON.stringify(skippedRuns));
    assert.ok(skippedRuns.some((item) => item.path.endsWith(unknownOrphan) && /不可判定/.test(item.reason)), JSON.stringify(skippedRuns));

    const applied = cliJson(dir, ["gc", "--apply"], locks);
    assert.equal(applied.status, 0, applied.stderr);
    for (const runId of [activeRef, archiveRef, bindingRef, operationRef, activeOrphan, unknownOrphan]) {
      assert.equal(existsSync(runPath(dir, runId)), true, `${runId} 不应被回收`);
    }
    assert.equal(existsSync(runPath(dir, orphan)), false, "无引用终态 run 应被清除");
  } finally {
    cleanup(dir);
  }
});

test("d) 预览与 storage gcCandidates 计数一致，且预览与 storage 均不改项目文件", () => {
  const dir = project("readonly");
  const locks = join(dir, ".locks");
  try {
    const runId = nextRunId();
    const runDir = makeRun(dir, runId, "completed");
    const tmp = join(runDir, "snapshot.tmp-cafebabe");
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "payload"), "tmp\n");
    writeTask(dir, "11-03-ref", taskWithRun(runId));
    mkdirSync(runtimePath(dir, "pi-sessions", "orphan-session"), { recursive: true });
    writeFileSync(runtimePath(dir, "pi-sessions", "orphan-session", "native.jsonl"), "{}\n");
    const orphanRun = nextRunId();
    makeRun(dir, orphanRun, "completed");
    createIndex(dir);

    const before = treeFingerprint(dir);
    const preview = cliJson(dir, ["gc"], locks);
    const storage = cliJson(dir, ["storage"], locks);
    const after = treeFingerprint(dir);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(storage.status, 0, storage.stderr);
    assert.equal(preview.parsed.data.counts.candidates, preview.parsed.data.candidates.length);
    assert.equal(storage.parsed.data.gcCandidates, preview.parsed.data.counts.candidates);
    assert.equal(after, before, "只读预览与 storage 统计不得改变文件条目或字节");
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "gc")), false, "预览不写 gc/last.json");
  } finally {
    cleanup(dir);
  }
});

test("e) apply 中途删除失败：已完成项保留，last.json 可诊断，其余候选原样", async () => {
  const dir = project("partial");
  try {
    createIndex(dir);
    const root = runtimePath(dir, "pi-sessions");
    for (const name of ["a-orphan", "b-orphan", "c-orphan"]) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "native.jsonl"), "{}\n");
    }
    const locks = new LockManager({ root: join(dir, ".locks") });
    let calls = 0;
    const service = new GcService({
      locks,
      remove: (absolutePath) => {
        calls += 1;
        if (calls === 2) throw new Error("injected failure");
        rmSync(absolutePath, { recursive: true, force: true });
      },
    });
    const result = await service.apply({ dir });
    assert.equal(result.state, "partial");
    assert.equal(result.counts.removed, 1);
    assert.equal(result.counts.failed, 1);
    assert.equal(result.counts.skipped, 1);
    assert.equal(existsSync(join(root, "a-orphan")), false, "失败前已完成项保留删除结果");
    assert.equal(existsSync(join(root, "b-orphan")), true, "失败项原样保留");
    assert.equal(existsSync(join(root, "c-orphan")), true, "失败后未处理项原样保留");
    assert.equal(result.recordPath, ".knit/.runtime/gc/last.json");
    const recordPath = join(dir, ".knit", ".runtime", "gc", "last.json");
    assert.equal(existsSync(recordPath), true);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.state, "partial");
    assert.equal(record.items.length, 3);
    assert.deepEqual(record.items.map((item) => item.status), ["removed", "failed", "skipped"]);
    assert.match(record.items[1].outcomeReason, /injected failure/);
    assert.ok(record.policy.age === "disabled");
  } finally {
    cleanup(dir);
  }
});

test("f) storage 既有字段保持，仅新增 gcCandidates 计数", () => {
  const dir = project("storage");
  const locks = join(dir, ".locks");
  try {
    createIndex(dir);
    const storage = cliJson(dir, ["storage"], locks);
    assert.equal(storage.status, 0, storage.stderr);
    assert.equal(storage.parsed.outcome, "completed");
    const data = storage.parsed.data;
    const existing = [
      "projectRoot",
      "database",
      "tasks",
      "runs",
      "snapshots",
      "nativeSessions",
      "diagnostics",
      "baselines",
      "locks",
      "limits",
      "warnings",
    ];
    for (const key of existing) assert.ok(key in data, `storage 既有字段缺失: ${key}`);
    assert.equal(typeof data.gcCandidates, "number");
    assert.deepEqual(
      Object.keys(data).filter((key) => !existing.includes(key)),
      ["gcCandidates"],
      "storage 只新增 gcCandidates，不改变既有输出结构",
    );
    assert.equal(typeof data.database.counts, "object");
    assert.equal(typeof data.tasks.active, "number");
  } finally {
    cleanup(dir);
  }
});
