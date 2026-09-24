/**
 * g-347 守护：`graph_help` 帮助资产（`dsh-graph-host/prompts/help.{zh,en}.md`）必须与引擎 tool schema 对齐。
 *
 * 为什么需要：`graph_help` 是主管会话的**首要工具速查**，而该资产此前**零测试覆盖**。
 * 引擎在 g-311（fast_track/machine_report）、g-329 等目标里加了参数，帮助文本没跟，
 * 主管据此误判「没有机器快速放行通道」——属「文档落后于引擎」的静默失效。
 * 本套件把「帮助资产 = 引擎 schema 的投影」变成机器断言：引擎加参数/加工具而帮助没跟 → 必红。
 *
 * 断言面（真源固定为 `apply()` 实际注册的 tool def，不硬编码 44 名单）：
 *  A. 工具集合：schema 44 个 graph_* 工具与 zh/en 两份帮助的条目**逐一相等**（不缺、不多、不重复），
 *     且两份帮助的条目**顺序一致**、文件头的计数声明与 schema 实数一致；
 *  B. 参数面：每个工具帮助行必须提及该工具 schema 的**全部**参数名（zh/en 双向）；
 *  C. 关键参数钉在同一物理行：`fast_track`/`machine_report` 在 `graph_resolve_accept` 行、
 *     `legacy` 在 `graph_unbind_goal_child` 行；
 *  D. 端到端：`graph_help` 的 run() 返回值（zh）与源资产逐字一致，且 dist 副本与源逐字一致；
 *  E. 加载机制：在 tmp 私有镜像里改资产 → 同一模块实例再次 run() 立即反映新内容
 *     ⇒ 证明 `graph_help` 是**每次调用读取**（`readFileSync`）而非启动缓存，build 后无需重启宿主。
 *
 * 负向对照（「改坏即红」）不在本文件内做——套件全部只读仓库；实证记录见 g-347 交付说明
 * （在 flock 内改私有副本/临时改源文件后运行本套件，观察到 A/B/C 断言变红）。
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

/** 解析帮助资产：只认 `- graph_xxx(` 开头的条目行（章节/散文不算条目）。 */
function parseHelp(text: string): HelpEntry[] {
  const out: HelpEntry[] = [];
  text.split("\n").forEach((line, i) => {
    const m = line.match(/^- (graph_[a-z0-9_]+)\s*\(/);
    if (m) out.push({ name: m[1], line, lineNo: i + 1 });
  });
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
  const schemaNames = defs.map((d) => d.name);
  for (const lang of ["zh", "en"] as const) {
    const names = help[lang].entries.map((e) => e.name);
    assert.equal(names.length, 44, `help.${lang}.md 条目数应为 44，实际 ${names.length}`);
    assert.equal(new Set(names).size, names.length, `help.${lang}.md 存在重复条目`);
    assert.deepEqual([...names].sort(), [...schemaNames].sort(), `help.${lang}.md 与 schema 工具集合不一致`);
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

test("A3 文件头声明的工具计数与 schema 实数一致", () => {
  const mZh = help.zh.text.match(/共\s*(\d+)\s*个/);
  const mEn = help.en.text.match(/(\d+)\s*total/);
  assert.ok(mZh, "help.zh.md 缺少「共 N 个」计数声明");
  assert.ok(mEn, "help.en.md 缺少「N total」计数声明");
  assert.equal(Number(mZh![1]), defs.length, "help.zh.md 计数声明与 schema 实数不一致");
  assert.equal(Number(mEn![1]), defs.length, "help.en.md 计数声明与 schema 实数不一致");
});

test("B 每个工具的签名行（括号内）列出该工具 schema 的全部参数名（zh/en）", () => {
  const problems: string[] = [];
  for (const lang of ["zh", "en"] as const) {
    for (const entry of help[lang].entries) {
      const def = defByName.get(entry.name);
      assert.ok(def, `help.${lang}.md 条目 ${entry.name} 不在引擎 schema 中`);
      const sig = signatureOf(entry.line);
      const missing = def!.params.filter((p) => !new RegExp(`\\b${p}\\b`).test(sig));
      if (missing.length) {
        problems.push(`help.${lang}.md:${entry.lineNo} ${entry.name} 签名缺参数: ${missing.join(", ")}`);
      }
      // 签名出现但 schema 没有的「疑似多余参数」（括号后的散文不计）
      const noise = (sig.match(/\b[a-z][a-z0-9_]*\b/g) ?? []).filter((t) => !def!.params.includes(t));
      const unexpected = [...new Set(noise)];
      if (unexpected.length) {
        problems.push(`help.${lang}.md:${entry.lineNo} ${entry.name} 签名含 schema 外 token: ${unexpected.join(", ")}`);
      }
    }
  }
  assert.deepEqual(problems, [], `帮助资产与引擎 schema 不一致：\n${problems.join("\n")}`);
});

test("C 关键参数钉在对应工具行的同一行", () => {
  const lineOf = (lang: "zh" | "en", name: string) => help[lang].entries.find((e) => e.name === name)!.line;
  for (const lang of ["zh", "en"] as const) {
    const resolve = lineOf(lang, "graph_resolve_accept");
    assert.match(resolve, /\bfast_track\b/, `help.${lang}.md graph_resolve_accept 行缺 fast_track`);
    assert.match(resolve, /\bmachine_report\b/, `help.${lang}.md graph_resolve_accept 行缺 machine_report`);
    const unbind = lineOf(lang, "graph_unbind_goal_child");
    assert.match(unbind, /\blegacy\b/, `help.${lang}.md graph_unbind_goal_child 行缺 legacy`);
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
