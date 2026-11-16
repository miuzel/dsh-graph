/**
 * g-615 行为断言库（供正向回归与**变异负向对照**共用）。
 *
 * 为什么抽出来：负向对照必须跑**与正向完全相同的断言**（否则「变异变红」可能只是断言不同，
 * 而不是代码被改坏后的真实行为差异）。因此本文件只描述「期望行为」，不关心被驱动的是
 * 生产 bundle 还是变异 bundle —— 变异对照（g615-live-panel-mutation.test.ts）把改坏的
 * bundle 传进来，断言必须失败。
 *
 * 【att-004 更正：什么叫「迟到的旧响应」】att-002 的假宿主在 abort 时 `reject(...)`，而
 * `answerLate` 随后才 `resolve(...)` —— **对已 settled 的 Promise，resolve 是 no-op（ES 规范）**，
 * 于是「迟到的旧响应」从未抵达组件（真缺陷）。att-003 把 abort 改成「只置标记、不 reject」，
 * 机制上修好了；但 att-003 自己的时序仍然**不是迟到**：它先 `answer("A")` 让 A 回包成功，
 * 再 `answerLate("A")` 对**同一个已 settled 的 Promise** 二次 resolve ⇒ 仍 no-op。于是 att-003
 * 声称的「迟到注入已打通」在它自己的用例里并不成立（评审 att-004 独立探针复核）。
 *
 * 真正的迟到语义（att-004 起本文件的唯一口径，见 `expectLateResponseIgnored`）：
 * **A 的请求在切换身份时还从未回包**，切到 B 且 B 先回包后，A 才第一次回包。此时 A 的
 * `await` 才真正返回到达组件，四态画面因此可以区分（att-004 实测，3 次重复一致）：
 *   PROD            → 🤖 MSG_B（迟到数据被丢弃）
 *   NO_ALIVE        → 读取中…（迟到数据**写进了 storedState**，被渲染期 token 守卫否掉 ⇒ 回退 loading）
 *   NO_TOKEN        → 🤖 MSG_B（token 缺失但 storedState 本就属于 B，无可泄漏）
 *   NO_ALIVE+TOKEN  → 🤖 MSG_A（真实泄漏）
 *
 * ⚠️ **`dirtyCount()` 不能用作「迟到响应抵达组件」的证据**（att-003/att-004 实测）：切换身份时
 * `useSyncExternalStore` 的退订与挂载期遗留的 microtask 都会把仍挂着的实例标记为 dirty ——
 * 实测四态在 `answerLate` 前后 dirty 都是 1。因此「注入是否真的有效」只用**画面差分**证明。
 */
import assert from "node:assert/strict";
import { createClientHarness, snapText, snapFind } from "./client-render-harness.ts";

const flushMicro = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

/**
 * 可被正/负两侧共用的「被测 bundle」描述符。
 * 变异对照不传裸 string，而是显式声明「我改坏了哪个机制」，行为断言据此**只放宽被改坏机制
 * 自身的健康态前置**，其余断言逐条照常执行 —— 否则一次变异会因无关的前置 assert 提前抛错而
 * 掩盖真正想要的失败点（判别力被高估）。
 *
 * ⚠️ 跳过前置 ≠ 不检查机制健康度（att-003 缺陷 3）：跳过一次「A 已渲染」只能说明该变异可能影响
 * A 的加载，**不能**说明「A 根本不加载」也算通过。因此每条被跳过的前置都必须**同时**由
 * `assertTokenGuardMutantHealth` 把该机制自身的健康态钉住（A 真的加载过 **且** 只加载一次），
 * 使「永远 loading / 从不加载」的变异体不能蒙混成绿。
 */
export type HarnessSpec = { bundle?: string; mutation?: "token-guard" | "mode-label" | null };
export type HarnessArg = string | HarnessSpec | undefined;
function specOf(arg: HarnessArg): HarnessSpec {
  if (arg === undefined) return {};
  return typeof arg === "string" ? { bundle: arg } : arg;
}

export const recFor = (who: string) => ({
  type: "event",
  event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "MSG_" + who }] } } },
});

export type HistCall = { parentId: string; childId: string; mode: any; resolve: (v: any) => void; aborted: boolean };

