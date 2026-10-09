/**
 * g-371 判据 3/4/6：仓库根 `CHANGELOG.md` 结构守卫（「改坏即红」）。
 *
 * 为什么需要（g-370 独立复核 NOTE-3 / M3）：复核者删掉 CHANGELOG 的 v0.16.1 一条亮点后
 * 全量 1393/1393 全绿 —— `grep -rn CHANGELOG core/tests/` 零命中，CHANGELOG 此前完全没有机器守卫。
 * 注意 M3 删的是**多条目节里的一条**（v0.16.1 原有 4 条），所以「每节 ≥1 条」这种弱规则**接不住** M3；
 * 本套件因此把「版本节 + 每节要点数」整体做成**快照常量**（`EXPECTED_SECTIONS`）：删任何一条要点、
 * 删任何一节、加一节未登记，都会红。
 *
 * 断言面：
 *  G1. 文件存在、含 `# Changelog` 标题；每个二级标题都是合法的 `## vX.Y.Z — YYYY-MM-DD` 版本节；
 *  G2. 版本节集合、顺序与每节要点数 == 快照常量（防静默删节/删条；发新版须同步一行）；
 *  G3. 每节要点数 ≥1 且 ≤5（独立于快照的自洽规则），版本号唯一且严格倒序；
 *  G4. 正文无过程痕迹：`g-XXX`、门禁数字 `10/0/0`、`通过 N/失败`、`P1–P6`、`M4`、
 *      tarball/sha256 指纹、测试计数、typecheck 结论 —— CHANGELOG 面向用户，不承载审计数字；
 *  F.  负向对照：对**内存中的字符串副本**做变异（删整节 / 删某节最后一条 / 版本乱序 / 去日期 /
 *      条目数超上限 / 混入审计数字），同一套判定函数必须报红；合法改写（改措辞、改日期）不得误红。
 *
 * 关于「版本归属与 git tag 强绑定」（目标描述授权执行者论证取舍）：**不纳入机器断言**。
 * 理由：(1) 测试可能在无 `.git` 的 dist/tarball 环境运行，绑 git 会把「环境缺失」误判成「文档错」；
 * (2) g-370 复核证明「某特性真实落地版本」需要逐条 `git tag --contains` 考古 + 与**已不存在**的旧
 *     README 基线比对，无法从当前仓库状态机械复现；(3) 可机械复现的部分（结构、条目数、版本节完整性、
 *     无过程痕迹）已由本文件覆盖。⇒ 归属正确性仍依赖人工复核，交付说明中如实登记。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
const CHANGELOG_PATH = join(repoRoot, "CHANGELOG.md");

/**
 * 版本节快照（倒序 + 每节要点数）。发新版时补一行；改动某节要点数（增/删）时同步改计数。
 * 这是「删整节 / 删某节一条」必红的唯一可靠手段（M3 复盘：弱规则接不住多条节内的删除）。
 */
const EXPECTED_SECTIONS: Array<{ version: string; bullets: number }> = [
  { version: "v0.20.0", bullets: 2 },
  { version: "v0.19.8", bullets: 5 },
  { version: "v0.19.7", bullets: 5 },
  { version: "v0.18.0", bullets: 5 },
  { version: "v0.17.0", bullets: 5 },
  { version: "v0.16.1", bullets: 4 },
  { version: "v0.16.0", bullets: 5 },
  { version: "v0.11.0", bullets: 1 },
  { version: "v0.9.2", bullets: 3 },
  { version: "v0.7.1", bullets: 4 },
  { version: "v0.6.1", bullets: 1 },
];

const MAX_BULLETS_PER_SECTION = 5;

const SECTION_HEADING = /^##\s+v(\d+)\.(\d+)\.(\d+)\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*$/;

/** 面向用户的 CHANGELOG 不得承载的过程痕迹（标签 → 正则）。 */
const FORBIDDEN_TRACES: Array<[string, RegExp]> = [
  ["过程痕迹 g-XXX", /g-\d{3}/],
  ["门禁数字 10/0/0", /\b10\/0\/0\b/],
  ["测试结论 通过 N/失败", /通过\s*\d+\s*\/\s*失败/],
  ["评审编号 P1–P6", /\bP[1-6](?:\s*[—–-]\s*P?[1-6])?\b/],
  ["突变编号 M4", /\bM4\b/],
  ["tarball / sha256 指纹", /tarball|sha256|\b[0-9a-f]{32,64}\b|\.tgz\b/i],
  [
    "测试计数",
    /通过\s*\d+|失败\s*\d+|\b\d{3,}\s*\/\s*\d{3,}\b|\b(?:tests?|pass(?:ed)?|fail(?:ed)?)\s*[:=]?\s*\d+/i,
  ],
  ["typecheck 结论", /typecheck|tsc\s+--noEmit|\bexit\s*(?:code\s*)?0\b/i],
];

