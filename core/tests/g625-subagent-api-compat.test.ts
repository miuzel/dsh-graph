/**
 * g-625 / g-627：DSH `subagent`/`agent` 管理 API 收口回归（g-627 收窄后只剩 rc.3+ 单版本口径）。
 *
 * rc.3 自带升级指南（`docs/upgrade-guide/`）删除：
 *   1. `subagents.interruptByParent(child, parent, 'continuable')` → `subagents.interrupt(target, authority)`，
 *      authority=`{kind:"ancestor", agent}`（插件持有派发时的确切父 Agent）或 `{kind:"user"}`；
 *      `interruptByUser(child)` 只是 **Remote face**，不得冒充本地收敛；
 *   2. `subagents.listChildren(parent)` → `sessionQuery.observeSession(parent).projections.values.subagentCatalog`；
 *   3. `agents.isOwnedBy(id, owner)` → `subagents.rootOf(agent)`（比较 **Agent 对象**）+ `session.header.parentSession`。
 *
 * **g-627 收窄**：宿主下限提高后，rc.1（`0.2.2-rc.1`）专用分支（旧 API 优先）已全部删除，
 * 因此本文件不再断言「旧名优先」；改为断言「旧名即使还在也不得被调用」。
 *
 * 断言面：
 *  A. 归属探测：仅 `rootOf`；同树 + parentSession 直系 = yes / 跨树 = no / 缺父会话 = unknown /
 *     `rootOf` 抛 UNAUTHORIZED ⇒ `requireLiveTree` 下 unknown；缺 API ⇒ unknown（fail-closed）；
 *  B. 子级目录：catalog 投影；**缺投影 ⇒ unavailable（不是「无 child」）**；观察必须释放；
 *     旧 `listChildren` 即使存在也不得被调用；
 *  C. 中断：`interrupt` ancestor authority；缺确切父 Agent 不退回 user 语义；UNAUTHORIZED ⇒ 未中断；
 *     能力缺失 ⇒ 如实「无法中断」；结构守卫禁止调用 Remote face `interruptByUser`；
 *  D. 结构守卫：收口 helper 之外不得出现这三个宿主方法名，调用面计数锁死；
 *  E. 真机路径（宿主桩）：派发失败时 catalog present/absent/missing 三态对 dispatch_in_flight 的影响；
 *     复用准入（g-613）同树放行 / 跨树拒绝 / rootOf 抛错 ⇒ 不可确认 fail-closed；
 *  F. 反向变异：倒置 authority / 倒置签名必须被严格夹具拒绝（证明判据本身有效）。
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
// A. 归属探测（只认 subagents.rootOf + parentSession）
// ============================================================================

type Verdict = "yes" | "no" | "unknown";

function agentObj(id: string, parentSession?: string): any {
  return { id, session: { id, header: { ...(parentSession === undefined ? {} : { parentSession }) } } };
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

/** `agents` **没有** `isOwnedBy`，只有 `subagents.rootOf`（对象身份比较）。 */
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

test("g-627 A① 旧归属 API isOwnedBy 即使还在位也不得被调用（收窄后只认 rootOf）", () => {
  const owner = agentObj("sup-1");
  const child = agentObj("child-1", "sup-1");
  const isOwnedByCalls: any[] = [];
  const agents = {
    get: (id: string) => ([owner, child].find((a) => a.id === id)),
    list: () => [owner, child],
    isOwnedBy: (id: string, o: any) => { isOwnedByCalls.push([id, o]); return true; },
  };
  const subagents = { rootOf: (a: any) => owner };
  const probe = ownershipProbeOf(agents as any, subagents as any);
  assert.equal(probe.mode, "rootOf", "归属判定只走 rootOf");
  assert.equal(probe.supported, true);
  assert.equal(probe.reason, null);
  assert.equal(probe.ownsId("child-1", owner), "yes");
  assert.equal(probe.ownsAgent(child, owner), "yes");
  assert.deepEqual(isOwnedByCalls, [], "旧 API 已不在支持面内，绝不得被调用");
});

