/**
 * g-252 判据机器断言：standing 格式化路径的**预算上界**与 **user-kind 语义**。
 *
 * 覆盖四类输入 + 超限边界：
 *  - 全约束（15 条关键禁令）/ 普通 / 混合（约束+普通）/ actor（user 私有记忆 owner 隔离）
 *  - 边界：正好等于条数上限、超 1 条；正好等于字符上界、超 1 字符；全是约束；约束+普通混合
 *
 * 修复的不变量（回退即红）：
 *  ① 关键约束**不再豁免** maxItems/maxChars（旧行为 `isConstraint(m) || 预算检查` 会让含
 *     「禁止/安全」关键词或 importance≥5 的条目无界放行）⇒ 本文件「注入条数 ≤ maxItems」
 *     与「注入行总码点 ≤ maxChars」两条断言在旧实现下必红；
 *  ② 计量口径 = **整条渲染行的码点数**（id + 来源权威标注 + 正文），不是仅正文、也不是 UTF-16 长度；
 *  ③ 关键禁令落入溢出时**显式停报**（不静默丢弃、不复制正文、不删条目）；
 *  ④ 溢出提示自身三重有界（列出条数 / 单条 digest / 整块字符）。
 *
 * 「改坏即红」：文件末尾是 hermetic 负向对照——把副本源码改回旧行为后，同一套源码不变量
 * 检查函数必须报出问题，并断言真实仓库文件逐字未变（对照不污染工作树）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  addMemory,
  formatStandingMemorySection,
} from "../ops.ts";

const repoRoot = join(import.meta.dirname, "../..");

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g252-"));
  init(root);
  return root;
}

/** 含「禁止/红线/隔离/worktree」关键词、≤200 码点的关键禁令文本。 */
const constraintText = (i: number) => `红线${i}：禁止在主工作区直接改码，必须隔离 worktree。`;

const ordinaryText = (i: number, pad = 30) => `普通事实${i}：` + "填".repeat(pad);

interface AddOpts { kind?: "project" | "user"; importance?: number; actor?: string }

const addStanding = (root: string, text: string, opts: AddOpts = {}) =>
  addMemory(root, {
    kind: opts.kind ?? "project",
    scope: "standing",
    text,
    importance: opts.importance,
    actor: opts.actor ?? "agent:g252",
  });

/** 实际注入的条目行（整行：以 `- **[mem-…]**` 开头，含来源标注与正文）。 */
const injectedLines = (sec: string) => sec.match(/^- \*\*\[mem-[a-f0-9]+\]\*\*.*$/gm) ?? [];
/** 注入部分占用的**码点**总数（与实现同一计量口径）。 */
const injectedCps = (sec: string) => injectedLines(sec).reduce((n, l) => n + [...l].length, 0);
/** 溢出提示整块长度（`> ` 开头的提示行）。 */
const noticeCps = (sec: string) =>
  sec.split("\n").filter((l) => l.startsWith("> ")).reduce((n, l) => n + [...l].length, 0);

// =====================================================================================
// 判据 1：全是约束 → 关键禁令不再无界放行条数/字符上限
// =====================================================================================

test("g-252 判据1：全部为关键约束时条数上界仍生效（旧实现会全量放行）", () => {
  const root = freshRoot();
  const N = 15;
  for (let i = 0; i < N; i++) addStanding(root, constraintText(i), { importance: 5, actor: "human:g252" });

  const sec = formatStandingMemorySection(root)!;
  const lines = injectedLines(sec);
  assert.equal(lines.length, 10, "条数上界 10 生效：15 条关键禁令只注入 10 条（旧实现注入 15 条 ⇒ 必红）");
  assert.equal(lines.filter((l) => /红线\d+：/.test(l)).length, 10, "注入的禁令正文恰好 10 条");
  assert.ok(injectedCps(sec) <= 2000, `注入行总码点 ≤ 2000（实测 ${injectedCps(sec)}）`);

  assert.ok(sec.includes("⛔ 关键隔离禁令未完整注入"), "关键禁令溢出时显式停报，不静默丢弃");
  assert.ok(sec.includes("5 条关键约束"), "停报写明未注入的关键约束条数");
  assert.ok(sec.includes("停报原因"), "停报给出原因");
  assert.ok(sec.includes("授权有界摘要"), "停报给出人工处置选项");

  const stopLine = sec.split("\n").find((l) => l.includes("⛔"))!;
  assert.equal((stopLine.match(/mem-[a-f0-9]{8}/g) ?? []).length, 5, "停报逐条列出未注入 id 供 recall");
  assert.equal((sec.match(/红线\d+：/g) ?? []).length, 10, "被折叠禁令的正文未被复制进提示（不靠无界文本补回）");
});

