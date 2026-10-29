/**
 * g-610 真实负向对照：已绑定 child 的 attempt.md 被损坏后，第二次派发必须 fail-closed。
 *
 * 本文件刻意只使用 **6edc 已存在**的公开 API（`apply`/工具派发/goalDetail/readEvents），
 * 因此同一文件可在旧实现副本上真实运行并断言其失败：
 *  - 旧实现没有同目标单活门禁（`listActiveExecutionAttempts` 尚不存在），第二次派发会成功
 *    创建第二个 child ⇒ 本测试的 `assert.rejects` 会真实报 "Missing expected rejection"；
 *  - 新实现把不可读 attempt 视为状态未知 ⇒ 第二次派发 409/工具错误且零副作用 ⇒ 本测试通过。
 *
 * 不是 sentinel：断言的是真实工具调用结果、attempt 数、child 数与事件数。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { init, createGoal, setCriteria, findGoalFile, goalDetail } from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";

function makeHarness() {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g610-neg-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const registered: any[] = [];
  const spawned: any[] = [];
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return { register: () => () => {} };
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "subagents") {
        return {
          list: () => ["spawn"],
          getProvider: () => ({ prepareContinuable: () => {} }),
          startContinuable: async (o: any) => {
            spawned.push(o);
            return { childId: "child-" + spawned.length, parentSessionId: "sess-super" };
          },
        };
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    tools: { register: (d: any) => { registered.push(d); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  const exec = { agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-exec" } }, signal: new AbortController().signal };
  return { ws, root, spawned, start: (args: any) => tool.execute(args, exec) };
}

test("g-610 负向对照：已绑定 child 的 attempt.md 损坏后，第二次派发必须拒绝且零副作用", async () => {
  const h = makeHarness();
  const goal = createGoal(h.root, {
    title: "损坏元数据负向对照", version: "v1.0", type: "task", actor: "human:gui",
    description: "用于证明旧实现会放行第二个 child",
  });
  setCriteria(h.root, goal, ["判据"], "human:gui");

  const first: any = await h.start({ goal, attempt_brief: "first" });
  assert.ok(first.child_id, "前提：首次派发已启动 child");

  // 损坏该 attempt 的元数据（真实文件写坏，不是 mock）
  const file = join(dirname(findGoalFile(h.root, goal)), "attempts", first.attempt, "attempt.md");
  writeFileSync(file, "---\n{\"id\": \"att-001\"\n---\n\nbroken frontmatter", "utf8");

  const attemptsBefore = goalDetail(h.root, goal).attempts.length;
  const eventsBefore = readEvents(h.root).length;
  const spawnedBefore = h.spawned.length;

  await assert.rejects(
    () => h.start({ goal, attempt_brief: "second after corruption" }),
    (e: any) => {
      assert.equal(e.code, "EXECUTION_STATE_UNKNOWN");
      assert.match(String(e.message), /无法解析|无法读取/);
      return true;
    },
    "不可读 attempt 元数据不能被当成「无 active」放行",
  );
  assert.equal(goalDetail(h.root, goal).attempts.length, attemptsBefore, "拒绝不得创建 attempt");
  assert.equal(h.spawned.length, spawnedBefore, "拒绝不得启动第二个 child");
  assert.equal(readEvents(h.root).length, eventsBefore, "拒绝不得写事件");
});
