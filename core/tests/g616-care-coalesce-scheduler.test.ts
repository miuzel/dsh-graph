/**
 * g-616 真实调度器回归：**单条定时唤醒**（方案 A）——短窗口内相邻到期**一次**投递。
 *
 * 现场（`docs/evidence/g616-care-wake-timeline.md`）：
 * | 投递 (UTC) | goal / attempt    | child     | 间隔   |
 * | 01:21:38   | g-028 / att-001   | 11882505… | —      |
 * | 01:22:33   | g-029 / att-001   | 69061b2c… | 55 秒  |
 *
 * 两次投递属于**不同目标** ⇒ 成因是「相邻到期未合并」，不是同一任务重复唤醒、
 * 也不是逐子代理计时器。
 *
 * 本文件驱动**真实的 `createCareRuntime`**（真实 `scheduleEntry`/`decisionOf`/`dueTargetsOf`/
 * `deliverNow` 全链路），只把三样东西换成可控替身：
 *  - 时钟与定时器（假时钟推进，绝不真睡）；
 *  - `agents` 服务（最小 stub：一个空闲主管 + 两个 running child）；
 *  - board payload（两个 in_progress 目标）。
 *
 * 因此断言的是**产品代码本身**的排程与投递批次，而不是测试自建的模型。
 * 零网络、零真实 provider、零费用。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { init } from "../ops.ts";

const WS = "/ws-g616";
const ROOT = join(WS, ".dsh-graph");
const T0 = Date.parse("2026-11-06T09:16:38.000Z");

/** 假时钟 + 单序列假定时器（可推进、可检视，绝不真睡）。 */
function fakeClock(startIso: number) {
  let t = startIso;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    setTimeoutFn: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, ms), fn });
      return id;
    },
    clearTimeoutFn: (id) => { timers.delete(id); },
    get pending() { return [...timers.values()]; },
    /** 推进到目标时刻，按到期先后执行定时器回调（异步串行）。 */
    async advanceTo(target) {
      for (let guard = 0; guard < 200; guard += 1) {
        const due = [...timers.entries()]
          .filter(([, v]) => v.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (!due.length) break;
        const [id, v] = due[0];
        timers.delete(id);
        t = Math.max(t, v.at);
        await v.fn();
      }
      t = Math.max(t, target);
      await new Promise((r) => setImmediate(r));
    },
  };
}

/** 最小 supervisor 替身：care 只看 status/session/send/runMaintenance。 */
function makeSupervisor(id, cwd) {
  const sent = [];
  return {
    id,
    status: "idle",
    session: { id, header: { cwd } },
    sent,
    send(message) { sent.push(message); return undefined; },
    async runMaintenance(fn) { return fn(); },
  };
}

/** 最小 child 替身：只为采样出 running + attempt 绑定。 */
function makeChild(id, cwd, parentId) {
  return { id, status: "running", session: { id, header: { cwd } }, meta: { parentSessionId: parentId } };
}

function boardPayload(goals) {
  return { versions: [{ slug: "v1", status: "active", goals }], standalone: [], backlog: [] };
}

function goalEntry(id, childId, parentId, startedAt) {
  return {
    id,
    title: `goal ${id}`,
    status: "in_progress",
    version: "v1",
    created_at: startedAt,
    attempt_started_at: startedAt,
    attempt_binding: { attempt: "att-001", child_id: childId, binding_version: 1, parent_session_id: parentId },
  };
}

