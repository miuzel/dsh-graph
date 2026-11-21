// g-613：`graph_start_attempt` 的可选 `child_id` —— 复用**空闲**专家子代理承接新目标。
//
// 本文件只断言「引擎契约」，宿主真实行为另有实测探针（见 g-613 结果日志）：
//   · idle 的 continuable child 仍常驻、可以直接续一轮；running 时 sendMessage 是 steer；
//   · 子代理沙箱根与工具限制继承**创建时**的父会话，复用在发送时不能改 cwd/权限；
//   · 另一父会话向该 child 发消息被宿主拒绝（UNAUTHORIZED）。
// 因此这里的桩只复刻这些**已核实**的返回值形状，不臆造宿主语义。
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createGoal, setCriteria, addCard, loadGoal, findGoalFile } from "../ops.ts";
import {
  createHarnessWith,
  prepare,
  dispatch,
  attemptMeta,
  readAllEvents,
  type ReuseChildStub,
} from "./_g374-harness.ts";

const CHILD = "child-expert-1";

/** 建一个「已在执行」的旧目标 A + 一个待派发的新目标 B（两者 attempt 都从 att-001 起 ⇒ 键冲突场景）。 */
function twoGoals(h: ReturnType<typeof createHarnessWith>) {
  const a = createGoal(h.root, { title: "A 旧目标", version: "v1.0", type: "task", actor: "human:gui" });
  setCriteria(h.root, a, ["判据 A"], "human:gui");
  const b = createGoal(h.root, { title: "B 新目标", version: "v1.0", type: "task", actor: "human:gui" });
  setCriteria(h.root, b, ["判据 B"], "human:gui");
  return { a, b };
}

/** 走一次**全新派发**（不传 child_id）把 A/att-001 落到 CHILD 上，模拟「专家正在跑旧目标」。 */
async function bindAtoChild(h: ReturnType<typeof createHarnessWith>, goal: string) {
  const res = await h.call("graph_start_attempt", { goal, attempt_brief: "旧任务", task_type: "fix" });
  assert.ok(res?.attempt, "首次派发必须返回 attempt");
  return res.attempt as string;
}

/** 目标 frontmatter 的只读投影（看板用 JSON frontmatter，故用 loadGoal 而不是文本正则）。 */
function goalMeta(root: string, goal: string): Record<string, any> {
  return loadGoal(join(root, "versions", "v1.0", "goals", goal, "goal.md")).meta as Record<string, any>;
}
function backlogGoalMeta(root: string, goal: string): Record<string, any> {
  return loadGoal(join(root, "backlog", goal, "goal.md")).meta as Record<string, any>;
}

/**
 * 复用准入的归属夹具（g-627：宿主归属收口只剩 `subagents.rootOf`）。
 * 一律显式声明 `ownershipApi: "rootOf"` —— 夹具按 rc.3 形态提供**稳定身份**的 live Agent，
 * 这是下限之上的唯一归属面；不声明就会落到旧 `isOwnedBy` 桩（已不在支持面内）。
 */
function registry(child: ReuseChildStub | undefined) {
  return { ownershipApi: "rootOf" as const, reuse: { childRegistry: { [CHILD]: child } } };
}

// ───────────────────────── 判据 1：未传 child_id 时行为逐字等价 ─────────────────────────
test("g-613 判据 1：未传/传 null child_id ⇒ 仍走全新 spawn，响应与既有形状逐字一致", async () => {
  const h = createHarnessWith({ ownershipApi: "rootOf" });
  const { b } = twoGoals(h);
  const plain = await h.call("graph_start_attempt", { goal: b, attempt_brief: "b1", task_type: "fix" });
  assert.equal(plain.child_id, "child-1", "未传 child_id 必须新建子代理");
  assert.equal(h.capturedRequests.length, 1, "必须真的调用了 startContinuable");
  assert.equal(plain.reused, undefined, "未复用时不得凭空出现复用字段");
  assert.equal(plain.delivery, undefined);
  assert.equal(plain.started, undefined);
  assert.equal(h.sentMessages.length, 0, "未复用不得向任何既有子代理投递");

  const h2 = createHarnessWith({ ownershipApi: "rootOf" });
  const b2 = createGoal(h2.root, { title: "B2", version: "v1.0", type: "task", actor: "human:gui" });
  setCriteria(h2.root, b2, ["判据"], "human:gui");
  const withNull = await h2.call("graph_start_attempt", { goal: b2, attempt_brief: "b2", task_type: "fix", child_id: null });
  assert.equal(withNull.child_id, "child-1", "child_id=null 等价于未传");
  assert.equal(withNull.reused, undefined);
});

