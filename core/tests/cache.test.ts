import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  init,
  createGoal,
  setCriteria,
  transition,
  addCard,
  fillCard,
  startAttempt,
  archiveGoal,
  renameGoal,
  setGoalType,
  boardPayload,
  getCachedBoardPayload,
  computeGraphRevision,
  invalidateBoardCache,
  formatETag,
  matchIfNoneMatch,
  _inspectBoardCache,
  writeHandoff,
} from "../../dsh-graph-host/core/ops.js";
import { apply } from "../../dsh-graph-host/index.js";

function setupTempGraph() {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-cache-test-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  return {
    ws,
    root,
    cleanup: () => {
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch {}
    },
  };
}

function setupHostApp(workspace?: string) {
  const routes = new Map<string, Function>();
  const webServer = {
    register: (def: any) => {
      routes.set(def.path, def.handler);
      return () => {};
    },
  };
  const mockCtx = {
    inject: () => mockCtx,
    effect: (fn: any) => fn(),
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "sandboxPolicy") return workspace ? { workspaceRoot: workspace } : null;
      return null;
    },
    tools: {
      register: () => {},
    },
    webServer,
  };
  apply(mockCtx as any);
  return routes;
}

function fakeResponse() {
  const res = {
    _code: 0,
    _headers: {} as Record<string, string>,
    _body: null as any,
    _rawBody: "",
    writeHead(code: number, headers?: Record<string, string>) {
      res._code = code;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    end(data?: string) {
      if (data) {
        res._rawBody = data;
        try {
          res._body = JSON.parse(data);
        } catch {
          res._body = data;
        }
      }
      return res;
    },
  };
  return res;
}

test("g-212 判据 1：首次 GET /api/dsh-graph 返回 200、完整看板数据和 ETag；携带匹配 If-None-Match 返回 304 且 body 为空", async () => {
  const { ws, root, cleanup } = setupTempGraph();
  try {
    createGoal(root, { title: "测试目标1", actor: "test" });
    const routes = setupHostApp(ws);
    const handler = routes.get("/api/dsh-graph");
    assert.ok(handler, "GET /api/dsh-graph 必须已注册");

    // 1. 首次 GET，无 If-None-Match
    const res1 = fakeResponse();
    handler({ method: "GET", url: `/api/dsh-graph?workspace=${encodeURIComponent(ws)}`, headers: {} }, res1);
    assert.equal(res1._code, 200);
    assert.ok(res1._body, "首次响应有 body");
    assert.equal(res1._body.backlog.length, 1);
    const etag1 = res1._headers["etag"];
    assert.ok(etag1 && etag1.startsWith('W/"'), "响应应包含有效弱 ETag");

    // 2. 携带相同 If-None-Match 请求
    const res2 = fakeResponse();
    handler(
      {
        method: "GET",
        url: `/api/dsh-graph?workspace=${encodeURIComponent(ws)}`,
        headers: { "if-none-match": etag1 },
      },
      res2,
    );
    assert.equal(res2._code, 304, "命中 ETag 应返回 304");
    assert.equal(res2._rawBody, "", "304 body 必须为空");
    assert.equal(res2._headers["etag"], etag1);

    // 3. 携带不匹配的 If-None-Match 请求
    const res3 = fakeResponse();
    handler(
      {
        method: "GET",
        url: `/api/dsh-graph?workspace=${encodeURIComponent(ws)}`,
        headers: { "if-none-match": 'W/"different-etag"' },
      },
      res3,
    );
    assert.equal(res3._code, 200, "ETag 不匹配应返回 200 最新数据");
    assert.ok(res3._body);
  } finally {
    cleanup();
  }
});

test("g-212 判据 2：内存投影缓存按 canonical graph root 与 includeArchived 维度隔离，无变更复用缓存", () => {
  const g1 = setupTempGraph();
  const g2 = setupTempGraph();
  try {
    createGoal(g1.root, { title: "G1 目标", actor: "test" });
    createGoal(g2.root, { title: "G2 目标", actor: "test" });

    // g1 includeArchived=false
    const resG1 = getCachedBoardPayload(g1.root, { includeArchived: false });
    assert.equal(resG1.fromCache, false, "g1 首次读取非缓存");

    // g1 includeArchived=false 再次读取
    const resG1Repeat = getCachedBoardPayload(g1.root, { includeArchived: false });
    assert.equal(resG1Repeat.fromCache, true, "g1 重复读取命中缓存");
    assert.equal(resG1Repeat.etag, resG1.etag);

    // g1 includeArchived=true (不同维度)
    const resG1Archived = getCachedBoardPayload(g1.root, { includeArchived: true });
    assert.equal(resG1Archived.fromCache, false, "g1 includeArchived=true 首次读取非缓存");

    // g2 (不同 root)
    const resG2 = getCachedBoardPayload(g2.root, { includeArchived: false });
    assert.equal(resG2.fromCache, false, "g2 首次读取非缓存");
    assert.notEqual(resG2.etag, resG1.etag, "不同 root 的 ETag 互相隔离且不同");
    assert.equal(resG2.payload.backlog[0].title, "G2 目标");
    assert.equal(resG1.payload.backlog[0].title, "G1 目标");
  } finally {
    g1.cleanup();
    g2.cleanup();
  }
});

test("g-212 判据 3：REST/Core 写操作完成后主动失效对应缓存，下一次请求返回 200 和新 ETag", async () => {
  const { ws, root, cleanup } = setupTempGraph();
  try {
    const goalId = createGoal(root, { title: "初始目标", actor: "test" });
    const routes = setupHostApp(ws);
    const handler = routes.get("/api/dsh-graph");

    const res1 = fakeResponse();
    handler({ method: "GET", url: `/api/dsh-graph?workspace=${encodeURIComponent(ws)}`, headers: {} }, res1);
    const etag1 = res1._headers["etag"];

    // 执行 Core 写操作：renameGoal
    renameGoal(root, goalId, { title: "已重命名目标", actor: "test" });

    // 携带旧 ETag 请求
    const res2 = fakeResponse();
    handler(
      {
        method: "GET",
        url: `/api/dsh-graph?workspace=${encodeURIComponent(ws)}`,
        headers: { "if-none-match": etag1 },
      },
      res2,
    );
    assert.equal(res2._code, 200, "写操作后旧 ETag 请求必须返回 200");
    assert.equal(res2._body.backlog[0].title, "已重命名目标");
    const etag2 = res2._headers["etag"];
    assert.notEqual(etag2, etag1, "写操作后 ETag 必须更新");

    // 再次测试 POST /api/dsh-graph/order 写操作端点失效
    const orderHandler = routes.get("/api/dsh-graph/order");
    const orderReq = {
      method: "POST",
      url: `/api/dsh-graph/order?workspace=${encodeURIComponent(ws)}`,
      on: (event: string, cb: any) => {
        if (event === "data") cb(JSON.stringify({ "backlog|backlog": [goalId] }));
        if (event === "end") cb();
      },
    };
    const orderRes = fakeResponse();
    await orderHandler(orderReq, orderRes);
    assert.equal(orderRes._code, 200);

    // 再次请求
    const res3 = fakeResponse();
    handler(
      {
        method: "GET",
        url: `/api/dsh-graph?workspace=${encodeURIComponent(ws)}`,
        headers: { "if-none-match": etag2 },
      },
      res3,
    );
    assert.equal(res3._code, 200, "order 更新后旧 ETag 必须失效并返回 200");
    const etag3 = res3._headers["etag"];
    assert.notEqual(etag3, etag2);
  } finally {
    cleanup();
  }
});

test("g-212 判据 4：外部直接修改 events.jsonl/goal.md/order.json/project.yaml 感知文件 revision 变化并返回最新数据", async () => {
  const waitWatcher = () => new Promise((r) => setTimeout(r, 50));
  const { root, cleanup } = setupTempGraph();
  try {
    const goalId = createGoal(root, { title: "待外部修改目标", actor: "test" });
    const initial = getCachedBoardPayload(root);
    assert.equal(initial.fromCache, false);

    const hit = getCachedBoardPayload(root);
    assert.equal(hit.fromCache, true);
    assert.equal(hit.etag, initial.etag);

    // 1. 外部直接写 events.jsonl
    writeFileSync(join(root, "events.jsonl"), JSON.stringify({ ts: "2026-08-31T20:00:00.000Z", actor: "external", event: "supervisor.status_reported", details: { status: "外部注入状态" } }) + "\n", "utf8");

    await waitWatcher();
    const afterEvents = getCachedBoardPayload(root);
    assert.equal(afterEvents.fromCache, false, "外部修改 events.jsonl 后缓存必须失效");
    assert.notEqual(afterEvents.etag, initial.etag);
    assert.equal(afterEvents.payload.supervisorStatus, "外部注入状态");

    // 2. 外部直接写 project.yaml
    writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: s-ext-123\n", "utf8");
    await waitWatcher();
    const afterYaml = getCachedBoardPayload(root);
    assert.equal(afterYaml.fromCache, false, "外部修改 project.yaml 后缓存必须失效");
    assert.equal(afterYaml.payload.supervisorSession, "s-ext-123");

    // 3. 外部直接写 order.json
    writeFileSync(join(root, "order.json"), JSON.stringify({ custom: [1, 2, 3] }), "utf8");
    await waitWatcher();
    const afterOrder = getCachedBoardPayload(root);
    assert.equal(afterOrder.fromCache, false, "外部修改 order.json 后缓存必须失效");

    // 4. 外部直接修改 goal.md
    const goalFile = join(root, "backlog", `${goalId}.md`);
    if (existsSync(goalFile)) {
      writeFileSync(goalFile, `---\n{"id":"${goalId}","title":"外部修改后的标题","status":"backlog"}\n---\n\n## 描述\n外部写入\n`, "utf8");
    }
    await waitWatcher();
    const afterGoal = getCachedBoardPayload(root);
    assert.equal(afterGoal.fromCache, false, "外部修改 goal.md 后缓存必须失效");
    assert.equal(afterGoal.payload.backlog[0].title, "外部修改后的标题");
  } finally {
    cleanup();
  }
});

test("g-212 判据 5：matchIfNoneMatch 处理各格式 If-None-Match 头（弱 ETag / 引号 / 逗号列表 / *）", () => {
  const currentETag = 'W/"abcd1234efgh"';
  assert.equal(matchIfNoneMatch('W/"abcd1234efgh"', currentETag), true);
  assert.equal(matchIfNoneMatch('"abcd1234efgh"', currentETag), true);
  assert.equal(matchIfNoneMatch('abcd1234efgh', currentETag), true);
  assert.equal(matchIfNoneMatch('*', currentETag), true);
  assert.equal(matchIfNoneMatch('W/"other", W/"abcd1234efgh"', currentETag), true);
  assert.equal(matchIfNoneMatch('"other", "abcd1234efgh"', currentETag), true);
  assert.equal(matchIfNoneMatch('W/"other"', currentETag), false);
  assert.equal(matchIfNoneMatch('', currentETag), false);
  assert.equal(matchIfNoneMatch(null, currentETag), false);
  assert.equal(matchIfNoneMatch(undefined, currentETag), false);
});

test("g-212 regression：writeHandoff invalidates warmed cache", () => {
  const { root, cleanup } = setupTempGraph();
  try {
    createGoal(root, { title: "handoff-cache", actor: "test" });
    const first = getCachedBoardPayload(root);
    assert.equal(first.fromCache, false);
    assert.equal(getCachedBoardPayload(root).fromCache, true);
    writeHandoff(root, "# updated\n");
    const next = getCachedBoardPayload(root);
    assert.equal(next.fromCache, false);
    assert.notEqual(next.etag, first.etag);
  } finally { cleanup(); }
});
