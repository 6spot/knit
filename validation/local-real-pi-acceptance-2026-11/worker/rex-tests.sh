#!/bin/bash
# 本机真实 Pi 验收（k-b9019179b424）R1.S2：Rex 验收终端完整 npm test。
#
# 本脚本是 P0 准备包，由主会话在**本轮新建的 Rex 验收 session/block** 里执行；
# worker 准备阶段不执行 npm ci / test / GUI。
#
# 实际动作（全部写入隔离根，不写当前仓库、不提交 Git）：
#   1. 核对 REX_SESSION/REX_BLOCK、TTY、Node 26、冻结提交与导出基线；
#   2. 从冻结提交导出**第二份**独立源码副本，逐文件核对内容/mode/摘要；
#   3. 在该副本内执行 npm ci、npm test，记录命令/退出码/耗时/测试总数与日志；
#   4. 记录 Rex 定位（session/block/server/bin、应用版本）与终端信息。
#
# 用法（在 Rex 验收 block 内）：
#   bash validation/local-real-pi-acceptance-2026-11/worker/rex-tests.sh
set -Eeuo pipefail

KIND="rex-tests"
TASK_ID="k-b9019179b424"
FROZEN_TREE="2d6801411158253beda3d5016ab0b781d12b37c8"
DEFAULT_REPO="/Users/me/IdeaProjects/knit"
DEFAULT_ISO_ROOT="/tmp/knit-self-acceptance.l9v2Ka"
BASELINE_REL="validation/local-real-pi-acceptance-2026-11/worker/export-manifest.json"

die() {
  printf '\n[失败] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：bash rex-tests.sh [选项]

在本轮 Rex 验收 block 内执行 R1.S2 的 Rex 侧 npm test：
  npm ci、npm test（含 typecheck/build）

选项：
  --repo <目录>       目标仓库，默认 /Users/me/IdeaProjects/knit
  --iso-root <目录>   隔离根，默认 /tmp/knit-self-acceptance.l9v2Ka
  --dry-run           只核对环境与参数，不导出、不安装、不测试，不产生验收证据
  --prepare-only      只导出并核对源码基线，不执行 npm 步骤，不产生验收证据
  -h, --help          显示本帮助

环境变量：KNIT_REPO / KNIT_ISO_ROOT / KNIT_FROZEN_TREE / KNIT_NODE / KNIT_EXPORT_BASELINE
EOF
}

REPO_INPUT="${KNIT_REPO:-$DEFAULT_REPO}"
ISO_INPUT="${KNIT_ISO_ROOT:-$DEFAULT_ISO_ROOT}"
TREE="${KNIT_FROZEN_TREE:-$FROZEN_TREE}"
DRY_RUN=0
PREPARE_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || die "--repo 缺少取值"
      REPO_INPUT="$2"
      shift 2
      ;;
    --iso-root)
      [[ $# -ge 2 ]] || die "--iso-root 缺少取值"
      ISO_INPUT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --prepare-only)
      PREPARE_ONLY=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1（用 --help 查看用法）"
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CHECKER="$SCRIPT_DIR/export-check.mjs"
[[ -f "$CHECKER" ]] || die "缺少同目录的 export-check.mjs；请保持 worker 目录完整"

# ---- Rex 终端真实性守卫 -----------------------------------------------------
if [[ $DRY_RUN -eq 0 && $PREPARE_ONLY -eq 0 ]]; then
  [[ -t 0 && -t 1 ]] || die "必须在真实交互式终端（Rex block）中运行；管道/重定向不能产生 R1.S2 证据"
  [[ -n "${REX_SESSION:-}" ]] || die "缺少 REX_SESSION：请在本轮授权的 Rex 验收 session/block 内运行，不要在普通终端伪造"
  [[ -n "${REX_BLOCK:-}" ]] || die "缺少 REX_BLOCK：请在本轮授权的 Rex 验收 block 内运行"
  printf '[守卫] 交互式 TTY + REX_SESSION=%s + REX_BLOCK=%s（Rex 验收 block）\n' "$REX_SESSION" "$REX_BLOCK"
else
  printf '[模式] %s：跳过终端真实性与 Rex 环境守卫，本 run 不作为 R1.S2 证据\n' \
    "$([[ $DRY_RUN -eq 1 ]] && echo dry-run || echo prepare-only)"
fi

# ---- Node 26 与 npm ---------------------------------------------------------
NODE_CMD="${KNIT_NODE:-$(command -v node || true)}"
[[ -n "$NODE_CMD" ]] || die "PATH 中找不到 node；请安装/激活 Node 26 后重试"
NODE_REAL="$("$NODE_CMD" -p 'process.execPath')"
NODE_VERSION="$("$NODE_REAL" -v)"
NODE_MAJOR="$("$NODE_REAL" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" == "26" ]] || die "本任务只验证 Node 26；当前解析到 ${NODE_VERSION}（${NODE_REAL}）。可用 KNIT_NODE=<node26 可执行文件> 指定"
export PATH="$(dirname "$NODE_REAL"):$PATH"
hash -r
[[ "$(node -p 'process.execPath')" == "$NODE_REAL" ]] || die "PATH 前缀未能让 node 指向 $NODE_REAL"
NPM_BIN="$(command -v npm || true)"
[[ -n "$NPM_BIN" ]] || die "PATH 中找不到 npm（Node 26 自带）"
NPM_VERSION="$(npm -v)"
printf '[环境] node %s（%s）\n[环境] npm %s（%s）\n' "$NODE_VERSION" "$NODE_REAL" "$NPM_VERSION" "$NPM_BIN"

