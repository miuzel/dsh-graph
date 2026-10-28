/**
 * g-501：共享卡生命周期能力补齐 —— 零引用共享卡安全删除 + 无模块工具时的保底解除。
 *
 * 覆盖（逐条对应质量判据 / 验收项）：
 *  ① 零引用删除：`deleteCard`（= 工具 `graph_delete_card`）对**零引用共享卡**可直接删除；
 *     **非零引用**仍严格拒绝且不部分修改（卡文件/引用计数/事件流三者都不动）。
 *  ② 保底解除：`shared_cards` 模块在会话中被裁剪关闭时，`graph_delete_card` **不受任何模块开关管理**
 *     ⇒ 仍在模型可见工具面内；其 `detach_only=true` 走与 `graph_detach_shared_card` 同一条 ops 路径
 *     与同一鉴权口径完成解除引用（卡本体保留共享池），**不产生操作死锁**。
 *  ③ 单测覆盖：零引用删除 / 非零引用拒绝 / 模块关闭场景解除；全量闸门自证通过见交付证据。
 *
 * 真源纪律（不复制实现）：
 *  · 工具真源 = `apply(dist/index.js)` **实际注册**的 tool def；描述与 `server-i18n` 字典逐字比对；
 *  · 裁剪真源 = `dsh-graph-host/index.js` 的 `agent/created` → `tools.restrict`（经**与 g-480 同构**的
 *    严格宿主夹具：分层语义 + 作用域过滤 + 校验先于效果，均与真宿主 `dsh-tools` 的 `view()` 一致）；
 *  · 语义真源 = core ops（`deleteCard` / `deleteSharedCard` / `detachSharedCardRef` / `referenceCount`）。
 *
 * 负向对照（文末两条）：在 `core/ops.ts` 的**私有 tmp 副本**上真实变异后实跑 ——
 * 「共享分支改回无条件拒绝」必红、且红因点名零引用判据；「去掉引用计数门禁一概委派删除」必红、且红因点名非零引用判据。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNestedSuiteFailed, assertNestedSuitePassed, runNestedArgv } from "./fixtures/nested-runner.ts";
import {
  init,
  createGoal,
  createSharedCard,
  addSharedCardRef,
  removeSharedCardRef,
  bindCardChild,
  deleteCard,
  detachSharedCardRef,
  referenceCount,
  sharedCards,
  findGoalFile,
  loadGoal,
  validate,
  readProjectConfig,
  resolveModuleSwitches,
  MODULE_TOOL_NAMES,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { SERVER_I18N } from "../../dist/lib/server-i18n.js";
import { apply } from "../../dist/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const HOST = join(repoRoot, "dsh-graph-host");

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 建一个已 init 的看板根目录（core 层用例）。 */
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g501-"));
  init(dir);
  return dir;
}

const sharedFile = (root: string, id: string): string => join(root, "shared-cards", `${id}.md`);

const eventsOf = (root: string, name: string) => readEvents(root).filter((e: any) => e.event === name);

function goalCardIds(root: string, goalId: string): string[] {
  const doc = loadGoal(findGoalFile(root, goalId));
  return Array.isArray(doc.meta.context_cards) ? [...doc.meta.context_cards].map(String) : [];
}

/** 建 workspace + `.dsh-graph/project.yaml`（可带模块开关）+ init。 */
function makeWorkspace(projectYaml = ""): { ws: string; root: string } {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g501-ws-"));
  const root = join(ws, ".dsh-graph");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "project.yaml"), projectYaml);
  init(root);
  return { ws, root };
}

// ---- 宿主夹具（与 g-480 的严格 mock 同构：分层语义 + 作用域过滤 + 校验先于效果）----

type HostMock = {
  ws: string;
  events: Map<string, Function[]>;
  restrictCalls: Array<{ agentId: string; deny: string[] }>;
  ctx: any;
  globalSet: () => Set<string>;
  registered: string[];
  registeredDefs: Map<string, any>;
};

