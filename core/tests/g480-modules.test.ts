/**
 * g-480：harness 模块可选开关（workspace 级 `project.yaml` 的 `modules` 段，五个模块默认全开）。
 *
 * 面积与判据（验收项 1–8 的机器可验部分）：
 *  · ① schema + 读写 + 三态纯函数双态：未配置 ⇒ 全 `null`/全开，**提示词投影与工具面与改造前逐字节一致**；
 *    显式 true/false 生效；畸形值（字符串/数字）⇒ `invalid_value` 且**按开启**处理（fail-safe，绝不猜「关」）。
 *  · ② 真裁剪：`agent/created` → `agent.ctx.tools.restrict({deny})`，受管工具**从模型可见清单消失**
 *    （量测口 = `tools.schemas(agent)`）；跨会话（子代理链）逐个生效；deny 名单**作用域过滤**；
 *    能力缺失（旧宿主/测试夹具无 `ctx.on` / `tools.restrict`）⇒ 静默降级、零报错、53 个工具照常可见。
 *  · ③ 提示词面裁剪：`memory` 关 ⇒ 常驻记忆段不注入；`automation_prompts` 关 ⇒ 六键指导段不追加；
 *    三个自有 section 的工具名提及按行剔除；**全开时逐字节相同**（`stripModuleToolMentions` 返回同一字符串）。
 *  · ④ 53 红线：apply 期注册**无条件**、不因配置跳过（任何配置下注册数恒为 53）。
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
import { join, resolve, sep } from "node:path";
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
  toolFilterForRole,
  getRoleProfile,
  diagnoseDispatchCapability,
  // g-480（att-002 裁决）：角色档案随模块自适应 —— core 单点真源 + 派生的受影响角色清单
  moduleAwareRoleProfile,
  rolesAdaptedByModule,
  writeSupervisorSession,
  createGoal,
  appendGoalComment,
  addCard,
  fillCard,
  formatHarvestedCardsSection,
  // g-480（att-002）：collector 派发提示词的模块投影（工具面 + REST 面同一函数）
  formatCollectPrompt,
  storeAttachment,
  readAttachment,
  parseAttachmentRefs,
  attachmentProblems,
  attachmentsDir,
  validate,
} from "../ops.ts";
import type { SubagentRole } from "../ops.ts";
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
  assert.equal(real.length, 53, `真实注册清单应为 53 个工具（实得 ${real.length}）`);
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
  assert.ok(realSet.has("graph_add_card"), "graph_add_card 仍在 53 个注册工具内（只不受模块开关管理）");

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
// 宿主模拟：真裁剪（②）、提示词面（③）、53 红线与降级（④）
// ---------------------------------------------------------------------------

type RestrictCall = { agentId: string; deny: string[]; allow?: string[] };

type HostMock = {
  ws: string;
  events: Map<string, Function[]>;
  restrictCalls: RestrictCall[];
  ctx: any;
  globalSet: () => Set<string>;
  registered: string[];
  registeredDefs: Map<string, any>;
  sections: any[];
};

/**
 * 模拟宿主：`tools.register`（apply 期注册面）+ `on`（生命周期事件）+ 每个 agent 自己的 `tools` 服务。
 *
 * ⚠️ 本夹具**刻意不宽松**：分层语义与真源 `dsh-tools/lib/index.js` 的 `view()` 同构（`knownNames` /
 * `restrictableNames` / `visible` 三个集合），因为「deny 名单作用域过滤」这条硬约束的全部价值就在于
 * **夹具会像真宿主一样抛错**：
 *   · global 平面（本插件 `ctx.tools.register` 的 53 个工具 + `opts.hostTools` 的宿主自带工具）；
 *   · ancestor 平面（`opts.ancestor`：祖先层 / agent 平面自有工具）⇒ **后代**可点名，全局视图里没有；
 *   · own 平面（`opts.own`：本会话自己层注册）⇒ `restrictableNames` **不含**它 ⇒ 点名必抛 `unknown global tool`。
 * `restrict` 与真源一样**先全量校验再落地**（空过滤 / 保留名 `run_code` / 未知名 ⇒ 抛错且**零副作用**，
 * 因为真源的校验发生在 `layers.effect` 之前）。
 */
function makeHostMock(
  ws: string,
  opts: {
    on?: boolean;
    restrict?: boolean;
    hostTools?: string[];
    onThrows?: boolean;
    hideGlobal?: string[];
    refuseRegister?: string[];
  } = {},
): HostMock {
  const sections: any[] = [];
  const registered: string[] = [];
  const registeredDefs = new Map<string, any>();
  const events = new Map<string, Function[]>();
  const restrictCalls: RestrictCall[] = [];
  const globalSet = new Set<string>(opts.hostTools ?? []);
  // `hideGlobal`：模拟宿主**漂移**（该工具被挪出全局层：改成会话/agent 平面注册，或本版本根本没有）
  // ⇒ 插件照常注册（计数红线），但 `tools.get(name)`（全局视图）读不到它。
  const hideGlobal = new Set<string>(opts.hideGlobal ?? []);
  // `refuseRegister`：模拟宿主**拒收/去重**某个注册（注册面少一个工具）⇒ 用于 53 红线的负向对照
  const refuseRegister = new Set<string>(opts.refuseRegister ?? []);
  const ctx: any = {
    get: (key: string) => (key === "systemPrompt" ? { section: (s: any) => { sections.push(s); return () => {}; } } : undefined),
    effect: (fn: any) => { if (typeof fn === "function") fn(); return () => {}; },
    tools: {
      register: (def: any) => {
        if (refuseRegister.has(def.name)) return () => {};
        registered.push(def.name);
        registeredDefs.set(def.name, def);
        if (!hideGlobal.has(def.name)) globalSet.add(def.name);
        return () => {};
      },
      // 全局视图（不传 scope）：本插件注册的 53 个工具（+ 宿主自带）
      get: (name: string) => (globalSet.has(name) ? { name } : undefined),
    },
  };
  if (opts.restrict !== false) {
    // 插件层 ctx 的 restrict：真实宿主上存在（用于特性探测）；agent 层另有各自的 restrict
    ctx.tools.restrict = () => () => {};
  }
  if (opts.on !== false) {
    ctx.on = (ev: string, fn: Function) => {
      if (opts.onThrows) throw new Error("event not supported by this host");
      const arr = events.get(ev) ?? [];
      arr.push(fn);
      events.set(ev, arr);
      return () => {};
    };
  }
  return { ws, events, restrictCalls, ctx, globalSet: () => globalSet, registered, registeredDefs, sections };
}

function applyHost(h: HostMock): void {
  apply(h.ctx, {});
}