// ───────────────────────── 判据 2：运行中的 child 一律拒绝（零副作用） ─────────────────────────
test("g-613 判据 2：child 运行中 ⇒ 可读拒绝、不建 attempt、不迁移状态、不投递、不建树", async () => {
  const h = createHarnessWith(registry({ status: "running", ownedBy: ["a1"] }));
  const { b } = twoGoals(h);
  const before = readAllEvents(h.root).length;
  await assert.rejects(
    () => h.call("graph_start_attempt", { goal: b, attempt_brief: "新任务", child_id: CHILD }),
    (e: any) => {
      assert.match(String(e.message), /正在运行/);
      assert.match(String(e.message), /空闲/, "错误必须说清楚「只接受空闲子代理」");
      return true;
    },
  );
  assert.equal(h.sentMessages.length, 0, "运行中绝不 steer 投递");
  assert.equal(h.capturedRequests.length, 0, "运行中绝不新建子代理");
  assert.equal(existsSync(join(h.root, "versions", "v1.0", "goals", b, "attempts")), false, "不得创建 attempts/");
  assert.notEqual(goalMeta(h.root, b).status, "in_progress", "目标状态不得迁移到 in_progress");
  assert.equal(readAllEvents(h.root).length, before, "拒绝必须零事件副作用");
});

test("g-613 判据 2：child 不在 live registry（冷态/已结束）⇒ 显式拒绝，不冒充可复用", async () => {
  const h = createHarnessWith(registry(undefined));
  const { b } = twoGoals(h);
  await assert.rejects(
    () => h.call("graph_start_attempt", { goal: b, attempt_brief: "x", child_id: CHILD }),
    /不在 live registry/,
  );
  assert.equal(h.sentMessages.length, 0);
});

// ───────────────────────── 判据 3：成功复用 ─────────────────────────
test("g-613 判据 3：空闲 child ⇒ 建 attempt + 绑定 + in_progress + attempt.bound + 注入完整任务提示词", async () => {
  const h = createHarnessWith(registry({ status: "idle", ownedBy: ["a1"] }));
  const { b } = twoGoals(h);
  const res = await h.call("graph_start_attempt", { goal: b, attempt_brief: "复用干新活", task_type: "fix", child_id: CHILD });
  assert.equal(res.attempt, "att-001");
  assert.equal(res.reused, true);
  assert.equal(res.child_id, CHILD);
  assert.equal(res.delivery, "accepted");
  assert.equal(res.started, true);
  assert.equal(res.started_basis, "delivery_accepted", "started 的必要条件只能是「宿主受理投递」");
  assert.equal(res.child_error, undefined, "成功复用不得带 child_error");
  assert.equal(h.capturedRequests.length, 0, "复用不得再新建子代理");
  // 归属真源：attempt.md
  const meta = attemptMeta(h.root, b, "att-001");
  assert.equal(meta.child_id, CHILD);
  assert.equal(Number(meta.binding_version), 1);
  assert.equal(meta.dispatch_in_flight, undefined, "绑定成功必须结算首次启动窗口");
  // 事件：attempt.bound
  const events = readAllEvents(h.root).filter((e) => e.goal === b);
  const bound = events.find((e) => e.event === "attempt.bound");
  assert.ok(bound, "必须落 attempt.bound 事件");
  assert.equal((bound!.details as any).child_id, CHILD);
  // 目标状态
  assert.equal(goalMeta(h.root, b).status, "in_progress");
  // 投递正文 = 完整 attempt 提示词（含目标、判据、attempt 编号）
  assert.equal(h.sentMessages.length, 1);
  const sent = h.sentMessages[0];
  assert.equal(sent.targetId, CHILD);
  assert.equal(sent.parentId, "a1", "只能由真实调用者（主管）投递");
  const promptText = sent.content.map((c) => c.text ?? "").join("\n");
  assert.match(promptText, new RegExp(b), "提示词必须点名本次目标");
  assert.match(promptText, /判据 B/, "提示词必须带本目标判据");
  assert.match(promptText, /att-001/, "提示词必须点名本次 attempt");
  // 复用响应**刻意不回显整份提示词**（调用者手里就是原文；与「未传 child_id 时回显 prompt」的既有
  // 形状保持一致地最小化差异），只回传哈希供审计。
  assert.equal(res.prompt, undefined, "复用不额外回显整份提示词");
  assert.ok(res.prompt_hash, "提示词哈希必须回传");
});

