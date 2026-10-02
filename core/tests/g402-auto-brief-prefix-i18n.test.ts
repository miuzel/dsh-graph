/**
 * g-402（g-390 / g-400 同族**第三处** i18n 残留，pre-existing）：英文派发 + `auto_from_desc`
 * 时，合成 brief 的前缀仍是中文。
 *
 * 现象：`resolveEffectiveBrief()`（`dsh-graph-host/index.js`）在**无显式 brief/directive** 时从目标
 * 描述合成 action，前缀固定为「执行目标描述中的任务：」⇒ `promptLanguage=en` 时该汉字串进入英文
 * 执行者的 **action 切片**（显式 brief / directive 路径不受影响）。合成 brief 只是把插件内置前缀
 * 与用户材料拼在一起，**前缀**属插件内置文本 ⇒ 必须随 `promptLanguage` 本地化。
 *
 * 本次修复：前缀按语言取表（`AUTO_FROM_DESC_BRIEF_PREFIX`，en 表纯 ASCII）；zh 表与基线**逐字相同**；
 * 合成 brief 仍**完整承载目标描述全文**（保留 g-251 的「不再截到 200 字」成果）；`brief_source` 闭集与
 * 四处同值契约不变。
 *
 * ## 断言面（判据一一对应）
 *
 * - 判据 1（en 真实 prompt 零汉字）：第 2 条用例走**真实工具派发**（`subagents.startContinuable`
 *   捕获的最终 prompt 正文），`settings` 服务的 locale 命名空间置 en、目标**有描述无指令** ⇒ 真实走
 *   `auto_from_desc`。断言：英文前缀在场 / 中文前缀缺席 / 剔除已声明用户材料（描述、判据）后**零汉字**
 *   （汉字判定用判据给定的 U+3400–U+4DBF ∪ U+4E00–U+9FFF；`【】`(U+3010/3011) 等既有契约括号不在其内）。
 * - 判据 2（zh 不回归 / 契约不变）：第 3 条用例在 zh 下覆盖三组输入（无伪造标记 / 长描述 / 含 directive）
 *   加显式 brief 对照，逐条断言合成文本**逐字等于基线字面式** `执行目标描述中的任务：<描述>`（长描述
 *   含尾部标记，钉住完整承载）、directive/brief 路径不被加前缀、`brief_source` 仍回传原值。整段 prompt
 *   的**逐字节**对照用 out-of-band sha256 实测（修复树 vs 基线 `a8a5530` 的独立构建副本，四组输入全同）：
 *     zh-plain          d97b8b4b46bbf16c6e62218eb708146e2ffef7340c68685affc45a74e108d12a
 *     zh-long           39d877790a64b12cc4800b0cd2574eaefbcca768e81d94bcf0cf5b83f362e3db
 *     zh-directive      627887d7ca8303289f3fb871413e4760d96660d07b5fc262a11b167572694d51
 *     zh-explicit-brief 24da7a677cfa5eadd6afd1a73998dd477a0a088b27d7b20bad3d6ed17ec1eeaa
 *   本文件把「zh 合成文本字面式」钉成断言 ⇒ 任何对 zh 前缀的改动（多一个字、少一个空格）即红。
 * - 判据 3（回归 + 负向对照）：本文件即回归。负向对照已实测：把**本文件原样**放进基线 `a8a5530` 的
 *   独立构建副本运行 ⇒ 3 条用例 **2 红 1 绿**（红的正是「前缀表 en 零汉字 + 调用点透传」与「英文派发
 *   零内置汉字」两条，绿的正是「zh 逐字不回归」条），红绿分布与缺陷面完全吻合。同一副本上的自扫码点：
 *   英文 auto_from_desc 剔除用户材料后**残留 10 个汉字**「执行目标描述中的任务」（修复树同口径 = 0）。
 * - 判据 4（不扩展）：改动面只有一张两语言前缀表 + 调用点透传 `promptLanguage`，无模板引擎、无新配置项、
 *   无截断策略改动、无派发组装重构。
 *
 * ## 豁免清单（为什么这些字符不算「内置中文泄漏」）
 *
 * 1. 用户材料原文（描述 / 判据 / directive）：用户写中文是合理且必须逐字保留的行为；第 2 条用例用
 *    「剔除全部已声明原文后必须零汉字」把它与内置文本严格区分（与 g-390 / g-400 同一口径）。
 * 2. 全角方括号 `【`(U+3010) / `】`(U+3011)：英文侧既有契约括号约定（`*.en.md` 资产沿用），
 *    `HAN` 只判汉字，不判 CJK 标点（且判据已显式豁免）。
 *
 * ## 已知证据边界（如实声明）
 *
 * - 插件 `apply()` 在单进程内只完整生效一次，故本文件共用一个惰性 harness；语言经**可变语言持有者**
 *   + `settings` 服务 locale 命名空间读取（`resolvePromptLanguage` 的首选通道）。
 * - 第 1 条用例读 `dsh-graph-host/index.js` 源码定位前缀表与调用点。定位失败即红（绝不静默放过）；
 *   若未来重命名/重构该表，请同步改这里的锚点。
 * - 真机 / GUI 未验证：本文件只覆盖引擎侧 prompt 组装链路（派发请求由宿主桩捕获）。
 * - 自扫码点（不只看断言）：修复树英文 `auto_from_desc` 剔除用户材料后，剩余非 ASCII 字符只有 U+2014
 *   （em dash）与 `【` / `】`(U+3010/3011，判据已豁免的既有契约括号)，汉字计数 0（剔除后 6266 字符）。
 * - 同族残余（本次**未**处理，已如实上报）：空描述路径的 `fallback` 文案「执行目标描述和质量判据中的
 *   任务」仍是中文（仅 HTTP 非门禁入口可达，g-378 后工具入口拒绝空描述派发）；它**不是**本目标的
 *   `auto_from_desc` 前缀，属另一次收敛，未擅自扩大改动面。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGoal, init, setCriteria, setGoalDirective } from "../ops.ts";
import { apply } from "../../dist/index.js";

/** 汉字判定：判据给定的 U+3400–U+4DBF ∪ U+4E00–U+9FFF（CJK 扩展 A + 统一表意文字主区）。 */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 基线（修复前）的 zh 合成前缀字面式，与本次修复后的 zh 表必须逐字相同。 */
const ZH_PREFIX = "执行目标描述中的任务：";
/** 修复引入的英文前缀（与 g-251 英文来源标注同风格，见 g251 测试里的既有示例句）。 */
const EN_PREFIX = "Execute the task from the goal description: ";

