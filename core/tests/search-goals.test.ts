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
  assert.match(kanban, /unhiddenSlugs/);
  assert.match(kanban, /expandedLanes/);
  assert.match(kanban, /openReleasedSlugs/);
  assert.match(bundle, /tempExpandedRef/);
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