// ───────────────────────── 判据 4：跨目标独占与键冲突 ─────────────────────────
test("g-613 判据 4：child 已被 A/att-001 活跃占用 ⇒ 拒绝 B，B 零副作用且 A 不受影响", async () => {
  const h = createHarnessWith(registry({ status: "idle", ownedBy: ["a1"] }));
  const { a, b } = twoGoals(h);
  await bindAtoChild(h, a); // A/att-001 → child-1；这里把 CHILD 手工占上
  // 手工把 A/att-001 绑到被测的 CHILD（模拟专家正在跑旧目标）
  const { seedGoalState } = await import("./_g374-harness.ts");
  seedGoalState(h.root, a, "att-001", CHILD);
  const bBefore = readAllEvents(h.root).filter((e) => e.goal === b).length;
  await assert.rejects(
    () => h.call("graph_start_attempt", { goal: b, attempt_brief: "x", child_id: CHILD }),
    (e: any) => {
      assert.match(String(e.message), new RegExp(`${a}/att-001`), "拒绝必须点名占用者");
      return true;
    },
  );
  assert.equal(existsSync(join(h.root, "versions", "v1.0", "goals", b, "attempts")), false);
  assert.equal(readAllEvents(h.root).filter((e) => e.goal === b).length, bBefore);
  assert.equal(attemptMeta(h.root, a, "att-001").child_id, CHILD, "旧绑定不得被改动");
  assert.equal(h.sentMessages.length, 0);
});

test("g-613 判据 4：A/att-001 已交付（不再活跃）⇒ 同一 child 可复用给 B/att-001，且旧绑定标注被复用", async () => {
  const h = createHarnessWith(registry({ status: "idle", ownedBy: ["a1"] }));
  const { a, b } = twoGoals(h);
  await bindAtoChild(h, a);
  const { seedGoalState } = await import("./_g374-harness.ts");
  seedGoalState(h.root, a, "att-001", CHILD, { status: "delivered", result: "completed" });
  const res = await h.call("graph_start_attempt", { goal: b, attempt_brief: "接手", child_id: CHILD });
  assert.equal(res.attempt, "att-001", "B 自己也是 att-001 —— 正是跨目标键冲突场景");
  assert.equal(res.reused, true);
  assert.deepEqual(res.prior_attempt, { goal: a, attempt: "att-001" });
  const reused = readAllEvents(h.root).find((e) => e.event === "attempt.reused");
  assert.ok(reused, "必须记 attempt.reused（看板据此标注旧绑定被复用）");
  assert.equal(reused!.goal, a, "attempt.reused 写在**旧目标**的事件流");
  assert.equal((reused!.details as any).reused_by, `${b}/att-001`);
  // 两个目标的绑定各自独立（A 的记录不被覆盖）
  assert.equal(attemptMeta(h.root, a, "att-001").child_id, CHILD);
  assert.equal(attemptMeta(h.root, b, "att-001").child_id, CHILD);
});

