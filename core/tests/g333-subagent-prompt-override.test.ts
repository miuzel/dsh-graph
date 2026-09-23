/**
 * g-333：设置弹窗写 `prompt_overrides.subagent`，而派发侧读 `defaults.subagent_prompt`——两者零交集，
 * 导致「设置界面上这个字段根本不在派发链路上」。
 *
 * 方案①（负责人 2026-09-24 裁定）：派发侧改为消费**结构化三态** `prompt_overrides.subagent`
 * （core `resolveSubagentPrompt` → `composeSubagentPrompt`），遗留 `defaults.subagent_prompt`
 * 降级为 deprecated 兼容回落（闭集优先级），不再有第二个独立消费者。
 *
 * ## 判据覆盖与「证据分工」（判据 5 要求明示，不含混宣称）
 *
 * - 判据 1：三条写入路径（GUI 弹窗载荷 / REST `/api/dsh-graph/settings` / `graph_update_settings`）
 *   → 派发正文，**三条都有实测**；接线契约另以源码断言锁定「唯一消费者」。
 * - 判据 2/3：三态 × 遗留 × 全局的**闭集优先级**——纯函数穷举 + 真实 YAML 读取 + 派发端到端四例。
 * - 判据 4：含空格/引号/#/多行/制表符的文本经 `writeProjectConfig`（`JSON.stringify` 编码）
 *   → YAML → 读取 → **派发正文逐字比对**，且注入产物中无字面 `\n`。
 * - 判据 5：端到端断言打在 `startContinuable` 捕获的**真实派发 prompt 正文**上（不是 promptHash）；
 *   promptHash 变化只作旁证，单独标注。
 * - 判据 6：写入门禁与无副作用（非法 state / 值未变 / 注释与未知键）。
 * - 判据 7 的「回归」由 `bash scripts/build.sh` + 全量 `node --test` 承担，本文件不重复计数；
 *   本文件另断言 i18n 键未被新增/改名、`graph_*` 工具未新增（由既有断言承担，不重复）。
 *
 * ## 已知证据边界（如实声明）
 *
 * profile 全局 `subagentPrompt` 经 DSH settings 服务（`@deepseek-ai/schemastery`）解析；本测试进程
 * 解析不到该模块 ⇒ `graphSettingsScope` 恒为 null ⇒ host 侧全局值恒为 `""`。故
 * 「default → 回落全局 profile」由 **纯函数用例 + host 接线源码契约** 承担，
 * 而「设置写入 → 派发正文」由 override / disable / 遗留 三条**真实端到端**链路承担。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import {
  init,
  createGoal,
  setCriteria,
  loadGoal,
  writeProjectConfig,
  readProjectConfig,
  readPromptOverride,
  readLegacySubagentPrompt,
  readPromptOverrideValue,
  composeSubagentPrompt,
  resolveSubagentPrompt,
  GraphError,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";

const HOST_SRC = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");
const MODAL_SRC = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/settings-modal.js"), "utf8");
const I18N_SRC = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/i18n.js"), "utf8");

/** 判据 4 的往返样本：中英混排 + 多空格 + 双引号 + `#` + 多行（\n）+ 制表符。 */
const ROUND_TRIP_TEXT = '第一行 "引号" # 井号   多空格\n第二行\t制表符 末尾';

// ===== 通用夹具 =====

function emptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g333-"));
  init(root);
  return root;
}

function writeYaml(root: string, text: string): void {
  writeFileSync(join(root, "project.yaml"), text, "utf8");
}

function readYaml(root: string): string {
  return readFileSync(join(root, "project.yaml"), "utf8");
}

function newGoal(root: string, title: string): string {
  const goal = createGoal(root, { title, version: "v-g333", actor: "test" });
  setCriteria(root, goal, ["判据：注入正文与设置值一致"], "test");
  return goal;
}

