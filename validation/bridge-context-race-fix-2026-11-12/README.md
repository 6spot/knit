# 桥接上下文竞态补修验证（2026-11-12）

任务：`k-8fc483a6e41e`。本记录只涉及隔离项目、真实本地 Knit CLI 与公开 Pi API 替身；不调用真实模型，不连接用户 Rex 会话。实施检查不能替代后续 independent 检查或完整真机验收。

## 修复与复现

桥接以进程内递增代际使相关成功写动作之前的上下文请求失效，解除旧请求的共享引用。回包写缓存及返回 fresh 前再次核对代际和原生会话。请求失效后保留当前会话成功缓存作明确标注过期的降级；切换原生会话清除内存缓存。只读查询不触发失效。未增加持久字段、模型调用或产品超时预算。

可移植复现在 `test/bridge-query.test.mjs` 的两个“上下文竞态”用例内：

1. 创建隔离 Git 项目，以普通 `init --pi` 生成桥接；核对生成内容与资产模板一致。
2. 设置主会话选择 A；令预热失败并等它结束，留下合法原生上一轮分节，内存无成功缓存。
3. 启动 A 用户轮次查询；CLI 包装先执行真实 `session context`，写完 `.snapshot.tmp` 后在同目录 rename 为 `.snapshot` 原子发布，再等待 `.release` 才转发已读取的回包。断言快照 taskId 确为 A。
4. 执行只读 status，启动共享用户轮次，再通过桥接成功选择 B；直接查询核心 session context，断言当前选择确为 B。
5. 成功分支取得 B 的新鲜注入／缓存；失败分支让新的 context CLI 返回失败，断言合法原生分节仍存在且标注可能过期。
6. 确认旧用户轮次仍未结束，才释放 A；等待旧用户轮次完成，断言它不被标 fresh。核对两轮共享 A 请求、变更后仅新建 B 查询，共两次 context 调用。
7. 再让下一轮查询失败，成功分支必须回填 B 而非 A；失败分支必须继续保留原生合法分节。两者均标注可能过期，只有一个 marker，无嵌套 `<knit>`，并记录 `context_invalidated` 诊断。

文件信号决定查询读快照／释放回包的顺序，10ms 轮询仅用于观察信号，带有界截止时间；用例不靠长 sleep 猜测执行进度。用例显式使用已有可配置预算 10000ms，产品默认值保持 300ms／无缓存首轮 2000ms／后台刷新 10000ms。

## 运行命令

在仓库根目录，使用已安装的开发依赖：

```sh
npm run -s typecheck
npm run -s build
node --input-type=module <<'NODE'
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const keys = mkdtempSync(join(tmpdir(), 'knit-race-keys-'));
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(KNIT_|REX_|PI_KNIT_)/.test(key)));
env.KNIT_KEYS_ROOT = keys;
try {
  const result = spawnSync(process.execPath,
    ['--test', 'test/bridge-query.test.mjs'], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(keys, { recursive: true, force: true });
}
NODE
```

只复现竞态时，在 `node --test` 后添加 `--test-name-pattern='上下文竞态'`。测试期间不要同时执行会删除共享 `dist` 的 build。

## 初次实施验证（历史记录）

- `npm run -s typecheck`：pass，退出码 0。
- `npm run -s build`：pass，退出码 0。
- 隔离定向竞态回归：pass，2 tests / 2 pass / 0 fail，最终增加“A 仍未完成”的显式断言后重跑，耗时 11300.79125ms。
- 完整 bridge-query 回归：pass，22 tests / 22 pass / 0 fail，耗时 96037.519458ms，进程退出码 0。涵盖用户连续轮次、custom 保留、单次查询、预热共享、超时、原生分节回填、包装还原与观察器回归。完整文件执行后又以最终加强的断言定向重跑竞态，两项均通过。
- 两份桥接 `cmp`：pass，逐字一致；生成桥接在竞态测试中经普通 init 核对一致，无 force，无外部包安装。
- `git diff --check`：pass。
- 实施时第一次完整回归与重新 build 重叠，部分用例报 `MODULE_NOT_FOUND`（共享 dist 在 build 中被删除）；该受干扰结果不作为通过凭据，构建结束后重新运行完整文件。
- 开发测试早期修正了包装识别 `--dev` 参数及 stderr 多行诊断解析；最终验证以修正后的测试为准。

## 全量失败后的夹具修复（run-51484103ba1a）

保留主会话首次全量失败事实：738 项中 736 pass、2 fail；本机原始日志 `/tmp/knit-fix-verification-WTrUsU/ordinary-attempt1.log` 未改写。本轮仅修改测试夹具和本记录，未修改已接收的桥接程序、预算、F2 产物或受管基线。

