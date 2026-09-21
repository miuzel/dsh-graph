/**
 * g-324：看板「刷新」按钮不重置自动刷新倒计时（g-214 判据 3 × g-212 ETag/watcher 缓存 交互回归）。
 *
 * 缺陷：`RefreshCountdown` 的重置 effect 依赖 `[generatedAt, intervalSec]`，挂载时传 `b.generated_at`。
 * 一次手动刷新在内容未变时不会改 `generated_at`：
 *   1. 服务端 ETag 命中 → 304，客户端复用 retained 载荷（generated_at 不变）；
 *   2. 服务端 200 但 watcher 缓存命中 → 返回同一份旧 payload（generated_at 同样不变）。
 * 两条路径下重置 effect 都不触发，倒计时继续沿旧终点递减。
 *
 * 本测试执行的是**模块里真实的代码**，不是重写一份：
 *   - 从 kanban.js 精确抠出 `load()` 函数体（花括号配平），用 `with (env)` 注入它的闭包自由变量
 *     （refs / setState / fetch / 真实 reconcileRetainedBoardState），从而可直接驱动 304 / 200 /
 *     forceFresh 重试 / 错误四条真实分支，并观察「刷新流程完成」信号；
 *   - 从 helpers.js 抠出真实的 `RefreshCountdown`，用带依赖数组比较的轻量 React mock + 可控假时钟
 *     驱动 tick/effects，断言的是「倒计时读数回到完整周期」这一真实行为，而非自证式文本匹配。
 *
 * 负向对照（brief 验收 2）：把 helpers.js 的重置依赖改回「仅 generatedAt」（去掉 refreshSignal），
 * 本文件的判据 1 用例必然变红；恢复后变绿。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reconcileRetainedBoardState } from "../../dsh-graph-host/lib/client/board-retain.js";

const ROOT = join(import.meta.dirname, "../..");
const kanbanSource = () => readFileSync(join(ROOT, "dsh-graph-host/lib/client/kanban.js"), "utf8");
const helpersSource = () => readFileSync(join(ROOT, "dsh-graph-host/lib/client/helpers.js"), "utf8");

/** 从源模块中按花括号配平抠出一段 `const ... = (...) => { ... }` / `function x() { ... }`。 */
function extractBalanced(source: string, marker: string, fromIndex = 0): string {
  const at = source.indexOf(marker, fromIndex);
  assert.ok(at >= 0, `源模块中存在 ${marker}`);
  let depth = 0;
  for (let i = source.indexOf("{", at); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`${marker} 花括号无法配平`);
}

// ===== 一、把 kanban.js 的真实 load() 变成可驱动的函数 =====

const GENERATED_AT = "2025-01-01T00:00:00.000Z";
const LATER_GENERATED_AT = "2025-01-01T00:05:00.000Z";
const DIM = "s-1::/ws::0";
const payload = (generatedAt: string = GENERATED_AT) => ({
  generated_at: generatedAt,
  versions: [],
  backlog: [{ id: "g-1", title: "t" }],
  standalone: [],
  backlog_count: 1,
  lazy: true,
});

