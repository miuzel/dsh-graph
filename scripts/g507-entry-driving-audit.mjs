#!/usr/bin/env node
/**
 * g-507 证据脚本 ④：**入口驱动审计**（变异反向证明「旧业务套件确实经唯一入口驱动」）。
 *
 * 做法：在仓库 `tmp/` 私有副本里把插件唯一入口改成「一律 401」（仅该副本），然后**逐文件**跑
 * `core/tests/*.test.ts`：
 *   · 变红 ⇒ 该套件的断言**真的驱动了 HTTP 入口**（这就是它被判红的原因）；
 *   · 仍全绿 ⇒ 该套件根本不驱动入口（客户端渲染 / 闸门 / 语言包类），不属「业务套件」。
 * 产出 `core/tests/fixtures/g507-entry-driving-audit.json`，由结构守卫 S5 逐条核验。
 *
 * 用法（在仓库根）：
 *   node scripts/g507-entry-driving-audit.mjs            # 跑审计并写 fixture
 *   node scripts/g507-entry-driving-audit.mjs --check    # 只比对现有 fixture 是否仍准确
 *
 * 约束：不写共享 `node_modules`（私有副本用软链只读引用）、不跑 pnpm、不碰主树 dist、
 * 不触碰 3080 实例；临时副本与 npm cache 都在 `tmp/` 下，跑完自动清理。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const PRIVATE = join(ROOT, "tmp", `g507-entry-audit-${process.pid}`);
const FIXTURE = join(ROOT, "core", "tests", "fixtures", "g507-entry-driving-audit.json");
const MUTATION = "entry returns 401 for every request";
const MUTATION_ENV = "G507_AUDIT_ENTRY_401";

/** 变异：在 dispatchRequest 入口第一行无条件回 401（只影响私有副本）。 */
function injectMutation(file) {
  const src = readFileSync(file, "utf8");
  const marker = "  const dispatchRequest = (req, res) => {";
  if (!src.includes(marker)) throw new Error(`入口标记未找到：${marker}`);
  const patched = src.replace(
    marker,
    `${marker}\n    if (process.env.${MUTATION_ENV} === "1") { res.writeHead(401, { "content-type": "application/json" }); res.end("{}"); return; }`,
  );
  writeFileSync(file, patched, "utf8");
}

