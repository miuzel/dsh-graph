// dsh-graph 搜索临时可见性状态机纯函数模块（g-255）
// 从 kanban.js 抽取的搜索覆盖层、恢复栈、用户意图优先逻辑
// 供 kanban.js import 以及 core/tests 断言同一真实实现

/* exported SearchTempState, createSearchTempState, toggleLaneCollapseInState,
   toggleReleasedOpenInState, exitSearchRestore, navigateToMatchTrack,
   computeEffectiveHiddenVersionSlugs, resetSearchState */

/**
 * 创建空白临时搜索状态对象（g-233 P2/P4 恢复栈）
 * @param {string} ws - 当前工作区路径
 * @returns {{ ws: string, expandedLanes: Set<string>, openReleasedSlugs: Set<string>, deliverExpanded: boolean, blockedExpanded: boolean }}
 */
function createSearchTempState(ws) {
  return {
    ws: ws || "",
    expandedLanes: new Set(),
    openReleasedSlugs: new Set(),
    deliverExpanded: false,
    blockedExpanded: false,
  };
}

/**
 * 用户显式操作泳道折叠时，将该泳道从临时恢复集合中移除（g-233 P4 用户意图优先）。
 * 返回移除后的 expandedLanes 集合副本。
 * @param {Set<string>} expandedLanes - 当前临时展开的泳道集合
 * @param {string} key - 被操作的泳道 key
 * @returns {Set<string>} 新的 expandedLanes（不修改原集合）
 */
function toggleLaneCollapseInState(expandedLanes, key) {
  const next = new Set(expandedLanes);
  next.delete(key);
  return next;
}

/**
 * 用户显式操作已发布版本展开/折叠时，从临时恢复集合中移除（g-233 P4 用户意图优先）。
 * 返回移除后的 openReleasedSlugs 集合副本。
 * @param {Set<string>} openReleasedSlugs - 当前临时展开的已发布版本集合
 * @param {string} slug - 被操作的版本 slug
 * @returns {Set<string>} 新的 openReleasedSlugs（不修改原集合）
 */
function toggleReleasedOpenInState(openReleasedSlugs, slug) {
  const next = new Set(openReleasedSlugs);
  next.delete(slug);
  return next;
}

/**
 * 退出搜索时的精准恢复指令（g-233 P1/P4）。
 * 纯函数：不修改 React state，仅返回「哪些泳道/列需要折叠回去」的指令对象。
 *
 * @param {{ ws: string, expandedLanes: Set<string>, openReleasedSlugs: Set<string>, deliverExpanded: boolean, blockedExpanded: boolean }} tempState
 * @param {string} activeWs - 当前活跃工作区
 * @returns {{ collapsedLanes: string[], unopenedReleasedSlugs: string[], collapseDeliver: boolean, collapseBlocked: boolean, wsMismatch: boolean }}
 *   - wsMismatch: true 表示工作区已切换，调用方应直接丢弃临时状态而非恢复
 *   - collapsedLanes: 需要折叠回去的泳道 key 列表（仅含用户未显式操作过的）
 *   - unopenedReleasedSlugs: 需要取消展开的已发布版本 slug 列表
 *   - collapseDeliver / collapseBlocked: 是否需要折叠交付/阻塞列
 */
function exitSearchRestore(tempState, activeWs) {
  // P2: 工作区不一致时直接丢弃不触碰
  if (tempState.ws && tempState.ws !== activeWs) {
    return {
      collapsedLanes: [],
      unopenedReleasedSlugs: [],
      collapseDeliver: false,
      collapseBlocked: false,
      wsMismatch: true,
    };
  }

  return {
    collapsedLanes: [...tempState.expandedLanes],
    unopenedReleasedSlugs: [...tempState.openReleasedSlugs],
    collapseDeliver: tempState.deliverExpanded,
    collapseBlocked: tempState.blockedExpanded,
    wsMismatch: false,
  };
}

