// dsh-graph 搜索命中「按版本/分区聚合」纯函数模块（g-367）
// g-366 交付的单列「搜索结果」聚合泳道是**跨分区扁平列表**（14 条命中混在一条泳道里），
// 本模块把命中按**看板既有分区**分段（组头 + 计数），组内仍是单列纵向。
// 供 kanban.js 调用以及 core/tests 断言同一真实实现（与 search-state.js / narrow-width.js 同模式）。
//
// 纪律（g-367 目标约束，逐条对应）：
//   1. 纯派生：不持状态、不写任何持久化键（分组态不记忆 ⇒ 组头也不可折叠）；
//   2. 组序 == 看板既有分区顺序：活跃版本（板序）→ 已发布版本（板序）→ 独立目标 → backlog；
//   3. 已隐藏版本的命中单列一组（g-233 硬口径：命中不得被视图过滤藏掉），恒置于**末尾**；
//   4. 组内保持 searchMatches 的既有相对次序 ⇒ **i/N 全局次序不变**（窄/宽档同源，`searchMatches`
//      本身一字不改）；分组只改「纵向落点」，不改跳转次序；
//   5. 泳道 key 约定（`v-<slug>` / `rellane-<slug>` / `standalone` / `backlog`）在本模块**唯一持有**，
//      搜索候选构造（g-381 起唯一实现在 search-match.js）复用 versionLaneKey ⇒ 全仓不再有第二份
//      这样的字面量。

/** 已隐藏版本的聚合组 key：不参与常规分区顺序，恒置于末尾。 */
const SEARCH_GROUP_HIDDEN = "__hidden__";

/**
 * 版本 → 看板泳道 key（g-366 起既有约定：已发布走 `rellane-` 前缀，其余走 `v-` 前缀）。
 * @param {{slug?: string, status?: string}|null} version
 * @returns {string}
 */
function versionLaneKey(version) {
  return (version?.status === "released" ? "rellane-" : "v-") + (version?.slug ?? "");
}

/**
 * 命中分组顺序（纯派生，与看板既有分区顺序一致）：
 *   活跃版本（板序）→ 已发布版本（板序）→ 独立目标 → backlog → 已隐藏版本（板序）
 *
 * hiddenSlugs 刻意取**持久隐藏底账**，不取「持久底账 − 搜索临时 unhide」的有效集合：
 * 否则 i/N 跳进隐藏版本的命中时该组会在「已隐藏版本」与常规版本位之间来回跳动
 *（搜索态下常规分区并不渲染，分组位置应当稳定）。
 *
 * @param {Array<{slug?: string, name?: string, status?: string}>} versions board payload 的 versions
 * @param {string[]} hiddenSlugs 持久隐藏版本 slug 列表
 * @returns {Array<{key: string, name: string|null, hidden: boolean}>}
 */
function searchGroupOrder(versions, hiddenSlugs) {
  const hidden = new Set(hiddenSlugs ?? []);
  const order = [];
  const pushVersion = (v) => {
    order.push({ key: versionLaneKey(v), name: v.name ?? v.slug ?? "", hidden: false });
  };
  for (const v of (versions ?? [])) {
    if (!v || v.status === "released" || hidden.has(v.slug)) continue;
    pushVersion(v);
  }
  for (const v of (versions ?? [])) {
    if (!v || v.status !== "released" || hidden.has(v.slug)) continue;
    pushVersion(v);
  }
  order.push({ key: "standalone", name: null, hidden: false });
  order.push({ key: "backlog", name: null, hidden: false });
  order.push({ key: SEARCH_GROUP_HIDDEN, name: null, hidden: true });
  return order;
}

/**
 * 把命中按分区聚合，返回**只含非空组**的有序数组（空组不渲染）。
 *
 * 归属规则：
 *   - 命中落在持久隐藏版本的 slug 上 ⇒ 归入末尾「已隐藏版本」组（g-233）；
 *   - 否则按命中自带的既有 laneKey 落组（该字段由 executeSearch 用 versionLaneKey 生成）；
 *   - laneKey 不在顺序表内（版本已从 payload 消失、lazy 分区未加载等）⇒ 归入**末尾兜底组**
 *     （组头名取该命中的 versionSlug / laneKey）——宁可多一个组头，也绝不丢一张命中（g-233）。
 *
 * @param {Array} versions board payload 的 versions
 * @param {Array<{id: string, versionSlug?: string|null, laneKey?: string|null}>} matches searchMatches
 * @param {string[]} hiddenSlugs 持久隐藏版本 slug 列表
 * @returns {Array<{key: string, name: string|null, hidden: boolean, items: any[]}>}
 */
function groupSearchMatches(versions, matches, hiddenSlugs) {
  const hidden = new Set(hiddenSlugs ?? []);
  const groups = [];
  const byKey = new Map();
  const bucket = (key, name, isHidden) => {
    let g = byKey.get(key);
    if (!g) {
      g = { key, name: name ?? null, hidden: !!isHidden, items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    return g;
  };
  for (const entry of searchGroupOrder(versions, hiddenSlugs)) bucket(entry.key, entry.name, entry.hidden);
  let fallback = null;
  for (const m of (matches ?? [])) {
    const slug = m?.versionSlug ?? null;
    if (slug && hidden.has(slug)) {
      bucket(SEARCH_GROUP_HIDDEN, null, true).items.push(m);
      continue;
    }
    const hit = m?.laneKey ? byKey.get(m.laneKey) : null;
    if (hit) {
      hit.items.push(m);
      continue;
    }
    if (!fallback) fallback = bucket("__other__", slug || m?.laneKey || "", false);
    fallback.items.push(m);
  }
  return groups.filter((g) => g.items.length > 0);
}

// >>>ESM-EXPORTS-START>>> (build script strips this block for browser bundle)
export { SEARCH_GROUP_HIDDEN, versionLaneKey, searchGroupOrder, groupSearchMatches };
// <<<ESM-EXPORTS-END<<<
