/**
 * g-627：**宿主兼容面收窄**的结构守卫（真源唯一 + 旧分支不得回潮 + 迁移说明存在）。
 *
 * 为什么需要：v0.25.0 把宿主下限由 `>=0.1.5-rc.2 <0.2.3-0` 收紧到 `>=0.2.2-rc.3 <0.2.3-0`，
 * 并删除了一批只为更低版本保留的分支。这类改动最容易出的两类错：
 *   ① 只改了 `engines.dsh` 或只改了 peer（宿主门禁在 `engines.dsh` 存在时只认它，两处漂移会让
 *      「市场读到的范围」与「实际门禁」不一致）；
 *   ② 分支删了、但某处悄悄又长回来（「顺手兼容一下」），于是「跑在任何宿主上都不会用到的路径」
 *      重新进入维护面。
 *
 * 断言面：
 *  A. **真源唯一 + 下限可达质量**：`engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-settings"]`
 *     逐字相等；范围形态合法；下界解析后**恰为** `0.2.2-rc.3`（负责人裁决：rc.1/rc.2 从未真机验证）。
 *     本守卫对「下界」本身是硬钉的（它是本轮最核心的声明），对**范围串**的其它部分才跟随 manifest。
 *  A'. **跨文件一致性**（评审新增）：同一事实「最低支持的 DSH」在三处 —— manifest 下界、迁移说明
 *     §1「最低 DSH」、g624 形态声明的「宿主下限 = `>=<版本>`」—— 必须**逐字一致**，任一处漂移即判红。
 *     att-001 的失败形态正是三处「自洽地错」（都写 rc.1，而代码已删 rc.1 所需嵌套 spec）。
 *  B. **旧分支不得回潮**：`dsh-graph-host/index.js` 与 `lib/client/*.js` 的**可执行代码**里
 *     不得出现已下线的旧宿主 API（注释里记录「已删除」不算违规）。
 *  C. **迁移说明存在且被引用**：`docs/host-compat-v0.25.0.md` 必须列出「明确保留」与「已知限制」，
 *     且包内 README（随包发布）必须指向它。
 *  D. **负向对照**：对**内存副本**施加变异（只改 peer / 只改 engines / 加回旧分支 / 删迁移说明引用），
 *     同一套判定函数必须报红 —— 证明判据本身有效，而不是恒真。
 *  E. hermetic：负向对照只改副本变量，末尾断言真实文件逐字未变。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..");
const HOST_PKG = join(repoRoot, "dsh-graph-host", "package.json");
const CLIENT_DIR = join(repoRoot, "dsh-graph-host", "lib", "client");
const HOST_SOURCE = join(repoRoot, "dsh-graph-host", "index.js");
const HOST_README = join(repoRoot, "dsh-graph-host", "README.md");
const COMPAT_DOC_REL = "docs/host-compat-v0.25.0.md";
/** g624 形态守卫（其头注释声明「本版只支持扁平 spec」的宿主下限口径）。 */
const G624_SPEC_DOC_REL = "core/tests/g624-activation-spec-compat.test.ts";

