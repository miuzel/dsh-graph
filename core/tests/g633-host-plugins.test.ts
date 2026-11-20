/**
 * g-633：外部宿主插件定义（`plugins/{claude-code,codex,opencode}`）的**守卫套件**。
 *
 * 负责人裁决（2026-11-17）：维持 5 个 npm 包，但不同宿主的插件定义**分别编写**，由插件引用能力，
 * 而不是复制产品代码。本套件钉住七件事，任一退化即变红：
 *
 * ① **三宿主各有独立定义目录**，清单能被各自宿主识别（Claude Code 由实测 `claude plugin validate`
 *    在交付记录中背书；本套件只做结构/字段级断言，不假装跑宿主 CLI）。
 * ② **引用而非复制**：插件目录只含 清单/配置/文档/技能正文/LICENSE，**不得**出现产品代码
 *    （`*.ts` / `core/` / `dist/` / `index.js` / `lib/client.js`）或 `node_modules`。
 * ③ **token 绝不进配置**：所有插件配置文件里**不得**出现看起来像真实 token 的字面量；必须只写
 *    各宿主的原生变量引用（Claude `${VAR}` / Codex `bearer_token_env_var` / OpenCode `{env:VAR}`）。
 * ④ **技能正文不引用 MCP 未提供的工具**：外部宿主版技能正文里出现的每个 `graph_*` 工具名，
 *    都必须真实存在于「只读 11 + 写模式 27 = 38」的可达集合内；Human Gate 工具只允许以
 *    「不可用」的口径出现（不得写成可调用示例）。
 * ⑤ **技能正文与 MCP 能力一致**：正文必须明确「默认只读」「`--allow-write` 才可写」
 *    与「Human Gate 不可达」，且只读/写模式的工具名集合与 core 真源逐项一致。
 * ⑥ **每份定义都有安装指南**：一条命令安装、前置、最小验证、卸载、排障五段齐备。
 * ⑦ **Codex 与 OpenCode 的 MCP 认证写法与宿主运行时实测语义一致**：Codex 必须用
 *    `bearer_token_env_var`（受控探针实测：服务端收到 `Authorization: Bearer <token>`）；
 *    而 `env_http_headers` / `headers` **在插件路径运行时被丢弃**（服务端收到 `undefined`）⇒ 出现即判红。
 *    OpenCode 用 `mcp.servers` + `{env:VAR}`。
 *
 * ⑦ 的口径来自**运行时探针**，不是静态回显：`codex mcp get` 对 `env_http_headers` 照样显示"已配置"，
 * 但它实际不发认证头 —— 把静态回显当证据正是这条守卫最初钉错的原因。
 *
 * 真源一律从 core 导入（`READ_ONLY_COMMAND_NAMES` / `WRITE_MODE_COMMAND_NAMES` /
 * `HUMAN_GATE_TOOLS`），不在这里手写第二份工具名单 ⇒ 将来 core 增减工具时本套件自动跟随，
 * 技能正文若不跟着更新就会红。
 *
 * ── 能力边界（**必读**，att-008 主管裁决固化；请勿再试图用文本守卫穷尽它）────────────────
 *
 * > 本守卫保证「登记表声明的未验证结论在**结论列**与**证据列**存在且未被否定」，
 * > **不保证**「文档任何位置都没有自相矛盾的肯定式表述」——后者无法用文本守卫穷尽，
 * > 依赖评审与 `scripts/g633-opencode-mcp-probe.mjs` 实测。
 *
 * 具体地：
 *   · **保证**（结构性、可穷尽，已钉死）：
 *       §8 表格每行恰好 3 列（项 | 状态 | 证据）；`\|` 是转义字面竖线、不分列；
 *       每条登记锚点的**结论列**讲这条结论、**证据列**命中「未证实」语义且不含无条件肯定断言；
 *       顶部 ⇄ §8 ⇄ 登记表三方逐条对应。
 *   · **不保证**（本轮**明确不追**，`⑧b-e1` 把这条漏放固化下来）：
 *       表格**之外**的段落写「已在本地跑通」「按目录放置即可生效」这类肯定式小结 ——
 *       那是**整篇自然语言**的性质，词表打地鼠，每轮都能构造新措辞。守卫已达约 2k 行 / 48 用例，
 *       真实防线是**探针实测**与人工评审，不是再补一条正则。
 *
 * 因此：**当评审再构造出表格外措辞逃逸时，正确处置是记录为已知边界 + 用探针实测，而不是继续加词表。**
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
// `relative` / `resolve` / `sep` / `mkdirSync` / `symlinkSync` **只**供 ⑨d 的「旧守卫」复刻体使用，
// 生产判定路径（serveRootProblems）一律委托 service 真源，不得再出现自造路径语义（⑨c 源码级断言钉住）。
import { isAbsolute, join, relative as legacyRelative, resolve as legacyResolve, sep as legacySep } from "node:path";

import { READ_ONLY_COMMAND_NAMES } from "../service/queries.ts";
// ⑨：**只**引用 service 真源 —— 本守卫不复制任何路径语义（att-007 起连布尔判定也一并委托）
import { ServiceConfigError, assertSeparatedRoots } from "../service/config.ts";
import {
  HUMAN_GATE_TOOLS,
  WRITE_MODE_COMMAND_NAMES,
  WRITE_MODE_TRANSITION_TARGETS,
} from "../service/write-commands.ts";

const repoRoot = join(import.meta.dirname, "../..");
const pluginsRoot = join(repoRoot, "plugins");
const HOSTS = ["claude-code", "codex", "opencode"] as const;

const REACHABLE = new Set<string>([...READ_ONLY_COMMAND_NAMES, ...WRITE_MODE_COMMAND_NAMES]);
const GATE_NAMES = Object.keys(HUMAN_GATE_TOOLS);

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function readJson(rel: string): any {
  return JSON.parse(read(rel));
}

/** 递归列出插件目录下所有文件的仓库相对路径（不跟进符号链接）。 */
function walk(rel: string): string[] {
  const abs = join(repoRoot, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(childRel));
    else if (entry.isFile()) out.push(childRel);
  }
  return out.sort();
}

/** 插件目录里允许出现的文件名/目录名（其余一律视为产品代码副本）。 */
function isAllowedPluginFile(rel: string): boolean {
  const base = rel.split("/").pop() as string;
  if (base === "LICENSE" || base === "README.md" || base === "INSTALL.md" || base === "SKILL.md") return true;
  if (base === "plugin.json" || base === "marketplace.json" || base === ".mcp.json" || base === "opencode.json") return true;
  return false;
}

/** 危险信号：Bearer 后面直接跟 24+ 位非占位字面量（真实 token 的典型形态）。 */
const TOKEN_LITERAL = /Bearer\s+(?!\$\{|\{env:)[A-Za-z0-9._~+/=-]{24,}/;
/** 任何 24+ 位的 hex/base64 风格长串出现在配置文件里都算可疑（变量名/URL 不会这么长且随机）。 */
const LONG_SECRET_LIKE = /["'\s=:]([A-Za-z0-9._~+/=-]{32,})["'\s]/;

function tokenLiteralProblems(rel: string, text: string): string[] {
  const problems: string[] = [];
  if (TOKEN_LITERAL.test(text)) problems.push(`${rel}: 含 Bearer + 长字面量（疑似真实 token）`);
  const m = LONG_SECRET_LIKE.exec(text);
  // URL/仓库地址/许可证文本里的长串不算秘密；只对配置文件的”看起来像凭据”的串报警，
  // 且排除明显是 URL/路径/描述的形态。
  if (m && !/^https?:|^\/|^\.\.?\//.test(m[1]) && !rel.endsWith(".md") && !rel.endsWith("LICENSE")) {
    problems.push(`${rel}: 含 32+ 位疑似秘密字面量 ${m[1].slice(0, 8)}…`);
  }
  return problems;
}

/** 从技能正文里抽取所有以 graph_ 开头的工具名（反引号或裸词均可）。 */
function skillToolNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/\bgraph_[a-z_]+[a-z]\b/g)) names.add(m[0]);
  return [...names].sort();
}

/**
 * 正文里把 Human Gate 工具写成"可调用示例"的特征。
 *
 * 判定口径（避免误伤合法的「这是保留项/不可用」叙述）：
 *   - 同一行出现否定/保留措辞（不可达 / 不可用 / 保留 / 必须由人 / 做不到 …）⇒ 允许；
 *   - 出现在「4. 外部宿主做不到的事」这类明确标注不可用的表格里 ⇒ 允许（表格首列是工具名、
 *     第二列是原因，读者一眼看到的是"不可用"）；
 *   - 其余场合把 `graph_xxx(` 之类**调用形态**写出来 ⇒ 判红（这才真的会误导模型去调）。
 */
