/**
 * g-207：本地事务/错误处理模板。
 *
 * 面向单用户本地多进程：有限锁/CAS 保护正常并发的数据完整性，
 * 明确失败阶段、错误分类与可诊断恢复，不追求分布式一致性或无限递归 rollback。
 *
 * 设计原则：
 * - 事件先行（R-02）：任何持久化变更必须先 appendEvent，再写文件。
 * - 锁内重读/CAS：读-改-写必须在锁保护下完成，写前重读校验预期状态。
 * - 有限恢复：失败时记录诊断信息，不吞错、不递归扩大失败路径。
 * - 基本安全：越界/凭据/明显 symlink 安全检查保留。
 *
 * g-384：prepare → event → persist 三段契约的**唯一次序实现**是
 * {@link commitPrepared}（withTx 在其上加锁）；两个阶段的失败语义与诊断见该函数注释，
 * 完整契约/审计清单见 docs/event-first-commit-contract.zh.md。
 * 注意：事件先行 ≠ 跨文件原子事务——helper 只保证「event 失败则磁盘原值不动」
 * 与「persist 失败可诊断」，不宣称多文件一致。
 */

import { readFileSync, existsSync, writeFileSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, nowIso, type GraphEvent } from "./events.ts";
import { GraphError } from "./machine.ts";
import { replaceFileAtomic, isProcessAlive } from "./platform.ts";

/** 事务阶段：用于诊断和日志。 */
export type TxPhase =
  | "validate"   // 输入校验
  | "read"       // 读取当前状态
  | "mutate"     // 内存变更
  | "event"      // 事件先行写入
  | "persist"    // 文件持久化
  | "cleanup";   // 清理/恢复

/** 事务失败分类。 */
export class TxError extends GraphError {
  phase: TxPhase;
  recoverable: boolean;
  constructor(message: string, phase: TxPhase, recoverable: boolean = false) {
    super(message);
    this.phase = phase;
    this.recoverable = recoverable;
  }
}

/** CAS 冲突：预期状态与实际状态不一致。 */
export class TxCasError extends TxError {
  constructor(message: string, phase: TxPhase = "read") {
    super(message, phase, true);
  }
}

/** 事务上下文：携带诊断信息，不吞错。 */
export interface TxContext {
  root: string;
  actor: string;
  goal?: string;
  /** 用于 CAS 校验的乐观 token（如 mtime、version、hash）。 */
  expect?: Record<string, unknown>;
}

/** 事务结果。 */
export interface TxResult<T> {
  ok: true;
  value: T;
  events: GraphEvent[];
}

export interface TxFailure {
  ok: false;
  phase: TxPhase;
  error: string;
  recoverable: boolean;
}

/** 文件锁的极简实现：基于临时文件 + PID 的 advisory lock。
 *  不保证跨所有内核级 FD 竞争，但覆盖正常单用户多进程场景。
 *  锁文件自动清理（进程退出时 OS 回收 FD，但锁文件保留——下次获取时覆盖过期锁）。 */
function lockFilePath(root: string, name: string): string {
  return join(root, `.lock.${name}`);
}

function acquireLock(lockPath: string, timeoutMs: number = 5000): void {
  const start = Date.now();
  const pid = process.pid;
  while (true) {
    try {
      // 原子写 PID 到锁文件（O_EXCL 语义通过 writeFileSync + 异常捕获模拟）
      writeFileSync(lockPath, String(pid), { flag: "wx" });
      return;
    } catch {
      // 锁被占用：检查是否过期（锁持有进程已死亡）
      if (existsSync(lockPath)) {
        try {
          const holder = readFileSync(lockPath, "utf8").trim();
          const holderPid = parseInt(holder, 10);
          if (!Number.isNaN(holderPid) && holderPid !== pid) {
            let alive = true;
            try {
              alive = isProcessAlive(holderPid);
            } catch {
              alive = true; // 保守判存活，避免在 Windows 权限异常时误抢锁
            }
            if (!alive) {
              // 进程已死：抢占锁
              try {
                writeFileSync(lockPath, String(pid), { flag: "w" });
                return;
              } catch { /* 竞争失败，继续轮询 */ }
            }
          }
          // holderPid === pid：同进程嵌套获取，视为死锁
          if (holderPid === pid) {
            throw new TxError(`同进程嵌套获取锁（${lockPath}）——死锁`, "read", true);
          }
        } catch (e) {
          if (e instanceof TxError) throw e;
          /* 读锁文件失败，继续轮询 */
        }
      }
      if (Date.now() - start > timeoutMs) {
        throw new TxError(`获取锁超时（${lockPath}）`, "read", true);
      }
      // 退避
      const backoff = Math.min(100, 10 + Math.random() * 50);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(backoff));
    }
  }
}

