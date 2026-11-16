/**
 * g-623：独立本地服务**传输层**（同一进程同时提供 Web 静态入口 / Web API / MCP endpoint）。
 *
 * 判据 1 / 5 的落地：
 * - 三个入口共用**一个** HTTP 服务器、一个端口、一个 application 层（`queries.ts` 白名单）：
 *   `GET /` `/app.js` `/app.css`（静态）、`/api/*`（Web API）、`POST /mcp`（MCP）。
 * - **CLI adapter 不承担 UI**：本模块只在独立服务进程里被 `serve.ts` 启动，`core/cli/*` 不 import 它。
 * - Web 会话与 MCP token **分离**：
 *     · Web API 只认 HttpOnly 会话 Cookie（由 `POST /api/session` 用 token 换取）；
 *     · MCP 只认 `Authorization: Bearer <token>`；
 *     · **MCP token 不能调用人工审批路由**：本服务根本没有审批/写路由，且 `/api/*` 一律
 *       拒绝 Bearer（即使带了正确 MCP token 也不升格为 Web 会话或审批权）。
 * - CORS：**从不**下发 `Access-Control-Allow-Origin`（同 origin 页面无需 CORS）；带 Origin 但
 *   非同一 allowlist 的请求在边界层即被拒绝（见 `policy.checkRequestBoundary`）。
 * - 一切副作用在**请求处理之前**被排除：边界校验 → 认证 → 业务；未认证/越界请求不触碰 store。
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ALLOWED_BIND_HOST, checkRequestBoundary, headerValue, isAllowedOrigin, validateBindHost } from "./policy.ts";
import { CredentialStore, WebSessionStore } from "./credentials.ts";
import {
  READ_ONLY_COMMANDS,
  ServiceError,
  executeReadOnlyCommand,
  queryBoard,
  queryGoal,
  queryGoalCriteria,
  queryGoalCards,
  queryGoalResults,
  querySettings,
  listGoals,
  listVersions,
  listSafeAttachments,
  readSafeAttachment,
  queryEvents,
  type ServiceContext,
} from "./queries.ts";
import { handleMcpRequest, parseBearer } from "./mcp.ts";
import { STATIC_ROUTES } from "./web-app.ts";

/** Web 会话 Cookie 名（HttpOnly + SameSite=Strict；本地 HTTP 下不设 Secure，避免 http:// 被拒收）。 */
export const WEB_SESSION_COOKIE = "dsh_graph_web";
/** 请求体上限（只读服务：小 JSON；附件读走 GET）。 */
export const MAX_REQUEST_BYTES = 64 * 1024;

export interface ServiceOptions {
  /** graphRoot（只读看板）。必须已由调用方校验与 executionWorkspace 分离。 */
  graphRoot: string;
  executionWorkspace: string;
  /** 服务私有状态目录（凭据 + 运行配置；0700）。 */
  stateDir: string;
  /** 监听端口（0 = 由系统分配空闲高位端口）。 */
  port?: number;
  /** 绑定地址（只接受 127.0.0.1）。 */
  host?: string;
  /** 注入的随机源（测试）。 */
  secretFactory?: (bytes: number) => string;
  /** 审计日志接收器（**只**允许脱敏后的事件文本；默认丢弃）。 */
  audit?: (line: string) => void;
}

export interface RunningService {
  server: Server;
  /** 实际监听端口（来自 `server.address()`）。 */
  port: number;
  /** 实际绑定地址（恒为 127.0.0.1）。 */
  host: string;
  origin: string;
  /** 凭据指纹（可安全展示）。 */
  tokenFingerprint: string;
  /** 轮换：旧 token/旧会话立即失效。 */
  rotateToken(): { fingerprint: string; generation: number };
  /** 撤销：删除凭据文件并使一切校验失败。 */
  revokeToken(): void;
  /** 停止监听（幂等）。 */
  close(): Promise<void>;
  credentials: CredentialStore;
  sessions: WebSessionStore;
  /** 只读自省（测试/诊断）：请求计数与拒绝原因分布。 */
  stats(): { total: number; rejected: Record<string, number> };
}

/** 绑定地址校验的**唯一入口**：任何非法主机在创建服务器之前即被拒绝（不留监听）。 */
export function resolveBindHost(host: string | null | undefined): string {
  const verdict = validateBindHost(host ?? ALLOWED_BIND_HOST);
  if (!verdict.ok) {
    const err: any = new Error(verdict.message);
    err.code = `E_BIND_${verdict.reason.toUpperCase().replace(/-/g, "_")}`;
    err.reason = verdict.reason;
    throw err;
  }
  return verdict.host;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(text);
}

