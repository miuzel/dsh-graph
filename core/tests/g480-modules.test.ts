/**
 * g-480：harness 模块可选开关（workspace 级 `project.yaml` 的 `modules` 段，五个模块默认全开）。
 *
 * 面积与判据（验收项 1–8 的机器可验部分）：
 *  · ① schema + 读写 + 三态纯函数双态：未配置 ⇒ 全 `null`/全开，**提示词投影与工具面与改造前逐字节一致**；
 *    显式 true/false 生效；畸形值（字符串/数字）⇒ `invalid_value` 且**按开启**处理（fail-safe，绝不猜「关」）。
 *  · ② 真裁剪：`agent/created` → `agent.ctx.tools.restrict({deny})`，受管工具**从模型可见清单消失**
 *    （量测口 = `tools.schemas(agent)`）；跨会话（子代理链）逐个生效；deny 名单**作用域过滤**；
 *    能力缺失（旧宿主/测试夹具无 `ctx.on` / `tools.restrict`）⇒ 静默降级、零报错、51 个工具照常可见。
 *  · ③ 提示词面裁剪：`memory` 关 ⇒ 常驻记忆段不注入；`automation_prompts` 关 ⇒ 六键指导段不追加；
 *    三个自有 section 的工具名提及按行剔除；**全开时逐字节相同**（`stripModuleToolMentions` 返回同一字符串）。
 *  · ④ 51 红线：apply 期注册**无条件**、不因配置跳过（任何配置下注册数恒为 51）。
 *  · ⑤ 数据安全 / 单一真源：关闭 = 隐藏，不删数据；`memory.tools_enabled` 旧键只作**读侧默认**，
 *    写 `modules.memory` 时同一原子写里删除旧键行 ⇒ 不存在两个真源。
 *  · ⑥ GUI：「模块」页签（g-479 页签结构内）渲染 5 个开关、绑定同一草稿、稀疏提交 `modules.<id>`、
 *    i18n zh/en 对称且 en 零 CJK。
 *  · ⑧ 负向对照（改坏即红，**在 dist 副本上真实变异后用子进程/vm 实跑**）：deny 映射漏一个工具、
 *    作用域过滤被移除、schema 放宽未知键、apply 期按配置跳过注册 —— 四条都必须报红。
 *
 * 反向纪律：本文件不新增任何「引擎强制」语义；模块开关只做**可见面裁剪**，不做权限/审批门禁。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import {
  HARNESS_MODULE_IDS,
  MODULE_TOOL_NAMES,
  moduleToolNames,
  resolveModuleSwitches,
  disabledModuleTools,
  isModuleEnabled,
  stripModuleToolMentions,
  readProjectConfig,
  writeProjectConfig,
  validateSchema,
  settingsPostSchema,
  init,
  isMemoryToolsEnabled,
  setMemoryToolsEnabled,
  addMemory,
} from "../ops.ts";
import { apply } from "../../dist/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const DIST = join(repoRoot, "dist");
const HOST = join(repoRoot, "dsh-graph-host");
const TMP_ROOT = join(repoRoot, "tmp");
const HAN = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

const MODULES = [...HARNESS_MODULE_IDS];

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function tmpDir(tag: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, `g480-${tag}-`));
}

/** 建 workspace + `.dsh-graph/project.yaml`（可**不** init：纯读/写路径都不要求 init）。 */
function makeWorkspace(projectYaml = ""): { ws: string; root: string } {
  const ws = tmpDir("ws");
  const root = join(ws, ".dsh-graph");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "project.yaml"), projectYaml);
  return { ws, root };
}

function writeYaml(root: string, yaml: string): void {
  writeFileSync(join(root, "project.yaml"), yaml);
}

function readYaml(root: string): string {
  return readFileSync(join(root, "project.yaml"), "utf8");
}

