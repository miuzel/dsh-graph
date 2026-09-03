/** g-207：迁移后的 writeSupervisorSession 与 settings REST schema 校验集成测试。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, writeSupervisorSession, readSupervisorSession, writeProjectConfig, readProjectConfig } from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dsh-graph-host/index.js";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g207-"));
  init(dir);
  return dir;
}

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

function setupRest() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g207-rest-"));
  init(root);
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined),
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

// ---- writeSupervisorSession 事务迁移测试 ----

test("writeSupervisorSession：正常写入并记事件（事务模板）", () => {
  const root = tmpRoot();
  writeSupervisorSession(root, "session-abc", "agent:test");
  assert.equal(readSupervisorSession(root), "session-abc");
  const evs = readEvents(root).filter((e) => e.event === "supervisor.claimed");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].details.supervisor_session, "session-abc");
});

test("writeSupervisorSession：保留注释与其他键", () => {
  const root = tmpRoot();
  writeFileSync(
    join(root, "project.yaml"),
    'name: t\nsupervisor:\n  session: old   # 主管会话\n  automation:\n    release: human\nexecutor:\n  provider: deepseek-official\n',
  );
  writeSupervisorSession(root, "session-new", "agent:test");
  const text = readFileSync(join(root, "project.yaml"), "utf8");
  assert.match(text, /session: session-new/);
  assert.match(text, /# 主管会话/);
  assert.match(text, /release: human/);
  assert.match(text, /provider: deepseek-official/);
});

test("writeSupervisorSession：空 session id 拒绝", () => {
  const root = tmpRoot();
  assert.throws(() => writeSupervisorSession(root, "", "agent:test"), /不能为空/);
});

test("writeSupervisorSession：无 project.yaml 时创建", () => {
  const root = tmpRoot();
  writeSupervisorSession(root, "s-1", "agent:test");
  assert.equal(readSupervisorSession(root), "s-1");
  assert.match(readFileSync(join(root, "project.yaml"), "utf8"), /supervisor:\n  session: s-1/);
});

// ---- writeProjectConfig schema 校验测试 ----

test("writeProjectConfig：schema 校验拒绝未知字段", () => {
  const root = tmpRoot();
  assert.throws(
    () => writeProjectConfig(root, { unknown_field: "bad" }, "human:gui"),
    /校验失败/,
  );
});

test("writeProjectConfig：schema 校验拒绝字符串 lanes（隐式 coercion）", () => {
  const root = tmpRoot();
  assert.throws(
    () => writeProjectConfig(root, { defaults: { pk: { lanes: "2" } } }, "human:gui"),
    /校验失败/,
  );
});

test("writeProjectConfig：schema 校验拒绝非法 automation 值", () => {
  const root = tmpRoot();
  assert.throws(
    () => writeProjectConfig(root, { supervisor: { automation: { release: "robot" } } }, "human:gui"),
    /校验失败/,
  );
});

test("writeProjectConfig：合法 patch 仍正常工作", () => {
  const root = tmpRoot();
  writeProjectConfig(root, { executor: { provider: "kimi", model: "k1" } }, "human:gui");
  const cfg = readProjectConfig(root);
  assert.equal(cfg.executor.provider, "kimi");
  assert.equal(cfg.executor.model, "k1");
});

test("writeProjectConfig：null 值允许（nullable 字段）", () => {
  const root = tmpRoot();
  writeProjectConfig(root, { executor: { provider: null, model: null } }, "human:gui");
  const cfg = readProjectConfig(root);
  assert.equal(cfg.executor.provider, null);
  assert.equal(cfg.executor.model, null);
});

test("writeProjectConfig：schema 校验失败后文件保持原样（不落盘）", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "project.yaml"), "name: original\n", "utf8");
  const before = readFileSync(join(root, "project.yaml"), "utf8");
  try {
    writeProjectConfig(root, { unknown_field: "bad" }, "human:gui");
  } catch {
    // 预期抛错
  }
  const after = readFileSync(join(root, "project.yaml"), "utf8");
  assert.equal(after, before);
});

// ---- REST /api/dsh-graph/settings schema 校验测试 ----

test("REST settings POST：合法 patch 返回 200", async () => {
  const { routes } = setupRest();
  const { code, body } = await post(routes, "/api/dsh-graph/settings", {
    executor: { provider: "kimi", model: "k1" },
  });
  assert.equal(code, 200);
  assert.equal(body.ok, true);
  assert.equal(body.config.executor.provider, "kimi");
});

test("REST settings POST：未知字段返回 400 且不泄漏值", async () => {
  const { routes } = setupRest();
  const { code, body } = await post(routes, "/api/dsh-graph/settings", {
    executor: { provider: "kimi" },
    secret_token: "should-not-leak",
  });
  assert.equal(code, 400);
  assert.ok(body.error.includes("校验失败"));
  assert.ok(body.details);
  // 错误消息不应包含原始值
  assert.ok(!body.error.includes("should-not-leak"));
  assert.ok(!body.error.includes("secret_token"));
  // details 中应指出字段
  assert.ok(body.details.some((d: any) => d.field === "secret_token"));
});

test("REST settings POST：字符串 lanes 返回 400（coercion 拒绝）", async () => {
  const { routes } = setupRest();
  const { code, body } = await post(routes, "/api/dsh-graph/settings", {
    defaults: { pk: { lanes: "2" } },
  });
  assert.equal(code, 400);
  assert.ok(body.details.some((d: any) => d.code === "coercion"));
});

test("REST settings POST：非法 automation 枚举返回 400", async () => {
  const { routes } = setupRest();
  const { code, body } = await post(routes, "/api/dsh-graph/settings", {
    supervisor: { automation: { release: "robot" } },
  });
  assert.equal(code, 400);
  assert.ok(body.details.some((d: any) => d.code === "enum"));
});

test("REST settings POST：null 值允许", async () => {
  const { routes } = setupRest();
  const { code, body } = await post(routes, "/api/dsh-graph/settings", {
    executor: { provider: null, model: null },
  });
  assert.equal(code, 200);
  assert.equal(body.ok, true);
});

test("REST settings POST：多个错误同时报告", async () => {
  const { routes } = setupRest();
  const { code, body } = await post(routes, "/api/dsh-graph/settings", {
    defaults: { pk: { lanes: "2" } },
    supervisor: { automation: { release: "robot" } },
    bad_field: "x",
  });
  assert.equal(code, 400);
  assert.ok(body.details.length >= 3);
  const codes = new Set(body.details.map((d: any) => d.code));
  assert.ok(codes.has("coercion"));
  assert.ok(codes.has("enum"));
  assert.ok(codes.has("additionalProperties"));
});
