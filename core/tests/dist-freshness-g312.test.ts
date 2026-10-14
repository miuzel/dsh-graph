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
  existsSync,
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
  // g-496：`_merge_prompts_layer` 是个 shell **函数**，函数体内的 `cp "$f" "$dest"` 是
  // 逐文件复制（变量形参，不是真实资产路径）。必须跟踪函数作用域并跳过其内部行，
  // 否则会把 `"$f"` 当成源路径收进清单（清单污染 ⇒ 镜像报 ENOENT）。
  let inMergeFn = false;
  for (const line of buildScript.split("\n")) {
    const trimmed = line.trim();
    // 进入/离开 `_merge_prompts_layer() { ... }` 函数体。
    if (/^_merge_prompts_layer\s*\(\)\s*\{?/.test(trimmed)) { inMergeFn = true; continue; }
    if (inMergeFn) {
      if (trimmed === "}") inMergeFn = false;
      continue;
    }
    const match = /^cp\s+(-r\s+)?(\S+)\s+(\S+)\s*$/.exec(trimmed);
    if (match) {
      const [, recursive, source, target] = match;
      if (recursive) dirs.push({ source, target });
      else files.push({ source, target });
      continue;
    }
    // 提示词资产由 `_merge_prompts_layer` **合并两层**（公共层 `prompts/` +
    // 宿主专属层 `dsh-graph-host/prompts/`）到 `dist/prompts/`，同名冲突 fail-closed。
    // 合并是文件级逐份复制 ⇒ 每次调用展开为「该源目录 → dist/prompts」目录对，
    // **逐字节一致**的检查口径不变（`collectVerbatimDrift` 逐文件比对，两层全覆盖）。
    const merge = /^_merge_prompts_layer\s+"([^"]+)"\s+"([^"]+)"(?:\s+"(?:required|optional)")?/.exec(trimmed);
    if (merge) dirs.push({ source: merge[1], target: "dist/prompts" });
  }
  return { files, dirs };
}

const copyPlan = parseBuildCopyPlan(readFileSync(buildScriptPath, "utf8"));

