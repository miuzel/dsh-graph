/**
 * g-347 守护（g-349 收敛版）：`graph_help` 帮助资产（`dsh-graph-host/prompts/help.{zh,en}.md`）
 * 必须与引擎 tool schema 对齐。
 *
 * 为什么需要：`graph_help` 是主管会话的**首要工具速查**，而该资产此前**零测试覆盖**。
 * 引擎在 g-311（fast_track/machine_report）、g-329 等目标里加了参数，帮助文本没跟，
 * 主管据此误判「没有机器快速放行通道」——属「文档落后于引擎」的静默失效。
 * 本套件把「帮助资产 = 引擎 schema 的投影」变成机器断言：引擎加参数/加工具而帮助没跟 → 必红。
 *
 * 断言面（真源固定为 `apply()` 实际注册的 tool def，不硬编码 44 名单）：
 *  A. 工具集合：schema 44 个 graph_* 工具与 zh/en 两份帮助的条目**逐一相等**（不缺、不多、不重复），
 *     且两份帮助的条目**顺序一致**；文件头声明的工具计数与 schema 实数一致；
 *  B. 参数面：每个工具帮助行必须提及该工具 schema 的**全部**参数名（zh/en 双向），
 *     且**可选性必须与 schema 一致**（必填不带方括号、可选必须带方括号）；
 *  C. 关键参数钉在对应工具行：`fast_track`/`machine_report` 在 `graph_resolve_accept` 行、
 *     `legacy` 在 `graph_unbind_goal_child` 行；
 *  D. 端到端：`graph_help` 的 run() 返回值（zh）与源资产逐字一致，且 dist 副本与源逐字一致；
 *  E. 加载机制：在 tmp 私有镜像里改资产 → 同一模块实例再次 run() 立即反映新内容
 *     ⇒ 证明 `graph_help` 是**每次调用读取**（`readFileSync`）而非启动缓存，build 后无需重启宿主。
 *  F. 负向对照：对**内存中的字符串副本**做变异，实测「改坏即红 / 合法改写不误红」
 *     （不触碰仓库文件，因此可随套件长期回归）。
 *
 * ── g-349 相对 g-347 的四处收敛（每处均保持原判别力，见各测试注释）──
 *  1. B 启用此前被提取却无人引用的 `ToolDef.required`（死字段）：新增「可选写成必填」「必填写成可选」
 *     两类必红，失败信息点出**具体工具 + 参数名**。原判别力（缺参/多参/schema 外 token）逐条保留。
 *  2. B/C 不再绑定**物理行**：解析前按「括号未闭合」或「缩进续行」拼接逻辑行（Markdown 合法折行 ⇒ 绿）；
 *     仍未闭合的条目给出**专属报错**。原判别力（真漏参、多参仍红）由 F 实证保持。
 *  3. A3 与英文/中文措辞解耦：不再匹配 `N total` / `共 N 个`，改为「文件头出现的数字必须等于 schema 实数」。
 *  4. A3/B 的核心判定抽成纯函数（`structureProblems`/`signatureProblems`/`countProblems`），
 *     既供真实文件断言使用，也供 F 对内存副本做负向对照 ⇒ 判别力本身被自动化钉住。
 *
 * ── g-349 att-002 相对 att-001 的三处收敛（fresh 复核点名的 R1/R2/R3）──
 *  R1 union 逃逸口：one-of 组加**白名单**（`UNION_WHITELIST`）。att-001 只约束「成员须 schema 可选
 *     + 组≥2 成员」，于是「≥2 个可选参数」可被顺手压成 `{a|b|c}` 而完全免除方括号 ⇒ 可产出
 *     谎称互斥的文档却不红。现在只有引擎**确有 XOR 校验**的工具参数组合才允许写成 `{a|b}`。
 *  R2 计数误红面：文件头与工具计数无关的数字不再参与判定——先剔除版本号类 token，存在
 *     「计数语境」数字时只判定它们（`dsh-graph v0.16.0 …` 头部由 RED 变 GREEN；缺声明/数字写错仍红）。
 *  R3 测试 E 去 tmp 依赖：镜像改建在 `os.tmpdir()` 并符号链接仓库 `node_modules`（供 yaml 解析），
 *     不再需要仓库内可写的 `tmp/` ⇒ 只读检出也能跑；`finally` 负责清理、异常退出不落仓库残留。
 *
 * 结构性例外（唯一）：`graph_unbind_goal_child` 的 `{attempt|child_id}` 是「二者恰取其一」的
 * one-of 记号（schema 中两者均为可选，运行时由引擎 `if (hasAtt === hasChild) throw` 校验恰好其一）
 * ⇒ 它是 `UNION_WHITELIST` 里的**唯一**合法项。解析器为 union 单列一桶，三重约束缺一不可：
 * 组内成员只能是 schema 可选参数、组至少 2 个成员、且「工具名 + 成员集合」必须命中白名单——
 * 因此 `{state}` 这类单成员组与 `graph_memory_replace(old, text, {kind|importance|source_goal})`
 * 这类**假 XOR**（顺带免除方括号）都必红。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { apply } from "../../dist/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const SOURCE_HELP = {
  zh: join(repoRoot, "dsh-graph-host", "prompts", "help.zh.md"),
  en: join(repoRoot, "dsh-graph-host", "prompts", "help.en.md"),
};
const DIST_HELP = {
  zh: join(repoRoot, "dist", "prompts", "help.zh.md"),
  en: join(repoRoot, "dist", "prompts", "help.en.md"),
};

type ToolDef = { name: string; params: string[]; required: string[] };
type HelpEntry = { name: string; line: string; lineNo: number };
type SigShape = { bare: string[]; bracketed: string[]; unions: string[][] };

/**
 * one-of（union）记号白名单：只有**引擎确有互斥/XOR 校验**的工具参数组合才允许写成 `{a|b}`。
 * 依据 `dsh-graph-host/index.js` 里 `graph_unbind_goal_child` 的 run：
 * `if (hasAtt === hasChild) throw new GraphError("必须且只能指定一个选择器：attempt 或 child_id")`
 * —— 只有 attempt/child_id 是真正的 XOR。
 * 白名单按「工具名 → 合法成员集合（成员顺序无关）」登记；未命中的 union 组一律判红，
 * 以免作者把多个可选参数「顺手压缩」成一个**假 XOR**（文档谎称互斥，同时免除方括号）。
 */
