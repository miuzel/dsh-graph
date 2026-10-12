/**
 * g-494 判据机器断言：模块开关的**界面呈现裁剪**（关闭 ⇒ 功能入口从界面**隐藏**，不是置灰）。
 *
 * 负责人 2026-10-12：「功能开关中，关闭的功能对应的功能入口应隐藏，比如记忆模块关闭后，
 * 应隐藏记忆按钮」。本文件是该要求的专用守卫，与 g-480（服务端真裁剪）/ g-479（页签结构）/
 * g-490（设置呈现层）的既有守卫**并存**。
 *
 * 覆盖（逐条对应质量判据）：
 *  ①「关闭 ⇒ 隐藏」：入口**不渲染**（不是 disabled/置灰/保留可点）；以 memory 模块为点名例。
 *  ②「同源一致」：界面判定与服务端真裁剪读**同一份**开关 —— 客户端只消费服务端在**同一份看板
 *     载荷**里下发的 `modules`（由 core `boardPayload` 经同一个 `resolveModuleSwitches` 解析）。
 *  ③「开态零回退 / 再开启恢复」：未配置/全开 ⇒ 入口照常；关闭→再开启 ⇒ 同一判定函数返回可见。
 *  ④「不留孤儿 UI」：入口隐藏时其容器/分隔符/分组标题一并消失；正打开的面板安全关闭。
 *  ⑤「守卫只增不减 + 4 类负例」：四条变异（入口仍在含置灰 / 留空壳 / 再开启未恢复 /
 *     界面与下发状态不一致）都必须报红。
 *
 * 本文件消费的**真实实现**：core/ops.ts 的 `boardPayload`/`moduleSwitchPayload`（服务端下发）与
 * dsh-graph-host/lib/client/module-gate.js（客户端判定，经 vm 求值同一份源码，不是另抄一份）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import {
  HARNESS_MODULE_IDS,
  boardPayload,
  moduleSwitchPayload,
  readProjectConfig,
  resolveModuleSwitches,
} from "../ops.ts";

const repoRoot = join(import.meta.dirname, "../..");
const HOST = join(repoRoot, "dsh-graph-host");
const TMP_ROOT = join(repoRoot, "tmp");
const CLIENT_DIR = join(HOST, "lib/client");

const MODULES = [...HARNESS_MODULE_IDS];

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function tmpDir(tag: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, `g494-${tag}-`));
}

/** 建 workspace + `.dsh-graph/project.yaml`（可**不** init：纯读路径不要求 init）。 */
function makeWorkspace(projectYaml = ""): { ws: string; root: string } {
  const ws = tmpDir("ws");
  const root = join(ws, ".dsh-graph");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "project.yaml"), projectYaml);
  return { ws, root };
}

const readHost = (): string => readFileSync(join(HOST, "index.js"), "utf8");
const readKanban = (): string => readFileSync(join(CLIENT_DIR, "kanban.js"), "utf8");
const readGoalModal = (): string => readFileSync(join(CLIENT_DIR, "goal-modal.js"), "utf8");
const readBuildScript = (): string => readFileSync(join(repoRoot, "scripts/build-client.sh"), "utf8");

/** 把客户端 **真实** module-gate.js 求值出来（同一份源码，不是测试里另抄一份实现）。 */
function loadModuleGate(): any {
  const src = readFileSync(join(CLIENT_DIR, "module-gate.js"), "utf8")
    // 剥掉 ESM export 块（与构建脚本同口径），使脚本可在 vm 里裸求值
    .replace(/\/\/ >>>ESM-EXPORTS-START>>>[\s\S]*?\/\/ <<<ESM-EXPORTS-END<<</, "");
  const sandbox: any = {};
  vm.runInNewContext(
    `${src}\n;globalThis.__m = { MODULE_UI_ENTRIES, MODULE_UI_IDS, moduleEnabled, visibleModuleEntries };`,
    sandbox,
  );
  return sandbox.__m;
}

// ===========================================================================
// ⑤-前置：不变式实现（**同一组不变式**同时用于正向断言与负向变异对照）
// ===========================================================================

