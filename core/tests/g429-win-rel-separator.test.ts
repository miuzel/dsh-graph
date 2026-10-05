/**
 * core/tests/g429-win-rel-separator.test.ts
 *
 * g-429：修 Windows 上「相对路径硬编码 POSIX 分隔符」族缺陷（4 处真缺陷）+ 防复发。
 * 覆盖判据：
 *   A1 收口 helper（normalizeRelPath/relPathSegments/relPathStartsWithSegments/relEscapesRoot/relOwnership/
 *      classifyGoalRel/archiveTargetRel/unarchiveTargetRel）+ 四处站点（archiveGoal / unarchiveGoal /
 *      locationProblems / validate 的 status↔goal.moved 对账）全部改走纯函数；
 *   A2 「按 rel 分类归属」抽成纯函数，以**注入的反斜杠 rel** 在 Linux 上判定 Windows 语义（不依赖真机）；
 *   A3 locationProblems 与 validate 对账各给正/负例（反斜杠形态仍检出 + 合法布局不误报），
 *      并各有一条**真实 POSIX 路径**的端到端回归；
 *   A4 防复发结构守卫（core 产品源码里对相对路径派生值的裸 split("/")/startsWith("x/") 判红；
 *      允许清单带理由、不得陈旧、必须自带反斜杠对照）+ 可实拍的负向对照；
 *   A5 Linux 端零回归：归档/取消归档经真实实例路径（真实文件系统 + 真实事件流）原样通过。
 *
 * 真机结论**不由本测试给出**：修复后由负责人在原生 Windows 重跑 g-428 冒烟闭环（T3 32 步），
 * 结论回填 docs/platform-gate.md §7。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  init,
  createGoal,
  moveGoal,
  archiveGoal,
  unarchiveGoal,
  findGoalFile,
  loadGoal,
  saveGoal,
  validate,
  toWorkspaceCardPath,
  normalizeRelPath,
  relPathSegments,
  relPathStartsWithSegments,
  relEscapesRoot,
  relOwnership,
  classifyGoalRel,
  archiveTargetRel,
  unarchiveTargetRel,
  locationProblemsForRel,
  moveTransitionProblemFor,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import {
  SEPARATOR_SITES_ALLOWLIST,
  SURGERY_BEGIN,
  SURGERY_END,
  allowEntryKey,
  siteKey,
  judgeRelSeparatorGuard,
  startsWithArgsToCheck,
  type SiteAllowEntry,
  type SourceFile,
} from "./g429-rel-separator-guard.ts";

const ACTOR = "test";
const repoRoot = join(import.meta.dirname, "../..");

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-g429-rel-"));
  init(dir);
  return dir;
}

/** 产品源码面（与 g-428 台账同口径：core/*.ts，不含 core/tests）。 */
function coreProductFiles(): SourceFile[] {
  const dir = join(repoRoot, "core");
  const out: SourceFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".ts")) continue;
    const abs = join(dir, name);
    if (!statSync(abs).isFile()) continue;
    out.push({ path: `core/${name}`, text: readFileSync(abs, "utf8") });
  }
  return out;
}

const CORPUS = coreProductFiles();
const fixture = (text: string): SourceFile[] => [{ path: "core/fixture.ts", text }];

/** 复刻修复前 moveGoal 的写入结果（保留 goal.moved，抹掉派生的 goal.transition）。 */
function stripMoveTransitions(root: string, id: string): void {
  const evFile = join(root, "events.jsonl");
  const kept = readFileSync(evFile, "utf8").split("\n").filter((line) => {
    if (!line.trim()) return false;
    try {
      const ev = JSON.parse(line);
      return !(ev.goal === id && ev.event === "goal.transition");
    } catch {
      return true;
    }
  });
  writeFileSync(evFile, kept.join("\n") + "\n", "utf8");
}

// ============================================================================
// A1 / A2：归一化 helper 与「按 rel 分类归属」纯函数（注入反斜杠 ⇒ Linux 上判定 Windows 语义）
// ============================================================================

