import { resolve } from "node:path";
import { watch, type FSWatcher } from "node:fs";
const generations = new Map<string, number>();
const watchers = new Map<string, FSWatcher>();
const unsafe = new Set<string>();
// Watcher close/reopen is lifecycle-only; content generation remains unchanged.
const watcherEpochs = new Map<string, number>();
export const MAX_WATCHERS = 32;
// g-392：GUI 轮询默认 15s、最低 5s（helpers.js DEFAULT/MIN_REFRESH_INTERVAL）。旧值 500ms
// 远短于轮询间隔 ⇒ 每次轮询前 watcher 都已空闲关闭并 bump epoch ⇒ cache.ts 判 rescan ⇒
// 即使内容无变化也调用 payloadFactory 完整重建（最终仍可能 fromCache=true，不代表省去投影）。
// 取「默认轮询间隔 + 5s 余量」作为**有限**空闲 TTL：正常轮询期间 watcher 保持存活（epoch 稳定、
// 无重建）；真正空闲（>20s 无任何读取）仍在 TTL 后关闭并 bump epoch，断档 rescan 兜底不变。
// 仍为有限 TTL：非常规超长轮询间隔（>20s，GUI 允许自定义）会退回「每次轮询一次 rescan 重建」，
// 只是少优化、不少正确性。
const IDLE_CLOSE_MS = 20_000;
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
// g-411：空闲 TTL 的**测试专用**注入。默认 null ⇒ 与修复前逐字等价的 20s；且仅在 node:test
// 子进程（NODE_TEST_CONTEXT 由测试运行器设置）内生效 —— 生产进程调用是 no-op，故它不构成
// 生产配置面（无 env 开关、无配置文件、无对外 API），默认 20s 生产语义不可能被改掉。
let idleCloseMsForTests: number | null = null;
export function __setWatcherIdleCloseMsForTests(ms: number | null): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  idleCloseMsForTests = ms;
}
function bumpWatcherEpoch(key: string): void { watcherEpochs.set(key, (watcherEpochs.get(key) ?? 0) + 1); }
export function generation(root: string): number { return generations.get(resolve(root)) ?? 0; }
export function invalidate(root?: string): void { if (!root) { generations.clear(); watcherEpochs.clear(); return; } const key=resolve(root); generations.set(key,generation(key)+1); }
function armIdle(key: string, w: FSWatcher): void {
  const previous=idleTimers.get(key); if (previous) clearTimeout(previous);
  const timer=setTimeout(() => {
    if (watchers.get(key) !== w || idleTimers.get(key) !== timer) return;
    try { w.close(); } catch {}
    watchers.delete(key); idleTimers.delete(key); bumpWatcherEpoch(key);
  }, watcherIdleCloseMs());
  timer.unref?.(); idleTimers.set(key,timer);
}
export function ensureWatcher(root: string): boolean {
  const key=resolve(root); const existing=watchers.get(key);
  if (existing) { armIdle(key,existing); return !unsafe.has(key); }
  try {
    if (watchers.size >= MAX_WATCHERS) { const oldest=watchers.keys().next().value; if (oldest) { const ow=watchers.get(oldest); const ot=idleTimers.get(oldest); if (ot) clearTimeout(ot); try { ow?.close(); } catch {} watchers.delete(oldest); idleTimers.delete(oldest); bumpWatcherEpoch(oldest); } }
    const w=watch(key,{recursive:true},()=>invalidate(key)); w.unref?.();
    w.on("error",()=>{ const t=idleTimers.get(key); if (t) clearTimeout(t); if (watchers.get(key)===w) { watchers.delete(key); idleTimers.delete(key); bumpWatcherEpoch(key); } unsafe.add(key); invalidate(key); try { w.close(); } catch {} });
    watchers.set(key,w); unsafe.delete(key); armIdle(key,w); return true;
  } catch { unsafe.add(key); return false; }
}
export function watcherSafe(root: string): boolean { return ensureWatcher(root) && !unsafe.has(resolve(root)); }
export function watcherEpoch(root: string): number { return watcherEpochs.get(resolve(root)) ?? 0; }
export function closeWatchers(): void { for (const key of watchers.keys()) bumpWatcherEpoch(key); for (const t of idleTimers.values()) clearTimeout(t); idleTimers.clear(); for (const w of watchers.values()) try { w.close(); } catch {} watchers.clear(); }
export function inspectGenerations() { return generations; }
/** g-392：空闲关闭 TTL 的只读口径（供回归测试断言「有限 TTL 必须覆盖默认轮询间隔」）。
 *  g-411：返回测试注入值（若有），否则默认 IDLE_CLOSE_MS —— armIdle 也读同一口径，
 *  保证「注入值 = 真实排定的定时器延迟」不会被两条路径写歪。 */
export function watcherIdleCloseMs(): number { return idleCloseMsForTests ?? IDLE_CLOSE_MS; }
/** g-392：资源自省（只读计数，不暴露可变引用）——watcher/timer 数量与计时器 unref 状态。
 *  注：Node 的 FSWatcher 不暴露 hasRef()，且本平台（Node v26/Linux）递归 watcher 的 unref 不生效
 *  （既有平台事实，非本次改动引入）；真实释放路径（closeWatchers / 上限驱逐）由
 *  g392-watcher-resource.test.ts 的行为断言覆盖。 */
export function inspectWatchers() {
  const refd=(x:unknown):boolean => typeof (x as {hasRef?:()=>boolean})?.hasRef === "function" ? (x as {hasRef:()=>boolean}).hasRef() : true;
  return {
    size: watchers.size,
    keys: [...watchers.keys()],
    timers: idleTimers.size,
    timerRefs: [...idleTimers.values()].map(refd),
    unsafe: [...unsafe],
  };
}