/** 建立私有副本（源码 + 构建产物 + 软链 node_modules），并注入变异。 */
function preparePrivateCopy() {
  rmSync(PRIVATE, { recursive: true, force: true });
  mkdirSync(PRIVATE, { recursive: true });
  for (const entry of ["core", "dist", "dsh-graph-host", "scripts", "prompts", "tsconfig.json", "package.json", "README.md"]) {
    const from = join(ROOT, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(PRIVATE, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, "node_modules"), join(PRIVATE, "node_modules"), "dir");
  injectMutation(join(PRIVATE, "dist", "index.js"));
}

/** 逐文件跑一次嵌套 runner，返回是否全绿以及失败是否来自**真实断言**。 */
function suitePasses(file) {
  const run = spawnSync(process.execPath, ["--test", file], {
    cwd: PRIVATE,
    env: { ...process.env, [MUTATION_ENV]: "1", NODE_TEST_CONTEXT: undefined, NODE_TEST_WORKER_ID: undefined },
    encoding: "utf8",
    timeout: 300_000,
  });
  const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  // 汇总行解析：优先机器可读汇总（test:summary），退回人类可读 `ℹ fail N`
  const failLine = /ℹ fail (\d+)/.exec(out) ?? /"fail":\s*(\d+)/.exec(out);
  const fail = failLine ? Number(failLine[1]) : null;
  if (process.env.G507_AUDIT_DEBUG === "1") {
    const tail = out.split("\n").filter((l) => l.includes("✖") || l.includes("Error") || l.includes("assert")).slice(0, 6).join(" | ");
    console.error(`[audit-debug] ${file} status=${run.status} fail=${fail} :: ${tail.slice(0, 600)}`);
  }
  // 全绿 = 退出码 0 且 fail 计数为 0（fail 计数缺失视为「没真跑」，按未通过处理）
  const passed = run.status === 0 && fail === 0;
  // 「因真实断言而红」才说明该套件驱动了入口：文件级包装失败（加载失败/进程异常退出）不算。
  // 判据：输出里出现了用例级 ✖ 行（`✖ <用例名>`），而不是只有文件级 `✖ <文件路径>`。
  const caseFailures = [...out.matchAll(/^\s*✖ (.+?)\s*(\(\d|$)/gm)]
    .map((m) => m[1].trim())
    .filter((name) => !name.endsWith(".test.ts"));
  // 归因：失败必须**与鉴权有关**才算「驱动了入口」。否则「入口变 401」只会间接触发其它差异
  //（副本里缺失的 .gitignore、构建时序等）⇒ 那些套件并不驱动 HTTP 入口，不能计入。
  const AUTH_RELATED = /401|403|认证|鉴权|准入|admit|owner|not-owner|受保护入口|唯一入口|拒绝|unauthenticated|forbidden/i;
  const failingBlocks = out
    .split(/\n(?=\s*✖ )/)
    .filter((b) => /^\s*✖ /.test(b))
    .filter((b) => !/^\s*✖ failing tests:/.test(b))
    .filter((b) => AUTH_RELATED.test(b));
  const assertedFailure = !passed && fail !== null && fail > 0 && caseFailures.length > 0 && failingBlocks.length > 0;
  return { passed, fail, code: run.status, assertedFailure };
}

function run() {
  if (!existsSync(join(ROOT, "dist", "index.js"))) throw new Error("缺少 dist/：请先 bash scripts/build.sh");
  preparePrivateCopy();
  const files = readdirSync(join(PRIVATE, "core", "tests")).filter((f) => f.endsWith(".test.ts")).sort();
  const driving = [];
  const nonDriving = [];
  const unknown = [];
  const loadFailures = [];
  for (const f of files) {
    const r = suitePasses(join("core", "tests", f));
    if (r.passed) nonDriving.push(f);
    else if (r.assertedFailure) driving.push(f);
    else if (r.fail !== null) loadFailures.push(f); // 有失败但不是用例级断言 ⇒ 加载/包装失败，不据此判定
    else unknown.push(`${f}: exit=${r.code}`);
  }
  if (loadFailures.length > 0) {
    console.warn(`[audit] 跳过 ${loadFailures.length} 个「非断言失败」套件（加载/包装失败，不能据此判定是否驱动入口）：${loadFailures.join(", ")}`);
  }
  if (unknown.length > 0) throw new Error(`以下套件无法判定（未产出汇总）：${unknown.join("; ")}`);
  const payload = {
    generatedBy: "scripts/g507-entry-driving-audit.mjs",
    mutation: MUTATION,
    mutationEnv: `${MUTATION_ENV}=1`,
    totals: { suites: files.length, driving: driving.length, nonDriving: nonDriving.length, skippedLoadFailures: loadFailures.length },
    skippedLoadFailures: loadFailures,
    driving,
    nonDriving,
  };
  mkdirSync(join(ROOT, "core", "tests", "fixtures"), { recursive: true });
  writeFileSync(FIXTURE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`[audit] suites=${files.length} driving=${driving.length} nonDriving=${nonDriving.length}`);
  console.log(`[audit] fixture: ${relative(ROOT, FIXTURE)}`);
  rmSync(PRIVATE, { recursive: true, force: true });
}

function check() {
  if (!existsSync(FIXTURE)) throw new Error(`缺少审计 fixture：${relative(ROOT, FIXTURE)}（先跑一次审计）`);
  const audit = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const files = readdirSync(join(ROOT, "core", "tests")).filter((f) => f.endsWith(".test.ts")).sort();
  const covered = new Set([...audit.driving, ...audit.nonDriving]);
  const uncovered = files.filter((f) => !covered.has(f));
  const phantom = [...covered].filter((f) => !files.includes(f));
  if (uncovered.length || phantom.length) {
    throw new Error(`审计清单已漂移：未覆盖=[${uncovered.join(", ")}] 不存在=[${phantom.join(", ")}]（请在仓库根重跑本脚本）`);
  }
  console.log(`[audit] 清单与当前套件一致（${files.length} 个套件：driving=${audit.driving.length} nonDriving=${audit.nonDriving.length}）`);
}

if (process.argv.includes("--check")) check();
else run();

// 私有副本清理兜底：只删本脚本自己创建的目录（绝对路径已核验）
if (existsSync(PRIVATE) && PRIVATE.startsWith(join(ROOT, "tmp", "g507-entry-audit-"))) {
  rmSync(PRIVATE, { recursive: true, force: true });
}
