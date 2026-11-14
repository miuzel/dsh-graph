/**
 * g-626：rc.3（0.2.2-rc.3）宿主上「关照整体不可用」的归属回退回归。
 *
 * 背景：rc.3 删除了 `agents.isOwnedBy`，归属收口 `ownershipProbeOf` 改走 `subagents.rootOf`。
 * 但 `rootOf` 对夹具/未管理/陈旧实例会抛 `SubagentError(UNAUTHORIZED)`（`ctx.agents.get(id) === caller`
 * 身份严格比对）。旧实现把「任一 rootOf 抛错」直接判 `unknown` ⇒ 该 child 被过滤 ⇒ `children_probe`
 * 不可用 ⇒ 关照不采样（g612 att008 A–H 全部超时「care task sampled」）。
 *
 * 断言面：
 *  A. 六组合矩阵：rootOf 成功/抛错 × parentSession 相等/不等/缺失 ⇒ yes/no/unknown，
 *     与 g-625 的 rootOf 成功口径（对象身份 + 直接创建者收紧）逐项一致；
 *  B. fail-closed 边界：UNAUTHORIZED 本身绝不放行；parentSession 不可读/owner 会话不可读 ⇒ unknown；
 *     `agents.get` 取不到 live Agent ⇒ `no`（既有语义，钉住）；
 *  C. 反向变异：「rootOf 抛错即 yes」的退化实现必须被同一判据判红（判据本身有效）；
 *  D. 结构守卫：rc.1 `agents.isOwnedBy` 路径与外部调用面未被本次回退改动（逐字保留旧分支）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ownershipProbeOf } from "../../dist/index.js";

const REPO = join(import.meta.dirname, "../..");
const HOST_SOURCE = join(REPO, "dsh-graph-host/index.js");
const DIST_SOURCE = join(REPO, "dist/index.js");

const UNAUTHORIZED = Object.assign(new Error("agent has no active runtime owner"), { code: "UNAUTHORIZED" });

/** 造一个 rc.3 形态的 Agent（`session.id` + 可选公开 `session.header.parentSession`）。 */
function agent(id: string, parentSession?: string | null | "unreadable"): any {
  const session: any = { id };
  if (parentSession === "unreadable") {
    Object.defineProperty(session, "header", { get() { throw new Error("header unreadable"); } });
  } else if (parentSession === undefined) {
    session.header = {};
  } else {
    session.header = parentSession === null ? {} : { parentSession };
  }
  return { id, session };
}

type Combo = {
  label: string;
  rootFails: boolean;
  parentSession?: string | null | "unreadable";
  sameTree?: boolean;
  expected: "yes" | "no" | "unknown";
};

/**
 * rc.3 归属夹具：`agents` **没有** `isOwnedBy`；`subagents.rootOf` 按组合返回同树/异树根或抛 UNAUTHORIZED。
 * Agent 对象身份稳定（rootOf 的比较口径就是对象身份）。
 */
function fixtureFor(combo: Combo) {
  const owner = agent("sup-1");
  const child = agent("child-1", combo.parentSession);
  const foreignRoot = agent("sup-other");
  const listCalls: any[] = [];
  const subagents = {
    rootOf: (a: any) => {
      listCalls.push(a);
      if (combo.rootFails) throw UNAUTHORIZED; // 含未管理/陈旧实例的官方 UNAUTHORIZED
      if (a === owner) return owner;
      return combo.sameTree === false ? foreignRoot : owner;
    },
  };
  const agents = {
    get: (id: string) => (String(id) === "sup-1" ? owner : String(id) === "child-1" ? child : null),
    list: () => [owner, child],
  };
  return { owner, child, agents, subagents, probe: ownershipProbeOf(agents, subagents) };
}

const MATRIX: Combo[] = [
  { label: "rootOf 成功 × parentSession 相等", rootFails: false, parentSession: "sup-1", expected: "yes" },
  { label: "rootOf 成功 × parentSession 不等", rootFails: false, parentSession: "sup-other", expected: "no" },
  { label: "rootOf 成功 × parentSession 缺失", rootFails: false, parentSession: undefined, expected: "unknown" },
  { label: "rootOf 抛错 × parentSession 相等", rootFails: true, parentSession: "sup-1", expected: "yes" },
  { label: "rootOf 抛错 × parentSession 不等", rootFails: true, parentSession: "sup-other", expected: "no" },
  { label: "rootOf 抛错 × parentSession 缺失", rootFails: true, parentSession: undefined, expected: "unknown" },
];

function verdictsOf(matrix: Combo[], evaluate: (fx: ReturnType<typeof fixtureFor>) => "yes" | "no" | "unknown") {
  return matrix.map((c) => evaluate(fixtureFor(c)));
}

// ============================================================================
// A. 六组合矩阵
// ============================================================================

