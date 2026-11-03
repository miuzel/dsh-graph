#!/usr/bin/env node
/**
 * g-507 证据采集的**可复用最小实现**（import-safe：被证据脚本与测试共用同一份代码，不做源码复制）。
 *
 * 最小方案的要点（刻意做减法，不建通用日志框架）：
 *   1. **不保存任何原始输出**（实例 stdout/stderr、探针 stdout/stderr 都不落盘，哪怕"脱敏"也不存）；
 *   2. 启动输出只在内存里做**按流的行缓冲**（stdout/stderr 各自独立，不混拼行）；
 *      只有**完整行**（或 EOF 末行）才参与解析 ⇒ token 前缀/内容跨任意 chunk 都正确；
 *   3. token 只经 **stdin** 交给探针，绝不进 argv/env/磁盘/错误消息；
 *   4. 磁盘只写**白名单结构化字段**（候选 SHA、DSH 版本、固定命令/端口、逐项状态码与固定标签、矩阵计数）；
 *   5. 进程完整输出收齐（close/EOF）之后才校验与落盘；缺失/冲突/计数不符/有 FAIL/非零/信号/spawn 错误/超时
 *      一律**非零失败**，不存在"unknown 也算绿"。
 */

/** 内存行缓冲：按流分别累积，只吐**完整行**；`flush()` 交出 EOF 末行（可能无换行）。 */
export class LineBuffer {
  constructor() {
    this.partial = "";
    this.lines = []; // 仅内存；调用方用完即弃
  }
  /** 喂一块字节/文本，返回本次新增的完整行（不含换行符）。 */
  push(chunk) {
    this.partial += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const out = [];
    let idx;
    while ((idx = this.partial.indexOf("\n")) >= 0) {
      out.push(this.partial.slice(0, idx));
      this.partial = this.partial.slice(idx + 1);
    }
    for (const line of out) this.lines.push(line);
    return out;
  }
  /** EOF：把残留的半行当作最后一行交出（无换行也**不丢**）。 */
  flush() {
    if (this.partial === "") return [];
    const last = this.partial;
    this.partial = "";
    this.lines.push(last);
    return [last];
  }
}

/**
 * 从**完整行**里提取 launch token。只有整行里出现 `?token=<值>` 才取值，
 * 因此 token 无论被切成几块，只要整行到齐就能拿到**完整** token（不会锁前 16 字符）。
 * 返回 { token, port }；没有则 { token: null }。
 */
export function parseLaunchLine(line) {
  const m = /https?:\/\/(?:[^\s/]+)(?::(\d+))?\/?\?token=([^\s&#]+)/.exec(line);
  if (!m) return { token: null, port: null };
  return { token: m[2], port: m[1] ? Number(m[1]) : null };
}

/** 白名单：探针只允许这些固定标签 + `STATUS <3位码> PASS <label>` 形态。 */
/** 固定标签（精确匹配；不带尾随文本）。未知标签折叠为 "other"，**不回写**原 label。 */
const STATUS_KEYS = new Set([
  "entrance count",
  "anonymous",
  "forged",
  "expired",
  "tampered",
  "wrong-name",
  "cross-site",
  "cross-origin",
  "bad-host",
  "no-admit",
  "owner index exchange (redirect mints cookie)",
  "owner cookie minted",
  "owner board",
  "owner board etag present",
  "owner board 304",
  "owner create-version",
  "owner version-detail",
  "owner delete-version (reversible write)",
  "owner unknown 404",
  "owner wrong method 405",
  "owner asset",
  "owner asset HEAD",
  "other",
]);

/**
 * 解析探针输出（只接受预定字段/固定标签）：
 *   · `STATUS <code> PASS <label>` / `STATUS <code> FAIL <label>`：label 必须是**固定枚举**；
 *   · 末行 `OK <pass>/<total> failures=<n>` 必须**恰有一行**（0 行或多行冲突 ⇒ 失败）。
 * 未知行一律忽略且**不回写**（避免 label 夹带凭证），但会让"行数对不上"在下游判红。
 */
export function parseProbeOutput(text) {
  const statuses = [];
  const summaries = [];
  const unknown = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trimEnd();
    if (line === "") continue;
    // 状态码位宽：HTTP 码 3 位；布尔型检查（etag 存在、cookie 铸造等）探针记为 1/0
    const st = /^STATUS (\d{1,3}) (PASS|FAIL) (.+)$/.exec(line);
    if (st) {
      const label = st[3].trim();
      // 只保留白名单里的固定标签；其余归入 "other"（不回写原 label）
      // 精确匹配优先；`owner asset <path>` / `anonymous <path>` 这类**前缀 + 路径**的标签归并到前缀
      const exact = STATUS_KEYS.has(label) ? label : null;
      const prefixed = exact ?? [...STATUS_KEYS].find((k) => k !== "other" && label.startsWith(`${k} /`)) ?? "other";
      const known = prefixed;
      statuses.push({ code: Number(st[1]), ok: st[2] === "PASS", label: known ?? "other" });
      continue;
    }
    const ok = /^OK (\d+)\/(\d+) failures=(\d+)$/.exec(line);
    if (ok) {
      summaries.push({ pass: Number(ok[1]), total: Number(ok[2]), failures: Number(ok[3]) });
      continue;
    }
    unknown.push(true);
  }
  return { statuses, summaries, unknownCount: unknown.length };
}

/**
 * 校验探针结果 —— 任何一项不满足都**返回问题清单**（非空即失败，绝无"unknown 也算绿"）：
 *   · 摘要必须恰一行；计数自洽（pass+failures===total）；failures===0；无 FAIL 项；
 *   · 逐项计数必须与摘要 total 交叉核对（防"少跑"）；
 *   · 退出码必须 0 且非信号、无 spawn 错误、未超时。
 */
export function validateProbeResult({ exitCode, signal, spawnError, timedOut, parsed, expectedMinItems = 1 }) {
  const problems = [];
  if (spawnError) problems.push("probe-spawn-error");
  if (timedOut) problems.push("probe-timeout");
  if (signal) problems.push("probe-killed-by-signal");
  if (exitCode !== 0) problems.push("probe-nonzero-exit");
  if (parsed.summaries.length === 0) problems.push("matrix-summary-missing");
  if (parsed.summaries.length > 1) problems.push("matrix-summary-conflict");
  const s = parsed.summaries[0];
  if (s) {
    if (s.pass + s.failures !== s.total) problems.push("matrix-count-inconsistent");
    if (s.failures !== 0) problems.push("matrix-has-failures");
    if (s.total !== parsed.statuses.length) problems.push("matrix-item-count-mismatch");
    if (parsed.statuses.some((x) => !x.ok)) problems.push("matrix-has-failed-item");
    if (s.total < expectedMinItems) problems.push("matrix-too-few-items");
  }
  return problems;
}

/** 白名单结构化证据（只写这些字段；不含任何原始输出/凭证）。 */
export function buildEvidenceRecord({ candidateSha, branch, dshVersion, command, port, parsed, problems }) {
  const s = parsed.summaries[0] ?? null;
  return {
    candidate_sha: candidateSha,
    branch,
    dsh_version: dshVersion,
    command,
    port,
    matrix: s ? { pass: s.pass, total: s.total, failures: s.failures } : null,
    // 逐项只保留状态码 + 固定标签（label 已收敛到枚举，不会夹带凭证）
    items: parsed.statuses.map((x) => ({ code: x.code, ok: x.ok, label: x.label })),
    problems,
    verdict: problems.length === 0 ? "OK" : "FAIL",
  };
}
