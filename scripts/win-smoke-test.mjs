#!/usr/bin/env node
/**
 * dsh-graph Windows 快速验收脚本（发布门禁执行件）
 *
 * 背景：本项目长期只在 Linux/WSL2 上开发验证，首个 Windows 用户一装上就撞到
 *   `core/ops.js` 的 POSIX 常量具名导入（`node:constants` 在 Windows 无 O_DIRECTORY），
 *   插件在 Windows 上「完全无法加载」。本脚本把那次事故拆成可复跑的检查项。
 *
 * 适用平台：Windows（主要目标）/ Linux / macOS —— 纯 Node 实现、无第三方依赖、单文件可拷贝。
 *   macOS 注意：脚本会把隔离 DSH_HOME 做 realpath，因为插件的 resolveRoot 会硬拒绝路径中含软链的
 *   root（core/root.ts「graph root symlink is not allowed」），而 macOS 的 /tmp、/var 都是软链
 *   （/tmp→/private/tmp、/var→/private/var）——不做 realpath 会在 macOS 上假失败。
 *   macOS 另有「APFS 默认大小写不敏感」（goal id / version slug 别名）属未验证类。
 *
 * 用法（Windows 上任意目录；本脚本是单文件、无第三方依赖，可单独拷到 Windows 运行）：
 *   node win-smoke-test.mjs --tarball D:\path\dsh-graph-0.11.0-alpha.tgz   # 直接验一个现成 tarball（推荐）
 *   node win-smoke-test.mjs --spec dsh-graph@0.11.0    # 从 npm registry 安装并验证
 *   node win-smoke-test.mjs --path C:\src\dsh-graph\dsh-graph-host   # 从本地源码目录打包后验证
 *   node win-smoke-test.mjs --static-only C:\src\dsh-graph   # 只跑静态门禁（秒级，跨平台，无需网络）
 *   node win-smoke-test.mjs --self-test                      # 离线自检本脚本自身的判定逻辑
 *   node win-smoke-test.mjs --mutation-check                 # 负向对照：定向突变必须让对应检查变红（需已构建 dist）
 *
 * 三种安装来源的区别（重要）：
 *   --tarball / --spec 都是「真实安装」语义：pnpm 会把包解开并**安装它的 dependencies**，
 *   与用户从 registry 安装完全一致，不受包所在磁盘位置影响。
 *   --path 会先 `npm pack --ignore-scripts` 打包再安装（同样是真实安装语义），
 *   因为直接 `plugin add <目录>` 会被 pnpm 处理成 link:，**不会安装该包的依赖**，
 *   而且解析会顺着包上层目录命中开发仓库的 node_modules —— 造成「本地通过、用户机器崩溃」的假通过。
 *
 * 检查分层（T1/T2 的平台敏感性最低，T4/T5 才是 Windows 真正要跑的）：
 *   T1 静态门禁   跨平台：发布包内不得对 POSIX 专有常量做 ESM 具名导入（可直接预测 Windows 崩溃）
 *   T1 台账层     跨平台：产品代码里**所有 OS 相关调用点**逐项登记进覆盖清单（fail-closed，见下）
 *   T2 安装       任意 OS：全新隔离 DSH_HOME + 全新 profile 安装插件成功
 *   T3 核心运行时 平台敏感：直接调用安装后的 core/ops.js 做**完整看板文件系统生命周期**冒烟
 *   T4 实例启动   平台敏感：dsh web 启动，插件树加载无平台错误
 *   T5 REST 冒烟  平台敏感：dsh-graph 路由已注册、看板载荷可读（插件真的 apply 了）
 *
 * g-428：为什么 T3 必须是**清单式全面覆盖**而不是抽样（0.18.0 的漏检教训）
 *   0.18.0 的 Windows 真机 T1–T5 **全绿**，却漏掉了 g-427（**目录形态目标移入版本在 Windows 上必然
 *   EPERM、重试永不收敛、并留下空目标目录**）。根因是**覆盖面**而非判定口径：旧 T3 只调
 *   `init / createGoal / setCriteria / setGoalTags / validate`，看板的文件系统生命周期
 *   （moveGoal / archiveGoal / unarchiveGoal / postponeGoal / 删除 / 附件 / 卡片 / attempts /
 *   事务 persist 失败与重试收敛 / 标签锁与事务锁 / 原子替换与备份回滚）**零覆盖**。
 *   故本件的 T3 扩成「完整生命周期 + 每步盘面断言」，并新增**台账层**（OS 调用点覆盖清单，
 *   未登记即判红）与**可实拍负向对照**（`--mutation-check`：还原 g-427 旧顺序 ⇒ 对应检查必红）。
 *   结论后的「可复制回传的报告」自本版起含一行 `覆盖=台账=<N>项/<M>处命中（忽略<K>行）  T3生命周期=<S>步…`：
 *   回填 Windows 真机结论时必须连同该行一起粘贴（它是「真机到底覆盖了什么」的对账依据）。
 *
 * 台账层（g-428，沿用 M4 既有范式，不另立第二套机制）
 *   - `OS_SITE_PATTERNS`：OS 相关 API 的静态模式表（rename/rmdir/rm/mkdir/chmod/symlink/fsync/
 *     realpath/lstat/stat/fstat/unlink/open/POSIX 常量/原子替换/锁文件/EXDEV/大小写别名/平台分支/
 *     进程存活/路径分隔符/homedir·tmpdir/CRLF/wx 独占/原子写）。
 *   - `OS_SITE_ROWS`：**逐项登记**表（站点 = 文件 + API + 顶层函数名集合 + 命中数），每项给出
 *     「风险面」与「映射」（`ws:<win-smoke 步骤 id>` / `pg:<platform-gate 探针 id>` / `exempt:<理由>`）。
 *   - **未登记项、清单与实现不同步、映射指向不存在的步骤/探针 ⇒ FAIL（fail-closed）**；
 *     有意样本用**成对标记** `dsh-win-os-ledger:ignore-os-sites` … `:end-…` 跳过，并**打印忽略处数**
 *     （不得静默豁免）；扫描面与判定逻辑由 `--self-test` 正反例 + `core/tests/g428-*.test.ts` 结构守卫钉住。
 *
 * 退出码：0=全部通过；1=有失败项；2=用法错误。
 *
 * 设计约束：纯 Node（无第三方依赖）、不改用户真实 DSH_HOME（默认用临时目录）、
 * 不自动打开浏览器、失败也继续跑完剩余检查后统一出结论。
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// 常量：判定表
// ---------------------------------------------------------------------------

/** 已由真实事故坐实：Windows 的 node:constants 没有 O_DIRECTORY。 */
const POSIX_PROVEN_MISSING = new Set(["O_DIRECTORY"]);
/** 高度可疑（libuv 在 Windows 未提供同名常量）——命中只告警，不判失败，避免误杀。 */
const POSIX_LIKELY_MISSING = new Set([
  "O_NOFOLLOW", "O_NOATIME", "O_DIRECT", "O_SYNC", "O_DSYNC", "O_ASYNC",
]);

