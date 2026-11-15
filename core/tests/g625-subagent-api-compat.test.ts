/**
 * g-625：DSH 0.2.2-rc.3 删除的三个 subagent/agent 管理 API 的**双版本兼容**回归。
 *
 * rc.3 自带升级指南（`docs/upgrade-guide/`）删除：
 *   1. `subagents.interruptByParent(child, parent, 'continuable')`。rc.3 **本地**服务面是
 *      `subagents.interrupt(target, authority)`，authority=`{kind:"ancestor", agent}`（插件持有派发时的确切
 *      父 Agent）或 `{kind:"user"}`；`interruptByUser(child)` 只是 **Remote face**，不得冒充本地收敛；
 *   2. `subagents.listChildren(parent)` → `sessionQuery.observeSession(parent).projections.values.subagentCatalog`；
 *   3. `agents.isOwnedBy(id, owner)` → `subagents.rootOf(agent)`（比较 **Agent 对象**）+ `session.header.parentSession`。
 * rc.1（0.2.2-rc.1）**仍保留旧 API** ⇒ 必须双路径：旧 API 在位时行为与 v0.24.0 逐字一致，缺失才走新 API。
 *
 * 断言面：
 *  A. 归属探测：rc.1（有 isOwnedBy，即使同时挂着 rootOf 也必须走旧名）/ rc.3（仅 rootOf）/ 皆无；
 *     `rootOf` 抛 UNAUTHORIZED、缺 parentSession、跨树、同树异父 一律 `unknown`/`no`，绝不臆断；
 *  B. 子级目录：rc.1 服务方法 / rc.3 catalog 投影；**缺投影 ⇒ unavailable（不是「无 child」）**；
 *     观察对象必须释放；旧方法异常不得当空目录；
 *  C. 中断：rc.1 三参 / rc.3 `interrupt` ancestor authority；authority 不拥有目标（UNAUTHORIZED）⇒ 未中断；
 *     缺确切父 Agent 不退回 user 语义；两者皆无 ⇒ 如实「无法中断」；
 *  C+. 结构守卫同时禁止调用 Remote face `interruptByUser`；
 *  D. 结构守卫：三个宿主方法名只允许出现在各自 helper 内（收口）；
 *  E. 真机路径（宿主桩）：rc.3 派发失败时 catalog present/absent/missing 三态对 dispatch_in_flight 的影响；
 *     rc.3 复用准入（g-613）同树放行 / 跨树拒绝 / rootOf 抛错 ⇒ 不可确认 fail-closed；
 *  F. 反向变异：把「旧优先」倒成「新优先」/ 把签名倒置必须被严格夹具判红（证明判据本身有效）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGoal, setCriteria, findGoalFile, loadGoal } from "../ops.ts";
import { ownershipProbeOf, readChildCatalogCompat, interruptChildCompat } from "../../dist/index.js";
import { createHarnessWith, prepare } from "./_g374-harness.ts";

const REPO = join(import.meta.dirname, "../..");
const HOST_SOURCE = join(REPO, "dsh-graph-host/index.js");
const DIST_SOURCE = join(REPO, "dist/index.js");

const UNAUTHORIZED = Object.assign(new Error("agent has no active runtime owner"), { code: "UNAUTHORIZED" });

// ============================================================================
// A. 归属探测（rc.1 isOwnedBy / rc.3 rootOf）
// ============================================================================

type Verdict = "yes" | "no" | "unknown";

function agentObj(id: string, parentSession?: string): any {
  return { id, session: { id, header: { ...(parentSession === undefined ? {} : { parentSession }) } } };
}

/** rc.1 面：有 `agents.isOwnedBy`。故意**同时**挂一个会抛错的 rootOf（旧名必须优先）。 */
function rc1Ownership() {
  const owner = agentObj("sup-1");
  const child = agentObj("child-1", "sup-1");
  const foreign = agentObj("child-2", "sup-other");
  const rootOfCalls: any[] = [];
  const isOwnedByCalls: any[] = [];
  const agents = {
    get: (id: string) => ([owner, child, foreign].find((a) => a.id === id)),
    list: () => [owner, child, foreign],
    isOwnedBy: (id: string, o: any) => {
      isOwnedByCalls.push([id, o]);
      return id === "child-1" && o === owner;
    },
  };
  const subagents = {
    // rc.1 没有该方法；这里放一个「若被误用就暴露」的严格桩。
    rootOf: (a: any) => {
      rootOfCalls.push(a);
      throw UNAUTHORIZED;
    },
  };
  return { owner, child, foreign, agents, subagents, rootOfCalls, isOwnedByCalls };
}

interface TreeFixture {
  owner: any;
  otherRoot: any;
  direct: any;
  grandchildSameSession: any;
  foreign: any;
  unmanaged: any;
  noParent: any;
  agents: any;
  subagents: any;
  rootOfCalls: any[];
}