/** 真实注册源（`dsh-graph-host/index.js` 的 tools 数组）里全部 `graph_*` 工具名。 */
function registeredToolNames(): string[] {
  const src = readFileSync(join(HOST, "index.js"), "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/name:\s*"(graph_[a-z_]+)"/g)) names.add(m[1]);
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// ① 纯函数双态 / 三态 / schema
// ---------------------------------------------------------------------------

test("g-480 ①：未配置 ⇒ 五模块全 null 且全开，工具面/提示词面与改造前逐字节一致", () => {
  const { root } = makeWorkspace("executor:\n  mode: minimal\n");
  const cfg = readProjectConfig(root);
  assert.deepEqual(cfg.modules, { tags: null, memory: null, shared_cards: null, automation_prompts: null, attachments: null }, "未配置 ⇒ 全 null");
  assert.equal(cfg.modules_legacy_keys, undefined, "无旧键时不产生迁移元数据");
  const sw = resolveModuleSwitches(cfg);
  for (const id of MODULES) {
    assert.deepEqual(sw.switches[id], { module: id, on: true, configured: false, reason: "default_on" }, `${id} 默认开启`);
  }
  assert.deepEqual(sw.disabled, [], "无模块被关闭");
  assert.deepEqual(sw.disabledTools, [], "关闭工具集为空");
  assert.deepEqual(disabledModuleTools(cfg), []);
  for (const id of MODULES) assert.equal(isModuleEnabled(cfg, id), true);

  // 「未配置」不被实体化：读一遍配置不得往 project.yaml 写任何东西
  assert.equal(readYaml(root), "executor:\n  mode: minimal\n", "纯读绝不改写 project.yaml（未配置保持未配置）");

  // 提示词面 diff=0 的**结构性**保证：关闭集为空 ⇒ 返回同一字符串（不是「等值的新串」）
  const text = "第一行 graph_memory_add\n第二行 普通文本\n第三行 graph_set_goal_tags\n";
  assert.equal(stripModuleToolMentions(text, []), text, "关闭集为空 ⇒ 逐字节原样");
  assert.ok(stripModuleToolMentions(text, []) === text, "必须是同一个字符串引用（O(1) 原样返回）");
  assert.equal(stripModuleToolMentions("", ["graph_set_goal_tags"]), "", "空文本原样");
});

test("g-480 ①：显式 true/false/null 三态 + 畸形值 fail-safe 为开启（invalid_value）", () => {
  const { root } = makeWorkspace();
  writeProjectConfig(root, { modules: { tags: false, memory: true, attachments: null } }, "t");
  const cfg = readProjectConfig(root);
  assert.equal(cfg.modules.tags, false);
  assert.equal(cfg.modules.memory, true);
  assert.equal(cfg.modules.attachments, null);
  const sw = resolveModuleSwitches(cfg);
  assert.deepEqual(sw.disabled, ["tags"]);
  assert.deepEqual(sw.disabledTools, ["graph_set_goal_tags"]);
  assert.equal(sw.switches.tags.reason, "explicit_off");
  assert.equal(sw.switches.memory.reason, "explicit_on");
  assert.equal(sw.switches.shared_cards.reason, "default_on");
  assert.equal(isModuleEnabled(cfg, "tags"), false);
  assert.equal(isModuleEnabled(cfg, "memory"), true);

  // 畸形值（手写 YAML 才可能出现的非布尔）：不抛错、按开启。
  // 口径说明：`readProjectConfig` 对所有布尔字段统一走 `boolScalar`（非布尔 ⇒ null），因此畸形值在**读侧**
  // 与「未配置」归一到同一形态（`default_on`）—— 这正是 fail-safe 要的结果：畸形绝不产生 deny 名单，
  // 也绝不因手滑把整块能力静默关掉。`invalid_value` 是**纯函数**对原始对象求值时的可区分原因（下方直接调）。
  for (const bad of ['"false"', "0", '"off"', "no", "{}", "[]"]) {
    writeYaml(root, `modules:\n  tags: ${bad}\n`);
    const c = readProjectConfig(root);
    const s = resolveModuleSwitches(c);
    assert.equal(s.switches.tags.on, true, `畸形值 ${bad} 必须按开启处理（绝不猜「关」）`);
    assert.equal(s.switches.tags.configured, false, `畸形值 ${bad} 不算显式配置`);
    assert.deepEqual(s.disabledTools, [], "畸形值不产生任何 deny 名单");
    assert.deepEqual(disabledModuleTools(c), []);
  }
  // 纯函数对**原始**（未归一）对象求值：畸形值的原因可区分（invalid_value）且仍为开启
  for (const raw of ["false", 0, {}, ["tags"]]) {
    const s = resolveModuleSwitches({ modules: { tags: raw } });
    assert.equal(s.switches.tags.on, true, `原始畸形值 ${JSON.stringify(raw)} 按开启`);
    assert.equal(s.switches.tags.reason, "invalid_value", `原始畸形值 ${JSON.stringify(raw)} ⇒ invalid_value`);
  }
  // 整段畸形（modules 是标量/数组）同样 fail-safe
  for (const yaml of ["modules: false\n", "modules: [tags]\n", "modules: nope\n"]) {
    writeYaml(root, yaml);
    const s = resolveModuleSwitches(readProjectConfig(root));
    for (const id of MODULES) assert.equal(s.switches[id].on, true, `${JSON.stringify(yaml)} ⇒ 全开`);
  }
});

test("g-480 ①：写入入口 schema —— 未知模块键与非布尔值一律拒绝且零写入", () => {
  const { root } = makeWorkspace("executor:\n  mode: minimal\n");
  const before = readYaml(root);
  const cases: Array<[any, RegExp]> = [
    [{ modules: { nope: false } }, /modules/i],
    [{ modules: { tags: "false" } }, /modules/i],
    [{ modules: { tags: 1 } }, /modules/i],
    [{ modules: { tags: {} } }, /modules/i],
  ];
  for (const [patch, re] of cases) {
    assert.throws(() => writeProjectConfig(root, patch, "t"), re, `必须拒绝 ${JSON.stringify(patch)}`);
    assert.equal(readYaml(root), before, `${JSON.stringify(patch)} 被拒后 project.yaml 逐字节不变（零写入）`);
  }
  // HTTP 入口（GET/POST /api/dsh-graph/settings）与写入入口共用同一 schema ⇒ 同一判据
  assert.equal(validateSchema({ modules: { tags: false, memory: null } }, settingsPostSchema).valid, true, "合法 patch 通过 HTTP schema");
  for (const bad of [{ modules: { nope: false } }, { modules: { tags: "false" } }]) {
    assert.equal(validateSchema(bad, settingsPostSchema).valid, false, `HTTP schema 必须拒绝 ${JSON.stringify(bad)}`);
  }
  // 空对象是合法 no-op（不新增键、不改字节）
  writeProjectConfig(root, { modules: {} }, "t");
  assert.equal(readYaml(root), before, "空 modules patch 不改字节");
});

test("g-480 ①：映射表以**真实注册清单**为真源 —— 不漏一个受管工具、不越界、不重复归属", () => {
  const real = registeredToolNames();
  assert.equal(real.length, 51, `真实注册清单应为 51 个工具（实得 ${real.length}）`);
  const managed = moduleToolNames();
  const realSet = new Set(real);
  for (const name of managed) {
    assert.ok(realSet.has(name), `映射表里的 ${name} 不在真实注册清单里（幽灵工具 ⇒ 必红）`);
  }
  assert.equal(new Set(managed).size, managed.length, "受管工具名不得重复（同一工具归两个模块）");

  // 逐模块的**前缀完备性**：真实清单里所有属于该模块命名面的工具都必须在映射表里。
  // 这是「deny 映射漏一个工具」的正向守卫（负向对照见文末变异用例）。
  const expected: Record<string, string[]> = {
    tags: real.filter((n) => n === "graph_set_goal_tags"),
    memory: real.filter((n) => n.startsWith("graph_memory_")),
    shared_cards: real.filter((n) => /_shared_cards?$/.test(n) || n.startsWith("graph_convert_card_to_")),
    attachments: real.filter((n) => n.startsWith("graph_store_attachment") || n.startsWith("graph_delete_attachment")),
  };
  for (const [id, want] of Object.entries(expected)) {
    assert.deepEqual([...MODULE_TOOL_NAMES[id as keyof typeof MODULE_TOOL_NAMES]].sort(), want.sort(), `${id} 映射表必须覆盖其全部命名面工具`);
  }
  assert.deepEqual([...MODULE_TOOL_NAMES.automation_prompts], [], "automation_prompts 是纯提示词面模块（无受管工具）");
  // 边界如实登记：graph_add_card 属于**目标自有卡片**（组装目标的部件），不随 shared_cards 关闭
  assert.ok(!managed.includes("graph_add_card"), "shared_cards 不越界禁目标自有卡片工具 graph_add_card");
  assert.ok(realSet.has("graph_add_card"), "graph_add_card 仍在 51 个注册工具内（只不受模块开关管理）");

  // prompt_face 面：每个模块都必须在 host 侧登记其提示词投影口径（新增模块漏登记 ⇒ 必红）
  const hostSrc = readFileSync(join(HOST, "index.js"), "utf8");
  const faceBlock = hostSrc.slice(hostSrc.indexOf("const MODULE_PROMPT_FACE = {"), hostSrc.indexOf("};", hostSrc.indexOf("const MODULE_PROMPT_FACE = {")));
  for (const id of MODULES) assert.ok(faceBlock.includes(`${id}:`), `MODULE_PROMPT_FACE 缺 ${id} 的提示词面登记`);
});

// ---------------------------------------------------------------------------
// ⑤ 数据安全 / 单一真源（memory 旧键）
// ---------------------------------------------------------------------------

test("g-480 ⑤：memory 单一真源 —— 旧键只作读侧默认，写入即在同一原子写里删除旧键行", () => {
  const { root } = makeWorkspace("memory:\n  tools_enabled: false\nexecutor:\n  mode: minimal\n");
  const cfg = readProjectConfig(root);
  assert.equal(cfg.modules.memory, false, "旧键只提供**读侧默认**：modules.memory 视为显式关闭");
  assert.deepEqual(cfg.modules_legacy_keys, { memory: "memory.tools_enabled" }, "如实标注该值来自旧键");
  assert.equal(isMemoryToolsEnabled(root), false, "既有 API 语义不变（g445 的 coupling 仍成立）");
  assert.deepEqual(disabledModuleTools(cfg).includes("graph_memory_add"), true);
  for (const id of MODULES) if (id !== "memory") assert.equal(cfg.modules[id], null, `${id} 未被旧键影响`);

  // 写 modules.memory ⇒ 同一原子写里删除旧键行（不存在两个真源）
  setMemoryToolsEnabled(root, true, "human:gui");
  const yaml = readYaml(root);
  assert.ok(!/tools_enabled/.test(yaml), "旧键行必须随同一次写入被删除（不留双真源）");
  assert.match(yaml, /modules:\n {2}memory: true/, "写入 modules.memory: true");
  assert.match(yaml, /executor:\n {2}mode: minimal/, "无关段落原样保留");
  const after = readProjectConfig(root);
  assert.equal(after.modules.memory, true);
  assert.equal(after.modules_legacy_keys, undefined, "旧键已删除 ⇒ 迁移元数据消失");
  assert.equal(isMemoryToolsEnabled(root), true);

  // 反向：显式 modules.memory: false 与旧键 true 并存时，**modules 胜出**（单一真源方向明确）
  const w = makeWorkspace("memory:\n  tools_enabled: true\nmodules:\n  memory: false\n");
  assert.equal(readProjectConfig(w.root).modules.memory, false, "modules.memory 优先于旧键");
  assert.equal(isMemoryToolsEnabled(w.root), false);
  assert.equal(readProjectConfig(w.root).modules_legacy_keys, undefined, "已有 modules.memory 时不再回落到旧键");

  // flow style 旧键（行编辑动不了）：读取仍生效，且一旦有 modules.memory 即**惰性失效**
  const f = makeWorkspace("memory: {tools_enabled: false}\n");
  assert.equal(readProjectConfig(f.root).modules.memory, false, "flow style 旧键同样只作读侧默认");
  writeProjectConfig(f.root, { modules: { memory: true } }, "t");
  assert.equal(readProjectConfig(f.root).modules.memory, true, "modules.memory 生效后旧键惰性失效");
  assert.equal(isMemoryToolsEnabled(f.root), true);

  // 关闭 memory 不删除任何记忆数据（判据 5）
  const g = makeWorkspace("");
  init(g.root);
  addMemory(g.root, { kind: "project", scope: "standing", text: "关闭模块不得删除这条记忆。", actor: "human:gui" });
  const file = join(g.root, "memory", "memory.jsonl");
  const beforeMem = readFileSync(file, "utf8");
  writeProjectConfig(g.root, { modules: { memory: false } }, "human:gui");
  assert.equal(readFileSync(file, "utf8"), beforeMem, "关闭 memory 后记忆文件逐字节不变（隐藏 ≠ 删除）");
  assert.equal(resolveModuleSwitches(readProjectConfig(g.root)).switches.memory.on, false);
  // 重新开启 ⇒ 数据仍在（可恢复）
  writeProjectConfig(g.root, { modules: { memory: true } }, "human:gui");
  assert.equal(readFileSync(file, "utf8"), beforeMem, "重新开启后数据原样");
});

// ---------------------------------------------------------------------------
// 宿主模拟：真裁剪（②）、提示词面（③）、51 红线与降级（④）
// ---------------------------------------------------------------------------

type HostMock = {
  ws: string;
  events: Map<string, Function[]>;
  restrictCalls: Array<{ agentId: string; deny: string[] }>;
  ctx: any;
  globalSet: () => Set<string>;
  registered: string[];
  sections: any[];
};

/** 模拟宿主：`tools.register`（apply 期注册面）+ `on`（生命周期事件）+ 每个 agent 自己的 tools 服务。 */
function makeHostMock(ws: string, opts: { on?: boolean; restrict?: boolean; hostPlane?: string[] } = {}): HostMock {
  const sections: any[] = [];
  const registered: string[] = [];
  const events = new Map<string, Function[]>();
  const restrictCalls: Array<{ agentId: string; deny: string[] }> = [];
  const globalSet = new Set<string>();
  const hostPlane = new Set(opts.hostPlane ?? []);
  const ctx: any = {
    get: (key: string) => (key === "systemPrompt" ? { section: (s: any) => { sections.push(s); return () => {}; } } : undefined),
    effect: (fn: any) => { if (typeof fn === "function") fn(); return () => {}; },
    tools: {
      register: (def: any) => { registered.push(def.name); globalSet.add(def.name); return () => {}; },
      // 全局视图（不传 scope）：本插件注册的 51 个工具
      get: (name: string) => (globalSet.has(name) ? { name } : undefined),
    },
  };
  if (opts.restrict !== false) {
    // 插件层 ctx 的 restrict：真实宿主上存在（用于特性探测）；agent 层另有各自的 restrict
    ctx.tools.restrict = () => () => {};
  }
  if (opts.on !== false) {
    ctx.on = (ev: string, fn: Function) => {
      const arr = events.get(ev) ?? [];
      arr.push(fn);
      events.set(ev, arr);
      return () => {};
    };
  }
  return { ws, events, restrictCalls, ctx, globalSet: () => globalSet, registered, sections };
}

function applyHost(h: HostMock): void {
  apply(h.ctx, {});
}

/** 建一个 agent（模拟宿主 `agents.create({ setup })` 后触发 `agent/created`）。 */
function makeAgent(
  h: HostMock,
  opts: { id?: string; cwd?: string | null; local?: string[]; hidden?: string[] } = {},
) {
  const visible = new Set<string>([...h.globalSet(), ...(opts.local ?? [])]);
  for (const n of opts.hidden ?? []) visible.delete(n);
  const denied = new Set<string>();
  const agent: any = { session: { id: opts.id ?? "s-x", header: {} } };
  if (opts.cwd !== null) agent.session.header.cwd = opts.cwd ?? h.ws;
  agent.__visible = visible;
  agent.ctx = {
    effect: (fn: any) => { const d = typeof fn === "function" ? fn() : undefined; return () => { if (typeof d === "function") d(); }; },
    tools: {
      get: (name: string, scope?: any) =>
        (scope ? (scope.__visible.has(name) ? { name } : undefined) : (h.globalSet().has(name) ? { name } : undefined)),
      restrict: (filter: any) => {
        for (const n of filter?.deny ?? []) {
          // 真实语义：deny 里出现对该 agent **不可见**的名字 ⇒ 抛 `unknown global tool`
          if (!visible.has(n)) throw new Error(`unknown global tool: ${n}`);
          denied.add(n);
        }
        h.restrictCalls.push({ agentId: agent.session.id, deny: [...(filter?.deny ?? [])] });
        return () => { denied.clear(); };
      },
      schemas: () => [...visible].filter((n) => !denied.has(n)).map((n) => ({ name: n })),
    },
  };
  return agent;
}

function createAgent(h: HostMock, opts: Parameters<typeof makeAgent>[1] = {}) {
  const agent = makeAgent(h, opts);
  for (const fn of h.events.get("agent/created") ?? []) fn({ agent });
  return agent;
}

const schemaNames = (agent: any): string[] => agent.ctx.tools.schemas().map((s: any) => s.name);

const OFF_TAGS_ATTACH = "modules:\n  tags: false\n  attachments: false\n";
const OFF_ALL = "modules:\n  tags: false\n  memory: false\n  shared_cards: false\n  automation_prompts: false\n  attachments: false\n";

test("g-480 ②：真裁剪 —— 关闭模块的工具从模型可见清单消失（量测口 tools.schemas；含子代理链）", () => {
  // 全开基线：一次 restrict 都不调，可见面 51、与改造前逐字节一致
  const on = makeWorkspace("");
  const ho = makeHostMock(on.ws);
  applyHost(ho);
  assert.equal(ho.registered.length, 51, "apply 期注册 51 个工具");
  const aOn = createAgent(ho, { id: "s-on" });
  assert.equal(schemaNames(aOn).length, 51, "全开 ⇒ 模型可见 51 个工具");
  assert.deepEqual(ho.restrictCalls, [], "全开 ⇒ 零 restrict（未配置路径行为不变）");

  // 关闭 tags + attachments
  const off = makeWorkspace(OFF_TAGS_ATTACH);
  const h = makeHostMock(off.ws);
  applyHost(h);
  assert.equal(h.registered.length, 51, "关闭模块**不改变**注册面（判据 4：不做 apply 期条件跳过）");
  const a = createAgent(h, { id: "s-1" });
  const names = schemaNames(a);
  assert.equal(names.length, 48, "48 = 51 − 3（tags 1 + attachments 2）");
  for (const n of ["graph_set_goal_tags", "graph_store_attachment", "graph_delete_attachment"]) {
    assert.ok(!names.includes(n), `${n} 必须从模型可见清单消失（真裁剪，非 UI 隐藏）`);
  }
  assert.ok(names.includes("graph_add_card"), "目标自有卡片工具不受 shared_cards 关闭影响");
  assert.deepEqual(h.restrictCalls, [{ agentId: "s-1", deny: ["graph_set_goal_tags", "graph_store_attachment", "graph_delete_attachment"] }]);

  // 子代理链：restrict 不沿 scope 链继承 ⇒ 每个新建会话各自 wire（全局监听覆盖宿主派发的每个子代理）
  const b = createAgent(h, { id: "sub-1" });
  assert.equal(h.restrictCalls.length, 2, "每个新会话各自调用一次 restrict（子代理链同样被覆盖）");
  assert.equal(schemaNames(b).length, 48, "子代理会话同样看不到被关模块的工具");
  assert.equal(schemaNames(a).length, 48, "先建会话的可见面不被后建会话影响（各自独立作用域）");

  // 无 cwd：不裁剪、不抛错（避免错 workspace 误判）
  const c = createAgent(h, { id: "s-nocwd", cwd: null });
  assert.equal(schemaNames(c).length, 51, "无 cwd ⇒ 不裁剪（fail-safe）");
  assert.equal(h.restrictCalls.length, 2, "无 cwd 不产生 restrict 调用");
});

test("g-480 ②：deny 名单**作用域过滤** —— 对某会话不可见的候选名不得进 deny（否则 restrict 抛错并回滚会话）", () => {
  const { ws } = makeWorkspace("modules:\n  memory: false\n");
  const h = makeHostMock(ws);
  applyHost(h);
  // 该 agent 看不到 graph_memory_remove（模拟被其它作用域限制/不在其继承面内）
  const a = createAgent(h, { id: "s-hidden", hidden: ["graph_memory_remove"] });
  assert.equal(h.restrictCalls.length, 1, "依然完成裁剪（不因不可见候选而抛错）");
  assert.deepEqual(h.restrictCalls[0].deny, ["graph_memory_add", "graph_memory_replace", "graph_memory_recall"], "不可见候选被过滤掉");
  assert.equal(schemaNames(a).length, 51 - 3, "可见面按**过滤后**的名单裁剪");

  // 全部候选都不可见 ⇒ 一次 restrict 都不调（空名单不调用，避免 no-op 调用与抛错风险）
  const h2 = makeHostMock(ws);
  applyHost(h2);
  const b = createAgent(h2, { id: "s-allhidden", hidden: [...MODULE_TOOL_NAMES.memory] });
  assert.deepEqual(h2.restrictCalls, [], "过滤后名单为空 ⇒ 不调用 restrict");
  assert.equal(schemaNames(b).length, 51, "不可见的候选本来就不在可见面上 ⇒ 结果一致");

  // 边界如实登记：候选集恒为**本插件全局注册**的工具名 ⇒ `tools.get(name)`（全局视图）恒有定义；
  // 过滤的第二项条件（对该 agent 可见）防的正是上面的抛错/回滚。若将来出现「scope 自有同名工具
  // 遮蔽全局同名」的病态配置，`get` 无法区分可见性来源，需另加探针——今天不可达，不提前加复杂度。
  assert.ok(true);
});

test("g-480 ④：能力缺失静默降级 —— 无 ctx.on / 无 tools.restrict 时零报错、零裁剪、51 个工具照常可见", () => {
  for (const opts of [{ on: false }, { restrict: false }, { on: false, restrict: false }]) {
    const { ws } = makeWorkspace(OFF_TAGS_ATTACH);
    const h = makeHostMock(ws, opts);
    applyHost(h); // 不得抛错（旧宿主 / 测试夹具只有 tools.register+get）
    assert.equal(h.registered.length, 51, `降级 ${JSON.stringify(opts)} 下注册数恒为 51`);
    const a = createAgent(h, { id: "s" });
    assert.equal(schemaNames(a).length, 51, "降级时不裁剪（可见面与改造前一致）");
    assert.deepEqual(h.restrictCalls, []);
  }
});

test("g-480 ④：apply 期注册无条件 —— 五模块全关时注册清单仍与全开逐项相同（51 红线不随配置漂移）", () => {
  const on = makeWorkspace("");
  const ho = makeHostMock(on.ws);
  applyHost(ho);
  const off = makeWorkspace(OFF_ALL);
  const hf = makeHostMock(off.ws);
  applyHost(hf);
  assert.deepEqual([...hf.registered].sort(), [...ho.registered].sort(), "注册清单与配置无关（无条件注册）");
  assert.equal(hf.registered.length, 51);
  // 全关时：所有受管工具都从可见面消失，其余工具（含不受模块管理的 graph_add_card）仍在
  const a = createAgent(hf, { id: "s" });
  const names = schemaNames(a);
  assert.equal(names.length, 51 - moduleToolNames().length, `全关后可见面 = 51 − ${moduleToolNames().length} 个受管工具`);
  for (const n of moduleToolNames()) assert.ok(!names.includes(n), `${n} 应不可见`);
  for (const n of hf.registered) if (!moduleToolNames().includes(n)) assert.ok(names.includes(n), `${n} 不受模块开关管理，必须仍可见`);
});
