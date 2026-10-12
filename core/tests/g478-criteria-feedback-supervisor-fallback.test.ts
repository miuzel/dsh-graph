/** g-478：判据反馈在「无执行会话」时被丢弃 —— 回退**直发主管会话**（负责人 2026-10-11 钦定）。
 *
 * 缺陷：`CriteriaChecklist.sendFb`（goal-actions.js）只绑定该目标当前 attempt 的执行子会话；
 * 绑定为空（无在跑 attempt / 子代理已结束·已解绑·已删除 / 任务由主管自做）时 `if (!session?.prompt)`
 * 直接 return，反馈被丢弃，且把「该目标当前无执行会话」误报成「未接入」。
 *
 * 期望三段式：①有活执行会话 → 原逻辑逐字不变；②无活执行会话 → 转主管（共享 helper
 * promptSessionQueue，**仅正向回执 res.ok === true 算送达**）；③两条通路都不可用 → 明确报错、绝不谎报。
 *
 * 本文件按 g-321 / g-323 / g-386 既有做法：花括号配平抠出模块里**真实的 sendFb**（不是重写一份），
 * 把闭包自由变量做成形参注入；共享 helper 亦抠自 session-hooks.js 的真实 promptSessionQueue，
 * 故 goal-actions.js 一旦回退为「丢弃」或自带第二份能力探测，下方用例必然失败。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const clientRoot = join(import.meta.dirname, "../../dsh-graph-host/lib/client");
const readClient = (name: string) => readFileSync(join(clientRoot, `${name}.js`), "utf8");
const goalActionsSrc = readClient("goal-actions");
const goalModalSrc = readClient("goal-modal");
const bundleSource = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");

/** 花括号配平抠出源码里的一个函数/箭头函数（与 g-321 / g-323 / g-386 同法）。 */
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

const stripComments = (s: string) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

/** 真实共享 helper：从 session-hooks.js 抠出 promptSessionQueue（与测试同 realm；
 *  recorder 作为它的 console 注入，使「失败回报一条可诊断原因」也可断言）。 */
function loadPromptSessionQueue(consoleRecorder: any = console): any {
  const src = extractBalanced(readClient("session-hooks"), "async function promptSessionQueue(");
  const helper = new Function("console", `${src}\nreturn promptSessionQueue;`)(consoleRecorder);
  assert.equal(typeof helper, "function", "抠出的共享 helper 可调用");
  return helper;
}

function loadI18n() {
  const sandbox: any = { React: {} };
  vm.runInNewContext(
    readClient("i18n") + "; this.zh = zh; this.en = en; this.createTranslator = createTranslator;",
    sandbox,
  );
  return { zh: sandbox.zh as Record<string, string>, en: sandbox.en as Record<string, string>, dgT: sandbox.createTranslator() };
}
const { zh, en, dgT } = loadI18n();

const CRITERION = "所有新增单测必须覆盖三条分支";
const OPINION = "请把第三条分支的负回执也覆盖到";

interface Harness {
  sendFb: (criterion: string) => Promise<void>;
  state: {
    notes: any[]; texts: any[]; idxs: any[]; closed: number;
    opened: any[][]; activated: number; toasts: string[]; warns: any[][];
  };
}

