/**
 * core/tests/g359-two-rename-fallback.test.ts
 *
 * g-359 质量判据 3 的自动化守卫：`scripts/build.sh` 的**退化发布路径**
 * （`mv` 不支持 `--exchange` ⇒ 两次 rename + stderr 告警）必须有机器覆盖，
 * 且为它提供的测试注入 `BUILD_FORCE_TWO_RENAME` 必须是**行为中性**的。
 *
 * 为什么需要（不是理论风险）：
 *   - 该分支在 coreutils ≥ 9.6 的构建机上**永远走不到**，g-348 的测试里
 *     `grep exchange` 0 命中 ⇒ 退化路径长期零覆盖，改坏了也没人知道；
 *   - 它影响的不是小众场景：macOS/BSD 的 `mv` 没有 `--exchange`，coreutils < 9.6 的
 *     Linux 用户同样走这里 —— 也就是说「非 WSL2 的 macOS 发布构建」正是这条路径。
 *
 * 四个断言面（全部在 os.tmpdir() 的 hermetic 沙箱里跑**真实** scripts/build.sh，
 * 绝不触碰仓库 dist/ —— 在测试里构建活动 dist 正是 g-348 要消除的故障）：
 *
 *  A. 正常路径（未设置注入）：exit 0、走 `mv -T --exchange`、**stderr 零告警**；
 *  B. 退化路径（`BUILD_FORCE_TWO_RENAME=1`）：exit 0、stderr 出现注入告警、
 *     且**不**出现 `mv -T --exchange`（证明确实切换了发布方式，而不是静默走原路径）；
 *  C. 行为中性：A 与 B 的 `dist/` 全树（路径 + 尺寸 + sha256）**逐字节一致**，
 *     37 个文件、`node --check dist/lib/client.js` 通过、无暂存残留；
 *  D. 边界 + 负向对照：注入只认字面 "1"（`=0` 仍走 exchange）；把注入条件从
 *     build.sh 里锚点化移除后，同一 `=1` 调用**必须**回到 exchange 路径 ⇒
 *     证明 B 的「不出现 exchange」不是恒真断言，改坏必红。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
const BUILD_SCRIPT = join(repoRoot, "scripts", "build.sh");

/** g-359 注入的告警行（stderr，仅退化路径出现）。 */
const FORCE_WARN_RE = /BUILD_FORCE_TWO_RENAME=1（g-359 测试注入）/;
/** 正常路径的发布方式标志（stdout）。 */
const EXCHANGE_RE = /mv -T --exchange/;
/** 退化路径的口径行（stderr）——两条分支都含「退回两次 rename」。 */
const FALLBACK_RE = /退回两次 rename/;

/** `dist/` 应有文件数（g-348/g-359 判据里的固定产物面）。 */
const DIST_FILE_COUNT = 37;

// ============================================================================
// 沙箱（与 g-348 测试同构：真实仓库布局，但只在 os.tmpdir() 内读写）
// ============================================================================

interface Sandbox {
  root: string;
  repo: string;
}