/** 模拟宿主：注册面（apply 期 52 个工具）+ `agent/created` 事件 + 每 agent 独立的 tools 服务。 */
function makeHostMock(ws: string): HostMock {
  const registered: string[] = [];
  const registeredDefs = new Map<string, any>();
  const events = new Map<string, Function[]>();
  const restrictCalls: Array<{ agentId: string; deny: string[] }> = [];
  const globalSet = new Set<string>();
  const ctx: any = {
    get: () => undefined,
    effect: (fn: any) => { if (typeof fn === "function") fn(); return () => {}; },
    tools: {
      register: (def: any) => {
        registered.push(def.name);
        registeredDefs.set(def.name, def);
        globalSet.add(def.name);
        return () => {};
      },
      get: (name: string) => (globalSet.has(name) ? { name } : undefined),
      restrict: () => () => {},
    },
    on: (ev: string, fn: Function) => {
      const arr = events.get(ev) ?? [];
      arr.push(fn);
      events.set(ev, arr);
      return () => {};
    },
  };
  return { ws, events, restrictCalls, ctx, globalSet: () => globalSet, registered, registeredDefs };
}

/** 建 agent 并触发 `agent/created`（`cwd` = 会话 workspace；null ⇒ 无 header.cwd，不裁剪）。 */
function createAgent(h: HostMock, cwd: string | null = h.ws): any {
  const agent: any = { session: { id: "s-g501", header: {} } };
  if (cwd !== null) agent.session.header.cwd = cwd;
  const layers: Array<{ deny: Set<string> }> = [];
  agent.__visible = new Set(h.globalSet());
  agent.ctx = {
    effect: (fn: any) => { const d = typeof fn === "function" ? fn() : undefined; return () => { if (typeof d === "function") d(); }; },
    tools: {
      // 作用域过滤口径：全局存在 且 对该 agent 可见（own 层注册不受 restriction 影响）
      get: (name: string, scope?: any) =>
        (scope ? (scope.__visible.has(name) ? { name } : undefined) : (h.globalSet().has(name) ? { name } : undefined)),
      restrict: (filter: any) => {
        const denyNames: string[] = filter?.deny ?? [];
        // 真源：多名字同时点名 ⇒ 校验先于效果，未知名一律抛错且零副作用
        for (const n of denyNames) {
          if (!h.globalSet().has(n)) throw new Error(`tools.restrict() names unknown global tool "${n}"`);
        }
        const layer = { deny: new Set(denyNames) };
        layers.push(layer);
        h.restrictCalls.push({ agentId: agent.session.id, deny: [...layer.deny] });
        return () => { const at = layers.indexOf(layer); if (at >= 0) layers.splice(at, 1); };
      },
      schemas: () => [...agent.__visible].filter((n) => layers.every((l) => !l.deny.has(n))).map((n) => ({ name: n })),
    },
  };
  for (const fn of h.events.get("agent/created") ?? []) fn({ agent });
  return agent;
}

const schemaNames = (agent: any): string[] => agent.ctx.tools.schemas().map((s: any) => s.name);
const callTool = (h: HostMock, name: string, args: Record<string, unknown>, exec: any) => {
  const def = h.registeredDefs.get(name);
  assert.ok(def, `${name} 未注册`);
  return def.execute(args, { agent: exec, signal: new AbortController().signal });
};

/** 会话身份 = 指定 session id 的 agent（授权按 `created_by` 与 actor 比对）。 */
const execAs = (ws: string, sessionId: string) => ({ id: sessionId, session: { id: sessionId, header: { cwd: ws } } });

// ---------------------------------------------------------------------------
// 判据 1：零引用共享卡可经 deleteCard 显式删除；非零引用严格拒绝
// ---------------------------------------------------------------------------

test("g-501 判据1：零引用共享卡经 deleteCard 显式删除（事件先行、卡文件消失、validate 通过）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "零引用待删", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  removeSharedCardRef(root, a, sid, "test"); // 走完整生命周期后成为零引用
  assert.equal(referenceCount(root, sid), 0, "前置：已零引用");
  assert.ok(existsSync(sharedFile(root, sid)), "前置：卡本体仍在共享池");

  const res = deleteCard(root, a, sid, { actor: "test" });
  assert.equal(res.scope, "shared", "如实回报删除的是共享卡");
  assert.equal(res.refCount, 0, "删除后剩余引用数为 0");
  assert.equal(res.card, sid, "回报被删卡片 id");
  assert.ok(!existsSync(sharedFile(root, sid)), "零引用共享卡已从共享池删除");
  // 走 deleteSharedCard 同一条权威路径 ⇒ 记 card.shared_deleted（不是自有卡的 card.deleted）
  assert.equal(eventsOf(root, "card.shared_deleted").length, 1, "恰记一次 card.shared_deleted");
  assert.equal(eventsOf(root, "card.deleted").length, 0, "不得误记自有卡的 card.deleted");
  assert.deepEqual(validate(root), [], "删除后不变式全绿");
});

