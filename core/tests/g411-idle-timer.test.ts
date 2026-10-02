/**
 * g-411：空闲关闭的**真实定时器**路径端到端覆盖（补 g-392 的覆盖缺口）。
 *
 * 缺口（g-392 复核者跟进项 1）：IDLE_CLOSE_MS 500 → 20000 后，既有测试改用显式
 * closeWatchers() 模拟空闲关闭；全套件 ≈27s ≪ 20s TTL ⇒ `armIdle` 的定时器回调
 * （含其中 stale-guard）**在测试中永不真实触发**，接线（armIdle → 回调 → close +
 * bump epoch → 下次读取 rescan）无端到端覆盖。
 *
 * 本文件做的事：
 *   判据 1  TTL 测试专用注入（`__setWatcherIdleCloseMsForTests`）：只在 node:test 子进程
 *           （NODE_TEST_CONTEXT）内生效；子进程分别在有/无该环境变量下调用同一注入，
 *           证明「生产形态进程内注入是 no-op、TTL 恒为 20s」而不是靠口头约定。
 *   判据 2  注入 TTL=120ms，**不调用 closeWatchers()**，只让时间流逝：真实定时器到期后
 *           watcher 被关闭、epoch 恰好 +1；断档期外部写入不被 watcher 捕获（generation 不变，
 *           证明 watcher 确已关闭），下次读取必须 rescan 检出、ETag 不复用。触发源证据 =
 *           读取续期时真实 setTimeout 拿到的延迟恰等于注入 TTL。
 *   判据 3  stale-guard 两条子句各钉一遍（都是真实代码路径 + 手动触发捕获到的定时器回调，
 *           以确定性模拟「回调已入队/迟到」的竞态）：
 *             3a 读取续期后旧 timer 到期 ⇒ 不得误关仍在册的 watcher、不得 bump epoch；
 *             3b 真实空闲关闭后重开出**新** watcher，旧 timer 迟到到期 ⇒ 不得误关新 watcher、
 *                不得清掉新计时器、不得重复 bump epoch。
 *   判据 4  负向对照**实际执行**：把 dist/core/cache-state.js 变异成「删守卫」/「回退 TTL 注入」
 *           后放进临时目录跑同一段对照脚本，断言观测到的就是坏行为（删守卫 ⇒ alive:false、
 *           epochDelta:1；回退注入 ⇒ closed:false）⇒ 判据 3/2 的断言在回退时必红，红因即
 *           「watcher 被误关 / epoch 重复 bump / 定时器不再按注入 TTL 到期」。另有结构性守卫。
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { boardPayload, createGoal, init } from "../../dist/core/ops.js";
import { getCachedBoardPayload } from "../../dist/core/cache.js";
import {
  __setWatcherIdleCloseMsForTests,
  closeWatchers,
  ensureWatcher,
  generation,
  inspectWatchers,
  watcherEpoch,
  watcherIdleCloseMs,
} from "../../dist/core/cache-state.js";

const STATE_SRC = join(import.meta.dirname, "../../core/cache-state.ts");
const STATE_DIST_URL = pathToFileURL(join(import.meta.dirname, "../../dist/core/cache-state.js")).href;
const DEFAULT_TTL = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const workspaces: string[] = [];

function setup(tag: string) {
  const ws = mkdtempSync(join(tmpdir(), `dsh-g411-${tag}-`));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goalId = createGoal(root, { title: "定时器目标", actor: "test" });
  workspaces.push(ws);
  return { ws, root, goalId };
}

function cleanupAll(): void {
  closeWatchers();
  for (const ws of workspaces) {
    try { rmSync(ws, { recursive: true, force: true }); } catch {}
  }
  workspaces.length = 0;
}

after(() => { __setWatcherIdleCloseMsForTests(null); cleanupAll(); });

/** 只写 backlog/<goalId>.md：不在 revision 哈希覆盖的 4 个文件内 ⇒ 只能靠 rescan 检出。 */
function externalTitle(root: string, goalId: string, title: string): void {
  writeFileSync(
    join(root, "backlog", `${goalId}.md`),
    `---\n${JSON.stringify({ id: goalId, title, status: "backlog" })}\n---\n\n## 描述\n定时器断档期间外部写入\n`,
    "utf8",
  );
}

function countingFactory() {
  const state = { calls: 0 };
  const factory = (root: string, opts: { includeArchived: boolean; lazy: boolean }) => {
    state.calls += 1;
    return boardPayload(root, { includeArchived: opts?.includeArchived, lazy: opts?.lazy });
  };
  return { state, factory };
}

/** 同步捕获 armIdle 真实排定的定时器（包一层 globalThis.setTimeout，随即还原）。
 *  返回的 fire() 直接执行**生产代码里那个定时器回调闭包**——这是确定性模拟
 *  「回调已入队 / 迟到到期」的唯一手段（真实 clearTimeout 会让它不再自然触发）。 */
