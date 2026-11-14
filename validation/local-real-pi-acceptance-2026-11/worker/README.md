# P0 准备包：R1.S2 工程校验脚本（本机真实 Pi 验收，2026-11）

对应任务：`k-b9019179b424`（本机真实 Pi 验收）。本目录由本任务的正式 implement worker（`run-8d8e0996ecbf`）准备，**只做导出基线与可执行脚本**；真实终端、安装、Pi/Rex、模型、恢复、Worktree 与 Git 交付由主会话在此包被接收后执行。

> **准备包完成 ≠ 本任务完成。** 本目录没有本机 R1–R9 任何场景的通过结论；worker 未执行 `npm ci`、`npm run typecheck`、`npm run build`、`npm test`、`npm run pack:check`、`npm run pack:install`，未打开 GUI，未调用模型。23 个必验场景在本阶段均为 `not_run`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `normal-engineering.sh` | 在**新开的普通 Terminal.app 窗口**执行 R1.S2 普通终端完整工程校验：导出冻结源码 → `npm ci` → `typecheck` → `build` → `test` → `pack:check` → `pack:install -- --prefix <run>/install-prefix`，逐步记录命令/退出码/耗时/日志。 |
| `rex-tests.sh` | 在**本轮新建的 Rex 验收 session/block**执行 R1.S2 的 Rex 侧校验：另导出一份等价源码 → `npm ci` → `npm test`，记录 Rex 定位与终端信息。 |
| `export-check.mjs` | 两脚本共用的导出核对器：按 `git ls-tree` 记录逐文件核对 mode 与 sha256，生成清单 JSON；传入 `--expect` 时核对 commit/文件数/内容摘要是否等于冻结基线。 |
| `export-manifest.json` | 冻结基线清单：commit `2d68014…`、817 个文件、3 个可执行、内容摘要 `sha256:4ab40c37…`。由 `export-check.mjs` 从 `git archive` 导出生成，供两次真实终端运行比对。 |

脚本只依赖：本机 Node 26、npm、bash（`/bin/bash` 3.2 即可）、git、`shasum`、`tar`、`/usr/libexec/PlistBuddy`（仅读 Rex 应用版本，缺失时留空）。

## 运行前条件

- 基线提交必须是 `2d6801411158253beda3d5016ab0b781d12b37c8`（与 `origin/main`、`git ls-remote` 一致）；工作区可有未提交的 `.knit/` 任务资料，脚本用 `git archive` 导出，**不包含**工作区改动、`node_modules/`、`dist/`、`*.tgz`。
- PATH 中的 `node` 必须是本机 Node 26；脚本强制 major=26，否则拒绝运行（可用 `KNIT_NODE=<node26 路径>` 指定）。
- 隔离根 `/tmp/knit-self-acceptance.l9v2Ka`（realpath `/private/tmp/knit-self-acceptance.l9v2Ka`）已存在；没有则脚本会创建。脚本拒绝把隔离根设在当前仓库内。
- `npm ci` / `npm test` 需要网络访问 npm registry；依赖只装进隔离根内的副本，不动仓库 `node_modules/`。
- 普通终端脚本要求真实 TTY 且无 `REX_*` 环境变量；Rex 脚本要求真实 TTY 且 `REX_SESSION`、`REX_BLOCK` 非空。两者都会拒绝把宿主 shell、管道或重定向当作 GUI 证据。

## 执行（主会话）

普通终端（Terminal.app 新窗口，确认窗口本身是本轮新建的验收窗口）：

```bash
cd /Users/me/IdeaProjects/knit
bash validation/local-real-pi-acceptance-2026-11/worker/normal-engineering.sh
```

Rex（本轮新建的验收 session/block，在该 block 内运行）：

```bash
cd /Users/me/IdeaProjects/knit
bash validation/local-real-pi-acceptance-2026-11/worker/rex-tests.sh
```

可选参数：`--repo <目录>`、`--iso-root <目录>`、`--dry-run`（只核对环境，不写目录）、`--prepare-only`（只导出核对，不跑 npm，结果标 `not_run`）、`-h`。环境变量：`KNIT_REPO`、`KNIT_ISO_ROOT`、`KNIT_FROZEN_TREE`、`KNIT_NODE`、`KNIT_EXPORT_BASELINE`。

两次运行会各自创建独立副本（`<UTC>--normal-engineering` / `<UTC>--rex-tests`），互不共享 `node_modules`、`dist/` 或安装前缀。

### 脚本内部步骤

普通终端：

| 步骤 | 实际命令 |
| --- | --- |
| `00-export-verify` | `git archive` 冻结提交 → `tar -x` 到 run 内 `src/`；`export-check.mjs --expect export-manifest.json` |
| `01-npm-ci` | `npm ci --include=dev --no-audit --no-fund` |
| `02-typecheck` | `npm run typecheck` |
| `03-build` | `npm run build` |
| `04-test` | `npm test` |
| `05-pack-check` | `npm run pack:check` |
| `06-pack-install` | `npm run pack:install -- --prefix <run>/install-prefix` |

