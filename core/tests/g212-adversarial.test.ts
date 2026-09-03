import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { init } from "../../dsh-graph-host/core/ops.js";
import { resolveRoot, resolveCanonicalRoot } from "../../dsh-graph-host/core/root.js";
import { apply } from "../../dsh-graph-host/index.js";
import { ensureWatcher, generation, closeWatchers } from "../../dsh-graph-host/core/cache-state.js";
import { readFileSync } from "node:fs";

function host(configRoot: string, workspace?: string, policyWorkspace = workspace) {
  const routes = new Map<string, any>(); let dispose = () => {};
  const webServer = { register: (d: any) => { routes.set(d.path, d.handler); return () => {}; } };
  const ctx: any = { get: (n: string) => n === "webServer" ? webServer : n === "sandboxPolicy" && policyWorkspace ? { workspaceRoot: policyWorkspace } : undefined, effect: (fn: any) => { dispose = fn(); return dispose; }, webServer, tools: { register: () => () => {}, get: () => ({}) } };
  apply(ctx, { root: configRoot });
  return { routes, dispose };
}
function response() { const r: any = { code: 0, body: null }; r.writeHead = (c: number) => { r.code = c; }; r.end = (s?: string) => { r.body = s ? JSON.parse(s) : null; }; return r; }
function badReq(url: string) { const listeners: any = {}; return { method: "POST", url, on: (e: string, cb: any) => { listeners[e] = cb; if (e === "data") cb("{bad"); if (e === "end") cb(); }, listeners }; }
function validReq(url: string, body: unknown) { const listeners: any = {}; return { method: "POST", url, on: (e: string, cb: any) => { listeners[e] = cb; if (e === "data") cb(JSON.stringify(body)); if (e === "end") cb(); }, listeners }; }

test("g212 malformed transition body is controlled 400", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "g212-malformed-")); const root = join(workspace, ".dsh-graph"); init(root);
  const fixture = host(".dsh-graph", workspace); const h = fixture.routes.get("/api/dsh-graph/transition"); const res = response();
  try { await h(badReq("/api/dsh-graph/transition"), res); assert.equal(res.code, 400); assert.match(String(res.body?.error), /JSON|body|格式/); } finally { fixture.dispose(); }
});

test("g212 absolute config symlink and missing leaf parent are rejected", () => {
  const outside = mkdtempSync(join(tmpdir(), "g212-out-")); const holder = mkdtempSync(join(tmpdir(), "g212-holder-")); const alias = join(holder, "alias"); symlinkSync(outside, alias, "dir");
  assert.throws(() => resolveRoot({ root: alias }), /symlink/); assert.throws(() => resolveCanonicalRoot({ root: join(alias, "missing", ".dsh-graph") }, holder), /symlink/); assert.throws(() => host(alias, holder), /symlink/); assert.equal(existsSync(join(outside, "missing")), false);
});

test("g212 absolute config REST still requires sandboxPolicy for GET and POST", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "g212-policy-ws-"));
  const graphRoot = join(workspace, "graph-data");
  const otherWorkspace = mkdtempSync(join(tmpdir(), "g212-policy-other-"));
  init(graphRoot);

  const missing = host(graphRoot);
  try {
    const getMissing = response();
    await missing.routes.get("/api/dsh-graph")({ method: "GET", url: "/api/dsh-graph" }, getMissing);
    assert.equal(getMissing.code, 400);
    const postMissing = response();
    await missing.routes.get("/api/dsh-graph/order")(validReq("/api/dsh-graph/order?workspace=" + encodeURIComponent(workspace), { "g-001": ["draft"] }), postMissing);
    assert.equal(postMissing.code, 400);
    assert.equal(existsSync(join(graphRoot, "order.json")), false, "无策略不得写 absolute graph root");
  } finally { missing.dispose(); }

  const mismatched = host(graphRoot, workspace, otherWorkspace);
  try {
    const getMismatched = response();
    await mismatched.routes.get("/api/dsh-graph")({ method: "GET", url: "/api/dsh-graph?workspace=" + encodeURIComponent(workspace) }, getMismatched);
    assert.equal(getMismatched.code, 400);
    const postMismatched = response();
    await mismatched.routes.get("/api/dsh-graph/order")(validReq("/api/dsh-graph/order?workspace=" + encodeURIComponent(workspace), { "g-001": ["planning"] }), postMismatched);
    assert.equal(postMismatched.code, 400);
    assert.equal(existsSync(join(graphRoot, "order.json")), false, "不匹配策略不得写 absolute graph root");
  } finally { mismatched.dispose(); }

  const matching = host(graphRoot, workspace, workspace);
  try {
    const getMatching = response();
    await matching.routes.get("/api/dsh-graph")({ method: "GET", url: "/api/dsh-graph?workspace=" + encodeURIComponent(workspace) }, getMatching);
    assert.equal(getMatching.code, 200);
    const postMatching = response();
    await matching.routes.get("/api/dsh-graph/order")(validReq("/api/dsh-graph/order?workspace=" + encodeURIComponent(workspace), { "g-001": ["planning"] }), postMatching);
    assert.equal(postMatching.code, 200);
    assert.equal(existsSync(join(graphRoot, "order.json")), true, "匹配策略允许使用管理员 absolute graph root");
  } finally { matching.dispose(); }
});

test("g212 watcher recreation invalidates safely and teardown is callable", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "g212-watch-")), ".dsh-graph"); init(root); try { const before = generation(root); assert.equal(ensureWatcher(root), true); await new Promise((r) => setTimeout(r, 600)); assert.ok(generation(root) > before); assert.equal(ensureWatcher(root), true); } finally { closeWatchers(); }
});

test("g212 client dimension contract guards retained payload and request sequence", () => {
  const src = readFileSync(new URL("../../dsh-graph-host/lib/client/kanban.js", import.meta.url), "utf8");
  assert.match(src, /boardDataRef/); assert.match(src, /requestSeqRef/); assert.match(src, /String\(props\?\.sessionId/); assert.match(src, /String\(activeWs/); assert.match(src, /showArchived/); assert.match(src, /retainedData/); assert.match(src, /r\.status === 304/); assert.match(src, /requestSeq !== requestSeqRef.current/); assert.match(src, /currentEtagRef.current.delete\(dimension\)/);
});

test("g212 watcher timer identity contract clears stale timers", () => {
  const src = readFileSync(new URL("../../core/cache-state.ts", import.meta.url), "utf8");
  assert.match(src, /watchers\.get\(key\) !== w/);
  assert.match(src, /idleTimers\.get\(key\) !== timer/);
  assert.match(src, /clearTimeout/);
  assert.match(src, /watchers\.get\(key\)===w/);
});

test("g212 malformed POST matrix is wired through shared parser", () => {
  const src = readFileSync(new URL("../../dsh-graph-host/index.js", import.meta.url), "utf8");
  assert.match(src, /reject\(new GraphError/);
  for (const route of ["transition", "set-criteria", "order", "start-execution"]) assert.match(src, new RegExp("/api/dsh-graph/" + route));
});

test("g212 apply disposer tears down compiled cache and invalidates board cache", () => {
  const src = readFileSync(new URL("../../dsh-graph-host/index.js", import.meta.url), "utf8");
  assert.match(src, /closeWatchers\(\)/); assert.match(src, /invalidateBoardCache\(\)/);
});
