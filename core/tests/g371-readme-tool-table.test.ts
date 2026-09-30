/**
 * g-371 判据 1/2/6：README 工具面机器守卫（「改坏即红」）。
 *
 * 为什么需要（g-370 独立复核 NOTE-3 / M2b、M4）：
 *  - 复核者删掉 `dsh-graph-host/README.md` 英文工具表一行并**重建**后，全量 1393/1393 全绿——
 *    只有「不重建」才被 `g312` 以**新鲜度**（dist 副本逐字一致）抓到，属复制断言而非语义断言；
 *  - 根 README 追加「按需记忆每条硬上限 2000 字符」（错值）全绿——`g339` 只禁字面 `上限 500`；
 *  - `g347` 已把 `help.{zh,en}.md` 与引擎 schema 钉住，但**三张 README 工具表**与其计数声明
 *    此前零内容级断言 ⇒ 「工具名在六处一致」只靠人工复核。
 *
 * 断言面（真源 = 引擎实际注册的 tool def，取自 `apply()`；不硬编码 49 名单）：
 *  A. 集合相等：root README 工具表 / host README zh 表 / host README en 表 / help.zh / help.en
 *     / `dsh-graph-host/index.js` 注册名 —— 六者与引擎注册集合**逐一相等**，且各恰 50；
 *  A2. 表内无重复工具行、每行列数与表头一致、工具列 token 全部是已注册工具名；
 *  B. 计数声明：两份 README 里「N 个 `graph_*` 工具 / N `graph_*` tools」的 N 必须等于注册实数，
 *     且至少存在一处声明（守卫不得恒真退化为「无声明即通过」）；
 *  C. 记忆上限声明：README / help 中提到「记忆 … 上限 N」时，N 必须是真源 `MEMORY_LIMITS`
 *     的取值（on_demand / standing）之一 —— M2b 的「硬上限 2000 字符」必红；
 *  F. 负向对照：对**内存中的字符串副本**做变异（删 root 表行 / 删 host en 表行 / 工具名改错一字符 /
 *     计数改错 / 追加假记忆上限），同一套判定函数必须报红；合法改写（表格行重排）不得误红。
 *     对照只改副本变量，绝不触碰仓库文件（末尾断言真实文件逐字未变）。
 *
 * 刻意不做的两件事（见交付说明）：
 *  - 不校验表格行**顺序**（判据只要求名集合相等），故合法重排不误红；
 *  - 不与 git tag 绑定（测试可能在无 `.git` 的 dist/tarball 环境运行；版本归属需 g-370 式人工考古）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../dist/index.js";
import { MEMORY_LIMITS } from "../ops.ts";

const repoRoot = join(import.meta.dirname, "../..");
const ROOT_README = join(repoRoot, "README.md");
const HOST_README = join(repoRoot, "dsh-graph-host", "README.md");
const HELP_ZH = join(repoRoot, "dsh-graph-host", "prompts", "help.zh.md");
const HELP_EN = join(repoRoot, "dsh-graph-host", "prompts", "help.en.md");
const INDEX_JS = join(repoRoot, "dsh-graph-host", "index.js");

/** 判据 1 明文要求的工具数；引擎加工具时必须同步所有文档面并改这一个常量（刻意的防静默漂移门禁）。 */
const EXPECTED_TOOL_COUNT = 50;

/** 工具名 token：容忍大小写与下划线，以便「改错一个字符」也能被完整捕获（而不是当成前缀匹配）。 */
const TOOL_TOKEN = /graph_[A-Za-z0-9_]+/g;

// =====================================================================================
// 真源：引擎实际注册的工具名
// =====================================================================================

/** 与 g347 同一套 mock ctx：apply 后从 ctx.tools.register 收集真实 tool def。 */
function registeredTools(): string[] {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g371-"));
  const registered: Array<{ name?: unknown }> = [];
  const webServer = { register: () => () => {} };
  const ctx: any = {
    get: (name: string) =>
      name === "sandboxPolicy" ? { workspaceRoot: root } : name === "webServer" ? webServer : undefined,
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: {
      register: (def: { name?: unknown }) => { registered.push(def); return () => {}; },
      get: () => ({}),
    },
  };
  apply(ctx, { root });
  return registered
    .map((d) => d.name)
    .filter((n): n is string => typeof n === "string" && n.startsWith("graph_"));
}

// =====================================================================================
// 提取与判定（纯函数：真实文件与内存副本共用同一套判定）
// =====================================================================================

