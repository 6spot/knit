#!/bin/bash
# 场景三：取消正在跑的执行。
set -euo pipefail
# 演练固定走后台执行：在 Rex 终端里跑时不把执行者开到窗格里。
unset REX_SESSION REX_BLOCK
here="$(cd "$(dirname "$0")" && pwd)"
base="$("$here/setup.sh" cancel)"
export PATH="$base/bin:$PATH"
cd "$base/proj"
fail() { echo "不满足：$1" >&2; exit 1; }
now() { python3 -c 'import time; print(time.time())'; }
# 一个进程和它所有的后代。
tree() { echo "$1"; for child in $(pgrep -P "$1" || true); do tree "$child"; done; }

id="$(knit task new --title "取消演练" --slug cancel --verification self | sed -n 's/^已创建 //p')"
file="$(echo .knit/tasks/*/task.md)"
{ awk '/^---$/{n++} {print} n==2{exit}' "$file"; cat <<'MD'

## 目标与范围

这个任务只用来演练取消。按顺序做两步：

1. 用 bash 工具在前台运行 `sleep 613`，等它结束。不要放到后台，不要加超时，不要换成别的命令。
2. 新建文件 `done.txt`，内容是 `done`。

## 完成条件

- `done.txt` 存在。

## 待澄清

## 相关资料
MD
} > "$file.new"
mv "$file.new" "$file"
knit task ready "$id"
knit run start "$id"
worker="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pid)' .knit/.runtime/runs/*/worker.json)"
echo "后台进程: $worker"

started="$(now)"
until pgrep -f "sleep 613" > /dev/null; do
  python3 -c "import sys; sys.exit(0 if $(now) - $started < 180 else 1)" || fail "等了 180 秒，执行者没有运行 sleep 613"
  sleep 1
done
echo "执行者开始运行 sleep 613，用了 $(python3 -c "print(round($(now) - $started, 1))") 秒"
pids="$(tree "$worker")"
echo "取消之前的进程:"
ps -o pid=,ppid=,command= -p $(echo $pids | tr ' ' ',') | cut -c1-150

before="$(now)"
set +e
knit run cancel "$id"
code=$?
set -e
echo "knit run cancel 退出码 ${code}，用了 $(python3 -c "print(round($(now) - $before, 1))") 秒"
[ "$code" = 0 ] || fail "knit run cancel 以退出码 0 返回"
for pid in $pids; do
  if kill -0 "$pid" 2> /dev/null; then fail "进程 $pid 还在：$(ps -o command= -p "$pid" | cut -c1-150)"; fi
done
if pgrep -f "sleep 613" > /dev/null; then fail "sleep 613 还在"; fi
echo "取消之前的 $(echo $pids | wc -w | tr -d ' ') 个进程都不在了"
node -e '
const run = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runs[0];
console.log(`记录: endedAt ${run.endedAt} failure ${run.failure}`);
process.exit(run.endedAt !== null && run.failure === "已取消" ? 0 : 1);
' .knit/tasks/*/record.json || fail "这次执行记为失败，原因是「已取消」"
echo; knit run status "$id"
[ ! -e done.txt ] || fail "done.txt 不存在（执行者没有做到第二步）"
echo; echo "场景三通过"