function makeKanbanLoad(opts: any = {}) {
  const chunk = extractBalanced(kanbanSource(), "const load = () => {");
  const env: any = {
    props: { sessionId: "s-1" },
    activeWs: "/ws",
    showArchived: false,
    boardIdentity: DIM,
    boardIdentityRef: { current: DIM },
    requestSeqRef: { current: 0 },
    forceFreshRef: { current: Boolean(opts.forceFresh) },
    currentEtagRef: { current: new Map(opts.etags ?? [[DIM, 'W/"e1"']]) },
    boardDataRef: { current: new Map(opts.retained ?? []) },
    collapsedLanes: {},
    openReleased: {},
    reconcileRetainedBoardState,
    graphUrlForActive: (path: string) => "http://board.test" + path,
    setState: (next: any) => { env.states.push(next); },
    setOrderMap: () => {},
    setRefreshCycle: (updater: any) => {
      env.refreshCycle = typeof updater === "function" ? updater(env.refreshCycle) : updater;
      env.cycles.push(env.refreshCycle);
    },
    loadOrder: () => { env.loadOrderCalls += 1; },
    loadBacklogGoals: () => { env.refetchBacklog += 1; },
    loadVersionGoals: () => { env.refetchVersions.push(1); },
    getHiddenVersionEntries: () => [],
    setHiddenVersionSlugs: () => {},
    applyUpdateEmphasis: () => { env.emphasisCalls += 1; },
    applyForceReplay: () => { env.replayCalls += 1; },
    setRefreshIntervalSec: () => {},
    console,
    // 观察量
    refreshCycle: 0,
    cycles: [] as number[],
    states: [] as any[],
    loadOrderCalls: 0,
    refetchBacklog: 0,
    refetchVersions: [] as number[],
    emphasisCalls: 0,
    replayCalls: 0,
    fetchCalls: [] as any[],
  };
  const responses = opts.responses ?? [{ status: 304 }];
  env.fetch = async (url: string, init: any) => {
    const index = env.fetchCalls.length;
    env.fetchCalls.push({ url, headers: { ...(init?.headers ?? {}) } });
    const spec = responses[Math.min(index, responses.length - 1)];
    if (spec.reject) throw spec.reject;
    return {
      status: spec.status,
      headers: { get: (name: string) => (String(name).toLowerCase() === "etag" ? spec.etag ?? null : null) },
      json: async () => (typeof spec.body === "function" ? spec.body() : spec.body),
    };
  };
  const compiled = new Function("__env", `with (__env) {\n${chunk}\nreturn load;\n}`)(env);
  return { env, load: compiled as () => void };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 最近一次「刷新流程」落定的载荷（错误路径为 null）——用于取本次 generated_at。 */
function lastFlowGat(env: any): string | null {
  for (let i = env.states.length - 1; i >= 0; i--) {
    const s = env.states[i];
    if (s.error) return null;
    if (s.data && s.loading === false) return s.data.generated_at;
  }
  return null;
}

/** 重置判据（与 helpers.js 重置 effect 的依赖数组逐项比较同语义）：返回依赖变化次数。
 *  renders 为每次 render 的依赖快照，keys 为参与比较的字段——用来对比「旧实现（仅
 *  generatedAt/intervalSec）」与「新实现（刷新完成信号 + generatedAt + intervalSec）」。 */
function resetCountFrom(renders: Array<Record<string, any>>, keys: string[]) {
  let resets = 0;
  let prev: any[] | null = null;
  for (const r of renders) {
    const deps = keys.map((k) => r[k]);
    if (prev && deps.some((d, j) => !Object.is(d, prev![j]))) resets += 1;
    prev = deps;
  }
  return resets;
}

// ===== 二、把 helpers.js 的真实 RefreshCountdown 变成可驱动的组件 =====

function makeCountdownHarness() {
  const src = helpersSource();
  const chunk = extractBalanced(src, "function RefreshCountdown(props)");
  const effects: Array<{ fn: any; deps: any }> = [];
  const slots: any[] = [];
  const cleanups: Array<() => void> = [];
  const listeners: Array<{ type: string; fn: any }> = [];
  const timers: Array<{ fn: any; id: number }> = [];
  let timerSeq = 0;
  let cursor = 0;
  let clock = 0; // 可控假时钟（ms）：让 tick 能真实推进「1 秒」
  let prevDeps: any[] | null = null;
  let stateVersion = 0;

  const React = {
    useState(init: any) {
      const i = cursor++;
      if (slots.length <= i) slots.push(typeof init === "function" ? init() : init);
      return [slots[i], (v: any) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; stateVersion += 1; }];
    },
    useRef(init: any) {
      const i = cursor++;
      if (slots.length <= i) slots.push({ current: init });
      return slots[i];
    },
    useEffect(fn: any, deps: any) { effects.push({ fn, deps }); },
  };
  const sandbox: any = {
    React,
    Date: { now: () => clock },
    document: {
      visibilityState: "visible",
      addEventListener: (type: string, fn: any) => { listeners.push({ type, fn }); },
      removeEventListener: () => {},
    },
    setInterval: (fn: any) => { const id = ++timerSeq; timers.push({ fn, id }); return id; },
    clearInterval: (id: any) => { const at = timers.findIndex((t) => t.id === id); if (at >= 0) timers.splice(at, 1); },
    dgT: (key: string, params: any) => `${key}${params ? JSON.stringify(params) : ""}`,
    S: { meta: {} },
    h: (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children }),
  };
  const compiled = new Function("sandbox", `with (sandbox) {\n${chunk}\nreturn RefreshCountdown;\n}`)(sandbox) as (props: any) => any;

  const readText = () => {
    const texts: string[] = [];
    const walk = (n: any) => {
      if (typeof n === "string") { texts.push(n); return; }
      if (typeof n === "number") { texts.push(String(n)); return; }
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (Array.isArray(n.children)) n.children.forEach(walk);
    };
    walk(sandbox.__vnode);
    return texts.join("|");
  };
  /** 一次 React 渲染 + 依赖数组比较 + effects 提交（state 变化则再渲染，最多 5 轮）。 */
  const commit = (props: any) => {
    for (let iter = 0; iter < 5; iter++) {
      const versionBefore = stateVersion;
      cursor = 0;
      effects.length = 0;
      const vnode = compiled(props);
      const pending = effects.slice();
      for (const { fn, deps } of pending) {
        const changed = !prevDeps || !deps || deps.some((d: any, i: number) => !Object.is(d, prevDeps![i]));
        if (changed) {
          const cleanup = fn();
          if (typeof cleanup === "function") cleanups.push(cleanup);
        }
      }
      const withDeps = pending.find((e) => e.deps);
      if (withDeps) prevDeps = withDeps.deps.slice();
      sandbox.__vnode = vnode;
      if (stateVersion === versionBefore) break; // 无 state 变化 → 渲染稳定
    }
    return sandbox.__vnode;
  };
  const tick = (times = 1) => {
    for (let i = 0; i < times; i++) {
      clock += 1000;
      for (const t of [...timers]) t.fn();
      commit(sandbox.__lastProps ?? {});
    }
  };
  const remaining = () => {
    const m = /(\d+)s/.exec(readText());
    return m ? Number(m[1]) : NaN;
  };
  return {
    render: (props: any) => { sandbox.__lastProps = props; return commit(props); },
    tick,
    remaining,
    listeners,
    timers,
    cleanups,
  };
}

