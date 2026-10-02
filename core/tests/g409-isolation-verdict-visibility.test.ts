import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import vm from "node:vm";
import {
  createGoal,
  defaultWorktreeForGoalType,
  findGoalFile,
  goalDetail,
  init,
  resolveWorktreeIsolationDecision,
} from "../ops.ts";
import { resolveWorktreeGuide } from "../../dist/index.js";

/**
 * g-409 回归：**隔离判定必须可见，且指引必须写清口径**。
 *
 * 缺陷面（g-406 att-001 建议，主管采纳）：
 *  (a) `graph_start_attempt` 返回已带 `isolationReport`（g-406），但 `goalDetail` 的 attempt 投影
 *      **未透出** `worktree_reason` ⇒ GUI 只能看到「没有 worktree」，无法区分
 *      **按类型策略豁免**（策略默认，正常）与**建树失败**（其实不可能静默发生：一律抛错零副作用）；
 *  (b) `minor-task.*` / `no-isolation.*` 指引只陈述「在工作区根目录运行」，未写明
 *      「豁免是策略默认、非失败」以及「需要隔离请显式传 `worktree:true`」。
 *
 * 本文件的三类不变式：
 *  1. 投影如实：`worktree_reason` 逐字来自 attempt.md，缺字段 ⇒ null（不报错、不伪造）；
 *     `isolated` 由已落盘的 worktree 证据推导，无证据 ⇒ null（同样不猜测）；
 *  2. GUI 可见：既有 attempt 展示位（worktree tab 的 attempt 行）渲染该字段，zh/en 双语同步、
 *     en 零 CJK；旧记录（无字段）保持原文案；
 *  3. 口径与边界：指引 zh/en 写清「策略默认、非失败」+「显式传 `worktree:true`」；
 *     隔离策略/命名/配置项一律未改（本目标只加只读字段与文案）。
 *
 * 负向对照（回退即红）：见文末「负向对照」小节——旧投影形状（无 worktree_reason / 无 isolated）
 * 与「未加指引句」的 prompt 资产必须被判红；结构性锚点保证删字段/删句子即红。
 */

const REPO_ROOT = join(import.meta.dirname, "../..");
const PROMPTS = join(REPO_ROOT, "dsh-graph-host", "prompts");
const CLIENT = join(REPO_ROOT, "dsh-graph-host", "lib", "client");

/** attempt.md 的可辨识枚举（core/worktree.ts WorktreeIsolationDecision.reason）。 */
const ISOLATION_REASONS = ["explicit", "dirty_workspace", "type_default", "type_default_unknown"] as const;

// ---------------------------------------------------------------------------
// 夹具：私有板副本（绝不碰真实看板）
// ---------------------------------------------------------------------------

function board(): { root: string; goalId: string; goalDir: string } {
  const root = mkdtempSync(join(tmpdir(), "g409-board-"));
  init(root);
  const goalId = createGoal(root, { title: "g-409 隔离判定可见性夹具", version: "v0.0.1", type: "task", actor: "agent:g409" });
  const goalDir = dirname(findGoalFile(root, goalId));
  return { root, goalId, goalDir };
}

/** 手写 attempt.md（`---` + JSON frontmatter + `---` + 正文），可精确模拟「旧记录缺字段」。 */
function writeAttempt(goalDir: string, id: string, meta: Record<string, any>): void {
  const dir = join(goalDir, "attempts", id);
  mkdirSync(dir, { recursive: true });
  const front = { id, executor: "agent:g409", sandbox: "directory", result: "pending", ...meta };
  writeFileSync(join(dir, "attempt.md"), `---\n${JSON.stringify(front, null, 2)}\n---\n\n## 交回\n`, "utf8");
}

function attemptRow(detail: Record<string, any>, id: string): Record<string, any> {
  const row = detail.attempts.find((a: any) => a.id === id);
  assert.ok(row, `goalDetail 应含 ${id}`);
  return row;
}

/**
 * 投影判定器：把「GUI 能否区分策略豁免与建树失败」写成可断言的真值函数。
 * **它正是负向对照的被测对象**：旧投影形状（无 worktree_reason / 无 isolated）必被判红。
 */
function projectionIsolationViolation(row: Record<string, any>): string | null {
  if (!("worktree_reason" in row)) return "投影缺 worktree_reason（GUI 无法区分策略豁免与建树失败）";
  const reason = row.worktree_reason;
  if (reason !== null && !(ISOLATION_REASONS as readonly string[]).includes(String(reason))) {
    return `worktree_reason 不是稳定枚举：${String(reason)}`;
  }
  if (!("isolated" in row)) return "投影缺 isolated";
  if (row.isolated !== null && typeof row.isolated !== "boolean") return "isolated 必须是 boolean 或 null";
  return null;
}

