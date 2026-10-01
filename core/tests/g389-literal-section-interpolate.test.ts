/**
 * g-389：字面量 section（首要是常驻记忆）的宿主模板插值隔离回归。
 *
 * 背景（v0.18.0 审查 P1，条件性）：宿主 `renderPrompt` **默认**解释 section 正文里的
 * `{{变量}}`。常驻记忆是用户/Agent 动态文本，可能合法地包含模板示例（`{{customer_name}}`）：
 *   · 变量未注册 → 抛 `unknown prompt variable` ⇒ **阻断该 workspace 的会话**；
 *   · 变量同名已注册 → **静默替换**原文 ⇒ 用户数据被篡改。
 * 修复：给本插件的**字面量 section** 显式 `interpolate: false`，正文逐字保留；不要求用户
 * 转义或删除合法的记忆模板。
 *
 * 本套件（判据 1/2/4）：
 *  ① 用**真实宿主 renderer**（`@deepseek-ai/dsh-system-prompt` 的 `renderPrompt`，非自造模仿）
 *     渲染从 `apply` **真实捕获**的 section：未注册变量、已注册同名变量、模板标点三类正文
 *     全部逐字保留，既不抛错也不被替换；
 *  ② **负向对照**：把捕获到的 section 剥掉 `interpolate` 后同一 renderer 立即抛
 *     `unknown prompt variable`（⇒ 去掉源码里的 `interpolate: false` 本用例必红）；默认
 *     （真模板）section 仍按原契约插值，证明没有全局禁用插值；
 *  ③ 审计范围钉住：本插件注册的 section 恰为 3 个且**全部** `interpolate === false`，并且
 *     不注册任何 prompt 变量/context（⇒ 没有任何 section 是真模板）。
 *
 * 兼容性边界（实测记录，见 dsh-graph-host/index.js 的 g-389 注释）：`interpolate: false`
 * 在 dsh/system-prompt 0.1.5-rc.2、0.1.5-rc.3 上**被忽略**（旧 renderPrompt 无条件插值），
 * 自 0.1.6-alpha.1 起生效；本套件只对"能解析到的本机宿主 renderer"给出结论，未解析到时
 * 显式 skip（不伪装绿灯）。仓储测试环境不装 `@deepseek-ai/*`，故解析是能力探测而非硬依赖。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { addMemory, init } from "../ops.ts";
import { apply } from "../../dist/index.js";

const REPO_ROOT = join(import.meta.dirname, "../..");
const PKG_REL = "@deepseek-ai/dsh-system-prompt";

/** 本插件自有 section 的审计清单（name → 是否字面量）；新增 section 必须在此重新分类。 */
const EXPECTED_GRAPH_SECTIONS = [
  "dsh-graph-guide-hint",
  "dsh-graph-standing-memory",
  "dsh-graph-supervisor-discipline",
];

type CapturedSection = { name: string; order: number; text: string; interpolate?: boolean };

/** 去掉可选键后的 section（= 修复前的注册形态），用于负向对照。 */
const stripInterpolate = (s: CapturedSection) => {
  const { interpolate: _ignored, ...rest } = s;
  return rest;
};

/** 真实宿主 renderer 的候选路径：env 覆盖 → 仓库 node_modules → PATH 上的 dsh → 常见全局根。 */
function rendererCandidates(): string[] {
  const out: string[] = [];
  const push = (p: string) => {
    if (p && !out.includes(p)) out.push(p);
  };
  const withDeps = (dshRoot: string) => join(dshRoot, "node_modules", PKG_REL, "lib/index.js");
  if (process.env.DSH_SYSTEM_PROMPT_PATH) push(process.env.DSH_SYSTEM_PROMPT_PATH);
  push(join(REPO_ROOT, "node_modules", PKG_REL, "lib/index.js"));
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const bin = join(dir, "dsh");
    if (!existsSync(bin)) continue;
    let prefix: string;
    try {
      prefix = dirname(dirname(realpathSync(bin))); // <prefix>/bin/dsh → <prefix>
    } catch {
      continue;
    }
    push(withDeps(join(prefix, "lib/node_modules/@deepseek-ai/dsh")));
    push(join(prefix, "lib/node_modules", PKG_REL, "lib/index.js"));
  }
  const globalRoots: string[] = [];
  if (process.env.npm_config_prefix) globalRoots.push(join(process.env.npm_config_prefix, "lib/node_modules"));
  globalRoots.push("/usr/lib/node_modules", "/usr/local/lib/node_modules", join(homedir(), ".npm-global/lib/node_modules"));
  for (const root of globalRoots) push(withDeps(join(root, "@deepseek-ai/dsh")));
  // 版本管理器（fnm / nvm）
  for (const base of [join(homedir(), ".local/share/fnm/node-versions"), join(homedir(), ".nvm/versions/node")]) {
    if (!existsSync(base)) continue;
    for (const v of readdirSync(base)) {
      push(withDeps(join(base, v, "installation/lib/node_modules/@deepseek-ai/dsh")));
      push(withDeps(join(base, v, "lib/node_modules/@deepseek-ai/dsh")));
    }
  }
  return out;
}