/**
 * SessionPanel 所需的最小 sessions runtime（`useBoundSession` / `useSessionModel` / `useSessionsList`
 * 都会碰它）。只做两件事：让面板能渲染（不刷 `binding 解析失败` 噪音）与 retain/release 配平。
 * 会话本身是假会话：面板显示「会话未接入」，但**执行模式标签行与 RecentRecords 都是真实的**，
 * 本函数要断言的正是这两处。
 */
export function makeSessionsRt(ids: string[] = ["A", "B"]) {
  const subs = new Set<any>();
  const sessions: Record<string, any> = {};
  const snapshot = () => ({
    byId: {},
    items: [],
    subagentsByParent: { p: { entries: ids.map((id) => ({ id, mode: "continuable" })) } },
  });
  return {
    list: { getSnapshot: snapshot, subscribe: (cb: any) => { subs.add(cb); return () => { subs.delete(cb); }; } },
    binding: (id: string) => ({ session: sessions[id] ?? null, eventSource: null }),
    refreshProjections: async () => {},
    retain: (target: any) => {
      const id = typeof target === "string" ? target : (target?.childSessionId ?? String(target));
      const session = {
        id,
        open: async () => {},
        subscribe: () => () => {},
        getSnapshot: () => ({ running: false, chat: null }),
        projections: { faceOf: () => ({ subscribe: () => () => {}, getSnapshot: () => undefined }) },
      };
      sessions[id] = session;
      return { sessionId: id, ready: Promise.resolve(), binding: { session, eventSource: null }, release: () => {} };
    },
  };
}

/**
 * 假宿主 `remote.session`。
 *
 * abort 语义（刻意选择，理由是判别力）：**abort 只置 `aborted` 标记，绝不 reject**。
 * - 若在 abort 时 reject，Promise 立即 settled，之后 `answerLate` 的 resolve 成为 no-op ⇒
 *   「迟到响应」根本没进过组件，断言恒绿（att-002 的缺陷）。
 * - 只置标记 ⇒ `answerLate` 的 resolve 真正驱动 `await remoteSession.events(...)` 之后的分支，
 *   于是「旧响应后到能否污染新身份」被真正执行到。宿主真实实现**可能**在 abort 后拒绝启动、
 *   也可能已发出的请求仍返回结果（本假宿主模拟后者，也是更难的情形）。
 */
