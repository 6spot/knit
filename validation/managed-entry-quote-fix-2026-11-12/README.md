# 受管入口路径转义验证（2026-11-12）

本次实施修复 `resolveManagedKnitCommand` 的两条回退路径：PATH 未命中，以及首个可执行 knit 版本不匹配／探测失败。两者共用一个 POSIX shell 路径 token。安全普通路径保持原样，其他路径以单引号包围，路径内的单引号用闭合、转义、重开表示。未改 CLI 选择、3000ms 默认预算和文件路径身份。

环境：macOS / darwin arm64，Node v26.13.0，包版本 0.1.0。run：`run-3f9e6879f487`；基线 HEAD：`58a2dc25a518befe33bb82804fe2e55eb9b95bf3`。以下是实施自检，独立检查另行执行。

## 方法与结果

先执行 `npm run -s typecheck && npm run -s build`，退出 0；随后串行执行 managed-entry 与 init 单测，不在测试期间重建 dist。最终版本 managed-entry 11/11、init 27/27，均无失败或跳过。`git diff --check` 通过。

测试入口：[test/managed-entry.test.mjs](../../test/managed-entry.test.mjs)。测试真实复制完整 dist，链接安装包 assets、node_modules、package.json；不以 CLI 符号链接代替安装副本。每个用例在自己的临时项目执行 init，从实际生成的 AGENTS 提取入口，再交给 `/bin/sh -c` 执行 `--version`、`task list`、`task list --archive`。三个安装目录乘以三个 PATH 分支，合计 9 个隔离安装、27 次生成命令执行，均退出 0；版本均为 0.1.0。

| 场景 | 实际证据 | 结果 |
| --- | --- | --- |
| R1.S1 安装路径含空格 | `installation with spaces` 分别走 missing、mismatch、failed 分支；版本、任务列表、归档列表成功 | pass |
| R1.S2 引号与 shell 特殊字符 | 目录字面量为 `installation ' "$KNIT_QUOTE_VALUE" $(touch injected)`；环境变量设置为另一个值，确保变量展开会找错路径；三个分支均成功，项目内副作用标记 `injected` 均不存在 | pass |
| R2.S1 cliEntry 保持实际路径 | 9 个安装记录均严格等于 `realpathSync(cli)`；直接读取该文件，并以该路径作为 Node argv 执行 `init --check`，全部成功；随后记录仍是同一实际路径 | pass |
| R2.S2 版本选择与普通路径 | 原有选择测试覆盖匹配时生成 knit、不匹配及缺失时回退；新增明确位于后面的匹配命令与探测标记，确认未探测该命令；普通安装路径三个分支实际可执行，命令字面形式未改变 | pass |

同一 `spaces/missing` 用例还执行了修复前形式（裸 `installation.cliEntry` 加 `--version`），实际退出 127，stderr 指向被截断的 `.../installation`；随后执行 AGENTS 中带引号的命令成功。不是只检查字符串引号。

[results.json](./results.json) 保存最终执行计数、实际生成命令样本、基线失败样本和限制。每次运行测试也会通过 Node test diagnostics 输出实际命令、安装路径、每次调用状态与 stdout；临时目录运行结束后清理，样本路径只作执行证据，不用于复跑。

所有子进程测试先清除宿主 `KNIT_*`、`REX_*`、`TERM_PROGRAM*`，再设置隔离密钥目录；安装用例还设置自身锁根和用于检测变量展开的测试变量。受限 PATH 只放当前 Node 的链接和需要时的假 knit；假 knit 以当前 Node 绝对路径为解释器。未使用用户现存 Rex 关联文件，未在仓库根执行 init，未安装包、提交或推送。

## 可移植复跑

从项目根执行以下命令。测试中的目录由系统临时目录生成，不依赖本机样本路径。typecheck/build 完成后，两个测试文件依次运行。

```sh
npm run -s typecheck && npm run -s build
node --input-type=module <<'NODE'
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const keys = mkdtempSync(join(tmpdir(), 'knit-quote-test-keys-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:KNIT_|REX_|TERM_PROGRAM)/.test(key),
));
try {
  for (const file of ['test/managed-entry.test.mjs', 'test/init.test.mjs']) {
    const result = spawnSync(process.execPath, ['--test', file], {
      env: { ...env, KNIT_KEYS_ROOT: keys }, stdio: 'inherit',
    });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(keys, { recursive: true, force: true });
}
NODE
```

## 范围与交接

本次只改 initialization 的命令表示、managed-entry 测试、ROLE-CONTRACT 第 5 节及本目录证据，保留实施前已有改动。已在 ROLE-CONTRACT 中明确命令表示与文件身份的分离，适用于受管入口初始化；未新增 `.knit/` 规范。

普通／真实 Rex 双终端全量 `npm test`、正式独立检查由主会话在两项补修组合后执行，本 run 未执行。Linux、Windows、其他 shell、Node24、真实 Pi／完整真机和发布矩阵未验证，本材料不作兼容或发布结论。行为用例在 Windows 明确跳过，不增加 Windows 支持承诺。
