/**
 * g-612 正常重启的一致性：真实 child 自然 idle/gone 后，**没有任何后续 care 消息/操作/周期事件**，
 * dispose 整个真实宿主并 recreate（同一 workspace/root/goal），run 的起止/elapsed/预算来源必须
 * 从持久事件恢复，而不是由 now/当前 goal 值反推。
 *
 * 这是正常系统操作，不是 crash；只用 fake adapter / 私有 tmp，不联网、不访问真实 provider。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { goalDetail } from "../ops.ts";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, label: string, timeoutMs = 7000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error(`等待超时：${label}`);
}

test("g-612 正常重启：停止后无后续 care 事件，recreate 仍能读到该轮实际起止/elapsed/预算来源", async () => {
  const wsBase = join(process.cwd(), "tmp", "g610", "restart-612");
  const ws = join(wsBase, `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const projectYaml = "supervisor:\n  session: sess-super\n  care: \"true\"\n  care_threshold_seconds: 300\n";

  const h1 = await makeRealHost({ workspace: ws, sessionQuery: true, projectYaml });
  let h2: any = null;
  try {
    const goal = await makeGoal(h1, "g612 restart run");
    const setTool = h1.tools.get("graph_set_goal_budget");
    await setTool.execute({ goal, budget_seconds: 120 }, { agent: h1.parent, signal: new AbortController().signal });

    h1.fake.hold("G612-RESTART");
    const dispatched: any = await h1.dispatch(goal, "G612-RESTART", { worktree: false });
    const childId = String(dispatched.child_id ?? "");
    assert.ok(childId);
    await waitFor(() => h1.childLive(childId) === "running", "child running");

    const getCare = async (h: any) => {
      const r = await h.tools.get("graph_get_settings").execute({}, {
        agent: h.parent, signal: new AbortController().signal,
      });
      return r.supervisor_care;
    };
    const live = await getCare(h1);
    assert.ok((live.tasks ?? []).some((t: any) => t.child === childId), "h1 真实采样到任务");

    // 自然停止（idle/gone），不触发任何额外 care 控制或周期事件
    h1.fake.releaseAll();
    await waitFor(() => h1.childLive(childId) !== "running", "child stopped");
    await sleep(30);
    const beforeRestart = await getCare(h1);
    const liveRun = (beforeRestart.runs ?? []).find((r: any) => r.child === childId) as any;
    assert.ok(liveRun, "h1 停止后必须先在内存/事件面观察到本轮 run");

    // 正常 dispose 整个宿主，再重建同一 workspace/root
    await h1.shutdown();
    assert.ok(existsSync(join(ws, ".dsh-graph")), "workspace 根必须保留");

    h2 = await makeRealHost({ workspace: ws, sessionQuery: true, sessionId: "sess-super-2",
      projectYaml: projectYaml.replace("sess-super", "sess-super-2") });
    const afterRestart = await getCare(h2);
    // goal 仍在且没有新派发
    assert.ok(goalDetail(h2.root, goal).meta, "goal 仍可读");
    const run = (afterRestart.runs ?? []).find((r: any) => r.child === childId) as any;
    assert.ok(run, "正常重启后必须从持久事件恢复本轮 run 历史（不得凭空丢失）");
    const startedAt = run.started_at ?? run.startedAt;
    const stoppedAt = run.stopped_at ?? run.stoppedAt;
    const naturalMs = run.natural_ms ?? run.naturalMs;
    const budgetSource = run.budget_source ?? run.budgetSource;
    assert.ok(typeof startedAt === "number" && startedAt > 0, "停止前必须持久保存可证开始时刻");
    assert.ok(typeof stoppedAt === "number" && stoppedAt >= startedAt, "必须持久保存实际观察到的停止时刻");
    assert.ok(typeof naturalMs === "number" && naturalMs >= 0, "必须恢复本轮 elapsed，而非用 now 反推");
    assert.ok(["goal", "project_explicit", "global_explicit", "global_default"].includes(budgetSource));
    assert.ok(run.stop_source === "agent_status" || run.stopSource === "agent_status",
      "自然 stop 必须来自公开 agent/status，而非采样/now");
  } finally {
    try { h1.fake.releaseAll(); } catch { /* ignore */ }
    try { await h1.shutdown(); } catch { /* already shut */ }
    if (h2) {
      try { h2.fake.releaseAll(); } catch { /* ignore */ }
      try { await h2.shutdown(); } catch { /* ignore */ }
    }
  }
});
