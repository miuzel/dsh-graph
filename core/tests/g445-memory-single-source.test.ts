/**
 * g-445：长期记忆模型整合（方向 A：结构化单一真源）。
 *
 * 断言面（全部走**真实入口**：core API、`apply()` 注册的工具/REST、generateHandoff 渲染、
 * 以及跨进程并发子进程；不做「只测纯函数」的自证）：
 *  1. 单一真源与事件计数：两次 add + 一次 replace + 一次 remove ⇒ 4 事件而活跃条目 1；
 *  2. `source_ref` 迁移幂等：同来源重试返回原 ID、不追加事件（含**跨进程并发**）；
 *  3. 迁移后 replace 再重试 ⇒ 修订保留、不追加；
 *  4. 迁移后 remove 再重试 ⇒ 明确跳过（`skipped`）、不复活；
 *  5. 同来源不同摘要 ⇒ 明确冲突；无来源目标的旧文档迁移成功，而伪目标被拒（不伪造 source_goal）；
 *  6. 未显式调用不迁移、不读旧 md 内容、不触发任何写入；1001 码点 on_demand / 201 码点 standing
 *     仍拒绝且旧文档原文与事件流逐字不变；
 *  7. 工具 / UI / 交接显示同一条目与来源（`ref:` 标签、`source_ref` 字段、i18n 键）；
 *     只改旧 md 不影响 recall 与注入；
 *  8. 指南 zh/en 不再要求索引维护、旧 md 仍保留；禁用写工具时迁移拒绝。
 *
 * 向后兼容：旧 `memory.added` 事件（无 `source_ref`）照常重放，新字段可选、缺省不影响排序。
 * 本目标**不改** standing ≤200 字上限与常驻授权规则（断言 6 只证明它们未被放宽/削弱）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { apply } from "../../dist/index.js";
import {
  init,
  addMemory,
  replaceMemory,
  removeMemory,
  recallMemory,
  readMemory,
  generateHandoff,
  formatStandingMemorySection,
} from "../ops.ts";
import { appendMemoryEvent, readMemoryEvents } from "../events.ts";

const repoRoot = join(import.meta.dirname, "../..");

/** 恰好 n 个**码点**的文本（😀 为代理对 ⇒ 与 UTF-16 长度可区分，证明计数走码点）。 */
function cps(n: number): string {
  const block = "😀中";
  const full = block.repeat(Math.floor(n / 2));
  return n % 2 === 0 ? full : `${full}字`;
}

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g445-"));
  init(root);
  return root;
}

const addedEvents = (root: string) => readMemoryEvents(root).filter((e) => e.event === "memory.added");
const replacedEvents = (root: string) => readMemoryEvents(root).filter((e) => e.event === "memory.replaced");

// =====================================================================================
// 真实入口脚手架：apply() 注册的工具 + REST（与既有多套 host 测试同款 mock ctx）
// =====================================================================================

function makeHarness() {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g445-ws-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const routes = new Map<string, any>();
  const tools = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) =>
      name === "webServer" ? webServer : name === "sandboxPolicy" ? { workspaceRoot: ws } : undefined,
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { tools.set(def.name, def); return () => {}; }, get: () => ({}) },
  };
  const dispose = apply(ctx, { root });
  return { ws, root, routes, tools, dispose };
}

function fakeRes() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s?: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}

async function post(routes: Map<string, any>, path: string, body: unknown) {
  const handler = routes.get(path);
  assert.ok(handler, `路由 ${path} 已注册`);
  const listeners: Record<string, Function> = {};
  const req: any = { method: "POST", url: path, on: (e: string, fn: Function) => { listeners[e] = fn; } };
  const res = fakeRes();
  const p = handler(req, res);
  listeners.data?.(JSON.stringify(body));
  listeners.end?.();
  await p;
  return { code: res._code, body: res._body };
}

async function get(routes: Map<string, any>, path: string) {
  const handler = routes.get(path.split("?")[0]);
  assert.ok(handler, `路由 ${path} 已注册`);
  const req: any = { method: "GET", url: path, on: () => {} };
  const res = fakeRes();
  await handler(req, res);
  return { code: res._code, body: res._body };
}

async function runTool(tools: Map<string, any>, name: string, args: unknown) {
  const t = tools.get(name);
  assert.ok(t, `工具 ${name} 已注册`);
  const ex = { agent: { id: "dsh", session: { id: "session-g445" } } };
  try {
    return { ok: true as const, out: await t.execute(args, ex) };
  } catch (e: any) {
    return { ok: false as const, error: String(e?.message ?? e) };
  }
}

// =====================================================================================
// 1. 单一真源：事件流是唯一权威（行数 ≠ 活跃条目数）
// =====================================================================================

