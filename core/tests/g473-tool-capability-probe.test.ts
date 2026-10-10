/**
 * g-473：harness 工具名依赖（shell 名解析 / 白名单求交 / 缺能力诊断）专项套件。
 *
 * 缺陷：DSH 在 win32 上**不注册** `bash`（注册 `pwsh`），而 `@deepseek-ai/dsh-tools` 的
 * `restrict()` 对未知名硬抛错（`tools.restrict() names unknown global tool "X"`）。
 * 修复前本插件把 shell 名硬编码进角色白名单 / 必需清单 / 文案 ⇒ Windows 上
 * reviewer / collector / executor-minimal 三条派发路径**必然**起不来。
 *
 * ## 断言面（与验收判据一一对应）
 *
 * - 判据 1/2：四种探针组合（bash-only / pwsh-only / both / neither）× 三条受影响路径
 *   （reviewer standard+minimal、collector standard+minimal、executor minimal）下，
 *   过滤器里**没有任何未知名**——用 dsh-tools 的接受性语义断言：
 *   `restrict()` 只接受 `restrictableNames ⊆ 探针为真的名字集合`，
 *   故「过滤器集合 ⊆ 探针为真集合」等价于「restrict() 必不抛错」。
 *   缺 `dsh-tool-web`（web_* 不可用）时**静默剔除**且不阻断派发。
 * - 判据 3：缺必需工具（含缺 shell）⇒ 可读诊断点名缺失项 + 探针来源 + 候选与回落值，
 *   且**不得派发**（本套件断言诊断 `ok === false` 与文案要素；宿主侧「不派发」由返回
 *   `child_error` / `review.failed` 接线承担，见 dsh-graph-host/index.js 的 capabilityBlock）。
 * - 判据 4：`standard: undefined` 语义不回归（executor/supervisor 不裁剪）；
 *   pm/summarizer 白名单不被无谓收紧（只在探针明确不可用时剔除）。
 * - 判据 5：负向对照——把探针回退成硬编码 `bash`（修复前形态）必须判红：
 *   ① 静态清单侧：硬编码清单在 pwsh-only 组合下必然提交未知名；
 *   ② 源码侧：`core/ops.ts` 中带引号的 `"bash"` 只允许出现在候选表与平台回落两处。
 * - 判据 6：文案侧零残留——模式片段 / 评审 prompt 渲染后不得残留 `{{shell}}`，
 *   且点名**本组合解析出的** shell（不再硬编码）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DISPATCH_CAPABILITY_MISSING_EVENT,
  GRAPH_MINIMAL_ALLOWED_TOOLS,
  ROLE_PROFILES,
  SHELL_TOOL_CANDIDATES,
  SHELL_TOOL_SLOT,
  SHELL_TOOL_TOKEN,
  addCard,
  createGoal,
  diagnoseDispatchCapability,
  expandRoleToolList,
  formatReviewPrompt,
  getRoleProfile,
  init,
  isWindows,
  renderShellToolText,
  resolveShellTool,
  setCriteria,
  subagentModePrompt,
  toolFilterForRole,
  withPlatformForTesting,
  type ToolCapabilityContext,
} from "../ops.ts";
import { apply } from "../../dist/index.js";

/** 真实 preset 平面（非 shell 部分）：两条平台分支共有的模型面向工具 + 本插件全局工具 + dsh-tool-web。 */
const BASE_TOOLS = [
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "graph_report_status",
  "graph_transition",
  "graph_fill_card",
  "graph_store_attachment",
  "graph_memory_recall",
  "graph_refresh_results",
  "graph_report_supervisor_status",
  "graph_start_attempt",
  "graph_resolve_accept",
] as const;

/** 组合构造器：探针 = 平台真实注册集（可显式删掉某类工具，模拟缺 dsh-tool-web / 缺 shell）。 */
function cap(opts: { shells?: readonly string[]; without?: readonly string[]; platform?: string } = {}): {
  cap: ToolCapabilityContext;
  availableTruth: Set<string>;
} {
  const names = new Set<string>(BASE_TOOLS);
  for (const s of opts.shells ?? []) names.add(s);
  for (const w of opts.without ?? []) names.delete(w);
  return {
    availableTruth: names,
    cap: { available: (n: string) => names.has(n), platform: opts.platform ?? "win32" },
  };
}

/** dsh-tools 语义：`restrict()` 接受的名字集合 ⊆ 探针为真的集合 ⇒ 差集必须为空。 */
function unknownNames(filter: readonly string[] | undefined, truth: Set<string>): string[] {
  return (filter ?? []).filter((n) => !truth.has(n));
}

const PATHS = ["reviewer", "collector"] as const;

