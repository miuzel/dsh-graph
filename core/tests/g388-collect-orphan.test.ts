/** g-388（v0.18.0 审查 H3，P2）：collecting 共享卡重试收集会孤儿化子代理并丢失 child_id。
 *
 *  旧行为：工具入口（graph_start_attempt + card）与 REST 入口（/api/dsh-graph/start-collection）
 *  都是「先 startContinuable/spawnChild（已启动真实 child）再 bindCardChild」；第二绑定被
 *  g-183 拒绝后，既不中断已启动的 child，也不保留其 child_id
 *  ⇒ spawned=2 / interrupted=0 / 第二结果 child_id=null，留下无人追踪、仍在写卡的孤儿 worker。
 *
 *  覆盖（判据 1–4）：
 *   ① 工具入口：collecting 共享卡重试在 spawn 前被拒 ⇒ spawn 次数不增、child_id=null、不请求中断；
 *   ② REST 入口：同一判定（不新增 spawn、child_id=null，且与工具入口同一套收敛策略）；
 *   ③ 成功路径只 spawn/bind 一次（恰 1 条 card.collecting 事件）；
 *   ④ spawn 成功但 bind 失败（用 startContinuable 钩子制造"另一收集者抢先绑定"的竞态）：
 *      请求中断该 child、结果保留可追溯 child_id、不破坏已存在的其它绑定；
 *   ⑤ 中断能力缺失 / 中断抛错：如实上报"无法中断/中断失败"，绝不虚称已停止；
 *   ⑥ 核心层 assertCollectAdmission 与 bindCardChild 拒绝条件、文案同源；
 *   ⑦ 负向对照（源序守卫）：两入口都必须"先准入后 spawn"，收集路径不得回退成直连 bindCardChild。
 *
 *  验证边界：subagent 服务为计数 mock，**未运行真实 worker**；因此"孤儿 worker 仍在写卡"的
 *  危害属代码推论（依据：旧序在拒绝前已启动 child 且未中断、未保留 child_id）。真实中断效果
 *  依赖宿主 interruptByParent 能力，本测试只断言"是否请求中断/是否如实上报"。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  addCard,
  createSharedCard,
  addSharedCardRef,
  bindCardChild,
  assertCollectAdmission,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";

const HOST_SRC = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");

type InterruptMode = "ok" | "missing" | "throw";

/** 计数 mock：记录 spawn 次数与 interruptByParent 调用参数；可注入 onSpawn 钩子（竞态模拟）。 */
function mkSubagents(opts: { onSpawn?: (n: number) => void; interrupt?: InterruptMode } = {}) {
  const spawnedIds: string[] = [];
  const interruptCalls: any[][] = [];
  const svc: any = {
    list: () => ["spawn"],
    getProvider: () => ({ prepareContinuable() {} }),
    startContinuable: async () => {
      const childId = `child-${spawnedIds.length + 1}`;
      spawnedIds.push(childId);
      opts.onSpawn?.(spawnedIds.length);
      return { childId, parentSessionId: "parent" };
    },
  };
  const mode: InterruptMode = opts.interrupt ?? "ok";
  if (mode !== "missing") {
    svc.interruptByParent = (...args: any[]) => {
      if (mode === "throw") throw new Error("interrupt service down");
      interruptCalls.push(args);
    };
  }
  return { svc, spawnedIds, interruptCalls };
}

