import test from "node:test";
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import fs, { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync, readFileSync, chmodSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { sha256Text } from "../dist/contracts/primitives.js";
import { atomicWrite, digestOf, fileFacts, listFiles } from "../dist/infrastructure/fs.js";
import { normalizeRoot, hashKey, projectRelative, resolveWithMissingTail, safeJoin, canonicalPath, samePath } from "../dist/infrastructure/paths.js";

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), `knit-infra-${prefix}-`));
}

test("原子写：预期版本不符不覆盖后来内容", () => {
  const dir = freshDir("atomic");
  try {
    const path = join(dir, "state.json");
    const first = atomicWrite({ path, data: Buffer.from("v1") });
    writeFileSync(path, "v2-by-rival"); // 模拟后来者覆盖
    assert.throws(
      () => atomicWrite({ path, data: Buffer.from("v3"), expectedSha256: first.sha256 }),
      (error) => error.code === "version_conflict",
    );
    assert.equal(readFileSync(path, "utf8"), "v2-by-rival", "后来内容必须保留");
    // 正确预期版本可发布
    const third = atomicWrite({ path, data: Buffer.from("v3"), expectedSha256: sha256Text("v2-by-rival") });
    assert.equal(third.sha256, sha256Text("v3"));
    // expectedSha256: null 要求文件不存在
    const newPath = join(dir, "new.json");
    atomicWrite({ path: newPath, data: Buffer.from("x"), expectedSha256: null });
    assert.throws(
      () => atomicWrite({ path: newPath, data: Buffer.from("y"), expectedSha256: null }),
      (error) => error.code === "version_conflict",
    );
    // 无残留临时文件
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".knit-tmp-")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无条件原子覆写跳过旧文件读取，写入、同步及改名失败保留原错误和原文件", (t) => {
  const dir = freshDir("atomic-overwrite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  writeFileSync(path, "old");
  const request = { path, data: Buffer.from("new") };
  const reads = t.mock.method(fs, "readFileSync");
  syncBuiltinESMExports();
  try {
    assert.equal(atomicWrite(request).sha256, sha256Text("new"));
    assert.equal(reads.mock.calls.some((call) => call.arguments[0] === path), false);
  } finally {
    reads.mock.restore();
    syncBuiltinESMExports();
  }
  for (const operation of ["writeSync", "fsyncSync", "renameSync"]) {
    const error = new Error(operation);
    const fault = t.mock.method(fs, operation, () => { throw error; });
    syncBuiltinESMExports();
    try {
      assert.throws(() => atomicWrite({ path, data: Buffer.from("failed") }), (actual) => actual === error);
      assert.deepEqual(readdirSync(dir), ["state.json"]);
      assert.equal(readFileSync(path, "utf8"), "new");
    } finally {
      fault.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("原子写：私有权限 0600 与嵌套目录创建", () => {
  const dir = freshDir("perm");
  try {
    const nested = join(dir, "a", "b", "file.txt");
    atomicWrite({ path: nested, data: Buffer.from("secret") });
    const mode = statSync(nested).mode & 0o777;
    assert.equal(mode, 0o600, `file mode ${mode.toString(8)}`);
    const dirMode = statSync(join(dir, "a", "b")).mode & 0o777;
    assert.ok((dirMode & 0o077) === 0, `目录不应含组／他人权限: ${dirMode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("原子写失败路径：临时文件清理后原文件保留", () => {
  const dir = freshDir("atomic-fail");
  try {
    const path = join(dir, "f.txt");
    atomicWrite({ path, data: Buffer.from("keep") });
    // 只读目录强制 rename 失败
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const subFile = join(sub, "x.txt");
    atomicWrite({ path: subFile, data: Buffer.from("v1") });
    chmodSync(sub, 0o500);
    try {
      assert.throws(() => atomicWrite({ path: subFile, data: Buffer.from("v2"), expectedSha256: sha256Text("v1") }));
      assert.equal(readFileSync(subFile, "utf8"), "v1", "失败后原文件保留");
    } finally {
      chmodSync(sub, 0o700);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("指纹与路径：稳定键、safeJoin 拒绝越界与符号链接逃逸", () => {
  assert.equal(hashKey("a"), hashKey("a"));
  assert.notEqual(hashKey("a"), hashKey("b"));
  assert.equal(digestOf({ x: 1, y: "2" }), digestOf({ y: "2", x: 1 }));
  assert.notEqual(digestOf({ x: 1 }), digestOf({ x: 2 }));

  const dir = freshDir("paths");
  try {
    const root = normalizeRoot(dir);
    assert.equal(normalizeRoot(join(dir, "sub", "..")), root);
    // 常规相对路径
    assert.equal(safeJoin(root, "tasks/a.md"), join(root, "tasks", "a.md"));
    // 绝对路径拒绝
    assert.throws(() => safeJoin(root, "/etc/passwd"), (error) => error.code === "path_escape");
    // .. 越界拒绝
    assert.throws(() => safeJoin(root, "../outside"), (error) => error.code === "path_escape");
    // NUL 拒绝
    assert.throws(() => safeJoin(root, "a\0b"), (error) => error.code === "path_escape");
    // 符号链接指向项目外：拒绝
    const outside = freshDir("outside");
    try {
      writeFileSync(join(outside, "secret.txt"), "s");
      const link = join(root, "link");
      execFileSync("ln", ["-s", outside, link]);
      assert.throws(() => safeJoin(root, "link/secret.txt"), (error) => error.code === "path_escape");
      symlinkSync(join(outside, "missing"), join(root, "pending"));
      assert.throws(() => safeJoin(root, "pending"), { code: "path_escape" });
      assert.throws(() => safeJoin(root, "pending/child"), { code: "path_escape" });
      // 等价改名（目录内移动）不拒绝
      mkdirSync(join(root, "t1"));
      assert.equal(safeJoin(root, "t1/../t2"), join(root, "t2"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("公共路径解析检查尾分隔符，并保留目录链接与 .. 的磁盘语义", (t) => {
  const root = realpathSync(freshDir("tail"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs", "sub"), { recursive: true });
  writeFileSync(join(root, "docs", "sample"), "ok");
  symlinkSync("docs/sub", join(root, "alias"));
  symlinkSync("missing", join(root, "pending"));
  for (const suffix of ["", "/", "///", "/child/"]) {
    assert.equal(resolveWithMissingTail(`${root}/pending${suffix}`), null);
    assert.throws(() => safeJoin(root, `pending${suffix}`), { code: "path_escape" });
  }
  assert.equal(resolveWithMissingTail(`${root}/alias/`), join(root, "docs/sub"));
  assert.equal(resolveWithMissingTail(`${root}/alias/../sample`), join(root, "docs/sample"));
  assert.equal(resolveWithMissingTail(`${root}/alias/../new/file/`), join(root, "docs/new/file"));
  assert.equal(safeJoin(root, "alias/new/file"), join(root, "docs/sub/new/file"));
});

test("项目相对路径拒绝空串与 NUL，保留合法路径的规整结果", () => {
  assert.equal(projectRelative(""), null);
  assert.equal(projectRelative("docs/a\0.md"), null);
  assert.equal(projectRelative("./docs/role.md"), "docs/role.md");
});

test("文件事实：absent 如实记录，不抛错；链接按目标、文件含模式", () => {
  const dir = freshDir("facts");
  try {
    const file = join(dir, "a.txt");
    assert.deepEqual(fileFacts(file), { kind: "absent", mode: null, sha256: null, childCount: null });
    writeFileSync(file, "hello");
    const facts = fileFacts(file);
    assert.equal(facts.kind, "file");
    assert.equal(facts.sha256, sha256Text("hello"));
    assert.equal(facts.childCount, null);
    assert.equal(facts.mode, statSync(file).mode.toString(8));
    const target = join(dir, "real.txt");
    writeFileSync(target, "target\n");
    symlinkSync("real.txt", join(dir, "link.txt"));
    const link = fileFacts(join(dir, "link.txt"));
    assert.equal(link.kind, "link");
    assert.equal(link.mode, "real.txt");
    assert.equal(link.sha256, null);
    const broken = fileFacts(join(dir, "broken.txt"));
    assert.equal(broken.kind, "absent");
    const listed = listFiles(dir);
    assert.equal(Object.keys(listed).length, 3);
    assert.ok(listed["a.txt"]);
    assert.equal(listed["link.txt"].kind, "link");
    assert.equal(listed["link.txt"].mode, "real.txt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


/** 模拟 macOS 临时目录：<base>/var 是指向 <base>/private/var 的符号链接，返回别名路径。 */
function aliasedTmp(prefix) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `knit-mac-${prefix}-`)));
  mkdirSync(join(base, "private", "var", "folders", "T"), { recursive: true });
  symlinkSync(join("private", "var"), join(base, "var"));
  return { base, alias: join(base, "var", "folders", "T"), real: join(base, "private", "var", "folders", "T") };
}

test("路径规范化：/var → /private/var 别名视为同一位置；不存在的尾段原样拼回", () => {
  const { base, alias, real } = aliasedTmp("canon");
  try {
    assert.equal(canonicalPath(alias), real);
    assert.equal(canonicalPath(join(alias, "not", "yet")), join(real, "not", "yet"));
    assert.equal(samePath(alias, real), true);
    assert.equal(samePath(join(alias, "a"), join(real, "a")), true);
    assert.equal(samePath(join(alias, "a"), join(real, "b")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
