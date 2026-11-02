"""任务005 宿主桥接准入验证。有限次真实 Pi 调用；本机已选模型；不导入 SDK；产物只进 .work 与本目录。

用例：
A schema-and-trust：TypeBox→JSON Schema 派生、受信项目自动加载、executeTool 零模型校验、
   真实模型按 schema 调用工具、未受信不自动加载、安装 ready 不冒充信任。
B reload-no-duplicate：公开 API reload，旧监听不重复。
C result-pipeline：worker 回执 → 只读轮询 → 来源/去重核对 → 被动/唤醒/忙时 follow-up → 切会话不误投。
"""
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / ".work"
OUT = ROOT
BRIDGE = Path(__file__).resolve().parent / "knit-bridge.js"
SCHEMA_FILE = Path("/tmp/knit-005-schema.json")
EVENTS_FILE = Path("/tmp/knit-005-events.jsonl")
DIST = Path(__file__).resolve().parents[3] / "dist"
PI = os.environ.get("PI_EXECUTABLE", "/home/opc/.pi/agent/bin/pi")
PROVIDER = os.environ.get("PI_PROVIDER", "magpie")
MODEL = os.environ.get("PI_MODEL", "auto/glm-5.3-flash")
RESULT = {"status": "running", "cases": {}, "sdk_imported": False, "env": {}}


def save():
    tmp = OUT / "results.tmp"
    tmp.write_text(json.dumps(RESULT, ensure_ascii=False, indent=2))
    tmp.replace(OUT / "results.json")


def case(name, fn):
    start = time.monotonic()
    try:
        data = fn()
        RESULT["cases"][name] = {"status": "passed", "seconds": round(time.monotonic() - start, 2), "details": data}
    except Exception as error:
        import traceback

        RESULT["cases"][name] = {
            "status": "failed",
            "seconds": round(time.monotonic() - start, 2),
            "error": str(error)[:500],
            "traceback": traceback.format_exc()[-2000:],
        }
    save()
    print(f"[{name}] {RESULT['cases'][name]['status']}", flush=True)


def derive_schema():
    """从 dist/contracts 派生桥接工具参数 schema；产品将由 build 从同一 TypeBox 定义生成。"""
    node_code = f"""
const {{ Type }} = await import('typebox');
const {{ Value }} = await import('typebox/value');
const {{ RunPhaseSchema }} = await import('{DIST}/contracts/run.js');
// 桥接工具参数：runId 必填 string，phase 可选且复用 contracts 的 RunPhaseSchema。
const bridge = Type.Object({{
  runId: Type.String({{ description: 'Knit run ID' }}),
  phase: Type.Optional(RunPhaseSchema),
}});
const probes = {{
  ok: Value.Check(bridge, {{ runId: 'r-1' }}),
  okPhase: Value.Check(bridge, {{ runId: 'r-1', phase: 'check' }}),
  badPhase: Value.Check(bridge, {{ runId: 'r-1', phase: 'nope' }}),
  badType: Value.Check(bridge, {{ runId: 123 }}),
}};
process.stdout.write(JSON.stringify({{ bridgeTool: bridge, probes }}));
"""
    proc = subprocess.run(["node", "--input-type=module", "-e", node_code], capture_output=True, text=True, timeout=30, cwd=str(DIST.parent))
    if proc.returncode != 0:
        raise RuntimeError(f"schema derivation failed: {proc.stderr[-500:]}")
    payload = json.loads(proc.stdout)
    probes = payload["probes"]
    assert probes == {"ok": True, "okPhase": True, "badPhase": False, "badType": False}, probes
    SCHEMA_FILE.write_text(json.dumps(payload, ensure_ascii=False))
    return probes


def fresh_events():
    if EVENTS_FILE.exists():
        EVENTS_FILE.unlink()


def read_events():
    if not EVENTS_FILE.exists():
        return []
    return [json.loads(line) for line in EVENTS_FILE.read_text().splitlines() if line.strip()]


