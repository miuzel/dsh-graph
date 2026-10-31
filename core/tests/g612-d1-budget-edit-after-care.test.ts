/**
 * g-612 D1（返工）：首次自然关照（goal 预算 30s）→ 公开窄工具回 unknown（锁保持 0、进入复查）
 * → 公开 graph_set_goal_budget 设 120 → 公开 care/status 的截止必须是
 * 「最近派发/主管消息 base + 120s」，而不是无变化的 lastCareAt+300s。
 * 语义依据（负责人已确认）：显式预算编辑/主管消息是**最新**基准，g506 的 300s 无答下限只约束
 * 「无新消息/无预算编辑」的后续复查；三次无有效结论封顶与人工锁仍然保留。
 * 真实 0.2.1-rc.2 公开宿主 + fake adapter + 真实 public tools；真实 timer（30s 首照）；
 * 不联网/真实 provider/真实 3120/3130/用户会话。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | null>, label: string, timeoutMs = 60000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`等待超时：${label}`);
}

test("D1 owner 规则：首次关照后 unknown（复查态）→ goal 预算 30→120 必须立即按 base+120 重算，而非 lastCare+300", async () => {
  const h = await makeRealHost({
    sessionQuery: true,
    projectYaml: "supervisor:\n  session: sess-super\n  care: \"true\"\n  care_threshold_seconds: 300\n  care_recheck_seconds: 300\n",
  });
  const sig = () => new AbortController().signal;
  const exec = () => ({ agent: h.parent, signal: sig() });
  const care = async () => (await h.tools.get("graph_get_settings").execute({}, exec())).supervisor_care;
  try {
    const goal = await makeGoal(h, "D1 owner recalc");
    await h.tools.get("graph_set_goal_budget").execute({ goal, budget_seconds: 30 }, exec());
    assert.equal((await h.tools.get("graph_claim_supervisor").execute({}, exec())).supervisor_session, h.parent.id);
    h.fake.hold("D1-CHILD");
    const d: any = await h.dispatch(goal, "D1-CHILD real care", { worktree: false });
    const childId = String(d.child_id ?? "");
    assert.ok(childId);
    const t0 = Date.now();
    await waitFor(async () => (h.childLive(childId) === "running" ? true : null), "child running");
    const first: any = await waitFor(async () => {
      const st: any = await care();
      const t = (st.tasks ?? []).find((x: any) => x.child === childId);
      return t && t.dueInMs > 0 && t.dueInMs <= 41_000 ? { st, t } : null;
    }, "task budget countdown 30s");
    const base = Number(first.t.budget_base_at);
    assert.ok(Number.isFinite(base) && base > 0, "base 可观察");
    console.log(`[D1] t0=${t0} base=${base} first.dueInMs=${first.t.dueInMs} budget=${first.t.effective_budget_seconds}`);

    // 等待真实首次自然关照投递（goal 预算 30s；项目 recheck 300s 不会先触发）
    const insp: any = await waitFor(async () => {
      const st: any = await care();
      return (st.pending_inspections ?? []).find((i: any) => (i.targets ?? []).some((x: any) => x.child === childId)) ?? null;
    }, "first care delivered", 60000);
    const deliveredAt = Date.now();
    console.log(`[D1] first care delivered at ${deliveredAt} (+${deliveredAt - t0}ms), inspection=${insp.id}`);

    // 公开窄工具回 unknown（锁保持 0；进入 300s 复查）
    const outcomeAt = Date.now();
    const out: any = await h.tools.get("graph_care_outcome").execute({
      inspection: insp.id, goal, attempt: String(d.attempt ?? "att-001"), child: childId,
      outcome: "unknown", evidence: "D1 owner 复核：首次关照后无有效结论（真实 unknown）",
    }, exec());
    assert.equal(out.ok, true, `unknown 必须被受理：${JSON.stringify(out)}`);
    const afterOutcome: any = await care();
    const tOut: any = (afterOutcome.tasks ?? []).find((x: any) => x.child === childId);
    assert.ok(tOut, "任务仍在采样");
    assert.equal(tOut.human_locked, false, "unknown 不得上锁");
    assert.equal(tOut.stagnant_rounds, 0, "unknown 不得计无进展");
    assert.equal(tOut.budget_countdown, false, "结论后进入复查态（候选当前行为）");
    const lastCare = Number(tOut.last_care_at);
    const recheckDue = lastCare + 300_000;
    const dueBefore = afterOutcome.server_now + Number(tOut.dueInMs);
    console.log(`[D1] after unknown: lastCare=${lastCare} budget_countdown=${tOut.budget_countdown} dueInMs=${tOut.dueInMs} dueAt=${dueBefore} (lastCare+300=${recheckDue})`);
    assert.ok(Math.abs(dueBefore - recheckDue) <= 2_000, "当前先落在 lastCare+300 复查（候选当前行为，作为对照基线）");

    // 下一秒公开 graph_set_goal_budget 30→120
    const editAt = Date.now();
    const set: any = await h.tools.get("graph_set_goal_budget").execute({ goal, budget_seconds: 120 }, exec());
    assert.equal(set.new_seconds, 120);
    const afterEdit: any = await care();
    const tEdit: any = (afterEdit.tasks ?? []).find((x: any) => x.child === childId);
    assert.ok(tEdit);
    const serverNow = Number(afterEdit.server_now);
    const dueAt = serverNow + Number(tEdit.dueInMs);
    const expected = Number(tEdit.budget_base_at) + 120_000;
    console.log(`[D1] edit at ${editAt} (+${editAt - t0}ms): base=${tEdit.budget_base_at} countdown=${tEdit.budget_countdown} effective=${tEdit.effective_budget_seconds} dueInMs=${tEdit.dueInMs} dueAt=${dueAt}`);
    console.log(`[D1] owner expected = base+120s = ${expected} (now=${serverNow}, expect dueInMs≈${expected - serverNow})；bug 对照 = lastCare+300 = ${recheckDue}`);
    assert.equal(tEdit.budget_seconds, 120, "goal 预算真源已更新");
    assert.equal(tEdit.effective_budget_seconds, 120, "生效预算已更新");
    assert.equal(tEdit.budget_countdown, true, "按 owner 规则应重新进入预算倒计时");
    assert.ok(Math.abs(dueAt - expected) <= 2_000,
      `owner 规则：预算编辑后截止必须=base+120s（expected≈${expected}，实得 dueAt=${dueAt}，dueInMs=${tEdit.dueInMs}，bug=lastCare+300=${recheckDue}）`);
    assert.notEqual(Math.abs(dueAt - recheckDue) <= 2_000, true, "不得仍停在 lastCare+300 复查");
  } finally {
    h.fake.releaseAll();
    try { await h.shutdown(); } catch {}
  }
});