/** host mock：webServer 路由 + 工具注册 + `subagents.startContinuable` 捕获真实派发 prompt。 */
function makeHostCtx(captured: { prompt?: string }, workspace: string) {
  const routes = new Map<string, any>();
  const registered: any[] = [];
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "sandboxPolicy") return { workspaceRoot: workspace };
      if (name === "subagents") {
        return {
          list: () => ["spawn"],
          getProvider: () => ({ prepareContinuable: () => {} }),
          startContinuable: async (opts: any) => {
            captured.prompt = opts.request?.prompt?.[0]?.text ?? "";
            return { childId: "child-g333", parentSessionId: "sess-super" };
          },
        };
      }
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root: undefined });
  return { routes, registered };
}

function execCtx(ws: string) {
  return { agent: { session: { id: "sess-exec", header: { cwd: ws } } }, signal: new AbortController().signal };
}

function fakeReq(method: string, url: string, body: any) {
  const listeners: Record<string, Function> = {};
  return {
    method,
    url,
    on: (e: string, fn: Function) => { listeners[e] = fn; },
    _emit: () => { listeners.data?.(JSON.stringify(body)); listeners.end?.(); },
  };
}

function fakeRes() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}

/** 经真实 REST 端点写入设置（GUI 弹窗保存走同一端点）。 */
async function postSettings(handler: any, ws: string, body: any) {
  const req = fakeReq("POST", "/api/dsh-graph/settings?workspace=" + encodeURIComponent(ws), body);
  const res = fakeRes();
  const p = handler(req, res);
  req._emit();
  await p;
  return res;
}

/** 经真实 `graph_start_attempt` 派发（worktree=false 只影响隔离段，不影响补充提示词段）。 */
async function dispatchTool(registered: any[], ws: string, goal: string, captured: { prompt?: string }) {
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  const res = await tool.execute({ goal, worktree: false, attempt_brief: "g-333 端到端校验" }, execCtx(ws));
  return { res, prompt: captured.prompt as string };
}

function attemptMeta(root: string, goal: string, attempt: string): any {
  return loadGoal(join(root, "versions", "v-g333", "goals", goal, "attempts", attempt, "attempt.md")).meta;
}

/** 从派发正文中抠出「子代理补充提示词」段落的正文（模板会剥掉 `## 标题` 行并 trim，见 formatAttemptDiscipline）。 */
function injectedBody(prompt: string): string | null {
  const marker = "【dsh-graph 子代理补充提示词·仅作背景，非任务】\n";
  const at = prompt.indexOf(marker);
  if (at < 0) return null;
  const rest = prompt.slice(at + marker.length);
  const end = rest.indexOf("\n\n");
  return end < 0 ? rest : rest.slice(0, end);
}

/** 从 settings-modal.js 真实源码里抠出草稿归一化与载荷构造（不重写等价实现）。 */
function loadModalHelpers() {
  const start = MODAL_SRC.indexOf("function normalizeSettingsDraft(");
  const end = MODAL_SRC.indexOf("function SettingsModal(");
  assert.ok(start > 0 && end > start, "settings-modal.js 含完整草稿/载荷函数段");
  const ctx: any = {};
  new vm.Script(
    `(function () {\n${MODAL_SRC.slice(start, end)}\nglobalThis.__norm = normalizeSettingsDraft;\nglobalThis.__build = buildSettingsPatch;\n})()`,
  ).runInNewContext(ctx);
  return { norm: ctx.__norm as any, build: ctx.__build as any };
}

// ============================================================================
// 判据 2/3：闭集优先级（纯函数穷举，含「override + 空文本」）
// ============================================================================