/** rc.3 面：`agents` **没有** `isOwnedBy`，只有 `subagents.rootOf`（对象身份比较）。 */
function rc3Ownership(): TreeFixture {
  const owner = agentObj("sup-1");
  const otherRoot = agentObj("sup-other");
  const direct = agentObj("child-1", "sup-1");
  const grandchildSameSession = agentObj("child-1b", "sup-1");
  const foreign = agentObj("child-2", "sup-other");
  const unmanaged = agentObj("child-3", "sup-1");
  const noParent = agentObj("child-4");
  const sameTreeOtherParent = agentObj("child-5", "someone-else");
  const byId: Record<string, any> = {
    "sup-1": owner, "sup-other": otherRoot, "child-1": direct, "child-1b": grandchildSameSession,
    "child-2": foreign, "child-3": unmanaged, "child-4": noParent, "child-5": sameTreeOtherParent,
  };
  const rootOfCalls: any[] = [];
  const agents = {
    get: (id: string) => byId[String(id)],
    list: () => Object.values(byId),
  };
  const subagents = {
    rootOf: (a: any) => {
      rootOfCalls.push(a);
      if (a === owner || a === otherRoot) return a; // 普通 live Agent ⇒ 自身即树根
      if (a === foreign) return otherRoot;          // 另一棵树
      if (a === unmanaged) throw UNAUTHORIZED;      // 未管理/陈旧实例
      if (a === direct || a === grandchildSameSession || a === noParent || a === sameTreeOtherParent) return owner;
      throw UNAUTHORIZED;
    },
  };
  return { owner, otherRoot, direct, grandchildSameSession, foreign, unmanaged, noParent, sameTreeOtherParent, agents, subagents, rootOfCalls };
}

test("g-625 A① rc.1（有 isOwnedBy，且 rootOf 也在位）⇒ 必须走旧名，rootOf 一次都不许调", () => {
  const fx = rc1Ownership();
  const probe = ownershipProbeOf(fx.agents, fx.subagents);
  assert.equal(probe.mode, "isOwnedBy", "有旧 API 必须以旧名为准（v0.24.0 行为逐字不变）");
  assert.equal(probe.supported, true);
  assert.equal(probe.reason, null);
  assert.equal(probe.ownsId("child-1", fx.owner), "yes");
  assert.equal(probe.ownsId("child-2", fx.owner), "no");
  assert.equal(probe.ownsId("gone-child", fx.owner), "no", "live registry 无该 id ⇒ no（与 rc.1 isOwnedBy 的 false 对齐）");
  assert.equal(probe.ownsAgent(fx.child, fx.owner), "yes");
  assert.deepEqual(fx.rootOfCalls, [], "旧 API 在位时绝不允许触碰新 API");
  assert.ok(fx.isOwnedByCalls.length >= 4);
});

test("g-625 A② rc.1 isOwnedBy 抛错 ⇒ unknown（不可确认，不得当无归属）", () => {
  const fx = rc1Ownership();
  const agents = { ...fx.agents, isOwnedBy: () => { throw new Error("registry down"); } };
  const probe = ownershipProbeOf(agents as any, null);
  assert.equal(probe.ownsId("child-1", fx.owner), "unknown");
});

test("g-625 A③ rc.3（仅 rootOf）⇒ 同树 + parentSession 直系判 yes；跨树判 no", () => {
  const fx = rc3Ownership();
  const probe = ownershipProbeOf(fx.agents, fx.subagents);
  assert.equal(probe.mode, "rootOf");
  assert.equal(probe.supported, true);
  assert.equal(probe.ownsAgent(fx.direct, fx.owner), "yes", "同树 + 直接创建者 ⇒ yes");
  assert.equal(probe.ownsId("child-1", fx.owner), "yes");
  assert.equal(probe.ownsAgent(fx.foreign, fx.owner), "no", "另一棵树 ⇒ no（跨主管拒绝的判据）");
  assert.equal(probe.ownsId("child-2", fx.owner), "no");
  assert.equal(probe.ownsId("gone-child", fx.owner), "no", "不在 live registry ⇒ no");
});

test("g-625 A④ rc.3 复用准入 rootOf 抛 UNAUTHORIZED ⇒ unknown，绝不当「无归属」", () => {
  const fx = rc3Ownership();
  const probe = ownershipProbeOf(fx.agents, fx.subagents, { requireLiveTree: true });
  assert.equal(probe.ownsAgent(fx.unmanaged, fx.owner), "unknown", "rootOf 抛错只能判不可确认");
  assert.equal(probe.ownsId("child-3", fx.owner), "unknown");
});

test("g-625 A⑤ rc.3 同树但 parentSession 缺失/指他人 ⇒ unknown / no（rc.1 判据是「直接子级」）", () => {
  const fx = rc3Ownership();
  const probe = ownershipProbeOf(fx.agents, fx.subagents);
  assert.equal(probe.ownsAgent(fx.noParent, fx.owner), "unknown", "读不到直接创建者 ⇒ 不臆断");
  assert.equal(probe.ownsAgent(fx.sameTreeOtherParent, fx.owner), "no", "同树但非本主管直接创建 ⇒ no");
});

