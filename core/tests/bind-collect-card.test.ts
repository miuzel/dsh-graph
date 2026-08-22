/** g-119：graph_bind_collect_card 工具（host）单测。
 *  验证：① 工具注册（参数 schema：goal/card/child_id 必填，parent_session_id 可选）；
 *  ② 执行成功：卡片 meta 写 child_id/parent_session_id、status=collecting，
 *     card.collecting 事件恰 1 条（事件先行，R-02）；
 *  ③ 幂等：同参重复绑定为 no-op（不重复记事件）；换 child（重新收集）仍正常记事件；
 *  ④ 缺参（缺 goal/card/child_id）报错；卡片不存在报错；
 *  ⑤ parent_session_id 缺省取当前会话 id，显式传入优先；
 *  ⑥ core bindCardChild 幂等（直调核心层验证）；
 *  ⑦ supervisor-guide.md 信息收集规范含绑定硬约束文本（未绑定即流程违规 + parentSession 反查 + 禁止推断）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { init, createGoal, addCard, findGoalFile, loadGoal, bindCardChild } from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dsh-graph-host/index.js";

/** 临时图根 + mock ctx 应用插件，返回 { root, byName }（byName 为工具名 → 定义）。 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-bind-"));
  init(root);
  const registered: any[] = [];
  const ctx: any = {
    get: () => undefined, // 无 subagents / skills / webServer 等服务
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (def: any) => { registered.push(def); return () => {}; },
      get: () => ({}),
    },
  };
  apply(ctx, { root });
  return { root, byName: new Map(registered.map((d) => [d.name, d])) };
}

const exec = (sessionId?: string) => ({
  agent: sessionId ? { id: "a1", session: { id: sessionId } } : undefined,
  signal: new AbortController().signal,
});

const collectEvents = (root: string, goal: string) =>
  readEvents(root).filter((e) => e.event === "card.collecting" && e.goal === goal);

const cardMeta = (root: string, goal: string, card: string) =>
  loadGoal(join(dirname(findGoalFile(root, goal)!), "cards", `${card}.md`)).meta;

test("g-119 ① 工具注册：graph_bind_collect_card 已注册，goal/card/child_id 必填、parent_session_id 可选", () => {
  const { byName } = setup();
  const t = byName.get("graph_bind_collect_card");
  assert.ok(t, "graph_bind_collect_card 应已注册");
  assert.deepEqual(t.parameters.required, ["goal", "card", "child_id"]);
  assert.ok(t.parameters.properties.parent_session_id, "parent_session_id 应为可选参数");
});

test("g-119 ② 执行成功：写 child_id/parent_session_id/status=collecting，card.collecting 事件恰 1 条", async () => {
  const { root, byName } = setup();
  const ex = exec("session-gui");
  const goal = (await byName.get("graph_create_goal").execute({ title: "t", version: "v-t" }, ex)).goal;
  const card = (await byName.get("graph_add_card").execute({ goal, title: "c", kind: "text" }, ex)).card;

  const out = await byName.get("graph_bind_collect_card").execute(
    { goal, card, child_id: "child-1", parent_session_id: "session-par" },
    ex,
  );
  assert.deepEqual(out, { ok: true, card, child_id: "child-1", parent_session_id: "session-par" });

  const meta = cardMeta(root, goal, card);
  assert.equal(meta.child_id, "child-1");
  assert.equal(meta.parent_session_id, "session-par");
  assert.equal(meta.status, "collecting");

  const evs = collectEvents(root, goal);
  assert.equal(evs.length, 1, "执行成功应写 card.collecting 事件恰 1 条");
  assert.equal(evs[0].details.card, card);
  assert.equal(evs[0].details.child_id, "child-1");
});

test("g-119 ③ 幂等：同参重复绑定不重复记事件；换 child（重新收集）仍正常记事件", async () => {
  const { root, byName } = setup();
  const ex = exec("session-gui");
  const goal = (await byName.get("graph_create_goal").execute({ title: "t", version: "v-t" }, ex)).goal;
  const card = (await byName.get("graph_add_card").execute({ goal, title: "c", kind: "text" }, ex)).card;
  const bind = (child_id: string) =>
    byName.get("graph_bind_collect_card").execute({ goal, card, child_id, parent_session_id: "session-par" }, ex);

  await bind("child-1");
  await bind("child-1"); // 同参重复 → 幂等 no-op
  assert.equal(collectEvents(root, goal).length, 1, "重复绑定同一 child 不重复记事件");

  await bind("child-2"); // 换 child → 重新收集，正常写
  const evs = collectEvents(root, goal);
  assert.equal(evs.length, 2);
  assert.equal(evs[1].details.child_id, "child-2");
  assert.equal(cardMeta(root, goal, card).child_id, "child-2");
});

test("g-119 ④ 缺参报错：缺 child_id / 缺 card / 缺 goal 抛错；卡片不存在抛错", async () => {
  const { root, byName } = setup();
  const ex = exec();
  const goal = (await byName.get("graph_create_goal").execute({ title: "t", version: "v-t" }, ex)).goal;
  const card = (await byName.get("graph_add_card").execute({ goal, title: "c", kind: "text" }, ex)).card;
  const bindTool = byName.get("graph_bind_collect_card");

  assert.throws(() => bindTool.execute({ goal, card }, ex), /缺参/); // 缺 child_id
  assert.throws(() => bindTool.execute({ goal, child_id: "c1" }, ex), /缺参/); // 缺 card
  assert.throws(() => bindTool.execute({ card, child_id: "c1" }, ex), /缺参/); // 缺 goal
  assert.throws(
    () => bindTool.execute({ goal, card: "card-nope", child_id: "c1" }, ex),
    /卡片不存在/,
  );
  assert.equal(collectEvents(root, goal).length, 0, "报错路径不得写事件");
});

test("g-119 ⑤ parent_session_id 缺省取当前会话 id；显式传入优先", async () => {
  const { root, byName } = setup();
  const ex = exec("session-me");
  const goal = (await byName.get("graph_create_goal").execute({ title: "t", version: "v-t" }, ex)).goal;
  const card = (await byName.get("graph_add_card").execute({ goal, title: "c", kind: "text" }, ex)).card;

  // 缺省：当前会话 id
  await byName.get("graph_bind_collect_card").execute({ goal, card, child_id: "child-d" }, ex);
  assert.equal(cardMeta(root, goal, card).parent_session_id, "session-me");

  // 显式传入优先（换 child，非幂等路径）
  await byName.get("graph_bind_collect_card").execute(
    { goal, card, child_id: "child-x", parent_session_id: "session-par" },
    ex,
  );
  assert.equal(cardMeta(root, goal, card).parent_session_id, "session-par");
});

test("g-119 ⑥ core bindCardChild 幂等（直调核心层）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-bind-core-"));
  init(root);
  const id = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  const card = addCard(root, id, { title: "c", kind: "text", actor: "test" });
  bindCardChild(root, id, card, { childId: "child-a", parentSessionId: "session-p", actor: "test" });
  bindCardChild(root, id, card, { childId: "child-a", parentSessionId: "session-p", actor: "test" }); // no-op
  assert.equal(collectEvents(root, id).length, 1, "同参重复绑定只记 1 条事件");
  bindCardChild(root, id, card, { childId: "child-a", parentSessionId: "session-other", actor: "test" }); // 换 parent → 正常写
  assert.equal(collectEvents(root, id).length, 2, "换 parent 应正常记事件");
  assert.equal(cardMeta(root, id, card).parent_session_id, "session-other");
});

test("g-119 ⑦ supervisor-guide.md 信息收集规范含绑定硬约束文本", () => {
  const guide = readFileSync(
    new URL("../../dsh-graph-host/supervisor-guide.md", import.meta.url),
    "utf8",
  );
  assert.ok(guide.includes("graph_bind_collect_card"), "guide 应引用 graph_bind_collect_card 工具");
  assert.ok(guide.includes("未绑定即流程违规"), "guide 应含「未绑定即流程违规」硬约束");
  assert.ok(guide.includes("parentSession"), "guide 应含 parentSession 反查（权威来源）");
  assert.ok(guide.includes("禁止按工作区+时间推断"), "guide 应禁止按工作区+时间推断");
});
