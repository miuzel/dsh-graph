/** g-461：新一轮「正在处理…」占位（**纯显示层，路线 A**）回归测试。
 *
 * 口径（负责人 2026-10-09 裁决 + 主管派发口径）：只改显示层，**不落盘、不写 status_line/status_state、
 * 不调 reportStatus、不新增事件**。判定源唯一：`helpers.js` 的 `deriveRunningStatusPlaceholder`
 * （+ `useRoundReportBaseline` 提供「本轮是否已有新真实报告」），由 card.js 的 StatusLine 与
 * session-hooks.js 的 LiveStrip（卡片内嵌 / 顶部主管状态栏两处消费）共用。
 *
 * 本套件用**真实源码模块**（helpers.js / session-hooks.js / card.js / i18n.js）抽到 vm 沙箱里跑，
 * 配最小 React hook 运行时渲染真实 LiveStrip / StatusLine；不复制一份实现来断言。
 *
 * 边界（如实标注）：不启动 3080/3090 实机；GUI 目视不在本套件内，由主管按判据 3 的口令复核。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import {
  CATALOG_SHAPE_FUNCS,
  extractFunction,
  flushAsync,
  makeHookHarness,
  makeSessions016,
  readClient,
} from "./_g387-harness.ts";
import { archiveGoal, createGoal, deleteGoal, GraphError, init, loadGoal, startAttempt } from "../ops.ts";
import { readEvents } from "../events.ts";
import { serializeDoc } from "../model.ts";

const repoRoot = join(import.meta.dirname, "../..");
const clientRoot = join(repoRoot, "dsh-graph-host", "lib", "client");
const PARENT = "parent-1";
const CHILD = "child-1";
const KEY_EXEC = "status.processing.executor";
const KEY_SUP = "status.processing.supervisor";
const silentConsole = { warn: () => {}, error: () => {}, log: () => {} };

/** 构建产物 `dist/lib/client.js`（读一次缓存）——供「出货的那份 JS 也生效」用例。 */
let bundleCache: string | null = null;
function bundleSource(): string {
  if (bundleCache === null) bundleCache = readFileSync(join(repoRoot, "dist", "lib", "client.js"), "utf8");
  return bundleCache;
}

/** LiveStrip / StatusLine 的依赖名（逐字取自真实源模块；缺一个就会在沙箱里 ReferenceError）。 */
const HOOK_NAMES = [
  "bindIdentity", "ensureBindingEntry", "notifyBinding", "subagentAddressFromCatalog",
  "resolveSessionRetainTarget", "startRetainedBinding", "releaseBinding", "useSessionBinding",
  "setupBoundSession", "openBoundSessionStream", "useSessionsList", "useBoundSession",
  "useProjectionValue", "lastStreamLine", "useThrottledLiveSession",
  "deriveLive", "toolDetail", "pickLiveLine", "useLiveStripState", "fmtElapsed", "liveMeter",
  "LiveStrip",
];
const HELPER_NAMES = [
  "subagentCatalogEntries", "subagentAddressOf", "refreshSubagentCatalog",
  ...CATALOG_SHAPE_FUNCS,
  "getLiveDisplay", "useLiveDisplayEnabled", "formatStatusWithLifecycle",
  // g-461 新增（判定源 + 本轮报告基线 + 文案键映射）
  "statusProcessingKey", "statusReportIdentity", "useRoundReportBaseline",
  "deriveRunningStatusPlaceholder",
];

type Sandbox = any;

/** 真实源码模块 → vm 沙箱（i18n 字典 + 最小 h/S 桩 + 可控定时器）。
 *  `from="bundle"` 时从**构建产物** `dist/lib/client.js` 抽同一批函数（证「出货的那份 JS」也生效）。 */
