import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const source = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/live-panel.js"), "utf8");
const begin = source.indexOf("    async function readRecentRecords(");
const end = source.indexOf("    // Recent records use", begin);
assert.ok(begin >= 0 && end > begin, "production helper must exist");
const readHistory = runInNewContext(`(function(){ ${source.slice(begin, end)}; return readRecentRecords; })()`);
const record = { type: "event", event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "ACK" }] } } } };
const expectedAddress = { kind: "subagent", parentSessionId: "parent", childSessionId: "child", mode: "unknown" };
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test("g-614 rc.1 events reads records with complete subagent address and unknown mode", async () => {
  let request: any;
  const result = await readHistory({ events: async (r: unknown) => { request = r; return { ok: true, value: { records: [record] } }; } }, "parent", "child", null);
  assert.deepEqual(plain(request), { address: expectedAddress, maxMessages: 30 });
  assert.deepEqual(plain(result), { entries: [record] });
});

test("g-614 only successful empty history is empty; identities and absent capability are unavailable", async () => {
  let calls = 0;
  const remote = { events: async () => { calls++; return { ok: true, value: { records: [] } }; } };
  assert.deepEqual(plain(await readHistory(remote, "p", "c", "continuable")), { entries: [] });
  assert.deepEqual(plain(await readHistory(remote, null, "c", "continuable")), { unavailable: "identity" });
  assert.deepEqual(plain(await readHistory(remote, "p", null, "continuable")), { unavailable: "identity" });
  assert.equal(calls, 1);
  assert.deepEqual(plain(await readHistory(null, "p", "c", null)), { unavailable: "capability" });
  assert.deepEqual(plain(await readHistory({}, "p", "c", null)), { unavailable: "capability" });
});

test("g-614 rejection, malformed success and thrown errors never look empty", async () => {
  assert.deepEqual(plain(await readHistory({ events: async () => ({ ok: false, error: { message: "denied" } }) }, "p", "c", null)), { error: "denied" });
  assert.deepEqual(plain(await readHistory({ events: async () => ({ ok: true, value: {} }) }, "p", "c", null)), { error: "invalid history response" });
  await assert.rejects(readHistory({ events: async () => { throw new Error("offline"); } }, "p", "c", null), /offline/);
});

test("g-614 0.2.1 follow snapshot yields real records and closes stream", async () => {
  let request: any; let closed = false;
  const remote = { async *follow(r: unknown) { request = r; try { yield { type: "snapshot", cursor: 7, records: [record] }; } finally { closed = true; } } };
  const result = await readHistory(remote, "parent", "child", "one-shot");
  assert.deepEqual(plain(request), { address: { ...expectedAddress, mode: "one-shot" }, maxMessages: 30 });
  assert.deepEqual(plain(result), { entries: [record] });
  assert.equal(closed, true);
  assert.deepEqual(plain(await readHistory({ async *follow() { yield { type: "snapshot", records: [] }; } }, "p", "c", "continuable")), { entries: [] });
  assert.deepEqual(plain(await readHistory({ async *follow() { yield { type: "event" }; } }, "p", "c", null)), { error: "invalid history snapshot" });
  assert.deepEqual(plain(await readHistory({ async *follow() {} }, "p", "c", null)), { error: "history stream ended before snapshot" });
});

test("g-614 old follow receives cancellation signal and propagates stream errors", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  let closed = false;
  const remote = { async *follow(_r: unknown, signal: AbortSignal) {
    received = signal;
    try {
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      yield { type: "snapshot", records: [] };
    } finally { closed = true; }
  } };
  const pending = readHistory(remote, "p", "c", "continuable", controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(received, controller.signal);
  assert.equal(closed, true);
  await assert.rejects(readHistory({ async *follow() { throw new Error("stream failed"); } }, "p", "c", null), /stream failed/);
});

test("g-614 maps real wire message and tool shapes", () => {
  const start = source.indexOf("    function recentRecordText(");
  assert.ok(start > begin);
  const text = runInNewContext(`(function(){const dgT = x => x; ${source.slice(start, end)}; return recentRecordText; })()`);
  assert.equal(text(record), "🤖 ACK");
  assert.equal(text({ event: { type: "user/message", data: { content: [{ type: "text", text: "hello" }] } } }), "🧑 hello");
  assert.equal(text({ event: { type: "tool/call", data: { name: "bash" } } }), "🔧 bash");
});

test("g-614 UI distinguishes unavailable and rejected from successful emptiness", () => {
  assert.match(source, /else if \(state\.error\).*live\.readFailed/);
  assert.match(source, /else if \(state\.unavailable\).*live\.historyIdentityUnavailable/);
  assert.match(source, /else if \(!state\.entries\.length\).*live\.noRecords/);
  assert.match(source, /\[props\.parentId, props\.childId, props\.mode\]/);
  assert.match(source, /controller\.abort\(\)/);
});