const COMBOS: Array<{ id: string; shells: readonly string[]; platform: string; expectShell: string | null }> = [
  { id: "bash-only(Linux/WSL)", shells: ["bash"], platform: "linux", expectShell: "bash" },
  { id: "pwsh-only(win32)", shells: ["pwsh"], platform: "win32", expectShell: "pwsh" },
  { id: "both(防御性：候选表首个优先)", shells: ["bash", "pwsh"], platform: "win32", expectShell: "bash" },
  { id: "neither(缺 shell)", shells: [], platform: "win32", expectShell: null },
];

// ============================================================================
// 判据 1/2：四组合 × 三路径 —— 过滤器无未知名 + shell 恰为解析结果
// ============================================================================

test("g-473 判据 1/2：四组合 × reviewer/collector/executor-minimal 过滤器零未知名，且 shell 恰为解析结果", () => {
  for (const combo of COMBOS) {
    const { cap: c, availableTruth } = cap({ shells: combo.shells, platform: combo.platform });
    const resolved = resolveShellTool(c);
    assert.equal(resolved.name, combo.expectShell, `${combo.id}：shell 解析结果不符（source=${resolved.source}）`);
    assert.equal(
      resolved.source,
      combo.expectShell ? "probe" : "probe-missing",
      `${combo.id}：有探针时必须由探针判定（不得回落平台）`,
    );

    for (const role of PATHS) {
      for (const mode of ["standard", "minimal"] as const) {
        const filter = toolFilterForRole(role, mode, c);
        const allow = filter?.allow ?? [];
        assert.deepEqual(unknownNames(allow, availableTruth), [], `${combo.id}/${role}/${mode}：过滤器出现未知名 ⇒ Windows 上 restrict() 必抛错`);
        assert.ok(!allow.includes(SHELL_TOOL_SLOT), `${combo.id}/${role}/${mode}：过滤器不得残留 shell 槽位`);
        const shells = allow.filter((n) => (SHELL_TOOL_CANDIDATES as readonly string[]).includes(n));
        if (combo.expectShell) {
          assert.deepEqual(shells, [combo.expectShell], `${combo.id}/${role}/${mode}：白名单里应恰有一个解析出的 shell`);
        } else {
          assert.deepEqual(shells, [], `${combo.id}/${role}/${mode}：缺 shell 时白名单不得留任何 shell`);
        }
      }
    }

    // executor minimal：受控 6 项，壳位=解析结果（缺 shell 时整条剔除）
    const execMinimal = toolFilterForRole("executor", "minimal", c)?.allow ?? [];
    assert.deepEqual(unknownNames(execMinimal, availableTruth), [], `${combo.id}/executor/minimal：过滤器出现未知名`);
    assert.equal(execMinimal.length, combo.expectShell ? 6 : 5, `${combo.id}/executor/minimal：工具数不符`);
    assert.deepEqual(execMinimal.filter((n) => n === "edit" || n === "read" || n === "write"), ["edit", "read", "write"], `${combo.id}：非 shell 基础工具必须逐字保留`);
  }
});

test("g-473 判据 2：缺 dsh-tool-web（web_* 不可用）⇒ 静默剔除且正常派发，其余名单不收紧", () => {
  const { cap: c, availableTruth } = cap({ shells: ["bash"], without: ["web_search", "web_fetch"], platform: "linux" });
  const allow = toolFilterForRole("collector", "standard", c)?.allow ?? [];
  assert.deepEqual(unknownNames(allow, availableTruth), [], "剔除后仍不得出现未知名");
  assert.ok(!allow.includes("web_search") && !allow.includes("web_fetch"), "缺 web 工具时必须静默剔除 web_*");
  // 静默 = 不阻断派发：web_* 不是必需工具 ⇒ 诊断通过
  const diag = diagnoseDispatchCapability("collector", "standard", c);
  assert.equal(diag.ok, true, "缺可选工具（web_*）不得阻断派发");
  assert.deepEqual(diag.missing, [], "缺可选工具不得进入缺失清单");
  // 其余声明过的名字（探针为真者）逐字保留，且顺序不漂移
  const declared = getRoleProfile("collector").allowedTools.standard as readonly string[];
  const expect = declared.map((n) => (n === SHELL_TOOL_SLOT ? "bash" : n)).filter((n) => availableTruth.has(n));
  assert.deepEqual(allow, expect, "求交只剔除不可用者，不得改动其余名字与顺序");
});

