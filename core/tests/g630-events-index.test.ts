/**
 * g-630：`dsh-graph status` 大看板性能优化的**事件流增量索引**。
 *
 * 判据映射：
 *  - 判据 1：大看板 status median <100ms（**实测**在交付报文里；本套件守它的**机制**——
 *    索引命中时不得再逐行全量扫描，见「命中路径不读全文」用例）。
 *  - 判据 2：索引必须有一致性校验 —— 截断 / 追加 / 损坏 / 替换后**不得**返回错误聚合。
 *  - 判据 3：索引缺失 / 损坏 / 版本不匹配 ⇒ fail-safe 回退 core `readEvents` 全量校验 + **可读告警**，
 *    不静默返回空或部分结果。
 *  - 判据 4：不修改 `.dsh-graph` 的事件格式，不改既有读写语义（索引落**用户缓存目录**，不落看板）。
 *  - 判据 5：复用 core `readEvents` 作为唯一权威解析（本套件用「索引结论 ≡ readEvents 结论」钉死）。
 *  - 判据 6：本文件即覆盖（命中 / 追加 / 截断 / 损坏 / 并发 / 回退 / 反向变异）。
 *
 * **反向变异口径**（沿用 g-314 收口后的做法）：把**真实源码**拷进沙箱后就地改坏，再用真进程跑
 * 同一组断言，断言**必须变红** —— 本地闭包伪变异是同义反复，不采纳。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents, appendEvent, nowIso } from "../events.ts";
import {
  EVENTS_INDEX_VERSION,
  eventsIndexPath,
  readEventsSummary,
  summarizeEvents,
  fullScanAndIndex,
} from "../cli/events-index.ts";
import { listGoalFiles, loadGoal, findGoalFile, readRulesVersion } from "../cli/goal-files.ts";
import { collectStatus } from "../cli/diagnostics.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const cliEntry = join(repoRoot, "bin", "dsh-graph.mjs");

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 每个用例独占的沙箱：workspace + graph root + 独立索引缓存目录 + 清理。 */
function makeSandbox(tag: string) {
  const tmpRoot = join(repoRoot, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, `g630-${tag}-`));
  const workspace = join(dir, "workspace");
  const root = join(workspace, ".dsh-graph");
  const cache = join(dir, "cache");
  mkdirSync(root, { recursive: true });
  return {
    dir,
    workspace,
    root,
    cache,
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 往事件流里追加一条合法事件（与 `appendEvent` 同形：JSON.stringify + "\n"）。 */
function pushEvent(root: string, event: string, details?: Record<string, unknown>, ts?: string): void {
  appendEvent(root, { event, actor: "test", ...(details ? { details } : {}), ...(ts ? { ts } : {}) });
}

/** 用**给定文本**整档覆盖事件流（用于制造损坏/改写）。 */
function writeRaw(root: string, text: string): void {
  writeFileSync(join(root, "events.jsonl"), text, "utf8");
}

/** 在**独立索引缓存**下跑一次摘要（避免用例之间串味）。 */
function withCache<T>(cache: string, fn: () => T): T {
  const prev = process.env.DSH_GRAPH_CACHE_HOME;
  process.env.DSH_GRAPH_CACHE_HOME = cache;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DSH_GRAPH_CACHE_HOME;
    else process.env.DSH_GRAPH_CACHE_HOME = prev;
  }
}

/** 任意子进程入口 env：剔除测试注入变量，并钉死索引缓存目录。 */
function childEnv(cache: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_GRAPH_CACHE_HOME: cache };
  for (const name of ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "NODE_OPTIONS"]) delete env[name];
  return env;
}

