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
const ROOT_README = join(repoRoot, "README.md");
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
  rootReadme: string | null;
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
    problems.push(...proseRangeConsistency(enginesRange, lower, [
      { name: "dsh-graph-host/README.md", text: input.hostReadme },
      { name: "README.md", text: input.rootReadme },
    ], input.sources));
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

/**
 * **散文口径一致性**（g-627 第三轮返工新增；B1/B2 复发的直接防线）。
 *
 * `crossFileConsistency` 只核「版本号」三处真源，覆盖不到**散文里对范围的断言**：att-002 的两个
 * 复发缺陷正是这一类 —— README 说「`0.1.x`、`0.2.0` 各版本本次未逐版验证 … 本版不做收窄或扩张」
 * （把已退出的旧线说成**仍在声明范围内**），以及 `index.js` 注释写「engines 下界维持 >=0.1.5-rc.2,
 * 不得抬高」（与真源相反的**指令性**口吻，写在产品源码里）。
 *
 * 判定口径是「**声明语境**」而不是「出现即红」——历史描述必须可留，故：
 *   A. README：同一条列表项里既出现**低于下界**的旧版本号、又出现「未逐版验证」这类**把它们算作
 *      声明范围**的措辞 ⇒ 红；若该条同时**明确**把它们标为不在支持范围（`已不在支持范围` /
 *      `不再支持` / no longer supported 等），则视为正确写法，放行。
 *   B. 源码注释：出现旧下界 `>=0.1.5-rc.2` 或 `不得抬高`/`维持` 一类**与当前下限相反的指令性**
 *      断言 ⇒ 红（正确写法是引用 `>=0.2.2-rc.3` 且说明「不改变下限」）。
 * C. 历史描述可留的唯一形态：把旧版本号放在**显式标注为非当前**的句子里（本函数的负向对照里
 *     `历史描述（**已不在支持范围**…）` 即该形态）。
 */
