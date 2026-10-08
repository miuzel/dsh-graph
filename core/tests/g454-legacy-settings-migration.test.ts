/**
 * g-454：宿主代次升级时旧 `settings.yaml` 的 `dsh-graph` 节不会进入新条目 `dsh-graph-host`
 * ⇒ 既有用户全局设置丢失（迁移缺口）——**插件侧补偿**的回归测试。
 *
 * ── 只读核实的宿主事实（0.2.0-rc.2；路径 = 宿主结账目录下
 *    `node_modules/@deepseek-ai/dsh-settings/lib/index.js`）───────────────────────────────
 *   · `LEGACY_SECTION_ENTRIES`（:303-308）是**模块私有 const 字面量**，只有 3 条硬编码映射；
 *     全模块唯一用法是 :354 `LEGACY_SECTION_ENTRIES[section] ?? section`；
 *   · 该模块只导出 SettingsForms / SettingsConflictError / redactSecrets（:544）⇒ 该表不导出，
 *     也没有别名 / 注册 / 扩展点（插件与配置文件都**无法**影响它）；
 *   · `importLegacyDocument()`（:346-363）先把 `settings.yaml` rename 成 `settings.yaml.imported`
 *     （:351），再逐节 `this.update(ns, values)`，**被组合拒绝的节**（:355-360）只留一条 warn，
 *     值仅存在于 `.imported` 里。
 *   ⇒ 插件 0.1.6 线用历史 namespace `dsh-graph` 作节名，0.2.0 线条目 id 是 `dsh-graph-host`，
 *     两者对不上 ⇒ 旧值进不来。补偿只能做在**插件侧**（本文件钉住的就是它）。
 *
 * ── 补偿的硬性要求（逐条对应断言）─────────────────────────────────────────────────────
 *   ① 一次性幂等：重复执行零重复写入（两条腿：一次性标记在场 / 标记被删但显式值已落 profile patch）；
 *   ② 留痕可追溯：stderr 点名**来源文件 + 目标条目 + 字段**，且落盘标记自带同一条留痕；
 *   ③ 绝不静默覆盖已存在的显式值：descriptor.user（profile patch 显式值）里已有该键（**含空串**）
 *      即跳过；读取面同样以显式值为准；
 *   ④ 失败不阻断：写入抛错 / 无写入能力 / 旧文档坏 / 无 profileContext ⇒ 降级告警（或静默），
 *      看板与工具照常，且读取侧有同源只读兜底；
 *   ⑤ 不依赖版本号字符串：只按能力探测（`typeof svc.update`、`Object.hasOwn(row,"user")`、
 *      标记文件存在性），结构性断言禁止版本字面量分支；
 *   ⑥ 负向对照（判别力）：把「显式值优先」守卫与枚举校验**忠实改坏** ⇒ 断言必须转红。
 *
 * ── 测试隔离纪律（g-396 教训）────────────────────────────────────────────────────────
 *   触碰 `apply()` 的用例一律在 `tmp/` 下的自包含临时 workspace 内运行（否则 canonical 会归一到
 *   **主工作树的真实看板**并对它调 init）；同时用临时 `$DSH_HOME`（放旧 settings.yaml）与临时
 *   profile 目录（放一次性标记），用后递归清理，绝不触碰真实 `~/.dsh`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { apply, resolveCanonicalRoot } from "../../dist/index.js";
import { normalizeSubagentMode } from "../../dist/core/ops.js";

const dist = join(process.cwd(), "dist");
const hostSource = () => readFileSync(join(dist, "index.js"), "utf8");
const guideEn = () => readFileSync(join(dist, "supervisor-guide.en.md"), "utf8");
const guideZh = () => readFileSync(join(dist, "supervisor-guide.zh.md"), "utf8");

const PROJECT_TMP = join(process.cwd(), "tmp");
const ENTRY = "dsh-graph-host";
const LEGACY_SECTION = "dsh-graph";
const MARKER = ".dsh-graph-legacy-settings-migrated";
const FIELD_KEYS = ["subagentProvider", "subagentModel", "subagentMode", "subagentReasoningEffort", "subagentPrompt", "promptLanguage"];
const DEFAULTS = Object.freeze({
  subagentProvider: "",
  subagentModel: "",
  subagentMode: "",
  subagentReasoningEffort: "",
  subagentPrompt: "",
  promptLanguage: "follow",
});

// ---------------------------------------------------------------------------
// 测试隔离底座（自包含临时 workspace / home / profile，绝不触碰真实看板与真实 $DSH_HOME）
// ---------------------------------------------------------------------------

/** 真实看板根：以 process.cwd() 为 workspace 的 canonical 解析（linked worktree 内会归一到主工作树）。 */
function realBoardRoot(): string {
  return resolveCanonicalRoot({ root: ".dsh-graph" }, process.cwd()).root;
}