async function main() {
  const base = join(process.cwd(), "tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "g616-sched-"));
}

test("g-616 真实调度器：55 秒相邻到期被合并为**一次**巡检（两个目标同批）", async () => {
  const dir = await main();
  try {
    const clock = fakeClock(T0);
    const sup = makeSupervisor("sup-g616", dir);
    const childA = makeChild("child-028", dir, sup.id);
    const childB = makeChild("child-029", dir, sup.id);
    const agents = {
      get: (id) => (id === sup.id ? sup : id === childA.id ? childA : id === childB.id ? childB : null),
      list: () => [sup, childA, childB],
      isOwnedBy: (id) => id === childA.id || id === childB.id,
    };
    // 现场：g-028 先开始，g-029 晚 55 秒（两任务首次到期相差 55 秒）
    const startA = new Date(T0).toISOString();
    const startB = new Date(T0 + 55_000).toISOString();
    const payload = boardPayload([
      goalEntry("g-028", childA.id, sup.id, startA),
      goalEntry("g-029", childB.id, sup.id, startB),
    ]);

    const mod = await import("../../dist/index.js");
    const events = [];
    const runtime = mod.createCareRuntime({
      ctx: { on: () => () => {}, get: (n) => (n === "agents" ? agents : undefined) },
      readGlobal: () => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false, available: true, raw: "on" }),
      resolveRoot: (ws) => ws,
      defaultWorkspace: () => dir,
      readProjectConfigFn: () => ({ supervisor: { care: true, care_threshold_seconds: 300, care_recheck_seconds: 300 } }),
      readSupervisorSessionFn: () => sup.id,
      readBoardPayload: () => payload,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      appendEventFn: (_root, ev) => { events.push(ev); },
      makeInspectionId: (() => { let i = 0; return () => `g616-insp-${++i}`; })(),
      log: () => {},
    });
    clock.advance(60_000); // 两个任务均已开始后再采样（未来起点会被夹成 now）
    runtime.start();
    try {
      runtime.armForRoot(dir);
      const entry = runtime.entryOfRoot(dir);
      assert.ok(entry, "真实 runtime 必须为 root 建 entry");
      // 单条定时器：任何时刻一个 board 只挂**一条** timer（方案 A 的「单条定时唤醒」）。
      // 注意其到期时刻被 `configRecheckMs`(30s) 封顶——那是**配置重读上界**，重扫不会投递；
      // 真正的合并行为由下面的投递批次断言证明（判据 2）。
      assert.equal(clock.pending.length, 1, "一个 board 只允许一条定时器");
      assert.ok(entry.timerDueAt > clock.now(), "定时器必须在未来");
      assert.ok(entry.timerDueAt - clock.now() <= 30_000, "到期时刻封顶到配置重读周期（既有语义不变）");

      // 推进到第一个到期（09:21:38）——这一次唤醒必须**同时**关照 g-028 与 g-029
      await clock.advanceTo(T0 + 300_000);
      const insp = events.filter((e) => e.event === "care.inspection");
      assert.equal(insp.length, 1, "宽限内（55 秒邻居）只允许一次巡检投递");
      const batch = insp[0].details.targets.map((t) => t.goal).sort();
      assert.deepEqual(batch, ["g-028", "g-029"], "55 秒邻居必须被并入同一批（判据 2 + 判据 3）");
      // 判据 6：合并必须留下可核验记录——本批几个目标、哪几个是宽限内提前并入、窗口长度
      const co = insp[0].details.coalesce;
      assert.ok(co, "care.inspection 事件必须记录 coalesce 明细");
      assert.equal(co.batch_size, 2);
      assert.equal(co.window_ms, 60_000);
      assert.deepEqual(co.merged_ahead.map((t) => t.goal), ["g-029"], "只有尚未到期的邻居记为 merged_ahead");
      assert.equal(sup.sent.length, 1, "主管只被唤醒一次（不再 55 秒后二次打断）");

      // 负向对照：此后到宽限结束（+59.9 秒）不得再出现第二次投递
      await clock.advanceTo(T0 + 360_000 - 100);
      assert.equal(events.filter((e) => e.event === "care.inspection").length, 1, "宽限内不得二次投递");
    } finally {
      runtime.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-616 真实调度器：宽限之外不凑合——超窗任务留给下一轮（先到期者不被饿死）", async () => {
  const dir = await main();
  try {
    const clock = fakeClock(T0);
    const sup = makeSupervisor("sup-g616b", dir);
    const childA = makeChild("child-a", dir, sup.id);
    const childB = makeChild("child-b", dir, sup.id);
    const agents = {
      get: (id) => (id === sup.id ? sup : id === childA.id ? childA : id === childB.id ? childB : null),
      list: () => [sup, childA, childB],
      isOwnedBy: () => true,
    };
    // 两任务相差 200 秒（远超 60 秒宽限）⇒ 不得被合并，先到期者必须按自己的到期被关照
    const payload = boardPayload([
      goalEntry("g-a", childA.id, sup.id, new Date(T0).toISOString()),
      goalEntry("g-b", childB.id, sup.id, new Date(T0 + 200_000).toISOString()),
    ]);
    const mod = await import("../../dist/index.js");
    const events = [];
    const runtime = mod.createCareRuntime({
      ctx: { on: () => () => {}, get: (n) => (n === "agents" ? agents : undefined) },
      readGlobal: () => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false, available: true, raw: "on" }),
      resolveRoot: (ws) => ws,
      defaultWorkspace: () => dir,
      readProjectConfigFn: () => ({ supervisor: { care: true, care_threshold_seconds: 300, care_recheck_seconds: 300 } }),
      readSupervisorSessionFn: () => sup.id,
      readBoardPayload: () => payload,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      appendEventFn: (_root, ev) => { events.push(ev); },
      makeInspectionId: (() => { let i = 0; return () => `g616b-insp-${++i}`; })(),
      log: () => {},
    });
    clock.advance(210_000); // g-b 起点 T0+200s 已过，再采样
    runtime.start();
    try {
      runtime.armForRoot(dir);
      await clock.advanceTo(T0 + 300_000);
      const first = events.filter((e) => e.event === "care.inspection");
      assert.equal(first.length, 1, "先到期者必须被关照（不得为等下一个人而饿死）");
      assert.deepEqual(first[0].details.targets.map((t) => t.goal), ["g-a"], "超窗邻居不并入本批");
    } finally {
      runtime.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