`pack:install` 只装到 run 内临时前缀（不落 npm 全局默认位置），随后脚本读取安装入口 `--version`、真实路径与 shebang，并核对版本等于 `package.json` 的 `0.1.0`。

Rex 终端：`00-export-verify`、`01-npm-ci`、`02-npm-test`（`npm test` 本身已包含 typecheck 与 build）。

### 守卫与判定

- HEAD ≠ 冻结提交、隔离根在仓库内、基线清单 commit 不符、导出摘要不符、导出目录多出/缺少文件、mode 不符：立即失败，不跑 npm。
- Node 非 26、无 npm、非 TTY、普通终端带 `REX_*`、Rex 终端缺 `REX_SESSION`/`REX_BLOCK`：立即失败。
- 每次运行前后记录当前仓库 `HEAD` 与 `git status --porcelain` 指纹；运行期间指纹变化判失败（防止基线漂移）。
- 普通终端结果通过需要：7 步全部 exit 0；从 `npm test` 日志解析到 `tests > 0` 且 `fail = 0`（Node 26 默认 spec 报告用 `ℹ tests …`，脚本去 ANSI 后与 TAP 的 `# tests …` 一同归一化）；安装入口存在、解析到 run 内前缀、`--version` 等于包版本；tarball 存在且有 sha256。
- Rex 结果通过需要：3 步全部 exit 0；从 `npm test` 日志解析到 `tests > 0` 且 `fail = 0`（与普通终端同一解析口径）。
- 测试总数从**本轮实际日志**解析，不预填历史数字（旧记录 719/719 与 739/739 都不属于本轮）。

## 产物与证据

每次运行在隔离根下生成：

```text
<iso-root>/runs/<UTC>--<kind>/
  env.txt                 # 系统/Node/npm/Pi/Rex/终端/Git/磁盘快照（不含密钥）
  git-status.txt          # 运行前仓库工作区指纹
  git-status-after.txt    # 运行后指纹（应与运行前一致）
  source.tar              # git archive 冻结提交（sha256 记录在 result.json）
  ls-tree.bin             # git ls-tree -r -z 原始记录
  export-manifest.json    # 本次导出逐文件清单（与仓库内基线比对）
  src/                    # 本次专用源码副本（npm ci 后含 node_modules）
  install-prefix/         # 普通终端 run 的临时安装前缀
  logs/00-…~06-….log     # 每步完整日志
  logs/write-result.mjs   # 生成 result.json 的小工具
  tests-summary.txt       # 从 npm test 日志提取的 # tests/pass/fail 等
  steps.tsv               # name / exitCode / seconds / command
  meta.tsv                # result.json 的原始键值
  run.log                 # 终端完整输出（与各步日志相加）
  result.json             # 机读结论：ok / verificationStatus / steps / tests / 安装 / 仓库指纹
```

摘要直接打印在终端并写入 run.log。

`result.json` 关键字段：`mode`（`verification` / `prepare-only`）、`ok`、`verificationStatus`、`steps[]`、`tests{}`、`packInstall{}`、`source.archiveSha256`、`source.exportContentDigest`、`repo.unchangedDuringRun`、`authenticity`（tty、TERM_PROGRAM、REX session/block）。

回传要求：主会话接收本包后，把两次运行的 `result.json`、`env.txt`、`tests-summary.txt` 与必要的日志摘要（脱敏）放到 `validation/local-real-pi-acceptance-2026-11/main/`；原始日志留在隔离根，引用时写清路径。`env.txt` / `result.json` 含本机绝对路径与 Rex session/block 定位，**不含** token、密钥或 `auth.json` 内容；仍按原始证据处理，不整包复制敏感环境。

## 准备时的本机环境快照（2026-11-12 19:04–19:07Z / 本机 2026-11-13 03:04–03:07 +08）

| 项 | 实测值 |
| --- | --- |
| macOS | 27.2.1（build 26B131），arm64 |
| Node | v26.13.0，`/opt/homebrew/Cellar/node/26.13.0_2/bin/node` |
| npm | 11.20.0，`/opt/homebrew/Cellar/node/26.13.0_2/bin/npm` |
| Pi | 1.5.2，`/Users/me/.pi/agent/bin/pi`（`~/.local/bin/pi` 为其符号链接） |
| Rex CLI | `…/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex` |
| Rex 应用 | `CFBundleShortVersionString=0.1.0`，`CFBundleVersion=1913`；`rex --version` 不支持 |
| Rex 终端 | 本轮准备会话 `TERM_PROGRAM=rex`、`TERM_PROGRAM_VERSION=0.1.0-preview.14` |
| Git | HEAD/origin/main = `2d6801411158253beda3d5016ab0b781d12b37c8`；提交时间 2026-11-13T01:49:49+08:00 |
| 导出 | 817 文件、3 可执行、0 符号链接；内容摘要 `sha256:4ab40c37a2336290991af554e5ebd0722bc9ab8db0b44bf8db9eed4ea71554d5`；`git archive` tar sha256 `1782a171ffe1361cddedb305e4f3b5b53e48cdc769c3d6d5f706e40430605c57` |

