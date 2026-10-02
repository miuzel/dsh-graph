/**
 * g-405（g-390 / g-400 / g-402 同族**第四处** i18n 残留，pre-existing）：英文派发 + **空目标描述**时，
 * 引擎兜底 brief 仍硬编码中文「执行目标描述和质量判据中的任务」。
 *
 * 现象：`resolveEffectiveBrief()`（`dsh-graph-host/index.js`）在 brief / directive / **目标描述**三者皆空时
 * 返回 `{ source: "fallback" }`，文案为固定中文字面式 ⇒ `promptLanguage=en` 时该汉字串进入英文执行者的
 * **action 切片**。可达路径：**共享派发函数 + HTTP 入口**（`entrypoint="http"`，GUI 拖拽/执行按钮；
 * `requireDescription` 只 gate 工具入口）**+ ready/空描述目标** ⇒ 英文执行者 prompt 出现内置汉字。
 * 兜底文案是**插件内置文本**（不是用户材料）⇒ 必须随 `promptLanguage` 本地化（与 g-402 前缀同口径）。
 *
 * 本次修复：兜底文案并入一张与 `AUTO_FROM_DESC_BRIEF_PREFIX` **同风格**的两语言表
 * （`EMPTY_DESC_FALLBACK_BRIEF`，en 表纯 ASCII）；zh 值与基线**逐字相同**（zh 派发产物逐字节不变）；
 * 兜底语义不变（仍指向「目标描述与质量判据」）；来源闭集与四处同值契约、g-378 门禁语义均不变。
 *
 * ## 断言面（判据一一对应）
 *
 * - 判据 1（en 真实 prompt 零汉字）：第 2 条用例走**真实 HTTP 派发**（`/api/dsh-graph/start-execution`
 *   → `subagents.startContinuable` 捕获的最终 prompt 正文），`settings` 服务 locale 置 en、目标**无描述**
 *   ⇒ 真实走 `fallback`。断言：英文兜底在场 / 中文兜底缺席 / 剔除已声明用户材料（标题、判据）后**零汉字**
 *   （汉字判定用判据给定的 U+3400–U+4DBF ∪ U+4E00–U+9FFF；`【】`(U+3010/3011) 等既有契约括号不在其内）。
 *   同条用例再补一个**工具入口 + planning 空描述**（g-236 豁免路径，门禁只作用于 ready/collecting）
 *   的 en 变体，证明兜底语言取自本次派发语言而非入口类型。
 * - 判据 2（zh 不回归 / 门禁不变）：第 3 条用例在 zh 下走 HTTP 空描述派发，断言 `brief` **逐字等于基线
 *   字面式**、整段 prompt 含该字面式、且 `brief_source` 仍为 `fallback`；随后**同一 ready 空描述目标**
 *   经工具入口派发必须仍被 g-378 拒绝（`/目标描述为空/`）且**零副作用**（不派发、不建 attempt）——
 *   门禁语义与入口豁免面在本目标内一字未改。整段 prompt 的**逐字节**对照用 out-of-band sha256 实测
 *   （修复树 vs 基线 `385dc81` 的独立构建副本，同一 fixture、同一脚本，zh 空描述整段 prompt 全同）：
 *     zh-fallback 791a77af09fada39dd095c7f805827faa015e354bc3e6a72f758daafa45026f4（两树相同）
 *     en-fallback 修复后 eaa85801d180337f6941b4f5d6cd40d86a51520557971b31c4a2d344881695de
 *                 基线   4298eedea0b23acc0dca10626209a848654c4037cb70a928ff8c3f1e040287cb（含 15 个汉字）
 *   本文件把「zh 兜底字面式」钉成断言 ⇒ 任何对 zh 文案的改动（多一字/少一空格）即红。
 * - 判据 3（回归 + 负向对照）：本文件即回归。负向对照两重：
 *   ① 源码级 —— 断言兜底分支**不得**再出现裸中文字面式（`brief: "执行目标描述…`），回退修复即红；
 *   ② out-of-band 实测 —— 把**本文件原样**放进基线 `385dc81` 的独立构建副本运行 ⇒ **2 红 1 绿**
 *      （红：源码锚点用例「表不存在」+ en 行为用例「兜底仍是中文」；绿：zh 逐字不回归用例），
 *      红绿分布与缺陷面完全吻合；同一副本自扫码点：en 剔除用户材料后残留 **15 个汉字**
 *      （「执行目标描述和质量判据中的任务」，修复树同口径 = 0）。
 * - 判据 4（不扩展）：改动面只有一张两语言兜底表 + 兜底分支取值 + 注释，无模板引擎、无新配置项、
 *   无截断策略/来源闭集/`brief_source` 改动、无派发组装重构，也未触碰 g-400 反伪装表与 g-397 客户端回执路径。
 *
 * ## 豁免清单（为什么这些字符不算「内置中文泄漏」）
 *
 * 1. 用户材料原文（目标标题 / 质量判据 / directive）：用户写中文是合理且必须逐字保留的行为；
 *    第 2 条用例用「剔除全部已声明原文后必须零汉字」把它与内置文本严格区分（与 g-390/g-400/g-402 同口径）。
 * 2. 全角方括号 `【`(U+3010) / `】`(U+3011)：英文侧既有契约括号约定（资产沿用），`HAN` 只判汉字，
 *    不判 CJK 标点（且判据已显式豁免）。
 *
 * ## 已知证据边界（如实声明）
 *
 * - 插件 `apply()` 在单进程内只完整生效一次，故本文件共用一个惰性 harness；语言经**可变语言持有者**
 *   + `settings` 服务 locale 命名空间读取（`resolvePromptLanguage` 的首选通道）。
 * - 第 1 条用例读 `dsh-graph-host/index.js` 源码定位兜底表与取值点。定位失败即红（绝不静默放过）；
 *   若未来重命名/重构该表，请同步改这里的锚点。
 * - 真机 / GUI 未验证：本文件只覆盖引擎侧 prompt 组装链路（HTTP handler 经最小 REST 桩直连，
 *   派发请求由宿主桩捕获），未在真实 GUI 点按钮、未跑真实子代理。
 * - 自扫码点（不只看断言）：修复树英文空描述兜底路径剔除用户材料后共 6323 字符，剩余非 ASCII 字符只有
 *   U+2014（em dash）与 `【` / `】`(U+3010/3011，判据已豁免的既有契约括号)，汉字计数 0。
 * - 范围外（本次**未**处理，如实声明）：客户端拖拽重执行的 `session.prompt` 载荷
 *   （`dsh-graph-host/lib/client/drag-prompts.js`）里也有同一条中文措辞，但该处带
 *   `i18n-keep(category-b)` 标记（g-272 att-002 约定：发往子代理会话的提示词模板，非 UI 文案，保留中文），
 *   且属 g-397 已定型的**客户端回执**路径 —— 不是派发渲染器的内置文本，未擅自扩大改动面。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createGoal, findGoalFile, init, setCriteria, transition } from "../ops.ts";
import { apply } from "../../dist/index.js";

/** 汉字判定：判据给定的 U+3400–U+4DBF ∪ U+4E00–U+9FFF（CJK 扩展 A + 统一表意文字主区）。 */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 基线（修复前）的 zh 兜底字面式，与本次修复后的 zh 表必须逐字相同。 */
const ZH_FALLBACK = "执行目标描述和质量判据中的任务";
/** 修复引入的英文兜底（与 g-402 前缀 / g-251 英文来源标注同风格）。 */
const EN_FALLBACK = "Execute the task in the goal description and quality criteria.";