/** 释放锁：仅当锁文件仍记录本进程 PID 时才删除（g-383）。
 *
 *  获取锁失败/超时的调用本无所有权（acquired=false），调用方不会走到这里；
 *  能走到这里说明本进程确实写过该锁文件。但「过期锁抢占」路径用非原子的
 *  `flag: "w"` 覆写实现，覆写本身不构成独占证明：锁可能已被其他进程接管。
 *  因此删除前必须校验持有者标识，绝不盲删他人（或外层）的锁。
 *  读不到持有者身份时保守放弃删除——宁可留残余锁文件，也不误删他人锁。 */
function releaseLock(lockPath: string): void {
  try {
    if (!existsSync(lockPath)) return;
    let holder: string;
    try {
      holder = readFileSync(lockPath, "utf8").trim();
    } catch {
      return; // 无法确认持有者身份：保守不删
    }
    if (holder !== String(process.pid)) return; // 锁已被他人接管：不删
    rmSync(lockPath, { force: true });
  } catch { /* 锁文件可能已被其他进程清理 */ }
}

/** g-384：一次提交的「准备结果」——prepare/event/persist 契约的载体。
 *
 *  - `value`/`events`：由**调用方（prepare 阶段）**产出，必须是纯内存结果；
 *    prepare 阶段不得有文件副作用（写文件一律放进 `persist`），否则事件失败时
 *    磁盘已经被改动，契约失效。
 *  - `persist`：唯一允许写盘的地方，只在 event 阶段全部成功后才被调用；
 *    省略表示本次提交无文件写入（纯事件追加）。 */
export interface PreparedCommit<T> {
  value: T;
  events: Omit<GraphEvent, "ts">[];
  persist?: () => void;
}

/** 提交结果：返回值 + 本次真实写入的事件（含 ts）。 */
export interface CommitOutcome<T> {
  value: T;
  events: GraphEvent[];
}

/** g-384（v0.18.0 审查 C3）：事件先行提交——prepare → event → persist 的唯一次序实现。
 *
 *  契约（三段，职责边界明确，不宣称跨文件原子事务）：
 *  1. **prepare**（调用方，调用本函数之前）：校验 + 全部内存变更，零文件副作用。
 *  2. **event**（本函数）：任何文件写入之前先消费 `plan.events`（R-02 事件先行）。
 *     本阶段失败 ⇒ 抛出 TxError(phase="event")，**persist 不执行** ⇒ 磁盘保持原值，
 *     调用方报错阶段准确（这是「失败时不留下已改状态」的保证）。
 *  3. **persist**（本函数）：事件已落盘后写文件。本阶段失败 ⇒ 补记一条
 *     `tx.persist_failed` 诊断事件（best-effort，绝不覆盖原始错误）并抛出
 *     TxError(phase="persist")：事件流（唯一真相源）已前进而投影文件未更新，
 *     属**可诊断、可收敛**的有限恢复场景——幂等重试同一调用即可对齐；
 *     诊断事件本身写不进去时只保留异常信息，不引入无限 rollback。
 *
 *  诚实边界：event 与 persist 是两个文件/两套写入，中间**不是**原子窗口；
 *  本 helper 不提供跨文件事务，也不自动重试（自动重试会掩盖真实 EIO/ENOSPC）。 */
export function commitPrepared<T>(
  root: string,
  meta: { actor: string; goal?: string },
  plan: PreparedCommit<T>,
): CommitOutcome<T> {
  // ---- event 阶段：先追加事件，失败则磁盘原值不动 ----
  const written: GraphEvent[] = [];
  try {
    for (const ev of plan.events) written.push(appendEvent(root, ev));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const where = meta.goal ? `目标 ${meta.goal}；` : "";
    throw new TxError(
      `事件追加失败（event 阶段：${where}未发生任何文件写入，磁盘保持原值）：${msg}`,
      "event",
      true,
    );
  }
  if (!plan.persist) return { value: plan.value, events: written };

  // ---- persist 阶段：事件已落盘后写文件；失败补记诊断事件 ----
  try {
    plan.persist();
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    try {
      appendEvent(root, {
        actor: meta.actor,
        event: "tx.persist_failed",
        ...(meta.goal ? { goal: meta.goal } : {}),
        details: {
          phase: "persist",
          error: msg,
          events: written.map((w) => w.event),
          recovery: "retry",
        },
      });
    } catch { /* 诊断写入失败：绝不覆盖原始错误 */ }
    throw new TxError(
      "文件持久化失败（persist 阶段：事件已先行落盘，磁盘可能落后于事件流；" +
        `已补记 tx.persist_failed，重试同一调用即可收敛）：${msg}`,
      "persist",
      e instanceof TxError ? e.recoverable : true,
    );
  }
  return { value: plan.value, events: written };
}

