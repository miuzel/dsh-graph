import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { extractFunction, flushAsync, makeHookHarness, makeSessionHooksSandbox, readClient } from "./_g387-harness.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Real SessionPanel -> real useBoundSession -> real binding/setup hooks. Only unrelated
// panel dependencies and the host session service are substituted.
function fixture() {
  const requests: ReturnType<typeof deferred>[] = [];
  const sessions = new Map<string, any>();
  const entries = [
    { id: "a", mode: "continuable" },
    { id: "b", mode: "one-shot" },
    { id: "c", mode: "continuable" },
  ];
  const snapshot = { projectionsBySession: {
    parent: { values: { subagentCatalog: entries } },
    other: { values: { subagentCatalog: [{ id: "a", mode: "one-shot" }] } },
  } };
  const rt = {
    list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    binding(id: string) {
      if (!sessions.has(id)) sessions.set(id, { session: { configureSubagent() {}, open: async () => {} }, eventSource: null });
      return sessions.get(id);
    },
    refreshProjections() { const d = deferred(); requests.push(d); return d.promise; },
  };
  const box: any = makeSessionHooksSandbox(rt, { console: { warn() {}, error() {}, log() {} } });
  Object.assign(box, {
    h: (type: any, props: any, ...children: any[]) => ({ type, props, children }),
    S: { livePanel: {}, drawerH: {}, meta: {}, btn: {} },
    useLocaleRevision() {}, useSessionSnapshot: () => null, useProjectionValue: () => null,
    useSessionModel: () => ({}), liveMeter: () => "", formatModelDisplay: () => "",
    formatShortModelDisplay: () => "", formatStatusWithLifecycle: () => ({ fullText: "" }),
    sessionLinkBtn: () => null, LiveStrip: () => null, PromptBox: () => null,
    ReExecBox: () => null, UnbindChildBox: () => null, RecentRecords: () => null,
  });
  vm.runInNewContext(`${extractFunction(readClient("live-panel"), "SessionPanel")}\nthis.renderPanel = SessionPanel;`, box);
  let child = "a";
  let parent = "parent";
  let lastTree: any;
  const find = (node: any, predicate: (node: any) => boolean): any => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) { for (const item of node) { const found = find(item, predicate); if (found) return found; } return null; }
    if (predicate(node)) return node;
    return find(node.children, predicate);
  };
  const records = () => {
    const props = find(lastTree, (node) => node.type === box.RecentRecords)?.props;
    return props ? { parentId: props.parentId, childId: props.childId, mode: props.mode } : null;
  };
  const renders: Array<{ child: string; parent: string; text: string; records: any }> = [];
  const harness = makeHookHarness((R) => {
    box.React = R;
    lastTree = box.renderPanel({ parentId: parent, childId: child });
    const text = JSON.stringify(lastTree);
    renders.push({ child, parent, text, records: records() });
    return text;
  });
  return { requests, renders, entries, harness, records,
    openRecords() {
      const button = find(lastTree, (node) => node.type === "button" && node.children?.some((s: any) => typeof s === "string" && s.includes("live.records")));
      assert.ok(button, "records 按钮必须存在");
      button.props.onClick();
      assert.ok(records(), "展开后必须渲染 RecentRecords");
    },
    switchTo(id: string, parentId = "parent") { child = id; parent = parentId; harness.render(); } };
}

const hasMode = (text: string, mode: string) => text.includes(`live.sessionMode ${mode}`);

test("SessionPanel 身份切换首帧与延迟响应不泄漏旧 mode，随后显示新 mode", async () => {
  const f = fixture();
  f.harness.render();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve();
  await flushAsync();
  assert.ok(hasMode(f.harness.value(), "live.continuable"), "前置：旧身份 mode 已真实显示");
  f.openRecords();
  assert.deepEqual(f.records(), { parentId: "parent", childId: "a", mode: "continuable" });
  const start = f.renders.length;
  f.switchTo("b");
  assert.equal(f.requests.length, 2);
  assert.ok(f.renders.slice(start).every((r) => !hasMode(r.text, "live.continuable")), "切换首帧及等待期不能出现旧 mode");
  assert.deepEqual(f.renders[start].records, { parentId: "parent", childId: "b", mode: null }, "切换首帧 RecentRecords 使用新身份和空 mode");
  f.requests[1].resolve();
  await flushAsync();
  assert.ok(hasMode(f.harness.value(), "live.oneShot"), "新身份响应后应显示新 mode");
  assert.deepEqual(f.records(), { parentId: "parent", childId: "b", mode: "one-shot" });
  f.harness.unmount();
});

test("失败的新身份不继承旧 mode", async () => {
  const f = fixture();
  f.harness.render();
  f.requests[0].resolve();
  await flushAsync();
  assert.ok(hasMode(f.harness.value(), "live.continuable"));
  f.entries.splice(1, 1); // A failed refresh with no cached entry cannot infer B's mode.
  f.switchTo("b");
  f.requests[1].reject(new Error("refresh failed"));
  await flushAsync();
  assert.ok(!f.harness.value().includes("live.sessionMode"), `失败后不显示旧身份模式: ${f.harness.value()}`);
  f.harness.unmount();
});

test("旧响应晚归与卸载后的响应不能覆盖新身份或触发渲染", async () => {
  const f = fixture();
  f.harness.render();
  assert.equal(f.requests.length, 1);
  f.switchTo("b");
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve();
  await flushAsync();
  assert.ok(hasMode(f.harness.value(), "live.oneShot"));
  f.requests[0].resolve();
  await flushAsync();
  assert.ok(hasMode(f.harness.value(), "live.oneShot"), "旧响应晚归不能覆盖新 mode");
  f.switchTo("c");
  assert.equal(f.requests.length, 3);
  f.harness.unmount();
  const count = f.renders.length;
  f.requests[2].resolve();
  await flushAsync();
  assert.equal(f.renders.length, count, "卸载后的响应不能触发渲染");
});

test("A → B → A 在 B 未完成时，RecentRecords 回切首帧仍为空", async () => {
  const f = fixture();
  f.harness.render();
  f.requests[0].resolve();
  await flushAsync();
  f.openRecords();
  assert.deepEqual(f.records(), { parentId: "parent", childId: "a", mode: "continuable" });
  f.switchTo("b");
  assert.equal(f.requests.length, 2);
  const start = f.renders.length;
  f.switchTo("a");
  assert.deepEqual(f.renders[start].records, { parentId: "parent", childId: "a", mode: null }, "回切首帧不能复活旧 A 状态");
  await flushAsync();
  assert.deepEqual(f.records(), { parentId: "parent", childId: "a", mode: "continuable" });
  f.requests[1].resolve();
  await flushAsync();
  assert.deepEqual(f.records(), { parentId: "parent", childId: "a", mode: "continuable" }, "旧 B 响应不能覆盖当前 A");
  f.harness.unmount();
});

test("同 child 切换 parent 时 RecentRecords 首帧为空并接收新 parent 的 mode", async () => {
  const f = fixture();
  f.harness.render();
  f.requests[0].resolve();
  await flushAsync();
  f.openRecords();
  assert.deepEqual(f.records(), { parentId: "parent", childId: "a", mode: "continuable" });
  const start = f.renders.length;
  f.switchTo("a", "other");
  assert.equal(f.requests.length, 2, "不同 parent 应触发新的目录查询");
  assert.deepEqual(f.renders[start].records, { parentId: "other", childId: "a", mode: null });
  f.requests[1].resolve();
  await flushAsync();
  assert.deepEqual(f.records(), { parentId: "other", childId: "a", mode: "one-shot" });
  f.harness.unmount();
});
