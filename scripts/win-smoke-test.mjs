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
 *   T2 安装       任意 OS：全新隔离 DSH_HOME + 全新 profile 安装插件成功
 *   T3 核心运行时 平台敏感：直接调用安装后的 core/ops.js 做 建目标/写标签/并发 CAS/validate
 *   T4 实例启动   平台敏感：dsh web 启动，插件树加载无平台错误
 *   T5 REST 冒烟  平台敏感：dsh-graph 路由已注册、看板载荷可读（插件真的 apply 了）
 *
 * 退出码：0=全部通过；1=有失败项；2=用法错误。
 *
 * 设计约束：纯 Node（无第三方依赖）、不改用户真实 DSH_HOME（默认用临时目录）、
 * 不自动打开浏览器、失败也继续跑完剩余检查后统一出结论。
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
    "  --static-only <dir>  只跑 T1 静态门禁后退出\n" +
    "  --self-test          离线自检（不联网、不安装）\n" +
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
    json: v.json,
  };
}

/** 把 "npx -y @deepseek-ai/dsh" 拆成命令 + 参数（允许 --dsh 写多段）。 */
function splitCmd(cmd) {
  return cmd.trim().split(/\s+/);
}

/**
 * Windows 上走 shell（cmd.exe）执行 .cmd 时，Node 不会自动为参数加引号；
 * 含空格/中文的路径（例如放在「我的文档」下的 tarball）会被截断 —— 这里显式加引号。
 */
/** 纯函数形式（便于在非 Windows 上做离线自检）。 */
function quoteForCmd(args) {
  return args.map((a) =>
    typeof a === "string" && /[\s"&^|<>]/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a);
}

function shellSafeArgs(args) {
  return isWin ? quoteForCmd(args) : args;
}

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, shellSafeArgs(args), {
    encoding: "utf8",
    shell: opts.shell ?? isWin,  // Windows 上 .cmd 需要 shell；内部 node 调用显式传 shell:false 避免 DEP0190
    maxBuffer: 32 * 1024 * 1024,
    timeout: opts.timeout ?? 600_000,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
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
// T3 核心运行时：直接调用安装后的 core/ops.js
// ---------------------------------------------------------------------------

const CORE_SMOKE_SRC = `
import { pathToFileURL } from "node:url";
const [opsPath, root] = process.argv.slice(2);
const out = { steps: [], ok: false };
const ops = await import(pathToFileURL(opsPath).href);
const step = (n, fn) => {
  try {
    const v = fn();
    out.steps.push({ n, ok: true });
    return v;
  } catch (e) {
    out.steps.push({ n, ok: false, err: String((e && e.message) || e) });
    throw e;
  }
};
const actor = "win-smoke";
try {
  ops.init(root);
  const id = step("init+createGoal", () =>
    ops.createGoal(root, { title: "windows smoke", version: "v-win-smoke", actor }));
  out.goal = id;   // 立即记录：任一步失败也要能定位到目标，避免下游出现「目标不存在：undefined」的误导
  step("setCriteria", () => ops.setCriteria(root, id, ["冒烟判据 A", "冒烟判据 B"], actor));
  step("setGoalTags 写入", () => ops.setGoalTags(root, id, { tags: ["alpha", "中文标签"], actor }));
  step("setGoalTags CAS 覆盖", () =>
    ops.setGoalTags(root, id, { tags: ["beta"], base_tags: ["alpha", "中文标签"], actor }));
  step("setGoalTags CAS 冲突应被拒", () => {
    try { ops.setGoalTags(root, id, { tags: ["nope"], base_tags: ["不匹配"], actor }); }
    catch { return; }
    throw new Error("base_tags 不匹配时未拒绝写入");
  });
  step("setGoalTags 清空(force)", () => ops.setGoalTags(root, id, { tags: [], force: true, actor }));
  const problems = ops.validate(root);
  out.validate = Array.isArray(problems) ? problems : ["validate 未返回数组"];
  out.ok = out.validate.length === 0;
  if (!out.ok) out.err = "graph_validate 返回非空：" + JSON.stringify(out.validate);
} catch (e) {
  out.ok = false;
  out.err = out.err || String((e && e.message) || e);
}
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

async function tier3Core(smokeDir, opsPath, workspace) {
  const script = join(smokeDir, "core-smoke.mjs");
  const worker = join(smokeDir, "tag-worker.mjs");
  writeFileSync(script, CORE_SMOKE_SRC, "utf8");
  writeFileSync(worker, TAG_WORKER_SRC, "utf8");

  const r = runSync(process.execPath, [script, opsPath, workspace], { timeout: 120_000, shell: false });
  const parsed = parseSmokeJson(r.out);
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
  if (failed.length === 0 && parsed.ok) {
    record("T3", "建目标 / 判据 / 标签锁 / CAS / validate", "PASS",
      `goal=${parsed.goal}，${parsed.steps.length} 步全通过，validate 返回空`);
  } else if (failed.length > 0) {
    record("T3", "核心写路径", "FAIL",
      failed.map((s) => `${s.n}: ${s.err}`).join(" | "));
  } else {
    record("T3", "graph_validate 无违规", "FAIL", parsed.err);
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
  // 命名 profile 的启动形式是 `dsh --profile <p> [web 应用参数…]`（见 scripts/dev-dsh-instance.sh）；
  // `dsh web` 是固定 web profile 的别名，不接受 --profile。
  const child = spawn(cmd, shellSafeArgs([...prefix, "--profile", ctx.profile, "--no-open", "--port", String(ctx.port)]), {
    cwd: ctx.workspace,
    env: { ...process.env, DSH_HOME: ctx.dshHome },
    shell: isWin,
    detached: !isWin,
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
  check("包目录解析：仓库根 → dsh-graph-host",
    resolvePackageDir(process.cwd()) === process.cwd() ||
    basename(resolvePackageDir(process.cwd())) === "dsh-graph-host");

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

  if (opt.staticOnly) {
    head("T1 静态门禁（发布包不得具名导入 POSIX 专有常量）");
    const pkgDir = resolvePackageDir(opt.staticOnly);
    console.log(`包目录：${pkgDir}`);
    tier1Static(pkgDir);
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

  // ---- T3 核心运行时 ----
  head("T3 核心运行时（建目标 / 判据 / 标签锁 / 原子写 / 并发 CAS / validate）");
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
  for (const r of results.filter((x) => x.level === "FAIL" || x.level === "WARN")) {
    console.log(`  ${r.level} ${r.tier} ${r.name}${r.detail ? " :: " + r.detail.slice(0, 300) : ""}`);
  }
  if (extra?.logPath) console.log(`启动日志=${extra.logPath}`);
  console.log("---------------------------");

  if (opt.json) console.log("\n" + JSON.stringify({ pass, results }, null, 2));
  process.exitCode = pass ? 0 : 1;
  return pass;
}

main().catch((e) => {
  console.error("\n脚本自身异常：" + (e?.stack || e));
  process.exit(1);
});
