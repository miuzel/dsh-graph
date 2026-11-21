/**
 * g-615 负向对照：**改坏产品代码后，同一套断言必须变红**（证明正测试有判别力）。
 *
 * 本文件的证据层：**SIMULATED-ONLY（vm + 假宿主）**——被驱动的是构建产物 dist/lib/client.js
 * 的真实组件，但宿主（sessions runtime / remote.session）是假实现。分层表见
 * docs/g615-evidence-tiers.md。
 *
 * 做法（与 g-352/g-366 的「变异 bundle」口径一致，且**不污染工作区**）：
 *   1. 读生产 bundle（dist/lib/client.js）；
 *   2. 在**内存里**对 `RecentRecords` / `SessionPanel` 做定点变异（等价于删掉守卫）；
 *   3. 把变异 bundle 交给与正向回归**完全相同**的行为断言（fixtures/g615-live-panel-behaviors.ts）；
 *   4. 断言每组断言都失败，并点名失败原因。
 *
 * 不变异磁盘文件、不重建 dist、不跑 pnpm —— 产品源码与构建产物在测试前后逐字节不变。
 * 变异是「把守卫删掉」而不是「造一个不存在的场景」：每条变异都对应源码里真实存在的一行。
 *
 * 【att-004 更正：M9 的如实现状】
 * att-003 把 M9 写成「只删 alive 守卫也必红 ⇒ alive 有独立判别力」，但它的变异体
 * `dropAliveKeepAbort` 内部**又调了 `dropTokenGuard`**，实际删的是 alive + token 两道，
 * 名不副实。att-004 用真正「只删 alive、保留 token」的变异体实测（3 次重复一致）：
 *   时序「A 未回包 → 直切 B → B 回包 → A 首次回包」
 *     PROD            → 🤖 MSG_B
 *     NO_ALIVE        → 读取中…（迟到数据**写进了 storedState**，但渲染期 token 守卫否掉它 ⇒ 回退 loading）
 *     NO_TOKEN        → 🤖 MSG_B
 *     NO_ALIVE+TOKEN  → 🤖 MSG_A（真实泄漏）
 * ⇒ 迟到写入的丢弃由 **token 守卫**提供可观测保护；alive 只阻止「写入 state」这一步，
 *   其效果在画面层**不可观测**（单删 alive 不泄漏），故 alive 与 token 在「迟到写入不得覆盖
 *   看板」这一条上**冗余**。M9 因此**降级为正向说明性用例**（断言只删 alive 时画面也不泄漏），
 *   不再声称它提供反向判别力；判据 3 的反向证据由 M2（双删必泄漏）承担。
 * ⇒ att-003 的另一论证「同一身份重挂载会重新 memo 出同一 token ⇒ 脏状态复活」**已被证伪且删除**：
 *   另查 `RecentRecords` 的 token 来自 `React.useMemo(() => ({}), [parentId, childId, mode])`，
 *   且 att-004 实测同一 props 再提交帧时实例复用（`sameInstance: true`，label 前后均为
 *   `RecentRecords #1`），**没有重挂载路径**；即便有，同 token 下也不会「复活」出 MSG_A
 *   （NO_ALIVE 实测始终是「读取中…」）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { snapText } from "./fixtures/client-render-harness.ts";
import {
  expectIdentitySwitchFirstFrameClean,
  expectLateResponseIgnored,
  expectLateResponseMustLeakOnUnguarded,
  expectAbaRecutClean,
  expectModeSwitchNoStaleNoEmpty,
  expectNoResidualResources,
  expectHonestEmptyAndErrors,
} from "./fixtures/g615-live-panel-behaviors.ts";

/** 「只删 token 守卫」变异体：仅放宽该机制自身的健康态前置（见 assertTokenGuardMutantHealth）。 */
const TOKENLESS = { mutation: "token-guard" as const };

const flushMicro = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
const recFor = (who: string) => ({
  type: "event",
  event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "MSG_" + who }] } } },
});