# ---- 仓库与冻结提交 ---------------------------------------------------------
[[ -d "$REPO_INPUT" ]] || die "仓库目录不存在：$REPO_INPUT"
REPO="$(cd "$REPO_INPUT" && pwd -P)"
[[ -d "$REPO/.git" ]] || die "$REPO 不是 Git 仓库"
[[ -f "$REPO/package.json" ]] || die "$REPO 缺少 package.json"
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
[[ "$HEAD_SHA" == "$TREE" ]] || die "HEAD=$HEAD_SHA ≠ 冻结提交 ${TREE}。本轮只验证该提交；请停止并交回主会话确认基线，不要 reset/强推"
git -C "$REPO" cat-file -e "$TREE^{commit}" 2>/dev/null || die "仓库中不存在冻结提交 $TREE"

BASELINE="${KNIT_EXPORT_BASELINE:-$REPO/$BASELINE_REL}"
[[ -f "$BASELINE" ]] || die "缺少导出基线清单：$BASELINE"
BASELINE_COMMIT="$(node -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).commit))' "$BASELINE")"
[[ "$BASELINE_COMMIT" == "$TREE" ]] || die "基线清单 commit=$BASELINE_COMMIT 与冻结提交 $TREE 不一致"
printf '[基线] 冻结提交 %s；导出基线 %s\n' "$TREE" "$BASELINE"

if [[ $DRY_RUN -eq 1 ]]; then
  printf '\n[dry-run] 参数与环境核对通过，未导出、未安装、未测试、未写入任何目录。\n'
  printf '  计划副本：%s/runs/<UTC>--%s/src\n' "$ISO_INPUT" "$KIND"
  printf '  计划步骤：00-export-verify、01-npm-ci、02-npm-test\n'
  printf '  dry-run 结果不能作为 R1.S2 通过证据。\n'
  exit 0
fi