test("g-445 判据1：两次 add + 一次 replace + 一次 remove ⇒ 4 事件而活跃条目 1", () => {
  const root = freshRoot();
  const a = addMemory(root, { kind: "project", text: "条目A：结构化记忆是单一真源", actor: "agent:t" });
  const b = addMemory(root, { kind: "project", text: "条目B：待撤回", actor: "agent:t" });
  replaceMemory(root, { old: a.id, text: "条目A：结构化记忆是单一真源（已修订）", actor: "agent:t" });
  removeMemory(root, { old: b.id, reason: "测试撤回", actor: "agent:t" });

  assert.equal(readMemoryEvents(root).length, 4, "4 条事件（2 added + 1 replaced + 1 removed）");
  const active = readMemory(root);
  assert.equal(active.length, 1, "活跃条目只有 1 条——事件行数不是记忆条数");
  assert.equal(active[0].id, a.id);
  assert.equal(active[0].text, "条目A：结构化记忆是单一真源（已修订）");
});

test("g-445 判据1：旧事件（无 source_ref）照常重放，新字段缺省不影响既有条目", () => {
  const root = freshRoot();
  // 模拟历史遗留事件（g-445 之前写入，无 source_ref）
  appendMemoryEvent(root, {
    actor: "agent:legacy",
    event: "memory.added",
    details: { id: "mem-legacy01", kind: "project", scope: "on_demand", text: "历史条目（无来源引用）", created_at: "2026-01-01T00:00:00+08:00", updated_at: "2026-01-01T00:00:00+08:00" },
  } as any);
  const entries = readMemory(root);
  assert.equal(entries.length, 1, "旧事件照常重放，不报错");
  assert.equal(entries[0].source_ref, undefined, "缺省 source_ref 不影响既有条目");
  assert.equal(recallMemory(root, { query: "历史条目" }).total, 1, "旧条目仍可检索");
  assert.ok(formatStandingMemorySection(root) === null || typeof formatStandingMemorySection(root) === "string");
});

// =====================================================================================
// 2–5. source_ref 幂等迁移语义（core 入口）
// =====================================================================================

test("g-445 判据3：同来源幂等重试返回原 ID、不重复追加事件", () => {
  const root = freshRoot();
  const src = "memory/long-term/arch.md#single-source";
  const opts = { kind: "project" as const, scope: "on_demand" as const, text: "统一摘要：结构化记忆是唯一真源", source_ref: src, actor: "agent:supervisor" };

  const first = addMemory(root, opts);
  const retry = addMemory(root, opts);
  assert.equal(retry.id, first.id, "同来源同输入返回原 ID");
  assert.equal(retry.deduped, true, "标记为幂等命中");
  assert.equal(retry.skipped, undefined);
  assert.equal(addedEvents(root).length, 1, "只追加一个 added 事件");
  assert.equal(first.entry.created_by, "agent:supervisor", "created_by 如实表示本次写入者");
  assert.equal(first.entry.source_goal, undefined, "无来源目标的旧文档不伪造 source_goal");
  assert.equal(first.entry.source_ref, src, "source_ref 落盘可追溯");
});

test("g-445 判据3：迁移后 replace 再重试 ⇒ 后续修订保留、不追加、不覆盖", () => {
  const root = freshRoot();
  const src = "memory/long-term/arch.md#revised";
  const first = addMemory(root, { kind: "project", scope: "on_demand", text: "摘要V1", source_ref: src, actor: "agent:s" });
  replaceMemory(root, { old: first.id, text: "摘要V2（主管修订）", actor: "agent:s" });

  const retry = addMemory(root, { kind: "project", scope: "on_demand", text: "摘要V1", source_ref: src, actor: "agent:s" });
  assert.equal(retry.id, first.id);
  assert.equal(retry.deduped, true);
  assert.equal(addedEvents(root).length, 1, "不追加 added 事件");
  assert.equal(replacedEvents(root).length, 1);
  assert.equal(readMemory(root)[0].text, "摘要V2（主管修订）", "保留后续修订");
  assert.equal(retry.entry.source_ref, src, "replace 后 source_ref 仍在（重放保留）");
});