function proseRangeConsistency(
  enginesRange: string,
  lower: string,
  readmes: Array<{ name: string; text: string | null }>,
  sources: Array<{ name: string; text: string }>,
): string[] {
  const problems: string[] = [];
  const belowFloor = /\b0\.1\.[0-9]|\b0\.1\.x|\b0\.2\.[01](?![0-9])/;
  // 「把它们算作声明范围」的措辞：未逐版验证 / 声明的其余宿主版本 / 不做收窄或扩张
  const countsAsInScope = /未逐版验证|未逐版核实|声明的其余宿主版本|其余宿主版本|不做收窄或扩张|neither narrows nor widens|does neither/i;
  // 「明确排除」的措辞：写了就等于正确（不是把它们当成在范围内）。
  // 含「低于宿主下限 / 低于下限 / 已删除 / 不再支持」等 —— 历史描述必须**显式**落在这一族措辞里才放行。
  const explicitlyExcluded = /已不在支持范围|不再支持|不支持|已删除|低于宿主下限|低于下限|低于下界|no longer supported|not supported|below the (?:host )?(?:lower bound|floor)/i;

  for (const { name, text } of readmes) {
    if (text === null) {
      problems.push(`散文口径：缺少 ${name}，无法核对支持范围散文`);
      continue;
    }
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!belowFloor.test(line) || !countsAsInScope.test(line)) return;
      if (explicitlyExcluded.test(line)) return;
      problems.push(
        `散文口径：${name}:${i + 1} 把低于下界 ${lower} 的旧宿主版本描述为声明范围内（「未逐版验证」一类）`
        + " ⇒ 必须改为「只在历史轮次实测；当前声明范围未逐版验证」或显式标注已不在支持范围",
      );
    });
  }

  // 「与当前下限相反的指令性注释」：旧下界串 + 不得抬高/维持 的口吻
  for (const src of sources) {
    const lines = src.text.split("\n");
    lines.forEach((line, i) => {
      // 「与 engines 下限相反的指令性断言」必须**同时**满足两点才判红，避免误伤与下限无关的
      // 普通散文（如「维持一条定时器」「准入错误维持 400」）：
      //   ① 出现**低于下界**的版本号（旧下界 `>=0.1.x` / `0.1.5-rc.x` / `0.1.x` / `0.2.0/0.2.1`），或
      //   ② 出现 `不得抬高` 这类**明说下限的升降**口吻（本身即指令性）。
      const belowFloorInLine = /\b0\.1\.[0-9]|\b0\.1\.x|>=0\.1\.|\b0\.2\.[01](?![0-9])/.test(line);
      const directive = /不得抬高/.test(line);
      const maintainTone = /维持/.test(line) && /engines|下界|下限/.test(line);
      if (!((directive || maintainTone) || (belowFloorInLine && /engines|下界|下限/.test(line)))) return;
      if (explicitlyExcluded.test(line)) return;
      problems.push(
        `散文口径：${src.name}:${i + 1} 出现与当前下限 ${lower} 相反的指令性断言（「不得抬高」/旧下界）`
        + " ⇒ 应改为「engines 下界 = >=0.2.2-rc.3（见 package.json）；特性探测仅用于缺能力时静默降级，不改变下限」",
      );
    });
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
    rootReadme: readOrNull(ROOT_README),
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

/** att-002 的缺陷原文（B1）：把已退出的 `0.1.x` / `0.2.0` 说成仍在声明范围内，并称本版不收窄。 */
const B1_DEFECTIVE_ZH = "- **实测范围（如实）**：本节的鉴权行为只在 **DSH `0.2.1-rc.2`** 上实测（真实宿主 `BrowserAuth` + 真实 Token 交换 + 真实 HTTP）。`engines.dsh` 声明的其余宿主版本（含 `0.1.x`、`0.2.0` 各版本）**本次未逐版验证**；若某宿主缺少公开 `admit`，按上表 HTTP 入口会 503，这一点**未经逐版核实**，因此不能把声明范围读成「当前 Web 鉴权结论」。兼容范围的取舍由维护者决定，本版不做收窄或扩张。";
const B2_DEFECTIVE_EN = "- **Verified scope, stated plainly**: the behaviour in this section was measured **only on DSH `0.2.1-rc.2`** (real host `BrowserAuth`, real token exchange, real HTTP). The other host versions declared in `engines.dsh` (including `0.1.x` and the `0.2.0` line) were **not verified version by version** in this round. Widening or narrowing the range is the maintainer's call; this release does neither.";

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

  // ⑧'' **散文口径**（第三轮返工新增，B1/B2 复发的直接防线）：README 把旧线说成在范围内、
  //      index.js 写「不得抬高」这类相反指令 ⇒ 必红。
  // (f) README 中文 —— **逐字复原 att-002 的缺陷原文**（B1 原形），必须判红
  expectRed((i) => {
    i.hostReadme = i.hostReadme!.replace(
      /^- \*\*实测范围（如实）\*\*：.*$/m,
      B1_DEFECTIVE_ZH,
    );
  }, "README.md:", "README 把 0.1.x/0.2.0 说成声明范围内（B1 原形）");
  // (g) README 英文镜像复原缺陷原文
  expectRed((i) => {
    i.hostReadme = i.hostReadme!.replace(/^- \*\*Verified scope, stated plainly\*\*:.*$/m, B2_DEFECTIVE_EN);
  }, "README.md:", "README 英文镜像把 0.1.x/0.2.0 说成声明范围内");
  // (h) 「本版不做收窄或扩张」（与 :45 已收窄直接矛盾）
  expectRed((i) => {
    i.hostReadme = i.hostReadme!.replace(/^- \*\*Verified scope, stated plainly\*\*:.*$/m,
      "- **Verified scope**: the other host versions declared in `engines.dsh` (including `0.1.x` and the `0.2.0` line) were **not verified version by version**; widening or narrowing the range is the maintainer's call; this release does neither.");
  }, "README.md:", "README 称本版不做收窄或扩张");
  // (f') 仓库根 README 同一类散文（第四处残留，本轮全仓扫描发现）必须判红
  expectRed((i) => {
    i.rootReadme = i.rootReadme!.replace(/^鉴权行为只在 DSH `0\.2\.1-rc\.2`.*$/m,
      "鉴权行为只在 DSH `0.2.1-rc.2` 实测；`engines.dsh` 声明的其它宿主版本未逐版验证。完整口径见下。");
  }, "README.md:", "根 README 把其它宿主版本说成仍在声明范围内");

  // (i) index.js 出现「engines 下界维持 >=0.1.5-rc.2，不得抬高」这类与当前下限相反的指令性注释（B2 原形）
  expectRed((i) => {
    i.sources[0].text += "\n// 不影响 attempt 生命周期与既有功能）。engines 下界维持 >=0.1.5-rc.2，**不得抬高**。\n";
  }, "不得抬高", "index.js 写入「不得抬高」相反指令（B2 原形）");
  // (j) index.js 仅「不得抬高」口吻（不写旧版本号）同样判红
  expectRed((i) => {
    i.sources[0].text += "\n// engines 下界不得抬高。\n";
  }, "不得抬高", "index.js 仅出现「不得抬高」口吻");
  // (k) 客户端模块同样纳入扫描
  expectRed((i) => {
    i.sources.filter((x) => x.name.includes("client")).at(0)!.text += "\n// engines 下界不得抬高\n";
  }, "不得抬高", "客户端模块出现相反指令");

  // ⑨ 合法变更不得误红：注释里提到已删除的旧 API（留痕）不是违规
  const withComment = structuredClone(base);
  withComment.sources[0].text += "\n// g-627：旧名 startContinuable / isOwnedBy 分支已删除（留痕说明，不算代码）\n";
  assert.deepEqual(narrowingProblems(withComment), [], "注释里的历史说明不得误红");
  // ⑨' 散文口径不得误红：把旧版本号写成**显式历史描述**是正确形态，必须放行
  const asHistory = structuredClone(base);
  asHistory.sources[0].text += "\n// 历史描述（**已不在支持范围**，仅解释代码为何仍容忍该字段被忽略）：0.1.5-rc.2 / 0.1.5-rc.3\n";
  asHistory.hostReadme = asHistory.hostReadme!.replace(
    "当前声明范围 `>=0.2.2-rc.3` 上的鉴权**未逐版验证**",
    "当前声明范围 `>=0.2.2-rc.3` 上的鉴权**未逐版验证**；`0.1.x`、`0.2.0`、`0.2.1` 已不在支持范围",
  );
  // 防静默空操作：`replace` 无匹配时不报错，会让这条“不误红对照”退化为恒真。
  assert.ok(
    asHistory.hostReadme!.includes("`0.1.x`、`0.2.0`、`0.2.1` 已不在支持范围"),
    "⑨' 对照必须真正改到 README 文案（否则本用例静默变成空操作）",
  );
  assert.deepEqual(narrowingProblems(asHistory), [], "显式标注为历史描述的旧版本号不得误红");

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