test("g-333 判据 2/3：三态 × 遗留 × 全局的闭集优先级穷举（override+空文本 ≡ disable）", () => {
  const GLOBAL = "全局提示词";
  const LEGACY = "遗留文本";
  const OV = "覆盖文本";
  const ov = (state: any, value: any) => ({ state, value });
  const r = (o: any, legacy: string, global = GLOBAL) => composeSubagentPrompt(global, o, legacy);

  // override → 覆盖遗留与全局（三种遗留取值都不影响）
  assert.equal(r(ov("override", OV), LEGACY), OV);
  assert.equal(r(ov("override", OV), "default"), OV);
  assert.equal(r(ov("override", OV), ""), OV);

  // 判据 3：override + 空文本（null/""）→ 等价 disable：不回落遗留、不回落全局
  assert.equal(r(ov("override", null), LEGACY), null, "override+null → 段消失（不回落）");
  assert.equal(r(ov("override", ""), LEGACY), null, "override+'' → 段消失（不回落）");
  assert.equal(r(ov("override", ""), ""), null);

  // disable → 段消失且绝不回落
  assert.equal(r(ov("disable", null), LEGACY), null);
  assert.equal(r(ov("disable", null), "default"), null);
  assert.equal(r(ov("disable", null), ""), null);

  // default → 回落遗留值；遗留 default/缺失 → 回落全局；遗留 "" → 段消失
  assert.equal(r(ov("default", null), LEGACY), LEGACY, "state=default 回落遗留值");
  assert.equal(r(ov("default", null), "default"), GLOBAL, "遗留 default → 回落全局");
  assert.equal(r(ov("default", null), ""), null, "遗留 '' → 显式禁用，不回落全局");
  assert.equal(r(ov("default", null), "default", ""), null, "全局也为空 → 不注入该段");
  assert.equal(r(ov("default", null), LEGACY, ""), LEGACY, "全局为空不吞掉遗留文本");

  // 闭集单调性：返回值只有 null 或非空文本（永不返回 ""，避免「注入了空段」的第三种状态）
  const states = ["default", "override", "disable"];
  const values = [null, "", OV];
  const legacies = ["default", "", LEGACY];
  for (const state of states) {
    for (const value of values) {
      for (const legacy of legacies) {
        const out = composeSubagentPrompt(GLOBAL, ov(state, value), legacy);
        assert.ok(out === null || out.length > 0, `闭集返回值：${state}/${JSON.stringify(value)}/${JSON.stringify(legacy)} → ${JSON.stringify(out)}`);
      }
    }
  }
});

// ============================================================================
// 判据 1/2：真实 YAML 读取的闭集优先级（含遗留字段）
// ============================================================================

test("g-333 判据 2：三态与遗留字段并存时的闭集优先级（真实 project.yaml）", () => {
  // 仅遗留字段存在 → 兼容消费（deprecated，但仍生效）
  const r1 = emptyRoot();
  writeYaml(r1, "defaults:\n  subagent_prompt: '遗留文本'\n");
  assert.equal(readLegacySubagentPrompt(r1), "遗留文本");
  assert.equal(resolveSubagentPrompt(r1, "全局"), "遗留文本");

  // override 覆盖遗留
  const r2 = emptyRoot();
  writeYaml(r2, "defaults:\n  subagent_prompt: '遗留文本'\nprompt_overrides:\n  subagent: \"覆盖文本\"\n");
  assert.equal(readPromptOverride(r2, "subagent").state, "override");
  assert.equal(resolveSubagentPrompt(r2, "全局"), "覆盖文本");

  // state=default 回落遗留
  const r3 = emptyRoot();
  writeYaml(r3, "defaults:\n  subagent_prompt: '遗留文本'\nprompt_overrides:\n  subagent: default\n");
  assert.equal(resolveSubagentPrompt(r3, "全局"), "遗留文本");

  // state=default + 无遗留 → 回落全局（此用例为纯读取路径；host 侧全局值边界见文件头声明）
  const r4 = emptyRoot();
  writeYaml(r4, "prompt_overrides:\n  subagent: default\n");
  assert.equal(resolveSubagentPrompt(r4, "全局"), "全局");

  // state=disable 不回落
  const r5 = emptyRoot();
  writeYaml(r5, "defaults:\n  subagent_prompt: '遗留文本'\nprompt_overrides:\n  subagent: disable\n");
  assert.equal(resolveSubagentPrompt(r5, "全局"), null);

  // 对外声明的三个状态名**裸字面量**都必须可读：`disable` 亦然
  //（此前只认 `""`，裸写 `subagent: disable` 会被当成 override 文本 "disable" 注入 prompt）
  const r5b = emptyRoot();
  writeYaml(r5b, "prompt_overrides:\n  subagent: disable\n");
  assert.deepEqual(readPromptOverride(r5b, "subagent"), { state: "disable", value: null });
  assert.equal(resolveSubagentPrompt(r5b, "全局"), null, "裸 disable → 段消失（不回落全局）");
  // 带引号则按 YAML 标量语义视为显式文本（需要把 "disable" 当文本时的转义用法）
  const r5c = emptyRoot();
  writeYaml(r5c, "prompt_overrides:\n  subagent: '\"disable\"'\n");
  assert.deepEqual(readPromptOverride(r5c, "subagent"), { state: "override", value: '"disable"' });

  // 判据 3 的存储侧事实：override + 空文本经合法编码后读回即 disable
  const r6 = emptyRoot();
  writeProjectConfig(r6, { prompt_overrides: { subagent: { state: "override", value: "" } } }, "human:gui");
  assert.deepEqual(readPromptOverride(r6, "subagent"), { state: "disable", value: null });
  assert.equal(resolveSubagentPrompt(r6, "全局"), null);

  // 无 project.yaml → 回落全局；全局为空 → 不注入
  const r7 = emptyRoot();
  assert.equal(resolveSubagentPrompt(r7, "全局"), "全局");
  assert.equal(resolveSubagentPrompt(r7, ""), null);
});

