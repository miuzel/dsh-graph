import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { extractFunction, flushAsync, makeDeferred, makeHookHarness, makeSessionHooksSandbox, readClient } from "./_g387-harness.ts";

// Execute the actual three components/hooks together. The only substituted boundary is
// the host API (plus unrelated panel widgets); each rendered frame is captured before effects.
function fixture() {
  const requests: any[] = [];
  const snapshot = { projectionsBySession: {
    parent: { values: { subagentCatalog: [{ id: "a", mode: "continuable" }, { id: "b", mode: "continuable" }] } },
    other: { values: { subagentCatalog: [{ id: "a", mode: "continuable" }] } },
  } };
  const sessions = new Map<string, any>();
  const rt = {
    list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    binding(id: string) {
      if (!sessions.has(id)) sessions.set(id, { session: { configureSubagent() {}, open: async () => {} }, eventSource: null });
      return sessions.get(id);
    },
    refreshProjections: async () => {},
  };
  const box: any = makeSessionHooksSandbox(rt, { console: { warn() {}, error() {}, log() {} } });
  const remote = { events(args: any, signal: AbortSignal) { const d = makeDeferred<any>(); requests.push({ ...d, args, signal }); return d.promise; } };
  Object.assign(box, {
    AbortController, appCtx: { get: () => remote },
    S: { livePanel: {}, drawerH: {}, meta: {}, btn: {}, recordItem: {} },
    useLocaleRevision() {}, useSessionSnapshot: () => null, useProjectionValue: () => null,
    useSessionModel: () => ({}), liveMeter: () => "", formatModelDisplay: () => "",
    formatShortModelDisplay: () => "", formatStatusWithLifecycle: () => ({ fullText: "" }),
    sessionLinkBtn: () => null, LiveStrip: () => null, PromptBox: () => null,
    ReExecBox: () => null, UnbindChildBox: () => null,
  });
  const source = readClient("live-panel");
  vm.runInNewContext(["readRecentRecords", "recentRecordText", "RecentRecords", "SessionPanel"].map(n => extractFunction(source, n)).join("\n") + "\nthis.panel = SessionPanel; this.records = RecentRecords;", box);
  box.h = (type: any, props: any, ...children: any[]) => type === box.records ? box.records(props) : ({ type, props, children });
  let parent = "parent", child = "a", tree: any;
  const frames: string[] = [];
  const harness = makeHookHarness((React) => { box.React = React; tree = box.panel({ parentId: parent, childId: child }); const text = JSON.stringify(tree); frames.push(text); return text; });
  const find = (n: any): any => {
    if (!n || typeof n !== "object") return null;
    if (Array.isArray(n)) { for (const x of n) { const found = find(x); if (found) return found; } return null; }
    if (n.type === "button" && n.children?.some((x: any) => typeof x === "string" && x.includes("live.records"))) return n;
    return find(n.children);
  };
  return { requests, frames, harness, open() { const button = find(tree); assert.ok(button); button.props.onClick(); },
    switchTo(c: string, p = "parent") { child = c; parent = p; harness.render(); },
    latestRequest() { assert.ok(requests.length); return requests[requests.length - 1]; } };
}
const response = (text: string) => ({ ok: true, value: { records: [{ event: { type: "user/message", data: { content: [{ type: "text", text }] } } }] } });

for (const oldKind of ["records", "error"]) {
  test(`切换 child 和 parent 的首帧不显示旧 ${oldKind}`, async () => {
    for (const [child, parent] of [["b", "parent"], ["a", "other"]]) {
      const f = fixture(); f.harness.render(); await flushAsync(); f.open();
      const old = f.latestRequest();
      old.resolve(oldKind === "records" ? response("OLD_RECORD") : { ok: false, error: { message: "OLD_ERROR" } });
      await flushAsync();
      const marker = oldKind === "records" ? "OLD_RECORD" : "OLD_ERROR";
      assert.ok(f.harness.value().includes(marker), "前置：旧数据真实显示");
      const start = f.frames.length; f.switchTo(child, parent);
      assert.ok(f.frames.length > start);
      assert.ok(!f.frames[start].includes(marker), "身份切换首帧不得显示旧内容");
      assert.ok(f.frames.slice(start).every(x => !x.includes(marker)), "等待期间不得显示旧内容");
      await flushAsync();
      const current = f.latestRequest();
      assert.equal(current.args.address.childSessionId, child);
      assert.equal(current.args.address.parentSessionId, parent);
      current.resolve(response("NEW_RECORD")); await flushAsync();
      assert.ok(f.harness.value().includes("NEW_RECORD"));
      f.harness.unmount();
    }
  });
}

test("A → B → A 不复活旧 A，且晚归 B 不覆盖新 A", async () => {
  const f = fixture(); f.harness.render(); await flushAsync(); f.open();
  const first = f.latestRequest(); first.resolve(response("A_OLD")); await flushAsync();
  assert.ok(f.harness.value().includes("A_OLD"));
  f.switchTo("b"); await flushAsync(); const b = f.latestRequest();
  const start = f.frames.length; f.switchTo("a");
  assert.ok(!f.frames[start].includes("A_OLD"), "回切首帧不得复活旧 A");
  await flushAsync(); const a = f.latestRequest(); assert.notEqual(a, first); assert.notEqual(a, b);
  a.resolve(response("A_NEW")); await flushAsync();
  b.resolve(response("B_LATE")); await flushAsync();
  assert.ok(f.harness.value().includes("A_NEW"));
  assert.ok(!f.harness.value().includes("B_LATE"));
  f.harness.unmount();
});

test("ABA 时首个 A 的在途响应不能覆盖新的 A", async () => {
  const f = fixture(); f.harness.render(); await flushAsync(); f.open();
  const oldA = f.latestRequest(); f.switchTo("b"); await flushAsync();
  f.switchTo("a"); await flushAsync(); const newA = f.latestRequest();
  assert.notEqual(oldA, newA);
  newA.resolve(response("A_CURRENT")); await flushAsync();
  oldA.resolve(response("A_STALE")); await flushAsync();
  assert.ok(f.harness.value().includes("A_CURRENT"));
  assert.ok(!f.harness.value().includes("A_STALE"));
  f.harness.unmount();
});

test("旧请求晚归及卸载后的成功或失败不能触发旧内容", async () => {
  for (const lateError of [false, true]) {
    const f = fixture(); f.harness.render(); await flushAsync(); f.open();
    const old = f.latestRequest(); f.switchTo("b"); await flushAsync(); const current = f.latestRequest();
    assert.equal(old.signal.aborted, true, "切换取消旧请求");
    current.resolve(response("CURRENT")); await flushAsync();
    if (lateError) old.reject(new Error("LATE_ERROR")); else old.resolve(response("LATE_RECORD"));
    await flushAsync(); assert.ok(f.harness.value().includes("CURRENT"));
    assert.ok(!f.harness.value().includes("LATE_"));
    f.switchTo("a"); await flushAsync(); const pending = f.latestRequest();
    f.harness.unmount(); assert.equal(pending.signal.aborted, true);
    const count = f.frames.length;
    if (lateError) pending.reject(new Error("UNMOUNT_ERROR")); else pending.resolve(response("UNMOUNT_RECORD"));
    await flushAsync(); assert.equal(f.frames.length, count, "卸载后无渲染");
  }
});
