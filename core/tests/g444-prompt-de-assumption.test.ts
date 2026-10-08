// g-444：提示词与运行期文案「去本仓库特有假设」的防复发守卫。
//
// 口径（负责人 2026-10-08，含 14:47 定稿 + r1 复核追加）：
//  · 源码注释可以有内部编号/内部路径（豁免）；**给用户 supervisor 的提示词**与**运行期文案**
//    不得假设能获取本仓库特有目录结构 / 脚本 / 分支模型 / 文件（含 `.dsh-graph` 内部文件名）。
//  · A) 资产扫描（仅模型可读面，**每个预期资产都有粒度下限，防 fail-open**）：
//      ① `dsh-graph-host/prompts/*.md` 与 `dsh-graph-host/supervisor-guide.{zh,en}.md`（源码 + dist 投递副本）；
//      ② `dsh-graph-host/lib/server-i18n.js` 的**字符串值**（导入模块取 value ⇒ 键名/注释天然不计）；
//      ③ `dsh-graph-host/lib/client/i18n.js`（GUI 可见文案）与 `dist/lib/client.js` 里的
//         **字符串值**——该文件是拼接片段、不可导入，故用「一行恰好是一条 `'key': 'value'`」行式提取：
//         只取 value、跳过键名；提取完备性由「源码侧 解析数 ≡ 形似行数」+「源码对 ⊆ dist 对」+ 下限断言自证，
//         合法插值（`{n}` 等）不受影响。
//  · 显式豁免（各自都有正例与「豁免不过宽」的反例）：
//      ① 「本项目示例 / 示例（本仓库）」(en: this repository example) 标记——**必须与被豁免的 token 紧邻**
//         （同括号且标记在前，或标记紧随其后），且**每资产豁免行数 ≤2**；只对 4 个「命令/路径」token 生效；
//      ② `INDEX.md` 出现在否定语境（不再/已取消/非记忆真源…）时放行；肯定语境（必须维护）仍判红；
//      ③ `<!-- -->` HTML 注释不计（本测试不解析 JS 注释：③ 走「只取字符串值」口径）。
//  · B) 行为断言：HANDOFF 只留 skill 名、上限文案（工具侧 + GUI 侧）不写死版本/槽位、骨架无 npm 生态词、zh/en 同步。
//  · 负向对照：塞回任一 token / 清空任一预期资产 / 滥用示例标记 ⇒ 必红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  init, createGoal, generateHandoff,
  ATTEMPT_REPORT_SKELETON, ATTEMPT_REPORT_SKELETON_EN,
  subagentSpawnErrorText,
} from "../ops.ts";

const repoRoot = join(import.meta.dirname, "../..");
const HOST = join(repoRoot, "dsh-graph-host");
const DIST = join(repoRoot, "dist");
const CLIENT_I18N_SRC = join(HOST, "lib", "client", "i18n.js");
const CLIENT_BUNDLE_DIST = join(DIST, "lib", "client.js");

/** 每个资产的粒度下限（防「清空任一资产仍绿」的 fail-open）。 */
const MD_MIN_LINES = 1;
const MD_MIN_BYTES = 100;
const MARKER_LINE_CAP = 2;
const SERVER_I18N_MIN_PER_SIDE = 40;
const CLIENT_I18N_MIN_PAIRS = 1800;

type Rule = {
  id: string;
  pattern: RegExp;
  why: string;
  /** 允许被「本项目示例」标记豁免（仅命令/路径类 token；且标记须与被豁免 token 紧邻）。 */
  exampleExempt?: boolean;
  /** 允许被否定语境豁免（仅 INDEX.md 这条）。 */
  negationExempt?: boolean;
};

