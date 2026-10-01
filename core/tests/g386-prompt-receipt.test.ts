/** g-386：客户端投递**回执**被忽略、虚报成功（v0.18.0 审查 H1，P2）。
 *
 * 缺陷：promptSessionQueue 的 using / retain / legacy 三个分支都丢弃 `session.prompt` 的返回，
 * 于是 `{ok:false,error:{code:"subagent/delivery-unavailable"}}` 这类**非抛错失败**仍返回 true。
 * 后果：目标润色误报「已投递」并跳过复制兜底；单卡 / 批量接受的主管通知静默失败。
 *
 * 本文件用**源码函数 + VM 三能力分支**执行模块里真实的 promptSessionQueue（不是重写一份），覆盖：
 *   1. `ok:false` 三分支均不虚报成功；`ok:true` 才成功；两种情况下 release 都严格配平、无重复投递；
 *   2. 老宿主**空回执**（undefined / null / 非对象 / 无 ok 字段）的兼容口径：按「未确认」处理 → false
 *      （明确、可测试：见下方 legacy 口径用例；与全仓既有三处 `if (res?.ok)` 消费点同口径）；
 *   3. ready 被拒 / prompt 抛异常 / 正常回执三条路径下 retain/release 配平；
 *   4. **负向对照**：把 helper 的回执判定文本改回「恒真」后，同一组 ok:false 断言必然转红；
 *   5. 调用方消费：润色失败退回复制兜底（不报成功）、单卡与批量接受通知失败有可见提示且不丢失已成功的接受。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const hostRoot = join(import.meta.dirname, "../../dsh-graph-host");
const clientRoot = join(hostRoot, "lib/client");
const readClient = (name: string) => readFileSync(join(clientRoot, `${name}.js`), "utf8");
const stripComments = (s: string) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

/** 按花括号配平抠出一个函数（与 g-273 / g-321 / g-323 / g-327 既有做法同源）。 */
function extractBalanced(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `源模块中存在 ${marker}`);
  let depth = 0;
  for (let i = source.indexOf("{", at); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`${marker} 花括号无法配平`);
}

interface WarnRecorder { warns: any[][]; console: { warn: (...a: any[]) => void } }
const makeWarnRecorder = (): WarnRecorder => {
  const warns: any[][] = [];
  return { warns, console: { warn: (...a: any[]) => { warns.push(a); } } };
};

/** 真实 promptSessionQueue：从源码抠出 + VM 求值（执行的是模块里真实的实现）。 */
function loadHelper(src: string, recorder: WarnRecorder = makeWarnRecorder()) {
  const code = extractBalanced(src, "async function promptSessionQueue(");
  const ctx = vm.createContext({ console: recorder.console });
  vm.runInContext(code, ctx);
  const helper = (ctx as any).promptSessionQueue;
  assert.equal(typeof helper, "function", "抠出的 promptSessionQueue 可在 VM 中调用");
  return helper as (rt: any, target: any, parts: any, warnLabel?: string) => Promise<boolean>;
}

const PARTS = [{ type: "text", text: "REQUEST" }];

// ===== 三能力宿主的真实语义替身（using 内部 try/finally；retain 由调用方 finally 配平） =====

interface Balance { releases: number; usingCalls: number; retainCalls: number }
const newBalance = (): Balance => ({ releases: 0, usingCalls: 0, retainCalls: 0 });

/** retain/using 借出的引用：binding 是 getter（release 后再读抛错），release 计数一次。 */
function makeReference(session: any, balance: Balance, ready: Promise<void> = Promise.resolve()) {
  let released = false;
  const reference: any = { sessionId: "sup-1", ready };
  Object.defineProperty(reference, "binding", {
    get() {
      if (released) throw new Error("Session reference is released");
      return { session };
    },
  });
  reference.release = () => { released = true; balance.releases += 1; };
  return reference;
}

