/**
 * g-506：子代理长任务关照的离线回归（零网络、零真实 provider、零费用）。
 *
 * 覆盖：
 *  1. 两级配置（profile 全局 / project 三态 + 时间参数继承/覆盖）、raw+malformed 闭锁与写侧拒绝；
 *  2. 调度状态机：禁用/能力缺口/无任务/暂停/待人/未到期/主管忙/空闲未知/去重/投递；
 *     多个任务取最早到期；暂停逐任务冻结剩余、继续接续、重置计满且保持暂停；
 *  3. 结论计数：unknown 不计数、3 份新鲜 no-progress 升级、progress 归零但**不解除**人工锁；
 *     事件先行、一次性幂等、旧 attempt/绑定/身份/过期拒绝；
 *  4. **真实公开宿主栈**（真实 cordis + Session/AgentRegistry/AgentLoop/LlmRuntime + fake adapter）：
 *     真实 `Agent.send(message,"next-turn",true)` + 自定义 care source（不冒充 human）、
 *     `runMaintenance` 真 idle 抢占/忙时延后、inbox delivered/claimed 证据、发送返回≠处理完成；
 *  5. g507 门禁下的 REST status/control（401/403/503/409）与暂停/继续/重置语义；
 *  6. 与 g505 保活的结构性隔离：care source 不被当作 human 活动，保活 ping 不产生关照。
 *
 * 边界：未连接任何真实 provider/LLM；真实主管判断、真实中断/续轮干预、真实 GUI 与付费唤醒仍需另行授权。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  CARE_DEFAULTS,
  CARE_OUTCOMES,
  CARE_MAX_UNANSWERED_REMINDERS,
  applyCareDelivery,
  applyCareInspectionOutcome,
  applyCareOutcome,
  careEffectiveProjection,
  careInspectionFreshnessMs,
  careResolutionOf,
  careStatusProjection,
  careTaskDueAt,
  createCareInspection,
  decideCare,
  expireCareInspection,
  formatCareWakeMessage,
  isCareReminderStillValid,
  newCareGroupState,
  normalizeCareMode,
  normalizeCareOutcome,
  normalizeCareSeconds,
  pauseCare,
  resetCare,
  resolveCare,
  resolveCareTiming,
  resumeCare,
  validateCareOutcome,
  type CareGroupState,
  type CareInspection,
  type CareTaskState,
} from "../care.ts";
import { init, readProjectConfig, writeProjectConfig, settingsPostSchema, validateSchema } from "../ops.ts";
import { appendEvent, readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";
import { ownerConnectionStub, entryHandler, createRegisterStub, OWNER_HEADER } from "./_http-auth-harness.ts";

// ───────────────────────────── 公共夹具 ─────────────────────────────
const TMP_ROOTS: string[] = [];
function tmpDir(tag: string): string {
  const base = join(process.cwd(), "tmp");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `g506-${tag}-`));
  TMP_ROOTS.push(dir);
  return dir;
}
function makeBoard(projectYaml = ""): string {
  const root = tmpDir("board");
  init(root);
  if (projectYaml) writeFileSync(join(root, "project.yaml"), projectYaml);
  return root;
}
test.after(() => {
  for (const root of TMP_ROOTS.splice(0)) { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function task(overrides: Partial<CareTaskState> = {}): CareTaskState {
  return {
    child: "child-a",
    attempt: "att-001",
    goal: "goal-a",
    bindingVersion: 1,
    startedAt: 1_000_000,
    lastProgressAt: null,
    lastProgressFingerprint: null,
    stagnantRounds: 0,
    humanLocked: false,
    lastCareAt: null,
    frozenRemainingMs: null,
    ...overrides,
  };
}
function group(overrides: Partial<CareGroupState> = {}): CareGroupState {
  return { ...newCareGroupState(), ...overrides };
}
const NOW = 1_000_000;

// ───────────────────────────── 1. 配置解析 ─────────────────────────────

test("g506 配置：三态归一/畸形/优先级/来源/时间参数继承覆盖", () => {
  assert.equal(normalizeCareMode("TRUE"), "true");
  assert.equal(normalizeCareMode(true), "true");
  assert.equal(normalizeCareMode("yes"), "inherit");
  assert.equal(normalizeCareMode(1), "inherit");
  assert.equal(normalizeCareSeconds("300"), 300);
  assert.equal(normalizeCareSeconds(300.9), 300);
  assert.equal(normalizeCareSeconds(5), null);
  assert.equal(normalizeCareSeconds(90000), null);
  assert.equal(normalizeCareSeconds("abc"), null);

  // 项目显式覆盖全局
  const projOn = { mode: "true" as const, thresholdSeconds: 120, recheckSeconds: null };
  const r1 = resolveCare(projOn, { enabled: false });
  assert.equal(r1.enabled, true);
  assert.equal(r1.source, "project_explicit");
  // 项目 inherit + 全局显式
  const r2 = resolveCare({ mode: "inherit" as const, thresholdSeconds: null, recheckSeconds: null }, { enabled: false });
  assert.equal(r2.enabled, false);
  assert.equal(r2.source, "global_explicit");
  // 都未配置 ⇒ 受控默认开启
  const r3 = resolveCare(null, null);
  assert.equal(r3.enabled, true);
  assert.equal(r3.source, "global_default");
  // 项目畸形 ⇒ fail-closed 关闭（绝不猜「开」）
  const r4 = resolveCare({ mode: "on" as any, thresholdSeconds: null, recheckSeconds: null }, { enabled: true });
  assert.equal(r4.enabled, false);
  assert.equal(r4.source, "project_invalid");
  assert.equal(r4.malformed, true);
  // 全局畸形 ⇒ 关闭
  const r5 = resolveCare({ mode: "inherit" as const, thresholdSeconds: null, recheckSeconds: null }, { enabled: "yes" as any });
  assert.equal(r5.enabled, false);
  assert.equal(r5.source, "global_invalid");

  // 时间参数：项目 > 全局 > 默认，来源可读
  const t = resolveCareTiming(
    { mode: "inherit", thresholdSeconds: 120, recheckSeconds: null },
    { enabled: true, thresholdSeconds: 240, recheckSeconds: 180 },
  );
  assert.deepEqual(t, { thresholdSeconds: 120, recheckSeconds: 180, thresholdSource: "project_explicit", recheckSource: "global_explicit" });
  const t2 = resolveCareTiming({ mode: "inherit", thresholdSeconds: null, recheckSeconds: null }, { enabled: true });
  assert.equal(t2.thresholdSeconds, CARE_DEFAULTS.thresholdSeconds);
  assert.equal(t2.recheckSeconds, CARE_DEFAULTS.recheckSeconds);
  assert.equal(t2.thresholdSource, "global_default");

  const eff = careEffectiveProjection(projOn, { enabled: null });
  assert.equal(eff.effective, true);
  assert.equal(eff.threshold_seconds, 120);
  assert.equal(eff.max_stagnant_rounds, 3);
  assert.deepEqual([...eff.modes], ["inherit", "true", "false"]);
});

test("g506 配置：project.yaml 读侧 raw 坏值闭锁 + 写侧拒绝 + settings schema", () => {
  const root = makeBoard("supervisor:\n  care: on\n  care_threshold_seconds: 5\n  care_recheck_seconds: nope\n");
  const cfg = readProjectConfig(root);
  assert.equal(cfg.supervisor.care, "inherit");
  assert.equal(cfg.supervisor.care_malformed, true);
  assert.equal(cfg.supervisor.care_raw, "on");
  assert.equal(cfg.supervisor.care_threshold_seconds, null);
  assert.equal(cfg.supervisor.care_threshold_seconds_malformed, true);
  assert.equal(cfg.supervisor.care_recheck_seconds_malformed, true);
  const eff = careEffectiveProjection(
    { mode: cfg.supervisor.care_raw as any, thresholdSeconds: null, recheckSeconds: null },
    { enabled: null },
  );
  assert.equal(eff.effective, false, "畸形项目值必须 fail-closed 关闭");

  // 写侧：非法三态/越界秒数一律拒绝
  assert.throws(() => writeProjectConfig(root, { supervisor: { care: "yes" } }, "test"), /supervisor\.care/);
  assert.throws(() => writeProjectConfig(root, { supervisor: { care_threshold_seconds: 5 } }, "test"), /care_threshold_seconds/);
  assert.throws(() => writeProjectConfig(root, { supervisor: { care_recheck_seconds: 999999 } }, "test"), /care_recheck_seconds/);
  // 合法写入：true 落盘、inherit 清空叶子
  writeProjectConfig(root, { supervisor: { care: "true", care_threshold_seconds: 120, care_recheck_seconds: 180 } }, "test");
  const cfg2 = readProjectConfig(root);
  assert.equal(cfg2.supervisor.care, "true");
  assert.equal(cfg2.supervisor.care_threshold_seconds, 120);
  assert.equal(cfg2.supervisor.care_recheck_seconds, 180);
  assert.equal(cfg2.supervisor.care_malformed, false);
  writeProjectConfig(root, { supervisor: { care: null, care_threshold_seconds: null, care_recheck_seconds: null } }, "test");
  const cfg3 = readProjectConfig(root);
  assert.equal(cfg3.supervisor.care, null);
  assert.equal(cfg3.supervisor.care_threshold_seconds, null);
  assert.ok(!/^\s*care:/m.test(readFileSync(join(root, "project.yaml"), "utf8")), "inherit 不实体化");

  // schema 层同样拒绝
  assert.equal(validateSchema({ supervisor: { care: "true", care_threshold_seconds: 120 } }, settingsPostSchema).valid, true);
  assert.equal(validateSchema({ supervisor: { care: "yes" } }, settingsPostSchema).valid, false);
  assert.equal(validateSchema({ supervisor: { care_threshold_seconds: 5 } }, settingsPostSchema).valid, false);
});

// ───────────────────────────── 2. 调度状态机 ─────────────────────────────

test("g506 调度：禁用/能力缺口/无任务/暂停/待人/未到期/主管忙/未知/去重/投递", () => {
  const base = {
    now: NOW,
    enabled: true,
    thresholdSeconds: 300,
    recheckSeconds: 300,
    maxStagnantRounds: 3,
    idle: true as boolean | null,
    group: group(),
    tasks: [task({ startedAt: NOW - 301_000 })],
  };
  assert.equal(decideCare({ ...base, enabled: false }, true).phase, "disabled");
  assert.equal(decideCare({ ...base, enabled: false }, true).nextDueAt, null);
  assert.equal(decideCare(base, false).phase, "unavailable");
  assert.equal(decideCare({ ...base, tasks: [] }, true).phase, "idle");
  assert.equal(decideCare({ ...base, group: group({ paused: true, pausedRemainingMs: 12_000 }) }, true).phase, "paused");
  assert.equal(decideCare({ ...base, tasks: [task({ startedAt: NOW - 301_000, stagnantRounds: 3 })] }, true).phase, "awaiting_human");

  const counting = decideCare({ ...base, tasks: [task({ startedAt: NOW - 100_000 })] }, true);
  assert.equal(counting.phase, "counting");
  assert.equal(counting.nextDueAt, NOW + 200_000);
  assert.equal(counting.nextDueInMs, 200_000);
  assert.equal(counting.deliver, false);

  const busy = decideCare({ ...base, idle: false }, true);
  assert.equal(busy.phase, "waiting_supervisor");
  assert.equal(busy.deliver, false);
  assert.equal(busy.nextDueAt, NOW - 1_000);

  const unknown = decideCare({ ...base, idle: null }, true);
  assert.equal(unknown.deliver, false, "空闲未知 fail-safe 不投递");

  const delivering = decideCare({ ...base, delivering: true }, true);
  assert.equal(delivering.deliver, false);
  assert.equal(delivering.reason, "delivering");

  const due = decideCare(base, true);
  assert.equal(due.deliver, true);
  assert.equal(due.reason, "deliver");

  // 多个任务：取最早有效到期；已锁定任务不产生倒计时
  const multi = decideCare({
    ...base,
    tasks: [
      task({ child: "c1", attempt: "a1", startedAt: NOW - 100_000 }),
      task({ child: "c2", attempt: "a2", startedAt: NOW - 200_000 }),
      task({ child: "c3", attempt: "a3", startedAt: NOW - 900_000, humanLocked: true }),
    ],
  }, true);
  assert.equal(multi.nextDueAt, NOW + 100_000);
  assert.deepEqual(multi.escalateTasks, ["c3"]);
  assert.equal(multi.deliver, false);
});

test("g506 调度：暂停逐任务冻结剩余、继续接续、重置计满且保持暂停、不清计数/人工锁", () => {
  const tasks = [
    task({ child: "c1", attempt: "a1", startedAt: NOW - 100_000 }),
    task({ child: "c2", attempt: "a2", startedAt: NOW - 200_000, stagnantRounds: 2 }),
  ];
  const p = pauseCare(group(), tasks, { now: NOW, thresholdSeconds: 300, recheckSeconds: 300 });
  assert.equal(p.group.paused, true);
  assert.equal(p.group.pausedRemainingMs, 100_000);
  assert.deepEqual(p.tasks.map((t) => t.frozenRemainingMs), [200_000, 100_000]);
  // 暂停期间时间流逝
  const later = NOW + 60_000;
  const pausedDecision = decideCare({
    now: later, enabled: true, thresholdSeconds: 300, recheckSeconds: 300, maxStagnantRounds: 3,
    idle: true, group: p.group, tasks: p.tasks,
  }, true);
  assert.equal(pausedDecision.phase, "paused");
  assert.equal(pausedDecision.nextDueAt, null, "暂停不得显示会推进的倒计时");
  // 继续：各自从冻结剩余接续（不是重新计满）
  const r = resumeCare(p.group, p.tasks, { now: later, thresholdSeconds: 300, recheckSeconds: 300 });
  assert.equal(r.group.paused, false);
  assert.equal(r.group.revision, p.group.revision + 1);
  const due1 = careTaskDueAt(r.tasks[0], { thresholdSeconds: 300, recheckSeconds: 300, resetAt: r.group.resetAt });
  const due2 = careTaskDueAt(r.tasks[1], { thresholdSeconds: 300, recheckSeconds: 300, resetAt: r.group.resetAt });
  assert.equal(due1, later + 200_000);
  assert.equal(due2, later + 100_000);
  // 重置（非暂停）：只重设计时，不碰计数/锁
  const reset = resetCare(r.group, r.tasks, { now: later, thresholdSeconds: 300, recheckSeconds: 300 });
  assert.equal(reset.group.resetAt, later);
  assert.equal(reset.tasks[1].stagnantRounds, 2);
  assert.equal(reset.tasks[1].humanLocked, false);
  // 暂停中重置：仍暂停，剩余为满额
  const p2 = pauseCare(group(), tasks, { now: NOW, thresholdSeconds: 300, recheckSeconds: 300 });
  const resetPaused = resetCare(p2.group, p2.tasks, { now: NOW + 10_000, thresholdSeconds: 300, recheckSeconds: 300 });
  assert.equal(resetPaused.group.paused, true);
  assert.equal(resetPaused.group.pausedRemainingMs, 300_000);
  assert.deepEqual(resetPaused.tasks.map((t) => t.frozenRemainingMs), [300_000, 300_000]);
  // 幂等：重复暂停/继续不递增 revision
  assert.equal(pauseCare(p.group, p.tasks, { now: later, thresholdSeconds: 300, recheckSeconds: 300 }).group.revision, p.group.revision);
  assert.equal(resumeCare(r.group, r.tasks, { now: later, thresholdSeconds: 300, recheckSeconds: 300 }).group.revision, r.group.revision);
});

test("g506 计数：unknown 不计数、no-progress 递增、3 次锁定、progress 归零但不清人工锁", () => {
  let g = group();
  let tasks = [task()];
  const apply = (kind: "progress" | "no-progress" | "unknown", now = NOW) => {
    const out = applyCareOutcome(g, tasks, { child: "child-a", attempt: "att-001" }, {
      kind, fingerprint: `${kind}-evidence`, now, maxStagnantRounds: 3,
    });
    g = out.group;
    tasks = out.tasks;
    return out;
  };
  let r = apply("unknown");
  assert.equal(r.tasks[0].stagnantRounds, 0);
  assert.equal(r.counted, false);
  r = apply("no-progress");
  assert.equal(r.tasks[0].stagnantRounds, 1);
  assert.equal(r.counted, true);
  r = apply("no-progress");
  assert.equal(r.tasks[0].stagnantRounds, 2);
  r = apply("no-progress");
  assert.equal(r.tasks[0].stagnantRounds, 3);
  assert.equal(r.tasks[0].humanLocked, true);
  assert.equal(r.group.escalated, true);
  // progress 归零，但人工锁保持
  r = apply("progress");
  assert.equal(r.tasks[0].stagnantRounds, 0);
  assert.equal(r.tasks[0].humanLocked, true, "progress 绝不解除已有人工锁");
  assert.equal(r.group.escalated, true);
  // 只影响目标 child/attempt：其他任务不变
  const other = task({ child: "other", attempt: "att-9", stagnantRounds: 2 });
  const r2 = applyCareOutcome(g, [tasks[0], other], { child: "child-a", attempt: "att-001" }, {
    kind: "no-progress", now: NOW, maxStagnantRounds: 3,
  });
  assert.equal(r2.tasks[1].stagnantRounds, 2);
});

test("g506 投递：只推进本次覆盖任务；巡检记录一次性/新鲜度/旧绑定校验", () => {
  const tasks = [task({ child: "c1", attempt: "a1" }), task({ child: "c2", attempt: "a2", lastCareAt: NOW - 50_000 })];
  const applied = applyCareDelivery(group(), tasks, NOW, [{ child: "c1", attempt: "a1" }]);
  assert.equal(applied.tasks[0].lastCareAt, NOW);
  assert.equal(applied.tasks[1].lastCareAt, NOW - 50_000, "未到期任务不得被顺带重置计时");

  const insp = createCareInspection({
    id: "insp-1", root: "/ws", supervisor: "sup-1", now: NOW, revision: 3, recheckSeconds: 300,
    targets: [{ goal: "goal-a", attempt: "att-001", child: "child-a", bindingVersion: 2 }],
  });
  assert.equal(insp.expiresAt, NOW + careInspectionFreshnessMs(300));
  const ok = validateCareOutcome({
    inspection: insp, now: NOW + 1000, root: "/ws", supervisor: "sup-1",
    goal: "goal-a", attempt: "att-001", child: "child-a", bindingVersion: 2,
    outcome: "no-progress", evidenceDigest: "d1",
  });
  assert.equal(ok.ok, true);
  // 错身份/错根/旧绑定/过期/未知 inspection
  const wrongId = validateCareOutcome({ ...{ inspection: insp, now: NOW, root: "/ws", supervisor: "other", goal: "goal-a", attempt: "att-001", child: "child-a", bindingVersion: 2, outcome: "progress", evidenceDigest: "d" } });
  assert.equal(wrongId.ok, false);
  assert.equal((wrongId as any).code, "wrong_identity");
  assert.equal((validateCareOutcome({ inspection: insp, now: NOW, root: "/other", supervisor: "sup-1", goal: "goal-a", attempt: "att-001", child: "child-a", bindingVersion: 2, outcome: "progress", evidenceDigest: "d" }) as any).code, "wrong_root");
  assert.equal((validateCareOutcome({ inspection: insp, now: NOW, root: "/ws", supervisor: "sup-1", goal: "goal-a", attempt: "att-001", child: "child-a", bindingVersion: 3, outcome: "progress", evidenceDigest: "d" }) as any).code, "stale_binding");
  assert.equal((validateCareOutcome({ inspection: insp, now: insp.expiresAt + 1, root: "/ws", supervisor: "sup-1", goal: "goal-a", attempt: "att-001", child: "child-a", bindingVersion: 2, outcome: "progress", evidenceDigest: "d" }) as any).code, "expired");
  assert.equal((validateCareOutcome({ inspection: null, now: NOW, root: "/ws", supervisor: "sup-1", goal: "goal-a", attempt: "att-001", child: "child-a", bindingVersion: 2, outcome: "progress", evidenceDigest: "d" }) as any).code, "inspection_unknown");
  // 一次性 + 幂等
  const resolved = applyCareInspectionOutcome(insp, { goal: "goal-a", attempt: "att-001", child: "child-a", kind: "no-progress", evidenceDigest: "d1", now: NOW + 1000 });
  const again = validateCareOutcome({
    inspection: resolved, now: NOW + 2000, root: "/ws", supervisor: "sup-1",
    goal: "goal-a", attempt: "att-001", child: "child-a", bindingVersion: 2,
    outcome: "no-progress", evidenceDigest: "d1",
  });
  assert.equal(again.ok, true);
  assert.equal((again as any).idempotent, true);
  const diff = validateCareOutcome({
    inspection: resolved, now: NOW + 2000, root: "/ws", supervisor: "sup-1",
    goal: "goal-a", attempt: "att-001", child: "child-a", bindingVersion: 2,
    outcome: "progress", evidenceDigest: "d2",
  });
  assert.equal(diff.ok, false);
  assert.equal((diff as any).code, "already_resolved");
  // 过期状态推进
  assert.equal(expireCareInspection(insp, insp.expiresAt + 1).status, "expired");
});

test("g506 投影/正文：到零只表示巡检到期；唤醒正文有界且要求窄工具回传", () => {
  const decision = decideCare({
    now: NOW, enabled: true, thresholdSeconds: 300, recheckSeconds: 300, maxStagnantRounds: 3,
    idle: true, group: group(), tasks: [task({ startedAt: NOW - 301_000 })],
  }, true);
  const proj = careStatusProjection({
    now: NOW, root: "/ws", supervisor: "sup-1", supervisorLive: true, supervisorIdle: true,
    configured: careEffectiveProjection(null, null),
    capable: { available: {}, missing: [], minimal: true } as any,
    decision, group: group(), tasks: [task({ startedAt: NOW - 301_000 })],
    pendingInspections: [], lastOutcome: null,
  });
  assert.equal(proj.next_due_at, NOW - 1000);
  assert.equal(proj.server_now, NOW);
  const text = formatCareWakeMessage({
    inspectionId: "insp-1",
    targets: [{ goal: "goal-a", attempt: "att-001", child: "child-a", elapsedMs: 400_000, lastCareAgoMs: null, stagnantRounds: 0, maxStagnantRounds: 3, humanLocked: false }],
    maxStagnantRounds: 3,
  });
  assert.match(text, /graph_care_outcome/);
  assert.match(text, /inspection: insp-1/);
  assert.match(text, /不是\*\*卡死证据|不是.*卡死/);
  assert.ok(text.length < 4000, "唤醒正文必须保持有界");
  // 返工：正文与巡检 targets 必须同集合，不得截断到前 8 个（否则第 9+ 个任务无法按正文回传）
  const many = Array.from({ length: 10 }, (_, i) => ({ goal: `goal-${i}`, attempt: `att-${i}`, child: `child-${i}`, elapsedMs: 400_000, lastCareAgoMs: null, stagnantRounds: 0, maxStagnantRounds: 3, humanLocked: false }));
  const full = formatCareWakeMessage({ inspectionId: "insp-many", targets: many, maxStagnantRounds: 3 });
  for (const t of many) assert.ok(full.includes(`goal=${t.goal}`), `唤醒正文必须包含 ${t.goal}（不得只列前 8 个）`);
  const en = formatCareWakeMessage({ inspectionId: "insp-1", targets: [], maxStagnantRounds: 3, lang: "en" });
  assert.match(en, /NOT evidence of a stall/);
  assert.match(en, /graph_care_outcome/);
});

// ───────────────────────────── 3. 真实宿主全栈 ─────────────────────────────

/** 真实宿主包解析（与既有 g505 套件同口径；不联网安装）。 */
async function resolveHostScope(): Promise<string> {
  const env = process.env.G505_HOST_STACK_DIR || process.env.G507_HOST_STACK_DIR;
  if (env) return env;
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    for (const scope of [
      join(globalRoot, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"),
      join(globalRoot, "@deepseek-ai"),
    ]) {
      if (existsSync(join(scope, "dsh-llm", "lib", "index.js")) && existsSync(join(scope, "dsh-agent", "lib", "index.js"))) return scope;
    }
  } catch { /* npm 不可用 ⇒ 尝试下一来源 */ }
  const { resolveHostStack } = await import("./_host-stack.ts");
  const { dir } = resolveHostStack();
  if (!existsSync(join(dir, "dsh-llm", "lib", "index.js"))) {
    throw new Error(`g506 测试需要同时包含 dsh-llm/dsh-agent 的宿主栈目录；当前解析到 ${dir}（请设置 G506_HOST_STACK_DIR）`);
  }
  return dir;
}
async function loadHostStack() {
  const dir = await resolveHostScope();
  const load = (pkg: string, file = "index.js") => import(pathToFileURL(join(dir, pkg, "lib", file)).href);
  const cordis = await load("cordis");
  const llm = await load("dsh-llm");
  const agent = await load("dsh-agent");
  const session = await load("dsh-session");
  const projection = await load("dsh-session-projection");
  const systemPrompt = await load("dsh-system-prompt");
  const tools = await load("dsh-tools");
  const loop = await load("dsh-agent-loop");
  return {
    Context: cordis.Context, llm, AgentRegistry: agent.AgentRegistry, SessionStore: session.SessionStore,
    SessionProjections: projection.default, SystemPrompt: systemPrompt.SystemPrompt, ToolRuntime: tools.ToolRuntime,
    AgentLoop: loop.AgentLoop,
  };
}