/** 隔离守卫：被断言的 workspace 必须自包含，绝不能 canonical 归一到真实看板。 */
function assertWorkspaceIsolated(ws: string): void {
  const resolved = resolveCanonicalRoot({ root: ".dsh-graph" }, ws).root;
  assert.notEqual(ws, process.cwd(), "测试 workspace 绝不能是 process.cwd()（那会命中真实看板）");
  assert.equal(resolved, join(ws, ".dsh-graph"), `测试 workspace 的看板必须自包含在自身内部（实际 ${resolved}）`);
  assert.notEqual(resolved, realBoardRoot(), `测试 workspace 绝不能归一到真实看板 ${resolved}`);
}

interface TempEnv { root: string; home: string; profileDir: string; ws: string }

/** 在 `tmp/` 下建自包含 env（home = 模拟 $DSH_HOME；profileDir = 模拟 profile 目录）；用后递归清理。 */
async function withTempEnv<T>(fn: (env: TempEnv) => T | Promise<T>): Promise<T> {
  mkdirSync(PROJECT_TMP, { recursive: true });
  const root = mkdtempSync(join(PROJECT_TMP, "g454-"));
  const home = join(root, "home");
  const profileDir = join(root, "profile");
  const ws = join(root, "ws");
  for (const dir of [home, profileDir, ws]) mkdirSync(dir, { recursive: true });
  try {
    return await fn({ root, home, profileDir, ws });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function isolatedTest(name: string, fn: (env: TempEnv) => void | Promise<void>): void {
  test(name, async () => { await withTempEnv(fn); });
}

/**
 * `ctx.inject(["settings"], cb)` 的同步桩：直接以给定 settings 服务回调
 * （真实宿主上该服务可能就绪更晚，但那不是本目标的关注点——g-351 已覆盖两条能力分支）。
 */
const injectWith = (settings: unknown) => (names: string[], cb: (sctx: any) => void) => {
  if (names.includes("settings")) cb({ settings, effect: (fn: () => unknown) => fn() });
};

/** 最小宿主 mock：只提供本用例关心的服务，其余按可选缺失处理（与 g-351 口径一致）。 */
function makeCtx(services: Record<string, unknown>, workspace: string) {
  const registeredSkills: any[] = [];
  const ctx: any = {
    get: (name: string) => {
      if (name === "skills") return { register: (d: any) => registeredSkills.push(d) };
      if (name === "sandboxPolicy") return { workspaceRoot: workspace };
      return services[name];
    },
    effect: (fn: () => unknown) => fn(),
    tools: { register: () => () => {}, get: () => ({}) },
  };
  assertWorkspaceIsolated(ctx.get("sandboxPolicy").workspaceRoot);
  return { ctx, registeredSkills };
}

/** 捕获（含 async 段）的 stderr；apply 的补偿写入是异步的，必须包住整个等待窗口。 */
async function captureStderr<T>(fn: () => T | Promise<T>): Promise<{ stderr: string; value: T }> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(String(s));
    return true;
  };
  try {
    const value = await fn();
    return { stderr: chunks.join(""), value };
  } finally {
    (process.stderr as unknown as { write: typeof orig }).write = orig;
  }
}