type RealRenderer = { renderPrompt: (assembly: any) => string; version: string; path: string };

/** 实测边界：`interpolate: false` 自 @deepseek-ai/dsh-system-prompt 0.1.6-alpha.1 起被认可。 */
const INTERPOLATE_OPTOUT_MIN = "0.1.6-alpha.1";

/** 版本比较（只处理本包 x.y.z[-pre] 形态；正式版 > 预发布，预发布按字符串序 alpha<rc）。 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ""] = v.split("-");
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** 能力探测：找得到就读真实 renderer，找不到返回 null（调用方显式 skip）。 */
async function loadRealRenderer(): Promise<RealRenderer | null> {
  for (const path of rendererCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const mod: any = await import(pathToFileURL(path).href);
      if (typeof mod?.renderPrompt !== "function") continue;
      const pkgPath = join(dirname(dirname(path)), "package.json");
      const version = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")).version : "unknown";
      return { renderPrompt: mod.renderPrompt, version, path };
    } catch {
      continue; // 依赖不全/加载失败：换下一个候选
    }
  }
  return null;
}

/** 用 mock ctx 跑真实 apply，捕获本插件注册的 section 及其渲染结果（含变量/context 注册探测）。 */
function captureGraphSections() {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g389-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  // 三类合法记忆正文：未注册变量名 / 已注册同名变量 / 模板标点
  addMemory(root, { kind: "project", scope: "standing", text: "模板示例 {{customer_name}} 必须逐字保留。", actor: "human:gui" });
  addMemory(root, { kind: "project", scope: "standing", text: "已注册同名变量 {{goal}} 不得被替换。", actor: "agent:test" });
  addMemory(root, { kind: "project", scope: "standing", text: "模板标点 {{ 与 }} 以及 {{{{nested}}}} 逐字保留。", actor: "agent:test" });

  const sections: any[] = [];
  const registeredVariables: string[] = [];
  const registeredContexts: string[] = [];
  const ctx: any = {
    get: (key: string) =>
      key === "systemPrompt"
        ? {
            section: (s: any) => {
              sections.push(s);
              return () => {};
            },
            variable: (name: string) => {
              registeredVariables.push(name);
              return () => {};
            },
            context: (c: any) => {
              registeredContexts.push(c?.name);
              return () => {};
            },
          }
        : undefined,
    effect: (fn: () => unknown) => fn(),
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  const renderCtx = { agent: { session: { id: "g389-audit", header: { cwd: ws } } } };
  const captured: CapturedSection[] = sections
    .filter((s) => typeof s?.name === "string" && s.name.startsWith("dsh-graph-"))
    .map((s) => {
      const text = typeof s.text === "function" ? s.text(renderCtx) : s.text;
      return { name: s.name, order: s.order, text, ...(s.interpolate === undefined ? {} : { interpolate: s.interpolate }) };
    });
  return { ws, root, captured, registeredVariables, registeredContexts };
}

test("g-389：审计范围钉住——本插件 3 个 section 全部 interpolate:false，且不注册变量/context", () => {
  const { captured, registeredVariables, registeredContexts } = captureGraphSections();
  assert.deepEqual(
    captured.map((s) => s.name).sort(),
    EXPECTED_GRAPH_SECTIONS,
    "本插件 section 清单变化 ⇒ 必须重新分类字面量/真模板（并更新 g-389 审计记录）",
  );
  for (const s of captured) {
    assert.equal(s.interpolate, false, `${s.name} 必须显式 interpolate:false（字面量 section）`);
  }
  assert.deepEqual(registeredVariables, [], "本插件不得注册 prompt 变量（否则某个 section 可能是真模板）");
  assert.deepEqual(registeredContexts, [], "本插件不得注册 prompt context（context 无逐字保留开关）");
  // 记忆确实被渲染进来（否则下面的字面量断言会退化成空文本空转）
  const mem = captured.find((s) => s.name === "dsh-graph-standing-memory");
  assert.ok(mem && mem.text.includes("{{customer_name}}") && mem.text.includes("{{goal}}"), "记忆正文应包含模板示例");
  assert.ok(mem.text.includes("{{ 与 }}") && mem.text.includes("{{{{nested}}}}"), "记忆正文应包含模板标点");
});

test("g-389：真实宿主 renderer 下字面量 section 逐字保留（未注册/已注册同名/模板标点）", async (t) => {
  const renderer = await loadRealRenderer();
  if (!renderer) {
    t.skip("未解析到本机 @deepseek-ai/dsh-system-prompt（仓储测试环境不装 @deepseek-ai/*）：真实 renderer 集成断言未执行");
    return;
  }
  t.diagnostic(`g-389 真实宿主 renderer：${PKG_REL}@${renderer.version} @ ${renderer.path}`);

  // 旧宿主一侧（engines 下界 0.1.5-rc.2/rc.3）：该字段被忽略 ⇒ 本修复不生效（已实测的已知缺口）。
  // 此处把该事实钉成断言（旧 renderer 仍抛 unknown prompt variable），不伪装成绿。
  if (compareVersions(renderer.version, INTERPOLATE_OPTOUT_MIN) < 0) {
    t.diagnostic(`已知兼容缺口：renderer ${renderer.version} < ${INTERPOLATE_OPTOUT_MIN}，忽略 interpolate:false；字面量保留断言在旧宿主不适用`);
    assert.throws(
      () => renderer.renderPrompt({ sections: [{ name: "mem", text: "模板 {{customer_name}} 保留", interpolate: false }], variables: {}, contexts: [], tools: [] }),
      /unknown prompt variable/,
      "旧宿主忽略 interpolate:false：逐字保留不生效（缺口事实断言）",
    );
    const { captured: oldCapture } = captureGraphSections();
    assert.throws(
      () => renderer.renderPrompt({ sections: oldCapture, variables: {}, contexts: [], tools: [] }),
      /unknown prompt variable "\{\{customer_name\}\}" in section "dsh-graph-standing-memory"/,
      "旧宿主上真实捕获的常驻记忆仍会抛错（P1 在旧宿主一侧未修复，属已记录的兼容缺口）",
    );
    return;
  }

  const { captured } = captureGraphSections();
  const mem = captured.find((s) => s.name === "dsh-graph-standing-memory");
  assert.ok(mem);
  const guide = captured.find((s) => s.name === "dsh-graph-guide-hint");
  assert.ok(guide && guide.text.length > 0, "guide-hint 恒渲染，非空");

  // 反向变量表：customer_name / goal 都是"已注册"的同名变量（最凶的静默替换场景）
  const variables = { customer_name: "ACME-CORP", goal: "g-999" };
  const assembly = { sections: captured, variables, contexts: [], tools: [] };
  const rendered = renderer.renderPrompt(assembly); // 判据 1：不得抛插值错误
  assert.ok(rendered.includes("{{customer_name}}"), "未注册名模板必须逐字保留");
  assert.ok(rendered.includes("{{goal}}"), "已注册同名变量位置必须逐字保留（不得静默替换）");
  assert.ok(rendered.includes("{{ 与 }}") && rendered.includes("{{{{nested}}}}"), "模板标点必须逐字保留");
  assert.ok(!rendered.includes("ACME-CORP"), "正文不得出现被替换进来的变量值");
  assert.ok(!rendered.includes("g-999"), "已注册同名变量不得改写正文");
  assert.ok(rendered.includes(guide.text), "guide-hint 正文逐字保留");

  // 负向对照 A：剥掉 interpolate（= 修复前形态）+ 变量未注册（= 事故现场）⇒ 真实 renderer 立即抛错
  const preFix = captured.map(stripInterpolate);
  assert.throws(
    () => renderer.renderPrompt({ ...assembly, sections: preFix, variables: {} }),
    /unknown prompt variable "\{\{customer_name\}\}" in section "dsh-graph-standing-memory"/,
    "去掉 interpolate:false 后必须复现 unknown prompt variable（本用例转红的前提）",
  );
  // 负向对照 B：修复前形态 + 同名变量已注册 ⇒ 静默替换（用户数据被篡改）确实会发生
  const substituted = renderer.renderPrompt({
    sections: [{ name: "dsh-graph-standing-memory", text: "已注册同名变量 {{goal}} 不得被替换。" }],
    variables: { goal: "g-999" },
    contexts: [],
    tools: [],
  });
  assert.equal(substituted, "已注册同名变量 g-999 不得被替换。", "宿主默认插值的替换语义（本修复要防的第二种失效）");
  // 同一个正文在修复后（interpolate:false）逐字保留
  assert.equal(
    renderer.renderPrompt({
      sections: [{ name: "dsh-graph-standing-memory", text: "已注册同名变量 {{goal}} 不得被替换。", interpolate: false }],
      variables: { goal: "g-999" },
      contexts: [],
      tools: [],
    }),
    "已注册同名变量 {{goal}} 不得被替换。",
  );

  // 判据 2：真正模板 section（默认 interpolate=缺省 true）仍按原契约插值——未全局禁用
  assert.equal(
    renderer.renderPrompt({
      sections: [
        { name: "host-real-template", text: "goal={{goal}} n={{n}}" },
        { name: "dsh-graph-standing-memory", text: mem.text, interpolate: false },
      ],
      variables: { goal: "g-1", n: "2" },
      contexts: [],
      tools: [],
    }),
    `goal=g-1 n=2\n\n${mem.text}`,
    "真模板 section 照旧插值，且与字面量 section 共存",
  );
});
