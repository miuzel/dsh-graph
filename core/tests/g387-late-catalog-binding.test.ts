/**
 * g-387（v0.18.0 审查 H2，P2）：会话绑定在「首次目录没有 child」时永久失效的修复回归。
 *
 * 根因：首次挂载时目录里还没有这个 child，useSessionBinding 先把 entry.started 置上，
 * resolveSessionRetainTarget 解析地址得到 null 后 bound 永久为 null，且那个 effect 不再重试
 * ⇒ 实时输出 / 模型选择 / 反馈会话一直未接入，直到组件卸载或身份切换。
 *
 * 修复：把「等待目录 / 在飞解析 / 已成功 retain」三态显式区分（entry.phase），并用一个**独立**的
 * 唤醒 effect 让 listSnap 成为触发源——已成功或在飞的条目直接跳过，只有等待目录的条目重新解析。
 * 绝不能把 listSnap 塞进生命周期 effect（真实宿主 retainScope 会 publishRetention 更新 list 快照，
 * 那会形成 retain → 通知 → 再 retain 的快照回环）。
 *
 * 断言跑在**真实源模块实现**上（vm 沙箱注入 session-hooks.js 的真实函数），宿主桩忠实复刻
 * 0.1.6-alpha.2 的 snapshot store 语义与 retain 的 publishRetention 联动（见 _g387-harness.ts）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeHookHarness, makeSessionHooksSandbox, makeSessions016, readClient, flushAsync, makeDeferred,
} from "./_g387-harness.ts";

const silentConsole = { warn: () => {}, error: () => {}, log: () => {} };
const ID_CHILD1 = "parent-1\u0000child-1";

/** 只消费 useSessionBinding（不经 useBoundSession 的地址配置/开流旁路），聚焦绑定生命周期。 */
function bind(rt: unknown, box: any, parentId: string, childId: string) {
  return makeHookHarness((R) => {
    box.React = R;
    return box.parts.useSessionBinding(childId, { parentId, childId });
  });
}

// ============================================================================
// 1. 判据 ①：首次目录缺 child / refresh 失败后，目录迟到能恢复 binding 与通路（无需卸载）
// ============================================================================

test("g-387 目录迟到恢复：首次挂载目录里没有 child → 未接入；目录迟到后自动重试接入（无需卸载组件）", async () => {
  const rt = makeSessions016();
  const box = makeSessionHooksSandbox(rt.rt, { console: silentConsole });
  const harness = makeHookHarness((R) => { box.React = R; return box.parts.useBoundSession("parent-1", "child-1"); });
  harness.render();
  await flushAsync();

  // 首次：目录里没有 child-1 → 保留未接入占位，且绝不拿裸 childId 去 retain（会 unknown session）
  assert.equal(harness.value().session, null, "首次目录缺 child 时必须保持未接入占位");
  assert.equal(harness.value().eventSource, null);
  assert.equal(rt.calls.retain.length, 0, "目标不可解析时不得 retain");
  assert.deepEqual(rt.calls.refresh, ["parent-1"], "拿不到地址时必须按能力刷新目录一次");

  // 目录迟到（真实宿主：投影刷新/其它路径把子会话写进目录 → list 快照更新并通知）
  rt.publishCatalog("child-1");
  await flushAsync();

  assert.equal(rt.calls.retain.length, 1, "目录迟到后必须重试，且恰好 retain 一次");
  assert.deepEqual(
    { ...rt.calls.retain[0].target },
    { parentSessionId: "parent-1", childSessionId: "child-1", mode: "continuable" },
    "重试仍须用子代理地址形态（路由 prompt/history 到 subagents.*）",
  );
  assert.equal(harness.value().session, rt.sessionFor("child-1"), "binding 必须恢复——且期间从未卸载组件");
  assert.equal(harness.value().eventSource, rt.eventSourceFor("child-1"), "实时输出通路（eventSource）必须接入");
  assert.equal(typeof harness.value().session.open, "function", "实时窗口通路可用");
  assert.equal(typeof harness.value().session.prompt, "function", "反馈会话通路（session.prompt）可用");
  assert.equal(typeof harness.value().session.projections.faceOf, "function", "模型/投影通路可用");
  assert.equal(harness.value().mode, "continuable", "会话模式必须随目录恢复一并回填");
  assert.deepEqual(rt.calls.opened, ["child-1"], "实时显示开启时恢复后打开输出流窗口");
  assert.equal(rt.calls.released.length, 0, "恢复过程中不得释放代际");
  assert.equal(box.parts.retainedBindings.get(ID_CHILD1).phase, "retained", "条目必须落在已成功态");

  harness.unmount();
  await flushAsync();
  assert.deepEqual(rt.calls.released, ["child-1"], "卸载时恰好 release 一次（配平）");
});

