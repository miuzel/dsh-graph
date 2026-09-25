/**
 * core/tests/g348-atomic-build.test.ts
 *
 * g-348 质量判据 1/2/3/5 的自动化守卫：`scripts/build.sh` 必须是**原子发布**，
 * 绝不能再出现「先把活动 dist 抽空、再逐步拷回」的破坏性窗口。
 *
 * 为什么需要（不是理论风险）：旧实现在开头 `rm -rf dist`，而运行中的宿主**每次调用**都从
 * dist/ 现读插件资产（prompts/*.md）。窗口期内宿主报
 * `dsh-graph prompt asset missing or unreadable: guide-hint.zh.md` 并**终止该轮次**，
 * 已实测击杀 g-346 的两个在途 worker attempt（att-001 静默死亡、att-002 turn/end 报同一错误）。
 * 该窗口不需要并发、不需要异常路径 —— 只要「仓库根跑一次正常构建 + 有宿主在运行」就必然出现。
 *
 * 三个断言面（全部在 os.tmpdir() 的 hermetic 沙箱里跑**真实** scripts/build.sh，
 * 绝不触碰仓库 dist/ —— 在测试里构建活动 dist 正是本目标要消除的故障）：
 *
 *  A. 结构性守卫（判据 5）：逐行解析 build.sh，**禁止**对活动 dist 执行 `rm -rf`。
 *  B. 行为性守卫（判据 2，主守卫）：3 个并发读者进程紧循环校验 dist 全树
 *     （缺失 / 尺寸不符 / 内容不符 三级判定），与真实构建同时进行 ≥3 轮 ⇒ 0 次 miss；
 *     一旦有人把 build.sh 改回「rm -rf dist + 就地组装」，同一读者必然观测到 ≥1 次缺失
 *     ⇒ 判别力由「改坏即红」负向对照（C）钉住，而不是把读者写成恒真。
 *  C. 负向对照（判据 2/5）：对 build.sh 文本做**锚点化回退**（每个锚点必须恰好命中一次，
 *     锚点漂移即抛错，绝不静默变成永真），复刻 g-319 起的旧破坏性模式，在同一沙箱里重放
 *     同一读者 ⇒ 结构性守卫与行为性守卫必须**双双变红**。
 *  D. 失败路径（判据 3）：构造一次中途失败的构建（删掉组装清单里的一个源文件）⇒
 *     旧 dist 逐字节完好、`node --check dist/lib/client.js` 仍通过、且不留暂存残留；
 *     成功路径同样不留残留（`.dist-stage.*` / `dist.prev.*` 计数为 0）。
 *
 * 沙箱布局（与真实仓库同构，仅缺 core/tests 等与构建无关的内容）：
 *   <root>/repo/{scripts,core/*.ts,dsh-graph-host,tsconfig.json,package.json,dist,node_modules→}
 *   <root>/read-loop.mjs   并发读者脚本
 *   <root>/reader-<n>/…    每轮每读者的允许内容清单 + 报告
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
const BUILD_SCRIPT = join(repoRoot, "scripts", "build.sh");
const DIST_DIR = join(repoRoot, "dist");

/** 读者全量内容比对的体积上限；超过则只比尺寸（大文件的部分写入必然改变尺寸）。 */
const FULL_READ_LIMIT = 262_144;
/** 每轮并发读者数（判据 2 要求「并发读者」，此处用 3 个独立进程）。 */
const READERS_PER_ROUND = 3;
/** 单轮读者最长时间兜底（防止构建挂住时测试一起挂住）。 */
const READER_MAX_MS = 60_000;

// ============================================================================
// A. 结构性守卫：禁止对活动 dist 执行 rm -rf
// ============================================================================

/** 抽取含 `rm` 的脚本行（`rm` 可能在函数体内，故不要求行首）。 */
function rmLines(script: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  script.split("\n").forEach((raw, index) => {
    const text = raw.trim();
    if (/\brm\s/.test(text)) out.push({ line: index + 1, text });
  });
  return out;
}

/**
 * 该操作数是否指向**活动 dist**（判据 5 明令禁止的破坏性目标）。
 * 允许的暂存/中间目标（$STAGE_DIST、$STAGE_ROOT、$LEGACY_PREV、core-dist、dsh-graph-host/core）
 * 一律不匹配 —— 它们都不是读者会走的路径。
 */
