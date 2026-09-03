/**
 * g-194：attempt/card frontmatter 中持久化 provider 与 model 元数据，
 * 消除 LiveStrip 跨 session routing 错误，完善安全降级与前端展示。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  init,
  createGoal,
  addCard,
  startAttempt,
  bindAttemptChild,
  bindCardChild,
  loadGoal,
  findGoalFile,
  goalDetail,
  goalCards,
  boardPayload,
  resolveModelRoute,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dsh-graph-host/index.js";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g194-"));
  init(dir);
  return dir;
}

function dirname(p: string): string {
  return p.substring(0, p.lastIndexOf("/"));
}

test("g-194 ① startAttempt 与 bindAttemptChild 持久化 provider 与 model 到 attempt.md 及事件流", () => {
  const root = tmpRoot();
  const goalId = createGoal(root, { title: "测试模型元数据", version: "v1.0", actor: "human:gui" });
  // 1. 显式传入 provider, model, modelRoute
  const att1 = startAttempt(root, goalId, {
    executor: "agent:test",
    actor: "human:gui",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    modelRoute: "deepseek/deepseek-v4-pro",
  });

  const goalFile = findGoalFile(root, goalId);
  const att1File = join(goalFile.replace(/goal\.md$/, ""), "attempts", att1, "attempt.md");
  const doc1 = loadGoal(att1File);
  assert.equal(doc1.meta.provider, "deepseek");
  assert.equal(doc1.meta.model, "deepseek-v4-pro");
  assert.equal(doc1.meta.model_route, "deepseek/deepseek-v4-pro");

  // 检查 attempt.started 事件
  const evStarted = readEvents(root).find((e) => e.event === "attempt.started" && e.details.attempt === att1);
  assert.ok(evStarted);
  assert.equal(evStarted.details.provider, "deepseek");
  assert.equal(evStarted.details.model, "deepseek-v4-pro");
  assert.equal(evStarted.details.model_route, "deepseek/deepseek-v4-pro");

  // 2. 绑定 child
  bindAttemptChild(root, goalId, att1, "child-123", "human:gui", "parent-456", "deepseek", "deepseek-v4-pro", "deepseek/deepseek-v4-pro");
  const doc1AfterBind = loadGoal(att1File);
  assert.equal(doc1AfterBind.meta.child_id, "child-123");
  assert.equal(doc1AfterBind.meta.parent_session_id, "parent-456");
  assert.equal(doc1AfterBind.meta.provider, "deepseek");
  assert.equal(doc1AfterBind.meta.model, "deepseek-v4-pro");

  // 检查 attempt.bound 事件
  const evBound = readEvents(root).find((e) => e.event === "attempt.bound" && e.details.attempt === att1);
  assert.ok(evBound);
  assert.equal(evBound.details.child_id, "child-123");
  assert.equal(evBound.details.provider, "deepseek");
  assert.equal(evBound.details.model, "deepseek-v4-pro");
  assert.equal(evBound.details.model_route, "deepseek/deepseek-v4-pro");
});

test("g-194 ② bindCardChild 持久化 provider 与 model 到 card.md 及事件流", () => {
  const root = tmpRoot();
  const goalId = createGoal(root, { title: "测试卡片模型元数据", version: "v1.0", actor: "human:gui" });
  const cardId = addCard(root, goalId, { title: "调研卡片", kind: "text", actor: "human:gui" });

  bindCardChild(root, goalId, cardId, {
    childId: "child-card-1",
    parentSessionId: "parent-card-1",
    actor: "human:gui",
    provider: "kimi",
    model: "moonshot-v1-auto",
  });

  const goalFile = findGoalFile(root, goalId);
  const cardFile = join(goalFile.replace(/goal\.md$/, ""), "cards", `${cardId}.md`);
  const cardDoc = loadGoal(cardFile);
  assert.equal(cardDoc.meta.child_id, "child-card-1");
  assert.equal(cardDoc.meta.parent_session_id, "parent-card-1");
  assert.equal(cardDoc.meta.provider, "kimi");
  assert.equal(cardDoc.meta.model, "moonshot-v1-auto");

  // 检查 card.collecting 事件
  const ev = readEvents(root).find((e) => e.event === "card.collecting" && e.details.card === cardId);
  assert.ok(ev);
  assert.equal(ev.details.child_id, "child-card-1");
  assert.equal(ev.details.provider, "kimi");
  assert.equal(ev.details.model, "moonshot-v1-auto");
});

test("g-194 ③ boardPayload 与 goalDetail 正确暴露 attempt 与 card 的 provider/model 字段", () => {
  const root = tmpRoot();
  const goalId = createGoal(root, { title: "测试看板暴露", version: "v1.0", actor: "human:gui" });
  const cardId = addCard(root, goalId, { title: "调研卡片", kind: "text", actor: "human:gui" });

  bindCardChild(root, goalId, cardId, {
    childId: "child-c",
    parentSessionId: "parent-c",
    actor: "human:gui",
    provider: "p-card",
    model: "m-card",
  });

  const attId = startAttempt(root, goalId, {
    executor: "agent:test",
    actor: "human:gui",
    provider: "p-att",
    model: "m-att",
    modelRoute: "p-att/m-att",
  });
  bindAttemptChild(root, goalId, attId, "child-a", "human:gui", "parent-a", "p-att", "m-att", "p-att/m-att");

  // 1. 验证 boardPayload
  const payload = boardPayload(root);
  const ver = payload.versions.find((v) => v.slug === "v1.0");
  const goalInBoard = ver?.goals.find((g) => g.id === goalId);
  assert.ok(goalInBoard);
  assert.equal(goalInBoard.attempt_child_id, "child-a");
  assert.equal(goalInBoard.attempt_parent_session_id, "parent-a");
  assert.equal(goalInBoard.attempt_provider, "p-att");
  assert.equal(goalInBoard.attempt_model, "m-att");

  const cardInBoard = goalInBoard.cards?.find((c) => c.id === cardId);
  assert.ok(cardInBoard);
  assert.equal(cardInBoard.provider, "p-card");
  assert.equal(cardInBoard.model, "m-card");

  // 2. 验证 goalDetail
  const detail = goalDetail(root, goalId);
  const attInDetail = detail.attempts.find((a: any) => a.id === attId);
  assert.ok(attInDetail);
  assert.equal(attInDetail.provider, "p-att");
  assert.equal(attInDetail.model, "m-att");
  assert.equal(attInDetail.model_route, "p-att/m-att");

  const cardInDetail = detail.cards.find((c: any) => c.id === cardId);
  assert.ok(cardInDetail);
  assert.equal(cardInDetail.provider, "p-card");
  assert.equal(cardInDetail.model, "m-card");
});

test("g-194 ④ 历史 attempt / card 缺少 provider / model 字段时安全降级不崩溃", () => {
  const root = tmpRoot();
  const goalId = createGoal(root, { title: "测试历史兼容", version: "v1.0", actor: "human:gui" });
  const cardId = addCard(root, goalId, { title: "旧卡片", kind: "text", actor: "human:gui" });

  // 历史老版本调用方式（无 provider / model）
  const attId = startAttempt(root, goalId, { executor: "agent:old", actor: "human:gui" });
  bindAttemptChild(root, goalId, attId, "child-old", "human:gui", "parent-old");
  bindCardChild(root, goalId, cardId, { childId: "child-card-old", parentSessionId: "parent-card-old", actor: "human:gui" });

  const payload = boardPayload(root);
  const goalInBoard = payload.versions[0].goals[0];
  assert.equal(goalInBoard.attempt_provider, null);
  assert.equal(goalInBoard.attempt_model, null);
  assert.equal(goalInBoard.cards?.[0].provider, null);
  assert.equal(goalInBoard.cards?.[0].model, null);

  const detail = goalDetail(root, goalId);
  assert.equal(detail.attempts[0].provider, null);
  assert.equal(detail.attempts[0].model, null);
  assert.equal(detail.attempts[0].model_route, null);
  assert.equal(detail.cards[0].provider, null);
  assert.equal(detail.cards[0].model, null);
});

test("g-194 ⑤ 三条 spawn 路径（graph_start_attempt / start-execution / start-collection）均持久化解析后路由", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g194-ws-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: s1\nexecutor:\n  provider: proj-p\n  model: proj-m\n");
  const goalId = createGoal(root, { title: "测试三条派发路径", version: "v1.0", actor: "human:gui" });
  const cardId = addCard(root, goalId, { title: "派发卡片", kind: "text", actor: "human:gui" });

  let registeredTools: any[] = [];
  let registeredRoutes = new Map<string, any>();
  const webServer = { register: (def: any) => { registeredRoutes.set(def.path, def.handler); return () => {}; } };
  const ctx = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "s1" }) };
      if (name === "subagents") {
        return {
          list: () => ["spawn"],
          getProvider: () => ({ prepareContinuable: () => {} }),
          startContinuable: async (opts: any) => {
            return { childId: "child-mock-" + Math.random().toString(36).slice(2, 6) };
          },
        };
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: {
      register: (def: any) => { registeredTools.push(def); return () => {}; },
      get: () => ({}),
    },
  };
  apply(ctx as any, { root });

  const toolsByName = new Map(registeredTools.map((t) => [t.name, t]));
  const execContext = {
    agent: { id: "a1", session: { header: { cwd: ws }, id: "s1" } },
    signal: new AbortController().signal,
  };

  // 1. graph_start_attempt (带 override)
  const toolRes = await toolsByName.get("graph_start_attempt")!.execute(
    { goal: goalId, provider: "tool-p", model: "tool-m" },
    execContext,
  );
  assert.equal(toolRes.model_route, "tool-p/tool-m");
  const detail1 = goalDetail(root, goalId);
  const att1 = detail1.attempts.find((a: any) => a.id === toolRes.attempt);
  assert.equal(att1.provider, "tool-p");
  assert.equal(att1.model, "tool-m");
  assert.equal(att1.model_route, "tool-p/tool-m");

  function fakeReq(method: string, queryParams: string, body: any) {
    const listeners: Record<string, Function> = {};
    return {
      method,
      url: queryParams,
      on: (e: string, fn: Function) => { listeners[e] = fn; },
      _emit: () => {
        listeners.data?.(JSON.stringify(body));
        listeners.end?.();
      },
    };
  }

  function fakeRes() {
    const res: any = { _code: 0, _body: null };
    res.writeHead = (code: number) => { res._code = code; };
    res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
    return res;
  }

  // 2. start-execution REST 端点 (缺省继承 project.yaml)
  const execHandler = registeredRoutes.get("/api/dsh-graph/start-execution");
  assert.ok(execHandler, "start-execution 已注册");
  const req2 = fakeReq("POST", "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws), { goal: goalId });
  const res2 = fakeRes();
  const p2 = execHandler(req2, res2);
  req2._emit();
  await p2;
  assert.ok(res2._body?.ok);
  assert.equal(res2._body.model_route, "proj-p/proj-m");
  const detail2 = goalDetail(root, goalId);
  const att2 = detail2.attempts.find((a: any) => a.id === res2._body.attempt);
  assert.equal(att2.provider, "proj-p");
  assert.equal(att2.model, "proj-m");
  assert.equal(att2.model_route, "proj-p/proj-m");

  // 3. start-collection REST 端点 (显式指定)
  const collectHandler = registeredRoutes.get("/api/dsh-graph/start-collection");
  assert.ok(collectHandler, "start-collection 已注册");
  const req3 = fakeReq("POST", "/api/dsh-graph/start-collection?workspace=" + encodeURIComponent(ws), { goal: goalId, card: cardId, provider: "col-p", model: "col-m" });
  const res3 = fakeRes();
  const p3 = collectHandler(req3, res3);
  req3._emit();
  await p3;
  assert.ok(res3._body?.ok);
  assert.equal(res3._body.model_route, "col-p/col-m");
  const detail3 = goalDetail(root, goalId);
  const card3 = detail3.cards.find((c: any) => c.id === cardId);
  assert.equal(card3.provider, "col-p");
  assert.equal(card3.model, "col-m");
});

test("g-194 ⑥ 前端 formatModelDisplay / formatShortModelDisplay 与 client.js bundle 契约校验", () => {
  const clientBundle = readFileSync(new URL("../../dsh-graph-host/lib/client.js", import.meta.url), "utf8");
  // 确保 generated header 存在
  assert.match(clientBundle, /⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY/);
  // 确保 formatModelDisplay 与 formatShortModelDisplay 存在
  assert.match(clientBundle, /function formatModelDisplay/);
  assert.match(clientBundle, /function formatShortModelDisplay/);
  // 确保过滤 owned by subagent routing 等内部错误
  assert.match(clientBundle, /owned by subagent routing/);
  assert.match(clientBundle, /默认配置\/未指定/);
  // 确保 LiveStrip 与 SessionPanel 接收并渲染 provider / model 属性
  assert.match(clientBundle, /provider: staticProvider, model: staticModel/);
});