test("g-252 判据1：普通条目边界——正好等于条数上限不报超限，超 1 条即折叠", () => {
  const root = freshRoot();
  for (let i = 0; i < 10; i++) addStanding(root, ordinaryText(i), { importance: 2 });

  const sec10 = formatStandingMemorySection(root)!;
  assert.equal(injectedLines(sec10).length, 10, "正好 10 条：全部注入");
  assert.ok(!sec10.includes("预算超限"), "正好等于上限时不报超限（不得虚报）");
  assert.ok(injectedCps(sec10) <= 2000, "10 条渲染行仍在字符上界内");

  addStanding(root, ordinaryText(10), { importance: 2 });
  const sec11 = formatStandingMemorySection(root)!;
  assert.equal(injectedLines(sec11).length, 10, "超 1 条：第 11 条必须折叠，不得放行");
  assert.ok(sec11.includes("其余 1 条条目已折叠"), "折叠条数正确（11 - 10）");
});

test("g-252 判据1：字符上界边界——正好等于限额全注入，超 1 字符即折叠，按整条渲染行计量", () => {
  const root = freshRoot();
  for (let i = 0; i < 5; i++) addStanding(root, ordinaryText(i, 20 + i * 7), { importance: 2 });

  const unlimited = formatStandingMemorySection(root, { maxItems: 1e9, maxChars: 1e9 })!;
  const lines = injectedLines(unlimited);
  assert.equal(lines.length, 5, "无上限时 5 条全注入（用于标定渲染行长度）");
  const sizes = lines.map((l) => [...l].length);
  assert.ok(sizes.every((s) => s > 40), "渲染行含 id/来源前缀 ⇒ 仅按正文计量会低估，必被本用例测出");

  const cap3 = sizes[0] + sizes[1] + sizes[2];
  assert.equal(
    injectedLines(formatStandingMemorySection(root, { maxItems: 1e9, maxChars: cap3 })!).length,
    3,
    "正好等于字符上界：3 条全部注入",
  );
  assert.equal(
    injectedLines(formatStandingMemorySection(root, { maxItems: 1e9, maxChars: cap3 - 1 })!).length,
    2,
    "超 1 字符：第 3 条必须折叠",
  );
});

test("g-252 判据1：字符计量按码点（代理对夹具）——UTF-16 长度口径会算错", () => {
  const root = freshRoot();
  for (let i = 0; i < 4; i++) addStanding(root, `${"😀".repeat(i + 2)}事实${i}：` + "填".repeat(20), { importance: 2 });

  const unlimited = formatStandingMemorySection(root, { maxItems: 1e9, maxChars: 1e9 })!;
  const lines = injectedLines(unlimited);
  assert.ok(lines.some((l) => l.length !== [...l].length), "夹具含代理对，能区分码点 / UTF-16 口径");
  const cap2 = [...lines[0]].length + [...lines[1]].length;

  assert.equal(
    injectedLines(formatStandingMemorySection(root, { maxItems: 1e9, maxChars: cap2 })!).length,
    2,
    "按码点计量：正好 2 条",
  );
  assert.equal(
    injectedLines(formatStandingMemorySection(root, { maxItems: 1e9, maxChars: cap2 - 1 })!).length,
    1,
    "按码点计量：超 1 码点即折叠（若按 UTF-16 长度会提前折叠 ⇒ 必红）",
  );
});

// =====================================================================================
// 判据 1/2：约束+普通混合 → 禁令优先；约束本身超预算 → 显式停报
// =====================================================================================

test("g-252 判据1：约束+普通混合时禁令优先，普通条目不得挤占禁令", () => {
  const root = freshRoot();
  for (let i = 0; i < 5; i++) addStanding(root, constraintText(i), { importance: 5, actor: "human:g252" });
  for (let i = 0; i < 10; i++) addStanding(root, ordinaryText(i), { importance: 2 });

  const sec = formatStandingMemorySection(root, { maxItems: 8 })!;
  const lines = injectedLines(sec);
  assert.equal(lines.length, 8, "条数上界 8 生效");
  assert.equal(lines.filter((l) => /红线\d+：/.test(l)).length, 5, "5 条禁令全部注入（只被另一条禁令挤出，不被普通条目挤占）");
  assert.equal(lines.filter((l) => /普通事实\d+：/.test(l)).length, 3, "普通条目只剩 3 个名额");
  assert.ok(!sec.includes("⛔"), "5 条禁令放得进 8 条预算 ⇒ 不得虚报禁令溢出");
  assert.ok(sec.includes("其余 7 条条目已折叠"), "折叠的都是普通条目（10 - 3）");
});