/** 0.1.6 形态：有 using，无 get(id)；release 由 using 的内部 finally 配平。 */
function usingHost(session: any, balance: Balance, ready?: Promise<void>) {
  return {
    binding: () => undefined,
    using: async (_target: any, _options: any, operation: any) => {
      balance.usingCalls += 1;
      const reference = makeReference(session, balance, ready);
      try { return await operation(reference); } finally { reference.release(); }
    },
  };
}

/** 0.1.6 形态：无 using，有 retain，无 get(id)；release 由 helper 的 finally 配平。 */
function retainHost(session: any, balance: Balance, ready?: Promise<void>) {
  return {
    binding: () => undefined,
    retain: (_target: any, _options: any) => {
      balance.retainCalls += 1;
      return makeReference(session, balance, ready);
    },
  };
}

/** 0.1.5 形态：既无 using 也无 retain，只有被动 binding（不进入任何代际，故 release 恒 0）。 */
function legacyHost(session: any) {
  return { binding: (id: string) => (id === "sup-1" ? { session } : undefined) };
}

const BRANCHES = [
  { name: "using", make: (session: any, b: Balance, ready?: Promise<void>) => usingHost(session, b, ready) },
  { name: "retain", make: (session: any, b: Balance, ready?: Promise<void>) => retainHost(session, b, ready) },
  { name: "legacy", make: (session: any, _b: Balance, _ready?: Promise<void>) => legacyHost(session) },
] as const;

const promptStub = (receipt: any, calls: any[]) =>
  async (parts: any, mode: any) => { calls.push({ parts, mode }); return typeof receipt === "function" ? receipt() : receipt; };

const NO_RECEIPT = { accepted: true, value: { accepted: true }, error: { code: "subagent/delivery-unavailable" } };

// ===== 1. 负回执：三分支均不得虚报成功，且 release 严格配平、无重复投递 =====
test("g-386 负回执（ok:false）：using/retain/legacy 三分支一律 false，release 配平且只投递一次", async () => {
  for (const branch of BRANCHES) {
    const helper = loadHelper(readClient("session-hooks"));
    const calls: any[] = [];
    const balance = newBalance();
    const session = { prompt: promptStub({ ok: false, error: { code: "subagent/delivery-unavailable", message: "delivery unavailable" } }, calls) };
    const result = await helper(branch.make(session, balance), "sup-1", PARTS);
    assert.equal(result, false, `${branch.name}：ok:false 绝不虚报成功`);
    assert.equal(calls.length, 1, `${branch.name}：恰好一次投递尝试（不得重复投递）`);
    assert.equal(calls[0].mode, "queue");
    assert.deepEqual(calls[0].parts, PARTS);
    assert.equal(balance.releases, branch.name === "legacy" ? 0 : 1, `${branch.name}：release 严格配平（legacy 不代际）`);
    assert.equal(balance.usingCalls, branch.name === "using" ? 1 : 0);
    assert.equal(balance.retainCalls, branch.name === "retain" ? 1 : 0);
  }
});

// ===== 2. 正向回执：只有 ok===true 才算送达（原行为不回归） =====
test("g-386 正向回执（ok:true）：三分支一律 true、恰好一条 queue、release 配平", async () => {
  for (const branch of BRANCHES) {
    const helper = loadHelper(readClient("session-hooks"));
    const calls: any[] = [];
    const balance = newBalance();
    const session = { prompt: promptStub({ ok: true, value: { accepted: true } }, calls) };
    const result = await helper(branch.make(session, balance), "sup-1", PARTS);
    assert.equal(result, true, `${branch.name}：正向回执必须如实成功`);
    assert.equal(calls.length, 1, `${branch.name}：恰好一条 queue 消息`);
    assert.equal(calls[0].mode, "queue");
    assert.equal(balance.releases, branch.name === "legacy" ? 0 : 1, `${branch.name}：release 严格配平`);
  }
});

