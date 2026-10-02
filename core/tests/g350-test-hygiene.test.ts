/**
 * core/tests/g350-test-hygiene.test.ts
 *
 * g-350（v0.19.7 lane）测试卫生补缺 —— 本文件只放**本目标新增**的三类覆盖：
 *
 *  ① `session-hooks.js` 的 `boundModes` 写入路径（g-351 att-002 复核 R1）：
 *     把 `boundModes.set(childId, catalogEntryMode(entry))` 变异成 `catalogAddressMode(entry)`
 *     时**全套 1302/0 存活**（执行者变异脚本对 boundModes 零覆盖）。后果：0.1.7 的
 *     `mode:'unknown'` 会在 `live-panel.js:502` 被渲染成「一次性」。这里补「unknown 模式下
 *     展示层不产出具体模式」的断言，并在**真实源模块**（vm 沙箱）上跑，外加 live-panel 渲染门
 *     的结构性钉住。
 *
 *  ② `cleanTestEnv(extra?)` 的 `extra` 合并时机（g-412 att-001 复核发现的注释瑕疵）：
 *     实现是「先合并 `extra`、再摘除注入变量」（故无法用它构造「带 NODE_TEST_CONTEXT」的 env），
 *     文档注释此前写成相反。注释已在 fixtures/nested-runner.ts 订正；此处把**语义**钉住。
 *
 *  ③ 顶层注入自证（g-407 R1）：`NODE_TEST_CONTEXT=… node --test core/tests/*.test.ts` 会静默
 *     skip 整套并 exit 0、仓内无自检位置。`scripts/run-tests.mjs` 是跨平台统一入口，本文件
 *     用**注入形态 + 变异副本**两条负向对照钉住它「真的跑了 tests>0 且 skipped==0」。
 *
 * 边界：不改产品逻辑；不新增依赖；原生 Windows 分支由注入桩覆盖（原生未验证，如实标注）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { cleanTestEnv, parseTestSummary } from "./fixtures/nested-runner.ts";
import { flushAsync, makeHookHarness, makeSessionHooksSandbox, makeSessions016, readClient } from "./_g387-harness.ts";

const repoRoot = join(import.meta.dirname, "../..");
const silentConsole = { warn: () => {}, error: () => {}, log: () => {} };
const PARENT = "parent-1";
const CHILD = "child-1";

/** 0.1.7 投影形状（无 kind）的目录，entry 由调用方给定。 */
function catalogWith(entry: Record<string, unknown>) {
  const rt = makeSessions016({ parentId: PARENT });
  rt.list.set((s: any) => ({
    ...s,
    seq: s.seq + 1,
    projectionsBySession: { ...s.projectionsBySession, [PARENT]: { values: { subagentCatalog: [entry] } } },
  }));
  return rt;
}

/**
 * 在真实 session-hooks 源模块沙箱上、经**真实消费路径** `useBoundSession` 取「展示层拿到的 mode」。
 * `useBoundSession` 正是 live-panel 的数据源（`props.mode`），其 mode 来自 `boundModes`。
 */
async function boundModeFor(entry: Record<string, unknown>) {
  const rt = catalogWith(entry);
  const addresses: any[] = [];
  const session = rt.sessionFor(CHILD);
  session.configureSubagent = (a: any) => addresses.push(a);

  const box = makeSessionHooksSandbox(rt.rt, { console: silentConsole });
  const harness = makeHookHarness((R) => {
    box.React = R;
    return box.parts.useBoundSession(PARENT, CHILD);
  });
  harness.render();
  await flushAsync();
  await flushAsync();
  await flushAsync();
  const result = {
    bound: box.parts.boundModes.get(CHILD),
    displayed: harness.value()?.mode,
    hasSession: Boolean(harness.value()?.session),
    addresses,
  };
  harness.unmount();
  await flushAsync();
  return result;
}

// ============================================================================
// ① boundModes：unknown 模式不得落具体模式
// ============================================================================