test("g-333 判据 1：遗留字段改为按路径读取（不再全文件正则），null 不再被当文本注入", () => {
  const root = emptyRoot();
  const yaml = "defaults:\n  pk:\n    lanes: 1\nother:\n  subagent_prompt: '不该被读'\n";
  writeYaml(root, yaml);
  assert.equal(readLegacySubagentPrompt(root), "default", "路径化读取不误命中其它块的同名键");
  assert.equal(readPromptOverrideValue(yaml, "subagent_prompt"), "不该被读", "（差异留证）遗留全文件正则确实会误命中");

  const r2 = emptyRoot();
  writeYaml(r2, "defaults:\n  subagent_prompt: null\n");
  assert.equal(readLegacySubagentPrompt(r2), "default", "null/~/缺失 → 未配置（回落），不再注入字面 'null'");
  assert.equal(readPromptOverrideValue("defaults:\n  subagent_prompt: null\n", "subagent_prompt"), "null", "（差异留证）遗留读取器会把字面 null 当文本");

  const r3 = emptyRoot();
  writeYaml(r3, "defaults:\n  subagent_prompt: ''\n");
  assert.equal(readLegacySubagentPrompt(r3), "", "显式空值仍是「显式禁用」，不是回落");
  assert.equal(resolveSubagentPrompt(r3, "全局"), null);
});

// ============================================================================
// 判据 4：往返保真（writeProjectConfig 的 JSON.stringify 编码 → 结构化解码）
// ============================================================================

test("g-333 判据 4：含空格/引号/#/多行/制表符的文本往返逐字保真，YAML 内为 JSON 转义序列", () => {
  const root = emptyRoot();
  writeYaml(root, "# 项目配置\nprompt_overrides:\n  subagent: default  # 行尾注释\nunknown_key: keep-me\n");
  writeProjectConfig(root, { prompt_overrides: { subagent: { state: "override", value: ROUND_TRIP_TEXT } } }, "human:gui");

  const yaml = readYaml(root);
  // 编码证据：多行/制表符在 YAML 里就是**字面** `\n` / `\t` 序列（JSON.stringify 编码）
  assert.ok(yaml.includes("\\n"), "writeProjectConfig 用 JSON.stringify 编码：YAML 内是字面 \\n 序列");
  assert.ok(yaml.includes("\\t"), "制表符同样被转义");
  // 读取侧逐字还原（三处读路径全部一致）
  assert.deepEqual(readPromptOverride(root, "subagent"), { state: "override", value: ROUND_TRIP_TEXT });
  assert.deepEqual(readProjectConfig(root).prompt_overrides.subagent, { state: "override", value: ROUND_TRIP_TEXT });
  assert.equal(resolveSubagentPrompt(root, "全局"), ROUND_TRIP_TEXT);
  // 首尾空格也必须逐字保真（prompt 模板层的 trim 是模板行为，见端到端用例注释）
  const spaced = "  前导空格与尾随空格  ";
  writeProjectConfig(root, { prompt_overrides: { subagent: { state: "override", value: spaced } } }, "human:gui");
  assert.deepEqual(readPromptOverride(root, "subagent"), { state: "override", value: spaced });
  // 注释与未知键保留
  assert.ok(yaml.includes("# 项目配置") && yaml.includes("unknown_key: keep-me") && yaml.includes("# 行尾注释"));
});

