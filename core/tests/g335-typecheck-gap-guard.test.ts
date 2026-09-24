/**
 * g-335：门禁②「类型检查仅覆盖 core 层」覆盖缺口的**防静默删除**断言。
 *
 * 背景（负责人裁定 2026-09-24 = 方案③「最低成本」）：
 *  - `tsconfig.json` 的 `include` 仅 `core/*.ts`，`core/tests` 与 host 的 `.js` 不在其内，
 *    故 `tsc --noEmit -p tsconfig.json` 的 `exit_code=0` **不能**代表全仓类型零错；
 *  - 方案①（修到 0 错并把 `core/tests` 纳入）与方案②（tests 专用宽松 tsconfig + 错误数基线门禁）
 *    均被否决；方案③维持现状，但必须在指南与门禁定义里**如实标注**该缺口。
 *
 * 本目标要解决的问题：该标注原先**没有任何断言守护**——实测把它删掉后全量测试仍全绿，
 * 即缺口说明可被静默删除（虚假完整性回归）。本文件就是那道守护。
 *
 * 判据映射：
 *  - 判据 1 → 缺口标注存在于 `dsh-graph-host/supervisor-guide.{zh,en}.md` 的门禁②行、
 *             以及 `core/review-policy.ts` 的门禁定义注释与失败文案；zh/en 行数严格相等。
 *  - 判据 2 → 本文件的断言即交付物：删除或改写任一侧的缺口说明必红。
 *  - 判据 3 → `package.json` 暴露 `typecheck` 脚本（门禁②命令），且**未**接进 build/prepare。
 *  - 判据 4 → 守卫方案③裁定：`tsconfig.json` 仍只 include `core/*.ts`、exclude `core/tests`，
 *             且全仓非忽略目录内不存在 tests 专用宽松 tsconfig（即不得退回被否决的①②）。
 *
 * 设计（g-346 att-005：**判别做在「纯检查函数 + 合成夹具」上**，不再对真实文件做字符串手术）：
 *  1. 真实文件路径只做两件事：把检查函数跑一遍真实指南 / `core/review-policy.ts` 及其 dist 产物
 *     （断言**当前 GREEN**），以及断言指南源与 dist 逐字相同。真实文件**不被切片**去拼夹具。
 *  2. 判别力（改坏即红）全部由**合成夹具字符串**驱动同一个检查函数：删缺口语义 / 搬行 / en 反转 /
 *     针内改写 / 针间反转断语 / 前置否定词。
 *     历史教训：att-003/att-004 按标签**切真实行**（`zhPrefix` 之类）来拼夹具，文件自身一旦被合法
 *     重排，切片结果就变，于是「合法同行编辑」被误判成红灯（NR1/NR2/NR3）；那批断言里约 3/4 是
 *     「验证测试自己构造的字符串」的夹具自检，而这恰恰是误红来源。合成夹具与真实文件的当前排列
 *     无关，此类误红结构性消失。
 *  3. 检查函数只做两类判定：**无序必需短语集合**（逐字命中）+ **无反转表述**（见下），与子句顺序
 *     无关 ⇒ 子句**顺序**变化（交错、重复、前后挪动）不改变判定结果，不误红；
 *     **换词式同义改写**仍会判红（短语不再逐字命中）——这是刻意的边界，见下。
 *  4. 源与 dist **双侧**断言：源侧守护「静默删除」，dist 侧守护「要发布的那一份」。
 *
 * 接受边界（如实声明，请勿读成「任何合法重排都不误红」）：
 *  - 必需短语是**无序列举**：只有新表述仍逐字包含这些短语才算「语义不变」；同义改写（换词、重述）
 *    会判红——这是刻意的（短语是契约的字面锚），但本文件**不是**「语义等价的完备判别器」。
 *  - 反转判别只有两层：结构化「否定词紧邻针前置」+ 极少数**强闭合式**枚举（见 `*_GATE2_CLOSURE`）。
 *    同义反转措辞（例如「现已全部纳入类型检查范围」「has since been addressed」）**不在覆盖内**，会漏网。
 *    被否定的形式、引号内引用、异主语一律**不**算反转——它们并不否认缺口存在。
 *  - 因此本文件守护的是「标注不得被删除 / 搬离门禁②行 / 被紧邻否定词反转 / 被明确断言已闭合」。
 *
 * 运行前需先 `bash scripts/build.sh`（判据 1 的 dist 分支读 dist/，dist/ 是生成物禁止手改）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
const distRoot = join(repoRoot, "dist");

const ZH_GUIDE_SRC = join(repoRoot, "dsh-graph-host", "supervisor-guide.zh.md");
const EN_GUIDE_SRC = join(repoRoot, "dsh-graph-host", "supervisor-guide.en.md");
const POLICY_SRC = join(repoRoot, "core", "review-policy.ts");
const ZH_GUIDE_DIST = join(distRoot, "supervisor-guide.zh.md");
const EN_GUIDE_DIST = join(distRoot, "supervisor-guide.en.md");
const POLICY_DIST = join(distRoot, "core", "review-policy.js");

/** 门禁②的命令字面量（指南与门禁失败文案共用；判据 3 的 typecheck 脚本亦须暴露它）。 */
const TSC_COMMAND = "./node_modules/.bin/tsc --noEmit -p tsconfig.json";