// ===== 3. 老宿主空回执的兼容口径：未确认 → false（三分支一致，可测试） =====
test("g-386 老宿主空回执（undefined/null/非对象/无 ok 字段）：按「未确认」处理 → 三分支均 false", async () => {
  const empties: Array<[string, any]> = [
    ["undefined", undefined],
    ["null", null],
    ["非对象", "ok"],
    ["无 ok 字段", { value: { accepted: true } }],
    ["空对象", {}],
    ["仅含 error 无 ok", { error: { code: "gateway/internal" } }],
  ];
  for (const branch of BRANCHES) {
    for (const [label, receipt] of empties) {
      const helper = loadHelper(readClient("session-hooks"));
      const calls: any[] = [];
      const balance = newBalance();
      const session = { prompt: promptStub(receipt, calls) };
      const result = await helper(branch.make(session, balance), "sup-1", PARTS);
      assert.equal(result, false, `${branch.name} / ${label}：空回执不得冒充已送达`);
      assert.equal(calls.length, 1, `${branch.name} / ${label}：仍恰好一次投递尝试`);
      assert.equal(balance.releases, branch.name === "legacy" ? 0 : 1, `${branch.name} / ${label}：release 配平`);
    }
  }
  // 严格性：只认 `ok === true`（真值但非 true 的回执同样不确认，绝不 `!= false` 宽松判定）
  for (const truthy of [1, "true", {}, []]) {
    const helper = loadHelper(readClient("session-hooks"));
    const calls: any[] = [];
    const session = { prompt: promptStub({ ok: truthy }, calls) };
    assert.equal(await helper(legacyHost(session), "sup-1", PARTS), false, `ok:${JSON.stringify(truthy)} 不是正向回执`);
  }
});

// ===== 4. ready 被拒 / prompt 抛异常：不虚报成功且 release 配平 =====
test("g-386 ready 被拒 / prompt 抛异常：三分支 false，retain/using 必须 release 配平", async () => {
  for (const branch of BRANCHES.filter((b) => b.name !== "legacy")) {
    // ready 被拒（会话控制器已释放）
    const readyCalls: any[] = [];
    const readyBalance = newBalance();
    const readyHelper = loadHelper(readClient("session-hooks"));
    const readySession = { prompt: promptStub({ ok: true }, readyCalls) };
    const ready = await readyHelper(
      branch.make(readySession, readyBalance, Promise.reject(new Error("Session Controller is disposed"))),
      "sup-1", PARTS,
    );
    assert.equal(ready, false, `${branch.name}：ready 被拒不得虚报成功`);
    assert.equal(readyCalls.length, 0, `${branch.name}：ready 未就绪不得发消息`);
    assert.equal(readyBalance.releases, 1, `${branch.name}：ready 被拒也必须 release 配平`);

    // prompt 抛异常
    const boomCalls: any[] = [];
    const boomBalance = newBalance();
    const boomHelper = loadHelper(readClient("session-hooks"));
    const boomSession = { prompt: promptStub(() => { throw new Error("prompt boom"); }, boomCalls) };
    const boom = await boomHelper(branch.make(boomSession, boomBalance), "sup-1", PARTS);
    assert.equal(boom, false, `${branch.name}：prompt 抛异常不得虚报成功`);
    assert.equal(boomCalls.length, 1, `${branch.name}：异常发生在一次投递尝试内`);
    assert.equal(boomBalance.releases, 1, `${branch.name}：prompt 抛异常也必须 release 配平`);
  }
  // legacy：prompt 抛异常同样 false、不代际（release 恒 0）
  const legacyCalls: any[] = [];
  const legacyHelper = loadHelper(readClient("session-hooks"));
  const legacyBalance = newBalance();
  const legacy = await legacyHelper(
    legacyHost({ prompt: promptStub(() => { throw new Error("prompt boom"); }, legacyCalls) }), "sup-1", PARTS,
  );
  assert.equal(legacy, false);
  assert.equal(legacyBalance.releases, 0, "legacy 分支不进入代际");
});

