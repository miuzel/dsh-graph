#!/usr/bin/env node
/**
 * g-507 C 层：对**隔离实例**的真实 HTTP 鉴权矩阵（不打印、不落盘任何凭证）。
 *
 * 用法：node core/tests/fixtures/g507-http-auth-probe.mjs <baseUrl> <workspace>
 *       launch token **从 stdin 读一行**（不走 argv/env，避免出现在进程列表与日志里）。
 *
 * 覆盖：匿名 / 伪造凭证 对 63 条入口 + 未知子路径 ⇒ 401（或 403 于信任边界），业务零触达；
 *       合法 owner（宿主 launch token 交换出的真实 cookie）⇒ 读、可逆写、资产、ETag304、404、405。
 * 输出：每步一行 `STATUS <code> <label>`，最后一行 `OK <n>`。凭证明文绝不打印。
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const base = process.argv[2];
const workspace = process.argv[3]; // 隔离实例的测试 workspace（REST 端点需要显式 workspace）
if (!base || !workspace) {
  console.error("usage: probe <baseUrl> <workspace>   (launch token via stdin)");
  process.exit(2);
}

/** 从 stdin 读取一行 launch token（仅内存持有，不打印、不落盘）。 */
function readTokenFromStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("stdin 读取 token 超时")), 30_000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        process.stdin.pause();
        resolve(buf.slice(0, nl).trim());
      }
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(buf.trim());
    });
    process.stdin.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
const token = await readTokenFromStdin();
if (!token) {
  console.error("probe: 未从 stdin 收到 launch token");
  process.exit(2);
}
const launchUrl = `${base}/?token=${encodeURIComponent(token)}`;

/** 基线 63 条入口（61 exact + 2 prefix 资产），逐条列出以便矩阵覆盖。 */
const EXACT = [
  "/api/dsh-graph", "/api/dsh-graph/supervisor-session", "/api/dsh-graph/goal", "/api/dsh-graph/refresh-results",
  "/api/dsh-graph/set-criteria", "/api/dsh-graph/relations", "/api/dsh-graph/accept", "/api/dsh-graph/resolve-accept",
  "/api/dsh-graph/worktrees", "/api/dsh-graph/worktrees/clean", "/api/dsh-graph/transition", "/api/dsh-graph/order",
  "/api/dsh-graph/move-goal", "/api/dsh-graph/edit-description", "/api/dsh-graph/rename-goal", "/api/dsh-graph/memory/list",
  "/api/dsh-graph/memory/add", "/api/dsh-graph/memory/delete", "/api/dsh-graph/memory/toggle-tools", "/api/dsh-graph/set-goal-tags", "/api/dsh-graph/set-goal-budget",
  "/api/dsh-graph/set-goal-type", "/api/dsh-graph/add-card", "/api/dsh-graph/card", "/api/dsh-graph/shared-cards",
  "/api/dsh-graph/create-shared-card", "/api/dsh-graph/attach-shared-card", "/api/dsh-graph/unreference-shared-card",
  "/api/dsh-graph/delete-shared-card", "/api/dsh-graph/convert-card-to-shared", "/api/dsh-graph/convert-card-to-owned",
  "/api/dsh-graph/delete-card", "/api/dsh-graph/attachments", "/api/dsh-graph/attachment", "/api/dsh-graph/store-attachment",
  "/api/dsh-graph/delete-attachment", "/api/dsh-graph/start-collection", "/api/dsh-graph/define-polish",
  "/api/dsh-graph/start-execution", "/api/dsh-graph/start-review", "/api/dsh-graph/spawn-options", "/api/dsh-graph/settings",
  "/api/dsh-graph/create-goal", "/api/dsh-graph/set-directive", "/api/dsh-graph/set-description", "/api/dsh-graph/add-comment",
  "/api/dsh-graph/record-handoff", "/api/dsh-graph/archive", "/api/dsh-graph/postpone", "/api/dsh-graph/unarchive",
  "/api/dsh-graph/delete", "/api/dsh-graph/unbind", "/api/dsh-graph/abandon-attempt", "/api/dsh-graph/create-version",
  "/api/dsh-graph/rename-version", "/api/dsh-graph/delete-version", "/api/dsh-graph/version-detail",
  "/api/dsh-graph/version-goals", "/api/dsh-graph/backlog-goals", "/api/dsh-graph/release-version",
  "/api/dsh-graph/set-version-status", "/api/dsh-graph/help/catalog",
];
const ASSETS = ["/api/dsh-graph/diagram/design-philosophy.lifecycle.html", "/api/dsh-graph/help/asset/supervisor-guide.zh.md"];
const UNKNOWN = ["/api/dsh-graph/no-such-endpoint", "/api/dsh-graph/goal/extra"];

