/**
 * g-351：宿主 settings 服务形态换代的**能力探测分流**回归测试。
 *
 * 背景（实测）：宿主从 0.1.6-alpha.2 前移到 0.1.7-rc.1 后，`ctx.settings` 上不再有
 * namespace 注册 API（`settings.register`），插件因此打出
 * `[dsh-graph-host] g-133 settings 注册失败（降级，模型路由/提示词走默认）：sctx.settings.register is not a function`
 * 并**静默降级**。修复要求：按能力探测分流（新 API 存在走新路径、否则回落旧路径），
 * 且**不得**按版本号字面量分支。
 *
 * 本测试把三种宿主形态都钉住：
 *   ① 新形态（只有 `describe` / 表单投影）→ 值取自本插件 entry 的 Config，不得再报「注册失败」；
 *   ② 旧形态（有 `register`，无 `describe`）→ 仍走 namespace 注册，行为不退化；
 *   ③ 两种能力都没有 → 如实说明「能力不可用」（而不是伪装成注册异常）。
 *
 * 可观测载荷：profile 全局默认 `promptLanguage` 决定注册给宿主的 supervisor-guide skill 用
 * 中文还是英文资产 —— 值被真正读到才会变。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { apply } from "../../dist/index.js";

const dist = join(process.cwd(), "dist");
const hostSource = () => readFileSync(join(dist, "index.js"), "utf8");
const guideEn = () => readFileSync(join(dist, "supervisor-guide.en.md"), "utf8");
const guideZh = () => readFileSync(join(dist, "supervisor-guide.zh.md"), "utf8");

/** 捕获 apply 期间的 stderr；apply 内 setupGraphSettings 同步执行（无 await）。 */
function captureStderr(fn) {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(String(s));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as unknown as { write: typeof orig }).write = orig;
  }
  return chunks.join("");
}

/** 最小宿主 mock：只提供本用例关心的服务，其余按可选缺失处理。 */
function makeCtx(services: Record<string, unknown>) {
  const registeredSkills: any[] = [];
  const ctx: any = {
    get: (name: string) => {
      if (name === "skills") return { register: (d: any) => registeredSkills.push(d) };
      if (name === "sandboxPolicy") return { workspaceRoot: process.cwd() };
      return services[name];
    },
    effect: (fn: () => unknown) => fn(),
    tools: { register: () => () => {}, get: () => ({}) },
  };
  return { ctx, registeredSkills };
}

/** `ctx.inject(["settings"], cb)` 的同步桩：直接以给定 settings 服务回调。 */
const injectWith = (settings: unknown) => (names: string[], cb: (sctx: any) => void) => {
  if (names.includes("settings")) cb({ settings, effect: (fn: () => unknown) => fn() });
};

/**
 * 旧路径的 schema 需 schemastery；仓储测试环境不装 @deepseek-ai/*，
 * 故在 tmp 内放一个最小桩，并把 process.argv[1] 指过去，让 resolveSchemastery 能命中。
 * 旧路径与「register+describe 同时存在」两例共用（NB-1）。
 */