/** 建一个 agent（模拟宿主 `agents.create({ setup })`；再由 `createAgent` 触发 `agent/created`）。 */
function makeAgent(
  h: HostMock,
  opts: { id?: string; cwd?: string | null; own?: string[]; ancestor?: string[]; hidden?: string[] } = {},
) {
  const ownPlane = new Set<string>(opts.own ?? []);
  const ancestorPlane = new Set<string>(opts.ancestor ?? []);
  // view().restrictableNames = global + 祖先层（**不含** own 层）⇒ 点 own 名必抛 unknown global tool
  const restrictable = new Set<string>([...h.globalSet(), ...ancestorPlane]);
  // view().visible = 继承面里被每一层放行的名字 + own 层（own 注册不受 restriction 影响）
  const visible = new Set<string>([...h.globalSet(), ...ancestorPlane, ...ownPlane]);
  for (const n of opts.hidden ?? []) visible.delete(n); // 祖先层已限制掉的（仍可点名，不抛错）
  const layers: Array<{ allow: Set<string> | null; deny: Set<string> }> = [];
  const agent: any = { session: { id: opts.id ?? "s-x", header: {} } };
  if (opts.cwd !== null) agent.session.header.cwd = opts.cwd ?? h.ws;
  agent.__visible = visible;
  agent.ctx = {
    effect: (fn: any) => { const d = typeof fn === "function" ? fn() : undefined; return () => { if (typeof d === "function") d(); }; },
    tools: {
      get: (name: string, scope?: any) =>
        (scope ? (scope.__visible.has(name) ? { name } : undefined) : (h.globalSet().has(name) ? { name } : undefined)),
      restrict: (filter: any) => {
        const allowNames: string[] | undefined = filter?.allow;
        const denyNames: string[] | undefined = filter?.deny;
        // 真源：空过滤 / 保留名 / 未知名 ⇒ 抛错；校验先于 layers.effect ⇒ 抛错时**零副作用**
        if (allowNames === undefined && denyNames === undefined) {
          throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny`");
        }
        for (const n of [...(allowNames ?? []), ...(denyNames ?? [])]) {
          if (n === "run_code") throw new Error('tools.restrict() cannot name reserved PTC mode presentation transport "run_code"');
          if (!restrictable.has(n)) throw new Error(`tools.restrict() names unknown global tool "${n}"`);
        }
        const layer = { allow: allowNames === undefined ? null : new Set(allowNames), deny: new Set(denyNames ?? []) };
        layers.push(layer);
        const rec: RestrictCall = { agentId: agent.session.id, deny: [...layer.deny] };
        if (allowNames !== undefined) rec.allow = [...allowNames];
        h.restrictCalls.push(rec);
        return () => { const at = layers.indexOf(layer); if (at >= 0) layers.splice(at, 1); };
      },
      schemas: () => [...visible]
        // own 层注册不受 restriction 影响；继承面上的名字须被每一层同时放行
        .filter((n) => (ownPlane.has(n) ? true : layers.every((l) => (!l.allow || l.allow.has(n)) && !l.deny.has(n))))
        .map((n) => ({ name: n })),
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
  // 全开基线：一次 restrict 都不调，可见面 53、与改造前逐字节一致
  const on = makeWorkspace("");
  const ho = makeHostMock(on.ws);
  applyHost(ho);
  assert.equal(ho.registered.length, 53, "apply 期注册 53 个工具");
  const aOn = createAgent(ho, { id: "s-on" });
  assert.equal(schemaNames(aOn).length, 53, "全开 ⇒ 模型可见 53 个工具");
  assert.deepEqual(ho.restrictCalls, [], "全开 ⇒ 零 restrict（未配置路径行为不变）");

  // 关闭 tags + attachments
  const off = makeWorkspace(OFF_TAGS_ATTACH);
  const h = makeHostMock(off.ws);
  applyHost(h);
  assert.equal(h.registered.length, 53, "关闭模块**不改变**注册面（判据 4：不做 apply 期条件跳过）");
  const a = createAgent(h, { id: "s-1" });
  const names = schemaNames(a);
  assert.equal(names.length, 50, "50 = 53 − 3（tags 1 + attachments 2）");
  for (const n of ["graph_set_goal_tags", "graph_store_attachment", "graph_delete_attachment"]) {
    assert.ok(!names.includes(n), `${n} 必须从模型可见清单消失（真裁剪，非 UI 隐藏）`);
  }
  assert.ok(names.includes("graph_add_card"), "目标自有卡片工具不受 shared_cards 关闭影响");
  assert.deepEqual(h.restrictCalls, [{ agentId: "s-1", deny: ["graph_set_goal_tags", "graph_store_attachment", "graph_delete_attachment"] }]);

  // 子代理链：restrict 不沿 scope 链继承 ⇒ 每个新建会话各自 wire（全局监听覆盖宿主派发的每个子代理）
  const b = createAgent(h, { id: "sub-1" });
  assert.equal(h.restrictCalls.length, 2, "每个新会话各自调用一次 restrict（子代理链同样被覆盖）");
  assert.equal(schemaNames(b).length, 50, "子代理会话同样看不到被关模块的工具");
  assert.equal(schemaNames(a).length, 50, "先建会话的可见面不被后建会话影响（各自独立作用域）");

  // 无 cwd：不裁剪、不抛错（避免错 workspace 误判）
  const c = createAgent(h, { id: "s-nocwd", cwd: null });
  assert.equal(schemaNames(c).length, 53, "无 cwd ⇒ 不裁剪（fail-safe）");
  assert.equal(h.restrictCalls.length, 2, "无 cwd 不产生 restrict 调用");
});

test("g-480 ②：deny 名单**作用域过滤**（硬约束②）—— 不可点名 / 不可解析候选名永不进 deny", () => {
  const { ws } = makeWorkspace("modules:\n  memory: false\n");
  const MEM = [...MODULE_TOOL_NAMES.memory];
  assert.equal(MEM.length, 4, "memory 受管工具 4 个（本用例的算术前提）");

  // (a) 宿主漂移 / agent 平面：该工具**不在全局视图**（注册被挪到会话层），但对该 agent 可见。
  //     真源语义：`restrict` 校验的是 `view(scope).restrictableNames`（全局层 + 祖先层，**不含** own 层）
  //     ⇒ 点名这种名字必抛 `unknown global tool`，而在 setup / 会话创建路径上抛错会**回滚整个会话**。
  const h = makeHostMock(ws, { hideGlobal: ["graph_memory_remove"] });
  applyHost(h);
  assert.equal(h.registered.length, 53, "注册面不受影响（判据 4 的 53 红线：漂移只影响可见性解析）");
  const a = createAgent(h, { id: "s-drift", own: ["graph_memory_remove"] });
  assert.equal(h.restrictCalls.length, 1, "漂移候选被剔除后仍有 3 个候选 ⇒ 照常完成一次裁剪（不抛错）");
  assert.deepEqual(h.restrictCalls[0].deny, MEM.filter((n) => n !== "graph_memory_remove"), "漂移候选不进 deny");
  assert.equal(schemaNames(a).length, 53 - 3, "可见面 = 53 − 3；own 层那个名字不在 deny 内 ⇒ 仍可见");
  assert.ok(schemaNames(a).includes("graph_memory_remove"), "own 层注册不受 restriction 影响（不误删会话自有工具）");
  // 反证：本夹具**不宽松** —— 直接点名该名字确实抛 `unknown global tool`，
  // ⇒ 上面的绿灯来自我们的作用域过滤（`tools.get(name)` 全局视图判定），而不是夹具对未知名的宽容。
  assert.throws(() => a.ctx.tools.restrict({ deny: ["graph_memory_remove"] }), /unknown global tool/);
  assert.equal(schemaNames(a).length, 53 - 3, "抛错零副作用（真源校验先于落地，不留半截限制）");

  // (b) 该名字在任何平面都解析不到（宿主版本已移除）⇒ 两个条件都不过 ⇒ 同样被过滤，不抛错
  const h2 = makeHostMock(ws, { hideGlobal: ["graph_memory_recall"] });
  applyHost(h2);
  const b = createAgent(h2, { id: "s-gone" });
  assert.deepEqual(h2.restrictCalls[0].deny, MEM.filter((n) => n !== "graph_memory_recall"));
  assert.equal(schemaNames(b).length, 52 - 3, "可见面 = 52 − 3");

  // (c) own 层同名遮蔽全局同名：**全局同名仍在** ⇒ 仍可点名（restrictableNames 含它），
  //     且 deny 只作用于继承面 ⇒ 不误删会话自有工具。
  const h3 = makeHostMock(ws);
  applyHost(h3);
  const c = createAgent(h3, { id: "s-own", own: ["graph_memory_add"] });
  assert.equal(h3.restrictCalls.length, 1);
  assert.deepEqual(h3.restrictCalls[0].deny, MEM, "全局同名仍进 deny（known 集含全局名）");
  assert.ok(schemaNames(c).includes("graph_memory_add"), "own 层注册不受 restriction 影响");
  assert.equal(schemaNames(c).length, 53 - 3, "另外 3 个受管工具照常从可见面消失");

  // (d) 候选全部被祖先层遮蔽（可见面里已无）⇒ 过滤后名单为空 ⇒ 一次 restrict 都不调（不做空调用）
  const h4 = makeHostMock(ws);
  applyHost(h4);
  const d = createAgent(h4, { id: "s-hidden", hidden: MEM });
  assert.deepEqual(h4.restrictCalls, [], "过滤后名单为空 ⇒ 不调用 restrict");
  assert.equal(schemaNames(d).length, 53 - MEM.length, "候选本就被祖先层遮蔽（可见面已少 4）⇒ 不再重复 deny");
});

test("g-480 ②：监听器的 workspace 口径**与工具侧/提示面同源**（header.cwd，无兜底）+ 监听器结构不变式", () => {
  // 真机上 `dsh-subagent` 的 cwd 参数只改「有效工作目录」，**不改**子会话 header.cwd（e2e 实拍），
  // 而工具侧 rootFor 用的是 `session.header.cwd ?? sandboxPolicy.workspaceRoot`（index.js:1440 同源
  // sessionWorkspace()），三个 section 也读 header.cwd ⇒ 裁剪必须用**同一个**口径，否则会出现
  // 「工具面裁了、提示词面没裁」或「裁剪 workspace ≠ board root」的分歧。本用例把口径钉在源码层。
  const src = readFileSync(join(HOST, "index.js"), "utf8");
  // att-002：能力探测已收口为**单一常量** `moduleTrimSupported`（监听器注册与设置状态面共用同一次判定）
  // ⇒ 结构守卫锚点随实现更新（语义不变：定位裁剪监听器块），并额外钉住「常量就是原探测表达式」。
  const PROBE = 'const moduleTrimSupported = typeof ctx?.on === "function" && typeof ctx?.tools?.restrict === "function";';
  assert.ok(src.includes(PROBE), "能力探测必须仍是同一表达式（唯一真源，不得改写语义）");
  const START = "if (moduleTrimSupported) {";
  const END = "// g-118：supervisor 守则自动注入";
  const i = src.indexOf(START);
  const j = src.indexOf(END, i + 1);
  assert.ok(i >= 0, "监听器注册锚点必须存在（结构性守卫的前提）");
  assert.ok(j > i, "监听器块必须以 g-118 注释为结束锚点");
  const block = src.slice(i, j);
  assert.ok(block.includes("ctx.on(\"agent/created\""), "锚点块必须仍是 agent/created 裁剪监听器（防锚点漂移到别处）");

  // ① 读法唯一：agent.session.header.cwd
  assert.ok(block.includes("agent?.session?.header?.cwd"), "workspace 必须取自 agent.session.header.cwd");
  // ② 不得兜底到别的 workspace 来源（避免与 section 面分歧 + 避免错 workspace 误裁）
  for (const forbidden of ["effectiveCwd", "process.cwd()", "sandboxPolicy", "workingDirectory"]) {
    assert.ok(!block.includes(forbidden), `监听器不得使用 ${forbidden} 作为 workspace 来源（口径必须唯一）`);
  }
  // ③ 硬约束②的作用域过滤必须双条件（全局视图 + 该 agent 视图）
  assert.ok(/at\.get\(name\)\s*!==\s*undefined/.test(block), "必须用全局视图 tools.get(name) 判定可点名");
  assert.ok(/at\.get\(name,\s*agent\)\s*!==\s*undefined/.test(block), "必须用该 agent 视图 tools.get(name, agent) 判定可解析");
  // ④ 硬约束①的 try/catch 兜底 + 留痕（抛错不得逃逸到会话创建路径）；
  // g-561 起留痕文案用中性功能描述，不得再带历史目标编号（本断言锚定整行）
  const catchWrite = block.match(/catch \(e\) \{\s*\n\s*\/\/[^\n]*\n\s*(process\.stderr\.write\(`[^`]*`\))/);
  assert.ok(catchWrite, "裁剪体必须有兜底 catch 并写 stderr 留痕");
  assert.match(catchWrite![1], /\[dsh-graph-host\] 模块裁剪跳过: \$\{e\?\.message \?\? e\}/, "留痕保留中性功能描述与错误摘要");
  assert.doesNotMatch(catchWrite![1], /\bg-\d+\b/, "留痕不得包含目标编号");
  // ⑤ 未配置/全开路径**一次 restrict 都不调**（行为逐字节不变的结构保证）
  assert.ok(block.includes("if (!switches.disabledTools.length) return;"), "全开必须提前返回（零 restrict 调用）");
  assert.ok(block.includes("if (!cwd) return;"), "无 cwd ⇒ 提前返回（fail-safe：不裁剪）");
  // ⑥ 视图口径必须与工具侧同一表达式（防将来只改一边）
  assert.ok(src.includes("ex?.agent?.session?.header?.cwd ?? ctx.get?.(\"sandboxPolicy\")?.workspaceRoot ?? null"), "工具侧 sessionWorkspace() 的既有口径不得被改动（两边同源）");
});

test("g-480 ④：能力缺失静默降级 —— 无 ctx.on / 无 tools.restrict 时零报错、零裁剪、53 个工具照常可见", () => {
  for (const opts of [{ on: false }, { restrict: false }, { on: false, restrict: false }]) {
    const { ws } = makeWorkspace(OFF_TAGS_ATTACH);
    const h = makeHostMock(ws, opts);
    applyHost(h); // 不得抛错（旧宿主 / 测试夹具只有 tools.register+get）
    assert.equal(h.registered.length, 53, `降级 ${JSON.stringify(opts)} 下注册数恒为 53`);
    const a = createAgent(h, { id: "s" });
    assert.equal(schemaNames(a).length, 53, "降级时不裁剪（可见面与改造前一致）");
    assert.deepEqual(h.restrictCalls, []);
  }
});

test("g-480 ④：apply 期注册无条件 —— 五模块全关时注册清单仍与全开逐项相同（53 红线不随配置漂移）", () => {
  const on = makeWorkspace("");
  const ho = makeHostMock(on.ws);
  applyHost(ho);
  const off = makeWorkspace(OFF_ALL);
  const hf = makeHostMock(off.ws);
  applyHost(hf);
  assert.deepEqual([...hf.registered].sort(), [...ho.registered].sort(), "注册清单与配置无关（无条件注册）");
  assert.equal(hf.registered.length, 53);
  // 全关时：所有受管工具都从可见面消失，其余工具（含不受模块管理的 graph_add_card）仍在
  const a = createAgent(hf, { id: "s" });
  const names = schemaNames(a);
  assert.equal(names.length, 53 - moduleToolNames().length, `全关后可见面 = 53 − ${moduleToolNames().length} 个受管工具`);
  for (const n of moduleToolNames()) assert.ok(!names.includes(n), `${n} 应不可见`);
  for (const n of hf.registered) if (!moduleToolNames().includes(n)) assert.ok(names.includes(n), `${n} 不受模块开关管理，必须仍可见`);
});

// ---------------------------------------------------------------------------
// ② 硬约束①：接线永不抛错（restrict 抛错不得回滚会话创建）
// ---------------------------------------------------------------------------

/** 捕获 `process.stderr.write`（监听器的 fail-safe 留痕走这里）。 */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig = (process.stderr as any).write;
  (process.stderr as any).write = (chunk: any) => { chunks.push(String(chunk)); return true; };
  try { fn(); } finally { (process.stderr as any).write = orig; }
  return chunks.join("");
}

