/**
 * g-440：Agent Teams 最小契约（单 attempt 内扇出 + 独立验证者）——机器断言。
 *
 * 负责人 2026-10-08 裁决的本版范围（**最小契约**）：契约文本 + 留痕要求 + 结构守卫 + 默认 off 的开关。
 * 明确**不做**：新调度器 / 一目标多活跃 attempt / 新强制门禁 / 第三方 Agent Teams 插件 /
 * 把扇出成员当 attempt 或 worktree。
 *
 * 覆盖 6 条验收项：
 *  1. 契约文本落地：`supervisor-guide.{zh,en}.md` + `prompts/discipline.{zh,en}.md` 双语对称
 *     （总行数与非空行数各自相等、docs 镜像同步），关键句齐备；**负向对照**：删改任一关键句
 *     ⇒ 同一判定谓词必红（证明确实由断言承载，不是摆设）。
 *  2. 留痕复用 g-436 真源 `<goalDir>/reviews/<review_id>.md`，`self_requested` **不算**独立验证；
 *     结论词表与 g-436 统一为 PASS / BLOCK / UNVERIFIED（**不含 FAIL**）。
 *  3. 结构守卫 fail-closed：缺留痕 / self_requested 冒充独立 / 作者自报顶替独立 / 结论越界或
 *     不一致 / 放弃计入 PASS ⇒ 判红并给红因；**反向边界**（如实标注 self_requested/author 的
 *     合法留痕、未启用时无该小节）**不误红**；**负向对照**：从可抽取块里删掉任一红因的判定语句
 *     ⇒ 该红因不再产出（证明每条检查都是承重的）。
 *  4. 开关：`settingsPostSchema` 白名单 + GUI 复选框（vm 里跑真实客户端源码渲染）+ 双语文案 +
 *     **默认 off**；**双态注入断言**：off（未配置 / false / null）派发提示词三态逐字节相等且不含
 *     契约文本（diff=0），on 才注入契约段，且 `on === off + "\n\n" + 契约段`（纯追加）。
 *  5. 降级矩阵逐行钉死（未勾选 / 契约缺失 / 宿主不支持 / 深度 < 2 / 未知 ⇒ 各自的确定性行为）。
 *  6. 零回归：本文件由 `node scripts/run-tests.mjs` 自证闸门与 `tsc --noEmit` 一并通过。
 *
 * 断言方式：契约/守卫/注入决策走**真实实现**（core 导出）；派发链路走**真实 `graph_start_attempt`**
 * （apply(ctx) + 捕获 `subagents.startContinuable` 的 request.prompt）；GUI 走 **vm 里求值的真实
 * `settings-modal.js` 源码**（渲染树断言，不用源码字符串匹配替代行为断言；仅「复选框存在且绑定
 * agent_teams」这类结构性事实用源码锚点，与 g-442 同口径）。
 *
 * harness（`loadClientHelpers` / `renderSettingsModal` / `h` / `walk`）沿用
 * `core/tests/g442-settings-review-conditions.test.ts` 的既有形态，避免另立第二套客户端夹具。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import vm from "node:vm";

import {
  AGENT_TEAMS_CONTRACT_BEGIN,
  AGENT_TEAMS_CONTRACT_END,
  FANOUT_GUARD_BLOCK_BEGIN,
  FANOUT_GUARD_BLOCK_END,
  appendReviewDispatch,
  auditFanoutIndependentVerification,
  bindReviewChild,
  composeSubagentPrompt,
  createGoal,
  extractAgentTeamsContract,
  fanoutIndependentVerificationProblems,
  findGoalFile,
  init,
  readAttemptResultsTexts,
  readProjectConfig,
  resolveAgentTeamsInjection,
  setCriteria,
  settleReview,
  writeProjectConfig,
  type FanoutReviewRecord,
} from "../ops.ts";
import { apply } from "../../dist/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const clientDir = join(repoRoot, "dsh-graph-host/lib/client");
const sourceDiscipline = (lang: "zh" | "en") => readFileSync(join(repoRoot, "dsh-graph-host/prompts", `discipline.${lang}.md`), "utf8");
const distDiscipline = (lang: "zh" | "en") => readFileSync(join(repoRoot, "dist/prompts", `discipline.${lang}.md`), "utf8");
const sourceGuide = (lang: "zh" | "en") => readFileSync(join(repoRoot, "dsh-graph-host", `supervisor-guide.${lang}.md`), "utf8");
const sourceOps = () => readFileSync(join(repoRoot, "core/ops.ts"), "utf8");
const sourceModal = () => readFileSync(join(clientDir, "settings-modal.js"), "utf8");
const sourceI18n = () => readFileSync(join(clientDir, "i18n.js"), "utf8");
const readDocsMirror = () => readFileSync(join(repoRoot, "docs/guide-auto-injection.md"), "utf8");

const lines = (t: string) => t.replace(/\n$/, "").split("\n");
const CJK = /[\u3400-\u9fff]/;

// =====================================================================================
// 判据 1：契约文本（双语对称 + 关键句 + 删改必红的负向对照）
// =====================================================================================

/** 承重关键句（zh）——逐条对应验收项 1/2 的语义要求，缺任一条即视为契约不成立。 */
const KEYS_ZH = [
  "扇出成员不是 attempt",
  "不分配 attempt ID",
  "不留悬挂成员",
  "作者自报不得冒充独立验证",
  "一律不算独立验证",
  "`self_requested`",
  "`PASS` / `BLOCK` / `UNVERIFIED`",
  "`## 扇出与独立验证`",
  "`<goalDir>/reviews/<review_id>.md`",
  "不得计入 PASS",
  "静默降级",
];
/** 承重关键句（en）：与 zh 语义一一对应（不要求逐字互译，但每条都必须真实存在）。 */
const KEYS_EN = [
  "Fan-out members are not attempts",
  "no attempt ID",
  "no dangling member",
  "an author's self-report must not masquerade as independent verification",
  "never count as independent verification",
  "`self_requested`",
  "`PASS` / `BLOCK` / `UNVERIFIED`",
  "`## Fan-out and independent verification`",
  "`<goalDir>/reviews/<review_id>.md`",
  "never count it as PASS",
  "silently degrade",
];

/** 契约成立谓词（测试用；负向对照直接改坏这一谓词的输入即红）。 */
function contractPasses(assetText: string, lang: "zh" | "en", keys: string[]): boolean {
  const block = extractAgentTeamsContract(assetText);
  if (!block) return false;
  return keys.every((k) => block.includes(k));
}