/** 让出事件循环：落盘迁移是 async 且不 await，需等它跑完再断言。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** 运行一次 apply（新形态宿主）并等到补偿迁移结束；返回捕获到的 stderr 与注册的 skills。 */
async function runApply(env: TempEnv, services: Record<string, unknown>): Promise<{ stderr: string; registeredSkills: any[] }> {
  const { ctx, registeredSkills } = makeCtx(services, env.ws);
  ctx.inject = injectWith(services.settings);
  const { stderr } = await captureStderr(async () => {
    apply(ctx, { root: ".dsh-graph" });
    await settle();
  });
  return { stderr, registeredSkills };
}

/**
 * 宿主 `settings` 服务 mock（形状对齐 0.2.0-rc.2 的 `SettingsForms.describe()`）：
 *   · `value` = 生效值（schema 默认 + 继承 + profile patch）；
 *   · `user`  = **profile patch 里显式写下的键值**（`configEditor.configuration().override`）——
 *               本目标的「显式值优先」判定面；
 *   · `update(ns, patch, expectedRevision)` 按真实语义把 patch 合并进显式值（宿主是写回
 *     profile patch 文档，之后 describe 即可见）⇒ 幂等断言验证的是**真实收敛行为**，不是 mock 假象。
 */
function makeSettingsHost(init?: {
  explicit?: Record<string, unknown>;
  inherited?: Record<string, unknown>;
  revision?: number;
  onUpdate?: (ns: string, patch: Record<string, unknown>, expected: unknown) => unknown;
}) {
  const calls: Array<{ ns: string; patch: Record<string, unknown>; expected: unknown }> = [];
  let explicit: Record<string, unknown> = { ...(init?.explicit ?? {}) };
  const inherited = { ...DEFAULTS, ...(init?.inherited ?? {}) };
  let revision = init?.revision ?? 0;
  const svc = {
    describe: () => [{
      ns: ENTRY,
      value: { ...inherited, ...explicit },
      base: { ...inherited },
      user: { ...explicit },
      revision,
      applies: "live",
    }],
    update: async (ns: string, patch: Record<string, unknown>, expected: unknown) => {
      calls.push({ ns, patch, expected });
      if (init?.onUpdate) await init.onUpdate(ns, patch, expected);
      explicit = { ...explicit, ...patch };
      revision += 1;
    },
  };
  return { svc, calls, explicit: () => ({ ...explicit }) };
}

/** 模拟旧宿主写下的 `$DSH_HOME/settings.yaml`：`dsh-graph` 节（0.1.6 线设置命名空间）。 */
const LEGACY_YAML = [
  "ui-onboarding:",
  "  welcomeNoticeVersion: 2026-08-13.1",
  `${LEGACY_SECTION}:`,
  "  subagentProvider: newapi-aseit",
  "  subagentModel: DeepSeek-V4.1-Flash",
  "  subagentMode: standard",
  "  subagentReasoningEffort: high",
  "  subagentPrompt: 只读 v0.20.0 看板",
  "  promptLanguage: en",
  "locale:",
  "  preference: zh",
  "",
].join("\n");

const writeLegacy = (home: string, name: string, body: string) => writeFileSync(join(home, name), body);
const profileContextOf = (env: TempEnv) => ({ home: env.home, dir: env.profileDir, name: "web" });
const skillContent = (skills: any[], name: string) => skills.find((s) => s.name === name)?.content;

// ---------------------------------------------------------------------------
// 判据 2/3：迁移生效、显式值优先、幂等、失败降级
// ---------------------------------------------------------------------------