test("g-480 ②：接线永不抛错（硬约束①）—— restrict 抛错被吞并留痕、不毒化后续会话、事件面不可用即静默降级", () => {
  const { ws } = makeWorkspace(OFF_TAGS_ATTACH);
  const h = makeHostMock(ws);
  applyHost(h);
  const a = makeAgent(h, { id: "s-throw" });
  // 让该会话的 restrict 无条件抛错：这正是「setup / 会话创建路径上抛错」的形状
  // （`dsh-agent-loop` 的 publish :1789 与 initializeAgent :1944 在同一个 try 里 ⇒ 抛出去就是会话创建回滚）
  a.ctx.tools.restrict = () => { throw new Error("simulated restrict failure"); };
  const notes = captureStderr(() => { for (const fn of h.events.get("agent/created") ?? []) fn({ agent: a }); });
  assert.match(notes, /模块裁剪跳过[\s\S]*simulated restrict failure/, "必须 try/catch 并留痕（可诊断，不静默）");
  assert.doesNotMatch(notes, /\bg-\d+\b/, "裁剪失败留痕不得包含目标编号（中性功能描述）");
  assert.equal(schemaNames(a).length, 53, "裁剪失败 ⇒ 可见面保持原状（fail-open 到「全开」= 等价降级）");
  assert.equal(h.restrictCalls.length, 0, "抛错的 restrict 不记账");

  // 接线无残留状态：一次抛错不得毒化后续会话
  const b = createAgent(h, { id: "s-after" });
  assert.equal(schemaNames(b).length, 50, "前一会话抛错不影响后一会话的裁剪（50 = 53 − 3）");
  assert.deepEqual(h.restrictCalls.map((c) => c.agentId), ["s-after"]);

  // 事件注册本身抛错（旧宿主 / 事件名不支持）⇒ 特性探测静默降级，注册面不漂移
  const h2 = makeHostMock(ws, { onThrows: true });
  assert.doesNotThrow(() => applyHost(h2), "ctx.on 抛错必须被吞掉（特性探测）");
  assert.equal(h2.registered.length, 53, "降级路径不改变注册面");
  const c = createAgent(h2, { id: "s-nolisten" });
  assert.equal(schemaNames(c).length, 53, "无监听 ⇒ 零裁剪（与改造前一致）");

  // info 形状退化（无 agent.ctx.tools）/ 无 cwd：监听器只 return，不抛错
  const h3 = makeHostMock(ws);
  applyHost(h3);
  assert.doesNotThrow(() => {
    for (const fn of h3.events.get("agent/created") ?? []) fn({ agent: { session: { id: "s-bare", header: { cwd: ws } } } });
  }, "无 agent.ctx.tools ⇒ 静默 return");
  assert.deepEqual(h3.restrictCalls, []);
});

test("g-480 ②：与 dsh-subagent 自身 setup 的 toolFilter 叠加（硬约束①/②）—— 两层过滤**相交**、不抛错", () => {
  const { ws } = makeWorkspace("modules:\n  memory: false\n");
  const filter = toolFilterForRole("summarizer", "standard");
  assert.ok(filter?.allow, "summarizer 标准模式有 allow 名单（本用例的前提）");
  const allow = [...filter!.allow!];
  assert.ok(allow.includes("graph_memory_recall"), "真实 allow 含 graph_memory_recall ⇒ 与 memory 模块的 deny 相交（否则用例失去意义）");
  const h = makeHostMock(ws, { hostTools: ["read", "glob", "grep", "graph_refresh_results"] });
  applyHost(h);
  const child = makeAgent(h, { id: "sub-1" });
  // dsh-subagent 形状：applyChildComposition(childCtx, parent, composition) → childCtx.tools.restrict(composition.toolFilter)
  assert.doesNotThrow(() => child.ctx.tools.restrict({ allow }), "子代理自己的 allow 层先落地（dsh-subagent setup 形状）");
  // 随后宿主 publish `agent/created` ⇒ 本插件在**同一个** agent 上追加 deny
  assert.doesNotThrow(() => { for (const fn of h.events.get("agent/created") ?? []) fn({ agent: child }); }, "叠加本插件的 deny 不得抛错（否则会话创建回滚）");
  assert.deepEqual(schemaNames(child).sort(), ["glob", "graph_refresh_results", "grep", "read"], "allow ∩ ¬deny：memory 关闭把 graph_memory_recall 从**子代理**允许集里也移除（相交，不是覆盖）");
  assert.deepEqual(h.restrictCalls, [
    { agentId: "sub-1", deny: [], allow },
    { agentId: "sub-1", deny: [...MODULE_TOOL_NAMES.memory] },
  ], "两层各自独立记账：本插件只下 deny，绝不改写子代理的 allow");
});

// ---------------------------------------------------------------------------
// ③ 提示词面裁剪（按会话 workspace 现读；全开 diff=0）
// ---------------------------------------------------------------------------

function sectionByName(h: HostMock, name: string): any {
  const s = h.sections.find((x: any) => x.name === name);
  assert.ok(s, `section ${name} 必须已注册（实得 [${h.sections.map((x: any) => x.name).join(", ")}]）`);
  return s;
}

function promptAsset(file: string): string {
  return readFileSync(join(DIST, "prompts", file), "utf8");
}

test("g-480 ③：三个自有 section 的注册形状不变（name/order/interpolate）+ 全开逐字等同资产", () => {
  const { ws } = makeWorkspace("");
  const h = makeHostMock(ws);
  applyHost(h);
  assert.deepEqual(h.sections.map((s: any) => s.name), ["dsh-graph-guide-hint", "dsh-graph-supervisor-discipline", "dsh-graph-standing-memory"], "本插件只注册这 3 个 section（g-389 审计面不变）");
  assert.deepEqual(h.sections.map((s: any) => s.order), [10, 11, 92], "order 不变");
  for (const s of h.sections) assert.equal(s.interpolate, false, `${s.name} 必须字面量（g-389：不参与 {{}} 插值）`);
  const c = { agent: { session: { id: "s-1", header: { cwd: ws } } } };
  const hint = sectionByName(h, "dsh-graph-guide-hint").text(c);
  assert.ok(hint === promptAsset("guide-hint.zh.md") || hint === promptAsset("guide-hint.en.md"), "全开 ⇒ 引导段逐字来自本地化资产（无改写、无追加）");
});