type FaceInput = {
  schemaTools: string[];
  rootReadme: string;
  hostReadme: string;
  helpZh: string;
  helpEn: string;
  indexJs: string;
};

/** 取 markdown 章节正文：从 `heading` 起，到同级或更高级标题为止。 */
function sectionLines(text: string, heading: string, level: number): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) break;
    out.push(lines[i]);
  }
  return out;
}

/** 表格行 → 单元格数组；非表格行返回 null；分隔行以 `skipSeparator` 跳过。 */
function tableRows(text: string, heading: string, level: number): { header: string[]; body: string[][] } | null {
  const rows: string[][] = [];
  for (const line of sectionLines(text, heading, level)) {
    const t = line.trim();
    if (!t.startsWith("|") || !t.endsWith("|")) continue;
    const cells = t.slice(1, -1).split("|").map((c) => c.trim());
    if (cells.every((c) => c === "" || /^:?-{2,}:?$/.test(c))) continue; // 分隔行
    rows.push(cells);
  }
  if (rows.length === 0) return null;
  return { header: rows[0], body: rows.slice(1) };
}

/** 单元格里的工具名 token（剔除散文里的 `graph_*` 通配写法）。 */
function toolTokens(s: string): string[] {
  return (s.match(TOOL_TOKEN) ?? []).filter((t) => t !== "graph_");
}

/** 解析一张工具表：返回工具名序列 + 结构问题（列数不齐 / 工具列空 / 单行多工具）。 */
function collectTable(
  label: string,
  text: string,
  heading: string,
  level: number,
  toolCol: number,
  singlePerRow: boolean,
): { tools: string[]; problems: string[] } {
  const problems: string[] = [];
  const table = tableRows(text, heading, level);
  if (!table) return { tools: [], problems: [`${label}：未找到章节「${heading}」下的 markdown 表格（章节被改名/删除？）`] };
  const tools: string[] = [];
  table.body.forEach((cells, i) => {
    const at = `${label} 第 ${i + 1} 个数据行`;
    if (cells.length !== table.header.length) {
      problems.push(`${at}：列数 ${cells.length} ≠ 表头 ${table.header.length}（${cells.join(" | ").slice(0, 100)}）`);
      return;
    }
    const tokens = toolTokens(cells[toolCol]);
    if (tokens.length === 0) {
      problems.push(`${at}：工具列里没有任何 graph_* 名（原文「${cells[toolCol].slice(0, 60)}」）`);
      return;
    }
    if (singlePerRow && tokens.length !== 1) {
      problems.push(`${at}：每行应恰含 1 个工具名，实际 ${tokens.length} 个（${tokens.join(", ")}）`);
      return;
    }
    tools.push(...tokens);
  });
  return { tools, problems };
}