test("g-445 判据3：迁移后 remove 再重试 ⇒ 明确跳过、不复活", () => {
  const root = freshRoot();
  const src = "memory/long-term/arch.md#withdrawn";
  const first = addMemory(root, { kind: "project", scope: "on_demand", text: "摘要（后撤回）", source_ref: src, actor: "agent:s" });
  removeMemory(root, { old: first.id, reason: "已证伪", actor: "agent:s" });

  const retry = addMemory(root, { kind: "project", scope: "on_demand", text: "摘要（后撤回）", source_ref: src, actor: "agent:s" });
  assert.equal(retry.skipped, true, "明确标记跳过");
  assert.equal(retry.deduped, true, "未追加事件");
  assert.equal(retry.id, first.id);
  assert.match(String(retry.reason), /撤回|跳过/);
  assert.equal(readMemory(root).length, 0, "不复活已撤回条目");
  assert.equal(addedEvents(root).length, 1, "不追加 added 事件");
  assert.equal(retry.entry.text, "摘要（后撤回）", "entry 为该条目撤回前的最后状态（可审计）");
});

test("g-445 判据3/4：同来源不同摘要 ⇒ 明确冲突；无来源目标成功 / 伪目标被拒", () => {
  const root = freshRoot();
  const src = "memory/long-term/arch.md#conflict";
  addMemory(root, { kind: "project", scope: "on_demand", text: "摘要甲", source_ref: src, actor: "agent:s" });
  assert.throws(
    () => addMemory(root, { kind: "project", scope: "on_demand", text: "摘要乙", source_ref: src, actor: "agent:s" }),
    /冲突/,
    "同来源不同输入不得自动替换",
  );
  assert.equal(addedEvents(root).length, 1, "冲突零副作用");

  // 无来源目标的旧文档：source_goal 留空、来源写进 source_ref（绝不伪造目标）
  const doc = addMemory(root, { kind: "project", scope: "on_demand", text: "旧文档摘要（无来源目标）", source_ref: "memory/long-term/legacy.md#u1", actor: "agent:s" });
  assert.equal(doc.entry.source_goal, undefined);
  assert.equal(doc.entry.source_ref, "memory/long-term/legacy.md#u1");
  // 伪造目标：既有校验拒绝（不得为过校验编造 source_goal）
  assert.throws(
    () => addMemory(root, { kind: "project", scope: "on_demand", text: "x", source_goal: "g-no-such-goal", source_ref: "memory/long-term/legacy.md#u2", actor: "agent:s" }),
    /目标不存在/,
  );
  assert.equal(addedEvents(root).length, 2, "伪目标被拒时零副作用");
});

// =====================================================================================
// 2b. 并发：跨进程同来源重试只增一个事件（真实文件锁 + 历史 added 判定）
// =====================================================================================

function spawnAdd(root: string, text: string, sourceRef: string): Promise<number> {
  const opsUrl = pathToFileURL(join(repoRoot, "dist/core/ops.js")).href;
  const script = [
    `import { addMemory } from ${JSON.stringify(opsUrl)};`,
    `addMemory(${JSON.stringify(root)}, { kind: "project", scope: "on_demand", text: ${JSON.stringify(text)}, source_ref: ${JSON.stringify(sourceRef)}, actor: "agent:test" });`,
  ].join("\n");
  return new Promise((resolve) => {
    // NODE_OPTIONS 置空：子进程不得继承测试事件通道（否则会污染闸门的计数/覆盖核对）
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("close", (code) => resolve(code === 0 ? 0 : Number(code) || 1));
    child.on("error", () => resolve(1));
    if (err) { /* 失败细节由退出码体现，避免污染测试输出 */ }
  });
}

test("g-445 判据3：5 个进程并发迁移同一来源 ⇒ 全部成功但只增一个 added 事件", async () => {
  const distOps = join(repoRoot, "dist/core/ops.js");
  assert.ok(existsSync(distOps), "dist/ 不存在：请先运行 bash scripts/build.sh");
  const root = freshRoot();
  const src = "memory/long-term/concurrent.md#unit";
  const text = "并发迁移摘要（同来源同输入）";

  const codes = await Promise.all(Array.from({ length: 5 }, () => spawnAdd(root, text, src)));
  assert.deepEqual(codes, [0, 0, 0, 0, 0], "5 个并发子进程均正常退出（锁等待不超时）");
  assert.equal(addedEvents(root).length, 1, "并发重试只增一个 added 事件");
  const active = readMemory(root);
  assert.equal(active.length, 1, "活跃条目只有 1 条");
  assert.equal(active[0].source_ref, src);
  assert.equal(active[0].text, text);
});

// =====================================================================================
// 6. 未显式调用不迁移：引擎不读旧 md、不写任何东西；上限纪律不变
// =====================================================================================