test("g-625 A⑥ 两者皆无 ⇒ supported=false + 可读 reason；所有判定 unknown（fail-closed）", () => {
  const probe = ownershipProbeOf({ get: () => null, list: () => [] }, {});
  assert.equal(probe.supported, false);
  assert.equal(probe.mode, "unavailable");
  assert.match(String(probe.reason), /缺归属 API/);
  assert.equal(probe.ownsId("child-1", agentObj("sup")), "unknown");
  assert.equal(probe.ownsAgent(agentObj("c", "sup"), agentObj("sup")), "unknown");
  const undef = ownershipProbeOf(undefined, undefined);
  assert.equal(undef.supported, false);
  assert.equal(undef.ownsId("x", agentObj("sup")), "unknown");
});

// ============================================================================
// B. 子级目录（rc.1 listChildren / rc.3 sessionQuery.subagentCatalog）
// ============================================================================

const CATALOG_ROWS = [
  { id: "child-a", label: "graph:g-1/att-001", mode: "continuable" },
  { id: "child-b", label: "graph:g-2/att-001", mode: "one-shot" },
];

/** rc.1：服务方法在位；sessionQuery 刻意做成「若被误用必抛」的严格桩。 */
function rc1Catalog() {
  const listCalls: any[] = [];
  const observeCalls: any[] = [];
  const subagents = {
    listChildren: async (parentSessionId: string) => {
      listCalls.push(parentSessionId);
      return CATALOG_ROWS;
    },
  };
  const sessionQuery = {
    observeSession: async () => {
      observeCalls.push("observe");
      throw new Error("rc.1 桩：不得走 sessionQuery");
    },
  };
  return { subagents, sessionQuery, listCalls, observeCalls };
}

/** rc.3：无 listChildren；只提供 observeSession + catalog 投影；记录释放次数。 */
function rc3Catalog(rows: any[] | null) {
  const state = { observes: 0, disposals: 0 };
  const sessionQuery = {
    observeSession: async (parentSessionId: string, options?: any) => {
      state.observes += 1;
      return {
        parentSessionId,
        options,
        ...(rows === null ? {} : { projections: { values: { subagentCatalog: rows } } }),
        [Symbol.dispose]() { state.disposals += 1; },
      };
    },
  };
  return { subagents: {}, sessionQuery, state };
}

test("g-625 B① rc.1 服务方法在位 ⇒ 走 listChildren，不触碰 sessionQuery", async () => {
  const fx = rc1Catalog();
  const out = await readChildCatalogCompat({ subagents: fx.subagents, sessionQuery: fx.sessionQuery }, "sess-parent");
  assert.equal(out.ok, true);
  assert.equal(out.mode, "listChildren");
  assert.deepEqual(out.rows, CATALOG_ROWS);
  assert.deepEqual(fx.listCalls, ["sess-parent"]);
  assert.deepEqual(fx.observeCalls, [], "旧方法在位时不得走新观察路径");
});

test("g-625 B② rc.3 走 observeSession 读 subagentCatalog，并**释放观察**", async () => {
  const fx = rc3Catalog(CATALOG_ROWS);
  const sig = new AbortController().signal;
  const out = await readChildCatalogCompat({ subagents: fx.subagents, sessionQuery: fx.sessionQuery }, "sess-parent", { signal: sig });
  assert.equal(out.ok, true);
  assert.equal(out.mode, "subagentCatalog");
  assert.deepEqual(out.rows, CATALOG_ROWS);
  assert.equal(fx.state.observes, 1);
  assert.equal(fx.state.disposals, 1, "观察对象必须恰释放一次");
});

test("g-625 B③ rc.3 缺 catalog 投影 ⇒ ok:false（不可用），**绝不是**「无 child」", async () => {
  const fx = rc3Catalog(null);
  const out = await readChildCatalogCompat({ subagents: fx.subagents, sessionQuery: fx.sessionQuery }, "sess-parent");
  assert.equal(out.ok, false, "缺投影必须判不可用");
  assert.equal(out.reason, "catalog_projection_unavailable");
  assert.deepEqual(out.rows, []);
  assert.equal(fx.state.disposals, 1, "即使缺投影，观察对象也必须释放");
});

test("g-625 B④ rc.3 空目录 ≠ 不可用：[] 是 ok:true 的真「无 child」", async () => {
  const fx = rc3Catalog([]);
  const out = await readChildCatalogCompat({ subagents: fx.subagents, sessionQuery: fx.sessionQuery }, "sess-parent");
  assert.equal(out.ok, true, "空数组是可判定的「没有 child」");
  assert.deepEqual(out.rows, []);
});

