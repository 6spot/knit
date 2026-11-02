/**
 * 自动修复计数（STATES.md 第4节、DESIGN.md 第4节）。
 * binding 只存 repairCycleId、repairRounds、stopReason，不建独立链文件，
 * 不做 active/paused/finished 状态机——周期是否生效由当前事实推导。
 */
import type { Decision } from "./task.js";

export type RepairGuardReason =
  | "cycle_mismatch"
  | "cycle_stopped"
  | "round_limit_reached"
  | "max_rounds_invalid";

/** 修复计数事实：与 TaskBinding 的对应字段一致。 */
export interface RepairFacts {
  /** 当前周期；null 表示从未有授权修复周期。 */
  repairCycleId: string | null;
  repairRounds: number | null;
  /** 非空表示周期已因该原因停止（达上限、用户暂停或真实阻塞），不自动续跑。 */
  stopReason: string | null;
}

/** 修复轮完成事件：一次修复实施轮真正结束（结果已接收）才累计。 */
export interface RepairEvent {
  kind: "repairRoundCompleted";
  /** 事件所属周期；与事实不符时拒绝，防止旧 run 事件污染新周期。 */
  repairCycleId: string;
}

/** 新周期授权事件：用户明确开启新修复周期或确认新范围。 */
export interface NewCycleEvent {
  kind: "newCycleAuthorized";
  /** 新周期 ID 由调用方分配并持久化；本模块不生成 ID。 */
  repairCycleId: string;
}

/** 周期停止事件：达上限、用户暂停或真实阻塞。 */
export interface StopEvent {
  kind: "stopped";
  stopReason: string;
}

/** 澄清事件：clarify 不构成重置理由（STATES.md 第4节）。 */
export interface ClarifyEvent {
  kind: "clarified";
}

/** 普通恢复事件：resume 不重置计数。 */
export interface ResumeEvent {
  kind: "resumed";
}

export type RepairEventUnion = RepairEvent | NewCycleEvent | StopEvent | ClarifyEvent | ResumeEvent;

/** 事件处理结果：新增计数或停止原因由调用方写回 binding。 */
export type RepairOutcome =
  | { changed: false }
  | { changed: true; repairCycleId: string | null; repairRounds: number | null; stopReason: string | null };

export type RepairDecision = Decision<RepairGuardReason> & { outcome?: RepairOutcome };

/** 项目上限（phases.* 配置）；调用方校验非负。上限 0 表示不允许自动修复。 */
export function repairDecision(facts: RepairFacts, event: RepairEventUnion, maxRounds: number): RepairDecision {
  if (!Number.isInteger(maxRounds) || maxRounds < 0) {
    return { allowed: false, reason: "max_rounds_invalid" };
  }
  switch (event.kind) {
    case "clarified":
    case "resumed":
      // 不重置、不累计：clarify 不开新周期，普通 resume 不重置。
      return { allowed: true, outcome: { changed: false } };
    case "newCycleAuthorized": {
      // 用户明确开启：新周期计数 0，清旧 stopReason。
      return {
        allowed: true,
        outcome: { changed: true, repairCycleId: event.repairCycleId, repairRounds: 0, stopReason: null },
      };
    }
    case "stopped": {
      // 任何当前周期都可停止；停止后主 Agent 不自动续跑。
      return {
        allowed: true,
        outcome: { changed: true, repairCycleId: facts.repairCycleId, repairRounds: facts.repairRounds, stopReason: event.stopReason },
      };
    }
    case "repairRoundCompleted": {
      if (facts.repairCycleId === null || event.repairCycleId !== facts.repairCycleId) {
        // 取消旧 run 只影响其对应周期；事件不得作用于后来新开的周期。
        return { allowed: false, reason: "cycle_mismatch" };
      }
      if (facts.stopReason !== null) {
        // 周期已停：迟到事件不改变事实。
        return { allowed: false, reason: "cycle_stopped" };
      }
      const next = (facts.repairRounds ?? 0) + 1;
      if (next > maxRounds) {
        // 达到上限：写 stopReason，不开始第 maxRounds+1 轮。
        return {
          allowed: false,
          reason: "round_limit_reached",
          outcome: { changed: true, repairCycleId: facts.repairCycleId, repairRounds: facts.repairRounds, stopReason: "repair_round_limit" },
        };
      }
      return { allowed: true, outcome: { changed: true, repairCycleId: facts.repairCycleId, repairRounds: next, stopReason: null } };
    }
  }
}

/** 下一次修复轮是否还允许自动开始（已停周期、达上限均不允许）。 */
export function mayStartRepairRound(facts: RepairFacts, maxRounds: number): Decision<RepairGuardReason> {
  if (!Number.isInteger(maxRounds) || maxRounds < 0) {
    return { allowed: false, reason: "max_rounds_invalid" };
  }
  if (facts.repairCycleId === null) {
    // 从未授权周期：不是本模块的拒绝理由，调用方先取得授权（newCycleAuthorized）。
    return { allowed: true };
  }
  if (facts.stopReason !== null) {
    // 周期已停：具体原因看 stopReason（达上限／用户暂停／阻塞），不自动续跑。
    return { allowed: false, reason: "cycle_stopped" };
  }
  if ((facts.repairRounds ?? 0) >= maxRounds) {
    return { allowed: false, reason: "round_limit_reached" };
  }
  return { allowed: true };
}