// ============================================================================
// 判据 1/4/5：端到端（REST 写入 → 真实派发正文）
// ============================================================================

test("g-333 判据 1/4/5：REST 写入 → 派发正文逐字包含该文本（断言落在注入正文，非 promptHash）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g333-e2e-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  writeYaml(root, "supervisor:\n  session: sess-super\n");
  const captured: { prompt?: string } = {};
  const { routes, registered } = makeHostCtx(captured, ws);
  const settingsRoute = routes.get("/api/dsh-graph/settings");

  // 基线：未设置覆盖 → 不注入该段（同时给出「变了」的对照）
  const g0 = newGoal(root, "基线目标");
  const base = await dispatchTool(registered, ws, g0, captured);
  assert.equal(injectedBody(base.prompt), null, "无覆盖时不注入补充提示词段");
  const baseHash = attemptMeta(root, g0, base.res.attempt).prompt_hash;

  // ① 经真实 REST 端点写入（GUI 弹窗保存走同一端点，见下一条用例）
  // 注意：settings body 走 schema 严格校验（additionalProperties 拒绝），workspace 只走 query 参数
  const res = await postSettings(settingsRoute, ws, {
    prompt_overrides: { subagent: { state: "override", value: ROUND_TRIP_TEXT } },
  });
  assert.equal(res._code, 200, "REST 写入成功");
  assert.deepEqual(res._body.config.prompt_overrides.subagent, { state: "override", value: ROUND_TRIP_TEXT }, "REST 回填即写入值（逐字）");

  // ② 派发 → 注入正文逐字比对
  const g1 = newGoal(root, "覆盖目标");
  const ov = await dispatchTool(registered, ws, g1, captured);
  assert.equal(injectedBody(ov.prompt), ROUND_TRIP_TEXT, "注入正文与设置文本逐字一致（含多行/引号/#/制表符/多空格）");
  assert.ok(ov.prompt.includes("【dsh-graph 子代理补充提示词·仅作背景，非任务】"), "注入段标记存在");
  assert.ok(!ov.prompt.includes("\\n"), "注入产物中不得出现字面 \\n（结构化读取器已解码 JSON 转义）");
  assert.ok(ov.prompt.includes("\n第二行\t制表符 末尾"), "多行与制表符以真实字符形态进入 prompt");
  // 判据 5 核心：设置改了 → 渲染产物真的变了
  assert.notEqual(ov.prompt, base.prompt, "设置改了 → 派发渲染产物变了");
  // 旁证（**不是**主证据）：promptHash 也随正文变化
  const ovHash = attemptMeta(root, g1, ov.res.attempt).prompt_hash;
  assert.notEqual(ovHash, baseHash, "（旁证）promptHash 随正文变化——hash 只能证明变了，正文比对才证明变对了");

  // ③ disable：段消失，且不回落遗留（下面先植入遗留字段：确定性重写，避免手工拼接 YAML）
  writeYaml(root, "supervisor:\n  session: sess-super\ndefaults:\n  subagent_prompt: '遗留端到端文本'\n");
  const res2 = await postSettings(settingsRoute, ws, { prompt_overrides: { subagent: { state: "disable" } } });
  assert.equal(res2._code, 200);
  const g2 = newGoal(root, "禁用目标");
  const dis = await dispatchTool(registered, ws, g2, captured);
  assert.equal(injectedBody(dis.prompt), null, "state=disable → 段消失，不回落遗留（也不回落全局）");

  // ④ state=default + 遗留字段 → 回落遗留值（deprecated 兼容在派发侧真的接线了）
  const res3 = await postSettings(settingsRoute, ws, { prompt_overrides: { subagent: { state: "default" } } });
  assert.equal(res3._code, 200);
  const g3 = newGoal(root, "回落遗留目标");
  const legacy = await dispatchTool(registered, ws, g3, captured);
  assert.equal(injectedBody(legacy.prompt), "遗留端到端文本", "state=default 在派发侧回落遗留字段");

  // ⑤ default + 无遗留（键整体缺失）→ 全局为空（本进程无 settings 服务）→ 不注入
  writeYaml(root, "supervisor:\n  session: sess-super\n");
  const g4 = newGoal(root, "回落全局目标");
  const none = await dispatchTool(registered, ws, g4, captured);
  assert.equal(injectedBody(none.prompt), null, "default 且无覆盖/无遗留 → 全局为空 → 不注入");
});