test("g-480 ③：关闭模块 ⇒ 该模块的提示词面不再出现（记忆段整段 / 六键段不追加 / 工具名按行剔除）", () => {
  // —— 常驻记忆段（order 92）：动态正文里的受管工具名按行剔除 ——
  const { ws, root } = makeWorkspace("");
  init(root);
  addMemory(root, { kind: "project", scope: "standing", text: "KEEP-STANDING-LINE 该行必须保留", actor: "human:gui" });
  addMemory(root, { kind: "project", scope: "standing", text: "需要项目知识库时调用 graph_list_shared_cards 列出卡片", actor: "human:gui" });
  const h = makeHostMock(ws);
  applyHost(h);
  const c = { agent: { session: { id: "s-1", header: { cwd: ws } } } };
  const memOn = sectionByName(h, "dsh-graph-standing-memory").text(c);
  assert.ok(memOn.includes("KEEP-STANDING-LINE"), "全开 ⇒ 常驻记忆正文注入");
  assert.ok(memOn.includes("graph_list_shared_cards"), "全开 ⇒ 记忆正文里的工具名提及原样保留（不裁剪）");

  writeProjectConfig(root, { modules: { shared_cards: false } }, "human:gui");
  const cardsOff = sectionByName(h, "dsh-graph-standing-memory").text(c);
  assert.ok(!cardsOff.includes("graph_list_shared_cards"), "关 shared_cards ⇒ 动态记忆正文里该工具名所在**行**被剔除");
  assert.ok(cardsOff.includes("KEEP-STANDING-LINE"), "只剔受管工具名所在行，其它记忆正文逐字保留（不整段丢失）");

  writeProjectConfig(root, { modules: { memory: false } }, "human:gui");
  assert.equal(sectionByName(h, "dsh-graph-standing-memory").text(c), "", "关 memory ⇒ 常驻记忆段**整段不注入**");
  assert.ok(readFileSync(join(root, "memory", "memory.jsonl"), "utf8").includes("KEEP-STANDING-LINE"), "只隐藏注入面：记忆数据文件逐字未动（判据 5：关闭不删数据）");

  // —— 主管纪律段（order 11，仅主管会话）：automation_prompts 关 ⇒ **只不追加**六键指导段 ——
  const { ws: wsSup, root: rootSup } = makeWorkspace("executor:\n  mode: minimal\n");
  init(rootSup);
  writeSupervisorSession(rootSup, "sup-1", "t");
  writeProjectConfig(rootSup, { supervisor: { automation: { scope_planning: "human", release: "ai" } } }, "t");
  const hs = makeHostMock(wsSup);
  applyHost(hs);
  const cs = { agent: { session: { id: "sup-1", header: { cwd: wsSup } } } };
  const autoOn = sectionByName(hs, "dsh-graph-supervisor-discipline").text(cs);
  const asset = autoOn.includes(promptAsset("discipline.zh.md")) ? promptAsset("discipline.zh.md") : promptAsset("discipline.en.md");
  assert.ok(autoOn.startsWith("\n" + asset), "全开 ⇒ 拼接形状与改造前一致（\\n + 本地化纪律资产 + 六键指导段）");
  const guidance = autoOn.slice(1 + asset.length);
  assert.ok(guidance.trim().length > 0, "六键生效 ⇒ 必须追加指导段（否则本用例失去意义）");

  writeProjectConfig(rootSup, { modules: { automation_prompts: false } }, "t");
  const autoOff = sectionByName(hs, "dsh-graph-supervisor-discipline").text(cs);
  assert.equal(autoOff, "\n" + asset, "关 automation_prompts ⇒ 只**不追加**六键段；纪律正文逐字保留（差异面 = 追加段）");
  assert.ok(!autoOff.includes(guidance.slice(0, 24)), "六键指导段不得以任何形式残留");

  // 既有语义不变：非主管会话 / 无 cwd ⇒ 纪律段为空串
  writeProjectConfig(rootSup, { modules: { automation_prompts: true } }, "t");
  assert.equal(sectionByName(hs, "dsh-graph-supervisor-discipline").text({ agent: { session: { id: "someone-else", header: { cwd: wsSup } } } }), "", "非主管会话不注入（g-131 语义不变）");
  assert.equal(sectionByName(hs, "dsh-graph-supervisor-discipline").text({ agent: { session: { id: "sup-1", header: {} } } }), "", "无 cwd ⇒ 不注入（避免错 workspace 误判）");
});

// ---------------------------------------------------------------------------
// ① graph_get_settings 端到端 + prompt_face 元数据与真实面对账
// ---------------------------------------------------------------------------

test("g-480 ①：graph_get_settings 端到端 —— modules 段 + schema_hints 与真实注册/prompt_face 闭集对账", () => {
  const { ws, root } = makeWorkspace("modules:\n  tags: false\n");
  const h = makeHostMock(ws);
  applyHost(h);
  const def = h.registeredDefs.get("graph_get_settings");
  assert.ok(def?.execute, "graph_get_settings 必须已注册且可执行");
  const res: any = def.execute({}, { agent: { session: { header: { cwd: ws } } } });
  assert.equal(res.config.modules.tags, false, "工具读到的 config 反映 project.yaml 的 modules 段");
  assert.equal(res.config_path, join(root, "project.yaml"));
  const m = res.schema_hints.modules;
  assert.ok(m, "schema_hints 必须含 modules（调用方据此渲染模块开关）");
  assert.equal(m.scope, "workspace", "只允许工作区级一层（负责人已定）");
  assert.equal(m.default, true, "未配置 = 开启");
  assert.deepEqual(m.values, [true, false, null]);
  assert.deepEqual(m.keys, [...HARNESS_MODULE_IDS], "五模块键序与 core 同源");
  const real = new Set(registeredToolNames());
  const sectionNames = new Set(h.sections.map((s: any) => s.name));
  const assetText = ["guide-hint.zh.md", "guide-hint.en.md", "discipline.zh.md", "discipline.en.md"].map(promptAsset).join("\n");
  for (const id of HARNESS_MODULE_IDS) {
    const pm = m.per_module[id];
    assert.ok(pm, `per_module 必须含 ${id}`);
    assert.deepEqual(pm.tools, [...MODULE_TOOL_NAMES[id]], `${id} 的 tools 与 core 的 MODULE_TOOL_NAMES 同源（不是第二份副本）`);
    for (const n of pm.tools) assert.ok(real.has(n), `${n} 必须在真实注册清单里`);
    const face: string = pm.prompt_face;
    if (face === "none" || face === "tool-name-mentions:none") {
      for (const n of pm.tools) assert.ok(!assetText.includes(n), `${id} 声明 ${face} ⇒ 四个 section 资产里不得出现其工具名（对账失败请如实改元数据）`);
    } else if (face === "tool-name-mentions:dynamic-memory") {
      assert.ok(pm.tools.some((n: string) => n.startsWith("graph_list_shared") || n.startsWith("graph_convert_card")), `${id} 声明 dynamic-memory ⇒ 其受管工具名确有可能出现在动态记忆正文里`);
    } else if (face.startsWith("section-part:")) {
      const [sname, part] = face.slice("section-part:".length).split("#");
      assert.ok(sectionNames.has(sname), `${id} 声明的 section ${sname} 必须真实注册`);
      assert.equal(part, "automation-guidance", "唯一已知的 section-part 是 automation-guidance（新增须同步本用例）");
    } else if (face.startsWith("role-prompt:")) {
      // 「可达提及只在某_子代理角色的**档案**与派发提示词里」⇒ 用**真实**口径证明两件事（att-002 裁决后）：
      //   ① 模块关闭时该角色**仍可派发**（自检通过）——**不再**用「拒绝派发」当裁剪手段；
      //   ② 该角色的档案面（`requiredTools`/`allowedTools`/persona 文本）**不再引用**该模块的受管工具名
      //      （单一真源 = `moduleAwareRoleProfile`，宿主只消费；派发提示词的投影见 ⑨ 与 e2e）。
      const role = face.slice("role-prompt:".length) as SubagentRole;
      const denied = new Set(MODULE_TOOL_NAMES[id]);
      const on = diagnoseDispatchCapability(role, "standard", { available: () => true });
      assert.equal(on.ok, true, `${role} 全开时必须可派发`);
      // 元数据前置条件：该角色档案里**确实**提及其受管工具（否则这条元数据是空话）
      assert.ok(
        [...denied].some((n) => JSON.stringify(getRoleProfile(role)).includes(n)),
        `${id} 声明 role-prompt:${role} ⇒ 该角色档案必须真实提及 ${[...denied].join("/")}（否则元数据不成立）`,
      );
      // ① 关闭 ⇒ 能力自检**通过**：角色随模块自适应，而不是被拒派发
      const idOff = resolveModuleSwitches({ modules: { [id]: false } });
      const offDiag = diagnoseDispatchCapability(role, "standard", { available: () => true }, idOff);
      assert.equal(
        offDiag.ok,
        true,
        `${id} 关闭 ⇒ ${role} 必须**仍可派发**（档案随模块自适应，不得再以「拒绝派发」当裁剪），实际 message=${String(offDiag.message)}`,
      );
      // ② 关闭 ⇒ 档案面逐项剔除（工具面 + persona 文本面）
      const adapted = moduleAwareRoleProfile(role, idOff);
      for (const n of denied) {
        assert.ok(!adapted.requiredTools.includes(n), `${id} 关闭 ⇒ ${role}.requiredTools 不得再含 ${n}`);
        assert.ok(!(adapted.allowedTools.standard ?? []).includes(n), `${id} 关闭 ⇒ ${role}.allowedTools.standard 不得再含 ${n}`);
        assert.ok(!(adapted.allowedTools.minimal ?? []).includes(n), `${id} 关闭 ⇒ ${role}.allowedTools.minimal 不得再含 ${n}`);
        const faceText = [adapted.description, adapted.disciplineTitle, ...adapted.disciplineLines, adapted.bashPermissionNote ?? ""].join("\n");
        assert.ok(!faceText.includes(n), `${id} 关闭 ⇒ ${role} 的 persona 文本面不得再提及 ${n}（stripModuleToolMentions 单点收口）`);
      }
      // 单点真源派生：受影响角色清单必须点名该角色
      assert.ok(rolesAdaptedByModule(id).includes(role), `${id} ⇒ rolesAdaptedByModule 必须列出 ${role}（schema_hints.per_module.roles 同源）`);
      // 全开 / 未配置 ⇒ **同一对象**（零拷贝，逐字节一致）
      assert.equal(moduleAwareRoleProfile(role, resolveModuleSwitches(null)), getRoleProfile(role), `${role} 全开 ⇒ 直接返回原档案对象（未配置路径零 diff）`);
      // **区分**「模块关」与「宿主真缺工具」：探针点名缺 `read` ⇒ 仍 fail-closed 拒绝派发（g-473 语义原样保留）
      const hostMissing = diagnoseDispatchCapability(role, "standard", { available: (n: string) => n !== "read" }, idOff);
      assert.equal(hostMissing.ok, false, `${id} 关闭 + 宿主真缺 read ⇒ 仍必须拒绝派发（g-473 fail-closed 不变）`);
      assert.match(String(hostMissing.message), /未启动子代理/, "宿主真缺工具时必须明示未启动子代理（不是静默降级）");
    } else {
      assert.ok(face.startsWith("section:"), `${id} 的 prompt_face 不在闭集内：${face}`);
      assert.ok(sectionNames.has(face.slice("section:".length)), `${id} 声明的 section 必须真实注册`);
    }
  }
  assert.equal(m.per_module.shared_cards.prompt_face, "tool-name-mentions:dynamic-memory", "静态资产里无可达提及、可达提及只在动态记忆正文 ⇒ 如实登记（不假装裁掉了不存在的文字）");
  assert.equal(m.per_module.automation_prompts.prompt_face, "section-part:dsh-graph-supervisor-discipline#automation-guidance", "六键段是**部分**裁剪（纪律正文保留）");
  assert.equal(m.per_module.memory.prompt_face, "section:dsh-graph-standing-memory", "记忆段是整段裁剪");
  assert.equal(
    m.per_module.attachments.prompt_face,
    "role-prompt:collector",
    "附件工具名只在 collector 角色的档案与派发提示词里 ⇒ 如实登记为角色面（关闭后该**档案自适应**、角色仍可派发）",
  );
  assert.deepEqual(m.per_module.attachments.roles, ["collector"], "attachments ⇒ 只有 collector 的档案会被自适应（如实登记，不是声称裁了所有角色）");
  for (const id of HARNESS_MODULE_IDS) {
    assert.deepEqual(
      m.per_module[id].roles,
      rolesAdaptedByModule(id),
      `${id} 的 roles 必须来自 core 单点真源 rolesAdaptedByModule（宿主不另抄一份映射）`,
    );
  }
  // 空工具集 / 无角色提及的模块：如实登记为「不影响任何角色档案」
  for (const id of ["tags", "shared_cards", "automation_prompts"] as const) {
    assert.deepEqual(m.per_module[id].roles, [], `${id} 不在任何角色档案里 ⇒ roles 必须为空（不假装裁了角色面）`);
  }
  // 交互面冻结：五模块全关**不阻断任何角色派发**（含 collector——它随 attachments 自适应，而非被拒派发）；
  // 受管工具名与自适应后的 requiredTools 必须不相交（越界收紧必红）。
  const allManaged = new Set(Object.values(MODULE_TOOL_NAMES).flat() as string[]);
  const allOff = resolveModuleSwitches({ modules: Object.fromEntries(HARNESS_MODULE_IDS.map((k) => [k, false])) });
  for (const role of ["supervisor", "executor", "summarizer", "reviewer", "collector", "pm"] as SubagentRole[]) {
    const blocked = moduleAwareRoleProfile(role, allOff).requiredTools.filter((t) => allManaged.has(t));
    assert.deepEqual(blocked, [], `模块开关不得阻断 ${role} 的派发（自适应后 requiredTools 与受管工具名必须不相交）`);
    const d = diagnoseDispatchCapability(role, "standard", { available: (n: string) => !allManaged.has(n) }, allOff);
    assert.equal(d.ok, true, `${role} 在五模块全关时仍必须可派发（缺能力时先补组合/工具再派发），实际 message=${String(d.message)}`);
  }
});

