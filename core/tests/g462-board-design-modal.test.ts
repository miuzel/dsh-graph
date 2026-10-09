/**
 * core/tests/g462-board-design-modal.test.ts
 *
 * g-462（v0.20.0 泳道）：看板标题栏「Graph 设计」入口 + 「Graph 设计哲学」弹窗
 * （内嵌 g-460 定稿的 lifecycle/workflow 两张 archify 交互图）+ 宿主**只读** HTML 路由 + 随包发布。
 *
 * 六族断言（全部打在**真实产物**上：dist/index.js、dist/lib/client.js、dist/diagrams/、build.sh）：
 *  A. 只读路由：白名单仅两张图；未知名 / 目录穿越（`../`、绝对路径、编码变体、反斜杠）/ 非 `.html`
 *     一律拒绝；GET/HEAD 命中即 `text/html; charset=utf-8` 且与源产物**逐字节一致**；POST 405；
 *     **路由块内不得出现任何写文件 API**。
 *  B. 只看板标题栏：入口在 `.dg-head`（与刷新/记忆同容器）+ 折叠弹层同一处派生；`design.btn`
 *     在 kanban 源里**只出现在看板返回体之前**（⇒ 不占看板主区域）；弹窗是 portal 浮层。
 *  C. 弹窗：两张图（lifecycle/workflow）都在，且 iframe 走宿主只读路由；切页签是本地状态。
 *  D. i18n：zh/en 键完全对称、design 键齐全、en 无 CJK、notice 如实声明「暂不支持自定义」；
 *     用户可见文案**零内部化**（不得出现目标编号 `g-4xx` / 文件路径 / 行号 / 函数名 / `§` 章节序号），
 *     且路线图是 notice 下方的**独立小节**、以**章节名**指路（`D2` 负向对照：塞回编号 / `§13` /
 *     `core/ops.ts` / `renderDiagram()` ⇒ 必红；拿掉小节容器 / 挪到 notice 之上 / 新增页签 ⇒ 必红）。
 *  E. 随包发布：build.sh 显式 `cp -r` diagrams；dist/diagrams 与源 sha256 逐字节一致；
 *     `npm pack --dry-run` 的文件清单确实含两张图（判据「pack 含图文件」）。
 *  F. 离线自包含：图 HTML 无任何外部网络子资源（无 `<link`/`<img`/`src=http`/`@import`/`url(http`），
 *     字体已是 `data:font/woff2;base64` 内嵌。
 *
 * 负向对照（证明断言非空转）：
 *  - 路由：把 dist/index.js 复制到仓库内 tmp 镜像（`node_modules` 仍可解析）后**真跑一次文本变异**
 *    （白名单放宽成「任意名字」）⇒ 未知名请求从 404 变 200 ⇒ 本套件的 404 断言必红；
 *  - 入口：对真实 client bundle 做**文本变异**（拿掉「Graph 设计」入口）⇒ 入口结构断言必红；
 *    变异只在内存里重放，真实文件逐字节不变。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { apply, DESIGN_DIAGRAM_ROUTE, DESIGN_DIAGRAM_FILES, resolveDesignDiagramRequest } from "../../dist/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const distRoot = join(repoRoot, "dist");
const hostIndex = join(repoRoot, "dsh-graph-host/index.js");
const buildScript = join(repoRoot, "scripts/build.sh");
const kanbanSrcPath = join(repoRoot, "dsh-graph-host/lib/client/kanban.js");
const designModalPath = join(repoRoot, "dsh-graph-host/lib/client/design-modal.js");
const i18nSrcPath = join(repoRoot, "dsh-graph-host/lib/client/i18n.js");
const bundlePath = join(distRoot, "lib/client.js");
const diagramsSrcDir = join(repoRoot, "dsh-graph-host/diagrams");
const diagramsDistDir = join(distRoot, "diagrams");

const LIFECYCLE = "design-philosophy.lifecycle.html";
const WORKFLOW = "design-philosophy.workflow.html";
const DIAGRAM_ROUTE = "/api/dsh-graph/diagram";
const HTML_CT = "text/html; charset=utf-8";

const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------- 宿主桩（只捕获路由）

function captureRoutes(): Map<string, any> {
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def); return () => {}; } };
  const ctx: any = {
    inject: () => ctx,
    effect: (fn: any) => fn(),
    get: (name: string) => (name === "webServer" ? webServer : null),
    tools: { register: () => {}, get: () => ({}) },
    webServer,
  };
  apply(ctx, {});
  return routes;
}

function fakeRes() {
  const res: any = {
    code: 0, headers: null, body: null,
    writeHead(code: number, headers: any) { this.code = code; this.headers = headers; },
    end(body: any) { this.body = body ?? null; },
  };
  return res;
}

const routes = (() => {
  const r = captureRoutes();
  const route = r.get(DIAGRAM_ROUTE);
  assert.ok(route, `宿主必须注册只读图路由 ${DIAGRAM_ROUTE}`);
  return { route };
})();

async function callDiagram(url: string, method = "GET") {
  const res = fakeRes();
  await routes.route.handler({ method, url, headers: {} }, res);
  return res;
}

const bodyOf = (res: any) => (Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body ?? ""), "utf8"));
const jsonError = (res: any) => { try { return JSON.parse(String(res.body)); } catch { return null; } };

// ================================================================ A. 只读路由

test("g-462 A1：白名单两张图都能以 text/html; charset=utf-8 读出，且与源产物逐字节一致", async () => {
  assert.deepEqual([...DESIGN_DIAGRAM_FILES].sort(), [LIFECYCLE, WORKFLOW].sort(), "白名单必须恰是 g-460 的两张图");
  assert.equal(DESIGN_DIAGRAM_ROUTE, DIAGRAM_ROUTE);
  for (const name of [LIFECYCLE, WORKFLOW]) {
    const res = await callDiagram(`${DIAGRAM_ROUTE}/${name}`);
    assert.equal(res.code, 200, `${name} 必须 200`);
    assert.equal(res.headers["content-type"], HTML_CT, `${name} 必须是 text/html; charset=utf-8`);
    const srcBuf = readFileSync(join(diagramsSrcDir, name));
    const distBuf = readFileSync(join(diagramsDistDir, name));
    assert.equal(res.body.length, srcBuf.length, `${name} 响应长度必须等于产物字节数`);
    assert.equal(sha256(bodyOf(res)), sha256(srcBuf), `${name} 响应必须与源产物 sha256 相等`);
    assert.equal(sha256(distBuf), sha256(srcBuf), `${name} dist 产物必须与源逐字节一致`);
  }
});

test("g-462 A2：未知名 / 目录穿越 / 绝对路径 / 编码变体 / 非 html 一律拒绝（404/400），无写路径", async () => {
  const rejected: Array<[string, number, string]> = [
    [`${DIAGRAM_ROUTE}/design-philosophy.secret.html`, 404, "未知名"],
    [`${DIAGRAM_ROUTE}/unknown.html`, 404, "未知名"],
    [`${DIAGRAM_ROUTE}`, 404, "缺名字"],
    [`${DIAGRAM_ROUTE}/`, 400, "空名字"],
    [`${DIAGRAM_ROUTE}/../index.js`, 404, "`../`（URL 归一化后已不在前缀下）"],
    [`${DIAGRAM_ROUTE}/%2e%2e%2findex.js`, 400, "URL 编码的 `..`"],
    [`${DIAGRAM_ROUTE}/..%2f..%2findex.js`, 400, "编码变体"],
    [`${DIAGRAM_ROUTE}/%2e%2e/%2e%2e/index.js`, 404, "WHATWG URL 把 `%2e%2e` 视作 `..` 段 ⇒ 归一化后已不在前缀下"],
    [`${DIAGRAM_ROUTE}//etc/passwd`, 400, "绝对路径"],
    [`${DIAGRAM_ROUTE}/C:%5Cwindows%5Cwin.ini`, 400, "反斜杠/盘符"],
    [`${DIAGRAM_ROUTE}/design-philosophy.lifecycle.html%00.png`, 400, "NUL 变体"],
    [`${DIAGRAM_ROUTE}/DESIGN-PHILOSOPHY.LIFECYCLE.HTML`, 400, "大小写变体"],
    [`${DIAGRAM_ROUTE}/design-philosophy.lifecycle.png`, 400, "非 .html（png 不内联）"],
    [`${DIAGRAM_ROUTE}/design-philosophy.lifecycle.json`, 400, "非 .html（archify 源）"],
  ];
  for (const [url, expected, why] of rejected) {
    // 两层都钉：① 纯函数解析器（策略：语法闸 + 白名单闸）；② 真实路由 handler（策略 + 文件存在闸）。
    // 只钉 ② 会漏检「白名单被放宽」—— 放宽后未知名虽被策略放行，仍会因文件不存在而在 ② 上回落 404
    // （A3 用真实可执行变异证实了这一点）。
    assert.equal(resolveDesignDiagramRequest(url).status, expected, `[resolver] ${url}（${why}）必须 ${expected}`);
    const res = await callDiagram(url);
    assert.equal(res.code, expected, `[route] ${url}（${why}）必须 ${expected}（实得 ${res.code}）`);
    assert.equal(res.headers?.["content-type"], "application/json; charset=utf-8", `${url} 拒绝响应必须是 JSON`);
    assert.ok(jsonError(res)?.error, `${url} 拒绝响应必须带可上报原因`);
  }
  // 方法面：只读路由只认 GET/HEAD。
  const post = await callDiagram(`${DIAGRAM_ROUTE}/${LIFECYCLE}`, "POST");
  assert.equal(post.code, 405, "POST 必须 405（无任何写路径）");
  for (const m of ["PUT", "DELETE", "PATCH"]) {
    assert.equal((await callDiagram(`${DIAGRAM_ROUTE}/${LIFECYCLE}`, m)).code, 405, `${m} 必须 405`);
  }
  // HEAD：200 + 同一个 content-type，但不回 body。
  const head = await callDiagram(`${DIAGRAM_ROUTE}/${LIFECYCLE}`, "HEAD");
  assert.equal(head.code, 200);
  assert.equal(head.headers["content-type"], HTML_CT);
  assert.equal(head.body, null, "HEAD 不得回 body");

  // 结构性：路由块内**零写文件 API**（只读是断言，不是散文）。
  const src = readFileSync(hostIndex, "utf8");
  const start = src.indexOf("// g-462：设计哲学交互图只读服务");
  const end = src.indexOf('path: "/api/dsh-graph/attachments"', start);
  assert.ok(start > 0 && end > start, "必须能在宿主源里定位 g-462 路由块");
  const block = src.slice(start, end);
  assert.match(block, /readFileSync\(new URL\(`\.\/diagrams\/\$\{decision\.name\}`, import\.meta\.url\)\)/, "路由必须以 readFileSync 现读 dist/diagrams");
  assert.doesNotMatch(
    block,
    /writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync|createWriteStream|truncateSync|chmodSync/,
    "只读路由块内不得出现任何写路径",
  );
});

async function routeStatus(url: string): Promise<number> {
  const res = fakeRes();
  await routes.route.handler({ method: "GET", url, headers: {} }, res);
  return res.code;
}

test("g-462 A3（负向对照·真实可执行变异）：白名单放宽成「任意名字」⇒ 未知名在策略层从 404 变 200", async () => {
  // 在仓库内 tmp 镜像里真跑一次 dist/index.js 的文本变异（放仓库内 ⇒ `yaml` 等依赖仍可解析）。
  const tmpBase = join(repoRoot, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const mirrorRoot = mkdtempSync(join(tmpBase, "g462-neg-"));
  try {
    cpSync(distRoot, join(mirrorRoot, "dist"), { recursive: true, dereference: true });
    const mirrorIndex = join(mirrorRoot, "dist/index.js");
    const before = readFileSync(mirrorIndex, "utf8");
    const widened = before.replace(
      'if (!DESIGN_DIAGRAM_FILES.includes(name)) return { status: 404, reason: "unknown-diagram" };',
      'if (false) return { status: 404, reason: "unknown-diagram" };',
    );
    assert.notEqual(widened, before, "变异必须命中白名单判定那一行");
    writeFileSync(mirrorIndex, widened, "utf8");

    const mod: any = await import(pathToFileURL(mirrorIndex).href);
    // 基线（真实产物）—— 策略层与路由层都拒绝未知名。
    assert.equal(resolveDesignDiagramRequest(`${DIAGRAM_ROUTE}/unknown.html`).status, 404, "真实产物策略层必须拒绝未知名");
    assert.equal(await routeStatus(`${DIAGRAM_ROUTE}/unknown.html`), 404, "真实产物路由层必须拒绝未知名");
    // 放宽白名单后：**策略层**放行；**路由层**仍回落 404，只是因为 `dist/diagrams/unknown.html` 不存在。
    // ⇒ 只钉路由层会让「白名单被放宽」逃检，故 A2 同时钉策略层（本变异即其判别力来源）。
    assert.equal(mod.resolveDesignDiagramRequest(`${DIAGRAM_ROUTE}/unknown.html`).status, 200,
      "放宽白名单后未知名必须在策略层被放行");
    assert.equal(mod.resolveDesignDiagramRequest(`${DIAGRAM_ROUTE}/design-philosophy.secret.html`).status, 200,
      "放宽白名单后任何合法名字都必须在策略层被放行");
    // 但名字合法性（穿越/编码/非 html）仍由语法闸拒绝：变异只放宽白名单、没有放宽语法闸。
    assert.equal(mod.resolveDesignDiagramRequest(`${DIAGRAM_ROUTE}/%2e%2e%2findex.js`).status, 400);
    assert.equal(mod.resolveDesignDiagramRequest(`${DIAGRAM_ROUTE}/design-philosophy.lifecycle.png`).status, 400);
  } finally {
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
});

// ================================================================ B/C. 入口与弹窗

/** 入口/弹窗结构断言（纯函数：文本进、问题清单出）—— 便于在内存变异上重放。 */
function entryProblems(opts: { kanban: string; bundle: string; modal: string }): string[] {
  const problems: string[] = [];
  const { kanban, bundle, modal } = opts;
  // ① 平铺态：与刷新/记忆同一行（`.dg-head` 容器内），且有 toolbarCollapsed 门控与 title/onClick。
  if (!/h\("div", \{ style: S\.head, className: "dg-head", ref: headRef \}/.test(kanban)) {
    problems.push("找不到看板标题栏容器 .dg-head");
  }
  if (!/toolbarCollapsed \? null : h\("button", \{\s*style: tbBtnStyle,\s*className: "dg-btn dg-design-btn",\s*title: dgT\("design\.title"\),\s*onClick: \(\) => setShowDesignModal\(true\),\s*\}, dgT\("design\.btn"\),?/.test(kanban)) {
    problems.push("平铺工具条缺少「Graph 设计」按钮（必须与刷新/记忆并列、走 tbBtnStyle）");
  }
  // ② 折叠弹层：同一处派生（headPanelRows 里必须有 design 行）。
  const rowStart = kanban.indexOf("const headPanelRows = [");
  const rowEnd = kanban.indexOf("const headPanelItems", rowStart);
  const rows = rowStart >= 0 && rowEnd > rowStart ? kanban.slice(rowStart, rowEnd) : "";
  if (!/key: "design", label: dgT\("design\.btn"\), title: dgT\("design\.title"\), action: \(\) => setShowDesignModal\(true\)/.test(rows)) {
    problems.push("折叠弹层候选缺少 design 行（窄档必须同样可达）");
  }
  // ③ 不占看板主区域：`design.btn` 的所有出现都必须在**泳道网格**（看板主区域）之前。
  const boardBodyAt = kanban.indexOf('h("div", { style: { ...S.grid, gridTemplateColumns: gridCols } }');
  const btnUses = [...kanban.matchAll(/dgT\("design\.btn"\)/g)].map((m) => m.index ?? -1);
  if (btnUses.length !== 2) problems.push(`dgT("design.btn") 应恰好 2 处（平铺 + 弹层），实得 ${btnUses.length}`);
  if (boardBodyAt < 0) problems.push("找不到看板主区域（泳道网格）锚点");
  else if (btnUses.some((i) => i > boardBodyAt)) problems.push("入口出现在看板主区域（泳道网格）之内/之后 —— 不得占用看板主区域");
  // ④ 弹窗：portal 浮层 + 稳定 key + 两张图 + 只读路由 + 本地切页签。
  if (!/showDesignModal\s*\n?\s*\? h\(DesignPhilosophyModal, \{\s*key: "dg-design-modal",\s*onClose: \(\) => setShowDesignModal\(false\),/.test(kanban)) {
    problems.push("看板未挂载 DesignPhilosophyModal（或缺少稳定 key）");
  }
  const hasModalFlag = /showMemoryModal \|\| showDesignModal \|\| showTagFilterModal/.test(kanban);
  if (!hasModalFlag) problems.push("hasModal 未纳入 showDesignModal（弹窗打开时看板遮罩语义会漂移）");
  if (!/dgOverlay\(\{ style: S\.overlay, \.\.\.backdropGuard \}/.test(modal)) problems.push("弹窗必须是 dgOverlay portal");
  for (const f of [LIFECYCLE, WORKFLOW]) {
    if (!modal.includes(f)) problems.push(`弹窗缺少图产物引用 ${f}`);
  }
  if (!/const src = "\/api\/dsh-graph\/diagram\/" \+ active\.file;/.test(modal)) problems.push("iframe 必须走宿主只读路由（相对同源路径）");
  if (!/h\("iframe", \{/.test(modal)) problems.push("弹窗缺少 iframe 内嵌");
  if (!/React\.useState\("lifecycle"\)/.test(modal)) problems.push("弹窗缺少页签本地状态（可切换）");
  if (!/dgT\("design\.notice"\)/.test(modal)) problems.push("弹窗缺少如实声明文案");
  if (!/className: "dg-design-roadmap"/.test(modal) || !/dgT\("design\.roadmap"\)/.test(modal)) {
    problems.push("弹窗缺少 notice 下方的独立路线图小节（dg-design-roadmap 走 design.roadmap 文案）");
  }
  if (!/const DESIGN_DIAGRAM_TABS = \[/.test(modal)) problems.push("弹窗缺少图页签定义");
  // ⑤ 生成物里真的有（防「源改了没重建」的假绿）。
  if (!bundle.includes("function DesignPhilosophyModal(")) problems.push("dist/lib/client.js 未包含 DesignPhilosophyModal（需重建）");
  if (!bundle.includes("dg-design-modal")) problems.push("dist/lib/client.js 未包含弹窗挂载点");
  if (!bundle.includes("dg-design-roadmap")) problems.push("dist/lib/client.js 未包含路线图小节（需重建）");
  if (!bundle.includes(LIFECYCLE) || !bundle.includes(WORKFLOW)) problems.push("dist/lib/client.js 未内嵌两张图名");
  return problems;
}

const readAll = () => ({
  kanban: readFileSync(kanbanSrcPath, "utf8"),
  bundle: readFileSync(bundlePath, "utf8"),
  modal: readFileSync(designModalPath, "utf8"),
});

test("g-462 B/C1：标题栏入口（与刷新/记忆并列）+ 弹窗（两张图、只读路由、如实声明）结构齐全", () => {
  assert.deepEqual(entryProblems(readAll()), [], "入口与弹窗结构断言必须全绿");
});

test("g-462 B/C2（负向对照·内存变异）：拿掉「Graph 设计」入口 ⇒ 入口断言必红；恢复后绿", () => {
  const real = readAll();
  assert.deepEqual(entryProblems(real), [], "基线必须为绿");
  // 变异 ①：删掉平铺按钮块（模拟「入口被拿掉」）。
  const FLAT_BLOCK = /          \/\/ g-462：Graph 设计入口[\s\S]*?\}, dgT\("design\.btn"\)\),\n/;
  const noFlat = real.kanban.replace(FLAT_BLOCK, "");
  assert.notEqual(noFlat, real.kanban, "变异 ① 必须命中平铺入口块");
  assert.ok(entryProblems({ ...real, kanban: noFlat }).length > 0, "拿掉平铺入口后必须报红");
  // 变异 ②：把入口从折叠弹层拿掉。
  const noPanel = real.kanban.replace(
    /\s*\{ key: "design", label: dgT\("design\.btn"\), title: dgT\("design\.title"\), action: \(\) => setShowDesignModal\(true\) \},/,
    "",
  );
  assert.notEqual(noPanel, real.kanban, "变异 ② 必须命中弹层 design 行");
  assert.ok(entryProblems({ ...real, kanban: noPanel }).length > 0, "拿掉弹层入口后必须报红");
  // 变异 ③：把入口挪进看板主区域（泳道网格之内）⇒ 「不占主区域」断言必红。
  const noFlatAgain = real.kanban.replace(FLAT_BLOCK, "");
  const movedIntoBody = noFlatAgain.replace(
    'h("div", { style: { ...S.grid, gridTemplateColumns: gridCols } },',
    '$& h("button", { style: tbBtnStyle, className: "dg-btn dg-design-btn", title: dgT("design.title"), onClick: () => setShowDesignModal(true) }, dgT("design.btn")),',
  );
  assert.notEqual(movedIntoBody, noFlatAgain, "变异 ③ 必须命中看板主区域锚点");
  assert.ok(
    entryProblems({ ...real, kanban: movedIntoBody }).some((p) => p.includes("不得占用看板主区域")),
    "入口挪进看板主区域后必须报红",
  );
  // 变异 ④：生成物里没有该组件（源改了不重建）。
  assert.ok(entryProblems({ ...real, bundle: real.bundle.replace(/function DesignPhilosophyModal\(/g, "function XDesignPhilosophyModal(") }).length > 0,
    "bundle 缺组件时必须报红");
  // 恢复：真实文件重新检查必须全绿，且真实文件逐字节未变。
  assert.deepEqual(entryProblems(real), [], "恢复后必须重新全绿");
  assert.deepEqual(readAll(), real, "负向对照必须是 hermetic 的（真实文件零改动）");
});

// ================================================================ D. i18n

function loadI18n() {
  const sandbox: any = { React: {} };
  const src = readFileSync(i18nSrcPath, "utf8");
  vm.runInNewContext(src + "; this.zh = zh; this.en = en;", sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

const DESIGN_KEYS = [
  "design.btn", "design.title", "design.tab.lifecycle", "design.tab.workflow",
  "design.openNewTab", "design.notice", "design.roadmap",
];

test("g-462 D1：design 键 zh/en 双语对称、en 无 CJK、notice 如实声明能力边界", () => {
  const { zh, en } = loadI18n();
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "i18n zh/en 键必须完全对称");
  for (const key of DESIGN_KEYS) {
    assert.ok(typeof zh[key] === "string" && zh[key].length > 0, `zh 缺少 ${key}`);
    assert.ok(typeof en[key] === "string" && en[key].length > 0, `en 缺少 ${key}`);
    assert.doesNotMatch(en[key], /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/, `en 的 ${key} 不得含 CJK：${en[key]}`);
  }
  // 如实声明：暂不支持自定义 + 后续开放 graph 语义调整与可视化自定义。
  assert.match(zh["design.notice"], /暂不支持自定义/);
  assert.match(zh["design.notice"], /graph 语义调整/);
  assert.match(zh["design.notice"], /可视化自定义/);
  assert.match(en["design.notice"], /not supported yet/i);
  assert.match(en["design.notice"], /semantic/i);
  assert.match(en["design.notice"], /customization/i);
  assert.match(zh["design.title"], /Graph 设计哲学/);
});

// ---------------------------------------------------------------- 判据 3：用户可见文案零内部化

/**
 * 用户可见文案的**去内部化**检查器（判据 3）：不得出现内部目标编号（`g-123` 形态）、commit sha、
 * 文件路径 / 内部产物文件名 / 行号、`§` 章节序号、函数或 API 调用形态（`foo()`）。
 * 纯函数：文本进、问题清单出 —— 可在内存变异上重放作负向对照。
 */
function visibilityProblems(text: string): string[] {
  const problems: string[] = [];
  const goals = text.match(/\bg-\d{2,4}\b/g);
  if (goals) problems.push(`内部目标编号：${[...new Set(goals)].join(",")}`);
  // sha 形态要求「7–40 个十六进制字符且含数字」⇒ 不会误伤 facade/decade 之类的英文单词。
  const shas = text.match(/\b(?=[0-9a-f]{7,40}\b)[0-9a-f]*\d[0-9a-f]*\b/g);
  if (shas) problems.push(`疑似 commit sha：${[...new Set(shas)].join(",")}`);
  const sections = text.match(/§\s*\d+/g);
  if (sections) problems.push(`章节序号：${[...new Set(sections)].join(",")}`);
  const paths = text.match(/(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:ts|js|mjs|cjs|json|html|md|png|svg|yml|yaml)\b/g);
  if (paths) problems.push(`文件路径 / 产物名：${[...new Set(paths)].join(",")}`);
  const calls = text.match(/\b[A-Za-z_$][\w$]*\(\)/g);
  if (calls) problems.push(`函数 / API 名：${[...new Set(calls)].join(",")}`);
  return problems;
}

/** 路线图小节检查器：独立小节（notice 之下、页签之上）+ 未实现标注 + 章节名指路 + 文案零内部化。 */
function roadmapProblems(opts: { modal: string; zh: string; en: string }): string[] {
  const { modal, zh, en } = opts;
  const problems: string[] = [];
  // ① 独立小节：notice 之下、图页签之上的专用容器，且走 i18n（不是图内容、不是新页签）。
  if (!/className: "dg-design-roadmap"/.test(modal)) problems.push("弹窗缺少独立的路线图小节容器 .dg-design-roadmap");
  if (!/dgT\("design\.roadmap"\)/.test(modal)) problems.push("路线图小节必须走 i18n 键 design.roadmap");
  const noticeAt = modal.indexOf('dgT("design.notice")');
  const roadmapAt = modal.indexOf('dgT("design.roadmap")');
  const tabsAt = modal.indexOf("DESIGN_DIAGRAM_TABS.map");
  if (!(noticeAt > 0 && roadmapAt > noticeAt && tabsAt > roadmapAt)) {
    problems.push("路线图小节必须位于 notice 之下、图页签之上");
  }
  // ② 不新增页签：图页签仍恰是 lifecycle/workflow 两张。
  const tabsStart = modal.indexOf("const DESIGN_DIAGRAM_TABS = [");
  const tabsEnd = modal.indexOf("];", tabsStart);
  const tabsBlock = tabsStart >= 0 && tabsEnd > tabsStart ? modal.slice(tabsStart, tabsEnd) : "";
  const tabKeys = [...tabsBlock.matchAll(/key: "([^"]+)"/g)].map((m) => m[1]!).sort();
  if (tabKeys.length !== 2 || tabKeys[0] !== "lifecycle" || tabKeys[1] !== "workflow") {
    problems.push(`图页签必须恰是 lifecycle/workflow 两张，实得 ${JSON.stringify(tabKeys)}`);
  }
  // ③ 明确标注「尚未实现」，并列出后续三项能力。
  if (!/未实现/.test(zh)) problems.push("zh 路线图必须明确标注「未实现」");
  if (!/not implemented/i.test(en)) problems.push("en 路线图必须明确标注 not implemented");
  for (const token of ["可视化自定义", "语义声明式", "每项目独立 graph"]) {
    if (!zh.includes(token)) problems.push(`zh 路线图缺少后续能力「${token}」`);
  }
  // ④ 章节名指路（不用会随改版漂移的 § 序号）。
  if (!zh.includes("1.0 路线（未实现）")) problems.push("zh 路线图必须用章节名「1.0 路线（未实现）」指路");
  if (!/1\.0 roadmap \(not implemented\)/i.test(en)) problems.push("en 路线图必须用章节名 '1.0 roadmap (not implemented)' 指路");
  // ⑤ 去内部化：zh/en 两份用户可见文案零编号 / 路径 / 函数名 / 章节序号。
  for (const [lang, text] of [["zh", zh], ["en", en]] as const) {
    const bad = visibilityProblems(text);
    if (bad.length) problems.push(`${lang} 路线图文案内部化：${bad.join("；")}`);
  }
  return problems;
}

/** 变异用：把路线图小节整块搬到 notice 之前（模拟「不是 notice 下方的独立小节」）。 */
function moveRoadmapAboveNotice(modal: string): string {
  const start = modal.indexOf("          // 后续路线（尚未实现）");
  const endMarker = 'dgT("design.roadmap")),';
  const end = modal.indexOf(endMarker, start);
  const noticeAt = modal.indexOf("          // 如实声明（醒目）");
  if (start < 0 || end < 0 || noticeAt < 0 || noticeAt > start) return modal;
  const block = modal.slice(start, end + endMarker.length) + "\n";
  const rest = modal.slice(0, start) + modal.slice(start + block.length);
  const at = rest.indexOf("          // 如实声明（醒目）");
  return rest.slice(0, at) + block + rest.slice(at);
}

test("g-462 D2：notice 零内部编号；路线图是独立小节（章节名指路，非 § 序号）—— 各配负向对照", () => {
  const { zh, en } = loadI18n();

  // ① notice：本轮返工的原始缺陷 —— 用户可见文案里出现内部目标编号。
  for (const [lang, text] of [["zh", zh["design.notice"]], ["en", en["design.notice"]]] as const) {
    assert.doesNotMatch(text, /\bg-\d{2,4}\b/, `${lang} design.notice 不得出现内部目标编号`);
    assert.deepEqual(visibilityProblems(text), [], `${lang} design.notice 必须完全去内部化`);
  }
  assert.match(zh["design.notice"], /暂不支持自定义/, "「暂不支持自定义」这句必须保留（如实声明）");
  // 负向对照：把编号塞回去 ⇒ 检查器必红并点名（真实缺陷复现）。
  const dirtyZh = zh["design.notice"].replace("的固定图", "的固定图（g-460 定稿）");
  assert.notEqual(dirtyZh, zh["design.notice"], "负向对照必须命中 zh notice 文案");
  assert.ok(visibilityProblems(dirtyZh).some((p) => p.includes("内部目标编号")), "zh 塞回编号必须被判红并点名");
  const dirtyEn = en["design.notice"].replace("the fixed diagrams", "the fixed diagrams (g-460)");
  assert.notEqual(dirtyEn, en["design.notice"], "负向对照必须命中 en notice 文案");
  assert.ok(visibilityProblems(dirtyEn).some((p) => p.includes("内部目标编号")), "en 塞回编号同样必红");

  // ② 路线图独立小节：基线绿。
  const modal = readFileSync(designModalPath, "utf8");
  const real = { modal, zh: zh["design.roadmap"], en: en["design.roadmap"] };
  assert.deepEqual(roadmapProblems(real), [], "路线图小节基线必须为绿");

  // 负向对照（全部为内存变异，真实文件逐字节不变）：五类偏离各自必红。
  const movedModal = moveRoadmapAboveNotice(modal);
  assert.notEqual(movedModal, modal, "「挪到 notice 之上」变异必须真实改变文本");
  const mutations: Array<[string, typeof real, string]> = [
    ["拿掉独立小节容器", { ...real, modal: modal.replace('className: "dg-design-roadmap"', 'className: "dg-design-x"') }, "路线图小节容器"],
    ["小节挪到 notice 之上", { ...real, modal: movedModal }, "notice 之下"],
    ["新增第三个页签", { ...real, modal: modal.replace("const DESIGN_DIAGRAM_TABS = [", 'const DESIGN_DIAGRAM_TABS = [{ key: "roadmap", file: "x.html", labelKey: "y" },') }, "图页签"],
    ["用 § 序号替代章节名", { ...real, zh: real.zh.replace("1.0 路线（未实现）", "§13") }, "章节名"],
    ["塞入文件路径", { ...real, zh: real.zh + "（见 core/ops.ts）" }, "路径"],
    ["塞入函数调用名", { ...real, en: real.en + " See renderDiagram()." }, "函数"],
  ];
  for (const [label, mutated, expect] of mutations) {
    assert.notDeepEqual(mutated, real, `负向对照「${label}」必须真实改变输入`);
    const got = roadmapProblems(mutated);
    assert.ok(got.some((p) => p.includes(expect)), `变异「${label}」必须报红并点名「${expect}」，实际：${JSON.stringify(got)}`);
  }

  // 恢复：真实文件重新检查必须全绿，且负向对照是 hermetic 的。
  assert.deepEqual(roadmapProblems(real), [], "移除变异后必须重新全绿");
  assert.equal(readFileSync(designModalPath, "utf8"), modal, "负向对照必须 hermetic（真实文件零改动）");
});

// ================================================================ E. 随包发布

test("g-462 E1：build.sh 显式复制 diagrams；dist/diagrams 与源逐字节一致（sha256 全等）", () => {
  const script = readFileSync(buildScript, "utf8");
  assert.match(script, /^cp -r dsh-graph-host\/diagrams dist\/diagrams$/m, "build.sh 必须显式 cp -r diagrams（既有风格）");
  const srcFiles = readdirSync(diagramsSrcDir).sort();
  assert.deepEqual(srcFiles, [
    LIFECYCLE, "design-philosophy.lifecycle.json", "design-philosophy.lifecycle.png",
    WORKFLOW, "design-philosophy.workflow.json", "design-philosophy.workflow.png",
  ].sort(), "diagrams 源目录内容必须与 g-460 定稿一致");
  assert.deepEqual(readdirSync(diagramsDistDir).sort(), srcFiles, "dist/diagrams 必须与源目录同名同集合");
  for (const name of srcFiles) {
    const a = readFileSync(join(diagramsSrcDir, name));
    const b = readFileSync(join(diagramsDistDir, name));
    assert.equal(sha256(b), sha256(a), `${name} 必须逐字节一致`);
    assert.ok(statSync(join(diagramsDistDir, name)).size > 0, `${name} 不得为空`);
  }
  // g-460 att-003：此处原先硬钉 g-460 第一版定稿 HTML 的两个 sha256 字面量（lifecycle
  // `bc71f30263f4` / workflow `18ac73e42853`，「字节必须未变」）。g-460 按负责人要求重出两张图
  // （去掉 1.0 路线图内容、并做「去代码化」）⇒ 字面量必然过期；而它本就不表达「产物未被中途篡改/
  // 静默替换」这一价值——任何合法重出都会红，反而逼迫后来者删断言。改为**自洽性断言**：
  // 包内 HTML 必须逐条体现**当前源 JSON** 的文案（泳道 / 节点 / 卡片），源与产物一旦对不上即必红。
  for (const [specName, htmlName] of [
    ["design-philosophy.lifecycle.json", LIFECYCLE],
    ["design-philosophy.workflow.json", WORKFLOW],
  ] as const) {
    const spec = JSON.parse(readFileSync(join(diagramsSrcDir, specName), "utf8"));
    const html = readFileSync(join(diagramsSrcDir, htmlName), "utf8");
    const strings = new Set<string>();
    for (const lane of spec.lanes ?? []) strings.add(lane.label);
    for (const node of [...(spec.states ?? []), ...(spec.nodes ?? [])]) {
      for (const key of ["label", "sublabel", "tag"]) if (node?.[key]) strings.add(node[key]);
    }
    for (const card of spec.cards ?? []) {
      strings.add(card.title);
      for (const item of card.items ?? []) strings.add(item);
    }
    assert.ok(strings.size >= 10, `${specName} 解析出的文案过少（${strings.size}），自洽性断言可能已退化`);
    const missing = [...strings].filter((s) => s && !html.includes(s));
    assert.deepEqual(missing, [], `${htmlName} 必须逐条体现 ${specName} 的文案（缺失即产物与源不符/被静默替换）`);
  }
});

test("g-462 E2：npm pack --dry-run 的文件清单确实包含两张图 HTML（判据「pack 含图文件」）", () => {
  // npm 默认缓存/日志目录在沙盒下只读 ⇒ 把 cache 与 logs 都重定向到仓库内 tmp/（用完即删）。
  const tmpBase = join(repoRoot, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const cacheDir = mkdtempSync(join(tmpBase, "g462-npm-cache-"));
  try {
    const out = execFileSync("npm", [
      "pack", "--dry-run", "--json", "--no-audit", "--no-fund", "--cache", cacheDir, "--logs-dir", cacheDir,
    ], { cwd: distRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const parsed = JSON.parse(out);
    // npm 的 `--json` 形态随版本变化：既可能是 `[{...}]`，也可能是 `{ "<pkg>": {...} }`。
    const entry: any = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    const files: string[] = (entry?.files ?? []).map((f: any) => String(f.path));
    assert.ok(files.length >= 30, `pack 文件数异常（${files.length}）—— 解析可能失效`);
    for (const name of [LIFECYCLE, WORKFLOW]) {
      assert.ok(files.includes(`diagrams/${name}`), `pack 必须包含 diagrams/${name}，实际清单：${files.filter((f) => f.startsWith("diagrams/")).join(",") || "（无 diagrams/*）"}`);
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ================================================================ F. 离线自包含

test("g-462 F1：图 HTML 无任何外部网络子资源（断网可用，字体已 base64 内嵌）", () => {
  for (const name of [LIFECYCLE, WORKFLOW]) {
    const html = readFileSync(join(diagramsDistDir, name), "utf8");
    assert.doesNotMatch(html, /<link\b/i, `${name} 不得有 <link>（外链样式/字体）`);
    assert.doesNotMatch(html, /<img\b/i, `${name} 不得有 <img>`);
    assert.doesNotMatch(html, /<script[^>]*\bsrc=/i, `${name} 不得有外链 script`);
    assert.doesNotMatch(html, /@import\b/i, `${name} 不得有 CSS @import`);
    assert.doesNotMatch(html, /url\(\s*['"]?(?:https?:)?\/\//i, `${name} 不得有 url(http…) 外链`);
    assert.doesNotMatch(html, /\b(?:src|poster)\s*=\s*['"](?:https?:)?\/\//i, `${name} 不得把外部 URL 用作子资源`);
    assert.match(html, /data:font\/woff2;base64,/, `${name} 字体必须是 base64 内嵌（离线可用）`);
  }
});

// ================================================================ G. 文档规范导出（第 7 项）

/**
 * 第 7 项（有界尝试）：用 headless 浏览器取 archify 观看器的**规范导出**
 * （`Archify.exportMenu.run("svg-light" | "svg-dark")`，`data-last-export-canonical=true`），
 * 落成 chrome-free 双主题自包含 SVG，替换文档里原先带观看器外框的 PNG 截图。
 * 本测试只校验**产物属性**（矢量、自包含、无色情外框/外链/脚本、明暗自洽），
 * 不重跑浏览器导出（导出脚本是一次性工具，不入库）。
 */
const DOC_ASSETS = join(repoRoot, "docs/assets");
const docSvg = (name: string, theme: string) => join(DOC_ASSETS, `design-philosophy.${name}.${theme}.svg`);
/** 从 `.svg` 里取 `:root, svg { … }` 主题块中的某个变量（HTML 里还有其它 `--bg:` 定义，
 *  但 **SVG 自身的**主题块才是独立渲染时的真源 —— 直接全文取第一条会取到页面侧的覆盖块）。 */
const themeVar = (svg: string, name: string) => {
  const block = (svg.match(/:root, svg \{ ([^}]*)\}/) ?? [])[1] ?? "";
  return (block.match(new RegExp(`--${name}:\\s*([^;]+);`)) ?? [])[1]?.trim() ?? "";
};

test("g-462 G1：docs/assets 的规范导出 SVG 为 chrome-free、双主题、自包含矢量", () => {
  for (const name of ["lifecycle", "workflow"]) {
    const light = readFileSync(docSvg(name, "light"), "utf8");
    const dark = readFileSync(docSvg(name, "dark"), "utf8");
    for (const [theme, svg] of [["light", light], ["dark", dark]] as const) {
      const label = `${name}.${theme}`;
      assert.ok(svg.startsWith("<?xml"), `${label}: 必须是独立 SVG 文档（XML 声明开头）`);
      assert.match(svg, /<svg [^>]*viewBox="[\d. ]+"/, `${label}: 必须有 viewBox（真矢量）`);
      assert.match(svg, /<svg [^>]*\bwidth="\d+"/, `${label}: 必须有显式 width`);
      assert.match(svg, /<svg [^>]*\bheight="\d+"/, `${label}: 必须有显式 height`);
      assert.match(svg, /:root, svg \{ --/, `${label}: 主题变量必须内嵌在 SVG 自身（独立可渲染）`);
      // chrome-free / 自包含：无观看器脚本、无外框、无外链子资源、无光栅化嵌入。
      assert.doesNotMatch(svg, /<script/i, `${label}: 不得含脚本`);
      assert.doesNotMatch(svg, /<foreignObject/i, `${label}: 不得用 foreignObject 伪装矢量`);
      assert.doesNotMatch(svg, /<image\b/i, `${label}: 不得内嵌位图`);
      assert.doesNotMatch(svg, /class="[^"]*(?:viewer|toolbar|export-menu|hud|topbar|bottombar)/i, `${label}: 不得带观看器外框`);
      assert.doesNotMatch(svg, /(?:href|src)\s*=\s*["'](?:https?:)?\/\//i, `${label}: 不得有外链子资源`);
      assert.doesNotMatch(svg, /@import\b/i, `${label}: 不得有 CSS @import`);
    }
    // 双主题必须真的不同（同尺寸、仅主题变量与底色换装）。
    assert.notEqual(themeVar(light, "bg"), themeVar(dark, "bg"), `${name}: 明/暗主题的 --bg 必须不同`);
    assert.notEqual(themeVar(light, "text"), themeVar(dark, "text"), `${name}: 明/暗主题的 --text 必须不同`);
    // 底色与画布矩形一致（主题不是「只改变量、不换底色」的半成品）。
    assert.ok(light.includes(`fill="${themeVar(light, "bg")}"`), `${name}: light 画布底色必须用主题 --bg`);
    assert.ok(dark.includes(`fill="${themeVar(dark, "bg")}"`), `${name}: dark 画布底色必须用主题 --bg`);
    assert.equal(
      (light.match(/viewBox="([^"]+)"/) ?? [])[1],
      (dark.match(/viewBox="([^"]+)"/) ?? [])[1],
      `${name}: 明/暗必须同一 viewBox（同一张图的两套配色）`,
    );
  }
  // 防「四个文件全同」的假绿：四份产物两两不同。
  const digests = new Set(
    ["lifecycle", "workflow"].flatMap((n) => ["light", "dark"].map((t) => sha256(readFileSync(docSvg(n, t))))),
  );
  assert.equal(digests.size, 4, "四份导出必须两两不同（明/暗 × 两张图）");
});