// ===== 5. 取不到会话 / 无 prompt / 空 target：如实 false 且零投递、零 release =====
test("g-386 无会话 / 无 prompt / 空 target：如实 false，零投递", async () => {
  const helper = loadHelper(readClient("session-hooks"));
  const balance = newBalance();
  let reached = 0;
  const rt = {
    binding: () => undefined,
    get: () => undefined,
    retain: () => { reached += 1; throw new Error("sessions.retain: unknown session"); },
  };
  assert.equal(await helper(rt, "sup-1", PARTS), false, "会话取不到 → false");
  assert.equal(reached, 1, "retain 分支确实被尝试过一次（抛 unknown session → 如实 false）");
  assert.equal(await helper({ binding: () => ({ session: {} }) }, "sup-1", PARTS), false, "无 prompt → false");
  // 空 target 必须在能力分流之前短路：保留入口一次都不许被触碰
  const spy = { retains: 0 };
  const spyRt = {
    binding: () => { spy.retains += 1; return undefined; },
    retain: () => { spy.retains += 1; throw new Error("空 target 不得进入代际"); },
  };
  assert.equal(await helper(spyRt, null, PARTS), false, "空 target → false");
  assert.equal(await helper(spyRt, "", PARTS), false, "空字符串 target → false");
  assert.equal(spy.retains, 0, "空 target 必须在能力分流之前短路");
  assert.equal(balance.releases, 0, "未进入代际时不得凭空 release");
});

// ===== 6. 可诊断性：负回执回报实际 error，空回执回报说明性原因（各至多一条 warn） =====
test("g-386 回执失败可诊断：负回执回报 res.error，空回执回报 no receipt（每次尝试至多一条 warn）", async () => {
  const label = "[dsh-graph-host] prompt supervisorSession failed:";
  const negRec = makeWarnRecorder();
  const negHelper = loadHelper(readClient("session-hooks"), negRec);
  const err = { code: "subagent/delivery-unavailable", message: "delivery unavailable" };
  assert.equal(await negHelper(legacyHost({ prompt: async () => ({ ok: false, error: err }) }), "sup-1", PARTS, label), false);
  assert.equal(negRec.warns.length, 1, "负回执恰好一条 warn（不新增报错风暴）");
  assert.equal(negRec.warns[0][0], label);
  assert.equal(negRec.warns[0][1], err, "回报的必须是宿主给出的真实 error");

  const emptyRec = makeWarnRecorder();
  const emptyHelper = loadHelper(readClient("session-hooks"), emptyRec);
  assert.equal(await emptyHelper(legacyHost({ prompt: async () => undefined }), "sup-1", PARTS, label), false);
  assert.equal(emptyRec.warns.length, 1);
  assert.match(String(emptyRec.warns[0][1]?.message), /no receipt/, "空回执必须回报「未确认」原因");

  // 不给 warnLabel 时零输出（保持既有调用点自选可诊断性）
  const quietRec = makeWarnRecorder();
  const quietHelper = loadHelper(readClient("session-hooks"), quietRec);
  assert.equal(await quietHelper(legacyHost({ prompt: async () => ({ ok: false, error: err }) }), "sup-1", PARTS), false);
  assert.equal(quietRec.warns.length, 0);
});

// ===== 7. 负向对照：回退修复（判定恒真）后，本文件新用例必然转红 =====
test("g-386 负向对照：把回执判定改回恒真（模拟回退修复）后，ok:false 会重新虚报成功", async () => {
  const src = readClient("session-hooks");
  const mutated = src.replace(
    "const accepted = (res) => res?.ok === true;",
    "const accepted = (res) => true;",
  );
  assert.notEqual(mutated, src, "负向对照必须真的改动了源码（回执判定行仍存在）");
  for (const branch of BRANCHES) {
    const broken = loadHelper(mutated);
    const calls: any[] = [];
    const balance = newBalance();
    const session = { prompt: promptStub({ ok: false, error: { code: "subagent/delivery-unavailable" } }, calls) };
    const result = await broken(branch.make(session, balance), "sup-1", PARTS);
    assert.equal(result, true, `${branch.name}：判定恒真时 ok:false 确实会被误报成功 ⇒ 上面的断言是有效负向对照`);
  }
  // 结构钉：三个分支都必须把回执交给统一收口（回退修复后该计数会掉到 0）
  assert.equal(
    stripComments(src).split('settle(await session.prompt(parts, "queue"))').length - 1,
    3,
    "using/retain/legacy 三分支都必须消费 session.prompt 的回执",
  );
});

