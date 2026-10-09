/**
 * core/tests/g464-launcher-bundle-entry-readiness.test.ts
 *
 * g-464 守卫：`scripts/dsh-test-web.sh` 的**插件就绪判据**不得再是「全文件子串匹配」，
 * 且「插件在启动期被静默跳过」必须**必然响铃**（非零退出），而不是被判成启动成功。
 *
 * 真机缺陷（g-463 独立验证中实际踩到，g-464 已复现）：
 *   旧判据 `grep -q "dsh-graph" "$EFFECTIVE_CONFIG"` 扫的是 composed tree 全文，而该文件里有
 *   **注释**形式的补丁来源标注：
 *     `# == @deepseek-ai/dsh-web-app, patched by /…/dsh-graph/tmp/dsh-test/0.2.1/home/profiles/web/cordis.patch.yml`
 *   注释里的**仓库绝对路径含 `dsh-graph`** ⇒ 即使插件的 profile bundle 在启动期被静默跳过
 *   （宿主 stderr：`dsh: skipping profile bundle "dsh-graph": … peerDependencies {…}`），grep 仍命中
 *   ⇒ launcher 判为就绪；实例照常起来但**插件完全缺席**，后续任何基于该实例的验证都失真。
 *
 * 断言面（对应 g-464 质量判据）：
 *  1. 结构化判据的**判别力**（`scripts/effective-config-bundle-entry.mjs`）：按 YAML 条目的
 *     `name`（bundle 包名）精确匹配真实条目；整行注释、注释里的路径、任意子串、以及「只按 id 覆盖
 *     config 的用户层 patch（无 name）」都不构成条目。含「注释命中但条目缺席」必红用例。
 *  2. **launcher 端到端**（夹具 stub dsh + 合成隔离根，零网络、零长驻进程）：
 *     健康 composed tree ⇒ 走到 boot（exit 0）；注释-only ⇒ exit 2 且**从未 boot**；
 *     启动期 skipping 行 ⇒ exit 2、点名日志与原始原因、且从未 boot。
 *  3. **自动化负向对照**：在同一类沙箱里把**派发基线脚本**（`1bba546:scripts/dsh-test-web.sh`，
 *     即被取代的实现）跑一遍 —— 它在「注释-only」与「skipping 行」两种场景下**都判为就绪并 boot**
 *     ⇒ 判据一旦被回退，本套件必红（不是人工核验）。
 *  4. `--dry-run` 零副作用与退出码语义不变；`--skip-install` 的既有要求不变。
 *
 * 平台范围：linux/WSL2（bash + GNU coreutils），与脚本自身登记的适用范围一致；原生 Windows
 * 不在本套件覆盖内（用例 skip 并如实登记）。真实 registry 安装与长驻服务不在本套件内
 * （见交付报文中的两次真实实例启动证据与真实构造的跳过对照）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { commentHits, findBundleEntry, parseEntryItems } from "../../scripts/effective-config-bundle-entry.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(REPO_ROOT, "scripts", "dsh-test-web.sh");
const CHECKER = join(REPO_ROOT, "scripts", "effective-config-bundle-entry.mjs");
/** 真实 host 目录（就绪判据只读它的 package.json 形状，不加载插件）。 */
const HOST_DIR = join(REPO_ROOT, "dsh-graph-host");
const TMP_ROOT = join(REPO_ROOT, "tmp");
/** 权威基线（本次 attempt 数据 1bba546）：负向对照从这里取**被取代的实现**。 */
const BASELINE_COMMIT = "1bba546";
const BUNDLE_NAME = "dsh-graph";
const PLUGIN_ID = "dsh-graph-host";
const FULL_VERSION = "0.2.1-alpha.2";
/** 预发布版本的 DSH_HOME 落在 stable 基座（脚本的 STABLE_VERSION 规则）。 */
const STABLE_VERSION = "0.2.1";
const DUMP_LOG_REL = join(FULL_VERSION, "dump-config.log");
const IS_WIN = process.platform === "win32";
const SKIP = IS_WIN ? "g-464 launcher 判据覆盖 linux/WSL2（bash + GNU coreutils）；原生 Windows 未验证" : false;
const BASH = existsSync("/usr/bin/bash") ? "/usr/bin/bash" : "bash";