export function makeRemote(arg: HarnessArg = {}) {
  const opts = specOf(arg);
  const calls: HistCall[] = [];
  const remote = {
    events: (req: any, signal: any) => new Promise((resolve) => {
      const call: HistCall = {
        parentId: req.address.parentSessionId,
        childId: req.address.childSessionId,
        mode: req.address.mode,
        aborted: false,
        resolve: (v: any) => resolve(v),
      };
      calls.push(call);
      // 只置标记、不 reject：见上方的判别力说明。
      signal?.addEventListener("abort", () => { call.aborted = true; }, { once: true });
    }),
  };
  const h = createClientHarness({
    services: { "remote.session": remote },
    sessions: makeSessionsRt(),
    ...(opts.bundle ? { bundle: opts.bundle } : {}),
  });
  const answer = (childId: string, records = [recFor(childId)]) => {
    const live = calls.filter((c) => c.childId === childId && !c.aborted);
    assert.ok(live.length, `存在尚未取消的 ${childId} 历史请求`);
    for (const c of live) c.resolve({ ok: true, value: { records } });
  };
  /** 无条件回包（含已被 abort 的请求）：模拟「宿主忽略 abort 仍回包」的迟到/乱序注入。 */
  const answerLate = (childId: string, records = [recFor(childId)]) => {
    const call = [...calls].reverse().find((c) => c.childId === childId);
    assert.ok(call, `存在 ${childId} 的历史请求`);
    call.resolve({ ok: true, value: { records } });
  };
  const recordsOf = (childId: string) => calls.filter((c) => c.childId === childId).length;
  const mount = (props: any) => {
    const C = (h.mod as any).__test?.RecentRecords;
    assert.equal(typeof C, "function", "RecentRecords 必须经 __test 暴露（真实组件）");
    return h.mount(C, props);
  };
  /**
   * 挂**真实消费 `subagentMode` 的组件** `SessionPanel`（att-003 缺陷 2）。
   * att-002 这里挂的是 `RecentRecords`，而 `subagentMode` 只被 `SessionPanel` 读取
   * （live-panel.js 的执行模式标签）⇒ 旧写法下 standard ≡ minimal 恒绿、毫无判别力。
   * 本函数顺带点开「查看最近会话记录」抽屉，让被断言的 RecentRecords 真的位于组件树里。
   */
  /**
   * 让挂载前已在飞的 promise 全部落定（`retain().ready` / `refreshProjections`…）。
   * 不这么做的话，SessionPanel 的 `useSyncExternalStore` 订阅会在迟到响应之后被**无关的
   * ready 通知**唤醒 —— 于是 `dirtyCount()` 无法证明「迟到响应驱动了组件」，本夹具的判别力
   * 来自「画面内容」而不是「谁把它变脏」（如实记录：不是「响应没到」，而是「无法归因」）。
   */
  const mountPanel = async (props: any) => {
    const P = (h.mod as any).__test?.SessionPanel;
    assert.equal(typeof P, "function", "SessionPanel 必须经 __test 暴露（真实组件）");
    const view = h.mount(P, props); // 不传 collapsible ⇒ 默认展开，RecentRecords 入口可见
    view.flush();
    await flushMicro();
    view.flush();
    // 等全部挂载期 promise 落定（含 retain.ready），再开始被测时序。
    for (let i = 0; i < 10 && h.dirtyCount() > 0; i += 1) { view.flush(); await flushMicro(); }
    const frame = view.flush();
    // 展开「查看最近会话记录」抽屉：让被断言的 RecentRecords 真的位于组件树里。
    const toggle = snapFind(frame, (n: any) => n.type === "button" && /查看最近会话记录/.test(snapText(n)))[0];
    assert.ok(toggle, "SessionPanel 必须提供「查看最近会话记录」入口（否则本函数测不到 RecentRecords）");
    toggle.props.onClick({ stopPropagation() {} });
    view.flush();
    await flushMicro();
    view.flush();
    await flushMicro();
    view.flush();
    return { view, calls };
  };
  return { h, calls, recordsOf, answer, answerLate, mount, mountPanel };
}

/**
 * 被跳过前置的变异体**自身机制健康度**（缺陷 3 的修复）。
 *
 * 调用点只在 `mutation === "token-guard"` 分支里，用来替代「A 的记录已渲染」这条前置：
 * 断言 A 的请求确实发起过、确实被回包、并且**只发起一次**，且外壳真的提交过多帧并离开「读取中」。
 * 若变异体是「永远 loading / A 永不可见」，这些断言会当场变红 —— 不允许用「跳过前置」把
 * 「旧数据从不加载」洗成绿。
 */
export function assertTokenGuardMutantHealth(ctx: { recordsOf: (id: string) => number; shell: string; frames: number }) {
  assert.equal(ctx.recordsOf("A"), 1, "变异体健康态：A 的历史请求必须发起且仅发起一次（0 次=从未加载，>1 次=重复请求）");
  assert.ok(ctx.frames >= 2, `变异体健康态：挂载后必须至少提交两帧（实得 ${ctx.frames}）`);
  assert.match(
    ctx.shell,
    /最近会话记录|读取中…|无记录|MSG_A|读取失败|不可用/,
    `变异体健康态：RecentRecords 容器必须已挂载并进入某种可见状态，不得整体缺失（实得 ${ctx.shell}）`,
  );
}

/**
 * RecentRecords 的**正文**文本：`RecentRecords` 渲染的根是一个只有内联样式的 `div`，
 * 其文本就是 body（「读取中…」/「（无记录）」/记录行…）。取快照里这样结构最内层的那一层；
 * 取不到返回空串（⇒ 空帧断言变红，不会因为「找不到就跳过」而白送）。
 */
export function recentBody(snap: any): string {
  // 组件实例的 label 是 `RecentRecords #n`（harness 给每个实例打的名字）。
  const comp = snapFind(snap, (n: any) => typeof n.instance?.label === "string" && /^RecentRecords /.test(n.instance.label))[0];
  if (!comp) return "";
  const rootDiv = snapFind(comp, (n: any) => n !== comp && n.type === "div")[0];
  return rootDiv ? snapText(rootDiv) : snapText(comp);
}

