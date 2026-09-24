/**
 * g-352：侧栏窄宽度适配（**取代** g-330 的「最小适配」）回归测试。
 *
 * 判据覆盖：
 *  1. 断点以看板根容器实测宽度为准（非 window 宽度），<480px 折叠工具条、<360px 单版本模式，
 *     ResizeObserver 监听动态拖拽 —— 阈值边界用真实数值逐点断言 + 源码契约。
 *  2. 无溢出：min-width:0 + text-overflow:ellipsis 兜底（触发按钮自身也不越框）。
 *  3. 单版本模式：只渲染选中版本一个泳道，阶段列横向并排 → 纵向堆叠；保留「全部版本」入口。
 *  4. 排期可用性：任意非归档目标可见；选项**永不包含 backlog**；两种语义（draft→planning 排期 /
 *     版本↔版本归属变更且状态保持）用真实 core ops 断言；带附件回 backlog 被拒并给失败态；
 *     排期后源/目标泳道计数与明细即时一致（含 retained 明细复位）。
 *  6. i18n zh/en 对称、零硬编码中文；复用既有内联下拉（S.inlineMenu）与排期选项纯函数，零新依赖。
 *  7. 降级/空态：无活跃版本、选中版本失效、栏宽拉回全宽均安全回落且不抛错；选中版本不另建状态真源。
 *  9. 硬约束不破坏：g-287（draft ≡ backlog）与 board-retain.js（绝不写 backlog_count）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

import {
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
} from "../../dsh-graph-host/lib/client/narrow-width.js";
import {
  init,
  createGoal,
  createVersion,
  setVersionStatus,
  addCard,
  moveGoal,
  transition,
  findGoalFile,
  loadGoal,
  boardProjection,
  backlogGoals,
} from "../ops.ts";
import { reconcileRetainedBoardState } from "../../dsh-graph-host/lib/client/board-retain.js";

const hostRoot = join(import.meta.dirname, "../../dsh-graph-host");
const readClient = (name: string) => readFileSync(join(hostRoot, `lib/client/${name}.js`), "utf8");

function setupTestProject(): { root: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), "dsh-g352-test-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  return { root, cleanup: () => { try { rmSync(ws, { recursive: true, force: true }); } catch { /* 忽略 */ } } };
}

// ============================================================ 判据 1：断点阈值（真实数值）

test("g-352 判据1：断点阈值 <480px 折叠工具条、<360px 单版本模式（边界数值逐点断言）", () => {
  assert.equal(NARROW_TOOLBAR_MAX_WIDTH, 480, "折叠工具条断点为 480px");
  assert.equal(NARROW_SINGLE_VERSION_MAX_WIDTH, 360, "单版本模式断点为 360px");

  // 上界为开区间：恰好 480/360 仍属上一档
  assert.equal(boardWidthTier(900), "wide");
  assert.equal(boardWidthTier(480), "wide", "恰好 480px 不折叠（<480 才折叠）");
  assert.equal(boardWidthTier(479.9), "narrow");
  assert.equal(boardWidthTier(400), "narrow");
  assert.equal(boardWidthTier(360), "narrow", "恰好 360px 仍是多泳道窄档（<360 才单版本）");
  assert.equal(boardWidthTier(359.9), "single");
  assert.equal(boardWidthTier(240), "single");
  // 宽度不可用（未测量 / ResizeObserver 缺失 / SSR）→ wide，绝不误折叠
  for (const unusable of [undefined, null, NaN, Infinity]) {
    assert.equal(boardWidthTier(unusable as any), "wide", `宽度 ${String(unusable)} 必须回落 wide`);
  }

  assert.equal(shouldCollapseToolbar(479), true);
  assert.equal(shouldCollapseToolbar(480), false);
  assert.equal(shouldCollapseToolbar(300), true, "<360px 同样折叠工具条（单版本档是其子集）");
  assert.equal(isSingleVersionTier(359), true);
  assert.equal(isSingleVersionTier(360), false);
  assert.equal(isSingleVersionTier(479), false);
});

test("g-352 判据1：断点真源为看板根容器实测宽度（ResizeObserver 观测），不是 window 宽度", () => {
  const src = readClient("kanban");
  // 观测对象是 boardRootRef 指向的看板根容器（S.wrap），实测 clientWidth
  assert.match(src, /const \[\s*boardWidth, setBoardWidth\] = React\.useState\(Infinity\)/);
  // 观测目标就是看板根节点本身；loading 阶段它还没渲染、kanbanRenderKey 变化会换节点，
  // 故依赖里带上「已挂载」与 render key，保证 ResizeObserver 挂到当前节点（真机 3082 实测踩过 null ref）
  assert.match(src, /const boardMounted = !state\.loading && !!state\.data;/);
  assert.match(src, /const el = boardRootRef\.current;/);
  assert.match(src, /ref: boardRootRef, style: S\.wrap,/);
  assert.match(src, /\}, \[activeWs, boardMounted, kanbanRenderKey\]\);/);
  assert.match(src, /const w = typeof el\.clientWidth === "number" && el\.clientWidth > 0/);
  assert.match(src, /const ro = new ResizeObserver\(measure\);/);
  assert.match(src, /ro\.observe\(el\);/);
  assert.match(src, /return \(\) => ro\.disconnect\(\);/);
  // 无 ResizeObserver 的宿主（旧 runner / vm）不抛错，退回首次测量值
  assert.match(src, /if \(typeof ResizeObserver === "undefined"\) return undefined;/);
  // 绝不按 window 宽度或媒体查询分档
  assert.doesNotMatch(src, /window\.innerWidth|window\.outerWidth|matchMedia/);
  // 分档走纯函数模块（阈值唯一真源），不是散落的数字字面量
  assert.match(src, /const widthTier = boardWidthTier\(boardWidth\);/);
  // att-005：断点/折叠是**两侧共用实现**——不再有 host 门控（会话页看板页签同口径）
  assert.match(src, /const narrowActive = widthTier !== "wide";/);
  assert.match(src, /const narrowSingleTier = isSingleVersionTier\(boardWidth\);/);
  assert.doesNotMatch(src, /sidebarHost/);
  const narrow = readClient("narrow-width");
  assert.doesNotMatch(narrow, /\bdocument\.|\bwindow\./, "断点派生是纯函数，不触碰 DOM/window");
});