test("g-440 判据 1：契约块在 disciplines 双语里都真实存在且关键句齐备（交付资产 ≠ 摆设）", () => {
  for (const lang of ["zh", "en"] as const) {
    const text = sourceDiscipline(lang);
    const keys = lang === "zh" ? KEYS_ZH : KEYS_EN;
    const block = extractAgentTeamsContract(text);
    assert.ok(block, `${lang} discipline 必须含定界契约块`);
    for (const k of keys) assert.ok(block.includes(k), `${lang} 契约块缺关键句：${k}`);
    // 生产注入读的是 dist 资产：逐字节等于源（否则注入的是过期文本）。
    assert.equal(distDiscipline(lang), text, `dist/prompts/discipline.${lang}.md 必须与源逐字节一致`);
    // 结论词表与 g-436 统一（**闭集**）：三值都在场。
    for (const c of ["PASS", "BLOCK", "UNVERIFIED"]) assert.ok(block.includes(c), `${lang} 契约块必须点名结论词 ${c}`);
  }
  assert.ok(contractPasses(sourceDiscipline("zh"), "zh", KEYS_ZH), "谓词对真实 zh 资产必须为真");
  assert.ok(contractPasses(sourceDiscipline("en"), "en", KEYS_EN), "谓词对真实 en 资产必须为真");
});

test("g-440 判据 1（负向对照）：删改任一关键句 / 摘掉定界标记 ⇒ 同一谓词必红", () => {
  const zh = sourceDiscipline("zh");
  const en = sourceDiscipline("en");
  // ① 逐条删除关键句 ⇒ 谓词转假（证明每条断言都承重，删改契约即红）。
  for (const k of KEYS_ZH) {
    const mutated = zh.replace(k, "");
    assert.notEqual(mutated, zh, `注入点必须真实存在：${k}`);
    assert.equal(contractPasses(mutated, "zh", KEYS_ZH), false, `删掉「${k}」后谓词必须转假`);
  }
  for (const k of KEYS_EN) {
    const mutated = en.replace(k, "");
    assert.notEqual(mutated, en, `注入点必须真实存在：${k}`);
    assert.equal(contractPasses(mutated, "en", KEYS_EN), false, `删掉「${k}」后谓词必须转假`);
  }
  // ② 摘掉定界标记 / 清空块 ⇒ 抽取 fail-safe 返回 null（不注入、不报错、不编造契约）。
  assert.equal(extractAgentTeamsContract(zh.replace(AGENT_TEAMS_CONTRACT_BEGIN, "")), null, "缺 begin 标记 ⇒ null");
  assert.equal(extractAgentTeamsContract(zh.replace(AGENT_TEAMS_CONTRACT_END, "")), null, "缺 end 标记 ⇒ null");
  assert.equal(
    extractAgentTeamsContract(`${AGENT_TEAMS_CONTRACT_BEGIN}\n\n   \n${AGENT_TEAMS_CONTRACT_END}`),
    null,
    "空块 ⇒ null（fail-safe：不注入）",
  );
  assert.equal(extractAgentTeamsContract(""), null, "无资产文本 ⇒ null（宿主缺资产时诚实降级）");
});

test("g-440 判据 1：双语对称（guide/discipline 行数与 docs 镜像）+ 两份文档都写明契约", () => {
  for (const name of ["supervisor-guide", "prompts/discipline"]) {
    const zh = lines(readFileSync(join(repoRoot, "dsh-graph-host", `${name}.zh.md`), "utf8"));
    const en = lines(readFileSync(join(repoRoot, "dsh-graph-host", `${name}.en.md`), "utf8"));
    assert.equal(zh.length, en.length, `${name}：zh/en 总行数必须相等`);
    assert.equal(
      zh.filter((l) => l.trim() !== "").length,
      en.filter((l) => l.trim() !== "").length,
      `${name}：zh/en 非空行数必须相等`,
    );
  }
  // guide 双侧都写明同一条契约（含「不是 attempt」「作者自报不得冒充独立验证」两处语义）。
  assert.match(sourceGuide("zh"), /Agent Teams 最小契约/);
  assert.match(sourceGuide("en"), /Agent Teams minimal contract/);
  for (const [text, needles] of [
    [sourceGuide("zh"), ["扇出成员不是 attempt", "作者自报不得冒充独立验证", "`self_requested`", "`PASS` / `BLOCK` / `UNVERIFIED`", "默认 off"]],
    [sourceGuide("en"), ["Fan-out members are not attempts", "author's self-report must not masquerade", "`self_requested`", "`PASS` / `BLOCK` / `UNVERIFIED`", "off by default"]],
  ] as const) {
    for (const n of needles) assert.ok(text.includes(n), `guide 缺契约语义：${n}`);
  }
  // docs 镜像（g-312 的 SUPERVISOR_DISCIPLINE 副本）必须把契约块整段同步（否则文档漂移）。
  const mirror = readDocsMirror();
  for (const l of lines(sourceDiscipline("zh"))) {
    if (l.trim() === "") continue;
    assert.ok(mirror.includes(`"${l}"`), `docs 镜像缺纪律行：${l.slice(0, 40)}…`);
  }
});

// =====================================================================================
// 判据 2/3：留痕真源 + fail-closed 结构守卫（含反向边界与变异负向对照）
// =====================================================================================

const SECTION_ZH = "## 扇出与独立验证";
const SECTION_EN = "## Fan-out and independent verification";

const rec = (o: Partial<FanoutReviewRecord> = {}): FanoutReviewRecord => ({
  review_id: "rev-att-001-01",
  independent: true,
  self_requested: false,
  reviewer_child_id: "child-reviewer",
  author_child_id: "child-author",
  conclusion: "PASS",
  status: "completed",
  ...o,
});

const codes = (text: string, records: FanoutReviewRecord[]): string[] =>
  fanoutIndependentVerificationProblems(text, records).map((p) => p.code);

const trace = (verifyLine: string, extra = ""): string =>
  `${SECTION_ZH}\n- member: name=m1 scope=parser status=done conclusion=PASS evidence='ok'\n${verifyLine}${extra ? "\n" + extra : ""}`;