test("g-445 判据3/6：未显式调用不迁移——不读旧 md 内容、不触发写入、原文逐字不变", () => {
  const root = freshRoot();
  const docPath = join(root, "memory", "long-term", "legacy.md");
  const docBody = "# 旧文档\n\n这是旧文档正文，绝不能被自动导入或截断。\n";
  writeFileSync(docPath, docBody);

  // 仅存在旧文档（无任何 graph_memory_* 调用）⇒ 没有结构化条目、没有 memory.jsonl
  assert.equal(readMemory(root).length, 0, "文件存在 ≠ 记忆条目");
  assert.ok(!existsSync(join(root, "memory", "memory.jsonl")), "未显式调用不产生 memory.jsonl");
  const handoff = generateHandoff(root);
  assert.ok(handoff.includes("legacy.md"), "交接只列出旧文档文件名");
  assert.ok(!handoff.includes("这是旧文档正文"), "引擎从不读取旧文档内容（不自动抽取）");

  // 上限纪律不变：1001 码点 on_demand / 201 码点 standing 均拒绝，且零副作用
  assert.throws(
    () => addMemory(root, { kind: "project", scope: "on_demand", text: cps(1001), source_ref: "memory/long-term/legacy.md#too-long", actor: "agent:s" }),
    /1000/,
  );
  assert.throws(
    () => addMemory(root, { kind: "project", scope: "standing", text: cps(201), source_ref: "memory/long-term/legacy.md#standing-too-long", actor: "agent:s" }),
    /200/,
  );
  assert.equal(readMemory(root).length, 0, "拒绝时零副作用");
  assert.equal(readFileSync(docPath, "utf8"), docBody, "旧文档原文逐字不变（只读保留）");
  assert.equal(existsSync(join(root, "memory", "memory.jsonl")), false, "事件流未被触碰");
});

test("g-445 判据3：standing ≤200 码点仍可通过且常驻段照常渲染（纪律未被放宽/削弱）", () => {
  const root = freshRoot();
  const ok = addMemory(root, { kind: "project", scope: "standing", text: cps(200), actor: "human:owner" });
  assert.equal([...ok.entry.text].length, 200, "200 码点 standing 仍可通过");
  assert.ok(ok.entry.created_by === "human:owner");
  const section = formatStandingMemorySection(root);
  assert.ok(section && section.includes("[mem-"), "常驻段照常渲染该条目");
});

// =====================================================================================
// 7. 工具 / UI / 交接口径一致；只改旧 md 不影响 recall 与注入
// =====================================================================================

test("g-445 判据4/7：工具、REST、交接显示同一条目与来源；REST/工具迁移幂等", async () => {
  const h = makeHarness();
  try {
    const src = "memory/long-term/legacy.md#unit-7";
    const summary = "统一摘要：长期记忆单一真源";

    // 工具入口：首次写入 + 同来源重试（返回原 ID、deduped、单事件）
    const t1 = await runTool(h.tools, "graph_memory_add", { kind: "project", scope: "on_demand", text: summary, source_ref: src });
    assert.equal(t1.ok, true, `工具入口迁移成功：${t1.ok ? "" : t1.error}`);
    assert.equal(t1.ok && t1.out.entry.source_ref, src, "工具返回值贯通 source_ref");
    const t2 = await runTool(h.tools, "graph_memory_add", { kind: "project", scope: "on_demand", text: summary, source_ref: src });
    assert.equal(t2.ok, true);
    assert.equal(t2.ok && t2.out.id, t1.ok && t1.out.id, "工具入口同来源重试返回原 ID");
    assert.equal(t2.ok && t2.out.deduped, true);
    assert.equal(addedEvents(h.root).length, 1, "工具入口重试不追加事件");

    // 工具 schema：source_ref 暴露且可选；描述说明幂等迁移
    const def = h.tools.get("graph_memory_add");
    assert.ok(Object.keys(def.parameters.properties).includes("source_ref"), "工具 schema 暴露 source_ref");
    assert.equal((def.parameters.required ?? []).includes("source_ref"), false, "source_ref 必须是可选参数");
    assert.match(String(def.description), /source_ref/, "工具描述说明 source_ref 幂等迁移");

    // REST 入口：同一来源同一条目（list 显示 source_ref；add 重试幂等）
    const rest = await post(h.routes, "/api/dsh-graph/memory/add", { kind: "project", scope: "on_demand", text: summary, source_ref: src });
    assert.equal(rest.code, 200);
    assert.equal(rest.body.id, t1.ok && t1.out.id);
    assert.equal(rest.body.deduped, true);
    const list = await get(h.routes, "/api/dsh-graph/memory/list?scope=on_demand");
    assert.equal(list.code, 200);
    const row = (list.body.memory as any[]).find((m) => m.id === (t1.ok && t1.out.id));
    assert.ok(row, "管理面列出该条目");
    assert.equal(row.source_ref, src, "管理面显示真实来源引用");
    assert.equal(row.text, summary);
    // 检索面含 source_ref（来源可追溯 ⇒ 可按来源检索）
    const bySource = await get(h.routes, `/api/dsh-graph/memory/list?query=${encodeURIComponent("unit-7")}`);
    assert.ok((bySource.body.memory as any[]).some((m) => m.id === row.id), "REST 检索可命中 source_ref");
    assert.equal(recallMemory(h.root, { query: "unit-7" }).total, 1, "core recall 也可命中 source_ref");

    // 交接：同一条目 + 来源标签可见
    const handoff = generateHandoff(h.root);
    assert.ok(handoff.includes(row.id), "交接含同一条目 ID");
    assert.ok(handoff.includes(summary), "交接含同一条目正文");
    assert.ok(handoff.includes(`ref:${src}`), "交接显示来源引用（ref:）");
    assert.ok(handoff.includes("memory.jsonl` 为唯一真源"), "交接声明结构化记忆为唯一真源");
    assert.ok(/活跃匹配 \d+ 条 \/ 本次选中 \d+ 条 \/ 实际展示 \d+ 条/.test(handoff), "数量表述区分活跃/选中/展示");

    // 只改旧 md：不影响 recall 与自动注入
    const docPath = join(h.root, "memory", "long-term", "legacy.md");
    writeFileSync(docPath, "被改写的旧文档正文（不属于记忆真源）\n");
    assert.equal(recallMemory(h.root, { query: "统一摘要" }).total, 1, "recall 不受旧 md 改动影响");
    assert.equal(readMemory(h.root).find((e) => e.id === row.id)?.text, summary);
    const handoff2 = generateHandoff(h.root);
    assert.ok(handoff2.includes(summary) && !handoff2.includes("被改写的旧文档正文"), "注入内容不受旧 md 改动影响");

    // UI 源：管理面显示 source_ref，i18n zh/en 双侧有键
    const drag = readFileSync(join(repoRoot, "dsh-graph-host/lib/client/drag-prompts.js"), "utf8");
    assert.ok(drag.includes('m.source_ref') && drag.includes('"memory.sourceRef"'), "记忆管理面渲染 source_ref 且走 i18n");
    const i18n = readFileSync(join(repoRoot, "dsh-graph-host/lib/client/i18n.js"), "utf8");
    assert.equal((i18n.match(/'memory\.sourceRef':/g) ?? []).length, 2, "i18n zh/en 双侧都有 memory.sourceRef");
    const distBundle = join(repoRoot, "dist/lib/client.js");
    if (existsSync(distBundle)) {
      assert.ok(readFileSync(distBundle, "utf8").includes("memory.sourceRef"), "构建产物含 source_ref 展示键");
    }
  } finally {
    h.dispose();
  }
});