# ---- 隔离根与 run 目录 ------------------------------------------------------
mkdir -p "$ISO_INPUT" || die "无法创建隔离根：$ISO_INPUT"
ISO_ROOT="$(cd "$ISO_INPUT" && pwd -P)"
case "$ISO_ROOT/" in
  "$REPO"/*) die "隔离根不能位于当前仓库内：$ISO_ROOT" ;;
esac
[[ "$ISO_ROOT" != "$REPO" ]] || die "隔离根不能等于当前仓库"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$ISO_ROOT/runs/${STAMP}--${KIND}"
suffix=2
while [[ -e "$RUN_DIR" ]]; do
  RUN_DIR="$ISO_ROOT/runs/${STAMP}--${KIND}-${suffix}"
  suffix=$((suffix + 1))
done
SRC="$RUN_DIR/src"
mkdir -p "$SRC" "$RUN_DIR/logs"
RUN_LOG="$RUN_DIR/run.log"
: > "$RUN_LOG"
: > "$RUN_DIR/steps.tsv"
: > "$RUN_DIR/meta.tsv"

STARTED_ISO="$(date -u +%FT%TZ)"
say() { printf '%s\n' "$*" | tee -a "$RUN_LOG"; }
say "===== $KIND / $TASK_ID ====="
say "startedAt=$STARTED_ISO"
say "runDir=$RUN_DIR"

meta_set() { printf '%s\t%s\n' "$1" "${2:-}" >> "$RUN_DIR/meta.tsv"; }
meta_set kind "$KIND"
meta_set taskId "$TASK_ID"
meta_set isolationRoot "$ISO_ROOT"
meta_set repo "$REPO"
meta_set frozenTree "$TREE"
meta_set startedAt "$STARTED_ISO"
meta_set mode "$([[ $PREPARE_ONLY -eq 1 ]] && echo prepare-only || echo verification)"
meta_set baselineManifest "$BASELINE"

# ---- 仓库工作区指纹 ---------------------------------------------------------
git -C "$REPO" status --porcelain=v1 > "$RUN_DIR/git-status.txt" 2>&1 || true
STATUS_LINES_BEFORE="$(wc -l < "$RUN_DIR/git-status.txt" | tr -d '[:space:]')"
STATUS_SHA_BEFORE="$(shasum -a 256 "$RUN_DIR/git-status.txt" | cut -d' ' -f1)"
DIRTY_OUTSIDE_KNIT="$(grep -vc '^.. \.knit/' "$RUN_DIR/git-status.txt" || true)"
DIRTY_OUTSIDE_KNIT="${DIRTY_OUTSIDE_KNIT:-0}"
if [[ "$DIRTY_OUTSIDE_KNIT" -gt 0 ]]; then
  say "[警告] 工作区有 $DIRTY_OUTSIDE_KNIT 条 .knit/ 之外的未提交改动；导出仍使用冻结提交，不包含这些改动"
fi
meta_set headBefore "$HEAD_SHA"
meta_set statusLinesBefore "$STATUS_LINES_BEFORE"
meta_set statusShaBefore "$STATUS_SHA_BEFORE"

# ---- 环境记录 ---------------------------------------------------------------
PI_BIN="$(command -v pi || true)"
PI_REAL=""
PI_VERSION=""
if [[ -n "$PI_BIN" ]]; then
  PI_REAL="$(node -e 'const fs=require("node:fs");process.stdout.write(fs.realpathSync(process.argv[1]))' "$PI_BIN")"
  PI_VERSION="$("$PI_BIN" --version 2>/dev/null | head -1 || true)"
fi
REX_BIN="$(command -v rex || true)"
if [[ -z "$REX_BIN" && -n "${REX_BIN_DIR:-}" && -x "$REX_BIN_DIR/rex" ]]; then
  REX_BIN="$REX_BIN_DIR/rex"
  say "[警告] PATH 中没有 rex，使用 REX_BIN_DIR 定位；Rex 侧定位记录可能不完整"
fi
REX_REAL=""
if [[ -n "$REX_BIN" ]]; then
  REX_REAL="$(node -e 'const fs=require("node:fs");process.stdout.write(fs.realpathSync(process.argv[1]))' "$REX_BIN")"
fi
REX_APP=""
case "${REX_REAL:-}" in
  */Contents/MacOS/rex) REX_APP="${REX_REAL%/Contents/MacOS/rex}" ;;
esac
REX_APP_VERSION=""
REX_APP_BUILD=""
if [[ -n "$REX_APP" && -f "$REX_APP/Contents/Info.plist" ]]; then
  REX_APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$REX_APP/Contents/Info.plist" 2>/dev/null || true)"
  REX_APP_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$REX_APP/Contents/Info.plist" 2>/dev/null || true)"
fi
TTY_NAME="$(tty 2>/dev/null || echo "(no tty)")"
PKG_VERSION="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version))' "$REPO/package.json")"