test("g-440 判据 3：守卫 fail-closed——每条红因都能被真实造假留痕触发并给出红因", () => {
  const cases: Array<{ name: string; text: string; records: FanoutReviewRecord[]; code: string }> = [
    {
      name: "声称独立验证但无留痕记录",
      text: trace("- verify: review=rev-att-001-99 scope=parser conclusion=PASS source=independent"),
      records: [rec()],
      code: "missing_review_record",
    },
    {
      name: "verify 行没写 review 引用",
      text: trace("- verify: scope=parser conclusion=PASS source=independent"),
      records: [rec()],
      code: "missing_review_record",
    },
    {
      name: "verify 行缺 source（无法判定独立性）",
      text: trace("- verify: review=rev-att-001-01 scope=parser conclusion=PASS"),
      records: [rec()],
      code: "missing_source",
    },
    {
      name: "source 越界",
      text: trace("- verify: review=rev-att-001-01 scope=parser conclusion=PASS source=author_self"),
      records: [rec()],
      code: "invalid_source",
    },
    {
      name: "self_requested（作者自派）冒充独立",
      text: trace("- verify: review=rev-att-001-01 scope=parser conclusion=PASS source=independent"),
      records: [rec({ self_requested: true, independent: false })],
      code: "self_requested_claimed_independent",
    },
    {
      name: "作者自己的 child 顶替独立验证",
      text: trace("- verify: review=rev-att-001-01 scope=parser conclusion=PASS source=independent"),
      records: [rec({ reviewer_child_id: "child-author", author_child_id: "child-author", independent: false })],
      code: "author_self_report_claimed_independent",
    },
    {
      name: "留痕记录不构成可审计独立评审",
      text: trace("- verify: review=rev-att-001-01 scope=parser conclusion=PASS source=independent"),
      records: [rec({ independent: false, reviewer_child_id: null })],
      code: "record_not_independent",
    },
    {
      name: "留痕评审未完成却计入",
      text: trace("- verify: review=rev-att-001-01 scope=parser conclusion=PASS source=independent"),
      records: [rec({ status: "failed" })],
      code: "review_not_completed",
    },
    {
      name: "声明结论与留痕不一致",
      text: trace("- verify: review=rev-att-001-01 scope=parser conclusion=PASS source=independent"),
      records: [rec({ conclusion: "BLOCK" })],
      code: "conclusion_mismatch",
    },
    {
      name: "结论词越界（FAIL 不在闭集）",
      text: trace("- verify: review=rev-att-001-01 scope=parser conclusion=FAIL source=independent"),
      records: [rec()],
      code: "invalid_conclusion",
    },
    {
      name: "已放弃成员计入 PASS",
      text: trace("- verify: review=rev-att-001-01 scope=parser conclusion=PASS source=independent", "- member: name=m2 scope=lexer status=timeout conclusion=PASS evidence='x'"),
      records: [rec()],
      code: "abandoned_counted_as_pass",
    },
    {
      name: "有独立验证声明却给不出可解析 verify 行（fail-closed）",
      text: `${SECTION_ZH}\n根据成员独立验证：结论 PASS。`,
      records: [rec()],
      code: "unparsable_independent_claim",
    },
  ];
  for (const c of cases) {
    const got = codes(c.text, c.records);
    assert.ok(got.includes(c.code), `${c.name}：期望红因 ${c.code}，实际 ${JSON.stringify(got)}`);
    const prob = fanoutIndependentVerificationProblems(c.text, c.records).find((p) => p.code === c.code)!;
    assert.ok(prob.message.trim().length > 0, `${c.code} 必须给出可读红因`);
  }
});

test("g-440 判据 3（反向边界）：合法留痕与 off 路径一律不误红", () => {
  // ① 真实独立验证（PASS）+ 如实成员行 ⇒ 全绿。
  assert.deepEqual(codes(trace("- verify: review=rev-att-001-01 scope=parser conclusion=PASS source=independent"), [rec()]), []);
  // ② 如实标注 self_requested（不冒充独立）⇒ **不误红**，但也不构成独立验证。
  assert.deepEqual(
    codes(trace("- verify: review=rev-att-001-01 scope=parser conclusion=PASS source=self_requested"), [rec({ self_requested: true, independent: false, conclusion: "PASS" })]),
    [],
  );
  // ③ 如实标注 author（作者自报、如实登记）⇒ 不误红。
  assert.deepEqual(
    codes(trace("- verify: review=rev-att-001-01 scope=parser conclusion=UNVERIFIED source=author"), [rec({ independent: false })]),
    [],
  );
  // ④ 只有成员行、没有独立验证声明 ⇒ 不误红（扇出 ≠ 必须独立验证）。
  assert.deepEqual(codes(`${SECTION_ZH}\n- member: name=m1 scope=x status=done conclusion=PASS evidence='ok'`, [rec()]), []);
  // ⑤ 未启用 / 根本没写该小节 ⇒ 完全不判（off 路径零回归）。
  assert.deepEqual(codes("## 结果摘要\ng-440 完成。", []), []);
  assert.deepEqual(codes("", []), []);
  // ⑥ en 对偶标题同样被识别（双语留痕可审计）。
  assert.deepEqual(codes(`${SECTION_EN}\n- verify: review=rev-att-001-01 scope=x conclusion=PASS source=independent`, [rec()]), []);
  // ⑦ 放弃成员如实登记为 UNVERIFIED（不计 PASS）⇒ 不误红。
  assert.deepEqual(
    codes(`${SECTION_ZH}\n- member: name=m2 scope=x status=abandoned conclusion=UNVERIFIED evidence='timeout'`, [rec()]),
    [],
  );
});

/** 抽取 core/ops.ts 里的自包含守卫块：源码里只有 `: any` 一种类型注解（去掉即可在 vm 求值）。 */
function extractGuardBlock(ops = sourceOps()): string {
  const b = ops.indexOf(FANOUT_GUARD_BLOCK_BEGIN);
  const e = ops.indexOf(FANOUT_GUARD_BLOCK_END);
  assert.ok(b > 0 && e > b, "core/ops.ts 必须含可抽取的守卫块定界标记");
  const block = ops.slice(b + FANOUT_GUARD_BLOCK_BEGIN.length, e);
  assert.ok(!/:\s*(string|number|boolean|void|unknown|never)\b/.test(block), "守卫块只允许 `: any` 注解（否则 vm 抽取失真）");
  return block;
}
function evalGuard(block: string): any {
  const js = block.replace(/:\s*any\b/g, "");
  const sandbox: any = {};
  vm.createContext(sandbox);
  vm.runInContext(`${js}\nGUARD = FANOUT_GUARD;`, sandbox);
  return sandbox.GUARD;
}

