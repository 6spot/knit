#!/bin/bash
# 派发之前的几种拒绝：各运行一次 knit run start，记下输出。最后加一种派发之后才失败的：模型不存在。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
base="$("$here/setup.sh" refusals)"
export PATH="$base/bin:$PATH"
cd "$base/proj"
fail() { echo "不满足：$1" >&2; exit 1; }
new() { knit task new --title "$1" --slug "$2" --verification self "${@:3}" | sed -n 's/^已创建 //p'; }
# 给任务写上能确认的需求正文。
body() {
  local file; file="$(grep -l "^id: $1$" .knit/tasks/*/task.md)"
  { awk '/^---$/{n++} {print} n==2{exit}' "$file"; printf '\n## 目标与范围\n\n新建 `%s.txt`。\n\n## 完成条件\n\n- `%s.txt` 存在。\n\n## 待澄清\n\n## 相关资料\n' "$1" "$1"; } > "$file.new"
  mv "$file.new" "$file"
}
# 运行 knit run start，要求它被拒绝。
refused() {
  echo; echo "== $1"; shift
  set +e
  "$@" 2>&1
  local code=$?
  set -e
  echo "退出码 $code"
  [ "$code" != 0 ] || fail "应当被拒绝"
}

draft="$(new "还没有确认" draft)"
refused "需求还没有确认" knit run start "$draft"

blocked="$(new "依赖没有完成" blocked --depends-on "$draft")"
body "$blocked"
knit task ready "$blocked" > /dev/null
refused "依赖的任务没有完成" knit run start "$blocked"

ended="$(new "已经结束" ended)"
body "$ended"
knit task ready "$ended" > /dev/null
knit task close "$ended" --result "演练用，直接记为完成。" > /dev/null
refused "任务已经结束" knit run start "$ended"

plain="$(new "普通任务" plain)"
body "$plain"
knit task ready "$plain" > /dev/null
sed -i '' 's|^model: magpie/group/deepseek$|# model: provider/模型|' .knit/workflow.yaml
refused "流程里没有写模型" knit run start "$plain"
sed -i '' 's|^# model: provider/模型$|model: magpie/group/deepseek|' .knit/workflow.yaml

file="$(grep -l "^id: $plain$" .knit/tasks/*/task.md)"
sed -i '' 's/^priority: .*$/priority: 很高/' "$file"
refused "task.md 写坏了（priority 写成不认识的值）" knit run start "$plain"
echo "这时 knit task list 的最后一行: $(knit task list 2>&1 | tail -1)"

sed -i '' 's/^priority: 很高$/priority: P2/' "$file"
sed -i '' 's/^dependsOn: \[\]$/dependsOn: [k-000000000000]/' "$file"
refused "依赖的任务不存在（手工把 dependsOn 改成一个没有的 id）" knit run start "$plain"
sed -i '' 's/^dependsOn: \[k-000000000000\]$/dependsOn: []/' "$file"

cp .knit/workflow.yaml "$base/workflow.yaml"
echo "stages: [" >> .knit/workflow.yaml
refused "workflow.yaml 写坏了" knit run start "$plain"
cp "$base/workflow.yaml" .knit/workflow.yaml

cp .knit/config.json "$base/config.json"
echo "{" > .knit/config.json
refused "config.json 写坏了" knit run start "$plain"
cp "$base/config.json" .knit/config.json

mkdir "$base/nogit"
cd "$base/nogit"
knit init > /dev/null
sed -i '' 's|^# model: provider/模型$|model: magpie/group/deepseek|' .knit/workflow.yaml
nogit="$(new "不在 Git 仓库里" nogit)"
body "$nogit"
knit task ready "$nogit" > /dev/null
refused "项目不在 Git 仓库里" knit run start "$nogit"

for dir in "$base/proj" "$base/nogit"; do
  [ -z "$(ls "$dir/.knit/.runtime/runs" 2> /dev/null)" ] || fail "被拒绝的派发不留下执行目录（${dir}）"
done
echo; echo "九种情况都被拒绝，没有留下执行目录"

# 模型不存在不是派发之前能发现的：派发成功，执行者启动 Pi 之后在选模型这一步失败。
cd "$base/proj"
echo; echo "== 模型不存在"
knit run start "$plain" --model magpie/no-such-model
knit run wait "$plain"
knit run status "$plain" | grep -q '^失败: 执行者启动失败：.*Model not found' || fail "模型不存在时这次执行记为失败，原因里有 Pi 的说法"
echo "worker.log: $(wc -c < "$(echo .knit/.runtime/runs/*/worker.log)" | tr -d ' ') 字节"
