/**
 * g-317：`dsh-graph submit [goal-id]` —— 自检 + Git 变更统计 → 推进到 `review` + `review.requested`。
 *
 * 覆盖判据（与 goal.md 的 11 条一一对应）：
 * - 判据 1：命令名/参数解析；省略 goal-id 从唯一在途目标推断，歧义/无在途 ⇒ 报错**并列候选**（不猜）；
 * - 判据 2：自检以 `scripts/run-tests.mjs` 的**真实退出码**为准（不是 `node --test`）；
 *   skip/todo/cancelled 非 0 阻断、空选集/未运行/`tests=0` 阻断、输出非 0 但无原因也阻断；
 * - 判据 3：阻断时**状态与事件零改动**；自检在锁外跑完才可能知道失败 ⇒ 零副作用指「看板零改动」；
 * - 判据 4：Git 变更统计口径（numstat HEAD 含暂存 + ls-files --others 未跟踪）与「无变更/不干净」行为；
 * - 判据 5：状态迁移复用 core `transition` + `requestAcceptReview`，`review.requested` **先于**
 *   `goal.transition`（注入失败验证真实顺序）；静态守卫禁止手写 events/写 goal.md；
 * - 判据 6：测试输出与 diff 全文不得写入 events.jsonl / 看板字段（事件行长度 + 字段白名单断言）；
 * - 判据 7：拒绝路径零副作用（整树内容哈希 + inode + mtime 快照逐字节比对）；
 * - 判据 8：已在 `review` ⇒ 幂等命中（退出 0、`changed=false`、零事件）；
 * - 判据 9：**真源码副本反向变异**（关掉自检阻断 ⇒ 必红；吞掉退出码 ⇒ 必红）；
 * - 判据 10：`--skip-tests` 默认关闭、显式使用大声标「未验证」并非零退出。
 *
 * 夹具建在仓库 `tmp/` 下的私有 mkdtemp 目录（AGENTS.md 规定的临时区），用后清理；
 * 「非工作区」夹具建在仓库外（`TMPDIR`），**绝不**让它在仓库内向上找到真实 `.dsh-graph`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  init,
  createGoal,
  setCriteria,
  moveGoal,
  transition,
  findGoalFile,
  loadGoal,
  listGoalFiles,
} from "../ops.ts";
import { parseArgs } from "../cli/args.ts";
import { runCli, EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../cli/main.ts";
import {
  submitGoal,
  SubmitError,
  evaluateSelfCheck,
  parseSelfCheckCounts,
  parseSelfCheckFailureReason,
  renderSubmitBrief,
  collectGitChanges,
  submitEvidenceSnapshot,
  type SelfCheckReport,
} from "../cli/submit.ts";

const repoRoot = join(import.meta.dirname, "../..");
/**
 * 夹具根：**工作区根**的 `tmp/`（git 忽略 ⇒ core 判 scratch，不做 worktree 归一；见 makeSandbox）。
 * `import.meta.dirname` 指向**当前**树（可能是 linked worktree），故从它向上找到工作区根（含 `.git`）。
 */
function findWorkspaceRoot(start: string): string {
  // 主树与 linked worktree 都含 `.git`（worktree 的是指针文件）；向上找最近的一个。
  let cur = start;
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return start;
    cur = parent;
  }
}
const workspaceRoot = findWorkspaceRoot(repoRoot);
const tmpRoot = join(workspaceRoot, "tmp");
const cliSourceEntry = join(repoRoot, "bin", "dsh-graph.mjs");

/**
 * 沙箱位置为什么是**工作区根**的 `tmp/` 而不是 `.worktrees/.../tmp/`（真事故）：
 * core 的 `resolveCanonicalRoot` 把 **Git linked worktree** 归一化到主工作树 —— 在 `.worktrees/g-317-att-01`
 * 里建看板会被归一成主树的 `<repo>/.dsh-graph`，测试就会真的写进真实看板（实测已命中的事故形态）。
 * 工作区根的 `tmp/` 带 `.gitignore` 的 `tmp/`/`/tmp/` ⇒ core 判为 **scratch 工作区**，不参与 worktree 归一。
 * 故本套件一律用 `TMPDIR`-可覆盖的工作区根 `tmp/`。
 */
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

/**
 * 已初始化看板。**看板直接位于沙箱根**（`<sandbox>/.dsh-graph`）而不是再套一层 `ws/`：
 * submit 自检时以「调用者 workspace」为 cwd 跑 `scripts/run-tests.mjs`，而沙箱里只有工作区根的 layout；
 * 于是夹具把测试夹具（`scripts/`、`bin/`、`core/` + 看板）放在**同一个根**下 —— 与真实仓库形态一致。
 */
function makeBoard(sandboxDir: string): { workspace: string; root: string } {
  const workspace = sandboxDir;
  const root = join(workspace, ".dsh-graph");
  mkdirSync(workspace, { recursive: true });
  init(root);
  return { workspace, root };
}

/** 建一个可 submit 的目标：createGoal → setCriteria → moveGoal(standalone=planning) → in_progress。 */
function makeInFlightGoal(root: string, opts: { title?: string; advance?: boolean } = {}): string {
  const id = createGoal(root, { title: opts.title ?? "在途目标", actor: "human:test" });
  setCriteria(root, id, ["判据一：必须可信"], "human:test");
  moveGoal(root, id, { to: "standalone", actor: "human:test" });
  if (opts.advance !== false) transition(root, id, "in_progress", { actor: "human:test" });
  return id;
}

function statusOf(root: string, id: string): string {
  return String(loadGoal(findGoalFile(root, id)).meta.status ?? "");
}