const UNION_WHITELIST: Record<string, string[][]> = {
  graph_unbind_goal_child: [["attempt", "child_id"]],
};

/** 成员集合比较（顺序无关）：`{child_id|attempt}` 与 `{attempt|child_id}` 视为同一组。 */
function sameMemberSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
}

/** 与既有 host 测试同一套 mock ctx：apply 后从 ctx.tools.register 收集真实 tool def。 */
function mockContext(root: string) {
  const registered: any[] = [];
  const webServer = { register: () => () => {} };
  const ctx: any = {
    get: (name: string) =>
      name === "sandboxPolicy" ? { workspaceRoot: root } : name === "webServer" ? webServer : undefined,
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: {
      register: (def: any) => { registered.push(def); return () => {}; },
      get: () => ({}),
    },
  };
  return { ctx, registered };
}

function toolDefsFrom(applyFn: any): ToolDef[] {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g347-"));
  const { ctx, registered } = mockContext(root);
  applyFn(ctx, { root });
  return registered
    .filter((d) => typeof d?.name === "string" && d.name.startsWith("graph_"))
    .map((d) => ({
      name: d.name as string,
      params: Object.keys(d.parameters?.properties ?? {}),
      required: (d.parameters?.required ?? []) as string[],
    }));
}

/** `(`/`[`/`{` 是否成对闭合（用于判定折行续行与「括号未闭合」）。 */
function isBalanced(s: string): boolean {
  let p = 0, b = 0, c = 0;
  for (const ch of s) {
    if (ch === "(") p++;
    else if (ch === ")") p--;
    else if (ch === "[") b++;
    else if (ch === "]") b--;
    else if (ch === "{") c++;
    else if (ch === "}") c--;
  }
  return p === 0 && b === 0 && c === 0;
}

/**
 * 解析帮助资产：只认 `- graph_xxx(` 开头的条目行（章节/散文不算条目）。
 * 逻辑行拼装：条目行之后，若**括号尚未闭合**（签名合法折行）或该行**有缩进**（散文续行），
 * 则并入同一条目 ⇒ 折行不再把一条签名拆成两段而误报「缺参」。
 */
function parseHelp(text: string): HelpEntry[] {
  const out: HelpEntry[] = [];
  let cur: { name: string; parts: string[]; lineNo: number } | null = null;
  const flush = () => {
    if (cur) out.push({ name: cur.name, line: cur.parts.join("\n"), lineNo: cur.lineNo });
    cur = null;
  };
  text.split("\n").forEach((line, i) => {
    const trimmed = line.trimEnd();
    const m = trimmed.match(/^- (graph_[a-z0-9_]+)\s*\(/);
    if (m) {
      flush();
      cur = { name: m[1], parts: [trimmed], lineNo: i + 1 };
      return;
    }
    if (!cur) return;
    const blank = trimmed.trim() === "";
    // 新章节标题 / 新列表项 / 新有序项 ⇒ 上一条目到此结束
    const structural = blank || /^\s*(#|- |\* |\d+\. )/.test(trimmed);
    const indented = /^\s/.test(line) && !blank;
    if (!structural && (!isBalanced(cur.parts.join("\n")) || indented)) {
      cur.parts.push(trimmed.trim());
      return;
    }
    flush();
  });
  flush();
  return out;
}

/** 取出条目签名括号内的参数面（不含括号后的散文描述）。 */
function signatureOf(line: string): string {
  const start = line.indexOf("(");
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")") {
      depth--;
      if (depth === 0) return line.slice(start, i + 1);
    }
  }
  return line.slice(start);
}

