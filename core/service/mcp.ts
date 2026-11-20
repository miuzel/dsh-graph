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
import { READ_ONLY_COMMANDS, RESERVED_ARG_KEYS, ServiceError, executeReadOnlyCommand, type ServiceContext } from "./queries.ts";
import {
  HUMAN_GATE_PARTIAL,
  HUMAN_GATE_TOOLS,
  MCP_WRITE_ACTOR,
  WRITE_MODE_COMMANDS,
  WRITE_MODE_DISABLED_REASON,
  isWriteModeCommand,
  type WriteCommand,
} from "./write-commands.ts";

/** 本服务实现的 MCP 协议版本（单一版本 + 完全向后兼容的默认口径）。 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION] as const;
export const SERVER_NAME = "goal-graph-local";
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

/** 写模式开关（**服务端**决定；默认 false）。取值只可能来自服务配置/启动选项，见 `write-commands.ts`。 */
export function isWriteModeEnabled(opts?: { writeMode?: { enabled?: boolean } | boolean } | null): boolean {
  const w = opts?.writeMode;
  if (typeof w === "boolean") return w === true;
  return w?.enabled === true;
}

/** 写模式下的工具集合（只读 + 写白名单）；**关闭时与只读集合逐项一致**。 */
export function registeredCommands(opts?: { writeMode?: { enabled?: boolean } | boolean } | null): readonly WriteCommand[] {
  if (!isWriteModeEnabled(opts)) return [] as readonly WriteCommand[];
  return WRITE_MODE_COMMANDS;
}

/** 全部已注册工具名（只读 + 按需写）。关闭写模式时**恰为**只读名单。 */
export function registeredToolNames(opts?: { writeMode?: { enabled?: boolean } | boolean } | null): readonly string[] {
  const writes = registeredCommands(opts);
  return [...READ_ONLY_COMMANDS.map((c) => c.name), ...writes.map((c) => c.name)];
}

/** `tools/list` 的工具描述（**从已注册集合派生**；写模式关闭时不可能出现写工具）。 */
export function listToolDescriptors(opts?: { writeMode?: { enabled?: boolean } | boolean } | null): any[] {
  const writes = registeredCommands(opts);
  const descriptors = READ_ONLY_COMMANDS.map((c) => {
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
  for (const c of writes) {
    const properties: Record<string, any> = {};
    for (const [key, type] of Object.entries(c.input)) properties[key] = schemaForType(type);
    descriptors.push({
      name: c.name,
      description: c.gateNote ? `${c.description}（边界：${c.gateNote}）` : c.description,
      inputSchema: { type: "object", properties, required: [...(c.required ?? [])], additionalProperties: false },
      // 写工具**不得**声明 readOnlyHint：客户端据此判断破坏性。
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    });
  }
  return descriptors;
}

function schemaForType(type: string): Record<string, any> {
  switch (type) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "string[]":
      return { type: "array", items: { type: "string" } };
    case "object":
      return { type: "object" };
    default:
      return { type: "string" };
  }
}

/**
 * 工具名 ⇒ 已注册命令判定（名字一一对应，杜绝别名）。
 * 写模式关闭时写工具名**根本不注册**（与 g-623 逐项一致）；开启后只认 `WRITE_MODE_COMMANDS` 白名单。
 */
export function isRegisteredTool(name: unknown, opts?: { writeMode?: { enabled?: boolean } | boolean } | null): boolean {
  if (READ_ONLY_COMMANDS.some((c) => c.name === name)) return true;
  return isWriteModeEnabled(opts) && isWriteModeCommand(name);
}

/** 写模式下**仍 fail-closed** 的工具名（Human Gate / 主管身份 / 执行派发）。 */
export const HUMAN_GATE_TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(HUMAN_GATE_TOOLS));

/**
 * **认证层**：token 伪参数检测（在任何业务解析之前调用）。
 * 判定为伪参数即拒绝，**不**因为「业务层本来就不读它」而放行 —— 那会让伪参数看起来可用。
 */