test("g-501 判据1（负向）：零引用共享卡删除**不外溢**——不误删共享池其他卡与目标引用", () => {
  const root = tmpRoot();
  const keep = createSharedCard(root, { title: "保留卡", kind: "text", actor: "test" });
  const drop = createSharedCard(root, { title: "待删卡", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, keep, "test");
  addSharedCardRef(root, a, drop, "test");
  removeSharedCardRef(root, a, drop, "test");

  deleteCard(root, a, drop, { actor: "test" });
  assert.ok(!existsSync(sharedFile(root, drop)), "被点名的零引用卡已删");
  assert.ok(existsSync(sharedFile(root, keep)), "未被点名的共享卡不受影响");
  assert.equal(referenceCount(root, keep), 1, "keep 的引用计数不漂移");
  assert.deepEqual(goalCardIds(root, a), [keep], "goal 的 context_cards 仍指向 keep");
  assert.deepEqual(sharedCards(root).map((c: any) => c.id), [keep], "共享池只剩 keep");
  assert.deepEqual(validate(root), []);
});

test("g-501 判据1（负向）：非零引用共享卡严格拒绝——卡文件/引用计数/事件流三者零改动", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "被引用", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const b = createGoal(root, { title: "B", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  addSharedCardRef(root, b, sid, "test");
  const before = JSON.stringify(sharedCards(root));

  assert.throws(() => deleteCard(root, a, sid, { actor: "test" }), /被 2 个 goal 引用，不能删除/);
  assert.ok(existsSync(sharedFile(root, sid)), "被引用 ⇒ 拒绝删除（卡文件仍在）");
  assert.equal(referenceCount(root, sid), 2, "引用计数不因被拒而部分修改");
  assert.deepEqual(goalCardIds(root, a), [sid], "拒绝路径不摘除 A 的引用");
  assert.deepEqual(goalCardIds(root, b), [sid], "拒绝路径不摘除 B 的引用");
  assert.equal(eventsOf(root, "card.shared_deleted").length, 0, "拒绝路径不记删除事件（零副作用）");
  assert.equal(JSON.stringify(sharedCards(root)), before, "共享池内容逐字节不变");
  assert.deepEqual(validate(root), []);
});

test("g-501 判据1：共享卡 collecting 时 deleteCard 仍拒绝（收集守卫不被零引用放行绕过）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "收集中", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  bindCardChild(root, a, sid, { childId: "child-1", actor: "test" });
  assert.equal(loadGoal(sharedFile(root, sid)).meta.status, "collecting", "前置：共享卡处于 collecting");

  assert.throws(() => deleteCard(root, a, sid, { actor: "test" }), /正在收集/);
  assert.ok(existsSync(sharedFile(root, sid)), "collecting ⇒ 拒绝删除（即便零引用亦不可）");
  assert.equal(referenceCount(root, sid), 1, "collecting 拒绝发生在引用计数门禁之前（引用不动）");
  assert.equal(eventsOf(root, "card.shared_deleted").length, 0);
});

// ---------------------------------------------------------------------------
// 判据 2：无模块工具时的保底解除
// ---------------------------------------------------------------------------

test("g-501 判据2：shared_cards 关闭 ⇒ 共享池工具被裁掉，但 graph_delete_card 仍在可见面内", () => {
  const off = makeWorkspace("modules:\n  shared_cards: false\n");
  const h = makeHostMock(off.ws);
  apply(h.ctx, {});
  const agent = createAgent(h, off.ws);
  const names = new Set(schemaNames(agent));

  // ① 共享池专属工具确实被裁剪（真裁剪生效，不是「看起来关了」）
  for (const n of MODULE_TOOL_NAMES.shared_cards) {
    assert.ok(!names.has(n), `${n} 应随 shared_cards 关闭从模型可见面消失`);
  }
  // ② 保底入口仍在：graph_delete_card 不受任何模块开关管理
  assert.ok(names.has("graph_delete_card"), "graph_delete_card 不被模块开关裁剪（保底通道的前提）");
  const managed = new Set<string>(Object.values(MODULE_TOOL_NAMES).flat() as string[]);
  assert.ok(!managed.has("graph_delete_card"), "graph_delete_card 不被任何模块管理（单一真源断言）");
  // ③ 裁剪真源：确实调了 restrict，且 deny 名单 = 该模块受管工具
  assert.equal(h.restrictCalls.length, 1, "恰一次 restrict");
  assert.deepEqual([...h.restrictCalls[0].deny].sort(), [...MODULE_TOOL_NAMES.shared_cards].sort());
});

test("g-501 判据2：模块关闭时用 graph_delete_card detach_only 完成解除引用（卡本体保留、事件同口径）", () => {
  const off = makeWorkspace("modules:\n  shared_cards: false\n");
  const root = off.root;
  const h = makeHostMock(off.ws);
  apply(h.ctx, {});
  const agent = createAgent(h, off.ws);
  const sessionId = "session-owner";
  const goal = createGoal(root, { title: "G", version: "v-t", actor: `agent:${sessionId}` });
  const sid = createSharedCard(root, { title: "保底解除", kind: "text", actor: "test" });
  addSharedCardRef(root, goal, sid, "test");

  // 前置：共享池工具确实不可见（无模块工具），只能走保底通道
  assert.ok(!schemaNames(agent).includes("graph_detach_shared_card"), "前置：graph_detach_shared_card 已被裁剪");

  const out = callTool(h, "graph_delete_card", { goal, card: sid, detach_only: true }, execAs(off.ws, sessionId));
  assert.equal(out.ok, true);
  assert.equal(out.detached, true, "detach_only 明确回报只解除引用");
  assert.equal(out.refCount, 0, "解除后引用计数归零");
  assert.deepEqual(goalCardIds(root, goal), [], "goal 的 context_cards 已摘除该共享卡");
  assert.ok(existsSync(sharedFile(root, sid)), "卡本体保留在共享池（解除 ≠ 删除）");
  assert.equal(eventsOf(root, "card.shared_unreferenced").length, 1, "恰记一次 card.shared_unreferenced（与 graph_detach_shared_card 同口径）");
  assert.equal(eventsOf(root, "card.shared_deleted").length, 0, "解除路径不删除卡");
  assert.deepEqual(validate(root), []);
});

test("g-501 判据2：detach_only 与 graph_detach_shared_card 同一条 ops 路径（落地效果逐字段一致）", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const s1 = createSharedCard(root, { title: "经保底", kind: "text", actor: "test" });
  const s2 = createSharedCard(root, { title: "经权威", kind: "text", actor: "test" });
  addSharedCardRef(root, a, s1, "test");
  addSharedCardRef(root, a, s2, "test");

  const rc = detachSharedCardRef(root, a, s1, "test");
  removeSharedCardRef(root, a, s2, "test");
  assert.equal(rc, referenceCount(root, s1), "保底通道回报的 refCount 与实际一致");
  assert.equal(referenceCount(root, s1), referenceCount(root, s2), "两条路径的引用计数结果一致（都是 0）");
  assert.ok(existsSync(sharedFile(root, s1)) && existsSync(sharedFile(root, s2)), "两条路径都保留卡本体");
  const unref = eventsOf(root, "card.shared_unreferenced");
  assert.equal(unref.length, 2, "两条路径各记一次同型事件");
  assert.deepEqual(unref.map((e: any) => e.details.card).sort(), [s1, s2].sort(), "事件指向各自卡片");
  assert.deepEqual(goalCardIds(root, a), [], "goal 引用已清空");
  assert.deepEqual(validate(root), []);
});

