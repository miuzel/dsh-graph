/** 目标状态机与迁移不变式（schema/SCHEMA.md §7）。 */

import { criteriaPresent } from "./model.ts";

export class GraphError extends Error {}

/** g-170：并发冲突（乐观 base_items 不一致）专用错误——REST 层映射为 409。 */
export class GraphConflictError extends GraphError {}

/** g-610：同一 workspace+goal 已存在活动/启动中/状态未知的执行 attempt 时的**稳定拒绝错误**。
 *
 *  与 GraphConflictError 一样由 REST 层映射为 409（工具入口在 message 前缀写 `[code]`，保证
 *  harness 只显示文本时也可机读）。`activity` 只含 attempt/child/dispatch 的可公开身份，
 *  **绝不**包含 binding token；`recovery` 是给有权限的人类/主管的可执行恢复指引（不含凭据）。 */
export class GraphExecutionBusyError extends GraphConflictError {
  code: string;
  activity: Array<Record<string, unknown>>;
  recovery: string;
  constructor(
    code: string,
    message: string,
    activity: Array<Record<string, unknown>> = [],
    recovery = "",
  ) {
    super(`[${code}] ${message}`);
    this.name = "GraphExecutionBusyError";
    this.code = code;
    this.activity = activity;
    this.recovery = recovery;
  }
}

/**
 * g-329/g-610：attempt.md `result` 的**已知终态取值**（唯一共享清单）。
 *
 * 来源与写入点（逐一核对 `core/ops.ts`）：
 *  - `cancelled`：`abandonAttempt`（`attempt.abandoned`）——引擎在公开证据/无 child 后写入；
 *  - `detached`：`unbindGoalChild` 正常解绑（`attempt.unbound`）；
 *  - `superseded`：解绑时被取代的旧 attempt（`attempt.superseded`）；
 *  - `completed` / `failed` / `selected` / `merged` / `rejected`：评审/交付路径的**声明式**
 *    终态（历史/外部写入；当前 core 没有直接写 attempt.md 的生产写入点）。
 *
 * 重要区分（g-610）：本表只回答「这个字符串是已知终态词吗」，**不等于**「已有可信证据
 * 证明 child 已停」。派发门禁必须再把「声明式终态」与「引擎可证终态」分开：前者仅在
 * `detached===true` 或存在可信结束事件（`subagent/end` 的 results_written 等）时才放行，
 * 否则按状态未知 fail-closed。worktree 清理侧的 `isActive` 继续使用本表（行为不变）。
 */
export const ATTEMPT_TERMINAL_RESULTS = [
  "completed", "failed", "selected", "merged", "rejected", "superseded",
  "cancelled", "detached",
] as const;

export const STATUSES = [
  "draft",
  "planning",
  "collecting",
  "ready",
  "in_progress",
  "review",
  "delivered",
  "blocked",
] as const;

export type Status = (typeof STATUSES)[number];

/** 有向边；blocked 的解除目标由 meta.blocked_from 决定（见 ops.transition）。 */
const EDGES: Record<Status, ReadonlySet<Status>> = {
  draft: new Set(["planning", "blocked"]),
  planning: new Set(["collecting", "ready", "blocked", "in_progress"]), // planning→ready：无收集需求时直达；planning→in_progress：派发开发直接进执行（负责人 2026-08 指示）
  collecting: new Set(["ready", "planning", "blocked", "in_progress"]), // collecting→in_progress：跳过 ready 直接执行（人工拖动视为授权）
  ready: new Set(["in_progress", "collecting", "blocked"]),
  in_progress: new Set(["review", "blocked", "collecting"]), // in_progress→collecting = 中断回退重新收集（负责人 2026-08-22）
  review: new Set(["delivered", "in_progress", "blocked"]), // review→in_progress = 打回
  delivered: new Set(["review"]), // delivered→review：负责人备注后回 review 补充/修 bug（负责人 2026-08-22）
  blocked: new Set(), // 特殊处理：只能回 blocked_from
};

export interface TransitionContext {
  /** 目标正文（用于判据非空检查）。 */
  body: string;
  /** 该目标是否已有 criteria.confirmed 事件。 */
  criteriaConfirmed: boolean;
  /** 进入 blocked 时的原因（无则视为未提供）。 */
  reason?: string;
  /** 强制迁移：跳过 in_progress 门槛（GUI 拖放视为人工授权）。 */
  force?: boolean;
}

/**
 * 校验一次迁移；合法则沉默，非法则抛 GraphError。
 * meta 为当前 frontmatter。
 */
export function assertTransition(
  meta: Record<string, any>,
  to: string,
  ctx: TransitionContext,
): void {
  const from = meta.status as string;
  if (!STATUSES.includes(from as Status)) {
    throw new GraphError(`当前状态非法：${from}`);
  }
  if (!STATUSES.includes(to as Status)) {
    throw new GraphError(`目标状态非法：${to}`);
  }
  if (from === to) throw new GraphError(`状态未变化：${from}`);

  if (from === "blocked") {
    const back = meta.blocked_from as string | undefined;
    if (!back) throw new GraphError("blocked 状态缺少 blocked_from，无法解除");
    if (to !== back) {
      throw new GraphError(`blocked 只能解除回原状态 ${back}，不允许到 ${to}`);
    }
  } else if (!EDGES[from as Status].has(to as Status)) {
    throw new GraphError(`非法迁移：${from} → ${to}`);
  }

  if (to === "blocked") {
    if (!ctx.reason || ctx.reason.trim() === "") {
      throw new GraphError("进入 blocked 必须提供 reason");
    }
  }

  if (to === "in_progress" && !ctx.force) {
    if (!meta.rules_snapshot) {
      throw new GraphError("进入 in_progress 前必须记录 rules_snapshot");
    }
    if (!criteriaPresent(ctx.body)) {
      throw new GraphError("进入 in_progress 前质量判据小节必须非空");
    }
    if (!ctx.criteriaConfirmed) {
      throw new GraphError("进入 in_progress 前必须存在 criteria.confirmed 事件");
    }
  }
}