type Gate = { MODULE_UI_ENTRIES: Record<string, any[]>; MODULE_UI_IDS: string[]; moduleEnabled: (m: any, id: string) => boolean; visibleModuleEntries: (m: any, c: string) => string[] };

/**
 * 用**替换后的判定函数**重建一个自洽的 gate（关键：`visibleModuleEntries` 必须与
 * `moduleEnabled` **同源**——真实实现里前者闭包调用后者，若只替换后者、前者仍闭包旧实现，
 * 变异就不会传导，负例断言会变成「恒真无鉴别力」的假守卫）。
 *
 * 这里以真实实现的 `MODULE_UI_ENTRIES` / `MODULE_UI_IDS` 为数据源，按真实实现的**同一算法**
 * （容器过滤 + 判定门控 + 声明序遍历）重建派生，确保变异可传导。
 */
function withPredicate(gate: Gate, pred: (m: any, id: string) => boolean): Gate {
  return {
    ...gate,
    moduleEnabled: pred,
    visibleModuleEntries: (m: any, container: string) => {
      const out: string[] = [];
      for (const id of gate.MODULE_UI_IDS) {
        for (const e of gate.MODULE_UI_ENTRIES[id] ?? []) {
          if (e.container !== container) continue;
          if (!pred(m, id)) continue;
          out.push(e.key);
        }
      }
      return out;
    },
  };
}

/** 不变式 A：模块 id 闭集与 core `HARNESS_MODULE_IDS` **同源同序**（副本漂移即红）。 */
function idSetProblems(gate: Gate): string[] {
  const problems: string[] = [];
  const got = [...gate.MODULE_UI_IDS];
  const want = [...HARNESS_MODULE_IDS];
  if (got.join(",") !== want.join(",")) problems.push(`客户端模块 id 闭集 ${got.join("/")} ≠ core ${want.join("/")}`);
  const entryKeys = Object.keys(gate.MODULE_UI_ENTRIES).sort();
  if (entryKeys.join(",") !== [...want].sort().join(",")) problems.push(`入口清单键集 ${entryKeys.join("/")} ≠ core 模块集`);
  return problems;
}

/** 不变式 B（判据 ①）：入口清单里每个「受管辖入口」在模块关闭时**必须不可见**。 */
function hiddenWhenOffProblems(gate: Gate): string[] {
  const problems: string[] = [];
  for (const id of gate.MODULE_UI_IDS) {
    const off = { [id]: false };
    for (const e of gate.MODULE_UI_ENTRIES[id] ?? []) {
      if (gate.moduleEnabled(off, id)) problems.push(`${id} 关闭后仍判为启用（入口 ${e.key} 不会被隐藏）`);
      if (gate.visibleModuleEntries(off, e.container).includes(e.key)) {
        problems.push(`${id} 关闭后入口 ${e.key} 仍在其容器 ${e.container} 的可见清单里`);
      }
    }
  }
  return problems;
}

/** 不变式 C（判据 ③）：**开态零回退**与**再开启完整恢复**（同一函数、同值语义）。 */
function roundTripProblems(gate: Gate): string[] {
  const problems: string[] = [];
  for (const id of gate.MODULE_UI_IDS) {
    for (const e of gate.MODULE_UI_ENTRIES[id] ?? []) {
      // 未配置/缺失 ⇒ 入口在位（老服务端与未配置项目零回退）
      if (!gate.moduleEnabled(undefined, id)) problems.push(`${id} 载荷缺失时被误判为关闭（回退为不可见）`);
      if (!gate.moduleEnabled({}, id)) problems.push(`${id} 载荷无该键时被误判为关闭（回退为不可见）`);
      if (!gate.moduleEnabled({ [id]: null }, id)) problems.push(`${id} 显式 null（未配置）被误判为关闭`);
      if (!gate.moduleEnabled({ [id]: true }, id)) problems.push(`${id} 显式 true 被误判为关闭`);
      if (!gate.visibleModuleEntries({ [id]: true }, e.container).includes(e.key)) problems.push(`${id} 开启时入口 ${e.key} 不可见`);
      // 关闭 → 再开启：同一判定必须完整恢复
      const off = { [id]: false }, back = { [id]: true };
      if (gate.visibleModuleEntries(off, e.container).includes(e.key)
          || !gate.visibleModuleEntries(back, e.container).includes(e.key)) {
        problems.push(`${id} 关闭→再开启未完整恢复入口 ${e.key}`);
      }
    }
  }
  return problems;
}