// ---------------------------------------------------------------------------
// ⑥ GUI：「模块」页签（前后端键集同源 / i18n 对称 / 稀疏提交 / 写回 actor）
// ---------------------------------------------------------------------------

const CLIENT_DIR = join(HOST, "lib", "client");
const MODAL_SRC = readFileSync(join(CLIENT_DIR, "settings-modal.js"), "utf8");
const I18N_SRC = readFileSync(join(CLIENT_DIR, "i18n.js"), "utf8");

/** vm 载入 settings-modal.js 的 `normalizeSettingsDraft…SettingsModal` 切片（与 g479 渲染测试同一切片口径）。
 *  该切片在**空 sandbox** 里可求值（已实证），故此处只需取出模块开关相关的常量与稀疏提交函数。 */
function loadClientSlice(): any {
  const a = MODAL_SRC.indexOf("function normalizeSettingsDraft(");
  const b = MODAL_SRC.indexOf("function SettingsModal(");
  assert.ok(a > 0 && b > a, "settings-modal.js 缺少归一化段或 SettingsModal（切片锚点漂移）");
  const sandbox: any = {};
  vm.runInNewContext(
    `${MODAL_SRC.slice(a, b)}\n;globalThis.__c = { buildSettingsPatch, MODULE_SWITCH_KEYS, MODULE_LABEL_KEYS, MODULE_HINT_KEYS, SETTINGS_TAB_KEYS };`,
    sandbox,
  );
  return sandbox.__c;
}

function loadI18nDicts(): { zh: Record<string, string>; en: Record<string, string> } {
  const sandbox: any = { React: {} };
  vm.runInNewContext(`${I18N_SRC}\n;globalThis.__d = { zh: zh, en: en };`, sandbox);
  return sandbox.__d;
}

test("g-480 ⑥：GUI 模块页签 —— 前后端键集同源、i18n zh/en 对称（en 零 CJK）、稀疏提交只发变化的模块叶子", () => {
  const c = loadClientSlice();
  // 注意：vm 跨 realm 取值 ⇒ 一律展开成本地数组再比（strict deepEqual 会比较原型）
  assert.deepEqual([...c.MODULE_SWITCH_KEYS], [...HARNESS_MODULE_IDS], "前端 MODULE_SWITCH_KEYS 与 core HARNESS_MODULE_IDS 同源同序（副本漂移即红）");
  assert.ok(c.SETTINGS_TAB_KEYS.includes("modules"), "模块开关归属 modules 页签（g-479 页签结构内）");
  assert.deepEqual(Object.keys(c.MODULE_LABEL_KEYS), [...c.MODULE_SWITCH_KEYS], "标签键与开关一一对应");
  assert.deepEqual(Object.keys(c.MODULE_HINT_KEYS), [...c.MODULE_SWITCH_KEYS], "说明键与开关一一对应");

  // i18n：模块相关键 zh/en 齐备、en 零 CJK、zh 为中文文案
  const d = loadI18nDicts();
  const moduleKeys = [
    "settings.tab.modules",
    "settings.modulesNote",
    "settings.modulesScopeNote",
    ...Object.values(c.MODULE_LABEL_KEYS),
    ...Object.values(c.MODULE_HINT_KEYS),
  ] as string[];
  for (const k of moduleKeys) {
    assert.ok(typeof d.zh[k] === "string" && d.zh[k].length > 0, `zh 缺模块文案键 ${k}`);
    assert.ok(typeof d.en[k] === "string" && d.en[k].length > 0, `en 缺模块文案键 ${k}（两语必须对称）`);
    assert.ok(!HAN.test(d.en[k]), `en 的 ${k} 不得含中日韩全角字符：${d.en[k]}`);
    assert.ok(HAN.test(d.zh[k]), `zh 的 ${k} 应当是中文文案：${d.zh[k]}`);
  }

  // 稀疏提交（与 agent_teams 同口径）：模块叶子只在「草稿是布尔」或「基线是布尔而草稿回 null」时进 payload
  const allNull = { modules: { tags: null, memory: null, shared_cards: null, automation_prompts: null, attachments: null } };
  assert.equal(c.buildSettingsPatch(allNull, allNull).modules, undefined, "未配置 + 未动 ⇒ 不提交 modules（不把「未配置」实体化进 project.yaml）");
  const offTags = { modules: { ...allNull.modules, tags: false } };
  assert.deepEqual({ ...c.buildSettingsPatch(offTags, allNull).modules }, { tags: false }, "显式关闭 ⇒ 只提交该叶子（其余模块连键都不进 payload）");
  assert.equal(c.buildSettingsPatch(offTags, offTags).modules, undefined, "同态不产生假脏（不重写他人段落）");
  assert.deepEqual({ ...c.buildSettingsPatch(allNull, offTags).modules }, { tags: null }, "false → 未配置（显式清空回默认开启）⇒ 提交 null");
  assert.equal(c.buildSettingsPatch({ modules: { ...allNull.modules, memory: "off" } }, allNull).modules, undefined, "畸形值归一为未配置 ⇒ 无差异 ⇒ 不提交（绝不回填成「关闭」）");

  // 写侧：GUI 路由 actor 恒为 human:gui（可信身份），且 POST 必先过 settingsPostSchema
  const routeSrc = readFileSync(join(HOST, "index.js"), "utf8");
  const routeAt = routeSrc.indexOf('path: "/api/dsh-graph/settings"');
  assert.ok(routeAt > 0, "设置路由 /api/dsh-graph/settings 必须存在");
  const route = routeSrc.slice(routeAt, routeAt + 1600);
  assert.match(route, /validateSchema\(body, settingsPostSchema\)/, "POST 必须先过 settingsPostSchema（未知键/非布尔 ⇒ 400）");
  assert.match(route, /writeProjectConfig\(r, body, "human:gui"\)/, "写回 actor 恒为 human:gui（不由请求体自报）");

  const { root } = makeWorkspace("");
  init(root);
  writeProjectConfig(root, { modules: { tags: false } }, "human:gui");
  const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = events[events.length - 1];
  assert.equal(last.event, "project.config_set", "写入必须有可追溯事件");
  assert.equal(last.actor, "human:gui", "事件 actor 为 GUI 身份");
  assert.deepEqual(last.details.fields, ["modules.tags"], "事件点名被改的叶子");
  assert.match(readFileSync(join(root, "project.yaml"), "utf8"), /modules:\n  tags: false/, "落盘形态为行级 modules 段");
});

// ---------------------------------------------------------------------------
// ⑧ 负向对照：同一组不变式在**变异体**上必须报红
// ---------------------------------------------------------------------------

/** 不变式 A：deny 映射表 ≡ 真实注册清单里的受管命名面（漏一个 / 多一个 / 重复归属 ⇒ 非空）。 */
function mappingProblems(map: Record<string, readonly string[]>, real: string[]): string[] {
  const problems: string[] = [];
  const realSet = new Set(real);
  const seen = new Map<string, string>();
  for (const [id, names] of Object.entries(map)) {
    for (const n of names) {
      if (!realSet.has(n)) problems.push(`${id} 的 ${n} 不在真实注册清单里`);
      if (seen.has(n)) problems.push(`${n} 同时归属 ${seen.get(n)} 与 ${id}`);
      seen.set(n, id);
    }
  }
  const expected: Record<string, string[]> = {
    tags: real.filter((n) => n === "graph_set_goal_tags"),
    memory: real.filter((n) => n.startsWith("graph_memory_")),
    shared_cards: real.filter((n) => /_shared_cards?$/.test(n) || n.startsWith("graph_convert_card_to_")),
    attachments: real.filter((n) => n.startsWith("graph_store_attachment") || n.startsWith("graph_delete_attachment")),
  };
  for (const [id, want] of Object.entries(expected)) {
    const got = [...(map[id] ?? [])].sort();
    const w = [...want].sort();
    if (got.join(",") !== w.join(",")) problems.push(`${id} 映射表 ${got.join("/") || "(空)"} ≠ 命名面 ${w.join("/") || "(空)"}`);
  }
  if ((map.automation_prompts ?? []).length) problems.push("automation_prompts 是纯提示词面模块，不应有受管工具");
  if (seen.has("graph_add_card")) problems.push("shared_cards 不得越界管理目标自有卡片工具 graph_add_card");
  return problems;
}