test("g-333 判据 1：graph_update_settings 写入即生效（第三条写入路径）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g333-tool-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  writeYaml(root, "supervisor:\n  session: sess-super\n");
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured, ws);

  const tool = registered.find((d) => d.name === "graph_update_settings");
  const out = await tool.execute({
    patch: { prompt_overrides: { subagent: { state: "override", value: "工具写入文本\n第二行" } } },
  }, execCtx(ws));
  assert.equal(out.ok, true, "graph_update_settings 写入成功");
  assert.deepEqual(readPromptOverride(root, "subagent"), { state: "override", value: "工具写入文本\n第二行" });

  const goal = newGoal(root, "工具写入目标");
  const { prompt } = await dispatchTool(registered, ws, goal, captured);
  assert.equal(injectedBody(prompt), "工具写入文本\n第二行", "工具写入的设置经派发正文生效");
});

test("g-333 判据 1/3：弹窗草稿（真实 buildSettingsPatch）→ REST → 派发正文", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g333-modal-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  writeYaml(root, "supervisor:\n  session: sess-super\n");
  const captured: { prompt?: string } = {};
  const { routes, registered } = makeHostCtx(captured, ws);
  const { norm, build } = loadModalHelpers();

  const form = {
    executor: { provider: "p-1", model: "m-1", reasoning_effort: "high", mode: "standard" },
    defaults: { review: { reviewer: "human", prompt: null }, pk: { lanes: 1, sandbox: "" } },
    supervisor: { automation: { release: "ai" } },
    review: { policy: "" },
    prompt_overrides: { subagent: { state: "override", value: "弹窗写入文本\n第二行" } },
  };
  const patch = build(form);
  // vm 里构造的对象与测试 realm 的 Object.prototype 不同，故按 JSON 形态比对（内容等价即可）
  const sub = (p: any) => JSON.parse(JSON.stringify(p.prompt_overrides.subagent));
  assert.deepEqual(sub(patch), { state: "override", value: "弹窗写入文本\n第二行" }, "弹窗载荷三态直传");
  // 载荷抽函数后其余字段口径不回归（原先由 g-133/g-231 的源码契约断言覆盖，此处改为**执行真实函数**断言）
  assert.deepEqual(
    JSON.parse(JSON.stringify({ executor: patch.executor, supervisor: patch.supervisor, review: patch.review, defaults: patch.defaults })),
    {
      executor: { provider: "p-1", model: "m-1", reasoning_effort: "high", mode: "standard" },
      supervisor: { automation: { release: "ai" } },
      review: { policy: null },
      defaults: { review: { reviewer: "human", prompt: null }, pk: { lanes: 1, sandbox: "" } },
    },
    "executor/defaults/supervisor/review 载荷口径与 save 原实现一致",
  );

  // 判据 3 的 UI 侧：override + 空文本在草稿与载荷里都归一为 disable（存储层无法表示空 override）
  const emptyOverrideForm = JSON.parse(JSON.stringify(form));
  emptyOverrideForm.prompt_overrides.subagent = { state: "override", value: "" };
  assert.deepEqual(sub(build(emptyOverrideForm)), { state: "disable", value: "" }, "override+'' → disable");
  const nullOverrideForm = JSON.parse(JSON.stringify(form));
  nullOverrideForm.prompt_overrides.subagent = { state: "override", value: null };
  assert.deepEqual(sub(build(nullOverrideForm)), { state: "disable", value: "" }, "override+null → disable");
  const disabledForm = JSON.parse(JSON.stringify(form));
  disabledForm.prompt_overrides.subagent = { state: "disable", value: null };
  assert.equal(
    JSON.stringify(norm(emptyOverrideForm, "15")),
    JSON.stringify(norm(disabledForm, "15")),
    "草稿归一化同口径（override+空 ≡ disable，不产生假脏）",
  );

  // 弹窗载荷 → 真实 REST 端点 → 真实派发正文
  const res = await postSettings(routes.get("/api/dsh-graph/settings"), ws, patch);
  assert.equal(res._code, 200, "弹窗载荷被 REST schema 接受");
  const goal = newGoal(root, "弹窗写入目标");
  const { prompt } = await dispatchTool(registered, ws, goal, captured);
  assert.equal(injectedBody(prompt), "弹窗写入文本\n第二行", "弹窗草稿经 REST 落到派发正文（三段链路实测）");
});