function isLiveDistTarget(operand: string): boolean {
  const token = operand.replace(/^["']|["']$/g, "");
  if (/^\$\{?STAGE/.test(token) || token.includes("STAGE")) return false;
  if (token === "dist" || token === "./dist") return true;
  if (token === "$DIST" || token === "${DIST}" || token === "$REPO_ROOT/dist") return true;
  return false;
}

/** 返回脚本中对活动 dist 执行 rm 的行（空数组 = 合规）。 */
function destructiveDistRemovals(script: string): string[] {
  const bad: string[] = [];
  for (const { line, text } of rmLines(script)) {
    // 一行里可能有多条命令（函数体等）：逐处取 `rm <选项...> <操作数...>`，操作数止于 ; & | }
    const re = /\brm\s+((?:-[^\s]+\s+)*)([^;&|}\n]*)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const operands = match[2]
        .split(/\s+/)
        .filter((token) => token.length > 0 && !token.includes("="));
      if (operands.some(isLiveDistTarget)) {
        bad.push(`build.sh:${line}: ${text}`);
        break;
      }
    }
  }
  return bad;
}

// ============================================================================
// C 的前置：把 build.sh 锚点化回退成 g-319 起的旧破坏性模式
// ============================================================================

/** 恰好命中一次的字面替换；命中 0 次或多次即抛错（防止锚点漂移后对照静默失效）。 */
function replaceOnce(src: string, from: string, to: string): string {
  const parts = src.split(from);
  assert.equal(
    parts.length,
    2,
    `锚点必须恰好命中 1 次（实际 ${parts.length - 1} 次）：${JSON.stringify(from.slice(0, 60))}；` +
      "build.sh 结构已变，请同步更新本负向对照，切勿让它静默失效",
  );
  return parts[0] + to + parts[1];
}

/**
 * 旧模式复刻：产物直接写进活动 dist，且**在编译之前**就 `rm -rf dist`（这正是当年的空窗源）。
 * 复刻后 dist/prompts 要等到组装第 3 步才回来，窗口以秒计。
 */
function revertToLegacyPublish(src: string): string {
  let out = src;
  // 1. 子脚本的产物根/中间目录指回活动 dist（= 旧行为）
  out = replaceOnce(out, 'STAGE_DIST_REL="$STAGE_ROOT_REL/dist"', 'STAGE_DIST_REL="dist"');
  out = replaceOnce(out, 'STAGE_CORE_DIST_REL="$STAGE_ROOT_REL/core-dist"', 'STAGE_CORE_DIST_REL="core-dist"');
  out = replaceOnce(out, 'STAGE_DIST="$STAGE_ROOT/dist"', 'STAGE_DIST="$DIST"');
  // 2. 旧模式第一步：抽空活动 dist（窗口从这里开始）
  out = replaceOnce(out, 'mkdir -p "$STAGE_DIST"', 'rm -rf "$DIST"\nmkdir -p "$DIST"');
  // 3. 组装阶段改回仓库根就地写（源与目标都是真实路径）
  out = replaceOnce(out, 'cd "$STAGE_ROOT"', 'cd "$REPO_ROOT"');
  // 4. 发布步骤整体失效：产物已就地写入，无切换可言
  out = replaceOnce(out, 'if [ ! -e "$DIST" ]; then', "if true; then");
  out = replaceOnce(
    out,
    '# 首次构建：目标不存在，单次 rename 即就位\n  mv "$STAGE_DIST" "$DIST"',
    "# 旧模式：产物已就地写入 dist/\n  :",
  );
  return out;
}

// ============================================================================
// 沙箱
// ============================================================================

const READER_SCRIPT = `// g348 并发读者（由 core/tests/g348-atomic-build.test.ts 生成并驱动）
// argv: <distDir> <specJson> <reportJson> <stopFile> <maxMs>
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [distDir, specJson, reportJson, stopFile, maxMs] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specJson, "utf8"));
const rels = Object.keys(spec);
const deadline = Date.now() + Number(maxMs);
const misses = [];
let reads = 0;
while (Date.now() < deadline) {
  for (const rel of rels) {
    reads++;
    const abs = join(distDir, rel);
    let st;
    try {
      st = statSync(abs);
    } catch (e) {
      if (misses.length < 8) misses.push(rel + " 缺失(" + e.code + ")");
      continue;
    }
    const want = spec[rel];
    if (st.size !== want.size) {
      if (misses.length < 8) misses.push(rel + " 尺寸 " + st.size + "≠" + want.size);
      continue;
    }
    if (want.b64 !== null) {
      let buf;
      try {
        buf = readFileSync(abs);
      } catch (e) {
        if (misses.length < 8) misses.push(rel + " 读取失败(" + e.code + ")");
        continue;
      }
      if (buf.toString("base64") !== want.b64) {
        if (misses.length < 8) misses.push(rel + " 内容不符");
      }
    }
  }
  if (existsSync(stopFile)) break;
}
writeFileSync(reportJson, JSON.stringify({ reads, misses }));
`;

function listFilesRel(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRel(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

interface Sandbox {
  root: string;
  repo: string;
  readerScript: string;
}

/** 构造与真实仓库同构的 hermetic 沙箱（绝不写仓库内任何路径）。 */
function makeSandbox(): Sandbox {
  assert.ok(
    existsSync(join(DIST_DIR, "prompts")),
    "dist/ 不存在或不完整：请先运行 bash scripts/build.sh 再跑测试（dist/ 是生成物，禁止手改）",
  );
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g348-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  cpSync(join(repoRoot, "scripts"), join(repo, "scripts"), { recursive: true });
  cpSync(join(repoRoot, "dsh-graph-host"), join(repo, "dsh-graph-host"), { recursive: true });
  // core/ 只取构建真正需要的 *.ts（tsconfig include 就是 core/*.ts），测试文件不参与构建
  mkdirSync(join(repo, "core"), { recursive: true });
  for (const name of readdirSync(join(repoRoot, "core"))) {
    if (name.endsWith(".ts")) cpSync(join(repoRoot, "core", name), join(repo, "core", name));
  }
  for (const name of ["tsconfig.json", "package.json"]) {
    cpSync(join(repoRoot, name), join(repo, name));
  }
  // 已构建好的 dist：作为「发布前基线」，也是读者校验的旧内容来源
  cpSync(join(repoRoot, "dist"), join(repo, "dist"), { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(repo, "node_modules"), "dir");
  const readerScript = join(root, "read-loop.mjs");
  writeFileSync(readerScript, READER_SCRIPT);
  return { root, repo, readerScript };
}

function cleanupSandbox(sb: Sandbox): void {
  rmSync(sb.root, { recursive: true, force: true });
}

/** 读者允许内容清单：全树（dist 内每个文件），小文件带 base64 全文。 */
function readerSpec(distDir: string): Record<string, { size: number; b64: string | null }> {
  const spec: Record<string, { size: number; b64: string | null }> = {};
  for (const rel of listFilesRel(distDir)) {
    const abs = join(distDir, rel);
    const size = statSync(abs).size;
    spec[rel] = { size, b64: size <= FULL_READ_LIMIT ? readFileSync(abs).toString("base64") : null };
  }
  return spec;
}

/** dist 全树摘要（路径 + 尺寸 + 内容哈希），用于「连续两次构建结果一致」断言。 */
function treeDigest(distDir: string): string {
  const hash = createHash("sha256");
  for (const rel of listFilesRel(distDir)) {
    const body = readFileSync(join(distDir, rel));
    hash.update(`${rel}\u0000${body.length}\u0000`);
    hash.update(body);
  }
  return hash.digest("hex");
}

function spawnWait(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (out += String(chunk)));
    child.on("close", (code) => resolve({ code, out }));
  });
}

function readerReport(path: string): { reads: number; misses: string[] } {
  return JSON.parse(readFileSync(path, "utf8")) as { reads: number; misses: string[] };
}

interface RoundResult {
  buildExit: number | null;
  buildLog: string;
  digestBefore: string;
  digestAfter: string;
  readers: { reads: number; misses: string[] }[];
  misses: string[];
  residue: string[];
}

/**
 * 一轮实测：同一沙箱内启动 3 个读者进程 → 跑真实 `bash scripts/build.sh` → 构建退出后停读者。
 * 读者的允许内容固定为**构建前**快照，故任何「缺失 / 尺寸不符 / 内容不符」都是真实观测。
 */
async function runRound(sb: Sandbox, tag: string, maxMs: number): Promise<RoundResult> {
  const distDir = join(sb.repo, "dist");
  const digestBefore = treeDigest(distDir);
  const specPath = join(sb.root, `spec-${tag}.json`);
  const stopFile = join(sb.root, `stop-${tag}`);
  writeFileSync(specPath, JSON.stringify(readerSpec(distDir)));
  rmSync(stopFile, { force: true });

  const readers: Promise<{ reads: number; misses: string[] }>[] = [];
  for (let i = 0; i < READERS_PER_ROUND; i++) {
    const reportPath = join(sb.root, `report-${tag}-${i}.json`);
    readers.push(
      spawnWait(
        process.execPath,
        [sb.readerScript, distDir, specPath, reportPath, stopFile, String(maxMs)],
        sb.root,
      ).then(() => readerReport(reportPath)),
    );
  }

  const build = spawnWait("bash", ["scripts/build.sh"], sb.repo);
  const settled = await build;
  writeFileSync(stopFile, "");
  const results = await Promise.all(readers);

  const digestAfter = treeDigest(distDir);
  const residue = readdirSync(sb.repo).filter(
    (name) => name.startsWith(".dist-stage.") || name.startsWith("dist.prev."),
  );
  return {
    buildExit: settled.code,
    buildLog: settled.out,
    digestBefore,
    digestAfter,
    readers: results,
    misses: results.flatMap((r) => r.misses),
    residue,
  };
}

// ============================================================================
// 断言
// ============================================================================

test("g-348 判据 5（结构性守卫）：build.sh 不得对活动 dist 执行 rm -rf", () => {
  const script = readFileSync(BUILD_SCRIPT, "utf8");
  const bad = destructiveDistRemovals(script);
  assert.deepEqual(
    bad,
    [],
    "build.sh 对活动 dist 执行了 rm -rf —— 这正是 g-348 的故障根因（宿主读资产会撞空窗）：\n" + bad.join("\n"),
  );
  // 守卫本身必须有判别力：旧模式文本必须被判红（否则它可能只是恒真的空断言）。
  const legacy = revertToLegacyPublish(script);
  const badLegacy = destructiveDistRemovals(legacy);
  assert.equal(
    badLegacy.length,
    1,
    `回退到旧模式必须被结构性守卫抓到 1 处，实际 ${badLegacy.length} 处：${JSON.stringify(badLegacy)}`,
  );
  assert.match(badLegacy[0], /rm -rf "\$DIST"/, `旧模式应被定位到 rm -rf "$DIST"，实际：${badLegacy[0]}`);
});

test("g-348 判据 2（行为性守卫）：3 个并发读者 × 3 轮构建，dist 全树零缺失/零不完整", async (t) => {
  const sb = makeSandbox();
  try {
    const totalReads = { n: 0 };
    for (let round = 1; round <= 3; round++) {
      const r = await runRound(sb, `atomic-${round}`, READER_MAX_MS);
      assert.equal(r.buildExit, 0, `第 ${round} 轮构建应成功，实际 exit=${r.buildExit}\n${r.buildLog.slice(-1500)}`);
      const reads = r.readers.reduce((sum, item) => sum + item.reads, 0);
      totalReads.n += reads;
      t.diagnostic(`evidence: suite=g348-atomic round=${round} readers=${READERS_PER_ROUND} reads=${reads} misses=${r.misses.length} exit=${r.buildExit} residue=${r.residue.length} digestSame=${r.digestAfter === r.digestBefore}`);
      assert.ok(
        reads > 1000,
        `第 ${round} 轮读者读取次数过少（${reads}）—— 读者可能没真正跑起来，断言会失去判别力`,
      );
      assert.deepEqual(
        r.misses,
        [],
        `第 ${round} 轮原子发布期间读者观测到 ${r.misses.length} 次缺失/不完整（应为 0）：\n${r.misses.join("\n")}`,
      );
      // 构建确定性：本轮构建前后的 dist 全树摘要必须一致（判据 4「连续两次构建结果一致」）
      assert.equal(r.digestAfter, r.digestBefore, `第 ${round} 轮构建后 dist 全树与构建前不一致`);
      // 成功路径不留暂存残留（判据 3），且 dist 仍是普通目录（原子互换不改变 dist 的身份）
      assert.deepEqual(r.residue, [], `第 ${round} 轮构建后残留：${r.residue.join(", ")}`);
      assert.ok(statSync(join(sb.repo, "dist")).isDirectory(), "发布后 dist 必须仍是普通目录");
      assert.equal(
        readdirSync(sb.repo).filter((name) => name === "core-dist").length,
        0,
        "构建后仓库根不应残留 core-dist 中间目录",
      );
    }
    assert.ok(totalReads.n > 0, "读者总读取次数必须为正");
  } finally {
    cleanupSandbox(sb);
  }
});

test("g-348 判据 2/5（负向对照，改坏即红）：回退为 rm -rf dist 旧模式 ⇒ 读者必观测到缺失", async (t) => {
  const sb = makeSandbox();
  try {
    const legacy = revertToLegacyPublish(readFileSync(BUILD_SCRIPT, "utf8"));
    writeFileSync(join(sb.repo, "scripts", "build.sh"), legacy);

    const r = await runRound(sb, "legacy", READER_MAX_MS);
    const reads = r.readers.reduce((sum, item) => sum + item.reads, 0);
    t.diagnostic(`evidence: suite=g348-legacy-control readers=${READERS_PER_ROUND} reads=${reads} misses=${r.misses.length} exit=${r.buildExit} sample=${r.misses[0] ?? "none"}`);
    assert.ok(reads > 1000, `负向对照的读者读取次数过少（${reads}）`);
    assert.ok(
      r.misses.length >= 1,
      "把 build.sh 回退成 `rm -rf dist` 旧模式后，同一读者**必须**观测到 ≥1 次缺失" +
        "（否则说明读者没有判别力，判据 2 的「0 次缺失」就成了恒真断言）",
    );
    assert.match(
      r.misses.join("\n"),
      /缺失\(ENOENT\)|尺寸 |内容不符/,
      `负向对照应命中缺失/不完整，实际：${r.misses.join(" | ")}`,
    );
  } finally {
    cleanupSandbox(sb);
  }
});

test("g-348 判据 3（失败路径）：中途失败的构建不动旧 dist、不留暂存残留", async (t) => {
  const sb = makeSandbox();
  try {
    const distDir = join(sb.repo, "dist");
    const digestBefore = treeDigest(distDir);
    const filesBefore = listFilesRel(distDir).length;
    // 让组装阶段的一个源文件消失 ⇒ 构建在组装中途以非 0 退出，此时暂存区已有部分产物
    rmSync(join(sb.repo, "dsh-graph-host", "LICENSE"));

    const settled = await spawnWait("bash", ["scripts/build.sh"], sb.repo);
    assert.notEqual(settled.code, 0, `中途失败的构建应非 0 退出，实际 ${settled.code}\n${settled.out.slice(-800)}`);
    t.diagnostic(`evidence: suite=g348-failure-path exit=${settled.code} files=${filesBefore} intact=${treeDigest(distDir) === digestBefore} residue=${readdirSync(sb.repo).filter((name) => name.startsWith(".dist-stage.")).length}`);

    assert.equal(treeDigest(distDir), digestBefore, "失败的构建必须让旧 dist 逐字节完好");
    assert.equal(listFilesRel(distDir).length, filesBefore, "失败构建后 dist 文件数不应变化");
    assert.ok(existsSync(join(distDir, "prompts", "help.zh.md")), "失败构建后资产仍应可读");
    const checked = await spawnWait(process.execPath, ["--check", join(distDir, "lib", "client.js")], sb.repo);
    assert.equal(checked.code, 0, `失败构建后 node --check dist/lib/client.js 应通过：${checked.out}`);
    assert.deepEqual(
      readdirSync(sb.repo).filter((name) => name.startsWith(".dist-stage.") || name.startsWith("dist.prev.")),
      [],
      "失败路径不得留下暂存残留",
    );
  } finally {
    cleanupSandbox(sb);
  }
});