/** 禁用 token：各须 0 命中（豁免见文件头注释）。 */
const RULES: Rule[] = [
  { id: "repo-package-path", pattern: /dsh-graph-host\//, why: "本仓库包目录路径", exampleExempt: true },
  { id: "archived-script", pattern: /scripts\/archived\//, why: "本仓库归档脚本路径", exampleExempt: true },
  { id: "repo-test-cmd", pattern: /node --test core\/tests/, why: "本仓库测试命令", exampleExempt: true },
  { id: "repo-typecheck-cmd", pattern: /tsc --noEmit -p tsconfig\.json/, why: "本仓库类型检查命令", exampleExempt: true },
  { id: "repo-integration-branch", pattern: /<version>-test/, why: "本仓库集成分支命名" },
  { id: "internal-fn-name", pattern: /prepareAttemptWorktree/, why: "插件内部函数名" },
  { id: "real-attempt-id", pattern: /g-\d+-att-\d{2}/, why: "真实 attempt 编号" },
  { id: "memory-index-file", pattern: /INDEX\.md/, why: "本仓库记忆索引文件", negationExempt: true },
  { id: "hardcoded-dsh-version", pattern: /DSH 0\.1\.6/, why: "写死宿主版本号" },
  { id: "hardcoded-subagent-slots", pattern: /(?:默认|最多|至多|at most|defaults? to)\s*[^。；\n]{0,12}\d+\s*[^。；\n]{0,8}(?:子代理|subagents?)/, why: "写死并发子代理槽位数" },
];

/** 「本项目示例」标记（zh/en 对称）。 */
const MARK = "(?:本项目示例|示例（本仓库）|this repository example|example \\(this repository\\))";
/** 标记紧邻判定：标记在前（同括号内、与 token 之间不得出现括号，且间隔 ≤32 字符）
 *  或紧随 token 之后 ≤3 字符。⇒ 标记孤零零挂在行尾、与命令之间隔着散文时不豁免。 */
const MARK_BEFORE = new RegExp(`${MARK}[:：]?[^（()）]{0,32}$`);
const MARK_AFTER = new RegExp(`^.{0,3}${MARK}`);
/** `INDEX.md` 的否定语境（不再要求 / 已取消 / 非记忆真源 …）。 */
const NEGATION_CONTEXT = /不再|已取消|非记忆真源|无需维护|不要求维护|no longer|not the memory source of truth|no index file needs to be maintained/;

/** `<!-- -->` 注释整体不计（按字符替换为空格以保留行号）。 */
function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** 命中是否被「本项目示例」标记紧邻豁免（标记须同行、且贴着该 token）。 */
function markerAdjacent(line: string, index: number, length: number): boolean {
  return MARK_BEFORE.test(line.slice(0, index)) || MARK_AFTER.test(line.slice(index + length));
}

/** 扫描一行：逐 token 逐次命中判定豁免（豁免按「命中」而非「整行」生效）。
 *  `markerExempted` 只统计「本项目示例」标记豁免（否定语境豁免不计入标记行数上限）。 */
function scanLine(label: string, line: string, lineNo: number): { violations: string[]; markerExempted: boolean } {
  const violations: string[] = [];
  let markerExempted = false;
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      if (rule.exampleExempt && markerAdjacent(line, m.index, m[0].length)) { markerExempted = true; continue; }
      if (rule.negationExempt && NEGATION_CONTEXT.test(line)) continue;
      violations.push(`${label}:${lineNo} [${rule.id}] ${rule.why}：${line.trim().slice(0, 140)}`);
    }
  }
  return { violations, markerExempted };
}

/**
 * 逐行扫描一段模型可读文本；真实资产、i18n 取值与合成夹具共用同一实现。
 * `minLines`/`minBytes` = 该资产的**粒度下限**：低于下限即产出违规（清空/截断资产必红，不留 fail-open）。
 */
function scanText(
  label: string,
  text: string,
  opts: { minLines?: number; minBytes?: number; maxMarkerLines?: number } = {},
): string[] {
  const out: string[] = [];
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = stripHtmlComments(text).split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0).length;
  const minLines = opts.minLines ?? 0;
  const minBytes = opts.minBytes ?? 0;
  const cap = opts.maxMarkerLines ?? 0;
  if (nonEmpty < minLines || bytes < minBytes) {
    out.push(`${label}: 资产覆盖不足（非空行 ${nonEmpty} < ${minLines} 或字节 ${bytes} < ${minBytes}）——预期资产被清空/截断`);
  }
  let markerLines = 0;
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const r = scanLine(label, line, index + 1);
    if (r.markerExempted) markerLines += 1;
    out.push(...r.violations);
  });
  if (markerLines > cap) {
    out.push(`${label}: 「本项目示例」豁免行数 ${markerLines} 超上限 ${cap}——豁免面不得扩张`);
  }
  return out;
}