capture_env() {
  {
    printf '# 环境记录（Rex 验收 block；只含本地定位，不含密钥/token）\n'
    printf 'generatedAtUtc=%s\n' "$(date -u +%FT%TZ)"
    printf 'kind=%s\nmode=%s\ntaskId=%s\nfrozenTree=%s\n' "$KIND" "$([[ $PREPARE_ONLY -eq 1 ]] && echo prepare-only || echo verification)" "$TASK_ID" "$TREE"
    printf 'repo=%s\nisoRoot=%s\nrunDir=%s\nscript=%s\nshell=%s\nuser=%s\n' "$REPO" "$ISO_ROOT" "$RUN_DIR" "${BASH_SOURCE[0]}" "$BASH_VERSION" "$(id -un)"
    printf '\n## 系统\n'
    sw_vers
    uname -a
    printf 'arch=%s\n' "$(uname -m)"
    printf 'cpu=%s\n' "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"
    printf '\n## Node/npm\nnode=%s\nnodePath=%s\nnpm=%s\nnpmPath=%s\nnpmRootGlobal=%s\n' \
      "$NODE_VERSION" "$NODE_REAL" "$NPM_VERSION" "$NPM_BIN" "$(npm root -g 2>/dev/null || echo unknown)"
    printf '\n## Pi\npiPath=%s\npiRealpath=%s\npiVersion=%s\n' "$PI_BIN" "$PI_REAL" "$PI_VERSION"
    printf '\n## Rex\nrexPath=%s\nrexRealpath=%s\nrexApp=%s\nrexAppVersion=%s\nrexAppBuild=%s\nrexVersionFlag=unsupported\n' \
      "$REX_BIN" "$REX_REAL" "$REX_APP" "$REX_APP_VERSION" "$REX_APP_BUILD"
    printf '\n## 终端\ntty=%s\nTERM_PROGRAM=%s\nTERM_PROGRAM_VERSION=%s\nTERM=%s\nTTY=%s\n' \
      "$TTY_NAME" "${TERM_PROGRAM:-}" "${TERM_PROGRAM_VERSION:-}" "${TERM:-}" "${TTY:-}"
    printf '\n## Rex 环境（本地定位；不含密钥）\n'
    printf 'REX_SESSION=%s\nREX_BLOCK=%s\nREX_SERVER=%s\nREX_BIN_DIR=%s\n' \
      "${REX_SESSION:-<unset>}" "${REX_BLOCK:-<unset>}" "${REX_SERVER:-<unset>}" "${REX_BIN_DIR:-<unset>}"
    printf '\n## Git\nhead=%s\ncommitDate=%s\noriginMain=%s\nstatusLines=%s\nstatusSha256=%s\n' \
      "$HEAD_SHA" "$(git -C "$REPO" log -1 --format='%cI' "$TREE")" \
      "$(git -C "$REPO" rev-parse origin/main 2>/dev/null || echo unknown)" \
      "$STATUS_LINES_BEFORE" "$STATUS_SHA_BEFORE"
    printf 'dirtyOutsideKnit=%s\n' "$DIRTY_OUTSIDE_KNIT"
    printf '\n## TMPDIR\nTMPDIR=%s\n' "${TMPDIR:-}"
    printf '\n## 磁盘\ndf=%s\n' "$(df -h "$ISO_ROOT" | tail -1)"
  } > "$RUN_DIR/env.txt" 2>&1
  cat "$RUN_DIR/env.txt" | tee -a "$RUN_LOG" >/dev/null
  say "[环境] 已写入 $RUN_DIR/env.txt"
}
capture_env

meta_set nodeVersion "$NODE_VERSION"
meta_set nodePath "$NODE_REAL"
meta_set npmVersion "$NPM_VERSION"
meta_set npmPath "$NPM_BIN"
meta_set piVersion "$PI_VERSION"
meta_set piPath "$PI_REAL"
meta_set rexBin "$REX_REAL"
meta_set rexAppVersion "$REX_APP_VERSION"
meta_set rexAppBuild "$REX_APP_BUILD"
meta_set tty "$TTY_NAME"
meta_set termProgram "${TERM_PROGRAM:-}"
meta_set termProgramVersion "${TERM_PROGRAM_VERSION:-}"
meta_set normalTerminal false
meta_set rexSession "${REX_SESSION:-}"
meta_set rexBlock "${REX_BLOCK:-}"
meta_set rexServer "${REX_SERVER:-}"
meta_set packageVersion "$PKG_VERSION"

