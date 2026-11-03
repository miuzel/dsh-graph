/**
 * g-347 守护（g-349 收敛版）：`graph_help` 帮助资产（`prompts/help.{zh,en}.md`）
 * 必须与引擎 tool schema 对齐。
 *
 * 为什么需要：`graph_help` 是主管会话的**首要工具速查**，而该资产此前**零测试覆盖**。
 * 引擎在 g-311（fast_track/machine_report）、g-329 等目标里加了参数，帮助文本没跟，
 * 主管据此误判「没有机器快速放行通道」——属「文档落后于引擎」的静默失效。
 * 本套件把「帮助资产 = 引擎 schema 的投影」变成机器断言：引擎加参数/加工具而帮助没跟 → 必红。
 *
 * 断言面（真源固定为 `apply()` 实际注册的 tool def，不硬编码 49 名单）：
 *  A. 工具集合：schema 53 个 graph_* 工具（g-436 新增 graph_start_review）与 zh/en 两份帮助的条目**逐一相等**（不缺、不多、不重复），
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
 *     g-363 补：`os.tmpdir()` 本身可能被设为仓库内 `tmp/`（AGENTS.md 临时文件纪律），
 *     故镜像根改由 `outOfRepoTempBase()` 显式挑一个仓库外的临时根 —— R3 前提按构造成立，
 *     「镜像不得落在仓库内」断言一字未改。
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
import { cpSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { apply } from "../../dist/index.js";
import { init, unbindGoalChild, HARNESS_MODULE_IDS } from "../ops.ts";
import { ownerConnectionStub } from "./_http-auth-harness.ts";

const repoRoot = join(import.meta.dirname, "../..");

/**
 * g-363：选一个**确定位于仓库之外**的临时根。
 *
 * 为什么需要：R3（见测试 E）要求镜像落在仓库外，只读检出也能跑；而 `os.tmpdir()` 可能被设为
 * 仓库内 `tmp/`（AGENTS.md 要求临时文件写仓库 `tmp/`）⇒ 该 R3 前提从「碰巧成立」变成「不成立」。
 * 这里显式把一个仓库外、可写的临时根挑出来，让前提**按构造成立**；测试 E 原有的
 * 「镜像不得落在仓库内」断言一字未改（判别力不降：若把本函数改回 `tmpdir()`，断言立刻变红）。
 */
function outOfRepoTempBase(): string {
  const repoPrefix = `${resolve(repoRoot)}/`;
  const candidates = [process.env.DSH_G347_OUTSIDE_TMP, "/tmp", process.env.TEMP, process.env.TMP, tmpdir()];
  for (const raw of candidates) {
    if (!raw) continue;
    const base = resolve(raw);
    if (`${base}/`.startsWith(repoPrefix)) continue; // 仓库内 → 不满足 R3 前提
    try {
      const probe = mkdtempSync(join(base, "dsh-graph-g347-probe-"));
      rmSync(probe, { recursive: true, force: true });
      return base;
    } catch {
      // 不可写 → 试下一个候选
    }
  }
  return tmpdir();
}
const SOURCE_HELP = {
  zh: join(repoRoot, "prompts", "help.zh.md"),
  en: join(repoRoot, "prompts", "help.en.md"),
};
const DIST_HELP = {
  zh: join(repoRoot, "dist", "prompts", "help.zh.md"),
  en: join(repoRoot, "dist", "prompts", "help.en.md"),
};
/** g-495：按需面（agent 需要细则时读的那一面；`help(topic="usage")` + skill dsh-graph 正文）。 */
const SOURCE_USAGE = {
  zh: join(repoRoot, "prompts", "usage.zh.md"),
  en: join(repoRoot, "prompts", "usage.en.md"),
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
      name === "sandboxPolicy" ? { workspaceRoot: root } : name === "webServer" ? webServer : name === "connection" ? ownerConnectionStub() : undefined,
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

/**
 * ── g-495 改判（负责人授权）：help 资产的可判定面从「53 条工具清单」换成「功能模块表」 ──
 *
 * help.zh/en 现在是 **agent 面的渐进式披露**：只列功能模块 + 当前开关状态，工具细节以
 * harness 注入的 schema 为准。原 A2（条目集合 == schema 工具集合）与 A3（条目数 == schema 实数）
 * 的**真源**随之从「工具」改为「模块」：
 *   A2' 模块表的 `{moduleId}` 占位集合 == 引擎模块注册表 `HARNESS_MODULE_IDS`（不缺/不多/不重复/zh-en 对称）
 *   A3' 文件头声明的模块数 == `HARNESS_MODULE_IDS.length`（仍与中英文措辞解耦）
 * 判别力**不降**：占位被删/拼错/多写 ⇒ 集合不等必红；模块数写错或声明被删 ⇒ 必红（负向对照见下）。
 */

/** 从 markdown 表格里抽取模块行：`| 标签 | … | {tags} |` ⇒ `{rowName, moduleId}`。 */
function parseModuleTable(text: string): Array<{ rowName: string; moduleId: string }> {
  const out: Array<{ rowName: string; moduleId: string }> = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|[^|]*\|\s*\{([a-z_]+)\}\s*\|\s*$/);
    if (m) out.push({ rowName: m[1], moduleId: m[2] });
  }
  return out;
}