- 快照半写：原 producer 对 `.snapshot` 直接 `writeFileSync`，先创建／截断文件再写入；consumer 的 exists 检查可能在写完前通过，随后 JSON.parse 读到空串。现在写入同目录临时文件并 rename 发布，不吞解析错误，不加固定等待。
- 清理竞态：`agent_settled` 在完成扫描后 `void refreshTurnContext(ctx)`；`session_shutdown` 同步停止观察器并失效上下文，不等待已启动的 CLI。原测试随后立即递归删除目录，可与真实 CLI 创建 SQLite／运行目录交错，符合 ENOTEMPTY 的竞争条件；原始失败当时没有进程追踪，无法追认具体哪个 PID 写入。
- 测试加载器仅在编译的临时桥接中包装 `runProcess`，登记其 Promise；测试 shutdown 先调用真实 shutdown、等待已排队的 scanChain，再等待全部已登记进程的 close。等待覆盖失效后脱离 contextWork 引用的旧请求，不终止任何外部进程，不改产品 shutdown 语义。观察器失败用例将此清理放在 finally，环境恢复和删目录之前。
- 新增确定性清理用例：预热 CLI 已读取快照后以 gate 挂起，调用 shutdown，断言一个事件循环回合后仍未结束；释放 gate 后等待 shutdown 完成才删项目。不用固定 sleep 推测写入完成。

本轮构建与测试串行。测试启动器仅为子进程移除全部 `KNIT_*`、`REX_*`、`PI_KNIT_*` 环境变量，再设私有 `KNIT_KEYS_ROOT`；worker 自身环境不变。运行时为 Node v26.13.0，日志目录为本机临时目录 `knit-f4-fixture-check-VC7F1S`，不含真实会话或鉴权材料。

本轮实际验证：

- `npm run -s typecheck` → `npm run -s build` 串行执行：pass，退出码 0。
- 清理子进程环境后 `node --test test/bridge-query.test.mjs`：pass，23/23，无失败／跳过，107293.338833ms；`bridge.log` 与 `bridge-result.json` 记录退出码 0。包含两个竞态、确定性后台 CLI 清理、原观察器失败／恢复及全部既有上下文测试。
- `cmp assets/templates/pi/extensions/knit.ts .pi/extensions/knit.ts`、`node --check test/bridge-query.test.mjs`、`git diff --check`：pass。产品预算仍为 300／2000／10000ms。

- 全量并行负载：使用相同子进程环境隔离方式执行 `node --test 'test/*.test.mjs'`，pass，739/739，无失败／取消／跳过，273858.763708ms；`full.log` 与 `full-result.json` 记录退出码 0。两项原失败对应的竞态／观察器用例、新增确定性清理用例均通过。它是本次实施的全量负载自检，不替代主会话后续普通与实际 Rex 各一次 npm test 或独立检查。
- 日志绝对目录：`/var/folders/25/wn233x_93rv9z2jjm9xzfm_00000gn/T/knit-f4-fixture-check-VC7F1S/`。启动器分别记录测试退出码，在前一组成功结束后才启动下一组；私有测试密钥目录在验证后清除。可移植复验使用上方脚本，将参数 `test/bridge-query.test.mjs` 换为 `test/*.test.mjs` 即运行全量。

本轮场景结果：R1.S1／R1.S2／R2.S1 均由两个最终竞态用例验证 pass；R2.S2 由最终整组及全量中的普通轮次、custom、单次查询、超时与包装降级验证 pass；R3.S1 由两份源文件 cmp 和竞态用例内普通隔离 init 的逐字归一对照验证 pass。未执行的独立检查与真实环境验收仍见下方边界。

## 场景与边界

- R1.S1：成功竞态用例，对照核心选择 B，B 注入 fresh 且 marker 不堆叠。
- R1.S2：成功竞态用例，B 缓存先完成、A 最后回包，下一轮失败仍回填 B 并标注过期。
- R2.S1：失败竞态用例，B 查询失败，保留合法原生上一轮分节与过期说明、记录诊断；既有超时用例覆盖 timeout 分支。
- R2.S2：完整 bridge-query 中的连续用户轮次、custom 保留、单次查询、包装还原和超时降级；代码对比确认默认预算未变化，唯一新增状态为内存代际。
- R3.S1：两份源文件 cmp；两个竞态用例对普通隔离 init 生成结果逐字核对（仅将生成的受管 baseline 常量归一为模板占位符）。

尚未执行：新的独立只读检查、主会话安排的普通／真实 Rex 终端各一次全量 npm test、真实 Pi／模型验收和其它平台矩阵。没有改写本仓库 init manifest，没有提交／推送，没有修改 `.knit/` 下的规范或运行凭据。前次实施通过 bash 复制的 `.pi/extensions/knit.ts` 已由主会话显式 include 接收；本轮只改 `test/bridge-query.test.mjs` 和本记录，其余已接收成果保持原样。