type Section = {
  version: string;
  parts: [number, number, number];
  date: string;
  lineNo: number;
  bullets: number;
};

/** 解析版本节。返回节列表 + 结构问题（非法二级标题等）。 */
function parseSections(text: string): { sections: Section[]; problems: string[] } {
  const problems: string[] = [];
  const sections: Section[] = [];
  let cur: Section | null = null;
  text.split("\n").forEach((line, i) => {
    const m = line.match(SECTION_HEADING);
    if (m) {
      if (cur) sections.push(cur);
      cur = {
        version: `v${m[1]}.${m[2]}.${m[3]}`,
        parts: [Number(m[1]), Number(m[2]), Number(m[3])],
        date: m[4],
        lineNo: i + 1,
        bullets: 0,
      };
      return;
    }
    if (/^##\s+/.test(line)) {
      problems.push(`第 ${i + 1} 行二级标题不是「## vX.Y.Z — YYYY-MM-DD」形态：${line.trim().slice(0, 80)}`);
      if (cur) {
        sections.push(cur);
        cur = null;
      }
      return;
    }
    if (cur && /^-\s+/.test(line)) cur.bullets++;
  });
  if (cur) sections.push(cur);
  return { sections, problems };
}

/** >0 表示 a 比 b 新（倒序时 a 应排在 b 前）。 */
function newerFirst(a: Section, b: Section): number {
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  }
  return 0;
}