/** 真实插件 apply + mock ctx：工具注册表与 REST 路由都拿到，两个入口在同一宿主内受检。 */
function applyHost(ws: string, subagents: any) {
  const root = join(ws, ".dsh-graph");
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-g388\n", "utf8");
  const registered = new Map<string, any>();
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const agents = { get: () => ({ id: "sess-g388" }) };
  const ctx: any = {
    get: (name: string) => {
      if (name === "subagents") return subagents;
      if (name === "webServer") return webServer;
      if (name === "agents") return agents;
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registered.set(def.name, def); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  return { root, registered, routes };
}

function post(routes: Map<string, any>, path: string, body: unknown) {
  const handler = routes.get(path);
  assert.ok(handler, `路由 ${path} 已注册`);
  const req: any = { method: "POST", _listeners: {} as Record<string, (v?: any) => void>, on(ev: string, cb: any) { req._listeners[ev] = cb; } };
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  const p = handler(req, res);
  req._listeners.data?.(JSON.stringify(body));
  req._listeners.end?.();
  return p.then(() => res);
}

const exFor = (ws: string) => ({
  agent: { id: "agent", session: { id: "parent", header: { cwd: ws } } },
  signal: new AbortController().signal,
});

/** 临时工作区 + 真实插件：返回 goal / 共享卡 / 工具表 / 路由表 / mock 服务。 */
function fixture(opts: { onSpawn?: (n: number) => void; interrupt?: InterruptMode } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g388-"));
  const m = mkSubagents(opts);
  const host = applyHost(ws, m.svc);
  const goal = createGoal(host.root, { title: "g388 目标", version: "v-t", actor: "test" });
  const card = createSharedCard(host.root, { title: "共享收集卡", actor: "test" });
  addSharedCardRef(host.root, goal, card, "test");
  return { ws, ...host, ...m, goal, card };
}

const collectingEvents = (root: string, goal: string, card: string) =>
  readEvents(root).filter((e) => e.event === "card.collecting" && e.goal === goal && e.details?.card === card);

// ---------------------------------------------------------------- ①② spawn 前准入（两入口一致）

test("g-388 ①工具入口：collecting 共享卡重试在 spawn 前被拒，不额外启动 child", async () => {
  const f = fixture();
  const tool = f.registered.get("graph_start_attempt");
  const ex = exFor(f.ws);

  const first = await tool.execute({ goal: f.goal, card: f.card }, ex);
  assert.equal(f.spawnedIds.length, 1, "首次收集应 spawn 恰 1 个 child");
  assert.equal(first.child_id, "child-1");
  assert.equal(first.child_error, null);

  const second = await tool.execute({ goal: f.goal, card: f.card }, ex);
  assert.equal(f.spawnedIds.length, 1, "重试被 spawn 前拒绝 ⇒ 不得额外启动任何 child");
  assert.equal(second.child_id, null, "未启动 child ⇒ child_id 为 null");
  assert.match(String(second.child_error), /不能并行收集/, "应如实上报收集冲突");
  assert.match(String(second.child_error), /child-1/, "冲突文案应点名现有权威收集者");
  assert.equal(f.interruptCalls.length, 0, "未启动 child ⇒ 无需（也不得）请求中断");
  assert.equal(collectingEvents(f.root, f.goal, f.card).length, 1, "成功路径只绑定一次（恰 1 条 card.collecting）");
});

test("g-388 ②REST 入口：同一判定——重试在 spawn 前被拒，不额外启动 child", async () => {
  const f = fixture();

  const first = await post(f.routes, "/api/dsh-graph/start-collection", { goal: f.goal, card: f.card, workspace: f.ws });
  assert.equal(first._code, 200);
  assert.equal(first._body.child_id, "child-1");
  assert.equal(first._body.child_error, null);
  assert.equal(f.spawnedIds.length, 1);

  const second = await post(f.routes, "/api/dsh-graph/start-collection", { goal: f.goal, card: f.card, workspace: f.ws });
  assert.equal(second._code, 200);
  assert.equal(f.spawnedIds.length, 1, "REST 重试同样不得额外启动 child");
  assert.equal(second._body.child_id, null);
  assert.match(String(second._body.child_error), /不能并行收集/);
  assert.equal(f.interruptCalls.length, 0);
  assert.equal(collectingEvents(f.root, f.goal, f.card).length, 1);
});

// ---------------------------------------------------------------- ④⑤ spawn 后 bind 失败的有限收敛

/** 竞态模拟：在 startContinuable 返回前，让"另一个收集者"抢先绑定该共享卡。
 *  于是本入口的 bindCardChild 必然被 g-183 拒绝 —— 正是"spawn 成功但 bind 失败"的真实形态。 */
function raceHook(root: string, goal: string, card: string, rivalChild = "child-rival") {
  return () => bindCardChild(root, goal, card, { childId: rivalChild, actor: "test" });
}

test("g-388 ④工具入口：spawn 成功但 bind 失败 ⇒ 请求中断并保留 child_id，不破坏既有绑定", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g388-"));
  const hooks: { onSpawn?: () => void } = {};
  const m = mkSubagents({ onSpawn: () => hooks.onSpawn?.() });
  const host = applyHost(ws, m.svc);
  const goal = createGoal(host.root, { title: "g388 目标", version: "v-t", actor: "test" });
  const card = createSharedCard(host.root, { title: "共享收集卡", actor: "test" });
  addSharedCardRef(host.root, goal, card, "test");
  hooks.onSpawn = raceHook(host.root, goal, card);

  const r = await host.registered.get("graph_start_attempt").execute({ goal, card }, exFor(ws));
  assert.equal(m.spawnedIds.length, 1, "child 确实启动了（bind 失败发生在 spawn 之后）");
  assert.equal(r.child_id, "child-1", "bind 失败必须保留可追溯 child_id");
  assert.match(String(r.child_error), /绑定失败/);
  assert.match(String(r.child_error), /child-1/);
  assert.match(String(r.child_error), /已请求中断/, "必须请求中断刚启动的 child");
  assert.equal(r.child_interrupted, true);
  assert.equal(m.interruptCalls.length, 1, "interruptByParent 恰被调用一次");
  assert.deepEqual(m.interruptCalls[0].slice(0, 2), ["child-1", "parent"]);
  // 失败收敛不得改动其它生命周期：卡仍绑定抢先的收集者、事件仍只有那 1 条
  const evs = collectingEvents(host.root, goal, card);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].details.child_id, "child-rival");
});

