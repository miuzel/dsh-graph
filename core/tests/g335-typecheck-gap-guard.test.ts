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
 *             且不存在 tests 专用宽松 tsconfig（即不得退回被否决的①②）。
 *
 * 反自我满足设计（与 g-313 / g-311 同一口径，不另立第二套规则）：
 *  1. 断言逐字比对**承载 tsc 命令的那一行**与其**锚点行**（`lineWithAll` 要求同一行命中全部
 *     anchors），而不是「关键词在全文某处出现」——把标注搬走、挪到无关段落同样必红；
 *  2. 负向对照在内存里对真实文本做定点破坏后重放**同一个检查器**，并断言真实文件逐字节未变
 *     （hermetic，不污染工作树、不依赖 worktree）；定点破坏自 g-346 问题② 起改为**anchors 定位式**
 *     （`spliceAnchoredRegion` / `moveAnchoredRegion`）——删除「门禁②行内命中标注 anchors 的那些区段」，
 *     而非删固定字面量，故同一行内的合法重排不再让负向对照自身误红；
 *     自 att-004（R1 收敛）起，删除/搬迁**逐针独立**进行（`locateAnchorSpans`：逐个锚点定位、互不重叠），
 *     不再取「首针起点 → 末针终点」的单一跨距——交错形态（两针分别在 tsc 命令前后、仍在同一行）下，
 *     该跨距会把**行锚点（tsc 命令）**一起包进被删区段，删完行锚点就消失，于是合法的同行重排被误判成
 *     「门禁②行定位失败」（R1 最小复现）。逐针删除只动标注针本身，命令与针间填塞内容原样保留；
 *  3. 锚点定位之外补一层**极性判别**（R2）：缺口标注既不得被否定、也不得声称缺口已闭合——
 *     三针齐全但极性反转（针间插「此缺口其实已修复，`core/tests` 已纳入类型检查」、针前加「不」）同样必红；
 *     判别边界如实声明：否定词判别是结构化的（任意否定词紧贴针前置，见 `NEGATION_TAIL`），
 *     闭合断言判别是按**极性措辞族**枚举的（同义改写仍可能漏网，见 `ZH_GATE2_FALSIFYING` /
 *     `EN_GATE2_FALSIFYING`）——「针间插中性短语」须保持绿、无法与「针间插反转断语」靠结构区分；
 *  4. 源文件与 dist 产物**双侧**断言：源侧守护「静默删除」，dist 侧守护「要发布的那一份」。
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

/**
 * g-346 判据 2 收敛（问题②）：门禁②行的**定位锚点**。
 * 检查器与负向对照共用同一组锚点，负向对照因此不再依赖「缺口标注能原样连续出现」。
 */
const ZH_GATE2_LINE_ANCHORS = ["2. 类型检查：", TSC_COMMAND];
const EN_GATE2_LINE_ANCHORS = ["2. Type check:", TSC_COMMAND];
const POLICY_DEF_LINE_ANCHORS = ["② 类型检查：", "缺口已在指南如实标注"];
const POLICY_DETAIL_LINE_ANCHORS = [`② ${TSC_COMMAND}`, "要求 0；"];

const BUILD_HINT =
  "门禁断言读取源文件与 dist 产物：请先运行 `bash scripts/build.sh` 再跑测试（dist/ 是生成物，禁止手改）";

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

/**
 * zh 门禁②行缺口标注的**旧**完整字面量（不含前导「；」）。
 * g-346 问题② 后不再用于构造负样本（改用 anchors 定位），只用于「行内重排自证」：
 * 证明重排会让该字面量消失——旧的字面量式负向对照正因此误红。
 */
const ZH_GAP_TEXT =
  "覆盖缺口如实标注——`tsconfig.json` 的 `include` 仅 `core/*.ts`，`core/tests` 与 host 的 `.js` 不在其内";

/** 指南门禁②行必须逐字命中的缺口标注片段（缺任一即红）。 */
const ZH_GATE2_ANNOTATION = [
  "覆盖缺口如实标注",
  "`include` 仅 `core/*.ts`",
  "`core/tests` 与 host 的 `.js` 不在其内",
];
const EN_GATE2_ANNOTATION = [
  "state the coverage gap honestly",
  "the `include` of `tsconfig.json` is only `core/*.ts`",
  "`core/tests` and host `.js` fall outside it",
];

/** `core/review-policy.ts` 门禁②定义注释行与失败文案行必须命中的缺口标注片段。 */
const POLICY_DEF_ANNOTATION = ["仅覆盖 core 层", "缺口已在指南如实标注"];
const POLICY_DETAIL_ANNOTATION = ["仅覆盖 core 层"];

/**
 * g-346 att-004（R2 收敛）：门禁②行的**极性判别**。
 *
 * 三针齐全 ≠ 语义正确：针间插一段中性短语（须绿）与针间插一段「此缺口其实已修复」式的反转断语
 * （必须红）在**锚点结构上完全同形**，`includes` 与定位式锚点都无法区分。故补两层判别：
 *  - 否定词判别（结构化）：任一标注针紧邻其前若是否定词（zh「不覆盖缺口如实标注」、
 *    en「not state the coverage gap honestly」），标注即被反转 ⇒ 必红；
 *  - 闭合断言判别（极性措辞族）：行内出现「缺口…已修复/已纳入类型检查」「covers the whole
 *    repository」「no coverage gap」式断言，与「缺口如实标注」的裁定相反 ⇒ 必红。
 * 边界如实声明：第二层是措辞族枚举，非同义改写全覆盖；第一层对任意否定词生效。
 */