// =====================================================================================
// 8. 指南单一真源口径 + 禁用写工具时迁移拒绝
// =====================================================================================

test("g-445 判据2：指南 zh/en 不再要求索引维护，旧 md 保留为可选文档", () => {
  for (const f of ["dsh-graph-host/supervisor-guide.zh.md", "dsh-graph-host/supervisor-guide.en.md"]) {
    const text = readFileSync(join(repoRoot, f), "utf8");
    assert.ok(!text.includes("INDEX.md"), `${f} 不再强制读取/维护 INDEX.md`);
    assert.ok(text.includes("memory/memory.jsonl") || text.includes("`memory.jsonl`"), `${f} 指明结构化记忆真源`);
    assert.ok(text.includes("graph_memory_recall"), `${f} 指明按需召回入口`);
    assert.ok(text.includes("source_ref"), `${f} 说明迁移来源键`);
    assert.ok(text.includes("on_demand") && text.includes("standing"), `${f} 保留 standing/on_demand 分级口径`);
    assert.ok(text.includes("long-term"), `${f} 说明旧 md 为可选文档`);
    const distCopy = join(repoRoot, "dist", f.replace("dsh-graph-host/", ""));
    if (existsSync(distCopy)) {
      assert.ok(!readFileSync(distCopy, "utf8").includes("INDEX.md"), `构建产物 ${distCopy} 同步移除索引要求`);
    }
  }
  // 行为面：迁移不删除、不改写旧文档
  const root = freshRoot();
  const docPath = join(root, "memory", "long-term", "keep.md");
  writeFileSync(docPath, "保留的旧文档\n");
  addMemory(root, { kind: "project", scope: "on_demand", text: "迁移条目", source_ref: "memory/long-term/keep.md#1", actor: "agent:s" });
  assert.equal(readFileSync(docPath, "utf8"), "保留的旧文档\n", "旧 md 原样保留（不自动删除/改写）");
});