export function hasTokenLikeParam(query: URLSearchParams | null, body: unknown): boolean {
  if (query) {
    for (const key of query.keys()) {
      if (/^(token|access_token|api[_-]?key|authorization)$/i.test(key)) return true;
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
  /**
   * 写模式（g-632 A / g-637）：**只能由服务端启动配置决定**（`serve --allow-write` 或 `goal-graph mcp` 默认写模式）。
   * 本对象从不从请求参数构造 —— 请求里出现任何写模式开关参数都按保留参数拒绝。
   */
  writeMode?: { enabled: boolean };
  /** 可选：当前工作区已自动启动/复用的本地 Web 看板基址（如 `http://127.0.0.1:43210`），仅写入 initialize 提示，不含秘密。 */
  webOrigin?: string;
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
        const baseInstructions = isWriteModeEnabled(ctx)
          ? `写模式已由服务端显式开启（actor 固定为 ${MCP_WRITE_ACTOR}）：执行类写工具可达；` +
            `但人工裁决（graph_resolve_accept、transition→delivered）与主管身份/执行派发仍 fail-closed。`
          : "只读看板服务：仅注册只读查询工具；写/执行/人工审批命令未注册。";
        const webNote = ctx.webOrigin ? ` 当前工作区本地看板：${ctx.webOrigin}/` : "";
        return rpcOk(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: CONTRACT_VERSION },
          instructions: `${baseInstructions}${webNote}`,
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        return null;
      case "ping":
        return isNotification ? null : rpcOk(id, {});
      case "tools/list":
        return rpcOk(id, { tools: listToolDescriptors(ctx) });
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || name === "") {
          return rpcErr(id, RPC_ERROR.INVALID_PARAMS, "tools/call 需要非空 name");
        }
        if (!isRegisteredTool(name, ctx)) {
          // 未注册 ⇒ 明确拒绝；**未触碰 store**。三种情形给出可读原因（都仍是 E_UNKNOWN_COMMAND）：
          // ① 写模式关闭 ② 写模式下仍保留给人工/主管的工具 ③ 完全未实现的名字（与 g-623 逐字一致）。
          return rpcErr(id, RPC_ERROR.METHOD_NOT_FOUND, unregisteredToolReason(name, ctx), { code: "E_UNKNOWN_COMMAND" });
        }
        const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
        // g-632 A：写模式开关族也是保留参数 —— 出现在**工具 arguments** 里同样必须被拒
        // （不只靠工具 schema 的 additionalProperties，因为只读路径会把未声明键静默忽略）。
        for (const key of Object.keys(args)) {
          if (WRITE_MODE_SWITCH_KEYS.has(key)) {
            return rpcErr(id, RPC_ERROR.INVALID_PARAMS, "请求参数包含保留的可信上下文字段（写模式开关不可由客户端提供）");
          }
        }
        try {
          const value = isWriteModeCommand(name)
            ? executeWriteCommand(ctx, name, args)
            : executeReadOnlyCommand({ graphRoot: ctx.graphRoot, executionWorkspace: ctx.executionWorkspace }, name, args);
          return rpcOk(id, {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: toStructuredContent(value),
            isError: false,
          });
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
        // JSON-RPC 2.0 规范：无 id 的通知（如未知 notifications/*）不得产出任何响应。
        if (msg.id === undefined) return null;
        return rpcErr(id, RPC_ERROR.METHOD_NOT_FOUND, `未实现的方法：${method}`);
    }
  } catch (e: any) {
    return rpcErr(id, RPC_ERROR.INTERNAL_ERROR, `内部错误：${String(e?.message ?? e)}`);
  }
}

/**
 * MCP 规范（CallToolResult）：`structuredContent` 必须是 JSON 对象（Record<string, unknown>），
 * 不得返回裸数组或原始值（Claude Code 等严格 Zod 校验客户端会直接拦截裸数组）。
 * 数组统一封装为 `{ items, count }`；普通对象原样透传；其他原始值封装为 `{ value }`。
 */
export function toStructuredContent(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { items: value, count: value.length };
  if (value !== null && typeof value === "object") return value as Record<string, unknown>;
  return { value };
}

/**
 * 保留参数名（可信上下文）：客户端永远不能经 MCP 参数提供。
 *
 * g-632 A：**写模式开关也是可信上下文** —— `allowWrite` / `writeMode` / `mode` 等出现在请求
 * （顶层 params、tools/call arguments、或 initialize 参数）时一律 INVALID_PARAMS 拒绝。
 * 写模式只能由服务端启动动作（`serve --allow-write`）决定，任何请求都不得把自己升格为可写。
 */
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
  // g-632 A：写模式开关（服务端显式动作，不是请求参数）
  "allowWrite",
  "allow_write",
  "allowwrite",
  "writeMode",
  "write_mode",
  "writable",
  "readOnly",
  "read_only",
  "write",
  "mode",
];

/** g-632 A：写模式开关族的保留参数名（请求任何位置出现都拒绝；**不是**开启通道）。 */
export const WRITE_MODE_SWITCH_KEYS: ReadonlySet<string> = new Set([
  "allowWrite",
  "allow_write",
  "allowwrite",
  "writeMode",
  "write_mode",
  "writable",
  "readOnly",
  "read_only",
  "write",
  "mode",
]);