// ===== 判据 1：304（ETag 命中）刷新完成后倒计时立即重置 =====

test("g-324 判据1：304 刷新（generated_at 不变）后倒计时重置为完整周期", async () => {
  const { env, load } = makeKanbanLoad({
    retained: [[DIM, payload()]],
    responses: [{ status: 304 }],
  });
  load();
  await flush();
  const gat1 = lastFlowGat(env);
  load();
  await flush();
  const gat2 = lastFlowGat(env);

  assert.equal(env.cycles.length, 2, "两次刷新流程完成 → 恰好两次完成信号");
  assert.deepEqual(env.cycles, [1, 2], "完成信号单调自增（不是每次 render/setState 递增）");
  assert.equal(gat1, GENERATED_AT, "304 复用 retained 载荷");
  assert.equal(gat2, GENERATED_AT, "304 路径 generated_at 与首次完全相同（缺陷场景）");

  // 语义级：旧判据（仅 generatedAt/intervalSec，两者恒定）→ 0 次重置；
  // 新判据（含刷新完成信号）→ 每次刷新完成各重置一次
  const renders = [
    { signal: 0, generatedAt: GENERATED_AT, intervalSec: 15 },
    { signal: env.cycles[0], generatedAt: gat1, intervalSec: 15 },
    { signal: env.cycles[1], generatedAt: gat2, intervalSec: 15 },
  ];
  assert.equal(resetCountFrom(renders, ["generatedAt", "intervalSec"]), 0, "负向前提：仅 generatedAt 判据在 304 下不重置");
  assert.equal(resetCountFrom(renders, ["signal", "generatedAt", "intervalSec"]), 2, "完成信号判据：304 下两次刷新各自重置一次");

  // 真实组件行为：递减到 1s → 一次 304 刷新完成 → 读数立即回到完整周期
  const h = makeCountdownHarness();
  const props = (signal: number) => ({ generatedAt: GENERATED_AT, refreshSignal: signal, intervalSec: 15, onTriggerRefresh: () => {} });
  h.render(props(0));
  h.tick(14);
  assert.equal(h.remaining(), 1, "刷新前倒计时已递减到 1s（缺陷可见位置）");
  h.render(props(env.refreshCycle)); // 一次刷新流程完成（304，generated_at 未变）
  assert.equal(h.remaining(), 15, "304 刷新完成后倒计时立即回到完整周期 15s");
});