// ============================================================================
// 判据 6：写入门禁与无副作用
// ============================================================================

test("g-333 判据 6：非法 state 逐字节不变且无事件；值未变不写盘不记事件；注释与未知键保留", () => {
  const root = emptyRoot();
  const initial = "# 项目配置\nexecutor:\n  provider: keep\nunknown_key: keep-me\n";
  writeYaml(root, initial);
  const eventsBefore = readEvents(root).length;

  assert.throws(
    () => writeProjectConfig(root, { prompt_overrides: { subagent: { state: "ghost" } } }, "human:gui"),
    GraphError,
    "非法 state 被拒",
  );
  assert.equal(readYaml(root), initial, "非法 state：project.yaml 逐字节不变");
  assert.equal(readEvents(root).length, eventsBefore, "非法 state：无事件写入");

  writeProjectConfig(root, { prompt_overrides: { subagent: { state: "override", value: "文本" } } }, "human:gui");
  const afterFirst = readYaml(root);
  const eventsAfterFirst = readEvents(root).length;
  assert.equal(eventsAfterFirst, eventsBefore + 1, "合法写入记一条 project.config_set");
  assert.ok(afterFirst.includes("# 项目配置") && afterFirst.includes("unknown_key: keep-me") && afterFirst.includes("provider: keep"), "注释与未知键保留");

  writeProjectConfig(root, { prompt_overrides: { subagent: { state: "override", value: "文本" } } }, "human:gui");
  assert.equal(readYaml(root), afterFirst, "值未变：不写盘");
  assert.equal(readEvents(root).length, eventsAfterFirst, "值未变：不记事件");

  // override + 空文本 / null 的编码形态（判据 3 的存储侧定义；两条路径字节一致）
  const r2 = emptyRoot();
  writeProjectConfig(r2, { prompt_overrides: { subagent: { state: "override", value: "" } } }, "human:gui");
  assert.ok(readYaml(r2).includes('subagent: ""'), "override+'' 编码为 \"\"");
  const r3 = emptyRoot();
  writeProjectConfig(r3, { prompt_overrides: { subagent: { state: "override", value: null } } }, "human:gui");
  assert.equal(readYaml(r3), readYaml(r2), "override+null 与 override+'' 同编码");
  assert.deepEqual(readPromptOverride(r3, "subagent"), { state: "disable", value: null }, "读回即 disable（显式定义，非静默沿用）");
});

// ============================================================================
// 接线契约：唯一消费者 + i18n 未动
// ============================================================================

test("g-333 判据 1：派发侧接线契约——唯一消费者为结构化三态，遗留正则读取器已无调用点", () => {
  assert.match(
    HOST_SRC,
    /const p = resolveSubagentPrompt\(root, globalSettings\.subagentPrompt\);/,
    "派发侧把 profile 全局值交给 core 唯一消费者（global 回落由此接线）",
  );
  assert.doesNotMatch(HOST_SRC, /readPromptOverrideValue\s*\(/, "遗留全文件正则读取器在 host 已无调用点");
  assert.doesNotMatch(HOST_SRC, /const readPromptOverride = \(/, "本地正则包装已删除（旧实现与弹窗零交集）");
  assert.doesNotMatch(HOST_SRC, /readPromptOverride\(root,/, "不再以遗留键名独立读取 project.yaml");

  // i18n 键未新增/改名（parity 敏感）——弹窗仍用同一标签键
  assert.match(MODAL_SRC, /dgT\("settings\.subagentPrompt"\)/);
  assert.match(I18N_SRC, /'settings\.subagentPrompt'/);
});
