/**
 * g-615 C1–C6：实时面板身份切换竞态 + 子代理异常生命周期。
 *
 * 证据分层：**SIMULATED-ONLY（vm + 假宿主）**。逐条标注（权威表见 `docs/g615-evidence-tiers.md`）：
 *   · 渲染对象是**真实生产组件**（dist/lib/client.js 里的 RecentRecords / SessionPanel / LiveStrip），
 *     走真实 useSyncExternalStore / useState / useEffect，不是对源码做正则；
 *   · 但宿主（DSH runtime）是**模拟**：sessions runtime / remote.session 为假实现，且注入延迟与乱序；
 *   · ⇒ 本文件对判据 1 / 2 / 3 / 5 / 6 给出的结论只到「模拟宿主下的真实渲染行为」，
 *     **不等于**真实隔离实例结论。判据 4（绑定失败补偿真实中断）在本文件**无对应用例**，状态为
 *     `UNVERIFIED`（原因与构造方案见 docs/g615-evidence-tiers.md）。
 *   · 唯一例外且有标注：`C1 源码级辅助检查` 与 `C2 源码级辅助检查` 两条是**源码正则级辅助检查**，
 *     不计入判据 1 / 判据 2 的正向证据（用例名与注释均已注明）。
 *   · 【att-003 更正】此处曾引用一条名为「C1 负向对照」的用例，**该用例从不存在**（代码里只有
 *     `C1 源码级辅助检查`）；真正的运行时判别在 g615-live-panel-mutation.test.ts 的 M1/M3。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClientHarness, snapText, snapFind } from "./fixtures/client-render-harness.ts";
import { expectModeSwitchNoStaleNoEmpty } from "./fixtures/g615-live-panel-behaviors.ts";

const flushMicro = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const source = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/live-panel.js"), "utf8");

// ============================================================ 夹具

const recFor = (who: string) => ({
  type: "event",
  event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "MSG_" + who }] } } },
});

type HistCall = { parentId: string; childId: string; mode: any; resolve: (v: any) => void; reject: (e: any) => void; aborted: boolean };

/**
 * 可控的 remote.session：每次 history 读取都挂起，由测试决定谁先回、谁后回（乱序注入），
 * 并记录 abort 信号是否在身份切换时被真正触发。
 */
function makeRemote(opts: { recordsOf?: (childId: string) => any[] } = {}) {
  const calls: HistCall[] = [];
  const remote = {
    events: (req: any, signal: any) => new Promise((resolve, reject) => {
      const call: HistCall = {
        parentId: req.address.parentSessionId,
        childId: req.address.childSessionId,
        mode: req.address.mode,
        resolve,
        reject,
        aborted: false,
      };
      calls.push(call);
      // 【att-003 缺陷 1】abort **只置标记、不 reject**。原来在这里 reject，会让后面的「迟到响应」
      // 成为对已 settled Promise 的 no-op（ES 规范）⇒ 迟到注入从未抵达组件、断言恒绿。
      // 只置标记后，`answer`/迟到 resolve 才能真正驱动组件里 await 之后的代码。
      signal?.addEventListener("abort", () => { call.aborted = true; }, { once: true });
    }),
  };
  const answer = (childId: string, records = (opts.recordsOf ?? ((id: string) => [recFor(id)]))(childId)) => {
    // 同一身份可能因「会话模式从未判定变为具体模式」而发起两次读取：回包所有未取消的请求，
    // 已过期的请求由组件自身丢弃（这正是乱序安全的一部分，不是测试夹具的补偿）。
    const live = calls.filter((c) => c.childId === childId && !c.aborted);
    assert.ok(live.length, `存在尚未取消的 ${childId} 历史请求`);
    for (const call of live) call.resolve({ ok: true, value: { records } });
  };
  /** 无条件回包（含已被 abort 的请求）：用于模拟「宿主忽略 abort 仍回包」的乱序注入。 */
  const answerLate = (childId: string, records = [recFor(childId)]) => {
    const call = [...calls].reverse().find((c) => c.childId === childId);
    assert.ok(call, `存在 ${childId} 的历史请求`);
    call.resolve({ ok: true, value: { records } });
  };
  return { remote, calls, answer, answerLate };
}