/**
 * 解析签名括号内的可选性形态：裸写=必填外观、`[...]`=可选外观、`{a|b}`=one-of 组。
 * 兼容 `name[]`（数组标记）与括号内嵌 `{, a|b}`。
 */
function parseSignatureShape(sig: string): SigShape {
  const body = sig.slice(1, -1);
  const bare: string[] = [];
  const bracketed: string[] = [];
  const unions: string[][] = [];
  let buf = "";
  const splitUnion = (t: string) => t.replace(/[{}]/g, "").split("|").map((s) => s.trim()).filter(Boolean);
  const flushBare = () => {
    const t = buf.trim();
    buf = "";
    if (!t) return;
    if (t.startsWith("{")) unions.push(splitUnion(t));
    else bare.push(t.replace(/\[\]$/, "").trim());
  };
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "[") {
      let depth = 0;
      let j = i;
      for (; j < body.length; j++) {
        if (body[j] === "[") depth++;
        else if (body[j] === "]") { depth--; if (depth === 0) break; }
      }
      for (const tok of body.slice(i + 1, j).split(",")) {
        const t = tok.trim();
        if (!t) continue;
        if (t.startsWith("{")) unions.push(splitUnion(t));
        else bracketed.push(t.replace(/\[\]$/, "").trim());
      }
      i = j + 1;
    } else if (ch === "{") {
      let depth = 0;
      let j = i;
      for (; j < body.length; j++) {
        if (body[j] === "{") depth++;
        else if (body[j] === "}") { depth--; if (depth === 0) break; }
      }
      unions.push(splitUnion(body.slice(i + 1, j)));
      i = j + 1;
    } else if (ch === ",") {
      flushBare();
      i++;
    } else {
      buf += ch;
      i++;
    }
  }
  flushBare();
  return { bare, bracketed, unions };
}

/** 结构面（条目数与工具集合）：A2 用，F 的「整条条目被删」负向对照亦复用。 */
function structureProblems(entries: HelpEntry[], defs: ToolDef[], lang: string): string[] {
  const problems: string[] = [];
  const schemaNames = defs.map((d) => d.name);
  const names = entries.map((e) => e.name);
  if (names.length !== defs.length) {
    problems.push(`help.${lang}.md 条目数 ${names.length} 与 schema 实数 ${defs.length} 不一致`);
  }
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupes.length) problems.push(`help.${lang}.md 存在重复条目: ${dupes.join(", ")}`);
  const missing = schemaNames.filter((n) => !names.includes(n));
  if (missing.length) problems.push(`help.${lang}.md 缺少工具条目: ${missing.join(", ")}`);
  const extra = names.filter((n) => !schemaNames.includes(n));
  if (extra.length) problems.push(`help.${lang}.md 含 schema 外条目: ${extra.join(", ")}`);
  return problems;
}

/**
 * 参数面 + 可选性面 + union 白名单：B 用，F 复用。失败信息一律包含「文件名:行号 工具名」+
 * 具体参数名（union 场景含成员名）。`unionWhitelist` 可注入：F 用合成 def，故传合成白名单。
 */
