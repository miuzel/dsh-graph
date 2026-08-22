/** g-120：已收集卡片成果注入执行子代理（context_cards 内容注入 + injected_cards 事件）。
 *  验证：① core 读取函数 harvestedCards 按 context_cards 顺序返回 filled/reviewed 卡片
 *  （title+summary+正文全文），跳过 empty/collecting，无成果卡片返回空；
 *  ② 两处执行派发（graph_start_attempt 工具 + /api/dsh-graph/start-execution 端点）的
 *  spawn prompt 注入「已收集上下文卡片成果」段（按序列出 title/summary/正文）；
 *  ③ attempt.started 事件 details 记 injected_cards（注入顺序与成果段一致）；
 *  ④ spawn 提示词附带 worktree 隔离指令（默认注入、worktree=false 省略、含数据分工）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  addCard,
  fillCard,
  reviewCard,
  bindCardChild,
  harvestedCards,
  formatHarvestedCardsSection,
  startAttempt,
  findGoalFile,
  loadGoal,
} from "../ops.ts";
import { serializeDoc } from "../model.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dsh-graph-host/index.js";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g120-"));
  init(dir);
  return dir;
}

/** 造一个带 4 张卡的目标：c1=filled、c2=filled+reviewed、c3=empty、c4=collecting。 */
function goalWithCards(root: string): { goal: string; c1: string; c2: string; c3: string; c4: string } {
  const goal = createGoal(root, { title: "g120 目标", version: "v-t", actor: "test" });
  const c1 = addCard(root, goal, { title: "甲", kind: "text", actor: "test" });
  const c2 = addCard(root, goal, { title: "乙", kind: "data", actor: "test" });
  const c3 = addCard(root, goal, { title: "丙", kind: "text", actor: "test" });
  const c4 = addCard(root, goal, { title: "丁", kind: "file", actor: "test" });
  fillCard(root, goal, c1, { text: "甲正文", summary: "甲摘要", by: "human:a", actor: "test" });
  fillCard(root, goal, c2, { text: "乙正文", summary: "乙摘要", by: "human:a", actor: "test" });
  reviewCard(root, goal, c2, { by: "human:b", actor: "test" });
  bindCardChild(root, goal, c4, { childId: "child-c", parentSessionId: "sess-c", actor: "test" });
  return { goal, c1, c2, c3, c4 };
}

// ---- ① core 读取函数 ----

test("g-120：harvestedCards 按 context_cards 顺序返回 filled/reviewed（title+summary+正文），跳过 empty/collecting", () => {
  const root = tmpRoot();
  const { goal, c1, c2 } = goalWithCards(root);
  const got = harvestedCards(root, goal);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((c) => c.id), [c1, c2]);
  assert.equal(got[0].title, "甲");
  assert.equal(got[0].status, "filled");
  assert.equal(got[0].summary, "甲摘要");
  assert.ok(got[0].content.includes("甲正文"), "正文全文随卡注入");
  assert.equal(got[1].title, "乙");
  assert.equal(got[1].status, "reviewed");
  assert.equal(got[1].summary, "乙摘要");
  assert.ok(got[1].content.includes("乙正文"));
});

test("g-120：harvestedCards 顺序取自 meta.context_cards（乱序/文件系统顺序无关）", () => {
  const root = tmpRoot();
  const { goal, c1, c2, c3 } = goalWithCards(root);
  // 把 context_cards 打乱成 [c3(empty), c2(reviewed), c1(filled)]：empty 在最前也应被跳过，
  // 返回顺序 = 过滤后的 context_cards 顺序
  const file = findGoalFile(root, goal);
  const doc = loadGoal(file);
  doc.meta.context_cards = [c3, c2, c1];
  writeFileSync(file, serializeDoc(doc), "utf8");
  const got = harvestedCards(root, goal);
  assert.deepEqual(got.map((c) => c.id), [c2, c1]);
});

test("g-120：harvestedCards 无成果卡片返回空；formatHarvestedCardsSection 无卡时给「（无）」段", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "t2", version: "v-t", actor: "test" });
  addCard(root, goal, { title: "x", kind: "text", actor: "test" }); // 只有 empty
  assert.deepEqual(harvestedCards(root, goal), []);
  const sec = formatHarvestedCardsSection(root, goal);
  assert.ok(sec.includes("已收集上下文卡片成果"), "无卡也注入段标题");
  assert.ok(sec.includes("（无"), "无卡时说明无成果可复用");
});

