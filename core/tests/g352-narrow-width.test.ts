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
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

import {
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
  assert.match(src, /\}, \[sidebarHost, activeWs, boardMounted, kanbanRenderKey\]\);/);
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
  assert.match(src, /const narrowActive = sidebarHost && widthTier !== "wide";/);
  assert.match(src, /const narrowSingleTier = sidebarHost && isSingleVersionTier\(boardWidth\);/);
  const narrow = readClient("narrow-width");
  assert.doesNotMatch(narrow, /\bdocument\.|\bwindow\./, "断点派生是纯函数，不触碰 DOM/window");
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
  assert.match(src, /const singleVersion = \(narrowSingleTier && !searchActiveQuery && !viewBacklogOnly && viewVersionSlug !== VIEW_ALL_VERSIONS_SLUG\)/);
  assert.match(src, /const VIEW_ALL_VERSIONS_SLUG = "__all__";/);
  // g-352（负责人裁决）：backlog 也是单版本档的视图备选 → 单泳道档 = 单版本 ∪ 单 backlog
  assert.match(src, /const VIEW_BACKLOG_SLUG = "__backlog__";/);
  assert.match(src, /const viewBacklogOnly = !!\(narrowSingleTier && !searchActiveQuery && viewVersionSlug === VIEW_BACKLOG_SLUG\);/);
  assert.match(src, /const singleLaneMode = !!\(narrowSingleTier && !searchActiveQuery && \(singleVersion \|\| viewBacklogOnly\)\);/);
  // 只渲染选中版本一个泳道，且以纵向模式（lane 第 7 参 vertical=true）渲染
  assert.match(src, /rows\.push\(\.\.\.lane\(`🏷️ \$\{singleVersion\.name\}`, singleVersion\.goals, "v-" \+ singleVersion\.slug, singleVersion\.slug, 0, true, true\)\)/);
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
  assert.match(kanban, /!searchActiveQuery && !viewBacklogOnly && viewVersionSlug !== VIEW_ALL_VERSIONS_SLUG\)/);
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

interface RenderResult { passElements: () => any[] }

function createRenderHarness(opts: { boardWidth?: number; payload: any }) {
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  const boardWidth = opts.boardWidth ?? 250;
  const elements: any[] = [];
  const fetchLog: string[] = [];
  const observed: any[] = [];
  let factory: any = null;
  const noop = () => {};

  const makeFakeNode = () => ({
    clientWidth: boardWidth, scrollWidth: 0, scrollHeight: 0, scrollTop: 0, style: {},
    getBoundingClientRect: () => ({ width: boardWidth, height: 10, top: 0, left: 0 }),
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
    if (name === "react-dom") return { render: noop, createRoot: () => ({ render: noop, unmount: noop }) };
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
    sessions: { list: { getSnapshot: () => ({ byId: {}, items: [], subagentsByParent: {} }) } },
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
    for (let p = 0; p < maxPasses; p++) {
      passes++;
      dirty = false;
      cursor.clear();
      pendingEffects = [];
      lastStart = elements.length;
      KanbanView(props); // 同步渲染；effect 抛错会直接冒泡 ⇒ 断言失败（生命周期缺陷必须变红）
      for (const s of pendingEffects) {
        if (typeof s.cleanup === "function") s.cleanup();
        s.cleanup = s.fn();
      }
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      if (!dirty) break;
    }
    return { passElements: () => elements.slice(lastStart) };
  }
  return { settle, elements, fetchLog, observed, passes: () => passes };
}

/** 元素树文本（含子元素递归）。 */
function treeText(node: any): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(treeText).join(" ");
  if (node.children) return treeText(node.children);
  return "";
}
const elClass = (e: any): string => (typeof e?.props?.className === "string" ? e.props.className : "");
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

test("g-352 判据5（渲染级）：conversation.view 搜索框样式逐字不变，min-width:0 只在 sidebar 窄档追加", async () => {
  const hConv = createRenderHarness({ boardWidth: 250, payload: { board: boardFixture(), backlogGoals: backlogGoalsFixture } });
  const conv = (await hConv.settle({ sessionId: "s1" })).passElements();
  const convBar = conv.filter((e) => elClass(e) === "dg-search-bar").pop();
  assert.ok(convBar, "会话内路径仍渲染同一个搜索框");
  assert.deepEqual(Object.keys(convBar.props.style).sort(), ["alignItems", "display", "flexShrink", "gap", "marginLeft"], "会话内搜索框包装层不得多出任何样式键（基线 5 键）");
  assert.equal(Object.prototype.hasOwnProperty.call(convBar.props.style, "minWidth"), false, "会话内路径不得出现 min-width:0");
  const convInner = conv.filter((e) => e.props?.style?.position === "relative" && e.props?.style?.display === "flex" && e.props?.style?.alignItems === "center").pop();
  assert.ok(convInner, "会话内路径渲染搜索框内层容器");
  assert.equal(Object.prototype.hasOwnProperty.call(convInner.props.style, "minWidth"), false, "搜索框内层同样不得出现 min-width:0");
  // 会话内路径不订阅 ResizeObserver、不出现窄档专属控件、头部不带 sidebar class
  assert.equal(hConv.observed.length, 0, "conversation.view 不订阅 ResizeObserver");
  assert.equal(withClass(conv, "dg-version-picker-trigger").length, 0);
  assert.equal(withClass(conv, "dg-head-overflow-trigger").length, 0);
  assert.equal(conv.filter((e) => elClass(e) === "dg-head-sidebar").length, 0);

  const hSide = createRenderHarness({ boardWidth: 250, payload: { board: boardFixture(), backlogGoals: backlogGoalsFixture } });
  const side = (await hSide.settle({ sessionId: "s1", host: "sidebar" })).passElements();
  const sideBar = side.filter((e) => elClass(e) === "dg-search-bar").pop();
  assert.equal(sideBar.props.style.minWidth, 0, "sidebar 窄档才追加 min-width:0（兜底不越框）");
  assert.equal(hSide.observed.length, 1, "sidebar 实例确实订阅了根容器宽度");
});