function captureArmedTimers<T>(fn: () => T): { result: T; armed: Array<{ delay: number; fire: () => void }> } {
  const real = globalThis.setTimeout;
  const armed: Array<{ delay: number; fire: () => void }> = [];
  (globalThis as any).setTimeout = (cb: (...a: any[]) => void, delay?: number, ...args: any[]) => {
    armed.push({ delay: Number(delay), fire: () => cb(...args) });
    return real(cb as any, delay as any, ...args);
  };
  try {
    return { result: fn(), armed };
  } finally {
    (globalThis as any).setTimeout = real;
  }
}

function runChildModule(moduleUrl: string, source: string, env?: NodeJS.ProcessEnv) {
  const code = `const MOD = ${JSON.stringify(moduleUrl)};\n${source}`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: env ?? process.env,
    timeout: 20_000,
  });
}

/* ── 判据 4 的对照脚本（在子进程里跑，可指定未变异/变异模块）────────────────── */

const GUARD_CHILD = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { ensureWatcher, inspectWatchers, watcherEpoch } = await import(MOD);
const dir = mkdtempSync(join(tmpdir(), "g411-guard-"));
const root = join(dir, ".dsh-graph");
mkdirSync(root, { recursive: true });
const armed = [];
const real = globalThis.setTimeout;
globalThis.setTimeout = (cb, ms, ...a) => { armed.push(cb); return real(cb, ms, ...a); };
ensureWatcher(root);
ensureWatcher(root);            // 读取续期：clearTimeout 旧 timer 并重排新 timer
globalThis.setTimeout = real;
const epoch0 = watcherEpoch(root);
armed[0]();                     // 旧 timer 到期（手动触发，模拟回调已入队/迟到）
const info = inspectWatchers();
rmSync(dir, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ alive: info.size === 1 && info.keys.includes(root), timers: info.timers, epochDelta: watcherEpoch(root) - epoch0 }));
`;

const TTL_CHILD = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { ensureWatcher, inspectWatchers, watcherEpoch, __setWatcherIdleCloseMsForTests } = await import(MOD);
const dir = mkdtempSync(join(tmpdir(), "g411-ttl-"));
const root = join(dir, ".dsh-graph");
mkdirSync(root, { recursive: true });
__setWatcherIdleCloseMsForTests(100);
ensureWatcher(root);
const epoch0 = watcherEpoch(root);
await new Promise((r) => setTimeout(r, 420));
const info = inspectWatchers();
rmSync(dir, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ closed: info.size === 0, timers: info.timers, epochDelta: watcherEpoch(root) - epoch0 }));
`;