const bundlePath = join(import.meta.dirname, "../../dist/lib/client.js");
const production = readFileSync(bundlePath, "utf8");

/** 在 bundle 上做一次定点替换；替换必须真的命中（否则变异无效、对照无意义）。 */
function mutate(source: string, from: RegExp, to: string, label: string): string {
  const before = source;
  const out = source.replace(from, to);
  assert.notEqual(out, before, `变异 ${label} 必须真的命中源码（否则对照无效）`);
  return out;
}

/** 取出 RecentRecords 函数体（从函数声明到下一个模块级 function 之前），限定变异范围。 */
function recentRecordsBody(source: string): { start: number; end: number } {
  const start = source.indexOf("    function RecentRecords(props) {");
  assert.ok(start >= 0, "bundle 内存在 RecentRecords");
  const end = source.indexOf("    // 当前模型查询", start);
  assert.ok(end > start, "RecentRecords 函数体边界可定位");
  return { start, end };
}

function mutateInRecentRecords(source: string, from: string, to: string, label: string): string {
  const { start, end } = recentRecordsBody(source);
  const body = source.slice(start, end);
  assert.ok(body.includes(from), `变异 ${label}：RecentRecords 内必须存在目标片段`);
  return source.slice(0, start) + body.replace(from, to) + source.slice(end);
}

const TOKEN_GUARD = "const state = storedState.token === token ? storedState : { loading: true };";
const ALIVE_OK = "if (alive) setState({ token, loading: false, ...result });";
const ALIVE_ERR = "if (alive) setState({ token, loading: false, error: String(e?.message ?? e) });";
const ABORT_CLEANUP = "return () => { alive = false; controller.abort(); };";

/** 删掉 token 守卫（渲染期身份比对）。 */
const dropTokenGuard = (src: string, label: string) => mutateInRecentRecords(src, TOKEN_GUARD, "const state = storedState;", label);
/**
 * **真的只删 alive 守卫**（跨代写入防护），**保留 token 守卫与 abort**。
 * 【att-004】旧实现在这里连 `dropTokenGuard` 一起调 ⇒ 实际是双删，与「只删 alive」名不副实。
 * 现在两个分支各自只删自己的那一行，断言（下面用 `assert.ok(结果仍含 token 守卫)` 兜底）可核验。
 */
const dropAliveKeepAbort = (src: string, label: string) =>
  mutateInRecentRecords(
    mutateInRecentRecords(src, ALIVE_OK, "setState({ token, loading: false, ...result });", `${label} alive 成功分支`),
    ALIVE_ERR, "setState({ token, loading: false, error: String(e?.message ?? e) });", `${label} alive 错误分支`,
  );
/** 删掉 alive 与 token 两道（判据 3 唯一的可观测泄漏路径，见文件头）。 */
const dropAliveAndToken = (src: string, label: string) => dropTokenGuard(dropAliveKeepAbort(src, label), `${label} token 守卫`);