test("A1 一处收口：helper 齐备且 core 产品源码里分隔符手术只在标记区间内", () => {
  assert.ok(CORPUS.length >= 10, `扫描面不得不当缩小（实际 ${CORPUS.length} 个文件）`);
  const ops = CORPUS.find((f) => f.path === "core/ops.ts");
  assert.ok(ops, "core/ops.ts 必须存在");
  for (const name of [
    "normalizeRelPath", "relPathSegments", "relPathStartsWithSegments", "relEscapesRoot", "relOwnership",
    "classifyGoalRel", "archiveTargetRel", "unarchiveTargetRel",
    "locationProblemsForRel", "moveTransitionProblemFor",
  ]) {
    assert.match(ops!.text, new RegExp(`export function ${name}\\b`), `helper ${name} 必须导出一处收口`);
  }
  assert.ok(ops!.text.includes(SURGERY_BEGIN) && ops!.text.includes(SURGERY_END), "必须存在收口标记区间");
  // 注释里写明了 rel 的来源与安全前提（判据 1 的显式要求）
  assert.match(ops!.text, /来源与安全前提/, "helper 注释必须写明 rel 的来源与安全前提");
  assert.match(ops!.text, /sanitizeAttachmentPath/, "安全前提必须点名「附件名已拒绝反斜杠」的依据");
  assert.match(ops!.text, /assertVersionSlug|isVersionSlug/, "安全前提必须点名「版本 slug 已拒绝分隔符」的依据");
  // 四处站点各自改走纯函数（不再自行切分）
  assert.match(ops!.text, /archiveTargetRel\(loc, id, srcDir !== null\)/, "archiveGoal 必须走纯函数");
  assert.match(ops!.text, /unarchiveTargetRel\(loc, id, srcDir !== null/, "unarchiveGoal 必须走纯函数");
  assert.match(ops!.text, /locationProblemsForRel\(file\.slice\(root\.length \+ 1\)/, "locationProblems 必须委托纯函数");
  assert.match(ops!.text, /moveTransitionProblemFor\(\{/, "validate 对账必须委托纯函数");
});

test("A2 归一化：`\\` → `/`，片段/前缀/逃逸判定对两种分隔符等价", () => {
  assert.equal(normalizeRelPath("versions\\v1\\goals\\g-1\\goal.md"), "versions/v1/goals/g-1/goal.md");
  assert.equal(normalizeRelPath("versions/v1/goals/g-1/goal.md"), "versions/v1/goals/g-1/goal.md");
  assert.deepEqual(relPathSegments("versions\\v1\\goals\\g-1\\goal.md"), ["versions", "v1", "goals", "g-1", "goal.md"]);
  assert.equal(relPathStartsWithSegments("backlog\\g-1.md", ["backlog"]), true);
  assert.equal(relPathStartsWithSegments("goals\\archived\\g-1\\goal.md", ["goals"]), true);
  assert.equal(relPathStartsWithSegments("versions\\v1\\goals\\g-1\\goal.md", ["versions", "v1"]), true);
  // 负例：目录前缀必须后随至少一段（等价旧写法 `startsWith("x/")`），且不得跨目录误判
  assert.equal(relPathStartsWithSegments("backlog", ["backlog"]), false);
  assert.equal(relPathStartsWithSegments("versions\\v2\\goals\\g-1\\goal.md", ["versions", "v1"]), false);
  assert.equal(relPathStartsWithSegments("goals\\g-1\\goal.md", ["backlog"]), false);
  // relEscapesRoot：Windows 形态的嵌套上跳必须命中（旧写法 fail-open）
  assert.equal(relEscapesRoot("..\\..\\evil"), true);
  assert.equal(relEscapesRoot("../evil"), true);
  assert.equal(relEscapesRoot(".."), true);
  assert.equal(relEscapesRoot("/abs/path"), true);
  assert.equal(relEscapesRoot("backlog\\g-1.md"), false);
  assert.equal(relEscapesRoot("goals\\archived\\g-1\\goal.md"), false);
  // relOwnership：validate 对账用的归属分类
  assert.equal(relOwnership("backlog\\archived\\g-1.md"), "backlog");
  assert.equal(relOwnership("backlog\\g-1.md"), "backlog");
  assert.equal(relOwnership("goals\\g-1\\goal.md"), "schedule");
  assert.equal(relOwnership("versions\\v1\\goals\\g-1\\goal.md"), "schedule");
  assert.equal(relOwnership("versions\\v1\\archived\\g-1\\goal.md"), "schedule");
  assert.equal(relOwnership("tmp\\x\\goal.md"), "other");
});

test("A2 反斜杠形态分类：五种板内布局 + 未知形态（Linux 上判定 Windows 语义）", () => {
  const cases: Array<[string, string, string | null]> = [
    ["versions\\v1\\goals\\g-1\\goal.md", "version-goal", "v1"],
    ["versions\\v1\\archived\\g-1\\goal.md", "version-archived", "v1"],
    ["versions\\archived\\g-1\\goal.md", "archived-version", "archived"],
    ["goals\\g-1\\goal.md", "standalone-goal", null],
    ["goals\\archived\\g-1\\goal.md", "standalone-archived", null],
    ["backlog\\g-1\\goal.md", "backlog-goal", null],
    ["backlog\\g-1.md", "backlog-goal", null],
    ["backlog\\archived\\g-1\\goal.md", "backlog-archived", null],
    ["backlog\\archived\\g-1.md", "backlog-archived", null],
  ];
  for (const [rel, form, version] of cases) {
    const loc = classifyGoalRel(rel);
    assert.equal(loc.form, form, `${rel} 的形态`);
    assert.equal(loc.version, version, `${rel} 的版本目录`);
    assert.equal(loc.rel, normalizeRelPath(rel), `${rel} 归一化后的 rel`);
    // 反斜杠与斜杠形态必须完全等价（Windows 语义 ≡ Linux 语义）
    assert.deepEqual(loc, classifyGoalRel(rel.replace(/\\/g, "/")), `${rel} 两种分隔符必须等价`);
  }
  // 负例：非板内布局不得被误判为板内
  for (const rel of ["tmp\\x\\goal.md", "cards\\c-1.md", "goal.md"]) {
    assert.equal(classifyGoalRel(rel).form, "unknown", `${rel} 应判为 unknown`);
    assert.equal(classifyGoalRel(rel).top, null);
  }
  // archived 标志
  assert.equal(classifyGoalRel("versions\\v1\\archived\\g-1\\goal.md").archived, true);
  assert.equal(classifyGoalRel("goals\\g-1\\goal.md").archived, false);
});

test("A2 归档/取消归档目标位置（纯函数）：g-428 真机 rel 等价条件分类成功，不再抛错", () => {
  // g-428 真机首跑的真实 rel（Windows 形态）：旧实现 split("/") 只切出一整段 ⇒ 必抛
  const machineRel = "versions\\v-win-smoke\\goals\\g-001\\goal.md";
  const loc = classifyGoalRel(machineRel);
  assert.equal(archiveTargetRel(loc, "g-001", true), "versions/v-win-smoke/archived/g-001/goal.md");
  assert.deepEqual(
    classifyGoalRel(machineRel),
    classifyGoalRel("versions/v-win-smoke/goals/g-001/goal.md"),
    "真机反斜杠 rel 与等价斜杠 rel 必须同判",
  );
  // 三种归档形态（目录形态 / 扁平 backlog / 独立 goals）
  assert.equal(archiveTargetRel(classifyGoalRel("backlog\\g-1.md"), "g-1", false), "backlog/archived/g-1.md");
  assert.equal(archiveTargetRel(classifyGoalRel("backlog\\g-1\\goal.md"), "g-1", true), "backlog/archived/g-1/goal.md");
  assert.equal(archiveTargetRel(classifyGoalRel("goals\\g-1\\goal.md"), "g-1", true), "goals/archived/g-1/goal.md");
  // 负例：非板内布局 ⇒ null（调用方按既有文案抛「无法确定…位置」）
  assert.equal(archiveTargetRel(classifyGoalRel("tmp\\x\\goal.md"), "g-1", true), null);
  // 取消归档的四条复原路径（含需 meta.version 的无版本目录形态）
  assert.equal(unarchiveTargetRel(classifyGoalRel("versions\\archived\\g-1\\goal.md"), "g-1", true, "v1"), "versions/v1/goals/g-1/goal.md");
  assert.equal(unarchiveTargetRel(classifyGoalRel("versions\\archived\\g-1\\goal.md"), "g-1", true, null), null);
  assert.equal(unarchiveTargetRel(classifyGoalRel("versions\\v1\\archived\\g-1\\goal.md"), "g-1", true, null), "versions/v1/goals/g-1/goal.md");
  assert.equal(unarchiveTargetRel(classifyGoalRel("goals\\archived\\g-1\\goal.md"), "g-1", true, null), "goals/g-1/goal.md");
  assert.equal(unarchiveTargetRel(classifyGoalRel("backlog\\archived\\g-1.md"), "g-1", false, null), "backlog/g-1.md");
  assert.equal(unarchiveTargetRel(classifyGoalRel("backlog\\archived\\g-1\\goal.md"), "g-1", true, null), "backlog/g-1/goal.md");
  assert.equal(unarchiveTargetRel(classifyGoalRel("backlog\\g-1.md"), "g-1", false, null), null, "未归档形态不得被复原");
});

// ============================================================================
// A3：locationProblems 与 validate 对账（正例 + 负例；反斜杠形态 + 真实 POSIX 端到端）
// ============================================================================

test("A3 locationProblemsForRel：反斜杠形态仍检出「位置与 version 不一致」，合法布局不误报", () => {
  // 正例（Windows 形态）
  assert.deepEqual(
    locationProblemsForRel("versions\\v1\\goals\\g-1\\goal.md", "g-1", "v2"),
    ["g-1: version 字段(v2) 与目录(v1)不一致"],
  );
  assert.deepEqual(
    locationProblemsForRel("backlog\\g-1.md", "g-1", "v1"),
    ["g-1: 位于 backlog/ 但 version=v1"],
  );
  assert.deepEqual(
    locationProblemsForRel("goals\\g-1\\goal.md", "g-1", "v1"),
    ["g-1: 位于 goals/ 但 version=v1"],
  );
  // 负例：合法布局与未知布局都不得误报
  assert.deepEqual(locationProblemsForRel("versions\\v1\\goals\\g-1\\goal.md", "g-1", "v1"), []);
  assert.deepEqual(locationProblemsForRel("backlog\\g-1.md", "g-1", null), []);
  assert.deepEqual(locationProblemsForRel("goals\\archived\\g-1\\goal.md", "g-1", null), []);
  assert.deepEqual(locationProblemsForRel("tmp\\x\\goal.md", "g-1", "v1"), []);
  // 反斜杠 ≡ 斜杠
  assert.deepEqual(
    locationProblemsForRel("versions\\v1\\goals\\g-1\\goal.md", "g-1", "v2"),
    locationProblemsForRel("versions/v1/goals/g-1/goal.md", "g-1", "v2"),
  );
});

test("A3 locationProblems 真实路径端到端：位置一致性检查在 validate 中生效且不误报", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "位置一致性", version: "v-g429-a", actor: ACTOR });
  const file = findGoalFile(root, id);
  assert.match(file, /versions[/\\]v-g429-a[/\\]goals[/\\]/, "前置：版本目标落在 versions/v-g429-a/goals/");
  // 负例：合法布局
  assert.deepEqual(validate(root).filter((p) => p.startsWith(`${id}:`) && p.includes("与目录(")), []);
  // 正例：人为制造「目录 v-g429-a / 字段 v-g429-b」
  const doc = loadGoal(file);
  doc.meta.version = "v-g429-b";
  saveGoal(file, doc);
  const hit = validate(root).filter((p) => p.startsWith(`${id}:`) && p.includes("与目录("));
  assert.equal(hit.length, 1, "位置一致性检查必须报出该不一致");
  assert.match(hit[0], /version 字段\(v-g429-b\) 与目录\(v-g429-a\)不一致/);
});

test("A3 moveTransitionProblemFor：反斜杠形态仍报「搬迁改 status 缺事件」，已记录/无关布局不误报", () => {
  // 正例（Windows 形态）：goals\ 下、事件流重建 draft、frontmatter planning、无 transition 记录
  const schedule = moveTransitionProblemFor({
    rel: "goals\\g-1\\goal.md", id: "g-1", actual: "planning", expected: "draft", recorded: false,
  });
  assert.ok(schedule, "schedule 泳道下的缺事件形态必须报出");
  assert.match(schedule!, /g-1: frontmatter=planning 与事件流重建=draft 不一致/);
  assert.match(schedule!, /只读诊断/);
  // 正例：backlog\ 泳道推论为 draft
  const backlog = moveTransitionProblemFor({
    rel: "backlog\\g-1.md", id: "g-1", actual: "draft", expected: "planning", recorded: false,
  });
  assert.match(backlog ?? "", /frontmatter=draft 与事件流重建=planning/);
  // 负例：④ 事件流已记录 ⇒ 不是缺事件
  assert.equal(moveTransitionProblemFor({
    rel: "goals\\g-1\\goal.md", id: "g-1", actual: "planning", expected: "draft", recorded: true,
  }), null);
  // 负例：推论 status 与 frontmatter 不符 / 非板内布局
  assert.equal(moveTransitionProblemFor({
    rel: "goals\\g-1\\goal.md", id: "g-1", actual: "draft", expected: "planning", recorded: false,
  }), null);
  assert.equal(moveTransitionProblemFor({
    rel: "tmp\\x\\goal.md", id: "g-1", actual: "planning", expected: "draft", recorded: false,
  }), null);
  // 反斜杠 ≡ 斜杠
  assert.deepEqual(
    moveTransitionProblemFor({ rel: "versions\\v1\\goals\\g-1\\goal.md", id: "g-1", actual: "planning", expected: "draft", recorded: false }),
    moveTransitionProblemFor({ rel: "versions/v1/goals/g-1/goal.md", id: "g-1", actual: "planning", expected: "draft", recorded: false }),
  );
});

test("A3 validate 对账真实路径端到端：缺事件的搬迁被报出，正常搬迁不误报", () => {
  const root = tmpRoot();
  const broken = createGoal(root, { title: "历史形态", actor: ACTOR });
  moveGoal(root, broken, { to: "standalone", actor: ACTOR });
  stripMoveTransitions(root, broken); // 还原修复前的数据形态（有 goal.moved、无 goal.transition）
  const hit = validate(root).filter((p) => p.startsWith(`${broken}:`) && p.includes("goal.transition"));
  assert.equal(hit.length, 1, "该对账必须恢复检出（旧实现在 Windows 上整段被跳过）");
  assert.match(hit[0], /frontmatter=planning 与事件流重建=draft/);
  assert.match(hit[0], /不自动补记事件/);

  // 负例：正常搬迁（带 goal.transition）不得被误报
  const root2 = tmpRoot();
  const ok = createGoal(root2, { title: "正常路径", actor: ACTOR });
  moveGoal(root2, ok, { to: "standalone", actor: ACTOR });
  moveGoal(root2, ok, { to: "version", version: "v-g429-b", actor: ACTOR });
  assert.deepEqual(validate(root2).filter((p) => p.includes("goal.transition")), []);
});

// ============================================================================
// A4：防复发结构守卫（正向 + 可实拍负向对照）
// ============================================================================

test("A4 正向：真实 core 产品源码 0 问题；站点全量归类且与允许清单逐条对应", () => {
  const v = judgeRelSeparatorGuard(CORPUS);
  assert.deepEqual(v.problems, [], "core 产品源码不得存在未归类/未收口的相对路径分隔符手术");
  assert.deepEqual(v.unallowed, []);
  assert.ok(v.sites.length >= 8, `扫描面不得萎缩（实际 ${v.sites.length} 个站点）`);
  assert.equal(v.allowed.length, SEPARATOR_SITES_ALLOWLIST.length, "放行站点数必须恰等于允许清单条数（不多不少）");
  assert.deepEqual(
    v.allowed.map(siteKey).sort(),
    SEPARATOR_SITES_ALLOWLIST.map(allowEntryKey).sort(),
    "放行站点与允许清单必须逐条对应（清单漂移/遗漏都判红）",
  );
  // 未登记的站点只允许是「非相对路径派生 + 已显式归一化」这一类（其余一律判红）
  for (const s of v.sites) {
    if (v.allowed.includes(s)) continue;
    assert.ok(!s.relDerived && s.normalized, `未登记站点必须已被显式归一化：${s.file}:${s.line} ${s.text}`);
  }
  // 收口区间内的站点不进入判定集合（唯一出口）；标记本身写在注释里 ⇒ 用原文定位
  const ops = CORPUS.find((f) => f.path === "core/ops.ts")!;
  const lines = ops.text.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.includes(SURGERY_BEGIN)) + 1;
  const end = lines.findIndex((l) => l.includes(SURGERY_END)) + 1;
  assert.ok(begin > 0 && end > begin, "收口标记区间必须存在且有内容");
  assert.ok(
    !v.sites.some((s) => s.file === "core/ops.ts" && s.line > begin && s.line < end),
    "收口区间内的分隔符手术不得进入判定集合",
  );
  // 对照：isBacklogFile 的双分隔符写法（`/` 与 `\` 两条）作为正确范式在册
  const dual = v.allowed.filter((s) => s.symbol === "isBacklogFile");
  assert.equal(dual.length, 2, "isBacklogFile 的 `/` 与 `\\` 两条判定都应在允许清单里");
  for (const s of dual) assert.ok(s.text.includes("\\\\"), "正确范式必须自带反斜杠对照");
  // 允许清单：kind 合法、逐条带实质理由；非相对路径的三处（附件逻辑路径 ×2 / reused_by id）必须在册
  assert.ok(SEPARATOR_SITES_ALLOWLIST.every((e) => e.reason.trim().length >= 20), "允许清单必须逐条带理由");
  assert.ok(SEPARATOR_SITES_ALLOWLIST.every((e) => e.kind === "rel-dual-separator" || e.kind === "non-rel-string"));
  assert.equal(
    SEPARATOR_SITES_ALLOWLIST.filter((e) => e.kind === "non-rel-string").length, 3,
    "brief 明确「已排除（非缺陷）」的三处必须逐条登记，而不是靠静默跳过",
  );
});