isolatedTest("g-454 判据2：旧 `dsh-graph` 节的缺失字段一次性迁入 `dsh-graph-host`，并留痕（来源+字段）", async (env) => {
  writeLegacy(env.home, "settings.yaml.imported", LEGACY_YAML);
  const host = makeSettingsHost();
  const { stderr, registeredSkills } = await runApply(env, { settings: host.svc, profileContext: profileContextOf(env) });

  assert.equal(host.calls.length, 1, "必须发生恰好一次迁移写入");
  assert.equal(host.calls[0].ns, ENTRY, "必须写进新条目 id（而不是宿主不认识的旧节名）");
  assert.deepEqual(host.calls[0].patch, {
    subagentProvider: "newapi-aseit",
    subagentModel: "DeepSeek-V4.1-Flash",
    subagentMode: "standard",
    subagentReasoningEffort: "high",
    subagentPrompt: "只读 v0.20.0 看板",
    promptLanguage: "en",
  }, "迁移内容 = 旧节里全部合法字段");
  assert.equal(host.calls[0].expected, 0, "写入必须带 revision（并发编辑保护）");

  assert.match(stderr, /g-454 旧设置已迁移/, "必须留痕说明动作");
  assert.match(stderr, /settings\.yaml\.imported/, "留痕必须点名来源文件");
  assert.match(stderr, /subagentModel/, "留痕必须点名字段");

  const marker = join(env.profileDir, MARKER);
  assert.ok(existsSync(marker), "迁移成功后必须落一次性标记");
  const trace = readFileSync(marker, "utf8");
  assert.match(trace, /settings\.yaml\.imported/, "落盘标记本身即留痕（来源）");
  assert.match(trace, new RegExp(`${LEGACY_SECTION}.*→.*${ENTRY}`), "落盘标记必须记录 旧节 → 新条目");

  // 端到端可观测：旧节的 promptLanguage=en 必须被**真正读到**（skill 资产走英文，而不是回落默认）。
  assert.equal(skillContent(registeredSkills, "dsh-graph-supervisor"), guideEn(), "旧节 promptLanguage 必须生效");
});

isolatedTest("g-454 判据2：profile patch 已有显式值时绝不覆盖（含显式空串），且显式值在读取面胜出", async (env) => {
  writeLegacy(env.home, "settings.yaml", LEGACY_YAML);
  const host = makeSettingsHost({
    explicit: { subagentModel: "explicit-model", subagentPrompt: "", promptLanguage: "zh" },
  });
  const { registeredSkills } = await runApply(env, { settings: host.svc, profileContext: profileContextOf(env) });

  assert.equal(host.calls.length, 1, "仍然只写一次（只为缺失字段）");
  assert.deepEqual(host.calls[0].patch, { subagentProvider: "newapi-aseit", subagentMode: "standard", subagentReasoningEffort: "high" },
    "显式字段（含显式空串 subagentPrompt）必须被跳过，只补缺失字段");
  assert.equal(Object.hasOwn(host.calls[0].patch, "subagentModel"), false, "显式 subagentModel 绝不能被旧值覆盖");
  assert.equal(Object.hasOwn(host.calls[0].patch, "promptLanguage"), false, "显式 promptLanguage 绝不能被旧值覆盖");
  assert.equal(host.explicit().subagentModel, "explicit-model", "显式值必须原样保留");

  // 读取面同样以显式值为准：旧节是 en，显式是 zh ⇒ 必须走中文资产。
  assert.equal(skillContent(registeredSkills, "dsh-graph-supervisor"), guideZh(), "显式 promptLanguage=zh 必须在读取面胜出");
});

isolatedTest("g-454 判据2：重复执行零重复写入（①标记在场 ②标记被删但显式值已落 profile patch）", async (env) => {
  writeLegacy(env.home, "settings.yaml.imported", LEGACY_YAML);
  const host = makeSettingsHost();
  const services = { settings: host.svc, profileContext: profileContextOf(env) };

  await runApply(env, services);
  assert.equal(host.calls.length, 1, "首次必须迁移一次");
  const markerPath = join(env.profileDir, MARKER);
  const markerBody = readFileSync(markerPath, "utf8");

  // 腿①：标记在场（真实的第二次启动形态）⇒ 连旧文档都不再读，零写入。
  const second = await runApply(env, services);
  assert.equal(host.calls.length, 1, "重复执行绝不能再写一次（标记在场）");
  assert.doesNotMatch(second.stderr, /旧设置已迁移/, "幂等重放不得再声称迁移过");
  assert.equal(readFileSync(markerPath, "utf8"), markerBody, "标记不得被重写（无二次写盘）");

  // 腿②：即使标记被删（例如用户清理），显式值已在 profile patch ⇒ 缺失字段为空 ⇒ 仍然零写入。
  rmSync(markerPath, { force: true });
  const third = await runApply(env, services);
  assert.equal(host.calls.length, 1, "值守卫本身也必须幂等（不依赖标记）");
  assert.doesNotMatch(third.stderr, /旧设置已迁移/, "无缺失字段时不得声称迁移");
});

