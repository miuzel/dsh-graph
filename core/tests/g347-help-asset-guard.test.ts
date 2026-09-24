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
 * 结构性例外（唯一）：`graph_unbind_goal_child` 的 `{attempt|child_id}` 是「二者恰取其一」的
 * one-of 记号（schema 中两者均为可选，运行时由引擎校验恰好其一）。解析器为其单列 union 桶：
 * 组内成员只能是 schema 可选参数，且组至少 2 个成员——因此不能用 `{state}` 之类单成员组绕过方括号断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** 参数面 + 可选性面：B 用，F 复用。失败信息一律包含「文件名:行号 工具名」+ 具体参数名。 */
function signatureProblems(entries: HelpEntry[], defByName: Map<string, ToolDef>, lang: string): string[] {
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

    // ── one-of 组约束：防止用 {x} 单成员组绕过方括号断言 ──
    for (const group of shape.unions) {
      if (group.length < 2) {
        problems.push(`${at} one-of 组至少需 2 个成员（不可用于绕过方括号）: {${group.join("|")}}`);
      }
    }
  }
  return problems;
}

/** 文件头（第一个 `## ` 之前）声明的数字：与措辞解耦，只要求「出现的数字 == schema 实数」。 */
function headerNumbers(text: string): number[] {
  const lines = text.split("\n");
  const end = lines.findIndex((l) => l.startsWith("## "));
  const header = (end < 0 ? lines : lines.slice(0, end)).join("\n");
  return [...new Set((header.match(/\d+/g) ?? []).map(Number))];
}

function countProblems(text: string, lang: string, expected: number): string[] {
  const nums = headerNumbers(text);
  const problems: string[] = [];
  if (nums.length === 0) {
    problems.push(`help.${lang}.md 文件头缺少工具计数声明（未出现任何数字）`);
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
  // 反恒真：确认确实取到了声明数字（避免「一个数字都没有 ⇒ 空断言恒绿」）
  assert.ok(headerNumbers(help.zh.text).length > 0, "help.zh.md 文件头未解析到声明数字");
  assert.ok(headerNumbers(help.en.text).length > 0, "help.en.md 文件头未解析到声明数字");
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

test("E 加载机制：资产为每次调用读取，改动后同一模块实例立即生效（无需重启宿主）", async () => {
  // 镜像必须落在仓库内，否则 dist/core/*.js 无法向上解析 yaml 依赖；tmp/ 已被 .gitignore 忽略。
  const tmpBase = join(repoRoot, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const mirrorRoot = mkdtempSync(join(tmpBase, "g347-mirror-"));
  try {
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
  ];
  const fixtureByName = new Map(FIXTURE_DEFS.map((d) => [d.name, d]));
  const ZH_FIXTURE = [
    "dsh-graph 插件。可用 graph_* 工具（共 2 个）：",
    "",
    "## 分组",
    "- graph_alpha(goal, note[, state]) 甲；",
    "- graph_beta(goal, {attempt|child_id}[, token]) 乙。",
    "",
  ].join("\n");
  const EN_FIXTURE = [
    "dsh-graph plugin. Available graph_* tools (2 total):",
    "",
    "## Group",
    "- graph_alpha(goal, note[, state]) alpha;",
    "- graph_beta(goal, {attempt|child_id}[, token]) beta.",
    "",
  ].join("\n");

  const audit = (text: string, lang: "zh" | "en") =>
    [
      ...structureProblems(parseHelp(text), FIXTURE_DEFS, lang),
      ...signatureProblems(parseHelp(text), fixtureByName, lang),
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
  expectGreen(edit(EN_FIXTURE, "(2 total)", "(2 tools available)"), "en", "英文计数合法改写");
  expectGreen(edit(ZH_FIXTURE, "共 2 个", "2 个工具可调用"), "zh", "中文计数合法改写");

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
  assert.equal(parseHelp(dropped).length, 1, "删条目后条目数应为 1");
  // ── ⑦ 真截断（括号未闭合）⇒ 专属报错 ──
  expectRed(edit(EN_FIXTURE, "note[, state]) alpha;", "note[, state] alpha;"), "en", /graph_alpha.*签名括号未闭合/s, "括号未闭合专属报错");
  // ── ⑧ 计数：字面数字改错必红（中/英）──
  expectRed(edit(EN_FIXTURE, "(2 total)", "(3 total)"), "en", /计数声明为 3.*实数 2/s, "英文计数改错");
  expectRed(edit(ZH_FIXTURE, "共 2 个", "共 3 个"), "zh", /计数声明为 3.*实数 2/s, "中文计数改错");
});
