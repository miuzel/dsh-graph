/**
 * g-339 判据机器断言：按需记忆（on_demand）单条硬上限 500 → 1000。
 *
 * 覆盖质量判据 1–6：
 *  1. 1000 码点通过 / 1001 拒绝（报错含实际上限值与当前字数）、trim 后计数、replace 等价放宽
 *  2. standing 200 铁律与常驻段预算（10 条 / 2000 字符）不回归，拒绝文案逐字不变
 *  3. 注入侧不再静默截断：500–1000 码点条目经 generateHandoff 全文可见；
 *     超长遗留条目留下**明确可见**的截断标记（而不是悄悄砍半）
 *  4. 4000 字符总预算保持：长条目挤占时高优先级优先保留 + 截断提示可见
 *  5. 上限值是 core 侧真源常量；host 工具描述 / lib/server-i18n.js / 客户端 i18n.js 与
 *     client/constants.js 的文案与阈值副本全部同步为 1000（standing 仍 200），
 *     配一致性断言核对（客户端 bundle 独立打包、无法 import core 常量，断言为等价手段）
 *  6. 前端拦截与服务端同阈值；既有拒绝项（控制字符 / SECRET / kind / scope / importance）
 *     未被削弱；仓库内无残留的记忆 500 上限表述（中英）
 *
 * 「改坏即红」：本文件末尾两节是 hermetic 负向对照——把**副本变量**改回旧行为后，
 * 同一套一致性检查函数必须报出漂移，并断言真实仓库文件逐字未变（对照不污染工作树）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import {
  init,
  addMemory,
  replaceMemory,
  generateHandoff,
  formatStandingMemorySection,
  recallMemory,
  MEMORY_LIMITS,
  MEMORY_INJECT_TOTAL_BUDGET,
  GraphError,
} from "../ops.ts";
import { appendMemoryEvent } from "../events.ts";
import { SERVER_I18N } from "../../dsh-graph-host/lib/server-i18n.js";

const repoRoot = join(import.meta.dirname, "../..");
const clientDir = join(repoRoot, "dsh-graph-host/lib/client");

/** 构造恰好 n 个**码点**的文本：😀 是代理对（UTF-16 长 2），中/字 是单码元。
 *  这样 `[...s].length` 与 `s.length` 必然不等，能证明计数走码点而非 UTF-16 长度。 */
function cps(n: number): string {
  const block = "😀中";
  const full = block.repeat(Math.floor(n / 2));
  return n % 2 === 0 ? full : `${full}字`;
}

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g339-"));
  init(root);
  return root;
}

// =====================================================================================
// 判据 1：on_demand 单条硬上限 1000（码点计数 / trim 后计数 / replace 等价放宽）
// =====================================================================================

test("g-339 判据1：上限真源为 200/1000，且 1000 码点通过、1001 码点被拒且报错含上限与当前字数", () => {
  assert.deepEqual({ ...MEMORY_LIMITS }, { standing: 200, on_demand: 1000 }, "上限真源常量");

  const root = freshRoot();
  const ok = cps(MEMORY_LIMITS.on_demand);
  assert.equal([...ok].length, 1000, "构造文本恰为 1000 码点");
  assert.ok(ok.length > 1000, `构造文本 UTF-16 长度(${ok.length})大于码点数，可区分两种计数`);

  const added = addMemory(root, { kind: "project", scope: "on_demand", text: ok, actor: "agent:g339" });
  assert.equal([...added.entry.text].length, 1000, "1000 码点写入成功");
  assert.equal(added.entry.text, ok, "内容逐字保留");

  const tooLong = cps(1001);
  assert.throws(
    () => addMemory(root, { kind: "project", scope: "on_demand", text: tooLong, actor: "agent:g339" }),
    (e: any) =>
      e instanceof GraphError &&
      e.message.includes("1000") &&
      e.message.includes("1001") &&
      /每[条条].*上限\s*1000/.test(e.message),
    "1001 码点被拒，报错含实际上限值与当前字数",
  );
  assert.equal(recallMemory(root).total, 1, "拒绝时零副作用（未落盘）");
});