isolatedTest("g-454 判据2：写入抛错时降级不阻断（只读兜底仍生效，且不落标记以便下次重试）", async (env) => {
  writeLegacy(env.home, "settings.yaml.imported", LEGACY_YAML);
  const host = makeSettingsHost({ onUpdate: () => { throw new Error("SettingsConflictError: revision mismatch"); } });
  const { stderr, registeredSkills } = await runApply(env, { settings: host.svc, profileContext: profileContextOf(env) });

  assert.equal(host.calls.length, 1, "确实尝试过写入");
  assert.match(stderr, /g-454 旧设置未落盘/, "失败必须降级告警（如实说明）");
  assert.match(stderr, /不影响看板与工具/, "告警必须说明不阻断");
  assert.equal(existsSync(join(env.profileDir, MARKER)), false, "未成功落盘 ⇒ 不得写标记（下次启动可重试）");
  // 读取侧兜底：即使写不进去，旧值（promptLanguage=en）在本次运行中仍然生效。
  assert.equal(skillContent(registeredSkills, "dsh-graph-supervisor"), guideEn(), "落盘失败不得导致旧值在读取面失效");
});

isolatedTest("g-454 判据3：settings 服务无 update 能力时只用只读兜底（能力探测，不按版本号）", async (env) => {
  writeLegacy(env.home, "settings.yaml.imported", LEGACY_YAML);
  const describeOnly = { describe: () => [{ ns: ENTRY, value: { ...DEFAULTS }, base: { ...DEFAULTS }, user: {}, revision: 0 }] };
  const { stderr, registeredSkills } = await runApply(env, { settings: describeOnly, profileContext: profileContextOf(env) });

  assert.equal(existsSync(join(env.profileDir, MARKER)), false, "无写入能力 ⇒ 不得写标记");
  assert.equal(skillContent(registeredSkills, "dsh-graph-supervisor"), guideEn(), "只读兜底必须让旧值仍然生效");
  assert.doesNotMatch(stderr, /settings 注册失败/, "能力可用（describe 在）时不得报注册失败");
});

isolatedTest("g-454 判据2：无旧文档 / 无 profileContext / 旧宿主 register 形态 ⇒ 零副作用且行为不变", async (env) => {
  // ① 无旧文档：不写、不标记、不报错，且既有读取行为不变（这里 value 自带 en）。
  const host = makeSettingsHost({ inherited: { promptLanguage: "en" } });
  const a = await runApply(env, { settings: host.svc, profileContext: profileContextOf(env) });
  assert.equal(host.calls.length, 0, "无旧文档时绝不写");
  assert.equal(existsSync(join(env.profileDir, MARKER)), false, "无旧文档时不落标记");
  assert.equal(skillContent(a.registeredSkills, "dsh-graph-supervisor"), guideEn(), "既有读取行为不得回归");

  // ② 无 profileContext（宿主未提供）：仍不写、不抛错。
  writeLegacy(env.home, "settings.yaml.imported", LEGACY_YAML);
  const host2 = makeSettingsHost();
  const b = await runApply(env, { settings: host2.svc });
  assert.equal(host2.calls.length, 0, "拿不到旧文档位置时绝不写");
  assert.doesNotMatch(b.stderr, /旧设置已迁移/, "拿不到旧文档位置时不得声称迁移");
});

/**
 * 旧路径的 schema 需 schemastery；仓储测试环境不装 @deepseek-ai/*，
 * 故在 tmp 内放一个最小桩并把 process.argv[1] 指过去（与 g-351 同一口径）。
 */