// ---------------------------------------------------------------------------
// 1. 投影如实 + 向后兼容
// ---------------------------------------------------------------------------

test("g-409 判据1：goalDetail attempt 投影如实透出 worktree_reason / isolated", () => {
  const { root, goalId, goalDir } = board();
  writeAttempt(goalDir, "att-001", { worktree: false, worktree_reason: "type_default", worktree_probe: { state: "clean" } });
  writeAttempt(goalDir, "att-002", { worktree: false, worktree_reason: "explicit" });
  writeAttempt(goalDir, "att-003", { worktree: { path: ".worktrees/g-409-att-03", branch: "refs/heads/g-409-att-03" } });
  writeAttempt(goalDir, "att-004", { worktree_reason: "type_default_unknown" });
  writeAttempt(goalDir, "att-005", {}); // 旧记录：两个字段都没有

  const detail = goalDetail(root, goalId);

  const a1 = attemptRow(detail, "att-001");
  assert.equal(a1.worktree_reason, "type_default", "worktree_reason 必须逐字来自 attempt.md");
  assert.equal(a1.isolated, false, "worktree=false ⇒ isolated=false");
  const a2 = attemptRow(detail, "att-002");
  assert.equal(a2.worktree_reason, "explicit");
  assert.equal(a2.isolated, false);
  const a3 = attemptRow(detail, "att-003");
  assert.equal(a3.worktree_reason, null, "已隔离记录无豁免原因 ⇒ null（不伪造）");
  assert.equal(a3.isolated, true, "有 worktree 证据 ⇒ isolated=true");
  const a4 = attemptRow(detail, "att-004");
  assert.equal(a4.worktree_reason, "type_default_unknown", "枚举值原样透出");
  assert.equal(a4.isolated, null, "无 worktree 证据 ⇒ isolated 未知为 null（不猜测）");
  const a5 = attemptRow(detail, "att-005");
  assert.equal(a5.worktree_reason, null, "旧记录缺字段 ⇒ null，不报错、不填默认值");
  assert.equal(a5.isolated, null, "旧记录缺 worktree 字段 ⇒ null，不猜测");

  for (const id of ["att-001", "att-002", "att-003", "att-004", "att-005"]) {
    assert.equal(projectionIsolationViolation(attemptRow(detail, id)), null, `${id} 投影必须可判定隔离`);
  }
});

test("g-409 判据1：worktree_reason 为非字符串/空串时不报错，按缺失处理", () => {
  const { root, goalId, goalDir } = board();
  writeAttempt(goalDir, "att-001", { worktree: false, worktree_reason: "" });
  writeAttempt(goalDir, "att-002", { worktree: false, worktree_reason: 42 });
  writeAttempt(goalDir, "att-003", { worktree: false, worktree_reason: "  " });

  const detail = goalDetail(root, goalId);
  assert.equal(attemptRow(detail, "att-001").worktree_reason, null, "空串 ⇒ null");
  assert.equal(attemptRow(detail, "att-002").worktree_reason, null, "非字符串 ⇒ null（不缓存脏值）");
  assert.equal(attemptRow(detail, "att-003").worktree_reason, null, "空白串 ⇒ null");
});

test("g-409 判据1：新增字段是只读投影——不改 attempt.md 一个字节", () => {
  const { root, goalId, goalDir } = board();
  writeAttempt(goalDir, "att-001", { worktree: false, worktree_reason: "type_default" });
  const file = join(goalDir, "attempts", "att-001", "attempt.md");
  const before = readFileSync(file, "utf8");
  goalDetail(root, goalId);
  goalDetail(root, goalId);
  assert.equal(readFileSync(file, "utf8"), before, "goalDetail 是只读投影，不得回写 attempt.md");
});

// ---------------------------------------------------------------------------
// 2. GUI 可见（既有 attempt 展示位）
// ---------------------------------------------------------------------------

function loadClientI18n(): any {
  const source = readFileSync(join(CLIENT, "i18n.js"), "utf8");
  const sandbox: any = { React: {} };
  vm.runInNewContext(source + "; this.zh = zh; this.en = en;", sandbox);
  return sandbox;
}

