/** g-382（v0.18.0 代码审查 C1，P1）：解绑最新 attempt 时不得误清理旧 running/unknown 子代理绑定。
 *
 *  缺陷：多 attempt 目标中「旧 attempt 的 child 仍 running、最新 child idle」时，合法解绑最新 binding
 *  只对最新 child 做了 liveCheck，却把全部旧绑定无条件标为 detached/superseded ⇒ 旧 child 未停止而
 *  绑定已消失，postponeGoal 因此误判「无活跃」搬走目标目录；且 superseded 事件在 `delete child_id`
 *  之后才取值，child_id 恒为 null（身份丢失）。
 *
 *  质量判据覆盖：
 *  1. 最新 child idle、旧 child running/unknown ⇒ 解绑不得清除旧绑定；暂缓仍拒绝活跃目标；
 *  2. 仅被 selector 选中的绑定发生修改；批量清理若保留，必须所有拟变更项先通过 liveCheck；
 *  3. attempt.superseded / attempt.unbound 事件保留真实 child_id；重复调用不扩大影响范围；
 *  4. 原脚本 tmp/review-v0.18.0/tmp/core-review/repro.ts 在基线树中不存在，本文件用**真实 core 调用**
 *     重建为稳定回归（不 mock 内部函数，只注入 liveCheck 这一 host 权威探针）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  startAttempt,
  bindAttemptChild,
  unbindGoalChild,
  readGoalBinding,
  findGoalFile,
  loadGoal,
  saveGoal,
  postponeGoal,
  boardProjection,
  GraphError,
} from "../ops.ts";
import { readEvents } from "../events.ts";

/** 旧 attempt 的 child 状态探针；最新 attempt 的 child 恒为 idle（复现前提）。 */
const liveFor = (oldChild: string, oldState: string) => (childId: string) =>
  childId === oldChild ? (oldState as "running" | "idle" | "gone" | "unknown") : "idle";

const attemptFile = (root: string, goal: string, att: string) => {
  const goalFile = findGoalFile(root, goal)!;
  return join(dirname(goalFile), "attempts", att, "attempt.md");
};
const attemptMeta = (root: string, goal: string, att: string) => loadGoal(attemptFile(root, goal, att)).meta;
const eventsOf = (root: string, goal: string, name: string) =>
  readEvents(root).filter((e) => e.event === name && e.goal === goal);

/** 同目标两个 attempt：att-001（旧，child-old）/ att-002（最新，child-new）。 */
function twoBoundAttempts() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g382-"));
  init(root);
  const goal = createGoal(root, { title: "g-382 多 attempt 目标", version: "v0.19.0", actor: "human:gui" });
  setCriteria(root, goal, ["解绑不得误清理旧绑定"], "human:gui");
  const oldAtt = startAttempt(root, goal, { executor: "agent:exec-old", actor: "human:gui" });
  bindAttemptChild(root, goal, oldAtt, "child-old", "human:gui", "sess-old");
  const newAtt = startAttempt(root, goal, { executor: "agent:exec-new", actor: "human:gui" });
  bindAttemptChild(root, goal, newAtt, "child-new", "human:gui", "sess-new");
  return { root, goal, oldAtt, newAtt };
}

const newToken = (root: string, goal: string, att: string) => String(attemptMeta(root, goal, att).binding_token);

/** 旧绑定必须逐字保留：不得 detached、不得清 child_id/token、不得改 result。 */
function assertOldBindingIntact(root: string, goal: string, oldAtt: string) {
  const om = attemptMeta(root, goal, oldAtt);
  assert.equal(om.detached, undefined, "旧 attempt 不得被标记 detached");
  assert.equal(om.detached_by, undefined, "旧 attempt 不得被标记 detached_by");
  assert.equal(om.child_id, "child-old", "旧 attempt 的 child_id 必须保留");
  assert.equal(om.parent_session_id, "sess-old", "旧 attempt 的 parent_session_id 必须保留");
  assert.ok(om.binding_token, "旧 attempt 的 binding_token 必须保留");
  assert.equal(om.result, "pending", "旧 attempt 的 result 不得被改写");
  assert.equal(om.binding_version, 1, "旧 attempt 的 binding_version 不得变化");
}

// ---------------------------------------------------------------- 判据 1 / 2

for (const oldState of ["running", "unknown"] as const) {
  test(`g-382 判据1/2：最新 child idle、旧 child ${oldState} ⇒ 只解绑选中项，旧绑定保留且暂缓仍被拒`, () => {
    const { root, goal, oldAtt, newAtt } = twoBoundAttempts();
    assert.equal(readGoalBinding(root, goal)!.attempt, newAtt, "前提：最新 attempt 才是当前绑定");

    const out = unbindGoalChild(root, goal, {
      actor: "human:gui", attempt: newAtt, token: newToken(root, goal, newAtt),
      liveCheck: liveFor("child-old", oldState),
    });
    assert.equal(out.detached, true, "选中绑定应被解绑");
    assert.equal(out.attempt, newAtt);

    // 选中项：已解绑 + 结果占位
    const nm = attemptMeta(root, goal, newAtt);
    assert.equal(nm.detached, true);
    assert.equal(nm.child_id, undefined, "选中项 child_id 清除");
    assert.equal(nm.result, "detached");

    // 旧项：逐字保留，且不得留下 superseded 事件（=未扩大影响面）
    assertOldBindingIntact(root, goal, oldAtt);
    assert.equal(eventsOf(root, goal, "attempt.superseded").length, 0, "running/unknown 不得被 superseded");
    assert.equal(eventsOf(root, goal, "attempt.unbound").length, 1, "仅选中项记一次 unbound");

    // 暂缓仍被拒：旧 child 仍 running/unknown，不得搬走目标目录
    assert.throws(
      () => postponeGoal(root, goal, { actor: "human:gui" }),
      GraphError,
      `${oldState} 的旧子代理仍在 ⇒ 暂缓必须被拒`,
    );
    assert.ok(eventsOf(root, goal, "goal.postpone_blocked").length >= 1, "拒绝须留 postpone_blocked 审计事件");
    assert.ok(findGoalFile(root, goal)!.includes("/goals/"), "目标目录不得被搬走");
  });
}

