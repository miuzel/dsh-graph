// g-444：提示词与运行期文案「去本仓库特有假设」的防复发守卫。
//
// 口径（负责人 2026-10-08）：
//  · 源码注释可以有内部编号/内部路径（豁免）；**给用户 supervisor 的提示词**与**运行期文案**
//    不得假设能获取本仓库特有目录结构 / 脚本 / 分支模型 / 文件（含 `.dsh-graph` 内部文件名）。
//  · A) 资产扫描（仅模型可读面）：`dsh-graph-host/prompts/*.md`、
//    `dsh-graph-host/supervisor-guide.{zh,en}.md`，以及 `dsh-graph-host/lib/server-i18n.js` 的
//    **字符串值**（注释与键名不计——故本测试只取模块取值对象的 value，不做 JS 文本解析）。
//  · 显式豁免（各自都有正例与「豁免不过宽」的反例）：
//      ① 行内含「本项目示例 / 示例（本仓库）」(en: this repository example) 标记的行**允许**携带
//         本仓库命令/路径——只对 4 个「命令/路径」token 生效，不对分支名/文件类 token 生效；
//      ② `INDEX.md` 出现在否定语境（不再/已取消/非记忆真源…）时放行；肯定语境（必须维护）仍判红；
//      ③ `<!-- -->` HTML 注释与代码注释不计。
//  · B) 行为断言：HANDOFF 只留 skill 名、上限文案不写死版本/槽位、attempt 骨架无 npm 生态词、zh/en 同步。
//  · 负向对照：人为把任一 token 塞回资产文本 / 把合法豁免行写成肯定语境 ⇒ 必红。
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

type Rule = {
  id: string;
  pattern: RegExp;
  why: string;
  /** 允许被「本项目示例」标记豁免（仅命令/路径类 token）。 */
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
];

/** 「本项目示例」标记（zh/en 对称；en 是本仓库命令示例的英文等价标注）。 */
const EXAMPLE_MARKER = /本项目示例|示例（本仓库）|this repository example|example \(this repository\)/;
/** `INDEX.md` 的否定语境（不再要求 / 已取消 / 非记忆真源 …）。 */
const NEGATION_CONTEXT = /不再|已取消|非记忆真源|无需维护|不要求维护|no longer|not the memory source of truth|no index file needs to be maintained/;

/** `<!-- -->` 注释整体不计（按字符替换为空格以保留行号）。 */
function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** 逐行扫描一段模型可读文本，返回违规列表（空 = 合规）。真实资产与合成夹具共用同一实现。 */
function scanText(label: string, text: string): string[] {
  const out: string[] = [];
  stripHtmlComments(text).split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      if (rule.exampleExempt && EXAMPLE_MARKER.test(line)) continue;
      if (rule.negationExempt && NEGATION_CONTEXT.test(line)) continue;
      out.push(`${label}:${index + 1} [${rule.id}] ${rule.why}：${line.trim().slice(0, 140)}`);
    }
  });
  return out;
}

/** 只取 i18n 字典的**字符串值**（注释与键名天然不入扫描面）。 */
function scanI18n(label: string, dict: { zh: Record<string, unknown>; en: Record<string, unknown> }): string[] {
  const out: string[] = [];
  for (const [lang, entries] of [["zh", dict.zh], ["en", dict.en]] as const) {
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value !== "string") continue;
      out.push(...scanText(`${label} ${lang}:${key}`, value));
    }
  }
  return out;
}

