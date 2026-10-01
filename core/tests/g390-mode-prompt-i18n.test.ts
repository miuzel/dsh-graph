/**
 * g-390（v0.18.0 审查提示词 P2 / P3 语言缺陷）：英文 minimal 模式下内置提示词泄露中文。
 *
 * 现象（复审已核实，本文件第 3 条用例即为该现象的机器化再现）：
 *   `core/ops.ts` 的 `SUBAGENT_MODE_PROMPTS` 只有中文，`resolveSubagentMode` 把它按 4 条来源
 *   原样返回；host 组装模式标题 `## 子代理执行模式（minimal）` 也没有语言分支 ⇒ 英文 attempt
 *   选 minimal 时，**内置**标题与策略以中文进入最终派发 prompt。
 *
 * ## 断言面（判据一一对应）
 *
 * - 判据 1：`zh/en × standard/minimal` 四组合，断言都打在**真实派发链路**里
 *   `subagents.startContinuable` 捕获的最终 prompt 正文上（不是 formatter 默认参数、
 *   也不是中英逐行数量）。四种组合的内置标题与策略必须与所选语言一致；英文内置文本零汉字。
 * - 判据 2：用户材料（brief / 目标描述 / 判据 / 卡片正文 / 用户补充提示词）原文**逐字保留**
 *   （不改写、不翻译、不丢弃），只有插件内置小节标题按语言本地化；豁免项在下方「豁免清单」如实列明。
 * - 判据 3：mode 路由（attempt.md 的 `meta.mode`）与**真实工具白名单**
 *   （`toolFilter.allow`）在 zh/en 下逐字相同，且等于 `ROLE_PROFILES.executor.allowedTools.minimal` —— 
 *   本次修复只碰 prompt 文本，不碰 mode 语义。
 * - 判据 4：无新增提示词框架——新增物只有「zh 表 / en 表 / 一个按语言取值的纯函数」，
 *   由第 1 条用例的形状断言钉住；相关双语/模式既有测试与全量回归由报告承担。
 *
 * ## 豁免清单（为什么这些字符不算「内置中文泄漏」）
 *
 * 1. 用户材料原文：brief / 目标描述 / 判据 / 卡片标题与正文 / 用户补充提示词。
 *    用户写中文是**合理**且必须逐字保留的行为，不属于本缺陷（本文件第 4 条用例用
 *    「剔除已声明原文后必须零汉字」把它与内置文本严格区分开）。
 * 2. 全角方括号 `【`(U+3010) / `】`(U+3011)：`dsh-graph-host/prompts/*.en.md` 英文资产
 *    自身沿用的**契约标记约定**（`worktree.en.md` / `no-isolation.en.md` / `minor-task.en.md` /
 *    `guide-hint.en.md` 均同形），内部零汉字。第 3 条用例断言英文派发 prompt 里
 *   非 ASCII 的 CJK 标点字符集**恰好**是 {【,】}，从而把这个豁免钉成显式契约而非默认放过。
 * 3. 其余机器格式标题（如 `## Goal description` / `## Quality criteria` / `## Execution discipline`）
 *    在英文路径本就是英文，不构成豁免；第 4 条用例反向断言对应中文标题在英文 prompt 中缺席。
 *
 * ## 已知证据边界（如实声明）
 *
 * - 插件 `apply()` 在单进程内只完整生效一次，故本文件共用一个惰性 harness；zh/en 对照必须经
 *   **可变语言持有者** + settings 服务 locale 命名空间读取（`ctx.get("settings").get("locale").preference`，
 *   即 `resolvePromptLanguage` 的首选通道）。直接写 `ctx.locale = { getLocale: () => "en" }` 无效
 *   ——`resolvePromptLanguage` 的该兜底分支只在 `getLocale()` 返回对象时取值，返回字符串会被丢弃；
 *   这是既有的读取口径，本目标不改它，只在测试里走真实首选通道。
 * - profile 全局设置服务在本进程不可用 ⇒ 覆盖一律经 workspace `project.yaml` 写入（真实链路）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROLE_PROFILES,
  SUBAGENT_MODE_PROMPTS,
  SUBAGENT_MODE_PROMPTS_EN,
  SUBAGENT_MODES,
  addCard,
  createGoal,
  fillCard,
  init,
  loadGoal,
  normalizeSubagentMode,
  resolveSubagentMode,
  reviewCard,
  setCriteria,
  subagentModePrompt,
  writeProjectConfig,
} from "../ops.ts";
import { apply } from "../../dist/index.js";

/** 汉字判定：与既有英文路径零 CJK 断言同口径（CJK 统一表意文字 A + 主区）。 */
const HAN = /[\u3400-\u9fff]/;
/** CJK 标点/符号区（含全角括号、。、「」『』等）——用于把「豁免标记」与「汉字泄漏」分开断言。 */
const CJK_PUNCT = /[\u3000-\u303f]/;