/** 解析 help 资产：只认行首 `- graph_xxx(` 的条目行（与 g347 同一约定）。 */
function collectHelp(label: string, text: string): { tools: string[]; problems: string[] } {
  const tools = [...text.matchAll(/^-\s+(graph_[A-Za-z0-9_]+)\s*\(/gm)].map((m) => m[1]);
  const problems: string[] = [];
  if (tools.length === 0) problems.push(`${label}：未解析到任何 \`- graph_xxx(\` 条目行`);
  return { tools, problems };
}

/** 解析 index.js 的注册名：`name: "graph_..."` 字面（与引擎 apply() 实数交叉核对）。 */
function collectIndexJs(text: string): { tools: string[]; problems: string[] } {
  const tools = [...text.matchAll(/name:\s*["'](graph_[A-Za-z0-9_]+)["']/g)].map((m) => m[1]);
  const problems: string[] = [];
  if (tools.length === 0) problems.push("dsh-graph-host/index.js：未解析到任何 `name: \"graph_...\"` 注册名");
  return { tools, problems };
}

function duplicatesOf(names: string[]): string[] {
  const seen = new Map<string, number>();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  return [...seen.entries()].filter(([, c]) => c > 1).map(([n, c]) => `${n}×${c}`);
}

function diffOf(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return { onlyA: [...sa].filter((x) => !sb.has(x)), onlyB: [...sb].filter((x) => !sa.has(x)) };
}

/** 判据 1 + 2（工具面）：六处名集合逐一相等、各恰 50、表内无重复、结构完整。 */
function toolFaceProblems(input: FaceInput): string[] {
  const problems: string[] = [];
  const reference = [...new Set(input.schemaTools)];
  if (reference.length !== EXPECTED_TOOL_COUNT) {
    problems.push(`引擎注册工具数 ${reference.length} ≠ 期望 ${EXPECTED_TOOL_COUNT}（新增/删除工具须同步本常量与全部文档面）`);
  }

  const faces: Array<{ id: string; tools: string[]; problems: string[] }> = [
    { id: "root README 工具表", ...collectTable("root README 工具表", input.rootReadme, "## 提供的工具", 2, 1, false) },
    { id: "host README zh 工具表", ...collectTable("host README zh 工具表", input.hostReadme, "### Agent 工具速查表", 3, 1, true) },
    { id: "host README en 工具表", ...collectTable("host README en 工具表", input.hostReadme, "### Agent Tools Reference", 3, 1, true) },
    { id: "help.zh.md", ...collectHelp("help.zh.md", input.helpZh) },
    { id: "help.en.md", ...collectHelp("help.en.md", input.helpEn) },
    { id: "index.js 注册名", ...collectIndexJs(input.indexJs) },
  ];

  for (const face of faces) {
    problems.push(...face.problems);
    const dup = duplicatesOf(face.tools);
    if (dup.length > 0) problems.push(`${face.id}：存在重复工具名 ${dup.join(", ")}`);
    const { onlyA, onlyB } = diffOf(face.tools, reference);
    if (onlyA.length > 0) problems.push(`${face.id}：出现未注册的工具名 ${onlyA.join(", ")}（拼写错误？）`);
    if (onlyB.length > 0) problems.push(`${face.id}：缺少已注册工具 ${onlyB.join(", ")}`);
    if (face.tools.length !== reference.length && onlyA.length === 0 && onlyB.length === 0) {
      problems.push(`${face.id}：条目数 ${face.tools.length} ≠ 注册数 ${reference.length}（含重复行）`);
    }
  }
  return problems;
}

/** 判据 1（计数声明）：README 里「N 个 `graph_*` 工具 / N `graph_*` tools」的 N 必须等于注册实数。 */
function countClaimProblems(
  docs: Array<{ id: string; text: string }>,
  expected: number,
): string[] {
  const problems: string[] = [];
  let claims = 0;
  for (const { id, text } of docs) {
    text.split("\n").forEach((line, i) => {
      const patterns = [
        /(\d+)\s*个\s*`?graph_\*`?\s*工具/g,
        /(\d+)\s+`?graph_\*`?\s+tools?\b/gi,
      ];
      for (const re of patterns) {
        for (const m of line.matchAll(re)) {
          claims++;
          if (Number(m[1]) !== expected) {
            problems.push(`${id}:${i + 1} 工具计数声明为 ${m[1]}，引擎注册实数 ${expected}：${line.trim().slice(0, 120)}`);
          }
        }
      }
    });
  }
  if (claims === 0) problems.push("两份 README 中找不到任何「N 个 graph_* 工具 / N graph_* tools」计数声明（守卫退化，须恢复声明）");
  return problems;
}

/** 判据 6（M2b）：记忆上限措辞里的数字必须是真源 MEMORY_LIMITS 的取值之一。 */
function memoryClaimProblems(docs: Array<{ id: string; text: string }>): string[] {
  const allowed = new Set<number>([MEMORY_LIMITS.on_demand, MEMORY_LIMITS.standing]);
  const problems: string[] = [];
  for (const { id, text } of docs) {
    text.split("\n").forEach((line, i) => {
      if (!/记忆|memory/i.test(line)) return;
      const patterns = [
        /(?:硬)?上限\s*(?:为|是|[:：])?\s*(\d+)/g,
        /≤\s*(\d+)\s*(?:字|字符|chars?)/gi,
        /(\d+)\s*(?:字|字符)\s*(?:的)?(?:硬)?上限/g,
        /(\d+)\s*chars?\s*(?:hard\s*)?limit/gi,
      ];
      for (const re of patterns) {
        for (const m of line.matchAll(re)) {
          const n = Number(m[1]);
          if (!allowed.has(n)) {
            problems.push(
              `${id}:${i + 1} 记忆上限声明 ${n} 不在真源取值 {${[...allowed].join(", ")}} 内：${line.trim().slice(0, 120)}`,
            );
          }
        }
      }
    });
  }
  return problems;
}

// =====================================================================================
// 真实文件
// =====================================================================================

function readText(path: string): string {
  assert.ok(existsSync(path), `缺少文件：${path}`);
  return readFileSync(path, "utf8");
}

const REAL_TEXT = {
  rootReadme: readText(ROOT_README),
  hostReadme: readText(HOST_README),
  helpZh: readText(HELP_ZH),
  helpEn: readText(HELP_EN),
  indexJs: readText(INDEX_JS),
};
const REAL_SCHEMA = registeredTools();

function realInput(): FaceInput {
  return { schemaTools: REAL_SCHEMA, ...REAL_TEXT };
}

test("g-371 判据1：六处工具名集合逐一相等（root/host-zh/host-en 表 · help.zh/en · index.js 注册 · 引擎 schema），各恰 50", () => {
  const problems = toolFaceProblems(realInput());
  assert.deepEqual(problems, [], `工具面漂移：\n${problems.join("\n")}`);
});

test("g-371 判据1：README 工具计数声明（50）与引擎注册实数一致", () => {
  const problems = countClaimProblems(
    [
      { id: "README.md", text: REAL_TEXT.rootReadme },
      { id: "dsh-graph-host/README.md", text: REAL_TEXT.hostReadme },
    ],
    REAL_SCHEMA.length,
  );
  assert.deepEqual(problems, [], `工具计数声明漂移：\n${problems.join("\n")}`);
});

test("g-371 判据6（M2b）：README/help 的记忆上限数值声明必须等于真源 MEMORY_LIMITS", () => {
  const problems = memoryClaimProblems([
    { id: "README.md", text: REAL_TEXT.rootReadme },
    { id: "dsh-graph-host/README.md", text: REAL_TEXT.hostReadme },
    { id: "help.zh.md", text: REAL_TEXT.helpZh },
    { id: "help.en.md", text: REAL_TEXT.helpEn },
  ]);
  assert.deepEqual(problems, [], `记忆上限声明漂移：\n${problems.join("\n")}`);
});

// =====================================================================================
// 「改坏即红」负向对照（hermetic：只改内存副本）
// =====================================================================================

/** 删除指定章节内、含 `needle` 的第一个表格行（模拟复核者 M4 的「删一行」）。 */
function dropTableRow(text: string, heading: string, level: number, needle: string): string {
  const lines = text.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  assert.ok(headingIdx >= 0, `变异前提：找不到章节 ${heading}`);
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  const idx = lines.findIndex(
    (l, i) => i > headingIdx && i < end && l.trim().startsWith("|") && l.includes(needle),
  );
  assert.ok(idx >= 0, `变异前提：章节 ${heading} 内找不到含 ${needle} 的表格行`);
  return lines.filter((_, i) => i !== idx).join("\n");
}

function expectRed(problems: string[], re: RegExp, label: string): void {
  assert.ok(
    problems.some((p) => re.test(p)),
    `${label} 必红，实际判定：${JSON.stringify(problems)}`,
  );
}

test("g-371 判据2/6 负向对照：删表行 / 工具名改错字符 / 计数改错 / 假记忆上限 必红，合法重排不误红", () => {
  const base = realInput();
  assert.deepEqual(toolFaceProblems(base), [], "基线（真实文件）必须零问题");

  // ① 删 root README 表一行（单工具行「质量判据」）⇒ 49 ≠ 50
  const dropRoot = { ...base, rootReadme: dropTableRow(base.rootReadme, "## 提供的工具", 2, "`graph_set_criteria`") };
  assert.notEqual(dropRoot.rootReadme, base.rootReadme, "变异确实生效");
  expectRed(toolFaceProblems(dropRoot), /root README 工具表：缺少已注册工具 graph_set_criteria/, "删 root README 表一行");

  // ② 删 host README en 表一行（复核 M4 的原样复现：graph_abandon_attempt）
  const dropEn = {
    ...base,
    hostReadme: dropTableRow(base.hostReadme, "### Agent Tools Reference", 3, "`graph_abandon_attempt`"),
  };
  expectRed(toolFaceProblems(dropEn), /host README en 工具表：缺少已注册工具 graph_abandon_attempt/, "删 host README en 表一行");

  // ③ 工具名改错一个字符（root 表）⇒ 出现未注册名 + 缺注册名
  const typo = { ...base, rootReadme: base.rootReadme.replace("`graph_amend_goal`", "`graph_amend_goals`") };
  assert.notEqual(typo.rootReadme, base.rootReadme, "变异确实生效");
  const typoProblems = toolFaceProblems(typo);
  expectRed(typoProblems, /出现未注册的工具名 graph_amend_goals/, "工具名改错一个字符（多打 s）");
  expectRed(typoProblems, /缺少已注册工具 graph_amend_goal/, "工具名改错一个字符（原名缺失）");

  // ③′ 同类变异：host zh 表删一行 ⇒ 同样必红（三张表都在守卫内，非只守 root）
  const dropZh = {
    ...base,
    hostReadme: dropTableRow(base.hostReadme, "### Agent 工具速查表", 3, "`graph_set_goal_type`"),
  };
  expectRed(toolFaceProblems(dropZh), /host README zh 工具表：缺少已注册工具 graph_set_goal_type/, "删 host README zh 表一行");

  // ③″ 表内重复行必红
  const dup = {
    ...base,
    rootReadme: base.rootReadme.replace(
      "| 质量判据 | `graph_set_criteria` |",
      "| 质量判据 | `graph_set_criteria` |\n| 质量判据 | `graph_set_criteria` |",
    ),
  };
  expectRed(toolFaceProblems(dup), /root README 工具表：存在重复工具名 graph_set_criteria×2/, "表内重复行");

  // ④ 计数声明改错 ⇒ 必红（50 → 51）
  const badCount = { ...base, rootReadme: base.rootReadme.replace("50 个 `graph_*` 工具", "51 个 `graph_*` 工具") };
  const countProblems = countClaimProblems(
    [
      { id: "README.md", text: badCount.rootReadme },
      { id: "dsh-graph-host/README.md", text: badCount.hostReadme },
    ],
    base.schemaTools.length,
  );
  expectRed(countProblems, /README\.md:18 工具计数声明为 51/, "README 工具计数改错");

  // ④′ 计数声明被整段删除 ⇒ 守卫不得恒真退化
  const noCount = {
    ...base,
    rootReadme: base.rootReadme.replace(/50 个 `graph_\*` 工具/g, "全部 `graph_*` 工具"),
    hostReadme: base.hostReadme.replace(/50 个 `graph_\*` 工具/g, "全部 `graph_*` 工具").replace(/50 `graph_\*` tools/g, "all `graph_*` tools"),
  };
  expectRed(
    countClaimProblems(
      [
        { id: "README.md", text: noCount.rootReadme },
        { id: "dsh-graph-host/README.md", text: noCount.hostReadme },
      ],
      base.schemaTools.length,
    ),
    /找不到任何/,
    "工具计数声明全部删除",
  );

  // ⑤ M2b：追加「按需记忆每条硬上限 2000 字符」（错值，g339 只禁字面 500）⇒ 必红
  const wrongLimit = { ...base, rootReadme: `${base.rootReadme}\n- 按需记忆每条硬上限 2000 字符。\n` };
  expectRed(
    memoryClaimProblems([{ id: "README.md", text: wrongLimit.rootReadme }]),
    /记忆上限声明 2000 不在真源取值/,
    "M2b 假记忆上限（2000）",
  );
  // ⑤′ 写成真源取值（1000 / 200）不得误红
  const rightLimit = { ...base, rootReadme: `${base.rootReadme}\n- 按需记忆每条硬上限 1000 字符；常驻记忆 ≤ 200 字。\n` };
  assert.deepEqual(
    memoryClaimProblems([{ id: "README.md", text: rightLimit.rootReadme }]),
    [],
    "真源取值的记忆上限声明不得误红",
  );

  // ⑥ 合法改写不误红：表格行重排（名集合不变 ⇒ 顺序无关）
  const lines = base.rootReadme.split("\n");
  const first = lines.findIndex((l) => l.includes("`graph_set_criteria`"));
  const second = lines.findIndex((l) => l.includes("`graph_move_goal`"));
  [lines[first], lines[second]] = [lines[second], lines[first]];
  assert.deepEqual(toolFaceProblems({ ...base, rootReadme: lines.join("\n") }), [], "合法重排（名集合不变）不得误红");

  // hermetic：负向对照只改内存副本，真实仓库文件逐字未变
  assert.equal(readText(ROOT_README), base.rootReadme, "负向对照污染了真实 README.md");
  assert.equal(readText(HOST_README), base.hostReadme, "负向对照污染了真实 dsh-graph-host/README.md");
  assert.equal(readText(HELP_ZH), base.helpZh, "负向对照污染了真实 help.zh.md");
  assert.equal(readText(INDEX_JS), base.indexJs, "负向对照污染了真实 index.js");
});
