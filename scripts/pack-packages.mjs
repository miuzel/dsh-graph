#!/usr/bin/env node
/**
 * g-631：多包打包层 —— 从 `dist/` 组装 5 个**可独立安装**的 npm 包。
 *
 * 为什么是「打包层」而不是真正的 monorepo：
 *   `scripts/run-tests.mjs` 的 `TEST_GLOB = "core/tests/*.test.ts"` 与 `tsconfig.json` 的
 *   **精确枚举** include（g335 禁止 `core/**`）把源码位置钉死在仓库根。搬动 `core/` 或
 *   `dsh-graph-host/` 会同时击穿两道守卫，而收益为零（单用户场景）。故：
 *
 *     **源码位置一律不动；`packages/<name>/` 只是「从 dist/ 取产物组装」的打包层。**
 *
 * 单包独立性怎样保证（判据 2）：每个包的**文件集合由真实模块图推导**，不是手写清单
 *   （手写清单必然随 core 演进漂移，且漂移的后果是「装了却跑不起来」）。流程：
 *     ① 从入口（bin / index.js / service）沿 **ESM 静态与动态 import** 求传递闭包；
 *     ② 按目录归属把闭包分到各包：`core/service/**` → service；`core/cli/**`、`bin/**` → cli；
 *        其余 `core/**` → **共享运行时**（见下）；
 *     ③ 每个包把**自己闭包里的一切**都打进 tarball（含共享运行时）⇒ 单装任意一包即可运行，
 *        不需要先装别的包。
 *
 * 共享运行时为什么「复制」而不是「声明依赖」：
 *   CLI 与 SERVICE 共用 24 个 core 模块，且 `core/cli/main.js` 对 `core/service/serve.js` 是
 *   **动态** import（`serve` 子命令），`core/service/queries.js` 又反向依赖公共 core。
 *   若拆成一个 `dsh-graph-runtime` 依赖包，就要把这 24 个模块先切出去 —— 那是「搬源码」，
 *   直接撞 g335/g350。复制进各包只多占约 1.5MB 未压缩体积，换来的是
 *   **零包间依赖、装哪个用哪个**（判据 2 原话：「不假设其他包已装」）。
 *
 * 提示词资产（易错点）：`core/ops.js` 在**运行期**按 `new URL("../prompts/", import.meta.url)`
 *   现读正文。任何携带 `core/` 的包（插件本体 / cli / service）都**必须**把合并后的
 *   `prompts/` 放在与 `core/` 同级的位置，否则运行到读资产时才炸。本脚本按「闭包里是否含
 *   core/」自动附带，不靠人工记得。
 *
 * 用法：
 *   node scripts/pack-packages.mjs            # 组装到 packages/<name>/（覆盖生成物）
 *   node scripts/pack-packages.mjs --check    # 只校验不写盘（供守卫测试使用）
 *   node scripts/pack-packages.mjs --tarballs # 组装 + npm pack 到 out/ 并打 sha256 清单
 *
 * 前置：必须先 `bash scripts/build.sh`（本脚本**只读** dist/，从不构建）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const DIST = join(repoRoot, "dist");
/** 组装根：默认仓库内 `packages/`（已 gitignore）。测试经 `DSH_GRAPH_PACKAGES_DIR` 改指到
 *  os.tmpdir() 私有副本，避免「只读断言」顺手污染工作树（g-631 评审注记 1）。 */
const PACKAGES = process.env.DSH_GRAPH_PACKAGES_DIR
  ? resolve(process.env.DSH_GRAPH_PACKAGES_DIR)
  : join(repoRoot, "packages");

/** 所有包共享的版本号与宿主范围真源（g466：engines.dsh 与 peer dsh-settings 必须逐字相等）。 */
const HOST_PKG = JSON.parse(readFileSync(join(repoRoot, "dsh-graph-host", "package.json"), "utf8"));
export const VERSION = HOST_PKG.version;
export const DSH_RANGE = HOST_PKG.engines.dsh;
export const NODE_RANGE = HOST_PKG.engines.node;

export const PACKAGE_NAMES = [
  "dsh-graph",
  "goal-graph-cli",
  "goal-graph-service",
  "goal-graph-skills",
  "goal-graph-mcp",
];

/**
 * 模块归属表：给定 dist 内相对路径，判定它属于哪一类。
 * 顺序敏感（先匹配 cli/service 专属目录，其余 core 一律视为共享运行时）。
 */