/** 每条红因的探针：正文 + 记录（变异前后用同一探针，只有守卫源码被改）。 */
const RED_PROBES: Array<{ code: string; body: string; records: FanoutReviewRecord[] }> = [
  { code: "unparsable_independent_claim", body: `${SECTION_ZH}\n独立验证：PASS`, records: [rec()] },
  { code: "missing_review_record", body: `${SECTION_ZH}\n- verify: review=rev-nope scope=x conclusion=PASS source=independent`, records: [rec()] },
  { code: "missing_source", body: `${SECTION_ZH}\n- verify: review=rev-att-001-01 scope=x conclusion=PASS`, records: [rec()] },
  { code: "invalid_source", body: `${SECTION_ZH}\n- verify: review=rev-att-001-01 scope=x conclusion=PASS source=bogus`, records: [rec()] },
  { code: "self_requested_claimed_independent", body: `${SECTION_ZH}\n- verify: review=rev-att-001-01 scope=x conclusion=PASS source=independent`, records: [rec({ self_requested: true, independent: false })] },
  { code: "author_self_report_claimed_independent", body: `${SECTION_ZH}\n- verify: review=rev-att-001-01 scope=x conclusion=PASS source=independent`, records: [rec({ reviewer_child_id: "child-author", author_child_id: "child-author", independent: false })] },
  { code: "record_not_independent", body: `${SECTION_ZH}\n- verify: review=rev-att-001-01 scope=x conclusion=PASS source=independent`, records: [rec({ independent: false, reviewer_child_id: null })] },
  { code: "review_not_completed", body: `${SECTION_ZH}\n- verify: review=rev-att-001-01 scope=x conclusion=PASS source=independent`, records: [rec({ status: "failed" })] },
  { code: "conclusion_mismatch", body: `${SECTION_ZH}\n- verify: review=rev-att-001-01 scope=x conclusion=PASS source=independent`, records: [rec({ conclusion: "BLOCK" })] },
  { code: "invalid_conclusion", body: `${SECTION_ZH}\n- verify: review=rev-att-001-01 scope=x conclusion=FAIL source=independent`, records: [rec()] },
  { code: "abandoned_counted_as_pass", body: `${SECTION_ZH}\n- member: name=m2 scope=x status=timeout conclusion=PASS evidence='x'\n- verify: review=rev-att-001-01 scope=x conclusion=PASS source=independent`, records: [rec()] },
];

test("g-440 判据 3（负向对照 / 变异）：删掉任一红因的判定语句 ⇒ 该红因不再产出", () => {
  const block = extractGuardBlock();
  const real = evalGuard(block);
  const codeSet = (g: any, p: { body: string; records: FanoutReviewRecord[] }): string[] =>
    (g.problems(p.body, p.records) as Array<{ code: string }>).map((x) => x.code);
  // ① 未变异：每条探针的**期望红因**必须在场（否则「删掉即消失」没有意义），且块里确有发射点。
  for (const p of RED_PROBES) {
    assert.ok(codeSet(real, p).includes(p.code), `未变异时 ${p.code} 必须真实可触发`);
    assert.ok(block.includes(`code: "${p.code}"`), `守卫块必须含红因发射点：${p.code}`);
  }
  // ② 逐条变异：删掉发射该红因的整行 ⇒ 该红因不再出现（承重性证明）。
  //    对单发射点的红因必须「干净消失」；对多发射点的红因（missing_review_record），删净后守卫会
  //    读到 undefined 记录而**直接失效抛错** —— 同样证明该检查承重（不是摆设），故显式接受抛错。
  for (const p of RED_PROBES) {
    const mutated = block.split("\n").filter((l) => !l.includes(`code: "${p.code}"`)).join("\n");
    assert.notEqual(mutated, block, `变异必须真实发生：${p.code}`);
    let after: string[] | null = null;
    let broke = false;
    try { after = codeSet(evalGuard(mutated), p); } catch { broke = true; }
    assert.ok(broke || !after!.includes(p.code), `删掉 ${p.code} 的判定语句后，该红因不得再产出（或守卫直接失效）`);
  }
  // ③ 反向边界在真实块上依然成立（合法留痕不误红）。vm 沙箱的对象跨 realm，先 JSON 往返再比较。
  assert.deepEqual(
    JSON.parse(JSON.stringify(real.problems(`${SECTION_ZH}\n- verify: review=rev-att-001-01 scope=x conclusion=PASS source=self_requested`, [rec({ self_requested: true, independent: false })]))),
    [],
  );
});

// =====================================================================================
// 判据 2/3：审计入口（真实 g-436 留痕 + 真实 results-att-*.md 命名）
// =====================================================================================

function tempRoot(): string {
  const ws = mkdtempSync(join(tmpdir(), "g440-"));
  init(join(ws, ".dsh-graph"));
  return join(ws, ".dsh-graph");
}

/** 建一个带真实 attempt 目录的目标，便于登记真实评审留痕。 */
function goalWithAttempt(root: string): { goal: string; goalDir: string } {
  const goal = createGoal(root, { title: "g-440 守卫夹具", version: "v-test", type: "improvement", actor: "human:gui" });
  const goalDir = dirname(findGoalFile(root, goal));
  mkdirSync(join(goalDir, "attempts", "att-001"), { recursive: true });
  writeFileSync(join(goalDir, "attempts", "att-001", "attempt.md"), "---\nid: att-001\n---\n夹具 attempt\n", "utf8");
  return { goal, goalDir };
}

/** 登记一条**真实**评审记录：独立（reviewer ≠ author、非作者自派）或 self_requested。 */
function dispatchReview(root: string, goal: string, opts: { independent: boolean; conclusion: string }): string {
  const requestedBy = opts.independent ? "agent:sess-super" : "agent:child-author";
  const { review_id } = appendReviewDispatch(root, {
    goalId: goal,
    sourceAttempt: "att-001",
    candidateSha: "c0ffee",
    requestedBy,
    authorChildId: "child-author",
    actor: "agent:sess-super",
  });
  if (opts.independent) bindReviewChild(root, goal, review_id, "child-reviewer", "agent:sess-super", { parentSessionId: "sess-super" });
  else bindReviewChild(root, goal, review_id, "child-reviewer", "agent:sess-super", { parentSessionId: "sess-super" });
  settleReview(root, goal, review_id, { text: `**总判**：${opts.conclusion}`, stopReason: "completed", actor: "agent:sess-super" });
  return review_id;
}

test("g-440 判据 2：留痕复用 g-436 真源（reviews/<review_id>.md），self_requested 不算独立验证", () => {
  const root = tempRoot();
  const { goal, goalDir } = goalWithAttempt(root);
  const rid = dispatchReview(root, goal, { independent: true, conclusion: "PASS" });
  assert.ok(existsSync(join(goalDir, "reviews", `${rid}.md`)), "留痕必须落在 <goalDir>/reviews/<review_id>.md（g-436 真源）");
  // 合法独立验证：绿；同一断言换成 self_requested 记录：红。
  const good = `${SECTION_ZH}\n- verify: review=${rid} scope=parser conclusion=PASS source=independent`;
  assert.equal(auditFanoutIndependentVerification(root, goal, { resultsTexts: [good] }).ok, true, "真实独立留痕必须通过");
  const rid2 = dispatchReview(root, goal, { independent: false, conclusion: "PASS" });
  const fake = `${SECTION_ZH}\n- verify: review=${rid2} scope=parser conclusion=PASS source=independent`;
  const audit = auditFanoutIndependentVerification(root, goal, { resultsTexts: [fake] });
  assert.equal(audit.ok, false, "self_requested 不得冒充独立验证");
  assert.deepEqual(audit.problems.map((p) => p.code), ["self_requested_claimed_independent"]);
  // 如实标注 self_requested ⇒ 绿（反向边界，端到端）。
  const honest = `${SECTION_ZH}\n- verify: review=${rid2} scope=parser conclusion=PASS source=self_requested`;
  assert.equal(auditFanoutIndependentVerification(root, goal, { resultsTexts: [honest] }).ok, true);
});