/** 未注册工具的可读原因（三种情形；对外错误码仍是 E_UNKNOWN_COMMAND，与 g-623 一致）。 */
export function unregisteredToolReason(name: unknown, opts?: { writeMode?: { enabled?: boolean } | boolean } | null): string {
  const tool = String(name);
  if (!isWriteModeEnabled(opts)) {
    // 关闭时：写模式白名单里的名字给出「如何开启」；其余（含 Human Gate）保持 g-623 原文。
    if (isWriteModeCommand(tool)) return `${WRITE_MODE_DISABLED_REASON}（工具：${tool}）`;
    return `未注册的工具（MVP 只读白名单）：${tool}`;
  }
  const gate = HUMAN_GATE_TOOLS[tool];
  if (gate) return `写模式下仍 fail-closed（${tool}）：${gate}`;
  return `未注册的工具（不在写模式白名单内）：${tool}`;
}

/**
 * 执行一个**写模式**命令（只在 `writeMode.enabled === true` 且名字在 `WRITE_MODE_COMMANDS` 内时可达）。
 *
 * 两道运行时防线（即使上游判定被误改也不会退化为提权）：
 * ① 写模式关闭 ⇒ 直接 E_UNKNOWN_COMMAND（**不触碰 store**）；
 * ② Human Gate 名单 ⇒ E_FORBIDDEN（不执行任何写操作）。
 */
export function executeWriteCommand(ctx: McpContext, name: string, args: Record<string, any>): unknown {
  if (!isWriteModeEnabled(ctx)) {
    throw new ServiceError("E_UNKNOWN_COMMAND", `${WRITE_MODE_DISABLED_REASON}（工具：${name}）`);
  }
  if (HUMAN_GATE_TOOLS[name]) {
    throw new ServiceError("E_FORBIDDEN", `写模式下仍 fail-closed（${name}）：${HUMAN_GATE_TOOLS[name]}`);
  }
  const cmd = WRITE_MODE_COMMANDS.find((c) => c.name === name);
  if (!cmd) throw new ServiceError("E_UNKNOWN_COMMAND", `未注册的工具（不在写模式白名单内）：${name}`);
  // 保留参数（actor/owner/human/approval/root/…）一律拒绝：伪可信上下文不可能生效。
  for (const key of Object.keys(args ?? {})) {
    if (RESERVED_ARG_KEYS.has(key)) throw new ServiceError("E_FORBIDDEN", `参数 ${key} 不可由客户端提供`);
  }
  const safe: Record<string, any> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined) continue;
    safe[key] = value;
  }
  return cmd.run({ graphRoot: ctx.graphRoot, executionWorkspace: ctx.executionWorkspace }, safe);
}

/**
 * 纯 JSON-RPC 2.0 负载分派核心（HTTP `handleMcpRequest` 与 stdio `goal-graph mcp` 100% 共用同一真源）。
 * - 解析错误 / 空体 ⇒ `status=400` + 对应 JSON-RPC 错误；
 * - 全为通知（无 id）⇒ `status=202` + `response=null`（调用方不产出响应）；
 * - 正常 ⇒ `status=200` + 单条或批量响应对象。
 */
export function dispatchJsonRpcPayload(
  ctx: McpContext,
  parsedBody: unknown,
): { status: number; response: JsonRpcResponse | JsonRpcResponse[] | null } {
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  if (messages.length === 0 || (messages.length === 1 && messages[0] === undefined)) {
    return { status: 400, response: rpcErr(null, RPC_ERROR.INVALID_REQUEST, "空请求体") };
  }
  const responses: JsonRpcResponse[] = [];
  for (const msg of messages) {
    const r = dispatchRpc(ctx, msg);
    if (r) responses.push(r);
  }
  if (responses.length === 0) {
    return { status: 202, response: null };
  }
  return { status: 200, response: Array.isArray(parsedBody) ? responses : responses[0] };
}

/**
 * 解析并分派一条 JSON-RPC 2.0 文本消息（供 stdio 传输直接复用，与 HTTP 共享 100% 同一工具表与安全门禁）。
 */
export function handleMcpJsonRpcText(
  ctx: McpContext,
  bodyText: string,
): { status: number; response: JsonRpcResponse | JsonRpcResponse[] | null } {
  if (typeof bodyText !== "string" || bodyText.trim() === "") {
    return { status: 400, response: rpcErr(null, RPC_ERROR.INVALID_REQUEST, "空请求体") };
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return { status: 400, response: rpcErr(null, RPC_ERROR.PARSE_ERROR, "JSON 解析失败") };
  }
  return dispatchJsonRpcPayload(ctx, parsedBody);
}

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
  const dispatched = dispatchJsonRpcPayload(ctx, parsedBody);
  if (dispatched.response === null) {
    return { status: dispatched.status, headers: baseHeaders, body: "", authenticated: true };
  }
  const headers = { ...baseHeaders };
  if (dispatched.status === 200 && req.sessionId) headers["mcp-session-id"] = String(req.sessionId);
  return { status: dispatched.status, headers, body: json(dispatched.response), authenticated: true };
}