test("g-339 判据1：首尾空白 trim 后计数（trim 后 1000 通过 / trim 后 1001 拒绝）", () => {
  const root = freshRoot();
  // 只用空格填充：\t/\n 属 \p{Cc} 控制字符，会被既有拒绝项先行拦下，不适用于本用例
  const padded = `   ${cps(1000)}   `;
  const added = addMemory(root, { kind: "project", scope: "on_demand", text: padded, actor: "agent:g339" });
  assert.equal([...added.entry.text].length, 1000);
  assert.equal(added.entry.text, padded.trim(), "落盘为 trim 后文本");

  assert.throws(
    () => addMemory(root, { kind: "project", scope: "on_demand", text: `   ${cps(1001)}   `, actor: "agent:g339" }),
    (e: any) => e instanceof GraphError && e.message.includes("1000") && e.message.includes("1001"),
    "trim 后 1001 码点仍被拒",
  );
});

test("g-339 判据1：graph_memory_replace 走同一校验并等价放宽", () => {
  const root = freshRoot();
  const target = addMemory(root, { kind: "project", scope: "on_demand", text: "旧条目：待替换定位片段", actor: "agent:g339" });

  const long = "R".repeat(1000);
  const replaced = replaceMemory(root, { old: target.id, text: long, actor: "agent:g339" });
  assert.equal(replaced.entry.text, long, "replace 到 1000 字符成功");

  assert.throws(
    () => replaceMemory(root, { old: target.id, text: "R".repeat(1001), actor: "agent:g339" }),
    (e: any) => e instanceof GraphError && e.message.includes("1000") && e.message.includes("1001"),
    "replace 到 1001 字符被同一校验拒绝",
  );
});

// =====================================================================================
// 判据 2：standing 200 铁律与常驻段预算不回归
// =====================================================================================

test("g-339 判据2：standing 200 通过 / 201 拒绝，拒绝文案与改动前逐字一致", () => {
  const root = freshRoot();
  addMemory(root, { kind: "project", scope: "standing", text: "S".repeat(200), actor: "agent:g339" });

  assert.throws(
    () => addMemory(root, { kind: "project", scope: "standing", text: "S".repeat(201), actor: "agent:g339" }),
    (e: any) =>
      e instanceof GraphError &&
      e.message === "常驻记忆 (standing) 每条文字硬上限为 200 字符（当前 201 字），请精炼后写入",
    "standing 拒绝文案逐字不变",
  );

  // standing 不被 on_demand 的放宽顺带放过：1000 字符 standing 仍按 200 拒绝
  assert.throws(
    () => addMemory(root, { kind: "project", scope: "standing", text: "S".repeat(1000), actor: "agent:g339" }),
    (e: any) => e instanceof GraphError && e.message.includes("硬上限为 200 字符"),
    "on_demand 放宽不得外溢到 standing",
  );
});