test("g-440 判据 2：attempt 结果摘要的固定小节 + 真实文件命名被审计入口读到", () => {
  const root = tempRoot();
  const { goal, goalDir } = goalWithAttempt(root);
  const rid = dispatchReview(root, goal, { independent: true, conclusion: "PASS" });
  // 真实 results 文件命名（与 results-face 写入器同口径：results-att-<NNN>.md）
  writeFileSync(join(goalDir, "results-att-001.md"), `# 完成摘要\n\n${SECTION_ZH}\n- verify: review=${rid} scope=parser conclusion=PASS source=independent\n`, "utf8");
  // 另一个 attempt 的摘要没写该小节 ⇒ 不参与判定（不进 results 面板的 off 路径）
  writeFileSync(join(goalDir, "results-att-002.md"), "# 完成摘要\n无扇出。\n", "utf8");
  const texts = readAttemptResultsTexts(goalDir);
  assert.equal(texts.length, 2, "只读 results-att-<NNN>.md（results.md / results-archive-* 不计）");
  assert.equal(auditFanoutIndependentVerification(root, goal).ok, true, "真实文件（非注入文本）必须被读到并通过");
  // 造价留痕：声明了 review 但记录不存在 ⇒ 红，且红因点名缺留痕。
  writeFileSync(join(goalDir, "results-att-002.md"), `# 完成摘要\n\n${SECTION_ZH}\n- verify: review=rev-att-001-77 scope=x conclusion=PASS source=independent\n`, "utf8");
  const audit = auditFanoutIndependentVerification(root, goal);
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.problems.map((p) => p.code), ["missing_review_record"]);
  assert.equal(audit.problems[0].source, "results[1]", "红因必须指向具体来源文件序号");
});

// =====================================================================================
// 判据 4/5：开关（schema / 读写 / GUI / 文案）与降级矩阵
// =====================================================================================

test("g-440 判据 4：settingsPostSchema 白名单 + 读写往返 + 畸形 fail-safe（默认 off）", () => {
  const root = tempRoot();
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  // 未配置 ⇒ null（= off）
  assert.equal(readProjectConfig(root).supervisor.agent_teams, null, "未配置必须是 null（off）");
  for (const v of [true, false, true, null] as const) {
    writeProjectConfig(root, { supervisor: { agent_teams: v } }, "agent:test");
    assert.equal(readProjectConfig(root).supervisor.agent_teams, v, `往返必须保真：${String(v)}`);
  }
  // 非布尔被 schema 拒绝（拒绝隐式 coercion），且零副作用（原值不变）。
  writeProjectConfig(root, { supervisor: { agent_teams: true } }, "agent:test");
  assert.throws(() => writeProjectConfig(root, { supervisor: { agent_teams: "true" } } as any, "agent:test"), /agent_teams|coercion|校验失败/);
  assert.throws(() => writeProjectConfig(root, { supervisor: { agent_teams: 1 } } as any, "agent:test"), /agent_teams|类型|校验失败/);
  assert.equal(readProjectConfig(root).supervisor.agent_teams, true, "被拒的写入不得改变已落盘值");
  // 手写畸形值（YAML `yes`/字符串）一律按未配置（off）处理，绝不误开。
  for (const bad of ["yes", "on", "\"true\"", "1", "maybe"]) {
    writeFileSync(join(root, "project.yaml"), `supervisor:\n  session: sess-super\n  agent_teams: ${bad}\n`, "utf8");
    assert.equal(readProjectConfig(root).supervisor.agent_teams, null, `畸形值必须 fail-safe 为 null（off）：${bad}`);
  }
});

test("g-440 判据 4：GUI 复选框（真实渲染）+ 双语文案（en 零 CJK）", () => {
  const modalSrc = sourceModal();
  // ① 真实源码里的归一化/稀疏 patch 行为（vm 求值，不用字符串匹配替代行为断言）。
  const helpers = loadClientHelpers(modalSrc);
  const plain = (x: any): any => JSON.parse(JSON.stringify(x));
  const base = { supervisor: { automation: {}, agent_teams: null } };
  assert.equal(helpers.normalizeSettingsDraft({ supervisor: {} }).supervisor.agent_teams, null, "缺失 ⇒ null");
  assert.equal(helpers.normalizeSettingsDraft({ supervisor: { agent_teams: true } }).supervisor.agent_teams, true);
  assert.equal(helpers.normalizeSettingsDraft({ supervisor: { agent_teams: false } }).supervisor.agent_teams, false);
  assert.equal(helpers.normalizeSettingsDraft({ supervisor: { agent_teams: "true" } }).supervisor.agent_teams, null, "畸形 ⇒ null（off）");
  // 同态不假脏；真态变化 ⇒ 恰好一个稀疏叶子（开关参与脏状态拦截）。
  const normBase = helpers.normalizeSettingsDraft(base, "");
  assert.equal(helpers.settingsDraftIsDirty(normBase, base), false);
  assert.equal(helpers.settingsDraftIsDirty(normBase, { supervisor: { agent_teams: true } }), true, "打开开关必须被判为脏");
  assert.equal(helpers.settingsDraftIsDirty(helpers.normalizeSettingsDraft({ supervisor: { agent_teams: true } }, ""), base), true, "关闭开关同样必须被判为脏");
  assert.deepEqual(plain(helpers.buildSettingsPatch(base, base)), {}, "无变化 ⇒ 空 patch");
  assert.deepEqual(
    plain(helpers.buildSettingsPatch({ supervisor: { agent_teams: true } }, base)),
    { supervisor: { agent_teams: true } },
    "稀疏 patch：只有真变化的叶子",
  );
  assert.deepEqual(
    plain(helpers.buildSettingsPatch({ supervisor: { agent_teams: null } }, { supervisor: { agent_teams: true } })),
    { supervisor: { agent_teams: null } },
    "关闭（回未配置）也要能提交（null 叶子）",
  );
  // ② 渲染树：复选框在场、checked 跟随配置、label 用 zh 文案。
  const zh = loadClientI18n().zh;
  for (const [value, expected] of [[true, true], [false, false], [null, false]] as const) {
    const tree = renderSettingsModal(modalSrc, snapshot({ agent_teams: value }), zh);
    const box = nodesOfType(tree, "input").find((n: any) => n.props?.id === "dg-agent-teams");
    assert.ok(box, "渲染树里必须有 Agent Teams 复选框");
    assert.equal(box.props.type, "checkbox");
    assert.equal(box.props.checked, expected, `checked 必须跟随 supervisor.agent_teams=${String(value)}`);
    const label = nodesOfType(tree, "label").find((n: any) => n.props?.htmlFor === "dg-agent-teams");
    assert.ok(label, "复选框必须有 label");
    assert.equal((label.children ?? []).join(""), zh["settings.agentTeams"]);
  }
  // ③ 双语文案齐备且 en 零 CJK（i18n 字典级）。
  const dicts = loadClientI18n();
  for (const k of ["settings.agentTeams", "settings.agentTeamsHint"]) {
    assert.ok(dicts.zh[k] && dicts.en[k], `i18n 键必须双语齐备：${k}`);
    assert.ok(!CJK.test(dicts.en[k]), `en 文案零 CJK：${k}`);
  }
  assert.match(dicts.zh["settings.agentTeamsHint"], /默认关闭/, "zh 文案必须写明默认关闭");
  assert.match(dicts.en["settings.agentTeamsHint"], /Off by default/, "en 文案必须写明 off by default");
  // ④ 结构性锚点（与行为断言互补）：复选框 id、绑定路径、以及「只有布尔才提交」。
  assert.ok(modalSrc.includes('id: "dg-agent-teams"'), "必须有稳定的复选框 id");
  assert.ok(modalSrc.includes('set(["supervisor", "agent_teams"]'), "复选框必须绑定 supervisor.agent_teams");
  assert.ok(modalSrc.includes('leaf(["supervisor", "agent_teams"])'), "稀疏 patch 必须覆盖该叶子");
});

