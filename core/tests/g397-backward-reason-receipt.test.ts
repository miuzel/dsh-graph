/** g-397：drag-prompts「回退理由投递」忽略 `session.prompt` 回执（g-386 同形残缺陷）。
 *
 * 缺陷：`BackwardReasonPrompt.sendReason` 忽略 `session.prompt` 的返回，直接 `setSent(true)`；
 * 于是 `{ok:false,error:{code:"subagent/delivery-unavailable"}}` / 激活上限这类**非抛错**失败
 * 仍被 UI 谎报成「已发送」，且不走任何兜底或提示。
 *
 * 本文件用**源码函数 + VM 执行**模块里真实的 `sendReason`（不是重写一份），覆盖：
 *   1. `ok:false` 与**空回执**（undefined / null / 非对象 / 无 ok 字段）一律不置 sent、退复制兜底；
 *   2. 只有正向回执 `ok === true` 才置 sent 并静默提交（不复制、不提示）；
 *   3. prompt 抛错同样按「未确认」处理（与空回执同路，不虚报）；
 *   4. 复制失败改用手动提示文案，理由仍随回退提交（用户已输入内容不丢失）；
 *   5. 无子代理 / 无 prompt / 空理由保持原有提交路径（零行为回归）；
 *   6. **负向对照**：把真实源码的判定改成「恒真」后，同一组 ok:false 断言必然转红；
 *   7. 结构钉：判定表达式与 g-386 的 `accepted` 同口径（`res?.ok === true`），未另立第二套判据，
 *      且未改 session-hooks.js 里 g-386 的既有实现。
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

const DP = readClient("drag-prompts");
const HOOKS = readClient("session-hooks");

/** 按花括号配平抠出一个函数（与 g-273 / g-321 / g-323 / g-327 / g-386 既有做法同源）。 */
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

// ===== 真实 sendReason：从源码抠出 + Function 求值（执行的是模块里真实的实现） =====
interface RunOpts {
  src?: string;
  reason?: string;
  hasChild?: boolean;
  session?: any;
  copyOk?: boolean;
}

function runSendReason(opts: RunOpts = {}) {
  const src = opts.src ?? DP;
  const arrow = extractBalanced(src, "const sendReason = ").slice("const sendReason = ".length).trim();
  const state = {
    sending: [] as boolean[], sent: [] as boolean[], notes: [] as any[], toasts: [] as any[],
    copied: [] as string[], confirmed: [] as any[], prompts: [] as any[],
    timers: [] as { fn: any; ms: number }[],
  };
  const deps: Record<string, any> = {
    goalId: "g-1",
    reason: opts.reason ?? "  理由文本  ",
    hasChild: opts.hasChild ?? true,
    // 显式传 null 表示「会话未接入」，不能用 ?? 兜回默认替身
    session: "session" in opts ? opts.session : {
      prompt: async (parts: any, mode: any) => {
        state.prompts.push({ parts, mode });
        return { ok: true, value: { accepted: true } };
      },
    },
    setSending: (v: boolean) => { state.sending.push(v); },
    setSent: (v: boolean) => { state.sent.push(v); },
    setNote: (v: any) => { state.notes.push(v); },
    onConfirm: (v: any) => { state.confirmed.push(v); },
    dgT: (k: string) => `T:${k}`,
    copyText: async (t: string) => { state.copied.push(t); return opts.copyOk !== false; },
    showToast: (t: any) => { state.toasts.push(t); },
    setTimeout: (fn: any, ms: number) => { state.timers.push({ fn, ms }); return 0; },
  };
  const names = Object.keys(deps);
  const make = new Function(...names, `return ${arrow};`);
  const run = make(...names.map((n) => deps[n])) as () => Promise<void>;
  return { run, state };
}

const promptResponder = (state: { prompts: any[] }, res: any) => ({
  prompt: async (parts: any, mode: any) => { state.prompts.push({ parts, mode }); return res; },
});

