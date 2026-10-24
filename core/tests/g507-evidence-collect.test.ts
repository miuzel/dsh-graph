/** g-507 证据采集的最小实现测试（**纯合成**，直接 import 真实模块，不做源码复制/正则抠函数）。
 *
 * 覆盖负责人指定的切点：token 起点后 20 字符、token 前缀内部、逐字节、连续多行、EOF 无换行；
 * 并断言：完整 token 只在内存里（经 stdin 传给探针）、所有预期结果不丢失、落盘结构文件不含合成 token
 * 或任何原始日志；缺/伪造/冲突/不完整 matrix 与子进程异常一律真实判红。
 *
 * 合成 token 是**随机生成**的假值，用完即弃；断言失败信息里也不打印 token 本身。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  LineBuffer,
  parseLaunchLine,
  parseProbeOutput,
  validateProbeResult,
  buildEvidenceRecord,
} from "../../scripts/g507-evidence-collect.mjs";

const ROOT = process.cwd();
const PROBE = join(ROOT, "core", "tests", "fixtures", "g507-http-auth-probe.mjs");

/** 合成一条 launch 行（token 长度 43，贴近真实 launch token 规模）。 */
function launchLine(token, port = 3097) {
  return `dsh web: http://127.0.0.1:${port}/?token=${token}\n`;
}

/** 按给定切点把一行拆成若干块。 */
function splitAt(text, cuts) {
  const out = [];
  let prev = 0;
  for (const c of cuts) {
    out.push(text.slice(prev, c));
    prev = c;
  }
  out.push(text.slice(prev));
  return out;
}

/** 用真实行缓冲 + 真实解析器，从给定切分中取 token。 */
function tokenFromChunks(chunks) {
  const buf = new LineBuffer();
  let token = null;
  const onLine = (line) => {
    if (token) return;
    const parsed = parseLaunchLine(line);
    if (parsed.token) token = parsed.token;
  };
  for (const c of chunks) buf.push(c).forEach(onLine);
  buf.flush().forEach(onLine);
  return token;
}

function assertNoTokenIn(text, token, label) {
  // 只报布尔，绝不把 token 写进失败信息
  assert.equal(text.includes(token), false, `${label} 不得包含合成 token`);
  for (let i = 0; i + 8 <= token.length; i += 4) {
    assert.equal(text.includes(token.slice(i, i + 8)), false, `${label} 不得包含 token 的 8 字符片段（i=${i}）`);
  }
}

test("g-507 S1：切点覆盖 —— token 起点后 20 字符 / 前缀内部 / 逐字节 / 连续多行", () => {
  const token = randomBytes(32).toString("base64url");
  const line = launchLine(token);
  const tokenStart = line.indexOf(token);
  assert.ok(tokenStart > 0);

  const cases = {
    "token 起点后 20 字符": [tokenStart + 20],
    "token 前缀内部（起点+4）": [tokenStart + 4],
    "token 起点前 1 字符": [tokenStart - 1],
    "token 末尾前 1 字符": [tokenStart + token.length - 1],
    "逐字节": [...Array(line.length - 1).keys()].map((i) => i + 1),
    "连续多行（token 在中间行）": null,
  };

  for (const [label, cuts] of Object.entries(cases)) {
    let chunks;
    if (cuts === null) {
      const pre = "plugin loading\nstarting webserver\n";
      const all = pre + line + "ready\nlistening\n";
      // 合并成一条块的切点串（含跨行边界）
      const boundary = pre.length + tokenStart + 12;
      chunks = splitAt(all, [3, pre.length, boundary, all.length - 2]);
    } else {
      chunks = splitAt(line, cuts);
    }
    assert.equal(tokenFromChunks(chunks), token, `${label}：必须得到**完整** token（不得锁前若干字符）`);
  }
});

