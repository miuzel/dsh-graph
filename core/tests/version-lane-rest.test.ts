/** g-134：版本泳道管理 REST API 测试——create-version / rename-version / delete-version 端点。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, createGoal, boardProjection } from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dsh-graph-host/index.js";

function fakeRequest(method: string, body: unknown) {
  const req: any = {
    method,
    _listeners: {} as Record<string, (v?: any) => void>,
    on(ev: string, cb: (v?: any) => void) {
      req._listeners[ev] = cb;
    },
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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-version-rest-"));
  init(root);
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, { root });
  return { root, routes };
}

const post = async (routes: Map<string, any>, path: string, body: unknown) => {
  const handler = routes.get(path);
  assert.ok(handler, `路由 ${path} 已注册`);
  const req = fakeRequest("POST", body);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, body);
  await p;
  return { code: res._code, body: res._body };
};

test("create-version 端点：正常创建版本", async () => {
  const { root, routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/create-version", {
    slug: "v0.7",
    name: "版本 0.7",
  });
  assert.equal(code, 200);
  assert.ok(body.ok);
  assert.equal(body.slug, "v0.7");
  assert.equal(body.name, "版本 0.7");
  // 验证版本目录存在
  assert.ok(existsSync(join(root, "versions", "v0.7", "version.md")));
  // 验证事件记录
  const events = readEvents(root);
  const created = events.find((e) => e.event === "version.created" && e.details?.version === "v0.7");
  assert.ok(created, "应记录 version.created 事件");
});

test("create-version 端点：缺少 slug 返回 400", async () => {
  const { routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/create-version", {
    name: "版本 0.7",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("missing slug"));
});

test("create-version 端点：slug 为空字符串返回 400", async () => {
  const { routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/create-version", {
    slug: "",
    name: "版本 0.7",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("missing slug"));
});

test("create-version 端点：slug 非字符串返回 400", async () => {
  const { routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/create-version", {
    slug: 123,
    name: "版本 0.7",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("missing slug"));
});

test("create-version 端点：slug 为对象返回 400", async () => {
  const { routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/create-version", {
    slug: { bad: true },
    name: "版本 0.7",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("missing slug"));
});

test("create-version 端点：版本已存在返回 400", async () => {
  const { routes } = setup();
  // 先创建一个版本
  await post(routes, "/api/dsh-graph/create-version", { slug: "v0.7" });
  // 再创建同名版本
  const { code, body } = await post(routes, "/api/dsh-graph/create-version", { slug: "v0.7" });
  assert.equal(code, 400);
  assert.ok(body.error.includes("已存在"));
});

test("rename-version 端点：正常重命名版本", async () => {
  const { root, routes } = setup();
  // 先创建一个版本
  await post(routes, "/api/dsh-graph/create-version", { slug: "v0.7", name: "版本 0.7" });
  // 创建一个目标
  createGoal(root, { title: "测试目标", version: "v0.7", actor: "test" });
  // 重命名版本
  const { code, body } = await post(routes, "/api/dsh-graph/rename-version", {
    slug: "v0.7",
    newSlug: "v0.8",
    newName: "版本 0.8",
  });
  assert.equal(code, 200);
  assert.ok(body.ok);
  assert.equal(body.old_slug, "v0.7");
  assert.equal(body.new_slug, "v0.8");
  assert.equal(body.old_name, "版本 0.7");
  assert.equal(body.new_name, "版本 0.8");
  // 验证旧目录不存在，新目录存在
  assert.ok(!existsSync(join(root, "versions", "v0.7")));
  assert.ok(existsSync(join(root, "versions", "v0.8", "version.md")));
  // 验证事件记录
  const events = readEvents(root);
  const renamed = events.find((e) => e.event === "version.renamed");
  assert.ok(renamed, "应记录 version.renamed 事件");
});

test("rename-version 端点：缺少 slug 返回 400", async () => {
  const { routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/rename-version", {
    newSlug: "v0.8",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("missing slug"));
});

test("rename-version 端点：slug 为空字符串返回 400", async () => {
  const { routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/rename-version", {
    slug: "",
    newSlug: "v0.8",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("missing slug"));
});

test("rename-version 端点：slug 非字符串返回 400", async () => {
  const { routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/rename-version", {
    slug: 123,
    newSlug: "v0.8",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("missing slug"));
});

test("rename-version 端点：版本不存在返回 400", async () => {
  const { routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/rename-version", {
    slug: "v999",
    newSlug: "v0.8",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("不存在"));
});

test("rename-version 端点：新 slug 已存在返回 400", async () => {
  const { routes } = setup();
  // 创建两个版本
  await post(routes, "/api/dsh-graph/create-version", { slug: "v0.7" });
  await post(routes, "/api/dsh-graph/create-version", { slug: "v0.8" });
  // 尝试将 v0.7 重命名为 v0.8
  const { code, body } = await post(routes, "/api/dsh-graph/rename-version", {
    slug: "v0.7",
    newSlug: "v0.8",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("已存在"));
});

test("delete-version 端点：正常删除空版本", async () => {
  const { root, routes } = setup();
  // 先创建一个版本
  await post(routes, "/api/dsh-graph/create-version", { slug: "v0.7" });
  // 删除版本
  const { code, body } = await post(routes, "/api/dsh-graph/delete-version", {
    slug: "v0.7",
  });
  assert.equal(code, 200);
  assert.ok(body.ok);
  assert.equal(body.slug, "v0.7");
  // 验证版本目录不存在
  assert.ok(!existsSync(join(root, "versions", "v0.7")));
  // 验证事件记录
  const events = readEvents(root);
  const deleted = events.find((e) => e.event === "version.deleted");
  assert.ok(deleted, "应记录 version.deleted 事件");
});

test("delete-version 端点：缺少 slug 返回 400", async () => {
  const { routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/delete-version", {});
  assert.equal(code, 400);
  assert.ok(body.error.includes("missing slug"));
});

test("delete-version 端点：slug 为空字符串返回 400", async () => {
  const { routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/delete-version", {
    slug: "",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("missing slug"));
});

test("delete-version 端点：slug 非字符串返回 400", async () => {
  const { routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/delete-version", {
    slug: 123,
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("missing slug"));
});

test("delete-version 端点：版本不存在返回 400", async () => {
  const { routes } = setup();
  const { code, body } = await post(routes, "/api/dsh-graph/delete-version", {
    slug: "v999",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("不存在"));
});

test("delete-version 端点：非空版本拒绝删除返回 400", async () => {
  const { root, routes } = setup();
  // 先创建一个版本
  await post(routes, "/api/dsh-graph/create-version", { slug: "v0.7" });
  // 创建一个目标
  createGoal(root, { title: "测试目标", version: "v0.7", actor: "test" });
  // 尝试删除非空版本
  const { code, body } = await post(routes, "/api/dsh-graph/delete-version", {
    slug: "v0.7",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("仍有目标"));
});

test("版本管理 REST API 集成：创建→重命名→删除完整流程", async () => {
  const { root, routes } = setup();
  // 创建版本
  const createRes = await post(routes, "/api/dsh-graph/create-version", {
    slug: "v0.7",
    name: "版本 0.7",
  });
  assert.equal(createRes.code, 200);
  // 创建目标
  const goalId = createGoal(root, { title: "测试目标", version: "v0.7", actor: "test" });
  // 重命名版本
  const renameRes = await post(routes, "/api/dsh-graph/rename-version", {
    slug: "v0.7",
    newSlug: "v0.8",
    newName: "版本 0.8",
  });
  assert.equal(renameRes.code, 200);
  // 验证重命名后看板
  let board = boardProjection(root);
  let v = board.versions.find((v) => v.slug === "v0.8");
  assert.ok(v);
  assert.equal(v.goals.length, 1);
  assert.equal(v.goals[0].id, goalId);
  // 移走目标（模拟清空版本）
  // 注意：这里需要使用 moveGoal，但 REST API 没有直接暴露
  // 我们直接操作文件系统来模拟
  const goalFile = join(root, "versions", "v0.8", "goals", goalId, "goal.md");
  const standaloneDir = join(root, "goals", goalId);
  const fs = await import("node:fs");
  fs.mkdirSync(standaloneDir, { recursive: true });
  fs.renameSync(goalFile, join(standaloneDir, "goal.md"));
  // 删除空版本
  const deleteRes = await post(routes, "/api/dsh-graph/delete-version", {
    slug: "v0.8",
  });
  console.log("Delete response:", deleteRes);
  assert.equal(deleteRes.code, 200);
  // 验证版本已删除
  board = boardProjection(root);
  v = board.versions.find((v) => v.slug === "v0.8");
  assert.ok(!v, "版本应已删除");
  // 验证目标仍在 standalone
  const standalone = board.standalone.find((g) => g.id === goalId);
  assert.ok(standalone, "目标应迁移到 standalone");
});

test("版本管理 REST API：POST 方法强制要求", async () => {
  const { routes } = setup();
  const handler = routes.get("/api/dsh-graph/create-version");
  assert.ok(handler, "路由应已注册");
  // 尝试 GET 请求
  const req = fakeRequest("GET", {});
  const res = fakeResponse();
  await handler(req, res);
  assert.equal(res._code, 405);
  assert.ok(res._body.error.includes("method not allowed"));
});

test("版本管理 REST API：事件先行验证", async () => {
  const { root, routes } = setup();
  // 创建版本
  await post(routes, "/api/dsh-graph/create-version", { slug: "v0.7" });
  const events = readEvents(root);
  const lastEvent = events[events.length - 1];
  assert.equal(lastEvent.event, "version.created");
  // 重命名版本
  await post(routes, "/api/dsh-graph/rename-version", {
    slug: "v0.7",
    newName: "新名称",
  });
  const events2 = readEvents(root);
  const lastEvent2 = events2[events2.length - 1];
  assert.equal(lastEvent2.event, "version.renamed");
  // 删除版本
  await post(routes, "/api/dsh-graph/delete-version", { slug: "v0.7" });
  const events3 = readEvents(root);
  const lastEvent3 = events3[events3.length - 1];
  assert.equal(lastEvent3.event, "version.deleted");
});
