/** g-145：收集子代理上下文注入测试
 *  测试 formatCollectPrompt 函数生成完整的收集提示词，
 *  包含仓库根、goal/card 元数据、回填模板和禁区。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { init, createGoal, findGoalFile, loadGoal, formatCollectPrompt, getCardMeta, fillCard, bindCardChild } from "../ops.ts";
import { readEvents } from "../events.ts";

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
  assert.ok(prompt.includes(`**工作目录**：当前分配的 worktree/当前工作目录（不要猜测 .dsh-graph 文件路径）`), "应包含工作目录说明");
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
  assert.ok(prompt.includes("所有 graph 工具操作必须在当前分配的 worktree/当前工作目录下运行"), "应包含工作目录运行要求");
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
  assert.ok(prompt.includes(`**工作目录**：当前分配的 worktree/当前工作目录（不要猜测 .dsh-graph 文件路径）`), "应包含工作目录说明");
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

// ---- fill_mismatch 绑定保护测试 ----

function setupCollectingCard() {
  const root = setup();
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  const goalFile = findGoalFile(root, goalId);
  const cardsDir = join(dirname(goalFile), "cards");
  if (!existsSync(cardsDir)) mkdirSync(cardsDir, { recursive: true });
  const cardId = "card-bind-test";
  const cardFile = join(cardsDir, `${cardId}.md`);
  writeFileSync(cardFile, `---\n{"id":"${cardId}","goal":"${goalId}","title":"绑定测试卡","kind":"text","status":"empty"}\n---\n\n`);
  // 绑定 child
  bindCardChild(root, goalId, cardId, { childId: "child-abc", parentSessionId: "parent-abc", actor: "test" });
  return { root, goalId, cardId };
}

test("fill_mismatch：绑定 child 正常填卡无 mismatch 事件", () => {
  const { root, goalId, cardId } = setupCollectingCard();
  fillCard(root, goalId, cardId, { text: "内容", summary: "摘要", by: "child-abc", actor: "agent:child-abc" });
  const events = readEvents(root).filter((e) => e.event === "card.fill_mismatch" && e.details?.card === cardId);
  assert.equal(events.length, 0, "绑定 child 填卡不应产生 mismatch");
  const cardDoc = loadGoal(join(dirname(findGoalFile(root, goalId)), "cards", `${cardId}.md`));
  assert.equal(cardDoc.meta.status, "filled");
});

test("fill_mismatch：陌生 actor 记 mismatch 但仍 filled", () => {
  const { root, goalId, cardId } = setupCollectingCard();
  fillCard(root, goalId, cardId, { text: "内容", summary: "摘要", by: "stranger-session", actor: "agent:stranger-session" });
  const mismatchEvents = readEvents(root).filter((e) => e.event === "card.fill_mismatch" && e.details?.card === cardId);
  assert.equal(mismatchEvents.length, 1, "陌生 actor 应产生 1 条 mismatch 事件");
  assert.equal(mismatchEvents[0].details.expected_child, "child-abc");
  const cardDoc = loadGoal(join(dirname(findGoalFile(root, goalId)), "cards", `${cardId}.md`));
  assert.equal(cardDoc.meta.status, "filled", "即使 mismatch 仍应 filled（不阻止）");
});

test("fill_mismatch：human:gui 正常回填无 mismatch", () => {
  const { root, goalId, cardId } = setupCollectingCard();
  fillCard(root, goalId, cardId, { text: "人工内容", summary: "人工摘要", by: "human:user1", actor: "human:gui" });
  const events = readEvents(root).filter((e) => e.event === "card.fill_mismatch" && e.details?.card === cardId);
  assert.equal(events.length, 0, "human:gui 回填不应产生 mismatch");
});

test("fill_mismatch：supervisor（agent:<session>）回填记 mismatch（by !== child_id）", () => {
  const { root, goalId, cardId } = setupCollectingCard();
  // supervisor 通过 graph_fill_card 调用时 actor 是 agent:<session>，by 是 session id
  fillCard(root, goalId, cardId, { text: "主管内容", summary: "主管摘要", by: "sess-supervisor", actor: "agent:sess-supervisor" });
  const events = readEvents(root).filter((e) => e.event === "card.fill_mismatch" && e.details?.card === cardId);
  // supervisor 的 by !== child_id 且 actor 不以 human: 开头 → 记 mismatch
  // 这是预期行为：supervisor 应先 bindCardChild 再 fillCard，或由主管手动 fill
  assert.equal(events.length, 1, "supervisor by !== child_id 应记 mismatch");
  const cardDoc = loadGoal(join(dirname(findGoalFile(root, goalId)), "cards", `${cardId}.md`));
  assert.equal(cardDoc.meta.status, "filled", "supervisor 回填仍应 filled");
});

test("fill_mismatch：by 为 agent:<child_id> 时正常回填无 mismatch（真实工具身份）", () => {
  const { root, goalId, cardId } = setupCollectingCard();
  // 真实工具调用时 by 是 "agent:<child_id>" 格式
  fillCard(root, goalId, cardId, { text: "工具内容", summary: "工具摘要", by: "agent:child-abc", actor: "agent:child-abc" });
  const events = readEvents(root).filter((e) => e.event === "card.fill_mismatch" && e.details?.card === cardId);
  assert.equal(events.length, 0, "by 为 agent:<child_id> 时不应产生 mismatch");
  const cardDoc = loadGoal(join(dirname(findGoalFile(root, goalId)), "cards", `${cardId}.md`));
  assert.equal(cardDoc.meta.status, "filled", "agent:<child_id> 回填应 filled");
});

test("fill_mismatch：by 为 agent:<other> 时记 mismatch", () => {
  const { root, goalId, cardId } = setupCollectingCard();
  // 其他 agent 的 by 是 "agent:<other>" 格式
  fillCard(root, goalId, cardId, { text: "其他内容", summary: "其他摘要", by: "agent:other-session", actor: "agent:other-session" });
  const events = readEvents(root).filter((e) => e.event === "card.fill_mismatch" && e.details?.card === cardId);
  assert.equal(events.length, 1, "by 为 agent:<other> 时应产生 mismatch");
  assert.equal(events[0].details.expected_child, "child-abc");
  const cardDoc = loadGoal(join(dirname(findGoalFile(root, goalId)), "cards", `${cardId}.md`));
  assert.equal(cardDoc.meta.status, "filled", "即使 mismatch 仍应 filled");
});

test("fill_mismatch：非 collecting 状态的卡片不触发 mismatch 检查", () => {
  const root = setup();
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  const goalFile = findGoalFile(root, goalId);
  const cardsDir = join(dirname(goalFile), "cards");
  if (!existsSync(cardsDir)) mkdirSync(cardsDir, { recursive: true });
  const cardId = "card-empty";
  const cardFile = join(cardsDir, `${cardId}.md`);
  writeFileSync(cardFile, `---\n{"id":"${cardId}","goal":"${goalId}","title":"空卡","kind":"text","status":"empty"}\n---\n\n`);
  fillCard(root, goalId, cardId, { text: "内容", summary: "摘要", by: "anyone", actor: "agent:anyone" });
  const events = readEvents(root).filter((e) => e.event === "card.fill_mismatch");
  assert.equal(events.length, 0, "empty 状态不应触发 mismatch 检查");
});
