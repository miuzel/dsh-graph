/**
 * g-312 判据 4：dist 生成物新鲜度断言 —— 把「改完必须 build」从文字纪律变成机器断言
 *
 * 为什么需要：本仓库 36/68 个测试直接读 `dist/`（指南、纪律、i18n、client bundle），
 * 而「改完必须 build」此前**纯靠文字纪律、零断言**——源改了不重建，测试可能「全绿」
 * 但新规则根本不在产物里，属于静默失效。本套件是 g-312「以测试断言替代散文证据」的
 * 示范性重构：散文条目换成可执行的断言。
 *
 * 三族检查（全部只读仓库，绝不改动任何源文件）：
 *  A. 逐字复制族 —— 逐条解析 `scripts/build.sh` 的 `cp` / `cp -r` 行，断言 dist 侧与源
 *     逐字节一致（含 prompts 目录的逐文件比对与「产物里多出文件」）；
 *  B. 生成族 —— `dist/package.json` 由 `dsh-graph-host/package.json` 变换而来，断言两者
 *     除 scripts/main/exports 外逐字段一致（源改版本号不重建必红）；
 *  C. 编译/拼接族 —— `core/*.ts → dist/core/*.js`、`lib/client/*.js → dist/lib/client.js`
 *     无法逐字节比对，改为断言**源文件 mtime 不得新于产物**（手改源不重建必红）。
 *
 * 负向对照（「改坏即红」）全部在 tmp 沙箱里用**真实文件名与真实 pair 列表**重放：
 * 把真实文件复制成镜像目录 → 只改镜像里的源 → 断言检查器报出漂移 → 再断言真实仓库
 * 文件逐字节未变（证明负向对照是 hermetic 的，不会污染工作树）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
const buildScriptPath = join(repoRoot, "scripts", "build.sh");
const BUILD_HINT = "源与 dist 不一致：请先运行 `bash scripts/build.sh` 再跑测试（dist/ 是生成物，禁止手改）";

interface FilePair {
  source: string;
  target: string;
}

interface DirPair {
  source: string;
  target: string;
}

/**
 * 从 build.sh 逐行解析复制清单——清单是**构建脚本自己**的，测试不维护第二份副本；
 * 新增一条 `cp` 即自动纳入新鲜度检查。解析结果数量做下限校验，防止正则失效后「零 pair 全绿」。
 */
function parseBuildCopyPlan(buildScript: string): { files: FilePair[]; dirs: DirPair[] } {
  const files: FilePair[] = [];
  const dirs: DirPair[] = [];
  for (const line of buildScript.split("\n")) {
    const match = /^cp\s+(-r\s+)?(\S+)\s+(\S+)\s*$/.exec(line.trim());
    if (!match) continue;
    const [, recursive, source, target] = match;
    if (recursive) dirs.push({ source, target });
    else files.push({ source, target });
  }
  return { files, dirs };
}

const copyPlan = parseBuildCopyPlan(readFileSync(buildScriptPath, "utf8"));

