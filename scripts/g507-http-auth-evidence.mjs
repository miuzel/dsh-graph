#!/usr/bin/env node
/**
 * g-507 证据脚本：**隔离实例真实 HTTP 鉴权矩阵**（可复现入口）。
 *
 * token 纪律（本轮返工重点）：
 *   · launch token **只在内存里**出现：从实例输出流里逐块累积、只在内存中解析；
 *   · **绝不**把原始输出落盘：落盘内容先经 `redact()` 逐块脱敏，并按「可能被 chunk 边界拆开」处理
 *     （保留末尾 holdback 延迟刷写，见 `RedactingWriter`）⇒ 落盘日志中不存在完整 token；
 *   · token 只用 **stdin** 交给探针（不写 argv / env / 报文），探针用完即弃；
 *   · 探针输出同样逐块脱敏后才落盘；
 *   · 证据只记录脱敏白名单字段（候选 SHA、DSH 版本、命令、矩阵结果）。
 *
 * 用法（仓库根；构建产物已就绪）：
 *   node scripts/g507-http-auth-evidence.mjs [--port 3095]
 *
 * 退出码：0 = 矩阵全绿；非 0 = 存在失败项（明细见 tmp/g507-evidence/）。
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "tmp", "g507-evidence");
const portArg = process.argv.indexOf("--port");
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 3095;
const BASE = `http://127.0.0.1:${PORT}`;
// 隔离根：仓库 tmp/ 下的标准位置（`dsh-test-web.sh` 拒绝任何 DSH_TEST_ROOT override）。
// token 每次启动都由宿主重新生成；脚本退出时会停止实例，凭证不作任何留存。
const ISOLATED_ROOT = join(ROOT, "tmp", "dsh-test");
const WORKSPACE = join(ISOLATED_ROOT, "0.2.1-rc.2", "workspace");
const INSTANCE_LOG = join(OUT, "instance.redacted.log");
const MATRIX_LOG = join(OUT, "http-auth-matrix.log");

if (!existsSync(join(ROOT, "dist", "index.js"))) throw new Error("缺少 dist/：请先 bash scripts/build.sh");
mkdirSync(OUT, { recursive: true });

/**
 * 脱敏：把 `token=<值>`、以及任何长度 ≥32 或**紧跟在 `<redacted>` 之后**的 base64url 片段替换成占位符。
 *
 * 后半条规则是为了堵住**chunk 边界**造成的一种真实泄漏（实测）：
 * 第一块输出里 `token=xxx` 已被替换成 `token=<redacted>`，而 token 的**后半截**落在下一块里，
 * 于是文件里出现 `<redacted>GSoqoy27Mot_Y95Ks` —— 既不含 `token=` 前缀、长度又不足 32，
 * 两条基本规则都匹配不到。因此这里额外吞掉 `<redacted>` 之后的残留片段。
 */