function eventsOf(root: string): Array<Record<string, unknown>> {
  const file = join(root, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function eventsNamed(root: string, id: string, name: string): Array<Record<string, unknown>> {
  return eventsOf(root).filter((e) => e.goal === id && e.event === name);
}

/** 整棵目录树快照（零副作用断言）：内容哈希 + inode + mtime。 */
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

/**
 * 可注入的「假自检」：返回指定结论（**不真的跑门禁**）。
 * 口径与 run-tests.mjs 的真实输出逐字对齐（**两种行形态不同**，这是评审 BLOCK 点名的地方）：
 * - 通过行：`✔ 自证通过：tests=… (>0) skipped=… fail=… cancelled=… todo=… pass=… exit=0 … glob=…`（带计数）；
 * - 失败行：`✖ 自证失败：<原因串>`（**只有原因串，没有任何计数字段**）——
 *   真实门禁失败时打印的就是这一句，夹具**不得**再造出 `tests=10 skipped=2 …` 这种从不出现的形态。
 */
function fakeSelfCheck(opts: {
  exitCode: number | null;
  counts?: Partial<{ tests: number; pass: number; fail: number; skipped: number; todo: number; cancelled: number }>;
  /** 失败行的原因串（`✖ 自证失败：` 之后的部分）；缺省按计数自拟。 */
  failureReason?: string;
  /** 失败行带计数（真实门禁**从不**这样打印；仅用于钉住防御分支）。 */
  failureLineWithCounts?: boolean;
  emitSummary?: boolean;
  stdout?: string;
}): SelfCheckReport {
  const c = {
    tests: 120,
    pass: 120,
    fail: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0,
    ...(opts.counts ?? {}),
  };
  const countsText =
    `tests=${c.tests} (>0) skipped=${c.skipped} fail=${c.fail} cancelled=${c.cancelled} ` +
    `todo=${c.todo} pass=${c.pass}`;
  const passing = opts.exitCode === 0 && c.fail === 0;
  let summaryLine: string;
  if (passing) {
    summaryLine = `[run-tests] ✔ 自证通过：${countsText} exit=0 ms=1234 glob=core/tests/*.test.ts`;
  } else if (opts.failureLineWithCounts) {
    // 真实门禁不会打印这一形态；保留它只为钉住「带计数的失败行也须点名 skip/todo/cancelled」的防御分支。
    summaryLine =
      `[run-tests] ✖ 自证失败：${countsText} exit=${opts.exitCode ?? 1} ms=1234 glob=core/tests/*.test.ts`;
  } else {
    const reason =
      opts.failureReason ??
      (c.skipped > 0
        ? `整套件自证闸门不达标 —— 有用例被**跳过**（skipped=${c.skipped}）`
        : c.todo > 0
          ? `整套件自证闸门不达标 —— 有用例被标记为 todo（todo=${c.todo}）`
          : c.cancelled > 0
            ? `整套件自证闸门不达标 —— 有用例被取消（cancelled=${c.cancelled}）`
            : c.fail > 0
              ? `整套件自证闸门不达标 —— 有 ${c.fail} 条用例失败（fail=${c.fail}）`
              : `整套件自证闸门不达标 —— 退出码 ${opts.exitCode ?? 1}`);
    // 真实形态：只有原因串，**没有** tests=/skipped= 这类计数字段。
    summaryLine = `[run-tests] ✖ 自证失败：${reason}`;
  }
  const stdout = opts.emitSummary === false ? (opts.stdout ?? "") : `${opts.stdout ?? ""}\n${summaryLine}\n`;
  const verdict = evaluateSelfCheck({ exitCode: opts.exitCode, signal: null, stdout, stderr: "" });
  return {
    ran: true,
    command: "node scripts/run-tests.mjs",
    exit_code: opts.exitCode,
    signal: null,
    duration_ms: 1234,
    ...(verdict.counts ?? { tests: null, pass: null, fail: null, skipped: null, todo: null, cancelled: null }),
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    tail: stdout.slice(-400),
  };
}

/** 成功自检（全绿）。 */
const PASSING = () => fakeSelfCheck({ exitCode: 0 });

/**
 * submit 的直接调用（绕过真实门禁）：注入 deps，**只测 submit 自己的语义**。
 * 真实门禁链路由「真进程 + 真实 scripts/run-tests.mjs」的那几条用例覆盖（标记耗时）。
 */
function submitWith(
  root: string,
  opts: { id?: string | null; selfCheck?: SelfCheckReport; changes?: () => ReturnType<typeof collectGitChanges> } = {},
) {
  return submitGoal({
    root,
    id: opts.id ?? null,
    actor: "test:submit",
    deps: {
      runSelfCheck: async () => opts.selfCheck ?? PASSING(),
      collectChanges: () => (opts.changes ? opts.changes() : null),
    },
  });
}

function runCliProcess(entry: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "NODE_OPTIONS"]) delete base[name];
  const res = spawnSync(process.execPath, [entry, ...argv], {
    cwd,
    encoding: "utf8",
    timeout: 300_000,
    env: { ...base, ...env },
  });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * 真源码副本沙箱：`core/` 全量（tests 除外）+ `prompts/` + `scripts/`（自检门禁）+ 入口。
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
  cpSync(join(repoRoot, "scripts"), join(sb.dir, "scripts"), { recursive: true });
  cpSync(cliSourceEntry, join(binDir, "dsh-graph.mjs"));
  return {
    entry: join(binDir, "dsh-graph.mjs"),
    file(rel: string): string {
      return join(sb.dir, rel);
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

/**
 * 在给定的 **workspace 根**（即自检的 cwd）写一个「假门禁」，退出码与输出可控
 * （模拟 run-tests.mjs 的不同结局）。注意：门禁必须落在自检真正跑的目录里 ——
 * 只看板目录写成 `<sb>/pre/.dsh-graph` 而门禁写在 `<sb>/scripts/` 时，自检在 `<sb>/pre`
 * 里根本找不到门禁，会得到「未解析到自证行」而非预期的伪绿结局（实测踩过）。
 */
function writeFakeGate(workspace: string, script: string): void {
  mkdirSync(join(workspace, "scripts"), { recursive: true });
  writeFileSync(join(workspace, "scripts", "run-tests.mjs"), script, "utf8");
}

// ===========================================================================
// 判据 1：参数解析 + 在途推断
// ===========================================================================

test("g-317 判据1：submit 登记为已知命令，goal-id 可省略（最多 1 个），--skip-tests 只属于 submit", () => {
  const noId = parseArgs(["submit"]);
  assert.equal(noId.error, null, `submit 必须允许省略 goal-id：${noId.error?.message ?? ""}`);
  assert.equal(noId.args?.command, "submit");
  assert.deepEqual(noId.args?.positionals, []);
  assert.equal(noId.args?.skipTests, false, "--skip-tests 默认必须关闭");

  const withId = parseArgs(["submit", "g-1"]);
  assert.equal(withId.error, null);
  assert.deepEqual(withId.args?.positionals, ["g-1"]);

  const full = parseArgs(["--json", "--root", "/x", "submit", "g-1", "--skip-tests"]);
  assert.equal(full.error, null);
  assert.equal(full.args?.json, true);
  assert.equal(full.args?.root, "/x");
  assert.equal(full.args?.skipTests, true);

  const extra = parseArgs(["submit", "g-1", "g-2"]);
  assert.ok(extra.error, "submit 多于一个位置参数必须被拒绝");
  assert.equal(extra.error!.code, "unexpected-argument");

  const blank = parseArgs(["submit", " "]);
  assert.ok(blank.error, "空串 goal-id 必须被拒绝（不得当作省略）");
  assert.equal(blank.error!.code, "missing-argument");

  const unknown = parseArgs(["submit", "g-1", "--nope"]);
  assert.equal(unknown.error?.code, "unknown-option");

  // --skip-tests 是 submit 专属：用在别的命令上属于用法错误，不得被静默忽略。
  const misuse = parseArgs(["claim", "g-1", "--skip-tests"]);
  assert.ok(misuse.error, "--skip-tests 用在 claim 上必须被拒绝");
  assert.equal(misuse.error!.code, "unexpected-argument");
  assert.match(misuse.error!.message, /只适用于 submit/);
});

test("g-317 判据1：help 文本登记 submit（命令名与 bin 一致）与 --skip-tests 语义", async () => {
  const r = await runCli(["submit", "--help"], { version: "0.0.0-test", cwd: tmpRoot });
  assert.equal(r.exitCode, EXIT_OK);
  assert.match(r.stdout, /submit \[goal-id\]/, "帮助必须给出 submit 的用法与可省略的 goal-id");
  assert.match(r.stdout, /--skip-tests/, "帮助必须登记 --skip-tests");
  assert.match(r.stdout, /未验证/, "帮助必须写明 --skip-tests 是「未验证」降级");
  assert.match(r.stdout, /scripts\/run-tests\.mjs/, "帮助必须写明自检用的是全量门禁而非 node --test");
});

test("g-317 判据1：省略 goal-id 且有多个在途目标 ⇒ 报错并列出候选（不猜），零副作用", async () => {
  const sb = makeSandbox("g317-ambiguous");
  try {
    const { root } = makeBoard(sb.dir);
    const a = makeInFlightGoal(root, { title: "甲" });
    const b = makeInFlightGoal(root, { title: "乙" });
    const before = snapshotTree(root);
    await assert.rejects(
      () => submitWith(root),
      (e: unknown) => {
        assert.ok(e instanceof SubmitError);
        assert.equal(e.code, "goal-ambiguous");
        assert.match(e.message, new RegExp(a), "必须列出候选甲");
        assert.match(e.message, new RegExp(b), "必须列出候选乙");
        assert.match(e.message, /不猜/);
        return true;
      },
    );
    assert.equal(snapshotTree(root), before, "歧义拒绝必须零副作用");
  } finally {
    sb.cleanup();
  }
});

test("g-317 判据1：省略 goal-id 且无在途目标 ⇒ 报错（零副作用）；唯一在途时正确推断", async () => {
  const sb = makeSandbox("g317-infer");
  try {
    const { root } = makeBoard(sb.dir);
    // 无在途：只有一个 planning 目标
    const planning = makeInFlightGoal(root, { title: "未认领", advance: false });
    assert.equal(statusOf(root, planning), "planning");
    const before = snapshotTree(root);
    await assert.rejects(
      () => submitWith(root),
      (e: unknown) => {
        assert.ok(e instanceof SubmitError);
        assert.equal(e.code, "goal-none-in-flight");
        assert.match(e.message, /在途目标/);
        return true;
      },
    );
    assert.equal(snapshotTree(root), before, "无在途拒绝必须零副作用");

    // 唯一在途 ⇒ 推断
    transition(root, planning, "in_progress", { actor: "human:test" });
    const r = await submitWith(root);
    assert.equal(r.inferred, true, "必须标明目标由推断而来");
    assert.equal(r.goal.id, planning);
    assert.equal(r.changed, true);
    assert.equal(statusOf(root, planning), "review");
  } finally {
    sb.cleanup();
  }
});

// ===========================================================================
// 判据 2：自检结论必须可信
// ===========================================================================

test("g-317 判据2：evaluateSelfCheck —— 全绿才可信通过；skip/todo/cancelled/tests=0/无自证行一律阻断", () => {
  const pass = evaluateSelfCheck({
    exitCode: 0,
    signal: null,
    stdout: "[run-tests] ✔ 自证通过：tests=120 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=120 exit=0 ms=9 glob=g",
    stderr: "",
  });
  assert.equal(pass.verdict, "pass", `全绿必须通过；reasons=${pass.reasons.join("；")}`);
  assert.deepEqual(pass.reasons, []);
  assert.equal(pass.counts?.tests, 120);

  // 失败行的**真实形态**：只有原因串（`✖ 自证失败：<原因串>`），没有 tests=/skipped= 计数。
  // 这正是评审 BLOCK 的形态 —— 旧夹具把它们造成带计数的行，使「点名原因」在真实门禁下失效。
  const cases: Array<[string, Parameters<typeof evaluateSelfCheck>[0], RegExp]> = [
    [
      "退出码非 0（真失败，门禁点名 fail=2）",
      {
        exitCode: 1,
        signal: null,
        stdout: "[run-tests] ✖ 自证失败：整套件自证闸门不达标 —— 有 2 条用例失败（fail=2）",
        stderr: "",
      },
      /门禁原因：.*fail=2/,
    ],
    [
      "伪绿：skipped 非 0（真实形态 —— 原因在原因串里）",
      {
        exitCode: 1,
        signal: null,
        stdout: "[run-tests] ✖ 自证失败：整套件自证闸门不达标 —— 有用例被**跳过**（skipped=3）",
        stderr: "",
      },
      /门禁原因：.*跳过.*skipped=3/,
    ],
    [
      "伪绿：todo 非 0（真实形态）",
      {
        exitCode: 1,
        signal: null,
        stdout: "[run-tests] ✖ 自证失败：整套件自证闸门不达标 —— 有用例被标记为 todo（todo=2）",
        stderr: "",
      },
      /门禁原因：.*todo=2/,
    ],
    [
      "伪绿：cancelled 非 0（真实形态）",
      {
        exitCode: 1,
        signal: null,
        stdout: "[run-tests] ✖ 自证失败：整套件自证闸门不达标 —— 有用例被取消（cancelled=1）",
        stderr: "",
      },
      /门禁原因：.*cancelled=1/,
    ],
    [
      "空选集：tests=0",
      { exitCode: 0, signal: null, stdout: "[run-tests] ✔ 自证通过：tests=0 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=0 exit=0 ms=9 g", stderr: "" },
      /tests=0/,
    ],
    [
      "未运行：没有任何自证行",
      { exitCode: 0, signal: null, stdout: "ℹ tests 1\nℹ pass 1\n", stderr: "" },
      /未解析到自检自证行/,
    ],
    [
      "被信号终止",
      { exitCode: null, signal: "SIGKILL", stdout: "", stderr: "" },
      /信号终止/,
    ],
  ];
  for (const [label, run, pattern] of cases) {
    const v = evaluateSelfCheck(run);
    assert.equal(v.verdict, "blocked", `${label} 必须阻断`);
    assert.ok(
      v.reasons.some((r) => pattern.test(r)),
      `${label} 必须点名原因（期望 ${pattern}）；实际：${v.reasons.join("；")}`,
    );
  }

  // 核心回归（评审 BLOCK 的直接复现）：真实失败行**存在**时，绝不能报「未解析到自证行」——
  // 那会把「有用例被跳过」误述成「测试未运行」（语义错位）。
  const realSkipped = evaluateSelfCheck({
    exitCode: 1,
    signal: null,
    stdout: "[run-tests] ✖ 自证失败：整套件自证闸门不达标 —— 有用例被**跳过**（skipped=1）",
    stderr: "",
  });
  assert.equal(realSkipped.verdict, "blocked");
  assert.ok(
    !realSkipped.reasons.some((r) => /未解析到自检自证行/.test(r)),
    `有失败自证行时不得报「未解析到自证行」；实际：${realSkipped.reasons.join("；")}`,
  );
  assert.ok(
    realSkipped.reasons.some((r) => /跳过/.test(r) && /skipped=1/.test(r)),
    `必须转述门禁自己点名的真实原因；实际：${realSkipped.reasons.join("；")}`,
  );
  // 失败行没有计数 ⇒ counts 为 null（不得凭空编造 tests=0 之类的数字）。
  assert.equal(realSkipped.counts, null, "失败行无计数字段，counts 必须为 null 而不是伪造的 0");

  // 防御：带计数的失败行（非真实形态）仍须点名 skip/todo/cancelled —— 阻断线只增不减。
  const withCounts = evaluateSelfCheck({
    exitCode: 1,
    signal: null,
    stdout: "[run-tests] ✖ 自证失败：tests=10 (>0) skipped=2 fail=0 cancelled=0 todo=0 pass=8 exit=1 ms=5 g",
    stderr: "",
  });
  assert.equal(withCounts.verdict, "blocked");
  assert.ok(
    withCounts.reasons.some((r) => /skip 用例 2 条/.test(r)),
    `带计数的失败行也必须点名 skip 伪绿；实际：${withCounts.reasons.join("；")}`,
  );

  // 退出码 0 但 fail>0（计数自相矛盾）同样阻断 —— 绝不因「退出码 0」就判绿。
  const contradictory = evaluateSelfCheck({
    exitCode: 0,
    signal: null,
    stdout: "[run-tests] ✔ 自证通过：tests=10 (>0) skipped=0 fail=1 cancelled=0 todo=0 pass=9 exit=0 ms=9 g",
    stderr: "",
  });
  assert.equal(contradictory.verdict, "blocked", "退出码 0 但 fail>0 必须阻断");
});

test("g-317 判据2：parseSelfCheckFailureReason 只摘门禁失败行的原因串（无计数、不含前缀）", () => {
  // 真实形态：冒号之后即原因串，前后不得夹带 `[run-tests]` 前缀。
  assert.equal(
    parseSelfCheckFailureReason("[run-tests] ✖ 自证失败：整套件自证闸门不达标 —— 有用例被**跳过**（skipped=1）"),
    "整套件自证闸门不达标 —— 有用例被**跳过**（skipped=1）",
  );
  // 多行输出取**最后**一条失败行（与计数解析同口径）。
  assert.equal(
    parseSelfCheckFailureReason(
      "[run-tests] ✖ 自证失败：第一条原因\nnoise\n[run-tests] ✖ 自证失败：最后一条原因",
    ),
    "最后一条原因",
  );
  // 没有前缀的同名文本（测试自己 console.log 伪造）不得被采信。
  assert.equal(parseSelfCheckFailureReason("✖ 自证失败：伪造的原因"), null, "无 [run-tests] 前缀不得采信");
  // 成功行不是失败行。
  assert.equal(
    parseSelfCheckFailureReason("[run-tests] ✔ 自证通过：tests=5 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=5"),
    null,
  );
  // 完全没有自证行 ⇒ null（这才是「未解析到」的合法场景）。
  assert.equal(parseSelfCheckFailureReason("ℹ tests 1\n"), null);
  // 空原因串也不返回空字符串（转述层不得出现「门禁原因：」后面什么都没有）。
  assert.equal(
    parseSelfCheckFailureReason("[run-tests] ✖ 自证失败："),
    "门禁报告自证失败，但未给出原因串",
  );
});

test("g-317 判据2：parseSelfCheckCounts 只认门禁自证行，测试自己打印的 `ℹ tests` 伪造不出结论", () => {
  assert.equal(parseSelfCheckCounts("ℹ tests 999\nℹ pass 999"), null, "人类可读摘要不是权威来源");
  // 测试内 console.log 伪造的 `tests=` 行（无 [run-tests] 前缀）不得被采信
  assert.equal(parseSelfCheckCounts("fake tests=999 pass=999 [run-tests]"), null);
  const got = parseSelfCheckCounts(
    "noise\n[run-tests] ✔ 自证通过：tests=5 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=5 exit=0 ms=1 glob=g\n",
  );
  assert.deepEqual(got, { tests: 5, pass: 5, fail: 0, skipped: 0, todo: 0, cancelled: 0 });
});

test("g-317 判据2：自检阻断 ⇒ 看板状态与事件零改动（真进程 + 沙箱里的失败门禁）", () => {
  const sb = makeSandbox("g317-gate-block");
  try {
    const mutation = makeMutationSandbox(sb);
    // 门禁打印**真实的失败自证行**（只有原因串、没有计数）并以非 0 退出（skipped 非 0 的真实结局）
    writeFakeGate(
      sb.dir,
      `console.log("[run-tests] ✖ 自证失败：整套件自证闸门不达标 —— 有用例被**跳过**（skipped=2）");\n` +
        `process.exitCode = 1;\n`,
    );
    const { workspace, root } = makeBoard(sb.dir);
    const id = makeInFlightGoal(root, { title: "自检失败目标" });
    const before = snapshotTree(root);
    const r = runCliProcess(mutation.entry, ["submit", id, "--json"], workspace);
    assert.equal(r.code, EXIT_FAILURE, `自检阻断必须非零退出；stdout=${r.stdout}`);
    assert.match(r.stderr, /自检未通过/, "必须点名自检未通过");
    assert.equal(snapshotTree(root), before, "自检阻断时看板必须零改动（状态与事件）");
    assert.equal(statusOf(root, id), "in_progress", "状态不得变化");
    // --json 错误形态稳定且点名原因
    const payload = JSON.parse(r.stdout) as Record<string, any>;
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "self-check-blocked");
    assert.ok(
      payload.self_check.reasons.some((x: string) => /skip/.test(x)),
      `--json 必须点名 skip 伪绿；reasons=${JSON.stringify(payload.self_check.reasons)}`,
    );
  } finally {
    sb.cleanup();
  }
});

test("g-317 判据2：自检真实链路用 run-tests.mjs（不是 node --test）—— 沙箱门禁收到的是 scripts/run-tests.mjs", () => {
  const sb = makeSandbox("g317-gate-real");
  try {
    const mutation = makeMutationSandbox(sb);
    // 门禁把自己收到的 argv 打出来，证明 submit 调的是**全量门禁**而非 `node --test`。
    writeFakeGate(
      sb.dir,
      `console.log("ARGS=" + JSON.stringify(process.argv.slice(1)));\n` +
        `console.log("[run-tests] ✔ 自证通过：tests=7 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=7 exit=0 ms=5 glob=g");\n`,
    );
    const { workspace, root } = makeBoard(sb.dir);
    const id = makeInFlightGoal(root);
    const r = runCliProcess(mutation.entry, ["submit", id, "--json"], workspace);
    assert.equal(r.code, EXIT_OK, `应成功；stderr=${r.stderr} stdout=${r.stdout}`);
    const payload = JSON.parse(r.stdout) as Record<string, any>;
    assert.match(payload.self_check.command, /scripts\/run-tests\.mjs$/, "自检命令必须是 run-tests.mjs");
    assert.doesNotMatch(payload.self_check.command, /--test\b/, "自检命令不得是 node --test");
    assert.equal(payload.self_check.tests, 7);
    assert.equal(payload.verified, true);
  } finally {
    sb.cleanup();
  }
});

// ===========================================================================
// 判据 3/5/6/8：成功提交、事件先行、幂等、无长文本
// ===========================================================================

test("g-317 判据5：成功提交 —— review.requested 先于 goal.transition，且都来自 core", async () => {
  const sb = makeSandbox("g317-success");
  try {
    const { root } = makeBoard(sb.dir);
    const id = makeInFlightGoal(root, { title: "成功提交目标" });
    const r = await submitWith(root, { id });

    assert.equal(r.changed, true);
    assert.equal(r.from, "in_progress");
    assert.equal(r.to, "review");
    assert.equal(statusOf(root, id), "review", "frontmatter 必须经 core 迁移到 review");
    assert.deepEqual(r.events, ["review.requested", "goal.transition"], "事件顺序必须固定：请求先行、迁移后行");

    // 事件流里两事件的相对顺序（按行号）
    const all = eventsOf(root);
    const idxRequested = all.findIndex((e) => e.goal === id && e.event === "review.requested");
    const idxTransition = all.findIndex(
      (e) => e.goal === id && e.event === "goal.transition" && (e.details as any)?.to === "review",
    );
    assert.ok(idxRequested >= 0 && idxTransition >= 0, "两条事件都必须落盘");
    assert.ok(idxRequested < idxTransition, `review.requested 必须先于 goal.transition（实际 ${idxRequested} vs ${idxTransition}）`);

    // review.requested 复用既有形态：targetStage / what / snapshot(≤200)
    const req = eventsNamed(root, id, "review.requested")[0];
    const d = req.details as Record<string, unknown>;
    assert.equal(d.targetStage, "in_progress", "targetStage 必须是当时的状态");
    assert.equal(d.what, "review", "what 沿用 core 的既有判定");
    assert.ok(typeof d.snapshot === "string" && (d.snapshot as string).length <= 200, "snapshot 必须 ≤200 字");
    assert.equal(req.actor, "test:submit", "事件 actor 必须是调用方传入的 actor");
  } finally {
    sb.cleanup();
  }
});

test("g-317 判据5：事件先行 —— goal.transition 失败时 review.requested 已落盘、状态未变（真源码副本注入）", () => {
  const sb = makeSandbox("g317-event-first");
  try {
    const mutation = makeMutationSandbox(sb);
    writeFakeGate(
      sb.dir,
      `console.log("[run-tests] ✔ 自证通过：tests=3 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=3 exit=0 ms=1 g");\n`,
    );
    const { workspace, root } = makeBoard(sb.dir);
    const id = makeInFlightGoal(root, { title: "事件先行目标" });

    // 基线：未变异副本必须成功（证明副本可运行、夹具有效）
    const baselineGoal = makeInFlightGoal(root, { title: "基线目标" });
    const pristine = runCliProcess(mutation.entry, ["submit", baselineGoal, "--json"], workspace);
    assert.equal(pristine.code, EXIT_OK, `未变异副本必须成功；stderr=${pristine.stderr}`);

    // 变异：让 transition 在写事件前抛错（模拟「迁移失败」）—— 必须**在 review.requested 之后**
    mutateSource(
      mutation.file("core/ops.ts"),
      `export function transition(
  root: string,
  id: string,
  to: string,
  opts: { reason?: string; actor: string; force?: boolean },
): void {
  const file = findGoalFile(root, id);`,
      `export function transition(
  root: string,
  id: string,
  to: string,
  opts: { reason?: string; actor: string; force?: boolean },
): void {
  throw new Error("injected: 迁移注入失败");
  const file = findGoalFile(root, id);`,
    );

    const statusBefore = statusOf(root, id);
    const r = runCliProcess(mutation.entry, ["submit", id, "--json"], workspace);
    assert.equal(r.code, EXIT_FAILURE, `变异体必须失败；stdout=${r.stdout}`);
    // 事件先行：review.requested 已落盘
    assert.equal(
      eventsNamed(root, id, "review.requested").length,
      1,
      "迁移失败时 review.requested 必须已先行落盘（事件先于状态）",
    );
    // 状态未变：goal.transition 未写、frontmatter 未变
    assert.equal(
      eventsNamed(root, id, "goal.transition").filter((e) => (e.details as any)?.to === "review").length,
      0,
      "迁移失败时不得写下 goal.transition",
    );
    assert.equal(statusOf(root, id), statusBefore, "迁移失败时状态不得变化");
    // 如实报告「事件已落盘」
    const payload = JSON.parse(r.stdout) as Record<string, any>;
    assert.equal(payload.events_written, true, "--json 必须如实标记 events_written=true");
    assert.match(r.stderr, /事件已先行落盘/, "stderr 必须如实说明事件已落盘");
  } finally {
    sb.cleanup();
  }
});

test("g-317 判据6：事件与看板字段不倾倒长文本 —— 测试输出/diff 全文绝不进 events.jsonl", async () => {
  const sb = makeSandbox("g317-nolargetext");
  try {
    const { root } = makeBoard(sb.dir);
    const id = makeInFlightGoal(root, { title: "长文本目标" });
    const noisy = `LOUDLINE-${"x".repeat(5000)}`;
    const check = fakeSelfCheck({ exitCode: 0, stdout: noisy });
    const changes = {
      repo: "/fake",
      branch: "main",
      head: "deadbee",
      files_changed: 3,
      insertions: 12,
      deletions: 4,
      untracked_files: 2,
      clean: false,
    };
    const r = await submitWith(root, { id, selfCheck: check, changes: () => changes });
    assert.equal(r.changed, true);

    const raw = readFileSync(join(root, "events.jsonl"), "utf8");
    assert.ok(!raw.includes(noisy), "测试输出正文绝不进 events.jsonl");
    assert.ok(!raw.includes("x".repeat(500)), "events.jsonl 里不得出现超长连续文本");
    // 事件行长度有界（无长文本倾倒）
    for (const line of raw.split("\n").filter(Boolean)) {
      assert.ok(line.length < 1200, `事件行必须短小，实际 ${line.length} 字符`);
    }
    // details 白名单：只有既有三字段 + 机器证据摘要的短字段
    const req = eventsNamed(root, id, "review.requested")[0];
    const d = req.details as Record<string, any>;
    for (const key of ["targetStage", "what", "snapshot", "command", "exit_code", "verified", "tests", "changes"]) {
      assert.ok(key in d, `review.requested.details 必须含 ${key}`);
    }
    assert.ok(!("tail" in d), "输出尾部不得进事件");
    for (const v of Object.values(d)) {
      if (typeof v === "string") assert.ok(v.length <= 400, `事件字符串字段必须短小，实际 ${v.length}`);
    }
    // --json 也不含输出正文（只给计数/退出码/耗时）
    assert.equal(r.self_check.tail, "", "--json 的自检结论必须剥掉输出尾部");
  } finally {
    sb.cleanup();
  }
});

test("g-317 判据8：已在 review ⇒ 幂等命中（退出 0、changed=false、零事件、零字节改动）", async () => {
  const sb = makeSandbox("g317-idempotent");
  try {
    const { root } = makeBoard(sb.dir);
    const id = makeInFlightGoal(root, { title: "幂等目标" });
    const first = await submitWith(root, { id });
    assert.equal(first.changed, true);
    const snapAfterFirst = snapshotTree(root);
    const requestedCount = eventsNamed(root, id, "review.requested").length;
    assert.equal(requestedCount, 1);

    // 第二次（显式 id）：幂等成功，零写入
    const second = await submitWith(root, { id });
    assert.equal(second.changed, false, "已在 review 必须 changed=false");
    assert.equal(second.from, "review");
    assert.equal(second.to, "review");
    assert.deepEqual(second.events, [], "幂等命中不得产生任何事件");
    assert.equal(eventsNamed(root, id, "review.requested").length, requestedCount, "不得重复 review.requested");
    assert.equal(statusOf(root, id), "review");
    assert.equal(snapshotTree(root), snapAfterFirst, "幂等命中必须零字节改动（整树快照）");

    // 第三次（省略 id）同样幂等：在途口径只含 in_progress，故不再歧义
    const third = await submitWith(root);
    assert.equal(third.changed, false);
    assert.equal(third.goal.id, id, "省略 id 时必须仍定位到同一目标");
    assert.equal(snapshotTree(root), snapAfterFirst, "省略 id 的幂等命中同样零字节改动");
  } finally {
    sb.cleanup();
  }
});

// ===========================================================================
// 判据 4：Git 变更统计口径
// ===========================================================================

test("g-317 判据4：Git 统计口径 —— numstat HEAD（含暂存）+ 未跟踪单列；无变更/不干净各有明确行为", () => {
  const sb = makeSandbox("g317-git");
  try {
    const repo = join(sb.dir, "repo");
    mkdirSync(repo, { recursive: true });
    const run = (args: string[]) => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      assert.equal(r.status, 0, `git ${args.join(" ")} 失败：${r.stderr}`);
    };
    run(["init", "-q"]);
    run(["config", "user.email", "t@example.test"]);
    run(["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "1\n2\n3\n", "utf8");
    run(["add", "a.txt"]);
    run(["commit", "-q", "-m", "init"]);

    // 干净仓库
    const clean = collectGitChanges(repo);
    assert.ok(clean, "git 仓库必须能收集统计");
    assert.equal(clean!.clean, true);
    assert.equal(clean!.files_changed, 0);
    assert.equal(clean!.untracked_files, 0);

    // 未暂存改动：改 a.txt + 新增未跟踪文件 b。
    // 注意 git 的行级 diff 口径：`1 2 3` → `1 X Y 4` 是 **3 增 2 删**（不是「2 增 1 删」——
    // git 会把末尾 `3`→`4` 也算一次替换）。断言写死 git 的真实输出，而不是我脑中的直觉。
    writeFileSync(join(repo, "a.txt"), "1\nX\nY\n4\n", "utf8");
    writeFileSync(join(repo, "b.txt"), "new\n", "utf8");
    const dirty = collectGitChanges(repo);
    assert.equal(dirty!.files_changed, 1, "未暂存改动必须计入");
    assert.equal(dirty!.insertions, 3, "口径来自 `git diff --numstat HEAD` 的真实输出");
    assert.equal(dirty!.deletions, 2);
    assert.equal(dirty!.untracked_files, 1, "未跟踪文件单列（不计入增删行）");
    assert.equal(dirty!.clean, false);

    // 全部暂存：口径是 numstat HEAD ⇒ **仍计入**（已暂存与未暂存一并算）
    run(["add", "-A"]);
    const staged = collectGitChanges(repo);
    assert.equal(staged!.files_changed, 2, "已暂存改动必须计入（numstat HEAD 口径）");
    assert.equal(staged!.untracked_files, 0, "已 add 的文件不再是未跟踪");

    // .gitignore 忽略的文件不计入（它们本来就不会入库）
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n", "utf8");
    writeFileSync(join(repo, "ignored.txt"), "z\n", "utf8");
    run(["add", ".gitignore"]);
    const withIgnore = collectGitChanges(repo);
    assert.equal(withIgnore!.untracked_files, 0, "被 .gitignore 忽略的文件不计入未跟踪");

    // 非 git 目录 ⇒ null（不当作错误）。
    // 必须建在**仓库之外**：本套件沙箱虽被 .gitignore 忽略，仍在工作树内，
    // `git rev-parse --is-inside-work-tree` 对树内任意路径都返回 true（实测：沙箱内返回 5 files）。
    const outside = makeOutsideSandbox("g317-nogit-repo");
    try {
      assert.equal(collectGitChanges(outside.dir), null, "非 git 目录必须返回 null");
    } finally {
      outside.cleanup();
    }
  } finally {
    sb.cleanup();
  }
});

test("g-317 判据4：无变更 ⇒ 继续提交但明确标注；非 git 工作区 ⇒ changes=null 并说明", async () => {
  const sb = makeSandbox("g317-nochange");
  try {
    const { root, workspace } = makeBoard(sb.dir);
    const id = makeInFlightGoal(root, { title: "无变更目标" });
    const clean = {
      repo: workspace,
      branch: "main",
      head: "abc1234",
      files_changed: 0,
      insertions: 0,
      deletions: 0,
      untracked_files: 0,
      clean: true,
    };
    const r = await submitWith(root, { id, changes: () => clean });
    assert.equal(r.changed, true, "无变更不是阻断（判据要求「有明确行为」，这里选：继续提交并标注）");
    assert.ok(
      r.boundaries.some((b) => /无任何改动/.test(b)),
      `无变更必须在边界里明确标注；boundaries=${JSON.stringify(r.boundaries)}`,
    );
    const brief = renderSubmitBrief(r);
    assert.match(brief, /变更统计：已跟踪 0 文件/, "简报必须给出计数");

    // 非 git
    const sb2 = makeSandbox("g317-nogit");
    try {
      const b2 = makeBoard(sb2.dir);
      const id2 = makeInFlightGoal(b2.root, { title: "非 git 目标" });
      const r2 = await submitWith(b2.root, { id: id2, changes: () => null });
      assert.equal(r2.changes, null);
      assert.ok(
        r2.boundaries.some((b) => /不是 git 仓库/.test(b)),
        "非 git 工作区必须在边界里说明（不静默）",
      );
      // 事件里 changes=null（不伪造 0）
      const d = eventsNamed(b2.root, id2, "review.requested")[0].details as Record<string, unknown>;
      assert.equal(d.changes, null);
    } finally {
      sb2.cleanup();
    }
  } finally {
    sb.cleanup();
  }
});

test("g-317 判据4：机器证据摘要只含计数（submitEvidenceSnapshot 的字段白名单）", () => {
  const snap = submitEvidenceSnapshot({
    selfCheck: PASSING(),
    changes: {
      repo: "/r",
      branch: "main",
      head: "abc",
      files_changed: 2,
      insertions: 5,
      deletions: 1,
      untracked_files: 3,
      clean: false,
    },
    verified: true,
  });
  assert.deepEqual(snap.changes, {
    files: 2,
    insertions: 5,
    deletions: 1,
    untracked: 3,
    branch: "main",
    head: "abc",
  });
  assert.equal(snap.verified, true);
  assert.equal(snap.exit_code, 0);
  assert.ok(!("tail" in snap), "摘要里不得有输出尾部");
  assert.ok(!("repo" in (snap.changes as object)), "不把绝对路径写进事件（去本机假设）");
});

// ===========================================================================
// 判据 7：拒绝路径零副作用
// ===========================================================================

test("g-317 判据7：目标不存在 / 损坏 goal.md / 状态不允许 ⇒ 可读非零退出且零副作用", async () => {
  const sb = makeSandbox("g317-reject");
  try {
    const { root } = makeBoard(sb.dir);

    // ① 目标不存在
    let before = snapshotTree(root);
    await assert.rejects(
      () => submitWith(root, { id: "g-999" }),
      (e: unknown) => {
        assert.ok(e instanceof SubmitError);
        assert.equal(e.code, "goal-not-found");
        return true;
      },
    );
    assert.equal(snapshotTree(root), before, "目标不存在必须零副作用");

    // ② 损坏 goal.md：不可解析且原始文本含该 id
    // 目录形态 `goals/<id>/goal.md` 才是 listGoalFiles 的收录口径（`goals/<id>.md` 不被收录 ⇒
    // 那样的夹具根本进不了「损坏」场景，只会表现为「不存在」，是假阴性）。
    const broken = join(root, "goals", "g-broken", "goal.md");
    mkdirSync(join(root, "goals", "g-broken"), { recursive: true });
    writeFileSync(broken, `---\n{ "id": "g-broken", 这不是合法 JSON\n---\n`, "utf8");
    // 确认夹具确实落在「损坏」分支（listGoalFiles 收录 + loadGoal 抛错）
    assert.ok(listGoalFiles(root).includes(broken), "损坏夹具必须被 listGoalFiles 收录（否则不是损坏场景）");
    before = snapshotTree(root);
    await assert.rejects(
      () => submitWith(root, { id: "g-broken" }),
      (e: unknown) => {
        assert.ok(e instanceof SubmitError);
        assert.equal(e.code, "goal-file-corrupt", `损坏必须点名 goal-file-corrupt（不得伪装成不存在）；实际 ${e.code}`);
        assert.match(e.message, /m?-?broken/);
        return true;
      },
    );
    assert.equal(snapshotTree(root), before, "损坏 goal.md 必须零副作用");
    rmSync(join(root, "goals", "g-broken"), { recursive: true, force: true });

    // ③ 状态不允许：draft（未排期）
    const draft = createGoal(root, { title: "草稿目标", actor: "human:test" });
    before = snapshotTree(root);
    await assert.rejects(
      () => submitWith(root, { id: draft }),
      (e: unknown) => {
        assert.ok(e instanceof SubmitError);
        assert.equal(e.code, "state-not-allowed");
        assert.match(e.message, /draft/);
        return true;
      },
    );
    assert.equal(snapshotTree(root), before, "draft 拒绝必须零副作用");

    // ④ 状态不允许：planning（未 claim）
    const planning = makeInFlightGoal(root, { title: "planning 目标", advance: false });
    before = snapshotTree(root);
    await assert.rejects(
      () => submitWith(root, { id: planning }),
      (e: unknown) => {
        assert.ok(e instanceof SubmitError);
        assert.equal(e.code, "state-not-allowed");
        assert.match(e.message, /claim/, "必须提示先 claim");
        return true;
      },
    );
    assert.equal(snapshotTree(root), before, "planning 拒绝必须零副作用");

    // ⑤ blocked：先阻塞一个 in_progress 目标
    const blocked = makeInFlightGoal(root, { title: "阻塞目标" });
    transition(root, blocked, "blocked", { actor: "human:test", reason: "等前置" });
    before = snapshotTree(root);
    await assert.rejects(
      () => submitWith(root, { id: blocked }),
      (e: unknown) => {
        assert.ok(e instanceof SubmitError);
        assert.equal(e.code, "state-not-allowed");
        return true;
      },
    );
    assert.equal(snapshotTree(root), before, "blocked 拒绝必须零副作用");
  } finally {
    sb.cleanup();
  }
});

test("g-317 判据7：非工作区 / 未初始化 / 只读看板 ⇒ 可读非零退出且零副作用（真进程）", () => {
  // 非工作区：仓库**外**的目录（不得在仓库内向上找到真实 .dsh-graph）
  const outside = makeOutsideSandbox("g317-noworkspace");
  try {
    const r = runCliProcess(cliSourceEntry, ["submit"], outside.dir);
    assert.equal(r.code, EXIT_FAILURE, `非工作区必须非零退出；stdout=${r.stdout}`);
    assert.match(r.stderr, /非 dsh-graph 工作区|--root/, "必须给出可操作提示");
    assert.deepEqual(readdirSync(outside.dir), [], "非工作区必须零副作用（连 .dsh-graph 都不建）");
  } finally {
    outside.cleanup();
  }

  const sb = makeSandbox("g317-unwritable");
  try {
    // 未初始化：目录存在但缺 events.jsonl
    const bare = join(sb.dir, "bare");
    mkdirSync(bare, { recursive: true });
    const before = snapshotTree(bare);
    const r = runCliProcess(cliSourceEntry, ["submit", "g-1", "--root", join(bare, ".dsh-graph")], sb.dir);
    assert.notEqual(r.code, 0, "未初始化必须非零退出");
    assert.equal(snapshotTree(bare), before, "未初始化/不存在 root 必须零副作用");

    // 只读看板：chmod 5xx ⇒ board-unwritable，且**连锁文件都不建**
    const { workspace, root } = makeBoard(sb.dir);
    const id = makeInFlightGoal(root);
    chmodSync(root, 0o500);
    let snap: string;
    try {
      snap = snapshotTree(root);
      const ro = runCliProcess(cliSourceEntry, ["submit", id, "--json"], workspace);
      assert.equal(ro.code, EXIT_FAILURE, `只读看板必须非零退出；stdout=${ro.stdout}`);
      const payload = JSON.parse(ro.stdout) as Record<string, any>;
      assert.equal(payload.code, "board-unwritable");
      assert.match(ro.stderr, /只读|不可写/);
    } finally {
      chmodSync(root, 0o755);
    }
    assert.equal(snapshotTree(root), snap!, "只读看板拒绝必须零副作用（含不建 .lock.*）");
    assert.equal(
      readdirSync(root).filter((f) => f.startsWith(".lock.")).length,
      0,
      "只读预检必须先于取锁：不得留下任何锁文件",
    );
    assert.equal(statusOf(root, id), "in_progress");
  } finally {
    sb.cleanup();
  }
});

// ===========================================================================
// 判据 10：--skip-tests 显式降级（默认关闭）
// ===========================================================================

test("g-317 判据10：--skip-tests 默认关闭；显式使用 ⇒ 照常迁移但非零退出 + 大声标「未验证」+ 事件标注 verified=false", () => {
  const sb = makeSandbox("g317-skiptests");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    const id = makeInFlightGoal(root, { title: "跳过自检目标" });
    const r = runCliProcess(cliSourceEntry, ["submit", id, "--skip-tests", "--json"], workspace);
    assert.equal(r.code, EXIT_FAILURE, "未验证提交必须非零退出（绝不伪装成通过）");
    const payload = JSON.parse(r.stdout) as Record<string, any>;
    assert.equal(payload.ok, true, "看板写入本身成功");
    assert.equal(payload.verified, false, "必须标注 verified=false");
    assert.equal(payload.unverified, true);
    assert.equal(payload.self_check.ran, false);
    assert.equal(payload.self_check.verdict, "unverified");
    assert.match(r.stderr, /未验证/, "stderr 必须大声告警「未验证」");
    assert.equal(statusOf(root, id), "review");
    const d = eventsNamed(root, id, "review.requested")[0].details as Record<string, any>;
    assert.equal(d.verified, false, "事件必须记录「未验证」");
    // 人类简报同样标出（换一个**新的在途目标**：上一个已进入 review，再跑同一 id 会走幂等分支）
    const id2 = makeInFlightGoal(root, { title: "跳过自检目标 2" });
    const human = runCliProcess(cliSourceEntry, ["submit", id2, "--skip-tests"], workspace);
    assert.equal(human.code, EXIT_FAILURE, "未验证的人类输出同样必须非零退出");
    assert.match(human.stdout, /未验证/, "人类简报必须标注「未验证」");
    assert.match(human.stderr, /未验证/, "stderr 必须大声告警「未验证」");
    assert.equal(statusOf(root, id2), "review");
    // 幂等命中（已在 review、本次零写入）时也必须告警 —— 「没写入」不等于「已验证」
    const again = runCliProcess(cliSourceEntry, ["submit", id2, "--skip-tests", "--json"], workspace);
    assert.equal(again.code, EXIT_FAILURE);
    assert.equal((JSON.parse(again.stdout) as any).changed, false);
    assert.match(again.stderr, /未验证/, "幂等命中同样必须告警「未验证」");
  } finally {
    sb.cleanup();
  }
});

// ===========================================================================
// 判据 2/5：真进程 + 真实 scripts/run-tests.mjs（耗时；本套件唯一的真实门禁链路）
// ===========================================================================

test("g-317 判据2/5（真实门禁·隔离副本）：submit 经真实门禁脚本成功推进到 review", () => {
  // 为什么用**隔离副本**而不是直接在仓库根跑：在仓库根跑 `submit` 会触发完整门禁，而门禁又跑本套件
  // ⇒ 递归自检（自检里再自检），在 CI 上会指数膨胀甚至超时。故把仓库的 `core/`（源码）+ `scripts/`
  // （真实门禁脚本）+ `prompts/` + 入口复制到沙箱，在**沙箱根**跑 submit，看板用 `--root` 指向沙箱内
  // 的临时板。此时门禁脚本先在沙箱 runner 里训练出来，再把 `core/tests` 换成**一个短小的真实测试文件**
  // —— 既走 run-tests.mjs 的真实判定链（三方交叉校验 + 自证行），又不会递归跑本套件。
  const sb = makeSandbox("g317-real-gate");
  try {
    const mutation = makeMutationSandbox(sb);
    // 真实门禁脚本依赖 `core/tests/fixtures/nested-runner.ts`（唯一实现的 cleanTestEnv 等）
    // ⇒ 隔离副本必须带上该 fixtures 目录，否则 run-tests.mjs 会 ERR_MODULE_NOT_FOUND。
    cpSync(join(repoRoot, "core", "tests", "fixtures"), join(sb.dir, "core", "tests", "fixtures"), {
      recursive: true,
    });
    // 一个真正会跑的测试文件（让 run-tests.mjs 的 tests>0 成立）
    const testsDir = join(sb.dir, "core", "tests");
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(
      join(testsDir, "smoke.test.ts"),
      `import { test } from "node:test";\nimport assert from "node:assert/strict";\n` +
        `test("smoke: 真实门禁里的真实用例", () => { assert.equal(1 + 1, 2); });\n`,
      "utf8",
    );
    const { root } = makeBoard(sb.dir);
    const id = makeInFlightGoal(root, { title: "真实门禁目标" });
    // 在**沙箱根**跑 submit（workspace = sb.dir 含真实 scripts/run-tests.mjs）⇒ 真门禁、真自证行
    const r = runCliProcess(mutation.entry, ["submit", id, "--json"], sb.dir);
    const payload = JSON.parse(r.stdout || "{}") as Record<string, any>;
    assert.equal(
      r.code,
      EXIT_OK,
      `真实门禁全绿时必须退出 0；stderr=${r.stderr} self_check=${JSON.stringify(payload.self_check ?? payload)}`,
    );
    assert.equal(payload.verified, true);
    assert.equal(payload.self_check.exit_code, 0);
    assert.equal(payload.self_check.tests, 1, "真的跑了用例（且只有隔离副本里那一个）");
    assert.equal(payload.self_check.skipped, 0);
    assert.equal(payload.self_check.todo, 0);
    assert.equal(payload.self_check.cancelled, 0);
    assert.match(payload.self_check.command, /scripts\/run-tests\.mjs$/);
    assert.equal(statusOf(root, id), "review");
    // 变更统计：沙箱在仓库外/内均可 —— 只断言结构（null 或数字），不假设 git 状态。
    assert.ok(payload.changes === null || typeof payload.changes.files_changed === "number");
  } finally {
    sb.cleanup();
  }
});

// ===========================================================================
// 判据 5（静态守卫）：不手写 events、不写 goal.md、不绕锁
// ===========================================================================

test("g-317 判据5（静态守卫）：submit 只经 core 的 requestAcceptReview + transition，不手写 events/不写 goal.md", () => {
  const src = readFileSync(join(repoRoot, "core", "cli", "submit.ts"), "utf8");
  assert.match(src, /\brequestAcceptReview\s*\(/, "必须复用 core 的 review.requested 入口");
  assert.match(src, /\btransition\s*\(/, "必须复用 core 的 transition");
  for (const forbidden of [
    /\bappendEvent\s*\(/,
    /\bsaveGoal\s*\(/,
    /\bwriteFileSync\s*\(/,
    /\bmkdirSync\s*\(/,
    /\bcopyFileSync\s*\(/,
    /\brmSync\s*\(/,
  ]) {
    assert.doesNotMatch(src, forbidden, `submit.ts 不得自行写盘（命中 ${forbidden}）`);
  }
  // 不得自己拼 events 行（events.jsonl 只允许被**读**）
  assert.doesNotMatch(src, /events\.jsonl["'`]\s*,\s*\{/, "submit.ts 不得自行拼事件行");
  // 锁必须来自 core 的 transaction.ts
  assert.match(src, /from "\.\.\/transaction\.ts"/, "锁必须来自 core 的 transaction.ts");
  assert.match(src, /\bwithLocalLock\b/, "必须用 core 的锁（不绕锁）");
  // 自检必须是门禁脚本，不得把 node --test 当权威
  assert.match(src, /scripts\/run-tests\.mjs/, "自检必须调用 scripts/run-tests.mjs");
  assert.doesNotMatch(src, /\["--test"\]|"node --test"/, "submit.ts 不得以 node --test 作为自检入口");
  // 不得经 pnpm/npx（会触发 verifyDepsBeforeRun 隐式 install）
  assert.doesNotMatch(src, /\bpnpm\b|\bnpx\b/, "submit.ts 不得调用 pnpm/npx");
});

// ===========================================================================
// 判据 9：反向变异（真源码副本）
// ===========================================================================

test("g-317 判据9（反向变异·真源码副本）：关掉自检阻断 ⇒ 自检失败的目标被错误推进到 review（未变异副本拒绝、变异体放行）", () => {
  const sb = makeSandbox("g317-mut-block");
  try {
    const mutation = makeMutationSandbox(sb);
    // 真实失败形态：只有原因串（无计数）——与 run-tests.mjs 失败时逐字同构。
    const FAILING_GATE =
      `console.log("[run-tests] ✖ 自证失败：整套件自证闸门不达标 —— 有用例被**跳过**（skipped=2）");\n` +
      `process.exitCode = 1;\n`;

    // ---- 前置：未变异副本必须阻断，且看板零副作用 ----
    const preBoard = makeBoard(join(sb.dir, "pre"));
    writeFakeGate(preBoard.workspace, FAILING_GATE);
    const pristine = makeInFlightGoal(preBoard.root, { title: "前置目标" });
    const preSnap = snapshotTree(preBoard.root);
    const pre = runCliProcess(mutation.entry, ["submit", pristine, "--json"], preBoard.workspace);
    assert.equal(pre.code, EXIT_FAILURE, `未变异副本必须阻断；stdout=${pre.stdout}`);
    assert.equal((JSON.parse(pre.stdout) as any).code, "self-check-blocked");
    assert.equal(snapshotTree(preBoard.root), preSnap, "未变异副本零副作用");
    assert.equal(statusOf(preBoard.root, pristine), "in_progress");

    // ---- 变异：关掉阻断（evaluateSelfCheck 恒返回 pass）----
    mutateSource(
      mutation.file("core/cli/submit.ts"),
      'return { verdict: unique.length === 0 ? "pass" : "blocked", reasons: unique, counts };',
      'return { verdict: "pass", reasons: unique, counts };',
    );

    const mutBoard = makeBoard(join(sb.dir, "mut"));
    writeFakeGate(mutBoard.workspace, FAILING_GATE);
    const id = makeInFlightGoal(mutBoard.root, { title: "变异目标" });
    const r = runCliProcess(mutation.entry, ["submit", id, "--json"], mutBoard.workspace);

    // ⇒ 上面「自检阻断必须非零退出 + 零副作用 + 状态不变」的断言在变异体上必然失败：
    //   这里断言变异体**放行**（这就证明那组断言有辨识力）。若变异体反而拒绝，说明变异没落到位。
    assert.equal(r.code, EXIT_OK, `变异体必须把自检失败放行（否则本对照不成立）；stderr=${r.stderr}`);
    assert.equal((JSON.parse(r.stdout) as any).verified, true, "变异体把失败标成 verified=true");
    assert.equal(statusOf(mutBoard.root, id), "review", "变异体把自检失败的目标推进到了 review");
  } finally {
    sb.cleanup();
  }
});

test("g-317 判据9（反向变异·真源码副本）：吞掉退出码/计数核对 ⇒ 退出码 0 但 skipped=2 的伪绿被误判通过", () => {
  const sb = makeSandbox("g317-mut-exitcode");
  try {
    const mutation = makeMutationSandbox(sb);
    // 门禁：自证行里 skipped=2（伪绿）但**退出码为 0**（模拟「只看退出码」的坏实现所面对的最坏输入）
    const FAKE_GREEN_GATE =
      `console.log("[run-tests] ✔ 自证通过：tests=10 (>0) skipped=2 fail=0 cancelled=0 todo=0 pass=8 exit=0 ms=5 g");\n`;

    // ---- 前置：未变异副本必须因 skipped=2 阻断（它核计数，不只看退出码）----
    const preBoard = makeBoard(join(sb.dir, "pre"));
    writeFakeGate(preBoard.workspace, FAKE_GREEN_GATE);
    const preId = makeInFlightGoal(preBoard.root, { title: "前置目标" });
    const pre = runCliProcess(mutation.entry, ["submit", preId, "--json"], preBoard.workspace);
    assert.equal(pre.code, EXIT_FAILURE, `未变异副本必须因 skipped=2 阻断；stdout=${pre.stdout}`);
    assert.match((JSON.parse(pre.stdout) as any).self_check.reasons.join("；"), /skip 用例 2 条/);
    assert.equal(statusOf(preBoard.root, preId), "in_progress", "未变异副本状态不变");

    // ---- 变异：吞掉退出码判定 + 吞掉 skipped 判定（= 「只看退出码」的坏实现形态）----
    mutateSource(
      mutation.file("core/cli/submit.ts"),
      "  if (run.exitCode !== 0) {",
      "  if (false as boolean) {",
    );
    mutateSource(
      mutation.file("core/cli/submit.ts"),
      '      if (v > 0) reasons.push(`伪绿：${label} 用例 ${v} 条（非 0 即不可信）`);\n    }\n    if (run.exitCode === 0 && counts.fail > 0) {',
      '    }\n    if (false as boolean) {',
    );

    const mutBoard = makeBoard(join(sb.dir, "mut"));
    writeFakeGate(mutBoard.workspace, FAKE_GREEN_GATE);
    const id = makeInFlightGoal(mutBoard.root, { title: "变异目标" });
    const r = runCliProcess(mutation.entry, ["submit", id, "--json"], mutBoard.workspace);

    // ⇒ 「伪绿必须阻断」的断言在变异体上必然失败：断言变异体放行以证明其辨识力。
    assert.equal(r.code, EXIT_OK, `变异体必须把伪绿放行（否则本对照不成立）；stderr=${r.stderr} stdout=${r.stdout}`);
    const payload = JSON.parse(r.stdout) as Record<string, any>;
    assert.equal(payload.verified, true, "变异体把 skipped=2 的伪绿标成 verified=true");
    assert.equal(payload.self_check.skipped, 2, "变异体确实看到了 skipped=2（只是没据此阻断）");
    assert.equal(statusOf(mutBoard.root, id), "review", "变异体把伪绿目标推进到了 review");
  } finally {
    sb.cleanup();
  }
});

// ===========================================================================
// 判据 2（端到端）：**真实** scripts/run-tests.mjs + test.skip 套件 ⇒ 原因含 skipped
// ===========================================================================

test("g-317 判据2（端到端·真门禁）：真实 run-tests.mjs 遇 test.skip ⇒ submit 阻断且原因点名 skipped（不再误报「未解析到自证行」）", () => {
  const sb = makeSandbox("g317-gate-real-skip");
  try {
    // 真源码副本（core/ + prompts/ + scripts/ + bin/）：门禁是**真的** scripts/run-tests.mjs，
    // 不是桩。唯一非真实的部分是被收集的套件 —— 按 TEST_GLOB 约定只放一个含 test.skip 的用例文件。
    const mutation = makeMutationSandbox(sb);
    const { workspace, root } = makeBoard(sb.dir);
    mkdirSync(join(workspace, "core", "tests"), { recursive: true });
    // fixtures/ 是 run-tests.mjs 的嵌套 runner helper 依赖（缺失会让门禁 import 失败而非判 skipped）。
    cpSync(join(repoRoot, "core", "tests", "fixtures"), join(workspace, "core", "tests", "fixtures"), {
      recursive: true,
    });
    writeFileSync(
      join(workspace, "core", "tests", "e2e-skip.test.ts"),
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'test("这条会通过", () => { assert.equal(1, 1); });',
        'test.skip("这条被跳过（模拟真实开发中的暂时禁用）", () => { assert.equal(1, 1); });',
        "",
      ].join("\n"),
      "utf8",
    );

    const id = makeInFlightGoal(root, { title: "真门禁跳过目标" });
    const before = snapshotTree(root);

    // 真进程跑真门禁：TMPDIR 必须在仓库外（门禁的事件通道写 TMPDIR，仓库内会污染工作树）。
    const r = runCliProcess(mutation.entry, ["submit", id, "--json"], workspace, { TMPDIR: "/tmp" });

    assert.equal(r.code, EXIT_FAILURE, `真门禁含 skip 必须非零退出；stdout=${r.stdout} stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout) as Record<string, any>;
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "self-check-blocked", "必须是自检阻断");

    const reasons: string[] = payload.self_check.reasons;
    // ① 必须点名「跳过」语义（评审验收的核心）：门禁自己的原因串被转述出来。
    assert.ok(
      reasons.some((x) => /跳过/.test(x) && /skipped=1/.test(x)),
      `原因必须点名真实故障（含「跳过」且带 skipped=1）；实际 reasons=${JSON.stringify(reasons)}`,
    );
    // ② 回归：有失败自证行时**不得**报「未解析到自证行」（旧实现把「有用例被跳过」误述成「测试未运行」）。
    assert.ok(
      !reasons.some((x) => /未解析到自检自证行/.test(x)),
      `不得误报「未解析到自证行」；实际 reasons=${JSON.stringify(reasons)}`,
    );
    // ③ 退出码被如实转述（阻断线不变）。
    assert.ok(
      reasons.some((x) => /退出码 1/.test(x)),
      `必须点名门禁退出码；实际 reasons=${JSON.stringify(reasons)}`,
    );
    // ④ 阻断时看板零改动。
    assert.equal(snapshotTree(root), before, "自检阻断时看板必须零改动（状态与事件）");
    assert.equal(statusOf(root, id), "in_progress", "状态不得变化");
  } finally {
    sb.cleanup();
  }
});