function withSchemasteryStub<T>(fn: () => T): T {
  const root = join(process.cwd(), "tmp", `g351-stub-${process.pid}`);
  const pkgDir = join(root, "node_modules", "@deepseek-ai", "schemastery");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/schemastery", version: "0.0.0-test", main: "index.cjs" }));
  writeFileSync(
    join(pkgDir, "index.cjs"),
    [
      "const field = () => ({ default: () => field(), volatile: () => field() });",
      "module.exports = { object: () => ({}), string: () => field(), union: () => field() };",
    ].join("\n"),
  );
  const bin = join(root, "bin.js");
  writeFileSync(bin, "// stub entry for resolveSchemastery base\n");
  const prevArgv1 = process.argv[1];
  process.argv[1] = bin;
  try {
    return fn();
  } finally {
    process.argv[1] = prevArgv1;
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 剥离 JS 源码里的注释（行注释与块注释），字符串字面量原样保留。
 * 用状态机而不是按行 replace 删 `//` 之后的内容：后者会被块注释与含双斜杠的
 * 字符串（URL、正则字面量）绕过，也会误删字符串里的双斜杠。
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += next ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i += 1; continue; }
    if (c === "/" && next === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

test("g-351 判据3：新形态（settings 无 register、有 describe）走新路径，且不再报「注册失败」", () => {
  const calls: string[] = [];
  const settings = {
    // 0.1.7 线：SettingsForms.describe() → descriptor.ns 为 profile 条目 id
    describe: (opts: any) => {
      calls.push(`describe:${JSON.stringify(opts)}`);
      return [
        { ns: "some-other-plugin", value: { x: 1 } },
        { ns: "dsh-graph-host", value: { subagentProvider: "prov-x", promptLanguage: "en" } },
      ];
    },
  };
  const { ctx, registeredSkills } = makeCtx({ settings });
  ctx.inject = injectWith(settings);

  const stderr = captureStderr(() => apply(ctx, { root: ".dsh-graph" }));

  assert.equal(/settings 注册失败/.test(stderr), false, "新宿主上不得再出现「settings 注册失败」告警");
  assert.equal(/能力不可用/.test(stderr), false, "新形态下能力可用，不得报能力缺失");
  assert.ok(calls.length >= 1, "必须真正调用 describe()（而不是静默跳过）");

  const supervisor = registeredSkills.find((s) => s.name === "dsh-graph-supervisor");
  assert.ok(supervisor, "dsh-graph-supervisor skill 已注册");
  assert.equal(supervisor.content, guideEn(), "profile 全局 promptLanguage=en 必须真正被读到（新路径生效）");
});

test("g-351 判据3：旧形态（settings 有 register、无 describe）仍走 namespace 注册，不退化", () => {
  withSchemasteryStub(() => {
    const registerCalls: any[] = [];
    const settings = {
      register: (ns: string, schema: unknown, options: unknown) => {
        registerCalls.push({ ns, schema, options });
        return { get: () => ({ promptLanguage: "en" }) };
      },
      // 旧宿主没有表单投影 API（这正是 0.1.6 线的形态）
    };
    const { ctx, registeredSkills } = makeCtx({ settings });
    ctx.inject = injectWith(settings);

    const stderr = captureStderr(() => apply(ctx, { root: ".dsh-graph" }));

    assert.equal(registerCalls.length, 1, "旧宿主必须仍调用 settings.register（能力探测不得误判）");
    assert.equal(registerCalls[0].ns, "dsh-graph", "namespace 契约不变");
    assert.deepEqual(
      (registerCalls[0].options as any)?.base,
      { subagentProvider: "", subagentModel: "", subagentMode: "", subagentReasoningEffort: "", subagentPrompt: "", promptLanguage: "follow" },
      "旧路径的 base 默认层不变",
    );
    assert.equal(/settings 注册失败|能力不可用/.test(stderr), false, "旧路径正常注册时不得有任何降级告警");

    const supervisor = registeredSkills.find((s) => s.name === "dsh-graph-supervisor");
    assert.equal(supervisor?.content, guideEn(), "旧路径 scope.get() 的 promptLanguage=en 必须生效");
  });
});

test("g-351 NB-1：register 与 describe 同时具备时 register 优先（0.1.6 真实形态）", () => {
  // 承载性不变量：0.1.6 线的 SettingsProvider 同时暴露 register 与 describe，
  // 但 describe 的 `ns` 是 namespace 而非 profile 条目 id ⇒ 误走表单分支会**静默**
  // 返回 mode_source=default（无任何告警）。本用例把「旧能力优先」钉住。
  withSchemasteryStub(() => {
    const registerCalls: any[] = [];
    const describeCalls: any[] = [];
    const settings = {
      register: (ns: string, schema: unknown, options: unknown) => {
        registerCalls.push({ ns, schema, options });
        return { get: () => ({ promptLanguage: "en" }) };
      },
      // 0.1.6 也有 describe：若判定顺序反了，值会取自这里（另一个 namespace），
      // 而不是 register 返回的 scope ⇒ 静默退回默认。
      describe: (opts: any) => {
        describeCalls.push(opts);
        return [
          { ns: "dsh-graph", value: { promptLanguage: "zh" } }, // namespace 同名但语义不同
          { ns: "dsh-graph-host", value: { promptLanguage: "zh" } },
        ];
      },
    };
    const { ctx, registeredSkills } = makeCtx({ settings });
    ctx.inject = injectWith(settings);

    const stderr = captureStderr(() => apply(ctx, { root: ".dsh-graph" }));

    assert.equal(registerCalls.length, 1, "两种能力都在时必须走 register（旧能力优先）");
    assert.equal(registerCalls[0].ns, "dsh-graph", "namespace 契约不变");
    assert.equal(describeCalls.length, 0, "register 可用时**不得**调用 describe（否则静默返回默认值）");
    assert.equal(/settings 注册失败|能力不可用/.test(stderr), false, "该形态下不得有任何降级告警");

    const supervisor = registeredSkills.find((s) => s.name === "dsh-graph-supervisor");
    assert.equal(supervisor?.content, guideEn(), "值必须来自 register 的 scope.get()（而非 describe 投影）");
  });
});

test("g-351 判据3：两种能力都缺失时如实报「能力不可用」，不伪装成注册异常", () => {
  const settings = {}; // 既无 register 也无 describe
  const { ctx, registeredSkills } = makeCtx({ settings });
  ctx.inject = injectWith(settings);

  const stderr = captureStderr(() => apply(ctx, { root: ".dsh-graph" }));

  assert.equal(/settings 注册失败/.test(stderr), false, "不得再输出误导性的「注册失败」");
  assert.match(stderr, /g-351 settings 能力不可用/, "必须如实说明是能力缺失");
  // 降级但绝不中断：skill 仍按默认语言（zh）注册
  const supervisor = registeredSkills.find((s) => s.name === "dsh-graph-supervisor");
  assert.equal(supervisor?.content, guideZh(), "能力缺失时回落默认语言，插件照常可用");
});

test("g-351 判据4：settings 分流块零版本号字面量比较", () => {
  const src = hostSource();
  const start = src.indexOf("let graphSettingsScope = null;");
  const end = src.indexOf("setupGraphSettings();");
  assert.ok(start > 0 && end > start, "定位 g-351 settings 分流块");
  // 只对**代码**设限：注释里说明「0.1.6 线 / 0.1.7 线」是证据性描述，不是分支依据。
  // 用状态机剥注释（见 stripComments）：按行删 `//` 会被块注释与含双斜杠的字符串/正则绕过。
  const code = stripComments(src.slice(start, end));
  assert.match(code, /typeof svc\?\.register === "function"/, "必须按能力探测旧路径");
  assert.match(code, /typeof svc\?\.describe === "function"/, "必须按能力探测新路径");
  assert.doesNotMatch(code, /0\.1\.\d|semver|compareVersion|versionCompare|PLUGIN_VERSION/, "不得按版本号分支");
});

test("g-351 判据3：profile 全局默认字段以 volatile 声明（新宿主表单可热改）", () => {
  const src = hostSource();
  assert.match(src, /function buildGraphSettingsConfigSchema\(z\)/, "必须导出 Config 的 schema 构造器");
  assert.match(src, /export \{ graphSettingsConfig as Config \}/, "必须以命名导出 Config 暴露给宿主");
  const start = src.indexOf("function buildGraphSettingsConfigSchema(z)");
  const end = src.indexOf("function resolveSchemastery()");
  const block = src.slice(start, end);
  for (const field of ["subagentProvider", "subagentMode", "subagentModel", "subagentReasoningEffort", "subagentPrompt", "promptLanguage"]) {
    assert.match(block, new RegExp(`${field}: live\\(`), `${field} 必须经 volatile 包装（否则宿主的表单投影不会收录本 entry）`);
  }
  // 旧路径 schema 必须保持原样（不是 volatile），否则 namespace 解析出的会是 volatile 包装而非标量
  assert.match(src, /subagentMode: z\.union\(\["", "standard", "minimal"\]\)\.default\(""\)/);
});

// ---------------------------------------------------------------------------
// 客户端：子代理目录的**形状 / 能力探测**
//
// 两代宿主是**两层同时换代**，两层都必须探测（att-001 只换了容器，漏了 entry 形状，
// 导致 0.1.7 上 entry 能读到但谓词恒假 ⇒ 点「↗ 转到对话」静默打开父会话）：
//   容器：0.1.6 `list.getSnapshot().subagentsByParent[pid].entries`
//         0.1.7 `list.getSnapshot().projectionsBySession[sid].values.subagentCatalog`
//         （0.1.7 全参考树 `subagentsByParent` 零命中）
//   entry：0.1.6 `{kind:'child'|'diagnostic', id, activity, hasChildren, mode, label?}`——**带 kind**
//          （权威：0.1.6 dsh-api-remotes/lib/client.js 的 subagents.list 结果 schema）
//         0.1.7 `{id, createdAt, mode:'one-shot'|'continuable'|'unknown', label?}`——**无 kind**
//          （权威：0.1.7 dsh-api-remotes/lib/client.js:9055 的 subagentCatalog union；
//           0.1.7 全树 client.js 对 `kind === "child"` 零命中）
// 夹具一律使用上述**真实 wire 形状**，不得自造宿主不存在的字段。
// ---------------------------------------------------------------------------

/** 0.1.6 真实 entry（subagents.list 结果；带判别字段 kind）。 */
const ENTRY_016_CHILD = Object.freeze({
  kind: "child", id: "child-cont", activity: "inactive", hasChildren: false, mode: "continuable", label: "Child",
});
const ENTRY_016_DIAGNOSTIC = Object.freeze({ kind: "diagnostic", id: "child-diag", reason: "corrupt" });
/** 0.1.7 真实 entry（subagentCatalog 投影；无 kind，新增 mode:'unknown'）。 */
const ENTRY_017_CONTINUABLE = Object.freeze({ id: "child-cont", createdAt: 11, mode: "continuable", label: "Child" });
const ENTRY_017_ONESHOT = Object.freeze({ id: "child-one", createdAt: 12, mode: "one-shot" });
const ENTRY_017_UNKNOWN = Object.freeze({ id: "child-unk", createdAt: 13, mode: "unknown" });

/** 0.1.6 快照：只有 subagentsByParent（0.1.6 getListSnapshot 的真实字段集）。 */
function snapshot016(entries: readonly unknown[]) {
  return { items: [], state: "idle", phase: "ready", error: null, subagentsByParent: { "parent-1": { entries, parentAvailable: true } }, jobsBySession: {} };
}
/** 0.1.7 快照：只有 projectionsBySession（0.1.7 getListSnapshot 的真实字段集）。 */
function snapshot017(catalog: readonly unknown[]) {
  return { items: [], state: "idle", phase: "ready", error: null, projectionsBySession: { "parent-1": { values: { subagentCatalog: catalog }, state: "idle", error: null } } };
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源模块中存在 function ${name}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} 花括号无法配平`);
}

const CATALOG_FUNCS = [
  "subagentCatalogEntries",
  "isCatalogChildEntry",
  "catalogChildEntry",
  "catalogParentIndex",
  "catalogEntryMode",
  "catalogAddressMode",
  "subagentAddressOf",
  "refreshSubagentCatalog",
];

function makeCatalogSandbox() {
  const bundle = readFileSync(join(dist, "lib/client.js"), "utf8");
  const code = [
    ...CATALOG_FUNCS.map((name) => extractFunction(bundle, name)),
    `this.api = { ${CATALOG_FUNCS.join(", ")} };`,
  ].join("\n");
  const sandbox: any = { Promise, console: { warn: () => {} } };
  vm.runInNewContext(code, sandbox, { filename: "dist/lib/client.js#subagentCatalog" });
  return sandbox.api;
}

test("g-351 客户端：0.1.7 真实 entry 形状（无 kind）下子会话可解析为子会话地址，不静默退化为父会话", () => {
  const { subagentCatalogEntries, subagentAddressOf, catalogChildEntry, isCatalogChildEntry } = makeCatalogSandbox();
  const catalog = [ENTRY_017_ONESHOT, ENTRY_017_CONTINUABLE, ENTRY_017_UNKNOWN];
  const rtNew: any = { list: { getSnapshot: () => snapshot017(catalog) } };

  // 跨 vm realm 对象原型不同，用 JSON 比较取值而非 deepEqual
  assert.equal(JSON.stringify(subagentCatalogEntries(rtNew, "parent-1")), JSON.stringify(catalog), "新容器（projectionsBySession）目录必须可读");
  for (const e of catalog) {
    assert.equal(isCatalogChildEntry(e, e.id), true, `0.1.7 entry ${e.id}（无 kind）必须被形状探测认作子会话`);
  }
  assert.equal(JSON.stringify(catalogChildEntry(catalog, "child-cont")), JSON.stringify(ENTRY_017_CONTINUABLE), "无 kind 的 entry 必须能按 id 命中");
  assert.equal(catalogChildEntry(catalog, "nope"), null, "未收录必须返回 null（调用方按未收录降级）");
  // 关键回归点：这一处 undefined ⇒ plugin.js 走 else「child not in catalog, opening parent」
  assert.equal(
    JSON.stringify(subagentAddressOf(rtNew, "parent-1", "child-cont")),
    JSON.stringify({ parentSessionId: "parent-1", childSessionId: "child-cont", mode: "continuable" }),
    "0.1.7 上必须能构造出子会话地址（否则「↗ 转到对话」静默打开父会话）",
  );
  assert.equal(
    JSON.stringify(subagentAddressOf(rtNew, "parent-1", "child-unk")),
    JSON.stringify({ parentSessionId: "parent-1", childSessionId: "child-unk", mode: "unknown" }),
    "mode:'unknown' 必须原样下发宿主的「未判定」通配值，不得臆断成 one-shot/continuable",
  );
});

test("g-351 客户端：0.1.6 真实 entry 形状（带 kind）不退化，且 diagnostic 行不得被误认成子会话", () => {
  const { subagentCatalogEntries, subagentAddressOf, catalogChildEntry, isCatalogChildEntry } = makeCatalogSandbox();
  const entries = [ENTRY_016_CHILD, ENTRY_016_DIAGNOSTIC];
  const rtOld: any = { list: { getSnapshot: () => snapshot016(entries) } };

  assert.equal(JSON.stringify(subagentCatalogEntries(rtOld, "parent-1")), JSON.stringify(entries), "旧容器（subagentsByParent）目录必须继续可读");
  assert.equal(isCatalogChildEntry(ENTRY_016_CHILD, "child-cont"), true, "kind:'child' 必须命中");
  assert.equal(isCatalogChildEntry(ENTRY_016_DIAGNOSTIC, "child-diag"), false, "kind:'diagnostic' 必须被排除（形状探测不得只按 id）");
  assert.equal(catalogChildEntry(entries, "child-diag"), null, "diagnostic 行不得被当成子会话（其 id 存在，只能靠 kind 排除）");
  assert.equal(
    JSON.stringify(subagentAddressOf(rtOld, "parent-1", "child-cont")),
    JSON.stringify({ parentSessionId: "parent-1", childSessionId: "child-cont", mode: "continuable" }),
    "0.1.6 旧路径必须零退化",
  );
  assert.equal(subagentAddressOf(rtOld, "parent-1", "child-diag"), null, "旧形态下 diagnostic 不产出地址");
});

test("g-351 客户端：子→直接父 反查索引（plugin.js 谱系回溯调用点）按同一形状探测构造", () => {
  const { catalogParentIndex } = makeCatalogSandbox();

  // 0.1.7：无 kind 的 entry 也必须在索引里（否则「目录型子会话」找不到直接父）
  const newIndex = catalogParentIndex(new Map([
    ["parent-1", [ENTRY_017_CONTINUABLE, ENTRY_017_UNKNOWN]],
    ["parent-2", [ENTRY_017_ONESHOT]],
  ]));
  assert.equal(newIndex.get("child-cont"), "parent-1", "0.1.7 entry（无 kind）必须进反查索引");
  assert.equal(newIndex.get("child-unk"), "parent-1", "0.1.7 mode:'unknown' 的 entry 同样必须进索引");
  assert.equal(newIndex.get("child-one"), "parent-2", "另一父会话的子会话必须归到各自父");

  // 0.1.6：kind:'child' 进索引，diagnostic 不进
  const oldIndex = catalogParentIndex(new Map([["parent-1", [ENTRY_016_CHILD, ENTRY_016_DIAGNOSTIC]]]));
  assert.equal(oldIndex.get("child-cont"), "parent-1", "0.1.6 kind:'child' 必须进索引");
  assert.equal(oldIndex.has("child-diag"), false, "0.1.6 diagnostic 行不得进反查索引（只按 id 会误收）");

  // 形状不符：空索引，绝不抛出
  assert.equal(catalogParentIndex(undefined).size, 0);
  assert.equal(catalogParentIndex(new Map([["p", "not-an-array" as any]])).size, 0);
});

test("g-351 客户端：mode 归一化——'unknown'/缺失/非法值一律按「未判定」降级，地址下发宿主通配值", () => {
  const { catalogEntryMode, catalogAddressMode } = makeCatalogSandbox();

  assert.equal(catalogEntryMode(ENTRY_017_CONTINUABLE), "continuable");
  assert.equal(catalogEntryMode(ENTRY_017_ONESHOT), "one-shot");
  assert.equal(catalogEntryMode(ENTRY_016_CHILD), "continuable", "0.1.6 entry 同样按具体模式识别");
  for (const bad of [ENTRY_017_UNKNOWN, { id: "x" }, { id: "x", mode: null }, { id: "x", mode: "weird" }, null, undefined]) {
    assert.equal(catalogEntryMode(bad as any), null, `未判定 mode 必须归一为 null（展示层不得臆断成「一次性」）：${JSON.stringify(bad)}`);
  }
  // 地址侧不能省略 mode：0.1.7 history 路由对 mode 缺失会判 subagent/unauthorized
  assert.equal(catalogAddressMode(ENTRY_017_UNKNOWN), "unknown", "未判定 ⇒ 下发宿主自己的 'unknown' 通配值");
  assert.equal(catalogAddressMode(ENTRY_017_CONTINUABLE), "continuable", "具体模式原样下发");
  assert.equal(catalogAddressMode({ id: "x" } as any), "unknown", "mode 缺失同样下发通配值（不留空）");
});

test("g-351 客户端：形状都不符时目录为空且不抛出（调用方按未收录降级）", () => {
  const { subagentCatalogEntries, subagentAddressOf } = makeCatalogSandbox();
  assert.equal(subagentCatalogEntries({ list: { getSnapshot: () => ({}) } }, "parent-1").length, 0);
  assert.equal(subagentCatalogEntries({}, "parent-1").length, 0);
  assert.equal(subagentCatalogEntries({ list: { getSnapshot: () => { throw new Error("boom"); } } }, "parent-1").length, 0, "快照读取抛错不得冒泡");
  assert.equal(subagentAddressOf({ list: { getSnapshot: () => snapshot017([ENTRY_017_CONTINUABLE]) } }, "parent-1", "nope"), null);
  assert.equal(subagentAddressOf({ list: { getSnapshot: () => snapshot017([]) } }, "", "child-cont"), null);
});

test("g-351 客户端：三处调用点统一走同一形状判定函数，不得残留内联 kind 谓词（结构性钉住）", () => {
  const clientDir = join(process.cwd(), "dsh-graph-host", "lib", "client");
  const read = (f: string) => readFileSync(join(clientDir, f), "utf8");
  const bundle = readFileSync(join(dist, "lib", "client.js"), "utf8");

  // ① 语义断言：每个具名调用点都必须通过共享函数取 entry / 建索引（改回内联谓词即红）
  const CALL_SITES: Array<[string, string]> = [
    ["plugin.js", "catalogParentIndex(catalogsByParent)"],                                                     // 谱系回溯反查索引
    ["plugin.js", "catalogChildEntry(subagentCatalogEntries(rt, parentSessionId), childId)"],                   // 子会话导航（「↗ 转到对话」）
    ["session-hooks.js", "catalogChildEntry(subagentCatalogEntries(sessionsRt, parentId), childId)"],           // 绑定会话 mode/地址配置
    ["helpers.js", "catalogChildEntry(subagentCatalogEntries(rt, parentId), childId)"],                         // 地址构造 subagentAddressOf
  ];
  for (const [file, expr] of CALL_SITES) {
    const occurrences = read(file).split(expr).length - 1;
    assert.equal(occurrences, 1, `${file} 必须恰有一处调用 \`${expr}\`（当前 ${occurrences} 处）`);
  }

  // ② 否定断言：剥注释后，`kind === "child"` 只允许出现在 helpers 的形状探测函数体内
  const code = stripComments(bundle);
  const kindPredicateLines = code.split("\n").filter((l) => /\.kind\s*===\s*"child"/.test(l));
  assert.equal(kindPredicateLines.length, 1, `kind 判定只允许出现在形状探测函数内，实际 ${kindPredicateLines.length} 处：\n${kindPredicateLines.join("\n")}`);
  assert.match(code, /hasOwnProperty\.call\(entry, "kind"\)/, "形状探测必须以「entry 是否自带 kind」为判别依据");
});

