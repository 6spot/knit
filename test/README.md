# 测试

使用 node:test、可控时钟／端口和临时Git仓库。随每个任务增加证明不变量和真实副作用的必要测试，不为每个事件复制四类矩阵，也不以fake证明原生能力。

模型／宿主集成仅在对应任务做最小必要调用，沿已授权本机模型，不静默替换。Git提交、移动、hook、故障注入均在隔离夹具运行；禁止以测试名义修改当前工程历史或其它真实仓库。

私有运行和原生会话保持Git忽略，不把凭据、提示词／工具原文或完整对话纳入公开测试快照。

`npm test` 以普通终端语义运行：脚本清除 `REX_SESSION`、`REX_BLOCK`、`REX_SERVER`、`REX_BIN_DIR`、`TERM_PROGRAM` 与阶段标记 `KNIT_STAGE_RUN_ID`，并把凭据密钥根 `KNIT_KEYS_ROOT` 指向本次运行新建的临时目录（`mktemp -d ${TMPDIR:-/tmp}/knit-test-keys-XXXXXX`，运行结束经 `trap` 删除，不碰 `~/.knit/keys`、不留密钥文件），在 Rex 终端内与普通终端内结果一致；需要 Rex 的用例自行注入假 Rex 环境。单跑测试时同样清除这些变量，例如 `env -u REX_SESSION -u REX_BLOCK -u REX_SERVER -u REX_BIN_DIR -u TERM_PROGRAM -u KNIT_STAGE_RUN_ID KNIT_KEYS_ROOT="$(mktemp -d)" node --test test/<文件>.test.mjs`（用后删除该目录；`credential-integrity.test.mjs` 自建并清理自己的密钥根）。macOS 兼容点（进程组 EPERM、socket 104 字节上限、`/private` 路径别名）见 `macos-compat.test.mjs`。