/** 列出目录下的全部普通文件（相对该目录的路径，排序稳定）。 */
function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  // g-496：宿主专属提示词层允许不存在（DSH 专属资产按内容归属公共层目录），
  // 缺失即视为「本层无文件」，而不是 scandir 抛错。
  if (!existsSync(join(root, prefix))) return out;
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
  // g-496：多个源目录可**合并**进同一目标目录（公共层 prompts/ + 宿主专属层
  // dsh-graph-host/prompts/ → dist/prompts/）。故按目标目录聚合：
  //   · 逐文件比对时，该文件可来自**任一同目标源目录**（取存在的那个）；
  //   · 「产物多余」以**全体源的并集**为基准，不得把另一层资产误判成多余。
  const byTarget = new Map<string, string[]>();
  for (const dir of opts.dirs) {
    const list = byTarget.get(dir.target) ?? [];
    list.push(dir.source);
    byTarget.set(dir.target, list);
  }
  for (const [target, sources] of byTarget) {
    const union = new Set<string>();
    for (const source of sources) {
      for (const rel of listFiles(join(opts.repoRoot, source))) union.add(rel);
    }
    for (const rel of [...union].sort()) {
      // 同一文件可能同时属于两层 —— 合并布局下构建会**拒绝**这种同名冲突，
      // 故此处若真出现同名，逐源比对会各自报「内容不一致」，反而是正确的红。
      for (const source of sources) {
        const srcAbs = join(opts.repoRoot, source, rel);
        if (existsSync(srcAbs)) compare(`${source}/${rel}`, `${target}/${rel}`);
      }
    }
    let targetFiles: string[] = [];
    try {
      targetFiles = listFiles(join(opts.repoRoot, target));
    } catch {
      targetFiles = [];
    }
    for (const rel of targetFiles) {
      if (!union.has(rel)) drift.push(`产物多余（源已无此文件）：${target}/${rel}`);
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
    // g-496：`dsh.promptAssets` 是 build **有意改写**的字段（source → merged 布局标记），
    // 不是「源改了没重建」的漂移面。此处仍**逐字段**核对：除 layout/dir 外其余必须与源一致，
    // 且版本号漂移检测（本用例核心）不受影响 —— 只是不把文档化的构建变换误判为陈旧。
    if (key === "dsh") {
      const srcDsh = (source.dsh ?? {}) as Record<string, unknown>;
      const builtDsh = (built.dsh ?? {}) as Record<string, unknown>;
      for (const dshKey of Object.keys(srcDsh)) {
        if (dshKey === "promptAssets") {
          const srcPa = (srcDsh.promptAssets ?? {}) as Record<string, unknown>;
          const builtPa = (builtDsh.promptAssets ?? {}) as Record<string, unknown>;
          if (builtPa.layout !== "merged") {
            drift.push(`dist/package.json dsh.promptAssets.layout 必须被改写为 merged，实际 ${JSON.stringify(builtPa.layout)}`);
          }
          if (typeof srcPa.layout === "string" && srcPa.layout !== "source") {
            drift.push(`源 dsh.promptAssets.layout 应为 source，实际 ${JSON.stringify(srcPa.layout)}`);
          }
          continue;
        }
        if (JSON.stringify(builtDsh[dshKey]) !== JSON.stringify(srcDsh[dshKey])) {
          drift.push(`dist/package.json dsh.${dshKey} 与源不一致（源改了不重建必红）`);
        }
      }
      continue;
    }
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
  assert.ok(copyPlan.files.length >= 4, `build.sh 应至少含 4 条 cp 文件拷贝，实际 ${copyPlan.files.length}`);
  // g-462：目录拷贝由 1 条（prompts）增至 2 条（+ diagrams，设计哲学图随包发布）。
  // g-496：prompts 不再整目录 `cp -r`，改由 `_merge_prompts_layer` **两次调用**合并两层
  // （公共层 prompts/ + 宿主专属层 dsh-graph-host/prompts/）⇒ 目录对共 3 条（2 层 + diagrams）。
  assert.equal(copyPlan.dirs.length, 3, "build.sh 应恰含 3 条目录来源（公共层 prompts、宿主专属 prompts、diagrams）");
  assert.deepEqual(
    [...new Set(copyPlan.dirs.map((d) => d.source))].sort(),
    ["dsh-graph-host/diagrams", "dsh-graph-host/prompts", "prompts"],
    "build.sh 的目录来源清单发生变化时必须同步复核本断言",
  );
  assert.deepEqual(
    [...new Set(copyPlan.dirs.map((d) => d.target))].sort(),
    ["dist/diagrams", "dist/prompts"],
    "目录拷贝的目标必须与源一一对应（两层合并进同一 dist/prompts）",
  );
  assert.deepEqual(
    copyPlan.files.map((pair) => pair.source).sort(),
    [
      "dsh-graph-host/LICENSE",
      "dsh-graph-host/README.md",
      "dsh-graph-host/cordis.patch.yml",
      "dsh-graph-host/index.js",
      "dsh-graph-host/lib/server-i18n.js",
    ].sort(),
    "build.sh 的复制清单发生变化时必须同步复核本断言（防止清单被悄悄缩减）",
  );

  const drift = collectVerbatimDrift({ repoRoot, ...copyPlan });
  assert.deepEqual(drift, [], `${BUILD_HINT}\n${drift.join("\n")}`);

  // 两层资产必须被真的逐文件比对过（不能因为目录不存在而「零检查全绿」）。
  // g-496：合并后产物含两层全部资产；公共层是**唯一**源码副本，宿主专属层当前为空。
  const publicPromptFiles = listFiles(join(repoRoot, "prompts"));
  assert.ok(publicPromptFiles.length >= 26,
    `公共层 prompts 目录应至少 26 个文件（两层合并后的随包资产全集），实际 ${publicPromptFiles.length}`);
  const publicNames = publicPromptFiles.map((f) => f.split("/").pop()).sort();
  for (const name of ["supervisor-guide.zh.md", "supervisor-guide.en.md", "help.zh.md", "discipline.zh.md"]) {
    assert.ok(publicNames.includes(name), `公共层必须含 ${name}（合并后随包发布）`);
  }
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

test("g-353 判据 3：build-client.sh 的 PARTS 与 lib/client/*.js 一一对应（漏模块被只读检查识别）", () => {
  // 本套件**自身**是只读的：只解析脚本 + 列目录，不执行构建、不改任何文件 —— 它就是纯只读入口
  // `node --test core/tests/dist-freshness-g312.test.ts`（实测运行前后 dist mtime + 全树 hash 不变）。
  // ⚠️ g-408：**`pnpm check:dist` 不是只读入口**（pnpm 的 verifyDepsBeforeRun 会在 run 前隐式
  // install ⇒ prepare 完整构建）。放在本套件里的理由：它必须同时覆盖「产物陈旧」与「漏模块」两族；
  // g-352 的同名断言伴随一次真实临时构建（语义更强但不适合做只读入口），故这里补结构族检查。
  const script = readFileSync(join(repoRoot, "scripts", "build-client.sh"), "utf8");
  const start = script.indexOf("PARTS=(");
  const end = script.indexOf("\n)", start);
  assert.ok(start >= 0 && end > start, "build-client.sh 含 PARTS=(...) 列表");
  const parts = [...script.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(parts.length >= 20, `PARTS 解析下限校验失败（实际 ${parts.length} 项）—— 解析失效会让本断言变永真`);
  const modules = readdirSync(join(repoRoot, "dsh-graph-host", "lib", "client"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => name.slice(0, -3));
  const missing = modules.filter((m) => !parts.includes(m)).sort();
  const extra = parts.filter((p) => !modules.includes(p)).sort();
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    "build-client.sh 的 PARTS 与 lib/client/*.js 必须一一对应（漏模块 ⇒ bundle 内被调用却无定义 ⇒ " +
      `真机 ReferenceError）：漏=[${missing.join(",")}] 多=[${extra.join(",")}]`,
  );
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
    // g-496：目录对可能**多源合并到同一目标**（两层 → dist/prompts）。镜像必须复现
    // 真实构建的合并语义：先把各源目录原样镜像，再把产物目录按 union 重建。
    const dirTargets = [...new Set(copyPlan.dirs.map((d) => d.target))];
    for (const dir of copyPlan.dirs) {
      if (!existsSync(join(repoRoot, dir.source))) continue; // g-496：可选层缺席（见 listFiles）
      cpSync(join(repoRoot, dir.source), join(mirror, dir.source), { recursive: true });
    }
    for (const target of dirTargets) {
      const destDir = join(mirror, target);
      rmSync(destDir, { recursive: true, force: true });
      mkdirSync(destDir, { recursive: true });
      for (const dir of copyPlan.dirs.filter((d) => d.target === target)) {
        const srcDir = join(repoRoot, dir.source);
        if (!existsSync(srcDir)) continue; // g-496：可选层缺席
        for (const f of readdirSync(srcDir)) {
          cpSync(join(srcDir, f), join(destDir, f));
        }
      }
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
    const mutatedRel = "prompts/supervisor-guide.zh.md";
    const realBefore = readFileSync(join(repoRoot, mutatedRel));
    const mutatedPath = join(mirror, mutatedRel);
    writeFileSync(mutatedPath, readFileSync(mutatedPath, "utf8") + "\n<!-- 未重建的空改 -->\n");
    const verbatimDrift = collectVerbatimDrift({ repoRoot: mirror, ...copyPlan });
    assert.deepEqual(
      verbatimDrift,
      [`内容不一致：dist/prompts/supervisor-guide.zh.md != prompts/supervisor-guide.zh.md`],
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