export function classifyDistPath(rel) {
  const p = rel.split(sep).join("/");
  if (p === "bin/goal-graph.mjs") return "cli-entry";
  if (p.startsWith("core/cli/")) return "cli";
  if (p.startsWith("core/service/")) return "service";
  if (p.startsWith("core/")) return "shared";
  if (p.startsWith("prompts/")) return "prompts";
  if (p === "index.js" || p.startsWith("lib/") || p === "cordis.patch.yml" || p === "icon.svg") return "plugin";
  if (p.startsWith("diagrams/")) return "plugin";
  return "other";
}

/** 去注释后提取 ESM 依赖（注释里提到 `import("./ops.ts")` 会造成假依赖）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function moduleDeps(absFile) {
  if (!existsSync(absFile)) return [];
  const src = stripComments(readFileSync(absFile, "utf8"));
  const out = [];
  const re = /(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    if (!m[1].startsWith(".")) continue;
    out.push(normalize(join(dirname(absFile), m[1])));
  }
  return out;
}

/** 传递闭包（dist 内绝对路径集合）。不存在的模块（如指向未发布源码）跳过并记为告警。 */
export function closureOf(entries) {
  const seen = new Set();
  const missing = [];
  const stack = entries.map((e) => join(DIST, e));
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    if (!existsSync(file)) {
      missing.push(relative(DIST, file).split(sep).join("/"));
      continue;
    }
    seen.add(file);
    for (const d of moduleDeps(file)) stack.push(d);
  }
  return { files: [...seen].sort(), missing: [...new Set(missing)].sort() };
}

/** 各包的入口模块（相对 dist）与它需要的非代码资产。 */
export function packageEntries() {
  return {
    "dsh-graph": {
      entries: ["index.js", "lib/client.js", "lib/server-i18n.js"],
      // index.js 静态 import ./core/{ops,care,root,events}.js；宿主另读 lib/client.js。
      assets: ["prompts", "diagrams", "icon.svg", "cordis.patch.yml"],
    },
    "goal-graph-cli": {
      entries: ["bin/goal-graph.mjs", "core/cli/main.js"],
      // 携带 core/ ⇒ 必须带 prompts/（运行期现读）。cli 不读 diagrams/client。
      assets: ["prompts"],
    },
    "goal-graph-service": {
      entries: ["core/service/serve.js"],
      assets: ["prompts"],
    },
    "goal-graph-skills": { entries: [], assets: [] },
    "goal-graph-mcp": { entries: [], assets: [] },
  };
}

/**
 * 计算某包应携带的 dist 内文件列表（相对 dist 的正斜杠路径）。
 * 规则：入口闭包 + （闭包含 core/ 时）prompts/ 全量 + 该包 entries 里显式列出的资产。
 */
export function filesForPackage(name) {
  const spec = packageEntries()[name];
  if (!spec) throw new Error(`未知包：${name}`);
  if (name === "goal-graph-skills" || name === "goal-graph-mcp") return [];
  const { files, missing } = closureOf(spec.entries);
  const rels = new Set(files.map((f) => relative(DIST, f).split(sep).join("/")));
  const hasCore = [...rels].some((r) => r.startsWith("core/"));
  for (const asset of spec.assets) {
    const abs = join(DIST, asset);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      for (const f of walk(abs)) rels.add(relative(DIST, f).split(sep).join("/"));
    } else {
      rels.add(asset);
    }
  }
  // 兜底：携带 core/ 就必须有 prompt 资产，否则运行期才炸。
  if (hasCore && ![...rels].some((r) => r.startsWith("prompts/"))) {
    throw new Error(`${name}: 闭包含 core/ 但未携带 prompts/（core/ops.js 运行期现读）`);
  }
  return { files: [...rels].sort(), missing };
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const LICENSE = readFileSync(join(repoRoot, "dsh-graph-host", "LICENSE"), "utf8");
const REPO = HOST_PKG.repository;

/** g466 不变的共享字段：engines.dsh 与 peer dsh-settings **逐字相等**。 */
function hostEngineFields() {
  return {
    engines: { node: NODE_RANGE, dsh: DSH_RANGE },
    peerDependencies: { "@deepseek-ai/dsh-settings": DSH_RANGE },
    peerDependenciesMeta: { "@deepseek-ai/dsh-settings": { optional: true } },
  };
}

function baseManifest(name, description, extra = {}) {
  return {
    name,
    version: VERSION,
    description,
    license: "MIT",
    type: "module",
    repository: REPO,
    ...extra,
  };
}