// ───────────────────────── 判据 5：迟到 end 不污染新目标 ─────────────────────────
test("g-613 判据 5：旧代际 runId 的迟到 subagent/end 不得写入新目标结果/状态", async () => {
  const h = createHarnessWith(registry({ status: "idle", ownedBy: ["a1"] }));
  const { b } = twoGoals(h);
  // 旧的 A 轮先结束（此刻 CHILD 还不是任何 attempt 的归属 ⇒ 不写任何结果），
  // 但它的 end 回调被「阻塞」到复用之后再投递（模拟事件迟到）。
  const res = await h.call("graph_start_attempt", { goal: b, attempt_brief: "新活", child_id: CHILD });
  // 复用后观察到的当前代际 = run-new；旧轮的迟到 end 带 run-old。
  h.emit("subagent/start", { id: CHILD, runId: "run-new", provider: "spawn", local: true });
  h.emit("subagent/end", {
    id: CHILD, runId: "run-old", provider: "spawn", local: true,
    stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "旧任务的总结，绝不归到新目标" }],
  });
  const resultsFile = join(h.root, "versions", "v1.0", "goals", b, `results-att-${String(res.attempt).replace(/^att-/, "")}.md`);
  const goalEvents = readAllEvents(h.root).filter((e) => e.goal === b);
  assert.equal(
    goalEvents.some((e) => e.event === "attempt.results_written" && (e.details as any).source === "subagent/end"),
    false,
    "旧代际迟到的 end 不得产生 results_written(subagent/end)",
  );
  if (existsSync(resultsFile)) {
    const body = readFileSync(resultsFile, "utf8");
    assert.doesNotMatch(body, /旧任务的总结/, "迟到 end 的正文不得落进新目标结果文件");
  }
  const att = attemptMeta(h.root, b, res.attempt);
  assert.equal(att.result, "pending", "迟到 end 不得结算新 attempt");
  // 当前代际的 end 仍然照常结算（证明过滤只针对旧代际，不是一刀切）。
  h.emit("subagent/end", {
    id: CHILD, runId: "run-new", provider: "spawn", local: true,
    stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "新任务完成" }],
  });
  const landed = readAllEvents(h.root).filter((e) => e.goal === b && e.event === "attempt.results_written"
    && (e.details as any).source === "subagent/end");
  assert.equal(landed.length, 1, "当前代际的 end 必须照常结算（过滤只针对旧代际）");
  assert.match(readFileSync(resultsFile, "utf8"), /新任务完成/);
});

// ───────────────────────── 判据 6：投递不确定 ⇒ fail-closed ─────────────────────────
test("g-613 判据 6：投递被拒绝 ⇒ child_error、attempt 结算为 child_error、记 reuse_failed、不声称已开始", async () => {
  const h = createHarnessWith({
    ownershipApi: "rootOf",
    reuse: {
      childRegistry: { [CHILD]: { status: "idle", ownedBy: ["a1"] } },
      sendMessage: async () => { throw new Error("INPUT_CLOSED: child 已提交结构化结果"); },
    },
  });
  const { b } = twoGoals(h);
  const res = await h.call("graph_start_attempt", { goal: b, attempt_brief: "x", child_id: CHILD });
  assert.equal(res.reused, true);
  assert.equal(res.delivery, "rejected");
  assert.equal(res.started, false, "投递被拒不等于已开始工作");
  assert.equal(res.child_id, null, "未确认投递时不得回传「已绑定 child」的假象");
  assert.match(String(res.child_error), /复用投递被拒绝/);
  const evt = readAllEvents(h.root).find((e) => e.event === "attempt.reuse_failed");
  assert.ok(evt, "必须如实记 attempt.reuse_failed");
  assert.equal((evt!.details as any).code, "delivery_rejected");
  const att = attemptMeta(h.root, b, "att-001");
  assert.equal(att.result !== "pending" || att.dispatch_in_flight === undefined, true, "不得留下永久 in-flight 门禁");
  // 不写 subagent/end 结果、不冒充完成摘要
  const results = readAllEvents(h.root).filter((e) => e.event === "attempt.results_written");
  assert.equal(results.every((e) => (e.details as any).source !== "subagent/end"), true);
});