test("g-625 B⑤ observeSession 抛错 / 服务缺失 ⇒ ok:false + 可读 reason", async () => {
  const throwing = {
    observeSession: async () => { throw new Error("query boom"); },
  };
  const a = await readChildCatalogCompat({ subagents: {}, sessionQuery: throwing }, "sess-parent");
  assert.equal(a.ok, false);
  assert.equal(a.reason, "observe_session_error");
  assert.match(String(a.detail), /query boom/);
  const b = await readChildCatalogCompat({ subagents: {} }, "sess-parent");
  assert.equal(b.ok, false);
  assert.equal(b.reason, "session_query_unavailable");
  const c = await readChildCatalogCompat({ subagents: {}, sessionQuery: throwing }, null);
  assert.equal(c.ok, false);
  assert.equal(c.reason, "no_parent_session");
});

test("g-625 B⑥ rc.1 旧方法抛错 ⇒ ok:false（不得当空目录），且不回退新路径", async () => {
  const subagents = { listChildren: async () => { throw new Error("catalog down"); } };
  const sessionQuery = { observeSession: async () => { throw new Error("不得回退"); } };
  const out = await readChildCatalogCompat({ subagents, sessionQuery }, "sess-parent");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "listChildren_error");
});

test("g-625 B⑦ 释放抛错不影响读取结论（观察仍被尝试释放，结果照常返回）", async () => {
  const sessionQuery = {
    observeSession: async () => ({
      projections: { values: { subagentCatalog: CATALOG_ROWS } },
      [Symbol.dispose]() { throw new Error("dispose boom"); },
    }),
  };
  const out = await readChildCatalogCompat({ subagents: {}, sessionQuery }, "sess-parent");
  assert.equal(out.ok, true);
  assert.deepEqual(out.rows, CATALOG_ROWS);
});

// ============================================================================
// C. 中断（rc.1 interruptByParent / rc.3 interrupt(ancestor authority)）
// ============================================================================

/** rc.1：只认三参旧签名；多/少参数都抛（倒置调用会立刻红）。 */
function rc1Interrupt() {
  const calls: any[][] = [];
  const subagents = {
    interruptByParent: (...args: any[]) => {
      if (args.length !== 3) throw new Error(`rc.1 interruptByParent 必须是 3 參（实得 ${args.length}）`);
      calls.push(args);
      return { accepted: true };
    },
  };
  return { subagents, calls };
}

/**
 * rc.3：`interruptByParent` 已删；本地服务面是 `interrupt(target, authority)`，
 * authority 必须是 `{ kind: "ancestor", agent: <确切父 Agent> }`（严格桩：kind/agent 不对就抛）。
 * `interruptByUser` 是 Remote face：插件**不得**调用，桩被调用即抛（负向夹具）。
 */
function rc3Interrupt() {
  const calls: any[][] = [];
  const remoteCalls: any[][] = [];
  const subagents = {
    interrupt: (...args: any[]) => {
      if (args.length !== 2) throw new Error(`rc.3 interrupt 必须是 2 參（实得 ${args.length}）`);
      const authority = args[1];
      if (authority?.kind !== "ancestor" || !authority.agent) {
        throw new Error(`rc.3 interrupt 只接受 ancestor authority（实得 ${JSON.stringify(authority)}）`);
      }
      calls.push(args);
      return undefined;
    },
    interruptByUser: (...args: any[]) => {
      remoteCalls.push(args);
      throw new Error("插件不得使用 Remote face interruptByUser");
    },
  };
  return { subagents, calls, remoteCalls };
}

test("g-625 C① rc.1 ⇒ interruptByParent(child, parent, 'continuable') 逐字保持", () => {
  const fx = rc1Interrupt();
  const out = interruptChildCompat({ subagents: fx.subagents }, { childId: "c-1", parentSessionId: "p-1" });
  assert.deepEqual(out, { requested: true, mode: "interruptByParent", note: "已请求中断该 child" });
  assert.deepEqual(fx.calls, [["c-1", "p-1", "continuable"]]);
});

test("g-625 C② rc.3 ⇒ interrupt(child, {kind:'ancestor', agent})：按确切父 Agent 的祖先身份中断", () => {
  const fx = rc3Interrupt();
  const parentAgent = { id: "a1", session: { id: "sess-exec" } };
  const out = interruptChildCompat({ subagents: fx.subagents }, { childId: "c-1", parentSessionId: null, parentAgent });
  assert.deepEqual(out, { requested: true, mode: "interrupt", note: "已请求中断该 child" });
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.calls[0][0], "c-1");
  assert.equal(fx.calls[0][1].kind, "ancestor");
  assert.equal(fx.calls[0][1].agent, parentAgent, "authority 必须是派发时的**同一个** live 父 Agent 对象");
  assert.deepEqual(fx.remoteCalls, [], "绝不得用 Remote face interruptByUser 冒充本地收敛");
});

