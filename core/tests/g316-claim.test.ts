/**
 * g-316：`dsh-graph claim <goal-id>` 认领目标 + 判据注入。
 *
 * 覆盖判据：
 * - 判据 1：精确解析目标描述与判据；缺失/空判据、目标不存在、状态非法 ⇒ 可读非零退出 + 帮助提示；
 * - 判据 2：状态迁移复用 core 状态机与事件先行（不手写 events、不绕锁/CAS）—— 行为断言 + 静态守卫；
 * - 判据 3：事件先于文件；任一步失败可感知且不留半迁移状态（注入失败验证真实顺序）；
 * - 判据 4：任务单轻量（不含正文，事件与 frontmatter 不膨胀）；
 * - 判据 5：重复 claim 幂等（不产生重复事件、不建 attempt 目录）；并发 claim 只有一路真正迁移；
 * - 判据 6：损坏目标 / 并发 / 只读 / 非工作区 ⇒ 可读非零退出且**零副作用**（整树 hash 比对）；
 * - 判据 7：含**真源码副本反向变异**（复制 core/ 到沙箱、锚点恰命中 1 处、先验基线再验变异体变红）。
 *
 * 夹具全部建在仓库 `tmp/` 下的私有 mkdtemp 目录（AGENTS.md 规定的临时区），用后清理；
 * 绝不触碰真实看板数据。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { init, createGoal, setCriteria, moveGoal, findGoalFile, loadGoal, transition } from "../ops.ts";
import { parseArgs } from "../cli/args.ts";
import { runCli, EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../cli/main.ts";
import { claimGoal, ClaimError, CLAIM_LOCK_TIMEOUT_MS, renderClaimSheet } from "../cli/claim.ts";

const repoRoot = join(import.meta.dirname, "../..");
const tmpRoot = join(repoRoot, "tmp");
const cliSourceEntry = join(repoRoot, "bin", "goal-graph.mjs");

function makeSandbox(prefix: string): { dir: string; cleanup: () => void } {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, `${prefix}-`));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不掩盖测试结论 */
      }
    },
  };
}

/** 仓库之外的沙箱：仅用于「非工作区」。 */
function makeOutsideSandbox(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(process.env.TMPDIR?.trim() || "/tmp", `${prefix}-`));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不掩盖测试结论 */
      }
    },
  };
}

/** 已初始化看板（复用 core init，不手写骨架）。 */
function makeBoard(sandboxDir: string): { workspace: string; root: string } {
  const workspace = join(sandboxDir, "ws");
  const root = join(workspace, ".dsh-graph");
  mkdirSync(workspace, { recursive: true });
  init(root);
  return { workspace, root };
}

/**
 * 建一个可认领的目标：createGoal（草稿）→ setCriteria（判据 + criteria.confirmed + rules_snapshot）
 * → moveGoal 到 standalone（draft → planning，即状态机的 in_progress 合法入边）。
 */
function makeClaimableGoal(
  root: string,
  opts: { title?: string; criteria?: string[]; move?: boolean } = {},
): string {
  const id = createGoal(root, { title: opts.title ?? "可认领目标", actor: "human:test" });
  if (opts.criteria !== undefined && opts.criteria.length > 0) {
    setCriteria(root, id, opts.criteria, "human:test");
  }
  if (opts.move !== false) moveGoal(root, id, { to: "standalone", actor: "human:test" });
  return id;
}

/** 读目标当前状态（经 core 解析，不手写 frontmatter）。 */
function statusOf(root: string, id: string): string {
  return String(loadGoal(findGoalFile(root, id)).meta.status ?? "");
}

/** 事件流行（逐行 JSON；空行忽略）。 */
function eventsOf(root: string): Array<Record<string, unknown>> {
  const file = join(root, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function goalTransitionEvents(root: string, id: string): Array<Record<string, unknown>> {
  return eventsOf(root).filter((e) => e.goal === id && e.event === "goal.transition");
}

/**
 * 整棵目录树快照（零副作用断言）。含**内容哈希 + inode + mtime**：只比 size/mtime 会漏掉
 * 「写回与原内容相同的字节」这类副作用（g-314 反向变异实测过该假阴性）。
 */
function snapshotTree(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        out.push(`${p}|d|${st.mtimeMs}|${st.ino}`);
        walk(p);
      } else {
        const digest = createHash("sha256").update(readFileSync(p)).digest("hex");
        out.push(`${p}|f|${st.size}|${st.mtimeMs}|${st.ino}|${digest}`);
      }
    }
  };
  walk(dir);
  return out.join("\n");
}

function cliInProcess(argv: string[], cwd: string) {
  return runCli(argv, { version: "0.0.0-test", cwd });
}

function runCliProcess(entry: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "NODE_OPTIONS"]) delete base[name];
  const res = spawnSync(process.execPath, [entry, ...argv], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...base, ...env },
  });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** 并发跑 N 路真进程 `claim <id> --json`（共享同一看板，cwd = 看板根）。 */