test("g-627 A② rootOf 抛错 ⇒ unknown（requireLiveTree）/ parentSession 回退（默认，见 g-626）", () => {
  const owner = agentObj("sup-1");
  const child = agentObj("child-1", "sup-1");
  const subagents = { rootOf: () => { throw UNAUTHORIZED; } };
  const agents = { get: () => child, list: () => [child] };
  assert.equal(ownershipProbeOf(agents as any, subagents as any, { requireLiveTree: true }).ownsId("child-1", owner), "unknown");
  // 默认（无 requireLiveTree）走 g-626 的 parentSession 回退：历史创建者 === 主管 ⇒ yes
  assert.equal(ownershipProbeOf(agents as any, subagents as any).ownsId("child-1", owner), "yes");
});

test("g-625 A③ 同树 + parentSession 直系判 yes；跨树判 no", () => {
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

test("g-625 A④rootOf 抛 UNAUTHORIZED + requireLiveTree ⇒ unknown，绝不当「无归属」", () => {
  const fx = rc3Ownership();
  const probe = ownershipProbeOf(fx.agents, fx.subagents, { requireLiveTree: true });
  assert.equal(probe.ownsAgent(fx.unmanaged, fx.owner), "unknown", "rootOf 抛错只能判不可确认");
  assert.equal(probe.ownsId("child-3", fx.owner), "unknown");
});

test("g-625 A⑤ 同树但 parentSession 缺失/指他人 ⇒ unknown / no（判据是「本主管直接创建」）", () => {
  const fx = rc3Ownership();
  const probe = ownershipProbeOf(fx.agents, fx.subagents);
  assert.equal(probe.ownsAgent(fx.noParent, fx.owner), "unknown", "读不到直接创建者 ⇒ 不臆断");
  assert.equal(probe.ownsAgent(fx.sameTreeOtherParent, fx.owner), "no", "同树但非本主管直接创建 ⇒ no");
});

test("g-625 A⑥ rootOf 不可用 ⇒ 无 rootOf 的归属裁决一律 unknown（fail-closed），supported 语义不变", () => {
  // g-627：`supported` 是「本 profile 是否具备子级枚举/归属探测能力」的总开关，仍由
  // `agents.list + get`（枚举）或 `rootOf` 判定；而**归属裁决**永远需要 rootOf 这唯一的 live 树证据。
  const probe = ownershipProbeOf({ get: () => null, list: () => [] }, {});
  assert.equal(probe.supported, true, "枚举能力在 ⇒ 总开关为真（否则精简/headless 部署会整块降级）");
  assert.equal(probe.mode, "unavailable");
  assert.match(String(probe.reason), /缺归属 API/);
  // g-627：没有 rootOf 就没有 live 树证据 —— 连「查不到 child」也只算 unknown
  // （这条比基线 isOwnedBy=false 更严：宁可无法确认，也不给无证据的否定结论）。
  assert.equal(probe.ownsId("child-1", agentObj("sup")), "unknown");
  // child 的创建者头缺失/不符 ⇒ 无法确认 ⇒ unknown（绝不靠 header 空缺冒充 yes）
  assert.equal(probe.ownsAgent(agentObj("c"), agentObj("sup")), "unknown");
  // 授权类调用方（requireLiveTree）同样 unknown —— 绝不因「lack rootOf」放行
  const strict = ownershipProbeOf({ get: () => null, list: () => [] }, {}, { requireLiveTree: true });
  assert.equal(strict.ownsId("child-1", agentObj("sup")), "unknown");
  assert.equal(strict.ownsAgent(agentObj("c", "sup"), agentObj("sup")), "unknown");
  const undef = ownershipProbeOf(undefined, undefined);
  assert.equal(undef.supported, false);
  assert.equal(undef.ownsId("x", agentObj("sup")), "unknown");
});

// ============================================================================
// B. 子级目录（sessionQuery.subagentCatalog）
// ============================================================================

const CATALOG_ROWS = [
  { id: "child-a", label: "graph:g-1/att-001", mode: "continuable" },
  { id: "child-b", label: "graph:g-2/att-001", mode: "one-shot" },
];

/** 只提供 observeSession + catalog 投影；记录观察/释放次数。 */
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

test("g-627 B① 旧服务方法 listChildren 即使还在位也不得被调用（只走 catalog 投影）", async () => {
  const listCalls: any[] = [];
  const subagents = { listChildren: async (parentSessionId: string) => { listCalls.push(parentSessionId); return CATALOG_ROWS; } };
  const fx = rc3Catalog(CATALOG_ROWS);
  const out = await readChildCatalogCompat({ subagents, sessionQuery: fx.sessionQuery }, "sess-parent");
  assert.equal(out.ok, true);
  assert.equal(out.mode, "subagentCatalog");
  assert.deepEqual(out.rows, CATALOG_ROWS);
  assert.deepEqual(listCalls, [], "旧服务方法已不在支持面内，绝不得被调用");
});

test("g-625 B② 走 observeSession 读 subagentCatalog，并**释放观察**", async () => {
  const fx = rc3Catalog(CATALOG_ROWS);
  const sig = new AbortController().signal;
  const out = await readChildCatalogCompat({ subagents: fx.subagents, sessionQuery: fx.sessionQuery }, "sess-parent", { signal: sig });
  assert.equal(out.ok, true);
  assert.equal(out.mode, "subagentCatalog");
  assert.deepEqual(out.rows, CATALOG_ROWS);
  assert.equal(fx.state.observes, 1);
  assert.equal(fx.state.disposals, 1, "观察对象必须恰释放一次");
});

test("g-625 B③ 缺 catalog 投影 ⇒ ok:false（不可用），**绝不是**「无 child」", async () => {
  const fx = rc3Catalog(null);
  const out = await readChildCatalogCompat({ subagents: fx.subagents, sessionQuery: fx.sessionQuery }, "sess-parent");
  assert.equal(out.ok, false, "缺投影必须判不可用");
  assert.equal(out.reason, "catalog_projection_unavailable");
  assert.deepEqual(out.rows, []);
  assert.equal(fx.state.disposals, 1, "即使缺投影，观察对象也必须释放");
});

test("g-625 B④ 空目录 ≠ 不可用：[] 是 ok:true 的真「无 child」", async () => {
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

test("g-627 B⑥ 旧方法抛错 + sessionQuery 不可用 ⇒ ok:false + session_query_unavailable（不得当空目录）", async () => {
  const subagents = { listChildren: async () => { throw new Error("catalog down"); } };
  const out = await readChildCatalogCompat({ subagents }, "sess-parent");
  assert.equal(out.ok, false, "读不到只能按 unknown 处理");
  assert.equal(out.reason, "session_query_unavailable");
  assert.deepEqual(out.rows, []);
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
// C. 中断（interrupt + ancestor authority）
// ============================================================================

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

test("g-627 C① 旧方法 interruptByParent 即使还在位也不得被调用（只走 ancestor authority）", () => {
  const oldCalls: any[][] = [];
  const newCalls: any[][] = [];
  const subagents = {
    interruptByParent: (...args: any[]) => { oldCalls.push(args); },
    interrupt: (...args: any[]) => { newCalls.push(args); },
  };
  const parentAgent = { id: "a1", session: { id: "sess-exec" } };
  const out = interruptChildCompat({ subagents }, { childId: "c-1", parentSessionId: "p-1", parentAgent });
  assert.equal(out.requested, true);
  assert.equal(out.mode, "interrupt");
  assert.deepEqual(oldCalls, [], "旧三参方法已不在支持面内，绝不得被调用");
  assert.equal(newCalls.length, 1);
});

test("g-625 C② interrupt(child, {kind:'ancestor', agent})：按确切父 Agent 的祖先身份中断", () => {
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

test("g-627 C③ 缺确切父 Agent（即便有 parent session）⇒ 如实「无法中断」，不退回 user 语义", () => {
  const fx = rc3Interrupt();
  const out = interruptChildCompat({ subagents: fx.subagents }, { childId: "c-1", parentSessionId: "p-1" });
  assert.equal(out.requested, false);
  assert.equal(out.mode, "interrupt");
  assert.match(out.note, /缺少确切 live 父 Agent/);
  assert.deepEqual(fx.calls, []);
  assert.deepEqual(fx.remoteCalls, []);
});

test("g-625 C④ 无中断能力 ⇒ requested=false + 可读「无法中断」，绝不虚称已停止", () => {
  const out = interruptChildCompat({ subagents: {} }, { childId: "c-1", parentSessionId: "p-1", parentAgent: { id: "a1" } });
  assert.equal(out.requested, false);
  assert.equal(out.mode, "unavailable");
  assert.match(out.note, /无法中断该 child/);
  assert.match(out.note, /subagents\.interrupt/);
  const noChild = interruptChildCompat({ subagents: {} }, {});
  assert.equal(noChild.requested, false);
  assert.match(noChild.note, /缺少 child id/);
});

test("g-625 C⑤ 中断抛错（含 authority 不拥有目标 UNAUTHORIZED）⇒ 如实「未中断/不可确认」", () => {
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

test("g-625 C⑥ 无 interrupt 能力 ⇒ 直接 fail-closed（不静态抛错、不虚报）", () => {
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
  // g-627：旧 API 名一律**不得出现**在可执行代码里（含 helper 内），只允许 rootOf / interrupt /
  // catalog 投影。调用面计数同时锁死「只在收口 helper 内、且只出现一次」。
  for (const [name, regex] of [
    ["agents.isOwnedBy(", /agents\.isOwnedBy\s*\(/g],
    ["subagents.listChildren(", /subagents\.listChildren\s*\(/g],
    ["subagents.interruptByParent(", /subagents\.interruptByParent\s*\(/g],
  ] as const) {
    const hits = [...code.matchAll(regex)];
    if (hits.length !== 0) {
      const line = code.slice(0, hits[0].index!).split("\n").length;
      problems.push(`${label}：旧宿主 API ${name} 已下线，不得再被调用（第 ${line} 行）`);
    }
  }
  if (assertInside("subagents.rootOf(", /subagents\.rootOf\s*\(/g, helpers.owns) !== 2) {
    problems.push(`${label}：ownership helper 内的 rootOf 调用应恰为 2 处（对象身份比较）`);
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
  // 注：本目录的复用准入仍按**默认（非 requireLiveTree）**探针判定；另一路 g-628 的
  // 「陈旧实例即便历史父关系相等也不得放行」另行钉住（见 g628-resumed-care-effects）。
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

test("g-627 F① 反向变异：「rootOf 抛错即放行」的退化实现必须被同一判据判红（判据有效）", () => {
  const owner = agentObj("sup-1");
  const stale = agentObj("child-stale", "someone-else");
  const subagents = { rootOf: () => { throw UNAUTHORIZED; } };
  const agents = { get: () => stale, list: () => [stale] };
  // 正确实现：requireLiveTree 下 rootOf 抛错 ⇒ unknown（绝不放行）
  assert.equal(ownershipProbeOf(agents as any, subagents as any, { requireLiveTree: true }).ownsId("child-stale", owner), "unknown");
  // 退化的「抛错即 yes」实现在同一夹具上会给出 yes ⇒ 二者可区分，说明本判据真的能捕获该变异
  const degraded = () => { try { subagents.rootOf(stale); } catch { return "yes"; } return "no"; };
  assert.equal(degraded(), "yes", "退化实现必须在本夹具上被区分为 yes（判据可捕获变异）");
});

test("g-627 F② 反向变异：无视 rootOf、只看 parentSession 的实现会被跨树夹具判红（判据有效）", async () => {
  const fx = rc3Catalog(CATALOG_ROWS);
  const parentOnly = async () => ({ ok: true, rows: [] });
  const wrong = await parentOnly();
  assert.deepEqual(wrong.rows, [], "不看 catalog 就会虚构「无 child」——正是缺投影必须判 unavailable 的理由");
  const denied = await readChildCatalogCompat({ sessionQuery: { observeSession: async () => ({}) } }, "p");
  assert.equal(denied.ok, false, "同一夹具下真实实现判 unavailable（二者可区分）");
  assert.equal((await readChildCatalogCompat({ sessionQuery: fx.sessionQuery }, "p")).ok, true);
});

test("g-625 F③ 反向变异：签名/authority 倒置会被严格夹具拒绝（三参旧签名 ↔ interrupt(ancestor)）", () => {
  const newFx = rc3Interrupt();
  const parentAgent = { id: "a1" };
  // 把旧的三参调用倒到 rc.3 的 interrupt 上必须抛错
  assert.throws(() => (newFx.subagents.interrupt as any)("c-1", "p-1", "continuable"), /必须是 2 參/,
    "把 rc.1 的三参调用倒到 rc.3 上必须抛错");
  // authority 用错（user 而非 ancestor）必须抛错
  assert.throws(() => (newFx.subagents.interrupt as any)("c-1", { kind: "user" }), /只接受 ancestor authority/);
  // Remote face 被调用即抛（插件不得走这条路）
  assert.throws(() => (newFx.subagents.interruptByUser as any)("c-1"), /不得使用 Remote face/);
  // 正确形态下成功（证明上面的抛错来自形态差异，而不是桩本身坏掉）
  assert.equal(interruptChildCompat({ subagents: newFx.subagents }, { childId: "c-1", parentAgent }).requested, true);
});