function signatureProblems(
  entries: HelpEntry[],
  defByName: Map<string, ToolDef>,
  lang: string,
  unionWhitelist: Record<string, string[][]> = UNION_WHITELIST,
): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    const at = `help.${lang}.md:${entry.lineNo} ${entry.name}`;
    const def = defByName.get(entry.name);
    if (!def) {
      problems.push(`${at} 不在引擎 schema 中`);
      continue;
    }
    if (!isBalanced(entry.line)) {
      problems.push(`${at} 签名括号未闭合（折行续行未能拼装，或括号/方括号缺失）`);
      continue;
    }
    const sig = signatureOf(entry.line);
    if (!sig) {
      problems.push(`${at} 条目行缺少签名括号`);
      continue;
    }
    const shape = parseSignatureShape(sig);
    const schemaRequired = [...def.required];
    const schemaOptional = def.params.filter((p) => !schemaRequired.includes(p));
    const unionMembers = shape.unions.flat();
    const inSignature = [...shape.bare, ...shape.bracketed, ...unionMembers];

    // ── 原 g-347 B 判别力：参数名覆盖 + schema 外 token ──
    const missing = def.params.filter((p) => !inSignature.includes(p));
    if (missing.length) problems.push(`${at} 签名缺参数: ${missing.join(", ")}`);
    const foreign = [...new Set(inSignature.filter((p) => !def.params.includes(p)))];
    if (foreign.length) problems.push(`${at} 签名含 schema 外 token: ${foreign.join(", ")}`);
    const dupes = [...new Set(inSignature.filter((p, i) => inSignature.indexOf(p) !== i))];
    if (dupes.length) problems.push(`${at} 签名参数重复: ${dupes.join(", ")}`);

    // ── g-349 新增：可选性 = schema.required 的投影 ──
    // ① 可选写成必填（少写方括号）
    const optionalWrittenBare = shape.bare.filter((p) => !schemaRequired.includes(p));
    if (optionalWrittenBare.length) {
      problems.push(`${at} 可选参数被写成必填（应加方括号）: ${optionalWrittenBare.join(", ")}`);
    }
    // ② 必填写成可选（多写方括号 / 塞进 one-of 组）
    const requiredWrittenOptional = [...shape.bracketed, ...unionMembers].filter(
      (p) => !schemaOptional.includes(p),
    );
    if (requiredWrittenOptional.length) {
      problems.push(`${at} 必填参数被写成可选（不应加方括号）: ${requiredWrittenOptional.join(", ")}`);
    }
    // ③ 覆盖面兜底（与 ①② 去重，避免同一参数重复报）
    const missingBare = schemaRequired.filter(
      (p) => !shape.bare.includes(p) && !optionalWrittenBare.includes(p),
    );
    if (missingBare.length) problems.push(`${at} 必填参数未以裸写形式出现: ${missingBare.join(", ")}`);
    const missingBrackets = schemaOptional.filter(
      (p) => !shape.bracketed.includes(p) && !unionMembers.includes(p) && !optionalWrittenBare.includes(p),
    );
    if (missingBrackets.length) problems.push(`${at} 可选参数未加方括号: ${missingBrackets.join(", ")}`);

    // ── one-of 组约束（三重）：单成员组不可绕过方括号；多成员组必须是白名单里的**真 XOR** ──
    // 白名单由 UNION_WHITELIST 登记（唯一合法项 graph_unbind_goal_child 的 {attempt|child_id}）。
    const allowedGroups = unionWhitelist[def.name] ?? [];
    for (const group of shape.unions) {
      if (group.length < 2) {
        problems.push(`${at} one-of 组至少需 2 个成员（不可用于绕过方括号）: {${group.join("|")}}`);
        continue;
      }
      if (!allowedGroups.some((allowed) => sameMemberSet(allowed, group))) {
        problems.push(
          `${at} one-of 组 {${group.join("|")}} 不在白名单（只有引擎确有互斥/XOR 校验的工具才能用 {a|b} 免除方括号）`,
        );
      }
    }
  }
  return problems;
}

/** 文件头原文（第一个 `## ` 之前；无章节标题则整篇）。 */
function headerOf(text: string): string {
  const lines = text.split("\n");
  const end = lines.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? lines : lines.slice(0, end)).join("\n");
}

/** 版本号类 token（`v0.16.0` / `0.16.0`）：与工具计数无关，判定前整体剔除。 */
const VERSION_TOKEN = /\bv?\d+(?:\.\d+)+/gi;
/** 「计数语境」：数字紧邻计数词（`44 tools` / `44 个` / `44 total`）。 */
const COUNT_AFTER_NUMBER = /(\d+)\s*(?:个|项|工具|tools?\b|total\b|available\b|count\b)/gi;
/** 「计数语境」：计数词紧邻数字（`共 44` / `total of 44`）。 */
const COUNT_BEFORE_NUMBER = /(?:共|总计|tool\s*count|total\s+of|count\s+of|available)\s*[:：]?\s*(\d+)/gi;

/**
 * 文件头「工具计数声明」的数字：与措辞解耦，只要求「声明的数字 == schema 实数」。
 * 收窄（g-349 att-002 / R2）：与计数无关的数字不参与判定——
 *  1) 版本号类 token 先整体剔除（最小复现：首行写 `dsh-graph v0.16.0 … (44 total)` 曾误红）；
 *  2) 存在「计数语境」数字时**只**判定它们，其余数字（章节号/日期等）忽略；
 *  3) 没有计数语境数字时退回「其余非版本数字都视作声明」；一个数字都没有 ⇒ 返回空 ⇒ 判「缺少计数声明」。
 * 判别力不下降：缺声明必红、声明数字写错必红（两种写法各由 F 钉住）。
 */
function countDeclarations(text: string): number[] {
  const stripped = headerOf(text).replace(VERSION_TOKEN, " ");
  const found = new Set<number>();
  for (const m of stripped.matchAll(COUNT_AFTER_NUMBER)) found.add(Number(m[1]));
  for (const m of stripped.matchAll(COUNT_BEFORE_NUMBER)) found.add(Number(m[1]));
  if (found.size) return [...found];
  return [...new Set((stripped.match(/\d+/g) ?? []).map(Number))];
}