function makeFakeAdapter(LlmAdapter: any) {
  class RecordingAdapter extends LlmAdapter {
    calls: any[] = [];
    holds = new Map<string, { gate: Promise<void>; release: () => void }>();
    releases: Array<() => void> = [];
    hold(text: string) {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = () => r(); });
      this.releases.push(release);
      this.holds.set(text, { gate, release });
      return gate;
    }
    release(text: string) {
      const hit = this.holds.get(text);
      if (hit) { hit.release(); this.holds.delete(text); }
    }
    releaseAll() {
      for (const r of this.releases.splice(0)) r();
      this.holds.clear();
    }
    providerInfo(provider: string) { return { id: provider, name: provider, protocol: "fake" }; }
    async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, inputModalities: ["text"], context: { contextWindow: 128000 }, defaultMaxTokens: 8192 };
    }
    async *stream(options: any) {
      this.calls.push(options);
      const serialized = JSON.stringify(options.messages);
      for (const [text, hit] of this.holds) if (serialized.includes(text)) await hit.gate;
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "ok" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "ok" } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  return new RecordingAdapter();
}

async function makeRealHost() {
  const { Context, llm: llmMod, AgentRegistry, SessionStore, SessionProjections, SystemPrompt, ToolRuntime, AgentLoop } = await loadHostStack();
  const hostCtx = new Context();
  new SessionStore(hostCtx);
  new SessionProjections(hostCtx);
  new SystemPrompt(hostCtx, {});
  new ToolRuntime(hostCtx, {});
  const reg = new AgentRegistry(hostCtx);
  const llmRuntime = new llmMod.LlmRuntime(hostCtx);
  const adapter = makeFakeAdapter(llmMod.LlmAdapter);
  llmRuntime.registerAdapter(["observed"], adapter);
  new AgentLoop(hostCtx, { agents: [], maxParallelToolCalls: 10 });
  return { hostCtx, llm: llmMod, llmRuntime, reg, adapter };
}

