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
  // 旧路径的 schema 需 schemastery；仓储测试环境不装 @deepseek-ai/*，
  // 故在 tmp 内放一个最小桩，并把 process.argv[1] 指过去，让 resolveSchemastery 能命中。
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
  } finally {
    process.argv[1] = prevArgv1;
    rmSync(root, { recursive: true, force: true });
  }
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
  const code = src
    .slice(start, end)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
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
// 客户端：子代理目录的**形状 / 能力探测**（0.1.7 移除了 subagentsByParent 与
// setSubagentCatalogOpen/refreshSubagents；替代物是 projectionsBySession 与 refreshProjections）
// ---------------------------------------------------------------------------

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

function makeCatalogSandbox() {
  const bundle = readFileSync(join(dist, "lib/client.js"), "utf8");
  const code = [
    extractFunction(bundle, "subagentCatalogEntries"),
    extractFunction(bundle, "subagentAddressOf"),
    extractFunction(bundle, "refreshSubagentCatalog"),
    "this.api = { subagentCatalogEntries, subagentAddressOf, refreshSubagentCatalog };",
  ].join("\n");
  const sandbox: any = { Promise, console: { warn: () => {} } };
  vm.runInNewContext(code, sandbox, { filename: "dist/lib/client.js#subagentCatalog" });
  return sandbox.api;
}

test("g-351 客户端：新形态（projectionsBySession）子代理目录可读，旧形态（subagentsByParent）不退化", async () => {
  const { subagentCatalogEntries, subagentAddressOf } = makeCatalogSandbox();
  const entry = { kind: "child", id: "child-1", mode: "continuable" };

  // 0.1.7 形态：没有 subagentsByParent，目录在共享投影里
  const rtNew: any = {
    list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: { "parent-1": { values: { subagentCatalog: [entry] } } } }) },
  };
  // 跨 vm realm 的对象原型不同，用 JSON 比较取值而非 deepEqual
  assert.equal(JSON.stringify(subagentCatalogEntries(rtNew, "parent-1")), JSON.stringify([entry]), "新形态目录必须可读（否则子会话导航静默退化为打开父会话）");
  assert.equal(
    JSON.stringify(subagentAddressOf(rtNew, "parent-1", "child-1")),
    JSON.stringify({ parentSessionId: "parent-1", childSessionId: "child-1", mode: "continuable" }),
    "新形态下必须能构造出 SubagentAddress",
  );

  // 0.1.6 形态：subagentsByParent 仍是权威来源
  const rtOld: any = {
    list: { getSnapshot: () => ({ ids: [], byId: {}, subagentsByParent: { "parent-1": { entries: [entry] } } }) },
  };
  assert.equal(JSON.stringify(subagentCatalogEntries(rtOld, "parent-1")), JSON.stringify([entry]), "旧形态目录必须继续可读（不退化）");

  // 形状都不符：空目录（调用方按未收录降级），不得抛错
  assert.equal(subagentCatalogEntries({ list: { getSnapshot: () => ({}) } }, "parent-1").length, 0);
  assert.equal(subagentCatalogEntries({}, "parent-1").length, 0);
  assert.equal(subagentAddressOf(rtNew, "parent-1", "nope"), null);
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