/** 只取 server i18n 字典的**字符串值**（注释与键名天然不入扫描面）。 */
function scanServerI18n(label: string, dict: { zh: Record<string, unknown>; en: Record<string, unknown> }): string[] {
  const out: string[] = [];
  for (const [lang, entries] of [["zh", dict.zh], ["en", dict.en]] as const) {
    const values = Object.entries(entries).filter(([, v]) => typeof v === "string") as [string, string][];
    if (values.length < SERVER_I18N_MIN_PER_SIDE) {
      out.push(`${label} ${lang}: 取值条数 ${values.length} < ${SERVER_I18N_MIN_PER_SIDE}——字典被清空/截断`);
    }
    for (const [key, value] of values) out.push(...scanText(`${label} ${lang}:${key}`, value));
  }
  return out;
}

type Pair = { key: string; value: string };
/** 行式提取 `'key': 'value'` 的**值**（键名不入扫描面）；`loose` 为「形似键值对」的行数，用于自证解析完备。 */
function extractPairs(text: string): { pairs: Pair[]; loose: number } {
  const PROP = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")\s*,?\s*$/;
  const LOOSE = /^\s*(?:'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)\s*:\s*(?:'|"|`)/;
  const pairs: Pair[] = [];
  let loose = 0;
  for (const line of text.split("\n")) {
    if (LOOSE.test(line)) loose += 1;
    const m = PROP.exec(line);
    if (!m) continue;
    const key = m[1] ?? m[2] ?? m[3] ?? "";
    const value = m[4] ?? m[5] ?? "";
    if (!key.includes(".")) continue;
    pairs.push({ key, value });
  }
  return { pairs, loose };
}

/** 收集源码与投递副本两侧的 markdown 资产（含粒度下限与豁免行数上限）。 */
function markdownAssets(): { label: string; text: string; maxMarkerLines: number }[] {
  const out: { label: string; text: string; maxMarkerLines: number }[] = [];
  for (const [label, dir] of [["源", HOST], ["dist", DIST]] as const) {
    const promptsDir = join(dir, "prompts");
    for (const name of readdirSync(promptsDir).filter((n) => n.endsWith(".md")).sort()) {
      out.push({ label: `${label}/prompts/${name}`, text: readFileSync(join(promptsDir, name), "utf8"), maxMarkerLines: 0 });
    }
    for (const name of ["supervisor-guide.zh.md", "supervisor-guide.en.md"]) {
      out.push({ label: `${label}/${name}`, text: readFileSync(join(dir, name), "utf8"), maxMarkerLines: MARKER_LINE_CAP });
    }
  }
  return out;
}

/** 全部真实资产 + i18n 取值的违规清单（空 = 合规）。 */
async function scanAllAssets(): Promise<string[]> {
  const out: string[] = [];
  let scannedLines = 0;
  for (const asset of markdownAssets()) {
    out.push(...scanText(asset.label, asset.text, {
      minLines: MD_MIN_LINES, minBytes: MD_MIN_BYTES, maxMarkerLines: asset.maxMarkerLines,
    }));
    scannedLines += asset.text.split("\n").length;
  }
  assert.ok(scannedLines > 1000, `扫描行数过少（${scannedLines}），结果不可信`);
  for (const [label, url] of [
    ["源", pathToFileURL(join(HOST, "lib", "server-i18n.js")).href],
    ["dist", pathToFileURL(join(DIST, "lib", "server-i18n.js")).href],
  ] as const) {
    const mod = await import(url) as { SERVER_I18N: { zh: Record<string, unknown>; en: Record<string, unknown> } };
    out.push(...scanServerI18n(label, mod.SERVER_I18N));
  }
  out.push(...scanClientI18n());
  return out;
}

/** 客户端 i18n（GUI 可见文案）：源码与 dist 拼接副本两侧的字符串值。 */
function scanClientI18n(): string[] {
  const out: string[] = [];
  const src = extractPairs(readFileSync(CLIENT_I18N_SRC, "utf8"));
  const dist = extractPairs(readFileSync(CLIENT_BUNDLE_DIST, "utf8"));
  // 解析完备性自证：源码侧「形似键值对」的行必须全部被解析（漏解析即判红，避免扫描面静默缩小）。
  if (src.pairs.length < CLIENT_I18N_MIN_PAIRS) {
    out.push(`源/lib/client/i18n.js: 取值条数 ${src.pairs.length} < ${CLIENT_I18N_MIN_PAIRS}——字典被清空/截断`);
  }
  if (src.pairs.length !== src.loose) {
    out.push(`源/lib/client/i18n.js: 解析数 ${src.pairs.length} ≠ 形似行数 ${src.loose}——提取器漏行，扫描面不可信`);
  }
  if (dist.pairs.length < src.pairs.length) {
    out.push(`dist/lib/client.js: 取值条数 ${dist.pairs.length} < 源码 ${src.pairs.length}——dist 未重建或注入被吞`);
  }
  const distSet = new Set(dist.pairs.map((p) => `${p.key}\u0000${p.value}`));
  const missing = src.pairs.filter((p) => !distSet.has(`${p.key}\u0000${p.value}`));
  if (missing.length > 0) {
    out.push(`dist/lib/client.js: 有 ${missing.length} 条源码取值未落进 dist（如 ${missing[0].key}）——需重建 dist`);
  }
  // 金丝雀：GUI 侧上限文案必须仍在扫描面内（防提取器/键名变动导致扫描面空洞）。
  const canary = src.pairs.filter((p) => p.key === "live.activationLimit");
  if (canary.length !== 2) out.push(`源/lib/client/i18n.js: 金丝雀键 live.activationLimit 命中 ${canary.length} 条（应为 zh/en 各 1）`);
  for (const p of src.pairs) out.push(...scanText(`源/lib/client/i18n.js:${p.key}`, p.value));
  for (const p of dist.pairs) out.push(...scanText(`dist/lib/client.js:${p.key}`, p.value));
  return out;
}

// ---------------------------------------------------------------------------
// A. 资产扫描（真实资产 0 命中 + 逐资产粒度下限）
// ---------------------------------------------------------------------------

test("g-444 判据3：模型可读资产（源码 + dist 投递副本）不含本仓库特有路径/命令/文件", async () => {
  const assets = markdownAssets();
  // 非恒真护栏：资产必须真被读到（清空/删减任一资产由每资产下限与文件枚举兜住）。
  assert.equal(assets.length, 32, `应扫到 14 个 prompts × 2 侧 + 2 份指南 × 2 侧（实得 ${assets.length}）`);
  const violations = await scanAllAssets();
  assert.deepEqual(violations, [], `资产命中禁用 token（应 0 命中）：\n${violations.join("\n")}`);
});

test("g-444 判据3：server-i18n 两侧的字符串值不含本仓库特有路径/命令/文件", async () => {
  let values = 0;
  const violations: string[] = [];
  for (const [label, url] of [
    ["源", pathToFileURL(join(HOST, "lib", "server-i18n.js")).href],
    ["dist", pathToFileURL(join(DIST, "lib", "server-i18n.js")).href],
  ] as const) {
    const mod = await import(url) as { SERVER_I18N: { zh: Record<string, unknown>; en: Record<string, unknown> } };
    values += Object.keys(mod.SERVER_I18N.zh).length + Object.keys(mod.SERVER_I18N.en).length;
    violations.push(...scanServerI18n(label, mod.SERVER_I18N));
  }
  assert.ok(values >= 2 * 2 * SERVER_I18N_MIN_PER_SIDE, `i18n 取值条数过少（${values}），结果不可信`);
  assert.deepEqual(violations, [], `server-i18n 字符串值命中禁用 token：\n${violations.join("\n")}`);
});

test("g-444 判据3：客户端 i18n（GUI 可见文案，源码 + dist 拼接副本）字符串值 0 命中", () => {
  const src = extractPairs(readFileSync(CLIENT_I18N_SRC, "utf8"));
  const dist = extractPairs(readFileSync(CLIENT_BUNDLE_DIST, "utf8"));
  assert.equal(src.pairs.length, src.loose, "源码侧形似键值对的行必须全部被解析（否则扫描面不可信）");
  assert.ok(src.pairs.length >= CLIENT_I18N_MIN_PAIRS, `客户端 i18n 取值条数过少（${src.pairs.length}）`);
  assert.ok(dist.pairs.length >= src.pairs.length, `dist 取值条数 ${dist.pairs.length} 少于源码 ${src.pairs.length}`);
  assert.deepEqual(scanClientI18n(), [], "客户端 i18n 字符串值命中禁用 token");
});

test("g-444 逐资产粒度下限：清空/截断任一预期资产即判红（防聚合护栏 fail-open）", () => {
  // 真实资产侧：每个资产都必须满足非空行/字节下限（阈值与主扫描一致）。
  for (const asset of markdownAssets()) {
    const hits = scanText(asset.label, asset.text, {
      minLines: MD_MIN_LINES, minBytes: MD_MIN_BYTES, maxMarkerLines: asset.maxMarkerLines,
    });
    assert.deepEqual(hits, [], `${asset.label} 覆盖不足或命中 token：\n${hits.join("\n")}`);
  }
  // 合成夹具侧：清空 / 截断必须产出违规（而不是被聚合护栏掩盖）。
  assert.equal(scanText("fixture", "", { minLines: MD_MIN_LINES, minBytes: MD_MIN_BYTES }).length, 1, "空资产必须判红");
  assert.equal(scanText("fixture", "x\n", { minLines: MD_MIN_LINES, minBytes: MD_MIN_BYTES }).length, 1, "截断资产必须判红");
  assert.deepEqual(scanText("fixture", "line1\nline2\nline3\n", { minLines: 3, minBytes: 1 }), [], "达标资产不应判红");
  // 字典侧：清空取值必须判红。
  const empty = scanServerI18n("fixture", { zh: {}, en: {} });
  assert.equal(empty.length, 2, `清空字典必须逐语言判红（实得 ${empty.length}）`);
});

// ---------------------------------------------------------------------------
// 豁免正例 + 「豁免不过宽」反例
// ---------------------------------------------------------------------------

test("g-444 豁免正例①：标记须与被豁免 token 紧邻，去掉标记/拉开距离/超条数上限均判红", () => {
  const adjacent = [
    "  1. 全量测试：项目配置的测试命令（本项目示例：`node --test core/tests/*.test.ts`）→ exit_code=0；",
    "  2. 类型检查：项目配置的类型检查命令（本项目示例：`tsc --noEmit -p tsconfig.json`）→ exit_code=0；",
    "  - 归档脚本（本项目示例：`scripts/archived/x.sh`）由项目自行显式执行；",
    "  1. Full tests: configured project test command (this repository example: `node --test core/tests/*.test.ts`);",
  ].join("\n");
  assert.deepEqual(scanText("fixture", adjacent, { maxMarkerLines: 4 }), [], "紧邻标记的示例行不应判红");

  // 标记在前但被其他 token 隔开：只有紧邻的那个 token 被豁免。
  const mixed = "（本项目示例：`node --test core/tests/x`）与 `dsh-graph-host/` 均写在本行";
  const mixedHits = scanText("fixture", mixed, { maxMarkerLines: 1 });
  assert.deepEqual(mixedHits.map((v) => v.match(/\[([a-z-]+)\]/)?.[1]), ["repo-package-path"], "只豁免紧邻标记的 token");

  // 复核反例：命令在前、标记孤零零挂在行尾（中间有散文）⇒ 不得豁免。
  const abuse = "门禁要求：必须运行 `node --test core/tests/*.test.ts` 通过后方可放行（本项目示例）";
  assert.equal(scanText("fixture", abuse).length, 1, "标记与命令不相邻时不得豁免");

  // 去掉标记即判红。
  assert.equal(scanText("fixture", adjacent.replace(/本项目示例：|this repository example: /g, "")).length, 4, "去掉标记必须逐行判红");

  // 豁免只覆盖「命令/路径」类 token：分支名与内部文件名即使带标记也仍判红。
  const overBroad = scanText("fixture", "本项目示例：<version>-test / prepareAttemptWorktree / g-125-att-03");
  assert.deepEqual(overBroad.map((v) => v.match(/\[([a-z-]+)\]/)?.[1]), [
    "repo-integration-branch", "internal-fn-name", "real-attempt-id",
  ], "「本项目示例」不得豁免分支名/内部函数名/真实编号");

  // 每资产豁免行数上限：3 行紧邻标记 ⇒ 超上限判红（上限 2）。
  const threeMarked = Array.from({ length: 3 }, (_, i) => `  命令（本项目示例：\`node --test core/tests/${i}\`）`).join("\n");
  const capped = scanText("fixture", threeMarked, { maxMarkerLines: MARKER_LINE_CAP });
  assert.equal(capped.length, 1, "超豁免条数上限必须判红");
  assert.match(capped[0], /豁免行数 3 超上限 2/);
  assert.deepEqual(scanText("fixture", threeMarked.split("\n").slice(0, 2).join("\n"), { maxMarkerLines: MARKER_LINE_CAP }), [], "不超过上限应放行");
});

test("g-444 豁免正例②：INDEX.md 的否定语境放行，肯定语境（必须维护）仍判红", () => {
  const benign = [
    "`.dsh-graph/memory/long-term/*.md` 只是可选项目文档，不是记忆真源，不要求维护任何索引文件（INDEX.md 不再被要求）；",
    "INDEX.md is no longer required; it is not the memory source of truth.",
  ].join("\n");
  assert.deepEqual(scanText("fixture", benign), [], "否定语境应放行");

  const obligations = [
    "初始化/接管时务必先阅读 `.dsh-graph/memory/long-term/INDEX.md`；",
    "必须同步更新 `.dsh-graph/memory/long-term/INDEX.md` 索引表；",
    "always read `.dsh-graph/memory/long-term/INDEX.md` first;",
  ].join("\n");
  const hits = scanText("fixture", obligations);
  assert.equal(hits.length, 3, `肯定语境必须逐行判红（实得 ${hits.length}）`);
  assert.ok(hits.every((v) => v.includes("[memory-index-file]")));
});

test("g-444 豁免正例③：HTML 注释不计；i18n 只扫字符串值（键名/注释不判红，值仍判红）", async () => {
  assert.deepEqual(scanText("fixture", "正文安全。\n<!-- node --test core/tests 与 dsh-graph-host/ 在注释里 -->\n<!--\n多行注释：prepareAttemptWorktree\n-->"), []);
  assert.equal(scanText("fixture", "正文泄露：node --test core/tests").length, 1, "正文同类文本必须判红");

  // i18n：行式提取只取值 ⇒ 键名里的 token 不判红，值里的判红（含 dist 侧同口径）。
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g444-i18n-"));
  const file = join(dir, "fixture-i18n.mjs");
  writeFileSync(file, [
    "    // 注释里出现 dsh-graph-host/ 与 node --test core/tests，不应计入扫描面",
    "    const zh = {",
    "      'clean.key': '安全值 {n} 插值合法',",
    "      'dsh-graph-host/.leak': '键名里出现本仓库路径，不应计入扫描面',",
    "      'dirty.key': '泄露 prepareAttemptWorktree',",
    "    };",
  ].join("\n"));
  const parsed = extractPairs(readFileSync(file, "utf8"));
  assert.deepEqual(parsed.pairs.map((p) => p.key), ["clean.key", "dsh-graph-host/.leak", "dirty.key"]);
  const hits = parsed.pairs.flatMap((p) => scanText(`fixture:${p.key}`, p.value));
  assert.equal(hits.length, 1, `仅 dirty.key 的值应判红（实得 ${hits.length}）`);
  assert.ok(hits[0].includes("[internal-fn-name]"), hits[0]);
  // 插值 `{n}` 不被误判（合法插值不是禁用 token）。
  assert.deepEqual(scanText("fixture", "队列 {n} 条待处理"), []);
});

test("g-444 负向对照：把任一 token 塞回资产文本，扫描器必须判红", () => {
  const samples: Record<string, string> = {
    "repo-package-path": "包目录 dsh-graph-host/ 下不要跑工具",
    "archived-script": "迁移用 scripts/archived/migrate.sh --apply",
    "repo-test-cmd": "全量测试：node --test core/tests/*.test.ts",
    "repo-typecheck-cmd": "类型检查：tsc --noEmit -p tsconfig.json",
    "repo-integration-branch": "合并到 <version>-test 分支",
    "internal-fn-name": "由 prepareAttemptWorktree 预建工作树",
    "real-attempt-id": "命名如 g-125-att-03",
    "memory-index-file": "必须维护 INDEX.md 索引表",
    "hardcoded-dsh-version": "DSH 0.1.6 起默认最多 8 个",
    "hardcoded-subagent-slots": "最多 8 个活跃子代理",
  };
  for (const rule of RULES) {
    const hits = scanText("fixture", samples[rule.id]);
    assert.ok(hits.length >= 1, `注入 token 后应判红：${rule.id}`);
    assert.ok(hits.some((v) => v.includes(`[${rule.id}]`)), `${rule.id} → ${JSON.stringify(hits)}`);
  }
  // 反向护栏：干净文本零命中，证明上面的判红不是「永远报红」。
  assert.deepEqual(scanText("fixture", "插件包目录、项目自有迁移脚本、项目约定的集成分支，上限由运行环境配置。"), []);
});

// ---------------------------------------------------------------------------
// B. 行为断言（执行代码产出的运行期文案）
// ---------------------------------------------------------------------------

test("g-444 B①：HANDOFF 以 skill 名指路，不出现本仓库路径或文件名", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g444-handoff-"));
  init(root);
  createGoal(root, { title: "去假设校验目标", version: "v-t", actor: "test" });
  const text = generateHandoff(root);
  assert.match(text, /dsh-graph-supervisor/, "必须只留 skill 名（dsh-graph-supervisor）");
  assert.doesNotMatch(text, /dsh-graph-host|supervisor-guide\.zh\.md/, "不得注入插件包内路径");
});

