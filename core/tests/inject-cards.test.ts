/** g-120：已收集卡片成果注入执行子代理（context_cards 内容注入 + injected_cards 事件）。
 *  验证：① core 读取函数 harvestedCards 按 context_cards 顺序返回 filled/reviewed 卡片
 *  （title+summary+正文全文），跳过 empty/collecting，无成果卡片返回空；
 *  ② 两处执行派发（graph_start_attempt 工具 + /api/dsh-graph/start-execution 端点）的
 *  spawn prompt 注入「已收集上下文卡片成果」段（按序列出 title/summary/正文）；
 *  ③ attempt.started 事件 details 记 injected_cards（注入顺序与成果段一致）；
 *  ④ spawn 提示词附带隔离声明（g-283：task 目标默认不建树 → 声明「本次未启用 worktree 隔离」，绝不强制隔离/预创建）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
  setCriteria,
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
  setCriteria(root, goal, ["质量判据一"], "test");
  const c1 = addCard(root, goal, { title: "甲", kind: "text", actor: "test", scope: "goal" });
  const c2 = addCard(root, goal, { title: "乙", kind: "data", actor: "test", scope: "goal" });
  const c3 = addCard(root, goal, { title: "丙", kind: "text", actor: "test", scope: "goal" });
  const c4 = addCard(root, goal, { title: "丁", kind: "file", actor: "test", scope: "goal" });
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
  addCard(root, goal, { title: "x", kind: "text", actor: "test", scope: "goal" }); // 只有 empty
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

test("g-262：卡片注入段 zh parity、en 标签翻译与非法语言回退", () => {
  const root = tmpRoot();
  const { goal } = goalWithCards(root);
  const zh = formatHarvestedCardsSection(root, goal);
  const en = formatHarvestedCardsSection(root, goal, undefined, undefined, "en");
  const invalid = formatHarvestedCardsSection(root, goal, undefined, undefined, "fr" as "zh");

  // zh 输出保持既有标签与动态用户内容；非法语言等同默认 zh。
  assert.ok(zh.includes("## 已收集上下文卡片成果"));
  assert.ok(zh.includes("摘要：甲摘要"));
  assert.ok(!zh.includes("Attachment references:"));
  assert.equal(invalid, zh);
  // en 只翻译插件固定标签，卡片用户内容原样保留。
  assert.ok(en.includes("## Harvested context card results"));
  assert.ok(en.includes("Summary: 甲摘要") && en.includes("甲正文"));
  assert.ok(!en.includes("g-120 注入"));
  assert.ok(!en.includes("摘要：") && !en.includes("正文为空") && !en.includes("精确路径："));

  const emptyZh = formatHarvestedCardsSection(root, createGoal(root, { title: "empty", version: "v-t", actor: "test" }));
  const emptyEn = formatHarvestedCardsSection(root, createGoal(root, { title: "empty-en", version: "v-t", actor: "test" }), undefined, undefined, "en");
  assert.ok(emptyZh.includes("（无：context_cards"));
  assert.ok(emptyEn.includes("(none: context_cards"));
});

test("g-120：startAttempt 带 injectedCards 时事件 details 记 injected_cards（含空数组）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  const c1 = addCard(root, goal, { title: "a", kind: "text", actor: "test", scope: "goal" });
  const c2 = addCard(root, goal, { title: "b", kind: "text", actor: "test", scope: "goal" });
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
function makeHostCtx(captured: { prompt?: string }, workspace?: string) {
  const routes = new Map<string, any>();
  const registered: any[] = [];
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "sandboxPolicy") return workspace ? { workspaceRoot: workspace } : undefined;
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

/** 断言 prompt 含卡片成果段 + 隔离声明（g-283：task 目标默认不建树 → 「本次未启用 worktree 隔离」，无强制隔离/预建树）。 */
function assertPromptInjected(prompt: string, cards: string[]) {
  assert.ok(prompt.includes("已收集上下文卡片成果"), "prompt 含卡片成果段");
  for (const c of cards) assert.ok(prompt.includes(c), `prompt 含卡片 ${c} 的 id`);
  assert.ok(prompt.includes("本次未启用 worktree 隔离"), "task 目标默认不隔离：prompt 声明本次未启用 worktree 隔离");
  assert.ok(!prompt.includes("【强制 worktree 隔离】"), "task 目标默认不隔离：不得出现强制隔离声明");
  assert.ok(!prompt.includes("预建"), "task 目标默认不隔离：不得出现预建树声明");
  assert.ok(!prompt.includes("git worktree add"), "不再要求子代理自行 add");
}