/** 假会话：记录订阅数，用于「断开后无残留订阅」。 */
function makeSession(id: string) {
  const subs = new Set<any>();
  return {
    id, subs,
    open: async () => {},
    subscribe: (cb: any) => { subs.add(cb); return () => { subs.delete(cb); }; },
    getSnapshot: () => ({ running: false, chat: null }),
    projections: { faceOf: () => ({ subscribe: () => () => {}, getSnapshot: () => undefined }) },
  };
}

/**
 * 假 sessions runtime：实现 retain（按身份计数、release 配平）、list 快照与目录。
 * `stats` 用于断言「身份切换/卸载后 retain 引用归零、无堆积」。
 */
function makeSessionsRuntime(opts: { children: { parentId: string; ids: string[] }; sessions?: Record<string, any> } = { children: { parentId: "p", ids: ["A", "B"] } }) {
  const stats = { retains: 0, releases: 0, live: 0, maxLive: 0, listSubs: 0, byId: new Map<string, any>() };
  const sessions: Record<string, any> = opts.sessions ?? {};
  const listSubs = new Set<any>();
  const snapshot = () => ({
    byId: {},
    items: [],
    subagentsByParent: {
      [opts.children.parentId]: { entries: opts.children.ids.map((id) => ({ id, mode: "continuable" })) },
    },
  });
  const rt: any = {
    list: {
      getSnapshot: snapshot,
      subscribe: (cb: any) => { stats.listSubs++; listSubs.add(cb); return () => { stats.listSubs--; listSubs.delete(cb); }; },
    },
    binding: (id: string) => ({ session: sessions[id] ?? null, eventSource: null }),
    // 0.1.7+ 能力：一次性投影刷新（无观察者）。若无此能力，目录仍从 list 快照读取。
    refreshProjections: async () => {},
    retain: (target: any) => {
      const id = typeof target === "string" ? target : target.childSessionId;
      const session = sessions[id] ?? makeSession(id);
      sessions[id] = session;
      stats.retains++; stats.live++; stats.maxLive = Math.max(stats.maxLive, stats.live); stats.byId.set(id, (stats.byId.get(id) ?? 0) + 1);
      let released = false;
      return {
        sessionId: id,
        ready: Promise.resolve(),
        get binding() { return { session, eventSource: null }; },
        release: () => { if (released) return; released = true; stats.releases++; stats.live--; },
      };
    },
  };
  return { rt, stats, sessions };
}

// ============================================================ 判据 1：同一组件持续挂载时切换身份，首帧无旧数据

test("g-615 C1：同一 RecentRecords 实例切换身份，首帧不显示上一身份的记录（真实渲染）", async () => {
  const { remote, calls, answer } = makeRemote();
  const h = createClientHarness({ services: { "remote.session": remote } });
  const RecentRecords = (h.mod as any).__test?.RecentRecords;
  assert.equal(typeof RecentRecords, "function", "RecentRecords 必须经 __test 暴露（真实组件）");
  const view = h.mount(RecentRecords, { parentId: "p", childId: "A", mode: "continuable" });

  view.flush();
  assert.match(snapText(view.frames.at(-1)), /读取中…/, "首次挂载为读取中占位");
  answer("A");
  await flushMicro();
  assert.match(snapText(view.flush()), /MSG_A/, "A 的记录已渲染");

  // —— 关键断言：同一实例（未卸载）切换身份后，**第一帧**不得显示 A 的旧记录
  const first = view.flush({ parentId: "p", childId: "B", mode: "continuable" });
  const firstText = snapText(first);
  assert.doesNotMatch(firstText, /MSG_A/, `切换后首帧不得残留上一身份数据（实得 ${firstText}）`);
  assert.match(firstText, /读取中…/, "切换后首帧显示新身份的读取中占位（不是空帧、不是旧数据）");
  assert.ok(view.frames.length >= 3, "确实发生了多帧提交");
  assert.equal(calls.filter((c) => c.childId === "B").length, 1, "新身份发起且仅发起一次读取");
  assert.equal(calls.filter((c) => c.childId === "A").length, 1, "旧身份的读取没有被重复发起");
});

test("g-615 C1 源码级辅助检查：token 不匹配时必须回退为 loading（不计入判据 1 的渲染证据）", () => {
  // 本用例是**源码正则级辅助检查**，只说明守卫写在源码里，**不能**证明运行时首帧行为。
  // 运行时的真判别在 core/tests/g615-live-panel-mutation.test.ts 的 M1/M3：它们在**内存里**定点
  // 删掉这行守卫后跑真实渲染，断言首帧泄漏必红（不写盘、不重建 dist）。
  assert.match(source, /const state = storedState\.token === token \? storedState : \{ loading: true \}/,
    "token 不匹配时必须丢弃上一身份的状态（回退为 loading）");
});

