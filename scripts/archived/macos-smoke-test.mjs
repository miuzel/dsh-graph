#!/usr/bin/env node
/**
 * dsh-graph macOS 快速验收脚本（发布门禁执行件 · g-359）
 *
 * 背景：本项目此前只有 Windows 门禁执行件 `scripts/win-smoke-test.mjs`（它本身是跨平台的），
 *   macOS 侧没有任何**专检**：`build.sh` 的退化发布路径（`mv` 无 `--exchange` ⇒ 两次 rename）
 *   在 coreutils ≥ 9.6 的机器上永远走不到、长期零覆盖；APFS 默认大小写不敏感对 goal id /
 *   version slug 的别名风险只在脚本注释里标了「未验证」；软链 root 边界（`/tmp` → `/private/tmp`）
 *   也只是文档里的已知限制。
 *
 * 用 Node 实现而不是 `sh`：macOS 自带 bash 是 **3.2**（无 `mapfile`、无关联数组、无 `**`），
 *   用 Node 可完全绕开 bashism，并与既有执行件同栈（同一份 Node 即可跑）。
 *
 * 本脚本只做两件事，**不复制** win-smoke-test.mjs 的任何检查逻辑：
 *   1. 转发 `--tarball / --spec / --path / --static-only / --self-test`（另含
 *      `--port/--profile/--dsh-home/--dsh/--timeout`）给 `scripts/win-smoke-test.mjs`，沿用其 T1–T5；
 *   2. 跑四项 macOS 专检（M1–M4），每项输出 PASS|FAIL|WARN + 判读口径。
 *
 * 四项专检：
 *   M1 退化构建路径   `BUILD_FORCE_TWO_RENAME=1 bash scripts/build.sh` 走两次 rename：
 *                     exit 0 / stderr 告警 / `node --check dist/lib/client.js` OK /
 *                     dist 37 个文件 / 暂存树被清理。**在隔离沙箱副本里跑，绝不碰仓库 dist/**。
 *   M2 APFS 大小写探针 隔离目录里造仅大小写不同的两个 slug ⇒ 检测是否别名（同 inode / 后写覆盖）；
 *                     只报告，不改核心行为（是否要引擎侧防御由负责人决策）。
 *   M3 软链 root 边界  显式传入 `/tmp` 下的 root ⇒ 预期被拒并报 `graph root symlink is not allowed`；
 *                     realpath 后的同类路径（≈ `process.cwd()` 推导）⇒ 预期通过。
 *   M4 Linux-only 假设扫描 扫 `scripts/*.sh`、`scripts/*.mjs`、`core/tests/**` 中的
 *                     `renameat2 / mv -T / readlink -f / stat -c / md5sum / sha256sum /
 *                     sed -i（缺 backup 后缀）/ grep -P / date -d / cp --reflink / mktemp -d（无模板）`
 *                     ⇒ 每命中判「已被回退覆盖」或「隐患」；`scripts/archived/**` 另列（非发布路径，不计门禁）。
 *
 * 用法（在仓库根目录；先 `pnpm install`，M1 需要 `node_modules/.bin/tsc`）：
 *   node scripts/macos-smoke-test.mjs --static-only .          # 秒级：只做静态门禁 + M1–M4
 *   node scripts/macos-smoke-test.mjs --tarball ../dsh-graph-0.16.0.tgz   # 完整门禁（转发 T1–T5）
 *   node scripts/macos-smoke-test.mjs --self-test              # 离线自检（本脚本 + win-smoke）
 *   node scripts/macos-smoke-test.mjs --skip-build             # 跳过 M1（未装依赖时）
 *
 * 结论边界（务必先读）：
 *   - M2/M3 的判定只在 macOS 上才有意义（APFS 默认大小写不敏感、`/tmp`→`/private/tmp` 软链）；
 *     非 darwin 时它们如实降级为 WARN 并说明原因，**不得**读成「macOS 已通过」。
 *   - 转发的 T1–T5 沿用 win-smoke-test.mjs 的既有口径：T1/T2 结论跨平台有效；
 *     T3–T5 在非 win32 上只能证明脚本与代码可跑，**不能替代** Windows 真机结论（发布红线 1）。
 *   - 本脚本的结论**不是**发布放行：真机结论回填位置见 `docs/macos-gate.md`「回填表」。
 *
 * 退出码：0=无失败项且转发的执行件通过；1=有失败项；其余=转发执行件的退出码（2=用法错误）。
 * 设计约束：纯 Node（无第三方依赖）、只写临时目录、不自动打开浏览器、失败也跑完剩余检查后再统一出结论。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const IS_DARWIN = process.platform === "darwin";
/** `dist/` 应有文件数（与 M1 / g-359 机器测试 / g-348 判据一致）。 */
const DIST_FILE_COUNT = 37;
/** win-smoke-test.mjs 的注入告警（M1 用）。 */
const FORCE_WARN_RE = /BUILD_FORCE_TWO_RENAME=1/;
/** 软链 root 被拒的权威文案（core/root.ts rejectSymlinkRoot）。 */
const SYMLINK_ROOT_MSG = "graph root symlink is not allowed";
/** 本文件（扫描 M4 时的唯一豁免：模式定义表自身必然含这些字面量）。 */
const SELF_FILE = basename(fileURLToPath(import.meta.url));

const LEVEL_TAG = { PASS: "[ OK ]", FAIL: "[FAIL]", WARN: "[WARN]", INFO: "[info]", SKIP: "[skip]" };
const results = [];

