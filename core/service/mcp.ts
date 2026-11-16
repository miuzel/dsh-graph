/**
 * g-623：localhost MCP endpoint（**只读**，JSON-RPC 2.0 over HTTP，零 SDK 依赖）。
 *
 * 判据 4 / 5 / 6 的落地（顺序不可交换）：
 *
 *   ① 传输边界（peer / Host / Origin，见 policy.ts）——由服务层在任何解析之前执行；
 *   ② **token 校验**：`Authorization: Bearer <token>` 必须命中当前活动秘密；
 *      缺失 / 空 / 错误 / 旧值 / 已轮换 / 已撤销 ⇒ 401，且**不解析 JSON-RPC**、不触碰 store；
 *   ③ **才**解析业务：JSON-RPC 解析 → 方法分派 → 白名单命令。
 *
 * 关键不变式：
 * - token **不接受**作为参数/URL/body 字段：`params.token`、`?token=`、body 里的 `token` 一律
 *   视为「token 伪参数」⇒ 401（不是在业务层被忽略，而是在认证层被拒）。
 * - 每个请求（含重连后的首个请求）都重新校验 token —— **不**用 session id 延续权限；
 *   `initialize` 返回的 `Mcp-Session-Id` 只是协议标识，**不**携带任何权限。
 * - 写/执行/Human Gate 方法**未注册**：`tools/call` 只查只读白名单，其余名字返回 E_UNKNOWN_COMMAND
 *   且零 store 副作用；`tools/list` 只列出白名单工具。
 * - 错误响应**不**回显 token，也不区分「错误 token / 已轮换 / 已撤销」。
 */
import { READ_ONLY_COMMANDS, ServiceError, executeReadOnlyCommand, type ServiceContext } from "./queries.ts";

/** 本服务实现的 MCP 协议版本（单一版本 + 完全向后兼容的默认口径）。 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION] as const;
export const SERVER_NAME = "dsh-graph-local";
export const CONTRACT_VERSION = "1.0-draft.1";

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 标准错误码 + 本服务扩展码（-32xxx 保留区间）。 */
export const RPC_ERROR = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NOT_INITIALIZED: -32002,
});

/** `tools/list` 的工具描述（**从白名单派生**，不可能出现写工具）。 */
export function listToolDescriptors(): any[] {
  return READ_ONLY_COMMANDS.map((c) => {
    const properties: Record<string, any> = {};
    for (const [key, type] of Object.entries(c.input)) {
      properties[key] = type === "number" ? { type: "number" } : type === "boolean" ? { type: "boolean" } : { type: "string" };
    }
    return {
      name: c.name,
      description: c.description,
      inputSchema: {
        type: "object",
        properties,
        required: Object.keys(c.input).length > 0 && c.input.goal === "string" ? ["goal"] : [],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };
  });
}

/** 工具名 ⇒ 白名单命令名（此处不做任何改写：名字一一对应，杜绝别名进入写域）。 */
export function isRegisteredTool(name: unknown): boolean {
  return READ_ONLY_COMMANDS.some((c) => c.name === name);
}

/**
 * **认证层**：token 伪参数检测（在任何业务解析之前调用）。
 * 判定为伪参数即拒绝，**不**因为「业务层本来就不读它」而放行 —— 那会让伪参数看起来可用。
 */
export function hasTokenLikeParam(query: URLSearchParams | null, body: unknown): boolean {
  if (query) {
    for (const key of query.keys()) {
      if (/^(token|access_token|api[_-]?key|authorization)$/i.test(key)) return true;
    }
    for (const value of query.values()) {
      if (/^bearer$/i.test(value.trim())) return true;
    }
  }
  const scan = (v: any, depth = 0): boolean => {
    if (depth > 6 || v === null || typeof v !== "object") return false;
    for (const [k, val] of Object.entries(v)) {
      if (/^(token|access_token|api[_-]?key|authorization|bearer)$/i.test(k)) return true;
      if (val && typeof val === "object" && scan(val, depth + 1)) return true;
    }
    return false;
  };
  return scan(body);
}

/** 从 `Authorization` 头解析 bearer（严格：只接受 `Bearer <token>` 单值形态）。 */
export function parseBearer(header: string | null | undefined): string | null {
  const raw = String(header ?? "").trim();
  if (raw === "") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(raw);
  return m ? m[1] : null;
}

export interface McpContext extends ServiceContext {
  /** 认证回调：返回 true 才继续（服务层注入，持凭据存储的闭包）。 */
  authenticate: (token: string | null) => boolean;
}

function rpcOk(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcErr(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * 分派一条已通过认证的 JSON-RPC 消息。**纯业务**：调用方负责认证与传输边界。
 * 返回 `null` 表示通知（无 id / `notifications/*`）⇒ 不产生响应体。
 */
export function dispatchRpc(ctx: McpContext, msg: any): JsonRpcResponse | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return rpcErr(null, RPC_ERROR.INVALID_REQUEST, "JSON-RPC 消息必须是对象");
  }
  const id: JsonRpcId = msg.id === undefined ? null : msg.id;
  const method = typeof msg.method === "string" ? msg.method : "";
  if (msg.jsonrpc !== "2.0" || method === "") {
    return rpcErr(id, RPC_ERROR.INVALID_REQUEST, "非法 JSON-RPC 请求（需要 jsonrpc=2.0 与 method）");
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  if (RESERVED_PARAM_KEYS.some((k) => Object.prototype.hasOwnProperty.call(params, k))) {
    // 伪 actor/approval/root/token 不得成为可信上下文（认证层已拦 token；这里拦其余可信字段）。
    return rpcErr(id, RPC_ERROR.INVALID_PARAMS, "请求参数包含保留的可信上下文字段（actor/approval/root/token 等不可由客户端提供）");
  }
  try {
    switch (method) {
      case "initialize": {
        const requested = String(params.protocolVersion ?? "");
        const version = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSION;
        return rpcOk(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: CONTRACT_VERSION },
          instructions: "只读看板服务：仅注册只读查询工具；写/执行/人工审批命令未注册。",
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        return null;
      case "ping":
        return isNotification ? null : rpcOk(id, {});
      case "tools/list":
        return rpcOk(id, { tools: listToolDescriptors() });
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || name === "") {
          return rpcErr(id, RPC_ERROR.INVALID_PARAMS, "tools/call 需要非空 name");
        }
        if (!isRegisteredTool(name)) {
          // 未注册（含所有写/执行/Human Gate 工具）⇒ 明确拒绝；**未触碰 store**。
          return rpcErr(id, RPC_ERROR.METHOD_NOT_FOUND, `未注册的工具（MVP 只读白名单）：${name}`, { code: "E_UNKNOWN_COMMAND" });
        }
        const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
        try {
          const value = executeReadOnlyCommand({ graphRoot: ctx.graphRoot, executionWorkspace: ctx.executionWorkspace }, name, args);
          return rpcOk(id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false });
        } catch (e: any) {
          const code = e instanceof ServiceError ? e.code : "E_STORAGE";
          return rpcOk(id, {
            content: [{ type: "text", text: `${code}: ${String(e?.message ?? e)}` }],
            isError: true,
          });
        }
      }
      case "resources/list":
        return rpcOk(id, { resources: [] });
      case "prompts/list":
        return rpcOk(id, { prompts: [] });
      default:
        return rpcErr(id, RPC_ERROR.METHOD_NOT_FOUND, `未实现的方法：${method}`);
    }
  } catch (e: any) {
    return rpcErr(id, RPC_ERROR.INTERNAL_ERROR, `内部错误：${String(e?.message ?? e)}`);
  }
}