// ============================================================================
// 判据 1/3/4：信息源——兜底表按语言取表，en 表零汉字、zh 表逐字等于基线
// ============================================================================

/** 从源码切出 `EMPTY_DESC_FALLBACK_BRIEF` 表（定位失败即抛，禁止静默放过）。 */
function extractFallbackTable(): { zh: string; en: string } {
  const src = readFileSync(join(REPO_ROOT, "dsh-graph-host", "index.js"), "utf8");
  const start = src.indexOf("const EMPTY_DESC_FALLBACK_BRIEF = {");
  assert.notEqual(start, -1, "必须能在 dsh-graph-host/index.js 定位 EMPTY_DESC_FALLBACK_BRIEF（锚点失效请同步本测试）");
  const end = src.indexOf("\n};", start);
  assert.notEqual(end, -1, "必须能定位 EMPTY_DESC_FALLBACK_BRIEF 表的结尾（锚点失效请同步本测试）");
  const block = src.slice(start, end);
  const literal = (lang: "zh" | "en") => {
    const m = new RegExp(`\\n  ${lang}: "((?:[^"\\\\]|\\\\.)*)"`).exec(block);
    assert.ok(m, `必须能定位 ${lang} 兜底字面量（锚点失效请同步本测试）`);
    return m[1];
  };
  return { zh: literal("zh"), en: literal("en") };
}