function record(id, name, level, detail = "", criterion = "") {
  results.push({ id, name, level, detail, criterion });
  console.log(`${LEVEL_TAG[level]} ${id} · ${name}${detail ? ` — ${detail}` : ""}`);
  if (criterion) console.log(`        判读口径：${criterion}`);
}

function head(text) {
  console.log(`\n${"=".repeat(72)}\n${text}\n${"=".repeat(72)}`);
}

function rel(from, to) {
  const r = to.startsWith(from) ? to.slice(from.length) : to;
  return r.replace(/^[\\/]/, "");
}

// ---------------------------------------------------------------------------
// M1：退化构建路径（无 mv --exchange ⇒ 两次 rename + 告警）
// ---------------------------------------------------------------------------

/** 与真实仓库同构的 hermetic 沙箱副本（绝不写仓库内任何路径）。 */
function makeBuildSandbox(repo, root) {
  const sbRepo = join(root, "repo");
  mkdirSync(sbRepo, { recursive: true });
  cpSync(join(repo, "scripts"), join(sbRepo, "scripts"), { recursive: true });
  cpSync(join(repo, "dsh-graph-host"), join(sbRepo, "dsh-graph-host"), { recursive: true });
  mkdirSync(join(sbRepo, "core"), { recursive: true });
  for (const name of readdirSync(join(repo, "core"))) {
    if (name.endsWith(".ts")) cpSync(join(repo, "core", name), join(sbRepo, "core", name));
  }
  for (const name of ["tsconfig.json", "package.json"]) cpSync(join(repo, name), join(sbRepo, name));
  cpSync(join(repo, "dist"), join(sbRepo, "dist"), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(sbRepo, "node_modules"), "dir");
  return sbRepo;
}

function listFilesRel(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const r = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRel(dir, r));
    else out.push(r);
  }
  return out.sort();
}

/** dist 全树指纹（路径 + sha256；**不含** mtime）。 */
function treeManifest(dir) {
  const lines = [];
  for (const r of listFilesRel(dir)) {
    lines.push(`${createHash("sha256").update(readFileSync(join(dir, r))).digest("hex")}  ${r}`);
  }
  return lines.join("\n");
}

function buildResidue(repo) {
  return readdirSync(repo)
    .filter((n) => n.startsWith(".dist-stage.") || n.startsWith("dist.prev.") || n === "core-dist")
    .sort();
}

const M1_CRITERION =
  "PASS = 注入构建 exit 0 且 stderr 出现退化路径告警 且 `node --check dist/lib/client.js` OK " +
  `且 dist 恰 ${DIST_FILE_COUNT} 个文件 且无 .dist-stage./dist.prev./core-dist 残留；` +
  "任一不满足即 FAIL（这条路径就是 macOS/BSD 与 coreutils<9.6 用户实际走的发布路径）。";

