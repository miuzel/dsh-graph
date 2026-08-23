/** g-145：收集子代理上下文注入测试
 *  测试 formatCollectPrompt 函数生成完整的收集提示词，
 *  包含仓库根、goal/card 元数据、回填模板和禁区。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { init, createGoal, findGoalFile, loadGoal, formatCollectPrompt, getCardMeta } from "../ops.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-collect-prompt-"));
  init(root);
  return root;
}

test("formatCollectPrompt 生成完整的收集提示词", () => {
  const root = setup();
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  const goalFile = findGoalFile(root, goalId);
  
  // 创建卡片
  const cardId = "card-123";
  const cardsDir = join(dirname(goalFile), "cards");
  if (!existsSync(cardsDir)) {
    mkdirSync(cardsDir, { recursive: true });
  }
  const cardFile = join(cardsDir, `${cardId}.md`);
  writeFileSync(cardFile, `---
{
  "id": "${cardId}",
  "goal": "${goalId}",
  "title": "测试卡片",
  "kind": "text",
  "status": "empty"
}
---

## 卡片内容
`);
  
  const prompt = formatCollectPrompt(root, goalId, cardId, "附加要求：请重点关注技术细节");
  
  // 验证提示词包含所有必要字段
  assert.ok(prompt.includes(`**仓库根目录**：\`${root}\``), "应包含仓库根目录");
  assert.ok(prompt.includes(`- id: \`${goalId}\``), "应包含 goal id");
  assert.ok(prompt.includes(`- 标题: 测试目标`), "应包含 goal 标题");
  assert.ok(prompt.includes(`- id: \`${cardId}\``), "应包含 card id");
  assert.ok(prompt.includes(`- 标题: 测试卡片`), "应包含 card 标题");
  assert.ok(prompt.includes(`- 类型: text`), "应包含 card 类型");
  assert.ok(prompt.includes(`graph_fill_card(goal="${goalId}", card="${cardId}", text=<全文>, summary=<≤100字摘要>)`), "应包含精确回填模板");
  assert.ok(prompt.includes("**禁区（严格遵守）**"), "应包含禁区说明");
  assert.ok(prompt.includes("不得猜测 `.dsh-graph` 文件路径"), "应包含路径猜测禁止");
  assert.ok(prompt.includes("不得修改其他 goal 或 card"), "应包含修改范围限制");
  assert.ok(prompt.includes("不得自行调用 `graph_review_card`"), "应包含 review 限制");
  assert.ok(prompt.includes("**用户附加要求**"), "应包含用户附加要求");
  assert.ok(prompt.includes("附加要求：请重点关注技术细节"), "应包含用户提供的附加要求内容");
});

test("formatCollectPrompt 无用户附加要求时省略该部分", () => {
  const root = setup();
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  const goalFile = findGoalFile(root, goalId);
  
  // 创建卡片
  const cardId = "card-456";
  const cardsDir = join(dirname(goalFile), "cards");
  if (!existsSync(cardsDir)) {
    mkdirSync(cardsDir, { recursive: true });
  }
  const cardFile = join(cardsDir, `${cardId}.md`);
  writeFileSync(cardFile, `---
{
  "id": "${cardId}",
  "goal": "${goalId}",
  "title": "测试卡片",
  "kind": "text",
  "status": "empty"
}
---

## 卡片内容
`);
  
  const prompt = formatCollectPrompt(root, goalId, cardId);
  
  // 验证提示词不包含用户附加要求部分
  assert.ok(!prompt.includes("**用户附加要求**"), "不应包含用户附加要求部分");
  assert.ok(prompt.includes(`**仓库根目录**：\`${root}\``), "应包含仓库根目录");
  assert.ok(prompt.includes(`graph_fill_card(goal="${goalId}", card="${cardId}", text=<全文>, summary=<≤100字摘要>)`), "应包含精确回填模板");
});

test("getCardMeta 返回正确的卡片元数据", () => {
  const root = setup();
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  const goalFile = findGoalFile(root, goalId);
  
  // 创建卡片
  const cardId = "card-789";
  const cardsDir = join(dirname(goalFile), "cards");
  if (!existsSync(cardsDir)) {
    mkdirSync(cardsDir, { recursive: true });
  }
  const cardFile = join(cardsDir, `${cardId}.md`);
  writeFileSync(cardFile, `---
{
  "id": "${cardId}",
  "goal": "${goalId}",
  "title": "测试卡片标题",
  "kind": "image",
  "status": "empty"
}
---

## 卡片内容
`);
  
  const meta = getCardMeta(root, goalId, cardId);
  
  assert.equal(meta.title, "测试卡片标题", "应返回正确的卡片标题");
  assert.equal(meta.kind, "image", "应返回正确的卡片类型");
  assert.equal(meta.goalTitle, "测试目标", "应返回正确的目标标题");
});

test("formatCollectPrompt 处理不存在的卡片", () => {
  const root = setup();
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  
  assert.throws(
    () => formatCollectPrompt(root, goalId, "non-existent-card"),
    /卡片不存在：non-existent-card/,
    "应抛出卡片不存在错误"
  );
});