test("g-445 判据8：禁用记忆写工具时迁移拒绝（工具入口拒绝、零事件；REST 属人工管理面）", async () => {
  const h = makeHarness();
  try {
    const off = await post(h.routes, "/api/dsh-graph/memory/toggle-tools", { enabled: false });
    assert.equal(off.code, 200);
    assert.equal(off.body.tools_enabled, false);

    const before = addedEvents(h.root).length;
    // 工具入口（supervisor/子代理的迁移路径）必须拒绝，且零副作用
    const deniedTool = await runTool(h.tools, "graph_memory_add", { kind: "project", scope: "on_demand", text: "禁用后迁移", source_ref: "memory/long-term/x.md#1" });
    assert.equal(deniedTool.ok, false, "禁用后工具入口迁移被拒");
    assert.match(deniedTool.ok ? "" : deniedTool.error, /禁用/);
    assert.equal(addedEvents(h.root).length, before, "工具入口拒绝时零事件、零副作用");
    assert.equal(readMemory(h.root).length, 0);

    // REST 端点属于**人工管理面**（开关文案即「允许 Agent 工具调用」/「纯手工模式」）：
    // 关闭后负责人仍可在 GUI 手工维护记忆 ⇒ REST 不受此开关拦截（有意边界，非漏检）。
    const manual = await post(h.routes, "/api/dsh-graph/memory/add", {
      kind: "project", scope: "on_demand", text: "人工在管理面添加", source_ref: "memory/long-term/x.md#manual",
    });
    assert.equal(manual.code, 200, "纯手工模式下负责人仍能经管理面维护记忆");
    assert.equal(readMemory(h.root).length, 1);
    assert.equal(addedEvents(h.root).length, before + 1);
  } finally {
    h.dispose();
  }
});

test("g-445：source_goal 与 source_ref 的输入校验（伪目标 / 空值 / 控制字符）", () => {
  const root = freshRoot();
  assert.throws(() => addMemory(root, { kind: "project", text: "x", source_goal: "g-nope", actor: "agent:s" }), /目标不存在/);
  assert.throws(() => addMemory(root, { kind: "project", text: "x", source_ref: "", actor: "agent:s" }), /source_ref/);
  assert.throws(
    () => addMemory(root, { kind: "project", text: "x", source_ref: `a${String.fromCharCode(1)}b`, actor: "agent:s" }),
    /控制字符/,
  );
  assert.equal(readMemoryEvents(root).length, 0, "非法输入零副作用");
});

// =====================================================================================
// review F1：user 类条目的 source_ref 幂等键必须按 owner 隔离（不得绕过 ACL）
//
// 三种形态（与复核者 probeE 一一对应），每条都带「不泄露他人 ID/正文」的负向断言：
//   ① 他人 source_ref + 不同 text ⇒ 不得抛冲突、不得回显他人条目 ID；bob 得到自己的新条目
//   ② 他人 source_ref + 相同 text ⇒ 不得静默并入他人私有条目；bob 得到自己的新条目
//   ③ 他人 remove 后同 source_ref 重试 ⇒ 不得返回他人撤回前的私有正文
// 同时钉住：同 owner 幂等不回归；project 类既有全局幂等语义逐字不变。
// =====================================================================================

const ALICE = "agent:alice";
const BOB = "agent:bob";
const SHARED_REF = "memory/long-term/private.md#unit";

/**
 * 负向断言：结果里不得出现他人条目 ID / 正文（含错误信息）。
 *
 * review r2 的 F2：旧调用点误传了**不含 `text` 字段**的结果对象（`AddMemoryResult`），
 * `other.text === undefined` ⇒ `dump.includes(undefined)` 退化为查找字面量 "undefined"，
 * 「不泄露他人私有正文」这条腿**静默空洞**（同时是 TS2345，但 `tsconfig` 排除 `core/tests`、
 * 闸门只 `node --test` 剥类型 ⇒ 两道门禁都看不见）。故这里先 **fail-closed 校验实参**，
 * 令任何「传错对象」的复用立刻显性判红，而不是悄悄退化成恒真断言。
 */
function assertNoLeak(result: unknown, other: { id: string; text: string }, label: string) {
  assert.equal(typeof other.id, "string", `${label}：assertNoLeak 的 other.id 必须是字符串`);
  assert.equal(typeof other.text, "string", `${label}：assertNoLeak 的 other.text 必须是字符串`);
  assert.ok(other.id.length > 0, `${label}：assertNoLeak 的 other.id 不得为空`);
  assert.ok(other.text.length > 0, `${label}：assertNoLeak 的 other.text 不得为空`);
  const dump = JSON.stringify(result);
  assert.equal(typeof dump, "string", `${label}：待检结果必须可序列化，否则断言不可信`);
  assert.equal(dump.includes(other.id), false, `${label}：不得泄露他人条目 ID`);
  assert.equal(dump.includes(other.text), false, `${label}：不得泄露他人私有正文`);
}

