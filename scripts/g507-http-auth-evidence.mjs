#!/usr/bin/env node
/**
 * g-507 证据脚本 ③：**隔离实例真实 HTTP 鉴权矩阵**（可复现入口）。
 *
 * 做三件事，全程不打印/不落盘任何 secret、token、cookie：
 *   ① 用 `scripts/dsh-test-web.sh` 在**仓库 tmp/ 内**的独立 DSH_HOME + workspace 起一个隔离实例
 *      （端口默认 3095，拒绝 3080；`--host-dir` 指向本仓库 `dist/`）；
 *   ② 从实例日志里**只**提取 launch token 用于「宿主自己的 token 交换」，随即丢弃；
 *   ③ 对 63 条入口 + 未知子路径跑匿名/伪造矩阵，并用宿主签发的 owner cookie 跑读/可逆写/资产/304/404/405；
 *   最后停止自己启动的实例（只杀自己记录的 PID）。
 *
 * 用法（仓库根；构建产物已就绪）：
 *   node scripts/g507-http-auth-evidence.mjs [--port 3095]
 *
 * 输出：逐条 `STATUS ... PASS/FAIL` 摘要 + 最后一行 `OK n/n`；证据写入 `tmp/g507-evidence/`
 *（不与产品源码混放，也不入库）。任何一步失败即非零退出。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "tmp", "g507-evidence");
const portArg = process.argv.indexOf("--port");
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 3095;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKSPACE = join(ROOT, "tmp", "dsh-test", "0.2.1-rc.2", "workspace");
const LOG = join(OUT, "instance.log");

if (!existsSync(join(ROOT, "dist", "index.js"))) throw new Error("缺少 dist/：请先 bash scripts/build.sh");
mkdirSync(OUT, { recursive: true });

/** 启动隔离实例（后台），返回 {child, logFile}。 */
function startInstance() {
  const child = spawn("bash", ["scripts/dsh-test-web.sh", "0.2.1-rc.2", "--port", String(PORT), "--host", "127.0.0.1", "--host-dir", join(ROOT, "dist")], {
    cwd: ROOT,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  const sink = (chunk) => {
    buf += chunk.toString("utf8");
    writeFileSync(LOG, buf, "utf8"); // 日志只落在 tmp/g507-evidence（含 token ⇒ 报告里绝不引用原文）
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);
  return child;
}

/** 等实例就绪（日志出现 `dsh web: http://…`）。 */
async function waitReady(child, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`隔离实例退出（code=${child.exitCode}）：见 ${LOG}`);
    if (existsSync(LOG)) {
      const text = readFileSync(LOG, "utf8");
      const m = /dsh web: (http:\/\/\S+)/.exec(text);
      if (m) return m[1];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等待实例就绪超时：见 ${LOG}`);
}

/** 读取仓库已安装的宿主栈（B 层同一解析器），返回 connection 模块路径（用于构造真实 token 交换请求）。 */
async function main() {
  const child = startInstance();
  let failures = 0;
  const lines = [];
  try {
    const launchUrl = await waitReady(child);
    const redacted = launchUrl.replace(/token=[^&]+/, "token=<redacted>");
    lines.push(`INSTANCE ${redacted}`);
    const token = new URL(launchUrl).searchParams.get("token");
    // 交给独立探针（其内部不打印凭证）
    const probe = spawn(
      process.execPath,
      ["core/tests/fixtures/g507-http-auth-probe.mjs", BASE, launchUrl, WORKSPACE],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    probe.stdout.on("data", (c) => (out += c.toString("utf8")));
    probe.stderr.on("data", (c) => (out += c.toString("utf8")));
    const code = await new Promise((resolve) => probe.on("exit", resolve));
    const safeOut = out.split("\n").map((l) => l.replace(/token=[^&\s]+/g, "token=<redacted>")).join("\n");
    lines.push(safeOut.trim());
    writeFileSync(join(OUT, "http-auth-matrix.log"), `${lines.join("\n")}\n`, "utf8");
    if (code !== 0) failures++;
    const summary = /OK (\d+\/\d+) failures=(\d+)/.exec(safeOut);
    console.log(`[evidence] ${redacted}`);
    console.log(`[evidence] ${summary ? summary[0] : `probe exit=${code}`}`);
    console.log(`[evidence] 明细：tmp/g507-evidence/http-auth-matrix.log`);
    void token;
  } finally {
    // 只停自己启动的实例
    try {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
      if (child.exitCode === null) child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  if (failures > 0) throw new Error("真实 HTTP 鉴权矩阵存在失败项（见明细）");
  console.log("[evidence] 实例已停止");
}

await main();