// ============================================================ 判据 2：不同 mode 下切换身份渲染与数据源一致

test("g-615 C2：标准/极简 mode 下切换身份的渲染与数据源一致（不错帧、不空帧）", async () => {
  // 【att-003 缺陷 2 的修复】判据 2 里「不同 mode」的维度必须挂在**真实消费 `subagentMode` 的组件**
  // 上：该 prop 只被 `SessionPanel` 读取（执行模式标签行），`RecentRecords` 根本不读它 —— 旧写法挂
  // `RecentRecords` 时 standard ≡ minimal 是同义反复、恒绿。现在挂 `SessionPanel`，并额外要求
  // 两模式的渲染文本**分别带上自己的模式值**（M12 证明抹掉它就会变红）。
  const seen = await expectModeSwitchNoStaleNoEmpty();
  const pick = (r: any) => ({ old: r.old, empty: r.empty, target: r.target });
  assert.deepEqual(pick(seen.standard), pick(seen.minimal), "standard 与 minimal 在身份切换上的渲染与数据源必须一致");
  assert.deepEqual({ standard: seen.standard.label, minimal: seen.minimal.label }, { standard: "standard", minimal: "minimal" },
    "两模式必须各自渲染出自己的执行模式值（否则「一致」没有判别力）");
});

test("g-615 C2 空帧负向对照（真实渲染）：抹掉「读取中」占位后临近的 RecentRecords 正文变空白 ⇒ 断言必红", async () => {
  // 判据 2 的「不空帧」此前只有正向一侧。本用例把生产 bundle 在**内存里**改坏（占位抹成空串），
  // 交给与 C2 同源的 expectModeSwitchNoStaleNoEmpty ⇒ 必须变红；随后再用生产 bundle 跑同一套断言
  // 必须为绿。若两侧都绿，说明「不空帧」这条断言没有判别力。
  const bundlePath = join(import.meta.dirname, "../../dist/lib/client.js");
  const production = readFileSync(bundlePath, "utf8");
  const from = 'if (state.loading) body = dgT("live.reading");';
  const mutant = production.replace(from, 'if (state.loading) body = "";');
  assert.notEqual(mutant, production, "空帧变异必须真的命中生产 bundle");
  await assert.rejects(
    () => expectModeSwitchNoStaleNoEmpty({ bundle: mutant }),
    (err: any) => /空帧/.test(String(err?.message ?? err)),
    "占位被抹空后首帧成为空帧，断言必须变红",
  );
  await expectModeSwitchNoStaleNoEmpty();
});

test("g-615 C2 源码级辅助检查（不计入判据 2 的渲染证据）：mode 只影响展示标签，不改变数据源", () => {
  // ⚠️ 本用例是**源码正则级辅助检查**，与上面的真实渲染用例 C2 不是同一层证据：
  //    它只能说明「代码结构上 mode 标签与历史地址参数正交」，**不能**证明任何一帧的渲染结果。
  //    判据 2 的成立依据是 C2（真实渲染）+ M8（空帧负向对照），不是本用例。
  // 源码级：SessionPanel 的 mode 展示取自 props.subagentMode，与历史读取使用的 props.mode 正交。
  assert.match(source, /props\.subagentMode \? ` ｜ \$\{dgT\("live\.executionMode"\)\} \$\{props\.subagentMode\}`/,
    "执行模式（standard/minimal）只作为标签展示");
  assert.match(source, /h\(RecentRecords, \{ key: "rr", parentId: props\.parentId, childId: props\.childId, mode \}\)/,
    "历史读取的参数是会话模式（continuable/one-shot），与执行模式标签无关");
});

// ============================================================ 判据 3：延迟与乱序（旧请求后到）