test("A4 负向对照：造违规样本（派生值裸 split/startsWith、内联 slice）⇒ 必红；非相对路径样本不得误红", () => {
  const v1 = judgeRelSeparatorGuard(fixture(
    `export function f(a: string, b: string) {\n  const rel = relative(a, b);\n  return rel.split("/")[0];\n}\n`,
  ), []);
  assert.equal(v1.problems.length, 1, "相对路径派生值上的裸 split(\"/\") 必须判红");
  assert.match(v1.problems[0], /\[unregistered\] core\/fixture\.ts:3 f /);
  assert.match(v1.problems[0], /split\("\/"\)/);

  const v2 = judgeRelSeparatorGuard(fixture(
    `export function g(a: string, b: string) {\n  const rel = relative(a, b);\n  return rel.startsWith("backlog/");\n}\n`,
  ), []);
  assert.equal(v2.problems.length, 1, "相对路径派生值上的裸 startsWith(\"x/\") 必须判红");
  assert.match(v2.problems[0], /startsWith\("backlog\/"\)/);

  const v3 = judgeRelSeparatorGuard(fixture(
    `export function h(root: string, file: string) {\n  const parts = file.slice(root.length + 1).split("/");\n  return parts[0];\n}\n`,
  ), []);
  assert.equal(v3.problems.length, 1, "内联 slice(root.length+1).split(\"/\") 必须判红（不得因没有变量名而漏检）");
  assert.match(v3.problems[0], /\[unregistered\]/);

  // 非相对路径但**未**归一化 ⇒ 也必须显式归类（守卫是「全量归类」，不是抽样）
  const rawParam = fixture(`export function k(p: string) {\n  return p.split("/");\n}\n`);
  const v4 = judgeRelSeparatorGuard(rawParam, []);
  assert.equal(v4.problems.length, 1, "非相对路径的裸 split(\"/\") 也必须登记并写明理由，不得静默通过");
  assert.match(v4.problems[0], /relDerived=false normalized=false/);

  // 正例对照①：非相对路径 + 显式归一化 ⇒ 放行（这正是要求的修复形态）
  const normalized = fixture(
    `export function k(path: string) {\n  const p = String(path ?? "").trim().replace(/\\\\/g, "/");\n  return p.split("/");\n}\n`,
  );
  assert.deepEqual(judgeRelSeparatorGuard(normalized, []).problems, [], "显式归一化后的非相对路径值不得误红");
});