test("g-473 判据 1：探针优先于平台（探针在场时绝不按平台硬编码），无探针才回落平台默认", () => {
  // 探针说 pwsh 可用但平台写成 linux ⇒ 结果必须是 pwsh（探针优先）
  assert.equal(resolveShellTool({ available: (n) => n === "pwsh", platform: "linux" }).name, "pwsh");
  // 探针说 bash 可用但平台写成 win32 ⇒ 结果必须是 bash
  assert.equal(resolveShellTool({ available: (n) => n === "bash", platform: "win32" }).name, "bash");
  // 无探针 ⇒ 平台回落
  assert.deepEqual(resolveShellTool({ platform: "win32" }), { name: "pwsh", source: "platform-fallback", candidates: SHELL_TOOL_CANDIDATES, platform: "win32" });
  assert.deepEqual(resolveShellTool({ platform: "linux" }), { name: "bash", source: "platform-fallback", candidates: SHELL_TOOL_CANDIDATES, platform: "linux" });
  // 完全无上下文 ⇒ 读 process.platform（win32 上是 pwsh）
  assert.equal(resolveShellTool().name, process.platform === "win32" ? "pwsh" : "bash");
  // 候选表顺序即优先级：both 组合解析 bash
  assert.equal(resolveShellTool({ available: () => true }).name, SHELL_TOOL_CANDIDATES[0]);
});

// ============================================================================
// 判据 3：缺必需能力 ⇒ 可读诊断（点名缺失项 + 探针来源 + 候选与回落值）
// ============================================================================

test("g-473 判据 3：缺 shell / 缺 read 产出可读诊断，点名缺失项与探针来源、候选与回落值", () => {
  const noShell = cap({ shells: [], platform: "win32" });
  const d1 = diagnoseDispatchCapability("reviewer", "standard", noShell.cap);
  assert.equal(d1.ok, false, "缺 shell 必须判不通过（调用方据此不派发）");
  assert.deepEqual(d1.missing, ["shell(bash | pwsh)"], "缺失清单必须点名 shell 候选（任一即可）");
  const m1 = String(d1.message);
  assert.match(m1, /role=reviewer/, "诊断必须点名角色");
  assert.match(m1, /mode=standard/, "诊断必须点名模式");
  assert.match(m1, /shell\(bash \| pwsh\)/, "诊断必须点名缺失的 shell 候选");
  assert.match(m1, /tools\.get\(name, parentAgent\)/, "诊断必须点名探针来源");
  assert.match(m1, /win32→pwsh/, "诊断必须给出平台回落值");
  assert.match(m1, /platform=win32/, "诊断必须给出实际平台");
  assert.doesNotMatch(m1, /names unknown global tool/, "不得把 dsh-tools 内部错误原文当作用户文案");

  // 缺非 shell 必需工具
  const noRead = cap({ shells: ["bash"], without: ["read"], platform: "linux" });
  const d2 = diagnoseDispatchCapability("reviewer", "standard", noRead.cap);
  assert.equal(d2.ok, false, "缺 read 必须判不通过");
  assert.deepEqual(d2.missing, ["read"], "缺失清单必须点名 read");
  assert.match(String(d2.message), /"read"/);

  // executor：缺 edit 时同样必须点名（三档必需工具口径一致）
  const noEdit = cap({ shells: ["bash"], without: ["edit"], platform: "linux" });
  assert.deepEqual(diagnoseDispatchCapability("executor", "minimal", noEdit.cap).missing, ["edit"]);

  // 无探针（legacy 调用方）⇒ 无法判定 ⇒ 不得误阻断
  const legacy = diagnoseDispatchCapability("reviewer", "standard", undefined);
  assert.equal(legacy.ok, true, "无探针时必须保持既有行为（不阻断派发）");
  assert.deepEqual(legacy.missing, []);
  // 无探针 + 平台 win32：shell 依然解析为 pwsh（平台回落），不是「缺 shell」
  const legacyWin = diagnoseDispatchCapability("reviewer", "standard", { platform: "win32" });
  assert.equal(legacyWin.ok, true);
  assert.equal(legacyWin.shell.name, "pwsh");
});

test("g-473 判据 3：能力自检不影响非必需角色（pm/summarizer 无 shell 槽位，白名单不被无谓收紧）", () => {
  for (const combo of COMBOS) {
    const { cap: c, availableTruth } = cap({ shells: combo.shells, platform: combo.platform });
    for (const role of ["pm", "summarizer"] as const) {
      const diag = diagnoseDispatchCapability(role, "standard", c);
      assert.equal(diag.ok, true, `${combo.id}/${role}：无 shell 槽位的角色不得因缺 shell 被阻断`);
      assert.deepEqual(diag.missing, [], `${combo.id}/${role}：缺失清单必须为空`);
      const allow = toolFilterForRole(role, "standard", c)?.allow ?? [];
      assert.deepEqual(unknownNames(allow, availableTruth), [], `${combo.id}/${role}：过滤器出现未知名`);
      assert.ok(!allow.some((n) => (SHELL_TOOL_CANDIDATES as readonly string[]).includes(n)), `${combo.id}/${role}：不得被无谓加入 shell`);
    }
  }
});