// ============================================================================
// 判据 1/4：信息源——前缀表按语言取表，en 表零汉字、zh 表逐字等于基线
// ============================================================================

/** 从源码切出 `AUTO_FROM_DESC_BRIEF_PREFIX` 表（定位失败即抛，禁止静默放过）。 */
function extractPrefixTable(): { zh: string; en: string } {
  const src = readFileSync(join(REPO_ROOT, "dsh-graph-host", "index.js"), "utf8");
  const start = src.indexOf("const AUTO_FROM_DESC_BRIEF_PREFIX = {");
  assert.notEqual(start, -1, "必须能在 dsh-graph-host/index.js 定位 AUTO_FROM_DESC_BRIEF_PREFIX（锚点失效请同步本测试）");
  const end = src.indexOf("\n};", start);
  assert.notEqual(end, -1, "必须能定位 AUTO_FROM_DESC_BRIEF_PREFIX 表的结尾（锚点失效请同步本测试）");
  const block = src.slice(start, end);
  const literal = (lang: "zh" | "en") => {
    const m = new RegExp(`\\n  ${lang}: "((?:[^"\\\\]|\\\\.)*)"`).exec(block);
    assert.ok(m, `必须能定位 ${lang} 前缀字面量（锚点失效请同步本测试）`);
    return m[1];
  };
  return { zh: literal("zh"), en: literal("en") };
}

