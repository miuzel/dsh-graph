/**
 * g-612 返工（reviewer 实测 BLOCK ①）：一轮运行的预算历史必须是**起始生效值 + 运行中变化时间线**，
 * 不得把停止时刻的 goal 预算说成整轮预算。
 *
 * 断言（显式语义，不是“最后一个值不等于 600”）：
 * - run.budget_seconds = 起始 30、budget_source = goal（goal 仍是唯一可编辑真源）；
 * - run.budget_changes 恰有一条 {seconds:600, source:goal}，时点必须在真实编辑之后、停止之前
 *   （不允许用停止时 now / 当前 goal 值回填）；
 * - deviation_ms 语义 = natural_ms − **起始**预算（deviation_basis="initial"）；
 * - 正常 dispose/recreate 后从事件真源恢复同一历史（不回填旧快照）。
 *
 * 真实 0.2.1-rc.2 宿主栈 + fake adapter + 私有 tmp；不联网/真实 provider。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, label: string, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (cond()) return; await sleep(10); }
  throw new Error(`等待超时：${label}`);
}

const PROJECT = "supervisor:\n  session: sess-super\n  care: \"true\"\n  care_threshold_seconds: 300\n";

test("g-612 run 预算历史：起始 30→运行中 600，历史可查起点/变化时点/source/偏差语义", async () => {
  const h = await makeRealHost({ sessionQuery: true, projectYaml: PROJECT });
  let h2: any = null;
  const sig = () => new AbortController().signal;
  const getCare = async (host: any) => (await host.tools.get("graph_get_settings").execute({}, { agent: host.parent, signal: sig() })).supervisor_care;
  try {
    const goal = await makeGoal(h, "g612 run budget history");
    const set = (seconds: number) => h.tools.get("graph_set_goal_budget").execute({ goal, budget_seconds: seconds }, { agent: h.parent, signal: sig() });
    assert.equal((await set(30) as any).new_seconds, 30);
    h.fake.hold("G612-RUN-HISTORY");
    const d: any = await h.dispatch(goal, "G612-RUN-HISTORY", { worktree: false });
    const childId = String(d.child_id ?? "");
    assert.ok(childId);
    await waitFor(() => h.childLive(childId) === "running", "child running");
    const st0: any = await getCare(h);
    const t0: any = (st0.tasks ?? []).find((t: any) => t.child === childId);
    assert.ok(t0);
    assert.equal(t0.effective_budget_seconds, 30);
    assert.equal(t0.budget_source, "goal");
    const startedAt = Number(t0.run_started_at);
    assert.ok(startedAt > 0, "必须有可证 run 起点");

    // 运行中通过正式 goal 预算入口 30→600（唯一可编辑真源仍是 goal）。
    const editBefore = Date.now();
    assert.equal((await set(600) as any).new_seconds, 600);
    const editAfter = Date.now();
    await sleep(30);
    const t1: any = (await getCare(h)).tasks.find((t: any) => t.child === childId);
    assert.equal(t1.effective_budget_seconds, 600, "运行中预算立即生效");

    h.fake.releaseAll();
    await waitFor(() => h.childLive(childId) !== "running", "child stopped");
    await sleep(200);
    const st2: any = await getCare(h);
    const run: any = (st2.runs ?? []).find((r: any) => r.child === childId);
    assert.ok(run, "run 记录必须存在");
    assert.equal(run.budget_seconds, 30, "历史必须保留**起始**预算 30，不得用停止时 600 冒充整轮");
    assert.equal(run.budget_source, "goal", "起始预算来源必须是 goal");
    assert.deepEqual(run.budget_changes.map((c: any) => [c.seconds, c.source]), [[600, "goal"]],
      "必须能查到运行中 600 生效（恰一次）");
    const changeAt = Number(run.budget_changes[0].at);
    assert.ok(changeAt >= editBefore - 1_000 && changeAt <= editAfter + 2_000,
      `变化时点必须是真实编辑时点（edit≈${editBefore}，实得 ${changeAt}）`);
    assert.ok(Number(run.started_at) === startedAt, "起始时点必须是可证 run 起点");
    assert.ok(Number(run.stopped_at) >= Number(run.started_at));
    // 偏差语义显式：相对**起始**预算；不是相对停止时 goal 值。
    assert.equal(run.deviation_basis, "initial");
    assert.equal(Number(run.deviation_ms), Number(run.natural_ms) - 30_000,
      "deviation_ms 必须相对起始预算 30s 计算");
    assert.ok(Number(run.natural_ms) < 30_000, "本 run 自然耗时应远小于起始预算");
    assert.equal(run.over_budget, false);

    // 正常 dispose/recreate：同一项目事件真源恢复同一预算历史（旧快照不回填新值）。
    await h.shutdown();
    h2 = await makeRealHost({
      workspace: h.ws, sessionQuery: true, sessionId: "sess-super-2",
      projectYaml: PROJECT.replace("sess-super", "sess-super-2"),
    });
    const rst: any = await getCare(h2);
    const restored: any = (rst.runs ?? []).find((r: any) => r.child === childId);
    assert.ok(restored, "重启后 run 历史必须可读");
    assert.equal(restored.budget_seconds, 30, "重启恢复的是起始预算，不是当前 goal 600");
    assert.equal(restored.budget_source, "goal");
    assert.deepEqual(restored.budget_changes.map((c: any) => [c.seconds, c.source]), [[600, "goal"]],
      "重启后变化时间线不丢");
    assert.equal(Number(restored.budget_changes[0].at), changeAt, "变化时点必须逐字保留，不得用重启 now 覆盖");
  } finally {
    try { h.fake.releaseAll(); } catch {}
    try { await h.shutdown(); } catch {}
    if (h2) { try { h2.fake.releaseAll(); } catch {} try { await h2.shutdown(); } catch {} }
  }
});
