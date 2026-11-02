// 任务005 宿主桥接准入夹具。只使用宿主公开扩展 API，不导入 Pi SDK 或 Knit 源码。
// 参数 schema 由驱动从 dist/contracts 派生写入 /tmp/knit-005-schema.json；
// 事件同时落 /tmp/knit-005-events.jsonl（诊断）与 knit-005-evt 自定义条目（会话内证据）。
import fs from "node:fs";
import { Type } from "typebox";

const version = "v1";
const SCHEMA_FILE = "/tmp/knit-005-schema.json";
const EVENTS_FILE = "/tmp/knit-005-events.jsonl";
const POLL_MS = 1000;

const log = (data) => {
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify({ time: Date.now(), version, ...data }) + "\n");
  } catch {}
};

function loadSchemas() {
  try {
    return JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
  } catch {
    return null;
  }
}

function readStatus(root) {
  try {
    return JSON.parse(fs.readFileSync(root + "/.knit/.runtime/runs/status.json", "utf8"));
  } catch {
    return null;
  }
}

function readRunResult(root, runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9_-]+$/.test(runId)) return null;
  try {
    return JSON.parse(fs.readFileSync(`${root}/.knit/.runtime/runs/${runId}/result.json`, "utf8"));
  } catch {
    return null;
  }
}

const TERMINAL_STATES = new Set(["completed", "cancelled", "failed"]);

export default function (pi) {
  let current = null;
  const pollers = new Set();

  const notifiedRunIds = (ctx) => {
    try {
      return new Set(
        ctx.sessionManager
          .getEntries()
          .filter((e) => e.type === "custom" && e.customType === "knit-005-evt" && e.data?.event === "notice_sent")
          .map((e) => e.data.runId),
      );
    } catch (error) {
      log({ event: "dedupe_scan_error", message: String(error?.message).slice(0, 200) });
      return new Set();
    }
  };

  pi.on("session_start", (event, ctx) => {
    current = ctx;
    const origin = ctx.sessionManager.getSessionId();
    const root = ctx.sessionManager.getCwd();
    log({ event: "session_start", reason: event?.reason, session: origin, cwd: root });
    if (!loadSchemas()) {
      log({ event: "no_schema" });
      return;
    }
    const timer = setInterval(() => tick(), POLL_MS);
    let stopped = false;
    const poller = {
      stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        log({ event: "poll_stopped", session: origin });
      },
    };
    pollers.add(poller);

    const tick = () => {
      try {
        const active = current?.sessionManager.getSessionId();
        if (active !== origin) {
          // 会话或树已切换：停止本会话的观察，不向新上下文投递。
          log({ event: "dropped_context_changed", origin, active });
          poller.stop();
          return;
        }
        const status = readStatus(root);
        const runId = status?.runId;
        if (typeof runId !== "string") return;
        // 来源守卫：run 必须由本会话发起；status.originSession 由驱动模拟核心绑定。
        if (status.originSession !== undefined && status.originSession !== origin) return;
        const result = readRunResult(root, runId);
        if (!result || !TERMINAL_STATES.has(result.state)) return;
        if (notifiedRunIds(ctx).has(runId)) return;
        const busy = current.isIdle() === false;
        const wake = status.wake === true;
        const deliverAs = busy ? "followUp" : wake ? "turn" : "passive";
        pi.sendMessage(
          {
            customType: "knit-005-notice",
            content: `Knit run ${runId} ${result.state}: ${result.reportSummary ?? ""}`,
            display: true,
            details: { runId, state: result.state, finalId: result.finalId ?? null },
          },
          busy ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: wake },
        );
        pi.appendEntry("knit-005-evt", { event: "notice_sent", runId, state: result.state, deliverAs, finalId: result.finalId ?? null });
        log({ event: "notice_sent", runId, state: result.state, deliverAs });
      } catch (error) {
        log({ event: "tick_error", message: String(error?.message).slice(0, 200) });
      }
    };
  });

  pi.on("session_shutdown", () => {
    for (const poller of pollers) poller.stop();
    pollers.clear();
    log({ event: "shutdown" });
  });

  pi.registerCommand("knit-bridge-status", {
    description: "005 fixture: append a versioned event",
    handler: async (_args, ctx) => {
      pi.appendEntry("knit-005-evt", { event: "cmd", version });
      log({ event: "cmd", version, session: ctx.sessionManager.getSessionId() });
    },
  });

  pi.registerCommand("knit-bridge-reload", {
    description: "005 fixture: reload this extension via public API",
    handler: async (_args, ctx) => {
      log({ event: "reload_requested" });
      await ctx.reload();
    },
  });

  pi.registerCommand("knit-bridge-selftest", {
    description: "005 fixture: marker command (selftest moved to knit_selftest tool)",
    handler: async (_args, ctx) => {
      pi.appendEntry("knit-005-evt", { event: "cmd", version, at: "selftest" });
      log({ event: "cmd", version, session: ctx.sessionManager.getSessionId() });
    },
  });

  const schemas = loadSchemas();
  if (!schemas?.bridgeTool) {
    log({ event: "tool_not_registered" });
    return;
  }
  // 自测工具：在工具 execute 的 ctx 里用宿主 executeTool 验证 knit_status 的参数校验（零额外模型回合）。
  pi.registerTool({
    name: "knit_selftest",
    label: "Knit selftest",
    description: "005 验证夹具：无参数。内部用 ctx.executeTool 分别以非法/合法参数调用 knit_status。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const out = { event: "selftest", version };
      try {
        // 宿主校验层 Value.Convert 会把兼容原始类型强转（123→"123"）；
        // 对象参数与超出联合字面量的值才会被拒。分别验证三种情况。
        const obj = await ctx.executeTool("knit_status", { runId: { deep: 1 }, phase: "implement" });
        out.objectRunId = {
          isError: obj?.isError === true,
          reachedExecute: obj?.result?.details?.runId !== undefined,
          text: String(obj?.result?.content?.[0]?.text ?? "").slice(0, 160),
        };
        const badPhase = await ctx.executeTool("knit_status", { runId: "r-ok", phase: "nope" });
        out.badPhase = { isError: badPhase?.isError === true, reachedExecute: badPhase?.result?.details?.runId !== undefined };
        const coerced = await ctx.executeTool("knit_status", { runId: 123 });
        out.coerced = { isError: coerced?.isError === true, runId: coerced?.result?.details?.runId ?? null };
        // 合法参数：到达 execute，返回 details。
        const valid = await ctx.executeTool("knit_status", { runId: "r-probe", phase: "check" });
        out.valid = {
          isError: valid?.isError === true,
          runId: valid?.result?.details?.runId ?? null,
          state: valid?.result?.details?.state ?? null,
        };
      } catch (error) {
        out.error = String(error?.message).slice(0, 200);
      }
      pi.appendEntry("knit-005-evt", out);
      log(out);
      return { content: [{ type: "text", text: JSON.stringify(out) }], details: out };
    },
  });

  pi.registerTool({
    name: "knit_status",
    label: "Knit status",
    description: "只读查询 Knit run 状态（005 验证夹具）。参数为 runId 与可选 phase。",
    parameters: schemas.bridgeTool,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = ctx?.sessionManager?.getCwd() ?? process.cwd();
      const result = readRunResult(root, params.runId);
      const details = {
        runId: params.runId,
        phase: params.phase ?? null,
        state: result?.state ?? "unknown",
      };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
  log({ event: "tool_registered" });
}