function withSchemasteryStub<T>(fn: () => T): T {
  mkdirSync(PROJECT_TMP, { recursive: true });
  const root = mkdtempSync(join(PROJECT_TMP, "g454-stub-"));
  const pkgDir = join(root, "node_modules", "@deepseek-ai", "schemastery");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/schemastery", version: "0.0.0-test", main: "index.cjs" }));
  writeFileSync(join(pkgDir, "index.cjs"), [
    "const field = () => ({ default: () => field(), volatile: () => field() });",
    "module.exports = { object: () => ({}), string: () => field(), union: () => field() };",
  ].join("\n"));
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

isolatedTest("g-454 判据4：旧宿主形态（有 register、无 describe）仍走 namespace 路径，绝不触发本条补偿", async (env) => {
  writeLegacy(env.home, "settings.yaml.imported", LEGACY_YAML);
  const registerCalls: any[] = [];
  const legacyShape = {
    register: (ns: string, schema: unknown, options: unknown) => { registerCalls.push({ ns, schema, options }); return { get: () => ({ promptLanguage: "en" }) }; },
    update: async () => { throw new Error("旧形态不该被调用 update"); },
  };
  const c = await withSchemasteryStub(async () =>
    runApply(env, { settings: legacyShape, profileContext: profileContextOf(env) }));
  assert.equal(registerCalls.length, 1, "旧宿主必须仍走 namespace 注册（行为不退化）");
  assert.equal(registerCalls[0].ns, LEGACY_SECTION, "旧宿主注册的 namespace 仍是 dsh-graph");
  assert.equal(skillContent(c.registeredSkills, "dsh-graph-supervisor"), guideEn(), "旧宿主读取路径行为不变");
  assert.equal(existsSync(join(env.profileDir, MARKER)), false, "旧宿主分支不得触发迁移/落标记");
});

isolatedTest("g-454 判据2：旧节里的未知键/非字符串/非法枚举/空串一律丢弃（绝不猜测）", async (env) => {
  writeLegacy(env.home, "settings.yaml.imported", [
    `${LEGACY_SECTION}:`,
    "  unknownKey: whatever",
    "  subagentProvider: \"\"",
    "  subagentModel: 42",
    "  subagentMode: turbo",
    "  subagentReasoningEffort: [low]",
    "  promptLanguage: ja",
    "  subagentPrompt: keep-me",
    "",
  ].join("\n"));
  const host = makeSettingsHost();
  await runApply(env, { settings: host.svc, profileContext: profileContextOf(env) });
  assert.equal(host.calls.length, 1, "只补唯一合法字段");
  assert.deepEqual(host.calls[0].patch, { subagentPrompt: "keep-me" },
    "只接受已知字段的合法非空字符串值（未知键/数字/数组/非法枚举/空串全部丢弃）");
});

isolatedTest("g-454 判据2：坏 YAML 只是「没有旧值」——不写入、不报错、不阻断加载", async (env) => {
  writeLegacy(env.home, "settings.yaml", `${LEGACY_SECTION}:\n  - [unclosed\n`);
  const host = makeSettingsHost();
  const { stderr, registeredSkills } = await runApply(env, { settings: host.svc, profileContext: profileContextOf(env) });
  assert.equal(host.calls.length, 0, "坏 YAML 不得产生任何写入");
  assert.doesNotMatch(stderr, /旧设置已迁移/, "坏 YAML 不得声称迁移");
  assert.equal(existsSync(join(env.profileDir, MARKER)), false, "坏 YAML 不得落标记");
  assert.ok(skillContent(registeredSkills, "dsh-graph-supervisor"), "插件必须照常加载并注册 skill（不阻断）");
});

// ---------------------------------------------------------------------------
// 判据 3/4：通道结构守卫（能力探测、零版本号分支、无新第三方依赖、fail-safe）
// ---------------------------------------------------------------------------

/** 剥离 JS 源码注释（状态机；字符串字面量原样保留），用于「只对代码设限」的结构断言。 */
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

test("g-454 判据3/4：补偿块按能力探测、零版本号分支、fail-safe，且未引入新第三方依赖", () => {
  const src = hostSource();
  const moduleStart = src.indexOf("const GRAPH_LEGACY_SETTINGS_SECTION");
  const moduleEnd = src.indexOf("// schema 需 schemastery");
  assert.ok(moduleStart > 0 && moduleEnd > moduleStart, "定位 g-454 模块级补偿块");
  const moduleBlock = stripComments(src.slice(moduleStart, moduleEnd));

  const applyStart = src.indexOf("let graphSettingsScope = null;");
  const applyEnd = src.indexOf("setupGraphSettings();");
  assert.ok(applyStart > 0 && applyEnd > applyStart, "定位 g-454 in-apply 补偿块");
  const applyBlock = stripComments(src.slice(applyStart, applyEnd));

  // 能力探测（不依赖版本号字符串；与 g-351 同口径）。
  assert.match(applyBlock, /typeof svc\?\.update !== "function"/, "写入必须按 update 能力探测");
  assert.match(applyBlock, /Object\.hasOwn\(row, "user"\)/, "必须探测 profile patch 视图（显式值判定面）");
  assert.match(applyBlock, /existsSync\(join\(dir, GRAPH_LEGACY_SETTINGS_MARKER\)\)/, "一次性判定必须按标记文件能力探测");
  assert.doesNotMatch(moduleBlock, /0\.\d+\.\d+|semver|compareVersion|versionCompare|PLUGIN_VERSION/, "模块级补偿块不得按版本号分支");
  assert.doesNotMatch(applyBlock, /0\.1\.\d|semver|compareVersion|versionCompare|PLUGIN_VERSION/, "in-apply 补偿块不得按版本号分支");

  // 两处候选旧文档（宿主 rename 之前 / 之后）。
  assert.match(moduleBlock, /"settings\.yaml", "settings\.yaml\.imported"/, "必须同时探测 settings.yaml 与 .imported");

  // 显式值优先 + 写入带 revision（并发保护）+ 失败降级。
  assert.match(moduleBlock, /if \(explicit && Object\.hasOwn\(explicit, key\)\) continue;/, "缺失才补：显式键必须跳过");
  assert.match(applyBlock, /await svc\.update\(row\.ns, patch, row\.revision\)/, "写入必须带 revision");
  assert.match(applyBlock, /void persistLegacyGraphSettings\(svc\)\.catch\(/, "迁移必须 fire-and-forget 且兜住异常（不阻断）");

  // 依赖面：入口只允许已声明的 `yaml`（不引入新的第三方库）。
  const bare = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]).filter((spec) => !spec.startsWith("node:") && !spec.startsWith("."));
  const declared = JSON.parse(readFileSync(join(process.cwd(), "dsh-graph-host", "package.json"), "utf8")).dependencies ?? {};
  assert.deepEqual([...new Set(bare)].sort(), Object.keys(declared).sort(), "插件入口的裸 import 必须与已声明 dependencies 完全一致");
  assert.deepEqual(Object.keys(declared), ["yaml"], "不得新增第三方依赖");

  // 回归：既有 g-351 能力分流断言只增不减。
  assert.match(applyBlock, /typeof svc\?\.register === "function"/, "旧能力探测必须保留");
  assert.match(applyBlock, /typeof svc\?\.describe === "function"/, "新能力探测必须保留");
});