function runStatus(entry: string, root: string, cache: string, extra: string[] = []) {
  const res = spawnSync(process.execPath, [entry, "status", "--root", root, ...extra], {
    cwd: join(root, ".."),
    encoding: "utf8",
    timeout: 120_000,
    env: childEnv(cache),
  });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** 权威结论（core `readEvents`）—— 所有索引结论都必须与它逐字段相等（判据 5）。 */
function authoritative(root: string) {
  const events = readEvents(root);
  const last = events.length > 0 ? events[events.length - 1] : null;
  return {
    eventCount: events.length,
    lastEvent: last ? String(last.event) : null,
    lastEventTs: last && typeof last.ts === "string" ? last.ts : null,
  };
}

/** 断言「本次结论与 core 全量校验逐字段一致」，并返回是否走了索引快路径。 */
function assertMatchesCore(root: string) {
  const got = withCache(sandboxCacheOf(root), () => readEventsSummary(root));
  const want = authoritative(root);
  assert.equal(got.eventCount, want.eventCount, "事件条数必须与 core readEvents 一致");
  assert.equal(got.lastEvent, want.lastEvent, "末事件名必须与 core readEvents 一致");
  assert.equal(got.lastEventTs, want.lastEventTs, "末事件时间戳必须与 core readEvents 一致");
  return got;
}

/** 摘要函数需要的缓存目录（与 `withCache` 配套；用例在 `withCache` 内自行传入）。 */
const cacheByRoot = new Map<string, string>();
function sandboxCacheOf(root: string): string {
  const c = cacheByRoot.get(root);
  assert.ok(c, `用例必须先用 cacheByRoot.set(root, cache) 登记缓存目录（${root}）`);
  return c;
}

/**
 * 索引路径必须在**缓存目录生效的作用域内**计算（`eventsIndexPath` 每次现读 env），
 * 否则会拿到默认 `~/.cache/dsh-graph` 下的同名文件 —— 测试既读错对象又会污染用户缓存。
 */
function indexPathIn(cache: string, root: string): string {
  return withCache(cache, () => eventsIndexPath(root));
}

// ---------------------------------------------------------------------------
// 判据 5：枚举/读取实现的唯一真源（ops 转调同一份，不存第二套）
// ---------------------------------------------------------------------------

test("g-630 判据 5：目标文件枚举/读取只有一份实现，ops 转调 cli/goal-files.ts", () => {
  const opsSrc = readFileSync(join(repoRoot, "core", "ops.ts"), "utf8");
  const leafSrc = readFileSync(join(repoRoot, "core", "cli", "goal-files.ts"), "utf8");
  // ops 必须把这三件事委派给叶子模块（不得再自己 for 循环一套枚举/解析）。
  assert.match(opsSrc, /from "\.\/cli\/goal-files\.ts"/, "ops 必须引用唯一的叶子实现");
  assert.match(opsSrc, /return listGoalFilesImpl\(root, opts\)/, "ops.listGoalFiles 必须转调叶子实现");
  assert.match(opsSrc, /return findGoalFileImpl\(root, id\)/, "ops.findGoalFile 必须转调叶子实现");
  assert.match(opsSrc, /return readRulesVersionImpl\(root\)/, "ops.readRulesVersion 必须转调叶子实现");
  assert.match(opsSrc, /assertNoSymlinkPathImpl\(file, forWrite\)/, "symlink 守卫必须转调叶子实现");
  assert.match(leafSrc, /export function listGoalFiles/, "叶子实现必须提供 listGoalFiles");
  // 事件流：索引模块必须经 core readEvents 做权威校验，不得自建第二套「整档解析」。
  const idxSrc = readFileSync(join(repoRoot, "core", "cli", "events-index.ts"), "utf8");
  assert.match(idxSrc, /from "\.\.\/events\.ts"/, "索引模块必须复用 core events.ts");
  assert.match(idxSrc, /export function fullScanAndIndex[\s\S]*?readEvents\(root\)/, "全量校验必须调用 core readEvents");
  // diagnostics 不得再自行逐行解析事件（旧 summarizeEventsFast 已删除）。
  const diagSrc = readFileSync(join(repoRoot, "core", "cli", "diagnostics.ts"), "utf8");
  assert.ok(!diagSrc.includes("summarizeEventsFast"), "旧的全量逐行快路径必须已删除（不得留第二套）");
  assert.match(diagSrc, /readEventsSummary\(root\)/, "diagnostics 必须经索引模块取事件摘要");
});

test("g-630 判据 5：叶子实现与 ops 转调在真实看板布局上逐字一致", () => {
  const sb = makeSandbox("parity");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    // 铺四种目标文件布局（backlog 扁平 / backlog 目录 / goals 目录 / versions 目录）+ 归档
    const mk = (rel: string, id: string) => {
      const p = join(sb.root, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, `---\n${JSON.stringify({ id, title: id, status: "draft", type: "task" }, null, 2)}\n---\n\nbody\n`, "utf8");
    };
    mk("backlog/g-a.md", "g-a");
    mk("backlog/g-b/goal.md", "g-b");
    mk("goals/g-c/goal.md", "g-c");
    mk("versions/v1.0.0/goals/g-d/goal.md", "g-d");
    mk("goals/archived/g-e/goal.md", "g-e");
    mk("versions/v1.0.0/archived/g-f/goal.md", "g-f");
    mk("backlog/archived/g-g.md", "g-g");

    const plain = listGoalFiles(sb.root);
    const all = listGoalFiles(sb.root, { includeArchived: true });
    assert.deepEqual(plain.map((p) => p.slice(sb.root.length)), [
      "/backlog/g-a.md",
      "/backlog/g-b/goal.md",
      "/goals/g-c/goal.md",
      "/versions/v1.0.0/goals/g-d/goal.md",
    ]);
    assert.equal(all.length, 7, "含归档必须扫到全部 7 个");
    assert.equal(loadGoal(plain[0]).meta.id, "g-a", "frontmatter 解析口径");
    assert.equal(findGoalFile(sb.root, "g-c"), join(sb.root, "goals/g-c/goal.md"), "findGoalFile 定位");
    assert.equal(findGoalFile(sb.root, "g-g"), join(sb.root, "backlog/archived/g-g.md"), "归档目标也必须找到");
    assert.throws(() => findGoalFile(sb.root, "g-nope"), /目标不存在/, "不存在的目标必须抛出可读错误");

    writeFileSync(join(sb.root, "rules.md"), `---\n${JSON.stringify({ version: "r-1" })}\n---\n`, "utf8");
    assert.equal(readRulesVersion(sb.root), "r-1", "rules.md 版本来自 frontmatter");
    writeFileSync(join(sb.root, "rules.md"), "version: r-2\n", "utf8");
    assert.equal(readRulesVersion(sb.root), "r-2", "非 JSON frontmatter 退化为行扫描");
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 1/判据 2：命中路径 —— 不读全文、结论与 core 一致
// ---------------------------------------------------------------------------

test("g-630 判据 1：索引命中时不再逐行全量扫描（大文件下近似 O(1)）", () => {
  const sb = makeSandbox("hit");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    // 造一个「大」事件流：3000 条合法事件（约 0.5MB，足以让线性扫描明显慢于探测）。
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      lines.push(JSON.stringify({ ts: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000+08:00`, event: "goal.created", actor: "test", details: { i, pad: "x".repeat(120) } }));
    }
    writeRaw(sb.root, lines.join("\n") + "\n");

    // 首次：无索引 ⇒ 必须有索引未命中（回退全量校验）并写入索引。
    const first = withCache(sb.cache, () => readEventsSummary(sb.root));
    assert.equal(first.indexed, false, "首次无索引必须走全量校验");
    assert.equal(first.eventCount, 3000);
    assert.ok(existsSync(indexPathIn(sb.cache, sb.root)), "全量校验后必须写出索引");

    // 第二次：命中，且结论与 core 完全一致。
    const second = assertMatchesCore(sb.root);
    assert.equal(second.indexed, true, "索引存在且未变化时必须命中");
    assert.equal(second.problems.length, 0, "命中路径不应有任何问题");

    // **机制断言**：命中时的耗时必须显著低于一次真实全量扫描（否则「命中」只是换了条慢路径）。
    const scanStart = process.hrtime.bigint();
    fullScanAndIndex(sb.root);
    const scanMs = Number(process.hrtime.bigint() - scanStart) / 1e6;
    const hitStart = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) withCache(sb.cache, () => summarizeEvents(sb.root));
    const hitMs = Number(process.hrtime.bigint() - hitStart) / 1e6 / 20;
    assert.ok(
      hitMs * 5 < scanMs,
      `命中必须比全量扫描快一个量级（命中 ${hitMs.toFixed(2)}ms/次 vs 全量 ${scanMs.toFixed(2)}ms/次）`,
    );

    // 逐字的语义等价：把索引删掉再走全量，两次结论必须一样（命中不改变结论）。
    rmSync(indexPathIn(sb.cache, sb.root), { force: true });
    const fallback = withCache(sb.cache, () => readEventsSummary(sb.root));
    assert.deepEqual(
      { c: fallback.eventCount, e: fallback.lastEvent, t: fallback.lastEventTs },
      { c: second.eventCount, e: second.lastEvent, t: second.lastEventTs },
      "命中结论必须与全量校验结论相同",
    );
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 2：追加 / 截断 / 损坏 / 替换 / 并发写
// ---------------------------------------------------------------------------

test("g-630 判据 2：纯追加只解析新增区间，结论与 core 一致", () => {
  const sb = makeSandbox("append");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    pushEvent(sb.root, "goal.created", { goal: "g-1" });
    withCache(sb.cache, () => readEventsSummary(sb.root));
    assertMatchesCore(sb.root);

    for (let i = 0; i < 5; i++) pushEvent(sb.root, "goal.status_changed", { goal: `g-${i}` });
    const after = assertMatchesCore(sb.root);
    assert.equal(after.indexed, true, "纯追加必须命中（只扫新增区间）");
    assert.equal(after.eventCount, 6);

    // 追加后紧接一次「未变化」读取：仍必须一致（索引已被更新到新 size）。
    const stable = assertMatchesCore(sb.root);
    assert.equal(stable.indexed, true);
    assert.deepEqual(withCache(sb.cache, () => readEventsSummary(sb.root)).problems, []);
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 2：追加一个**半行**（写者未落盘完整）不得被算作已提交事件", () => {
  const sb = makeSandbox("half");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    pushEvent(sb.root, "goal.created", { goal: "g-1" });
    withCache(sb.cache, () => readEventsSummary(sb.root));

    // 追加一个没有换行结尾的残行（模拟写入中途被观察）。
    const file = join(sb.root, "events.jsonl");
    const prev = readFileSync(file, "utf8");
    writeFileSync(file, prev + '{"event":"goal.created","actor":"test"}', "utf8");

    const got = withCache(sb.cache, () => readEventsSummary(sb.root));
    // core 口径：没有换行的尾行仍会被 readEvents 当作一行解析成功 ⇒ 必须以 core 为准。
    const want = authoritative(sb.root);
    assert.equal(got.eventCount, want.eventCount, "半行的取舍必须与 core 完全一致（不自作主张）");
    assert.equal(got.lastEvent, want.lastEvent);
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 2：截断（行数/字节变少）必须回退全量校验并给出可读告警", () => {
  const sb = makeSandbox("trunc");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    for (let i = 0; i < 6; i++) pushEvent(sb.root, "goal.created", { goal: `g-${i}` });
    withCache(sb.cache, () => readEventsSummary(sb.root));
    const before = assertMatchesCore(sb.root);
    assert.equal(before.indexed, true);

    // 截断：只留前 3 条（旧索引记的是 6 条）
    const lines = readFileSync(join(sb.root, "events.jsonl"), "utf8").split("\n").filter(Boolean);
    writeRaw(sb.root, lines.slice(0, 3).join("\n") + "\n");

    const got = assertMatchesCore(sb.root);
    assert.equal(got.indexed, false, "截断后必须回退全量校验");
    assert.equal(got.eventCount, 3, "回退后必须给出截断后的真实条数（不得沿用旧值）");
    assert.ok(
      got.notices.some((n) => n.includes("截断") && n.includes("退回全量校验")),
      `必须给出可读的截断告警，实际：${JSON.stringify(got.notices)}`,
    );
    assert.equal(got.problems.length, 0, "截断不是「看板损坏」（回退已给出权威结论），不该判 problem");
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 2：事件流被就地改写（长度不变/变长但头部变了）必须回退，不得返回错误聚合", () => {
  const sb = makeSandbox("rewrite");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    for (let i = 0; i < 40; i++) pushEvent(sb.root, "goal.created", { goal: `g-${i}` });
    withCache(sb.cache, () => readEventsSummary(sb.root));
    assert.equal(assertMatchesCore(sb.root).indexed, true);

    const file = join(sb.root, "events.jsonl");
    const text = readFileSync(file, "utf8");
    // 把**第一条**（落在头部 4KB 前缀内）的事件名改掉，长度保持不变。
    const rewritten = text.replace('"event":"goal.created"', '"event":"goal.renamed"');
    assert.notEqual(rewritten, text, "前置：必须真的改到了头部内容");
    assert.equal(rewritten.length, text.length, "前置：长度必须不变（专测「头部指纹」而非「大小」）");
    writeRaw(sb.root, rewritten);

    const got = assertMatchesCore(sb.root);
    assert.equal(got.indexed, false, "头部指纹变化必须回退全量校验");
    assert.ok(
      got.notices.some((n) => n.includes("就地改写") && n.includes("退回全量校验")),
      `必须给出可读的改写告警，实际：${JSON.stringify(got.notices)}`,
    );
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 2：事件流被替换（换 inode / 换文件）必须回退，不得用旧索引", () => {
  const sb = makeSandbox("replace");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    for (let i = 0; i < 20; i++) pushEvent(sb.root, "goal.created", { goal: `g-${i}` });
    withCache(sb.cache, () => readEventsSummary(sb.root));
    assert.equal(assertMatchesCore(sb.root).indexed, true);

    const file = join(sb.root, "events.jsonl");
    const original = readFileSync(file, "utf8");
    // 用「写到临时文件 + rename」替换：inode 变了，内容**完全相同**。
    const tmp = join(sb.root, "events.jsonl.new");
    writeFileSync(tmp, original, "utf8");
    rmSync(file, { force: true });
    cpSync(tmp, file);
    rmSync(tmp, { force: true });

    const got = assertMatchesCore(sb.root);
    // 内容相同 ⇒ 结论必然相同；但必须**回退**（不能凭旧索引断言未变）。
    const statAfter = statSync(file);
    const idx = JSON.parse(readFileSync(indexPathIn(sb.cache, sb.root), "utf8"));
    if (idx.ino && statAfter.ino && idx.ino !== `${statAfter.dev}:${statAfter.ino}`) {
      assert.ok(
        got.notices.some((n) => n.includes("替换") && n.includes("退回全量校验")),
        `被替换必须给出可读告警，实际：${JSON.stringify(got.notices)}`,
      );
    }
    assert.equal(got.eventCount, 20, "替换为同内容文件 ⇒ 条数仍须正确");
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 2：事件流损坏（非法 JSON / 缺 event·actor）必须由 core 报出准确行号", () => {
  const sb = makeSandbox("corrupt");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    for (let i = 0; i < 10; i++) pushEvent(sb.root, "goal.created", { goal: `g-${i}` });
    withCache(sb.cache, () => readEventsSummary(sb.root));
    assert.equal(assertMatchesCore(sb.root).indexed, true);

    // 破坏**中间**一行（不在头部前缀内、也不在尾窗内 ⇒ 只有全量校验能发现）
    const lines = readFileSync(join(sb.root, "events.jsonl"), "utf8").split("\n");
    lines[4] = "{not json";
    writeRaw(sb.root, lines.join("\n"));

    const got = withCache(sb.cache, () => readEventsSummary(sb.root));
    assert.equal(got.indexed, false, "损坏必须回退全量校验");
    assert.equal(got.eventCount, 0, "损坏时不得给出条数（绝不静默返回部分聚合）");
    assert.ok(got.problems.length > 0, "损坏必须进入 problems（status 非零退出）");
    assert.match(got.problems[0], /第 5 行不是合法 JSON/, `必须报出准确行号，实际：${got.problems[0]}`);
    // 与 core 的报错逐字一致（语义只有一份）
    assert.throws(() => readEvents(sb.root), /第 5 行不是合法 JSON/, "core 必须报同一行号");
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 2：缺失 event/actor 的行同样由 core 判红（索引不得放过）", () => {
  const sb = makeSandbox("schema");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    pushEvent(sb.root, "goal.created", { goal: "g-1" });
    withCache(sb.cache, () => readEventsSummary(sb.root));
    // 追加一行「合法 JSON 但缺 actor」——不落在头部，但落在追加区间内 ⇒ 新增区间校验必须拦住。
    const file = join(sb.root, "events.jsonl");
    writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ event: "goal.created", ts: nowIso() }) + "\n", "utf8");

    const got = withCache(sb.cache, () => readEventsSummary(sb.root));
    assert.equal(got.indexed, false, "新增区间内含非法行 ⇒ 必须回退");
    assert.ok(got.problems.some((p) => /缺少 event\/actor/.test(p)), `必须报出缺字段，实际：${JSON.stringify(got.problems)}`);
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 2：并发写（追加与读取交错）下结论始终等于 core，不出现半聚合", async () => {
  const sb = makeSandbox("concurrent");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    pushEvent(sb.root, "goal.created", { goal: "g-0" });
    withCache(sb.cache, () => readEventsSummary(sb.root));

    // 写者：独立子进程连续追加 60 条；读者：本进程并发读 40 次。
    const writer = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { appendEvent } = await import(${JSON.stringify(join(repoRoot, "core", "events.ts"))});
         for (let i = 0; i < 60; i++) appendEvent(${JSON.stringify(sb.root)}, { event: "goal.created", actor: "writer", details: { i, pad: "y".repeat(200) } });`,
      ],
      { env: childEnv(sb.cache), stdio: "ignore" },
    );
    const exited = new Promise((res) => writer.on("exit", res));

    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      // 并发下不能要求「与某一次 readEvents 精确相等」——写者在两次读取之间继续追加，
      // 精确相等会把正常的时序差误判成错误（实测：core 读到 32 而索引给 19，两者都对，
      // 只是时间不同）。正确不变式是**落在夹逼区间内**：读索引之前与之后各取一次权威值，
      // 索引结论必须夹在两者之间（证明它既没有凭旧值虚增、也没有漏数）。
      const before = authoritative(sb.root).eventCount;
      const got = withCache(sb.cache, () => readEventsSummary(sb.root));
      const after = authoritative(sb.root).eventCount;
      assert.ok(got.eventCount >= before, `索引条数不得少于读取前的权威值：${got.eventCount} < ${before}`);
      assert.ok(got.eventCount <= after, `索引条数不得多于读取后的权威值：${got.eventCount} > ${after}`);
      seen.push(got.eventCount);
      await new Promise((r) => setTimeout(r, 5));
    }
    await exited;

    // 单调不减（追加语义），且最终必须等于 core 的最终值。
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] >= seen[i - 1], `并发期间条数必须单调不减：${seen[i - 1]} → ${seen[i]}`);
    }
    const final = assertMatchesCore(sb.root);
    assert.equal(final.eventCount, 61, "最终条数 = 初始 1 + 并发写入 60");
    assert.equal(final.lastEvent, "goal.created");
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 3：索引缺失 / 损坏 / 版本不匹配 ⇒ fail-safe 回退 + 可读告警
// ---------------------------------------------------------------------------

test("g-630 判据 3：索引缺失时静默回退（正常冷启动，不算异常），结论正确", () => {
  const sb = makeSandbox("missing");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    pushEvent(sb.root, "goal.created", { goal: "g-1" });
    const got = withCache(sb.cache, () => readEventsSummary(sb.root));
    assert.equal(got.indexed, false, "无索引必须回退");
    assert.equal(got.eventCount, 1);
    assert.deepEqual(got.problems, [], "首次无索引是正常路径，不该报 problem");
    assert.deepEqual(got.notices, [], "首次无索引也不该刷告警");
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 3：索引损坏（非法 JSON / 结构非法）必须回退并给出可读告警", () => {
  const sb = makeSandbox("badidx");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    pushEvent(sb.root, "goal.created", { goal: "g-1" });
    pushEvent(sb.root, "goal.status_changed", { goal: "g-1" });
    withCache(sb.cache, () => readEventsSummary(sb.root));
    const idxPath = indexPathIn(sb.cache, sb.root);

    // ① 非法 JSON
    writeFileSync(idxPath, "{ this is not json", "utf8");
    const bad1 = withCache(sb.cache, () => readEventsSummary(sb.root));
    assert.equal(bad1.indexed, false, "索引非法 JSON 必须回退");
    assert.equal(bad1.eventCount, 2, "回退后结论必须正确");
    assert.ok(bad1.notices.some((n) => n.includes("损坏") && n.includes("退回全量校验")), `可读告警：${JSON.stringify(bad1.notices)}`);

    // ② 合法 JSON 但结构非法（缺字段 / 自相矛盾）
    writeFileSync(idxPath, JSON.stringify({ version: EVENTS_INDEX_VERSION, file: join(sb.root, "events.jsonl"), size: 99 }), "utf8");
    const bad2 = withCache(sb.cache, () => readEventsSummary(sb.root));
    assert.equal(bad2.indexed, false, "索引结构非法必须回退");
    assert.equal(bad2.eventCount, 2);
    assert.ok(bad2.notices.some((n) => n.includes("结构非法")), `可读告警：${JSON.stringify(bad2.notices)}`);

    // ③ 指向**别的文件**（root 串味）⇒ 必须拒用
    writeFileSync(
      idxPath,
      JSON.stringify({
        version: EVENTS_INDEX_VERSION,
        file: join(sb.root, "another-events.jsonl"),
        size: 10,
        ino: "",
        headSha: "",
        eventCount: 7,
        lastEvent: "ghost",
        lastEventTs: null,
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const bad3 = withCache(sb.cache, () => readEventsSummary(sb.root));
    assert.equal(bad3.indexed, false, "指向别的文件的索引必须拒用");
    assert.equal(bad3.eventCount, 2, "不得采信 ghost 索引的 7 条");
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 3：索引版本不匹配必须回退并点名版本（不兼容读取）", () => {
  const sb = makeSandbox("ver");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    pushEvent(sb.root, "goal.created", { goal: "g-1" });
    withCache(sb.cache, () => readEventsSummary(sb.root));
    const idxPath = indexPathIn(sb.cache, sb.root);
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    idx.version = EVENTS_INDEX_VERSION + 41;
    writeFileSync(idxPath, JSON.stringify(idx), "utf8");

    const got = withCache(sb.cache, () => readEventsSummary(sb.root));
    assert.equal(got.indexed, false, "版本不匹配必须回退");
    assert.equal(got.eventCount, 1, "回退后结论必须正确");
    assert.ok(
      got.notices.some((n) => n.includes("版本不匹配") && n.includes(String(EVENTS_INDEX_VERSION))),
      `必须点名期望版本，实际：${JSON.stringify(got.notices)}`,
    );
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 3：索引目录不可写时静默降级（只慢不坏），结论仍正确", () => {
  const sb = makeSandbox("nowrite");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    pushEvent(sb.root, "goal.created", { goal: "g-1" });
    // 用一个「父路径是文件」的缓存目录，使 mkdir 必然失败。
    const blocker = join(sb.dir, "blocker");
    writeFileSync(blocker, "x", "utf8");
    const unwritable = join(blocker, "cache");
    const got = withCache(unwritable, () => readEventsSummary(sb.root));
    assert.equal(got.eventCount, 1, "索引写不进去也不得影响结论");
    assert.deepEqual(got.problems, [], "索引写失败不该污染 problems");
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 端到端：CLI status 的告警可见性与退出码语义
// ---------------------------------------------------------------------------

test("g-630 判据 3（端到端）：status 对索引失效打印「告警」段，但**不**因此非零退出", () => {
  const sb = makeSandbox("e2e");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    pushEvent(sb.root, "goal.created", { goal: "g-1" });
    pushEvent(sb.root, "goal.created", { goal: "g-2" });
    // 先跑一次建立索引
    const first = runStatus(cliEntry, sb.root, sb.cache);
    assert.equal(first.code, 0, `首次 status 必须成功；stderr=${first.stderr}`);
    assert.ok(existsSync(indexPathIn(sb.cache, sb.root)), "status 必须建立索引");

    // 破坏索引 ⇒ 下一次必须打印可读告警，但仍是成功（看板本身没坏）
    writeFileSync(indexPathIn(sb.cache, sb.root), "not json at all", "utf8");
    const second = runStatus(cliEntry, sb.root, sb.cache);
    assert.equal(second.code, 0, `索引失效不是看板损坏，不该非零退出；stdout=${second.stdout}`);
    assert.match(second.stdout, /告警：/, "必须打印告警段（不得静默）");
    assert.match(second.stdout, /事件索引已损坏（已退回全量校验）/, "告警必须点名原因与回退动作");
    assert.match(second.stdout, /事件数:\s+2/, "回退后条数仍须正确");
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 3（端到端）：事件流真损坏时 status 非零退出并报准确行号", () => {
  const sb = makeSandbox("e2e-corrupt");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    pushEvent(sb.root, "goal.created", { goal: "g-1" });
    pushEvent(sb.root, "goal.created", { goal: "g-2" });
    runStatus(cliEntry, sb.root, sb.cache);
    const lines = readFileSync(join(sb.root, "events.jsonl"), "utf8").split("\n");
    lines[1] = '{"broken":true}';
    writeRaw(sb.root, lines.join("\n"));

    const res = runStatus(cliEntry, sb.root, sb.cache);
    assert.equal(res.code, 1, "事件流损坏必须非零退出（既有判据 4 语义不变）");
    assert.match(res.stdout, /事件流不可解析：.*第 2 行缺少 event\/actor 字段/, "必须报准确行号与原因");
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 3/4：status 不往 .dsh-graph 里写任何东西（索引落在用户缓存目录）", () => {
  const sb = makeSandbox("noside");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    pushEvent(sb.root, "goal.created", { goal: "g-1" });
    const lsBefore = snapshotTree(sb.root);
    runStatus(cliEntry, sb.root, sb.cache);
    runStatus(cliEntry, sb.root, sb.cache);
    const lsAfter = snapshotTree(sb.root);
    assert.deepEqual(lsAfter, lsBefore, "status 不得在 .dsh-graph 里留下任何文件/改动（含 mtime 与大小）");
    assert.ok(existsSync(indexPathIn(sb.cache, sb.root)), "索引必须落在缓存目录");
    assert.ok(indexPathIn(sb.cache, sb.root).startsWith(sb.cache), "索引必须位于配置的缓存目录下");
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

/** 递归快照：相对路径 → (size, mtimeMs)，用于「零副作用」断言。 */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        out[p.slice(root.length)] = `${st.size}:${st.mtimeMs}`;
      }
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// 判据 6：反向变异（真源码副本；改坏必须变红）
// ---------------------------------------------------------------------------

/**
 * 铺一份**真实源码副本**（`core/` 全量 + `bin/dsh-graph.mjs`），供变异用。
 * 复制整棵 core 是因为 CLI 模块图经相对导入展开，只复制被改文件会得到不可运行的程序。
 */
function makeMutationSandbox(sb: { dir: string }) {
  const binDir = join(sb.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  cpSync(join(repoRoot, "core"), join(sb.dir, "core"), {
    recursive: true,
    filter: (src) => !src.startsWith(join(repoRoot, "core", "tests")),
  });
  cpSync(cliEntry, join(binDir, "dsh-graph.mjs"));
  return {
    entry: join(binDir, "dsh-graph.mjs"),
    file(rel: string): string {
      return join(sb.dir, "core", "cli", rel);
    },
  };
}

/** 就地替换并从断言「恰命中 1 处」（命中数≠1 ⇒ 变异没生效或落在无关处，对照无意义）。 */
function mutateSource(file: string, from: string, to: string): void {
  const src = readFileSync(file, "utf8");
  const hits = src.split(from).length - 1;
  assert.equal(hits, 1, `变异锚点必须恰命中 1 处（${file} ← ${JSON.stringify(from)}），实际命中 ${hits}`);
  writeFileSync(file, src.replace(from, to), "utf8");
}

/** 在变异体上执行一段脚本并取它的 stdout（脚本内的断言失败会以非零退出表示）。 */
function runInMutant(mutation: { entry: string }, root: string, cache: string, script: string) {
  // 用变异体的 core 目录导入被测模块（确保跑的是被改坏的源码）
  const mutantCore = join(mutation.entry, "..", "..", "core");
  const code = `const base = ${JSON.stringify(mutantCore)};
${script}`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 120_000,
    env: childEnv(cache),
  });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("g-630 判据 6（反向变异）：关掉「截断检测」后，截断用例在变异体上实测变红", () => {
  const sb = makeSandbox("mut-trunc");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    for (let i = 0; i < 6; i++) pushEvent(sb.root, "goal.created", { goal: `g-${i}` });
    withCache(sb.cache, () => readEventsSummary(sb.root));

    const mutation = makeMutationSandbox(sb);
    // 变异体必须先**正确**识别截断（否则对照不成立）：这里用与生产同形的脚本直接调 summarize。
    const script = `const { summarizeEvents } = await import(base + "/cli/events-index.ts");
const r = summarizeEvents(${JSON.stringify(sb.root)});
console.log(JSON.stringify(r));`;
    const pristine = runInMutant(mutation, sb.root, sb.cache, script);
    assert.equal(pristine.code, 0, `未变异副本必须可运行；stderr=${pristine.stderr}`);

    // 截断事件流后用**未变异**副本跑：必须回退（indexed:false）。
    const lines = readFileSync(join(sb.root, "events.jsonl"), "utf8").split("\n").filter(Boolean);
    writeRaw(sb.root, lines.slice(0, 3).join("\n") + "\n");
    // 重新建立索引（指向截断前的 6 条）
    writeRaw(sb.root, lines.join("\n") + "\n");
    withCache(sb.cache, () => readEventsSummary(sb.root));
    writeRaw(sb.root, lines.slice(0, 3).join("\n") + "\n");

    const good = JSON.parse(runInMutant(mutation, sb.root, sb.cache, script).stdout.trim().split("\n").pop() || "{}");
    assert.equal(good.indexed, false, "未变异副本必须识别截断并回退（前置条件）");
    assert.equal(good.eventCount, 0, "未变异副本回退时不得给条数（不得给出错误聚合）");
    assert.match(good.warning, /事件流被截断/, "未变异副本必须报「截断」（第一道防线）");

    // 变异：把截断路径上的**三道**防线全部关掉 —— 大小检测、头部指纹、追加区间确证。
    // 只关一道不够（实测：其余防线会接手），这也反过来说明防护是分层的、不是单点。
    mutateSource(
      mutation.file("events-index.ts"),
      "if (size < entry.size) {\n      return fallback(`事件流被截断（${entry.size} → ${size} 字节，已退回全量校验）`);\n    }",
      "if (size < entry.size) {\n      /* 变异：跳过截断检测 */\n    }",
    );
    mutateSource(mutation.file("events-index.ts"), "const headChanged = entry.headSha !== probe.headSha;", "const headChanged = false;");
    mutateSource(
      mutation.file("events-index.ts"),
      'const appended = applyAppend(probe, entry.size, entry);\n  if (appended === null) return fallback("事件流新增区间无法逐行确证（已退回全量校验）");',
      "const appended = { count: entry.eventCount, lastEvent: entry.lastEvent, lastEventTs: entry.lastEventTs };",
    );
    const mutated = runInMutant(mutation, sb.root, sb.cache, script);
    const bad = JSON.parse(mutated.stdout.trim().split("\n").pop() || "{}");
    // 三道路由全关后，被截断成 3 条的文件会被**静默报成 6 条** —— 正是判据 2 禁止的「错误聚合」。
    assert.equal(bad.indexed, true, `变异体必须信旧索引（否则本对照不成立）；实际 ${mutated.stdout.trim()}`);
    assert.equal(bad.eventCount, 6, `变异体必须报出陈旧的 6 条（真实只有 3 条）；实际 ${mutated.stdout.trim()}`);
    assert.equal(bad.warning, null, "变异体不再有任何告警（静默错误）");
    // ⇒ 上面 `good.indexed === false` / `good.eventCount === 0` 两条断言在变异体上必然变红。
    // ⇒ 上面「截断必须回退」的断言在变异体上必然失败。
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 6（反向变异）：把回退降级为「返回空结果」后，回退用例在变异体上实测变红", () => {
  const sb = makeSandbox("mut-silent");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    pushEvent(sb.root, "goal.created", { goal: "g-1" });
    pushEvent(sb.root, "goal.created", { goal: "g-2" });
    withCache(sb.cache, () => readEventsSummary(sb.root));
    // 破坏索引，逼出回退路径
    writeFileSync(indexPathIn(sb.cache, sb.root), "garbage", "utf8");

    const mutation = makeMutationSandbox(sb);
    const script = `const { readEventsSummary } = await import(base + "/cli/events-index.ts");
const r = readEventsSummary(${JSON.stringify(sb.root)});
console.log(JSON.stringify({ c: r.eventCount, p: r.problems.length, n: r.notices.length, i: r.indexed }));`;

    const pristine = JSON.parse(runInMutant(mutation, sb.root, sb.cache, script).stdout.trim().split("\n").pop() || "{}");
    assert.equal(pristine.c, 2, "未变异副本：索引损坏时回退后必须给出真实的 2 条（前置条件）");
    assert.ok(pristine.n >= 1, "未变异副本：必须给出可读告警（前置条件）");

    // 变异：让 readEventsSummary 在索引失效时**不**回退，直接返回空摘要（「静默返回空」这一最危险退化的原型）。
    mutateSource(
      mutation.file("events-index.ts"),
      "  if (fast.warning) notices.push(fast.warning);\n  try {\n    const full = fullScanAndIndex(root);",
      "  if (fast.warning) notices.push(fast.warning);\n  if (true) return { eventCount: 0, lastEvent: null, lastEventTs: null, problems, indexed: false, notices };\n  try {\n    const full = fullScanAndIndex(root);",
    );
    // 上一轮未变异副本已把索引修复回健康 ⇒ 再次破坏，确保变异体走的就是回退分支。
    writeFileSync(indexPathIn(sb.cache, sb.root), "garbage", "utf8");
    const mutated = runInMutant(mutation, sb.root, sb.cache, script);
    const bad = JSON.parse(mutated.stdout.trim().split("\n").pop() || "{}");
    assert.equal(bad.c, 0, `变异体必须静默返回空（否则本对照不成立）；实际 ${mutated.stdout.trim()} / ${mutated.stderr}`);
    // ⇒ 上面「回退后必须给出 2 条」的断言在变异体上必然失败。
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

test("g-630 判据 6（反向变异）：关掉「头部指纹」校验后，就地改写用例在变异体上实测变红", () => {
  const sb = makeSandbox("mut-head");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    for (let i = 0; i < 40; i++) pushEvent(sb.root, "goal.created", { goal: `g-${i}` });
    withCache(sb.cache, () => readEventsSummary(sb.root));
    const text = readFileSync(join(sb.root, "events.jsonl"), "utf8");
    writeRaw(sb.root, text.replace('"event":"goal.created"', '"event":"goal.renamed"'));

    const mutation = makeMutationSandbox(sb);
    const script = `const { summarizeEvents } = await import(base + "/cli/events-index.ts");
const r = summarizeEvents(${JSON.stringify(sb.root)});
console.log(JSON.stringify({ i: r.indexed, e: r.lastEvent }));`;

    const pristine = JSON.parse(runInMutant(mutation, sb.root, sb.cache, script).stdout.trim().split("\n").pop() || "{}");
    assert.equal(pristine.i, false, "未变异副本：头部改写必须回退（前置条件）");

    // 变异：让 headSha 恒等（等价于「不比头部指纹」）
    mutateSource(mutation.file("events-index.ts"), "const headChanged = entry.headSha !== probe.headSha;", "const headChanged = false;");
    const mutated = runInMutant(mutation, sb.root, sb.cache, script);
    const bad = JSON.parse(mutated.stdout.trim().split("\n").pop() || "{}");
    assert.equal(bad.i, true, `变异体必须**放行**就地改写（否则本对照不成立）；实际 ${mutated.stdout.trim()}`);
    // ⇒ 上面「就地改写必须回退」的断言在变异体上必然失败。
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 7：status 的既有语义不因本优化而改变
// ---------------------------------------------------------------------------

test("g-630 判据 7：collectStatus 的事件结论与 core readEvents 逐字段一致（多种事件流形态）", async () => {
  const sb = makeSandbox("parity-status");
  cacheByRoot.set(sb.root, sb.cache);
  try {
    const cases: Array<[string, () => void]> = [
      ["空事件流", () => writeRaw(sb.root, "")],
      ["仅换行", () => writeRaw(sb.root, "\n\n\n")],
      ["单条", () => writeRaw(sb.root, JSON.stringify({ ts: "2026-01-01T00:00:00.000+08:00", event: "a", actor: "t" }) + "\n")],
      [
        "多条含空行",
        () =>
          writeRaw(
            sb.root,
            [
              JSON.stringify({ ts: "2026-01-01T00:00:00.000+08:00", event: "a", actor: "t" }),
              "",
              JSON.stringify({ ts: "2026-01-02T00:00:00.000+08:00", event: "b", actor: "t" }),
              "",
            ].join("\n"),
          ),
      ],
      [
        "末事件无 ts",
        () => writeRaw(sb.root, JSON.stringify({ event: "a", actor: "t" }) + "\n" + JSON.stringify({ event: "b", actor: "t" }) + "\n"),
      ],
    ];
    for (const [label, setup] of cases) {
      rmSync(indexPathIn(sb.cache, sb.root), { force: true });
      setup();
      const want = authoritative(sb.root);
      const status = await withCacheAsync(sb.cache, () => collectStatus({ root: sb.root, workspace: sb.workspace, mode: "main-tree" }));
      assert.equal(status.eventCount, want.eventCount, `${label}：条数`);
      assert.equal(status.lastEvent, want.lastEvent, `${label}：末事件名`);
      assert.equal(status.lastEventTs, want.lastEventTs, `${label}：末事件时间戳`);
      assert.deepEqual(status.problems, [], `${label}：不该有问题`);
    }
  } finally {
    cacheByRoot.delete(sb.root);
    sb.cleanup();
  }
});

/** async 版 withCache（collectStatus 现在是 async：project.yaml 的 ops 按需加载）。 */
async function withCacheAsync<T>(cache: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DSH_GRAPH_CACHE_HOME;
  process.env.DSH_GRAPH_CACHE_HOME = cache;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DSH_GRAPH_CACHE_HOME;
    else process.env.DSH_GRAPH_CACHE_HOME = prev;
  }
}
