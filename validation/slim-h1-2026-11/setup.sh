#!/bin/bash
# 用法：setup.sh <名字>
# 在 /tmp/knit-h1/<名字>/ 里建 bin/knit（运行本仓库的 dist）和 proj（knit init 过、写了模型、提交过一次的 Git 仓库）。
# 输出 /tmp/knit-h1/<名字>。
set -euo pipefail
[ -n "${1:-}" ] || { echo "用法：setup.sh <名字>" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
[ -f "$repo/dist/cli/knit.js" ] || { echo "没有 dist：先运行 npm run -s build" >&2; exit 2; }
base="/tmp/knit-h1/$1"
rm -rf "$base"
mkdir -p "$base/bin" "$base/proj"
printf '#!/bin/sh\nexec node "%s/dist/cli/knit.js" "$@"\n' "$repo" > "$base/bin/knit"
chmod +x "$base/bin/knit"
export PATH="$base/bin:$PATH"
cd "$base/proj"
git init -q -b main
git config user.name h1
git config user.email h1@example.invalid
git config commit.gpgsign false
# 提交之后 Git 会在后台整理仓库，和演练无关。
git config maintenance.auto false
cat > greet.mjs <<'JS'
export function greet(name) {
  return `hello ${name}`;
}
JS
cat > AGENTS.md <<'MD'
# 项目约定

- 这是一个没有依赖的小项目，测试用 `node --test`。
- 每份报告正文的第一行写 `AGENTS-MARK: 7f3a`。
MD
knit init > /dev/null
# 两份规范，用来看规范有没有按环节交到执行者和主会话手里。
mkdir -p .knit/standards
cat > .knit/standards/testing.md <<'MD'
---
title: 测试规范
stages: [implement, review]
---

测试的名字用中文写。
MD
cat > .knit/standards/delivery.md <<'MD'
---
title: 交付规范
stages: [deliver]
---

提交文案的标题用英文，以 `feat:`、`fix:` 这样的类型开头。
MD
# 模型写成 provider/模型；不设时是 2026-11-17 演练用的那个。
model="${KNIT_H1_MODEL:-magpie/group/deepseek}"
sed -i.bak "s|^# model: provider/模型\$|model: $model|" .knit/workflow.yaml && rm .knit/workflow.yaml.bak
grep -qxF "model: $model" .knit/workflow.yaml
knit workflow validate > /dev/null
git add -A
git commit -q -m "init"
echo "$base"