# ---- 步骤执行器 -------------------------------------------------------------
STEP_FAILURES=0
STEP_CODES=()
run_step() {
  local dir="$1" name="$2"
  shift 2
  local log="$RUN_DIR/logs/${name}.log"
  local start end status elapsed
  start="$(date +%s)"
  {
    printf '\n===== [%s] %s\n' "$(date -u +%FT%TZ)" "$name"
    printf 'cwd=%s\ncommand=%s\n' "$dir" "$*"
  } | tee -a "$RUN_LOG" >/dev/null
  set +e
  ( cd "$dir" && "$@" ) 2>&1 | tee -a "$RUN_LOG" "$log"
  status=${PIPESTATUS[0]}
  set -e
  end="$(date +%s)"
  elapsed=$((end - start))
  printf -- '----- [%s] exit=%d elapsed=%ss\n' "$name" "$status" "$elapsed" | tee -a "$RUN_LOG" >/dev/null
  printf '%s\t%s\t%s\t%s\n' "$name" "$status" "$elapsed" "$*" >> "$RUN_DIR/steps.tsv"
  STEP_CODES+=("$status")
  if [[ "$status" -ne 0 ]]; then
    STEP_FAILURES=$((STEP_FAILURES + 1))
  fi
  return 0
}

# ---- 收尾结果 ---------------------------------------------------------------
ARCHIVE_SHA=""
EXPORT_FILE_COUNT=""
EXPORT_DIGEST=""
TESTS_TOTAL=0
TESTS_PASS=0
TESTS_FAIL=0
TESTS_SKIPPED=0
TESTS_DURATION=""

write_result() {
  cat > "$RUN_DIR/logs/write-result.mjs" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runDir = process.argv[2];
const read = (name) => {
  try {
    return readFileSync(join(runDir, name), "utf8");
  } catch {
    return "";
  }
};
const meta = {};
for (const line of read("meta.tsv").split("\n")) {
  if (line === "") continue;
  const tab = line.indexOf("\t");
  if (tab < 0) continue;
  meta[line.slice(0, tab)] = line.slice(tab + 1);
}
const steps = read("steps.tsv")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [name, exitCode, seconds, ...command] = line.split("\t");
    return { name, exitCode: Number(exitCode), seconds: Number(seconds), command: command.join("\t") };
  });