/** 与 g-272/g-276 同款：从源模块中抽出 AttemptWorktrees 组件并在 vm 内求值。 */
function loadAttemptWorktrees(): any {
  const i18nSource = readFileSync(join(CLIENT, "i18n.js"), "utf8");
  const modalSource = readFileSync(join(CLIENT, "goal-modal.js"), "utf8");
  const h = (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children });
  const sandbox: any = {
    React: {
      createElement: h,
      useState: (v: any) => [typeof v === "function" ? v() : v, () => {}],
      useRef: (v: any) => ({ current: v }),
      useCallback: (fn: any) => fn,
      useEffect: () => {},
    },
    h,
    S: { btn: {}, btnPrimary: {}, meta: {}, modalSection: {}, modalH: {}, subCard: {} },
    copyText: async () => true,
    showToast: () => {},
    dgT: (k: string) => k,
  };
  const match = modalSource.match(/function AttemptWorktrees\(props\) \{[\s\S]*?\n    \}/);
  if (!match) throw new Error("AttemptWorktrees 组件未在 goal-modal.js 中定位到");
  vm.runInNewContext(i18nSource + ";\n" + match[0] + ";\nthis.zh = zh; this.en = en; this.AttemptWorktrees = AttemptWorktrees;", sandbox);
  return sandbox;
}

function allText(node: any): string[] {
  if (!node) return [];
  if (typeof node === "string") return [node];
  let out: string[] = [];
  if (Array.isArray(node)) for (const n of node) out = out.concat(allText(n));
  else if (Array.isArray(node.children)) for (const n of node.children) out = out.concat(allText(n));
  return out;
}

const EXEMPT_CASES: Array<[string, string, string]> = [
  ["type_default", "策略默认豁免隔离（非失败）", "Exempt by type policy default (not a failure)"],
  ["explicit", "显式跳过隔离（非失败）", "Isolation skipped explicitly (not a failure)"],
  ["type_default_unknown", "探测不可靠，按类型默认豁免（非失败）", "Probe unreliable, type default exemption (not a failure)"],
  ["dirty_workspace", "工作区有未提交改动，已升级为隔离", "Workspace was dirty, isolation upgraded"],
];

test("g-409 判据1：GUI attempt 展示位渲染隔离判定（zh），缺字段保持原文案", () => {
  const sandbox = loadAttemptWorktrees();
  sandbox.dgT = (k: string) => sandbox.zh[k] ?? k;
  const render = (attempt: any) => allText(sandbox.AttemptWorktrees({
    attempts: [attempt], worktrees: { status: "ok", items: {} },
  }));

  for (const [reason, zhText] of EXEMPT_CASES.map(([r, z]) => [r, z] as [string, string])) {
    const texts = render({ id: "att-001", worktree_reason: reason });
    assert.ok(texts.includes(`未创建 worktree · ${zhText}`), `zh 必须展示「${zhText}」，实际：${JSON.stringify(texts)}`);
  }

  // 旧记录（无 worktree_reason）：文案逐字不变，不伪造原因
  const legacy = render({ id: "att-002" });
  assert.ok(legacy.includes("未创建 worktree"), "旧记录必须仍显示原文案");
  assert.ok(!legacy.some((t) => t.includes("·")), "旧记录不得拼接任何原因后缀");
});

test("g-409 判据1：GUI attempt 展示位 en 输出零 CJK", () => {
  const sandbox = loadAttemptWorktrees();
  sandbox.dgT = (k: string) => sandbox.en[k] ?? k;
  const render = (attempt: any) => allText(sandbox.AttemptWorktrees({
    attempts: [attempt], worktrees: { status: "ok", items: {} },
  }));

  for (const [reason, , enText] of EXEMPT_CASES) {
    const texts = render({ id: "att-001", worktree_reason: reason });
    assert.ok(texts.includes(`No worktree created · ${enText}`), `en 必须展示「${enText}」，实际：${JSON.stringify(texts)}`);
    for (const t of texts) assert.doesNotMatch(t, /[\u3400-\u9fff]/, `en 输出不得含 CJK：${t}`);
  }

  const legacy = render({ id: "att-002" });
  assert.ok(legacy.includes("No worktree created"), "旧记录英文原文案不变");
  for (const t of legacy) assert.doesNotMatch(t, /[\u3400-\u9fff]/, `en 输出不得含 CJK：${t}`);
});

test("g-409 判据1/4：客户端 i18n zh/en 字典对称，且 en 新增值零 CJK", () => {
  const { zh, en } = loadClientI18n();
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "client i18n zh/en 必须键完全对称");
  const keys = ["worktree.isolation.explicit", "worktree.isolation.typeDefault", "worktree.isolation.typeDefaultUnknown", "worktree.isolation.dirtyWorkspace"];
  for (const k of keys) {
    assert.equal(typeof zh[k], "string", `zh 缺 ${k}`);
    assert.equal(typeof en[k], "string", `en 缺 ${k}`);
    assert.doesNotMatch(en[k], /[\u3400-\u9fff]/, `en ${k} 不得含 CJK`);
  }
});