test("g-615 C3：旧身份响应后到不得覆盖新身份（真延迟注入 + 乱序），最终态属新身份", async () => {
  const { remote, calls, answer } = makeRemote();
  const h = createClientHarness({ services: { "remote.session": remote } });
  const RecentRecords = (h.mod as any).__test?.RecentRecords;
  const view = h.mount(RecentRecords, { parentId: "p", childId: "A", mode: "continuable" });
  view.flush();
  await flushMicro();
  view.flush();
  assert.equal(calls.filter((c) => c.childId === "A").length, 1, "A 的请求在飞");

  // 在 A 未回包时切换身份 → 旧请求应被 abort
  view.flush({ parentId: "p", childId: "B", mode: "continuable" });
  const aCall = calls.find((c) => c.childId === "A")!;
  assert.equal(aCall.aborted, true, "身份切换必须 abort 旧身份的在飞请求（不是只靠渲染期过滤）");

  await flushMicro();
  view.flush();
  // 乱序：即使旧 A 的响应迟到（宿主忽略 abort 仍回包），也不得写入看板。
  // （abort 只置标记不 reject ⇒ 这次 resolve **真的**驱动了组件里 await 之后的代码；
  //   无守卫时它会写进看板 —— 反向证据见 mutation.test.ts **M2**（双删 alive+token 必泄漏 MSG_A）。
  //   注意 M9 只删 alive 时**不**泄漏（写入被渲染期 token 守卫否掉），故 M9 是说明性用例，不是本判据的反向证据。）
  aCall.resolve({ ok: true, value: { records: [recFor("A")] } });
  await flushMicro();
  const mid = view.flush();
  assert.doesNotMatch(snapText(mid), /MSG_A/, "迟到的旧响应不得覆盖新身份数据");
  await flushMicro();
  assert.match(snapText(view.flush()), /读取中…/, "迟到响应之后仍停在 B 的「读取中」占位（未被旧数据或错误改写）");

  answer("B");
  await flushMicro();
  const final = view.flush();
  assert.match(snapText(final), /MSG_B/, "最终态属于新身份 B");
  assert.doesNotMatch(snapText(final), /MSG_A/, "最终态不含旧身份数据");
});

test("g-615 C3：A→B→A 快速回切，任何一帧都不得显示与当前身份不符的数据", async () => {
  const { remote, answer } = makeRemote();
  const h = createClientHarness({ services: { "remote.session": remote } });
  const RecentRecords = (h.mod as any).__test?.RecentRecords;
  const view = h.mount(RecentRecords, { parentId: "p", childId: "A", mode: "continuable" });
  view.flush(); await flushMicro(); view.flush();
  // 首次 A 回包并渲染
  answer("A"); await flushMicro();
  assert.match(snapText(view.flush()), /MSG_A/);
  // A → B → A（B 尚未回包就切回）
  view.flush({ parentId: "p", childId: "B", mode: "continuable" });
  const back = view.flush({ parentId: "p", childId: "A", mode: "continuable" });
  assert.doesNotMatch(snapText(back), /MSG_A/, "回切后首帧不得复用上一次 A 的缓存（否则会显示过期数据）");
  assert.match(snapText(back), /读取中…/, "回切后首帧重新进入读取中");
  await flushMicro();
  view.flush();
  answer("A");
  await flushMicro();
  assert.match(snapText(view.flush()), /MSG_A/, "回切后新请求的 A 数据最终渲染");
});

// ============================================================ 判据 5：旧宿主 follow 资源清理

test("g-615 C5：RecentRecords 卸载/身份切换后无残留订阅、定时器与在飞请求", async () => {
  const { remote, calls } = makeRemote();
  const h = createClientHarness({ services: { "remote.session": remote } });
  const RecentRecords = (h.mod as any).__test?.RecentRecords;
  const base = h.resources();
  const view = h.mount(RecentRecords, { parentId: "p", childId: "A", mode: "continuable" });
  view.flush(); await flushMicro(); view.flush();
  // 连续切换 5 次身份：每次都应在切换时 abort 上一身份的请求，不得累积
  for (const id of ["B", "C", "D", "E", "F"]) {
    view.flush({ parentId: "p", childId: id, mode: "continuable" });
    await flushMicro();
  }
  const abortedCount = calls.filter((c) => c.aborted).length;
  assert.equal(abortedCount, calls.length - 1, `只有当前身份的最后一次请求保持存活（在飞 ${calls.length}，已 abort ${abortedCount}）`);
  view.unmount();
  const after = h.resources();
  assert.equal(after.intervals, base.intervals, "卸载后无遗留 interval");
  assert.equal(after.timeouts, base.timeouts, "卸载后无遗留 timeout");
  assert.equal(after.listeners, base.listeners, "卸载后无遗留 window 监听");
});