test("g-625 C③ 两版都在位 ⇒ 旧签名优先（v0.24.0 不变）；旧缺 parent 时**不**偷偷换新路径", () => {
  const oldCalls: any[][] = [];
  const newCalls: any[][] = [];
  const subagents = {
    interruptByParent: (...args: any[]) => { oldCalls.push(args); },
    interrupt: (...args: any[]) => { newCalls.push(args); },
  };
  const parentAgent = { id: "a1", session: { id: "sess-exec" } };
  const withParent = interruptChildCompat({ subagents }, { childId: "c-1", parentSessionId: "p-1", parentAgent });
  assert.equal(withParent.mode, "interruptByParent");
  assert.deepEqual(oldCalls, [["c-1", "p-1", "continuable"]]);
  assert.deepEqual(newCalls, []);
  // 旧路径缺 parent session：如实报「缺少 parent session」，不因新 API 在位而改变旧宿主行为。
  const withoutParent = interruptChildCompat({ subagents }, { childId: "c-2", parentAgent });
  assert.equal(withoutParent.requested, false);
  assert.equal(withoutParent.mode, "interruptByParent");
  assert.match(withoutParent.note, /缺少 parent session/);
  assert.deepEqual(newCalls, []);
});

test("g-625 C④ 两版皆无 ⇒ requested=false + 可读「无法中断」，绝不虚称已停止", () => {
  const out = interruptChildCompat({ subagents: {} }, { childId: "c-1", parentSessionId: "p-1", parentAgent: { id: "a1" } });
  assert.equal(out.requested, false);
  assert.equal(out.mode, "unavailable");
  assert.match(out.note, /无法中断该 child/);
  assert.match(out.note, /interruptByParent/);
  assert.match(out.note, /subagents\.interrupt/);
  const noChild = interruptChildCompat({ subagents: {} }, {});
  assert.equal(noChild.requested, false);
  assert.match(noChild.note, /缺少 child id/);
});

test("g-625 C⑤ 中断抛错（含 authority 不拥有目标 UNAUTHORIZED）⇒ 如实「未中断/不可确认」", () => {
  const oldOut = interruptChildCompat({ subagents: { interruptByParent: () => { throw new Error("old down"); } } }, { childId: "c", parentSessionId: "p" });
  assert.equal(oldOut.requested, false);
  assert.match(oldOut.note, /中断该 child 失败/);
  assert.match(oldOut.note, /old down/);
  // rc.3：authority 不拥有目标 ⇒ 宿主抛 SubagentError(UNAUTHORIZED)。
  const unauthorized = Object.assign(new Error("subagent is not a live descendant"), { code: "UNAUTHORIZED" });
  const denied = interruptChildCompat({ subagents: { interrupt: () => { throw unauthorized; } } }, { childId: "c", parentAgent: { id: "a1" } });
  assert.equal(denied.requested, false, "UNAUTHORIZED 只能判未中断，不得伪称已中断");
  assert.match(denied.note, /无法中断该 child/);
  assert.match(denied.note, /归属不可确认/);
  // 其它异常：如实带上原因
  const broken = interruptChildCompat({ subagents: { interrupt: () => { throw new Error("svc down"); } } }, { childId: "c", parentAgent: { id: "a1" } });
  assert.equal(broken.requested, false);
  assert.match(broken.note, /中断失败/);
  assert.match(broken.note, /svc down/);
});

test("g-625 C⑥ rc.3 缺确切父 Agent ⇒ 不退回 user 语义，直接 fail-closed", () => {
  const fx = rc3Interrupt();
  const out = interruptChildCompat({ subagents: fx.subagents }, { childId: "c-1", parentSessionId: "p-1" });
  assert.equal(out.requested, false);
  assert.equal(out.mode, "interrupt");
  assert.match(out.note, /缺少确切 live 父 Agent/);
  assert.deepEqual(fx.calls, [], "没有 authority 就不得中断");
  assert.deepEqual(fx.remoteCalls, [], "绝不退回 Remote face");
});

// ============================================================================
// D. 结构守卫：三个宿主方法名只允许出现在各自收口 helper 内
// ============================================================================