const ZH_GATE2_FALSIFYING: readonly RegExp[] = [
  /缺口[^，。；;、]{0,10}已\s*(?:修复|解决|闭合|补齐|覆盖|纳入|包含)/,
  /已\s*(?:纳入|包含)\s*(?:类型检查|`?core\/tests`?)/,
];
const EN_GATE2_FALSIFYING: readonly RegExp[] = [
  /\bgap\b[^,.;]{0,16}\b(?:is|has been|was)\s+(?:fixed|closed|covered|resolved)\b/i,
  /\bcovers?\s+the\s+whole\s+repositor/i,
  /\bfully\s+covered\b/i,
  /\bno\s+(?:coverage\s+)?gap\b/i,
];
/** 紧贴标注针之前的否定词（结构化判别，两种语言各自一套）。 */
const ZH_NEGATION_TAIL = /(?:不|未|非|无|没有|勿|别)\s*$/;
const EN_NEGATION_TAIL = /\b(?:not|no|never|without|isn't|doesn't|don't)\s*$/i;

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`${BUILD_HINT}\n读取失败：${relative(repoRoot, path)}`);
  }
}

/**
 * 定位「同一行同时含全部 anchors」的那一行；`count !== 1` 表示锚点失效（0）或不唯一（>1），
 * 两种情况都必须报红——否则删除标注会被「别处仍命中」掩盖。
 */
function lineWithAll(text: string, anchors: readonly string[]): { line: string; count: number } {
  const hits = text.split("\n").filter((line) => anchors.every((anchor) => line.includes(anchor)));
  return { line: hits[0] ?? "", count: hits.length };
}

type AnchorSpan = { start: number; end: number };

/**
 * g-346 att-004（R1 收敛）：在**行内**逐针独立定位标注锚点——每个锚点各自取首个命中位置，
 * 返回按起点排序、互不重叠的区段数组。
 *
 * 旧实现取「首针起点 → 末针终点」的**单一跨距**；当标注被拆成两半、tsc 命令夹在中间（两针分别在
 * 行锚点 `TSC_COMMAND` 的前后，仍在同一行）时，该跨距会把行锚点本身包进去，删除/替换跨距就
 * 连行锚点一起删掉 ⇒ 检查器报「门禁②行定位失败（命中 0 行）」，合法的同行重排被误红。
 * 逐针独立删除只动标注针，命令与针间填塞内容保持原样。
 *
 * 返回 null 表示任一标注锚点不在行内（负样本无法构造，属真实的对照失效）。
 */
function locateAnchorSpans(line: string, annotationAnchors: readonly string[]): AnchorSpan[] | null {
  const spans: AnchorSpan[] = [];
  for (const anchor of annotationAnchors) {
    const at = line.indexOf(anchor);
    if (at < 0) return null;
    spans.push({ start: at, end: at + anchor.length });
  }
  spans.sort((a, b) => a.start - b.start);
  // 锚点互为子串/重合时丢弃被包含的区段，避免同一段文本被删两次。
  const disjoint: AnchorSpan[] = [];
  for (const span of spans) if (!disjoint.some((kept) => span.start < kept.end)) disjoint.push(span);
  return disjoint;
}

/** 找到「同一行同时命中全部行锚点」的那一行（`count !== 1` 即锚点失效或不唯一）。 */
function locateAnchoredLine(
  text: string,
  lineAnchors: readonly string[],
): { index: number; line: string; count: number } {
  const lines = text.split("\n");
  const hits = lines.map((line, index) => ({ line, index })).filter(({ line }) => lineAnchors.every((a) => line.includes(a)));
  const first = hits[0];
  return { index: first?.index ?? -1, line: first?.line ?? "", count: hits.length };
}

/**
 * 定位式改写：只对「唯一命中行锚点」的那一行应用 `rewrite`。
 * 用于构造**文件级**变体（R1 交错形态、V4 针间插入、V5 针前加否定词等），与
 * 「把真实文件改坏再跑守护」的复核手法一一对应，而不只是构造负样本。
 */
function rewriteAnchoredLine(
  text: string,
  lineAnchors: readonly string[],
  rewrite: (line: string) => string,
): string | null {
  const hit = locateAnchoredLine(text, lineAnchors);
  if (hit.count !== 1) return null;
  const lines = text.split("\n");
  lines[hit.index] = rewrite(hit.line);
  return lines.join("\n");
}

/** 定位式改写：把门禁②行内命中全部标注 anchors 的那些区段**逐针删除**，并在**首针位置**插入 replacement。 */
function spliceAnchoredRegion(
  text: string,
  lineAnchors: readonly string[],
  annotationAnchors: readonly string[],
  replacement = "",
): string | null {
  const hit = locateAnchoredLine(text, lineAnchors);
  if (hit.count !== 1) return null;
  const spans = locateAnchorSpans(hit.line, annotationAnchors);
  if (!spans) return null;

  const lines = text.split("\n");
  let out = "";
  let cursor = 0;
  let inserted = false;
  for (const span of spans) {
    out += hit.line.slice(cursor, span.start);
    if (!inserted) {
      out += replacement;
      inserted = true;
    }
    cursor = span.end;
  }
  out += hit.line.slice(cursor);
  lines[hit.index] = out;
  return lines.join("\n");
}