function moduleTableProblems(text: string, lang: string): string[] {
  const problems: string[] = [];
  const rows = parseModuleTable(text);
  const ids = rows.map((r) => r.moduleId);
  const expected = [...HARNESS_MODULE_IDS];
  if (ids.length !== expected.length) {
    problems.push(`help.${lang}.md 模块表行数 ${ids.length} 与引擎模块注册表 ${expected.length} 不一致`);
  }
  const dupes = [...new Set(ids.filter((n, i) => ids.indexOf(n) !== i))];
  if (dupes.length) problems.push(`help.${lang}.md 模块表存在重复模块: ${dupes.join(", ")}`);
  const missing = expected.filter((n) => !ids.includes(n));
  if (missing.length) problems.push(`help.${lang}.md 缺少模块行: ${missing.join(", ")}`);
  const extra = ids.filter((n) => !expected.includes(n));
  if (extra.length) problems.push(`help.${lang}.md 含注册表外模块: ${extra.join(", ")}`);
  return problems;
}

/** 模块数声明（与措辞解耦）：`共 5 个功能模块` / `5 feature modules`。 */
const MODULE_COUNT_PATTERNS = [/(\d+)\s*个功能模块/g, /(\d+)\s+feature modules/g];

function moduleCountProblems(text: string, lang: string): string[] {
  const problems: string[] = [];
  const expected = HARNESS_MODULE_IDS.length;
  let hits = 0;
  for (const re of MODULE_COUNT_PATTERNS) {
    for (const m of text.matchAll(re)) {
      hits++;
      if (Number(m[1]) !== expected) {
        problems.push(`help.${lang}.md 模块计数声明为 ${m[1]}，应为 ${expected}`);
      }
    }
  }
  if (hits === 0) problems.push(`help.${lang}.md 未解析到模块计数声明（声明被删/措辞已变，守卫不得退化为恒真）`);
  return problems;
}

const help = {
  zh: { text: readFileSync(SOURCE_HELP.zh, "utf8"), entries: parseHelp(readFileSync(SOURCE_HELP.zh, "utf8")) },
  en: { text: readFileSync(SOURCE_HELP.en, "utf8"), entries: parseHelp(readFileSync(SOURCE_HELP.en, "utf8")) },
};

const USAGE = {
  zh: { text: readFileSync(SOURCE_USAGE.zh, "utf8") },
  en: { text: readFileSync(SOURCE_USAGE.en, "utf8") },
};

/**
 * 从按需面 usage 抽取工具签名条目。usage 的清单行有两种形态：
 *   `- graph_x(a[, b]) 说明；`            （单工具一行）
 *   `- graph_a(p) …；graph_b(p) …`        （同一行用 `；`/`;` 分隔多工具）
 * 逐行扫描所有 `graph_xxx(...)` 出现点，取 `(` 到配对 `)` 的签名。
 */