function fakeClock(start = NOW) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } };
}
function fakeScheduler(clock: ReturnType<typeof fakeClock>) {
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => any }>();
  const setTimeoutFn = (fn: () => any, ms: number) => { const id = ++seq; timers.set(id, { at: clock.now() + Math.max(0, ms), fn }); return id; };
  const clearTimeoutFn = (id: number) => { timers.delete(id); };
  const advanceTo = async (target: number) => {
    for (let guard = 0; guard < 200; guard += 1) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (!due.length) break;
      const [id, v] = due[0];
      timers.delete(id);
      clock.set(v.at);
      await v.fn();
    }
    clock.set(target);
    await new Promise((r) => setImmediate(r));
  };
  return { setTimeoutFn, clearTimeoutFn, advanceTo, timers };
}

async function makeCareRuntime(host: any, opts: {
  clock: ReturnType<typeof fakeClock>;
  scheduler: ReturnType<typeof fakeScheduler>;
  project?: any;
  payload?: any;
  supervisorId?: string;
  readSupervisorSessionFn?: (root: string) => string | null;
  appendEventFn?: (root: string, ev: any) => void;
  readGlobal?: () => any;
  resolveRoot?: (ws: string) => string | null;
}) {
  const mod: any = await import("../../dist/index.js");
  const events: any[] = [];
  const runtime = mod.createCareRuntime({
    ctx: { on: (n: string, h: any) => host.hostCtx.on(n, h), get: (n: string) => (n === "agents" ? host.reg : n === "llm" ? host.llmRuntime : n === "subagents" ? host.subagents : undefined) },
    readGlobal: opts.readGlobal ?? (() => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false, available: true, raw: "on" })),
    resolveRoot: opts.resolveRoot ?? ((ws: string) => ws),
    readProjectConfigFn: () => opts.project ?? { supervisor: { care: true, care_threshold_seconds: 30, care_recheck_seconds: 30 } },
    readSupervisorSessionFn: opts.readSupervisorSessionFn ?? (() => opts.supervisorId),
    readBoardPayload: opts.readBoardPayload ?? (() => opts.payload ?? null),
    now: opts.clock.now,
    setTimeoutFn: opts.scheduler.setTimeoutFn,
    clearTimeoutFn: opts.scheduler.clearTimeoutFn,
    appendEventFn: opts.appendEventFn ?? ((root: string, ev: any) => { events.push(ev); }),
    makeInspectionId: (() => { let i = 0; return () => `insp-${++i}`; })(),
    log: () => {},
  });
  return { runtime, events };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`超时等待：${label}`);
    await new Promise((r) => setImmediate(r));
  }
}

const WS = "/ws";
const boardPayload = (goals) => ({ versions: [{ slug: "v1", status: "active", goals }], standalone: [], backlog: [] });

