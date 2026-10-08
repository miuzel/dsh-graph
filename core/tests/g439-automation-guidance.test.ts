/**
 * g-439：打通 `supervisor.automation` 消费——六键 → 主管动作**指导**（不新增引擎硬门禁）。
 *
 * 负责人裁决口径（goal.md 评论 14:49 + 最近指令）：
 *  · 消费点 = host 既有「主管纪律注入 section」（`dsh-graph-supervisor-discipline`）：
 *    缓存**配置数据**、按语言渲染成品；六键全 null ⇒ 输出与既有纪律文本**逐字一致**、不新增 section；
 *  · human ⇒「请就此动作请求负责人确认」；ai ⇒「在已授权范围内自主判断并留痕」；null ⇒ 保持既有指导；
 *  · 四类 gate（开始工作 / 审核 / 发布 / 调整版本计划）与六键**不是一一映射**：「开始工作」「审核」
 *    没有对应键，其既有要求原样保留；`scope_planning` ≠ 首次 start 授权、`integration_decision` ≠
 *    review verdict / delivered 授权、`release=ai` 也不能单独放行 delivered；
 *  · 不新增引擎硬门禁 / 审批凭据 / 轮次控制器 / 工具与 API 授权。
 *
 * 覆盖验收 ①–⑧（逐条机器可验）+ 判据 4/5/6（UI 如实、既有守卫不削弱、无新增硬门禁），
 * 并含 4 个**变异负向对照**（改坏即红）：把真实 `dist/index.js` 复制到临时目录后按锚点变异，
 * 用子进程渲染，证明 ① 的逐字一致、② 的 human 确认要求、③ 的缓存失效、④ 的主管身份门禁
 * 各自都**具备判别力**（不是永真断言）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { init, addMemory, readProjectConfig } from "../ops.ts";
import { apply } from "../../dist/index.js";
import { cleanTestEnv } from "./fixtures/nested-runner.ts";

const repoRoot = join(import.meta.dirname, "../..");
const HOST = join(repoRoot, "dsh-graph-host");
const DIST = join(repoRoot, "dist");
const I18N_SRC = join(HOST, "lib", "client", "i18n.js");
const MODAL_SRC = join(HOST, "lib", "client", "settings-modal.js");
const CLIENT_BUNDLE = join(DIST, "lib", "client.js");

const AUTOMATION_KEYS = ["scope_planning", "integration_decision", "rework", "memory_promotion", "skill_proposal", "release"] as const;
const HAN = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

/**
 * g-439 判据 2 的**反向断言口径**：不得声称「引擎会/将/已 + 强制/拒绝/阻断/停轮」——
 * 设置弹窗的 i18n 说明与 `index.js` 注入的指导文本**共用同一 token 口径**（两处都是「主管/用户
 * 会读到的承诺面」，任一处声称引擎强制都违反负责人裁决）。
 * 结构 = `引擎/engine` + **情态助动词** + 最多一小段宾语（`可以将越权动作阻断` 这类不连续改写也要抓）
 * + 强制类动词。**合法否定句不匹配**：zh「不构成引擎强制」与 en "is not engine enforcement" 中，
 * `引擎`/`engine` 之后**没有**情态助动词（`强制`/`enforcement` 不是助动词）⇒ 不误伤；
 * en 侧另加否定守卫，`the engine does not enforce …` 这类**否定式**同样不匹配。
 */
