import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createGoal, moveGoal, goalDetail, setCriteria, setGoalDescription, transition, CRITERIA_VERIFIED_MARK } from "../ops.ts";
import { readEvents } from "../events.ts";
import { makeRealHost } from "./_g610-real-host.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(f: () => boolean) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (f()) return; await pause(5); }
  assert.fail("timed out waiting for real host");
}

for (const scenario of [
  { tree: "same", explicit: false }, { tree: "same", explicit: true },
  { tree: "other", explicit: false }, { tree: "other", explicit: true },
  { tree: "unknown", explicit: false }, { tree: "unknown", explicit: true },
] as const) {
  test(`g628 real host unversioned reuse ${scenario.tree} explicit=${scenario.explicit}`, async () => {
    const h = await makeRealHost({ sessionQuery: true, gitRepo: true });
    try {
      const old = git(h.ws, "rev-parse", "HEAD");
      git(h.ws, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "second");
      const main = git(h.ws, "rev-parse", "HEAD");
      const other = join(h.ws, "other-tree");
      git(h.ws, "worktree", "add", "--detach", other, old);
      const goal = createGoal(h.root, { title: "unversioned cwd", type: "task", actor: "human:gui" });
      moveGoal(h.root, goal, { to: "standalone", actor: "human:gui" });
      setCriteria(h.root, goal, [`real host ${CRITERIA_VERIFIED_MARK}`], "human:gui");
      setGoalDescription(h.root, goal, "real cwd baseline test", "human:gui");
      transition(h.root, goal, "ready", { actor: "human:gui" });
      const wd = h.ctx.get("workingDirectory");
      if (scenario.tree === "other") await wd.set(h.parent, other, new AbortController().signal);
      const gate = h.fake.hold();
      const child = await h.startChild("cwd-test");
      await waitFor(() => h.childLive(child.childId) === "running");
      if (scenario.tree === "other") await wd.set(h.parent, h.ws, new AbortController().signal);
      let result: any = null; let error: any = null; let actual = ""; let actualHead = ""; let fired = false;
      let before: any; let sends = 0; let spawns = 0;
      const send = h.subagents.sendMessage.bind(h.subagents);
      const start = h.subagents.startActivation.bind(h.subagents);
      h.subagents.sendMessage = (...args: any[]) => { sends++; return send(...args); };
      h.subagents.startActivation = (...args: any[]) => { spawns++; return start(...args); };
      h.ctx.on("agent/status", ({ agent, status }: any) => {
        if (fired || status !== "idle" || agent?.id !== child.childId) return;
        fired = true;
        actual = wd.get(agent.session);
        actualHead = git(actual, "rev-parse", "HEAD");
        before = { attempts: h.attempts(goal).length, status: (goalDetail(h.root, goal).meta as any).status, events: readEvents(h.root).length, agents: h.reg.list().map((a: any) => a.id).sort(), worktrees: git(h.ws, "worktree", "list", "--porcelain") };
        if (scenario.tree === "unknown") {
          const get = wd.get.bind(wd);
          wd.get = (s: any) => s === agent.session ? undefined : get(s);
        }
        Promise.resolve(h.dispatch(goal, "cwd check", { child_id: child.childId, ...(scenario.explicit ? { baseline_commit: main } : {}) })).then((r) => { result = r; }, (e) => { error = e; });
      });
      gate.resolve();
      await waitFor(() => result !== null || error !== null);
      assert.equal(spawns, 0);
      assert.equal(actual, scenario.tree === "other" ? other : h.ws);
      assert.equal(actualHead, scenario.tree === "other" ? old : main);
      if (scenario.tree === "same") {
        assert.equal(error, null, String(error));
        assert.equal(result.baseline_commit, main);
        assert.equal(h.attempts(goal).length, 1);
        assert.equal(sends, 1);
      } else {
        assert.ok(error, `must reject mismatch: baseline=${result?.baseline_commit}, actual=${actualHead}`);
        assert.match(String(error), /实际工作目录与基线一致/);
        assert.deepEqual({ attempts: h.attempts(goal).length, status: (goalDetail(h.root, goal).meta as any).status, events: readEvents(h.root).length, agents: h.reg.list().map((a: any) => a.id).sort(), worktrees: git(h.ws, "worktree", "list", "--porcelain") }, before);
        assert.equal(sends, 0);
      }
    } finally { h.fake.releaseAll(); await h.shutdown(); }
  });
}