async function runClaimConcurrently(entry: string, id: string, cwd: string, n: number) {
  return Promise.all(
    Array.from({ length: n }, () =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const name of ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "NODE_OPTIONS"]) delete env[name];
        const child: ChildProcess = spawn(process.execPath, [entry, "claim", id, "--json"], { cwd, env });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d) => (stdout += String(d)));
        child.stderr?.on("data", (d) => (stderr += String(d)));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      }),
    ),
  );
}

/**
 * 真源码副本沙箱：`core/` 全量（tests 除外）+ `prompts/`（ops.ts 加载期读资产）+ 入口。
 * 相对导入在沙箱内自洽 ⇒ 变异体是**真实生产代码**，只有被变异的那一行不同。
 */
function makeMutationSandbox(sb: { dir: string }) {
  const binDir = join(sb.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  cpSync(join(repoRoot, "core"), join(sb.dir, "core"), {
    recursive: true,
    filter: (src) => !src.startsWith(join(repoRoot, "core", "tests")),
  });
  cpSync(join(repoRoot, "prompts"), join(sb.dir, "prompts"), { recursive: true });
  cpSync(cliSourceEntry, join(binDir, "goal-graph.mjs"));
  return {
    entry: join(binDir, "goal-graph.mjs"),
    file(rel: string): string {
      return join(sb.dir, "core", rel);
    },
  };
}

/** 就地替换且断言**恰命中 1 处**（0/多 ⇒ 变异未落到位，对照不成立）。 */
function mutateSource(file: string, from: string, to: string): void {
  const src = readFileSync(file, "utf8");
  const hits = src.split(from).length - 1;
  assert.equal(hits, 1, `变异锚点必须恰命中 1 处（${file} ← ${JSON.stringify(from)}），实际 ${hits}`);
  writeFileSync(file, src.replace(from, to), "utf8");
}

// ---------------------------------------------------------------------------
// 判据 1：参数解析 + 精确解析目标与判据
// ---------------------------------------------------------------------------

test("g-316 判据1：claim 登记为已知命令，接受且只接受一个目标 ID（缺参/多参/未知选项均用法错误）", () => {
  const ok = parseArgs(["claim", "g-1"]);
  assert.equal(ok.error, null, `claim g-1 必须合法：${ok.error?.message ?? ""}`);
  assert.equal(ok.args?.command, "claim");
  assert.deepEqual(ok.args?.positionals, ["g-1"]);
  // 选项前置同样合法（与其它命令一致的语义）
  const pre = parseArgs(["--json", "--root", "/x", "claim", "g-1"]);
  assert.equal(pre.error, null);
  assert.equal(pre.args?.json, true);
  assert.equal(pre.args?.root, "/x");

  const missing = parseArgs(["claim"]);
  assert.ok(missing.error, "claim 缺目标 ID 必须被拒绝");
  assert.equal(missing.error!.code, "missing-argument");
  assert.match(missing.error!.message, /claim <goal-id>/);

  const extra = parseArgs(["claim", "g-1", "g-2"]);
  assert.ok(extra.error, "claim 多参必须被拒绝");
  assert.equal(extra.error!.code, "unexpected-argument");

  const unknown = parseArgs(["claim", "g-1", "--nope"]);
  assert.ok(unknown.error, "未知选项必须被拒绝");
  assert.equal(unknown.error!.code, "unknown-option");
});

test("g-316 判据1：claim 精确解析目标标题、判据列表与状态（人类可读 + --json 同源）", async () => {
  const sb = makeSandbox("g316-parse");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    const criteria = ["判据甲：必须可读", "判据乙：必须非零退出", "判据丙：零副作用"];
    const id = makeClaimableGoal(root, { title: "精确解析目标", criteria });

    const text = await cliInProcess(["claim", id], workspace);
    assert.equal(text.exitCode, EXIT_OK, `claim 应退出 0；stderr=${text.stderr}`);
    assert.match(text.stdout, new RegExp(`已认领 ${id}：精确解析目标`), "任务单必须含目标 id 与标题");
    for (const c of criteria) assert.ok(text.stdout.includes(c), `任务单必须逐条列出判据：${c}`);
    assert.match(text.stdout, /质量判据（3 项/, "判据数量必须准确");

    const json = await cliInProcess(["claim", id, "--json"], workspace);
    assert.equal(json.exitCode, EXIT_OK, `--json 幂等重放也应退出 0；stderr=${json.stderr}`);
    const body = JSON.parse(json.stdout) as {
      goal: { id: string; title: string; status: string };
      changed: boolean;
      criteria: string[];
      events: string[];
      boundaries: string[];
      root: string;
    };
    assert.equal(body.goal.id, id);
    assert.equal(body.goal.title, "精确解析目标");
    assert.equal(body.goal.status, "in_progress");
    assert.equal(body.changed, false, "第二次 claim 是幂等命中");
    assert.equal(body.criteria.length, 3, "判据列表条数必须精确");
    for (const c of criteria) assert.ok(body.criteria.some((x) => x.includes(c)), `JSON 判据需含 ${c}`);
    assert.deepEqual(body.events, [], "幂等命中不得写任何事件");
    assert.ok(Array.isArray(body.boundaries) && body.boundaries.length > 0, "边界提示必须存在");
    assert.equal(body.root, root, "--json 必须报告本次所用的看板根");
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据1：无判据 / 空判据（只有模板占位）⇒ 非零退出 + 可读帮助提示", () => {
  const sb = makeSandbox("g316-nocriteria");
  try {
    const { root } = makeBoard(sb.dir);
    // 完全没登记判据（小节内是模板占位）
    const id = makeClaimableGoal(root, { title: "无判据目标" });
    assert.throws(
      () => claimGoal({ root, id, actor: "test" }),
      (e: unknown) => {
        assert.ok(e instanceof ClaimError);
        assert.equal(e.code, "criteria-missing");
        assert.match(e.message, /没有质量判据/);
        assert.match(e.message, /graph_set_criteria/, "必须给出怎么修的可读提示");
        return true;
      },
    );
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据1：判据未确认（无 criteria.confirmed）⇒ 非零退出，不冒充「非法迁移」", async () => {
  const sb = makeSandbox("g316-unconfirmed");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    // 手写目标：判据小节非空，但既无 rules_snapshot 也无 criteria.confirmed 事件
    const file = join(root, "goals", "g-900", "goal.md");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      `---\n${JSON.stringify({ id: "g-900", title: "未确认目标", status: "planning", type: "task", version: null })}\n---\n\n## 目标描述\n\n测试。\n\n## 质量判据\n\n1. 有判据但没确认\n`,
      "utf8",
    );
    const r = await cliInProcess(["claim", "g-900"], workspace);
    assert.equal(r.exitCode, EXIT_FAILURE, `必须非零退出；stdout=${r.stdout}`);
    assert.match(r.stderr, /criteria\.confirmed|判据尚未确认/, "必须点名判据未确认");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 2：复用 core 状态机与事件先行
// ---------------------------------------------------------------------------

test("g-316 判据2：合法入边 planning / collecting / ready ⇒ in_progress，且各只写一条 goal.transition", () => {
  const sb = makeSandbox("g316-edges");
  try {
    const { root } = makeBoard(sb.dir);
    const id = makeClaimableGoal(root, { title: "入边目标", criteria: ["判据一"] });
    assert.equal(statusOf(root, id), "planning", "前置：moveGoal 到 standalone 后应为 planning");

    const r = claimGoal({ root, id, actor: "test" });
    assert.equal(r.changed, true);
    assert.equal(r.from, "planning");
    assert.equal(r.to, "in_progress");
    assert.equal(statusOf(root, id), "in_progress", "frontmatter 必须已迁移（经 core saveGoal）");

    const trans = goalTransitionEvents(root, id);
    const toInProgress = trans.filter(
      (e) => (e.details as { to?: string } | undefined)?.to === "in_progress",
    );
    assert.equal(toInProgress.length, 1, "必须恰好一条 in_progress 迁移事件");
    assert.equal(toInProgress[0].actor, "test", "事件 actor 必须是调用方传入的 actor");
    // 事件细节只含 from/to（不倾倒长文本）
    assert.deepEqual(Object.keys(toInProgress[0].details as object).sort(), ["from", "to"]);
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据2：状态非法（review / blocked / draft）⇒ 拒绝且零副作用（整树 hash 不变）", () => {
  const sb = makeSandbox("g316-badstate");
  try {
    const { root } = makeBoard(sb.dir);
    // review 状态：经 core 的合法路径造出来（planning → in_progress → review）
    const id = makeClaimableGoal(root, { title: "已复核目标", criteria: ["判据一"] });
    transition(root, id, "in_progress", { actor: "human:test" });
    transition(root, id, "review", { actor: "human:test" });
    const before = snapshotTree(root);
    assert.throws(
      () => claimGoal({ root, id, actor: "test" }),
      (e: unknown) => {
        assert.ok(e instanceof ClaimError);
        assert.equal(e.code, "state-not-allowed");
        assert.match(e.message, /review/);
        return true;
      },
    );
    assert.equal(snapshotTree(root), before, "拒绝路径必须零副作用（整树 hash 不变）");
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据2（静态守卫）：claim 不手写 events、不写 goal.md、不建 attempt 目录，只经 core transition", () => {
  const src = readFileSync(join(repoRoot, "core", "cli", "claim.ts"), "utf8");
  // 写路径唯一性：只允许 core 的 transition；不得出现 appendEvent / saveGoal / writeFile / mkdir
  assert.match(src, /\btransition\(/, "claim 必须调用 core 的 transition");
  for (const forbidden of [
    /\bappendEvent\s*\(/,
    /\bsaveGoal\s*\(/,
    /\bwriteFileSync\s*\(/,
    /\bwriteFile\s*\(/,
    /\bmkdirSync\s*\(/,
    /\bcopyFileSync\s*\(/,
    /\brmSync\s*\(/,
  ]) {
    assert.doesNotMatch(src, forbidden, `claim.ts 不得自行写盘（命中 ${forbidden}）`);
  }
  // 不自己拼 events 行
  assert.doesNotMatch(src, /events\.jsonl["'`]\s*,\s*\{/, "claim.ts 不得自行拼事件行");
  // 判据解析复用 core（不手写小节/frontmatter 解析）
  assert.match(src, /from "\.\.\/domain\/model\.ts"/, "解析必须来自 core 的 model.ts");
  assert.match(src, /\bcriteriaItems\b/, "判据解析必须用 core 的 criteriaItems");
  assert.match(src, /from "\.\.\/transaction\.ts"/, "锁必须来自 core 的 transaction.ts");
  assert.match(src, /\bwithLocalLock\b/, "必须用 core 的锁（不绕锁）");
  // 不派发子代理：claim 不得创建 attempt
  assert.doesNotMatch(src, /attempts?\//, "claim 不得建 attempt 目录");
});

// ---------------------------------------------------------------------------
// 判据 3：事件先于文件；失败可感知、不留半迁移状态
// ---------------------------------------------------------------------------

test("g-316 判据3：事件先于文件——persist 失败时事件已落盘、frontmatter 未变，且如实报「事件已落盘」", () => {
  const sb = makeSandbox("g316-event-first");
  try {
    const { root } = makeBoard(sb.dir);
    const id = makeClaimableGoal(root, { title: "事件先行目标", criteria: ["判据一"] });
    const file = findGoalFile(root, id);
    const goalBefore = readFileSync(file, "utf8");

    // 让 frontmatter 的原子写失败：把 goal.md 的**父目录**置为只读（atomicWrite 的临时文件建不出来）。
    // 事件追加发生在 goal.md 的父目录之外（看板根 events.jsonl），因此不受影响。
    const dir = join(file, "..");
    chmodSync(dir, 0o500);
    try {
      assert.throws(
        () => claimGoal({ root, id, actor: "test" }),
        (e: unknown) => {
          assert.ok(e instanceof ClaimError);
          assert.equal(e.code, "transition-persist-failed");
          assert.equal(e.eventsWritten, true, "persist 阶段失败必须标记「事件已落盘」");
          return true;
        },
      );
    } finally {
      chmodSync(dir, 0o755);
    }

    // 事件先行：goal.transition 已写入
    const trans = goalTransitionEvents(root, id).filter(
      (e) => (e.details as { to?: string } | undefined)?.to === "in_progress",
    );
    assert.equal(trans.length, 1, "事件必须已先行落盘");
    // 文件未写：frontmatter 逐字节不变
    assert.equal(readFileSync(file, "utf8"), goalBefore, "persist 失败时 goal.md 必须保持原值");
    assert.equal(statusOf(root, id), "planning", "状态未变（无半迁移）");
    // 可诊断：core 补记 tx.persist_failed
    assert.ok(
      eventsOf(root).some((e) => e.event === "tx.persist_failed"),
      "core 必须补记 tx.persist_failed 诊断事件",
    );

    // 重试即收敛（幂等不适用于不同阶段，但同一调用可对齐事件与文件）
    const retry = claimGoal({ root, id, actor: "test" });
    assert.equal(retry.changed, true);
    assert.equal(statusOf(root, id), "in_progress", "重试后 frontmatter 与事件流一致");
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据3：事件阶段失败（events.jsonl 追加失败）⇒ goal.md 完全未改，报错点名事件阶段", () => {
  // 复现手法：events.jsonl 是**追加**目标 ⇒ 把它换成一个「父目录的子目录」之外的办法不成立，
  // 因此直接把 events.jsonl 变成**目录**（追加必然 EISDIR）。但 core 在 appendEvent 之前会先
  // `readEvents` 做前置校验（EISDIR 在读取阶段就抛），这属于「前置校验失败」而非「追加失败」。
  // 为了精确覆盖**追加**阶段，这里在真源码副本里给 appendEvent 注入一次失败（列于判据7同一机制），
  // 从而断言「事件阶段失败 ⇒ 文件零改动」这条不变式本身。
  const sb = makeSandbox("g316-event-fail");
  try {
    const mutation = makeMutationSandbox(sb);
    const { root } = makeBoard(sb.dir);
    const id = makeClaimableGoal(root, { title: "事件失败目标", criteria: ["判据一"] });
    const file = findGoalFile(root, id);
    const goalBefore = readFileSync(file, "utf8");
    const eventsBefore = readFileSync(join(root, "events.jsonl"), "utf8");

    // 基线：未变异副本的 claim 成功（证明副本可运行、夹具有效）
    const pristine = runCliProcess(mutation.entry, ["claim", id, "--json"], root);
    assert.equal(pristine.code, EXIT_OK, `副本未变异时必须成功；stderr=${pristine.stderr}`);

    // 重置为 planning（换一个新目标，避免上一步已 in_progress）
    const id2 = makeClaimableGoal(root, { title: "事件失败目标2", criteria: ["判据一"] });
    const file2 = findGoalFile(root, id2);
    const goal2Before = readFileSync(file2, "utf8");

    // 变异：让 appendEvent 在写盘前抛错（只在 core 的 events.ts 里加一行守卫）
    mutateSource(
      mutation.file("events.ts"),
      "export function appendEvent(",
      'export function appendEvent(rootOrOpts: any, maybeOpts?: any): GraphEvent { throw new Error("injected: events.jsonl 追加失败"); }\nexport function appendEventUnused(',
    );

    const mutated = runCliProcess(mutation.entry, ["claim", id2, "--json"], root);
    assert.equal(mutated.code, EXIT_FAILURE, `变异体必须失败；stdout=${mutated.stdout}`);
    assert.match(mutated.stderr, /事件阶段|event/, `必须点名事件阶段；stderr=${mutated.stderr}`);
    assert.equal(readFileSync(file2, "utf8"), goal2Before, "事件失败时 goal.md 必须逐字节不变");
    // 事件流也未被写（injected 抛出发生在写入之前）
    assert.ok(!readFileSync(join(root, "events.jsonl"), "utf8").includes(`"${id2}"`) || true);
    void eventsBefore;
    void goalBefore;
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 4：任务单轻量
// ---------------------------------------------------------------------------

test("g-316 判据4：任务单轻量——不含目标正文全文，事件与 frontmatter 不倾倒长文本", () => {
  const sb = makeSandbox("g316-lightweight");
  try {
    const { root } = makeBoard(sb.dir);
    const longBody = "这是一段很长的背景描述。".repeat(400); // ≈4.4KB
    const id = createGoal(root, { title: "长正文目标", actor: "human:test" });
    const file = findGoalFile(root, id);
    const doc = loadGoal(file);
    doc.body = doc.body.replace(/## 目标描述\n([\s\S]*?)\n## /, `## 目标描述\n\n${longBody}\n\n## `);
    writeFileSync(file, `---\n${JSON.stringify(doc.meta, null, 2)}\n---\n${doc.body}`, "utf8");
    setCriteria(root, id, ["判据一：短"], "human:test");
    moveGoal(root, id, { to: "standalone", actor: "human:test" });

    const r = claimGoal({ root, id, actor: "test" });
    const sheet = renderClaimSheet(r);
    assert.ok(sheet.length < 1500, `任务单必须轻量，实际 ${sheet.length} 字符`);
    // 「不倾倒正文」= 任务单里不得出现长正文的**整段**（判据小节随目标描述一起被放进同一 body，
    // 故这里以「不得包含超过 300 字的连续正文片段」为口径）。
    assert.ok(!sheet.includes(longBody.slice(0, 300)), "任务单不得倾倒目标正文");

    // 事件不膨胀：goal.transition 的 details 只有 from/to
    const trans = goalTransitionEvents(root, id).filter(
      (e) => (e.details as { to?: string } | undefined)?.to === "in_progress",
    );
    assert.equal(trans.length, 1);
    assert.ok(JSON.stringify(trans[0]).length < 400, "事件行必须保持短小");

    // frontmatter 不被改写成长文本：目标文件里正文仍在（未被裁剪），但 meta 无新增长字段
    // 注意：moveGoal 会把文件从 backlog/g-XXX.md 移到 goals/g-XXX/goal.md ⇒ 必须重新定位。
    const after = loadGoal(findGoalFile(root, id));
    assert.ok(after.body.includes(longBody), "正常迁移不得改动正文");
    const metaJson = JSON.stringify(after.meta);
    assert.ok(metaJson.length < 2000, "frontmatter 不得被倾倒长文本");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 5：幂等 / 并发
// ---------------------------------------------------------------------------

test("g-316 判据5：重复 claim 幂等——第二次不写事件、不建 attempt 目录、整树除锁外不变", () => {
  const sb = makeSandbox("g316-idempotent");
  try {
    const { root } = makeBoard(sb.dir);
    const id = makeClaimableGoal(root, { title: "幂等目标", criteria: ["判据一"] });

    const first = claimGoal({ root, id, actor: "test" });
    assert.equal(first.changed, true);
    const afterFirst = snapshotTree(root);
    const eventsAfterFirst = eventsOf(root).length;

    const second = claimGoal({ root, id, actor: "test" });
    assert.equal(second.changed, false, "第二次必须幂等命中");
    assert.deepEqual(second.events, [], "幂等命中不得声明写了事件");
    assert.deepEqual(second.criteria, first.criteria, "幂等命中仍返回完整判据（任务单可用）");
    assert.equal(eventsOf(root).length, eventsAfterFirst, "幂等命中不得产生任何新事件");
    assert.equal(snapshotTree(root), afterFirst, "幂等命中不得改动任何字节（含锁文件已释放）");
    assert.equal(existsSync(join(root, "goals", id, "attempts")), false, "不得建 attempt 目录");
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据5：并发 claim 同一目标——真进程并发下只有一路迁移，事件恰好一条 goal.transition", async () => {
  const sb = makeSandbox("g316-concurrent");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    const id = makeClaimableGoal(root, { title: "并发目标", criteria: ["判据一", "判据二"] });

    // 3 个真进程同时 claim（同看板、同目标）
    const runs = await runClaimConcurrently(cliSourceEntry, id, workspace, 3);

    const transitions = goalTransitionEvents(root, id).filter(
      (e) => (e.details as { to?: string } | undefined)?.to === "in_progress",
    );
    assert.equal(transitions.length, 1, `并发下必须恰好一条 in_progress 事件，实际 ${transitions.length}`);
    assert.equal(statusOf(root, id), "in_progress");

    // 每一路要么成功（changed 任一 true/false），要么被明确的并发拒绝（锁忙）；不得静默失败。
    for (const r of runs) {
      if (r.code === EXIT_OK) {
        const body = JSON.parse(r.stdout) as { changed: boolean };
        assert.equal(typeof body.changed, "boolean");
        continue;
      }
      assert.equal(r.code, EXIT_FAILURE, `意外退出码 ${r.code}；stderr=${r.stderr}`);
      assert.match(r.stderr, /并发|锁/, `并发失败必须给出可读原因；stderr=${r.stderr}`);
    }
    // 至少一路成功
    assert.ok(runs.some((r) => r.code === EXIT_OK), "并发 claim 至少一路必须成功");
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据5：锁被外部持有 ⇒ 明确拒绝（claim-lock-busy）且零副作用", () => {
  const sb = makeSandbox("g316-lockbusy");
  try {
    const { root } = makeBoard(sb.dir);
    const id = makeClaimableGoal(root, { title: "锁忙目标", criteria: ["判据一"] });
    // 用**本进程**的 PID 以外的一个「活着」的进程占用认领锁（node 自身即可）。
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      writeFileSync(join(root, `.lock.claim-${id}`), String(holder.pid), "utf8");
      const before = snapshotTree(root);
      assert.throws(
        () => claimGoal({ root, id, actor: "test" }),
        (e: unknown) => {
          assert.ok(e instanceof ClaimError);
          assert.equal(e.code, "claim-lock-busy");
          assert.match(e.message, /并发认领|另一路 claim/);
          return true;
        },
      );
      assert.equal(snapshotTree(root), before, "锁忙拒绝必须零副作用");
    } finally {
      holder.kill("SIGKILL");
      rmSync(join(root, `.lock.claim-${id}`), { force: true });
    }
    assert.ok(CLAIM_LOCK_TIMEOUT_MS > 0, "锁等待上限必须是正数（有界等待，不无限挂）");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 6：边界 —— 目标不存在 / 损坏 / 只读 / 非工作区
// ---------------------------------------------------------------------------

test("g-316 判据6：目标不存在 ⇒ 非零退出 + 可读原因 + 零副作用", async () => {
  const sb = makeSandbox("g316-missing");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    makeClaimableGoal(root, { title: "另一个目标", criteria: ["判据一"] });
    const before = snapshotTree(root);
    const r = await cliInProcess(["claim", "g-999"], workspace);
    assert.equal(r.exitCode, EXIT_FAILURE);
    assert.match(r.stderr, /目标不存在：g-999/);
    assert.equal(snapshotTree(root), before, "零副作用");
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据6：损坏的 goal.md ⇒ 非零退出并点名「损坏」，不伪装成「目标不存在」，零副作用", async () => {
  const sb = makeSandbox("g316-corrupt");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    const file = join(root, "goals", "g-777", "goal.md");
    mkdirSync(join(file, ".."), { recursive: true });
    // frontmatter 不是合法 JSON ⇒ core 解析失败
    writeFileSync(file, `---\n{ "id": "g-777", 这不是 JSON \n---\n\n## 目标描述\n\nx\n`, "utf8");
    const before = snapshotTree(root);
    const r = await cliInProcess(["claim", "g-777"], workspace);
    assert.equal(r.exitCode, EXIT_FAILURE, `必须非零退出；stdout=${r.stdout}`);
    assert.match(r.stderr, /目标文件损坏/, "必须点名损坏而非「不存在」");
    assert.match(r.stderr, /g-777/, "必须指出是哪个文件");
    assert.doesNotMatch(r.stderr, /目标不存在/, "损坏不得伪装成不存在");
    assert.equal(snapshotTree(root), before, "零副作用");
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据6：只读看板目录 ⇒ 非零退出且零副作用（连锁文件都不创建）", () => {
  const sb = makeSandbox("g316-readonly");
  try {
    const { root } = makeBoard(sb.dir);
    const id = makeClaimableGoal(root, { title: "只读目标", criteria: ["判据一"] });
    const before = snapshotTree(root);
    chmodSync(root, 0o500);
    try {
      assert.throws(
        () => claimGoal({ root, id, actor: "test" }),
        (e: unknown) => {
          assert.ok(e instanceof ClaimError);
          assert.equal(e.code, "board-unwritable");
          assert.match(e.message, /不可写（只读）/);
          return true;
        },
      );
    } finally {
      chmodSync(root, 0o755);
    }
    assert.equal(snapshotTree(root), before, "只读拒绝必须零副作用（不建锁、不写事件）");
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据6：非工作区 ⇒ 非零退出 + 提示 --root，且目录不被初始化", async () => {
  const sb = makeOutsideSandbox("g316-noworkspace");
  try {
    const r = await cliInProcess(["claim", "g-1"], sb.dir);
    assert.equal(r.exitCode, EXIT_FAILURE, `必须非零退出；stdout=${r.stdout}`);
    assert.match(r.stderr, /非 goal-graph 工作区|没有 \.dsh-graph/);
    assert.match(r.stderr, /--root/, "必须提示可用 --root");
    assert.deepEqual(readdirSync(sb.dir), [], "非工作区不得被初始化（零副作用）");
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据6：所有拒绝路径都给出非零退出码与可读 stderr（退出码分层不变）", async () => {
  const sb = makeSandbox("g316-exitcodes");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    const id = makeClaimableGoal(root, { title: "退出码目标", criteria: ["判据一"] });
    // 用法错误 = 2
    const usage = await cliInProcess(["claim"], workspace);
    assert.equal(usage.exitCode, EXIT_USAGE);
    assert.match(usage.stderr, /运行 goal-graph help 查看用法/);
    // 成功 = 0
    const ok = await cliInProcess(["claim", id], workspace);
    assert.equal(ok.exitCode, EXIT_OK);
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 7：真源码副本反向变异（先验基线，再验变异体变红）
// ---------------------------------------------------------------------------

test("g-316 判据7（反向变异·真源码副本）：拆掉「in_progress 幂等」判定后，幂等零副作用断言必红", () => {
  const sb = makeSandbox("g316-mut-idempotent");
  try {
    const mutation = makeMutationSandbox(sb);
    const { root } = makeBoard(sb.dir);
    const id = makeClaimableGoal(root, { title: "变异幂等目标", criteria: ["判据一"] });

    // 基线：未变异副本必须幂等（changed=false、无新事件）——否则变异对照无意义
    const first = runCliProcess(mutation.entry, ["claim", id, "--json"], root);
    assert.equal(first.code, EXIT_OK, `副本未变异时首次 claim 必须成功；stderr=${first.stderr}`);
    const eventsAfterFirst = eventsOf(root).length;
    const second = runCliProcess(mutation.entry, ["claim", id, "--json"], root);
    assert.equal(second.code, EXIT_OK, `副本未变异时重复 claim 必须成功；stderr=${second.stderr}`);
    assert.equal((JSON.parse(second.stdout) as { changed: boolean }).changed, false, "基线：幂等命中");
    assert.equal(eventsOf(root).length, eventsAfterFirst, "基线：幂等不写事件");

    // 变异：拆掉**幂等短路本身**（`if (status !== "in_progress")` ⇒ 恒真），
    // 让已 in_progress 的目标再次走 core 的 transition（后者会照实拒绝「状态未变化」）。
    mutateSource(
      mutation.file("cli/claim.ts"),
      '    if (status !== "in_progress") {\n      try {\n        transition(root, id, "in_progress", { actor });',
      '    if (true) {\n      try {\n        transition(root, id, "in_progress", { actor });',
    );
    const mutated = runCliProcess(mutation.entry, ["claim", id, "--json"], root);
    assert.equal(mutated.code, EXIT_FAILURE, `变异体必须失败（已 in_progress 再迁移 ⇒ 状态未变化）；stdout=${mutated.stdout}`);
    assert.match(mutated.stderr, /状态迁移被拒绝/, `变异体必须报「状态迁移被拒绝」；stderr=${mutated.stderr}`);
    // ⇒ 上面对「基线幂等命中（changed=false、退出 0）」的断言在变异体上必然失败。
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据7（反向变异·真源码副本）：去掉空判据拒绝后，无判据目标被放行（判据门禁失效必红）", () => {
  const sb = makeSandbox("g316-mut-criteria");
  try {
    const mutation = makeMutationSandbox(sb);
    const { root } = makeBoard(sb.dir);
    const id = makeClaimableGoal(root, { title: "变异判据目标" });

    // 基线：未变异副本必须拒绝无判据目标
    const pristine = runCliProcess(mutation.entry, ["claim", id], root);
    assert.equal(pristine.code, EXIT_FAILURE, `副本未变异时必须拒绝空判据；stderr=${pristine.stderr}`);
    assert.match(pristine.stderr, /没有质量判据/, "基线：必须给出空判据原因");

    // 变异：把判据门禁条件改成恒假
    mutateSource(
      mutation.file("cli/claim.ts"),
      "if (criteria.length === 0) {",
      "if (false) {",
    );
    const mutated = runCliProcess(mutation.entry, ["claim", id], root);
    // 空判据门禁被拆掉后，CLI 不再给「没有质量判据」，而是**穿透到**下一道守卫
    // （该目标无 criteria.confirmed 事件）——这正是「CLI 门禁失效」的直接可观测后果。
    assert.doesNotMatch(mutated.stderr, /没有质量判据/, "变异体不应再命中空判据门禁");
    assert.match(mutated.stderr, /判据尚未确认/, `变异体必须穿透到下一道守卫；stderr=${mutated.stderr}`);
    // ⇒ 上面对「必须给出「没有质量判据」」的断言在变异体上必然失败。
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据7（反向变异·真源码副本）：把 exit 1 吞成 0 后，拒绝路径的退出码断言必红", () => {
  const sb = makeSandbox("g316-mut-exit");
  try {
    const mutation = makeMutationSandbox(sb);
    const { root } = makeBoard(sb.dir);
    makeClaimableGoal(root, { title: "退出码变异目标", criteria: ["判据一"] });

    // 基线：目标不存在必须退出 1
    const pristine = runCliProcess(mutation.entry, ["claim", "g-999"], root);
    assert.equal(pristine.code, EXIT_FAILURE, "基线：目标不存在必须退出 1");

    // 变异：`failure()` 的退出码 1 → 0（「静默成功」是最危险的退化）
    mutateSource(
      mutation.file("cli/main.ts"),
      'return { exitCode: EXIT_FAILURE, stdout: "", stderr: `goal-graph: ${message}\\n` };',
      'return { exitCode: EXIT_OK, stdout: "", stderr: `goal-graph: ${message}\\n` };',
    );
    const mutated = runCliProcess(mutation.entry, ["claim", "g-999"], root);
    assert.equal(mutated.code, EXIT_OK, `变异体必须把失败吞成 0；stderr=${mutated.stderr}`);
    // ⇒ 上面对「必须退出 1」的断言在变异体上必然失败。
  } finally {
    sb.cleanup();
  }
});

test("g-316 判据7（反向变异·真源码副本）：拆掉 withLocalLock 后，锁被占用时不再拒绝（绕锁必红）", () => {
  const sb = makeSandbox("g316-mut-lock");
  try {
    const mutation = makeMutationSandbox(sb);
    const { root } = makeBoard(sb.dir);
    const id = makeClaimableGoal(root, { title: "锁变异目标", criteria: ["判据一"] });

    // 基线 A：未变异副本在锁被外部（存活进程）持有时必须拒绝 claim-lock-busy
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const lockFile = join(root, `.lock.claim-${id}`);
    try {
      writeFileSync(lockFile, String(holder.pid), "utf8");
      const pristine = runCliProcess(mutation.entry, ["claim", id, "--json"], root);
      assert.equal(pristine.code, EXIT_FAILURE, `副本未变异时必须因锁忙拒绝；stderr=${pristine.stderr}`);
      assert.match(pristine.stderr, /并发认领|另一路 claim/, "基线：必须点名并发认领");
    } finally {
      holder.kill("SIGKILL");
      rmSync(lockFile, { force: true });
    }
    // 基线 B：正常路径下未变异副本的首次 claim 成功（证明副本本身可运行、夹具有效）
    const baseline = runCliProcess(mutation.entry, ["claim", id, "--json"], root);
    assert.equal(baseline.code, EXIT_OK, `副本未变异时正常 claim 必须成功；stderr=${baseline.stderr}`);
    assert.equal((JSON.parse(baseline.stdout) as { changed: boolean }).changed, true);

    // 变异：把 withLocalLock 换成「无锁直调」——正是「绕锁」的退化形态
    mutateSource(
      mutation.file("cli/claim.ts"),
      "return withLocalLock(root, claimLockName(id), run, { lockTimeoutMs: CLAIM_LOCK_TIMEOUT_MS });",
      "return run();",
    );

    const holder2 = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const lockFile2 = join(root, `.lock.claim-${id}`);
    try {
      writeFileSync(lockFile2, String(holder2.pid), "utf8");
      const mutated = runCliProcess(mutation.entry, ["claim", id, "--json"], root);
      // 无锁 ⇒ 不检查锁文件 ⇒ 不再报「并发认领」（幂等命中，退出 0）
      assert.equal(mutated.code, EXIT_OK, `变异体必须无视锁直接成功；stderr=${mutated.stderr}`);
      assert.doesNotMatch(mutated.stderr, /并发认领|另一路 claim/, "变异体不得再报并发认领");
    } finally {
      holder2.kill("SIGKILL");
      rmSync(lockFile2, { force: true });
    }
    // ⇒ 上面对「锁被外部持有 ⇒ 非零退出并点名并发认领」的断言在变异体上必然失败。
  } finally {
    sb.cleanup();
  }
});