// ============================================================================
// 判据 4：standard: undefined 语义不回归；求交不新增/重排名字
// ============================================================================

test("g-473 判据 4：executor/supervisor standard 仍为 undefined（不裁剪），minimal 恰为声明表展开", () => {
  for (const combo of COMBOS) {
    const { cap: c } = cap({ shells: combo.shells, platform: combo.platform });
    assert.equal(toolFilterForRole("executor", "standard", c), undefined, `${combo.id}：executor standard 必须不裁剪`);
    assert.equal(toolFilterForRole("executor", null, c), undefined, `${combo.id}：缺省模式等同 standard`);
    assert.equal(toolFilterForRole("supervisor", "standard", c), undefined, `${combo.id}：supervisor standard 必须不裁剪`);
  }
  // 求交只做「剔除」：结果集必须是声明集（槽位展开后）的保序子序列
  const declared = ROLE_PROFILES.collector.allowedTools.standard as readonly string[];
  const { cap: c } = cap({ shells: ["pwsh"], without: ["graph_memory_recall"], platform: "win32" });
  const expanded = declared.map((n) => (n === SHELL_TOOL_SLOT ? "pwsh" : n));
  const allow = toolFilterForRole("collector", "standard", c)?.allow ?? [];
  let i = 0;
  for (const n of allow) {
    while (i < expanded.length && expanded[i] !== n) i++;
    assert.ok(i < expanded.length, `求交结果出现声明表里没有（或顺序漂移）的名字：${n}`);
    i++;
  }
  assert.ok(allow.includes("pwsh") && !allow.includes("graph_memory_recall"), "求交语义：可用者保留、不可用者剔除");
  // expandRoleToolList 去重 + 槽位展开（求交语义：不可用者一律剔除，含非 shell 名）
  assert.deepEqual(expandRoleToolList([SHELL_TOOL_SLOT, SHELL_TOOL_SLOT, "read"], { available: (n) => n === "pwsh" || n === "read" }), ["pwsh", "read"]);
  assert.deepEqual(expandRoleToolList([SHELL_TOOL_SLOT, "read"], { available: (n) => n === "pwsh" }), ["pwsh"], "探针为 false 的非 shell 名同样被剔除（这就是「缺 dsh-tool-web ⇒ 静默剔除」的同一机制）");
  assert.deepEqual(expandRoleToolList(GRAPH_MINIMAL_ALLOWED_TOOLS), [
    resolveShellTool().name,
    "edit",
    "read",
    "write",
    "graph_report_status",
    "graph_transition",
  ]);
});

// ============================================================================
// 判据 5：负向对照 —— 回退成硬编码 bash 必红
// ============================================================================

test("g-473 判据 5 负向对照①：修复前的硬编码 bash 清单在 pwsh-only 组合下必然提交未知名", () => {
  // 事故形态（修复前）：reviewer standard / minimal 与 executor minimal 白名单里写死 "bash"。
  const legacyFilters = {
    "reviewer:standard": ["read", "glob", "grep", "bash", "graph_memory_recall", "web_search", "web_fetch"],
    "reviewer:minimal": ["read", "bash"],
    "collector:minimal": ["read", "bash", "web_search", "web_fetch", "graph_fill_card", "graph_store_attachment"],
    "executor:minimal": ["bash", "edit", "read", "write", "graph_report_status", "graph_transition"],
  } as const;
  const win = cap({ shells: ["pwsh"], platform: "win32" });
  for (const [label, list] of Object.entries(legacyFilters)) {
    assert.deepEqual(unknownNames(list, win.availableTruth), ["bash"], `${label}：负向对照必须判红（否则本套件无判别力）`);
  }
  // 修复后同一组合：零未知名（同一输入维度上的一红一绿）
  for (const [label, role] of [["reviewer:standard", "reviewer"], ["reviewer:minimal", "reviewer"], ["collector:minimal", "collector"], ["executor:minimal", "executor"]] as const) {
    const mode = label.endsWith("minimal") ? "minimal" : "standard";
    const allow = toolFilterForRole(role, mode, win.cap)?.allow ?? [];
    assert.deepEqual(unknownNames(allow, win.availableTruth), [], `${label}：修复后不得出现未知名`);
    assert.ok(allow.includes("pwsh"), `${label}：必须换成探针解析出的 pwsh`);
  }
});

