/**
 * g-133：profile 级全局默认（dsh-graph 设置）源契约回归（node:test，零依赖）。
 *
 * 覆盖三类不变式：
 *  1. 模型路由优先级合成 `resolveModelRoute`：单次派发 override > workspace project.yaml 明确值
 *     > profile 全局默认 > 继承；空值不覆盖低层。
 *  2. 补充提示词三态合成 `resolvePromptOverride`：default/缺失 → 继承全局；非空文本 → 覆盖；
 *     显式空值 → 禁用（null）。
 *  3. project.yaml 覆盖字段解析 `readPromptOverrideValue`：`default`/缺失 → default；
 *     非空文本（含引号/空格）→ 文本；显式空值（'' / ""）→ 空串。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  resolveModelRoute,
  resolvePromptOverride,
  readPromptOverrideValue,
} from "../ops.ts";

/** vm 沙箱对象与测试 realm prototype 不同：断言前 JSON 往返。 */
const plainJson = (x: any): any => JSON.parse(JSON.stringify(x));

/**
 * g-453：加载 `settings.js` 里「profile 设置 scope 绑定 + 命名空间发现」段落的**真实源码**，
 * 在 vm 里执行后暴露内部符号，供**行为断言**使用（不再用源码字符串匹配替代「到底绑到了哪个
 * namespace」这类行为断言 —— Lane A 复核 NC2：写死历史名 `dsh-graph` 会让整页不可用，而当时
 * 只有字符串断言 ⇒ 门禁全绿、静默失效）。
 *
 * 段落 = `const GRAPH_SETTINGS_NS` 起、到 `loadHostCatalog` 之前的注释止；外部依赖只有
 * `helpers.js` 的两个受保护读取 helper 与 i18n 的 `dgT`（都在沙箱里注入）。
 * `mutateSource` 供**判别力对照**在文本上做变异（如把候选写死成 `[GRAPH_SETTINGS_NS]`）。
 */
function loadGraphSettingsScopeSegment(mutateSource?: (src: string) => string): any {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const settingsRaw = read("../../dsh-graph-host/lib/client/settings.js");
  const settings = mutateSource ? mutateSource(settingsRaw) : settingsRaw;
  const helpers = read("../../dsh-graph-host/lib/client/helpers.js");
  const start = settings.indexOf("const GRAPH_SETTINGS_NS =");
  const end = settings.indexOf("// g-133 / g-215：从当前 Host 读取合法 provider/model 目录");
  assert.ok(start > 0 && end > start, "settings.js 含 profile 设置 scope 绑定段落（段落边界漂移即 fail-closed）");
  const helperStart = helpers.indexOf("function optionalService(ctx, name)");
  const helperEnd = helpers.indexOf("function dgOverlay(", helperStart);
  assert.ok(helperStart > 0 && helperEnd > helperStart, "helpers.js 含 optionalService / optionalServicePath 段落");
  const ctx: any = {};
  vm.runInNewContext(
    `${helpers.slice(helperStart, helperEnd)}\n` +
      `function dgT(key) { return "T:" + key; }\n` +
      `(function () {\n${settings.slice(start, end)}\n` +
      "globalThis.__s = { GRAPH_SETTINGS_NS, GRAPH_SETTINGS_ENTRY_ID, GRAPH_SETTINGS_NS_CANDIDATES,\n" +
      "  GRAPH_SETTINGS_SERVICE_KEYS, subscribeGraphSettingsScope, publishGraphSettingsScope,\n" +
      "  getScope: () => gSettingsScope, bindGraphSettingsScope, armGraphSettingsScope,\n" +
      "  createGraphSettingsApiScope };\n})()",
    ctx,
  );
  return ctx.__s;
}

/** describe()/mutate() 形状的假 `remote.settings`（0.2.0-rc.2 上 ClientSettingsService 的投影形态）。 */
function fakeRemoteSettings(namespaces: any[], writable = true): any {
  const calls: Array<{ ns: string; ops: any[]; expectedRevision: unknown }> = [];
  return {
    calls,
    async describe() { return { ok: true, value: { namespaces, writable } }; },
    async mutate(ns: string, ops: any[], expectedRevision: unknown) {
      calls.push({ ns, ops, expectedRevision });
      const row = namespaces.find((r) => r.ns === ns) ?? { ns, value: {}, revision: 0 };
      return { ok: true, value: { ns, value: { ...(row.value ?? {}), [ops[0].path[0]]: ops[0].value }, revision: (row.revision ?? 0) + 1 } };
    },
  };
}

