#!/bin/bash
# 场景一：用命令行走完一个任务，执行者是真的 Pi。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# 日志目录可以从外面指定：别的机器上重跑时不覆盖这里 2026-11-17 的证据。
logs="${KNIT_H1_LOGS:-$here/logs}"
base="$("$here/setup.sh" cli)"
export PATH="$base/bin:$PATH"
cd "$base/proj"
fail() { echo "不满足：$1" >&2; exit 1; }
step() { echo; echo "\$ $*"; "$@"; }

id="$(knit task new --title "greet 支持自定义问候语" --slug greet-word --verification independent | sed -n 's/^已创建 //p')"
echo "任务: $id"
file="$(echo .knit/tasks/*/task.md)"
# 保留开头的元数据，后面换成需求正文。
{ awk '/^---$/{n++} {print} n==2{exit}' "$file"; echo; cat "$here/task-body.md"; } > "$file.new"
mv "$file.new" "$file"

step knit task ready "$id"
step knit run start "$id"
step knit run wait "$id"
step knit run start "$id"
step knit run wait "$id"

record="$(echo .knit/tasks/*/record.json)"
echo; echo "两次执行:"
node -e '
const runs = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runs;
for (const run of runs) {
  const seconds = ((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1);
  console.log(`  ${run.id} ${run.stage} 用时 ${seconds}s 失败 ${run.failure} 结论 ${run.verdict} 改动 ${run.changedPaths.join(",")}`);
}
const ok = runs.length === 2 && runs.every((run) => run.endedAt !== null && run.failure === null)
  && runs[0].stage === "implement" && runs[1].stage === "review" && runs[1].verdict === "pass";
process.exit(ok ? 0 : 1);
' "$record" || fail "两次执行都正常结束，审查的结论是 pass"
echo "执行者有没有读到 AGENTS.md，拿到哪些工具，日志多大:"
for run in .knit/.runtime/runs/*/; do
  name="$(basename "$run")"
  node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((line) => JSON.parse(line));
const system = lines.find((entry) => entry.type === "message" && entry.message.role === "system").message;
const context = system.sections.project_context ?? "";
const given = context.includes(`${process.cwd()}/AGENTS.md`) && context.includes("AGENTS-MARK: 7f3a");
// Knit 准备的系统提示（角色文件、规范、规则）是不是整份到了 Pi 的系统提示里。
const systemFile = require("fs").readFileSync(process.argv[3], "utf8").trim();
const prepared = (system.sections.addendum ?? "").includes(systemFile);
// 这个环节的规范在里面，别的环节的不在。
const standards = systemFile.includes("测试的名字用中文写。") && !systemFile.includes("提交文案的标题用英文");
console.log(`  ${process.argv[2]} 系统提示里有这个项目的 AGENTS.md: ${given}；有 system.md 的全文: ${prepared}；system.md 里只有这个环节的规范: ${standards}；工具 ${system.toolsAdded.map((tool) => tool.name).join(",")}`);
process.exit(given && prepared && standards ? 0 : 1);
' "$run"session/*.jsonl "$name" "$run"system.md || fail "会话记录里，系统提示带着这个项目的 AGENTS.md 和 Knit 准备的 system.md，其中只有这个环节的规范（${name}）"
  line="$(grep -nx 'AGENTS-MARK: 7f3a' "$run"report.md | head -1 | cut -d: -f1)"
  echo "  $name 报告里的标记在第 ${line:-（没有）} 行；worker.log $(wc -c < "$run"worker.log | tr -d ' ') 字节"
  [ -n "$line" ] || fail "报告里有单独的一行 AGENTS-MARK: 7f3a（${name}）"
done
node --test > "$base/node-test.log" 2>&1 || true
grep -E '^ℹ (tests|pass|fail)' "$base/node-test.log"
grep -q '^ℹ fail 0$' "$base/node-test.log" || fail "node --test 输出里 fail 0"

step knit task close "$id" --result "greet 可以传第二个参数换问候语；两个场景都有测试，node --test 通过；审查结论 pass。"
step knit deliver "$id" --preview
printf 'feat: let greet take a greeting word\n' > "$base/message.txt"
step knit deliver "$id" --authorization "脚本演练：没有真的用户消息" --message-file "$base/message.txt"

echo; echo "提交:"
git log -1 --format='%h %s%n%b'
git show --name-only --format= HEAD
files="$(git show --name-only --format= HEAD)"
for want in greet.mjs greet.test.mjs ".knit/tasks/archive/$(date +%Y-%m)/$(basename "$(dirname "$file")")/task.md"; do
  echo "$files" | grep -qxF "$want" || fail "提交里有 $want"
done
[ "$(git log -1 --format=%B | sed '/^$/d' | tail -1)" = "Knit-Task: $id" ] || fail "提交说明的最后一行是 Knit-Task: $id"
[ -z "$(git status --porcelain)" ] || fail "交付之后工作区是干净的"
step knit task show "$id"
knit task show "$id" | grep -qx '状态: delivered' || fail "knit task show 的状态是 delivered"

# 留给记录用的文件。
mkdir -p "$logs/cli"
cp .knit/tasks/archive/*/*/record.json "$logs/cli/record.json"
for run in .knit/.runtime/runs/*/; do
  mkdir -p "$logs/cli/$(basename "$run")"
  cp "$run"report.md "$run"message.md "$run"system.md "$logs/cli/$(basename "$run")/"
done
echo; echo "场景一通过"