// ===== 8. 调用方消费：润色失败退回复制兜底，不报「已投递」 =====
let cachedClientI18n: { zh: Record<string, string>; en: Record<string, string>; dgT: any } | null = null;
function clientI18n() {
  if (cachedClientI18n) return cachedClientI18n;
  const sandbox: any = { React: {}, console };
  vm.runInNewContext(readClient("i18n") + "; this.zh = zh; this.en = en; this.dgT = createTranslator();", sandbox);
  cachedClientI18n = { zh: sandbox.zh, en: sandbox.en, dgT: sandbox.dgT };
  return cachedClientI18n;
}
const settledNotes = (notes: any[]) => notes.filter((v) => v !== null);

function makeOpenSupervisorRunner(opts: { rt: any; supervisorSession: any; request: string; copyText?: (t: string) => any }) {
  const src = readClient("goal-actions");
  const arrow = extractBalanced(src, "const openSupervisor = ").slice("const openSupervisor = ".length).trim();
  const state = { notes: [] as any[], toasts: [] as string[], copied: [] as string[], fallbacks: [] as any[], loading: [] as boolean[], modes: [] as any[], activated: 0, opened: [] as any[] };
  const make = new Function(
    "dgT", "sessionsRt", "appCtx", "supervisorSession", "promptSessionQueue", "request",
    "copyText", "openSessionTarget", "activateChatTab", "showToast",
    "setLoading", "setMode", "setNote", "setFallback",
    `return ${arrow};`,
  );
  const run = make(
    clientI18n().dgT, opts.rt, null, opts.supervisorSession, loadHelper(readClient("session-hooks")), opts.request,
    async (text: string) => { state.copied.push(text); return opts.copyText ? await opts.copyText(text) : false; },
    (...args: any[]) => { state.opened.push(args); },
    () => { state.activated += 1; },
    (t: string) => { state.toasts.push(t); },
    (v: boolean) => { state.loading.push(v); },
    (v: any) => { state.modes.push(v); },
    (v: any) => { state.notes.push(v); },
    (v: any) => { state.fallbacks.push(v); },
  ) as () => Promise<void>;
  return { run, state };
}

test("g-386 目标润色：投递负回执时绝不报「已投递」，且完整走复制兜底", async () => {
  const requests: any[] = [];
  const { run, state } = makeOpenSupervisorRunner({
    rt: legacyHost({ prompt: async (parts: any, mode: any) => { requests.push({ parts, mode }); return { ok: false, error: { code: "subagent/delivery-unavailable" } }; } }),
    supervisorSession: "sup-1", request: "REQ", copyText: (t: string) => t === "REQ",
  });
  await run();
  const { zh } = clientI18n();
  assert.equal(requests.length, 1, "确实尝试过直发");
  assert.deepEqual(state.copied, ["REQ"], "负回执必须退回复制兜底");
  assert.deepEqual(state.toasts, [zh["exec.requestCopied"]], "不得显示「已直接发送」toast");
  assert.ok(!state.toasts.includes(zh["exec.requestDelivered"]), "绝不虚报已投递");
  assert.deepEqual(settledNotes(state.notes), [zh["exec.requestCopiedOpened"]]);
  assert.deepEqual(state.fallbacks, [false]);
  assert.deepEqual(state.loading, [true, false], "loading 配平");
});