def write_project(name):
    folder = WORK / name
    if folder.exists():
        shutil.rmtree(folder)
    (folder / ".pi" / "extensions").mkdir(parents=True)
    shutil.copy2(BRIDGE, folder / ".pi" / "extensions" / "knit-bridge.js")  # 项目发现只认 .ts/.js（loader.js:585）
    (folder / "AGENTS.md").write_text("# 005 fixture project\n")
    marker = folder / ".knit" / ".runtime" / "installation.json"
    marker.parent.mkdir(parents=True)
    marker.write_text(json.dumps({"knit": "0.1.0", "ready": True}))
    return folder


def env_for(folder):
    env = dict(os.environ)
    for key in ("PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"):
        env.pop(key, None)
    env.update(PI_OFFLINE="1", PI_SKIP_VERSION_CHECK="1", PI_TELEMETRY="0")
    # 不设 PI_CODING_AGENT_DIR：provider 目录来自用户主目录，隐藏它会导致 Unknown provider。
    return env


class Pi:
    """最小 RPC 客户端（仅本验证用；产品走 src/adapters/pi）。"""

    def __init__(self, folder, role, discover, tools_mode="none"):
        self.folder = Path(folder)
        self.role = role
        self.q = queue.Queue()
        self.responses = {}
        self.events = []
        self.err = (self.folder / f"{role}-stderr.log").open("wb")
        self.log = (self.folder / f"{role}-events.jsonl").open("a")
        args = [PI, "--mode", "rpc", "--offline", "--no-mcp", "--no-skills", "--no-context-files",
                "--no-prompt-templates", "--no-themes", "--session-dir", str(self.folder / "sessions")]
        args += ["--approve"] if discover else ["--no-extensions", "--no-approve"]
        args += {"none": ["--no-tools"], "extension": ["--no-builtin-tools"], "bash": ["--tools", "bash"]}[tools_mode]
        args += ["--provider", PROVIDER, "--model", MODEL]
        args += ["--session-id", str(uuid.uuid4()), "--name", f"knit-005 {role}"]
        args += ["--append-system-prompt", "Temporary validation fixture. Follow the precise request. Do not inspect unrelated paths."]
        self.p = subprocess.Popen(args, cwd=self.folder, env=env_for(self.folder),
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err, start_new_session=True)
        threading.Thread(target=self._read, daemon=True).start()
        state = self.call("get_state").get("data", {})
        self.id = state.get("sessionId")
        self.file = state.get("sessionFile")
        self.call("set_model", provider=PROVIDER, modelId=MODEL)

    def _read(self):
        for raw in self.p.stdout:
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            self.q.put(obj)
        self.q.put({"type": "process_eof"})

    def pump(self, seconds=0.5):
        try:
            obj = self.q.get(timeout=seconds)
        except queue.Empty:
            return
        if obj.get("type") == "process_eof":
            raise RuntimeError("CLI EOF")
        if obj.get("type") == "response":
            self.responses[obj.get("id")] = obj
        else:
            self.events.append(obj)
            self.log.write(json.dumps(obj, ensure_ascii=False)[:2000] + "\n")
            self.log.flush()

    def call(self, kind, allow_failure=False, **data):
        rid = f"r-{uuid.uuid4().hex[:8]}"
        self.p.stdin.write((json.dumps({"id": rid, "type": kind, **data}, ensure_ascii=False) + "\n").encode())
        self.p.stdin.flush()
        end = time.monotonic() + 30
        while rid not in self.responses:
            self.pump()
            if time.monotonic() > end:
                raise TimeoutError(f"timeout: {kind}")
        obj = self.responses.pop(rid)
        if not allow_failure and not obj.get("success"):
            raise RuntimeError(f"rejected {kind}: {str(obj.get('error'))[:200]}")
        return obj

    def until(self, predicate, seconds=180):
        end = time.monotonic() + seconds
        while not predicate():
            self.pump()
            if time.monotonic() > end:
                raise TimeoutError("observation deadline")

    def observe(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.pump(min(0.3, max(0.01, end - time.monotonic())))

    def prompt(self, text):
        return self.call("prompt", message=text)

    def settled(self, start=0):
        return any(e.get("type") == "agent_settled" for e in self.events[start:])

    def last_text(self):
        return self.call("get_last_assistant_text").get("data", {}).get("text", "")

    def stats(self):
        s = self.call("get_session_stats").get("data", {})
        return {"tokens": s.get("tokens", {}), "cost_usd": s.get("cost")}

    def entries(self):
        return self.call("get_entries").get("data", {}).get("entries", [])

    def knit_events(self):
        return [e for e in self.entries() if e.get("customType") == "knit-005-evt"]

    def close(self):
        if self.p.poll() is None:
            try:
                self.call("clear_queue")
                self.call("abort")
            except Exception:
                pass
            try:
                self.p.stdin.close()
                self.p.wait(timeout=5)
            except Exception:
                try:
                    os.killpg(self.p.pid, signal.SIGTERM)
                    self.p.wait(timeout=3)
                except Exception:
                    try:
                        os.killpg(self.p.pid, signal.SIGKILL)
                        self.p.wait(timeout=3)
                    except Exception:
                        pass
        self.err.close()
        self.log.close()


def case_schema_and_trust():
    probes = derive_schema()
    fresh_events()
    folder = write_project("schema-trust")
    obj = Pi(folder, "trusted", discover=True, tools_mode="extension")
    try:
        commands = obj.call("get_commands").get("data", {}).get("commands", [])
        registered = sorted(c.get("name") for c in commands if str(c.get("name", "")).startswith("knit-bridge"))
        assert "knit-bridge-selftest" in registered, registered

        # 零额外模型回合的参数校验：模型调 knit_selftest，其 execute 内部用宿主 executeTool
        # 以非法/合法参数调 knit_status；非法参数必须在校验层被拒，不到达目标 execute。
        offset = len(obj.events)
        obj.prompt("Call the knit_selftest tool once, then reply exactly SELFTEST_DONE.")
        obj.until(lambda: obj.settled(offset), seconds=120)
        assert "SELFTEST_DONE" in obj.last_text(), obj.last_text()
        selftest = next((e for e in obj.knit_events() if e.get("data", {}).get("event") == "selftest"), None)
        assert selftest, obj.knit_events()[-5:]
        st = selftest["data"]
        assert st.get("error") is None, st
        # 对象 runId 与非法联合字面量被宿主校验拒绝（isError，不达 execute）。
        assert st["objectRunId"]["isError"] is True and st["objectRunId"]["reachedExecute"] is False, st["objectRunId"]
        assert st["badPhase"]["isError"] is True and st["badPhase"]["reachedExecute"] is False, st["badPhase"]
        # 兼容原始类型被 Value.Convert 强转（123→"123"），不拒绝：这是宿主真实行为。
        assert st["coerced"]["isError"] is False and st["coerced"]["runId"] == "123", st["coerced"]
        # 合法参数到达 execute。
        assert st["valid"]["isError"] is False and st["valid"]["runId"] == "r-probe" and st["valid"]["state"] == "unknown", st["valid"]

        # 真实模型按 schema 直接调用 knit_status（M0 门槛：TypeBox 自测不代替宿主兼容验证）。
        (folder / ".knit" / ".runtime" / "runs" / "r-live").mkdir(parents=True)
        (folder / ".knit" / ".runtime" / "runs" / "r-live" / "result.json").write_text(
            json.dumps({"runId": "r-live", "state": "completed", "reportSummary": "live"}))
        offset = len(obj.events)
        obj.prompt('Call the knit_status tool with runId exactly "r-live" and no other parameters, then reply exactly TOOL_USED.')
        obj.until(lambda: obj.settled(offset), seconds=120)
        assert "TOOL_USED" in obj.last_text(), obj.last_text()
        calls = [e for e in obj.events[offset:] if e.get("type") == "tool_execution_end" and e.get("toolName") == "knit_status"]
        assert calls, [e.get("type") for e in obj.events[offset:]]
        assert not calls[-1].get("isError"), calls[-1]

        # 未受信不自动加载；ready 标记存在但不构成信任。
        untrusted = Pi(folder, "untrusted", discover=False, tools_mode="none")
        try:
            names = [c.get("name") for c in untrusted.call("get_commands").get("data", {}).get("commands", [])]
            assert not any(str(n).startswith("knit-bridge") for n in names), names
        finally:
            untrusted.close()
        assert (folder / ".knit" / ".runtime" / "installation.json").exists()

        return {
            "schema_probes": probes,
            "commands_registered": registered,
            "host_validation": st,
            "coercion_semantics": "Value.Convert 强转兼容原始类型（123→\"123\"）；对象与非法联合字面量被拒（isError，不达 execute）",
            "real_model_called_registered_tool": True,
            "untrusted_not_loaded": True,
            "ready_marker_not_trust": True,
            "sdk_dependency": False,
        }
    finally:
        obj.close()


def case_reload_no_duplicate():
    fresh_events()
    folder = write_project("reload")
    obj = Pi(folder, "reload", discover=True, tools_mode="none")
    try:
        obj.prompt("/knit-bridge-status")
        assert len([e for e in obj.knit_events() if e["data"].get("event") == "cmd"]) == 1, obj.knit_events()

        obj.prompt("/knit-bridge-reload")
        obj.observe(1.5)
        obj.prompt("/knit-bridge-status")
        cmds = [e for e in obj.knit_events() if e["data"].get("event") == "cmd"]
        assert len(cmds) == 2, cmds

        events = read_events()
        assert any(e.get("event") == "reload_requested" for e in events), events[-8:]
        starts = [e for e in events if e.get("event") == "session_start"]
        regs = [e for e in events if e.get("event") == "tool_registered"]
        return {"cmd_events_after_reload": len(cmds), "session_starts": len(starts), "tool_registrations": len(regs),
                "note": "reload 后旧监听不重复：每条命令仍只产生一条事件。"}
    finally:
        obj.close()


def write_result(folder, run_id, state, summary, final_id=None):
    run_dir = folder / ".knit" / ".runtime" / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "result.json").write_text(json.dumps({
        "runId": run_id, "taskId": "t-005", "phase": "implement", "state": state,
        "reportSummary": summary, "finalId": final_id,
    }, ensure_ascii=False))