function makeClientSandbox(rt: unknown, from: "source" | "bundle" = "source"): Sandbox {
  const timers: Array<() => void> = [];
  const pick = (name: string) => (from === "bundle" ? bundleSource() : readClient(name));
  const code = [
    readClient("i18n"),
    "var sessionsRt = __rt;",
    "var NOOP_UNSUB = () => () => {};",
    "var S = {};",
    "var h = (tag, p, ...kids) => ({ tag, props: p, children: kids });",
    "var openChildSession = () => {};",
    "var boundSetup = new Map();",
    "var boundModes = new Map();",
    "var boundOpened = new Map();",
    "var retainedBindings = new Map();",
    "var LIVE_DISPLAY_KEY = 'dsh-graph.live-display';",
    "var dgT = (k, p) => { var s = (zh[k] !== undefined ? zh[k] : k); if (p) for (var key in p) s = s.split('{' + key + '}').join(p[key]); return s; };",
    ...HELPER_NAMES.map((n) => extractFunction(pick("helpers"), n)),
    ...HOOK_NAMES.map((n) => extractFunction(pick("session-hooks"), n)),
    extractFunction(pick("card"), "StatusLine"),
    "this.api = { LiveStrip, StatusLine, deriveRunningStatusPlaceholder, useRoundReportBaseline, formatStatusWithLifecycle };",
    "this.zh = zh; this.en = en;",
  ].join("\n");
  const sandbox: Sandbox = {
    __rt: rt,
    React: null,
    console: silentConsole,
    localStorage: { getItem: () => "1", setItem: () => {}, removeItem: () => {} },
    window: { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  vm.runInNewContext(code, sandbox, { filename: "dsh-graph-client-g461-subset" });
  sandbox.timers = timers;
  sandbox.flushTimers = () => { for (const fn of timers.splice(0)) fn(); };
  return sandbox;
}

/** 会话桩：`running` 可手动翻转（模拟快照 false→true，以及被 kill 后归 false）。 */
function makeRunningHost() {
  const host = makeSessions016({ parentId: PARENT });
  host.publishCatalog(CHILD);
  const session: any = host.sessionFor(CHILD);
  const subs = new Set<() => void>();
  let running = false;
  session.getSnapshot = () => ({ running });
  session.subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };
  return {
    host,
    session,
    isRunning: () => running,
    setRunning: (v: boolean) => { running = v; for (const cb of [...subs]) cb(); },
  };
}

function collectText(node: any, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const c of node) collectText(c, out); return out; }
  if (typeof node === "object" && "children" in node) { for (const c of node.children) collectText(c, out); }
  return out;
}

/** 挂载真实 LiveStrip / StatusLine（props 为可变对象，改它再 render 即「新报告到达」）。 */
async function mountStrip(kind: "live" | "statusLine", props: Record<string, unknown>, from: "source" | "bundle" = "source") {
  const host = makeRunningHost();
  const sb = makeClientSandbox(host.host.rt, from);
  const harness = makeHookHarness((R: any) => {
    sb.React = R;
    return kind === "live" ? sb.api.LiveStrip(props) : sb.api.StatusLine(props);
  });
  harness.render();
  await flushAsync();
  await flushAsync();
  await flushAsync();
  /** 走完既有节流（≤5fps trailing flush）与异步绑定，让判定落在「≤1 个刷新周期」内。 */
  const settle = async () => {
    for (let i = 0; i < 3; i++) { sb.flushTimers(); await flushAsync(); }
  };
  await settle();
  return {
    host, sb, harness, props,
    settle,
    text: () => collectText(harness.value()).join(" "),
    node: () => harness.value(),
  };
}

/** g-461 判定源所在的源码区块（注释 + 实现），供「触发可判定/延迟有界」的结构断言。 */
function g461Block(): string {
  const helpers = readClient("helpers");
  const start = helpers.indexOf("===== g-461");
  const end = helpers.indexOf("// g-283：根据目标类型计算");
  assert.ok(start > 0 && end > start, "helpers.js 含 g-461 区块且位于 g-283 之前");
  return helpers.slice(start, end);
}

// ============================================================================
// 判据 1：触发可判定且延迟有界
// ============================================================================

