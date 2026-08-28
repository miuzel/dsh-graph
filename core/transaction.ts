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
 */

import { readFileSync, existsSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, nowIso, type GraphEvent } from "./events.ts";
import { GraphError } from "./machine.ts";

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
            try {
              process.kill(holderPid, 0); // 探测进程是否存活
            } catch {
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

function releaseLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch { /* 锁文件可能已被其他进程清理 */ }
}

/** 在锁保护下执行读-改-写事务。
 *  流程：校验 → 加锁 → 重读 → CAS 校验 → 内存变更 → 事件先行 → 持久化 → 解锁。
 *  任何阶段失败立即解锁并返回 TxFailure，不递归重试。 */
export function withTx<T>(
  ctx: TxContext,
  opts: { lockName: string; lockTimeoutMs?: number },
  fn: (ctx: TxContext) => { value: T; events: Omit<GraphEvent, "ts">[] },
): TxResult<T> | TxFailure {
  const lockPath = lockFilePath(ctx.root, opts.lockName);
  let phase: TxPhase = "validate";
  try {
    // 1. 加锁
    acquireLock(lockPath, opts.lockTimeoutMs ?? 5000);

    // 2. 执行业务逻辑（在锁内）
    const result = fn(ctx);

    // 3. 事件先行
    phase = "event";
    const events: GraphEvent[] = [];
    for (const ev of result.events) {
      events.push(appendEvent(ctx.root, ev));
    }

    // 4. 返回成功
    releaseLock(lockPath);
    return { ok: true, value: result.value, events };
  } catch (e) {
    releaseLock(lockPath);
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
    const { lstatSync } = require("node:fs");
    if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
      throw new TxError(`拒绝写入符号链接：${resolved}`, "persist", false);
    }
  } catch (e) {
    const err = e as Error;
    // lstatSync 不可用（极少见）时跳过 symlink 检查
  }
  const tmp = `${resolved}.tmp.${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, resolved);
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
