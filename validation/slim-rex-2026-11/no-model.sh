#!/bin/bash
# 在真的 Rex 里看窗格的失败和回退，不调用模型：模型不存在、Pi 在窗格里起不来、Pi 卡住不开始、取消、关窗格。
# 要在 Rex 的终端里运行，先运行过 npm run -s build:next。约 50 秒。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
h1="$here/../slim-h1-2026-11"
[ -n "${REX_SESSION:-}" ] && [ -n "${REX_BLOCK:-}" ] || { echo "要在 Rex 的终端里运行" >&2; exit 2; }
base="$("$h1/setup.sh" rex-no-model)"
export PATH="$base/bin:$PATH"
cd "$base/proj"
fail() { echo "不满足：$1" >&2; exit 1; }
# 这个 Rex 会话里现在有哪些浮动窗格：标签、状态、层的 id。
panes() {
  rex --autostart=false api call session.view "{\"session_id\":\"$REX_SESSION\"}" | node -e '
const view = JSON.parse(require("fs").readFileSync(0, "utf8"));
const layers = view.windows.flatMap((window) => window.layers ?? []).filter((layer) => layer.kind === "floating");
console.log(layers.map((layer) => `${layer.blocks[0].label}(${layer.state}) ${layer.layer_id}`).join("\n"));'
}
# 派发，输出这次执行的 id。
start() { knit run start "$id" "$@" > /dev/null; ls -t .knit/.runtime/runs | head -1; }
# 等执行者在窗格里开始。
started() {
  for _ in $(seq 1 100); do [ -f ".knit/.runtime/runs/$1/pane.json" ] && return; sleep 0.1; done
  fail "执行者在窗格里开始（$1）"
}
failure() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runs.at(-1).failure)' .knit/tasks/*/record.json; }
no_leftovers() {
  [ "$(panes)" = "$before" ] || fail "窗格关掉了（$1）"
  if pgrep -fl "run worker|fake-pi|rex.*wait.*block:"; then fail "没有留下进程（$1）"; fi
  echo "  窗格关掉了，没有留下进程"
}
rex version | head -1
before="$(panes)"
id="$(knit task new --title "greet 支持自定义问候语" --slug greet-word --verification independent | sed -n 's/^已创建 //p')"
file="$(echo .knit/tasks/*/task.md)"
{ awk '/^---$/{n++} {print} n==2{exit}' "$file"; echo; cat "$h1/task-body.md"; } > "$file.new"
mv "$file.new" "$file"
knit task ready "$id" > /dev/null

echo; echo "== 一、真的 Pi，模型不存在"
run="$(start --model magpie/no-such-model)"
knit run wait "$id" > /dev/null
echo "  失败: $(failure)"
[ "$(failure)" = "执行者启动失败：Pi 里没有模型 magpie/no-such-model" ] || fail "记为启动失败"
[ -f ".knit/.runtime/runs/$run/pane.json" ] || fail "执行者是在窗格里开始的"
[ ! -s ".knit/.runtime/runs/$run/worker.log" ] || fail "没有回退"
echo "  worker.log 是空的（没有回退）"
no_leftovers 一

echo; echo "== 二、真的 Pi 在窗格里起不来（provider 不认识，Pi 在加载扩展之前退出）"
run="$(start --model nosuch/model)"
knit run wait "$id" > /dev/null
echo "  worker.log: $(cat ".knit/.runtime/runs/$run/worker.log")"
grep -qx "Rex 窗格用不了（执行者没有在窗格里开始），改在后台执行" ".knit/.runtime/runs/$run/worker.log" || fail "回退到后台"
echo "  失败（后台那一次的）: $(failure | head -1 | cut -c1-40)…"
[ ! -f ".knit/.runtime/runs/$run/pane.json" ] || fail "执行者没有在窗格里开始"
no_leftovers 二

# 后面用假的 Pi。窗格里的程序拿不到这里的环境变量，所以包一层。
fake="$here/../../next/test/helpers/fake-pi.mjs"
printf '#!/bin/sh\nKNIT_FAKE_PI=%s exec node %s "$@"\n' "$base/script.json" "$fake" > "$base/fake-pi.sh"
# 在窗格里（命令行里没有 --mode）什么都不做，在后台照常是假的 Pi。
printf '#!/bin/sh\ncase " $* " in *" --mode "*) KNIT_FAKE_PI=%s exec node %s "$@";; esac\nexec sleep 300\n' "$base/script.json" "$fake" > "$base/stuck-pi.sh"
chmod +x "$base/fake-pi.sh" "$base/stuck-pi.sh"

