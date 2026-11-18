// 把主任务的 design.md 拆成两份：第 1–11 节写成 docs/design/DESIGN.md（现行设计），第 12–14 节留在原处。
// 在仓库根目录运行：node validation/slim-h5-2026-11/split-design.mjs
// 第 1–11 节里讲重写过程和旧 Knit 的说法按下面的表逐条替换，每一条都必须在原文里正好出现一次，否则报错、什么都不写。
// 同时把 AGENTS.md 和主任务 task.md 里指向旧位置的几行改过来。拆过之后再运行会报错。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const TASK = ".knit/tasks/11-14-slim-refactor";
const DESIGN = "docs/design/DESIGN.md";

/** 文件里的 `from` 必须正好出现一次。 */
function replaceOnce(text, from, to, where) {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`${where}：应当正好出现一次，实际 ${count} 次：${from.slice(0, 60)}`);
  return text.replace(from, () => to);
}

const source = readFileSync(`${TASK}/design.md`, "utf8");
const from12 = source.indexOf("## 12. 可以搬的现有代码");
const from15 = source.indexOf("## 15. 还没定的内容");
if (!source.startsWith("# 小核心范围\n") || from12 < 0 || from15 < from12) {
  throw new Error(`${TASK}/design.md 不是拆分之前的样子（可能已经拆过了）`);
}
const intro = source.split("\n")[2];

const EDITS = [
  ["# 小核心范围", "# Knit 设计"],
  [intro, "本文是 Knit 现行的设计：保留什么、不做什么、长什么样。改设计时直接改对应的章节。"],
  ["（来源：`--retry` 与 `--recover-policy` 互相拒绝的死锁）", ""],
  ["`src/application/stage.ts` — 现在拼交接内容的地方", "`src/application/handoff.ts` — 拼交接内容的地方"],
  ["`.knit/tasks/11-14-slim-refactor/design.md#5-交接`", "`docs/design/DESIGN.md#5-交接`"],
  ["「完成条件」沿用现有的 Requirement／Scenario 写法", "「完成条件」用 Requirement／Scenario 写法"],
  ["「待澄清」沿用 `[blocking]`／`[assumed]`", "「待澄清」用 `[blocking]`／`[assumed]`"],
  ["两个字段，代替现在的 `status`、`stage`、`outcome` 三个：", "两个字段："],
  [
    "- 第一版的 `knit init` 不预置规范内容。切换之后再把通用规范放进模板，并在初始化后生成一个引导任务带用户补齐规范（子任务 I1，见第 11 节「延后」）。",
    "- `knit init` 不预置规范内容。把通用规范放进模板、初始化后生成引导任务是延后的功能，见第 11 节。",
  ],
  [
    "（去掉现在的 `--no-context-files`），不加载项目扩展和技能（沿用现状）。",
    "。环节的 `tools` 里没有 `external` 时不加载扩展、技能和 MCP。",
  ],
  ["（依据见 `research/findings.md` 第 9 节）", ""],
  ["格式沿用现在的：", "格式："],
  ["默认是实现、审查两个。现在叫 `check` 的环节改名为 `review`。", "默认是实现、审查两个。"],
  [
    "不保留 `add`／`remove`／`move`／`set-*` 这些修改子命令和 `knit_workflow` 工具。",
    "没有 `add`／`remove`／`move`／`set-*` 这些修改子命令，也没有 `knit_workflow` 工具。",
  ],
  ["；不再像现在这样降级成没有环节的流程。", "。"],
  [
    "- 第一版只在主检出执行，同一时间只跑一个执行者。Worktree 并行之后加回，见第 11 节。",
    "- 只在主检出执行，同一时间只跑一个执行者。Worktree 并行是延后的功能，见第 11 节。",
  ],
  ["（用户 2026-11-17 决定）", ""],
  ["记在 `research/rex-pane.md`", "记在 `.knit/tasks/11-14-slim-refactor/research/rex-pane.md`"],
  ["（用户 2026-11-18 决定：标出来，不拦）", "（标出来，不拦）"],
  ["| list | show | search", "| list | show"],
  ["桥接工具从 9 个减到 3 个：", "桥接有 3 个工具："],
  ["时校验。检索用命令行。", "时校验。"],
  ["当前任务的选择沿用现在的做法，写在 Pi 会话记录里。", "当前任务的选择写在 Pi 会话记录里。"],
  ["（切换之前在 `next/assets/templates/`）", ""],
  [
    "延后，不在第一版，之后作为单独的子任务加回：",
    "延后，之后作为单独的任务加回。表里的行数和用量是重构之前在旧 Knit 上统计的：",
  ],
  [
    "旧实现随旧代码在切换时删除，之后在小核心上重新做；切换到加回之间不能并行",
    "旧实现已经随旧代码删除，要在现在的代码上重新做；加回之前不能并行",
  ],
  ["\n不做：\n", "\n不做。表里的行数和用量是重构之前在旧 Knit 上统计的：\n"],
  [
    "| 现在 `independent` 任务会因 `check_self_modified` 不能完成 |",
    "| 旧 Knit 里 `independent` 任务会因 `check_self_modified` 不能完成 |",
  ],
  ["（用户 2026-11-18 决定）", ""],
];