test("g-120：formatHarvestedCardsSection 按序含 title/summary/正文全文", () => {
  const root = tmpRoot();
  const { goal, c1, c2 } = goalWithCards(root);
  const sec = formatHarvestedCardsSection(root, goal);
  assert.ok(sec.includes("已收集上下文卡片成果"));
  const i1 = sec.indexOf("**甲**");
  const i2 = sec.indexOf("**乙**");
  assert.ok(i1 >= 0 && i2 >= 0 && i1 < i2, "卡片按 context_cards 顺序列出");
  assert.ok(sec.includes("摘要：甲摘要"), "含 summary");
  assert.ok(sec.includes("甲正文") && sec.includes("乙正文"), "含正文全文");
  assert.ok(sec.includes(c1) && sec.includes(c2), "含卡片 id（子代理无需猜路径）");
});

test("g-120：startAttempt 带 injectedCards 时事件 details 记 injected_cards（含空数组）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  const c1 = addCard(root, goal, { title: "a", kind: "text", actor: "test" });
  const c2 = addCard(root, goal, { title: "b", kind: "text", actor: "test" });
  startAttempt(root, goal, { executor: "agent:t", actor: "test", injectedCards: [c2, c1] });
  const ev = readEvents(root).filter((e) => e.event === "attempt.started");
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].details.injected_cards, [c2, c1], "按注入顺序记录");
  // 不传 injectedCards → 事件不含该键（CLI/收集派发路径不注入）
  const root2 = tmpRoot();
  const g2 = createGoal(root2, { title: "u", version: "v-t", actor: "test" });
  startAttempt(root2, g2, { executor: "agent:t", actor: "test" });
  const ev2 = readEvents(root2).find((e) => e.event === "attempt.started");
  assert.ok(!("injected_cards" in ev2!.details));
});

// ---- ②③④ host 两处派发 ----

function fakeRequest(method: string, body: unknown) {
  const req: any = {
    method,
    _listeners: {} as Record<string, (v?: any) => void>,
    on(ev: string, cb: (v?: any) => void) { req._listeners[ev] = cb; },
  };
  return req;
}

function emitBody(req: any, body: unknown) {
  req._listeners.data?.(JSON.stringify(body));
  req._listeners.end?.();
}

function fakeResponse() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}

/** 构造带 subagents/agents/webServer stub 的 ctx：捕获两处派发实际送入子代理的 prompt。 */
function makeHostCtx(captured: { prompt?: string }) {
  const routes = new Map<string, any>();
  const registered: any[] = [];
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "subagents") return {
        list: () => ["spawn"],
        getProvider: () => ({ prepareContinuable: () => {} }),
        startContinuable: async (opts: any) => {
          captured.prompt = opts.request?.prompt?.[0]?.text ?? "";
          return { childId: "child-g120" };
        },
      };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, {});
  return { routes, registered };
}

function execCtx(ws: string) {
  return { agent: { session: { id: "sess-exec", header: { cwd: ws } } }, signal: new AbortController().signal };
}

/** 断言 prompt 含卡片成果段 + worktree 指令（或按 wantWorktree 断言省略），并返回注入清单。 */
function assertPromptInjected(prompt: string, cards: string[], wantWorktree: boolean) {
  assert.ok(prompt.includes("已收集上下文卡片成果"), "prompt 含卡片成果段");
  for (const c of cards) assert.ok(prompt.includes(c), `prompt 含卡片 ${c} 的 id`);
  if (wantWorktree) {
    assert.ok(prompt.includes("worktree 隔离"), "prompt 默认附带 worktree 指令");
    assert.ok(prompt.includes("git worktree add"), "worktree 指令含 add 用法");
    assert.ok(prompt.includes(".dsh-graph/"), "worktree 指令含 .dsh-graph 数据分工");
    assert.ok(prompt.includes("主工作树写"), "worktree 指令明确看板数据仍在主工作树写");
  } else {
    assert.ok(!prompt.includes("worktree 隔离"), "worktree=false 时 prompt 省略 worktree 指令");
  }
}