/** 真实 sendFb：抠出箭头函数 + 注入闭包自由变量；可选 mutate 用于负向对照。 */
function makeSendFb(env: {
  session?: any; supervisorSession?: any; rt?: any; appCtx?: any; fbText?: string;
  mutate?: (src: string) => string;
}): Harness {
  const src = env.mutate ? env.mutate(goalActionsSrc) : goalActionsSrc;
  const arrow = extractBalanced(src, "const sendFb = ").slice("const sendFb = ".length).trim();
  assert.match(arrow, /^async \(criterion\) => \{/, "抠到的确实是 sendFb 箭头函数");
  const state = { notes: [] as any[], texts: [] as any[], idxs: [] as any[], closed: 0, opened: [] as any[][], activated: 0, toasts: [] as string[], warns: [] as any[][] };
  const consoleRecorder = { warn: (...a: any[]) => state.warns.push(a) };
  const make = new Function(
    "session", "props", "fbText", "setFbNote", "setFbText", "setFbIdx", "dgT",
    "sessionQueueState", "subagentDispatchErrorText", "promptSessionQueue",
    "sessionsRt", "appCtx", "openSessionTarget", "activateChatTab", "showToast", "console",
    `return ${arrow};`,
  );
  const sendFb = make(
    env.session ?? null,
    { goalId: "g-478", supervisorSession: env.supervisorSession ?? null, onClose: () => { state.closed += 1; } },
    env.fbText ?? OPINION,
    (v: any) => state.notes.push(v),
    (v: any) => state.texts.push(v),
    (v: any) => state.idxs.push(v),
    dgT,
    () => ({ pendingCount: 2 }),
    () => null,
    loadPromptSessionQueue(consoleRecorder),
    env.rt ?? null,
    env.appCtx ?? null,
    (...a: any[]) => state.opened.push(a),
    () => { state.activated += 1; },
    (t: string) => state.toasts.push(t),
    consoleRecorder,
  );
  return { sendFb, state };
}

/** 0.1.6 形态宿主：无 get(id)，retain 才借得到 binding；release 后读 binding 抛错（真实语义）。 */
function retainHost(session: any, record: { retains: any[]; releases: number; opened: any[] }) {
  let released = false;
  return {
    binding: () => undefined,
    retain: (id: any, options: any) => {
      record.retains.push({ id, options });
      const reference: any = { sessionId: id, ready: Promise.resolve() };
      Object.defineProperty(reference, "binding", {
        get() {
          if (released) throw new Error("Session reference is released");
          return { session };
        },
      });
      reference.release = () => { released = true; record.releases += 1; };
      return reference;
    },
    open: (id: any) => { record.opened.push(id); },
  };
}
const newRecord = () => ({ retains: [] as any[], releases: 0, opened: [] as any[] });

const promptStub = (receipt: any, calls: any[]) => async (parts: any, mode: any) => {
  calls.push({ parts, mode });
  if (receipt instanceof Error) throw receipt;
  return receipt;
};

// ===== 判据 2：有活执行会话 ⇒ 原路径逐字不变，且完全不触碰主管通路 =====
test("g-478 判据2：有活执行会话仍直发执行会话（原载荷 + queue + 队列深度 + 关弹窗），不触碰主管通路", async () => {
  const calls: any[] = [];
  const record = newRecord();
  const { sendFb, state } = makeSendFb({
    session: { prompt: promptStub({ ok: true }, calls) },
    supervisorSession: "sup-1",
    rt: retainHost({ prompt: promptStub({ ok: true }, []) }, record),
  });
  await assert.doesNotReject(() => sendFb(CRITERION));
  assert.equal(calls.length, 1, "恰好一条投递到执行会话");
  assert.equal(calls[0].mode, "queue", "投递模式仍为 queue");
  assert.equal(calls[0].parts.length, 1);
  assert.equal(calls[0].parts[0].type, "text");
  assert.equal(calls[0].parts[0].text, `【g-478 判据反馈】${CRITERION}\n${OPINION}`, "执行会话载荷模板逐字不变");
  assert.deepEqual(state.notes, [zh["criteria.feedbackQueuedDepth"].replace("{n}", "2")], "队列深度提示不变");
  assert.deepEqual(state.texts, [""], "成功清空输入框");
  assert.deepEqual(state.idxs, [-1], "成功收起输入框");
  assert.equal(state.closed, 1, "成功后关闭弹窗（g-109 行为不变）");
  assert.deepEqual(record.retains, [], "绝不触碰主管会话通路");
  assert.deepEqual(state.opened, [], "不打开主管会话");
  assert.equal(state.activated, 0, "不切换对话页");
  assert.deepEqual(state.toasts, [], "不弹主管提示 toast");
});

test("g-478 判据2：有活执行会话但投递负回执时仍走原失败提示（不误报、不回退主管）", async () => {
  const calls: any[] = [];
  const record = newRecord();
  const { sendFb, state } = makeSendFb({
    session: { prompt: promptStub({ ok: false, error: { message: "queue rejected" } }, calls) },
    supervisorSession: "sup-1",
    rt: retainHost({ prompt: promptStub({ ok: true }, []) }, record),
  });
  await sendFb(CRITERION);
  assert.deepEqual(state.notes, [zh["criteria.feedbackSendFail"] + "queue rejected"]);
  assert.equal(state.closed, 0);
  assert.deepEqual(record.retains, [], "执行会话存在时不回退主管");
});

// ===== 判据 1 / 4：无活执行会话 ⇒ 经共享 helper 送达主管，载荷自描述 =====
test("g-478 判据1+4：无活执行会话时经真实 promptSessionQueue 送达主管（自描述中文载荷 + 区分性提示 + 打开主管会话）", async () => {
  const calls: any[] = [];
  const record = newRecord();
  const rt = retainHost({ prompt: promptStub({ ok: true }, calls) }, record);
  const { sendFb, state } = makeSendFb({ session: null, supervisorSession: "sup-1", rt });
  await assert.doesNotReject(() => sendFb(CRITERION));

  // 走的是共享 helper 的 retain 分支，目标就是主管会话，且 release 严格配平
  assert.deepEqual(record.retains.map((r) => r.id), ["sup-1"], "retain 的目标是主管会话");
  assert.equal(record.retains[0].options.source, "dsh-graph");
  assert.equal(record.releases, 1, "release 配平");
  assert.equal(calls.length, 1, "恰好一条投递到主管会话");
  assert.equal(calls[0].mode, "queue");
  const text = calls[0].parts[0].text as string;
  assert.equal(text, `【g-478 判据反馈（该目标无执行会话 → 转主管）】${CRITERION}\n${OPINION}`);
  assert.ok(text.includes("g-478"), "载荷自描述：含目标 id");
  assert.ok(text.includes(CRITERION), "载荷自描述：含判据原文");
  assert.ok(text.includes(OPINION), "载荷自描述：含负责人意见");
  assert.ok(text.includes("该目标无执行会话 → 转主管"), "载荷标明「无执行会话 ⇒ 转主管」");

  assert.deepEqual(state.notes, [zh["criteria.feedbackSupervisorDelivered"]], "给出区分性成功提示");
  assert.deepEqual(state.toasts, [zh["criteria.feedbackSupervisorDelivered"]], "切页后 toast 同样可见");
  assert.deepEqual(state.opened.map((a) => a[0]), ["sup-1"], "打开主管会话");
  assert.equal(state.activated, 1, "切换到对话页");
  assert.deepEqual(state.texts, [""]);
  assert.deepEqual(state.idxs, [-1]);
  assert.equal(state.closed, 0, "不关弹窗：区分性提示留在原地可见（与既有主管直发 UX 一致）");
});

test("g-478 判据1：绑定存在但无 prompt（已解绑/已删除）时同样回退主管，不丢弃", async () => {
  const calls: any[] = [];
  const record = newRecord();
  const { sendFb, state } = makeSendFb({ session: {}, supervisorSession: "sup-1", rt: retainHost({ prompt: promptStub({ ok: true }, calls) }, record) });
  await sendFb(CRITERION);
  assert.equal(calls.length, 1, "无 prompt 的绑定按「无活执行会话」处理并转主管");
  assert.deepEqual(state.notes, [zh["criteria.feedbackSupervisorDelivered"]]);
});

test("g-478 判据1：sessionsRt 缺失时仍按 appCtx.get(\"sessions\") 取会话服务（取法不变）", async () => {
  const calls: any[] = [];
  const record = newRecord();
  const { sendFb, state } = makeSendFb({
    session: null, supervisorSession: "sup-1", rt: null,
    appCtx: { get: (name: string) => (name === "sessions" ? retainHost({ prompt: promptStub({ ok: true }, calls) }, record) : undefined) },
  });
  await sendFb(CRITERION);
  assert.equal(calls.length, 1, "appCtx 取到的会话服务可投递");
  assert.deepEqual(state.notes, [zh["criteria.feedbackSupervisorDelivered"]]);
});

// ===== 判据 1 / 3：只有正向回执算送达；否则明示未送达、不谎报、不抛 =====
test("g-478 判据1：主管负回执 / 空回执 / 取不到 prompt / prompt 抛错一律按未送达处理（不谎报成功）", async () => {
  const cases: [string, any][] = [
    ["负回执 ok:false", { ok: false, error: { code: "subagent/delivery-unavailable" } }],
    ["空回执 undefined", undefined],
    ["空回执 null", null],
    ["非对象回执", "ok"],
  ];
  for (const [name, receipt] of cases) {
    const calls: any[] = [];
    const record = newRecord();
    const { sendFb, state } = makeSendFb({ session: null, supervisorSession: "sup-1", rt: retainHost({ prompt: promptStub(receipt, calls) }, record) });
    await assert.doesNotReject(() => sendFb(CRITERION), `${name}：不得抛未捕获异常`);
    assert.equal(calls.length, 1, `${name}：确实尝试过投递`);
    assert.deepEqual(state.notes, [zh["criteria.feedbackNotConnected"]], `${name}：必须明示未送达`);
    assert.ok(!state.notes.includes(zh["criteria.feedbackSupervisorDelivered"]), `${name}：绝不谎报送达`);
    assert.deepEqual(state.toasts, [], `${name}：不弹成功 toast`);
    assert.deepEqual(state.opened, [], `${name}：不误报为已打开主管会话`);
    assert.equal(state.activated, 0);
    assert.equal(record.releases, 1, `${name}：release 仍配平`);
    assert.equal(state.warns.length, 1, `${name}：helper 回报一条可诊断原因`);
  }

  // 无 prompt 的主管会话 + prompt 抛错：helper 内部兜底，绝不外抛
  const noPrompt = makeSendFb({ session: null, supervisorSession: "sup-1", rt: retainHost({}, newRecord()) });
  await assert.doesNotReject(() => noPrompt.sendFb(CRITERION));
  assert.deepEqual(noPrompt.state.notes, [zh["criteria.feedbackNotConnected"]]);

  const throwing = makeSendFb({
    session: null, supervisorSession: "sup-1",
    rt: retainHost({ prompt: promptStub(new Error("boom"), []) }, newRecord()),
  });
  await assert.doesNotReject(() => throwing.sendFb(CRITERION));
  assert.deepEqual(throwing.state.notes, [zh["criteria.feedbackNotConnected"]]);
  assert.deepEqual(throwing.state.toasts, []);
});

// ===== 判据 3：主管会话本身不可用（未配置 / 无会话服务）⇒ 明确提示、不抛、不静默 =====
test("g-478 判据3：未配置 supervisor.session 或取不到会话服务时明确报错，不抛、不静默丢弃", async () => {
  // ① 未配置 supervisor.session
  const record = newRecord();
  const noSup = makeSendFb({ session: null, supervisorSession: null, rt: retainHost({ prompt: promptStub({ ok: true }, []) }, record) });
  await assert.doesNotReject(() => noSup.sendFb(CRITERION));
  assert.deepEqual(noSup.state.notes, [zh["criteria.feedbackNotConnected"]], "未配置主管必须明示未送达");
  assert.deepEqual(record.retains, [], "未配置主管时不尝试投递");

  // ② 无 sessions 服务（sessionsRt 与 appCtx 皆空）
  const noRt = makeSendFb({ session: null, supervisorSession: "sup-1", rt: null, appCtx: null });
  await assert.doesNotReject(() => noRt.sendFb(CRITERION));
  assert.deepEqual(noRt.state.notes, [zh["criteria.feedbackNotConnected"]], "无会话服务必须明示未送达");
  assert.deepEqual(noRt.state.opened, []);
  assert.equal(noRt.state.activated, 0);

  // ③ 会话服务存在但不具备任何借用能力（老/异形宿主）→ helper 返回 false → 未送达
  const barren = makeSendFb({ session: null, supervisorSession: "sup-1", rt: { binding: () => undefined } });
  await assert.doesNotReject(() => barren.sendFb(CRITERION));
  assert.deepEqual(barren.state.notes, [zh["criteria.feedbackNotConnected"]]);
  assert.deepEqual(barren.state.toasts, []);
});

// ===== 判据 6 的负向对照：把「未送达」闸门去掉后，同一组负回执断言必然转红 =====
test("g-478 负向对照：删除 if (!delivered) 闸门后负回执会被误报为送达（证明上面断言有效）", async () => {
  const guard = 'if (!delivered) { setFbNote(dgT("criteria.feedbackNotConnected")); return; }';
  const record = newRecord();
  const { sendFb, state } = makeSendFb({
    session: null, supervisorSession: "sup-1",
    rt: retainHost({ prompt: promptStub({ ok: false, error: { code: "subagent/delivery-unavailable" } }, []) }, record),
    mutate: (src) => {
      const mutated = src.replace(guard, "");
      assert.notEqual(mutated, src, "负向对照必须真的改动源码（未送达闸门仍存在）");
      return mutated;
    },
  });
  await sendFb(CRITERION);
  assert.deepEqual(state.notes, [zh["criteria.feedbackSupervisorDelivered"]], "闸门被移除后负回执确实会被谎报为送达 ⇒ 判据1 断言有效");
});

// ===== 判据 1 / 结构：唯一投递裁决点（无第二份能力探测）+ 调用点补传 supervisorSession + 生成物同步 =====
test("g-478 结构契约：sendFb 只消费共享 helper（无第二份 using/retain 探测），调用点补传 supervisorSession", () => {
  const sendFbBody = stripComments(extractBalanced(goalActionsSrc, "const sendFb = "));
  assert.match(sendFbBody, /promptSessionQueue\(rt, props\.supervisorSession,/, "主管投递必须走共享 helper");
  assert.match(sendFbBody, /const rt = sessionsRt \?\? appCtx\?\.get\?\.\("sessions"\)/, "会话服务取法必须与既有主管通路一致");
  assert.doesNotMatch(sendFbBody, /\.using\b/, "不得自带第二份 using 能力探测");
  assert.doesNotMatch(sendFbBody, /\.retain\b/, "不得自带第二份 retain 能力探测");
  assert.doesNotMatch(sendFbBody, /0\.1\.[56]/, "不得写版本号分支");
  assert.match(goalActionsSrc, /【\$\{props\.goalId\} 判据反馈】\$\{criterion\}\\n\$\{t\}`/, "执行会话载荷模板仍逐字保留");
  // 调用点补传 supervisorSession（CriteriaChecklist 此前拿不到它）
  assert.match(goalModalSrc, /h\(CriteriaChecklist, \{[^}]*supervisorSession: props\.supervisorSession[^}]*\}\)/, "goal-modal.js 调用点必须补传 supervisorSession");
  // 生成物同步
  assert.ok(bundleSource.includes("判据反馈（该目标无执行会话 → 转主管）"), "bundle 必须含转主管载荷标记");
  assert.ok(bundleSource.includes("supervisorSession: props.supervisorSession"), "bundle 必须含补传后的调用点");
  assert.ok(bundleSource.includes("criteria.feedbackSupervisorDelivered"), "bundle 必须含新词条");
});

// ===== 判据 5：i18n 新增/修订 key 中英双语齐备、语义对应 =====
test("g-478 判据5：criteria.feedback* 键 zh/en 严格对称，en 无 CJK，新增/修订语义对应", () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "client i18n zh/en 必须严格对称");
  for (const k of ["criteria.feedbackSupervisorDelivered", "criteria.feedbackNotConnected"]) {
    assert.ok(zh[k], `zh 缺少 ${k}`);
    assert.ok(en[k], `en 缺少 ${k}`);
    assert.doesNotMatch(en[k], /[\u3400-\u9fff]/, `en ${k} 不得含 CJK`);
  }
  // 送达文案：区分「已转主管」而非「已送达执行会话」
  assert.equal(zh["criteria.feedbackSupervisorDelivered"], "✅ 已送达主管会话（该目标当前无执行会话）");
  assert.match(en["criteria.feedbackSupervisorDelivered"], /supervisor session/i);
  assert.ok(!zh["criteria.feedbackSupervisorDelivered"].includes("执行会话已送达"));
  assert.notEqual(zh["criteria.feedbackSupervisorDelivered"], zh["criteria.feedbackQueued"]);
  // 未送达文案：如实陈述两条通路都不可达（旧值把「无执行会话」误报成「未接入」）
  assert.ok(zh["criteria.feedbackNotConnected"].includes("主管会话不可达"), "未送达文案必须如实覆盖主管通路");
  assert.match(en["criteria.feedbackNotConnected"], /supervisor session unreachable/i);
  // 两键都被真实代码引用（不是死词条）
  assert.ok(goalActionsSrc.includes('dgT("criteria.feedbackSupervisorDelivered")'));
  assert.ok(goalActionsSrc.includes('dgT("criteria.feedbackNotConnected")'));
});