test("g-382 判据2：调用方未注入 liveCheck（状态不可确认）⇒ 旧绑定一律保留", () => {
  const { root, goal, oldAtt, newAtt } = twoBoundAttempts();
  // 最新 attempt 置为非 pending，绕开「选中项无 liveCheck 且 pending ⇒ 拒绝」的既有门禁，
  // 从而单独考察批量清理路径在缺少探针时的行为。
  const f = attemptFile(root, goal, newAtt);
  const doc = loadGoal(f);
  doc.meta.result = "done";
  saveGoal(f, doc);

  const out = unbindGoalChild(root, goal, {
    actor: "human:gui", attempt: newAtt, token: newToken(root, goal, newAtt),
  });
  assert.equal(out.detached, true);
  assertOldBindingIntact(root, goal, oldAtt);
  assert.equal(eventsOf(root, goal, "attempt.superseded").length, 0, "无探针 ⇒ unknown ⇒ 不得清理");
  assert.throws(() => postponeGoal(root, goal, { actor: "human:gui" }), GraphError);
});

// ---------------------------------------------------------------------- 判据 3

for (const oldState of ["gone", "idle"] as const) {
  test(`g-382 判据3：旧 child ${oldState}（可确认已停止）⇒ 允许取代，事件保留真实 child_id，暂缓放行`, () => {
    const { root, goal, oldAtt, newAtt } = twoBoundAttempts();
    const out = unbindGoalChild(root, goal, {
      actor: "human:gui", attempt: newAtt, token: newToken(root, goal, newAtt),
      liveCheck: liveFor("child-old", oldState),
    });
    assert.equal(out.detached, true);

    const om = attemptMeta(root, goal, oldAtt);
    assert.equal(om.detached, true, "可确认已停止 ⇒ 允许取代");
    assert.equal(om.detached_by, "system:superseded");
    assert.equal(om.result, "superseded");
    assert.equal(om.child_id, undefined);
    assert.equal(om.binding_token, undefined);

    const evs = eventsOf(root, goal, "attempt.superseded");
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.details.child_id, "child-old", "superseded 事件必须保留真实 child_id（身份不得丢失）");
    assert.equal(evs[0]!.details.attempt, oldAtt);
    assert.equal(evs[0]!.details.live_state, oldState);

    // 全部绑定已安全清理 ⇒ 暂缓放行
    postponeGoal(root, goal, { actor: "human:gui" });
    assert.ok(boardProjection(root).backlog.find((x) => x.id === goal), "暂缓后应回到 backlog");
  });
}

test("g-382 判据3：重复解绑幂等，旧 running 绑定与事件数均不扩大影响面", () => {
  const { root, goal, oldAtt, newAtt } = twoBoundAttempts();
  const token = newToken(root, goal, newAtt);
  const first = unbindGoalChild(root, goal, {
    actor: "human:gui", attempt: newAtt, token, liveCheck: liveFor("child-old", "running"),
  });
  assert.equal(first.detached, true);
  const unboundAfterFirst = eventsOf(root, goal, "attempt.unbound").length;

  const again = unbindGoalChild(root, goal, {
    actor: "human:gui", attempt: newAtt, token, liveCheck: liveFor("child-old", "running"),
  });
  assert.deepEqual(again, { detached: false, already: true }, "重复解绑必须幂等 no-op（不得误判并发冲突）");
  assert.equal(eventsOf(root, goal, "attempt.unbound").length, unboundAfterFirst, "不得重复记事件");
  assert.equal(eventsOf(root, goal, "attempt.superseded").length, 0);
  assertOldBindingIntact(root, goal, oldAtt);
  assert.throws(() => postponeGoal(root, goal, { actor: "human:gui" }), GraphError);
});

test("g-382 判据2：selector 指向不存在/未绑定的 attempt 仍按并发冲突拒绝（不削弱 CAS 门禁）", () => {
  const { root, goal, newAtt } = twoBoundAttempts();
  const token = newToken(root, goal, newAtt);
  assert.throws(
    () => unbindGoalChild(root, goal, { actor: "human:gui", attempt: "att-999", token, liveCheck: () => "gone" }),
    GraphError,
    "不存在的 selector 必须拒绝",
  );
  assert.throws(
    () => unbindGoalChild(root, goal, { actor: "human:gui", attempt: "att-001", token, liveCheck: () => "gone" }),
    GraphError,
    "指向仍有绑定的旧 attempt 且 token 不匹配 ⇒ 必须拒绝",
  );
});