let current = source.slice(0, from12);
for (const [from, to] of EDITS) current = replaceOnce(current, from, to, `${TASK}/design.md 第 1–11 节`);

const kept = [
  "# 重写怎么进行",
  "",
  "现行的设计在 `docs/design/DESIGN.md`：它是这份文件原来的第 1–11 节，章节号没有变。这里只留重写过程用到的三节，里面说的「第 11 节」指 `docs/design/DESIGN.md` 的第 11 节。",
  "",
  source.slice(from12, from15).trimEnd(),
  "",
].join("\n");

/** 别的文件里跟着改的几行：[文件, 原文, 改成]。 */
const FOLLOW = [
  [
    "AGENTS.md",
    "- [.knit/tasks/11-14-slim-refactor/design.md](.knit/tasks/11-14-slim-refactor/design.md)：现行设计（小核心）；同目录的 [plan.md](.knit/tasks/11-14-slim-refactor/plan.md) 是子任务清单和进度。\n- [docs/history/design/](docs/history/design/)：切换之前的旧 Knit 的规范、架构和状态说明，还没有换成小核心的说明；和上面的设计不一致时以上面的为准。",
    "- [docs/design/DESIGN.md](docs/design/DESIGN.md)：现行设计。\n- [.knit/tasks/11-14-slim-refactor/plan.md](.knit/tasks/11-14-slim-refactor/plan.md)：重构的子任务清单和进度。\n- [docs/history/design/](docs/history/design/)：重构之前的旧 Knit 的规范、架构和状态说明，只作历史档案。",
  ],
  [
    `${TASK}/task.md`,
    "- `design.md` — 小核心范围：保留什么、不做什么、布局、流程与角色文件、返工、完成与交付、命令、规范注入、自举、可搬代码、重写怎么进行",
    "- `docs/design/DESIGN.md` — 现行设计：保留什么、不做什么、布局、流程与角色文件、返工、完成与交付、命令、规范注入、自举\n- `design.md` — 重写过程用到的三节：可搬代码、规模估算、重写怎么进行",
  ],
];
const follow = new Map();
for (const [file, from, to] of FOLLOW) {
  follow.set(file, replaceOnce(follow.get(file) ?? readFileSync(file, "utf8"), from, to, file));
}

mkdirSync("docs/design", { recursive: true });
writeFileSync(DESIGN, `${current.trimEnd()}\n`);
writeFileSync(`${TASK}/design.md`, kept);
for (const [file, text] of follow) writeFileSync(file, text);
console.log(`已写出 ${DESIGN}（替换 ${EDITS.length} 处）；${TASK}/design.md 只留第 12–14 节；另外改了 ${follow.size} 个文件`);