// ---------------------------------------------------------------------------
// 判据 2 的**负向对照**（判别力）：把守卫忠实改坏 ⇒ 断言必须转红
// ---------------------------------------------------------------------------

/** 从源产物里抠出一个模块级 `function name(...)` 的完整源码（含 async 限定符）。 */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源模块中存在 function ${name}`);
  const asyncPrefix = source.slice(Math.max(0, start - 6), start) === "async " ? "async " : "";
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return asyncPrefix + source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} 花括号无法配平`);
}

/** 恰好命中一次的字面替换；命中 0 次或多次即抛错（防止锚点漂移后负向对照静默失效）。 */
function replaceOnce(src: string, needle: string, replacement: string): string {
  const parts = src.split(needle);
  assert.equal(parts.length, 2, `负向对照锚点必须恰好命中一次（实际 ${parts.length - 1} 次）：${needle}`);
  return parts[0] + replacement + parts[1];
}

/** 用真实产物里的两个纯函数建沙箱；`mutate` 可对抽取源码做忠实变异。 */
function makeLegacyHelpersSandbox(mutate?: (parts: { coerce: string; patch: string }) => { coerce: string; patch: string }) {
  const src = hostSource();
  let coerce = extractFunction(src, "coerceLegacyGraphSettings");
  let patch = extractFunction(src, "graphSettingsMissingPatch");
  if (mutate) ({ coerce, patch } = mutate({ coerce, patch }));
  const code = [
    `const GRAPH_SETTINGS_FIELD_KEYS = ${JSON.stringify(FIELD_KEYS)};`,
    coerce,
    patch,
    "this.api = { coerceLegacyGraphSettings, graphSettingsMissingPatch };",
  ].join("\n");
  const sandbox: any = { normalizeSubagentMode };
  vm.runInNewContext(code, sandbox, { filename: "dist/index.js#g454-legacy-helpers" });
  return sandbox.api as {
    coerceLegacyGraphSettings: (section: unknown) => Record<string, string> | null;
    graphSettingsMissingPatch: (user: unknown, values: unknown) => Record<string, string> | null;
  };
}

