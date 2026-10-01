// dsh-graph 搜索「候选收集 + 匹配」纯函数模块（g-381）
// ------------------------------------------------------------------
// 本模块是**全仓唯一的搜索匹配实现**：g-381 把原先内联在 kanban.js `executeSearch` 里的
// 候选收集与匹配判定（编号 / 标题 / 描述子串，大小写不敏感）抽取到这里，供两个调用点共用：
//   1. 看板搜索泳道：`kanban.js` 的 `executeSearch`（匹配语义、次序一字不变，snippet 仍由
//      helpers.js 的既有 `extractMatchSnippet` 提供，本模块不复制片段实现）；
//   2. 目标详情「🔗 标记关系」面板的对端搜索框：`goal-modal.js` 的 `RelationMarker`。
// 纪律（g-381 目标约束，逐条对应）：
//   1. 纯派生：不持状态、不写任何持久化键、不引入轮询/watcher/定时器；
//   2. 候选顺序 == 看板既有分区顺序（活跃版本板序 → 已发布版本板序 → 独立目标 → backlog，
//      与 search-groups.js 的组序枚举同源）⇒ 搜索命中相对次序（i/N）不变；
//   3. 泳道 key 复用 search-groups.js 的 `versionLaneKey`（唯一真源），不新造第二份字面量；
//   4. `filterCandidateMatches` 的候选上限只为**渲染规模**服务：匹配集合（含总数）仍完整，
//      只是截断呈现 ⇒ 逐键输入不重排、不挂载全量节点。

/** 「关系标记」对端搜索框单次渲染的候选上限（g-381 判据 3：避免一次挂载 ~400 个节点）。 */
const RELATION_PEER_LIMIT = 50;

/**
 * 查询串归一（与既有搜索一致：仅去首尾空白；空串表示「未输入关键字」）。
 * @param {unknown} text
 * @returns {string}
 */
function normalizeSearchQuery(text) {
  return String(text ?? "").trim();
}

/**
 * 从看板 payload 收集全部目标候选（含隐藏版本内的目标——搜索是跨视图的既有口径）。
 * 候选顺序即看板既有分区顺序，字段形态与 g-381 抽取前的 `executeSearch` 完全一致。
 * @param {{versions?: Array, standalone?: Array, backlog?: Array}|null} board
 * @returns {Array<object>}
 */
function collectBoardCandidates(board) {
  const candidates = [];
  for (const v of (board?.versions ?? [])) {
    const isRel = v.status === "released";
    for (const g of (v.goals ?? [])) {
      candidates.push({
        ...g,
        versionSlug: v.slug,
        versionName: v.name,
        isReleased: isRel,
        // g-367：泳道 key 约定收敛到 search-groups.js 的 versionLaneKey()（唯一真源）
        laneKey: versionLaneKey(v),
      });
    }
  }
  for (const g of (board?.standalone ?? [])) {
    candidates.push({ ...g, versionSlug: null, isReleased: false, laneKey: "standalone" });
  }
  for (const g of (board?.backlog ?? [])) {
    candidates.push({ ...g, versionSlug: null, isReleased: false, laneKey: "backlog" });
  }
  return candidates;
}

/**
 * 单个候选的匹配判定（**唯一匹配语义**）：编号 / 标题子串命中；`fullText` 时追加描述子串。
 * 大小写不敏感；空查询**不匹配任何项**（空串不是关键字）。
 * @param {{id?: unknown, title?: unknown, description?: unknown}|null} candidate
 * @param {unknown} query
 * @param {{fullText?: boolean}} [opts]
 * @returns {{titleHit: boolean, idHit: boolean, descHit: boolean, matched: boolean}}
 */
function matchGoalCandidate(candidate, query, opts) {
  const q = normalizeSearchQuery(query).toLowerCase();
  if (!q) return { titleHit: false, idHit: false, descHit: false, matched: false };
  const titleHit = String(candidate?.title ?? "").toLowerCase().includes(q);
  const idHit = String(candidate?.id ?? "").toLowerCase().includes(q);
  let descHit = false;
  const fullText = !!(opts && opts.fullText);
  if (fullText && candidate?.description) {
    descHit = String(candidate.description).toLowerCase().includes(q);
  }
  return { titleHit, idHit, descHit, matched: titleHit || idHit || descHit };
}