/**
 * 导航到搜索匹配项时，记录被自动展开的泳道/列并返回临时 unhide 指令（g-233 P1/P4）。
 * 纯函数：返回 { updatedTempState, unhideVersionSlug }，调用方负责应用到 React state。
 *
 * @param {{ ws: string, expandedLanes: Set<string>, openReleasedSlugs: Set<string>, deliverExpanded: boolean, blockedExpanded: boolean }} tempState
 * @param {{ id: string, versionSlug: string|null, isReleased: boolean, laneKey: string|null, status: string }} target
 * @param {string[]} hiddenVersionSlugs - 当前持久隐藏的版本 slug 列表
 * @param {function} stageOf - status→stage 映射函数
 * @returns {{ updatedTempState: object, unhideVersionSlug: string|null, expandLane: string|null, expandReleasedSlug: string|null, expandDeliver: boolean, expandBlocked: boolean }}
 */
function navigateToMatchTrack(tempState, target, hiddenVersionSlugs, stageOf) {
  const updated = {
    ws: tempState.ws,
    expandedLanes: new Set(tempState.expandedLanes),
    openReleasedSlugs: new Set(tempState.openReleasedSlugs),
    deliverExpanded: tempState.deliverExpanded,
    blockedExpanded: tempState.blockedExpanded,
  };

  let unhideVersionSlug = null;
  let expandLane = null;
  let expandReleasedSlug = null;
  let expandDeliver = false;
  let expandBlocked = false;

  // 1. 若在隐藏版本内，临时 unhide（P1: 纯内存覆盖层，不写持久底账）
  if (target.versionSlug && (hiddenVersionSlugs ?? []).includes(target.versionSlug)) {
    unhideVersionSlug = target.versionSlug;
  }

  // 2. 若在折叠版本内，自动展开并记录
  if (target.isReleased && target.versionSlug) {
    expandReleasedSlug = target.versionSlug;
    updated.openReleasedSlugs.add(target.versionSlug);
  } else if (target.laneKey) {
    expandLane = target.laneKey;
    updated.expandedLanes.add(target.laneKey);
  }

  // 3. 若在折叠的交付/阻塞列，自动展开并记录
  const stage = stageOf(target.status);
  if (stage === "deliver" && !tempState.deliverExpanded) {
    updated.deliverExpanded = true;
    expandDeliver = true;
  } else if (stage === "blocked" && !tempState.blockedExpanded) {
    updated.blockedExpanded = true;
    expandBlocked = true;
  }

  return {
    updatedTempState: updated,
    unhideVersionSlug,
    expandLane,
    expandReleasedSlug,
    expandDeliver,
    expandBlocked,
  };
}

/**
 * 计算视图有效的隐藏版本集合（g-233 P1：搜索内存覆盖层不写持久底账）。
 * 纯函数：从持久隐藏列表中排除被搜索临时 unhide 的 slug。
 *
 * @param {string[]} hiddenVersionSlugs - 持久隐藏的版本 slug 列表
 * @param {Set<string>} searchUnhiddenSlugs - 搜索临时 unhide 的版本 slug 集合
 * @returns {Set<string>} 视图中应隐藏的版本 slug 集合
 */
function computeEffectiveHiddenVersionSlugs(hiddenVersionSlugs, searchUnhiddenSlugs) {
  return new Set((hiddenVersionSlugs ?? []).filter((slug) => !searchUnhiddenSlugs.has(slug)));
}

/**
 * 工作区切换时的完整搜索状态重置对象（g-233 P2：防止跨工作区污染）。
 * 返回 { searchState, tempState } 供调用方一次性 set 所有搜索相关 React state。
 *
 * @param {string} activeWs - 新的工作区路径
 * @returns {{ searchState: { query: string, activeQuery: string, matches: any[], currentIndex: number, feedback: string|null, unhiddenSlugs: Set<string> }, tempState: object }}
 */
function resetSearchState(activeWs) {
  return {
    searchState: {
      query: "",
      activeQuery: "",
      matches: [],
      currentIndex: 0,
      feedback: null,
      unhiddenSlugs: new Set(),
    },
    tempState: createSearchTempState(activeWs),
  };
}

// >>>ESM-EXPORTS-START>>> (build script strips this block for browser bundle)
export { createSearchTempState, toggleLaneCollapseInState, toggleReleasedOpenInState, exitSearchRestore, navigateToMatchTrack, computeEffectiveHiddenVersionSlugs, resetSearchState };
// <<<ESM-EXPORTS-END<<<

    // Search contract marker: 未找到匹配.
    // Contract marker: 未找到匹配