// ===== 判据 1：200 但 watcher 缓存命中（generated_at 未变）同样重置 =====

test("g-324 判据1：200（watcher 缓存命中、generated_at 未变）刷新后同样重置为完整周期", async () => {
  const cached = payload(); // 服务端 watcher 缓存命中：两次返回同一份旧 payload
  const { env, load } = makeKanbanLoad({
    retained: [[DIM, payload()]],
    responses: [
      { status: 200, body: () => payload(), etag: 'W/"e1"' },
      { status: 200, body: () => cached, etag: 'W/"e1"' },
    ],
  });
  load();
  await flush();
  const gat1 = lastFlowGat(env);
  load();
  await flush();
  const gat2 = lastFlowGat(env);

  assert.equal(env.cycles.length, 2, "200 路径同样在「刷新流程完成」时发一次信号");
  assert.equal(gat1, GENERATED_AT);
  assert.equal(gat2, GENERATED_AT, "缓存命中 → generated_at 两次相同（缺陷场景）");
  const renders = [
    { signal: 0, generatedAt: GENERATED_AT, intervalSec: 15 },
    { signal: env.cycles[0], generatedAt: gat1, intervalSec: 15 },
    { signal: env.cycles[1], generatedAt: gat2, intervalSec: 15 },
  ];
  assert.equal(resetCountFrom(renders, ["generatedAt", "intervalSec"]), 0, "负向前提：仅 generatedAt 判据不重置");
  assert.equal(resetCountFrom(renders, ["signal", "generatedAt", "intervalSec"]), 2, "完成信号判据：200 缓存命中仍重置");

  const h = makeCountdownHarness();
  const props = (signal: number, generatedAt = GENERATED_AT) => ({ generatedAt, refreshSignal: signal, intervalSec: 15, onTriggerRefresh: () => {} });
  h.render(props(0));
  h.tick(14);
  assert.equal(h.remaining(), 1, "刷新前已递减到 1s");
  h.render(props(1));
  assert.equal(h.remaining(), 15, "200 缓存命中刷新完成后立即回到完整周期");
  // 载荷内容真的变化（generated_at 变）时仍然重置——原语义未丢失
  h.render(props(2, LATER_GENERATED_AT));
  assert.equal(h.remaining(), 15, "generated_at 变化同样（继续）重置");
});

// ===== 判据 2：自动刷新归零路径行为不变 =====

test("g-324 判据2：自动刷新归零仍恰好触发一次刷新且只重置一次（无重复请求/双重重置）", async () => {
  let triggerCount = 0;
  const { env, load } = makeKanbanLoad({
    retained: [[DIM, payload()]],
    responses: [{ status: 304 }],
  });
  const h = makeCountdownHarness();
  const props = (signal: number) => ({
    generatedAt: GENERATED_AT,
    refreshSignal: signal,
    intervalSec: 15,
    onTriggerRefresh: () => { triggerCount += 1; load(); },
  });
  h.render(props(0));
  h.tick(15); // 归零 → onTriggerRefresh（真实 load）
  await flush();

  assert.equal(triggerCount, 1, "归零恰好触发一次刷新");
  assert.equal(env.fetchCalls.length, 1, "归零不产生重复请求");
  assert.equal(env.cycles.length, 1, "刷新完成恰好一次重置信号（不双重重置）");
  h.render(props(env.refreshCycle));
  assert.equal(h.remaining(), 15, "归零后读数回到完整周期");
  // 归零后再走一个周期 → 仍是「一次刷新 + 一次重置」，无累积
  h.tick(15);
  await flush();
  assert.equal(triggerCount, 2, "第二个周期归零再触发一次（不重复）");
  assert.equal(env.fetchCalls.length, 2, "每周期恰好一次请求");
  assert.equal(env.cycles.length, 2, "每周期恰好一次重置信号");
  h.render(props(env.refreshCycle));
  assert.equal(h.remaining(), 15, "第三个周期起点同样回到完整周期");
});

// ===== 判据 3/4：forceFresh 兜底与错误路径 =====