test("g-388 ⑤中断能力缺失：如实上报「无法中断」，不得虚称已停止", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g388-"));
  const hooks: { onSpawn?: () => void } = {};
  const m = mkSubagents({ onSpawn: () => hooks.onSpawn?.(), interrupt: "missing" });
  const host = applyHost(ws, m.svc);
  const goal = createGoal(host.root, { title: "g388 目标", version: "v-t", actor: "test" });
  const card = createSharedCard(host.root, { title: "共享收集卡", actor: "test" });
  addSharedCardRef(host.root, goal, card, "test");
  hooks.onSpawn = raceHook(host.root, goal, card);

  const r = await host.registered.get("graph_start_attempt").execute({ goal, card }, exFor(ws));
  assert.equal(r.child_id, "child-1", "中断不可用也必须保留 child_id");
  assert.match(String(r.child_error), /无法中断/);
  assert.doesNotMatch(String(r.child_error), /已请求中断/, "不得虚称已停止");
  assert.equal(r.child_interrupted, undefined, "未成功请求中断 ⇒ 不得标记已中断");
});

test("g-388 ⑤中断本身失败：如实上报失败原因，不得虚称已停止", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g388-"));
  const hooks: { onSpawn?: () => void } = {};
  const m = mkSubagents({ onSpawn: () => hooks.onSpawn?.(), interrupt: "throw" });
  const host = applyHost(ws, m.svc);
  const goal = createGoal(host.root, { title: "g388 目标", version: "v-t", actor: "test" });
  const card = createSharedCard(host.root, { title: "共享收集卡", actor: "test" });
  addSharedCardRef(host.root, goal, card, "test");
  hooks.onSpawn = raceHook(host.root, goal, card);

  const r = await host.registered.get("graph_start_attempt").execute({ goal, card }, exFor(ws));
  assert.equal(r.child_id, "child-1");
  assert.match(String(r.child_error), /中断该 child 失败/);
  assert.match(String(r.child_error), /interrupt service down/);
  assert.equal(r.child_interrupted, undefined);
});

test("g-388 ④REST 入口：spawn 成功但 bind 失败 ⇒ 同一套收敛（中断 + child_id 保留）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g388-"));
  const hooks: { onSpawn?: () => void } = {};
  const m = mkSubagents({ onSpawn: () => hooks.onSpawn?.() });
  const host = applyHost(ws, m.svc);
  const goal = createGoal(host.root, { title: "g388 目标", version: "v-t", actor: "test" });
  const card = createSharedCard(host.root, { title: "共享收集卡", actor: "test" });
  addSharedCardRef(host.root, goal, card, "test");
  hooks.onSpawn = raceHook(host.root, goal, card);

  const r = await post(host.routes, "/api/dsh-graph/start-collection", { goal, card, workspace: ws });
  assert.equal(r._code, 200);
  assert.equal(r._body.child_id, "child-1", "REST 也必须保留 child_id，而不是丢掉");
  assert.match(String(r._body.child_error), /绑定失败/);
  assert.match(String(r._body.child_error), /已请求中断/);
  assert.equal(m.interruptCalls.length, 1);
  assert.deepEqual(m.interruptCalls[0].slice(0, 2), ["child-1", "sess-g388"]);
});

// ---------------------------------------------------------------- ⑥ 核心层同源