function parseUsageEntries(text: string): HelpEntry[] {
  const out: HelpEntry[] = [];
  text.split("\n").forEach((line, i) => {
    const re = /\b(graph_[a-z0-9_]+)\s*\(/g;
    for (const m of line.matchAll(re)) {
      const start = (m.index ?? 0) + m[0].length - 1; // 指向 `(`
      let depth = 0;
      let end = -1;
      for (let k = start; k < line.length; k++) {
        if (line[k] === "(") depth++;
        else if (line[k] === ")") { depth--; if (depth === 0) { end = k; break; } }
      }
      if (end < 0) continue; // 括号不闭合 ⇒ 交给 usageSignatureProblems 的 isBalanced 分支报红
      out.push({ name: m[1], line: line.slice(m.index ?? 0, end + 1), lineNo: i + 1 });
    }
  });
  return out;
}

/**
 * usage 签名 vs schema：复用与 help 期**同一套**判定核心（铁律：不留弱化副本）。
 *
 * usage 是**代表性速查面**（agent 需要细则时才读），不是 schema 的逐字镜像：
 * 它按教学需要挑选参数、用 `goal | goals[]` 这类自然记法。因此这里只保留**健全性（soundness）**
 * 判定 —— 凡 usage 写出来的东西必须是对的；**完整性（completeness）**判定归 harness 注入的 schema 本身。
 *
 * 保留（健全性，g-311/g-329 的真正判别力）：
 *   ① 不得出现 schema 外 token（`签名含 schema 外 token`）—— 文档写了引擎不存在的参数必红；
 *   ② 必填参数不得被写成可选（`必填参数被写成可选`）—— 少写方括号会让 agent 漏传必填参数；
 *   ③ union 组必须是白名单里的真 XOR（`one-of 组 … 不在白名单`）；
 *   ④ 签名括号必须闭合（`签名括号未闭合`）。
 * 豁免（usage 体例，非缺陷）：缺可选参数、可选参数没加方括号、`a | b` 选择记法。
 */
function usageSignatureProblems(
  text: string,
  defByName: Map<string, ToolDef>,
  lang: string,
  unionWhitelist: Record<string, string[][]> = UNION_WHITELIST,
): string[] {
  // 用「已闭合」的条目送入判定核心；`goal | goals[]` / `content=…` 这类速查记法先归一成裸参数名，
  // 以免把体例差异误判成 foreign token（归一后仍会被 ①②③④ 逐条校验）。
  const entries = parseUsageEntries(text).map((e) => ({ ...e, line: normalizeUsageSignature(e.line) }));
  return signatureProblems(entries, defByName, lang, unionWhitelist).filter(
    (p) =>
      !/签名缺参数/.test(p) && // usage 体例：允许只列必填（完整性由 schema 注入承担）
      !/可选参数未加方括号/.test(p) && // usage 体例：可选参数不必写方括号
      !/可选参数被写成必填/.test(p), // 同上（速查面不区分方括号）
  );
}

/** 把 usage 的速查记法归一成判定核心认识的形态：`goal | goals[]` → `goal`；`content=…` → `content`。 */
function normalizeUsageSignature(line: string): string {
  return line
    .replace(/([A-Za-z_][\w]*)\s*=\s*(?:…|\.\.\.|[^,)\s]+)/g, "$1") // `content=…` / `llm:true` 形式的赋值记法
    .replace(/\s*[|]\s*[A-Za-z_][\w]*(?:\[\])?/g, "") // `goal | goals[]` 选择记法
    .replace(/([A-Za-z_][\w]*)(?:\[\])?(?:…|\.\.\.)/g, "$1"); // `x…` 去省略号（`criteria[]` 不受影响）
}

