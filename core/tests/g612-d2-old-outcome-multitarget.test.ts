/**
 * g-612 D2（返工）：某 inspection 已真实 delivered 且仍 open（未提交结论），
 * 主管经公开 subagents.sendMessage 向同一 child 真送新消息（budgetBaseAt/scheduleDueAt=messageAt+goalBudget），
 * 随后对**先前那条** inspection 调真实 graph_care_outcome(unknown)。
 * 实现语义：按 stable message id 把该 target 标为 superseded ⇒ 晚到结论受理为**审计**
 * （ok:true, stale:true, applied:false），绝不清空/改写新消息基准的预算 deadline、计数或锁；
 * 同一批的其它 target 仍可正常回传有效结论（一条消息绝不整批作废）。
 * 真实 0.2.1-rc.2 公开宿主 + fake adapter + public tools/subagents；真实 timer（30s 首照）；
 * 不联网/真实 provider/真实服务/用户会话。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readEvents } from "../events.ts";
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

test("D2 owner 规则：旧 open inspection 的晚 unknown 不得覆盖之后主管消息建立的预算 deadline/计数/锁", async () => {
  const h = await makeRealHost({
    sessionQuery: true,
    projectYaml: "supervisor:\n  session: sess-super\n  care: \"true\"\n  care_threshold_seconds: 300\n  care_recheck_seconds: 300\n",
  });
  const sig = () => new AbortController().signal;
  const exec = () => ({ agent: h.parent, signal: sig() });
  const care = async () => (await h.tools.get("graph_get_settings").execute({}, exec())).supervisor_care;
  try {
    const goal = await makeGoal(h, "D2 owner old outcome");
    await h.tools.get("graph_set_goal_budget").execute({ goal, budget_seconds: 30 }, exec());
    assert.equal((await h.tools.get("graph_claim_supervisor").execute({}, exec())).supervisor_session, h.parent.id);
    h.fake.hold("D2-CHILD");
    const d: any = await h.dispatch(goal, "D2-CHILD real care", { worktree: false });
    const childId = String(d.child_id ?? "");
    const attempt = String(d.attempt ?? "att-001");
    assert.ok(childId);
    await waitFor(async () => (h.childLive(childId) === "running" ? true : null), "child running");
    // 一批多 target：第二个 goal/child 也处于同一关照周期（同一 inspection 覆盖两个 target）。
    const goalB = await makeGoal(h, "D2 owner old outcome B");
    await h.tools.get("graph_set_goal_budget").execute({ goal: goalB, budget_seconds: 30 }, exec());
    h.fake.hold("D2-CHILD-B");
    const dB: any = await h.dispatch(goalB, "D2-CHILD-B real care", { worktree: false });
    const childB = String(dB.child_id ?? "");
    const attemptB = String(dB.attempt ?? "att-001");
    assert.ok(childB);
    await waitFor(async () => (h.childLive(childB) === "running" ? true : null), "child B running");
    // 让两个任务在同一时刻获得新的预算基准（同一批 timer 到期 ⇒ 同一 inspection 覆盖两个 target）。
    // 真实公开 subagents.sendMessage（running steer）；不手造 care 状态。
    const preMsgs = await Promise.all([
      h.subagents.sendMessage(h.parent, childId, [{ type: "text", text: "D2 pre-align A" }], { signal: sig() }),
      h.subagents.sendMessage(h.parent, childB, [{ type: "text", text: "D2 pre-align B" }], { signal: sig() }),
    ]);
    assert.ok(preMsgs.every(Boolean));
    await sleep(100);
    const aligned: any = await care();
    const aPre: any = (aligned.tasks ?? []).find((x: any) => x.child === childId);
    const bPre: any = (aligned.tasks ?? []).find((x: any) => x.child === childB);
    assert.ok(aPre && bPre);
    assert.ok(Math.abs(Number(aPre.budget_base_at) - Number(bPre.budget_base_at)) <= 1_000, "两任务预算基准必须对齐（同一到期窗口）");

    // 两个 target 的 base 仍可能相差数毫秒：在最早到期瞬间让**真实主管** busy（公开 agent turn +
    // fake stream gate），宿主按 busyRecheck 延后一次；此时两个 target 都已到期 ⇒ 同一 inspection
    // 覆盖两个 target（真实生产批次语义，不手造 care 状态）。
    const dueAt = Math.min(Number(aPre.budget_base_at), Number(bPre.budget_base_at)) + 30_000;
    h.fake.hold();
    h.parent.send(h.modules.llm.createUserMessage({
      content: [{ type: "text", text: "D2 supervisor busy at due" }], source: { kind: "user" },
    }), "next-turn", true);
    await waitFor(() => h.parent.status === "running", "supervisor busy", 5_000);
    await sleep(Math.max(0, dueAt - Date.now() + 300));
    assert.equal(h.parent.status, "running", "到期时主管必须真实 busy（两个 target 延后到同一批）");
    h.fake.release();
    await waitFor(() => h.parent.status !== "running", "supervisor idle again", 5_000);

    // 真实首次关照 delivered（保持 open，不提交结论）；同一批必须覆盖两个 target。
    const insp: any = await waitFor(async () => {
      const st: any = await care();
      return (st.pending_inspections ?? []).find((i: any) => {
        const kids = (i.targets ?? []).map((x: any) => x.child);
        return kids.includes(childId) && kids.includes(childB);
      }) ?? null;
    }, "first care delivered/open (both targets)", 30_000);
    assert.equal((insp.targets ?? []).length, 2, "同一 inspection 必须覆盖两个真实 target");
    const inspectionDeliveredAt = Date.now();
    const beforeMsg: any = await care();
    const tBefore: any = (beforeMsg.tasks ?? []).find((x: any) => x.child === childId);
    assert.ok(tBefore);
    const lastCare = Number(tBefore.last_care_at);
    console.log(`[D2] inspection=${insp.id} deliveredAt=${inspectionDeliveredAt} lastCare=${lastCare} budget=${tBefore.effective_budget_seconds} countdown=${tBefore.budget_countdown}`);

    // 主管真送新消息（公开 subagents.sendMessage；running steer/queue）。
    // 预算保持 30s：新 deadline=base+30s 与 lastCare+300s 仍可区分；这样「旧巡检被消息取代」
    //（而不是被预算编辑取代）也被真实覆盖。
    const messageAt = Date.now();
    const msgId = await h.subagents.sendMessage(h.parent, childId, [{ type: "text", text: "D2 supervisor new message" }], { signal: sig() });
    assert.ok(msgId, "subagents.sendMessage 必须返回消息 id");
    await sleep(300);
    const afterMsg: any = await care();
    const tMsg: any = (afterMsg.tasks ?? []).find((x: any) => x.child === childId);
    assert.ok(tMsg);
    const expectedMsgDue = Number(tMsg.budget_base_at) + 30_000;
    const msgDueAt = Number(afterMsg.server_now) + Number(tMsg.dueInMs);
    console.log(`[D2] messageAt=${messageAt} base=${tMsg.budget_base_at} countdown=${tMsg.budget_countdown} effective=${tMsg.effective_budget_seconds} dueInMs=${tMsg.dueInMs} dueAt=${msgDueAt}`);
    assert.ok(Number(tMsg.budget_base_at) >= messageAt - 2_000, "新消息必须建立新 budgetBaseAt");
    assert.equal(tMsg.budget_countdown, true, "新消息后应处于预算倒计时");
    assert.ok(Math.abs(msgDueAt - expectedMsgDue) <= 2_000, `新消息 deadline 应为 base+30s（expected=${expectedMsgDue} actual=${msgDueAt}）`);
    assert.equal(tMsg.human_locked, false);
    assert.equal(tMsg.stagnant_rounds, 0);
    const remindersAfterMsg = tMsg.reminders_sent;
    // 未被消息触及的 target B：仍是复查态（消息只取代 A 的旧巡检，绝不整批作废）。
    const tB0: any = (afterMsg.tasks ?? []).find((x: any) => x.child === childB);
    assert.ok(tB0);
    assert.equal(tB0.budget_countdown, false, "B 未被主管消息重置，仍按复查间隔");

    // 旧 inspection 晚 unknown（真实公开窄工具；不手造事件）
    const outcomeAt = Date.now();
    let accepted = false;
    let result: any = null;
    try {
      result = await h.tools.get("graph_care_outcome").execute({
        inspection: insp.id, goal, attempt, child: childId,
        outcome: "unknown", evidence: "D2 owner 复核：旧 inspection 的晚结论（unknown）",
      }, exec());
      accepted = result?.ok === true;
    } catch (e) {
      result = { thrown: String((e as any)?.message ?? e) };
    }
    const afterOld: any = await care();
    const tOld: any = (afterOld.tasks ?? []).find((x: any) => x.child === childId);
    const oldDueAt = Number(afterOld.server_now) + Number(tOld?.dueInMs ?? NaN);
    const lastCareRecheck = lastCare + 300_000;
    console.log(`[D2] old outcome at ${outcomeAt} accepted=${accepted} result=${JSON.stringify(result)}`);
    console.log(`[D2] timing: inspectionDeliveredAt=${inspectionDeliveredAt} < messageAt=${messageAt} < outcomeAt=${outcomeAt}`);
    console.log(`[D2] after old outcome: base=${tOld?.budget_base_at} countdown=${tOld?.budget_countdown} dueInMs=${tOld?.dueInMs} dueAt=${oldDueAt} reminders=${tOld?.reminders_sent} locked=${tOld?.human_locked} stagnant=${tOld?.stagnant_rounds}`);
    console.log(`[D2] message deadline=${msgDueAt} (base+30=${expectedMsgDue})；lastCare+300=${lastCareRecheck}`);

    if (accepted) {
      const keepsMessageDeadline = tOld?.budget_countdown === true && Math.abs(oldDueAt - expectedMsgDue) <= 2_000;
      const clearsCounters = tOld?.reminders_sent !== remindersAfterMsg || tOld?.human_locked === true;
      assert.ok(keepsMessageDeadline,
        `旧 inspection（deliveredAt=${inspectionDeliveredAt} 早于 messageAt=${messageAt}）的晚 unknown 在 outcomeAt=${outcomeAt} 被受理，但覆盖了新消息的 budget deadline：countdown=${tOld?.budget_countdown}，dueAt=${oldDueAt}（新消息=base+30=${expectedMsgDue}，lastCare+300=${lastCareRecheck}）`);
      assert.equal(clearsCounters, false, "旧晚结论不得清/改计数或人工锁");
      // 语义必须机读明确：受理为审计（applied=false），且按 stable message id 指出取代事件。
      assert.equal(result.stale, true, "旧巡检晚结论必须标 stale");
      assert.equal(result.applied, false, "stale 结论不得应用到新状态");
      assert.equal(result.stale_reason, "superseded_by_message");
      assert.equal(result.stale_superseded_by, msgId, "superseded_by 必须是 stable message id（不是毫秒比较）");
    } else {
      const unchanged = Math.abs(oldDueAt - expectedMsgDue) <= 2_000 && tOld?.budget_countdown === true;
      assert.ok(unchanged, "旧结论被拒后新消息 deadline 必须原样保留");
    }

    // 同一批的另一个 target（未被消息触及）必须能正常回传有效结论：一条消息绝不整批作废。
    const bOut: any = await h.tools.get("graph_care_outcome").execute({
      inspection: insp.id, goal: goalB, attempt: attemptB, child: childB,
      outcome: "progress", evidence: "D2 owner 复核：B 有真实新增进展（B 未被主管消息触及）",
    }, exec());
    assert.equal(bOut.ok, true, `B 的结论必须被受理：${JSON.stringify(bOut)}`);
    assert.equal(bOut.counted, true, "B 的 progress 必须真实计数");
    assert.equal(bOut.stale, false, "B 未被消息取代，不得被标 stale");
    assert.equal(bOut.applied, true, "B 的结论必须真实应用");
    const afterB: any = await care();
    const tB: any = (afterB.tasks ?? []).find((x: any) => x.child === childB);
    assert.equal(tB?.reminders_sent, 0, "B 的有效结论归零未回复预算");
    assert.equal(tB?.stagnant_rounds, 0);
    assert.equal(tB?.budget_countdown, false, "B 仍按复查间隔（未被消息/预算编辑重置）");
    const tA2: any = (afterB.tasks ?? []).find((x: any) => x.child === childId);
    assert.equal(tA2?.budget_countdown, true, "B 的结论不得影响 A 的新消息基准");
    assert.ok(Math.abs((Number(afterB.server_now) + Number(tA2?.dueInMs ?? NaN)) - expectedMsgDue) <= 2_000);

    // 一次性幂等：同一 stale 结论 + 同一证据重放 ⇒ idempotent，且仍不改 A 的状态。
    const again: any = await h.tools.get("graph_care_outcome").execute({
      inspection: insp.id, goal, attempt, child: childId,
      outcome: "unknown", evidence: "D2 owner 复核：旧 inspection 的晚结论（unknown）",
    }, exec());
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true, "同结论+同证据必须幂等");
    assert.equal(again.stale, true);
    assert.equal(again.applied, false);
    const afterAgain: any = await care();
    const tA3: any = (afterAgain.tasks ?? []).find((x: any) => x.child === childId);
    assert.ok(Math.abs((Number(afterAgain.server_now) + Number(tA3?.dueInMs ?? NaN)) - expectedMsgDue) <= 2_000, "幂等重放不得改新 deadline");
    assert.equal(tA3?.reminders_sent, remindersAfterMsg);

    // 持久化证据：care.outcome 快照里的 inspection target 带 stale metadata（重启恢复同源）。
    const outcomeEvs = readEvents(h.root).filter((e: any) => e.event === "care.outcome");
    const lastSnap = outcomeEvs.at(-1)?.details?.care_state;
    const insSnap = (lastSnap?.inspections ?? []).find((i: any) => i.id === insp.id);
    assert.ok(insSnap, "care.outcome 快照必须含该 inspection");
    const targetA = (insSnap.targets ?? []).find((t: any) => t.child === childId);
    const targetB = (insSnap.targets ?? []).find((t: any) => t.child === childB);
    assert.equal(targetA?.staleReason, "superseded_by_message", "stale 标记必须落盘");
    assert.equal(targetA?.supersededBy, msgId);
    assert.equal(targetB?.staleReason ?? null, null, "其它 target 不得被误标 stale");
    assert.equal(targetA?.outcome, "unknown");
    assert.equal(targetB?.outcome, "progress");
  } finally {
    h.fake.releaseAll();
    try { await h.shutdown(); } catch {}
  }
});