mkdirSync(TMP_ROOT, { recursive: true });

// ────────────────────────────────────────────────────────────────────────────
// 夹具：composed effective-config 的忠实片段（取自真实 `dsh web --dump-config` 输出形态）
// ────────────────────────────────────────────────────────────────────────────

/** 真实的补丁来源标注：注释里的**仓库路径含 `dsh-graph`**，正是旧判据的假阳性来源。 */
const PROVENANCE =
  "# == @deepseek-ai/dsh-web-app, patched by /home/someone/workspace/personal/dsh-graph/tmp/dsh-test/0.2.1/home/profiles/web/cordis.patch.yml";

/** 健康 composed tree：注释命中 + **真实 bundle 条目**（`- id: dsh-graph-host / name: dsh-graph`）。 */
const CONFIG_HEALTHY = [
  "# == @deepseek-ai/dsh-base",
  "- id: session",
  "  name: '@deepseek-ai/dsh-session'",
  "# == @deepseek-ai/dsh-web-app",
  "- id: web-app",
  "  name: '@deepseek-ai/dsh-web-app'",
  "  config:",
  "    name: not-a-bundle-entry",
  PROVENANCE,
  "- id: ui-settings-general",
  "  name: '@deepseek-ai/dsh-client-ui-settings-general'",
  "# == dsh-graph",
  "- id: dsh-graph-host",
  "  name: dsh-graph",
  "  config:",
  "    root: .dsh-graph",
  "",
].join("\n");

/** 真机 A′：bundle 被跳过 ⇒ **没有任何真实条目**，全文只剩注释里的 `dsh-graph` 路径。 */
const CONFIG_COMMENT_ONLY = `${CONFIG_HEALTHY.split("\n").slice(0, CONFIG_HEALTHY.split("\n").indexOf("# == dsh-graph")).join("\n")}\n`;

/** 宿主在启动期跳过 bundle 时打到 stderr 的原始行（dsh-app-boot 的 reportSkippedBundles）。 */
const SKIP_REASON =
  'dsh: skipping profile bundle "dsh-graph": Error: Plugin dsh-graph@0.20.0-alpha is incompatible with dsh 0.2.1-alpha.2: ' +
  'peerDependencies {"@deepseek-ai/dsh-settings":"^0.1.0"}. Running it may cause crashes or data loss.';

// ────────────────────────────────────────────────────────────────────────────
// 夹具：合成隔离根 + stub dsh（零网络；dump 内容与 stderr 由夹具控制）
// ────────────────────────────────────────────────────────────────────────────

type RunResult = { status: number | null; stdout: string; stderr: string };
type RunOpts = { script?: string; env?: Record<string, string> };

/** 在仓库 tmp/ 下开一次性沙箱（用例结束即整目录删除，不碰 tmp/dsh-test 的既有 home）。 */
function mkSandbox(): string {
  return mkdtempSync(join(TMP_ROOT, ".g464-smoke-"));
}

/** stub dsh：`--version` / `web --dump-config` / boot 三种调用各自可辨，绝不联网、绝不长驻。 */
const STUB_DSH = `#!/bin/sh
case "\${1:-}" in
  --version) printf '0.0.0-g464-stub\\n'; exit 0;;
esac
if [ "\${2:-}" = "--dump-config" ]; then
  [ -n "\${G464_FIXTURE:-}" ] && cat "$G464_FIXTURE"
  [ -n "\${G464_SKIP_REASON:-}" ] && printf '%s\\n' "$G464_SKIP_REASON" >&2
  exit 0
fi
printf 'STUB-BOOT %s\\n' "$*"
exit 0
`;

