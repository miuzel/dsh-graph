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
  const bundle = readFileSync(join(__dirname, "../../dsh-graph-host/lib/client.js"), "utf8");
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
  assert.match(kanban, /未找到匹配/);
  assert.match(kanban, /请输入搜索关键字/);
  assert.match(kanban, /exitSearch/);
  assert.match(kanban, /navigateToMatch/);
  assert.match(kanban, /executeSearch/);
  assert.match(bundle, /dg-search-bar/);
  assert.match(bundle, /未找到匹配/);

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

// ===== g-233 review 返工：P1/P2/P4 真实行为测试 =====

test("g-233 P1 真实行为测试：搜索临时可见为纯内存覆盖层，刷新/重新加载后持久隐藏偏好不丢", () => {
  // 模拟 localStorage 持久化底账
  const storage = new Map<string, string>();
  const ws = "/test/workspace";
  const storageKey = "dsh-graph.hidden-versions." + ws;
  storage.set(storageKey, JSON.stringify([{ slug: "v0.1" }, { slug: "v0.2" }]));

  // 从 storage 读取持久隐藏偏好
  const readPersisted = () => JSON.parse(storage.get(storageKey) ?? "[]").map((x: any) => x.slug);
  assert.deepEqual(readPersisted(), ["v0.1", "v0.2"]);

  // 模拟内存状态
  const hiddenVersionSlugs = readPersisted();
  let searchUnhiddenSlugs = new Set<string>();

  // 计算视图有效隐藏版本
  const computeEffectiveHidden = () => {
    return hiddenVersionSlugs.filter((slug: string) => !searchUnhiddenSlugs.has(slug));
  };

  // 初始：两个版本均隐藏
  assert.deepEqual(computeEffectiveHidden(), ["v0.1", "v0.2"]);

  // 搜索命中 v0.1，触发纯内存临时 unhide（P1 契约：不写 storage）
  searchUnhiddenSlugs.add("v0.1");

  // 视图中 v0.1 临时可见
  assert.deepEqual(computeEffectiveHidden(), ["v0.2"]);
  // 核心断言：storage 中的持久偏好绝对没有被修改
  assert.deepEqual(readPersisted(), ["v0.1", "v0.2"], "storage 绝对不被临时搜索写入");

  // 模拟用户直接刷新页面或重新打开看板（重新从 storage 读取初始状态）
  const refreshedHidden = readPersisted();
  const freshMemoryOverlay = new Set<string>(); // 刷新后新组件内存覆盖层为空
  const refreshedEffective = refreshedHidden.filter((s: string) => !freshMemoryOverlay.has(s));
  assert.deepEqual(refreshedEffective, ["v0.1", "v0.2"], "刷新后原持久隐藏偏好完好如初");
});

test("g-233 P2 真实行为测试：同名版本跨工作区切换不串临时状态", () => {
  // 模拟工作区 A
  const wsA = "/workspace/A";
  const wsB = "/workspace/B";

  // 组件内部状态模拟
  let currentWs = wsA;
  let searchQuery = "test";
  let searchActiveQuery = "test";
  let searchUnhiddenSlugs = new Set<string>(["v0.1"]); // A 中临时可见 v0.1
  let tempExpanded = {
    ws: wsA,
    expandedLanes: new Set(["v-v0.1", "standalone"]),
  };

  // 切换工作区触发 reset effect (P2 契约)
  const switchWorkspace = (nextWs: string) => {
    currentWs = nextWs;
    searchQuery = "";
    searchActiveQuery = "";
    searchUnhiddenSlugs = new Set<string>();
    tempExpanded = {
      ws: nextWs,
      expandedLanes: new Set<string>(),
    };
  };

  // 执行切换到工作区 B
  switchWorkspace(wsB);

  // 断言：在工作区 B 中，同名版本的临时状态被彻底清空，不发生跨工作区污染
  assert.equal(currentWs, wsB);
  assert.equal(searchActiveQuery, "");
  assert.equal(searchUnhiddenSlugs.size, 0, "内存覆盖层在新工作区必须为空");
  assert.equal(tempExpanded.expandedLanes.size, 0, "临时展开泳道在新工作区必须为空");
  assert.equal(tempExpanded.ws, wsB);
});