/** usage 的「工具细则」段（`## Tool details` / `## 工具细则` 之后）。 */
function toolDetailSection(text: string): string {
  const m = text.match(/^##\s+(?:Tool details|工具细则).*$/m);
  if (!m || m.index === undefined) return "";
  return text.slice(m.index);
}

/** 某工具在细则段里的窗口：从该工具名首次出现到下一个 `**graph_` 段落标题或段尾。 */
function toolDetailWindow(text: string, tool: string): string {
  const section = toolDetailSection(text);
  const start = section.indexOf(tool);
  if (start < 0) return "";
  const rest = section.slice(start);
  const next = rest.slice(tool.length).search(/\n\*\*graph_/);
  return next < 0 ? rest : rest.slice(0, tool.length + next);
}

test("A1 schema 恰为 53 个 graph_* 工具，且名字唯一", () => {
  assert.equal(defs.length, 53, `引擎注册的 graph_* 工具数应为 53（g-436 新增 graph_start_review），实际 ${defs.length}`);
  assert.equal(new Set(defs.map((d) => d.name)).size, 53, "引擎工具名存在重复");
});

test("A2' zh/en 帮助模块表与引擎模块注册表逐一相等（不缺/不多/不重复），且 zh/en 结构对称", () => {
  for (const lang of ["zh", "en"] as const) {
    assert.deepEqual(moduleTableProblems(help[lang].text, lang), [], `help.${lang}.md 模块表面不一致`);
    // 原判别力显式保留（换成模块口径）：行数、唯一性、集合相等
    const ids = parseModuleTable(help[lang].text).map((r) => r.moduleId);
    assert.equal(ids.length, HARNESS_MODULE_IDS.length, `help.${lang}.md 模块行数应为 ${HARNESS_MODULE_IDS.length}，实际 ${ids.length}`);
    assert.equal(new Set(ids).size, ids.length, `help.${lang}.md 存在重复模块行`);
    assert.deepEqual([...ids].sort(), [...HARNESS_MODULE_IDS].sort(), `help.${lang}.md 与引擎模块注册表不一致`);
  }
  // zh/en 对称：模块行顺序一致（两份资产的投影结构必须逐条对应）
  assert.deepEqual(
    parseModuleTable(help.zh.text).map((r) => r.moduleId),
    parseModuleTable(help.en.text).map((r) => r.moduleId),
    "help.zh.md 与 help.en.md 的模块行顺序不一致（zh/en 非对称）",
  );
  const headings = (t: string) => t.split("\n").filter((l) => l.startsWith("## ")).length;
  assert.equal(headings(help.zh.text), headings(help.en.text), "help.zh.md 与 help.en.md 的章节数不一致");
});

test("A3' 文件头声明的模块计数与引擎模块注册表一致（与中英文措辞解耦）", () => {
  for (const lang of ["zh", "en"] as const) {
    assert.deepEqual(moduleCountProblems(help[lang].text, lang), [], `help.${lang}.md 模块计数声明与注册表不一致`);
  }
  // 反恒真：确认确实解析到「计数声明」（而非「文件头任意数字存在」这种更弱的条件）。
  for (const lang of ["zh", "en"] as const) {
    assert.ok(
      MODULE_COUNT_PATTERNS.some((re) => re.test(help[lang].text)),
      `help.${lang}.md 未解析到模块计数声明`,
    );
  }
});

test("A2''/A3'' 负向对照：模块占位被改坏 / 模块数写错 / 声明被删，均必红", () => {
  const base = { zh: help.zh.text, en: help.en.text };
  // ① 模块占位拼错（`{memory}` → `{memry}`）⇒ 集合不等必红
  const typo = { ...base, zh: base.zh.replace("{memory}", "{memry}") };
  assert.notEqual(typo.zh, base.zh, "变异必须生效");
  assert.match(moduleTableProblems(typo.zh, "zh").join("\n"), /缺少模块行: memory/, "模块占位拼错未判红");
  assert.match(moduleTableProblems(typo.zh, "zh").join("\n"), /注册表外模块: memry/, "模块占位拼错未判红");
  // ② 整行删除 ⇒ 行数不等 + 缺模块，必红
  const dropped = { ...base, zh: base.zh.replace(/^\| 记忆 \|.*\{\{?memory\}?\}.*$/m, "") };
  assert.notEqual(dropped.zh, base.zh, "变异必须生效");
  assert.match(moduleTableProblems(dropped.zh, "zh").join("\n"), /模块表行数 4 与引擎模块注册表 5 不一致/, "删模块行未判红");
  // ③ 模块数写错（5 → 4）⇒ 必红
  const wrongNum = { ...base, zh: base.zh.replace("共 5 个功能模块", "共 4 个功能模块") };
  assert.notEqual(wrongNum.zh, base.zh, "变异必须生效");
  assert.match(moduleCountProblems(wrongNum.zh, "zh").join("\n"), /模块计数声明为 4，应为 5/, "模块数写错未判红");
  // ④ 计数声明整条删除 ⇒ 判「未解析到」必红（守卫不得退化为恒真）
  const noDecl = { ...base, zh: base.zh.replace(/共 \d+ 个功能模块/, "功能模块：") };
  assert.notEqual(noDecl.zh, base.zh, "变异必须生效");
  assert.match(moduleCountProblems(noDecl.zh, "zh").join("\n"), /未解析到模块计数声明/, "计数声明被删未判红");
  // hermetic：只改内存副本
  assert.equal(readFileSync(SOURCE_HELP.zh, "utf8"), base.zh, "负向对照污染了真实 help.zh.md");
});

test("B（g-495 改判后已由 B' 接管）help 无逐工具签名行时本判据对空集合为真，不得退化为静默跳过", () => {
  // help 现在**刻意不含**逐工具签名（工具细节以 harness 注入的 schema 为准）。
  // 保留 signatureProblems 的**合成样本**判别力由 F 负责；真实资产上的口径改由 B'（按需面 usage）承担。
  // 这里显式断言「help 确实没有签名条目」，使「help 又被加回 53 条清单」这种回退也能被看见。
  assert.equal(help.zh.entries.length, 0, "help.zh.md 不应再有逐工具条目（改判后为模块清单）");
  assert.equal(help.en.entries.length, 0, "help.en.md 不应再有逐工具条目（改判后为模块清单）");
  // 若将来误把清单加回，signatureProblems 会重新生效并逐条校验（fail-closed，不是放行）。
  const problems = [
    ...signatureProblems(help.zh.entries, defByName, "zh"),
    ...signatureProblems(help.en.entries, defByName, "en"),
  ];
  assert.deepEqual(problems, [], `帮助资产与引擎 schema 不一致：\n${problems.join("\n")}`);
});
test("B' 按需面（usage）里出现的每个工具签名都是 schema 的真投影（参数名/可选性/union 白名单）", () => {
  // g-495 改判（负责人授权）：help 不再逐条列工具签名 —— 其覆盖力**改判**到按需面 usage（它是
  // `help(topic="usage")` 与 skill dsh-graph 的正文，agent 需要细则时读的那一面）。口径不降：
  // ① usage 出现的每个签名都必须覆盖该工具 schema 的**全部**参数名（g-311/g-329 的原始判别力：
  //    引擎加了参数而文档没跟 ⇒ 必红）；② 必填/可选性必须与 schema.required 一致；
  // ③ union（`{a|b}`）只能用于真 XOR 白名单工具；④ 签名不得含 schema 外 token。
  // 与 help 期不同之处只在「覆盖面」：usage 是**代表性**速查面（不是 53 条全量清单），故只对
  // **它自己声明过的**工具判真，不要求它列全 53 个 —— 但列出来的每一条都必须逐字正确。
  const problems = [
    ...usageSignatureProblems(USAGE.zh.text, defByName, "zh"),
    ...usageSignatureProblems(USAGE.en.text, defByName, "en"),
  ];
  assert.deepEqual(problems, [], `按需面 usage 与引擎 schema 不一致：\n${problems.join("\n")}`);
  // 反恒真：usage 必须真的承载签名（否则本判据退化为空判）。
  assert.ok(parseUsageEntries(USAGE.zh.text).length > 0, "usage.zh.md 未解析到任何工具签名（判据退化）");
  assert.ok(parseUsageEntries(USAGE.en.text).length > 0, "usage.en.md 未解析到任何工具签名（判据退化）");
  // zh/en 覆盖同一工具集合（两份资产必须谈同一批工具）
  assert.deepEqual(
    parseUsageEntries(USAGE.zh.text).map((e) => e.name).sort(),
    parseUsageEntries(USAGE.en.text).map((e) => e.name).sort(),
    "usage.zh.md 与 usage.en.md 声明的工具集合不一致",
  );
});

test("C' 关键参数钉在对应工具的同一逻辑行（按需面 usage，含签名内）", () => {
  // g-495 改判：C 原钉在 help 的逐工具行上；help 已无逐工具行 ⇒ 载体改判到 usage 的
  // 「工具细则」段（那里现在承载 fast_track / machine_report / legacy 的操作口径）。
  for (const lang of ["zh", "en"] as const) {
    const text = USAGE[lang].text;
    // 这三个参数必须在同一段落里与它们的归属工具同时出现（归属正确性）。
    const section = toolDetailSection(text);
    assert.match(section, /graph_resolve_accept/, `usage.${lang}.md 细则段缺 graph_resolve_accept`);
    assert.match(section, /\bfast_track\b/, `usage.${lang}.md graph_resolve_accept 段缺 fast_track`);
    assert.match(section, /\bmachine_report\b/, `usage.${lang}.md graph_resolve_accept 段缺 machine_report`);
    assert.match(section, /graph_unbind_goal_child/, `usage.${lang}.md 细则段缺 graph_unbind_goal_child`);
    assert.match(section, /\blegacy\b/, `usage.${lang}.md graph_unbind_goal_child 段缺 legacy`);
    // 加固：归属必须**同段**（跨段算失败）—— 取该工具名到下一段落标题之间做窗口。
    assert.ok(
      toolDetailWindow(text, "graph_resolve_accept").includes("machine_report"),
      `usage.${lang}.md machine_report 未落在 graph_resolve_accept 的同一段落内`,
    );
    assert.ok(
      toolDetailWindow(text, "graph_unbind_goal_child").includes("legacy"),
      `usage.${lang}.md legacy 未落在 graph_unbind_goal_child 的同一段落内`,
    );
  }
});

test("D graph_help run() 渲染模块开关后返回，且 dist 副本与源逐字一致", () => {
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
  const rendered = helpDef.execute().help as string;
  // g-495（A）：help 的模块状态位从 `{moduleId}` 占位渲染为**当前生效值**；
  // 未配置 = 全部开启（fail-safe）。渲染后不得残留任何占位符。
  assert.doesNotMatch(rendered, /\{[a-z_]+\}/, "graph_help 返回文本残留未渲染的 {moduleId} 占位");
  assert.equal(
    rendered,
    help.zh.text.replace(/\{(tags|memory|shared_cards|automation_prompts|attachments)\}/g, "开启"),
    "graph_help execute() 渲染结果与「源资产 + 全开启」不一致",
  );
  // 除占位渲染外，其余正文必须与源资产**逐字一致**（章节/表格/散文都不可能被 run() 改写）。
  // 只在**模块表行**上做归一（散文里本就出现「开启」字样，全局 replace 会误伤）。
  const normalizeModuleRows = (t: string) =>
    t
      .split("\n")
      .map((l) => (/^\|\s*[^|]+\|[^|]*\|\s*(?:\{[a-z_]+\}|开启|关闭)\s*\|\s*$/.test(l) ? l.replace(/\|\s*(?:\{[a-z_]+\}|开启|关闭)\s*\|$/, "| {M} |") : l))
      .join("\n");
  assert.equal(
    normalizeModuleRows(rendered),
    normalizeModuleRows(help.zh.text),
    "graph_help execute() 除模块状态位外改动了源资产正文",
  );
  // 占位渲染是「数据投影」而非「文本替换」的负向对照：把源资产的一个占位改坏 ⇒ 渲染结果必变。
  const mutated = help.zh.text.replace("{memory}", "{memry}");
  assert.notEqual(
    mutated.replace(/\{(tags|memory|shared_cards|automation_prompts|attachments)\}/g, "开启"),
    rendered,
    "占位符改名后渲染结果未变 ⇒ 渲染判据未真正绑定占位符",
  );
});

/**
 * 让 tmp 镜像里的 `dist/core/*.js` 仍能解析 `yaml` 等依赖：把镜像根下的 node_modules
 * 符号链接到仓库（或任一上层目录）的 node_modules。R3：镜像不再需要落在仓库内，
 * 因此只读检出（无仓库内可写 tmp/）也能跑测试 E。
 *
 * g-350（Windows 符号链接能力）：`symlinkSync(dir)` 在**原生 Windows**（未开开发者模式 /
 * 无 `SeCreateSymbolicLinkPrivilege`）会 EPERM；Windows 上目录**联接（junction）不需要该特权**，
 * 故先试 `dir` 再回退 `junction`。两路皆失败时返回**可读诊断**（点名 errno + 回退建议），
 * 而不是让调用方看到一句误导的「未找到 node_modules」。
 * `symlink` 可注入：本机（Linux/WSL2）无法原生复现 Windows 分支，用注入桩覆盖两条回退路径；
 * **原生 Windows 未验证**（如实标注，见测试 G2 注释）。
 * @returns `{ ok, via, reason }` —— `via` 记录实际走通的链接方式（`symlink` / `junction`）。
 */
function linkDependencies(
  mirrorRoot: string,
  deps: { symlink?: typeof symlinkSync } = {},
): { ok: boolean; via: "symlink" | "junction" | null; reason: string } {
  const symlink = deps.symlink ?? symlinkSync;
  const link = join(mirrorRoot, "node_modules");
  const attempts: Array<{ via: "symlink" | "junction"; type: "dir" | "junction" }> = [
    { via: "symlink", type: "dir" },
    { via: "junction", type: "junction" },
  ];
  for (let dir = repoRoot; ; ) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate)) {
      const errors: string[] = [];
      for (const attempt of attempts) {
        try {
          symlink(candidate, link, attempt.type);
          return { ok: true, via: attempt.via, reason: "" };
        } catch (e: any) {
          errors.push(`${attempt.via}=${e?.code ?? e?.message ?? "unknown"}`);
        }
      }
      return {
        ok: false,
        via: null,
        reason:
          `找到 ${candidate} 但无法建立 node_modules 链接（${errors.join(", ")}）；` +
          `Windows 上目录链接需开发者模式/符号链接特权，回退 junction 亦失败，请检查权限或改用非镜像夹具`,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) return { ok: false, via: null, reason: "向上遍历到根仍未找到 node_modules" };
    dir = parent;
  }
}

