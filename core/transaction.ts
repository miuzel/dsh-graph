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

import {
  readFileSync,
  existsSync,
  writeFileSync,
  rmSync,
  lstatSync,
  chmodSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { appendEvent, nowIso, type GraphEvent } from "./events.ts";
import { GraphError } from "./machine.ts";
import { replaceFileAtomic, isProcessAlive, areSameStat } from "./platform.ts";

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

/** g-394：本进程**当前确实持有**（acquireLock 成功且尚未 releaseLock）的锁路径集合。
 *
 *  存在的唯一理由：锁文件里写着本进程 PID 时，必须区分两种完全不同的情形——
 *  - 集合内：真·同进程嵌套持有 ⇒ 沿用既有死锁语义拒绝（既有测试钉住该行为）；
 *  - 集合外：本进程遗留的孤儿锁（上次临界区崩溃、或上次 releaseLock 因读不到身份
 *    而保守未删）⇒ 不是嵌套，按过期锁回收，否则本进程在剩余生命周期内**永远**拿不回它。
 *  键用 lockKey() 归一化（`./x` 与 `/abs/x` 不得被误判为孤儿）。集合只描述进程内事实，
 *  不参与跨进程判定，也不改变 Windows 兼容路径（isProcessAlive 的保守判活语义原样保留）。 */
const heldLocks = new Set<string>();

/** 锁路径的进程内规范化键。
 *
 *  `resolve` 统一 `./x` 与绝对路径；再对**父目录**取 realpath，使「同一锁经 symlink 别名
 *  访问」也能归一到同一个键——否则同一进程持有的锁会被误判成孤儿锁而遭回收（进程内两个
 *  临界区重叠）。父目录不存在时退回 resolve 结果（此时 acquiring 本来也会失败）。 */
function lockKey(lockPath: string): string {
  const abs = resolve(lockPath);
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

/** g-394：**无法确认持有者身份**的锁的有界自愈阈值（ms）。
 *
 *  适用边界（务必按此理解，否则会误读成「任何锁超时即可抢占」）：
 *  - 只用于身份不可确认的锁（0 字节 / 乱码 / 截断 / 读失败）。内容能解析出 PID
 *    且该进程存活时，**无论 mtime 多旧都绝不回收**（g-383 所有权语义，判据 3）。
 *  - 只在 mtime 超过本阈值后才回收：刚用 O_EXCL 建好、内容尚未落盘的正常锁必须能被放过，
 *    因此阈值远大于「创建→写入」窗口；同时它是有界等待而非永久占用（判据 1/2）。
 *  - 30s 与 ops.ts tags-lock 的陈旧锁阈值同量级（同仓库同一口径，便于审查对照）。 */
export const STALE_BAD_LOCK_MS = 30_000;

/** 单次 acquireLock 内允许的回收次数上限：回收后立刻重试，防止外部反复重建坏锁时空转。 */
const MAX_LOCK_RECLAIMS = 3;

/** 锁文件年龄（ms）；stat 失败返回 null（保守：不回收，只继续轮询）。 */
function lockAgeMs(lockPath: string): number | null {
  try {
    return Date.now() - lstatSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

/** g-394：该数值能否为「持有者是否存活」给出**确定结论**。
 *
 *  - 非整数（含 NaN）：不能；
 *  - `<= 0`：能——platform.isProcessAlive 直接返回「不存活」（合法进程不可能是非正 PID）；
 *  - 正数且落在 process.kill 接受的 int32 范围内：能，可实际探测存活；
 *  - 越界正数（如两次写入拼接出的 14 位数字）：**不能**——process.kill 会抛
 *    ERR_OUT_OF_RANGE 而非 ESRCH/EPERM。若把抛错当「保守判存活」，这种坏锁就永远进不了
 *    自愈分支（正是要消灭的永久等待）⇒ 一律按**身份不可确认**处理，与 0 字节/乱码
 *    同走 mtime 有界自愈。
 *    注意不能反过来判死：Windows PID 是 uint32，越界正数可能是真实存活持有者，
 *    故只降级为「需 mtime 过期」，绝不立即抢占（判据 3）。 */
function pidLivenessDecidable(n: number): boolean {
  if (!Number.isInteger(n)) return false;
  return n <= 0 || n <= 2_147_483_647;
}

/** g-394：回收一把**身份不可确认或已确认属本进程遗留**的陈旧锁。
 *
 *  调用方保证已经判定「持有者身份无法确认」或「本进程 PID 但进程内未持有」；
 *  这里仍然自行复核一次身份：先把权限恢复到可读（mode 000 的 EACCES 场景）再读一遍，
 *  若复核发现是可解析且存活的**他人**锁，则放弃回收（绝不误抢他人活锁）。
 *
 *  回收采用「原子隔离 + 身份核对」而非直接删除：先把锁 rename 到唯一隔离路径，
 *  再用 dev+ino 核对隔离到的**确实**是判定时那一把；若期间已有别的进程新建了锁
 *  （即我们移走的是它的新锁），则尽力原样还原且**绝不删除**。这样「读不到就删」的
 *  粗放策略被排除在外——只有经过身份核对的那一个文件才有可能被删。
 *  返回 true 表示锁文件已被清除，调用方应立刻用 O_EXCL 重新争取（不做非原子覆写，
 *  避免把「删除」误当成「已取得独占」）。 */
function reclaimStaleBadLock(lockPath: string, reason: string): boolean {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(lockPath);
  } catch {
    return false; // stat 不到：不回收
  }
  // 1) 尽力恢复可读性并复核身份：EACCES（mode 000）chmod 后可读到真实持有者
  try { chmodSync(lockPath, 0o600); } catch { /* EISDIR / 非属主等：继续走回收判定 */ }
  let holder: string | null = null;
  try { holder = readFileSync(lockPath, "utf8").trim(); } catch { holder = null; }
  if (holder !== null) {
    const holderPid = parseInt(holder, 10);
    if (pidLivenessDecidable(holderPid) && holderPid !== process.pid) {
      let alive = true;
      try {
        alive = isProcessAlive(holderPid);
      } catch {
        alive = true; // 保守判存活（与既有路径同口径）
      }
      if (alive) return false; // 复核后确认是存活他人锁：放弃回收
    }
  }
  // 2) 原子隔离到唯一路径（EISDIR 时锁路径是目录，rename 同样适用；symlink 只移链接本身）
  const quarantine =
    `${lockPath}.reclaim-${process.pid}-${Date.now().toString(36)}-` +
    Math.random().toString(36).slice(2, 8);
  try {
    renameSync(lockPath, quarantine);
  } catch {
    return false; // ENOENT（已被别的进程回收）等：本轮不回收，继续轮询
  }
  let moved: ReturnType<typeof lstatSync> | null = null;
  try { moved = lstatSync(quarantine); } catch { moved = null; }
  if (!moved || !areSameStat(before, moved)) {
    // 期间已被他人重建：我们移走的是它的新锁 ⇒ 尽力还原，绝不删除
    try { renameSync(quarantine, lockPath); } catch { /* 还原失败：保留隔离文件，不删 */ }
    return false;
  }
  try {
    rmSync(quarantine, { recursive: true, force: true });
  } catch {
    return false;
  }
  console.error(
    `[dsh-graph] 回收陈旧锁（无法确认持有者或本进程遗留）：${lockPath}；` +
      `原因=${reason}；内容=${holder === null ? "<不可读>" : JSON.stringify(holder)}`,
  );
  return true;
}

function acquireLock(lockPath: string, timeoutMs: number = 5000): void {
  const start = Date.now();
  const pid = process.pid;
  const key = lockKey(lockPath);
  let reclaims = 0;
  while (true) {
    try {
      // 原子写 PID 到锁文件（O_EXCL 语义通过 writeFileSync + 异常捕获模拟）
      writeFileSync(lockPath, String(pid), { flag: "wx" });
      heldLocks.add(key);
      return;
    } catch {
      // 锁被占用：检查是否过期（锁持有进程已死亡 / 身份不可确认的坏锁）
      if (existsSync(lockPath)) {
        try {
          const holder = readFileSync(lockPath, "utf8").trim();
          const holderPid = parseInt(holder, 10);
          if (pidLivenessDecidable(holderPid) && holderPid !== pid) {
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
                heldLocks.add(key);
                return;
              } catch { /* 竞争失败，继续轮询 */ }
            }
          } else if (holderPid === pid) {
            // 锁文件里是本进程 PID，但必须区分「真·同进程嵌套持有」与「本进程遗留孤儿锁」
            if (heldLocks.has(key)) {
              // 本进程确实持有着同一把锁：真·同进程嵌套获取，视为死锁（语义不变）
              throw new TxError(`同进程嵌套获取锁（${lockPath}）——死锁`, "read", true);
            }
            // g-394：本进程 PID 但本进程并未持有 ⇒ 上次遗留的孤儿锁（临界区崩溃残留 /
            // releaseLock 读不到身份而保守未删）。不是嵌套，按过期锁回收，
            // 否则本进程在剩余生命周期内永久拿不回自己的锁。
            if (reclaimStaleBadLock(lockPath, "内容为本进程 PID 但进程内未持有（遗留孤儿锁）")) {
              if (++reclaims <= MAX_LOCK_RECLAIMS) continue;
            }
          } else {
            // g-394：身份无从确认（0 字节 / 乱码 / 截断写 / 越界数字）⇒ 按 mtime 有界自愈
            const age = lockAgeMs(lockPath);
            if (
              age !== null && age > STALE_BAD_LOCK_MS &&
              reclaimStaleBadLock(lockPath, `持有者身份不可解析（内容=${JSON.stringify(holder)}），mtime 已过期 ${Math.round(age)}ms`)
            ) {
              if (++reclaims <= MAX_LOCK_RECLAIMS) continue;
            }
          }
        } catch (e) {
          if (e instanceof TxError) throw e;
          // g-394：读身份失败（EACCES/EISDIR/EIO）⇒ 读不到不等于可以盲删（保留 g-383 语义），
          // 但也不能让「本进程残留自身 PID 锁」永久不可用；按 mtime 有界自愈。
          const code = (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e);
          const age = lockAgeMs(lockPath);
          if (
            age !== null && age > STALE_BAD_LOCK_MS &&
            reclaimStaleBadLock(lockPath, `持有者身份不可读（${String(code)}），mtime 已过期 ${Math.round(age)}ms`)
          ) {
            if (++reclaims <= MAX_LOCK_RECLAIMS) continue;
          }
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
 *  读不到持有者身份时保守放弃删除——宁可留残余锁文件，也不误删他人锁。
 *
 *  g-394：保守不删**不等于**留下永久不可回收的锁——残留锁统一由 acquireLock 的
 *  mtime 有界自愈覆盖（含本进程 PID 的遗留锁走 heldLocks 判定）。此处只额外保证
 *  本进程的进程内持有记录一定被清除，否则下次获取自己的残留锁会被误判为嵌套死锁。 */
function releaseLock(lockPath: string): void {
  try {
    if (!existsSync(lockPath)) return;
    let holder: string;
    try {
      holder = readFileSync(lockPath, "utf8").trim();
    } catch {
      return; // 无法确认持有者身份：保守不删（由 g-394 mtime 有界自愈兜底回收）
    }
    if (holder !== String(process.pid)) return; // 锁已被他人接管：不删
    rmSync(lockPath, { force: true });
  } catch { /* 锁文件可能已被其他进程清理 */ } finally {
    // 无论文件是否删除成功，本进程都不再持有它：必须清记录，否则后续获取会误判为嵌套
    heldLocks.delete(lockKey(lockPath));
  }
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