/** 组件树里全部可见文本：只要 RecentRecords 还挂在树上就一定非空。 */
const shellTextOf = (root: any) => snapText(root) || "";

/**
 * B1：**A 已加载 → 直切 B** 的首帧不得显示上一身份数据（这是 token 守卫的判别场景）。
 *
 * 判别力说明（M3 修复的核心，务必读）：
 *   · 直切（A 已渲染 → 同一组件实例切到 B）时，新身份的读取**尚未回包**，唯一能让首帧不残留 A
 *     的就是「状态里存着 token，比对不通过就回退 loading」这道守卫。
 *   · **ABA 回切不泄漏 ≠ token 守卫无判别力**：A→B→A 场景里 A 的 token 会被重新 memo 出来，
 *     且新 effect 立刻 setState({loading:true}) 重排，effect 的 alive 标记与 controller.abort()
 *     足以补位，所以删掉 token 守卫在 ABA 场景下**看不出**差异（见 expectAbaRecutClean 的说明）。
 *     只跑 ABA 就断言「token 守卫无判别力」是判宽 —— 直切场景会当场泄漏。
 *
 * `mutation: "token-guard"` 时改用 `assertTokenGuardMutantHealth` 钉住「A 确实加载过」这条前置
 * （缺陷 3），**保留全部泄漏断言**，因此仍必红。
 */
export async function expectIdentitySwitchFirstFrameClean(arg: HarnessArg = {}) {
  const spec = specOf(arg);
  const { answer, mount, recordsOf } = makeRemote(spec);
  const view = mount({ parentId: "p", childId: "A", mode: "continuable" });
  view.flush();
  await flushMicro();
  view.flush();
  // 先让挂载期的 effect 落地（健康态变异体可能**根本不发起**请求，此时 answer 会先抛错而掩盖
  // 真正该红的「健康态」断言）。
  await flushMicro();
  if (spec.mutation === "token-guard" && recordsOf("A") === 0) {
    const shell = shellTextOf(view.flush());
    assertTokenGuardMutantHealth({ recordsOf, shell, frames: view.frames.length });
  }
  answer("A");
  await flushMicro();
  const firstFlush = view.flush();
  if (spec.mutation === "token-guard") {
    assertTokenGuardMutantHealth({ recordsOf, shell: shellTextOf(firstFlush), frames: view.frames.length });
  } else {
    assert.match(snapText(firstFlush), /MSG_A/, "前置：A 的记录已渲染");
  }

  // ① 直切身份的首帧：不得残留 A（token 守卫若缺失，这一帧就会显示 🤖 MSG_A）
  const first = view.flush({ parentId: "p", childId: "B", mode: "continuable" });
  const t = snapText(first);
  assert.doesNotMatch(t, /MSG_A/, `切换身份首帧不得显示上一身份数据（实得 ${t}）`);
  assert.match(t, /读取中…/, `切换身份首帧应回到读取中占位（实得 ${t}）`);
}

/**
 * B1b：乱序与最终态（身份切换后旧请求迟到不得覆盖新身份）。
 * 与 B1 分开：B1 只断言「首帧」，本函数断言「迟到响应 + 最终落定」，两者判别不同的机制。
 *
 * 【att-004 更正：迟到语义必须是「A 从未回包」】
 * att-003 先 `answer("A")` 再 `answerLate("A")` —— 对已 settled 的 Promise 二次 resolve 是 no-op，
 * 迟到的旧响应**根本没到组件**，断言恒绿（空转）。现在改为：A **从不回包**，直切 B，B 先回包
 * （画面离开「读取中…」），**然后** A 才第一次回包。此时 A 的 await 真正返回到达组件，于是
 * 「迟到数据是否被丢弃」才有可观测内容。
 *
 * 断言只写生产代码应有的行为（不替代任何守卫的具体实现）：
 *   ① 切换时旧请求必须被 abort；
 *   ② 迟到回包之后，画面**不得**出现 MSG_A，也**不得**从 B 的既有画面退化（例如被打回「读取中…」——
 *      那同样是迟到写入污染 state 的可观测痕迹）；
 *   ③ 最终态属于新身份 B。
 */