const BUILD_HINT =
  "门禁断言读取源文件与 dist 产物：请先运行 `bash scripts/build.sh` 再跑测试（dist/ 是生成物，禁止手改）";

// ---------------------------------------------------------------------------
// 定位锚点与必需短语（检查器与合成夹具共用）
// ---------------------------------------------------------------------------

/**
 * 门禁②行的**定位锚点**（g-346 判据 2 收敛：问题②）。
 * 锚点刻意**不含缺口标注文本**，因此删掉标注只会得到「缺缺口标注」的准确首报，
 * 不会退化成误导性的「门禁②行定位失败」。
 */
const ZH_GATE2_LINE_ANCHORS = ["2. 类型检查：", TSC_COMMAND];
const EN_GATE2_LINE_ANCHORS = ["2. Type check:", TSC_COMMAND];
const POLICY_DEF_LINE_ANCHORS = ["② 类型检查：", "exit_code === 0"];
const POLICY_DETAIL_LINE_ANCHORS = [`② ${TSC_COMMAND}`, "要求 0"];

/**
 * 门禁②行必须逐字命中的缺口标注短语——**无序集合**：只要求同一行内含全部短语，
 * 与它们在行内的顺序、重复次数、彼此间隔无关（合法同行重排因此天然不误红）。
 */
const ZH_GATE2_ANNOTATION: readonly string[] = [
  "覆盖缺口如实标注",
  "`include` 仅 `core/*.ts`",
  "`core/tests` 与 host 的 `.js` 不在其内",
];
const EN_GATE2_ANNOTATION: readonly string[] = [
  "state the coverage gap honestly",
  "the `include` of `tsconfig.json` is only `core/*.ts`",
  "`core/tests` and host `.js` fall outside it",
];
/** `core/review-policy.ts` 门禁②定义注释行与失败文案行各自必须命中的短语。 */
const POLICY_DEF_ANNOTATION: readonly string[] = ["仅覆盖 core 层", "缺口已在指南如实标注"];
const POLICY_DETAIL_ANNOTATION: readonly string[] = ["仅覆盖 core 层"];

// ---------------------------------------------------------------------------
// 极性判别（窄口径：结构化否定词 + 极少数强闭合式）
// ---------------------------------------------------------------------------

/**
 * 紧贴某一标注短语**之前**的否定词 ⇒ 该标注被反转（结构化判别，对任意否定词生效）。
 */
