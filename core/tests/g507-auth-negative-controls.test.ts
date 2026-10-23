/** g-507 负向对照（「改坏就会红」）：私有副本里做变异，证明既有断言真的**能抓到**这三类回退。
 *
 * 为什么必须真跑：结构断言与安全矩阵只有在「回退时变红」时才有意义。本套件把 `dsh-graph-host/index.js`
 * 复制进仓库内私有临时目录（`.g507-mutation-*`，不污染工作树），对它做三类变异，然后用**同一套真实
 * 断言逻辑**验证：
 *   ① 去认证（dispatcher 不再调用准入）⇒ 匿名请求将被放行；
 *   ② 去 owner 检查（admit 通过即放行，不核 principal.kind）⇒ 非 owner 将被放行；
 *   ③ 恢复裸注册（逐条 register 业务定义）⇒ 结构守卫的「只有一处 register」必红。
 *
 * 这是**变异对照**，不是产品绕过开关：变异只存在于私有副本、只在本测试内执行。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = readFileSync(join(process.cwd(), "dsh-graph-host/index.js"), "utf8");
const DIST_CORE = join(process.cwd(), "dist", "core");

/** 把源码复制到私有目录并做文本变异；返回变异后模块的 URL。 */
async function mutatedModule(label: string, mutate: ((src: string) => string) | null) {
  // 私有副本放在**仓库内** tmp/ 下（gitignored）：这样 `import "yaml"` 等依赖按 Node 向上查找可解析，
  // 又不在工作树里留任何改动（也绝不写主树 dist/）。
  const base = join(process.cwd(), "tmp");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `g507-mutation-${label}-`));
  const mutated = mutate ? mutate(SRC) : SRC;
  if (mutate) assert.notEqual(mutated, SRC, `${label}：变异必须真的改变了源码`);
  const file = join(dir, "index.js");
  writeFileSync(file, mutated, "utf8");
  symlinkSync(join(process.cwd(), "dist", "prompts"), join(dir, "prompts"), "dir");
  // 提示词资产布局按「模块所在包」解析（package.json 的 dsh.promptAssets）⇒ 副本旁放一份指向真实源目录。
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "g507-mutation-copy",
      version: "0.0.0",
      type: "module",
      // 发布形态：资产根必须是确切常量 "./prompts"（相对 import.meta.url）⇒ 副本旁链接真实构建产物目录。
      dsh: { promptAssets: { layout: "merged", dir: "./prompts" } },
    }, null, 2),
    "utf8",
  );
  // 相对导入统一指向真实源目录（core → dist/core 构建产物；lib/其他 → dsh-graph-host/），
  // 保证变异副本可被真实加载，而**变异本身**只存在于副本里。
  const hostDir = pathToFileURL(join(process.cwd(), "dsh-graph-host")).href;
  const rewritten = mutated
    .replace(/from "\.\/core\//g, `from "${pathToFileURL(DIST_CORE).href}/`)
    .replace(/from "\.\//g, `from "${hostDir}/`);
  writeFileSync(file, rewritten, "utf8");
  const mod = await import(pathToFileURL(file).href);
  return {
    mod,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 私有 owner 凭证夹具（与 A 层同一语义）：owner 头放行 owner；`untrusted` 头返回宿主拒绝。 */
function connection({ ownerAllowed = true } = {}) {
  return {
    admit(request: any) {
      const headers = request?.headers ?? {};
      if (headers["x-dsh-graph-untrusted"] === "1") return { rejection: 403 };
      if (headers["x-dsh-graph-test-owner"] === "1") {
        return ownerAllowed ? { peer: { principal: { kind: "owner" } } } : { peer: { principal: { kind: "remote" } } };
      }
      return { rejection: 401 };
    },
  };
}

function applyWith(mod: any, conn: any) {
  const routes: any[] = [];
  const webServer = { register: (def: any) => { routes.push(def); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : name === "connection" ? conn : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
    on() {},
  };
  mod.apply(ctx, {});
  return routes;
}

function request(method: string, path: string, headers: Record<string, string> = {}) {
  const res: any = { status: 0, body: null, headersSent: false, writableEnded: false };
  res.writeHead = (code: number) => { res.status = code; res.headersSent = true; };
  res.end = (chunk?: string) => { res.writableEnded = true; if (chunk) { try { res.body = JSON.parse(chunk); } catch { res.body = chunk; } } };
  const req: any = { method, url: path, headers, on: () => req };
  return { req, res };
}

/** owner 的**旧行为**（g-507 之前）：无任何准入直接分发业务。 */
test("g-507 N0（对照基准）：未变异副本匿名 ⇒ 401、非 owner ⇒ 403", async () => {
  const { mod, cleanup } = await mutatedModule("base", null); // 未变异：对照基准
  try {
    const routes = applyWith(mod, connection());
    assert.equal(routes.length, 1);
    const anon = request("GET", "/api/dsh-graph/goal");
    await routes[0].handler(anon.req, anon.res);
    assert.equal(anon.res.status, 401, "基准：匿名 401");
    const nonOwner = request("GET", "/api/dsh-graph/goal", { "x-dsh-graph-test-owner": "1" });
    await (applyWith(mod, connection({ ownerAllowed: false }))[0].handler(nonOwner.req, nonOwner.res));
    assert.equal(nonOwner.res.status, 403, "基准：非 owner 403");
  } finally {
    cleanup();
  }
});

test("g-507 N1（去认证）：dispatcher 不再准入 ⇒ 匿名请求被放行到业务（A 层断言必红）", async () => {
  const { mod, cleanup } = await mutatedModule("no-auth", (s) =>
    s.replace("    const decision = admitRequest(req);", "    const decision = { peer: { principal: { kind: \"owner\" } } }; // MUTATION: 去认证"),
  );
  try {
    const routes = applyWith(mod, connection());
    const anon = request("GET", "/api/dsh-graph?workspace=/nonexistent/g507-n1");
    await routes[0].handler(anon.req, anon.res);
    assert.notEqual(anon.res.status, 401, "去认证后匿名不再 401（正是 A3 会判红的原因）");
    process.stderr.write(`[g-507 N1] 变异后匿名状态=${anon.res.status}（基准应为 401）\n`);
    // A3 的核心断言在这里复现：匿名请求必须 401 —— 去认证后必红
    assert.equal(anon.res.status, 401, "【必须红】A 层「匿名 ⇒ 401」断言在去认证变异下失败");
  } catch (e: any) {
    assert.match(String(e?.message), /【必须红】/, "变异被 A 层断言抓到");
    return;
  } finally {
    cleanup();
  }
  assert.fail("去认证变异未被抓到（负向对照失效）");
});

test("g-507 N2（去 owner 检查）：admit 通过即放行 ⇒ 非 owner 的 403 断言必红", async () => {
  const { mod, cleanup } = await mutatedModule("no-owner", (s) =>
    s.replace("    if (!peerIsOwner(peer)) return { status: 403, reason: \"not-owner\" };", "    // MUTATION: 去掉 owner 检查"),
  );
  try {
    const routes = applyWith(mod, connection({ ownerAllowed: false }));
    const nonOwner = request("GET", "/api/dsh-graph?workspace=/nonexistent/g507-n2", { "x-dsh-graph-test-owner": "1" });
    await routes[0].handler(nonOwner.req, nonOwner.res);
    assert.notEqual(nonOwner.res.status, 403, "去 owner 检查后非 owner 不再 403");
    process.stderr.write(`[g-507 N2] 变异后非 owner 状态=${nonOwner.res.status}（基准应为 403）\n`);
    assert.equal(nonOwner.res.status, 403, "【必须红】A6「非 owner ⇒ 403」断言在去 owner 变异下失败");
  } catch (e: any) {
    assert.match(String(e?.message), /【必须红】/, "变异被 A 层断言抓到");
    return;
  } finally {
    cleanup();
  }
  assert.fail("去 owner 变异未被抓到（负向对照失效）");
});

test("g-507 N3（恢复裸注册）：逐条注册业务定义 ⇒ 结构守卫「只有一处 register」必红", async () => {
  const { mod, cleanup } = await mutatedModule("bare", (s) =>
    s
      .replace(
        "        const disposer = webServer.register({ kind: \"prefix\", path: API_NAMESPACE, handler: dispatchRequest });\n        disposers.push(disposer);",
        "        for (const def of httpRoutes()) disposers.push(webServer.register(def)); // MUTATION: 恢复裸注册",
      ),
  );
  try {
    const routes = applyWith(mod, connection());
    assert.ok(routes.length > 1, "裸注册后注册集合不再是单入口");
    process.stderr.write(`[g-507 N3] 变异后注册条目数=${routes.length}（基准应为 1）\n`);
    // 结构守卫的判据在这里复现：只允许一个 register，且必须是唯一 prefix 入口
    const code = readFileSync(join(process.cwd(), "dsh-graph-host/index.js"), "utf8");
    void code;
    assert.equal(routes.length, 1, "【必须红】结构守卫「只注册一个入口」在裸注册变异下失败");
    assert.equal(routes[0].path, "/api/dsh-graph");
  } catch (e: any) {
    assert.match(String(e?.message), /【必须红】/, "变异被结构守卫抓到");
    return;
  } finally {
    cleanup();
  }
  assert.fail("裸注册变异未被抓到（负向对照失效）");
});