test("A4 负向对照：允许清单退化为「裸 POSIX」「错挂分类」「无理由」「陈旧条目」⇒ 必红", () => {
  const dualSource = fixture(
    `export function isBacklogFile(file: string, root: string): boolean {\n  const rel = file.slice(root.length + 1);\n  return rel.startsWith("backlog/") || rel.startsWith("backlog\\\\");\n}\n`,
  );
  const reason = "负向对照样本：双分隔符对照写法，等价于归一化后判定（非产品源码，仅用于验证守卫判定力）";
  const good: SiteAllowEntry[] = [
    { file: "core/fixture.ts", symbol: "isBacklogFile", op: "startsWith", arg: '"backlog/"', kind: "rel-dual-separator", reason },
    { file: "core/fixture.ts", symbol: "isBacklogFile", op: "startsWith", arg: '"backlog\\\\"', kind: "rel-dual-separator", reason },
  ];
  assert.deepEqual(judgeRelSeparatorGuard(dualSource, good).problems, [], "前置：双分隔符写法 + 带理由清单应通过");

  // ① 把对照改成裸 POSIX（删掉反斜杠分支）⇒ 剩余站点缺反斜杠对照 + 另一条清单陈旧
  const degraded = fixture(
    `export function isBacklogFile(file: string, root: string): boolean {\n  const rel = file.slice(root.length + 1);\n  return rel.startsWith("backlog/");\n}\n`,
  );
  const degradedProblems = judgeRelSeparatorGuard(degraded, good).problems;
  assert.ok(degradedProblems.some((p) => p.includes("[allowlist-without-backslash]")), "裸 POSIX 写法不得被登记为正确范式");
  assert.ok(degradedProblems.some((p) => p.includes("[stale-allowlist]")), "清单与实现漂移必须判红");

  // ② 「非相对路径」的名义不得用来绕过收口：实际是相对路径派生 ⇒ 判红
  const wrongKind: SiteAllowEntry[] = [
    { file: "core/fixture.ts", symbol: "isBacklogFile", op: "startsWith", arg: '"backlog/"', kind: "non-rel-string", reason: "负向对照样本：故意错挂分类，用于验证「不得以非相对路径名义绕过」" },
  ];
  const wrongKindProblems = judgeRelSeparatorGuard(degraded, wrongKind).problems;
  assert.ok(wrongKindProblems.some((p) => p.includes("[misclassified-non-rel]")), "错挂分类必须判红");

  // 反向：登记为 rel-dual-separator 但值并非相对路径派生 ⇒ 判红
  const notRelSource = fixture(
    `export function isBacklogFile(file: string, root: string): boolean {\n  return file.startsWith("backlog/") || file.startsWith("backlog\\\\");\n}\n`,
  );
  const notRelProblems = judgeRelSeparatorGuard(notRelSource, good).problems;
  assert.ok(notRelProblems.some((p) => p.includes("[misclassified-rel]")), "把非派生值登记成 rel 例外必须判红");

  // ③ 理由过短 ⇒ 判红
  const shortReason: SiteAllowEntry[] = [{ ...good[0], reason: "历史遗留" }];
  assert.ok(
    judgeRelSeparatorGuard(dualSource, shortReason).problems.some((p) => p.includes("理由过短")),
    "允许清单必须带实质理由",
  );

  // ④ 陈旧条目（登记了却无命中）⇒ 判红
  const stale: SiteAllowEntry[] = [...good, {
    file: "core/fixture.ts", symbol: "nope", op: "split", arg: '"/"', kind: "non-rel-string",
    reason: "可疑的历史豁免，已经没有任何站点与之对应（用于验证陈旧清单必红）",
  }];
  assert.ok(
    judgeRelSeparatorGuard(dualSource, stale).problems.some((p) => p.includes("[stale-allowlist]")),
    "陈旧允许清单必须判红（防止豁免长期潜伏）",
  );

  // ⑤ 收口区间内的手术被豁免（否则 helper 自身会自判红）
  const inSurgery = fixture(
    `// ${SURGERY_BEGIN}\nexport function normalizeRelPath(rel: string): string {\n  return String(rel).replace(/\\\\/g, "/");\n}\nexport function relPathSegments(rel: string): string[] {\n  return normalizeRelPath(rel).split("/");\n}\n// ${SURGERY_END}\n`,
  );
  assert.deepEqual(judgeRelSeparatorGuard(inSurgery, []).problems, [], "收口区间内的分隔符手术不得被判红");

  // ⑥ 非路径的反斜杠转义不得被当成分隔符站点（避免守卫误红）
  assert.deepEqual(startsWithArgsToCheck(['"\\n"']), [], "孤立反斜杠转义不得被当成分隔符站点");
  assert.equal(startsWithArgsToCheck(['"backlog/"', '"backlog\\\\"']).length, 2, "双分隔符对照的两条都要算站点");
});

