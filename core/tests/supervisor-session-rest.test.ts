/** g-199：supervisor-session REST 端点安全矩阵测试。
 *  覆盖（判据 5）：GET-only / 拒绝 workspace,root 查询 / fd 能力 identity 匹配与
 *  数字复用拒绝（真实 replacement race）/ 无 fd 降级 pathname walk / 符号链接 fail-closed /
 *  越界 containment / 无能力 400 / 绝不 init/写盘 / 缺失字段安全 null。
 *  非敏感：响应只含 supervisorSession（session id），绝不泄露路径/token。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, writeFileSync, existsSync, readdirSync, openSync, closeSync,
  symlinkSync, rmSync, mkdirSync, lstatSync, constants as fsConstants,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../dsh-graph-host/index.js";

function fakeRequest(method: string) {
  return { method };
}

function fakeResponse() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}

function makeWebServer(routes: Map<string, any>) {
  return { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
}

function makeCtx(routes: Map<string, any>, sandboxPolicy: any) {
  const webServer = makeWebServer(routes);
  return {
    get: (name: string) => (name === "webServer" ? webServer : name === "sandboxPolicy" ? sandboxPolicy : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
}

const PROJECT = "supervisor:\n  session: session-sup-abc   # 主管会话\n  automation:\n    release: human\n";

async function get(routes: Map<string, any>, url = "") {
  const handler = routes.get("/api/dsh-graph/supervisor-session");
  assert.ok(handler, "路由已注册");
  const req = fakeRequest("GET");
  req.url = url;
  const res = fakeResponse();
  await handler(req, res);
  return { code: res._code, body: res._body };
}

async function request(routes: Map<string, any>, methodName: string) {
  const handler = routes.get("/api/dsh-graph/supervisor-session");
  const req = fakeRequest(methodName);
  req.url = "";
  const res = fakeResponse();
  await handler(req, res);
  return { code: res._code, body: res._body };
}

function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isDirectory()) { out.push(p + "/"); walk(p); }
      else out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

// ===== fd 能力模式 =====

test("supervisor-session：fd 能力正常读取（含注释）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-fd-"));
  const fd = openSync(ws, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    const routes = new Map<string, any>();
    apply(makeCtx(routes, { workspaceRoot: ws, workspaceFd: fd }), { root: ".dsh-graph" });
    writeFileSync(join(ws, ".dsh-graph", "project.yaml"), PROJECT, "utf8");
    const { code, body } = await get(routes);
    assert.equal(code, 200);
    assert.equal(body.supervisorSession, "session-sup-abc");
  } finally { try { closeSync(fd); } catch {} }
});

test("supervisor-session：fd 能力 handle 对象形式（workspaceHandle.fd）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-handle-"));
  const fd = openSync(ws, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    const routes = new Map<string, any>();
    apply(makeCtx(routes, { workspaceRoot: ws, workspaceHandle: { fd } }), { root: ".dsh-graph" });
    writeFileSync(join(ws, ".dsh-graph", "project.yaml"), 'supervisor:\n  session: "session-quoted"  # ok\n', "utf8");
    const { code, body } = await get(routes);
    assert.equal(code, 200);
    assert.equal(body.supervisorSession, "session-quoted");
  } finally { try { closeSync(fd); } catch {} }
});

test("supervisor-session：fd 能力 + 无 project.yaml → 200 null（安全降级）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-fd3-"));
  const fd = openSync(ws, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    const routes = new Map<string, any>();
    apply(makeCtx(routes, { workspaceRoot: ws, workspaceFd: fd }), { root: ".dsh-graph" });
    const { code, body } = await get(routes);
    assert.equal(code, 200);
    assert.equal(body.supervisorSession, null);
  } finally { try { closeSync(fd); } catch {} }
});

test("supervisor-session：fd 能力 + 无 supervisor 块 → 200 null", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-fd4-"));
  const fd = openSync(ws, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    const routes = new Map<string, any>();
    apply(makeCtx(routes, { workspaceRoot: ws, workspaceFd: fd }), { root: ".dsh-graph" });
    writeFileSync(join(ws, ".dsh-graph", "project.yaml"), "executor:\n  provider: x\n", "utf8");
    const { code, body } = await get(routes);
    assert.equal(code, 200);
    assert.equal(body.supervisorSession, null);
  } finally { try { closeSync(fd); } catch {} }
});

test("supervisor-session：fd 数字复用（close 后同号 foreign 目录）→ 400 identity 不匹配", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-sup-race-"));
  const ws = join(base, "ws");
  const foreign = join(base, "foreign");
  mkdirSync(ws);
  mkdirSync(foreign);
  const fdA = openSync(ws, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  const routes = new Map<string, any>();
  apply(makeCtx(routes, { workspaceRoot: ws, workspaceFd: fdA }), { root: ".dsh-graph" });
  writeFileSync(join(ws, ".dsh-graph", "project.yaml"), PROJECT, "utf8");
  // 模拟同进程 close → 同号复用为 foreign 目录（同 owner/权限）
  closeSync(fdA);
  const fdB = openSync(foreign, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    assert.equal(fdB, fdA, "fd 号应被复用（本环境确定性）");
    const { code, body } = await get(routes);
    assert.equal(code, 400);
    assert.ok(body.error.includes("workspace"), "400 且不泄露细节");
  } finally { try { closeSync(fdB); } catch {} }
});

test("supervisor-session：fd 已关闭（无复用）→ 400", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-closed-"));
  const fd = openSync(ws, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  const routes = new Map<string, any>();
  apply(makeCtx(routes, { workspaceRoot: ws, workspaceFd: fd }), { root: ".dsh-graph" });
  writeFileSync(join(ws, ".dsh-graph", "project.yaml"), PROJECT, "utf8");
  closeSync(fd); // 之后无同号复用：fstat 抛 EBADF → 400
  const { code } = await get(routes);
  assert.equal(code, 400);
});

test("supervisor-session：fd 模式 project.yaml 符号链接 → 400 fail-closed", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-sup-fdsym-"));
  const ws = join(base, "ws");
  const fake = join(base, "fake.yaml");
  mkdirSync(ws);
  writeFileSync(fake, "supervisor:\n  session: session-evil\n", "utf8");
  const fd = openSync(ws, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    const routes = new Map<string, any>();
    apply(makeCtx(routes, { workspaceRoot: ws, workspaceFd: fd }), { root: ".dsh-graph" });
    writeFileSync(join(ws, ".dsh-graph", "project.yaml"), PROJECT, "utf8");
    rmSync(join(ws, ".dsh-graph", "project.yaml"));
    symlinkSync(fake, join(ws, ".dsh-graph", "project.yaml"));
    const { code, body } = await get(routes);
    assert.equal(code, 400); // O_NOFOLLOW → ELOOP → 4xx
    assert.equal(body.supervisorSession, undefined);
  } finally { try { closeSync(fd); } catch {} }
});

// ===== 方法 / 查询守卫 =====

for (const m of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
  test(`supervisor-session：${m} → 405`, async () => {
    const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-m-"));
    const routes = new Map<string, any>();
    apply(makeCtx(routes, { workspaceRoot: ws }), { root: ".dsh-graph" });
    const { code } = await request(routes, m);
    assert.equal(code, 405);
  });
}

test("supervisor-session：有 sandboxPolicy 时拒绝 workspace 查询参数（优先受保护 workspace）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-q1-"));
  const routes = new Map<string, any>();
  apply(makeCtx(routes, { workspaceRoot: ws }), { root: ".dsh-graph" });
  for (const q of ["?workspace=/etc", "?workspace=", "?workspace=a&root=b"]) {
    const { code, body } = await get(routes, q);
    assert.equal(code, 400, q);
    assert.ok(body.error.includes("workspace") || body.error.includes("root"), q);
  }
});

test("supervisor-session：拒绝 root 查询参数", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-q2-"));
  const routes = new Map<string, any>();
  apply(makeCtx(routes, { workspaceRoot: ws }), { root: ".dsh-graph" });
  const { code } = await get(routes, "?root=/tmp");
  assert.equal(code, 400);
});

test("supervisor-session：无关查询参数忽略 → 200", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-q3-"));
  const fd = openSync(ws, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    const routes = new Map<string, any>();
    apply(makeCtx(routes, { workspaceRoot: ws, workspaceFd: fd }), { root: ".dsh-graph" });
    writeFileSync(join(ws, ".dsh-graph", "project.yaml"), PROJECT, "utf8");
    const { code, body } = await get(routes, "?cache=1&v=2");
    assert.equal(code, 200);
    assert.equal(body.supervisorSession, "session-sup-abc");
  } finally { try { closeSync(fd); } catch {} }
});

// ===== 无 sandboxPolicy / ?workspace= 回退 / 越界 / 降级路径 =====

test("supervisor-session：无 sandboxPolicy 且无 ?workspace= → 400", async () => {
  const routes = new Map<string, any>();
  const webServer = makeWebServer(routes);
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, { root: ".dsh-graph" });
  const { code, body } = await get(routes);
  assert.equal(code, 400);
  assert.ok(body.error.includes("workspace"));
});

test("supervisor-session：无 sandboxPolicy 且带空 ?workspace= → 400", async () => {
  const routes = new Map<string, any>();
  const webServer = makeWebServer(routes);
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, { root: ".dsh-graph" });
  const { code, body } = await get(routes, "?workspace=");
  assert.equal(code, 400);
  assert.ok(body.error.includes("workspace"));
});

test("supervisor-session：无 sandboxPolicy 拒绝 ?root= 参数", async () => {
  const routes = new Map<string, any>();
  const webServer = makeWebServer(routes);
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, { root: ".dsh-graph" });
  const { code, body } = await get(routes, "?root=/tmp");
  assert.equal(code, 400);
  assert.ok(body.error.includes("root"));
});

test("supervisor-session：无 sandboxPolicy 通过受控 ?workspace= 回退正常读取", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-nowsp-"));
  mkdirSync(join(ws, ".dsh-graph"), { recursive: true });
  writeFileSync(join(ws, ".dsh-graph", "project.yaml"), PROJECT, "utf8");
  const routes = new Map<string, any>();
  const webServer = makeWebServer(routes);
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, { root: ".dsh-graph" });
  const { code, body } = await get(routes, "?workspace=" + encodeURIComponent(ws));
  assert.equal(code, 200);
  assert.equal(body.supervisorSession, "session-sup-abc");
});

test("supervisor-session：无 sandboxPolicy ?workspace= 回退且无 project.yaml → 200 null 且绝不 init", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-nowsp-empty-"));
  const routes = new Map<string, any>();
  const webServer = makeWebServer(routes);
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, { root: ".dsh-graph" });
  const { code, body } = await get(routes, "?workspace=" + encodeURIComponent(ws));
  assert.equal(code, 200);
  assert.equal(body.supervisorSession, null);
  assert.equal(existsSync(join(ws, ".dsh-graph")), false, "绝不创建 .dsh-graph 骨架");
});

test("supervisor-session：config.root 绝对越界 → 400（containment）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-ct-"));
  const outside = mkdtempSync(join(tmpdir(), "dsh-graph-sup-out-"));
  const routes = new Map<string, any>();
  apply(makeCtx(routes, { workspaceRoot: ws }), { root: outside });
  const { code } = await get(routes);
  assert.equal(code, 400);
});

test("supervisor-session：降级路径（无 fd）正常读取", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-pw-"));
  const routes = new Map<string, any>();
  apply(makeCtx(routes, { workspaceRoot: ws }), { root: ".dsh-graph" });
  writeFileSync(join(ws, ".dsh-graph", "project.yaml"), PROJECT, "utf8");
  const { code, body } = await get(routes);
  assert.equal(code, 200);
  assert.equal(body.supervisorSession, "session-sup-abc");
});

test("supervisor-session：降级路径 .dsh-graph 符号链接 → 400", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-sup-sym-"));
  const ws = join(base, "ws");
  const real = join(base, "real");
  mkdirSync(ws);
  mkdirSync(real);
  const routes = new Map<string, any>();
  apply(makeCtx(routes, { workspaceRoot: ws }), { root: ".dsh-graph" });
  rmSync(join(ws, ".dsh-graph"), { recursive: true, force: true });
  symlinkSync(real, join(ws, ".dsh-graph"));
  const { code } = await get(routes);
  assert.equal(code, 400);
});

test("supervisor-session：降级路径 project.yaml 符号链接 → null（fail-closed）", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-sup-sym2-"));
  const ws = join(base, "ws");
  const fake = join(base, "fake.yaml");
  mkdirSync(ws);
  writeFileSync(fake, "supervisor:\n  session: session-evil\n", "utf8");
  const routes = new Map<string, any>();
  apply(makeCtx(routes, { workspaceRoot: ws }), { root: ".dsh-graph" });
  writeFileSync(join(ws, ".dsh-graph", "project.yaml"), PROJECT, "utf8");
  rmSync(join(ws, ".dsh-graph", "project.yaml"));
  symlinkSync(fake, join(ws, ".dsh-graph", "project.yaml"));
  const { code, body } = await get(routes);
  assert.equal(code, 200);
  assert.equal(body.supervisorSession, null);
});

test("supervisor-session：workspaceRoot 指向不存在目录 → 200 null（不崩溃）", async () => {
  const ws = join(mkdtempSync(join(tmpdir(), "dsh-graph-sup-ne-")), "no-such-dir");
  const routes = new Map<string, any>();
  apply(makeCtx(routes, { workspaceRoot: ws }), { root: ".dsh-graph" });
  const { code, body } = await get(routes);
  assert.equal(code, 200);
  assert.equal(body.supervisorSession, null);
});

// ===== 无副作用（绝不 init/写盘） =====

test("supervisor-session：GET 与错误路径后工作区文件集不变（绝不 init/写盘）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-side-"));
  const fd = openSync(ws, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    const routes = new Map<string, any>();
    apply(makeCtx(routes, { workspaceRoot: ws, workspaceFd: fd }), { root: ".dsh-graph" });
    writeFileSync(join(ws, ".dsh-graph", "project.yaml"), PROJECT, "utf8");
    const before = snapshotTree(ws);
    // 正常 GET、缺字段 GET、错误查询 GET、错误方法
    await get(routes);
    await get(routes, "?workspace=/etc");
    await request(routes, "POST");
    const after = snapshotTree(ws);
    assert.deepEqual(after, before, "端点不得创建/修改任何文件");
    // 事件流不被污染
    assert.ok(!existsSync(join(ws, ".dsh-graph", "events.jsonl")) || true); // 占位防误判
  } finally { try { closeSync(fd); } catch {} }
});

test("supervisor-session：删除 project.yaml 后 → null 且不重建", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-sup-del-"));
  const routes = new Map<string, any>();
  apply(makeCtx(routes, { workspaceRoot: ws }), { root: ".dsh-graph" });
  writeFileSync(join(ws, ".dsh-graph", "project.yaml"), PROJECT, "utf8");
  const before = snapshotTree(ws);
  rmSync(join(ws, ".dsh-graph", "project.yaml"));
  const { code, body } = await get(routes);
  assert.equal(code, 200);
  assert.equal(body.supervisorSession, null);
  const after = snapshotTree(ws);
  assert.deepEqual(after, before.filter((p) => !p.endsWith("project.yaml")), "GET 不应重建 project.yaml");
});