test("g-388 ⑥核心层：assertCollectAdmission 与 bindCardChild 拒绝条件/文案同源", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g388-core-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "g388", version: "v-t", actor: "test" });
  const shared = createSharedCard(root, { title: "共享卡", actor: "test" });
  addSharedCardRef(root, goal, shared, "test");
  const owned = addCard(root, goal, { title: "自有卡", scope: "goal", actor: "test" });

  // 共享卡 collecting → 准入拒绝，且与 bindCardChild 的文案逐字一致
  bindCardChild(root, goal, shared, { childId: "child-a", actor: "test" });
  let bindMsg = "";
  try { bindCardChild(root, goal, shared, { childId: "child-b", actor: "test" }); } catch (e: any) { bindMsg = e.message; }
  let admissionMsg = "";
  try { assertCollectAdmission(root, goal, shared); } catch (e: any) { admissionMsg = e.message; }
  assert.ok(bindMsg.includes("不能并行收集"));
  assert.equal(admissionMsg, bindMsg, "两处文案必须逐字一致（同因同话）");
  assert.match(admissionMsg, /child-a/);

  // 未 collecting / 自有卡：准入放行（自有卡沿用 g-119 换 child 重收语义，不被新门禁改变）
  assertCollectAdmission(root, goal, owned);
  bindCardChild(root, goal, owned, { childId: "oc-1", actor: "test" });
  assertCollectAdmission(root, goal, owned); // 自有卡 collecting 也不拦（与 bindCardChild 同源）
  bindCardChild(root, goal, owned, { childId: "oc-2", actor: "test" }); // 换 child 仍正常写
});

// ---------------------------------------------------------------- ⑦ 负向对照（源序守卫）

test("g-388 ⑦负向对照：两入口均为「先准入后 spawn」，收集路径不得回退成直连 bindCardChild", () => {
  // 工具入口：准入必须早于派发（g-469 起派发统一经 startSubagentCompat 收口）；绑定必须走收敛 helper
  const toolBranch = HOST_SRC.slice(
    HOST_SRC.indexOf("if (a.card !== undefined && a.card !== null) {"),
    HOST_SRC.indexOf("const ws = sessionWorkspace(ex) ?? dirname(r)"),
  );
  assert.ok(toolBranch.length > 0, "工具入口收集分支应可见");
  assert.ok(toolBranch.includes("collectAdmissionBlock(r, a.goal, a.card)"), "工具入口必须有 spawn 前准入");
  assert.ok(
    toolBranch.indexOf("collectAdmissionBlock(r, a.goal, a.card)") < toolBranch.indexOf("startSubagentCompat(subagents, {"),
    "准入必须早于派发（否则先启动 child 再被拒 = 孤儿 worker）",
  );
  assert.ok(toolBranch.includes("bindCollectWithConvergence(r, a.goal, a.card"), "工具入口绑定必须走共用收敛 helper");
  assert.ok(!/bindCardChild\(r, a\.goal, a\.card/.test(toolBranch), "收集分支不得回退成直连 bindCardChild");

  // REST 入口：同样先准入、绑定走 helper
  const restBranch = HOST_SRC.slice(
    HOST_SRC.indexOf('path: "/api/dsh-graph/start-collection"'),
    HOST_SRC.indexOf('path: "/api/dsh-graph/define-polish"'),
  );
  assert.ok(restBranch.includes("collectAdmissionBlock(rRoot, goal, card)"), "REST 入口必须有 spawn 前准入");
  assert.ok(
    restBranch.indexOf("collectAdmissionBlock(rRoot, goal, card)") < restBranch.indexOf("spawnChild("),
    "REST 准入必须早于 spawnChild",
  );
  assert.ok(restBranch.includes("bindCollectWithConvergence(rRoot, goal, card"), "REST 绑定必须走共用收敛 helper");
  assert.ok(!/bindCardChild\(rRoot, goal, card/.test(restBranch), "REST 收集分支不得回退成直连 bindCardChild");

  // 收敛策略必须"如实上报"，不得只写"已停止"
  const convStart = HOST_SRC.indexOf("const bindCollectWithConvergence =");
  const convEnd = HOST_SRC.indexOf("// 枚举派发选项（重新执行选择器用）");
  const convSrc = HOST_SRC.slice(convStart, convEnd > convStart ? convEnd : convStart + 3000);
  assert.ok(convSrc.includes("interruptByParent"), "收敛策略必须请求中断");
  assert.ok(convSrc.includes("无法中断该 child"), "中断能力缺失必须如实上报");
  assert.ok(convSrc.includes("中断该 child 失败"), "中断失败必须如实上报");
  assert.ok(convSrc.includes("child_id: childId"), "收敛结果必须保留 child_id");
});
