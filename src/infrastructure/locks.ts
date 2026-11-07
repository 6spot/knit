/**
 * 本机共享锁（OPERATIONS.md 第2节）。
 * 锁根 ~/.knit/locks/：projects/<项目根摘要>/、sessions/<客户端及原生身份摘要>/，
 * 目录 0700、owner 文件 0600。mkdir 抢占式占用；owner.json 记录协议、token、
 * 动作／run、机器／启动标识、PID 与进程开始时间；心跳原子更新；释放核对 token。
 * 只读查询（status/doctor/init --check）不建目录——检查入口是 inspect。
 * 不跨机、不对心跳超时强解；强解是显式风险操作（unlock 命令层处理）。
 * acquire 遇到已存在目录时核实 owner：同一启动周期且 owner（含登记的阶段进程）确认已死，
 * 在目录内 mkdir 回收守卫后原子改名进 reclaimed/ 并重建，留下 reclaim.json 记录；unknown 仍 busy。
 * acquire 任一键失败逆序撤销本次重入引用和新建资源，含 owner 未落盘的目录；
 * unlock --force 可清除「目录在而 owner 不可核实」的残留，正常 token 校验路径不变。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite, readWithVersion } from "./atomic.js";
import { procStartTicks, machineBootId, sameProcessStart } from "./process.js";

export { procStartTicks } from "./process.js";
import { hashKey } from "./paths.js";
import { InfrastructureError } from "./errors.js";

const OWNER_PROTOCOL = 1;
/** 回收区：与锁目录同一文件系统，改名原子；保留最近若干条回收记录供诊断。 */
const RECLAIM_DIR = "reclaimed";
const RECLAIM_GUARD = ".reclaiming";
const RECLAIM_KEEP = 50;
/** 回收守卫残留宽限：正常回收在毫秒级完成，超过即视为回收者崩溃。 */
const RECLAIM_GUARD_STALE_MS = 60_000;
const LOCK_HASH = /^[0-9a-f]{32}$/;
/** 会在多机或非原子目录语义下失效的远程文件系统；本机锁不冒充跨机协调。 */
const REMOTE_FS_TYPES = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x65735546]);

export interface ProcessIdentity {
  pid: number;
  /** /proc/<pid>/stat 第 22 字段（starttime）；PID 复用时不同。取不到为 null。 */
  procStartTicks: string | null;
  /** 本机机器与本次 OS 启动标识。 */
  machineBootId: string;
}

export interface LockOwner {
  protocol: number;
  token: string;
  action: string;
  /** 新记录保存业务键，便于只读列表与人工 unlock；旧 owner 可能缺失。 */
  scope?: LockScope;
  rawKey?: string;
  machineBootId: string;
  pid: number;
  procStartTicks: string | null;
  startedAt: string;
  heartbeatAt: string;
  /**
   * 持锁者登记的附属进程（如阶段 Pi）；owner 已死而附属进程仍在时不视为可回收。
   * 旧 owner 没有该字段。
   */
  attached?: Array<{ pid: number; procStartTicks: string | null }>;
}

/** 自动回收记录：写入回收区 reclaim.json，只读诊断（locks／doctor）展示。 */
export interface LockReclaimRecord {
  schemaVersion: 1;
  /** 原锁 ID：scope/hash。 */
  id: string;
  scope: LockScope;
  key: string | null;
  reclaimedAt: string;
  reason: "owner_not_alive";
  reclaimedBy: { pid: number; procStartTicks: string | null; machineBootId: string; action: string };
  previousOwner: LockOwner;
  /** 回收区内目录名（相对锁根 reclaimed/）。 */
  archive: string;
}

/** 锁范围：项目执行占用、Session 跨项目占用、任务文件短占用。 */
export type LockScope = "project" | "session" | "task";

export interface LockKey {
  scope: LockScope;
  /** project: 规范化项目根；session: 客户端与原生 ID 的组合键。 */
  rawKey: string;
}

export interface AcquireRequest {
  keys: LockKey[];
  action: string;
}