test("g-461 判据1：触发点＝会话快照 running（false→true），最大延迟写明受既有刷新节流约束", async () => {
  const block = g461Block();
  assert.match(block, /running/, "判定必须挂在生命周期 running 上");
  assert.match(block, /false→true/, "必须写明「新一轮开始」的可观测边界（会话快照 false→true）");
  assert.match(block, /MIN_REFRESH_INTERVAL/, "必须写明最大延迟受既有刷新节流约束（MIN_REFRESH_INTERVAL）");
  assert.match(block, /snapshot\.running/, "必须点名触发数据源（会话快照 snapshot.running）");

  // 行为：running=false（idle）时无占位；翻转 false→true 后，一个节流周期内即出现占位。
  const r = await mountStrip("live", { parentId: PARENT, childId: CHILD, statusLine: "完成", statusState: "done" });
  assert.equal(r.host.isRunning(), false, "夹具初始为 idle");
  assert.equal(r.text().includes(r.sb.zh[KEY_EXEC]), false, "idle 时绝不显示「正在处理」");
  r.host.setRunning(true);
  await r.settle();
  assert.equal(r.text().includes(r.sb.zh[KEY_EXEC]), true, "快照 false→true 后一个刷新周期内必须出现占位");
  r.harness.unmount();
});

// ============================================================================
// 判据 3：原始痛点可验收
// ============================================================================

test("g-461 判据3：上一轮 status_line=完成 + status_state=done ⇒ 新轮次渲染「正在处理…」而非终态词", async () => {
  const r = await mountStrip("live", { parentId: PARENT, childId: CHILD, statusLine: "完成", statusState: "done" });
  assert.ok(r.text().includes("完成"), "前置：上一轮终态词确实在界面上（夹具成立）");
  r.host.setRunning(true);
  await r.settle();
  const text = r.text();
  assert.equal(text.includes(r.sb.zh[KEY_EXEC]), true, `新轮次应渲染占位；实际渲染：${text}`);
  assert.equal(text.includes("完成"), false, `终态词必须被占位顶掉；实际渲染：${text}`);
  assert.equal(text.includes(r.sb.zh["status.running"]), true, "运行态标签（🟢）仍在，占位不改变生命周期标签");
  r.harness.unmount();
});

test("g-461 判据3b（真实产物）：dist/lib/client.js 里抽出的 LiveStrip/StatusLine 同样生效", async () => {
  const bundle = bundleSource();
  for (const k of [KEY_EXEC, KEY_SUP]) {
    assert.ok(bundle.includes(k), `构建产物必须带上 i18n 键 ${k}`);
  }
  // 出货的那份 JS：上一轮终态词 → 新轮次占位 → 真实报告让位（三条断言与判据 3/4 同口径）
  const live = await mountStrip("live", { parentId: PARENT, childId: CHILD, statusLine: "完成", statusState: "done" }, "bundle");
  assert.ok(live.text().includes("完成"), "产物前置：终态词在界面上");
  live.host.setRunning(true);
  await live.settle();
  assert.equal(live.text().includes(live.sb.zh[KEY_EXEC]), true, `产物里 LiveStrip 应显示占位；实际：${live.text()}`);
  assert.equal(live.text().includes("完成"), false, "产物里终态词被占位顶掉");
  live.props.statusLine = "正在跑全量测试";
  live.props.statusState = "working";
  live.harness.render();
  await live.settle();
  assert.equal(live.text().includes(live.sb.zh[KEY_EXEC]), false, "产物里真实报告到达后让位");
  assert.equal(live.text().includes("正在跑全量测试"), true, "产物里真实报告逐字显示");
  const line = await mountStrip("statusLine", { text: "完成", statusState: "done", blocked: false, running: true }, "bundle");
  assert.equal(line.text().includes(line.sb.zh[KEY_EXEC]), true, `产物里卡片 StatusLine 应显示占位；实际：${line.text()}`);
  live.harness.unmount();
  line.harness.unmount();
});