/** 写一个真实 board 目标（goal.md + attempts/att-001/attempt.md），供 B1 生产载荷回归。 */
function writeRealGoal(root: string, layout: { version?: string; standalone?: boolean; backlog?: boolean }, goal: {
  id: string; status?: string; child?: string; attempt?: string; version?: number; startedAt?: string;
}) {
  const attempt = goal.attempt ?? "att-001";
  const startedAt = goal.startedAt ?? new Date(NOW - 40_000).toISOString();
  const dir = layout.backlog
    ? join(root, "backlog")
    : layout.version
      ? join(root, "versions", layout.version, "goals", goal.id)
      : join(root, "goals", goal.id);
  mkdirSync(layout.backlog ? dir : join(dir, "attempts", attempt), { recursive: true });
  const goalMd = `---\n${JSON.stringify({
    id: goal.id,
    title: `goal ${goal.id}`,
    status: goal.status ?? "in_progress",
    type: "task",
    created_at: startedAt,
    version: layout.version ?? null,
    depends_on: [],
    review: { reviewer: "human", prompt: null },
    pk: { lanes: 1, sandbox: "directory" },
    rules_snapshot: null,
  }, null, 2)}\n---\n\n# goal ${goal.id}\n\n## 目标描述\n\nB1 fixture\n`;
  if (layout.backlog) {
    writeFileSync(join(dir, `${goal.id}.md`), goalMd);
    return;
  }
  writeFileSync(join(dir, "goal.md"), goalMd);
  if (layout.version) {
    const vdir = join(root, "versions", layout.version);
    if (!existsSync(join(vdir, "version.md"))) {
      writeFileSync(join(vdir, "version.md"), `---\n${JSON.stringify({ id: layout.version, name: layout.version, status: "active", created_at: startedAt }, null, 2)}\n---\n`);
    }
  }
  writeFileSync(join(dir, "attempts", attempt, "attempt.md"), `---\n${JSON.stringify({
    child_id: goal.child ?? "child-x",
    parent_session_id: "SUP_SESSION",
    binding_version: goal.version ?? 1,
    started_at: startedAt,
    executor: "agent:main",
    detached: false,
  }, null, 2)}\n---\n`);
}

test("g506 B1 真实 boardPayload：版本目标 + 独立目标均采样，backlog 排除，重复绑定只计一次", async () => {
  const root = makeBoard();
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-b1", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: root } })).agent;
  const childV = (await host.reg.create({ sessionId: "child-v", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: root } })).agent;
  const childS = (await host.reg.create({ sessionId: "child-s", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: root } })).agent;
  host.adapter.hold("CHILD-B1-V");
  host.adapter.hold("CHILD-B1-S");
  childV.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-B1-V" }], source: { kind: "user" } }), "next-turn", true);
  childS.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-B1-S" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => childV.status === "running" && childS.status === "running", "children running");

  writeRealGoal(root, { version: "v1" }, { id: "g-101", child: childV.id, version: 1 });
  writeRealGoal(root, { standalone: true }, { id: "g-102", child: childS.id, version: 1 });
  writeRealGoal(root, { backlog: true }, { id: "g-103", child: childS.id, version: 9 });
  // 重复绑定（同 child+attempt 被另一目标重复投影）⇒ 只应采样一次
  writeRealGoal(root, { standalone: true }, { id: "g-104", child: childV.id, version: 1 });
  for (const f of ["versions/v1/goals/g-101/attempts/att-001/attempt.md", "goals/g-102/attempts/att-001/attempt.md", "goals/g-104/attempts/att-001/attempt.md"]) {
    const abs = join(root, f);
    writeFileSync(abs, readFileSync(abs, "utf8").replace("SUP_SESSION", sup.id));
  }

  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime: mod } = await import("../../dist/index.js") as any;
  void mod;
  const ops: any = await import("../ops.ts");
  const runtime = (await import("../../dist/index.js") as any).createCareRuntime({
    ctx: { on: (n: string, h: any) => host.hostCtx.on(n, h), get: (n: string) => (n === "agents" ? host.reg : n === "llm" ? host.llmRuntime : undefined) },
    readGlobal: () => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false }),
    resolveRoot: (ws: string) => ws,
    readProjectConfigFn: () => ({ supervisor: { care: true, care_threshold_seconds: 30, care_recheck_seconds: 300 } }),
    readSupervisorSessionFn: () => sup.id,
    readBoardPayload: (r: string) => ops.getCachedBoardPayload(r, { lazy: true })?.payload ?? null,
    now: clock.now, setTimeoutFn: scheduler.setTimeoutFn, clearTimeoutFn: scheduler.clearTimeoutFn,
    appendEventFn: (_root: string, _ev: any) => {},
    makeInspectionId: (() => { let i = 0; return () => `b1-${++i}`; })(), log: () => {},
  });
  runtime.start();
  try {
    await runtime.sweep();
    await waitFor(() => sup.status === "idle", "supervisor turn");
    const st = runtime.statusFor(root);
    assert.deepEqual(st.tasks.map((t: any) => t.goal).sort(), ["g-101", "g-102"], "版本 + 独立目标各一；backlog 与重复绑定不计");
    const ins = runtime.entryOfRoot(root).inspections.get("b1-1");
    assert.ok(ins, "投递了真实巡检");
    assert.deepEqual(ins.targets.map((t: any) => t.goal).sort(), ["g-101", "g-102"]);
    // 真正的窄工具回传也必须用同一生产枚举找到版本/独立目标（而不是只看 payload.goals）。
    const submit = (goal: string, child2: string, outcome: string) => runtime.submitOutcome({
      root, supervisor: sup.id, inspection: "b1-1", goal, attempt: "att-001", child: child2, outcome, evidence: `b1 ${goal}`,
    });
    assert.equal(submit("g-101", childV.id, "no-progress").ok, true);
    assert.equal(submit("g-102", childS.id, "progress").ok, true);
    assert.equal(runtime.statusFor(root).tasks.filter((t: any) => t.human_locked).length, 0);
    assert.equal(runtime.statusFor(root).last_outcome?.outcome, "progress");
    // 负向：移除 standalone 支持（模拟旧枚举）后，独立目标不再出现——证明该分支真被覆盖。
    const payload = ops.getCachedBoardPayload(root, { lazy: true }).payload;
    const onlyVersions = { ...payload, standalone: [] };
    const tasksOnly = [...(onlyVersions.versions ?? []).flatMap((v: any) => v.goals ?? [])];
    assert.deepEqual(tasksOnly.map((g: any) => g.id), ["g-101"]);
    // 运行时负向：把 standalone 从载荷移除（模拟旧实现漏掉独立目标）⇒ 独立目标任务必须消失。
    const standaloneBackup = payload.standalone;
    payload.standalone = [];
    await runtime.sweep();
    assert.deepEqual(runtime.statusFor(root).tasks.map((t: any) => t.goal), ["g-101"], "移除 standalone 支持后独立目标不得再被采样");
    payload.standalone = standaloneBackup;
  } finally {
    host.adapter.releaseAll?.();
    runtime.dispose();
  }
});

