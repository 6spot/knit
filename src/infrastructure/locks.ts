/**
 * 本机共享锁（OPERATIONS.md 第2节）。
 * 锁根 ~/.knit/locks/：projects/<项目根摘要>/、sessions/<客户端及原生身份摘要>/，
 * 目录 0700、owner 文件 0600。mkdir 抢占式占用；owner.json 记录协议、token、
 * 动作／run、机器／启动标识、PID 与进程开始时间；心跳原子更新；释放核对 token。
 * 只读查询（status/doctor/init --check）不建目录——检查入口是 inspect。
 * 不跨机、不对心跳超时强解；强解是显式风险操作（unlock 命令层处理）。
 * acquire 任一键失败逆序撤销本次重入引用和新建资源，含 owner 未落盘的目录；
 * unlock --force 可清除「目录在而 owner 不可核实」的残留，正常 token 校验路径不变。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite, readWithVersion } from "./atomic.js";
import { procStartTicks } from "./process.js";

export { procStartTicks } from "./process.js";
import { hashKey } from "./paths.js";
import { InfrastructureError } from "./errors.js";

const OWNER_PROTOCOL = 1;
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
  token: string;
  keys: LockKey[];
  ownerPaths: string[];
  /** 获取时各 owner 文件的 SHA-256；心跳用它与当前内容比对，检测并发篆改。 */
  ownerVersions: string[];
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

function bootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return `unknown-boot-${hostname()}`;
  }
}

/** /proc/<pid>/stat starttime；空格包裹的 comm 字段内可能含空格，取最后一个 ')' 之后解析。 */
export function currentIdentity(): ProcessIdentity {
  const pid = process.pid;
  return { pid, procStartTicks: procStartTicks(pid), machineBootId: bootId() };
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
    const ownerVersions: string[] = [];
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
          ownerVersions.push(held.ownerVersion);
          if (token === null) token = held.token;
          continue;
        }
        const created: Extract<AcquireUndo, { kind: "created" }> = {
          kind: "created", heldKey, dir, token: token ?? randomUUID(),
        };
        // mkdir 是占用原语：已存在即 busy；不在进程中等待旧工具。
        for (;;) {
          try {
            mkdirSync(dir, { recursive: false, mode: 0o700 });
            token = created.token;
            undo.push(created);
            break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EEXIST") {
              throw new InfrastructureError("lock_busy", `lock already held: ${key.scope}/${hashKey(key.rawKey)}`, {
                scope: key.scope,
                key: key.rawKey,
                ownerPath: join(dir, "owner.json"),
              });
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
        ownerVersions.push(written.sha256);
        created.held = { token: owner.token, ownerVersion: written.sha256, action: request.action, count: 1 };
        this.heldBySelf.set(heldKey, created.held);
      }
    } catch (error) {
      this.rollbackAcquire(undo);
      throw error;
    }
    return { token: token as string, keys: request.keys, ownerPaths, ownerVersions };
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
    const dir = this.lockDir(input.key);
    const status = this.inspectDir(dir);
    const hash = hashKey(input.key.rawKey);
    const base: LockEntry = { ...status, scope: input.key.scope, id: `${input.key.scope}/${hash}`, hash, path: dir, key: status.owner?.rawKey ?? input.key.rawKey };
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
    return ticks === owner.procStartTicks ? "alive" : "not_alive";
  }

  /** 心跳原子更新：核对 token 与获取时版本，更新 heartbeatAt。token 或版本不符抛错。 */
  async heartbeat(lock: AcquiredLock): Promise<void> {
    const next: string[] = [];
    for (const [index, ownerPath] of lock.ownerPaths.entries()) {
      const current = readWithVersion(ownerPath);
      if (!current) throw new InfrastructureError("lock_token_mismatch", `owner file missing: ${ownerPath}`);
      const owner = JSON.parse(current.data.toString("utf8")) as LockOwner;
      if (owner.token !== lock.token) {
        throw new InfrastructureError("lock_token_mismatch", `owner token mismatch: ${ownerPath}`);
      }
      if (current.sha256 !== lock.ownerVersions[index]) {
        throw new InfrastructureError("version_conflict", `owner file changed outside heartbeat: ${ownerPath}`);
      }
      const data = Buffer.from(JSON.stringify({ ...owner, heartbeatAt: this.now().toISOString() }, null, 2), "utf8");
      const written = atomicWrite({ path: ownerPath, data, expectedSha256: current.sha256, mode: 0o600 });
      next.push(written.sha256);
    }
    lock.ownerVersions = next;
  }

  /** 释放：核对每个 owner 的 token；仅删除本次 token 写下的 owner 与目录。 */
  release(lock: { token: string; keys: LockKey[]; ownerPaths?: string[] }): void {
    for (const key of lock.keys) {
      const heldKey = this.heldKey(key);
      const held = this.heldBySelf.get(heldKey);
      if (held !== undefined && held.token === lock.token) {
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
      if (owner?.token !== lock.token) continue; // 他者占用，不释放
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
