/** g-247 structured attempt status persistence, precedence, and legacy fallback. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GraphError,
  archiveGoal,
  boardProjection,
  createGoal,
  deleteGoal,
  findGoalFile,
  goalDetail,
  init,
  loadGoal,
  postponeGoal,
  reportStatus,
  startAttempt,
} from "../ops.ts";
import { readEvents } from "../events.ts";

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-status-state-"));
  init(root);
  return root;
}

function versionAttempt(root: string, title = "状态目标") {
  const goal = createGoal(root, { title, version: "v-t", actor: "human:test" });
  const attempt = startAttempt(root, goal, { executor: "agent:test", actor: "human:test" });
  return { goal, attempt };
}

test("g-247：reportStatus 持久化 status_state、事件审计与旧调用兼容", () => {
  const root = tmpRoot();
  const { goal, attempt } = versionAttempt(root);
  reportStatus(root, goal, attempt, "已完成但没有关键词依赖", "agent:test", "done");

  const attemptFile = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`);
  assert.equal(loadGoal(attemptFile).meta.status_state, "done");
  const event = readEvents(root).find((item) => item.event === "attempt.status_reported");
  assert.equal(event?.details.status_state, "done");

  assert.throws(
    () => reportStatus(root, goal, attempt, "非法状态", "agent:test", "bogus" as any),
    (error) => error instanceof GraphError && error.message.includes("state 只允许"),
  );

  const legacy = startAttempt(root, goal, { executor: "agent:test", actor: "human:test" });
  reportStatus(root, goal, legacy, "旧调用不传 state", "agent:test");
  const legacyFile = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${legacy}/attempt.md`);
  assert.equal(loadGoal(legacyFile).meta.status_state, null, "不传 state 时旧 attempt 字段保持 null");
  const legacyEvent = readEvents(root).filter((item) => item.event === "attempt.status_reported").at(-1);
  assert.equal(legacyEvent?.details.status_state, undefined, "旧调用事件不虚构 status_state");
});

test("g-247：board/goalDetail 投影 status_state，结构化状态优先于误导 status_line", () => {
  const root = tmpRoot();
  const { goal, attempt } = versionAttempt(root);
  reportStatus(root, goal, attempt, "仍在执行但结构化已完成", "agent:test", "done");

  const board = boardProjection(root);
  const projected = board.versions[0].goals.find((item) => item.id === goal);
  assert.equal(projected?.status_line, "仍在执行但结构化已完成");
  assert.equal(projected?.status_state, "done");
  const detail = goalDetail(root, goal);
  assert.equal(detail.attempts.find((item: any) => item.id === attempt)?.status_state, "done");
});

test("g-247：结构化终态/运行态覆盖 deleteGoal 与 postponeGoal 活跃保护", () => {
  // state=done 即使 status_line 没有结束关键词，也不再阻止归档目标删除。
  const doneRoot = tmpRoot();
  const done = versionAttempt(doneRoot, "结构化完成");
  reportStatus(doneRoot, done.goal, done.attempt, "仍在检查", "agent:test", "done");
  archiveGoal(doneRoot, done.goal, { actor: "human:test" });
  deleteGoal(doneRoot, done.goal, { actor: "human:test" });
  assert.equal(existsSync(join(doneRoot, "versions", "v-t", "archived", done.goal)), false);

  // state=working 压过“已完成/等待复核”文本，postpone/delete 都必须保护。
  const workingRoot = tmpRoot();
  const working = versionAttempt(workingRoot, "结构化进行中");
  reportStatus(workingRoot, working.goal, working.attempt, "已完成，等待复核", "agent:test", "working");
  assert.throws(
    () => postponeGoal(workingRoot, working.goal, { actor: "human:test" }),
    (error) => error instanceof GraphError && error.message.includes("进行中的子代理"),
  );
  archiveGoal(workingRoot, working.goal, { actor: "human:test" });
  assert.throws(
    () => deleteGoal(workingRoot, working.goal, { actor: "human:test" }),
    (error) => error instanceof GraphError && error.message.includes("进行中的子代理"),
  );

  // 否定完成词与英文失败词不应把结构化 working 误判成 done/error；仍保持保护。
  for (const line of ["尚未完成", "fixed the failing test"]) {
    const root = tmpRoot();
    const item = versionAttempt(root, line);
    reportStatus(root, item.goal, item.attempt, line, "agent:test", "working");
    assert.throws(() => postponeGoal(root, item.goal, { actor: "human:test" }), GraphError);
  }
});

test("g-247：旧记录无 status_state 时保留 status_line 启发式回退", () => {
  const doneRoot = tmpRoot();
  const done = versionAttempt(doneRoot, "旧完成");
  reportStatus(doneRoot, done.goal, done.attempt, "已完成", "agent:test");
  assert.equal(boardProjection(doneRoot).versions[0].goals[0].status_state, null);
  archiveGoal(doneRoot, done.goal, { actor: "human:test" });
  assert.doesNotThrow(() => deleteGoal(doneRoot, done.goal, { actor: "human:test" }));

  const activeRoot = tmpRoot();
  const active = versionAttempt(activeRoot, "旧进行中");
  reportStatus(activeRoot, active.goal, active.attempt, "正在执行", "agent:test");
  archiveGoal(activeRoot, active.goal, { actor: "human:test" });
  assert.throws(
    () => deleteGoal(activeRoot, active.goal, { actor: "human:test" }),
    (error) => error instanceof GraphError && error.message.includes("进行中的子代理"),
  );
});