test("g-473 判据 5 负向对照②：core/ops.ts 里带引号的 \"bash\" 只允许出现在候选表与平台回落两处", () => {
  const src = readFileSync(join(import.meta.dirname, "../ops.ts"), "utf8");
  // 与验收判据 1 的 grep 同口径（`grep -rn '"bash"' core/ops.ts`）
  const hits = src
    .split("\n")
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter(({ line }) => line.includes('"bash"'));
  assert.deepEqual(
    hits.map((h) => h.line),
    ['export const SHELL_TOOL_CANDIDATES = ["bash", "pwsh"] as const;', 'name: platform === "win32" ? "pwsh" : "bash",'],
    `带引号的 "bash" 只允许出现在候选表与平台回落（实际命中：${hits.map((h) => `${h.no}:${h.line}`).join(" | ")}）`,
  );
  // 负向对照：把声明表改回硬编码（修复前形态）⇒ 命中数与内容都变 ⇒ 守卫必红
  const reverted = src.replace('SHELL_TOOL_SLOT,\n  "edit"', '"bash",\n  "edit"');
  assert.notEqual(reverted, src, "负向对照锚点必须命中（否则对照静默失效）");
  const revertedHits = reverted
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes('"bash"'));
  assert.equal(revertedHits.length, hits.length + 1, "回退成硬编码后命中数必须增加 ⇒ 守卫判红");
});

// ============================================================================
// 判据 6：文案侧零残留 —— 渲染后点名本组合解析出的 shell
// ============================================================================

test("g-473 判据 6：模式片段 / 评审 prompt 渲染后零 {{shell}} 残留，且点名解析出的 shell", () => {
  for (const combo of COMBOS) {
    const { cap: c } = cap({ shells: combo.shells, platform: combo.platform });
    const shell = resolveShellTool(c).name ?? "shell";

    const zh = subagentModePrompt("minimal", "zh", c);
    const en = subagentModePrompt("minimal", "en", c);
    for (const [label, text] of [["zh", zh], ["en", en]] as const) {
      assert.ok(!text.includes(SHELL_TOOL_TOKEN), `${combo.id}/mode-${label}：渲染后残留占位符`);
      assert.ok(text.includes(shell), `${combo.id}/mode-${label}：必须点名解析出的 shell（${shell}）`);
    }

    const rev = formatReviewPrompt({
      goalId: "g-473",
      attemptId: "att-001",
      goalRel: ".dsh-graph/goals/g-473/goal.md",
      shellTool: shell,
    });
    assert.ok(!rev.includes(SHELL_TOOL_TOKEN), `${combo.id}/review：渲染后残留占位符`);
    assert.ok(rev.includes(`${shell} 权限说明`), `${combo.id}/review：中文权限说明必须点名解析出的 shell`);
    const revEn = formatReviewPrompt({
      goalId: "g-473",
      attemptId: "att-001",
      goalRel: ".dsh-graph/goals/g-473/goal.md",
      language: "en",
      shellTool: shell,
    });
    assert.ok(revEn.includes(`- ${shell}, when available`), `${combo.id}/review-en：英文权限说明必须点名解析出的 shell`);
  }
  // 角色 profile 文案：占位符渲染后不得残留，且点名解析结果
  for (const role of ["executor", "collector", "reviewer"] as const) {
    const note = getRoleProfile(role).bashPermissionNote;
    assert.ok(note && note.includes(SHELL_TOOL_TOKEN), `${role}：权限说明应以占位符表达 shell 名`);
    const resolved = resolveShellTool({ available: (n) => n === "pwsh" });
    assert.equal(resolved.name, "pwsh");
    const rendered = renderShellToolText(note!, resolved);
    assert.ok(!rendered.includes(SHELL_TOOL_TOKEN), `${role}：渲染后残留占位符`);
    assert.ok(rendered.includes("pwsh"), `${role}：渲染后必须点名探针解析出的 pwsh`);
  }
});

test("g-473：平台回落走 platform.ts 的唯一注入点（setPlatformForTesting 能模拟 win32 ⇒ 回落 pwsh）", () => {
  // 无探针时才读平台；注入 win32 ⇒ pwsh，恢复后 ⇒ bash。证明 core 未自行读 process.platform（g-284 结构守卫）。
  const win = withPlatformForTesting("win32", () => resolveShellTool({}));
  assert.deepEqual(win, { name: "pwsh", source: "platform-fallback", candidates: SHELL_TOOL_CANDIDATES, platform: "win32" });
  const lin = withPlatformForTesting("linux", () => resolveShellTool());
  assert.deepEqual(lin, { name: "bash", source: "platform-fallback", candidates: SHELL_TOOL_CANDIDATES, platform: "linux" });
  assert.equal(isWindows(), false, "作用域注入必须自动恢复");
  // 注入平台下白名单与必需清单同样按注入值展开（executor minimal 的首项 = pwsh）
  const allow = withPlatformForTesting("win32", () => toolFilterForRole("executor", "minimal", {})?.allow ?? []);
  assert.equal(allow[0], "pwsh");
  assert.equal(allow.length, 6, "注入平台不得改变工具数（无探针 ⇒ 不裁剪）");
});

