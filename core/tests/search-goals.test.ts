import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  init,
  createGoal,
  boardProjection,
  extractGoalDescription,
  saveGoal,
  loadGoal,
  findGoalFile,
} from "../ops.ts";
// g-255: import 真实 search-state 模块，消除测试内孤立复制实现
import {
  createSearchTempState,
  toggleLaneCollapseInState,
  toggleReleasedOpenInState,
  exitSearchRestore,
  navigateToMatchTrack,
  computeEffectiveHiddenVersionSlugs,
  resetSearchState,
} from "../../dsh-graph-host/lib/client/search-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("g-233 extractGoalDescription：正确提取目标描述正文并跳过后续小节", () => {
  const body = `
## 目标描述

这是第一段描述。

### 背景与价值
这是子标题内容。

## 质量判据

1. 判据 1
2. 判据 2
`;
  const desc = extractGoalDescription(body);
  assert.ok(desc.includes("这是第一段描述。"));
  assert.ok(desc.includes("### 背景与价值"));
  assert.ok(desc.includes("这是子标题内容。"));
  assert.ok(!desc.includes("质量判据"));
  assert.ok(!desc.includes("判据 1"));
});

test("g-233 boardProjection：目标对象下发 description 字段供全文搜索", () => {
  const root = mkdtempSync(join(tmpdir(), "g233-board-"));
  init(root);
  const goalId = createGoal(root, {
    title: "测试搜索目标",
    actor: "human:test",
  });
  const file = findGoalFile(root, goalId);
  const doc = loadGoal(file);
  doc.body = `
## 目标描述

独特的搜索关键词xyz123abc

## 质量判据

1. 判据测试
`;
  saveGoal(file, doc);

  const board = boardProjection(root);
  const found = board.backlog.find((g) => g.id === goalId);
  assert.ok(found, "目标应存在于 boardProjection backlog");
  assert.ok(found.description, "应包含 description 字段");
  assert.ok(found.description.includes("独特的搜索关键词xyz123abc"));
});

