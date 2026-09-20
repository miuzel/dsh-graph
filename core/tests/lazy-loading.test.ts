import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  createVersion,
  setCriteria,
  transition,
  boardProjection,
  versionGoals,
  backlogGoals,
  setVersionStatus,
  releaseVersion,
  moveGoal,
  GraphError,
} from "../ops.ts";
import { apply } from "../../dist/index.js";

function setupTestProject(): { root: string; ws: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), "dsh-lazy-test-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  return {
    root,
    ws,
    cleanup: () => {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    },
  };
}

test("g-258 boardProjection lazy 模式：活跃与独立全量，已发布与 backlog 仅条数计数", () => {
  const { root, cleanup } = setupTestProject();
  try {
    // 1. 创建版本 v1.0 与目标
    createVersion(root, { slug: "v1.0", name: "Version 1.0", actor: "test" });
    const g1 = createGoal(root, { title: "v1 目标 1", version: "v1.0", actor: "test" });
    setCriteria(root, g1, ["判据 1"], "test");
    transition(root, g1, "collecting", { actor: "test" });
    transition(root, g1, "ready", { actor: "test" });
    transition(root, g1, "in_progress", { actor: "test" });
    transition(root, g1, "review", { actor: "test" });
    transition(root, g1, "delivered", { actor: "test", force: true });
    releaseVersion(root, { slug: "v1.0", actor: "human:test" });

    // 2. 创建当前活跃版本 v2.0 与目标
    createVersion(root, { slug: "v2.0", name: "Version 2.0", actor: "test" });
    setVersionStatus(root, { slug: "v2.0", status: "active", actor: "test" });
    const g2 = createGoal(root, { title: "v2 活跃目标", version: "v2.0", actor: "test" });

    // 3. 创建独立目标与 backlog 目标
    const gStandalone = createGoal(root, { title: "独立目标", actor: "test" });
    // 将 gStandalone 移到 standalone（createGoal 默认进了 backlog）
    moveGoal(root, gStandalone, { to: "standalone", actor: "test" });

    const gBacklog1 = createGoal(root, { title: "Backlog 目标 1", actor: "test" });
    const gBacklog2 = createGoal(root, { title: "Backlog 目标 2", actor: "test" });

    // 4. 全量 boardProjection（默认/无 lazy）
    const full = boardProjection(root);
    assert.equal(full.lazy, undefined);
    assert.equal(full.backlog.length, 2);
    assert.equal(full.backlog_count, 2);
    const fullV1 = full.versions.find((v) => v.slug === "v1.0")!;
    assert.equal(fullV1.status, "released");
    assert.equal(fullV1.goals.length, 1);
    assert.equal(fullV1.goals_count, 1);

    const fullV2 = full.versions.find((v) => v.slug === "v2.0")!;
    assert.equal(fullV2.status, "active");
    assert.equal(fullV2.goals.length, 1);
    assert.equal(fullV2.goals[0].id, g2);

    // 5. 懒加载 boardProjection（lazy: true）
    const lazy = boardProjection(root, { lazy: true });
    assert.equal(lazy.lazy, true);
    // backlog 目标明细为空，计数为 2
    assert.equal(lazy.backlog.length, 0);
    assert.equal(lazy.backlog_count, 2);

    // 已发布版本 v1.0 目标明细为空，计数为 1
    const lazyV1 = lazy.versions.find((v) => v.slug === "v1.0")!;
    assert.equal(lazyV1.status, "released");
    assert.equal(lazyV1.goals.length, 0);
    assert.equal(lazyV1.goals_count, 1);
    assert.equal(lazyV1.lazy, true);

    // 活跃版本 v2.0 全量加载
    const lazyV2 = lazy.versions.find((v) => v.slug === "v2.0")!;
    assert.equal(lazyV2.status, "active");
    assert.equal(lazyV2.goals.length, 1);
    assert.equal(lazyV2.goals[0].id, g2);

    // 独立目标全量加载
    assert.equal(lazy.standalone.length, 1);
    assert.equal(lazy.standalone[0].id, gStandalone);

    // 6. 按需拉取 versionGoals 与 backlogGoals
    const v1Goals = versionGoals(root, "v1.0");
    assert.equal(v1Goals.length, 1);
    assert.equal(v1Goals[0].id, g1);
    assert.equal(v1Goals[0].status, "delivered");

    const bgGoals = backlogGoals(root);
    assert.equal(bgGoals.length, 2);
    const bgIds = bgGoals.map((g) => g.id);
    assert.ok(bgIds.includes(gBacklog1));
    assert.ok(bgIds.includes(gBacklog2));
  } finally {
    cleanup();
  }
});

test("g-258 versionGoals 边界与安全校验", () => {
  const { root, cleanup } = setupTestProject();
  try {
    assert.throws(() => versionGoals(root, "nonexistent"), /不存在/);
    assert.throws(() => versionGoals(root, "../escaping"), /版本 slug/);
    assert.throws(() => versionGoals(root, ""), /版本 slug/);
  } finally {
    cleanup();
  }
});