/** 定位式搬迁：逐针删除门禁②行的标注针（行锚点与针间内容保持原样），把标注区段追加到 targetLineAnchor 所在行。 */
function moveAnchoredRegion(
  text: string,
  lineAnchors: readonly string[],
  annotationAnchors: readonly string[],
  targetLineAnchor: string,
): string | null {
  const hit = locateAnchoredLine(text, lineAnchors);
  if (hit.count !== 1) return null;
  const spans = locateAnchorSpans(hit.line, annotationAnchors);
  if (!spans) return null;

  const lines = text.split("\n");
  const targetIndex = lines.findIndex((line) => line.includes(targetLineAnchor));
  if (targetIndex < 0) return null;

  const payload = hit.line.slice(spans[0]!.start, spans[spans.length - 1]!.end);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += hit.line.slice(cursor, span.start);
    cursor = span.end;
  }
  out += hit.line.slice(cursor);

  lines[hit.index] = out;
  lines[targetIndex] = `${lines[targetIndex]!}${payload}`;
  return lines.join("\n");
}

/**
 * g-346 att-004（R2）：门禁②行的极性判别（针齐全之外的语义判别，见 `ZH_GATE2_FALSIFYING` 注释）。
 * 缺针情形由调用方报红，这里 `continue` 跳过，避免同一次失效被重复计数。
 */
function polarityGaps(
  line: string,
  needles: readonly string[],
  label: string,
  side: "zh" | "en",
): string[] {
  const gaps: string[] = [];
  const negationTail = side === "zh" ? ZH_NEGATION_TAIL : EN_NEGATION_TAIL;
  const falsifying = side === "zh" ? ZH_GATE2_FALSIFYING : EN_GATE2_FALSIFYING;

  for (const needle of needles) {
    const at = line.indexOf(needle);
    if (at < 0) continue;
    if (negationTail.test(line.slice(0, at))) {
      gaps.push(`${label}：${side} 门禁②行缺口标注被前置否定词反转（「${needle}」紧邻其前是否定词）`);
    }
  }
  for (const pattern of falsifying) {
    const hit = line.match(pattern);
    if (hit) gaps.push(`${label}：${side} 门禁②行出现「缺口已闭合」式反转表述（命中「${hit[0]}」）`);
  }
  return gaps;
}

/**
 * 指南检查器：门禁②行逐字含缺口标注 + 极性未被反转 + zh/en 行数相等。返回缺口列表（空 = 通过）。
 * 抽成纯函数是为了让负向对照能在内存里破坏真实文本后重放**同一套判定**。
 */
function guideGapGaps(zh: string, en: string, label: string): string[] {
  const gaps: string[] = [];

  const zhHit = lineWithAll(zh, ZH_GATE2_LINE_ANCHORS);
  if (zhHit.count !== 1) gaps.push(`${label}：zh 指南门禁②行定位失败（命中 ${zhHit.count} 行，应为 1）`);
  else {
    for (const needle of ZH_GATE2_ANNOTATION) if (!zhHit.line.includes(needle)) gaps.push(`${label}：zh 门禁②行缺缺口标注「${needle}」`);
    gaps.push(...polarityGaps(zhHit.line, ZH_GATE2_ANNOTATION, label, "zh"));
  }

  const enHit = lineWithAll(en, EN_GATE2_LINE_ANCHORS);
  if (enHit.count !== 1) gaps.push(`${label}：en 指南门禁②行定位失败（命中 ${enHit.count} 行，应为 1）`);
  else {
    for (const needle of EN_GATE2_ANNOTATION) if (!enHit.line.includes(needle)) gaps.push(`${label}：en 门禁②行缺缺口标注「${needle}」`);
    gaps.push(...polarityGaps(enHit.line, EN_GATE2_ANNOTATION, label, "en"));
  }

  const zhLines = zh.split("\n").length;
  const enLines = en.split("\n").length;
  if (zhLines !== enLines) gaps.push(`${label}：zh/en 指南行数不等（${zhLines} vs ${enLines}）`);

  return gaps;
}

/**
 * 门禁定义检查器：`core/review-policy.ts`（及其编译产物）的两处标注各自锚定一行——
 * 定义注释行（② 定义 + 「缺口已在指南如实标注」）与失败文案行（② 命令 + 「要求 0；」）。
 * 两处分别校验，避免「删掉一处、另一处仍在」被漏过。
 */
function policyGapGaps(policy: string, label: string): string[] {
  const gaps: string[] = [];

  const defHit = lineWithAll(policy, POLICY_DEF_LINE_ANCHORS);
  if (defHit.count !== 1) gaps.push(`${label}：门禁②定义注释行定位失败（命中 ${defHit.count} 行，应为 1）`);
  else for (const needle of POLICY_DEF_ANNOTATION) if (!defHit.line.includes(needle)) gaps.push(`${label}：门禁②定义注释缺「${needle}」`);

  const detailHit = lineWithAll(policy, POLICY_DETAIL_LINE_ANCHORS);
  if (detailHit.count !== 1) gaps.push(`${label}：门禁②失败文案行定位失败（命中 ${detailHit.count} 行，应为 1）`);
  else for (const needle of POLICY_DETAIL_ANNOTATION) if (!detailHit.line.includes(needle)) gaps.push(`${label}：门禁②失败文案缺「${needle}」`);

  return gaps;
}