test("g-615 C5：LiveStrip 断开（卸载）后订阅与定时器归零，不随身份切换堆积", async () => {
  const h = createClientHarness();
  assert.equal(typeof (h.mod as any).__test?.LiveStrip, "function", "LiveStrip 必须经 __test 暴露");
  const session = makeSession("A");
  const { rt, stats, sessions } = makeSessionsRuntime({ children: { parentId: "p", ids: ["A", "B"] }, sessions: { A: session } });
  const h2 = createClientHarness({ sessions: rt });
  const Strip = (h2.mod as any).__test?.LiveStrip;
  const base = h2.resources();
  const view = h2.mount(Strip, { parentId: "p", childId: "A" });
  view.flush();
  await flushMicro();
  view.flush();
  // 切换身份（同组件持续挂载）
  view.flush({ parentId: "p", childId: "B" });
  await flushMicro();
  view.flush();
  assert.ok(stats.maxLive <= 2, `retain 引用不得随切换累积（峰值 ${stats.maxLive}）`);
  view.unmount();
  assert.equal(stats.live, 0, "卸载后 retain 引用全部归还（无泄漏代际）");
  const after = h2.resources();
  assert.equal(after.listeners, base.listeners, "卸载后无遗留 window 监听");
  assert.equal(after.intervals, base.intervals, "卸载后无遗留 interval");
  assert.equal(after.timeouts, base.timeouts, "卸载后无遗留 timeout（含节流 trailing flush）");
  // 会话级订阅（session.subscribe）：旧身份断开后也不得残留
  for (const sess of Object.values(sessions) as any[]) {
    assert.equal(sess.subs.size, 0, `会话 ${sess.id} 上不得残留订阅（实得 ${sess.subs.size}）`);
  }
});

test("g-615 C5：旧宿主 follow 流在身份切换时被真正取消（signal 透传到宿主）", async () => {
  // 0.2.1 旧宿主路径：readRecentRecords 走 follow；abort 后宿主侧生成器必须被关闭。
  const events: string[] = [];
  const remote = {
    async *follow(req: any, signal: any) {
      const id = req.address.childSessionId;
      events.push("open:" + id);
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 10_000);
          signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
        });
        yield { type: "snapshot", records: [recFor(id)] };
      } finally {
        events.push("close:" + id);
      }
    },
  };
  const h = createClientHarness({ services: { "remote.session": remote } });
  const RecentRecords = (h.mod as any).__test?.RecentRecords;
  const view = h.mount(RecentRecords, { parentId: "p", childId: "A", mode: "continuable" });
  view.flush(); await flushMicro(); view.flush();
  assert.deepEqual(events, ["open:A"], "A 的 follow 流已打开");
  view.flush({ parentId: "p", childId: "B", mode: "continuable" });
  await flushMicro(); await flushMicro();
  assert.ok(events.includes("close:A"), `切换身份后旧 follow 流必须关闭（实得 ${JSON.stringify(events)}）`);
  view.unmount();
});

// ============================================================ 判据 6：真实空历史 vs 错误提示

test("g-615 C6：真实空历史显示「无记录」，读取失败显示「读取失败」，能力缺失显示「不可用」——三者互不伪装", async () => {
  const cases = [
    { name: "empty", remote: { events: async () => ({ ok: true, value: { records: [] } }) }, expect: /（无记录）/, forbid: [/读取失败/, /不可用/] },
    { name: "rejected", remote: { events: async () => ({ ok: false, error: { message: "denied" } }) }, expect: /读取失败：denied/, forbid: [/（无记录）/, /不可用/] },
    { name: "malformed", remote: { events: async () => ({ ok: true, value: {} }) }, expect: /读取失败：invalid history response/, forbid: [/（无记录）/] },
    { name: "thrown", remote: { events: async () => { throw new Error("offline"); } }, expect: /读取失败：offline/, forbid: [/（无记录）/, /不可用/] },
    { name: "no-capability", remote: {}, expect: /历史记录不可用：宿主未提供读取能力/, forbid: [/（无记录）/, /读取失败/] },
  ] as const;
  for (const c of cases) {
    const h = createClientHarness({ services: { "remote.session": c.remote } });
    const RecentRecords = (h.mod as any).__test?.RecentRecords;
    const view = h.mount(RecentRecords, { parentId: "p", childId: "A", mode: "continuable" });
    view.flush();
    await flushMicro();
    const text = snapText(view.flush());
    assert.match(text, c.expect, `${c.name}：必须显示准确提示（实得 ${text}）`);
    for (const f of c.forbid) assert.doesNotMatch(text, f, `${c.name}：不得伪装成其它状态（实得 ${text}）`);
  }
});

