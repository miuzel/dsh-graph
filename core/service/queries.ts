/**
 * g-623：本地服务的**只读查询层**（MVP 白名单的唯一实现）。
 *
 * 判据 6 / 7 / 8 的落地：
 * - **只调用 core 既有读函数**（`ops.ts` / `events.ts` / `model.ts` / `root.ts`）：
 *   不拼 frontmatter、不解析事件、不绕过状态机/CAS/锁/恢复，**不另造第二真源**。
 * - 白名单**只有**查询：列目标/版本、读目标描述/判据/状态、卡片、结果摘要、看板投影、
 *   脱敏设置、安全附件引用。写/执行/Human Gate 命令在这里**根本没有实现**（不可注册）。
 * - 一切 store 访问前先过 `assertInitialized()`：未初始化看板只报错，**绝不** `init()` / `claim()`。
 * - 返回给客户端的投影**脱敏**：剥掉绝对路径（graphRoot/executionWorkspace/附件绝对目录/
 *   goalFile）、绑定 token、会话 id 等运行内部信息；浏览器不直接读磁盘。
 * - 附件读取只经 core 的 `sanitizeAttachmentPath` + `readAttachment`（含 realpath/lstat/父目录
 *   重验），因此 `../`、绝对路径、根外 symlink 在 core 层被拒；本层**不**自己拼路径。
 */
import { readProjectConfig, goalCards, goalDetail, listAttachments, readAttachment, boardPayload } from "../ops.ts";
import { readEvents } from "../events.ts";
import { criteriaItems, countCriteria, isCriterionVerified } from "../model.ts";
import { isGraphInitialized } from "./config.ts";

/**
 * 稳定错误码（与设计 §7 的 Result 语义对齐）。
 * 全部为「可预期拒绝」，不包含任何 secret；响应体只带 code + message。
 */
export type ServiceErrorCode =
  | "E_NOT_INITIALIZED"
  | "E_NOT_FOUND"
  | "E_INPUT"
  | "E_FORBIDDEN"
  | "E_UNKNOWN_COMMAND"
  | "E_NOT_READ_ONLY"
  | "E_STORAGE";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  /** HTTP 状态码映射（MCP 层不用，但统一在这里给出以免两处漂移）。 */
  readonly status: number;
  constructor(code: ServiceErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code];
  }
}

const STATUS_BY_CODE: Record<ServiceErrorCode, number> = {
  E_NOT_INITIALIZED: 409,
  E_NOT_FOUND: 404,
  E_INPUT: 400,
  E_FORBIDDEN: 403,
  E_UNKNOWN_COMMAND: 404,
  E_NOT_READ_ONLY: 403,
  E_STORAGE: 500,
};

/** 服务上下文：**显式**的 graphRoot（只读）+ executionWorkspace（执行目录，本层不使用）。 */
export interface ServiceContext {
  graphRoot: string;
  executionWorkspace: string;
}

/** 未初始化看板 ⇒ 明确报错（**不是**空成功，也**不会**自动建目录/记事件/claim）。 */
export function assertInitialized(ctx: ServiceContext): void {
  if (!isGraphInitialized(ctx.graphRoot)) {
    throw new ServiceError(
      "E_NOT_INITIALIZED",
      `看板未初始化：${ctx.graphRoot} 缺少 events.jsonl（本服务不会自动 init 或 claim）`,
    );
  }
}

/** 校验目标 id 形态（core 的目录约定 `g-<token>`）；不合法直接 E_INPUT，不触碰磁盘。 */
export function assertGoalId(id: unknown): string {
  const s = String(id ?? "").trim();
  if (!/^g-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) {
    throw new ServiceError("E_INPUT", `非法目标 id：${String(id)}`);
  }
  return s;
}