// ===== 1. 负回执（非抛错失败）不得虚报「已发送」，必须走可见提示 + 复制兜底 =====
test("g-397 判据1/2：ok:false（delivery-unavailable）不置 sent，退复制兜底且理由不丢", async () => {
  const probe: { prompts: any[] } = { prompts: [] };
  const { run, state } = runSendReason({
    session: promptResponder(probe, { ok: false, error: { code: "subagent/delivery-unavailable" } }),
  });
  await run();
  assert.equal(probe.prompts.length, 1, "确实尝试过投递（恰好一次，不重复发送）");
  assert.equal(probe.prompts[0].mode, "queue", "仍以 queue 模式投递");
  assert.equal(probe.prompts[0].parts[0].text, "【g-1 回退理由】理由文本", "提示词模板逐字不变（reason 已 trim）");
  assert.deepEqual(state.sent, [], "负回执绝不 setSent(true)（不虚报已投递）");
  assert.deepEqual(state.copied, ["理由文本"], "理由必须复制到剪贴板兜底（内容不丢）");
  assert.deepEqual(state.toasts, ["T:backward.reasonUnconfirmedCopied"], "必须有可见提示");
  assert.deepEqual(state.notes, [null, "T:backward.reasonUnconfirmedCopied"], "先清旧提示，弹窗内同样可见");
  assert.deepEqual(state.timers.map((t) => t.ms), [1500], "提示可见后再提交回退");
  state.timers[0].fn();
  assert.deepEqual(state.confirmed, ["理由文本"], "回退照常提交且带原理由（随 transition 事件留档）");
  assert.deepEqual(state.sending, [true, false], "sending 配平");
});

test("g-397 判据1：空回执（undefined/null/非对象/无 ok 字段）一律按「未确认」处理", async () => {
  const empties: any[] = [undefined, null, {}, { ok: undefined }, "ok", 0, { value: { accepted: true } }];
  for (const res of empties) {
    const probe: { prompts: any[] } = { prompts: [] };
    const { run, state } = runSendReason({ session: promptResponder(probe, res) });
    await run();
    assert.deepEqual(state.sent, [], `空回执 ${JSON.stringify(res)} 不得置 sent`);
    assert.deepEqual(state.copied, ["理由文本"], `空回执 ${JSON.stringify(res)} 必须退复制兜底`);
    assert.deepEqual(state.toasts, ["T:backward.reasonUnconfirmedCopied"], `空回执 ${JSON.stringify(res)} 必须有可见提示`);
  }
});

test("g-397 判据1：只有正向回执 ok === true 才置 sent 并静默提交", async () => {
  const probe: { prompts: any[] } = { prompts: [] };
  const { run, state } = runSendReason({ session: promptResponder(probe, { ok: true, value: { accepted: true } }) });
  await run();
  assert.deepEqual(state.sent, [true], "正向回执才显示「已发送」");
  assert.deepEqual(state.copied, [], "正向回执不写剪贴板（不产生多余副作用）");
  assert.deepEqual(state.toasts, [], "正向回执不弹未确认提示");
  assert.deepEqual(state.notes, [null], "发送前清空上一次提示");
  assert.deepEqual(state.timers.map((t) => t.ms), [800], "保留原 800ms 提交延迟");
  state.timers[0].fn();
  assert.deepEqual(state.confirmed, ["理由文本"]);
  assert.deepEqual(state.sending, [true, false]);
});

test("g-397 判据1/2：prompt 抛错同样按未确认处理（不虚报、有提示、有复制兜底）", async () => {
  const { run, state } = runSendReason({
    session: { prompt: async () => { throw new Error("boom"); } },
  });
  await run();
  assert.deepEqual(state.sent, [], "抛错路径绝不 setSent(true)");
  assert.deepEqual(state.copied, ["理由文本"]);
  assert.deepEqual(state.toasts, ["T:backward.reasonUnconfirmedCopied"]);
  assert.deepEqual(state.timers.map((t) => t.ms), [1500]);
  state.timers[0].fn();
  assert.deepEqual(state.confirmed, ["理由文本"], "抛错后回退不再静默吞掉提示");
});