/**
 * 看板级搜索命中集合（`executeSearch` 的既有实现，逐字迁移到本模块）。
 * 命中记录字段与次序完全沿用既有实现（`snippet` 由调用方注入的 `snippetOf` 产生，
 * 即 helpers.js 的既有 `extractMatchSnippet`）。
 * @param {object|null} board
 * @param {unknown} queryText
 * @param {{fullText?: boolean, snippetOf?: ((text: unknown, query: string) => string)|null}} [opts]
 * @returns {Array<{id: unknown, title: unknown, status: unknown, versionSlug: unknown, isReleased: unknown, laneKey: unknown, snippet: string}>}
 */
function collectSearchMatches(board, queryText, opts) {
  const q = normalizeSearchQuery(queryText);
  if (!q) return [];
  const fullText = !!(opts && opts.fullText);
  const snippetOf = typeof opts?.snippetOf === "function" ? opts.snippetOf : null;
  const matches = [];
  for (const c of collectBoardCandidates(board)) {
    const m = matchGoalCandidate(c, q, { fullText });
    if (!m.matched) continue;
    matches.push({
      id: c.id,
      title: c.title,
      status: c.status,
      versionSlug: c.versionSlug,
      isReleased: c.isReleased,
      laneKey: c.laneKey,
      snippet: (m.descHit && snippetOf) ? snippetOf(c.description, q) : "",
    });
  }
  return matches;
}

/**
 * 扁列表候选过滤（「关系标记」对端搜索框用）：调用 `matchGoalCandidate` 同一匹配语义，
 * 保序（板序），并按 `limit` 截断**渲染**集合。
 *   空查询 ⇒ 给出有上限的首屏候选（板序前 N 项；空串不做关键字匹配）；
 *   有查询 ⇒ 完整匹配后取前 N 项（`total` 为真实命中数）。
 * @param {Array<object>} candidates
 * @param {unknown} query
 * @param {{fullText?: boolean, limit?: number}} [opts]
 * @returns {{items: Array<object>, total: number, limited: boolean, limit: number}}
 */
function filterCandidateMatches(candidates, query, opts) {
  const list = Array.isArray(candidates) ? candidates : [];
  const rawLimit = opts && opts.limit != null ? Number(opts.limit) : RELATION_PEER_LIMIT;
  const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.floor(rawLimit) : RELATION_PEER_LIMIT;
  const q = normalizeSearchQuery(query);
  if (!q) {
    const items = limit > 0 ? list.slice(0, limit) : list.slice();
    return { items, total: list.length, limited: list.length > items.length, limit };
  }
  const fullText = !!(opts && opts.fullText);
  const all = [];
  for (const c of list) {
    if (matchGoalCandidate(c, q, { fullText }).matched) all.push(c);
  }
  const items = limit > 0 ? all.slice(0, limit) : all;
  return { items, total: all.length, limited: all.length > items.length, limit };
}

/**
 * 候选的显示文案（编号 + 标题；标题与编号相同则不重复）——对端搜索框与下拉/列表项共用一处。
 * @param {{id?: unknown, title?: unknown}|null} candidate
 * @returns {string}
 */
function goalCandidateLabel(candidate) {
  const id = String(candidate?.id ?? "");
  const title = candidate?.title == null ? "" : String(candidate.title);
  return title && title !== id ? `${id} ${title}` : id;
}

// >>>ESM-EXPORTS-START>>> (build script strips this block for browser bundle)
import { versionLaneKey } from "./search-groups.js";
export {
  RELATION_PEER_LIMIT,
  normalizeSearchQuery,
  collectBoardCandidates,
  matchGoalCandidate,
  collectSearchMatches,
  filterCandidateMatches,
  goalCandidateLabel,
};
// <<<ESM-EXPORTS-END<<<