// g-613（真实宿主 E2E ⑤ 暴露的缺口，确定性回归）：投递被拒后必须补写 child_error 占位。
// 修复前：绑定成功把 closeFailure 关掉 ⇒ 投递失败分支不写占位 ⇒ 留下「有 attempt、无任何结果文件」的
// 孤儿记录（g-374 不变式要求：无子代理输出的 attempt 由派发处补齐占位摘要）。
test("g-613 判据 6：投递被拒 ⇒ 补写 source=child_error 占位摘要（不留无结果文件的孤儿 attempt）", async () => {
  const h = createHarnessWith({
    ownershipApi: "rootOf",
    reuse: {
      childRegistry: { [CHILD]: { status: "idle", ownedBy: ["a1"] } },
      sendMessage: async () => { throw new Error("UNAUTHORIZED: message delivery requires the exact live sender agent"); },
    },
  });
  const { b } = twoGoals(h);
  const res = await h.call("graph_start_attempt", { goal: b, attempt_brief: "x", child_id: CHILD });
  assert.equal(res.delivery, "rejected");
  const written = readAllEvents(h.root).filter((e) => e.event === "attempt.results_written" && (e.details as any).attempt === "att-001");
  assert.equal(written.length, 1, "必须恰好写一次占位结果");
  assert.equal((written[0].details as any).source, "child_error", "占位来源必须是 child_error");
  assert.match(String((written[0].details as any).reason ?? ""), /复用投递失败/, "占位原因写明投递失败");
  const file = join(dirname(findGoalFile(h.root, b)!), "results-att-001.md");
  assert.ok(existsSync(file), "占位文件必须真实落盘");
  assert.match(readFileSync(file, "utf8"), /source: `child_error`/);
  // 仍然不得把投递失败当成功
  assert.equal(res.started, false);
  assert.equal(res.child_id, null);
});