// ===== 2. 复制也失败时的提示与内容保全 =====
test("g-397 判据2：复制失败改用手动提示文案，理由仍随回退提交（不丢失）", async () => {
  const probe: { prompts: any[] } = { prompts: [] };
  const { run, state } = runSendReason({
    session: promptResponder(probe, { ok: false, error: { code: "subagent/ACTIVATION_LIMIT_REACHED" } }),
    copyOk: false,
  });
  await run();
  assert.deepEqual(state.sent, [], "激活上限等负回执同样不得虚报");
  assert.deepEqual(state.copied, ["理由文本"], "仍尝试过复制");
  assert.deepEqual(state.toasts, ["T:backward.reasonUnconfirmedManual"], "复制失败给出可操作提示");
  assert.deepEqual(state.notes, [null, "T:backward.reasonUnconfirmedManual"]);
  state.timers[0].fn();
  assert.deepEqual(state.confirmed, ["理由文本"], "理由随回退事件留档，不丢失用户输入");
});

// ===== 3. 原有路径零回归 =====
test("g-397 判据2：无子代理 / 无 prompt / 空理由保持原提交路径", async () => {
  // 无子代理
  const noChild = runSendReason({ hasChild: false });
  await noChild.run();
  assert.deepEqual(noChild.state.prompts, [], "无子代理不发 prompt");
  assert.deepEqual(noChild.state.confirmed, ["理由文本"], "直接提交");
  assert.deepEqual(noChild.state.copied, [], "无子代理不写剪贴板");
  assert.deepEqual(noChild.state.toasts, []);

  // 有子代理但会话未接入（无 prompt）
  const noSession = runSendReason({ hasChild: true, session: null });
  await noSession.run();
  assert.deepEqual(noSession.state.confirmed, ["理由文本"], "会话未接入 → 原样直接提交");
  assert.deepEqual(noSession.state.sent, [], "未接入不得显示已发送");
  assert.deepEqual(noSession.state.toasts, []);

  // 空理由（仅空白）：不发 prompt、不提交空串以外的内容
  const blankProbe: { prompts: any[] } = { prompts: [] };
  const blank = runSendReason({ reason: "   ", session: promptResponder(blankProbe, { ok: false }) });
  await blank.run();
  assert.deepEqual(blankProbe.prompts, [], "空理由不投递");
  assert.deepEqual(blank.state.confirmed, [""], "空理由直接提交空串（原语义）");
  assert.deepEqual(blank.state.timers, [], "空理由不排提交定时器");
});

// ===== 4. 负向对照：回退修复即红 =====
test("g-397 判据3（负向对照）：判定改成「恒真」后 ok:false 必然被误报成功 ⇒ 上面的断言是有效对照", async () => {
  const mutated = DP.replace("delivered = res?.ok === true;", "delivered = true;");
  assert.notEqual(mutated, DP, "变异必须实际命中源码判定点");
  const probe: { prompts: any[] } = { prompts: [] };
  const { run, state } = runSendReason({
    src: mutated,
    session: promptResponder(probe, { ok: false, error: { code: "subagent/delivery-unavailable" } }),
  });
  await run();
  assert.deepEqual(state.sent, [true], "回退成恒真判定时 ok:false 确实被谎报成「已发送」");
  assert.deepEqual(state.copied, [], "回退后不再走复制兜底");
  assert.deepEqual(state.toasts, [], "回退后没有任何可见提示");
  assert.deepEqual(state.timers.map((t) => t.ms), [800]);
});