test("A4 负向对照（真实语料变异）：向真实 core/ops.ts 注入违规 ⇒ 必红；把双分隔符对照改回裸 POSIX ⇒ 必红", () => {
  const ops = CORPUS.find((f) => f.path === "core/ops.ts")!;
  // 变异①：真实源码 + 注入一个违规函数
  const injected = [{
    path: ops.path,
    text: `${ops.text}\nexport function g429Mutant(root: string, file: string): string {\n  const rel = relative(root, file);\n  return rel.split("/")[0];\n}\n`,
  }];
  const vm = judgeRelSeparatorGuard(injected);
  assert.equal(vm.problems.length, 1, "真实语料注入违规必须恰好红一处");
  assert.match(vm.problems[0], /\[unregistered\].*g429Mutant/s);

  // 变异②：真实源码里删掉 isBacklogFile 的反斜杠分支（回到 g-429 之前的裸 POSIX 写法）
  const degradedText = ops.text.replace(
    'return rel.startsWith("backlog/") || rel.startsWith("backlog\\\\");',
    'return rel.startsWith("backlog/");',
  );
  assert.notEqual(degradedText, ops.text, "前置：变异必须真的改到源码");
  const vd = judgeRelSeparatorGuard([{ path: ops.path, text: degradedText }]);
  assert.ok(vd.problems.some((p) => p.includes("[allowlist-without-backslash]")), "删掉反斜杠对照必须判红");
  assert.ok(vd.problems.some((p) => p.includes("[stale-allowlist]")), "删掉后清单条目陈旧必须判红");
});