function errorResponse(res: ServerResponse, err: unknown): void {
  if (err instanceof ServiceError) {
    jsonResponse(res, err.status, { ok: false, code: err.code, message: err.message });
    return;
  }
  jsonResponse(res, 500, { ok: false, code: "E_STORAGE", message: "内部错误" });
}

function readBodyCapped(req: IncomingMessage, cap = MAX_REQUEST_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > cap) {
        done = true;
        reject(new ServiceError("E_INPUT" as any, "请求体过大", 413));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

/** 从 Cookie 头取出会话 bearer（只认本服务 cookie 名）。 */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  const raw = String(cookieHeader ?? "");
  if (raw === "") return null;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (name !== WEB_SESSION_COOKIE) continue;
    const value = part.slice(idx + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/**
 * 启动独立本地服务。
 *
 * 启动序列（全部 fail-closed，任一失败 ⇒ 不监听）：
 *   ① 绑定地址必须是 127.0.0.1（拒绝 0.0.0.0 / :: / LAN / 主机名）；
 *   ② 凭据：初始化/读取 + 目录与文件权限自检（0700/0600）；
 *   ③ 监听（端口占用 ⇒ 明确报错，不抢占、不回退其他端口）；
 *   ④ 以**实际**监听端口构造 Host/Origin allowlist。
 */
export async function startService(opts: ServiceOptions): Promise<RunningService> {
  const host = resolveBindHost(opts.host ?? ALLOWED_BIND_HOST);
  const credentials = new CredentialStore({ stateDir: opts.stateDir, secretFactory: opts.secretFactory });
  const opened = credentials.open();
  const sessions = new WebSessionStore({ secretFactory: opts.secretFactory });
  const ctx: ServiceContext = { graphRoot: opts.graphRoot, executionWorkspace: opts.executionWorkspace };
  const audit = opts.audit ?? (() => {});
  const stats = { total: 0, rejected: {} as Record<string, number> };
  const noteReject = (code: string) => {
    stats.rejected[code] = (stats.rejected[code] ?? 0) + 1;
    // 审计行只含稳定错误码与脱敏指纹，绝不含 token/会话原文。
    audit(`reject code=${code} token=${credentials.fingerprint()}`);
  };

  /** 每次请求都取**实际**端口（listen(0) 时端口只有 listen 后才知道）。 */
  let boundPort = Number(opts.port) || 0;

  const server = createServer(async (req, res) => {
    stats.total += 1;
    const url = new URL(req.url ?? "/", `http://${ALLOWED_BIND_HOST}:${boundPort}`);

    // ── ① 传输边界（peer / Host / Origin）：任何业务解析之前 ─────────────────
    const boundary = checkRequestBoundary(
      { headers: req.headers as any, socket: { remoteAddress: req.socket.remoteAddress ?? null } },
      { port: boundPort },
    );
    if (!boundary.ok) {
      noteReject(boundary.code);
      jsonResponse(res, 403, { ok: false, code: boundary.code, message: boundary.message });
      return;
    }

    try {
      // ── ② MCP endpoint（认证先行，见 mcp.handleMcpRequest）─────────────────
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, code: "E_INPUT", message: "MCP endpoint 只接受 POST" }, { allow: "POST" });
          return;
        }
        const bodyText = await readBodyCapped(req);
        const out = handleMcpRequest(
          { ...ctx, authenticate: (t) => credentials.verify(t) },
          {
            authorization: headerValue(req.headers as any, "authorization"),
            query: url.searchParams,
            bodyText,
            sessionId: headerValue(req.headers as any, "mcp-session-id"),
          },
        );
        if (!out.authenticated) noteReject("mcp_unauthorized");
        res.writeHead(out.status, out.headers);
        res.end(out.body);
        return;
      }

      // ── ③ Web 静态入口（无认证要求：页面本身不含秘密/数据）───────────────────
      const staticRes = STATIC_ROUTES[url.pathname];
      if (staticRes && req.method === "GET") {
        res.writeHead(200, {
          "content-type": staticRes.contentType,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          // 静态页只允许从自身加载资源：更严格的 CSP 兜底同 origin 语义。
          "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
          "referrer-policy": "no-referrer",
        });
        res.end(staticRes.body);
        return;
      }

      // ── ④ Web API（只认 HttpOnly 会话 Cookie；**拒绝** Bearer）─────────────
      if (url.pathname.startsWith("/api/")) {
        const bearer = parseBearer(headerValue(req.headers as any, "authorization"));
        if (bearer !== null) {
          // MCP token **不能**换取 Web 会话/审批权：必须由人在本地 UI 用 token 走 POST /api/session。
          noteReject("api_bearer_forbidden");
          jsonResponse(res, 401, {
            ok: false,
            code: "E_FORBIDDEN",
            message: "Web API 不接受 Bearer 凭据：MCP token 不是 Web 会话，也不能调用任何人工审批路由",
          });
          return;
        }
        await handleApi(req, res, url, ctx, credentials, sessions, noteReject);
        return;
      }

      // ── ⑤ 兜底 404（未注册路由 ⇒ 不存在，不是「禁用开关」）────────────────
      jsonResponse(res, 404, { ok: false, code: "E_UNKNOWN_COMMAND", message: `未注册的路由：${url.pathname}` });
    } catch (e) {
      errorResponse(res, e);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: any) => {
      server.removeListener("error", onError);
      if (err && (err.code === "EADDRINUSE" || err.code === "EACCES")) {
        const e: any = new Error(`端口不可用（${opts.port}）：${err.code} —— 不抢占已占用端口，也不回退到其他端口`);
        e.code = "E_PORT_UNAVAILABLE";
        reject(e);
        return;
      }
      reject(err);
    };
    server.once("error", onError);
    server.listen({ host, port: Number(opts.port) || 0 }, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr === "string") {
    await new Promise<void>((r) => server.close(() => r()));
    throw new Error("无法确定实际监听端口");
  }
  boundPort = addr.port;
  const origin = `http://${ALLOWED_BIND_HOST}:${boundPort}`;

  return {
    server,
    port: boundPort,
    host,
    origin,
    tokenFingerprint: opened.fingerprint,
    credentials,
    sessions,
    rotateToken() {
      const r = credentials.rotate();
      sessions.revokeAll(); // 轮换 ⇒ 旧 Web 会话立即撤销
      return r;
    },
    revokeToken() {
      credentials.revoke();
      sessions.revokeAll();
    },
    stats: () => ({ total: stats.total, rejected: { ...stats.rejected } }),
    async close() {
      sessions.revokeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 关闭 keep-alive 连接，确保 close 真正完成（否则测试/卸载会挂住）。
        (server as any).closeAllConnections?.();
      });
    },
  };
}