/** 去掉行注释/块注释与字符串字面量内容（保留换行；长度与原文一一对应，下标可直接切片）。 */
function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  type Frame = { depth: number };
  const tpl: Frame[] = [];
  let mode: "code" | "line" | "block" | "str" = "code";
  let quote = "";
  const push = (n: number) => { out += src.slice(i, i + n).replace(/[^\n]/g, " "); i += n; };
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (mode === "line") { if (c === "\n") { mode = "code"; out += "\n"; i++; } else push(1); continue; }
    if (mode === "block") { if (c === "*" && c2 === "/") { push(2); mode = "code"; } else push(1); continue; }
    if (mode === "str") {
      if (c === "\\") { push(2); continue; }
      if (c === quote) { mode = "code"; out += c; i++; continue; }
      if (quote === "`" && c === "$" && c2 === "{") { push(2); mode = "code"; tpl.push({ depth: 0 }); continue; }
      push(1); continue;
    }
    if (c === "/" && c2 === "/") { push(2); mode = "line"; continue; }
    if (c === "/" && c2 === "*") { push(2); mode = "block"; continue; }
    if (c === '"' || c === "'" || c === "`") { mode = "str"; quote = c; out += c; i++; continue; }
    if (tpl.length > 0 && c === "{") { tpl[tpl.length - 1].depth++; }
    if (tpl.length > 0 && c === "}") {
      // 模板插值结束的 `}` 不是代码（`${` 已被抹掉）；不抹掉它会制造一个悬空 `}`，
      // 让后面的花括号配平提前归零（本 helper 体内有多个模板插值）。
      if (tpl[tpl.length - 1].depth === 0) { tpl.pop(); mode = "str"; quote = "`"; push(1); continue; }
      tpl[tpl.length - 1].depth--;
    }
    out += c; i++;
  }
  return out;
}

