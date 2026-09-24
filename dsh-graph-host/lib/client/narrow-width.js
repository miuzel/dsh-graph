// dsh-graph 看板窄宽度响应式派生纯函数模块（g-352）
// 取代 g-330 的「最小适配」（constants.js 里那条「头部放开换行」的纯 CSS 规则）。
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
/**
 * g-352 att-005：头部「装不下就把六项工具条收进 ⋯ 工具」的实测判定余量（px）。
 * 已折叠状态要重新展开，必须多出这么多余量（避免折叠↔展开在同一宽度上自激抖动）。
 */
const HEAD_FIT_SLACK = 24;
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
 * g-352 att-005（负责人 gate「装不下进「⋯ 工具」弹层」）：头部**单行自然宽度**。
 *
 * 头部子项一律 `flex-shrink: 0`（.dg-head > *），故每个子项的 offsetWidth 就是它的自然宽度；
 * 自然宽度之和 + 间隙 = 头部排成一行所需的最小宽度。任一子项测不到（vm harness / SSR / 首帧）
 * ⇒ 返回 null，调用方保持现状（绝不误折叠）。
 * @param {Array<number>} childWidths 子项 offsetWidth
 * @param {number} gap 头部 flex gap（S.head.gap）
 * @returns {number|null}
 */
function headNaturalWidth(childWidths, gap) {
  const list = Array.isArray(childWidths) ? childWidths : [];
  if (list.length === 0) return null;
  if (!list.every((w) => Number.isFinite(Number(w)) && Number(w) > 0)) return null;
  const g = Number.isFinite(Number(gap)) ? Number(gap) : 0;
  return list.reduce((sum, w) => sum + Number(w), 0) + g * (list.length - 1);
}

/**
 * g-352 att-005：头部六项工具条「折叠 / 展开」的下一次状态（纯函数，唯一真源）。
 *
 * 判据是头部**实测自然宽度**（而不是某个写死的视口宽度）：装不下（自然宽度 > 可用宽度）就折叠；
 * 已折叠状态用「上次展开态实测需求 + HEAD_FIT_SLACK」作展开门槛 ⇒ 折叠↔展开不会自激抖动
 *（折叠后自然宽度必然变小，若按当前宽度直接判定会立刻反弹）。
 * 测量不可用（任一入参非正有限值）⇒ null，调用方保持现状（只按断点分档：<480 折叠）。
 * @param {{collapsed:boolean, naturalWidth:number, availableWidth:number, expandedNeed:number}} input
 * @returns {{collapsed:boolean, expandedNeed:number}|null}
 */