const url = new URL(base);
const host = url.host;

function request(method, path, headers = {}, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path,
        method,
        headers: {
          host,
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = text;
          try { parsed = text ? JSON.parse(text) : null; } catch { /* 原文 */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, text });
        });
      },
    );
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: String(e), text: "" }));
    if (payload) req.write(payload);
    req.end();
  });
}

const lines = [];
let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  lines.push(`STATUS ${actual} ${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (expected ${expected})`}`);
}

// ① 匿名 / 伪造凭证矩阵：63 条 + 未知子路径
const all = [...EXACT, ...ASSETS, ...UNKNOWN];
for (const [i, path] of all.entries()) {
  const anon = await request(i % 2 === 0 ? "GET" : "POST", path, {}, undefined);
  check(`anonymous ${path}`, anon.status, 401);
  const forged = await request("POST", path, { cookie: "dsh-auth-forged=v1.eyJ2ZXJzaW9uIjoxfQ.deadbeef", "x-dsh-graph-test-owner": "1" }, { title: "x" });
  check(`forged ${path}`, forged.status, 401);
}
// ② 合法 owner：用宿主自己的 launch token 交换 cookie（同源 GET /?token=…）
const rootRes = await request("GET", `/?token=${encodeURIComponent(token)}`);
// 宿主的真实交换语义：带发令 token 的 GET / 铸 cookie 并 **302/303 重定向到干净 URL**（不是 200）。
check("owner index exchange (redirect mints cookie)", [302, 303].includes(rootRes.status) ? 1 : 0, 1);
const setCookie = rootRes.headers["set-cookie"]?.[0];
const cookie = setCookie ? setCookie.split(";")[0] : "";
check("owner cookie minted", cookie.startsWith("dsh-auth-") ? 1 : 0, 1);
const owner = { cookie };

// ③ 合法 owner 业务面：读 / 可逆写 / 资产 / ETag304 / 404 / 405
const wsQ = `?workspace=${encodeURIComponent(workspace)}`;
const board = await request("GET", `/api/dsh-graph${wsQ}`, owner);
check("owner board", board.status, 200);
const etag = board.headers.etag;
check("owner board etag present", etag ? 1 : 0, 1);
const notModified = await request("GET", `/api/dsh-graph${wsQ}`, { ...owner, "if-none-match": String(etag) });
check("owner board 304", notModified.status, 304);
const created = await request("POST", `/api/dsh-graph/create-version${wsQ}`, owner, { slug: "g507-probe", name: "g507 probe" });
check("owner create-version", created.status, 200);
const listed = await request("GET", `/api/dsh-graph/version-detail${wsQ}&slug=g507-probe`, owner);
check("owner version-detail", listed.status, 200);
const removed = await request("POST", `/api/dsh-graph/delete-version${wsQ}`, owner, { slug: "g507-probe" });
check("owner delete-version (reversible write)", removed.status, 200);
for (const asset of ASSETS) {
  const res = await request("GET", asset, owner);
  check(`owner asset ${asset}`, res.status, 200);
  const head = await request("HEAD", asset, owner);
  check(`owner asset HEAD ${asset}`, head.status, 200);
}
const neg = await request("GET", "/api/dsh-graph/no-such-endpoint", owner);
check("owner unknown 404", neg.status, 404);
const wrongMethod = await request("GET", `/api/dsh-graph/create-version${wsQ}`, owner);
check("owner wrong method 405", wrongMethod.status, 405);
check("entrance count", all.length, 63 + UNKNOWN.length);

console.log(lines.join("\n"));
console.log(`OK ${lines.filter((l) => l.includes(" PASS ")).length}/${lines.length} failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