/** 各包 package.json（唯一真源；生成物落 packages/<name>/package.json）。 */
export function manifestFor(name) {
  const common = { author: HOST_PKG.author };
  switch (name) {
    case "dsh-graph":
      return {
        ...baseManifest(
          "dsh-graph",
          "DSH plugin: graph-based goal management + two-dimensional swimlane kanban (graph_* tools).",
          {
            icon: "icon.svg",
            main: "index.js",
            exports: {
              ".": "./index.js",
              "./client": "./lib/client.js",
              "./cordis.patch.yml": "./cordis.patch.yml",
              "./package.json": "./package.json",
            },
            keywords: HOST_PKG.keywords,
            ...common,
            ...hostEngineFields(),
            peerDependencies: {
              ...hostEngineFields().peerDependencies,
              "@deepseek-ai/cordis": "^4.0.2",
              "@deepseek-ai/schemastery": "^3.18.2",
            },
            peerDependenciesMeta: {
              ...hostEngineFields().peerDependenciesMeta,
              "@deepseek-ai/cordis": { optional: true },
              "@deepseek-ai/schemastery": { optional: true },
            },
            dependencies: { yaml: "^2.9.0" },
            dsh: {
              bundle: { patch: "./cordis.patch.yml" },
              client: HOST_PKG.dsh.client,
              promptAssets: { layout: "merged", dir: "./prompts" },
            },
          },
        ),
      };
    case "goal-graph-cli":
      return baseManifest(
        "goal-graph-cli",
        "Command line for goal-graph boards: info / status / goal / version / sync / claim / submit / serve.",
        {
          bin: { "goal-graph": "./bin/goal-graph.mjs" },
          exports: { ".": "./core/cli/main.js", "./package.json": "./package.json" },
          files: ["bin/", "core/", "prompts/", "README.md", "INSTALL.md", "LICENSE"],
          keywords: ["goal-graph", "cli", "goals", "kanban"],
          ...common,
          engines: { node: NODE_RANGE },
          dependencies: { yaml: "^2.9.0" },
        },
      );
    case "goal-graph-service":
      return baseManifest(
        "goal-graph-service",
        "Local service for goal-graph: Web app + Web API + localhost MCP endpoint (127.0.0.1 only, read-only by default).",
        {
          main: "./core/service/serve.js",
          exports: {
            ".": "./core/service/serve.js",
            "./server": "./core/service/server.js",
            "./mcp": "./core/service/mcp.js",
            "./package.json": "./package.json",
          },
          files: ["core/", "prompts/", "README.md", "INSTALL.md", "LICENSE"],
          keywords: ["goal-graph", "service", "mcp", "web"],
          ...common,
          ...hostEngineFields(),
          dsh: { promptAssets: { layout: "merged", dir: "./prompts" } },
        },
      );
    case "goal-graph-skills":
      return baseManifest(
        "goal-graph-skills",
        "Agent skills for goal-graph / dsh-graph: dsh-graph (board usage) and dsh-graph-supervisor (supervisor guide).",
        {
          main: "./install.mjs",
          bin: { "goal-graph-skills": "./bin/goal-graph-skills.mjs" },
          exports: { ".": "./install.mjs", "./package.json": "./package.json" },
          files: ["skills/", "install.mjs", "bin/", "README.md", "INSTALL.md", "LICENSE"],
          keywords: ["goal-graph", "skills", "agent"],
          ...common,
          engines: { node: NODE_RANGE },
        },
      );
    case "goal-graph-mcp":
      return baseManifest(
        "goal-graph-mcp",
        "MCP adapter for goal-graph with config generators for Claude Code, Codex and OpenCode (no tokens in config files).",
        {
          main: "./lib/index.mjs",
          bin: { "goal-graph-mcp": "./bin/goal-graph-mcp.mjs" },
          exports: { ".": "./lib/index.mjs", "./package.json": "./package.json" },
          files: ["lib/", "bin/", "README.md", "INSTALL.md", "LICENSE"],
          keywords: ["goal-graph", "mcp", "claude-code", "codex", "opencode"],
          ...common,
          engines: { node: NODE_RANGE },
        },
      );
    default:
      throw new Error(`未知包：${name}`);
  }
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

/** 把 dist 内文件复制进包目录（保持相对结构）。 */
function copyDistFiles(pkgDir, rels) {
  for (const rel of rels) {
    const from = join(DIST, rel);
    const to = join(pkgDir, rel);
    ensureDir(dirname(to));
    cpSync(from, to);
    if (rel === "bin/goal-graph.mjs") {
      // 可执行位必须保留，否则全局安装后 CLI 不可直接调用。
      chmodSync(to, 0o755);
    }
  }
}

/** skills 包的源：仓库根 prompts/ 下的技能正文（dsh-graph / dsh-graph-supervisor）。 */
const SKILL_SOURCES = [
  {
    id: "dsh-graph",
    files: [
      { from: "prompts/usage.zh.md", to: "SKILL.zh.md" },
      { from: "prompts/usage.en.md", to: "SKILL.en.md" },
      { from: "prompts/help.zh.md", to: "REFERENCE.zh.md" },
      { from: "prompts/help.en.md", to: "REFERENCE.en.md" },
    ],
  },
  {
    id: "dsh-graph-supervisor",
    files: [
      { from: "prompts/supervisor-guide.zh.md", to: "SKILL.zh.md" },
      { from: "prompts/supervisor-guide.en.md", to: "SKILL.en.md" },
    ],
  },
];

function writeSkillsPackage(pkgDir) {
  for (const skill of SKILL_SOURCES) {
    for (const f of skill.files) {
      const src = join(repoRoot, f.from);
      if (!existsSync(src)) throw new Error(`skills 源缺失：${f.from}`);
      const to = join(pkgDir, "skills", skill.id, f.to);
      ensureDir(dirname(to));
      cpSync(src, to);
    }
    // SKILL.md = 中文正文 + frontmatter（DSH/Claude 技能入口约定：name + description）
    const zh = readFileSync(join(pkgDir, "skills", skill.id, "SKILL.zh.md"), "utf8");
    const firstLine = zh.split("\n").find((l) => l.trim()) ?? "";
    const desc = firstLine.replace(/^#+\s*/, "").trim().slice(0, 200);
    writeFileSync(
      join(pkgDir, "skills", skill.id, "SKILL.md"),
      `---\nname: ${skill.id}\ndescription: ${desc}\n---\n\n${zh}`,
    );
  }
  cpSync(join(repoRoot, "scripts", "pack-skills-install.mjs"), join(pkgDir, "install.mjs"));
  ensureDir(join(pkgDir, "bin"));
  // bin 入口必须是**真正的启动器**：既 import 模块，又显式调用它的 main。
  // 只 `import("../install.mjs")` 时，模块自身的 `argv[1] === import.meta.url` 判定不成立
  // （argv[1] 是本包装器的路径），于是 main() 永不执行、命令静默 exit 0 —— 实测踩到过。
  writeFileSync(
    join(pkgDir, "bin", "goal-graph-skills.mjs"),
    [
      "#!/usr/bin/env node",
      'import { main } from "../install.mjs";',
      'import { fileURLToPath } from "node:url";',
      "try {",
      "  process.exitCode = main(process.argv.slice(2));",
      "} catch (e) {",
      '  process.stderr.write(`goal-graph-skills: ${e.message}\\n`);',
      "  process.exitCode = 1;",
      "}",
      "",
    ].join("\n"),
  );
  chmodSync(join(pkgDir, "bin", "goal-graph-skills.mjs"), 0o755);
}

/** mcp 包源：仓库 scripts/mcp/ 下的适配器与三宿主配置生成器。 */
function writeMcpPackage(pkgDir) {
  cpSync(join(repoRoot, "scripts", "mcp"), join(pkgDir, "lib"), { recursive: true });
  ensureDir(join(pkgDir, "bin"));
  // 同上：必须是启动器，不能只 import（否则 main 不执行、静默 exit 0）。
  writeFileSync(
    join(pkgDir, "bin", "goal-graph-mcp.mjs"),
    [
      "#!/usr/bin/env node",
      'import { run, usage } from "../lib/cli.mjs";',
      "try {",
      "  const r = run(process.argv.slice(2));",
      "  process.stdout.write(r.out);",
      "  process.exitCode = r.code;",
      "} catch (e) {",
      '  process.stderr.write(`goal-graph-mcp: ${e.message}\\n\\n${usage()}\\n`);',
      "  process.exitCode = 2;",
      "}",
      "",
    ].join("\n"),
  );
  chmodSync(join(pkgDir, "bin", "goal-graph-mcp.mjs"), 0o755);
}

/** 从 dsh-graph-host/package.json 派生插件的发布形态（与 build.sh 生成 dist/package.json 同口径）。 */
function writePluginManifest(pkgDir, manifest) {
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/** 组装单个包到 packages/<name>/。 */
export function assemblePackage(name) {
  const pkgDir = join(PACKAGES, name);
  rmSync(pkgDir, { recursive: true, force: true });
  ensureDir(pkgDir);
  const manifest = manifestFor(name);
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(pkgDir, "LICENSE"), LICENSE);

  if (name === "goal-graph-skills") {
    writeSkillsPackage(pkgDir);
  } else if (name === "goal-graph-mcp") {
    writeMcpPackage(pkgDir);
  } else {
    const { files, missing } = filesForPackage(name);
    copyDistFiles(pkgDir, files);
    if (name === "dsh-graph") {
      // 插件本体：README 用 host 的（用户面向），另附独立安装指南。
      cpSync(join(repoRoot, "dsh-graph-host", "README.md"), join(pkgDir, "README.md"));
      // dsh 字段已在 manifest 内写入发布形态（layout: merged）。
      writePluginManifest(pkgDir, manifest);
    }
    if (missing.length > 0) {
      process.stderr.write(`⚠️ ${name}: 模块图中不存在的引用（已跳过）：${missing.join(", ")}\n`);
    }
  }
  // 每包一致的 README/INSTALL 由 docs/packages/ 真源复制（单一真源，不手写两份）。
  const docsDir = join(repoRoot, "docs", "packages");
  for (const f of ["README.md", "INSTALL.md"]) {
    const src = join(docsDir, name, f);
    if (existsSync(src)) cpSync(src, join(pkgDir, f));
  }
  return pkgDir;
}

export function assembleAll() {
  if (!existsSync(DIST)) throw new Error("缺少 dist/：请先运行 bash scripts/build.sh");
  const out = [];
  for (const name of PACKAGE_NAMES) out.push(assemblePackage(name));
  return out;
}

/** 计算 tarball：npm pack --dry-run 拿文件清单，再真实 pack。 */
export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function packTarballs(outDir) {
  ensureDir(outDir);
  const lines = [];
  for (const name of PACKAGE_NAMES) {
    const pkgDir = join(PACKAGES, name);
    const r = spawnSync("npm", ["pack", "--json", "--pack-destination", outDir], {
      cwd: pkgDir,
      encoding: "utf8",
      env: { ...process.env, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" },
    });
    if (r.status !== 0) throw new Error(`${name}: npm pack 失败\n${r.stderr}`);
    // npm ≥ 11 的 `--json` 输出是「包名 → 元信息」的对象；npm 10 及更早是单元素数组。
    // 两种形状都接受，避免打包脚本在 npm 版本间静默失效。
    const parsed = JSON.parse(r.stdout);
    const meta = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]];
    const file = join(outDir, meta.filename);
    const bytes = statSync(file).size;
    lines.push({ name, file: meta.filename, sha256: sha256(file), bytes, entries: meta.entryCount });
  }
  return lines;
}

const isMain = process.argv[1] && normalize(process.argv[1]) === normalize(join(import.meta.dirname, "pack-packages.mjs"));

if (isMain) {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const wantTarballs = args.includes("--tarballs");
  if (!existsSync(DIST)) {
    console.error("❌ 缺少 dist/：请先运行 bash scripts/build.sh（本脚本只读 dist/，不构建）");
    process.exit(1);
  }
  // --check：只校验包集合与版本自洽，不落盘。
  if (checkOnly) {
    for (const name of PACKAGE_NAMES) {
      const m = manifestFor(name);
      if (m.version !== VERSION) throw new Error(`${name} 版本不一致：${m.version} != ${VERSION}`);
      if (name !== "goal-graph-skills" && name !== "goal-graph-mcp") filesForPackage(name);
    }
    console.log(`✅ 校验通过：${PACKAGE_NAMES.length} 个包，版本统一 ${VERSION}`);
    process.exit(0);
  }
  const dirs = assembleAll();
  for (const d of dirs) console.log(`  → ${relative(repoRoot, d)}`);
  console.log(`✅ 已组装 ${dirs.length} 个包（版本 ${VERSION}）`);
  if (wantTarballs) {
    const outDir = join(repoRoot, "out");
    const rows = await packTarballs(outDir);
    const lines = ["# dsh-graph / goal-graph v" + VERSION + " tarball 清单（sha256）", ""];
    for (const r of rows) {
      lines.push(`${r.name}\t${r.file}\tsha256=${r.sha256}\tbytes=${r.bytes}\tfiles=${r.entries}`);
    }
    writeFileSync(join(outDir, "SHA256SUMS.txt"), lines.join("\n") + "\n");
    console.log(`✅ tarball 与 sha256 清单：${relative(repoRoot, join(outDir, "SHA256SUMS.txt"))}`);
  }
}