/** 已下线的旧宿主 API（g-627 删除的收口分支）——不得再出现在可执行代码里。 */
const RETIRED_HOST_APIS: Array<{ label: string; pattern: RegExp }> = [
  { label: "subagents.startContinuable(", pattern: /\bstartContinuable\s*\(/ },
  { label: "subagents.interruptByParent(", pattern: /\binterruptByParent\s*\(/ },
  { label: "subagents.listChildren(", pattern: /\blistChildren\s*\(/ },
  { label: "agents.isOwnedBy(", pattern: /\bisOwnedBy\s*\(/ },
  { label: "subagents.list()（provider 枚举）", pattern: /\bsubagents\??\.list\s*\(/ },
  { label: "sessions.openSubagent(", pattern: /\bopenSubagent\s*\(/ },
  { label: "sessions.open 回退（rt.open(）", pattern: /\brt\??\.open\s*\(/ },
  { label: "snap.current / snap.currentAddress", pattern: /\bsnap\.current\b|\bsnap\.currentAddress\b/ },
  { label: "getSnapshot().queue（0.1.5 排队快照）", pattern: /getSnapshot\(\)\s*\.\s*queue/ },
];

/**
 * 只看**可执行代码**：抹掉行注释 / 块注释 / 字符串**内容**，输出与输入行数相同的数组（便于点名行号）。
 * 为什么不止去 `//`：本仓库的块注释（`/** … * …`）里会写「已删除 `startContinuable`」这类留痕，
 * 那是**说明**不是调用；字符串里的渲染文案同理。
 */
function stripCommentsWithLineMap(source: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | "str" = "code";
  let quote = "";
  const blank = (n: number) => source.slice(i, i + n).replace(/[^\n]/g, " ");
  while (i < source.length) {
    const c = source[i];
    const c2 = source[i + 1];
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += "\n"; i++; } else { out += blank(1); i++; }
      continue;
    }
    if (mode === "block") {
      if (c === "*" && c2 === "/") { out += blank(2); i += 2; mode = "code"; } else { out += blank(1); i++; }
      continue;
    }
    if (mode === "str") {
      if (c === "\\") { out += blank(2); i += 2; continue; }
      if (c === quote) { mode = "code"; out += c; i++; continue; }
      out += blank(1); i++; continue;
    }
    if (c === "/" && c2 === "/") { out += blank(2); i += 2; mode = "line"; continue; }
    if (c === "/" && c2 === "*") { out += blank(2); i += 2; mode = "block"; continue; }
    if (c === '"' || c === "'" || c === "`") { mode = "str"; quote = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

function codeLines(source: string): string[] {
  return stripCommentsWithLineMap(source).split("\n");
}

/** 一组源码里命中的下线 API（带文件与行号）。 */
function retiredFindings(sources: Array<{ name: string; text: string }>): string[] {
  const out: string[] = [];
  for (const { name, text } of sources) {
    const lines = codeLines(text);
    for (const { label, pattern } of RETIRED_HOST_APIS) {
      lines.forEach((line, i) => {
        if (pattern.test(line)) out.push(`${name}:${i + 1} 出现已下线的旧宿主 API「${label}」`);
      });
    }
  }
  return out;
}

/** 解析 `>=X <Y` 形态的兼容范围；不合法返回 null。 */
function parseHostRange(range: unknown): { lower: string; upper: string } | null {
  if (typeof range !== "string") return null;
  const m = /^>=(\S+) <(\S+)$/.exec(range.trim());
  return m ? { lower: m[1], upper: m[2] } : null;
}

/** 把 `0.2.2-rc.1` 归一成可比较的元组（数字段 + 预发布段字符串）。 */
function semverOf(version: string): { nums: number[]; pre: string | null } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** 语义化比较：返回 <0 / 0 / >0（预发布按「先于同号正式版」处理）。 */
function compareSemver(a: string, b: string): number {
  const x = semverOf(a);
  const y = semverOf(b);
  assert.ok(x && y, `非法版本串：${a} / ${b}`);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1; // 正式版 > 预发布
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** 判据全量判定（真实文件与内存副本共用同一实现）。 */
function narrowingProblems(input: {
  manifest: { engines?: Record<string, string>; peerDependencies?: Record<string, string> };
  sources: Array<{ name: string; text: string }>;
  hostReadme: string | null;
  compatDoc: string | null;
  g624Doc: string | null;
}): string[] {
  const problems: string[] = [];
  const enginesRange = input.manifest.engines?.dsh;
  const peerRange = input.manifest.peerDependencies?.["@deepseek-ai/dsh-settings"];
  if (!enginesRange) problems.push("manifest 必须声明 engines.dsh");
  if (!peerRange) problems.push('manifest 必须声明 peerDependencies["@deepseek-ai/dsh-settings"]');
  if (enginesRange && peerRange && enginesRange !== peerRange) {
    problems.push(`真源必须唯一：engines.dsh（${enginesRange}）与 peer 范围（${peerRange}）必须逐字相等`);
  }
  const parsed = parseHostRange(enginesRange);
  if (!parsed) {
    problems.push(`engines.dsh 形态必须为「>=<下界> <上界>」（实得 ${String(enginesRange)}）`);
  } else {
    const { lower, upper } = parsed;
    assertEqualRangeShape(problems, lower, upper);
    // 下界必须**恰好**是本轮声明的下限 `0.2.2-rc.3`（负责人裁决：rc.1/rc.2 从未真机验证，声称支持它们不实在）：
    // 放宽会重新把已删除嵌套 spec 分支的宿主纳入声明范围（rc.1 的 startActivation 读 spec.request.parent.id
    // ⇒ TypeError 静默误派）；抬高则会排除唯一真机验证过的宿主。
    if (compareSemver(lower, "0.2.2-rc.3") !== 0) problems.push(`下界必须恰为 0.2.2-rc.3（实得 ${lower}）⇒ 超出本轮声明的下限`);
    if (upper !== "0.2.3-0") problems.push(`上界必须为 0.2.3-0（未实测的下一线必须排除），实得 ${upper}`);
    problems.push(...crossFileConsistency(enginesRange, lower, input.compatDoc, input.g624Doc));
  }
  problems.push(...retiredFindings(input.sources));
  if (input.hostReadme === null) {
    problems.push("缺少随包发布的 dsh-graph-host/README.md");
  } else if (!input.hostReadme.includes("host-compat-v0.25.0.md")) {
    problems.push("包内 README 必须指向迁移说明 docs/host-compat-v0.25.0.md（用户从旧宿主升级时找得到）");
  }
  if (input.compatDoc === null) {
    problems.push(`缺少迁移说明 ${COMPAT_DOC_REL}`);
  } else {
    for (const need of ["明确保留", "已知限制", "升级步骤", "低于下限时的诊断"]) {
      if (!input.compatDoc.includes(need)) problems.push(`迁移说明缺少「${need}」小节`);
    }
  }
  return problems;
}

function assertEqualRangeShape(problems: string[], lower: string, upper: string): void {
  for (const [label, value] of [["下界", lower], ["上界", upper]] as const) {
    if (!semverOf(value)) problems.push(`兼容范围${label}不是合法 semver：${value}`);
  }
}

/**
 * **跨文件一致性**（评审要求新增，防再次漂移）：同一事实「本版最低支持的 DSH」散落在三处，
 * 任一处单独漂移都会产生**同类缺陷**（例如 att-001 就是 manifest 写 rc.1、迁移文档同步写 rc.1、
 * 而代码已删了 rc.1 所需的嵌套 spec ⇒ 三处「自洽地错」，对外宣告了一个跑不起来的宿主）。
 *
 * 三处口径：
 *   ① `dsh-graph-host/package.json` 的 `engines.dsh` **下界**（真源，其余两处都向它对齐）；
 *   ② `docs/host-compat-v0.25.0.md` §1「最低 DSH」行声明的版本；
 *   ③ `core/tests/g624-activation-spec-compat.test.ts` 头注释里「宿主下限 = `>=<版本>`」的形态声明。
 * 任一与 ① 逐字（按版本号解析后恰好相等）不一致 ⇒ 判红并点名漂移的那一处。
 *
 * 为什么用「解析后相等」而不是裸字符串包含：②③ 是散文，版本号两侧有反引号/加粗/不同措辞，
 * 裸子串比较会把合法排版判红；只要**版本号本身**逐字相同即可。反过来，`0.2.2-rc.1` 与
 * `0.2.2-rc.3` 解析后不等 ⇒ 任何真实漂移都接得住（负向对照已钉住）。
 */
function crossFileConsistency(
  enginesRange: string,
  lower: string,
  compatDoc: string | null,
  g624Doc: string | null,
): string[] {
  const problems: string[] = [];
  // ② 迁移说明 §1「最低 DSH」行
  if (compatDoc === null) {
    problems.push(`跨文件一致性：缺少迁移说明 ${COMPAT_DOC_REL}，无法核对「最低 DSH」`);
  } else {
    const row = /^\|\s*最低 DSH\s*\|\s*[^|]*\|\s*([^|]*)\|/m.exec(compatDoc);
    const declared = row ? /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(row[1])?.[1] : undefined;
    if (!declared) {
      problems.push(`跨文件一致性：${COMPAT_DOC_REL} 缺少可解析的「最低 DSH」行（必须声明下界 ${lower}）`);
    } else if (declared !== lower) {
      problems.push(
        `跨文件一致性：迁移说明「最低 DSH」= ${declared}，但 engines.dsh 下界 = ${lower} ⇒ 两者必须逐字一致`,
      );
    }
  }
  // ③ g624 形态声明的宿主下限
  if (g624Doc === null) {
    problems.push(`跨文件一致性：缺少形态守卫 ${G624_SPEC_DOC_REL}，无法核对形态声明的下限`);
  } else {
    const m = /宿主下限\s*=\s*`>=([^`\s]+)`/.exec(g624Doc);
    if (!m) {
      problems.push(`跨文件一致性：${G624_SPEC_DOC_REL} 缺少「宿主下限 = \`>=<版本>\`」形态声明（须声明 ${lower}）`);
    } else if (m[1] !== lower) {
      problems.push(
        `跨文件一致性：形态守卫声明的宿主下限 = ${m[1]}，但 engines.dsh 下界 = ${lower} ⇒ 两者必须逐字一致`,
      );
    }
  }
  // ① 自上而下自洽：engines 范围串里必须真的含这个下界（防止解析与原始串脱节）
  if (!enginesRange.includes(lower)) {
    problems.push(`跨文件一致性：engines.dsh（${enginesRange}）不含解析出的下界 ${lower}`);
  }
  return problems;
}

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function clientSources(): Array<{ name: string; text: string }> {
  return readdirSync(CLIENT_DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ name: `lib/client/${f}`, text: readFileSync(join(CLIENT_DIR, f), "utf8") }));
}

function realInput() {
  return {
    manifest: JSON.parse(readFileSync(HOST_PKG, "utf8")),
    sources: [{ name: "index.js", text: readFileSync(HOST_SOURCE, "utf8") }, ...clientSources()],
    hostReadme: readOrNull(HOST_README),
    compatDoc: readOrNull(join(repoRoot, COMPAT_DOC_REL)),
    g624Doc: readOrNull(join(repoRoot, G624_SPEC_DOC_REL)),
  };
}

// =============================================================================
// 判据：真源唯一 + 旧分支不回流 + 迁移说明在册
// =============================================================================

test("g-627 判据：宿主下限真源唯一、范围合法，旧宿主分支不得回潮，迁移说明在册", () => {
  assert.deepEqual(narrowingProblems(realInput()), []);
});

// =============================================================================
// 负向对照：变异必须全部被接住（只改内存副本）
// =============================================================================

test("g-627 负向对照：只改 peer / 只改 engines / 旧分支回潮 / 删迁移引用 必红；合法变更不误红", () => {
  const base = realInput();
  const expectRed = (mutate: (input: ReturnType<typeof realInput>) => void, needle: string, why: string) => {
    const copy = structuredClone(base);
    mutate(copy);
    const problems = narrowingProblems(copy);
    assert.ok(problems.some((p) => p.includes(needle)), `期望判红且点名「${needle}」（${why}），实得：${JSON.stringify(problems)}`);
  };

  // ① 只改 engines（peer 未同步）⇒ 真源不唯一
  expectRed((i) => { i.manifest.engines!.dsh = ">=0.2.2-rc.2 <0.2.3-0"; }, "真源必须唯一", "只改 engines");
  // ② 只改 peer ⇒ 同上
  expectRed((i) => { i.manifest.peerDependencies!["@deepseek-ai/dsh-settings"] = ">=0.2.2-rc.2 <0.2.3-0"; }, "真源必须唯一", "只改 peer");
  // ③ 下界退回旧值（放宽）⇒ 超出本轮下限
  expectRed((i) => {
    i.manifest.engines!.dsh = ">=0.1.5-rc.2 <0.2.3-0";
    i.manifest.peerDependencies!["@deepseek-ai/dsh-settings"] = ">=0.1.5-rc.2 <0.2.3-0";
  }, "超出本轮声明的下限", "下界退回 0.1.5-rc.2");
  // ④ 下界抬高到下一线（rc.3 之后）⇒ 不满足「恰为 0.2.2-rc.3」，且会排除当前已验证宿主
  expectRed((i) => {
    i.manifest.engines!.dsh = ">=0.2.3-rc.1 <0.2.3-0";
    i.manifest.peerDependencies!["@deepseek-ai/dsh-settings"] = ">=0.2.3-rc.1 <0.2.3-0";
  }, "下界必须恰为 0.2.2-rc.3", "下界抬高到下一线");
  // ④' 下界回落到 rc.1（att-001 的原始缺陷）⇒ 重新把只剩嵌套 spec 的宿主纳入声明范围
  expectRed((i) => {
    i.manifest.engines!.dsh = ">=0.2.2-rc.1 <0.2.3-0";
    i.manifest.peerDependencies!["@deepseek-ai/dsh-settings"] = ">=0.2.2-rc.1 <0.2.3-0";
  }, "下界必须恰为 0.2.2-rc.3", "下界退回 rc.1");
  // ⑤ 上界放宽到未实测的下一线
  expectRed((i) => {
    i.manifest.engines!.dsh = ">=0.2.2-rc.3 <0.2.4-0";
    i.manifest.peerDependencies!["@deepseek-ai/dsh-settings"] = ">=0.2.2-rc.3 <0.2.4-0";
  }, "上界必须为 0.2.3-0", "上界放宽");
  // ⑥ 旧分支回潮（代码里重新调用已下线 API）
  expectRed((i) => { i.sources[0].text += "\nconst legacy = () => subagents.startContinuable({ provider: \"spawn\" });\n"; },
    "startContinuable", "旧派发名回潮");
  expectRed((i) => { i.sources[0].text += "\nconst legacy2 = () => agents.isOwnedBy(id, owner);\n"; },
    "isOwnedBy", "旧归属 API 回潮");
  expectRed((i) => { i.sources.filter((s) => s.name.includes("client")).at(0)!.text += "\nconst nav = (rt) => rt.open(id);\n"; },
    "sessions.open 回退", "客户端会话导航回退回潮");
  // ⑦ 迁移说明引用被删
  expectRed((i) => { i.hostReadme = "（无引用）"; }, "必须指向迁移说明", "删 README 引用");
  // ⑧ 迁移说明缺失 / 缺小节
  expectRed((i) => { i.compatDoc = null; }, "缺少迁移说明", "删迁移说明");
  expectRed((i) => { i.compatDoc = i.compatDoc!.replace("明确保留", "其他"); }, "明确保留", "删保留清单小节");

  // ⑧' **跨文件一致性**（评审要求）：三处口径任一处漂移必红且点名。三处 = manifest 下界 /
  //   迁移说明 §1「最低 DSH」/ g624 形态声明的「宿主下限 = `>=<版本>`」。
  const LOWER = "0.2.2-rc.3";
  // (a) 只改迁移说明 ⇒ 与 manifest 漂移
  expectRed((i) => { i.compatDoc = i.compatDoc!.replace("**`0.2.2-rc.3`**", "**`0.2.2-rc.1`**"); },
    "迁移说明「最低 DSH」= 0.2.2-rc.1", "只改迁移说明最低 DSH");
  // (b) 只改 g624 形态声明 ⇒ 与 manifest 漂移（att-001 的自相矛盾正属此形态）
  expectRed((i) => { i.g624Doc = i.g624Doc!.replace("宿主下限 = `>=0.2.2-rc.3`", "宿主下限 = `>=0.2.2-rc.1`"); },
    "形态守卫声明的宿主下限 = 0.2.2-rc.1", "只改 g624 形态声明");
  // (c) 三处**一起**改回 rc.1 ⇒ 下界硬钉仍判红（自洽地错也必须红）
  expectRed((i) => {
    i.manifest.engines!.dsh = `>=${"0.2.2-rc.1"} <0.2.3-0`;
    i.manifest.peerDependencies!["@deepseek-ai/dsh-settings"] = i.manifest.engines!.dsh;
    i.compatDoc = i.compatDoc!.replace("**`0.2.2-rc.3`**", "**`0.2.2-rc.1`**");
    i.g624Doc = i.g624Doc!.replace("宿主下限 = `>=0.2.2-rc.3`", "宿主下限 = `>=0.2.2-rc.1`");
  }, "下界必须恰为 0.2.2-rc.3", "三处一起改回 rc.1（自洽地错）");
  // (d) 迁移说明的「最低 DSH」行被删 ⇒ 无从核对，判红
  expectRed((i) => { i.compatDoc = i.compatDoc!.replace(/^\|\s*最低 DSH\s*\|.*$/m, ""); },
    "缺少可解析的「最低 DSH」行", "删最低 DSH 行");
  // (e) g624 形态声明被删 ⇒ 无从核对，判红
  expectRed((i) => { i.g624Doc = i.g624Doc!.replace("宿主下限 = `>=0.2.2-rc.3`", "宿主下限已定"); },
    "缺少「宿主下限", "删 g624 形态声明");

  // ⑨ 合法变更不得误红：注释里提到已删除的旧 API（留痕）不是违规
  const withComment = structuredClone(base);
  withComment.sources[0].text += "\n// g-627：旧名 startContinuable / isOwnedBy 分支已删除（留痕说明，不算代码）\n";
  assert.deepEqual(narrowingProblems(withComment), [], "注释里的历史说明不得误红");
  // ⑩ 合法变更不得误红：上界以外的合法重排（换行/空白）不影响判定
  const reformatted = structuredClone(base);
  reformatted.manifest.engines!.dsh = `  ${reformatted.manifest.engines!.dsh}  `;
  reformatted.manifest.peerDependencies!["@deepseek-ai/dsh-settings"] = reformatted.manifest.engines!.dsh;
  assert.deepEqual(narrowingProblems(reformatted), [], "范围串两侧空白不得误红（按 trim 后逐字比较）");
});

// =============================================================================
// hermetic：负向对照只改内存副本
// =============================================================================

test("g-627 hermetic：负向对照未污染真实 manifest / 源文件 / README / 迁移说明 / g624 形态守卫", () => {
  const before = realInput();
  narrowingProblems(before);
  structuredClone(before);
  const after = realInput();
  assert.deepEqual(after.manifest, before.manifest, "真实 manifest 被污染");
  assert.deepEqual(after.sources, before.sources, "真实源文件被污染");
  assert.equal(after.hostReadme, before.hostReadme, "真实 README 被污染");
  assert.equal(after.compatDoc, before.compatDoc, "真实迁移说明被污染");
  assert.equal(after.g624Doc, before.g624Doc, "真实 g624 形态守卫被污染");
});