/** 脱敏：把一切绝对路径替换成稳定的占位符（响应中不得出现宿主绝对路径）。 */
export function redactPaths<T>(value: T, ctx: ServiceContext): T {
  const replacements: Array<[string, string]> = [
    [ctx.graphRoot, "<graphRoot>"],
    [ctx.executionWorkspace, "<executionWorkspace>"],
  ];
  const walk = (v: any): any => {
    if (typeof v === "string") {
      let out = v;
      for (const [from, to] of replacements) {
        if (from && out.includes(from)) out = out.split(from).join(to);
      }
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}

/** 客户端投影时**必须**剥掉的字段（运行内部 / 绑定能力 / 绝对路径）。 */
const STRIPPED_KEYS = new Set([
  "goalFile",
  "root",
  "attachmentsDir",
  "binding_token",
  "child_id",
  "parent_session_id",
]);

/**
 * 剥掉运行内部字段（递归）。被剥掉的键一律**删除**而非置 null：避免客户端把占位值当真值。
 * `content_ref` 等正常业务字段不受影响。
 */
export function stripInternal<T>(value: T): T {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v)) {
        if (STRIPPED_KEYS.has(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/** 对外投影：先剥内部字段、再脱敏绝对路径。两者的顺序不可交换（先脱敏会把路径变成占位串但仍留下键）。 */
export function toClientView<T>(value: T, ctx: ServiceContext): T {
  return redactPaths(stripInternal(value), ctx);
}

// ── 白名单查询（每个函数都是纯读；全部先过 assertInitialized）────────────────────────────

/** 看板投影（目标/版本/backlog + supervisor 状态 + 共享卡摘要 + 模块开关）。 */
export function queryBoard(ctx: ServiceContext, opts: { includeArchived?: boolean; lazy?: boolean } = {}): any {
  assertInitialized(ctx);
  const payload = boardPayload(ctx.graphRoot, { includeArchived: opts.includeArchived === true, lazy: opts.lazy === true });
  return toClientView(payload, ctx);
}

/** 目标列表（看板投影的扁平化视图 + 位置信息）。 */
export function listGoals(ctx: ServiceContext, opts: { includeArchived?: boolean } = {}): any[] {
  const board: any = queryBoard(ctx, { includeArchived: opts.includeArchived === true });
  const out: any[] = [];
  for (const v of board.versions ?? []) {
    for (const g of v.goals ?? []) out.push({ ...g, placement: "version", version: v.slug });
  }
  for (const g of board.standalone ?? []) out.push({ ...g, placement: "standalone", version: null });
  for (const g of board.backlog ?? []) out.push({ ...g, placement: "backlog", version: null });
  return out;
}

/** 版本列表（slug/名称/状态/目标数；byGroup 形态的 goals 只给计数，避免复制目标）。 */
export function listVersions(ctx: ServiceContext): any[] {
  const board: any = queryBoard(ctx, {});
  return (board.versions ?? []).map((v: any) => ({
    slug: v.slug,
    id: v.id ?? null,
    name: v.name,
    status: v.status,
    goals_count: typeof v.goals_count === "number" ? v.goals_count : (v.goals ?? []).length,
  }));
}

/** 单个目标详情（描述/判据/状态/卡片/attempt 摘要/事件摘要/结果摘要/评审状态）。 */
export function queryGoal(ctx: ServiceContext, id: unknown): any {
  assertInitialized(ctx);
  const goalId = assertGoalId(id);
  return toClientView(readGoalGuarded(ctx, goalId), ctx);
}

/** 目标描述 + 判据（最小只读切片；供 MCP 细粒度工具使用）。 */
export function queryGoalCriteria(ctx: ServiceContext, id: unknown): any {
  assertInitialized(ctx);
  const goalId = assertGoalId(id);
  const detail = readGoalGuarded(ctx, goalId);
  const items: string[] = criteriaItems(detail.body ?? "");
  return {
    id: goalId,
    status: detail.meta?.status ?? null,
    criteria_confirmed: detail.meta?.criteria_confirmed === true,
    items: items.map((text, index) => ({ index: index + 1, text, verified: isCriterionVerified(text) })),
    count: countCriteria(detail.body ?? ""),
  };
}

/** 卡片列表（自有卡 + 该目标引用的共享卡）。 */
export function queryGoalCards(ctx: ServiceContext, id: unknown): any[] {
  assertInitialized(ctx);
  const goalId = assertGoalId(id);
  guardNotFound(() => goalCards(ctx.graphRoot, goalId), goalId);
  return toClientView(goalCards(ctx.graphRoot, goalId), ctx);
}

/** 结果摘要（results.md + results-att-*.md 只读投影）。 */
export function queryGoalResults(ctx: ServiceContext, id: unknown): any {
  assertInitialized(ctx);
  const goalId = assertGoalId(id);
  const detail = readGoalGuarded(ctx, goalId);
  return toClientView({ id: goalId, results: detail.results ?? null }, ctx);
}

/** 脱敏项目设置：**只读**投影核心既有 `readProjectConfig`（不复制默认/迁移逻辑，不回写）。 */
export function querySettings(ctx: ServiceContext): any {
  assertInitialized(ctx);
  const cfg: any = readProjectConfig(ctx.graphRoot);
  // 只读且脱敏：prompt 覆盖文本可能含宿主路径 ⇒ 统一过 redactPaths。
  return {
    ...toClientView(cfg, ctx),
    readOnly: true,
    writeDisabledReason: "MVP 白名单仅只读：设置写控件禁用（写路径需独立 Web UI 的可信本地人工确认，本批未开放）",
  };
}

/** 附件相对路径清单（安全引用名，不含绝对路径）。 */
export function listSafeAttachments(ctx: ServiceContext): string[] {
  assertInitialized(ctx);
  return listAttachments(ctx.graphRoot);
}

/**
 * 读取一个附件（安全引用）。所有路径校验都在 core：
 * `sanitizeAttachmentPath`（拒绝对路径/`..`/反斜杠/冒号/NUL）+ realpath 包含 + lstat 非 symlink
 * + 父目录 symlink 重验。失败一律映射成 E_NOT_FOUND（不区分「越界」与「不存在」，不泄露根外存在性）。
 */
export function readSafeAttachment(ctx: ServiceContext, name: unknown): {
  name: string;
  size: number;
  digest: string;
  contentType: string;
  inline: boolean;
  base64: string;
} {
  assertInitialized(ctx);
  const raw = String(name ?? "");
  try {
    const r = readAttachment(ctx.graphRoot, raw);
    return {
      name: raw,
      size: r.size,
      digest: r.digest,
      contentType: r.contentType,
      inline: r.inline,
      base64: r.buffer.toString("base64"),
    };
  } catch {
    throw new ServiceError("E_NOT_FOUND", `附件不可读或不存在：${raw}`);
  }
}

/** 事件游标列表（只读事件信封；不暴露磁盘细节）。 */
export function queryEvents(ctx: ServiceContext, opts: { goal?: string; limit?: number } = {}): any[] {
  assertInitialized(ctx);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 100, 1000));
  const goal = opts.goal === undefined ? null : assertGoalId(opts.goal);
  const events = readEvents(ctx.graphRoot)
    .filter((e) => (goal ? e.goal === goal : true))
    .slice(-limit)
    .map((e) => ({ ts: e.ts, actor: e.actor, event: e.event, goal: e.goal ?? null, details: e.details ?? {} }));
  return toClientView(events, ctx);
}

// ── 内部：把 core 的抛错映射为稳定服务错误码 ─────────────────────────────────────────

function guardNotFound<T>(fn: () => T, goalId: string): T {
  try {
    return fn();
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    if (msg.includes("目标不存在")) throw new ServiceError("E_NOT_FOUND", `目标不存在：${goalId}`);
    throw new ServiceError("E_STORAGE", `读取失败：${msg || "未知错误"}`);
  }
}

function readGoalGuarded(ctx: ServiceContext, goalId: string): any {
  return guardNotFound(() => goalDetail(ctx.graphRoot, goalId), goalId);
}

/**
 * 白名单命令目录（**单一真源**）：MCP 工具与 Web API 都从这里派生，
 * 因此「未注册的写命令」在这两个入口都**不存在**（不是运行时开关，而是根本没有实现）。
 */
export interface ReadOnlyCommand {
  name: string;
  description: string;
  input: Record<string, "string" | "number" | "boolean">;
  run: (ctx: ServiceContext, args: Record<string, any>) => unknown;
}

export const READ_ONLY_COMMANDS: readonly ReadOnlyCommand[] = Object.freeze([
  {
    name: "graph_list_goals",
    description: "列出看板目标（只读投影；含 versions/standalone/backlog 位置）",
    input: { includeArchived: "boolean" },
    run: (ctx: ServiceContext, args: Record<string, any>) => listGoals(ctx, { includeArchived: args.includeArchived === true }),
  },
  {
    name: "graph_list_versions",
    description: "列出看板版本（slug/名称/状态/目标计数）",
    input: {},
    run: (ctx: ServiceContext) => listVersions(ctx),
  },
  {
    name: "graph_query_goal",
    description: "读取单个目标的描述/判据/状态/卡片/结果摘要（只读）",
    input: { goal: "string" },
    run: (ctx: ServiceContext, args: Record<string, any>) => queryGoal(ctx, args.goal),
  },
  {
    name: "graph_query_criteria",
    description: "读取单个目标的质量判据（条目 + 是否已验）",
    input: { goal: "string" },
    run: (ctx: ServiceContext, args: Record<string, any>) => queryGoalCriteria(ctx, args.goal),
  },
  {
    name: "graph_list_cards",
    description: "列出某个目标的上下文卡片（自有卡 + 引用的共享卡）",
    input: { goal: "string" },
    run: (ctx: ServiceContext, args: Record<string, any>) => queryGoalCards(ctx, args.goal),
  },
  {
    name: "graph_query_results",
    description: "读取某个目标的完成摘要投影（results.md / results-att-*.md）",
    input: { goal: "string" },
    run: (ctx: ServiceContext, args: Record<string, any>) => queryGoalResults(ctx, args.goal),
  },
  {
    name: "graph_board",
    description: "看板派生投影（版本/独立/backlog + supervisor 状态 + 共享卡摘要）",
    input: { includeArchived: "boolean", lazy: "boolean" },
    run: (ctx: ServiceContext, args: Record<string, any>) => queryBoard(ctx, { includeArchived: args.includeArchived === true, lazy: args.lazy === true }),
  },
  {
    name: "graph_settings",
    description: "读取脱敏项目设置（只读展示；写控件禁用）",
    input: {},
    run: (ctx: ServiceContext) => querySettings(ctx),
  },
  {
    name: "graph_list_attachments",
    description: "列出项目附件的安全引用名（不含绝对路径）",
    input: {},
    run: (ctx: ServiceContext) => listSafeAttachments(ctx),
  },
  {
    name: "graph_read_attachment",
    description: "按安全引用名读取一个附件（base64；越界/绝对路径/symlink 一律 E_NOT_FOUND）",
    input: { name: "string" },
    run: (ctx: ServiceContext, args: Record<string, any>) => readSafeAttachment(ctx, args.name),
  },
  {
    name: "graph_events",
    description: "只读事件信封（可按目标过滤、按 limit 截取尾部）",
    input: { goal: "string", limit: "number" },
    run: (ctx: ServiceContext, args: Record<string, any>) => queryEvents(ctx, { goal: args.goal, limit: args.limit }),
  },
] as unknown as ReadOnlyCommand[]);

export const READ_ONLY_COMMAND_NAMES: readonly string[] = READ_ONLY_COMMANDS.map((c) => c.name);

/**
 * 统一命令分派（MCP 与 Web API 共用）。**未注册的名字一律 E_UNKNOWN_COMMAND**，
 * 且在分派前**不**触碰 store（判据 6：直接构造写命令请求必须零副作用）。
 */
export function executeReadOnlyCommand(
  ctx: ServiceContext,
  name: unknown,
  args: Record<string, any> = {},
): unknown {
  const cmd = READ_ONLY_COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    throw new ServiceError("E_UNKNOWN_COMMAND", `未注册的命令（MVP 仅只读白名单）：${String(name)}`);
  }
  const safeArgs: Record<string, any> = {};
  for (const [key, type] of Object.entries(cmd.input)) {
    const value = (args ?? {})[key];
    if (value === undefined) continue;
    if (type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new ServiceError("E_INPUT", `参数 ${key} 必须是数字`);
      safeArgs[key] = n;
      continue;
    }
    // 运行内部 / 可信上下文类参数一律拒绝（伪 actor / 伪 approval / 伪 root 不得成为上下文）。
    if (RESERVED_ARG_KEYS.has(key)) throw new ServiceError("E_FORBIDDEN", `参数 ${key} 不可由客户端提供`);
    if (type === "boolean") {
      safeArgs[key] = value === true || value === "true";
      continue;
    }
    safeArgs[key] = String(value);
  }
  for (const key of Object.keys(args ?? {})) {
    if (!(key in cmd.input) && RESERVED_ARG_KEYS.has(key)) {
      throw new ServiceError("E_FORBIDDEN", `参数 ${key} 不可由客户端提供`);
    }
  }
  return cmd.run(ctx, safeArgs);
}

/**
 * 保留参数：这些名字代表**可信上下文**（actor/审批/root/凭据），客户端永远不能填。
 * 出现在工具 schema 中会被逐个拒绝 ⇒「伪 actor」「human=true」「approval」不可能生效。
 */
export const RESERVED_ARG_KEYS: ReadonlySet<string> = new Set([
  "actor",
  "owner",
  "human",
  "approval",
  "approved",
  "confirmed",
  "token",
  "auth",
  "authorization",
  "root",
  "graphRoot",
  "executionWorkspace",
  "session",
  "sessionId",
  "capability",
  "role",
]);