/** 保留参数名（可信上下文）：客户端永远不能经 MCP 参数提供。 */
export const RESERVED_PARAM_KEYS: readonly string[] = [
  "actor",
  "owner",
  "human",
  "approval",
  "approved",
  "confirmed",
  "root",
  "graphRoot",
  "executionWorkspace",
  "token",
  "authorization",
  "sessionId",
  "capability",
];

/**
 * 一次完整的 MCP HTTP 请求处理（**认证先行**）。服务层负责在调用本函数之前完成
 * peer/Host/Origin 边界校验；本函数内部顺序为 ①token 伪参数 ②token ③JSON 解析 ④分派。
 *
 * @returns HTTP 状态 + 响应体 + 响应头（`Mcp-Session-Id` 只是协议标识，不含权限）。
 */
export function handleMcpRequest(
  ctx: McpContext,
  req: { authorization?: string | null; query?: URLSearchParams | null; bodyText?: string; sessionId?: string | null },
): { status: number; headers: Record<string, string>; body: string; authenticated: boolean } {
  const json = (obj: unknown) => JSON.stringify(obj);
  const baseHeaders: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

  // ① token 伪参数（URL/body）⇒ 认证拒绝（不等业务层「反正不读」）
  let parsedBody: any = undefined;
  let parseError = false;
  if (typeof req.bodyText === "string" && req.bodyText.trim() !== "") {
    try {
      parsedBody = JSON.parse(req.bodyText);
    } catch {
      parseError = true;
    }
  }
  if (hasTokenLikeParam(req.query ?? null, parseError ? {} : parsedBody)) {
    return {
      status: 401,
      headers: { ...baseHeaders, "www-authenticate": "Bearer" },
      body: json(rpcErr(null, RPC_ERROR.INVALID_REQUEST, "拒绝：token 不得作为参数/URL 传递（只接受 Authorization: Bearer 头）")),
      authenticated: false,
    };
  }

  // ② token 校验（每一请求、含重连）——失败即返回，**不**解析业务
  const token = parseBearer(req.authorization);
  if (!ctx.authenticate(token)) {
    return {
      status: 401,
      headers: { ...baseHeaders, "www-authenticate": "Bearer" },
      body: json(rpcErr(null, RPC_ERROR.INVALID_REQUEST, "未认证：缺少或无效的本地 token")),
      authenticated: false,
    };
  }

  // ③ 解析
  if (parseError) {
    return { status: 400, headers: baseHeaders, body: json(rpcErr(null, RPC_ERROR.PARSE_ERROR, "JSON 解析失败")), authenticated: true };
  }

  // ④ 分派（批量数组按 MCP 语义逐条处理，通知无响应）
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  if (messages.length === 0 || (messages.length === 1 && messages[0] === undefined)) {
    return { status: 400, headers: baseHeaders, body: json(rpcErr(null, RPC_ERROR.INVALID_REQUEST, "空请求体")), authenticated: true };
  }
  const responses: JsonRpcResponse[] = [];
  for (const msg of messages) {
    const r = dispatchRpc(ctx, msg);
    if (r) responses.push(r);
  }
  if (responses.length === 0) {
    return { status: 202, headers: baseHeaders, body: "", authenticated: true };
  }
  const headers = { ...baseHeaders };
  if (req.sessionId) headers["mcp-session-id"] = String(req.sessionId);
  return { status: 200, headers, body: json(Array.isArray(parsedBody) ? responses : responses[0]), authenticated: true };
}