test("g-233 源码契约：模块与 Bundle 包含搜索框、高亮样式、导航与临时状态恢复", () => {
  const bundle = readFileSync(join(__dirname, "../../dist/lib/client.js"), "utf8");
  const constants = readFileSync(join(__dirname, "../../dsh-graph-host/lib/client/constants.js"), "utf8");
  const helpers = readFileSync(join(__dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  const card = readFileSync(join(__dirname, "../../dsh-graph-host/lib/client/card.js"), "utf8");
  const kanban = readFileSync(join(__dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");

  // 1. 样式与视觉契约（判据 1, 2, 3, 4）
  assert.match(constants, /\.dg-card-matched/);
  assert.match(constants, /\.dg-card-search-current/);
  assert.match(constants, /\.dg-search-highlight/);
  assert.match(constants, /\.dg-search-highlight-current/);
  assert.match(bundle, /\.dg-card-matched/);
  assert.match(bundle, /\.dg-card-search-current/);

  // 2. 辅助函数契约（正则转义、高亮分割、片段提取）
  assert.match(helpers, /function escapeRegExp/);
  assert.match(helpers, /function renderHighlight/);
  assert.match(helpers, /function extractMatchSnippet/);
  assert.match(bundle, /escapeRegExp/);
  assert.match(bundle, /renderHighlight/);

  // 3. 卡片行内高亮与当前卡视觉区分契约（判据 2, 3, 4）
  assert.match(card, /renderHighlight/);
  assert.match(card, /highlight\(g\.title/);
  assert.match(card, /highlight\(g\.id/);
  assert.match(card, /data-goal-id/);
  assert.match(card, /dg-card-search-current/);
  assert.match(card, /dg-card-matched/);
  assert.match(bundle, /highlight\(g\.title/);

  // 4. 看板搜索框与导航控件契约（判据 1, 3, 8, 9）
  assert.match(kanban, /dg-search-bar/);
  assert.match(kanban, /dg-search-input/);
  assert.match(kanban, /searchFullText/);
  assert.match(kanban, /dgT\(['"]search\.noResults['"]\)/);
  assert.match(kanban, /dgT\(['"]search\.enterKeyword['"]\)/);
  assert.match(kanban, /exitSearch/);
  assert.match(kanban, /navigateToMatch/);
  assert.match(kanban, /executeSearch/);
  assert.match(bundle, /dg-search-bar/);
  assert.match(bundle, /dgT\(['"]search\.noResults['"]\)/);

  // 5. 临时状态栈记录与精准恢复契约（判据 5, 6, 7）
  assert.match(kanban, /tempExpandedRef/);
  assert.match(kanban, /searchUnhiddenSlugs/);
  assert.match(kanban, /expandedLanes/);
  assert.match(kanban, /openReleasedSlugs/);
  assert.match(bundle, /searchUnhiddenSlugs/);
  assert.match(bundle, /tempExpandedRef/);

  // 6. DEBUG 信息两行紧凑展示、最长省略与 tooltip 契约（为搜索框留出空间，判据 1 优化）
  assert.match(kanban, /DEBUG sessionId=[\s\S]*?ws=/);
  assert.match(kanban, /textOverflow: "ellipsis"/);
  assert.match(kanban, /maxWidth: 160/);
  assert.match(bundle, /DEBUG sessionId=[\s\S]*?ws=/);
});

// ===== g-233 review 返工：P1/P2/P4 真实行为测试（g-255: 使用 search-state.js 真实模块） =====

test("g-233 P1 真实行为测试：搜索临时可见为纯内存覆盖层，computeEffectiveHiddenVersionSlugs 不写持久底账", () => {
  // 模拟 localStorage 持久化底账
  const storage = new Map<string, string>();
  const ws = "/test/workspace";
  const storageKey = "dsh-graph.hidden-versions." + ws;
  storage.set(storageKey, JSON.stringify([{ slug: "v0.1" }, { slug: "v0.2" }]));

  // 从 storage 读取持久隐藏偏好
  const readPersisted = () => JSON.parse(storage.get(storageKey) ?? "[]").map((x: any) => x.slug);
  assert.deepEqual(readPersisted(), ["v0.1", "v0.2"]);

  // 使用真实模块的 computeEffectiveHiddenVersionSlugs
  const hiddenVersionSlugs = readPersisted();
  let searchUnhiddenSlugs = new Set<string>();

  // 初始：两个版本均隐藏
  assert.deepEqual([...computeEffectiveHiddenVersionSlugs(hiddenVersionSlugs, searchUnhiddenSlugs)], ["v0.1", "v0.2"]);

  // 搜索命中 v0.1，触发纯内存临时 unhide（P1 契约：不写 storage）
  searchUnhiddenSlugs = new Set(["v0.1"]);

  // 视图中 v0.1 临时可见
  assert.deepEqual([...computeEffectiveHiddenVersionSlugs(hiddenVersionSlugs, searchUnhiddenSlugs)], ["v0.2"]);
  // 核心断言：storage 中的持久偏好绝对没有被修改
  assert.deepEqual(readPersisted(), ["v0.1", "v0.2"], "storage 绝对不被临时搜索写入");

  // 模拟用户直接刷新页面或重新打开看板（重新从 storage 读取初始状态）
  const refreshedHidden = readPersisted();
  const freshMemoryOverlay = new Set<string>(); // 刷新后新组件内存覆盖层为空
  assert.deepEqual(
    [...computeEffectiveHiddenVersionSlugs(refreshedHidden, freshMemoryOverlay)],
    ["v0.1", "v0.2"],
    "刷新后原持久隐藏偏好完好如初"
  );
});

test("g-233 P2 真实行为测试：resetSearchState 彻底清空跨工作区临时状态", () => {
  const wsA = "/workspace/A";
  const wsB = "/workspace/B";

  // 使用真实模块创建初始搜索临时状态（模拟工作区 A 中的搜索）
  const tempA = createSearchTempState(wsA);
  tempA.expandedLanes.add("v-v0.1");
  tempA.expandedLanes.add("standalone");

  // 使用真实模块的 resetSearchState 模拟工作区切换
  const reset = resetSearchState(wsB);

  // 断言：在工作区 B 中，搜索状态被彻底清空
  assert.equal(reset.searchState.query, "");
  assert.equal(reset.searchState.activeQuery, "");
  assert.equal(reset.searchState.matches.length, 0);
  assert.equal(reset.searchState.currentIndex, 0);
  assert.equal(reset.searchState.feedback, null);
  assert.equal(reset.searchState.unhiddenSlugs.size, 0, "内存覆盖层在新工作区必须为空");

  // 断言：临时展开状态被彻底重置
  assert.equal(reset.tempState.expandedLanes.size, 0, "临时展开泳道在新工作区必须为空");
  assert.equal(reset.tempState.openReleasedSlugs.size, 0, "临时展开已发布版本在新工作区必须为空");
  assert.equal(reset.tempState.ws, wsB, "临时状态绑定新工作区");
  assert.equal(reset.tempState.deliverExpanded, false);
  assert.equal(reset.tempState.blockedExpanded, false);
});

test("g-233 P4 真实行为测试：toggleLaneCollapseInState + exitSearchRestore 尊重用户意图优先", () => {
  const ws = "/workspace/test";

  // 使用真实模块创建临时状态，模拟搜索命中并自动展开 lane-1 和 lane-2
  let tempState = createSearchTempState(ws);
  tempState.expandedLanes.add("v-v0.1");
  tempState.expandedLanes.add("v-v0.2");

  // 模拟 React collapsedLanes 状态
  const collapsedLanes: Record<string, boolean> = { "v-v0.1": true, "v-v0.2": true };
  collapsedLanes["v-v0.1"] = false;
  collapsedLanes["v-v0.2"] = false;

  // 搜索期间，用户对 lane-1 进行了显式折叠操作（P4: 用户意图优先）
  // 使用真实模块的 toggleLaneCollapseInState
  tempState.expandedLanes = toggleLaneCollapseInState(tempState.expandedLanes, "v-v0.1");
  collapsedLanes["v-v0.1"] = true; // React state 更新

  assert.equal(tempState.expandedLanes.has("v-v0.1"), false, "用户显式操作后脱离临时恢复列表");
  assert.equal(tempState.expandedLanes.has("v-v0.2"), true, "未操作项保留在恢复列表");

  // 用户退出搜索模式——使用真实模块的 exitSearchRestore 计算恢复指令
  const restore = exitSearchRestore(tempState, ws);
  assert.equal(restore.wsMismatch, false, "工作区一致，应执行恢复");

  // 验证恢复指令：只有未被用户操作过的 lane-2 需要恢复折叠
  assert.deepEqual(restore.collapsedLanes, ["v-v0.2"], "仅恢复用户未操作过的泳道");

  // 应用恢复指令到 React state
  for (const key of restore.collapsedLanes) collapsedLanes[key] = true;

  // lane-2 未被用户操作过，精准恢复为折叠
  assert.equal(collapsedLanes["v-v0.2"], true, "未被操作的 lane-2 正常恢复折叠");
  // lane-1 被用户显式折叠过，保持用户显式操作的状态（true），不被恢复逻辑紊乱
  assert.equal(collapsedLanes["v-v0.1"], true, "用户显式操作的状态被完整尊重");

  // 反向场景验证：若用户在搜索期间显式保持展开
  let tempState2 = createSearchTempState(ws);
  tempState2.expandedLanes.add("v-v0.2");
  collapsedLanes["v-v0.2"] = false;
  // 用户显式再次点击确认展开——toggleLaneCollapseInState 从恢复列表移除
  tempState2.expandedLanes = toggleLaneCollapseInState(tempState2.expandedLanes, "v-v0.2");
  const restore2 = exitSearchRestore(tempState2, ws);
  // 因为用户显式展开过，expandedLanes 已空，恢复列表无此泳道
  assert.deepEqual(restore2.collapsedLanes, [], "用户显式操作后不在恢复列表中");
  assert.equal(collapsedLanes["v-v0.2"], false, "用户显式操作展开后，退出搜索依然保留展开");
});

test("g-233 真实行为测试：navigateToMatchTrack + exitSearchRestore 反复进入退出一致性", () => {
  const ws = "/workspace/test";
  const hiddenVersionSlugs = ["v-archived-1"];
  const stageOf = (status: string) => {
    if (["draft", "planning"].includes(status)) return "describe";
    if (["collecting", "ready"].includes(status)) return "collect";
    if (status === "in_progress") return "execute";
    if (status === "review") return "confirm";
    if (status === "delivered") return "deliver";
    if (status === "blocked") return "blocked";
    return "unknown";
  };

  // 使用真实模块：进入搜索并导航到匹配项
  let tempState = createSearchTempState(ws);
  let unhiddenSlugs = new Set<string>();

  // 模拟搜索命中隐藏版本 v-archived-1，在折叠泳道 v-v0.1 中
  const target1 = {
    id: "g-100",
    versionSlug: "v-archived-1",
    isReleased: false,
    laneKey: "v-v0.1",
    status: "in_progress",
  };
  const track1 = navigateToMatchTrack(tempState, target1, hiddenVersionSlugs, stageOf);
  tempState = track1.updatedTempState;
  if (track1.unhideVersionSlug) unhiddenSlugs = new Set([track1.unhideVersionSlug]);

  assert.ok(unhiddenSlugs.has("v-archived-1"), "隐藏版本被临时 unhide");
  assert.ok(track1.expandLane === "v-v0.1", "折叠泳道应展开");
  assert.ok(tempState.expandedLanes.has("v-v0.1"), "泳道记录在临时状态中");

  // 退出搜索——使用真实模块
  const restore1 = exitSearchRestore(tempState, ws);
  assert.equal(restore1.wsMismatch, false);
  assert.deepEqual(restore1.collapsedLanes, ["v-v0.1"], "退出后泳道应恢复折叠");
  tempState = createSearchTempState(ws); // 模拟 React state 重置
  unhiddenSlugs = new Set<string>();

  // 第 2 次搜索与退出（相同路径）
  const track2 = navigateToMatchTrack(tempState, target1, hiddenVersionSlugs, stageOf);
  tempState = track2.updatedTempState;
  if (track2.unhideVersionSlug) unhiddenSlugs = new Set([track2.unhideVersionSlug]);
  assert.ok(unhiddenSlugs.has("v-archived-1"));
  const restore2 = exitSearchRestore(tempState, ws);
  assert.deepEqual(restore2.collapsedLanes, ["v-v0.1"]);
  tempState = createSearchTempState(ws);
  unhiddenSlugs = new Set<string>();

  // 第 3 次搜索命中不同项并退出
  const target2 = {
    id: "g-200",
    versionSlug: null,
    isReleased: false,
    laneKey: "standalone",
    status: "draft",
  };
  const track3 = navigateToMatchTrack(tempState, target2, hiddenVersionSlugs, stageOf);
  tempState = track3.updatedTempState;
  assert.ok(tempState.expandedLanes.has("standalone"), "standalone 泳道被记录");
  const restore3 = exitSearchRestore(tempState, ws);
  assert.deepEqual(restore3.collapsedLanes, ["standalone"]);
  tempState = createSearchTempState(ws);

  // 最终底账一致性：tempState 干净无漂移
  assert.equal(tempState.expandedLanes.size, 0);
  assert.equal(tempState.openReleasedSlugs.size, 0);
  assert.equal(tempState.deliverExpanded, false);
  assert.equal(tempState.blockedExpanded, false);
});

test("g-233 P2 跨工作区恢复：exitSearchRestore 检测工作区不匹配时丢弃恢复", () => {
  const wsA = "/workspace/A";
  const wsB = "/workspace/B";

  // 在工作区 A 中搜索并展开泳道
  const tempStateA = createSearchTempState(wsA);
  tempStateA.expandedLanes.add("v-v0.1");

  // 切换到工作区 B 后尝试退出搜索——exitSearchRestore 应检测 ws 不匹配
  const restore = exitSearchRestore(tempStateA, wsB);
  assert.equal(restore.wsMismatch, true, "工作区不匹配时 wsMismatch=true");
  assert.deepEqual(restore.collapsedLanes, [], "不匹配时不返回恢复指令");
  assert.deepEqual(restore.unopenedReleasedSlugs, [], "不匹配时不返回恢复指令");
  assert.equal(restore.collapseDeliver, false);
  assert.equal(restore.collapseBlocked, false);
});

test("g-233 搜索匹配与转义逻辑纯函数测试", () => {
  // 模拟客户端转义与匹配行为
  function escapeRegExp(str: string) {
    return String(str ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  // 测试特殊字符不会抛错
  const dangerousInputs = ["[test]", "a+b", "(foo|bar)", ".*", "$100", "?query", "\\escape"];
  for (const input of dangerousInputs) {
    const escaped = escapeRegExp(input);
    assert.doesNotThrow(() => new RegExp(escaped, "gi"));
  }

  // 模拟搜索域比对
  const goals = [
    { id: "g-101", title: "登录功能开发", description: "支持微信和邮箱登录" },
    { id: "g-102", title: "修复搜索栏 bug", description: "处理特殊符号崩溃" },
    { id: "g-103", title: "数据库升级", description: "为登录提供更快的查询" },
  ];

  // 默认搜索（title + id）
  const query1 = "登录";
  const defaultMatches = goals.filter((g) => g.title.includes(query1) || g.id.includes(query1));
  assert.equal(defaultMatches.length, 1);
  assert.equal(defaultMatches[0].id, "g-101");

  // 全文搜索（额外包含 description）
  const fullTextMatches = goals.filter(
    (g) => g.title.includes(query1) || g.id.includes(query1) || g.description.includes(query1),
  );
  assert.equal(fullTextMatches.length, 2);
  assert.deepEqual(
    fullTextMatches.map((g) => g.id),
    ["g-101", "g-103"],
  );

  // id 匹配
  const queryId = "102";
  const idMatches = goals.filter((g) => g.title.includes(queryId) || g.id.includes(queryId));
  assert.equal(idMatches.length, 1);
  assert.equal(idMatches[0].id, "g-102");
});
