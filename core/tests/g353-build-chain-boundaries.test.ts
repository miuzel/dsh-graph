/**
 * core/tests/g353-build-chain-boundaries.test.ts
 *
 * g-353（构建链三类边界，吸收 g-299 残项）的自动化守卫：
 *
 *  ① 无 exchange 平台（coreutils < 9.6 / macOS / BSD）的两次 rename 中间失败/中断：
 *     - 第二次 rename 失败 ⇒ **回滚**（minimal recoverable）：活动路径恢复为逐字节完好的旧树，
 *       非 0 退出、零残留；
 *     - 回滚也失败 ⇒ **fail-closed**：旧树是唯一完好副本，绝不被 EXIT trap 删除，恢复命令上屏；
 *     - 窗口内被 SIGKILL ⇒ 下次构建**自动恢复**（可重放），且**不做 stage 自动 GC**（本包明确不做）；
 *     - 能力探测（`mv --exchange --help` = 二进制能力）必须与**文件系统实际 exchange 失败**
 *       区分：后者告警并退回两次 rename，而不是与「平台不支持」混为一谈。
 *  ② `build-client.sh` 独立调用会**就地非原子**重写活动 `dist/lib/client.js` ⇒ 明确告警并指向
 *     `build.sh`；`build.sh` 传 DIST_DIR 时零噪音（不把它改成原子构建）。
 *  ③ 打包入口唯一化：根 `build` = `prepare` = `bash scripts/build.sh`，**没有** prepack，文档与
 *     真实脚本一致；`check:dist` 指向的守卫本身不构建、不修复、不改文件，且能识别陈旧产物与漏模块
 *     —— 但**经 pnpm 运行时**会先触发 `prepare` 完整构建（g-408），故纯只读入口一律直接调
 *     `node --test core/tests/dist-freshness-g312.test.ts`，不经 pnpm。
 *
 * 全部断言在 os.tmpdir() 的 hermetic 沙箱里跑**真实** `scripts/build.sh` / `build-client.sh`，
 * 绝不触碰仓库 dist/（在测试里构建活动 dist 正是 g-348 要消除的故障）。
 * 失败路径用**故障注入**（`BUILD_INJECT_PUBLISH_FAILURE`）驱动，未注入时与历史实现逐字等价；
 * 每个关键断言都带**负向对照**（把守卫改坏即红），判别力由对照钉住而不是靠「恒真断言」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
const BUILD_SCRIPT = join(repoRoot, "scripts", "build.sh");
const BUILD_CLIENT_SCRIPT = join(repoRoot, "scripts", "build-client.sh");
const FRESHNESS_SUITE = "core/tests/dist-freshness-g312.test.ts";

// ============================================================================
// 沙箱 / 运行器 / 摘要工具
// ============================================================================

interface Sandbox {
  root: string;
  repo: string;
}

/** 与真实仓库同构的 hermetic 沙箱；`dist/` **最后**拷贝，保证产物 mtime 不早于源（新鲜度族）。 */
function makeSandbox(opts: { withFreshnessSuite?: boolean } = {}): Sandbox {
  assert.ok(
    existsSync(join(repoRoot, "dist", "prompts")),
    "dist/ 不存在或不完整：请先运行 bash scripts/build.sh 再跑测试（dist/ 是生成物，禁止手改）",
  );
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g353-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  cpSync(join(repoRoot, "scripts"), join(repo, "scripts"), { recursive: true });
  cpSync(join(repoRoot, "dsh-graph-host"), join(repo, "dsh-graph-host"), { recursive: true });
  mkdirSync(join(repo, "core"), { recursive: true });
  for (const name of readdirSync(join(repoRoot, "core"))) {
    if (name.endsWith(".ts")) cpSync(join(repoRoot, "core", name), join(repo, "core", name));
  }
  for (const name of ["tsconfig.json", "package.json"]) cpSync(join(repoRoot, name), join(repo, name));
  if (opts.withFreshnessSuite) {
    mkdirSync(join(repo, "core", "tests"), { recursive: true });
    cpSync(join(repoRoot, FRESHNESS_SUITE), join(repo, FRESHNESS_SUITE));
  }
  cpSync(join(repoRoot, "dist"), join(repo, "dist"), { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(repo, "node_modules"), "dir");
  return { root, repo };
}

function cleanupSandbox(sb: Sandbox): void {
  rmSync(sb.root, { recursive: true, force: true });
}

interface RunResult {
  code: number | null;
  out: string;
  err: string;
}

function runBash(cmd: string, cwd: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

/**
 * 干净 env：先摘掉宿主环境里的注入/测试运行器变量。
 * **`NODE_TEST_CONTEXT` 必须摘掉**：它会让嵌套 `node --test` 打印
 * 「node:test run() is being called recursively… skipping running files」并**以 0 退出**，
 * 使「只读 check 报红」这类断言变成永真。本套件已由负向对照实测踩到过这个坑。
 */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BUILD_FORCE_TWO_RENAME;
  delete env.BUILD_INJECT_PUBLISH_FAILURE;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return { ...env, ...extra };
}

type Inject = "exchange" | "second-rename" | "rollback" | "kill";

/** 构建运行器；`pathPrefix` 可把平台模拟 shim（如不支持 --exchange 的 mv）前置到 PATH。 */
function runBuild(
  sb: Sandbox,
  opts: { force?: boolean; inject?: Inject; pathPrefix?: string } = {},
): Promise<RunResult> {
  const extra: NodeJS.ProcessEnv = {};
  if (opts.force) extra.BUILD_FORCE_TWO_RENAME = "1";
  if (opts.inject) extra.BUILD_INJECT_PUBLISH_FAILURE = opts.inject;
  if (opts.pathPrefix) extra.PATH = `${opts.pathPrefix}:${process.env.PATH ?? ""}`;
  return runBash("bash scripts/build.sh", sb.repo, cleanEnv(extra));
}

/** 列出文件（相对路径）；符号链接单独标记，绝不跟随（沙箱里有 node_modules 软链）。 */
function listFilesRel(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) out.push(`${rel}@symlink`);
    else if (entry.isDirectory()) out.push(...listFilesRel(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** 内容摘要（不含 mtime）：用于「逐字节一致」断言。 */
function contentDigest(dir: string): string {
  const hash = createHash("sha256");
  for (const rel of listFilesRel(dir)) {
    hash.update(`${rel}\u0000`);
    hash.update(readFileSync(join(dir, rel)));
  }
  return hash.digest("hex");
}

/** 全树摘要（路径 + 尺寸 + mtime + 内容）：用于「只读 check 零改动」断言，能抓住同内容的重建。 */
function fullDigest(root: string): string {
  const hash = createHash("sha256");
  for (const rel of listFilesRel(root)) {
    if (rel.endsWith("@symlink")) {
      hash.update(`${rel}\u0000`);
      continue;
    }
    const st = statSync(join(root, rel));
    hash.update(`${rel}\u0000${st.size}\u0000${st.mtimeMs}\u0000`);
    hash.update(readFileSync(join(root, rel)));
  }
  return hash.digest("hex");
}

const prevDirs = (repo: string): string[] =>
  readdirSync(repo).filter((name) => name.startsWith("dist.prev.")).sort();
const stageDirs = (repo: string): string[] =>
  readdirSync(repo).filter((name) => name.startsWith(".dist-stage.")).sort();
/** 构建残留（暂存根 / 旧树 / 编译中间目录）。 */
const residue = (repo: string): string[] =>
  readdirSync(repo)
    .filter((name) => name.startsWith(".dist-stage.") || name.startsWith("dist.prev.") || name === "core-dist")
    .sort();

/** 恰好命中一次的字面替换；命中 0 次或多次即抛错（防止锚点漂移后负向对照静默失效）。 */
function replaceOnce(src: string, from: string, to: string): string {
  const parts = src.split(from);
  assert.equal(
    parts.length,
    2,
    `锚点必须恰好命中 1 次（实际 ${parts.length - 1} 次）：${JSON.stringify(from)}；` +
      "被守卫的脚本结构已变，请同步更新本负向对照，切勿让它静默失效",
  );
  return parts[0] + to + parts[1];
}

/**
 * 构造「mv 二进制不支持 --exchange」的平台模拟（macOS/BSD / coreutils < 9.6 的真实口径）：
 * 用 PATH 前置的 shim 复刻该平台的 mv，其余参数原样转发给真实 mv（故两次 rename 仍是真的）。
 */
function makeMvWithoutExchange(sb: Sandbox): string {
  const realMv = spawnSync("bash", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim();
  assert.ok(realMv.startsWith("/"), `需要定位真实 mv 以模拟无 exchange 平台，实际「${realMv}」`);
  const shimDir = join(sb.root, "mv-no-exchange");
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, "mv");
  writeFileSync(
    shim,
    "#!/usr/bin/env bash\n" +
      "# g-353 平台模拟：macOS/BSD / coreutils<9.6 的 mv 不认识 --exchange\n" +
      'for arg in "$@"; do\n' +
      '  if [ "$arg" = "--exchange" ]; then\n' +
      "    echo \"mv: unrecognized option '--exchange'\" >&2\n" +
      "    exit 64\n" +
      "  fi\n" +
      "done\n" +
      `exec "${realMv}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return shimDir;
}

// ============================================================================
// ① 两次 rename 的中间失败 / 中断
// ============================================================================

test("g-353 判据 1：第二次 rename 失败 ⇒ 回滚恢复活动路径（旧树逐字节完好，零残留）", async (t) => {
  const sb = makeSandbox();
  try {
    const dist = join(sb.repo, "dist");
    const before = contentDigest(dist);

    const r = await runBuild(sb, { force: true, inject: "second-rename" });
    t.diagnostic(
      `evidence: suite=g353-second-rename exit=${r.code} restored=${existsSync(dist)} ` +
        `same=${existsSync(dist) && contentDigest(dist) === before} residue=${residue(sb.repo).length}`,
    );

    assert.notEqual(r.code, 0, "第二次 rename 失败必须以非 0 退出（不得谎报发布成功）");
    assert.match(r.err, /第二次 rename 失败/, "须点明「第二次 rename 失败」");
    assert.match(r.err, /已回滚/, "须明确回滚成功（最小可恢复）");
    assert.ok(existsSync(dist), "回滚后活动路径 dist/ 必须存在（不是「prev 里留着、活动路径缺失」）");
    assert.equal(contentDigest(dist), before, "回滚后 dist/ 必须是逐字节完好的旧树");
    assert.deepEqual(residue(sb.repo), [], "回滚路径不得留下暂存根 / 旧树 / core-dist 残留");

    // 负向对照（改坏即红）：短路回滚分支 ⇒ 同一注入下活动路径必须仍然缺失（证明「恢复」来自新代码）。
    const sb2 = makeSandbox();
    try {
      const script = readFileSync(join(sb2.repo, "scripts", "build.sh"), "utf8");
      writeFileSync(
        join(sb2.repo, "scripts", "build.sh"),
        replaceOnce(script, "  if rollback_old; then", "  if false; then"),
      );
      const r2 = await runBuild(sb2, { force: true, inject: "second-rename" });
      assert.notEqual(r2.code, 0, "负向对照仍应非 0 退出");
      assert.ok(
        !existsSync(join(sb2.repo, "dist")),
        "负向对照：短路回滚后 dist/ 必须仍然缺失 ⇒ 上面的「回滚恢复活动路径」断言有判别力",
      );
      assert.equal(prevDirs(sb2.repo).length, 1, "负向对照下旧树退化为 dist.prev.<pid>（fail-closed 形态）");
    } finally {
      cleanupSandbox(sb2);
    }
  } finally {
    cleanupSandbox(sb);
  }
});

test("g-353 判据 1：回滚也失败 ⇒ fail-closed 保留旧树并给恢复命令（负向对照：删掉保留即红）", async (t) => {
  const sb = makeSandbox();
  try {
    const dist = join(sb.repo, "dist");
    const before = contentDigest(dist);

    const r = await runBuild(sb, { force: true, inject: "rollback" });
    const prevs = prevDirs(sb.repo);
    t.diagnostic(
      `evidence: suite=g353-fail-closed exit=${r.code} distMissing=${!existsSync(dist)} prevs=${prevs.length} ` +
        `prevSame=${prevs.length === 1 && contentDigest(join(sb.repo, prevs[0])) === before} stageLeft=${stageDirs(sb.repo).length}`,
    );

    assert.notEqual(r.code, 0, "fail-closed 必须非 0 退出");
    assert.match(r.err, /fail-closed/, "须点明 fail-closed 口径");
    assert.match(r.err, /恢复命令：mv "/, "须打印可直接执行的恢复命令");
    assert.ok(!existsSync(dist), "fail-closed 下活动路径缺失是已知状态（文档已给恢复命令）");
    assert.equal(prevs.length, 1, `旧树必须完整保留为 dist.prev.<pid>（实际 ${prevs.length} 个）`);
    assert.equal(
      contentDigest(join(sb.repo, prevs[0])),
      before,
      "旧树是唯一完好副本，必须逐字节完好 —— 绝不为兜底而删除仍然完好的旧 dist",
    );
    assert.deepEqual(stageDirs(sb.repo), [], "fail-closed 仍应清掉暂存根（只保留旧树）");

    // 负向对照（改坏即红）：让 EXIT trap 无条件删除旧树 ⇒ 同一注入下旧树必须消失。
    const sb2 = makeSandbox();
    try {
      const script = readFileSync(join(sb2.repo, "scripts", "build.sh"), "utf8");
      writeFileSync(
        join(sb2.repo, "scripts", "build.sh"),
        replaceOnce(script, 'if [ -n "$SWAP_IN_FLIGHT" ] && [ -e "$LEGACY_PREV" ]; then', "if false; then"),
      );
      const r2 = await runBuild(sb2, { force: true, inject: "rollback" });
      assert.notEqual(r2.code, 0, "负向对照仍应非 0 退出（退出码不是本对照的判据）");
      assert.deepEqual(
        prevDirs(sb2.repo),
        [],
        "负向对照：无条件删除时旧树确实消失 ⇒ 上面的「保留旧树」断言有判别力（而不是恒真）",
      );
    } finally {
      cleanupSandbox(sb2);
    }
  } finally {
    cleanupSandbox(sb);
  }
});

test("g-353 判据 1：SIGKILL 中断 ⇒ 下次构建自动恢复（可重放），且不做 stage 自动 GC", async (t) => {
  const sb = makeSandbox();
  try {
    const dist = join(sb.repo, "dist");
    const before = contentDigest(dist);

    const killed = await runBuild(sb, { force: true, inject: "kill" });
    const prevs = prevDirs(sb.repo);
    const stageAfterKill = stageDirs(sb.repo).length;
    assert.notEqual(killed.code, 0, "被 SIGKILL 的构建不得报成功");
    assert.ok(!existsSync(dist), "SIGKILL 后 dist/ 缺失（trap 无法运行，这正是需要恢复命令的场景）");
    assert.equal(prevs.length, 1, `SIGKILL 必须留下恰好一个 dist.prev.<pid>（实际 ${prevs.length}）`);
    assert.equal(contentDigest(join(sb.repo, prevs[0])), before, "SIGKILL 留下的旧树必须逐字节完好");
    assert.ok(stageAfterKill >= 1, "SIGKILL 必然留下暂存根（trap 不运行）—— 这是本包明确不自动 GC 的对象");

    const rebuilt = await runBuild(sb);
    t.diagnostic(
      `evidence: suite=g353-sigkill killExit=${killed.code} stageAfterKill=${stageAfterKill} ` +
        `rebuildExit=${rebuilt.code} recovered=${/自动恢复/.test(rebuilt.err)} same=${contentDigest(dist) === before}`,
    );
    assert.equal(rebuilt.code, 0, `恢复后的构建应成功，实际 exit=${rebuilt.code}\n${rebuilt.out.slice(-1200)}`);
    assert.match(rebuilt.err, /自动恢复/, "下次构建必须自动恢复被中断的旧树（可重放：恢复动作幂等）");
    assert.ok(existsSync(dist), "恢复后活动路径必须存在");
    assert.equal(contentDigest(dist), before, "恢复 + 重建后的 dist 必须与中断前逐字节一致");
    assert.deepEqual(prevDirs(sb.repo), [], "恢复后不得再残留 dist.prev.*");
    assert.equal(
      stageDirs(sb.repo).length,
      stageAfterKill,
      "边界：不做 SIGKILL stage 自动 GC —— 遗留暂存根数量不得被自动清理（恢复只搬回旧树）",
    );

    // 负向对照（改坏即红）：短路自动恢复条件 ⇒ 遗留旧树必须原样留着，不会被搬回活动路径。
    const sb2 = makeSandbox();
    try {
      const script = readFileSync(join(sb2.repo, "scripts", "build.sh"), "utf8");
      writeFileSync(
        join(sb2.repo, "scripts", "build.sh"),
        replaceOnce(
          script,
          'if [ ! -e "$DIST" ] && [ -n "$prev_latest" ]; then',
          "if false; then",
        ),
      );
      const killed2 = await runBuild(sb2, { force: true, inject: "kill" });
      assert.notEqual(killed2.code, 0, "负向对照的第一次构建同样被 SIGKILL");
      const rebuilt2 = await runBuild(sb2);
      assert.equal(rebuilt2.code, 0, "负向对照的第二次构建仍应成功（它只是不再自动恢复）");
      assert.doesNotMatch(rebuilt2.err, /自动恢复/, "负向对照：短路后不得再打印自动恢复");
      assert.equal(
        prevDirs(sb2.repo).length,
        1,
        "负向对照：遗留旧树必须原样留着（不再被搬回 dist/）⇒ 上面的「自动恢复」断言有判别力",
      );
    } finally {
      cleanupSandbox(sb2);
    }
  } finally {
    cleanupSandbox(sb);
  }
});

test("g-353 判据 1：能力探测 vs 文件系统实际 exchange 失败必须区分（运行时失败仍退回两次 rename）", async (t) => {
  const sb = makeSandbox();
  try {
    const dist = join(sb.repo, "dist");
    const before = contentDigest(dist);

    const r = await runBuild(sb, { inject: "exchange" });
    t.diagnostic(
      `evidence: suite=g353-exchange-runtime-failure exit=${r.code} capabilityWarn=${/能力探测通过/.test(r.err)} ` +
        `fallbackWarn=${/退回两次 rename/.test(r.err)} same=${contentDigest(dist) === before}`,
    );
    assert.equal(
      r.code,
      0,
      "文件系统实际不支持 RENAME_EXCHANGE 时应退回两次 rename 并完成发布，而不是让构建失败",
    );
    assert.match(r.err, /能力探测通过/, "须明说「能力探测通过」（mv 二进制支持 --exchange）");
    assert.match(r.err, /实际 exchange 失败/, "须明说「实际 exchange 失败」（运行时/文件系统层）");
    assert.match(r.err, /退回两次 rename/, "须点明退回两次 rename");
    assert.doesNotMatch(r.out, /mv -T --exchange（单次系统调用/, "运行时失败不得谎报原子发布成功");
    assert.equal(contentDigest(dist), before, "退回路径的产物必须与正常路径逐字节一致");
    assert.deepEqual(residue(sb.repo), [], "运行时失败退回路径不得留下残留");

    // 两种「不支持」的口径必须不同：能力探测失败（= macOS/BSD/coreutils<9.6）说「当前 mv 不支持」，
    // 而运行时失败说「能力探测通过…实际 exchange 失败」。前者用 mv shim **忠实模拟**平台（而不是
    // 复用 g-359 的注入，注入会打印注入口径，测不到真实平台的 else 分支文案）。
    const shimDir = makeMvWithoutExchange(sb);
    const noExchange = await runBuild(sb, { pathPrefix: shimDir });
    assert.equal(noExchange.code, 0, `无 exchange 能力的退化路径应成功，实际 exit=${noExchange.code}`);
    assert.match(noExchange.err, /当前 mv 不支持 --exchange/, "无交换能力必须报「mv 不支持」（真实平台口径）");
    assert.match(noExchange.err, /退回两次 rename/, "无交换能力须点明退回两次 rename");
    assert.doesNotMatch(noExchange.err, /能力探测通过/, "无交换能力不得与运行时失败混为一谈");
    assert.equal(contentDigest(dist), before, "无交换能力平台的退化产物必须与正常路径逐字节一致");
    assert.deepEqual(residue(sb.repo), [], "无交换能力退化路径不得留下残留");
  } finally {
    cleanupSandbox(sb);
  }
});

// ============================================================================
// ② build-client.sh 独立调用（非原子）警告
// ============================================================================

test("g-353 判据 2：build-client 独立调用有明确非原子警告，构建路径零噪音（负向对照：删告警即红）", async (t) => {
  const text = readFileSync(BUILD_CLIENT_SCRIPT, "utf8");
  assert.match(text, /独立调用/, "脚本文档须自述独立调用契约");
  assert.match(text, /非原子/, "须明确「就地重写非原子」");
  assert.match(text, /scripts\/build\.sh/, "须指路唯一打包入口 build.sh");

  const sb = makeSandbox();
  try {
    const standaloneEnv = cleanEnv();
    delete standaloneEnv.DIST_DIR;
    const standalone = await runBash("bash scripts/build-client.sh", sb.repo, standaloneEnv);
    t.diagnostic(
      `evidence: suite=g353-build-client-warning exit=${standalone.code} warn=${/独立调用/.test(standalone.err)}`,
    );
    assert.equal(standalone.code, 0, `独立调用仍应成功（只加警告、不改成原子构建），实际 exit=${standalone.code}`);
    assert.match(standalone.err, /独立调用/, "独立调用必须在 stderr 明确告警");
    assert.match(standalone.err, /非原子/, "告警须点明非原子写入");
    assert.match(standalone.err, /bash scripts\/build\.sh/, "告警须提示发布走 build.sh 的暂存/切换路径");

    const outDir = join(sb.root, "staged");
    const viaBuild = await runBash("bash scripts/build-client.sh", sb.repo, cleanEnv({ DIST_DIR: outDir }));
    assert.equal(viaBuild.code, 0, "DIST_DIR 重定向路径应成功");
    assert.ok(existsSync(join(outDir, "lib", "client.js")), "DIST_DIR 重定向仍须生效（契约不变）");
    assert.doesNotMatch(viaBuild.err, /独立调用/, "build.sh 传 DIST_DIR 时不得有告警（构建路径零噪音）");

    // 负向对照（改坏即红）：删掉告警分支 ⇒ 同一独立调用必须无告警。
    const script = readFileSync(join(sb.repo, "scripts", "build-client.sh"), "utf8");
    writeFileSync(
      join(sb.repo, "scripts", "build-client.sh"),
      replaceOnce(script, 'if [ -z "${DIST_DIR:-}" ]; then', "if false; then"),
    );
    const gutted = await runBash("bash scripts/build-client.sh", sb.repo, standaloneEnv);
    assert.equal(gutted.code, 0, "负向对照仍应成功");
    assert.doesNotMatch(
      gutted.err,
      /独立调用/,
      "负向对照：移除告警分支后必须无告警 ⇒ 上面的告警断言有判别力（而不是恒真）",
    );
  } finally {
    cleanupSandbox(sb);
  }
});

// ============================================================================
// ③ 打包入口唯一化 + 只读 check
// ============================================================================

test("g-353 判据 3：根打包入口唯一（build = prepare = build.sh，无 prepack）且文档与真实脚本一致", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  assert.equal(scripts.build, "bash scripts/build.sh", "根 build 必须指向唯一入口");
  assert.equal(scripts.prepare, "bash scripts/build.sh", "prepare（GitHub 源码安装）必须复用同一入口");
  assert.ok(!("prepack" in scripts), "根 package.json 不得再有 prepack（历史文档引用的 prepack 并不存在）");
  assert.ok(existsSync(join(repoRoot, "scripts", "build.sh")), "入口引用的脚本必须真实存在");

  // 文档与真实脚本一致：现行文档不得再让用户跑一个不存在的 `pnpm prepack`。
  for (const doc of ["AGENTS.md", "scripts/build.sh"]) {
    const body = readFileSync(join(repoRoot, doc), "utf8");
    assert.doesNotMatch(
      body,
      /pnpm prepack|npm run prepack/,
      `${doc} 不得再声称存在 prepack 入口（文档与真实脚本必须一致）`,
    );
  }
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  assert.match(agents, /bash scripts\/build\.sh/, "AGENTS.md 须给出唯一构建/打包入口");
  assert.match(agents, /check:dist/, "AGENTS.md 须给出 check:dist 入口（其非只读告警见 g-408）");
  assert.match(
    agents,
    /node --test core\/tests\/dist-freshness-g312\.test\.ts/,
    "AGENTS.md 须给出不触发构建的纯只读入口（node --test …）",
  );
  const handbook = readFileSync(join(repoRoot, "docs", "release-handbook.md"), "utf8");
  assert.match(handbook, /唯一打包入口/, "发布手册须给出唯一的现行打包入口");
  assert.match(handbook, /已废止/, "发布手册须标注历史 prepack 已废止");
});

test("g-353 判据 3：只读 check 不改任何文件，且能识别陈旧产物与漏模块（负向对照）", async (t) => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const cmd = (pkg.scripts ?? {})["check:dist"] ?? "";
  assert.match(
    cmd,
    /^node --test core\/tests\/dist-freshness-g312\.test\.ts$/,
    `check:dist 必须是指向既有只读守卫的最小入口（实际「${cmd}」）`,
  );
  assert.doesNotMatch(cmd, /build\.sh|build-client\.sh|tsc/, "只读 check 命令不得调用任何构建脚本");
  const checkSrc = readFileSync(join(repoRoot, FRESHNESS_SUITE), "utf8");
  assert.doesNotMatch(
    checkSrc,
    /\b(spawn|spawnSync|execFileSync|execSync)\s*\(/,
    "只读 check 守卫不得具备 spawn/exec 能力（结构上不可能静默触发构建）",
  );

  const sb = makeSandbox({ withFreshnessSuite: true });
  try {
    const before = fullDigest(sb.repo);
    const clean = await runBash(cmd, sb.repo, cleanEnv());
    t.diagnostic(
      `evidence: suite=g353-readonly-check exit=${clean.code} digestStable=${fullDigest(sb.repo) === before}`,
    );
    assert.equal(clean.code, 0, `只读 check 在新鲜仓库上应绿：\n${clean.out.slice(-1500)}`);
    // 判别力前提：守卫必须**真的被执行**。宿主注入 NODE_TEST_CONTEXT 时嵌套 `node --test` 会
    // 「skipping running files」并以 0 退出 ⇒ 下面的报红断言会变成永真（本套件实测踩到过）。
    assert.match(
      clean.out,
      /g-312 判据 4：编译\/拼接族源文件 mtime/,
      `只读 check 必须真的跑到守卫本身，实际输出：${clean.out.slice(-800)}`,
    );
    assert.equal(
      fullDigest(sb.repo),
      before,
      "只读 check 不得改动沙箱内任何文件（含 mtime）—— 不构建、不修复",
    );

    // 负向对照 A：把源文件 mtime 推到产物之后（陈旧产物）⇒ 必须报红。
    const stale = join(sb.repo, "core", "model.ts");
    const future = new Date(Date.now() + 60_000);
    utimesSync(stale, future, future);
    const redStale = await runBash(cmd, sb.repo, cleanEnv());
    assert.notEqual(redStale.code, 0, "陈旧产物必须被只读 check 识别（不得静默通过）");
    assert.match(redStale.out, /产物陈旧|内容不一致/, `陈旧族必须报红，实际输出：${redStale.out.slice(-600)}`);

    // 负向对照 B：从 PARTS 里删掉一个真实模块（漏模块）⇒ 必须报红。
    const bc = join(sb.repo, "scripts", "build-client.sh");
    writeFileSync(bc, replaceOnce(readFileSync(bc, "utf8"), '  "narrow-width"\n', ""));
    const redModule = await runBash(cmd, sb.repo, cleanEnv());
    assert.notEqual(redModule.code, 0, "漏模块必须被只读 check 识别（不得静默通过）");
    assert.match(
      redModule.out,
      /PARTS|一一对应/,
      `漏模块族必须报红，实际输出：${redModule.out.slice(-600)}`,
    );
  } finally {
    cleanupSandbox(sb);
  }
});