export async function expectLateResponseIgnored(arg: HarnessArg = {}) {
  const spec = specOf(arg);
  const { answer, answerLate, mount, calls } = makeRemote(spec);
  const view = mount({ parentId: "p", childId: "A", mode: "continuable" });
  view.flush();
  await flushMicro();
  view.flush();

  // A **尚未回包**就直切 B（这才是「旧请求仍在飞」的真实竞态形态）
  view.flush({ parentId: "p", childId: "B", mode: "continuable" });
  await flushMicro();
  view.flush();
  const aCall = calls.find((c) => c.childId === "A")!;
  assert.equal(aCall.aborted, true, "身份切换必须 abort 旧身份在飞请求");

  // B 先回包：画面离开「读取中…」，建立可被污染的可观测基线
  answer("B");
  await flushMicro();
  const bFrame = view.flush();
  assert.match(snapText(bFrame), /MSG_B/, "前置：新身份 B 的记录已渲染（迟到注入的可污染基线）");

  // ② 迟到的旧响应（宿主忽略 abort 仍回包，且这是 A 的**第一次**回包）
  answerLate("A");
  await flushMicro();
  const mid = view.flush();
  await flushMicro();
  const lateFrames = snapText(mid) + " || " + snapText(view.flush());
  assert.doesNotMatch(lateFrames, /MSG_A/, `迟到的旧响应不得写入看板（实得 ${lateFrames}）`);
  assert.match(snapText(mid), /MSG_B/, `迟到的旧响应不得把新身份画面打回其它状态（实得 ${snapText(mid)}）`);

  // ③ 新身份最终态
  const final = view.flush();
  assert.match(snapText(final), /MSG_B/, "最终态属于新身份 B");
  assert.doesNotMatch(snapText(final), /MSG_A/, "最终态不含旧身份数据");
}

/**
 * **迟到注入的泄漏对照（判据 3「不得写入」的可归属反向证据）**：去掉 alive 与 token 两道守卫后，
 * 同一迟到注入**必须**真的把旧响应写进看板。
 *
 * 【att-004 更正：为什么只能双删，以及为什么这仍然可信】
 *   · 单删 alive（保留 token）：迟到数据确实进入 `storedState`，但渲染期 token 守卫
 *     （`storedState.token === token`）会否掉它并回退「读取中…」——**无可观测泄漏**。
 *     删掉任何一道都**不**泄漏 ⇒ 判据 3 的泄漏路径需要 alive + token **同时**缺失才可观测。
 *   · 单删 token（保留 alive）：alive 已在 cleanup 置 false，迟到写入被拦在 `setState` 之前，
 *     画面保持 MSG_B ——同样无可观测泄漏。
 *   · 因此「不得写入」的判别力只能由**双删**证明；单机制不可分离（如实标注，不包装成单机制证明）。
 *   本函数在双删变异体上必须变红（泄漏 MSG_A）；若它也保持绿，说明迟到注入又一次空转，
 *   `expectLateResponseIgnored` 的「不得写入」就没有判别力。
 */
export async function expectLateResponseMustLeakOnUnguarded(arg: HarnessArg = {}) {
  const spec = specOf(arg);
  const { answer, answerLate, mount, calls } = makeRemote(spec);
  const view = mount({ parentId: "p", childId: "A", mode: "continuable" });
  view.flush();
  await flushMicro();
  view.flush();
  // A 尚未回包就直切 B；B 先回包建立基线；再让 A 第一次回包（真正的迟到）
  view.flush({ parentId: "p", childId: "B", mode: "continuable" });
  await flushMicro();
  view.flush();
  assert.equal(calls.find((c) => c.childId === "A")!.aborted, true, "身份切换必须 abort 旧身份在飞请求");
  answer("B");
  await flushMicro();
  view.flush();
  answerLate("A");
  await flushMicro();
  const leaked = snapText(view.flush());
  assert.match(
    leaked,
    /MSG_A/,
    `无守卫时迟到的旧响应必须写进看板（实得 ${JSON.stringify(leaked)}）—— 若这里看不到 MSG_A，`
      + "说明迟到注入仍未抵达组件，正向的「不得写入」断言就没有判别力",
  );
}