test("g-324 判据3：forceFresh 304 兜底重试只在重试那次发一次完成信号（不双重重置）", async () => {
  const { env, load } = makeKanbanLoad({
    forceFresh: true,
    retained: [[DIM, payload()]],
    responses: [{ status: 304 }, { status: 200, body: () => payload(LATER_GENERATED_AT), etag: 'W/"e2"' }],
  });
  load();
  await flush();

  assert.equal(env.fetchCalls.length, 2, "forceFresh 306 兜底：304 后重试一次");
  assert.equal(env.fetchCalls[0].headers["If-None-Match"], undefined, "forceFresh 请求不带 If-None-Match（g-294 对账语义保留）");
  assert.equal(env.cycles.length, 1, "一次刷新流程只重置一次（由重试那次落定）");
  assert.deepEqual(env.cycles, [1]);
});

test("g-324 判据3：错误路径（fetch 失败）不重置——刷新未完成，倒计时继续递减", async () => {
  const { env, load } = makeKanbanLoad({ retained: [[DIM, payload()]], responses: [{ reject: new Error("network down") }] });
  load();
  await flush();
  assert.equal(env.cycles.length, 0, "刷新失败不得重置倒计时");
  assert.ok(env.states.some((s) => s.error), "错误已如实进入 error 状态");
});

// ===== 判据 3：重置事件源与内容变化解耦（源契约，防回退） =====

test("g-324 判据3 源契约：重置由「刷新流程完成」信号驱动，非仅 generatedAt；且无固定时间兜底重置", () => {
  const helpers = helpersSource();
  const kanban = kanbanSource();
  // helpers：重置 effect 依赖含刷新完成信号
  assert.match(helpers, /\}, \[refreshSignal, generatedAt, intervalSec\]\);/,
    "重置 effect 依赖刷新完成信号（不是仅 generatedAt）");
  assert.match(helpers, /const \{ generatedAt, refreshSignal, intervalSec, onTriggerRefresh \} = props;/,
    "RefreshCountdown 接收刷新完成信号");
  assert.doesNotMatch(helpers, /\}, \[generatedAt, intervalSec\]\);/,
    "不得回退为仅依赖 generatedAt（g-324 缺陷根因）");
  // helpers：倒计时只在真实归零 / 切回前台补偿时重新武装终点——不做固定时间兜底重置
  assert.match(helpers, /if \(leftSec <= 0\) \{[\s\S]{0,160}nextTriggerAtRef\.current = Date\.now\(\) \+ intervalSec \* 1000;/,
    "tick 仅真实归零时重置终点（无 N 秒兜底重置）");
  // kanban：挂载点传入完成信号
  assert.match(kanban, /h\(RefreshCountdown, \{[\s\S]{0,300}generatedAt: b\.generated_at,[\s\S]{0,80}refreshSignal: refreshCycle,/,
    "挂载 RefreshCountdown 时传入 refreshCycle 完成信号");
  // kanban：load() 的 200 与 304 两条成功路径都发完成信号，且各自至多一次
  assert.match(kanban, /setState\(\{ loading: false, data \}\); loadOrder\(\); applyUpdateEmphasis\(data\); applyForceReplay\(data\);\s*\n\s*signalRefreshFlowDone\(\);/,
    "200 路径完成时发信号");
  assert.match(kanban, /setState\(\{ loading: false, data: retainedData, error: null \}\);\s*\n\s*signalRefreshFlowDone\(\);/,
    "304 路径完成时发信号");
  assert.match(kanban, /const signalRefreshFlowDone = \(\) => \{\s*\n\s*if \(refreshFlowDone\) return;/,
    "完成信号幂等（一次刷新流程至多一次）");
  assert.match(kanban, /const retryLoad = \(\) => \{ refreshFlowDone = true; load\(\); \};/,
    "forceFresh 重试让位给重试那次流程");
  // 禁止项：手动刷新按钮 / 倒计时触发都直接 load（不得篡改 forceFresh 跳过 If-None-Match 换取重置）
  assert.match(kanban, /onTriggerRefresh: load,/, "倒计时归零触发的是普通 load");
  assert.match(kanban, /h\("button", \{ style: tbBtnStyle, className: "dg-btn", onClick: load \}, dgT\("common\.refresh"\)\)/,
    "手动刷新按钮直接 load（不置 forceFresh）");
  // g-294 的 forceFresh 语义仍在（仅由目标类型变更路径设置）
  assert.match(kanban, /forceFreshRef\.current = true; load\(\)/, "g-294 目标类型变更后的 forceFresh 路径未被削弱");
});