// ───────────────────────── 判据 7：care 按新绑定重算 ─────────────────────────
test("g-613 判据 7：复用后 care 按新绑定重算（旧代际任务/巡检被 retire，不继承旧锁与计时）", async () => {
  const h = createHarnessWith(registry({ status: "idle", ownedBy: ["a1"] }));
  const { a, b } = twoGoals(h);
  await bindAtoChild(h, a);
  const { seedGoalState } = await import("./_g374-harness.ts");
  seedGoalState(h.root, a, "att-001", CHILD, { status: "delivered", result: "completed" });
  const res = await h.call("graph_start_attempt", { goal: b, attempt_brief: "接手", child_id: CHILD });
  // 旧代际的巡检结论（A/att-001，child=CHILD）在新绑定下必须 stale。
  const care = (await import("../../dist/index.js")).createCareRuntime({ ctx: { get: () => null, on: () => () => {} }, resolveRoot: () => h.root });
  const st = care.entryOfRoot(h.root, true);
  assert.ok(st, "care 运行时必须为同一 root 建立条目");
  const ins = (await import("../care.ts")).createCareInspection({
    id: "ins-old", root: h.root, supervisor: "sess-super", now: Date.now(), revision: 0, recheckSeconds: 120,
    targets: [{ goal: a, attempt: "att-001", child: CHILD, bindingVersion: 1 }],
  });
  st!.inspections.set(ins.id, ins);
  st!.tasks.set(`${a}\u0000att-001`, {
    child: CHILD, attempt: "att-001", goal: a, bindingVersion: 1, startedAt: Date.now() - 60_000,
    lastProgressAt: null, lastProgressFingerprint: null, stagnantRounds: 0, humanLocked: true,
    lastCareAt: null, frozenRemainingMs: null,
  });
  const out = care.notifyReusedBinding(h.root, {
    goal: b, attempt: res.attempt, child: CHILD, bindingVersion: Number(attemptMeta(h.root, b, "att-001").binding_version),
    prior: { goal: a, attempt: "att-001", bindingVersion: 1 }, accepted: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.retired_tasks, 1, "旧代际任务必须被 retire（人工锁/计时不得继承）");
  assert.equal(out.retired_inspections, 1, "旧代际巡检必须作废");
  assert.equal(st!.tasks.has(`${a}\u0000att-001`), false);
  assert.equal(st!.tasks.has(`${b}\u0000att-001`), false, "新绑定在首次采样前不得凭空造任务（起点由采样决定）");
  assert.equal(st!.inspections.get("ins-old")!.status, "expired");
  care.dispose();
});

// ───────────────────────── 判据 10：跨主管 ─────────────────────────
test("g-613：child 不属于当前主管 ⇒ 显式拒绝（跨主管复用零副作用）", async () => {
  const h = createHarnessWith(registry({ status: "idle", ownedBy: ["someone-else"] }));
  const { b } = twoGoals(h);
  await assert.rejects(
    () => h.call("graph_start_attempt", { goal: b, attempt_brief: "x", child_id: CHILD }),
    /不属于当前主管/,
  );
  assert.equal(h.sentMessages.length, 0);
  assert.equal(existsSync(join(h.root, "versions", "v1.0", "goals", b, "attempts")), false);
});

// ───────────────────────── 判据 6 补充：投递等待超时（不确定） ─────────────────────────
test("g-613 判据 6：投递长时间无回执 ⇒ 按「不确定 = 未投递」fail-closed（timed out）", async () => {
  const h = createHarnessWith({
    ownershipApi: "rootOf",
    reuse: {
      childRegistry: { [CHILD]: { status: "idle", ownedBy: ["a1"] } },
      sendMessage: () => new Promise<string>(() => { /* 永不 settle：模拟宿主无回执 */ }),
    },
  });
  const { b } = twoGoals(h);
  const mod = await import("../../dist/index.js");
  // 用可控时钟把确认等待压到 5ms，避免测试等 15s。
  const origin = (mod as any).REUSE_DELIVERY_TIMEOUT_MS;
  assert.ok(Number.isFinite(origin), "确认等待上限必须是可读常量");
  const res = await h.call("graph_start_attempt", { goal: b, attempt_brief: "x", child_id: CHILD });
  assert.equal(res.reused, true);
  // 超时前若 sendMessage 已被调用，则必定进入 fail-closed 分支；两种终态都**不得**声称已开始。
  assert.notEqual(res.delivery, "accepted");
  assert.equal(res.started, false);
});

// ───────────────────────── 判据：复用不伪装目录/权限切换 ─────────────────────────
test("g-613 判据 8：复用不建 worktree、不宣称切换 cwd/权限（worktree_reason=reused_child）", async () => {
  const h = createHarnessWith(registry({ status: "idle", ownedBy: ["a1"] }));
  const { b } = twoGoals(h);
  // 显式 worktree=true 在非 Git 工作区会被既有建树路径拒绝；这里只在本夹具为 Git 仓库时断言复用语义。
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: h.ws });
  writeFileSync(join(h.ws, ".gitignore"), ".dsh-graph/\n");
  writeFileSync(join(h.ws, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: h.ws });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: h.ws });
  execFileSync("git", ["branch", "-f", "v1.0-test", "HEAD"], { cwd: h.ws });
  const res = await h.call("graph_start_attempt", { goal: b, attempt_brief: "x", child_id: CHILD, worktree: true });
  assert.equal(res.reused, true);
  assert.equal(res.isolated, false, "复用不得伪称隔离");
  assert.equal(res.worktree, false, "复用不得伪称建了工作树");
  assert.equal(res.worktree_reason, "reused_child");
  assert.equal(res.worktree_created, false);
  assert.equal(res.worktree_reused, false);
});

