import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { knit } from "./cli.mjs";

const cli = fileURLToPath(new URL("../../dist/cli/knit.js", import.meta.url));

/**
 * 在 `dir` 里运行 `knit init --pi`，加载生成出来的桥接，传给它一个假的 `pi`。
 * `PATH` 最前面放一个指向 `dist/cli/knit.js` 的 `knit`，测试结束时改回去。
 * 返回 `{ tool, fire, entries, messages, definitions }`：调用工具、触发事件、会话记录、桥接发出的消息及工具声明。
 */
export async function loadBridge(t, dir, { onMessage = () => {}, executor = false, projection = "buildSessionContext", sessionManager } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "knit-bin-"));
  const path = process.env.PATH;
  const inheritedExecutor = process.env.KNIT_PI_EXECUTOR;
  delete process.env.KNIT_PI_EXECUTOR;
  if (executor) process.env.KNIT_PI_EXECUTOR = "1";
  t.after(() => {
    delete process.env.KNIT_PI_EXECUTOR;
    if (inheritedExecutor !== undefined) process.env.KNIT_PI_EXECUTOR = inheritedExecutor;
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  });
  writeFileSync(join(bin, "knit"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
  chmodSync(join(bin, "knit"), 0o755);
  process.env.PATH = `${bin}${delimiter}${path}`;

  const initialized = knit(dir, "init", "--pi");
  assert.equal(initialized.code, 0, initialized.stderr);

  const tools = new Map();
  const handlers = new Map();
  const entries = [];
  const messages = [];
  const projectContext = (branch = entries) => {
    if (sessionManager) return sessionManager.buildSessionProjection();
    const compact = branch.findLast((entry) => entry.type === "compaction");
    const start = compact ? branch.findIndex((entry) => entry.id === compact.firstKeptEntryId) : 0;
    const kept = branch.slice(start < 0 ? branch.indexOf(compact) + 1 : start);
    return { messages: [
      ...(compact ? [{ role: "compactionSummary", summary: compact.summary }] : []),
      ...kept.flatMap((entry) => {
        if (entry.type === "message") return [entry.message];
        if (entry.type !== "custom_message") return [];
        const { customType, content, display, details, timestamp } = entry;
        return [{ role: "custom", customType, content, display, details, timestamp: Date.parse(timestamp) }];
      }),
    ] };
  };
  const ctx = { sessionManager: { getBranch: () => sessionManager?.getBranch() ?? entries,
    getSessionId: () => sessionManager?.getSessionId() ?? "test-session",
    ...(projection ? { [projection]: projectContext } : {}),
  } };
  const append = (entry) => {
    if (!sessionManager) {
      const id = randomUUID();
      entries.push({ ...entry, id, timestamp: new Date(0).toISOString() });
      return id;
    }
    if (entry.type === "message") return sessionManager.appendMessage(entry.message);
    if (entry.type === "compaction") return sessionManager.appendCompaction(entry.summary, entry.firstKeptEntryId, 1000);
    if (entry.type === "custom") return sessionManager.appendCustomEntry(entry.customType, entry.data);
    assert.equal(entry.type, "custom_message");
    return sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  };
  const bridge = await import(pathToFileURL(join(dir, ".pi", "extensions", "knit.ts")).href);
  const api = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (customType, data) => append({ type: "custom", customType, data }),
    sendMessage: (message, options) => {
      onMessage(message, options);
      messages.push({ message, options });
    },
  };
  await bridge.default(api);

  return {
    reload: async (restoredManager = sessionManager) => {
      sessionManager = restoredManager;
      tools.clear();
      handlers.clear();
      await bridge.default(api);
    },
    tool: (name, params, context = {}) => tools.get(name).execute("call", params, undefined, undefined, { ...ctx, ...context }),
    appendMessage: (message) => append({ type: "message", message }),
    compact: (firstKeptEntryId = null) => append({ type: "compaction", summary: "压缩摘要", firstKeptEntryId }),
    switchBranch: (branch) => entries.splice(0, entries.length, ...branch),
    projectContext,
    fire: async (event, payload) => {
      const proposed = event === "turn_end" ? payload.entries ?? [] : [];
      const boundary = event === "turn_end" ? { ...payload, entries: proposed, context: {
        contextMessages: projectContext([...entries, ...proposed]).messages,
      } } : payload;
      for (const handler of handlers.get(event) ?? []) {
        const result = await handler(boundary, ctx);
        if (result?.block) return result;
        if (result?.message) append({ type: "custom_message", ...result.message });
        if (event === "turn_end") {
          assert.equal(result?.continue, undefined);
          (result?.entries ?? proposed).forEach(append);
        }
        return result;
      }
    },
    async requestMessages(messages = projectContext().messages) {
      return (await this.fire("context_with_system", { messages: structuredClone(messages) }))?.messages ?? messages;
    },
    get entries() { return ctx.sessionManager.getBranch(); },
    messages,
    events: [...handlers.keys()],
    definitions: [...tools.values()],
  };
}