test("g-440 判据 5：降级矩阵逐行钉死（off / 缺契约 / 宿主不支持 / 深度不足 / 未知）", () => {
  const C = "CONTRACT-BODY";
  const rows: Array<[{ enabled: boolean; contract?: string | null; supportsFanout?: boolean | null; subagentDepth?: number | null }, boolean, string]> = [
    [{ enabled: false, contract: C }, false, "disabled"],
    [{ enabled: false }, false, "disabled"],
    [{ enabled: true, contract: null }, false, "contract_unavailable"],
    [{ enabled: true, contract: "" }, false, "contract_unavailable"],
    [{ enabled: true, contract: "   " }, false, "contract_unavailable"],
    [{ enabled: true, contract: C, supportsFanout: false }, false, "unsupported_host"],
    [{ enabled: true, contract: C, subagentDepth: 0 }, false, "shallow_depth"],
    [{ enabled: true, contract: C, subagentDepth: 1 }, false, "shallow_depth"],
    [{ enabled: true, contract: C, subagentDepth: 2 }, true, "enabled"],
    [{ enabled: true, contract: C, subagentDepth: 5 }, true, "enabled"],
    [{ enabled: true, contract: C }, true, "enabled"],
    [{ enabled: true, contract: C, supportsFanout: null, subagentDepth: null }, true, "enabled"],
    [{ enabled: true, contract: C, supportsFanout: true, subagentDepth: null }, true, "enabled"],
  ];
  for (const [opts, inject, reason] of rows) {
    const d = resolveAgentTeamsInjection(opts);
    assert.equal(d.inject, inject, `${JSON.stringify(opts)} ⇒ inject=${inject}`);
    assert.equal(d.reason, reason, `${JSON.stringify(opts)} ⇒ reason=${reason}`);
    assert.equal(d.contract, inject ? C : null, "只有注入时才带契约正文（否则必须 null）");
  }
  // 降级必须**诚实**：任何降级都不抛错、不返回半截契约（fail-safe）。
  for (const opts of [
    { enabled: true, contract: null },
    { enabled: true, contract: C, supportsFanout: false },
    { enabled: true, contract: C, subagentDepth: 1 },
  ]) {
    assert.doesNotThrow(() => resolveAgentTeamsInjection(opts));
    assert.equal(resolveAgentTeamsInjection(opts).contract, null);
  }
});

test("g-440 判据 4：composeSubagentPrompt / resolveSubagentPrompt 的 off 逐字节不变与 on 纯追加", () => {
  const overrides: any[] = [
    { state: "default", value: null },
    { state: "override", value: "USER-PROMPT" },
    { state: "disable", value: null },
  ];
  const globals = ["", "GLOBAL-PROMPT"];
  // 第三参是**遗留值**语义：`"default"` = 未配置（回落全局）、非空 = 遗留显式值、`""` = 显式禁用。
  const legacies = ["default", "LEGACY-PROMPT", ""];
  let combos = 0;
  for (const g of globals) for (const ov of overrides) for (const l of legacies) {
    // 缺省第 4 参（g-440 之前的调用形态）与显式 null 必须逐字节一致 ⇒ off 零回归。
    assert.equal(composeSubagentPrompt(g, ov, l, null), composeSubagentPrompt(g, ov, l));
    // off 决策下契约不参与合成。
    const d = resolveAgentTeamsInjection({ enabled: false, contract: "CONTRACT" });
    assert.equal(composeSubagentPrompt(g, ov, l, d.contract), composeSubagentPrompt(g, ov, l));
    combos++;
  }
  assert.equal(combos, 18, "矩阵必须真的跑满");
  // on：纯追加（off + "\n\n" + 契约）。
  const off = composeSubagentPrompt("GLOBAL-PROMPT", { state: "default", value: null }, "default");
  const on = composeSubagentPrompt("GLOBAL-PROMPT", { state: "default", value: null }, "default", "CONTRACT");
  assert.equal(off, "GLOBAL-PROMPT");
  assert.equal(on, "GLOBAL-PROMPT\n\nCONTRACT");
  assert.equal(String(on).replace("\n\nCONTRACT", ""), off, "on = off + 纯追加");
  // 用户材料被显式 disable（管理员禁用补充提示词）时：off ⇒ null；on ⇒ 只剩契约（不复活被禁材料）。
  assert.equal(composeSubagentPrompt("GLOBAL-PROMPT", { state: "disable", value: null }, "default"), null);
  assert.equal(composeSubagentPrompt("GLOBAL-PROMPT", { state: "disable", value: null }, "default", "CONTRACT"), "CONTRACT");
  // 双语对偶：en 契约块经同一通道合成时同样**逐字**追加（装配是 locale 无关的同一段代码）。
  const enContract = extractAgentTeamsContract(sourceDiscipline("en"))!;
  assert.ok(enContract && enContract.includes("Fan-out members are not attempts"));
  const enOn = composeSubagentPrompt("GLOBAL-PROMPT", { state: "default", value: null }, "default", enContract)!;
  assert.equal(enOn, `GLOBAL-PROMPT\n\n${enContract}`);
  assert.equal(composeSubagentPrompt("GLOBAL-PROMPT", { state: "default", value: null }, "default", enContract), composeSubagentPrompt("GLOBAL-PROMPT", { state: "default", value: null }, "default", enContract));
});