test("g-339 判据2：常驻段默认预算（10 条 / 2000 字符）行为不回归", () => {
  const root = freshRoot();
  for (let i = 0; i < 12; i++) {
    addMemory(root, {
      kind: "project",
      scope: "standing",
      text: `约束${i}-` + "S".repeat(150), // 154 码点 < 200，12 条合计 1848 > 2000 且超过 10 条上限
      importance: 3,
      actor: `human:g339-${i}`,
    });
  }

  const section = formatStandingMemorySection(root);
  assert.ok(section, "常驻段应生成");
  assert.equal((section.match(/^- \*\*\[mem-/gm) ?? []).length, 10, "默认最多注入 10 条");
  assert.ok(section.includes("常驻记忆预算超限"), "预算超限提示可见");
  assert.ok(section.includes("其余 2 条条目已折叠"), "折叠条数正确（12 - 10）");
});

// =====================================================================================
// 判据 3：注入侧不再静默截断（注入上限与存储上限同源）
// =====================================================================================

test("g-339 判据3：500–1000 码点条目经注入/交接路径全文可见，无截断标记", () => {
  const root = freshRoot();
  const mid = cps(800);
  const max = cps(1000);
  addMemory(root, { kind: "project", scope: "on_demand", text: mid, importance: 5, actor: "agent:g339" });
  addMemory(root, { kind: "project", scope: "on_demand", text: max, importance: 5, actor: "agent:g339" });

  const handoff = generateHandoff(root);
  assert.ok(handoff.includes("## 长期记忆"), "交接文档含长期记忆注入段");
  assert.ok(handoff.includes(mid), "800 码点条目注入全文可见（旧实现会在 500 处静默砍半）");
  assert.ok(handoff.includes(max), "1000 码点条目注入全文可见（注入上限 == 存储上限）");
  assert.ok(!handoff.includes("本条已截断"), "正常范围内的条目不得出现截断标记");
  assert.ok(!handoff.includes("已达到 4000 字符上限"), "两条长条目未触及总预算");
});

test("g-339 判据3：超出存储上限的遗留条目在注入侧留下明确可见的截断标记", () => {
  const root = freshRoot();
  // 模拟历史遗留 / 手工编辑写入的超长条目（绕过存储校验，存储侧已拒绝的路径）
  const legacy = "L".repeat(1500);
  appendMemoryEvent(root, {
    actor: "agent:legacy",
    event: "memory.added",
    details: {
      id: "mem-legacy01", kind: "project", scope: "on_demand", text: legacy, importance: 5,
      created_at: "2026-01-01T00:00:00+08:00", updated_at: "2026-01-01T00:00:00+08:00",
    },
  } as any);

  const handoff = generateHandoff(root);
  assert.ok(handoff.includes("- **mem-legacy01**"), "遗留条目仍被注入");
  assert.ok(!handoff.includes(legacy), "超长条目不再被原样注入");
  assert.ok(handoff.includes("本条已截断"), "截断带有明确可见标记（而非静默砍半）");
  assert.ok(handoff.includes(`单条上限 ${MEMORY_LIMITS.on_demand} 字符`), "标记写明单条上限值");
  assert.ok(handoff.includes("原文 1500 字"), "标记写明原始字数");
  assert.ok(handoff.includes("L".repeat(1000)), "标记前保留上限内的全部内容");
});

// =====================================================================================
// 判据 4：4000 字符总预算保持 + 优先级排序生效 + 截断提示可见
// =====================================================================================

test("g-339 判据4：4000 总预算保持；长条目挤占时高优先级优先保留且截断提示可见", () => {
  assert.equal(MEMORY_INJECT_TOTAL_BUDGET, 4000, "总预算保持 4000（不随单条上限放宽而提高）");

  const root = freshRoot();
  const low1 = "L".repeat(MEMORY_LIMITS.on_demand);
  const low2 = "M".repeat(MEMORY_LIMITS.on_demand);
  // 先登记**低**优先级长条目，再登记高优先级：若排序失效，被预算保留的会是先登记的低优先级条目
  addMemory(root, { kind: "project", scope: "on_demand", text: low1, importance: 1, actor: "agent:g339" });
  addMemory(root, { kind: "project", scope: "on_demand", text: low2, importance: 1, actor: "agent:g339" });
  const highs = ["H".repeat(1000), "I".repeat(1000), "J".repeat(1000)];
  for (const text of highs) addMemory(root, { kind: "project", scope: "on_demand", text, importance: 5, actor: "agent:g339" });

  const handoff = generateHandoff(root);
  for (const h of highs) assert.ok(handoff.includes(h), "高优先级长条目优先保留（长条目挤占场景）");
  assert.ok(!handoff.includes(low1) && !handoff.includes(low2), "低优先级长条目被 4000 预算挤出");
  assert.ok(
    handoff.includes(`已达到 ${MEMORY_INJECT_TOTAL_BUDGET} 字符上限`),
    "截断提示可见（不是无声丢弃）",
  );
  assert.ok(handoff.includes("剩余条目已截断"), "提示说明剩余条目已截断");
});

// =====================================================================================
// 判据 5：上限值的 core 真源 + host/client 各副本与文案一致性
// =====================================================================================

function loadClientDicts(i18nSrc: string): { zh: Record<string, string>; en: Record<string, string> } {
  const sandbox: any = { React: {} };
  vm.runInNewContext(`${i18nSrc}\n;this.zh = zh; this.en = en;`, sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

function loadClientLimits(constantsSrc: string) {
  const sandbox: any = { React: {}, dgT: (k: string) => k };
  // constants.js 末尾停在 `const S = {`（对象字面量由 helpers.js 续写），补一个闭合花括号即可独立求值
  vm.runInNewContext(`${constantsSrc}\n};\nthis.MEMORY_LIMITS = MEMORY_LIMITS;\nthis.memLimit = memLimit;`, sandbox);
  return { limits: sandbox.MEMORY_LIMITS, memLimit: sandbox.memLimit as (s?: string) => number };
}

/** 客户端一侧的一致性检查（可注入副本，便于 hermetic 负向对照）。返回问题列表。 */
function clientLimitProblems(s: {
  constantsSrc: string;
  dragPromptsSrc: string;
  zh: Record<string, string>;
  en: Record<string, string>;
}): string[] {
  const problems: string[] = [];

  let limits: any, limitFn: any;
  try {
    ({ limits, memLimit: limitFn } = loadClientLimits(s.constantsSrc));
  } catch (e) {
    return [`client/constants.js 无法求值：${String(e)}`];
  }
  if (!limits) problems.push("client/constants.js 未导出 MEMORY_LIMITS");
  else {
    if (limits.standing !== MEMORY_LIMITS.standing) problems.push(`client MEMORY_LIMITS.standing=${limits.standing} ≠ core ${MEMORY_LIMITS.standing}`);
    if (limits.on_demand !== MEMORY_LIMITS.on_demand) problems.push(`client MEMORY_LIMITS.on_demand=${limits.on_demand} ≠ core ${MEMORY_LIMITS.on_demand}`);
  }
  if (typeof limitFn !== "function") problems.push("client/constants.js 未导出 memLimit()");
  else {
    if (limitFn("standing") !== MEMORY_LIMITS.standing) problems.push(`memLimit("standing")=${limitFn("standing")} ≠ ${MEMORY_LIMITS.standing}`);
    if (limitFn("on_demand") !== MEMORY_LIMITS.on_demand) problems.push(`memLimit("on_demand")=${limitFn("on_demand")} ≠ ${MEMORY_LIMITS.on_demand}`);
    if (limitFn(undefined) !== MEMORY_LIMITS.on_demand) problems.push("memLimit(undefined) 应回退 on_demand 上限");
  }

  const drag = s.dragPromptsSrc;
  if (!/memLimit\(newScope\)/.test(drag)) problems.push("drag-prompts.js 未使用 memLimit(newScope)：前端阈值可能与 core 漂移");
  if ((drag.match(/memLimit\(newScope\)/g) ?? []).length < 3) {
    problems.push("drag-prompts.js 使用 memLimit(newScope) 的次数 < 3（拦截 / 超限标红 / 输入提示需全部同源）");
  }
  if (!drag.includes("onDemandCharsExceeded")) problems.push("drag-prompts.js 缺少 on_demand 前端拦截：前端会放行 >1000 去吃服务端报错");
  if (/\b500\b/.test(drag)) problems.push("drag-prompts.js 仍残留字面量 500 记忆阈值");

  for (const [lang, dict] of [["zh", s.zh], ["en", s.en]] as const) {
    for (const key of ["memory.onDemandLabel", "memory.onDemandType"]) {
      const v = dict[key];
      if (!v) problems.push(`${lang} 缺少 ${key}`);
      else if (!v.includes("1000")) problems.push(`${lang}.${key} 未显示 1000：${v}`);
      else if (/\b500\b/.test(v)) problems.push(`${lang}.${key} 仍写 500：${v}`);
    }
    const over = dict["memory.onDemandCharsExceeded"];
    if (!over) problems.push(`${lang} 缺少 memory.onDemandCharsExceeded`);
    else if (!over.includes("{limit}") || !over.includes("{count}")) {
      problems.push(`${lang}.memory.onDemandCharsExceeded 缺少 {limit}/{count} 占位符：${over}`);
    }
    const hint = dict["memory.onDemandHint"];
    if (!hint || !hint.includes("1000")) problems.push(`${lang}.memory.onDemandHint 未显示 1000`);
  }
  return problems;
}

/** host 文案（工具描述）的一致性检查。返回问题列表。 */
function hostCopyProblems(zhText: string, enText: string): string[] {
  const problems: string[] = [];
  if (!zhText.includes("普通记忆上限 1000 字符")) problems.push(`中文工具描述未同步为 1000：${zhText}`);
  if (/\b500\b/.test(zhText)) problems.push(`中文工具描述仍写 500：${zhText}`);
  if (!/硬上限\s*200\s*字符/.test(zhText)) problems.push("中文工具描述丢失 standing 200 表述");
  if (!enText.includes("ordinary memory limit 1000 characters")) problems.push(`英文工具描述未同步为 1000：${enText}`);
  if (/\b500\b/.test(enText)) problems.push(`英文工具描述仍写 500：${enText}`);
  if (!/hard limit 200 characters/.test(enText)) problems.push("英文工具描述丢失 standing 200 表述");
  return problems;
}

/** core 源码不变量：真源常量 + 存储校验与注入渲染同源。返回问题列表。 */
function coreSourceProblems(src: string): string[] {
  const problems: string[] = [];
  // 说明：本检查器同时用于 .ts 源码与 tsc 编译后的 dist/core/ops.js（仅类型注解被擦除），
  // 故正则不假设 `export` 前缀或 `: number` 注解存在。
  if (!/MEMORY_LIMITS = \{[\s\S]{0,600}?standing: 200,[\s\S]{0,600}?on_demand: 1000,/.test(src)) {
    problems.push("core/ops.ts 的 MEMORY_LIMITS 真源常量不是 { standing: 200, on_demand: 1000 }");
  }
  if (!/MEMORY_INJECT_TOTAL_BUDGET = 4000/.test(src)) problems.push("core/ops.ts 的注入总预算常量不是 4000");
  if (!/\[\.\.\.text\]\.length > MEMORY_LIMITS\.on_demand/.test(src)) {
    problems.push("validateMemoryInput 未使用 on_demand 真源常量（存储上限与真源漂移）");
  }
  if (!/\[\.\.\.text\]\.length > MEMORY_LIMITS\.standing/.test(src)) {
    problems.push("validateMemoryInput 未使用 standing 真源常量");
  }
  if (!/limit(?:: number)? = MEMORY_LIMITS\.on_demand/.test(src)) {
    problems.push("safeMemory 未与存储上限同源（注入侧可能仍静默截断）");
  }
  if (/slice\(0, 500\)/.test(src)) problems.push("core/ops.ts 仍残留 slice(0, 500) 注入截断");
  return problems;
}

const readClientFile = (name: string) => readFileSync(join(clientDir, name), "utf8");

test("g-339 判据5/6：core 真源常量 + 客户端副本 / i18n / drag-prompts 阈值一致性", () => {
  assert.deepEqual({ ...MEMORY_LIMITS }, { standing: 200, on_demand: 1000 }, "core 侧真源常量");
  assert.deepEqual(coreSourceProblems(readFileSync(join(repoRoot, "core/ops.ts"), "utf8")), [], "core 源码不变量");

  const { zh, en } = loadClientDicts(readClientFile("i18n.js"));
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "客户端 i18n zh/en 键集对称");
  // en 侧零 CJK：唯一豁免是语言名本体（"中文" 是有意保留的自称，非未翻译文案）
  const cjkKeys = Object.entries(en).filter(([, v]) => /[\u3400-\u9fff]/.test(String(v))).map(([k]) => k);
  assert.deepEqual(cjkKeys.filter((k) => k !== "profileSettings.promptLanguageZh"), [], "en 侧零 CJK（仅允许语言名自称）");
  for (const [k, v] of Object.entries(en)) {
    if (k.startsWith("memory.")) assert.doesNotMatch(String(v), /[\u3400-\u9fff]/, `memory.* en 文案不得含 CJK：${k}`);
  }

  const problems = clientLimitProblems({
    constantsSrc: readClientFile("constants.js"),
    dragPromptsSrc: readClientFile("drag-prompts.js"),
    zh,
    en,
  });
  assert.deepEqual(problems, [], "客户端各副本与 core 真源一致");

  // 输入提示 / 前端拦截阈值确实来自副本函数（行为化：真实求值而非字符串自证）
  const { memLimit } = loadClientLimits(readClientFile("constants.js"));
  assert.equal(memLimit("on_demand"), 1000, "输入提示与前端拦截的 on_demand 阈值为 1000");
  assert.equal(memLimit("standing"), 200, "standing 仍为 200");
});

test("g-339 判据5：host 工具描述（index.js 硬编码 + server-i18n zh/en）同步为 1000", () => {
  const indexSrc = readFileSync(join(repoRoot, "dsh-graph-host/index.js"), "utf8");
  const start = indexSrc.indexOf('name: "graph_memory_add"');
  assert.ok(start >= 0, "index.js 找到 graph_memory_add 工具定义");
  const next = indexSrc.indexOf('name: "graph_memory_', start + 10);
  const block = indexSrc.slice(start, next > start ? next : start + 2000);

  assert.deepEqual(
    hostCopyProblems(SERVER_I18N.zh["tool.graph_memory_add"], SERVER_I18N.en["tool.graph_memory_add"]),
    [],
    "server-i18n 中英工具描述一致为 1000",
  );
  assert.deepEqual(hostCopyProblems(block, SERVER_I18N.en["tool.graph_memory_add"]), [], "index.js 硬编码描述与 server-i18n 同源同值");
});

test("g-339 判据5：build 产物同步（dist 客户端副本与 server-i18n 均为 1000）", () => {
  const distRoot = join(repoRoot, "dist");
  assert.ok(existsSync(distRoot), "dist/ 不存在：请先运行 bash scripts/build.sh");

  const bundle = readFileSync(join(distRoot, "lib/client.js"), "utf8");
  assert.ok(bundle.includes("const MEMORY_LIMITS = { standing: 200, on_demand: 1000 }"), "dist/lib/client.js 客户端副本已同步 1000");
  assert.ok(bundle.includes("memLimit(newScope)"), "dist/lib/client.js 前端拦截走同源阈值函数");
  assert.ok(bundle.includes("memory.onDemandCharsExceeded"), "dist/lib/client.js 含 on_demand 超限文案");
  assert.doesNotMatch(bundle, /≤\s*500/, "dist bundle 无残留 ≤500 文案");

  const distServer = readFileSync(join(distRoot, "lib/server-i18n.js"), "utf8");
  assert.ok(distServer.includes("普通记忆上限 1000 字符"), "dist server-i18n 中文已同步");
  assert.ok(distServer.includes("ordinary memory limit 1000 characters"), "dist server-i18n 英文已同步");
  assert.doesNotMatch(distServer, /\b500\b/, "dist server-i18n 无残留 500");

  const distOps = readFileSync(join(distRoot, "core/ops.js"), "utf8");
  assert.deepEqual(coreSourceProblems(distOps), [], "dist/core/ops.js 与 core 源码不变量一致");
});

// =====================================================================================
// 判据 6：既有拒绝项未被削弱 + 仓库内无残留的记忆 500 上限表述
// =====================================================================================

test("g-339 判据6：既有拒绝项（控制字符 / SECRET / kind / scope / importance / 空值）行为不变", () => {
  const root = freshRoot();
  const base = { kind: "project" as const, scope: "on_demand" as const, actor: "agent:g339" };

  assert.throws(() => addMemory(root, { ...base, text: `正常前缀\u0007控制字符` }), /不得包含控制字符/);
  assert.throws(() => addMemory(root, { ...base, text: "api_key: sk-abcdefghijklmnop" }), /疑似包含凭据或 token/);
  assert.throws(() => addMemory(root, { ...base, text: "Authorization: Bearer abcdefghijklmnopqrst" }), /疑似包含凭据或 token/);
  assert.throws(() => addMemory(root, { ...(base as any), kind: "bogus", text: "x" }), /kind 必须为 project 或 user/);
  assert.throws(() => addMemory(root, { ...(base as any), scope: "weird", text: "x" }), /scope 必须为 standing 或 on_demand/);
  for (const imp of [0, 6, Number.NaN]) {
    assert.throws(() => addMemory(root, { ...base, text: "x", importance: imp }), /importance 必须为 1-5 数字/);
  }
  assert.throws(() => addMemory(root, { ...base, text: "   " }), /必须是非空字符串/);

  // 放宽只影响长度上限：上限内的合法条目仍可写入
  addMemory(root, { ...base, text: "K".repeat(1000) });
  assert.equal(recallMemory(root).total, 1);
});

const MEMORY_500_PATTERNS: Array<[string, RegExp]> = [
  ["中文上限文案", /上限\s*500/],
  ["中文 ≤500 文案", /≤\s*500/],
  ["英文 500 chars 文案", /500\s*chars/],
  ["中文 500 字符文案", /500\s*字符/],
  ["旧注入截断", /slice\(\s*0\s*,\s*500\s*\)/],
  ["旧英文工具描述", /ordinary memory limit 500/],
];

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", ".worktrees", ".dsh-graph", "tmp"].includes(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (full === join(repoRoot, "core/tests")) continue; // 测试自身需要书写边界值，排除
      walkFiles(full, out);
    } else if (/\.(ts|js|md|json|ya?ml)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

test("g-339 判据6：仓库内无残留的记忆 500 上限表述（中英，排除历史事件流与历史数据）", () => {
  const roots = ["core", "dsh-graph-host", "docs", "scripts", "schema"]
    .map((p) => join(repoRoot, p))
    .filter((p) => existsSync(p));
  const files = walkFiles(repoRoot).filter((f) =>
    roots.some((r) => f.startsWith(r + "/")) ||
    /^\/(README|AGENTS|DESIGN|TESTING-g-157)\.md$/.test(f.slice(repoRoot.length)) ||
    f === join(repoRoot, "package.json") ||
    f.startsWith(join(repoRoot, "dist") + "/"),
  );
  assert.ok(files.length > 100, `扫描面过小（${files.length} 个文件），结果不可信`);

  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [label, re] of MEMORY_500_PATTERNS) {
      lines.forEach((line, i) => {
        if (re.test(line)) hits.push(`${file.slice(repoRoot.length + 1)}:${i + 1} [${label}] ${line.trim().slice(0, 120)}`);
      });
    }
  }
  assert.deepEqual(hits, [], `仍存在记忆 500 上限表述（改完必须 rebuild）：\n${hits.join("\n")}`);
});

// =====================================================================================
// 「改坏即红」负向对照（hermetic：只改内存中的副本变量，绝不触碰真实文件）
// =====================================================================================

test("g-339 负向对照：客户端副本 / i18n 文案 / host 文案改回旧值，一致性断言必红且仓库文件未变", () => {
  const realConstants = readClientFile("constants.js");
  const realDrag = readClientFile("drag-prompts.js");
  const { zh, en } = loadClientDicts(readClientFile("i18n.js"));

  // 基线：真实源零问题
  assert.deepEqual(clientLimitProblems({ constantsSrc: realConstants, dragPromptsSrc: realDrag, zh, en }), []);

  // 改坏 1：客户端副本回退 500
  const mutatedConstants = realConstants.replace("on_demand: 1000", "on_demand: 500");
  assert.notEqual(mutatedConstants, realConstants, "变更确实生效");
  const p1 = clientLimitProblems({ constantsSrc: mutatedConstants, dragPromptsSrc: realDrag, zh, en });
  assert.ok(p1.some((p) => p.includes("client MEMORY_LIMITS.on_demand")), `副本回退必红，实际问题：${JSON.stringify(p1)}`);

  // 改坏 2：前端 on_demand 拦截退回（不再有超限文案引用）
  const mutatedDrag = realDrag.replace(/onDemandCharsExceeded/g, "standingCharsExceeded");
  const p2 = clientLimitProblems({ constantsSrc: realConstants, dragPromptsSrc: mutatedDrag, zh, en });
  assert.ok(p2.some((p) => p.includes("on_demand 前端拦截")), `前端拦截缺失必红，实际问题：${JSON.stringify(p2)}`);

  // 改坏 3：i18n 文案回退 500
  const p3 = clientLimitProblems({ constantsSrc: realConstants, dragPromptsSrc: realDrag, zh: { ...zh, "memory.onDemandLabel": "按需记忆(≤500字)" }, en });
  assert.ok(p3.some((p) => p.includes("memory.onDemandLabel")), `i18n 文案回退必红，实际问题：${JSON.stringify(p3)}`);

  // 改坏 4：host 工具描述回退 500
  const p4 = hostCopyProblems(SERVER_I18N.zh["tool.graph_memory_add"].replace("1000 字符", "500 字符"), SERVER_I18N.en["tool.graph_memory_add"]);
  assert.ok(p4.length > 0, `host 中文描述回退必红，实际问题：${JSON.stringify(p4)}`);
  const p5 = hostCopyProblems(SERVER_I18N.zh["tool.graph_memory_add"], SERVER_I18N.en["tool.graph_memory_add"].replace("1000 characters", "500 characters"));
  assert.ok(p5.some((p) => p.includes("英文工具描述")), `host 英文描述回退必红，实际问题：${JSON.stringify(p5)}`);

  // hermetic：真实仓库文件逐字未变
  assert.equal(readClientFile("constants.js"), realConstants, "负向对照污染了真实 client/constants.js");
  assert.equal(readClientFile("drag-prompts.js"), realDrag, "负向对照污染了真实 drag-prompts.js");
});

test("g-339 负向对照：core 真源 / 注入同源不变量改坏即红（镜像源码）", () => {
  const realOps = readFileSync(join(repoRoot, "core/ops.ts"), "utf8");
  assert.deepEqual(coreSourceProblems(realOps), [], "真实 core/ops.ts 满足不变量");

  const backTo500 = realOps.replace("on_demand: 1000,", "on_demand: 500,");
  assert.notEqual(backTo500, realOps);
  assert.ok(coreSourceProblems(backTo500).some((p) => p.includes("真源常量")), "真源回退 500 必红");

  // 模拟「只放宽存储、注入仍截断 500」的退化形态
  const silentTruncation = realOps.replace("limit: number = MEMORY_LIMITS.on_demand", "limit: number = 500");
  assert.ok(
    coreSourceProblems(silentTruncation).some((p) => p.includes("safeMemory 未与存储上限同源")),
    "注入侧不同源（静默截断退化）必红",
  );

  const budgetDrift = realOps.replace("MEMORY_INJECT_TOTAL_BUDGET = 4000", "MEMORY_INJECT_TOTAL_BUDGET = 8000");
  assert.ok(coreSourceProblems(budgetDrift).some((p) => p.includes("总预算常量")), "总预算漂移必红");

  assert.equal(readFileSync(join(repoRoot, "core/ops.ts"), "utf8"), realOps, "负向对照污染了真实 core/ops.ts");
});