test("g-626 A① 六组合（rootOf 成功/抛错 × parentSession 相等/不等/缺失）⇒ yes/no/unknown", () => {
  for (const combo of MATRIX) {
    const fx = fixtureFor(combo);
    assert.equal(fx.probe.mode, "rootOf", `${combo.label}：必须走 rc.3 新路径`);
    assert.equal(fx.probe.supported, true, `${combo.label}：rootOf 在位 ⇒ supported`);
    assert.equal(fx.probe.ownsAgent(fx.child, fx.owner), combo.expected, `${combo.label}：ownsAgent`);
    assert.equal(fx.probe.ownsId("child-1", fx.owner), combo.expected, `${combo.label}：ownsId`);
  }
});

test("g-626 A② rootOf 抛错但父会话是**直接创建者** ⇒ yes（rc.3 关照恢复的关键分支）", () => {
  const fx = fixtureFor({ label: "", rootFails: true, parentSession: "sup-1", expected: "yes" });
  assert.equal(fx.probe.ownsAgent(fx.child, fx.owner), "yes");
  assert.equal(fx.probe.ownsId("child-1", fx.owner), "yes");
  // 回退只在 rootOf 抛错时生效：抛错必然至少一次 rootOf 探测（不是绕过探测直接信 header）。
  assert.ok(fx.subagents.rootOf !== undefined);
});

test("g-626 A③ rootOf 成功时保持 g-625 口径：跨树即便 parentSession 相等也判 no", () => {
  const fx = fixtureFor({ label: "", rootFails: false, parentSession: "sup-1", sameTree: false, expected: "no" });
  assert.equal(fx.probe.ownsAgent(fx.child, fx.owner), "no", "对象身份判同树优先；不因 header 相等而放行");
});

test("g-626 A④ 孙级收紧不变：同树但 parentSession 指向他人 ⇒ no（rootOf 成功路径）", () => {
  const fx = fixtureFor({ label: "", rootFails: false, parentSession: "child-1", sameTree: true, expected: "no" });
  assert.equal(fx.probe.ownsAgent(fx.child, fx.owner), "no", "同树异父（孙级/兄弟）仍不得判 yes");
});

// ============================================================================
// B. fail-closed 边界
// ============================================================================

test("g-626 B① UNAUTHORIZED 本身绝不放行：父会话不等 ⇒ no，缺失 ⇒ unknown", () => {
  const diff = fixtureFor({ label: "", rootFails: true, parentSession: "sup-other", expected: "no" });
  assert.equal(diff.probe.ownsAgent(diff.child, diff.owner), "no", "跨主管仍拒绝");
  const missing = fixtureFor({ label: "", rootFails: true, parentSession: undefined, expected: "unknown" });
  assert.equal(missing.probe.ownsAgent(missing.child, missing.owner), "unknown", "无证据仍不可确认");
  const unreadable = fixtureFor({ label: "", rootFails: true, parentSession: "unreadable", expected: "unknown" });
  assert.equal(unreadable.probe.ownsAgent(unreadable.child, unreadable.owner), "unknown", "header 不可读 ⇒ unknown");
});

test("g-626 B② owner 会话 id 不可读 ⇒ unknown（不拿不可比的证据臆断）", () => {
  const fx = fixtureFor({ label: "", rootFails: true, parentSession: "sup-1", expected: "yes" });
  const ownerNoSession: any = { id: "", session: undefined };
  assert.equal(fx.probe.ownsAgent(fx.child, ownerNoSession), "unknown", "owner 无会话 id ⇒ 无法比对 ⇒ unknown");
});

test("g-626 B③ agents.get 取不到 live Agent ⇒ no（既有语义，钉住不被回退放大）", () => {
  const fx = fixtureFor({ label: "", rootFails: true, parentSession: "sup-1", expected: "yes" });
  assert.equal(fx.probe.ownsId("gone-child", fx.owner), "no", "不在 live registry ⇒ 可确定非 live 归属");
  const throwing = {
    get: () => { throw new Error("registry down"); },
    list: () => [],
  };
  const probe = ownershipProbeOf(throwing as any, fx.subagents);
  assert.equal(probe.ownsId("child-1", fx.owner), "unknown", "registry 出错 ⇒ 不可确认（不是 no）");
});

test("g-626 B④ 两版 API 皆无 ⇒ unavailable/unknown（不靠 header 冒充归属能力）", () => {
  const probe = ownershipProbeOf({ get: () => agent("child-1", "sup-1"), list: () => [] }, {});
  assert.equal(probe.supported, false);
  assert.equal(probe.mode, "unavailable");
  assert.equal(probe.ownsAgent(agent("child-1", "sup-1"), agent("sup-1")), "unknown");
});

// ============================================================================
// C. 反向变异：把回退写成「抛错即 yes」必须判红
// ============================================================================

/** 恶意/退化实现：rootOf 抛错就直接放行（正是 g-626 明令禁止的「UNAUTHORIZED 即 yes」）。 */
function unauthorizedMeansYes(childAgent: any, ownerAgent: any, subagents: any): "yes" | "no" | "unknown" {
  try { subagents.rootOf(ownerAgent); } catch { return "yes"; }
  try { subagents.rootOf(childAgent); } catch { return "yes"; }
  return "no";
}