test("g-453 命名空间发现（静态）：候选集合钉住 + 必须按 describe 的实际 ns 集合发现、不得写死单一名字", () => {
  const client = readFileSync(new URL("../../dsh-graph-host/lib/client/settings.js", import.meta.url), "utf8");
  // 宿主 0.2.0-rc.2 服务的是 **profile 条目 id**；历史 namespace 名保留为候选（旧线 0.1.6）
  assert.match(client, /const GRAPH_SETTINGS_NS = "dsh-graph"/);
  assert.match(client, /const GRAPH_SETTINGS_ENTRY_ID = "dsh-graph-host"/);
  assert.match(client, /const GRAPH_SETTINGS_NS_CANDIDATES = \[GRAPH_SETTINGS_ENTRY_ID, GRAPH_SETTINGS_NS\]/,
    "候选集合必须同时含条目 id 与历史 namespace 名（写死其一会让整页不可用且静默）");
  // 发现口径：只认 describe() 返回的 namespaces，按候选集合筛行（不得绕过集合直接写死名字）
  assert.match(client, /const rows = Array\.isArray\(view\?\.namespaces\) \? view\.namespaces : \[\]/);
  assert.match(client, /rows\.find\(\(candidate\) => GRAPH_SETTINGS_NS_CANDIDATES\.includes\(candidate\?\.ns\)\)/);
  assert.match(client, /resolvedNs = row\.ns/);
  // 至少不能出现「候选 = 单一历史名」或「直接拿单一常量当 ns 去比对」的写法
  const code = client.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  assert.doesNotMatch(code, /GRAPH_SETTINGS_NS_CANDIDATES = \[GRAPH_SETTINGS_NS\]/, "候选不得写死成单一历史名");
  assert.doesNotMatch(code, /candidate\?\.ns === GRAPH_SETTINGS_NS\b/, "不得绕过候选集合直接比对单一名字");
});

test("g-453 命名空间发现（行为）：describe 服务条目 id ⇒ 绑到它并写回同一 ns；仅历史名 ⇒ 旧线候选；都没有 ⇒ 如实降级", async () => {
  const seg = loadGraphSettingsScopeSegment();

  // ① 本宿主形态：describe 只服务 profile 条目 id `dsh-graph-host`
  const hostRemote = fakeRemoteSettings([
    { ns: "locale", value: { preference: "zh" } },
    { ns: "dsh-graph-host", value: { subagentMode: "minimal" }, revision: 7 },
  ]);
  const hostScope = seg.createGraphSettingsApiScope(undefined, { get: () => undefined }, hostRemote);
  await hostScope.load();
  const hostSnap = plainJson(hostScope.getSnapshot());
  assert.equal(hostSnap.status, "ready", "条目 id 命名空间必须被识别（写死历史名时这里会变 unavailable = Lane A NC2）");
  assert.equal(hostSnap.value.subagentMode, "minimal");
  assert.equal(hostSnap.revision, 7);
  await hostScope.set("subagentMode", "standard");
  assert.equal(hostRemote.calls.length, 1);
  assert.equal(hostRemote.calls[0].ns, "dsh-graph-host", "写回必须用**发现到的** ns，而不是写死的历史名");
  assert.deepEqual(plainJson(hostRemote.calls[0].ops), [{ op: "set", path: ["subagentMode"], value: "standard" }]);

  // ② 旧线形态：describe 只有历史 namespace 名 ⇒ 候选集合里的历史名照样绑定
  const legacyRemote = fakeRemoteSettings([{ ns: "dsh-graph", value: { promptLanguage: "en" }, revision: 1 }]);
  const legacyScope = seg.createGraphSettingsApiScope(undefined, { get: () => undefined }, legacyRemote);
  await legacyScope.load();
  assert.equal(plainJson(legacyScope.getSnapshot()).status, "ready", "旧线命名空间仍是合法候选");
  await legacyScope.set("promptLanguage", "zh");
  assert.equal(legacyRemote.calls[0].ns, "dsh-graph");

  // ③ 两者都没有 ⇒ 如实降级（不假装可用、不抛错）
  const noneScope = seg.createGraphSettingsApiScope(undefined, { get: () => undefined }, fakeRemoteSettings([{ ns: "ui-theme", value: {} }]));
  await noneScope.load();
  assert.equal(plainJson(noneScope.getSnapshot()).status, "unavailable", "无候选命名空间时必须如实降级");

  // ④ 判别力自检（同一份真实源码的文本变异）：候选写死成单一历史名 ⇒ ① 必须变成 unavailable
  const broken = loadGraphSettingsScopeSegment((src) =>
    src.replace("const GRAPH_SETTINGS_NS_CANDIDATES = [GRAPH_SETTINGS_ENTRY_ID, GRAPH_SETTINGS_NS]",
      "const GRAPH_SETTINGS_NS_CANDIDATES = [GRAPH_SETTINGS_NS]"));
  assert.notDeepEqual(plainJson(broken.GRAPH_SETTINGS_NS_CANDIDATES), plainJson(seg.GRAPH_SETTINGS_NS_CANDIDATES),
    "变异必须真的落在候选集合上（fail-closed）");
  const brokenScope = broken.createGraphSettingsApiScope(undefined, { get: () => undefined },
    fakeRemoteSettings([{ ns: "dsh-graph-host", value: { subagentMode: "minimal" }, revision: 7 }]));
  await brokenScope.load();
  assert.equal(plainJson(brokenScope.getSnapshot()).status, "unavailable",
    "候选写死历史名后必须复现「整页不可用」（否则本夹具没有判别力）");
});