const ZH_NEGATION_TAIL = /(?:不|未|非|无|没有|勿|别)\s*$/;
const EN_NEGATION_TAIL = /\b(?:not|no|never|without|isn't|doesn't|don't)\s*$/i;

/**
 * 「缺口已闭合」式**强闭合断言**（极窄枚举）。
 *
 * 刻意只保留**不可能支持缺口存在**的强反转式：
 *  - 只有「这一缺口已被修复/解决/闭合/补齐」与「covers the whole repository」这类断言才算反转；
 *  - 删掉了旧枚举里的 `fully covered`、`gap is covered`（`not fully covered` / `the gap is covered in
 *    the guide` 实际**支持**缺口存在或只是「已记录」，旧枚举把它们误判成红灯）；
 *  - 删掉了旧枚举里的「已纳入类型检查」式异主语匹配（`host 的 .js 已纳入类型检查` 与 core 层缺口无关）。
 * 覆盖边界如实声明：本层是措辞族枚举，**同义反转措辞未全覆盖**。
 */
const ZH_GATE2_CLOSURE: readonly RegExp[] = [/缺口[^，。；;、]{0,10}已\s*(?:修复|解决|闭合|补齐)/];
const EN_GATE2_CLOSURE: readonly RegExp[] = [
  /\bgap\b[^,.;]{0,12}\b(?:is|has been|was)\s+(?:fixed|closed|resolved)\b/i,
  /\bcovers?\s+the\s+whole\s+repositor/i,
];

/** 引号内片段：引用他人 / 被反驳的说法，不构成对裁定的反转断言。 */
const QUOTED_SPAN = /`[^`]*`|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/g;
/** 反转断语自身被否定（`并未修复` / `not fixed`）⇒ 不构成闭合断言（它支持缺口存在）。 */
const ZH_CLAUSE_NEGATION = /(?:并非|不是|未|没有|无|不)\s*$/;
const EN_CLAUSE_NEGATION = /\b(?:not|never|no longer|isn't|wasn't|hasn't been)\s*$/i;

// ---------------------------------------------------------------------------
// 纯检查函数（真实文件与合成夹具共用同一套判定）
// ---------------------------------------------------------------------------

/** 定位「同一行同时含全部 anchors」的那一行；`count !== 1` 表示锚点失效（0）或不唯一（>1），两者都必须报红。 */
function lineWithAll(text: string, anchors: readonly string[]): { line: string; count: number } {
  const hits = text.split("\n").filter((line) => anchors.every((anchor) => line.includes(anchor)));
  return { line: hits[0] ?? "", count: hits.length };
}

/** 门禁②行的极性缺口（仅在标注短语齐全时调用，避免同一次失效被重复计数）。 */
function polarityGaps(line: string, needles: readonly string[], where: string, side: "zh" | "en"): string[] {
  const gaps: string[] = [];
  const negationTail = side === "zh" ? ZH_NEGATION_TAIL : EN_NEGATION_TAIL;

  // 结构化判别：扫描该短语的**全部**出现位置，任一处紧邻否定词即视为被反转。
  for (const needle of needles) {
    let at = line.indexOf(needle);
    while (at >= 0) {
      if (negationTail.test(line.slice(0, at))) {
        gaps.push(`${where}：门禁②行缺口标注被前置否定词反转（「${needle}」紧邻其前是否定词）`);
        break;
      }
      at = line.indexOf(needle, at + 1);
    }
  }

  // 强闭合式断言：先剔除引号内引用，再看断言本身是否被否定。
  const scan = line.replace(QUOTED_SPAN, " ");
  for (const pattern of side === "zh" ? ZH_GATE2_CLOSURE : EN_GATE2_CLOSURE) {
    const hit = scan.match(pattern);
    if (!hit || hit.index === undefined) continue;
    const clauseNegation = side === "zh" ? ZH_CLAUSE_NEGATION : EN_CLAUSE_NEGATION;
    if (clauseNegation.test(scan.slice(0, hit.index))) continue;
    gaps.push(`${where}：门禁②行出现「缺口已闭合」式反转表述（命中「${hit[0]}」）`);
  }
  return gaps;
}

/** 单个门禁行的检查器：定位唯一门禁行 → 必需短语齐全 → 极性未被反转。 */
function gateLineGaps(
  text: string,
  spec: { label: string; lineAnchors: readonly string[]; needles: readonly string[]; language?: "zh" | "en" },
): string[] {
  const where = spec.language ? `${spec.label} ${spec.language}` : spec.label;
  const hit = lineWithAll(text, spec.lineAnchors);
  if (hit.count !== 1) return [`${where}：门禁②行定位失败（命中 ${hit.count} 行，应为 1）`];

  const gaps = spec.needles
    .filter((needle) => !hit.line.includes(needle))
    .map((needle) => `${where}：门禁②行缺缺口标注「${needle}」`);
  if (gaps.length === 0 && spec.language) gaps.push(...polarityGaps(hit.line, spec.needles, where, spec.language));
  return gaps;
}

/** 指南检查器：门禁②行短语齐全 + 极性未被反转 + zh/en 行数严格相等。返回缺口列表（空 = 通过）。 */
function guideGapGaps(zh: string, en: string, label: string): string[] {
  const gaps = [
    ...gateLineGaps(zh, {
      label,
      lineAnchors: ZH_GATE2_LINE_ANCHORS,
      needles: ZH_GATE2_ANNOTATION,
      language: "zh",
    }),
    ...gateLineGaps(en, {
      label,
      lineAnchors: EN_GATE2_LINE_ANCHORS,
      needles: EN_GATE2_ANNOTATION,
      language: "en",
    }),
  ];
  const zhLines = zh.split("\n").length;
  const enLines = en.split("\n").length;
  if (zhLines !== enLines) gaps.push(`${label}：zh/en 指南行数不等（${zhLines} vs ${enLines}）`);
  return gaps;
}

/**
 * 门禁定义检查器：`core/review-policy.ts`（及其编译产物）的两处标注各自锚定一行——
 * 定义注释行与失败文案行分别校验，避免「删掉一处、另一处仍在」被漏过。
 */
function policyGapGaps(policy: string, label: string): string[] {
  return [
    ...gateLineGaps(policy, {
      label: `${label} 门禁②定义注释`,
      lineAnchors: POLICY_DEF_LINE_ANCHORS,
      needles: POLICY_DEF_ANNOTATION,
    }),
    ...gateLineGaps(policy, {
      label: `${label} 门禁②失败文案`,
      lineAnchors: POLICY_DETAIL_LINE_ANCHORS,
      needles: POLICY_DETAIL_ANNOTATION,
    }),
  ];
}

// ---------------------------------------------------------------------------
// 合成夹具（**不读取、不切片任何真实文件**）
// ---------------------------------------------------------------------------

/** 合成门禁②行的**标准排列**——与真实文件当前排列无关；必需短语逐字取自真实标注。 */
const ZH_ANNOTATION_LITERAL =
  "覆盖缺口如实标注——`tsconfig.json` 的 `include` 仅 `core/*.ts`，`core/tests` 与 host 的 `.js` 不在其内；";
const EN_ANNOTATION_LITERAL =
  "state the coverage gap honestly—the `include` of `tsconfig.json` is only `core/*.ts`, " +
  "so `core/tests` and host `.js` fall outside it;";
/** 去掉缺口标注、只留命令的门禁②行（模拟「静默删除」与「搬行」）。 */
const ZH_STUB_LINE = `2. 类型检查：\`${TSC_COMMAND}\` → \`exit_code=0\`；`;
const EN_STUB_LINE = `2. Type check: \`${TSC_COMMAND}\` → \`exit_code=0\`;`;
const ZH_SYNTH_GATE2 = `${ZH_STUB_LINE}${ZH_ANNOTATION_LITERAL}`;
const EN_SYNTH_GATE2 = `${EN_STUB_LINE} ${EN_ANNOTATION_LITERAL}`;