/** 收集源码与投递副本两侧的 markdown 资产。 */
function markdownAssets(): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  for (const [label, dir] of [["源", HOST], ["dist", DIST]] as const) {
    const promptsDir = join(dir, "prompts");
    for (const name of readdirSync(promptsDir).filter((n) => n.endsWith(".md")).sort()) {
      out.push({ label: `${label}/prompts/${name}`, text: readFileSync(join(promptsDir, name), "utf8") });
    }
    for (const name of ["supervisor-guide.zh.md", "supervisor-guide.en.md"]) {
      out.push({ label: `${label}/${name}`, text: readFileSync(join(dir, name), "utf8") });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A. 资产扫描（真实资产 0 命中）
// ---------------------------------------------------------------------------

test("g-444 判据3：模型可读资产（源码 + dist 投递副本）不含本仓库特有路径/命令/文件", () => {
  const assets = markdownAssets();
  const violations: string[] = [];
  let scannedLines = 0;
  for (const asset of assets) {
    violations.push(...scanText(asset.label, asset.text));
    scannedLines += asset.text.split("\n").length;
  }
  // 非恒真护栏：资产必须真被读到、且确实扫到了足量文本，否则「零违规」可能只是空扫。
  assert.equal(assets.length, 32, `应扫到 14 个 prompts × 2 侧 + 2 份指南 × 2 侧（实得 ${assets.length}）`);
  assert.ok(scannedLines > 1000, `扫描行数过少（${scannedLines}），结果不可信`);
  assert.deepEqual(violations, [], `资产命中禁用 token（应 0 命中）：\n${violations.join("\n")}`);
});

test("g-444 判据3：server-i18n 两侧的字符串值不含本仓库特有路径/命令/文件", async () => {
  const violations: string[] = [];
  let values = 0;
  for (const [label, url] of [
    ["源", pathToFileURL(join(HOST, "lib", "server-i18n.js")).href],
    ["dist", pathToFileURL(join(DIST, "lib", "server-i18n.js")).href],
  ] as const) {
    const mod = await import(url) as { SERVER_I18N: { zh: Record<string, unknown>; en: Record<string, unknown> } };
    values += Object.keys(mod.SERVER_I18N.zh).length + Object.keys(mod.SERVER_I18N.en).length;
    violations.push(...scanI18n(label, mod.SERVER_I18N));
  }
  assert.ok(values > 100, `i18n 取值条数过少（${values}），结果不可信`);
  assert.deepEqual(violations, [], `server-i18n 字符串值命中禁用 token（应 0 命中）：\n${violations.join("\n")}`);
});

// ---------------------------------------------------------------------------
// 豁免正例 + 「豁免不过宽」反例
// ---------------------------------------------------------------------------

test("g-444 豁免正例①：带「本项目示例」标记的行允许携带本仓库命令，去掉标记即判红", () => {
  const marked = [
    "  1. 全量测试：项目配置的测试命令（本项目示例：`node --test core/tests/*.test.ts`）→ exit_code=0；",
    "  2. 类型检查：项目配置的类型检查命令（本项目示例：`tsc --noEmit -p tsconfig.json`）→ exit_code=0；",
    "  - 归档脚本（本项目示例：`scripts/archived/x.sh`）由项目自行显式执行；",
    "  1. Full tests: configured project test command (this repository example: `node --test core/tests/*.test.ts`);",
  ].join("\n");
  assert.deepEqual(scanText("fixture", marked), [], "带标记的示例行不应判红");

  const unmarked = marked.replace(/本项目示例：|this repository example: /g, "");
  const hits = scanText("fixture", unmarked);
  assert.equal(hits.length, 4, `去掉「本项目示例」标记后每行都必须判红（实得 ${hits.length}）`);

  // 豁免只覆盖「命令/路径」类 token：分支名与内部文件名即使带标记也仍判红。
  const overBroad = scanText("fixture", "本项目示例：<version>-test / prepareAttemptWorktree / g-125-att-03");
  assert.deepEqual(overBroad.map((v) => v.match(/\[([a-z-]+)\]/)?.[1]), [
    "repo-integration-branch", "internal-fn-name", "real-attempt-id",
  ], "「本项目示例」不得豁免分支名/内部函数名/真实编号");
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

test("g-444 豁免正例③：HTML 注释与代码注释不计，同类文本出现在正文/字符串值仍判红", async () => {
  // md：`<!-- -->` 整段不计（含跨行注释）。
  assert.deepEqual(scanText("fixture", "正文安全。\n<!-- node --test core/tests 与 dsh-graph-host/ 在注释里 -->\n<!--\n多行注释：prepareAttemptWorktree\n-->"), []);
  assert.equal(scanText("fixture", "正文泄露：node --test core/tests").length, 1, "正文同类文本必须判红");

  // js：扫描面只取字符串值 ⇒ 注释天然不计；字符串值仍逐条判红（含 zh/en 两侧）。
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g444-js-"));
  const file = join(dir, "fixture-i18n.mjs");
  writeFileSync(
    file,
    [
      "// 注释里出现 dsh-graph-host/ 与 node --test core/tests，不应计入扫描面",
      "/* 块注释：prepareAttemptWorktree */",
      'export const SERVER_I18N = Object.freeze({ zh: { clean: "安全值", dirty: "泄露 prepareAttemptWorktree" }, en: { clean: "safe", dirty: "leaks prepareAttemptWorktree" } });',
    ].join("\n"),
  );
  const mod = await import(pathToFileURL(file).href) as { SERVER_I18N: { zh: Record<string, unknown>; en: Record<string, unknown> } };
  const hits = scanI18n("fixture", mod.SERVER_I18N);
  assert.equal(hits.length, 2, `仅 zh.dirty / en.dirty 应判红（实得 ${hits.length}）`);
  assert.ok(hits.every((v) => v.includes("[internal-fn-name]")), hits.join("\n"));
});

test("g-444 负向对照：把任一 token 塞回资产文本，扫描器必须判红", () => {
  for (const rule of RULES) {
    const sample: Record<string, string> = {
      "repo-package-path": "包目录 dsh-graph-host/ 下不要跑工具",
      "archived-script": "迁移用 scripts/archived/migrate.sh --apply",
      "repo-test-cmd": "全量测试：node --test core/tests/*.test.ts",
      "repo-typecheck-cmd": "类型检查：tsc --noEmit -p tsconfig.json",
      "repo-integration-branch": "合并到 <version>-test 分支",
      "internal-fn-name": "由 prepareAttemptWorktree 预建工作树",
      "real-attempt-id": "命名如 g-125-att-03",
      "memory-index-file": "必须维护 INDEX.md 索引表",
      "hardcoded-dsh-version": "DSH 0.1.6 起默认最多 8 个",
    };
    const hits = scanText("fixture", sample[rule.id]);
    assert.equal(hits.length, 1, `注入 token 后应恰好 1 条违规：${rule.id} → ${JSON.stringify(hits)}`);
    assert.ok(hits[0].includes(`[${rule.id}]`), hits[0]);
  }
  // 反向护栏：干净文本零命中，证明上面的判红不是「永远报红」。
  assert.deepEqual(scanText("fixture", "插件包目录、项目自有迁移脚本、项目约定的集成分支。"), []);
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

test("g-444 B②：子代理上限文案不写死版本号与槽位数，实际上限来自错误对象", () => {
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
  // 上限只在错误对象真的给出时透出，且 details 数值字段优先于引擎消息文本。
  assert.match(subagentSpawnErrorText({ code: "ACTIVATION_LIMIT_REACHED", message: "x", details: { limit: 5 } }), /当前上限 5 个/);
  assert.match(
    subagentSpawnErrorText({ code: "ACTIVATION_LIMIT_REACHED", message: "subagent limit reached (active child limit: 8)", details: { maxActiveSubagents: 3 } }),
    /当前上限 3 个/,
  );
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
  assert.equal(
    zh.split("\n").filter((l) => EXAMPLE_MARKER.test(l)).length,
    en.split("\n").filter((l) => EXAMPLE_MARKER.test(l)).length,
    "「本项目示例」标记行 zh/en 必须成对",
  );
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
    // 正向：不得再有「存在/必读/必维护索引文件」的要求。
    assert.doesNotMatch(text, /INDEX\.md/, `${side} 仍提到 INDEX.md`);
    assert.doesNotMatch(text, /务必先阅读[^。\n]*索引|必须同步更新[^。\n]*索引/, `${side} 仍有「必读/必维护索引」要求`);
    assert.doesNotMatch(text, /always read[^.\n]*index|must also update[^.\n]*index (table|file)/i, `${side} 仍有「必读/必维护索引」要求`);
    // 反向：必须显式声明「结构化记忆为真源、不要求维护索引文件」（避免只删不立）。
    if (side === "zh") {
      assert.match(text, /结构化记忆为唯一真源/);
      assert.match(text, /不是记忆真源，也不要求维护任何索引文件/);
    } else {
      assert.match(text, /structured memory as the single source of truth/);
      assert.match(text, /not the memory source of truth, and no index file needs to be maintained/);
    }
  }
});