test("g-453 迟到绑定（行为）：服务缺席保持降级态 → inject 迟到触发 → 订阅者被唤醒并绑到可用 scope", async () => {
  const seg = loadGraphSettingsScopeSegment();
  let notify = 0;
  const off = seg.subscribeGraphSettingsScope(() => { notify += 1; });

  const injectCalls: Array<{ key: string; cb: any }> = [];
  const bareCtx = { get: () => undefined, inject: (deps: string[], cb: any) => { injectCalls.push({ key: deps[0], cb }); } };
  seg.armGraphSettingsScope(bareCtx);
  assert.equal(seg.getScope(), null, "服务缺席 ⇒ 不得伪造绑定（页面保持降级文案）");
  assert.equal(notify, 0, "无可用绑定 ⇒ 不得唤醒订阅者");
  assert.deepEqual(injectCalls.map((c) => c.key).sort(), ["remote.settings", "settingsScope"],
    "两个服务键（旧线注入键 / 新线点分名）必须各自独立探测、互不阻塞");

  // 迟到 provide：宿主稍后才声明该服务 ⇒ 回调被调用，绑定发布并唤醒订阅者（组件据此重渲染）
  const remote = fakeRemoteSettings([{ ns: "dsh-graph-host", value: { subagentMode: "minimal" }, revision: 3 }]);
  const lateCtx = { get: (name: string) => (name === "remote.settings" ? remote : undefined) };
  injectCalls.find((c) => c.key === "remote.settings")!.cb(lateCtx);
  assert.equal(notify, 1, "迟到绑定必须唤醒订阅者（渲染面从降级态切到配置表单）");
  assert.ok(seg.getScope(), "绑定后 scope 可用");
  await seg.getScope().load();
  assert.equal(plainJson(seg.getScope().getSnapshot()).status, "ready");
  off();

  // 退订后不再被唤醒（effect 卸载语义）
  seg.publishGraphSettingsScope({ getSnapshot: () => ({ status: "ready" }) }, {}, 0);
  assert.equal(notify, 1, "退订后不得再唤醒");
});