/** 不变式 D（判据 ②）：界面判定与服务端下发**同源** —— 对每个有界面入口的模块，
 *  界面可见性必须**等于**下发值（不得一侧裁剪、另一侧留入口 / 或反过来更严）。 */
function sameSourceProblems(proto: { modules: Record<string, boolean> }, gate: Gate): string[] {
  const problems: string[] = [];
  for (const id of gate.MODULE_UI_IDS) {
    if ((gate.MODULE_UI_ENTRIES[id] ?? []).length === 0) continue; // 无界面入口的模块不涉及界面裁剪
    const off = proto.modules?.[id] === false;
    if (gate.moduleEnabled(proto.modules, id) === off) {
      problems.push(`服务端下发 ${id}=${proto.modules?.[id]} 与界面判定不一致（一侧裁剪另一侧未裁）`);
    }
  }
  return problems;
}

// ===========================================================================
// ① 核心：关闭 ⇒ 入口隐藏（不是置灰），点名 memory
// ===========================================================================

test("g-494 ①：入口清单与 core 模块闭集同源同序；关闭 ⇒ 受管辖入口一律不可见（点名 memory）", () => {
  const gate = loadModuleGate();
  assert.deepEqual(idSetProblems(gate), [], "模块 id 闭集/清单键集必须与 core HARNESS_MODULE_IDS 同源同序");
  assert.deepEqual(hiddenWhenOffProblems(gate), [], "每个模块关闭时其全部受管辖入口都必须不可见");
  assert.deepEqual(roundTripProblems(gate), [], "开态零回退 + 关闭→再开启完整恢复");

  // 负责人点名的例子：记忆模块关闭 ⇒ 记忆入口隐藏
  const memoryEntries = gate.MODULE_UI_ENTRIES.memory ?? [];
  assert.ok(memoryEntries.some((e: any) => e.key === "memory"), "memory 模块必须登记「记忆」入口");
  assert.equal(gate.moduleEnabled({ memory: false }, "memory"), false, "memory=false ⇒ 记忆入口不可见（隐藏，不是置灰）");
  assert.equal(gate.moduleEnabled({ memory: true }, "memory"), true, "memory=true ⇒ 记忆入口照常可见");
});