/** 合成 zh/en 指南：两侧行数由构造保证相等（不足侧补空行），不影响门禁②行定位。 */
function synthGuides(
  zhGate2: string = ZH_SYNTH_GATE2,
  enGate2: string = EN_SYNTH_GATE2,
  zhTrailing: readonly string[] = [],
): { zh: string; en: string } {
  const zhLines = ["1. 全量测试：`node --test core/tests/*.test.ts` → `exit_code=0`；", zhGate2, ...zhTrailing];
  const enLines = ["1. Full test suite: `node --test core/tests/*.test.ts` → `exit_code=0`;", enGate2];
  const width = Math.max(zhLines.length, enLines.length);
  const pad = (lines: readonly string[]) => [...lines, ...Array<string>(width - lines.length).fill("")].join("\n");
  return { zh: pad(zhLines), en: pad(enLines) };
}

/** 合成门禁定义文本：定义注释行 + 失败文案行（与 `core/review-policy.ts` 同形）。 */
const POLICY_SYNTH_DEF =
  " * ② 类型检查：`tsc --noEmit -p tsconfig.json` → `exit_code === 0`（**仅覆盖 core 层**，缺口已在指南如实标注）；";
const POLICY_SYNTH_DETAIL = `        : \`② ${TSC_COMMAND} → exit_code=0（要求 0；仅覆盖 core 层）\`,`;
function synthPolicy(defLine: string = POLICY_SYNTH_DEF, detailLine: string = POLICY_SYNTH_DETAIL): string {
  return ["// 合成门禁定义", defLine, "        ? NO_SIGNAL", detailLine, ""].join("\n");
}

/**
 * 断言「改坏后**必红**，且首报是**准确的门禁断言**」。
 * `expect` 是该类改坏专属的措辞（缺哪条短语 / 哪种反转），因此这条断言同时排除两种空转：
 * 夹具没构造出来（那会红在别的原因上）与红灯来自「门禁②行定位失败」。
 */