function checkDegenerateBuild(opt, repo, tmpRoot) {
  const id = "M1";
  const name = "退化构建路径（BUILD_FORCE_TWO_RENAME=1 ⇒ 两次 rename）";
  if (opt.skipBuild) {
    record(id, name, "WARN", "已用 --skip-build 跳过", M1_CRITERION);
    return;
  }
  if (!existsSync(join(repo, "dist", "prompts"))) {
    record(id, name, "WARN", `未找到 ${join(repo, "dist", "prompts")}：请先 \`pnpm build\``, M1_CRITERION);
    return;
  }
  if (!existsSync(join(repo, "node_modules", ".bin", "tsc"))) {
    record(id, name, "WARN", "未找到 node_modules/.bin/tsc：请先在仓库根 `pnpm install`", M1_CRITERION);
    return;
  }

  const sbRepo = makeBuildSandbox(repo, tmpRoot);
  const baselineManifest = treeManifest(join(sbRepo, "dist"));
  const run = spawnSync("bash", ["scripts/build.sh"], {
    cwd: sbRepo,
    env: { ...process.env, BUILD_FORCE_TWO_RENAME: "1" },
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = run.stdout ?? "";
  const err = run.stderr ?? "";
  const distDir = join(sbRepo, "dist");
  const files = existsSync(distDir) ? listFilesRel(distDir) : [];
  const syntax = spawnSync(process.execPath, ["--check", join(distDir, "lib", "client.js")], { encoding: "utf8" });
  const residue = buildResidue(sbRepo);
  const sameTree = files.length > 0 ? treeManifest(distDir) === baselineManifest : false;

  const problems = [];
  if (run.status !== 0) problems.push(`exit=${run.status}`);
  if (!FORCE_WARN_RE.test(err)) problems.push("stderr 未出现退化路径告警");
  if (syntax.status !== 0) problems.push(`node --check 失败: ${(syntax.stderr || "").split("\n")[0]}`);
  if (files.length !== DIST_FILE_COUNT) problems.push(`dist 文件数 ${files.length}≠${DIST_FILE_COUNT}`);
  if (residue.length > 0) problems.push(`残留 ${residue.join(",")}`);

  const detail =
    `exit=${run.status} warn=${FORCE_WARN_RE.test(err)} check=${syntax.status} files=${files.length} ` +
    `sameTree=${sameTree} residue=${residue.length}`;
  if (problems.length > 0) {
    record(id, name, "FAIL", `${problems.join(" / ")}（${detail}）`, M1_CRITERION);
    console.error("----- 构建输出尾部 -----\n" + (out + err).split(/\r?\n/).slice(-15).join("\n") + "\n-----------------------");
    return;
  }
  record(id, name, "PASS", detail, M1_CRITERION);
  if (!sameTree) {
    record(
      id,
      `${name}（附带观察）`,
      "WARN",
      "本次构建产物与仓库现有 dist/ 不一致 —— dist/ 可能已过期（不代表退化路径有问题）",
      "该观察不参与门禁判定：仓库 dist/ 允许是旧构建；不一致时请先 `pnpm build` 让基线同步。",
    );
  }
}

// ---------------------------------------------------------------------------
// M2：APFS 大小写不敏感探针
// ---------------------------------------------------------------------------

/**
 * 在 dir 内造仅大小写不同的两个 slug 与两个目录，检测是否互为别名。
 * 纯函数式副作用（只写 dir 内），便于离线自检。
 */
export function probeCaseAliasing(dir) {
  const lower = "v0.16.0-goal-probe";
  const upper = "V0.16.0-GOAL-PROBE";
  writeFileSync(join(dir, lower), "LOWER", "utf8");
  writeFileSync(join(dir, upper), "UPPER", "utf8");
  const fileAliased = readFileSync(join(dir, lower), "utf8") === "UPPER";
  const sameInode = statSync(join(dir, lower)).ino === statSync(join(dir, upper)).ino;
  mkdirSync(join(dir, `${lower}-dir`), { recursive: true });
  const dirAliased = existsSync(join(dir, `${upper}-dir`));
  return { fileAliased, sameInode, dirAliased, aliased: fileAliased || sameInode || dirAliased };
}

const M2_CRITERION =
  "PASS = 大小写敏感（两个仅大小写不同的 slug/id 是不同实体，无别名风险）；" +
  "WARN = 探针**证实别名**（APFS 默认卷即如此）——本项只报告、不改核心行为，" +
  "是否加引擎侧防御由负责人另行决策；FAIL = 探针自身异常。";

function checkCaseSensitivity(opt, tmpRoot) {
  const id = "M2";
  const name = "APFS 大小写探针（仅大小写不同的 slug/id 是否别名）";
  let probe;
  try {
    const dir = mkdtempSync(join(tmpRoot, "case-probe-"));
    probe = probeCaseAliasing(dir);
  } catch (e) {
    record(id, name, "FAIL", `探针异常：${String(e?.message ?? e)}`, M2_CRITERION);
    return;
  }
  const detail = `fileAliased=${probe.fileAliased} sameInode=${probe.sameInode} dirAliased=${probe.dirAliased}`;
  if (probe.aliased) {
    record(
      id,
      name,
      "WARN",
      `本卷大小写**不敏感**：仅大小写不同的 slug/id 会互相别名（${detail}）`,
      M2_CRITERION +
        " 影响面：goal id / version slug 若仅大小写不同，会落到同一实体（后写覆盖前者）。",
    );
  } else {
    record(
      id,
      name,
      "PASS",
      `本卷大小写敏感，无别名（${detail}）${IS_DARWIN ? "" : "；本机非 darwin，APFS 默认卷请以真机结论为准"}`,
      M2_CRITERION,
    );
  }
}

// ---------------------------------------------------------------------------
// M3：软链 root 边界
// ---------------------------------------------------------------------------

/** 载入发布物里的真实实现（不复制其逻辑）；不可用时返回 null。 */
async function loadResolveRoot(repo) {
  const p = join(repo, "dist", "core", "root.js");
  if (!existsSync(p)) return null;
  try {
    const mod = await import(pathToFileURL(p).href);
    return typeof mod.resolveRoot === "function" ? mod.resolveRoot : null;
  } catch {
    return null;
  }
}

const M3_CRITERION =
  "PASS = 显式传入 `/tmp` 下的 root 被拒且报 `graph root symlink is not allowed`，" +
  "同时 realpath 后的同类路径（≈ `process.cwd()` 推导，Node 返回物理路径）解析通过；" +
  "WARN = 本机 `/tmp` 不是软链（Linux 常态）⇒ 该边界在本机不成立，只证明物理路径可解析，**不能**当作 macOS 已验证；" +
  "FAIL = 物理路径也被拒（真实缺陷，会让 macOS 上的会话完全打不开看板）。";

async function checkSymlinkRoot(opt, repo) {
  const id = "M3";
  const name = "软链 root 边界（/tmp 显式 root 被拒 + 物理路径推导通过）";
  const resolveRoot = await loadResolveRoot(repo);
  if (!resolveRoot) {
    record(
      id,
      name,
      "WARN",
      `未找到可载入的 ${join(repo, "dist", "core", "root.js")}：请先 \`pnpm build\``,
      M3_CRITERION,
    );
    return;
  }

  const probeBase = "/tmp";
  let tmpIsSymlink = false;
  try {
    tmpIsSymlink = realpathSync(probeBase) !== probeBase;
  } catch {
    /* /tmp 不存在时按非软链处理 */
  }
  const dir = mkdtempSync(join(probeBase, "dsh-graph-root-probe-"));
  const physical = realpathSync(dir);

  let explicitErr = null;
  try {
    resolveRoot(null, join(dir, "graph"));
  } catch (e) {
    explicitErr = String(e?.message ?? e);
  }
  let derivedErr = null;
  try {
    resolveRoot(null, join(physical, "graph"));
  } catch (e) {
    derivedErr = String(e?.message ?? e);
  }

  const detail = `tmpSymlink=${tmpIsSymlink} explicitRejected=${explicitErr !== null} derivedRejected=${derivedErr !== null}`;
  if (tmpIsSymlink) {
    if (explicitErr === SYMLINK_ROOT_MSG && derivedErr === null) {
      record(id, name, "PASS", detail, M3_CRITERION);
    } else {
      record(
        id,
        name,
        "FAIL",
        `显式 root 拒绝文案=${JSON.stringify(explicitErr)}（期望 ${JSON.stringify(SYMLINK_ROOT_MSG)}）；物理路径=${JSON.stringify(derivedErr)}（期望 null）`,
        M3_CRITERION,
      );
    }
    return;
  }
  if (derivedErr !== null) {
    record(id, name, "FAIL", `物理路径也被拒：${derivedErr}`, M3_CRITERION);
    return;
  }
  record(
    id,
    name,
    "WARN",
    `本机 \`/tmp\` 不是软链（explicitRejected=${explicitErr !== null}）⇒ 该边界在本机不成立（${detail}）`,
    M3_CRITERION,
  );
}

// ---------------------------------------------------------------------------
// M4：Linux-only 假设扫描
// ---------------------------------------------------------------------------

/** 行是否整行注释（`#` / `//` / `*` / `/*` 起始）。 */
export function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("#") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * 「有意样本」区域标记：区域内出现的 Linux-only 字面量是**测试样本**（只做字符串比较，
 * 不执行），不应计入隐患。理由：M4 自身的判别力测试必然要写出这些字面量，否则无从证明
 * 「真隐患必红」。标记在任意文件生效、必须成对出现，且扫描会打印被忽略的处数 —— 不是隐形豁免。
 */
const SCAN_IGNORE_BEGIN = "dsh-macos-gate:ignore-linux-only-probes";
const SCAN_IGNORE_END = "dsh-macos-gate:end-ignore-linux-only-probes";

/** 逐行标记：true = 落在 ignore 区域内（含标记行自身）。 */
export function ignoredLineMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(SCAN_IGNORE_BEGIN)) depth++;
    mask[i] = depth > 0;
    if (lines[i].includes(SCAN_IGNORE_END)) depth = Math.max(0, depth - 1);
  }
  return mask;
}