/** 列出目录下的全部普通文件（相对该目录的路径，排序稳定）。 */
function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${name.name}` : name.name;
    if (name.isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** A 族：逐字复制族漂移清单（缺失 / 内容不一致 / 产物多余）。 */
function collectVerbatimDrift(opts: { repoRoot: string; files: FilePair[]; dirs: DirPair[] }): string[] {
  const drift: string[] = [];
  const compare = (source: string, target: string) => {
    let sourceBuf: Buffer;
    let targetBuf: Buffer;
    try {
      sourceBuf = readFileSync(join(opts.repoRoot, source));
    } catch {
      return;
    }
    try {
      targetBuf = readFileSync(join(opts.repoRoot, target));
    } catch {
      drift.push(`产物缺失：${target}（源 ${source}）`);
      return;
    }
    if (!sourceBuf.equals(targetBuf)) drift.push(`内容不一致：${target} != ${source}`);
  };
  for (const pair of opts.files) compare(pair.source, pair.target);
  for (const dir of opts.dirs) {
    const sourceFiles = listFiles(join(opts.repoRoot, dir.source));
    for (const rel of sourceFiles) compare(`${dir.source}/${rel}`, `${dir.target}/${rel}`);
    let targetFiles: string[] = [];
    try {
      targetFiles = listFiles(join(opts.repoRoot, dir.target));
    } catch {
      targetFiles = [];
    }
    for (const rel of targetFiles) {
      if (!sourceFiles.includes(rel)) drift.push(`产物多余（源已无此文件）：${dir.target}/${rel}`);
    }
  }
  return drift;
}

/** B 族：dist/package.json 与源 package.json 的字段级漂移（scripts 应被移除，main/exports 应被补上）。 */
function collectPackageDrift(repoRoot: string): string[] {
  const source = JSON.parse(readFileSync(join(repoRoot, "dsh-graph-host", "package.json"), "utf8")) as Record<string, unknown>;
  const built = JSON.parse(readFileSync(join(repoRoot, "dist", "package.json"), "utf8")) as Record<string, unknown>;
  const drift: string[] = [];
  if ("scripts" in built) drift.push("dist/package.json 不应再含 scripts（build.sh 会删除）");
  if (built.main !== "index.js") drift.push(`dist/package.json main 应为 index.js，实际 ${JSON.stringify(built.main)}`);
  const expectedExports = {
    ".": "./index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json",
  };
  if (JSON.stringify(built.exports) !== JSON.stringify(expectedExports)) {
    drift.push(`dist/package.json exports 与构建脚本不一致：${JSON.stringify(built.exports)}`);
  }
  for (const key of Object.keys(source)) {
    if (key === "scripts" || key === "main" || key === "exports") continue;
    if (JSON.stringify(built[key]) !== JSON.stringify(source[key])) {
      drift.push(`dist/package.json 字段 ${key} 与源不一致（源改了不重建必红）：${JSON.stringify(built[key])} != ${JSON.stringify(source[key])}`);
    }
  }
  return drift;
}

/** C 族：源 mtime 新于产物即判为陈旧（严格大于；相等视为刚刚构建，避免文件系统时间戳精度造成假红）。 */
function findStaleArtifacts(repoRoot: string, pairs: FilePair[]): string[] {
  const stale: string[] = [];
  for (const pair of pairs) {
    let sourceStat;
    let targetStat;
    try {
      sourceStat = statSync(join(repoRoot, pair.source));
    } catch {
      continue;
    }
    try {
      targetStat = statSync(join(repoRoot, pair.target));
    } catch {
      stale.push(`产物缺失：${pair.target}（源 ${pair.source}）`);
      continue;
    }
    if (sourceStat.mtimeMs > targetStat.mtimeMs) {
      stale.push(`产物陈旧：${pair.target} 早于源 ${pair.source} 的最近修改`);
    }
  }
  return stale;
}

/** C 族的真实 pair 列表：每个 core/*.ts ↔ dist/core/*.js，以及全部 client 模块 ↔ dist/lib/client.js。 */
function compiledPairs(repoRoot: string): FilePair[] {
  const pairs: FilePair[] = [];
  for (const name of readdirSync(join(repoRoot, "core"))) {
    if (!name.endsWith(".ts")) continue;
    pairs.push({ source: `core/${name}`, target: `dist/core/${name.replace(/\.ts$/, ".js")}` });
  }
  for (const name of readdirSync(join(repoRoot, "dsh-graph-host", "lib", "client"))) {
    if (!name.endsWith(".js")) continue;
    pairs.push({ source: `dsh-graph-host/lib/client/${name}`, target: "dist/lib/client.js" });
  }
  return pairs;
}

test("g-312 判据 4：逐字复制族（build.sh 的 cp 清单）dist 与源逐字节一致", () => {
  // 解析下限校验：清单空掉会让下面的断言变成永真，必须显式防住。
  assert.ok(copyPlan.files.length >= 6, `build.sh 应至少含 6 条 cp 文件拷贝，实际 ${copyPlan.files.length}`);
  assert.equal(copyPlan.dirs.length, 1, "build.sh 应恰含 1 条 cp -r 目录拷贝（prompts）");
  assert.deepEqual(
    copyPlan.files.map((pair) => pair.source).sort(),
    [
      "dsh-graph-host/LICENSE",
      "dsh-graph-host/README.md",
      "dsh-graph-host/cordis.patch.yml",
      "dsh-graph-host/index.js",
      "dsh-graph-host/lib/server-i18n.js",
      "dsh-graph-host/supervisor-guide.en.md",
      "dsh-graph-host/supervisor-guide.zh.md",
    ].sort(),
    "build.sh 的复制清单发生变化时必须同步复核本断言（防止清单被悄悄缩减）",
  );

  const drift = collectVerbatimDrift({ repoRoot, ...copyPlan });
  assert.deepEqual(drift, [], `${BUILD_HINT}\n${drift.join("\n")}`);

  // prompts 目录必须被真的逐文件比对过（不能因为目录不存在而「零检查全绿」）。
  const promptFiles = listFiles(join(repoRoot, "dsh-graph-host", "prompts"));
  assert.ok(promptFiles.length >= 14, `prompts 目录应至少 14 个文件，实际 ${promptFiles.length}`);
});

test("g-312 判据 4：生成族 dist/package.json 与源 package.json 字段一致（版本号改动不重建必红）", () => {
  const drift = collectPackageDrift(repoRoot);
  assert.deepEqual(drift, [], `${BUILD_HINT}\n${drift.join("\n")}`);
  // 版本号一致性是发布红线之一，这里顺带把「源/产物同版本」变成可执行断言。
  const source = JSON.parse(readFileSync(join(repoRoot, "dsh-graph-host", "package.json"), "utf8")) as { version: string };
  const built = JSON.parse(readFileSync(join(repoRoot, "dist", "package.json"), "utf8")) as { version: string };
  assert.equal(built.version, source.version, "dist/package.json version 必须与源一致");
});

test("g-312 判据 4：编译/拼接族源文件 mtime 不得新于产物（手改源不重建必红）", () => {
  const pairs = compiledPairs(repoRoot);
  assert.equal(pairs.filter((pair) => pair.target.startsWith("dist/core/")).length >= 10, true, "core/*.ts 应至少 10 个编译单元");
  assert.equal(pairs.filter((pair) => pair.target === "dist/lib/client.js").length >= 10, true, "client 模块应至少 10 个");
  const stale = findStaleArtifacts(repoRoot, pairs);
  assert.deepEqual(stale, [], `${BUILD_HINT}\n${stale.join("\n")}`);
});

test("g-312 判据 4 负向对照：在 tmp 镜像里手改源不重建，三族检查都必须报红（且真实仓库零改动）", () => {
  const mirror = mkdtempSync(join(tmpdir(), "dsh-graph-g312-freshness-"));
  try {
    // 用**真实 pair 列表**把真实文件复制成镜像：负向对照检查的是同一套检查逻辑与同一份清单。
    for (const pair of copyPlan.files) {
      const from = join(repoRoot, pair.source);
      const to = join(mirror, pair.target);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
      mkdirSync(dirname(join(mirror, pair.source)), { recursive: true });
      cpSync(from, join(mirror, pair.source));
    }
    for (const dir of copyPlan.dirs) {
      cpSync(join(repoRoot, dir.source), join(mirror, dir.source), { recursive: true });
      cpSync(join(repoRoot, dir.target), join(mirror, dir.target), { recursive: true });
    }
    for (const name of readdirSync(join(repoRoot, "dsh-graph-host", "lib", "client"))) {
      if (!name.endsWith(".js")) continue;
      const rel = `dsh-graph-host/lib/client/${name}`;
      mkdirSync(dirname(join(mirror, rel)), { recursive: true });
      cpSync(join(repoRoot, rel), join(mirror, rel));
    }
    // package.json 一族不在 cp 清单里（由 build.sh 的 node -e 变换生成），单独镜像。
    for (const rel of ["dsh-graph-host/package.json", "dist/package.json"]) {
      mkdirSync(dirname(join(mirror, rel)), { recursive: true });
      cpSync(join(repoRoot, rel), join(mirror, rel));
    }

    // 对照 0：未改动的镜像必须零漂移（否则下面的报红可能只是镜像本身不完整）。
    assert.deepEqual(collectVerbatimDrift({ repoRoot: mirror, ...copyPlan }), [], "未改动镜像不应有漂移");
    assert.deepEqual(collectPackageDrift(mirror), [], "未改动镜像的 package.json 不应有漂移");

    // 对照 1：只改镜像里的**源**（真实文件名 supervisor-guide.zh.md），不动产物。
    const mutatedRel = "dsh-graph-host/supervisor-guide.zh.md";
    const realBefore = readFileSync(join(repoRoot, mutatedRel));
    const mutatedPath = join(mirror, mutatedRel);
    writeFileSync(mutatedPath, readFileSync(mutatedPath, "utf8") + "\n<!-- 未重建的空改 -->\n");
    const verbatimDrift = collectVerbatimDrift({ repoRoot: mirror, ...copyPlan });
    assert.deepEqual(
      verbatimDrift,
      [`内容不一致：dist/supervisor-guide.zh.md != dsh-graph-host/supervisor-guide.zh.md`],
      `手改源不重建必须被逐字复制族抓到，实际：${JSON.stringify(verbatimDrift)}`,
    );

    // 对照 2：改镜像里的 package.json 版本号而不重建 → 生成族报红。
    const pkgPath = join(mirror, "dsh-graph-host", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    pkg.version = `${String(pkg.version)}-unrebuilt`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    const packageDrift = collectPackageDrift(mirror);
    assert.equal(packageDrift.length, 1, `改版本号不重建必须被生成族抓到：${JSON.stringify(packageDrift)}`);
    assert.match(packageDrift[0], /字段 version 与源不一致/);

    // 对照 3：把镜像里的源 mtime 推到产物之后 → 编译族报红。
    const stalePair = compiledPairs(repoRoot).find((pair) => pair.target.startsWith("dist/core/"))!;
    mkdirSync(dirname(join(mirror, stalePair.source)), { recursive: true });
    mkdirSync(dirname(join(mirror, stalePair.target)), { recursive: true });
    cpSync(join(repoRoot, stalePair.source), join(mirror, stalePair.source));
    cpSync(join(repoRoot, stalePair.target), join(mirror, stalePair.target));
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(mirror, stalePair.source), future, future);
    const stale = findStaleArtifacts(mirror, [stalePair]);
    assert.equal(stale.length, 1, `源新于产物必须被编译族抓到：${JSON.stringify(stale)}`);
    assert.match(stale[0], /产物陈旧/);

    // 对照 4：负向对照是 hermetic 的——真实仓库文件逐字节未变。
    assert.deepEqual(readFileSync(join(repoRoot, mutatedRel)), realBefore, "负向对照绝不允许改动真实仓库文件");
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
});