function assertRed(gaps: string[], expect: string, what: string): void {
  assert.ok(gaps[0]?.includes(expect), `${what}：改坏后首报须是准确的门禁断言（含「${expect}」）：${gaps.join("；")}`);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`${BUILD_HINT}\n读取失败：${relative(repoRoot, path)}`);
  }
}

// ---------------------------------------------------------------------------
// 判据 1 + 判据 2：真实文件路径——只断言「当前 GREEN」与「源 == dist」
// ---------------------------------------------------------------------------

test("g-335 判据 1/2：指南源文件门禁②行如实标注覆盖缺口，且 zh/en 行数严格相等", () => {
  const gaps = guideGapGaps(readText(ZH_GUIDE_SRC), readText(EN_GUIDE_SRC), "源指南");
  assert.deepEqual(gaps, [], gaps.join("\n"));
});

test("g-335 判据 1/2：core/review-policy.ts 门禁定义注释与失败文案均标注「仅覆盖 core 层」", () => {
  const gaps = policyGapGaps(readText(POLICY_SRC), "review-policy.ts 源文件");
  assert.deepEqual(gaps, [], gaps.join("\n"));
});

test("g-335 判据 1/2：dist 产物同样保留缺口标注，且指南 dist 与源逐字相同", () => {
  const gaps = [
    ...guideGapGaps(readText(ZH_GUIDE_DIST), readText(EN_GUIDE_DIST), "dist 指南"),
    ...policyGapGaps(readText(POLICY_DIST), "dist/core/review-policy.js"),
  ];
  assert.deepEqual(gaps, [], `${BUILD_HINT}\n${gaps.join("\n")}`);
  assert.equal(readText(ZH_GUIDE_DIST), readText(ZH_GUIDE_SRC), "要发布的那一份（dist zh 指南）必须与源逐字相同");
  assert.equal(readText(EN_GUIDE_DIST), readText(EN_GUIDE_SRC), "要发布的那一份（dist en 指南）必须与源逐字相同");
});

// ---------------------------------------------------------------------------
// 判据 2：判别力（合成夹具驱动同一检查函数，改坏即红）
// ---------------------------------------------------------------------------

test("g-335 判据 2：六类改坏（合成夹具）全部必红，且首报是准确的门禁断言", () => {
  const [zhNeedle1, zhNeedle2] = ZH_GATE2_ANNOTATION as [string, string, string];
  const [enNeedle1] = EN_GATE2_ANNOTATION as [string, string, string];

  // 搬行夹具：标注被搬到**门禁①行**（仍在文本中，只是不在门禁②行）——「别处还在」不得救活它。
  const moved = synthGuides(ZH_STUB_LINE, EN_SYNTH_GATE2, [ZH_ANNOTATION_LITERAL]);
  assert.ok(moved.zh.includes(ZH_ANNOTATION_LITERAL), "搬行夹具失控：标注未落到另一行");

  const cases: Array<{ name: string; guide: { zh: string; en: string }; expect: string }> = [
    {
      name: "① 删缺口语义（门禁②行整段标注被删）",
      guide: synthGuides(ZH_STUB_LINE),
      expect: `缺缺口标注「覆盖缺口如实标注」`,
    },
    { name: "② 搬行（标注挪到门禁①行）", guide: moved, expect: `缺缺口标注「覆盖缺口如实标注」` },
    {
      name: "③ en 语义反转（改成 covers the whole repository）",
      guide: synthGuides(undefined, `${EN_STUB_LINE} the type check covers the whole repository;`),
      expect: `缺缺口标注「${enNeedle1}」`,
    },
    {
      name: "④ 针内改写（`include` 仅 → `include` 覆盖）",
      guide: synthGuides(ZH_SYNTH_GATE2.replace(zhNeedle2, "`include` 覆盖 `core/*.ts`")),
      expect: `缺缺口标注「${zhNeedle2}」`,
    },
    {
      name: "⑤ 针间反转断语（针间插「此缺口其实已修复，`core/tests` 已纳入类型检查」）",
      guide: synthGuides(ZH_SYNTH_GATE2.replace(zhNeedle2, `${zhNeedle2}，此缺口其实已修复，\`core/tests\` 已纳入类型检查`)),
      expect: "缺口已闭合",
    },
    {
      name: "⑥ 前置否定词（针前加「不」）",
      guide: synthGuides(ZH_SYNTH_GATE2.replace(zhNeedle1, `不${zhNeedle1}`)),
      expect: "前置否定词",
    },
  ];
  for (const { name, guide, expect } of cases) {
    assertRed(guideGapGaps(guide.zh, guide.en, "合成指南"), expect, name);
  }

  // 门禁定义侧的两处标注同样「删除即红」，且首报点名缺的是哪一条短语。
  const policyCases: Array<{ name: string; policy: string; expect: string }> = [
    {
      name: "⑦ 定义注释行删「缺口已在指南如实标注」",
      policy: synthPolicy(POLICY_SYNTH_DEF.replace("，缺口已在指南如实标注", "")),
      expect: "缺缺口标注「缺口已在指南如实标注」",
    },
    {
      name: "⑧ 失败文案行删「仅覆盖 core 层」",
      policy: synthPolicy(POLICY_SYNTH_DEF, POLICY_SYNTH_DETAIL.replace("；仅覆盖 core 层", "")),
      expect: "缺缺口标注「仅覆盖 core 层」",
    },
  ];
  for (const { name, policy, expect } of policyCases) {
    assertRed(policyGapGaps(policy, "合成门禁定义"), expect, name);
  }
});