test("g-120：graph_start_attempt 工具 prompt 注入卡片成果段 + worktree 指令，事件记 injected_cards", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g120-host-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const { goal, c1, c2 } = goalWithCards(root);
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  assert.ok(tool, "graph_start_attempt 已注册");
  const res = await tool.execute({ goal }, execCtx(ws));
  assert.equal(res.child_id, "child-g120");
  assert.deepEqual(res.injected_cards, [c1, c2], "工具返回注入清单");
  assertPromptInjected(captured.prompt!, [c1, c2], true);
  const ev = readEvents(root).filter((e) => e.event === "attempt.started" && e.goal === goal);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].details.injected_cards, [c1, c2], "attempt.started 记 injected_cards（按注入顺序）");
});

test("g-120：graph_start_attempt worktree=false 省略 worktree 指令但保留卡片注入", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g120-host-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const { goal, c1, c2 } = goalWithCards(root);
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  const res = await tool.execute({ goal, worktree: false }, execCtx(ws));
  assert.deepEqual(res.injected_cards, [c1, c2], "worktree=false 不影响卡片注入（仅省略 worktree 指令）");
  assertPromptInjected(captured.prompt!, [c1, c2], false);
});

test("g-120：start-execution 端点 prompt 注入卡片成果段 + worktree 指令，事件记 injected_cards", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g120-ep-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const { goal, c1, c2 } = goalWithCards(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const captured: { prompt?: string } = {};
  const { routes } = makeHostCtx(captured);
  const handler = routes.get("/api/dsh-graph/start-execution");
  assert.ok(handler, "start-execution 路由已注册");
  const req = fakeRequest("POST", { goal });
  req.url = "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal });
  await p;
  assert.equal(res._code, 200);
  assert.equal(res._body.ok, true);
  assert.deepEqual(res._body.injected_cards, [c1, c2], "端点响应带注入清单");
  assertPromptInjected(captured.prompt!, [c1, c2], true);
  assert.ok(captured.prompt!.includes("## 目标描述"), "原有目标描述段保留");
  assert.ok(captured.prompt!.includes("## 质量判据"), "原有判据段保留");
  const ev = readEvents(root).filter((e) => e.event === "attempt.started" && e.goal === goal);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].details.injected_cards, [c1, c2]);
});

test("g-120：start-execution 端点 worktree=false 省略 worktree 指令；无成果卡时注入空清单", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g120-ep-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const { goal, c1 } = goalWithCards(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const captured: { prompt?: string } = {};
  const { routes } = makeHostCtx(captured);
  const handler = routes.get("/api/dsh-graph/start-execution");
  const req = fakeRequest("POST", { goal, worktree: false });
  req.url = "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal, worktree: false });
  await p;
  assert.equal(res._code, 200);
  assertPromptInjected(captured.prompt!, [c1], false);

  // 无成果卡（只有 empty 卡）：注入清单为空、段标题仍在
  const ws2 = mkdtempSync(join(tmpdir(), "dsh-graph-g120-ep2-"));
  const root2 = join(ws2, ".dsh-graph");
  init(root2);
  const goal2 = createGoal(root2, { title: "empty-only", version: "v-t", actor: "test" });
  addCard(root2, goal2, { title: "x", kind: "text", actor: "test" });
  writeFileSync(join(root2, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const captured2: { prompt?: string } = {};
  const { routes: routes2 } = makeHostCtx(captured2);
  const handler2 = routes2.get("/api/dsh-graph/start-execution");
  const req2 = fakeRequest("POST", { goal: goal2 });
  req2.url = "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws2);
  const res2 = fakeResponse();
  const p2 = handler2(req2, res2);
  emitBody(req2, { goal: goal2 });
  await p2;
  assert.equal(res2._code, 200);
  assert.deepEqual(res2._body.injected_cards, [], "无成果卡 → 空注入清单");
  assert.ok(captured2.prompt!.includes("已收集上下文卡片成果"), "prompt 仍含成果段标题");
  assert.ok(captured2.prompt!.includes("（无"), "prompt 说明无成果可复用");
});