test("g-473：诊断事件名稳定（宿主据此记事件；改名即破坏看板可观测性）", () => {
  assert.equal(DISPATCH_CAPABILITY_MISSING_EVENT, "dispatch.capability_missing");
});

// ============================================================================
// 判据 3（宿主端）：经真实 graph_start_attempt 派发 —— 缺能力不派发 + 事件留痕；
// 缺可选工具静默剔除且正常派发；探针必须按 **scope** 探测（g-473 的关键裁决）
// ============================================================================

/** 夹具：`tools.get(name, scope)` 由 `availableSet` 决定真假，并记录每次探测的入参。 */
function makeDispatchHarness(availableSet: Set<string>) {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g473-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const spawned: any[] = [];
  const registered: any[] = [];
  const probeCalls: Array<{ name: string; scope: unknown }> = [];
  const agent = { id: "sess-super" };
  const ctx: any = {
    get: (name: string) => {
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => agent };
      if (name === "settings") return { get: () => undefined };
      if (name === "subagents") {
        return {
          list: () => ["spawn"],
          getProvider: () => ({ prepareContinuable: () => {} }),
          startContinuable: async (opts: any) => {
            spawned.push(opts);
            return { childId: `child-${spawned.length}`, parentSessionId: "sess-super" };
          },
        };
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer: { register: () => () => {} },
    tools: {
      register: (def: any) => { registered.push(def); return () => {}; },
      get: (name: string, scope: unknown) => {
        probeCalls.push({ name, scope });
        return availableSet.has(name) ? { name } : undefined;
      },
    },
  };
  apply(ctx, { root });
  // 主管会话必须在 project.yaml 里登记（reviewer/summarizer 经 resolveSpawnParent 取 live Agent）
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  // 工具入口用 `ex.agent` 作为父作用域（也是探针 scope key），故必须传真实调用上下文。
  const exec = { agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-exec" } }, signal: new AbortController().signal };
  return { ws, root, spawned, registered, probeCalls, agent, exec };
}

function dispatchTool(h: ReturnType<typeof makeDispatchHarness>) {
  const tool = h.registered.find((d: any) => d.name === "graph_start_attempt");
  assert.ok(tool, "graph_start_attempt 必须已注册");
  return tool;
}

test("g-473 判据 3（宿主端）：探针说缺 shell ⇒ 记 dispatch.capability_missing、零副作用、不派发子代理", async () => {
  // win32 形态：read/write/edit 等都在，但两个 shell 候选都不可用（模拟 preset 两边都没注册）
  const h = makeDispatchHarness(new Set(BASE_TOOLS));
  const goal = createGoal(h.root, { title: "g-473 no shell", version: "v-g473", actor: "human:test" });
  setCriteria(h.root, goal, ["criterion one"], "human:test");

  const res: any = await dispatchTool(h).execute({ goal, mode: "minimal" }, h.exec);

  assert.ok(res.child_error, `缺 shell 时必须给出可读诊断，实际返回：${JSON.stringify(res).slice(0, 300)}`);
  assert.match(String(res.child_error), /shell\(bash \| pwsh\)/, "诊断必须点名缺失的 shell 候选");
  assert.match(String(res.child_error), /tools\.get\(name, parentAgent\)/, "诊断必须点名探针来源");
  assert.equal(res.attempt, null, "零副作用：不得创建 attempt");
  assert.equal(h.spawned.length, 0, "零副作用：不得启动子代理");

  // 事件留痕（事件先行）：dispatch.capability_missing 必须落盘，且带 missing/shell 事实
  const events = readFileSync(join(h.root, "events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ev = events.find((e: any) => e.event === DISPATCH_CAPABILITY_MISSING_EVENT);
  assert.ok(ev, `必须记 ${DISPATCH_CAPABILITY_MISSING_EVENT} 事件（失败可观测）`);
  assert.equal(ev.actor, "system:dispatch");
  assert.equal(ev.goal, goal);
  assert.equal(ev.details.role, "executor");
  assert.equal(ev.details.mode, "minimal");
  assert.deepEqual(ev.details.missing, ["shell(bash | pwsh)"]);
  assert.equal(ev.details.shell_resolved, null, "事件必须留痕「没解析出 shell」");
  assert.equal(ev.details.shell_source, "probe-missing", "事件必须留痕判定来源（探针在场但候选全不可用）");
  assert.deepEqual(ev.details.shell_candidates, [...SHELL_TOOL_CANDIDATES]);

  // 探针必须按 **scope** 探测（Agent 实例即 scope key）：无 scope 的 get 只看 global 层 ⇒ 在真实
  // 宿主上会把 preset 平面的工具全判 false（比 Windows 缺陷更糟）。这是本目标的关键裁决。
  assert.ok(h.probeCalls.length > 0, "必须真的走了探针");
  assert.ok(h.probeCalls.every((c) => Boolean(c.scope)), "每次 tools.get 都必须带 scope（父 Agent），不得用无 scope 的全局视图");
  const shellProbes = h.probeCalls.filter((c) => (SHELL_TOOL_CANDIDATES as readonly string[]).includes(c.name)).map((c) => c.name);
  assert.deepEqual(shellProbes, ["bash", "pwsh"], "shell 候选按候选表顺序探测（首个可用者胜；本组合两个都不可用）");
  assert.equal(h.probeCalls[0].name, "bash", "首个探测必须是候选表首项（顺序即优先级，不得先问平台）");
});

// ============================================================================
// 探针 scope 语义钉成用例（防退回无 scope 写法）
//
// 背景（att-001 对真实包的四层拓扑实测，主管已复核）：`tools.get(name)` **不传 scope 只看 global 层**，
// 而模型面向工具注册在 agent preset 平面（祖先层）⇒ 无 scope 探针会把 bash/read/… 全判 false，
// 在 **Linux 上**也会拦下 reviewer/collector/minimal（比原缺陷更严重）。`view()` 是 private，不可用。
// 故：宿主 5 处派发点一律 `tools.get(name, <该处 parent Agent>)`，core 侧只消费纯函数。
// ============================================================================

test("g-473：四层拓扑仿真——无 scope 探针在 Linux 上也会全判缺失（本修复的存在理由）", () => {
  // 仿真：global 层（插件工具）+ preset 层（模型面向工具，注册在祖先 scope 上）
  const GLOBAL = new Set(["graph_report_status", "graph_transition", "graph_start_review"]);
  const PRESET = new Set([...BASE_TOOLS, "bash", "glob", "grep"]);
  const visible = (scope: string | undefined): Set<string> => {
    if (scope === undefined) return GLOBAL; // 无 scope ⇒ 仅 global 层
    if (scope === "preset" || scope === "parent" || scope === "child") return new Set([...GLOBAL, ...PRESET]);
    return GLOBAL;
  };
  const childRestrictable = visible("child"); // 子作用域可 restrict 的名字集合

  // ① 无 scope 探针（原始推理的写法）：连 bash 都看不见 ⇒ 诊断判「缺 shell」⇒ Linux 也拦
  const noScope: ToolCapabilityContext = { available: (n) => visible(undefined).has(n), platform: "linux" };
  assert.equal(resolveShellTool(noScope).name, null, "无 scope 探针看不见 preset 层 ⇒ 解析不出任何 shell");
  const blocked = diagnoseDispatchCapability("reviewer", "standard", noScope);
  assert.equal(blocked.ok, false, "无 scope 探针会把 Linux 上的派发也拦下（比原缺陷更严重）⇒ 该写法必须被钉死");
  assert.ok(blocked.missing.length >= 2, "缺的是一整批模型面向工具，不只是 shell");

  // ② 带 parent scope 的探针（本实现）：解析出 bash，且为真集合 ⊆ 子作用域可 restrict 集合
  const withScope: ToolCapabilityContext = { available: (n) => visible("parent").has(n), platform: "linux" };
  assert.equal(resolveShellTool(withScope).name, "bash");
  assert.equal(diagnoseDispatchCapability("reviewer", "standard", withScope).ok, true);
  for (const role of ["reviewer", "collector"] as const) {
    const allow = toolFilterForRole(role, "standard", withScope)?.allow ?? [];
    assert.deepEqual(
      allow.filter((n) => !childRestrictable.has(n)),
      [],
      `${role}：过滤器必须是子作用域可 restrict 名字的子集（否则 restrict() 抛错）`,
    );
  }
  // ③ 探针为真集合 ⊆ 可 restrict 集合 是**结构性**成立的：parent 的 own layer 也是 child 的祖先层
  //    ⇒ 不存在「多报」；反之 parent 自身被 restrict 时会少报（能力收窄，绝不抛错）——见目标报告残余段。
  assert.ok([...visible("parent")].every((n) => childRestrictable.has(n)));
});

test("g-473：宿主 5 处派发点的探针实参被结构守卫钉住（退回无 scope 写法必红）", () => {
  const host = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");

  // ① 能力探针构造器内部：探针必须是两参形态 `tools.get(name, agentScope)`，且缺 scope 时如实降级（不猜）
  const helper = host.slice(host.indexOf("const toolCapabilityFor ="), host.indexOf("const capabilityBlock ="));
  assert.ok(helper.length > 0, "必须能找到 toolCapabilityFor（结构守卫锚点失效即判红）");
  assert.match(helper, /tools\.get\(\s*name\s*,\s*agentScope\s*\)/, "探针必须传 agent scope（Agent 实例即 scope key）");
  assert.doesNotMatch(helper, /tools\.get\(\s*name\s*\)/, "不得退回无 scope 的全局视图探针");
  assert.match(helper, /!\s*agentScope/, "拿不到 scope 时必须降级为「只给平台」而不是当作「全部不可用」");

  // ② 5 处派发点都必须调用能力探针，且实参是**该处的 parent agent**（不得留空/传 ctx）
  const calls = [...host.matchAll(/toolCapabilityFor\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(
    calls,
    ["agentScope", "parent", "parentAgent", "parentAgent", "ex.agent", "parent"],
    `派发点的探针实参必须逐处显式给出 parent agent（实际：${JSON.stringify(calls)}）`,
  );

  // ③ 三受影响角色的过滤器构造**必须**带能力上下文（不得有绕过探针的派发点）；
  //    允许两种等价形态：内联 `toolCapabilityFor(...)`，或先赋给局部变量（该变量必须源自探针）。
  const capVars = [...host.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*toolCapabilityFor\(/g)].map((m) => m[1]);
  assert.ok(capVars.length >= 2, `必须存在「先算能力、再建过滤器」的局部变量（实际：${JSON.stringify(capVars)}）`);
  for (const role of ["executor", "collector", "reviewer"]) {
    const sites = [...host.matchAll(new RegExp(`toolFilterForRole\\(\\s*"${role}"\\s*,[^)]*\\)`, "g"))].map((m) => m[0]);
    assert.ok(sites.length >= 1, `${role}：必须存在过滤器构造点`);
    for (const s of sites) {
      assert.ok(
        /toolCapabilityFor\(/.test(s) || capVars.some((v) => new RegExp(`\\b${v}\\b`).test(s)),
        `${role}：过滤器构造必须带能力上下文（探针或其派生变量），实际：${s}`,
      );
    }
  }
});

test("g-473 判据 2（宿主端）：缺 dsh-tool-web ⇒ web_* 静默剔除、不阻断派发、过滤器零未知名", async () => {
  // bash-only + 无 web 工具（模拟未启用 dsh-tool-web 的宿主）：collector 走卡片收集路径
  const withoutWeb = new Set([...BASE_TOOLS].filter((n) => n !== "web_search" && n !== "web_fetch"));
  withoutWeb.add("bash");
  const h = makeDispatchHarness(withoutWeb);
  const goal = createGoal(h.root, { title: "g-473 no web", version: "v-g473", actor: "human:test" });
  setCriteria(h.root, goal, ["criterion one"], "human:test");
  const card = addCard(h.root, goal, { title: "g-473 card", actor: "human:test" });

  const res: any = await dispatchTool(h).execute({ goal, card }, h.exec);

  assert.ok(!res.child_error, `缺可选工具不得阻断派发，实际：${JSON.stringify(res.child_error ?? res).slice(0, 300)}`);
  assert.equal(h.spawned.length, 1, "必须正常派发子代理");
  const allow = h.spawned[0].request?.toolFilter?.allow ?? [];
  assert.ok(allow.includes("bash"), "探针判定可用的 bash 必须保留");
  assert.ok(!allow.includes("web_search") && !allow.includes("web_fetch"), "不可用的 web_* 必须静默剔除");
  assert.deepEqual(allow.filter((n: string) => !withoutWeb.has(n)), [], "过滤器不得含未知名（否则 restrict() 抛错）");
  const events = readFileSync(join(h.root, "events.jsonl"), "utf8");
  assert.ok(!events.includes(DISPATCH_CAPABILITY_MISSING_EVENT), "静默剔除不得记「缺能力」事件（它不是失败）");
});

test("g-473（宿主端）：bash-only 探针下三条路径都能派发，且过滤器实名换了平台正确的 shell", async () => {
  const bashOnly = new Set([...BASE_TOOLS, "bash"]);
  const h = makeDispatchHarness(bashOnly);
  const goal = createGoal(h.root, { title: "g-473 bash only", version: "v-g473", actor: "human:test" });
  setCriteria(h.root, goal, ["criterion one"], "human:test");

  const res: any = await dispatchTool(h).execute({ goal, mode: "minimal" }, h.exec);
  assert.ok(!res.child_error, `bash-only 组合必须能派发：${JSON.stringify(res.child_error ?? "")}`);
  assert.equal(h.spawned.length, 1);
  const sentFilter = h.spawned[0].request?.toolFilter;
  assert.deepEqual(sentFilter?.allow, ["bash", "edit", "read", "write", "graph_report_status", "graph_transition"]);
  assert.ok(!(sentFilter?.allow ?? []).includes(SHELL_TOOL_SLOT), "过滤器不得残留槽位");
});