// ============================================================================
// A5：Linux 端零回归（真实文件系统 + 真实事件流；等价于冒烟 T3 的归档/取消归档路径）
// ============================================================================

test("A5 归档/取消归档真实路径（backlog 扁平 / 独立 goals / 版本目录三形态）原样通过", () => {
  const root = tmpRoot();
  const flat = createGoal(root, { title: "backlog 扁平", actor: ACTOR });
  const standalone = createGoal(root, { title: "独立目标", actor: ACTOR });
  moveGoal(root, standalone, { to: "standalone", actor: ACTOR });
  const versioned = createGoal(root, { title: "版本目标", version: "v-g429", actor: ACTOR });
  assert.ok(existsSync(join(root, "backlog", `${flat}.md`)), "前置：扁平 backlog 形态");
  assert.ok(existsSync(join(root, "goals", standalone, "goal.md")), "前置：独立 goals 形态");
  assert.ok(existsSync(join(root, "versions", "v-g429", "goals", versioned, "goal.md")), "前置：版本形态");

  const archived: Array<[string, string, string]> = [
    [flat, join(root, "backlog", `${flat}.md`), join(root, "backlog", "archived", `${flat}.md`)],
    [standalone, join(root, "goals", standalone, "goal.md"), join(root, "goals", "archived", standalone, "goal.md")],
    [versioned, join(root, "versions", "v-g429", "goals", versioned, "goal.md"), join(root, "versions", "v-g429", "archived", versioned, "goal.md")],
  ];
  for (const [id, from, to] of archived) {
    archiveGoal(root, id, { actor: ACTOR });
    assert.ok(existsSync(to), `${id} 必须落到 ${to}`);
    assert.ok(!existsSync(from), `${id} 原位置必须消失`);
    assert.equal(loadGoal(to).meta.archived, true);
    unarchiveGoal(root, id, { actor: ACTOR });
    assert.ok(existsSync(from), `${id} 必须复原回 ${from}`);
    assert.ok(!existsSync(to), `${id} 归档位置必须消失`);
    assert.equal(loadGoal(from).meta.archived, false);
  }
  const archivedEvents = readEvents(root).filter((e) => e.event === "goal.archived");
  const unarchivedEvents = readEvents(root).filter((e) => e.event === "goal.unarchived");
  assert.equal(archivedEvents.length, 3, "三次归档三次事件");
  assert.equal(unarchivedEvents.length, 3, "三次取消归档三次事件");
  for (const e of [...archivedEvents, ...unarchivedEvents]) {
    for (const key of ["from", "to"] as const) {
      const v = String(e.details?.[key] ?? "");
      assert.ok(!v.includes("\\"), `事件 ${key} 必须是 POSIX 形态（Linux 上 relative() 产出 /）：${v}`);
    }
  }
  // 回归：归档/取消归档后 validate 不产生新的位置类问题
  assert.deepEqual(validate(root).filter((p) => p.includes("与目录(") || p.includes("但 version=")), []);
});

test("A5 注入反斜杠的派生判定（toWorkspaceCardPath / relEscapesRoot）在 Linux 上可判定 Windows 语义", () => {
  // Linux 上构造「relative() 产出反斜杠」的等价形态：文件名里带反斜杠（单层），relative() 即原样返回
  const ws = mkdtempSync(join(tmpdir(), "dsh-g429-ws-"));
  const cardRel = ".dsh-graph\\cards\\c-1.md";
  assert.equal(toWorkspaceCardPath(ws, join(ws, cardRel)), ".dsh-graph/cards/c-1.md",
    "反斜杠形态必须归一化为 POSIX 且不得拼出重复的 .dsh-graph 前缀");
  assert.equal(toWorkspaceCardPath(join(ws, ".dsh-graph"), join(ws, cardRel)), ".dsh-graph/cards/c-1.md");
  assert.equal(toWorkspaceCardPath(ws, join(ws, "other", "c-1.md")), ".dsh-graph/other/c-1.md",
    "非 .dsh-graph 前缀时仍按既有逻辑补前缀");
});