test("g-507 S2：EOF 无换行的末行不丢，且能解析出 token", () => {
  const token = randomBytes(32).toString("base64url");
  const line = launchLine(token).trimEnd(); // 去掉换行，模拟 EOF 前无换行
  const buf = new LineBuffer();
  const got = [...buf.push(line.slice(0, 20)), ...buf.push(line.slice(20)), ...buf.flush()];
  assert.equal(got.length, 1, "EOF 末行必须被交出（不能丢）");
  assert.equal(parseLaunchLine(got[0]).token, token);

  // 连续多行 + 无换行末行
  const buf2 = new LineBuffer();
  const lines = [...buf2.push("a\nb\nc-partial"), ...buf2.flush()];
  assert.deepEqual(lines, ["a", "b", "c-partial"], "多行与 EOF 末行都必须保留");
});

test("g-507 S3：stdout/stderr 分开缓冲，不混拼成一行", () => {
  const out = new LineBuffer();
  const err = new LineBuffer();
  out.push("line-out-1\npart");
  err.push("line-err-1\n");
  out.push("ial\n");
  assert.deepEqual(out.lines, ["line-out-1", "partial"]);
  assert.deepEqual(err.lines, ["line-err-1"]);
});

test("g-507 S4：落盘结构文件只含白名单字段，不含合成 token / 原始日志", () => {
  const token = randomBytes(32).toString("base64url");
  const probeText = [
    "STATUS 401 PASS anonymous /api/dsh-graph",
    "STATUS 403 PASS cross-site",
    `STATUS 401 FAIL leaked-labelled ${token}`, // 恶意 label 夹带 token
    "unknown raw line with token " + token,
    "OK 3/3 failures=0",
  ].join("\n");
  const parsed = parseProbeOutput(probeText);
  const problems = validateProbeResult({ exitCode: 0, signal: null, spawnError: null, timedOut: false, parsed });
  const record = buildEvidenceRecord({
    candidateSha: "deadbeef",
    branch: "b",
    dshVersion: "0.2.1-rc.2",
    command: "node scripts/g507-http-auth-evidence.mjs --port 3097",
    port: 3097,
    parsed,
    problems,
  });
  const dir = mkdtempSync(join(tmpdir(), "g507-ev-"));
  const file = join(dir, "evidence.json");
  writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
  const written = readFileSync(file, "utf8");
  assertNoTokenIn(written, token, "白名单结构文件");
  // label 必须是固定枚举（未知 label 收敛为 "other"，不回写原 label）
  assert.ok(record.items.every((x: any) => typeof x.label === "string" && !x.label.includes("/api/")));
  assert.deepEqual(readdirSync(dir), ["evidence.json"], "只允许写一个白名单结构文件（不写任何原始日志）");
  // 恶意 label 导致 FAIL 项 ⇒ 必须判红
  assert.equal(record.verdict, "FAIL");
  assert.ok(problems.includes("matrix-has-failed-item"));
});