test("g-350/g-351 R1：unknown/缺失/非法模式 ⇒ boundModes 记 null，展示层拿到的 mode 必须为 null", async (t) => {
  const cases: Array<{ name: string; entry: Record<string, unknown> }> = [
    { name: "0.1.7 mode:'unknown'（宿主未判定）", entry: { id: CHILD, createdAt: 1, mode: "unknown" } },
    { name: "mode 字段缺失", entry: { id: CHILD, createdAt: 1 } },
    { name: "mode 为非法值", entry: { id: CHILD, createdAt: 1, mode: "bogus" } },
  ];
  for (const { name, entry } of cases) {
    const got = await boundModeFor(entry);
    assert.equal(got.hasSession, true, `${name}：夹具前置——真实消费路径必须已接入会话（否则断言空转）`);
    // 变异对照：把 `boundModes.set(childId, catalogEntryMode(entry))` 写成 `catalogAddressMode(entry)`
    // 时这里会得到 "unknown"（真值）；live-panel 的 `mode ? … : "一次性"` 分支随之产出**具体**模式 ⇒ 必红。
    assert.equal(
      got.bound,
      null,
      `${name}：boundModes 必须记 null（展示层据此整段省略模式），实际 ${JSON.stringify(got.bound)}`,
    );
    assert.equal(
      got.displayed,
      null,
      `${name}：展示层（useBoundSession → live-panel 的 props.mode）必须收到 null（不得被渲染成「一次性」），实际 ${JSON.stringify(got.displayed)}`,
    );
    assert.equal(got.addresses.length, 1, `${name}：必须恰好下发一次子代理地址配置`);
    assert.equal(
      got.addresses[0].mode,
      "unknown",
      `${name}：路由层必须下发宿主自己的 'unknown' 通配值（不得臆断具体模式）`,
    );
  }
  t.diagnostic("evidence: suite=g350-bound-modes unknown_null=1 missing_null=1 illegal_null=1 displayed_null=3 address_mode=unknown");
});

test("g-350/g-351 R1：具体模式仍须照常回填到展示层（否则「一律 null」也能绿 —— 假守卫）", async () => {
  for (const mode of ["continuable", "one-shot"] as const) {
    const got = await boundModeFor({ id: CHILD, createdAt: 1, mode });
    assert.equal(got.bound, mode, `具体模式 ${mode} 必须原样回填到 boundModes`);
    assert.equal(got.displayed, mode, `具体模式 ${mode} 必须原样到达展示层（props.mode）`);
  }
});

test("g-350/g-351 R1：展示层只在 mode 非空时渲染具体模式（结构性钉住 live-panel 真实表达式）", () => {
  const panel = readClient("live-panel");
  // live-panel 唯一的会话模式渲染点：整段以 `mode ?` 为门，非空时只有 continuable/oneShot 两种具体措辞。
  assert.match(
    panel,
    /\(mode \? `[^`]*\$\{dgT\("live\.sessionMode"\)\}[^`]*\$\{mode === "continuable" \? dgT\("live\.continuable"\) : dgT\("live\.oneShot"\)\}` : ""\)/,
    "live-panel 的会话模式片段必须以 `mode ? … : \"\"` 为门（去掉该门即把「未判定」渲染成具体模式）",
  );
  assert.match(panel, /dgT\("live\.oneShot"\)/, "具体模式分支必须保留 oneShot 措辞（正向对照）");
});

// ============================================================================
// ② cleanTestEnv：extra 在摘除之前合并
// ============================================================================

test("g-350：cleanTestEnv 的 extra 在摘除之前合并 ⇒ 无法构造「带注入变量」的 env（注释与实现一致）", () => {
  const env = cleanTestEnv({ NODE_TEST_CONTEXT: "child-v8", NODE_TEST_WORKER_ID: "7", G350_KEEP: "1" });
  assert.equal(env.NODE_TEST_CONTEXT, undefined, "extra 里的 NODE_TEST_CONTEXT 必须同样被摘除（合并先于摘除）");
  assert.equal(env.NODE_TEST_WORKER_ID, undefined, "extra 里的 NODE_TEST_WORKER_ID 必须同样被摘除");
  assert.equal(env.G350_KEEP, "1", "非注入变量必须原样保留（否则 extra 语义被改坏）");
});

// ============================================================================
// ③ 顶层注入自证：scripts/run-tests.mjs
// ============================================================================

const GATE_SCRIPT = join(repoRoot, "scripts", "run-tests.mjs");
const FIXTURE_PASS = join("core", "tests", "fixtures", "g407", "always-pass.test.ts");
const FIXTURE_FAIL = join("core", "tests", "fixtures", "g407", "always-fail.test.ts");