/** 合成 host 包：满足脚本的 link/name/`dsh.bundle.patch` 判定（不真正加载插件）。 */
function writeSyntheticHost(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      { name: BUNDLE_NAME, version: "0.0.0-g464", main: "index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n    - id: dsh-graph-host\n      name: dsh-graph\n");
}

/**
 * 合成隔离根：运行时（stub dsh，按 FULL_VERSION 落盘）+ 已就绪的 web profile（link 指向 hostDir，
 * 与脚本的 `profile_ready` 判定同形）。`needs_install=0` ⇒ 不跑任何 pnpm/安装。
 */
function makeReadyRoot(testRoot: string, hostDir: string): void {
  const vroot = join(testRoot, FULL_VERSION);
  const home = join(testRoot, STABLE_VERSION, "home");
  for (const d of ["workspace", "cache/npm", "cache/xdg", "pnpm-store", "node_modules/.bin"]) {
    mkdirSync(join(vroot, d), { recursive: true });
  }
  mkdirSync(join(home, "profiles/web/node_modules"), { recursive: true });
  const stub = join(vroot, "node_modules/.bin/dsh");
  writeFileSync(stub, STUB_DSH);
  chmodSync(stub, 0o755);
  symlinkSync(hostDir, join(home, "profiles/web/node_modules/dsh-graph"));
  writeFileSync(
    join(home, "profiles/web/package.json"),
    `${JSON.stringify(
      {
        name: "dsh-profile-web",
        private: true,
        dependencies: { [BUNDLE_NAME]: `link:${hostDir}` },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", BUNDLE_NAME] } },
      },
      null,
      2,
    )}\n`,
  );
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
}

