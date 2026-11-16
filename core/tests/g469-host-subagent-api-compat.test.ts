/**
 * g-469 / g-627：宿主 subagent **派发 API** 收口回归。
 *
 * 背景（真实现状）：DSH `0.2.1-alpha.2` 把 `startContinuable(spec)` 改名为 `startActivation(spec)`；
 * `0.2.2-rc.3` 又扁平化了 spec。插件 5 处派发点原先直连 `subagents.startContinuable(...)`
 * ⇒ 新宿主上「安装 + 启动可用、**派发完全不可用**」。修复要求在 `dsh-graph-host/index.js` 内建立
 * **唯一** helper `startSubagentCompat(subagents, spec)`，5 处调用点全部改走它。
 *
 * **g-627 收窄**：宿主下限提高后，`startContinuable` 回退分支已删除 ⇒ 本文件断言「只有一条路径：
 * `startActivation`；旧名即使还在位也不得被调用；缺失即 fail-closed」。
 *
 * 断言面：
 *  A. helper 单路径 + fail-closed（缺失即抛错、绝不虚构 childId、绝不静默回退旧名）；
 *  B. 返回契约：`childId` 可读；`parentSessionId` 缺失时按既有 `?? null` 兜底不崩；
 *  C. g-321 错误码映射（ACTIVATION_LIMIT_REACHED / subagent/delivery-unavailable）语义一致；
 *  D. **结构性守卫**：5 处派发点全部经 helper，`startContinuable(` 在代码里**零出现**；
 *  E. **真实宿主契约核对**：以真实 `@deepseek-ai/dsh-subagent` tarball 提取的夹具为证据 ——
 *     断言履约所需的字段/能力在真实实现中存在（夹具离线可读、不联网）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { subagentSpawnErrorText } from "../ops.ts";
import { startSubagentCompat } from "../../dist/index.js";
import { createHarnessWith, prepare } from "./_g374-harness.ts";

const REPO = join(import.meta.dirname, "../..");
const HOST_SOURCE = join(REPO, "dsh-graph-host/index.js");
const DIST_SOURCE = join(REPO, "dist/index.js");
const FIXTURE_DIR = join(import.meta.dirname, "fixtures");
const FIXTURE = join(FIXTURE_DIR, "g469-host-subagent-api.json");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ============================================================================
// A. helper 三分支 + 优先级
// ============================================================================

test("g-469 A① 派发 helper：走 startActivation，扁平 spec + 显式 delivery=parent", async () => {
  const parent = {};
  const payload = { provider: "spawn", label: "graph:g-1/att-01", parent, prompt: [], signal: new AbortController().signal };
  const seen: any[] = [];
  const receipt = { childId: "child-new-1", result: {}, dispose: () => {} };
  // 旧名刻意也在位（属性在、值为 undefined），并用 getter 记录**任何**读取：
  // g-627 收窄后 helper 连碰都不许碰它（若判据按「属性存在」选路径，这里会立刻暴露）。
  let legacyReads = 0;
  const svc: any = {
    startActivation: async (s: any) => { seen.push(["startActivation", s]); return receipt; },
  };
  Object.defineProperty(svc, "startContinuable", {
    get() { legacyReads += 1; return undefined; },
    enumerable: true,
  });
  const got = await startSubagentCompat(svc, payload);
  assert.deepEqual(seen.map((x) => x[0]), ["startActivation"], "必须走 startActivation，且不得触碰旧名");
  assert.equal(legacyReads, 0, "旧名属性绝不得被读取（回退路径已删除）");
  assert.deepEqual(seen[0][1], {
    provider: payload.provider, label: payload.label, parent, prompt: [], signal: payload.signal, delivery: "parent",
  }, "扁平形态：顶层 provider/label/parent/prompt/signal + delivery=parent，不得带 request 嵌套");
  assert.equal(got, receipt, "receipt 必须原样透出（childId 可读）");
});

test("g-627 A② 只有 startContinuable 的宿主（≤0.2.1-alpha.1，低于下限）⇒ fail-closed，绝不走旧名", async () => {
  const seen: any[] = [];
  const svc = { startContinuable: async (s: any) => { seen.push(s); return { childId: "child-old", messageId: "m-1" }; } };
  await assert.rejects(
    () => startSubagentCompat(svc, { provider: "spawn", label: "graph:collect/g-1/c-1", parent: {}, prompt: [] }),
    /缺少派发 API/,
  );
  assert.deepEqual(seen, [], "旧名 startContinuable 绝不得被调用（回退已删除）");
});

test("g-469 A③ 派发 helper：API 缺失时 fail-closed 明确报错（绝不静默回退/虚构 childId 冒充成功）", async () => {
  let returned: any = "SENTINEL-NOT-CALLED";
  try {
    returned = await startSubagentCompat({ list: () => ["spawn", "fork"] }, { provider: "spawn" });
  } catch (e: any) {
    assert.match(String(e?.message ?? e), /缺少派发 API/, "必须给出明确的「缺少派发 API」错误");
    assert.match(String(e?.message ?? e), /startActivation/, "错误须点名所需方法名（可操作）");
    assert.match(String(e?.message ?? e), /0\.2\.2-rc\.3/, "错误须点名最低支持宿主版本（可操作；下限为 rc.3）");
    assert.match(String(e?.message ?? e), /已注册 provider/, "错误须带已注册 provider 便于定位");
    // 既有 g-321 友好化对「未知名错误」逐字透传 ⇒ 不吞掉可追溯信息
    assert.match(subagentSpawnErrorText(e), /缺少派发 API/);
    return;
  }
  assert.fail(`两版 API 皆缺时必须抛错，而不是返回 ${JSON.stringify(returned)}（静默回退/虚构 childId）`);
});

test("g-469 A④ 派发 helper：服务缺失（undefined/null）同样 fail-closed，不得抛无信息错", async () => {
  for (const svc of [undefined, null]) {
    await assert.rejects(
      () => startSubagentCompat(svc as any, { provider: "spawn" }),
      /缺少派发 API/,
      `subagents=${svc} 时必须给出可操作错误`,
    );
  }
});

// ============================================================================
// B. 返回契约（childId / parentSessionId 兜底）+ host 端真派发
// ============================================================================

test("g-469 B① receipt 契约：childId 原样可读；缺 parentSessionId 时调用点的 ?? null 链不崩", async () => {
  // 真实宿主 receipt（夹具实测）：旧版 { childId, messageId }、新版 { childId, result, dispose }
  // —— **两版都没有 parentSessionId**，故调用点的 `parentSessionId ?? started.parentSessionId ?? null`
  //    兜底是必需契约，不是装饰。
  const svc = { startActivation: async () => ({ childId: "c-b1", result: {}, dispose: () => {} }) };
  const started: any = await startSubagentCompat(svc, { provider: "spawn" });
  assert.equal(started.childId, "c-b1");
  assert.equal(started.parentSessionId ?? null, null, "?? null 兜底不得抛");

  const src = readFileSync(HOST_SOURCE, "utf8");
  const uses = [...src.matchAll(/started\??\.parentSessionId/g)];
  assert.ok(uses.length >= 4, `应有 >=4 处读取 started.parentSessionId（实得 ${uses.length}）`);
  for (const m of uses) {
    // 兜底链可能有多级（`parentSessionId ?? started.parentSessionId ?? ex.agent?.session?.id ?? null`），
    // 但**每一级链都必须以 `?? null` 收尾**——否则缺失 parentSessionId 时会把 undefined 传下去。
    const lineTail = src.slice(m.index! + m[0].length).split("\n", 1)[0];
    assert.match(lineTail, /\?\?\s*null/, `每处 started.parentSessionId 的兜底链都必须以 ?? null 收尾（实得 ${JSON.stringify(lineTail.slice(0, 60))}）`);
  }
});

test("g-469 B② host 端（仅新 API）：graph_start_attempt 经新名派发并取得真实 child_id 绑定", async () => {
  const h = createHarnessWith({ dispatchApi: "activation" });
  const { goal } = prepare(h, { title: "g-469 新宿主派发" });
  const res = await h.call("graph_start_attempt", { goal, attempt_brief: "新宿主派发", task_type: "fix", worktree: false });
  assert.ok(res.child_id, `新宿主派发必须取得 child_id（实得 ${JSON.stringify(res.child_id)}，child_error=${res.child_error}）`);
  assert.equal(res.child_error ?? null, null, "不得上报派发错误");
  assert.deepEqual(h.capturedVia, ["startActivation"], "必须经新名派发");
  assert.match(String(h.capturedRequests[0]?.label ?? ""), /^graph:/, "label 语义逐字保持（graph:<goal>/<attempt>）");
  assert.ok(!("parentSessionId" in (h.capturedRequests[0] ?? {})), "spec 不得被 helper 增删字段");
});

test("g-627 B③ host 端（只有旧 API = 低于下限）：派发如实失败，绝不经旧名派发", async () => {
  const h = createHarnessWith({ dispatchApi: "legacy" });
  const { goal } = prepare(h, { title: "g-627 低于下限宿主" });
  const res = await h.call("graph_start_attempt", { goal, attempt_brief: "低版本宿主", task_type: "fix", worktree: false });
  assert.equal(res.child_id ?? null, null, "低版本宿主不得取得 child_id（不得虚构）");
  assert.match(String(res.child_error ?? ""), /缺少派发 API/, "必须如实上报「缺少派发 API」");
  assert.deepEqual(h.capturedVia, [], "绝不得经旧名 startContinuable 派发");
});

test("g-469 B④ host 端（无派发 API）：派发失败如实上报，绝不返回假 child_id", async () => {
  const h = createHarnessWith({ dispatchApi: "none" });
  const { goal } = prepare(h, { title: "g-469 无派发 API" });
  const res = await h.call("graph_start_attempt", { goal, attempt_brief: "无 API", task_type: "fix", worktree: false });
  assert.equal(res.child_id ?? null, null, "两版皆无时不得虚构 child_id");
  assert.match(String(res.child_error ?? ""), /缺少派发 API/, "必须如实上报「缺少派发 API」");
  assert.deepEqual(h.capturedVia, [], "不得调用任何派发方法");
});

// ============================================================================
// C. g-321 错误码映射：两条路径语义一致
// ============================================================================

const G321_CASES: Array<{ name: string; err: unknown; expect: RegExp }> = [
  {
    name: "ACTIVATION_LIMIT_REACHED",
    err: Object.assign(new Error("subagent limit reached (active child limit: 8)"), { code: "ACTIVATION_LIMIT_REACHED" }),
    expect: /子代理激活已达上限/,
  },
  {
    name: "subagent/delivery-unavailable",
    err: Object.assign(new Error("cold resume rejected"), { code: "subagent/delivery-unavailable" }),
    expect: /子代理消息暂时无法送达/,
  },
];

test("g-469 C① g-321 映射：error 原样透出（不得包装/吞掉 code）并给出友好化文案", async () => {
  assert.equal(G321_CASES.length, 2, "两族错误码都必须覆盖");
  for (const c of G321_CASES) {
    const svc = { startActivation: async () => { throw c.err; } };
    const via = await startSubagentCompat(svc, { provider: "spawn" }).then(() => null, (e) => e);
    assert.ok(via, `${c.name}：必须 reject`);
    assert.equal(via, c.err, "error 必须原样透出（不得包装/吞掉 code）");
    assert.match(subagentSpawnErrorText(via), c.expect, `${c.name}：必须给出友好化文案`);
  }
});

test("g-469 C② g-321 映射（host 端）：child_error 友好化且给出可操作动作", async () => {
  const err = Object.assign(new Error("subagent limit reached (active child limit: 8)"), { code: "ACTIVATION_LIMIT_REACHED" });
  const h = createHarnessWith({ dispatchApi: "activation", dispatchError: err });
  const { goal } = prepare(h, { title: "g-469 g321 activation" });
  const res = await h.call("graph_start_attempt", { goal, attempt_brief: "g321", task_type: "fix", worktree: false });
  assert.equal(res.child_id ?? null, null, "失败时不得给 child_id");
  assert.match(String(res.child_error ?? ""), /子代理激活已达上限/, "必须友好化 ACTIVATION_LIMIT_REACHED");
  assert.match(String(res.child_error ?? ""), /解绑|等待/, "必须给出可操作动作");
});

// ============================================================================
// D. 结构性守卫：唯一收口 + 无裸调用
// ============================================================================

/**
 * 去掉行注释 / 块注释与字符串字面量**内容**（替换为等长空白，保留换行）。
 * 长度与原文逐一对应 ⇒ 下标可直接用于源码切片。结构守卫只看**代码**：
 * 注释里提到的方法名不算调用（本文件与 index.js 的头注释都会提到这两个名字）。
 */
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
      if (tpl[tpl.length - 1].depth === 0) { tpl.pop(); mode = "str"; quote = "`"; }
      else tpl[tpl.length - 1].depth--;
    }
    out += c; i++;
  }
  return out;
}