test("g506 B2 未回复/unknown：连续 10 个周期最多 3 次实际提醒，未回复计数不增加 no-progress，之后等待人工", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-nr", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const child = (await host.reg.create({ sessionId: "child-nr", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  host.adapter.hold("CHILD-NR");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-NR" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const makePayload = () => boardPayload([{ id: "goal-nr", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  const payload = makePayload();
  const { runtime, events } = await makeCareRuntime(host, { clock, scheduler, payload, supervisorId: sup.id });
  runtime.start();
  try {
    // 完全不回复：每 301s 超过一次 300s 冷却/巡检新鲜度，10 个周期只允许 3 次实际 care.inspection。
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await runtime.sweep();
      await waitFor(() => sup.status === "idle", `turn ${cycle}`);
      clock.advance(301_000);
    }
    const inspections = events.filter((e) => e.event === "care.inspection");
    assert.equal(inspections.length, CARE_MAX_UNANSWERED_REMINDERS, "最多 3 次实际提醒（10 个周期也不得更多）");
    const st = runtime.statusFor(WS);
    assert.equal(st.phase, "awaiting_human");
    assert.equal(st.reason, "no_response_limit");
    assert.equal(st.tasks[0].stagnant_rounds, 0, "未回复绝不算 no-progress");
    assert.equal(st.tasks[0].reminders_sent, CARE_MAX_UNANSWERED_REMINDERS);
    assert.equal(st.tasks[0].human_locked, true);
    assert.equal(st.tasks[0].human_reason, "no_response_limit");
    assert.ok(events.some((e) => e.event === "care.escalated" && e.details?.no_progress_counted === false), "升级事件明确未计 no-progress");
    // 再推进 10 个周期也不得产生第 4 次提醒/新巡检
    for (let cycle = 0; cycle < 10; cycle += 1) { clock.advance(301_000); await runtime.sweep(); }
    assert.equal(events.filter((e) => e.event === "care.inspection").length, CARE_MAX_UNANSWERED_REMINDERS);
  } finally {
    host.adapter.releaseAll?.();
    runtime.dispose();
  }
});

test("g506 真实宿主：空闲主管到期唤醒使用真实 send + 独立 care source；send≠处理完成", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-1", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const child = (await host.reg.create({ sessionId: "child-1", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  host.adapter.hold("CARE-HOLD");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CARE-HOLD" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");

  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([{ id: "goal-a", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  const { runtime, events } = await makeCareRuntime(host, { clock, scheduler, payload, supervisorId: sup.id });
  runtime.start();
  try {
    await runtime.sweep();
    await waitFor(() => sup.status === "idle", "supervisor turn finished");
    assert.deepEqual(events.map((e) => e.event), ["care.inspection"]);
    const call = host.adapter.calls[host.adapter.calls.length - 1];
    const careMsg = call.messages.find((m: any) => m.source?.kind === "dsh-graph-care");
    assert.ok(careMsg, "主管确实收到 care message");
    assert.equal(careMsg.role, "user");
    assert.equal(careMsg.source.inspectionId, "insp-1");
    assert.equal(careMsg.source.form, "notice");
    assert.deepEqual(careMsg.source.targets.map((t: any) => t.child), [child.id]);
    assert.ok(careMsg.content[0].text.includes("graph_care_outcome"));
    // 状态：已 claimed（不是「已处理完成」）；计数仍为 0
    const st = runtime.statusFor(WS);
    assert.equal(st.pending_inspections.length, 1);
    assert.ok(["delivered", "claimed"].includes(st.pending_inspections[0].status));
    assert.equal(st.tasks[0].stagnant_rounds, 0);
    assert.equal(st.phase, "awaiting_outcome", "已投递但未回传结论 ⇒ 等待结论，不再重复发送");
    // 真实结论：no-progress +1，重复同结论幂等
    const submit = (outcome: string, evidence: string) => runtime.submitOutcome({
      root: WS, supervisor: sup.id, inspection: "insp-1", goal: "goal-a", attempt: "att-001", child: child.id, outcome, evidence,
    });
    const first = submit("no-progress", "same failing test twice");
    assert.equal(first.ok, true);
    assert.equal(first.counted, true);
    assert.equal(first.stagnant_rounds, 1);
    const again = submit("no-progress", "same failing test twice");
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true);
    assert.equal(again.counted, false);
    assert.equal(runtime.statusFor(WS).tasks[0].stagnant_rounds, 1);
  } finally {
    host.adapter.releaseAll?.();
    runtime.dispose();
    try { await child.whenIdle(); } catch { /* ignore */ }
  }
});

test("g506 B2 unknown：每次回传 unknown 也只累计 3 次提醒，不增加 no-progress，之后等待人工", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-un", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const child = (await host.reg.create({ sessionId: "child-un", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  host.adapter.hold("CHILD-UN");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-UN" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([{ id: "goal-un", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  const { runtime, events } = await makeCareRuntime(host, { clock, scheduler, payload, supervisorId: sup.id });
  runtime.start();
  try {
    let submitted = 0;
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await runtime.sweep();
      await waitFor(() => sup.status === "idle", `turn ${cycle}`);
      const open = [...runtime.entryOfRoot(WS).inspections.values()].find((i: any) => i.status !== "resolved" && i.status !== "failed" && i.status !== "expired");
      if (open) {
        const res = runtime.submitOutcome({ root: WS, supervisor: sup.id, inspection: open.id, goal: "goal-un", attempt: "att-001", child: child.id, outcome: "unknown", evidence: "cannot tell" });
        assert.equal(res.ok, true);
        submitted += 1;
      }
      clock.advance(301_000);
    }
    assert.ok(submitted <= CARE_MAX_UNANSWERED_REMINDERS, `unknown 回传次数也受 3 次提醒预算约束（实得 ${submitted}）`);
    assert.equal(events.filter((e) => e.event === "care.inspection").length, CARE_MAX_UNANSWERED_REMINDERS);
    const st = runtime.statusFor(WS);
    assert.equal(st.phase, "awaiting_human");
    assert.equal(st.tasks[0].stagnant_rounds, 0, "unknown 不得增加 no-progress");
    assert.equal(st.tasks[0].human_reason, "no_response_limit");
  } finally {
    host.adapter.releaseAll?.();
    runtime.dispose();
  }
});

test("g506 B5 事件真源恢复：dispose+recreate 保留 pause/剩余/无进展/人工锁，不重复发送", async () => {
  const host = await makeRealHost();
  const root = makeBoard("");
  const sup = (await host.reg.create({ sessionId: "sup-persist", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: root } })).agent;
  const child = (await host.reg.create({ sessionId: "child-persist", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: root } })).agent;
  host.adapter.hold("CHILD-PERSIST");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-PERSIST" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([{ id: "goal-persist", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  const options = {
    clock, scheduler, payload, supervisorId: sup.id,
    appendEventFn: (r: string, ev: any) => { appendEvent(r, ev); },
  };
  const first = await makeCareRuntime(host, options);
  first.runtime.start();
  try {
    // 3 次真实 no-progress ⇒ 人工锁；随后暂停（带剩余）并 dispose。
    for (let i = 0; i < 3; i += 1) {
      await first.runtime.sweep();
      await waitFor(() => sup.status === "idle", `turn ${i}`);
      const ins = [...first.runtime.entryOfRoot(root).inspections.values()].find((x: any) => x.status !== "resolved" && x.status !== "failed" && x.status !== "expired");
      assert.ok(ins, "每轮有可回传巡检");
      const res = first.runtime.submitOutcome({ root, supervisor: sup.id, inspection: ins.id, goal: "goal-persist", attempt: "att-001", child: child.id, outcome: "no-progress", evidence: `same ${i}` });
      assert.equal(res.ok, true);
      clock.advance(31_000);
    }
    const before = first.runtime.statusFor(root);
    assert.equal(before.tasks[0].human_locked, true);
    assert.equal(before.tasks[0].stagnant_rounds, 3);
    const paused = first.runtime.control(root, "pause", { requestId: "pause-persist" });
    assert.equal(paused.ok, true);
    first.runtime.dispose();
    // 重新创建（模拟 HMR/重启）：只靠 events.jsonl 真源恢复。
    const second = await makeCareRuntime(host, options);
    second.runtime.start();
    try {
      const restored = second.runtime.statusFor(root);
      assert.equal(restored.paused, true, "重启不得解除用户 pause");
      assert.ok((restored.paused_remaining_ms ?? 0) >= 0);
      assert.equal(restored.tasks[0].human_locked, true, "重启不得解除人工锁");
      assert.equal(restored.tasks[0].stagnant_rounds, 3);
      assert.equal(restored.tasks[0].human_reason, "no_progress_limit");
      const inspectionsBefore = readEvents(root).filter((e: any) => e.event === "care.inspection").length;
      await second.runtime.sweep();
      clock.advance(10_000_000);
      await second.runtime.sweep();
      assert.equal(readEvents(root).filter((e: any) => e.event === "care.inspection").length, inspectionsBefore, "暂停/人工锁恢复后不得重复发送");
    } finally { second.runtime.dispose(); }
  } finally {
    host.adapter.releaseAll?.();
    try { await child.whenIdle(); } catch { /* ignore */ }
  }
});

test("g506 B5 在途巡检恢复：queued 快照重启后视为已发，绝不重发同一 inspection", async () => {
  const host = await makeRealHost();
  const root = makeBoard("");
  const sup = (await host.reg.create({ sessionId: "sup-inflight", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: root } })).agent;
  const child = (await host.reg.create({ sessionId: "child-inflight", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: root } })).agent;
  host.adapter.hold("CHILD-INFLIGHT");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-INFLIGHT" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([{ id: "goal-i", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  const options = { clock, scheduler, payload, supervisorId: sup.id, appendEventFn: (r: string, ev: any) => { appendEvent(r, ev); } };
  const first = await makeCareRuntime(host, options);
  first.runtime.start();
  await first.runtime.sweep();
  await waitFor(() => sup.status === "idle", "first turn");
  const beforeCount = readEvents(root).filter((e: any) => e.event === "care.inspection").length;
  assert.equal(beforeCount, 1);
  first.runtime.dispose();
  const second = await makeCareRuntime(host, options);
  second.runtime.start();
  try {
    await second.runtime.sweep();
    await second.runtime.sweep();
    assert.equal(readEvents(root).filter((e: any) => e.event === "care.inspection").length, 1, "重启后不得重发同一巡检");
    assert.equal(second.runtime.statusFor(root).phase, "awaiting_outcome");
    // 过期后允许下一次（新 id）提醒；仍受 3 次未回复预算约束。
    clock.advance(301_000);
    await second.runtime.sweep();
    await waitFor(() => sup.status === "idle", "second turn");
    assert.equal(readEvents(root).filter((e: any) => e.event === "care.inspection").length, 2);
  } finally { second.runtime.dispose(); host.adapter.releaseAll?.(); }
});

