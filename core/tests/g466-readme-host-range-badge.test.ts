/**
 * g-466 返工判据：README 宿主兼容徽标 == manifest 声明（含**百分号编码变体**口径）。
 *
 * 为什么需要（真实漏检，非理论风险）：g-465 把宿主兼容面由 `>=0.1.5-rc.2 <0.2.1-0` 放宽到
 * `>=0.1.5-rc.2 <0.2.2-0`（`engines.dsh` + `peerDependencies`），但两份 README 的 shields.io
 * 徽标仍写着旧上界。该处形态是 **shields.io 编码变体**：
 *   `>=0.1.5-rc.2 <0.2.2-0`  ⇒  `%3E%3D0.1.5--rc.2%20%3C0.2.2--0`
 * 其中 `<` `>` `=` 被百分号编码、空格被编码为 `%20`、**连字符被双写**。
 * 于是 g-465 的残留审计（搜字面量 `0.2.1-0`）天然搜不到它 —— 旧徽标段里
 * `0.2.1-` 之后紧跟的是 `-0`（连字符双写），**不存在**连续子串 `0.2.1-0` ⇒ 「全仓 0 命中」是
 * **假绿**；唯一可见的坏行是**随包发布**的 `dsh-graph-host/README.md`（`dist/README.md` 与
 * tarball 内 `package/README.md` 由它拷贝而来），它与 manifest 声明**自相矛盾**且对用户可见。
 * ⇒ 本守卫**不硬编码**任何编码串：旧形态由 `shieldsEncodeRange(">=0.1.5-rc.2 <0.2.1-0")` 现场推导，
 *   仓库内因此不含旧编码字面量（可被 `grep -F` 直接证明 0 命中）。
 *
 * 断言面：
 *  A. 真源唯一：`dsh-graph-host/package.json` 的 `engines.dsh` 与
 *     `peerDependencies["@deepseek-ai/dsh-settings"]` 必须**逐字相等**（宿主门禁只读后者，
 *     两者漂移即判定真源不唯一 ⇒ 直接判红，不进入徽标比对）。
 *  B. 期望值**从 manifest 推导**（不硬编码版本串）：按 shields.io 编码规则把范围串编码为徽标段。
 *  C. 三处逐字比对：根 `README.md` / 包内 `dsh-graph-host/README.md` / **打包层** `dist/README.md`
 *     （`build.sh` 步骤 3 把包内 README 拷成 `dist/README.md`，而 tarball 内 `package/README.md`
 *     就是该文件的拷贝 ⇒ 对 `dist/README.md` 的断言即覆盖「打包后 package/README.md」这一层）。
 *  D. **解码回明文**再比一次：把徽标段按 shields 规则解码回 `>=x <y` 形态，必须等于 manifest 范围
 *     ⇒ 与 C 的逐字比对是**两条独立的腿**：单写连字符 / 小写百分号等变体解码后仍然「明文正确」，
 *     只有逐字腿能接住；而 `+` 空格这类变体两条腿都接得住。只做任一条腿都不完备。
 *  E. 负向对照（对**内存中的字符串副本**做变异，同一套判定函数必须报红）：①旧上界（现场推导）
 *     ②单写连字符变体 ③小写百分号变体 ④空格写成 `+` ⑤删掉徽标行；合法改写（改 href / 正文措辞）
 *     不得误红。并显式钉住「字面量搜索接不住」这一根因（⑥）。
 *  F. hermetic：负向对照只改副本变量，末尾断言三份真实文件逐字未变。
 *
 * 刻意不做的：不把徽标 `color` 段（`2f6feb`）纳入期望值 —— 守卫只钉「范围段 + 徽标形状」，
 * 颜色变更属纯装饰，但形状（`badge/DSH-<范围段>-<6 位十六进制色>?style=flat-square`）必须保持，
 * 否则判红并给出期望形状（含 `alt="DSH host range"`，以定位到唯一那枚徽标）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
const HOST_PKG = join(repoRoot, "dsh-graph-host", "package.json");
const ROOT_README = join(repoRoot, "README.md");
const HOST_README = join(repoRoot, "dsh-graph-host", "README.md");
const DIST_README = join(repoRoot, "dist", "README.md");

/** g-465 之前的旧上界范围（**现场推导**其编码形态，仓库内不留旧编码字面量）。 */
const LEGACY_RANGE = ">=0.1.5-rc.2 <0.2.1-0";

