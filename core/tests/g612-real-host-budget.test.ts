/**
 * g-612 真实宿主：窄工具 `graph_set_goal_budget` 的写面/事件面/清空语义；
 * 确认它不改变派发参数、不把预算写进 child prompt、不额外调用模型。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { goalDetail } from "../ops.ts";
import { readEvents } from "../events.ts";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

test("g-612 真实宿主：graph_set_goal_budget 写 goal meta + 事件先行 + 清空继承；不派发/不加模型调用", async () => {
  const h = await makeRealHost({
    projectYaml: "supervisor:\n  session: sess-super\n  care: \"true\"\n",
  });
  try {
    const goal = await makeGoal(h, "g612 budget tool");
    const beforeCalls = h.fake.calls;
    const beforeAttempts = h.attempts(goal).length;
    const tool = h.tools.get("graph_set_goal_budget");
    assert.ok(tool, "工具必须注册");

    const r = await tool.execute(
      { goal, budget_seconds: 120 },
      { agent: h.parent, signal: new AbortController().signal },
    );
    assert.deepEqual(r, { ok: true, old_seconds: null, new_seconds: 120 });
    assert.equal(goalDetail(h.root, goal).meta.task_budget_seconds, 120);
    const ev = readEvents(h.root).filter((e: any) => e.event === "goal.budget_set");
    assert.equal(ev.length, 1);
    assert.equal(ev[0].details?.new_seconds, 120);
    assert.equal(h.fake.calls, beforeCalls, "不得额外调用模型");
    assert.equal(h.attempts(goal).length, beforeAttempts, "不得派发 attempt");

    // 同值幂等：不重复事件
    await tool.execute({ goal, budget_seconds: 120 }, { agent: h.parent, signal: new AbortController().signal });
    assert.equal(readEvents(h.root).filter((e: any) => e.event === "goal.budget_set").length, 1);

    // 非法值：工具拒绝、零写/零事件
    const before = goalDetail(h.root, goal).meta.task_budget_seconds;
    let invalidError = null;
    try {
      await tool.execute({ goal, budget_seconds: 29 }, { agent: h.parent, signal: new AbortController().signal });
    } catch (e) {
      invalidError = e;
    }
    assert.match(String(invalidError?.message ?? invalidError), /30–86400/);
    assert.equal(goalDetail(h.root, goal).meta.task_budget_seconds, before);
    assert.equal(readEvents(h.root).filter((e: any) => e.event === "goal.budget_set").length, 1);

    // 清空 → 继承
    const c = await tool.execute(
      { goal, budget_seconds: null },
      { agent: h.parent, signal: new AbortController().signal },
    );
    assert.deepEqual(c, { ok: true, old_seconds: 120, new_seconds: null });
    assert.equal(goalDetail(h.root, goal).meta.task_budget_seconds, undefined);
    assert.equal(h.fake.calls, beforeCalls, "清空也不得调用模型");
  } finally {
    h.fake.releaseAll();
    await h.shutdown();
  }
});
