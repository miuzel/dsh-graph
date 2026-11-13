import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGoal, findGoalFile, goalDetail, init, loadGoal, moveGoal, setCriteria } from "../ops.ts";
import { apply } from "../../dist/index.js";
import { prepareAttemptWorktree } from "../worktree.ts";
import { createRegisterStub, entryHandler, ownerConnectionStub, OWNER_HEADER } from "./_http-auth-harness.ts";

const fields = ["baseline_commit", "baseline_source", "baseline_ref", "baseline_version", "baseline_fallback_reason"] as const;
function git(ws: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: ws, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function harness() {
  const tmp = join(import.meta.dirname, "../../tmp");
  mkdirSync(tmp, { recursive: true });
  const ws = mkdtempSync(join(tmp, "g474-"));
  git(ws, "init", "-q", "-b", "main");
  writeFileSync(join(ws, ".gitignore"), ".worktrees/\n.dsh-graph/\n");
  writeFileSync(join(ws, "file"), "base");
  git(ws, "add", ".");
  git(ws, "-c", "user.name=test", "-c", "user.email=t@e", "commit", "-qm", "base");
  const versionTip = git(ws, "rev-parse", "HEAD");
  git(ws, "branch", "v1.2.3-test");
  writeFileSync(join(ws, "file"), "main");
  git(ws, "add", "file");
  git(ws, "-c", "user.name=test", "-c", "user.email=t@e", "commit", "-qm", "main");
  const mainTip = git(ws, "rev-parse", "HEAD");
  const root = join(ws, ".dsh-graph");
  init(root);
  const stub = createRegisterStub();
  const tools: any[] = [];
  let spawned = 0;
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return stub.webServer;
      if (name === "connection") return ownerConnectionStub();
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "subagents") return { list: () => ["spawn"], listChildren: async () => [], getProvider: () => ({ prepareContinuable: () => {} }), startContinuable: async () => { spawned++; return { childId: "child-" + spawned, parentSessionId: "sess-super" }; } };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(), webServer: stub.webServer,
    tools: { register: (def: any) => { tools.push(def); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  return { ws, root, versionTip, mainTip, routes: stub.routes, spawned: () => spawned,
    dispatch: (args: any) => tools.find(t => t.name === "graph_start_attempt").execute(args, { agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-exec" } }, signal: new AbortController().signal }) };
}
function goal(h: ReturnType<typeof harness>, version = true) {
  const id = createGoal(h.root, { title: "baseline", ...(version ? { version: "v1.2.3" } : {}), type: "feature", actor: "human:gui" });
  if (!version) moveGoal(h.root, id, { to: "standalone", actor: "human:gui" });
  setCriteria(h.root, id, ["criterion"], "human:gui");
  return id;
}
function meta(h: ReturnType<typeof harness>, id: string, attempt: string): any {
  return loadGoal(join(dirname(findGoalFile(h.root, id)), "attempts", attempt, "attempt.md")).meta;
}
function checkFields(result: any, record: any) {
  for (const key of fields) {
    assert.ok(Object.hasOwn(result, key), `response missing ${key}`);
    assert.ok(Object.hasOwn(record, key), `attempt missing ${key}`);
    assert.deepEqual(result[key], record[key] ?? null, `${key} differs from attempt`);
  }
}
function zeroEffects(h: ReturnType<typeof harness>, id: string, before: string, trees: string, branches: string) {
  assert.equal(loadGoal(findGoalFile(h.root, id)).meta.status, before);
  assert.equal(goalDetail(h.root, id).attempts.length, 0);
  assert.equal(existsSync(join(dirname(findGoalFile(h.root, id)), "attempts")), false);
  assert.equal(h.spawned(), 0);
  assert.equal(git(h.ws, "worktree", "list", "--porcelain"), trees);
  assert.equal(git(h.ws, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"), branches);
}

test("g474 version branch wins over divergent main and is audited", async () => {
  const h = harness(); const id = goal(h);
  const r = await h.dispatch({ goal: id, worktree: true });
  assert.equal(r.baseline_commit, h.versionTip);
  assert.equal(r.baseline_source, "version_branch");
  assert.equal(r.baseline_ref, "refs/heads/v1.2.3-test");
  assert.equal(r.baseline_version, "v1.2.3");
  assert.equal(git(r.worktree.path, "rev-parse", "HEAD"), h.versionTip);
  checkFields(r, meta(h, id, r.attempt));
  const events = readFileSync(join(h.root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const started = events.find(e => e.event === "attempt.started" && e.details?.attempt === r.attempt);
  assert.ok(started, "attempt.started must be recorded");
  for (const field of fields) assert.deepEqual(started.details[field] ?? null, r[field], `event ${field}`);
});

test("g474 explicit baseline overrides version branch", async () => {
  const h = harness(); const id = goal(h);
  const r = await h.dispatch({ goal: id, worktree: true, baseline_commit: h.mainTip });
  assert.equal(r.baseline_commit, h.mainTip);
  assert.equal(r.baseline_source, "explicit");
  assert.equal(git(r.worktree.path, "rev-parse", "HEAD"), h.mainTip);
  checkFields(r, meta(h, id, r.attempt));
});

test("g474 standalone uses main HEAD", async () => {
  const h = harness(); const id = goal(h, false);
  const r = await h.dispatch({ goal: id, worktree: true });
  assert.equal(r.baseline_commit, h.mainTip);
  assert.equal(r.baseline_source, "main_head");
  checkFields(r, meta(h, id, r.attempt));
});

test("g474 non-isolated divergent version baseline is rejected without effects", async () => {
  const h = harness(); const id = goal(h);
  const before = String(loadGoal(findGoalFile(h.root, id)).meta.status);
  const trees = git(h.ws, "worktree", "list", "--porcelain");
  const branches = git(h.ws, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
  await assert.rejects(() => h.dispatch({ goal: id, worktree: false }), /HEAD.*不一致/);
  zeroEffects(h, id, before, trees, branches);
});

test("g474 non-isolated matching version baseline is audited", async () => {
  const h = harness(); const id = goal(h);
  git(h.ws, "branch", "-f", "v1.2.3-test", h.mainTip);
  const r = await h.dispatch({ goal: id, worktree: false });
  assert.equal(r.isolated, false);
  assert.equal(r.baseline_commit, h.mainTip);
  assert.equal(r.baseline_source, "version_branch");
  checkFields(r, meta(h, id, r.attempt));
});

test("g474 non-isolated matching explicit baseline is audited", async () => {
  const h = harness(); const id = goal(h);
  const r = await h.dispatch({ goal: id, worktree: false, baseline_commit: h.mainTip });
  assert.equal(r.isolated, false);
  assert.equal(r.baseline_commit, h.mainTip);
  assert.equal(r.baseline_source, "explicit");
  checkFields(r, meta(h, id, r.attempt));
});

for (const kind of ["missing", "remote-only", "invalid-explicit"] as const) {
  test(`g474 ${kind} fails before state, attempts, worktree or spawn`, async () => {
    const h = harness(); const id = goal(h);
    if (kind !== "invalid-explicit") {
      git(h.ws, "branch", "-D", "v1.2.3-test");
      if (kind === "remote-only") git(h.ws, "update-ref", "refs/remotes/origin/v1.2.3-test", h.versionTip);
    }
    const before = String(loadGoal(findGoalFile(h.root, id)).meta.status);
    const trees = git(h.ws, "worktree", "list", "--porcelain");
    const branches = git(h.ws, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
    await assert.rejects(() => h.dispatch({ goal: id, worktree: true, ...(kind === "invalid-explicit" ? { baseline_commit: "0".repeat(40) } : {}) }));
    zeroEffects(h, id, before, trees, branches);
  });
}

test("g474 non-isolated invalid explicit baseline has zero side effects", async () => {
  const h = harness(); const id = goal(h);
  const before = String(loadGoal(findGoalFile(h.root, id)).meta.status);
  const trees = git(h.ws, "worktree", "list", "--porcelain");
  const branches = git(h.ws, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
  await assert.rejects(() => h.dispatch({ goal: id, worktree: false, baseline_commit: "0".repeat(40) }));
  zeroEffects(h, id, before, trees, branches);
});

test("g474 owned existing worktree preserves original anchor and advanced HEAD", () => {
  const h = harness(); const id = goal(h);
  const first = prepareAttemptWorktree(h.root, id, "att-001", { enabled: true, version: "v1.2.3" });
  assert.ok(first.worktree);
  const path = first.worktree.path;
  assert.equal(first.baseline_commit, h.versionTip);
  writeFileSync(join(path, "file"), "attempt progress");
  git(path, "add", "file");
  git(path, "-c", "user.name=test", "-c", "user.email=t@e", "commit", "-qm", "progress");
  const advanced = git(path, "rev-parse", "HEAD");
  assert.notEqual(advanced, h.versionTip);
  const second = prepareAttemptWorktree(h.root, id, "att-001", { enabled: true, version: "v1.2.3" });
  assert.equal(second.reused, true);
  assert.equal(second.created, false);
  assert.equal(second.baseline_source, "existing_worktree");
  assert.equal(second.baseline_commit, h.versionTip);
  assert.ok(second.worktree);
  assert.equal(second.worktree.head, advanced);
  assert.equal(git(path, "rev-parse", "HEAD"), advanced);
});

test("g474 existing worktree conflict never silently resets or misreports", async () => {
  const h = harness(); const id = goal(h);
  const first = prepareAttemptWorktree(h.root, id, "att-001", { enabled: true, version: "v1.2.3" });
  assert.ok(first.worktree);
  const path = first.worktree.path;
  const before = String(loadGoal(findGoalFile(h.root, id)).meta.status);
  const trees = git(h.ws, "worktree", "list", "--porcelain");
  const branches = git(h.ws, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
  let r: any;
  try { r = await h.dispatch({ goal: id, worktree: true, baseline_commit: h.mainTip }); }
  catch {
    zeroEffects(h, id, before, trees, branches);
    assert.equal(git(path, "rev-parse", "HEAD"), h.versionTip);
    return;
  }
  assert.equal(git(path, "rev-parse", "HEAD"), h.versionTip);
  assert.equal(r.baseline_source, "existing_worktree");
  assert.equal(r.baseline_commit, h.versionTip);
  checkFields(r, meta(h, id, r.attempt));
});

test("g474 HTTP response preserves baseline whitelist", async () => {
  const h = harness(); const id = goal(h);
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n");
  const listeners: Record<string, Function> = {};
  const req: any = { headers: { [OWNER_HEADER]: "1" }, method: "POST", url: "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(h.ws), on: (e: string, f: Function) => { listeners[e] = f; } };
  const res: any = { code: 0, body: null, writeHead(c: number) { this.code = c; }, end(s: string) { this.body = s ? JSON.parse(s) : null; } };
  const p = entryHandler(h.routes)(req, res);
  listeners.data(JSON.stringify({ goal: id, worktree: true })); listeners.end();
  await p;
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.baseline_commit, h.versionTip);
  assert.equal(res.body.baseline_source, "version_branch");
  checkFields(res.body, meta(h, id, res.body.attempt));
});

test("g474 both response whitelists reject each omitted baseline field", () => {
  const source = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");
  const anchors = ["baseline_commit: execRes.baseline_commit ?? null"];
  for (const anchor of anchors) assert.equal(source.split(anchor).length - 1, 2, "tool and HTTP whitelist anchors");
  const sections = source.split(anchors[0]).slice(1).map(s => s.slice(0, 1200));
  const missing = (section: string) => fields.slice(1).filter(f => !new RegExp(`${f}\\s*:\\s*execRes\\.${f}\\b`).test(section));
  for (const section of sections) {
    assert.deepEqual(missing(section), []);
    for (const field of fields.slice(1)) {
      const altered = section.replace(new RegExp(`${field}\\s*:\\s*execRes\\.${field}\\b`), "omitted_field: null");
      assert.ok(missing(altered).includes(field), `negative control for ${field}`);
    }
  }
});