test("g-258 REST API：/api/dsh-graph?lazy=1、/api/dsh-graph/version-goals 与 /api/dsh-graph/backlog-goals", async () => {
  const { root, ws, cleanup } = setupTestProject();
  try {
    createVersion(root, { slug: "v0.1", name: "Version 0.1", actor: "test" });
    const g1 = createGoal(root, { title: "已发布目标", version: "v0.1", actor: "test" });
    setCriteria(root, g1, ["判据 1"], "test");
    transition(root, g1, "collecting", { actor: "test" });
    transition(root, g1, "ready", { actor: "test" });
    transition(root, g1, "in_progress", { actor: "test" });
    transition(root, g1, "review", { actor: "test" });
    transition(root, g1, "delivered", { actor: "test", force: true });
    releaseVersion(root, { slug: "v0.1", actor: "human:test" });

    createGoal(root, { title: "Backlog 待办", actor: "test" });

    const registered = new Map<string, any>();
    const webServer = { register: (def: any) => { registered.set(def.path, def.handler); return () => {}; } };
    const fakeCtx = {
      get: (name: string) => (name === "webServer" ? webServer : name === "sandboxPolicy" ? { workspaceRoot: ws } : undefined),
      effect: (fn: () => unknown) => fn(),
      webServer,
      tools: { register: () => () => {}, get: () => ({}) },
      on() {},
    };
    apply(fakeCtx as any, { root });

    // 1. 测试 GET /api/dsh-graph?lazy=1
    const boardHandler = registered.get("/api/dsh-graph");
    assert.ok(boardHandler, "GET /api/dsh-graph 端点存在");

    let boardResBody = "";
    let boardStatusCode = 0;
    const fakeBoardRes = {
      writeHead(code: number, headers?: any) { boardStatusCode = code; },
      end(chunk?: any) { if (chunk) boardResBody = String(chunk); },
    };
    boardHandler({ method: "GET", url: `/api/dsh-graph?workspace=${encodeURIComponent(ws)}&lazy=1`, headers: {} }, fakeBoardRes);
    assert.equal(boardStatusCode, 200);
    const boardJson = JSON.parse(boardResBody);
    assert.equal(boardJson.lazy, true);
    assert.equal(boardJson.backlog.length, 0);
    assert.equal(boardJson.backlog_count, 1);
    const v01 = boardJson.versions.find((v: any) => v.slug === "v0.1");
    assert.equal(v01.goals.length, 0);
    assert.equal(v01.goals_count, 1);
    assert.equal(v01.lazy, true);

    // 2. 测试 GET /api/dsh-graph/version-goals?slug=v0.1
    const vGoalsHandler = registered.get("/api/dsh-graph/version-goals");
    assert.ok(vGoalsHandler, "GET /api/dsh-graph/version-goals 端点存在");

    let vgBody: any = null;
    let vgStatus = 0;
    const fakeVgRes = {
      writeHead(code: number) { vgStatus = code; },
      setHeader() {},
      end(chunk?: any) { if (chunk) vgBody = JSON.parse(chunk); },
    };
    await vGoalsHandler({ method: "GET", url: `/api/dsh-graph/version-goals?workspace=${encodeURIComponent(ws)}&slug=v0.1` }, fakeVgRes);
    assert.equal(vgStatus, 200);
    assert.equal(vgBody.ok, true);
    assert.equal(vgBody.slug, "v0.1");
    assert.equal(vgBody.goals.length, 1);
    assert.equal(vgBody.goals[0].id, g1);

    // 3. 测试 GET /api/dsh-graph/version-goals 缺少 slug
    let vgErrStatus = 0;
    const fakeVgErrRes = {
      writeHead(code: number) { vgErrStatus = code; },
      setHeader() {},
      end() {},
    };
    await vGoalsHandler({ method: "GET", url: `/api/dsh-graph/version-goals?workspace=${encodeURIComponent(ws)}` }, fakeVgErrRes);
    assert.equal(vgErrStatus, 400);

    // 4. 测试 POST 方法拒绝
    let vgMethodStatus = 0;
    const fakeVgMethodRes = {
      writeHead(code: number) { vgMethodStatus = code; },
      setHeader() {},
      end() {},
    };
    await vGoalsHandler({ method: "POST", url: `/api/dsh-graph/version-goals?workspace=${encodeURIComponent(ws)}&slug=v0.1` }, fakeVgMethodRes);
    assert.equal(vgMethodStatus, 405);

    // 5. 测试 GET /api/dsh-graph/backlog-goals
    const bgHandler = registered.get("/api/dsh-graph/backlog-goals");
    assert.ok(bgHandler, "GET /api/dsh-graph/backlog-goals 端点存在");

    let bgBody: any = null;
    let bgStatus = 0;
    const fakeBgRes = {
      writeHead(code: number) { bgStatus = code; },
      setHeader() {},
      end(chunk?: any) { if (chunk) bgBody = JSON.parse(chunk); },
    };
    await bgHandler({ method: "GET", url: `/api/dsh-graph/backlog-goals?workspace=${encodeURIComponent(ws)}` }, fakeBgRes);
    assert.equal(bgStatus, 200);
    assert.equal(bgBody.ok, true);
    assert.equal(bgBody.goals.length, 1);
  } finally {
    cleanup();
  }
});