// ===== 9. 调用方消费：单卡接受通知失败有可见提示，且不丢失已成功的接受 =====
function makeDoAcceptRunner(opts: { rt: any; supervisorSession: any; jsonResult: any; onRefresh?: () => void }) {
  const src = readClient("goal-actions");
  const arrow = extractBalanced(src, "const doAccept = ").slice("const doAccept = ".length).trim();
  const state = { notes: [] as any[], loading: [] as boolean[] };
  const make = new Function(
    "confirm", "dgT", "goalId", "setLoading", "setNote", "fetch", "graphUrl",
    "onRefresh", "sessionsRt", "appCtx", "supervisorSession", "promptSessionQueue", "console",
    `return ${arrow};`,
  );
  const run = make(
    () => true, clientI18n().dgT, "g-1", (v: boolean) => { state.loading.push(v); }, (v: any) => { state.notes.push(v); },
    async () => ({ json: async () => opts.jsonResult }), (p: string) => p,
    opts.onRefresh ?? (() => {}), opts.rt, null, opts.supervisorSession, loadHelper(readClient("session-hooks")), console,
  ) as () => Promise<void>;
  return { run, state };
}

test("g-386 单卡接受：主管通知负回执 → 有可见提示，但接受本身照常成功（不回滚、不报失败）", async () => {
  let refreshed = 0;
  const { run, state } = makeDoAcceptRunner({
    rt: legacyHost({ prompt: async () => ({ ok: false, error: { code: "subagent/delivery-unavailable" } }) }),
    supervisorSession: "sup-1", jsonResult: { pending: true }, onRefresh: () => { refreshed += 1; },
  });
  await assert.doesNotReject(() => run(), "通知失败绝不穿出 doAccept");
  const { zh } = clientI18n();
  assert.deepEqual(state.notes, [zh["exec.acceptNotifyFail"]], "必须有可见提示");
  assert.doesNotMatch(String(state.notes[0]), /接受失败/, "不得把通知失败说成接受失败");
  assert.match(String(state.notes[0]), /接受已成功/, "必须说明接受本身已成功");
  assert.equal(refreshed, 1, "接受成功的刷板不得丢失");
  assert.deepEqual(state.loading, [true, false]);

  // 正向回执：不出现通知失败提示
  const okRun = makeDoAcceptRunner({
    rt: legacyHost({ prompt: async () => ({ ok: true, value: { accepted: true } }) }),
    supervisorSession: "sup-1", jsonResult: { pending: true },
  });
  await okRun.run();
  assert.deepEqual(okRun.state.notes, [], "正向回执不得出现通知失败提示");

  // 未配置主管会话：保持原「静默跳过」语义（配置态不是投递失败）
  const noSup = makeDoAcceptRunner({
    rt: legacyHost({ prompt: async () => ({ ok: false, error: {} }) }),
    supervisorSession: null, jsonResult: { pending: true },
  });
  await noSup.run();
  assert.deepEqual(noSup.state.notes, [], "未配置主管会话时不得弹通知失败提示");
});

// ===== 10. 调用方消费：批量接受通知失败有可见提示，且成功/失败计数逐字保留 =====
function makeSubmitBatchAcceptRunner(opts: {
  runResult: any; notifyResult: boolean; supervisorSession: any;
}) {
  const src = readClient("kanban");
  const fn = extractBalanced(src, "async function submitBatchAccept(");
  const state = { toasts: [] as string[], failures: [] as any[], opened: [] as any[], loading: [] as boolean[], loaded: 0, notified: [] as any[] };
  const make = new Function(
    "batchAcceptLoading", "runBatchAccept", "graphUrlForActive", "b", "notifySupervisorBatchAccept",
    "dgT", "setBatchAcceptFailures", "setBatchAcceptOpen", "showToast", "load", "setBatchAcceptLoading",
    `return ${fn};`,
  );
  const run = make(
    false, async () => opts.runResult, (p: string) => p, { supervisorSession: opts.supervisorSession },
    async (session: any, ids: any[]) => { state.notified.push({ session, ids }); return opts.notifyResult; },
    clientI18n().dgT, (v: any) => { state.failures.push(v); }, (v: any) => { state.opened.push(v); },
    (t: string) => { state.toasts.push(t); }, () => { state.loaded += 1; }, (v: boolean) => { state.loading.push(v); },
  ) as (ids: any[]) => Promise<void>;
  return { run, state };
}