test("g-615 C6：缺少父子身份显示「不可用：缺少父子会话身份」，绝不显示为「无记录」", async () => {
  for (const props of [
    { parentId: null, childId: "A", mode: "continuable" },
    { parentId: "p", childId: null, mode: "continuable" },
  ]) {
    const h = createClientHarness({ services: { "remote.session": { events: async () => ({ ok: true, value: { records: [] } }) } } });
    const RecentRecords = (h.mod as any).__test?.RecentRecords;
    const view = h.mount(RecentRecords, props);
    view.flush();
    await flushMicro();
    const text = snapText(view.flush());
    assert.match(text, /历史记录不可用：缺少父子会话身份/, `身份缺失必须如实提示（实得 ${text}）`);
    assert.doesNotMatch(text, /（无记录）/, "身份缺失不得伪装成空历史");
  }
});

test("g-615 C6：读取期间显示「读取中」，不提前断言为空或成功", async () => {
  let release: any;
  const h = createClientHarness({ services: { "remote.session": { events: () => new Promise((r) => { release = r; }) } } });
  const RecentRecords = (h.mod as any).__test?.RecentRecords;
  const view = h.mount(RecentRecords, { parentId: "p", childId: "A", mode: "continuable" });
  const t1 = snapText(view.flush());
  assert.match(t1, /读取中…/, "在飞期间显示读取中");
  assert.doesNotMatch(t1, /（无记录）|读取失败/, "在飞期间不得提前断言为空或失败");
  await flushMicro();
  const t2 = snapText(view.flush());
  assert.match(t2, /读取中…/, "宿主未回包前不得凭空出结果");
  release({ ok: true, value: { records: [] } });
  await flushMicro();
  const t3 = snapText(view.flush());
  assert.match(t3, /（无记录）/, "真实空结果才显示无记录");
});

// ============================================================ harness 自身正确性（防夹具误判）

test("g-615 H1：useSyncExternalStore 的订阅回调唤醒建立订阅的那个实例（捕获节点，不读渲染期游标）", async () => {
  // harness 的 useSyncExternalStore 曾在 subscribe 闭包里读 `current`（渲染期游标）—— 订阅触发时
  // `current` 早已是别的实例或 null，会唤醒错节点或丢掉更新，导致「无更新也算干净」的假绿。
  // 本用例把一个真实订阅放进组件里，在渲染之外触发它两次，断言组件**确实**重渲染。
  const h = createClientHarness();
  const ReactStub = h.ReactStub;
  const listeners = new Set<any>();
  let value = 1;
  const store = { subscribe: (cb: any) => { listeners.add(cb); return () => listeners.delete(cb); }, getSnapshot: () => value };
  const renders: number[] = [];
  function Probe() {
    const snap = ReactStub.useSyncExternalStore(store.subscribe, store.getSnapshot);
    renders.push(snap);
    return { type: "div", props: {}, children: [String(snap)] };
  }
  const view = h.mount(Probe as any, {});
  view.flush();
  assert.deepEqual(renders, [1], "首次渲染读到初始快照");
  assert.equal(listeners.size, 1, "effect 建立了一个订阅");
  // ⚠️ 必须先把上一帧遗留的 dirty 清零：挂载本身会把新实例标记为 dirty，不清零则下面的断言
  //    恒真（无判别力）。清零后，只有「订阅回调真的唤醒了 Probe」才会重新变 dirty。
  h.clearDirty();
  assert.equal(h.dirtyCount(), 0, "前置：dirty 已清零");
  // 渲染之外（此时没有组件在渲染，渲染期游标为 null）触发订阅
  value = 2;
  for (const cb of [...listeners]) cb();
  assert.equal(h.dirtyCount(), 1, "订阅变化必须把建立订阅的实例标记为 dirty（读渲染期游标则会丢更新）");
  view.flush();
  assert.deepEqual(renders, [1, 2], "订阅触发后组件重渲染为新快照");
  view.unmount();
  assert.equal(listeners.size, 0, "卸载后订阅被撤销");
});