test("g-387 refresh 失败恢复：首次 refresh 抛错 → 未接入不崩；目录迟到后仍能恢复并接入", async () => {
  const logs: unknown[][] = [];
  let failFirst = true;
  const rt = makeSessions016({
    onRefresh: () => {
      if (failFirst) { failFirst = false; return Promise.reject(new Error("network down")); }
    },
  });
  const box = makeSessionHooksSandbox(rt.rt, { console: { ...silentConsole, warn: (...a: unknown[]) => logs.push(a) } });
  const harness = bind(rt.rt, box, "parent-1", "child-1");
  harness.render();
  await flushAsync();

  assert.equal(harness.value().session, null, "refresh 失败 → 保留未接入占位，不崩");
  assert.equal(rt.calls.retain.length, 0);
  assert.deepEqual(logs, [], "目录未收录是预期内状态，不得刷 console");

  rt.publishCatalog("child-1");
  await flushAsync();
  assert.equal(rt.calls.retain.length, 1, "refresh 失败不得让条目永久失效——目录迟到后必须恢复");
  assert.equal(harness.value().session, rt.sessionFor("child-1"), "binding 恢复");
  assert.deepEqual(logs, [], "恢复路径同样不得刷 console");
  harness.unmount();
  await flushAsync();
});

// ============================================================================
// 2. 判据 ②：同身份成功 retain 后目录更新不反复 retain（无快照回环）；在飞解析不重复启动
// ============================================================================

test("g-387 快照回环防护：成功 retain 后目录/快照更新不得再 retain（且回环触发源真实存在）", async () => {
  const rt = makeSessions016();
  const box = makeSessionHooksSandbox(rt.rt, { console: silentConsole });
  rt.publishCatalog("child-1"); // 目录一开始就有 child → 首次即成功
  const harness = bind(rt.rt, box, "parent-1", "child-1");
  harness.render();
  await flushAsync();

  assert.equal(rt.calls.retain.length, 1, "首次即成功接入");
  assert.equal(harness.value().session, rt.sessionFor("child-1"));
  assert.equal(box.parts.retainedBindings.get(ID_CHILD1).phase, "retained");
  const seqAfterRetain = rt.current().seq;
  assert.ok(seqAfterRetain >= 1, "桩必须像真实 retainScope 一样 publishRetention 更新 list 快照（回环触发源存在，否则本用例形同虚设）");

  // 目录/快照抖动 5 次：真实场景里 retain 自身就会引发这类更新
  for (let i = 0; i < 5; i++) rt.jitter();
  await flushAsync();

  assert.equal(rt.calls.retain.length, 1, "已成功 retain 的条目不得因目录/快照更新再次 retain");
  assert.equal(rt.calls.released.length, 0, "也不得抖动释放代际");
  assert.equal(rt.current().seq, seqAfterRetain + 5, "5 次抖动各自只换一次快照（未出现 retain→通知→再 retain 放大）");
  assert.equal(harness.value().session, rt.sessionFor("child-1"), "绑定不受抖动影响");
  harness.unmount();
  await flushAsync();
});

test("g-387 在飞解析不重复启动：解析未落定时目录/快照抖动不得发起第二次解析", async () => {
  const deferred = makeDeferred();
  const rt = makeSessions016({ onRefresh: () => deferred.promise });
  const box = makeSessionHooksSandbox(rt.rt, { console: silentConsole });
  const harness = bind(rt.rt, box, "parent-1", "child-1");
  harness.render();
  await flushAsync();

  assert.deepEqual(rt.calls.refresh, ["parent-1"], "首次解析已发起目录刷新");
  assert.equal(rt.calls.retain.length, 0, "解析在飞时不得 retain");
  for (let i = 0; i < 3; i++) rt.jitter();
  await flushAsync();
  assert.deepEqual(rt.calls.refresh, ["parent-1"], "在飞解析期间抖动不得重复发起解析");

  rt.publishCatalog("child-1");
  deferred.resolve();
  await flushAsync();
  assert.equal(rt.calls.retain.length, 1, "在飞解析落定后命中目录 → 恰好 retain 一次");
  assert.equal(harness.value().session, rt.sessionFor("child-1"));
  harness.unmount();
  await flushAsync();
});