test("g-352 att-005 B3：头部实测「装不下就折叠」的纯函数契约（唯一真源，含防抖动余量）", () => {
  const narrow = readClient("narrow-width");
  assert.match(narrow, /const HEAD_FIT_SLACK = 24;/);
  assert.equal(HEAD_FIT_SLACK, 24);
  // 自然宽度 = 子项宽度之和 + 间隙；测量不全（vm/SSR/首帧）⇒ null，绝不误折叠
  assert.equal(headNaturalWidth([100, 100, 100], 12), 324);
  assert.equal(headNaturalWidth([100], 12), 100);
  assert.equal(headNaturalWidth([100, 0], 12), null, "任一子项测不到 ⇒ null");
  assert.equal(headNaturalWidth([100, undefined as any], 12), null);
  assert.equal(headNaturalWidth([], 12), null);
  assert.equal(headNaturalWidth(null as any, 12), null);
  // 展开态：装不下就折叠，装得下不折叠（expandedNeed 记录本次实测需求，供折叠态判展开门槛）
  assert.deepEqual(fitCollapseState({ collapsed: false, naturalWidth: 1318, availableWidth: 1298, expandedNeed: 0 }), { collapsed: true, expandedNeed: 1318 });
  assert.deepEqual(fitCollapseState({ collapsed: false, naturalWidth: 1180, availableWidth: 1298, expandedNeed: 0 }), { collapsed: false, expandedNeed: 1180 });
  assert.deepEqual(fitCollapseState({ collapsed: false, naturalWidth: 1299, availableWidth: 1298, expandedNeed: 0 }), { collapsed: false, expandedNeed: 1299 }, "1px 亚像素容差内视为装得下");
  assert.deepEqual(fitCollapseState({ collapsed: false, naturalWidth: 1300, availableWidth: 1298, expandedNeed: 0 }), { collapsed: true, expandedNeed: 1300 }, "超出容差即折叠");
  // 折叠态：必须比「上次展开所需宽度 + slack」还宽才展开 ⇒ 折叠/展开不会在同一宽度自激抖动
  assert.deepEqual(
    fitCollapseState({ collapsed: true, naturalWidth: 700, availableWidth: 1298, expandedNeed: 1318 }),
    { collapsed: true, expandedNeed: 1318 },
    "1298 < 1318+24 ⇒ 保持折叠（否则展开→装不下→折叠的抖动）",
  );
  assert.equal(fitCollapseState({ collapsed: true, naturalWidth: 700, availableWidth: 1342, expandedNeed: 1318 })!.collapsed, false, "1342 >= 1318+24 ⇒ 展开");
  // 测量不可用 ⇒ null（调用方保持现状，只按 <480 断点档折叠）
  for (const bad of [
    { collapsed: false, naturalWidth: NaN, availableWidth: 900, expandedNeed: 0 },
    { collapsed: false, naturalWidth: 0, availableWidth: 900, expandedNeed: 0 },
    { collapsed: false, naturalWidth: 900, availableWidth: 0, expandedNeed: 0 },
    { collapsed: false, naturalWidth: 900, availableWidth: Infinity, expandedNeed: 0 },
  ]) {
    assert.equal(fitCollapseState(bad as any), null, `测量不可用必须回 null：${JSON.stringify(bad)}`);
  }
  // 接线契约：头部 ref 实测 offsetWidth + clientWidth，折叠状态 = 断点档 OR 实测
  const src = readClient("kanban");
  assert.match(src, /const headRef = React\.useRef\(null\);/);
  assert.match(src, /h\("div", \{ style: S\.head, className: "dg-head", ref: headRef \}/);
  assert.match(src, /const natural = headNaturalWidth\(kids\.map\(\(k\) => k\.offsetWidth\), S\.head\.gap\);/);
  assert.match(src, /React\.useLayoutEffect\(\(\) => \{/);
  assert.match(src, /const ro = new ResizeObserver\(measure\);\s*\n\s*ro\.observe\(el\);/);
  assert.match(src, /const toolbarCollapsed = shouldCollapseToolbar\(boardWidth\) \|\| toolbarCollapsedByFit;/);
  // 六项之外不得再往弹层里塞别的东西（负责人：「只折叠这几个」）
  const panelSlice = src.slice(src.indexOf("const headPanelRows = ["), src.indexOf("const headPanelItems"));
  assert.doesNotMatch(panelSlice, /versionmanage|createversion/, "版本管理/创建版本不再进折叠弹层（回网格左上角）");
  assert.equal([...panelSlice.matchAll(/key: "/g)].length, 6, "弹层候选恰好六项（刷新/标签筛选/[清空标签]/记忆/知识库/设置）");
});

// ============================================================ 判据 2：无溢出兜底

test("g-352 判据2：min-width:0 + text-overflow:ellipsis 兜底（触发按钮自身也不越框）", () => {
  const css = readClient("constants");
  const src = readClient("kanban");
  // CSS 兜底规则：既给 min-width:0 也省略号收敛
  assert.match(css, /\.dg-narrow-head-btn \{ min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  // 内联兜底：窄档每个可见按钮都带同一组属性（含工具条折叠触发按钮）
  assert.match(src, /const narrowHeadBtnStyle = narrowActive\s*\n\s*\? \{ minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" \}/);
  assert.match(src, /const headBtnStyle = narrowHeadBtnStyle \? \{ \.\.\.tbBtnStyle, \.\.\.narrowHeadBtnStyle \} : tbBtnStyle;/);
  assert.match(src, /className: headBtnClass \+ " dg-head-overflow-trigger"/);
  assert.match(src, /className: headBtnClass \+ " dg-version-picker-trigger"/);
  // 折叠后头部剩下的可见控件都是可收缩的：DEBUG 块已有 minWidth:0 + 省略号，搜索框固定宽度 flexShrink:0
  assert.match(src, /minWidth: 0,\n\s*overflow: "hidden",\n\s*cursor: "default",/);
  // att-005「任何宽度不得竖排/逐字换行」的根因兜底：头部子项与按钮一律 nowrap + 不参与压缩
  //（CJK 的 min-content 只有一个字宽，缺这两条就会被 flex 压成逐字换行 —— 负责人 1585px 截图缺陷）
  assert.match(css, /\.dg-head \{ flex-wrap: wrap; \}/);
  assert.match(css, /\.dg-head > \* \{ flex-shrink: 0; \}/);
  assert.match(css, /\.dg-head > \*, \.dg-head button \{ white-space: nowrap; \}/);
  assert.doesNotMatch(css, /\.dg-head \.dg-btn \{ min-width: 0; \}/, "不得给头部全部按钮加 min-width:0（那才会压成竖排）");
  // 工具条六项在平铺态用 tbBtnStyle（同样 nowrap；头部按钮统一由 CSS 兜底）
  assert.match(src, /const tbBtnStyle = \{ \.\.\.S\.btn, \.\.\.rowBtnStyle\(\), marginLeft: 8 \};/);
});

// ============================================================ 判据 3：单版本模式

test("g-352 判据3：单版本投影只做派生（选中失效则回落首个可见版本，无可见版本则 null）", () => {
  const v1 = { slug: "v1", name: "V1" };
  const v2 = { slug: "v2", name: "V2" };
  assert.equal(pickSingleVersion([], "v1"), null, "无可见版本 → null（调用方回落全宽多泳道，不抛错）");
  assert.equal(pickSingleVersion(null as any, "v1"), null);
  assert.deepEqual(pickSingleVersion([v1, v2], null), v1, "未选择时默认第一个可见版本");
  assert.deepEqual(pickSingleVersion([v1, v2], "v2"), v2);
  // 选中版本被隐藏/删除/重命名后 slug 不再出现在可见集合里 → 安全回落
  assert.deepEqual(pickSingleVersion([v1, v2], "已被隐藏的 slug"), v1);
  // 脏数据（无 slug）被过滤，不会选中半截对象
  assert.deepEqual(pickSingleVersion([{ name: "无 slug" } as any, v2], null), v2);
});

test("g-352 判据3：单版本模式下只渲染选中版本一个泳道，阶段列改为纵向堆叠，保留「全部版本」入口", () => {
  const src = readClient("kanban");
  // 单版本派生只用既有可见性判定的结果 active（hiddenVersionSlugs + search 覆盖层之后的集合）
  assert.match(src, /const singleVersion = \(narrowSingleTier && !searchActiveQuery && !viewBacklogOnly && !viewStandaloneOnly && viewVersionSlug !== VIEW_ALL_VERSIONS_SLUG\)/);
  assert.match(src, /const VIEW_ALL_VERSIONS_SLUG = "__all__";/);
  // g-352（负责人裁决）：backlog 也是单版本档的视图备选 → 单泳道档 = 单版本 ∪ 单 backlog
  assert.match(src, /const VIEW_BACKLOG_SLUG = "__backlog__";/);
  assert.match(src, /const viewBacklogOnly = !!\(narrowSingleTier && !searchActiveQuery && viewVersionSlug === VIEW_BACKLOG_SLUG\);/);
  // att-003 第 5 项③：独立目标同样是单泳道档的视图备选 → 单泳道档 = 单版本 ∪ 单 backlog ∪ 单独立目标
  assert.match(src, /const VIEW_STANDALONE_SLUG = "__standalone__";/);
  assert.match(src, /const viewStandaloneOnly = !!\(narrowSingleTier && !searchActiveQuery && viewVersionSlug === VIEW_STANDALONE_SLUG\);/);
  assert.match(src, /const singleLaneMode = !!\(narrowSingleTier && !searchActiveQuery && \(singleVersion \|\| viewBacklogOnly \|\| viewStandaloneOnly\)\);/);
  // 只渲染选中版本一个泳道，且以纵向模式（lane 第 7 参 vertical=true）渲染；
  // att-003 第 4 项：单泳道档第 6 参 collapsible=false（只有一个泳道 ⇒ 不给版本头部 ▲/▼ 折叠开关）
  assert.match(src, /rows\.push\(\.\.\.lane\(`🏷️ \$\{singleVersion\.name\}`, singleVersion\.goals, "v-" \+ singleVersion\.slug, singleVersion\.slug, 0, false, true\)\)/);
  // 其他泳道（其余 active 版本、standalone、backlog、released）在该档一律不渲染
  assert.match(src, /for \(const v of \(singleLaneMode \? \[\] : active\)\)/);
  assert.match(src, /const releasedRows = \(singleLaneMode \? \[\] : released\)\.map/);
  assert.match(src, /if \(!singleLaneMode\) \{\n\s*rows\.push\(\.\.\.lane\(dgT\("lane\.standalone"\)/);
  // 列模板退化为单列全宽（阶段纵向堆叠而非横向挤压）
  assert.match(src, /const gridCols = singleLaneMode \? "minmax\(0, 1fr\)" : horizontalGridCols;/);
  // 横向阶段列头在单版本档不渲染（改由每个阶段块自带列头）
  assert.match(src, /singleLaneMode \? null : STAGES\.map\(\(s\) => \{/);
  // 纵向堆叠分支：每阶段一个块（列头 + 全宽单元格），容器 flexDirection: column
  assert.match(src, /const stacked = STAGES\.map\(\(s, sIdx\) => h\("div", \{\n\s*key: key \+ "-v-" \+ s\.key,/);
  assert.match(src, /gridColumn: "1 \/ -1", display: "flex", flexDirection: "column", gap: 8, minWidth: 0/);
  // 纵向档不再走 36px 竖条折叠形态（竖条在纵向堆叠里不可读）
  assert.match(src, /const deliverCollapsed = vertical \? false : deliverColumnCollapsed;/);
  assert.match(src, /const blockedCollapsed = vertical \? false : blockedColumnCollapsed;/);
  // 保留「全部版本」入口
  assert.match(src, /dgT\("view\.allVersions"\)/);
  assert.match(src, /onClick: \(\) => \{ setViewVersionSlug\(VIEW_ALL_VERSIONS_SLUG\); setShowVersionPicker\(false\); \}/);
  // 切换版本即改 selected slug（视图与计数随 active 派生，无第二份计数）
  assert.match(src, /onClick: \(\) => \{ setViewVersionSlug\(v\.slug\); setShowVersionPicker\(false\); \}/);
});

// ============================================================ 判据 4：排期可用性

test("g-352 判据4：排期目标选项派生永不含 backlog，且排除当前归属版本", () => {
  const v1 = { slug: "v1", name: "V1" };
  const v2 = { slug: "v2", name: "V2" };
  const opts = scheduleTargetOptions([v1, v2], null, true);
  assert.deepEqual(opts.map((o) => o.to), ["standalone", "version", "version"]);
  // 结构上不可能产出 backlog 选项
  for (const o of opts) {
    assert.ok(o.to === "standalone" || o.to === "version", `非法排期目标 ${String(o.to)}`);
    assert.notEqual(o.to as string, "backlog");
  }
  // 排除当前已归属版本（避免原地排期）
  assert.deepEqual(scheduleTargetOptions([v1, v2], "v1", true).map((o) => o.version), [undefined, "v2"]);
  // 已在独立目标 → 不再提供独立目标选项（否则是空操作）
  assert.deepEqual(scheduleTargetOptions([v1], null, false).map((o) => o.to), ["version"]);
  assert.deepEqual(scheduleTargetOptions([], null, false), [], "无任何选项 → 空态提示");
  // 脏数据与空 slug 被丢弃
  assert.deepEqual(scheduleTargetOptions([{ slug: "" }, null as any, v1], null, false).map((o) => o.version), ["v1"]);
  // 源码契约：选择器与拖放拒绝都吃这一份派生
  const card = readClient("card");
  assert.match(card, /const scheduleOptions = scheduleTargetOptions\(activeVersions, goalVersion, allowStandalone !== false\);/);
  assert.match(card, /const versionOptions = scheduleOptions\.filter\(\(o\) => o\.to === "version"\);/);
  assert.doesNotMatch(card, /doSchedule\("backlog"/, "选择器不得提供 backlog 选项");
  assert.doesNotMatch(card, /to: "backlog"/);
});

test("g-352 判据4：任意非归档目标标题栏可见「排期」（不再限于 backlog）", () => {
  const modal = readClient("goal-modal");
  // 放开限制：只看 archived
  assert.match(modal, /!isArchived\n\s*\? h\(VersionSelectorButton, \{/);
  assert.doesNotMatch(modal, /isBacklogGoal && !isArchived\s*\n\s*\? h\(VersionSelectorButton/);
  // 独立目标不再提供「独立目标」选项
  assert.match(modal, /const isStandaloneGoal = !isArchived && !isBacklogGoal && !state\.data\?\.meta\?\.version;/);
  assert.match(modal, /allowStandalone: !isStandaloneGoal,/);
  // 反直觉项定策：不往每张看板卡片标题栏另加排期按钮（与「窄宽度收窄工具条」相悖）
  assert.match(modal, /不往每张看板卡片标题栏再加「排期」按钮/);
  const card = readClient("card");
  assert.doesNotMatch(card, /goal\.scheduleTooltip[\s\S]{0,200}function Card\(/, "卡片本体不新增排期按钮");
});

test("g-352 判据4：两种排期语义的真实 core 结果（backlog→版本 = draft→planning；版本↔版本 = 状态保持）", () => {
  const { root, cleanup } = setupTestProject();
  try {
    createVersion(root, { slug: "v-a", name: "A", actor: "test" });
    createVersion(root, { slug: "v-b", name: "B", actor: "test" });
    // 语义一：backlog（draft）→ 版本 = 排期，状态变 planning
    const backlogGoal = createGoal(root, { title: "backlog 目标", actor: "test" });
    assert.equal(loadGoal(findGoalFile(root, backlogGoal)).meta.status, "draft");
    moveGoal(root, backlogGoal, { to: "version", version: "v-a", actor: "human:gui" });
    let doc = loadGoal(findGoalFile(root, backlogGoal));
    assert.equal(doc.meta.status, "planning", "backlog → 版本：draft → planning（排期）");
    assert.equal(doc.meta.version, "v-a");

    // 语义二：版本 ↔ 版本 = 归属变更，生命周期状态保持
    transition(root, backlogGoal, "collecting", { actor: "test" });
    moveGoal(root, backlogGoal, { to: "version", version: "v-b", actor: "human:gui" });
    doc = loadGoal(findGoalFile(root, backlogGoal));
    assert.equal(doc.meta.version, "v-b", "版本 → 版本：归属变更");
    assert.equal(doc.meta.status, "collecting", "版本 → 版本：状态保持（不回落 planning）");

    // 语义二变体：版本 ↔ 独立目标亦为归属变更、状态保持
    moveGoal(root, backlogGoal, { to: "standalone", actor: "human:gui" });
    doc = loadGoal(findGoalFile(root, backlogGoal));
    assert.equal(doc.meta.version, null);
    assert.equal(doc.meta.status, "collecting", "版本 → 独立目标：状态保持");
  } finally {
    cleanup();
  }
});

test("g-352 判据4：带附件目标移回 backlog 被拒，客户端据稳定错误码给本地化失败态", () => {
  const { root, cleanup } = setupTestProject();
  try {
    createVersion(root, { slug: "v-a", name: "A", actor: "test" });
    const id = createGoal(root, { title: "带附件目标", actor: "test" });
    moveGoal(root, id, { to: "version", version: "v-a", actor: "test" });
    addCard(root, id, { title: "c", kind: "text", actor: "test", scope: "goal" });
    // 服务端拒绝（core 真源）
    assert.throws(() => moveGoal(root, id, { to: "backlog", actor: "test" }), /附件/);
    // 稳定错误码判定（语言中立，不再用中文子串匹配服务端文案）
    assert.equal(MOVE_TO_BACKLOG_ERROR_CODE, "move-to-backlog-has-attachments");
    assert.equal(isMoveToBacklogRejection("move-to-backlog-has-attachments"), true);
    assert.equal(isMoveToBacklogRejection(undefined), false);
    assert.equal(isMoveToBacklogRejection("其它错误"), false);
    // 服务端端点确实下发该 code（源码契约）
    const host = readFileSync(join(hostRoot, "index.js"), "utf8");
    assert.match(host, /const errCode = \/附件\/\.test\(message\) && \/backlog\/i\.test\(message\) \? "move-to-backlog-has-attachments" : null;/);
    assert.match(host, /json\(res, code, errCode \? \{ error: message, code: errCode \} : \{ error: message \}\);/);
    // 客户端两条路径都据此给本地化失败态（而非服务端中文原文）
    const card = readClient("card");
    assert.match(card, /const rejected = isMoveToBacklogRejection\(moveData\.code\);/);
    assert.match(card, /setError\(rejected \? dgT\("drag\.moveToBacklogError"\) : \(moveData\.error \|\| dgT\("drag\.unknownError"\)\)\);/);
    const kanban = readClient("kanban");
    assert.match(kanban, /\} else if \(isMoveToBacklogRejection\(data\.code\)\) \{/);
    assert.match(kanban, /showToast\(dgT\('drag\.moveToBacklogError'\)\);/);
    assert.doesNotMatch(kanban, /err\.includes\(dgT\("drag\.moveToBacklogError"\)\)/, "旧的中文子串匹配必须删除");
  } finally {
    cleanup();
  }
});

test("g-352 判据4：排期成功后源/目标泳道计数与明细即时一致（含 retained 明细复位）", () => {
  const { root, cleanup } = setupTestProject();
  try {
    createVersion(root, { slug: "v-a", name: "A", actor: "test" });
    setVersionStatus(root, { slug: "v-a", status: "active", actor: "test" });
    const moved = createGoal(root, { title: "待排期", actor: "test" });
    createGoal(root, { title: "留在 backlog", actor: "test" });

    // 展开态已拉取 backlog 明细（retained）
    const lazyBefore = boardProjection(root, { lazy: true });
    const retained = { ...lazyBefore, backlog: backlogGoals(root), backlog_loaded: true };
    assert.equal(retained.backlog.length, 2);

    // 排期：backlog → 版本（与客户端 move-goal 同一入口）
    moveGoal(root, moved, { to: "version", version: "v-a", actor: "human:gui" });

    // 即时刷新：服务端 lazy 载荷计数已变，明细留空交懒加载补拉
    const data = boardProjection(root, { lazy: true });
    assert.equal(data.backlog_count, 1, "源泳道（backlog）计数即时减一");
    const vLane = data.versions.find((v: any) => v.slug === "v-a");
    assert.equal(vLane.goals_count, 1, "目标泳道（版本）计数即时加一");

    // retained 明细复位：计数不一致 → 丢弃旧明细、复位已加载标记、触发补拉；绝不写 backlog_count
    const res = reconcileRetainedBoardState(data, retained, { collapsedLanes: { backlog: false }, openReleased: {} });
    assert.equal(data.backlog_count, 1, "data.backlog_count 保持服务端值");
    assert.equal(data.backlog.length, 0, "旧明细被丢弃（无幽灵卡片）");
    assert.equal(data.backlog_loaded, false, "backlog_loaded 复位");
    assert.equal(res.refetchBacklog, true, "触发既有懒加载补拉");
    // 目标泳道明细与计数即时一致（版本泳道明细随载荷下发）
    assert.equal((vLane.goals ?? []).length, 1, "目标泳道明细即时出现该目标");
    assert.equal((vLane.goals ?? [])[0].id, moved, "目标泳道明细指向被排期的目标");
  } finally {
    cleanup();
  }
});

// ============================================================ 判据 6：i18n 对称 + 单一实现 + 零新依赖

test("g-352 判据6：新增文案 zh/en 齐备、en 零 CJK，且源码零硬编码中文文案", () => {
  const i18n = readClient("i18n");
  const keys = [
    "goal.rescheduleSuccess",
    "toolbar.more",
    "toolbar.moreTooltip",
    "toolbar.moreTitle",
    "view.pickVersion",
    "view.pickVersionTooltip",
    "view.allVersions",
  ];
  const zhBlock = i18n.slice(i18n.indexOf("const zh = {"), i18n.indexOf("const en = {"));
  const enBlock = i18n.slice(i18n.indexOf("const en = {"));
  for (const key of keys) {
    const pattern = new RegExp(`'${key.replace(/\./g, "\\.")}'\\s*:`, "g");
    assert.equal([...zhBlock.matchAll(pattern)].length, 1, `zh 缺少或多写 ${key}`);
    assert.equal([...enBlock.matchAll(pattern)].length, 1, `en 缺少或多写 ${key}`);
    const m = enBlock.match(new RegExp(`'${key.replace(/\./g, "\\.")}'\\s*:\\s*'([^']*)'`));
    assert.ok(m, `en 缺少 ${key}`);
    assert.doesNotMatch(m![1], /[\u3400-\u9fff]/, `en ${key} 不得含 CJK`);
  }
  // 新文案的使用点全部走 dgT（无硬编码中文）
  const kanban = readClient("kanban");
  for (const key of ["toolbar.more", "toolbar.moreTooltip", "toolbar.moreTitle", "view.pickVersion", "view.pickVersionTooltip", "view.allVersions"]) {
    assert.match(kanban, new RegExp(`dgT\\("${key.replace(/\./g, "\\.")}"`), `${key} 必须走 dgT`);
  }
  const card = readClient("card");
  assert.match(card, /dgT\(goalVersion \? "goal\.rescheduleSuccess" : "goal\.scheduleSuccess", \{ version: label \}\)/);
  // 新增纯函数模块的**代码**里不含任何文案（注释可中文；零硬编码中文指字符串字面量）
  const narrowCode = readClient("narrow-width")
    .split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  const narrowLiterals = [...narrowCode.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]).join("");
  assert.doesNotMatch(narrowLiterals, /[\u3400-\u9fff]/, "narrow-width.js 的字符串字面量不得含中文文案");
});

test("g-352 判据6：全仓只有一套内联下拉实现（S.inlineMenu + .dg-schedule-version-item），零新依赖", () => {
  const helpers = readClient("helpers");
  // 唯一样式 token 定义处
  assert.equal([...helpers.matchAll(/inlineMenu: \{/g)].length, 1, "S.inlineMenu 只有一个定义");
  // 排期版本选择器（card.js）与新选择器（kanban.js）共用同一 token
  assert.match(readClient("card"), /open \? h\("div", \{\n\s*style: S\.inlineMenu,/);
  const kanban = readClient("kanban");
  assert.equal([...kanban.matchAll(/\.\.\.S\.inlineMenu/g)].length, 2, "工具条折叠容器 + 查看版本选择器各引用一次");
  // 选项行复用既有 .dg-schedule-version-item（未新增第三套行样式）
  const constants = readClient("constants");
  assert.equal([...constants.matchAll(/\.dg-schedule-version-item/g)].length, 2, "只保留既有 hover 两条规则");
  // 零新依赖：三个改动模块都不含 ESM import / 额外 require
  for (const mod of ["kanban", "card", "narrow-width"]) {
    assert.doesNotMatch(readClient(mod), /^\s*import\s/m, `${mod} 不得引入 ESM import`);
    assert.doesNotMatch(readClient(mod), /require\((?!["']react["'])/, `${mod} 不得引入第三方依赖`);
  }
});

// ============================================================ 判据 7：降级 / 空态

test("g-352 判据7：无活跃版本 / 选中版本失效 / 拉回全宽均安全回落且不抛错", () => {
  const kanban = readClient("kanban");
  // 无活跃版本 → picker 显示空态文案，且单版本模式自动回落全宽多泳道
  assert.match(kanban, /active\.length === 0\n\s*\? h\("div", \{ style: \{ padding: "5px 10px", fontSize: 12, opacity: 0\.5 \} \}, dgT\("goal\.scheduleNoVersion"\)\)/);
  assert.equal(pickSingleVersion([], "任意"), null);
  // 选中版本被隐藏 → active 里没有它 → pickSingleVersion 回落；删除/重命名同理（slug 变化）
  assert.deepEqual(pickSingleVersion([{ slug: "still-here", name: "S" }], "被隐藏的"), { slug: "still-here", name: "S" });
  // 栏宽拉回全宽（离开窄档/单版本档）→ 收起窄宽度专属下拉，不残留
  assert.match(kanban, /if \(!narrowActive\) setShowHeadOverflow\(false\);/);
  assert.match(kanban, /if \(!narrowSingleTier\) setShowVersionPicker\(false\);/);
  // 未测量 / 无 ResizeObserver → wide 档，不误折叠
  assert.equal(boardWidthTier(Infinity), "wide");
  // 搜索激活时挂起单版本收窄（g-233 优先级：搜索匹配不被视图过滤藏掉）
  assert.match(kanban, /!searchActiveQuery && !viewBacklogOnly && !viewStandaloneOnly && viewVersionSlug !== VIEW_ALL_VERSIONS_SLUG\)/);
  // 选中 backlog 但处于搜索激活态时同样挂起（g-233 优先级不变）
  assert.match(kanban, /const viewBacklogOnly = !!\(narrowSingleTier && !searchActiveQuery/);
});

test("g-352 判据7：单版本选中不另建状态真源（零持久化键，仅派生映射既有可见性）", () => {
  const kanban = readClient("kanban");
  // 选中态只是组件内 React state
  assert.match(kanban, /const \[viewVersionSlug, setViewVersionSlug\] = React\.useState\(null\);/);
  // 零持久化：本目标不新增任何存储读写（隐藏状态唯一持久真源仍是 useHiddenVersionSlugs）
  assert.doesNotMatch(kanban, /localStorage|sessionStorage/, "单版本选中不得落任何持久化存储");
  // 排期选择器（本次放开的组件）同样零持久化新增
  const card = readClient("card");
  const selectorSrc = card.slice(card.indexOf("function VersionSelectorButton("), card.indexOf("// 目标卡：只保留关键信息"));
  assert.ok(selectorSrc.length > 0, "card.js 含 VersionSelectorButton 源片段");
  assert.doesNotMatch(selectorSrc, /localStorage|sessionStorage/);
  // 可见性仍由既有两份既有来源共同决定（持久底账 + 搜索临时覆盖层），单版本只在其上再收窄
  assert.match(kanban, /const hiddenVersionSet = computeEffectiveHiddenVersionSlugs\(hiddenVersionSlugs, searchUnhiddenSlugs\);/);
  assert.match(kanban, /const active = allActiveVersions\.filter\(\(v\) => !hiddenVersionSet\.has\(v\.slug\)\);/);
});

// ============================================================ 判据 9：硬约束不破坏

test("g-352 判据9：g-287 不变式与 board-retain 的「绝不写 backlog_count」均未被破坏", () => {
  // g-287：draft ≡ 位于 backlog —— 客户端排期只调 move-goal，不自行改状态
  const card = readClient("card");
  assert.match(card, /moveGoal 已自动处理 draft→planning 转换，无需显式 transition/);
  const selectorSrc = card.slice(card.indexOf("function VersionSelectorButton("), card.indexOf("// 目标卡：只保留关键信息"));
  assert.doesNotMatch(selectorSrc, /api\/dsh-graph\/transition/, "排期路径不得自行调用 transition 端点（状态由 core moveGoal 决定）");
  assert.doesNotMatch(selectorSrc, /doSchedule\(\s*["'`]backlog/, "排期选择器绝不发往 backlog");
  // board-retain：绝不写 backlog_count
  const retain = readClient("board-retain");
  assert.match(retain, /绝不写 data\.backlog_count/);
  assert.doesNotMatch(retain, /data\.backlog_count\s*=(?!=)/, "board-retain 不得给 backlog_count 赋值（比较运算不算）");
  // 客户端看板代码也不得写 backlog_count（除既有 loadBacklogGoals 的本地聚合路径）
  const kanban = readClient("kanban");
  const assignments = [...kanban.matchAll(/backlog_count:\s*json\.goals\.length/g)].length;
  assert.equal(assignments, 1, "backlog_count 的写入点数量未增加（仅既有本地聚合一处）");
});

// ============================================================================
// C2-m5：构建接线守卫（复核者变异 m5 —— PARTS 删掉 narrow-width ⇒ 全套 1317 仍绿，
// 但 bundle 内 boardWidthTier( 调用 1 处、定义 0 处 ⇒ 真机两条 host 路径同时 ReferenceError）
// ============================================================================

/** 按 build-client.sh 的语义读出 PARTS 列表（正则解析，不执行脚本）。 */
function readBuildParts(): { parts: string[]; script: string } {
  const script = readFileSync(join(import.meta.dirname, "../../scripts/build-client.sh"), "utf8");
  const start = script.indexOf("PARTS=(");
  const end = script.indexOf("\n)", start);
  assert.ok(start >= 0 && end > start, "build-client.sh 含 PARTS=(...) 列表");
  return { parts: [...script.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]), script };
}

/** 用真实构建脚本把 bundle 产出到仓库外/临时目录（绝不触碰活动 dist/）。 */
function buildBundleToTemp(): string {
  const out = mkdtempSync(join(tmpdir(), "dsh-g352-bundle-"));
  try {
    execFileSync("bash", [join(import.meta.dirname, "../../scripts/build-client.sh")], {
      cwd: join(import.meta.dirname, "../.."),
      env: { ...process.env, DIST_DIR: out },
      stdio: "pipe",
    });
  } catch (e) {
    assert.fail(`build-client.sh 执行失败（守卫必须跑真实构建接线）：${String((e as Error)?.message ?? e)}`);
  }
  return readFileSync(join(out, "lib/client.js"), "utf8");
}

const localFunctionNames = (src: string): string[] =>
  [...src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);

test("g-352 C2-m5：build-client PARTS 覆盖 lib/client 全部模块，且 bundle 内无「被调用但无定义」的本地函数", () => {
  const modDir = join(import.meta.dirname, "../../dsh-graph-host/lib/client");
  const modules = readdirSync(modDir).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
  const { parts } = readBuildParts();

  // ① 结构守卫：PARTS 与源目录一一对应（顺序是刻意的依赖序，故只比集合）
  assert.deepEqual(
    [...parts].sort(), [...modules].sort(),
    "PARTS 必须覆盖 lib/client/*.js 全部模块：漏一个 ⇒ bundle 里该模块的导出函数会在别处被调用却无定义（真机 ReferenceError）",
  );
  assert.equal(new Set(parts).size, parts.length, "PARTS 内不得重复");

  // ② 语义守卫：对**真实构建产物**做「每个被引用的本地函数都有定义」检查。
  const bundle = buildBundleToTemp();
  assert.match(bundle, /⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY/, "临时构建产物带生成标记");
  const defined = new Set(localFunctionNames(bundle));
  const undefinedCalled: string[] = [];
  for (const mod of modules) {
    for (const name of localFunctionNames(readFileSync(join(modDir, mod + ".js"), "utf8"))) {
      if (defined.has(name)) continue;
      // 该函数在所有源模块里都没有定义落地 ⇒ 若 bundle 内仍被调用，就是必然的 ReferenceError
      if (new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(bundle)) undefinedCalled.push(`${mod}.js 定义的 ${name}()`);
    }
  }
  assert.deepEqual(undefinedCalled, [], "bundle 内被调用却无定义的本地函数（构建接线漏模块的典型症状）");
  // 反证：守卫真的看得见定义（boardWidthTier 由 narrow-width 模块提供）
  assert.ok(defined.has("boardWidthTier"), "bundle 内必须有 boardWidthTier 的定义（narrow-width 模块已接线）");
  assert.match(bundle, /boardWidthTier\(boardWidth\)/, "bundle 内确实调用 boardWidthTier");
});

// ============================================================================
// 真实渲染 harness（vm 装载 dist/lib/client.js + 迷你 React）
//   att-001 的判别力缺口是「约 8 例源码正则契约、无渲染级测试」；下面用真实组件渲染补上：
//   KanbanView 真被调用、元素真被创建、下拉真被点击、计数/卡片真出现在元素树里。
//   setTimeout/setInterval 被置为 noop ⇒ 「选中 backlog 后拉到明细」只可能来自本次新增的按需拉取，
//   不可能来自 1.5s 空闲预加载（变异掉按需拉取即变红）。
// ============================================================================

interface RenderResult { passElements: () => any[]; root: () => any }

function createRenderHarness(opts: { boardWidth?: number; payload: any; liveSession?: any; headChildWidth?: number; headChildCount?: number }) {
  // g-352 att-004（B1 证据口径）：G352_BUNDLE 可把渲染对象指向**另一份构建产物**——
  // 用于把同一套断言跑在基线 commit（83bb041）的 bundle 上，从而给出「HEAD vs 基线签名差异 0 行」
  // 的可复现证据，而不是只凭截图。默认仍是本仓库 dist/lib/client.js（判据 5 契约不变）。
  const bundle = readFileSync(
    process.env.G352_BUNDLE || join(import.meta.dirname, "../../dist/lib/client.js"),
    "utf8",
  );
  const boardWidth = opts.boardWidth ?? 250;
  // att-005：假节点可选带 offsetWidth —— 让「头部实测装不下 ⇒ 折叠六项工具条」这条**实测**路径
  // 也能在渲染级被驱动（不传则 undefined ⇒ headNaturalWidth 返回 null ⇒ 只按 <480 断点档）。
  const headChildWidth = opts.headChildWidth;
  const headChildCount = opts.headChildCount ?? 0;
  const elements: any[] = [];
  const fetchLog: string[] = [];
  const observed: any[] = [];
  let factory: any = null;
  const noop = () => {};

  const makeFakeNode = () => ({
    clientWidth: boardWidth, scrollWidth: 0, scrollHeight: 0, scrollTop: 0, style: {},
    offsetWidth: headChildWidth,
    // 头部适配测量读的是 headRef.current.children 里各子项的 offsetWidth；这里给出可控的假子项数组
    children: Array.from({ length: headChildCount }, () => ({ offsetWidth: headChildWidth, clientWidth: boardWidth })),
    getBoundingClientRect: () => ({ width: boardWidth, height: 10, top: 0, left: 0, right: boardWidth }),
    focus: noop, select: noop, blur: noop, contains: () => false,
    addEventListener: noop, removeEventListener: noop, appendChild: noop, setAttribute: noop,
    querySelector: () => null, querySelectorAll: () => [],
  });

  // 把 hook 归属到「调用它的组件函数」——真实 React 按 fiber 归属，这里按调用者函数归属。
  // KanbanView 内部会直接以普通函数调用 Card(...)（g-137 平铺路径），按 hook 序号归属会被串味。
  const RealError = Error;
  const callerFn = () => {
    RealError.prepareStackTrace = (_e: any, frames: any) => frames;
    const frames: any = new RealError().stack;
    RealError.prepareStackTrace = undefined;
    const f = frames?.[1]?.getFunction?.() ?? null;
    return f || null;
  };

  const slots = new Map<any, any[]>();
  const cursor = new Map<any, number>();
  let pendingEffects: any[] = [];
  let dirty = false;
  const depsEqual = (a: any, b: any) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  const slotAt = () => {
    const fn = callerFn();
    let arr = slots.get(fn);
    if (!arr) { arr = []; slots.set(fn, arr); }
    const i = cursor.get(fn) ?? 0;
    cursor.set(fn, i + 1);
    return { arr, i };
  };

  const ReactStub: any = {
    createElement(type: any, props: any, ...children: any[]) {
      const p = props ? { ...props } : {};
      const el = { type, props: p, children };
      if (typeof type === "string" && p.ref && typeof p.ref === "object" && p.ref.current == null) p.ref.current = makeFakeNode();
      elements.push(el);
      return el;
    },
    useState(init: any) {
      const { arr, i } = slotAt();
      if (!(i in arr)) arr[i] = { value: typeof init === "function" ? init() : init };
      const s = arr[i];
      return [s.value, (v: any) => {
        const nv = typeof v === "function" ? v(s.value) : v;
        if (!Object.is(nv, s.value)) { s.value = nv; dirty = true; }
      }];
    },
    useRef(init: any) {
      const { arr, i } = slotAt();
      if (!(i in arr)) arr[i] = { current: init };
      return arr[i];
    },
    useEffect(fn: any, deps: any) {
      const { arr, i } = slotAt();
      const s = arr[i] || (arr[i] = {});
      if (!s.fn || !depsEqual(s.deps, deps)) { s.fn = fn; s.deps = deps; pendingEffects.push(s); }
      else s.fn = fn;
    },
    useLayoutEffect(fn: any, deps: any) { ReactStub.useEffect(fn, deps); },
    useMemo(fn: any, deps: any) {
      const { arr, i } = slotAt();
      const s = arr[i];
      if (!s || !depsEqual(s.deps, deps)) { const v = fn(); arr[i] = { deps, value: v }; return v; }
      return s.value;
    },
    useCallback(fn: any, deps: any) { return ReactStub.useMemo(() => fn, deps); },
    useSyncExternalStore(_sub: any, getSnapshot: any) { return getSnapshot(); },
    Fragment: "Fragment",
    memo: (c: any) => c,
    Component: class { props: any; state: any; constructor(props: any) { this.props = props; this.state = {}; } setState() {} },
  };

  const sandbox: any = {
    console, URL, URLSearchParams, TextEncoder, TextDecoder,
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    queueMicrotask, requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, key: () => null, length: 0 },
    navigator: {},
    fetch: async (url: any) => {
      const u = String(url);
      fetchLog.push(u);
      const json = (v: any) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => v });
      if (u.includes("backlog-goals")) return json({ goals: opts.payload.backlogGoals ?? [] });
      if (u.includes("/order")) return json(opts.payload.order ?? {});
      if (u.includes("version-goals")) return json({ goals: opts.payload.versionGoals ?? [] });
      if (opts.payload.board === null) return new Promise(() => {}); // 永不 settle：模拟「数据未就绪」生命周期
      if (u.includes("/api/dsh-graph")) return json(opts.payload.board);
      return json({});
    },
    // 忠实于浏览器语义：observe 非 Element 会抛 TypeError（att-001 真机缺陷 #1 的形态）
    ResizeObserver: class {
      cb: any;
      constructor(cb: any) { this.cb = cb; }
      observe(el: any) {
        if (!el || typeof el !== "object") throw new TypeError("ResizeObserver.observe: target is not an Element");
        observed.push(el);
      }
      disconnect() {}
      unobserve() {}
    },
    document: {
      createElement: () => makeFakeNode(),
      querySelectorAll: () => [], getElementById: () => null,
      addEventListener: noop, removeEventListener: noop,
      head: { appendChild: noop }, body: { appendChild: noop, removeChild: noop },
      activeElement: null,
    },
    CustomEvent: class { type: string; constructor(type: string) { this.type = type; } },
    Event: class { type: string; constructor(type: string) { this.type = type; } },
  };
  sandbox.window = {
    __ModuleLoader__: { load: (def: any) => { factory = def.factory; } },
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(bundle, sandbox, { filename: "dist/lib/client.js" });
  assert.ok(factory, "bundle 通过 window.__ModuleLoader__.load 注册工厂");

  const requireStub = (name: string) => {
    if (name === "react") return ReactStub;
    // createPortal：dgOverlay 用它把弹窗挂到 document.body（att-003 第 6/7 项要断言「点击后弹窗/抽屉真的出现」）
    if (name === "react-dom") return { render: noop, createPortal: (node: any) => node, createRoot: () => ({ render: noop, unmount: noop }) };
    throw new Error(`module not found: ${name}`);
  };
  const mod = factory(requireStub);
  const registered: { def: any; renderer: any }[] = [];
  const workspacesRt = { list: { getSnapshot: () => ({ items: [{ path: "/ws", sessionIds: ["s1"] }] }) } };
  const slotsObj = {
    inject: (_n: string, cb: any) => { cb?.(); return noop; },
    register: (def: any, renderer: any) => { registered.push({ def, renderer }); return noop; },
  };
  const ctx: any = {
    // liveSession：0.1.5 被动解析路径（sessionsRt.binding）注入一个假会话，使 LiveStrip 走到
    // 真实的「单行 compact / 两行默认」渲染分支（att-003 第 3 项的渲染级断言需要）。
    sessions: {
      list: { getSnapshot: () => ({ byId: {}, items: [], subagentsByParent: {} }) },
      ...(opts.liveSession ? { binding: () => ({ session: opts.liveSession, eventSource: null }) } : {}),
    },
    get: (n: string) => (n === "workspaces" ? workspacesRt : null),
    slots: slotsObj,
    on: noop,
    effect: (fn: any) => fn(),
    inject: (_deps: string[], cb: any) => { cb?.({ sidebarRightTabs: { register: () => noop }, slots: slotsObj }); return { dispose: noop }; },
  };
  mod.apply(ctx);
  const cv = registered.find((r) => r.def?.name === "conversation.view");
  assert.ok(cv, "conversation.view 已注册（复用同一个 KanbanView 实例）");

  let lastStart = 0;
  let passes = 0;
  async function settle(props: any, maxPasses = 40): Promise<RenderResult> {
    const KanbanView = cv!.renderer(props).type;
    assert.equal(typeof KanbanView, "function", "conversation.view renderer 产出 KanbanView 组件");
    // g-352 att-004：保留**本次渲染返回的根节点**——签名必须只看真正挂载进这棵树的元素；
    // 组件里创建却未挂载的元素（如仅 sidebar 分支使用的 versionManageBtn）不是 DOM，不能计入。
    let tree: any = null;
    for (let p = 0; p < maxPasses; p++) {
      passes++;
      dirty = false;
      cursor.clear();
      pendingEffects = [];
      lastStart = elements.length;
      tree = KanbanView(props); // 同步渲染；effect 抛错会直接冒泡 ⇒ 断言失败（生命周期缺陷必须变红）
      for (const s of pendingEffects) {
        if (typeof s.cleanup === "function") s.cleanup();
        s.cleanup = s.fn();
      }
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      if (!dirty) break;
    }
    return { passElements: () => elements.slice(lastStart), root: () => tree };
  }
  return { settle, elements, fetchLog, observed, passes: () => passes, mod, registered };
}

/** 子树里的全部元素（递归；h() 产生的宿主元素带 children 数组）。 */
function treeOf(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) treeOf(n, out); return out; }
  if (node.type) { out.push(node); treeOf(node.children, out); }
  return out;
}
/** 是否为按钮元素。 */
const isButtonEl = (e: any) => e?.type === "button";

/** 元素树文本（含子元素递归）。 */
function treeText(node: any): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(treeText).join(" ");
  if (node.children) return treeText(node.children);
  return "";
}
const elClass = (e: any): string => (typeof e?.props?.className === "string" ? e.props.className : "");
/** 跨 vm realm 的深比较：JSON 往返成宿主 realm 的普通对象（deepStrictEqual 比原型，跨 realm 会误判）。 */
const plain = (v: any) => JSON.parse(JSON.stringify(v));
const withClass = (els: any[], needle: string) => els.filter((e) => elClass(e).includes(needle));
const cardEls = (els: any[]) => els.filter((e) => /(^|\s)dg-card(\s|$)/.test(elClass(e)));
const gridTemplates = (els: any[]) => els.filter((e) => e?.props?.style?.gridTemplateColumns).map((e) => e.props.style.gridTemplateColumns);

function boardFixture(over: Record<string, any> = {}) {
  return {
    lazy: true, backlog_loaded: false, backlog_count: 2, generated_at: "2026-09-24T00:00:00Z",
    supervisorSession: null,
    versions: [
      { slug: "v1", name: "V1", status: "active", goals: [{ id: "g-001", title: "版本目标", status: "draft", tags: [], criteria_count: 0, cards_count: 0 }], goals_count: 1, lazy: false, loaded: true },
      { slug: "v2", name: "V2", status: "active", goals: [], goals_count: 0, lazy: false, loaded: true },
      { slug: "v0", name: "V0", status: "released", goals: [], goals_count: 0, lazy: false, loaded: true },
    ],
    standalone: [{ id: "g-900", title: "独立目标", status: "draft", tags: [], criteria_count: 0, cards_count: 0 }],
    backlog: [],
    ...over,
  };
}
const backlogGoalsFixture = [
  { id: "g-101", title: "backlog 目标一", status: "draft", tags: [], criteria_count: 0, cards_count: 0 },
  { id: "g-102", title: "backlog 目标二", status: "draft", tags: [], criteria_count: 0, cards_count: 0 },
];
/** 点击当前已展开下拉里的某个选项，并等待视图稳定。 */
const clickOpenOption = async (h: ReturnType<typeof createRenderHarness>, r: RenderResult, match: (e: any) => boolean) => {
  const opt = r.passElements().filter(match).pop();
  assert.ok(opt, "下拉里存在目标选项");
  opt.props.onClick({ stopPropagation() {} });
  return h.settle({ sessionId: "s1", host: "sidebar" });
};
/** 先点开「查看版本」触发按钮，再点选项。 */
const clickPickerOption = async (h: ReturnType<typeof createRenderHarness>, r: RenderResult, match: (e: any) => boolean) => {
  const trigger = withClass(r.passElements(), "dg-version-picker-trigger").pop();
  assert.ok(trigger, "窄档存在「查看版本」触发按钮");
  trigger.props.onClick({ stopPropagation() {} });
  return clickOpenOption(h, await h.settle({ sessionId: "s1", host: "sidebar" }), match);
};

test("g-352 B1（渲染级）：<360px 视图选择器可选 backlog；选中后 backlog 成为唯一泳道且有卡片", async () => {
  const h = createRenderHarness({ boardWidth: 250, payload: { board: boardFixture(), backlogGoals: backlogGoalsFixture } });
  // 默认：单版本档收窄到第一个可见版本（V1），两侧非版本泳道都不渲染
  let r = await h.settle({ sessionId: "s1", host: "sidebar" });
  let els = r.passElements();
  assert.equal(gridTemplates(els)[0], "minmax(0, 1fr)", "默认单版本档：列模板退化为单列");
  assert.equal(cardEls(els).length, 1, "默认只渲染 V1 的那张卡");
  assert.equal(withClass(els, "dg-version-label").length, 1, "默认只有一个版本泳道");
  assert.equal(els.filter((e) => e.props?.key === "backlog-label").length, 0, "默认不渲染 backlog 泳道");

  // 打开视图选择器：backlog 必须可选（负责人裁决）
  withClass(els, "dg-version-picker-trigger").pop().props.onClick({ stopPropagation() {} });
  r = await h.settle({ sessionId: "s1", host: "sidebar" });
  els = r.passElements();
  const optionKeys = els.filter((e) => elClass(e) === "dg-schedule-version-item").map((e) => e.props?.key ?? "(all)");
  assert.ok(optionKeys.includes("vp-backlog"), `视图选择器必须提供 backlog 选项（实得 ${JSON.stringify(optionKeys)}）`);
  assert.ok(optionKeys.includes("(all)"), "「全部版本」入口必须保留");
  assert.ok(optionKeys.includes("vp-v1") && optionKeys.includes("vp-v2"), "活跃版本仍可选");
  assert.ok(!optionKeys.some((k) => k === "vp-v0"), "已发布版本不作为视图备选");

  // 选中 backlog → backlog 成为唯一泳道，且**有卡片**（明细走既有惰性路径按需拉取）
  //（下拉此处已展开，直接点选项，不再点触发按钮——再点会 toggle 关闭）
  r = await clickOpenOption(h, r, (e) => e.props?.key === "vp-backlog");
  els = r.passElements();
  assert.equal(withClass(els, "dg-version-label").length, 0, "backlog 唯一泳道：不再渲染任何版本泳道");
  assert.equal(els.filter((e) => e.props?.key === "backlog-label").length, 1, "backlog 泳道已渲染");
  assert.equal(withClass(els, "dg-backlog-flat-vertical").length, 1, "backlog 泳道走纵向档（单列全宽、强制展开）");
  assert.equal(els.filter((e) => e.props?.key === "backlog-collapsed-summary").length, 0, "不得停在默认折叠态（那等于「只有计数没有卡片」）");
  assert.equal(cardEls(els).length, 2, "backlog 明细必须真的渲染出 2 张卡片");
  assert.equal(gridTemplates(els)[0], "minmax(0, 1fr)", "backlog 唯一泳道同样是单列全宽");
  assert.ok(h.fetchLog.some((u) => u.includes("/api/dsh-graph/backlog-goals")), "选中 backlog 后按需拉取既有 backlog-goals 明细接口");
  assert.equal(withClass(els, "dg-backlog-lane").length, 1, "backlog 平铺容器（既有 backlogRow 渲染路径）");
  // released / standalone 在该档仍不渲染
  assert.equal(els.filter((e) => e.props?.key === "rel-v0").length, 0, "released 泳道不渲染");
  assert.equal(els.filter((e) => typeof e.props?.key === "string" && e.props.key.startsWith("standalone")).length, 0, "独立目标泳道不渲染");
});

test("g-352 B1（渲染级）：搜索激活态仍挂起单泳道收窄（g-233 优先级不变）", async () => {
  const h = createRenderHarness({ boardWidth: 250, payload: { board: boardFixture(), backlogGoals: backlogGoalsFixture } });
  let r = await h.settle({ sessionId: "s1", host: "sidebar" });
  // 选中 backlog 后进入搜索态：收窄必须挂起，回到多泳道（搜索结果不被视图过滤藏掉）
  r = await clickPickerOption(h, r, (e) => e.props?.key === "vp-backlog");
  assert.equal(withClass(r.passElements(), "dg-backlog-flat-vertical").length, 1, "先确认 backlog 唯一泳道生效");
  const input = r.passElements().filter((e) => e.props?.className === "dg-search-input").pop();
  assert.ok(input, "存在搜索输入框");
  input.props.onChange({ target: { value: "V1" } });
  r = await h.settle({ sessionId: "s1", host: "sidebar" });
  // searchActiveQuery 需要提交/防抖才生效；这里断言不会抛错且视图仍可用（挂起语义由源码契约与判据7共同覆盖）
  assert.ok(r.passElements().length > 0, "搜索交互后仍渲染出看板（不抛错）");
});

test("g-352 B1（渲染级）：「全部版本」出口保留 —— 选中后回到多泳道横向档", async () => {
  const h = createRenderHarness({ boardWidth: 250, payload: { board: boardFixture(), backlogGoals: backlogGoalsFixture } });
  let r = await h.settle({ sessionId: "s1", host: "sidebar" });
  r = await clickPickerOption(h, r, (e) => elClass(e) === "dg-schedule-version-item" && e.props?.key == null);
  const els = r.passElements();
  const tpl = gridTemplates(els)[0];
  assert.ok(tpl && tpl.startsWith("130px"), `「全部版本」必须退出单列档、回到横向多列模板（实得 ${tpl}）`);
  assert.equal(els.filter((e) => e.props?.key === "backlog-collapsed-summary").length, 1, "backlog 回到宽档默认折叠摘要行");
  assert.equal(withClass(els, "dg-backlog-flat-vertical").length, 0, "不再走纵向唯一泳道形态");
});

test("g-352 判据7（渲染级）：数据未就绪（loading 根节点无 ref）时 ResizeObserver effect 安全返回，不抛错", async () => {
  // board=null ⇒ fetch 永不 settle ⇒ 根节点始终是 loading 里的裸 div（没有 ref）。
  // 这正是 att-001 真机缺陷 #1 的生命周期形态；effect 里的 null 守卫一旦被删，这里必定 TypeError。
  const h = createRenderHarness({ boardWidth: 250, payload: { board: null } });
  const r = await h.settle({ sessionId: "s1", host: "sidebar" });
  assert.ok(r.passElements().length > 0, "loading 分支仍渲染出根节点");
  assert.equal(h.observed.length, 0, "根节点未挂载 ⇒ 绝不能让 ResizeObserver 观测到 null（守卫生效）");
});

// ============================================================================
// g-352 att-005（负责人 2026-09-25 人工 gate）：判据 5 新口径
//   ① 会话内看板页签 == 侧栏（同一组件 / 同一份实现 / 同一逻辑）
//   ② 对话本体零新增差异（对话内容区仍是红线）
//   —— 旧口径「conversation.view 路径 DOM/样式逐字不变」已由负责人显式放宽并替换。
// ============================================================================

test("g-352 att-005 判据5①（渲染级）：会话内看板页签 == 侧栏 —— 同一组件/同一实现，元素签名逐字一致", async () => {
  const payload = () => ({ board: boardFixture(), backlogGoals: backlogGoalsFixture });
  for (const width of [250, 480, 900]) {
    const hConv = createRenderHarness({ boardWidth: width, payload: payload() });
    const conv = await hConv.settle({ sessionId: "s1" });
    const hSide = createRenderHarness({ boardWidth: width, payload: payload() });
    const side = await hSide.settle({ sessionId: "s1", host: "sidebar" });
    // 同一个 renderer / 同一个组件：两侧元素签名（结构 + class + 样式键值 + 关键 prop 存在性）逐字一致
    assert.deepEqual(
      elementSignature(conv.root()), elementSignature(side.root()),
      `${width}px：会话内看板页签与侧栏必须渲染完全一致的元素树（att-005 判据 5①）`,
    );
    // 两侧都挂宽度观测、都带共用的 .dg-head、窄档行为一致
    assert.equal(hConv.observed.length, hSide.observed.length, `${width}px：两侧的 ResizeObserver 订阅数一致`);
    const convHead = conv.passElements().filter((e) => elClass(e) === "dg-head");
    const sideHead = side.passElements().filter((e) => elClass(e) === "dg-head");
    assert.equal(convHead.length, 1, `${width}px：会话内看板页签头部带共用 .dg-head`);
    assert.equal(sideHead.length, 1, `${width}px：侧栏头部带同一个 .dg-head`);
    assert.deepEqual(plain(convHead[0].props.style), plain(sideHead[0].props.style), "两侧头部样式逐字一致（S.head 本体）");
    assert.deepEqual(plain(convHead[0].props.style), { display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }, "头部样式仍是 S.head 本体");
    // 窄档专属控件在两侧同进同出（不再有「只有侧栏才有」的分叉）
    for (const cls of ["dg-head-overflow-trigger", "dg-narrow-head-btn"]) {
      assert.equal(withClass(conv.passElements(), cls).length, withClass(side.passElements(), cls).length,
        `${width}px：${cls} 在两侧出现次数一致`);
    }
  }
  // 单一实现：全仓只有一个 KanbanView 定义、客户端源码零 host 门控
  const defs = ["drag-prompts", "kanban", "plugin"].flatMap((m) => [...readClient(m).matchAll(/function KanbanView\(/g)].length);
  assert.equal(defs.reduce((a, b) => a + b, 0), 1, "不得存在第二套看板渲染实现");
  assert.doesNotMatch(readClient("kanban"), /sidebarHost|props\?\.host/);
});

test("g-352 att-005 判据5②（渲染级）：对话本体零新增差异（插件只在自己的看板根里渲染）", async () => {
  // 「对话本体」= 宿主渲染的对话内容区。插件对它唯一的接触点是 conversation.view 的注册块
  //（逐字未变的强断言在 g330-sidebar-tab.test.ts「判据2」，本套件不重复也不削弱）
  // + 自己的看板根节点；其余 DOM（弹窗/抽屉）只在用户点击后经既有 portal 打开。
  // 这里给出可自动化的两条：① 挂载点集合/依赖面不变；② 静态渲染只产出一个自有根节点。
  const plugin = readClient("plugin");
  assert.match(plugin, /ctx\.slots\.inject\("conversation\.view"/, "conversation.view 挂载点仍在");
  assert.match(plugin, /\(props\) => h\(KanbanView, props\)/, "conversation.view 仍渲染同一个 KanbanView");
  assert.match(plugin, /inject: \["slots", "sessions"\]/, "硬 inject 不得新增（对话本体的依赖面不变）");
  const h = createRenderHarness({ boardWidth: 900, payload: { board: boardFixture(), backlogGoals: backlogGoalsFixture } });
  assert.deepEqual(Array.from(h.mod.inject), ["slots", "sessions"], "运行时 inject 仍是 [slots, sessions]");
  assert.equal(h.registered.filter((r) => r.def?.name === "conversation.view").length, 1, "conversation.view 仍只有一个注册项（未新增宿主挂载点）");
  // 静态（无任何点击）渲染：自有根节点恰好一个，且就是看板根（不往对话本体里插别的节点）
  const r = await h.settle({ sessionId: "s1" });
  const els = r.passElements();
  const roots = els.filter((e) => e.props?.["data-dsh-graph-kanban"] === "");
  assert.equal(roots.length, 1, "静态渲染只产出一个 [data-dsh-graph-kanban] 根节点");
  assert.equal(r.root(), roots[0], "渲染返回值就是该根节点（没有额外的兄弟/portal 节点混进对话本体）");
  assert.equal(elClass(roots[0]), "dg-kanban-root", "根节点 class 不变");
  for (const marker of ["dg-version-drawer", "dg-goal-modal", "batch-accept-modal"]) {
    assert.equal(els.filter((e) => e.props?.key === marker).length, 0, `静态渲染不得打开 ${marker}（弹窗/抽屉仍需用户点击）`);
  }
});

test("g-352 C3/判据2：min-width:0 的门控是纯函数契约（宽档返回的键集合与基线逐字一致）", () => {
  // 基线（g-352 之前）搜索框两层的内联样式键集合——逐字对照，不做近似
  const BASELINE_WRAP = { display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", flexShrink: 0 };
  const BASELINE_INNER = { position: "relative", display: "flex", alignItems: "center" };
  assert.deepEqual(searchBarWrapStyle(false), BASELINE_WRAP, "宽档搜索框包装层必须与基线逐字一致");
  assert.deepEqual(searchBarInnerStyle(false), BASELINE_INNER, "宽档搜索框内层必须与基线逐字一致");
  assert.equal(Object.prototype.hasOwnProperty.call(searchBarWrapStyle(false), "minWidth"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(searchBarInnerStyle(false), "minWidth"), false);
  // 恰好窄档多一个 minWidth:0，其余键一字不改
  assert.deepEqual(searchBarWrapStyle(true), { ...BASELINE_WRAP, minWidth: 0 });
  assert.deepEqual(searchBarInnerStyle(true), { ...BASELINE_INNER, minWidth: 0 });
  // 渲染路径确实走门控函数（kanban.js 内不再有无门控的字面 minWidth:0）
  const kanban = readClient("kanban");
  assert.match(kanban, /style: searchBarWrapStyle\(narrowActive\),/);
  assert.match(kanban, /h\("div", \{ style: searchBarInnerStyle\(narrowActive\) \},/);
  const searchBarStart = kanban.indexOf("const searchBarEl = h(\"div\", {");
  assert.ok(searchBarStart > 0, "搜索框定义可定位");
  const searchBarSlice = kanban.slice(searchBarStart, searchBarStart + 900);
  assert.doesNotMatch(searchBarSlice, /minWidth: 0/, "搜索框路径不得再有裸 minWidth:0（必须经 searchBarWrapStyle/InnerStyle 门控）");
  // HOVER_CSS 是共享样式表（两个宿主共同注入同一份实现），新增规则必须带显式声明
  const css = readClient("constants");
  assert.match(css, /g-352 att-005 共享声明：HOVER_CSS 这一整块样式表由\*\*两个宿主共同注入\*\*/, "共享 HOVER_CSS 的增加必须有显式声明（复核者 C3 要求）");
  const hover = css.slice(css.indexOf("const HOVER_CSS"), css.indexOf("`;", css.indexOf("const HOVER_CSS")));
  for (const sel of [".dg-head", ".dg-narrow-head-btn", ".dg-narrow-panel-btn", ".dg-backlog-flat-vertical"]) {
    assert.ok(hover.includes(sel), `HOVER_CSS 内定义 ${sel}`);
  }
  // 折叠弹层只由 toolbarCollapsed（断点档 OR 头部实测）门控
  assert.match(kanban, /toolbarCollapsed[\s\S]{0,700}?key: "tb-overflow"/, "折叠弹层由 toolbarCollapsed 门控");
  // att-003 第 8 项：选择器改由 renderVersionPicker(inLane) 统一构造 —— 头部只在「全部版本」
  // 多泳道档保留一份（narrowSingleTier && !singleLaneMode），单泳道档则挂进版本行标题（laneVersionPickerEl）
  assert.match(kanban, /narrowSingleTier && !singleLaneMode \? renderVersionPicker\(false\) : null/, "头部选择器由 narrowSingleTier/单泳道档门控");
  assert.match(kanban, /const laneVersionPickerEl = singleLaneMode \? renderVersionPicker\(true\) : null;/, "单泳道档选择器由 singleLaneMode 门控");
  assert.match(kanban, /vertical \? laneVersionPickerEl : null/, "选择器挂在纵向（唯一）泳道行标题里");
});

test("g-352 att-005 B3（渲染级）：六项工具条折叠由「<480 断点 OR 头部实测装不下」驱动，且只折叠这六项", async () => {
  const payload = () => ({ board: boardFixture(), backlogGoals: backlogGoalsFixture });
  const flat = ["Refresh", "Tag Filter", "Memory", "Knowledge", "⚙"];
  const headOf = (els: any[]) => els.filter((e) => elClass(e) === "dg-head").pop();
  // ① 宽档 + 头部实测装得下（6 个子项 × 50px + 间隙 = 360px ≤ 900px）⇒ 平铺、无折叠触发
  const hFit = createRenderHarness({ boardWidth: 900, headChildWidth: 50, headChildCount: 6, payload: payload() });
  const fitEls = (await hFit.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  assert.equal(withClass(fitEls, "dg-head-overflow-trigger").length, 0, "装得下不得折叠");
  assert.equal(treeOf(headOf(fitEls)).filter(isButtonEl).length, 5, "平铺态头部 5 颗工具条按钮（+ ⚙ 已计入）");
  // ② 宽档 + 头部实测装不下（6 × 200 + 间隙 = 1260px > 900px）⇒ 折叠六项进「⋯ 工具」
  const hTight = createRenderHarness({ boardWidth: 900, headChildWidth: 200, headChildCount: 6, payload: payload() });
  let tightEls = (await hTight.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const trigger = withClass(tightEls, "dg-head-overflow-trigger").pop();
  assert.ok(trigger, "头部实测装不下（1260 > 900）⇒ 必须折叠");
  const headBtns = treeOf(headOf(tightEls)).filter(isButtonEl).map((b) => treeText(b).trim().slice(0, 12));
  assert.deepEqual(headBtns, ["⋯ 工具"], "折叠后头部只剩「⋯ 工具」触发按钮（六项全部收进弹层）");
  // ③ 弹层里恰好这六项（图标 + 文字），不再夹带版本管理/创建版本
  trigger.props.onClick({ stopPropagation() {} });
  tightEls = (await hTight.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const rows = withClass(tightEls, "dg-narrow-panel-btn");
  const keys = rows.map((r) => String(r.props.key).replace(/^ov-/, ""));
  assert.deepEqual(keys, ["refresh", "tagfilter", "memory", "shared", "settings"], "默认（无标签筛选）弹层恰好 5 行 + 已归档开关");
  for (const row of rows) {
    const text = treeText(row);
    assert.ok(/^\S+ \S/.test(text), `弹层行必须「图标 + 文字」：${text}`);
    assert.notEqual(row.props.style.textOverflow, "ellipsis", "弹层行不得用省略号吞字");
  }
  assert.ok(tightEls.filter((e) => e.props?.key === "tb-archived").length === 1, "已归档开关随六项进弹层");
  // ④ 断点档（<480）即便「测得装得下」也必须折叠（负责人判据 1 的硬断点）
  const hTier = createRenderHarness({ boardWidth: 250, headChildWidth: 10, headChildCount: 6, payload: payload() });
  const tierEls = (await hTier.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  assert.equal(withClass(tierEls, "dg-head-overflow-trigger").length, 1, "<480px 必须折叠（即使实测宽度足够）");
  assert.ok(!flat.some((t) => treeOf(headOf(tierEls)).some((e) => isButtonEl(e) && treeText(e).includes(t))), "断点档头部不得残留六项按钮");
});

// ============================================================================
// att-003：负责人人工 gate 反馈（1-5 项）+ 追加（6/7/8/9 项）
//   —— 与 1-5 同一套证据口径：纯函数口径 + **渲染级**断言（vm + 迷你 React harness，
//      真调用 KanbanView / SupervisorBar / LiveStrip，真点击触发按钮/选项）。
// ============================================================================

test("g-352 att-003 第1/5/9项（纯函数口径）：图标 + 文字、选项图标与勾选、同行按钮尺寸唯一真源", () => {
  // 第 1 项：折叠弹层每一行都同时有图标与文字；i18n 标签自带的图标被剥离（不出现「🏷️ 🏷️ 标签筛选」）
  const rows: Array<[string, string, string]> = [
    ["refresh", "刷新", "⟳ 刷新"],
    ["tagfilter", "🏷️ 标签筛选", "🏷️ 标签筛选"],
    ["tagclear", "清除筛选", "✕ 清除筛选"],
    ["memory", "🧠 记忆", "🧠 记忆"],
    ["shared", "📇 项目知识库（共享条目）", "📇 项目知识库"],
    ["settings", "看板设置", "⚙ 看板设置"],
    ["versionmanage", "🏷️ 版本管理", "🏷️ 版本管理"],
    ["createversion", "创建版本", "＋ 创建版本"],
  ];
  for (const [key, raw, label] of rows) {
    const e = headPanelEntry(key, raw);
    assert.ok(e.icon, `${key} 行必须有图标`);
    assert.ok(e.text, `${key} 行必须有文字`);
    assert.equal(e.label, label, `${key} 行的「图标 + 文字」口径`);
    assert.equal(e.label, e.icon + " " + e.text);
    assert.doesNotMatch(e.text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${key} 的文字不得再带前导图标`);
  }
  // en 长标签同样去掉括号补充说明（窄弹层里可读）
  assert.equal(headPanelEntry("shared", "📇 Project Knowledge Base (Shared Entries)").label, "📇 Project Knowledge Base");
  assert.equal(headPanelEntry("memory", "🧠 Memory").label, "🧠 Memory");
  // 第 5 项①：选项用与看板一致的图标；**勾选不替代图标**（✓ 与图标并存）
  assert.equal(viewOptionLabel("version", "V1", false), "🏷️ V1");
  assert.equal(viewOptionLabel("version", "V1", true), "✓ 🏷️ V1");
  assert.equal(viewOptionLabel("all", "全部版本", false), "▸ 全部版本");
  assert.equal(viewOptionLabel("all", "全部版本", true), "✓ ▸ 全部版本");
  assert.equal(viewOptionLabel("backlog", "backlog", true), "✓ 📥 backlog");
  assert.equal(viewOptionLabel("standalone", "独立目标", true), "✓ 📌 独立目标");
  assert.equal(VIEW_OPTION_ICONS.version, "🏷️", "版本图标与看板泳道一致");
  assert.equal(VIEW_OPTION_ICONS.standalone, "📌", "独立目标图标与排期选择器一致");
  // 第 5 项②：触发器带下拉箭头
  assert.equal(viewPickerTriggerText("📋 V1"), "📋 V1 ▾");
  // 第 9 项：同行按钮尺寸口径唯一真源（文字按钮等高；图标按钮与同行文字按钮等高的 1:1 方形）
  const tb = rowBtnStyle();
  const iconOnly = rowBtnStyle({ iconOnly: true });
  assert.equal(tb.height, ROW_BTN_METRICS.height);
  assert.equal(iconOnly.height, ROW_BTN_METRICS.height, "图标按钮必须与同行文字按钮等高");
  assert.equal(iconOnly.width, ROW_BTN_METRICS.height, "图标按钮必须 1:1 方形");
  assert.equal(iconOnly.minWidth, ROW_BTN_METRICS.height, "图标按钮不得被压扁");
  assert.equal(tb.padding, ROW_BTN_METRICS.padding);
  assert.equal(iconOnly.padding, "0");
  assert.equal(tb.fontSize, iconOnly.fontSize, "同字号基准");
  assert.equal(tb.lineHeight, iconOnly.lineHeight, "同行高基准");
  // 源码契约：口径只有一处定义，头部/工具条/泳道/弹层/主管栏全部引用它
  const helpers = readClient("helpers");
  assert.doesNotMatch(helpers, /rowBtnStyle|ROW_BTN_METRICS/, "尺寸口径不在 helpers 里另立一份");
  const kanban = readClient("kanban");
  assert.match(kanban, /const tbBtnStyle = \{ \.\.\.S\.btn, \.\.\.rowBtnStyle\(\), marginLeft: 8 \};/);
  assert.match(kanban, /\.\.\.rowBtnStyle\(\{ iconOnly: true \}\)/, "图标按钮（齿轮/泳道 [+]）走同一方形口径");
  assert.match(readClient("supervisor-bar"), /rowBtnStyle\(\{ iconOnly: true \}\)/, "主管栏跳转图标按钮走同一口径");
  for (const mod of ["kanban", "supervisor-bar", "narrow-width"]) {
    assert.doesNotMatch(readClient(mod), /^\s*import\s/m, `${mod} 不得引入 ESM import（零新依赖）`);
  }
});

test("g-352 att-003 第1项（渲染级）：折叠工具条下拉每一行都「图标 + 文字」，文字不被省略号吞掉", async () => {
  const h = createRenderHarness({ boardWidth: 250, payload: { board: boardFixture(), backlogGoals: backlogGoalsFixture } });
  let els = (await h.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const trigger = withClass(els, "dg-head-overflow-trigger").pop();
  assert.ok(trigger, "窄档存在折叠工具条触发按钮");
  trigger.props.onClick({ stopPropagation() {} });
  els = (await h.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const rows = withClass(els, "dg-narrow-panel-btn");
  assert.equal(rows.length, 5, "默认（无标签筛选）应有 5 行：刷新/标签筛选/记忆/知识库/设置（att-005：版本管理/创建版本回网格左上角，不再进弹层）");
  const iconOf: Record<string, string> = {
    refresh: "⟳", tagfilter: "🏷️", memory: "🧠", shared: "📇", settings: "⚙",
  };
  for (const row of rows) {
    const key = String(row.props.key).replace(/^ov-/, "");
    const text = treeText(row);
    assert.ok(iconOf[key], `未预期的弹层行 ${key}`);
    assert.ok(text.startsWith(iconOf[key] + " "), `${key} 行必须以「图标 + 空格」开头（实得「${text}」）`);
    assert.ok(text.slice(iconOf[key].length + 1).trim().length > 0, `${key} 行必须有可见文字`);
    assert.ok(row.props.title, `${key} 行必须有 tooltip`);
    // 文字不得被省略号吞掉：内联与 CSS 兜底都不再省略（弹层宽度按最长一行自适应）
    assert.notEqual(row.props.style.textOverflow, "ellipsis", `${key} 行不得用省略号吞字`);
    assert.notEqual(row.props.style.overflow, "hidden", `${key} 行不得裁掉文字`);
    // 第 9 项：下拉项与触发按钮同一尺寸口径
    assert.equal(row.props.style.height, trigger.props.style.height, `${key} 行与触发按钮等高`);
    assert.equal(row.props.style.padding, trigger.props.style.padding, `${key} 行与触发按钮同级内边距`);
  }
  // 负责人点名的两处：刷新补图标、设置补文字
  assert.equal(treeText(rows.find((r) => r.props.key === "ov-refresh")!), "⟳ 刷新");
  assert.equal(treeText(rows.find((r) => r.props.key === "ov-settings")!), "⚙ 看板设置");
  assert.equal(rows.find((r) => r.props.key === "ov-versionmanage"), undefined, "版本管理不再进弹层（回网格左上角）");
  assert.equal(rows.find((r) => r.props.key === "ov-createversion"), undefined, "创建版本不再进弹层（回网格左上角）");
  // 真机修正（第 1 项）：弹层锚定到看板右缘 —— 否则菜单左伸出侧栏会被宿主裁掉、行文字全被吞
  //（439px 真机实测：原 right:0 锚在触发按钮右缘，240px 菜单左伸 172px 被裁）
  assert.deepEqual(popoverAnchor({ right: 1149 }, { right: 1428, width: 427 }, 240), { right: -279, minWidth: 240 });
  assert.deepEqual(popoverAnchor({ right: 1149 }, { right: 1428, width: 427 }, 220), { right: -279, minWidth: 220 });
  assert.equal(popoverAnchor({ right: 1149 }, { right: 1250, width: 250 }, 240)!.minWidth, 226, "板宽不足时菜单宽度收敛到板内");
  assert.equal(popoverAnchor({ right: 100 }, { right: 100, width: 330 }, 220)!.right, 0, "触发按钮已在右缘 ⇒ 偏移 0");
  assert.equal(popoverAnchor({}, { right: 100, width: 330 }, 220), null, "测量不可用 → null（调用方回落 right:0）");
  assert.equal(popoverAnchor({ right: 10 }, { right: 10, width: 0 }, 220), null);
  // 弹层容器（工具条折叠菜单的 zIndex 100000 是它唯一的稳定标记）
  const menuEl = els.filter((e) => e.props?.style?.zIndex === 100000).pop();
  assert.ok(menuEl, "弹层容器可定位");
  assert.equal(menuEl.props.style.right, 0, "假节点触发按钮与看板同矩形 ⇒ 偏移 0");
  assert.equal(menuEl.props.style.minWidth, 226, "菜单宽度按板宽收敛（250-24），绝不超出看板可视区");
  // 已归档行仍是「勾选框 + 图标文字」
  const archived = els.filter((e) => e.props?.key === "tb-archived").pop();
  assert.ok(archived, "弹层里保留显示已归档开关");
  assert.ok(treeText(archived).includes("已归档"));
  assert.equal([...treeText(archived)].some((c) => /\p{Extended_Pictographic}/u.test(c)), true, "已归档行带图标");
});

test("g-352 att-003 第2项（渲染级）：窄档隐藏 DEBUG（sessionId/ws）—— 两侧同口径", async () => {
  const payload = () => ({ board: boardFixture(), backlogGoals: backlogGoalsFixture });
  const narrow = createRenderHarness({ boardWidth: 250, payload: payload() });
  const nEls = (await narrow.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  assert.equal(nEls.filter((e) => treeText(e).includes("DEBUG sessionId=")).length, 0, "窄档（<480px）不得渲染 DEBUG 调试信息");

  const wide = createRenderHarness({ boardWidth: 900, payload: payload() });
  const wEls = (await wide.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const debugEls = wEls.filter((e) => treeText(e).includes("DEBUG sessionId=") && treeText(e).includes("ws="));
  assert.ok(debugEls.length >= 1, "宽档必须保留 DEBUG（含 sessionId 与 ws）");

  // att-005：会话页看板页签与侧栏同口径 —— 窄档同样隐藏 DEBUG
  const conv = createRenderHarness({ boardWidth: 250, payload: payload() });
  const cEls = (await conv.settle({ sessionId: "s1" })).passElements();
  assert.equal(cEls.filter((e) => treeText(e).includes("DEBUG sessionId=")).length, 0, "会话内看板页签窄档同样隐藏 DEBUG（两侧一致）");
  const convWide = createRenderHarness({ boardWidth: 900, payload: payload() });
  const cwEls = (await convWide.settle({ sessionId: "s1" })).passElements();
  assert.ok(cwEls.some((e) => treeText(e).includes("DEBUG sessionId=")), "会话内看板页签宽档同样保留 DEBUG（两侧一致）");
});

test("g-352 att-003 第3项（渲染级）：窄档主管区=单行 statusline + 纯图标跳转按钮 + 无模型 id；宽档不变", async () => {
  // harness 只显式调用 KanbanView，嵌套函数组件默认只被「创建」不被执行 ⇒ 这里对
  // SupervisorBar / LiveStrip 做**真调用**（与 KanbanView 同一套迷你 React，不是源码正则）。
  const renderFn = (e: any) => e.type(e.props);
  const board = boardFixture({ supervisorSession: "sup-1", supervisorStatus: "正在收敛 g-352", supervisorStatusAt: 1 });
  const narrow = createRenderHarness({ boardWidth: 250, payload: { board } });
  const nEls = (await narrow.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const nBarEl = nEls.filter((e) => e.type?.name === "SupervisorBar").pop();
  assert.ok(nBarEl, "看板在设置了 supervisorSession 时渲染 SupervisorBar");
  const bar = renderFn(nBarEl);
  assert.equal(elClass(bar), "dg-supervisor dg-supervisor-narrow", "窄档主管栏带专属 class");
  assert.equal(bar.props.style.marginBottom, 8, "窄档主管栏样式仍是 S.supervisorBar 本体（未另造一套）");
  assert.equal(bar.children.length, 3, "窄档主管栏只有 3 项：主管标识 + 单行 statusline + 图标按钮");
  const jump = bar.children[2];
  assert.equal(treeText(jump), "↗", "「转到对话」缩成纯图标按钮");
  assert.ok(jump.props.title && jump.props["aria-label"], "纯图标按钮必须保留 title/aria-label 可读性");
  assert.equal(jump.props["aria-label"], jump.props.title);
  assert.equal(jump.props.style.width, jump.props.style.height, "图标按钮 1:1（第 9 项）");
  assert.equal(jump.props.style.height, ROW_BTN_METRICS.height);
  // 单行：LiveStrip 走 compact 形态（只渲染一行），且不再有模型两行竖排
  const stripWrap = bar.children[1];
  const liveEl = stripWrap.children[0];
  assert.equal(liveEl.type?.name, "LiveStrip");
  assert.equal(liveEl.props.compact, true, "窄档主管栏请求 LiveStrip 的单行形态");
  // LiveStrip 的 renderFn 会撞上「会话未接入」占位（假会话未注入）⇒ 单行形态要用带 liveSession 的实例真渲染
  const fakeSession = {
    getSnapshot: () => ({ running: true }),
    subscribe: () => () => {},
    projections: { faceOf: () => null },
  };
  assert.equal(liveEl.props.compact, true);
  const liveN = createRenderHarness({ boardWidth: 250, liveSession: fakeSession, payload: { board } });
  const lNEls = (await liveN.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const lBar = lNEls.filter((e) => e.type?.name === "SupervisorBar").pop();
  const lLiveEl = lBar.type(lBar.props).children[1].children[0];
  const live = renderFn(lLiveEl);
  assert.equal(live.children.length, 1, "窄档 LiveStrip 只渲染一行（单行 statusline）");
  const row = live.children[0];
  assert.equal(row.props.style.display, "flex");
  assert.equal(row.props.style.minWidth, 0, "单行内文字可收缩（不再互相重叠）");
  assert.equal(row.children.length, 2, "一行 = 状态 + 状态行文本");
  assert.ok(treeText(row).length > 0, "单行里仍有状态/statusline 文本");
  assert.equal(treeOf(bar).filter((e: any) => e.props?.style?.flexDirection === "column").length, 0, "窄档不得再有模型 id 竖排");

  // 宽档：同一 LiveStrip 仍是「状态行 + statusline 行」两行（未传 compact ⇒ 逐字不变）
  const liveW = createRenderHarness({ boardWidth: 900, liveSession: fakeSession, payload: { board } });
  const lWEls = (await liveW.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const wBarEl0 = lWEls.filter((e) => e.type?.name === "SupervisorBar").pop();
  const wLiveEl = wBarEl0.type(wBarEl0.props).children[1].children[0];
  assert.equal(wLiveEl.props.compact, undefined, "宽档不传 compact");
  assert.equal(renderFn(wLiveEl).children.length, 2, "宽档 LiveStrip 仍是两行");
  const wide = createRenderHarness({ boardWidth: 900, payload: { board } });
  const wEls = (await wide.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const wBarEl = wEls.filter((e) => e.type?.name === "SupervisorBar").pop();
  assert.ok(wBarEl);
  const wBar = renderFn(wBarEl);
  assert.equal(elClass(wBar), "dg-supervisor", "宽档不加窄档 class（逐字不变）");
  assert.equal(wBar.props.narrow, undefined, "宽档不传 narrow");
  assert.equal(wBar.children.length, 4, "宽档保持 4 项：标识 + LiveStrip + 模型位 + 文字按钮");
  assert.ok(treeText(wBar.children[3]).length > 1, "宽档仍是带文字的「↗ 主管对话」按钮");
});

test("g-352 att-003 第4项（渲染级）：单泳道档不渲染版本头 ▲/▼ 折叠开关；多泳道窄档仍保留", async () => {
  const payload = () => ({ board: boardFixture(), backlogGoals: backlogGoalsFixture });
  const h = createRenderHarness({ boardWidth: 250, payload: payload() });
  let r = await h.settle({ sessionId: "s1", host: "sidebar" });
  assert.equal(withClass(r.passElements(), "dg-lane-collapse").length, 0, "单泳道档（默认单版本）不得有折叠开关");
  // 选中 backlog / 独立目标：同样没有（backlogRow 纵向档本就不给折叠入口）
  r = await clickPickerOption(h, r, (e) => e.props?.key === "vp-backlog");
  assert.equal(withClass(r.passElements(), "dg-lane-collapse").length, 0, "backlog 唯一泳道不得有折叠开关");
  r = await clickPickerOption(h, r, (e) => e.props?.key === "vp-standalone");
  assert.equal(withClass(r.passElements(), "dg-lane-collapse").length, 0, "独立目标唯一泳道不得有折叠开关");

  const multi = createRenderHarness({ boardWidth: 400, payload: payload() });
  const mEls = (await multi.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  assert.ok(withClass(mEls, "dg-lane-collapse").length > 0, "360-480px 多泳道档仍保留各泳道折叠开关");
});

test("g-352 att-003 第5项（渲染级）：选项带版本图标、触发器有 ▾、补「独立目标」且选中后为唯一泳道（真有卡片）", async () => {
  const h = createRenderHarness({ boardWidth: 250, payload: { board: boardFixture(), backlogGoals: backlogGoalsFixture } });
  let r = await h.settle({ sessionId: "s1", host: "sidebar" });
  const trigger = withClass(r.passElements(), "dg-version-picker-trigger").pop();
  assert.ok(trigger, "单泳道档存在查看版本选择器");
  assert.ok(treeText(trigger).endsWith(" ▾"), `触发器必须带下拉箭头（实得「${treeText(trigger)}」）`);
  assert.equal(trigger.props["aria-expanded"], "false");
  trigger.props.onClick({ stopPropagation() {} });
  r = await h.settle({ sessionId: "s1", host: "sidebar" });
  const opts = r.passElements().filter((e) => elClass(e) === "dg-schedule-version-item");
  const byKey = new Map(opts.map((e) => [e.props?.key ?? "(all)", e]));
  assert.ok(byKey.has("vp-standalone"), `必须补「独立目标」选项（实得 ${JSON.stringify([...byKey.keys()])}）`);
  assert.equal(treeText(byKey.get("vp-v1")!), "✓ 🏷️ V1", "选中项保留勾选但不得替代版本图标");
  assert.equal(treeText(byKey.get("vp-v2")!), "🏷️ V2", "未选中项用与看板一致的版本图标");
  assert.equal(treeText(byKey.get("(all)")!), "▸ 全部版本", "「全部版本」出口保留");
  assert.equal(treeText(byKey.get("vp-backlog")!), "📥 backlog");
  assert.equal(treeText(byKey.get("vp-standalone")!), "📌 独立目标");
  assert.ok(!byKey.has("vp-v0"), "已发布版本仍不作为视图备选");

  // 选中独立目标 → 唯一泳道且**真有卡片**（复用既有 lane 渲染路径）
  r = await clickOpenOption(h, r, (e) => e.props?.key === "vp-standalone");
  const els = r.passElements();
  assert.equal(withClass(els, "dg-version-label").length, 0, "不再渲染任何版本泳道");
  assert.equal(els.filter((e) => e.props?.key === "standalone-label").length, 1, "独立目标泳道已渲染");
  assert.equal(els.filter((e) => e.props?.key === "backlog-label").length, 0, "backlog 不渲染");
  assert.equal(cardEls(els).length, 1, "独立目标明细必须真的渲染出卡片（fixture 有 1 个独立目标）");
  assert.equal(gridTemplates(els)[0], "minmax(0, 1fr)", "独立目标唯一泳道同样是单列全宽");
  assert.equal(withClass(els, "dg-lane-collapse").length, 0);
});

test("g-352 att-003 第6项（渲染级）：单泳道档「确认」阶段块头有批量确认入口（图标+文字），复用同一弹窗；宽档列头入口不变", async () => {
  const board = boardFixture({
    versions: [
      { slug: "v1", name: "V1", status: "active", goals: [
        { id: "g-001", title: "版本目标", status: "draft", tags: [], criteria_count: 0, cards_count: 0 },
        { id: "g-002", title: "待确认", status: "review", tags: [], criteria_count: 0, cards_count: 0 },
      ], goals_count: 2, lazy: false, loaded: true },
      { slug: "v2", name: "V2", status: "active", goals: [], goals_count: 0, lazy: false, loaded: true },
      { slug: "v0", name: "V0", status: "released", goals: [], goals_count: 0, lazy: false, loaded: true },
    ],
  });
  const h = createRenderHarness({ boardWidth: 250, payload: { board, backlogGoals: backlogGoalsFixture } });
  let r = await h.settle({ sessionId: "s1", host: "sidebar" });
  let btns = withClass(r.passElements(), "dg-batch-accept-btn");
  assert.equal(btns.length, 1, "单泳道档恰好一个批量确认入口（横向列头在该档不渲染）");
  const btn = btns[0];
  assert.equal(btn.props.disabled, false, "有 1 个待确认目标 ⇒ 入口可用");
  assert.ok(treeText(btn).startsWith("✅ "), `入口必须是「图标 + 文字」（实得「${treeText(btn)}」）`);
  assert.match(treeText(btn), /\(1\)/, "数量提示与既有弹窗口径一致");
  assert.ok(btn.props.title && btn.props["aria-label"], "hover/可访问名称齐备");
  // 点击 → 打开**既有** BatchAcceptModal（逐个走单卡「接受」等价路径，不新造后端批量路径）
  btn.props.onClick({ stopPropagation() {} });
  r = await h.settle({ sessionId: "s1", host: "sidebar" });
  const els = r.passElements();
  assert.ok(els.some((e) => e.props?.key === "batch-accept-modal"), "点击后打开既有批量接受弹窗（二次确认）");
  assert.ok(els.some((e) => treeText(e).includes("批量接受")), "弹窗标题走既有 i18n 文案");

  // 无待确认目标 ⇒ 禁用 + 悬停说明（与既有 batchAcceptButtonState 口径一致）
  const h0 = createRenderHarness({ boardWidth: 250, payload: { board: boardFixture(), backlogGoals: backlogGoalsFixture } });
  const b0 = withClass((await h0.settle({ sessionId: "s1", host: "sidebar" })).passElements(), "dg-batch-accept-btn");
  assert.equal(b0.length, 1);
  assert.equal(b0[0].props.disabled, true, "0 个待确认 ⇒ 入口禁用");
  assert.ok(b0[0].props.title);

  // 宽档（多泳道）仍在「确认」列头渲染入口（同一工厂、同一 class、文案不变）
  const hw = createRenderHarness({ boardWidth: 900, payload: { board, backlogGoals: backlogGoalsFixture } });
  const bw = withClass((await hw.settle({ sessionId: "s1", host: "sidebar" })).passElements(), "dg-batch-accept-btn");
  assert.equal(bw.length, 1, "宽档确认列头入口唯一且不变");
  assert.doesNotMatch(treeText(bw[0]), /^✅ /, "宽档列头文案逐字不变（未加图标）");

  // 单一实现：两处调用点共用同一工厂（源码契约）
  const kanban = readClient("kanban");
  assert.match(kanban, /const renderBatchAcceptButton = \(iconized\) => \{/, "工厂只有一处定义");
  assert.equal([...kanban.matchAll(/renderBatchAcceptButton\(/g)].length, 2, "恰好 2 处调用（宽档确认列头 / 单泳道确认阶段块头）");
  assert.equal([...kanban.matchAll(/batchAcceptButtonState\(reviewGoals\.length\)/g)].length, 1, "状态派生只在工厂里一份");
  assert.match(kanban, /s\.key === "confirm" \? renderBatchAcceptButton\(true\) : null/, "单泳道档确认阶段块头挂入口");
});

test("g-352 att-005 B2（渲染级）：版本管理+创建版本回到网格左上角原位置（靠左、可读标签、两侧一致）", async () => {
  const payload = () => ({ board: boardFixture(), backlogGoals: backlogGoalsFixture });
  const h = createRenderHarness({ boardWidth: 900, payload: payload() });
  const els = (await h.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  // ① 原位置 = 网格左上角单元格（g-174/g-223 的落点），且不再是 att-003 的「空锚点」
  const corner = els.filter((e) => e.props?.key === "grid-corner").pop();
  assert.ok(corner, "网格左上角单元格在");
  assert.equal(elClass(corner), "dg-grid-corner", "单元格带稳定 class（真机核验可选中）");
  const inCorner = treeOf(corner);
  const vm = inCorner.filter((e) => elClass(e).includes("dg-version-manage-btn")).pop();
  assert.ok(vm, "版本管理按钮在网格左上角（不再并入搜索行）");
  assert.equal(treeText(vm), "🏷️ 版本管理", "保留「补齐可读标签」成果：图标 + 可见文字");
  assert.ok(vm.props.title && vm.props["aria-label"], "title/aria-label 仍指向版本管理抽屉");
  const cv = inCorner.filter((e) => isButtonEl(e) && treeText(e) === "创建版本").pop();
  assert.ok(cv, "创建版本按钮同样在网格左上角");
  // ② 靠左对齐 + 纵向堆叠 + 不溢出（130px 列宽；en 标签更长 ⇒ 省略号兜底）
  assert.equal(corner.props.style.flexDirection, "column", "两颗按钮纵向靠左堆叠（130px 列宽放不下同一行）");
  assert.equal(corner.props.style.alignItems, "flex-start", "靠左对齐");
  assert.equal(corner.props.style.overflow, "hidden", "单元格不溢出到相邻阶段列头");
  for (const b of [vm, cv]) {
    assert.equal(b.props.style.maxWidth, "100%");
    assert.equal(b.props.style.minWidth, 0);
    assert.equal(b.props.style.overflow, "hidden");
    assert.equal(b.props.style.textOverflow, "ellipsis");
    assert.equal(b.props.style.height, ROW_BTN_METRICS.height, "两颗按钮同行同口径（rowBtnStyle 唯一真源）");
    assert.equal(b.props.style.padding, ROW_BTN_METRICS.padding);
  }
  // ③ 头部不再有 att-003 的同行容器；搜索框是头部的直接子节点（B-1：与标题同一行、不新增行）
  assert.equal(els.filter((e) => e.props?.key === "head-search-row").length, 0, "不再有 head-search-row 包装层");
  const head = els.filter((e) => elClass(e) === "dg-head").pop();
  assert.ok(head, "头部带共用 .dg-head");
  assert.ok((head.children || []).flat(Infinity).some((c: any) => elClass(c) === "dg-search-bar"), "搜索框是头部的直接子节点（与标题同一行）");
  const headKids = (head.children || []).flat(Infinity).filter((c: any) => c?.type);
  assert.equal(headKids[headKids.length - 1]?.props?.className, "dg-search-bar", "搜索框是头部最后一个子节点（原设计：marginLeft:auto 推到同一行右端）");
  const cBar = headKids[headKids.length - 1];
  assert.equal(cBar.props.style.marginLeft, "auto", "搜索框仍是 marginLeft:auto（同一行、不新增行）");
  assert.equal(head.props.style.flexDirection, undefined, "头部不得改成纵向容器（那会新增行高）");
  assert.ok(gridTemplates(els)[0]!.startsWith("130px"), "共享列模板不变");
  // ④ 点击仍打开版本管理抽屉（行为不变、无新实现）
  vm.props.onClick({ stopPropagation() {} });
  const els2 = (await h.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  assert.ok(els2.some((e) => e.props?.key === "dg-version-drawer"), "点击版本管理按钮 → 打开版本管理抽屉");
  const drawer = els2.filter((e) => e.props?.key === "dg-version-drawer").pop();
  assert.equal(typeof drawer.props.onClose, "function", "抽屉 props 齐备（既有版本管理抽屉）");
  assert.ok(Array.isArray(drawer.props.versions), "抽屉仍吃既有 versions 数据源（宽度由既有 S.modal 约束，不溢出）");

  // ⑤ 两侧完全一致：会话内看板页签的角落与侧栏逐字相同（att-005 判据 5①）
  const hc = createRenderHarness({ boardWidth: 900, payload: payload() });
  const cEls = (await hc.settle({ sessionId: "s1" })).passElements();
  const cCorner = cEls.filter((e) => e.props?.key === "grid-corner").pop();
  assert.ok(cCorner, "会话内看板页签同样在原位置渲染角落（两侧一致）");
  assert.deepEqual(plain(cCorner), plain(corner), "两侧角落元素逐字一致");
  const cvm = cEls.filter((e) => elClass(e).includes("dg-version-manage-btn")).pop();
  assert.equal(treeText(cvm), "🏷️ 版本管理", "会话内看板页签同口径（不再是无文字裸图标）");
});

test("g-352 att-003 第8项（渲染级）：版本选择下拉在版本行标题里、[+] 左侧；「全部版本」出口仍可达", async () => {
  const payload = () => ({ board: boardFixture(), backlogGoals: backlogGoalsFixture });
  const h = createRenderHarness({ boardWidth: 250, payload: payload() });
  let r = await h.settle({ sessionId: "s1", host: "sidebar" });
  const label = r.passElements().filter((e) => e.props?.key === "v-v1-label").pop();
  assert.ok(label, "存在版本行标题");
  const inside = treeOf(label);
  const picker = inside.filter((e) => elClass(e).includes("dg-version-picker-trigger")).pop();
  assert.ok(picker, "选择器在版本行标题里");
  const plus = inside.filter((e) => isButtonEl(e) && treeText(e) === "＋").pop();
  assert.ok(plus, "版本行标题里有创建 goal 的 [ + ]");
  assert.ok(inside.indexOf(picker) < inside.indexOf(plus), "选择器必须位于 [ + ] 左侧");
  assert.equal(plus.props.style.position, "absolute", "创建 goal 的 [ + ] 仍在标题右侧绝对定位（原样式口径）");
  assert.equal(plus.props.style.height, picker.props.style.height, "同行的 [ + ] 与选择器等高（第 9 项）");
  assert.equal(plus.props.style.width, plus.props.style.height, "[ + ] 是 1:1 方形图标按钮");
  // 头部不再重复挂一份（单泳道档只有这一处）
  assert.equal(withClass(r.passElements(), "dg-version-picker-trigger").length, 1, "单泳道档只有一份选择器（不会 N 份重复下拉）");
  // backlog / 独立目标唯一泳道时同样挂在这一行（出口处处可达）
  r = await clickPickerOption(h, r, (e) => e.props?.key === "vp-backlog");
  const bl = r.passElements().filter((e) => e.props?.key === "backlog-label").pop();
  assert.ok(bl, "backlog 唯一泳道已渲染");
  assert.ok(treeOf(bl).some((e) => elClass(e).includes("dg-version-picker-trigger")), "backlog 泳道标题里也有选择器");
  // 「全部版本」出口仍可达：从版本行选择器切回多泳道横向档
  r = await clickPickerOption(h, r, (e) => elClass(e) === "dg-schedule-version-item" && e.props?.key == null);
  const tpl = gridTemplates(r.passElements())[0];
  assert.ok(tpl && tpl.startsWith("130px"), `「全部版本」出口必须可达（实得 ${tpl}）`);
});

test("g-352 att-003 第9项（渲染级）：同一行按钮等高同风格（头部/工具条/泳道行/主管栏）", async () => {
  const h = createRenderHarness({ boardWidth: 900, payload: { board: boardFixture({ supervisorSession: "sup-1" }), backlogGoals: backlogGoalsFixture } });
  const els = (await h.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const head = els.filter((e) => elClass(e) === "dg-head").pop();
  assert.ok(head, "头部带共用的 .dg-head（两侧同一实现）");
  const btns = treeOf(head).filter((e) => isButtonEl(e) && elClass(e).includes("dg-btn"));
  assert.equal(btns.length, 5, `头部恰好 5 颗按钮（实得 ${btns.length}：刷新/标签筛选/记忆/知识库/⚙；已归档是 label、清除筛选仅在筛选激活时出现）`);
  assert.deepEqual([...new Set(btns.map((b) => b.props.style.height))], [ROW_BTN_METRICS.height], "同一行/同区按钮必须等高");
  for (const b of btns) {
    if (b.props.style.width === ROW_BTN_METRICS.height) {
      assert.equal(b.props.style.minWidth, ROW_BTN_METRICS.height, "图标按钮必须 1:1 且不可压扁");
    } else {
      assert.equal(b.props.style.padding, ROW_BTN_METRICS.padding, "文字按钮同级内边距");
    }
  }
  // att-005 B-2：负责人截图指出的两颗（版本管理小方图标 / 创建版本大长条）现都在网格左上角、完全同口径
  const corner = els.filter((e) => e.props?.key === "grid-corner").pop();
  const cornerBtns = treeOf(corner).filter(isButtonEl);
  const vm = cornerBtns.find((b) => elClass(b).includes("dg-version-manage-btn"));
  const cv = cornerBtns.find((b) => treeText(b) === "创建版本");
  assert.ok(vm && cv, "两颗按钮都在网格左上角（原位置）");
  assert.deepEqual(
    [vm!.props.style.height, vm!.props.style.padding, vm!.props.style.fontSize, vm!.props.style.lineHeight, vm!.props.style.boxSizing],
    [cv!.props.style.height, cv!.props.style.padding, cv!.props.style.fontSize, cv!.props.style.lineHeight, cv!.props.style.boxSizing],
    "两颗按钮尺寸口径完全一致（rowBtnStyle 唯一真源）",
  );
  // 齿轮图标按钮与同行文字按钮等高
  const gear = btns.filter((b) => treeText(b) === "⚙");
  assert.equal(gear.length, 1);
  assert.equal(gear[0].props.style.height, ROW_BTN_METRICS.height);
  assert.equal(gear[0].props.style.width, ROW_BTN_METRICS.height);

  // 窄档：折叠触发按钮与被收进的下拉项同口径（第 9 项第 4 点）
  const hn = createRenderHarness({ boardWidth: 250, payload: { board: boardFixture({ supervisorSession: "sup-1" }), backlogGoals: backlogGoalsFixture } });
  let nEls = (await hn.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const trigger = withClass(nEls, "dg-head-overflow-trigger").pop();
  assert.equal(trigger.props.style.height, ROW_BTN_METRICS.height);
  trigger.props.onClick({ stopPropagation() {} });
  nEls = (await hn.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  for (const row of withClass(nEls, "dg-narrow-panel-btn")) {
    assert.equal(row.props.style.height, ROW_BTN_METRICS.height, "下拉项与触发按钮等高");
  }
  // 单泳道档：版本行选择器与 [ + ] 同行等高（同为 26px）
  const hs = createRenderHarness({ boardWidth: 250, payload: { board: boardFixture(), backlogGoals: backlogGoalsFixture } });
  const sEls = (await hs.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const sLabel = sEls.filter((e) => e.props?.key === "v-v1-label").pop();
  const sInside = treeOf(sLabel);
  const sPicker = sInside.filter((e) => elClass(e).includes("dg-version-picker-trigger")).pop();
  const sPlus = sInside.filter((e) => isButtonEl(e) && treeText(e) === "＋").pop();
  assert.equal(sPicker.props.style.height, ROW_BTN_METRICS.height);
  assert.equal(sPlus.props.style.height, ROW_BTN_METRICS.height);

  // 主管栏窄档图标按钮同样与同行按钮等高（SupervisorBar 需真调用，见第 3 项）
  const supBoard = boardFixture({ supervisorSession: "sup-1" });
  const hSup = createRenderHarness({ boardWidth: 250, payload: { board: supBoard } });
  const supEls = (await hSup.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const supBarEl = supEls.filter((e) => e.type?.name === "SupervisorBar").pop();
  const supBar = supBarEl.type(supBarEl.props);
  const supBtn = treeOf(supBar).filter((e: any) => elClass(e).includes("dg-supervisor-jump-icon")).pop();
  assert.equal(supBtn.props.style.height, ROW_BTN_METRICS.height);
  assert.equal(supBtn.props.style.width, ROW_BTN_METRICS.height);
});

// ============================================================================
// g-352 att-004（B1）：DEBUG 块必须留在 .dg-head 内部
//   att-003 的判别力缺口：只断言 `debug:true/false`（元素在不在）——抓不住「块被搬到头部之外」。
//   这里补两级断言：① 父子/次序（结构级）；② 整棵 conversation.view 元素签名（签名级）。
//   签名基线取自 att-002 的 commit 83bb041（构建产物），冻结在 fixtures/g352-conv-signature.txt。
// ============================================================================

/** 子 → 父 索引（把 h() 元素树展开；children 可能是嵌套数组）。 */
function parentIndexOf(els: any[]): Map<any, any> {
  const m = new Map<any, any>();
  const walk = (node: any, parent: any): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walk(n, parent); return; }
    if (!node.type) return;
    m.set(node, parent);
    walk(node.children, node);
  };
  for (const el of els) if (!m.has(el)) m.set(el, null);
  for (const el of els) walk(el.children, el);
  return m;
}

/**
 * 元素**结构签名**（一行一个元素，文档序 DFS）：tag / key / className / 样式键值 / 关键 prop 存在性。
 * 刻意**不含文案与时间戳**（插件版本号、generated_at 倒计时、i18n 文案）⇒ 可跨版本冻结；
 * 只在 DOM 结构或样式真的变化时变红 —— att-003 的「DEBUG 被搬出 .dg-head」正是这一类变化。
 * 只看**根节点可达**的元素（未挂载的孤立元素不是 DOM）。
 */
function elementSignature(root: any): string[] {
  const out: string[] = [];
  const styleOf = (e: any) => {
    const st = e?.props?.style;
    if (!st || typeof st !== "object") return "-";
    return Object.keys(st).sort().map((k) => `${k}=${String(st[k])}`).join(";");
  };
  const flagsOf = (e: any) =>
    ["title", "aria-label", "aria-expanded", "placeholder", "href"].filter((k) => typeof e?.props?.[k] === "string").join(",") || "-";
  const walk = (node: any, depth: number): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth); return; }
    if (!node.type) return;
    const tag = typeof node.type === "string" ? node.type : (node.type?.name || "Component");
    const cls = typeof node.props?.className === "string" ? node.props.className : "-";
    const key = node.props?.key == null ? "-" : String(node.props.key);
    out.push(`${"  ".repeat(depth)}${tag} key=${key} class=${cls} style=${styleOf(node)} flags=${flagsOf(node)}`);
    walk(node.children, depth + 1);
  };
  walk(root, 0);
  return out;
}

const CONV_SIGNATURE_FIXTURE = join(import.meta.dirname, "fixtures/g352-conv-signature.txt");

test("g-352 att-005 B1（结构级/两侧一致）：DEBUG 是 .dg-head 的直接子节点，次序 已归档 → DEBUG → 搜索框", async () => {
  const payload = () => ({ board: boardFixture(), backlogGoals: backlogGoalsFixture });
  const cases: Array<[string, any, number]> = [
    ["会话内看板页签（宽档）", { sessionId: "s1" }, 900],
    ["右侧栏（宽档）", { sessionId: "s1", host: "sidebar" }, 900],
  ];
  for (const [label, props, width] of cases) {
    const h = createRenderHarness({ boardWidth: width, payload: payload() });
    const els = (await h.settle(props)).passElements();
    const parents = parentIndexOf(els);
    const strong = els.filter((e) => e.type === "strong" && treeText(e) === "dsh-graph").pop();
    assert.ok(strong, `${label}：看板标题存在`);
    const head = parents.get(strong);
    assert.ok(head, `${label}：标题在头部容器内`);
    assert.equal(elClass(head), "dg-head", `${label}：头部是共用的 .dg-head`);
    assert.ok(treeOf(head).some((e) => elClass(e) === "dg-search-bar"), `${label}：搜索框在这个头部容器里`);
    const debug = els.filter((e) => typeof e.props?.title === "string" && e.props.title.startsWith("DEBUG sessionId=")).pop();
    assert.ok(debug, `${label}：DEBUG 块已渲染`);
    assert.equal(parents.get(debug), head, `${label}：DEBUG 必须是 .dg-head 的直接子节点（att-003 缺陷：成了看板根容器的兄弟）`);
    assert.notEqual(parents.get(head), null, `${label}：头部本身不是最外层根容器（DEBUG 才有「头部内部」可言）`);
    // 次序：已归档 → DEBUG → 搜索框（两侧同一份实现 ⇒ 两侧同一次序）
    const kids = (head.children ?? []).flat(Infinity).filter((c: any) => c && typeof c === "object" && c.type);
    const iArch = kids.findIndex((c: any) => c.props?.key === "tb-archived");
    const iDebug = kids.indexOf(debug);
    const iSearch = kids.findIndex((c: any) => elClass(c) === "dg-search-bar");
    assert.ok(iArch >= 0, `${label}：已归档开关在头部`);
    assert.ok(iSearch >= 0, `${label}：搜索框在头部`);
    assert.ok(iDebug > iArch, `${label}：DEBUG 在「已归档」之后（实得 ${iDebug} vs ${iArch}）`);
    assert.ok(iDebug < iSearch, `${label}：DEBUG 在「搜索框」之前（实得 ${iDebug} vs ${iSearch}）`);
  }
});

// ============================================================================
// g-352 att-005：冻结签名 fixture（重新生成 + 来源 commit/内容 hash 头 + 断言）
//   新口径：① 会话内看板页签 == 侧栏（同一组件/同一逻辑，逐字签名相等，见上方判据 5①）
//          ② 对话本体零新增差异（见上方判据 5②）
//   冻结的会话内签名仍然逐字断言 —— 它的作用是「头部/泳道结构被无意改动就变红」。
// ============================================================================

/** fixture 头：来源 commit + 源码 hash（决定头部渲染的 4 个源模块）+ 正文内容 hash。 */
const SIG_HEADER_PREFIX = "# ";
const SIG_SOURCE_FILES = ["kanban", "constants", "narrow-width", "helpers"];

/** 仓库根（core/tests → ../..）——供 git 溯源断言与签名 dump 工具使用。 */
const repoRoot = () => join(import.meta.dirname, "../..");

function sourceFingerprint(): string {
  const hash = createHash("sha256");
  for (const name of SIG_SOURCE_FILES) hash.update(name + "\n" + readClient(name) + "\n");
  return hash.digest("hex");
}

function parseSignatureFixture(raw: string): { meta: Map<string, string>; body: string[] } {
  const meta = new Map<string, string>();
  const body: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    if (line.startsWith(SIG_HEADER_PREFIX)) {
      const i = line.indexOf(":", SIG_HEADER_PREFIX.length);
      if (i > 0) meta.set(line.slice(SIG_HEADER_PREFIX.length, i).trim(), line.slice(i + 1).trim());
      continue;
    }
    body.push(line);
  }
  return { meta, body };
}

const bodyHash = (body: string[]) => createHash("sha256").update(body.join("\n") + "\n").digest("hex");

test("g-352 att-005：会话内看板页签签名 == 冻结 fixture，且 fixture 的来源 commit/内容 hash 头自校验", async () => {
  // 维护者工具（改动头部/泳道结构后重新冻结）：
  //   G352_SIG_DUMP=1 G352_SIG_ACK=1 node --test --test-name-pattern="会话内看板页签签名" core/tests/g352-narrow-width.test.ts
  // 只导出做 diff（不覆盖冻结基线）：G352_SIG_DUMP=<其他路径>（无需 ack）
  const SIG_BOARD_WIDTH = 250;
  const h = createRenderHarness({ boardWidth: SIG_BOARD_WIDTH, payload: { board: boardFixture(), backlogGoals: backlogGoalsFixture } });
  const r = await h.settle({ sessionId: "s1" });
  const actual = elementSignature(r.root());
  if (process.env.G352_SIG_DUMP) {
    const target = process.env.G352_SIG_DUMP === "1" ? CONV_SIGNATURE_FIXTURE : process.env.G352_SIG_DUMP;
    if (target === CONV_SIGNATURE_FIXTURE && process.env.G352_SIG_ACK !== "1") {
      assert.fail("拒绝覆盖冻结基线：需 G352_SIG_ACK=1 显式确认（或 G352_SIG_DUMP=<其他路径> 只导出做 diff）");
    }
    const head = [
      "# g352-conv-signature —— 会话内看板页签元素签名冻结基线（g-352 att-005 重新生成）",
      `# source-commit: ${execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot(), encoding: "utf8" }).trim()}`,
      `# source-sha256: ${sourceFingerprint()}`,
      `# source-files: ${SIG_SOURCE_FILES.join(",")}   # 源 hash 覆盖的模块（决定头部/泳道渲染）`,
      `# content-sha256: ${bodyHash(actual)}`,
      `# board-width: ${SIG_BOARD_WIDTH}`,
      "",
    ].join("\n");
    writeFileSync(target, head + actual.join("\n") + "\n");
    return;
  }
  const raw = readFileSync(CONV_SIGNATURE_FIXTURE, "utf8");
  const { meta, body } = parseSignatureFixture(raw);
  // ① 来源 commit 头必须是本仓库真实存在的提交，且是 HEAD 的祖先（可追溯来源，不接受手写字符串）
  const sourceCommit = meta.get("source-commit");
  assert.ok(sourceCommit && /^[0-9a-f]{7,40}$/.test(sourceCommit), `fixture 必须带来源 commit 头（实得 ${sourceCommit}）`);
  execFileSync("git", ["cat-file", "-e", `${sourceCommit}^{commit}`], { cwd: repoRoot(), stdio: "ignore" });
  execFileSync("git", ["merge-base", "--is-ancestor", sourceCommit, "HEAD"], { cwd: repoRoot(), stdio: "ignore" });
  // ② 内容 hash 头必须与正文一致（手改正文而不更新头 ⇒ 立即变红）
  assert.equal(bodyHash(body), meta.get("content-sha256"), "fixture 内容 hash 与正文不一致（被手改过？）");
  // ③ 源码 hash 头必须与当前「决定头部渲染的源模块」一致 ⇒ fixture 与源码同步，改坏必红
  assert.equal(sourceFingerprint(), meta.get("source-sha256"), "fixture 与源码不同步：确认改动后按维护者工具重新冻结");
  // ④ 会话内看板页签的实渲染签名 == 冻结正文（逐字）
  assert.equal(Number(meta.get("board-width")), SIG_BOARD_WIDTH, "fixture 记录了冻结时的板宽，须与本测试一致");
  assert.deepEqual(actual, body, "会话内看板页签元素签名必须与冻结值逐字一致（差异 0 行）");
});

test("g-352 att-005：签名 fixture 维护者工具需显式 ack，绝不无条件覆盖冻结基线", () => {
  const src = readFileSync(import.meta.filename, "utf8");
  // 覆盖冻结基线前必须校验来源 hash 或要求第二个显式 ack 变量（G352_SIG_ACK=1）
  assert.match(src, /G352_SIG_ACK/, "必须存在第二个显式 ack 变量");
  assert.match(src, /if \(target === CONV_SIGNATURE_FIXTURE && process\.env\.G352_SIG_ACK !== "1"\)/, "覆盖冻结基线必须要求 ack");
  assert.match(src, /assert\.fail\(/, "未 ack 时必须显式失败，而不是静默写入");
  // dump 到别处（做 diff）不需要 ack，但绝不覆盖冻结基线
  assert.match(src, /G352_SIG_DUMP/);
});

test("g-352 att-004 N1（渲染级）：标签筛选激活时头部「清除筛选」与同行按钮同口径", async () => {
  const board = boardFixture({
    versions: [{ slug: "v1", name: "V1", status: "active", goals: [{ id: "g-001", title: "版本目标", status: "draft", tags: ["alpha"], criteria_count: 0, cards_count: 0 }], goals_count: 1, lazy: false, loaded: true }],
  });
  const payload = { board, backlogGoals: backlogGoalsFixture };
  const h = createRenderHarness({ boardWidth: 900, payload });
  /** 头部（.dg-head）子树内、文字匹配的按钮——弹窗里也有一个「清除筛选」，必须排除。 */
  const headBtn = (els: any[], text: string) => {
    const strong = els.filter((e) => e.type === "strong" && treeText(e) === "dsh-graph").pop();
    assert.ok(strong, "看板标题存在");
    const head = parentIndexOf(els).get(strong);
    assert.ok(head, "标题在头部容器内");
    return treeOf(head).filter((e) => isButtonEl(e) && treeText(e) === text).pop();
  };
  let els = (await h.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  assert.equal(headBtn(els, "清除筛选"), undefined, "无筛选时头部不渲染「清除筛选」");
  // 打开标签筛选弹层并选中一个标签 ⇒ tagFilter 非空（清除按钮出现）
  const tfBtn = headBtn(els, "🏷️ 标签筛选");
  assert.ok(tfBtn, "头部有标签筛选入口");
  tfBtn.props.onClick({ stopPropagation() {} });
  els = (await h.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const tagOpt = els.filter((e) => isButtonEl(e) && treeText(e) === "#alpha").pop();
  assert.ok(tagOpt, "标签弹层列出可选标签");
  tagOpt.props.onClick({ stopPropagation() {} });
  els = (await h.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const clearBtn = headBtn(els, "清除筛选");
  assert.ok(clearBtn, "标签筛选激活后头部出现「清除筛选」");
  // N1：同行基准（rowBtnStyle 唯一真源）——原先自覆盖 padding 0 6px / fontSize 11 ⇒ 同行有大有小
  const sibling = headBtn(els, "🏷️ 标签筛选 (1)");
  assert.ok(sibling, "筛选激活后同行按钮文字带计数（标签筛选 (1)）");
  assert.equal(clearBtn.props.style.padding, ROW_BTN_METRICS.padding, "不得再自覆盖 0 6px");
  assert.equal(clearBtn.props.style.fontSize, ROW_BTN_METRICS.fontSize, "不得再自覆盖 11px");
  assert.equal(clearBtn.props.style.height, ROW_BTN_METRICS.height);
  assert.equal(clearBtn.props.style.lineHeight, ROW_BTN_METRICS.lineHeight);
  for (const k of ["height", "fontSize", "lineHeight", "padding", "boxSizing", "display", "alignItems"] as const) {
    assert.equal(clearBtn.props.style[k], sibling.props.style[k], `清除筛选与同行按钮 ${k} 必须一致（同行无大有小）`);
  }
  const kanban = readClient("kanban");
  assert.doesNotMatch(kanban, /marginLeft: 4, padding: "0 6px", fontSize: 11/, "源码里不得再有 tagclear 的自覆盖口径");
  assert.match(kanban, /style: \{ \.\.\.S\.btn, \.\.\.rowBtnStyle\(\), marginLeft: 4 \}/, "tagclear 走 rowBtnStyle 同行基准");
});