/** 变异 dist 模块并在临时目录里执行同一对照脚本（变异必须真实生效，否则对照是空转）。 */
function runMutatedState(mutate: (src: string) => string, source: string) {
  const src = readFileSync(join(import.meta.dirname, "../../dist/core/cache-state.js"), "utf8");
  const mutated = mutate(src);
  assert.notEqual(mutated, src, "变异未命中源码（守卫/注入可能已被删除或改写）⇒ 负向对照失效");
  const dir = mkdtempSync(join(tmpdir(), "dsh-g411-mut-"));
  try {
    const file = join(dir, "cache-state.mut.mjs");
    writeFileSync(file, mutated, "utf8");
    return runChildModule(pathToFileURL(file).href, source);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 判据 1 ─────────────────────────────────────────────────────────────── */

test("g-411 判据 1：TTL 注入只在测试进程生效，生产形态进程内恒为默认 20s", () => {
  try {
    assert.ok(process.env.NODE_TEST_CONTEXT, "本用例必须运行在 node:test 子进程内");
    assert.equal(watcherIdleCloseMs(), DEFAULT_TTL, "未注入时必须是默认 20s");
    __setWatcherIdleCloseMsForTests(120);
    assert.equal(watcherIdleCloseMs(), 120, "测试上下文内注入必须生效");
    __setWatcherIdleCloseMsForTests(null);
    assert.equal(watcherIdleCloseMs(), DEFAULT_TTL, "复位后必须回到 20s");

    const probe =
      `const { __setWatcherIdleCloseMsForTests, watcherIdleCloseMs } = await import(MOD);` +
      `__setWatcherIdleCloseMsForTests(5); process.stdout.write(String(watcherIdleCloseMs()));`;
    const prodEnv: NodeJS.ProcessEnv = { ...process.env };
    delete prodEnv.NODE_TEST_CONTEXT;
    const prod = runChildModule(STATE_DIST_URL, probe, prodEnv);
    assert.equal(prod.status, 0, prod.stderr);
    assert.equal(prod.stdout, String(DEFAULT_TTL), "生产形态进程内注入必须 no-op（TTL 仍是 20s）");
    const testEnv: NodeJS.ProcessEnv = { ...process.env, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT };
    const t = runChildModule(STATE_DIST_URL, probe, testEnv);
    assert.equal(t.status, 0, t.stderr);
    assert.equal(t.stdout, "5", "同一探针在测试上下文内必须读到注入值（否则上面的 no-op 断言是空转）");
  } finally {
    __setWatcherIdleCloseMsForTests(null);
  }
});

/* ── 判据 2 ─────────────────────────────────────────────────────────────── */

test("g-411 判据 2：短 TTL 下真实定时器触发一次空闲关闭（未调用 closeWatchers）", async () => {
  const TTL = 120;
  const { root, goalId } = setup("timer");
  try {
    __setWatcherIdleCloseMsForTests(TTL);
    const { state, factory } = countingFactory();
    const first = getCachedBoardPayload(root, undefined, factory);
    assert.equal(state.calls, 1);
    const epoch0 = watcherEpoch(root);
    assert.equal(inspectWatchers().size, 1, "首次读取后 watcher 必须存活");
    assert.equal(inspectWatchers().timers, 1, "首次读取后必须已排定空闲计时器");

    // 触发源证据：读取续期真实调用 setTimeout，其延迟必须等于注入 TTL。
    const { armed } = captureArmedTimers(() => ensureWatcher(root));
    assert.equal(armed.length, 1, "读取续期必须恰好重新排定一个空闲计时器");
    assert.equal(armed[0].delay, TTL, `排定延迟必须是注入 TTL=${TTL}ms，实际 ${armed[0].delay}ms`);

    const started = Date.now();
    await sleep(TTL + 180); // 只有时间流逝：本用例全程不调用 closeWatchers() / ensureWatcher 关闭路径
    const elapsed = Date.now() - started;
    const fired = inspectWatchers();
    assert.equal(fired.size, 0, `watcher 必须已被空闲定时器关闭（TTL=${TTL}ms, elapsed=${elapsed}ms）`);
    assert.equal(fired.timers, 0, "关闭后不得残留空闲计时器");
    assert.equal(watcherEpoch(root), epoch0 + 1, "空闲关闭必须恰好 bump 一次 epoch");

    // 断档期外部变更：watcher 已关闭 ⇒ 事件不被捕获；下次读取只能靠 rescan 检出。
    const genBefore = generation(root);
    externalTitle(root, goalId, "定时器断档期间外部修改");
    await sleep(150);
    assert.equal(generation(root), genBefore, "watcher 已关闭 ⇒ 断档期写入不得被 watcher 事件捕获");
    const after = getCachedBoardPayload(root, undefined, factory);
    assert.equal(after.fromCache, false, "rescan 必须返回新载荷（不得复用旧缓存）");
    assert.notEqual(after.etag, first.etag, "rescan 检出后 ETag 不得复用");
    assert.equal(after.payload.backlog[0].title, "定时器断档期间外部修改");
    assert.equal(state.calls, 2, `断档检出应重建一次（累计 2），实际 ${state.calls}`);
  } finally {
    __setWatcherIdleCloseMsForTests(null);
    cleanupAll();
  }
});

/* ── 判据 3 ─────────────────────────────────────────────────────────────── */

test("g-411 判据 3a：读取续期后旧定时器到期 ⇒ 不误关 watcher、不 bump epoch", async () => {
  const TTL = 200;
  const { root } = setup("stale-renew");
  try {
    __setWatcherIdleCloseMsForTests(TTL);
    const firstArm = captureArmedTimers(() => ensureWatcher(root));
    assert.equal(firstArm.armed.length, 1);
    const epoch0 = watcherEpoch(root);

    const renewed = captureArmedTimers(() => ensureWatcher(root)); // 读取续期：重排定时器
    assert.equal(renewed.armed.length, 1);
    assert.equal(inspectWatchers().timers, 1, "续期后只应有一个空闲计时器");

    firstArm.armed[0].fire(); // 旧 timer 到期（stale-guard 应挡下）
    const stale = inspectWatchers();
    assert.equal(stale.size, 1, "旧 timer 到期不得误关仍被续期持有的 watcher");
    assert.equal(stale.keys.includes(root), true, "watcher 必须仍在册");
    assert.equal(stale.timers, 1, "旧 timer 到期不得清掉新计时器");
    assert.equal(watcherEpoch(root), epoch0, "旧 timer 到期不得 bump epoch");

    await sleep(TTL + 180); // 新 timer 真实到期：仍必须正常关闭，且只 bump 一次
    assert.equal(inspectWatchers().size, 0, "新定时器到期必须真实关闭 watcher");
    assert.equal(watcherEpoch(root), epoch0 + 1, "epoch 只允许 bump 一次（旧 timer 未重复 bump）");
  } finally {
    __setWatcherIdleCloseMsForTests(null);
    cleanupAll();
  }
});

test("g-411 判据 3b：旧定时器迟到到期于重开的新 watcher ⇒ 不误关、不重复 bump epoch", async () => {
  const TTL = 120;
  const { root } = setup("stale-reopen");
  try {
    __setWatcherIdleCloseMsForTests(TTL);
    const gen1 = captureArmedTimers(() => ensureWatcher(root)); // watcher#1 + timer#1
    await sleep(TTL + 180); // timer#1 真实到期：watcher#1 关闭、epoch +1
    assert.equal(inspectWatchers().size, 0);
    const epochAfterClose = watcherEpoch(root);
    assert.equal(epochAfterClose, 1);

    const gen2 = captureArmedTimers(() => ensureWatcher(root)); // 重开：watcher#2 + timer#2
    assert.equal(gen2.armed.length, 1);
    assert.equal(inspectWatchers().size, 1);

    gen1.armed[0].fire(); // 旧 timer（绑定 watcher#1）迟到到期
    const info = inspectWatchers();
    assert.equal(info.size, 1, "旧定时器不得误关重开出来的新 watcher");
    assert.equal(info.keys.includes(root), true, "新 watcher 必须仍在册");
    assert.equal(info.timers, 1, "新 watcher 的空闲计时器不得被旧回调清掉");
    assert.equal(watcherEpoch(root), epochAfterClose, "旧定时器不得重复 bump epoch");
  } finally {
    __setWatcherIdleCloseMsForTests(null);
    cleanupAll();
  }
});

/* ── 判据 4 ─────────────────────────────────────────────────────────────── */

test("g-411 判据 4a：负向对照（实际执行）——删掉 stale-guard 即观测到误关 + 重复 bump", () => {
  const good = runChildModule(STATE_DIST_URL, GUARD_CHILD);
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(
    JSON.parse(good.stdout),
    { alive: true, timers: 1, epochDelta: 0 },
    "未变异时旧 timer 必须被守卫挡住（与判据 3a 同一断言）",
  );

  const bad = runMutatedState(
    (s) => s.replace(/\n\s*if \(watchers\.get\(key\) !== w \|\| idleTimers\.get\(key\) !== timer\)\s*\n\s*return;/, ""),
    GUARD_CHILD,
  );
  assert.equal(bad.status, 0, bad.stderr);
  assert.deepEqual(
    JSON.parse(bad.stdout),
    { alive: false, timers: 0, epochDelta: 1 },
    "删守卫后必须观测到「误关 watcher + 重复 bump epoch」⇒ 判据 3a/3b 在删守卫时必红",
  );
});

test("g-411 判据 4b：负向对照（实际执行）——回退 TTL 注入即观测到定时器不再按注入值到期", () => {
  const good = runChildModule(STATE_DIST_URL, TTL_CHILD);
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(
    JSON.parse(good.stdout),
    { closed: true, timers: 0, epochDelta: 1 },
    "未变异时注入 TTL=100ms 必须让真实定时器到关闭 watcher（与判据 2 同一接线）",
  );

  const bad = runMutatedState((s) => s.replace("}, watcherIdleCloseMs());", "}, IDLE_CLOSE_MS);"), TTL_CHILD);
  assert.equal(bad.status, 0, bad.stderr);
  assert.deepEqual(
    JSON.parse(bad.stdout),
    { closed: false, timers: 1, epochDelta: 0 },
    "回退注入后 420ms 内 watcher 必须仍然存活（20s TTL）⇒ 判据 2 在回退注入时必红",
  );
});

test("g-411 判据 4c：结构性守卫（默认 20s / 注入门禁 / 承重接线）", () => {
  const src = readFileSync(STATE_SRC, "utf8");
  assert.match(src, /const IDLE_CLOSE_MS = 20_000;/, "默认空闲 TTL 必须是 20s（生产语义不变）");
  assert.match(src, /export function __setWatcherIdleCloseMsForTests\(/, "测试专用注入口必须存在");
  assert.match(
    src,
    /if \(!process\.env\.NODE_TEST_CONTEXT\) return;/,
    "注入必须被 node:test 上下文门禁挡住（生产进程 no-op）",
  );
  assert.match(src, /\}, watcherIdleCloseMs\(\)\);/, "armIdle 必须排定可注入的 TTL（否则判据 2 无法确定性地触发）");
  assert.match(
    src,
    /if \(watchers\.get\(key\) !== w \|\| idleTimers\.get\(key\) !== timer\) return;/,
    "stale-guard 必须同时校验 watcher 身份与 timer 身份",
  );
  const envReads = src.match(/process\.env\./g) ?? [];
  assert.equal(envReads.length, 1, `除 node:test 上下文外不得读取任何 env（不得引入生产配置面），实际 ${envReads.length} 处`);
});