export interface AcquiredLock {
  /** 首键的 owner token；混合重入的逐键凭据见 ownerTokens。 */
  token: string;
  keys: LockKey[];
  ownerPaths: string[];
  /** 与 keys 同序；旧的单 token 句柄可省略。owner 文件协议不变。 */
  ownerTokens?: string[];
  /** 获取时各 owner 文件的 SHA-256；心跳用它与当前内容比对，检测并发篡改。 */
  ownerVersions: string[];
  /** 本次获取时自动回收的残留锁；调用方可写入自己的诊断事件。 */
  reclaimed?: LockReclaimRecord[];
}

export interface LockStatus {
  exists: boolean;
  owner: LockOwner | null;
  /** 进程身份与 owner 记录是否一致；未知不冒充死亡。 */
  processVerdict: "alive" | "not_alive" | "unknown";
}

export interface LockEntry extends LockStatus {
  scope: LockScope;
  /** 稳定展示 ID：scope/hash。 */
  id: string;
  hash: string;
  path: string;
  /** owner 缺失时为 null；旧记录可能没有业务键。 */
  key: string | null;
}

/** 进程内回收观察者：CLI 诊断（--dev）订阅，任何入口的自动回收都能留下诊断事件。 */
const reclaimListeners = new Set<(record: LockReclaimRecord) => void>();

export function onLockReclaimed(listener: (record: LockReclaimRecord) => void): () => void {
  reclaimListeners.add(listener);
  return () => reclaimListeners.delete(listener);
}

/** 心跳观察：超过阈值只表示可疑，不触发回收（回收仍以进程核实为准）。 */
export type HeartbeatState = "fresh" | "stale" | "unknown";

export function heartbeatState(owner: LockOwner | null, nowMs: number, staleMs: number): HeartbeatState {
  if (owner === null) return "unknown";
  const at = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(at)) return "unknown";
  return nowMs - at > staleMs ? "stale" : "fresh";
}

/** lock-id（scope/hash）解析；非法返回 null。 */
export function parseLockId(id: string): { scope: LockScope; hash: string } | null {
  const [scope, hash, extra] = id.split("/");
  if (extra !== undefined || hash === undefined || !LOCK_HASH.test(hash)) return null;
  if (scope !== "project" && scope !== "task" && scope !== "session") return null;
  return { scope, hash };
}

/** /proc/<pid>/stat starttime；空格包裹的 comm 字段内可能含空格，取最后一个 ')' 之后解析。 */
export function currentIdentity(): ProcessIdentity {
  const pid = process.pid;
  return { pid, procStartTicks: procStartTicks(pid), machineBootId: machineBootId() };
}

export interface LockManagerOptions {
  /** 覆盖锁根；测试注入临时目录。默认 ~/.knit/locks。 */
  root?: string;
  identity?: ProcessIdentity;
  now?: () => Date;
}

interface HeldLock {
  token: string;
  ownerVersion: string;
  action: string;
  count: number;
}

type AcquireUndo =
  | { kind: "reentered"; heldKey: string; held: HeldLock }
  | { kind: "created"; heldKey: string; dir: string; token: string; held?: HeldLock };

export class LockManager {
  private readonly root: string;
  private readonly identity: ProcessIdentity;
  private readonly now: () => Date;
  /** 本实例已持键的引用计数重入记录（任务029）：同实例串行栈可重入，跨实例仍互斥。 */
  private readonly heldBySelf = new Map<string, HeldLock>();

  private heldKey(key: LockKey): string {
    return `${key.scope}\u0000${hashKey(key.rawKey)}`;
  }

  constructor(options: LockManagerOptions = {}) {
    this.root = options.root ?? join(homedir(), ".knit", "locks");
    this.identity = options.identity ?? currentIdentity();
    this.now = options.now ?? (() => new Date());
  }

  private scopeDir(scope: LockScope): string {
    return join(this.root, scope === "project" ? "projects" : scope === "task" ? "tasks" : "sessions");
  }

  private lockDir(key: LockKey): string {
    return join(this.scopeDir(key.scope), hashKey(key.rawKey));
  }

  /** 锁根本机路径；只读，用于把运行占用目录排除在业务脏守卫之外。 */
  get rootPath(): string {
    return this.root;
  }