function makeSandbox(): Sandbox {
  assert.ok(
    existsSync(join(repoRoot, "dist", "prompts")),
    "dist/ 不存在或不完整：请先运行 bash scripts/build.sh 再跑测试（dist/ 是生成物，禁止手改）",
  );
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g359-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  cpSync(join(repoRoot, "scripts"), join(repo, "scripts"), { recursive: true });
  cpSync(join(repoRoot, "dsh-graph-host"), join(repo, "dsh-graph-host"), { recursive: true });
  mkdirSync(join(repo, "core"), { recursive: true });
  for (const name of readdirSync(join(repoRoot, "core"))) {
    if (name.endsWith(".ts")) cpSync(join(repoRoot, "core", name), join(repo, "core", name));
  }
  for (const name of ["tsconfig.json", "package.json"]) {
    cpSync(join(repoRoot, name), join(repo, name));
  }
  cpSync(join(repoRoot, "dist"), join(repo, "dist"), { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(repo, "node_modules"), "dir");
  return { root, repo };
}

function cleanupSandbox(sb: Sandbox): void {
  rmSync(sb.root, { recursive: true, force: true });
}

/** 干净 env：先把宿主环境里的注入变量摘掉，再叠加本次用例的取值。 */
function buildEnv(force?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BUILD_FORCE_TWO_RENAME;
  if (force !== undefined) env.BUILD_FORCE_TWO_RENAME = force;
  return env;
}

interface BuildRun {
  code: number | null;
  out: string;
  err: string;
}

function runBuild(sb: Sandbox, force?: string): Promise<BuildRun> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["scripts/build.sh"], {
      cwd: sb.repo,
      env: buildEnv(force),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

function runNode(args: string[], cwd: string): Promise<BuildRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

function listFilesRel(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRel(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * `dist/` 全树清单：逐文件 sha256（**不含** mtime —— 判据只要求「产物一致」，
 * 时间戳天然不同，拿它做断言只会引入假失败）。
 */
function treeManifest(dir: string): string {
  const lines: string[] = [];
  for (const rel of listFilesRel(dir)) {
    const body = readFileSync(join(dir, rel));
    const hash = createHash("sha256").update(body).digest("hex");
    lines.push(`${hash}  ${rel}`);
  }
  return lines.join("\n");
}

/** 构建残留：暂存根 / 退化路径旧树临时名 / 编译中间目录。 */
function residue(repo: string): string[] {
  return readdirSync(repo)
    .filter((name) => name.startsWith(".dist-stage.") || name.startsWith("dist.prev.") || name === "core-dist")
    .sort();
}

/** 恰好命中一次的字面替换；命中 0 次或多次即抛错（防止锚点漂移后对照静默失效）。 */
function replaceOnce(src: string, from: string, to: string): string {
  const parts = src.split(from);
  assert.equal(
    parts.length,
    2,
    `锚点必须恰好命中 1 次（实际 ${parts.length - 1} 次）：${JSON.stringify(from)}；` +
      "build.sh 结构已变，请同步更新本测试，切勿让它静默失效",
  );
  return parts[0] + to + parts[1];
}

// ============================================================================
// 断言
// ============================================================================

test("g-359 判据 3：退化发布路径（无 mv --exchange 时两次 rename）有机器覆盖且注入行为中性", async (t) => {
  const sb = makeSandbox();
  try {
    // 前置：本机 mv 必须**支持** --exchange，否则「正常路径」与「退化路径」无从区分，
    // 本测试的判别力归零；此时显式 skip，而不是把不可区分当成通过。
    const mvProbe = await new Promise<number | null>((resolve) => {
      const c = spawn("bash", ["-c", "mv --exchange --help >/dev/null 2>&1"], { cwd: sb.repo });
      c.on("close", (code) => resolve(code));
    });
    if (mvProbe !== 0) {
      t.skip("本机 mv 不支持 --exchange：正常/退化路径不可区分，跳过（在 macOS/BSD 或 coreutils<9.6 上属预期）");
      return;
    }

    const distDir = join(sb.repo, "dist");

    // ---- A. 正常路径（注入未设置）----
    const normal = await runBuild(sb, undefined);
    assert.equal(normal.code, 0, `正常构建应成功，实际 exit=${normal.code}\n${normal.out.slice(-1200)}`);
    assert.match(normal.out, EXCHANGE_RE, "未设置注入时仍应走 mv -T --exchange（历史行为不变）");
    assert.doesNotMatch(
      normal.err,
      FORCE_WARN_RE,
      `未设置注入时 stderr 不得出现退化路径告警（行为中性），实际 stderr：${normal.err.slice(0, 400)}`,
    );
    const normalManifest = treeManifest(distDir);
    const normalFiles = listFilesRel(distDir);
    assert.equal(
      normalFiles.length,
      DIST_FILE_COUNT,
      `正常路径 dist/ 应有 ${DIST_FILE_COUNT} 个文件，实际 ${normalFiles.length}`,
    );

    // ---- B. 退化路径（注入 = "1"）----
    const forced = await runBuild(sb, "1");
    assert.equal(forced.code, 0, `退化路径构建应成功（exit 0），实际 exit=${forced.code}\n${forced.out.slice(-1200)}`);
    assert.match(
      forced.err,
      FORCE_WARN_RE,
      `退化路径必须在 stderr 告警，实际 stderr：${forced.err.slice(0, 400)}`,
    );
    assert.match(forced.err, FALLBACK_RE, "告警须点明退回两次 rename 的口径");
    assert.doesNotMatch(
      forced.out,
      EXCHANGE_RE,
      "BUILD_FORCE_TWO_RENAME=1 必须真的切换发布方式（若仍打印 mv -T --exchange，说明注入已失效）",
    );
    const forcedManifest = treeManifest(distDir);
    const forcedFiles = listFilesRel(distDir);
    t.diagnostic(
      `evidence: suite=g359-two-rename normalExit=${normal.code} forcedExit=${forced.code} ` +
        `files=${forcedFiles.length} sameTree=${forcedManifest === normalManifest} residue=${residue(sb.repo).length}`,
    );

    // ---- C. 行为中性：两条路径产物逐字节一致 ----
    assert.equal(
      forcedFiles.length,
      DIST_FILE_COUNT,
      `退化路径 dist/ 应有 ${DIST_FILE_COUNT} 个文件，实际 ${forcedFiles.length}`,
    );
    assert.equal(
      forcedManifest,
      normalManifest,
      "退化路径与正常路径的 dist/ 全树必须逐字节一致（注入只改变发布方式，不改变产物）",
    );
    const syntax = await runNode(["--check", join(distDir, "lib", "client.js")], sb.repo);
    assert.equal(syntax.code, 0, `退化路径后 node --check dist/lib/client.js 应通过：${syntax.err.slice(0, 600)}`);
    assert.deepEqual(residue(sb.repo), [], "两条路径都不得留下暂存/旧树/编译中间残留");
    assert.ok(statSync(distDir).isDirectory(), "退化发布后 dist 必须仍是普通目录");

    // ---- D1. 边界：注入只认字面 "1" ----
    const zero = await runBuild(sb, "0");
    assert.equal(zero.code, 0, `BUILD_FORCE_TWO_RENAME=0 构建应成功，实际 exit=${zero.code}`);
    assert.match(zero.out, EXCHANGE_RE, 'BUILD_FORCE_TWO_RENAME=0 不得触发退化路径（只认字面 "1"）');
    assert.doesNotMatch(zero.err, FORCE_WARN_RE, "BUILD_FORCE_TWO_RENAME=0 不得打印注入告警");

    // ---- D2. 负向对照（改坏即红）：把注入条件从 build.sh 移除 ----
    const script = readFileSync(join(sb.repo, "scripts", "build.sh"), "utf8");
    // 结构性锚点：注入点必须仍是这两处（漂移即抛错，绝不静默失效）。
    const mutated = replaceOnce(
      replaceOnce(
        script,
        'FORCE_TWO_RENAME="${BUILD_FORCE_TWO_RENAME:-0}"',
        'FORCE_TWO_RENAME="0"',
      ),
      'elif [ "$FORCE_TWO_RENAME" != "1" ] && mv --exchange --help >/dev/null 2>&1; then',
      'elif mv --exchange --help >/dev/null 2>&1; then',
    );
    writeFileSync(join(sb.repo, "scripts", "build.sh"), mutated);
    const gutted = await runBuild(sb, "1");
    assert.equal(gutted.code, 0, `削弱注入后构建仍应成功，实际 exit=${gutted.code}`);
    assert.match(
      gutted.out,
      EXCHANGE_RE,
      "移除注入条件后，同一 BUILD_FORCE_TWO_RENAME=1 调用必须回到 exchange 路径 —— " +
        "这正是 B 中「不出现 exchange」断言的判别力来源（改坏即红）",
    );
    assert.doesNotMatch(gutted.err, FORCE_WARN_RE, "移除注入条件后不得再出现注入告警");
    assert.equal(treeManifest(distDir), normalManifest, "削弱注入不应改变产物（对照只为钉住判别力）");
  } finally {
    cleanupSandbox(sb);
  }
});
