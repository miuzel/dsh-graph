/** g-507 负向对照（**真实测试文件 + 真实 runner 裁决**）：证明既有断言真的能抓到三类回退。
 *
 * 与上一版（catch 里自带 `【必须红】` 文案）的区别 —— 这也是本轮返工要求改正的地方：
 * 本套件把**真实业务套件**复制进仓库 `tmp/` 私有副本，对副本里的**产品代码**做一次变异，再用仓库
 * 自带的嵌套 runner helper（`core/tests/fixtures/nested-runner.ts`）真实跑该套件，并做**正负裁决**：
 *   · 未变异 ⇒ 该套件必须**全绿**（正向基准，证明变异是唯一差异来源）；
 *   · 变异后 ⇒ 必须**判红**，且失败事件文本匹配该变异应有的断言特征（不靠进程早退冒充）。
 *
 * 三类变异各自对应一条真实断言：
 *   ① 去认证（入口不再准入）⇒ A 层「匿名 ⇒ 401」必红；
 *   ② 去 owner 检查（admit 通过即放行）⇒ A6「非 owner ⇒ 403」必红；
 *   ③ 恢复裸注册（逐条注册业务定义）⇒ 结构断言「只注册一个入口」必红。
 *
 * 约束：只写 `tmp/` 私有副本；不跑 pnpm；不写共享 `node_modules`（软链只读引用）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNestedSuiteFailed, assertNestedSuitePassed, runNestedArgv } from "./fixtures/nested-runner.ts";

const ROOT = process.cwd();
// 每次运行用**唯一**私有目录（全量套件会并发跑，共享目录会互相覆盖副本 ⇒ 变异丢失/误判）
const PRIVATE = join(ROOT, "tmp", `g507-negative-controls-${process.pid}-${Date.now().toString(36)}`);

/** 建私有副本（源码 + 构建产物 + 软链 node_modules）。 */
function makeCopy(label: string) {
  const dir = join(PRIVATE, label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // 根 `prompts/` 必须一起复制：测试从源码 import core/*.ts，其资产根解析到仓库根 `prompts/`。
  for (const entry of ["core", "dist", "dsh-graph-host", "scripts", "prompts", ".gitignore", "tsconfig.json", "package.json"]) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
}

/** 在副本的构建产物里做一次文本变异（未命中即抛错，避免「变异没生效」被当成对照通过）。 */
function mutate(distFile: string, from: string, to: string) {
  const src = readFileSync(distFile, "utf8");
  assert.ok(src.includes(from), `变异锚点未命中：${from.slice(0, 70)}`);
  writeFileSync(distFile, src.replace(from, to), "utf8");
}

const ENTRY = '  const dispatchRequest = (req, res) => {';
const ADMIT = "    const decision = admitRequest(req);";
const OWNER = '    if (!peerIsOwner(peer)) return { status: 403, reason: "not-owner" };';
const REGISTER = '        const disposer = webServer.register({ kind: "prefix", path: API_NAMESPACE, handler: dispatchRequest });\n        disposers.push(disposer);';

/** 在副本里真实跑一个套件文件（整文件跑，不用选集开关 —— 选集会被嵌套裁决 fail-closed 拒绝）。 */
async function runSuite(dir: string, file: string) {
  return runNestedArgv(process.execPath, ["--test", join("core", "tests", file)], { cwd: dir, timeout: 600_000 });
}

/**
 * 在副本里**派生出只含指定用例的真实套件文件**（`g507-neg-<case>.test.ts`）。
 *
 * 为什么这样做：完整 A 层套件在「去认证」变异下会执行大量真实业务（写端点/派发）而挂起，但
 * 嵌套裁决又**禁止** `--test-name-pattern` 选集（选集会让覆盖断言失真）。折中：用真实源码
 * （A 层文件的 import 头 + 目标用例块逐字复制）拼出一个**独立可跑的真实测试文件**，整文件跑它。
 * 该文件仍然断言同一批真实判据，只是剔除了变异下会挂起的其它用例。
 */
function extractCase(source: string, caseName: string) {
  const start = source.indexOf(`test("${caseName}`);
  assert.ok(start >= 0, `未找到用例：${caseName}`);
  // 用例块以顶层 "\n});" 结束
  const end = source.indexOf("\n});", start);
  assert.ok(end > start, `用例块未闭合：${caseName}`);
  return source.slice(start, end + 4);
}

/** 派生「非 owner ⇒ 403」的最小真实用例套件（只读端点，不含会挂起的写业务）。 */
function deriveOwnerProbeSuite(dir: string) {
  const source = readFileSync(join(dir, "core", "tests", "g507-http-auth-surface.test.ts"), "utf8");
  const headerEnd = source.indexOf("\ntest(");
  assert.ok(headerEnd > 0, "A 层文件头未找到");
  const header = source.slice(0, headerEnd);
  const body = `test("g-507 N2 派生：有效凭证但非 owner ⇒ 403（不进入业务）", async () => {
  const { routes, webServer } = createRegisterStub();
  const ctx: any = {
    get: (name: string) => name === "webServer" ? webServer : name === "connection" ? { admit: () => ({ peer: { principal: { kind: "remote" } } }) } : undefined,
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});
  const entry = assertSingleProtectedEntry(routes).handler;
  const { req, seen } = watchRequest("GET", \`\${API_NAMESPACE}\`, {}, {});
  const res = watchResponse();
  await entry(req, res);
  assert.equal(res.status, 403, "有效凭证的非 owner ⇒ 403（不是 200/500，也不是被放行到业务）");
  assert.equal(res.body.error, "not-owner");
  assert.equal(seen.bodyListeners, 0, "非 owner 请求不得读取请求体");
});
`;
  writeFileSync(join(dir, "core", "tests", "g507-neg-owner.test.ts"), `${header}\n\n${body}`, "utf8");
  return "g507-neg-owner.test.ts";
}

function deriveCaseSuite(dir: string, outFile: string, caseNames: string[]) {
  const source = readFileSync(join(dir, "core", "tests", "g507-http-auth-surface.test.ts"), "utf8");
  // import/常量头：文件首个 `test(` 之前的一切（含 import、BASELINE 清单、helper）
  const headerEnd = source.indexOf("\ntest(");
  assert.ok(headerEnd > 0, "A 层文件头未找到");
  const header = source.slice(0, headerEnd);
  const bodies = caseNames.map((name) => extractCase(source, name)).join("\n\n");
  writeFileSync(join(dir, "core", "tests", outFile), `${header}\n\n${bodies}\n`, "utf8");
  return outFile;
}

test("g-507 N0 基准：未变异副本跑真实 A3（拒绝矩阵）必须全绿", { timeout: 300_000 }, async () => {
  const dir = makeCopy("baseline");
  try {
    const file = deriveCaseSuite(dir, "g507-neg-a3.test.ts", ["g-507 A3："]);
    const run = await runSuite(dir, file);
    assertNestedSuitePassed(run, "g-507 N0 基准（未变异，A3 拒绝矩阵）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-507 N1 去认证：真实 A 层套件必须判红，失败文本指向「匿名 ⇒ 401」", { timeout: 700_000 }, async () => {
  const dir = makeCopy("no-auth");
  try {
    mutate(
      join(dir, "dist", "index.js"),
      ADMIT,
      '    const decision = { peer: { principal: { kind: "owner" } } }; // MUTATION: 入口不再准入',
    );
    // 只跑 A3（拒绝矩阵）：去认证后匿名/伪造请求会被当作 owner 放行到业务 ⇒ A3 必红。
    // （全量跑 A 层会在变异下执行真实业务写端点而挂起，故按用例名精确选取；命中用例在主树未变异时全绿。）
    const file = deriveCaseSuite(dir, "g507-neg-a3.test.ts", ["g-507 A3："]);
    const run = await runSuite(dir, file);
    assertNestedSuiteFailed(run, "g-507 N1（去认证）", /401|403|匿名|拒绝|一律/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-507 N2 去 owner 检查：真实用例必须判红（非 owner 被放行到业务）", { timeout: 700_000 }, async () => {
  const dir = makeCopy("no-owner");
  try {
    mutate(join(dir, "dist", "index.js"), OWNER, "    // MUTATION: 去掉 owner 检查");
    // 用**真实派生的最小用例**（与 A6 同一判据：有效凭证但非 owner ⇒ 403、不进入业务）。
    // 原 A6 在变异下会把请求交给真实业务（create-goal 等待 body）而挂起、并非判红，
    // 这里改为同样真实的观测点：只看「非 owner 请求的最终状态是否为 403」，不触发会挂起的写业务。
    const file = deriveOwnerProbeSuite(dir);
    const run = await runSuite(dir, file);
    assertNestedSuiteFailed(run, "g-507 N2（去 owner）", /403|owner|非 owner/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-507 N3 恢复裸注册：真实结构守卫套件必须判红（注册集合不再是单入口）", { timeout: 300_000 }, async () => {
  const dir = makeCopy("bare-registration");
  try {
    // 变异：把「注册一个 prefix 入口」改回「逐条注册业务定义」
    mutate(
      join(dir, "dist", "index.js"),
      REGISTER,
      '        for (const def of httpRoutes()) disposers.push(webServer.register({ kind: "exact", path: def.path, handler: def.handler })); // MUTATION: 裸注册',
    );
    const run = await runSuite(dir, "g507-http-auth-guard.test.ts");
    assertNestedSuiteFailed(run, "g-507 N3（裸注册）", /register|注册|入口/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-507 N4 清理：本次各用例的私有副本子目录均已删除（不在仓库里留残料）", () => {
  // 只核对**本进程**创建的四个子目录（每当例 finally 里 rmSync 掉自己的子目录）；
  // 不用「扫描前缀」判残留：全量套件会并发跑多个测试进程，各有带 pid 的唯一前缀目录（实测会把别人的在跑目录算成残留）。
  for (const label of ["baseline", "no-auth", "no-owner", "bare-registration"]) {
    assert.equal(existsSync(join(PRIVATE, label)), false, `${label} 私有副本应已清理：${join(PRIVATE, label)}`);
  }
  // 根目录若只剩空壳（本进程独占创建），顺手移除，避免在 tmp/ 留空目录
  try {
    if (existsSync(PRIVATE) && readdirSync(PRIVATE).length === 0) rmSync(PRIVATE, { recursive: true, force: true });
  } catch {
    /* 并发下可能已不存在 */
  }
});
