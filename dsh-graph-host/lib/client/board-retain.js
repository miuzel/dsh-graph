// dsh-graph 看板 retained 明细对账纯函数模块（g-290）
// 从 kanban.js load() 中抽取的 g-258「刷新后状态保持」合并逻辑，
// 供 kanban.js 调用以及 core/tests 断言同一真实实现（与 search-state.js 同模式）。
//
// 缺陷背景（g-290）：g-258 的逻辑在 lazy 载荷下**无条件**用上一份 retained 明细
// 覆盖服务端返回，并且把服务端计数也覆盖成 retained 明细长度、把 backlog_loaded 置真。
// 后果：backlog（以及 released 版本）内的任何成员变化——移出到版本/独立目标、归档、
// 删除——都被旧明细掩盖，应用内自动刷新（load()）看不见，只有整页刷新才消失（幽灵卡片）。
//
// 对账铁律：
//   1. 计数以服务端为准：data.backlog_count / ver.goals_count 在任何情况下都不得被
//      retained 明细长度覆盖；
//   2. 仅当「本次载荷确为 lazy（服务端省略了明细）且服务端计数与 retained 明细长度一致」
//      时才允许恢复 retained 明细 → 保住 g-258 的「展开态刷新不闪空」体验；
//   3. 计数不一致（或不可比）时：丢弃 retained 明细、复位已加载标记，由既有懒加载路径
//      （loadBacklogGoals / loadVersionGoals）补拉正确明细；允许一次短暂 loading，
//      绝不残留幽灵卡片。

/* exported reconcileRetainedBoardState */

/**
 * 把上一份 retained 看板载荷与本次服务端载荷对账，决定哪些明细可以安全沿用。
 *
 * `data` 会被原地修改（backlog 明细与 released 版本明细可能被沿用或被清空），
 * 返回对账结论供调用方决定是否立即触发懒加载补拉。
 *
 * @param {object} data - 本次服务端返回的看板载荷（boardPayload，可能为 lazy）
 * @param {object|null|undefined} retained - boardDataRef 中同维度的上一份载荷
 * @param {{ collapsedLanes?: Record<string, boolean>, openReleased?: Record<string, boolean> }} [opts]
 *        当前视图状态：collapsedLanes[key] === false 表示该泳道展开；openReleased[slug] 为真表示该已发布版本展开
 * @returns {{ data: object, refetchBacklog: boolean, refetchVersions: string[] }}
 */
function reconcileRetainedBoardState(data, retained, opts) {
  const result = { data, refetchBacklog: false, refetchVersions: [] };
  if (!data || typeof data !== "object") return result;
  if (!retained || typeof retained !== "object") return result;
  const collapsedLanes = (opts && opts.collapsedLanes) || {};
  const openReleased = (opts && opts.openReleased) || {};

  // ===== backlog：lazy 载荷只回 backlog_count，明细留空数组 =====
  // 注意 data.lazy 是「服务端确实省略了明细」的唯一可信信号：非 lazy 载荷里
  // data.backlog 已是权威全量明细，不存在被旧值掩盖的问题，也不需要沿用。
  if (data.lazy === true) {
    const retainedBacklog = Array.isArray(retained.backlog) ? retained.backlog : null;
    const serverCount = typeof data.backlog_count === "number" ? data.backlog_count : null;
    const laneExpanded = !collapsedLanes["backlog"];
    const canRetain =
      laneExpanded &&
      retainedBacklog !== null &&
      retainedBacklog.length > 0 &&
      serverCount !== null &&
      serverCount === retainedBacklog.length;
    if (canRetain) {
      // g-258 本意：计数未变 → 沿用明细，展开态刷新不闪空
      data.backlog = retainedBacklog;
      data.backlog_loaded = true;
    } else {
      // 计数变化/不可比 → 丢弃旧明细、复位已加载标记；绝不写 data.backlog_count
      data.backlog = [];
      data.backlog_loaded = false;
      if (laneExpanded && serverCount !== null && serverCount > 0) {
        result.refetchBacklog = true;
      }
    }
  }

  // ===== released 版本：lazy 载荷只回 goals_count，明细留空数组 =====
  if (Array.isArray(data.versions) && Array.isArray(retained.versions)) {
    const retainedVersionMap = new Map(retained.versions.map((v) => [v && v.slug, v]));
    for (const ver of data.versions) {
      if (!ver || ver.status !== "released") continue;
      if (!openReleased[ver.slug]) continue;
      // 非 lazy：服务端已回全量明细，无需沿用（也绝不覆盖）
      if (ver.lazy !== true) continue;
      const prevVer = retainedVersionMap.get(ver.slug);
      const prevGoals = prevVer && Array.isArray(prevVer.goals) ? prevVer.goals : null;
      const serverCount = typeof ver.goals_count === "number" ? ver.goals_count : null;
      const canRetain =
        prevGoals !== null &&
        prevGoals.length > 0 &&
        serverCount !== null &&
        serverCount === prevGoals.length;
      if (canRetain) {
        ver.goals = prevGoals;
        ver.loaded = true;
        ver.lazy = false;
      } else {
        // 成员变化/不可比 → 丢弃旧明细、复位已加载标记；保留服务端 lazy/goals_count
        // （复位 lazy=false 会让懒加载路径不再补拉，故此处必须保留服务端原值）
        ver.goals = [];
        ver.loaded = false;
        if (serverCount !== null && serverCount > 0) {
          result.refetchVersions.push(ver.slug);
        }
      }
      // ver.goals_count 始终以服务端为准，不覆盖
    }
  }

  return result;
}

// >>>ESM-EXPORTS-START>>> (build script strips this block for browser bundle)
export { reconcileRetainedBoardState };
// <<<ESM-EXPORTS-END<<<