test("g-626 C① 反向变异「rootOf 抛错即 yes」被同一六组合判据判红（判据有效）", () => {
  const expected = MATRIX.map((c) => c.expected);
  const real = verdictsOf(MATRIX, (fx) => fx.probe.ownsAgent(fx.child, fx.owner));
  const mutant = verdictsOf(MATRIX, (fx) => unauthorizedMeansYes(fx.child, fx.owner, fx.subagents));
  const assertMatrix = (label: string, verdicts: string[]) => {
    assert.deepEqual(verdicts, expected, `${label} 必须与六组合期望一致`);
  };
  assertMatrix("真实实现", real); // 正向：真实实现必须通过
  // 反向：退化实现必然偏离（抛错的三个组合全变 yes）⇒ 同一判据必须判红。
  assert.deepEqual(mutant, ["no", "no", "no", "yes", "yes", "yes"], "退化实现的实际结论");
  assert.throws(() => assertMatrix("退化实现", mutant), assert.AssertionError, "「抛错即 yes」必须被六组合判据判红");
  assert.notEqual(mutant[4], expected[4], "parentSession 不等的回退必须从 yes 纠正为 no");
  assert.notEqual(mutant[5], expected[5], "parentSession 缺失的回退必须从 yes 纠正为 unknown");
});

// ============================================================================
// D. 结构守卫：rc.1 isOwnedBy 路径逐字保持，回退只发生在 rootOf 分支
// ============================================================================

/** 去掉注释（保留字符串字面量与换行；长度与原文一一对应，下标可直接切片）。 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | "str" = "code";
  let quote = "";
  const push = (n: number) => { out += src.slice(i, i + n).replace(/[^\n]/g, " "); i += n; };
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (mode === "line") { if (c === "\n") { mode = "code"; out += "\n"; i++; } else push(1); continue; }
    if (mode === "block") { if (c === "*" && c2 === "/") { push(2); mode = "code"; } else push(1); continue; }
    if (mode === "str") {
      if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === quote) { mode = "code"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (c === "/" && c2 === "/") { push(2); mode = "line"; continue; }
    if (c === "/" && c2 === "*") { push(2); mode = "block"; continue; }
    if (c === '"' || c === "'" || c === "`") { mode = "str"; quote = c; out += c; i++; continue; }
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
    else if (code[i] === "}") { depth--; if (depth === 0) return { start, end: i + 1 }; }
  }
  throw new Error(`花括号无法配平：${header}`);
}

function fallbackProblems(file: string): string[] {
  const problems: string[] = [];
  const code = stripComments(readFileSync(file, "utf8"));
  const owns = functionRange(code, "export function ownershipProbeOf(");
  if (!owns) return [`${file}：缺少 ownershipProbeOf`];
  const ownsCode = code.slice(owns.start, owns.end);
  // rc.1 旧分支必须逐字保留（只增不减：不得删旧 API 调用、不得把它降级到 rootOf 之后）。
  const isOwnedByCalls = [...ownsCode.matchAll(/agents\.isOwnedBy\s*\(/g)].map((m) => m.index!);
  const rootOfCalls = [...ownsCode.matchAll(/subagents\.rootOf\s*\(/g)].map((m) => m.index!);
  const fallbackAt = ownsCode.indexOf("parentSessionOf");
  if (isOwnedByCalls.length !== 2) problems.push(`${file}：rc.1 isOwnedBy 调用面应恰为 2 处（实得 ${isOwnedByCalls.length}）`);
  if (rootOfCalls.length !== 2) problems.push(`${file}：rootOf 调用面应恰为 2 处（实得 ${rootOfCalls.length}）`);
  if (fallbackAt < 0) problems.push(`${file}：缺少 parentSession 证据 helper（g-626 回退）`);
  // 回退分支必须**同时**要求「ownerSid 可读」与「parentSid 可读」，且比较两者（不是无条件 yes）。
  if (!/if \(ownerSid === null \|\| parentSid === null\) return "unknown";/.test(ownsCode)) {
    problems.push(`${file}：回退分支缺少「证据缺失 ⇒ unknown」防线`);
  }
  if (!/return parentSid === ownerSid \? "yes" : "no";/.test(ownsCode)) {
    problems.push(`${file}：回退分支必须是 parentSession === ownerSession 比对，不得无条件放行`);
  }
  // 「抛错 ⇒ yes」这种退化绝不能出现。
  if (/catch\s*\{\s*return\s+"yes"/.test(ownsCode)) {
    problems.push(`${file}：rootOf 抛错后直接放行（UNAUTHORIZED 即 yes）是禁止的退化`);
  }
  return problems;
}

test("g-626 D① 结构守卫：rc.1 旧分支与 rootOf 探测面不变，回退含缺失防线", () => {
  const problems = fallbackProblems(HOST_SOURCE);
  assert.deepEqual(problems, [], problems.join("；"));
});

test("g-626 D② 结构守卫：dist/index.js 与源同形", () => {
  const problems = fallbackProblems(DIST_SOURCE);
  assert.deepEqual(problems, [], problems.join("；"));
  assert.equal(readFileSync(DIST_SOURCE, "utf8"), readFileSync(HOST_SOURCE, "utf8"),
    "dist/index.js 必须是 dsh-graph-host/index.js 的逐字节副本");
});