function countProblems(text: string, lang: string, expected: number): string[] {
  const nums = countDeclarations(text);
  const problems: string[] = [];
  if (nums.length === 0) {
    problems.push(`help.${lang}.md 文件头缺少工具计数声明（未解析到声明的工具数）`);
  }
  for (const n of nums) {
    if (n !== expected) {
      problems.push(`help.${lang}.md 文件头计数声明为 ${n}，与 schema 实数 ${expected} 不一致`);
    }
  }
  return problems;
}

const defs = toolDefsFrom(apply);
const defByName = new Map(defs.map((d) => [d.name, d]));
const help = {
  zh: { text: readFileSync(SOURCE_HELP.zh, "utf8"), entries: parseHelp(readFileSync(SOURCE_HELP.zh, "utf8")) },
  en: { text: readFileSync(SOURCE_HELP.en, "utf8"), entries: parseHelp(readFileSync(SOURCE_HELP.en, "utf8")) },
};

test("A1 schema 恰为 44 个 graph_* 工具，且名字唯一", () => {
  assert.equal(defs.length, 44, `引擎注册的 graph_* 工具数应为 44，实际 ${defs.length}`);
  assert.equal(new Set(defs.map((d) => d.name)).size, 44, "引擎工具名存在重复");
});

test("A2 zh/en 帮助条目与 schema 工具集合逐一相等（不缺/不多/不重复），且 zh/en 结构对称", () => {
  for (const lang of ["zh", "en"] as const) {
    assert.deepEqual(structureProblems(help[lang].entries, defs, lang), [], `help.${lang}.md 结构面不一致`);
    // 原判别力显式保留：条目数、唯一性、集合相等
    const names = help[lang].entries.map((e) => e.name);
    assert.equal(names.length, 44, `help.${lang}.md 条目数应为 44，实际 ${names.length}`);
    assert.equal(new Set(names).size, names.length, `help.${lang}.md 存在重复条目`);
    assert.deepEqual([...names].sort(), [...defs.map((d) => d.name)].sort(), `help.${lang}.md 与 schema 工具集合不一致`);
  }
  // zh/en 对称：条目顺序与章节数一致（两份资产的投影结构必须逐条对应）
  assert.deepEqual(
    help.zh.entries.map((e) => e.name),
    help.en.entries.map((e) => e.name),
    "help.zh.md 与 help.en.md 的工具条目顺序不一致（zh/en 非对称）",
  );
  const headings = (t: string) => t.split("\n").filter((l) => l.startsWith("## ")).length;
  assert.equal(headings(help.zh.text), headings(help.en.text), "help.zh.md 与 help.en.md 的章节数不一致");
});

test("A3 文件头声明的工具计数与 schema 实数一致（与中英文措辞解耦）", () => {
  for (const lang of ["zh", "en"] as const) {
    assert.deepEqual(countProblems(help[lang].text, lang, defs.length), [], `help.${lang}.md 计数声明与 schema 实数不一致`);
  }
  // 反恒真：确认确实解析到「计数声明」（而非「文件头任意数字存在」这种更弱的条件——
  // 那正是 R2 的误红面来源：版本号等无关数字会让它恒真）。
  assert.ok(countDeclarations(help.zh.text).length > 0, "help.zh.md 文件头未解析到工具计数声明");
  assert.ok(countDeclarations(help.en.text).length > 0, "help.en.md 文件头未解析到工具计数声明");
});

test("B 每个工具的签名行覆盖全部参数名（zh/en），且必填/可选性与 schema 一致", () => {
  const problems = [
    ...signatureProblems(help.zh.entries, defByName, "zh"),
    ...signatureProblems(help.en.entries, defByName, "en"),
  ];
  assert.deepEqual(problems, [], `帮助资产与引擎 schema 不一致：\n${problems.join("\n")}`);
});

test("C 关键参数钉在对应工具行的同一逻辑行（含签名内）", () => {
  const entryOf = (lang: "zh" | "en", name: string) => help[lang].entries.find((e) => e.name === name)!;
  for (const lang of ["zh", "en"] as const) {
    const resolve = entryOf(lang, "graph_resolve_accept").line;
    assert.match(resolve, /\bfast_track\b/, `help.${lang}.md graph_resolve_accept 行缺 fast_track`);
    assert.match(resolve, /\bmachine_report\b/, `help.${lang}.md graph_resolve_accept 行缺 machine_report`);
    const unbind = entryOf(lang, "graph_unbind_goal_child").line;
    assert.match(unbind, /\blegacy\b/, `help.${lang}.md graph_unbind_goal_child 行缺 legacy`);
    // 加固：这三个参数必须落在**签名括号内**（散文提及不算；B 已要求签名覆盖，这里再钉住其归属工具）
    assert.match(signatureOf(resolve), /\bfast_track\b/, `help.${lang}.md graph_resolve_accept 签名缺 fast_track`);
    assert.match(signatureOf(resolve), /\bmachine_report\b/, `help.${lang}.md graph_resolve_accept 签名缺 machine_report`);
    assert.match(signatureOf(unbind), /\blegacy\b/, `help.${lang}.md graph_unbind_goal_child 签名缺 legacy`);
  }
});