/** 不变式 B：`settingsPostSchema` 的 modules 段裁决（只收真布尔/null，拒未知键与非布尔）。 */
function modulesSchemaProblems(validate: (v: unknown, s: unknown) => { valid: boolean }, schema: unknown): string[] {
  const cases: Array<[unknown, boolean]> = [
    [{ modules: { tags: true } }, true],
    [{ modules: { tags: false, memory: null } }, true],
    [{ modules: {} }, true],
    [{ modules: { automation_prompts: false, attachments: true, shared_cards: null } }, true],
    [{ modules: { nope: true } }, false],
    [{ modules: { tags: "false" } }, false],
    [{ modules: { tags: 1 } }, false],
    [{ modules: [] }, false],
  ];
  const problems: string[] = [];
  for (const [value, want] of cases) {
    const got = validate(value, schema).valid;
    if (got !== want) problems.push(`schema 对 ${JSON.stringify(value)} 的裁决 ${got} ≠ 期望 ${want}`);
  }
  return problems;
}

/** 不变式 C：53 红线（注册面不多不少、无重名、受管工具都在注册面里）。 */
function registrationProblems(registered: string[], map: Record<string, readonly string[]>): string[] {
  const problems: string[] = [];
  if (registered.length !== 53) problems.push(`注册数 ${registered.length} ≠ 53（判据 4 红线）`);
  if (registered.length !== new Set(registered).size) problems.push("注册清单有重复项");
  const set = new Set(registered);
  for (const names of Object.values(map)) for (const n of names) if (!set.has(n)) problems.push(`${n} 未被无条件注册`);
  return problems;
}

/** 漂移场景量测：宿主把 `graph_memory_remove` 挪出全局层（插件**仍注册**它）。
 *  期望：候选被作用域过滤 ⇒ 其余 3 个真被裁掉、零错误留痕。 */
function driftTrim(applyFn: (ctx: any, cfg: any) => void, ws: string) {
  const h = makeHostMock(ws, { hideGlobal: ["graph_memory_remove"] });
  applyFn(h.ctx, {});
  const a = makeAgent(h, { id: "s-drift", own: ["graph_memory_remove"] });
  const notes = captureStderr(() => { for (const fn of h.events.get("agent/created") ?? []) fn({ agent: a }); });
  return { trimmed: 53 - schemaNames(a).length, deny: h.restrictCalls[0]?.deny ?? [], notes, registered: h.registered.length };
}

