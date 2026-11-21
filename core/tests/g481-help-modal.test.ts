/**
 * core/tests/g481-help-modal.test.ts
 *
 * g-481（v0.20.x 泳道）：看板「📖 使用说明」入口 + 五页签帮助弹窗
 * （使用说明 / 提示词模板 / 工具清单 / 常见问题 / Graph 设计），以及它依赖的宿主**只读**面：
 *   `/api/dsh-graph/help/asset/<name>`（随包提示词资产 md，白名单 + 无写路径）
 *   `/api/dsh-graph/help/catalog`（工具清单 + 资产清单 + 生效提示词语言的**唯一真源投影**）
 *
 * 断言全部打在**真实产物**上（dist/index.js、dist/lib/client.js、dist/prompts/、build-client.sh、
 * 客户端源码模块）：
 *  A. 资产路由：白名单 ≡ 随包 `dist/prompts/*.md`（无漂移、无死条目）；命中即
 *     `text/markdown; charset=utf-8` + `nosniff` 且与产物**逐字节一致**；未知名 / 目录穿越（`../`、
 *     绝对路径、编码变体、反斜杠）/ 非 `.md` / 大小写变体一律拒绝；GET/HEAD 之外 405；路由块内零写 API；
 *     `dist/` 根下的 md（如 README）**不在**白名单内 ⇒ 仍必须 404（只读面不外溢）；
 *     g-496 起提示词资产合并进 `dist/prompts/`，白名单 ≡ 该目录全部 md。
 *  B. 目录端点：`tools[]` 逐项等于**注册真源**（apply 时 ctx.tools.register 的实收名字），
 *     `prompts[]` 等于白名单投影；说明 zh/en 成对且 en 无 CJK；`prompt_language` 随宿主语言设置变化
 *     （settings.locale.preference = en ⇒ en；缺省 ⇒ zh）。
 *  C. 客户端结构：五个页签齐全且各有真内容；工具名 / 资产名**零硬编码**（全部来自目录端点）；
 *     版本只走 `PLUGIN_VERSION`（模块内零版本字面量）；单 overlay + g-181 guard；看板接线（2 处入口 +
 *     稳定 key 挂载 + hasModal）；`build-client.sh` PARTS 收录 help-modal 且**排在 drag-prompts 之前**，
 *     旧 `design-modal` 已移除。
 *  D. i18n：`help.*` zh/en 键完全对称、必备键齐全、en 无 CJK、版本占位符 `{version}` 保留、
 *     每个资产基名都有展示标签。
 *
 * 负向对照（证明断言非空转；全部 hermetic —— 真实文件逐字节不变）：
 *  - 路由：把 `dist/index.js` 复制到仓库内 tmp 镜像后**真跑一次文本变异**（白名单放宽成「任意名字」）
 *    ⇒ 未知名/白名单外 md 从 404 变 200 ⇒ A 的白名单断言必红；变异只放宽白名单、语法闸未动。
 *  - 目录：对目录 JSON 做内存变异（漏项/多项/改名/en 说明空/CJK/`prompt_language` 越界/未随包资产）
 *    ⇒ `catalogProblems` 各自必红并点名。
 *  - 客户端：对真实源码/产物做内存变异（硬编码工具名、硬编码资产名、版本字面量、PARTS 次序倒置、
 *    bundle 缺组件）⇒ 结构断言必红。
 *  - i18n：删键 / 加 CJK / 键集不对称 ⇒ 必红。
 */

import { test } from "node:test";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import {
  apply, DESIGN_DIAGRAM_ROUTE, HELP_ASSET_ROUTE, HELP_CATALOG_ROUTE, HELP_PROMPT_ASSETS,
  helpAssetRelativePath, helpAssetOwnership, helpPromptAssetEntries, resolveHelpAssetRequest,
} from "../../dist/index.js";
import { ownerConnectionStub, entryHandler, createRegisterStub, OWNER_HEADER, singleEntry, NAMESPACE } from "./_http-auth-harness.ts";
// g-507：捕获到的注册定义（setup/fixture 内赋值；helper 经唯一门禁入口分发时读取）
let routeDefs: any[] = [];
let webServer: any = null;

const repoRoot = join(import.meta.dirname, "../..");
const distRoot = join(repoRoot, "dist");
const hostIndex = join(repoRoot, "dsh-graph-host/index.js");
const buildClientScript = join(repoRoot, "scripts/build-client.sh");
const kanbanSrcPath = join(repoRoot, "dsh-graph-host/lib/client/kanban.js");
const helpModalPath = join(repoRoot, "dsh-graph-host/lib/client/help-modal.js");
const designModalPath = join(repoRoot, "dsh-graph-host/lib/client/design-modal.js");
const i18nSrcPath = join(repoRoot, "dsh-graph-host/lib/client/i18n.js");
const clientConstantsPath = join(repoRoot, "dsh-graph-host/lib/client/constants.js");
const bundlePath = join(distRoot, "lib/client.js");
const promptsSrcDir = join(repoRoot, "prompts");
const promptsDistDir = join(distRoot, "prompts");
// g-496 att-007：资产分两层，源侧根按归属选择（包侧仍是合并后的单一 prompts/）。
const publicPromptSrcDir = promptsSrcDir;
const hostPromptSrcDir = join(repoRoot, "dsh-graph-host/prompts");

const MARKDOWN_CT = "text/markdown; charset=utf-8";
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------- 宿主桩（捕获路由 + 注册真源）

type Capture = { route: any; registered: any[] };

function captureRoutes(opts: { locale?: string } = {}): Capture {
  const routes = new Map<string, any>();
  const registered: any[] = [];
  { const stub = createRegisterStub(); routeDefs = stub.routes; webServer = stub.webServer; }
  // 语言真源：settings 服务的 locale.preference（resolvePromptLanguage 的首选来源）。
  const settings = opts.locale
    ? { get: (ns: string) => (ns === "locale" ? { preference: opts.locale } : null), watch: () => () => {}, update: async () => {} }
    : null;
  const ctx: any = {
    inject: () => ctx,
    effect: (fn: any) => fn(),
    get: (name: string) => (name === "webServer" ? webServer : name === "connection" ? ownerConnectionStub() : name === "settings" ? settings : null),
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
    webServer,
  };
  apply(ctx, {});
  return { route: singleEntry(routeDefs), registered };
}

function fakeRes() {
  const res: any = {
    code: 0, headers: null, body: null,
    writeHead(code: number, headers: any) { this.code = code; this.headers = headers; },
    end(body: any) { this.body = body ?? null; },
  };
  return res;
}

const captured = captureRoutes();
// g-507：业务定义不再逐条注册 —— 两条资产端点都经唯一受保护入口分发。
const assetRoute = captured.route;
const catalogRoute = captured.route;
assert.equal(assetRoute.path, NAMESPACE, `唯一入口覆盖命名空间（资产路由 ${HELP_ASSET_ROUTE} 在其内）`);
assert.equal(assetRoute.kind, "prefix", "唯一入口必须是 prefix");

async function callAsset(url: string, method = "GET") {
  const res = fakeRes();
  await assetRoute.handler({ headers: { OWNER_HEADER: "1" }, method, url, headers: { [OWNER_HEADER]: "1" } }, res);
  return res;
}

async function callCatalog(locale?: string) {
  const route = locale ? captureRoutes({ locale }).route : catalogRoute;
  const res = fakeRes();
  await route.handler({ headers: { [OWNER_HEADER]: "1" }, method: "GET", url: HELP_CATALOG_ROUTE }, res);
  return res;
}