// ---------------------------------------------------------------------------
// 3. 指引与文档口径（zh/en 成对）
// ---------------------------------------------------------------------------

const GUIDE_PAIRS: Array<[string, string]> = [["minor-task", "patch"], ["no-isolation", "task"]];

test("g-409 判据2：minor-task / no-isolation 指引写明「策略默认、非失败」与「显式传 worktree:true」（zh/en 成对）", () => {
  for (const [name] of GUIDE_PAIRS) {
    const zh = readFileSync(join(PROMPTS, `${name}.zh.md`), "utf8");
    const en = readFileSync(join(PROMPTS, `${name}.en.md`), "utf8");

    // zh 口径
    assert.match(zh, /策略默认/, `${name}.zh.md 必须写明「策略默认」`);
    assert.match(zh, /并非隔离创建失败/, `${name}.zh.md 必须写明「并非隔离创建失败」`);
    assert.match(zh, /显式传\s*`worktree:true`/, `${name}.zh.md 必须写明「显式传 worktree:true」`);
    assert.match(zh, /patch \/ chore \/ task|patch \/ chore/, `${name}.zh.md 必须点名默认豁免的类型范围`);

    // en 口径（与 zh 成对）
    assert.match(en, /policy default/, `${name}.en.md must state "policy default"`);
    assert.match(en, /not a worktree creation failure/, `${name}.en.md must state "not a worktree creation failure"`);
    assert.match(en, /`worktree:true`/, `${name}.en.md must state "worktree:true"`);
    assert.match(en, /explicitly pass/, `${name}.en.md must state "explicitly pass"`);

    // zh/en 行数一致（prompt-i18n-parity 的既有契约）
    assert.equal(zh.split("\n").length, en.split("\n").length, `${name} zh/en 行数必须一致`);
  }
});

test("g-409 判据2：新增指引句 en 零 CJK（逐行核验新增行）", () => {
  const newLines: Array<[string, number]> = [["minor-task", 4], ["no-isolation", 1]];
  for (const [name, idx] of newLines) {
    const line = readFileSync(join(PROMPTS, `${name}.en.md`), "utf8").split("\n")[idx];
    assert.ok(line && line.trim().length > 0, `${name}.en.md 第 ${idx + 1} 行应为新增指引句`);
    assert.doesNotMatch(line, /[\u3400-\u9fff]/, `${name}.en.md 第 ${idx + 1} 行不得含 CJK：${line}`);
  }
});