test("g-494 ①：客户端各渲染点**按判定结果整条不渲染**（隐藏 = 不产出节点），绝不 disabled/置灰", () => {
  const kanban = readKanban();
  const goalModal = readGoalModal();

  // 记忆按钮：宽档平铺 + 折叠弹层（headPanelRows 即弹层真源）两处都受同一判定门控
  assert.match(kanban, /!moduleEnabled\(mods, "memory"\) \? null : h\("button", \{[\s\S]{0,400}?memory\.title/,
    "记忆按钮必须在隐藏时整条不渲染（宽档平铺）");
  assert.match(kanban, /moduleEnabled\(mods, "memory"\)\s*\n?\s*\? \{ key: "memory"/,
    "折叠弹层的记忆入口同样受同一判定门控（两处同源）");
  // 知识库（共享卡片）入口
  assert.match(kanban, /!moduleEnabled\(mods, "shared_cards"\) \? null : h\("button", \{[\s\S]{0,300}?shared\.title/,
    "知识库入口必须在隐藏时整条不渲染");
  // 标签筛选入口（tags 模块）—— 门槛在 `h("button", {` 之前，其内联 style 三元较长，窗口放宽
  assert.match(kanban, /!moduleEnabled\(mods, "tags"\) \? null : h\("button", \{[\s\S]{0,600}?tagFilter\.title/,
    "标签筛选入口必须在隐藏时整条不渲染");
  // 目标弹窗的标签编辑器
  assert.match(goalModal, /moduleEnabled\(props\.modules, "tags"\)[\s\S]{0,400}?GoalTagsEditor/,
    "目标弹窗标签编辑器必须受同一判定门控");

  // **反置灰**：受管辖入口不得出现 disabled 的「保留可点」形态。
  // （口径：关闭即移除；留一个 disabled 按钮正是本目标要消灭的形态。）
  // 只扫「该入口自身的渲染块」（从 `h("button", {` 到其闭合文案），避免误伤文件里其它无关的 disabled。
  const gateBlocks: Array<[string, string, RegExp]> = [
    ["kanban.js", kanban, /h\("button", \{[\s\S]{0,320}?\}, dgT\("memory\.btn"\)\)/],
    ["kanban.js", kanban, /h\("button", \{[\s\S]{0,260}?\}, dgT\("shared\.title"\)\.split\("（"\)\[0\]\)/],
    ["kanban.js", kanban, /h\("button", \{[\s\S]{0,600}?dgT\("tagFilter\.title"\)\)/],
    ["goal-modal.js", goalModal, /h\(GoalTagsEditor, \{[\s\S]{0,260}?\}\)/],
  ];
  for (const [name, src, re] of gateBlocks) {
    const m = re.exec(src);
    assert.ok(m, `${name}：受管辖入口的渲染块必须可定位（否则反置灰断言无的放矢）`);
    assert.ok(!/disabled/.test(m![0]), `${name}：受管辖入口的渲染块内不得出现 disabled（隐藏 ≠ 置灰禁用）`);
  }
});

// ===========================================================================
// ② 同源一致：界面判定 ≡ 服务端真裁剪，读同一份下发字段
// ===========================================================================

test("g-494 ②：服务端在**同一份看板载荷**里下发模块开关，且与真裁剪同读一次解析结果", () => {
  const { root } = makeWorkspace("modules:\n  memory: false\n  tags: true\n");
  // 服务端下发字段：与真裁剪**同一个** resolveModuleSwitches 的产物
  const sw = resolveModuleSwitches(readProjectConfig(root));
  const payload = boardPayload(root);

  assert.deepEqual(payload.modules, moduleSwitchPayload(root), "看板载荷的 modules 必须由唯一投影函数产出");
  for (const id of MODULES) {
    assert.equal(payload.modules[id], sw.switches[id].on, `${id}：下发值必须等于真裁剪判定（同源）`);
  }
  assert.equal(payload.modules.memory, false, "显式关闭 ⇒ 下发 false");
  assert.equal(payload.modules.tags, true, "显式开启 ⇒ 下发 true");

  // 真源是 project.yaml ⇒ 改一个叶子即改变下发（不存在第二真源/缓存陈旧）
  writeFileSync(join(root, "project.yaml"), "modules:\n  memory: true\n");
  assert.equal(boardPayload(root).modules.memory, true, "开关改回开启 ⇒ 下发随之回到 true（无陈旧副本）");

  // 单侧裁剪的铁律：界面判定（客户端真实实现）与下发值必须一致
  const gate = loadModuleGate();
  assert.deepEqual(sameSourceProblems({ modules: payload.modules }, gate), [], "界面判定必须与下发值一致（无「一侧裁剪另一侧留入口」）");

  // 服务端异常 ⇒ fail-safe 全开（与宿主 readModuleSwitchesForRoot 的降级口径一致）
  const missing = join(tmpDir("noyaml"), ".dsh-graph");
  mkdirSync(missing, { recursive: true });
  const mp = moduleSwitchPayload(missing);
  for (const id of MODULES) assert.equal(mp[id], true, `${id}：无 project.yaml ⇒ 下发 true（fail-safe 全开）`);
});

test("g-494 ②：客户端**不自备**开关副本 —— 不读 project.yaml、不解析 YAML（只消费下发字段）", () => {
  const gateSrc = readFileSync(join(CLIENT_DIR, "module-gate.js"), "utf8");
  // 只检查**可执行代码**（剥掉注释）——注释里提到 project.yaml 是说明「不读它」，不算违规。
  const code = gateSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/project\.yaml/.test(code), "客户端不得自行读 project.yaml（那会成为第二真源）");
  assert.ok(!/resolveModuleSwitches|HARNESS_MODULE_IDS|readProjectConfig/.test(code),
    "客户端不得复制服务端解析函数/常量（只消费下发值）");
  assert.ok(!/fetch\(|\bXMLHttpRequest\b/.test(code), "客户端判定必须是纯函数（不自行发起请求拿开关）");
  // 服务端唯一投影函数存在且被 boardPayload 使用
  const opsSrc = readFileSync(join(repoRoot, "core/ops.ts"), "utf8");
  assert.match(opsSrc, /modules: moduleSwitchPayload\(root\)/, "boardPayload 必须携带 modules 下发字段");
  assert.match(opsSrc, /export function moduleSwitchPayload\(/, "moduleSwitchPayload 必须是可测的导出");
});

// ===========================================================================
// ④ 不留孤儿 UI：容器/分隔符随内容消失；正打开的面板安全关闭
// ===========================================================================

test("g-494 ④：入口隐藏时其分隔符/容器一并消失（不留空壳），容器可见性由内容驱动", () => {
  const goalModal = readGoalModal();
  // 标签编辑器与其 `｜` 分隔符必须**同处一个条件分支**（否则会留下悬空分隔符 = 空壳）
  const branch = goalModal.slice(goalModal.indexOf('moduleEnabled(props.modules, "tags")'));
  const seg = branch.slice(0, branch.indexOf("GoalTagsEditor") + 400);
  assert.match(seg, /h\("span", \{ style: \{ opacity: 0\.5, userSelect: "none" \} \}, "｜"\)/,
    "`｜` 分隔符必须与标签编辑器在同一条件分支内（关闭时一并消失）");
  assert.ok(!/moduleEnabled\(props\.modules, "tags"\)[\s\S]{0,120}?h\("span"[^\n]*"｜"\s*\)\s*,\s*moduleEnabled/.test(goalModal),
    "分隔符不得留在条件分支之外（那会成为孤儿 UI）");

  // 容器的可见性判定由 module-gate 的 visibleModuleEntries 提供（**由内容驱动**，不新增第二份容器开关）
  const gate = loadModuleGate();
  const offAll = { memory: false, shared_cards: false, tags: false };
  assert.deepEqual([...gate.visibleModuleEntries(offAll, "head-toolbar")], [],
    "全部受管辖模块关闭 ⇒ 该容器内模块入口清空（调用方据此可整块不渲染）");
  // 次序 = 清单声明序（模块 id 序：tags → memory → shared_cards），loaded 后不重排；
  // 显式关掉未点名的模块，避免 fail-safe（缺键 ⇒ 开）把 shared 带进来。
  assert.deepEqual([...gate.visibleModuleEntries({ tags: true, memory: true, shared_cards: false }, "head-toolbar")],
    ["tagfilter", "tagclear", "memory"],
    "仅开 tags+memory ⇒ 可见清单恰为标签筛选两枚 + 记忆（按 模块id序/声明序）");
  assert.deepEqual([...gate.visibleModuleEntries({ shared_cards: true, tags: false, memory: false }, "head-toolbar")], ["shared"],
    "仅开 shared_cards ⇒ 可见清单只含知识库入口");
  assert.deepEqual([...gate.visibleModuleEntries({ attachments: true, automation_prompts: true, tags: false, memory: false, shared_cards: false }, "head-toolbar")], [],
    "无界面入口的模块（提示词面/附件）开启也不产生 toolbar 入口");
});

test("g-494 ④：模块关闭时**正打开**的面板被安全关闭（不留浮着的空壳）", () => {
  const kanban = readKanban();
  const at = kanban.indexOf("g-494 判据 4（不留孤儿 UI）");
  assert.ok(at > 0, "kanban.js 必须含「正打开面板安全关闭」的守卫段");
  const seg = kanban.slice(at, at + 900);
  for (const [id, setter] of [["memory", "setShowMemoryModal"], ["shared_cards", "setShowSharedPanel"], ["tags", "setShowTagFilterModal"]] as const) {
    assert.match(seg, new RegExp(`moduleEnabled\\(modsNow, "${id}"\\)\\) ${setter}\\(false\\)`),
      `模块 ${id} 关闭时必须安全关闭其面板（${setter}(false)）`);
  }
  assert.match(seg, /React\.useEffect\(/, "安全关闭必须由 effect 驱动（响应载荷变化，非一次性初始化）");
});

// ===========================================================================
// ③ 开态零回退：未配置/全开 ⇒ 渲染路径逐字不变
// ===========================================================================

test("g-494 ③：开态零回退 —— 未配置/全开时判定恒真，既有入口渲染字面量未被改写", () => {
  const gate = loadModuleGate();
  for (const id of MODULES) {
    assert.equal(gate.moduleEnabled(undefined, id), true, `${id}：载荷缺失 ⇒ 可见（零回退）`);
    assert.equal(gate.moduleEnabled({ [id]: true }, id), true, `${id}：开启 ⇒ 可见`);
  }
  // 未配置 workspace：下发全 true ⇒ 与改造前界面一致
  const { root } = makeWorkspace("");
  const payload = boardPayload(root);
  for (const id of MODULES) assert.equal(payload.modules[id], true, `${id}：未配置 ⇒ 下发 true（开态零回退）`);

  // 既有入口的字面量渲染（文案键 / 图标）未被本次改动改写
  const kanban = readKanban();
  assert.match(kanban, /dgT\("memory\.btn"\)/, "记忆按钮文案键不变");
  assert.match(kanban, /dgT\("shared\.title"\)\.split\("（"\)\[0\]/, "知识库入口既有截断口径不变");
  const narrow = readFileSync(join(CLIENT_DIR, "narrow-width.js"), "utf8");
  assert.match(narrow, /memory: "🧠"/, "记忆入口图标不变（headPanelEntry 图标表）");
});

// ===========================================================================
// ⑤ 负向对照：四条变异必须报红（改坏就会红）
// ===========================================================================

test("g-494 ⑤：负例① 关闭后入口仍在（仅置灰也算）⇒ 必红", () => {
  const gate = loadModuleGate();
  // 变异：判定恒真（关闭也判「可见」）⇒ 正是「仅置灰/保留可点」的等价形态
  const mutated = withPredicate(gate, () => true);
  const problems = hiddenWhenOffProblems(mutated);
  assert.ok(problems.length > 0, "入口在关闭态仍可见必须报红（仅置灰也算）");
  assert.ok(problems.some((p) => /memory/.test(p)), "点名 memory 入口仍在");

  // 变异：只置灰不禁用（源码层）—— 给受管辖入口加 disabled 而保留渲染
  const kanban = readKanban();
  const greyed = kanban.replace(
    '          toolbarCollapsed || !moduleEnabled(mods, "memory") ? null : h("button", {\n            style: tbBtnStyle,\n            className: "dg-btn",\n            title: dgT("memory.title"),',
    '          h("button", {\n            style: tbBtnStyle,\n            className: "dg-btn",\n            disabled: !moduleEnabled(mods, "memory"),\n            title: dgT("memory.title"),',
  );
  assert.notEqual(greyed, kanban, "变异必须真的改到源码（否则负例无效）");
  // 与测试 ① 的「反置灰」断言**同一口径**：定位该入口的渲染块（**与门槛写法无关**——
  // 从 `h("button", {` 起到 `dgT("memory.btn")` 止），块内出现 disabled 即判红。
  // 门槛被变异移除时仍能命中，正是该断言应起的作用（入口保留可点 ⇒ 必红）。
  const blockRe = /h\("button", \{[\s\S]{0,320}?\}, dgT\("memory\.btn"\)\)/;
  const hit = blockRe.exec(greyed);
  assert.ok(hit && /disabled/.test(hit[0]), "置灰变异必须被「反置灰」断言命中（入口保留可点 ⇒ 必红）");
  const orig = blockRe.exec(kanban);
  assert.ok(orig && !/disabled/.test(orig[0]), "原实现不得命中该断言（否则断言恒真、无鉴别力）");
  // 并确认原实现的「隐藏」门槛**确实存在且为 null 短路**（不是把入口留着置灰）
  assert.match(kanban, /toolbarCollapsed \|\| !moduleEnabled\(mods, "memory"\) \? null : h\("button", \{[\s\S]{0,320}?\}, dgT\("memory\.btn"\)\)/,
    "原实现必须是「关闭 ⇒ null（不渲染）」的短路形态");
});

test("g-494 ⑤：负例② 入口隐藏但容器/分隔符留空壳 ⇒ 必红", () => {
  const goalModal = readGoalModal();
  // 变异：把 `｜` 分隔符移出条件分支（关闭时入口没了、分隔符还在 = 空壳）
  const orphan = goalModal.replace(
    /moduleEnabled\(props\.modules, "tags"\)\s*\n\s*\? h\(React\.Fragment, null,\s*\n\s*h\("span", \{ style: \{ opacity: 0\.5, userSelect: "none" \} \}, "｜"\),/,
    'h("span", { style: { opacity: 0.5, userSelect: "none" } }, "｜"),\n            moduleEnabled(props.modules, "tags")\n              ? h(React.Fragment, null,',
  );
  assert.notEqual(orphan, goalModal, "变异必须真的改到源码（否则负例无效）");
  const seg = orphan.slice(orphan.indexOf('moduleEnabled(props.modules, "tags")'));
  const branch = seg.slice(0, seg.indexOf("GoalTagsEditor") + 400);
  assert.ok(!/h\("span", \{ style: \{ opacity: 0\.5, userSelect: "none" \} \}, "｜"\)/.test(branch),
    "分隔符被移出条件分支 ⇒ 原判据（同一分支）必须报红");

  // 变异：容器可见性不再由内容驱动（容器恒渲染）
  const gate = loadModuleGate();
  const mutated = withPredicate(gate, () => true);
  const offAll = { memory: false, shared_cards: false, tags: false };
  assert.notDeepEqual([...mutated.visibleModuleEntries(offAll, "head-toolbar")], [],
    "容器在全部模块关闭时仍报有可见入口 ⇒ 原判据（清空）必须报红");
});

test("g-494 ⑤：负例③ 关闭后再开启入口未恢复 ⇒ 必红", () => {
  const gate = loadModuleGate();
  // 变异：一次性「粘滞隐藏」——关闭过一次就永久不可见（再开启也不恢复）
  const sticky = new Set<string>();
  const mutated = withPredicate(gate, (m: any, id: string) => {
    if (m && typeof m === "object" && m[id] === false) { sticky.add(id); return false; }
    return !sticky.has(id);
  });
  const problems = roundTripProblems(mutated);
  assert.ok(problems.length > 0, "关闭→再开启未恢复必须报红");
  assert.ok(problems.some((p) => /再开启未完整恢复/.test(p)), "点名「再开启未恢复」");
});

test("g-494 ⑤：负例④ 界面开关状态与下发裁剪状态不一致 ⇒ 必红", () => {
  const gate = loadModuleGate();
  // 变异：界面判定比下发**更宽**（服务端已裁、界面仍留入口）—— 一侧裁剪另一侧留入口
  const wider = withPredicate(gate, () => true);
  const problemsA = sameSourceProblems({ modules: { memory: false, shared_cards: false, tags: false } }, wider);
  assert.ok(problemsA.length > 0, "服务端下发 false 而界面仍可见必须报红");
  assert.ok(problemsA.some((p) => /memory/.test(p)), "点名 memory 侧裁剪不一致");

  // 变异：界面判定比下发**更严**（服务端还留着能力、界面却藏了入口）—— 同样是一侧裁剪
  const stricter = withPredicate(gate, () => false);
  const problemsB = sameSourceProblems({ modules: { memory: true, shared_cards: true, tags: true } }, stricter);
  assert.ok(problemsB.length > 0, "服务端下发 true 而界面不可见必须报红");

  // 正向：一致时零问题（保证上面的断言有鉴别力，不是恒红）
  assert.deepEqual(sameSourceProblems({ modules: { memory: false, shared_cards: true, tags: true } }, gate), [],
    "一致（memory 关、其余开）时不得误报");
  assert.deepEqual(sameSourceProblems({ modules: { memory: true, shared_cards: true, tags: true } }, gate), [],
    "全开一致时不得误报");
});

// ===========================================================================
// 边界：只改客户端呈现层 + 必要下发字段；不改开关语义/默认值/core/ops.ts 真裁剪
// ===========================================================================

test("g-494 边界：不新增依赖、不改开关语义与默认值、不改自动化键名、构建接线完整", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(pkg.dependencies ?? {}, {}, "不得新增依赖（客户端裁剪是零依赖纯函数）");

  // 开关语义/默认值未改：未配置 ⇒ 五模块全开（g-480 语义）
  const { root } = makeWorkspace("");
  const sw = resolveModuleSwitches(readProjectConfig(root));
  for (const id of MODULES) {
    assert.deepEqual(sw.switches[id], { module: id, on: true, configured: false, reason: "default_on" }, `${id} 默认语义不变`);
  }
  // 真裁剪判定仍是同一函数（未被界面裁剪改道）
  assert.match(readFileSync(join(repoRoot, "core/ops.ts"), "utf8"), /export function resolveModuleSwitches\(/,
    "resolveModuleSwitches 仍是唯一判定入口");

  // 构建接线：module-gate 必须在 drag-prompts **之前**（工厂作用域），否则 client 侧引用不到
  const build = readBuildScript();
  const parts = build.slice(build.indexOf("PARTS=("), build.indexOf(")\n\n# 写入稳定"));
  const g = parts.indexOf('"module-gate"'), dp = parts.indexOf('"drag-prompts"');
  assert.ok(g > 0, "构建清单必须含 module-gate");
  assert.ok(g < dp, "module-gate 必须排在 drag-prompts 之前（工厂作用域）");

  // 产物存在且含判定（构建后）
  const bundle = readFileSync(join(repoRoot, "dist/lib/client.js"), "utf8");
  assert.match(bundle, /function moduleEnabled\(/, "客户端产物必须含 moduleEnabled 真实实现");
  assert.match(bundle, /function visibleModuleEntries\(/, "客户端产物必须含可见入口派生实现");
});

test("g-494 边界：入口清单表结构完整（模块/入口键/容器齐备，无未登记的可选模块入口）", () => {
  const gate = loadModuleGate();
  for (const id of MODULES) {
    const entries = gate.MODULE_UI_ENTRIES[id];
    assert.ok(Array.isArray(entries), `${id} 必须在入口清单里登记（空数组 = 明确无界面入口）`);
    for (const e of entries) {
      assert.ok(typeof e.key === "string" && e.key.length > 0, `${id} 的入口必须有稳定 key`);
      assert.ok(typeof e.container === "string" && e.container.length > 0, `${id} 的入口 ${e.key} 必须登记所在容器`);
      assert.ok(typeof e.label_key === "string" && e.label_key.length > 0, `${id} 的入口 ${e.key} 必须登记文案键`);
    }
  }
  // 纯提示词面模块与附件（无独立界面入口）如实登记为空，而不是漏登记
  assert.deepEqual([...gate.MODULE_UI_ENTRIES.automation_prompts], [], "automation_prompts 无界面入口");
  assert.deepEqual([...gate.MODULE_UI_ENTRIES.attachments], [], "attachments 无独立界面功能入口");
  // 通用入口不得登记（否则模块关闭会误删与开关无关的入口）
  const allKeys = MODULES.flatMap((id) => (gate.MODULE_UI_ENTRIES[id] ?? []).map((e: any) => e.key));
  for (const generic of ["refresh", "help", "settings", "versionmanage", "createversion"]) {
    assert.ok(!allKeys.includes(generic), `通用入口 ${generic} 不得登记为模块管辖（绝不因模块关闭误删）`);
  }
});