const bodyOf = (res: any) => (Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body ?? ""), "utf8"));
const jsonOf = (res: any) => { try { return JSON.parse(String(res.body)); } catch { return null; } };

/** 随包发布的 md 资产名（dist/ 是发布真相；源目录必须同集）。 */
const packagedNames = (dir: string) =>
  readdirSync(dir).filter((f) => f.endsWith(".md")).sort();

/** g-496：可达资产的**位置真源** —— 注册表把「名字 → 包内相对路径」冻结下来。
 *  g-496 起资产分两层（公共层 `prompts/` + 宿主专属层 `dsh-graph-host/prompts/`），
 *  由构建合并进**单一** `dist/prompts/`（故包内相对路径统一为 `prompts/<name>`）；
 *  但**源侧**根取决于**归属**：public → 仓库根 `prompts/`；host → `dsh-graph-host/prompts/`。
 *  本 helper 由**注册投影 + 归属投影**给出每个名字的源/包**绝对路径**，
 *  供 A1 做「源 ↔ 包 ↔ 真实响应字节」对账。
 *
 *  g-496 att-007 改判（负责人 2026-10-15 批准）：原实现把**每一份**资产的源根钉死为
 *  `repoRoot/prompts`。资产分层所有权落地后该钉法结构性失效（host 资产根本不在公共层）。
 *  改为**按 `helpAssetOwnership(base)` 解析源根** —— 属等价/更强载体改判：
 *  断言强度不降（源↔包↔真实 HTTP 响应三方字节一致、未注册 404 等防护逐项保留），
 *  且**新增**「归属必须与源根实际所在层一致」的正向校验（原实现无法发现归属标错）。
 *  注意：`helpAssetOwnership` 接受**基名**（不含 `.<lang>.md`）。 */
const baseOfAssetName = (name: string) => name.replace(/\.(zh|en)\.md$/, "");
// 仅当前 9 类 GUI 模板允许短载荷；固定基线摘要独立于资产读取，截断/缺段/错变量均判红。
const SHORT_GUI_BASELINES: Record<string, Record<string, string>> = {
  "gui-accept-review-request": { zh: "5f119fbf43375e73b0f40f4131f0be912d001646281209c03525b8246e0fecec", en: "ee62878627ed519433a8490ac327c6cfad55965a52fb868cc8bd5014e85f03b3" },
  "gui-backward-reason": { zh: "1c924c50aec1c1d21c4ff327386f86760cb6fb35e939f081a02992adc9460392", en: "1c65b5901afa72574611079623d48d2a504e422276d185a67c371b5801e50cbd" },
  "gui-batch-accept-review-request": { zh: "f7292763fef918c581b70e9a8926f309d38ebf33abd1765de9abbe5172890602", en: "58eec339b5b3db70a40536e99d72e75e585772fe8fb0c7f043d55e7c840e132b" },
  "gui-criteria-feedback-executor": { zh: "baf85d40a5ad398884b7770d8e9ec2d6b6036dbe151f3e04774fec0e618ef056", en: "aa9a26b04eb0664495cb49cc6932310e49f132a941c73aa4999faf210febf886" },
  "gui-criteria-feedback-supervisor": { zh: "f2b2b2adb0a732c46379a354173ad680bef305394ef576aecc1fb91068e3e60b", en: "96cdb12e0e792597e20fd0e034713e0280ef7212507cf3a3f3552fcadf42b45c" },
  "gui-define-polish-request": { zh: "9b859302c6fc9ea07fed31c3fd3562eaaf313110cd46618f09e4bf23ed02ce30", en: "f9e8640fdf47a8a5ded3a3336dc21c5361f91c4eaac6688006b88165e909ff3b" },
  "gui-deliver-notice": { zh: "9b5ff562b63fe369b475d9d672d34e07a6b4be68a1e894e7a09a1f30e500d223", en: "b410203964d85098eddbbcf1c79b853f1afde80d462e4d95990ccbe05fcd9900" },
  "gui-help-takeover-example": { zh: "d64a41f3ae844937ae246c1e3d82adc83de5334a35cd4b2243077643bed732fe", en: "29997434a39f6d326114375eff4a6fa43ddb1489e2d84a84c3bbe6fa7cb85c2b" },
  "gui-reexecute": { zh: "016fa00702af15b47329251ddb2c9505ae8dfdfa3a3b3301ab59356af92e3b00", en: "0ebbe0834f6ae8b4f7cc40c57872d9583c789bd420b2ec11b5f47aa80fc3ecbe" },
};
const promptLayerRoot = (name: string) =>
  helpAssetOwnership(baseOfAssetName(name)) === "host"
    ? hostPromptSrcDir
    : publicPromptSrcDir;
const registryPath = (name: string, root: "src" | "dist") => {
  const rel = helpAssetRelativePath(name);
  assert.ok(rel, `${name} 必须在注册表内（白名单不得含未注册名字）`);
  // 源侧：按归属落到对应层的根；包侧：合并后的 `dist/prompts/<name>`。
  return root === "dist" ? join(distRoot, rel!) : join(promptLayerRoot(name), name);
};

// ================================================================ A. 宿主只读资产路由