// =====================================================================================
// 客户端 vm harness（沿用 g-442 形态）
// =====================================================================================

const NORM_START = "function normalizeSettingsDraft(";
const MODAL_START = "function SettingsModal(";
const HELPER_NAMES = ["normalizeSettingsDraft", "settingsDraftIsDirty", "buildSettingsPatch", "settingsPatchIsEmpty"];

function loadClientHelpers(modalSrc: string): any {
  const start = modalSrc.indexOf(NORM_START);
  const end = modalSrc.indexOf(MODAL_START, start);
  assert.ok(start > 0 && end > start, "settings-modal.js 必须含「归一化段…SettingsModal」");
  const sandbox: any = {};
  vm.runInNewContext(
    `(function () {\n${modalSrc.slice(start, end)}\n` +
      `globalThis.__h = { ${HELPER_NAMES.map((n) => `${n}: ${n}`).join(", ")} };\n})()`,
    sandbox,
  );
  return sandbox.__h;
}

function loadClientI18n(src = sourceI18n()): { zh: Record<string, string>; en: Record<string, string> } {
  const sandbox: any = { React: {} };
  vm.runInNewContext(`${src}\n;this.zh = zh; this.en = en;`, sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

const h = (type: any, props: any, ...children: any[]) => ({
  type,
  props: props || {},
  children: children.flat(Infinity).filter((c: any) => c !== null && c !== undefined && c !== false),
});
function walk(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}
function nodesOfType(tree: any, type: string): any[] {
  const out: any[] = [];
  walk(tree, (n) => { if (n.type === type) out.push(n); });
  return out;
}

/** 服务端快照（够渲染表单即可；agent_teams 是要断言的那一格）。 */
function snapshot(o: { agent_teams: boolean | null }): any {
  return {
    executor: { provider: null, model: null, reasoning_effort: null, mode: null },
    defaults: { review: { reviewer: null, prompt: null }, pk: { lanes: null, sandbox: null } },
    supervisor: {
      automation: Object.fromEntries(["scope_planning", "integration_decision", "rework", "memory_promotion", "skill_proposal", "release"].map((k) => [k, null])),
      agent_teams: o.agent_teams,
    },
    prompt_overrides: { subagent: { state: "default", value: null } },
    review: { policy: null, regions: null, contract_paths: null, non_product_prefixes: null, effective: {} },
  };
}

/** 真实渲染 SettingsModal（form 已加载态）。hook 序与 g-442 同源：
 *  0 loading, 1 form, 2 saving, 3 note, 4 error, 5 showAdvanced, 6 configFile,
 *  7 refreshIntervalInput, 8 intervalWarn, 9 catalog, 10 suggestedRegions。 */
function renderSettingsModal(modalSrc: string, snap: any, zh: Record<string, string>): any {
  const overrides: any[] = [false, snap];
  overrides[10] = null;
  let idx = 0;
  const sandbox: any = {
    console,
    h,
    dgOverlay: (props: any, ...children: any[]) => h("div", props, ...children),
    settingsModalModeInstanceSeq: 0,
    dgT: (k: string) => zh[k] ?? k,
    S: new Proxy({}, { get: () => ({}) }),
    graphUrl: (u: string) => u,
    gConnectionApi: null,
    loadHostCatalog: async () => ({ status: "unavailable" }),
    openHostPath: async () => ({ opened: false }),
    copyText: async () => true,
    showToast: () => {},
    openErrorText: (e: any) => String(e),
    getRefreshInterval: () => 15,
    setRefreshInterval: () => 15,
    MIN_REFRESH_INTERVAL: 5,
    useLocaleRevision: () => {},
    useBackdropClose: () => ({}),
    useLiveDisplayEnabled: () => false,
    window: { confirm: () => true },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    React: {
      createElement: h,
      useRef: (init: any) => ({ current: init }),
      useState: (init: any) => {
        const i = idx++;
        const v = i < overrides.length && overrides[i] !== undefined ? overrides[i] : (typeof init === "function" ? init() : init);
        return [v, () => {}];
      },
      useEffect: () => {},
    },
  };
  const start = modalSrc.indexOf(MODAL_START);
  assert.ok(start > 0, "settings-modal.js 缺少 SettingsModal");
  const normStart = modalSrc.indexOf(NORM_START);
  assert.ok(normStart > 0 && normStart < start, "settings-modal.js 缺少 normalizeSettingsDraft");
  vm.runInNewContext(
    `${modalSrc.slice(normStart, start)}\n${modalSrc.slice(start)}\n;this.__SettingsModal = SettingsModal;`,
    sandbox,
  );
  return sandbox.__SettingsModal({ onClose: () => {}, onSaved: () => {} });
}

// =====================================================================================
// 判据 4：宿主派发链路的双态注入断言（真实 graph_start_attempt）
// =====================================================================================

interface HostHarness {
  ws: string;
  root: string;
  toolsByName: Map<string, any>;
  capturedRequests: any[];
  execContext: any;
}

function createHarness(projectYaml: string): HostHarness {
  const ws = mkdtempSync(join(tmpdir(), "g440-host-"));
  execFileSync("git", ["init", "-q"], { cwd: ws });
  // 固定 author/committer 时间 ⇒ 空提交 SHA 跨夹具**确定**（派发正文里含「权威基线 commit」一行，
  // 若任其取当前时间，同一秒内的两次夹具才相等、跨秒即假红 —— 那是夹具抖动，不是配置差异）。
  const gitDate = { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: ws, env: gitDate });
  const root = join(ws, ".dsh-graph");
  init(root);
  writeFileSync(join(root, "project.yaml"), projectYaml, "utf8");
  const capturedRequests: any[] = [];
  const registeredTools: any[] = [];
  const events: Record<string, Function[]> = {};
  const webServer = { register: () => () => {} };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "subagents") {
        return {
          list: () => ["spawn"],
          getProvider: () => ({ prepareContinuable: () => {} }),
          startContinuable: async (o: any) => {
            capturedRequests.push(o);
            return { childId: `child-${capturedRequests.length}`, parentSessionId: "sess-super" };
          },
          interruptByParent: () => {},
        };
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registeredTools.push(def); return () => {}; }, get: () => ({}) },
    on: (name: string, fn: Function) => { (events[name] = events[name] ?? []).push(fn); return () => {}; },
  };
  apply(ctx, { root });
  return {
    ws,
    root,
    toolsByName: new Map(registeredTools.map((t: any) => [t.name, t])),
    capturedRequests,
    execContext: { agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-exec" } }, signal: new AbortController().signal },
  };
}