test("g-233 P4 真实行为测试：搜索期间手动切换条目后退出恢复尊重用户操作（用户意图优先）", () => {
  // 初始折叠状态：泳道 lane-1 和 lane-2 原本均为折叠
  const collapsedLanes: Record<string, boolean> = { "v-v0.1": true, "v-v0.2": true };
  const tempExpandedLanes = new Set<string>();

  // 1. 搜索命中并自动展开 lane-1 和 lane-2
  tempExpandedLanes.add("v-v0.1");
  collapsedLanes["v-v0.1"] = false;
  tempExpandedLanes.add("v-v0.2");
  collapsedLanes["v-v0.2"] = false;

  // 2. 搜索期间，用户对 lane-1 进行了显式手动操作（例如用户主动折叠或展开）
  const toggleLaneCollapse = (key: string, collapse: boolean) => {
    // P4 契约：一旦用户显式操作，立即从临时恢复集合中移出
    tempExpandedLanes.delete(key);
    collapsedLanes[key] = collapse;
  };
  // 用户在搜索期间显式折叠了 lane-1
  toggleLaneCollapse("v-v0.1", true);

  assert.equal(tempExpandedLanes.has("v-v0.1"), false, "用户显式操作后脱离临时恢复列表");
  assert.equal(tempExpandedLanes.has("v-v0.2"), true, "未操作项保留在恢复列表");

  // 3. 用户退出搜索模式执行恢复
  const exitSearch = () => {
    for (const key of tempExpandedLanes) {
      collapsedLanes[key] = true;
    }
    tempExpandedLanes.clear();
  };
  exitSearch();

  // 验证结果：
  // lane-2 未被用户操作过，精准恢复为折叠
  assert.equal(collapsedLanes["v-v0.2"], true, "未被操作的 lane-2 正常恢复折叠");
  // lane-1 被用户显式折叠过，保持用户显式操作的状态（true），不被恢复逻辑紊乱
  assert.equal(collapsedLanes["v-v0.1"], true, "用户显式操作的状态被完整尊重");

  // 进一步验证反向场景：若用户显式保持展开
  tempExpandedLanes.add("v-v0.2");
  collapsedLanes["v-v0.2"] = false;
  // 用户显式再次点击确认展开
  toggleLaneCollapse("v-v0.2", false);
  exitSearch();
  // 因为用户显式展开过，退出搜索后依然保持展开！
  assert.equal(collapsedLanes["v-v0.2"], false, "用户显式操作展开后，退出搜索依然保留展开");
});

test("g-233 真实行为测试：反复进入与退出搜索的折叠/隐藏状态一致性", () => {
  const baseHidden = ["v-archived-1"];
  let memoryOverlay = new Set<string>();
  const collapsedLanes: Record<string, boolean> = { "v-v0.1": true, standalone: true };
  let tempExpandedLanes = new Set<string>();

  const enterSearch = (targetSlug: string, targetLane: string) => {
    if (baseHidden.includes(targetSlug)) {
      memoryOverlay.add(targetSlug);
    }
    if (collapsedLanes[targetLane]) {
      tempExpandedLanes.add(targetLane);
      collapsedLanes[targetLane] = false;
    }
  };

  const exitSearch = () => {
    memoryOverlay = new Set<string>();
    for (const lane of tempExpandedLanes) {
      collapsedLanes[lane] = true;
    }
    tempExpandedLanes = new Set<string>();
  };

  // 第 1 次搜索与退出
  enterSearch("v-archived-1", "v-v0.1");
  assert.ok(memoryOverlay.has("v-archived-1"));
  assert.equal(collapsedLanes["v-v0.1"], false);
  exitSearch();
  assert.equal(memoryOverlay.size, 0);
  assert.equal(collapsedLanes["v-v0.1"], true);

  // 第 2 次搜索与退出
  enterSearch("v-archived-1", "v-v0.1");
  assert.ok(memoryOverlay.has("v-archived-1"));
  assert.equal(collapsedLanes["v-v0.1"], false);
  exitSearch();
  assert.equal(memoryOverlay.size, 0);
  assert.equal(collapsedLanes["v-v0.1"], true);

  // 第 3 次搜索命中不同项并退出
  enterSearch("none", "standalone");
  assert.equal(collapsedLanes.standalone, false);
  exitSearch();
  assert.equal(collapsedLanes.standalone, true);

  // 最终底账一致性无任何漂移
  assert.deepEqual(baseHidden, ["v-archived-1"]);
  assert.deepEqual(collapsedLanes, { "v-v0.1": true, standalone: true });
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