test("g-405 判据 1/3/4：兜底表 en 零汉字、zh 逐字等于基线，且兜底分支确实按 promptLanguage 取值", () => {
  const table = extractFallbackTable();

  // 缺陷本体（判据 1）：en 兜底**零汉字**。
  assert.doesNotMatch(table.en, HAN, `en 兜底不得含汉字：「${table.en}」`);
  assert.equal(table.en, EN_FALLBACK, "en 兜底须与行为断言预期逐字一致");

  // zh 不回归（判据 2）：zh 兜底与基线**逐字相同**（改一个字符/空格即红）。
  assert.equal(table.zh, ZH_FALLBACK, "zh 兜底必须与基线逐字相同（zh 派发产物逐字节不变）");

  // 检查器自证：回退（en 表换回中文串）必然被上面的断言抓住。
  assert.match(ZH_FALLBACK, HAN, "自证：HAN 检查器必须能识别回退后的中文兜底（否则本用例形同虚设）");

  // 接线守卫（判据 1/4）：兜底分支必须真的按 promptLanguage 取值。
  const src = readFileSync(join(REPO_ROOT, "dsh-graph-host", "index.js"), "utf8");
  assert.ok(
    src.includes("EMPTY_DESC_FALLBACK_BRIEF[normalizePromptLanguage(promptLanguage)]"),
    "兜底分支必须按 promptLanguage 取表（锚点失效请同步本测试）",
  );
  // 负向对照（判据 3 源码级）：兜底分支不得再出现裸中文字面式（回退修复即红）。
  assert.ok(
    !/brief:\s*"执行目标描述/.test(src),
    "兜底 brief 不得再硬编码中文字面式（回退修复必须被本断言抓住）",
  );
});

// ============================================================================
// 真实派发捕获 harness（与 g-402 同口径：单进程只 apply 一次，语言经可变持有者）
// ============================================================================