test("g-444 B②：子代理上限文案（工具侧 + GUI 侧）不写死版本号与槽位数", () => {
  // 工具侧：读不到上限时必须中性表述，且细节来自错误对象。
  const neutralCases: unknown[] = [
    { code: "ACTIVATION_LIMIT_REACHED", message: "limit reached" },
    { message: "cold resume rejected", details: { reason: "ACTIVATION_LIMIT_REACHED" } },
    new Error("rejected with ACTIVATION_LIMIT_REACHED"),
  ];
  for (const e of neutralCases) {
    const text = subagentSpawnErrorText(e);
    assert.match(text, /子代理激活已达上限/, JSON.stringify(e));
    assert.match(text, /上限由运行环境配置/, "读不到上限时必须中性表述");
    assert.doesNotMatch(text, /0\.1\.6|最多\s*\d+\s*个|maxActiveSubagents:\s*\d+/, "禁止写死版本号/默认槽位数");
  }
  assert.match(subagentSpawnErrorText({ code: "ACTIVATION_LIMIT_REACHED", message: "x", details: { limit: 5 } }), /当前上限 5 个/);
  assert.match(
    subagentSpawnErrorText({ code: "ACTIVATION_LIMIT_REACHED", message: "subagent limit reached (active child limit: 8)", details: { maxActiveSubagents: 3 } }),
    /当前上限 3 个/,
  );

  // GUI 侧：`live.activationLimit` 的 zh/en 值同样不得写死版本号/槽位，且两侧同步。
  const canary = extractPairs(readFileSync(CLIENT_I18N_SRC, "utf8")).pairs.filter((p) => p.key === "live.activationLimit");
  assert.equal(canary.length, 2, "GUI 上限文案应 zh/en 各一条");
  assert.ok(canary.some((p) => p.value.includes("上限由运行环境配置")), canary.map((p) => p.value).join("\n"));
  assert.ok(canary.some((p) => /the limit is configured by the runtime environment/.test(p.value)), canary.map((p) => p.value).join("\n"));
  for (const p of canary) {
    assert.doesNotMatch(p.value, /0\.1\.6|默认\s*\d+\s*个|defaults to \d+/, `GUI 上限文案不得写死：${p.value}`);
  }
});