// ---------------------------------------------------------------------------
// 判据 1 + 判据 2：源侧守护（静默删除即红）
// ---------------------------------------------------------------------------

test("g-335 判据 1/2：指南源文件门禁②行如实标注覆盖缺口，且 zh/en 行数严格相等", () => {
  const gaps = guideGapGaps(readText(ZH_GUIDE_SRC), readText(EN_GUIDE_SRC), "源指南");
  assert.deepEqual(gaps, [], gaps.join("\n"));
});

test("g-335 判据 1/2：core/review-policy.ts 门禁定义注释与失败文案均标注「仅覆盖 core 层」", () => {
  const gaps = policyGapGaps(readText(POLICY_SRC), "review-policy.ts 源文件");
  assert.deepEqual(gaps, [], gaps.join("\n"));
});

// ---------------------------------------------------------------------------
// 判据 1 + 判据 2：dist 侧守护（要发布的那一份同样不得丢标注）
// ---------------------------------------------------------------------------

test("g-335 判据 1/2：dist 产物（指南与 core/review-policy.js）同样保留缺口标注", () => {
  const gaps = [
    ...guideGapGaps(readText(ZH_GUIDE_DIST), readText(EN_GUIDE_DIST), "dist 指南"),
    ...policyGapGaps(readText(POLICY_DIST), "dist/core/review-policy.js"),
  ];
  assert.deepEqual(gaps, [], `${BUILD_HINT}\n${gaps.join("\n")}`);
});

// ---------------------------------------------------------------------------
// 判据 2：判别力自证（负向对照改坏即红）+ hermetic
// ---------------------------------------------------------------------------