/**
 * 只查「他人条目 ID」泄漏面，用于 F1② 这类**双方正文逐字相同**的形态：
 * 彼处 bob 自己的正文就是同一字面量，若照样断言「结果不含该文本」，对**正确实现也必然失败**
 * （属错误断言而非加强），故文本面由正文不同的 F1①/F1③ 覆盖，此处改用 owner 归属硬判。
 */
function assertNoIdLeak(result: unknown, otherId: string, label: string) {
  assert.equal(typeof otherId, "string", `${label}：assertNoIdLeak 的 otherId 必须是字符串`);
  assert.ok(otherId.length > 0, `${label}：assertNoIdLeak 的 otherId 不得为空`);
  const dump = JSON.stringify(result);
  assert.equal(typeof dump, "string", `${label}：待检结果必须可序列化，否则断言不可信`);
  assert.equal(dump.includes(otherId), false, `${label}：不得泄露他人条目 ID`);
}

test("review F1①：他人 source_ref + 不同 text ⇒ 无命中（不抛冲突、不回显他人 ID），bob 写入自己的条目", () => {
  const root = freshRoot();
  const aliceText = "ALICE-私有：仅 alice 可见的迁移摘要";
  const bobText = "BOB-私有：bob 自己的迁移摘要";
  const alice = addMemory(root, { kind: "user", text: aliceText, source_ref: SHARED_REF, actor: ALICE });

  let bob: any;
  assert.doesNotThrow(() => {
    bob = addMemory(root, { kind: "user", text: bobText, source_ref: SHARED_REF, actor: BOB });
  }, "他人同来源不得抛冲突（冲突信息会回显他人条目 ID）");
  assert.notEqual(bob.id, alice.id, "bob 得到自己的新条目，而不是 alice 的");
  assert.equal(bob.entry.text, bobText);
  assert.equal(bob.deduped, undefined, "不是幂等命中");
  assert.equal(bob.skipped, undefined);
  assertNoLeak(bob, { id: alice.id, text: aliceText }, "F1①");

  // 两条各自独立存在，各自 recall 只见自己
  assert.equal(readMemory(root).length, 2, "alice/bob 各有一条");
  const aliceSees = recallMemory(root, { actor: ALICE });
  const bobSees = recallMemory(root, { actor: BOB });
  assert.deepEqual(aliceSees.matches.map((e) => e.text), [aliceText], "alice 只看到自己的");
  assert.deepEqual(bobSees.matches.map((e) => e.text), [bobText], "bob 只看到自己的");
  assert.equal(recallMemory(root).total, 0, "无身份调用看不到任何 user 条目");
});

test("review F1②：他人 source_ref + 相同 text ⇒ 不静默并入，bob 仍有自己的条目", () => {
  const root = freshRoot();
  const sameText = "IMPORTANT-私有：同一段摘要文本";
  const alice = addMemory(root, { kind: "user", text: sameText, source_ref: SHARED_REF, actor: ALICE });
  const bob = addMemory(root, { kind: "user", text: sameText, source_ref: SHARED_REF, actor: BOB });

  assert.notEqual(bob.id, alice.id, "bob 不得被并入 alice 的私有条目（否则 bob 拿不到自己的条目）");
  assert.equal(bob.entry.text, sameText);
  // 本形态双方正文逐字相同 ⇒ 只能查 ID 泄漏面 + 归属（旧实现会把 bob 的调用并进 alice 的条目：
  // `bob.id === alice.id`、且返回的 created_by 是 ALICE），文本面见 F1①/F1③。
  assertNoIdLeak(bob, alice.id, "F1②");
  assert.equal(bob.entry.created_by, BOB, "bob 拿到的条目必须记在 bob 名下，而不是 alice");
  assert.equal(bob.deduped, undefined);
  assert.equal(readMemory(root).length, 2, "两人各一条，互不覆盖");
  assert.equal(recallMemory(root, { actor: BOB }).total, 1);
  assert.equal(recallMemory(root, { actor: ALICE }).total, 1);
  // alice 的条目内容未被 bob 的调用改动
  const aliceEntry = readMemory(root).find((e) => e.id === alice.id);
  assert.equal(aliceEntry?.text, sameText);
  assert.equal(aliceEntry?.owner, ALICE);
});