echo; echo "== 三、Pi 在窗格里卡住不开始：20 秒之后回退"
echo '{"texts":["后台做完了。"]}' > "$base/script.json"
export KNIT_PI_BIN="$base/stuck-pi.sh"
began="$(date +%s)"
run="$(start)"
knit run wait "$id" > /dev/null
echo "  用时 $(( $(date +%s) - began )) 秒；worker.log: $(cat ".knit/.runtime/runs/$run/worker.log")"
grep -qx "Rex 窗格用不了（执行者没有在窗格里开始），改在后台执行" ".knit/.runtime/runs/$run/worker.log" || fail "回退到后台"
[ "$(failure)" = "null" ] || fail "后台那一次正常结束"
[ "$(cat ".knit/.runtime/runs/$run/report.md")" = "后台做完了。" ] || fail "报告是后台那一次的"
echo "  后台那一次正常结束，报告: $(cat ".knit/.runtime/runs/$run/report.md")"
if pgrep -fl "stuck-pi|sleep 300"; then fail "卡住的 Pi 被结束了"; fi
no_leftovers 三
# 上一次正常结束，任务到了下一个环节；后面两次派发的是审查环节。

echo; echo "== 四、执行者在窗格里卡着时取消"
echo "{\"waitFor\":\"$base/never\"}" > "$base/script.json"
export KNIT_PI_BIN="$base/fake-pi.sh"
run="$(start)"
started "$run"
status="$(knit run status "$id")"
echo "$status" | tail -1 | sed 's/^/  /'
grep -qx "窗格: Rex 里标着 knit $run 的浮动窗格（最小化着）" <<< "$status" || fail "状态里指出是哪个窗格"
grep -qF "knit $run(minimized)" <<< "$(panes)" || fail "有这个窗格，最小化着"
knit run cancel "$id" | sed 's/^/  /'
[ "$(failure)" = "已取消" ] || fail "记为已取消"
sleep 0.5
no_leftovers 四

echo; echo "== 五、派发之后马上取消（执行者还没有在窗格里开始）"
echo "{\"writes\":[{\"path\":\"late.txt\",\"content\":\"x\"}],\"waitFor\":\"$base/never\"}" > "$base/script.json"
for delay in 0 0.15 0.3 0.45; do
  run="$(start)"
  sleep "$delay"
  had="$([ -f ".knit/.runtime/runs/$run/pane.json" ] && echo 已经开始 || echo 还没有开始)"
  changed="$(knit run cancel "$id" | sed -n 's/^改动文件: //p')"
  [ "$(failure)" = "已取消" ] || fail "记为已取消"
  # 取消返回的时候执行者动没动过工作区：动过的话，记下的改动文件里有它。
  wrote="$([ -f late.txt ] && echo "1 个" || echo "0 个")"
  # 更晚才起来的 Pi 看到后台进程不在了，自己退出，窗格跟着关掉。
  for _ in $(seq 1 50); do [ "$(panes)" = "$before" ] && break; sleep 0.1; done
  sleep 1
  echo "  派发 $delay 秒之后取消（这时执行者${had}）：记下的改动文件 ${changed}"
  [ "$changed" = "$wrote" ] || fail "取消返回时工作区里的改动都记下了"
  [ "$([ -f late.txt ] && echo "1 个" || echo "0 个")" = "$wrote" ] || fail "取消返回之后执行者没有再动工作区"
  rm -f late.txt
  no_leftovers "五，$delay 秒"
done
echo "{\"waitFor\":\"$base/never\"}" > "$base/script.json"

echo; echo "== 六、执行者在窗格里卡着时把窗格关掉"
run="$(start)"
started "$run"
layer="$(panes | grep -F "knit $run(" | awk '{print $NF}')"
rex --autostart=false api call session.close_layer "{\"session_id\":\"$REX_SESSION\",\"layer_id\":\"$layer\"}" > /dev/null
knit run wait "$id" > /dev/null
echo "  失败: $(failure)"
[ "$(failure)" = "执行者的窗格关掉了，没有交报告" ] || fail "记为失败"
no_leftovers 六

echo; echo "通过"