/** 唯一那枚宿主范围徽标的形状（`alt` 用于定位；范围段与色段分开捕获）。 */
const BADGE_SHAPE = /<img src="https:\/\/img\.shields\.io\/badge\/DSH-([^"]*)-([0-9a-fA-F]{6})\?style=flat-square" alt="DSH host range">/;

/** shields.io 徽标段编码：连字符/下划线**双写**，空格与 `<` `>` `=` 百分号编码。 */
const SHIELDS_ESCAPES: Array<[RegExp, string]> = [
  [/-/g, "--"],
  [/_/g, "__"],
  [/ /g, "%20"],
  [/</g, "%3C"],
  [/>/g, "%3E"],
  [/=/g, "%3D"],
];

function shieldsEncodeRange(range: string): string {
  let out = range;
  for (const [re, rep] of SHIELDS_ESCAPES) out = out.replace(re, rep);
  return out;
}

/** 逆变换：先解百分号（大小写通吃），再解双写。 */
function shieldsDecodeRange(encoded: string): string {
  const percent: Record<string, string> = { "20": " ", "3c": "<", "3e": ">", "3d": "=", "5f": "_", "2d": "-" };
  return encoded
    .replace(/%([0-9a-fA-F]{2})/g, (whole, hex: string) => percent[hex.toLowerCase()] ?? whole)
    .replace(/__/g, "_")
    .replace(/--/g, "-");
}

/** 取出徽标 URL 里的「范围段」（不含色段）；形状不符返回 null。 */
function badgeRangeSegment(text: string): string | null {
  const m = text.match(BADGE_SHAPE);
  return m ? m[1] : null;
}

type Surface = { label: string; text: string | null };

/** 判据全量判定（真实文件与内存副本共用同一实现）。 */
function badgeProblems(surfaces: Surface[], expectedRange: string): string[] {
  const problems: string[] = [];
  const expectedEncoded = shieldsEncodeRange(expectedRange);
  for (const s of surfaces) {
    if (s.text === null) {
      problems.push(`${s.label}: 文件缺失或不可读`);
      continue;
    }
    const segment = badgeRangeSegment(s.text);
    if (segment === null) {
      problems.push(
        `${s.label}: 未找到「DSH host range」徽标（形状须为 badge/DSH-<范围段>-<6位十六进制色>?style=flat-square 且 alt="DSH host range"）`,
      );
      continue;
    }
    if (segment !== expectedEncoded) {
      problems.push(
        `${s.label}: 徽标范围段与 manifest 不符（实得 ${segment}，期望 ${expectedEncoded} —— 由 engines.dsh "${expectedRange}" 推导）`,
      );
    }
    const decoded = shieldsDecodeRange(segment);
    if (decoded !== expectedRange) {
      problems.push(
        `${s.label}: 徽标解码回明文与 manifest 不符（实得 "${decoded}"，期望 "${expectedRange}"）`,
      );
    }
  }
  return problems;
}

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// =====================================================================================
// 判据：真源 + 三处徽标
// =====================================================================================