test("g-335 判据 2：合法同行编辑与支持缺口存在的表述一律不误红（合成夹具）", () => {
  const [zhNeedle1, zhNeedle2, zhNeedle3] = ZH_GATE2_ANNOTATION as [string, string, string];

  const benign: Array<{ name: string; guide: { zh: string; en: string } }> = [
    // NR1：标注整段挪到门禁标签**之前**（同行）——att-004 曾因按标签切真实行而误红。
    {
      name: "NR1 标注整段前置到门禁标签之前（同行）",
      guide: synthGuides(`${ZH_ANNOTATION_LITERAL}${ZH_STUB_LINE}`),
    },
    // NR2：子句重排——outside 在前、命令居中、marker+include 在后（同行）。
    {
      name: "NR2 子句重排（outside → 命令 → marker+include，同行）",
      guide: synthGuides(
        `2. 类型检查：${zhNeedle3}；\`${TSC_COMMAND}\` → \`exit_code=0\`；${zhNeedle1}——\`tsconfig.json\` 的 ${zhNeedle2}；`,
      ),
    },
    // NR3：同一行内重复一次缺口子句。
    { name: "NR3 同行重复一次缺口子句", guide: synthGuides(`${ZH_SYNTH_GATE2}${ZH_ANNOTATION_LITERAL}`) },
    // 标点变化（标注后的「——」→「：」）。
    { name: "标点变化（标注后的「——」→「：」）", guide: synthGuides(ZH_SYNTH_GATE2.replace("——", "：")) },
    // 针间插中性短语。
    {
      name: "针间插中性短语（（本项为说明性文字））",
      guide: synthGuides(ZH_SYNTH_GATE2.replace(zhNeedle1, `${zhNeedle1}（本项为说明性文字）`)),
    },
    // NR4：极性层反向误红的四例——它们都**不**否认缺口存在。
    {
      name: "NR4a en「not fully covered」（支持缺口存在）",
      guide: synthGuides(undefined, `${EN_SYNTH_GATE2} the repository is therefore not fully covered.`),
    },
    {
      name: "NR4b en「the gap is covered in the guide」（= 已记录）",
      guide: synthGuides(undefined, `${EN_SYNTH_GATE2} the gap is covered in the guide.`),
    },
    {
      name: "NR4c zh「本项并非「缺口已修复」」（引用被反驳的说法）",
      guide: synthGuides(`${ZH_SYNTH_GATE2}本项并非「缺口已修复」。`),
    },
    {
      name: "NR4d zh 异主语「host 的 `.js` 已纳入类型检查」（与 core 层缺口无关）",
      guide: synthGuides(`${ZH_SYNTH_GATE2}host 的 \`.js\` 已纳入类型检查。`),
    },
  ];
  for (const { name, guide } of benign) {
    assert.deepEqual(guideGapGaps(guide.zh, guide.en, "合成指南"), [], `${name}（语义不变）不应误红`);
  }
});

// ---------------------------------------------------------------------------
// 判据 3 + 判据 4：脚本暴露与「不引入全仓/测试类型门禁」的裁定守卫
// ---------------------------------------------------------------------------

