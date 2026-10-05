/**
 * core/tests/g428-win-os-ledger.test.ts
 *
 * g-428 质量判据的自动化守卫：Windows 真机冒烟必须从「抽样」升级为
 * **清单式全面覆盖 + 防漂移**，具体钉住三件事：
 *
 *   ① **台账层（fail-closed）**：产品代码里每一个 OS 相关调用点都必须在
 *      `scripts/win-smoke-test.mjs` 的 `OS_SITE_ROWS` 里登记（站点 = 文件 + API + 顶层函数集合 +
 *      命中数），并给出风险面与映射（`ws:<冒烟步骤>` / `pg:<平台探针>`）或豁免理由。
 *      **未登记 ⇒ 判红；清单与实现不同步 ⇒ 判红；映射指向不存在的步骤/探针 ⇒ 判红。**
 *      有意样本只能走**成对标记**（`dsh-win-os-ledger:ignore-os-sites` … `:end-…`）且会打印忽略处数。
 *   ② **步骤清单 ≡ 实跑**：T3 的步骤 id 清单（`WIN_SMOKE_STEP_IDS`）必须全部出现在内嵌冒烟源里，
 *      运行时还会反查「清单里的步骤是否真的执行过」——防止有人把覆盖面悄悄删小却仍全绿。
 *   ③ **判定函数有判别力**：文案卫生（裸 EPERM/ENOTEMPTY/EBUSY/EACCES）、盘面总览（双份 / 残留空目标
 *      目录 / 锁残留 / 事件计数）、失败路径（预置非空目标 ⇒ 明确业务错误）都必须**真问题必红、干净样本必绿**。
 *
 * 为什么需要（不是理论风险）：0.18.0 的 Windows 真机 T1–T5 **全绿**，却漏掉了 g-427
 * （目录形态目标移入版本在 Windows 上必然 EPERM、重试永不收敛、并留下空目标目录）。
 * 根因是**覆盖面**：旧 T3 只调 `init/createGoal/setCriteria/setGoalTags/validate`，
 * 看板的文件系统生命周期零覆盖。故本守卫直接钉住覆盖面本身，而不是只钉判定口径。
 *
 * 说明（边界）：真机结论**不在本测试内**——本测试只固化「覆盖面 + 判定力 + 防漂移」；
 *   Windows 原生结论由负责人在真机执行 `scripts/win-smoke-test.mjs` 后回填，
 *   回填表与漏检记录见 `docs/platform-gate.md`。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  G427_FORM_STEP_IDS,
  OS_SITE_NON_GOALS,
  OS_SITE_PATTERNS,
  OS_SITE_REGISTRY,
  PLATFORM_PROBE_IDS,
  WIN_SMOKE_STEP_IDS,
  auditOsSiteLedger,
  buildLedgerRow,
  buildOsJsMutant,
  collectProductSourceFiles,
  judgeBoardSummary,
  judgeExpectedFailure,
  platformErrorLeak,
  resolveProductSourceRoot,
  scanOsCallSites,
} from "../../scripts/win-smoke-test.mjs";

const repoRoot = join(import.meta.dirname, "../..");
const SCRIPT = join(repoRoot, "scripts", "win-smoke-test.mjs");
const sourceRoot = resolveProductSourceRoot(repoRoot);
assert.ok(sourceRoot, "必须在仓库内跑（需要 core/*.ts 作为台账真源）");

const fixture = (text: string) => [{ path: "core/fixture.ts", text }];
const row = (file: string, api: string, hits: number, sites: string[], risk: string, map: string) =>
  buildLedgerRow([file, api, hits, sites, risk, map]);

// ============================================================================
// ① 台账：真源逐字段同步 + 规模下限 + 每项齐备（未登记即判红的核心）
// ============================================================================

test("g-428 判据 2：台账与产品代码逐字段同步（0 问题），且规模不减、g-427 站点在册", () => {
  const files = collectProductSourceFiles(sourceRoot!);
  const audit = auditOsSiteLedger(files);
  assert.deepEqual(
    audit.problems.map((p) => `[${p.kind}] ${p.detail}`),
    [],
    "台账必须与产品代码完全同步：未登记 / 命中数或顶层函数漂移 / 映射悬空都会在此判红",
  );
  assert.ok(audit.scanned >= 15, `扫描面不得萎缩（实际 ${audit.scanned} 个文件）`);
  assert.ok(audit.hits.length >= 200, `OS 调用点命中数不得萎缩（实际 ${audit.hits.length}）`);
  assert.ok(OS_SITE_REGISTRY.length >= 60, `登记项不得萎缩（实际 ${OS_SITE_REGISTRY.length}）`);
  assert.equal(audit.ignoredLines, 0, "当前应无 ignore 区域；一旦使用成对标记，本断言需连同理由一并更新");

  // g-427 的缺陷站点必须**在册**（这正是 0.18.0 漏检的那个目录搬迁实现）
  const opsRename = OS_SITE_REGISTRY.find((r) => r.file === "core/ops.ts" && r.api === "renameSync");
  assert.ok(opsRename, "core/ops.ts 的 renameSync 站点必须登记");
  assert.ok(opsRename!.sites.includes("renameDirInto"), "g-427 的 renameDirInto 必须在册（目录搬迁的唯一末级实现）");
  for (const fn of ["moveGoal", "archiveGoal", "unarchiveGoal", "postponeGoal"]) {
    assert.ok(opsRename!.sites.includes(fn), `目录/文件搬迁调用方 ${fn} 必须登记在 core/ops.ts#renameSync 下`);
  }

  // 每项：风险面 + 映射或豁免理由；映射不得悬空；key 不得重复
  const keys = new Set<string>();
  for (const r of OS_SITE_REGISTRY) {
    const key = `${r.file}#${r.api}`;
    assert.ok(!keys.has(key), `清单重复登记 ${key}`);
    keys.add(key);
    assert.ok(r.risk.trim().length >= 4, `${key} 缺少风险面描述`);
    assert.ok(r.refs.length > 0 || (r.exempt && r.exempt.length >= 8), `${key} 既无映射也无豁免理由`);
    assert.equal(r.invalidRef, null, `${key} 的映射串含无法识别的片段`);
    for (const ref of r.refs) {
      if (ref.kind === "ws") assert.ok(WIN_SMOKE_STEP_IDS.includes(ref.id), `${key} 映射到不存在的冒烟步骤 ${ref.id}`);
      if (ref.kind === "pg") assert.ok(PLATFORM_PROBE_IDS.includes(ref.id), `${key} 映射到不存在的平台探针 ${ref.id}`);
    }
  }
  for (const ref of OS_SITE_REGISTRY.flatMap((r) => r.refs).filter((x) => x.kind === "ws")) {
    assert.ok(WIN_SMOKE_STEP_IDS.includes(ref.id), `映射 ${ref.id} 不在步骤清单内`);
  }

  // 模式表与非目标 API 表：id 唯一，且非目标不得悄悄混进模式表
  assert.equal(new Set(OS_SITE_PATTERNS.map((d) => d.id)).size, OS_SITE_PATTERNS.length, "模式表 id 必须唯一");
  assert.ok(OS_SITE_PATTERNS.length >= 20, "模式表不得萎缩");
  assert.ok(OS_SITE_NON_GOALS.length >= 4, "显式非目标 API 表必须存在（避免隐性口径）");
  for (const n of OS_SITE_NON_GOALS) {
    for (const d of OS_SITE_PATTERNS) {
      assert.ok(!n.api.includes(d.id), `非目标 ${n.api} 与模式表项 ${d.id} 冲突`);
    }
  }
});

test("g-428 判据 2：未登记 ⇒ 判红；注释 / 具名导入 / 成对标记的口径必须成立", () => {
  // 反例：未登记命中
  const hit = auditOsSiteLedger(fixture("export function f() {\n  renameSync(1, 2);\n}\n"), { registry: [] });
  assert.deepEqual(
    hit.problems.map((p) => p.kind),
    ["unregistered"],
    "未登记的 renameSync 命中必须判红（fail-closed）",
  );
  assert.equal(hit.problems[0].key, "core/fixture.ts#renameSync");

  // 正例：无 OS 调用 ⇒ 0 问题
  assert.deepEqual(auditOsSiteLedger(fixture("export function f() {\n  return 1;\n}\n"), { registry: [] }).problems, []);

  // 注释行不产生命中（注释里提到 API 名不得虚增覆盖，也不得逼着人去登记）
  assert.deepEqual(auditOsSiteLedger(fixture("// renameSync(1, 2) 仅为说明\n"), { registry: [] }).problems, []);

  // ESM 具名导入不是调用点（那条链路由 T1 的 POSIX 常量门禁单独负责）
  assert.equal(scanOsCallSites(fixture('import { renameSync } from "node:fs";\n')).hits.length, 0);

  // 成对标记：区域内跳过且**计数**（不是隐形豁免）
  const ignored = scanOsCallSites(fixture(
    "// dsh-win-os-ledger:ignore-os-sites\nrenameSync(1, 2);\n// dsh-win-os-ledger:end-ignore-os-sites\n",
  ));
  assert.equal(ignored.hits.length, 0);
  assert.equal(ignored.ignoredLines, 3, "忽略处数必须被统计并打印");

  // 标记不配对 ⇒ 抛错（拒绝静默放宽）
  assert.throws(() => scanOsCallSites(fixture("// dsh-win-os-ledger:ignore-os-sites\nrenameSync(1, 2);\n")),
    /ignore 区域缺少/);
});

test("g-428 判据 2：清单与实现不同步（新增站点 / 站点消失 / 映射悬空）逐项判红", () => {
  const scoped = [row("core/cache.ts", "statSync", 1, ["computeGraphRevision"], "看板缓存新鲜度探测（只读）", "ws:T3.validate")];

  const drift = auditOsSiteLedger([{
    path: "core/cache.ts",
    text: "function computeGraphRevision() { statSync(\"a\"); }\nfunction extraSite() { statSync(\"b\"); }\n",
  }], { registry: scoped });
  assert.ok(drift.problems.some((p) => p.kind === "drift" && p.detail.includes("命中数")),
    "新增站点（命中数变化）必须判红");
  assert.ok(drift.problems.some((p) => p.kind === "drift" && p.detail.includes("顶层函数集合")),
    "新增顶层调用方必须判红");

  const stale = auditOsSiteLedger([{ path: "core/cache.ts", text: "export function computeGraphRevision() { return 1; }\n" }],
    { registry: scoped });
  assert.ok(stale.problems.some((p) => p.kind === "stale"), "实现里消失的站点必须判红（清单不得留幽灵项）");

  const dangling = auditOsSiteLedger([], { registry: [row("core/x.ts", "statSync", 0, ["f"], "风险面描述", "ws:T3.不存在的步骤")] });
  assert.ok(dangling.problems.some((p) => p.kind === "dangling"), "映射到不存在的冒烟步骤必须判红");

  const badMapping = auditOsSiteLedger([], { registry: [row("core/x.ts", "statSync", 0, ["f"], "风险面描述", "garbage") ] });
  assert.ok(badMapping.problems.some((p) => p.kind === "mapping" && p.detail.includes("无法识别")), "非法映射串必须判红");

  const shortExempt = auditOsSiteLedger([], { registry: [row("core/x.ts", "statSync", 0, ["f"], "风险面描述", "exempt:短")] });
  assert.ok(shortExempt.problems.some((p) => p.kind === "mapping" && p.detail.includes("豁免理由过短")), "豁免必须给理由");
});

// ============================================================================
// ② 步骤清单 ≡ 内嵌冒烟源 ≡ 覆盖率下限（防止覆盖面被悄悄删小）
// ============================================================================

test("g-428 判据 1：步骤清单与内嵌冒烟源一致，关键生命周期算子与盘面断言仍在", () => {
  const text = readScript();
  assert.equal(new Set(WIN_SMOKE_STEP_IDS).size, WIN_SMOKE_STEP_IDS.length, "步骤 id 必须唯一");
  assert.ok(WIN_SMOKE_STEP_IDS.length >= 30, `清单式覆盖不得萎缩（实际 ${WIN_SMOKE_STEP_IDS.length} 步）`);

  // 每个清单 id 都必须出现在内嵌冒烟源里（运行时另有「清单 ≡ 实跑」反查）
  for (const id of WIN_SMOKE_STEP_IDS) {
    assert.ok(text.includes(`"${id}"`), `内嵌冒烟源缺少步骤 ${id} —— 清单与实现已漂移`);
  }

  // g-427 形态（目录搬迁）步骤必须在册且被清单包含
  assert.ok(G427_FORM_STEP_IDS.length >= 5, "g-427 形态步骤不得少于 5 个（目录搬迁是缺陷现场）");
  for (const id of G427_FORM_STEP_IDS) {
    assert.ok(WIN_SMOKE_STEP_IDS.includes(id), `g-427 形态步骤 ${id} 必须在总清单内`);
  }

  // 关键算子与断言：删掉任一项都会让「完整生命周期 + 盘面断言」退化
  for (const symbol of [
    "moveGoal", "archiveGoal", "unarchiveGoal", "postponeGoal", "deleteGoal",
    "storeAttachment", "deleteAttachment", "addCard", "addMemory", "removeMemory",
    "setGoalTags", "writeSupervisorSession", "validate",
    "assertBoard", "boardSummary", "tx.persist_failed",
  ]) {
    assert.ok(text.includes(symbol), `内嵌冒烟源必须仍覆盖 ${symbol}（覆盖面不得回退）`);
  }
  // 盘面断言必须真的检查磁盘最终状态（源消失 / 计数唯一 / 完整搬迁）
  for (const phrase of ["源位置未消失", "在板上出现", "未随目录整体搬迁", "残留空目标目录", "锁/临时产物残留"]) {
    assert.ok(text.includes(phrase), `盘面断言必须包含「${phrase}」这类磁盘事实检查`);
  }
});

// ============================================================================
// ③ 判定函数判别力（真问题必红 / 干净样本必绿）
// ============================================================================

test("g-428 判据 1：用户可见文案卫生判定有判别力（裸平台错误码必红）", () => {
  for (const code of ["EPERM", "ENOTEMPTY", "EBUSY", "EACCES"]) {
    assert.equal(platformErrorLeak(`${code}: operation failed`), code, `${code} 必须被判为泄漏`);
    assert.equal(platformErrorLeak(`操作失败（${code}）`), code, `包裹在中文里的 ${code} 同样必须判红`);
  }
  assert.equal(platformErrorLeak("目标位置已存在且非空，拒绝覆盖：/x/versions/v/goals/g-1（源目录仍在原位，未移动）"), null);
  assert.equal(platformErrorLeak("XEPERMX"), null, "词内出现的字母串不是错误码");
  assert.equal(platformErrorLeak(""), null);
});

test("g-428 判据 1：盘面总览判定有判别力（双份 / 空目录 / 锁残留 / 事件计数必红）", () => {
  const dirty = judgeBoardSummary({
    copies: { "g-1": 2, "g-2": 1 },
    emptyGoalDirs: ["backlog/g-1"],
    lockArtifacts: [".lock.project.yaml"],
    persistFailed: 2,
    persistFailedExpected: 1,
    validate: ["boom"],
  });
  assert.equal(dirty.length, 5, `五类问题必须逐项判红，实际：${dirty.join(" | ")}`);
  assert.ok(dirty.some((p) => p.includes("双份")));

  const clean = judgeBoardSummary({
    copies: { "g-1": 1 },
    expectedLive: ["g-1"],
    expectedGone: ["g-9"],
    emptyGoalDirs: [],
    lockArtifacts: [],
    persistFailed: 1,
    persistFailedExpected: 1,
    validate: [],
  });
  assert.deepEqual(clean, [], "干净盘面必须零问题（防止判定退化为恒红）");

  assert.equal(judgeBoardSummary({ copies: {}, expectedLive: ["g-9"] }).length, 1, "预期存活的目标缺失必须判红");
  assert.equal(judgeBoardSummary({ copies: { "g-1": 1 }, expectedGone: ["g-1"] }).length, 1, "已删除目标仍在必须判红");
});

test("g-428 判据 1：失败路径判定有判别力（未报错 / 裸 EPERM / 无路径语义 / 半迁移态必红）", () => {
  const good = {
    threw: true,
    message: "目标位置已存在且非空，拒绝覆盖：/root/versions/v2-smoke/goals/g-1（源目录仍在原位，未移动）",
    expectedPath: "versions/v2-smoke/goals/g-1",
    sourceIntact: true,
    obstacleIntact: true,
    persistFailedDelta: 1,
  };
  assert.deepEqual(judgeExpectedFailure(good), [], "合格业务错误必须零问题");

  assert.equal(judgeExpectedFailure({ ...good, threw: false }).length, 1, "未报错必须判红（静默覆盖更糟）");
  const leaked = judgeExpectedFailure({ ...good, message: "EPERM: operation not permitted, rename 'a' -> 'b'" });
  assert.ok(leaked.some((p) => p.includes("EPERM")), "裸平台错误码必须判红");
  assert.ok(leaked.some((p) => p.includes("目标路径")), "缺目标路径必须判红");
  assert.ok(leaked.some((p) => p.includes("业务语义")), "缺业务语义必须判红");
  assert.equal(judgeExpectedFailure({ ...good, sourceIntact: false }).length, 1, "破坏源位置（半迁移态）必须判红");
  assert.equal(judgeExpectedFailure({ ...good, persistFailedDelta: 0 }).length, 1, "失败不可诊断必须判红");
});

test("g-428 判据 4：突变构造可信（形状不匹配必须拒绝，不得静默做无效对照）", () => {
  const src = "function other() {}\nfunction renameDirInto(srcDir, destDir) {\n    renameSync(srcDir, destDir);\n}\nfunction after() {}\n";
  const oldOrder = buildOsJsMutant(src, "old-order");
  const copyDup = buildOsJsMutant(src, "copy-dup");
  assert.ok(oldOrder && copyDup);
  assert.ok(oldOrder!.text.includes("EPERM"), "旧顺序突变必须显式模拟 NTFS/MoveFileEx 语义（目标目录已存在 ⇒ EPERM）");
  assert.ok(oldOrder!.text.startsWith("function other()") && oldOrder!.text.includes("function after()"),
    "突变必须只替换目标函数，保留前后文");
  assert.ok(copyDup!.text.includes("__g428CpSync") && !copyDup!.text.includes("renameSync(srcDir, destDir)"),
    "复制退化突变必须改为递归复制且不再 rename");
  assert.equal(buildOsJsMutant("function x() {}\n", "old-order"), null, "形状不匹配必须返回 null");
  assert.equal(buildOsJsMutant("", "copy-dup"), null);
});

// ============================================================================
// ④ 端到端：三个入口可用 + 负向对照真的必红（未构建 dist 时退化为 fail-closed 断言）
// ============================================================================

function readScript(): string {
  return readFileSync(SCRIPT, "utf8");
}

function runScript(args: string[], timeout: number) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repoRoot, encoding: "utf8", timeout });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("g-428 判据 3/5：--self-test 端到端全绿（含台账与判定逻辑的正反例）", () => {
  const r = runScript(["--self-test"], 300_000);
  assert.equal(r.status, 0, `--self-test 必须 exit 0\n${r.out.slice(-3000)}`);
  assert.match(r.out, /自检全部通过。/);
  assert.doesNotMatch(r.out, /自检失败/);
  // 新增判定逻辑必须在自检里有正反例（不是只跑旧检查）
  for (const needle of [
    "未登记的 renameSync 命中 ⇒ unregistered 判红",
    "清单项与实现不同步",
    "成对 ignore 标记内跳过并计数",
    "步骤清单：内嵌冒烟源确实包含全部步骤 id",
    "突变构造：形状不匹配 ⇒ 返回 null",
  ]) {
    assert.ok(r.out.includes(needle), `自检缺少新判定逻辑的正反例：${needle}`);
  }
});

test("g-428 判据 2/5：--static-only . 端到端全绿并打印覆盖清单（含忽略处数）", () => {
  const r = runScript(["--static-only", "."], 300_000);
  assert.equal(r.status, 0, `--static-only . 必须 exit 0\n${r.out.slice(-3000)}`);
  assert.match(r.out, /OS 调用点覆盖清单（台账层）/);
  assert.match(r.out, /未登记项即判红/);
  assert.match(r.out, /覆盖清单（文件 \| API \| 命中 \| 顶层函数/);
  assert.match(r.out, /忽略处数 0/);
  assert.match(r.out, /总判定：PASS/);
});

test("g-428 判据 4：--mutation-check 负向对照必红（已构建包）／未构建时 fail-closed", () => {
  const hasDist = existsSync(join(repoRoot, "dist", "core", "ops.js"));
  const r = runScript(["--mutation-check"], 600_000);
  if (!hasDist) {
    assert.notEqual(r.status, 0, "未构建 dist 时必须 fail-closed（不得静默 PASS）");
    assert.match(r.out, /未找到 core\/ops\.js/);
    return;
  }
  assert.equal(r.status, 0, `--mutation-check 必须 exit 0（两种突变都要被捕获）\n${r.out.slice(-3000)}`);
  assert.match(r.out, /基线对照（未突变，同一夹具）[^\n]*必|基线对照/);
  assert.match(r.out, /还原 g-427 旧顺序[^\n]*必红已实拍/);
  assert.match(r.out, /文案泄漏=EPERM/, "旧顺序突变必须同时证明「不泄漏错误码」这条断言有鉴别力");
  assert.match(r.out, /搬迁退化为复制[^\n]*必红已实拍/);
  assert.match(r.out, /双份检出=true/);
  assert.doesNotMatch(r.out, /FAIL ❌/);
});