function gateMisuseProblems(rel: string, text: string): string[] {
  const problems: string[] = [];
  const NEGATION =
    /不可达|不可用|做不到|保留项|不能|拒绝|不可|必须由人|由人裁决|人工裁决|请用户|仅限本地|fail-closed|不开放|也不开放|未注册|不会被|没有提供/i;
  // 「人工裁决保留项」小节（标题含"做不到"或"人工裁决保留"）内的表格行一律视作不可用口径
  let inGateSection = false;
  // 代码围栏里的内容一律按"可调用示例"看待：围栏里出现保留工具名就是误导
  let inFence = false;
  for (const raw of text.split("\n")) {
    const line = raw;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      for (const gate of GATE_NAMES) {
        if (line.includes(gate)) {
          problems.push(`${rel}: 代码块里把人工裁决保留工具 ${gate} 当成可调用示例：${line.trim().slice(0, 80)}`);
        }
      }
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      inGateSection = /做不到|人工裁决保留|Human Gate/i.test(line);
      continue;
    }
    for (const gate of GATE_NAMES) {
      if (!line.includes(gate)) continue;
      if (NEGATION.test(line)) continue;
      if (inGateSection) continue;
      // 只把"看起来像可调用"的形态算作误用（有代码围栏/调用括号/示例参数），
      // 纯清单式点名（如"写模式下仍 fail-closed 的是 A、B、C"）不算。
      if (!/`/.test(line) && !/\(/.test(line)) continue;
      problems.push(`${rel}: 把人工裁决保留工具 ${gate} 写成可用口径：${line.trim().slice(0, 80)}`);
    }
  }
  return problems;
}

// ── ① 三宿主目录与清单 ────────────────────────────────────────────────────────

test("g-633 ① 三宿主各有独立插件定义目录，清单字段齐全", () => {
  const problems: string[] = [];
  for (const host of HOSTS) {
    const dir = `plugins/${host}`;
    if (!existsSync(join(repoRoot, dir))) {
      problems.push(`${dir}: 目录缺失`);
      continue;
    }
    for (const required of ["INSTALL.md", "README.md", "LICENSE", "skills/goal-graph/SKILL.md"]) {
      if (!existsSync(join(repoRoot, dir, required))) problems.push(`${dir}: 缺少 ${required}`);
    }
  }

  // Claude Code：plugin.json + marketplace.json
  const ccPlugin = readJson("plugins/claude-code/.claude-plugin/plugin.json");
  if (ccPlugin.name !== "goal-graph") problems.push("claude-code plugin.json: name 必须是 goal-graph");
  for (const key of ["name", "version", "description", "author", "license"]) {
    if (!ccPlugin[key]) problems.push(`claude-code plugin.json: 缺少 ${key}`);
  }
  if (ccPlugin.mcpServers !== "./.mcp.json") problems.push("claude-code plugin.json: mcpServers 必须指向 ./.mcp.json");
  const ccMarket = readJson("plugins/claude-code/.claude-plugin/marketplace.json");
  if (ccMarket.name !== "goal-graph") problems.push("claude-code marketplace.json: name 必须是 goal-graph");
  if (!ccMarket.owner?.name) problems.push("claude-code marketplace.json: 缺 owner.name（claude validate 会报 error）");
  if (!Array.isArray(ccMarket.plugins) || ccMarket.plugins.length !== 1) {
    problems.push("claude-code marketplace.json: 必须恰好列出 1 个插件");
  } else if (ccMarket.plugins[0].name !== "goal-graph") {
    problems.push("claude-code marketplace.json: 插件名必须是 goal-graph");
  }

  // Codex：同形状清单 + bearer_token_env_var 的 .mcp.json
  const cxPlugin = readJson("plugins/codex/.claude-plugin/plugin.json");
  const cxMarket = readJson("plugins/codex/.claude-plugin/marketplace.json");
  if (cxPlugin.name !== "goal-graph") problems.push("codex plugin.json: name 必须是 goal-graph");
  if (cxMarket.name !== "goal-graph") problems.push("codex marketplace.json: name 必须是 goal-graph");
  if (!cxMarket.owner?.name) problems.push("codex marketplace.json: 缺 owner.name");
  if (cxMarket.plugins?.[0]?.name !== "goal-graph") problems.push("codex marketplace.json: 插件名必须是 goal-graph");

  // OpenCode：opencode.json（mcp.servers）
  const oc = readJson("plugins/opencode/opencode.json");
  if (!oc.mcp?.servers?.["goal-graph"]) problems.push("opencode.json: 缺 mcp.servers.goal-graph");

  assert.deepEqual(problems, []);
});

// ── ② 引用而非复制：无产品代码、无 dist、无 node_modules ─────────────────────────

test("g-633 ② 插件目录只含清单/配置/文档/技能/Licence，无产品代码副本与 dist 产物", () => {
  const problems: string[] = [];
  let total = 0;
  for (const host of HOSTS) {
    const files = walk(`plugins/${host}`);
    if (files.length === 0) problems.push(`plugins/${host}: 没有任何文件`);
    for (const rel of files) {
      total += 1;
      if (!isAllowedPluginFile(rel)) problems.push(`${rel}: 不属于允许的清单/配置/文档/技能文件`);
      if (/\.(ts|tsx|mjs|cjs|js|map)$/.test(rel)) problems.push(`${rel}: 插件不得携带代码文件`);
      if (rel.includes("node_modules") || rel.split("/").includes("dist")) problems.push(`${rel}: 插件不得携带 dist/node_modules`);
    }
  }
  if (total === 0) problems.push("插件目录整体为空（不可能通过）");
  assert.deepEqual(problems, []);
});

// ── ③ 零配置 stdio 且无任何 token 字面量 ─────────────────────────────────────

test("g-633 ③ 插件配置采用零配置 stdio，无 token 字面量、无硬编码端口 7788", () => {
  const problems: string[] = [];

  // Claude Code：零配置 stdio
  const ccMcp = readJson("plugins/claude-code/.mcp.json");
  const ccServer = ccMcp.mcpServers?.["goal-graph"] ?? {};
  if (ccServer.type !== "stdio" || ccServer.command !== "goal-graph" || JSON.stringify(ccServer.args) !== JSON.stringify(["mcp"])) {
    problems.push(`claude-code .mcp.json: 必须是零配置 stdio（goal-graph mcp），实际 ${JSON.stringify(ccServer)}`);
  }

  // Codex：零配置 stdio（不携带失效 headers / env_http_headers）
  const cxMcp = readJson("plugins/codex/.mcp.json");
  const cxServer = cxMcp.mcpServers?.["goal-graph"] ?? {};
  if (cxServer.type !== "stdio" || cxServer.command !== "goal-graph" || JSON.stringify(cxServer.args) !== JSON.stringify(["mcp"])) {
    problems.push(`codex .mcp.json: 必须是零配置 stdio（goal-graph mcp），实际 ${JSON.stringify(cxServer)}`);
  }
  if (cxServer.headers !== undefined || cxServer.env_http_headers !== undefined) {
    problems.push("codex .mcp.json: 不得出现 headers / env_http_headers");
  }

  // OpenCode：零配置 local stdio
  const ocMcp = readJson("plugins/opencode/opencode.json");
  const ocServer = ocMcp.mcp?.servers?.["goal-graph"] ?? {};
  if (ocServer.type !== "local" || JSON.stringify(ocServer.command) !== JSON.stringify(["goal-graph", "mcp"])) {
    problems.push(`opencode.json: 必须是零配置 local stdio（["goal-graph","mcp"]），实际 ${JSON.stringify(ocServer)}`);
  }

  // 全量扫描：任何插件文件都不得含 token 字面量；配置文件不得硬编码固定端口 7788
  for (const host of HOSTS) {
    for (const rel of walk(`plugins/${host}`)) {
      const content = readFileSync(join(repoRoot, rel), "utf8");
      problems.push(...tokenLiteralProblems(rel, content));
      if ((rel.endsWith(".mcp.json") || rel.endsWith("opencode.json")) && content.includes("7788")) {
        problems.push(`${rel}: 零配置插件不得硬编码端口 7788`);
      }
    }
  }

  assert.deepEqual(problems, []);
});

// ── ④ 技能正文只引用 MCP 真实提供的工具 ───────────────────────────────────────

test("g-633 ④ 技能正文引用的每个工具都真实可达（只读∪写模式），不引用 Human Gate 工具", () => {
  const problems: string[] = [];
  for (const host of HOSTS) {
    const rel = `plugins/${host}/skills/goal-graph/SKILL.md`;
    const text = read(rel);
    const names = skillToolNames(text);
    if (names.length === 0) problems.push(`${rel}: 未引用任何 graph_* 工具（空正文？）`);
    for (const name of names) {
      if (GATE_NAMES.includes(name)) continue; // 由 gateMisuseProblems 按口径判定
      if (!REACHABLE.has(name)) problems.push(`${rel}: 引用了 MCP 未提供的工具 ${name}`);
    }
    problems.push(...gateMisuseProblems(rel, text));
  }
  assert.deepEqual(problems, []);
});

test("g-633 ④b 技能正文的只读/写模式工具清单与 core 真源逐项一致", () => {
  const problems: string[] = [];
  for (const host of HOSTS) {
    const rel = `plugins/${host}/skills/goal-graph/SKILL.md`;
    const text = read(rel);
    // 「只读」小节必须点名全部 11 个只读工具
    for (const name of READ_ONLY_COMMAND_NAMES) {
      if (!text.includes(name)) problems.push(`${rel}: 只读工具 ${name} 未在正文出现`);
    }
    // 写模式小节必须点名全部 27 个写工具（正文可以换行/制表排版，故按整文包含判断）
    for (const name of WRITE_MODE_COMMAND_NAMES) {
      if (!text.includes(name)) problems.push(`${rel}: 写模式工具 ${name} 未在正文出现`);
    }
    // Human Gate 必须三个都点名并以不可用口径出现
    for (const gate of GATE_NAMES) {
      if (!text.includes(gate)) problems.push(`${rel}: 未说明人工裁决保留项 ${gate}`);
    }
    // 必须说明写模式的开启方式（服务端 --allow-write）
    if (!text.includes("--allow-write")) problems.push(`${rel}: 未说明写模式需服务端 --allow-write`);
    // 必须说明 delivered 不可达
    if (!/delivered/.test(text)) problems.push(`${rel}: 未说明 transition → delivered 不可达`);
    // 迁移可达集合必须与 core 一致（逐项出现）
    for (const target of WRITE_MODE_TRANSITION_TARGETS) {
      if (!text.includes(target)) problems.push(`${rel}: 未提及可达迁移目标 ${target}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("g-633 ④c 负向对照：把 Human Gate 写成可调用形态、或引用不存在的工具，必须被判红", () => {
  // 1) 普通段落里把 accept 写成可调用 ⇒ 必红（这条最要命：模型会照着调）
  const misuse = "调用 `graph_resolve_accept` 接受该目标即可完成交付。\n";
  assert.notDeepEqual(gateMisuseProblems("x.md", misuse), [], "把 accept 写成可调用必须被判红");

  // 2) 代码围栏里的调用示例也必红
  const misuse2 = "```json\n{\"name\": \"graph_start_attempt\"}\n```\n";
  assert.notDeepEqual(gateMisuseProblems("x.md", misuse2), [], "围栏里写 start_attempt 调用必须被判红");

  // 3) 「做不到」小节内的表格行（标注不可用）⇒ 不得误红
  const legit = "## 4. 外部宿主做不到的事\n\n| 工具 | 原因 |\n|---|---|\n| `graph_resolve_accept` | 必须人在 GUI 裁决 |\n";
  assert.deepEqual(gateMisuseProblems("x.md", legit), [], "标注不可用的表格行不得误红");

  // 4) 带否定措辞的单行点名 ⇒ 不得误红
  const legit2 = "    `graph_claim_supervisor`（主管身份）与 `graph_start_attempt`（派发）也不开放。\n";
  assert.deepEqual(gateMisuseProblems("x.md", legit2), [], "带否定措辞的点名不得误红");

  // 5) 引用 core 里根本不存在的工具 ⇒ 必须能被识别出来
  const unknown = "使用 `graph_do_something_magic` 即可。\n";
  const names = skillToolNames(unknown);
  assert.ok(names.some((n) => !REACHABLE.has(n) && !GATE_NAMES.includes(n)), "不存在的工具必须能被识别为不可达");
});

// ── ⑤ 正文与能力一致性（模式口径） ────────────────────────────────────────────

test("g-633 ⑤ 三份技能正文口径一致：stdio 默认 38 工具、--read-only/serve 只读 11 工具、Human Gate 不可达", () => {
  const texts = HOSTS.map((h) => read(`plugins/${h}/skills/goal-graph/SKILL.md`));
  // 三份必须是同一份外部宿主版（内容逐字节一致，避免三处漂移出第二真源）
  for (let i = 1; i < texts.length; i += 1) {
    assert.equal(
      texts[i],
      texts[0],
      `plugins/${HOSTS[i]} 与 plugins/${HOSTS[0]} 的 SKILL.md 必须逐字节一致（否则会漂移出第二个真源）`,
    );
  }
  const t = texts[0];
  for (const pat of [/goal-graph mcp/, /--read-only/, /11\b.*工具|工具.*11\b|\|\s*\*\*11\*\*/, /38\b/, /--allow-write/, /人工裁决/]) {
    assert.match(t, pat, `技能正文缺少必要口径：${pat}`);
  }
});

// ── ⑥ 安装指南五段齐备 ───────────────────────────────────────────────────────

test("g-633 ⑥ 每份插件定义都有安装指南：一条命令安装/前置/最小验证/卸载/排障", () => {
  const problems: string[] = [];
  for (const host of HOSTS) {
    const rel = `plugins/${host}/INSTALL.md`;
    const text = read(rel);
    const checks: Array<[string, RegExp]> = [
      ["一条命令安装", /一条命令安装/],
      ["前置", /##\s*\d*\.?\s*前置|前置/],
      ["最小验证", /最小验证/],
      ["卸载", /卸载/],
      ["排障", /排障/],
    ];
    for (const [name, re] of checks) if (!re.test(text)) problems.push(`${rel}: 缺少「${name}」段`);
    // 安装命令必须是宿主的真实命令形态
    if (host === "claude-code" && !/claude plugin marketplace add/.test(text)) problems.push(`${rel}: 缺 claude plugin marketplace add`);
    if (host === "claude-code" && !/claude plugin install/.test(text)) problems.push(`${rel}: 缺 claude plugin install`);
    if (host === "codex" && !/codex plugin marketplace add/.test(text)) problems.push(`${rel}: 缺 codex plugin marketplace add`);
    if (host === "codex" && !/codex plugin add/.test(text)) problems.push(`${rel}: 缺 codex plugin add`);
    if (host === "opencode" && !/opencode mcp add/.test(text)) problems.push(`${rel}: 缺 opencode mcp add`);
    // 每份都必须写清服务需先 init
    if (!/serve init/.test(text)) problems.push(`${rel}: 未说明需先 serve init`);
  }
  assert.deepEqual(problems, []);
});

// ── ⑦ 宿主运行时实测语义：三宿主统一零配置 stdio（goal-graph mcp） ──────────────

test("g-633 ⑦ 三宿主统一零配置 stdio 入口（goal-graph mcp），无固定端口/手动 token 前置", () => {
  const cc = readJson("plugins/claude-code/.mcp.json").mcpServers["goal-graph"];
  const cx = readJson("plugins/codex/.mcp.json").mcpServers["goal-graph"];
  const oc = readJson("plugins/opencode/opencode.json").mcp.servers["goal-graph"];
  assert.deepEqual(cc, { type: "stdio", command: "goal-graph", args: ["mcp"] });
  assert.deepEqual(cx, { type: "stdio", command: "goal-graph", args: ["mcp"] });
  assert.deepEqual(oc, { type: "local", command: ["goal-graph", "mcp"] });
});

test("g-633 ⑦a Codex 插件配置采用 stdio（且进阶 HTTP 生成器仍只用 bearer_token_env_var）", async () => {
  const cx = readJson("plugins/codex/.mcp.json").mcpServers["goal-graph"];
  assert.equal(cx.type, "stdio");
  assert.equal(cx.command, "goal-graph");
  assert.deepEqual(cx.args, ["mcp"]);
  const mcpMod = await import(new URL("../../scripts/mcp/index.mjs", import.meta.url).href);
  const httpToml = mcpMod.codexConfig({ transport: "http", port: 7788 });
  assert.match(httpToml, /bearer_token_env_var\s*=\s*"GOAL_GRAPH_MCP_TOKEN"/, "进阶 HTTP 模式仍必须用 bearer_token_env_var");
  assert.ok(!httpToml.includes("env_http_headers"), "进阶 HTTP 模式同样不得回退到 env_http_headers");
});

test("g-633 ⑦b 负向：Codex 配置不得出现 env_http_headers 或 headers（插件路径运行时不发认证头）", () => {
  const raw = read("plugins/codex/.mcp.json");
  const cx = JSON.parse(raw).mcpServers["goal-graph"];
  assert.equal(
    Object.hasOwn(cx, "env_http_headers"),
    false,
    "codex .mcp.json 不得出现 env_http_headers",
  );
  assert.equal(
    raw.includes("env_http_headers"),
    false,
    "codex .mcp.json 全文不得出现 env_http_headers（含嵌套/大小写变体）",
  );
  assert.equal(Object.hasOwn(cx, "headers"), false, "codex .mcp.json 不得出现 headers");
});

test("g-633 ⑦b 无未授权网络/发布痕迹：不声明 dependencies，不调用 npm publish/tag/push", () => {
  const problems: string[] = [];
  for (const host of HOSTS) {
    for (const rel of walk(`plugins/${host}`)) {
      if (!rel.endsWith(".md") && !rel.endsWith(".json")) continue;
      const text = readFileSync(join(repoRoot, rel), "utf8");
      // 安装指南里出现 publish/tag/push 只允许是"不做"的说明口径
      for (const cmd of [/npm\s+publish/, /git\s+push/, /git\s+tag/]) {
        if (cmd.test(text)) problems.push(`${rel}: 出现发布/推送命令 ${cmd}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

// ── ⑧ OpenCode 验证声明必须是实测事实（评审 BLOCK 返工，att-003）────────────────
//
// 历史教训：att-002 的 INSTALL.md 顶部写「XDG_* 无效、日志路径硬编码」，把**可实测项**声明成
// 不可验证，且与同文件 §7 排障表自相矛盾。att-003 实测推翻该说法：
//   · 四路 XDG_* 重定向到可写目录后 `opencode --version` → v2.0.24 / exit 0
//   · `opencode mcp add` 产出与 plugins/opencode/opencode.json 逐字段一致
//   · `opencode debug config` 有效（header 显示 ***）
//   · 带日志监听器实收 OpenCode 的 `Authorization: Bearer <token>`（len=71 = "Bearer " 7 + token 64）；
//     未导出该变量时退化为 len=6 ⇒ 证明 {env:} 替换确实取自环境变量
// 下面把这些事实钉住：假话回退即红，已验证项被重新写成"未验证"也红。

test("g-633 ⑧a OpenCode 文档不得再声称 XDG 无效 / 日志路径硬编码（att-002 已被实测推翻）", () => {
  const problems: string[] = [];
  const files = ["plugins/opencode/INSTALL.md", "plugins/opencode/README.md"];
  for (const rel of files) {
    const text = read(rel);
    // ① 不得出现「硬编码」的**肯定式**断言（"不是硬编码/非硬编码" 属正确口径，放行）
    const hardcodedAssertions = text
      .split("\n")
      .filter((line) => /硬编码/.test(line) && !/不是硬编码|非硬编码|不.*硬编码/.test(line));
    if (hardcodedAssertions.length > 0) {
      problems.push(`${rel}: 仍把日志路径断言为硬编码（实测可经 XDG 重定向）`);
    }
    // ② 不得再声称改 XDG 无效
    if (/XDG[_*]*[^\n]{0,20}无效|无效[^\n]{0,20}XDG/.test(text)) {
      problems.push(`${rel}: 仍声称 XDG 变量无效（实测重定向可正常启动）`);
    }
    // ③ 必须写明日志路径由 XDG_DATA_HOME 派生（把正确机制写出来，而不只是删掉错话）
    if (!/XDG_DATA_HOME[\s\S]{0,80}派生|派生[\s\S]{0,40}XDG_DATA_HOME/.test(text)) {
      problems.push(`${rel}: 未写明日志路径由 XDG_DATA_HOME 派生`);
    }
  }
  assert.deepEqual(problems, []);
});

// ── ⑧b 锚定实体守卫（att-004 / att-005 / att-006 三轮评审 BLOCK 返工）────────
//
// att-004 修的 L1/L2/L3 三处漏放各配负向对照（N1/N2/N3）。att-005 评审又物理注入出两处逃逸：
//   E3 §8 区内插入**非表格行**的未验证标记（`> ❌ 未验证：…` + `### 8.1` 子小节）⇒ 表格原样，
//      只统计表格行的守卫完全看不见 ⇒ 判绿
//   F3 把 §8 两条未验行**整体替换**成别的项（数量守恒 2→2、集合已变）⇒ 判绿
//      （自称「集合比对」，实现其实是**计数比对**）
// att-005 的修法把比对做成「顶部 ⇄ §8 表格**双向**关键词对应」。att-006 评审指出这仍不够：
//   它校验的是**两处自洽**，而不是**结论未被悄悄删除** —— 只要把顶部与表格**一起**改，两处照样自洽：
//   Y1' 把真实未验行「`skills/` 被 OpenCode 自动发现」整体换成伪造行「Windows 平台兼容性」，
//       并同步把顶部 ① 也换成同一伪造项 ⇒ 数量守恒 2→2、双向 corresponds 逐项命中 ⇒ 判绿，
//       而 `skills/` 那条实质未验证结论从文档里**凭空消失**
//   Y2' 只在表格追加「Windows 平台兼容性 | ✅ 已实测 | 待补测」，未测项伪装成已实测 ⇒ 判绿
//   ⇒ 根因：corresponds 只看「标识性关键词半数命中」，任何成对替换都能通过。
//
// 因此本版把「**应当存在的结论**」变成**显式登记表**（而不是从文档里推导）：
//   A. §8 区内**任何**含未验证标记的行（不论是不是表格行）都必须是表格行；非表格行一律判红（保留）
//   ① 每个已登记的 `REQUIRED_UNVERIFIED_ANCHORS` 锚点（锚点 = 独立子串；顶部编号 = 必须带前缀的
//      证据模式）在**顶部**必须出现一次，且顶部项数必须恰好等于登记表条数（不得偷偷增删顶部项）
//   ② 每个锚点必须在 §8 表格里有一条**未验证**行，且该行**结论列**确实讲这条结论（锚点 ∈ 结论列 +
//      该条 rowPattern ∈ 结论列）；行里不得同时标 ✅/已实测（**自相矛盾行**一律判红 —— Y2' 的伪装面）
//   ③ §8 表格里每一条 ❌ 未验证行都必须**映射到某个已登记锚点**，否则是「未登记项」⇒ 判红
//   ④ 登记表条数 = 表格未验证行数（不得多也不得少）
//   C. 每条负向对照先演示旧口径确实漏放，再断言新口径必红
//   D. 另自建 E4/F4/F5 与 Y1'/Y2' 及 X1'/X2' 逃逸自测
//
// att-007 评审指出：上述「加实体」的方向已加到第六轮，但**匹配一直对整行做** —— 而 §8 表格是
// 「项 | 状态 | 证据」三列，列语义从未参与判定：
//   逃逸 D  结论列换成无关项、锚点词与 ❌ 只藏在**证据列** ⇒ 整行匹配照样命中 ⇒ 判绿
//   逃逸 A2 结论列与锚点词都保留、只把**证据列**改成肯定断言（「已在全部平台确认…无需手工放置」）
//           ⇒ 整行匹配照样命中 ⇒ 判绿，「未验证」只剩个符号
// 本版把列语义纳入判定（这是**最后一次**「守卫还差最后一列」式的补洞，登记表机制本身不变）：
//   ② 锚点 ∈ **结论列（第 1 列）** 且 rowPattern ∈ **结论列**；evidencePattern ∈ **证据列（第 3 列）**
//   ③ 证据列**不得**含肯定式断言（`AFFIRMATIVE_CLAIM`）
//
// 关键性质：**锚点来自代码里的登记表，不来自文档**。改动登记表 = 一次有意识的决策（diff 里可见），
// 而不是「顶部与表格一起改一下」就能蒙混过关。

/**
 * **已知必须存在的未验证项锚点**（改动此表 = 一次有意识的决策）。
 *
 * 这是本守卫的**唯一真源**：文档里「顶部与 §8 表格都写对」不再足以判绿，
 * 必须逐条命中这里登记的实体。新增真实未验证项 ⇒ 必须先在此登记（强制有意识决策）。
 */
interface UnverifiedAnchor {
  /** 锚点 id：行的逻辑身份，也是本表的主键。 */
  readonly id: string;
  /** 顶部必须出现的编号（`①`/`②`…）——顶部序号本身也是登记的实体，不允许被换掉。 */
  readonly topNumber: string;
  /**
   * 顶部该项的**证据模式**：顶部文本（该编号之后的那一项）必须命中它。
   * 与锚点分离 ⇒ 光把编号换到另一个伪造项上也不够，内容也得对。
   */
  readonly topPattern: RegExp;
  /** 锚点实体：独立子串（用于定位「讲这条结论的那一行」）。 */
  readonly anchor: string;
  /**
   * 该条结论在**结论列（第 1 列）**必须有证据：结论列文本必须命中它。
   * （att-007 起限定列：此前对**整行**匹配，锚点词藏在证据列也能判绿 —— 评审逃逸 D。）
   */
  readonly rowPattern: RegExp;
  /**
   * 该条结论在**证据列（第 3 列）**必须命中它 —— 证据列必须仍在描述「未证实」这件事。
   *
   * att-007（评审逃逸 A2）：此前只审结论列 ⇒ 保留锚点词与 `❌ 未验证`、把证据列改成
   * 「已在全部平台确认可自动发现，无需手工放置」这类**肯定断言**照样判绿。证据列被反向断言后，
   * 「未验证」就只剩个符号，结论事实上已被改写成「已确认」。
   *
   * att-008（评审逃逸 c）：上一版的语料是**手写的少量变体**，把证据列改成「未经确认」「尚未验证」
   * 这类**同义的未证实表述**反而判红 —— 守卫既漏放了真肯定断言，又误伤了诚实的否定式改写。
   * 本版改为**必须命中 `UNVERIFIED_SEMANTICS` 这一族未证实语义**（白名单是「未证实」这一侧，
   * 不是「肯定式」那一侧）：近义否定被系统性收录，而不是一个个往正则里补。
   */
  readonly evidencePattern: RegExp;
}

/**
 * 「未证实」语义全集（**正向**白名单）：证据列必须命中其中至少一项。
 *
 * att-008：白名单从「肯定式的封闭黑名单」翻转到「未证实的开放白名单」的两侧之一 ——
 * 判绿的前提从「没有出现我知道的肯定词」变成「确实出现了未证实语义」。
 * 新增近义否定请加到这里（这是**能力上限的显式登记**，不是打地鼠）。
 */
const UNVERIFIED_SEMANTICS =
  /未经确认|未确认|尚未验证|未验证|尚未确认|未得到验证|有待验证|尚无定论|未在本次实测范围|未实测|未测|未核查|未覆盖|走不到|未走到|不可用|无法[^|]{0,20}调用|未完成[^|]{0,10}调用|手工放置|规则未确认/;

/**
 * 证据列里**不得**出现的肯定式断言（命中等同于把「未证实」偷换成「已确认」）。
 *
 * att-008 c3：补「默认能 / 能自动发现 / 已跑通 / 事实上…」这类已发现的逃逸措辞。
 *
 * 注意本表是**措辞线索**，不是最终裁决 —— 裁决走 `affirmativeClaimProblems`：
 * 「**是否**默认能自动发现」「未验证**能否**自动发现」这类**诚实的疑问式**必须不被误伤
 * （⑧b-c3b 钉住），因此判定要按**分句**看语境，不能对整列做一次裸匹配。
 */
const AFFIRMATIVE_CLAIM =
  /已确认|已证实|已核实|无需|不需要|不必|全部平台|所有平台|均可用|完全可用|可自动发现|已可|默认能(自动)?发现|能自动发现|已跑通|跑通|事实上[^|]{0,10}(通过|生效|可用)/;

/**
 * 疑问/条件分句标记：分句里出现它，则该分句中的肯定词**不算断言**
 * （「是否默认能…」是在问，「若跑通则…」是条件）。
 *
 * 这是**必要的误伤保护**，不是白名单扩容：不加它，「未确认能否自动发现」这种最诚实的写法
 * 反而会判红 —— 而那正是 e1 边界声明所依赖的「文档可以诚实说不知道」。
 */
const HEDGE_CLAUSE = /是否|能否|不确定|假如|如果|若|？|\?/;

/**
 * 证据列是否含**无条件**肯定式断言（返回命中的分句，便于点名；`null` = 没有）。
 *
 * 按 `，。；、|` 切分句，逐句判定：疑问/条件分句中的肯定词不算断言，其余分句命中即算。
 */
/**
 * 证据列是否含**无条件**肯定式断言（返回命中的分句，便于点名；`null` = 没有）。
 *
 * 按句读切分（`，。；、！？|`），逐句判定：疑问/条件分句中的肯定词不算断言，其余分句命中即算。
 * 问号保留在分句里（不切掉），因为它本身就是「这句是疑问」的证据。
 */
function affirmativeClaimIn(evidence: string): string | null {
  for (const clause of evidence.split(/[，。；、|！]/)) {
    if (HEDGE_CLAUSE.test(clause)) continue;
    if (AFFIRMATIVE_CLAIM.test(clause)) return clause.trim();
  }
  return null;
}

/** §8 表格的列数（`项 | 状态 | 证据`）：恒为 3，多一列/少一列都是结构退化。 */
const SECTION8_COLUMNS = 3;

export const REQUIRED_UNVERIFIED_ANCHORS: readonly UnverifiedAnchor[] = [
  {
    id: "opencode-skills-auto-discovery",
    topNumber: "①",
    // 顶部该项必须仍讲 `skills/`（编号 + 锚点是主要判据；内容偷换由 §8 行的 rowPattern 锁死）
    topPattern: /skills\//i,
    anchor: "skills/",
    // 该行**结论列**必须说明「是否被自动发现」这条结论，而不只是提到 `skills/`
    rowPattern: /自动发现/,
    // 证据列必须仍在说「没测 / 未确认 / 手工放置」，而不是「已确认可自动发现」
    evidencePattern: UNVERIFIED_SEMANTICS,
  },
  {
    id: "opencode-in-session-tool-call",
    topNumber: "②",
    topPattern: /会话内|工具调用链路|tools\/call/i,
    anchor: "工具调用链路",
    rowPattern: /会话内|tools\/call/,
    // 证据列必须仍在说「走不到 / 不可用 / 未走到」
    evidencePattern: UNVERIFIED_SEMANTICS,
  },
];

/** 未验证标记：三者任一即计入（不依赖 `❌` 字形）。 */
const UNVERIFIED_MARK = /未验证|未覆盖|❌/;

/**
 * 「已实测」标记（Y2' 的伪装面）：`✅` / `已实测` / `待补测`。
 * 一条行同时带未验证与已实测标记 = 自相矛盾行 ⇒ 一律判红（未测项伪装成已实测）。
 */
const VERIFIED_MARK = /✅|已实测|待补测/;

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}
function isSeparatorRow(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line);
}

/**
 * 把一条表格行切成列数组（去掉首尾竖线，逐列 trim）。非表格行返回 `[]`。
 *
 * **按 Markdown 语义切列**（att-008 评审逃逸 g / g2）：GFM 表格里 `\|` 是**转义的字面竖线**，
 * 不是列分隔符。att-007 的 `body.split("|")` 把它当分隔符 ⇒ 证据列里写
 * 「未测 \| 已确认无需手工放置」，`evidenceCol` 只取到 `未测 `（真话），而 `已确认…` 被切到
 * 第 4 列后被静默丢弃 ⇒ 行被当成 4 列也不报错、证据列里的肯定断言肉眼可见却判绿。
 * 先以占位符保护 `\|`，切分后再还原成字面 `|`。
 */
const ESCAPED_PIPE = "\u0000";
function splitRowCols(line: string): string[] {
  if (!isTableRow(line)) return [];
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body
    .replace(/\\\|/g, ESCAPED_PIPE)
    .split("|")
    .map((c) => c.replaceAll(ESCAPED_PIPE, "|").trim());
}

/**
 * 结论列（第 1 列）/ 证据列（第 3 列）。
 *
 * §8 表格是「项 | 状态 | 证据」三列：结论讲什么 MUST 看第 1 列；
 * 「未证实」这件事讲得对不对 MUST 看第 3 列。对**整行**匹配等于把两列语义混在一起 ——
 * 锚点词藏进证据列、结论列换成无关项，照样命中（评审逃逸 D）。
 */
function conclusionCol(line: string): string {
  return splitRowCols(line)[0] ?? "";
}
function evidenceCol(line: string): string {
  return splitRowCols(line)[2] ?? "";
}

/** §8 区段（从 `## 8.` 到下一个非 8 的同级 `## ` 标题或文末）。 */
function section8Of(doc: string): string {
  const idx = doc.search(/^##\s*8\./m);
  if (idx === -1) return "";
  const rest = doc.slice(idx);
  const next = rest.slice(4).search(/^##\s+(?!8\.)/m);
  return next === -1 ? rest : rest.slice(0, 4 + next);
}

/** 把文档切成「顶部声明区」「§8 全行」「§8 表格行」。 */
function splitDoc(doc: string): { top: string; tableRows: string[]; section8Lines: string[] } {
  const idx = doc.search(/^##\s*8\./m);
  const top = idx === -1 ? doc : doc.slice(0, idx);
  const section8Lines = section8Of(doc).split("\n");
  const tableRows = section8Lines.filter(isTableRow).filter((l) => !isSeparatorRow(l));
  return { top, tableRows, section8Lines };
}

/**
 * 从顶部「未验证项」声明里抽出**逐项**文本。
 *
 * 只收集声明所在的那段引用续行（遇到空 `>` 行、列表项或非引用行即停），
 * 避免把 §1 正文的 `-` 条目也算成未验证项。
 *
 * att-006 起返回「编号 + 项正文」：编号本身也是登记的实体（顶部序号被换到别的项上也必须判红），
 * 故不能只返回正文字符串。
 */
function topUnverifiedItems(top: string): Array<{ number: string; text: string }> {
  const lines = top.split("\n");
  const start = lines.findIndex((l) => /未验证项/.test(l));
  if (start === -1) return [];
  const collected: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    const quoted = /^\s*>/.test(raw);
    const body = raw.replace(/^\s*>\s?/, "");
    if (i > start) {
      if (!quoted) break;
      if (body.trim() === "") break;
      if (/^\s*(?:[-*+]\s|#)/.test(body)) break;
    }
    collected.push(body);
  }
  const joined = collected.join(" ");
  // 注意：`NUM` 是**裸字符集**（不含方括号），否则 `[^${NUM}]` 会拼出 `[^[…]]` 而永远不匹配。
  const NUM = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
  const out: Array<{ number: string; text: string }> = [];
  const re = new RegExp(`([${NUM}])\\s*([^${NUM}]+)`, "g");
  for (const m of joined.matchAll(re)) {
    const text = m[2]!.trim().replace(/[；;。]\s*$/, "");
    if (text !== "") out.push({ number: m[1]!, text });
  }
  return out;
}

/**
 * 抽出「标识性关键词」：拉丁/路径词（≥3 字符）与 CJK 片段（≥2 字）。
 *
 * 不用「全部关键词命中」：顶部声明天然比表格行啰嗦（带原因说明），要求全量命中会把正确文档判红。
 */
function identifyingKeywords(text: string): string[] {
  const norm = text.toLowerCase().replace(/[`*_~]/g, "").replace(/[，。；：、（）()「」【】]/g, " ");
  const out: string[] = [];
  for (const tok of norm.split(/\s+/)) {
    if (tok === "") continue;
    for (const l of tok.match(/[a-z0-9][a-z0-9/._-]*/g) ?? []) if (l.length >= 3) out.push(l);
    for (const c of tok.match(/[\u4e00-\u9fff]{2,}/g) ?? []) out.push(c);
  }
  return [...new Set(out)];
}

/**
 * 一项与一行的对应：该项标识性关键词至少半数命中该行，且至少命中 1 个（双向同尺）。
 *
 * **⚠️ 仅供「旧口径」演示使用**（`legacyAuditTwoWayCorresponds` 与负向对照里演示漏放面）。
 * att-006 评审证明它只是「两处自洽」而非「结论未被删除」：成对替换（Y1'）能整条通过。
 * 生产判定（`auditOpenCodeVerification`）**不再**调用它。
 */
function corresponds(item: string, row: string): boolean {
  const want = identifyingKeywords(item);
  if (want.length === 0) return false;
  const rowNorm = row.toLowerCase().replace(/[`*_~]/g, "");
  const hits = want.filter((w) => rowNorm.includes(w)).length;
  return hits > 0 && hits * 2 >= want.length;
}

/**
 * **旧口径**（att-005 版）：顶部 ⇄ §8 表格双向关键词对应 + 数量相等。
 * 仅供负向对照「先演示旧口径确实判绿」，**不参与任何正向判定**。
 * Y1'（成对替换）与 Y2'（未测项伪装成已实测）在此口径下都会判绿 —— 这就是要修的漏放面。
 */
export function legacyAuditTwoWayCorresponds(doc: string): { pass: boolean; problems: string[] } {
  const { top, tableRows } = splitDoc(doc);
  const tableUnverified = tableRows.filter((l) => UNVERIFIED_MARK.test(l));
  const topItems = topUnverifiedItems(top).map((it) => it.text);
  const problems: string[] = [];
  for (const item of topItems) {
    if (!tableUnverified.some((row) => corresponds(item, row))) problems.push(`top→row: ${item}`);
  }
  for (const row of tableUnverified) {
    if (!topItems.some((item) => corresponds(item, row))) problems.push(`row→top: ${row.slice(0, 40)}`);
  }
  if (topItems.length !== tableUnverified.length) problems.push(`count: ${topItems.length}≠${tableUnverified.length}`);
  return { pass: problems.length === 0, problems };
}

/** ⑧b 的判定核心（纯函数，便于负向对照直接喂坏文档）。空数组 = 通过。 */
export function auditOpenCodeVerification(doc: string): string[] {
  const problems: string[] = [];
  const { top, tableRows, section8Lines } = splitDoc(doc);

  const tableUnverified = tableRows.filter((l) => UNVERIFIED_MARK.test(l));
  const topItems = topUnverifiedItems(top);

  // ── A. §8 区内**任何**未验证标记行都必须是表格行（E3 的漏放面）──────────────
  const nonTableUnverified = section8Lines.filter((l) => l.trim() !== "" && !isTableRow(l) && UNVERIFIED_MARK.test(l));
  for (const line of nonTableUnverified) {
    problems.push(`§8 区内出现**非表格行**的未验证标记（必须是表格行）：「${line.trim().slice(0, 60)}」`);
  }

  // ── A2. §8 表格每行**列数恒为 3**（att-008 评审逃逸 g2 的结构面）───────────────
  //
  // 「项 | 状态 | 证据」三列的语义前提是每行恰好 3 列。多出第 4 列时，`evidenceCol` 只取第 3 列，
  // 第 4 列里的肯定断言**在结构上不可能被看到** —— 只要不校验列数，藏一列就永久绕过证据列判定。
  // 列数不符即判红（含 `\|` 被误当分隔符的情形：那会让一列被切成两列）。
  for (const row of tableRows) {
    const n = splitRowCols(row).length;
    if (n !== SECTION8_COLUMNS) {
      problems.push(
        `§8 表格行必须是 ${SECTION8_COLUMNS} 列（项 | 状态 | 证据），实际 ${n} 列：「${row.trim().slice(0, 70)}」` +
          " —— 多出的列会绕过证据列判定（`\\|` 是转义字面竖线，不能用来分列）",
      );
    }
  }

  // ── B. 锚定**实体**：登记表 ⇄ 顶部 ⇄ §8 表格三方逐条对应（F3 / Y1' / Y2' 的漏放面）──
  //
  // 这里**不再**做「顶部与表格互相自洽」的比对：成对替换能让两处照样自洽（Y1'）。
  // 判据改为以 REQUIRED_UNVERIFIED_ANCHORS 为唯一真源，三方对齐：
  //   登记表 → 顶部（编号 + 内容）→ §8 表格（未验证行且内容讲这条）
  //   以及反方向：§8 表格里每条 ❌ 行都必须映射到某个已登记锚点（未登记项判红）
  if (topItems.length === 0) problems.push("顶部必须显式声明「未验证项」集合（不得省略，且需按 ① ② 逐项列出）");
  if (tableUnverified.length === 0) problems.push("§8 必须显式标出「未验证」行（不得把未验项悄悄删掉）");

  for (const reg of REQUIRED_UNVERIFIED_ANCHORS) {
    // ① 顶部必须保留这个**编号**，且该编号后面讲的必须仍是这条结论（编号与内容都得对）
    const tops = topItems.filter((it) => it.number === reg.topNumber);
    const top = tops[0];
    if (!top) {
      problems.push(`顶部未验证项缺少已登记编号 ${reg.topNumber}（登记锚点「${reg.id}」）—— 不得删除或改号`);
    } else if (!reg.topPattern.test(top.text)) {
      problems.push(
        `顶部 ${reg.topNumber} 项内容已不是登记的锚点「${reg.id}」：` +
          `期望命中 ${String(reg.topPattern)}，实际「${top.text.slice(0, 50)}」（编号被换到别的项上也判红）`,
      );
    }

    // ② §8 表格必须有一条讲**这条**结论的**未验证**行：
    //    锚点 ∈ **结论列**、rowPattern ∈ **结论列**（不再对整行匹配 —— 否则锚点词藏在证据列、
    //    结论列被换掉也能判绿：评审逃逸 D）
    const row = tableUnverified.find((r) => conclusionCol(r).includes(reg.anchor) && reg.rowPattern.test(conclusionCol(r)));
    if (!row) {
      const anyRow = tableRows.find((r) => conclusionCol(r).includes(reg.anchor));
      problems.push(
        `§8 表格里找不到已登记未验证项「${reg.id}」的对应行（锚点 "${reg.anchor}" 须在**结论列**）` +
          (anyRow ? `：结论列命中锚点但该行未被标为未验证「${anyRow.slice(0, 60)}」` : "") +
          " —— 真实未验证结论不得被替换/删除",
      );
    } else {
      // Y2' 的伪装面：同一条行里既 ❌ 未验证 又 ✅ 已实测/待补测 ⇒ 自相矛盾，一律判红
      if (VERIFIED_MARK.test(row)) {
        problems.push(
          `§8 行「${reg.id}」同时标了未验证与已实测/待补测（自相矛盾行）：「${row.slice(0, 60)}」` +
            " —— 未测项不得伪装成已实测",
        );
      }
      // ③ 证据列必须仍在描述「未证实」：A2 的伪装面 —— 结论列还是「❌ 未验证」，
      //    证据列却改口成「已确认/无需/全部平台…」⇒「未验证」只剩个符号，结论事实上被改写
      const ev = evidenceCol(row);
      if (!reg.evidencePattern.test(ev)) {
        problems.push(
          `§8 行「${reg.id}」的证据列不再描述「未证实」（期望命中 ${String(reg.evidencePattern)}）：` +
            `「${ev.slice(0, 80)}」 —— 未验证结论必须由证据列支撑，不得只留符号`,
        );
      }
      const claim = affirmativeClaimIn(ev);
      if (claim !== null) {
        problems.push(
          `§8 行「${reg.id}」的证据列含**肯定式断言**（把「未证实」偷换成「已确认」）：「${ev.slice(0, 80)}」` +
            `（无条件的肯定分句：「${claim.slice(0, 40)}」）`,
        );
      }
    }
  }

  // ③ 反方向：§8 表格里**每一条**未验证行都必须映射到某个已登记锚点（不得有未登记项）
  for (const row of tableUnverified) {
    const hit = REQUIRED_UNVERIFIED_ANCHORS.some(
      (reg) => conclusionCol(row).includes(reg.anchor) && reg.rowPattern.test(conclusionCol(row)),
    );
    if (!hit) {
      problems.push(
        `§8 表格未验证行未登记为锚点（未登记项）：「${row.slice(0, 60)}」` +
          " —— 新增未验证项必须在 REQUIRED_UNVERIFIED_ANCHORS 显式登记",
      );
    }
  }

  // ④ 数量守恒：登记条数 = 表格未验证行数（多一条伪造行/少一条真实行都判红）
  if (tableUnverified.length !== REQUIRED_UNVERIFIED_ANCHORS.length) {
    problems.push(
      `§8 表格未验证行数(${tableUnverified.length}) ≠ 已登记锚点数(${REQUIRED_UNVERIFIED_ANCHORS.length})` +
        "：未验证项集合必须与登记表逐条一致",
    );
  }
  if (topItems.length !== REQUIRED_UNVERIFIED_ANCHORS.length) {
    problems.push(
      `顶部未验证项数(${topItems.length}) ≠ 已登记锚点数(${REQUIRED_UNVERIFIED_ANCHORS.length})` +
        "：不得在顶部偷偷增删未验证项",
    );
  }

  // ── C. 已验证项必须**在 §8 对应行内**标为已实测 ─────────────────────────────
  const verifiedClaimPatterns: Array<[string, RegExp]> = [
    ["mcp add 产出与插件配置逐字段一致", /逐字段一致/],
    ["debug config 能读到条目（并注明无鉴别力）", /\*\*\*[\s\S]*无鉴别力|无鉴别力[\s\S]*\*\*\*/],
    ["认证头实际发出", /认证头[\s\S]{0,40}发出|实收[\s\S]{0,20}Authorization/i],
    ["{env:} 被替换成 token", /\{env:[\s\S]{0,80}(替换|插值)/],
    ["负向对照：未导出变量退化为 len=6", /未导出[\s\S]{0,80}(长度\s*6|len=6)/i],
    ["负向对照：${VAR} 形态不插值", /\$\{VAR\}[\s\S]{0,80}(不插值|字面量)/],
  ];
  for (const [name, re] of verifiedClaimPatterns) {
    const row = tableRows.find((r) => re.test(r)) ?? null;
    if (row === null) {
      problems.push(`§8 表格中找不到结论「${name}」的对应行（不允许靠正文他处的 ✅ 顶替）`);
      continue;
    }
    if (UNVERIFIED_MARK.test(row)) problems.push(`§8 行「${name}」被标成了未验证，但它有实测证据`);
    if (!/✅|已实测/.test(row)) problems.push(`§8 行「${name}」未标为已实测`);
  }

  // ── D. mcp list 必须写明不作判据（且不得再断言「恒返回」）──────────────────
  if (!/mcp list[\s\S]{0,200}(不作判据|不要用|不可作判据)/.test(doc)) {
    problems.push("INSTALL.md: 未注明 opencode mcp list 不可作为判据");
  }
  if (/恒返回|恒报/.test(doc)) {
    problems.push("INSTALL.md: 不得再断言「恒返回/恒报」（实测输出随后台服务状态而变）");
  }

  // ── E. 不得再出现已被证伪的归因 ─────────────────────────────────────────────
  const forbidden: Array<[string, RegExp]> = [
    ["debug config 的 *** 被当成「引用被识别」的证据", /\*\*\*[\s\S]{0,40}说明[\s\S]{0,20}识别/],
    ["以长度算术（7+…=71）作为替换证明", /7\)\s*\+\s*token[\s\S]{0,20}=\s*71|=\s*71[\s\S]{0,20}证明/],
    ["E_NOT_INITIALIZED ⇒ token 已通过认证层", /E_NOT_INITIALIZED[\s\S]{0,40}通过.*认证层/],
    ["mcp list 读的不是同一份生效配置（未证实机制断言）", /读的不是同一份/],
  ];
  for (const [name, re] of forbidden) {
    if (re.test(doc)) problems.push(`INSTALL.md: 仍含已被证伪的归因「${name}」`);
  }

  return problems;
}

/**
 * **旧口径**（att-004 版）：只统计 §8 表格行的未验证标记，顶部只做**计数**比对。
 * 仅供负向对照「先演示旧口径确实漏放」，不参与任何正向判定。
 */
function legacyAuditCountOnly(doc: string): { topCount: number; tableCount: number; pass: boolean } {
  const { top, tableRows } = splitDoc(doc);
  const topUnverified = top.split("\n").filter((l) => UNVERIFIED_MARK.test(l));
  const tableUnverified = tableRows.filter((l) => UNVERIFIED_MARK.test(l));
  const topCount = topUnverified.reduce((n, l) => n + (l.match(/①|②|③|④|⑤|⑥|⑦|⑧|⑨/g)?.length ?? 1), 0);
  return { topCount, tableCount: tableUnverified.length, pass: topCount === tableUnverified.length };
}

test("g-633 ⑧b OpenCode 的「已实测」与「未验证」双向一致（顶部 ⇄ §8、正向限定行内）", () => {
  const problems = auditOpenCodeVerification(read("plugins/opencode/INSTALL.md"));
  assert.deepEqual(problems, []);
});

test("g-633 ⑧b-N1 负向对照：把「认证头实际发出」改成「本次未验证」而不加 ❌，必须判红", () => {
  // L1 漏放：旧版只数 §8 里的 ❌ 字形
  const doc = read("plugins/opencode/INSTALL.md").replace(
    /(\|[^|\n]*认证头[^|\n]*\|)\s*✅\s*已实测\s*\|/,
    "$1 本次未验证 |",
  );
  // 旧口径（只数 §8 表格里的 ❌ 字形）此时**察觉不到变化** —— 这就是漏放面：
  //   改前改后的 ❌ 行数完全相同（2 → 2），只数 ❌ 的守卫拿不到任何信号。
  const countMarks = (d: string) =>
    (d.split("## 8.")[1] ?? "").split("\n").filter((l) => l.trim().startsWith("|") && /❌/.test(l)).length;
  assert.equal(
    countMarks(doc),
    countMarks(read("plugins/opencode/INSTALL.md")),
    "旧口径（只数 ❌）对「改成未验证但不加 ❌」毫无信号 ⇒ 这就是要修的漏放面",
  );
  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "把已实测项改成「本次未验证」（无 ❌）必须判红");
  assert.ok(
    problems.some((p) => /被标成了未验证|未标为已实测|≠ §8/.test(p)),
    `判红理由应点名该项，实际：${JSON.stringify(problems)}`,
  );
});

test("g-633 ⑧b-N2 负向对照：只在顶部新增一条未验证项、§8 表不动，必须判红", () => {
  // L2 漏放：旧版根本不看顶部声明
  const doc = read("plugins/opencode/INSTALL.md").replace(
    /(> \*\*未验证项（与 §8 表格逐项相同）\*\*[^\n]*\n)/,
    "$1> ③ 另有一项未验证：Windows 上未测试。\n",
  );
  assert.notEqual(doc, read("plugins/opencode/INSTALL.md"), "负向对照必须真的改到了文档");
  // 旧口径（完全不审视顶部声明）此时判绿 —— 这就是漏放面：
  const section8b = doc.split("## 8.")[1] ?? "";
  const oldStyleRows = section8b.split("\n").filter((l) => l.trim().startsWith("|") && /❌/.test(l));
  assert.equal(oldStyleRows.length, 2, "旧口径只看 §8 ⇒ 顶部多出的未验证项完全不可见");
  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "顶部新增未验证项而 §8 未动必须判红");
  assert.ok(
    problems.some((p) => /未验证项数|逐项一致/.test(p)),
    `判红理由应点名两处不一致，实际：${JSON.stringify(problems)}`,
  );
});

test("g-633 ⑧b-N3 负向对照：正向断言靠文中他处 ✅ 满足（结论改「仍待确认」），必须判红", () => {
  // L3 漏放：旧版正向正则在全文任意位置匹配，可被别处 ✅ 满足
  const base = read("plugins/opencode/INSTALL.md");
  // 只改「状态列」（第 2 列）为「仍待确认」，标题列与证据列原样保留 —— 这才是评审构造的
  // 真实形态：结论被弱化为待确认，但标题关键词仍在，全文匹配口径照样能找到该行。
  const doc = base
    .replace(/^(\|[^|\n]*认证头[^|\n]*\|)\s*✅[^|\n]*\|/m, "$1 仍待确认 |")
    .replace(/^(## 5\.)/m, "> 附注 ✅：认证头相关结论见 §8。\n\n$1");
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  // 旧口径（全文匹配）会被这个 ✅ 满足 —— 先用它演示漏放：
  const naiveFullText = /认证头[\s\S]{0,10}(是否真的|实际)?发出[\s\S]{0,20}✅|✅[\s\S]{0,40}认证头/.test(doc);
  assert.equal(naiveFullText, true, "旧口径（全文任意命中）确实会被满足 ⇒ 这就是漏放面");
  // 新口径（限定行内）必须判红：
  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "结论改成「仍待确认」而靠他处 ✅ 满足，新口径必须判红");
  assert.ok(
    problems.some((p) => /被标成了未验证|未标为已实测/.test(p)),
    `判红理由应点名该行，实际：${JSON.stringify(problems)}`,
  );
});

// ── ⑧b E3 / F3：att-005 评审物理注入的两处真实逃逸 ──────────────────────────

test("g-633 ⑧b-E3 负向对照：§8 区内插入非表格行的未验证标记（旧口径漏放），新口径必红", () => {
  const base = read("plugins/opencode/INSTALL.md");
  // 评审的构造：§8 表格原样不动，只在区内**另起**非表格行（引用块里的 ❌ 未验证）+ `### 8.1` 子小节。
  const doc = base.replace(
    /(\n)(\|\s*`skills\/` 被 OpenCode 自动发现)/,
    "$1> ❌ 未验证：Windows 平台未测试。\n\n### 8.1 补记\n\n> 另有 Windows 平台未覆盖。\n$1$2",
  );
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");

  // ① 先演示**旧口径确实漏放**：它只统计表格行，非表格行完全不可见
  assert.equal(legacyAuditCountOnly(doc).pass, true, "旧口径（只统计表格行 + 计数比对）此时判绿 ⇒ 这就是漏放面");
  const { tableRows } = splitDoc(doc);
  assert.equal(
    tableRows.filter((r) => UNVERIFIED_MARK.test(r)).length,
    2,
    "表格行未验证数仍是 2（注入的是非表格行）⇒ 只数表格行的口径看不见新增项",
  );

  // ② 再断言**新口径必红**
  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "§8 区内非表格行的未验证标记必须判红");
  assert.ok(
    problems.some((p) => /非表格行/.test(p) && /Windows 平台未测试/.test(p)),
    `判红理由应点名那条非表格行，实际：${JSON.stringify(problems)}`,
  );
});

test("g-633 ⑧b-F3 负向对照：§8 两条未验行整体替换（数量守恒 2→2），计数口径漏放、内容级必红", () => {
  const base = read("plugins/opencode/INSTALL.md");
  const doc = base
    .replace(/^\|[^|\n]*工具调用链路[^|\n]*\|.*$/m, "| Windows 平台兼容性 | ❌ **未验证** | 未在原生 Windows 上测试 |")
    .replace(/^\|\s*`skills\/` 被 OpenCode 自动发现\s*\|.*$/m, "| macOS 平台兼容性 | ❌ **未验证** | 未在 macOS 上测试 |");
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  // 顶部同步替换（模拟「认真改了顶部但集合已变」），使计数依然守恒
  const doc2 = doc
    .replace(/① `skills\/` 是否被 OpenCode 自动发现；/, "① Windows 平台兼容性；")
    .replace(/② OpenCode \*\*会话内\*\*经 LLM[\s\S]*?\n/, "② macOS 平台兼容性。\n");
  assert.notEqual(doc2, doc, "顶部也必须真的改到，否则本条退化成 N2");

  // ① 先演示**旧口径确实漏放**：数量守恒 2→2 ⇒ 计数比对判绿
  const legacy = legacyAuditCountOnly(doc2);
  assert.equal(legacy.topCount, 2, "顶部未验证项数仍为 2");
  assert.equal(legacy.tableCount, 2, "表格未验证行数仍为 2");
  assert.equal(legacy.pass, true, "旧口径（自称集合比对、实为计数比对）此时判绿 ⇒ 这就是逃逸面");

  // ② 再断言**新口径必红**（数量守恒但内容已换）
  assert.notDeepEqual(auditOpenCodeVerification(doc2), [], "数量守恒但内容已换的未验证项必须判红");
});

test("g-633 ⑧b-E4 自建逃逸：把未验证标记藏进 §8 的缩进段落，新口径必红", () => {
  const base = read("plugins/opencode/INSTALL.md");
  // 自建逃逸 E4：不用 `>` 也不用 `###`，插一行**缩进普通段落**（仍非表格行），
  // 且用「未覆盖」而非「未验证」来试探只看字面的守卫。
  const doc = base.replace(
    /(\n)(\|\s*`skills\/` 被 OpenCode 自动发现)/,
    "$1    补充：原生 Windows 上此链路未覆盖（详见上游 issue）。\n$1$2",
  );
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  assert.equal(legacyAuditCountOnly(doc).pass, true, "旧口径对此完全无感 ⇒ 仍判绿");
  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "缩进段落里的「未覆盖」同样是 §8 区内的非表格未验证标记，必须判红");
  assert.ok(problems.some((p) => /非表格行/.test(p)), `判红理由应点名非表格行，实际：${JSON.stringify(problems)}`);
});

test("g-633 ⑧b-F4 自建逃逸：表格多出一行未验证、顶部不动（反向单向），新口径必红", () => {
  const base = read("plugins/opencode/INSTALL.md");
  // 自建逃逸 F4：只在 §8 **表格内追加**一条未验证行，顶部完全不动 ⇒ 靠反向对应抓住。
  const doc = base.replace(
    /^(\|\s*`skills\/` 被 OpenCode 自动发现\s*\|.*)$/m,
    "$1\n| Windows 平台兼容性 | ❌ **未验证** | 未在原生 Windows 上测试 |",
  );
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "表格多出一条未验证行而顶部不动必须判红");
  assert.ok(
    problems.some((p) => /未登记为锚点/.test(p)),
    `判红理由应点名「该未验证行未登记为锚点」，实际：${JSON.stringify(problems)}`,
  );
});

test("g-633 ⑧b-F5 自建逃逸：同量替换且伪造行带 OpenCode 字样（关键词重叠），必红", () => {
  const base = read("plugins/opencode/INSTALL.md");
  // 自建逃逸 F5：把 `skills/` 行换成一条**顶部关键词仍能部分命中**的项（伪造行也带 OpenCode），
  // 试图靠关键词重叠蒙混过内容级比对。
  const doc = base.replace(
    /^\|\s*`skills\/` 被 OpenCode 自动发现\s*\|.*$/m,
    "| OpenCode 插件缓存未验证 | ❌ **未验证** | 安装后缓存可能过期 |",
  );
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "`skills/` 行被换掉后，顶部该项失去对应行，必须判红");
  assert.ok(
    problems.some((p) => /找不到已登记未验证项/.test(p) && /skills\//.test(p)),
    `判红理由应点名已登记锚点失去对应行，实际：${JSON.stringify(problems)}`,
  );
});

// ── ⑧b Y1' / Y2'：att-006 评审物理注入的两条真实逃逸（成对自洽即判绿）───────

test("g-633 ⑧b-Y1' 负向对照：真实未验行被伪造行「成对替换」（顶部同步改），旧口径判绿、新口径必红", () => {
  const base = read("plugins/opencode/INSTALL.md");
  // 评审的构造（Y1'）：把 **§8 表格里**那条真实的 `skills/` 未验证行整体换成伪造项，
  // **同时**把顶部 ① 也换成同一个伪造项 ⇒ 数量守恒 2→2、且顶部↔表格**双向自洽**。
  // 结果：两处仍逐项一致，但 `skills/` 那条实质未验证结论**从文档里凭空消失**。
  const doc = base
    .replace(/^\|[^|\n]*`skills\/`[^|\n]*\|.*$/m, "| Windows 平台兼容性 | ❌ **未验证** | 未在原生 Windows 上测试 |")
    .replace(/①\s*`skills\/`\s*是否被 OpenCode 自动发现；/, "① Windows 平台兼容性；");
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  assert.ok(!/`skills\/` 是否被 OpenCode 自动发现/.test(doc), "Y1' 的前提：真实结论已从顶部消失");
  assert.ok(!/skills\/` 被 OpenCode 自动发现 \|/.test(doc), "Y1' 的前提：真实结论已从 §8 消失");

  // ① 先演示**旧口径（att-005 的双向关键词对应）确实判绿** —— 这正是本次要修的漏放面
  const legacy = legacyAuditTwoWayCorresponds(doc);
  assert.equal(
    legacy.pass,
    true,
    `旧口径（顶部⇄§8 双向自洽 + 数量相等）此时判绿 ⇒ 成对替换可整条通过。实际 problems=${JSON.stringify(legacy.problems)}`,
  );
  const legacyCount = legacyAuditCountOnly(doc);
  assert.equal(legacyCount.pass, true, "更旧的计数口径同样判绿（数量守恒 2→2）");

  // ② 再断言**新口径必红**：锚点来自登记表，不来自文档 ⇒ 两处一起改也救不回来
  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "真实未验行被成对替换必须判红");
  assert.ok(
    problems.some((p) => /找不到已登记未验证项/.test(p) && /opencode-skills-auto-discovery/.test(p)),
    `判红理由必须点名已登记锚点「skills/」失去对应行，实际：${JSON.stringify(problems)}`,
  );
  assert.ok(
    problems.some((p) => /顶部 ① 项内容已不是登记的锚点/.test(p)),
    `判红理由必须点名顶部 ① 的内容已被换掉，实际：${JSON.stringify(problems)}`,
  );
  assert.ok(
    problems.some((p) => /未登记为锚点/.test(p) && /Windows 平台兼容性/.test(p)),
    `判红理由必须点名伪造行「未登记项」，实际：${JSON.stringify(problems)}`,
  );
});

test("g-633 ⑧b-Y2' 负向对照：未测项伪装成「✅ 已实测 / 待补测」，旧口径判绿、新口径必红", () => {
  const base = read("plugins/opencode/INSTALL.md");
  // 评审的构造（Y2'）：把 §8 那条真实的 `skills/` 未验证行**原地改写**成「❌ 未验证 但 ✅ 已实测」，
  // 顶部不动（数量守恒 2→2、顶部↔表格双向自洽）—— 用「已实测」字样把未测项伪装成测过了。
  const doc = base.replace(
    /^(\|\s*`?skills\/`?\s*被 OpenCode 自动发现\s*\|)\s*❌\s*\*\*未验证\*\*\s*\|.*$/m,
    "$1 ❌ **未验证** 但 ✅ 已实测 | 待补测 |",
  );
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  // 注意：顶部声明行里也有「被 OpenCode 自动发现」字样，必须只取**表格行**
  const y2Row = doc.split("\n").find((l) => l.trim().startsWith("|") && /被 OpenCode 自动发现/.test(l))!;
  assert.ok(UNVERIFIED_MARK.test(y2Row) && VERIFIED_MARK.test(y2Row), "Y2' 的前提：该行同时自称未验证与已实测");

  // ① 先演示**旧口径确实判绿**：数量守恒 2→2、该行仍带 `skills/` 关键词 ⇒ 双向自洽
  const legacy = legacyAuditTwoWayCorresponds(doc);
  assert.equal(
    legacy.pass,
    true,
    `旧口径此时判绿 ⇒ 未测项伪装成已实测可整条通过。实际 problems=${JSON.stringify(legacy.problems)}`,
  );
  const legacyCount = legacyAuditCountOnly(doc);
  assert.equal(legacyCount.pass, true, "更旧的计数口径同样判绿（数量守恒 2→2）");

  // ② 新口径必红：同时带未验证与「已实测」的行一律判红（自相矛盾行），且**锚点行本身**被点名
  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "未测项伪装成「✅ 已实测/待补测」必须判红");
  assert.ok(
    problems.some((p) => /自相矛盾行/.test(p) && /opencode-skills-auto-discovery/.test(p)),
    `判红理由必须点名那条自相矛盾行，实际：${JSON.stringify(problems)}`,
  );
});

// ── ⑧b X1' / X2'：本 attempt 自建的新逃逸（说明为什么这次防住了）─────────────

test("g-633 ⑧b-X1' 自建逃逸：只把顶部 ① 编号换到伪造项上、表格行不动，必红", () => {
  // 自建 X1'：**不动 §8 表格**（真实的 `skills/` 未验证行原样保留），只把顶部 ① 指向伪造项，
  // 并顺手在表格里把 `skills/` 行改写成一个仍含 `skills/` 字样、但讲别的结论的行 ——
  // 试探「锚点子串命中就算」的宽松实现。期望：锚点命中但 rowPattern 不命中 ⇒ 判红。
  const base = read("plugins/opencode/INSTALL.md");
  const doc = base
    .replace(/①\s*`skills\/`\s*是否被 OpenCode 自动发现；/, "① `skills/` 在 Windows 上能否被识别；")
    .replace(/^\|\s*`?skills\/`?[^|\n]*\|.*$/m, "| `skills/` 在 Windows 上能否被识别 | ❌ **未验证** | 未测 |");
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");

  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "把「是否被自动发现」偷换成「能否被 Windows 识别」必须判红");
  assert.ok(
    problems.some((p) => /找不到已登记未验证项/.test(p) && /skills\//.test(p)),
    `判红理由必须点名：锚点子串虽在，但该行不再讲「自动发现」这条结论，实际：${JSON.stringify(problems)}`,
  );
});

test("g-633 ⑧b-X1'b 自建逃逸：顶部编号被整体挪到另一条真实锚点上（① ⇄ ② 互换措辞），必红", () => {
  // 自建 X1'b：两个编号都还在、表格两行也都还在讲各自的真实结论，
  // 只把**顶部的编号与内容错配**（① 讲工具调用链路、② 讲 skills/ 自动发现）。
  // 旧口径按关键词找「任意一行」⇒ 照样命中，判绿；新口径按 `编号 → 该编号自己那一项` 判定 ⇒ 必红。
  const base = read("plugins/opencode/INSTALL.md");
  const doc = base
    .replace(
      /①\s*`skills\/`\s*是否被 OpenCode 自动发现；/,
      "① OpenCode 会话内经 LLM 走到工具调用的链路；",
    )
    .replace(/② OpenCode \*\*会话内\*\*经 LLM/, "② `skills/` 是否被 OpenCode 自动发现；③ OpenCode **会话内**经 LLM");
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");

  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "顶部编号与内容错配必须判红");
  assert.ok(
    problems.some((p) => /顶部 ① 项内容已不是登记的锚点/.test(p)),
    `判红理由必须点名顶部 ① 讲的不再是 skills/ 这条结论，实际：${JSON.stringify(problems)}`,
  );
});

test("g-633 ⑧b-X2' 自建逃逸：删除全部未验证项（顶部+表格一起清空），必红", () => {
  // 自建 X2'：最彻底的「删除」——把顶部未验证声明与 §8 两条 ❌ 行**一起**删掉。
  // 任何「双向自洽」口径此时都**空集自洽**（0↔0 逐项命中，vacuous truth）⇒ 判绿；
  // 这正是「以登记表为真源」相对「以文档自洽为真源」的第二个判别点。
  const base = read("plugins/opencode/INSTALL.md");
  const doc = base
    .split("\n")
    .filter((l) => !(l.trim().startsWith("|") && UNVERIFIED_MARK.test(l)))
    .join("\n")
    .replace(/^> \*\*未验证项（与 §8 表格逐项相同）\*\*：[\s\S]*?逐项对照见文末 §8。$/m, "");
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  assert.ok(!/❌/.test(section8Of(doc)), `X2' 的前提：§8 区段里已无 ❌ 行，实际：${section8Of(doc).split("\n").filter((l) => /❌/.test(l)).join(" / ")}`);

  // ① 旧口径空集自洽 ⇒ 判绿（vacuous truth）
  const legacy = legacyAuditTwoWayCorresponds(doc);
  assert.equal(legacy.pass, true, "旧口径在 0↔0 时判绿 ⇒ 空集自洽就是要防的漏放面");

  // ② 新口径必红：登记表里的锚点一条都不能少
  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "把未验证项整体删光必须判红");
  for (const reg of REQUIRED_UNVERIFIED_ANCHORS) {
    assert.ok(
      problems.some((p) => p.includes(reg.id)),
      `判红理由必须逐条点名已登记锚点「${reg.id}」，实际：${JSON.stringify(problems)}`,
    );
  }
});

// ── ⑧b-codex：Codex 侧也必须有验证状态声明（att-007 判据 7 返工）────────────
//
// 评审事实：`plugins/codex/INSTALL.md` 里 `未验证|未能实测` **0 命中** —— ⑧b 的未验证登记表只覆盖
// OpenCode 一份文档，Codex 侧对「哪些没测过」一字未提，读者只能按「已通过」理解。
// 真实边界（att-002 阶段实测）：`codex plugin marketplace add` / `codex plugin add` / `codex mcp list` 成功；
// 但完整 `tools/call` 会话链路与 `skills/` 自动发现**未实测**。
//
// 守卫要求：
//   A. 必须有「验证状态」声明段，且同时含「已实测」与「未实测」两个子段（不得只写好话）
//   B. 每条 Codex **已实测**项必须有证据列（不得空口称已测）
//   C. 必须显式声明「完整 tools/call 会话链路未实测」与「skills/ 自动发现未实测」—— 这两条是本轮的真实边界
//   D. 未实测项里不得出现「已通过 / 已验证通过」这类声称

/** Codex 侧必须显式声明为「未实测」的项（登记表：新增真实边界须在此登记）。 */
export const REQUIRED_CODEX_UNVERIFIED: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "codex-session-tools-call", pattern: /tools\/call[^|]{0,40}(会话|链路)|会话[^|]{0,20}tools\/call|会话内/ },
  { id: "codex-skills-auto-discovery", pattern: /skills\/[^|]{0,20}(自动发现|加载)/ },
  { id: "codex-uninstall-commands", pattern: /plugin remove|marketplace remove/ },
];

/** ⑧b-codex 的判定核心（纯函数，便于负向对照直接喂坏文档）。空数组 = 通过。 */
export function auditCodexVerification(doc: string): string[] {
  const problems: string[] = [];
  // A. 必须有验证状态声明段
  const h = /^##\s*[\d.]*\s*验证状态.*$/m.exec(doc);
  if (!h) {
    problems.push("INSTALL.md: 缺少「验证状态」声明段（Codex 侧必须如实标注实测边界，判据 7）");
    return problems;
  }
  const after = doc.slice(h.index + h[0].length);
  const next = after.search(/^##\s+(?!.*验证状态)/m);
  const section = next === -1 ? after : after.slice(0, next);
  // 段内表格行（去分隔行与表头行 —— 表头「项 | 状态 | 证据」不含 ✅/❌，但「已实测」字样的表头必须排除）
  const all = section.split("\n").filter(isTableRow).filter((l) => !isSeparatorRow(l));
  const HEADER = /^\s*\|\s*项\s*\|\s*状态\s*\|/;
  const rows = all.filter((l) => !HEADER.test(l));
  const verified = rows.filter((r) => /✅|已实测/.test(r) && !/❌|未验证/.test(r));
  const unverified = rows.filter((r) => /❌|未验证/.test(r));
  if (verified.length === 0) problems.push("验证状态: 必须有「已实测」项（只列未验证项等于没写实测记录）");
  if (unverified.length === 0) {
    problems.push("验证状态: 必须有「未验证/❌ 未实测」项（Codex 侧有真实未测边界，不得全部声称已通过）");
  }
  // B. 每条已实测项必须有证据（第 3 列非空且不是占位）
  for (const r of verified) {
    const cols = splitRowCols(r);
    const ev = cols[2] ?? "";
    if (ev.trim() === "" || /^(?:-|待补|TODO|无)$/i.test(ev.trim())) {
      problems.push(`验证状态: 已实测项缺证据列「${r.slice(0, 60)}」—— 不得空口称已测`);
    }
  }
  // C. 真实边界必须逐条登记为「未实测」
  for (const reg of REQUIRED_CODEX_UNVERIFIED) {
    const hit = unverified.find(
      (r) => reg.pattern.test(conclusionCol(r)) && (/❌|未验证|未实测/.test(r)),
    );
    if (!hit) {
      problems.push(
        `验证状态: 未实测项「${reg.id}」未如实标注（期望在结论列命中 ${String(reg.pattern)} 且标 ❌ 未验证）` +
          " —— 这条是真实边界，不得隐去或写成已通过",
      );
    }
  }
  // D. 未实测项不得声称已通过
  for (const r of unverified) {
    if (/已通过|验证通过|确认可用/.test(evidenceCol(r)) && !/未/.test(evidenceCol(r))) {
      problems.push(`验证状态: 未验证项的说明里仍声称「已通过」：「${r.slice(0, 70)}」`);
    }
  }
  return problems;
}

test("g-633 ⑧b-codex Codex INSTALL 如实声明验证状态：已实测有证据、未实测逐条标注", () => {
  assert.deepEqual(auditCodexVerification(read("plugins/codex/INSTALL.md")), []);
  // 顶层 grep 口径（评审用的就是它）：必须真的命中未验证/未能实测
  assert.match(read("plugins/codex/INSTALL.md"), /未验证|未能实测/, "codex INSTALL 必须出现「未验证/未能实测」声明");
});

test("g-633 ⑧b-codex-N1 负向对照：删掉「验证状态」整段（回到评审时的 0 命中状态），必须判红", () => {
  const base = read("plugins/codex/INSTALL.md");
  const doc = base.replace(/^##\s*[\d.]*\s*验证状态[\s\S]*$/m, "");
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  assert.equal(/未验证|未能实测/.test(doc), false, "构造前提：已回到评审时的「未验证/未能实测 0 命中」状态");
  const problems = auditCodexVerification(doc);
  assert.notDeepEqual(problems, [], "删掉验证状态段必须判红");
  assert.ok(
    problems.some((p) => /缺少「验证状态」声明段/.test(p)),
    `判红理由必须点名缺声明段，实际：${JSON.stringify(problems)}`,
  );
});

test("g-633 ⑧b-codex-N2 负向对照：把未实测项全部改成「已通过」（只写好话），必须判红", () => {
  const base = read("plugins/codex/INSTALL.md");
  // 模拟「把边界抹平」：所有 ❌ 行改成 ✅ 已实测 + 已通过
  const doc = base
    .split("\n")
    .map((l) => (l.trim().startsWith("|") && /❌/.test(l) ? l.replace(/❌ \*\*未验证\*\*/g, "✅ 已实测").replace(/\|\s*$/, " 已通过 |") : l))
    .join("\n");
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  const problems = auditCodexVerification(doc);
  assert.notDeepEqual(problems, [], "把未实测项全改成已通过必须判红");
  assert.ok(
    problems.some((p) => /必须有「未验证\/❌ 未实测」项/.test(p)) &&
      REQUIRED_CODEX_UNVERIFIED.every((reg) => problems.some((p) => p.includes(reg.id))),
    `判红理由必须逐条点名未实测项，实际：${JSON.stringify(problems)}`,
  );
});

test("g-633 ⑧b-codex-N3 负向对照：已实测项证据列被清空（空口称已测），必须判红", () => {
  const base = read("plugins/codex/INSTALL.md");
  // 只清空**验证状态段内第一行**已实测项的证据列（第 3 列），状态列 / 结论列原样保留
  // （必须限定在 §9 段内：§3 的写法对比表里也有 ✅，那不是验证状态行）
  const lines = base.split("\n");
  const secStart = lines.findIndex((l) => /^##\s*[\d.]*\s*验证状态/.test(l));
  assert.ok(secStart !== -1, "构造前提：必须有验证状态段");
  const idx = lines.findIndex(
    (l, i) => i > secStart && isTableRow(l) && /✅/.test(l) && !isSeparatorRow(l),
  );
  assert.ok(idx !== -1, "构造前提：必须有至少一行已实测项");
  const cols = splitRowCols(lines[idx]!);
  assert.ok(cols[2] && cols[2]!.trim() !== "", "构造前提：该行原本有证据列");
  lines[idx] = `| ${cols[0]} | ${cols[1]} |  |`;
  const doc = lines.join("\n");
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  const problems = auditCodexVerification(doc);
  assert.notDeepEqual(problems, [], `已实测项缺证据必须判红；实际：${JSON.stringify(problems)}`);
  assert.ok(
    problems.some((p) => /缺证据列/.test(p)),
    `判红理由必须点名缺证据，实际：${JSON.stringify(problems)}`,
  );
});

// ── ⑧b D / A2：att-007 评审物理注入的两条「守卫还差最后一列」逃逸 ────────────
//
// 前六轮都在加「文档里的实体」，但匹配一律对**整行**做 —— 而 §8 表格是「项 | 状态 | 证据」三列：
//   D  把结论列换成无关项、锚点词与 ❌ 只藏在**证据列** ⇒ 整行匹配照样命中 ⇒ 判绿
//   A2 结论列与锚点词都保留、只把**证据列**改成肯定断言（「已在全部平台确认…无需手工放置」）
//      ⇒ 整行匹配照样命中 ⇒ 判绿
// 根因：列语义没有参与判定。现在锚点/rowPattern 限**结论列**、evidencePattern 限**证据列**。

/** 旧口径复刻：**整行**匹配（att-006 的 auditOpenCodeVerification 原文逻辑，仅锚点部分）。 */
function legacyLineWideProblems(doc: string): string[] {
  const { top, tableRows, section8Lines } = splitDoc(doc);
  const problems: string[] = [];
  const nonTable = section8Lines.filter((l) => l.trim() !== "" && !isTableRow(l) && UNVERIFIED_MARK.test(l));
  for (const line of nonTable) problems.push(`§8 区内非表格行：「${line.trim().slice(0, 60)}」`);
  const tableUnverified = tableRows.filter((l) => UNVERIFIED_MARK.test(l));
  const topItems = topUnverifiedItems(top);
  if (topItems.length === 0) problems.push("顶部无未验证项");
  if (tableUnverified.length === 0) problems.push("§8 无未验证行");
  for (const reg of REQUIRED_UNVERIFIED_ANCHORS) {
    const tops = topItems.filter((it) => it.number === reg.topNumber);
    if (!tops[0]) problems.push(`顶部缺编号 ${reg.topNumber}`);
    else if (!reg.topPattern.test(tops[0].text)) problems.push(`顶部 ${reg.topNumber} 内容不符`);
    // ← 关键：**整行**匹配（正是逃逸 D / A2 的漏放面）
    const row = tableUnverified.find((r) => r.includes(reg.anchor) && reg.rowPattern.test(r));
    if (!row) problems.push(`找不到已登记未验证项「${reg.id}」`);
    else if (VERIFIED_MARK.test(row)) problems.push(`自相矛盾行「${reg.id}」`);
  }
  for (const row of tableUnverified) {
    const hit = REQUIRED_UNVERIFIED_ANCHORS.some((reg) => row.includes(reg.anchor) && reg.rowPattern.test(row));
    if (!hit) problems.push(`未登记为锚点：「${row.slice(0, 60)}」`);
  }
  if (tableUnverified.length !== REQUIRED_UNVERIFIED_ANCHORS.length) problems.push("表格未验证行数不符");
  if (topItems.length !== REQUIRED_UNVERIFIED_ANCHORS.length) problems.push("顶部未验证项数不符");
  return problems;
}

test("g-633 ⑧b-D 决定性逃逸：结论列被换掉、锚点词只藏在证据列 ⇒ 整行匹配判绿、限定结论列必红", () => {
  const base = read("plugins/opencode/INSTALL.md");
  // 评审的构造（D）：整行换成「结论列 = 无关项，证据列 = 顺带提一句 skills/」。
  // 结论列已不含「自动发现」，但那串字只藏在证据列里。
  const D_ROW = "| Windows 平台兼容性 | ❌ **未验证** | 未测（注：`skills/` 自动发现属另一条，未覆盖） |";
  const doc = base.replace(/^\|\s*`skills\/` 被 OpenCode 自动发现\s*\|.*$/m, D_ROW);
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  const row = doc.split("\n").find((l) => l.includes("Windows 平台兼容性"))!;
  // 构造前提（三条都必须成立，否则这条构造没在测 D）：
  assert.ok(row.includes("skills/"), "D 的前提：锚点词仍在整行里");
  assert.match(row, /自动发现/, "D 的前提：rowPattern 仍能在整行命中");
  assert.doesNotMatch(conclusionCol(row), /skills\/|自动发现/, "D 的前提：结论列已不含锚点/结论词");

  // ① 旧口径（整行匹配）此时判绿 —— 这正是要修的漏放面
  assert.deepEqual(
    legacyLineWideProblems(doc),
    [],
    "旧口径（整行匹配）判绿 ⇒ 锚点词藏在证据列即可蒙混，这就是决定性逃逸 D",
  );

  // ② 新口径必红，且**红因点名锚点 id**
  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "结论列被换掉必须判红");
  assert.ok(
    problems.some((p) => /找不到已登记未验证项/.test(p) && p.includes("opencode-skills-auto-discovery")),
    `判红理由必须点名 opencode-skills-auto-discovery，实际：${JSON.stringify(problems)}`,
  );
  assert.ok(
    problems.some((p) => /须在\*\*结论列\*\*/.test(p)),
    `判红理由必须点明「锚点须在结论列」，实际：${JSON.stringify(problems)}`,
  );
  // ③ 红因不得是「前提断言」——正向守卫自己就要报红（旧构造下正向守卫全程绿，红只因 assert.notEqual）
  assert.ok(!problems.some((p) => /非表格行/.test(p)), "红因不应来自 E 段（A 段非表格行检查），必须是锚点列判定");
});

test("g-633 ⑧b-A2 逃逸：证据列被改成「已确认/无需」的肯定断言 ⇒ 整行匹配判绿、证据列反向断言必红", () => {
  const base = read("plugins/opencode/INSTALL.md");
  // 评审的构造（A2）：**保留**锚点词与 `❌ 未验证`（结论列一字不改），
  // 只把证据列改成肯定断言 —— 于是「未验证」只剩个符号，结论事实上成了「已确认」。
  const doc = base.replace(
    /^(\|\s*`skills\/` 被 OpenCode 自动发现\s*\|\s*❌\s*\*\*未验证\*\*\s*\|).*$/m,
    "$1 已在全部平台确认可自动发现，无需手工放置 |",
  );
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  const row = doc.split("\n").find((l) => l.trim().startsWith("|") && l.includes("被 OpenCode 自动发现"))!;
  // 构造前提：结论列与状态列原样保留，只有证据列变了
  assert.match(conclusionCol(row), /skills\//, "A2 的前提：结论列仍含锚点");
  assert.match(conclusionCol(row), /自动发现/, "A2 的前提：结论列仍含结论词");
  assert.match(row, /❌\s*\*\*未验证\*\*/, "A2 的前提：状态列仍是 ❌ 未验证");
  assert.match(evidenceCol(row), /已在全部平台确认|无需手工放置/, "A2 的前提：证据列已改成肯定断言");
  assert.doesNotMatch(evidenceCol(row), /未在本次实测范围|未测|未确认/, "A2 的前提：证据列已不再说「没测」");

  // ① 旧口径（整行匹配 + 不看证据列语义）此时判绿 —— 漏放面
  assert.deepEqual(legacyLineWideProblems(doc), [], "旧口径判绿 ⇒ 证据列反向断言可整条通过，这就是逃逸 A2");

  // ② 新口径必红，且红因点名锚点 id 与「证据列」
  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "证据列被改成肯定断言必须判红");
  assert.ok(
    problems.some((p) => /证据列/.test(p) && p.includes("opencode-skills-auto-discovery")),
    `判红理由必须点名该锚点的证据列，实际：${JSON.stringify(problems)}`,
  );
  assert.ok(
    problems.some((p) => /肯定式断言/.test(p)),
    `判红理由必须点名「肯定式断言」，实际：${JSON.stringify(problems)}`,
  );

  // ③ 负向对照的负向对照：证据列仍如实描述「未证实」时**不得**因 evidencePattern 判红
  //    （防止把 evidencePattern 写成「反正一律红」的假守卫）
  //    att-008：这里必须**整列替换**而不是把旧证据列嵌进括号 —— 旧证据列自带表格竖线，
  //    拼接后会把行撑成 4 列，新加的「列数恒为 3」断言会（正确地）把它判红；反向自检要验的是
  //    「诚实的否定式改写不被误伤」，因此只保留恰好 3 列的构造。
  const ok = base.replace(
    /^(\|\s*`skills\/` 被 OpenCode 自动发现\s*\|\s*❌\s*\*\*未验证\*\*\s*\|).*$/m,
    "$1 未在本次实测范围内；本机规则未确认，请手工放置 |",
  );
  assert.notEqual(ok, base, "反向自检必须真的改到了文档");
  const okRow = ok.split("\n").find((l) => l.trim().startsWith("|") && l.includes("被 OpenCode 自动发现"))!;
  assert.equal(splitRowCols(okRow).length, 3, "反向自检的前提：改写后的行仍是 3 列");
  assert.deepEqual(
    auditOpenCodeVerification(ok).filter((p) => /证据列/.test(p)),
    [],
    "证据列如实描述「未证实」时不得被证据列判定误伤",
  );
});

// ── ⑧b-G 列结构（att-008 评审逃逸 g / g2：结构性、可穷尽）──────────────────
//
// 前几轮补了 D（结论列）与 A2（证据列语义），但**表格的结构本身**从未被校验：
//   g  证据列写「未测 \| 已确认无需手工放置」—— `\|` 是转义字面竖线，却被人为当作列分隔符，
//      `evidenceCol` 只取到第 3 列的「未测」（真话），`已确认…` 被切进第 4 列后**静默丢弃** ⇒ 判绿
//   g2 直接把肯定断言写进第 4 列 —— 同上，证据列判定在结构上看不到它
// 两者的共同前提都是「一行可以不是 3 列」。本段把列数变成**硬断言**，前提消失 ⇒ 两类逃逸关闭。
//
// 注意：判别 `\|` 不是分隔符这一点**同时**决定证据列取到什么，所以 splitRowCols 的正负向对照
// 与列数断言必须成对存在 —— 只做其一，仍可构造另一侧的逃逸。

test("g-633 ⑧b-G0 splitRowCols 按 Markdown 语义切列：`\\|` 是转义字面竖线，不是分隔符", () => {
  // ① 正向：普通 3 列
  assert.deepEqual(splitRowCols("| a | b | c |"), ["a", "b", "c"], "普通 3 列必须切成 3 列");
  // ② 正向：`\|` 不得分列（转义后还原为字面竖线）
  assert.deepEqual(
    splitRowCols("| a | b | 未测 \\| 已确认 |"),
    ["a", "b", "未测 | 已确认"],
    "`\\|` 必须在**同一列内**还原成字面竖线，不得当作分隔符",
  );
  // ③ 负向对照：旧实现（裸 split）在同一个输入上确实切成 4 列 —— 先演示漏放面
  const legacySplit = (line: string): string[] =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  assert.equal(
    legacySplit("| a | b | 未测 \\| 已确认 |").length,
    4,
    "旧实现（裸 split）确实把 `\\|` 当分隔符 ⇒ 这就是 g / g2 的结构前提",
  );
  assert.equal(splitRowCols("| a | b | 未测 \\| 已确认 |").length, 3, "新实现必须切成 3 列");
  // ④ 非表格行 / 空行仍返回空数组（既有契约不变）
  assert.deepEqual(splitRowCols("不是表格行"), [], "非表格行返回 []");
});

test("g-633 ⑧b-G1 列数恒为 3：4 列必红（评审逃逸 g2：肯定断言藏进第 4 列）", () => {
  const base = read("plugins/opencode/INSTALL.md");
  // g2 的构造：结论列、状态列、证据列（真话「未测」）全保留，只在**第 4 列**追加肯定断言
  const doc = base.replace(
    /^(\|\s*`skills\/` 被 OpenCode 自动发现\s*\|\s*❌\s*\*\*未验证\*\*\s*\|[^|\n]*\|)\s*$/m,
    "$1 已确认无需手工放置，全部平台可用 |",
  );
  assert.notEqual(doc, base, "负向对照必须真的改到了文档（§8 的 `skills/` 行）");
  const got = doc.split("\n").find((l) => l.trim().startsWith("|") && l.includes("被 OpenCode 自动发现"))!;
  assert.equal(splitRowCols(got).length, 4, "负向对照的前提：该行确实被撑成 4 列");
  // 前提确认：第 3 列（证据列）仍是真话，第 4 列才是肯定断言 ⇒ 只看证据列的口径必然漏放
  assert.match(evidenceCol(got), /未在本次实测范围|未测|未确认/, "前提：证据列仍是真话");
  assert.match(splitRowCols(got)[3]!, /已确认|全部平台/, "前提：肯定断言藏在第 4 列");

  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "4 列的 §8 表格行必须判红");
  assert.ok(
    problems.some((p) => /必须是 3 列/.test(p) && /实际 4 列/.test(p)),
    `判红理由必须点名列数，实际：${JSON.stringify(problems)}`,
  );
});

test("g-633 ⑧b-G2 列数恒为 3：2 列必红（缩列后证据列取空，不得静默判绿）", () => {
  const base = read("plugins/opencode/INSTALL.md");
  // 缩成 2 列：证据列被整个删掉 ⇒ evidenceCol 取到空串。旧口径对空串会让 evidencePattern 判红，
  // 但红因是「证据列不再描述未证实」而**不是**「表格结构坏了」；这里要的是结构级点名。
  const doc = base.replace(
    /^(\|\s*`skills\/` 被 OpenCode 自动发现\s*\|\s*❌\s*\*\*未验证\*\*\s*\|).*$/m,
    "$1",
  );
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  const got = doc
    .split("\n")
    .find((l) => l.trim().startsWith("|") && l.includes("被 OpenCode 自动发现"))!;
  assert.equal(splitRowCols(got).length, 2, "负向对照的前提：该行确实被缩成 2 列");

  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "2 列的 §8 表格行必须判红");
  assert.ok(
    problems.some((p) => /必须是 3 列/.test(p) && /实际 2 列/.test(p)),
    `判红理由必须点名列数，实际：${JSON.stringify(problems)}`,
  );
});

test("g-633 ⑧b-G3 含 `\\|` 的行必红（评审逃逸 g：转义竖线被当分隔符藏肯定断言）", () => {
  const base = read("plugins/opencode/INSTALL.md");
  // g 的构造原样：证据列写「未测 \| 已确认无需手工放置」—— 肉眼可见的肯定断言，
  // 但裸 split 会把它切到第 4 列，`evidenceCol` 只读到「未测」⇒ 旧口径判绿。
  const doc = base.replace(
    /^(\|\s*`skills\/` 被 OpenCode 自动发现\s*\|\s*❌\s*\*\*未验证\*\*\s*\|).*$/m,
    "$1 未测 \\| 已确认无需手工放置 |",
  );
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  const got = doc
    .split("\n")
    .find((l) => l.trim().startsWith("|") && l.includes("被 OpenCode 自动发现"))!;
  // ① 旧口径漏放：裸 split 把 `\|` 当分隔符 ⇒ 4 列，其中证据列只剩「未测」是真话
  const legacyCols = got.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  assert.equal(legacyCols.length, 4, "旧口径（裸 split）切出 4 列 ⇒ 这是漏放的结构前提");
  assert.equal(legacyCols[2], "未测 \\", "旧口径的证据列只取到「未测」⇒ 肯定断言被静默丢弃");
  // ② 新口径：`\|` 不分列 ⇒ 证据列完整含「已确认」，肯定断言可见
  assert.equal(splitRowCols(got).length, 3, "新口径：`\\|` 不分列，仍是 3 列");
  assert.match(evidenceCol(got), /已确认/, "新口径：证据列必须能看见被藏在转义竖线后的肯定断言");

  const problems = auditOpenCodeVerification(doc);
  assert.notDeepEqual(problems, [], "证据列含 `\\|` + 肯定断言必须判红");
  assert.ok(
    problems.some((p) => /肯定式断言/.test(p)),
    `判红理由必须点名「肯定式断言」（而不是被切列后静默丢弃），实际：${JSON.stringify(problems)}`,
  );
});

// ── ⑧b-c 证据列「必须命中未证实语义」（att-008 评审逃逸 c：近义否定）────────────
//
// att-007 的 evidencePattern 是**手写语料**：证据列改成「未经确认」「尚未验证」这类**同义的未证实
// 表述**会被判红（误伤诚实标注），而「默认能自动发现」这类肯定式措辞却判绿（漏放）。
// 本版把白名单翻到「未证实」一侧（UNVERIFIED_SEMANTICS）：判绿前提从「没出现我知道的肯定词」
// 变成「确实出现了未证实语义」。以下逐条钉住**方向正确**：近义否定必须绿、肯定式必须红。

test("g-633 ⑧b-c 证据列的六种近义否定都必须判绿（误伤面：诚实标注不得被当成改口）", () => {
  const base = read("plugins/opencode/INSTALL.md");
  const variants = [
    "未经确认：OpenCode 侧技能目录规则未确认，请手工放置",
    "尚未验证：本机 LLM 上游不可用，未走到这一步",
    "尚未确认：需在你的版本上复核",
    "未得到验证：本次未跑该路径",
    "有待验证：留待换版本后复核",
    "尚无定论：两种规则都可能",
  ];
  for (const variant of variants) {
    const doc = base.replace(
      /^(\|\s*`skills\/` 被 OpenCode 自动发现\s*\|\s*❌\s*\*\*未验证\*\*\s*\|).*$/m,
      `$1 ${variant} |`,
    );
    assert.notEqual(doc, base, `负向对照必须真的改到了文档（${variant}）`);
    const got = doc.split("\n").find((l) => l.trim().startsWith("|") && l.includes("被 OpenCode 自动发现"))!;
    assert.equal(splitRowCols(got).length, 3, `前提：改写后仍是 3 列（${variant}）`);
    // 前提：确认这确实是**未证实**语义、且不含任何肯定断言（否则判绿的理由会跑偏）
    assert.match(evidenceCol(got), UNVERIFIED_SEMANTICS, `前提：「${variant}」确实命中未证实语义`);
    assert.equal(affirmativeClaimIn(evidenceCol(got)), null, `前提：「${variant}」不含肯定式断言`);

    assert.deepEqual(
      auditOpenCodeVerification(doc),
      [],
      `证据列改写成近义否定「${variant}」必须判绿（诚实标注不得被误伤）`,
    );
  }
});

test("g-633 ⑧b-c2 每种近义否定都有对照：换成肯定式必须判红（方向正确 + 不漏放）", () => {
  // 与 ⑧b-c 一一配对的肯定式改写 —— 若某一对里「绿」的那条其实也不是靠 UNVERIFIED_SEMANTICS 判绿
  // （例如全文档根本没走到证据列判定），下面这半边的红就必须出现，否则说明对照失效。
  const base = read("plugins/opencode/INSTALL.md");
  const pairs: Array<[string, string]> = [
    ["未经确认：规则未确认，请手工放置", "已确认：规则明确，可自动发现"],
    ["尚未验证：未走到这一步", "尚未验证 → 但事实上已通过"],
    ["尚未确认：需复核", "不必复核，已核实可用"],
    ["未得到验证：本次未跑该路径", "已验证通过，无需手工放置"],
    ["有待验证：留待换版本后复核", "有待验证 → 但事实上已生效"],
    ["尚无定论：两种规则都可能", "无争议，已证实全部平台可用"],
  ];
  for (const [honest, claim] of pairs) {
    const rewrite = (text: string) => {
      const doc = base.replace(
        /^(\|\s*`skills\/` 被 OpenCode 自动发现\s*\|\s*❌\s*\*\*未验证\*\*\s*\|).*$/m,
        `$1 ${text} |`,
      );
      assert.notEqual(doc, base, `负向对照必须真的改到了文档（${text}）`);
      return doc;
    };
    // 正方向：诚实的否定式 ⇒ 绿
    assert.deepEqual(auditOpenCodeVerification(rewrite(honest)), [], `诚实标注「${honest}」必须绿`);
    // 负方向：同一「位置」换成肯定式 ⇒ 红
    const problems = auditOpenCodeVerification(rewrite(claim));
    assert.notDeepEqual(problems, [], `肯定式「${claim}」必须红（对照「${honest}」）`);
    assert.ok(
      problems.some((p) => /证据列/.test(p)),
      `红因必须落在证据列（${claim}），实际：${JSON.stringify(problems)}`,
    );
  }
});

// ── ⑧b-c3 AFFIRMATIVE_CLAIM 补已知逃逸措辞（att-008 评审逃逸 c3）──────────────
//
// c3 的构造：「默认能自动发现，若不行再手工放置」—— 既像提示又像结论，`手工放置` 命中了旧的
// evidencePattern 语料 ⇒ 判绿。措辞非穷尽，但**已发现的**必须钉住。

test("g-633 ⑧b-c3 已知逃逸措辞必须判红：「默认能 / 能自动发现 / 已跑通 / 事实上…」", () => {
  const base = read("plugins/opencode/INSTALL.md");
  const escapes = [
    "默认能自动发现，若不行再手工放置", // 评审 c3 原文
    "能自动发现，未放对目录时才手工放置",
    "这条路已在本地跑通，未放对目录时才手工放置",
    "未确认过，但事实上已生效，手工放置只是兜底",
    "未测过整体，但事实上可用，否则再手工放置",
  ];
  for (const text of escapes) {
    const doc = base.replace(
      /^(\|\s*`skills\/` 被 OpenCode 自动发现\s*\|\s*❌\s*\*\*未验证\*\*\s*\|).*$/m,
      `$1 ${text} |`,
    );
    assert.notEqual(doc, base, `负向对照必须真的改到了文档（${text}）`);
    const got = doc.split("\n").find((l) => l.trim().startsWith("|") && l.includes("被 OpenCode 自动发现"))!;
    assert.equal(splitRowCols(got).length, 3, `前提：改写后仍是 3 列（${text}）`);
    // 前提：确认这确实是被**新补的**那几条措辞命中（而不是老白名单里的词顺带命中）
    assert.match(
      evidenceCol(got),
      /默认能[^|]{0,6}(发现|生效|可用|工作)|能自动发现|已跑通|跑通|事实上[^|]{0,10}(通过|生效|可用)/,
      `前提：「${text}」命中本轮新增的逃逸措辞集合`,
    );

    const problems = auditOpenCodeVerification(doc);
    assert.notDeepEqual(problems, [], `证据列改成「${text}」必须判红`);
    assert.ok(
      problems.some((p) => /肯定式断言/.test(p)),
      `判红理由必须点名「肯定式断言」（${text}），实际：${JSON.stringify(problems)}`,
    );
  }
});

test("g-633 ⑧b-c3b 反向自检：新增措辞不得误伤诚实的否定式表述", () => {
  const base = read("plugins/opencode/INSTALL.md");
  // 这些也含「默认」「自动发现」「已跑通」等**新增线索词**，但语义是**疑问/条件/否定**，不得被判红。
  // 其中第一条最关键：它含 `默认能自动发现` 这个**本轮新加**的线索（旧版必被误伤），
  // 但整句是「不确定**是否**…」⇒ 分句级判定必须放行。
  // 每条用例 = [证据列文本, 是否含本轮新增的线索词]。含线索词的必须证明没被误伤（这是保护的实际
  // 检验面）；不含线索词的只需证明整句判绿（它防的是 evidencePattern 一侧的误伤）。
  const honest: Array<[string, boolean]> = [
    ["未测：不确定是否默认能自动发现，请手工放置", true], // 含 `默认能自动发现`（本轮新增线索）
    ["能自动发现吗？尚未验证，请先手工放置", true], // 含 `能自动发现`（疑问式结尾）
    ["若默认能自动发现则可省一步，但这一点尚未验证", true], // 含 `默认能自动发现`（条件从句）
    ["未验证能否自动发现，先手工放置", false], // 「能否自动发现」不构成线索（`能自动发现` 不在词表内含「否」）
    ["未确认这条路径是否已跑通，按规则未确认处理", true], // 含 `已跑通`，但被「是否」限定
  ];
  for (const [text, hasCue] of honest) {
    const doc = base.replace(
      /^(\|\s*`skills\/` 被 OpenCode 自动发现\s*\|\s*❌\s*\*\*未验证\*\*\s*\|).*$/m,
      `$1 ${text} |`,
    );
    assert.notEqual(doc, base, `反向自检必须真的改到了文档（${text}）`);
    // 必须限定**表格行**：顶部第 8 行的引用块同样含「被 OpenCode 自动发现」（且排在前面），
    // 不筛表格行就会取到那一行、evidenceCol 返回空串 ⇒ 前提断言假红。
    const ev = evidenceCol(
      doc.split("\n").find((l) => l.trim().startsWith("|") && l.includes("被 OpenCode 自动发现"))!,
    );
    assert.ok(ev !== "", "反向自检的前提：必须取到 §8 表格行的证据列（非空）");
    // 前提：含线索词的用例必须确实**含**线索，否则这条自检等于没测到 HEDGE_CLAUSE 的误伤保护
    assert.equal(AFFIRMATIVE_CLAIM.test(ev), hasCue, `反向自检的前提：「${text}」的线索词命中应为 ${hasCue}`);
    // 而判定必须认为它是**被限定的**陈述（疑问/条件），不是无条件断言
    assert.equal(affirmativeClaimIn(ev), null, `「${text}」是疑问/条件分句，不得被判为无条件断言`);
    assert.deepEqual(auditOpenCodeVerification(doc), [], `诚实的否定式表述「${text}」不得被误伤`);
  }
});

// ── ⑧b-e1 **已知边界**：表格外段落的肯定式表述（本轮明确不追，仅固化为已知漏放）──
//
// e1 是评审构造的真实逃逸：§8 表格一字不改（结论列、状态列、证据列都诚实），只在表格**后面**
// 追加一段小结「已在本地跑通，按目录放置即可生效」⇒ 整篇文档自相矛盾，而表格守卫判绿。
//
// 本守卫**不追**这一类，理由（主管裁决 + 评审共识）：
//   「表格外段落会不会自相矛盾」是**整篇自然语言**的性质，任何词表都无法穷尽 —— 本轮已用尽
//   结构性手段（列语义、列数、未证实语义词族），再补词表只是把地鼠洞挪到下一条措辞。
//   真实防线是**探针实测**（`scripts/g633-opencode-mcp-probe.mjs`，可复跑）与人工评审。
// 本测试把这条漏放**钉成已知事实**：若将来有人声称守卫覆盖了 e1，它会先红。

test("g-633 ⑧b-e1 【已知边界】表格外追加的小结肯定断言不被文本守卫拦下（如实固化，非缺陷回归）", () => {
  const base = read("plugins/opencode/INSTALL.md");
  const doc = base.replace(
    /(> \*\*关于 `opencode mcp list`\*\*)/,
    "> **小结**：skills 已在本地跑通，按目录放置即可生效。\n\n$1",
  );
  assert.notEqual(doc, base, "负向对照必须真的改到了文档");
  // 表格本身一字未动 ⇒ 表格级守卫（锚点/列语义/列数）按设计判绿
  assert.deepEqual(
    auditOpenCodeVerification(doc),
    [],
    "已知边界：表格外段落的肯定式表述不被文本守卫覆盖（这就是 §8 能力上限，见文件头「能力边界」）",
  );
});

// ── ⑨ serve 启动命令与排障约束（att-005 评审 BLOCK-1 返工 / att-006 补齐判定面）──
//
// att-005 的 ⑨ 只比 `root !== ws`，标题却写「不得相同**且不互相包含**」—— 标题与判定面不一致。
// service（core/service/config.ts `assertSeparatedRoots`）实际会拒绝三种形态：
//   root_relative : 任一侧不是绝对路径（`!isAbsolute` ⇒ 「必须是绝对路径」）
//   root_same     : realpath/字面相同（「不得相同」）
//   root_nested   : 任一方向互相包含（`pathContains(g,w) || pathContains(w,g)` ⇒ 「不得互相包含」）
// 本版把三种形态**逐条**断言，并与 service 的判定函数**同口径**（同一套 path 语义），
// 且每条判定都配负向对照（喂合法形态必绿、喂非法形态必红）。

/** 绝对路径判定（与 service `isAbsolute` 同一 Node 语义）。 */
function isAbsolutePath(p: string): boolean {
  return isAbsolute(p);
}

/**
 * service `assertSeparatedRoots` 能抛出的错误码集合（与 `ServiceConfigError["code"]` 同域）。
 *
 * att-007：此前本守卫**自己复制**了一份 `pathContains`（注释自称「与 service 同口径」），
 * 而 service 的 realpath 分支（`config.ts` 的 `realOrNull`）在守卫侧没有对应 ⇒ 只是「布尔巧合一致」。
 * 现在改为**委托真源**：一律走 `assertSeparatedRoots`，并取其抛出的 `code`（而不是只比布尔）。
 */
export type RootProblem = RootErrorCode;
type RootErrorCode = ReturnType<typeof serviceRootError>;

/**
 * 调一次 service 真源：合法返回 `null`，非法返回它抛出的**错误码**（不是布尔）。
 *
 * 非 `ServiceConfigError`（例如实现里出现 TypeError）一律**抛出**，不得降级成某个码 ——
 * 否则「守卫判定」会被一个无关异常冒充。
 */
function serviceRootError(root: string, ws: string): "root_same" | "root_nested" | "root_relative" | "root_missing" {
  try {
    assertSeparatedRoots(root, ws);
    return null as never;
  } catch (err) {
    if (err instanceof ServiceConfigError) return err.code as Exclude<RootErrorCode, null>;
    throw err;
  }
}

/**
 * **⑨ 的判定**（纯函数，便于负向对照直接喂非法形态）。`null` = 通过，否则 = service 的**错误码**。
 *
 * 不再复制任何路径语义：绝对路径 / 不得相同 / 不得互相包含（含 realpath 变体）全部由
 * `assertSeparatedRoots` 判定，本函数只做「取码」⇒ 不存在第二套口径。
 * 返回码与 service 逐项一致（含 `""` ⇒ `root_missing`，此前守卫误报 `root_relative`）。
 */
export function serveRootProblems(root: string, ws: string): RootErrorCode {
  return serviceRootError(root, ws);
}

test("g-633 ⑨ 三份 INSTALL 的 serve 命令满足 service 三条约束：绝对路径 / 不得相同 / 不得互相包含", () => {
  const files = ["plugins/claude-code/INSTALL.md", "plugins/codex/INSTALL.md", "plugins/opencode/INSTALL.md"];
  // 三份文档统一用这两个变量（下方逐份断言它们已被 export 且是绝对路径）
  for (const rel of files) {
    const text = read(rel);
    const lines = text.split("\n");
    // ① 不得再出现 `--root "$PWD" --workspace "$PWD"`（同值必被 service 拒绝：root_same）
    for (const line of lines) {
      if (!/goal-graph\s+serve/.test(line)) continue;
      assert.doesNotMatch(
        line,
        /--root\s+"\$PWD"\s+--workspace\s+"\$PWD"/,
        `${rel}: 仍用 --root $PWD --workspace $PWD 同值（service 会报「graphRoot 与 executionWorkspace 不得相同」）`,
      );
    }
    // ② 文档必须把两个路径变量 export 成**绝对路径**（root_relative 的判定面）
    assert.match(
      text,
      /export\s+DSH_BOARD="\$HOME\//,
      `${rel}: DSH_BOARD 必须以 $HOME/… 形式导出（相对路径会被 service 以 root_relative 拒绝）`,
    );
    assert.match(
      text,
      /export\s+DSH_WS="\$PWD"/,
      `${rel}: DSH_WS 必须以 $PWD（绝对路径）导出（相对路径会被 service 以 root_relative 拒绝）`,
    );

    const serveCmds = lines.filter((l) => /^\s*goal-graph\s+serve\s+(init\b|--)/.test(l));
    assert.ok(serveCmds.length >= 3, `${rel}: 至少应有 serve init / serve / serve --allow-write 三条命令`);
    for (const cmd of serveCmds) {
      const root = /--root\s+(\S+)/.exec(cmd)?.[1];
      const ws = /--workspace\s+(\S+)/.exec(cmd)?.[1];
      assert.ok(root && ws, `${rel}: serve 命令必须同时给 --root 与 --workspace：${cmd.trim()}`);
      assert.notEqual(root, ws, `${rel}: --root 与 --workspace 不得相同：${cmd.trim()}`);
      // ③ 三条约束**逐条实判**（不是只比字符串）：把文档里的两个变量按真实取值展开后交给 service 真源
      const code = serveRootProblems(expandDocPath(root, rel), expandDocPath(ws, rel));
      assert.equal(
        code,
        null,
        `${rel}: serve 命令被 service 真源拒绝（${String(code)}）：${cmd.trim()}`,
      );
    }
    // ④ `serve`（非 init）必须显式 --port：不给时 parseServeArgs 置 0 ⇒ 配置里的 port 被忽略
    for (const cmd of serveCmds) {
      if (/\bserve\s+init\b/.test(cmd)) continue;
      assert.match(cmd, /--port\s+\d+/, `${rel}: serve 必须显式 --port（否则随机端口，URL 对不上）：${cmd.trim()}`);
    }
  }
});

/**
 * 把文档里的 serve 命令路径展开成**绝对路径**（用于把文档本身喂给与 service 同口径的判定）。
 *
 * 三份文档统一用两个变量：
 *   `DSH_BOARD="$HOME/.dsh-graph-boards/$(basename "$PWD")"`  ⇒ `/home/user/.dsh-graph-boards/myproject`
 *   `DSH_WS="$PWD"`                                          ⇒ `/work/myproject`
 * 变量取值**从文档自身读取**（不是在这里另写一份路径），故文档改了取值本展开会跟着变。
 * 出现不认识的形态直接抛错（防止「未覆盖的形态被静默当成合法绝对路径」）。
 */
function expandDocPath(token: string, rel: string): string {
  const text = read(rel);
  const HOME = "/home/user";
  const PWD = "/work/myproject";
  const varByName = new Map<string, string>();
  for (const name of ["DSH_BOARD", "DSH_WS"]) {
    const m = new RegExp(`export\\s+${name}="([^"]+)"`).exec(text);
    if (!m) throw new Error(`${rel}: 未找到 export ${name}=…（serve 命令必须具备可核验的绝对路径来源）`);
    varByName.set(name, m[1]!);
  }
  const expandVars = (s0: string): string =>
    s0
      .replace(/\$\$?PWD/g, PWD)
      .replace(/\$\$?HOME/g, HOME)
      .replace(/\$\(basename\s+"?\$?PWD"?\)/g, "myproject")
      .replace(/\$\{?(DSH_BOARD|DSH_WS)\}?/g, (_m, name: string) => expandVars(varByName.get(name)!))
      .replace(/"|'/g, "");
  const expanded = expandVars(token);
  if (!isAbsolutePath(expanded)) {
    throw new Error(`${rel}: serve 命令路径 ${token} 展开后仍不是绝对路径（${expanded}）—— 请用受支持的形态`);
  }
  return expanded;
}

test("g-633 ⑨b 负向对照：service 的四种拒绝码（root_missing / root_relative / root_nested / root_same）逐条精确必红", () => {
  // ① 合法形态必绿（先证明判定函数本身不是「一律判红」）
  assert.equal(
    serveRootProblems("/home/user/.dsh-graph-boards/myproject", "/work/myproject"),
    null,
    "两个分离的绝对路径必须判绿（判定函数的正向基准）",
  );
  assert.equal(serveRootProblems("/a/board", "/b/ws"), null, "两个不相干绝对路径必须判绿");

  // ② **逐形态精确比码**（不是「含某个码即可」：错误码本身也是判定面，
  //    `""` 曾被守卫误报 root_relative 而 service 报 root_missing —— 正是「只比布尔」掩盖的偏差）
  const cases: Array<[string, string, RootProblem]> = [
    ["", "/work/myproject", "root_missing"],
    ["/home/user/board", "", "root_missing"],
    ["   ", "/work/myproject", "root_missing"],
    ["board", "/work/myproject", "root_relative"],
    ["/home/user/board", "ws", "root_relative"],
    ["./board", "../ws", "root_relative"],
    ["/work", "/work/myproject", "root_nested"],
    ["/work/myproject/.dsh-graph", "/work/myproject", "root_nested"],
    ["/a", "/a/b", "root_nested"],
    ["/a/b", "/a", "root_nested"],
    ["/work/proj", "/work/proj", "root_same"],
    ["/work/proj/", "/work/proj", "root_same"],
  ];
  for (const [r, w, want] of cases) {
    assert.equal(serveRootProblems(r, w), want, `必须精确判 ${want}：root=${JSON.stringify(r)} ws=${JSON.stringify(w)}`);
  }

  // ③ 反向确认：**只**判 `root !== ws` 的旧口径会放过相对路径与互相包含 ⇒ 这就是标题与判定面不一致的部分
  const legacyOnly = (r: string, w: string) => r !== w;
  assert.equal(legacyOnly("/work", "/work/myproject"), true, "旧口径（只比 root!==ws）对互相包含判绿 ⇒ 漏放面");
  assert.equal(legacyOnly("board", "/work/myproject"), true, "旧口径（只比 root!==ws）对相对路径判绿 ⇒ 漏放面");
  assert.equal(serveRootProblems("/work", "/work/myproject"), "root_nested", "新口径必须抓住互相包含");
  assert.equal(serveRootProblems("board", "/work/myproject"), "root_relative", "新口径必须抓住相对路径");
});

test("g-633 ⑨c 与 service 真源同口径：**错误码**级交叉验证（不复制任何路径语义）", () => {
  // att-007：此前 ⑨c 只比**布尔**，而 serveRootProblems 自己复制了一份 pathContains、且缺 realpath 分支
  // ⇒ 「0/11 布尔一致」只是巧合，不是同源。
  //
  // 现在做两级断言：
  //   ① **身份级**：serveRootProblems 的返回值必须**恒等于** assertSeparatedRoots 抛出的 code
  //      （逐形态精确相等，而不是「都红/都绿」）；
  //   ② **源码级**：守卫文件里**不得**再出现自造的路径语义（`pathContains` 调用、`relative(`、
  //      `resolve(`）—— 出现即说明又长出第二套口径。
  const cases: Array<[string, string]> = [
    ["/home/user/.dsh-graph-boards/myproject", "/work/myproject"],
    ["/a/board", "/b/ws"],
    ["", "/work/myproject"],
    ["/home/user/board", ""],
    ["board", "/work/myproject"],
    ["/home/user/board", "ws"],
    ["/work", "/work/myproject"],
    ["/work/myproject/.dsh-graph", "/work/myproject"],
    ["/a", "/a/b"],
    ["/a/b", "/a"],
    ["/work/proj", "/work/proj"],
    ["/work/proj/", "/work/proj"],
  ];
  for (const [r, w] of cases) {
    // 真源口径：合法 ⇒ null，非法 ⇒ 它抛出的 ServiceConfigError.code（非本类异常必须原样抛出）
    let serviceCode: RootProblem = null;
    try {
      assertSeparatedRoots(r, w);
    } catch (err) {
      assert.ok(err instanceof ServiceConfigError, `service 必须只抛 ServiceConfigError，实际：${String(err)}`);
      serviceCode = err.code;
    }
    assert.equal(
      serveRootProblems(r, w),
      serviceCode,
      `本守卫的**错误码**必须与 service 真源逐形态相同：root=${JSON.stringify(r)} ws=${JSON.stringify(w)}`,
    );
  }

  // ② 源码级：不得自造第二套路径语义（注释行不算）
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l));
  for (const bad of [/\bpathContains\s*\(/, /\brelative\s*\(/, /\bresolve\s*\(/]) {
    const hits = code.filter((l) => bad.test(l));
    assert.deepEqual(hits, [], `守卫不得自造路径语义（应一律委托 service 真源）：${bad} 命中 ${JSON.stringify(hits)}`);
  }
});

test("g-633 ⑨d 负向对照：自己复制 pathContains（缺 realpath 分支）的旧守卫必与真源分歧", () => {
  // 演示「第二套口径」是怎么来的：旧守卫 = 自己的 `pathContains`（`relative()` 字面比较）+ 无 realpath 分支，
  // 而 service 的 `assertSeparatedRoots` 会**额外**拿 realpath 再判一遍（symlink 不得把两个 root 变成同一个）。
  // 于是「两个路径经 symlink 指向同一处」时：旧守卫判绿（无分歧地放行），真源判 root_same。
  const oldPathContains = (parent: string, child: string) => {
    const rel = legacyRelative(parent, child);
    return rel !== "" && rel !== ".." && !rel.startsWith(".." + legacySep) && !isAbsolute(rel);
  };
  const oldProblems = (root: string, ws: string): string[] => {
    const out: string[] = [];
    if (!isAbsolute(root) || !isAbsolute(ws)) out.push("root_relative");
    const g = legacyResolve(root);
    const w = legacyResolve(ws);
    if (g === w) out.push("root_same");
    if (oldPathContains(g, w) || oldPathContains(w, g)) out.push("root_nested");
    return out;
  };
  const tmp = mkdtempSync(join(tmpdir(), "g633-realpath-"));
  try {
    const real = join(tmp, "real");
    mkdirSync(real, { recursive: true });
    const link = join(tmp, "link");
    symlinkSync(real, link);
    // ① 旧守卫：字面比较 ⇒ 两条路径不同 ⇒ 判绿（这就是缺 realpath 分支的漏放面）
    assert.deepEqual(oldProblems(link, real), [], "旧守卫（无 realpath 分支）对 symlink 同源判绿 ⇒ 漏放面");
    // ② 真源：realpath 后相同 ⇒ root_same
    assert.equal(serveRootProblems(link, real), "root_same", "service 真源（含 realpath 变体）必须判 root_same");
    // ③ 二者分歧 ⇒ 「布尔一致」不代表同源（att-006 的 0/11 一致只是用例全落在字面分支上）
    assert.notEqual(oldProblems(link, real).length > 0, serveRootProblems(link, real) !== null, "旧守卫与真源在此形态上必分歧");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // ④ 错误码级分歧（att-006 已记录的 "" 例）：旧守卫报 root_relative，真源报 root_missing
  assert.deepEqual(oldProblems("", "/work/myproject"), ["root_relative"], '旧守卫对 "" 报的是 root_relative');
  assert.equal(serveRootProblems("", "/work/myproject"), "root_missing", '真源对 "" 报 root_missing');
});

test("g-633 ⑨a 三份 §7 排障都含三条实测约束：root≠workspace / XDG_STATE_HOME 可写 / 同一 XDG 连跑两次", () => {
  for (const rel of ["plugins/claude-code/INSTALL.md", "plugins/codex/INSTALL.md", "plugins/opencode/INSTALL.md"]) {
    const text = read(rel);
    // 按**标题语义**定位排障章节，不硬编码编号（codex 多一节「认证」⇒ 排障是 §8）
    const h = /^##\s*[\d.]*\s*排障.*$/m.exec(text);
    assert.ok(h, `${rel}: 必须有「排障」章节`);
    const idx = h!.index;
    const after = text.slice(idx + h![0].length);
    const nextRel = after.search(/^##\s/m);
    const section7 = nextRel === -1 ? text.slice(idx) : text.slice(idx, idx + h![0].length + nextRel);
    assert.match(section7, /不得相同|必须不同/, `${rel} §7: 必须写明 --root 与 --workspace 不得相同`);
    assert.match(section7, /XDG_STATE_HOME[\s\S]{0,200}(可写|不可写)/, `${rel} §7: 必须写明 XDG_STATE_HOME 必须可写`);
    assert.match(section7, /同一\s*XDG[\s\S]{0,120}连跑两次|连跑两次[\s\S]{0,120}不(再)?连/, `${rel} §7: 必须写明同一 XDG 连跑两次第二次不连 MCP`);
  }
});

test("g-633 ⑧c §7 排障表与顶部声明不再自相矛盾", () => {
  const install = read("plugins/opencode/INSTALL.md");
  const troubleshoot = install.split("## 7.")[1] ?? "";
  assert.ok(troubleshoot.length > 0, "INSTALL.md 必须保留 §7 排障");
  // §7 仍保留「设 XDG_DATA_HOME 指向可写目录」的正确处置，且与顶部同一口径
  assert.match(troubleshoot, /XDG_DATA_HOME/, "§7 必须保留 XDG_DATA_HOME 排障处置");
  assert.doesNotMatch(
    troubleshoot,
    /(?<!不是|非|不)硬编码/,
    "§7 不得再出现「硬编码」肯定式断言（与顶部「由 XDG_DATA_HOME 派生」矛盾）",
  );
  // 顶部与 §7 必须使用同一机制表述
  const top = install.split("## 1.")[0];
  assert.match(top, /派生/, "顶部必须以「派生」口径说明日志路径");
});

test("g-633 ⑩（g-634 负向守卫）：三宿主插件目录不得残留旧跨宿主包名/旧插件名/旧 env 名", () => {
  const FORBIDDEN: Array<[string, RegExp]> = [
    ["旧 CLI 包名 dsh-graph-cli", /\bdsh-graph-cli\b/],
    ["旧服务包名/状态目录 dsh-graph-service", /\bdsh-graph-service\b/],
    ["旧技能包名 dsh-graph-skills", /\bdsh-graph-skills\b/],
    ["旧 MCP 包名 dsh-graph-mcp", /\bdsh-graph-mcp\b/],
    ["旧 CLI 名 dsh-cli", /\bdsh-cli\b/],
    ["旧环境变量 DSH_GRAPH_MCP_TOKEN", /\bDSH_GRAPH_MCP_TOKEN\b/],
    ["旧插件安装名 dsh-graph@dsh-graph", /\bdsh-graph@dsh-graph\b/],
    ["旧技能目录 skills/dsh-graph", /skills\/dsh-graph\b/],
    ["旧服务标识 dsh-graph-local", /\bdsh-graph-local\b/],
  ];
  const problems: string[] = [];
  for (const host of HOSTS) {
    for (const rel of walk(`plugins/${host}`)) {
      const text = read(rel);
      for (const [label, re] of FORBIDDEN) {
        if (re.test(text)) problems.push(`${rel}: 残留 ${label}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  // 负向对照：人为注入旧 env 名或旧插件名必须被拦截
  assert.ok(FORBIDDEN.some(([, re]) => re.test("Bearer ${DSH_GRAPH_MCP_TOKEN}")), "负向对照：旧 env 名必被拦截");
  assert.ok(FORBIDDEN.some(([, re]) => re.test("claude plugin install dsh-graph@dsh-graph")), "负向对照：旧插件名必被拦截");
});