test("g506 真实宿主：暂停在到期前生效 ⇒ 零投递；继续后按冻结剩余接续并投递", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-pause", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const child = (await host.reg.create({ sessionId: "child-pause", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  host.adapter.hold("CHILD-PAUSE");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-PAUSE" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([{ id: "goal-a", status: "in_progress", attempt_started_at: new Date(NOW - 10_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  const { runtime, events } = await makeCareRuntime(host, {
    clock, scheduler, payload, supervisorId: sup.id,
    readSupervisorSessionFn: (root: string) => (root === WS ? sup.id : null),
  });
  runtime.start();
  try {
    const paused = runtime.control(WS, "pause");
    assert.equal(paused.ok, true);
    assert.equal(paused.status.paused, true);
    assert.ok(paused.status.paused_remaining_ms > 0, "暂停时冻结剩余");
    await runtime.sweep();
    assert.equal(events.filter((e) => e.event === "care.inspection").length, 0, "暂停期间绝不能投递");
    clock.advance(120_000);
    await runtime.sweep();
    assert.equal(events.filter((e) => e.event === "care.inspection").length, 0, "暂停期间时间流逝也不得投递");
    const resumed = runtime.control(WS, "resume");
    assert.equal(resumed.ok, true);
    // 冻结剩余仍为正 ⇒ 继续后不是立刻到期
    assert.ok(runtime.statusFor(WS).next_due_in_ms > 0, "继续后按剩余接续，不重置也不立即到期");
    clock.advance(runtime.statusFor(WS).next_due_in_ms + 1);
    await runtime.sweep();
    await waitFor(() => events.filter((e) => e.event === "care.inspection").length === 1, "care.inspection after resume");
  } finally {
    host.adapter.releaseAll?.();
    runtime.dispose();
  }
});

test("g506 真实宿主：主管忙时延后；维护占用时同步拒绝并有界重排，绝不打断当前轮", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-busy", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const child = (await host.reg.create({ sessionId: "child-busy", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  host.adapter.hold("CHILD-HOLD");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-HOLD" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([{ id: "goal-a", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  const { runtime, events } = await makeCareRuntime(host, { clock, scheduler, payload, supervisorId: sup.id });
  runtime.start();
  try {
    // 主管真实 running（自己的一轮未结束）⇒ 延期，不打断
    host.adapter.hold("SUP-HOLD");
    sup.send(host.llm.createUserMessage({ content: [{ type: "text", text: "SUP-HOLD" }], source: { kind: "user" } }), "next-turn", true);
    await waitFor(() => sup.status === "running", "supervisor running");
    await runtime.sweep();
    assert.equal(events.length, 0, "主管忙不得投递");
    assert.equal(runtime.statusFor(WS).phase, "waiting_supervisor");
    host.adapter.release("SUP-HOLD");
    await sup.whenIdle();
    // 维护占用：手抢 runMaintenance，care sweep 必须同步被拒
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const maintenance = sup.runMaintenance(async () => { await gate; });
    await waitFor(() => sup.status === "idle", "maintenance projects idle");
    await runtime.sweep();
    assert.equal(events.length, 0, "维护占用不得投递");
    assert.equal(runtime.entryOfRoot(WS).transportFailures, 0, "维护占用不消耗真实发送预算");
    release?.();
    await maintenance;
    clock.advance(15_000);
    await runtime.sweep();
    assert.equal(events.filter((e) => e.event === "care.inspection").length, 1, "维护结束后有界重排可投递");
  } finally {
    host.adapter.releaseAll?.();
    runtime.dispose();
    try { await child.whenIdle(); } catch { /* ignore */ }
  }
});

test("g506 真实宿主：3 份新鲜 no-progress 升级待人；unknown 不计数；progress 归零；过期/旧绑定拒绝", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-3", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const child = (await host.reg.create({ sessionId: "child-3", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  host.adapter.hold("CHILD-HOLD-3");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-HOLD-3" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([{ id: "goal-a", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  const { runtime, events } = await makeCareRuntime(host, { clock, scheduler, payload, supervisorId: sup.id });
  runtime.start();
  try {
    const submit = (inspection: string, outcome: string, evidence = "evidence") => runtime.submitOutcome({
      root: WS, supervisor: sup.id, inspection, goal: "goal-a", attempt: "att-001", child: child.id, outcome, evidence,
    });
    await runtime.sweep();
    await waitFor(() => sup.status === "idle", "turn 1");
    // unknown 在新鲜巡检上不计数
    const unknown = submit("insp-1", "unknown", "no reply yet");
    assert.equal(unknown.ok, true);
    assert.equal(unknown.counted, false);
    assert.equal(runtime.statusFor(WS).tasks[0].stagnant_rounds, 0);
    // 未回复预算至少 300s 冷却后再提醒；收到有效 no-progress 后恢复普通复查间隔
    clock.advance(300_000);
    await runtime.sweep(); await waitFor(() => sup.status === "idle", "turn 2");
    const n2 = submit("insp-2", "no-progress", "same failure #2");
    assert.equal(n2.stagnant_rounds, 1);
    clock.advance(30_000);
    await runtime.sweep(); await waitFor(() => sup.status === "idle", "turn 3");
    const n3 = submit("insp-3", "no-progress", "same failure #3");
    assert.equal(n3.stagnant_rounds, 2);
    clock.advance(30_000);
    await runtime.sweep(); await waitFor(() => sup.status === "idle", "turn 4");
    const n4 = submit("insp-4", "no-progress", "same failure #4");
    assert.equal(n4.stagnant_rounds, 3);
    assert.equal(n4.human_locked, true);
    assert.equal(n4.awaiting_human, true);
    assert.ok(events.some((e) => e.event === "care.escalated"), "升级必须留事件");
    const st = runtime.statusFor(WS);
    assert.equal(st.phase, "awaiting_human");
    assert.equal(st.next_due_at, null, "待人状态不得显示倒计时");
    // 旧 inspection 已过期/已解决；错 attempt/身份/过期拒绝
    assert.equal(submit("insp-1", "progress", "late").ok, false);
    assert.equal(runtime.submitOutcome({ root: WS, supervisor: "other", inspection: "insp-4", goal: "goal-a", attempt: "att-001", child: child.id, outcome: "progress", evidence: "x" }).code, "wrong_identity");
    assert.equal(runtime.submitOutcome({ root: WS, supervisor: sup.id, inspection: "insp-4", goal: "goal-a", attempt: "att-999", child: child.id, outcome: "progress", evidence: "x" }).code, "stale_binding");
    clock.advance(4000_000);
    const late = runtime.submitOutcome({ root: WS, supervisor: sup.id, inspection: "insp-4", goal: "goal-a", attempt: "att-001", child: child.id, outcome: "progress", evidence: "late" });
    assert.equal(late.ok, false);
    assert.ok(["expired", "inspection_not_open", "already_resolved"].includes(late.code));
  } finally {
    host.adapter.releaseAll?.();
    runtime.dispose();
    try { await child.whenIdle(); } catch { /* ignore */ }
  }
});

test("g506 B3 send 同步抛错：非零回退、不推进计时、不计投递成功；连续 3 次后停止自动尝试", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-sf", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const child = (await host.reg.create({ sessionId: "child-sf", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  host.adapter.hold("CHILD-SF");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-SF" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([{ id: "goal-sf", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  const { runtime, events } = await makeCareRuntime(host, { clock, scheduler, payload, supervisorId: sup.id });
  const originalSend = sup.send.bind(sup);
  sup.send = () => { throw new Error("send boom"); };
  runtime.start();
  try {
    await runtime.sweep();
    const entries = runtime.entryOfRoot(WS);
    assert.ok(events.some((e) => e.event === "care.delivery_failed"), "失败必须留事件，不得伪装成功");
    assert.equal(entries.tasks.get(`${child.id}\u0000att-001`).lastCareAt, null, "失败不得推进 lastCareAt");
    assert.equal(entries.retryNotBefore - clock.now() >= 30_000, true, "失败回退必须非零且可解释（>=30s）");
    assert.equal(runtime.statusFor(WS).phase !== "awaiting_outcome", true, "失败不得显示为已投递待结论");
    // 立刻再 sweep 不得忙等（retryNotBefore 未到）
    const before = events.length;
    await runtime.sweep();
    assert.equal(events.length, before, "重试窗口内不得产生新事件");
    // 连续三次失败后停止自动尝试，进入明确不可用态（reset 可恢复）
    for (let i = 0; i < 2; i += 1) {
      clock.advance(31_000);
      await runtime.sweep();
    }
    assert.equal(entries.transportFailures, 3);
    assert.equal(runtime.statusFor(WS).reason, "delivery_failed_limit");
    assert.equal(runtime.statusFor(WS).phase, "unavailable");
    const frozen = events.length;
    for (let i = 0; i < 3; i += 1) { clock.advance(31_000); await runtime.sweep(); }
    assert.equal(events.length, frozen, "达上限后不得无限产生事件/尝试");
    // 用户 reset 清除投递失败预算（不是解除人工锁/暂停）
    const reset = runtime.control(WS, "reset", { requestId: "reset-sf" });
    assert.equal(reset.ok, true);
    sup.send = originalSend;
    clock.advance(31_000);
    await runtime.sweep();
    assert.equal(runtime.entryOfRoot(WS).transportFailures, 0, "reset 后恢复预算");
  } finally {
    sup.send = originalSend;
    host.adapter.releaseAll?.();
    runtime.dispose();
  }
});

test("g506 B4 结论新鲜性：真实 child live/running/owned/parent/workspace 校验，拒绝零事件；同值幂等、异值拒绝", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-fresh", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const child = (await host.reg.create({ sessionId: "child-fresh", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  host.adapter.hold("CHILD-FRESH");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-FRESH" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([{ id: "goal-f", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  const { runtime, events } = await makeCareRuntime(host, { clock, scheduler, payload, supervisorId: sup.id });
  runtime.start();
  try {
    await runtime.sweep();
    await waitFor(() => sup.status === "idle", "turn");
    const submit = (outcome: string, evidence: string, over: any = {}) => runtime.submitOutcome({ root: WS, supervisor: sup.id, inspection: "insp-1", goal: "goal-f", attempt: "att-001", child: child.id, outcome, evidence, ...over });
    const ok = submit("progress", "new test passed");
    assert.equal(ok.ok, true);
    const outcomeEvents = () => events.filter((e) => e.event === "care.outcome").length;
    assert.equal(outcomeEvents(), 1);
    const again = submit("progress", "new test passed");
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true);
    assert.equal(outcomeEvents(), 1, "同值同证据精确幂等，只有一次事件");
    const opposite = submit("no-progress", "different");
    assert.equal(opposite.ok, false);
    assert.equal(opposite.code, "already_resolved");
    assert.equal(outcomeEvents(), 1, "异值重交拒绝且零事件");
    // 旧 attempt/绑定变更 ⇒ stale_binding（当前 pending 已变）
    const rebound = { ...payload, versions: [{ ...payload.versions[0], goals: [{ ...payload.versions[0].goals[0], attempt_binding: { attempt: "att-002", child_id: child.id, binding_version: 2, parent_session_id: sup.id } }] }] };
    const oldPayload = payload.versions;
    payload.versions = rebound.versions;
    const stale = submit("progress", "late");
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "stale_binding");
    assert.equal(outcomeEvents(), 1);
    payload.versions = oldPayload;
    // parent session 变 ⇒ stale_parent
    payload.versions = [{ ...payload.versions[0], goals: [{ ...payload.versions[0].goals[0], attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: "other-parent" } }] }];
    const parentBad = submit("progress", "late2");
    assert.equal(parentBad.ok, false);
    assert.equal(parentBad.code, "stale_parent");
    assert.equal(outcomeEvents(), 1);
    // 恢复绑定；child idle ⇒ child_not_running（不再是「有活干」）
    payload.versions = oldPayload;
    host.adapter.releaseAll?.();
    await child.whenIdle();
    const idleBad = submit("progress", "late3");
    assert.equal(idleBad.ok, false);
    assert.equal(idleBad.code, "child_not_running");
    assert.equal(outcomeEvents(), 1, "拒绝路径零计数零事件");
  } finally {
    host.adapter.releaseAll?.();
    runtime.dispose();
  }
});

test("g506 真实宿主：事件先行失败 ⇒ 零投递/零记录；旧 attempt 变更 ⇒ 旧提醒失效", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-ev", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const child = (await host.reg.create({ sessionId: "child-ev", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  host.adapter.hold("CHILD-EV");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-EV" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([{ id: "goal-a", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  let failAppend = true;
  const { runtime, events } = await makeCareRuntime(host, {
    clock, scheduler, payload, supervisorId: sup.id,
    appendEventFn: (root: string, ev: any) => { if (failAppend) throw new Error("append failed"); events.push(ev); },
  });
  runtime.start();
  try {
    await runtime.sweep();
    assert.equal(events.length, 0);
    assert.equal(runtime.entryOfRoot(WS).inspections.size, 0, "事件失败不得留下巡检记录");
    assert.equal(runtime.statusFor(WS).tasks[0].last_care_at, null, "事件失败不得推进计时");
    // 旧 attempt 变更：换绑后旧任务/旧提醒失效
    const changed = boardPayload([{ id: "goal-a", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-002", child_id: child.id, binding_version: 2, parent_session_id: sup.id } }]);
    payload.versions = changed.versions;
    failAppend = false;
    clock.advance(31_000); // 事件失败按有界重排（30s），到期后再试
    await runtime.sweep();
    assert.equal(runtime.statusFor(WS).tasks[0].attempt, "att-002");
    assert.equal(runtime.statusFor(WS).tasks[0].stagnant_rounds, 0, "换 attempt 重新计数");
    assert.ok(events.filter((e) => e.event === "care.inspection").length === 1);
  } finally {
    host.adapter.releaseAll?.();
    runtime.dispose();
    try { await child.whenIdle(); } catch { /* ignore */ }
  }
});

test("g506 控制：暂停/继续/重置有界幂等、revision 竞争、暂停不撤已投递、跨工作区隔离", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-ctl", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([]);
  const { runtime, events } = await makeCareRuntime(host, {
    clock, scheduler, payload, supervisorId: sup.id,
    readSupervisorSessionFn: (root: string) => (root === WS ? sup.id : null),
  });
  runtime.start();
  try {
    const p1 = runtime.control(WS, "pause");
    assert.equal(p1.ok, true);
    assert.equal(p1.idempotent, false);
    const rev = p1.status.revision;
    const p2 = runtime.control(WS, "pause");
    assert.equal(p2.ok, true);
    assert.equal(p2.idempotent, true);
    assert.equal(p2.status.revision, rev);
    const conflict = runtime.control(WS, "resume", { expectedRevision: rev - 1 });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "revision_conflict");
    const r1 = runtime.control(WS, "resume");
    assert.equal(r1.ok, true);
    assert.equal(r1.status.paused, false);
    const resetPaused = runtime.control(WS, "pause");
    assert.equal(resetPaused.ok, true);
    const reset = runtime.control(WS, "reset", { requestId: "click-1" });
    assert.equal(reset.ok, true);
    assert.equal(reset.status.paused, true, "暂停中重置仍保持暂停");
    const resetRetry = runtime.control(WS, "reset", { requestId: "click-1" });
    assert.equal(resetRetry.ok, true);
    assert.equal(resetRetry.idempotent, true, "同一次点击重试按 requestId 幂等");
    assert.equal(resetRetry.status.revision, reset.status.revision);
    const resetNewClick = runtime.control(WS, "reset", { requestId: "click-2" });
    assert.equal(resetNewClick.ok, true);
    assert.equal(resetNewClick.idempotent, false, "不同真实点击不得按秒猜重复");
    assert.ok(resetNewClick.status.revision > reset.status.revision);
    // 无 live 主管 ⇒ 不可操作并给出原因
    const noSup = runtime.control("/other-ws", "pause");
    assert.equal(noSup.ok, false);
    assert.equal(noSup.code, "no_live_supervisor");
    assert.ok(events.some((e) => e.event === "care.control"));
    // 其他 workspace 的暂停状态互不影响
    assert.equal(runtime.statusFor("/other-ws").paused, false);
  } finally { runtime.dispose(); }
});

// ───────────────────────────── 4. g507 门禁 + REST 控制 ─────────────────────────────
function fakeRes() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}
function makeApplyHarness(root: string, opts: { extraGet?: (name: string) => any; connection?: any; settingsService?: any } = {}) {
  const stub = createRegisterStub();
  const registered: any[] = [];
  const cleanups: Array<() => void> = [];
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return stub.webServer;
      if (name === "connection") return Object.prototype.hasOwnProperty.call(opts, "connection") ? opts.connection : ownerConnectionStub();
      if (name === "sandboxPolicy") return { workspaceRoot: root };
      return opts.extraGet?.(name);
    },
    effect: (fn: () => unknown) => { const d = fn(); if (typeof d === "function") cleanups.push(d as any); return d; },
    webServer: stub.webServer,
    tools: { register: (d: any) => { registered.push(d); return () => {}; }, get: () => undefined },
    ...(opts.settingsService
      ? {
          inject: (_deps: string[], cb: (sctx: any) => void) => {
            cb({ settings: opts.settingsService, effect: () => {}, on: () => () => {}, get: ctx.get });
          },
        }
      : {}),
  };
  apply(ctx, { root });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { [OWNER_HEADER]: "1" }) => {
    const handler = entryHandler(stub.routes);
    const req: any = {
      headers, method, url: path, _l: {} as Record<string, (v?: any) => void>,
      on(ev: string, cb: (v?: any) => void) { req._l[ev] = cb; },
    };
    const res = fakeRes();
    const p = handler(req, res);
    if (method === "POST") { req._l.data?.(JSON.stringify(body ?? {})); req._l.end?.(); }
    await p;
    return { code: res._code, body: res._body };
  };
  return { ctx, call, cleanups, routes: stub.routes, registered };
}

test("g506 B5 事件写失败：control 不得半更新（paused/revision/锁保持原状）", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-af", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime } = await makeCareRuntime(host, {
    clock, scheduler, payload: boardPayload([]), supervisorId: sup.id,
    appendEventFn: () => { throw new Error("append broken"); },
  });
  runtime.start();
  try {
    const before = runtime.statusFor(WS);
    const res = runtime.control(WS, "pause", { requestId: "af-1" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "event_append_failed");
    const after = runtime.statusFor(WS);
    assert.equal(after.paused, false, "事件失败不得落地暂停");
    assert.equal(after.revision, before.revision, "事件失败不得推进 revision");
  } finally { runtime.dispose(); }
});

test("g506 B5 事件文件损坏：fail-closed 不投递、不重建锁/暂停；绝不半信状态", async () => {
  const host = await makeRealHost();
  const root = makeBoard("");
  writeFileSync(join(root, "events.jsonl"), "{not json\n", "utf8");
  const sup = (await host.reg.create({ sessionId: "sup-corrupt", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: root } })).agent;
  const child = (await host.reg.create({ sessionId: "child-corrupt", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: root } })).agent;
  host.adapter.hold("CHILD-CORRUPT");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-CORRUPT" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const payload = boardPayload([{ id: "goal-c", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  const { runtime, events } = await makeCareRuntime(host, { clock, scheduler: fakeScheduler(clock), payload, supervisorId: sup.id });
  runtime.start();
  try {
    await runtime.sweep();
    assert.equal(events.filter((e) => e.event === "care.inspection").length, 0, "损坏状态不得投递");
    const st = runtime.statusFor(root);
    assert.equal(st.phase, "unavailable");
    assert.equal(st.paused, false, "不得凭空重建暂停/锁");
  } finally {
    host.adapter.releaseAll?.();
    runtime.dispose();
  }
});

test("g506 REST：g507 门禁 401/403/503 + status/control 语义（无 live 主管如实 409）", async () => {
  const root = makeBoard("supervisor:\n  session: absent-live-supervisor\n  care: true\n");
  // 503：connection 服务缺失 ⇒ fail-closed
  const missing = makeApplyHarness(root, { connection: null });
  const miss = await missing.call("GET", `/api/dsh-graph/care/status?workspace=${encodeURIComponent(root)}`, undefined, {});
  assert.equal(miss.code, 503);
  // 401：无 owner 凭证
  const h = makeApplyHarness(root);
  const r401 = await h.call("GET", `/api/dsh-graph/care/status?workspace=${encodeURIComponent(root)}`, undefined, {});
  assert.equal(r401.code, 401);
  // 403：有效凭证但非 owner
  const notOwner = makeApplyHarness(root, { connection: ownerConnectionStub({ owner: false }) });
  const r403 = await notOwner.call("GET", `/api/dsh-graph/care/status?workspace=${encodeURIComponent(root)}`, undefined, { [OWNER_HEADER]: "1" });
  assert.equal(r403.code, 403);
  // owner：status 200，且缺 live 主管时 control 409
  const st = await h.call("GET", `/api/dsh-graph/care/status?workspace=${encodeURIComponent(root)}`);
  assert.equal(st.code, 200);
  assert.equal(st.body.configured.effective, true, "项目显式 true ⇒ 生效");
  const ctl = await h.call("POST", "/api/dsh-graph/care/control", { workspace: root, action: "pause" });
  assert.equal(ctl.code, 409);
  assert.equal(ctl.body.error, "no_live_supervisor");
  // 非法 action 400
  const bad = await h.call("POST", "/api/dsh-graph/care/control", { workspace: root, action: "stop" });
  assert.equal(bad.code, 400);
  for (const x of [missing, h, notOwner]) for (const fn of x.cleanups) { try { fn(); } catch { /* ignore */ } }
});

test("g506 REST：公开 settings 服务的全局关照值是现真源，项目三态可显式覆盖", async () => {
  const root = makeBoard("");
  const svc = {
    describe: () => [{
      ns: "dsh-graph-host",
      value: { supervisorCare: "off", supervisorCareThresholdSeconds: "120", supervisorCareRecheckSeconds: "90" },
      user: { supervisorCare: "off", supervisorCareThresholdSeconds: "120", supervisorCareRecheckSeconds: "90" },
      revision: 1,
    }],
    configure: () => {},
  };
  const h = makeApplyHarness(root, { settingsService: svc });
  try {
    const inherit = await h.call("GET", `/api/dsh-graph/care/status?workspace=${encodeURIComponent(root)}`);
    assert.equal(inherit.code, 200);
    assert.equal(inherit.body.configured.effective, false, "项目 inherit ⇒ 跟随全局 off");
    assert.equal(inherit.body.configured.source, "global_explicit");
    assert.equal(inherit.body.configured.threshold_seconds, 120);
    assert.equal(inherit.body.configured.recheck_seconds, 90);
    // 项目显式 true 覆盖全局 off
    writeProjectConfig(root, { supervisor: { care: "true", care_threshold_seconds: 300 } }, "test");
    const explicit = await h.call("GET", `/api/dsh-graph/care/status?workspace=${encodeURIComponent(root)}`);
    assert.equal(explicit.body.configured.effective, true);
    assert.equal(explicit.body.configured.source, "project_explicit");
    assert.equal(explicit.body.configured.threshold_seconds, 300);
  } finally {
    for (const fn of h.cleanups) { try { fn(); } catch { /* ignore */ } }
  }
});

test("g506 REST：有 live 主管时 pause/resume/reset 生效并跨请求保真（revision 冲突 409）", async () => {
  const host = await makeRealHost();
  const root = makeBoard("");
  const sup = (await host.reg.create({ sessionId: "sup-rest", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: root } })).agent;
  writeFileSync(join(root, "project.yaml"), `supervisor:\n  session: ${sup.id}\n  care: "true"\n`);
  const h = makeApplyHarness(root, {
    extraGet: (name: string) => (name === "agents" ? host.reg : name === "llm" ? host.llmRuntime : undefined),
  });
  try {
    const st0 = await h.call("GET", `/api/dsh-graph/care/status?workspace=${encodeURIComponent(root)}`);
    assert.equal(st0.code, 200);
    assert.equal(st0.body.supervisor, sup.id);
    assert.equal(st0.body.supervisor_live, true);
    const p = await h.call("POST", "/api/dsh-graph/care/control", { workspace: root, action: "pause" });
    assert.equal(p.code, 200);
    assert.equal(p.body.status.paused, true);
    const rev = p.body.status.revision;
    const p2 = await h.call("POST", "/api/dsh-graph/care/control", { workspace: root, action: "pause" });
    assert.equal(p2.code, 200);
    assert.equal(p2.body.idempotent, true);
    const conflict = await h.call("POST", "/api/dsh-graph/care/control", { workspace: root, action: "resume", expected_revision: rev - 1 });
    assert.equal(conflict.code, 409);
    assert.equal(conflict.body.error, "revision_conflict");
    const r = await h.call("POST", "/api/dsh-graph/care/control", { workspace: root, action: "resume" });
    assert.equal(r.code, 200);
    assert.equal(r.body.status.paused, false);
    // 刷新（新请求）后仍是服务端同一状态
    const again = await h.call("GET", `/api/dsh-graph/care/status?workspace=${encodeURIComponent(root)}`);
    assert.equal(again.body.paused, false);
    assert.equal(again.body.revision, r.body.status.revision);
  } finally {
    for (const fn of h.cleanups) { try { fn(); } catch { /* ignore */ } }
  }
});

// ───────────────────────────── 5. 与 g505 保活的结构性隔离 ─────────────────────────────

test("g506 B7 能力如实投影：进展读取不等于可干预；interrupt/resume seam 只标 unverified，不列 available", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-cap", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const child = (await host.reg.create({ sessionId: "child-cap", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  host.adapter.hold("CHILD-CAP");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-CAP" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([{ id: "goal-cap", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  // 模拟宿主暴露了干预 seam（但插件没有授权/验证，绝不能当 available）
  host.subagents = { interrupt() {}, sendMessage() {} } as any;
  const { runtime, events } = await makeCareRuntime(host, { clock, scheduler, payload, supervisorId: sup.id });
  runtime.start();
  try {
    await runtime.sweep();
    await waitFor(() => sup.status === "idle", "turn");
    const st = runtime.statusFor(WS);
    assert.equal(st.capable.available.interrupt, false, "有 seam ≠ 已授权可用");
    assert.equal(st.capable.available.resume, false);
    assert.ok(st.capable.missing.includes("interrupt"));
    assert.ok(st.capable.missing.includes("resume"));
    assert.deepEqual(st.capable.unverified.sort(), ["interrupt", "resume"]);
    assert.equal(st.capable.available.progress_read, true, "真实 child session 可读进展");
    const wake = events.find((e) => e.event === "care.inspection");
    assert.ok(wake);
  } finally {
    host.adapter.releaseAll?.();
    runtime.dispose();
  }
});

test("g506 B7 两 runtime × 两 workspace：各自只采样/提醒自己的主管任务，互不串", async () => {
  const host = await makeRealHost();
  const rootA = "/ws-a";
  const rootB = "/ws-b";
  const supA = (await host.reg.create({ sessionId: "sup-a", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: rootA } })).agent;
  const supB = (await host.reg.create({ sessionId: "sup-b", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: rootB } })).agent;
  const childA = (await host.reg.create({ sessionId: "child-a", parentAgent: supA, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: rootA } })).agent;
  const childB = (await host.reg.create({ sessionId: "child-b", parentAgent: supB, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: rootB } })).agent;
  host.adapter.hold("CHILD-A");
  host.adapter.hold("CHILD-B");
  childA.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-A" }], source: { kind: "user" } }), "next-turn", true);
  childB.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-B" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => childA.status === "running" && childB.status === "running", "children running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payloadOf = (root: string) => boardPayload([{ id: root === rootA ? "goal-a" : "goal-b", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: root === rootA ? childA.id : childB.id, binding_version: 1, parent_session_id: root === rootA ? supA.id : supB.id } }]);
  const mk = (root: string) => makeCareRuntime(host, {
    clock, scheduler, supervisorId: root === rootA ? supA.id : supB.id,
    readSupervisorSessionFn: (r: string) => (r === root ? (root === rootA ? supA.id : supB.id) : null),
    readBoardPayload: (r: string) => (r === root ? payloadOf(root) : null),
  });
  const a = await mk(rootA);
  const b = await mk(rootB);
  a.runtime.start(); b.runtime.start();
  try {
    await a.runtime.sweep();
    await b.runtime.sweep();
    await waitFor(() => supA.status === "idle" && supB.status === "idle", "both turns");
    assert.deepEqual(a.events.filter((e) => e.event === "care.inspection").map((e) => e.details.targets.map((t: any) => t.goal)), [["goal-a"]]);
    assert.deepEqual(b.events.filter((e) => e.event === "care.inspection").map((e) => e.details.targets.map((t: any) => t.goal)), [["goal-b"]]);
    assert.equal(a.runtime.statusFor(rootA).tasks.length, 1);
    assert.equal(b.runtime.statusFor(rootB).tasks.length, 1);
    assert.equal(a.events.some((e) => e.details?.targets?.some?.((t: any) => t.goal === "goal-b")), false);
    assert.equal(b.events.some((e) => e.details?.targets?.some?.((t: any) => t.goal === "goal-a")), false);
  } finally {
    a.runtime.dispose(); b.runtime.dispose(); host.adapter.releaseAll?.();
  }
});