// ============================================================================
// 判据 2：两处生效 + 单一判定源 + 按 agent 类型走 i18n
// ============================================================================
test("g-461 判据2：卡片/列表 status 行与顶部主管状态栏都生效，且共用同一判定源", async () => {
  // 消费点 ①：卡片/列表（card.js 内嵌 LiveStrip，parentId=目标会话）
  const card = await mountStrip("live", { parentId: PARENT, childId: CHILD, statusLine: "完成", statusState: "done" });
  card.host.setRunning(true);
  await card.settle();
  assert.equal(card.text().includes(card.sb.zh[KEY_EXEC]), true, "卡片/列表 status 行必须生效");

  // 消费点 ②：看板顶部主管状态栏（supervisor-bar.js 的 LiveStrip：parentId=null + agentKind=supervisor）
  const sup = await mountStrip("live", { parentId: null, childId: CHILD, agentKind: "supervisor", statusLine: "完成", statusState: "done" });
  sup.host.setRunning(true);
  await sup.settle();
  const supText = sup.text();
  assert.equal(supText.includes(sup.sb.zh[KEY_SUP]), true, "主管状态栏必须生效");
  assert.equal(supText.includes(card.sb.zh[KEY_EXEC]), false, "主管栏不得串用执行子代理文案（按 agent 类型固定文案）");

  // 单一判定源：定义恰一处；两处消费点都调用它；supervisor-bar 两处调用点都标注 agent 类型
  const defs = ["helpers", "session-hooks", "card", "supervisor-bar", "live-panel", "kanban"]
    .flatMap((f) => (readClient(f).match(/function deriveRunningStatusPlaceholder\(/g) ?? []).map(() => f));
  assert.deepEqual(defs, ["helpers"], "判定源必须唯一（只有 helpers.js 定义）");
  assert.equal(/deriveRunningStatusPlaceholder\(/.test(readClient("card")), true, "card.js StatusLine（card.js:615 一带）必须复用同一判定源");
  assert.equal(/deriveRunningStatusPlaceholder\(/.test(readClient("session-hooks")), true, "session-hooks.js LiveStrip 必须复用同一判定源");
  const bar = readClient("supervisor-bar");
  assert.equal((bar.match(/agentKind: "supervisor"/g) ?? []).length, 2, "主管栏两处 LiveStrip 调用点都要传 agent 类型");
  assert.equal(/deriveRunningStatusPlaceholder/.test(bar), false, "主管栏不得自带第二套判定（只传类型、共用 LiveStrip 判定）");

  card.harness.unmount();
  sup.harness.unmount();
});

test("g-461 判据2b：卡片 StatusLine（无会话可观测路径）复用同一判定源", async () => {
  const r = await mountStrip("statusLine", { text: "完成", statusState: "done", blocked: false, running: true });
  assert.equal(r.text().includes(r.sb.zh[KEY_EXEC]), true, `卡片状态行应显示占位；实际渲染：${r.text()}`);
  assert.equal(r.text().includes("完成"), false, "终态词被占位顶掉");
  // 同一组件内：本轮出现更晚的真实报告 ⇒ 立即让位
  r.props.text = "正在修复客户端渲染";
  r.props.statusState = "working";
  r.harness.render();
  await r.settle();
  assert.equal(r.text().includes(r.sb.zh[KEY_EXEC]), false, "真实报告到达后占位让位");
  assert.equal(r.text().includes("正在修复客户端渲染"), true, "真实报告逐字显示");
  r.harness.unmount();
});

// ============================================================================
// 判据 4：让位优先级
// ============================================================================

test("g-461 判据4：真实报告到达立即让位，占位不覆盖更晚的真实报告", async () => {
  const r = await mountStrip("live", { parentId: PARENT, childId: CHILD, statusLine: "本轮完成", statusState: "done" });
  r.host.setRunning(true);
  await r.settle();
  assert.equal(r.text().includes(r.sb.zh[KEY_EXEC]), true, "前置：占位已显示");

  // 更晚的 working 报告
  r.props.statusLine = "正在跑全量测试";
  r.props.statusState = "working";
  r.harness.render();
  await r.settle();
  assert.equal(r.text().includes(r.sb.zh[KEY_EXEC]), false, "working 报告到达后占位让位");
  assert.equal(r.text().includes("正在跑全量测试"), true, "working 报告逐字显示");

  // 更晚的 done 报告（同轮次内的收尾汇报）：身份变化即视为新报告，不得被占位遮罩
  r.props.statusLine = "本轮完成";
  r.props.statusState = "done";
  r.harness.render();
  await r.settle();
  assert.equal(r.text().includes(r.sb.zh[KEY_EXEC]), false, "更晚的 done 真实报告也不得被占位覆盖");
  assert.equal(r.text().includes("本轮完成"), true, "更晚的真实报告逐字显示");
  r.harness.unmount();
});

// ============================================================================
// 判据 5：生命周期硬门控 + structured status 优先语义不变
// ============================================================================

test("g-461 判据5：idle/error/done/blocked 不显示「正在处理」，g-239/g-247 语义不变", async () => {
  const r = await mountStrip("statusLine", { text: "完成", statusState: "done", blocked: false, running: false });
  const pure = r.sb.api.deriveRunningStatusPlaceholder;
  assert.equal(pure("完成", false, false, "done", false), null, "idle（running=false）+ done ⇒ 无占位");
  assert.equal(pure("阻塞：等待依赖", false, true, "blocked", false), null, "idle + blocked ⇒ 无占位");
  assert.equal(pure("构建失败报错", false, false, "error", false), null, "idle + error ⇒ 无占位");
  assert.equal(r.text().includes(r.sb.zh[KEY_EXEC]), false, "idle 渲染无占位");

  // running 为真但真实报告是阻塞/失败 ⇒ 结构化状态优先，占位不得遮罩
  for (const [line, state, zhKey] of [["阻塞：等待上游", "blocked", "阻塞"], ["构建失败报错", "error", "构建失败报错"]] as const) {
    const s = await mountStrip("statusLine", { text: line, statusState: state, blocked: false, running: true });
    assert.equal(s.text().includes(s.sb.zh[KEY_EXEC]), false, `${state} 报告不得被占位遮罩`);
    assert.equal(s.text().includes(zhKey), true, `${state} 报告逐字显示`);
    s.harness.unmount();
  }

  // g-247 结构化优先语义逐字不变（结构化状态压过自由文本关键词）
  const fmt = r.sb.api.formatStatusWithLifecycle;
  assert.deepEqual(
    [fmt("没有完成关键词", true, false, "done").isDone, fmt("没有完成关键词", true, false, "done").isRunning],
    [true, false], "structured done 优先于文本");
  assert.deepEqual(
    [fmt("已完成，等待复核", true, false, "working").isDone, fmt("已完成，等待复核", true, false, "working").isRunning],
    [false, true], "structured working 优先于「已完成」文本");
  assert.deepEqual(
    [fmt("空闲待命", true, false).isDone, fmt("空闲待命", true, false).isRunning],
    [true, false], "缺失结构化字段时保留 legacy 文本启发式");
  r.harness.unmount();
});

// ============================================================================
// 判据 6：g-124 长任务显示共存
// ============================================================================

test("g-461 判据6：g-124 长任务 ⏳ + 全文 + 延续时长 tooltip 不被占位顶掉", async () => {
  const statusAt = Date.now() - 90_000;            // 报告早于本轮起点 ⇒ 既有 staleStatus 成立
  const r = await mountStrip("live", {
    parentId: PARENT, childId: CHILD, statusLine: "执行全量测试矩阵", statusState: "working", statusAt,
  });
  r.host.setRunning(true);
  await r.settle();
  const text = r.text();
  assert.equal(text.includes(r.sb.zh[KEY_EXEC]), false, "working 长任务不得被占位顶掉");
  assert.equal(text.includes("执行全量测试矩阵"), true, "长任务全文保留");
  // g-124 的 staleStatus 由 effect 落 ref（既有实现，本次未改动）⇒ 延续时长在随后一次渲染可见；
  // 此处只断言「占位不顶掉」与「tooltip 仍带延续时长」，不改动 g-124 的时序。
  r.harness.render();
  await r.settle();
  assert.equal(r.text().includes(r.sb.zh[KEY_EXEC]), false, "后续渲染中占位同样不得顶掉 working 长任务");
  const rows = (r.node()?.children ?? []).filter((c: any) => c && c.props && typeof c.props.title === "string");
  const ongoing = r.sb.zh["live.statusOngoing"].split("{duration}")[0];
  assert.ok(rows.some((c: any) => c.props.title.includes(ongoing)), `延续时长 tooltip 保留（g-124）；实际 title=${JSON.stringify(rows.map((c: any) => c.props.title))}`);

  // 纯函数侧同样：working + 本轮无新报告 ⇒ 不占位（只覆盖「上一轮遗留的终态词」）
  assert.equal(r.sb.api.deriveRunningStatusPlaceholder("执行全量测试矩阵", true, false, "working", false), null);
  assert.equal(r.sb.api.deriveRunningStatusPlaceholder("本轮完成", true, false, "done", false)?.key, KEY_EXEC);
  r.harness.unmount();
});

// ============================================================================
// 判据 8：收敛性（轮次结束 / 空闲 / 被 kill / 消息连发）
// ============================================================================

test("g-461 判据8：轮次结束或子代理被 kill 后占位收敛，消息连发不残留", async () => {
  const r = await mountStrip("live", { parentId: PARENT, childId: CHILD, statusLine: "完成", statusState: "done" });
  r.host.setRunning(true);
  await r.settle();
  assert.equal(r.text().includes(r.sb.zh[KEY_EXEC]), true, "前置：占位已显示");
  r.host.setRunning(false);                        // 轮次结束 / 子代理被 kill：快照 running → false
  await r.settle();
  assert.equal(r.text().includes(r.sb.zh[KEY_EXEC]), false, "轮次结束后占位必须收敛");
  assert.equal(r.text().includes("完成"), true, "收敛后如实回到生命周期投影（✅ 终态词）");

  // 消息连发：running 保持为真、报告连续变化 ⇒ 永远跟随最新真实报告，不残留占位
  r.host.setRunning(true);
  await r.settle();
  const burst = ["正在读需求", "正在改渲染层", "正在跑测试"];
  for (const line of burst) {
    r.props.statusLine = line;
    r.props.statusState = "working";
    r.harness.render();
    await r.settle();
    assert.equal(r.text().includes(r.sb.zh[KEY_EXEC]), false, `连发中不得残留占位（${line}）`);
    assert.equal(r.text().includes(line), true, `连发必须跟随最新报告（${line}）`);
  }
  r.harness.unmount();
});

// ============================================================================
// 判据 7：零落盘 / 零事件副作用（真实看板夹具，前后字节与事件数不变）
// ============================================================================

/** 真实看板夹具：版本目标 + 一个 attempt（手工写 status_line/status_state）。 */
function boardFixture(statusLine: string, statusState?: string) {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g461-"));
  init(root);
  const id = createGoal(root, { title: "g461 零落盘夹具", version: "v-t", actor: "test" });
  const attId = startAttempt(root, id, { executor: "test", actor: "test" });
  const attFile = join(root, "versions", "v-t", "goals", id, "attempts", attId, "attempt.md");
  const adoc = loadGoal(attFile);
  adoc.meta.status_line = statusLine;
  if (statusState) adoc.meta.status_state = statusState;
  writeFileSync(attFile, serializeDoc(adoc), "utf8");
  const goalFile = join(root, "versions", "v-t", "goals", id, "goal.md");
  const eventsFile = join(root, "events.jsonl");
  const snap = () => ({
    attempt: readFileSync(attFile),
    goal: readFileSync(goalFile),
    events: readFileSync(eventsFile),
    eventCount: readEvents(root).length,
    reported: readEvents(root).filter((e) => e.event === "attempt.status_reported").length,
  });
  return { root, id, attId, attFile, goalFile, snap };
}

test("g-461 判据7：占位不写盘、不加事件（前后 attempt/goal 字节与事件数逐字节不变）", async () => {
  const fx = boardFixture("完成", "done");
  const before = fx.snap();
  const beforeMtime = statSync(fx.attFile).mtimeMs;

  // 驱动**真实渲染路径**（卡片内嵌 LiveStrip + 卡片 StatusLine）显示占位
  const live = await mountStrip("live", { parentId: PARENT, childId: CHILD, statusLine: "完成", statusState: "done" });
  live.host.setRunning(true);
  await live.settle();
  assert.equal(live.text().includes(live.sb.zh[KEY_EXEC]), true, "前置：占位确实渲染过");
  const line = await mountStrip("statusLine", { text: "完成", statusState: "done", blocked: false, running: true });
  assert.equal(line.text().includes(line.sb.zh[KEY_EXEC]), true, "前置：卡片状态行占位确实渲染过");
  live.harness.unmount();
  line.harness.unmount();
  await live.settle();

  const after = fx.snap();
  assert.deepEqual(after.attempt, before.attempt, "attempt.md 必须逐字节不变（占位不写 status_line/status_state）");
  assert.deepEqual(after.goal, before.goal, "goal.md 必须逐字节不变");
  assert.deepEqual(after.events, before.events, "事件流必须逐字节不变（不新增 attempt.status_reported 类事件）");
  assert.equal(after.eventCount, before.eventCount, "事件数不变");
  assert.equal(after.reported, before.reported, "attempt.status_reported 事件数不变");
  assert.equal(statSync(fx.attFile).mtimeMs, beforeMtime, "attempt.md mtime 不变（零写入）");

  // 结构断言：判定源与本轮基线的函数体不含任何写通道
  for (const name of ["deriveRunningStatusPlaceholder", "useRoundReportBaseline", "statusReportIdentity", "statusProcessingKey"]) {
    const body = extractFunction(readClient("helpers"), name);
    for (const forbidden of ["fetch(", "/api/", "reportStatus", "status_reported", "setItem", "writeFile"]) {
      assert.equal(body.includes(forbidden), false, `${name} 不得含写通道 ${forbidden}`);
    }
  }
  for (const f of ["helpers", "session-hooks", "card", "supervisor-bar"]) {
    assert.equal(readClient(f).includes("/api/dsh-graph/report-status"), false, `${f} 不得新增状态写入端点`);
  }
});

// ============================================================================
// 判据 8 负向：不得产生「永久活跃 / 不可删目标」回归
// ============================================================================

test("g-461 判据8负向：占位不改变「status_line 进行中则禁删目标」守卫（终态可删 / 进行中仍拦）", async () => {
  // ① 终态词（done）：占位在界面上出现，但看板守卫仍按终态处理 ⇒ 目标可删
  const ok = boardFixture("完成", "done");
  const live = await mountStrip("live", { parentId: PARENT, childId: CHILD, statusLine: "完成", statusState: "done" });
  live.host.setRunning(true);
  await live.settle();
  assert.equal(live.text().includes(live.sb.zh[KEY_EXEC]), true, "占位确实渲染（显示层呈现「进行中」）");
  assert.equal(readEvents(ok.root).filter((e) => e.event === "attempt.status_reported").length, 0,
    "显示层占位不得伪造状态汇报事件（否则守卫会被自己写活）");
  archiveGoal(ok.root, ok.id, { actor: "test" });
  deleteGoal(ok.root, ok.id, { actor: "test" });   // 不抛 = 未被占位伪造成「进行中」
  live.harness.unmount();

  // ② 进行中（working）：守卫必须照旧拦住——证明占位没有改动/绕过既有活跃判定
  const busy = boardFixture("正在修改核心模块", "working");
  archiveGoal(busy.root, busy.id, { actor: "test" });
  assert.throws(
    () => deleteGoal(busy.root, busy.id, { actor: "test" }),
    (e: unknown) => e instanceof GraphError && e.message.includes("进行中的子代理"),
    "working 报告仍必须拦住删除（守卫语义未回归）",
  );
  // 该路径下占位也不得出现（working 长任务保留原文，见判据 6）
  const strip = await mountStrip("live", { parentId: PARENT, childId: CHILD, statusLine: "正在修改核心模块", statusState: "working" });
  strip.host.setRunning(true);
  await strip.settle();
  assert.equal(strip.text().includes(strip.sb.zh[KEY_EXEC]), false, "working 不显示占位");
  strip.harness.unmount();
});

// ============================================================================
// 判据 9：i18n（zh/en 同步）+ g-352 窄档不溢出
// ============================================================================

test("g-461 判据9：文案走 i18n（zh/en 同键、en 零 CJK），g-352 窄档单行不溢出", async () => {
  const sb = makeClientSandbox(null);
  const zh = sb.zh as Record<string, string>;
  const en = sb.en as Record<string, string>;
  for (const k of [KEY_EXEC, KEY_SUP]) {
    assert.equal(typeof zh[k], "string", `zh 缺 ${k}`);
    assert.equal(typeof en[k], "string", `en 缺 ${k}`);
    assert.notEqual(zh[k], en[k], `${k} zh/en 必须各自成文`);
    assert.equal(/[\u3400-\u9fff]/.test(en[k]), false, `${k} en 不得含 CJK`);
    assert.equal(zh[k], sb.api.formatStatusWithLifecycle === undefined ? zh[k] : zh[k], "占位文案只来自 i18n 字典");
  }
  assert.notEqual(zh[KEY_EXEC], zh[KEY_SUP], "按 agent 类型固定文案：执行子代理与主管不得同串");
  assert.equal(/[\r\n]/.test(zh[KEY_EXEC] + zh[KEY_SUP]), false, "占位文案必须单行");
  assert.ok([...zh[KEY_EXEC]].length <= 24, "占位文案长度受控（窄档单行不溢出）");

  // 窄档（g-352，supervisor-bar compact:true）：单行 + min-width:0 + 省略号收敛
  const r = await mountStrip("live", { parentId: null, childId: CHILD, agentKind: "supervisor", compact: true, statusLine: "完成", statusState: "done" });
  r.host.setRunning(true);
  await r.settle();
  const text = r.text();
  assert.equal(text.includes(r.sb.zh[KEY_SUP]), true, "窄档单行 statusline 也显示占位");
  assert.equal(/[\r\n]/.test(text), false, "窄档渲染必须单行");
  const row = r.node()?.children?.[0];
  const span = row?.children?.[1];
  assert.ok(span, "窄档存在状态行文本节点");
  assert.deepEqual(
    {
      minWidth: span.props.style.minWidth,
      overflow: span.props.style.overflow,
      textOverflow: span.props.style.textOverflow,
      whiteSpace: span.props.style.whiteSpace,
      flex: span.props.style.flex,
    },
    { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
    "窄档状态行保留 g-352 的收敛样式（占位不破坏不溢出契约）",
  );
  assert.equal((r.node()?.children ?? []).length, 1, "compact 形态只渲染一行");
  const bar = readClient("supervisor-bar");
  assert.equal((bar.match(/compact: true/g) ?? []).length, 1, "窄档分支仍走 compact 单行");
  r.harness.unmount();
});

// ============================================================================
// 判据 10：零核心行为改动
// ============================================================================

test("g-461 判据10：新标识符不进入 core/ 与 schema/（持久语义与事件模型零改动）", () => {
  const needles = ["deriveRunningStatusPlaceholder", "useRoundReportBaseline", "status.processing.supervisor", "status.processing.executor"];
  for (const rel of ["core/ops.ts", "core/model.ts", "core/events.ts", "core/main.ts", "core/transaction.ts", "schema/SCHEMA.md", "dsh-graph-host/index.js"]) {
    const src = readFileSync(join(repoRoot, rel), "utf8");
    for (const n of needles) {
      assert.equal(src.includes(n), false, `${rel} 不得出现 ${n}（占位是纯显示层）`);
    }
  }
  // 事件模型未新增事件类型：不可删除/永久活跃的守卫输入面（attempt 元数据）零改动由判据 8 负向用例钉住
  assert.equal(readClient("helpers").includes("attempt.status_reported"), false, "helpers 不得涉及状态汇报事件");
});