const ENGINE_ENFORCEMENT_ZH = /引擎(?:会|将|已|能|能够|可以|可)[^。；\n]{0,12}(?:强制|拒绝|阻断|停轮|阻止|拦截)/;
const ENGINE_ENFORCEMENT_EN = /engine\s+(?:will|would|shall|should|does|must|can|may)\s+(?:(?!not\b|n['’]t\b)\w+\s+){0,2}(?:enforce|force|refuse|reject|block|halt|stop|prevent|deny|override)/i;

// ---------------------------------------------------------------------------
// 夹具：mock ctx（捕获 section 注册）/ workspace / 渲染
// ---------------------------------------------------------------------------

type Locale = { preference: string };

function makeMockCtx(locale?: Locale) {
  const sections: any[] = [];
  const registered: any[] = [];
  const ctx: any = {
    get: (key: string) => {
      if (key === "systemPrompt") {
        return { section: (s: any) => { sections.push(s); return () => {}; } };
      }
      if (key === "settings" && locale) {
        return { get: (ns: string) => (ns === "locale" ? locale : undefined) };
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (def: any) => { registered.push(def); return () => {}; },
      get: () => ({}),
    },
  };
  return { ctx, sections, registered };
}

/** 建一个 workspace + `<ws>/.dsh-graph/project.yaml`（**不** init：验证渲染路径不需要初始化）。 */
function makeWorkspace(projectYaml: string): string {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g439-"));
  const root = join(ws, ".dsh-graph");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "project.yaml"), projectYaml);
  return ws;
}

function writeProject(ws: string, projectYaml: string): void {
  writeFileSync(join(ws, ".dsh-graph", "project.yaml"), projectYaml);
}

function yamlWith(session: string, automation?: string): string {
  return `supervisor:\n  session: ${session}\n${automation ?? ""}`;
}

type Harness = { section: any; sections: any[]; registered: any[]; locale?: Locale };

function harness(projectYaml: string, locale?: Locale) {
  const ws = makeWorkspace(projectYaml);
  const { ctx, sections, registered } = makeMockCtx(locale);
  apply(ctx, {});
  const section = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
  assert.ok(section, "应注册 dsh-graph-supervisor-discipline section");
  return { ws, section, sections, registered };
}

function renderAt(h: Harness, sessionId: string, ws = h.ws): string {
  return h.section.text({ agent: { session: { id: sessionId, header: { cwd: ws } } } });
}

const disciplineAsset = (lang: "zh" | "en") => readFileSync(join(DIST, "prompts", `discipline.${lang}.md`), "utf8");

/** 取配置键对应的那一行（不存在则返回 ""）。 */
function guidanceLine(out: string, key: string): string {
  return out.split("\n").find((l) => l.startsWith(`- \`${key}\` = `)) ?? "";
}

// ===========================================================================
// 验收①：六键全 null（未配置/畸形/非法）⇒ 注入文本与既有纪律逐字一致，不新增 section
// ===========================================================================

test("g-439 验收①：六键全 null ⇒ 注入文本与既有纪律逐字一致（zh/en 双侧）", () => {
  const h = harness(yamlWith("session-super"));
  assert.equal(renderAt(h, "session-super"), "\n" + disciplineAsset("zh"), "zh：未配置 automation 时逐字一致");
  assert.equal(renderAt(h, "session-super"), "\n" + disciplineAsset("zh"), "重复渲染仍逐字一致（无缓存污染）");

  const en = harness(yamlWith("session-super"), { preference: "en" });
  assert.equal(renderAt(en, "session-super"), "\n" + disciplineAsset("en"), "en：未配置 automation 时逐字一致");

  // 不新增 section：本插件自有 section 仍恰好 3 个，且 discipline 只注册一次
  assert.equal(h.sections.filter((s) => s.name === "dsh-graph-supervisor-discipline").length, 1);
  assert.deepEqual(
    h.sections.map((s) => s.name).sort(),
    ["dsh-graph-guide-hint", "dsh-graph-standing-memory", "dsh-graph-supervisor-discipline"],
    "不新增 section（仍为既有 3 个）",
  );
});

test("g-439 验收①：显式 null / 空 automation / 非法枚举 一律按未配置处理（fail-closed 不产生指导）", () => {
  const baseline = "\n" + disciplineAsset("zh");
  const variants: [string, string][] = [
    ["显式 null", `supervisor:\n  session: session-super\n  automation:\n    release: null\n`],
    ["显式空串", `supervisor:\n  session: session-super\n  automation:\n    release: ""\n`],
    ["非法枚举", `supervisor:\n  session: session-super\n  automation:\n    release: robot\n`],
    ["大小写变体", `supervisor:\n  session: session-super\n  automation:\n    release: HUMAN\n`],
    ["未列出的键", `supervisor:\n  session: session-super\n  automation:\n    unknown_key: human\n`],
  ];
  for (const [label, yaml] of variants) {
    const h = harness(yaml);
    assert.equal(renderAt(h, "session-super"), baseline, `${label} 必须按未配置处理（逐字一致）`);
  }
});

// ===========================================================================
// 验收②：单键/混配只改对应动作文案；不出现串权表述
// ===========================================================================

test("g-439 验收②：单键只改对应动作文案（其余键不出现），且无「允许首次 start / 审核通过 / 自动 delivered」串权表述", () => {
  const h = harness(yamlWith("session-super", "  automation:\n    release: human\n"));
  const out = renderAt(h, "session-super");

  assert.ok(out.includes("⚠️ **自动化动作指导**"), "含指导标题");
  assert.ok(guidanceLine(out, "release").includes("= human"), "release 行按配置渲染");
  assert.ok(guidanceLine(out, "release").includes("请就此动作请求负责人确认"), "human ⇒ 请求负责人确认");
  for (const other of AUTOMATION_KEYS.filter((k) => k !== "release")) {
    assert.equal(guidanceLine(out, other), "", `未配置的 ${other} 不得被渲染成任何指导`);
  }
  // 既有纪律文本仍在（只追加，不改写）
  assert.ok(out.startsWith("\n" + disciplineAsset("zh")), "指导追加在既有纪律文本之后（既有文本逐字保留）");
  // 不得出现串权表述
  assert.doesNotMatch(out, /允许(首次|先行)? ?start|审核通过|自动 ?交付|自动 ?delivered/);
  assert.doesNotMatch(out, /引擎(会|将)(强制|拒绝|阻断|停轮)/, "不声称引擎能强制 LLM 停轮");
  // g-439 P2：同一反向口径的**加宽**版本（含 已/能/可以 + 阻止/拦截），与设置说明侧共用常量
  assert.doesNotMatch(out, ENGINE_ENFORCEMENT_ZH, "不声称引擎会/将/已/能 强制、拒绝、阻断、停轮或拦截");
});

test("g-439 验收②：混配（human + ai）逐键吃自己的语义，互不覆盖；四类 gate 无键者保留独立指导", () => {
  const yaml = yamlWith("session-super",
    "  automation:\n    scope_planning: human\n    integration_decision: ai\n    release: human\n");
  const h = harness(yaml);
  const out = renderAt(h, "session-super");

  const human = "请就此动作请求负责人确认";
  const ai = "在已授权范围内自主判断并留痕";
  const sp = guidanceLine(out, "scope_planning");
  const id = guidanceLine(out, "integration_decision");
  const rl = guidanceLine(out, "release");
  assert.ok(sp.includes(human) && !sp.includes(ai), "scope_planning=human 只吃 human 语义");
  assert.ok(id.includes(ai) && !id.includes(human), "integration_decision=ai 只吃 ai 语义（不被 human 覆盖）");
  assert.ok(rl.includes(human) && !rl.includes(ai), "release=human 只吃 human 语义（不被 ai 覆盖）");
  for (const k of ["rework", "memory_promotion", "skill_proposal"]) {
    assert.equal(guidanceLine(out, k), "", `${k} 未配置 ⇒ 不渲染`);
  }

  // 映射如实：不把 scope_planning/integration_decision 说成首次 start / review verdict 授权
  assert.match(sp, /不是首次 start 授权/);
  assert.match(id, /不是 review verdict \/ delivered 授权/);
  assert.match(rl, /release=ai 也不能单独放行 delivered/);
  // 「开始工作」「审核」没有对应键 ⇒ 其既有要求保留（未被删除/弱化）
  assert.match(out, /「开始工作」与「审核」没有对应键/);
  assert.match(out, /review→delivered 必须等负责人 verdict/);
  assert.doesNotMatch(out, /「开始工作」与「审核」[^。；]{0,20}(免|无需|不再|取消)/, "不得弱化无键 gate");
});

// ===========================================================================
// 验收③：配置更新/删除后缓存失效；六键回 null 恢复旧指导
// ===========================================================================

test("g-439 验收③：配置更新/删除后缓存失效，六键回 null 即恢复既有指导（逐字一致）", () => {
  const ws = makeWorkspace(yamlWith("session-super", "  automation:\n    release: human\n"));
  const { ctx, sections } = makeMockCtx();
  apply(ctx, {});
  const section = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
  const render = () => section.text({ agent: { session: { id: "session-super", header: { cwd: ws } } } });

  const first = render();
  assert.ok(guidanceLine(first, "release").includes("请就此动作请求负责人确认"), "初始配置生效");

  // 更新：human → ai（同一文件，内容长度变化 ⇒ 指纹变化）
  writeProject(ws, yamlWith("session-super", "  automation:\n    release: ai\n"));
  const second = render();
  assert.ok(guidanceLine(second, "release").includes("在已授权范围内自主判断并留痕"), "更新后立即换语义（缓存未冻结）");
  assert.ok(!guidanceLine(second, "release").includes("请就此动作请求负责人确认"), "旧语义不得残留");

  // 删除：整个 automation 段移除 ⇒ 恢复既有指导（逐字一致）
  writeProject(ws, yamlWith("session-super"));
  assert.equal(render(), "\n" + disciplineAsset("zh"), "删除配置后恢复与既有纪律逐字一致的输出");

  // 再加回来（同一 apply 实例）⇒ 仍立即生效
  writeProject(ws, yamlWith("session-super", "  automation:\n    skill_proposal: human\n"));
  assert.ok(guidanceLine(render(), "skill_proposal").includes("请就此动作请求负责人确认"), "重新配置立即生效");
});

// ===========================================================================
// 验收④：两 workspace / 主管身份切换无跨项目缓存污染；普通/执行会话不获指导
// ===========================================================================

test("g-439 验收④：跨 workspace 无缓存污染；普通/执行/无 cwd 会话不获主管指导", () => {
  const wsA = makeWorkspace(yamlWith("session-a", "  automation:\n    release: human\n"));
  const wsB = makeWorkspace(yamlWith("session-b", "  automation:\n    release: ai\n"));
  const { ctx, sections } = makeMockCtx();
  apply(ctx, {});
  const section = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
  const text = (id: string, cwd: string) => section.text({ agent: { session: { id, header: { cwd } } } });

  assert.ok(guidanceLine(text("session-a", wsA), "release").includes("请就此动作请求负责人确认"), "wsA 现任主管拿到自己的配置");
  assert.ok(guidanceLine(text("session-b", wsB), "release").includes("在已授权范围内自主判断并留痕"), "wsB 现任主管拿到自己的配置（无跨项目污染）");
  assert.equal(text("session-b", wsA), "", "非 wsA 主管不得拿到 wsA 的指导");
  assert.equal(text("session-a", wsB), "", "非 wsB 主管不得拿到 wsB 的指导");
  assert.equal(text("session-normal", wsA), "", "普通会话不获主管指导");
  assert.equal(text("session-exec-1", wsA), "", "执行子代理会话不获主管指导");
  assert.equal(section.text({ agent: { session: { id: "session-a" } } }), "", "缺失 cwd 不注入（避免误注入）");
  assert.equal(section.text({}), "", "无 agent 不注入");
  assert.equal(section.text(undefined), "", "undefined context 不注入");

  // 主管身份切换（换人）：旧主管立即失效、新主管立即生效（同一 apply 实例，缓存按文件指纹失效）
  writeProject(wsA, yamlWith("session-c", "  automation:\n    release: human\n"));
  assert.equal(text("session-a", wsA), "", "旧主管身份不得因缓存残留");
  assert.ok(guidanceLine(text("session-c", wsA), "release").includes("请就此动作请求负责人确认"), "新主管立即生效");
});

// ===========================================================================
// 验收⑤：zh / en 切换不冻结语言（缓存数据、渲染成品）
// ===========================================================================

test("g-439 验收⑤：同一 apply 实例内 zh/en 切换立即生效（缓存的是数据，不是成品文本）", () => {
  const ws = makeWorkspace(yamlWith("session-super", "  automation:\n    release: human\n"));
  const locale: Locale = { preference: "zh" };
  const { ctx, sections } = makeMockCtx(locale);
  apply(ctx, {});
  const section = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
  const render = () => section.text({ agent: { session: { id: "session-super", header: { cwd: ws } } } });

  const zh = render();
  assert.ok(zh.includes("⚠️ **自动化动作指导**") && !zh.includes("Automation action guidance"), "zh 首渲染");
  locale.preference = "en";
  const en = render();
  assert.ok(en.includes("⚠️ **Automation action guidance**"), "切 en 后立即英文（不冻结语言）");
  assert.ok(en.includes("request the person in charge's confirmation"), "en 语义在同一份缓存数据上重渲染");
  assert.doesNotMatch(guidanceLine(en, "release"), HAN, "en 指导行不得含 CJK");
  assert.doesNotMatch(en.split("⚠️ **Automation action guidance**")[1], HAN, "en 指导段不得含 CJK");
  locale.preference = "zh";
  assert.equal(render(), zh, "切回 zh 逐字复原");
});

// ===========================================================================
// 验收⑥：defaults.review.reviewer 只展示意图，不改变 policy 或 delivered 批准
// ===========================================================================

test("g-439 验收⑥：reviewer 配置不参与指导、不改变 policy / delivered 批准口径", () => {
  const base = "supervisor:\n  session: session-super\n  automation:\n    release: human\n";
  const h1 = harness(base);
  const without = renderAt(h1, "session-super");

  const h2 = harness(base + "defaults:\n  review:\n    reviewer: reviewer-x\n");
  const withReviewer = renderAt(h2, "session-super");

  assert.equal(withReviewer, without, "reviewer 配置不得改变主管指导文本（指导不消费 reviewer）");
  assert.ok(!withReviewer.includes("reviewer-x"), "reviewer 取值不得出现在注入指导里");

  // 只展示意图：读侧仍如实暴露该配置（意图可见），但 policy 仍为未配置
  const cfg = readProjectConfig(join(h2.ws, ".dsh-graph"));
  assert.equal(cfg.defaults.review.reviewer, "reviewer-x", "读侧如实暴露 reviewer 意图");
  assert.equal(cfg.review.policy, null, "reviewer 配置不改变 review.policy");

  // 指导不得声称能自动放行 delivered
  assert.doesNotMatch(withReviewer, /自动(批准|放行|交付)|自动 ?delivered|automatically approve/i);
  assert.doesNotMatch(withReviewer, /reviewer/, "指导文本不引入 reviewer 语义");
});

// ===========================================================================
// 验收⑦：批量授权 + 禁令优先级（zh/en 同口径）
// ===========================================================================

test("g-439 验收⑦：批量授权与禁令优先级如实注入（zh/en 同口径，Full access 非业务批准）", () => {
  const yaml = yamlWith("session-super", "  automation:\n    release: human\n");
  const zh = renderAt(harness(yaml), "session-super");
  const en = renderAt(harness(yaml, { preference: "en" }), "session-super");

  for (const token of [
    "负责人明确、范围清楚的批量授权可覆盖其**列明动作**的逐项询问",
    "笼统方向授权不构成覆盖",
    "明确禁 push/publish/tag 永远优先",
    "Full access 不是业务批准",
    "绝不被低风险豁免覆盖",
  ]) assert.ok(zh.includes(token), `zh 缺失优先级口径：${token}`);

  for (const token of [
    "clearly scoped batch authorization",
    "vague directional authorization does not",
    "push/publish/tag always takes precedence",
    "Full access is not business approval",
    "never overridden by a low-risk exemption",
  ]) assert.ok(en.includes(token), `en 缺失优先级口径：${token}`);

  // g-439 P2：注入指导（zh/en 双侧）都不得声称引擎强制/停轮（与设置说明共用同一 token 口径）
  assert.doesNotMatch(zh, ENGINE_ENFORCEMENT_ZH, "zh 指导文本不得声称引擎强制/停轮");
  assert.doesNotMatch(en, ENGINE_ENFORCEMENT_EN, "en guidance text must not claim engine enforcement/halt");

  // 不得把 Full access / 批量授权写成可推翻明确禁令的业务批准
  assert.doesNotMatch(zh, /Full access[^。；]{0,16}(可以|可)(批准|放行)/);
  assert.doesNotMatch(zh, /批量授权[^。；]{0,24}(覆盖|推翻|豁免)[^。；]{0,12}(push|publish|tag|禁令)/);
});

// ===========================================================================
// 验收⑧：memory_promotion=ai 不晋升 standing（引擎侧 200 字上限不因指导放宽）
// ===========================================================================

test("g-439 验收⑧：memory_promotion=ai 仍不晋升 standing；引擎侧 standing 200 字铁律不变", () => {
  const h = harness(yamlWith("session-super", "  automation:\n    memory_promotion: ai\n"));
  const out = renderAt(h, "session-super");
  const line = guidanceLine(out, "memory_promotion");
  assert.ok(line.includes("在已授权范围内自主判断并留痕"), "ai 语义注入");
  assert.ok(line.includes("仍默认 on_demand"), "ai 不改变 on_demand 默认");
  assert.ok(line.includes("standing") && line.includes("≤200 字"), "standing 特权与 200 字上限如实保留");
  assert.doesNotMatch(line, /(可|能|允许)晋升|晋升 ?standing/, "不得声称 ai 可晋升 standing");

  // 引擎侧真源未被本指导改变：standing 200 通过 / 201 拒绝，拒绝文案逐字不变
  const root = join(mkdtempSync(join(tmpdir(), "dsh-graph-g439-mem-")), ".dsh-graph");
  init(root);
  addMemory(root, { kind: "project", scope: "standing", text: "S".repeat(200), actor: "agent:g439" });
  assert.throws(
    () => addMemory(root, { kind: "project", scope: "standing", text: "S".repeat(201), actor: "agent:g439" }),
    (e: any) => e?.message === "常驻记忆 (standing) 每条文字硬上限为 200 字符（当前 201 字），请精炼后写入",
    "standing 201 仍按逐字不变的文案拒绝（ai 指导不放宽引擎上限）",
  );
});

// ===========================================================================
// 判据 4：设置弹窗如实说明消费方式，不再一概称「仅存储」
// ===========================================================================

function loadClientI18n(): { zh: Record<string, string>; en: Record<string, string> } {
  const src = readFileSync(I18N_SRC, "utf8");
  const sandbox: any = { React: {} };
  vm.runInNewContext(`${src}\n;this.zh = zh; this.en = en;`, sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

test("g-439 判据4：设置弹窗如实说明「影响主管提示」，去掉「仅存储字段」一概而论标注", () => {
  const { zh, en } = loadClientI18n();
  const modal = readFileSync(MODAL_SRC, "utf8");
  const i18nSrc = readFileSync(I18N_SRC, "utf8");

  // 1) 「仅存储」一概而论标注必须消失（源码侧 + GUI 文案侧）
  assert.doesNotMatch(modal, /仅存储/, "settings-modal.js 不得再出现「仅存储」标注");
  assert.doesNotMatch(i18nSrc, /仅存储/, "client i18n 不得再出现「仅存储」标注");
  assert.doesNotMatch(zh["settings.advanced"], /仅存储|storage-only/, "高级区标题如实");
  assert.doesNotMatch(zh["settings.supervisorAutomation"], /仅存储/, "六键区块标题如实");
  assert.doesNotMatch(en["settings.advanced"], /storage-only/, "en 高级区标题如实");
  assert.doesNotMatch(en["settings.supervisorAutomation"], /storage-only/, "en 六键区块标题如实");

  // 2) 新增如实说明键，zh/en 对称、en 无 CJK
  const hintKey = "settings.automationHint";
  assert.ok(zh[hintKey] && en[hintKey], "zh/en 均存在 settings.automationHint");
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "client i18n 键集必须对称");
  assert.doesNotMatch(en[hintKey], HAN, "en 说明不得含 CJK");
  const zhHint = zh[hintKey];
  for (const token of ["影响主管提示", "human", "负责人确认", "ai", "自主判断并留痕", "未配置保持既有指导", "不改变工具权限", "不构成引擎强制"]) {
    assert.ok(zhHint.includes(token), `zh 说明缺失「${token}」`);
  }
  for (const token of ["Affects the supervisor prompt", "human", "confirmation", "ai", "autonomously", "unset keeps the existing guidance", "changes no tool permission", "not engine enforcement"]) {
    assert.ok(en[hintKey].includes(token), `en 说明缺失「${token}」`);
  }

  // 2b) g-439 P2 反向断言：说明**不得**声称引擎强制/拒绝/停轮（与注入指导共用同一 token 口径）。
  //     ——仅正向 token 不足：只在末尾追加一句「引擎会强制主管停轮并拒绝越权动作。」也能保留全部
  //     被钉 token 而全绿，正是本次复核抓到的守卫缺口。
  assert.doesNotMatch(zhHint, ENGINE_ENFORCEMENT_ZH, "zh 说明不得声称引擎会/将/已/能 强制、拒绝、阻断、停轮或拦截");
  assert.doesNotMatch(en[hintKey], ENGINE_ENFORCEMENT_EN, "en 说明不得声称 engine will/would/does enforce, refuse, reject, block or halt");
  // 合法否定句必须仍然存在（反向断言不得把「不构成引擎强制」也一并误伤/删掉）
  assert.match(zhHint, /不构成引擎强制/, "zh 说明仍如实声明「不构成引擎强制」");
  assert.match(en[hintKey], /not engine enforcement/, "en 说明仍如实声明 is not engine enforcement");
  // 口径自检：这两个正则确实能抓住「声称强制」的改写（不是永真断言），且不误伤合法否定句
  assert.match("引擎会强制主管停轮并拒绝越权动作。", ENGINE_ENFORCEMENT_ZH, "正向样本必须命中（zh）");
  assert.match("引擎可以将越权动作阻断。", ENGINE_ENFORCEMENT_ZH, "正向样本必须命中（zh 变体）");
  assert.doesNotMatch("本指导只影响提示，不改变工具权限，也不构成引擎强制。", ENGINE_ENFORCEMENT_ZH, "合法否定句不得命中（zh）");
  assert.match("The engine will enforce a halt and reject unauthorized actions.", ENGINE_ENFORCEMENT_EN, "正向样本必须命中（en）");
  assert.match("The engine will therefore halt the supervisor.", ENGINE_ENFORCEMENT_EN, "正向样本必须命中（en 含短宾语）");
  assert.doesNotMatch("it changes no tool permission and is not engine enforcement", ENGINE_ENFORCEMENT_EN, "合法否定句不得命中（en）");
  assert.doesNotMatch("the engine does not enforce the gate", ENGINE_ENFORCEMENT_EN, "否定式（does not enforce）不得命中（en）");

  // 3) 说明真的渲染进弹窗（紧随六键网格之后），且仍随高级区开关显示
  const gridIdx = modal.indexOf('["scope_planning", "integration_decision", "rework", "memory_promotion", "skill_proposal", "release"]');
  const hintIdx = modal.indexOf('dgT("settings.automationHint")');
  assert.ok(gridIdx > 0 && hintIdx > gridIdx, "说明必须渲染在六键网格之后");
  assert.match(modal.slice(Math.max(0, hintIdx - 220), hintIdx), /display: showAdvanced \? "block" : "none"/, "说明随高级区开关显示");

  // 4) 已构建的客户端产物同样携带新文案（不是只改了源码）
  const bundle = readFileSync(CLIENT_BUNDLE, "utf8");
  assert.ok(bundle.includes("settings.automationHint"), "dist/lib/client.js 已含新说明键");
  assert.ok(!bundle.includes("仅存储"), "dist/lib/client.js 不得再含「仅存储」");
  assert.match(bundle, /影响主管提示/, "dist bundle 已含如实说明文案");
});

test("g-439 判据4：指南（源码 + dist）如实记录六键 -> 动作指导，zh/en 行数仍相等", () => {
  for (const base of [HOST, DIST]) {
    const zh = readFileSync(join(base, "supervisor-guide.zh.md"), "utf8");
    const en = readFileSync(join(base, "supervisor-guide.en.md"), "utf8");
    assert.equal(zh.split("\n").length, en.split("\n").length, `${base}：指南 zh/en 行数必须仍相等`);
    assert.match(zh, /配置化的动作指导/, `${base}：zh 指南含配置化动作指导`);
    assert.match(en, /Configured action guidance/, `${base}：en 指南含配置化动作指导`);
    assert.ok(zh.includes("`supervisor.automation` 六键"), "zh 指南点名六键来源");
    assert.ok(en.includes("six `supervisor.automation` keys"), "en 指南点名六键来源");
    assert.match(zh, /只影响提示、不构成引擎强制/, "zh 指南如实：只影响提示");
    assert.match(en, /only shapes the prompt, is not engine enforcement/, "en 指南如实：只影响提示");
  }
});

// ===========================================================================
// 判据 6：不新增引擎硬门禁 / 审批凭据 / 轮次控制 / 工具与 API 授权
// ===========================================================================

test("g-439 判据6：不新增工具与 API 授权（工具计数不变），指导文本不声称引擎强制", () => {
  const h = harness(yamlWith("session-super", "  automation:\n    release: human\n"));
  assert.equal(h.registered.length, 51, "graph_* 工具计数不因本目标增加");
  const out = renderAt(h, "session-super");
  assert.ok(out.includes("不构成引擎强制"), "指导如实声明不构成引擎强制");
  assert.ok(out.includes("不改变工具权限"), "指导如实声明不改变工具权限");
  assert.doesNotMatch(out, /轮次控制|审批凭据|凭据校验/);
});

// ===========================================================================
// 变异负向对照：改坏真实 dist/index.js 副本 ⇒ 对应断言必红（证明判别力）
// ===========================================================================

const G439_BLOCK_BEGIN = "// ==== g-439 automation guidance: extractable block begin ====";
const G439_BLOCK_END = "// ==== g-439 automation guidance: extractable block end ====";

const DRIVER = `
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const mod = await import(pathToFileURL(spec.index).href);
const sections = [];
const ctx = {
  get: (k) => (k === "systemPrompt" ? { section: (s) => { sections.push(s); return () => {}; } } : undefined),
  effect: (f) => f(),
  tools: { register: () => () => {}, get: () => ({}) },
};
mod.apply(ctx, {});
const sec = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
mkdirSync(join(spec.ws, ".dsh-graph"), { recursive: true });
const proj = join(spec.ws, ".dsh-graph", "project.yaml");
const outputs = [];
for (const yaml of spec.yamls) {
  writeFileSync(proj, yaml);
  outputs.push(sec.text({ agent: { session: { id: spec.session, header: { cwd: spec.ws } } } }));
}
process.stdout.write(JSON.stringify({ outputs }));
`;

/** 复制真实 dist 到**仓库内 tmp/**（供 `yaml` 等依赖按 Node 解析规则向上找到 node_modules），
 *  按锚点变异 index.js，用子进程渲染。hermetic：真实 dist/**绝不**被写入。 */
function runMutant(mutations: [string, string][], spec: { session: string; yamls: string[] }): string[] {
  const tmpBase = join(repoRoot, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const dir = mkdtempSync(join(tmpBase, "g439-mutant-"));
  try {
    const distCopy = join(dir, "dist");
    cpSync(DIST, distCopy, { recursive: true });
    const index = join(distCopy, "index.js");
    let src = readFileSync(index, "utf8");
    for (const [from, to] of mutations) {
      const hits = src.split(from).length - 1;
      assert.equal(hits, 1, `变异锚点必须唯一存在于 dist/index.js（hits=${hits}）：${from.slice(0, 60)}`);
      src = src.replace(from, to);
    }
    writeFileSync(index, src);
    const ws = join(dir, "ws");
    mkdirSync(ws, { recursive: true });
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, JSON.stringify({ index, ws, session: spec.session, yamls: spec.yamls }));
    const driverPath = join(dir, "driver.mjs");
    writeFileSync(driverPath, DRIVER);
    const out = execFileSync(process.execPath, [driverPath, specPath], {
      encoding: "utf8",
      env: cleanTestEnv(),
      cwd: dir,
    });
    return JSON.parse(out).outputs as string[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("g-439 负向对照（hermetic）：四个变异各自让对应验收断言翻红，真实 dist 一字节未动", () => {
  const index = join(DIST, "index.js");
  const before = readFileSync(index, "utf8");
  const yamlHuman = yamlWith("session-super", "  automation:\n    release: human\n");
  const yamlRework = yamlWith("session-super", "  automation:\n    rework: human\n");
  const yamlNull = yamlWith("session-super");

  // N1：抽掉「无生效键 ⇒ 空串」守卫 ⇒ 全 null 也会输出指导 ⇒ 验收① 的逐字一致断言必红
  const n1 = runMutant(
    [['if (!lines.length) return "";', 'if (!lines.length) return table.header + "\\n" + table.trailer;']],
    { session: "session-super", yamls: [yamlNull] },
  );
  assert.notEqual(n1[0], "", "N1：变异后全 null 也产出指导（证明 ① 的逐字一致断言有判别力）");
  assert.notEqual(n1[0], "\n" + disciplineAsset("zh"));
  assert.ok(n1[0].includes("自动化动作指导"));

  // N2：把 human 子句也换成 ai 子句 ⇒ human 的「请求负责人确认」丢失 ⇒ 验收②/判据2 必红
  const n2 = runMutant(
    [["value === \"human\" ? table.confirm : table.autonomous", "table.autonomous"]],
    { session: "session-super", yamls: [yamlRework] },
  );
  const n2Line = guidanceLine(n2[0], "rework");
  assert.ok(n2Line.includes("= human"), "N2：该行仍标注 human");
  assert.ok(!n2Line.includes("请就此动作请求负责人确认"), "N2：human 的确认要求被抹掉（证明 human 确认断言有判别力）");
  assert.ok(n2Line.includes("在已授权范围内自主判断并留痕"), "N2：被低风险(ai)语义覆盖");

  // N3：把缓存依赖从 project.yaml 抽空 ⇒ 配置删除后仍返回陈旧指导 ⇒ 验收③ 必红
  const n3 = runMutant(
    [['cachedRender(`sup:${canonical.root}`, canonical.root, ["project.yaml"],', 'cachedRender(`sup:${canonical.root}`, canonical.root, [],']],
    { session: "session-super", yamls: [yamlHuman, yamlNull] },
  );
  assert.ok(guidanceLine(n3[1], "release").includes("请就此动作请求负责人确认"), "N3：配置已删除却仍返回陈旧指导（证明 ③ 的缓存失效断言有判别力）");
  assert.notEqual(n3[1], "\n" + disciplineAsset("zh"));

  // N4：去掉主管身份比对 ⇒ 普通/执行会话也拿到主管指导 ⇒ 验收④ 必红
  const n4 = runMutant(
    [['if (!supConfig || !supConfig.supervisorId || supConfig.supervisorId !== sessionId) return "";',
      'if (!supConfig || !supConfig.supervisorId) return "";']],
    { session: "session-intruder", yamls: [yamlHuman] },
  );
  assert.ok(n4[0].includes("⚠️ **自动化动作指导**"), "N4：非主管会话也拿到指导（证明 ④ 的身份门禁断言有判别力）");

  assert.equal(readFileSync(index, "utf8"), before, "变异对照必须 hermetic：真实 dist/index.js 逐字未变");
  assert.ok(existsSync(join(DIST, "prompts", "discipline.zh.md")), "真实 dist 资产仍在");
});

test("g-439：可抽取块自包含（变异锚点齐备），且渲染函数对未配置/非法输入返回空串", () => {
  const src = readFileSync(join(DIST, "index.js"), "utf8");
  const a = src.indexOf(G439_BLOCK_BEGIN);
  const b = src.indexOf(G439_BLOCK_END);
  assert.ok(a > 0 && b > a, "dist/index.js 含 g-439 可抽取块标记");
  const block = src.slice(a, b);
  assert.ok(block.includes("const AUTOMATION_GUIDANCE_KEYS"), "块内含键清单");
  assert.ok(block.includes("function renderAutomationGuidance"), "块内含渲染函数");
  const fn: any = new Function(`${block}\nreturn renderAutomationGuidance;`)();
  for (const bad of [null, undefined, {}, { release: null }, { release: "robot" }, { release: 1 }]) {
    assert.equal(fn(bad, "zh"), "", `未配置/非法输入(${JSON.stringify(bad)}) 必须返回空串`);
    assert.equal(fn(bad, "en"), "", `未配置/非法输入(${JSON.stringify(bad)}) 必须返回空串（en）`);
  }
  // 语言归一：未知语言按 zh（fail-safe，不产出空/半成品）
  assert.ok(fn({ release: "human" }, "fr").includes("自动化动作指导"));
  assert.ok(fn({ release: "human" }, undefined).includes("自动化动作指导"));
});
