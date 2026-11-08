import { test } from "node:test";
import assert from "node:assert/strict";
import { flushAsync, makeDeferred, makeHookHarness, makeSessionHooksSandbox } from "./_g387-harness.ts";

// Exercise actual useSessionBinding → resolveSessionRetainTarget → host lookup,
// including the second lookup after refresh, not a reimplementation of the resolver.
test("direct address 必须匹配 parent 和 child 才能 retain", async () => {
  for (const address of [
    { parentSessionId: "foreign", childSessionId: "a", mode: "continuable" },
    { parentSessionId: "parent", childSessionId: "foreign", mode: "continuable" },
    { parentSessionId: "parent", childSessionId: "a", mode: "continuable" },
  ]) {
    const retains: any[] = []; let refreshes = 0;
    const snapshot = { projectionsBySession: { parent: { values: { subagentCatalog: [{ id: "a", mode: "continuable" }] } } } };
    const rt = {
      list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      subagentAddress: () => address,
      refreshProjections: async () => { refreshes++; },
      retain(target: any) { retains.push(target); return { ready: Promise.resolve(), binding: { session: {} }, release() {} }; },
    };
    const box: any = makeSessionHooksSandbox(rt);
    const h = makeHookHarness(R => { box.React = R; return box.parts.useSessionBinding("a", { parentId: "parent", childId: "a" }); });
    h.render(); await flushAsync();
    const valid = address.parentSessionId === "parent" && address.childSessionId === "a";
    assert.equal(retains.length, valid ? 1 : 0, `direct ${JSON.stringify(address)}`);
    if (!valid) assert.ok(refreshes >= 1, "刷新后的 direct 地址仍须校验");
    else assert.equal(retains[0], address);
    h.unmount();
  }
});

function leaseFixture() {
  const requests: any[] = [], configured: any[] = [];
  const snapshot = { projectionsBySession: { parent: { values: { subagentCatalog: [
    { id: "a", mode: "continuable" }, { id: "b", mode: "one-shot" },
  ] } } } };
  const sessions = new Map<string, any>();
  const rt = {
    list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    binding(id: string) {
      if (!sessions.has(id)) sessions.set(id, { session: {
        configureSubagent(address: any) { configured.push({ id, address }); }, open: async () => {},
      }, eventSource: null });
      return sessions.get(id);
    },
    refreshProjections(parent: string) { const d = makeDeferred<void>(); requests.push({ ...d, parent }); return d.promise; },
  };
  const box: any = makeSessionHooksSandbox(rt, { console: { warn() {}, error() {}, log() {} } });
  function consumer(initial = "a") {
    let child = initial; const frames: any[] = [];
    const h = makeHookHarness(R => { box.React = R; const value = box.parts.useBoundSession("parent", child); frames.push(value); return value; });
    return { h, frames, switchTo(id: string) { child = id; h.render(); } };
  }
  return { requests, configured, consumer };
}

test("setup 切换及 ABA 后旧刷新不得配置路由", async () => {
  const f = leaseFixture(); const c = f.consumer(); c.h.render();
  assert.equal(f.requests.length, 1); const oldA = f.requests[0];
  c.switchTo("b"); assert.equal(f.requests.length, 2); const oldB = f.requests[1];
  c.switchTo("a"); assert.equal(f.requests.length, 3); const newA = f.requests[2];
  oldA.resolve(); oldB.resolve(); await flushAsync();
  assert.equal(f.configured.length, 0, "旧代即使同 identity 回归也不能配置");
  newA.resolve(); await flushAsync();
  assert.equal(f.configured.length, 1);
  assert.equal(f.configured[0].address.childSessionId, "a");
  c.h.unmount();
});

test("setup 卸载后迟到不得 configureSubagent", async () => {
  const f = leaseFixture(); const c = f.consumer(); c.h.render();
  assert.equal(f.requests.length, 1); c.h.unmount(); f.requests[0].resolve(); await flushAsync();
  assert.equal(f.configured.length, 0);
});

test("同一 identity 多消费者共用 setup lease，最后一个卸载才使其失效", async () => {
  const f = leaseFixture(); const a = f.consumer(), b = f.consumer();
  a.h.render(); b.h.render();
  assert.equal(f.requests.length, 1, "相同 session 应共用一个 setup");
  a.h.unmount(); f.requests[0].resolve(); await flushAsync();
  assert.equal(f.configured.length, 1, "尚有消费者时应正常配置");
  assert.equal(b.h.value().mode, "continuable");
  b.h.unmount();
  const c = f.consumer(), d = f.consumer(); c.h.render(); d.h.render();
  assert.equal(f.requests.length, 2, "新生命周期应重新配置");
  c.h.unmount(); d.h.unmount(); f.requests[1].resolve(); await flushAsync();
  assert.equal(f.configured.length, 1, "最后消费者卸载后迟到不得配置");
});
