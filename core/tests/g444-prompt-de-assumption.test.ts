// g-444：提示词与运行期文案「去本仓库特有假设」的防复发守卫。
//
// 口径（负责人 2026-10-08，含 14:47 定稿 + r1 复核追加）：
//  · 源码注释可以有内部编号/内部路径（豁免）；**给用户 supervisor 的提示词**与**运行期文案**
//    不得假设能获取本仓库特有目录结构 / 脚本 / 分支模型 / 文件（含 `.dsh-graph` 内部文件名）。
//  · A) 资产扫描（仅模型可读面，**每个预期资产都有粒度下限，防 fail-open**）：
//      ① `dsh-graph-host/prompts/*.md` 与 `dsh-graph-host/supervisor-guide.{zh,en}.md`（源码 + dist 投递副本）；
//      ② `dsh-graph-host/lib/server-i18n.js` 的**字符串值**（导入模块取 value ⇒ 键名/注释天然不计）；
//      ③ `dsh-graph-host/lib/client/i18n.js`（GUI 可见文案）与 `dist/lib/client.js` 的
//         **全部字符串字面量**（`'…'` / `"…"` / 反引号，含数组元素、赋值右侧、键名；拼接片段不可导入，
//         故按字符扫描）。四条 fail-closed 不变式：
//           · **解转义后入面** ⇒ `'…DSH\u00200.1.6…'` 这类编码写法照样命中；**行继续**（`\` + LF/CRLF/CR）
//             按运行时语义**归空串**（`'DSH 0.1.\⏎6'` 运行时即 `DSH 0.1.6`）；
//           · **相邻字面量 `+` 拼接折叠**后入面（`'k': 'a' + 'b'`、`` `${'a' + 'b'}` ``、`const s = 'a' + 'b'`
//             同口径）⇒ 拆到多个字面量的 token 仍被拼回命中；
//           · **承重完备性腿**：无法解析的含引号内容（未闭合字面量/块注释）必须为 0（宁可判红，不许静默）；
//             （另一条「注释外残留引号 = 0」经复核插桩证明是**恒真式**——每个引号必然走字面量或未闭合
//             分支——已删除，不再并列宣称。）
//           · 源码字面量多重集 ⊆ dist 字面量多重集（兼作 dist 新鲜度；折叠派生条目不参与）+ 分辨率下限 + 金丝雀。
//         合法插值（`{n}` 等）不受影响。
//  · **收口声明（2026-10-08，最后一轮复核后）**：本守卫是**词法绊线**，不是「无本仓假设」的完备证明。
//    已记录并接受、**不再追修**的局限：① **拼写变体**（`dsh_graph_host/`、反斜杠、大小写、双空格…）；
//    ② **跨非相邻构造拆分 token**（如 `'DSH' + x + ' 0.1.6'`、变量/别名中转、`String.raw`、`%s` 占位拼接）；
//    ③ 任何需要**常量折叠 / 别名分析**才能识别的形态。后人不必反复扩张本守卫。
//  · **粒度下限是粗网，精细网在邻居守卫**（复核实测 2026-10-08）：把 `prompts/worktree.{zh,en}.md`
//    对称截断到 1 长行（179/205 字节）并重建后，本守卫 13/13 仍绿，但整套件 **8 红** =
//    `g239`×1 + `g241`×1 + `g253`×1 + `g283`×4 + 「zh prompt assets are not stubs」×1 ⇒ **不构成套件级
//    静默绿**。故本守卫不加「基线一半」「逐资产锚点表」这类会随正常改文误红的阈值（预案保留、未采用），
//    只留「非空行 ≥1 且字节 ≥100」的粗网与聚合断言（资产数 32、扫描行数 >1000）。
//  · 显式豁免（各自都有正例与「豁免不过宽」的反例）：
//      ① 「本项目示例 / 示例（本仓库）」(en: this repository example) 标记——**必须与被豁免的 token 紧邻**
//         （同括号且标记在前，或标记紧随其后），且**每资产豁免行数 ≤2**；只对 4 个「命令/路径」token 生效；
//      ② `INDEX.md` 出现在否定语境（不再/已取消/非记忆真源…）时放行；肯定语境（必须维护）仍判红；
//      ③ `<!-- -->` HTML 注释不计；客户端 i18n 侧走「注释与正则字面量不计、其余全部字符串字面量入面」口径。
//  · B) 行为断言：HANDOFF 只留 skill 名、上限文案（工具侧 + GUI 侧）不写死版本/槽位、骨架无 npm 生态词、zh/en 同步。
//  · 负向对照：塞回任一 token（含转义编码 / 非键值行两种整形态）/ 清空任一预期资产 / 滥用示例标记 ⇒ 必红。
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
/** 客户端 i18n 字面量分辨率下限（实测源码 3962 / dist 10485）。 */
const CLIENT_I18N_MIN_LITERALS = 3500;

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