test("g-409 判据2：未隔离指引仍不得混入强制隔离口径（g-283 不变式保持）", () => {
  const forbidden = ["强制", "预创建", "预建", "git worktree list", "graph_list_worktrees", "你的 cwd 是主/集成工作树"];
  for (const [name, type] of GUIDE_PAIRS) {
    for (const lang of ["zh", "en"] as const) {
      const guide = resolveWorktreeGuide(type, false, lang);
      assert.ok(guide.includes(readFileSync(join(PROMPTS, `${name}.${lang}.md`), "utf8").trim()), `${name}.${lang} 指引应被完整注入`);
      for (const bad of forbidden) {
        assert.ok(!guide.includes(bad), `${name}.${lang} 未隔离指引不得含「${bad}」`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. 边界：不改隔离策略 / 命名规范 / 配置项
// ---------------------------------------------------------------------------

test("g-409 判据4：隔离策略矩阵逐字未变（g-283/g-289 type_default 行为保留）", () => {
  const matrix: Array<[string, boolean]> = [
    ["patch", false], ["chore", false], ["task", false],
    ["feature", true], ["bug", true], ["improvement", true],
  ];
  for (const [type, expected] of matrix) {
    assert.equal(defaultWorktreeForGoalType(type), expected, `${type} 类型默认保持 ${expected}`);
  }
  assert.deepEqual(
    { isolate: resolveWorktreeIsolationDecision("task", undefined, { clean: true }).isolate, reason: resolveWorktreeIsolationDecision("task", undefined, { clean: true }).reason },
    { isolate: false, reason: "type_default" },
    "干净工作区 + task 未传 ⇒ type_default 豁免（策略默认，非失败）",
  );
  assert.deepEqual(
    { isolate: resolveWorktreeIsolationDecision("task", undefined, { clean: false }).isolate, reason: resolveWorktreeIsolationDecision("task", undefined, { clean: false }).reason },
    { isolate: true, reason: "dirty_workspace" },
    "脏工作区 ⇒ 任何类型升级隔离",
  );
  assert.deepEqual(
    { isolate: resolveWorktreeIsolationDecision("task", false).isolate, reason: resolveWorktreeIsolationDecision("task", false).reason },
    { isolate: false, reason: "explicit" },
    "显式 worktree:false ⇒ explicit 豁免",
  );
  assert.equal(resolveWorktreeIsolationDecision("task", true).isolate, true, "显式 worktree:true ⇒ 建树");
});

test("g-409 判据4：决策函数签名/命名规范未改，且未引入新配置项", () => {
  const worktreeSource = readFileSync(join(REPO_ROOT, "core", "worktree.ts"), "utf8");
  assert.match(
    worktreeSource,
    /export function resolveWorktreeIsolationDecision\(\s*rawType: unknown,\s*explicitIsolate\?: boolean \| null,\s*probeState\?: GitCleanlinessResult \| null,\s*\)/,
    "决策函数签名不得新增参数（即不得新增配置开关）",
  );
  assert.match(worktreeSource, /const name2 = `\$\{goalId\}-att-\$\{String\(seqNum\)\.padStart\(2, "0"\)\}`;/, "worktree 命名规范（两位序号）不得改动");
  assert.match(worktreeSource, /const name3 = `\$\{goalId\}-att-\$\{String\(seqNum\)\.padStart\(3, "0"\)\}`;/, "三位别名并存（兼容既有树）");
});

// ---------------------------------------------------------------------------
// 5. 负向对照：回退修复即红
// ---------------------------------------------------------------------------

test("g-409 负向对照：旧投影形状（无 worktree_reason / 无 isolated）必须被判红", () => {
  // 事故现场形状：只有 worktree=false，没有任何「为何未建树」的字段
  const oldShape = { id: "att-001", worktree: false, status_line: null, result: "pending" };
  const violation = projectionIsolationViolation(oldShape);
  assert.ok(violation, "旧投影形状必须被判红");
  assert.match(String(violation), /worktree_reason/);

  // 只补 worktree_reason、漏 isolated 也判红
  assert.match(String(projectionIsolationViolation({ worktree: false, worktree_reason: "type_default" })), /isolated/);
  // 非法枚举判红（防止「随便填一个原因」冒充可判定）
  assert.match(String(projectionIsolationViolation({ worktree: false, worktree_reason: "unknown_reason", isolated: false })), /枚举/);
  // 齐全且如实 ⇒ 放行
  assert.equal(projectionIsolationViolation({ worktree: false, worktree_reason: "type_default", isolated: false }), null);
  assert.equal(projectionIsolationViolation({ worktree: false, worktree_reason: null, isolated: null }), null);
});

test("g-409 负向对照：结构性锚点——删字段/删指引句/改策略必红", () => {
  const opsSource = readFileSync(join(REPO_ROOT, "core", "ops.ts"), "utf8");
  assert.match(opsSource, /worktree_reason: typeof m\.worktree_reason === "string" && m\.worktree_reason\.trim\(\) \? m\.worktree_reason\.trim\(\) : null,/, "goalDetail 投影必须逐字保留 worktree_reason 透出");
  assert.match(opsSource, /isolated: m\.worktree === undefined \? null : Boolean\(m\.worktree\),/, "goalDetail 投影必须保留 isolated 推导（缺证据 ⇒ null）");

  const compiledOps = readFileSync(join(REPO_ROOT, "dist", "core", "ops.js"), "utf8");
  assert.match(compiledOps, /worktree_reason:/, "编译产物同样必须含该字段（回退同步构建即红）");

  const modalSource = readFileSync(join(CLIENT, "goal-modal.js"), "utf8");
  assert.match(modalSource, /notCreatedLabel/, "GUI attempt 展示位必须使用隔离判定标签");
  assert.match(modalSource, /ISOLATION_EXEMPT_KEYS/, "GUI 必须按枚举映射原因");
  const bundle = readFileSync(join(REPO_ROOT, "dist", "lib", "client.js"), "utf8");
  assert.match(bundle, /notCreatedLabel/, "客户端 bundle 必须已重建（含判定标签）");

  for (const name of ["minor-task", "no-isolation"]) {
    assert.match(readFileSync(join(PROMPTS, `${name}.zh.md`), "utf8"), /显式传\s*`worktree:true`/, `${name}.zh.md 的指引句不得被删除`);
  }
});