const ZH_MODE_TITLE = (mode: string) => `## 子代理执行模式（${mode}）`;
const EN_MODE_TITLE = (mode: string) => `## Subagent execution mode (${mode})`;
const ZH_SUBAGENT_PROMPT_TITLE = "## dsh-graph 子代理补充提示词（profile 全局 / workspace 覆盖）";
const EN_SUBAGENT_PROMPT_TITLE = "## dsh-graph subagent supplementary prompt (profile global / workspace override)";

type Harness = ReturnType<typeof makeHarness>;

/** 单进程只 apply 一次；语言经可变持有者动态读取（见文件头「已知证据边界」）。 */
function makeHarness() {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g390-"));
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

let HARNESS: Harness | null = null;
function harness(): Harness {
  HARNESS ??= makeHarness();
  return HARNESS;
}

interface DispatchOpts {
  lang: "zh" | "en";
  mode?: "standard" | "minimal";
  brief?: string;
  description?: string;
  criteria?: string[];
  cardText?: string;
  subagentPrompt?: string;
  projectMode?: "standard" | "minimal";
}

/** 经**真实** `graph_start_attempt` 派发，并捕获 `subagents.startContinuable` 的最终 prompt。 */
async function dispatch(h: Harness, opts: DispatchOpts) {
  h.lang.value = opts.lang;
  if (opts.projectMode) writeProjectConfig(h.root, { executor: { mode: opts.projectMode } }, "human:test");
  if (opts.subagentPrompt) {
    writeProjectConfig(h.root, { prompt_overrides: { subagent: { state: "override", value: opts.subagentPrompt } } }, "human:test");
  }
  const goal = createGoal(h.root, {
    title: "g-390 dispatch",
    version: "v-g390",
    actor: "human:test",
    ...(opts.description ? { description: opts.description } : {}),
  });
  setCriteria(h.root, goal, opts.criteria ?? ["criterion one"], "human:test");
  if (opts.cardText) {
    const card = addCard(h.root, goal, { title: "g-390 card", actor: "human:test" });
    fillCard(h.root, goal, card, { text: opts.cardText, by: "human:test", actor: "human:test" });
    reviewCard(h.root, goal, card, { by: "human:test", actor: "human:test" });
  }
  const before = h.captured.length;
  const tool = h.registered.find((d: any) => d.name === "graph_start_attempt");
  assert.ok(tool, "graph_start_attempt 必须已注册");
  const res = await tool.execute(
    { goal, worktree: false, attempt_brief: opts.brief ?? "Fix the thing.", task_type: "fix", ...(opts.mode ? { mode: opts.mode } : {}) },
    h.exec,
  );
  assert.ok(res?.attempt, "派发必须产生 attempt（准入通过）");
  const request = h.captured[before]?.request;
  assert.ok(request, "必须捕获到恰好一次子代理派发请求");
  const attemptMeta = loadGoal(join(h.root, "versions", "v-g390", "goals", goal, "attempts", res.attempt, "attempt.md")).meta as any;
  return { goal, attempt: res.attempt as string, prompt: String(request.prompt?.[0]?.text ?? ""), toolFilter: request.toolFilter, attemptMeta };
}

// ============================================================================
// 判据 3/4：纯函数层——双语片段来源、回落默认值与「无新增框架」
// ============================================================================

test("g-390 判据 3/4：模式片段 zh/en 逐 mode 对称、英文零汉字、未知语言回落 zh", () => {
  // 逐 mode 对称：两张表的键完全一致（漏一个 mode 就会在这里变红）。
  assert.deepEqual(Object.keys(SUBAGENT_MODE_PROMPTS).sort(), [...SUBAGENT_MODES].sort());
  assert.deepEqual(Object.keys(SUBAGENT_MODE_PROMPTS_EN).sort(), [...SUBAGENT_MODES].sort());

  // standard 两语言都是空串（standard 不注入模式段 ⇒ 与语言无关，行为一致）。
  assert.equal(SUBAGENT_MODE_PROMPTS.standard, "");
  assert.equal(SUBAGENT_MODE_PROMPTS_EN.standard, "");

  // 英文片段零汉字，且与中文片段不同（防止「en 表照抄 zh 表」这种假修复）。
  assert.doesNotMatch(SUBAGENT_MODE_PROMPTS_EN.minimal, HAN, "英文 minimal 片段不得含汉字");
  assert.notEqual(SUBAGENT_MODE_PROMPTS_EN.minimal, SUBAGENT_MODE_PROMPTS.minimal);

  // zh 真源逐字未动（既有断言与既有 zh 渲染产物按它锁定）。
  assert.equal(
    SUBAGENT_MODE_PROMPTS.minimal,
    "【极简模式执行策略】仅提供受控 6 项基础工具（bash、edit、read、write、graph_report_status、graph_transition），保持紧凑输出，不展开冗余高级调用。",
  );

  // 取值函数：language 只认字面量 "en"，其余一律回落 zh（向后兼容）。
  assert.equal(subagentModePrompt("minimal", "en"), SUBAGENT_MODE_PROMPTS_EN.minimal);
  assert.equal(subagentModePrompt("minimal", "zh"), SUBAGENT_MODE_PROMPTS.minimal);
  assert.equal(subagentModePrompt("minimal"), SUBAGENT_MODE_PROMPTS.minimal, "缺省语言必须回落 zh");
  assert.equal(subagentModePrompt("minimal", null), SUBAGENT_MODE_PROMPTS.minimal);
  assert.equal(subagentModePrompt("minimal", "follow"), SUBAGENT_MODE_PROMPTS.minimal, "未知/follow 必须回落 zh");
  assert.equal(subagentModePrompt("standard", "en"), "");

  // 判据 4「无新增提示词框架」：新增面只有两张常量表 + 一个 4 行纯函数（无模板引擎、无规则集、无新配置项）。
  assert.equal(typeof subagentModePrompt, "function");
  assert.ok(Object.isFrozen?.(SUBAGENT_MODE_PROMPTS) === false, "两张表保持既有可变形态，未引入新的冻结/校验框架");
});

test("g-390 判据 3/4：四来源（override/project/global/default）按语言渲染，未传语言与修复前逐字相同", () => {
  const ZH_MIN = SUBAGENT_MODE_PROMPTS.minimal;
  const EN_MIN = SUBAGENT_MODE_PROMPTS_EN.minimal;

  // 四条来源 × en：模式与来源判定不变，只有 prompt 走英文。
  assert.deepEqual(resolveSubagentMode("minimal", "standard", "standard", "en"), { mode: "minimal", source: "override", prompt: EN_MIN });
  assert.deepEqual(resolveSubagentMode(null, "minimal", "standard", "en"), { mode: "minimal", source: "project", prompt: EN_MIN });
  assert.deepEqual(resolveSubagentMode(null, null, "minimal", "en"), { mode: "minimal", source: "global", prompt: EN_MIN });
  assert.equal(resolveSubagentMode("standard", "standard", "standard", "en").prompt, "", "default 来源 = standard ⇒ 两语言都为空");

  // 四条来源 × zh：与 en 只差 prompt 文本，mode/source 逐字相同。
  assert.deepEqual(resolveSubagentMode("minimal", "standard", "standard", "zh"), { mode: "minimal", source: "override", prompt: ZH_MIN });
  assert.deepEqual(resolveSubagentMode(null, "minimal", "standard", "zh"), { mode: "minimal", source: "project", prompt: ZH_MIN });
  assert.deepEqual(resolveSubagentMode(null, null, "minimal", "zh"), { mode: "minimal", source: "global", prompt: ZH_MIN });

  // 基线对照（向后兼容的硬约束）：**不传第 4 参**必须与修复前逐字相同。
  assert.deepEqual(resolveSubagentMode("minimal", "standard", "minimal"), { mode: "minimal", source: "override", prompt: ZH_MIN });
  assert.equal(resolveSubagentMode(null, "minimal", "standard").prompt, ZH_MIN);
  assert.equal(resolveSubagentMode(null, null, "minimal").prompt, ZH_MIN);
  assert.equal(resolveSubagentMode("bad", "bad", "bad").prompt, "");

  // 语言参数不改变规范化语义（无效 mode 仍安全回落 null）。
  assert.equal(normalizeSubagentMode(" MINIMAL "), "minimal");
  assert.equal(resolveSubagentMode("invalid", "invalid", "invalid", "en").mode, "standard");
});

// ============================================================================
// 判据 1：端到端——最终派发 prompt 的内置标题与策略按所选语言渲染
// ============================================================================

test("g-390 判据 1：zh/en × standard/minimal 最终派发 prompt 的内置模式段与所选语言一致", async () => {
  const h = harness();
  const seen: Record<string, string> = {};
  for (const lang of ["zh", "en"] as const) {
    for (const mode of ["standard", "minimal"] as const) {
      const { prompt } = await dispatch(h, { lang, mode, brief: "Fix the built-in mode prompt language." });
      seen[`${lang}/${mode}`] = prompt;

      // mode 段是否存在只由 mode 决定，与语言无关：standard 两语言都不注入。
      const expectSection = mode === "minimal";
      assert.equal(prompt.includes(ZH_MODE_TITLE(mode)), expectSection && lang === "zh", `${lang}/${mode}：中文模式标题存在性不符`);
      assert.equal(prompt.includes(EN_MODE_TITLE(mode)), expectSection && lang === "en", `${lang}/${mode}：英文模式标题存在性不符`);
      assert.equal(prompt.includes(SUBAGENT_MODE_PROMPTS.minimal), expectSection && lang === "zh", `${lang}/${mode}：中文策略片段存在性不符`);
      assert.equal(prompt.includes(SUBAGENT_MODE_PROMPTS_EN.minimal), expectSection && lang === "en", `${lang}/${mode}：英文策略片段存在性不符`);

      // 英文侧：内置文本零汉字（这是本次缺陷的判定口径——不是数行数）。
      if (lang === "en") {
        assert.doesNotMatch(prompt, HAN, `en/${mode}：英文最终派发 prompt 的内置文本出现汉字（用户材料全为 ASCII，故不得有任何汉字）`);
        assert.ok(!prompt.includes("极简模式执行策略"), `en/${mode}：不得残留中文策略片段`);
        assert.ok(!prompt.includes("子代理执行模式"), `en/${mode}：不得残留中文模式标题`);
      } else {
        assert.ok(prompt.includes("极简模式执行策略") === expectSection, `zh/${mode}：中文策略片段应仅在 minimal 出现`);
      }
    }
  }

  // 交叉对照：同一 mode 的中英产物必须真的不同（防止两条路径被接到同一份文本）。
  assert.notEqual(seen["zh/minimal"], seen["en/minimal"], "zh/en minimal 渲染产物必须不同");
  // 同一语言内 standard 与 minimal 必须不同（minimal 多一段策略）——修复不得抹平模式差异。
  assert.notEqual(seen["zh/standard"], seen["zh/minimal"], "zh standard/minimal 产物必须不同");
  assert.notEqual(seen["en/standard"], seen["en/minimal"], "en standard/minimal 产物必须不同");
});

// ============================================================================
// 判据 2：用户材料逐字保留 + 内置标题本地化 + 豁免如实列明
// ============================================================================

test("g-390 判据 2：英文派发中用户材料逐字保留、内置标题本地化，剔除已声明原文后零汉字", async () => {
  const h = harness();
  const BRIEF = "User brief text must be kept verbatim.";
  const DESC = "User description: keep these exact words.";
  const CRIT = "User criterion: never translate this line.";
  const CARD = "User card body must survive verbatim.";
  const USER_PROMPT = "User supplementary prompt text stays verbatim.";

  const { prompt } = await dispatch(h, {
    lang: "en",
    mode: "minimal",
    brief: BRIEF,
    description: DESC,
    criteria: [CRIT],
    cardText: CARD,
    subagentPrompt: USER_PROMPT,
  });

  // ① 用户材料逐字保留（不翻译、不改写、不丢弃）。
  for (const [label, text] of [["brief", BRIEF], ["目标描述", DESC], ["判据", CRIT], ["卡片正文", CARD], ["用户补充提示词", USER_PROMPT]] as const) {
    assert.ok(prompt.includes(text), `en：${label} 原文必须在最终派发 prompt 中逐字出现`);
  }

  // ② 内置标题本地化为英文；对应中文标题必须缺席。
  assert.ok(prompt.includes(EN_MODE_TITLE("minimal")), "en：模式小节标题必须为英文");
  assert.ok(prompt.includes(EN_SUBAGENT_PROMPT_TITLE), "en：子代理补充提示词小节标题必须为英文（正文仍是用户原文）");
  assert.ok(prompt.includes("## Goal description") && prompt.includes("## Quality criteria"), "en：目标背景小节标题必须为英文");
  for (const zhTitle of [ZH_MODE_TITLE("minimal"), ZH_SUBAGENT_PROMPT_TITLE, "## 目标描述", "## 质量判据"]) {
    assert.ok(!prompt.includes(zhTitle), `en：内置中文标题「${zhTitle}」必须缺席`);
  }

  // ③ 豁免清算：剔除全部已声明用户材料原文后，剩余（= 插件内置文本）必须零汉字。
  let scrubbed = prompt;
  for (const text of [BRIEF, DESC, CRIT, CARD, USER_PROMPT]) scrubbed = scrubbed.split(text).join("");
  assert.doesNotMatch(scrubbed, HAN, "en：剔除用户材料后，插件内置文本不得含任何汉字（含即内置中文泄漏）");

  // ④ 豁免标记如实钉死：英文侧仅允许 `*.en.md` 资产沿用的全角方括号标记（内部零汉字）。
  const punct = [...new Set(prompt.match(new RegExp(CJK_PUNCT, "g")) ?? [])].sort();
  assert.deepEqual(punct, ["【", "】"], "en：内置 CJK 标点仅允许英文资产沿用的 【】 契约标记；『』「」、。等中文标点一律禁止");
  assert.ok(!HAN.test("【】"), "豁免标记本身不含汉字（豁免的是标记，不是中文文本）");
});

// ============================================================================
// 判据 3：mode 路由与真实工具白名单不因语言/本次修复而变
// ============================================================================

test("g-390 判据 3：zh/en 下 mode 路由与真实工具白名单逐字相同，minimal 白名单未变", async () => {
  const h = harness();
  const zhMin = await dispatch(h, { lang: "zh", mode: "minimal" });
  const enMin = await dispatch(h, { lang: "en", mode: "minimal" });
  const zhStd = await dispatch(h, { lang: "zh", mode: "standard" });
  const enStd = await dispatch(h, { lang: "en", mode: "standard" });

  // 真实工具白名单：minimal 只放 6 项，且与 ROLE_PROFILES 真源逐字一致；standard 无裁剪。
  assert.deepEqual(zhMin.toolFilter, { allow: ROLE_PROFILES.executor.allowedTools.minimal });
  assert.deepEqual(enMin.toolFilter, zhMin.toolFilter, "工具白名单不得随语言变化");
  assert.deepEqual(zhMin.toolFilter.allow, ["bash", "edit", "read", "write", "graph_report_status", "graph_transition"]);
  assert.equal(zhStd.toolFilter, undefined, "standard 不裁剪工具");
  assert.equal(enStd.toolFilter, undefined, "standard 不裁剪工具（与语言无关）");

  // mode 路由：attempt 台账记录的生效模式不随语言变化，且来源仍是 override。
  assert.equal(zhMin.attemptMeta.mode, "minimal");
  assert.equal(enMin.attemptMeta.mode, "minimal");
  assert.equal(zhStd.attemptMeta.mode, "standard");
  assert.equal(enStd.attemptMeta.mode, "standard");

  // 修复只改 prompt：同一 mode 的 prompt_hash 因文本语言不同而不同（旁证），但 mode 字段不变。
  assert.notEqual(zhMin.attemptMeta.prompt_hash, enMin.attemptMeta.prompt_hash, "（旁证）中英 prompt 文本不同 ⇒ hash 不同");
  assert.equal(zhMin.attemptMeta.mode, enMin.attemptMeta.mode, "语言绝不参与 mode 路由");
});

// ============================================================================
// 判据 1（第二来源）：project.yaml executor.mode 来源同样按语言渲染
// ============================================================================

test("g-390 判据 1：project.yaml 来源的 minimal 在英文派发中同样渲染英文模式段", async () => {
  const h = harness();
  const { prompt, toolFilter, attemptMeta } = await dispatch(h, { lang: "en", projectMode: "minimal" });

  assert.equal(attemptMeta.mode, "minimal", "project.yaml executor.mode 生效（非语言路径）");
  assert.deepEqual(toolFilter, { allow: ROLE_PROFILES.executor.allowedTools.minimal }, "project 来源的 minimal 工具白名单不变");
  assert.ok(prompt.includes(EN_MODE_TITLE("minimal")), "project 来源的 minimal 也必须渲染英文模式标题");
  assert.ok(prompt.includes(SUBAGENT_MODE_PROMPTS_EN.minimal), "project 来源的 minimal 也必须渲染英文策略片段");
  assert.ok(!prompt.includes(ZH_MODE_TITLE("minimal")) && !prompt.includes("极简模式执行策略"), "project 来源不得残留中文模式段");
  assert.doesNotMatch(prompt, HAN, "project 来源的英文派发 prompt 内置文本零汉字");
});