/**
 * g-350：把**镜像（授权临时目录）内**待覆写的文件恢复为 0644。
 * 只读检出（全树 0444）下 `cpSync` 会把只读权限一起复制进镜像，测试 E 的覆写因此 EACCES
 * （g-349 复核 N1 的最小复现）。本函数**只作用于镜像副本**，源检出一个字节、一个权限位都不动。
 */
function makeWritableForTest(path: string): void {
  chmodSync(path, 0o644);
}

test("E 加载机制：资产为每次调用读取，改动后同一模块实例立即生效（无需重启宿主）", async () => {
  // R3：镜像落在**仓库外**的临时目录（`outOfRepoTempBase()` 显式挑选，g-363），**不**依赖
  // 仓库内可写的 tmp/ ⇒ 只读检出也能跑；镜像里的 dist/core/ops.js 需要解析 `yaml`，
  // 故把镜像根 node_modules 链接到仓库的 node_modules。
  const mirrorRoot = mkdtempSync(join(outOfRepoTempBase(), "dsh-graph-g347-mirror-"));
  try {
    assert.ok(
      !mirrorRoot.startsWith(repoRoot + "/"),
      `镜像不得落在仓库内（只读检出会因不可写而失败）: ${mirrorRoot}`,
    );
    const link = linkDependencies(mirrorRoot);
    assert.ok(link.ok, `镜像无法解析 yaml 依赖：${link.reason}`);
    const mirrorDist = join(mirrorRoot, "dist");
    cpSync(join(repoRoot, "dist"), mirrorDist, { recursive: true });
    const mirrorHelp = join(mirrorDist, "prompts", "help.zh.md");
    // g-350：只读检出（全树 0444）下 `cpSync` 连权限一起复制，镜像副本因此不可写 ⇒
    // 覆写前必须把**镜像副本**恢复为 0644（源检出不改；根因与负向对照见测试 G）。
    makeWritableForTest(mirrorHelp);
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

// ============================================================================
// G（g-350）：0444 只读副本可写性 —— 只读检出（全树 0444）下测试 E 不因权限而 red
// ============================================================================

test("G 0444 只读副本可写性：cpSync 连权限一起复制 ⇒ 必须显式恢复镜像副本可写（负向对照：不恢复即 EACCES）", (t) => {
  // root 绕过权限位 ⇒「不可写」前提不成立。如实标注本能力边界，不制造假绿。
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("当前以 root 运行：0444 权限位不构成写保护，本夹具前提不成立（非 root 环境下方真实生效）");
    return;
  }
  const srcRoot = mkdtempSync(join(outOfRepoTempBase(), "dsh-graph-g347-ro-src-"));
  const dstRoot = mkdtempSync(join(outOfRepoTempBase(), "dsh-graph-g347-ro-dst-"));
  try {
    // 只读检出形态：资产文件 0444（目录 0755，故可建/删文件，但文件本身不可写）
    const srcFile = join(srcRoot, "help.zh.md");
    writeFileSync(srcFile, "READONLY-SENTINEL");
    chmodSync(srcFile, 0o444);
    assert.equal(statSync(srcFile).mode & 0o777, 0o444, "夹具前置：源文件必须真的是 0444");

    const dstFile = join(dstRoot, "help.zh.md");
    cpSync(srcFile, dstFile);
    // 根因：cpSync 会**连权限一起复制** ⇒ 镜像副本同样 0444。
    assert.equal(
      statSync(dstFile).mode & 0o777,
      0o444,
      "根因断言：cpSync 保留源权限，镜像副本继承 0444（这正是测试 E 在全树 0444 检出下 EACCES 的成因）",
    );
    // 负向对照（= 回退修复 makeWritableForTest）：不恢复可写时覆写必须失败
    assert.throws(
      () => writeFileSync(dstFile, "OVERWRITE"),
      /EACCES|EPERM|permission denied/i,
      "未恢复可写时必须 EACCES —— 这就是「回退修复」后测试 E 的红灯形态",
    );
    // 修复：只对**镜像副本**恢复 0644
    makeWritableForTest(dstFile);
    assert.equal(statSync(dstFile).mode & 0o777, 0o644, "镜像副本必须恢复为 0644");
    assert.equal(statSync(srcFile).mode & 0o777, 0o444, "修复只作用于镜像副本：源检出必须仍是 0444（零改动）");
    writeFileSync(dstFile, "OVERWRITE");
    assert.equal(readFileSync(dstFile, "utf8"), "OVERWRITE", "恢复可写后覆写必须成功");
    t.diagnostic(`evidence: suite=g347-ro-copy src_mode=444 dst_after_cp=444 write_before=EPERM dst_after_fix=644`);
  } finally {
    for (const f of [join(srcRoot, "help.zh.md"), join(dstRoot, "help.zh.md")]) {
      try { chmodSync(f, 0o644); } catch { /* 文件可能未建 */ }
    }
    rmSync(srcRoot, { recursive: true, force: true });
    rmSync(dstRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// G2（g-350）：Windows 符号链接能力 —— dir 失败回退 junction，失败给可读诊断
// ============================================================================

test("G2 Windows 符号链接能力：dir 抛 EPERM 时回退 junction；两路皆失败给可读诊断（注入桩）", () => {
  const mirror = () => mkdtempSync(join(outOfRepoTempBase(), "dsh-graph-g347-link-"));
  const made: string[] = [];
  try {
    // (a) 能力齐全：一次 dir 链接成功，不得多试 junction
    const a = mirror();
    made.push(a);
    const callsA: string[] = [];
    const ra = linkDependencies(a, {
      symlink: ((_t: string, _p: string, type: string) => { callsA.push(type); }) as unknown as typeof symlinkSync,
    });
    assert.equal(ra.ok, true, `能力可用时必须成功：${ra.reason}`);
    assert.equal(ra.via, "symlink");
    assert.deepEqual(callsA, ["dir"], "能力可用时不得额外尝试 junction");

    // (b) 原生 Windows 无符号链接特权：dir 抛 EPERM ⇒ 必须回退 junction（Windows 不需要该特权）
    const b = mirror();
    made.push(b);
    const callsB: string[] = [];
    const rb = linkDependencies(b, {
      symlink: ((_t: string, _p: string, type: string) => {
        callsB.push(type);
        if (type === "dir") {
          const e: NodeJS.ErrnoException = new Error("EPERM: operation not permitted, symlink");
          e.code = "EPERM";
          throw e;
        }
      }) as unknown as typeof symlinkSync,
    });
    assert.equal(rb.ok, true, `dir 抛 EPERM 时必须回退 junction（原实现直接失败）：${rb.reason}`);
    assert.equal(rb.via, "junction");
    assert.deepEqual(callsB, ["dir", "junction"], "必须先 dir 后 junction");

    // (c) 两路皆失败：boolean 时代只会报「未找到 node_modules」（误导性），现须给可读诊断
    const c = mirror();
    made.push(c);
    const rc = linkDependencies(c, {
      symlink: ((_t: string, _p: string, type: string) => {
        const e: NodeJS.ErrnoException = new Error(`EPERM: operation not permitted, symlink ${type}`);
        e.code = "EPERM";
        throw e;
      }) as unknown as typeof symlinkSync,
    });
    assert.equal(rc.ok, false, "两路皆失败时 ok 必须为 false");
    assert.equal(rc.via, null);
    assert.match(rc.reason, /EPERM/, "诊断必须点名真实 errno（而非「未找到 node_modules」这种误导信息）");
    assert.match(rc.reason, /junction/, "诊断必须指出已尝试的回退方式");
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  }
  // 能力边界（如实标注）：本机为 Linux/WSL2，上述 Windows 分支由注入桩覆盖；
  // **原生 Windows 真机未验证**（发布门禁要求的 Windows T1–T5 另由 scripts/win-smoke-test.mjs 承担）。
});

// ============================================================================
// H（g-350）：真实 UNION_WHITELIST 自保护 —— 白名单本身此前无断言守护
// ============================================================================

test("H 真实 UNION_WHITELIST 自保护：窄登记（扩宽/删项必红），且唯一合法项对应引擎真实 XOR 校验", () => {
  // ① 结构钉死：实测给白名单**多登记**一组（`graph_memory_replace: [["old","text"]]`）后
  //    A/B/C/D/E/F 全部仍绿 ⇒ 假 XOR 可被「顺手放行」。本条把登记面收敛为精确形状。
  assert.deepEqual(
    Object.entries(UNION_WHITELIST).map(([tool, groups]) => [tool, groups.map((g) => [...g].sort())]),
    [["graph_unbind_goal_child", [["attempt", "child_id"]]]],
    "UNION_WHITELIST 只允许登记引擎确有互斥/XOR 校验的工具；扩宽或删项都必须同时给出引擎侧证据",
  );

  // ② 引擎接地：白名单不是自我声明 —— 直接调用引擎核心，验证这两个参数确实是「二者恰取其一」。
  const root = mkdtempSync(join(outOfRepoTempBase(), "dsh-graph-g347-union-"));
  try {
    init(root);
    const failure = (opts: Record<string, unknown>): string => {
      try {
        unbindGoalChild(root, "g-none", { actor: "human:gui", token: "t", ...opts });
        return "(no throw)";
      } catch (e: unknown) {
        return String((e as Error)?.message ?? e);
      }
    };
    const XOR = /必须且只能指定一个选择器：attempt 或 child_id/;
    assert.match(failure({ attempt: "att-001", childId: "child-1" }), XOR, "引擎在「两个都给」时必须拒绝（真 XOR 的判据）");
    assert.match(failure({}), XOR, "引擎在「一个都不给」时必须拒绝（真 XOR 的判据）");
    assert.doesNotMatch(failure({ attempt: "att-001" }), XOR, "只给一个选择器时 XOR 校验必须放行（其后失败于目标不存在）");
    assert.doesNotMatch(failure({ childId: "child-1" }), XOR, "只给一个选择器时 XOR 校验必须放行（其后失败于目标不存在）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