// ===== 5. 结构钉：同口径复用、不另立第二套判定、不动 g-386 既有实现 =====
test("g-397 判据1（结构钉）：判定表达式与 g-386 的 accepted 同口径，未另立第二套判据", () => {
  const dp = stripComments(DP);
  // 唯一裁决点：与 session-hooks.js 里 g-386 的 accepted 逐字同口径
  assert.ok(
    dp.includes("delivered = res?.ok === true;"),
    "sendReason 必须以 res?.ok === true 消费回执（g-386 的同一口径）",
  );
  assert.ok(
    stripComments(HOOKS).includes("const accepted = (res) => res?.ok === true;"),
    "g-386 既有实现（session-hooks.js 的 accepted）必须原样保留",
  );
  // 不另立判据：不得改读 value.accepted / 不得把空回执当成功 / 不得按错误码分支放行
  assert.doesNotMatch(dp, /value\??\.accepted/, "不得另立 value.accepted 判据");
  assert.doesNotMatch(dp, /delivered = res\?\.ok !== false/, "不得把空回执当成功");
  // sent 只在正向回执分支被置真（本文件 sendReason 唯一一处）
  const sendReasonBody = extractBalanced(DP, "const sendReason = ");
  assert.equal(sendReasonBody.split("setSent(true)").length - 1, 1, "sendReason 内 setSent(true) 恰好一处");
  assert.match(
    sendReasonBody,
    /if \(delivered\) \{\s*setSent\(true\);/,
    "setSent(true) 必须被 if (delivered) 门控",
  );
  // 未确认分支必须有可见提示与复制兜底
  assert.match(sendReasonBody, /copyText\(reason\.trim\(\)\)/, "未确认分支必须走复制兜底");
  assert.match(sendReasonBody, /showToast\(hint\)/, "未确认分支必须有可见 toast");
  assert.match(sendReasonBody, /setNote\(hint\)/, "未确认分支必须有弹窗内提示");
  assert.match(DP, /note \? h\("div"/, "弹窗必须渲染 note 提示行");
  // g-386 三个分支的 settle 收口仍在（未改 g-386 既有实现）
  assert.equal(
    stripComments(HOOKS).split('settle(await session.prompt(parts, "queue"))').length - 1,
    3,
    "session-hooks.js 的 using/retain/legacy 三分支收口必须原样保留",
  );
});

// ===== 6. i18n：新增文案 zh/en 对称、en 无 CJK，且被真实引用 =====
test("g-397 判据2：未确认提示文案 zh/en 对称且被 sendReason 引用", () => {
  const sandbox: any = { React: {} };
  vm.runInNewContext(readClient("i18n") + "; this.zh = zh; this.en = en;", sandbox);
  const { zh, en } = sandbox as { zh: Record<string, string>; en: Record<string, string> };
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "client i18n zh/en 键必须完全对称");
  for (const key of ["backward.reasonUnconfirmedCopied", "backward.reasonUnconfirmedManual"]) {
    assert.ok(zh[key], `zh 缺少 ${key}`);
    assert.ok(en[key], `en 缺少 ${key}`);
    assert.doesNotMatch(en[key], /[\u3400-\u9fff]/, `en ${key} 不得含 CJK`);
    assert.ok(DP.includes(`dgT(copied ? "backward.reasonUnconfirmedCopied" : "backward.reasonUnconfirmedManual")`)
      || DP.includes(`"${key}"`), `drag-prompts.js 必须引用 ${key}`);
  }
});

// ===== 7. 构建产物同步（dist/lib/client.js 由 build.sh 生成） =====
test("g-397 判据3：构建后的 client bundle 同步包含回执判定", () => {
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.ok(bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"), "client.js 保留 GENERATED FILE header");
  assert.ok(bundle.includes("delivered = res?.ok === true;"), "bundle 必须包含修好后的回执判定");
  assert.ok(bundle.includes('"backward.reasonUnconfirmedCopied"'), "bundle 必须包含未确认提示文案");
});