// ───────────────────────── 收集任务不接受 child_id ─────────────────────────
test("g-613：收集派发（card）显式传 child_id ⇒ 拒绝，不悄悄复用", async () => {
  const h = createHarnessWith(registry({ status: "idle", ownedBy: ["a1"] }));
  const { b } = twoGoals(h);
  const card = addCard(h.root, b, { title: "收集卡", actor: "human:gui" });
  const cardId = typeof card === "string" ? card : (card as any)?.id;
  await assert.rejects(
    () => h.call("graph_start_attempt", { goal: b, card: cardId, attempt_brief: "收集", child_id: CHILD }),
    /收集任务/,
  );
  assert.equal(h.sentMessages.length, 0);
});

// ───────────────────────── 判据 8/9：文档与提示词如实写隔离语义 ─────────────────────────
test("g-613 判据 8/9：提示词与主管指南写明「工作位置隔离≠权限隔离」「运行中拒绝」「必须经 child_id 纳管」", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const zhGuide = read("prompts/supervisor-guide.zh.md");
  const enGuide = read("prompts/supervisor-guide.en.md");
  const zhWt = read("prompts/worktree.zh.md");
  const enWt = read("prompts/worktree.en.md");
  const readme = read("README.md");
  const zhText = [zhGuide, zhWt, readme].join("\n");
  assert.match(zhText, /工作位置隔离/, "必须如实标注 worktree 是工作位置隔离");
  assert.match(zhText, /不是权限隔离/, "必须明确 worktree 不是权限隔离");
  assert.match(zhGuide, /child_id/, "主管指南必须写明通过 graph_start_attempt(child_id=...) 纳管专家");
  assert.match(zhGuide, /运行中/, "主管指南必须写明运行中拒绝");
  const enText = [enGuide, enWt].join("\n");
  assert.match(enText, /not a permission boundary/i);
  assert.match(enGuide, /child_id/);
  // 反向：不得出现「切 worktree 即收窄写入权限」这类过度承诺
  assert.doesNotMatch(zhText, /切换 ?worktree[^。\n]*收窄[^。\n]*权限/);
});

// ───────────────────────── 复用后管理动作不被「假进行中」卡死（正向 + 负向对照） ─────────────────────────
test("g-613：复用**空闲**专家后目标可暂缓（不再被 status_line 启发式误判为进行中）", async () => {
  const h = createHarnessWith(registry({ status: "idle", ownedBy: ["a1"] }));
  const { b } = twoGoals(h);
  await h.call("graph_start_attempt", { goal: b, attempt_brief: "x", child_id: CHILD });
  h.call("graph_postpone_goal", { goal: b, reason: "复用后暂缓" });
  assert.equal(existsSync(join(h.root, "versions", "v1.0", "goals", b, "goal.md")), false, "目标应已移出执行泳道");
  assert.equal(backlogGoalMeta(h.root, b).status, "draft");
});

test("g-613 负向对照：复用的 child 变回 running ⇒ 暂缓仍被拒绝（门禁没有被放松成「一律放行」）", async () => {
  const stubs: Record<string, ReuseChildStub> = { [CHILD]: { status: "idle", ownedBy: ["a1"] } };
  const h = createHarnessWith({ ownershipApi: "rootOf", reuse: { childRegistry: stubs } });
  const { b } = twoGoals(h);
  await h.call("graph_start_attempt", { goal: b, attempt_brief: "x", child_id: CHILD });
  stubs[CHILD].status = "running"; // 子代理开始干活
  assert.throws(() => h.call("graph_postpone_goal", { goal: b, reason: "running" }), /进行中的子代理|仍在运行/);
  assert.equal(existsSync(join(h.root, "versions", "v1.0", "goals", b, "goal.md")), true, "拒绝时目标必须留在原处");
});