与 task/plan 文本的差异（以实测为准，worker 不改任务资料）：

- plan 写 Node `v26.3.0` / npm `11.16.0`；本次实测 `v26.13.0` / `11.20.0`，仍是 Node 26、`engines >=24` 未变。主会话在 R1.S1 基线中记录实际值。
- plan 写 Rex `0.1.0-preview.14/API 12`；Rex 应用 bundle 实测为 `0.1.0 (1913)`，`TERM_PROGRAM_VERSION` 为 `0.1.0-preview.14`。本包只记录这两个实际来源，不推断 API 12。
- 工作区当时有 2 个已跟踪 `.knit` 文件改动与若干未跟踪任务目录，均未进入导出（`git archive` 只取提交内容）。运行脚本时若出现 `.knit/` 之外的脏文件，`env.txt` 会记 `dirtyOutsideKnit`，但导出仍只取冻结提交。

## 本阶段实际执行的自检（不等于场景验证）

已执行且结果：

1. `/bin/bash -n` 语法检查两份脚本、`node --check export-check.mjs`：通过。
2. `normal-engineering.sh --dry-run`、`rex-tests.sh --dry-run`：均 exit 0，只核对 Node/仓库/基线，未写目录。
3. `export-check.mjs` 对真实导出生成基线清单：817 文件与基线一致。
4. 两个脚本 `--prepare-only`：各自从冻结提交导出并核对成功；`result.json` 为 `mode=prepare-only`、`ok=null`、`verificationStatus=not_run`，并记录仓库 HEAD/工作区指纹前后一致。产物在 `prep/selfcheck/`，**不是** `runs/` 下的验收结果。
5. 负例：篡改基线 `contentDigest` 后 `--prepare-only` exit 1 且写明差异；改动导出文件内容 / 去掉可执行位后 `export-check.mjs` 分别报内容摘要不符 / mode 不符，均 exit 1。
6. 守卫抽检：在 Rex 环境中用 pty 运行普通终端脚本（不带 `--dry-run`），在 TTY 检查后因 `REX_*` 被拒绝，未进入导出或 npm。

未执行（不得当作通过）：任何 `npm ci` / typecheck / build / test / pack / install；任何 GUI 目视确认；任何 Pi/Rex 会话、模型、通知、取消恢复、Worktree、Git 交付；R1–R9 全部 23 个场景。

## 限制与注意事项

- 脚本本身无法证明“窗口是主会话新建的”。R1.S2 的 GUI 真实性仍需主会话对窗口/终端截图或等价证据负责；脚本只提供 TTY 与 `TERM_PROGRAM`、`REX_SESSION`/`REX_BLOCK` 记录。
- 普通终端脚本在 Terminal.app 新窗口中运行；如果通过 Rex 的 `rex send` 或宿主 shell 启动，会因 `REX_*` 或非 TTY 被拒绝。
- `npm test` 的脚本内部会 `env -u REX_SESSION -u REX_BLOCK …` 再启动测试进程，因此 Rex 侧运行证明的是“在实际 Rex 终端里跑通完整测试”，不是“测试进程读取了 Rex 注入”。
- `npm run pack:install` 需要网络且会在 run 内保留 tarball 与安装前缀；它内部会再跑一次 `npm ci` 与 `npm pack`（prepack 触发 build），因此比单独构建慢；不会执行 `npm publish`，不改全局 npm 前缀。
- 两次运行各自导出同一提交，`archiveSha256` 与 `exportContentDigest` 应一致；不一致说明基线被污染，应停止并交回主会话。
- 测试总数来自 node test runner 的摘要行（Node 26 默认 `spec` 报告为 `ℹ tests/# pass/# fail`，TAP 为 `# tests …`；脚本去 ANSI 后统一为 `# key value`，并去重）。若上游输出格式变化导致解析不到，脚本判失败并保留原始日志，不猜测数字。
- 脚本拒绝在 HEAD 不等于冻结提交时运行。若需要改用其它提交，必须先由主会话重新生成基线清单并更新 `KNIT_FROZEN_TREE`，不得在本轮验收中移动基线。
- `prep/` 下是准备期自检产物（prepare-only run 与篡改基线），主会话可保留或删除；`runs/` 只应出现真实验收运行。