/** ESM 具名导入：import { A, B } from "node:constants"（命名空间导入不受影响）。 */
const NAMED_CONSTANTS_IMPORT =
  /import\s*\{([^}]*)\}\s*from\s*["']node:constants["']/g;

/** 启动日志里出现即代表插件加载失败的特征串。 */
const FATAL_LOG_PATTERNS = [
  { re: /does not provide an export named/i, why: "ESM 具名导入在 Windows 上不存在（本次事故的原始错误）" },
  { re: /plugin tree failed to load/i, why: "插件树加载失败" },
  { re: /failed to import loader entry/i, why: "loader 条目导入失败" },
  { re: /ERR_MODULE_NOT_FOUND/i, why: "模块解析失败" },
  { re: /Cannot find package/i, why: "包解析失败" },
  { re: /^\s*SyntaxError\b/m, why: "语法/模块实例化错误" },
];

/** 实例就绪标志：`dsh web: http://127.0.0.1:PORT/?token=...` */
const READY_RE = /dsh web:\s*(https?:\/\/\S+)/;

// ---------------------------------------------------------------------------
// 结果收集与输出
// ---------------------------------------------------------------------------

const LEVEL_ORDER = { FAIL: 0, WARN: 1, INFO: 2, PASS: 3, SKIP: 4 };
const results = [];

function record(tier, name, level, detail = "") {
  results.push({ tier, name, level, detail });
  const tag = { PASS: "[ OK ]", FAIL: "[FAIL]", WARN: "[WARN]", INFO: "[info]", SKIP: "[skip]" }[level];
  const line = `${tag} ${tier} · ${name}${detail ? ` — ${detail}` : ""}`;
  (level === "FAIL" ? console.error : console.log)(line);
}

function head(text) {
  console.log(`\n${"=".repeat(72)}\n${text}\n${"=".repeat(72)}`);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const isWin = process.platform === "win32";

function usage(msg) {
  if (msg) console.error(`\n参数错误：${msg}`);
  console.error(
    "\n用法：node win-smoke-test.mjs [选项]\n\n" +
    "  --tarball <file>     直接验证一个现成的 .tgz 安装包（推荐：无需仓库/分支，拷一个文件即可）\n" +
    "  --spec <spec>        从 npm registry 安装（默认 dsh-graph，可写 dsh-graph@0.11.0）\n" +
    "  --path <dir>         从本地源码目录验证（先 npm pack 成 tarball 再安装，指向 dsh-graph-host 或其父目录）\n" +
    "  --port <n>           web 实例端口（默认 3088；被占用时自动顺延）\n" +
    "  --profile <name>     隔离 profile 名（默认 win-smoke）\n" +
    "  --dsh-home <dir>     隔离 DSH_HOME（默认 <%TEMP%>\\dsh-graph-win-smoke-<时间戳>）\n" +
    "  --dsh <cmd>          dsh 启动命令（默认 \"npx -y @deepseek-ai/dsh\"）\n" +
    "  --timeout <sec>      等待实例启动的秒数（默认 120）\n" +
    "  --keep               结束后保留隔离 DSH_HOME（默认删除）\n" +
    "  --static-only <dir>  只跑 T1 静态门禁（POSIX 具名导入 + OS 调用点覆盖清单 + H 系列组合探针）后退出\n" +
    "  --self-test          离线自检（不联网、不安装）\n" +
    "  --mutation-check     负向对照（g-428）：对已构建包的 core/ops.js 做定向突变\n" +
    "                       （还原 g-427 旧顺序 / 只复制不搬迁），断言对应功能检查必红\n" +
    "  --pkg <dir>          --mutation-check 使用的包目录（默认自动定位 dist/）\n" +
    "  --h3-dispatch-json <file>\n" +
    "                       H3 真机/实例事实文件（隔离实例上三条派发路径的 child_id 与错误）；\n" +
    "                       不给则 H3 显式标注「跳过（需真机/实例）」，不冒充通过。\n" +
    "                       等价环境变量：DSH_GATE_H3_DISPATCH_JSON\n" +
    "  --dsh-root <dir>     组合声明来源（DSH 安装目录或其 node_modules），可重复/可逗号分隔；\n" +
    "                       等价环境变量：DSH_GATE_DSH_ROOT\n" +
    "  --json               额外打印机器可读结果\n",
  );
  process.exit(2);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        spec: { type: "string" },
        tarball: { type: "string" },
        path: { type: "string" },
        port: { type: "string" },
        profile: { type: "string" },
        "dsh-home": { type: "string" },
        dsh: { type: "string" },
        timeout: { type: "string" },
        keep: { type: "boolean", default: false },
        "static-only": { type: "string" },
        "self-test": { type: "boolean", default: false },
        "mutation-check": { type: "boolean", default: false },
        "h3-dispatch-json": { type: "string" },
        "dsh-root": { type: "string", multiple: true, default: [] },
        pkg: { type: "string" },
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
  const sources = [v.path && "--path", v.tarball && "--tarball", v.spec && "--spec"].filter(Boolean);
  if (sources.length > 1) usage(`${sources.join(" 与 ")} 互斥，只能选一个安装来源`);
  if (v.pkg && !v["mutation-check"]) usage("--pkg 仅与 --mutation-check 一起使用");
  const h3Json = v["h3-dispatch-json"] ? resolve(v["h3-dispatch-json"]) : null;
  if (h3Json) {
    if (!existsSync(h3Json)) usage(`--h3-dispatch-json 指定的文件不存在：${h3Json}`);
    if (!statSync(h3Json).isFile()) usage(`--h3-dispatch-json 不是文件：${h3Json}`);
  }
  if (v.tarball) {
    const t = resolve(v.tarball);
    if (!/\.tgz$|\.tar\.gz$/i.test(t)) usage(`--tarball 需要 .tgz 文件：${t}`);
    if (!existsSync(t)) usage(`--tarball 指定的文件不存在：${t}`);
    if (!statSync(t).isFile()) usage(`--tarball 不是文件：${t}`);
  }
  return {
    spec: v.spec ?? "dsh-graph",
    tarball: v.tarball ? resolve(v.tarball) : null,
    path: v.path ? resolve(v.path) : null,
    port: v.port ? Number(v.port) : 3088,
    profile: v.profile ?? "win-smoke",
    dshHome: v["dsh-home"] ? resolve(v["dsh-home"]) : null,
    dshCmd: v.dsh ?? "npx -y @deepseek-ai/dsh",
    timeoutSec: v.timeout ? Number(v.timeout) : 120,
    keep: v.keep,
    staticOnly: v["static-only"] ? resolve(v["static-only"]) : null,
    selfTest: v["self-test"],
    mutationCheck: v["mutation-check"],
    pkg: v.pkg ? resolve(v.pkg) : null,
    h3DispatchJson: h3Json,
    dshRoots: (v["dsh-root"] ?? []).flatMap((x) => String(x).split(/[,;]/)).map((x) => x.trim()).filter(Boolean).map((x) => resolve(x)),
    json: v.json,
  };
}

/**
 * 把 `--dsh` 的单串拆成命令 + 参数（允许写多段）。
 *
 * g-475（H6）：从「纯空白拆分」升级为**引号感知**拆分 —— 原实现遇到
 * `"C:\Program Files\node.exe" -y …` 会拆成 `"C:\Program` / `Files\node.exe"` 两段，
 * 在 Windows 上表现为「node.exe 找不到」（mem-9b910064 记录的正是这条坑：`--dsh` 取一个字符串，
 * 需靠引号分组把带空格的路径包起来）。引号内的空白不再断词，引号本身被剥掉；
 * 未闭合的引号按字面处理（保持宽容，不抛错）。既有形态（`npx -y @deepseek-ai/dsh`）逐字不变。
 */
export function splitCmd(cmd) {
  const s = String(cmd ?? "");
  const out = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { out.push(cur); cur = ""; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * Windows 上走 shell（cmd.exe）执行 .cmd 时，Node 不会自动为参数加引号；
 * 含空格/中文的路径（例如放在「我的文档」下的 tarball）会被截断 —— 这里显式加引号。
 */
/** 纯函数形式（便于在非 Windows 上做离线自检）。 */
export function quoteForCmd(args) {
  return args.map((a) =>
    typeof a === "string" && /[\s"&^|<>]/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a);
}

/**
 * DEP0190：`shell: true` 且传 **args 数组**时，Node 会把参数直接拼进命令行（不转义）并发出
 *   DeprecationWarning（`Passing args to a child process with shell option true …`）。
 *   修复口径：需要 shell 的场景（Windows 上的 `npm` / `npx` 等 `.cmd`）把**完整命令行**作为
 *   **单个字符串**交给 shell（`spawnSync(commandLine, { shell: true })`，不传 args）；
 *   其余（含所有内部 node 子进程调用）一律 `shell: false` + args 数组，不做任何字符串拼接。
 *   本函数把「命令 + 参数」拼成一条完整命令行，参数按 cmd.exe 规则加引号（含空格/中文的路径
 *   例如放在「我的文档」下的 tarball 不会被截断）。
 */
export function buildShellCommandLine(cmd, args) {
  return quoteForCmd([cmd, ...args]).join(" ");
}

function runSync(cmd, args, opts = {}) {
  const useShell = opts.shell ?? isWin;
  const base = {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: opts.timeout ?? 600_000,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  };
  // shell 分支：只传完整命令行字符串（不传 args 数组）⇒ 不触发 DEP0190；
  // 非 shell 分支：shell:false + args 数组（内部 node 子进程一律走这里）。
  const r = useShell
    ? spawnSync(buildShellCommandLine(cmd, args), { ...base, shell: true })
    : spawnSync(cmd, args, { ...base, shell: false });
  return {
    code: r.status ?? (r.error ? -1 : 0),
    out: r.stdout ?? "",
    err: r.stderr ?? "",
    error: r.error ? String(r.error.message) : "",
  };
}

function findFreePort(start) {
  for (let p = start; p < start + 20; p++) {
    const ok = spawnSync(process.execPath, ["-e", `
      const net=require('net');const s=net.createServer();
      s.once('error',()=>process.exit(1));
      s.once('listening',()=>s.close(()=>process.exit(0)));
      s.listen(${p},'127.0.0.1');
    `], { timeout: 8000 });
    if (ok.status === 0) return p;
  }
  return start;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// T1 静态门禁：发布包内不得具名导入 POSIX 专有常量
// ---------------------------------------------------------------------------

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 接受「包目录」或「仓库根」；返回包目录。 */
function resolvePackageDir(dir) {
  if (existsSync(join(dir, "core", "ops.js")) || existsSync(join(dir, "index.js"))) return dir;
  const nested = join(dir, "dsh-graph-host");
  if (existsSync(nested)) return nested;
  return dir;
}

/**
 * 把本地包目录打包成 tarball（--ignore-scripts 同时绕过依赖 bash 的 prepack，
 * 后者在原生 Windows 上不可用）。返回 { file, detail }；file 为 null 表示失败。
 */
function packLocalPackage(pkgDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  const r = runSync("npm", ["pack", "--ignore-scripts", "--pack-destination", destDir],
    { cwd: pkgDir, timeout: 300_000 });
  const output = (r.out || "") + "\n" + (r.err || "");
  const lines = output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // npm 的 notice 行形如 "npm notice filename: x.tgz"，也会以 .tgz 结尾；
  // 只接受「整行就是一个文件名」的那一行（无空格）。
  const name = lines.filter((s) => /^[^\s]+\.tgz$/.test(s)).pop();
  if (r.code !== 0 || !name) {
    const errLine = lines.find((l) => /^npm error/.test(l)) ?? lines.slice(-1)[0] ?? `exit=${r.code}`;
    return { file: null, detail: `${errLine}（目录 ${pkgDir}）` };
  }
  const full = join(destDir, basename(name));
  return existsSync(full) ? { file: full, detail: "" } : { file: null, detail: `未找到产物 ${full}` };
}

function scanPosixNamedImports(pkgDir) {
  const files = [];
  const idx = join(pkgDir, "index.js");
  if (existsSync(idx)) files.push(idx);
  const coreDir = join(pkgDir, "core");
  if (existsSync(coreDir)) {
    for (const f of readdirSync(coreDir)) {
      if (f.endsWith(".js")) files.push(join(coreDir, f));
    }
  }
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    NAMED_CONSTANTS_IMPORT.lastIndex = 0;
    let m;
    while ((m = NAMED_CONSTANTS_IMPORT.exec(text)) !== null) {
      const names = m[1]
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      hits.push({ file, names });
    }
  }
  return { files, hits };
}

function tier1Static(pkgDir) {
  const { files, hits } = scanPosixNamedImports(pkgDir);
  if (files.length === 0) {
    record("T1", "扫描发布包 JS", "INFO", `在 ${pkgDir} 未找到 index.js / core/*.js`);
    return;
  }
  const proven = [];
  const likely = [];
  for (const h of hits) {
    const names = h.names.join(", ");
    for (const n of h.names) {
      if (POSIX_PROVEN_MISSING.has(n)) proven.push({ rel: rel(pkgDir, h.file), names });
      else if (POSIX_LIKELY_MISSING.has(n)) likely.push({ rel: rel(pkgDir, h.file), names: n });
    }
  }
  if (proven.length === 0 && likely.length === 0) {
    record("T1", "无 POSIX 专有常量的 ESM 具名导入", "PASS", `已扫描 ${files.length} 个文件`);
  }
  for (const p of proven) {
    record("T1", `具名导入 O_DIRECTORY（Windows 必然崩溃）`, "FAIL",
      `${p.rel}: import { ${p.names} } from "node:constants"`);
  }
  if (likely.length > 0) {
    record("T1", "疑似 POSIX 专有常量具名导入", "WARN",
      likely.map((l) => `${l.rel} → ${l.names}`).join("; ") + "（这些名字在 Windows 的 node:constants 中通常不存在）");
  }
}

function rel(from, to) {
  const r = to.startsWith(from) ? to.slice(from.length) : to;
  return r.replace(/^[\\/]/, "");
}

// ---------------------------------------------------------------------------
// 台账层（g-428）：OS 相关调用点覆盖清单 —— fail-closed，沿用 M4 范式
//
// 与 M4（scripts/platform-smoke-test.mjs 的 Linux-only 假设扫描）同构：静态模式表 +
// 逐条判定 + 成对 ignore 标记 + 打印忽略处数 + --self-test 正反例 + 结构守卫测试。
// 判据只有一条：**产品代码里出现的每一个 OS 相关调用点，都必须在 OS_SITE_ROWS 里登记**，
// 且登记项必须与实现逐字段同步（文件 + API + 顶层函数名集合 + 命中数）；未登记 / 不同步 /
// 映射指向不存在的步骤或探针 ⇒ 判红（fail-closed）。
// ---------------------------------------------------------------------------

/** 有意样本的成对标记（区域内跳过；扫描结束会打印忽略处数，不做隐形豁免）。 */
export const OS_LEDGER_IGNORE_BEGIN = "dsh-win-os-ledger:ignore-os-sites";
export const OS_LEDGER_IGNORE_END = "dsh-win-os-ledger:end-ignore-os-sites";

/** 顶层声明锚点（列 0）：只认 `export/async function NAME` 与 `export const|let|var NAME =`。 */
export const OS_TOP_LEVEL_DECL_RE =
  /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/;

/** 整行注释（与 M4 同口径：`#` / `//` / `*` / `/*` 起始的行不产生命中）。 */
export function isCommentLine(line) {
  const t = String(line ?? "").trimStart();
  return t.startsWith("#") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** 逐行标记：true = 落在成对 ignore 区域内（含标记行自身）。标记不配对即抛错。 */
export function osLedgerIgnoredLineMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] ?? "");
    if (!open && line.includes(OS_LEDGER_IGNORE_BEGIN)) {
      open = true;
      mask[i] = true;
      continue;
    }
    if (open) {
      mask[i] = true;
      if (line.includes(OS_LEDGER_IGNORE_END)) open = false;
    }
  }
  if (open) {
    throw new Error("台账扫描：ignore 区域缺少 " + OS_LEDGER_IGNORE_END + " 收尾标记（拒绝静默豁免）");
  }
  return mask;
}

/**
 * win-smoke 的 T3 步骤 id 全集。
 * 台账里 `ws:<id>` 形式的映射必须命中其一；T3 运行时还会**反查**这些步骤是否真的被执行过
 * （清单里写了、运行时没跑 ⇒ 判红），避免「台账登记了但冒烟根本没覆盖」。
 */
export const WIN_SMOKE_STEP_IDS = Object.freeze([
  "T3.init_create",
  "T3.set_criteria",
  "T3.tags_write",
  "T3.tags_cas_overwrite",
  "T3.tags_cas_conflict",
  "T3.tags_clear",
  "T3.layout_s1_create",
  "T3.layout_s1_to_version",
  "T3.layout_s1_to_standalone",
  "T3.layout_s1_to_backlog",
  "T3.layout_s1_to_standalone_again",
  "T3.cards_own_and_shared",
  "T3.attempts_dir_present",
  "T3.attachments_store_delete",
  "T3.memory_roundtrip",
  "T3.tx_lock_reclaim",
  "T3.tags_lock_stale_reclaim",
  "T3.lifecycle_move_dir_with_extras",
  "T3.lifecycle_move_back_to_version",
  "T3.lifecycle_archive_version_form",
  "T3.lifecycle_unarchive_version_form",
  "T3.lifecycle_postpone",
  "T3.lifecycle_backlog_dir_to_version",
  "T3.delete_fixture_create",
  "T3.failure_nonempty_target",
  "T3.failure_retry_converges",
  "T3.flat_create_and_move",
  "T3.flat_archive_unarchive",
  "T3.dir_delete_archived",
  "T3.flat_archive_delete",
  "T3.locks_and_board_summary",
  "T3.validate",
]);

/** g-427 形态：末级目录搬迁（renameDirInto：目录形态 → 目录形态）。负向对照必须让其中之一必红。 */
export const G427_FORM_STEP_IDS = Object.freeze([
  "T3.layout_s1_to_version",
  "T3.layout_s1_to_standalone",
  "T3.layout_s1_to_backlog",
  "T3.lifecycle_move_dir_with_extras",
  "T3.lifecycle_move_back_to_version",
  "T3.lifecycle_archive_version_form",
  "T3.lifecycle_unarchive_version_form",
  "T3.lifecycle_backlog_dir_to_version",
]);

/** 可引用的 platform-gate 探针 id（判定口径在 scripts/platform-smoke-test.mjs，本件不改）。 */
export const PLATFORM_PROBE_IDS = Object.freeze(["P1", "P2", "P3", "P4.a", "P4.b", "P5", "P6", "M4"]);

/** OS 相关 API 的静态模式表（id → 正则）。新增模式即新增覆盖义务，请连带登记 OS_SITE_ROWS。 */
export const OS_SITE_PATTERNS = Object.freeze([
  { id: "renameSync", re: /(?<![.\w])renameSync\s*\(/ },
  { id: "rmdirSync", re: /(?<![.\w])rmdirSync\s*\(/ },
  { id: "rmSync", re: /(?<![.\w])rmSync\s*\(/ },
  { id: "mkdirSync", re: /(?<![.\w])mkdirSync\s*\(/ },
  { id: "chmodSync", re: /(?<![.\w])(?:chmodSync|fchmodSync)\s*\(/ },
  { id: "symlinkSync", re: /(?<![.\w])(?:symlinkSync|readlinkSync)\s*\(/ },
  { id: "fsyncSync", re: /(?<![.\w])fsyncSync\s*\(/ },
  { id: "realpathSync", re: /(?<![.\w])realpathSync\s*\(/ },
  { id: "lstatSync", re: /(?<![.\w])lstatSync\s*\(/ },
  { id: "statSync", re: /(?<![.\w])statSync\s*\(/ },
  { id: "fstatSync", re: /(?<![.\w])fstatSync\s*\(/ },
  { id: "unlinkSync", re: /(?<![.\w])unlinkSync\s*\(/ },
  { id: "openSync", re: /(?<![.\w])openSync\s*\(/ },
  { id: "posixConstants", re: /\bO_(?:DIRECTORY|NOFOLLOW|EXCL|CREAT|RDONLY|WRONLY|RDWR)\b/ },
  { id: "atomicReplace", re: /(?<![.\w])(?:replaceFileAtomic|syncDirectorySafely|applyModeSafely)\s*\(/ },
  { id: "lockFile", re: /\.tags\.lock|\.lock\.|acquireLock\s*\(|releaseLock\s*\(|reclaimStaleBadLock\s*\(|STALE_BAD_LOCK_MS|heldLocks|lockKey\s*\(|lockAgeMs\s*\(/ },
  { id: "exdev", re: /\bEXDEV\b/ },
  { id: "caseAlias", re: /(?<![.\w])(?:resolveExistingEntry|foldEntryName)\s*\(|isCaseInsensitiveVolumeInjected\s*\(|setCaseInsensitiveVolumeForTesting\s*\(/ },
  { id: "platformBranch", re: /(?<![.\w])(?:isWindows|getPlatform)\s*\(/ },
  { id: "processLiveness", re: /(?<![.\w])isProcessAlive\s*\(|process\.kill\s*\(/ },
  { id: "pathSep", re: /split\(\s*sep\s*\)|\bpath\.sep\b/ },
  { id: "homedirTmpdir", re: /(?<![.\w])(?:homedir|tmpdir)\s*\(/ },
  { id: "crlf", re: /\\r\\n/ },
  { id: "wxCreate", re: /flag:\s*["']wx["']/ },
  { id: "atomicWrite", re: /(?<![.\w])(?:atomicWrite|casWrite)\s*\(/ },
]);

/**
 * 有意**不登记**的 API（显式非目标，避免「为什么 readFileSync 不在清单里」的隐性口径）。
 * 这些 API 无路径/所有权/错误码语义分叉：内容 I/O 由原子写（atomicWrite / atomicReplace）承担，
 * 目录枚举由 caseAlias 的 readdir 权威实现承担，存在性探测不产生平台错误码。
 */
export const OS_SITE_NON_GOALS = Object.freeze([
  { api: "readFileSync / writeFileSync / appendFileSync", why: "内容 I/O；原子性由 atomicWrite / replaceFileAtomic 单列" },
  { api: "readdirSync", why: "目录枚举本身跨平台一致；大小写折叠语义由 caseAlias / resolveExistingEntry 单列" },
  { api: "existsSync", why: "只读存在性探测，不产生平台错误码" },
  { api: "cpSync / copyFileSync", why: "当前实现未使用（一旦使用必须登记，模式表已备 symlinkSync 等同类位）" },
  { api: "chownSync / utimesSync / watch / watchFile", why: "产品代码未使用" },
  { api: "closeSync / readSync / writeSync", why: "fd 操作，无路径语义（其平台分叉已由 openSync / wxCreate 登记）" },
]);

/**
 * 逐项登记的 OS 调用点（**本清单即覆盖契约**）。
 * 行格式：[文件, API, 命中数, 顶层函数名集合, 风险面, 映射]
 * 映射取值：`ws:<win-smoke 步骤 id>` / `pg:<platform-gate 探针 id>`（可逗号组合），
 * 或 `exempt:<理由>`（豁免必须给理由，理由长度不足会被判红）。
 * 生成方式：scripts/win-smoke-test.mjs --self-test 会重扫实现并与本表逐字段对账；
 * 新增/改动产品代码里的 OS 调用即必须同步本表（否则 --static-only 判红）。
 */
const OS_SITE_ROWS = [
  ["core/cache.ts", "statSync", 1, ["computeGraphRevision"],
   "看板缓存新鲜度探测（mtime+size，只读）",
   "exempt:只读探测、无平台分叉，不进 T3 写路径"],
  ["core/events.ts", "atomicReplace", 1, ["appendMemoryEvent"],
   "记忆事件目录 fsync（syncDirectorySafely）",
   "ws:T3.memory_roundtrip,pg:P4.b"],
  ["core/events.ts", "fsyncSync", 2, ["withMemoryLock", "appendMemoryEvent"],
   "记忆锁 lease / memory.jsonl 落盘 fsync",
   "ws:T3.memory_roundtrip,pg:P4.b"],
  ["core/events.ts", "mkdirSync", 2, ["withMemoryLock", "appendMemoryEvent"],
   "记忆目录创建（mkdir 幂等）",
   "ws:T3.memory_roundtrip"],
  ["core/events.ts", "openSync", 2, ["withMemoryLock", "appendMemoryEvent"],
   "记忆锁 wx 独占 / jsonl 追加打开",
   "ws:T3.memory_roundtrip"],
  ["core/events.ts", "processLiveness", 1, ["withMemoryLock"],
   "记忆锁持有者存活探测（Windows EPERM=存活）",
   "ws:T3.memory_roundtrip"],
  ["core/events.ts", "unlinkSync", 2, ["withMemoryLock"],
   "记忆锁清理",
   "ws:T3.memory_roundtrip"],
  ["core/ops.ts", "atomicReplace", 4, ["writeProjectConfig", "atomicWrite", "setGoalTags"],
   "原子替换：项目配置 / 目标文件 / 标签写",
   "ws:T3.tags_write,ws:T3.tags_cas_overwrite,pg:P4.b"],
  ["core/ops.ts", "atomicWrite", 8, ["saveGoal", "writeSupervisorSession", "raiseSeqFloor", "atomicWrite", "storeAttachment", "writeAttemptResults", "refreshGoalResults"],
   "原子写（临时文件 + replaceFileAtomic）",
   "ws:T3.tags_write,ws:T3.init_create,pg:P4.b"],
  ["core/ops.ts", "caseAlias", 3, ["resolveAttachmentPath", "storeAttachment"],
   "附件路径的卷大小写别名解析（g-364）",
   "exempt:需真实大小写不敏感卷或注入；平台语义由 pg:P1 探测，注入复现见 core/tests/g364-*"],
  ["core/ops.ts", "chmodSync", 2, ["setGoalTags"],
   "标签写保留原 mode（Windows 分支跳过 fchmod）",
   "ws:T3.tags_write"],
  ["core/ops.ts", "crlf", 3, ["sanitizeResultsHeaderValue", "writeAttemptResults", "refreshGoalResults"],
   "用户文本 CRLF 归一（纯字符串，无 FS 语义）",
   "exempt:字符串归一、无平台分叉；Windows 真机由 T3 全链路读写间接覆盖"],
  ["core/ops.ts", "fstatSync", 5, ["acquireTagsLock", "releaseTagsLock", "setGoalTags"],
   "锁 / 标签临时文件的 fd 同一性核对",
   "ws:T3.tx_lock_reclaim,ws:T3.tags_write"],
  ["core/ops.ts", "fsyncSync", 1, ["atomicWrite"],
   "原子写前 fsync（落盘保证）",
   "pg:P4.b,ws:T3.tags_write"],
  ["core/ops.ts", "lockFile", 2, ["getTagsLockPaths", "acquireTagsLock"],
   "标签锁路径/获取（目录形态锁 + wx owner）",
   "ws:T3.tags_write,ws:T3.tx_lock_reclaim"],
  ["core/ops.ts", "lstatSync", 16, ["tryLstat", "renameDirInto", "acquireTagsLock", "releaseTagsLock", "setGoalTags"],
   "锁目录 / 目标目录探测（symlink 与目录判定）",
   "ws:T3.tags_write,ws:T3.tx_lock_reclaim,ws:T3.failure_nonempty_target"],
  ["core/ops.ts", "mkdirSync", 23, ["init", "writeHandoff", "raiseSeqFloor", "createGoal", "rebuild", "addCard", "createSharedCard", "convertOwnedToShared", "convertSharedToOwned", "ensureAttachmentsRoot", "resolveAttachmentPath", "startAttempt", "renameDirInto", "moveGoal", "archiveGoal", "unarchiveGoal", "postponeGoal", "acquireTagsLock", "persistReviewRecord"],
   "板 / 目标 / 卡片 / 附件目录创建（幂等）",
   "ws:T3.init_create,ws:T3.cards_own_and_shared,ws:T3.attachments_store_delete"],
  ["core/ops.ts", "openSync", 4, ["atomicWrite", "acquireTagsLock", "setGoalTags"],
   "标签临时文件独占创建（O_EXCL / wx）",
   "ws:T3.tags_write,ws:T3.tags_cas_conflict"],
  ["core/ops.ts", "pathSep", 3, ["storeAttachment", "deleteAttachment", "attachmentProblems"],
   "附件相对路径的 / 归一（split(sep).join('/')）",
   "ws:T3.attachments_store_delete,ws:T3.lifecycle_move_dir_with_extras"],
  ["core/ops.ts", "platformBranch", 3, ["acquireTagsLock", "setGoalTags", "resolveShellTool"],
   "Windows / POSIX 分支：标签锁（文件锁语义）+ shell 工具名的平台回落（g-473；有探针时不走平台）",
   "ws:T3.tags_write,ws:T3.tx_lock_reclaim,exempt:shell 名平台回落仅是无探针时的默认值、无 FS/错误码语义；判定由 T1 派发可用层（静态、跨平台同结论）覆盖，见 docs/platform-gate.md §3.4.6"],
  ["core/ops.ts", "posixConstants", 3, ["acquireTagsLock", "setGoalTags"],
   "POSIX 专有常量（O_DIRECTORY / O_NOFOLLOW）使用点",
   "ws:T3.tags_write"],
  ["core/ops.ts", "processLiveness", 1, ["acquireTagsLock"],
   "标签锁陈旧回收的持有者存活探测",
   "ws:T3.tx_lock_reclaim"],
  ["core/ops.ts", "realpathSync", 8, ["assertNoSymlinkPath", "assertContainedPath", "ensureAttachmentsRoot", "resolveAttachmentPath", "reassertContainedParent", "resolveExistingAttachmentReal", "attachmentProblems"],
   "附件 / root 的 realpath 越界与 symlink 校验",
   "ws:T3.attachments_store_delete"],
  ["core/ops.ts", "renameSync", 11, ["deleteAttachment", "renameDirInto", "moveGoal", "archiveGoal", "unarchiveGoal", "postponeGoal", "acquireTagsLock", "releaseTagsLock", "setGoalTags"],
   "目录/文件搬迁（g-427：NTFS 拒绝用目录替换已存在目录）",
   "ws:T3.lifecycle_move_dir_with_extras,ws:T3.lifecycle_archive_version_form,ws:T3.lifecycle_unarchive_version_form,ws:T3.layout_s1_to_version,ws:T3.attachments_store_delete"],
  ["core/ops.ts", "rmdirSync", 7, ["renameDirInto", "moveGoal", "acquireTagsLock", "releaseTagsLock"],
   "残留空目录清理 / 标签锁隔离目录删除",
   "ws:T3.layout_s1_to_backlog,ws:T3.tx_lock_reclaim"],
  ["core/ops.ts", "rmSync", 18, ["addCard", "convertOwnedToShared", "convertSharedToOwned", "deleteSharedCard", "atomicWrite", "deleteAttachment", "deleteCard", "startAttempt", "deleteGoal", "acquireTagsLock", "setGoalTags"],
   "目标目录删除 / trash 清理 / 失败回滚清理",
   "ws:T3.dir_delete_archived,ws:T3.attachments_store_delete,ws:T3.flat_archive_delete"],
  ["core/ops.ts", "statSync", 6, ["versionSlugDiagnostics", "readAttemptResultsFile", "buildBoardGoalItem", "setGoalTags"],
   "版本诊断 / 结果文件大小 / 标签写前 mode 快照",
   "ws:T3.tags_write,ws:T3.validate"],
  ["core/ops.ts", "unlinkSync", 2, ["releaseTagsLock"],
   "标签锁释放",
   "ws:T3.tags_write,ws:T3.tx_lock_reclaim"],
  ["core/ops.ts", "wxCreate", 2, ["acquireTagsLock", "setGoalTags"],
   "wx 独占创建（锁 owner / 标签临时文件）",
   "ws:T3.tags_write,ws:T3.tx_lock_reclaim"],
  ["core/platform.ts", "atomicReplace", 3, ["replaceFileAtomic", "syncDirectorySafely", "applyModeSafely"],
   "POSIX rename / Windows 备份-替换-回滚（原子替换实现）",
   "pg:P4.b"],
  ["core/platform.ts", "caseAlias", 5, ["isCaseInsensitiveVolumeInjected", "setCaseInsensitiveVolumeForTesting", "foldEntryName", "decideCaseAliasEntry", "resolveExistingEntry"],
   "卷大小写别名解析实现（readdir 权威 + 测试注入；g-477：注入三态纯决策 + 薄 FS 包装）",
   "pg:P1"],
  ["core/platform.ts", "chmodSync", 2, ["applyModeSafely"],
   "POSIX fchmod / chmod（Windows 安全跳过）",
   "ws:T3.tags_write"],
  ["core/platform.ts", "fstatSync", 1, ["verifyFileIdentity"],
   "文件同一性（fd）校验",
   "pg:P4.b"],
  ["core/platform.ts", "fsyncSync", 1, ["syncDirectorySafely"],
   "目录 fsync（Windows 跳过）",
   "pg:P4.b"],
  ["core/platform.ts", "lstatSync", 3, ["resolveExistingEntry", "takeFileIdentity", "verifyFileIdentity"],
   "条目 / 文件身份探测",
   "pg:P1,pg:P4.b"],
  ["core/platform.ts", "openSync", 1, ["syncDirectorySafely"],
   "目录 fd 打开（POSIX 专有语义）",
   "pg:P4.b"],
  ["core/platform.ts", "platformBranch", 8, ["getPlatform", "isWindows", "areSameStat", "replaceFileAtomic", "syncDirectorySafely", "applyModeSafely", "takeFileIdentity"],
   "平台判定单一注入点（含测试注入）",
   "ws:T3.tags_write,pg:P1"],
  ["core/platform.ts", "posixConstants", 8, ["FS_CONSTANTS", "syncDirectorySafely"],
   "FS 常量能力探测与默认回退（Windows 缺失 → 0）",
   "ws:T3.init_create,pg:P4.b"],
  ["core/platform.ts", "processLiveness", 2, ["isProcessAlive"],
   "进程存活探测（EPERM = 存活，保守不抢锁）",
   "ws:T3.tx_lock_reclaim"],
  ["core/platform.ts", "renameSync", 5, ["replaceFileAtomic"],
   "原子替换 / 备份回滚 rename",
   "pg:P4.b"],
  ["core/platform.ts", "unlinkSync", 1, ["replaceFileAtomic"],
   "备份文件清理",
   "pg:P4.b"],
  ["core/root.ts", "pathSep", 1, ["checkIgnoreArgv"],
   "root 相对路径 / 归一",
   "ws:T3.init_create,ws:T3.validate"],
  ["core/root.ts", "realpathSync", 2, ["rejectSymlinkRoot", "safeRealpath"],
   "root symlink 拒绝 / realpath 归一",
   "pg:P2"],
  ["core/root.ts", "statSync", 1, ["getGitMtime"],
   "git 元数据 mtime 探测（根新鲜度）",
   "exempt:仅只读 git mtime 探测，无写路径"],
  ["core/transaction.ts", "atomicReplace", 1, ["atomicWrite"],
   "原子写路径的 replaceFileAtomic 调用",
   "pg:P4.b"],
  ["core/transaction.ts", "atomicWrite", 4, ["atomicWrite", "casWrite", "readModifyWrite"],
   "事务原子写 / CAS 写",
   "pg:P4.b,ws:T3.tags_write"],
  ["core/transaction.ts", "chmodSync", 1, ["reclaimStaleBadLock"],
   "回收 mode 000 坏锁前恢复可读",
   "ws:T3.tx_lock_reclaim"],
  ["core/transaction.ts", "lockFile", 23, ["lockFilePath", "heldLocks", "lockKey", "STALE_BAD_LOCK_MS", "lockAgeMs", "reclaimStaleBadLock", "acquireLock", "releaseLock", "withTx"],
   "事务锁获取 / 释放 / 陈旧回收（隔离 + 身份核对）",
   "ws:T3.tx_lock_reclaim"],
  ["core/transaction.ts", "lstatSync", 4, ["lockAgeMs", "reclaimStaleBadLock", "atomicWrite"],
   "锁年龄 / 隔离锁身份核对",
   "ws:T3.tx_lock_reclaim"],
  ["core/transaction.ts", "processLiveness", 2, ["reclaimStaleBadLock", "acquireLock"],
   "锁持有者存活（EPERM = 存活，绝不误抢）",
   "ws:T3.tx_lock_reclaim"],
  ["core/transaction.ts", "realpathSync", 1, ["lockKey"],
   "锁路径父目录 realpath 归一（heldLocks 键）",
   "ws:T3.tx_lock_reclaim"],
  ["core/transaction.ts", "renameSync", 2, ["reclaimStaleBadLock"],
   "锁隔离 rename（回收 / 还原）",
   "ws:T3.tx_lock_reclaim"],
  ["core/transaction.ts", "rmSync", 3, ["reclaimStaleBadLock", "releaseLock", "atomicWrite"],
   "隔离锁删除 / 临时文件清理",
   "ws:T3.tx_lock_reclaim"],
  ["core/transaction.ts", "wxCreate", 1, ["acquireLock"],
   "锁文件 wx 独占创建",
   "ws:T3.tx_lock_reclaim"],
  ["core/version-lane.ts", "caseAlias", 1, ["caseAliasVersionSlug"],
   "版本泳道 slug 的卷别名解析",
   "pg:P1"],
  ["core/version-lane.ts", "mkdirSync", 1, ["createVersion"],
   "版本目录创建",
   "ws:T3.layout_s1_to_version"],
  ["core/version-lane.ts", "renameSync", 1, ["renameVersion"],
   "版本目录改名（renameVersion）",
   "exempt:版本改名走独立入口、T3 不触发；目录 rename 同 API 语义由 ws:T3.layout_s1_to_version 覆盖"],
  ["core/version-lane.ts", "rmdirSync", 7, ["deleteVersion"],
   "版本目录自底向上删除",
   "exempt:deleteVersion 走独立入口、T3 不触发；rmdir 空目录同 API 语义由 ws:T3.layout_s1_to_backlog 覆盖"],
  ["core/version-lane.ts", "rmSync", 3, ["deleteVersion"],
   "版本删除的文件清理",
   "exempt:deleteVersion 走独立入口、T3 不触发；rm 同 API 语义由 ws:T3.dir_delete_archived 覆盖"],
  ["core/worktree.ts", "atomicWrite", 1, ["writeBoardOwner"],
   "g-451 归属标记原子写（同目录 temp + fsync + rename，复用 core/ops.ts 原语）",
   "pg:P4.b"],
  ["core/worktree.ts", "mkdirSync", 1, ["prepareAttemptWorktree"],
   "worktree 目录创建（.worktrees）",
   "exempt:worktree 管理需 git 仓库，不在看板冒烟范围"],
  ["core/worktree.ts", "pathSep", 1, ["entriesRelPath"],
   "g-437 attempt 真源的未跟踪路径归一（绝对路径 → 仓库根相对）",
   "exempt:纯字符串归一（split(sep).join('/')），无平台分叉；真源采集需 git 仓库，不在看板冒烟范围"],
  ["core/worktree.ts", "realpathSync", 5, ["canonicalPath", "listWorktrees", "cleanWorktree", "collectAttemptGitTruth"],
   "worktree 路径 realpath（软链保护 + g-448 看板归属根比较归一 + g-437 attempt 真源绑定实际工作树）",
   "exempt:同上；软链 root 边界另见 pg:P2"],
  ["dsh-graph-host/index.js", "crlf", 1, ["normalizeForDedup"],
   "去重键的 CRLF 归一",
   "exempt:宿主端字符串归一，无 FS 语义"],
  ["dsh-graph-host/index.js", "mkdirSync", 1, ["apply"],
   "attempts 目录创建",
   "ws:T3.attempts_dir_present"],
  ["dsh-graph-host/index.js", "realpathSync", 4, ["resolveSchemastery", "discoverAttemptWorktrees"],
   "workspace canonical key / worktree 真实路径",
   "exempt:宿主 workspace 归一由 T4/T5 间接覆盖；软链拒绝见 pg:P2"],
  ["dsh-graph-host/index.js", "statSync", 1, ["apply"],
   "文件 mtime 探测（REST 载荷）",
   "exempt:只读探测；REST 读路径由 T5 覆盖"],
// 台账规模**不写死**：行数与命中数由 buildLedgerRow 汇总后运行时打印（`台账=<rows>项/<hits>处命中`），
// 未登记即判红。历史教训：此处曾写死 253 / 257，而实际先后是 255 / 258 ⇒ 一律以运行时报数为准。
];

/** 展开后的清单（含解析过的映射引用）。 */
export function buildLedgerRow([file, api, hits, sites, risk, map]) {
  const parsed = parseLedgerMap(map);
  return {
    file, api, hits, sites: [...sites], risk, map,
    refs: parsed.refs, exempt: parsed.exempt, invalidRef: parsed.invalid,
  };
}
export const OS_SITE_REGISTRY = OS_SITE_ROWS.map(buildLedgerRow);

/** 解析映射串：`ws:X,pg:Y` / `exempt:理由`。返回 {refs, exempt, invalid}。 */
export function parseLedgerMap(map) {
  const raw = String(map ?? "");
  const refs = [];
  let exempt = null;
  let invalid = null;
  for (const token of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (token.startsWith("exempt:")) exempt = token.slice("exempt:".length).trim();
    else if (token.startsWith("ws:")) refs.push({ kind: "ws", id: token.slice(3).trim() });
    else if (token.startsWith("pg:")) refs.push({ kind: "pg", id: token.slice(3).trim() });
    else invalid = token;
  }
  return { refs, exempt, invalid };
}

/** 扫描给定文件集合（{path, text}[]）里的 OS 调用点。返回 {hits, ignoredLines}。 */
export function scanOsCallSites(files) {
  const hits = [];
  let ignoredLines = 0;
  for (const f of files) {
    const lines = String(f.text ?? "").split(/\r?\n/);
    const ignored = osLedgerIgnoredLineMask(lines);
    ignoredLines += ignored.filter(Boolean).length;
    let fn = "(top-level)";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const decl = line.match(OS_TOP_LEVEL_DECL_RE);
      if (decl) fn = decl[1] ?? decl[2];
      if (ignored[i]) continue;
      // ESM 具名导入不是调用点（`import { mkdirSync } from "node:fs"` 由 T1 单独门禁）
      if (/^\s*(?:import|export)\b/.test(line) && /from\s*["']node:/.test(line)) continue;
      if (isCommentLine(line)) continue;
      for (const def of OS_SITE_PATTERNS) {
        if (!def.re.test(line)) continue;
        hits.push({ file: f.path, api: def.id, fn, line: i + 1, text: line.trim() });
      }
    }
  }
  return { hits, ignoredLines };
}

/** 按 (file, api) 归并命中：{count, sites: Map(fn → 命中数)}。 */
export function groupOsSites(hits) {
  const groups = new Map();
  for (const h of hits) {
    const key = h.file + "#" + h.api;
    if (!groups.has(key)) groups.set(key, { file: h.file, api: h.api, count: 0, sites: new Map(), lines: [] });
    const g = groups.get(key);
    g.count += 1;
    g.sites.set(h.fn, (g.sites.get(h.fn) ?? 0) + 1);
    g.lines.push(h.line);
  }
  return groups;
}

/**
 * 台账判据（fail-closed）：未登记 / 清单与实现不同步 / 映射悬空 / 映射串非法 / 清单自身重复。
 * opts.registry 可注入更小的清单（仅供自检夹具使用；默认即全量 OS_SITE_REGISTRY）。
 * 返回 {problems, groups, hits, ignoredLines, scanned}。
 */
export function auditOsSiteLedger(files, opts = {}) {
  const problems = [];
  const registry = opts.registry ?? OS_SITE_REGISTRY;
  const { hits, ignoredLines } = scanOsCallSites(files);
  const groups = groupOsSites(hits);
  const seen = new Set();
  for (const r of registry) {
    const key = r.file + "#" + r.api;
    if (seen.has(key)) problems.push({ kind: "duplicate", key, detail: "清单重复登记 " + key });
    seen.add(key);
    if (!r.risk || String(r.risk).trim().length < 4) {
      problems.push({ kind: "mapping", key, detail: "缺少风险面描述（risk 至少 4 字）" });
    }
    if (r.invalidRef) problems.push({ kind: "mapping", key, detail: "映射串含无法识别的片段：" + r.invalidRef });
    if (r.refs.length === 0 && !r.exempt) {
      problems.push({ kind: "mapping", key, detail: "缺少映射（ws:/pg:）且未给出豁免理由" });
    }
    if (r.exempt && String(r.exempt).length < 8) {
      problems.push({ kind: "mapping", key, detail: "豁免理由过短（应说明为何不覆盖）" });
    }
    for (const ref of r.refs) {
      if (ref.kind === "ws" && !WIN_SMOKE_STEP_IDS.includes(ref.id)) {
        problems.push({ kind: "dangling", key, detail: "映射到不存在的 win-smoke 步骤：" + ref.id });
      }
      if (ref.kind === "pg" && !PLATFORM_PROBE_IDS.includes(ref.id)) {
        problems.push({ kind: "dangling", key, detail: "映射到不存在的 platform-gate 探针：" + ref.id });
      }
    }
  }
  // ① 未登记（红）
  for (const [key, g] of groups) {
    if (!seen.has(key)) {
      const sites = [...g.sites.keys()].join(", ");
      problems.push({
        kind: "unregistered",
        key,
        detail: key + " 命中 " + g.count + " 处（" + sites + "）未登记 —— 请登记进 OS_SITE_ROWS（风险面 + 映射/豁免）",
      });
    }
  }
  // ② 清单与实现不同步（红）
  for (const r of registry) {
    const key = r.file + "#" + r.api;
    const g = groups.get(key);
    if (!g) {
      problems.push({ kind: "stale", key, detail: "清单项已无命中（实现里已消失）—— 请同步 OS_SITE_ROWS" });
      continue;
    }
    if (g.count !== r.hits) {
      problems.push({ kind: "drift", key, detail: "命中数 " + g.count + " ≠ 清单 " + r.hits + "（实现变了，请同步）" });
    }
    const actual = [...g.sites.keys()].sort().join(",");
    const declared = [...r.sites].sort().join(",");
    if (actual !== declared) {
      problems.push({ kind: "drift", key, detail: "顶层函数集合不一致：实现 [" + actual + "] ≠ 清单 [" + declared + "]" });
    }
  }
  // ③ 模式表健康
  const ids = new Set();
  for (const def of OS_SITE_PATTERNS) {
    if (ids.has(def.id)) problems.push({ kind: "pattern", key: def.id, detail: "模式表 id 重复：" + def.id });
    ids.add(def.id);
  }
  return { problems, groups, hits, ignoredLines, scanned: files.length };
}

/** 定位产品源码根（含 core/*.ts 的目录）。找不到返回 null（此时台账判 WARN 而非 PASS）。 */
export function resolveProductSourceRoot(dir) {
  for (const candidate of [dir, dirname(dir)]) {
    const coreDir = join(candidate, "core");
    if (!existsSync(coreDir)) continue;
    let ts = [];
    try { ts = readdirSync(coreDir).filter((n) => n.endsWith(".ts") && statSync(join(coreDir, n)).isFile()); } catch { ts = []; }
    if (ts.length > 0) return candidate;
  }
  return null;
}

/** 台账扫描面：core/*.ts（不含 core/tests）+ dsh-graph-host/index.js + lib/**\/*.js（不含 lib/client）。 */
export function collectProductSourceFiles(sourceRoot) {
  const files = [];
  const coreDir = join(sourceRoot, "core");
  let names = [];
  try { names = readdirSync(coreDir); } catch { names = []; }
  for (const name of names.sort()) {
    if (!name.endsWith(".ts")) continue;
    const abs = join(coreDir, name);
    if (!statSync(abs).isFile()) continue;
    files.push({ path: "core/" + name, text: readFileSync(abs, "utf8") });
  }
  const hostIndex = join(sourceRoot, "dsh-graph-host", "index.js");
  if (existsSync(hostIndex)) files.push({ path: "dsh-graph-host/index.js", text: readFileSync(hostIndex, "utf8") });
  const libDir = join(sourceRoot, "dsh-graph-host", "lib");
  const walk = (dir, prefix) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) {
        if (e.name === "client" || e.name === "node_modules") continue;
        walk(join(dir, e.name), prefix + e.name + "/");
      } else if (e.name.endsWith(".js")) {
        files.push({ path: prefix + e.name, text: readFileSync(join(dir, e.name), "utf8") });
      }
    }
  };
  walk(libDir, "dsh-graph-host/lib/");
  return files;
}

/** 用户可见文案里**裸平台错误码**检测（EPERM/ENOTEMPTY/EBUSY/EACCES）。命中返回该码，否则 null。 */
export const PLATFORM_ERROR_CODES = Object.freeze(["EPERM", "ENOTEMPTY", "EBUSY", "EACCES"]);
export function platformErrorLeak(text) {
  const s = String(text ?? "");
  for (const code of PLATFORM_ERROR_CODES) {
    if (new RegExp("(^|[^A-Za-z0-9_])" + code + "([^A-Za-z0-9_]|$)").test(s)) return code;
  }
  return null;
}

/**
 * 最终盘面总览判据（夹具级负向对照：预置双份 / 残留空目录 / 锁残留 / 诊断事件计数）。
 * 返回问题字符串数组（空数组 = 通过）。
 */
export function judgeBoardSummary(summary) {
  const problems = [];
  const s = summary ?? {};
  const copies = s.copies ?? {};
  for (const [id, n] of Object.entries(copies)) {
    if (Number(n) > 1) problems.push("目标 " + id + " 在板上出现 " + n + " 份（双份）");
  }
  for (const id of s.expectedLive ?? []) {
    if (!copies[id]) problems.push("目标 " + id + " 不在最终盘面上（期望 1 份）");
  }
  for (const id of s.expectedGone ?? []) {
    if (copies[id]) problems.push("目标 " + id + " 已删除却仍在盘面上（" + copies[id] + " 份）");
  }
  for (const d of s.emptyGoalDirs ?? []) problems.push("残留空目标目录：" + d);
  for (const a of s.lockArtifacts ?? []) problems.push("未清理的锁/临时产物：" + a);
  if (s.persistFailed !== undefined && s.persistFailed !== s.persistFailedExpected) {
    problems.push("tx.persist_failed 计数 " + s.persistFailed + " ≠ 期望 " + s.persistFailedExpected);
  }
  if (Array.isArray(s.validate) && s.validate.length > 0) {
    problems.push("validate 非空：" + s.validate.join("; "));
  }
  return problems;
}

/**
 * 失败路径判据（夹具级负向对照：预置非空目标目录 ⇒ 明确业务错误）。
 * obs = {threw, message, expectedPath, sourceIntact, obstacleIntact, persistFailedDelta}
 *
 * g-428 真机现场修正（2026-10-06）：产品文案里的目标位置来自平台 `join()`（Windows 上是反斜杠路径），
 * 而夹具的 `expectedPath` 由 POSIX 拼接得到 ⇒ 裸 `includes` 在真机上恒假，把**正确的**业务错误判成
 * 「未包含目标路径」（v0.19.0-alpha.fix3 真机实测：该步其余子判据全绿，仅此条假红）。
 * 故比对前两侧统一归一化为 `/`；判定意图不变（错误信息必须指明目标位置，缺路径仍判红）。
 */
function posixPath(v) {
  return String(v ?? "").replace(/\\/g, "/");
}

export function judgeExpectedFailure(obs) {
  const problems = [];
  const o = obs ?? {};
  if (!o.threw) problems.push("预置非空目标目录时未报错（应当拒绝覆盖）");
  const leak = platformErrorLeak(o.message);
  if (leak) problems.push("用户可见文案泄漏平台错误码 " + leak);
  if (o.expectedPath && !posixPath(o.message).includes(posixPath(o.expectedPath))) {
    problems.push("错误信息未包含目标路径（应指明目标位置）");
  }
  if (!/已存在|非空|拒绝/.test(String(o.message ?? ""))) {
    problems.push("错误信息缺少明确业务语义（应含「已存在 / 非空 / 拒绝」）");
  }
  if (o.sourceIntact === false) problems.push("失败后源位置被破坏（不留半迁移态失效）");
  if (o.obstacleIntact === false) problems.push("失败后阻碍物被破坏");
  if (o.persistFailedDelta !== 1) problems.push("tx.persist_failed 增量 " + o.persistFailedDelta + "（期望 1：失败可诊断）");
  return problems;
}

/**
 * 定向突变（负向对照）：把已构建包里的 `renameDirInto` 换成缺陷形态。
 *   old-order —— 还原 g-427 旧顺序（先建目标目录再 rename）；POSIX 的 rename 允许用目录替换**空目录**
 *                故在 Linux 上不会自然变红，这里显式模拟 NTFS/MoveFileEx 语义（目标目录已存在即 EPERM），
 *                与 Windows 真机现场一致；
 *   copy-dup  —— 搬迁退化为复制（源与目标同时存在 ⇒ 双份）。
 * 返回 {text, original, mutated} 或 null（形状不匹配时**拒绝**执行，避免对照静默无效）。
 */
export function buildOsJsMutant(source, kind) {
  const text = String(source ?? "");
  const start = text.search(/^function renameDirInto\s*\(/m);
  if (start < 0) return null;
  const rest = text.slice(start);
  const endRel = rest.search(/\n\}\n/);
  if (endRel < 0) return null;
  const end = start + endRel + 3;
  const body = kind === "copy-dup"
    ? [
      'import { cpSync as __g428CpSync } from "node:fs";',
      "function renameDirInto(srcDir, destDir) {",
      "    // g-428 --mutation-check 负向对照：搬迁退化为复制 ⇒ 源与目标同时存在（双份）。",
      "    mkdirSync(dirname(destDir), { recursive: true });",
      "    __g428CpSync(srcDir, destDir, { recursive: true });",
      "}",
      "",
    ].join("\n")
    : [
      "function renameDirInto(srcDir, destDir) {",
      "    // g-428 --mutation-check 负向对照：还原 g-427 旧顺序（先建目标目录再 rename）。",
      "    // POSIX 的 rename 允许用目录替换**空目录**（缺陷在 Linux 上不可见），故此处显式模拟",
      "    // NTFS/MoveFileEx 语义：目标目录已存在 ⇒ EPERM（与 Windows 真机现场一致）。",
      "    mkdirSync(dirname(destDir), { recursive: true });",
      "    mkdirSync(destDir, { recursive: true });",
      "    if (existsSync(destDir)) {",
      '        throw new Error("EPERM: operation not permitted, rename \'" + srcDir + "\' -> \'" + destDir + "\'");',
      "    }",
      "    renameSync(srcDir, destDir);",
      "}",
      "",
    ].join("\n");
  return { text: text.slice(0, start) + body + text.slice(end), original: text.slice(start, end), mutated: body };
}

// ---------------------------------------------------------------------------
// 台账层入口 + 负向对照（--mutation-check）
// ---------------------------------------------------------------------------

/** 覆盖摘要（写进可复制回传的报告块，供真机结论引用）。 */
const coverage = { ledger: null, smokeSteps: 0, smokeFailed: 0, ignoredLines: 0, harness: null };

/**
 * 台账层入口：扫描产品代码里的 OS 调用点并与 OS_SITE_ROWS 逐字段对账。
 * 找不到产品源码（如对着已安装的发布包跑）时诚实降级为 WARN —— 绝不静默 PASS。
 */
function checkOsSiteLedger(dir) {
  const sourceRoot = resolveProductSourceRoot(dir);
  if (!sourceRoot) {
    record("T1", "OS 调用点覆盖清单（台账层）", "WARN",
      "未找到产品源码（core/*.ts）：本次未做台账对账（发布包内只有编译产物）——" +
      "请在仓库根用 `node scripts/win-smoke-test.mjs --static-only .` 做台账核对");
    return { ok: false, degraded: true, audit: null };
  }
  const files = collectProductSourceFiles(sourceRoot);
  const audit = auditOsSiteLedger(files);
  coverage.ledger = {
    rows: OS_SITE_REGISTRY.length, hits: audit.hits.length,
    scanned: audit.scanned, ignoredLines: audit.ignoredLines,
  };
  coverage.ignoredLines = audit.ignoredLines;
  const base = `清单 ${OS_SITE_REGISTRY.length} 项 / 命中 ${audit.hits.length} 处 / 扫描 ${audit.scanned} 文件 / 忽略处数=${audit.ignoredLines}`;
  if (audit.problems.length === 0) {
    record("T1", "OS 调用点覆盖清单（台账层）", "PASS",
      `${base}；每项均给出风险面与映射（ws:/pg:）或豁免理由，未登记项即判红`);
  } else {
    const byKind = {};
    for (const p of audit.problems) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
    record("T1", "OS 调用点覆盖清单（台账层）", "FAIL",
      `${base}；问题 ${audit.problems.length} 项（${JSON.stringify(byKind)}）：` +
      audit.problems.slice(0, 6).map((p) => `[${p.kind}] ${p.detail}`).join(" | ") +
      (audit.problems.length > 6 ? ` …另有 ${audit.problems.length - 6} 项` : ""));
  }
  return { ok: audit.problems.length === 0, audit, sourceRoot };
}

/** 打印台账覆盖清单（--static-only 模式；也是人工复核的输入）。 */
function printLedgerTable(audit) {
  const byKey = new Map();
  for (const [key, g] of audit.groups) byKey.set(key, g);
  console.log("\n覆盖清单（文件 | API | 命中 | 顶层函数 | 风险面 | 映射/豁免）");
  let exempt = 0;
  for (const r of OS_SITE_REGISTRY) {
    const g = byKey.get(r.file + "#" + r.api);
    if (r.exempt) exempt += 1;
    console.log(`  ${r.file} | ${r.api} | ${g ? g.count : 0}/${r.hits} | ${r.sites.join(",") || "-"} | ${r.risk} | ${r.map}`);
  }
  console.log(`  小计：登记 ${OS_SITE_REGISTRY.length} 项（其中豁免 ${exempt} 项，均带理由）` +
    `，命中 ${audit.hits.length} 处，忽略处数 ${audit.ignoredLines}（成对标记 ${OS_LEDGER_IGNORE_BEGIN}）`);
  console.log("  非目标 API（显式口径，不登记）：" + OS_SITE_NON_GOALS.map((n) => n.api).join("；"));
}

// ---------------------------------------------------------------------------
// T1 派发可用层（g-473）：harness 工具名平台无关性
//
// 缺陷（真实事故）：DSH 在 win32 上**不注册** `bash`（注册 `pwsh`），而
// `@deepseek-ai/dsh-tools` 的 `restrict()` 对未知名**硬抛错**
// （`tools.restrict() names unknown global tool "bash"`）。产品代码把 shell 名硬编码进
// 角色白名单 / 必需清单 / 文案 ⇒ Windows 上 reviewer / collector / executor-minimal
// 三条派发路径**必然**起不来（T1–T5 全绿也照不出来：它们不含派发维度）。
//
// 判定（fail-closed，静态可跑、跨平台同结论）：
//   A. 产品代码（core/ops.ts 或编译产物 core/ops.js）里**带引号的 "bash" 只允许出现在两处形态**：
//      候选表 `SHELL_TOOL_CANDIDATES = ["bash", "pwsh"]` 与平台回落 `win32 ? "pwsh" : "bash"`；
//      其余任何位置（白名单/必需清单/文案）出现即判红 —— 这正是「回退修复」的机器化对照。
//   B. 解析与诊断接线必须在册：shell 槽位常量、候选表、文案占位符、缺能力诊断函数与事件名。
// ---------------------------------------------------------------------------

/** 允许出现带引号 shell 名的两处形态（候选表 + 平台回落）；其余命中一律判红。 */
export const DISPATCH_SHELL_ALLOWED_LINE_RES = Object.freeze([
  /SHELL_TOOL_CANDIDATES\s*=\s*\[\s*["']bash["']\s*,\s*["']pwsh["']\s*\]/,
  /["']win32["']\s*\?\s*["']pwsh["']\s*:\s*["']bash["']/,
]);

/** 派发可用层的存在性自证（缺任一项 ⇒ 修复不在被扫产物里）。 */
export const DISPATCH_WIRING_REQUIRED = Object.freeze([
  { id: "shell-slot", re: /SHELL_TOOL_SLOT\s*=\s*["']<shell>["']/, why: "shell 槽位常量缺失（白名单仍在硬编码 shell 名）" },
  { id: "shell-candidates", re: /SHELL_TOOL_CANDIDATES\s*=\s*\[/, why: "shell 候选表缺失（无从按探针/平台解析）" },
  { id: "shell-token", re: /\{\{shell\}\}/, why: "文案占位符缺失（prompt / 纪律仍会点名某一个平台的名字）" },
  { id: "probe-diagnosis", re: /diagnoseDispatchCapability/, why: "缺能力诊断函数缺失（缺工具时会静默派发到 restrict() 抛错）" },
  { id: "probe-event", re: /dispatch\.capability_missing/, why: "缺能力诊断事件名缺失（失败不可观测）" },
]);

/** 静态审计派发可用性；`files` = [{path, text}]（与台账层同一形状，便于自检正反例）。 */
export function auditDispatchToolPortability(files) {
  const problems = [];
  const targets = files.filter((f) => /(^|\/)ops\.(ts|js)$/.test(f.path));
  for (const f of targets) {
    const lines = String(f.text).split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.includes('"bash"') && !line.includes("'bash'")) continue;
      if (isCommentLine(line)) continue;
      if (DISPATCH_SHELL_ALLOWED_LINE_RES.some((re) => re.test(line))) continue;
      problems.push({
        kind: "hardcoded_shell", path: f.path, line: i + 1,
        detail: `${f.path}:${i + 1} 出现带引号的 "bash" 但不在候选表/平台回落内：${line.trim().slice(0, 120)}`,
      });
    }
    for (const req of DISPATCH_WIRING_REQUIRED) {
      if (!req.re.test(String(f.text))) {
        problems.push({ kind: "missing_wiring", path: f.path, detail: `${f.path}：${req.why}（${req.id}）` });
      }
    }
  }
  return { problems, scanned: files.length, targets: targets.map((f) => f.path) };
}

/**
 * 执行「派发可用」静态核对。
 * 仓库根（有 core/*.ts）⇒ 扫产品源码；只对着已安装包 ⇒ 扫编译产物 `core/ops.js`
 * （那才是真正会跑起来的那份代码）。两者都找不到时如实降级为 WARN，**不伪装 PASS**。
 */
function checkDispatchToolPortability(dir) {
  const sourceRoot = resolveProductSourceRoot(dir);
  let files = null;
  let where = "";
  if (sourceRoot) {
    files = collectProductSourceFiles(sourceRoot).filter((f) => /(^|\/)ops\.(ts|js)$/.test(f.path));
    where = "产品源码";
  } else {
    const pkgDir = resolvePackageDir(dir);
    const ops = join(pkgDir, "core", "ops.js");
    if (existsSync(ops)) {
      files = [{ path: "core/ops.js", text: readFileSync(ops, "utf8") }];
      where = `已安装包编译产物 ${rel(pkgDir, ops)}`;
    }
  }
  if (!files || files.length === 0) {
    record("T1", "派发可用（工具名平台无关性）", "WARN",
      "未找到 core/ops.ts 或 core/ops.js：本次未做派发可用静态核对（请在仓库根用 `--static-only .`，或对着已构建包运行）");
    return { ok: false, degraded: true, audit: null };
  }
  const audit = auditDispatchToolPortability(files);
  coverage.dispatch = { targets: audit.targets, problems: audit.problems.length };
  if (audit.problems.length === 0) {
    record("T1", "派发可用（工具名平台无关性）", "PASS",
      `${where}（${audit.targets.join(", ")}）：带引号的 "bash" 只出现在候选表与平台回落；槽位/候选/占位符/诊断/事件接线齐备`);
  } else {
    record("T1", "派发可用（工具名平台无关性）", "FAIL",
      `问题 ${audit.problems.length} 项：` + audit.problems.slice(0, 5).map((p) => `[${p.kind}] ${p.detail}`).join(" | ") +
      (audit.problems.length > 5 ? ` …另有 ${audit.problems.length - 5} 项` : ""));
  }
  return { ok: audit.problems.length === 0, audit, where };
}

// ---------------------------------------------------------------------------
// H 系列（g-475）：harness 组合 / OS 行为差异探针（**单一真源**，两件消费）
//
// 病根（g-473 实证）：同一个 harness 在不同 OS / 组合下**行为不同**，而两平台门禁此前只守
//   「OS API 调用点」（g-428 台账层）与「POSIX 专有常量具名导入」（T1）——**不守 harness 组合依赖**。
//   ⇒ Windows 上模型面向工具是 `pwsh`（不注册 `bash`），插件把 `bash` 写进角色白名单，
//   `@deepseek-ai/dsh-tools` 的 `restrict()` 对未知名**硬抛** ⇒ reviewer / collector /
//   executor-minimal 三条派发路径必挂，而 v0.20.1 的 Windows 真机 T1–T5 **全绿**。
//
// 本段是 H1–H6 的**唯一真源**：探针清单（`HARNESS_PROBE_ROWS`）、判定（`judge*`）、运行器
//   （`HARNESS_PROBE_RUNNERS`）与防漂移审计（`auditHarnessProbeManifest` /
//   `auditHarnessProbeConsumers`）都**只在这里定义一次**；`scripts/win-smoke-test.mjs` 与
//   `scripts/platform-smoke-test.mjs` 都调用 `runHarnessProbes()`，并各自渲染**同一行**矩阵结论。
//
// **为什么宿主是 win-smoke，而不是新开 `scripts/lib/`**：win-smoke 的既有契约是「单文件、无第三方
//   依赖、可单独拷到原生 Windows 上运行」（发布红线 1 的执行件，`win-smoke-test.cmd` 双击即用）——
//   新增本地 import 会让「只拷一个 .mjs」失效。platform-smoke 本来就依赖 win-smoke 在仓库内存在
//   （`forwardSmoke` 直接 spawn 它，`core/tests/*` 也从它 import），故由它 import **不引入任何新耦合**，
//   也不产生第二份定义（brief 允许「若仓内已有更合适的共享位则复用」）。
//
// 与既有 P1–P6 / M4 / T1 台账的分工（零重复定义）：
//   H1 shell 名解析   —— 新增：组合声明 × 插件解析（组合依赖面；T1/g-473 只**静态扫产品代码**）
//   H2 白名单求交     —— 新增：组合工具名台账 × `toolFilterForRole`（把 g-473 的代码在 dist 上真跑一遍）
//   H3 派发可用       —— 新增：隔离实例真派发**事实**的判定（`--static-only` 一律显式 SKIP，不静默通过）
//   H4 分隔符/大小写  —— H4.a 断言产品既有拒绝语义；H4.b **新增**（P1 量真实卷语义，H4.b 注引擎语义）
//   H5 CRLF/编码往返  —— **新增**（P6 是 locale/CJK 逐字节；H5 是换行风格 + 机器头注入折叠）
//   H6 命令拼接与引号 —— 复用 win-smoke 既有 `splitCmd`/`quoteForCmd`/`buildShellCommandLine`，
//                        并**新增**真实 argv 传递自检（真机/实例轮靠它回传结论）
// ---------------------------------------------------------------------------

/** H 探针 id 全集（顺序即报告顺序）；清单穷尽性由 `auditHarnessProbeManifest` 钉住。 */
export const HARNESS_PROBE_IDS = Object.freeze(["H1", "H2", "H3", "H4", "H5", "H6"]);

/** 负向对照用的**已知不存在**的名字：判定必须判红，证明「补集为空」这条断言不是恒真。 */
export const HARNESS_ABSENT_TOOL = "__dsh_graph_absent_tool__";

/** 两件执行件（相对仓库根）：**都必须消费**本清单。 */
export const HARNESS_PROBE_CONSUMER_FILES = Object.freeze([
  "scripts/win-smoke-test.mjs",
  "scripts/platform-smoke-test.mjs",
]);

/** 消费点的唯一形态：调用 `runHarnessProbes(`；未出现即「该件未消费」。 */
export const HARNESS_PROBE_CONSUMER_MARKER = "runHarnessProbes(";

/** 单一真源的机械标记：`export const HARNESS_PROBE_ROWS` 在两件里必须**恰好出现 1 次**。 */
export const HARNESS_PROBE_DEFINITION_MARKER = "export const HARNESS_PROBE_ROWS";

/**
 * H 系列探针清单（**覆盖契约**）。行格式：[id, requires, title, criterion]。
 * `requires`：`offline`（纯 Node，无需 dist/组合）| `composition`（需 DSH 组合声明）|
 *             `dist`（需可导入的 core/ops.js）| `instance`（需隔离实例真派发事实）。
 * 漏一项 / 多一项 / 重复 / 某件未消费 ⇒ 由 `auditHarnessProbeManifest` 与
 * `auditHarnessProbeConsumers` fail-closed 判红（`--self-test` 与 `core/tests/g475-*.test.ts` 双证）。
 */
export const HARNESS_PROBE_ROWS = Object.freeze([
  [
    "H1", "composition",
    "shell 工具名解析（平台条件化组合声明 → 插件解析一致：win32→pwsh / POSIX→bash）",
    "PASS = 组合声明里 `tool-bash`/`tool-pwsh` 的 `disabled: !!js process.platform …` 按目标平台求值后" +
      "恰好一个启用，且该名字与 `resolveShellTool()`（探针优先 + 无探针平台回落）**逐平台一致**；" +
      "FAIL = 组合声明与解析结果不一致 / 出现无法识别的 disabled 形态 / 组合声明了未登记的工具插件；" +
      "WARN = 找不到 DSH 组合声明（未实测，不冒充通过；可用 DSH_GATE_DSH_ROOT / --dsh-root 指定，" +
      "WARN 文案另附可复制的定位命令 —— g-477）。",
  ],
  [
    "H2", "dist",
    "角色白名单求交（组合工具名台账驱动；reviewer / collector / executor-minimal 三路径）",
    "PASS = 三路径（含 minimal）的 `toolFilterForRole().allow` ⊆ 组合**实际存在**名字集合（以「有探针时逐名求交」" +
      "的语义驱动）；shell 槽位解析为组合的 shell 名、另一平台的名字不出现；" +
      "**负向对照**：注入一个已知不存在的名字必须判红（证明「补集为空」不是恒真）；" +
      "注入「缺 dsh-tool-web」⇒ web_* 静默剔除、注入「缺 shell」⇒ 可读诊断且不派发；" +
      "FAIL = 出现越界名字 / 组合工具插件未登记 / 求交未生效；WARN = 无可导入的 core/ops.js。",
  ],
  [
    "H3", "instance",
    "派发可用（隔离实例真派发 reviewer + collector + executor-minimal 各一次）",
    "PASS = 三条路径都拿到非空 `child_id`、无 `tools.restrict() names unknown`、无「子代理启动失败」/" +
      "`child_error`；FAIL = 任一条不成立；" +
      "**SKIP（需真机/实例）** = 未在隔离实例上真实派发时**必须显式标注跳过**，禁止静默通过" +
      "（真机事实经 `--h3-dispatch-json <file>` / `DSH_GATE_H3_DISPATCH_JSON` 回传后由本探针判定）。",
  ],
  [
    "H4", "dist",
    "路径分隔符与大小写语义（产品侧拒绝语义 + 卷语义注入下的引擎行为）",
    "PASS = 反斜杠 / 绝对路径 / `..` 形态的附件名被**可读拒绝**（不静默建目录、不泄漏平台错误码），`a/b.txt` 正常；" +
      "且注入「大小写不敏感卷」时别名解析命中、注入「大小写敏感」时不命中（判定与真实卷无关，跨平台同结论）；" +
      "FAIL = 任一不成立；WARN = 无可导入的 core/ops.js 或 core/platform.js。",
  ],
  [
    "H5", "dist",
    "CRLF/LF 与编码往返（目标正文逐字节 + results 机器头注入折叠）",
    "PASS = 含 `\\r\\n` 与星平面字符（🙂）的正文写进 goal.md 后逐字节读回一致、UTF-8 往返无损且无孤立 `\\r`；" +
      "机器头字段里注入 `\\r\\n` 只被折叠进同一行（不新增行、字段齐备），正文换行归一为 LF 且逻辑行不丢；" +
      "FAIL = 任一不成立；WARN = 无可导入的 core/ops.js。",
  ],
  [
    "H6", "offline",
    "命令拼接与引号（`--dsh` 单串解析 + cmd.exe 引号 + 真实 argv 传递自检）",
    "PASS = `splitCmd` 按空白/引号分组解析 `--dsh` 单串（含带空格路径的引号分组）；`quoteForCmd` /" +
      " `buildShellCommandLine` 按 cmd.exe 元字符集合加引号且不重复加；" +
      "真实 argv 传递（`shell:false` 与 POSIX `sh -c <组合命令行>`）逐字节一致；FAIL = 任一不成立。",
  ],
]);

/** 有意**不登记**进组合工具名台账的产品插件（显式非目标，避免「为什么 X 不在清单里」的隐性口径）。 */
export const HARNESS_TOOL_REGISTRY_NON_GOALS = Object.freeze([
  "子代理角色白名单（reviewer/collector/executor/supervisor/pm/summarizer）从不裁剪的工具：",
  "present / todo / goal / skill / jobs / schedule / workflow / subagent* / ask-user / working-directory /",
  "terminal* / call-timeout-policy / cordis / plugin-manager 等 —— 它们不在 `allowedTools` 里出现，",
  "故「组合里有没有」不影响 restrict() 是否抛错；一旦将来被写进角色白名单，本表必须同步登记。",
]);

/**
 * 组合工具名台账（**本清单即覆盖契约**）：`@deepseek-ai/dsh-tool-*` 声明 → 模型面向工具名。
 * 行格式：[插件包名, 工具名数组 | null, 非目标理由]
 * 工具名数组必须能被该包自己的 `package.json` description 佐证（`auditToolRegistry`，防止凭空编造）；
 * 组合声明里出现**未登记**的 `@deepseek-ai/dsh-tool-*` ⇒ 判红（fail-closed，与 OS_SITE_ROWS 同范式）。
 * 键是**包名**：声明里的子路径形态（`@deepseek-ai/dsh-tool-subagent-control/list-agents`）按包名归一。
 */
export const DSH_TOOL_PLUGIN_REGISTRY = Object.freeze([
  ["@deepseek-ai/dsh-tool-bash", ["bash"], ""],
  ["@deepseek-ai/dsh-tool-pwsh", ["pwsh"], ""],
  ["@deepseek-ai/dsh-tool-fs", ["read", "write", "edit"], ""],
  ["@deepseek-ai/dsh-tool-fs-search", ["glob", "grep"], ""],
  ["@deepseek-ai/dsh-tool-web", ["web_search", "web_fetch"], ""],
  ["@deepseek-ai/dsh-tool-ask-user", null, "角色白名单不裁剪（仅标准模式全量可用）"],
  ["@deepseek-ai/dsh-tool-bash-persistent", null, "持久终端，不在角色白名单"],
  ["@deepseek-ai/dsh-tool-pwsh-persistent", null, "持久终端，不在角色白名单"],
  ["@deepseek-ai/dsh-tool-call-timeout-policy", null, "策略件，不注册模型面向工具"],
  ["@deepseek-ai/dsh-tool-cordis", null, "角色白名单不裁剪"],
  ["@deepseek-ai/dsh-tool-goal", null, "角色白名单不裁剪"],
  ["@deepseek-ai/dsh-tool-jobs", null, "角色白名单不裁剪"],
  ["@deepseek-ai/dsh-tool-present", null, "角色白名单不裁剪"],
  ["@deepseek-ai/dsh-tool-ralph", null, "实验 bundle 专用，不在角色白名单"],
  ["@deepseek-ai/dsh-tool-schedule", null, "角色白名单不裁剪"],
  ["@deepseek-ai/dsh-tool-session-query", null, "实验 bundle 专用，不在角色白名单"],
  ["@deepseek-ai/dsh-tool-skill", null, "角色白名单不裁剪"],
  ["@deepseek-ai/dsh-tool-subagent", null, "角色白名单不裁剪"],
  ["@deepseek-ai/dsh-tool-subagent-control", null, "角色白名单不裁剪（含 /list-agents、/model-selection-settings 子路径）"],
  ["@deepseek-ai/dsh-tool-terminal", null, "实验 bundle 专用，不在角色白名单"],
  ["@deepseek-ai/dsh-tool-todo", null, "角色白名单不裁剪"],
  ["@deepseek-ai/dsh-tool-workflow", null, "角色白名单不裁剪"],
  ["@deepseek-ai/dsh-tool-working-directory", null, "角色白名单不裁剪"],
  ["@deepseek-ai/dsh-tool-workspace-dependencies", null, "SDK bundle 专用，不在角色白名单"],
]);

/** `@deepseek-ai/dsh-tool-x/sub/path` → `@deepseek-ai/dsh-tool-x`（台账按包名比对）。 */
export function toolPluginBaseName(name) {
  const parts = String(name ?? "").split("/");
  return parts.length > 2 ? parts.slice(0, 2).join("/") : String(name ?? "");
}

/** 台账别名（与 OS_SITE_REGISTRY 同形状用法）。 */
export const DSH_TOOL_REGISTRY = Object.freeze(DSH_TOOL_PLUGIN_REGISTRY.map(([pkg, tools, nonGoal]) => ({
  pkg, tools: tools ? [...tools] : null, nonGoal: nonGoal || "",
})));

/** 允许的 `disabled:` 条件形态（只认这些；其余形态**判红**，避免组合声明变了却静默放行）。 */
export const PLATFORM_CONDITION_FORMS = Object.freeze([
  { id: "win32-eq", re: /^process\.platform\s*===\s*['"]win32['"]$/ },
  { id: "win32-neq", re: /^process\.platform\s*!==\s*['"]win32['"]$/ },
  { id: "platform-in", re: /^\[([^\]]*)\]\.includes\(process\.platform\)$/ },
  { id: "bool-true", re: /^true$/ },
  { id: "bool-false", re: /^false$/ },
]);

/**
 * 对目标平台求值一条平台条件表达式。
 * 返回 {ok, value, form, why}；`ok === false` 表示形态无法识别（调用方**必须判红**）。
 */
export function evaluatePlatformCondition(rawExpr, platform) {
  const expr = stripJsPrefix(rawExpr);
  const platformRelevant = /process\.platform/.test(expr);
  for (const form of PLATFORM_CONDITION_FORMS) {
    const m = form.re.exec(expr);
    if (!m) continue;
    if (form.id === "win32-eq") return { ok: true, value: platform === "win32", form: form.id, why: "", platformRelevant: true };
    if (form.id === "win32-neq") return { ok: true, value: platform !== "win32", form: form.id, why: "", platformRelevant: true };
    if (form.id === "bool-true") return { ok: true, value: true, form: form.id, why: "", platformRelevant };
    if (form.id === "bool-false") return { ok: true, value: false, form: form.id, why: "", platformRelevant };
    const names = m[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    return { ok: true, value: names.includes(platform), form: form.id, why: "", platformRelevant: true };
  }
  return {
    ok: false, value: null, form: null, platformRelevant,
    why: `无法识别的${platformRelevant ? "平台" : "非平台"}条件形态：${expr || "(空)"}`,
  };
}

/** 去掉 `!!js ` 前缀与包裹的字符串引号（组合声明里两种写法都出现过）。 */
export function stripJsPrefix(rawExpr) {
  let expr = String(rawExpr ?? "").trim();
  if (expr.startsWith("!!js")) expr = expr.slice(4).trim();
  if (/^".*"$/.test(expr) && expr.length >= 2) expr = expr.slice(1, -1).trim();
  return expr;
}

/**
 * 解析组合声明（cordis patch YAML 的「- id: X / name: 'pkg' / disabled: <expr>」三元组）。
 * files: [{path, text}]。返回 {declarations, problems}；只认含 `name:` 的条目。
 */
export function scanCompositionToolDeclarations(files) {
  const declarations = [];
  const problems = [];
  for (const f of files) {
    const lines = String(f.text ?? "").split(/\r?\n/);
    let cur = null;
    const flush = () => {
      if (!cur) return;
      if (cur.name) declarations.push(cur);
      cur = null;
    };
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const idm = /^\s*-\s*id:\s*([A-Za-z0-9_$.-]+)\s*$/.exec(line);
      if (idm) { flush(); cur = { file: f.path, line: i + 1, id: idm[1], name: null, disabled: null }; continue; }
      if (!cur) continue;
      const nm = /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
      if (nm && !cur.name) { cur.name = nm[1]; continue; }
      const dm = /^\s*disabled:\s*(.+?)\s*$/.exec(line);
      if (dm && cur.disabled === null) { cur.disabled = dm[1]; continue; }
    }
    flush();
    if (declarations.length === 0) problems.push({ kind: "no-declaration", file: f.path, detail: `${f.path}：未解析出任何 - id/name 组合声明条目` });
  }
  return { declarations, problems };
}

/** 组合声明里出现的 `@deepseek-ai/dsh-tool-*` 包名（去重，保留出现顺序）。 */
export function compositionToolPackages(declarations) {
  const out = [];
  for (const d of declarations) {
    if (!/^@deepseek-ai\/dsh-tool-/.test(String(d.name ?? ""))) continue;
    const base = toolPluginBaseName(d.name);
    if (!out.includes(base)) out.push(base);
  }
  return out;
}

/** 台账查询：包名 → 工具名数组（null = 显式非目标）。未登记返回 undefined。 */
export function registryEntryFor(pkg, registry = DSH_TOOL_REGISTRY) {
  return registry.find((r) => r.pkg === pkg);
}

/**
 * 组合工具名台账审计（fail-closed）：
 *  ① 组合声明里出现未登记的 `@deepseek-ai/dsh-tool-*` ⇒ 判红（新增工具插件必须登记）；
 *  ② 台账里登记为「有工具名」的包，其工具名必须被该包自己的 package.json description 佐证
 *     （`descriptions` 为 pkg → description 映射；缺失即跳过该包的佐证，但由 ③ 记录）；
 *  ③ 无法识别的 `disabled:` 形态（若该条目属于已登记的工具包）⇒ 判红。
 */
export function auditToolRegistry(declarations, opts = {}) {
  const registry = opts.registry ?? DSH_TOOL_REGISTRY;
  const descriptions = opts.descriptions ?? {};
  const problems = [];
  const nonPlatform = [];
  for (const d of declarations) {
    if (!/^@deepseek-ai\/dsh-tool-/.test(String(d.name ?? ""))) continue;
    const base = toolPluginBaseName(d.name);
    const entry = registryEntryFor(base, registry);
    if (!entry) {
      problems.push({ kind: "unregistered-tool-plugin", file: d.file, detail: `${d.file}:${d.line} 组合声明了未登记的工具插件 ${d.name}（包名 ${base}；请登记进 DSH_TOOL_PLUGIN_REGISTRY：工具名数组或非目标理由）` });
      continue;
    }
    if (entry.tools) {
      const desc = descriptions[base];
      if (typeof desc === "string" && desc.length > 0) {
        for (const t of entry.tools) {
          if (!desc.toLowerCase().includes(t.toLowerCase())) {
            problems.push({ kind: "tool-name-unverified", file: d.file, detail: `${base} 的台账工具名 "${t}" 未出现在该包 package.json description 里（不得凭空编造）` });
          }
        }
      }
    }
    if (d.disabled) {
      const ev = evaluatePlatformCondition(d.disabled, "linux");
      if (!ev.ok && ev.platformRelevant) {
        problems.push({ kind: "unknown-platform-condition", file: d.file, detail: `${d.file}:${d.line} ${d.name} 的**平台**条件形态无法识别：${stripJsPrefix(d.disabled)}（组合声明形态变了，必须同步扩展 PLATFORM_CONDITION_FORMS）` });
      } else if (!ev.ok) {
        nonPlatform.push({ file: d.file, line: d.line, name: d.name, expr: stripJsPrefix(d.disabled) });
      }
    }
  }
  for (const r of registry) {
    if (r.tools && r.tools.length === 0) problems.push({ kind: "registry", detail: `台账 ${r.pkg} 的工具名数组为空` });
    if (!r.tools && String(r.nonGoal).trim().length < 4) problems.push({ kind: "registry", detail: `台账 ${r.pkg} 既无工具名也无非目标理由` });
  }
  const ids = new Set();
  for (const r of registry) {
    if (ids.has(r.pkg)) problems.push({ kind: "registry", detail: `台账重复登记 ${r.pkg}` });
    ids.add(r.pkg);
  }
  return { problems, nonPlatform };
}

/**
 * 某一平台下组合**实际注册**的 shell 工具名集合。
 * 判据：`tool-bash` / `tool-pwsh` 声明里 `disabled` 求值为 false（或没写 disabled）⇒ 启用。
 * 返回 {tools, unknown}；unknown 为非空表示有条目无法判定（调用方判红）。
 */
export function compositionShellTools(declarations, platform) {
  const tools = [];
  const unknown = [];
  for (const d of declarations) {
    if (d.id !== "tool-bash" && d.id !== "tool-pwsh") continue;
    const name = d.id === "tool-bash" ? "bash" : "pwsh";
    let disabled = false;
    if (d.disabled !== null && String(d.disabled).trim() !== "") {
      const ev = evaluatePlatformCondition(d.disabled, platform);
      if (!ev.ok) { unknown.push({ id: d.id, expr: d.disabled, why: ev.why }); continue; }
      disabled = ev.value === true;
    }
    if (!disabled && !tools.includes(name)) tools.push(name);
  }
  return { tools: tools.sort(), unknown };
}

/**
 * 某一平台下组合**实际存在**的模型面向工具名集合（台账驱动）。
 * 只看「无 disabled 或 disabled 求值为 false」的条目；未登记包 ⇒ 记入 unregistered。
 */
export function compositionToolNames(declarations, platform, registry = DSH_TOOL_REGISTRY) {
  const names = new Set();
  const unregistered = [];
  for (const d of declarations) {
    if (!/^@deepseek-ai\/dsh-tool-/.test(String(d.name ?? ""))) continue;
    let disabled = false;
    if (d.disabled !== null && String(d.disabled).trim() !== "") {
      const ev = evaluatePlatformCondition(d.disabled, platform);
      if (!ev.ok) continue; // 形态问题由 auditToolRegistry 判红，此处不重复
      disabled = ev.value === true;
    }
    if (disabled) continue;
    const base = toolPluginBaseName(d.name);
    const entry = registryEntryFor(base, registry);
    if (!entry) { unregistered.push(base); continue; }
    for (const t of entry.tools ?? []) names.add(t);
  }
  return { names, unregistered };
}

/** 目录的直接子目录名（有界、静默失败：用于 profiles / _npx 这类通配形态）。 */
function subdirNames(dir) {
  try { return readdirSync(dir).sort(); } catch { return []; }
}

/**
 * 在 base 下有界枚举 `node_modules` 目录（深度 ≤ depth；**不再深入 node_modules 内部**）。
 * 覆盖 `_npx\<hash>\node_modules`、`~/.dsh/profiles\<名>\node_modules` 这类「中间层是通配名」的形态。
 */
export function nodeModulesDirsUnder(base, depth = 2) {
  const out = [];
  const walk = (dir, level) => {
    for (const name of subdirNames(dir)) {
      const child = join(dir, name);
      if (name === "node_modules") out.push(child);
      else if (level < depth) walk(child, level + 1);
    }
  };
  walk(base, 1);
  return out;
}

/**
 * npm 全局根回退的**命令构造**（纯：platform / execPath / timeout 全部可注入 ⇒ 离线夹具可跑）。
 *
 * 为什么需要（g-477 真机缺陷）：Windows 上 `npm` 是 `npm.cmd` 批处理包装，`spawnSync("npm", …)`
 * **不经 shell 必然失败**（ENOENT，且 Node ≥ 18.20 对 `.cmd` 非 shell spawn 直接 EINVAL）⇒
 * 旧实现的回退在 Windows 上**恒失效**（Linux 上有效，掩盖了问题）。
 * 修法：Windows 走 `process.execPath` 同目录的 `npm.cmd` + `shell: true`，且按 DEP0190 口径只传
 * **完整命令行字符串**（不传 args 数组）；POSIX 保持 `npm` + args、`shell: false`（语义更窄）。
 */
export function npmGlobalRootInvocation(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const execPath = opts.execPath ?? process.execPath;
  const args = ["root", "-g"];
  const options = { encoding: "utf8", timeout: opts.timeout ?? 30_000 };
  if (platform === "win32") {
    const cmd = join(dirname(execPath), "npm.cmd"); // 官方安装器 / nvm-windows 都把 npm.cmd 放在 node.exe 同目录
    return { file: cmd, args, shell: true, commandLine: buildShellCommandLine(cmd, args), options };
  }
  return { file: "npm", args, shell: false, commandLine: buildShellCommandLine("npm", args), options };
}

/**
 * 命令构造的**可判定性**（fail-closed）：不可用形状一律**拒绝启动**，绝不让回退「静默恒失效」。
 * 判据即 g-477 真机缺陷的机器化形态：`{file:"npm", shell:false}` 在 win32 上必须被拒。
 */
export function npmGlobalRootInvocationProblems(inv, platform = process.platform) {
  const problems = [];
  const file = String(inv?.file ?? "").trim();
  if (!file) return ["缺少可执行文件名（npm 回退无法启动）"];
  if (platform === "win32") {
    if (!/\.(?:cmd|bat|exe)$/i.test(file)) {
      problems.push(`Windows 上 npm 回退必须指向 npm.cmd（实际 ${file}）：非 shell spawn 打不到 .cmd 包装`);
    } else if (inv.shell !== true) {
      problems.push(`Windows 上 ${basename(file)} 必须经 shell 启动（否则 ENOENT/EINVAL）`);
    }
    if (inv.shell === true && !String(inv.commandLine ?? "").trim()) {
      problems.push("shell 形态必须给完整命令行字符串（DEP0190：不得同时传 args 数组）");
    }
  } else if (inv.shell === true) {
    problems.push("POSIX 上 npm 回退不应经 shell（静默失败语义与注入面都会被放大）");
  }
  return problems;
}

/**
 * 执行 `npm root -g` 回退（best-effort：超时、静默失败）。形状不可用（见
 * `npmGlobalRootInvocationProblems`）时**不启动进程**直接返回 null；`opts.spawnSync` / `opts.invocation`
 * 可注入，供离线夹具断言「命令构造真的走了 shell」与「裸 npm 形态被拒」。
 */
export function queryNpmGlobalRoot(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const inv = opts.invocation ?? npmGlobalRootInvocation({ platform, execPath: opts.execPath, timeout: opts.timeout });
  if (npmGlobalRootInvocationProblems(inv, platform).length > 0) return null;
  const spawn = opts.spawnSync ?? spawnSync;
  try {
    const r = inv.shell
      ? spawn(inv.commandLine, { ...inv.options, shell: true })
      : spawn(inv.file, inv.args, inv.options);
    if (r && r.status === 0 && String(r.stdout ?? "").trim()) return String(r.stdout).trim();
  } catch { /* 静默失败：回退只是 best-effort */ }
  return null;
}

/**
 * DSH 安装根候选目录（**纯枚举 + 真实存在的目录过滤**；env / homedir / platform / execPath 全部可注入
 * ⇒ 可在 Linux 上用伪造的 `%APPDATA%` / `_npx` / `profiles` 树做夹具）。
 *
 * 候选面（g-477 补全 Windows 形态）：
 *   ① 显式指定（`DSH_GATE_DSH_ROOT` / `extra`，可逗号分隔）；
 *   ② 仓库根 / 工作目录的 `node_modules` 与 `node_modules/@deepseek-ai/dsh`；
 *   ③ 当前 Node 的全局 `node_modules`（`<node>/lib/node_modules`、`<node>/node_modules`，离线不 spawn）；
 *   ④ Windows 的 `%APPDATA%\npm\node_modules`（官方安装器的全局根）；
 *   ⑤ Windows 的 npx 缓存 `%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules`（`npx` / `npm exec` 形态）；
 *   ⑥ DSH 自己的 profile 目录 `~/.dsh/profiles/**\/node_modules`（隔离 profile 的真实来源）。
 */
export function dshRootCandidates(opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const cwd = opts.cwd ?? process.cwd();
  const execPath = opts.execPath ?? process.execPath;
  const home = opts.homedir ?? (platform === "win32" ? env.USERPROFILE : env.HOME) ?? env.HOME ?? env.USERPROFILE ?? null;
  const raw = [];
  const add = (p) => { if (p) raw.push(resolve(String(p))); };
  // ① 显式指定优先（--dsh-root / DSH_GATE_DSH_ROOT，可逗号/分号分隔）
  for (const e of String(env.DSH_GATE_DSH_ROOT ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean)) add(e);
  for (const e of opts.extra ?? []) add(e);
  // ② 仓库根 / 工作目录
  for (const b of [opts.repo, cwd].filter(Boolean)) {
    add(join(b, "node_modules", "@deepseek-ai", "dsh"));
    add(join(b, "node_modules"));
  }
  // ③ 当前 Node 的全局 node_modules（离线、不 spawn 进程）；同时覆盖 Windows 的 <nodejs>\node_modules
  const nodeDir = dirname(execPath);
  add(join(nodeDir, "node_modules", "@deepseek-ai", "dsh"));
  add(join(nodeDir, "node_modules"));
  add(join(nodeDir, "..", "lib", "node_modules", "@deepseek-ai", "dsh"));
  add(join(nodeDir, "..", "lib", "node_modules"));
  add(join(nodeDir, "..", "node_modules", "@deepseek-ai", "dsh"));
  // ④ Windows：%APPDATA%\npm\node_modules（全局安装的默认落点）
  if (platform === "win32") {
    const appData = env.APPDATA ?? (home ? join(home, "AppData", "Roaming") : null);
    if (appData) {
      add(join(appData, "npm", "node_modules", "@deepseek-ai", "dsh"));
      add(join(appData, "npm", "node_modules"));
    }
    // ⑤ Windows：npx / npm exec 的缓存树（%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules）
    const localAppData = env.LOCALAPPDATA ?? (home ? join(home, "AppData", "Local") : null);
    const npxBases = [localAppData, appData].filter(Boolean).map((b) => join(b, "npm-cache", "_npx"));
    for (const base of npxBases) {
      for (const nm of nodeModulesDirsUnder(base, 2)) add(nm);
    }
  }
  // ⑥ DSH 自己的 profile 目录（~/.dsh/profiles/**\/node_modules）
  if (home) {
    const profiles = join(home, ".dsh", "profiles");
    add(profiles);
    for (const nm of nodeModulesDirsUnder(profiles, 2)) add(nm);
  }
  const out = [];
  for (const p of raw) if (existsSync(p) && !out.includes(p)) out.push(p);
  return out;
}

/** 候选根是否可被 `collectCompositionFiles` 消费（`<root>/@deepseek-ai` 或 `<root>/node_modules/@deepseek-ai`）。 */
export function isDshRootShape(root) {
  return existsSync(join(root, "node_modules", "@deepseek-ai"))
    || existsSync(join(root, "@deepseek-ai"))
    || /@deepseek-ai[\\/]dsh$/.test(root)
    || basename(root) === "@deepseek-ai";
}

/**
 * 在若干候选根里定位 DSH 安装（含 `@deepseek-ai/dsh-tool-bash` 或 `dsh-web-app`）。
 * 全部入参可经 `opts`（env / platform / execPath / spawnSync / invocation）注入，便于离线夹具。
 */
export function discoverDshRoots(repo, extra = [], opts = {}) {
  const roots = dshRootCandidates({ ...opts, repo, extra }).filter(isDshRootShape);
  // npm root -g（跨平台 best-effort；Windows 经 npm.cmd + shell，形状不可用则拒绝启动）
  const npmRoot = queryNpmGlobalRoot(opts);
  if (npmRoot) {
    for (const cand of [join(npmRoot, "@deepseek-ai", "dsh"), npmRoot]) {
      const abs = resolve(cand);
      if (existsSync(abs) && !roots.includes(abs)) roots.push(abs);
    }
  }
  return roots.filter(isDshRootShape);
}

/** 读取若干包的 package.json description（台账佐证用）。 */
export function collectPackageDescriptions(roots) {
  const out = {};
  for (const root of roots) {
    const scopeDir = root.includes(`${sep}@deepseek-ai${sep}dsh`) ? join(root, "node_modules", "@deepseek-ai") : join(root, "@deepseek-ai");
    let names = [];
    try { names = readdirSync(scopeDir); } catch { continue; }
    for (const n of names) {
      if (out[n]) continue;
      try {
        const j = JSON.parse(readFileSync(join(scopeDir, n, "package.json"), "utf8"));
        if (typeof j.description === "string") out[j.name ?? n] = j.description;
      } catch { /* 忽略 */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// H1：shell 工具名解析（组合声明 × 插件解析）
// ---------------------------------------------------------------------------

/**
 * 纯判定。facts = {
 *   platforms: ["win32","linux","darwin"],
 *   composition: { <platform>: {tools:[...], unknown:[...]} },
 *   pluginProbe: { <platform>: {name, source, candidates} },   // 用组合名字集合当探针的解析结果
 *   pluginFallback: { <platform>: {name, source} },            // 无探针（平台回落）的解析结果
 *   registryProblems: [...], compositionProblems: [...],
 *   currentPlatform, currentResolved: {name, source},
 * }
 * 返回 {level, problems, detail}。
 */
export function judgeShellToolComposition(facts) {
  const problems = [];
  const f = facts ?? {};
  const platforms = f.platforms ?? ["win32", "linux", "darwin"];
  for (const p of f.compositionProblems ?? []) problems.push(`[composition] ${p.detail ?? JSON.stringify(p)}`);
  for (const p of f.registryProblems ?? []) problems.push(`[registry] ${p.detail ?? JSON.stringify(p)}`);
  const expected = {};
  for (const p of platforms) {
    const comp = (f.composition ?? {})[p];
    if (!comp) { problems.push(`组合声明缺少平台 ${p} 的求值结果`); continue; }
    for (const u of comp.unknown ?? []) problems.push(`平台 ${p}：无法判定 ${u.id} 的 disabled（${u.why}）`);
    const tools = comp.tools ?? [];
    if (tools.length !== 1) {
      problems.push(`平台 ${p}：组合里启用的 shell 工具应为恰好 1 个，实际 [${tools.join(", ")}]`);
      continue;
    }
    expected[p] = tools[0];
  }
  const wantShell = { win32: "pwsh", linux: "bash", darwin: "bash" };
  for (const p of platforms) {
    if (expected[p] && expected[p] !== wantShell[p]) {
      problems.push(`平台 ${p}：组合启用的 shell 是 ${expected[p]}，与门禁契约 ${wantShell[p]} 不符`);
    }
    const probe = (f.pluginProbe ?? {})[p];
    if (!probe) { problems.push(`缺少平台 ${p} 的插件探针解析结果`); continue; }
    if (probe.name !== expected[p]) {
      problems.push(`平台 ${p}：插件按组合探针解析出 ${probe.name ?? "null"}，组合声明的是 ${expected[p] ?? "(未知)"}`);
    }
    const fb = (f.pluginFallback ?? {})[p];
    if (!fb) { problems.push(`缺少平台 ${p} 的插件平台回落结果`); continue; }
    if (fb.name !== wantShell[p]) {
      problems.push(`平台 ${p}：插件无探针时回落到 ${fb.name ?? "null"}，期望 ${wantShell[p]}`);
    }
  }
  const cur = f.currentResolved;
  if (cur && expected[f.currentPlatform] && cur.name !== expected[f.currentPlatform]) {
    problems.push(`当前平台 ${f.currentPlatform}：插件解析出 ${cur.name ?? "null"}，组合声明的是 ${expected[f.currentPlatform]}`);
  }
  const detail =
    `组合声明：${platforms.map((p) => `${p}=${expected[p] ?? "?"}`).join(" ")}；` +
    `插件解析（探针）逐平台一致；回落=${platforms.map((p) => `${p}:${(f.pluginFallback ?? {})[p]?.name ?? "?"}`).join(" ")}` +
    (cur ? `；当前平台 ${f.currentPlatform}=${cur.name}（来源 ${cur.source}）` : "");
  return { level: problems.length === 0 ? "PASS" : "FAIL", problems, detail };
}

// ---------------------------------------------------------------------------
// H2：角色白名单求交（组合工具名台账驱动 + 负向对照）
// ---------------------------------------------------------------------------

/** 单条「allow ⊆ existing」判定（纯函数，供正反例与负向对照直接调用）。 */
export function roleFilterProblems(role, mode, allow, existing) {
  const problems = [];
  const set = existing instanceof Set ? existing : new Set(existing ?? []);
  if (!Array.isArray(allow)) return [`${role}/${mode}：未产出 allow 数组（求交路径没走到）`];
  const outside = allow.filter((n) => !set.has(n));
  if (outside.length > 0) {
    problems.push(`${role}/${mode}：allow 里有 ${outside.length} 个名字不在组合实际存在集合内（${outside.join(", ")}）—— restrict() 必抛`);
  }
  return problems;
}

/**
 * 纯判定。facts = {
 *   cases: [{role, mode, platform, allow, existing, shellExpected, shellForbidden}],
 *   injections: [{id, problems:[...]}],
 *   negativeControl: {problems: [...]},   // 注入不存在名字时必须非空
 *   registryProblems: [...],
 *   absentTool,
 * }
 */
export function judgeRoleWhitelistIntersection(facts) {
  const problems = [];
  const f = facts ?? {};
  for (const p of f.registryProblems ?? []) problems.push(`[registry] ${p.detail ?? JSON.stringify(p)}`);
  for (const c of f.cases ?? []) {
    const existing = c.existing instanceof Set ? c.existing : new Set(c.existing ?? []);
    for (const p of roleFilterProblems(c.role, c.mode, c.allow, existing)) problems.push(p);
    if (c.allow && !c.allow.includes(c.shellExpected)) {
      problems.push(`${c.role}/${c.mode}（${c.platform}）：allow 未包含组合的 shell 名 ${c.shellExpected}`);
    }
    if (c.allow && c.allow.includes(c.shellForbidden)) {
      problems.push(`${c.role}/${c.mode}（${c.platform}）：allow 含**另一平台**的 shell 名 ${c.shellForbidden}`);
    }
  }
  for (const inj of f.injections ?? []) {
    for (const p of inj.problems ?? []) problems.push(`[注入 ${inj.id}] ${p}`);
  }
  const nc = f.negativeControl;
  if (!nc || !Array.isArray(nc.problems) || nc.problems.length === 0) {
    problems.push(`负向对照失效：注入已知不存在的名字 ${f.absentTool ?? HARNESS_ABSENT_TOOL} 后判定仍全绿（断言可能是恒真的）`);
  }
  const shellSummary = (f.cases ?? []).map((c) => `${c.role}/${c.mode}@${c.platform}=${(c.allow ?? []).includes(c.shellExpected) ? c.shellExpected : "缺"}${(c.allow ?? []).includes(c.shellForbidden) ? `+越界${c.shellForbidden}` : ""}`);
  return {
    level: problems.length === 0 ? "PASS" : "FAIL",
    problems,
    detail: `三路径（含 minimal）+ 注入 ${(f.injections ?? []).length} 组；${shellSummary.join(" ")}；负向对照已判红`,
  };
}

// ---------------------------------------------------------------------------
// H3：派发可用（隔离实例端到端事实的判定）
// ---------------------------------------------------------------------------

export const H3_REQUIRED_ROLES = Object.freeze(["reviewer", "collector", "executor-minimal"]);
export const H3_FAILURE_SIGNATURES = Object.freeze([
  { id: "restrict-unknown", re: /tools\.restrict\(\)[^\n]*names unknown|names unknown global tool/ },
  { id: "spawn-failed", re: /子代理启动失败|child_error|startContinuable is not a function|startActivation is not a function/ },
]);

/**
 * 纯判定。facts = { attempted, roles: [{role, mode, childId, errors: [string]}], raw }
 * attempted=false ⇒ 返回 {level:"SKIP"}（调用方必须把 SKIP 显式标注为「需真机/实例」，禁止静默通过）。
 */
export function judgeDispatchAvailability(facts) {
  const f = facts ?? {};
  if (!f.attempted) {
    return {
      level: "SKIP",
      problems: [],
      detail: "跳过（需真机/实例）：未在隔离实例上真实派发 reviewer + collector + executor-minimal —— 不冒充通过",
    };
  }
  const problems = [];
  const byRole = new Map();
  for (const r of f.roles ?? []) byRole.set(String(r.role), r);
  for (const role of H3_REQUIRED_ROLES) {
    const got = byRole.get(role);
    if (!got) { problems.push(`未回传 ${role} 的派发事实（该路径本次未真实派发）`); continue; }
    if (!got.childId) problems.push(`${role}：child_id 为空（派发未真正成功）`);
    const errs = (got.errors ?? []).map((e) => String(e));
    for (const sig of H3_FAILURE_SIGNATURES) {
      const hit = errs.find((e) => sig.re.test(e));
      if (hit) problems.push(`${role}：命中失败签名 [${sig.id}] ${hit.slice(0, 120)}`);
    }
  }
  const detail = H3_REQUIRED_ROLES
    .map((r) => {
      const got = byRole.get(r);
      return `${r}=${got ? (got.childId ? "child_id✓" : "child_id∅") : "未回传"}`;
    })
    .join(" ");
  return { level: problems.length === 0 ? "PASS" : "FAIL", problems, detail };
}

// ---------------------------------------------------------------------------
// H4：路径分隔符与大小写语义
// ---------------------------------------------------------------------------

/** 纯判定。facts = {cases:[{name, kind:"reject"|"accept", threw, message, created, errnoLeak}], caseInjection:{...}} */
export function judgePathSeparatorSemantics(facts) {
  const problems = [];
  const f = facts ?? {};
  for (const c of f.cases ?? []) {
    if (c.kind === "reject") {
      if (!c.threw) problems.push(`附件名 ${JSON.stringify(c.name)} 未被拒绝（分隔符/越界语义被静默接受）`);
      if (c.created) problems.push(`附件名 ${JSON.stringify(c.name)} 被拒绝但仍落地了 ${c.created}`);
      if (c.errnoLeak) problems.push(`附件名 ${JSON.stringify(c.name)} 的拒绝文案泄漏平台错误码 ${c.errnoLeak}（应给可读文案）`);
      if (c.threw && String(c.message ?? "").trim().length < 6) problems.push(`附件名 ${JSON.stringify(c.name)} 的拒绝文案过短：${c.message}`);
    } else if (c.kind === "accept" && c.threw) {
      problems.push(`合法附件名 ${JSON.stringify(c.name)} 被拒绝：${c.message}`);
    }
  }
  const want = (f.cases ?? []).filter((c) => c.kind === "reject").length;
  if (want < 3) problems.push(`H4.a 拒绝侧用例过少（${want} 条）：判定可能退化`);
  return { level: problems.length === 0 ? "PASS" : "FAIL", problems, detail: f.detail ?? "" };
}

/** 纯判定。facts = {requested, actual, insensitive:{result}, sensitive:{result}} */
export function judgeCaseSemanticsInjection(facts) {
  const problems = [];
  const f = facts ?? {};
  const ins = f.insensitive?.result ?? null;
  const sen = f.sensitive?.result ?? null;
  if (f.insensitive?.error) problems.push(`注入大小写不敏感卷时抛错：${f.insensitive.error}`);
  if (f.sensitive?.error) problems.push(`注入大小写敏感卷时抛错：${f.sensitive.error}`);
  if (!ins) problems.push("注入「大小写不敏感卷」时未解析出别名（注入通道失效）");
  else {
    if (ins.aliased !== true) problems.push(`注入不敏感卷时 aliased=${ins.aliased}（应为 true）`);
    if (ins.actual !== f.actual) problems.push(`注入不敏感卷时解析到 ${ins.actual}，期望 ${f.actual}`);
  }
  if (sen) {
    if (sen.aliased === true && sen.actual !== f.requested) {
      problems.push(`注入「大小写敏感卷」时仍把 ${f.requested} 别名到 ${sen.actual}（卷语义注入不生效）`);
    }
  }
  const detail = `请求=${f.requested}；不敏感卷→${ins ? `${ins.actual}(aliased=${ins.aliased})` : "null"}；敏感卷→${sen ? `${sen.actual}(aliased=${sen.aliased})` : "null"}`;
  return { level: problems.length === 0 ? "PASS" : "FAIL", problems, detail };
}

// ---------------------------------------------------------------------------
// H5：CRLF/LF 与编码往返
// ---------------------------------------------------------------------------

/** 纯判定。facts = {description:{...}, results:{...}}；两个子面都必须成立。 */
export function judgeCrlfEncodingRoundTrip(facts) {
  const problems = [];
  const f = facts ?? {};
  const d = f.description ?? {};
  const r = f.results ?? {};
  if (!d.written) problems.push("目标正文写入失败（createGoal）");
  if (d.written) {
    if (d.loneCr) problems.push("goal.md 里出现孤立 \\r（CRLF 与 LF 混用的静默损坏）");
    if (!d.byteExact) problems.push("含 \\r\\n 与星平面字符的正文未逐字节写入 goal.md");
    if (!d.utf8Lossless) problems.push("goal.md 的 UTF-8 往返有损（解码后再编码 ≠ 原字节）");
  }
  if (!r.written) problems.push(`results 写入失败（writeAttemptResults：${r.reason ?? "未知"}）`);
  if (r.written) {
    if (r.loneCr) problems.push("results 文件里出现孤立 \\r");
    if (!r.headerFolded) problems.push("机器头字段里的 \\r\\n 未被折叠进同一行（存在字段注入/换行逃逸）");
    if (!r.injectedLineAbsent) problems.push("机器头注入文本在 results 里自成一行的痕迹（注入未被中和）");
    if (!r.bodyNoCr) problems.push("results 正文里的 \\r\\n 未归一为 LF");
    if (!r.bodyKeepsLines) problems.push("results 正文归一后丢失了逻辑行");
  }
  const detail = `正文：别名=${d.loneCr ? "有" : "无"} 逐字节=${d.byteExact ? "✓" : "✗"} utf8=${d.utf8Lossless ? "✓" : "✗"}；` +
    `机器头：折叠=${r.headerFolded ? "✓" : "✗"} 注入自成一行的痕迹=${r.injectedLineAbsent ? "无" : "有"} 正文归一=${r.bodyNoCr ? "✓" : "✗"}`;
  return { level: problems.length === 0 ? "PASS" : "FAIL", problems, detail };
}

// ---------------------------------------------------------------------------
// H6：命令拼接与引号（`--dsh` 单串 + cmd.exe 引号 + 真实 argv 传递）
// ---------------------------------------------------------------------------

/**
 * 纯判定。facts = {
 *   splitCases:  [{input, expected, got}],
 *   quoteCases:  [{args, expected, got}],
 *   lineCases:   [{cmd, args, expected, got}],
 *   argvCases:   [{args, got, ok}],      // shell:false 真实传递
 *   shellCases:  [{command, got, ok}],   // `sh -c <组合命令行>` 真实传递（POSIX 侧的组合命令代理）
 *   detail,
 * }
 */
export function judgeArgvQuoting(facts) {
  const problems = [];
  const f = facts ?? {};
  for (const p of f.problems ?? []) problems.push(p);
  const cmp = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const c of f.splitCases ?? []) {
    if (!cmp(c.got, c.expected)) problems.push(`splitCmd(${JSON.stringify(c.input)}) = ${JSON.stringify(c.got)}，期望 ${JSON.stringify(c.expected)}`);
  }
  for (const c of f.quoteCases ?? []) {
    if (!cmp(c.got, c.expected)) problems.push(`quoteForCmd(${JSON.stringify(c.args)}) = ${JSON.stringify(c.got)}，期望 ${JSON.stringify(c.expected)}`);
  }
  for (const c of f.lineCases ?? []) {
    if (c.got !== c.expected) problems.push(`buildShellCommandLine(${JSON.stringify(c.cmd)}, ${JSON.stringify(c.args)}) = ${JSON.stringify(c.got)}，期望 ${JSON.stringify(c.expected)}`);
  }
  for (const c of f.argvCases ?? []) {
    if (!c.ok) problems.push(`真实 argv 传递不一致：${JSON.stringify(c.args)} → ${JSON.stringify(c.got)}`);
  }
  for (const c of f.shellCases ?? []) {
    if (!c.ok) problems.push(`shell 组合命令传递不一致：${c.command} → ${JSON.stringify(c.got)}`);
  }
  if ((f.argvCases ?? []).length === 0) problems.push("缺少 shell:false 的真实 argv 传递用例（判定可能退化为纯字符串比较）");
  if ((f.shellCases ?? []).length === 0) problems.push("缺少 shell 组合命令的传递用例（cmd.exe/POSIX shell 面未实测）");
  return {
    level: problems.length === 0 ? "PASS" : "FAIL",
    problems,
    detail: (f.detail ?? "") + `；argv 用例 ${(f.argvCases ?? []).length} 条 / shell 组合 ${(f.shellCases ?? []).length} 条`,
  };
}

// ---------------------------------------------------------------------------
// H 系列运行器（两个执行件共用；只看事实，不做渲染）
// ---------------------------------------------------------------------------

/** 定位「真正会跑起来的那份 core」（已安装包优先，其次仓库 dist）。找不到返回 null。 */
export function resolveHarnessCoreDir(opts = {}) {
  const candidates = [];
  if (opts.coreDir) candidates.push(opts.coreDir);
  if (opts.pkgDir) candidates.push(join(opts.pkgDir, "core"));
  if (opts.repo) candidates.push(join(opts.repo, "dist", "core"));
  candidates.push(join(process.cwd(), "dist", "core"));
  for (const c of candidates) {
    if (c && existsSync(join(c, "ops.js"))) return c;
  }
  return null;
}

/**
 * 定位「仓库根」（H 层用来找 `dist/core`、`dsh-graph-host/index.js` 与两件执行件）。
 * 顺序：pkgDir 本身 → pkgDir 的父目录（`--static-only dist` 形态）→ cwd → cwd 的父目录。
 * 判定依据是「含 `scripts/win-smoke-test.mjs` 或 `dsh-graph-host/index.js`」；找不到时退回 cwd。
 */
export function resolveHarnessRepoRoot(opt = {}, pkgDir = null) {
  const candidates = [pkgDir, pkgDir ? dirname(pkgDir) : null, process.cwd(), join(process.cwd(), "..")].filter(Boolean);
  const seen = new Set();
  for (const c of candidates) {
    const abs = resolve(c);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (existsSync(join(abs, "scripts", "win-smoke-test.mjs")) || existsSync(join(abs, "dsh-graph-host", "index.js"))) return abs;
  }
  return resolve(process.cwd());
}

/**
 * 组合声明发现失败的统一提示（必须能被人直接照着做 —— g-477 真机教训：旧文案只给一个变量名，
 * 没告诉用户「去哪儿找」，真机上只能人肉摸索）。故附**可直接复制**的定位命令（Windows + POSIX）。
 * 保持**单行**（WARN 详情与「可复制回传的报告」都按单行渲染，多行会破坏粘贴块的可解析性）。
 */
export const HARNESS_COMPOSITION_HINT =
  "未找到 DSH 组合声明（presets/*.patch.yml / cordis.patch.yml）——可用 DSH_GATE_DSH_ROOT=<dir>（或 --dsh-root <dir>）显式指定 DSH 安装目录（或其 node_modules）。" +
  "先定位安装目录（可直接复制）——" +
  "Windows PowerShell：Get-ChildItem \"$env:APPDATA\\npm\\node_modules\\@deepseek-ai\"；" +
  "Get-ChildItem \"$env:LOCALAPPDATA\\npm-cache\\_npx\\*\\node_modules\\@deepseek-ai\"；" +
  "where.exe dsh；npm root -g。" +
  "POSIX：npm root -g；ls ~/.dsh/profiles/*/node_modules/@deepseek-ai；which -a dsh。" +
  "把命中的目录（或它的 node_modules）接到 --dsh-root / DSH_GATE_DSH_ROOT 上重跑。";

/** 目录扫描的上限与形状（本函数只走已知布局，不做全树递归 —— 组合文件很多、必须可控）。 */
export function collectCompositionFiles(roots) {
  const files = [];
  const seen = new Set();
  const add = (abs) => {
    const key = abs.replace(/\\/g, "/");
    if (seen.has(key)) return;
    seen.add(key);
    try { files.push({ path: key, text: readFileSync(abs, "utf8") }); } catch { /* 忽略 */ }
  };
  const scanScope = (scopeDir, depth, maxDepth) => {
    let names = [];
    try { names = readdirSync(scopeDir); } catch { return; }
    for (const n of names.sort()) {
      const pkgDir = join(scopeDir, n);
      let presetNames = [];
      try { presetNames = readdirSync(join(pkgDir, "presets")); } catch { presetNames = []; }
      for (const f of presetNames) {
        if (/\.patch\.ya?ml$/.test(f)) add(join(pkgDir, "presets", f));
      }
      for (const cand of ["cordis.patch.yml", "cordis.patch.yaml"]) {
        if (existsSync(join(pkgDir, cand))) add(join(pkgDir, cand));
      }
      if (depth < maxDepth) scanScope(join(pkgDir, "node_modules", "@deepseek-ai"), depth + 1, maxDepth);
    }
  };
  for (const r of roots) {
    for (const scope of [join(r, "node_modules", "@deepseek-ai"), join(r, "@deepseek-ai")]) {
      if (existsSync(scope)) scanScope(scope, 0, 2);
    }
    if (basename(r) === "@deepseek-ai") scanScope(r, 0, 2);
  }
  return files;
}

/** 插件自己注册的模型面向工具名（graph_*）；从宿主源码/编译产物里扫，避免凭空假设。 */
export function collectPluginToolNames(repo, pkgDir) {
  const names = new Set();
  const candidates = [pkgDir ? join(pkgDir, "index.js") : null, repo ? join(repo, "dsh-graph-host", "index.js") : null].filter(Boolean);
  for (const f of candidates) {
    let text = "";
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const m of text.matchAll(/name:\s*"(graph_[a-z0-9_]+)"/g)) names.add(m[1]);
    if (names.size > 0) break;
  }
  return names;
}

function loadHarnessComposition(ctx) {
  const roots = discoverDshRoots(ctx.repo, ctx.compositionRoots ?? []);
  if (roots.length === 0) return { found: false, roots: [], files: [], declarations: [], problems: [], descriptions: {} };
  const files = collectCompositionFiles(roots);
  const scanned = scanCompositionToolDeclarations(files);
  const descriptions = collectPackageDescriptions(roots);
  const audit = auditToolRegistry(scanned.declarations, { descriptions });
  return {
    found: files.length > 0 && scanned.declarations.length > 0,
    roots, files, declarations: scanned.declarations, descriptions,
    problems: [...scanned.problems, ...audit.problems],
  };
}

async function loadHarnessRuntime(ctx) {
  const coreDir = resolveHarnessCoreDir(ctx);
  if (!coreDir) return null;
  try {
    const ops = await import(pathToFileURL(join(coreDir, "ops.js")).href);
    let platform = null;
    if (existsSync(join(coreDir, "platform.js"))) {
      try { platform = await import(pathToFileURL(join(coreDir, "platform.js")).href); } catch { platform = null; }
    }
    return { coreDir, ops, platform };
  } catch (e) {
    return { coreDir, error: String(e?.message ?? e), ops: null, platform: null };
  }
}

const H_WARN = (detail, problems = []) => ({ level: "WARN", detail, problems });

async function runH1(ctx, deps) {
  if (!deps.runtime || !deps.runtime.ops) {
    return H_WARN(`未找到可导入的 core/ops.js（H1 需要 resolveShellTool 作为「插件解析」一侧）${deps.runtime?.error ? `：${deps.runtime.error}` : ""}`);
  }
  if (!deps.composition.found) return H_WARN(HARNESS_COMPOSITION_HINT, deps.composition.problems ?? []);
  const platforms = ["win32", "linux", "darwin"];
  const composition = {};
  const pluginProbe = {};
  const pluginFallback = {};
  for (const p of platforms) {
    composition[p] = compositionShellTools(deps.composition.declarations, p);
    const names = compositionToolNames(deps.composition.declarations, p).names;
    pluginProbe[p] = deps.runtime.ops.resolveShellTool({ platform: p, available: (n) => names.has(n) });
    pluginFallback[p] = deps.runtime.ops.resolveShellTool({ platform: p });
  }
  const currentShellSet = new Set(compositionShellTools(deps.composition.declarations, ctx.platform).tools);
  const currentResolved = deps.runtime.ops.resolveShellTool({ platform: ctx.platform, available: (n) => currentShellSet.has(n) });
  const verdict = judgeShellToolComposition({
    platforms, composition, pluginProbe, pluginFallback,
    registryProblems: deps.composition.problems, compositionProblems: [],
    currentPlatform: ctx.platform, currentResolved,
  });
  verdict.detail = `${verdict.detail}；组合来源=${deps.composition.files.length} 个声明文件`;
  return verdict;
}

async function runH2(ctx, deps) {
  if (!deps.runtime || !deps.runtime.ops) {
    return H_WARN(`未找到可导入的 core/ops.js（H2 需要 toolFilterForRole）${deps.runtime?.error ? `：${deps.runtime.error}` : ""}`);
  }
  if (!deps.composition.found) return H_WARN(HARNESS_COMPOSITION_HINT, deps.composition.problems ?? []);
  const ops = deps.runtime.ops;
  const graphNames = collectPluginToolNames(ctx.repo, ctx.pkgDir);
  if (graphNames.size === 0) return H_WARN("未扫描到 dsh-graph 自己注册的 graph_* 工具名（host index.js 不在扫描面）");
  const cases = [];
  const injections = [];
  const platforms = ["win32", "linux"];
  const roleCases = [
    ["reviewer", "standard"], ["reviewer", "minimal"],
    ["collector", "standard"], ["collector", "minimal"],
    ["executor", "minimal"],
  ];
  for (const p of platforms) {
    const derived = compositionToolNames(deps.composition.declarations, p);
    const existing = new Set([...derived.names, ...graphNames]);
    for (const [role, mode] of roleCases) {
      const filter = ops.toolFilterForRole(role, mode, { platform: p, available: (n) => existing.has(n) });
      const allow = Array.isArray(filter?.allow) ? [...filter.allow] : null;
      cases.push({
        role, mode, platform: p, allow, existing,
        shellExpected: p === "win32" ? "pwsh" : "bash",
        shellForbidden: p === "win32" ? "bash" : "pwsh",
      });
    }
  }
  // 注入①：组合缺 dsh-tool-web ⇒ web_* 必须被静默剔除（不炸）
  {
    const p = "linux";
    const derived = compositionToolNames(deps.composition.declarations, p);
    const noWeb = new Set([...[...derived.names].filter((n) => n !== "web_search" && n !== "web_fetch"), ...graphNames]);
    const filter = ops.toolFilterForRole("collector", "standard", { platform: p, available: (n) => noWeb.has(n) });
    const allow = Array.isArray(filter?.allow) ? filter.allow : [];
    const problems = [];
    if (allow.includes("web_search") || allow.includes("web_fetch")) problems.push("缺 dsh-tool-web 时 web_* 未被剔除（restrict() 会抛）");
    if (!allow.includes("read")) problems.push("剔除 web_* 时误伤了 read（求交过宽）");
    injections.push({ id: "no-tool-web", problems });
  }
  // 注入②：组合缺 shell ⇒ requiredTools 缺失必须给出可读诊断且不派发
  {
    const diag = ops.diagnoseDispatchCapability("reviewer", "minimal", { platform: "win32", available: () => false });
    const problems = [];
    if (diag.ok !== false) problems.push("探针判定 shell 缺失时 diagnoseDispatchCapability 仍返回 ok=true（缺能力被静默放行）");
    if (!/候选|missing|缺少/.test(String(diag.message ?? ""))) problems.push("缺能力诊断文案未点名缺失项/候选");
    const allow = ops.expandRoleToolList(["read", "<shell>"], { platform: "win32", available: () => false });
    if (allow.length !== 0) problems.push(`缺能力时 allow 仍非空：${JSON.stringify(allow)}`);
    injections.push({ id: "no-shell", problems });
  }
  // 注入③：求交本身必须真按探针裁剪（KNOWN-ABSENT 必须被剔除）
  {
    const p = "linux";
    const derived = compositionToolNames(deps.composition.declarations, p);
    const existing = new Set([...derived.names, ...graphNames]);
    const expanded = ops.expandRoleToolList(["read", HARNESS_ABSENT_TOOL], { platform: p, available: (n) => existing.has(n) });
    const problems = [];
    if (expanded.includes(HARNESS_ABSENT_TOOL)) problems.push(`expandRoleToolList 未剔除已知不存在的名字 ${HARNESS_ABSENT_TOOL}（求交失效）`);
    if (!expanded.includes("read")) problems.push("求交误伤了存在的名字 read");
    injections.push({ id: "absent-name-dropped", problems });
  }
  // 负向对照：把不存在名字塞进 allow ⇒ 判定必须判红（证明断言非恒真）
  const sample = cases.find((c) => c.role === "reviewer" && c.mode === "standard") ?? cases[0];
  const negativeControl = {
    problems: roleFilterProblems(sample.role, sample.mode, [...(sample.allow ?? []), HARNESS_ABSENT_TOOL], sample.existing),
  };
  const verdict = judgeRoleWhitelistIntersection({
    cases, injections, negativeControl, absentTool: HARNESS_ABSENT_TOOL,
    registryProblems: deps.composition.problems,
  });
  verdict.detail = `${verdict.detail}；组合工具名=${compositionToolNames(deps.composition.declarations, ctx.platform).names.size}+graph_*${graphNames.size}`;
  return verdict;
}

async function runH3(ctx) {
  const file = ctx.h3DispatchJson;
  if (!file) {
    return judgeDispatchAvailability({ attempted: false });
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { level: "FAIL", problems: [`H3 事实文件无法解析（${file}）：${String(e?.message ?? e)}`], detail: "" };
  }
  const roles = Array.isArray(raw?.roles) ? raw.roles : [];
  const verdict = judgeDispatchAvailability({ attempted: true, roles, raw });
  verdict.detail = `${verdict.detail}；事实来源=${file}`;
  return verdict;
}

async function runH4(ctx, deps) {
  if (!deps.runtime || !deps.runtime.ops) {
    return H_WARN(`未找到可导入的 core/ops.js（H4 需要 storeAttachment）${deps.runtime?.error ? `：${deps.runtime.error}` : ""}`);
  }
  if (!deps.runtime.platform) return H_WARN("未找到 dist/core/platform.js（H4.b 需要卷大小写语义注入）");
  const ops = deps.runtime.ops;
  const root = mkdtempSync(join(ctx.scratch, "h4-"));
  const cases = [];
  for (const [name, kind] of [["a\\b.txt", "reject"], ["/abs.txt", "reject"], ["../esc.txt", "reject"], ["a/b.txt", "accept"], ["ok.txt", "accept"]]) {
    let threw = false;
    let message = "";
    let created = null;
    try {
      created = ops.storeAttachment(root, { name, content: "h4", actor: "h4" });
    } catch (e) {
      threw = true;
      message = String(e?.message ?? e);
    }
    cases.push({ name, kind, threw, message, created: threw ? null : created, errnoLeak: platformErrorLeak(message) });
  }
  const detail = judgePathSeparatorSemantics({ cases, detail: cases.map((c) => `${c.name}=${c.threw ? "拒绝" : "接受"}`).join(" ") });
  let caseVerdict;
  try {
    const dir = mkdtempSync(join(ctx.scratch, "h4-case-"));
    writeFileSync(join(dir, "A.txt"), "1", "utf8");
    const requested = "a.txt";
    const actual = "A.txt";
    const run = (mode) => {
      try {
        return { result: deps.runtime.platform.withCaseInsensitiveVolumeForTesting(mode, () => deps.runtime.platform.resolveExistingEntry(dir, requested)) };
      } catch (e) {
        return { error: String(e?.message ?? e) };
      }
    };
    caseVerdict = judgeCaseSemanticsInjection({ requested, actual, insensitive: run(true), sensitive: run(false) });
  } catch (e) {
    caseVerdict = { level: "FAIL", problems: [`H4.b 探针异常：${String(e?.message ?? e)}`], detail: "" };
  }
  const problems = [...detail.problems, ...caseVerdict.problems];
  return {
    level: problems.length === 0 ? "PASS" : "FAIL",
    problems,
    detail: `分隔符：${detail.detail}；大小写注入：${caseVerdict.detail}`,
  };
}

async function runH5(ctx, deps) {
  if (!deps.runtime || !deps.runtime.ops) {
    return H_WARN(`未找到可导入的 core/ops.js（H5 需要 createGoal/writeAttemptResults）${deps.runtime?.error ? `：${deps.runtime.error}` : ""}`);
  }
  const ops = deps.runtime.ops;
  const root = mkdtempSync(join(ctx.scratch, "h5-"));
  ops.init(root);
  const description = "L1\r\nL2\r\nL3🙂尾";
  const goalId = ops.createGoal(root, { title: "H5 · CRLF 往返", version: "v1", description, actor: "h5" });
  const goalFile = ops.listGoalFiles(root, { includeArchived: true }).find((p) => /goal\.md$/.test(p));
  const dFacts = { written: false };
  if (goalFile && existsSync(goalFile)) {
    const raw = readFileSync(goalFile);
    const text = raw.toString("utf8");
    const block = text.slice(text.indexOf("## 目标描述"));
    dFacts.written = true;
    dFacts.loneCr = /\r(?!\n)/.test(text);
    dFacts.byteExact = block.includes(description);
    dFacts.utf8Lossless = Buffer.from(text, "utf8").equals(raw);
  }
  const wr = ops.writeAttemptResults(root, {
    goal: goalId, attempt: "att-001", source: "manual",
    actor: "h5\r\nINJECTED: yes", text: "body line1\r\nline2\n",
  });
  const rFacts = { written: Boolean(wr?.written), reason: wr?.reason ?? null };
  if (wr?.written && existsSync(wr.file)) {
    const rtext = readFileSync(wr.file, "utf8");
    const lines = rtext.split(/\r?\n/);
    const headerEnd = lines.findIndex((l) => /^-->\s*$/.test(l));
    const headerLines = headerEnd >= 0 ? lines.slice(0, headerEnd + 1) : lines.slice(0, 12);
    const bodyStart = lines.findIndex((l) => /^## att-001 完成摘要/.test(l));
    const body = bodyStart >= 0 ? lines.slice(bodyStart + 1).join("\n") : "";
    rFacts.loneCr = /\r(?!\n)/.test(rtext);
    rFacts.headerFolded = headerLines.some((l) => /^actor:\s/.test(l) && l.includes("INJECTED: yes")) &&
      headerLines.filter((l) => /^actor:\s/.test(l)).length === 1;
    rFacts.injectedLineAbsent = !lines.some((l) => /^INJECTED: yes\s*$/.test(l.trim()));
    rFacts.bodyNoCr = !/\r/.test(body);
    rFacts.bodyKeepsLines = body.includes("body line1") && body.includes("line2");
  }
  const verdict = judgeCrlfEncodingRoundTrip({ description: dFacts, results: rFacts });
  return verdict;
}

async function runH6(ctx, deps) {
  const problems = [];
  const splitCases = [
    { input: "npx -y @deepseek-ai/dsh", expected: ["npx", "-y", "@deepseek-ai/dsh"] },
    { input: "  npx   -y  @deepseek-ai/dsh@0.2.1-alpha.2 ", expected: ["npx", "-y", "@deepseek-ai/dsh@0.2.1-alpha.2"] },
    { input: '"C:\\Program Files\\node.exe" -y @deepseek-ai/dsh', expected: ["C:\\Program Files\\node.exe", "-y", "@deepseek-ai/dsh"] },
    { input: "node 'a b' c", expected: ["node", "a b", "c"] },
    { input: "", expected: [] },
  ].map((c) => ({ ...c, got: splitCmd(c.input) }));
  const quoteCases = [
    { args: ["plugin", "add", "D:\\my docs\\a.tgz"], expected: ["plugin", "add", '"D:\\my docs\\a.tgz"'] },
    { args: ["add", ".\\a.tgz"], expected: ["add", ".\\a.tgz"] },
    { args: ["a&b"], expected: ['"a&b"'] },
    { args: ["has space"], expected: ['"has space"'] },
    { args: ['"pre-quoted"'], expected: ['"pre-quoted"'] },
    { args: ["plain"], expected: ["plain"] },
  ].map((c) => ({ ...c, got: quoteForCmd(c.args) }));
  const lineCases = [
    { cmd: "npm", args: ["pack", "--ignore-scripts"], expected: "npm pack --ignore-scripts" },
    { cmd: "dsh.cmd", args: ["plugin", "add", "D:\\my docs\\a.tgz"], expected: 'dsh.cmd plugin add "D:\\my docs\\a.tgz"' },
  ].map((c) => ({ ...c, got: buildShellCommandLine(c.cmd, c.args) }));
  const ARGV_SRC = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
  const argvInputs = ["a b", 'a"b', "中 文", "C:\\x\\y", "a&b", "a^b", "$HOME", "line1\nline2", '"C:\\Program Files\\node.exe" -y'];
  const argvCases = [];
  for (const args of [argvInputs]) {
    const r = spawnSync(process.execPath, ["-e", ARGV_SRC, ...args], { encoding: "utf8", shell: false, timeout: 60_000 });
    let got = null;
    try { got = JSON.parse(r.stdout ?? "null"); } catch { got = null; }
    argvCases.push({ args, got, ok: JSON.stringify(got) === JSON.stringify(args) });
  }
  // 组合命令行的**真实传递**自检：`buildShellCommandLine` 的产物交给真 shell（win32 = cmd.exe，
  // POSIX = /bin/sh，与 `runSync` 的 `shell:true` 单字符串路径完全一致），参数必须逐字节到达。
  // 用「临时脚本文件 + 参数」而不是 `-e <代码>`：代码里含 `(`/`)` 等 POSIX 元字符，那是**被测函数
  // 的规则之外**（`quoteForCmd` 只按 cmd.exe 元字符集合加引号）—— 用它会把「规则不覆盖 POSIX 元字符」
  // 误判成失败。这里只问「组合命令行能否把参数原样送达」。
  const shellCases = [];
  const shellScript = join(ctx.scratch, "h6-argv-echo.mjs");
  writeFileSync(shellScript, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", "utf8");
  const shellInputs = ["a b", "中 文", "a&b", "a^b", "a|b", "a<b", "a>b", "plain"];
  const command = buildShellCommandLine(process.execPath, [shellScript, ...shellInputs]);
  const shellRun = spawnSync(command, { encoding: "utf8", shell: true, timeout: 60_000 });
  let shellGot = null;
  try { shellGot = JSON.parse(shellRun.stdout ?? "null"); } catch { shellGot = null; }
  shellCases.push({ command, got: shellGot, ok: JSON.stringify(shellGot) === JSON.stringify(shellInputs) });
  if (!shellCases[0].ok) {
    problems.push(`shell 组合命令执行/传递失败（shell=${isWin ? "cmd.exe" : "/bin/sh"} exit=${shellRun.status}）：${String(shellRun.stderr ?? "").trim().split("\n")[0] ?? ""}`);
  }
  return judgeArgvQuoting({
    splitCases, quoteCases, lineCases, argvCases, shellCases, problems,
    detail: `--dsh 单串按空白/引号分组；cmd.exe 元字符集合 [\\s"&^|<>]；argv 逐字节回传（含 ${isWin ? "cmd.exe" : "/bin/sh"} 组合命令行）`,
  });
}

/**
 * H 系列定向突变（g-475 变异对照）：把 g-473 的修复**原地回退**，断言 H 探针必红。
 * 每个突变都按**精确形状**匹配编译产物；形状不匹配即返回 null（绝不做一次静默无效的对照）。
 */
export const HARNESS_MUTANT_KINDS = Object.freeze([
  {
    kind: "no-intersection",
    probe: "H2",
    name: "突变H①：求交失效（expandRoleToolList 不再按探针裁剪）",
    apply: (src) => src.replace("if (probeAvailable(cap, name) === false)", "if (false)"),
  },
  {
    kind: "bash-only",
    probe: "H1",
    name: "突变H②：候选表退化为只认 bash（复现 g-473 病根）",
    apply: (src) => src.replace('SHELL_TOOL_CANDIDATES = ["bash", "pwsh"]', 'SHELL_TOOL_CANDIDATES = ["bash"]'),
  },
]);

/** 造 H 突变体；形状不匹配 ⇒ null。 */
export function buildToolCapabilityMutant(source, kind) {
  const entry = HARNESS_MUTANT_KINDS.find((m) => m.kind === kind);
  if (!entry || typeof source !== "string" || source.length === 0) return null;
  const text = entry.apply(source);
  if (typeof text !== "string" || text === source) return null;
  return { kind, text, bytes: text.length };
}

/** H 系列运行器表（清单的每个 id 都必须有运行器；多一个少一个都由审计判红）。 */
export const HARNESS_PROBE_RUNNERS = Object.freeze({
  H1: runH1, H2: runH2, H3: runH3, H4: runH4, H5: runH5, H6: runH6,
});

// ---------------------------------------------------------------------------
// 防漂移：清单穷尽性 + 「两件都消费」 + 变异对照
// ---------------------------------------------------------------------------

/** 把清单行规范化成对象（行格式 [id, requires, title, criterion]，也接受对象形式）。 */
export function harnessProbeRow(row) {
  if (Array.isArray(row)) return { id: row[0], requires: row[1], title: row[2], criterion: row[3] };
  return { ...(row ?? {}) };
}

/** 清单审计：穷尽性（H1..H6 一个不少、不多、不重）、每行齐备、每个 id 都有运行器（反之亦然）。 */
export function auditHarnessProbeManifest(rows, runners) {
  const problems = [];
  const list = (rows ?? []).map(harnessProbeRow);
  const ids = list.map((r) => r?.id);
  if (list.length !== HARNESS_PROBE_IDS.length) {
    problems.push({ kind: "count", detail: `清单 ${list.length} 项 ≠ 应有 ${HARNESS_PROBE_IDS.length} 项` });
  }
  for (const id of HARNESS_PROBE_IDS) {
    if (!ids.includes(id)) problems.push({ kind: "missing-probe", detail: `清单漏项 ${id}（探针清单必须穷尽）` });
  }
  for (const id of ids) {
    if (!HARNESS_PROBE_IDS.includes(id)) problems.push({ kind: "unknown-probe", detail: `清单含未登记的探针 id ${id}` });
  }
  const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  for (const id of dup) problems.push({ kind: "duplicate-probe", detail: `清单重复登记 ${id}` });
  const runnerIds = Object.keys(runners ?? {});
  for (const id of ids) {
    if (!runnerIds.includes(id)) problems.push({ kind: "missing-runner", detail: `探针 ${id} 没有运行器（清单登记了但跑不了）` });
  }
  for (const id of runnerIds) {
    if (!ids.includes(id)) problems.push({ kind: "orphan-runner", detail: `运行器 ${id} 不在清单里（实现与清单漂移）` });
  }
  for (const r of list) {
    if (!r?.id) continue;
    if (!r.title || String(r.title).trim().length < 4) problems.push({ kind: "row", detail: `${r.id} 缺少标题` });
    if (!r.criterion || String(r.criterion).trim().length < 20) problems.push({ kind: "row", detail: `${r.id} 判定口径过短（无法据此判读）` });
    if (!["offline", "composition", "dist", "instance"].includes(r.requires)) {
      problems.push({ kind: "row", detail: `${r.id} 的 requires 非法：${r.requires}` });
    }
  }
  return { problems };
}

/** 消费审计：两件执行件**都**调用 runHarnessProbes；清单定义恰好一份；消费件不得自行实现 H 判定。 */
export function auditHarnessProbeConsumers(files) {
  const problems = [];
  const list = files ?? [];
  const defs = list.filter((f) => String(f.text ?? "").includes(HARNESS_PROBE_DEFINITION_MARKER));
  if (defs.length !== 1) {
    problems.push({
      kind: "single-source",
      detail: `${HARNESS_PROBE_DEFINITION_MARKER} 必须恰好出现 1 次（单一真源），实际 ${defs.length} 次：${defs.map((f) => f.path).join(", ") || "（无）"}`,
    });
  }
  for (const path of HARNESS_PROBE_CONSUMER_FILES) {
    const f = list.find((x) => x.path === path);
    if (!f) { problems.push({ kind: "consumer-missing", detail: `缺少消费件 ${path}` }); continue; }
    if (!String(f.text ?? "").includes(HARNESS_PROBE_CONSUMER_MARKER)) {
      problems.push({ kind: "unconsumed", detail: `${path} 未消费共享清单（缺少 ${HARNESS_PROBE_CONSUMER_MARKER} 调用）` });
    }
  }
  const host = HARNESS_PROBE_CONSUMER_FILES[0];
  const judgeSymbols = [
    "judgeShellToolComposition", "judgeRoleWhitelistIntersection", "judgeDispatchAvailability",
    "judgePathSeparatorSemantics", "judgeCaseSemanticsInjection", "judgeCrlfEncodingRoundTrip",
    "judgeArgvQuoting", "HARNESS_PROBE_ROWS", "HARNESS_PROBE_RUNNERS",
  ];
  for (const f of list) {
    if (f.path === host) continue;
    for (const sym of judgeSymbols) {
      if (new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var)\\s+${sym}\\b`).test(String(f.text ?? ""))) {
        problems.push({ kind: "duplicate-definition", detail: `${f.path} 自行定义了 ${sym}（第二份并行定义 = 漂移）` });
      }
    }
  }
  return { problems };
}

/** 从仓库里读两件消费件的源码（供审计与守卫测试使用）。 */
export function collectHarnessProbeConsumerFiles(repo) {
  return HARNESS_PROBE_CONSUMER_FILES.map((path) => {
    try { return { path, text: readFileSync(join(repo, path), "utf8") }; } catch { return { path, text: "" }; }
  });
}

/** 一行可跨平台对比的矩阵结论（两件执行件都打印**同一形状**）。 */
export function formatHarnessProbeMatrix(platform, verdicts) {
  const cell = (v) => (v.level === "SKIP" ? `${v.id}=SKIP(需真机/实例)` : `${v.id}=${v.level}`);
  const list = (verdicts ?? []).map(cell).join(" ");
  return `harness 组合矩阵 | 平台=${platform} | ${list} | 清单=${HARNESS_PROBE_IDS.length} 项（单一真源，win-smoke + platform-smoke 两件消费）`;
}

/**
 * 运行 H1–H6（两件执行件共用的唯一入口）。
 * opts = { repo, pkgDir, coreDir, platform, scratch, compositionRoots, h3DispatchJson }
 * 返回 { verdicts, matrix, composition, runtime }；verdicts 每项 = 清单行 + {level, detail, problems}。
 */
export async function runHarnessProbes(opts = {}) {
  const repo = resolve(opts.repo ?? process.cwd());
  const ctx = {
    repo,
    pkgDir: opts.pkgDir ?? null,
    coreDir: opts.coreDir ?? null,
    platform: opts.platform ?? process.platform,
    compositionRoots: opts.compositionRoots ?? [],
    h3DispatchJson: opts.h3DispatchJson ?? process.env.DSH_GATE_H3_DISPATCH_JSON ?? null,
    scratch: opts.scratch ?? null,
  };
  if (!ctx.scratch) ctx.scratch = join(tmpdir(), "dsh-graph-harness-probes");
  mkdirSync(ctx.scratch, { recursive: true });
  // 必须 realpath：核心层对 root 含软链是**硬拒绝**（macOS 的 /var、/tmp 都是软链）
  try { ctx.scratch = realpathSync(ctx.scratch); } catch { /* 保持原路径 */ }
  const deps = {
    runtime: await loadHarnessRuntime(ctx),
    composition: loadHarnessComposition(ctx),
  };
  const verdicts = [];
  for (const row of HARNESS_PROBE_ROWS) {
    const def = harnessProbeRow(row);
    let verdict;
    const runner = HARNESS_PROBE_RUNNERS[def.id];
    if (typeof runner !== "function") {
      verdict = { level: "FAIL", problems: [`清单登记了 ${def.id} 但没有运行器`], detail: "" };
    } else {
      try {
        verdict = await runner(ctx, deps);
      } catch (e) {
        verdict = { level: "FAIL", problems: [`${def.id} 运行器异常：${String(e?.stack ?? e).split("\n").slice(0, 2).join(" | ")}`], detail: "" };
      }
    }
    verdicts.push({
      ...def,
      level: verdict?.level ?? "FAIL",
      detail: verdict?.detail ?? "",
      problems: verdict?.problems ?? [],
    });
  }
  return { verdicts, matrix: formatHarnessProbeMatrix(ctx.platform, verdicts), composition: deps.composition, runtime: deps.runtime };
}

/** 最近一次 H 层结果（供 summarize 打印矩阵行；两件执行件各自持有）。 */
let lastHarnessProbeRun = null;

/** H 层的机器可读摘要（进 --json）。 */
export function harnessProbeSummary(run) {
  if (!run) return null;
  return {
    matrix: run.matrix,
    items: run.verdicts.map((v) => ({ id: v.id, level: v.level, requires: v.requires, title: v.title })),
    compositionFiles: run.composition?.files?.length ?? 0,
    compositionRoots: run.composition?.roots ?? [],
  };
}

/**
 * 在门禁流水线里跑 H1–H6 并逐条记为 T1 账（`--static-only` 与完整门禁**共用**本函数 —— 同一实现）。
 * opts: { repo, pkgDir, coreDir, compositionRoots, scratch }
 */
export async function harnessProbeLayer(opt, opts = {}) {
  head("T1 harness 组合探针层（H1–H6：harness 组合 / OS 行为差异）");
  const run = await runHarnessProbes({
    repo: opts.repo ?? process.cwd(),
    pkgDir: opts.pkgDir ?? null,
    coreDir: opts.coreDir ?? null,
    platform: process.platform,
    compositionRoots: [...(opt?.dshRoots ?? []), ...(opts.compositionRoots ?? [])],
    h3DispatchJson: opt?.h3DispatchJson ?? null,
    scratch: opts.scratch ?? null,
  });
  for (const v of run.verdicts) {
    record("T1", `H · ${v.id} ${v.title}`, v.level,
      `${v.detail}${v.problems.length > 0 ? ` :: ${v.problems.slice(0, 3).join(" ; ")}` : ""}`);
  }
  console.log(run.matrix);
  if (run.composition?.roots?.length) {
    console.log(`组合来源：${run.composition.files.length} 个声明文件（${run.composition.roots.join(", ")}）`);
  }
  coverage.harness = {
    total: run.verdicts.length,
    pass: run.verdicts.filter((v) => v.level === "PASS").length,
    skip: run.verdicts.filter((v) => v.level === "SKIP").length,
    problems: run.verdicts.filter((v) => v.level === "FAIL").length,
  };
  lastHarnessProbeRun = run;
  return run;
}

/** 定位已构建包（含 core/ops.js）：--pkg 优先，其次 <仓库根>/dist、<cwd>/dist。 */
function findBuiltPackage(opt = {}) {
  const candidates = [];
  if (opt.pkg) candidates.push(opt.pkg);
  const srcRoot = resolveProductSourceRoot(process.cwd());
  if (srcRoot) candidates.push(join(srcRoot, "dist"));
  candidates.push(join(process.cwd(), "dist"));
  for (const c of candidates) {
    if (existsSync(join(c, "core", "ops.js"))) return c;
  }
  return null;
}

/** 突变副本的工作目录：尽量落在能找到 node_modules 的祖先下（core/ops.js 运行期 import yaml）。 */
function scratchBaseFor(pkgDir) {
  let dir = pkgDir;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, "node_modules"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return tmpdir();
}

/**
 * 负向对照（g-428 A4）：对**已构建包**的 core/ops.js 做定向突变，断言对应功能检查**必红**。
 *   ① 基线对照：未突变 + 同一夹具 ⇒ 必须全绿（否则突变对照本身无效）；
 *   ② old-order：还原 g-427 旧顺序 ⇒ 必须在 g-427 形态步骤上变红，且文案泄漏 EPERM（证明卫生断言有鉴别力）；
 *   ③ copy-dup ：搬迁退化为复制 ⇒ 必须报出「双份」。
 * 突变形状不匹配即**拒绝**（返回 null），不允许静默地做一次无效对照。
 */
function mutationCheck(opt) {
  head("负向对照（g-428）：定向突变必须让对应检查变红");
  const pkgDir = findBuiltPackage(opt);
  if (!pkgDir) {
    record("M", "负向对照前置（已构建包）", "FAIL",
      "未找到 core/ops.js —— 请先在隔离 worktree 里跑 `bash scripts/build.sh`（或用 --pkg 指定 dist 目录）");
    return false;
  }
  const opsPath = join(pkgDir, "core", "ops.js");
  const source = readFileSync(opsPath, "utf8");
  console.log(`突变目标包：${pkgDir}`);
  let allOk = true;

  // ① 突变开关自身可信：形状不匹配必须返回 null（否则对照静默无效）
  const probe = buildOsJsMutant(source, "old-order");
  const noop = buildOsJsMutant("function other() {}\n", "old-order");
  const switchOk = Boolean(probe) && probe.text !== source && probe.text.includes("EPERM") && noop === null;
  record("M", "突变开关可信（形状不匹配即拒绝）", switchOk ? "PASS" : "FAIL",
    switchOk
      ? `已识别 renameDirInto（原 ${probe.original.split("\n").length} 行 → 突变 ${probe.mutated.split("\n").length} 行）；缺失形状返回 null`
      : "buildOsJsMutant 形状识别失效（对照可能静默无效）—— 请同步 buildOsJsMutant 与 core/ops.ts");
  if (!switchOk) allOk = false;

  const workRoot = join(scratchBaseFor(pkgDir), "tmp", `win-smoke-mutation-${Date.now()}`);
  const smokeDir = join(workRoot, "smoke");
  mkdirSync(smokeDir, { recursive: true });

  // ② 基线对照
  const baseline = runCoreSmoke(smokeDir, opsPath, join(workRoot, "root-baseline"));
  const bFailed = (baseline.parsed?.steps ?? []).filter((s) => !s.ok);
  if (baseline.parsed?.ok) {
    coverage.smokeSteps = baseline.parsed.steps.length;
    record("M", "基线对照（未突变，同一夹具）", "PASS",
      `${baseline.parsed.steps.length} 步全通过、validate 空 —— 突变对照有可比基线`);
  } else {
    allOk = false;
    record("M", "基线对照（未突变，同一夹具）", "FAIL",
      "基线在同一夹具下已红 ⇒ 突变对照无意义 :: " +
      (bFailed.length ? `${bFailed[0].id}: ${bFailed[0].err}` : `子进程 exit=${baseline.r.code}`));
  }

  const mutants = [
    {
      kind: "old-order",
      name: "突变①：还原 g-427 旧顺序（先建目标目录再 rename）",
      judge: (parsed) => {
        const failed = parsed.steps.filter((s) => !s.ok);
        const first = failed[0];
        const problems = [];
        if (parsed.ok) problems.push("突变后仍然全绿（对照没有鉴别力）");
        if (!first) problems.push("未产出失败步骤（子进程异常？）");
        else if (!G427_FORM_STEP_IDS.includes(first.id)) {
          problems.push(`首个失败步骤是 ${first.id}（不在 g-427 形态步骤里：${G427_FORM_STEP_IDS.join(", ")}）`);
        }
        const leak = first ? platformErrorLeak(first.err) : null;
        if (!leak) problems.push("失败文案未出现平台错误码 —— 「不泄漏错误码」这条断言将失去鉴别力");
        return { problems, note: first ? `首个失败步骤=${first.id}；文案泄漏=${leak}` : "" };
      },
    },
    {
      kind: "copy-dup",
      name: "突变②：搬迁退化为复制（残留双份）",
      judge: (parsed) => {
        const problems = [];
        if (parsed.ok) problems.push("突变后仍然全绿（对照没有鉴别力）");
        const copies = parsed.board?.copies ?? {};
        const dup = Object.entries(copies).filter(([, n]) => Number(n) > 1);
        const failed = parsed.steps.filter((s) => !s.ok);
        const mentioned = failed.some((s) => /双份|出现 2 份|在板上出现/.test(s.err ?? ""));
        if (dup.length === 0 && !mentioned) {
          problems.push("未检出双份（既无盘面副本数 >1，也无「在板上出现 N 份」断言）");
        }
        return { problems, note: `副本数=${JSON.stringify(copies)}；双份检出=${dup.length > 0 || mentioned}` };
      },
    },
  ];

  for (const m of mutants) {
    const built = buildOsJsMutant(source, m.kind);
    if (!built) {
      allOk = false;
      record("M", m.name, "FAIL", "突变未生效（renameDirInto 形状已变）");
      continue;
    }
    const dest = join(workRoot, `pkg-${m.kind}`);
    mkdirSync(dest, { recursive: true });
    cpSync(join(pkgDir, "core"), join(dest, "core"), { recursive: true });
    writeFileSync(join(dest, "core", "ops.js"), built.text, "utf8");
    const res = runCoreSmoke(smokeDir, join(dest, "core", "ops.js"), join(workRoot, `root-${m.kind}`));
    if (!res.parsed) {
      allOk = false;
      record("M", m.name, "FAIL", `突变包未产出结果（exit=${res.r.code}）：${(res.r.err || "").trim().split(/\r?\n/)[0] ?? ""}`);
      continue;
    }
    const verdict = m.judge(res.parsed);
    if (verdict.problems.length === 0) {
      record("M", m.name, "PASS", `必红已实拍 —— ${verdict.note}`);
    } else {
      allOk = false;
      record("M", m.name, "FAIL", verdict.problems.join(" | ") + (verdict.note ? ` :: ${verdict.note}` : ""));
    }
  }

  // ---- H 系列负向对照（g-475）：把 g-473 的修复回退后，H1/H2 必须判红 ----
  allOk = mutationCheckHarness(opt, { pkgDir, source, workRoot }) && allOk;

  if (!opt.keep) {
    try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
  } else {
    console.log(`保留突变工作目录：${workRoot}（--keep）`);
  }
  return allOk;
}

/**
 * H 系列负向对照（g-475）：① 基线（未突变）必须 H1/H2 全绿 —— 否则对照无意义；
 * ② 每个 H 突变体必须让**指定探针**判红（且红因指向被回退的那条断言）。
 * 突变形状不匹配即判红（拒绝静默无效对照）。返回是否全部符合。
 */
function mutationCheckHarness(opt, ctx) {
  const { pkgDir, source, workRoot } = ctx;
  let ok = true;
  const repo = resolveHarnessRepoRoot(opt, pkgDir);

  // ① 基线：未突变 ⇒ H1/H2 必须 PASS（对照的「绿」半边）
  const baselineRun = runHarnessProbesSync(repo, pkgDir, join(workRoot, "h-baseline"));
  const baseBad = ["H1", "H2"].map((id) => baselineRun?.verdicts?.find((v) => v.id === id)).filter((v) => !v || v.level !== "PASS");
  if (!baselineRun) {
    ok = false;
    record("M", "H 突变基线对照（未突变）", "FAIL", "基线未能产出 H 探针结果（runHarnessProbes 抛错）");
  } else if (baseBad.length > 0) {
    ok = false;
    record("M", "H 突变基线对照（未突变）", "FAIL",
      `基线已红 ⇒ H 突变对照无意义 :: ${baseBad.map((v) => `${v?.id}=${v?.level}${v?.problems?.length ? `（${v.problems[0]}）` : ""}`).join(" ; ")}`);
  } else {
    record("M", "H 突变基线对照（未突变）", "PASS", "H1/H2 在未突变包上全绿 —— 突变对照有可比基线");
  }

  // ② 突变体：指定探针必须判红
  for (const m of HARNESS_MUTANT_KINDS) {
    const built = buildToolCapabilityMutant(source, m.kind);
    if (!built) {
      ok = false;
      record("M", m.name, "FAIL",
        "突变未生效（编译产物形状已变）—— 请同步 buildToolCapabilityMutant 与 core/ops.ts");
      continue;
    }
    const dest = join(workRoot, `pkg-h-${m.kind}`);
    mkdirSync(join(dest, "core"), { recursive: true });
    cpSync(join(pkgDir, "core"), join(dest, "core"), { recursive: true });
    writeFileSync(join(dest, "core", "ops.js"), built.text, "utf8");
    const run = runHarnessProbesSync(repo, dest, join(workRoot, `h-${m.kind}`));
    const verdict = run?.verdicts?.find((v) => v.id === m.probe);
    if (!verdict) {
      ok = false;
      record("M", m.name, "FAIL", `突变包未产出 ${m.probe} 结果（子进程/导入异常）`);
      continue;
    }
    if (verdict.level === "FAIL") {
      const first = verdict.problems[0] ?? "(无红因说明)";
      record("M", m.name, "PASS", `必红已实拍 —— ${m.probe} 判红，首条红因：${String(first).slice(0, 160)}`);
    } else {
      ok = false;
      record("M", m.name, "FAIL",
        `突变后 ${m.probe} 仍为 ${verdict.level}（对照没有鉴别力）:: ${verdict.detail}`);
    }
  }
  return ok;
}

/** 同步阻塞地跑一次 H 探针（`--mutation-check` 是同步流水线，沿用 spawnSync 子进程语义）。 */
function runHarnessProbesSync(repo, pkgDir, scratch) {
  try {
    const r = spawnSync(process.execPath, [
      "-e",
      "import(process.argv[1]).then(m=>m.runHarnessProbes({repo:process.argv[2],pkgDir:process.argv[3],scratch:process.argv[4],platform:process.argv[5]})).then(x=>process.stdout.write(JSON.stringify(x.verdicts))).catch(e=>{process.stderr.write(String(e&&e.stack||e));process.exitCode=1;})",
      pathToFileURL(join(repo, "scripts", "win-smoke-test.mjs")).href,
      repo, pkgDir, scratch, process.platform,
    ], { encoding: "utf8", shell: false, timeout: 300_000 });
    if (r.status !== 0) {
      console.log(`  （H 突变子进程 exit=${r.status}：${String(r.stderr ?? "").trim().split("\n")[0] ?? ""}）`);
      return null;
    }
    const verdicts = JSON.parse(r.stdout);
    return { verdicts };
  } catch (e) {
    console.log(`  （H 突变子进程异常：${String(e?.message ?? e)}）`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// T3 核心运行时：直接调用安装后的 core/ops.js（完整看板文件系统生命周期）
// ---------------------------------------------------------------------------

const CORE_SMOKE_SRC = `
import { pathToFileURL } from "node:url";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

const [opsPath, root] = process.argv.slice(2);
const out = { steps: [], ok: false, board: null, validate: null };
const ops = await import(pathToFileURL(opsPath).href);

// g-427 形态的末级目录搬迁（renameDirInto）只在「目录形态 → 目录形态」时发生。
const V1 = "v-win-smoke";
const V2 = "v2-smoke";
const S = {};
const actor = "win-smoke";
// 几乎不可能存活的 PID（Linux pid_max 默认 4194304）：模拟「锁持有者进程已死」。
// 不用 2^31 以上的值——那会让 process.kill 抛 ERR_OUT_OF_RANGE，被保守判为「存活」。
const DEAD_PID = 2000000000;

const relOf = (p) => relative(root, p).split(sep).join("/");

const step = (id, label, fn) => {
  try {
    const v = fn();
    out.steps.push({ id, label, ok: true });
    return v;
  } catch (e) {
    out.steps.push({ id, label, ok: false, err: String((e && e.message) || e) });
    throw e;
  }
};

/** 盘面工具（断言「最终盘面」，不是「调用没抛错」）。 */
const goalFiles = () => ops.listGoalFiles(root, { includeArchived: true });

const copiesOf = (id) => {
  const hits = [];
  for (const f of goalFiles()) {
    try {
      if (String(ops.loadGoal(f).meta.id) === String(id)) hits.push(relOf(f));
    } catch { /* 坏文件由 validate 报告 */ }
  }
  return hits;
};

const eventsCount = (name) => {
  const f = join(root, "events.jsonl");
  if (!existsSync(f)) return 0;
  let n = 0;
  for (const line of readFileSync(f, "utf8").split(/\\r?\\n/)) {
    if (line.indexOf('"' + name + '"') >= 0) n++;
  }
  return n;
};

/**
 * 每个布局操作后的**盘面断言**：源位置已消失、目标存在且内容完整、全板计数唯一（无双份）。
 * 只断言「调用没抛错」是 0.18.0 漏检的形态本身，故这里逐项核对磁盘真相。
 */
const assertBoard = (id, expect) => {
  const copies = copiesOf(id);
  if (copies.length !== 1) {
    throw new Error("盘面断言失败：目标 " + id + " 在板上出现 " + copies.length + " 份（期望 1）→ " + copies.join(", "));
  }
  if (copies[0] !== expect.at) {
    throw new Error("盘面断言失败：目标 " + id + " 位于 " + copies[0] + "（期望 " + expect.at + "）");
  }
  for (const gone of expect.gone || []) {
    if (existsSync(join(root, gone))) throw new Error("盘面断言失败：源位置未消失 " + gone);
  }
  const abs = join(root, expect.at);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error("盘面断言失败：目标文件不存在 " + expect.at);
  const body = readFileSync(abs, "utf8");
  if (body.indexOf("## 目标描述") < 0) throw new Error("盘面断言失败：目标文件内容不完整（缺「目标描述」小节）" + expect.at);
  if (basename(abs) === "goal.md") {
    const dir = dirname(abs);
    if (expect.cards && !existsSync(join(dir, "cards"))) {
      throw new Error("盘面断言失败：cards/ 未随目录整体搬迁 " + expect.at);
    }
    if (expect.noCards && existsSync(join(dir, "cards"))) {
      throw new Error("盘面断言失败：不该有 cards/ " + expect.at);
    }
    if (expect.attempts && !existsSync(join(dir, "attempts"))) {
      throw new Error("盘面断言失败：attempts/ 未随目录整体搬迁 " + expect.at);
    }
  }
};

/** 把目录 mtime 推到 30s 之前（锁的陈旧判定阈值）。 */
const agePath = (p) => {
  const old = new Date(Date.now() - 120000);
  utimesSync(p, old, old);
};

/** 最终盘面总览：双份 / 残留空目标目录 / 锁与临时产物 / 诊断事件计数。 */
const boardSummary = () => {
  const copies = {};
  for (const f of goalFiles()) {
    let id;
    try { id = String(ops.loadGoal(f).meta.id); } catch { continue; }
    copies[id] = (copies[id] || 0) + 1;
  }
  const emptyGoalDirs = [];
  const lockArtifacts = [];
  const LOCK_RE = /\\.tags\\.lock|\\.lock\\.|\\.bak-|\\.trash-|\\.reclaim-|\\.release-|\\.tags-|\\.tmp$|\\.tmp\\./;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (/^g-\\d+$/.test(e.name)) {
          let inner = [];
          try { inner = readdirSync(abs); } catch { /* 忽略 */ }
          if (inner.length === 0) emptyGoalDirs.push(relOf(abs));
        }
        if (LOCK_RE.test(e.name)) lockArtifacts.push(relOf(abs));
        walk(abs);
      } else if (LOCK_RE.test(e.name)) {
        lockArtifacts.push(relOf(abs));
      }
    }
  };
  for (const sub of ["backlog", "goals", "versions", "shared-cards", "memory", "attachments"]) {
    if (existsSync(join(root, sub))) walk(join(root, sub));
  }
  let top = [];
  try { top = readdirSync(root, { withFileTypes: true }); } catch { /* 忽略 */ }
  for (const e of top) {
    if (/^\\.lock\\./.test(e.name) || /\\.tmp\\./.test(e.name) || /\\.bak-/.test(e.name) || LOCK_RE.test(e.name)) {
      if (!/^events\\.jsonl$|^index\\.json$|^rules\\.md$|^project\\.yaml$|^next-seq\\.json$/.test(e.name)) {
        lockArtifacts.push(e.name);
      }
    }
  }
  return {
    copies,
    emptyGoalDirs: [...new Set(emptyGoalDirs)].sort(),
    lockArtifacts: [...new Set(lockArtifacts)].sort(),
    persistFailed: eventsCount("tx.persist_failed"),
    // 本次冒烟**有意**触发一次 persist 失败（预置非空目标目录）⇒ 期望计数恰为 1（正常路径另有断言）
    persistFailedExpected: 1,
    attachments: (() => { try { return ops.listAttachments(root); } catch { return []; } })(),
  };
};

const flow = () => {
  ops.init(root);

  // ---- ① 既有步骤（只增不减）：建目标 / 判据 / 标签锁 / CAS ----
  S.p = step("T3.init_create", "init+createGoal", () =>
    ops.createGoal(root, { title: "windows smoke", version: V1, actor }));
  out.goal = S.p;
  step("T3.set_criteria", "setCriteria", () => ops.setCriteria(root, S.p, ["冒烟判据 A", "冒烟判据 B"], actor));
  step("T3.tags_write", "setGoalTags 写入", () => ops.setGoalTags(root, S.p, { tags: ["alpha", "中文标签"], actor }));
  step("T3.tags_cas_overwrite", "setGoalTags CAS 覆盖", () =>
    ops.setGoalTags(root, S.p, { tags: ["beta"], base_tags: ["alpha", "中文标签"], actor }));
  step("T3.tags_cas_conflict", "setGoalTags CAS 冲突应被拒", () => {
    try { ops.setGoalTags(root, S.p, { tags: ["nope"], base_tags: ["不匹配"], actor }); }
    catch { return; }
    throw new Error("base_tags 不匹配时未拒绝写入");
  });
  step("T3.tags_clear", "setGoalTags 清空(force)", () => ops.setGoalTags(root, S.p, { tags: [], force: true, actor }));
  assertBoard(S.p, { at: "versions/" + V1 + "/goals/" + S.p + "/goal.md" });

  // ---- ② 目录形态 ↔ 扁平形态互转（每一步都触发真实的目录搬迁）----
  step("T3.layout_s1_create", "布局：创建独立目标（目录形态）", () => {
    S.s1 = ops.createGoal(root, { title: "layout smoke", version: "standalone", actor });
    assertBoard(S.s1, { at: "goals/" + S.s1 + "/goal.md" });
  });
  step("T3.layout_s1_to_version", "布局：独立(目录) → 版本(目录)", () => {
    ops.moveGoal(root, S.s1, { to: "version", version: V1, actor });
    assertBoard(S.s1, { at: "versions/" + V1 + "/goals/" + S.s1 + "/goal.md", gone: ["goals/" + S.s1] });
  });
  step("T3.layout_s1_to_standalone", "布局：版本(目录) → 独立(目录)", () => {
    ops.moveGoal(root, S.s1, { to: "standalone", actor });
    assertBoard(S.s1, { at: "goals/" + S.s1 + "/goal.md", gone: ["versions/" + V1 + "/goals/" + S.s1] });
  });
  step("T3.layout_s1_to_backlog", "布局：独立(目录) → backlog(扁平)", () => {
    ops.moveGoal(root, S.s1, { to: "backlog", actor });
    assertBoard(S.s1, { at: "backlog/" + S.s1 + ".md", gone: ["goals/" + S.s1] });
  });
  step("T3.layout_s1_to_standalone_again", "布局：backlog(扁平) → 独立(目录)", () => {
    ops.moveGoal(root, S.s1, { to: "standalone", actor });
    assertBoard(S.s1, { at: "goals/" + S.s1 + "/goal.md", gone: ["backlog/" + S.s1 + ".md"] });
  });

  // ---- ③ 卡片 / attempts / 附件（目录内容完整性）----
  step("T3.cards_own_and_shared", "卡片：目标自有卡 + 共享卡", () => {
    S.ownCard = ops.addCard(root, S.p, { title: "自有卡", scope: "goal", actor });
    S.sharedCard = ops.addCard(root, S.p, { title: "共享卡", actor });
    const pdir = "versions/" + V1 + "/goals/" + S.p;
    if (!existsSync(join(root, pdir, "cards", S.ownCard + ".md"))) throw new Error("目标自有卡未落盘");
    if (!existsSync(join(root, "shared-cards", S.sharedCard + ".md"))) throw new Error("共享卡未落盘");
    const refs = ops.loadGoal(join(root, pdir, "goal.md")).meta.context_cards;
    if (!Array.isArray(refs) || refs.indexOf(S.ownCard) < 0) throw new Error("目标未引用自有卡");
    if (refs.indexOf(S.sharedCard) < 0) throw new Error("目标未引用共享卡");
  });
  step("T3.attempts_dir_present", "attempts 子目录（随目标整体搬迁）", () => {
    const adir = join(root, "versions", V1, "goals", S.p, "attempts", "att-001");
    mkdirSync(adir, { recursive: true });
    writeFileSync(join(adir, "attempt.md"),
      "---\\n{\\n  \\"id\\": \\"att-001\\",\\n  \\"result\\": \\"done\\",\\n  \\"detached\\": true,\\n  \\"status_line\\": \\"完成\\"\\n}\\n---\\n\\n（win-smoke 夹具）\\n", "utf8");
    if (!existsSync(join(adir, "attempt.md"))) throw new Error("attempts 夹具未写入");
  });
  step("T3.attachments_store_delete", "附件：存储 + 原子删除（trash 往返）", () => {
    const keep = ops.storeAttachment(root, { name: "smoke-keep.txt", content: "keep\\n", actor });
    const gone = ops.storeAttachment(root, { name: "smoke-gone.txt", content: "gone\\n", actor });
    if (!ops.listAttachments(root).includes(keep)) throw new Error("附件未落盘：" + keep);
    ops.deleteAttachment(root, gone, { actor });
    if (ops.listAttachments(root).includes(gone)) throw new Error("附件删除后仍在列表：" + gone);
    if (existsSync(join(root, "attachments", gone))) throw new Error("附件删除后文件仍在");
    const left = readdirSync(join(root, "attachments")).filter((n) => n.indexOf(".trash-") === 0);
    if (left.length > 0) throw new Error("附件删除留下 trash 残留：" + left.join(", "));
  });

  // ---- ④ 记忆写入（memory 锁 + jsonl fsync 的真跑）----
  step("T3.memory_roundtrip", "记忆写入往返（memory 锁 + jsonl）", () => {
    const added = ops.addMemory(root, { kind: "project", text: "win-smoke 记忆往返", actor });
    if (!ops.readMemory(root).some((m) => m.id === added.id)) throw new Error("记忆写入后读不回");
    ops.removeMemory(root, { old: "win-smoke 记忆往返", actor, reason: "win-smoke 往返清理" });
    if (ops.readMemory(root).some((m) => m.id === added.id)) throw new Error("记忆删除后仍在");
  });

  // ---- ⑤ 锁：事务锁与标签锁的获取/释放 + 陈旧回收（Windows 分支同样真跑）----
  step("T3.tx_lock_reclaim", "事务锁：正常释放 + 死进程抢占 + 坏锁隔离回收", () => {
    const lock = join(root, ".lock.project.yaml");
    ops.writeSupervisorSession(root, "win-smoke-session", actor);
    if (existsSync(lock)) throw new Error("事务锁未释放：" + lock);
    writeFileSync(lock, String(DEAD_PID), "utf8");
    agePath(lock);
    ops.writeSupervisorSession(root, "win-smoke-session-2", actor);
    if (existsSync(lock)) throw new Error("死进程事务锁未被抢占/释放：" + lock);
    writeFileSync(lock, "", "utf8");
    agePath(lock);
    ops.writeSupervisorSession(root, "win-smoke-session-3", actor);
    if (existsSync(lock)) throw new Error("身份不可解析的坏锁未被回收：" + lock);
  });
  step("T3.tags_lock_stale_reclaim", "标签锁：陈旧锁回收（死 PID + 过期 mtime）", () => {
    const file = ops.findGoalFile(root, S.s1);
    const lockDir = file + ".tags.lock";
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner"), DEAD_PID + ":00000000-0000-4000-8000-000000000000", "utf8");
    agePath(lockDir);
    ops.setGoalTags(root, S.s1, { tags: ["reclaimed"], actor });
    if (existsSync(lockDir)) throw new Error("陈旧标签锁未被回收：" + lockDir);
    const doc = ops.loadGoal(ops.findGoalFile(root, S.s1));
    if (JSON.stringify(doc.meta.tags) !== JSON.stringify(["reclaimed"])) throw new Error("回收后标签未写入");
  });

  // ---- ⑥ 完整生命周期（g-427 形态：目录形态搬迁真的发生）----
  step("T3.lifecycle_move_dir_with_extras", "生命周期：版本目录形态(含 cards/attempts) → 独立", () => {
    ops.moveGoal(root, S.p, { to: "standalone", actor });
    assertBoard(S.p, {
      at: "goals/" + S.p + "/goal.md",
      gone: ["versions/" + V1 + "/goals/" + S.p],
      cards: true, attempts: true,
    });
  });
  step("T3.lifecycle_move_back_to_version", "生命周期：独立(目录) → 版本(目录)", () => {
    ops.moveGoal(root, S.p, { to: "version", version: V1, actor });
    assertBoard(S.p, {
      at: "versions/" + V1 + "/goals/" + S.p + "/goal.md",
      gone: ["goals/" + S.p],
      cards: true, attempts: true,
    });
  });
  step("T3.lifecycle_archive_version_form", "生命周期：版本目录形态归档", () => {
    ops.archiveGoal(root, S.p, { actor });
    assertBoard(S.p, {
      at: "versions/" + V1 + "/archived/" + S.p + "/goal.md",
      gone: ["versions/" + V1 + "/goals/" + S.p],
      cards: true, attempts: true,
    });
  });
  step("T3.lifecycle_unarchive_version_form", "生命周期：版本目录形态取消归档", () => {
    ops.unarchiveGoal(root, S.p, { actor });
    assertBoard(S.p, {
      at: "versions/" + V1 + "/goals/" + S.p + "/goal.md",
      gone: ["versions/" + V1 + "/archived/" + S.p],
      cards: true, attempts: true,
    });
  });
  step("T3.lifecycle_postpone", "生命周期：暂缓 → backlog 目录形态", () => {
    ops.postponeGoal(root, S.p, { actor, reason: "win-smoke" });
    assertBoard(S.p, {
      at: "backlog/" + S.p + "/goal.md",
      gone: ["versions/" + V1 + "/goals/" + S.p],
      cards: true, attempts: true,
    });
    const doc = ops.loadGoal(join(root, "backlog", S.p, "goal.md"));
    if (doc.meta.version !== null) throw new Error("暂缓后 version 未清空：" + String(doc.meta.version));
  });
  step("T3.lifecycle_backlog_dir_to_version", "生命周期：backlog 目录形态 → 版本(目录)", () => {
    ops.moveGoal(root, S.p, { to: "version", version: V1, actor });
    assertBoard(S.p, {
      at: "versions/" + V1 + "/goals/" + S.p + "/goal.md",
      gone: ["backlog/" + S.p],
      cards: true, attempts: true,
    });
  });

  // ---- ⑦ 删除夹具（目录形态，含 cards/attempts）+ 失败路径（预置非空目标）+ 收敛 ----
  // 注意：主目标 P 必须**存活到冒烟结束**（宿主的跨进程 CAS 子测试仍要写它的标签），
  // 故「预置非空目标 / 删除」这两个破坏性场景改用独立夹具目标 D。
  step("T3.delete_fixture_create", "删除夹具：目录形态目标（含 cards/attempts）", () => {
    S.d = ops.createGoal(root, { title: "delete smoke", version: "standalone", actor });
    const card = ops.addCard(root, S.d, { title: "待删卡", scope: "goal", actor });
    const adir = join(root, "goals", S.d, "attempts", "att-001");
    mkdirSync(adir, { recursive: true });
    writeFileSync(join(adir, "attempt.md"),
      "---\\n{\\n  \\"id\\": \\"att-001\\",\\n  \\"result\\": \\"done\\",\\n  \\"detached\\": true,\\n  \\"status_line\\": \\"完成\\"\\n}\\n---\\n\\n（win-smoke 夹具）\\n", "utf8");
    if (!existsSync(join(root, "goals", S.d, "cards", card + ".md"))) throw new Error("夹具卡片未落盘");
    assertBoard(S.d, { at: "goals/" + S.d + "/goal.md", cards: true, attempts: true });
  });
  step("T3.failure_nonempty_target", "失败路径：预置非空目标目录 ⇒ 明确业务错误", () => {
    const blocker = join(root, "versions", V2, "goals", S.d);
    mkdirSync(blocker, { recursive: true });
    writeFileSync(join(blocker, "blocker.txt"), "occupied\\n", "utf8");
    const before = eventsCount("tx.persist_failed");
    const srcDir = join(root, "goals", S.d);
    let threw = false;
    let message = "";
    try {
      ops.moveGoal(root, S.d, { to: "version", version: V2, actor });
    } catch (e) {
      threw = true;
      message = String((e && e.message) || e);
    }
    const after = eventsCount("tx.persist_failed");
    out.expectedFailure = {
      threw,
      message,
      expectedPath: "versions/" + V2 + "/goals/" + S.d,
      sourceIntact: existsSync(join(srcDir, "goal.md")) && existsSync(join(srcDir, "cards")) && existsSync(join(srcDir, "attempts")),
      obstacleIntact: existsSync(join(blocker, "blocker.txt")),
      persistFailedDelta: after - before,
    };
    if (existsSync(join(blocker, "goal.md"))) throw new Error("失败路径把目标写进了阻碍目录（半迁移态）");
    if (!out.expectedFailure.sourceIntact) throw new Error("失败路径破坏了源位置");
    if (!out.expectedFailure.obstacleIntact) throw new Error("失败路径破坏了阻碍物");
  });
  step("T3.failure_retry_converges", "失败路径：排除阻碍后重试收敛", () => {
    const blocker = join(root, "versions", V2, "goals", S.d);
    const before = eventsCount("tx.persist_failed");
    rmSync(blocker, { recursive: true, force: true });
    ops.moveGoal(root, S.d, { to: "version", version: V2, actor });
    assertBoard(S.d, {
      at: "versions/" + V2 + "/goals/" + S.d + "/goal.md",
      gone: ["goals/" + S.d],
      cards: true, attempts: true,
    });
    const after = eventsCount("tx.persist_failed");
    if (after !== before) throw new Error("重试又产生 persist 失败事件（未收敛）：" + before + " → " + after);
  });

  // ---- ⑧ 扁平形态：backlog ↔ 独立目标 ----
  step("T3.flat_create_and_move", "扁平形态：backlog ↔ 独立目标互转", () => {
    S.f = ops.createGoal(root, { title: "flat smoke", actor });
    assertBoard(S.f, { at: "backlog/" + S.f + ".md" });
    ops.moveGoal(root, S.f, { to: "standalone", actor });
    assertBoard(S.f, { at: "goals/" + S.f + "/goal.md", gone: ["backlog/" + S.f + ".md"] });
    ops.moveGoal(root, S.f, { to: "backlog", actor });
    assertBoard(S.f, { at: "backlog/" + S.f + ".md", gone: ["goals/" + S.f] });
  });
  step("T3.flat_archive_unarchive", "扁平形态：归档 + 取消归档", () => {
    ops.archiveGoal(root, S.f, { actor });
    assertBoard(S.f, { at: "backlog/archived/" + S.f + ".md", gone: ["backlog/" + S.f + ".md"] });
    ops.unarchiveGoal(root, S.f, { actor });
    assertBoard(S.f, { at: "backlog/" + S.f + ".md", gone: ["backlog/archived/" + S.f + ".md"] });
  });

  // ---- ⑨ 删除（目录形态 + 扁平形态，均须先归档）----
  step("T3.dir_delete_archived", "目录形态：归档后删除（含 cards/attempts 整目录）", () => {
    ops.archiveGoal(root, S.d, { actor });
    assertBoard(S.d, { at: "versions/" + V2 + "/archived/" + S.d + "/goal.md", cards: true, attempts: true });
    ops.deleteGoal(root, S.d, { actor });
    if (copiesOf(S.d).length !== 0) throw new Error("删除后目标仍在板上：" + copiesOf(S.d).join(", "));
    if (existsSync(join(root, "versions", V2, "archived", S.d))) throw new Error("删除后目标目录仍在");
    if (eventsCount("goal.deleted") < 1) throw new Error("未记 goal.deleted 事件");
  });
  step("T3.flat_archive_delete", "扁平形态：归档后删除", () => {
    ops.archiveGoal(root, S.f, { actor });
    assertBoard(S.f, { at: "backlog/archived/" + S.f + ".md" });
    ops.deleteGoal(root, S.f, { actor });
    if (copiesOf(S.f).length !== 0) throw new Error("删除后扁平目标仍在板上");
    if (existsSync(join(root, "backlog", "archived", S.f + ".md"))) throw new Error("删除后扁平文件仍在");
  });

  // ---- ⑩ 收尾：锁/临时产物清理 + 盘面总览 ----
  step("T3.locks_and_board_summary", "收尾：锁与临时产物零残留 + 盘面总览", () => {
    const s = boardSummary();
    if (s.lockArtifacts.length > 0) throw new Error("锁/临时产物残留：" + s.lockArtifacts.join(", "));
    if (s.emptyGoalDirs.length > 0) throw new Error("残留空目标目录：" + s.emptyGoalDirs.join(", "));
    if (s.persistFailed !== s.persistFailedExpected) {
      throw new Error("tx.persist_failed 计数 " + s.persistFailed + "（期望 " + s.persistFailedExpected + "）");
    }
    if (copiesOf(S.s1).length !== 1) throw new Error("收尾盘面：S1 计数不为 1");
    // 主目标 P 必须存活且唯一（宿主的跨进程 CAS 子测试仍要写它的标签）
    assertBoard(S.p, { at: "versions/" + V1 + "/goals/" + S.p + "/goal.md", cards: true, attempts: true });
    if (copiesOf(S.d).length !== 0 || copiesOf(S.f).length !== 0) throw new Error("收尾盘面：已删除目标仍存在");
    if (!s.attachments.includes("smoke-keep.txt")) throw new Error("收尾盘面：保留的附件丢失");
  });
  step("T3.validate", "validate 无违规", () => {
    const problems = ops.validate(root);
    out.validate = Array.isArray(problems) ? problems : ["validate 未返回数组"];
    if (out.validate.length !== 0) throw new Error("graph_validate 返回非空：" + JSON.stringify(out.validate));
  });
};

try {
  flow();
} catch (e) {
  out.err = out.err || String((e && e.message) || e);
}
try {
  out.board = boardSummary();
} catch (e) {
  out.board = { error: String((e && e.message) || e) };
}
if (out.validate === null) {
  try {
    const problems = ops.validate(root);
    out.validate = Array.isArray(problems) ? problems : ["validate 未返回数组"];
  } catch (e) {
    out.validate = ["validate 抛错：" + String((e && e.message) || e)];
  }
}
out.ok = out.steps.length > 0 && out.steps.every((s) => s.ok) && out.validate.length === 0;
if (!out.ok && !out.err) out.err = "存在失败步骤或 validate 非空";
process.stdout.write("WIN_SMOKE_JSON:" + JSON.stringify(out) + "\\n");
`;

const TAG_WORKER_SRC = `
import { pathToFileURL } from "node:url";
const [opsPath, root, goal, tag] = process.argv.slice(2);
const ops = await import(pathToFileURL(opsPath).href);
try {
  ops.setGoalTags(root, goal, { tags: [tag], base_tags: [], actor: "win-smoke-" + tag });
  process.stdout.write("WIN_TAG_OK\\n");
} catch (e) {
  const msg = String((e && e.message) || e);
  const byClass = typeof ops.GraphConflictError === "function" && e instanceof ops.GraphConflictError;
  const byName = e && (e.name === "GraphConflictError" || e.constructor?.name === "GraphConflictError");
  const byMsg = /已被其他人修改|已被外部|冲突|conflict|CAS|刷新后重试/i.test(msg);
  process.stdout.write((byClass || byName || byMsg ? "WIN_TAG_CONFLICT" : "WIN_TAG_ERROR") + ":" + msg + "\\n");
}
`;

function parseSmokeJson(out) {
  const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith("WIN_SMOKE_JSON:"));
  if (!line) return null;
  try { return JSON.parse(line.slice("WIN_SMOKE_JSON:".length)); } catch { return null; }
}

function writeSmokeSources(smokeDir) {
  const script = join(smokeDir, "core-smoke.mjs");
  const worker = join(smokeDir, "tag-worker.mjs");
  writeFileSync(script, CORE_SMOKE_SRC, "utf8");
  writeFileSync(worker, TAG_WORKER_SRC, "utf8");
  return { script, worker };
}

/** 跑一次 T3 生命周期冒烟（子进程），返回 {parsed, r}；不产生 record（供基线/突变对照复用）。 */
function runCoreSmoke(smokeDir, opsPath, workspace, timeout = 180_000) {
  const { script } = writeSmokeSources(smokeDir);
  const r = runSync(process.execPath, [script, opsPath, workspace], { timeout, shell: false });
  return { parsed: parseSmokeJson(r.out), r };
}

async function tier3Core(smokeDir, opsPath, workspace) {
  const { worker } = writeSmokeSources(smokeDir);
  const { parsed, r } = runCoreSmoke(smokeDir, opsPath, workspace);
  if (!parsed) {
    const stderr = (r.err || "").trim();
    const depMissing = /ERR_MODULE_NOT_FOUND|Cannot find package/.test(stderr + r.out);
    record("T3", "core/ops.js 可加载并跑通", "FAIL",
      depMissing
        ? "运行时依赖未解析（插件自带 dependencies 未随安装落地）——这正是「拷贝目录 + plugin add 目录」的失败形态 :: " +
          (stderr.split(/\r?\n/).find((l) => /Cannot find package/.test(l)) ?? stderr.split(/\r?\n/)[0] ?? "")
        : `子进程未产出结果（exit=${r.code}）${stderr ? " :: " + stderr.split(/\r?\n/)[0] : ""}` +
          (r.out.trim() ? " :: " + r.out.trim().split(/\r?\n/).slice(-1)[0] : ""));
    return null;
  }
  const failed = parsed.steps.filter((s) => !s.ok);
  coverage.smokeSteps = parsed.steps.length;
  coverage.smokeFailed = failed.length;
  if (failed.length === 0 && parsed.ok) {
    record("T3", "建目标 / 判据 / 标签锁 / CAS / validate", "PASS",
      `goal=${parsed.goal}，${parsed.steps.length} 步全通过，validate 返回空`);
    record("T3", `看板文件系统生命周期（清单式 ${parsed.steps.length} 步）`, "PASS",
      "建/移/归档/取消归档/暂缓/删除 + 卡片/附件/attempts + 锁与陈旧回收；每步均核对磁盘最终状态（源已消失、目标完整、全板计数唯一）");
  } else if (failed.length > 0) {
    record("T3", "核心写路径", "FAIL", failed.map((s) => `${s.id}(${s.label}): ${s.err}`).join(" | "));
  } else {
    record("T3", "graph_validate 无违规", "FAIL", parsed.err);
  }

  // 清单式覆盖自证（fail-closed）：清单里钉住的步骤 id 必须与实跑集合**完全一致**。
  // 只增不减的清单能挡住「某步被悄悄删掉/改名」，避免覆盖率回退而检查仍全绿（0.18.0 的漏检形态）。
  const emitted = new Set(parsed.steps.map((s) => s.id));
  const missingSteps = WIN_SMOKE_STEP_IDS.filter((id) => !emitted.has(id));
  const unknownSteps = [...emitted].filter((id) => !WIN_SMOKE_STEP_IDS.includes(id));
  if (failed.length === 0 && missingSteps.length === 0 && unknownSteps.length === 0) {
    record("T3", "步骤清单自证（清单 ≡ 实跑）", "PASS",
      `${WIN_SMOKE_STEP_IDS.length} 个步骤 id 与实跑集合完全一致`);
  } else if (failed.length > 0 || missingSteps.length > 0 || unknownSteps.length > 0) {
    record("T3", "步骤清单自证（清单 ≡ 实跑）", "FAIL",
      (missingSteps.length ? `清单中 ${missingSteps.length} 步未执行：${missingSteps.join(", ")}` : "") +
      (unknownSteps.length ? `${missingSteps.length ? "；" : ""}实跑出现未登记步骤：${unknownSteps.join(", ")}` : "") +
      (missingSteps.length === 0 && unknownSteps.length === 0 ? `失败步骤 ${failed.length} 个（首个：${failed[0].id}）` : ""));
  }

  // 失败路径判据：预置非空目标目录必须给出**明确业务错误**（带路径与语义、无平台错误码、无半迁移态）
  if (parsed.expectedFailure) {
    const problems = judgeExpectedFailure(parsed.expectedFailure);
    record("T3", "失败路径：预置非空目标 ⇒ 明确业务错误", problems.length ? "FAIL" : "PASS",
      problems.length
        ? problems.join(" | ")
        : "含目标路径与「已存在/非空」语义、无平台错误码、源与阻碍物完好、tx.persist_failed 恰好 +1（可诊断），且重试收敛");
  } else {
    record("T3", "失败路径：预置非空目标 ⇒ 明确业务错误", "FAIL",
      "冒烟未产出该步骤的判定事实（预期失败未被观察到）");
  }

  // 盘面总览判据：无双份 / 无残留空目标目录 / 无锁与临时产物 / 诊断事件计数符合预期 / validate 干净
  if (parsed.board && !parsed.board.error) {
    const problems = judgeBoardSummary({
      ...parsed.board,
      validate: failed.length === 0 ? parsed.validate : [],
    });
    record("T3", "盘面总览（双份/空目录/锁残留/事件计数）", problems.length ? "FAIL" : "PASS",
      problems.length
        ? problems.join(" | ")
        : `目标副本数唯一（${Object.keys(parsed.board.copies).length} 个存活目标）、无残留空目标目录、无锁/临时产物、tx.persist_failed=${parsed.board.persistFailed}`);
  } else {
    record("T3", "盘面总览（双份/空目录/锁残留/事件计数）", "FAIL",
      "冒烟未产出盘面总览（可能是子进程异常退出）");
  }

  // 用户可见文案：任何失败步骤的文案都不得出现裸平台错误码（EPERM/ENOTEMPTY/EBUSY/EACCES）
  const leaks = failed.map((s) => ({ id: s.id, code: platformErrorLeak(s.err) })).filter((x) => x.code);
  const expectedLeak = parsed.expectedFailure ? platformErrorLeak(parsed.expectedFailure.message) : null;
  if (leaks.length === 0 && !expectedLeak) {
    record("T3", "用户可见文案不泄漏平台错误码", "PASS",
      `已核 ${parsed.steps.length} 步文案，无 EPERM/ENOTEMPTY/EBUSY/EACCES`);
  } else {
    record("T3", "用户可见文案不泄漏平台错误码", "FAIL",
      leaks.map((l) => `${l.id}: 出现 ${l.code}`).join(" | ") +
      (expectedLeak ? `${leaks.length ? " | " : ""}失败路径文案出现 ${expectedLeak}` : ""));
  }

  // 并发 CAS：4 个独立进程以同一 base_tags 抢写，必须恰好 1 成功
  // 主写路径若已失败，这里只能得到级联噪声（如「目标不存在：undefined」），故跳过并说明
  if (!parsed.goal) {
    record("T3", "跨进程并发 CAS（4 抢 1）", "SKIP",
      "目标未创建成功（主写路径已失败），跳过并发子测试以免产生级联误报");
    return parsed;
  }
  const procs = [];
  for (let i = 0; i < 4; i++) {
    procs.push(new Promise((res) => {
      const c = spawn(process.execPath, [worker, opsPath, workspace, parsed.goal, `w${i}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("close", () => res({ out, err }));
    }));
  }
  const settled = await Promise.all(procs);
  const ok = settled.filter((s) => s.out.includes("WIN_TAG_OK")).length;
  const conflict = settled.filter((s) => s.out.includes("WIN_TAG_CONFLICT")).length;
  const error = settled.filter((s) => s.out.includes("WIN_TAG_ERROR") || !s.out.trim());
  if (ok === 1 && conflict === 3) {
    record("T3", "跨进程并发 CAS（4 抢 1）", "PASS", "恰好 1 个成功、3 个冲突被拒");
  } else if (error.length > 0) {
    record("T3", "跨进程并发 CAS（4 抢 1）", "FAIL",
      `成功=${ok} 冲突=${conflict} 异常=${error.length} :: ` +
      error.map((e) => (e.out + e.err).trim().split(/\r?\n/)[0]).join(" | "));
  } else {
    record("T3", "跨进程并发 CAS（4 抢 1）", "FAIL",
      `成功=${ok} 冲突=${conflict}（期望 1/3）——锁未生效或过度拒绝`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// T4/T5 实例启动 + REST 冒烟
// ---------------------------------------------------------------------------

function killTree(child) {
  if (!child || child.pid === undefined) return;
  if (isWin) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }
  }
}

async function tier45Boot(ctx) {
  const logPath = join(ctx.smokeDir, "dsh-web.log");
  writeFileSync(logPath, "", "utf8");
  const [cmd, ...prefix] = splitCmd(ctx.dshCmd);
  // 命名 profile 的启动形式是 `dsh --profile <p> [web 应用参数…]`（见 scripts/archived/dev-dsh-instance.sh）；
  // `dsh web` 是固定 web profile 的别名，不接受 --profile。
  const dshArgs = [...prefix, "--profile", ctx.profile, "--no-open", "--port", String(ctx.port)];
  // DEP0190：需要 shell 时只传完整命令行字符串；不需要 shell 时 shell:false + args 数组。
  const child = isWin
    ? spawn(buildShellCommandLine(cmd, dshArgs), {
        cwd: ctx.workspace,
        env: { ...process.env, DSH_HOME: ctx.dshHome },
        shell: true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn(cmd, dshArgs, {
        cwd: ctx.workspace,
        env: { ...process.env, DSH_HOME: ctx.dshHome },
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
  let log = "";
  const onData = (d) => {
    log += d.toString();
    try { writeFileSync(logPath, log, "utf8"); } catch { /* 忽略 */ }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  let fatal = null;
  let url = null;
  const deadline = Date.now() + ctx.timeoutSec * 1000;
  let exited = false;
  child.on("close", () => { exited = true; });

  while (Date.now() < deadline) {
    for (const p of FATAL_LOG_PATTERNS) {
      const m = log.match(p.re);
      if (m) { fatal = { why: p.why, text: m[0] }; break; }
    }
    if (fatal) break;
    const ready = log.match(READY_RE);
    if (ready) { url = ready[1]; break; }
    if (exited) break;
    await sleep(300);
  }

  if (fatal) {
    const idx = log.search(fatal.re);
    const around = log.slice(Math.max(0, idx - 200), idx + 400).trim();
    record("T4", "实例启动 / 插件加载", "FAIL", `${fatal.why}（命中：${fatal.text}）`);
    console.error("----- 启动日志片段 -----\n" + around + "\n------------------------");
    if (log.includes("O_DIRECTORY")) {
      console.error("!! 命中本次事故的原始错误：Windows 的 node:constants 不提供 O_DIRECTORY 具名导出。");
    }
    killTree(child);
    return { child, logPath, url: null };
  }
  if (!url) {
    const cliMismatch = /takes none of parent|unknown option/i.test(log);
    record("T4", "实例启动 / 插件加载", "FAIL",
      cliMismatch
        ? "启动参数形式不被当前 dsh 接受（本脚本按 `dsh --profile <p> [应用参数]` 调用；若 dsh 换了 CLI 形式需同步脚本）"
        : exited ? `进程提前退出（exit code 已返回）` : `等待 ${ctx.timeoutSec}s 未见就绪标志`);
    console.error("----- 启动日志尾部 -----\n" + log.split(/\r?\n/).slice(-20).join("\n") + "\n-----------------------");
    killTree(child);
    return { child, logPath, url: null };
  }
  record("T4", "实例启动 / 插件加载", "PASS", `就绪：${url.replace(/\?token=.*/, "?token=***")}`);

  // ---- T5 REST 冒烟：路由存在 === 插件真的 apply 了 ----
  const origin = new URL(url).origin;
  const ws = encodeURIComponent(ctx.workspace);
  const probe = async (path, label, validate) => {
    try {
      const res = await fetch(`${origin}${path}`, { redirect: "manual" });
      if (res.status !== 200) {
        record("T5", label, "FAIL", `HTTP ${res.status}`);
        return null;
      }
      const body = await res.text();
      const problem = validate(body);
      if (problem) record("T5", label, "FAIL", problem);
      else record("T5", label, "PASS");
      return body;
    } catch (e) {
      record("T5", label, "FAIL", `请求异常：${String(e.message || e)}`);
      return null;
    }
  };

  await probe(`/api/dsh-graph/supervisor-session?workspace=${ws}`, "dsh-graph 路由已注册", (body) => {
    try {
      const j = JSON.parse(body);
      return "supervisorSession" in j ? null : "响应缺少 supervisorSession 字段";
    } catch { return "响应不是 JSON：" + body.slice(0, 80); }
  });
  await probe(`/api/dsh-graph?workspace=${ws}`, "看板载荷可读", (body) => {
    try {
      const j = JSON.parse(body);
      if (!("versions" in j) || !("generated_at" in j)) return "载荷缺少 versions/generated_at";
      return null;
    } catch { return "响应不是 JSON：" + body.slice(0, 80); }
  });
  try {
    const res = await fetch(url, { redirect: "manual" });
    record("T5", "Web UI 可达", res.status < 400 ? "PASS" : "FAIL", `HTTP ${res.status}`);
  } catch (e) {
    record("T5", "Web UI 可达", "FAIL", `请求异常：${String(e.message || e)}`);
  }
  return { child, logPath, url };
}

// ---------------------------------------------------------------------------
// --self-test：离线自检判定逻辑（无需网络 / 无需 Windows）
// ---------------------------------------------------------------------------

function selfTest() {
  head("离线自检（判定逻辑）");
  let bad = 0;
  const check = (name, cond) => {
    if (cond) console.log(`[ OK ] ${name}`);
    else { console.error(`[FAIL] ${name}`); bad++; }
  };

  // 静态门禁：坏样本（本次事故的真实代码行）必须判 FAIL
  const tmp = join(tmpdir(), `win-smoke-selftest-${Date.now()}`);
  const badDir = join(tmp, "bad", "core");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(tmp, "bad", "index.js"), "export const x = 1;\n");
  writeFileSync(join(badDir, "ops.js"),
    'import { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY, O_RDWR, O_RDONLY, O_DIRECTORY } from "node:constants";\n');
  const badScan = scanPosixNamedImports(join(tmp, "bad"));
  check("坏样本被识别出 node:constants 具名导入",
    badScan.hits.length === 1 && badScan.hits[0].names.includes("O_DIRECTORY"));

  // 好样本（修复后的写法）必须判 PASS
  const goodDir = join(tmp, "good", "core");
  mkdirSync(goodDir, { recursive: true });
  writeFileSync(join(tmp, "good", "index.js"),
    'import * as FS_CONSTANTS from "node:constants";\nconst O_DIRECTORY = FS_CONSTANTS.O_DIRECTORY ?? 0;\n');
  writeFileSync(join(goodDir, "ops.js"), "import { O_CREAT, O_EXCL } from \"node:constants\";\n");
  const goodScan = scanPosixNamedImports(join(tmp, "good"));
  const goodProven = goodScan.hits.flatMap((h) => h.names).filter((n) => POSIX_PROVEN_MISSING.has(n));
  check("好样本（命名空间导入 + 仅安全常量）不误报", goodProven.length === 0);

  check("日志判定：真实事故日志被识别为致命",
    FATAL_LOG_PATTERNS.some((p) => p.re.test(
      "SyntaxError: The requested module 'node:constants' does not provide an export named 'O_DIRECTORY'")));
  check("日志判定：正常启动行不算致命",
    !FATAL_LOG_PATTERNS.some((p) => p.re.test("dsh web: http://127.0.0.1:3088/?token=abc")));
  check("就绪行可被解析",
    READY_RE.exec("dsh web: http://127.0.0.1:3088/?token=T")?.[1] === "http://127.0.0.1:3088/?token=T");
  check("命令行拆分正确", splitCmd("npx -y @deepseek-ai/dsh").join("|") === "npx|-y|@deepseek-ai/dsh");
  check("--tarball 路径含空格时按 cmd 规则加引号",
    quoteForCmd(["plugin", "add", "D:\\my docs\\dsh-graph-0.11.0-alpha.tgz"]).join("|") ===
    'plugin|add|"D:\\my docs\\dsh-graph-0.11.0-alpha.tgz"');
  check("无空格路径不被加引号",
    quoteForCmd(["add", ".\\dsh-graph-0.11.0-alpha.tgz"]).join("|") === "add|.\\dsh-graph-0.11.0-alpha.tgz");
  // DEP0190 修复的形状：需要 shell 时只传**完整命令行字符串**，不再传 args 数组
  check("完整命令行：命令与含空格参数都被引号包住",
    buildShellCommandLine("dsh.cmd", ["plugin", "add", "D:\\my docs\\a.tgz"]) ===
    'dsh.cmd plugin add "D:\\my docs\\a.tgz"');
  check("完整命令行：无空格参数不加引号（与历史行为一致）",
    buildShellCommandLine("npm", ["pack", "--ignore-scripts"]) === "npm pack --ignore-scripts");
  check("包目录解析：仓库根 → dsh-graph-host",
    resolvePackageDir(process.cwd()) === process.cwd() ||
    basename(resolvePackageDir(process.cwd())) === "dsh-graph-host");

  // ---- g-428 台账层：未登记即判红（正反例）+ 扫描口径 ----
  const fixture = (text) => [{ path: "core/fixture.ts", text }];
  const ledgerRow = (file, api, hits, sites, risk, map) => buildLedgerRow([file, api, hits, sites, risk, map]);
  check("台账反例：未登记的 renameSync 命中 ⇒ unregistered 判红",
    auditOsSiteLedger(fixture("export function f() {\n  renameSync(1, 2);\n}\n"), { registry: [] }).problems
      .some((p) => p.kind === "unregistered" && p.key === "core/fixture.ts#renameSync"));
  check("台账正例：无 OS 调用的文件 ⇒ 0 问题",
    auditOsSiteLedger(fixture("export function f() {\n  return 1;\n}\n"), { registry: [] }).problems.length === 0);
  check("台账：注释行不产生命中（注释里的 API 名不得虚增覆盖）",
    auditOsSiteLedger(fixture("// renameSync(1, 2) 说明\n"), { registry: [] }).problems.length === 0);
  check("台账：node: 具名导入行不算调用点",
    scanOsCallSites(fixture('import { renameSync } from "node:fs";\n')).hits.length === 0);
  check("台账：成对 ignore 标记内跳过并计数（不做隐形豁免）", (() => {
    const r = scanOsCallSites(fixture("// dsh-win-os-ledger:ignore-os-sites\nrenameSync(1, 2);\n// dsh-win-os-ledger:end-ignore-os-sites\n"));
    return r.hits.length === 0 && r.ignoredLines === 3;
  })());
  check("台账：ignore 标记不配对 ⇒ 抛错（拒绝静默放宽）", (() => {
    try { scanOsCallSites(fixture("// dsh-win-os-ledger:ignore-os-sites\nrenameSync(1, 2);\n")); return false; }
    catch { return true; }
  })());
  check("台账：清单项与实现不同步（新增站点 / 站点消失）⇒ drift/stale 判红", (() => {
    const scoped = [ledgerRow("core/cache.ts", "statSync", 1, ["computeGraphRevision"], "看板缓存新鲜度探测（只读）", "ws:T3.validate")];
    const drift = auditOsSiteLedger([{
      path: "core/cache.ts",
      text: "function computeGraphRevision() { statSync(\"a\"); }\nfunction extraSite() { statSync(\"b\"); }\n",
    }], { registry: scoped });
    const stale = auditOsSiteLedger([{ path: "core/cache.ts", text: "export function computeGraphRevision() { return 1; }\n" }], { registry: scoped });
    const dangling = auditOsSiteLedger([], { registry: [ledgerRow("core/x.ts", "statSync", 0, ["f"], "风险面描述", "ws:T3.nope")] });
    return drift.problems.some((p) => p.kind === "drift" && p.key === "core/cache.ts#statSync") &&
      stale.problems.some((p) => p.kind === "stale" && p.key === "core/cache.ts#statSync") &&
      dangling.problems.some((p) => p.kind === "dangling" && p.detail.includes("T3.nope"));
  })());
  check("台账：冒险面/映射/豁免理由齐备且映射不悬空",
    OS_SITE_REGISTRY.every((r) => r.risk.trim().length >= 4 && (r.refs.length > 0 || (r.exempt && r.exempt.length >= 8))) &&
    new Set(OS_SITE_REGISTRY.map((r) => r.file + "#" + r.api)).size === OS_SITE_REGISTRY.length &&
    OS_SITE_REGISTRY.flatMap((r) => r.refs).filter((x) => x.kind === "ws").every((x) => WIN_SMOKE_STEP_IDS.includes(x.id)) &&
    OS_SITE_REGISTRY.flatMap((r) => r.refs).filter((x) => x.kind === "pg").every((x) => PLATFORM_PROBE_IDS.includes(x.id)));
  check("台账：映射解析支持 ws:/pg:/exempt: 三种形态",
    parseLedgerMap("ws:T3.validate,pg:P4.b").refs.length === 2 &&
    parseLedgerMap("ws:T3.validate,pg:P4.b").exempt === null &&
    parseLedgerMap("exempt:只读探测、无平台分叉").exempt.startsWith("只读") &&
    parseLedgerMap("garbage").invalid === "garbage");
  check("台账：模式表 id 无重复且非目标 API 与模式表不重叠",
    new Set(OS_SITE_PATTERNS.map((d) => d.id)).size === OS_SITE_PATTERNS.length &&
    OS_SITE_NON_GOALS.every((n) => !OS_SITE_PATTERNS.some((d) => n.api.includes(d.id))));
  check("台账规模下限：渐进萎缩必红（登记 ≥ 60 项）", OS_SITE_REGISTRY.length >= 60);

  // ---- g-428：步骤清单自证（清单 ≡ 内嵌冒烟源）----
  check("步骤清单：无重复、g-427 形态 ⊆ 全集且 ≥ 5 步",
    new Set(WIN_SMOKE_STEP_IDS).size === WIN_SMOKE_STEP_IDS.length &&
    G427_FORM_STEP_IDS.length >= 5 && G427_FORM_STEP_IDS.every((id) => WIN_SMOKE_STEP_IDS.includes(id)));
  check("步骤清单：内嵌冒烟源确实包含全部步骤 id（映射不会指向不存在的步骤）",
    WIN_SMOKE_STEP_IDS.every((id) => CORE_SMOKE_SRC.includes('"' + id + '"')));
  check("步骤清单：内嵌冒烟源仍覆盖关键生命周期算子与盘面断言",
    ["moveGoal", "archiveGoal", "unarchiveGoal", "postponeGoal", "deleteGoal", "storeAttachment", "deleteAttachment",
      "addCard", "setGoalTags", "validate", "assertBoard", "boardSummary"].every((k) => CORE_SMOKE_SRC.includes(k)));

  // ---- g-428：用户可见文案卫生 ----
  check("文案卫生：裸 EPERM / ENOTEMPTY / EBUSY / EACCES 判泄漏",
    platformErrorLeak("EPERM: operation not permitted, rename 'a' -> 'b'") === "EPERM" &&
    platformErrorLeak("ENOTEMPTY: directory not empty") === "ENOTEMPTY" &&
    platformErrorLeak("EBUSY: resource busy") === "EBUSY" &&
    platformErrorLeak("EACCES: permission denied") === "EACCES");
  check("文案卫生：带路径与语义的业务文案不误判",
    platformErrorLeak("目标位置已存在且非空，拒绝覆盖：/x/versions/v/goals/g-1（源目录仍在原位，未移动）") === null &&
    platformErrorLeak("XEPERMX 不是错误码") === null && platformErrorLeak("") === null);

  // ---- g-428：失败路径 / 盘面总览 判定（夹具级负向对照）----
  const goodFail = {
    threw: true,
    message: "目标位置已存在且非空，拒绝覆盖：/root/versions/v2-smoke/goals/g-1（源目录仍在原位，未移动）",
    expectedPath: "versions/v2-smoke/goals/g-1",
    sourceIntact: true, obstacleIntact: true, persistFailedDelta: 1,
  };
  check("失败路径判定：合格业务错误判绿", judgeExpectedFailure(goodFail).length === 0);
  check("失败路径判定：Windows 反斜杠文案 + POSIX 期望路径判绿（真机现场回归）",
    judgeExpectedFailure({
      ...goodFail,
      message: "目标位置已存在且非空，拒绝覆盖：D:\\ws\\.dsh-graph\\versions\\v2-smoke\\goals\\g-1（源目录仍在原位，未移动）",
    }).length === 0);
  check("失败路径判定：确实不含目标路径时仍判红（归一化不得削弱判定力）",
    judgeExpectedFailure({
      ...goodFail,
      message: "目标位置已存在且非空，拒绝覆盖：别处（源目录仍在原位，未移动）",
    }).some((p) => p.includes("目标路径")));
  check("失败路径判定：未报错 / 裸 EPERM / 源被破坏 / 事件计数不符 逐项判红",
    judgeExpectedFailure({ ...goodFail, threw: false }).length === 1 &&
    judgeExpectedFailure({ ...goodFail, message: "EPERM: operation not permitted" }).length >= 3 &&
    judgeExpectedFailure({ ...goodFail, sourceIntact: false }).length === 1 &&
    judgeExpectedFailure({ ...goodFail, obstacleIntact: false }).length === 1 &&
    judgeExpectedFailure({ ...goodFail, persistFailedDelta: 0 }).length === 1);
  check("盘面判定：预置双份 / 空目标目录 / 锁残留 / 计数不符 / validate 非空 逐项判红",
    judgeBoardSummary({
      copies: { "g-1": 2 }, emptyGoalDirs: ["backlog/g-1"], lockArtifacts: [".lock.x"],
      persistFailed: 2, persistFailedExpected: 1, validate: ["boom"],
    }).length === 5);
  check("盘面判定：干净盘面判绿（含预期存活/已删除集合）",
    judgeBoardSummary({
      copies: { "g-1": 1 }, expectedLive: ["g-1"], expectedGone: ["g-9"],
      emptyGoalDirs: [], lockArtifacts: [], persistFailed: 1, persistFailedExpected: 1, validate: [],
    }).length === 0 &&
    judgeBoardSummary({ copies: {}, expectedLive: ["g-9"] }).length === 1 &&
    judgeBoardSummary({ copies: { "g-1": 1 }, expectedGone: ["g-1"] }).length === 1);

  // ---- g-428：突变构造（负向对照的可信性）----
  const mutSrc = "function other() {}\nfunction renameDirInto(srcDir, destDir) {\n    renameSync(srcDir, destDir);\n}\nfunction after() {}\n";
  const mutA = buildOsJsMutant(mutSrc, "old-order");
  const mutB = buildOsJsMutant(mutSrc, "copy-dup");
  check("突变构造：old-order 注入 Windows EPERM 语义且保留前后文",
    Boolean(mutA) && mutA.text.includes("EPERM") && mutA.text.startsWith("function other()") && mutA.text.includes("function after()"));
  check("突变构造：copy-dup 注入 cpSync 导入且不再 rename",
    Boolean(mutB) && mutB.text.includes("__g428CpSync") && !mutB.text.includes("renameSync(srcDir, destDir)"));
  check("突变构造：形状不匹配 ⇒ 返回 null（拒绝静默做一次无效对照）",
    buildOsJsMutant("function x() {}\n", "old-order") === null && buildOsJsMutant("", "copy-dup") === null);

  // ---- g-473 派发可用层：硬编码 shell 名判红（正反例）+ 接线在册 ----
  const WIRED_SAMPLE = [
    'export const SHELL_TOOL_CANDIDATES = ["bash", "pwsh"] as const;',
    'export const SHELL_TOOL_SLOT = "<shell>";',
    'export const SHELL_TOOL_TOKEN = "{{shell}}";',
    '  return { name: platform === "win32" ? "pwsh" : "bash" };',
    'export function diagnoseDispatchCapability() { /* dispatch.capability_missing */ }',
  ].join("\n");
  check("派发可用正例：候选表 + 平台回落 + 接线齐备 ⇒ 0 问题",
    auditDispatchToolPortability([{ path: "core/ops.ts", text: WIRED_SAMPLE }]).problems.length === 0);
  check("派发可用反例：白名单里硬编码 bash ⇒ 判红（回退修复的机器化对照）",
    auditDispatchToolPortability([{
      path: "core/ops.ts",
      text: WIRED_SAMPLE + '\nconst HARDCODED = ["read", "bash"];\n',
    }]).problems.some((p) => p.kind === "hardcoded_shell"));
  check("派发可用反例：missing 接线（无槽位/无诊断/无事件）⇒ 逐项判红",
    (() => {
      const r = auditDispatchToolPortability([{ path: "core/ops.ts", text: 'const x = "pwsh";\n' }]);
      return r.problems.filter((p) => p.kind === "missing_wiring").length === DISPATCH_WIRING_REQUIRED.length;
    })());
  check("派发可用：注释里的 bash 不算命中（口径与台账层一致）",
    auditDispatchToolPortability([{ path: "core/ops.ts", text: WIRED_SAMPLE + '\n// 旧实现曾写死 "bash"\n' }]).problems.length === 0);
  check("派发可用：非 ops 文件不在扫描面（避免 host 文案误判）",
    auditDispatchToolPortability([{ path: "dsh-graph-host/index.js", text: 'const s = ["bash"];\n' }]).targets.length === 0);

  // ---- g-428：台账必须与**当前仓库源码**同步（真源核对；非仓库根时跳过而非放行）----
  const selftestSrcRoot = resolveProductSourceRoot(process.cwd());
  if (selftestSrcRoot) {
    const liveAudit = auditOsSiteLedger(collectProductSourceFiles(selftestSrcRoot));
    check("台账：当前仓库源码与 OS_SITE_ROWS 完全同步（0 问题，未登记即判红）", liveAudit.problems.length === 0);
    check("台账：真实命中规模未萎缩（≥ 200 处 / ≥ 15 文件）",
      liveAudit.hits.length >= 200 && liveAudit.scanned >= 15);
    check("台账：g-427 的 renameDirInto 站点在册",
      OS_SITE_REGISTRY.some((r) => r.file === "core/ops.ts" && r.api === "renameSync" && r.sites.includes("renameDirInto")));
    const liveDispatch = auditDispatchToolPortability(collectProductSourceFiles(selftestSrcRoot));
    check("派发可用：当前仓库源码零硬编码 shell 名且接线齐备", liveDispatch.problems.length === 0);
  } else {
    console.log("[INFO] 台账真源核对：当前目录下未找到产品源码（core/*.ts），跳过（不视为通过）");
  }

  // ---- g-475 H 系列：平台条件求值（正反例）----
  check("H1 条件求值：win32 等/不等在目标平台上互斥",
    evaluatePlatformCondition("!!js process.platform === 'win32'", "win32").value === true &&
    evaluatePlatformCondition("!!js process.platform === 'win32'", "linux").value === false &&
    evaluatePlatformCondition("!!js process.platform !== 'win32'", "linux").value === true &&
    evaluatePlatformCondition("!!js ['darwin', 'win32'].includes(process.platform)", "darwin").value === true);
  check("H1 条件求值：字面量 true/false 与字符串包裹形态都能识别",
    evaluatePlatformCondition("true", "linux").value === true &&
    evaluatePlatformCondition("!!js \"!(process.env.X)\"", "linux").ok === false &&
    evaluatePlatformCondition("!!js \"!(process.env.X)\"", "linux").platformRelevant === false);
  check("H1 条件求值：无法识别的**平台**形态必须判 ok=false（不静默放行）",
    evaluatePlatformCondition("!!js process.platform.startsWith('win')", "win32").ok === false &&
    evaluatePlatformCondition("!!js process.platform.startsWith('win')", "win32").platformRelevant === true);

  // ---- g-475 H 系列：组合扫描（正反例）----
  const compFixture = [
    "- id: tool-bash",
    "  name: '@deepseek-ai/dsh-tool-bash'",
    "  disabled: !!js process.platform === 'win32'",
    "- id: tool-pwsh",
    "  name: '@deepseek-ai/dsh-tool-pwsh'",
    "  disabled: !!js process.platform !== 'win32'",
    "- id: tool-fs",
    "  name: '@deepseek-ai/dsh-tool-fs'",
  ].join("\n");
  const compScan = scanCompositionToolDeclarations([{ path: "presets/x.patch.yml", text: compFixture }]);
  check("H1 组合扫描：解析出 3 条声明（含条件）",
    compScan.declarations.length === 3 && compScan.declarations[2].disabled === null);
  check("H1 组合扫描：win32 只启用 pwsh、POSIX 只启用 bash",
    compositionShellTools(compScan.declarations, "win32").tools.join("|") === "pwsh" &&
    compositionShellTools(compScan.declarations, "linux").tools.join("|") === "bash" &&
    compositionShellTools(compScan.declarations, "darwin").tools.join("|") === "bash");
  check("H1 组合扫描：无 name 的条目不算声明（避免把策略件误当工具插件）",
    scanCompositionToolDeclarations([{ path: "x.patch.yml", text: "- id: foo\n  disabled: true\n" }]).declarations.length === 0);
  check("H2 组合工具名：win32 组合里 bash 不存在（病根现场）",
    !compositionToolNames(compScan.declarations, "win32").names.has("bash") &&
    compositionToolNames(compScan.declarations, "win32").names.has("read") &&
    compositionToolNames(compScan.declarations, "linux").names.has("bash"));
  const regFixture = (name, extra = "") =>
    scanCompositionToolDeclarations([{ path: "x.patch.yml", text: `- id: t\n  name: '${name}'\n${extra}` }]).declarations;
  check("H2 台账审计：未登记的工具插件判红（fail-closed）",
    auditToolRegistry(regFixture("@deepseek-ai/dsh-tool-brand-new"), { registry: DSH_TOOL_REGISTRY })
      .problems.some((p) => p.kind === "unregistered-tool-plugin"));
  check("H2 台账审计：已登记包不判红，且工具名能被 description 佐证",
    auditToolRegistry(regFixture("@deepseek-ai/dsh-tool-web"), {
      registry: DSH_TOOL_REGISTRY,
      descriptions: { "@deepseek-ai/dsh-tool-web": "Model-facing web tools (web_search, web_fetch)" },
    }).problems.length === 0 &&
    auditToolRegistry(regFixture("@deepseek-ai/dsh-tool-web"), {
      registry: DSH_TOOL_REGISTRY,
      descriptions: { "@deepseek-ai/dsh-tool-web": "完全无关的描述" },
    }).problems.some((p) => p.kind === "tool-name-unverified"));
  check("H2 台账审计：子路径声明按包名归一（/list-agents 不判红）",
    auditToolRegistry(regFixture("@deepseek-ai/dsh-tool-subagent-control/list-agents"), { registry: DSH_TOOL_REGISTRY })
      .problems.length === 0 &&
    toolPluginBaseName("@deepseek-ai/dsh-tool-subagent-control/list-agents") === "@deepseek-ai/dsh-tool-subagent-control");
  check("H2 台账审计：非平台条件不进平台条件审计（env 条件不误红）",
    auditToolRegistry(regFixture("@deepseek-ai/dsh-tool-web", '  disabled: !!js "!(process.env.X)"\n'),
      { registry: DSH_TOOL_REGISTRY }).problems.length === 0 &&
    auditToolRegistry(regFixture("@deepseek-ai/dsh-tool-web", "  disabled: !!js process.platform.startsWith('win')\n"),
      { registry: DSH_TOOL_REGISTRY }).problems.some((p) => p.kind === "unknown-platform-condition"));
  check("H2 台账规模下限：渐进萎缩必红（登记 ≥ 20 包）", DSH_TOOL_REGISTRY.length >= 20);

  // ---- g-475 H2：求交判定（正反例 + 负向对照必须判红）----
  const h2Existing = new Set(["read", "write", "bash", "glob", "grep"]);
  check("H2 判定：allow ⊆ existing 判绿",
    roleFilterProblems("reviewer", "standard", ["read", "bash"], h2Existing).length === 0);
  check("H2 判定：越界名字判红（restrict() 会抛的那一下）",
    roleFilterProblems("reviewer", "standard", ["read", HARNESS_ABSENT_TOOL], h2Existing).length === 1);
  check("H2 负向对照：注入不存在名字后判定必须判红（证明断言非恒真）",
    judgeRoleWhitelistIntersection({
      cases: [{ role: "reviewer", mode: "standard", platform: "linux", allow: ["read", "bash"], existing: h2Existing, shellExpected: "bash", shellForbidden: "pwsh" }],
      injections: [],
      negativeControl: { problems: roleFilterProblems("reviewer", "standard", ["read", HARNESS_ABSENT_TOOL], h2Existing) },
      absentTool: HARNESS_ABSENT_TOOL,
    }).level === "PASS" &&
    judgeRoleWhitelistIntersection({
      cases: [{ role: "reviewer", mode: "standard", platform: "linux", allow: ["read", "bash"], existing: h2Existing, shellExpected: "bash", shellForbidden: "pwsh" }],
      injections: [],
      negativeControl: { problems: [] },
      absentTool: HARNESS_ABSENT_TOOL,
    }).level === "FAIL");
  check("H2 判定：另一平台的 shell 名出现在 allow 里判红",
    judgeRoleWhitelistIntersection({
      cases: [{ role: "reviewer", mode: "standard", platform: "linux", allow: ["read", "bash", "pwsh"], existing: new Set([...h2Existing, "pwsh"]), shellExpected: "bash", shellForbidden: "pwsh" }],
      injections: [], negativeControl: { problems: ["x"] },
    }).level === "FAIL");

  // ---- g-475 H3：派发可用判定（SKIP 必须显式，不许静默通过）----
  check("H3 判定：未派发 ⇒ SKIP 且文案点名「需真机/实例」",
    judgeDispatchAvailability({ attempted: false }).level === "SKIP" &&
    /需真机\/实例/.test(judgeDispatchAvailability({ attempted: false }).detail));
  check("H3 判定：三路径齐备且有 child_id 判绿",
    judgeDispatchAvailability({
      attempted: true,
      roles: H3_REQUIRED_ROLES.map((role) => ({ role, childId: "c-1", errors: [] })),
    }).level === "PASS");
  check("H3 判定：缺一条路径 / child_id 为空 / 命中失败签名 逐项判红",
    judgeDispatchAvailability({ attempted: true, roles: [{ role: "reviewer", childId: "c", errors: [] }] }).level === "FAIL" &&
    judgeDispatchAvailability({
      attempted: true,
      roles: H3_REQUIRED_ROLES.map((role) => ({ role, childId: role === "collector" ? "" : "c", errors: [] })),
    }).level === "FAIL" &&
    judgeDispatchAvailability({
      attempted: true,
      roles: H3_REQUIRED_ROLES.map((role) => ({
        role, childId: "c",
        errors: role === "executor-minimal" ? ["tools.restrict() names unknown global tool: bash"] : [],
      })),
    }).level === "FAIL");

  // ---- g-475 H4/H5/H6：判定正反例 ----
  check("H4 判定：拒绝侧未抛错 / 落地了文件 / 泄漏错误码 逐项判红",
    judgePathSeparatorSemantics({ cases: [
      { name: "a\\b.txt", kind: "reject", threw: false, created: null, message: "", errnoLeak: null },
      { name: "/abs.txt", kind: "reject", threw: true, created: "/abs.txt", message: "不能是绝对路径", errnoLeak: null },
      { name: "../e.txt", kind: "reject", threw: true, created: null, message: "EPERM: operation not permitted", errnoLeak: "EPERM" },
    ] }).problems.length === 3);
  check("H4 判定：合法名被拒判红、全绿样本判绿",
    judgePathSeparatorSemantics({ cases: [
      { name: "a\\b.txt", kind: "reject", threw: true, created: null, message: "附件路径含非法反斜杠", errnoLeak: null },
      { name: "/abs.txt", kind: "reject", threw: true, created: null, message: "附件路径不能是绝对路径", errnoLeak: null },
      { name: "../e.txt", kind: "reject", threw: true, created: null, message: "附件路径含非法片段", errnoLeak: null },
      { name: "a/b.txt", kind: "accept", threw: false, created: "a/b.txt", message: "", errnoLeak: null },
    ] }).level === "PASS" &&
    judgePathSeparatorSemantics({ cases: [
      { name: "a\\b.txt", kind: "reject", threw: true, created: null, message: "非法反斜杠", errnoLeak: null },
      { name: "/abs.txt", kind: "reject", threw: true, created: null, message: "不能是绝对路径", errnoLeak: null },
      { name: "../e.txt", kind: "reject", threw: true, created: null, message: "非法片段", errnoLeak: null },
      { name: "a/b.txt", kind: "accept", threw: true, created: null, message: "误拒", errnoLeak: null },
    ] }).level === "FAIL");
  check("H4 判定：大小写注入不生效判红",
    judgeCaseSemanticsInjection({
      requested: "a.txt", actual: "A.txt",
      insensitive: { result: { actual: "A.txt", aliased: true } },
      sensitive: { result: null },
    }).level === "PASS" &&
    judgeCaseSemanticsInjection({
      requested: "a.txt", actual: "A.txt",
      insensitive: { result: null },
      sensitive: { result: { actual: "A.txt", aliased: true } },
    }).level === "FAIL");
  check("H5 判定：孤立 CR / 头未折叠 / 注入自成一行的痕迹 / 正文未归一 逐项判红",
    judgeCrlfEncodingRoundTrip({
      description: { written: true, loneCr: true, byteExact: false, utf8Lossless: true },
      results: { written: true, loneCr: true, headerFolded: false, injectedLineAbsent: false, bodyNoCr: false, bodyKeepsLines: false },
    }).problems.length >= 6);
  check("H5 判定：全绿样本判绿；未写入判红",
    judgeCrlfEncodingRoundTrip({
      description: { written: true, loneCr: false, byteExact: true, utf8Lossless: true },
      results: { written: true, loneCr: false, headerFolded: true, injectedLineAbsent: true, bodyNoCr: true, bodyKeepsLines: true },
    }).level === "PASS" &&
    judgeCrlfEncodingRoundTrip({ description: { written: false }, results: { written: false, reason: "x" } }).level === "FAIL");
  check("H6 判定：缺真实 argv/shell 用例即判红（防止退化成纯字符串比较）",
    judgeArgvQuoting({ splitCases: [], quoteCases: [], lineCases: [], argvCases: [], shellCases: [] }).problems.length === 2);
  check("H6 判定：splitCmd/quoteForCmd 正反例",
    splitCmd('"C:\\Program Files\\node.exe" -y @deepseek-ai/dsh').join("|") === "C:\\Program Files\\node.exe|-y|@deepseek-ai/dsh" &&
    splitCmd("").length === 0 &&
    splitCmd("node 'a b' c").join("|") === "node|a b|c" &&
    quoteForCmd(["a&b"]).join("|") === '"a&b"' &&
    quoteForCmd(['"pre-quoted"']).join("|") === '"pre-quoted"');
  check("H6 突变构造：形状不匹配 ⇒ null（拒绝静默无效对照）",
    buildToolCapabilityMutant("function x() {}\n", "no-intersection") === null &&
    buildToolCapabilityMutant("", "bash-only") === null &&
    Boolean(buildToolCapabilityMutant('export const SHELL_TOOL_CANDIDATES = ["bash", "pwsh"];\n', "bash-only")) &&
    buildToolCapabilityMutant('export const SHELL_TOOL_CANDIDATES = ["bash", "pwsh"];\n', "bash-only").text.includes('["bash"]'));

  // ---- g-477：组合声明发现（H1/H2 的前置）—— 命令构造 + 候选面 + 负向对照 ----
  // 真机缺陷：`spawnSync("npm")` 在 Windows 上打不到 npm.cmd（回退恒失效），候选面缺 %APPDATA%/_npx/profile。
  const dshTree = join(tmp, "g477-fake");
  const fakeAppData = join(dshTree, "AppData", "Roaming");
  const fakeLocalAppData = join(dshTree, "AppData", "Local");
  const fakeNpxBase = join(fakeLocalAppData, "npm-cache", "_npx");
  const fakeHome = join(dshTree, "home");
  const fakeRepo = join(dshTree, "repo");
  /** 伪造一个「含 @deepseek-ai/dsh + presets/*.patch.yml」的安装树。 */
  const mkDshTree = (dir, preset) => {
    const pkg = join(dir, "node_modules", "@deepseek-ai", "dsh");
    mkdirSync(join(pkg, "presets"), { recursive: true });
    writeFileSync(join(pkg, "presets", preset), "plugins:\n  '@deepseek-ai/dsh-tool-bash': {}\n");
  };
  mkDshTree(join(fakeAppData, "npm"), "appdata.patch.yml");            // ④ %APPDATA%\npm\node_modules
  mkDshTree(join(fakeNpxBase, "abc123"), "npx.patch.yml");             // ⑤ _npx\<hash>\node_modules
  mkDshTree(join(fakeHome, ".dsh", "profiles", "win-smoke"), "profile.patch.yml"); // ⑥ ~/.dsh/profiles\<名>\node_modules
  mkDshTree(join(dshTree, "npm-global"), "npm-global.patch.yml");      // npm root -g 回退命中面
  const fakeEnv = {
    APPDATA: fakeAppData, LOCALAPPDATA: fakeLocalAppData,
    USERPROFILE: fakeHome, HOME: fakeHome,
  };
  const discOpts = {
    env: fakeEnv, platform: "win32", repo: fakeRepo, cwd: fakeRepo,
    execPath: join(dshTree, "nodejs", "node.exe"), spawnSync: () => ({ status: 1, stdout: "" }),
  };
  const found = discoverDshRoots(fakeRepo, [], discOpts);
  const wantRoots = [
    join(fakeAppData, "npm", "node_modules"),
    join(fakeNpxBase, "abc123", "node_modules"),
    join(fakeHome, ".dsh", "profiles", "win-smoke", "node_modules"),
  ].map((p) => resolve(p));
  check("g-477 候选面：伪造 %APPDATA% / _npx / profiles 树全部命中（Windows 形态）",
    wantRoots.every((w) => found.includes(w)) && found.length >= wantRoots.length);
  check("g-477 候选面：命中的候选真的能扫出组合声明",
    ["appdata.patch.yml", "npx.patch.yml", "profile.patch.yml"].every((p) =>
      collectCompositionFiles(found).some((f) => f.path.endsWith(`presets/${p}`))));
  const winInv = npmGlobalRootInvocation({ platform: "win32", execPath: join(dshTree, "nodejs", "node.exe") });
  const posixInv = npmGlobalRootInvocation({ platform: "linux", execPath: "/usr/bin/node" });
  check("g-477 npm 回退：Windows 构造为 npm.cmd + shell + 单条命令行（不再裸 spawn npm）",
    /npm\.cmd$/i.test(winInv.file) && winInv.shell === true &&
    winInv.commandLine === buildShellCommandLine(winInv.file, ["root", "-g"]) &&
    npmGlobalRootInvocationProblems(winInv, "win32").length === 0);
  check("g-477 npm 回退：POSIX 保持 npm + args + shell:false（不回退成 shell 形态）",
    posixInv.file === "npm" && posixInv.shell === false && posixInv.args.join(" ") === "root -g" &&
    npmGlobalRootInvocationProblems(posixInv, "linux").length === 0);
  const spawnCalls = [];
  const foundNpm = discoverDshRoots(fakeRepo, [], {
    ...discOpts,
    spawnSync: (cmd, opts) => { spawnCalls.push({ cmd, opts }); return { status: 0, stdout: `${join(dshTree, "npm-global")}\n` }; },
  });
  check("g-477 npm 回退：win32 经 shell 单条命令行启动并消费结果（args 数组不得同时传）",
    foundNpm.includes(resolve(join(dshTree, "npm-global"))) &&
    collectCompositionFiles(foundNpm).some((f) => f.path.endsWith("presets/npm-global.patch.yml")) &&
    spawnCalls.length === 1 && typeof spawnCalls[0].cmd === "string" && /npm\.cmd/.test(spawnCalls[0].cmd) &&
    spawnCalls[0].opts?.shell === true && spawnCalls[0].opts?.args === undefined);
  const bareCalls = [];
  const bareShape = { file: "npm", args: ["root", "-g"], shell: false, commandLine: "npm root -g" };
  const bareRoot = queryNpmGlobalRoot({
    platform: "win32", invocation: bareShape,
    spawnSync: (...a) => { bareCalls.push(a); return { status: 0, stdout: "/nope\n" }; },
  });
  check("g-477 npm 回退（负向对照）：裸 npm 形态在 win32 上被拒且**未启动进程**",
    bareRoot === null && bareCalls.length === 0 &&
    npmGlobalRootInvocationProblems(bareShape, "win32").length > 0);
  check("g-477 WARN 文案：给出可复制的定位命令（Windows PowerShell + POSIX），且仍是单行",
    /Get-ChildItem/.test(HARNESS_COMPOSITION_HINT) && /where\.exe dsh/.test(HARNESS_COMPOSITION_HINT) &&
    /npm root -g/.test(HARNESS_COMPOSITION_HINT) && /ls ~\/\.dsh\/profiles/.test(HARNESS_COMPOSITION_HINT) &&
    !/[\r\n]/.test(HARNESS_COMPOSITION_HINT));

  // ---- g-475 防漂移：清单穷尽性 + 两件都消费（绿色基线 + 变异必红）----
  const manifestOk = auditHarnessProbeManifest(HARNESS_PROBE_ROWS, HARNESS_PROBE_RUNNERS);
  check("H 清单审计：H1–H6 齐备、每项有运行器、运行器不孤儿 ⇒ 0 问题",
    manifestOk.problems.length === 0 &&
    HARNESS_PROBE_IDS.length === 6 &&
    Object.keys(HARNESS_PROBE_RUNNERS).length === HARNESS_PROBE_IDS.length);
  check("H 清单审计（变异必红）：漏一项 / 多一项 / 重复 / 缺运行器 逐项判红",
    auditHarnessProbeManifest(HARNESS_PROBE_ROWS.slice(1), HARNESS_PROBE_RUNNERS).problems.some((p) => p.kind === "missing-probe") &&
    auditHarnessProbeManifest([...HARNESS_PROBE_ROWS, ["H7", "offline", "多余探针", "这是一个足够长的判定口径说明文字"]], HARNESS_PROBE_RUNNERS)
      .problems.some((p) => p.kind === "unknown-probe") &&
    auditHarnessProbeManifest([...HARNESS_PROBE_ROWS, HARNESS_PROBE_ROWS[0]], HARNESS_PROBE_RUNNERS)
      .problems.some((p) => p.kind === "duplicate-probe") &&
    auditHarnessProbeManifest(HARNESS_PROBE_ROWS, (() => { const r = { ...HARNESS_PROBE_RUNNERS }; delete r.H1; return r; })())
      .problems.some((p) => p.kind === "missing-runner") &&
    auditHarnessProbeManifest(HARNESS_PROBE_ROWS, { ...HARNESS_PROBE_RUNNERS, H7: () => {} })
      .problems.some((p) => p.kind === "orphan-runner"));
  const selftestRepo = resolveHarnessRepoRoot({}, null);
  const consumerFiles = collectHarnessProbeConsumerFiles(selftestRepo);
  const consumerOk = auditHarnessProbeConsumers(consumerFiles);
  if (consumerFiles.every((f) => f.text.length > 0)) {
    check("H 消费审计：清单恰好一份定义 + 两件都调用 runHarnessProbes ⇒ 0 问题",
      consumerOk.problems.length === 0);
    check("H 消费审计（变异必红）：删掉消费调用 / 制造第二份定义 逐项判红",
      auditHarnessProbeConsumers(consumerFiles.map((f) => ({
        ...f, text: f.text.split(HARNESS_PROBE_CONSUMER_MARKER).join("__removed__"),
      }))).problems.filter((p) => p.kind === "unconsumed").length === HARNESS_PROBE_CONSUMER_FILES.length &&
      auditHarnessProbeConsumers(consumerFiles.map((f) => ({
        ...f, text: f.text + `\n${HARNESS_PROBE_DEFINITION_MARKER} = [];\n`,
      }))).problems.some((p) => p.kind === "single-source"));
    check("H 消费审计（变异必红）：消费件里出现第二份 H 判定 ⇒ 判红",
      auditHarnessProbeConsumers(consumerFiles.map((f) => ({
        ...f,
        text: f.path === HARNESS_PROBE_CONSUMER_FILES[1] ? f.text + "\nfunction judgeArgvQuoting() {}\n" : f.text,
      }))).problems.some((p) => p.kind === "duplicate-definition"));
  } else {
    console.log("[INFO] H 消费审计：当前目录下未找到两件执行件，跳过（不视为通过）");
  }
  check("H 矩阵行：两件执行件渲染同一形状（含平台与全部探针 id）",
    (() => {
      const line = formatHarnessProbeMatrix("linux", HARNESS_PROBE_ROWS.map((r) => ({
        ...harnessProbeRow(r), level: "PASS", detail: "", problems: [],
      })));
      return /^harness 组合矩阵 \| 平台=linux \| /.test(line) && HARNESS_PROBE_IDS.every((id) => line.includes(`${id}=`));
    })());

  rmSync(tmp, { recursive: true, force: true });
  console.log(bad === 0 ? "\n自检全部通过。" : `\n自检失败 ${bad} 项。`);
  process.exit(bad === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const opt = parseCli();
  if (opt.selfTest) selfTest();

  if (opt.mutationCheck) {
    mutationCheck(opt);
    return summarize(opt, { pkgDir: findBuiltPackage(opt) ?? "(未找到已构建包)" });
  }

  if (opt.staticOnly) {
    head("T1 静态门禁（发布包不得具名导入 POSIX 专有常量）");
    const pkgDir = resolvePackageDir(opt.staticOnly);
    console.log(`包目录：${pkgDir}`);
    tier1Static(pkgDir);
    head("T1 台账层（OS 调用点覆盖清单：未登记即判红）");
    const ledger = checkOsSiteLedger(opt.staticOnly);
    if (ledger.audit) printLedgerTable(ledger.audit);
    head("T1 派发可用层（harness 工具名平台无关性：硬编码 shell 名即判红）");
    checkDispatchToolPortability(opt.staticOnly);

    // T1 harness 组合探针层（g-475）：组合声明 / 组合工具名 / 派发端到端 / 分隔符 / 换行 / 引号
    await harnessProbeLayer(opt, { repo: resolveHarnessRepoRoot(opt, pkgDir), pkgDir });
    return summarize(opt, { pkgDir });
  }

  head("dsh-graph Windows 快速验收");
  console.log(`平台：${process.platform} ${process.arch}    Node：${process.version}    ${new Date().toISOString()}`);
  if (!isWin) {
    console.log("提示：当前不是 win32。T1/T2 结论有效；T3/T4/T5 只能证明脚本与代码可跑，");
    console.log("      **不能替代** Windows 真机结论（发布门禁要求原生 Windows 跑一遍）。");
  }

  const homeRaw = opt.dshHome ?? join(tmpdir(), `dsh-graph-win-smoke-${Date.now()}`);
  const profile = opt.profile;
  mkdirSync(join(homeRaw, "profiles"), { recursive: true });
  // 必须 realpath：插件的 resolveRoot 会**硬拒绝**路径中含软链的 root
  // （core/root.ts「graph root symlink is not allowed」）。macOS 上 os.tmpdir() 是
  // /var/folders/…，而 /var → /private/var、/tmp → /private/tmp 都是软链 ——
  // 不 realpath 的话本脚本会在 macOS 上因「工作区路径含软链」而假失败。
  let home = homeRaw;
  try { home = realpathSync(homeRaw); } catch { /* 保持原路径 */ }
  const smokeDir = join(home, "_smoke");
  const workspace = join(home, "workspace");
  mkdirSync(smokeDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  console.log(`隔离 DSH_HOME：${home}${home !== homeRaw ? `（realpath of ${homeRaw}）` : ""}`);
  console.log(`隔离 profile：${profile}    工作区：${workspace}`);

  const [dshCmd, ...dshPrefix] = splitCmd(opt.dshCmd);

  // ---- T2 安装 ----
  head("T2 全新隔离 profile 安装");
  const ver = runSync(dshCmd, [...dshPrefix, "--version"], { timeout: 180_000 });
  if (ver.code === 0) console.log(`dsh 版本：${(ver.out + ver.err).trim().split(/\r?\n/)[0]}`);
  const init = runSync(dshCmd,
    [...dshPrefix, "--profile", profile, "--from-default-profile", "web", "--dump-config"],
    { env: { ...process.env, DSH_HOME: home }, timeout: 300_000 });
  if (init.code === 0) {
    record("T2", "初始化 web 模板 profile", "PASS", `--dump-config 写好 profile 即退出`);
  } else {
    record("T2", "初始化 web 模板 profile", "FAIL",
      `exit=${init.code} :: ${(init.err || init.out).trim().split(/\r?\n/)[0]}`);
  }

  // --path 也必须走「真实安装」语义：先 npm pack 成 tarball 再安装。
  // 直接 `add <目录>` 会被 pnpm 处理成 link:，**不会安装该包的 dependencies**；
  // 而依赖解析会顺着包所在目录的上层 node_modules 命中依赖，于是在开发仓库内
  // 「看起来通过」，到了仓库外（或用户机器上拷贝的目录里）就 ERR_MODULE_NOT_FOUND。
  // 用 tarball 安装与 registry 安装一致，杜绝这种假通过。
  let spec = opt.tarball ?? opt.spec;
  let sourceKind = opt.tarball ? "tarball" : "registry";
  if (opt.path) {
    const localPkgDir = resolvePackageDir(opt.path);
    const packed = packLocalPackage(localPkgDir, join(home, "_pack"));
    if (!packed.file) {
      record("T2", "本地目录打包为 tarball", "FAIL", packed.detail);
      return finish(opt, home, { pkgDir: localPkgDir, logPath: null });
    }
    spec = packed.file;
    sourceKind = "tarball";
    record("T2", "本地目录已打包为 tarball", "PASS",
      `${basename(packed.file)}（与 registry 安装同语义：会真正安装 dependencies）`);
  }

  // 记录被测产物指纹：跨机器/跨渠道传 tarball 时，哈希是唯一可靠的对账依据
  let artifactSha = "";
  let artifactBytes = 0;
  if (sourceKind === "tarball" && existsSync(spec)) {
    artifactSha = sha256File(spec);
    artifactBytes = statSync(spec).size;
    record("T2", "被测产物指纹", "INFO", `${basename(spec)}  ${artifactBytes} B  sha256=${artifactSha}`);
  }

  const install = runSync(dshCmd, [...dshPrefix, "plugin", "--profile", profile, "add", spec],
    { env: { ...process.env, DSH_HOME: home }, timeout: 900_000 });
  const installOut = install.out + install.err;
  const installLabel = opt.path ? `本地构建 ${basename(spec)}`
    : opt.tarball ? `安装 tarball ${basename(spec)}`
    : `安装 ${spec}`;
  if (install.code === 0) {
    record("T2", installLabel, "PASS");
  } else {
    record("T2", installLabel, "FAIL",
      `exit=${install.code} :: ${installOut.trim().split(/\r?\n/).slice(-3).join(" / ")}`);
  }
  if (/Issues with peer dependencies found/.test(installOut)) {
    record("T2", "peer 依赖告警", "WARN",
      "出现 Issues with peer dependencies found（宿主 profile 为 autoInstallPeers:false；" +
      "若插件已按生态惯例标注 peerDependenciesMeta.optional 则不应出现）");
  }
  const peerWarns = installOut.split(/\r?\n/).filter((l) => /missing peer|✕/.test(l)).map((l) => l.trim());
  if (peerWarns.length > 0) {
    record("T2", "缺失 peer 明细", "INFO", `${peerWarns.length} 条：${peerWarns.slice(0, 3).join(" ; ")}`);
  }
  // 运行时依赖必须真的被装进 profile（捕捉「link 安装不装 dependencies」这类问题）
  const yamlDep = join(home, "profiles", profile, "node_modules", "yaml");
  if (existsSync(join(home, "profiles", profile, "node_modules", "dsh-graph"))) {
    record("T2", "插件自带依赖已随安装落地", existsSync(yamlDep) ? "PASS" : "FAIL",
      existsSync(yamlDep) ? "yaml 已安装" : "未找到 profile 内的 yaml（core/ops.js 顶层 import 它，会 ERR_MODULE_NOT_FOUND）");
  }

  const pkgDir = join(home, "profiles", profile, "node_modules", "dsh-graph");
  const opsPath = join(pkgDir, "core", "ops.js");
  if (!existsSync(opsPath)) {
    record("T1", "定位已安装的 core/ops.js", "FAIL", `未找到 ${opsPath}`);
    return finish(opt, home, { pkgDir, logPath: null });
  }
  record("T2", "已安装包定位", "INFO", pkgDir);
  let pkgVersion = "";
  try { pkgVersion = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version ?? ""; } catch { /* 忽略 */ }
  if (pkgVersion) console.log(`已安装 dsh-graph 版本：${pkgVersion}`);

  // ---- T1 静态门禁（针对真正会跑起来的那份代码）----
  head("T1 静态门禁（发布包不得具名导入 POSIX 专有常量）");
  tier1Static(pkgDir);

  // ---- T1 台账层（OS 调用点覆盖清单；产品源码在仓库侧，故以 cwd/--path 为扫描面）----
  head("T1 台账层（OS 调用点覆盖清单：未登记即判红）");
  checkOsSiteLedger(opt.path ? resolvePackageDir(opt.path) : process.cwd());

  // ---- T1 派发可用层（g-473）：对**真正会跑起来的**那份代码断言工具名平台无关性 ----
  head("T1 派发可用层（harness 工具名平台无关性：硬编码 shell 名即判红）");
  checkDispatchToolPortability(pkgDir);

  // ---- T1 harness 组合探针层（g-475）：装完后拿到**真实**的宿主组合（隔离 profile 的 node_modules）----
  await harnessProbeLayer(opt, {
    repo: resolveHarnessRepoRoot(opt, pkgDir),
    pkgDir,
    compositionRoots: [join(home, "profiles", profile, "node_modules")],
    scratch: join(home, "_harness-probes"),
  });

  // ---- T3 核心运行时 ----
  head("T3 核心运行时（完整看板文件系统生命周期 + 每步盘面断言 + 并发 CAS）");
  await tier3Core(smokeDir, opsPath, workspace);

  // ---- T4/T5 实例启动 + REST ----
  head("T4/T5 实例启动与 REST 冒烟");
  const port = findFreePort(opt.port);
  if (port !== opt.port) console.log(`端口 ${opt.port} 被占用，顺延到 ${port}`);
  const boot = await tier45Boot({
    dshHome: home, profile, port, workspace, smokeDir,
    dshCmd: opt.dshCmd, timeoutSec: opt.timeoutSec,
  });
  await sleep(300);
  killTree(boot.child);

  return finish(opt, home, {
    pkgDir, logPath: boot.logPath, pkgVersion,
    tarball: sourceKind === "tarball" ? spec : null,
    artifactSha, artifactBytes,
  });
}

function finish(opt, home, extra) {
  const verdict = summarize(opt, extra);
  if (opt.keep) {
    console.log(`\n保留隔离 DSH_HOME：${home}（--keep）`);
  } else {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows 文件占用时忽略 */ }
    console.log(`\n已清理隔离 DSH_HOME：${home}`);
  }
  return verdict;
}

function summarize(opt, extra) {
  head("结论");
  const fails = results.filter((r) => r.level === "FAIL");
  const warns = results.filter((r) => r.level === "WARN");
  const passes = results.filter((r) => r.level === "PASS");

  console.log(`通过 ${passes.length} 项，失败 ${fails.length} 项，告警 ${warns.length} 项。`);
  if (fails.length > 0) {
    console.log("\n失败项：");
    for (const f of fails) console.log(`  - ${f.tier} · ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  }
  if (warns.length > 0) {
    console.log("\n告警项：");
    for (const w of warns) console.log(`  - ${w.tier} · ${w.name}${w.detail ? ` — ${w.detail}` : ""}`);
  }

  const pass = fails.length === 0;
  console.log(`\n总判定：${pass ? "PASS ✅" : "FAIL ❌"}`);
  if (pass && !isWin) {
    console.log("注意：这是在非 Windows 上取得的 PASS。发布门禁要求**在原生 Windows 上再跑一次**本脚本。");
  }

  console.log("\n----- 可复制回传的报告 -----");
  console.log(`dsh-graph Windows 冒烟 | 平台=${process.platform}/${process.arch} node=${process.version}`);
  const sourceLabel = extra?.tarball
    ? `${basename(extra.tarball)}${opt.path ? "（由本地目录打包）" : ""}`
    : opt.spec;
  console.log(`安装来源=${sourceLabel}${extra?.pkgVersion ? ` (实际版本 ${extra.pkgVersion})` : ""}`);
  if (extra?.artifactSha) {
    console.log(`产物指纹=sha256:${extra.artifactSha}  ${extra.artifactBytes} B`);
  }
  console.log(`结果=${pass ? "PASS" : "FAIL"} 通过${passes.length}/失败${fails.length}/告警${warns.length}`);
  const cov = [];
  if (coverage.ledger) {
    cov.push(`台账=${coverage.ledger.rows}项/${coverage.ledger.hits}处命中（忽略${coverage.ledger.ignoredLines}行，未登记即判红）`);
  }
  if (coverage.smokeSteps > 0) {
    cov.push(`T3生命周期=${coverage.smokeSteps}步（g-427 形态 ${G427_FORM_STEP_IDS.length} 步，每步盘面断言）`);
  }
  if (coverage.dispatch) {
    cov.push(`派发可用=${coverage.dispatch.problems === 0 ? "零硬编码 shell 名（接线齐备）" : `${coverage.dispatch.problems} 项问题`}`);
  }
  if (coverage.harness) {
    cov.push(`H组合=${coverage.harness.pass}/${coverage.harness.total} 通过` +
      (coverage.harness.skip > 0 ? `，${coverage.harness.skip} 项显式跳过（需真机/实例）` : "") +
      (coverage.harness.problems > 0 ? `，${coverage.harness.problems} 项判红` : ""));
  }
  if (cov.length > 0) console.log(`覆盖=${cov.join("  ")}`);
  for (const r of results.filter((x) => x.level === "FAIL" || x.level === "WARN")) {
    console.log(`  ${r.level} ${r.tier} ${r.name}${r.detail ? " :: " + r.detail.slice(0, 300) : ""}`);
  }
  if (lastHarnessProbeRun) console.log(lastHarnessProbeRun.matrix);
  if (extra?.logPath) console.log(`启动日志=${extra.logPath}`);
  console.log("---------------------------");

  if (opt.json) {
    console.log("\n" + JSON.stringify({ pass, results, harness: harnessProbeSummary(lastHarnessProbeRun) }, null, 2));
  }
  process.exitCode = pass ? 0 : 1;
  return pass;
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