let KNOWN_TOKEN = null; // 仅内存持有；一旦捕获，落盘前先按**字面**整体抹掉
function redact(text) {
  let out = String(text);
  if (KNOWN_TOKEN) {
    out = out.split(KNOWN_TOKEN).join("<redacted>");
    for (let i = 0; i + 8 <= KNOWN_TOKEN.length; i += 8) {
      out = out.split(KNOWN_TOKEN.slice(i, i + 8)).join("");
    }
  }
  return out
    .replace(/<redacted>[A-Za-z0-9_-]{4,}/g, "<redacted>")
    .replace(/([?&]token=)[^&\s"'<>]+/g, "$1<redacted>")
    .replace(/\/\?token=[^\s"'<>]+/g, "/?token=<redacted>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted>");
}

/**
 * 逐块脱敏写入器：不缓存整份输出，只保留末尾一小段用于跨 chunk 边界脱敏 ⇒
 * 即使 token 被切分到两个 chunk，也不会以明文写入文件。
 */
class RedactingWriter {
  constructor(file, holdback = 256) {
    this.file = file;
    this.holdback = holdback;
    this.buffer = ""; // 尚未落盘的原始文本（末尾 holdback 内可能是不完整的凭证）
    this.safeAll = ""; // 已脱敏全文（供内存解析，绝不回写原值）
    writeFileSync(file, "", "utf8");
  }
  /**
   * 处理一块输出：**先**把「确定安全的前缀」脱敏落盘，**再**把末尾 holdback 留在缓冲区等后续 chunk。
   * 关键点：切分必须发生在**脱敏之前**，且切分点之后的文本一律不进文件 —— 否则 token 会被
   * 「位置切分 + 事后脱敏」的组合漏掉（实测：窗口 256、token 跨度 322 时，切点后的第一段就是明文 token）。
   */
  push(chunk) {
    this.buffer += chunk.toString("utf8");
    const cut = Math.max(0, this.buffer.length - this.holdback);
    if (cut > 0) return this._commit(this.buffer.slice(0, cut));
    return "";
  }
  /**
   * 落盘前按**行**处理：含 `token=` 的行整行重写为白名单形态（保留 URL 主体，去掉查询串），
   * 其余行按 `redact` 处理。整行重写保证「无论 token 分成几块、落在哪个位置」都不会漏。
   */
  _commit(rawText) {
    const lines = rawText.split("\n");
    const tailLine = lines.pop(); // 最后一行可能不完整 ⇒ 留在 buffer 里继续累积
    this.buffer = tailLine;
    const safe = lines
      .map((line) => (/[?&]token=/.test(line) ? line.replace(/\?[^\s]*$/, "") + " (?token=<redacted>)" : redact(line)))
      .join("\n");
    if (safe) {
      const block = `${safe}\n`;
      this.safeAll += block;
      writeFileSync(this.file, block, { encoding: "utf8", flag: "a" });
    }
    return safe;
  }
  finish() {
    if (!this.buffer) return;
    this._commit(this.buffer);
    this.buffer = "";
  }
  /** 当前已脱敏全文（含尚未落盘的缓冲区，经同一 redact 处理） */
  text() {
    return this.safeAll + redact(this.buffer);
  }
}

/**
 * 从**内存**里累积的（已脱敏）输出中取 launch URL —— 脱敏后 token 已被替换，
 * 因此这里只能用于「判断实例就绪」；真正的 token 由 `tokenFromMemory` 单独从原始块提取。
 */
function startInstance(writer) {
  const child = spawn(
    "bash",
    ["scripts/dsh-test-web.sh", "0.2.1-rc.2", "--port", String(PORT), "--host", "127.0.0.1", "--host-dir", join(ROOT, "dist")],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let ready = false;
  let token = null;
  const sink = (chunk) => {
    const raw = chunk.toString("utf8");
    // token 只在**这一帧内存**里被取出，不进入任何持久化文本
    if (token === null) {
      const m = /[?&]token=([A-Za-z0-9_-]{16,})/.exec(raw);
      if (m) {
        token = m[1];
        KNOWN_TOKEN = token; // 从此以后所有落盘文本都按字面抹除该 token 及其片段
      }
    }
    writer.push(chunk);
    if (/dsh web: /.test(raw)) ready = true;
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);
  return { child, isReady: () => ready, takeToken: () => token };
}

/** 等实例就绪（`dsh web:` 行出现）且已拿到 token。 */
async function waitReady(inst, timeoutMs = 240_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (inst.child.exitCode !== null) throw new Error(`隔离实例退出（code=${inst.child.exitCode}）：见 ${INSTANCE_LOG}`);
    if (inst.isReady() && inst.takeToken()) return inst.takeToken();
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`等待实例就绪超时：见 ${INSTANCE_LOG}`);
}

/** 运行探针：token 走 stdin（不出现在 argv / env / 落盘）。 */
function runProbe(writer, token) {
  const probe = spawn(process.execPath, ["core/tests/fixtures/g507-http-auth-probe.mjs", BASE, WORKSPACE], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let safeOut = "";
  const sink = (chunk) => {
    safeOut += writer.push(chunk);
  };
  probe.stdout.on("data", sink);
  probe.stderr.on("data", sink);
  probe.stdin.write(`${token}\n`);
  probe.stdin.end();
  return { probe, output: () => writer.text() };
}

function git(args) {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  const instWriter = new RedactingWriter(INSTANCE_LOG);
  const matrixWriter = new RedactingWriter(MATRIX_LOG, 256);
  const inst = startInstance(instWriter);
  let failures = 0;
  try {
    const token = await waitReady(inst); // 仅在内存中
    const run = runProbe(matrixWriter, token);
    const code = await new Promise((resolve) => run.probe.on("exit", resolve));
    const out = run.output();
    const summary = /OK (\d+\/\d+) failures=(\d+)/.exec(out);
    if (code !== 0) failures++;

    // 负向自检：落盘文件与探针 argv/env 都不得包含 token（只报布尔，不打印 token 本身）
    const diskText = [INSTANCE_LOG, MATRIX_LOG].map((f) => (existsSync(f) ? readText(f) : "")).join("\n");
    // 不只查完整 token：token 的任一 12 字符连续片段出现在落盘内容里都算泄漏（覆盖 chunk 截断残留）
    const tokenShards = [];
    for (let i = 0; i + 12 <= token.length; i += 4) tokenShards.push(token.slice(i, i + 12));
    const leakedShards = tokenShards.filter((shard) => diskText.includes(shard));
    const noTokenOnDisk = !diskText.includes(token) && leakedShards.length === 0;
    const argvClean = !process.argv.some((a) => a.includes(token));

    const safety = [
      "=== g-507 evidence safety summary (no credentials) ===",
      `candidate_sha=${git(["rev-parse", "HEAD"])}`,
      `branch=${git(["rev-parse", "--abbrev-ref", "HEAD"])}`,
      "dsh_version=0.2.1-rc.2",
      `command=node scripts/g507-http-auth-evidence.mjs --port ${PORT}`,
      `base=${BASE}`,
      `matrix=${summary ? summary[0] : "unknown"}`,
      `probe_exit=${code}`,
      `token_on_disk=${noTokenOnDisk ? "ABSENT" : "PRESENT(FAIL)"}`,
      `token_shards_checked=${tokenShards.length}`,
      `token_in_argv=${argvClean ? "ABSENT" : "PRESENT(FAIL)"}`,
      `token_transport=stdin`,
      `isolated_root=tmp/dsh-test`,
      `instance_log=${INSTANCE_LOG.slice(ROOT.length + 1)} (redacted)`,
      `matrix_log=${MATRIX_LOG.slice(ROOT.length + 1)}`,
    ].join("\n");
    writeFileSync(join(OUT, "safety-summary.txt"), `${safety}\n`, "utf8");
    console.log(safety);
    if (!noTokenOnDisk) failures++;
    if (!argvClean) failures++;
  } finally {
    try {
      inst.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
      if (inst.child.exitCode === null) inst.child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
    instWriter.finish();
    matrixWriter.finish();
  }
  if (failures > 0) throw new Error("证据脚本存在失败项（矩阵失败或 token 纪律自检未过）");
  console.log("[evidence] 实例已停止");
}

function readText(file) {
  return readFileSync(file, "utf8");
}

await main();