test("g-481 A1：白名单 ≡ 注册表投影的随包资产（源 ↔ 包 ↔ 真实响应字节三方一致）", async () => {
  // g-496（负责人 2026-10-14 批准）：白名单是**完整注册映射**的投影。两层资产合并后
  // 注册路径统一为 `prompts/<name>`（不再有包根特例），但「注册表为唯一真源」的口径不变。
  assert.equal(new Set(HELP_PROMPT_ASSETS).size, HELP_PROMPT_ASSETS.length, "白名单不得有重复项");
  // ① 每条注册项：路径形态受控（`<name>` 或 `prompts/<name>`），且名字过形态闸
  for (const name of HELP_PROMPT_ASSETS) {
    assert.match(name, /^[a-z0-9][a-z0-9.-]*\.(zh|en)\.md$/, `${name} 必须是 <base>.<lang>.md 形态`);
    const rel = helpAssetRelativePath(name);
    assert.equal(rel, `prompts/${name}`, `${name} 的注册路径必须在合并后的 prompts/ 布局`);
    assert.ok(!rel!.includes("..") && !rel!.includes("\\"), `${name} 的注册路径不得含穿越/反斜杠`);
  }
  // ② 注册项逐一真实存在（源 + 包），且响应字节与产物逐字节一致
  const digests = new Set<string>();
  for (const name of HELP_PROMPT_ASSETS) {
    const srcAbs = registryPath(name, "src");
    const distAbs = registryPath(name, "dist");
    assert.ok(existsSync(srcAbs), `${name} 必须存在于源（${srcAbs}）`);
    assert.ok(existsSync(distAbs), `${name} 必须随包发布（${distAbs}）`);
    const res = await callAsset(`${HELP_ASSET_ROUTE}/${name}`);
    assert.equal(res.code, 200, `${name} 必须 200`);
    assert.equal(res.headers["content-type"], MARKDOWN_CT, `${name} 必须是 text/markdown; charset=utf-8`);
    assert.equal(res.headers["x-content-type-options"], "nosniff", `${name} 必须带 nosniff（不被嗅探成 HTML）`);
    const srcBuf = readFileSync(srcAbs);
    const distBuf = readFileSync(distAbs);
    assert.equal(sha256(distBuf), sha256(srcBuf), `${name} 随包副本必须与源逐字节一致`);
    assert.equal(res.body.length, distBuf.length, `${name} 响应长度必须等于产物字节数`);
    assert.equal(sha256(bodyOf(res)), sha256(distBuf), `${name} 响应必须与随包产物逐字节一致`);
    // 「提示词模板」页签要有真内容可显示（不是占位/空文件；注入式提示词本就不必带 `#` 标题）。
    const text = distBuf.toString("utf8");
    // g-496 att-012（终局复核 BLOCK 收口）：短载荷下限**只**发给 `SHORT_GUI_BASELINES`
    // 登记的既有 9 类 GUI 模板 —— **不**按 host 归属发放。归属是「哪一层维护」，
    // 与「载荷可以多短」无关；按归属发就是 100→20 泛化到未来所有宿主资产。
    // 公共层资产与未来新增的任何 host 资产一律维持 ≥100。
    const base = baseOfAssetName(name);
    const language = name.match(/\.(zh|en)\.md$/)?.[1] ?? "zh";
    const shortBaseline = SHORT_GUI_BASELINES[base]?.[language];
    const floor = shortBaseline ? 20 : 100;
    assert.ok(text.trim().length >= floor,
      `${name} 必须是实质内容（${shortBaseline ? "既有短 GUI 模板" : "非短 GUI 豁免资产"} ⇒ ≥${floor} 字符，实得 ${text.trim().length}）`);
    if (shortBaseline) assert.equal(sha256(distBuf), shortBaseline, `${name} 短 GUI 模板必须保持独立语义/变量基线快照`);
    assert.doesNotMatch(text, /TODO|FIXME|待补/, `${name} 不得残留未完成标记`);
    assert.ok(!digests.has(sha256(distBuf)), `${name} 内容与其他资产重复（疑似复制粘贴占位）`);
    digests.add(sha256(distBuf));
  }
  // ③ 目录派生（不放弱）：白名单 ≡ 合并后 `prompts/` 下**全部** md（新增资产自动纳入，无死条目）
  const distNames = packagedNames(promptsDistDir);
  const srcNames = packagedNames(promptsSrcDir);
  // g-496 att-007：`src prompts == dist prompts` 在**分层**后不再成立（dist 是两层的合并集）。
  // 原断言编码的是「单层时代」的等价关系，故改判为**更强**的等价关系（见 ③-b）：
  // 源侧两层并集 ≡ 随包集 ≡ 白名单 —— 三层互为同一集合，单层时代的「无死条目/无遗漏」语义原样保留。
  assert.deepEqual([...HELP_PROMPT_ASSETS].sort(), distNames,
    "白名单必须恰等于随包 dist/prompts 的全部 md（目录派生，无死条目、无遗漏）");
  // ③-b（g-496 att-007 新增，更强）：**源侧两层并集**也必须恰等于白名单 ——
  // 既保证每份 host 资产确有版本控制副本，也保证没有「只在 dist 里、源里没有」的幽灵资产。
  const srcLayerNames = [
    ...packagedNames(publicPromptSrcDir),
    ...packagedNames(hostPromptSrcDir),
  ].sort();
  assert.deepEqual([...HELP_PROMPT_ASSETS].sort(), srcLayerNames,
    "白名单必须恰等于源侧两层（prompts/ ∪ dsh-graph-host/prompts/）的全部 md");
  // ③-c：两层的**归属标注**必须与实际所在层一一对应（错标即判红 —— 原实现看不出来）。
  const publicSrcSet = new Set(packagedNames(publicPromptSrcDir));
  const hostSrcSet = new Set(packagedNames(hostPromptSrcDir));
  for (const name of HELP_PROMPT_ASSETS) {
    const own = helpAssetOwnership(baseOfAssetName(name));
    const inPublic = publicSrcSet.has(name);
    const inHost = hostSrcSet.has(name);
    assert.notEqual(inPublic, inHost, `${name} 必须恰在两层之一（不得同时存在或双双缺失）`);
    assert.equal(own === "host", inHost,
      `${name} 归属标注（${own}）与实际所在层（${inHost ? "host" : "public"}）必须一致`);
  }
  // ④ supervisor-guide 已随合并进入 prompts/，且**不再**位于包根（证明归一为单一位置）
  assert.ok(HELP_PROMPT_ASSETS.includes("supervisor-guide.zh.md"), "supervisor-guide 必须可达（g-496）");
  assert.ok(HELP_PROMPT_ASSETS.includes("supervisor-guide.en.md"), "supervisor-guide.en 必须可达（g-496）");
  assert.ok(distNames.includes("supervisor-guide.zh.md"), "合并后 supervisor-guide 应位于 prompts/");
  assert.ok(!existsSync(join(distRoot, "supervisor-guide.zh.md")), "supervisor-guide 不得再位于包根");
});

test("g-481 A1b（att-012）：短 GUI 保护恰为既有 9 类，且截断/空壳/错变量各自判红", () => {
  // ① 豁免集合 ≡ 宿主层实际资产基名（不多发、不漏发）。
  const hostBases = [...new Set(
    packagedNames(hostPromptSrcDir).map((n) => baseOfAssetName(n)),
  )].sort();
  assert.deepEqual(Object.keys(SHORT_GUI_BASELINES).sort(), hostBases,
    "短 GUI 基线表必须恰等于宿主层现有资产基名");
  assert.equal(hostBases.length, 9, `短 GUI 模板恰为 9 类（实得 ${hostBases.length}）`);
  // ② 每类 zh/en 都有**独立**基线（防止两语言共用同一摘要掩盖单侧截断）。
  for (const base of hostBases) {
    assert.ok(SHORT_GUI_BASELINES[base].zh, `${base} 必须有 zh 基线`);
    assert.ok(SHORT_GUI_BASELINES[base].en, `${base} 必须有 en 基线`);
    assert.notEqual(SHORT_GUI_BASELINES[base].zh, SHORT_GUI_BASELINES[base].en,
      `${base} 的 zh/en 基线不得相同（否则单侧被另一侧掩盖）`);
  }
  const all = Object.values(SHORT_GUI_BASELINES).flatMap((v) => [v.zh, v.en]);
  assert.equal(new Set(all).size, all.length, "9 类 × 2 语言的基线摘要必须两两不同（防复制粘贴空壳）");
  // ③ 基线摘要真实生效：改动任一字节即与摘要不符 ⇒ 判红。
  const probe = "gui-backward-reason.zh.md";
  const real = readFileSync(join(hostPromptSrcDir, probe));
  assert.equal(sha256(real), SHORT_GUI_BASELINES["gui-backward-reason"].zh, "真实资产必须命中基线");
  const truncated = Buffer.from(real.toString("utf8").slice(0, 5), "utf8");
  assert.notEqual(sha256(truncated), SHORT_GUI_BASELINES["gui-backward-reason"].zh, "截断后必须与基线不符（判红）");
  // ④ 20 字节下限对 9 类仍拦得住空文件与近空壳。
  assert.ok(truncated.toString("utf8").trim().length < 20, "截断样本应低于 20 字节下限（证明下限非空转）");
  for (const base of hostBases) {
    for (const lang of ["zh", "en"]) {
      const text = readFileSync(join(hostPromptSrcDir, `${base}.${lang}.md`), "utf8");
      assert.ok(text.trim().length >= 20, `${base}.${lang} 必须 ≥20 字符`);
      assert.ok(text.trim().length >= 20, `${base}.${lang} 非空壳`);
    }
  }
  // ⑤ 非豁免资产名不得获得短下限（防 100→20 泛化到未来 host 资产）。
  for (const future of ["gui-future-widget", "error-msg", "help-snippet"]) {
    assert.equal(SHORT_GUI_BASELINES[future], undefined, `${future} 不得预先获得短豁免`);
  }
});