/** 真实派发一次，返回最终派发提示词。 */
async function dispatchPrompt(projectYaml: string, opts: { subagentPrompt?: string } = {}): Promise<string> {
  const hh = createHarness(projectYaml);
  const goal = createGoal(hh.root, { title: "g-440 派发夹具", version: "v-test", type: "chore", actor: "human:gui" });
  setCriteria(hh.root, goal, ["判据一 ✅已验"], "human:gui");
  const t0 = hh.toolsByName.get("graph_set_description");
  assert.ok(t0, "graph_set_description 必须注册");
  await t0.execute({ goal, description: "## 目标描述\n- g-440 双态注入夹具。" }, hh.execContext);
  if (opts.subagentPrompt) writeProjectConfig(hh.root, { prompt_overrides: { subagent: { state: "override", value: opts.subagentPrompt } } }, "human:gui");
  const t1 = hh.toolsByName.get("graph_start_attempt");
  assert.ok(t1, "graph_start_attempt 必须注册");
  await t1.execute({ goal, worktree: false, attempt_brief: "g-440 双态注入夹具 brief" }, hh.execContext);
  assert.equal(hh.capturedRequests.length, 1, "恰好派发一个执行子代理");
  const parts = hh.capturedRequests[0].request.prompt;
  return Array.isArray(parts) ? parts.map((p: any) => String(p?.text ?? "")).join("") : String(parts);
}

const OFF_YAML = "supervisor:\n  session: sess-super\n";
const OFF_FALSE_YAML = "supervisor:\n  session: sess-super\n  agent_teams: false\n";
const OFF_NULL_YAML = "supervisor:\n  session: sess-super\n  agent_teams:\n";
const ON_YAML = "supervisor:\n  session: sess-super\n  agent_teams: true\n";

const USER_SENTINEL = "USER-SUBAGENT-PROMPT-SENTINEL-42";

test("g-440 判据 4（双态注入断言）：off 三态派发提示词逐字节相等且不含契约；on 纯追加契约段", async () => {
  // 三个 off 态（未配置 / false / null）各自真实派发；期望**逐字节相等**（diff=0）。
  const off = await dispatchPrompt(OFF_YAML, { subagentPrompt: USER_SENTINEL });
  const offFalse = await dispatchPrompt(OFF_FALSE_YAML, { subagentPrompt: USER_SENTINEL });
  const offNull = await dispatchPrompt(OFF_NULL_YAML, { subagentPrompt: USER_SENTINEL });
  assert.equal(offFalse, off, "agent_teams=false 的派发提示词必须与未配置逐字节相等（diff=0）");
  assert.equal(offNull, off, "agent_teams=null 的派发提示词必须与未配置逐字节相等（diff=0）");
  assert.ok(off.includes(USER_SENTINEL), "夹具前提：off 提示词确实含用户补充提示词（否则比较无意义）");
  assert.ok(!off.includes(AGENT_TEAMS_CONTRACT_BEGIN) && !off.includes("扇出成员不是 attempt"), "off 提示词绝不含契约文本");

  // on：同一夹具 + 同一用户材料 ⇒ 契约段被注入，且相对 off 是**纯追加**。
  const on = await dispatchPrompt(ON_YAML, { subagentPrompt: USER_SENTINEL });
  assert.ok(on.includes(USER_SENTINEL), "on 也必须保留用户材料（不得覆盖）");
  assert.ok(on.includes("扇出成员不是 attempt"), "on 必须注入契约段");
  // 注入的正文 = 交付资产里的定界块（逐字；不是第二份手抄副本）。
  const contract = extractAgentTeamsContract(distDiscipline("zh"));
  assert.ok(contract, "dist 资产必须能抽出契约块");
  assert.ok(on.includes(contract!), "注入的契约正文必须与资产逐字一致");
  assert.equal(on.replace("\n\n" + contract!, ""), off, "on = off + 纯追加契约段（diff 仅为契约段）");
});

test("g-440 判据 4：无用户补充提示词时，off 完全不注入；on 仍注入（开关自身生效）", async () => {
  const off = await dispatchPrompt(OFF_YAML);
  assert.ok(!off.includes("子代理补充提示词"), "off 且无用户材料 ⇒ 该槽位不存在（与 g-440 之前逐字节一致）");
  assert.ok(!off.includes("扇出成员不是 attempt"), "off 绝不含契约");
  const on = await dispatchPrompt(ON_YAML);
  assert.ok(on.includes("子代理补充提示词"), "on 必须为该槽位提供内容");
  assert.ok(on.includes("扇出成员不是 attempt"));
  assert.ok(on.includes(extractAgentTeamsContract(distDiscipline("zh"))!), "on 注入的仍是资产原文");
});

test("g-440 判据 4：契约只进既有槽位（不新增框架小节标题，无新强制门禁）", async () => {
  const off = await dispatchPrompt(OFF_YAML, { subagentPrompt: USER_SENTINEL });
  const on = await dispatchPrompt(ON_YAML, { subagentPrompt: USER_SENTINEL });
  // 框架自身的 `## ` 小节标题集合在 on/off 之间**完全相同** ⇒ 契约没有另立小节/新门禁。
  const headings = (t: string) => t.split("\n").filter((l) => l.startsWith("## ")).sort();
  assert.deepEqual(headings(on), headings(off), "on 不得新增任何 `## ` 框架小节标题");
  // 契约紧跟在「子代理补充提示词」槽位内（用户材料之后），与 g-333 单一注入通道同源。
  const contract = extractAgentTeamsContract(distDiscipline("zh"))!;
  assert.ok(on.indexOf("子代理补充提示词") < on.indexOf(contract), "契约必须位于既有槽位之内");
  // 主管每轮纪律仍逐字渲染资产本身（g-439 口径）：契约块作为资产的一部分出现在纪律里。
  const asset = sourceDiscipline("zh");
  assert.ok(asset.includes("扇出成员不是 attempt"), "纪律资产本身含契约（常驻文档）");
  assert.equal(distDiscipline("zh"), asset, "dist 与源一致（渲染读的是交付资产）");
});