test("g-501 判据2：detach_only 沿用同一鉴权口径——非 owner/非主管拒绝且零副作用", () => {
  const ws = makeWorkspace("");
  const root = ws.root;
  const h = makeHostMock(ws.ws);
  apply(h.ctx, {});
  const goal = createGoal(root, { title: "G", version: "v-t", actor: "agent:owner-session" });
  const sid = createSharedCard(root, { title: "越权", kind: "text", actor: "test" });
  addSharedCardRef(root, goal, sid, "test");

  assert.throws(
    () => callTool(h, "graph_delete_card", { goal, card: sid, detach_only: true }, execAs(ws.ws, "stranger")),
    /无权挂载或解除共享卡引用/,
  );
  assert.equal(referenceCount(root, sid), 1, "越权拒绝 ⇒ 引用计数零改动");
  assert.deepEqual(goalCardIds(root, goal), [sid], "越权拒绝 ⇒ goal 引用不变");
  assert.equal(eventsOf(root, "card.shared_unreferenced").length, 0, "越权拒绝 ⇒ 不记事件");
  assert.ok(existsSync(sharedFile(root, sid)));
});

test("g-501 判据2（负向）：不带 detach_only 时删除被引用的共享卡仍严格拒绝（保底通道不放宽删除门禁）", () => {
  const off = makeWorkspace("modules:\n  shared_cards: false\n");
  const root = off.root;
  const h = makeHostMock(off.ws);
  apply(h.ctx, {});
  const sessionId = "session-owner";
  const goal = createGoal(root, { title: "G", version: "v-t", actor: `agent:${sessionId}` });
  const sid = createSharedCard(root, { title: "仍被引用", kind: "text", actor: "test" });
  addSharedCardRef(root, goal, sid, "test");

  assert.throws(
    () => callTool(h, "graph_delete_card", { goal, card: sid }, execAs(off.ws, sessionId)),
    /被 1 个 goal 引用，不能删除/,
  );
  assert.ok(existsSync(sharedFile(root, sid)), "保底通道不得变成「绕过引用计数删除」");
  assert.equal(referenceCount(root, sid), 1);
  assert.deepEqual(goalCardIds(root, goal), [sid]);
});

