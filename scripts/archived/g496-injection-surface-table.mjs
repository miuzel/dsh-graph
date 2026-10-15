#!/usr/bin/env node
/**
 * g-496 att-012 证据生成器：**最终注入面 / 资产字节对照表**。
 *
 * 覆盖当前全部资产：公共层 36 份（18 基名 × zh/en）+ 宿主专属层 18 份（9 基名 × zh/en）= 54 份。
 * 每行记录：资产名 | 层归属 | 字节数 | 行数 | 占位符方言与变量集 | 注入面 | 消费点 | 是否第二副本。
 *
 * 只读：不构建、不写盘（除 stdout）。主树/工作树通用。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const PUBLIC_DIR = join(root, "prompts");
const HOST_DIR = join(root, "dsh-graph-host/prompts");
const CORE_SRC = join(root, "core/ops.ts");
const HOST_SRC = join(root, "dsh-graph-host/index.js");
const CLIENT_DIR = join(root, "dsh-graph-host/lib/client");

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const core = read(CORE_SRC);
const host = read(HOST_SRC);
const clientSrc = existsSync(CLIENT_DIR)
  ? readdirSync(CLIENT_DIR).filter((f) => f.endsWith(".js")).map((f) => read(join(CLIENT_DIR, f))).join("\n")
  : "";
const allSrc = `${core}\n${host}\n${clientSrc}`;

/** 注入面分类（与 g-496 判据一致：①逐轮常量 ②按需 skill/工具返回 ③派发时门控）。 */
const SURFACE = {
  "discipline": "① 逐轮常量（gated: supervisorId===sessionId）",
  "guide-hint": "① 逐轮常量（全会话）",
  "supervisor-guide": "② 按需 skill（dsh-graph-supervisor）",
  "usage": "② 按需 工具返回（graph_help）",
  "worktree": "② 按需 工具返回（minor-task 指引）",
  "minor-task": "② 按需 工具返回（minor-task 指引）",
  "no-isolation": "② 按需 工具返回（isolate=false 指引）",
  "help": "② 按需（help 路由 + GUI 只读资产路由）",
  "agent-teams-contract": "③ 派发时（gated: supervisor.agent_teams===true）",
  "attempt-instructions": "③ 派发时（attempt 提示词骨架，短语 marker）",
  "executor-discipline": "③ 派发时（纪律条目正文）",
  "attempt-report-skeleton": "③ 派发时（results 报告骨架）",
  "subagent-mode": "③ 派发时（模式策略段）",
  "collect-task": "③ 派发时（formatCollectPrompt）+ GUI 预览（同源）",
  "summary-task": "③ 派发时（formatSummaryPrompt）",
  "pm-task": "③ 派发时（formatPmPrompt）",
  "review-task": "③ 派发时（formatReviewPrompt）",
  "automation-guidance": "② 按需（自动化配置指引）",
};
/** 宿主专属层 9 类 GUI 模板：全部是**GUI 动作的剪贴板/派发载荷**（用户点按钮时取一次，非自动注入）。 */
const SURFACE_GUI = "④ GUI 动作载荷（用户触发取一次，只读资产路由）";

const rows = [];
function scan(dir, ownership) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const text = readFileSync(join(dir, name), "utf8");
    const buf = readFileSync(join(dir, name));
    const base = name.replace(/\.(zh|en)\.md$/, "");
    const lang = name.match(/\.(zh|en)\.md$/)?.[1] ?? "?";
    // 方言：公共层 `{{name}}`；宿主 GUI `{name}`。
    const dbl = [...text.matchAll(/\{\{([A-Za-z0-9_.-]+)\}\}/g)].map((m) => m[1]);
    const sgl = [...text.matchAll(/(?<!\{)\{([A-Za-z0-9_]+)\}(?!\})/g)].map((m) => m[1]);
    const vars = dbl.length ? [...new Set(dbl)].sort() : [...new Set(sgl)].sort();
    const dialect = dbl.length ? "{{name}}" : (sgl.length ? "{name}" : "—（无变量）");
    // 消费点：源码中是否出现该基名（引号包裹）。
    const consumers = [];
    if (new RegExp(`(?:readCorePromptAsset|readPromptAsset|loadGuiPromptAsset|renderGuiPrompt)\\(["'\`]${base}["'\`]`).test(allSrc)) consumers.push("显式读取");
    if (allSrc.includes(`"${base}"`) || allSrc.includes(`'${base}'`)) consumers.push("按名引用");
    rows.push({
      name, base, lang, ownership, bytes: buf.length, lines: text.split("\n").length,
      sha256: createHash("sha256").update(buf).digest("hex").slice(0, 12),
      dialect, vars, surface: ownership === "host" ? SURFACE_GUI : (SURFACE[base] ?? "（未分类，需登记）"),
      consumers: consumers.length ? [...new Set(consumers)].join("+") : "（间接/资产内 marker）",
    });
  }
}
scan(PUBLIC_DIR, "public");
scan(HOST_DIR, "host");

const groups = { public: rows.filter((r) => r.ownership === "public"), host: rows.filter((r) => r.ownership === "host") };
console.log(`# 注入面 / 资产字节对照表（g-496 att-012）\n`);
console.log(`资产总数 ${rows.length}（公共层 ${groups.public.length} + 宿主专属层 ${groups.host.length}）`);
console.log(`总字节 ${rows.reduce((s, r) => s + r.bytes, 0)}\n`);
for (const [label, list] of [["公共层 prompts/", groups.public], ["宿主专属层 dsh-graph-host/prompts/", groups.host]]) {
  console.log(`\n## ${label}（${list.length} 份）\n`);
  console.log("| 资产 | 字节 | 行 | sha256 | 方言 | 变量 | 注入面 | 消费点 |");
  console.log("| --- | ---: | ---: | --- | --- | --- | --- | --- |");
  for (const r of list) {
    console.log(`| \`${r.name}\` | ${r.bytes} | ${r.lines} | \`${r.sha256}\` | ${r.dialect} | ${r.vars.length ? r.vars.map((v) => `\`${v}\``).join(" ") : "—"} | ${r.surface} | ${r.consumers} |`);
  }
  const bytes = list.reduce((s, r) => s + r.bytes, 0);
  console.log(`\n小计：${list.length} 份 / ${bytes} 字节；最大 ${Math.max(...list.map((r) => r.bytes))} / 最小 ${Math.min(...list.map((r) => r.bytes))}`);
}
// 未分类告警（fail-closed：新增资产必须登记注入面）。
const unclassified = rows.filter((r) => r.surface.startsWith("（未分类"));
if (unclassified.length) console.log(`\n⚠️ 未登记注入面的资产 ${unclassified.length} 份：${unclassified.map((r) => r.name).join(", ")}`);