function functionRange(code: string, header: string): { start: number; end: number } | null {
  const start = code.indexOf(header);
  if (start < 0) return null;
  let depth = 0;
  for (let i = code.indexOf("{", start); i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error(`花括号无法配平：${header}`);
}

function chokepointProblems(file: string): string[] {
  const problems: string[] = [];
  const code = codeOnly(readFileSync(file, "utf8"));
  const label = file.endsWith("dist/index.js") ? "dist/index.js" : "dsh-graph-host/index.js";
  const helpers = {
    owns: functionRange(code, "export function ownershipProbeOf("),
    catalog: functionRange(code, "export async function readChildCatalogCompat("),
    interrupt: functionRange(code, "export function interruptChildCompat("),
  };
  for (const [k, r] of Object.entries(helpers)) if (!r) problems.push(`${label}：缺少收口 helper ${k}`);
  const assertInside = (name: string, regex: RegExp, range: { start: number; end: number } | null) => {
    const hits = [...code.matchAll(regex)].map((m) => m.index!);
    if (hits.length === 0) problems.push(`${label}：未找到 ${name} 的调用面`);
    for (const idx of hits) {
      if (!range || !(idx >= range.start && idx < range.end)) {
        problems.push(`${label}：${name} 出现在 helper 之外（第 ${code.slice(0, idx).split("\n").length} 行）⇒ 绕过收口`);
      }
    }
    return hits.length;
  };
  if (assertInside("agents.isOwnedBy(", /agents\.isOwnedBy\s*\(/g, helpers.owns) !== 2) {
    problems.push(`${label}：ownership helper 内的 isOwnedBy 调用应恰为 2 处`);
  }
  if (assertInside("subagents.rootOf(", /subagents\.rootOf\s*\(/g, helpers.owns) !== 2) {
    problems.push(`${label}：ownership helper 内的 rootOf 调用应恰为 2 处（对象身份比较）`);
  }
  if (assertInside("subagents.listChildren(", /subagents\.listChildren\s*\(/g, helpers.catalog) !== 1) {
    problems.push(`${label}：catalog helper 内的 listChildren 调用应恰为 1 处`);
  }
  if (assertInside("subagents.interruptByParent(", /subagents\.interruptByParent\s*\(/g, helpers.interrupt) !== 1) {
    problems.push(`${label}：interrupt helper 内的 interruptByParent 调用应恰为 1 处`);
  }
  // rc.3 的 `interruptByUser` 只是 Remote face（user 语义）——插件不得用它冒充本地收敛。
  const remoteFaceCalls = [...code.matchAll(/subagents\.interruptByUser\s*\(/g)];
  if (remoteFaceCalls.length !== 0) {
    problems.push(`${label}：不得调用 Remote face subagents.interruptByUser（实得 ${remoteFaceCalls.length} 处）`);
  }
  if (assertInside("subagents.interrupt(", /subagents\.interrupt\s*\(/g, helpers.interrupt) !== 1) {
    problems.push(`${label}：interrupt helper 内的 interrupt( 调用应恰为 1 处`);
  }
  // 使用点登记：8 个功能面 + helper 自身
  const ownershipMentions = [...code.matchAll(/\bownershipProbeOf\s*\(/g)].length;
  if (ownershipMentions !== 9) {
    problems.push(`${label}：ownershipProbeOf 提及应恰为 9（1 声明 + 8 使用点），实得 ${ownershipMentions}`);
  }
  const interruptMentions = [...code.matchAll(/\binterruptChildCompat\s*\(/g)].length;
  if (interruptMentions !== 4) {
    problems.push(`${label}：interruptChildCompat 提及应恰为 4（1 声明 + 3 收敛点），实得 ${interruptMentions}`);
  }
  const catalogMentions = [...code.matchAll(/\breadChildCatalogCompat\s*\(/g)].length;
  if (catalogMentions !== 2) {
    problems.push(`${label}：readChildCatalogCompat 提及应恰为 2（1 声明 + 1 孤儿判定点），实得 ${catalogMentions}`);
  }
  return problems;
}

test("g-625 D① 结构守卫：三个被删 API 的调用面全部收口，无绕过 helper 的裸调用", () => {
  const problems = chokepointProblems(HOST_SOURCE);
  assert.deepEqual(problems, [], problems.join("；"));
});

test("g-625 D② 结构守卫：dist/index.js 与源逐字节同形（收口不因构建漂移）", () => {
  const problems = chokepointProblems(DIST_SOURCE);
  assert.deepEqual(problems, [], problems.join("；"));
  assert.equal(readFileSync(DIST_SOURCE, "utf8"), readFileSync(HOST_SOURCE, "utf8"),
    "dist/index.js 必须是 dsh-graph-host/index.js 的逐字节副本");
});

// ============================================================================
// E. 宿主桩真路径：rc.3 孤儿判定 + rc.3 复用准入（g-613）
// ============================================================================

/** `dispatch_in_flight` 的真源是 **attempt.md**（g-610），不是 goal.md。 */
function attemptMeta(h: { root: string }, goal: string, attempt: string): Record<string, any> {
  const attFile = join(dirname(findGoalFile(h.root, goal)), "attempts", attempt, "attempt.md");
  return loadGoal(attFile).meta as Record<string, any>;
}

test("g-625 E① rc.3 派发失败 + catalog 有匹配 label ⇒ 保留 dispatch_in_flight（不当孤儿回收）", async () => {
  let label: string | null = null;
  const h = createHarnessWith({
    dispatchApi: "activation",
    dispatchError: new Error("provider boom"),
    childCatalog: () => (label === null ? null : [{ id: "catalog-child-1", label, mode: "continuable" }]),
  });
  const { goal } = prepare(h, { title: "g-625 rc.3 孤儿判定 present" });
  label = `graph:${goal}/att-001`;
  const res = await h.call("graph_start_attempt", { goal, attempt_brief: "rc.3 boom", task_type: "fix" });
  assert.equal(res.child_id ?? null, null, "spawn 失败不得虚构 child_id");
  assert.equal(attemptMeta(h, goal, res.attempt).dispatch_in_flight, true, "catalog 里已有该 label ⇒ 无法证明无 child ⇒ 必须保留阻断");
  assert.equal(h.catalogState.observes, 1, "必须真实读取 catalog");
  assert.equal(h.catalogState.disposals, 1, "观察必须释放");
});

test("g-625 E② rc.3 派发失败 + catalog 确认无匹配 label ⇒ 结算 dispatch_in_flight（不误留阻断）", async () => {
  const h = createHarnessWith({
    dispatchApi: "activation",
    dispatchError: new Error("provider boom"),
    childCatalog: () => [{ id: "someone-else", label: "graph:other/att-001", mode: "continuable" }],
  });
  const { goal } = prepare(h, { title: "g-625 rc.3 孤儿判定 absent" });
  const res = await h.call("graph_start_attempt", { goal, attempt_brief: "rc.3 boom", task_type: "fix" });
  assert.equal(res.child_id ?? null, null);
  assert.notEqual(attemptMeta(h, goal, res.attempt).dispatch_in_flight, true, "确认无 child ⇒ 必须结算（否则目标永久卡死）");
  assert.equal(h.catalogState.observes, 1);
});

test("g-625 E③ rc.3 派发失败 + 缺 catalog 投影 ⇒ unavailable，必须按 unknown 保留阻断", async () => {
  const h = createHarnessWith({
    dispatchApi: "activation",
    dispatchError: new Error("provider boom"),
    childCatalog: () => null,
  });
  const { goal } = prepare(h, { title: "g-625 rc.3 孤儿判定 unknown" });
  const res = await h.call("graph_start_attempt", { goal, attempt_brief: "rc.3 boom", task_type: "fix" });
  assert.equal(attemptMeta(h, goal, res.attempt).dispatch_in_flight, true, "缺投影 ≠ 无 child：不得静默结算");
  assert.equal(h.catalogState.observes, 1);
  assert.equal(h.catalogState.disposals, 1);
});

// ── g-613 复用准入（rc.3 only rootOf） ──
const CHILD = "child-expert-1";

function rc3ReuseHarness(child: any) {
  return createHarnessWith({
    dispatchApi: "activation",
    ownershipApi: "rootOf",
    reuse: { childRegistry: { [CHILD]: child } },
  });
}

function reuseGoal(h: ReturnType<typeof createHarnessWith>) {
  const goal = createGoal(h.root, { title: "g-625 复用目标", version: "v1.0", type: "task", actor: "human:gui" });
  setCriteria(h.root, goal, ["判据"], "human:gui");
  return goal;
}

test("g-625 E④ rc.3 复用准入：rootOf 同树 + parentSession 直系 ⇒ 允许复用，投递一次", async () => {
  const h = rc3ReuseHarness({ status: "idle", ownedBy: ["a1"] });
  const goal = reuseGoal(h);
  const res = await h.call("graph_start_attempt", { goal, attempt_brief: "复用", task_type: "fix", child_id: CHILD });
  assert.equal(res.reused, true, "rc.3 下复用准入不得退化");
  assert.equal(res.child_id, CHILD);
  assert.equal(h.sentMessages.length, 1, "必须向被复用 child 投递一次");
});

test("g-625 E⑤ rc.3 复用准入：跨主管（另一棵树）⇒ 明确拒绝，零投递", async () => {
  const h = rc3ReuseHarness({ status: "idle", ownedBy: [] });
  const goal = reuseGoal(h);
  await assert.rejects(
    () => h.call("graph_start_attempt", { goal, attempt_brief: "跨主管", task_type: "fix", child_id: CHILD }),
    /不属于当前主管/,
  );
  assert.equal(h.sentMessages.length, 0);
});

test("g-625 E⑥ rc.3 rootOf 抛 UNAUTHORIZED（未管理/陈旧实例）⇒ 不可确认，复用 fail-closed", async () => {
  const h = rc3ReuseHarness({ status: "idle", unmanaged: true });
  const goal = reuseGoal(h);
  await assert.rejects(
    () => h.call("graph_start_attempt", { goal, attempt_brief: "未管理", task_type: "fix", child_id: CHILD }),
    /无法确认 child .* 是否属于当前主管/,
    "rootOf 抛错只能判「不可确认」并拒绝，绝不能当成「无归属」放行",
  );
  assert.equal(h.sentMessages.length, 0);
});

// ============================================================================
// F. 反向变异：倒置「旧优先」/倒置签名必须被严格夹具判红
// ============================================================================

test("g-625 F① 反向变异：把归属探测倒成「rootOf 优先」⇒ rc.1 夹具结果翻转（判据有效）", () => {
  const fx = rc1Ownership();
  const correct = ownershipProbeOf(fx.agents, fx.subagents);
  assert.equal(correct.ownsId("child-1", fx.owner), "yes");
  // 倒置实现：无视 isOwnedBy，直接走 rootOf ⇒ rc.1 的 rootOf 严格桩抛错 ⇒ unknown。
  const inverted = (childId: string) => {
    try {
      const child = fx.agents.get(childId);
      return fx.subagents.rootOf(child) === fx.subagents.rootOf(fx.owner) ? "yes" : "no";
    } catch { return "unknown"; }
  };
  assert.notEqual(inverted("child-1"), "yes", "倒置实现必须被 rc.1 严格桩判为 unknown（判据可捕获变异）");
});

test("g-625 F② 反向变异：把目录读取倒成「一律 sessionQuery」⇒ rc.1 夹具翻转（判据有效）", async () => {
  const fx = rc1Catalog();
  const correct = await readChildCatalogCompat({ subagents: fx.subagents, sessionQuery: fx.sessionQuery }, "p");
  assert.equal(correct.ok, true);
  const inverted = async () => {
    try {
      const obs = await fx.sessionQuery.observeSession();
      return { ok: true, rows: obs?.projections?.values?.subagentCatalog ?? [] };
    } catch { return { ok: false, rows: [] }; }
  };
  const wrong = await inverted();
  assert.equal(wrong.ok, false, "rc.1 上没有 sessionQuery ⇒ 倒置实现必然不可用（判据可捕获变异）");
});

test("g-625 F③ 反向变异：签名/authority 倒置会被严格夹具拒绝（旧三参 ↔ rc.3 interrupt(ancestor)）", () => {
  const oldFx = rc1Interrupt();
  assert.throws(() => (oldFx.subagents.interruptByParent as any)("c-1"), /必须是 3 參/,
    "把 rc.3 的调用形态倒到 rc.1 上必须抛错");
  const newFx = rc3Interrupt();
  const parentAgent = { id: "a1" };
  // 把旧的三参调用倒到 rc.3 的 interrupt 上必须抛错
  assert.throws(() => (newFx.subagents.interrupt as any)("c-1", "p-1", "continuable"), /必须是 2 參/,
    "把 rc.1 的三参调用倒到 rc.3 上必须抛错");
  // authority 用错（user 而非 ancestor）必须抛错
  assert.throws(() => (newFx.subagents.interrupt as any)("c-1", { kind: "user" }), /只接受 ancestor authority/);
  // Remote face 被调用即抛（插件不得走这条路）
  assert.throws(() => (newFx.subagents.interruptByUser as any)("c-1"), /不得使用 Remote face/);
  // 正确形态下两者都成功（证明上面的抛错来自形态差异，而不是桩本身坏掉）
  assert.equal(interruptChildCompat({ subagents: oldFx.subagents }, { childId: "c-1", parentSessionId: "p-1" }).requested, true);
  assert.equal(interruptChildCompat({ subagents: newFx.subagents }, { childId: "c-1", parentAgent }).requested, true);
});