/**
 * 已由「能力探测 + 回退」覆盖：同文件里含 `mv --exchange --help` 探测。
 * （build.sh 正是这个形态；测试里出现该字面量则表示在断言/复刻该探测。）
 */
function coveredByExchangeProbe(hit) {
  if (/--exchange\s+--help/.test(hit.fileText)) {
    return {
      covered: true,
      why: "同文件含 `mv --exchange --help` 能力探测（不假定 mv 支持该选项），并有两次 rename 回退",
    };
  }
  return {
    covered: false,
    why: "使用 GNU coreutils 专有的 mv 选项，同文件没有能力探测/回退",
    advice: "加 `mv --exchange --help` 探测 + 两次 rename 兜底（build.sh 的现成形态）",
  };
}

/** Linux-only 假设表：检测正则 + 判定函数（返回 { covered, why, advice? }）。 */
export const LINUX_ONLY_PATTERNS = [
  {
    id: "renameat2",
    label: "renameat2(RENAME_EXCHANGE) 系统调用",
    re: /\brenameat2\b/,
    judge: coveredByExchangeProbe,
  },
  {
    id: "mv-exchange",
    label: "GNU mv 专有选项（--exchange / -T）",
    re: /\bmv\s+(?:-T\s+)?--exchange\b|\bmv\s+-T\b/,
    judge: coveredByExchangeProbe,
  },
  {
    id: "readlink-f",
    label: "readlink -f",
    re: /\breadlink\b[^\n]*\s-f\b/,
    judge: () => ({
      covered: false,
      why: "macOS/BSD 的 readlink 没有 -f（GNU 专有）",
      advice: "改用 realpath，或 `cd <dir> && pwd -P`",
    }),
  },
  {
    id: "stat-c",
    label: "stat -c",
    re: /\bstat\b[^\n]*(?:\s|^)-c\b/,
    judge: () => ({
      covered: false,
      why: "macOS/BSD 的 stat 用 -f，不认 GNU 的 -c",
      advice: "改用 stat -f，或统一走 Node fs.statSync",
    }),
  },
  {
    id: "md5sum",
    label: "md5sum",
    re: /\bmd5sum\b/,
    judge: () => ({
      covered: false,
      why: "macOS 没有 md5sum",
      advice: "改用 `md5 -r`，或 Node crypto",
    }),
  },
  {
    id: "sha256sum",
    label: "sha256sum",
    re: /\bsha256sum\b/,
    judge: () => ({
      covered: false,
      why: "macOS 没有 sha256sum（BSD 系只有 shasum / openssl）",
      advice: "改用 `shasum -a 256`，或 Node crypto（win-smoke-test.mjs 就是 Node 实现）",
    }),
  },
  {
    id: "sed-i-no-backup",
    label: "sed -i（未给 backup 后缀）",
    re: /\bsed\b[^\n]*(?:\s|^)-i(?![\w.'"])/,
    judge: () => ({
      covered: false,
      why: "BSD/macOS 的 `sed -i` 必须带 backup 后缀参数，否则直接报错",
      advice: "写成 `sed -i '' 's/x/y/'`，或用临时文件 + mv",
    }),
  },
  {
    id: "grep-P",
    label: "grep -P（PCRE）",
    re: /\bgrep\b[^\n]*\s-[a-zA-Z]*P[a-zA-Z]*\b/,
    judge: () => ({
      covered: false,
      why: "BSD/macOS 的 grep 没有 -P",
      advice: "改用 grep -E，或 Node 正则",
    }),
  },
  {
    id: "date-d",
    label: "date -d",
    re: /\bdate\b[^\n]*(?:\s|^)-d\b/,
    judge: () => ({
      covered: false,
      why: "macOS/BSD 的 date 用 `-j -f` 解析日期，没有 GNU 的 -d",
      advice: "改用 BSD 形式，或 Node Date",
    }),
  },
  {
    id: "cp-reflink",
    label: "cp --reflink",
    re: /\bcp\b[^\n]*--reflink\b/,
    judge: () => ({
      covered: false,
      why: "macOS/BSD 的 cp 没有 --reflink（GNU 专有）",
      advice: "去掉该选项（macOS 可用 clonefile 语义工具，但非本仓库依赖）",
    }),
  },
  {
    id: "mktemp-d-no-template",
    label: "mktemp -d（未给模板）",
    re: /\bmktemp\s+-[a-zA-Z]*d[a-zA-Z]*(?=\s*(?:[;&|)]|$))/,
    judge: () => ({
      covered: false,
      why: "省略模板时默认目录/行为在 GNU 与 BSD/macOS 之间不保证一致",
      advice: '显式写模板：`mktemp -d "${TMPDIR:-/tmp}/xxx.XXXXXX"`',
    }),
  },
];

/**
 * 扫描一批文件，返回全部命中（含判定）。
 * files: [{ path, fileClass: "release"|"test"|"archived", text }]
 * 落在 `dsh-macos-gate:ignore-linux-only-probes` 标记区域内的行被跳过（有意样本，见 ignoredLineMask）。
 */
export function scanLinuxOnlyAssumptions(files) {
  const hits = [];
  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    const ignored = ignoredLineMask(lines);
    for (const def of LINUX_ONLY_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (ignored[i]) continue;
        const text = lines[i];
        if (!def.re.test(text)) continue;
        const hit = {
          id: def.id,
          label: def.label,
          file: f.path,
          fileClass: f.fileClass,
          line: i + 1,
          text: text.trim(),
          comment: isCommentLine(text),
          fileText: f.text,
        };
        // 统一前置：注释/说明文案不可执行，一律判「已覆盖」（模式表无需各自重复这条规则）。
        const verdict = hit.comment
          ? { covered: true, why: "仅出现在注释/说明文案里，不是可执行调用" }
          : def.judge(hit);
        hits.push({ ...hit, covered: verdict.covered, why: verdict.why, advice: verdict.advice ?? "" });
      }
    }
  }
  return hits;
}