test("g-444 B③：attempt 尾注骨架不含 npm 插件生态词（宿主 / engines / host）", () => {
  for (const [side, text] of [["zh", ATTEMPT_REPORT_SKELETON], ["en", ATTEMPT_REPORT_SKELETON_EN]] as const) {
    assert.doesNotMatch(text, /宿主|engines|\bhost\b/, `${side} 骨架仍含 npm 插件生态词`);
    assert.match(text, /4\. \*\*(影响面|Impact surface)\*\*/, `${side} 骨架必须仍含第 4 项影响面`);
  }
});

test("g-444 B④：zh/en 同步（骨架条目、指南行数、示例标记行数）", () => {
  const zh = readFileSync(join(HOST, "supervisor-guide.zh.md"), "utf8");
  const en = readFileSync(join(HOST, "supervisor-guide.en.md"), "utf8");
  assert.equal(zh.split("\n").length, en.split("\n").length, "指南 zh/en 行数必须相等");
  const markerLines = (text: string) => text.split("\n").filter((l) => new RegExp(MARK).test(l)).length;
  assert.equal(markerLines(zh), markerLines(en), "「本项目示例」标记行 zh/en 必须成对");
  assert.equal(markerLines(zh), MARKER_LINE_CAP, `指南豁免行数应恰为 ${MARKER_LINE_CAP}（实得 ${markerLines(zh)}）`);
  const promptNames = readdirSync(join(HOST, "prompts")).filter((n) => n.endsWith(".zh.md"));
  for (const name of promptNames) {
    const base = name.slice(0, -6);
    const pzh = readFileSync(join(HOST, "prompts", `${base}.zh.md`), "utf8");
    const pen = readFileSync(join(HOST, "prompts", `${base}.en.md`), "utf8");
    assert.equal(pzh.split("\n").length, pen.split("\n").length, `${base} 行数必须 zh/en 相等`);
  }
  assert.equal(
    ATTEMPT_REPORT_SKELETON.split("\n").length,
    ATTEMPT_REPORT_SKELETON_EN.split("\n").length,
    "骨架 zh/en 行数必须相等",
  );
});

test("g-444 判据2：提示词不再要求用户项目存在或手工维护 INDEX.md（双向）", () => {
  for (const [side, name] of [["zh", "supervisor-guide.zh.md"], ["en", "supervisor-guide.en.md"]] as const) {
    const text = readFileSync(join(HOST, name), "utf8");
    assert.doesNotMatch(text, /INDEX\.md/, `${side} 仍提到 INDEX.md`);
    assert.doesNotMatch(text, /务必先阅读[^。\n]*索引|必须同步更新[^。\n]*索引/, `${side} 仍有「必读/必维护索引」要求`);
    assert.doesNotMatch(text, /always read[^.\n]*index|must also update[^.\n]*index (table|file)/i, `${side} 仍有「必读/必维护索引」要求`);
    if (side === "zh") {
      assert.match(text, /结构化记忆为唯一真源/);
      assert.match(text, /不是记忆真源，也不要求维护任何索引文件/);
    } else {
      assert.match(text, /structured memory as the single source of truth/);
      assert.match(text, /not the memory source of truth, and no index file needs to be maintained/);
    }
  }
});