type LiteralEntry = {
  value: string;
  line: number;
  /** 相邻字面量 `+` 拼接折叠出的派生条目（不参与「源码 ⊆ dist」腿，只入扫描面）。 */
  folded?: boolean;
};

type LiteralScan = {
  /** 解转义后的**全部**字符串字面量（单引号 / 双引号 / 反引号；含数组元素、赋值右侧、键名）。 */
  values: LiteralEntry[];
  /** 含引号却无法安全解析的位置（未闭合字面量 / 未闭合块注释）⇒ 判红，绝不静默（**承重完备性腿**）。 */
  unparsed: { line: number; why: string }[];
};

const ESCAPES: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0", "\\": "\\", "'": "'", '"': '"', "`": "`",
};

/**
 * 解 JS 字符串转义（`\n` `\t` `\'` `\"` `\\` `\xNN` `\uNNNN` `\u{…}`），
 * 并正确处理**行继续**：`\` + LF / CRLF / CR 在运行时**整段删除**（归空串，不是换行）。
 */
function decodeEscapes(raw: string): string {
  return raw.replace(/\\(\r\n|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, g: string) => {
    if (g === "\r\n" || g === "\n" || g === "\r") return "";
    if (g.startsWith("u{")) return String.fromCodePoint(parseInt(g.slice(2, -1), 16));
    if (g.startsWith("u")) return String.fromCharCode(parseInt(g.slice(1), 16));
    if (g.startsWith("x")) return String.fromCharCode(parseInt(g.slice(1), 16));
    return ESCAPES[g] ?? g;
  });
}

type LitToken = { raw: string; line: number; end: number; endLine: number };

/** 从 `start` 处读一个字面量（`'` / `"` / 反引号）；未闭合返回 null（调用方记 unparsed）。 */
function readLiteral(text: string, start: number, line: number): LitToken | null {
  const quote = text[start];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;
  let raw = "";
  let cur = line;
  for (let j = start + 1; j < text.length; j += 1) {
    const d = text[j];
    if (d === "\\") {
      raw += d;
      if (j + 1 < text.length) {
        const nxt = text[j + 1];
        raw += nxt;
        j += 1;
        if (nxt === "\n") cur += 1;
        else if (nxt === "\r" && text[j + 1] === "\n") { raw += "\n"; j += 1; cur += 1; }
      }
      continue;
    }
    if (d === quote) return { raw, line, end: j, endLine: cur };
    if (d === "\n") {
      if (quote !== "`") return null;
      cur += 1;
    }
    raw += d;
  }
  return null;
}

/** 跳过空白与注释（折叠与前瞻用），返回下一个有效字符位置。 */
function skipTrivia(text: string, index: number, line: number): { index: number; line: number } {
  let i = index;
  let cur = line;
  for (;;) {
    const c = text[i];
    if (c === undefined) return { index: i, line: cur };
    if (c === "\n") { cur += 1; i += 1; continue; }
    if (c === " " || c === "\t" || c === "\r") { i += 1; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i += 1; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; continue; }
    return { index: i, line: cur };
  }
}