/**
 * B2：A→B→A 快速回切，任何一帧都不得显示与当前身份不符的数据。
 *
 * ⚠️ **ABA 回切不泄漏 ≠ token 守卫无判别力**：本函数即使在「只删 token 守卫」的变异体下也会
 * 保持 GREEN —— 回切到 A 时新 effect 立刻 `setState({loading:true})` 重排，B 的迟到响应即使抵达
 * 也会被 alive 拦下或被这一拍 loading 覆盖，所以 ABA 场景**看不出** token 守卫缺失（att-004 实测
 * NO_TOKEN 在 ABA 下保持绿）。它**不能**据此断言 token 守卫无判别力；判别场景是直切，见
 * expectIdentitySwitchFirstFrameClean（M3）与 expectLateResponseIgnored（迟到写入）。
 */
export async function expectAbaRecutClean(arg: HarnessArg = {}) {
  const { answer, answerLate, mount, calls } = makeRemote(specOf(arg));
  const view = mount({ parentId: "p", childId: "A", mode: "continuable" });
  view.flush(); await flushMicro(); view.flush();
  answer("A"); await flushMicro();
  assert.match(snapText(view.flush()), /MSG_A/);
  // A → B（B 尚未回包）→ 立刻切回 A
  view.flush({ parentId: "p", childId: "B", mode: "continuable" });
  const back = view.flush({ parentId: "p", childId: "A", mode: "continuable" });
  assert.doesNotMatch(snapText(back), /MSG_A/, "回切首帧不得复用旧缓存");
  assert.match(snapText(back), /读取中…/, "回切首帧重新进入读取中");
  // B 的响应迟到（宿主忽略 abort）：回切后的任何一帧都不得显示 B 的数据
  await flushMicro();
  const bCall = [...calls].reverse().find((c) => c.childId === "B");
  assert.ok(bCall, "B 的历史请求存在");
  answerLate("B");
  await flushMicro();
  const afterLate = snapText(view.flush());
  assert.doesNotMatch(afterLate, /MSG_B/, `回切后迟到的 B 响应不得写入看板（实得 ${afterLate}）`);
  // 回切后 A 的新响应落地
  answer("A");
  await flushMicro();
  view.flush();
  const settled = snapText(view.flush());
  assert.match(settled, /MSG_A/, "回切后的最终态属于 A");
  assert.doesNotMatch(settled, /MSG_B/, "最终态不含 B 的数据");
}

/** B3：断开后无残留（订阅 / 定时器 / 在飞请求）。 */
export async function expectNoResidualResources(arg: HarnessArg = {}) {
  const { calls, mount, h } = makeRemote(specOf(arg));
  const base = h.resources();
  const view = mount({ parentId: "p", childId: "A", mode: "continuable" });
  view.flush(); await flushMicro(); view.flush();
  for (const id of ["B", "C", "D"]) {
    view.flush({ parentId: "p", childId: id, mode: "continuable" });
    await flushMicro();
  }
  assert.equal(calls.filter((c) => c.aborted).length, calls.length - 1, "切换时旧请求被 abort，只留最后一次在飞");
  view.unmount();
  const after = h.resources();
  assert.equal(after.intervals, base.intervals, "卸载后无遗留 interval");
  assert.equal(after.timeouts, base.timeouts, "卸载后无遗留 timeout");
  assert.equal(after.listeners, base.listeners, "卸载后无遗留 window 监听");
}

/** B4：真实空历史 / 错误 / 能力缺失三者互不伪装。 */
export async function expectHonestEmptyAndErrors(arg: HarnessArg = {}) {
  const bundle = specOf(arg).bundle;
  const cases = [
    { name: "empty", remote: { events: async () => ({ ok: true, value: { records: [] } }) }, expect: /（无记录）/, forbid: [/读取失败/, /不可用/] },
    { name: "rejected", remote: { events: async () => ({ ok: false, error: { message: "denied" } }) }, expect: /读取失败：denied/, forbid: [/（无记录）/] },
    { name: "thrown", remote: { events: async () => { throw new Error("offline"); } }, expect: /读取失败：offline/, forbid: [/（无记录）/] },
    { name: "no-capability", remote: {}, expect: /历史记录不可用：宿主未提供读取能力/, forbid: [/（无记录）/, /读取失败/] },
  ];
  for (const c of cases) {
    const h = createClientHarness({ services: { "remote.session": c.remote }, ...(bundle ? { bundle } : {}) });
    const C = (h.mod as any).__test?.RecentRecords;
    const view = h.mount(C, { parentId: "p", childId: "A", mode: "continuable" });
    view.flush();
    await flushMicro();
    const text = snapText(view.flush());
    assert.match(text, c.expect, `${c.name}：必须显示准确提示（实得 ${text}）`);
    for (const f of c.forbid) assert.doesNotMatch(text, f, `${c.name}：不得伪装成其它状态（实得 ${text}）`);
  }
}