test("g-466 判据：宿主兼容真源唯一（engines.dsh == peerDependencies），且三处 README 徽标由它推导（含打包层）", () => {
  const pkg = JSON.parse(readFileSync(HOST_PKG, "utf8")) as {
    engines?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const enginesRange = pkg.engines?.dsh;
  const peerRange = pkg.peerDependencies?.["@deepseek-ai/dsh-settings"];
  assert.ok(enginesRange, "package.json 必须声明 engines.dsh");
  assert.ok(peerRange, 'package.json 必须声明 peerDependencies["@deepseek-ai/dsh-settings"]（宿主门禁唯一真源）');
  assert.equal(enginesRange, peerRange, "宿主兼容真源必须唯一：engines.dsh 与 peerDependencies 逐字相等");

  const range = enginesRange as string;
  assert.match(range, /^>=0\.1\.5-rc\.2 <\d+\.\d+\.\d+-0$/, `兼容范围形态不符合仓库口径：${range}`);
  assert.notEqual(range, LEGACY_RANGE, `manifest 仍是旧上界 ${LEGACY_RANGE}`);

  const surfaces: Surface[] = [
    { label: "README.md（根，中）", text: readOrNull(ROOT_README) },
    { label: "dsh-graph-host/README.md（包内，随包发布）", text: readOrNull(HOST_README) },
    { label: "dist/README.md（打包层：tarball 内 package/README.md 即此文件拷贝）", text: readOrNull(DIST_README) },
  ];
  assert.deepEqual(badgeProblems(surfaces, range), []);
});

// =====================================================================================
// 负向对照：编码变体必须全被接住（对照只改内存副本）
// =====================================================================================

test("g-466 负向对照：旧上界/编码变体（单写连字符、小写百分号、+ 空格）/缺徽标 必红，合法改写不误红", () => {
  const range = ">=0.1.5-rc.2 <0.2.2-0";
  const encoded = shieldsEncodeRange(range);
  const legacyEncoded = shieldsEncodeRange(LEGACY_RANGE);
  const host = readFileSync(HOST_README, "utf8");
  const root = readFileSync(ROOT_README, "utf8");
  const dist = readFileSync(DIST_README, "utf8");

  // 基线副本：真实文件形态必须零问题（否则下面的变异对照没有意义）
  assert.deepEqual(
    badgeProblems(
      [
        { label: "root", text: root },
        { label: "host", text: host },
        { label: "dist", text: dist },
      ],
      range,
    ),
    [],
    "真实 README 徽标必须与 manifest 一致",
  );

  const mutated = (text: string): Surface[] => [{ label: "host", text }];
  const expectRed = (mutant: string, needle: string, why: string) => {
    assert.notEqual(mutant, host, `变异确实生效：${why}`);
    const problems = badgeProblems(mutated(mutant), range);
    assert.ok(
      problems.some((p) => p.includes(needle)),
      `期望判红且点名「${needle}」（${why}），实得：${JSON.stringify(problems)}`,
    );
  };

  // ① 旧上界（正是本次真实漏检的形态；编码串现场推导，仓库内无字面量）
  expectRed(host.replace(encoded, legacyEncoded), "与 manifest 不符", "旧上界范围（推导形态）");
  // ② 单写连字符变体（解码回明文仍正确 ⇒ 只有「逐字比对」这条腿能接住）
  const singleDash = host.replace(encoded, encoded.replace("0.2.2--0", "0.2.2-0"));
  expectRed(singleDash, "与 manifest 不符", "单写连字符变体");
  assert.deepEqual(
    badgeProblems(mutated(singleDash), range).filter((p) => p.includes("解码回明文")),
    [],
    "单写连字符变体解码后与明文相同 ⇒ 该变异正是为「逐字比对」这条腿而设",
  );
  // ③ 小写百分号变体（解码腿同样放行 ⇒ 仍只有逐字腿接住）
  const lowerHex = host.replace(encoded, encoded.replace("%3C", "%3c"));
  expectRed(lowerHex, "与 manifest 不符", "小写百分号变体");
  assert.deepEqual(
    badgeProblems(mutated(lowerHex), range).filter((p) => p.includes("解码回明文")),
    [],
    "小写百分号变体解码后与明文相同 ⇒ 仍由逐字腿接住",
  );
  // ④ 空格写成 `+`（逐字与解码**两条腿都**应报红）
  const plusSpace = host.replace(encoded, encoded.replace("%20", "+"));
  expectRed(plusSpace, "与 manifest 不符", "+ 号空格（逐字腿）");
  expectRed(plusSpace, "解码回明文", "+ 号空格（解码腿）");
  // ⑤ 徽标整行删除 ⇒ 形状缺失（守卫不得恒真退化为「无徽标即通过」）
  expectRed(host.replace(BADGE_SHAPE, "<!-- badge removed -->"), "未找到", "删除徽标行");
  // ⑥ 根因留痕：字面量搜索接不住编码变体（旧编码段里不存在连续子串 `0.2.1-0`）
  assert.equal(host.includes(encoded), true, "真实文件确实带正确编码的徽标段");
  assert.equal(
    legacyEncoded.includes("0.2.1-0"),
    false,
    "旧编码段不含连续子串 `0.2.1-0`（连字符被双写）⇒ 字面量搜索天然漏检（本守卫存在的直接理由）",
  );

  // ⑦ 合法改写不误红：改徽标 href / 改无关正文（范围段与徽标形状不动）
  const legit = host
    .replace("https://raw.githubusercontent.com/miuzel/dsh-graph/main/dsh-graph-host/package.json", "https://example.invalid/pkg.json")
    .replace("**环境要求**", "**运行环境要求**");
  assert.notEqual(legit, host, "合法改写确实生效");
  assert.deepEqual(badgeProblems(mutated(legit), range), [], "合法改写（href / 正文措辞）不得误红");

  // hermetic：对照只改内存副本，三份真实文件逐字未变
  assert.equal(readFileSync(ROOT_README, "utf8"), root, "负向对照污染了根 README.md");
  assert.equal(readFileSync(HOST_README, "utf8"), host, "负向对照污染了包内 README.md");
  assert.equal(readFileSync(DIST_README, "utf8"), dist, "负向对照污染了 dist/README.md");
});
