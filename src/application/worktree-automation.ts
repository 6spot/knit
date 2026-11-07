/**
 * Worker 派发的 Worktree 自动准备（任务 k-da9973a69c20；DESIGN §6/§10/§13）。
 *
 * 只在任务派发的首个配置阶段调用：无绑定且策略 on → 脏守卫 → create → handoff →
 * prepare；自动 create 后中断（绑定已写入、交接未完成）且策略 on → 续做 handoff／prepare；
 * 已交接但未准备、从主检出发起且策略 on → 续做准备。已准备的活动绑定按现有路由使用。
 * 每一步复用现有服务及其回执，失败保留现场并按原原因返回；调用方在成功后才创建 request。
 */
import type { MetadataStore } from "../ports/infrastructure.js";
import type { ProjectConfig } from "./config.js";
import { GuardError } from "./guard-error.js";
import { LockManager } from "../infrastructure/locks.js";
import { RunStore } from "../infrastructure/run-store.js";
import { WorktreeService } from "./worktree-manager.js";
import { WorktreeHandoffService } from "./worktree-handoff.js";
import { WorktreePrepareService, worktreePrepareCurrent } from "./worktree-prepare.js";

/** 派发级 worktree 覆盖；resume 沿用旧请求的已生效策略。 */
export type WorktreePolicyMode = "on" | "off";
export type WorktreePolicySource = "explicit" | "config" | "default" | "resume";

export interface WorktreePolicy {
  policy: WorktreePolicyMode;
  source: WorktreePolicySource;
}

/** 显式覆盖优先；否则项目 worktree.default；缺省 off。 */
export function resolveWorktreePolicy(config: ProjectConfig, override?: WorktreePolicy | null): WorktreePolicy {
  if (override !== undefined && override !== null) {
    return { policy: override.policy, source: override.source };
  }
  const configured = config.worktree?.default;
  if (configured !== undefined) return { policy: configured, source: "config" };
  return { policy: "off", source: "default" };
}

export interface EnsureWorktreeInput {
  root: string;
  taskId: string;
  store: MetadataStore;
  policy: WorktreePolicy;
  /** 本次派发阶段必须是生效流程的首个配置阶段。 */
  firstStage: boolean;
  /** 调用起点是主检出；据此允许从主检出续做未完成的准备。 */
  fromMain?: boolean;
  locksRoot?: string | null;
}

export interface EnsureWorktreeResult {
  /** 本次实际执行了创建／交接／准备中的至少一步。 */
  ensured: boolean;
  /** 任务当前生效的 worktree 路径；未使用 worktree 时为 null。 */
  worktreePath: string | null;
  actions: Array<"create" | "handoff" | "prepare">;
}

function locksOf(root: string | null | undefined): LockManager {
  return new LockManager(root === null || root === undefined ? {} : { root });
}

/**
 * 确保任务在派发前拥有可执行的 worktree。
 *
 * - 尚未到首个配置阶段：不触发（返回 ensured=false）。
 * - 已有绑定：active 且已准备时按现有路由使用；未准备且从主检出发起、策略 on 时续做 prepare；
 *   未交接且策略 on 时续做 handoff + prepare。
 * - 无绑定且策略 on：先核对主检出脏守卫，再 create + handoff + prepare；
 *   脏守卫失败为 `worktree_dirty_source`，手动路径才允许 `--allow-dirty`。
 */
export async function ensureWorktreeForDispatch(input: EnsureWorktreeInput): Promise<EnsureWorktreeResult> {
  if (!input.firstStage) {
    return { ensured: false, worktreePath: null, actions: [] };
  }
  const binding = await input.store.bindings.get(input.taskId);
  if (binding === null) {
    throw new GuardError("unknown_binding", `任务缺少绑定: ${input.taskId}`);
  }
  const registered = binding.worktree ?? null;
  const actions: EnsureWorktreeResult["actions"] = [];

  if (registered === null) {
    if (input.policy.policy !== "on") {
      return { ensured: false, worktreePath: null, actions };
    }
    // 自动路径不搬未提交内容：create 在任务目录之外有改动时返回 worktree_dirty_source；
    // 自动路径永不传 allowDirty，手动 worktree create --allow-dirty 才可覆盖。
    const created = await new WorktreeService({
      store: input.store,
      locks: locksOf(input.locksRoot),
    }).create({ dir: input.root, taskId: input.taskId, guardDirty: true });
    actions.push("create");
    actions.push("handoff");
    await new WorktreeHandoffService({ store: input.store, runs: new RunStore(input.root) })
      .handoff({ dir: input.root, taskId: input.taskId });
    actions.push("prepare");
    await new WorktreePrepareService({ store: input.store, locks: locksOf(input.locksRoot) })
      .prepare({ dir: input.root, taskId: input.taskId });
    return { ensured: true, worktreePath: created.worktree.path, actions };
  }

  if (registered.active === true) {
    // 已交接但未准备：仅当从主检出发起且策略 on 时续做准备（自动创建失败重试）；
    // 从 worktree 起点仍按既有 worktree_not_ready 守卫要求显式 prepare。
    if (input.policy.policy === "on" && input.fromMain === true && !worktreePrepareCurrent(binding)) {
      actions.push("prepare");
      await new WorktreePrepareService({ store: input.store, locks: locksOf(input.locksRoot) })
        .prepare({ dir: input.root, taskId: input.taskId });
      return { ensured: true, worktreePath: registered.path, actions };
    }
    return { ensured: false, worktreePath: registered.path, actions };
  }
  // 自动创建在 create 后中断：绑定已写入但交接未完成，策略 on 时续做。
  if (input.policy.policy !== "on" || worktreePrepareCurrent(binding)) {
    return { ensured: false, worktreePath: registered.path, actions };
  }
  actions.push("handoff");
  await new WorktreeHandoffService({ store: input.store, runs: new RunStore(input.root) })
    .handoff({ dir: input.root, taskId: input.taskId });
  actions.push("prepare");
  await new WorktreePrepareService({ store: input.store, locks: locksOf(input.locksRoot) })
    .prepare({ dir: input.root, taskId: input.taskId });
  return { ensured: true, worktreePath: registered.path, actions };
}