/** 判据 3 全套判定（真实文件与内存副本共用）。 */
function changelogProblems(text: string): string[] {
  const problems: string[] = [];
  if (!/^#\s+Changelog\s*$/m.test(text)) problems.push("缺少 `# Changelog` 一级标题");

  const { sections, problems: parseProblems } = parseSections(text);
  problems.push(...parseProblems);
  if (sections.length === 0) {
    problems.push("没有任何 `## vX.Y.Z — YYYY-MM-DD` 版本节");
    return problems;
  }

  // 版本节集合 == 快照（防静默删节；也防「新增版本但没登记快照」）
  const actualVersions = sections.map((s) => s.version);
  const expectedVersions = EXPECTED_SECTIONS.map((s) => s.version);
  const missing = expectedVersions.filter((v) => !actualVersions.includes(v));
  const unexpected = actualVersions.filter((v) => !expectedVersions.includes(v));
  if (missing.length > 0) {
    problems.push(`缺少版本节 ${missing.join(", ")}（若确有版本下线，请同步更新 EXPECTED_SECTIONS 快照）`);
  }
  if (unexpected.length > 0) {
    problems.push(`出现快照外的版本节 ${unexpected.join(", ")}（发新版须同步更新 EXPECTED_SECTIONS 快照）`);
  }

  // 每节要点数 == 快照（M3 的「删一条亮点」就在这里红）
  for (const expected of EXPECTED_SECTIONS) {
    const actual = sections.find((s) => s.version === expected.version);
    if (!actual) continue;
    if (actual.bullets !== expected.bullets) {
      problems.push(
        `${expected.version}（第 ${actual.lineNo} 行）要点数 ${actual.bullets} ≠ 快照 ${expected.bullets}（增删要点须同步查证并更新快照）`,
      );
    }
  }

  // 自洽规则：每节 1..5 条
  for (const s of sections) {
    if (s.bullets < 1) problems.push(`${s.version}（第 ${s.lineNo} 行）没有任何要点（每节至少 1 条）`);
    if (s.bullets > MAX_BULLETS_PER_SECTION) {
      problems.push(`${s.version}（第 ${s.lineNo} 行）有 ${s.bullets} 条要点，超过每节上限 ${MAX_BULLETS_PER_SECTION} 条`);
    }
  }

  // 版本唯一 + 严格倒序
  const seen = new Map<string, number>();
  for (const s of sections) seen.set(s.version, (seen.get(s.version) ?? 0) + 1);
  const dup = [...seen.entries()].filter(([, c]) => c > 1).map(([v, c]) => `${v}×${c}`);
  if (dup.length > 0) problems.push(`版本节重复：${dup.join(", ")}`);
  for (let i = 1; i < sections.length; i++) {
    if (newerFirst(sections[i - 1], sections[i]) <= 0) {
      problems.push(
        `版本节未严格倒序：第 ${sections[i - 1].lineNo} 行 ${sections[i - 1].version} 之后是第 ${sections[i].lineNo} 行 ${sections[i].version}`,
      );
    }
  }

  // 过程痕迹
  text.split("\n").forEach((line, i) => {
    for (const [label, re] of FORBIDDEN_TRACES) {
      if (re.test(line)) problems.push(`第 ${i + 1} 行含[${label}]：${line.trim().slice(0, 120)}`);
    }
  });
  return problems;
}

// =====================================================================================
// 真实文件
// =====================================================================================

function realChangelog(): string {
  assert.ok(existsSync(CHANGELOG_PATH), `缺少仓库根 CHANGELOG.md：${CHANGELOG_PATH}`);
  return readFileSync(CHANGELOG_PATH, "utf8");
}

test("g-371 判据3：CHANGELOG 存在、版本节形态合法、集合与要点数符合快照且倒序", () => {
  const text = realChangelog();
  const { sections } = parseSections(text);
  const structural = changelogProblems(text).filter((p) => !p.includes("含["));
  assert.deepEqual(structural, [], `CHANGELOG 结构漂移：\n${structural.join("\n")}`);
  assert.equal(sections.length, EXPECTED_SECTIONS.length, "版本节数应与快照一致");
});

test("g-371 判据3：CHANGELOG 正文无过程痕迹（g-XXX / 门禁数字 / 测试计数 / typecheck 结论 / tarball 指纹）", () => {
  const problems = changelogProblems(realChangelog()).filter((p) => p.includes("含["));
  assert.deepEqual(problems, [], `CHANGELOG 混入过程痕迹：\n${problems.join("\n")}`);
});

// =====================================================================================
// 「改坏即红」负向对照（hermetic：只改内存副本）
// =====================================================================================

/** 版本节在文件中的行区间 [headingIdx, endIdx)。 */
function sectionRange(lines: string[], version: string): { start: number; end: number } {
  const start = lines.findIndex((l) => l.trim().startsWith(`## ${version} `) || l.trim() === `## ${version}`);
  assert.ok(start >= 0, `变异前提：找不到 ${version} 节`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** 删除某个版本节整块。 */
function dropSection(text: string, version: string): string {
  const lines = text.split("\n");
  const { start, end } = sectionRange(lines, version);
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/** 删除某节最后一条要点（M3 的同形复现）。 */
function dropLastBullet(text: string, version: string): string {
  const lines = text.split("\n");
  const { start, end } = sectionRange(lines, version);
  let last = -1;
  for (let i = start + 1; i < end; i++) if (/^-\s+/.test(lines[i])) last = i;
  assert.ok(last >= 0, `变异前提：${version} 节没有要点`);
  return [...lines.slice(0, last), ...lines.slice(last + 1)].join("\n");
}

function expectRed(problems: string[], re: RegExp, label: string): void {
  assert.ok(
    problems.some((p) => re.test(p)),
    `${label} 必红，实际判定：${JSON.stringify(problems)}`,
  );
}

test("g-371 判据4 负向对照：删整节 / 删某节一条 / 版本乱序 / 去日期 / 超条目上限 / 混入审计数字 必红，合法改写不误红", () => {
  const base = realChangelog();
  assert.deepEqual(changelogProblems(base), [], "基线（真实 CHANGELOG）必须零问题");

  // ① 删整节（最新节 v0.16.1）⇒ 快照缺节必红
  const dropFirst = dropSection(base, "v0.16.1");
  assert.notEqual(dropFirst, base, "变异确实生效");
  expectRed(changelogProblems(dropFirst), /缺少版本节 v0\.16\.1/, "删掉 v0.16.1 整节");

  // ①′ 删中间整节（v0.9.2）⇒ 同样必红（删哪一节都在守卫内）
  expectRed(changelogProblems(dropSection(base, "v0.9.2")), /缺少版本节 v0\.9\.2/, "删掉 v0.9.2 整节");

  // ② 删某节最后一条要点 —— v0.16.0（原 5 条）与 v0.11.0（原 1 条）各一次
  //    ★ M3 同形：删掉 v0.16.1 的「窄档搜索可用性」一条，必须红（弱规则「≥1 条」接不住，快照接得住）
  const dropM3 = dropLastBullet(base, "v0.16.1");
  assert.notEqual(dropM3, base, "变异确实生效");
  expectRed(changelogProblems(dropM3), /v0\.16\.1（第 \d+ 行）要点数 3 ≠ 快照 4/, "M3 同形：删掉 v0.16.1 一条亮点");

  expectRed(changelogProblems(dropLastBullet(base, "v0.16.0")), /v0\.16\.0（第 \d+ 行）要点数 4 ≠ 快照 5/, "删掉 v0.16.0 最后一条");
  const dropSingle = dropLastBullet(base, "v0.11.0");
  const singleProblems = changelogProblems(dropSingle);
  expectRed(singleProblems, /v0\.11\.0（第 \d+ 行）要点数 0 ≠ 快照 1/, "删掉 v0.11.0 唯一一条要点");
  expectRed(singleProblems, /v0\.11\.0（第 \d+ 行）没有任何要点/, "删掉唯一一条后触发「每节至少 1 条」自洽规则");

  // ③ 版本号改成乱序：把 v0.6.1 与 v0.16.1 的版本号互换 ⇒ 未严格倒序必红
  const swap = base.replace("## v0.16.1 —", "## v0.6.1 —").replace("## v0.6.1 — 2026-08-24", "## v0.16.1 — 2026-08-24");
  expectRed(changelogProblems(swap), /版本节未严格倒序|版本节重复/, "版本号乱序");

  // ④ 版本节标题缺日期 ⇒ 形态非法必红
  expectRed(
    changelogProblems(base.replace("## v0.16.1 — 2026-09-26", "## v0.16.1")),
    /二级标题不是「## vX\.Y\.Z — YYYY-MM-DD」形态/,
    "版本节缺日期",
  );

  // ⑤ 每节要点数 > 5 ⇒ 必红（自洽规则，独立于快照）
  const sixBullets = base.replace(
    "## v0.11.0 — 2026-09-15",
    "## v0.11.0 — 2026-09-15\n\n- 第二条要点；\n- 第三条要点；\n- 第四条要点；\n- 第五条要点；\n- 第六条要点；",
  );
  expectRed(changelogProblems(sixBullets), /有 6 条要点，超过每节上限 5 条/, "每节要点数超上限");

  // ⑥ 混入过程痕迹：g-XXX / 10/0/0 / 通过 N/失败 / P1–P6 / M4 / tarball 指纹 / 测试计数 / typecheck
  const traceSamples: Array<[string, RegExp, string]> = [
    ["- 详见 g-370 的结论。", /过程痕迹 g-XXX/, "g-XXX"],
    ["- 门禁 10/0/0，全绿。", /门禁数字 10\/0\/0/, "10/0/0"],
    ["- 验证：通过 1393/失败 0。", /测试结论 通过 N\/失败/, "通过 N/失败"],
    ["- 复核覆盖 P1–P6。", /评审编号 P1–P6/, "P1–P6"],
    ["- 突变 M4 全绿。", /突变编号 M4/, "M4"],
    ["- tarball sha256 3f2a1b…", /tarball \/ sha256 指纹/, "tarball 指纹"],
    ["- 全量 1393/1393 全绿。", /测试计数/, "测试计数"],
    ["- typecheck exit 0。", /typecheck 结论/, "typecheck 结论"],
  ];
  for (const [sample, re, label] of traceSamples) {
    expectRed(changelogProblems(`${base}\n${sample}\n`), re, `混入${label}`);
  }

  // ⑦ 合法改写不误红：改一条要点的措辞 + 改日期（版本节与要点数不变）
  const legit = base
    .replace("## v0.7.1 — 2026-08-26", "## v0.7.1 — 2026-08-27")
    .replace("- **卡片标题去前缀**：看板卡片标题直接显示目标标题，不再带 🎯 前缀。", "- **卡片标题**：看板卡片直接显示目标标题。");
  assert.notEqual(legit, base, "变异确实生效");
  assert.deepEqual(changelogProblems(legit), [], "合法改写（措辞/日期）不得误红");

  // hermetic：负向对照只改内存副本，真实文件逐字未变
  assert.equal(readFileSync(CHANGELOG_PATH, "utf8"), base, "负向对照污染了真实 CHANGELOG.md");
});