test("g-402 判据 1/4：前缀表 en 零汉字、zh 逐字等于基线，且调用点确实透传 promptLanguage", () => {
  const table = extractPrefixTable();

  // 缺陷本体（判据 1）：en 前缀**零汉字**。
  assert.doesNotMatch(table.en, HAN, `en 前缀不得含汉字：「${table.en}」`);
  assert.equal(table.en, EN_PREFIX, "en 前缀须与行为断言预期逐字一致");

  // zh 不回归（判据 2）：zh 前缀与基线**逐字相同**（改一个字符/空格即红）。
  assert.equal(table.zh, ZH_PREFIX, "zh 前缀必须与基线逐字相同（zh 派发产物逐字节不变）");

  // 检查器自证：回退（en 表换回中文串）必然被上面的断言抓住。
  assert.match(ZH_PREFIX, HAN, "自证：HAN 检查器必须能识别回退后的中文前缀（否则本用例形同虚设）");

  // 接线守卫（判据 1/4）：语言必须真的传进合成器；丢掉第 4 参 ⇒ en 前缀不生效（行为用例亦会红）。
  const src = readFileSync(join(REPO_ROOT, "dsh-graph-host", "index.js"), "utf8");
  assert.ok(
    src.includes("resolveEffectiveBrief(attempt_brief, currentDirective, desc, promptLanguage)"),
    "派发组装必须把本次 promptLanguage 传给 resolveEffectiveBrief（锚点失效请同步本测试）",
  );
});

// ============================================================================
// 真实派发捕获 harness（与 g-400 同口径：单进程只 apply 一次，语言经可变持有者）
// ============================================================================