/** 在锁保护下执行读-改-写事务。
 *  流程：校验 → 加锁 → prepare（重读 + CAS + 内存变更）→ 事件先行 → 持久化 → 解锁。
 *  任何阶段失败立即解锁并返回 TxFailure，不递归重试。
 *  回调只负责 prepare：**不得在回调里写盘**——把文件写入放进返回值的 `persist`
 *  （见 {@link commitPrepared}），否则 event 失败时磁盘已被改动（g-384 修复的正是这一形态）。
 *  g-383：只有 acquireLock 正常返回（本次确实取得锁）才释放；超时/同进程嵌套
 *  获取失败的调用不持有锁，绝不释放——否则会删掉原持有者仍在使用的锁，
 *  使后续调用得以闯入其临界区。 */
export function withTx<T>(
  ctx: TxContext,
  opts: { lockName: string; lockTimeoutMs?: number },
  fn: (ctx: TxContext) => PreparedCommit<T>,
): TxResult<T> | TxFailure {
  const lockPath = lockFilePath(ctx.root, opts.lockName);
  const phase: TxPhase = "validate"; // 未分类异常的回报阶段（历史口径，见下方 catch）
  let acquired = false; // 本次调用是否真正取得锁（唯一释放依据）
  try {
    // 1. 加锁
    acquireLock(lockPath, opts.lockTimeoutMs ?? 5000);
    acquired = true; // 抛错则不会执行到这里：超时/嵌套失败者无所有权

    // 2. prepare：锁内只读 + 内存变更（回调不得有文件副作用）
    //    未分类异常仍按历史语义回报 phase="validate"（既有断言标题依赖该口径）
    const plan = fn(ctx);

    // 3. event 先行 + 4. persist（唯一次序实现，含失败诊断）
    const outcome = commitPrepared(ctx.root, { actor: ctx.actor, goal: ctx.goal }, plan);

    // 5. 返回成功
    releaseLock(lockPath);
    return { ok: true, value: outcome.value, events: outcome.events };
  } catch (e) {
    if (acquired) releaseLock(lockPath); // 获取失败者无锁：不得释放他人的锁
    if (e instanceof TxError) {
      return { ok: false, phase: e.phase, error: e.message, recoverable: e.recoverable };
    }
    return { ok: false, phase, error: String((e as Error)?.message ?? e), recoverable: false };
  }
}

/** 原子文件写：临时文件 + rename（已存在的安全模式）。
 *  不覆盖 symlink；目标路径如果是 symlink 则拒绝。 */
export function atomicWrite(file: string, content: string): void {
  const resolved = file; // 调用方应提供绝对路径
  // 基本 symlink 安全检查
  try {
    if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
      throw new TxError(`拒绝写入符号链接：${resolved}`, "persist", false);
    }
  } catch (e) {
    if (e instanceof TxError) throw e;
    // lstatSync 不可用（极少见）时跳过 symlink 检查
  }
  const tmp = `${resolved}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, content, "utf8");
    replaceFileAtomic(tmp, resolved);
  } catch (e) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* 忽略清理失败 */ }
    throw e;
  }
}

/** CAS 文件写：在锁保护下读取文件、校验预期内容、原子写入。
 *  用于需要「读-校验-写」原子性的场景（如乐观并发控制）。
 *  expect 函数返回 true 表示校验通过。 */
export function casWrite(
  file: string,
  content: string,
  expect: (current: string | null) => boolean,
): void {
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (!expect(current)) {
    throw new TxCasError(`CAS 校验失败：${file} 内容已被其他进程修改`, "read");
  }
  atomicWrite(file, content);
}

/** 带 CAS 的文件读-改-写辅助：读取 → 校验 → 变更 → 原子写回。
 *  read 返回当前内容；mutate 返回新内容；validate 在校验失败时抛 TxCasError。 */
export function readModifyWrite(
  file: string,
  opts: {
    read: () => string;
    expect: (current: string) => boolean;
    mutate: (current: string) => string;
  },
): string {
  const current = opts.read();
  if (!opts.expect(current)) {
    throw new TxCasError(`CAS 校验失败：${file}`, "read");
  }
  const next = opts.mutate(current);
  atomicWrite(file, next);
  return next;
}
