/** 目标状态机与迁移不变式（schema/SCHEMA.md §7）。 */

import { criteriaPresent } from "./model.ts";

export class GraphError extends Error {}

/** g-170：并发冲突（乐观 base_items 不一致）专用错误——REST 层映射为 409。 */
export class GraphConflictError extends GraphError {}

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