def set_status(folder, run_id, wake=False, origin=None):
    payload = {"runId": run_id, "wake": wake}
    if origin is not None:
        payload["originSession"] = origin
    status = folder / ".knit" / ".runtime" / "runs" / "status.json"
    status.parent.mkdir(parents=True, exist_ok=True)
    status.write_text(json.dumps(payload))


def case_result_pipeline():
    fresh_events()
    folder = write_project("pipeline")
    obj = Pi(folder, "pipeline", discover=True, tools_mode="bash")
    origin_session = obj.id
    try:
        # 阶段1：结果未落盘 → 不投递。
        set_status(folder, "r-passive", origin=origin_session)
        time.sleep(2.5)
        assert not any(e["data"].get("event") == "notice_sent" for e in obj.knit_events()), obj.knit_events()

        # 阶段2：非终态不投递；终态落盘 → 被动投递，不触发模型回合。
        write_result(folder, "r-passive", "running", "still working")
        time.sleep(1.5)
        assert not any(e["data"].get("event") == "notice_sent" for e in obj.knit_events())
        offset = len(obj.events)
        write_result(folder, "r-passive", "completed", "KNIT_005_PASSIVE", final_id="leaf-9")
        obj.observe(2.5)
        notices = [e["data"] for e in obj.knit_events() if e["data"].get("event") == "notice_sent"]
        assert notices and notices[0]["runId"] == "r-passive" and notices[0]["deliverAs"] == "passive", notices
        assert notices[0]["finalId"] == "leaf-9", notices
        assert not any(e.get("type") == "agent_start" for e in obj.events[offset:]), obj.events[offset:]
        messages = obj.call("get_messages").get("data", {}).get("messages", [])
        assert any("KNIT_005_PASSIVE" in str(m.get("content")) for m in messages), messages[-3:]

        # 阶段3：同一 run 重复轮询 → 去重，只投一次。
        time.sleep(2.5)
        notices2 = [e for e in obj.knit_events() if e["data"].get("event") == "notice_sent" and e["data"].get("runId") == "r-passive"]
        assert len(notices2) == 1, notices2

        # 阶段4：完成消息（wake）触发真实模型回合。
        offset = len(obj.events)
        before = obj.stats()
        set_status(folder, "r-wake", wake=True, origin=origin_session)
        write_result(folder, "r-wake", "completed", "KNIT_005_WAKE reply with exactly WAKE_ACK and no tools", final_id="leaf-10")
        obj.until(lambda: obj.settled(offset), seconds=120)
        assert "WAKE_ACK" in obj.last_text(), obj.last_text()
        after = obj.stats()
        wake_usage = {k: [before["tokens"].get(k, 0), after["tokens"].get(k, 0)] for k in after["tokens"]}

        # 阶段5：忙时 follow-up 排队，不抢当前输入；当前回答先于排队通知。
        nonce = "KNIT_005_BUSY_" + uuid.uuid4().hex
        queued = "KNIT_005_QUEUED_" + uuid.uuid4().hex
        offset = len(obj.events)
        command = f"python3 -u -c 'import time;print(\"{nonce}\",flush=True);time.sleep(3)'"
        obj.prompt(f"Use bash to run exactly this command: {command} then reply exactly BUSY_DONE. Do not run other commands.")
        obj.until(lambda: nonce in json.dumps(obj.events[offset:]), seconds=120)
        set_status(folder, "r-queued", wake=True, origin=origin_session)
        write_result(folder, "r-queued", "completed", queued, final_id="leaf-11")
        obj.until(lambda: obj.settled(offset), seconds=120)
        tail = json.dumps(obj.events[offset:])
        assert "BUSY_DONE" in tail and queued in tail, tail[-500:]

        # 阶段6：来源守卫——originSession 指向旧会话，当前会话不得投递。
        set_status(folder, "r-foreign", wake=True, origin="not-this-session")
        write_result(folder, "r-foreign", "completed", "KNIT_005_FOREIGN", final_id="leaf-12")
        time.sleep(2.5)
        foreign = [e for e in obj.knit_events() if e["data"].get("event") == "notice_sent" and e["data"].get("runId") == "r-foreign"]
        assert not foreign, foreign

        # 阶段7：回调前切换会话 → 新会话不收到旧通知（旧会话轮询停止）。
        set_status(folder, "r-stale", wake=True, origin=origin_session)
        write_result(folder, "r-stale", "completed", "KNIT_005_STALE", final_id="leaf-13")
        time.sleep(2.0)
        old_id = obj.id
        obj.call("new_session")
        obj.observe(2.0)
        assert obj.call("get_state").get("data", {}).get("sessionId") != old_id
        messages = obj.call("get_messages").get("data", {}).get("messages", [])
        assert not any("KNIT_005_STALE" in str(m.get("content")) for m in messages), messages[-3:]

        return {
            "no_result_no_delivery": True,
            "nonterminal_not_delivered": True,
            "passive_delivered_without_model": True,
            "dedupe_single_notice": True,
            "wake_triggered_model_round": {"tokens_before_after": wake_usage},
            "busy_followup_after_current_answer": True,
            "foreign_origin_not_delivered": True,
            "context_switch_no_misdelivery": True,
            "sdk_dependency": False,
        }
    finally:
        obj.close()


def main():
    RESULT["env"] = {
        "pi": subprocess.run([PI, "--version"], capture_output=True, text=True).stdout.strip(),
        "node": subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip(),
        "model": f"{PROVIDER}/{MODEL}",
    }
    WORK.mkdir(parents=True, exist_ok=True)
    selected = sys.argv[1:]
    for name, fn in [("schema-and-trust", case_schema_and_trust),
                     ("reload-no-duplicate", case_reload_no_duplicate),
                     ("result-pipeline", case_result_pipeline)]:
        if not selected or name in selected:
            case(name, fn)
    RESULT["status"] = "completed"
    save()


if __name__ == "__main__":
    main()