/** 断言某组行为在给定 bundle 下**失败**，并返回错误信息用于点名。 */
async function expectRed(bundle: string, run: (b?: string) => Promise<void>, label: string): Promise<string> {
  await assert.rejects(
    () => run(bundle),
    (err: any) => { assert.ok(err, `${label}：必须抛出断言失败`); return true; },
    `${label}：改坏后断言必须变红（若仍为绿，说明该断言没有判别力）`,
  );
  try {
    await run(bundle);
    return "";
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

test("g-615 M1：删掉 token 守卫（首帧身份比对）后，身份切换首帧泄漏旧数据 ⇒ 断言变红", async () => {
  const mutant = dropTokenGuard(production, "M1");
  // ① 首帧泄漏（M1/M3 的判别点：A 已加载 → 直切 B）
  const msg = await expectRed(mutant, (b) => expectIdentitySwitchFirstFrameClean({ bundle: b, mutation: "token-guard" }), "M1");
  assert.match(msg, /首帧不得显示上一身份数据/, `M1 失败原因应指向首帧残留（实得 ${msg.slice(0, 120)}）`);
  // ② 乱序与最终态（本变异不破坏这两条：alive+abort 仍在，故期望保持绿 —— 如实记录，不假装变红）
  await expectLateResponseIgnored(TOKENLESS);
  // 正向：生产 bundle 同一断言必须为绿
  await expectIdentitySwitchFirstFrameClean();
  await expectLateResponseIgnored();
});

test("g-615 M2：删掉 alive + token + abort 三者后，迟到的旧响应覆盖新身份 ⇒ 断言变红（判据 3 的反向证据）", async () => {
  let mutant = dropAliveAndToken(production, "M2");
  mutant = mutateInRecentRecords(mutant, ABORT_CLEANUP, "return () => {};", "M2 abort 清理");
  // 【att-004 更正】这是判据 3「不得写入」**唯一可归属**的反向证据：单删 alive（M9，说明性）与
  //   单删 token（M3 的 ABA 侧）都不泄漏，只有 alive + token 同时缺失时迟到写入才可观测（泄漏 MSG_A）。
  //   故本文不声称「某单一机制提供判别力」，只声称「本变异体下同一迟到注入必然可见」。
  const msg = await expectRed(mutant, (b) => expectLateResponseIgnored({ bundle: b, mutation: "token-guard" }), "M2");
  assert.match(msg, /迟到的旧响应不得写入看板|迟到的旧响应不得把新身份画面打回其它状态|身份切换必须 abort/,
    `M2 失败原因应指向迟到写入/乱序防护（实得 ${msg.slice(0, 120)}）`);
  assert.notEqual(mutant, production);
  // 正向：生产 bundle 在迟到注入下仍绿
  await expectLateResponseIgnored();
});

test("g-615 M3：只删 token 守卫 + A 已加载 → 直切 B，首帧泄漏旧数据 ⇒ 断言必红", async () => {
  // 【att-002 修复的正是此处】att-001 只跑了 expectAbaRecutClean（A→B→A 回切）就得出
  // 「token 守卫无判别力」的结论 —— 那是判宽：ABA 回切会重新发起读取，新 effect 的 alive 标记与
  // controller.abort() 足以补位，所以回切场景看不出 token 守卫缺失。**ABA 回切不泄漏 ≠ token 守卫
  // 无判别力**：直切（A 已渲染 → 同一实例切到 B）时新身份尚未回包，唯一挡住旧数据的就是 token
  // 守卫，此刻首帧会直接渲染 🤖 MSG_A。下面用同一个变异体把两种场景都钉住。
  const tokenless = dropTokenGuard(production, "M3");
  // ① 直切场景（判别场景）：必须变红，且失败原因是首帧残留
  const msg = await expectRed(tokenless, (b) => expectIdentitySwitchFirstFrameClean({ bundle: b, mutation: "token-guard" }), "M3 直切");
  assert.match(msg, /首帧不得显示上一身份数据/, `M3 直切失败原因应指向首帧残留（实得 ${msg.slice(0, 120)}）`);
  // ② ABA 回切对照（说明 alive+abort 在回切场景能独立补位）：同一变异体在此**保持绿**
  await expectAbaRecutClean({ bundle: tokenless });
  // ③ 生产 bundle 两种场景都为绿
  await expectIdentitySwitchFirstFrameClean();
  await expectAbaRecutClean();
});

test("g-615 M4：删掉 abort 清理后，切换身份不取消旧请求 ⇒ 资源清理断言变红", async () => {
  const mutant = mutateInRecentRecords(production, ABORT_CLEANUP, "return () => {};", "M4 abort 清理");
  await expectRed(mutant, expectNoResidualResources, "M4");
  await expectNoResidualResources();
});

test("g-615 M5：把「读取失败」伪装成「无记录」后，诚实提示断言变红", async () => {
  const mutant = mutateInRecentRecords(
    production,
    'else if (state.error) body = dgT("live.readFailed") + state.error;',
    'else if (state.error) body = dgT("live.noRecords");',
    "M5 错误伪装为空",
  );
  await expectRed(mutant, expectHonestEmptyAndErrors, "M5");
  await expectHonestEmptyAndErrors();
});

test("g-615 M6：把「历史不可用」伪装成「无记录」后，诚实提示断言变红", async () => {
  const mutant = mutateInRecentRecords(
    production,
    'else if (state.unavailable) body = dgT(state.unavailable === "identity" ? "live.historyIdentityUnavailable" : "live.historyUnavailable");',
    'else if (state.unavailable) body = dgT("live.noRecords");',
    "M6 不可用伪装为空",
  );
  await expectRed(mutant, expectHonestEmptyAndErrors, "M6");
});

test("g-615 M7（无变异基线对照）：生产 bundle 下全部行为的正向断言为绿", async () => {
  // 与上面每条对照的「正向一半」同源；单独列出一条，便于评审直接看基线结论。
  await expectIdentitySwitchFirstFrameClean();
  await expectLateResponseIgnored();
  await expectAbaRecutClean();
  await expectModeSwitchNoStaleNoEmpty();
  await expectNoResidualResources();
  await expectHonestEmptyAndErrors();
});

test("g-615 M8：把「读取中」占位抹成空串后，判据 2 的「不空帧」断言变红（空帧负向对照）", async () => {
  // 判据 2 的「不空帧」此前只有正向一侧（渲染出了「读取中」）。本对照把占位抹空，证明
  // 「面板渲染成全空白」也能被同一套断言抓到 —— 否则「不空帧」只是空话。
  const mutant = mutateInRecentRecords(
    production,
    'if (state.loading) body = dgT("live.reading");',
    'if (state.loading) body = "";',
    "M8 读取中占位抹空",
  );
  const msg = await expectRed(mutant, (b) => expectModeSwitchNoStaleNoEmpty({ bundle: b }), "M8");
  assert.match(msg, /空帧/, `M8 失败原因应指向空帧（实得 ${msg.slice(0, 120)}）`);
  // 正向：生产 bundle 同一断言为绿（确实给出「读取中」占位，不是空白）
  await expectModeSwitchNoStaleNoEmpty();
});

test("g-615 M9（正向说明性用例，非反向对照）：只删 alive 守卫时，迟到数据仍不得出现在画面", async () => {
  // 【att-004 定性：这是**正向说明性**用例，不是「改坏必红」的反向对照】
  // att-003 把 M9 写成「只删 alive 也必红 ⇒ alive 有独立判别力」，但当时的变异体内部还调了
  // dropTokenGuard（实际双删），名不副实。现在 `dropAliveKeepAbort` 真的只删 alive、保留 token
  // 与 abort（下方 assert 兜底核验变异体仍含 token 守卫）。用真正迟到（A 切换后才首次回包）的
  // 时序实测：迟到数据**确实写进了 storedState**，但渲染期 token 守卫（storedState.token === token）
  // 不通过 ⇒ 回退 {loading:true} ⇒ 画面是「读取中…」而**不是** MSG_A。也就是说：
  //   · 可观测的丢弃由 **token 守卫**提供保护；
  //   · alive 只阻止「写入 state」这一步，画面层不可观测 ⇒ 单机制**无**判别力；
  //   · 故本用例断言的是「不泄漏」（与生产一致），**不**断言「必红」，也不为 alive 记判别力。
  // 判据 3 的可归属反向证据在 M2（alive + token 双删必泄漏 MSG_A）。
  const { createClientHarness } = await import("./fixtures/client-render-harness.ts");
  const aliveOnly = dropAliveKeepAbort(production, "M9");
  assert.ok(aliveOnly.includes(TOKEN_GUARD), "M9 变异体必须**保留** token 守卫（否则就不是「只删 alive」）");
  assert.ok(aliveOnly.includes(ABORT_CLEANUP), "M9 变异体必须保留 abort 清理");
  assert.notEqual(aliveOnly, production, "M9 必须真的删掉了 alive 守卫");

  /** 真正迟到：A 从未回包 → 直切 B → B 回包 → A 首次回包。 */
  const run = async (bundle: string, label: string) => {
    const calls: { childId: string; aborted: boolean; resolve: (v: any) => void }[] = [];
    const remote = {
      events: (req: any, signal: any) => new Promise((resolve: any) => {
        const call: any = { childId: req.address.childSessionId, aborted: false, resolve };
        calls.push(call);
        signal?.addEventListener("abort", () => { call.aborted = true; }, { once: true });
      }),
    };
    const h = createClientHarness({ services: { remote: {}, "remote.session": remote }, bundle });
    const C = (h.mod as any).__test?.RecentRecords;
    const view = h.mount(C, { parentId: "p", childId: "A", mode: "continuable" });
    view.flush(); await flushMicro(); view.flush();
    const aCall = calls.find((c) => c.childId === "A")!;
    // A 未回包就直切 B
    view.flush({ parentId: "p", childId: "B", mode: "continuable" });
    await flushMicro(); view.flush();
    assert.equal(aCall.aborted, true, `${label}：切换时旧请求必须被 abort`);
    // B 先回包，建立可被污染的可观测基线
    calls.find((c) => c.childId === "B")!.resolve({ ok: true, value: { records: [recFor("B")] } });
    await flushMicro();
    const baseline = snapText(view.flush());
    // 真正的迟到：A 的**第一次**回包
    aCall.resolve({ ok: true, value: { records: [recFor("A")] } });
    await flushMicro();
    const afterLate = snapText(view.flush());
    view.unmount();
    return { baseline, afterLate };
  };

  const prod = await run(production, "PROD");
  assert.match(prod.baseline, /MSG_B/, `生产 bundle：基线应为 B 的记录（实得 ${JSON.stringify(prod.baseline)}）`);
  assert.doesNotMatch(prod.afterLate, /MSG_A/, `生产 bundle：迟到数据不得出现（实得 ${JSON.stringify(prod.afterLate)}）`);

  const mut = await run(aliveOnly, "M9");
  assert.doesNotMatch(mut.afterLate, /MSG_A/,
    `只删 alive 后迟到数据**仍不得渲染**（实得 ${JSON.stringify(mut.afterLate)}）—— 画面层由 token 守卫兜底；`
      + "若这里出现 MSG_A，说明 token 守卫也失效了（与 att-004 实测不符，需重新判定）");
  // 如实记录 alive 缺失的可观测痕迹：迟到写入把画面从 MSG_B 打回「读取中…」（token 守卫否掉脏 state）。
  assert.doesNotMatch(mut.afterLate, /MSG_B/,
    `只删 alive 时迟到写入应留下可观测痕迹（画面从 B 的基线退化），实得 ${JSON.stringify(mut.afterLate)}`);

  // 【att-004 补】NO_TOKEN 四态在此之前只存在于文档与探针里，仓库内无用例 ⇒ 无回归保护。
  // 用同一真迟到时序固化它。如实定性：画面仍是 MSG_B **不等于** token 守卫有效 ——
  // storedState 本来就属于 B，token 不匹配与否都画出同一个 B，**没有可泄漏的内容**。
  // 因此这条断言的是「单删 token 在真迟到下也无泄漏」，不是「token 守卫有判别力」；
  // 判据 3 的可归属反向证据仍只由 M2（双删）承担。
  const tokenless = dropTokenGuard(production, "M9b");
  assert.notEqual(tokenless, production, "M9b 必须真的删掉了 token 守卫");
  const noTok = await run(tokenless, "M9b");
  assert.match(noTok.baseline, /MSG_B/, `只删 token：基线仍应为 B（实得 ${JSON.stringify(noTok.baseline)}）`);
  assert.doesNotMatch(noTok.afterLate, /MSG_A/,
    `只删 token 后迟到数据仍不得出现（实得 ${JSON.stringify(noTok.afterLate)}）—— `
      + "storedState 本就属于 B，无可泄漏内容；若这里出现 MSG_A 说明结论需重新判定");
});

test("g-615 M10：mutation 跳过健康态前置时，「永远 loading、A 永不可见」的变异体也必须变红", async () => {
  // 缺陷 3：旧写法下 `mutation: "token-guard"` 会跳过「A 已渲染」这条前置，于是一个「A 永远加载
  // 不出记录」的变异体（会让任何「首帧不得残留 A」的断言白送）可以蒙混成绿。修复后跳过的前置由
  // `assertTokenGuardMutantHealth` 顶替：A 的请求必须发起且只发起一次、必须提交多帧、RecentRecords
  // 容器必须已进入可见状态。本用例用「history 永不回包」的变异体把这条修复钉死。
  // 「A 永远 loading、永不可见」的最小变异：删掉唯一的 `loadHistory()` 调用（请求都不会发起）。
  const mutant = mutateInRecentRecords(production, "\n        loadHistory();\n", "\n", "M10 永不做历史加载");
  const msg = await expectRed(mutant, (b) => expectIdentitySwitchFirstFrameClean({ bundle: b, mutation: "token-guard" }), "M10");
  assert.match(msg, /变异体健康态/, `M10 失败原因应点名变异体健康态（实得 ${msg.slice(0, 160)}）`);
  // 不带 mutation 标记时同样必须红（对照组：旧口径下这条本来就是红的）
  await expectRed(mutant, (b) => expectIdentitySwitchFirstFrameClean({ bundle: b }), "M10 无标记");
});

test("g-615 M11：迟到注入的判别力元证据 —— 双删时必泄漏（M2）、有守卫时不得泄漏（生产）", async () => {
  // 缺陷 1 把「迟到响应能否抵达组件」变成了必须自证的事。att-004 更正后的元证据由**两条**组成：
  //   · M2：alive + token 双删时，同一条迟到注入**必须**让画面出现 MSG_A（注入确实抵达组件）；
  //   · 本用例：生产 bundle 上跑同一注入，画面必须看不到旧数据且不退化为「读取中…」。
  // 两条一起构成「注入有效 + 断言有判别力」的最低元证据；单看任一条都不够。
  //
  // 【att-004 更正】att-003 此处写「M9 证明无 alive 守卫时会复活」——**已证伪并删除**：
  //   只删 alive 时迟到写入被 token 守卫否掉，画面是「读取中…」而非 MSG_A（见 M9 的定性说明）。
  await expectLateResponseIgnored();
  await expectAbaRecutClean();
});

test("g-615 M12：把执行模式值从标签里抹掉后，「两 mode 渲染一致」的断言变红（判据 2 的 mode 维度）", async () => {
  // 缺陷 2：att-002 的 mode 维度挂在 RecentRecords 上，而该组件根本不读 subagentMode ⇒ 同义反复恒绿。
  // 现在断言挂在 SessionPanel（唯一消费者）上并要求渲染文本带上模式值；本变异把值抹掉，必须变红。
  const from = '(props.subagentMode ? ` ｜ ${dgT("live.executionMode")} ${props.subagentMode}` : "")';
  const mutant = mutate(production, from, '(props.subagentMode ? ` ｜ ${dgT("live.executionMode")}` : "")', "M12 模式值抹除");
  const msg = await expectRed(mutant, (b) => expectModeSwitchNoStaleNoEmpty({ bundle: b }), "M12");
  assert.match(msg, /执行模式标签/, `M12 失败原因应指向 mode 标签判别力前置（实得 ${msg.slice(0, 160)}）`);
  // 正向：生产 bundle 下两 mode 都能看到各自的模式值且切换干净
  await expectModeSwitchNoStaleNoEmpty();
});
