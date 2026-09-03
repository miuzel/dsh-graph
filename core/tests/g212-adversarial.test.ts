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

function host(configRoot: string, workspace?: string, policyWorkspace: string | null | undefined = workspace) {
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

test("g212 REST accepts explicit workspace regardless of sandboxPolicy", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "g212-policy-ws-"));
  const graphRoot = join(workspace, ".dsh-graph");
  const otherWorkspace = mkdtempSync(join(tmpdir(), "g212-policy-other-"));
  init(graphRoot);

  const cases = [
    ["matching policy", host(".dsh-graph", workspace, workspace)],
    ["mismatched policy", host(".dsh-graph", workspace, otherWorkspace)],
    ["no policy", host(".dsh-graph", workspace, null)],
  ] as const;
  for (const [label, fixture] of cases) {
    try {
      const getResult = response();
      await fixture.routes.get("/api/dsh-graph")({ method: "GET", url: "/api/dsh-graph?workspace=" + encodeURIComponent(workspace) }, getResult);
      assert.equal(getResult.code, 200, `${label}: explicit workspace GET succeeds`);

      const postResult = response();
      await fixture.routes.get("/api/dsh-graph/order")(validReq("/api/dsh-graph/order", { workspace, "g-001": ["planning"] }), postResult);
      assert.equal(postResult.code, 200, `${label}: body.workspace POST succeeds`);
      assert.equal(existsSync(join(graphRoot, "order.json")), true, `${label}: order written in requested workspace`);
    } finally { fixture.dispose(); }
  }

  const absolute = host(graphRoot);
  try {
    const getAbsolute = response();
    await absolute.routes.get("/api/dsh-graph")({ method: "GET", url: "/api/dsh-graph" }, getAbsolute);
    assert.equal(getAbsolute.code, 200, "absolute config.root GET works without policy or workspace");

    const postAbsolute = response();
    await absolute.routes.get("/api/dsh-graph/order")(validReq("/api/dsh-graph/order", { "g-002": ["draft"] }), postAbsolute);
    assert.equal(postAbsolute.code, 200, "absolute config.root POST works without policy or workspace");
    assert.equal(existsSync(join(graphRoot, "order.json")), true, "absolute config.root POST writes configured root");
  } finally { absolute.dispose(); }
});

test("g212 watcher recreation preserves content generation and teardown is callable", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "g212-watch-")), ".dsh-graph"); init(root); try { const before = generation(root); assert.equal(ensureWatcher(root), true); await new Promise((r) => setTimeout(r, 600)); assert.equal(generation(root), before); assert.equal(ensureWatcher(root), true); } finally { closeWatchers(); }
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