test("g-481 A2：未知名 / 穿越 / 非 md / 大小写变体一律拒绝，GET/HEAD 之外 405，白名单不覆盖未注册根名", async () => {
  const rejected: Array<[string, number, string]> = [
    [`${HELP_ASSET_ROUTE}/unknown.zh.md`, 404, "未知名"],
    // g-496：负例仍钉「**未注册**名不得经本路由外溢」——合并后资产归一进 prompts/，
    // 但 `help.*` 之外的名字（含形态合法者）一律 404，白名单口径不弱化。
    [`${HELP_ASSET_ROUTE}/supervisor-guide.md`, 404, "名字合法但**不在白名单**（未注册名不得经本路由外溢）"],
    [`${HELP_ASSET_ROUTE}/readme.zh.md`, 404, "未注册的形态合法名仍须 404"],
    [`${HELP_ASSET_ROUTE}/README.md`, 400, "大写不合规（形态闸先拒；`README.md` 虽随包在 dist/ 根下，也不得经本路由外溢）"],
    [`${HELP_ASSET_ROUTE}`, 404, "缺名字"],
    [`${HELP_ASSET_ROUTE}/`, 400, "空名字"],
    [`${HELP_ASSET_ROUTE}/../index.js`, 404, "`../`（URL 归一化后已不在前缀下）"],
    [`${HELP_ASSET_ROUTE}/%2e%2e%2findex.js`, 400, "URL 编码的 `..`"],
    [`${HELP_ASSET_ROUTE}/..%2f..%2fpackage.json`, 400, "编码变体"],
    [`${HELP_ASSET_ROUTE}//etc/passwd`, 400, "绝对路径"],
    [`${HELP_ASSET_ROUTE}/C:%5Cwindows%5Cwin.ini`, 400, "反斜杠/盘符"],
    [`${HELP_ASSET_ROUTE}/usage.zh.md%00.png`, 400, "NUL 变体"],
    [`${HELP_ASSET_ROUTE}/USAGE.ZH.MD`, 400, "大小写变体"],
    [`${HELP_ASSET_ROUTE}/usage.zh.json`, 400, "非 .md"],
    [`${HELP_ASSET_ROUTE}/design-philosophy.lifecycle.html`, 400, "非 .md（图走另一条路由）"],
  ];
  for (const [url, expected, why] of rejected) {
    // 两层都钉：① 纯函数解析器（语法闸 + 白名单闸）；② 真实路由 handler（策略 + 文件存在闸）。
    // 只钉 ② 会漏检「白名单被放宽」—— 放宽后未知名虽被策略放行，仍会因文件不存在而回落 404（见 A3）。
    assert.equal(resolveHelpAssetRequest(url).status, expected, `[resolver] ${url}（${why}）必须 ${expected}`);
    const res = await callAsset(url);
    assert.equal(res.code, expected, `[route] ${url}（${why}）必须 ${expected}（实得 ${res.code}）`);
    assert.equal(res.headers?.["content-type"], "application/json; charset=utf-8", `${url} 拒绝响应必须是 JSON`);
    assert.ok(jsonOf(res)?.error, `${url} 拒绝响应必须带可上报原因`);
  }
  // 方法面：只读路由只认 GET/HEAD。
  for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await callAsset(`${HELP_ASSET_ROUTE}/usage.zh.md`, m);
    assert.equal(res.code, 405, `${m} 必须 405（无任何写路径）`);
  }
  // HEAD：200 + 同一 content-type，但不回 body。
  const head = await callAsset(`${HELP_ASSET_ROUTE}/usage.zh.md`, "HEAD");
  assert.equal(head.code, 200);
  assert.equal(head.headers["content-type"], MARKDOWN_CT);
  assert.equal(head.body, null, "HEAD 不得回 body");

  // g-496 反向对照：注册名必须真实可达（含随宿主专属层的 entry）—— 证明「未注册名 404」
  // 不是因为整体不可达，而是白名单确实在起作用（防恒真断言）。
  for (const name of ["supervisor-guide.zh.md", "supervisor-guide.en.md"]) {
    assert.equal(resolveHelpAssetRequest(`${HELP_ASSET_ROUTE}/${name}`).status, 200, `${name} 已注册 ⇒ 策略层必须 200`);
    const res = await callAsset(`${HELP_ASSET_ROUTE}/${name}`);
    assert.equal(res.code, 200, `${name}（已注册）必须可达`);
    assert.equal(res.headers["content-type"], MARKDOWN_CT, `${name} 必须是 text/markdown; charset=utf-8`);
    assert.equal(res.headers["x-content-type-options"], "nosniff", `${name} 必须带 nosniff`);
    assert.equal(sha256(bodyOf(res)), sha256(readFileSync(join(promptsDistDir, name))), `${name} 响应必须与随包产物逐字节一致`);
  }

  // 结构性：路由块内**零写文件 API**（只读是断言，不是散文）。
  const src = readFileSync(hostIndex, "utf8");
  const start = src.indexOf("// g-481：使用说明弹窗的只读服务");
  const end = src.indexOf('path: "/api/dsh-graph/attachments"', start);
  assert.ok(start > 0 && end > start, "必须能在宿主源里定位 g-481 只读路由块");
  const block = src.slice(start, end);
  assert.match(block, /kind: "prefix"/, "资产路由必须是 prefix 路由");
  assert.match(block, /resolveHelpAssetRequest\(req\.url\)/, "尾段裁决必须走白名单解析器（单一真源）");
  // g-496：路径**只能来自冻结注册表**（`helpAssetRelativePath`），不得再把请求内容拼进路径；
  // 且必须显式处理「未注册 ⇒ null」（否则白名单放宽后可能拼出任意路径）。
  assert.match(block, /helpAssetRelativePath\(decision\.name\)/, "路由必须按冻结注册表解析相对路径（不得拼接请求内容）");
  assert.match(block, /if \(!relativePath\)/, "未注册名必须显式拒绝（不得回落到任一位置）");
  assert.match(block, /readFileSync\(new URL\(`\.\/\$\{relativePath\}`, import\.meta\.url\)\)/,
    "路由必须以 readFileSync 现读注册表给出的随包路径");
  assert.doesNotMatch(block, /readFileSync\(new URL\(`\.\/prompts\/\$\{/,
    "路由不得再把名字硬拼到 ./prompts/ 下（根级资产无法表达）");
  assert.doesNotMatch(
    block,
    /writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync|createWriteStream|truncateSync|chmodSync/,
    "只读路由块内不得出现任何写路径",
  );
});

test("g-481 A3（负向对照·真实可执行变异）：白名单放宽成「任意名字」⇒ 白名单外的 md 在策略层从 404 变 200", async () => {
  const tmpBase = join(repoRoot, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const mirrorRoot = mkdtempSync(join(tmpBase, "g481-neg-"));
  try {
    cpSync(distRoot, join(mirrorRoot, "dist"), { recursive: true, dereference: true });
    const mirrorIndex = join(mirrorRoot, "dist/index.js");
    const before = readFileSync(mirrorIndex, "utf8");
    const widened = before.replace(
      'if (!HELP_PROMPT_ASSETS.includes(name)) return { status: 404, reason: "unknown-asset" };',
      'if (false) return { status: 404, reason: "unknown-asset" };',
    );
    assert.notEqual(widened, before, "变异必须命中白名单判定那一行");
    writeFileSync(mirrorIndex, widened, "utf8");

    const mod: any = await import(pathToFileURL(mirrorIndex).href);
    // 基线（真实产物）—— 策略层与路由层都拒绝**未注册**的根级名字。
    // g-496：根级 `supervisor-guide.{zh,en}.md` 已纳入注册表（可达），故负例改用同为根级、
    // 形态合法但**未注册**的名字；判别力（放宽白名单 ⇒ 策略层从 404 变 200）不变。
    assert.equal(resolveHelpAssetRequest(`${HELP_ASSET_ROUTE}/supervisor-guide.md`).status, 404, "真实产物策略层必须拒绝未注册名字");
    assert.equal((await callAsset(`${HELP_ASSET_ROUTE}/supervisor-guide.md`)).code, 404, "真实产物路由层必须拒绝未注册名字");
    // 放宽白名单后：策略层放行（判别力来源）；路由层仍回落 404，只因包内没有该文件。
    assert.equal(mod.resolveHelpAssetRequest(`${HELP_ASSET_ROUTE}/supervisor-guide.md`).status, 200,
      "放宽白名单后未注册名字必须在策略层被放行");
    assert.equal(mod.resolveHelpAssetRequest(`${HELP_ASSET_ROUTE}/whatever.zh.md`).status, 200,
      "放宽白名单后任何合法名字都必须在策略层被放行");
    // g-496 追加：注册表驱动的**路径解析**不得成为新的外溢面 —— 未注册名必须解析为 null
    // （路由据此明确 404，绝不拼接请求内容、也不回落到任一位置）。
    assert.equal(mod.helpAssetRelativePath("supervisor-guide.md"), null, "未注册名必须解析为 null（不得回落到任一位置）");
    assert.equal(mod.helpAssetRelativePath("supervisor-guide.zh.md"), "prompts/supervisor-guide.zh.md", "注册名必须解析为冻结的 prompts 路径（合并布局）");
    assert.equal(mod.helpAssetRelativePath("usage.zh.md"), "prompts/usage.zh.md", "注册名必须解析为冻结的 prompts 路径");
    // 语法闸未动：穿越/非 md 仍被拒。
    assert.equal(mod.resolveHelpAssetRequest(`${HELP_ASSET_ROUTE}/%2e%2e%2findex.js`).status, 400);
    assert.equal(mod.resolveHelpAssetRequest(`${HELP_ASSET_ROUTE}/usage.zh.json`).status, 400);
  } finally {
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
});

// ================================================================ B. 帮助目录端点

/** 目录端点检查器（纯函数：输入进、问题清单出）—— 便于在内存变异上重放。 */
function catalogProblems(opts: { catalog: any; registered: any[]; assets: Array<{ name: string; base: string; lang: string }> }): string[] {
  const problems: string[] = [];
  const { catalog, registered, assets } = opts;
  if (!catalog || typeof catalog !== "object") return ["目录端点未回 JSON 对象"];
  if (!["zh", "en"].includes(catalog.prompt_language)) {
    problems.push(`prompt_language 必须是 zh/en（实得 ${JSON.stringify(catalog.prompt_language)}）`);
  }
  const regNames: string[] = registered.map((d) => d?.name);
  if (!Array.isArray(catalog.tools)) {
    problems.push("catalog.tools 必须是数组");
    return problems;
  }
  const toolNames: string[] = catalog.tools.map((t: any) => t?.name);
  if (toolNames.length !== regNames.length) {
    problems.push(`工具数必须等于注册真源（目录 ${toolNames.length} vs 注册 ${regNames.length}）`);
  }
  const missing = regNames.filter((n) => !toolNames.includes(n));
  if (missing.length) problems.push(`目录缺少注册工具：${missing.join(",")}`);
  const extra = toolNames.filter((n) => !regNames.includes(n));
  if (extra.length) problems.push(`目录含注册真源之外的工具（硬编码/残留）：${extra.join(",")}`);
  if (new Set(toolNames).size !== toolNames.length) problems.push("目录工具名重复");
  for (const t of catalog.tools) {
    const zh = String(t?.description?.zh ?? "").trim();
    const en = String(t?.description?.en ?? "").trim();
    if (!zh) problems.push(`工具 ${t?.name} 缺 zh 说明`);
    if (!en) problems.push(`工具 ${t?.name} 缺 en 说明`);
    else if (CJK.test(en)) problems.push(`工具 ${t?.name} 的 en 说明含 CJK`);
  }
  if (!Array.isArray(catalog.prompts)) {
    problems.push("catalog.prompts 必须是数组");
    return problems;
  }
  const promptNames: string[] = catalog.prompts.map((p: any) => p?.name);
  if (promptNames.length !== assets.length) {
    problems.push(`资产清单长度必须等于白名单（目录 ${promptNames.length} vs 白名单 ${assets.length}）`);
  }
  for (const a of assets) if (!promptNames.includes(a.name)) problems.push(`资产清单缺少 ${a.name}`);
  for (const p of catalog.prompts) {
    if (!HELP_PROMPT_ASSETS.includes(p?.name)) problems.push(`资产清单列出未随包发布的资产 ${JSON.stringify(p?.name)}`);
    if (!p?.base || !["zh", "en"].includes(p?.lang)) problems.push(`资产条目形状不合法：${JSON.stringify(p)}`);
  }
  return problems;
}

test("g-481 B1：工具清单逐项等于注册真源、说明 zh/en 成对（en 无 CJK），资产清单等于白名单投影", async () => {
  const { sT }: any = await import(pathToFileURL(join(distRoot, "lib/server-i18n.js")).href);
  const assets = helpPromptAssetEntries();
  assert.equal(assets.length, HELP_PROMPT_ASSETS.length, "资产投影必须与白名单等长");
  assert.deepEqual(assets.map((a) => a.name).sort(), [...HELP_PROMPT_ASSETS].sort(), "资产投影必须与白名单同集");
  // g-496：合并后资产**只有一处位置**（随包 `prompts/`），基名集合直接由目录派生 ——
  // 既防漂移，也防资产改名后残留死基名；并交叉核对「每个注册名都真的落在 prompts/ 下」。
  for (const n of HELP_PROMPT_ASSETS) {
    assert.equal(helpAssetRelativePath(n), `prompts/${n}`, `${n} 注册路径必须落在合并后的 prompts/ 布局`);
  }
  const packagedBases = [...new Set(
    packagedNames(promptsDistDir).map((n) => n.replace(/\.(zh|en)\.md$/, "")),
  )].sort();
  assert.deepEqual([...new Set(assets.map((a) => a.base))].sort(), packagedBases, "资产基名集合必须等于随包 prompts/ 目录投影（无漂移、无死基名）");
  for (const base of new Set(assets.map((a) => a.base))) {
    const langs = assets.filter((a) => a.base === base).map((a) => a.lang).sort();
    assert.deepEqual(langs, ["en", "zh"], `${base} 必须 zh/en 成对`);
  }

  const res = await callCatalog();
  assert.equal(res.code, 200, "目录端点必须 200");
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8", "目录端点回 JSON");
  const catalog = jsonOf(res);
  assert.deepEqual(catalogProblems({ catalog, registered: captured.registered, assets }), [], "目录端点结构基线必须全绿");

  // 注册真源 = apply 时 ctx.tools.register 的实收定义（不是本测试另抄一份清单）。
  assert.equal(captured.registered.length, catalog.tools.length, "注册工具数必须等于目录工具数");
  for (const t of catalog.tools) {
    const def = captured.registered.find((d) => d.name === t.name);
    assert.ok(def, `${t.name} 必须在注册真源里`);
    // 说明是 `tool.<name>` 的服务端 i18n 投影（单一真源，不是客户端自造文案）。
    assert.equal(t.description.zh, sT(`tool.${t.name}`, "zh"), `${t.name} 的 zh 说明必须来自 server-i18n`);
    assert.equal(t.description.en, sT(`tool.${t.name}`, "en"), `${t.name} 的 en 说明必须来自 server-i18n`);
    assert.ok(def.description && String(def.description).trim(), `${t.name} 注册时已有说明文案`);
  }

  // 负向对照（内存变异）：八类偏离各自必红并点名。
  const mutate = (fn: (c: any) => void) => { const copy = JSON.parse(JSON.stringify(catalog)); fn(copy); return catalogProblems({ catalog: copy, registered: captured.registered, assets }); };
  const cases: Array<[string, string[]]> = [
    ["漏掉一个工具", mutate((c) => { c.tools.splice(0, 1); }).filter((p) => p.includes("工具数") || p.includes("缺少注册工具"))],
    ["多出一个工具（硬编码/残留）", mutate((c) => { c.tools.push({ name: "graph_not_registered", description: { zh: "x", en: "x" } }); }).filter((p) => p.includes("之外的工具"))],
    ["工具改名", mutate((c) => { c.tools[0].name = "graph_renamed"; }).filter((p) => p.includes("缺少注册工具") || p.includes("之外的工具"))],
    ["en 说明为空", mutate((c) => { c.tools[0].description.en = ""; }).filter((p) => p.includes("缺 en 说明"))],
    ["en 说明混入 CJK", mutate((c) => { c.tools[0].description.en = "Create 目标"; }).filter((p) => p.includes("含 CJK"))],
    ["prompt_language 越界", mutate((c) => { c.prompt_language = "fr"; }).filter((p) => p.includes("prompt_language"))],
    ["资产清单缺项", mutate((c) => { c.prompts.splice(0, 1); }).filter((p) => p.includes("资产清单"))],
    ["资产清单混入未随包资产", mutate((c) => { c.prompts.push({ name: "not-packaged.zh.md", base: "not-packaged", lang: "zh" }); }).filter((p) => p.includes("未随包发布"))],
  ];
  for (const [label, problems] of cases) {
    assert.ok(problems.length > 0, `负向对照「${label}」必须报红并点名，实际：${JSON.stringify(problems)}`);
  }
  // 恢复：真实目录重新检查必须全绿。
  assert.deepEqual(catalogProblems({ catalog, registered: captured.registered, assets }), [], "移除变异后必须重新全绿");
});

test("g-481 B2：prompt_language 随宿主语言设置变化（settings.locale.preference），不是写死的 zh", async () => {
  // 缺省（无 settings 服务）⇒ 引擎降级口径：zh。
  assert.equal(jsonOf(await callCatalog()).prompt_language, "zh", "无语言服务时缺省 zh");
  // 显式 locale ⇒ 目录语言随之变化（证明它取自 resolvePromptLanguage，而非常量）。
  assert.equal(jsonOf(await callCatalog("en")).prompt_language, "en", "locale=en ⇒ prompt_language=en");
  assert.equal(jsonOf(await callCatalog("zh")).prompt_language, "zh", "locale=zh ⇒ prompt_language=zh");
  // 方法面：目录端点是只读 GET。
  const res = fakeRes();
  await catalogRoute.handler({ headers: { [OWNER_HEADER]: "1" }, method: "POST", url: HELP_CATALOG_ROUTE }, res);
  assert.equal(res.code, 405, "目录端点 POST 必须 405");
});

// ================================================================ C. 客户端结构与接线

function readBuildParts(): string[] {
  const script = readFileSync(buildClientScript, "utf8");
  const start = script.indexOf("PARTS=(");
  const end = script.indexOf("\n)", start);
  assert.ok(start >= 0 && end > start, "build-client.sh 含 PARTS=(...) 列表");
  return [...script.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

/** 客户端结构检查器（纯函数：文本进、问题清单出）—— 便于在内存变异上重放。 */
function helpClientProblems(opts: { kanban: string; modal: string; bundle: string; parts: string[] }): string[] {
  const problems: string[] = [];
  const { kanban, modal, bundle, parts } = opts;
  // ① 五个页签（顺序即展示顺序），标签键齐全。
  const tabsStart = modal.indexOf("const HELP_TABS = [");
  const tabsEnd = modal.indexOf("];", tabsStart);
  const tabsBlock = tabsStart >= 0 && tabsEnd > tabsStart ? modal.slice(tabsStart, tabsEnd) : "";
  const tabKeys = [...tabsBlock.matchAll(/key: "([^"]+)"/g)].map((m) => m[1]!);
  const wantTabs = ["usage", "prompts", "tools", "faq", "design"];
  if (JSON.stringify(tabKeys) !== JSON.stringify(wantTabs)) {
    problems.push(`HELP_TABS 必须恰是 ${wantTabs.join("/")}（实得 ${JSON.stringify(tabKeys)}）`);
  }
  for (const k of wantTabs) {
    if (!tabsBlock.includes(`labelKey: "help.tab.${k}"`)) problems.push(`页签 ${k} 缺 i18n 键 help.tab.${k}`);
  }
  // 页签栏必须由 HELP_TABS 驱动（写死子集 ⇒ 加了页签界面不显示）。
  if (!/HELP_TABS\.map\(/.test(modal)) problems.push("页签栏必须由 HELP_TABS 驱动（不得写死子集）");
  // ② 版本：唯一真源 PLUGIN_VERSION，模块内零版本字面量。
  if (!/dgT\("help\.version", \{ version: PLUGIN_VERSION \}\)/.test(modal)) {
    problems.push("使用说明页签必须以 PLUGIN_VERSION 渲染当前版本");
  }
  if (/\b\d+\.\d+\.\d+\b/.test(modal)) {
    problems.push("弹窗内不得出现版本字面量（唯一真源 = constants.js 的 PLUGIN_VERSION）");
  }
  // ③ 工具名 / 资产名零硬编码：清单与正文都来自宿主面。
  if (/[a-z0-9-]+\.(?:zh|en)\.md/.test(modal)) problems.push("弹窗不得硬编码提示词资产名（清单来自 /help/catalog）");
  if (/\bgraph_[a-z_]+\b/.test(modal)) problems.push("弹窗不得硬编码工具名（清单来自 /help/catalog）");
  if (!modal.includes('"/api/dsh-graph/help/catalog"')) problems.push("弹窗必须从宿主帮助目录端点取清单");
  if (!modal.includes('"/api/dsh-graph/help/asset/"')) problems.push("弹窗必须从宿主只读资产路由取正文");
  // ④ 五个页签各有真内容。
  if (!/HELP_USAGE_KEYS\.map/.test(modal)) problems.push("使用说明页签缺段落清单");
  if (!/HELP_FAQ_ITEMS\.map/.test(modal) || !/help\.faq\.q/.test(modal) || !/help\.faq\.a/.test(modal)) {
    problems.push("常见问题页签缺问答渲染（q/a 成对）");
  }
  if (!/h\(GoalMarkdown, \{ text:/.test(modal)) problems.push("提示词模板页签必须用既有 markdown 渲染器渲染资产正文");
  if (!/catalog\.tools/.test(modal)) problems.push("工具清单页签必须渲染目录里的工具（不得另抄清单）");
  for (const f of ["design-philosophy.lifecycle.html", "design-philosophy.workflow.html", "design-philosophy.architecture.html"]) {
    if (!modal.includes(f)) problems.push(`Graph 设计页签缺图产物引用 ${f}`);
  }
  if (!/const src = "\/api\/dsh-graph\/diagram\/" \+ active\.file;/.test(modal)) problems.push("图必须走宿主只读路由（相对同源路径）");
  if (!/h\("iframe", \{/.test(modal)) problems.push("Graph 设计页签缺 iframe 内嵌");
  if (!/React\.useState\("lifecycle"\)/.test(modal)) problems.push("图页签缺本地切换状态（可切换）");
  if (!/dgT\("design\.notice"\)/.test(modal)) problems.push("Graph 设计页签缺如实声明文案");
  if (!/className: "dg-design-roadmap"/.test(modal) || !/dgT\("design\.roadmap"\)/.test(modal)) {
    problems.push("Graph 设计页签缺 notice 下方的独立路线图小节");
  }
  // ⑤ g-181：单独 portal 浮层 + backdrop guard + panel stopPropagation。
  const guarded = modal.match(/style: S\.overlay, \.\.\.\w+Guard/g) ?? [];
  if (guarded.length !== 1) problems.push(`弹窗必须恰有 1 处 style: S.overlay 接 guard（实得 ${guarded.length}）`);
  if (/style: S\.overlay, onClick:/.test(modal)) problems.push("禁止裸 style: S.overlay, onClick:（会误关弹窗）");
  if (!/onClick: \(e\) => e\.stopPropagation\(\)/.test(modal)) problems.push("panel 必须保留 stopPropagation");
  // ⑥ 看板接线：两处入口（平铺 + 折叠弹层）+ 稳定 key 挂载 + hasModal 纳入。
  const btnUses = [...kanban.matchAll(/dgT\("help\.btn"\)/g)].length;
  if (btnUses !== 2) problems.push(`看板 dgT("help.btn") 应恰好 2 处（平铺 + 折叠弹层），实得 ${btnUses}`);
  if (!/className: "dg-btn dg-help-btn"/.test(kanban)) problems.push("平铺工具条缺「使用说明」按钮（dg-help-btn）");
  if (!/showHelpModal\s*\n?\s*\? h\(HelpModal, \{\s*key: "dg-help-modal",\s*onClose: \(\) => setShowHelpModal\(false\),/.test(kanban)) {
    problems.push("看板未挂载 HelpModal（或缺少稳定 key dg-help-modal）");
  }
  if (!/showMemoryModal \|\| showHelpModal \|\| showTagFilterModal/.test(kanban)) {
    problems.push("hasModal 未纳入 showHelpModal（弹窗打开时看板遮罩语义会漂移）");
  }
  if (/DesignPhilosophyModal|setShowDesignModal/.test(kanban)) problems.push("看板不得再留旧的独立设计入口/组件");
  // ⑦ 生成物与构建次序。
  if (!bundle.includes("function HelpModal(")) problems.push("dist/lib/client.js 未包含 HelpModal（需重建）");
  if (!bundle.includes("dg-help-modal")) problems.push("dist/lib/client.js 未包含弹窗挂载点");
  const hi = parts.indexOf("help-modal");
  const di = parts.indexOf("drag-prompts");
  if (hi < 0) problems.push("build-client PARTS 缺 help-modal");
  if (parts.includes("design-modal")) problems.push("build-client PARTS 不得再含 design-modal（已并入 help-modal）");
  if (hi >= 0 && di >= 0 && hi > di) problems.push("help-modal 必须排在 drag-prompts 之前（否则成为 KanbanView 内嵌组件，图会反复重载）");
  return problems;
}

const readClientFiles = () => ({
  kanban: readFileSync(kanbanSrcPath, "utf8"),
  modal: readFileSync(helpModalPath, "utf8"),
  bundle: readFileSync(bundlePath, "utf8"),
  parts: readBuildParts(),
});

test("g-481 C1：五页签结构齐全、清单零硬编码、版本走 PLUGIN_VERSION、看板接线与 PARTS 次序正确", () => {
  assert.ok(existsSync(helpModalPath), "客户端必须有 help-modal.js");
  assert.ok(!existsSync(designModalPath), "原独立 design-modal.js 必须已删除（并入「使用说明」）");
  const real = readClientFiles();
  assert.deepEqual(helpClientProblems(real), [], "客户端结构断言必须全绿");
  // 版本唯一真源：客户端常量与宿主 package.json 必须一致（发布红线，不在本插件的 UI 里写第二份）。
  const versionOf = (text: string, re: RegExp) => (text.match(re) ?? [])[1];
  const pluginVersion = versionOf(readFileSync(clientConstantsPath, "utf8"), /PLUGIN_VERSION\s*=\s*"([^"]+)"/);
  const pkgVersion = JSON.parse(readFileSync(join(repoRoot, "dsh-graph-host/package.json"), "utf8")).version;
  assert.ok(pluginVersion, "constants.js 必须定义 PLUGIN_VERSION");
  assert.equal(pluginVersion, pkgVersion, "PLUGIN_VERSION 必须与宿主 package.json 版本一致");
  assert.ok(real.bundle.includes(pluginVersion), "生成物必须内嵌当前 PLUGIN_VERSION");
});

test("g-481 C2（负向对照·内存变异）：硬编码清单 / 版本字面量 / PARTS 次序倒置 / 缺组件 ⇒ 结构断言必红", () => {
  const real = readClientFiles();
  assert.deepEqual(helpClientProblems(real), [], "基线必须为绿");
  const mutations: Array<[string, typeof real, string]> = [
    ["弹窗里硬编码工具名", { ...real, modal: real.modal.replace('const HELP_CATALOG_URL = ', 'const HELP_TOOL = "graph_create_goal";\n    const HELP_CATALOG_URL = ') }, "硬编码工具名"],
    ["弹窗里硬编码资产名", { ...real, modal: real.modal.replace("const HELP_ASSET_URL", 'const HELP_ASSET_NAME = "usage.zh.md";\n    const HELP_ASSET_URL') }, "硬编码提示词资产名"],
    ["弹窗里写死版本号", { ...real, modal: real.modal.replace("dgT(\"help.version\"", 'dgT("help.version") + "0.20.2" && dgT("help.version"') }, "版本字面量"],
    ["拿掉一个页签", { ...real, modal: real.modal.replace('      { key: "faq", labelKey: "help.tab.faq" },\n', "") }, "HELP_TABS"],
    ["PARTS 次序倒置（help-modal 排到 drag-prompts 之后）", { ...real, parts: ["drag-prompts", "help-modal", "kanban"] }, "drag-prompts 之前"],
    ["bundle 缺组件（源改了没重建）", { ...real, bundle: real.bundle.replace(/function HelpModal\(/g, "function XHelpModal(") }, "未包含 HelpModal"],
    ["看板拿掉平铺入口", { ...real, kanban: real.kanban.replace(/className: "dg-btn dg-help-btn"/, 'className: "dg-btn dg-x-btn"') }, "dg-help-btn"],
  ];
  for (const [label, mutated, expect] of mutations) {
    assert.notDeepEqual(mutated, real, `负向对照「${label}」必须真实改变输入`);
    const got = helpClientProblems(mutated);
    assert.ok(got.some((p) => p.includes(expect)), `变异「${label}」必须报红并点名「${expect}」，实际：${JSON.stringify(got)}`);
  }
  assert.deepEqual(readClientFiles(), real, "负向对照必须是 hermetic 的（真实文件零改动）");
});

test("g-481 C3：Graph 设计页签的两张图随包且真能经宿主只读路由加载（图内嵌可见性的可自动化部分）", async () => {
  const modal = readFileSync(helpModalPath, "utf8");
  const block = (modal.match(/const DESIGN_DIAGRAM_TABS = \[([\s\S]*?)\];/) ?? [])[1] ?? "";
  const files = [...block.matchAll(/file: "([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(files.length, 3, "Graph 设计页签必须恰有三张图（lifecycle / workflow / architecture）");
  const diagramRoute = captured.route;
  assert.equal(diagramRoute.path, NAMESPACE, `唯一入口覆盖命名空间（图路由 ${DESIGN_DIAGRAM_ROUTE} 在其内）`);
  for (const file of files) {
    assert.ok(!/^https?:|^\/\//.test(file), `${file} 不得是绝对/外站 URL（必须同源随包）`);
    const src = join(repoRoot, "dsh-graph-host/diagrams", file);
    const dst = join(distRoot, "diagrams", file);
    assert.ok(existsSync(src) && existsSync(dst), `${file} 必须随包发布（源与 dist 都在）`);
    assert.equal(sha256(readFileSync(dst)), sha256(readFileSync(src)), `${file} 随包副本必须与源逐字节一致`);
    const res = fakeRes();
    await diagramRoute.handler({ headers: { [OWNER_HEADER]: "1" }, method: "GET", url: `${DESIGN_DIAGRAM_ROUTE}/${file}` }, res);
    assert.equal(res.code, 200, `${file} 必须能加载（200）`);
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8", `${file} 必须回 text/html`);
    assert.equal(res.headers["x-content-type-options"], "nosniff", `${file} 必须带 nosniff`);
    assert.equal(sha256(bodyOf(res)), sha256(readFileSync(dst)), `${file} 响应必须与随包产物逐字节一致`);
  }
  // 客户端必须用与宿主同一路由前缀拼 URL（写死别的路径 ⇒ 图打不开）。
  assert.ok(modal.includes(`"${DESIGN_DIAGRAM_ROUTE}/"`), `客户端必须以内嵌图路由前缀 ${DESIGN_DIAGRAM_ROUTE}/ 拼 URL`);
  // 负向对照：未随包的图名必须 404（证明「能加载」不是路由对任何名字都放行）。
  const neg = fakeRes();
  await diagramRoute.handler({ headers: { [OWNER_HEADER]: "1" }, method: "GET", url: `${DESIGN_DIAGRAM_ROUTE}/not-a-diagram.html` }, neg);
  assert.equal(neg.code, 404, "未随包的图名必须 404");
});

// ================================================================ D. i18n
function loadI18n() {
  const sandbox: any = { React: {} };
  const src = readFileSync(i18nSrcPath, "utf8");
  vm.runInNewContext(src + "; this.zh = zh; this.en = en;", sandbox);
  return { zh: sandbox.zh as Record<string, string>, en: sandbox.en as Record<string, string> };
}

const REQUIRED_HELP_KEYS = [
  "help.btn", "help.title", "help.version",
  "help.tab.usage", "help.tab.prompts", "help.tab.tools", "help.tab.faq", "help.tab.design",
  "help.lang.zh", "help.lang.en",
  "help.usage.what", "help.usage.board", "help.usage.flow", "help.usage.dispatch", "help.usage.review", "help.usage.tabs",
  "help.prompts.intro", "help.prompts.source", "help.prompts.loading", "help.prompts.error",
  "help.tools.intro", "help.tools.langHint", "help.tools.loading", "help.tools.error",
  "help.faq.intro",
  ...["usage", "help", "discipline", "guide-hint", "minor-task", "no-isolation", "worktree"].map((b) => `help.asset.${b}`),
  ...[1, 2, 3, 4, 5, 6].flatMap((i) => [`help.faq.q${i}`, `help.faq.a${i}`]),
];

/** i18n 检查器（纯函数）：help.* 键对称 + 必备键 + 非空 + en 无 CJK + 版本占位符。 */
function i18nProblems(zh: Record<string, string>, en: Record<string, string>): string[] {
  const problems: string[] = [];
  const zhKeys = Object.keys(zh).filter((k) => k.startsWith("help.")).sort();
  const enKeys = Object.keys(en).filter((k) => k.startsWith("help.")).sort();
  if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
    problems.push(`help.* 键 zh/en 不对称：zh 独有 [${zhKeys.filter((k) => !enKeys.includes(k)).join(",")}]；en 独有 [${enKeys.filter((k) => !zhKeys.includes(k)).join(",")}]`);
  }
  for (const k of REQUIRED_HELP_KEYS) {
    if (!(k in zh) || !(k in en)) problems.push(`缺 help 键 ${k}`);
  }
  for (const k of zhKeys) {
    const z = String(zh[k] ?? "");
    const e = String(en[k] ?? "");
    if (!z.trim()) problems.push(`help 键 ${k} 的 zh 值为空`);
    if (!e.trim()) problems.push(`help 键 ${k} 的 en 值为空`);
    if (CJK.test(e)) problems.push(`help 键 ${k} 的 en 值含 CJK`);
  }
  for (const k of ["help.version"]) {
    if (!String(zh[k] ?? "").includes("{version}")) problems.push(`${k} 的 zh 值必须带 {version} 占位（版本唯一真源）`);
    if (!String(en[k] ?? "").includes("{version}")) problems.push(`${k} 的 en 值必须带 {version} 占位（版本唯一真源）`);
  }
  return problems;
}

test("g-481 D1：help.* zh/en 键对称、必备键齐全、en 无 CJK、每个资产基名都有展示标签", () => {
  const { zh, en } = loadI18n();
  assert.deepEqual(i18nProblems(zh, en), [], "help.* i18n 基线必须全绿");
  // 资产基名 → 展示标签（缺标签时客户端回退基名，但随包资产必须都有标签）。
  for (const base of new Set(helpPromptAssetEntries().map((a) => a.base))) {
    assert.ok(zh[`help.asset.${base}`], `zh 缺资产标签 help.asset.${base}`);
    assert.ok(en[`help.asset.${base}`], `en 缺资产标签 help.asset.${base}`);
  }
  // 页签标题必须真的不同（防「五个页签同一句话」）。
  const titles = ["usage", "prompts", "tools", "faq", "design"].map((k) => zh[`help.tab.${k}`]);
  assert.equal(new Set(titles).size, 5, "五个页签标题不得重复");
  // 负向对照：删键 / 键集不对称 / en 混 CJK 各自必红。
  const dropEn = { ...en };
  delete dropEn["help.tab.faq"];
  assert.ok(i18nProblems(zh, dropEn).some((p) => p.includes("不对称") || p.includes("缺 help 键")), "删掉 en 键必须判红");
  assert.ok(i18nProblems({ ...zh, "help.extra": "只此一份" }, en).some((p) => p.includes("不对称")), "zh 多出键必须判红");
  assert.ok(i18nProblems(zh, { ...en, "help.tab.faq": "常见问题" }).some((p) => p.includes("含 CJK")), "en 混入 CJK 必须判红");
});