test("g-335 判据 2：分别删除/改写四处缺口说明中的任一情形必红，且同行重排不误红、负向对照不污染工作树", () => {
  const zhGuide = readText(ZH_GUIDE_SRC);
  const enGuide = readText(EN_GUIDE_SRC);
  const policy = readText(POLICY_SRC);

  // 前提：正样本本身必须全绿，否则下面的负向对照没有判别力。
  assert.deepEqual(guideGapGaps(zhGuide, enGuide, "源指南"), [], "负向对照前提不成立：源指南本来就不绿");
  assert.deepEqual(policyGapGaps(policy, "review-policy.ts 源文件"), [], "负向对照前提不成立：门禁定义本来就不绿");

  // 负向对照 1：zh 侧删掉缺口标注整段（模拟「静默删除」）→ 必红。
  // 定位方式为 anchors（门禁②行 + 行内标注锚点区段），不再依赖固定字面量连续出现。
  const zhDropped = spliceAnchoredRegion(zhGuide, ZH_GATE2_LINE_ANCHORS, ZH_GATE2_ANNOTATION);
  assert.ok(zhDropped !== null, "负向对照失效：zh 指南门禁②行未同时命中线锚点与缺口标注锚点");
  assert.notEqual(zhDropped, zhGuide, "负向对照失效：zh 缺口标注定位删除未改变文本");
  assert.ok(guideGapGaps(zhDropped, enGuide, "源指南").length > 0, "删掉 zh 缺口标注后竟然仍绿");

  // 负向对照 2：en 侧改写缺口标注（语句在、语义反转）→ 必红。
  const enRewritten = spliceAnchoredRegion(
    enGuide,
    EN_GATE2_LINE_ANCHORS,
    EN_GATE2_ANNOTATION,
    "the type check covers the whole repository",
  );
  assert.ok(enRewritten !== null, "负向对照失效：en 指南门禁②行未同时命中线锚点与缺口标注锚点");
  assert.notEqual(enRewritten, enGuide, "负向对照失效：en 缺口标注定位改写未改变文本");
  assert.ok(guideGapGaps(zhGuide, enRewritten, "源指南").length > 0, "改写 en 缺口标注后竟然仍绿");

  // 负向对照 3：门禁定义注释行删掉「缺口已在指南如实标注」→ 必红。
  const defDropped = spliceAnchoredRegion(policy, POLICY_DEF_LINE_ANCHORS, POLICY_DEF_ANNOTATION);
  assert.ok(defDropped !== null, "负向对照失效：未定位到定义注释行的缺口说明锚点");
  assert.notEqual(defDropped, policy, "负向对照失效：定义注释锚点定位删除未改变文本");
  assert.ok(policyGapGaps(defDropped, "review-policy.ts 源文件").length > 0, "删掉定义注释缺口说明后竟然仍绿");

  // 负向对照 4：失败文案行删掉「仅覆盖 core 层」→ 必红（只看定义注释会漏掉这一处）。
  const detailDropped = spliceAnchoredRegion(policy, POLICY_DETAIL_LINE_ANCHORS, POLICY_DETAIL_ANNOTATION);
  assert.ok(detailDropped !== null, "负向对照失效：未定位到失败文案行的缺口说明锚点");
  assert.notEqual(detailDropped, policy, "负向对照失效：失败文案锚点定位删除未改变文本");
  assert.ok(policyGapGaps(detailDropped, "review-policy.ts 源文件").length > 0, "删掉失败文案缺口说明后竟然仍绿");

  // 负向对照 5：把缺口标注**搬到另一行**（门禁①行），行数不变 → 仍必红。
  // 这一对照必须与「行数不变量」解耦，否则无法证明判据锚定的是「门禁②这一行」而非全文任一处。
  const movedOut = moveAnchoredRegion(zhGuide, ZH_GATE2_LINE_ANCHORS, ZH_GATE2_ANNOTATION, "  1. 全量测试：");
  assert.ok(movedOut !== null, "负向对照失效：未找到可搬迁的缺口标注区段或目标行");
  assert.notEqual(movedOut, zhGuide, "负向对照失效：搬迁未改变 zh 指南");
  assert.equal(movedOut.split("\n").length, zhGuide.split("\n").length, "负向对照 5 失控：搬迁不得改变行数");
  // R3 收敛：此处的循环原先断言「搬迁后的全文里仍含三针」——而搬迁载荷本身就是由三针拼出来的，
  // 该断言对 locator 输出恒真、不构成任何判别力。改为断言**搬迁的后置条件**：
  // 门禁②行仍唯一可定位（逐针搬迁不得把行锚点带走）、且该行已不含任何标注针。
  const movedGate2 = locateAnchoredLine(movedOut, ZH_GATE2_LINE_ANCHORS);
  assert.equal(movedGate2.count, 1, "负向对照 5 失控：搬迁后门禁②行锚点应仍唯一可定位（逐针搬迁不得删掉行锚点）");
  for (const anchor of ZH_GATE2_ANNOTATION) {
    assert.ok(!movedGate2.line.includes(anchor), `负向对照 5 失控：搬迁后门禁②行不应再含标注锚点「${anchor}」`);
  }
  const movedTargetLine = movedOut.split("\n").find((line) => line.includes("  1. 全量测试：")) ?? "";
  assert.ok(
    ZH_GATE2_ANNOTATION.every((anchor) => movedTargetLine.includes(anchor)),
    "负向对照 5 失控：搬迁后的标注应整体落在目标行（门禁①行）上",
  );
  const movedGaps = guideGapGaps(movedOut, enGuide, "源指南");
  assert.ok(movedGaps.length > 0, "缺口标注被搬离门禁②行后竟然仍绿");
  assert.ok(
    movedGaps.every((gap) => !gap.includes("定位失败")),
    `负向对照 5 首报必须是准确的门禁断言（缺标注），而非误导性的「门禁②行定位失败」：${movedGaps.join("；")}`,
  );

  // 负向对照 6：zh/en 行数被破坏 → 必红。
  assert.ok(guideGapGaps(zhGuide, `${enGuide}\nextra line\n`, "源指南").length > 0, "en 指南行数被破坏后竟然仍绿");

  // g-346 问题② 自证：**同一条门禁②行内重排**（语义不变、行数不变）→ 必须绿。
  // 旧实现用 `.replace("；" + ZH_GAP_TEXT, "")` 构造负样本，重排后该前置 `assert.notEqual` 会报红
  //（「负向对照失效」）——合法编辑红在错误原因上。现改为 anchors 定位，重排后仍应可定位、可判别。
  const [zhAnchorMarker, zhAnchorInclude, zhAnchorOutside] = ZH_GATE2_ANNOTATION as [string, string, string];
  const [enAnchorHonest, enAnchorInclude, enAnchorOutside] = EN_GATE2_ANNOTATION as [string, string, string];
  const reorderedGuide = spliceAnchoredRegion(
    zhGuide,
    ZH_GATE2_LINE_ANCHORS,
    ZH_GATE2_ANNOTATION,
    `${zhAnchorMarker}——${zhAnchorOutside}，\`tsconfig.json\` 的 ${zhAnchorInclude}`,
  );
  assert.ok(reorderedGuide !== null, "重排对照失控：未定位到 zh 门禁②行的缺口标注区段");
  assert.equal(reorderedGuide.split("\n").length, zhGuide.split("\n").length, "重排对照失控：重排不得改变行数");
  assert.ok(
    !reorderedGuide.includes(ZH_GAP_TEXT),
    "重排对照失控：重排后不应再含旧的字面量片段（旧负向对照正是靠它定位，故重排会误红）",
  );
  for (const anchor of ZH_GATE2_ANNOTATION) {
    assert.ok(reorderedGuide.includes(anchor), `重排对照失控：重排后标注锚点「${anchor}」应仍在门禁②行内`);
  }
  assert.deepEqual(
    guideGapGaps(reorderedGuide, enGuide, "源指南"),
    [],
    "同一门禁②行内重排（语义不变）不应误红（g-346 问题②）",
  );
  // 重排后仍须能构造出「删除标注 → 必红」的负样本，证明 anchors 定位本身不依赖原排列。
  const droppedAfterReorder = spliceAnchoredRegion(reorderedGuide, ZH_GATE2_LINE_ANCHORS, ZH_GATE2_ANNOTATION);
  assert.ok(droppedAfterReorder !== null, "重排后 anchors 定位失效：无法构造删除负样本");
  assert.notEqual(droppedAfterReorder, reorderedGuide, "重排后 anchors 定位失效：删除未改变文本");
  assert.ok(
    guideGapGaps(droppedAfterReorder, enGuide, "源指南").length > 0,
    "重排后删掉缺口标注竟然仍绿（判别力被削弱）",
  );

  // -------------------------------------------------------------------------
  // R1（att-004 阻塞项）：标注**拆成两半、tsc 命令夹在中间**、仍在同一行 ⇒ 必须绿。
  // 这是复核者的最小复现形态：旧实现取「首针起点 → 末针终点」单一跨距，删除/替换该跨距时
  // 把**行锚点（tsc 命令）**一起删掉，于是检查器报「门禁②行定位失败（命中 0 行）」——
  // 合法的同行重排被误红，正是本目标要消灭的缺陷类。
  // 断言只依赖**构造出的行**的性质，不依赖真实文件当前是哪一种排列：否则文件自身合法重排后，
  // 这条自证又会变成新的误红源（原「重排后必须与文件不同」式断言正是这种形态）。
  // -------------------------------------------------------------------------
  const zhPrefix = (() => {
    const real = locateAnchoredLine(zhGuide, ZH_GATE2_LINE_ANCHORS).line;
    const at = real.indexOf(ZH_GATE2_LINE_ANCHORS[0]!);
    return real.slice(0, at + ZH_GATE2_LINE_ANCHORS[0]!.length);
  })();
  const zhCommandClause = `\`${TSC_COMMAND}\` → \`exit_code=0\`；`;
  const canonicalZhLine = `${zhPrefix}${zhCommandClause}${zhAnchorMarker}——\`tsconfig.json\` 的 ${zhAnchorInclude}，${zhAnchorOutside}；`;
  const interleavedZhLine = `${zhPrefix}${zhAnchorMarker}——\`tsconfig.json\` 的 ${zhAnchorInclude}；${zhCommandClause}${zhAnchorOutside}；`;
  assert.notEqual(canonicalZhLine, interleavedZhLine, "R1 对照失控：常规与交错两种排列必须真的不同");

  const applyZhLine = (line: string) => rewriteAnchoredLine(zhGuide, ZH_GATE2_LINE_ANCHORS, () => line);
  const canonicalGuide = applyZhLine(canonicalZhLine);
  const interleavedGuide = applyZhLine(interleavedZhLine);
  assert.ok(canonicalGuide !== null, "R1 复现失控：未定位到 zh 门禁②行（常规排列）");
  assert.ok(interleavedGuide !== null, "R1 复现失控：未定位到 zh 门禁②行（交错排列）");
  assert.equal(interleavedGuide.split("\n").length, zhGuide.split("\n").length, "R1 复现失控：交错重排不得改变行数");

  // 两种排列的差别**只在于**行锚点是否落在标注跨距之内——这正是旧实现的误红根因。
  const spanOf = (line: string) =>
    line.slice(line.indexOf(zhAnchorMarker), line.indexOf(zhAnchorOutside) + zhAnchorOutside.length);
  const canonicalGate2 = locateAnchoredLine(canonicalGuide, ZH_GATE2_LINE_ANCHORS);
  const interleavedGate2 = locateAnchoredLine(interleavedGuide, ZH_GATE2_LINE_ANCHORS);
  assert.equal(canonicalGate2.count, 1, "R1 对照失控：常规排列下门禁②行应唯一可定位");
  assert.equal(interleavedGate2.count, 1, "R1 复现失控：交错排列下门禁②行应仍唯一可定位");
  for (const anchor of [...ZH_GATE2_LINE_ANCHORS, ...ZH_GATE2_ANNOTATION]) {
    assert.ok(interleavedGate2.line.includes(anchor), `R1 复现失控：交错重排后「${anchor}」应仍在该行内`);
  }
  assert.ok(!spanOf(canonicalGate2.line).includes(TSC_COMMAND), "R1 对照失控：常规排列的标注跨距不应覆盖 tsc 命令");
  assert.ok(
    spanOf(interleavedGate2.line).includes(TSC_COMMAND),
    "R1 复现失控：交错形态的标注跨距本应覆盖 tsc 命令（否则复现的不是 R1）",
  );

  // 语义不变 ⇒ 两种排列都必须绿（旧实现对交错排列报「门禁②行定位失败」）。
  const zhArrangements: Array<[string, string]> = [
    ["常规排列", canonicalGuide],
    ["交错排列", interleavedGuide],
  ];
  for (const [name, guide] of zhArrangements) {
    assert.deepEqual(guideGapGaps(guide, enGuide, "源指南"), [], `R1：zh 门禁②行${name}（语义不变）不应误红`);
  }

  // 交错形态下逐针删除：不得带走行锚点，且删后仍必红（判别力不因修 R1 而削弱）。
  const interleavedDropped = spliceAnchoredRegion(interleavedGuide, ZH_GATE2_LINE_ANCHORS, ZH_GATE2_ANNOTATION);
  assert.ok(interleavedDropped !== null, "R1 收敛失效：交错形态下无法构造删除负样本");
  assert.notEqual(interleavedDropped, interleavedGuide, "R1 收敛失效：交错形态下删除未改变文本");
  assert.equal(
    locateAnchoredLine(interleavedDropped, ZH_GATE2_LINE_ANCHORS).count,
    1,
    "R1 回归：逐针删除不得连行锚点（tsc 命令）一起删掉——否则合法的同行重排又会被误判成「定位失败」",
  );
  const interleavedDroppedGaps = guideGapGaps(interleavedDropped, enGuide, "源指南");
  assert.ok(interleavedDroppedGaps.length > 0, "R1 收敛失效：交错形态下删掉缺口标注竟然仍绿");
  assert.ok(
    interleavedDroppedGaps.every((gap) => !gap.includes("定位失败")),
    `R1 收敛：删标注的首报应是「缺标注」而非「定位失败」：${interleavedDroppedGaps.join("；")}`,
  );

  // en 侧同形态（命令夹在标注中间）同样不得误红。
  const enPrefix = (() => {
    const real = locateAnchoredLine(enGuide, EN_GATE2_LINE_ANCHORS).line;
    const at = real.indexOf(EN_GATE2_LINE_ANCHORS[0]!);
    return real.slice(0, at + EN_GATE2_LINE_ANCHORS[0]!.length);
  })();
  const enCommandClause = `\`${TSC_COMMAND}\` → \`exit_code=0\`; `;
  const canonicalEnLine = `${enPrefix}${enCommandClause}${enAnchorHonest}—${enAnchorInclude}, so ${enAnchorOutside};`;
  const interleavedEnLine = `${enPrefix}${enAnchorHonest}—${enAnchorInclude}; ${enCommandClause}${enAnchorOutside};`;
  assert.notEqual(canonicalEnLine, interleavedEnLine, "R1 对照失控：en 常规与交错两种排列必须真的不同");

  const applyEnLine = (line: string) => rewriteAnchoredLine(enGuide, EN_GATE2_LINE_ANCHORS, () => line);
  const canonicalEn = applyEnLine(canonicalEnLine);
  const interleavedEn = applyEnLine(interleavedEnLine);
  assert.ok(canonicalEn !== null, "R1 复现失控：未定位到 en 指南门禁②行（常规排列）");
  assert.ok(interleavedEn !== null, "R1 复现失控：未定位到 en 指南门禁②行（交错排列）");
  const enArrangements: Array<[string, string]> = [
    ["常规排列", canonicalEn],
    ["交错排列", interleavedEn],
  ];
  for (const [name, guide] of enArrangements) {
    assert.equal(locateAnchoredLine(guide, EN_GATE2_LINE_ANCHORS).count, 1, `R1：en ${name}下门禁②行应唯一可定位`);
    assert.deepEqual(guideGapGaps(zhGuide, guide, "源指南"), [], `R1：en 门禁②行${name}（语义不变）不应误红`);
  }
  const interleavedEnDropped = spliceAnchoredRegion(interleavedEn, EN_GATE2_LINE_ANCHORS, EN_GATE2_ANNOTATION);
  assert.ok(interleavedEnDropped !== null, "R1 收敛失效：en 交错形态下无法构造删除负样本");
  assert.equal(
    locateAnchoredLine(interleavedEnDropped, EN_GATE2_LINE_ANCHORS).count,
    1,
    "R1 回归：en 交错形态逐针删除不得带走行锚点",
  );
  assert.ok(
    guideGapGaps(zhGuide, interleavedEnDropped, "源指南").length > 0,
    "R1 收敛失效：en 交错形态下删掉缺口标注竟然仍绿",
  );

  // -------------------------------------------------------------------------
  // R2（att-004）：三针齐全但**极性反转** ⇒ 必须红。
  // 旧实现（含 att-003）只查 `includes`，针间插什么、针前加什么都判不出来 ⇒ 这两类恒绿。
  // -------------------------------------------------------------------------
  // V4：针间插入「此缺口其实已修复，`core/tests` 已纳入类型检查」（三针齐全、结构完全合法）。
  const v4Guide = rewriteAnchoredLine(zhGuide, ZH_GATE2_LINE_ANCHORS, (line) =>
    line.replace(zhAnchorInclude, `${zhAnchorInclude}，此缺口其实已修复，\`core/tests\` 已纳入类型检查`),
  );
  assert.ok(v4Guide !== null, "R2 对照失效：未定位到 zh 门禁②行（V4）");
  assert.ok(
    v4Guide.includes(`${zhAnchorInclude}，此缺口其实已修复，\`core/tests\` 已纳入类型检查`),
    "R2 对照失控：V4 的反转断语未插入（否则这条对照是空转）",
  );
  assert.equal(v4Guide.split("\n").length, zhGuide.split("\n").length, "R2 对照失控：V4 不得改变行数");
  for (const anchor of ZH_GATE2_ANNOTATION) {
    assert.ok(v4Guide.includes(anchor), "R2 对照失控：V4 三针应仍齐全（否则退化为「缺标注」，不符 V4 形态）");
  }
  const v4Gaps = guideGapGaps(v4Guide, enGuide, "源指南");
  assert.ok(v4Gaps.length > 0, "R2：针间插入「此缺口其实已修复」式反转断语竟然仍绿");
  assert.ok(
    v4Gaps.some((gap) => gap.includes("缺口已闭合")),
    `R2：V4 的红必须来自极性反转判别（而非缺针等副作用）：${v4Gaps.join("；")}`,
  );

  // V5：针 1 前加「不」（三针齐全，`includes` 判不出来）。
  const v5Guide = rewriteAnchoredLine(zhGuide, ZH_GATE2_LINE_ANCHORS, (line) =>
    line.replace(zhAnchorMarker, `不${zhAnchorMarker}`),
  );
  assert.ok(v5Guide !== null, "R2 对照失效：未定位到 zh 门禁②行（V5）");
  assert.ok(v5Guide.includes(`不${zhAnchorMarker}`), "R2 对照失控：V5 的前置否定词未插入（否则这条对照是空转）");
  for (const anchor of ZH_GATE2_ANNOTATION) {
    assert.ok(v5Guide.includes(anchor), "R2 对照失控：V5 三针应仍齐全（否则退化为「缺标注」）");
  }
  const v5Gaps = guideGapGaps(v5Guide, enGuide, "源指南");
  assert.ok(v5Gaps.length > 0, "R2：缺口标注被前置否定词反转（「不覆盖缺口如实标注」）竟然仍绿");
  assert.ok(
    v5Gaps.some((gap) => gap.includes("前置否定词")),
    `R2：V5 的红必须来自极性判别（而非缺针等副作用）：${v5Gaps.join("；")}`,
  );

  // -------------------------------------------------------------------------
  // 判据 2 的另一半（不误红）：语义不变的同行改写必须保持绿——中性短语（V1）、标点（V2）、
  // 连续区段互换（M0）。三条与上面的负向对照共用同一个检查器，故判别力是「可区分」而非「一改就红」。
  // 与 R1 同样：断言只看**构造出的行**的形态与判定，不看它与真实文件是否相同（文件本身可能已处于
  // 该排列，那时「必须与文件不同」会变成新的误红源）。
  // -------------------------------------------------------------------------
  const zhNeutralPhrase = "（本项为说明性文字）";
  /** 标注针区间（首针起点 → 末针终点）内的文本——变体形态断言一律基于它，不假设针的相邻字符。 */
  const spanBetweenNeedles = (line: string) =>
    line.slice(line.indexOf(zhAnchorMarker), line.indexOf(zhAnchorOutside));
  const benignVariants: Array<[string, (line: string) => string, (line: string) => boolean]> = [
    [
      "V1 针间插中性短语",
      (line) =>
        spanBetweenNeedles(line).includes(zhNeutralPhrase)
          ? line
          : line.replace(zhAnchorMarker, `${zhAnchorMarker}${zhNeutralPhrase}`),
      (line) => spanBetweenNeedles(line).includes(zhNeutralPhrase),
    ],
    [
      "V2 标点替换（标注后的「——」→「：」）",
      (line) => {
        const at = line.indexOf(zhAnchorMarker);
        return `${line.slice(0, at)}${zhAnchorMarker}${line.slice(at + zhAnchorMarker.length).replace("——", "：")}`;
      },
      (line) => {
        const between = spanBetweenNeedles(line).slice(zhAnchorMarker.length);
        return between.includes("：") && !between.includes("——");
      },
    ],
    [
      "M0 连续区段互换（命令段与标注段对调）",
      (line) => {
        const anchor = ZH_GATE2_LINE_ANCHORS[0]!;
        const prefix = line.slice(0, line.indexOf(anchor) + anchor.length);
        const commandClause = `\`${TSC_COMMAND}\` → \`exit_code=0\`；`;
        const body = line.slice(prefix.length);
        const at = body.indexOf(commandClause);
        assert.ok(at >= 0, "合法变体失控：M0 未在 zh 门禁②行找到标准命令段");
        // 幂等：命令段已在末尾时结果与输入相同（文件本身可能已经是 M0 排列）。
        return `${prefix}${body.slice(0, at)}${body.slice(at + commandClause.length)}${commandClause}`;
      },
      (line) => {
        const anchor = ZH_GATE2_LINE_ANCHORS[0]!;
        const prefix = line.slice(0, line.indexOf(anchor) + anchor.length);
        return line.startsWith(`${prefix}${zhAnchorMarker}`) && line.endsWith(`\`${TSC_COMMAND}\` → \`exit_code=0\`；`);
      },
    ],
  ];
  for (const [name, rewrite, shapeHolds] of benignVariants) {
    const mutated = rewriteAnchoredLine(zhGuide, ZH_GATE2_LINE_ANCHORS, rewrite);
    assert.ok(mutated !== null, `合法变体失控：未定位到 zh 门禁②行（${name}）`);
    assert.equal(mutated.split("\n").length, zhGuide.split("\n").length, `合法变体失控：${name} 不得改变行数`);
    const mutatedGate2 = locateAnchoredLine(mutated, ZH_GATE2_LINE_ANCHORS);
    assert.equal(mutatedGate2.count, 1, `合法变体失控：${name} 后行锚点应仍唯一可定位`);
    assert.ok(shapeHolds(mutatedGate2.line), `合法变体失控：${name} 的变体形态未成立（否则这条对照是空转）`);
    for (const anchor of ZH_GATE2_ANNOTATION) {
      assert.ok(mutatedGate2.line.includes(anchor), `合法变体失控：${name} 后三针应齐全（否则不是「语义不变」变体）`);
    }
    assert.deepEqual(guideGapGaps(mutated, enGuide, "源指南"), [], `${name}（语义不变的同行改写）不应误红`);
  }

  // hermetic：负向对照只改内存字符串，真实文件必须逐字节未变。
  assert.equal(readText(ZH_GUIDE_SRC), zhGuide, "负向对照污染了源指南");
  assert.equal(readText(EN_GUIDE_SRC), enGuide, "负向对照污染了源指南");
  assert.equal(readText(POLICY_SRC), policy, "负向对照污染了 core/review-policy.ts");
  assert.deepEqual(
    guideGapGaps(readText(ZH_GUIDE_SRC), readText(EN_GUIDE_SRC), "源指南"),
    [],
    "真实源指南被破坏",
  );
  assert.deepEqual(policyGapGaps(readText(POLICY_SRC), "review-policy.ts 源文件"), [], "真实 core/review-policy.ts 被破坏");
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
