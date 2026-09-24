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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  assert.match(src, /const singleVersion = \(narrowSingleTier && !searchActiveQuery && viewVersionSlug !== VIEW_ALL_VERSIONS_SLUG\)/);
  assert.match(src, /const VIEW_ALL_VERSIONS_SLUG = "__all__";/);
  assert.match(src, /const singleVersionMode = !!\(narrowSingleTier && singleVersion\);/);
  // 只渲染选中版本一个泳道，且以纵向模式（lane 第 7 参 vertical=true）渲染
  assert.match(src, /rows\.push\(\.\.\.lane\(`🏷️ \$\{singleVersion\.name\}`, singleVersion\.goals, "v-" \+ singleVersion\.slug, singleVersion\.slug, 0, true, true\)\)/);
  // 其他泳道（其余 active 版本、standalone、backlog、released）在该档一律不渲染
  assert.match(src, /for \(const v of \(singleVersionMode \? \[\] : active\)\)/);
  assert.match(src, /const releasedRows = \(singleVersionMode \? \[\] : released\)\.map/);
  assert.match(src, /if \(!singleVersionMode\) \{\n\s*rows\.push\(\.\.\.lane\(dgT\("lane\.standalone"\)/);
  // 列模板退化为单列全宽（阶段纵向堆叠而非横向挤压）
  assert.match(src, /const gridCols = singleVersionMode \? "minmax\(0, 1fr\)" : horizontalGridCols;/);
  // 横向阶段列头在单版本档不渲染（改由每个阶段块自带列头）
  assert.match(src, /singleVersionMode \? null : STAGES\.map\(\(s\) => \{/);
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
  assert.match(kanban, /!searchActiveQuery && viewVersionSlug !== VIEW_ALL_VERSIONS_SLUG\)/);
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