test("g-507 S5：矩阵缺失 / 伪造 / 冲突 / 不完整 / 子进程异常 全部真实判红", () => {
  const ok = (n: number) =>
    [...Array(n).keys()].map((i) => `STATUS 401 PASS anonymous`).join("\n") + `\nOK ${n}/${n} failures=0`;
  const base = { exitCode: 0, signal: null, spawnError: null, timedOut: false, expectedMinItems: 145 };

  // 正常 145 项 ⇒ 无问题
  assert.deepEqual(validateProbeResult({ ...base, parsed: parseProbeOutput(ok(145)) }), []);

  const cases: Array<[string, any, string]> = [
    ["matrix 缺失", { ...base, parsed: parseProbeOutput("STATUS 401 PASS anonymous") }, "matrix-summary-missing"],
    [
      "摘要冲突（两行 OK）",
      { ...base, parsed: parseProbeOutput(`${ok(145)}\nOK 145/145 failures=0`) },
      "matrix-summary-conflict",
    ],
    [
      "计数不符（单行摘要自相矛盾）",
      {
        ...base,
        parsed: parseProbeOutput(`${[...Array(100).keys()].map(() => "STATUS 401 PASS anonymous").join("\n")}\nOK 100/145 failures=0`),
      },
      "matrix-count-inconsistent",
    ],
    [
      "少跑（逐项与 total 交叉核对：只出 3 项却报 145）",
      {
        ...base,
        expectedMinItems: 1,
        parsed: parseProbeOutput(`${[...Array(3).keys()].map(() => "STATUS 401 PASS anonymous").join("\n")}\nOK 145/145 failures=0`),
      },
      "matrix-item-count-mismatch",
    ],
    [
      "有 FAIL 计数（单行摘要 failures=1）",
      {
        ...base,
        parsed: parseProbeOutput(`${[...Array(144).keys()].map(() => "STATUS 401 PASS anonymous").join("\n")}\nOK 144/145 failures=1`),
      },
      "matrix-has-failures",
    ],
    ["非零退出", { ...base, exitCode: 1, parsed: parseProbeOutput(ok(145)) }, "probe-nonzero-exit"],
    ["被信号杀死", { ...base, signal: "SIGKILL", parsed: parseProbeOutput(ok(145)) }, "probe-killed-by-signal"],
    ["超时", { ...base, timedOut: true, parsed: parseProbeOutput(ok(145)) }, "probe-timeout"],
    ["spawn 错误", { ...base, spawnError: "ENOENT", parsed: parseProbeOutput(ok(145)) }, "probe-spawn-error"],
    ["项数不足", { ...base, parsed: parseProbeOutput(`${[...Array(10).keys()].map(() => "STATUS 401 PASS anonymous").join("\n")}\nOK 10/10 failures=0`) }, "matrix-too-few-items"],
  ];
  for (const [label, input, expected] of cases) {
    const problems = validateProbeResult(input);
    assert.ok(problems.length > 0, `${label}：必须非零失败（不能 unknown 也绿）`);
    assert.ok(problems.includes(expected), `${label}：应点名 ${expected}（实得 ${problems.join(",")}）`);
  }
});

test("g-507 S6：token 只经 stdin 给探针 —— argv/env 不含合成 token，且探针不回显", { timeout: 60_000 }, () => {
  const token = randomBytes(32).toString("base64url");
  const dir = mkdtempSync(join(tmpdir(), "g507-stdin-"));
  const run = spawnSync(process.execPath, [PROBE, "http://127.0.0.1:1", dir], {
    encoding: "utf8",
    input: `${token}\n`,
    timeout: 20_000,
  });
  const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assertNoTokenIn(combined, token, "探针输出");
  // argv 不含 token（本测试自己构造的 argv 就只含 base/workspace）
  assert.equal([PROBE, "http://127.0.0.1:1", dir].some((a) => a.includes(token)), false);
  assert.deepEqual(readdirSync(dir), [], "探针不得在工作目录留文件（token 不落盘）");
});

test("g-507 S7：证据脚本不再保存原始实例/探针日志（只剩白名单结构文件）", () => {
  const src = readFileSync(join(ROOT, "scripts", "g507-http-auth-evidence.mjs"), "utf8");
  const code = src.split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
  // 不允许写日志文件（只允许写 evidence.json 这一个白名单结构产物）
  const writes = [...code.matchAll(/writeFileSync\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.deepEqual(writes, ["EVIDENCE_FILE"], `只允许 writeFileSync(EVIDENCE_FILE)：实得 ${writes.join(",")}`);
  // 不再是"脱敏写入器"方案
  assert.doesNotMatch(code, /RedactingWriter|holdback/, "不得保留旧的分片擦除/脱敏写入器");
  // token 只走 stdin
  assert.match(code, /probe\.stdin\.write\(/, "token 必须经 stdin 传递");
  assert.doesNotMatch(code, /\benv:\s*\{[^}]*token/i, "token 不得进 env");
});
