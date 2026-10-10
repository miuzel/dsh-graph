/**
 * core/tests/g475-harness-combo-probes.test.ts
 *
 * g-475 质量判据的自动化守卫：两平台门禁执行件必须覆盖 **harness 组合 / OS 行为差异**，
 * 具体钉住四件事：
 *
 *   ① **H 清单穷尽（单一真源）**：`HARNESS_PROBE_ROWS` 只允许定义一次（在
 *      `scripts/win-smoke-test.mjs`），id 恰好是 H1–H6、不重不漏，每项都有运行器
 *      （`HARNESS_PROBE_RUNNERS`），反之运行器不得是孤儿；标题与判定口径齐备。
 *   ② **两件消费（防第二份并行定义）**：`scripts/win-smoke-test.mjs` 与
 *      `scripts/platform-smoke-test.mjs` **都**调用 `runHarnessProbes(`；消费件里不得出现
 *      H 判定/清单/运行器的第二份定义；H 层必须真的接进门禁流水线（`harnessProbeLayer(` 有调用点）。
 *   ③ **判定有判别力**：H1–H6 的判定函数用合成样本把「真问题必红 / 干净样本必绿」两向钉住，
 *      其中 H2 的**负向对照**（注入已知不存在的名字）必须判红 —— 否则「allow ⊆ existing」可能是恒真。
 *   ④ **H3 不得静默通过**：未在隔离实例上真实派发时必须是显式 `SKIP`（文案点名「需真机/实例」），
 *      绝不允许假装 PASS。
 *
 * 为什么需要（不是理论风险）：v0.20.1 的 Windows 真机 T1–T5 **全绿**，却漏掉 g-473 ——
 *   Windows 上模型面向工具是 `pwsh`（不注册 `bash`），插件把 `bash` 写进角色白名单，
 *   `@deepseek-ai/dsh-tools` 的 `restrict()` 对未知名硬抛，三条派发路径必挂。
 *   既有门禁只守「OS API 调用点」（g-428）与「POSIX 专有常量具名导入」（T1），**不守组合依赖**。
 *   故本守卫钉住「组合声明 × 角色白名单求交」这条此前完全缺失的覆盖面本身。
 *
 * 说明（边界）：真机/实例结论**不在本测试内** —— H3 的 Windows/macOS 原生派发由负责人在真机上
 *   执行并用 `--h3-dispatch-json` 回传事实；L2 的 H1/H2/H4–H6 需要已构建的 `dist/core/*.js`
 *   与 DSH 组合声明，属**门禁执行件**的职责（`--static-only` / `--mutation-check`），
 *   本测试只固化「清单 + 消费 + 判定力 + 防漂移」，不依赖 dist，故在纯源码检出上也能跑。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  DSH_TOOL_REGISTRY,
  HARNESS_ABSENT_TOOL,
  HARNESS_PROBE_CONSUMER_FILES,
  HARNESS_PROBE_CONSUMER_MARKER,
  HARNESS_PROBE_DEFINITION_MARKER,
  HARNESS_PROBE_IDS,
  HARNESS_PROBE_ROWS,
  HARNESS_PROBE_RUNNERS,
  H3_REQUIRED_ROLES,
  auditHarnessProbeConsumers,
  auditHarnessProbeManifest,
  auditToolRegistry,
  buildToolCapabilityMutant,
  collectHarnessProbeConsumerFiles,
  compositionShellTools,
  compositionToolNames,
  evaluatePlatformCondition,
  formatHarnessProbeMatrix,
  harnessProbeRow,
  judgeArgvQuoting,
  judgeCaseSemanticsInjection,
  judgeCrlfEncodingRoundTrip,
  judgeDispatchAvailability,
  judgePathSeparatorSemantics,
  judgeRoleWhitelistIntersection,
  judgeShellToolComposition,
  quoteForCmd,
  roleFilterProblems,
  scanCompositionToolDeclarations,
  splitCmd,
  toolPluginBaseName,
} from "../../scripts/win-smoke-test.mjs";

const repoRoot = join(import.meta.dirname, "../..");
const WIN_SCRIPT = join(repoRoot, "scripts", "win-smoke-test.mjs");
const PLATFORM_SCRIPT = join(repoRoot, "scripts", "platform-smoke-test.mjs");

const readText = (p: string): string => readFileSync(p, "utf8");

// ---------------------------------------------------------------------------
// ① H 清单穷尽（单一真源）
// ---------------------------------------------------------------------------

test("g475 ①：H 清单 id 恰好是 H1–H6，不重不漏、每项齐备且有运行器", () => {
  const audit = auditHarnessProbeManifest(HARNESS_PROBE_ROWS, HARNESS_PROBE_RUNNERS);
  assert.deepEqual(audit.problems, [], `清单审计必须 0 问题，实际：${JSON.stringify(audit.problems)}`);
  assert.deepEqual([...HARNESS_PROBE_IDS], ["H1", "H2", "H3", "H4", "H5", "H6"]);
  assert.equal(HARNESS_PROBE_ROWS.length, HARNESS_PROBE_IDS.length, "清单条数必须与 id 全集一致");
  assert.equal(
    Object.keys(HARNESS_PROBE_RUNNERS).length,
    HARNESS_PROBE_IDS.length,
    "运行器数量必须与清单一致（多一个少一个都是漂移）",
  );
  for (const row of HARNESS_PROBE_ROWS) {
    const def = harnessProbeRow(row);
    assert.ok(HARNESS_PROBE_IDS.includes(def.id), `清单含未登记 id：${def.id}`);
    assert.ok(def.title.length >= 4, `${def.id} 缺少标题`);
    assert.ok(def.criterion.length >= 20, `${def.id} 判定口径过短`);
    assert.ok(
      ["offline", "composition", "dist", "instance"].includes(def.requires),
      `${def.id} 的 requires 非法：${def.requires}`,
    );
    assert.equal(typeof HARNESS_PROBE_RUNNERS[def.id as keyof typeof HARNESS_PROBE_RUNNERS], "function", `${def.id} 无运行器`);
  }
  // H3 是唯一「需真机/实例」的探针：这条恰好把「覆盖面」写死，防止有人把 H3 悄悄删掉换全绿
  assert.equal(harnessProbeRow(HARNESS_PROBE_ROWS[2]).id, "H3");
  assert.equal(harnessProbeRow(HARNESS_PROBE_ROWS[2]).requires, "instance");
});

test("g475 ①：清单审计有鉴别力（漏项/多项/重复/缺运行器/孤儿运行器 逐项判红）", () => {
  const kinds = (rows: unknown, runners: unknown) =>
    auditHarnessProbeManifest(rows, runners).problems.map((p: { kind: string }) => p.kind);
  assert.ok(kinds(HARNESS_PROBE_ROWS.slice(1), HARNESS_PROBE_RUNNERS).includes("missing-probe"), "漏一项必须判红");
  assert.ok(
    kinds([...HARNESS_PROBE_ROWS, ["H7", "offline", "多余探针", "这是一个足够长的判定口径说明文字"]], HARNESS_PROBE_RUNNERS)
      .includes("unknown-probe"),
    "多一项必须判红",
  );
  assert.ok(
    kinds([...HARNESS_PROBE_ROWS, HARNESS_PROBE_ROWS[0]], HARNESS_PROBE_RUNNERS).includes("duplicate-probe"),
    "重复登记必须判红",
  );
  const noH1 = { ...HARNESS_PROBE_RUNNERS } as Record<string, unknown>;
  delete noH1.H1;
  assert.ok(kinds(HARNESS_PROBE_ROWS, noH1).includes("missing-runner"), "缺运行器必须判红");
  assert.ok(kinds(HARNESS_PROBE_ROWS, { ...HARNESS_PROBE_RUNNERS, H7: () => {} }).includes("orphan-runner"), "孤儿运行器必须判红");
  assert.ok(kinds([], {}).includes("missing-probe"), "空清单必须判红（不得「空即通过」）");
});

// ---------------------------------------------------------------------------
// ② 两件消费（防第二份并行定义）
// ---------------------------------------------------------------------------

test("g475 ②：清单只定义一次、两件执行件都消费、消费件不自行实现 H 判定", () => {
  const files = collectHarnessProbeConsumerFiles(repoRoot);
  assert.equal(files.length, HARNESS_PROBE_CONSUMER_FILES.length);
  for (const f of files) {
    assert.ok(f.text.length > 0, `未能读取消费件 ${f.path}`);
  }
  const audit = auditHarnessProbeConsumers(files);
  assert.deepEqual(audit.problems, [], `消费审计必须 0 问题，实际：${JSON.stringify(audit.problems)}`);

  // 清单定义的物理位置：只有 win-smoke（宿主）持有它
  const winText = readText(WIN_SCRIPT);
  const platformText = readText(PLATFORM_SCRIPT);
  assert.ok(winText.includes(HARNESS_PROBE_DEFINITION_MARKER), "win-smoke 必须是清单宿主");
  assert.ok(!platformText.includes(HARNESS_PROBE_DEFINITION_MARKER), "platform-smoke 不得定义清单（只消费）");
  assert.ok(winText.includes(HARNESS_PROBE_CONSUMER_MARKER), "win-smoke 必须调用共享入口");
  assert.ok(platformText.includes(HARNESS_PROBE_CONSUMER_MARKER), "platform-smoke 必须调用共享入口");
  assert.ok(platformText.includes('from "./win-smoke-test.mjs"'), "platform-smoke 必须从宿主导入（而非拷贝）");
});

test("g475 ②：消费审计有鉴别力（抹掉消费调用 / 第二份定义 必红）", () => {
  const files = collectHarnessProbeConsumerFiles(repoRoot);
  const stripped = auditHarnessProbeConsumers(
    files.map((f) => ({ ...f, text: f.text.split(HARNESS_PROBE_CONSUMER_MARKER).join("__removed__") })),
  );
  assert.equal(
    stripped.problems.filter((p: { kind: string }) => p.kind === "unconsumed").length,
    HARNESS_PROBE_CONSUMER_FILES.length,
    "抹掉全部消费调用后每一件都必须被点名",
  );
  const dupDef = auditHarnessProbeConsumers(
    files.map((f) => ({ ...f, text: `${f.text}\n${HARNESS_PROBE_DEFINITION_MARKER} = [];\n` })),
  );
  assert.ok(dupDef.problems.some((p: { kind: string }) => p.kind === "single-source"), "第二份定义必须判红");
  const dupJudge = auditHarnessProbeConsumers(
    files.map((f) => ({
      ...f,
      text: f.path === HARNESS_PROBE_CONSUMER_FILES[1] ? `${f.text}\nfunction judge${"ArgvQuoting"}() {}\n` : f.text,
    })),
  );
  assert.ok(
    dupJudge.problems.some((p: { kind: string }) => p.kind === "duplicate-definition"),
    "消费件里出现第二份 H 判定必须判红",
  );
  assert.ok(
    auditHarnessProbeConsumers([files[0]]).problems.some((p: { kind: string }) => p.kind === "consumer-missing"),
    "缺少消费件必须判红",
  );
});

test("g475 ②：H 层真的接进门禁流水线（静态分支 + 完整门禁；platform 侧也有调用点）", () => {
  const winText = readText(WIN_SCRIPT);
  const platformText = readText(PLATFORM_SCRIPT);
  const layerCalls = winText.split("harnessProbeLayer(").length - 1;
  assert.ok(layerCalls >= 3, `win-smoke 的 harnessProbeLayer 至少要有定义 + --static-only + 完整门禁三处，实际 ${layerCalls}`);
  assert.ok(
    /--static-only[\s\S]{0,4000}harnessProbeLayer\(/.test(winText),
    "--static-only 分支必须真的跑 H 层（否则 Linux 侧四入口覆盖不到）",
  );
  assert.ok(platformText.includes("checkHarnessProbes("), "platform-smoke 必须有自己的 H 层调用点");
  assert.ok(platformText.split("checkHarnessProbes(").length - 1 >= 2, "platform-smoke 的 H 层要有定义 + 调用");
  // 两件都渲染同一形状的矩阵行（跨平台逐项可比）
  const line = formatHarnessProbeMatrix("linux", HARNESS_PROBE_ROWS.map((r) => ({
    ...harnessProbeRow(r), level: "PASS", detail: "", problems: [],
  })));
  assert.match(line, /^harness 组合矩阵 \| 平台=linux \| /);
  for (const id of HARNESS_PROBE_IDS) assert.ok(line.includes(`${id}=`), `矩阵行缺少 ${id}`);
  assert.equal(winText.split("lastHarnessProbeRun.matrix").length - 1 >= 1, true, "win-smoke 回传报告须含矩阵行");
});

test("g475 ②：既有导出点零削减（两件的既有符号仍在，新增只做加法）", () => {
  const winText = readText(WIN_SCRIPT);
  const platformText = readText(PLATFORM_SCRIPT);
  const winRequired = [
    "OS_SITE_REGISTRY", "WIN_SMOKE_STEP_IDS", "G427_FORM_STEP_IDS", "PLATFORM_PROBE_IDS",
    "auditOsSiteLedger", "auditDispatchToolPortability", "buildOsJsMutant", "scanOsCallSites",
    "judgeBoardSummary", "judgeExpectedFailure", "platformErrorLeak",
  ];
  for (const sym of winRequired) {
    assert.ok(
      new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${sym}\\b`).test(winText),
      `win-smoke 既有导出 ${sym} 不得削减`,
    );
  }
  const platformRequired = [
    "resolveTempRoot", "judgeCaseSensitivity", "judgeMountType", "judgeSymlinkRoot", "judgeConcurrentCas",
    "judgeAtomicWrite", "judgeExdev", "judgeLocaleRoundTrip", "scanLinuxOnlyAssumptions", "buildForwardArgs",
    "forwardRequested", "forwardEnv", "itemLevel", "selfCheck",
  ];
  for (const sym of platformRequired) {
    assert.ok(
      new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${sym}\\b`).test(platformText),
      `platform-smoke 既有导出 ${sym} 不得削减`,
    );
  }
  // g-475 的加法式导出
  for (const sym of ["splitCmd", "quoteForCmd", "buildShellCommandLine", "runHarnessProbes", "HARNESS_PROBE_ROWS"]) {
    assert.ok(new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${sym}\\b`).test(winText), `win-smoke 应导出 ${sym}`);
  }
});

// ---------------------------------------------------------------------------
// ③ 判定有判别力（H1–H6 合成样本）
// ---------------------------------------------------------------------------

const compositionFixture = [
  "- id: tool-bash",
  "  name: '@deepseek-ai/dsh-tool-bash'",
  "  disabled: !!js process.platform === 'win32'",
  "- id: tool-pwsh",
  "  name: '@deepseek-ai/dsh-tool-pwsh'",
  "  disabled: !!js process.platform !== 'win32'",
  "- id: tool-fs",
  "  name: '@deepseek-ai/dsh-tool-fs'",
  "- id: tool-web",
  "  name: '@deepseek-ai/dsh-tool-web'",
].join("\n");

test("g475 ③ H1：平台条件求值 + 组合扫描 + 「组合 ≡ 插件解析」判定有判别力", () => {
  assert.equal(evaluatePlatformCondition("!!js process.platform === 'win32'", "win32").value, true);
  assert.equal(evaluatePlatformCondition("!!js process.platform === 'win32'", "linux").value, false);
  assert.equal(evaluatePlatformCondition("!!js process.platform !== 'win32'", "darwin").value, true);
  assert.equal(evaluatePlatformCondition("!!js ['darwin', 'win32'].includes(process.platform)", "darwin").value, true);
  assert.equal(evaluatePlatformCondition("true", "linux").value, true);
  const unknown = evaluatePlatformCondition("!!js process.platform.startsWith('win')", "win32");
  assert.equal(unknown.ok, false, "无法识别的**平台**形态必须判 ok=false（不得静默放行）");
  assert.equal(unknown.platformRelevant, true);
  const envCond = evaluatePlatformCondition('!!js "!(process.env.DSH_PRIMARY_RUNTIME)"', "linux");
  assert.equal(envCond.ok, false);
  assert.equal(envCond.platformRelevant, false, "env 条件不属于平台条件（不得误红）");

  const { declarations } = scanCompositionToolDeclarations([{ path: "presets/x.patch.yml", text: compositionFixture }]);
  assert.equal(declarations.length, 4);
  assert.deepEqual(compositionShellTools(declarations, "win32").tools, ["pwsh"]);
  assert.deepEqual(compositionShellTools(declarations, "linux").tools, ["bash"]);
  assert.deepEqual(compositionShellTools(declarations, "darwin").tools, ["bash"]);
  assert.equal(compositionToolNames(declarations, "win32").names.has("bash"), false, "win32 组合不得有 bash（病根现场）");
  assert.equal(compositionToolNames(declarations, "win32").names.has("read"), true);

  const winShell = new Set(compositionToolNames(declarations, "win32").names);
  const facts = (over: Record<string, unknown> = {}) => ({
    platforms: ["win32", "linux", "darwin"],
    composition: {
      win32: compositionShellTools(declarations, "win32"),
      linux: compositionShellTools(declarations, "linux"),
      darwin: compositionShellTools(declarations, "darwin"),
    },
    pluginProbe: {
      win32: { name: "pwsh", source: "probe" },
      linux: { name: "bash", source: "probe" },
      darwin: { name: "bash", source: "probe" },
    },
    pluginFallback: {
      win32: { name: "pwsh", source: "platform-fallback" },
      linux: { name: "bash", source: "platform-fallback" },
      darwin: { name: "bash", source: "platform-fallback" },
    },
    compositionProblems: [],
    registryProblems: [],
    currentPlatform: "win32",
    currentResolved: { name: "pwsh", source: "probe" },
    ...over,
  });
  assert.equal(winShell.has("pwsh"), true);
  assert.equal(judgeShellToolComposition(facts()).level, "PASS", "组合与解析一致必须判绿");
  assert.equal(
    judgeShellToolComposition(facts({ pluginProbe: { ...facts().pluginProbe, win32: { name: "bash", source: "probe" } } })).level,
    "FAIL",
    "插件解析出 bash（组合是 pwsh）必须判红",
  );
  assert.equal(
    judgeShellToolComposition(facts({ pluginFallback: { ...facts().pluginFallback, win32: { name: "bash", source: "platform-fallback" } } })).level,
    "FAIL",
    "无探针时回落错平台必须判红",
  );
  assert.equal(
    judgeShellToolComposition(facts({ registryProblems: [{ detail: "未登记的工具插件 X" }] })).level,
    "FAIL",
    "组合声明了未登记的工具插件必须判红（fail-closed）",
  );
  assert.equal(
    judgeShellToolComposition(facts({
      composition: { ...facts().composition, win32: { tools: [], unknown: [{ id: "tool-pwsh", why: "形态无法识别" }] } },
    })).level,
    "FAIL",
    "平台条件形态变了必须判红（不得默认放行）",
  );
});

test("g475 ③ H2：白名单求交「allow ⊆ 组合实际存在」+ 负向对照必红", () => {
  const existing = new Set(["read", "write", "edit", "bash", "glob", "grep"]);
  assert.deepEqual(roleFilterProblems("reviewer", "standard", ["read", "bash"], existing), []);
  assert.equal(roleFilterProblems("reviewer", "standard", ["read", HARNESS_ABSENT_TOOL], existing).length, 1);
  assert.equal(roleFilterProblems("reviewer", "standard", null, existing).length, 1, "未产出 allow 必须判红（求交路径没走到）");

  const goodCase = {
    role: "reviewer", mode: "standard", platform: "linux",
    allow: ["read", "bash"], existing, shellExpected: "bash", shellForbidden: "pwsh",
  };
  const base = {
    cases: [goodCase],
    injections: [],
    absentTool: HARNESS_ABSENT_TOOL,
  };
  assert.equal(
    judgeRoleWhitelistIntersection({ ...base, negativeControl: { problems: roleFilterProblems("reviewer", "standard", ["read", HARNESS_ABSENT_TOOL], existing) } }).level,
    "PASS",
    "干净样本 + 有效负向对照必须判绿",
  );
  assert.equal(
    judgeRoleWhitelistIntersection({ ...base, negativeControl: { problems: [] } }).level,
    "FAIL",
    "负向对照失效（注入不存在名字仍全绿）必须判红 —— 否则「补集为空」可能是恒真",
  );
  assert.equal(
    judgeRoleWhitelistIntersection({ ...base, negativeControl: { problems: ["x"] }, cases: [{ ...goodCase, allow: ["read", "bash", "pwsh"] }] }).level,
    "FAIL",
    "另一平台的 shell 名出现在 allow 里必须判红",
  );
  assert.equal(
    judgeRoleWhitelistIntersection({ ...base, negativeControl: { problems: ["x"] }, cases: [{ ...goodCase, allow: ["read", "read"] }], injections: [{ id: "i", problems: ["注入失败"] }] })
      .level,
    "FAIL",
    "注入用例出问题必须判红",
  );

  // 台账：未登记的工具插件 fail-closed；子路径按包名归一；工具名必须有 description 佐证
  const decl = (name: string, extra = "") =>
    scanCompositionToolDeclarations([{ path: "x.patch.yml", text: `- id: t\n  name: '${name}'\n${extra}` }]).declarations;
  assert.ok(
    auditToolRegistry(decl("@deepseek-ai/dsh-tool-brand-new"), { registry: DSH_TOOL_REGISTRY })
      .problems.some((p: { kind: string }) => p.kind === "unregistered-tool-plugin"),
    "未登记的工具插件必须判红",
  );
  assert.deepEqual(
    auditToolRegistry(decl("@deepseek-ai/dsh-tool-subagent-control/list-agents"), { registry: DSH_TOOL_REGISTRY }).problems,
    [],
    "子路径声明按包名归一（/list-agents 不得判红）",
  );
  assert.equal(toolPluginBaseName("@deepseek-ai/dsh-tool-a/b/c"), "@deepseek-ai/dsh-tool-a");
  assert.deepEqual(
    auditToolRegistry(decl("@deepseek-ai/dsh-tool-web"), {
      registry: DSH_TOOL_REGISTRY,
      descriptions: { "@deepseek-ai/dsh-tool-web": "Model-facing web tools (web_search, web_fetch)" },
    }).problems,
    [],
  );
  assert.ok(
    auditToolRegistry(decl("@deepseek-ai/dsh-tool-web"), {
      registry: DSH_TOOL_REGISTRY,
      descriptions: { "@deepseek-ai/dsh-tool-web": "完全无关的描述" },
    }).problems.some((p: { kind: string }) => p.kind === "tool-name-unverified"),
    "台账工具名必须有该包 description 佐证（不得凭空编造）",
  );
  assert.ok(
    auditToolRegistry(decl("@deepseek-ai/dsh-tool-web", "  disabled: !!js process.platform.startsWith('win')\n"), { registry: DSH_TOOL_REGISTRY })
      .problems.some((p: { kind: string }) => p.kind === "unknown-platform-condition"),
    "无法识别的**平台**条件必须判红",
  );
  assert.deepEqual(
    auditToolRegistry(decl("@deepseek-ai/dsh-tool-web", '  disabled: !!js "!(process.env.X)"\n'), { registry: DSH_TOOL_REGISTRY }).problems,
    [],
    "非平台条件不进平台条件审计（env 条件不得误红）",
  );
  assert.ok(DSH_TOOL_REGISTRY.length >= 20, "台账规模下限：登记 ≥ 20 个工具插件（渐进萎缩必红）");
  assert.equal(new Set(DSH_TOOL_REGISTRY.map((r: { pkg: string }) => r.pkg)).size, DSH_TOOL_REGISTRY.length, "台账不得重复登记");
});

test("g475 ③ H3：三条派发路径的判定 + 未派发必须显式 SKIP（不得静默通过）", () => {
  const skip = judgeDispatchAvailability({ attempted: false });
  assert.equal(skip.level, "SKIP");
  assert.match(skip.detail, /需真机\/实例/, "SKIP 文案必须点名「需真机/实例」");
  assert.deepEqual([...H3_REQUIRED_ROLES], ["reviewer", "collector", "executor-minimal"]);

  const ok = judgeDispatchAvailability({
    attempted: true,
    roles: H3_REQUIRED_ROLES.map((role) => ({ role, childId: "child-1", errors: [] })),
  });
  assert.equal(ok.level, "PASS", "三路径齐备且 child_id 非空必须判绿");

  assert.equal(
    judgeDispatchAvailability({ attempted: true, roles: [{ role: "reviewer", childId: "c", errors: [] }] }).level,
    "FAIL",
    "缺路径必须判红",
  );
  assert.equal(
    judgeDispatchAvailability({
      attempted: true,
      roles: H3_REQUIRED_ROLES.map((role) => ({ role, childId: role === "collector" ? "" : "c", errors: [] })),
    }).level,
    "FAIL",
    "child_id 为空必须判红",
  );
  for (const sig of ["tools.restrict() names unknown global tool: bash", "子代理启动失败：child_error"]) {
    assert.equal(
      judgeDispatchAvailability({
        attempted: true,
        roles: H3_REQUIRED_ROLES.map((role) => ({ role, childId: "c", errors: role === "executor-minimal" ? [sig] : [] })),
      }).level,
      "FAIL",
      `失败签名必须判红：${sig}`,
    );
  }
});

test("g475 ③ H4：分隔符拒绝语义 + 卷大小写语义注入 判定有判别力", () => {
  const reject = (name: string, message: string) => ({ name, kind: "reject", threw: true, created: null, message, errnoLeak: null });
  const good = {
    cases: [
      reject("a\\b.txt", "附件路径含非法反斜杠：a\\b.txt"),
      reject("/abs.txt", "附件路径不能是绝对路径"),
      reject("../esc.txt", "附件路径含非法片段（空/./..）"),
      { name: "a/b.txt", kind: "accept", threw: false, created: "a/b.txt", message: "", errnoLeak: null },
    ],
  };
  assert.equal(judgePathSeparatorSemantics(good).level, "PASS");
  assert.equal(
    judgePathSeparatorSemantics({ cases: [{ ...good.cases[0], threw: false }] }).level,
    "FAIL",
    "该拒未拒必须判红",
  );
  assert.equal(
    judgePathSeparatorSemantics({ cases: [{ ...good.cases[1], created: "/abs.txt" }] }).level,
    "FAIL",
    "被拒绝却仍落地必须判红",
  );
  assert.equal(
    judgePathSeparatorSemantics({ cases: [{ ...good.cases[2], message: "EPERM: operation not permitted", errnoLeak: "EPERM" }] }).level,
    "FAIL",
    "拒绝文案泄漏平台错误码必须判红（应给可读文案）",
  );
  assert.equal(
    judgePathSeparatorSemantics({ cases: [{ ...good.cases[3], threw: true, message: "误拒" }] }).level,
    "FAIL",
    "合法名被拒必须判红",
  );

  assert.equal(
    judgeCaseSemanticsInjection({
      requested: "a.txt", actual: "A.txt",
      insensitive: { result: { actual: "A.txt", aliased: true } },
      sensitive: { result: null },
    }).level,
    "PASS",
  );
  assert.equal(
    judgeCaseSemanticsInjection({
      requested: "a.txt", actual: "A.txt",
      insensitive: { result: null },
      sensitive: { result: { actual: "A.txt", aliased: true } },
    }).level,
    "FAIL",
    "注入通道失效 / 敏感卷仍别名 必须判红",
  );
});

test("g475 ③ H5：CRLF/编码往返 + 机器头注入折叠 判定有判别力", () => {
  const good = {
    description: { written: true, loneCr: false, byteExact: true, utf8Lossless: true },
    results: { written: true, loneCr: false, headerFolded: true, injectedLineAbsent: true, bodyNoCr: true, bodyKeepsLines: true },
  };
  assert.equal(judgeCrlfEncodingRoundTrip(good).level, "PASS");
  const cases: Array<[string, Record<string, unknown>]> = [
    ["孤立 CR", { description: { ...good.description, loneCr: true } }],
    ["正文未逐字节", { description: { ...good.description, byteExact: false } }],
    ["UTF-8 往返有损", { description: { ...good.description, utf8Lossless: false } }],
    ["机器头未折叠", { results: { ...good.results, headerFolded: false } }],
    ["注入自成一行的痕迹", { results: { ...good.results, injectedLineAbsent: false } }],
    ["正文未归一为 LF", { results: { ...good.results, bodyNoCr: false } }],
    ["正文丢了逻辑行", { results: { ...good.results, bodyKeepsLines: false } }],
    ["results 未写入", { results: { written: false, reason: "backlog-goal-no-dir" } }],
  ];
  for (const [label, over] of cases) {
    assert.equal(judgeCrlfEncodingRoundTrip({ ...good, ...over }).level, "FAIL", `${label} 必须判红`);
  }
});

test("g475 ③ H6：`--dsh` 单串解析 + cmd.exe 引号 + 真实 argv 用例齐备性 判定有判别力", () => {
  assert.deepEqual(splitCmd("npx -y @deepseek-ai/dsh"), ["npx", "-y", "@deepseek-ai/dsh"]);
  assert.deepEqual(splitCmd('"C:\\Program Files\\node.exe" -y @deepseek-ai/dsh'), ["C:\\Program Files\\node.exe", "-y", "@deepseek-ai/dsh"]);
  assert.deepEqual(splitCmd("node 'a b' c"), ["node", "a b", "c"]);
  assert.deepEqual(splitCmd(""), []);
  assert.deepEqual(splitCmd("   "), []);
  assert.deepEqual(quoteForCmd(["a&b"]), ['"a&b"']);
  assert.deepEqual(quoteForCmd(['"pre-quoted"']), ['"pre-quoted"']);
  assert.deepEqual(quoteForCmd(["plain", ".\\a.tgz"]), ["plain", ".\\a.tgz"]);

  const empty = judgeArgvQuoting({ splitCases: [], quoteCases: [], lineCases: [], argvCases: [], shellCases: [] });
  assert.equal(empty.level, "FAIL", "缺真实 argv/shell 用例必须判红（防止退化成纯字符串比较）");
  assert.equal(empty.problems.length, 2);
  assert.equal(
    judgeArgvQuoting({
      argvCases: [{ args: ["a b"], got: ["a", "b"], ok: false }],
      shellCases: [{ command: "x", got: null, ok: false }],
    }).level,
    "FAIL",
    "真实传递不一致必须判红",
  );
  assert.equal(
    judgeArgvQuoting({
      splitCases: [{ input: "a b", expected: ["a", "b"], got: ["a", "b"] }],
      argvCases: [{ args: ["a b"], got: ["a b"], ok: true }],
      shellCases: [{ command: "c", got: ["a b"], ok: true }],
    }).level,
    "PASS",
  );

  // 突变构造：形状不匹配必须返回 null（拒绝静默做一次无效对照）
  assert.equal(buildToolCapabilityMutant("function x() {}\n", "no-intersection"), null);
  assert.equal(buildToolCapabilityMutant("", "bash-only"), null);
  const m1 = buildToolCapabilityMutant('if (probeAvailable(cap, name) === false)\n    continue;\n', "no-intersection");
  assert.ok(m1 && m1.text.includes("if (false)"), "求交突变必须真的改掉判定点");
  const m2 = buildToolCapabilityMutant('export const SHELL_TOOL_CANDIDATES = ["bash", "pwsh"];\n', "bash-only");
  assert.ok(m2 && m2.text.includes('["bash"]') && !m2.text.includes('"pwsh"'), "候选表突变必须真的去掉 pwsh");
});

// ---------------------------------------------------------------------------
// ④ H6 真实 argv 传递（离线可跑，不依赖 dist / DSH 安装）
// ---------------------------------------------------------------------------

test("g475 ④ H6 运行器：真实 argv 逐字节传递（shell:false + 组合命令行）实拍为 PASS", async () => {
  const scratch = mkdtempSync(join(repoRoot, "tmp", "g475-h6-"));
  try {
    const verdict = await HARNESS_PROBE_RUNNERS.H6({ repo: repoRoot, scratch, platform: process.platform }, {} as never);
    assert.equal(verdict.level, "PASS", `H6 必须 PASS，实际：${verdict.level} :: ${JSON.stringify(verdict.problems)}`);
    assert.match(verdict.detail, /argv 用例/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
