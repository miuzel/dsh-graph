/** g-304：graph_convert_card_to_shared / graph_convert_card_to_owned 工具封装测试。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, createGoal, setCriteria, transition, addCard, createSharedCard, addSharedCardRef, bindCardChild, referenceCount, sharedCards, loadGoal, findGoalFile } from "../ops.ts";
import { apply } from "../../dist/index.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g304-"));
  init(root);
  const registered: any[] = [];
  const ctx = {
    get: () => undefined,
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (def: any) => { registered.push(def); return () => {}; },
      get: () => ({}),
    },
  };
  apply(ctx as any, { root });
  const byName = new Map(registered.map((d: any) => [d.name, d]));
  const exec = { agent: undefined, signal: new AbortController().signal };
  const call = async (name: string, args: Record<string, unknown>) => {
    return await byName.get(name)!.execute(args, exec);
  };
  return { root, call };
}

/** 通过 goal 的 context_cards 获取当前引用的卡片 id 列表 */
function goalCardIds(root: string, goalId: string): string[] {
  const doc = loadGoal(findGoalFile(root, goalId));
  return Array.isArray(doc.meta.context_cards) ? [...doc.meta.context_cards] : [];
}

// ===== 成功路径 =====

test("graph_convert_card_to_shared：goal 自有卡 → 共享卡成功", async () => {
  const { root, call } = setup();
  const { goal } = await call("graph_create_goal", { title: "g304-1", version: "v-t" });
  await call("graph_set_criteria", { goal, criteria: ["ok"] });
  // g-137：带 version 的目标初始状态已是 planning，无需再迁移
  const { card } = await call("graph_add_card", { goal, title: "自有卡", scope: "goal" });
  const result = await call("graph_convert_card_to_shared", { goal, card });
  assert.deepEqual(result, { ok: true });
  // 转换后共享池应有 1 张卡
  const pool = sharedCards(root);
  assert.equal(pool.length, 1, "转换后共享池恰 1 张");
  assert.ok(pool[0].id.startsWith("shared-"), "新共享卡 id 应以 shared- 开头");
});

test("graph_convert_card_to_owned：共享卡 → goal 自有卡成功（引用计数=1）", async () => {
  const { root, call } = setup();
  const { goal } = await call("graph_create_goal", { title: "g304-2", version: "v-t" });
  await call("graph_set_criteria", { goal, criteria: ["ok"] });
  // 创建共享卡并挂到 goal
  const sid = createSharedCard(root, { title: "共享卡", actor: "test" });
  addSharedCardRef(root, goal, sid, "test");
  assert.equal(referenceCount(root, sid), 1);
  const result = await call("graph_convert_card_to_owned", { goal, card: sid });
  assert.deepEqual(result, { ok: true });
  // 转换后共享池应为空
  const pool = sharedCards(root);
  assert.equal(pool.length, 0, "转换后共享池应为空");
  // goal 的 context_cards 应包含一张 card-* 自有卡
  const refs = goalCardIds(root, goal);
  assert.equal(refs.length, 1);
  assert.ok(refs[0].startsWith("card-"), "转换后应以 card- 开头的自有卡 id");
});

// ===== collecting 状态拒绝 =====

test("graph_convert_card_to_shared：collecting 状态拒绝", async () => {
  const { root, call } = setup();
  const { goal } = await call("graph_create_goal", { title: "g304-3", version: "v-t" });
  await call("graph_set_criteria", { goal, criteria: ["ok"] });
  const { card } = await call("graph_add_card", { goal, title: "收集中的卡", scope: "goal" });
  await call("graph_bind_collect_card", { goal, card, child_id: "child-collect" });
  await assert.rejects(
    () => call("graph_convert_card_to_shared", { goal, card }),
    /正在收集中/,
  );
});

test("graph_convert_card_to_owned：collecting 状态拒绝", async () => {
  const { root, call } = setup();
  const { goal } = await call("graph_create_goal", { title: "g304-4", version: "v-t" });
  await call("graph_set_criteria", { goal, criteria: ["ok"] });
  const sid = createSharedCard(root, { title: "共享收集", actor: "test" });
  addSharedCardRef(root, goal, sid, "test");
  bindCardChild(root, goal, sid, { childId: "child-collect-2", actor: "test" });
  await assert.rejects(
    () => call("graph_convert_card_to_owned", { goal, card: sid }),
    /正在收集中/,
  );
});