test("g-120：graph_start_attempt 工具 prompt 注入卡片成果段 + 隔离声明，事件记 injected_cards", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g120-host-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const { goal, c1, c2 } = goalWithCards(root);
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured, ws);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  assert.ok(tool, "graph_start_attempt 已注册");
  const res = await tool.execute({ goal }, execCtx(ws));
  assert.equal(res.child_id, "child-g120");
  assert.deepEqual(res.injected_cards, [c1, c2], "工具返回注入清单");
  assertPromptInjected(captured.prompt!, [c1, c2]);
  const ev = readEvents(root).filter((e) => e.event === "attempt.started" && e.goal === goal);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].details.injected_cards, [c1, c2], "attempt.started 记 injected_cards（按注入顺序）");
});

test("g-120：graph_start_attempt worktree=false 声明未启用隔离但保留卡片注入", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g120-host-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const { goal, c1, c2 } = goalWithCards(root);
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured, ws);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  const res = await tool.execute({ goal, worktree: false }, execCtx(ws));
  assert.deepEqual(res.injected_cards, [c1, c2], "worktree=false 不影响卡片注入（仅声明未启用隔离）");
  assertPromptInjected(captured.prompt!, [c1, c2]);
});

test("g-120：start-execution 端点 prompt 注入卡片成果段 + 隔离声明，事件记 injected_cards", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g120-ep-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const { goal, c1, c2 } = goalWithCards(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const captured: { prompt?: string } = {};
  const { routes } = makeHostCtx(captured, ws);
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
  assertPromptInjected(captured.prompt!, [c1, c2]);
  assert.ok(captured.prompt!.includes("## 目标描述"), "原有目标描述段保留");
  assert.ok(captured.prompt!.includes("## 质量判据"), "原有判据段保留");
  const ev = readEvents(root).filter((e) => e.event === "attempt.started" && e.goal === goal);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].details.injected_cards, [c1, c2]);
});