test("g-386 批量接受：整批通知未确认送达 → toast 带警示前缀，但接受结果与刷板逐字保留", async () => {
  const { zh } = clientI18n();
  const allOk = makeSubmitBatchAcceptRunner({
    runResult: { ok: [{ goal: "g-1" }, { goal: "g-2" }], failed: [] },
    notifyResult: false, supervisorSession: "sup-1",
  });
  await allOk.run(["g-1", "g-2"]);
  assert.deepEqual(allOk.state.notified, [{ session: "sup-1", ids: ["g-1", "g-2"] }], "仍恰好一条聚合通知");
  assert.equal(allOk.state.toasts.length, 1, "单条 toast（不刷屏）");
  assert.equal(allOk.state.toasts[0], zh["batchAccept.notifyFail"] + zh["batchAccept.allOk"].replace("{count}", "2"));
  assert.match(allOk.state.toasts[0], /未确认送达/, "必须有可见提示");
  assert.match(allOk.state.toasts[0], /已对 2 个目标发起交付复核请求/, "接受结果逐字保留，绝不改判为失败");
  assert.equal(allOk.state.loaded, 1, "刷板不得丢失");
  assert.deepEqual(allOk.state.opened, [false], "全部成功仍关闭弹窗");
  assert.deepEqual(allOk.state.loading, [true, false]);

  // 部分失败 + 通知失败：失败项仍被持久列出，计数不漏
  const partial = makeSubmitBatchAcceptRunner({
    runResult: { ok: [{ goal: "g-1" }], failed: [{ goal: "g-2", error: "boom" }] },
    notifyResult: false, supervisorSession: "sup-1",
  });
  await partial.run(["g-1", "g-2"]);
  assert.equal(partial.state.failures[0][0].goal, "g-2", "失败项必须原样保留");
  assert.equal(partial.state.toasts[0], zh["batchAccept.notifyFail"] + zh["batchAccept.partialResult"].replace("{ok}", "1").replace("{fail}", "1"));
  assert.equal(partial.state.loaded, 1);

  // 通知成功：逐字沿用原 toast（零回归）
  const notified = makeSubmitBatchAcceptRunner({
    runResult: { ok: [{ goal: "g-1" }], failed: [] }, notifyResult: true, supervisorSession: "sup-1",
  });
  await notified.run(["g-1"]);
  assert.equal(notified.state.toasts[0], zh["batchAccept.allOk"].replace("{count}", "1"), "通知成功时 toast 逐字不变");

  // 未配置主管会话：保持原「静默跳过」——不通知、不加警示（零回归）
  const skipped = makeSubmitBatchAcceptRunner({
    runResult: { ok: [{ goal: "g-1" }], failed: [] }, notifyResult: false, supervisorSession: null,
  });
  await skipped.run(["g-1"]);
  assert.deepEqual(skipped.state.notified, [], "未配置主管会话不得尝试通知");
  assert.equal(skipped.state.toasts[0], zh["batchAccept.allOk"].replace("{count}", "1"), "静默跳过不得加警示前缀");
});

// ===== 11. i18n：新增失败提示键 zh/en 对称、en 零 CJK、文案如实 =====
test("g-386 i18n：通知失败提示键对称、en 零 CJK、zh 不得谎称接受失败", () => {
  const { zh, en } = clientI18n();
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "client i18n zh/en 键必须完全对称");
  for (const key of ["exec.acceptNotifyFail", "batchAccept.notifyFail"]) {
    assert.ok(zh[key], `zh 缺少 ${key}`);
    assert.ok(en[key], `en 缺少 ${key}`);
    assert.doesNotMatch(en[key], /[\u3400-\u9fff]/, `en ${key} 含 CJK`);
    assert.match(zh[key], /未确认送达/, `zh ${key} 必须如实说明未确认送达`);
    assert.match(en[key], /unconfirmed/i, `en ${key} 必须如实说明未确认送达`);
  }
  assert.match(zh["exec.acceptNotifyFail"], /接受已成功/, "单卡提示必须说明接受本身已成功");
  assert.doesNotMatch(zh["exec.acceptNotifyFail"], /接受失败/, "不得把通知失败谎报成接受失败");
});