test("g-351 客户端：目录刷新按能力分流（新 refreshProjections / 旧 setSubagentCatalogOpen+refreshSubagents）", async () => {
  const { refreshSubagentCatalog } = makeCatalogSandbox();

  const calls: string[] = [];
  const rtNew: any = {
    refreshProjections: async (p: string) => { calls.push(`refreshProjections:${p}`); },
    setSubagentCatalogOpen: () => calls.push("setSubagentCatalogOpen"),
    refreshSubagents: async () => calls.push("refreshSubagents"),
  };
  await refreshSubagentCatalog(rtNew, "parent-1");
  assert.deepEqual(calls, ["refreshProjections:parent-1"], "新能力存在时必须只走 refreshProjections，不得再调用已移除的旧 API");

  const legacyCalls: string[] = [];
  const rtOld: any = {
    setSubagentCatalogOpen: (p: string) => legacyCalls.push(`open:${p}`),
    refreshSubagents: async (p: string) => { legacyCalls.push(`refresh:${p}`); },
  };
  await refreshSubagentCatalog(rtOld, "parent-1");
  assert.deepEqual(legacyCalls, ["open:parent-1", "refresh:parent-1"], "旧宿主必须继续走旧刷新序列");

  // 两种能力都没有：静默返回（调用方按未收录降级），绝不抛出
  await refreshSubagentCatalog({}, "parent-1");
  await refreshSubagentCatalog(undefined, "parent-1");

  // 新 API 抛错时不得冒泡（看板不得崩）
  await refreshSubagentCatalog({ refreshProjections: async () => { throw new Error("boom"); } }, "parent-1");
});
