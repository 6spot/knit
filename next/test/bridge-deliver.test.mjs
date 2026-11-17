import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { loadBridge } from "./helpers/bridge.mjs";
import { doneTask, gitIdentity } from "./helpers/deliver.mjs";
import { commitAll, git, gitProject } from "./helpers/git.mjs";

const now = new Date();
const archived = (task) =>
  `.knit/tasks/archive/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}/${basename(task.dir)}`;
const text = (result) => result.content[0].text;
const failed = (message) => ({ content: [{ type: "text", text: message }], details: undefined, isError: true });
const filesOf = (dir, taskDir) => ["task.md", "record.json"].map((name) => readFileSync(join(dir, taskDir, name), "utf8"));

/** 会话记录的样子照 Pi 的会话格式。 */
const userSaid = (id, content) => ({ type: "message", id, message: { role: "user", content } });
const FIRST = userSaid("u-first", "可以交付，然后下一步G。");
const SECOND = userSaid("u-second", [{ type: "text", text: "造不出来就先不管这个\n授权交付" }]);

/** 加载了桥接的临时项目，不在 Git 仓库里；会话记录里有那两条用户消息。 */
async function bridged(t) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bridge = await loadBridge(t, dir);
  bridge.entries.push(FIRST, SECOND);
  return { dir, bridge };
}

test("找到原话时交付并记下是哪一条", async (t) => {
  const { dir, bridge } = await bridged(t);
  const task = doneTask(dir);
  const other = doneTask(dir);

  const delivered = await bridge.tool("knit_deliver", { taskId: task.id, authorization: "  授权交付  " });
  assert.equal(delivered.isError, undefined, text(delivered));
  assert.equal(
    text(delivered),
    `已交付 ${task.id}\n归档: ${archived(task)}\n提交: 这个项目不在 Git 仓库里，没有提交`,
  );
  assert.equal(existsSync(join(dir, task.dir)), false);
  const [document, record] = filesOf(dir, archived(task));
  assert.match(document, /^status: delivered$/m);
  assert.equal(JSON.parse(record).authorization, "user:u-second 授权交付");

  const again = await bridge.tool("knit_deliver", { taskId: other.id, authorization: "可以交付，然后下一步G。" });
  assert.equal(again.isError, undefined, text(again));
  assert.equal(
    JSON.parse(filesOf(dir, archived(other))[1]).authorization,
    "user:u-first 可以交付，然后下一步G。",
  );
});

test("找不到原话时不交付", async (t) => {
  const { dir, bridge } = await bridged(t);
  bridge.entries.push(
    { type: "message", id: "a-1", message: { role: "assistant", content: [{ type: "text", text: "同意交付" }] } },
    { type: "custom_message", id: "c-1", customType: "knit.run-ended", content: "同意交付", display: true },
  );
  const task = doneTask(dir);
  const before = filesOf(dir, task.dir);

  for (const quote of ["同意交付", "交付", "可以交付"]) {
    assert.deepEqual(
      await bridge.tool("knit_deliver", { taskId: task.id, authorization: quote }),
      failed(
        `在这个会话里找不到用户说过这句话：${quote}；authorization 要写用户同意交付的那条消息的原话（整条，或者其中完整的一行）`,
      ),
    );
  }
  for (const params of [{}, { authorization: "   " }]) {
    assert.deepEqual(
      await bridge.tool("knit_deliver", { taskId: task.id, ...params }),
      failed("交付要有用户的授权：authorization 写用户同意交付的那条消息的原话"),
    );
  }
  assert.deepEqual(filesOf(dir, task.dir), before);
  assert.equal(existsSync(join(dir, archived(task))), false);
});

test("在 Git 仓库里带提交文案交付", async (t) => {
  const dir = gitProject(t);
  gitIdentity(dir);
  const bridge = await loadBridge(t, dir);
  const task = doneTask(dir);
  commitAll(dir, "task");
  bridge.entries.push(userSaid("u-git", "可以交付"));
  const tmpBefore = process.env.TMPDIR;
  const tmp = mkdtempSync(join(tmpdir(), "knit-tmp-"));
  t.after(() => {
    if (tmpBefore === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmpBefore;
    rmSync(tmp, { recursive: true, force: true });
  });
  process.env.TMPDIR = tmp;

  const delivered = await bridge.tool("knit_deliver", {
    taskId: task.id,
    authorization: "可以交付",
    message: "feat: 加问候语",
  });
  assert.equal(delivered.isError, undefined, text(delivered));
  assert.equal(text(delivered).split("\n")[2], `提交: ${git(dir, "rev-parse", "--short", "HEAD")} feat: 加问候语`);
  assert.equal(git(dir, "log", "-1", "--format=%B"), `feat: 加问候语\n\nKnit-Task: ${task.id}`);
  assert.equal(JSON.parse(filesOf(dir, archived(task))[1]).authorization, "user:u-git 可以交付");
  assert.deepEqual(readdirSync(tmp), []);
});
