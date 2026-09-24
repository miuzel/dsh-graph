// dsh-graph 看板窄宽度响应式派生纯函数模块（g-352）
// 取代 g-330 的「最小适配」（constants.js 的 `.dg-head-sidebar { flex-wrap: wrap; row-gap: 6px }`）。
//
// 断点真源 = **看板根容器实测宽度**（ResizeObserver 观测 S.wrap 的 clientWidth），不是 window 宽度：
// 右侧栏宽度由宿主拖拽改变，window 宽度可以完全不变。
//
// 本模块只做派生、不持有状态、不写任何持久化键：
//   - 断点分档与工具条折叠判定（boardWidthTier / shouldCollapseToolbar / isSingleVersionTier）
//   - 单版本模式的可见版本投影（pickSingleVersion）——在既有可见性判定
//     （hiddenVersionSlugs 持久底账 + searchUnhiddenSlugs 搜索临时覆盖层）**之上**再收窄，
//     不新增状态真源。
//   - 排期目标选项派生（scheduleTargetOptions）——**结构上不可能产出 backlog 选项**。
//   - 「带附件不能回 backlog」的稳定错误码判定（isMoveToBacklogRejection）。

/** <480px：工具条（刷新/标签筛选/记忆/知识库/设置/显示归档）收进一个弹层容器 */
const NARROW_TOOLBAR_MAX_WIDTH = 480;
/** <360px：单版本模式——只渲染选中版本一个泳道，阶段列由横向并排改为纵向堆叠 */
const NARROW_SINGLE_VERSION_MAX_WIDTH = 360;

/**
 * 宽度分档。宽度不可用（SSR / 尚未测量 / ResizeObserver 缺失 → Infinity）时按 wide 处理，
 * 绝不误折叠：默认外观与 g-330 之前的全宽路径逐字一致。
 * @param {number|undefined|null} width 看板根容器实测宽度（px）
 * @returns {"wide"|"narrow"|"single"}
 */
function boardWidthTier(width) {
  const w = typeof width === "number" && Number.isFinite(width) ? width : Infinity;
  if (w < NARROW_SINGLE_VERSION_MAX_WIDTH) return "single";
  if (w < NARROW_TOOLBAR_MAX_WIDTH) return "narrow";
  return "wide";
}

/** <480px 折叠工具条（含 <360px 的单版本档）。 */
function shouldCollapseToolbar(width) {
  return boardWidthTier(width) !== "wide";
}

/** <360px 进入单版本模式。 */
function isSingleVersionTier(width) {
  return boardWidthTier(width) === "single";
}

/**
 * 单版本模式的可见版本投影（纯派生，不新增状态真源）。
 * 入参 visibleVersions 必须已是既有可见性判定的结果（active 集合 + hiddenVersionSlugs 底账 +
 * searchUnhiddenSlugs 搜索覆盖层共同作用后），本函数只在其上再收窄到一个版本。
 *
 * 降级：选中 slug 失效（版本被隐藏/删除/重命名、切换工作区、切回全宽后重进单版本档）→
 * 回落到首个可见版本；没有任何可见版本 → null（调用方回落全宽多泳道渲染，不抛错）。
 *
 * @param {Array<{slug: string}>} visibleVersions
 * @param {string|null|undefined} selectedSlug
 * @returns {object|null}
 */
function pickSingleVersion(visibleVersions, selectedSlug) {
  const list = Array.isArray(visibleVersions) ? visibleVersions.filter((v) => v && typeof v.slug === "string") : [];
  if (list.length === 0) return null;
  if (selectedSlug) {
    const hit = list.find((v) => v.slug === selectedSlug);
    if (hit) return hit;
  }
  return list[0];
}

/**
 * 排期（归属变更）目标选项派生。
 * **结构上不可能产出 backlog 选项**（判据 4）：只从「独立目标」与「活跃版本」两种语义产出。
 * 已被发布版本不作为排期目标（与 VersionSelectorButton 的 activeVersions 入参口径一致）。
 *
 * @param {Array<{slug: string, name?: string}>} activeVersions 活跃版本（非 released）
 * @param {string|null} currentVersion 目标当前所属版本（同版本不出现在选项里，避免原地排期）
 * @param {boolean} allowStandalone 是否提供「独立目标」选项（目标已在独立目标时不再提供）
 * @returns {Array<{to: "standalone"|"version", version?: string, label?: string}>}
 */
function scheduleTargetOptions(activeVersions, currentVersion, allowStandalone) {
  const opts = [];
  if (allowStandalone) opts.push({ to: "standalone", version: undefined, label: undefined });
  for (const v of Array.isArray(activeVersions) ? activeVersions : []) {
    if (!v || typeof v.slug !== "string" || v.slug === "") continue;
    if (currentVersion && v.slug === currentVersion) continue;
    opts.push({ to: "version", version: v.slug, label: v.name || v.slug });
  }
  return opts;
}

/** 「带附件不能回 backlog」的稳定错误码（dsh-graph-host 服务端 move-goal 端点下发）。 */
const MOVE_TO_BACKLOG_ERROR_CODE = "move-to-backlog-has-attachments";

/**
 * 是否「带附件不能回 backlog」失败态。
 * 用语言中立的稳定错误码判定，不再用中文子串匹配服务端文案（旧实现 `err.includes(dgT(...))`
 * 永远匹配不上服务端的中文 GraphError，且会把中文原文漏进英文界面）。
 */
function isMoveToBacklogRejection(code) {
  return code === MOVE_TO_BACKLOG_ERROR_CODE;
}

/**
 * 看板头部**搜索框包装层**的内联样式（判据 5：conversation.view 路径 DOM/样式逐字不变）。
 *
 * 基线（g-352 之前）恰好是下面这 5 个键；g-352 唯一新增的 `min-width: 0` 只在右侧栏窄档
 * （narrowActive）追加 —— 未测量 / 非 sidebarHost 时返回的键集合与基线**逐字一致**，
 * 会话内渲染路径不会多出任何样式键（这正是 att-001 被判 BLOCK 的 C3 项）。
 * 之所以抽成纯函数：门控本身必须能被真实断言（不是源码正则），见 g352 测试「判据 5」。
 *
 * @param {boolean} narrowActive 是否处于右侧栏窄档（<480px）
 * @returns {object} React 内联样式对象
 */
function searchBarWrapStyle(narrowActive) {
  const base = { display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", flexShrink: 0 };
  return narrowActive ? { ...base, minWidth: 0 } : base;
}

/** 搜索框**内层**（输入框 + 清除按钮的定位容器）的内联样式；门控口径同 searchBarWrapStyle。 */
function searchBarInnerStyle(narrowActive) {
  const base = { position: "relative", display: "flex", alignItems: "center" };
  return narrowActive ? { ...base, minWidth: 0 } : base;
}

// >>>ESM-EXPORTS-START>>> (build script strips this block for browser bundle)
export {
  NARROW_TOOLBAR_MAX_WIDTH,
  NARROW_SINGLE_VERSION_MAX_WIDTH,
  MOVE_TO_BACKLOG_ERROR_CODE,
  boardWidthTier,
  shouldCollapseToolbar,
  isSingleVersionTier,
  pickSingleVersion,
  scheduleTargetOptions,
  isMoveToBacklogRejection,
  searchBarWrapStyle,
  searchBarInnerStyle,
};
// <<<ESM-EXPORTS-END<<<