const tests = {};
for (const line of read("tests-summary.txt").split("\n")) {
  const match = line.match(/^# ([a-z_]+) (.+)$/);
  if (match) tests[match[1]] = Number(match[2]);
}
const num = (value) => (value === undefined || value === "" ? null : Number(value));
const text = (value) => (value === undefined || value === "" ? null : value);
const result = {
  kind: meta.kind,
  taskId: meta.taskId,
  mode: meta.mode,
  preparedBy: "P0 worker run-8d8e0996ecbf",
  ok: meta.ok === "true" ? true : meta.ok === "false" ? false : null,
  verificationStatus: meta.mode === "verification" ? (meta.ok === "true" ? "pass" : "fail") : "not_run",
  startedAt: meta.startedAt,
  finishedAt: meta.finishedAt,
  exitCode: num(meta.exitCode),
  failureReason: text(meta.failureReason),
  isolationRoot: meta.isolationRoot,
  runDir,
  source: {
    repo: meta.repo,
    commit: meta.frozenTree,
    packageVersion: meta.packageVersion,
    archiveSha256: meta.archiveSha256,
    exportManifest: "export-manifest.json",
    exportFileCount: num(meta.exportFileCount),
    exportContentDigest: meta.exportContentDigest,
  },
  environment: {
    nodeVersion: meta.nodeVersion,
    nodePath: meta.nodePath,
    npmVersion: meta.npmVersion,
    npmPath: meta.npmPath,
    piVersion: meta.piVersion,
    piPath: meta.piPath,
    rexBin: meta.rexBin,
    rexAppVersion: meta.rexAppVersion,
    rexAppBuild: meta.rexAppBuild,
  },
  authenticity: {
    tty: meta.tty,
    termProgram: meta.termProgram,
    termProgramVersion: meta.termProgramVersion,
    normalTerminal: meta.normalTerminal === "true",
    rexSession: text(meta.rexSession),
    rexBlock: text(meta.rexBlock),
    rexServer: text(meta.rexServer),
  },
  repo: {
    headBefore: meta.headBefore,
    headAfter: meta.headAfter,
    statusSha256Before: meta.statusShaBefore,
    statusSha256After: meta.statusShaAfter,
    statusLinesBefore: num(meta.statusLinesBefore),
    statusLinesAfter: num(meta.statusLinesAfter),
    unchangedDuringRun: meta.repoUnchanged === "true",
  },
  steps,
  tests,
  packInstall: null,
};
writeFileSync(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(`[结果] 已写入 ${join(runDir, "result.json")}`);
JS
  node "$RUN_DIR/logs/write-result.mjs" "$RUN_DIR" | tee -a "$RUN_LOG"
}

print_summary() {
  local code="$1" reason="$2"
  say ""
  say "================ 结果摘要 ================"
  say "kind=$KIND mode=$([[ $PREPARE_ONLY -eq 1 ]] && echo prepare-only || echo verification)"
  say "runDir=$RUN_DIR"
  say "frozenTree=$TREE archiveSha256=${ARCHIVE_SHA:-<missing>}"
  say "export: ${EXPORT_FILE_COUNT:-?} files, ${EXPORT_DIGEST:-<missing>}"
  say "node=$NODE_VERSION npm=$NPM_VERSION"
  say "rex: session=${REX_SESSION:-<unset>} block=${REX_BLOCK:-<unset>} bin=${REX_REAL:-<missing>} app=${REX_APP_VERSION:-?} build=${REX_APP_BUILD:-?}"
  say "步骤（name exit seconds command）："
  while IFS=$'\t' read -r name step_code seconds command; do
    say "  - $name exit=$step_code ${seconds}s  $command"
  done < "$RUN_DIR/steps.tsv"
  if [[ $PREPARE_ONLY -eq 0 ]]; then
    say "测试：tests=$TESTS_TOTAL pass=$TESTS_PASS fail=$TESTS_FAIL skipped=$TESTS_SKIPPED duration_ms=${TESTS_DURATION:-unknown}"
  else
    say "prepare-only：未执行 npm test，不能作为 R1.S2 证据"
  fi
  say "仓库：HEAD ${HEAD_SHA} -> $(git -C "$REPO" rev-parse HEAD)；工作区指纹 ${STATUS_SHA_BEFORE} -> $(shasum -a 256 <(git -C "$REPO" status --porcelain=v1) | cut -d' ' -f1)"
  say "结果：$([[ $code -eq 0 ]] && echo '成功' || echo '失败')${reason:+（${reason}）}"
  say "证据：${RUN_DIR}（run.log、env.txt、git-status*.txt、export-manifest.json、logs/*.log、result.json）"
  say "=========================================="
}

finish_result() {
  local code="$1" reason="${2:-}"
  local status_after status_sha_after head_after repo_unchanged="true"
  head_after="$(git -C "$REPO" rev-parse HEAD)"
  git -C "$REPO" status --porcelain=v1 > "$RUN_DIR/git-status-after.txt" 2>&1 || true
  status_after="$(wc -l < "$RUN_DIR/git-status-after.txt" | tr -d '[:space:]')"
  status_sha_after="$(shasum -a 256 "$RUN_DIR/git-status-after.txt" | cut -d' ' -f1)"
  if [[ "$head_after" != "$HEAD_SHA" || "$status_sha_after" != "$STATUS_SHA_BEFORE" ]]; then
    repo_unchanged="false"
    code=1
    reason="${reason:+$reason; }运行期间当前仓库的 HEAD/工作区指纹发生变化"
  fi
  meta_set headAfter "$head_after"
  meta_set statusLinesAfter "$status_after"
  meta_set statusShaAfter "$status_sha_after"
  meta_set repoUnchanged "$repo_unchanged"
  meta_set finishedAt "$(date -u +%FT%TZ)"
  if [[ $PREPARE_ONLY -eq 1 ]]; then
    meta_set ok ""
  else
    meta_set ok "$([[ "$code" -eq 0 ]] && echo true || echo false)"
  fi
  meta_set exitCode "$code"
  meta_set failureReason "$reason"
  write_result
  print_summary "$code" "$reason"
  exit "$code"
}

# ---- 导出冻结源码并核对基线 -------------------------------------------------
do_export() {
  git -C "$REPO" archive --format=tar -o "$RUN_DIR/source.tar" "$TREE" || return 1
  tar -xf "$RUN_DIR/source.tar" -C "$SRC" || return 1
  git -C "$REPO" ls-tree -r -z "$TREE" > "$RUN_DIR/ls-tree.bin" || return 1
  node "$CHECKER" --src "$SRC" --ls-tree "$RUN_DIR/ls-tree.bin" \
    --out "$RUN_DIR/export-manifest.json" --commit "$TREE" \
    --expect "$BASELINE" --label "$KIND"
}

say ""
say "===== 导出冻结源码并核对基线（Rex 副本） ====="
run_step "$REPO" "00-export-verify" do_export
if [[ "${STEP_CODES[0]:-1}" -ne 0 ]]; then
  finish_result 1 "导出/基线核对失败（见 logs/00-export-verify.log）"
fi

ARCHIVE_SHA="$(shasum -a 256 "$RUN_DIR/source.tar" | cut -d' ' -f1)"
EXPORT_FILE_COUNT="$(node -e 'const m=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(m.fileCount))' "$RUN_DIR/export-manifest.json")"
EXPORT_DIGEST="$(node -e 'const m=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(m.contentDigest))' "$RUN_DIR/export-manifest.json")"
meta_set archiveSha256 "$ARCHIVE_SHA"
meta_set exportFileCount "$EXPORT_FILE_COUNT"
meta_set exportContentDigest "$EXPORT_DIGEST"
say "[导出] $EXPORT_FILE_COUNT 个文件；tar sha256=${ARCHIVE_SHA}；内容摘要 $EXPORT_DIGEST"

# ---- npm test ---------------------------------------------------------------
if [[ $PREPARE_ONLY -eq 1 ]]; then
  say ""
  say "[prepare-only] 已核对导出基线；未执行 npm ci / npm test。本 run 不是 R1.S2 证据。"
  if [[ $STEP_FAILURES -ne 0 ]]; then
    finish_result 1 "prepare-only 导出/基线核对失败"
  fi
  finish_result 0 ""
fi

say ""
say "===== 执行 Rex 侧 npm test（全部在 $SRC 内） ====="
run_step "$SRC" "01-npm-ci" npm ci --include=dev --no-audit --no-fund
run_step "$SRC" "02-npm-test" npm test

TESTS_LOG="$RUN_DIR/logs/02-npm-test.log"
if [[ -f "$TESTS_LOG" ]]; then
  node -e '
const fs = require("node:fs");
const log = fs.readFileSync(process.argv[1], "utf8");
const keys = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo", "duration_ms"];
const found = new Map();
for (const rawLine of log.split("\n")) {
  const line = rawLine.replace(/\u001b\[[0-9;]*m/g, "");
  const match = line.match(/^(?:#|\u2139)\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+([0-9.]+)$/);
  if (match && !found.has(match[1])) found.set(match[1], match[2]);
}
const summary = keys.filter((key) => found.has(key)).map((key) => `# ${key} ${found.get(key)}`).join("\n");
fs.writeFileSync(process.argv[2], summary === "" ? "" : `${summary}\n`);
' "$TESTS_LOG" "$RUN_DIR/tests-summary.txt"
fi
: >> "$RUN_DIR/tests-summary.txt"
num_stat() {
  awk -v key="$1" '$1 == "#" && $2 == key { value = $3 } END { print value + 0 }' "$RUN_DIR/tests-summary.txt"
}
TESTS_TOTAL="$(num_stat tests)"
TESTS_PASS="$(num_stat pass)"
TESTS_FAIL="$(num_stat fail)"
TESTS_SKIPPED="$(num_stat skipped)"
TESTS_DURATION="$(awk '$1 == "#" && $2 == "duration_ms" { value = $3 } END { print value }' "$RUN_DIR/tests-summary.txt")"
meta_set testsTotal "$TESTS_TOTAL"
meta_set testsPass "$TESTS_PASS"
meta_set testsFail "$TESTS_FAIL"
meta_set testsSkipped "$TESTS_SKIPPED"
meta_set testsDurationMs "$TESTS_DURATION"

# ---- 结果判定 ---------------------------------------------------------------
FAIL_REASONS=""
if [[ $STEP_FAILURES -ne 0 ]]; then
  FAIL_REASONS="有 $STEP_FAILURES 个步骤失败"
fi
if [[ $TESTS_TOTAL -le 0 ]]; then
  FAIL_REASONS="${FAIL_REASONS:+$FAIL_REASONS; }未从 npm test 日志解析到测试总数"
fi
if [[ $TESTS_FAIL -ne 0 ]]; then
  FAIL_REASONS="${FAIL_REASONS:+$FAIL_REASONS; }npm test 失败 $TESTS_FAIL 项"
fi

if [[ -n "$FAIL_REASONS" ]]; then
  finish_result 1 "$FAIL_REASONS"
fi
finish_result 0 ""