/** 收集扫描目标：scripts/*.sh、scripts/*.mjs（顶层）与 core/tests/**（递归）；archived 另列。 */
export function collectScanFiles(repo) {
  const gated = [];
  const archived = [];
  const readAt = (abs, fileClass) => {
    try {
      return { path: rel(repo, abs), fileClass, text: readFileSync(abs, "utf8") };
    } catch {
      return null;
    }
  };
  const scriptsDir = join(repo, "scripts");
  if (existsSync(scriptsDir)) {
    for (const name of readdirSync(scriptsDir)) {
      const abs = join(scriptsDir, name);
      if (!statSync(abs).isFile()) continue;
      if (name === SELF_FILE) continue; // 豁免：模式定义表自身必然含这些字面量（判别力由 --self-test 固化）
      if (!name.endsWith(".sh") && !name.endsWith(".mjs")) continue;
      const f = readAt(abs, "release");
      if (f) gated.push(f);
    }
  }
  const walk = (dir, fileClass, sink) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, fileClass, sink);
      else {
        const f = readAt(abs, fileClass);
        if (f) sink.push(f);
      }
    }
  };
  walk(join(repo, "core", "tests"), "test", gated);
  walk(join(repo, "scripts", "archived"), "archived", archived);
  return { gated, archived };
}

const M4_CRITERION =
  "每命中判「已被回退覆盖」或「隐患」：发布/测试路径（scripts 顶层 + core/tests）里的隐患 ⇒ FAIL；" +
  "archived 脚本只列 INFO（非发布路径，不计门禁）；全为已覆盖 ⇒ PASS。" +
  ` 唯一豁免 ${SELF_FILE} 自身（其模式定义表必然含这些字面量，判别力由 --self-test 固化）。`;