test("g-453 绑定发布语义（行为）：null 不覆盖既有绑定、低优先级不替换高优先级、同源（同服务实例）幂等", () => {
  const seg = loadGraphSettingsScopeSegment();
  let notify = 0;
  seg.subscribeGraphSettingsScope(() => { notify += 1; });
  assert.equal(seg.getScope(), null);
  const legacy = { getSnapshot: () => ({ status: "ready", value: {}, mode: "profile" }) };
  // `source` = **服务实例**（bindGraphSettingsScope 传的就是 `ctx.get(...)` 的返回值）⇒ 幂等按同一实例判定
  const legacySource = { id: "legacy" };
  seg.publishGraphSettingsScope(legacy, legacySource, 1);
  assert.equal(seg.getScope(), legacy);
  assert.equal(notify, 1);
  // 同一服务实例 + 同优先级重复发布（apply 立即绑定 + inject 迟到回调各一次的真实形态）⇒ 幂等
  seg.publishGraphSettingsScope({ getSnapshot: () => ({ status: "ready" }) }, legacySource, 1);
  assert.equal(seg.getScope(), legacy, "同一服务实例的重复发布必须幂等（保留既有绑定，不抖动页面）");
  assert.equal(notify, 1, "同一服务实例的重复发布不得重复唤醒");
  // 低优先级（新线 remote.settings）不得替换高优先级（旧线 settingsScope）绑定
  const remote = { getSnapshot: () => ({ status: "ready", value: {}, mode: "profile" }) };
  seg.publishGraphSettingsScope(remote, { id: "remote" }, 0);
  assert.equal(seg.getScope(), legacy, "低优先级绑定不得替换既有高优先级绑定");
  assert.equal(notify, 1);
  // 解析失败（null）不得覆盖既有可用绑定
  seg.publishGraphSettingsScope(null, null, 5);
  assert.equal(seg.getScope(), legacy, "解析失败不得清空既有可用绑定");
  assert.equal(notify, 1);
  // 同优先级但换了服务实例 ⇒ 重绑并唤醒
  const legacy2 = { getSnapshot: () => ({ status: "ready", value: {}, mode: "profile" }) };
  seg.publishGraphSettingsScope(legacy2, { id: "legacy2" }, 1);
  assert.equal(seg.getScope(), legacy2, "同优先级换服务实例必须重绑");
  assert.equal(notify, 2);
});

test("g-133/g-191 profile settings 契约：受控字段并保留 Host API fallback", () => {
  const host = readFileSync(new URL("../../dist/index.js", import.meta.url), "utf8");
  const client = readFileSync(new URL("../../dsh-graph-host/lib/client/settings.js", import.meta.url), "utf8");
  for (const field of ["subagentProvider", "subagentModel", "subagentReasoningEffort", "subagentMode", "subagentPrompt"]) assert.match(host, new RegExp(field));
  assert.match(host, /subagentMode: z\.union\(\["", "standard", "minimal"\]\)/);
  assert.doesNotMatch(host, /supervisorPrompt/);
  assert.doesNotMatch(client, /supervisorPrompt/);
  assert.match(client, /api\.settings\.describe/);
  assert.match(client, /api\.settings\.mutate/);
});