/** 取出模板字面量里 `${…}` 的**代码片段**（括号配对、内嵌字符串跳过）⇒ 递归入面，供 `` `${'a' + 'b'}` `` 折叠。 */
function templateExpressions(raw: string, baseLine: number): { code: string; line: number }[] {
  const out: { code: string; line: number }[] = [];
  let i = 0;
  const lineAt = (upto: number) => baseLine + (raw.slice(0, upto).match(/\n/g)?.length ?? 0);
  while (i < raw.length) {
    if (raw[i] === "\\") { i += 2; continue; }
    if (raw[i] === "$" && raw[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      const start = j;
      while (j < raw.length && depth > 0) {
        const d = raw[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "'" || d === '"' || d === "`") {
          j += 1;
          while (j < raw.length && raw[j] !== d) { if (raw[j] === "\\") j += 1; j += 1; }
          j += 1;
          continue;
        }
        if (d === "{") depth += 1;
        else if (d === "}") depth -= 1;
        j += 1;
      }
      out.push({ code: raw.slice(start, Math.max(start, j - 1)), line: lineAt(start) });
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * 按字符扫描 JS 文本，提取**全部字符串字面量**并解转义，另把**相邻字面量 `+` 拼接**折叠后再入面。
 * 不进扫描面：`//` 与块注释（源码注释豁免）、正则字面量（其内部引号不代表文案）。
 * fail-closed：未闭合字面量/注释记入 `unparsed`（**承重腿**：解析不到的含引号内容必判红）。
 * 明确不追的形态见文件头「收口声明」（拼写变体、跨非相邻构造拆分、需常量折叠/别名分析的形态）。
 */
function scanLiterals(text: string): LiteralScan {
  const values: LiteralEntry[] = [];
  const unparsed: LiteralScan["unparsed"] = [];
  let i = 0;
  let line = 1;
  let prev = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") line += 1;
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i += 1) if (text[i] === "\n") line += 1;
      if (end < 0) unparsed.push({ line, why: "未闭合块注释" });
      continue;
    }
    // 正则字面量启发式：前一个有效字符是运算符/开括号等（或行首）时视为正则，整体跳过。
    if (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%~^<>]/.test(prev))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      for (; j < text.length; j += 1) {
        const d = text[j];
        if (d === "\\") { j += 1; continue; }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { closed = true; break; }
      }
      if (closed) { i = j + 1; prev = "/"; continue; }
    }
    if (c === "'" || c === '"' || c === "`") {
      const first = readLiteral(text, i, line);
      if (first === null) {
        unparsed.push({ line, why: "未闭合字符串字面量" });
        while (i < text.length && text[i] !== "\n") i += 1;
        continue;
      }
      const parts = [decodeEscapes(first.raw)];
      values.push({ value: parts[0], line: first.line });
      // 模板字面量：`${…}` 内的代码片段递归入面（`` `${'a' + 'b'}` `` 也能被折叠命中）。
      if (c === "`") {
        for (const inner of templateExpressions(first.raw, first.line)) {
          const sub = scanLiterals(inner.code);
          for (const v of sub.values) values.push({ ...v, line: inner.line + v.line - 1 });
          for (const u of sub.unparsed) unparsed.push({ line: inner.line + u.line - 1, why: `模板插值内：${u.why}` });
        }
      }
      let end = first.end;
      let endLine = first.endLine;
      // 相邻字面量 `+` 拼接：整链折叠后再入面（`'a' + 'b'` 与 `'k': 'a' + 'b'` 同口径）。
      for (;;) {
        const op = skipTrivia(text, end + 1, endLine);
        if (text[op.index] !== "+") break;
        const operand = skipTrivia(text, op.index + 1, op.line);
        const next = readLiteral(text, operand.index, operand.line);
        if (next === null) break;
        parts.push(decodeEscapes(next.raw));
        values.push({ value: parts[parts.length - 1], line: next.line });
        end = next.end;
        endLine = next.endLine;
      }
      if (parts.length > 1) values.push({ value: parts.join(""), line: first.line, folded: true });
      i = end + 1;
      line = endLine;
      prev = text[end];
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return { values, unparsed };
}

/** 客户端 i18n（GUI 可见文案）：源码与 dist 拼接副本两侧的**全部字符串字面量**（含 `+` 拼接折叠）。 */
function scanClientI18n(): string[] {
  const out: string[] = [];
  const src = scanLiterals(readFileSync(CLIENT_I18N_SRC, "utf8"));
  const dist = scanLiterals(readFileSync(CLIENT_BUNDLE_DIST, "utf8"));
  const sides = [["源/lib/client/i18n.js", src], ["dist/lib/client.js", dist]] as const;
  // 完备性（fail-closed）：含引号却解析不了的形态必判红。**这是本扫描面的承重完备性腿**
  // （另一条「注释外残留引号 = 0」经复核插桩证明是恒真式：每个引号必然走字面量/未闭合分支，已删除）。
  for (const [label, r] of sides) {
    if (r.unparsed.length > 0) {
      out.push(`${label}: 有 ${r.unparsed.length} 处字面量无法解析（首个 line ${r.unparsed[0].line}：${r.unparsed[0].why}）——扫描面不可信`);
    }
  }
  // 分辨率下限 + 源码字面量必须落进 dist（兼作 dist 新鲜度）；**折叠派生条目**不参与该腿。
  if (src.values.length < CLIENT_I18N_MIN_LITERALS) {
    out.push(`源/lib/client/i18n.js: 字面量条数 ${src.values.length} < ${CLIENT_I18N_MIN_LITERALS}——文件被清空/截断`);
  }
  if (dist.values.length < src.values.length) {
    out.push(`dist/lib/client.js: 字面量条数 ${dist.values.length} < 源码 ${src.values.length}——dist 未重建或注入被吞`);
  }
  const distCount = new Map<string, number>();
  for (const { value, folded } of dist.values) {
    if (folded) continue;
    distCount.set(value, (distCount.get(value) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const { value, folded } of src.values) {
    if (folded) continue;
    const left = distCount.get(value) ?? 0;
    if (left === 0) { missing.push(value); continue; }
    distCount.set(value, left - 1);
  }
  if (missing.length > 0) {
    out.push(`dist/lib/client.js: 有 ${missing.length} 条源码字面量未落进 dist（如 ${missing[0].slice(0, 60)}）——需重建 dist`);
  }
  // 金丝雀：GUI 侧上限文案必须仍在扫描面内（防扫描面空洞）。
  const canary = src.values.filter(({ value }) => /子代理激活已达上限|Subagent activation limit reached/.test(value));
  if (canary.length !== 2) {
    out.push(`源/lib/client/i18n.js: 金丝雀文案命中 ${canary.length} 条（应为 zh/en 各 1，实测 ${canary.length}）`);
  }
  for (const [label, r] of sides) {
    for (const { value, line, folded } of r.values) {
      out.push(...scanText(`${label}:${line}${folded ? ":folded" : ""}`, value));
    }
  }
  return out;
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

test("g-444 判据3：客户端 i18n（GUI 可见文案，源码 + dist 拼接副本）全部字符串字面量 0 命中", () => {
  const src = scanLiterals(readFileSync(CLIENT_I18N_SRC, "utf8"));
  const dist = scanLiterals(readFileSync(CLIENT_BUNDLE_DIST, "utf8"));
  // 完备性腿（承重）：不得有解析不了的含引号内容（宁可判红，不许静默）。
  for (const [label, r] of [["源", src], ["dist", dist]] as const) {
    assert.deepEqual(r.unparsed, [], `${label}: 存在无法解析的字面量`);
  }
  assert.ok(src.values.length >= CLIENT_I18N_MIN_LITERALS, `源码字面量条数过少（${src.values.length}）`);
  assert.ok(dist.values.length >= src.values.length, `dist 字面量 ${dist.values.length} 少于源码 ${src.values.length}`);
  assert.deepEqual(scanClientI18n(), [], "客户端 i18n 字符串字面量命中禁用 token");
});

test("g-444 字面量口径：转义编码 / 非键值行两类形态必须入面（复核 P1 假绿的两种写法）", () => {
  // 形态①：把 token 写成 \u 转义 —— 必须**解转义后**命中。
  const escaped = scanLiterals("    'live.x': '⚠️ DSH\\u00200.1.6 起默认 8 个活跃子代理',\n");
  assert.deepEqual(escaped.unparsed, []);
  const escapedHits = escaped.values.flatMap(({ value }) => scanText("fixture", value));
  assert.deepEqual(escapedHits.map((v) => v.match(/\[([a-z-]+)\]/)?.[1]), ["hardcoded-dsh-version", "hardcoded-subagent-slots"], "转义写法必须命中");

  // 形态②：token 出现在**非键值行**（赋值右侧）—— 必须入面。
  const assignment = scanLiterals("const G444_LEAK = 'DSH 0.1.6 起默认 8 个活跃子代理';\n");
  assert.deepEqual(assignment.unparsed, []);
  const assignHits = assignment.values.flatMap(({ value }) => scanText("fixture", value));
  assert.deepEqual(assignHits.map((v) => v.match(/\[([a-z-]+)\]/)?.[1]), ["hardcoded-dsh-version", "hardcoded-subagent-slots"], "非键值行必须入面");

  // 数组元素 / 反引号 / 双引号同样入面；注释与正则字面量不入面。
  const mixed = scanLiterals([
    "const arr = ['dsh-graph-host/', \"prepareAttemptWorktree\", `node --test core/tests/x`];",
    "// 注释里的 dsh-graph-host/ 与 INDEX.md 不计",
    "/* 块注释里的 DSH 0.1.6 不计 */",
    "const re = /[\"'](DSH 0\\.1\\.6)[\"']/;",
    "const s = '安全值 {n}';",
  ].join("\n"));
  assert.deepEqual(mixed.unparsed, [], "不得有无法解析的字面量");
  const mixedHits = mixed.values.flatMap(({ value }) => scanText("fixture", value));
  assert.deepEqual(mixedHits.map((v) => v.match(/\[([a-z-]+)\]/)?.[1]), [
    "repo-package-path", "internal-fn-name", "repo-test-cmd",
  ], `数组/双引号/反引号入面、注释与正则不入面（实得 ${JSON.stringify(mixedHits)}）`);
  assert.equal(mixed.values.filter(({ value }) => value.includes("{n}")).length, 1, "合法插值仍入面且不误判");

  // 解析不了的含引号内容必须判红（而不是静默漏掉）——承重完备性腿。
  const broken = scanLiterals("const s = '没有收尾引号\n");
  assert.equal(broken.unparsed.length, 1, "未闭合字面量必须记入 unparsed");
  assert.match(broken.unparsed[0].why, /未闭合/);
});

test("g-444 字面量口径②：运行时真值必然入面（行继续 / `+` 拼接的差分对照）", () => {
  /**
   * 差分对照：右侧用 `new Function` 求**运行时字符串**（真值），左侧要求扫描面必须命中——
   * 即「运行时会拼出 token 的写法，扫描面不得漏」。list 覆盖复核点名的两类新形态。
   */
  const runtime = (expr: string): string => new Function(`return (${expr});`)() as string;
  const cases: { why: string; expr: string; expect: string[] }[] = [
    { why: "行继续 LF", expr: "'DSH 0.1.\\\n6 起默认 8 个活跃子代理'", expect: ["hardcoded-dsh-version", "hardcoded-subagent-slots"] },
    { why: "行继续 CRLF", expr: "'DSH 0.1.\\\r\n6 起默认 8 个活跃子代理'", expect: ["hardcoded-dsh-version", "hardcoded-subagent-slots"] },
    { why: "unicode 转义", expr: "'DSH\\u00200.1.6'", expect: ["hardcoded-dsh-version"] },
    { why: "hex 转义", expr: "'DSH\\x200.1.6'", expect: ["hardcoded-dsh-version"] },
    { why: "相邻字面量拼接", expr: "'DSH ' + '0.1.6 起默认 8 个活跃子代理'", expect: ["hardcoded-dsh-version", "hardcoded-subagent-slots"] },
    { why: "跨行相邻拼接", expr: "'DSH '\n      + '0.1.6'", expect: ["hardcoded-dsh-version"] },
    { why: "注释隔开的相邻拼接", expr: "'DSH ' /* 注释 */ + '0.1.6'", expect: ["hardcoded-dsh-version"] },
    { why: "反引号内嵌拼接", expr: "`${'DSH' + ' 0.1.6'}`", expect: ["hardcoded-dsh-version"] },
  ];
  for (const c of cases) {
    const truth = runtime(c.expr);
    assert.ok(c.expect.every((id) => RULES.find((r) => r.id === id)!.pattern.test(truth)), `${c.why}: 夹具本身应命中（runtime=${truth}）`);
    const scan = scanLiterals(c.expr);
    assert.deepEqual(scan.unparsed, [], `${c.why}: 不得有未解析字面量`);
    const hits = scan.values.flatMap(({ value }) => scanText("fixture", value));
    const ids = hits.map((v) => v.match(/\[([a-z-]+)\]/)?.[1]);
    for (const id of c.expect) assert.ok(ids.includes(id), `${c.why}: 运行时真值命中 ${id}，扫描面却漏了（扫描面=${JSON.stringify(scan.values.map((v) => v.value))}）`);
  }
  // 键值行形态（复核要求至少覆盖）：`'k': 'a' + 'b'`。
  const kv = scanLiterals("    'live.x': 'DSH ' + '0.1.6 起默认 8 个活跃子代理',\n");
  const kvHits = kv.values.flatMap(({ value }) => scanText("fixture", value)).map((v) => v.match(/\[([a-z-]+)\]/)?.[1]);
  assert.ok(kvHits.includes("hardcoded-dsh-version") && kvHits.includes("hardcoded-subagent-slots"), `键值行拼接必须命中（实得 ${JSON.stringify(kvHits)}）`);
  // 反向护栏：不拼出 token 的相邻拼接不得误报。
  const clean = scanLiterals("const s = '插件' + '包目录';\n");
  assert.deepEqual(clean.values.flatMap(({ value }) => scanText("fixture", value)), [], "合法拼接不得误报");
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

test("g-444 豁免正例③：HTML 注释不计；客户端 i18n 走「注释/正则不计、其余字面量全入面」口径", async () => {
  assert.deepEqual(scanText("fixture", "正文安全。\n<!-- node --test core/tests 与 dsh-graph-host/ 在注释里 -->\n<!--\n多行注释：prepareAttemptWorktree\n-->"), []);
  assert.equal(scanText("fixture", "正文泄露：node --test core/tests").length, 1, "正文同类文本必须判红");

  // i18n：注释（行注释/块注释）不入面，键名与值**都**入面（全字面量口径，宁可判红不静默）。
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g444-i18n-"));
  const file = join(dir, "fixture-i18n.mjs");
  writeFileSync(file, [
    "    // 注释里出现 dsh-graph-host/ 与 node --test core/tests，不应计入扫描面",
    "    const zh = {",
    "      'clean.key': '安全值 {n} 插值合法',",
    "      'dsh-graph-host/leaky.key': '键名里的本仓库路径同样入面',",
    "      'dirty.key': '泄露 prepareAttemptWorktree',",
    "    };",
  ].join("\n"));
  const parsed = scanLiterals(readFileSync(file, "utf8"));
  assert.deepEqual(parsed.unparsed, []);
  const hits = parsed.values.flatMap(({ value }) => scanText("fixture", value));
  assert.deepEqual(hits.map((v) => v.match(/\[([a-z-]+)\]/)?.[1]), ["repo-package-path", "internal-fn-name"], "键名与值都入面、注释不入面");
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
  const canary = scanLiterals(readFileSync(CLIENT_I18N_SRC, "utf8")).values
    .map(({ value }) => value)
    .filter((value) => /子代理激活已达上限|Subagent activation limit reached/.test(value));
  assert.equal(canary.length, 2, "GUI 上限文案应 zh/en 各一条");
  assert.ok(canary.some((v) => v.includes("上限由运行环境配置")), canary.join("\n"));
  assert.ok(canary.some((v) => /the limit is configured by the runtime environment/.test(v)), canary.join("\n"));
  for (const value of canary) {
    assert.doesNotMatch(value, /0\.1\.6|默认\s*\d+\s*个|defaults to \d+/, `GUI 上限文案不得写死：${value}`);
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