// ============================================================================
// 3. 判据 ③：多消费者 / 卸载 / 身份切换的引用计数与 release 配平；迟到结果不污染新身份
// ============================================================================

test("g-387 多消费者 + 目录迟到：只 retain 一次，计数归零才 release（配平）", async () => {
  const rt = makeSessions016();
  const box = makeSessionHooksSandbox(rt.rt, { console: silentConsole });
  const a = bind(rt.rt, box, "parent-1", "child-1");
  const b = bind(rt.rt, box, "parent-1", "child-1");
  a.render();
  b.render();
  await flushAsync();
  assert.equal(rt.calls.retain.length, 0);
  assert.equal(box.parts.retainedBindings.get(ID_CHILD1).count, 2, "同身份两个消费者共用一个条目（计数 2）");

  rt.publishCatalog("child-1");
  await flushAsync();
  assert.equal(rt.calls.retain.length, 1, "两个消费者只 retain 一次");
  assert.equal(a.value().session, rt.sessionFor("child-1"), "两个消费者都拿到恢复后的会话");
  assert.equal(b.value().session, rt.sessionFor("child-1"));

  a.unmount();
  await flushAsync();
  assert.equal(rt.calls.released.length, 0, "仍有消费者时不得归还代际");
  b.unmount();
  await flushAsync();
  assert.deepEqual(rt.calls.released, ["child-1"], "计数归零才 release，且恰好一次");
  assert.equal(box.parts.retainedBindings.size, 0, "条目必须随计数归零释放");
});

test("g-387 卸载时解析在飞：迟到的解析结果不得建立代际、不漏 release、不复活条目", async () => {
  const deferred = makeDeferred();
  const rt = makeSessions016({ onRefresh: () => deferred.promise });
  const box = makeSessionHooksSandbox(rt.rt, { console: silentConsole });
  const harness = bind(rt.rt, box, "parent-1", "child-1");
  harness.render();
  await flushAsync();
  assert.deepEqual(rt.calls.refresh, ["parent-1"]);

  harness.unmount();
  assert.equal(box.parts.retainedBindings.size, 0, "卸载后条目必须随计数归零释放");

  rt.publishCatalog("child-1"); // 目录此时才到
  deferred.resolve();           // 迟到的解析结果回来了
  await flushAsync();

  assert.equal(rt.calls.retain.length, 0, "已释放条目的迟到结果不得建立代际（否则代际泄漏、无人 release）");
  assert.equal(rt.calls.released.length, 0, "从未建立代际 → 无 release 可还（严格配平）");
  assert.equal(box.parts.retainedBindings.size, 0, "条目不得被迟到结果复活");
});

test("g-387 身份切换：旧身份的迟到结果被丢弃，不建立代际、不污染新身份（release 配平）", async () => {
  const deferred = makeDeferred();
  const rt = makeSessions016({ onRefresh: () => deferred.promise });
  // child-2 的地址可直接取到（模拟新身份不需要等目录）
  rt.addresses.set("child-2", { parentSessionId: "parent-1", childSessionId: "child-2", mode: "continuable" });
  const box = makeSessionHooksSandbox(rt.rt, { console: silentConsole });
  let current = "child-1";
  const harness = makeHookHarness((R) => {
    box.React = R;
    return box.parts.useSessionBinding(current, { parentId: "parent-1", childId: current });
  });
  harness.render();
  await flushAsync();
  assert.deepEqual(rt.calls.refresh, ["parent-1"], "child-1 的解析在飞");

  current = "child-2"; // 身份切换
  harness.render();
  await flushAsync();
  assert.equal(rt.calls.retain.length, 1);
  assert.equal(rt.calls.retain[0].target.childSessionId, "child-2", "新身份照常接入");
  assert.equal(harness.value().session, rt.sessionFor("child-2"));

  rt.publishCatalog("child-1"); // 旧身份的目录此时才到
  deferred.resolve();           // 旧身份的解析结果迟到回来
  await flushAsync();

  assert.equal(rt.calls.retain.length, 1, "旧身份的迟到结果不得建立代际");
  assert.equal(harness.value().session, rt.sessionFor("child-2"), "新身份的绑定不得被污染");
  assert.equal(box.parts.retainedBindings.has(ID_CHILD1), false, "旧身份条目不得被迟到结果复活");
  assert.equal(box.parts.retainedBindings.get("parent-1\u0000child-2").phase, "retained");

  harness.unmount();
  await flushAsync();
  assert.deepEqual(rt.calls.released, ["child-2"], "只归还新身份的代际；旧身份从未建立代际也无需 release");
});