test("D graph_help run() 返回源资产原文，且 dist 副本与源逐字一致", () => {
  for (const lang of ["zh", "en"] as const) {
    assert.equal(
      readFileSync(DIST_HELP[lang], "utf8"),
      help[lang].text,
      `dist/prompts/help.${lang}.md 与源不一致：请先 bash scripts/build.sh`,
    );
  }
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g347-run-"));
  const { ctx, registered } = mockContext(root);
  apply(ctx, { root });
  const helpDef = registered.find((d) => d.name === "graph_help");
  assert.ok(helpDef, "graph_help 未注册");
  assert.equal(helpDef.execute().help, help.zh.text, "graph_help execute() 返回值与源资产 help.zh.md 不一致");
});

/**
 * 让 tmp 镜像里的 `dist/core/*.js` 仍能解析 `yaml` 等依赖：把镜像根下的 node_modules
 * 符号链接到仓库（或任一上层目录）的 node_modules。R3：镜像不再需要落在仓库内，
 * 因此只读检出（无仓库内可写 tmp/）也能跑测试 E。
 * @returns 是否成功建立链接（未找到 node_modules 时返回 false，调用方给出可读诊断）
 */
function linkDependencies(mirrorRoot: string): boolean {
  for (let dir = repoRoot; ; ) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate)) {
      symlinkSync(candidate, join(mirrorRoot, "node_modules"), "dir");
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

test("E 加载机制：资产为每次调用读取，改动后同一模块实例立即生效（无需重启宿主）", async () => {
  // R3：镜像落在 os.tmpdir()，**不**依赖仓库内可写的 tmp/ ⇒ 只读检出也能跑；
  // 镜像里的 dist/core/ops.js 需要解析 `yaml`，故把镜像根 node_modules 链接到仓库的 node_modules。
  const mirrorRoot = mkdtempSync(join(tmpdir(), "dsh-graph-g347-mirror-"));
  try {
    assert.ok(
      !mirrorRoot.startsWith(repoRoot + "/"),
      `镜像不得落在仓库内（只读检出会因不可写而失败）: ${mirrorRoot}`,
    );
    assert.ok(linkDependencies(mirrorRoot), "未找到仓库 node_modules，tmp 镜像无法解析 yaml 依赖");
    const mirrorDist = join(mirrorRoot, "dist");
    cpSync(join(repoRoot, "dist"), mirrorDist, { recursive: true });
    const mirrorHelp = join(mirrorDist, "prompts", "help.zh.md");
    const original = readFileSync(mirrorHelp, "utf8");

    const mod = await import(`${pathToFileURL(join(mirrorDist, "index.js")).href}?g347=${Date.now()}`);
    const root = mkdtempSync(join(tmpdir(), "dsh-graph-g347-mirror-root-"));
    const { ctx, registered } = mockContext(root);
    mod.apply(ctx, { root });
    const helpDef = registered.find((d: any) => d.name === "graph_help");
    assert.ok(helpDef, "镜像实例未注册 graph_help");

    writeFileSync(mirrorHelp, `<!-- SENTINEL-ONE -->\n${original}`);
    assert.match(helpDef.execute().help, /SENTINEL-ONE/, "首次改动未被 graph_help 读取（疑似启动缓存）");
    writeFileSync(mirrorHelp, `<!-- SENTINEL-TWO -->\n${original}`);
    assert.match(helpDef.execute().help, /SENTINEL-TWO/, "同实例二次改动未被读取 ⇒ 资产非每次调用读取");
    assert.doesNotMatch(helpDef.execute().help, /SENTINEL-ONE/, "旧内容仍在 ⇒ 存在缓存");
    // 反向判别力（R3 验收「删除资产仍能被检出」）：删除镜像资产后立即报「资产缺失/不可读」，
    // 既不沿用上一次内容，也不静默降级为空帮助 ⇒ 判别力不因换掉仓库内 tmp 而下降。
    rmSync(mirrorHelp);
    assert.ok(!existsSync(mirrorHelp), "镜像资产未被删除（测试前置失败）");
    assert.throws(
      () => helpDef.execute(),
      /prompt asset missing or unreadable: help\.zh\.md/,
      "help.zh.md 被删除后未报错 ⇒ 资产删除不可检出（疑似缓存或静默降级）",
    );
  } finally {
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
});

test("F 负向对照：判定函数对合成样本「改坏即红 / 合法改写不误红」", () => {
  // 合成样本自带 def ⇒ F 的锚点**不受真实资产措辞/折行变化影响**：
  // 真实资产的逐条对齐由 A2/A3/B/C 负责，真实资产上的折行与改写实测记录见 g-349 交付说明。
  // 这样 F 才能在长期回归中既证明判别力，又不会因为未来合法的文案/折行编辑而误红。
  const FIXTURE_DEFS: ToolDef[] = [
    { name: "graph_alpha", params: ["goal", "note", "state"], required: ["goal", "note"] },
    { name: "graph_beta", params: ["goal", "attempt", "child_id", "token"], required: ["goal"] },
    // 与真实 graph_memory_replace 同形（3 个可选参数）：R1 最小复现的合成副本，可长期回归。
    { name: "graph_delta", params: ["old", "text", "kind", "importance", "source_goal"], required: ["old", "text"] },
  ];
  const fixtureByName = new Map(FIXTURE_DEFS.map((d) => [d.name, d]));
  // 合成白名单：F 的锚点不依赖真实资产（graph_beta 是合成样本里唯一具 XOR 语义的工具）。
  const FIXTURE_UNION_WHITELIST: Record<string, string[][]> = { graph_beta: [["attempt", "child_id"]] };
  const ZH_FIXTURE = [
    "dsh-graph 插件。可用 graph_* 工具（共 3 个）：",
    "",
    "## 分组",
    "- graph_alpha(goal, note[, state]) 甲；",
    "- graph_beta(goal, {attempt|child_id}[, token]) 乙；",
    "- graph_delta(old, text[, kind][, importance][, source_goal]) 丙。",
    "",
  ].join("\n");
  const EN_FIXTURE = [
    "dsh-graph plugin. Available graph_* tools (3 total):",
    "",
    "## Group",
    "- graph_alpha(goal, note[, state]) alpha;",
    "- graph_beta(goal, {attempt|child_id}[, token]) beta;",
    "- graph_delta(old, text[, kind][, importance][, source_goal]) delta.",
    "",
  ].join("\n");

  const audit = (text: string, lang: "zh" | "en") =>
    [
      ...structureProblems(parseHelp(text), FIXTURE_DEFS, lang),
      ...signatureProblems(parseHelp(text), fixtureByName, lang, FIXTURE_UNION_WHITELIST),
      ...countProblems(text, lang, FIXTURE_DEFS.length),
    ].join("\n");
  const expectGreen = (text: string, lang: "zh" | "en", why: string) =>
    assert.equal(audit(text, lang), "", `${why} 被误红:\n${audit(text, lang)}`);
  const expectRed = (text: string, lang: "zh" | "en", re: RegExp, why: string) =>
    assert.match(audit(text, lang), re, `${why} 未变红`);
  const edit = (text: string, from: string, to: string) => {
    assert.ok(text.includes(from), `合成样本锚点缺失: ${JSON.stringify(from)}`);
    return text.replace(from, to);
  };

  // ── 基线 + 两类「合法变更不误红」──
  expectGreen(ZH_FIXTURE, "zh", "合成中文样本基线");
  expectGreen(EN_FIXTURE, "en", "合成英文样本基线");
  // 折行：签名括号未闭合的物理行 + 缩进续行（Markdown 合法）
  expectGreen(edit(EN_FIXTURE, "note[, state])", "note\n  [, state])"), "en", "签名按合法方式折行");
  expectGreen(edit(ZH_FIXTURE, "note[, state])", "note\n  [, state])"), "zh", "签名按合法方式折行");
  // 计数措辞解耦：换措辞但数字正确
  expectGreen(edit(EN_FIXTURE, "(3 total)", "(3 tools available)"), "en", "英文计数合法改写");
  expectGreen(edit(ZH_FIXTURE, "共 3 个", "3 个工具可调用"), "zh", "中文计数合法改写");
  // R2：头部出现与计数无关的数字（版本号）不得误红
  expectGreen(edit(EN_FIXTURE, "dsh-graph plugin.", "dsh-graph v0.16.0 plugin."), "en", "英文头部含版本号 v0.16.0");
  expectGreen(edit(ZH_FIXTURE, "dsh-graph 插件。", "dsh-graph v0.16.0 插件。"), "zh", "中文头部含版本号 v0.16.0");
  // R2：同一行同时含版本号与正确计数（复核者 S16 最小复现的合成副本）
  expectGreen(
    edit(
      EN_FIXTURE,
      "dsh-graph plugin. Available graph_* tools (3 total):",
      "dsh-graph v0.16.0 is a plugin. Available graph_* tools (3 total):",
    ),
    "en",
    "S16 最小复现同形：首行 dsh-graph v0.16.0 … (3 total)",
  );

  // ── ① 可选写成必填（少写方括号）：点名工具 + 参数 ──
  expectRed(edit(EN_FIXTURE, "note[, state])", "note, state)"), "en", /graph_alpha.*可选参数被写成必填.*state/s, "可选写成必填");
  // ── ② 必填写成可选（多写方括号）：点名工具 + 参数 ──
  expectRed(edit(ZH_FIXTURE, "graph_alpha(goal, note[, state])", "graph_alpha(goal[, note][, state])"), "zh", /graph_alpha.*必填参数被写成可选.*note/s, "必填写成可选");
  // ── ③ 单成员 one-of 组不能成为绕过方括号的通道 ──
  expectRed(edit(EN_FIXTURE, "note[, state])", "note[, {state}])"), "en", /graph_alpha.*one-of 组至少需 2 个成员/s, "单成员 one-of 组");
  // ── ④ 真漏参仍必红（g-347 原判别力）──
  expectRed(edit(EN_FIXTURE, "[, token]", ""), "en", /graph_beta.*签名缺参数.*token/s, "漏参（token）");
  expectRed(edit(ZH_FIXTURE, "graph_alpha(goal, note[, state])", "graph_alpha(goal)"), "zh", /graph_alpha.*签名缺参数.*(note|state)/s, "签名退回 (goal)");
  // ── ⑤ 多参 / 重复参数仍必红 ──
  expectRed(edit(EN_FIXTURE, "[, token]", "[, token][, bogus]"), "en", /graph_beta.*schema 外 token.*bogus/s, "多参（bogus）");
  expectRed(edit(ZH_FIXTURE, "goal, note[, state]", "goal, note, note[, state]"), "zh", /graph_alpha.*签名参数重复.*note/s, "重复参数");
  // ── ⑥ 整条条目被删 ⇒ 结构必红（g-347 原判别力）──
  const dropped = EN_FIXTURE.replace(/- graph_beta\([^\n]*\n/, "");
  expectRed(dropped, "en", /graph_beta/, "整条条目被删");
  assert.equal(parseHelp(dropped).length, 2, "删条目后条目数应为 2");
  // ── ⑦ 真截断（括号未闭合）⇒ 专属报错 ──
  expectRed(edit(EN_FIXTURE, "note[, state]) alpha;", "note[, state] alpha;"), "en", /graph_alpha.*签名括号未闭合/s, "括号未闭合专属报错");
  // ── ⑧ 计数：字面数字改错必红（中/英）──
  expectRed(edit(EN_FIXTURE, "(3 total)", "(4 total)"), "en", /计数声明为 4.*实数 3/s, "英文计数改错");
  expectRed(edit(ZH_FIXTURE, "共 3 个", "共 4 个"), "zh", /计数声明为 4.*实数 3/s, "中文计数改错");
  // ── ⑨ R2 反恒真：版本号不算计数声明 ⇒ 只剩版本号时仍必红（剔版本不得变成「恒绿」）──
  expectRed(
    edit(edit(EN_FIXTURE, "dsh-graph plugin.", "dsh-graph v0.16.0 plugin."), " (3 total)", ""),
    "en",
    /缺少工具计数声明/,
    "头部只剩版本号、无计数声明",
  );
  expectRed(edit(ZH_FIXTURE, "（共 3 个）", ""), "zh", /缺少工具计数声明/, "中文头部删除计数声明");

  // ── ⑩ R1 union 白名单：白名单外「多个可选参数压成一个 union」必红（最小复现同形）──
  const fakeXor = edit(ZH_FIXTURE, "text[, kind][, importance][, source_goal]", "text, {kind|importance|source_goal}");
  expectRed(
    fakeXor,
    "zh",
    /graph_delta.*one-of 组 \{kind\|importance\|source_goal\} 不在白名单/s,
    "假 XOR（graph_memory_replace 同形：可选项压缩成 union）",
  );
  assert.equal(
    audit(fakeXor, "zh").split("\n").length,
    1,
    "假 XOR 应只触发「不在白名单」一条问题（否则说明另有误判或漏判）",
  );
  // 白名单内同形 union 仍绿（成员顺序无关）
  expectGreen(edit(EN_FIXTURE, "{attempt|child_id}", "{child_id|attempt}"), "en", "白名单内 XOR 成员顺序颠倒");
  // 同一工具的白名单外组合（真 XOR 之外的压缩）必红
  expectRed(
    edit(EN_FIXTURE, "{attempt|child_id}", "{attempt|token}"),
    "en",
    /graph_beta.*one-of 组 \{attempt\|token\} 不在白名单/s,
    "白名单外组合 {attempt|token}",
  );
  // 假 XOR 写在方括号内（`[, {a|b|c}]`）同样命中白名单检查，不得成为第二条逃逸路径
  expectRed(
    edit(ZH_FIXTURE, "text[, kind][, importance][, source_goal]", "text[, {kind|importance|source_goal}]"),
    "zh",
    /graph_delta.*one-of 组 \{kind\|importance\|source_goal\} 不在白名单/s,
    "方括号内嵌假 XOR",
  );
});
