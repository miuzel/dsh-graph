import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createGoal, setCriteria, setGoalDescription, transition, goalDetail, CRITERIA_VERIFIED_MARK } from "../ops.ts";
import { makeRealHost } from "./_g610-real-host.ts";
import { readEvents } from "../events.ts";

const waitFor = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

for (const scenario of ["same", "different", "unknown"] as const) {
  test(`g-474 真实宿主 child 工作目录基线：${scenario}`, async () => {
    const h = await makeRealHost({ sessionQuery: true });
    try {
      const goal = createGoal(h.root, { title: `reuse ${scenario}`, version: "v1.0", type: "task", actor: "human:gui" });
      setCriteria(h.root, goal, [`真实宿主 ${CRITERIA_VERIFIED_MARK}`], "human:gui");
      setGoalDescription(h.root, goal, "验证真实 child 工作目录与版本基线。", "human:gui");
      transition(h.root, goal, "ready", { actor: "human:gui" });
      const gate = h.fake.hold();
      const started = await h.startChild("baseline expert");
      await waitFor(() => h.childLive(started.childId) === "running", "child running");
      const child = h.reg.get(started.childId);
      const wd = h.ctx.get("workingDirectory");
      assert.ok(child?.session);
      assert.equal(wd.get(child.session), h.ws);
      if (scenario === "different") {
        const other = join(h.ws, "other-line");
        execFileSync("git", ["worktree", "add", "-q", "-b", "other-line", other], { cwd: h.ws });
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--allow-empty", "-qm", "other"], { cwd: other });
        await wd.set(child, other);
        assert.equal(wd.get(child.session), other);
      }
      if (scenario === "unknown") {
        // 故障注入仅作用于该真实 session 的只读查询；不伪造 attempt 或 child 元数据。
        const realGet = wd.get.bind(wd);
        wd.get = (session: any) => session === child.session ? undefined : realGet(session);
        assert.equal(wd.get(child.session), undefined);
      }
      const beforeEvents = readEvents(h.root);
      const beforeTrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: h.ws, encoding: "utf8" });
      const baseline = execFileSync("git", ["rev-parse", "refs/heads/v1.0-test"], { cwd: h.ws, encoding: "utf8" }).trim();
      let sends = 0;
      const send = h.subagents.sendMessage.bind(h.subagents);
      h.subagents.sendMessage = (...args: any[]) => { sends++; return send(...args); };
      let result: any = null;
      let error: any = null;
      let fired = false;
      const fire = () => {
        if (fired || h.reg.get(started.childId)?.status !== "idle") return;
        fired = true;
        h.dispatch(goal, "g474 child baseline", { child_id: started.childId }).then((r: any) => { result = r; }, (e: any) => { error = e; });
      };
      h.ctx.on("agent/status", ({ agent, status }: any = {}) => {
        if (status === "idle" && (agent?.id ?? agent) === started.childId) fire();
      });
      gate.resolve();
      fire();
      await waitFor(() => result !== null || error !== null, "复用派发结果");
      if (scenario === "same") {
        assert.equal(error, null, String(error));
        assert.equal(result.reused, true);
        assert.equal(result.child_id, started.childId);
        assert.equal(result.delivery, "accepted");
        assert.equal(result.baseline_commit, baseline);
        assert.equal(result.baseline_source, "version_branch");
        assert.equal(result.worktree, false);
        assert.equal(h.attempts(goal).length, 1);
        assert.equal((goalDetail(h.root, goal).meta as any).status, "in_progress");
        assert.equal(sends, 1);
      } else {
        assert.match(String(error?.message ?? error), /无法验证复用 child 的实际工作目录与基线一致/);
        assert.equal(h.attempts(goal).length, 0);
        assert.equal((goalDetail(h.root, goal).meta as any).status, "ready");
        assert.equal(sends, 0);
        assert.deepEqual(readEvents(h.root), beforeEvents);
        assert.equal(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: h.ws, encoding: "utf8" }), beforeTrees);
      }
    } finally {
      h.fake.releaseAll();
      await h.shutdown();
    }
  });
}