function runGate(script: string, args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
    env,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("g-350 顶层注入自证：闸门在 NODE_TEST_CONTEXT 注入形态下仍真跑用例并自证 tests>0 & skipped==0", (t) => {
  // (a) 顶层注入形态（g-407 R1）：直接 `node --test …` 会静默 skip 全部文件、exit 0、零汇总；
  //     闸门必须先摘除注入变量，再自证「确实跑了」。
  const injected = runGate(GATE_SCRIPT, [FIXTURE_PASS], { ...process.env, NODE_TEST_CONTEXT: "child-v8" });
  assert.equal(injected.code, 0, `闸门在注入形态下必须仍然真跑并判绿：\n${injected.err.slice(-800)}`);
  const s = parseTestSummary(injected.out, injected.err);
  assert.ok(s.tests > 0, `闸门必须自证 tests>0（实际 ${s.tests}）——「真的跑了」必须可判定`);
  assert.equal(s.skipped, 0, `闸门必须自证 skipped==0（实际 ${s.skipped}）`);
  assert.equal(s.runnerSkippedFiles, false, "闸门输出不得再出现 skipping running files");
  // (b) 判别力：真实失败必须如实红（闸门不是恒绿）
  const failing = runGate(GATE_SCRIPT, [FIXTURE_FAIL], { ...process.env });
  assert.notEqual(failing.code, 0, "闸门遇到真实失败用例必须非零退出");
  assert.match(failing.err, /自证失败|不得有失败用例/, `失败形态必须给出自证失败诊断：\n${failing.err.slice(-400)}`);
  t.diagnostic(`evidence: suite=g350-gate injected_exit=${injected.code} injected_tests=${s.tests} failing_exit=${failing.code}`);
});

test("g-350 顶层注入自证（负向对照）：去掉「摘除注入变量」的变异副本必须判红", (t) => {
  const original = readFileSync(GATE_SCRIPT, "utf8");
  const mutantSrc = original.replace("env: cleanTestEnv(),", "env: { ...process.env },");
  assert.notEqual(mutantSrc, original, "变异锚点失效：闸门里必须存在 `env: cleanTestEnv(),` 这一行");
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g350-gate-"));
  try {
    const mutant = join(dir, "run-tests-mutant.mjs");
    // 变异副本落在仓库外 ⇒ 用绝对路径重写 repoRoot（不改任何其它语义）。
    const fixed = mutantSrc.replace(
      /const repoRoot = join\(dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\."\);/,
      `const repoRoot = ${JSON.stringify(repoRoot)};`,
    );
    assert.notEqual(fixed, mutantSrc, "变异副本的 repoRoot 重写锚点失效");
    writeFileSync(mutant, fixed);

    const m = runGate(mutant, [FIXTURE_PASS], { ...process.env, NODE_TEST_CONTEXT: "child-v8" });
    assert.notEqual(m.code, 0, "回退「摘除注入变量」后，注入形态必须被自证闸门判红（否则自证是永真）");
    assert.match(
      m.err,
      /skipping running files|跳过了全部用例|没有输出任何汇总行|零用例|自证失败/,
      `负向对照必须红在「用例根本没跑」：\n${m.err.slice(-600)}`,
    );
    t.diagnostic(`evidence: suite=g350-gate-mutant mutant_exit=${m.code} red_reason=no-summary-or-skip`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-350 顶层注入自证：闸门与文档共享同一 glob 字面量（入口不分叉）且复用唯一 helper", () => {
  const src = readFileSync(GATE_SCRIPT, "utf8");
  const glob = /const TEST_GLOB = "([^"]+)"/.exec(src)?.[1];
  assert.equal(glob, "core/tests/*.test.ts", "闸门缺省的测试 glob 必须与文档命令逐字相同");
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  assert.ok(agents.includes("node --test core/tests/*.test.ts"), "AGENTS.md 必须保留原有全量命令（不得被替换成分叉入口）");
  assert.ok(agents.includes("scripts/run-tests.mjs"), "AGENTS.md 必须登记自证闸门入口");
  // 唯一实现：闸门不得自行摘除注入变量（必须经 fixtures/nested-runner.ts 的 cleanTestEnv）
  assert.ok(
    src.includes("core/tests/fixtures/nested-runner.ts"),
    "闸门必须导入唯一 helper（core/tests/fixtures/nested-runner.ts）",
  );
  assert.match(src, /\bcleanTestEnv\s*\(\s*\)/, "闸门必须以 cleanTestEnv() 构造子进程 env");
  assert.match(src, /\bassertNestedSuiteRan\s*\(/, "闸门必须以 assertNestedSuiteRan() 自证「真的跑了」");
  assert.ok(!/delete\s+[\w.$]*NODE_TEST_CONTEXT/.test(src), "闸门不得自行 `delete …NODE_TEST_CONTEXT`（唯一实现已收归 helper）");
});
