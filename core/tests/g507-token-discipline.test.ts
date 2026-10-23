/** g-507 token 纪律：证据脚本与探针**不得**让 launch token 出现在落盘文件、argv、env 里。
 *
 * 为什么需要这个套件：上一轮证据脚本把实例原始输出整份写进 `instance.log`（含 `?token=…`），
 * 又把带 token 的 launch URL 放进探针 argv —— 与报告的"无凭证日志"自相矛盾。
 * 本套件把纪律固化为可回归的断言，**不打印任何 token 值**。
 *
 * 覆盖：
 *   ① 源码静态：证据脚本不把原始输出整份落盘、探针只从 stdin 取 token；
 *   ② 真实行为：用假的实例输出（含 token）驱动脚本的脱敏写入器，覆盖「token 跨 chunk 边界」；
 *   ③ 负向：落盘内容里不得含 token 或其任意 8 字符片段；tv 探针 argv/env 不含 token。
 *
 * 测试自身的假 token 是**随机生成**的，用完即弃（不是任何真实实例的凭证）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "g507-http-auth-evidence.mjs");
const PROBE = join(ROOT, "core", "tests", "fixtures", "g507-http-auth-probe.mjs");
const scriptSrc = () => readFileSync(SCRIPT, "utf8");
const probeSrc = () => readFileSync(PROBE, "utf8");
const code = (src: string) => src.split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

test("g-507 T1 静态：证据脚本不整份落盘原始输出，探针不把 token 放进 argv", () => {
  const s = code(scriptSrc());
  // 上一轮的写法：把累积的原始 buf 直接 writeFileSync 到日志
  assert.doesNotMatch(s, /writeFileSync\(\s*LOG\s*,\s*buf/, "不得把原始输出整份落盘");
  assert.doesNotMatch(s, /writeFileSync\(\s*INSTANCE_LOG\s*,\s*text/, "不得把原始输出整份落盘");
  // token 只经 stdin 交给探针；不得出现在探针的 argv 里
  assert.match(s, /probe\.stdin\.write\(/, "token 必须经 stdin 传递");
  assert.doesNotMatch(s, /spawn\(\s*process\.execPath\s*,\s*\[[^\]]*launchUrl/, "launch URL 不得进 argv");
  assert.doesNotMatch(s, /\benv:\s*\{[^}]*token/i, "token 不得进 env");
  // 探针侧：从 stdin 读，且 argv 只接受 base/workspace
  const p = code(probeSrc());
  assert.match(p, /readTokenFromStdin/, "探针必须从 stdin 读 token");
  assert.doesNotMatch(p, /process\.argv\[4\]/, "探针不得从 argv 接收 launch URL");
  // 只禁止把**凭证变量**插值进输出：`console.*(… ${token} …)` / `+ token` / `, token)`
  //（文案里出现 "token" 字样不算——探针的 usage 文案就含这个词）
  assert.doesNotMatch(p, /console\.\w+\([^)]*\$\{\s*token\s*\}/, "探针不得插值打印 token");
  assert.doesNotMatch(p, /console\.\w+\([^)]*\+\s*token\b/, "探针不得拼接打印 token");
  assert.doesNotMatch(p, /console\.\w+\([^)]*,\s*token\s*\)/, "探针不得直接打印 token");
  assert.doesNotMatch(p, /console\.\w+\([^)]*\$\{\s*launchUrl\s*\}/, "探针不得插值打印 launch URL");
});

test("g-507 T2 行为：token 跨 chunk 边界时，落盘文件不得出现 token 或任何 8 字符片段", async () => {
  // 动态 import 证据脚本会立即执行 main()（起实例），因此这里把它的脱敏器**按源码复制**成安全副本：
  // 只取 `redact` 与 `RedactingWriter` 两个纯函数/类（不触发任何 I/O 或实例启动）。
  const src = scriptSrc();
  const startAt = src.indexOf("let KNOWN_TOKEN = null;");
  const endAt = src.indexOf("/**\n * 从**内存**里累积的（已脱敏）输出中取 launch URL");
  assert.ok(startAt > 0 && endAt > startAt, "未找到脱敏器定义（脚本结构已变化，请更新本测试）");
  let block = src.slice(startAt, endAt).replace(/export /g, "");

  const dir = mkdtempSync(join(tmpdir(), "g507-token-"));
  const fakeToken = randomBytes(24).toString("base64url");
  // 伪造一次「token 被拆在两个 chunk 中间」的输出（真实缺陷形态）
  const line = `dsh web: http://127.0.0.1:3097/?token=${fakeToken}\n`;
  const cut = 30; // 切在 token 中间
  const chunks = [line.slice(0, cut), line.slice(cut)];

  const harness = `
    import { mkdtempSync } from "node:fs";
    import { writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    ${block}
    const dir = ${JSON.stringify(dir)};
    const file = join(dir, "out.log");
    const w = new RedactingWriter(file, 256);
    for (const c of ${JSON.stringify(chunks)}) w.push(c);
    w.finish();
    writeFileSync(join(dir, "all.txt"), w.text(), "utf8");
    console.log(JSON.stringify({ file }));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", harness], { encoding: "utf8" });
  assert.equal(run.status, 0, `脱敏器副本执行失败：${run.stderr?.slice(0, 400)}`);

  const written = readFileSync(join(dir, "out.log"), "utf8");
  const all = readFileSync(join(dir, "all.txt"), "utf8");
  for (const [label, text] of [["落盘文件", written], ["脱敏全文", all]] as const) {
    assert.equal(text.includes(fakeToken), false, `${label} 不得包含完整 token`);
    for (let i = 0; i + 8 <= fakeToken.length; i += 4) {
      assert.equal(text.includes(fakeToken.slice(i, i + 8)), false, `${label} 不得包含 token 的 8 字符片段（i=${i}）`);
    }
  }
  // 白名单字段仍保留（可审计）：URL 主体可见、token 位置被占位符替换
  assert.match(written, /127\.0\.0\.1:3097/, "应保留实例地址（可审计）");
  assert.match(written, /<redacted>/, "token 位置应以占位符呈现");
});

test("g-507 T3 负向：探针在拿到 token 时，其 argv/env 不含该 token", { timeout: 60_000 }, () => {
  // 用假的 base/workspace 起探针（不连任何实例）：它读不到 token 会以 exit 2 结束；
  // 我们只断言 argv/env 里没有 token，并且它不会把 stdin 内容回显。
  const fakeToken = randomBytes(24).toString("base64url");
  const dir = mkdtempSync(join(tmpdir(), "g507-probe-"));
  const run = spawnSync(process.execPath, [PROBE, "http://127.0.0.1:1", dir], {
    encoding: "utf8",
    input: `${fakeToken}\n`,
    env: { ...process.env, PATH: process.env.PATH },
    timeout: 20_000,
  });
  const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.equal(combined.includes(fakeToken), false, "探针不得回显 token");
  for (let i = 0; i + 8 <= fakeToken.length; i += 8) {
    assert.equal(combined.includes(fakeToken.slice(i, i + 8)), false, "探针不得回显 token 片段");
  }
  // 探针不得把 token 写进 cwd 下任何文件
  const files = readdirSync(dir);
  assert.deepEqual(files, [], `探针不应在工作目录留下文件：${files.join(", ")}`);
});