test("g-480 ⑧：负向对照 —— 四条变异（漏工具 / 去作用域过滤 / 放宽 schema / 注册少一个）都必须报红", async () => {
  const { ws } = makeWorkspace("modules:\n  memory: false\n");
  const real = registeredToolNames();

  // —— 正向：真输入下三条不变式全绿，真 dist 的漂移裁剪确实发生 ——
  assert.deepEqual(mappingProblems(MODULE_TOOL_NAMES, real), []);
  assert.deepEqual(modulesSchemaProblems(validateSchema as any, settingsPostSchema), []);
  const hOn = makeHostMock(ws);
  applyHost(hOn);
  assert.deepEqual(registrationProblems(hOn.registered, MODULE_TOOL_NAMES), []);
  const good = driftTrim((ctx, cfg) => apply(ctx, cfg), ws);
  assert.deepEqual([good.trimmed, good.deny.length, good.notes], [3, 3, ""], "真 dist：漂移候选被过滤、3 个工具真被裁掉、零错误留痕");
  assert.equal(good.registered, 53, "漂移不影响注册面");

  // —— 变异 ①：映射表漏一个受管工具（模拟「漏 deny 映射」）——
  const leaked: Record<string, readonly string[]> = {
    ...MODULE_TOOL_NAMES,
    memory: MODULE_TOOL_NAMES.memory.filter((n) => n !== "graph_memory_recall"),
  };
  assert.ok(mappingProblems(leaked, real).length > 0, "漏一个受管工具必须报红");

  // —— 变异 ④：注册面少一个工具（夹具层：宿主拒收一个注册）——
  const hRefuse = makeHostMock(ws, { refuseRegister: ["graph_set_goal_tags"] });
  applyHost(hRefuse);
  assert.ok(registrationProblems(hRefuse.registered, MODULE_TOOL_NAMES).length > 0, "注册面少一个工具必须报红（53 红线）");

  // —— 变异 ②/③：在 dist **私有副本**上真实变异后实跑（不碰真 dist）——
  const copy = mkdtempSync(join(TMP_ROOT, "g480-mut-"));
  try {
    cpSync(DIST, copy, { recursive: true });
    const idxPath = join(copy, "index.js");
    const schPath = join(copy, "core", "schema.js");
    const idx = readFileSync(idxPath, "utf8");
    const sch = readFileSync(schPath, "utf8");
    const guard = "at.get(name) !== undefined && at.get(name, agent) !== undefined";
    const boolAnchor = 'tags: { type: "boolean", nullable: true },';
    assert.equal(idx.split(guard).length - 1, 1, "变异锚点 1（作用域过滤的全局视图判定）必须在 dist/index.js 里恰好出现一次");
    assert.equal(sch.split(boolAnchor).length - 1, 1, "变异锚点 2（modules.tags 的布尔约束）必须在 dist/core/schema.js 里恰好出现一次");
    // 两次变异都必须在**首次 import 之前**落盘（ESM 模块缓存）
    writeFileSync(idxPath, idx.replace(guard, "at.get(name, agent) !== undefined"));
    writeFileSync(schPath, sch.replace(boolAnchor, 'tags: { type: "string", nullable: true },'));

    const mutated = await import(pathToFileURL(idxPath).href);
    const bad = driftTrim((ctx, cfg) => mutated.apply(ctx, cfg), ws);
    assert.equal(bad.trimmed, 0, "去掉全局视图判定 ⇒ restrict 抛 unknown global tool ⇒ 被吞掉 ⇒ 该会话**零裁剪**（过滤器缺失的代价）");
    assert.match(bad.notes, /模块裁剪跳过[\s\S]*unknown global tool/, "留痕点名真因（可诊断，不静默）");
    assert.equal(bad.registered, 53, "裁剪失效不改变注册面");

    const mutatedSchema: any = await import(pathToFileURL(schPath).href);
    assert.ok(
      modulesSchemaProblems(mutatedSchema.validateSchema, mutatedSchema.settingsPostSchema).length > 0,
      "放宽 modules.tags 类型（boolean → string）必须报红",
    );
  } finally {
    const resolved = resolve(copy);
    assert.ok(resolved.startsWith(resolve(TMP_ROOT) + sep), `拒绝删除 TMP_ROOT 之外的路径：${resolved}`);
    rmSync(resolved, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑤ 数据安全：关闭 = 只隐藏入口，绝不删数据（附件仍可读、校验仍通过）
// ---------------------------------------------------------------------------

test("g-480 ⑤：attachments 关闭后既有 @att/ 资产仍可读、引用仍可解析、graph_validate 不因开关报错", async () => {
  const { ws, root } = makeWorkspace("modules:\n  attachments: false\n  shared_cards: false\n  tags: false\n");
  init(root);
  const cfg = readProjectConfig(root);
  const off = resolveModuleSwitches(cfg);
  assert.equal(off.switches.attachments.on, false, "配置读回为关闭");

  // 关闭状态下**写入仍在**（写路径是 core 的，不受模块开关门禁；开关只做可见面裁剪）
  const name = storeAttachment(root, { name: "g480-note.txt", content: "模块关闭不删数据", actor: "t" });
  const goal = createGoal(root, { title: "g-480 数据安全", actor: "t" });
  appendGoalComment(root, goal, "见 @att/" + name + " 与 @att/" + name, "t");
  const readBack = readAttachment(root, name);
  assert.equal(readBack.buffer.toString("utf8"), "模块关闭不删数据", "关闭模块后既有附件仍逐字节可读");
  assert.deepEqual(parseAttachmentRefs("见 @att/" + name + " 与 @att/" + name), [name], "引用仍可解析（同名去重）");

  // 目标正文里的 @att/ 引用仍解析到存在的文件（读侧不受开关影响）
  const goalFile = [join(root, "backlog", `${goal}.md`), join(root, "goals", goal, "goal.md")].find((p) => existsSync(p));
  assert.ok(goalFile, "目标文件必须存在（backlog 单文件或 goals/ 目录形态）");
  const goalText = readFileSync(goalFile as string, "utf8");
  assert.ok(goalText.includes("@att/" + name), "目标正文里的 @att/ 引用仍在");
  assert.ok(existsSync(join(attachmentsDir(root), name)), "@att/ 物理文件仍在");
  assert.deepEqual(attachmentProblems(root), [], "附件面自检无问题（孤立/缺失引用都没有）");
  assert.deepEqual(validate(root), [], "graph_validate 全量不变式校验通过（模块开关不引入违规）");

  // 真裁剪仍然生效：附件/标签工具从可见面消失（隐藏入口 ≠ 删数据）
  const h = makeHostMock(ws);
  applyHost(h);
  const a = makeAgent(h, { id: "s-data" });
  for (const fn of h.events.get("agent/created") ?? []) fn({ agent: a });
  const visible = schemaNames(a);
  for (const n of ["graph_store_attachment", "graph_delete_attachment", "graph_set_goal_tags", ...MODULE_TOOL_NAMES.shared_cards]) {
    assert.ok(!visible.includes(n), `${n} 应从可见面消失`);
  }
  assert.ok(visible.includes("graph_add_card"), "目标自有卡片工具不受 shared_cards 关闭影响（边界如实）");
  assert.equal(readAttachment(root, name).buffer.toString("utf8"), "模块关闭不删数据", "裁剪后仍可读");

  // —— 判据③点名的「卡片段」边界如实冻结 ——
  // 派发提示词里的**已收集卡片成果段**（formatHarvestedCardsSection）只出现 `@att/` **数据引用**，
  // 从不出现任何受管工具名 ⇒ 该段**没有可裁的工具名提及**（无需裁剪，也不该被裁剪：@att/ 引用必须保持可读）。
  // 目标自有卡片工具（graph_add_card/graph_fill_card）不归属任何模块（见 MODULE_TOOL_NAMES 边界注释）。
  const cardGoal = createGoal(root, { title: "g-480 卡片段边界", version: "v-t", actor: "t" });
  const card = addCard(root, cardGoal, { title: "g480 边界卡", kind: "text", actor: "t", scope: "goal" });
  fillCard(root, cardGoal, card, { text: `证据见 @att/${name}`, summary: "边界", by: "human:a", actor: "t" });
  const cardsSec = formatHarvestedCardsSection(root, cardGoal);
  assert.ok(cardsSec.includes(`@att/${name}`), "卡片段仍渲染 @att/ 数据引用（关闭 attachments 不影响可读性）");
  const managed = moduleToolNames();
  for (const n of managed) assert.ok(!cardsSec.includes(n), `卡片段不得出现受管工具名 ${n}（无提及即无裁剪面）`);
  assert.ok(!cardsSec.includes("graph_add_card"), "卡片段不出现目标自有卡片工具名（边界如实）");
  // 全开/关闭两态下该段逐字节相同（与模块开关无关，结构上不可被误裁）
  writeProjectConfig(root, { modules: { attachments: true, shared_cards: true, tags: true } }, "t");
  assert.equal(formatHarvestedCardsSection(root, cardGoal), cardsSec, "模块开关不改变卡片段一个字节");
});

// ---------------------------------------------------------------------------
// ⑨ att-002 裁决①：关闭模块 ⇒ **角色档案自适应**（core 单点真源），绝不拒绝派发
// ---------------------------------------------------------------------------

test("g-480 ⑨：moduleAwareRoleProfile —— 单点真源、全开同一对象、关闭逐项剔除（工具面 + persona 文本面）", () => {
  const offAttach = resolveModuleSwitches({ modules: { attachments: false } });
  const base = getRoleProfile("collector");
  const adapted = moduleAwareRoleProfile("collector", offAttach);
  // 工具面
  assert.deepEqual(base.requiredTools, ["graph_fill_card", "graph_store_attachment", "read"], "改坏基线即红：collector 的必需工具含附件工具");
  assert.deepEqual(adapted.requiredTools, ["graph_fill_card", "read"], "关闭 attachments ⇒ requiredTools 去掉附件工具（不再算必需）");
  assert.ok((base.allowedTools.standard ?? []).includes("graph_store_attachment"), "基线 standard 白名单含附件工具");
  assert.ok(!(adapted.allowedTools.standard ?? []).includes("graph_store_attachment"), "关闭 ⇒ standard 白名单同步剔除");
  assert.ok(!(adapted.allowedTools.minimal ?? []).includes("graph_store_attachment"), "关闭 ⇒ minimal 白名单同步剔除");
  // persona 文本面（persona 单一真源 = disciplineLines）
  const baseText = [base.description, base.disciplineTitle, ...base.disciplineLines].join("\n");
  const adaptedText = [adapted.description, adapted.disciplineTitle, ...adapted.disciplineLines].join("\n");
  assert.ok(baseText.includes("graph_store_attachment"), "基线 persona 文本里确有附件工具名（否则本用例失去意义）");
  assert.ok(!adaptedText.includes("graph_store_attachment"), "关闭 ⇒ persona 文本面不得再提及附件工具名（stripModuleToolMentions 单点收口）");
  assert.equal(adapted.disciplineLines.length, base.disciplineLines.length, "自适应只**去掉含工具名的整行**，不得改变行数（不重排、不合并）");
  assert.ok(!adaptedText.includes("graph_delete_attachment"), "同模块的另一个受管工具名一并剔除");
  assert.equal(typeof adapted.readOnly, "boolean", "非文本/非工具字段（readOnly 等）原样透传");
  assert.equal(adapted.readOnly, base.readOnly);
  assert.equal(adapted.name, base.name);
  // 全开 / 未配置 / 读失败口径 ⇒ **同一对象**（零拷贝 ⇒ 未配置路径逐字节一致，diff=0）
  for (const s of [null, undefined, resolveModuleSwitches(null), resolveModuleSwitches({})]) {
    assert.equal(moduleAwareRoleProfile("collector", s), base, "全开/未配置 ⇒ 返回原档案对象（不是拷贝，逐字节一致）");
  }
  // 只裁「该模块自己的」工具：其它模块工具名与无关行原样保留
  assert.ok(adaptedText.includes("graph_fill_card"), "同角色的**非受管**工具名不受影响");
  assert.ok(!adaptedText.includes("3."), "被剔除的是**含工具名的整行**（附件安全条目整行消失，不做词语替换/改写）");
  assert.equal(base.disciplineLines.length, 5, "改坏基线即红：collector 有 5 条纪律");
  assert.equal(adapted.disciplineLines[2], "", "被剔除行变成空串（**行数与顺序不变**，其余条目逐字保留）");
  for (const keep of ["1. ", "2. ", "4. ", "5. "]) {
    assert.ok(adaptedText.includes(keep), `其余纪律条目 ${keep} 必须逐字保留（只删含工具名的行）`);
  }
  assert.deepEqual(
    adapted.disciplineLines.filter((l) => l !== ""),
    base.disciplineLines.filter((l) => !l.includes("graph_store_attachment")),
    "保留集必须恰为「不含受管工具名的行」（单一真源，不做额外改写）",
  );
  // 未知角色安全回退（与 getRoleProfile 同口径）
  assert.deepEqual(moduleAwareRoleProfile("nope" as SubagentRole, offAttach).requiredTools, moduleAwareRoleProfile("executor", offAttach).requiredTools);
});

test("g-480 ⑨：rolesAdaptedByModule —— 由真实档案 diff 派生（不是第二份映射）；schema_hints 与之同源", () => {
  // 只有档案里**真的**出现受管工具名的角色才会被列出
  assert.deepEqual(rolesAdaptedByModule("attachments"), ["collector"], "附件工具名只在 collector 档案里");
  for (const id of ["tags", "shared_cards"] as const) {
    assert.deepEqual(rolesAdaptedByModule(id), [], `${id} 的工具名不在任何角色档案里 ⇒ 空清单（不假装裁了角色面）`);
  }
  assert.deepEqual(rolesAdaptedByModule("automation_prompts"), [], "空工具集 ⇒ 无角色档案受影响");
  // 自洽性（逐模块、逐角色）：清单里 ⟺ 档案形状真的变了 —— 单一真源，不新增平行真源
  const ALL_ROLES: SubagentRole[] = ["supervisor", "executor", "collector", "reviewer", "pm", "summarizer"];
  for (const id of HARNESS_MODULE_IDS) {
    const off = resolveModuleSwitches({ modules: { [id]: false } });
    const listed = new Set(rolesAdaptedByModule(id));
    for (const role of ALL_ROLES) {
      const changed = JSON.stringify(getRoleProfile(role)) !== JSON.stringify(moduleAwareRoleProfile(role, off));
      assert.equal(listed.has(role), changed, `${id}/${role}：清单必须与真实档案形状变化严格一致`);
    }
  }
  // 未知名模块（防御）：空清单，不抛错
  assert.deepEqual(rolesAdaptedByModule("nope" as any), [], "未知模块安全返回空清单");
});

test("g-480 ⑨：collector 派发提示词面随模块自适应 —— 关闭剔除附件工具提及，全开**同一字符串**", () => {
  const { root } = makeWorkspace("");
  init(root);
  const goal = createGoal(root, { title: "g-480 提示词投影", version: "v-t", actor: "t" });
  const card = addCard(root, goal, { title: "g480 投影卡", kind: "text", actor: "t", scope: "goal" });
  const off = resolveModuleSwitches({ modules: { attachments: false } });
  // 两种读法必须同源（宿主用已解析的 `disabledTools`；纯函数入口接受原始 config）
  assert.deepEqual(off.disabledTools, disabledModuleTools({ modules: { attachments: false } }), "已解析开关与纯函数入口必须给出同一禁用清单");
  for (const lang of ["zh", "en"] as const) {
    const prompt = formatCollectPrompt(root, goal, card, "收集这个", lang);
    assert.ok(prompt.includes("graph_store_attachment"), `${lang} 基线提示词里确有附件工具名（否则本用例失去意义）`);
    const trimmed = stripModuleToolMentions(prompt, off.disabledTools);
    assert.ok(!trimmed.includes("graph_store_attachment"), `${lang} 关闭 attachments ⇒ 派发提示词不得再提及附件工具`);
    assert.ok(!trimmed.includes("graph_delete_attachment"), `${lang} 同模块另一工具名一并剔除`);
    assert.ok(trimmed.includes("@att/"), `${lang} @att/ 引用行**不含工具名** ⇒ 必须原样保留（数据可读性不受裁剪影响）`);
    assert.ok(trimmed.includes("graph_fill_card"), `${lang} 非受管工具（graph_fill_card）不受影响`);
    // 全开：stripModuleToolMentions 必须返回**同一字符串**（未配置/全开路径逐字节一致）
    const same = stripModuleToolMentions(prompt, resolveModuleSwitches(null).disabledTools);
    assert.equal(same, prompt, `${lang} 全开 ⇒ 返回同一字符串（diff=0）`);
    assert.equal(stripModuleToolMentions(prompt, []), prompt, `${lang} 空禁用清单 ⇒ 同一字符串`);
  }
});

test("g-480 ⑨：宿主的三个派发点全部走同一自适应口径（无一处漏传 switches / 漏做提示词投影）", () => {
  const src = readFileSync(join(HOST, "index.js"), "utf8");
  // ① 能力自检：唯一入口 capabilityBlock 必须把模块开关传进 diagnoseDispatchCapability
  const capSites = [...src.matchAll(/diagnoseDispatchCapability\(/g)].map((m) => src.slice(m.index!, m.index! + 400));
  assert.equal(capSites.length, 1, "diagnoseDispatchCapability 只允许在 capabilityBlock 一处调用（漏改/多改即红）");
  assert.ok(capSites[0].includes("readModuleSwitchesForRoot("), "能力自检必须按本 board root 的模块开关自适应（否则工具面裁了、自检却点名缺工具）");
  // ② 工具过滤：**每一个** toolFilterForRole 调用点都必须传第 4 参数（新增派发点漏传即红）
  const filterSites = [...src.matchAll(/toolFilterForRole\(/g)].map((m) => src.slice(m.index!, m.index! + 260));
  assert.ok(filterSites.length >= 5, `toolFilterForRole 调用点数应 ≥5（实得 ${filterSites.length}）`);
  filterSites.forEach((s, i) => assert.ok(s.includes("readModuleSwitchesForRoot("), `toolFilterForRole 第 ${i + 1} 处必须传模块开关`));
  for (const role of ['"executor"', '"collector"', '"reviewer"', '"summarizer"']) {
    assert.ok(filterSites.some((s) => s.includes(role)), `真实派发角色 ${role} 的工具过滤点必须存在且已接线`);
  }
  // ③ 派发提示词：**两个** collector 入口（工具面 + REST 面）都必须做同一投影
  const promptSites = [...src.matchAll(/formatCollectPrompt\(/g)].map((m) => src.slice(Math.max(0, m.index! - 120), m.index! + 400));
  assert.equal(promptSites.length, 2, `formatCollectPrompt 调用点应恰为 2（工具面 + REST 面），实得 ${promptSites.length}`);
  promptSites.forEach((s, i) => {
    assert.ok(s.includes("stripModuleToolMentions("), `第 ${i + 1} 个 collector 入口必须用 stripModuleToolMentions 做提示词投影`);
    assert.ok(s.includes("readModuleSwitchesForRoot("), `第 ${i + 1} 个 collector 入口必须读取本 root 的模块开关`);
  });
  // ④ 提示词面元数据不再声称「拒绝派发」（语义已由裁决改写为「档案自适应」）
  const faceAt = src.indexOf("const MODULE_PROMPT_FACE = {");
  assert.ok(faceAt > 0, "MODULE_PROMPT_FACE 必须存在（提示词面元数据真源）");
  const faceComment = src.slice(Math.max(0, faceAt - 1800), faceAt);
  assert.ok(faceComment.includes("档案自适应"), "注释必须如实登记新语义：档案随模块自适应");
  assert.ok(faceComment.includes("照常可派发"), "注释必须明示「关闭模块不拒绝派发」");
  assert.ok(faceComment.includes("moduleAwareRoleProfile"), "注释必须点名 core 单点真源（宿主只消费、不另抄一份映射）");
  const refusalLines = faceComment.split("\n").filter((l) => l.includes("拒绝派发"));
  assert.ok(refusalLines.length > 0, "注释必须显式说明为何**不再**用「拒绝派发」当裁剪手段（留下裁决痕迹）");
  for (const l of refusalLines) assert.ok(l.includes("不再"), `不得残留「关闭模块 ⇒ 拒绝派发」的旧语义：${l.trim()}`);
});


// ---------------------------------------------------------------------------
// ⑩ att-002 裁决②：宿主**不支持真裁剪**时如实显示一行（支持时该行不存在）
// ---------------------------------------------------------------------------

const TRIM_HINT_KEY = "settings.modulesTrimUnsupported";

/** 真实渲染 settings-modal（与 g479 渲染夹具同口径）：按 useState 槽位序覆写初值。
 *  槽位 11 = `trimSupported`（新增状态**追加**在既有 0..10 之后，故既有夹具语义不受影响）。 */
function renderModulesTab(trimSupportedValue: any, dict: Record<string, string>): { nodes: any[] } {
  const h = (type: any, props: any, ...children: any[]) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c: any) => c !== null && c !== undefined && c !== false),
  });
  const overrides: any[] = [false, {}, false, null, null, "modules", "/abs/project.yaml", 15, null, { status: "loading" }, null, trimSupportedValue];
  let idx = 0;
  const sandbox: any = {
    console,
    h,
    dgOverlay: (props: any, ...children: any[]) => h("div", props, ...children),
    settingsModalModeInstanceSeq: 0,
    dgT: (k: string) => dict[k] ?? k,
    S: new Proxy({}, { get: () => ({}) }),
    graphUrl: (u: string) => u,
    gConnectionApi: null,
    loadHostCatalog: async () => ({ status: "unavailable" }),
    openHostPath: async () => ({ opened: false }),
    copyText: async () => true,
    showToast: () => {},
    openErrorText: (e: any) => String(e),
    getRefreshInterval: () => 15,
    setRefreshInterval: () => 15,
    MIN_REFRESH_INTERVAL: 5,
    useLocaleRevision: () => {},
    useBackdropClose: () => ({}),
    useLiveDisplayEnabled: () => false,
    window: { confirm: () => true },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    React: {
      createElement: h,
      useRef: (init: any) => ({ current: init }),
      useState: (init: any) => {
        const i = idx++;
        const v = i < overrides.length ? overrides[i] : (typeof init === "function" ? init() : init);
        return [v, () => {}];
      },
      useEffect: () => {},
    },
  };
  const a = MODAL_SRC.indexOf("function normalizeSettingsDraft(");
  const b = MODAL_SRC.indexOf("function SettingsModal(");
  assert.ok(a > 0 && b > a, "settings-modal.js 切片锚点漂移");
  vm.runInNewContext(`${MODAL_SRC.slice(a, b)}\n${MODAL_SRC.slice(b)}\n;globalThis.__m = SettingsModal;`, sandbox);
  const tree = sandbox.__m({ onClose: () => {}, onSaved: () => {} });
  const nodes: any[] = [];
  (function walk(n: any) {
    if (!n || typeof n !== "object") return;
    nodes.push(n);
    for (const c of n.children ?? []) walk(c);
  })(tree);
  return { nodes };
}

const trimHintNodes = (nodes: any[]): any[] => nodes.filter((n) => n?.props?.["data-dg-module-trim-unsupported"] === "1");

test("g-480 ⑩：trim_supported 三段真值 —— 能力缺失（无 ctx.on / 无 tools.restrict）⇒ false；具备 ⇒ true", () => {
  const { ws } = makeWorkspace("modules:\n  attachments: false\n");
  const read = (h: HostMock): any => {
    applyHost(h);
    const def = h.registeredDefs.get("graph_get_settings");
    assert.ok(def?.execute, "graph_get_settings 必须已注册且可执行");
    return def.execute({}, { agent: { session: { header: { cwd: ws } } } });
  };
  const ok = read(makeHostMock(ws));
  assert.equal(ok.trim_supported, true, "宿主同时提供 agent/created 与 tools.restrict ⇒ trim_supported=true（真裁剪生效）");
  const noOn = read(makeHostMock(ws, { on: false }));
  assert.equal(noOn.trim_supported, false, "无 ctx.on ⇒ 不支持真裁剪（如实下发 false，不得谎报 true）");
  const noRestrict = read(makeHostMock(ws, { restrict: false }));
  assert.equal(noRestrict.trim_supported, false, "无 tools.restrict ⇒ 不支持真裁剪");
  // 能力缺失时**配置与数据面完全不受影响**（只记录配置）：读到的 modules 段照样回传
  assert.equal(noOn.config.modules.attachments, false, "无真裁剪能力时仍如实回传已记录的配置");
  // 单一探测点：同一次判定同时驱动「监听器是否注册」与「设置状态面下发」，绝不两处各判一次
  const src = readFileSync(join(HOST, "index.js"), "utf8");
  const probe = "const moduleTrimSupported = typeof ctx?.on === \"function\" && typeof ctx?.tools?.restrict === \"function\";";
  assert.equal(src.split(probe).length - 1, 1, "能力探测必须**恰好一处**（两处判定 = 监听器与设置面可能分歧）");
  assert.equal(src.split("trim_supported: moduleTrimSupported").length - 1, 3, "设置状态面三处下发（工具面 + GET + POST）必须同源");
  assert.equal(src.split("if (moduleTrimSupported)").length - 1, 1, "监听器注册必须复用同一探测结果");
});

test("g-480 ⑩：真裁剪不可用时，GUI「模块」页签**只**多渲染一行提示；可用/未知时该行不存在", () => {
  const { zh, en } = loadI18nDicts();
  assert.ok(zh[TRIM_HINT_KEY] && en[TRIM_HINT_KEY], "提示文案键必须 zh/en 双份");
  assert.ok(!HAN.test(en[TRIM_HINT_KEY]), "en 侧零 CJK");
  assert.ok(zh[TRIM_HINT_KEY].includes("不支持真裁剪") && en[TRIM_HINT_KEY].includes("does not support real trimming"), "两侧同义：如实说明本版本不支持真裁剪");
  assert.ok(zh[TRIM_HINT_KEY].includes("不生效") && en[TRIM_HINT_KEY].includes("no effect"), "两侧同义：开关不生效（只记录配置）");
  assert.ok(zh[TRIM_HINT_KEY].includes("记录配置") && en[TRIM_HINT_KEY].includes("recorded only"), "两侧同义：只记录配置");
  const keyRefs = MODAL_SRC.split("MODULE_TRIM_UNSUPPORTED_HINT_KEY").length - 1;
  assert.equal(keyRefs, 2, "常量定义 + 渲染引用各一次（按键取值，不硬编码文案）");
  assert.ok(MODAL_SRC.includes("trimSupported === false"), "只有**明确** false 才渲染该行");
  assert.ok(MODAL_SRC.includes("data.trim_supported === true ? true : data.trim_supported === false ? false : null"), "服务端缺字段 ⇒ null（未知不等于不支持，绝不谎报能力）");

  // 不支持 ⇒ 恰好一行，文案与字典同源
  const bad = trimHintNodes(renderModulesTab(false, zh).nodes);
  assert.equal(bad.length, 1, "不支持真裁剪 ⇒ 「模块」页签恰好多一行提示");
  assert.equal(bad[0].children.filter((c: any) => typeof c === "string").join(""), zh[TRIM_HINT_KEY], "渲染文案必须取自同一 i18n 键");
  const badEn = trimHintNodes(renderModulesTab(false, en).nodes);
  assert.equal(badEn.length, 1, "en 侧同样渲染一行");
  assert.equal(badEn[0].children.filter((c: any) => typeof c === "string").join(""), en[TRIM_HINT_KEY]);
  assert.ok(!HAN.test(badEn[0].children.filter((c: any) => typeof c === "string").join("")), "en 渲染结果零 CJK");

  // 支持 / 未知（缺字段）⇒ **不渲染该行**（真机上默认不可见，不改变既有页面）
  for (const v of [true, null, undefined, "yes"]) {
    assert.equal(trimHintNodes(renderModulesTab(v, zh).nodes).length, 0, `trim_supported=${JSON.stringify(v)} ⇒ 不得渲染该行`);
  }
  // 五个开关照常在（提示行是**追加**一行，不是替换面板）
  const switchKeys: string[] = [...loadClientSlice().MODULE_SWITCH_KEYS];
  const boxes = renderModulesTab(false, zh).nodes
    .map((n) => n?.props?.id)
    .filter((id: any) => typeof id === "string" && id.startsWith("dg-module-"));
  assert.deepEqual([...boxes].sort(), switchKeys.map((k) => `dg-module-${k}`).sort(), "五个模块开关仍在（提示行只追加一行）");
});