test("g-335 判据 3：package.json 提供 typecheck 脚本暴露门禁②命令，且未接进 build/prepare", () => {
  const pkg = JSON.parse(readText(join(repoRoot, "package.json"))) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};

  const typecheck = scripts.typecheck ?? "";
  assert.ok(
    typecheck.includes("tsc --noEmit -p tsconfig.json"),
    `typecheck 脚本须暴露门禁②命令 \`tsc --noEmit -p tsconfig.json\`（实际：「${typecheck}」）`,
  );

  for (const chained of ["build", "prepare"]) {
    assert.ok(
      !(scripts[chained] ?? "").includes("typecheck"),
      `${chained} 脚本不得接进 typecheck（判据 3：不得作为新的放行门禁或 build 流程的一环）`,
    );
  }
});

test("g-335 判据 4：tsconfig 仍只含 core 层、仍排除 core/tests，且不存在 tests 专用宽松 tsconfig", () => {
  const tsconfig = JSON.parse(readText(join(repoRoot, "tsconfig.json"))) as {
    include?: string[];
    exclude?: string[];
  };

  assert.deepEqual(tsconfig.include, ["core/*.ts"], "判据 4：不得把 core/tests 或全仓纳入 include（被否决的方案①）");
  assert.ok((tsconfig.exclude ?? []).includes("core/tests"), "判据 4：exclude 必须仍含 core/tests");
  assert.ok(!(tsconfig.include ?? []).some((p) => p.includes("dsh-graph-host")), "判据 4：host 的 .js 不得被纳入类型检查");

  const extraTsconfigs = walkRepoFiles().filter(
    (path) => /^tsconfig.*\.json$/.test(path.split("/").pop() ?? "") && path !== "tsconfig.json",
  );
  assert.deepEqual(
    extraTsconfigs,
    [],
    "判据 4：不得新建 tests 专用宽松 tsconfig（被否决的方案②）——扫描范围为全仓非忽略目录，host 目录同样在内",
  );
});

test("g-346 判据 1：tsconfig 扫描覆盖全仓非忽略目录（含 dsh-graph-host/），且排除依赖/产物/隔离工作树", () => {
  const files = walkRepoFiles();

  // 正向：扫描确实递归进 dsh-graph-host/（旧实现只扫 repoRoot + core/，host 目录的绕过因此看不见）。
  assert.ok(
    files.includes("dsh-graph-host/supervisor-guide.zh.md"),
    "判据 4 收敛失效：tsconfig 扫描未覆盖 dsh-graph-host/（host 内的宽松 tsconfig 可绕过守护）",
  );
  assert.ok(files.includes("core/review-policy.ts"), "判据 4 收敛失效：扫描未覆盖 core/");

  // 反向：忽略目录不得被扫入，否则会在依赖/产物/其他 attempt 工作树里误报红。
  for (const prefix of ["node_modules/", ".git/", ".worktrees/", "dist/", "core-dist/", "tmp/"]) {
    assert.deepEqual(
      files.filter((path) => path.startsWith(prefix)),
      [],
      `判据 4 收敛：扫描范围不得包含忽略目录 ${prefix}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 判据 4 收敛（问题①）：扫描范围工具
// ---------------------------------------------------------------------------

/**
 * g-346 判据 4 收敛（问题①）：tsconfig 扫描跳过的目录。
 *
 * 旧实现只扫 `repoRoot` 与 `core/` 两层——实测在 `dsh-graph-host/tsconfig.tests.json` 放一个宽松
 * tsconfig，守护仍然全绿，即「把 core/tests 纳入类型检查」的偷偷回归可从 host 目录绕过。
 * 现改为递归「全仓非忽略目录」；跳过项与 `.gitignore` 的忽略口径一致
 * （依赖、VCS、隔离工作树、生成物、临时目录、看板内层仓库），避免把生成物/数据误判为绕过。
 */
const SCAN_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".worktrees",
  "dist",
  "core-dist",
  "tmp",
  "probe",
  "handoffs",
  ".dsh-graph",
]);

/** 递归列出「全仓非忽略文件」相对 repoRoot 的路径（`/` 分隔，便于负向/正向对照断言）。 */
function walkRepoFiles(dir: string = repoRoot): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      out.push(...walkRepoFiles(join(dir, entry.name)));
    } else if (entry.isFile()) {
      out.push(relative(repoRoot, join(dir, entry.name)));
    }
  }
  return out;
}