/**
 * B5：standard / minimal 两种执行模式下，**直切身份后的首帧**必须既无旧数据、也**不是空帧**，
 * 且两模式的渲染与数据源必须一致。
 *
 * 挂载对象（att-003 缺陷 2 的修复）：`SessionPanel` —— `subagentMode` 的**唯一真实消费者**
 * （`live-panel.js` 里 `props.subagentMode ? ... ${dgT("live.executionMode")} ${props.subagentMode}` 的标签行）。
 * att-002 挂的是 `RecentRecords`，它根本不读该 prop，于是「standard ≡ minimal」同义反复恒绿。
 * 现在模式值直接决定渲染文本 ⇒ `mutation: "mode-label"`（把标签里的模式值抹掉）必然让
 * 「两模式渲染一致」的断言变红，判别力由 M12 钉住。
 *
 * 负向对照（判据 2 的「不空帧」一侧）：`mutation` 为 null 时由 M8（占位抹空）证明「空帧」会被抓到；
 * 本函数自身也断言首帧含「读取中」占位，而不是只断言「没有旧数据」。
 */
export async function expectModeSwitchNoStaleNoEmpty(arg: HarnessArg = {}) {
  const spec = specOf(arg);
  const seen: Record<string, { old: boolean; empty: boolean; target: string; label: string; reading: string }> = {};
  for (const mode of ["standard", "minimal"]) {
    const { answer, mountPanel } = makeRemote(spec);
    const { view, calls } = await mountPanel({ parentId: "p", childId: "A", subagentMode: mode });
    answer("A", [recFor("A")]);
    await flushMicro();
    view.flush();

    // 直切身份后的**第一帧**（同一组件持续挂载，不卸载重建）
    const first = view.flush({ parentId: "p", childId: "B", subagentMode: mode });
    const text = snapText(first);
    // i18n 文案里冒号是「：」、后跟可能有多余空格（右对齐补位），故显式给出分隔。
    const label = (text.match(/执行模式\s*[：:]\s*([A-Za-z-]+)/) ?? [])[1] ?? "";
    // 「空帧」= **RecentRecords 正文**渲染成空白（不是「整块面板空白」：面板还有标题/模型行，
    // 那些与身份切换无关。att-002 用整块面板文本判断「空帧」，使这条断言永不可能红 —— 已修正）。
    const reading = recentBody(first);
    seen[mode] = { old: /MSG_A/.test(text), empty: reading.trim().length === 0, target: "B", label, reading };
    assert.ok(calls.some((c) => c.childId === "B"), `${mode}：切换后必须对 B 发起读取`);
  }
  for (const [mode, r] of Object.entries(seen)) {
    assert.equal(r.old, false, `${mode}：切换身份首帧不得显示上一身份数据`);
    assert.equal(r.empty, false, `${mode}：切换身份首帧不得是空帧（实测空白，说明面板渲染成了空白）`);
    assert.match(r.reading, /读取中…/, `${mode}：首帧应给出「读取中」占位（实得 ${JSON.stringify(r.reading)}）`);
  }
  // 判别力前置：两种 mode 的**渲染文本**必须真的带上各自的模式值（否则「一致」是同义反复）。
  assert.equal(seen.standard.label, "standard", `standard 场景必须渲染出执行模式标签（实得 ${JSON.stringify(seen.standard.label)}）`);
  assert.equal(seen.minimal.label, "minimal", `minimal 场景必须渲染出执行模式标签（实得 ${JSON.stringify(seen.minimal.label)}）`);
  assert.deepEqual(
    { old: seen.standard.old, empty: seen.standard.empty, target: seen.standard.target },
    { old: seen.minimal.old, empty: seen.minimal.empty, target: seen.minimal.target },
    "standard 与 minimal 在身份切换上的渲染与数据源必须一致",
  );
  return seen;
}