test("g-454 判据2 负向对照：把「显式值优先」守卫改坏 ⇒ 会覆盖显式值（本套件断言有判别力）", () => {
  const real = makeLegacyHelpersSandbox();
  const explicit = { subagentModel: "explicit-model" };
  const legacy = { subagentModel: "legacy-model", subagentProvider: "legacy-provider" };
  // vm 里造出的对象在**另一个 realm**（原型不同），strict deepEqual 会因为原型身份而假红 ⇒ 展开到本 realm。
  assert.deepEqual({ ...real.graphSettingsMissingPatch(explicit, legacy) }, { subagentProvider: "legacy-provider" },
    "真实实现：显式键必须被跳过");

  // 忠实改坏：把「已有该键即跳过」降级为永不跳过（= 补偿不做显式值判定）。
  const broken = makeLegacyHelpersSandbox(({ coerce: c, patch: p }) => ({
    coerce: c,
    patch: replaceOnce(p, "if (explicit && Object.hasOwn(explicit, key)) continue;", "if (explicit && false) continue;"),
  }));
  assert.deepEqual({ ...broken.graphSettingsMissingPatch(explicit, legacy) }, legacy,
    "负向对照：去掉守卫后旧值会覆盖显式值 ⇒ 上面的「绝不覆盖」断言确有判别力");
});

test("g-454 判据2 负向对照：把枚举/类型校验改坏 ⇒ 非法旧值会漏进条目（本套件断言有判别力）", () => {
  const dirty = { subagentMode: "turbo", subagentModel: 42, promptLanguage: "ja", unknownKey: "x", subagentPrompt: "keep-me" };
  const real = makeLegacyHelpersSandbox();
  assert.deepEqual({ ...real.coerceLegacyGraphSettings(dirty) }, { subagentPrompt: "keep-me" }, "真实实现：非法值必须全部丢弃");

  // 忠实改坏：去掉枚举校验（mode 直接透传）+ 放宽类型（非字符串也收）。
  const broken = makeLegacyHelpersSandbox(({ coerce: c, patch: p }) => ({
    coerce: replaceOnce(replaceOnce(c, "if (typeof value !== \"string\" || value === \"\") continue;", "if (value === \"\" || value === undefined || value === null) continue;"), "      const mode = normalizeSubagentMode(value);\n      if (!mode) continue;\n      out[key] = mode;\n      continue;", "      out[key] = value;\n      continue;"),
    patch: p,
  }));
  const leaked: any = broken.coerceLegacyGraphSettings(dirty);
  assert.equal(leaked?.subagentMode, "turbo", "负向对照：去掉枚举校验后非法 mode 会漏进条目");
  assert.equal(leaked?.subagentModel, 42, "负向对照：去掉类型校验后非字符串会漏进条目");
});