test("g-252 判据2：关键禁令本身超预算时显式停报，不静默丢弃、不复制正文、不删条目", () => {
  const root = freshRoot();
  for (let i = 0; i < 3; i++) addStanding(root, constraintText(i), { importance: 5, actor: "human:g252" });
  for (let i = 0; i < 20; i++) addStanding(root, ordinaryText(i), { importance: 2 });

  const sec = formatStandingMemorySection(root, { maxItems: 2 })!;
  const lines = injectedLines(sec);
  assert.equal(lines.length, 2, "预算只有 2 条 ⇒ 只注入 2 条禁令");
  assert.equal(lines.filter((l) => /红线\d+：/.test(l)).length, 2);

  const stopLine = sec.split("\n").find((l) => l.includes("⛔"))!;
  assert.ok(stopLine.includes("1 条关键约束"), "停报写明未注入的关键约束条数");
  assert.ok(stopLine.includes("未注入 id"), "停报列出未注入 id");
  assert.equal((sec.match(/红线\d+：/g) ?? []).length, 2, "未注入禁令只以 id 出现，正文未被补回");

  // 记忆条目本身未被删除：仍可按需 recall 全量
  assert.ok(sec.includes("其余 21 条条目已折叠"), "折叠总数诚实（23 - 2）");
});

test("g-252 判据2：预算连一条禁令都容不下时显式停报，不静默返回 null", () => {
  const root = freshRoot();
  addStanding(root, constraintText(0), { importance: 5, actor: "human:g252" });

  const sec = formatStandingMemorySection(root, { maxChars: 10 });
  assert.ok(sec, "有关键禁令但预算装不下 ⇒ 必须显式停报，不得静默 return null（禁令无声消失）");
  assert.equal(injectedLines(sec!).length, 0, "确实一条都装不下");
  assert.ok(sec!.includes("⛔ 关键隔离禁令未完整注入"), "停报可见");
  assert.ok(sec!.includes("未注入 id"), "列出未注入 id 供 recall");
});

test("g-252 判据1：只有普通条目且预算装不下时保持原有 null 语义（不无中生有）", () => {
  const root = freshRoot();
  addStanding(root, ordinaryText(0, 50), { importance: 2 });
  assert.equal(formatStandingMemorySection(root, { maxChars: 10 }), null, "无禁令可停报时维持原语义");
});

// =====================================================================================
// 判据 3：user-kind 常驻语义（owner 隔离 / 不跨 actor 泄漏）
// =====================================================================================

test("g-252 判据3：user 常驻记忆 owner 隔离——无 actor 仅按需 recall，匹配 actor 可见且不跨 actor 泄漏", () => {
  const root = freshRoot();
  addStanding(root, "项目共享硬性事实：全量测试须全绿", { importance: 4, actor: "human:gui" });
  addStanding(root, "用户私有偏好：仅限张三可见", { kind: "user", importance: 4, actor: "human:zhangsan" });
  addStanding(root, "用户私有偏好：仅限李四可见", { kind: "user", importance: 4, actor: "human:lisi" });

  // host 固定植入章节的真实调用形态：不传 actor ⇒ recallMemory 过滤掉全部 user 条目
  const anon = formatStandingMemorySection(root)!;
  assert.ok(anon.includes("项目共享硬性事实"), "project 条目共享可见");
  assert.ok(!anon.includes("仅限张三可见") && !anon.includes("仅限李四可见"), "无 actor 路径看不到任何 user 条目（等价仅按需 recall）");

  const zhang = formatStandingMemorySection(root, { actor: "human:zhangsan" })!;
  assert.ok(zhang.includes("仅限张三可见"), "匹配 owner 的 actor 可见自身 user 常驻记忆");
  assert.ok(!zhang.includes("仅限李四可见"), "不得跨 actor 泄漏");
  const lisi = formatStandingMemorySection(root, { actor: "human:lisi" })!;
  assert.ok(lisi.includes("仅限李四可见") && !lisi.includes("仅限张三可见"), "李四对称可见自身、看不到张三");
  assert.notEqual(zhang, lisi, "同 root 不同 actor 渲染必须不同（若加缓存，缓存键必须含 actor）");
});

// =====================================================================================
// 判据 3：溢出提示有界且诚实
// =====================================================================================