function makeHarness() {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g402-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const captured: any[] = [];
  const registered: any[] = [];
  const webServer = { register: () => () => {} };
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

/** 建一个「有描述、无指令」的目标：干净地落在 auto_from_desc 路径上。 */
function goalWithDescription(h: Harness, title: string, description: string, criteria: string[] = []): string {
  const goal = createGoal(h.root, { title, version: "v-g402", actor: "human:test", description });
  setCriteria(h.root, goal, criteria.length ? criteria : ["criteria body"], "human:test");
  return goal;
}

/** 经**真实** `graph_start_attempt` 派发（不传 brief/directive），返回捕获的最终 prompt。 */
async function startAttempt(h: Harness, goal: string, args: Record<string, unknown> = {}) {
  const before = h.captured.length;
  const tool = h.registered.find((d: any) => d.name === "graph_start_attempt");
  assert.ok(tool, "graph_start_attempt 必须已注册");
  const res = await tool.execute({ goal, worktree: false, task_type: "fix", ...args }, h.exec);
  assert.ok(res?.attempt, "派发必须产生 attempt（准入通过）");
  const request = h.captured[before]?.request;
  assert.ok(request, "必须捕获到恰好一次子代理派发请求");
  return { res, prompt: String(request.prompt?.[0]?.text ?? ""), attempt: String(res.attempt) };
}

// ============================================================================
// 判据 1：英文派发 + auto_from_desc 的真实最终 prompt 剔除用户材料后零汉字
// ============================================================================

test("g-402 判据 1/3：英文派发 auto_from_desc 的最终 prompt 零内置汉字（合成前缀为英文）", async () => {
  const h = harness();
  h.lang.value = "en";

  // 用户材料本身是中文（完全合法且必须逐字保留）⇒ 用它做「剔除后零汉字」的最强对照。
  const desc = "修复英文派发时合成 action 前缀仍是中文的问题，并补一条回归断言（g-402-DESC-MARKER）。";
  const criterion = "英文派发的最终 prompt 在剔除用户材料后不得含汉字（g-402-CRIT-MARKER）。";
  const goal = goalWithDescription(h, "g-402 en auto_from_desc", desc, [criterion]);

  const { res, prompt } = await startAttempt(h, goal);

  // 来源未被本目标改动（判据 2 的契约面）：仍是闭集里的 auto_from_desc。
  assert.equal(res.brief_source, "auto_from_desc", "无 brief/无 directive 时必须仍记 auto_from_desc");
  assert.equal(res.brief, `${EN_PREFIX}${desc}`, "英文路径合成 brief 必须用英文前缀 + 描述全文");

  // 缺陷本体（判据 1）：英文前缀在场、中文前缀缺席（回退修复 ⇒ 第二/三条即红）。
  assert.ok(prompt.includes(EN_PREFIX), `英文派发必须使用英文合成前缀（实际 brief：${res.brief}）`);
  assert.ok(!prompt.includes(ZH_PREFIX), "英文派发的 action 切片不得出现中文合成前缀");
  assert.ok(!prompt.includes("执行目标描述"), "英文派发不得残留任何中文前缀片段");
  assert.match(prompt, /Source: auto_from_desc/, "英文来源标注必须仍在（g-251 成果）");

  // 零汉字（判据 1）：剔除**全部**已声明用户材料后，剩余（= 插件内置文本）零汉字。
  let scrubbed = prompt;
  for (const material of [desc, criterion]) scrubbed = scrubbed.split(material).join("");
  assert.doesNotMatch(scrubbed, HAN, "英文派发剔除用户材料后，插件内置文本不得含任何汉字");
  // 剔除确实生效（防「剔除把整段抹空 ⇒ 断言空转」）。—— 语言无关锚点。
  assert.ok(scrubbed.includes(EN_PREFIX), "剔除用户材料后必须仍保留英文前缀（证明检查面非空）");
});

// ============================================================================
// 判据 2：zh 派发产物的合成文本逐字等于基线（三组输入），g-251 完整承载不回归
// ============================================================================

test("g-402 判据 2：zh 派发合成文本逐字等于基线字面式（无伪造标记 / 长描述 / 含 directive）", async () => {
  const h = harness();
  h.lang.value = "zh";

  // ① 无伪造标记（普通描述）
  const plain = "调整派发组装的中文前缀取值路径，不做其它重构（g-402-ZH-PLAIN）。";
  const plainRes = await startAttempt(h, goalWithDescription(h, "g-402 zh plain", plain));
  assert.equal(plainRes.res.brief_source, "auto_from_desc");
  assert.equal(plainRes.res.brief, `${ZH_PREFIX}${plain}`, "zh 合成 brief 必须逐字等于基线字面式");
  assert.ok(plainRes.prompt.includes(`${ZH_PREFIX}${plain}`), "zh prompt 必须逐字承载基线合成文本");

  // ② 长描述：尾部要求必须在 action 切片内（保留 g-251「不再截到 200 字」成果）
  const tail = "尾部关键要求：必须同时更新 CHANGELOG.md 与 README 的版本表述（g-402-TAIL-MARKER）。";
  const longDesc = `${"前置说明：把尾部要求推出历史 200 字截断边界的中性描述。".repeat(9)}\n\n${tail}`;
  assert.ok(longDesc.indexOf(tail) > 200, `负向对照前提：尾部标记下标(${longDesc.indexOf(tail)})必须 > 200`);
  const longRes = await startAttempt(h, goalWithDescription(h, "g-402 zh long", longDesc));
  assert.equal(longRes.res.brief_source, "auto_from_desc");
  assert.equal(longRes.res.brief, `${ZH_PREFIX}${longDesc}`, "zh 长描述必须全文承载、逐字等于基线字面式");
  assert.ok(longRes.prompt.includes(tail), "尾部关键要求必须在 action 切片内（完整承载不回归）");

  // ③ 含 directive：directive 承接 action，**不得**被加上任何合成前缀
  const directive = "本次只改 host 侧前缀取值，不动核心层（g-402-ZH-DIRECTIVE）。";
  const dirGoal = goalWithDescription(h, "g-402 zh directive", "描述存在，但 directive 优先于描述合成。");
  setGoalDirective(h.root, dirGoal, directive, "human:test");
  const dirRes = await startAttempt(h, dirGoal);
  assert.equal(dirRes.res.brief_source, "directive", "有 directive 时来源必须仍是 directive");
  assert.equal(dirRes.res.brief, directive, "directive 路径不得被加合成前缀（逐字保留）");
  assert.ok(dirRes.prompt.includes(directive), "directive 文本必须逐字落入 prompt");

  // 显式 brief 路径同样不受影响（判据 2 的契约面）
  const brief = "显式 brief：改前缀取值并补回归（g-402-ZH-BRIEF）。";
  const explicitRes = await startAttempt(h, goalWithDescription(h, "g-402 zh brief", "描述存在。"), { attempt_brief: brief });
  assert.equal(explicitRes.res.brief_source, "brief", "显式 brief 的来源必须仍是 brief");
  assert.equal(explicitRes.res.brief, brief, "显式 brief 必须逐字保留、不得被加前缀");
});