/** 具名 function 声明体在 `codeOnly` 文本中的下标区间（花括号配平）；未找到返回 null。 */
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

/** 对单个文件断言「唯一收口」的全部不变式。返回该文件的裸调用清单供跨文件比对。 */
function dispatchChokepointViolations(file: string): string[] {
  const problems: string[] = [];
  const code = codeOnly(readFileSync(file, "utf8"));
  const label = file.endsWith("dist/index.js") ? "dist/index.js" : "dsh-graph-host/index.js";

  // ① helper 必须存在且是 async 导出
  const helper = functionRange(code, "export async function startSubagentCompat(subagents, spec)");
  if (!helper) problems.push(`${label}：未找到 exported helper startSubagentCompat(subagents, spec)`);

  // ② 5 处派发点必须全部经 helper（`await startSubagentCompat(subagents, `）
  const calls = [...code.matchAll(/await\s+startSubagentCompat\(\s*subagents\s*,/g)];
  if (calls.length !== 5) problems.push(`${label}：经 helper 的派发点应恰为 5 处，实得 ${calls.length}`);

  // ③ helper 总提及次数 = 1 处声明 + 5 处调用（多出的提及意味着有旁路分支）
  const mentions = [...code.matchAll(/\bstartSubagentCompat\s*\(/g)].length;
  if (mentions !== 6) problems.push(`${label}：startSubagentCompat 提及应恰为 6（1 声明 + 5 调用），实得 ${mentions}`);

  // ④ `startContinuable(` 必须**零出现**（g-627：旧名回退已删除）；`startActivation(` 只允许在 helper 内、恰 1 处
  const legacyCalls = [...code.matchAll(/\bstartContinuable\s*\(/g)];
  if (legacyCalls.length !== 0) {
    problems.push(`${label}：startContinuable( 已下线，不得再出现（实得 ${legacyCalls.length} 处）`);
  }
  const bare = [...code.matchAll(/\bstartActivation\s*\(/g)].map((m) => ({ name: m[1], index: m.index! }));
  if (bare.length !== 1) {
    problems.push(`${label}：startActivation 调用应恰为 1 处（在 helper 内），实得 ${bare.length}`);
  }
  for (const b of bare) {
    if (helper && !(b.index >= helper.start && b.index < helper.end)) {
      problems.push(`${label}：${b.name}( 出现在 helper 之外（第 ${code.slice(0, b.index).split("\n").length} 行）⇒ 绕过收口`);
    }
  }

  // ⑤ 对原始服务方法的**属性访问**合计恰 2 处（helper 内 1 处 typeof 探测 + 1 处调用）——
  //    任何调用点直连 `subagents.startActivation` 都会让计数漂移。
  const touches = [...code.matchAll(/subagents\.(startActivation|startContinuable)\b/g)].map((m) => ({ name: m[1], index: m.index! }));
  if (touches.length !== 2) {
    problems.push(`${label}：subagents.<方法> 访问应恰为 2 处（helper 内），实得 ${touches.length}：${touches.map((t) => t.name).join(",")}`);
  }
  for (const t of touches) {
    if (helper && !(t.index >= helper.start && t.index < helper.end)) {
      problems.push(`${label}：subagents.${t.name} 在 helper 之外被访问（第 ${code.slice(0, t.index).split("\n").length} 行）`);
    }
  }

  // ⑥ 单路径：只探测 startActivation；缺失必须显式抛错（fail-closed）
  if (helper) {
    const body = code.slice(helper.start, helper.end);
    if (body.indexOf("typeof subagents.startActivation") < 0) problems.push(`${label}：helper 必须探测 startActivation`);
    if (body.includes("startContinuable")) problems.push(`${label}：helper 不得再保留 startContinuable 回退`);
    if (!/throw new Error\(/.test(body)) problems.push(`${label}：helper 必须在 API 缺失时显式抛错（fail-closed）`);
    if (/return\s*\{?\s*childId/.test(body)) problems.push(`${label}：helper 不得虚构 childId（fail-closed 分支不允许返回 receipt）`);
  }

  // ⑦ childId 绑定面：5 处调用后都必须能读到 started.childId
  const childIdReads = [...code.matchAll(/started\.childId|started\?\.childId/g)].length;
  if (childIdReads < 5) problems.push(`${label}：started.childId 读取应 >=5 处（每处派发都要绑定 child），实得 ${childIdReads}`);

  return problems;
}

test("g-469 D① 结构守卫：五处派发点全部经唯一 helper，且无绕过收口的裸调用", () => {
  const problems = dispatchChokepointViolations(HOST_SOURCE);
  assert.deepEqual(problems, [], problems.join("；"));
});

test("g-469 D② 结构守卫：构建产物 dist/index.js 与源同形（派发收口不因构建丢失）", () => {
  const problems = dispatchChokepointViolations(DIST_SOURCE);
  assert.deepEqual(problems, [], problems.join("；"));
  assert.equal(
    readFileSync(DIST_SOURCE, "utf8"),
    readFileSync(HOST_SOURCE, "utf8"),
    "dist/index.js 必须是 dsh-graph-host/index.js 的逐字节副本（派发收口不得因构建而漂移）",
  );
});

// ============================================================================
// E. 真实宿主契约核对（夹具由真实 tarball 提取；离线可复跑）
// ============================================================================

/**
 * 冻结的 tarball 指纹：证据必须来自该份真实宿主包（换包时须显式更新本表并在提交说明里写清来源）。
 * g-627：宿主下限提高后，契约证据只保留**当前最低支持线** `0.2.2-rc.3`（旧版 tarball 已不在
 * 支持面内），因此不再登记 `0.2.0-rc.2` / `0.2.1-alpha.*`。
 */
const FROZEN_TARBALLS: Record<string, string> = {
  "0.2.2-rc.3": "6cf6401df4658d11a1398a7f38f7a5e610217be13bcf7c89b70d0d4fc019deef",
};
const EXPECTED: Record<string, { startActivation: boolean; startContinuable: boolean; impl: string }> = {
  "0.2.2-rc.3": { startActivation: true, startContinuable: false, impl: "startActivation" },
};

function readFixture(): any {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

test("g-469 E① 真实宿主契约：最低支持线上只有 startActivation，且与冻结 tarball 指纹一致", () => {
  const fx = readFixture();
  assert.equal(fx.schema, "g469-host-subagent-api/v1");
  assert.equal(fx.generator, "core/tests/fixtures/g469-host-subagent-api.mjs", "夹具必须由仓内生成器从真实 tarball 提取");
  assert.deepEqual(fx.probe_contract.dispatch_methods, ["startActivation"], "派发方法只剩 startActivation");
  assert.equal(fx.probe_contract.provider_capability, "prepareContinuable");
  assert.deepEqual(Object.keys(FROZEN_TARBALLS).sort(), fx.versions.map((v: any) => v.host_version).sort());

  for (const v of fx.versions) {
    const exp = EXPECTED[v.host_version];
    assert.ok(exp, `未预期的宿主版本：${v.host_version}`);
    assert.deepEqual(v.methods, { startActivation: exp.startActivation, startContinuable: exp.startContinuable },
      `${v.host_version}：两版方法名必须互斥（实测 typert 服务方法表）`);
    assert.equal(v.dispatch_impl.name, exp.impl, `${v.host_version}：真实实现体必须取自该版本的派发方法`);
    assert.equal(v.tarball_sha256, FROZEN_TARBALLS[v.host_version], `${v.host_version}：tarball 指纹必须与冻结值一致`);
    assert.match(v.tarball_sha256, /^[0-9a-f]{64}$/);
    // 方法名确实存在于真实实现提取物中（不是靠我方源码自证）
    assert.ok(v.dispatch_impl.source.includes(`async ${exp.impl}(spec)`), `${v.host_version}：实现体必须含 async ${exp.impl}(spec)`);
    assert.ok(v.dispatch_impl.source.includes("spec."), `${v.host_version}：实现体必须读取 spec.*`);
    assert.equal(sha256(v.dispatch_impl.source), v.dispatch_impl.sha256, `${v.host_version}：派发实现体自校验 sha256`);
    assert.equal(sha256(v.manager_impl.source), v.manager_impl.sha256, `${v.host_version}：manager 实现体自校验 sha256`);
    // 能力探测名仍在服务门面里（我方 provider 探测依赖它）
    assert.equal(v.provider_capability.name, "prepareContinuable");
    assert.equal(v.provider_capability.present_in_entry, true, `${v.host_version}：入口必须含 prepareContinuable`);
    // 收窄证据：该版的服务方法表里**同时**包含 rootOf / interrupt（g-625 收口所依赖的单版本口径）
    for (const needed of ["startActivation", "rootOf", "interrupt", "getProvider", "sendMessage"]) {
      assert.ok(v.service_method_names.includes(needed), `${v.host_version}：服务方法表必须含 ${needed}`);
    }
    for (const gone of ["startContinuable", "interruptByParent", "listChildren", "isOwnedBy"]) {
      assert.ok(!v.service_method_names.includes(gone), `${v.host_version}：${gone} 必须已从服务面删除（收窄理由）`);
    }
  }
});

test("g-469 E② 真实宿主契约：我方扁平 spec 字段与 receipt 读取被真实实现覆盖（parentSessionId 兜底必需）", () => {
  const fx = readFixture();
  const ours: string[] = fx.probe_contract.call_spec_fields;
  // g-624 / g-627：这里是**扁平形态**基线字段；每处派发还显式传 delivery=parent。
  // 形态断言见 g624-activation-spec-compat.test.ts。
  assert.deepEqual(ours, ["provider", "label", "parent", "prompt", "signal"], "扁平 spec 的基线字段（逐字）");
  const specUnion = new Set<string>();
  for (const v of fx.versions) {
    // 派发门面自身会读取的字段（parent/provider/signal…）在 spec_fields 里；其余字段由 provider
    // 接管后隔着子调用读取，门面静态提取不到 —— 这类字段交给 E③ 的 .d.ts 声明层核对。
    const FACADE_READ_FIELDS = ["provider", "parent"];
    for (const field of ours) {
      specUnion.add(field);
      if (!FACADE_READ_FIELDS.includes(field)) continue;
      assert.ok(v.spec_fields.includes(field),
        `${v.host_version}：派发门面未读取 spec.${field} ⇒ 我方调用形态与该版不符（实得 ${JSON.stringify(v.spec_fields)}）`);
    }
    // receipt：childId 必在；parentSessionId 两版都没有 ⇒ 调用点 `?? null` 兜底是必需契约
    assert.ok(v.receipt_keys.includes("childId"), `${v.host_version}：receipt 必须含 childId`);
    assert.ok(!v.receipt_keys.includes("parentSessionId"),
      `${v.host_version}：真实 receipt 不含 parentSessionId（若将来新增，需重估 ??: null 兜底与绑定来源）`);
  }
  assert.equal(specUnion.size, 5);

  // 我方源码：探测的方法名集合 == 夹具声明的候选集合（不多不少）
  // 注意：`codeOnly` 会清空字符串**内容**，故这里只匹配到开引号为止。
  const code = codeOnly(readFileSync(HOST_SOURCE, "utf8"));
  const probed = [...new Set([...code.matchAll(/typeof\s+subagents\.(start\w+)\s*===\s*"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(probed, ["startActivation"], "源码只允许探测 startActivation（旧名回退已删除）");
  assert.ok(fx.probe_contract.dispatch_methods.includes("startActivation"), "夹具必须覆盖 startActivation");
  // 能力探测名不得跟着改名（仍是 prepareContinuable）
  const caps = [...new Set([...code.matchAll(/getProvider\([^)]*\)\?\.(\w+)/g)].map((m) => m[1]))];
  assert.deepEqual(caps, [fx.probe_contract.provider_capability], "provider 能力探测名必须仍是 prepareContinuable");
});

test("g-469 E③ 真实宿主契约（声明层）：.d.ts 声明的 spec/receipt 字段表覆盖我方调用形态", () => {
  const fx = readFixture();
  const ours: string[] = fx.probe_contract.call_spec_fields;
  const REQUIRED_COMMON = ["provider", "label", "parent", "prompt", "signal"];
  for (const v of fx.versions) {
    const names = Object.keys(v.declared_types);
    const specName = names.find((n) => n.endsWith("Spec"));
    const receiptName = names.find((n) => !n.endsWith("Spec"));
    assert.ok(specName && receiptName, `${v.host_version}：必须同时声明 spec 与 receipt 类型（实得 ${names}）`);
    assert.equal(sha256(v.declared_types[specName].source), v.declared_types[specName].sha256, "声明片段自校验 sha256");

    const specFields: Array<{ name: string; optional: boolean }> = v.declared_types[specName].fields;
    // g-627：rc.3 的 `SubagentActivationSpec extends Omit<SubagentStartRequest, 'label'|'signal'>`，
    // 因此 label/signal 由本接口声明，其余（prompt/parent/cwd/agentOptions…）继承自 SubagentStartRequest。
    // 这里断言「必填的本地声明 + 声明了继承关系」两者共同覆盖我方必传字段。
    const declared = new Set(specFields.map((d) => d.name));
    const inherited = /extends\s+Omit<\s*SubagentStartRequest\s*,/.test(v.declared_types[specName].source);
    for (const f of REQUIRED_COMMON) {
      if (!declared.has(f)) {
        assert.ok(inherited, `${v.host_version}/${specName}：既未声明 ${f}，也没有继承 SubagentStartRequest`);
        continue;
      }
      const decl = specFields.find((d) => d.name === f)!;
      assert.equal(decl.optional, false, `${v.host_version}/${specName}：${f} 必须是必填（我方每处都传）`);
    }
    // 我方不传 childId（可选）——两版都声明为可选
    const childId = specFields.find((d) => d.name === "childId");
    assert.ok(childId?.optional === true, `${v.host_version}/${specName}：childId 必须是可选（我方不预留守卫）`);
    // 我方调用传入的字段全部被声明覆盖（本地声明 或 继承自 SubagentStartRequest）
    for (const f of ours) {
      assert.ok(specFields.some((d) => d.name === f) || inherited, `${v.host_version}：未声明我方字段 ${f}`);
    }

    const receiptFields: Array<{ name: string; optional: boolean }> = v.declared_types[receiptName].fields;
    const rc = receiptFields.find((d) => d.name === "childId");
    assert.ok(rc && rc.optional === false, `${v.host_version}/${receiptName}：receipt 必含必填 childId`);
    assert.ok(!receiptFields.some((d) => d.name === "parentSessionId"),
      `${v.host_version}/${receiptName}：声明里没有 parentSessionId ⇒ 我方 ?? null 兜底是必需契约`);

    // 新版声明必填 `delivery`，其运行时默认值恰为 'parent'；g-624 起我们**显式**传 'parent'
    // （不再依赖该默认值），断言默认值仍为 parent 以便旧宿主/漏传时同样落到「通知父代理」。
    if (v.optional_field_defaults.delivery !== null) {
      assert.equal(v.optional_field_defaults.delivery, "parent",
        `${v.host_version}：声明必填的 delivery 必须有 'parent' 运行时默认，否则不传该字段会改变交付语义`);
    }
  }
  assert.equal(fx.versions[0].optional_field_defaults.delivery, "parent", "delivery 的运行时默认仍是 parent");
});

// ============================================================================
// F. 真机演练件（惰性资产）：登记在库里、可复跑，但**不入闸门**
// ============================================================================

/** 真机派发探测件：只有被显式 `dsh --patch` 引用时才会加载 ⇒ 不进闸门、不做任何网络/凭据动作。 */
const DISPATCH_PROBE = resolve(FIXTURE_DIR, "g469-host-dispatch-probe.mjs");

test("g-469 F① 真机演练件：惰性、不参与收集、且如实声明「真实 childId」判据", () => {
  const src = readFileSync(DISPATCH_PROBE, "utf8");
  // 1) 惰性：文件名不匹配闸门 glob（core/tests/*.test.ts），且不含任何测试注册调用
  assert.ok(!DISPATCH_PROBE.endsWith(".test.ts"), "演练件不得落入闸门收集集合");
  assert.ok(!/\b(?:test|it|describe)\s*\(/.test(src), "演练件不得注册测试节点（否则会污染闸门计数）");
  // 2) 只读探测：不写凭据、不发网络请求、不读 API key
  for (const forbidden of [/process\.env\.\w*API_KEY/i, /\bfetch\s*\(/, /https?:\/\//, /\bapiKey\b/i]) {
    assert.ok(!forbidden.test(src), `演练件必须无凭据/无网络（命中 ${forbidden}）`);
  }
  // 3) 契约：必须走被测插件的收口 helper，并只在旧名缺失时做零副作用的阴性对照
  assert.match(src, /startSubagentCompat/, "演练件必须经收口 helper 派发（不得直接调宿主新/旧名冒充通过）");
  assert.match(src, /ctx\.on\("agent\/created"/, "必须等真实 live Agent 出现（parent 必须是真实 Agent）");
  assert.match(src, /!record\.service\.has_startContinuable/, "阴性对照只在旧名缺失时执行（零副作用）");
  assert.match(src, /child_id_is_real/, "必须显式判定并落盘「拿到的是否真实 childId」");
  // 4) 可复跑性：文件头必须写清复跑步骤（宿主版本运行时 + --patch + 无凭据退出码说明）
  assert.match(src, /--profile headless/, "文件头必须写明复跑命令（headless + --patch）");
  assert.match(src, /MISSING_CREDENTIAL/, "文件头必须说明无凭据时进程会以该错误结束（与派发探测无关）");
  assert.match(src, /DSH_HOME/, "文件头必须写明 DSH_HOME 隔离要求");
});