// ===== shared→own 引用计数>1 拒绝 =====

test("graph_convert_card_to_owned：引用计数>1 拒绝", async () => {
  const { root, call } = setup();
  const { goal: goalA } = await call("graph_create_goal", { title: "g304-5a", version: "v-t" });
  const { goal: goalB } = await call("graph_create_goal", { title: "g304-5b", version: "v-t" });
  await call("graph_set_criteria", { goal: goalA, criteria: ["ok"] });
  await call("graph_set_criteria", { goal: goalB, criteria: ["ok"] });
  const sid = createSharedCard(root, { title: "被两个 goal 引用", actor: "test" });
  addSharedCardRef(root, goalA, sid, "test");
  addSharedCardRef(root, goalB, sid, "test");
  assert.equal(referenceCount(root, sid), 2);
  await assert.rejects(
    () => call("graph_convert_card_to_owned", { goal: goalA, card: sid }),
    /引用计数/,
  );
});

// ===== 参数缺失 =====

test("graph_convert_card_to_shared：缺少 goal 参数拒绝", async () => {
  const { call } = setup();
  await assert.rejects(
    () => call("graph_convert_card_to_shared", { card: "c-1" }),
    /goal/,
  );
});

test("graph_convert_card_to_shared：缺少 card 参数拒绝", async () => {
  const { call } = setup();
  const { goal } = await call("graph_create_goal", { title: "g304-6", version: "v-t" });
  await assert.rejects(
    () => call("graph_convert_card_to_shared", { goal }),
    /卡片|card/,
  );
});

test("graph_convert_card_to_owned：缺少 goal 参数拒绝", async () => {
  const { call } = setup();
  await assert.rejects(
    () => call("graph_convert_card_to_owned", { card: "shared-x" }),
    /goal/,
  );
});

test("graph_convert_card_to_owned：缺少 card 参数拒绝", async () => {
  const { call } = setup();
  const { goal } = await call("graph_create_goal", { title: "g304-7", version: "v-t" });
  await assert.rejects(
    () => call("graph_convert_card_to_owned", { goal }),
    /卡片|card/,
  );
});

// ===== 双向转换（round-trip）=====

test("双向转换：owned → shared → owned 完整往返", async () => {
  const { root, call } = setup();
  const { goal } = await call("graph_create_goal", { title: "g304-roundtrip", version: "v-t" });
  await call("graph_set_criteria", { goal, criteria: ["ok"] });
  const { card } = await call("graph_add_card", { goal, title: "往返测试", scope: "goal" });
  // owned → shared（card id 会变为 shared-*）
  await call("graph_convert_card_to_shared", { goal, card });
  // 获取转换后的共享卡 id
  const refs1 = goalCardIds(root, goal);
  assert.equal(refs1.length, 1);
  assert.ok(refs1[0].startsWith("shared-"), "owned→shared 后应为 shared-* id");
  const sharedId = refs1[0];
  // shared → owned（引用计数恰为 1）
  await call("graph_convert_card_to_owned", { goal, card: sharedId });
  const refs2 = goalCardIds(root, goal);
  assert.equal(refs2.length, 1);
  assert.ok(refs2[0].startsWith("card-"), "shared→owned 后应为 card-* id");
  const ownedId = refs2[0];
  // 再次 owned → shared
  await call("graph_convert_card_to_shared", { goal, card: ownedId });
  const refs3 = goalCardIds(root, goal);
  assert.ok(refs3[0].startsWith("shared-"), "第二次 owned→shared 后应为 shared-* id");
  // 最终 shared → owned
  await call("graph_convert_card_to_owned", { goal, card: refs3[0] });
  const refs4 = goalCardIds(root, goal);
  assert.ok(refs4[0].startsWith("card-"), "最终 shared→owned 后应为 card-* id");
});