function checkLinuxOnlyAssumptions(repo) {
  const id = "M4";
  const name = "Linux-only 假设扫描";
  const { gated, archived } = collectScanFiles(repo);
  const gatedHits = scanLinuxOnlyAssumptions(gated);
  const archivedHits = scanLinuxOnlyAssumptions(archived);
  const risks = gatedHits.filter((h) => !h.covered);
  const covered = gatedHits.filter((h) => h.covered);

  console.log(`        扫描 ${gated.length} 个文件（scripts 顶层 + core/tests）⇒ 命中 ${gatedHits.length} 处` +
    `（已覆盖 ${covered.length} / 隐患 ${risks.length}）`);
  const ignoredLines = [...gated, ...archived].reduce(
    (n, f) => n + ignoredLineMask(f.text.split(/\r?\n/)).filter(Boolean).length,
    0,
  );
  if (ignoredLines > 0) {
    console.log(`        有意样本区域：跳过 ${ignoredLines} 行（标记 ${SCAN_IGNORE_BEGIN} … ${SCAN_IGNORE_END}）`);
  }
  for (const h of covered) {
    console.log(`        · 已覆盖 ${h.file}:${h.line} [${h.id}] — ${h.why}`);
  }
  for (const h of risks) {
    console.log(`        · 隐患   ${h.file}:${h.line} [${h.id}] — ${h.why}${h.advice ? ` ⇒ ${h.advice}` : ""}`);
  }
  for (const h of archivedHits) {
    console.log(
      `        · archived(不计门禁) ${h.file}:${h.line} [${h.id}] — ${h.covered ? "已覆盖" : "隐患"}：${h.why}` +
        `${!h.covered && h.advice ? ` ⇒ ${h.advice}` : ""}`,
    );
  }

  if (risks.length > 0) {
    record(id, name, "FAIL", `${risks.length} 处隐患（发布/测试路径）：${risks.map((h) => `${h.file}:${h.line} [${h.id}]`).join("; ")}`, M4_CRITERION);
    return;
  }
  if (gatedHits.length === 0) {
    record(id, name, "PASS", `扫描 ${gated.length} 个文件：零命中`, M4_CRITERION);
    return;
  }
  record(
    id,
    name,
    "PASS",
    `命中 ${gatedHits.length} 处全部已被特性探测/回退覆盖（${[...new Set(covered.map((h) => h.id))].join(", ")}）` +
      (archivedHits.length ? `；archived 另 ${archivedHits.length} 处仅列 INFO` : ""),
    M4_CRITERION,
  );
}

// ---------------------------------------------------------------------------
// 转发给 win-smoke-test.mjs（不复制其逻辑）
// ---------------------------------------------------------------------------

/** 把本脚本收到的门禁参数原样转成 win-smoke-test.mjs 的 argv（顺序稳定，便于自检）。 */
export function buildForwardArgs(opt) {
  const args = [];
  const push = (flag, value) => {
    if (value !== undefined && value !== null) args.push(flag, String(value));
  };
  push("--tarball", opt.tarball);
  push("--spec", opt.spec);
  push("--path", opt.path);
  push("--static-only", opt.staticOnly);
  if (opt.selfTest) args.push("--self-test");
  push("--port", opt.port);
  push("--profile", opt.profile);
  push("--dsh-home", opt.dshHome);
  push("--dsh", opt.dsh);
  push("--timeout", opt.timeout);
  return args;
}

function forwardSmoke(opt, repo) {
  const args = buildForwardArgs(opt);
  const script = join(repo, "scripts", "win-smoke-test.mjs");
  if (!existsSync(script)) {
    record("T*", "转发 win-smoke-test.mjs", "WARN", `未找到 ${script}`, "转发失败不改变 M1–M4 的结论。");
    return null;
  }
  if (args.length === 0) {
    record(
      "T*",
      "转发 win-smoke-test.mjs",
      "SKIP",
      "未提供 --tarball/--spec/--path/--static-only/--self-test（只跑 macOS 专检）",
      "完整门禁请加 `--tarball <path>/dsh-graph-<version>.tgz`（或先 `--static-only .` 做秒级预检）。",
    );
    return null;
  }
  head(`转发：node scripts/win-smoke-test.mjs ${args.join(" ")}`);
  const r = spawnSync(process.execPath, [script, ...args], { cwd: repo, stdio: "inherit" });
  const status = r.status ?? 1;
  record(
    "T*",
    `转发 win-smoke-test.mjs（${args.join(" ")}）`,
    status === 0 ? "PASS" : "FAIL",
    `exit=${status}`,
    "T1/T2 结论跨平台有效；T3–T5 在非 win32 上只能证明脚本与代码可跑，不能替代 Windows 真机结论（发布红线 1）。",
  );
  return status;
}

// ---------------------------------------------------------------------------
// --self-test：离线自检（无需网络 / 无需 macOS）
// ---------------------------------------------------------------------------