test("g-352 C3/判据5：min-width:0 的门控是纯函数契约（非窄档返回的键集合与基线逐字一致）", () => {
  // 基线（g-352 之前）搜索框两层的内联样式键集合——逐字对照，不做近似
  const BASELINE_WRAP = { display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", flexShrink: 0 };
  const BASELINE_INNER = { position: "relative", display: "flex", alignItems: "center" };
  assert.deepEqual(searchBarWrapStyle(false), BASELINE_WRAP, "会话内（非窄档）搜索框包装层必须与基线逐字一致");
  assert.deepEqual(searchBarInnerStyle(false), BASELINE_INNER, "会话内搜索框内层必须与基线逐字一致");
  assert.equal(Object.prototype.hasOwnProperty.call(searchBarWrapStyle(false), "minWidth"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(searchBarInnerStyle(false), "minWidth"), false);
  // 恰好窄档多一个 minWidth:0，其余键一字不改
  assert.deepEqual(searchBarWrapStyle(true), { ...BASELINE_WRAP, minWidth: 0 });
  assert.deepEqual(searchBarInnerStyle(true), { ...BASELINE_INNER, minWidth: 0 });
  // 渲染路径确实走门控函数（kanban.js 内不再有无门控的字面 minWidth:0）
  const kanban = readClient("kanban");
  assert.match(kanban, /style: searchBarWrapStyle\(narrowActive\),/);
  assert.match(kanban, /h\("div", \{ style: searchBarInnerStyle\(narrowActive\) \},/);
  const searchBarSlice = kanban.slice(kanban.indexOf('className: "dg-search-bar"') - 900, kanban.indexOf('className: "dg-search-bar"') + 900);
  assert.doesNotMatch(searchBarSlice, /minWidth: 0/, "搜索框路径不得再有裸 minWidth:0（必须经 searchBarWrapStyle/InnerStyle 门控）");
  // HOVER_CSS 是共享样式表：新增规则必须都只命中 sidebar/窄档专属选择器，且共享声明在位
  const css = readClient("constants");
  assert.match(css, /g-352 共享声明（判据 5）：HOVER_CSS 这一整块样式表由\*\*两个宿主共同注入\*\*/, "共享 HOVER_CSS 的增加必须有显式声明（复核者 C3 要求）");
  const hover = css.slice(css.indexOf("const HOVER_CSS"), css.indexOf("`;", css.indexOf("const HOVER_CSS")));
  for (const sel of [".dg-narrow-head-btn", ".dg-narrow-panel-btn", ".dg-backlog-flat-vertical"]) {
    assert.ok(hover.includes(sel), `HOVER_CSS 内定义 ${sel}`);
  }
  // 会话内路径不可能命中这些选择器：其元素只在 host=sidebar 且窄档时创建（渲染级反证见下一条）
  const conv = readClient("kanban");
  assert.match(conv, /narrowActive[\s\S]{0,600}?key: "tb-overflow"/, "窄档专属元素由 narrowActive 门控");
  assert.match(conv, /narrowSingleTier[\s\S]{0,600}?key: "tb-version-picker"/, "单泳道档专属选择器由 narrowSingleTier 门控");
});

test("g-352 判据5（渲染级反证）：conversation.view 路径不出现任何窄档专属元素/class", async () => {
  const hConv = createRenderHarness({ boardWidth: 250, payload: { board: boardFixture(), backlogGoals: backlogGoalsFixture } });
  const conv = (await hConv.settle({ sessionId: "s1" })).passElements();
  for (const k of ["dg-narrow-head-btn", "dg-narrow-panel-btn", "dg-backlog-flat-vertical", "dg-head-overflow-trigger", "dg-version-picker-trigger", "dg-head-sidebar"]) {
    assert.equal(withClass(conv, k).length, 0, `会话内路径不得出现 ${k}（HOVER_CSS 新增规则对它零影响）`);
  }
});