function fitCollapseState(input) {
  const natural = Number(input?.naturalWidth);
  const available = Number(input?.availableWidth);
  if (!Number.isFinite(natural) || !Number.isFinite(available) || natural <= 0 || available <= 0) return null;
  const prevNeed = Number(input?.expandedNeed);
  if (!input?.collapsed) {
    // 展开态：这次实测的自然宽度就是「展开所需宽度」，直接据它判定是否装得下
    return { collapsed: natural > available + 1, expandedNeed: natural };
  }
  const need = Number.isFinite(prevNeed) && prevNeed > 0 ? prevNeed : natural;
  return { collapsed: available < need + HEAD_FIT_SLACK, expandedNeed: Number.isFinite(prevNeed) && prevNeed > 0 ? prevNeed : 0 };
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

/**
 * g-352 负责人人工 gate 反馈①：折叠工具条弹层的**每一行都必须同时有图标与文字**。
 *
 * 图标是语言中立的符号（zh/en 共用同一套，故不进 i18n 词条；与仓库既有 🏷️/＋/⚙ 同口径），
 * 文字取既有 i18n 标签并剥掉标签自带的前导符号与括号补充说明 —— 既避免「🏷️ 🏷️ 标签筛选」
 * 式重复，也让 en 的长标签（`📇 Project Knowledge Base (Shared Entries)`）在窄弹层里可读。
 * 本函数只做派生、不持有状态。
 */
const HEAD_PANEL_ICONS = {
  refresh: "⟳",
  tagfilter: "🏷️",
  tagclear: "✕",
  memory: "🧠",
  shared: "📇",
  settings: "⚙",
  versionmanage: "🏷️",
  createversion: "＋",
};

/** 剥掉文案的前导符号/空白，再剥掉尾部的括号补充说明（中英文括号都吃）。 */
function stripPanelLabelDecorations(rawLabel) {
  return String(rawLabel ?? "")
    .replace(/[（(][^）)]*[）)]\s*$/u, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
}

/**
 * 弹层行的「图标 + 文字」标签（图标与文字都非空 ⇒ 每行同时有图标与文字）。
 * @param {string} key 行标识（refresh/tagfilter/tagclear/memory/shared/settings）
 * @param {string} rawLabel 既有 i18n 标签原文
 * @returns {{icon: string, text: string, label: string}}
 */
function headPanelEntry(key, rawLabel) {
  const icon = HEAD_PANEL_ICONS[key] ?? "";
  const text = stripPanelLabelDecorations(rawLabel);
  return { icon, text, label: icon ? icon + " " + text : text };
}

/** 「查看版本」选择器各选项的图标（与看板泳道一致：版本 🏷️ / backlog 📥 / 独立目标 📌）。 */
const VIEW_OPTION_ICONS = { all: "▸", version: "🏷️", backlog: "📥", standalone: "📌" };

/**
 * 「查看版本」选择器的选项标签（判据 5①）：图标与看板泳道一致，且**选中勾选标记不替代图标**
 * （✓ 与图标并存，而不是二选一）。图标同样是语言中立符号，zh/en 共用。
 * @param {"all"|"version"|"backlog"|"standalone"} kind 选项种类
 * @param {string} text 选项文字（来自 dgT）
 * @param {boolean} selected 是否为当前选中项
 */
function viewOptionLabel(kind, text, selected) {
  const icon = VIEW_OPTION_ICONS[kind] ?? "";
  return (selected ? "✓ " : "") + (icon ? icon + " " : "") + String(text ?? "");
}

/** 「查看版本」触发器文字 + 下拉箭头（判据 5②：让「可点开」可发现）。 */
function viewPickerTriggerText(text) {
  return String(text ?? "") + " ▾";
}

/**
 * g-352 att-003 第 9 项（负责人人工 gate 反馈）：「同一行按钮有大有小」——
 * 把**同一行按钮**的尺寸口径收敛到**这一处**（唯一真源），头部/工具条/版本行/折叠弹层全部复用。
 *
 * 口径：同行文字按钮统一 height/line-height/字号/内边距/圆角基准；图标按钮是**与同行文字按钮
 * 等高**的 1:1 方形（width = height），不得「一边小方块、一边大长条」。
 */
const ROW_BTN_METRICS = {
  height: 26,
  fontSize: 12,
  lineHeight: "22px",
  padding: "0 8px",
  gap: 4,
  verticalAlign: "middle",
};

/**
 * 同行按钮内联样式（与 S.btn 叠加使用）。
 * @param {{iconOnly?: boolean}} [opts] iconOnly=true ⇒ 等高 1:1 方形图标按钮
 * @returns {object} React 内联样式对象
 */
function rowBtnStyle(opts) {
  const iconOnly = !!opts?.iconOnly;
  const base = {
    height: ROW_BTN_METRICS.height,
    boxSizing: "border-box",
    fontSize: ROW_BTN_METRICS.fontSize,
    lineHeight: ROW_BTN_METRICS.lineHeight,
    padding: iconOnly ? "0" : ROW_BTN_METRICS.padding,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: ROW_BTN_METRICS.gap,
    verticalAlign: ROW_BTN_METRICS.verticalAlign,
  };
  // 图标按钮：宽=高，且锁死最小宽度，避免被 flex 压扁成非方形
  return iconOnly ? { ...base, width: ROW_BTN_METRICS.height, minWidth: ROW_BTN_METRICS.height } : base;
}

/**
 * g-352 att-003 真机修正（第 1 项）：窄档下拉/选择器弹层的**锚定**——菜单右缘对齐**看板右缘**，
 * 绝不左伸出侧栏被宿主裁掉（真机 439px 实测：原来的 right:0 锚在触发按钮右缘，240px 菜单左伸
 * 172px 被侧栏裁掉 ⇒ 行文字全被吞，与「图标 + 文字齐备」的要求相悖）。
 *
 * 纯函数、无 DOM 依赖：调用方传入触发元素与看板根元素的 getBoundingClientRect()。
 * 测量不可用（SSR / vm harness 假节点无 right）→ null，调用方回落 right:0（行为不变）。
 * @param {{right?: number}|null} triggerRect
 * @param {{right?: number, width?: number}|null} boardRect
 * @param {number} [wantMinWidth] 菜单期望最小宽度（工具条 240 / 选择器 220）
 * @returns {{right: number, minWidth: number}|null}
 */
function popoverAnchor(triggerRect, boardRect, wantMinWidth) {
  const sright = Number(triggerRect?.right);
  const bright = Number(boardRect?.right);
  const bw = Number(boardRect?.width);
  if (!Number.isFinite(sright) || !Number.isFinite(bright) || !Number.isFinite(bw) || bw <= 0) return null;
  const want = Number.isFinite(Number(wantMinWidth)) && Number(wantMinWidth) > 0 ? Number(wantMinWidth) : 240;
  return {
    // 菜单右缘落到看板右缘：right 是相对触发元素右缘的偏移（负值 = 向右推）
    right: Math.round(sright - bright),
    minWidth: Math.max(160, Math.min(want, Math.round(bw) - 24)),
  };
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
 * 看板头部**搜索框包装层**的内联样式。
 *
 * 基线（g-352 之前）恰好是下面这 5 个键；g-352 唯一新增的 `min-width: 0` 只在窄档
 * （narrowActive）追加 —— 未测量 / 宽档时返回的键集合与基线**逐字一致**。
 * 之所以抽成纯函数：门控本身必须能被真实断言（不是源码正则），见 g352 测试「判据 2/判据 5」。
 * att-005（负责人 gate「两侧完全一致」）：两个宿主共用这一份实现（同一 KanbanView，零 host 门控）。
 *
 * @param {boolean} narrowActive 是否处于窄档（<480px）
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
  HEAD_FIT_SLACK,
  MOVE_TO_BACKLOG_ERROR_CODE,
  HEAD_PANEL_ICONS,
  VIEW_OPTION_ICONS,
  ROW_BTN_METRICS,
  boardWidthTier,
  shouldCollapseToolbar,
  isSingleVersionTier,
  headNaturalWidth,
  fitCollapseState,
  pickSingleVersion,
  scheduleTargetOptions,
  isMoveToBacklogRejection,
  searchBarWrapStyle,
  searchBarInnerStyle,
  headPanelEntry,
  viewOptionLabel,
  viewPickerTriggerText,
  rowBtnStyle,
  popoverAnchor,
};
// <<<ESM-EXPORTS-END<<<
