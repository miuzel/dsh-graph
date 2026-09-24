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
 *     （`spliceAnchoredRegion` / `moveAnchoredRegion`）——删除「门禁②行内命中全部标注 anchors 的那一段」，
 *     而非删固定字面量，故同一行内的合法重排不再让负向对照自身误红；
 *  3. 源文件与 dist 产物**双侧**断言：源侧守护「静默删除」，dist 侧守护「要发布的那一份」。
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

type AnchoredRegion = { lineIndex: number; start: number; end: number; text: string };

/**
 * g-346 问题②：用 anchors 在**行内**定位缺口标注区段（首个命中 anchor 的起点 → 最末命中 anchor 的终点）。
 * 行内重排/等效改写不影响定位——这正是旧实现 `.replace(<固定字面量>)` 缺的能力。
 * 返回 null 表示行锚点不唯一或标注锚点不完整（负样本无法构造，属真实的对照失效）。
 */
function locateAnchoredRegion(
  text: string,
  lineAnchors: readonly string[],
  annotationAnchors: readonly string[],
): AnchoredRegion | null {
  const lines = text.split("\n");
  const lineIndex = lines.findIndex((line) => lineAnchors.every((anchor) => line.includes(anchor)));
  if (lineIndex < 0) return null;

  const line = lines[lineIndex]!;
  let start = -1;
  let end = -1;
  for (const anchor of annotationAnchors) {
    const at = line.indexOf(anchor);
    if (at < 0) return null;
    if (start < 0 || at < start) start = at;
    if (at + anchor.length > end) end = at + anchor.length;
  }
  return { lineIndex, start, end, text: line.slice(start, end) };
}

/** 定位式改写：把门禁②行内命中全部标注 anchors 的那一段替换为 replacement（默认「删除」语义）。 */
function spliceAnchoredRegion(
  text: string,
  lineAnchors: readonly string[],
  annotationAnchors: readonly string[],
  replacement = "",
): string | null {
  const hit = locateAnchoredRegion(text, lineAnchors, annotationAnchors);
  if (!hit) return null;
  const lines = text.split("\n");
  const line = lines[hit.lineIndex]!;
  lines[hit.lineIndex] = `${line.slice(0, hit.start)}${replacement}${line.slice(hit.end)}`;
  return lines.join("\n");
}

/** 定位式搬迁：把标注区段从门禁②行搬到 targetLineAnchor 所在行（行数不变）。 */
function moveAnchoredRegion(
  text: string,
  lineAnchors: readonly string[],
  annotationAnchors: readonly string[],
  targetLineAnchor: string,
): string | null {
  const hit = locateAnchoredRegion(text, lineAnchors, annotationAnchors);
  if (!hit) return null;
  const lines = text.split("\n");
  const targetIndex = lines.findIndex((line) => line.includes(targetLineAnchor));
  if (targetIndex < 0) return null;
  lines[hit.lineIndex] = `${lines[hit.lineIndex]!.slice(0, hit.start)}${lines[hit.lineIndex]!.slice(hit.end)}`;
  lines[targetIndex] = `${lines[targetIndex]!}${hit.text}`;
  return lines.join("\n");
}

/**
 * 指南检查器：门禁②行逐字含缺口标注 + zh/en 行数相等。返回缺口列表（空 = 通过）。
 * 抽成纯函数是为了让负向对照能在内存里破坏真实文本后重放**同一套判定**。
 */
function guideGapGaps(zh: string, en: string, label: string): string[] {
  const gaps: string[] = [];

  const zhHit = lineWithAll(zh, ZH_GATE2_LINE_ANCHORS);
  if (zhHit.count !== 1) gaps.push(`${label}：zh 指南门禁②行定位失败（命中 ${zhHit.count} 行，应为 1）`);
  else for (const needle of ZH_GATE2_ANNOTATION) if (!zhHit.line.includes(needle)) gaps.push(`${label}：zh 门禁②行缺缺口标注「${needle}」`);

  const enHit = lineWithAll(en, EN_GATE2_LINE_ANCHORS);
  if (enHit.count !== 1) gaps.push(`${label}：en 指南门禁②行定位失败（命中 ${enHit.count} 行，应为 1）`);
  else for (const needle of EN_GATE2_ANNOTATION) if (!enHit.line.includes(needle)) gaps.push(`${label}：en 门禁②行缺缺口标注「${needle}」`);

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
  for (const anchor of ZH_GATE2_ANNOTATION) {
    assert.ok(movedOut.includes(anchor), `负向对照 5 失控：搬迁后标注锚点「${anchor}」应仍在全文某处`);
  }
  assert.ok(guideGapGaps(movedOut, enGuide, "源指南").length > 0, "缺口标注被搬离门禁②行后竟然仍绿");

  // 负向对照 6：zh/en 行数被破坏 → 必红。
  assert.ok(guideGapGaps(zhGuide, `${enGuide}\nextra line\n`, "源指南").length > 0, "en 指南行数被破坏后竟然仍绿");

  // g-346 问题② 自证：**同一条门禁②行内重排**（语义不变、行数不变）→ 必须绿。
  // 旧实现用 `.replace("；" + ZH_GAP_TEXT, "")` 构造负样本，重排后该前置 `assert.notEqual` 会报红
  //（「负向对照失效」）——合法编辑红在错误原因上。现改为 anchors 定位，重排后仍应可定位、可判别。
  const [zhAnchorMarker, zhAnchorInclude, zhAnchorOutside] = ZH_GATE2_ANNOTATION as [string, string, string];
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