test("g506 与 g505：care source 不被当作 human 活动；保活 ping 不产生关照", async () => {
  const host = await makeRealHost();
  const sup = (await host.reg.create({ sessionId: "sup-mix", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  const child = (await host.reg.create({ sessionId: "child-mix", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: WS } })).agent;
  host.adapter.hold("CHILD-MIX");
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "CHILD-MIX" }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", "child running");
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const payload = boardPayload([{ id: "goal-a", status: "in_progress", attempt_started_at: new Date(NOW - 40_000).toISOString(), attempt_binding: { attempt: "att-001", child_id: child.id, binding_version: 1, parent_session_id: sup.id } }]);
  const careMod: any = await import("../../dist/index.js");
  const events: any[] = [];
  const care = careMod.createCareRuntime({
    ctx: { on: (n: string, h: any) => host.hostCtx.on(n, h), get: (n: string) => (n === "agents" ? host.reg : n === "llm" ? host.llmRuntime : undefined) },
    readGlobal: () => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false }),
    resolveRoot: (ws: string) => ws,
    readProjectConfigFn: () => ({ supervisor: { care: true, care_threshold_seconds: 30, care_recheck_seconds: 30 } }),
    readSupervisorSessionFn: () => sup.id,
    readBoardPayload: () => payload,
    now: clock.now, setTimeoutFn: scheduler.setTimeoutFn, clearTimeoutFn: scheduler.clearTimeoutFn,
    appendEventFn: (_root: string, ev: any) => { events.push(ev); }, makeInspectionId: (() => { let i = 0; return () => `mix-${++i}`; })(), log: () => {},
  });
  // g505 保活运行时：真实公开服务 + 假时钟；配置全开
  const keep = careMod.createKeepAliveRuntime({
    ctx: { on: (n: string, h: any) => host.hostCtx.on(n, h), get: (n: string) => (n === "agents" ? host.reg : n === "llm" ? host.llmRuntime : undefined) },
    readGlobal: () => ({ enabled: true, malformed: false, available: true, raw: "on" }),
    resolveRoot: (ws: string) => ws,
    defaultWorkspace: () => WS,
    readProjectConfigFn: () => ({ supervisor: { keep_alive: null } }),
    readSupervisorSessionFn: () => sup.id,
    now: clock.now, setTimeoutFn: scheduler.setTimeoutFn, clearTimeoutFn: scheduler.clearTimeoutFn,
    log: () => {},
  });
  care.start(); keep.start();
  try {
    await care.sweep();
    await waitFor(() => sup.status === "idle", "turn");
    const board = keep.stateFor(WS);
    assert.ok(board, "保活 board 已建立");
    assert.equal(board.lastHumanAt, null, "care source 不得被当成人类输入");
    assert.equal(board.lastLlmAt !== null, true, "主管正常轮请求仍被观察（不是伪造消息）");
    // 保活 ping 不产生关照：先建立快照，再推进到阶段一阈值并 sweep
    const before = events.filter((e) => e.event === "care.inspection").length;
    clock.advance(400_000);
    await keep.sweep();
    await new Promise((r) => setImmediate(r));
    assert.equal(events.filter((e) => e.event === "care.inspection").length, before, "保活不得产生关照巡检");
  } finally {
    care.dispose(); keep.dispose();
    host.adapter.releaseAll?.();
    try { await child.whenIdle(); } catch { /* ignore */ }
  }
});
