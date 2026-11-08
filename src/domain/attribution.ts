/**
 * 改动来源归属（DESIGN §5.3、OPERATIONS §2.1）：纯函数，不做 IO、不信模型自报。
 *
 * 输入是核心观察到的实际差异 A、报告 paths 字段 R、本 run 原生会话里 write／edit 的目标 T
 * （null 表示会话不可读，全部按来源不明处理）与任务残留（失败／取消 run 留下、指纹是否未变）。
 * 输出三类路径：
 * - attributed：报告列出且属工具写入，正常接收；
 * - unattributed：有差异但来源不明（报告列出的 bash 产物、会话不可读时的全部差异、
 *   指纹已变或来源不明的残留），接收挂起 needs_attention: unattributed_paths；
 * - external：报告未列出、也非工具写入，不并入 scope、不让整轮失败。
 * 声明继承且指纹未变、原 run 由工具写入的残留按“沿用”并入（inherited）。
 * 工具写入却漏报，或报告列出既无差异也非残留的路径，仍判报告不实。
 */

export interface ResidueFact {
  path: string;
  /** 当前指纹与记录残留时一致。 */
  current: boolean;
  /** 留下残留的 run 由 write／edit 写入该路径。 */
  toolWritten: boolean;
}

export interface AttributionInput {
  actual: readonly string[];
  /** 报告 paths 字段（已剔除任务资料）；字段缺失为 null。 */
  reported: readonly string[] | null;
  toolPaths: readonly string[] | null;
  residue: readonly ResidueFact[];
}

export interface AttributionOutcome {
  ok: boolean;
  reason: string | null;
  /** 报告 paths 字段在本规则下应等于的集合（R 中被接受的部分）。 */
  claimed: string[];
  attributed: string[];
  unattributed: string[];
  external: string[];
  inherited: string[];
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export function classifyChangedPaths(input: AttributionInput): AttributionOutcome {
  const actual = new Set(input.actual);
  const reported = new Set(input.reported ?? []);
  const tool = input.toolPaths === null ? null : new Set(input.toolPaths);
  const residue = new Map(input.residue.map((item) => [item.path, item]));
  const attributed: string[] = [];
  const unattributed: string[] = [];
  const external: string[] = [];
  const inherited: string[] = [];
  const falseClaims: string[] = [];
  const unlisted: string[] = [];

  for (const path of reported) {
    if (actual.has(path)) {
      if (tool !== null && tool.has(path)) attributed.push(path);
      else unattributed.push(path);
      continue;
    }
    const left = residue.get(path);
    if (left === undefined) {
      falseClaims.push(path);
      continue;
    }
    // 指纹未变且原 run 由工具写入：沿用并入；指纹已变或来源不明：交主会话确认。
    if (left.current && left.toolWritten) inherited.push(path);
    else unattributed.push(path);
  }
  for (const path of actual) {
    if (reported.has(path)) continue;
    if (tool === null) unattributed.push(path);
    else if (tool.has(path)) unlisted.push(path);
    else external.push(path);
  }

  const actualList = sorted(actual);
  let reason: string | null = null;
  if (falseClaims.length > 0 || unlisted.length > 0) {
    if (input.reported === null) reason = "report_changed_paths_missing";
    else reason = actualList.length === 0 ? "changed_paths_mismatch:zero_diff" : `changed_paths_mismatch:${actualList.join(",")}`;
  }
  return {
    ok: reason === null,
    reason,
    claimed: sorted([...reported].filter((path) => !falseClaims.includes(path))),
    attributed: sorted(attributed),
    unattributed: sorted(unattributed),
    external: sorted(external),
    inherited: sorted(inherited),
  };
}
