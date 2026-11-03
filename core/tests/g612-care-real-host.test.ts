/**
 * g-612 真实宿主（plugin apply 内的真实关照运行时）：
 * goal 预算立即生效、running steer 重置预算基准、同一 message.id 幂等、
 * run 起止来自公开 status 事件（observed），停止后保留有界 run 历史。
 *
 * 不等待 300s/120s 真实墙钟；只断言事件时点/基准与投影。全程 fake adapter，无网络/真实 provider。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { goalDetail } from "../ops.ts";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error(`等待超时：${label}`);
}

test("g-612 真实宿主：goal 预算 + 主管消息重置 + message.id 幂等 + run 状态/历史", async () => {
  const h = await makeRealHost({
    sessionQuery: true,
    projectYaml: "supervisor:\n  session: sess-super\n  care: \"true\"\n  care_threshold_seconds: 300\n",
  });
  try {
    const goal = await makeGoal(h, "g612 care binding");
    const setTool = h.tools.get("graph_set_goal_budget");
    const getSettings = async () => {
      const r = await h.tools.get("graph_get_settings").execute({}, {
        agent: h.parent, signal: new AbortController().signal,
      });
      return r.supervisor_care;
    };
    await setTool.execute({ goal, budget_seconds: 120 }, { agent: h.parent, signal: new AbortController().signal });

    h.fake.hold("G612-CHILD");
    const dispatched: any = await h.dispatch(goal, "G612-CHILD real care", { worktree: false });
    const childId = String(dispatched.child_id ?? "");
    assert.ok(childId);
    await waitFor(() => h.childLive(childId) === "running", "child running");
    const first = await getSettings();
    const t0 = (first.tasks ?? []).find((t: any) => t.child === childId);
    assert.ok(t0, "running child 必须进入 care tasks");
    assert.equal(t0.budget_seconds, 120);
    assert.equal(t0.effective_budget_seconds, 120);
    assert.equal(t0.budget_source, "goal");
    assert.equal(t0.budget_countdown, true);
    assert.ok(t0.run_started_at > 0, "run 起点必须来自可观察事件");
    assert.ok(["agent_status", "attempt_record"].includes(t0.run_start_source));
    assert.equal(typeof t0.run_start_exact, "boolean");

    const baseBefore = t0.budget_base_at;
    const msgId = await h.subagents.sendMessage(h.parent, childId, [{ type: "text", text: "G612 steer" }], {
      signal: new AbortController().signal,
    });
    assert.ok(msgId);
    await sleep(30);
    const second = await getSettings();
    const t1 = (second.tasks ?? []).find((t: any) => t.child === childId);
    assert.ok(t1, "running steer 后 task 仍在");
    assert.ok(t1.budget_base_at > baseBefore, "主管消息必须以新基准重置预算倒计时");
    assert.ok(t1.dueInMs > 0 && t1.dueInMs <= 120_000, "消息后按当前 goal 预算重算");
    assert.equal(t1.run_started_at, t0.run_started_at, "消息不得改变当前 run 起点");

    // 同一 message.id 重放（公开事件形状）⇒ 幂等，基准不变
    const childAgent = h.reg.get(childId);
    const replayPayload = {
      message: { id: msgId, source: { kind: "agent-message", form: "relay", senderSessionId: h.parent.id } },
      agent: childAgent,
    };
    h.ctx.emit("agent/inbox/inserted", replayPayload);
    await sleep(10);
    const third = await getSettings();
    const t2 = (third.tasks ?? []).find((t: any) => t.child === childId);
    assert.equal(t2.budget_base_at, t1.budget_base_at, "同一 message.id 不得二次重置");

    // goal 预算编辑立即按最近有效基准重算（base 不变，生效预算变）
    await setTool.execute({ goal, budget_seconds: 60 }, { agent: h.parent, signal: new AbortController().signal });
    await sleep(20);
    const fourth = await getSettings();
    const t3 = (fourth.tasks ?? []).find((t: any) => t.child === childId);
    assert.equal(t3.budget_seconds, 60);
    assert.equal(t3.effective_budget_seconds, 60);
    assert.equal(t3.budget_base_at, t2.budget_base_at, "预算编辑不得伪造新的消息基准");
    assert.ok(t3.dueInMs > 0 && t3.dueInMs <= 60_000, "预算编辑立即重算且不把过去墙钟算进去");

    // 自然停止：run 结束保留 observed/sample 来源的历史，不伪造精确时刻
    h.fake.releaseAll();
    await waitFor(() => h.childLive(childId) !== "running", "child stopped");
    await sleep(30);
    const last = await getSettings();
    assert.equal((last.tasks ?? []).some((t: any) => t.child === childId), false, "停止后 task 移出采样");
    const run = (last.runs ?? []).find((r: any) => r.child === childId);
    assert.ok(run, "停止后必须保留有界 run 历史");
    assert.ok(["agent_status", "disposed", "sample", "unknown"].includes(run.stop_source));
    assert.equal(typeof run.stop_exact, "boolean");
    assert.ok(run.natural_ms === null || run.natural_ms >= 0);
  } finally {
    h.fake.releaseAll();
    try { await h.shutdown(); } catch { /* ignore */ }
  }
});