function selfCheck() {
  head("离线自检（本脚本的转发与扫描判别力）");
  let bad = 0;
  const check = (name, cond) => {
    if (cond) console.log(`[ OK ] ${name}`);
    else {
      console.error(`[FAIL] ${name}`);
      bad++;
    }
  };

  // 1) 参数转发：五个规定选项原样转发
  const onlyTarball = buildForwardArgs({ tarball: "/x/a.tgz" });
  check("--tarball 原样转发", onlyTarball.join(" ") === "--tarball /x/a.tgz");
  const all = buildForwardArgs({
    tarball: "/x/a.tgz", spec: "dsh-graph@1.0.0", path: "/p", staticOnly: "/s", selfTest: true,
    port: "3099", profile: "p", dshHome: "/h", dsh: "npx -y @deepseek-ai/dsh", timeout: "30",
  });
  check(
    "五个规定选项 + 常用选项全部转发",
    ["--tarball", "--spec", "--path", "--static-only", "--self-test", "--port", "--profile", "--dsh-home", "--dsh", "--timeout"].every(
      (flag) => all.includes(flag),
    ),
  );
  check("空参数不产生转发参数", buildForwardArgs({}).length === 0);

  // 2) 扫描器判别力（合成样本：隐患必红、已覆盖不误报、注释不算）
  const badSample = scanLinuxOnlyAssumptions([{ path: "x.sh", fileClass: "release", text: "sha256sum a > b\n" }]);
  check("隐患样本（sha256sum）被判为未覆盖", badSample.length === 1 && badSample[0].covered === false);
  const goodSample = scanLinuxOnlyAssumptions([
    { path: "build.sh", fileClass: "release", text: "elif mv --exchange --help >/dev/null 2>&1; then\n  mv -T --exchange a b\nfi\n" },
  ]);
  check("已有能力探测的 mv --exchange 判为已覆盖", goodSample.length === 2 && goodSample.every((h) => h.covered));
  const cmtSample = scanLinuxOnlyAssumptions([{ path: "b.sh", fileClass: "release", text: "# 用 renameat2 做原子互换\n" }]);
  check("注释里的 renameat2 判为已覆盖", cmtSample.length === 1 && cmtSample[0].covered === true);
  const templateSample = scanLinuxOnlyAssumptions([
    { path: "c.sh", fileClass: "release", text: 'T=$(mktemp -d "${TMPDIR:-/tmp}/x.XXXXXX")\n' },
  ]);
  check("带模板的 mktemp -d 不误报", templateSample.length === 0);
  const noTemplateSample = scanLinuxOnlyAssumptions([{ path: "d.sh", fileClass: "release", text: "T=$(mktemp -d)\n" }]);
  check("无模板的 mktemp -d 判为隐患", noTemplateSample.length === 1 && noTemplateSample[0].covered === false);
  const pcreSample = scanLinuxOnlyAssumptions([{ path: "e.sh", fileClass: "release", text: "grep -P 'x' f\n" }]);
  check("grep -P 判为隐患", pcreSample.length === 1 && pcreSample[0].covered === false);
  const safeGrep = scanLinuxOnlyAssumptions([{ path: "f.sh", fileClass: "release", text: "grep -E 'x' f\n" }]);
  check("grep -E 不误报", safeGrep.length === 0);
  const sedBackup = scanLinuxOnlyAssumptions([{ path: "g.sh", fileClass: "release", text: "sed -i.bak 's/a/b/' f\n" }]);
  check("带 backup 后缀的 sed -i 不误报", sedBackup.length === 0);
  const sedNoBackup = scanLinuxOnlyAssumptions([{ path: "h.sh", fileClass: "release", text: "sed -i 's/a/b/' f\n" }]);
  check("缺 backup 后缀的 sed -i 判为隐患", sedNoBackup.length === 1 && sedNoBackup[0].covered === false);

  // 3) 注释行判定
  check("注释行判定", isCommentLine("  # x") && isCommentLine("// y") && !isCommentLine("echo hi"));

  // 4) 大小写探针：在任一平台上都应给出三个布尔量（本机通常大小写敏感）
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-macos-selftest-"));
  try {
    const probe = probeCaseAliasing(dir);
    check(
      "大小写探针返回三个布尔量且自洽",
      typeof probe.aliased === "boolean" &&
        typeof probe.fileAliased === "boolean" &&
        typeof probe.dirAliased === "boolean" &&
        probe.aliased === (probe.fileAliased || probe.sameInode || probe.dirAliased),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(bad === 0 ? "\n本脚本自检全部通过。" : `\n本脚本自检失败 ${bad} 项。`);
  return bad;
}

// ---------------------------------------------------------------------------
// CLI / 主流程
// ---------------------------------------------------------------------------

function usage(msg) {
  if (msg) console.error(`\n参数错误：${msg}`);
  console.error(
    "\n用法：node scripts/macos-smoke-test.mjs [选项]\n\n" +
    "转发给 win-smoke-test.mjs（沿用其 T1–T5）：\n" +
    "  --tarball <file>     直接验证现成 .tgz（推荐；无需仓库/分支）\n" +
    "  --spec <spec>        从 npm registry 安装并验证\n" +
    "  --path <dir>         从本地源码目录打包后验证\n" +
    "  --static-only <dir>  只跑 T1 静态门禁\n" +
    "  --self-test          离线自检（本脚本 + win-smoke-test.mjs）\n" +
    "  --port/--profile/--dsh-home/--dsh/--timeout   一并转发\n\n" +
    "macOS 专检（M1–M4）：\n" +
    "  --repo <dir>         仓库根（默认本脚本所在目录的上一级）\n" +
    "  --skip-build         跳过 M1（未装 node_modules 时）\n" +
    "  --keep-temp          保留探针临时目录\n" +
    "  --json               额外打印机器可读结果\n",
  );
  process.exit(2);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        tarball: { type: "string" },
        spec: { type: "string" },
        path: { type: "string" },
        "static-only": { type: "string" },
        "self-test": { type: "boolean", default: false },
        port: { type: "string" },
        profile: { type: "string" },
        "dsh-home": { type: "string" },
        dsh: { type: "string" },
        timeout: { type: "string" },
        repo: { type: "string" },
        "skip-build": { type: "boolean", default: false },
        "keep-temp": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (e) {
    usage(e.message);
  }
  const v = parsed.values;
  if (v.help) usage();
  const sources = [v.path && "--path", v.tarball && "--tarball", v.spec && "--spec", v["static-only"] && "--static-only"].filter(Boolean);
  if (sources.length > 1) usage(`${sources.join(" 与 ")} 互斥，只能选一个来源（--self-test 可与它们并存）`);
  return {
    tarball: v.tarball ? resolve(v.tarball) : undefined,
    spec: v.spec,
    path: v.path ? resolve(v.path) : undefined,
    staticOnly: v["static-only"] ? resolve(v["static-only"]) : undefined,
    selfTest: v["self-test"],
    port: v.port,
    profile: v.profile,
    dshHome: v["dsh-home"] ? resolve(v["dsh-home"]) : undefined,
    dsh: v.dsh,
    timeout: v.timeout,
    repo: v.repo ? resolve(v.repo) : join(import.meta.dirname, ".."),
    skipBuild: v["skip-build"],
    keepTemp: v["keep-temp"],
    json: v.json,
  };
}

function printPreamble(repo) {
  head("dsh-graph macOS 门禁（g-359）");
  console.log(`平台：${process.platform} ${process.arch}    Node：${process.version}    ${new Date().toISOString()}`);
  console.log(`仓库：${repo}`);
  console.log(`执行件：scripts/${SELF_FILE}（Node 实现，规避 macOS 自带 bash 3.2 的 bashism）`);
  console.log("");
  console.log("结论边界（务必先读）：");
  console.log("  - M1–M4 为本机专检，任意平台可跑；M2/M3 的判定**只在 macOS 上有意义**");
  console.log("    （APFS 默认大小写不敏感、/tmp→/private/tmp 软链），非 darwin 时如实降级为 WARN。");
  console.log("  - T1–T5 由 scripts/win-smoke-test.mjs 执行（本脚本只转发、不复制其逻辑）：T1/T2 跨平台有效；");
  console.log("    T3–T5 在非 win32 上只能证明脚本与代码可跑，**不能替代** Windows 真机结论（发布红线 1）。");
  console.log("  - 真机结论回填位置：docs/macos-gate.md「回填表」。");
}

function summarize(opt, forwardStatus) {
  head("结论");
  const fails = results.filter((r) => r.level === "FAIL");
  const warns = results.filter((r) => r.level === "WARN");
  const passes = results.filter((r) => r.level === "PASS");
  console.log(`通过 ${passes.length} 项，失败 ${fails.length} 项，告警 ${warns.length} 项。`);
  for (const group of [["失败项", fails], ["告警项", warns]]) {
    const [label, list] = group;
    if (list.length === 0) continue;
    console.log(`\n${label}：`);
    for (const r of list) console.log(`  - ${r.id} · ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  const ownPass = fails.length === 0;
  const pass = ownPass && (forwardStatus === null || forwardStatus === 0);
  console.log(`\nmacOS 专检判定：${ownPass ? "PASS ✅" : "FAIL ❌"}` + (forwardStatus === null ? "（未运行转发的门禁）" : `；转发执行件 exit=${forwardStatus}`));
  if (pass && !IS_DARWIN) {
    console.log("注意：这是在**非 darwin** 上取得的结论。M2/M3 的 macOS 判定未成立，发布门禁仍待 macOS 真机执行。");
  }
  if (pass && IS_DARWIN) {
    console.log("注意：本脚本的 PASS 只覆盖 M1–M4；Windows 真机门禁（T1–T5）仍需在原生 Windows 上单独执行。");
  }

  console.log("\n----- 可复制回传的报告 -----");
  console.log(`dsh-graph macOS 门禁 | 平台=${process.platform}/${process.arch} node=${process.version}`);
  console.log(`仓库=${opt.repo}`);
  console.log(`结果=${pass ? "PASS" : "FAIL"} 通过${passes.length}/失败${fails.length}/告警${warns.length}${forwardStatus === null ? "" : ` 转发exit=${forwardStatus}`}`);
  for (const r of results.filter((x) => x.level === "FAIL" || x.level === "WARN")) {
    console.log(`  ${r.level} ${r.id} ${r.name}${r.detail ? " :: " + r.detail.slice(0, 300) : ""}`);
  }
  console.log("---------------------------");
  if (opt.json) console.log("\n" + JSON.stringify({ pass, forwardStatus, results }, null, 2));
  return { pass, ownPass, fails: fails.length };
}

async function main() {
  const opt = parseCli();
  printPreamble(opt.repo);

  let selfCheckFailures = 0;
  if (opt.selfTest) selfCheckFailures = selfCheck();

  const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-graph-macos-smoke-"));
  try {
    if (!opt.selfTest) {
      checkDegenerateBuild(opt, opt.repo, tmpRoot);
      checkCaseSensitivity(opt, tmpRoot);
      await checkSymlinkRoot(opt, opt.repo);
      checkLinuxOnlyAssumptions(opt.repo);
    }
  } finally {
    if (opt.keepTemp) console.log(`\n保留探针临时目录：${tmpRoot}（--keep-temp）`);
    else rmSync(tmpRoot, { recursive: true, force: true });
  }

  const forwardStatus = forwardSmoke(opt, opt.repo);
  const summary = summarize(opt, forwardStatus);

  if (selfCheckFailures > 0) {
    console.error(`\n本脚本 --self-test 失败 ${selfCheckFailures} 项。`);
    process.exitCode = 1;
    return;
  }
  if (summary.fails > 0) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = forwardStatus === null ? 0 : forwardStatus;
}

const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e) => {
    console.error("\n脚本自身异常：" + (e?.stack || e));
    process.exit(1);
  });
}