test("g-387 卸载后重挂同一身份：旧条目的迟到结果不得写进新条目（不重复 retain、release 配平）", async () => {
  const deferred = makeDeferred();
  const rt = makeSessions016({ onRefresh: () => deferred.promise });
  const box = makeSessionHooksSandbox(rt.rt, { console: silentConsole });

  const first = bind(rt.rt, box, "parent-1", "child-1");
  first.render();
  await flushAsync();
  assert.equal(box.parts.retainedBindings.size, 1, "首次挂载建立条目（解析在飞）");
  first.unmount();
  assert.equal(box.parts.retainedBindings.size, 0, "卸载后旧条目释放");

  const second = bind(rt.rt, box, "parent-1", "child-1");
  second.render();
  await flushAsync();
  const renewed = box.parts.retainedBindings.get(ID_CHILD1);
  assert.ok(renewed, "重挂后建立**新**条目（同一 identity 的新一代）");
  assert.equal(renewed.phase, "resolving");

  rt.publishCatalog("child-1");
  deferred.resolve(); // 两个条目的解析结果同时回来
  await flushAsync();

  assert.equal(rt.calls.retain.length, 1, "只有新条目建立保留；旧条目的迟到结果必须被丢弃");
  assert.equal(second.value().session, rt.sessionFor("child-1"));
  assert.equal(box.parts.retainedBindings.get(ID_CHILD1), renewed, "新条目不得被旧结果替换/污染");
  assert.equal(renewed.phase, "retained");
  second.unmount();
  await flushAsync();
  assert.deepEqual(rt.calls.released, ["child-1"], "恰好 release 一次（配平）");
});

// ============================================================================
// 4. 源契约：唤醒 effect 与生命周期 effect 分离，listSnap 只在唤醒 effect 的依赖栏里
// ============================================================================

test("g-387 源契约：目录唤醒 effect 独立存在，生命周期 effect 依赖栏不得含 listSnap", () => {
  const hooks = readClient("session-hooks");
  const lifecycleStart = hooks.indexOf("React.useEffect(() => {", hooks.indexOf("// 依赖只取能力与身份"));
  const lifecycle = hooks.slice(lifecycleStart, hooks.indexOf("// g-387：目录迟到唤醒"));
  assert.ok(lifecycle.length > 0, "生命周期 effect 段落存在");
  assert.match(lifecycle, /\}, \[canRetain, enabled, identity, parentId, childId\]\);/);
  assert.doesNotMatch(lifecycle, /listSnap/, "生命周期 effect 依赖栏不得含 listSnap（否则 retain→publishRetention→再 retain 回环）");
  assert.match(
    hooks,
    /\/\/ g-387：目录迟到唤醒[\s\S]*?\}, \[canRetain, enabled, identity, parentId, childId, listSnap\]\);/,
    "独立的唤醒 effect 必须以 listSnap 为触发源",
  );
  // 三态守卫与迟到结果丢弃
  assert.match(hooks, /entry\.phase === "retained" \|\| entry\.promise/, "已成功 / 在飞 → 不重复启动");
  assert.match(hooks, /entry\.phase = "waiting"/, "目录未收录 → 回到等待目录态（可被唤醒重试）");
  assert.match(hooks, /retainedBindings\.get\(entry\.identity\) !== entry/, "迟到结果必须按条目代际丢弃");
});