// ---------------------------------------------------------------------------
// 判据 3：工具描述真源（server-i18n）与注册面不变式
// ---------------------------------------------------------------------------

test("g-501 判据3：graph_delete_card 描述与 server-i18n 字典一致（zh/en 对称、含新增语义）", () => {
  const ws = makeWorkspace("");
  const h = makeHostMock(ws.ws);
  apply(h.ctx, {});
  const def = h.registeredDefs.get("graph_delete_card")!;
  const dict = SERVER_I18N as unknown as Record<"zh" | "en", Record<string, string>>;

  // 该工具历史上是**字面量**描述（未走 sT）；此处钉住「注册面文案 == i18n 字典」，防两处漂移
  assert.equal(def.description, dict.zh["tool.graph_delete_card"], "zh 注册面描述与字典逐字一致");
  assert.match(def.description, /零引用/, "zh 描述登记零引用可删");
  assert.match(def.description, /detach_only/, "zh 描述登记保底解除开关");
  assert.match(dict.en["tool.graph_delete_card"], /zero references/i, "en 描述登记零引用可删");
  assert.match(dict.en["tool.graph_delete_card"], /detach_only/, "en 描述登记保底解除开关");
  assert.ok(!/[\u4e00-\u9fff]/.test(dict.en["tool.graph_delete_card"]), "en 描述零 CJK");
  // 参数面：detach_only 为可选布尔，required 仍只有 goal/card
  const params = def.parameters ?? {};
  assert.equal(params.properties?.detach_only?.type, "boolean", "detach_only 是布尔参数");
  assert.deepEqual(params.required ?? [], ["goal", "card"], "goal/card 必填，detach_only 可选");
});

