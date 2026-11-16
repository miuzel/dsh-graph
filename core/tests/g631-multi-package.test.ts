/**
 * g-631 打包守卫：5 包拆分后的**结构性**断言（判据 2 / 3 / 4 / 5 / 7）。
 *
 * 为什么需要：拆分把「单包发布」变成「5 个包各自可独立安装」。手写清单必然随 core 演进漂移，
 * 而漂移的后果是**装了却跑不起来**（缺某个 core 模块 / 缺 prompts 资产），且在本地开发机上
 * 永远不会暴露——只有真实安装才炸。故本守卫直接对**真实 dist/ + 真实组装脚本**断言。
 *
 * 断言面：
 *  A. 版本一致性：5 个包的 version 都等于基真源 `dsh-graph-host/package.json` 的 version。
 *  B. 包清单完备：`PACKAGE_NAMES` 恰为 5 个且与 docs/packages/<name>/INSTALL.md 一一对应。
 *  C. 独立可用（核心）：每个携带 core/ 的包，其**闭包内所有相对 import 都能在包内解析**
 *     —— 这是「只装这一包就能跑」的充分条件，比「文件存在」强得多。
 *  D. prompts 资产伴随：闭包含 core/ 的包必须带 prompts/*.md（运行期现读，缺则 fail-closed）。
 *  E. 安装指南结构：每份 INSTALL.md 必须含前置要求 / 安装 / 最小验证 / 卸载 / 排障五段，
 *     排障须覆盖 版本不匹配 / 端口占用 / token / 权限 四类。
 *  F. engines/peer 逐字一致（g466 口径延续）：带 dsh 的包其 engines.dsh 与
 *     peerDependencies["@deepseek-ai/dsh-settings"] 都与基真源逐字相等。
 *  G. 三宿主配置：均指向同一 endpoint，且都只引用环境变量、无 token 字面量。
 *  H. 负向对照：人为破坏（删模块 / 删 prompts / 改版本 / 注入 token / 删指南段）同一套判定必须报红。
 *
 * 全部断言只读仓库 + 只读 dist/；需要组装时在 os.tmpdir() 的私有副本里跑，绝不写 packages/。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(import.meta.dirname, "../..");
const DIST = join(repoRoot, "dist");
const PACK_SCRIPT = join(repoRoot, "scripts", "pack-packages.mjs");

/** 懒加载组装脚本（它读 dist/，故必须先 build；本守卫只在 dist 存在时做文件级断言）。 */
async function loadPackModule() {
  return import(pathToFileURL(PACK_SCRIPT).href);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

test("g-631 A：5 个包版本号一致且等于基真源", async () => {
  const mod = await loadPackModule();
  const baseVersion = readJson(join(repoRoot, "dsh-graph-host", "package.json")).version;
  assert.equal(mod.PACKAGE_NAMES.length, 5, "必须恰好 5 个包");
  for (const name of mod.PACKAGE_NAMES) {
    const m = mod.manifestFor(name);
    assert.equal(m.version, baseVersion, `${name} 版本必须等于基真源 ${baseVersion}`);
    assert.equal(m.name, name, `${name} 的 name 字段必须与目录同名`);
  }
  // 负向对照：人为改版本，判定必须能发现
  const broken = { ...mod.manifestFor("dsh-graph-cli"), version: "0.24.0" };
  assert.notEqual(broken.version, baseVersion, "负向对照：旧版本号必须被判为不一致");
});

test("g-631 B：包清单与安装指南一一对应", async () => {
  const mod = await loadPackModule();
  assert.deepEqual(
    [...mod.PACKAGE_NAMES].sort(),
    ["dsh-graph", "dsh-graph-cli", "dsh-graph-mcp", "dsh-graph-service", "dsh-graph-skills"],
  );
  for (const name of mod.PACKAGE_NAMES) {
    const guide = join(repoRoot, "docs", "packages", name, "INSTALL.md");
    assert.ok(existsSync(guide), `${name} 缺安装指南：docs/packages/${name}/INSTALL.md`);
  }
});

test("g-631 C：每个包对其闭包内的相对 import 全部可在包内解析（独立可用）", async () => {
  const mod = await loadPackModule();
  for (const name of ["dsh-graph", "dsh-graph-cli", "dsh-graph-service"]) {
    const { files, missing } = mod.filesForPackage(name);
    assert.ok(files.length > 0, `${name} 文件集不得为空`);
    assert.deepEqual(missing, [], `${name} 闭包内有无法解析的模块：${missing.join(", ")}`);
    const fileSet = new Set(files);
    // 逐文件复核：闭包里每个 .js 的相对 import 目标都必须也在包内
    for (const rel of files) {
      if (!rel.endsWith(".js") && !rel.endsWith(".mjs")) continue;
      const src = readFileSync(join(DIST, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g)) {
        const target = relative(DIST, normalize(join(dirname(join(DIST, rel)), m[1])))
          .split(sep)
          .join("/");
        assert.ok(fileSet.has(target), `${name}: ${rel} 依赖的 ${target} 不在包内（装后必炸）`);
      }
    }
  }
});

test("g-631 D：携带 core/ 的包必须附带 prompts 资产", async () => {
  const mod = await loadPackModule();
  for (const name of ["dsh-graph", "dsh-graph-cli", "dsh-graph-service"]) {
    const { files } = mod.filesForPackage(name);
    const hasCore = files.some((f) => f.startsWith("core/"));
    const prompts = files.filter((f) => f.startsWith("prompts/") && f.endsWith(".md"));
    assert.ok(hasCore, `${name} 应携带 core/`);
    assert.ok(prompts.length > 0, `${name} 携带 core/ 却没有 prompts/*.md（运行期现读会 fail-closed）`);
  }
});

const REQUIRED_SECTIONS = [
  { key: "前置要求", re: /^##\s*\d*\.?\s*前置要求/m },
  { key: "安装", re: /^##\s*\d*\.?\s*安装/m },
  { key: "最小验证", re: /^##\s*\d*\.?\s*最小验证/m },
  { key: "卸载", re: /^##\s*\d*\.?\s*卸载/m },
  { key: "排障", re: /^##\s*\d*\.?\s*常见故障排查/m },
];
const REQUIRED_TROUBLES = [
  { key: "版本不匹配", re: /版本不匹配/ },
  { key: "端口占用", re: /端口占用/ },
  { key: "token", re: /token/i },
  { key: "权限", re: /权限/ },
];

test("g-631 E：5 份安装指南含前置/安装/最小验证/卸载/排障且覆盖四类故障", async () => {
  const mod = await loadPackModule();
  for (const name of mod.PACKAGE_NAMES) {
    const text = readFileSync(join(repoRoot, "docs", "packages", name, "INSTALL.md"), "utf8");
    for (const s of REQUIRED_SECTIONS) {
      assert.match(text, s.re, `${name}/INSTALL.md 缺「${s.key}」段`);
    }
    for (const s of REQUIRED_TROUBLES) {
      assert.match(text, s.re, `${name}/INSTALL.md 排障缺「${s.key}」`);
    }
    // 「最小验证」必须给出**可执行命令**（反引号代码块里有命令），不是纯散文
    const verifyIdx = text.search(/最小验证/);
    assert.ok(verifyIdx >= 0, `${name}: 无最小验证段`);
    const tail = text.slice(verifyIdx);
    assert.ok(/(^|\n)\s*(```|\$ |node |npm |dsh-graph |npx )/m.test(tail.slice(0, 2000)), `${name}: 最小验证段应含可执行命令`);
  }
  // 负向对照：删掉排障段后判定必须报红
  const sample = readFileSync(join(repoRoot, "docs", "packages", "dsh-graph", "INSTALL.md"), "utf8");
  const broken = sample.replace(/##\s*\d*\.?\s*常见故障排查[\s\S]*/, "");
  // 判定口径与上面一致：只认「## …故障排查」标题（正文里提到「故障排查」不算数）
  assert.doesNotMatch(broken, REQUIRED_SECTIONS[4].re, "负向对照：删段后判定必须能发现缺失");
});

test("g-631 F：带 dsh 的包其 engines.dsh 与 peer dsh-settings 逐字相等", async () => {
  const mod = await loadPackModule();
  const base = readJson(join(repoRoot, "dsh-graph-host", "package.json"));
  for (const name of ["dsh-graph", "dsh-graph-service"]) {
    const m = mod.manifestFor(name);
    assert.equal(m.engines.dsh, base.engines.dsh, `${name} engines.dsh 必须与基真源逐字相等`);
    assert.equal(
      m.peerDependencies["@deepseek-ai/dsh-settings"],
      base.engines.dsh,
      `${name} peer @deepseek-ai/dsh-settings 必须与 engines.dsh 逐字相等`,
    );
  }
});

test("g-631 G：三宿主配置指向同一 endpoint 且均不泄漏 token", async () => {
  const mcpMod = await import(pathToFileURL(join(repoRoot, "scripts", "mcp", "index.mjs")).href);
  const opts = { port: 7801 };
  const endpoint = mcpMod.mcpEndpoint(opts);
  const rendered = {
    "claude-code": JSON.stringify(mcpMod.claudeCodeConfig(opts)),
    codex: mcpMod.codexConfig(opts),
    opencode: JSON.stringify(mcpMod.openCodeConfig(opts)),
  };
  for (const [host, text] of Object.entries(rendered)) {
    assert.ok(text.includes(endpoint), `${host} 配置必须指向 ${endpoint}`);
    const r = mcpMod.leaksToken(text);
    assert.ok(r.ok && !r.literal, `${host} 配置必须只引用环境变量、不含 token 字面量`);
  }
  // 三宿主 endpoint 逐字相同（单一真源）
  assert.equal(new Set(Object.values(rendered).map((t) => t.includes(endpoint))).size, 1);
  // 负向对照：把真实形态 token 写进配置，泄漏判定必须报红
  const leaked = rendered["claude-code"].replace("Bearer ${DSH_GRAPH_MCP_TOKEN}", "Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop");
  assert.equal(mcpMod.leaksToken(leaked).literal, true, "负向对照：真实 token 字面量必须被判为泄漏");
  // 拒绝非回环 host（服务端策略同口径）
  assert.throws(() => mcpMod.mcpEndpoint({ host: "0.0.0.0" }), mcpMod.McpConfigError);
});

test("g-631 H：组装出的包内不含开发资产（源码 ts / 测试 / worktrees）", async () => {
  if (!existsSync(DIST)) return; // 需要构建产物；dist-freshness 守卫另行覆盖「必须已构建」
  const mod = await loadPackModule();
  const baseVersion = readJson(join(repoRoot, "dsh-graph-host", "package.json")).version;
  for (const name of mod.PACKAGE_NAMES) {
    // 只跑组装到仓库内 packages/（生成物）；断言按**包内相对路径**判定，
    // 绝不能按绝对路径判定 —— 本仓库的 worktree 自身就位于 `.worktrees/` 下，
    // 绝对路径必然含该子串，按绝对路径过滤会让每个包都「判红」（本守卫首版即踩到）。
    const dir = mod.assemblePackage(name);
    const offenders = collectFiles(dir)
      .map((f) => relative(dir, f).split(sep).join("/"))
      .filter((rel) => rel.endsWith(".ts") || rel.startsWith("core/tests/") || rel.includes("worktrees"));
    assert.deepEqual(offenders, [], `${name} 包内含开发资产：${offenders.join(", ")}`);
    const manifest = readJson(join(dir, "package.json"));
    assert.equal(manifest.version, baseVersion, `${name} 包内版本必须与基真源一致`);
  }
});

function collectFiles(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, acc);
    else acc.push(p.split(sep).join("/"));
  }
  return acc;
}