test("g-133 provider/model 目录 select 源契约：connection.api 捕获 + llm RPC + 已存值保留 + advisory 不拦截保存", () => {
  const client = readFileSync(new URL("../../dsh-graph-host/lib/client/settings.js", import.meta.url), "utf8");
  // 数据源：settings 模块内捕获 ctx.get('connection').api，挂载时调用 llm.providers/models 目录 RPC
  // g-425：connection 捕获改走受保护读取 helper（optionalService：ctx.get 优先 + 属性访问兜 try/catch，
  // 见 helpers.js），语义不变——仍是从 ctx 取 connection 再取 .api（裸 `ctx?.connection` 在连接服务
  // 缺席时会撞 cordis 注入门禁抛错并中断降级链）。
  assert.match(client, /optionalService\(ctx, "connection"\)/);
  assert.match(client, /createGraphSettingsApiScope\(connection\?\.api, ctx, remoteSettings\)/);
  // g-453：`remote.settings` 是**点分服务名** ⇒ 只能经 optionalServicePath（纯 ctx.get）；属性访问
  // `ctx.remote.settings` 在 0.2.0-rc.2 上抛 `cannot get property "remote.settings" without inject`
  // （**基线产物**实测：抛错被降级 catch 吞成 `gSettingsScope = null`）。但这条腿**可被补偿** ——
  // 本版的 `ctx.inject(["remote.settings"], …)` 声明使属性访问合法（Lane A 变异 n1 真机仍可用）
  // ⇒ 承重腿是**命名空间发现**（=profile 条目 id，见下方 g-453 命名空间守卫）。新线按 describe 实际 ns 集合发现。
  assert.match(client, /optionalServicePath\(ctx, "remote\.settings"\)/);
  assert.doesNotMatch(client, /optionalService\([^)]*"remote\.settings"/);
  assert.match(client, /GRAPH_SETTINGS_NS_CANDIDATES/);
  assert.match(client, /const pickRow = \(view\) =>/);
  assert.match(client, /api\.llm\.providers/);
  assert.match(client, /api\.llm\.models/);
  // provider/model 是目录 select（非自由文本 input）；首项留空继承
  assert.match(client, /h\("select"/);
  assert.match(client, /继承父会话/);
  // 已存但目录未列出的旧值保留为「已存值（当前目录未列出）」固定 option
  assert.match(client, /已存值/);
  assert.match(client, /当前目录未列出/);
  // advisory 目录不拦截保存：不再有「不在目录中」的保存拦截文案
  assert.doesNotMatch(client, /不在当前 Host 的合法 provider 目录中/);
  assert.doesNotMatch(client, /supervisorPrompt/);
});

test("g-133 模型路由：单次派发 override 最高优先", () => {
  const out = resolveModelRoute(
    { provider: "override-p", model: "override-m" },
    { provider: "project-p", model: "project-m" },
    { subagentProvider: "global-p", subagentModel: "global-m" },
  );
  assert.deepEqual(out, { provider: "override-p", model: "override-m" });
});

test("g-133 模型路由：无 override 时 project.yaml 明确值优先于全局默认", () => {
  const out = resolveModelRoute(
    null,
    { provider: "project-p", model: "project-m" },
    { subagentProvider: "global-p", subagentModel: "global-m" },
  );
  assert.deepEqual(out, { provider: "project-p", model: "project-m" });
});

test("g-133 模型路由：override 只给 provider、project 只给 model 时逐层求值", () => {
  const out = resolveModelRoute(
    { provider: "override-p", model: null },
    { provider: null, model: "project-m" },
    { subagentProvider: "global-p", subagentModel: "global-m" },
  );
  // provider：override-p；model：override 为 null → project-m
  assert.deepEqual(out, { provider: "override-p", model: "project-m" });
});

test("g-133 模型路由：全空回退全局默认，均为空则 null（继承）", () => {
  assert.deepEqual(
    resolveModelRoute(null, { provider: null, model: null }, { subagentProvider: "global-p", subagentModel: "global-m" }),
    { provider: "global-p", model: "global-m" },
  );
  assert.deepEqual(
    resolveModelRoute(null, { provider: null, model: null }, { subagentProvider: "", subagentModel: "" }),
    { provider: null, model: null },
  );
});

test("g-133 提示词三态：default 继承全局", () => {
  assert.equal(resolvePromptOverride("全局提示词", "default"), "全局提示词");
});

test("g-133 提示词三态：非空文本覆盖全局", () => {
  assert.equal(resolvePromptOverride("全局提示词", "workspace 覆盖文本"), "workspace 覆盖文本");
});

test("g-133 提示词三态：显式空值禁用（null）", () => {
  assert.equal(resolvePromptOverride("全局提示词", ""), null);
});

test("g-133 提示词三态：全局为空 & default → 空串（注入时视为无补充词）", () => {
  assert.equal(resolvePromptOverride("", "default"), "");
});

test("g-133 project.yaml 覆盖字段解析：缺失 → default", () => {
  assert.equal(readPromptOverrideValue("executor:\n  provider: x\n", "subagent_prompt"), "default");
});

test("g-133 project.yaml 覆盖字段解析：default 字面量 → default", () => {
  assert.equal(readPromptOverrideValue("defaults:\n  subagent_prompt: default\n", "subagent_prompt"), "default");
});

test("g-133 project.yaml 覆盖字段解析：显式空值（单引号）→ 空串", () => {
  assert.equal(readPromptOverrideValue("defaults:\n  subagent_prompt: ''\n", "subagent_prompt"), "");
});

test("g-133 project.yaml 覆盖字段解析：显式空值（双引号）→ 空串", () => {
  assert.equal(readPromptOverrideValue('defaults:\n  supervisor_prompt: ""\n', "supervisor_prompt"), "");
});

test("g-133 project.yaml 覆盖字段解析：带空格/引号的覆盖文本 → 去引号返回原文", () => {
  const yaml = "defaults:\n  subagent_prompt: '专注质量，先跑测试'\n";
  assert.equal(readPromptOverrideValue(yaml, "subagent_prompt"), "专注质量，先跑测试");
});

test("g-133 project.yaml 覆盖字段解析：行尾 # 注释不入值", () => {
  // 单引号内 # 不作注释；行尾裸 # 前为值
  const yaml = "defaults:\n  subagent_prompt: 自定义提示词 # 注释\n";
  assert.equal(readPromptOverrideValue(yaml, "subagent_prompt"), "自定义提示词");
});