test("g-501 判据3：注册面不新增工具名（52 红线）——保底通道复用既有 graph_delete_card 入口", () => {
  const ws = makeWorkspace("");
  const h = makeHostMock(ws.ws);
  apply(h.ctx, {});
  assert.equal(h.registered.length, 52, `注册数应为 52（实得 ${h.registered.length}）`);
  assert.equal(new Set(h.registered).size, h.registered.length, "无重名工具");
  // 未新增共享池专属工具名：否则会被模块映射表的命名面前缀（/_shared_cards?$/）吞并 ⇒ 关模块时保底入口一并消失
  const sharedish = h.registered.filter((n) => /_shared_cards?$/.test(n)).sort();
  const mapped = [...MODULE_TOOL_NAMES.shared_cards].filter((n) => /_shared_cards?$/.test(n)).sort();
  assert.deepEqual(sharedish, mapped, "共享池命名面工具集合不变");
});

test("g-501 判据3：模块开关解析未受影响（shared_cards: false 的 deniedTools 仍是五项，保底入口不在其中）", () => {
  const off = makeWorkspace("modules:\n  shared_cards: false\n");
  const sw = resolveModuleSwitches(readProjectConfig(off.root));
  assert.deepEqual(sw.disabled, ["shared_cards"]);
  assert.deepEqual([...sw.disabledTools].sort(), [...MODULE_TOOL_NAMES.shared_cards].sort());
  assert.ok(!sw.disabledTools.includes("graph_delete_card"), "保底入口不在任何模块的禁用名单里");
});

// ---------------------------------------------------------------------------
// 负向对照：改坏实现必红（在 core 私有 tmp 副本上真实变异 + 子进程实跑）
// ---------------------------------------------------------------------------

/**
 * 在 `deleteCard` **函数体内的共享分支**上做定点变异（不是全文 replace）：
 *   · 先定位 `export function deleteCard(` 的起点，再从其函数体里找共享分支 `if (existsSync(sharedFile)) { … }`；
 *   · 用花括号配平扫描取该 if 块的**精确结束位置**（避免非贪婪正则在全文里跨函数吞掉大段源码 ——
 *     实测该坑会把 `rebuild` 之后的文件内容整段删掉，变异体连语法都不成立）。
 * 返回变异后的全文；未命中变异点则返回原文（由调用方 assert 判为「负向对照空转」）。
 */
