#!/bin/bash
# 在真的 Rex 里用真的模型走一个任务：实现环节在窗格里做完；审查环节中途按 Esc 中止，再接着输入让它做完。
# 要在 Rex 的终端里运行（环境里有 REX_SESSION、REX_BLOCK），先运行过 npm run -s build。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
h1="$here/../slim-h1-2026-11"
[ -n "${REX_SESSION:-}" ] && [ -n "${REX_BLOCK:-}" ] || { echo "要在 Rex 的终端里运行" >&2; exit 2; }
base="$("$h1/setup.sh" rex)"
export PATH="$base/bin:$PATH"
cd "$base/proj"
fail() { echo "不满足：$1" >&2; exit 1; }
step() { echo; echo "\$ $*"; "$@"; }
# 这个 Rex 会话里现在有哪些浮动窗格（标签）。
panes() {
  rex --autostart=false api call session.view "{\"session_id\":\"$REX_SESSION\"}" | node -e '
const view = JSON.parse(require("fs").readFileSync(0, "utf8"));
const layers = view.windows.flatMap((window) => window.layers ?? []).filter((layer) => layer.kind === "floating");
console.log(layers.map((layer) => `${layer.blocks[0].label}(${layer.state})`).join(" "));'
}
# 会话记录里每条用户消息和执行者消息：角色、结束原因、开头二十个字。
turns() {
  node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((line) => JSON.parse(line));
for (const { message } of lines.filter((entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message.role))) {
  const text = typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  console.log(`  ${message.role} ${message.stopReason ?? "-"} ${JSON.stringify(text.slice(0, 20))}`);
}' "$1"
}
rex version | head -1
before="$(panes)"

id="$(knit task new --title "greet 支持自定义问候语" --slug greet-word --verification independent | sed -n 's/^已创建 //p')"
echo "任务: $id"
file="$(echo .knit/tasks/*/task.md)"
{ awk '/^---$/{n++} {print} n==2{exit}' "$file"; echo; cat "$h1/task-body.md"; } > "$file.new"
mv "$file.new" "$file"
step knit task ready "$id"

echo; echo "== 实现环节：在窗格里做完"
step knit run start "$id"
implement="$(ls -t .knit/.runtime/runs | head -1)"
for _ in $(seq 1 100); do [ -f ".knit/.runtime/runs/$implement/pane.json" ] && break; sleep 0.1; done
[ -f ".knit/.runtime/runs/$implement/pane.json" ] || fail "执行者在窗格里开始（pane.json）"
echo "窗格: $(panes)"
grep -qF "knit $implement(minimized)" <<< "$(panes)" || fail "有一个标着 knit $implement 的最小化的浮动窗格"
step knit run status "$id"
step knit run wait "$id"
echo "窗格里做完之后的会话记录:"; turns ".knit/.runtime/runs/$implement"/session/*.jsonl
echo "outcome.json: $(tr -d '\n' < ".knit/.runtime/runs/$implement/outcome.json" | sed "s|$base|<base>|")"
echo "worker.log $(wc -c < ".knit/.runtime/runs/$implement/worker.log" | tr -d ' ') 字节"
[ ! -s ".knit/.runtime/runs/$implement/worker.log" ] || fail "没有回退（worker.log 是空的）"
[ "$(panes)" = "$before" ] || fail "做完之后窗格自己关掉"

echo; echo "== 审查环节：中途按 Esc，再接着输入"
step knit run start "$id"
review="$(ls -t .knit/.runtime/runs | head -1)"
pane="knit $review"
for _ in $(seq 1 150); do grep -q "Working" <<< "$(rex capture -b "$pane" -s "$REX_SESSION" --trim 2>/dev/null)" && break; sleep 0.2; done
sleep 1.5
step rex send-key -b "$pane" -s "$REX_SESSION" escape
sleep 8
echo "按 Esc 八秒之后，窗格的最后几行:"
rex capture -b "$pane" -s "$REX_SESSION" --trim | tail -9 | sed -n 1,5p
status="$(knit run status "$id")"
echo; echo "\$ knit run status $id"; echo "$status"
grep -q "^正在跑: 审查（${review}）" <<< "$status" || fail "中止之后这次执行还算正在跑"
grep -qx "窗格: Rex 里标着 knit ${review} 的浮动窗格（最小化着）" <<< "$status" || fail "状态里指出是哪个窗格"
[ ! -f ".knit/.runtime/runs/$review/report.md" ] || fail "中止之后没有报告"
[ ! -f ".knit/.runtime/runs/$review/outcome.json" ] || fail "中止之后没有结果"
aborted="$(turns ".knit/.runtime/runs/$review"/session/*.jsonl)"
echo "中止之后的会话记录:"; echo "$aborted"
grep -q "assistant aborted" <<< "$aborted" || fail "会话记录里执行者的那条消息是 aborted"
step rex send -b "$pane" -s "$REX_SESSION" '接着做，把审查做完并交报告。'
step rex send-key -b "$pane" -s "$REX_SESSION" enter
step knit run wait "$id"
echo "接着做完之后的会话记录:"; turns ".knit/.runtime/runs/$review"/session/*.jsonl
echo "outcome.json: $(tr -d '\n' < ".knit/.runtime/runs/$review/outcome.json" | sed "s|$base|<base>|")"
[ "$(panes)" = "$before" ] || fail "做完之后窗格自己关掉"

record="$(echo .knit/tasks/*/record.json)"
echo; echo "两次执行:"
node -e '
const runs = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runs;
for (const run of runs) {
  const seconds = ((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1);
  console.log(`  ${run.id} ${run.stage} 用时 ${seconds}s 失败 ${run.failure} 结论 ${run.verdict} 改动 ${run.changedPaths.join(",")}`);
}
const ok = runs.length === 2 && runs.every((run) => run.endedAt !== null && run.failure === null)
  && runs[0].stage === "implement" && runs[0].changedPaths.join() === "greet.mjs,greet.test.mjs"
  && runs[1].stage === "review" && runs[1].verdict === "pass";
process.exit(ok ? 0 : 1);
' "$record" || fail "两次执行都正常结束，实现改了两个文件，审查的结论是 pass"
node --test > "$base/node-test.log" 2>&1 || true
grep -E '^ℹ (tests|pass|fail)' "$base/node-test.log"
grep -q '^ℹ fail 0$' "$base/node-test.log" || fail "node --test 输出里 fail 0"
if pgrep -fl "run worker|rex.*wait.*block:"; then fail "没有留下进程"; fi
echo "没有留下进程"

mkdir -p "$here/logs"
cp "$record" "$here/logs/record.json"
for run in "$implement" "$review"; do
  mkdir -p "$here/logs/$run"
  cp ".knit/.runtime/runs/$run/report.md" "$here/logs/$run/"
done
echo; echo "通过"
