/**
 * g-612 B（返工）：**主管更替 ≠ child 停止**。
 *
 * 真实 0.2.1-rc.2 宿主栈 + fake adapter + 私有 workspace（不联网、不访问真实 provider/看板）：
 * ① 两个目标各有真实 running child、各自真实主管消息基准；
 * ② 合法新主管经真实 `graph_claim_supervisor` 接管 —— 旧 child 此刻仍 running，新主管因
 *    ownership/parent_session 变化无法再采样它们；这只能表示「追踪暂不可确认」，
 *    **不得**以 sample + 当前 now 声称已停止；
 * ③ 旧 child 在更替窗口内自然停止（其事件不再归属新主管）；正常 dispose/recreate 后，
 *    每个 child 每轮只允许一条 run：同 run id 幂等、停止时点不可证时留 null（unknown），
 *    绝不用重启时间补造或拉长 elapsed。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { goalDetail, readSupervisorSession } from "../ops.ts";
import { readEvents } from "../events.ts";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, label: string, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (cond()) return; await sleep(20); }
  throw new Error(`等待超时：${label}`);
}

const PROJECT = "supervisor:\n  session: sess-super\n  care: \"true\"\n  care_threshold_seconds: 300\n  care_recheck_seconds: 300\n";

test("g-612 B 主管更替时仍 running 的 child 不被误记停止；正常重启后每轮仅一条 run 且未知停止不伪造时刻", async () => {
  const h1 = await makeRealHost({ sessionQuery: true, projectYaml: PROJECT });
  let h2: any = null;
  let sup2Handle: any = null;
  const sig = () => new AbortController().signal;
  const care = async (host: any, agent: any) =>
    (await host.tools.get("graph_get_settings").execute({}, { agent, signal: sig() })).supervisor_care;
  const tool = (host: any, name: string) => host.tools.get(name);
  try {
    // ① 首个主管真实 claim；两个真实目标各派发一个 running child。
    assert.equal((await tool(h1, "graph_claim_supervisor").execute({}, { agent: h1.parent, signal: sig() })).supervisor_session, h1.parent.id);
    const goalA = await makeGoal(h1, "g612 switch a");
    const goalB = await makeGoal(h1, "g612 switch b");
    h1.fake.hold("G612-SW-A");
    h1.fake.hold("G612-SW-B");
    const dA: any = await h1.dispatch(goalA, "G612-SW-A child", { worktree: false });
    const dB: any = await h1.dispatch(goalB, "G612-SW-B child", { worktree: false });
    await waitFor(() => h1.childLive(String(dA.child_id)) === "running", "A running");
    await waitFor(() => h1.childLive(String(dB.child_id)) === "running", "B running");

    // ② 两个任务都进入采样，并各自有真实主管消息基准（care.message 快照含两个 open run）。
    const st0: any = await care(h1, h1.parent);
    assert.equal((st0.tasks ?? []).length, 2, "两个 running child 都被采样为 care 任务");
    assert.ok((st0.tasks ?? []).every((t: any) => t.run_started_at > 0), "两轮 run 起点可观察");
    await h1.subagents.sendMessage(h1.parent, dA.child_id, [{ type: "text", text: "G612-SW msgA" }], { signal: sig() });
    await h1.subagents.sendMessage(h1.parent, dB.child_id, [{ type: "text", text: "G612-SW msgB" }], { signal: sig() });
    await sleep(50);
    const snapWithBoth = readEvents(h1.root).filter((e: any) => e.event === "care.message"
      && (e.details?.care_state?.tasks ?? []).filter((t: any) => t.runStartedAt != null).length === 2);
    assert.ok(snapWithBoth.length >= 1, "已落盘同时含两个 running 任务的真实快照");

    const beforeClaimRuns = readEvents(h1.root).filter((e: any) => e.event === "care.run").length;
    // ③ 合法公开控件序列：新会话真实 claim 接管（主管更替）。
    const created: any = await h1.reg.create({
      sessionId: "sess-super-switch",
      agentOptions: { provider: "fake", model: "fake-model" },
      meta: { cwd: h1.ws },
    });
    sup2Handle = created;
    const sup2 = created.agent;
    const claimed2: any = await tool(h1, "graph_claim_supervisor").execute({}, { agent: sup2, signal: sig() });
    assert.equal(claimed2.supervisor_session, sup2.id);
    assert.equal(readSupervisorSession(h1.root), sup2.id);

    // ④ 同一次 reconcile 观察到两个旧任务不再归新主管，但 registry 明确显示 child 仍 running ⇒
    //    只能记「unobserved」（stoppedAt=null），绝不得写 stopped/now。
    const runsAfterClaim = readEvents(h1.root).filter((e: any) => e.event === "care.run");
    assert.equal(runsAfterClaim.length - beforeClaimRuns, 2, "两个旧任务各留一条 run 观察 metadata");
    for (const ev of runsAfterClaim.slice(beforeClaimRuns)) {
      assert.equal(ev.details?.phase, "unobserved", "主管更替不是停止事件（phase=unobserved）");
      assert.equal(ev.details?.run?.stoppedAt, null, "仍 running 时不得伪造停止时刻");
      assert.equal(ev.details?.run?.stopSource, null, "不得声称已有停止证据");
    }
    assert.equal(h1.childLive(String(dA.child_id)), "running", "更替时 child A 仍真实 running");
    assert.equal(h1.childLive(String(dB.child_id)), "running", "更替时 child B 仍真实 running");
    assert.equal(((await care(h1, sup2)).tasks ?? []).length, 0, "新主管看不到旧 ownership 的任务（不是已停止）");

    // ⑤ 两个 child 在更替窗口内自然停止（其 status 事件已不归属新主管）。
    h1.fake.releaseAll();
    await waitFor(() => h1.childLive(String(dA.child_id)) !== "running", "A stopped");
    await waitFor(() => h1.childLive(String(dB.child_id)) !== "running", "B stopped");
    await sleep(200);
    const staleInLastSnapshot = (readEvents(h1.root)
      .filter((e: any) => String(e.event ?? "").startsWith("care.") && e.details?.care_state)
      .at(-1)?.details?.care_state?.tasks ?? []).filter((t: any) => t.runStartedAt != null);
    assert.equal(staleInLastSnapshot.length, 0, "快照不得保留会被再次 close 的陈旧 open 任务");

    // ⑥ 正常 dispose + recreate（同一 workspace/root；新主管会话 id 与 claim 后一致）。
    await h1.shutdown();
    h2 = await makeRealHost({
      workspace: h1.ws, sessionQuery: true, sessionId: "sess-super-switch",
      projectYaml: PROJECT.replace("sess-super", "sess-super-switch"),
    });
    const restartAt = Date.now();
    const stAfter: any = await care(h2, h2.parent);
    const runsA = ((stAfter.runs ?? []) as any[]).filter((r: any) => r.child === dA.child_id);
    const runsB = ((stAfter.runs ?? []) as any[]).filter((r: any) => r.child === dB.child_id);
    assert.equal(runsA.length, 1, `child A 应恰有 1 条 run（实得 ${runsA.length}）`);
    assert.equal(runsB.length, 1, `child B 应恰有 1 条 run（实得 ${runsB.length}）`);
    assert.equal(new Set((stAfter.runs ?? []).map((r: any) => r.id)).size, (stAfter.runs ?? []).length, "run id 不得重复");
    for (const r of [...runsA, ...runsB]) {
      assert.equal(r.stop_source, "unknown", "旧 ownership 下真实停止不可证 ⇒ 如实 unknown");
      assert.equal(r.stopped_at, null, "未知停止时点必须留空，不得用重启 now 补造");
      assert.equal(r.natural_ms, null, "未知时点不得算精确 elapsed");
      assert.ok(Number(r.started_at) > 0, "开始时刻仍是可证的真实观测");
    }
    // 重复读取不得再 close/追加（幂等）。
    const again: any = await care(h2, h2.parent);
    assert.equal((again.runs ?? []).filter((r: any) => r.child === dA.child_id).length, 1, "重复读取不得重复 close 同一 run");
    assert.ok(restartAt > 0);
    assert.ok(goalDetail(h2.root, goalA).meta, "目标历史仍可读");
  } finally {
    try { h1.fake.releaseAll(); } catch { /* ignore */ }
    try { await h1.shutdown(); } catch { /* ignore */ }
    try { await sup2Handle?.dispose?.(); } catch { /* ignore */ }
    if (h2) { try { h2.fake.releaseAll(); } catch { /* ignore */ } try { await h2.shutdown(); } catch { /* ignore */ } }
  }
});