/** Web API 分派（全部只读；每个路由都复用 `queries.ts` 的白名单实现）。 */
async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ServiceContext,
  credentials: CredentialStore,
  sessions: WebSessionStore,
  noteReject: (code: string) => void,
): Promise<void> {
  const method = req.method ?? "GET";

  // ── 会话路由：唯一的「用 token 换会话」入口（仅本机 UI 人工操作）──────────────
  if (url.pathname === "/api/session") {
    if (method === "POST") {
      const bodyText = await readBodyCapped(req);
      let parsed: any = {};
      try {
        parsed = JSON.parse(bodyText || "{}");
      } catch {
        jsonResponse(res, 400, { ok: false, code: "E_INPUT", message: "请求体不是合法 JSON" });
        return;
      }
      // token 只在这里出现一次，且**只**从请求体取（不接受 URL query）。
      if (url.searchParams.has("token")) {
        noteReject("session_token_in_query");
        jsonResponse(res, 400, { ok: false, code: "E_INPUT", message: "token 不得放在 URL query 中（只接受同 origin 请求体）" });
        return;
      }
      const token = typeof parsed?.token === "string" ? parsed.token : null;
      if (!credentials.verify(token)) {
        noteReject("session_bad_token");
        jsonResponse(res, 401, { ok: false, code: "E_FORBIDDEN", message: "token 不正确" });
        return;
      }
      const session = sessions.create(credentials.generation);
      const maxAge = Math.floor((8 * 60 * 60));
      jsonResponse(res, 200, { ok: true, authenticated: true }, {
        // HttpOnly：页面 JS 读不到；SameSite=Strict：跨站请求不携带；不带 Secure 以适配本地 HTTP。
        "set-cookie": `${WEB_SESSION_COOKIE}=${session.secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`,
      });
      return;
    }
    if (method === "DELETE") {
      sessions.revokeAll();
      jsonResponse(res, 200, { ok: true }, {
        "set-cookie": `${WEB_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      });
      return;
    }
    if (method === "GET") {
      const session = sessions.verify(readSessionCookie(headerValue(req.headers as any, "cookie")), credentials.generation);
      jsonResponse(res, 200, { ok: true, authenticated: session !== null });
      return;
    }
    jsonResponse(res, 405, { ok: false, code: "E_INPUT", message: "不支持的方法" }, { allow: "GET, POST, DELETE" });
    return;
  }

  // ── 其余 API 一律要求有效 Web 会话（**不**接受 Bearer；已在调用方拦过）──────────
  const session = sessions.verify(readSessionCookie(headerValue(req.headers as any, "cookie")), credentials.generation);
  if (!session) {
    noteReject("api_unauthenticated");
    jsonResponse(res, 401, { ok: false, code: "E_FORBIDDEN", message: "需要本地 Web 会话（请先在本地 UI 登录）" });
    return;
  }
  if (method !== "GET") {
    // 只读服务：没有任何写路由（不是「开关关闭」，而是不存在）。
    noteReject("api_write_attempt");
    jsonResponse(res, 405, { ok: false, code: "E_UNKNOWN_COMMAND", message: "MVP 只读：本服务没有写/执行/审批路由" }, { allow: "GET" });
    return;
  }

  const q = url.searchParams;
  switch (url.pathname) {
    case "/api/board":
      jsonResponse(res, 200, queryBoard(ctx, { includeArchived: q.get("includeArchived") === "true", lazy: q.get("lazy") === "true" }));
      return;
    case "/api/goals":
      jsonResponse(res, 200, listGoals(ctx, { includeArchived: q.get("includeArchived") === "true" }));
      return;
    case "/api/versions":
      jsonResponse(res, 200, listVersions(ctx));
      return;
    case "/api/goal":
      jsonResponse(res, 200, queryGoal(ctx, q.get("goal")));
      return;
    case "/api/criteria":
      jsonResponse(res, 200, queryGoalCriteria(ctx, q.get("goal")));
      return;
    case "/api/cards":
      jsonResponse(res, 200, queryGoalCards(ctx, q.get("goal")));
      return;
    case "/api/results":
      jsonResponse(res, 200, queryGoalResults(ctx, q.get("goal")));
      return;
    case "/api/settings":
      jsonResponse(res, 200, querySettings(ctx));
      return;
    case "/api/attachments":
      if (q.has("name")) {
        jsonResponse(res, 200, readSafeAttachment(ctx, q.get("name")));
        return;
      }
      jsonResponse(res, 200, listSafeAttachments(ctx));
      return;
    case "/api/events":
      jsonResponse(res, 200, queryEvents(ctx, { goal: q.get("goal") ?? undefined, limit: q.get("limit") ? Number(q.get("limit")) : undefined }));
      return;
    default: {
      // 未注册路由：即使名字看起来像写命令（accept/deliver/claim/start…）也不存在。
      noteReject("api_unknown_route");
      jsonResponse(res, 404, { ok: false, code: "E_UNKNOWN_COMMAND", message: `未注册的 API 路由：${url.pathname}` });
      return;
    }
  }
}

/** Web API 路由清单（供 self-check / 文档 / 测试断言「没有写路由」）。 */
export const WEB_API_ROUTES: readonly string[] = Object.freeze([
  "/api/session",
  "/api/board",
  "/api/goals",
  "/api/versions",
  "/api/goal",
  "/api/criteria",
  "/api/cards",
  "/api/results",
  "/api/settings",
  "/api/attachments",
  "/api/events",
]);

/** 白名单命令名（供 self-check 断言 MCP 与 Web 同源）。 */
export const SERVICE_TOOL_NAMES: readonly string[] = READ_ONLY_COMMANDS.map((c) => c.name);

/** 稳定指纹辅助（诊断用；不暴露原文）。 */
export function fingerprintOf(secret: string): string {
  return createHash("sha256").update(String(secret)).digest("hex").slice(0, 12);
}

/** 生成一个随机端口探测用的非令牌（仅供测试/诊断，**不**用作凭据）。 */
export function ephemeralId(): string {
  return randomBytes(8).toString("hex");
}

export { isAllowedOrigin };