test("g-120：start-execution 端点 worktree=false 声明未启用隔离；无成果卡时注入空清单", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g120-ep-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const { goal, c1 } = goalWithCards(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const captured: { prompt?: string } = {};
  const { routes } = makeHostCtx(captured, ws);
  const handler = routes.get("/api/dsh-graph/start-execution");
  const req = fakeRequest("POST", { goal, worktree: false });
  req.url = "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal, worktree: false });
  await p;
  assert.equal(res._code, 200);
  assertPromptInjected(captured.prompt!, [c1]);

  // 无成果卡（只有 empty 卡）：注入清单为空、段标题仍在
  const ws2 = mkdtempSync(join(tmpdir(), "dsh-graph-g120-ep2-"));
  const root2 = join(ws2, ".dsh-graph");
  init(root2);
  const goal2 = createGoal(root2, { title: "empty-only", version: "v-t", actor: "test" });
  setCriteria(root2, goal2, ["质量判据一"], "test");
  addCard(root2, goal2, { title: "x", kind: "text", actor: "test", scope: "goal" });
  writeFileSync(join(root2, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const captured2: { prompt?: string } = {};
  const { routes: routes2 } = makeHostCtx(captured2, ws2);
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

test("g-240: 超长单卡注入预算截断，保留摘要、精确路径与 digest 供按需展开", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "超长卡目标", version: "v-t", actor: "test" });
  const c1 = addCard(root, goal, { title: "长文本卡片", kind: "text", actor: "test", scope: "goal" });
  // 构造 3000 字超长正文
  const longText = "这是一段非常长的分析报告内容。".repeat(200);
  fillCard(root, goal, c1, { text: longText, summary: "长文本摘要分析", by: "human:tester", actor: "test" });

  const sec = formatHarvestedCardsSection(root, goal, { maxCardChars: 500 });
  assert.ok(sec.includes("长文本卡片"));
  assert.ok(sec.includes("摘要：长文本摘要分析"));
  assert.ok(sec.includes("⚠️ 正文已超出单卡预算 500 字已截断"), "正文超出单卡预算时被截断");
  assert.ok(sec.includes(`cards/${c1}.md`), "包含精确卡片路径以供按需查阅");
  assert.match(sec, /digest=[a-f0-9]{16}/, "包含卡片内容审计摘要");
  // 确保输出长度受控（远小于 3000 字符）
  assert.ok(sec.length < 1500, "单卡超出预算后注入段长度严格受控");
  const secEn = formatHarvestedCardsSection(root, goal, { maxCardChars: 500 }, undefined, "en");
  assert.ok(secEn.includes("Summary: 长文本摘要分析"));
  assert.ok(secEn.includes("body truncated after exceeding the per-card budget"));
  assert.ok(!secEn.includes("正文已超出单卡预算"));
});

test("g-240: 多卡注入总预算控制与折叠机制，保留附件引用且溢出明确可见可定位", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "多卡目标", version: "v-t", actor: "test" });

  // 创建 10 张卡片，每张正文 300 字符，并附带 @att/ 附件引用
  for (let i = 1; i <= 10; i++) {
    const cardId = addCard(root, goal, { title: `卡片 ${i}`, kind: "text", actor: "test", scope: "goal" });
    fillCard(root, goal, cardId, {
      text: `这是卡片 ${i} 的详细内容。` + "详细正文数据。".repeat(30) + ` 参见附件 @att/doc-${i}.pdf`,
      summary: `卡片 ${i} 的简明摘要`,
      by: "human:tester",
      actor: "test",
    });
  }

  // 限制 maxTotalChars=1000, maxFullCards=2
  const sec = formatHarvestedCardsSection(root, goal, { maxTotalChars: 1000, maxFullCards: 2 });
  assert.ok(sec.includes("卡片 1"));
  assert.ok(sec.includes("卡片 2"));
  // 前面卡片完整展开，后续卡片折叠
  assert.ok(sec.includes("⚠️ 已超出卡片总预算折叠正文"), "超出预算卡片应标注折叠");
  assert.ok(sec.includes("卡片 10"), "第 10 张卡片依然列出，不静默丢失");
  assert.ok(sec.includes("摘要：卡片 10 的简明摘要"), "折叠卡片依然提供摘要");
  assert.ok(sec.includes(`cards/`), "折叠卡片依然提供精确路径以供按需查阅");
  assert.ok(sec.includes("@att/doc-10.pdf"), "折叠卡片依然保留附件引用");
  assert.ok(sec.includes("⚠️ 卡片总预算限制：已完整展开"), "底部输出明确可见的总预算统计说明");

  const secEn = formatHarvestedCardsSection(root, goal, { maxTotalChars: 1000, maxFullCards: 2 }, undefined, "en");
  assert.ok(secEn.includes("Attachment references: @att/doc-10.pdf"));
  assert.ok(secEn.includes("body collapsed after exceeding the total card budget"));
  assert.ok(secEn.includes("Card budget limit:"));
  assert.ok(!secEn.includes("附件引用：") && !secEn.includes("卡片总预算限制"));
});

test("g-240: 卡片精确路径以 .dsh-graph/ 开头且在工作区根相对路径真实可读", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-ws-path-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "路径测试目标", version: "v-t", actor: "test" });
  const c1 = addCard(root, goal, { title: "卡片1", kind: "text", actor: "test", scope: "goal" });
  const longText = "测试内容数据。".repeat(200);
  fillCard(root, goal, c1, { text: longText, summary: "摘要说明", by: "human:tester", actor: "test" });

  const sec = formatHarvestedCardsSection(root, goal, { maxCardChars: 100 });
  // 提取截断提示中的精确路径
  const match = sec.match(/完整内容请读取 ([\S]+)，digest=/);
  assert.ok(match, "应包含精确卡片路径");
  const cardRelPath = match[1];
  assert.ok(cardRelPath.startsWith(".dsh-graph/"), `卡片路径必须以 .dsh-graph/ 开头，当前为: ${cardRelPath}`);

  // 验证在工作区根拼接后真实存在且可读取
  const fullPath = join(ws, cardRelPath);
  assert.ok(existsSync(fullPath), `拼接工作区路径后文件必须存在: ${fullPath}`);
  const content = readFileSync(fullPath, "utf8");
  assert.ok(content.includes("测试内容数据。"), "从该精确路径可读取到卡片原始内容");
});