function makeHarness() {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g405-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const captured: any[] = [];
  const registered: any[] = [];
  const routes: any[] = [];
  const webServer = { register: (r: any) => { routes.push(r); return () => {}; } };
  const lang = { value: "zh" };
  const ctx: any = {
    get: (name: string) => {
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "webServer") return webServer;
      // resolvePromptLanguage 的首选通道：DSH settings 服务的 locale 命名空间。
      if (name === "settings") return { get: (ns: string) => (ns === "locale" ? { preference: lang.value } : undefined) };
      if (name === "subagents") {
        return {
          list: () => ["spawn"],
          getProvider: () => ({ prepareContinuable: () => {} }),
          startContinuable: async (opts: any) => {
            captured.push(opts);
            return { childId: `child-${captured.length}`, parentSessionId: "sess-super" };
          },
        };
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  return {
    ws,
    root,
    captured,
    registered,
    routes,
    lang,
    exec: { agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-exec" } }, signal: new AbortController().signal },
  };
}

type Harness = ReturnType<typeof makeHarness>;

let HARNESS: Harness | null = null;
function harness(): Harness {
  HARNESS ??= makeHarness();
  return HARNESS;
}

/** 极简 REST 请求/响应桩（与 g374 共用 harness 同形；只用到 data/end 事件）。 */
function restCall(route: any, body: any) {
  const req: any = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  req.method = "POST";
  req.url = route.path;
  req.headers = {};
  const res: any = {
    code: 0, payload: null,
    writeHead(code: number) { this.code = code; },
    end(text: string) { this.payload = JSON.parse(text); },
  };
  return route.handler(req, res).then(() => res);
}

function routeOf(h: Harness, path: string) {
  const route = h.routes.find((r: any) => r.path === path);
  assert.ok(route, `REST 路由未注册：${path}`);
  return route;
}

/** 建一个「无描述」的 ready 目标：HTTP 入口可达、工具入口应被 g-378 门禁拒绝。 */
function readyGoalWithoutDescription(h: Harness, title: string, criteria: string[]): string {
  const goal = createGoal(h.root, { title, version: "v-g405", actor: "human:test" });
  setCriteria(h.root, goal, criteria, "human:test");
  transition(h.root, goal, "ready", { actor: "human:test" });
  return goal;
}

/** 经 HTTP 入口（非门禁路径）真实派发空描述目标，返回捕获的最终 prompt。 */
async function startViaHttp(h: Harness, goal: string) {
  const before = h.captured.length;
  const res = await restCall(routeOf(h, "/api/dsh-graph/start-execution"), { goal, workspace: h.ws });
  assert.equal(res.code, 200, `HTTP 入口必须照常派发（实际：${JSON.stringify(res.payload)}）`);
  assert.equal(res.payload.ok, true, "HTTP 派发必须成功");
  const request = h.captured[before]?.request;
  assert.ok(request, "必须捕获到恰好一次子代理派发请求");
  return { payload: res.payload, prompt: String(request.prompt?.[0]?.text ?? "") };
}

// ============================================================================
// 判据 1：英文派发 + 空描述兜底的真实最终 prompt 剔除用户材料后零汉字
// ============================================================================

test("g-405 判据 1/3：英文派发空描述兜底的最终 prompt 零内置汉字（HTTP 入口 + 工具 planning 路径）", async () => {
  const h = harness();
  h.lang.value = "en";

  // 用户材料本身是中文（完全合法且必须逐字保留）⇒ 用它做「剔除后零汉字」的最强对照。
  const title = "英文派发空描述兜底（g-405-TITLE-MARKER）";
  const criterion = "英文派发的最终 prompt 在剔除用户材料后不得含汉字（g-405-CRIT-MARKER）。";
  const goal = readyGoalWithoutDescription(h, title, [criterion]);

  const { payload, prompt } = await startViaHttp(h, goal);

  // 来源与兜底语义未被本目标改动（判据 2 的契约面）：仍是闭集里的 fallback。
  assert.equal(payload.brief_source, "fallback", "空描述路径来源必须仍是 fallback");
  assert.equal(payload.brief, EN_FALLBACK, "英文路径兜底 brief 必须是英文表取值");

  // 缺陷本体（判据 1）：英文兜底在场、中文兜底缺席（回退修复 ⇒ 前两条即红）。
  assert.doesNotMatch(payload.brief, HAN, `兜底 brief 不得含汉字：「${payload.brief}」`);
  assert.ok(prompt.includes(EN_FALLBACK), `英文派发必须使用英文兜底文案（实际 brief：${payload.brief}）`);
  assert.ok(!prompt.includes(ZH_FALLBACK), "英文派发的 action 切片不得出现中文兜底文案");
  assert.ok(!prompt.includes("执行目标描述"), "英文派发不得残留任何中文兜底片段");
  assert.match(prompt, /Source: fallback/, "英文来源标注必须仍在（g-251 成果）");

  // 零汉字（判据 1）：剔除**全部**已声明用户材料后，剩余（= 插件内置文本）零汉字。
  let scrubbed = prompt;
  for (const material of [title, criterion]) scrubbed = scrubbed.split(material).join("");
  assert.doesNotMatch(scrubbed, HAN, "英文派发剔除用户材料后，插件内置文本不得含任何汉字");
  // 剔除确实生效（防「剔除把整段抹空 ⇒ 断言空转」）。—— 语言无关锚点。
  assert.ok(scrubbed.includes(EN_FALLBACK), "剔除用户材料后必须仍保留英文兜底（证明检查面非空）");

  // 同族变体：工具入口 + planning 空描述（g-236 豁免路径，门禁只作用于 ready/collecting）——
  // 兜底语言必须取自本次派发语言，而非入口类型。
  const toolGoal = createGoal(h.root, { title: "工具 planning 空描述（g-405-TOOL-MARKER）", version: "v-g405", actor: "human:test" });
  setCriteria(h.root, toolGoal, ["判据（g-405-TOOL-CRIT）"], "human:test");
  const tool = h.registered.find((d: any) => d.name === "graph_start_attempt");
  assert.ok(tool, "graph_start_attempt 必须已注册");
  const before = h.captured.length;
  const toolRes = await tool.execute({ goal: toolGoal, worktree: false, task_type: "fix" }, h.exec);
  assert.equal(toolRes.brief_source, "fallback", "planning 空描述仍走 g-236 兜底路径");
  assert.equal(toolRes.brief, EN_FALLBACK, "en 下 planning 兜底同样取英文表");
  const toolPrompt = String(h.captured[before]?.request?.prompt?.[0]?.text ?? "");
  assert.ok(toolPrompt.includes(EN_FALLBACK), "en 工具入口兜底必须落英文文案");
  assert.ok(!toolPrompt.includes(ZH_FALLBACK), "en 工具入口不得出现中文兜底文案");
});

// ============================================================================
// 判据 2：zh 派发产物逐字等于基线（含空描述路径），g-378 门禁语义不变
// ============================================================================

test("g-405 判据 2/3：zh 空描述兜底逐字等于基线，且工具入口空描述仍被 g-378 拒绝（零副作用）", async () => {
  const h = harness();
  h.lang.value = "zh";

  const title = "zh 空描述兜底（g-405-ZH-TITLE）";
  const criterion = "zh 兜底文案必须逐字不变（g-405-ZH-CRIT）。";
  const goal = readyGoalWithoutDescription(h, title, [criterion]);

  // ① 工具入口负向（g-378 门禁）：拒绝且零副作用。
  const attDir = join(dirname(findGoalFile(h.root, goal)), "attempts");
  const spawnsBefore = h.captured.length;
  const tool = h.registered.find((d: any) => d.name === "graph_start_attempt");
  assert.ok(tool, "graph_start_attempt 必须已注册");
  await assert.rejects(
    () => tool.execute({ goal }, h.exec),
    /目标描述为空/,
    "ready 空描述目标经工具入口必须仍被 g-378 门禁拒绝（门禁未被本目标改动）",
  );
  assert.equal(h.captured.length, spawnsBefore, "门禁拒绝必须零派发");
  assert.ok(
    !existsSync(attDir) || readdirSync(attDir).filter((d) => d.startsWith("att-")).length === 0,
    "门禁拒绝必须零 attempt",
  );

  // ② HTTP 入口（非门禁路径）：照常派发，zh 兜底逐字等于基线。
  const { payload, prompt } = await startViaHttp(h, goal);
  assert.equal(payload.brief_source, "fallback", "zh 空描述兜底来源必须是 fallback");
  assert.equal(payload.brief, ZH_FALLBACK, "g-236 兜底文案（zh）必须逐字不变");
  assert.ok(prompt.includes(ZH_FALLBACK), "zh prompt 必须逐字承载基线兜底文案");
  assert.ok(!prompt.includes(EN_FALLBACK), "zh 派发不得出现英文兜底文案");
  assert.match(prompt, /来源：fallback/, "zh 来源标注必须仍是中文表（g-251 成果）");
  // zh 兜底语义不变：仍指向「目标描述与质量判据」。
  assert.match(payload.brief, /目标描述/, "兜底语义必须仍指向目标描述");
  assert.match(payload.brief, /质量判据/, "兜底语义必须仍指向质量判据");
});