test("g-252 判据3：溢出提示自身有界——条目数增长不放大提示，且诚实说明省略了多少", () => {
  const root = freshRoot();
  for (let i = 0; i < 300; i++) addStanding(root, ordinaryText(i, 24), { importance: 2, actor: `agent:g252-${i}` });
  const sec300 = formatStandingMemorySection(root)!;
  const len300 = noticeCps(sec300);

  for (let i = 300; i < 400; i++) addStanding(root, ordinaryText(i, 24), { importance: 2, actor: `agent:g252-${i}` });
  const sec400 = formatStandingMemorySection(root)!;
  const len400 = noticeCps(sec400);

  assert.ok(len300 <= 1000, `溢出提示有硬上界（实测 ${len300} 码点），不随折叠条数膨胀`);
  assert.equal(len400, len300, "溢出条目再多 100 条，提示长度逐字不变 ⇒ 有界");
  assert.ok(sec400.includes("条未列出（id 见 memory/memory.jsonl）"), "诚实说明还有多少条未列出");
  assert.ok(sec400.includes("已折叠（可通过 recallMemory 按需检索）"), "给出按需检索出路");
  assert.ok(sec400.includes("其余 390 条条目已折叠"), "折叠总数诚实");
  assert.equal(injectedLines(sec400).length, 10, "注入条数不因提示而放松");
  assert.ok(injectedCps(sec400) <= 2000, `注入部分仍 ≤ 2000（实测 ${injectedCps(sec400)}）`);
});

// =====================================================================================
// 负向对照：源码不变量回退即红（hermetic，镜像副本，不污染工作树）
// =====================================================================================

/** g-252 源码不变量检查器（可注入副本，便于 hermetic 负向对照）。返回问题列表。 */
function standingSourceProblems(src: string): string[] {
  const problems: string[] = [];
  if (/isConstraint\(m\)\s*\|\|/.test(src)) {
    problems.push("常驻段选择仍在用 `isConstraint(m) || …` 的 OR 放行：关键禁令可无界绕过条数/字符上限");
  }
  if (!/included\.length < maxItems && accumulatedChars \+ lineLen <= maxChars/.test(src)) {
    problems.push("常驻段选择未同时施加条数与字符双上限");
  }
  const listed = src.match(/STANDING_OVERFLOW_MAX_LISTED = (\d+);/);
  if (!listed) problems.push("溢出提示缺少列出条数有界上限");
  else if (Number(listed[1]) > 64) problems.push(`溢出提示列出条数上界漂移（${listed[1]} > 64）：提示可被无界放大`);
  const chars = src.match(/STANDING_OVERFLOW_MAX_CHARS = (\d+);/);
  if (!chars) problems.push("溢出提示缺少整块字符有界上限");
  else if (Number(chars[1]) > 2000) problems.push(`溢出提示整块字符上界漂移（${chars[1]} > 2000）`);
  if (!/关键隔离禁令未完整注入/.test(src)) problems.push("关键禁令溢出时缺少显式停报（会退化为静默丢弃）");
  if (/核心安全约束始终保留/.test(src)) problems.push("溢出提示仍宣称核心约束始终保留：禁令超限时是假话，可见性不诚实");
  return problems;
}

test("g-252 负向对照：预算上界 / 停报 / 提示有界被改回旧行为时必红", () => {
  const opsPath = join(repoRoot, "core/ops.ts");
  const real = readFileSync(opsPath, "utf8");
  assert.deepEqual(standingSourceProblems(real), [], "真实 core/ops.ts 满足 g-252 不变量");

  // 改坏 1：恢复 `isConstraint(m) ||` OR 放行（即 g-240 遗留形态）
  const reverted = real.replace(
    "if (included.length < maxItems && accumulatedChars + lineLen <= maxChars) {",
    "if (isConstraint(m) || (included.length < maxItems && accumulatedChars + lineLen <= maxChars)) {",
  );
  assert.notEqual(reverted, real, "负向对照必须真的改到目标行（否则对照无效）");
  assert.ok(standingSourceProblems(reverted).some((p) => p.includes("OR 放行")), "回退 OR 放行必红");

  // 改坏 2：溢出提示上界放大到无界
  const unbounded = real.replace("STANDING_OVERFLOW_MAX_LISTED = 12;", "STANDING_OVERFLOW_MAX_LISTED = 9999;");
  assert.ok(standingSourceProblems(unbounded).some((p) => p.includes("列出条数上界漂移")), "提示有界性漂移必红");

  // 改坏 3：去掉显式停报
  const silent = real.replace(/关键隔离禁令未完整注入/g, "预算超限");
  assert.ok(standingSourceProblems(silent).some((p) => p.includes("缺少显式停报")), "去掉停报必红");

  // hermetic：负向对照逐字未变
  assert.equal(readFileSync(opsPath, "utf8"), real, "负向对照污染了真实 core/ops.ts");
});