  /**
   * 依次取得全部键：目录 0700，owner.json 0600 原子写。
   * 任一键失败逆序撤销本次新增引用与资源；删除目录时核对对应 token。
   * 固定顺序由调用方给定数组顺序决定；同类多键先排序再传入由调用方负责（本模块按给定顺序）。
   */
  /** acquire 前建立私有锁根并拒绝已知远程文件系统；只读 inspect 不调用。 */
  private ensureRoot(): void {
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new InfrastructureError("io_error", `锁根不可创建: ${this.root}`, { cause: code ?? String(error), permission: code === "EACCES" || code === "EPERM" });
    }
    try {
      const type = statfsSync(this.root).type;
      if (REMOTE_FS_TYPES.has(type)) {
        throw new InfrastructureError("lock_fs_unsupported", `锁根位于不支持本机原子占用的文件系统: 0x${type.toString(16)}`, { root: this.root, fsType: type });
      }
    } catch (error) {
      if (error instanceof InfrastructureError) throw error;
      // statfs 不可用时无法证明本机原子条件；保守拒绝，不静默降级。
      throw new InfrastructureError("lock_fs_unsupported", `无法核实锁根文件系统: ${this.root}`, { cause: error instanceof Error ? error.message : String(error) });
    }
  }

  async acquire(request: AcquireRequest): Promise<AcquiredLock> {
    if (request.keys.length === 0) {
      throw new InfrastructureError("lock_busy", "no lock keys requested");
    }
    let token: string | null = null;
    const startedAt = this.now().toISOString();
    const ownerPaths: string[] = [];
    const ownerTokens: string[] = [];
    const ownerVersions: string[] = [];
    const reclaimed: LockReclaimRecord[] = [];
    /** 只记录本次实际完成的步骤；mkdir 后立即登记，覆盖 owner 写失败。 */
    const undo: AcquireUndo[] = [];
    try {
      this.ensureRoot();
      for (const key of request.keys) {
        const dir = this.lockDir(key);
        // 同实例已持同键且同一动作：串行栈重入（接收→检查点收敛），计数 +1；
        // 不同动作视为竞争，仍 busy（任务029）。
        const heldKey = this.heldKey(key);
        const held = this.heldBySelf.get(heldKey);
        if (held !== undefined && held.action === request.action) {
          held.count += 1;
          undo.push({ kind: "reentered", heldKey, held });
          ownerPaths.push(join(dir, "owner.json"));
          ownerTokens.push(held.token);
          ownerVersions.push(held.ownerVersion);
          if (token === null) token = held.token;
          continue;
        }
        const created: Extract<AcquireUndo, { kind: "created" }> = {
          kind: "created", heldKey, dir, token: token ?? randomUUID(),
        };
        // mkdir 是占用原语：已存在时只回收「同一启动周期且确认已死」的 owner，其余 busy；
        // 不在进程中等待旧工具。回收竞争有限次重试，仍失败按 busy 报告。
        let reclaimAttempts = 0;
        for (;;) {
          try {
            mkdirSync(dir, { recursive: false, mode: 0o700 });
            token = created.token;
            undo.push(created);
            break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EEXIST") {
              const outcome = reclaimAttempts < 3 ? this.tryReclaim(key, dir, request.action) : { reclaimed: null, retry: false };
              reclaimAttempts += 1;
              if (outcome.reclaimed !== null) {
                reclaimed.push(outcome.reclaimed);
                continue;
              }
              if (outcome.retry) continue;
              throw this.busyError(key, dir);
            }
            if (code === "ENOENT") {
              mkdirSync(this.scopeDir(key.scope), { recursive: true, mode: 0o700 });
              continue;
            }
            throw error;
          }
        }
        const owner: LockOwner = {
          protocol: OWNER_PROTOCOL,
          token: created.token,
          action: request.action,
          scope: key.scope,
          rawKey: key.rawKey,
          machineBootId: this.identity.machineBootId,
          pid: this.identity.pid,
          procStartTicks: this.identity.procStartTicks,
          startedAt,
          heartbeatAt: startedAt,
        };
        const ownerPath = join(dir, "owner.json");
        const written = this.writeOwner(ownerPath, owner);
        ownerPaths.push(ownerPath);
        ownerTokens.push(token);
        ownerVersions.push(written.sha256);
        created.held = { token: owner.token, ownerVersion: written.sha256, action: request.action, count: 1 };
        this.heldBySelf.set(heldKey, created.held);
      }
    } catch (error) {
      this.rollbackAcquire(undo);
      throw error;
    }
    const acquired: AcquiredLock = { token: token as string, keys: [...request.keys], ownerPaths, ownerTokens, ownerVersions };
    if (reclaimed.length > 0) acquired.reclaimed = reclaimed;
    return acquired;
  }

  /**
   * 残留锁是否可自动回收：owner 记录完整、同一启动周期、owner 进程确认已死，
   * 且登记的附属进程（阶段 Pi 等）也都确认已死。任何 alive／unknown 都不回收。
   */
  reclaimable(status: LockStatus): boolean {
    if (!status.exists || status.owner === null || status.processVerdict !== "not_alive") return false;
    if (status.owner.machineBootId !== this.identity.machineBootId) return false;
    for (const item of status.owner.attached ?? []) {
      if (this.verifyPid(item.pid, item.procStartTicks) !== "not_alive") return false;
    }
    return true;
  }

  /**
   * 回收一个已存在的锁目录：先核实可回收，再在目录内 mkdir 回收守卫（并发回收者互斥），
   * 守卫内复核 owner token 未变后原子改名进回收区，写 reclaim.json。
   * 返回 retry=true 表示现场在核实期间变化（目录消失、owner 替换），调用方重新 mkdir。
   */
  private tryReclaim(key: LockKey, dir: string, action: string): { reclaimed: LockReclaimRecord | null; retry: boolean } {
    const status = this.inspectDir(dir);
    if (!status.exists) return { reclaimed: null, retry: true };
    if (!this.reclaimable(status) || status.owner === null) return { reclaimed: null, retry: false };
    const guard = join(dir, RECLAIM_GUARD);
    try {
      mkdirSync(guard, { recursive: false, mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { reclaimed: null, retry: true };
      // 回收者在守卫与改名之间崩溃会留下守卫；超过宽限才清除并重试，其余按 busy 报告。
      if (code === "EEXIST") {
        try {
          if (this.now().getTime() - statSync(guard).mtimeMs > RECLAIM_GUARD_STALE_MS) {
            rmdirSync(guard);
            return { reclaimed: null, retry: true };
          }
        } catch {
          return { reclaimed: null, retry: true };
        }
      }
      return { reclaimed: null, retry: false };
    }
    const releaseGuard = (path: string) => {
      try {
        rmdirSync(path);
      } catch {
        // 守卫已随目录移走或被删除
      }
    };
    const fresh = this.inspectDir(dir);
    if (fresh.owner === null || fresh.owner.token !== status.owner.token) {
      releaseGuard(guard);
      return { reclaimed: null, retry: true };
    }
    const hash = hashKey(key.rawKey);
    const stamp = this.now().toISOString().replace(/[-:.]/g, "");
    const archiveName = `${stamp}-${key.scope}-${hash}-${randomUUID().slice(0, 8)}`;
    const archiveRoot = join(this.root, RECLAIM_DIR);
    const archive = join(archiveRoot, archiveName);
    try {
      mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
      renameSync(dir, archive);
    } catch {
      releaseGuard(guard);
      return { reclaimed: null, retry: true };
    }
    // 改名对象必须仍含本次守卫：否则期间目录被删除并由他人重建，立即改名还原后重试。
    if (!existsSync(join(archive, RECLAIM_GUARD))) {
      try {
        renameSync(archive, dir);
      } catch {
        // 还原失败：原位已有新目录，回收区保留该副本供人工核实
      }
      return { reclaimed: null, retry: true };
    }
    releaseGuard(join(archive, RECLAIM_GUARD));
    const record: LockReclaimRecord = {
      schemaVersion: 1,
      id: `${key.scope}/${hash}`,
      scope: key.scope,
      key: fresh.owner.rawKey ?? key.rawKey,
      reclaimedAt: this.now().toISOString(),
      reason: "owner_not_alive",
      reclaimedBy: { pid: this.identity.pid, procStartTicks: this.identity.procStartTicks, machineBootId: this.identity.machineBootId, action },
      previousOwner: fresh.owner,
      archive: archiveName,
    };
    try {
      writeFileSync(join(archive, "reclaim.json"), JSON.stringify(record, null, 2), { mode: 0o600 });
    } catch {
      // 记录写失败不影响已完成的原子回收；返回值仍携带记录供调用方诊断
    }
    this.pruneReclaimed();
    for (const listener of reclaimListeners) {
      try {
        listener(record);
      } catch {
        // 诊断失败不影响占用结果
      }
    }
    return { reclaimed: record, retry: false };
  }

  /** 回收区只保留最近 RECLAIM_KEEP 条；名称以时间戳开头，按名排序即时间序。 */
  private pruneReclaimed(): void {
    const archiveRoot = join(this.root, RECLAIM_DIR);
    let names: string[];
    try {
      names = readdirSync(archiveRoot).sort();
    } catch {
      return;
    }
    for (const name of names.slice(0, Math.max(0, names.length - RECLAIM_KEEP))) {
      try {
        rmSync(join(archiveRoot, name), { recursive: true, force: true });
      } catch {
        // 清理失败保留，下次再试
      }
    }
  }

  /** 只读列出自动回收记录（新在前）；回收区不存在时为空，不创建目录。 */
  listReclaimed(): LockReclaimRecord[] {
    const archiveRoot = join(this.root, RECLAIM_DIR);
    let names: string[];
    try {
      names = readdirSync(archiveRoot).sort().reverse();
    } catch {
      return [];
    }
    const records: LockReclaimRecord[] = [];
    for (const name of names) {
      try {
        records.push(JSON.parse(readFileSync(join(archiveRoot, name, "reclaim.json"), "utf8")) as LockReclaimRecord);
      } catch {
        // 记录缺失或损坏：跳过
      }
    }
    return records;
  }

  /** lock_busy：带 owner 动作、pid、核实结论与下一步命令，便于人工处理。 */
  private busyError(key: LockKey, dir: string): InfrastructureError {
    const hash = hashKey(key.rawKey);
    const id = `${key.scope}/${hash}`;
    const status = this.inspectDir(dir);
    const owner = status.owner;
    const attachedAlive = owner !== null && status.processVerdict === "not_alive" && !this.reclaimable(status);
    const nextActions: string[] = [];
    if (owner === null) {
      nextActions.push(`knit locks 核实；确认无进程在写后 knit unlock ${id} --expect-token <任意> --force`);
    } else if (status.processVerdict === "alive") {
      nextActions.push("等待持有者结束；若是失控的 run，先 knit run cancel <run-id>");
      nextActions.push(`knit locks 查看 ${id} 的心跳与动作`);
    } else if (status.processVerdict === "unknown") {
      nextActions.push(`knit locks 核实 ${id}；确认原进程已停止后 knit unlock ${id} --expect-token ${owner.token} --force`);
    } else {
      nextActions.push(attachedAlive
        ? `owner 已退出但其阶段进程仍在或无法核实；先终止残留进程后重试，或 knit unlock ${id} --expect-token ${owner.token}`
        : `knit unlock ${id} --expect-token ${owner.token}`);
    }
    const verdictText = owner === null ? "owner 缺失/损坏" : attachedAlive ? "not_alive（附属进程未结束）" : status.processVerdict;
    const ownerText = owner === null ? "" : ` action=${owner.action} pid=${owner.pid}`;
    return new InfrastructureError(
      "lock_busy",
      `lock already held: ${id}（owner${ownerText} 进程核实=${verdictText}）；下一步: ${nextActions.join("；")}`,
      {
        scope: key.scope,
        key: key.rawKey,
        lockId: id,
        ownerPath: join(dir, "owner.json"),
        ownerAction: owner?.action ?? null,
        ownerPid: owner?.pid ?? null,
        ownerToken: owner?.token ?? null,
        heartbeatAt: owner?.heartbeatAt ?? null,
        processVerdict: status.processVerdict,
        attachedAlive,
        nextActions,
      },
    );
  }

  /** owner 文件写入；单一入口，测试可注入 owner.json 写入失败。 */
  protected writeOwner(ownerPath: string, owner: LockOwner): { sha256: string } {
    return atomicWrite({ path: ownerPath, data: Buffer.from(JSON.stringify(owner, null, 2), "utf8"), expectedSha256: null, mode: 0o600 });
  }

  /**
   * acquire 失败逆序撤销已完成步骤。既有锁只撤销本次重入的一份引用；
   * 本次新建键清理匹配的内存记录与目录，owner 未落盘也覆盖；他者 token 不动。
   */
  private rollbackAcquire(undo: AcquireUndo[]): void {
    for (const entry of [...undo].reverse()) {
      const held = this.heldBySelf.get(entry.heldKey);
      if (entry.kind === "reentered") {
        if (held === entry.held) held.count -= 1;
        continue;
      }
      if (entry.held !== undefined && held === entry.held) {
        this.heldBySelf.delete(entry.heldKey);
      }
      let owner: LockOwner | null = null;
      try {
        owner = JSON.parse(readFileSync(join(entry.dir, "owner.json"), "utf8")) as LockOwner;
      } catch {
        owner = null;
      }
      if (owner !== null && owner.token !== entry.token) continue; // 他者占用，不释放
      try {
        rmSync(entry.dir, { recursive: true, force: true });
      } catch {
        // 删除失败保留现场；不影响已抛出的原始错误
      }
    }
  }

  /** 只读检查：不建目录、不写文件。返回 owner 与进程核实结论。 */
  inspect(key: LockKey): LockStatus {
    return this.inspectDir(this.lockDir(key));
  }

  private inspectDir(dir: string): LockStatus {
    const ownerPath = join(dir, "owner.json");
    if (!existsSync(ownerPath)) {
      // 目录在而 owner 缺失视为未知残留，不冒充可占用或已死亡。
      const dirExists = existsSync(dir);
      return { exists: dirExists, owner: null, processVerdict: "unknown" };
    }
    try {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LockOwner;
      return { exists: true, owner, processVerdict: this.verifyProcess(owner) };
    } catch {
      return { exists: true, owner: null, processVerdict: "unknown" };
    }
  }

  /** 只读枚举所有锁目录；不创建锁根，也不把损坏 owner 当成可释放。 */
  list(): LockEntry[] {
    const entries: LockEntry[] = [];
    for (const scope of ["project", "task", "session"] as const) {
      const dir = this.scopeDir(scope);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const hash of names.sort()) {
        const path = join(dir, hash);
        let isDirectory = false;
        try {
          isDirectory = statSync(path).isDirectory();
        } catch {
          continue;
        }
        if (!isDirectory) continue;
        const status = this.inspectDir(path);
        entries.push({ ...status, scope, id: `${scope}/${hash}`, hash, path, key: status.owner?.rawKey ?? null });
      }
    }
    return entries;
  }

  /**
   * 显式解除一个锁。必须提供 owner token；token 不符永远拒绝，旧 token 不能删新占用。
   * 默认只允许已确认死亡的 owner；alive／unknown 必须显式 force，仍不能绕过 token。
   */
  unlock(input: { key: LockKey; expectToken: string; force?: boolean }): LockEntry & { removed: boolean } {
    const hash = hashKey(input.key.rawKey);
    return this.unlockDir({ scope: input.key.scope, hash, rawKey: input.key.rawKey, expectToken: input.expectToken, force: input.force });
  }

  /** 按 lock-id（scope/hash，来自 list）解除；无需原始键，规则与 unlock 相同。 */
  unlockById(input: { id: string; expectToken: string; force?: boolean }): LockEntry & { removed: boolean } {
    const parsed = parseLockId(input.id);
    if (parsed === null) throw new InfrastructureError("lock_owner_unknown", `非法 lock-id: ${input.id}`, { id: input.id });
    return this.unlockDir({ scope: parsed.scope, hash: parsed.hash, rawKey: null, expectToken: input.expectToken, force: input.force });
  }

  private unlockDir(input: { scope: LockScope; hash: string; rawKey: string | null; expectToken: string; force?: boolean }): LockEntry & { removed: boolean } {
    const dir = join(this.scopeDir(input.scope), input.hash);
    const status = this.inspectDir(dir);
    const hash = input.hash;
    const base: LockEntry = { ...status, scope: input.scope, id: `${input.scope}/${hash}`, hash, path: dir, key: status.owner?.rawKey ?? input.rawKey };
    if (!status.exists) return { ...base, removed: false };
    if (status.owner === null) {
      if (input.force !== true) {
        throw new InfrastructureError("lock_owner_unknown", `锁 owner 不可核实，拒绝删除: ${dir}`, { path: dir });
      }
      // force 清除无 owner 残留（如进程在 mkdir 与 owner 写入之间死亡）；
      // 删除前再核实仍无 owner，避免清掉并发新建的占用。token 校验路径不受影响。
      const fresh = this.inspectDir(dir);
      if (fresh.owner !== null) {
        throw new InfrastructureError("lock_owner_unknown", `锁 owner 在清除前出现，重试: ${dir}`, { path: dir });
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new InfrastructureError("io_error", `解除锁失败: ${dir}`, { cause: code ?? String(error), permission: code === "EACCES" || code === "EPERM" });
      }
      return { ...base, removed: true };
    }
    if (status.owner.token !== input.expectToken) {
      throw new InfrastructureError("lock_token_mismatch", `owner token 不匹配，拒绝解除: ${dir}`, { path: dir });
    }
    if (status.processVerdict !== "not_alive" && input.force !== true) {
      const code = status.processVerdict === "alive" ? "lock_busy" : "lock_owner_unknown";
      throw new InfrastructureError(code, `owner ${status.processVerdict}，需 --force 才可解除: ${dir}`, {
        path: dir,
        token: status.owner.token,
        processVerdict: status.processVerdict,
      });
    }
    // 删除前再次核对 token，拒绝与并发心跳／替换竞态；force 也只接受同一 token。
    const fresh = this.inspectDir(dir);
    if (fresh.owner === null || fresh.owner.token !== input.expectToken) {
      throw new InfrastructureError("lock_token_mismatch", `owner 在解除前变化: ${dir}`, { path: dir });
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new InfrastructureError("io_error", `解除锁失败: ${dir}`, { cause: code ?? String(error), permission: code === "EACCES" || code === "EPERM" });
    }
    return { ...base, removed: true };
  }

  /** 进程身份核实：同机 + PID 存活 + starttime 一致才 alive；任何不确定都是 unknown。 */
  verifyProcess(owner: LockOwner): "alive" | "not_alive" | "unknown" {
    if (owner.protocol !== OWNER_PROTOCOL) return "unknown";
    if (owner.machineBootId !== this.identity.machineBootId) return "unknown";
    if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid)) return "unknown";
    // 跨平台存活检查：process.kill(pid, 0) 在 Linux／macOS 都可用（任务052-B001 Mac 适配）。
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return "not_alive";
      return "unknown"; // EPERM 等权限情形不冒充结论。
    }
    const ticks = procStartTicks(owner.pid);
    if (ticks === null || owner.procStartTicks === null) return "alive";
    return sameProcessStart(owner.procStartTicks, ticks) ? "alive" : "not_alive";
  }

  /** 附属进程核实：PID 不存在为 not_alive；权限不足 unknown；启动标识不符视为 PID 复用。 */
  private verifyPid(pid: number, recordedTicks: string | null): "alive" | "not_alive" | "unknown" {
    if (!Number.isInteger(pid) || pid <= 0) return "unknown";
    try {
      process.kill(pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "not_alive" : "unknown";
    }
    const ticks = procStartTicks(pid);
    if (ticks === null || recordedTicks === null) return "alive";
    return sameProcessStart(recordedTicks, ticks) ? "alive" : "not_alive";
  }

  /** 心跳逐键核对 token 和版本；同实例嵌套句柄共享本机已成功写入的版本。 */
  async heartbeat(lock: AcquiredLock): Promise<void> {
    const at = this.now().toISOString();
    this.rewriteOwners(lock, (owner) => ({ ...owner, heartbeatAt: at }));
  }

  /**
   * 登记持锁者启动的附属进程（阶段 Pi）；pid 为 null 时清空。owner 已死而附属进程仍在时不自动回收。
   * 与心跳同样逐键核对 token 和版本，并同步刷新心跳时间。
   */
  attachProcess(lock: AcquiredLock, pid: number | null): void {
    const attached = pid === null ? [] : [{ pid, procStartTicks: procStartTicks(pid) }];
    const at = this.now().toISOString();
    this.rewriteOwners(lock, (owner) => ({ ...owner, heartbeatAt: at, attached }));
  }

  private rewriteOwners(lock: AcquiredLock, mutate: (owner: LockOwner) => LockOwner): void {
    if (lock.ownerTokens && (lock.ownerTokens.length !== lock.keys.length || lock.ownerTokens[0] !== lock.token)) {
      throw new InfrastructureError("lock_token_mismatch", "lock handle token mismatch");
    }
    for (const [index, ownerPath] of lock.ownerPaths.entries()) {
      const token = lock.ownerTokens?.[index] ?? lock.token;
      const current = readWithVersion(ownerPath);
      if (!current) throw new InfrastructureError("lock_token_mismatch", `owner file missing: ${ownerPath}`);
      const owner = JSON.parse(current.data.toString("utf8")) as LockOwner;
      if (owner.token !== token) {
        throw new InfrastructureError("lock_token_mismatch", `owner token mismatch: ${ownerPath}`);
      }
      const held = this.heldBySelf.get(this.heldKey(lock.keys[index]!));
      const expected = held?.token === token ? held.ownerVersion : lock.ownerVersions[index];
      if (current.sha256 !== expected) {
        throw new InfrastructureError("version_conflict", `owner file changed outside heartbeat: ${ownerPath}`);
      }
      const data = Buffer.from(JSON.stringify(mutate(owner), null, 2), "utf8");
      const written = atomicWrite({ path: ownerPath, data, expectedSha256: current.sha256, mode: 0o600 });
      // 每个成功写入立即登记；后续键失败时仍可用真实版本继续，重复键亦然。
      lock.ownerVersions[index] = written.sha256;
      if (held?.token === token) held.ownerVersion = written.sha256;
    }
  }

  /** 逐键核对 owner token 并撤销本次引用，不用首键 token 代替其它键的凭据。 */
  release(lock: { token: string; keys: LockKey[]; ownerTokens?: string[]; ownerPaths?: string[] }): void {
    if (lock.ownerTokens && (lock.ownerTokens.length !== lock.keys.length || lock.ownerTokens[0] !== lock.token)) return;
    for (const [index, key] of lock.keys.entries()) {
      const token = lock.ownerTokens?.[index] ?? lock.token;
      const heldKey = this.heldKey(key);
      const held = this.heldBySelf.get(heldKey);
      if (held !== undefined && held.token === token) {
        held.count -= 1;
        if (held.count > 0) continue; // 嵌套占用仍有效，不删目录
        this.heldBySelf.delete(heldKey);
      }
      const dir = this.lockDir(key);
      const ownerPath = join(dir, "owner.json");
      if (!existsSync(ownerPath)) continue;
      let owner: LockOwner | null = null;
      try {
        owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LockOwner;
      } catch {
        continue; // 无法核实的 owner 不动
      }
      if (owner?.token !== token) continue; // 他者占用，不释放
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 目录删除失败保留现场；owner 已不被本次 token 引用
      }
    }
  }
}

/** 固定锁顺序：项目执行占用在前、任务文件短占用次之、Session 在后；同类键按摘要排序，避免倒序等待。 */
export function orderKeys(keys: LockKey[]): LockKey[] {
  const rank = (scope: LockScope) => (scope === "project" ? 0 : scope === "task" ? 1 : 2);
  return [...keys].sort((a, b) => rank(a.scope) - rank(b.scope) || (a.rawKey < b.rawKey ? -1 : a.rawKey > b.rawKey ? 1 : 0));
}