function mutateDeleteCardSharedBranch(src: string, replacement: string): string {
  const fnAt = src.indexOf("export function deleteCard(");
  if (fnAt < 0) return src;
  const from = src.indexOf("if (existsSync(sharedFile)) {", fnAt);
  if (from < 0) return src;
  // 花括号配平扫描（从 `{` 开始）取该块结束下标
  const openAt = src.indexOf("{", from);
  let depth = 0;
  let end = -1;
  for (let i = openAt; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return src;
  return src.slice(0, from) + replacement + src.slice(end + 1);
}

/**
 * 变异夹具：把 `core/ops.ts` 的 deleteCard 共享分支定点改坏，在**私有 tmp 副本**上实跑两条核心断言。
 *
 * 三条纪律（都是实测踩坑后的硬约束）：
 *  ① 副本必须带 `prompts/`（core 的提示词资产按 `../prompts/` 相对自身解析）——
 *     否则 `import "./core/ops.ts"` 在**模块加载期**抛错；
 *  ② `node_modules` 用**绝对路径符号链接**（不安装、不写主树）——`cpSync(..., {dereference:false})`
 *     会把相对链接拷成悬空链接 ⇒ 依赖解析失败 ⇒ `node --test` 对该文件**零输出且 exit 0**；
 *  ③ 嵌套 runner **一律经 `core/tests/fixtures/nested-runner.ts`**（g-407 结构性守卫）——
 *     它自带摘除 `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID`、目标集合覆盖断言、以及
 *     「确有 test 级真实失败事件 + 签名匹配」的 fail-closed 裁决，正是本负向对照所需的判别力。
 */
async function withMutantCopy(
  mutate: (src: string) => string,
  body: (work: string) => Promise<void>,
): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "dsh-graph-g501-mut-"));
  try {
    cpSync(join(repoRoot, "core"), join(work, "core"), { recursive: true });
    cpSync(join(repoRoot, "prompts"), join(work, "prompts"), { recursive: true });
    symlinkSync(join(repoRoot, "node_modules"), join(work, "node_modules"));
    const src = readFileSync(join(work, "core", "ops.ts"), "utf8");
    const mutated = mutate(src);
    // 对照组传恒等变异（原文返回）⇒ 只在该情况下跳过「变异必须生效」的断言
    if (mutated !== src) writeFileSync(join(work, "core", "ops.ts"), mutated);
    await body(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** 变异副本里的两条核心断言（相对导入 ⇒ 命中被变异的 ops.ts）。用例名是红因签名面。 */
const PROBE_SRC = `
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, createGoal, createSharedCard, addSharedCardRef, removeSharedCardRef, deleteCard, referenceCount } from "./core/ops.ts";

const tmp = () => { const d = mkdtempSync(join(tmpdir(), "g501-probe-")); init(d); return d; };
const cardFile = (root, id) => join(root, "shared-cards", id + ".md");

test("零引用共享卡经 deleteCard 显式删除", () => {
  const root = tmp();
  const sid = createSharedCard(root, { title: "x", actor: "t" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "t" });
  addSharedCardRef(root, a, sid, "t");
  removeSharedCardRef(root, a, sid, "t");
  assert.equal(referenceCount(root, sid), 0);
  deleteCard(root, a, sid, { actor: "t" });
  assert.equal(existsSync(cardFile(root, sid)), false, "零引用共享卡应被真正删除");
});

test("非零引用共享卡严格拒绝", () => {
  const root = tmp();
  const sid = createSharedCard(root, { title: "y", actor: "t" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "t" });
  addSharedCardRef(root, a, sid, "t");
  assert.throws(() => deleteCard(root, a, sid, { actor: "t" }), /不能删除/);
  assert.equal(referenceCount(root, sid), 1);
  assert.equal(existsSync(cardFile(root, sid)), true, "被引用卡不得被删除");
});
`;

const PROBE_FILE = "probe.test.ts";
const writeProbe = (work: string) => writeFileSync(join(work, PROBE_FILE), PROBE_SRC, "utf8");

/** 未变异副本的对照：两条断言必须真跑完且全绿（否则红因无法归因）。 */
test("g-501 变异夹具自检：未变异副本上探针全绿（负向对照的前提）", async () => {
  await withMutantCopy((src) => src, async (work) => {
    writeProbe(work);
    const control = await runNestedArgv(process.execPath, ["--test", PROBE_FILE], { cwd: work });
    assertNestedSuitePassed(control, "g-501 变异夹具自检（未变异副本）");
    assert.equal(control.summary.pass >= 2, true, "两条探针用例都必须真跑（不得被静默 skip）");
  });
});

test("g-501 负向对照：共享分支改回「无条件拒绝」⇒ 零引用删除用例必红且点名该判据", async () => {
  await withMutantCopy(
    (src) =>
      mutateDeleteCardSharedBranch(
        src,
        'if (existsSync(sharedFile)) {\n    throw new GraphError(`共享卡 ${cardIdSafe} 被 goal 引用，不能删除`);\n  }',
      ),
    async (work) => {
      writeProbe(work);
      const red = await runNestedArgv(process.execPath, ["--test", PROBE_FILE], { cwd: work });
      // fail-closed 裁决：非零退出 + 确有 test 级真实失败事件 + 失败文本匹配签名（不接受「退出码伪装」）
      assertNestedSuiteFailed(red, "g-501 负向对照 A（无条件拒绝零引用共享卡）", /被 goal 引用，不能删除/);
    },
  );
});

test("g-501 负向对照：共享分支改成「一概委派删除」（去掉引用计数门禁）⇒ 非零引用拒绝用例必红且点名该判据", async () => {
  await withMutantCopy(
    (src) =>
      mutateDeleteCardSharedBranch(
        src,
        'if (existsSync(sharedFile)) {\n    rmSync(sharedFile, { force: true });\n    return { card: cardIdSafe, scope: "shared" as CardScope, refCount: 0 };\n  }',
      ),
    async (work) => {
      writeProbe(work);
      const red = await runNestedArgv(process.execPath, ["--test", PROBE_FILE], { cwd: work });
      // 该变异让「被引用卡不得被删除」这条断言失败（assert.equal 的 message 即签名）
      assertNestedSuiteFailed(red, "g-501 负向对照 B（去掉引用计数门禁）", /Missing expected exception/);
    },
  );
});

void HOST;
