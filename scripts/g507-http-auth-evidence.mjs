#!/usr/bin/env node
/**
 * g-507 证据脚本：隔离实例真实 HTTP 鉴权矩阵（薄驱动 —— 采集/解析/校验复用 `g507-evidence-collect.mjs`）。
 *
 * 纪律（最小方案）：
 *   · 实例与探针的原始输出**一律不落盘**（不存原样、也不存"脱敏副本"）；
 *   · 行缓冲只在内存里，stdout/stderr 各一份（不混拼）；只有**完整行 / EOF 末行**参与解析；
 *   · token 只经 **stdin** 给探针（不进 argv/env/磁盘/错误消息）；
 *   · 磁盘只写白名单字段（`tmp/g507-evidence/evidence.json`）；
 *   · 收齐 close/EOF 之后才校验与落盘；缺失/冲突/计数不符/FAIL/非零/信号/超时 ⇒ 非零失败。
 *
 * 用法：node scripts/g507-http-auth-evidence.mjs [--port 3097]
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LineBuffer, parseLaunchLine, parseProbeOutput, validateProbeResult, buildEvidenceRecord } from "./g507-evidence-collect.mjs";

const ROOT = process.cwd();
const OUT = join(ROOT, "tmp", "g507-evidence");
const EVIDENCE_FILE = join(OUT, "evidence.json");
const portArg = process.argv.indexOf("--port");
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 3097;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKSPACE = join(ROOT, "tmp", "dsh-test", "0.2.1-rc.2", "workspace");
const PROBE_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 240_000;

if (!existsSync(join(ROOT, "dist", "index.js"))) throw new Error("缺少 dist/：请先 bash scripts/build.sh");
mkdirSync(OUT, { recursive: true });
rmSync(EVIDENCE_FILE, { force: true });

function git(args) {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** 起隔离实例；stdout/stderr 各一份行缓冲（不混拼）。 */
function startInstance() {
  const child = spawn(
    "bash",
    ["scripts/dsh-test-web.sh", "0.2.1-rc.2", "--port", String(PORT), "--host", "127.0.0.1", "--host-dir", join(ROOT, "dist")],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  const buffers = { out: new LineBuffer(), err: new LineBuffer() };
  let token = null;
  const onLine = (line) => {
    if (token) return;
    const { token: t } = parseLaunchLine(line);
    if (t) token = t; // 只在内存；完整行到齐才得到完整 token
  };
  child.stdout.on("data", (c) => buffers.out.push(c).forEach(onLine));
  child.stderr.on("data", (c) => buffers.err.push(c).forEach(onLine));
  return {
    child,
    takeToken: () => token,
    drainEof: () => {
      [...buffers.out.flush(), ...buffers.err.flush()].forEach(onLine);
    },
  };
}

async function waitForToken(inst) {
  const started = Date.now();
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (inst.child.exitCode !== null) {
      inst.drainEof();
      throw new Error(`隔离实例启动失败（固定原因 instance-exited code=${inst.child.exitCode}）`);
    }
    if (inst.takeToken()) return inst.takeToken();
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("隔离实例启动失败（固定原因 instance-ready-timeout）");
}

/** 跑探针：token 只走 stdin；完整收齐 close 后才解析。 */
function runProbe(token) {
  return new Promise((resolve) => {
    const probe = spawn(process.execPath, ["core/tests/fixtures/g507-http-auth-probe.mjs", BASE, WORKSPACE], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const buffers = { out: new LineBuffer(), err: new LineBuffer() };
    let spawnError = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      probe.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);
    probe.on("error", (e) => {
      spawnError = e?.code ?? "spawn-error"; // 只保留错误码，不回显消息
    });
    probe.stdout.on("data", (c) => buffers.out.push(c));
    probe.stderr.on("data", (c) => buffers.err.push(c));
    probe.stdin.write(`${token}\n`);
    probe.stdin.end();
    probe.on("close", (code, signal) => {
      clearTimeout(timer);
      buffers.out.flush();
      buffers.err.flush();
      // 只取 stdout 的完整行做解析（stderr 仅判空，内容不回写）
      const text = buffers.out.lines.join("\n");
      resolve({
        exitCode: code,
        signal,
        spawnError,
        timedOut,
        emptyStdout: buffers.out.lines.length === 0,
        parsed: parseProbeOutput(text),
      });
    });
  });
}

const inst = startInstance();
let problems = [];
let parsed = { statuses: [], summaries: [], unknownCount: 0 };
try {
  const token = await waitForToken(inst); // 仅内存
  const result = await runProbe(token);
  parsed = result.parsed;
  problems = validateProbeResult({ ...result, expectedMinItems: 145 });
  if (result.emptyStdout) problems.push("probe-stdout-empty");
} catch (error) {
  // 固定安全原因：不回显原始行/token
  problems = [String(error?.message ?? "").startsWith("隔离实例启动失败") ? String(error.message) : "evidence-collect-failed"];
} finally {
  try {
    inst.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    if (inst.child.exitCode === null) inst.child.kill("SIGKILL");
  } catch {
    /* 已退出 */
  }
}

const record = buildEvidenceRecord({
  candidateSha: git(["rev-parse", "HEAD"]),
  branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
  dshVersion: "0.2.1-rc.2",
  command: `node scripts/g507-http-auth-evidence.mjs --port ${PORT}`,
  port: PORT,
  parsed,
  problems,
});
writeFileSync(EVIDENCE_FILE, `${JSON.stringify(record, null, 2)}\n`, "utf8");

console.log(
  `[evidence] verdict=${record.verdict} matrix=${record.matrix ? `${record.matrix.pass}/${record.matrix.total}` : "null"} items=${record.items.length}`,
);
if (record.problems.length) console.log(`[evidence] problems=${record.problems.join(",")}`);
console.log("[evidence] 白名单产物：tmp/g507-evidence/evidence.json");
console.log("[evidence] 实例已停止");
if (record.verdict !== "OK") process.exitCode = 1;
