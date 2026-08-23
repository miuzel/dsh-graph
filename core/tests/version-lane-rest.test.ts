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

const get = async (routes: Map<string, any>, path: string, query?: string) => {
  const handler = routes.get(path);
  assert.ok(handler, `路由 ${path} 已注册`);
  const req = fakeRequest("GET", null);
  req.url = query ? `?${query}` : "";
  const res = fakeResponse();
  const p = handler(req, res);
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
  // 移走目标（模拟清空版本）——需清理空目录
  const goalFile = join(root, "versions", "v0.8", "goals", goalId, "goal.md");
  const standaloneDir = join(root, "goals", goalId);
  const fs = await import("node:fs");
  fs.mkdirSync(standaloneDir, { recursive: true });
  fs.renameSync(goalFile, join(standaloneDir, "goal.md"));
  // 清理空的目标目录
  const goalDirInVersion = join(root, "versions", "v0.8", "goals", goalId);
  fs.rmdirSync(goalDirInVersion);
  // 删除空版本
  const deleteRes = await post(routes, "/api/dsh-graph/delete-version", {
    slug: "v0.8",
  });
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

// ---- g-135: 版本发布 REST API 测试 ----

test("version-detail 端点：正常获取版本详情", async () => {
  const { root, routes } = setup();
  await post(routes, "/api/dsh-graph/create-version", { slug: "v1.0", name: "1.0" });
  const res = await get(routes, "/api/dsh-graph/version-detail", "slug=v1.0");
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.slug, "v1.0");
  assert.equal(res.body.name, "1.0");
  assert.equal(res.body.status, "planning");
  assert.ok(typeof res.body.goals_count === "number");
  assert.ok(Array.isArray(res.body.blocking));
});

test("version-detail 端点：缺少 slug 返回 400", async () => {
  const { routes } = setup();
  const res = await get(routes, "/api/dsh-graph/version-detail");
  assert.equal(res.code, 400);
  assert.ok(res.body.error.includes("missing slug"));
});

test("release-version 端点：正常发布（无阻塞目标）", async () => {
  const { root, routes } = setup();
  await post(routes, "/api/dsh-graph/create-version", { slug: "v1.0" });
  const res = await post(routes, "/api/dsh-graph/release-version", { slug: "v1.0" });
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  // 验证事件
  const events = readEvents(root);
  const released = events.find((e: any) => e.event === "version.released" && e.details?.version === "v1.0");
  assert.ok(released, "应记录 version.released 事件");
  assert.equal(released.actor, "human:gui"); // REST 端点 actor 为 human:gui
});

test("release-version 端点：有阻塞目标时返回阻塞清单", async () => {
  const { root, routes } = setup();
  await post(routes, "/api/dsh-graph/create-version", { slug: "v1.0" });
  // 创建一个未 delivered 的目标
  createGoal(root, { title: "阻塞目标", version: "v1.0", actor: "test" });
  const res = await post(routes, "/api/dsh-graph/release-version", { slug: "v1.0" });
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, false);
  assert.ok(Array.isArray(res.body.blocking));
  assert.equal(res.body.blocking.length, 1);
  assert.equal(res.body.blocking[0].title, "阻塞目标");
  // 不应写 version.released 事件
  const events = readEvents(root);
  const released = events.find((e: any) => e.event === "version.released");
  assert.equal(released, undefined, "不应写 version.released 事件");
});

test("release-version 端点：缺少 slug 返回 400", async () => {
  const { routes } = setup();
  const res = await post(routes, "/api/dsh-graph/release-version", {});
  assert.equal(res.code, 400);
  assert.ok(res.body.error.includes("missing slug"));
});

test("release-version 端点：POST 方法强制要求", async () => {
  const { routes } = setup();
  const handler = routes.get("/api/dsh-graph/release-version");
  const req = fakeRequest("GET", null);
  const res = fakeResponse();
  await handler(req, res);
  assert.equal(res._code, 405);
});

test("set-version-status 端点：正常设置 working（active）", async () => {
  const { root, routes } = setup();
  await post(routes, "/api/dsh-graph/create-version", { slug: "v1.0" });
  const res = await post(routes, "/api/dsh-graph/set-version-status", { slug: "v1.0", status: "active" });
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  // 验证事件
  const events = readEvents(root);
  const changed = events.find((e: any) => e.event === "version.status_changed" && e.details?.version === "v1.0");
  assert.ok(changed, "应记录 version.status_changed 事件");
  assert.equal(changed.details.old_status, "planning");
  assert.equal(changed.details.new_status, "active");
});

test("set-version-status 端点：缺少参数返回 400", async () => {
  const { routes } = setup();
  const res1 = await post(routes, "/api/dsh-graph/set-version-status", { status: "active" });
  assert.equal(res1.code, 400);
  const res2 = await post(routes, "/api/dsh-graph/set-version-status", { slug: "v1.0" });
  assert.equal(res2.code, 400);
});

test("set-version-status 端点：拒绝 released（必须经 releaseVersion）", async () => {
  const { root, routes } = setup();
  await post(routes, "/api/dsh-graph/create-version", { slug: "v1.0" });
  const res = await post(routes, "/api/dsh-graph/set-version-status", { slug: "v1.0", status: "released" });
  assert.equal(res.code, 400);
  assert.ok(res.body.error.includes("setVersionStatus"), "错误信息应提及 setVersionStatus");
  // 不应写 version.status_changed 事件
  const events = readEvents(root).filter((e: any) => e.event === "version.status_changed");
  assert.equal(events.length, 0, "拒绝后不应写 status_changed 事件");
});

test("set-version-status 端点：拒绝无效状态", async () => {
  const { routes } = setup();
  await post(routes, "/api/dsh-graph/create-version", { slug: "v1.0" });
  const res = await post(routes, "/api/dsh-graph/set-version-status", { slug: "v1.0", status: "bogus" });
  assert.equal(res.code, 400);
  assert.ok(res.body.error.includes("非法版本状态"));
});

test("set-version-status 端点：released 终态 guard——released→planning 被拒绝", async () => {
  const { root, routes } = setup();
  await post(routes, "/api/dsh-graph/create-version", { slug: "v1.0" });
  await post(routes, "/api/dsh-graph/release-version", { slug: "v1.0" });
  // 确认已 released
  const detail1 = await get(routes, "/api/dsh-graph/version-detail", "slug=v1.0");
  assert.equal(detail1.body.status, "released");
  const eventsBefore = readEvents(root).length;
  // 尝试 released → planning
  const res = await post(routes, "/api/dsh-graph/set-version-status", { slug: "v1.0", status: "planning" });
  assert.equal(res.code, 400);
  assert.ok(res.body.error.includes("终态"), "错误信息应提及终态");
  // 状态不变、事件不变
  const detail2 = await get(routes, "/api/dsh-graph/version-detail", "slug=v1.0");
  assert.equal(detail2.body.status, "released");
  assert.equal(readEvents(root).length, eventsBefore, "拒绝后不应写事件");
});