/** 跑一次 launcher（默认跑当前实现；`script` 可换成基线实现做负向对照）。 */
function runScript(args: string[], opts: RunOpts = {}): RunResult {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DSH_TEST_MODE: "1",
    ...(opts.env ?? {}),
  };
  const r = spawnSync(BASH, [opts.script ?? SCRIPT, ...args], { cwd: REPO_ROOT, env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 夹具场景：写好 config 夹具文件，返回可传给 launcher 的环境与参数。 */
async function scenario(
  sb: string,
  testRoot: string,
  hostDir: string,
  config: string,
  skipReason?: string,
): Promise<{ env: Record<string, string>; args: string[] }> {
  const configPath = join(sb, "fixture-config.yml");
  writeFileSync(configPath, config);
  const env: Record<string, string> = { DSH_TEST_ROOT: testRoot, G464_FIXTURE: configPath };
  if (skipReason !== undefined) env.G464_SKIP_REASON = skipReason;
  const port = await freePort();
  return { env, args: [FULL_VERSION, "--port", String(port), "--host-dir", hostDir] };
}

/** 当前实现的场景：沙箱内合成隔离根，host-dir 用仓库真实的 dsh-graph-host。 */
async function currentScenario(sb: string, config: string, skipReason?: string) {
  const testRoot = join(sb, "root");
  makeReadyRoot(testRoot, HOST_DIR);
  return scenario(sb, testRoot, HOST_DIR, config, skipReason);
}

// ────────────────────────────────────────────────────────────────────────────
// 1. 结构化判据的判别力
// ────────────────────────────────────────────────────────────────────────────

test("g-464 判据 1：「注释含 dsh-graph 但真实条目缺席」必须判红（旧子串判据在此必绿）", () => {
  const found = findBundleEntry(CONFIG_COMMENT_ONLY, { name: BUNDLE_NAME, id: PLUGIN_ID });
  assert.equal(found, undefined, "注释-only 的 composed tree 不得被认成存在真实条目");
  assert.ok(commentHits(CONFIG_COMMENT_ONLY, BUNDLE_NAME) > 0, "夹具必须确实被注释命中（否则本用例无判别力）");
  // 被取代的旧判据在同一份文本上**为真** —— 这正是「改前判为就绪」的最小复现。
  assert.equal(CONFIG_COMMENT_ONLY.includes(BUNDLE_NAME), true, "旧子串判据必须在此夹具上命中（否则对照不成立）");
});

test("g-464 判据 1：健康 composed tree 命中真实条目（name/id 精确）", () => {
  const found = findBundleEntry(CONFIG_HEALTHY, { name: BUNDLE_NAME, id: PLUGIN_ID });
  assert.ok(found, "健康树必须命中真实 bundle 条目");
  assert.equal(found.name, BUNDLE_NAME);
  assert.equal(found.id, PLUGIN_ID);
  assert.ok(found.line > 0, "命中必须带行号（便于回报）");
});

test("g-464 判据 1：注释、子串、嵌套键、id-only patch 都不构成条目（判别力自检）", () => {
  const cases: Array<[string, string, boolean]> = [
    ["整行注释里的条目", "# - id: dsh-graph-host\n#   name: dsh-graph\n", false],
    ["注释里的路径含包名", "# patched by /w/dsh-graph/tmp/x.yml\n- id: other\n  name: other-plugin\n", false],
    ["只有 id-only 的用户层 patch（无 name）", "- id: dsh-graph-host\n  config:\n    root: .dsh-graph\n", false],
    ["name 是另一个包（不得子串命中）", "- id: x\n  name: dsh-graph-client\n", false],
    ["name 精确但 id 不符", "- id: not-the-plugin\n  name: dsh-graph\n", false],
    ["带引号的 name", "- id: dsh-graph-host\n  name: 'dsh-graph'\n", true],
    ["双引号 name + 行尾注释", '- id: dsh-graph-host\n  name: "dsh-graph" # 说明\n', true],
    ["裸 name + 行尾注释", "- id: dsh-graph-host\n  name: dsh-graph # 说明\n", true],
    ["嵌套 config 里同名键不算条目自身键", "- id: other\n  config:\n    name: dsh-graph\n", false],
    ["CRLF 行尾", "- id: dsh-graph-host\r\n  name: dsh-graph\r\n", true],
  ];
  for (const [label, text, expected] of cases) {
    const found = findBundleEntry(text, { name: BUNDLE_NAME, id: PLUGIN_ID });
    assert.equal(found !== undefined, expected, `${label}：期望 ${expected ? "命中" : "不命中"}`);
  }
});

test("g-464 判据 1：条目自身的键与嵌套子键分开（`config:` 子块不得污染条目键）", () => {
  const items = parseEntryItems(CONFIG_HEALTHY);
  const entry = items.find((item) => item.keys.get("name") === BUNDLE_NAME);
  assert.ok(entry, "必须解析出该条目");
  assert.deepEqual([...entry.keys.keys()].sort(), ["config", "id", "name"], "条目自身键只应有 id/name/config");
  assert.equal(entry.keys.get("root"), undefined, "嵌套的 root 不得被当成条目自身的键");
});

// ────────────────────────────────────────────────────────────────────────────
// 2. launcher 端到端：结构化判据 + 启动期响铃
// ────────────────────────────────────────────────────────────────────────────

test("g-464 判据 3：健康实例走到 boot（就绪判定为真）", { skip: SKIP }, async () => {
  const sb = mkSandbox();
  try {
    const s = await currentScenario(sb, CONFIG_HEALTHY);
    const r = runScript(s.args, { env: s.env });
    assert.equal(r.status, 0, `健康路径必须就绪并 boot：\n${r.stderr}`);
    assert.match(r.stdout, /命中真实 bundle 条目：name=dsh-graph id=dsh-graph-host/, "必须回报结构化判据的命中");
    assert.match(r.stdout, /STUB-BOOT web --no-open --port \d+/, "必须真正走到 boot（exec 到 stub）");
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("g-464 判据 1/2：注释-only 场景判红（exit 2）且**从未 boot**", { skip: SKIP }, async () => {
  const sb = mkSandbox();
  try {
    const s = await currentScenario(sb, CONFIG_COMMENT_ONLY);
    const r = runScript(s.args, { env: s.env });
    assert.equal(r.status, 2, `缺少真实条目必须非零退出（die ⇒ 2）：\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /没有 dsh-graph 的真实 bundle 条目/, "必须点名判据失败");
    assert.match(r.stderr, /全部落在注释里/, "必须点出「只有注释命中」，便于区分成因");
    assert.doesNotMatch(r.stdout, /STUB-BOOT/, "判红时绝不允许已经把服务拉起来");
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("g-464 判据 2：启动期 skipping profile bundle 必须响铃（exit 2 + 点名日志与原因）", { skip: SKIP }, async () => {
  const sb = mkSandbox();
  try {
    const s = await currentScenario(sb, CONFIG_HEALTHY, SKIP_REASON);
    const r = runScript(s.args, { env: s.env });
    assert.equal(r.status, 2, `启动期跳过必须非零退出：\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /在启动期被跳过/, "必须点名「启动期被跳过」");
    assert.match(r.stderr, /skipping profile bundle "dsh-graph"/, "必须回显原始原因行");
    assert.ok(r.stderr.includes(DUMP_LOG_REL), "必须点名日志文件");
    assert.match(r.stderr, /peerDependencies/, "必须给出「声明面不兼容」这类可能成因");
    assert.doesNotMatch(r.stdout, /STUB-BOOT/, "响铃时绝不允许已经把服务拉起来");
    // 诊断痕迹必须留档（旧实现把 stderr 丢进 /dev/null，静默跳过无声无息）。
    const log = join(sb, "root", DUMP_LOG_REL);
    assert.ok(existsSync(log), `dump stderr 必须留档：${log}`);
    assert.match(readFileSync(log, "utf8"), /skipping profile bundle "dsh-graph"/, "日志必须保留原始跳过行");
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 3. 自动化负向对照：基线实现（被取代的判据）在同样两种场景下都判为就绪
// ────────────────────────────────────────────────────────────────────────────

test("g-464 判据 4：基线实现（1bba546）在两种失效场景下都判为就绪 ⇒ 判据回退必红", { skip: SKIP }, async () => {
  const baseline = spawnSync("git", ["show", `${BASELINE_COMMIT}:scripts/dsh-test-web.sh`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(baseline.status, 0, `必须能取到基线脚本 ${BASELINE_COMMIT}:scripts/dsh-test-web.sh`);
  for (const [label, config, skipReason] of [
    ["注释-only（子串命中但条目缺席）", CONFIG_COMMENT_ONLY, undefined],
    ["启动期 skipping profile bundle", CONFIG_HEALTHY, SKIP_REASON],
  ] as Array<[string, string, string | undefined]>) {
    // 基线脚本的 REPO_ROOT 由脚本身处的位置决定：自建一个自洽沙箱
    // `<sb>/scripts/dsh-test-web.sh` + `<sb>/dsh-graph-host` + `<sb>/tmp/dsh-test`。
    const sb = mkSandbox();
    try {
      mkdirSync(join(sb, "scripts"), { recursive: true });
      const baselineScript = join(sb, "scripts", "dsh-test-web.sh");
      writeFileSync(baselineScript, baseline.stdout);
      writeSyntheticHost(join(sb, "dsh-graph-host"));
      const testRoot = join(sb, "tmp", "dsh-test");
      makeReadyRoot(testRoot, join(sb, "dsh-graph-host"));
      const s = await scenario(sb, testRoot, join(sb, "dsh-graph-host"), config, skipReason);
      const r = runScript(s.args, { script: baselineScript, env: s.env });
      assert.equal(r.status, 0, `基线实现必须在该场景下判为就绪（这正是被修复的缺陷）：${label}\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /STUB-BOOT/, `基线实现必须真的把服务拉起来（插件缺席却「就绪」）：${label}`);
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 4. 既有语义不回归：--dry-run / --skip-install
// ────────────────────────────────────────────────────────────────────────────

test("g-464 判据 3：--dry-run 语义与退出码不变（就绪 ⇒ exit 0，且零 dump/零 boot）", { skip: SKIP }, async () => {
  const sb = mkSandbox();
  try {
    const testRoot = join(sb, "root");
    makeReadyRoot(testRoot, HOST_DIR);
    const port = await freePort();
    const r = runScript([FULL_VERSION, "--dry-run", "--port", String(port), "--host-dir", HOST_DIR], {
      env: { DSH_TEST_ROOT: testRoot },
    });
    assert.equal(r.status, 0, `就绪的隔离根在预检下应为 exit 0：\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /只读预检结论：可按当前参数启动（exit 0）/);
    assert.doesNotMatch(r.stdout, /STUB-BOOT/, "预检不得启动服务");
    assert.equal(existsSync(join(testRoot, FULL_VERSION, "effective-config.yml")), false, "预检不得写 composed config");
    assert.equal(existsSync(join(testRoot, DUMP_LOG_REL)), false, "预检不得写 dump 日志");
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("g-464 判据 3：--skip-install 既有要求不变（未就绪的 profile ⇒ exit 2）", { skip: SKIP }, async () => {
  const sb = mkSandbox();
  try {
    const testRoot = join(sb, "root");
    makeReadyRoot(testRoot, HOST_DIR);
    // 抹掉 profile 的 link 声明 ⇒ needs_install=1 ⇒ --skip-install 必须拒绝（既有语义，一字不变）
    const manifest = join(testRoot, STABLE_VERSION, "home/profiles/web/package.json");
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies: Record<string, string> };
    pkg.dependencies[BUNDLE_NAME] = `link:${join(sb, "elsewhere")}`;
    writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
    const port = await freePort();
    const r = runScript([FULL_VERSION, "--skip-install", "--port", String(port), "--host-dir", HOST_DIR], {
      env: { DSH_TEST_ROOT: testRoot },
    });
    assert.equal(r.status, 2, `--skip-install 在 profile 未就绪时必须 exit 2：\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /--skip-install 要求目标 DSH_HOME 已有可复用的 dsh-graph profile/);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 5. 结构性守卫：旧子串判据不得回流 + 判据实现零第三方依赖
// ────────────────────────────────────────────────────────────────────────────

test("g-464 判据 5：launcher 不得再用全文件子串判据，且必须把 dump stderr 留档", () => {
  const script = readFileSync(SCRIPT, "utf8");
  // 只扫**代码行**：注释里为解释缺陷而引用的旧判据原文不算回流。
  const code = script
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.doesNotMatch(code, /grep -q "dsh-graph"\s+"\$EFFECTIVE_CONFIG"/, "旧的全文件子串判据不得回流");
  assert.doesNotMatch(code, /grep -q 'dsh-graph'\s+"\$EFFECTIVE_CONFIG"/, "旧的全文件子串判据不得回流（单引号形态）");
  assert.match(code, /effective-config-bundle-entry\.mjs/, "必须调用结构化判据实现");
  assert.match(code, /2>"\$DUMP_LOG"/, "dump stderr 必须留档（跳过信号由此而来，不得丢 /dev/null）");
  assert.match(code, /skipping profile bundle "dsh-graph"/, "必须检测启动期跳过信号");
  assert.match(script, /^die\(\) \{ printf '错误：%s\\n' "\$\*" >&2; exit 2; \}$/m, "die 的退出码约定不得改变");
});

test("g-464 判据 5：判据实现只用 node 内置模块（无网络、纯 bash+node 环境可用）", () => {
  const source = readFileSync(CHECKER, "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(specifiers.length > 0, "必须能解析出 import 说明符（守卫不得空跑）");
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith("node:"), `判据实现不得引入第三方依赖：${specifier}`);
  }
  assert.doesNotMatch(source, /require\(/, "ESM 判据实现不得使用 require");
});