test("review F1③：他人 remove 后同 source_ref 重试 ⇒ 不返回他人撤回前正文（无越权读取通道）", () => {
  const root = freshRoot();
  const aliceSecret = "ALICE-SECRET：撤回前的私有正文，绝不能被他人读到";
  const bobText = "BOB-私有：重试写入";
  const alice = addMemory(root, { kind: "user", text: aliceSecret, source_ref: SHARED_REF, actor: ALICE });
  removeMemory(root, { old: alice.id, reason: "alice 自己撤回", actor: ALICE });

  const bob = addMemory(root, { kind: "user", text: bobText, source_ref: SHARED_REF, actor: BOB });
  assert.equal(bob.skipped, undefined, "bob 不该拿到 alice 的「已撤回跳过」结局");
  assert.notEqual(bob.id, alice.id);
  assert.equal(bob.entry.text, bobText);
  assertNoLeak(bob, { id: alice.id, text: aliceSecret }, "F1③");

  // alice 的撤回语义不受影响：她重试仍是 skipped 且拿到自己撤回前的内容（自己的东西）
  const aliceRetry = addMemory(root, { kind: "user", text: aliceSecret, source_ref: SHARED_REF, actor: ALICE });
  assert.equal(aliceRetry.skipped, true, "owner 自己的「不复活」语义不变");
  assert.equal(aliceRetry.id, alice.id);
  assert.equal(aliceRetry.entry.text, aliceSecret);
  // bob 的条目已落盘且只有 bob 能看到
  assert.equal(recallMemory(root, { actor: BOB }).total, 1);
  assert.equal(recallMemory(root, { actor: ALICE }).total, 0, "alice 自己的条目仍未复活");
});

test("review F1 回归：同 owner 幂等不回归；project 类全局幂等语义逐字不变", () => {
  const root = freshRoot();
  // 同 owner：user 类仍幂等（返回原 ID、不追加事件）
  const alice1 = addMemory(root, { kind: "user", text: "alice 迁移摘要", source_ref: SHARED_REF, actor: ALICE });
  const alice2 = addMemory(root, { kind: "user", text: "alice 迁移摘要", source_ref: SHARED_REF, actor: ALICE });
  assert.equal(alice2.id, alice1.id, "同 owner 同来源仍幂等");
  assert.equal(alice2.deduped, true);
  assert.equal(addedEvents(root).length, 1, "同 owner 重试不追加事件");

  // project 类：跨 actor 仍是全局幂等键（既有语义不变）
  const pRef = "memory/long-term/shared.md#unit";
  const p1 = addMemory(root, { kind: "project", text: "project 迁移摘要", source_ref: pRef, actor: ALICE });
  const p2 = addMemory(root, { kind: "project", text: "project 迁移摘要", source_ref: pRef, actor: BOB });
  assert.equal(p2.id, p1.id, "project 类任何 actor 都命中同一条目");
  assert.equal(p2.deduped, true);
  assert.equal(p2.entry.kind, "project");
  assert.equal(addedEvents(root).length, 2, "project 重试同样不追加事件");
  // project 冲突语义不变（任何人同来源不同输入 ⇒ 冲突，不回显他人私有 ID）
  assert.throws(() => addMemory(root, { kind: "project", text: "project 另写", source_ref: pRef, actor: BOB }), /冲突/);
  assert.equal(addedEvents(root).length, 2, "冲突零副作用");
});

test("review F2：负向断言自身有效 —— 文本腿非空洞、实参误用 fail-closed", () => {
  const alice = { id: "mem-alice01", text: "ALICE-私有：仅 alice 可见" };
  // 干净载荷（只含自己的信息）必须通过
  assertNoLeak({ id: "mem-bob01", entry: { text: "BOB-私有" } }, alice, "F2-clean");
  assertNoIdLeak({ id: "mem-bob01" }, alice.id, "F2-clean-id");
  // 文本腿/ID 腿确实会判红（旧写法 `dump.includes(undefined)` 在此恒过 ⇒ 空洞断言）
  assert.throws(() => assertNoLeak({ entry: { text: alice.text } }, alice, "F2-leak"), /不得泄露他人私有正文/);
  assert.throws(() => assertNoLeak({ id: alice.id }, alice, "F2-leak-id"), /不得泄露他人条目 ID/);
  assert.throws(() => assertNoIdLeak({ id: alice.id }, alice.id, "F2-leak-id2"), /不得泄露他人条目 ID/);
  // 旧调用点的真实误用形态（传 AddMemoryResult ⇒ 无 text 字段）必须**显性判红**，不得退化成恒真
  const misuse = { id: alice.id, entry: { text: alice.text } } as unknown as { id: string; text: string };
  assert.throws(() => assertNoLeak(misuse, misuse, "F2-misuse"), /other\.text 必须是字符串/);
  assert.throws(() => assertNoIdLeak({}, "", "F2-misuse-id"), /otherId 不得为空/);
  // 不可序列化结果不得被当作「无泄露」
  assert.throws(() => assertNoLeak(undefined, alice, "F2-unserializable"), /必须可序列化/);
});
