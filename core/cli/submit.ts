/**
 * dsh-graph submit（g-317）：跑项目自检并取得**可信**结论，收集 Git 变更统计，然后把目标
 * 经 core 状态机推进到 `review` 并写入 `review.requested` —— 一条命令完成「机器化交接」。
 *
 * 沿用 claim（g-316）已确立的写命令纪律，不另发明：
 * - **只读预检先于取锁**（取锁会创建 `.lock.*`，那已经是一次写）；
 * - 锁内**重读**目标即 CLI 侧 CAS（`withLocalLock(.lock.submit-<id>)`，锁内 status 是权威当前值）；
 * - 状态迁移与事件**只经 core**：`transition`（状态机校验 + `commitPrepared` 事件先行）与
 *   `requestAcceptReview`（既有 `review.requested` 入口，`details` 为 targetStage/what/snapshot，
 *   snapshot 已截断 200 字）。本模块**不拼 events 行、不写 goal.md、不绕过锁**。
 *
 * ── 自检为什么必须用 run-tests.mjs 的退出码（判据 2，本目标最关键的点）───────────────────
 * 项目 `scripts.test` 是 `node --test core/tests/*.test.ts`，它**无法区分伪绿**：注入
 * `NODE_TEST_CONTEXT` 时 `node --test` 会静默 skip 全部文件并 `exit 0`；被取消/跳过/待办用例
 * 也只计入 `cancelled`/`skipped`/`todo` 而非 `fail`。因此 submit **从不**把 `node --test` 的原始
 * 退出码当权威，而是跑 `node scripts/run-tests.mjs`（含三方交叉校验与 `tests>0` 自证），
 * **只看它的退出码**；并额外把门禁自己打印的失败原因行转述进阻断原因。
 *
 * 门禁的两种自证行**形态不同**，转述时不可混为一谈：
 * - 通过：`[run-tests] ✔ 自证通过：tests=… (>0) skipped=… fail=… cancelled=… todo=… pass=… exit=0 …`（**带计数**）；
 * - 失败：`[run-tests] ✖ 自证失败：<原因串>`（**只有原因，没有计数**），例如
 *   `✖ 自证失败：整套件自证闸门不达标 —— 有用例被**跳过**（skipped=1）`。
 * 故阻断原因取自失败行的原因串（{@link parseSelfCheckFailureReason}），而不是从失败行解析计数 ——
 * 失败行上恒无计数，按计数判定会落到「未解析到自证行」，把「有用例被跳过」误述成「测试未运行」。
 *
 * 阻断线（任一条即阻断，判据 2/3）：退出码非 0、退出码非 0 但**未给出**原因、退出码非 0 且失败行带计数时
 * skipped/todo/cancelled 非 0、退出码 0 时没有自证行（空选集/未运行）、`tests === 0`、计数自相矛盾。
 *
 * ── 长文本零污染（判据 6）─────────────────────────────────────────────────────────────────
 * 测试输出与 diff 全文**绝不**进 events.jsonl 或看板字段：进程内只保留 stdout/stderr 的**尾部**
 * 若干行（≤ 400 字符）供人读简报使用，`--json` 只给计数、退出码与耗时；事件只带机器证据的
 * **计数摘要**（见 {@link submitEvidenceSnapshot}）。
 *
 * ── 零副作用与「失败但已提交」的一致性（判据 3/7）─────────────────────────────────────────
 * 所有拒绝判定（目标不存在、损坏 goal.md、非工作区、只读目录、参数、自检阻断）都在**任何写入之前**
 * 完成 —— 注意自检本身会跑测试（可能写临时文件），但判据要求的「零副作用」指的是**看板的状态与
 * 事件零改动**：自检与 Git 统计全在锁外完成，未通过即返回，一步都不写看板。
 *
 * 自检通过后取锁并在锁内重读：若目标已被另一路 submit 推进到 `review` ⇒ 幂等命中，**不再执行
 * 迁移、不再写 `review.requested`**（重跑一次自检以如实回报当前证据，但零写入；理由见
 * {@link submitGoal} 的注释 —— 不能让一份永久失败的测试把「已提交」变成永远无法重复确认）。
 *
 * 半迁移（判据 5）：`review.requested` 先行、`goal.transition` 后行；任一步失败都不再继续，
 * 且如实区分「事件已落盘、状态未变」与「事件未落盘、状态未变」。
 */
import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, join, relative, resolve } from "node:path";
import {
  findGoalFile,
  listGoalFiles,
  loadGoal,
  requestAcceptReview,
  transition,
} from "../ops.ts";
import type { GoalDoc } from "../domain/model.ts";
import { TxError, withLocalLock } from "../transaction.ts";
import { isScratchWorkspace } from "../root.ts";

/** submit 的可判定失败（`code` 供测试稳定断言，`message` 面向人类可读）。 */
export type SubmitProblemCode =
  | "usage"
  | "goal-not-found"
  | "goal-file-corrupt"
  | "goal-archived"
  | "goal-ambiguous"
  | "goal-none-in-flight"
  | "state-not-allowed"
  | "self-check-not-found"
  | "self-check-blocked"
  | "self-check-unverified"
  | "git-failed"
  | "board-unwritable"
  | "submit-lock-busy"
  | "review-request-failed"
  | "transition-event-failed"
  | "transition-persist-failed"
  | "transition-failed"
  | "no-changes";

/** 拒绝/失败：一律非零退出；除「持久化阶段」与「审查请求已落盘」两种固有余量外，**零写入**。 */
export class SubmitError extends Error {
  readonly code: SubmitProblemCode;
  /** 事件先行语义下 `review.requested` 可能已落盘（仅 review-request/tx.persist 阶段的余量）。 */
  readonly eventsWritten: boolean;
  /** `--json` 时随错误一并输出的结构化字段（如 `tests` / `changes`），便于脚本处理。 */
  readonly data: Record<string, unknown>;
  constructor(
    code: SubmitProblemCode,
    message: string,
    opts: { eventsWritten?: boolean; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "SubmitError";
    this.code = code;
    this.eventsWritten = opts.eventsWritten ?? false;
    this.data = opts.data ?? {};
  }
}

/** 等待提交锁的上限（ms）：与 claim 同口径的「短临界区 + 快速失败」。 */
export const SUBMIT_LOCK_TIMEOUT_MS = 1500;

/** 自检的硬超时（ms，默认 60 分钟）。超时 = 阻断（绝不把「跑不完」当成通过）。 */
export const SUBMIT_TEST_TIMEOUT_MS = 60 * 60 * 1000;

/** 默认自检命令（项目专属门禁；可由调用方显式覆盖，供测试与其它仓库使用）。 */
export const DEFAULT_SELF_CHECK_COMMAND: readonly string[] = ["scripts/run-tests.mjs"];

/** 提交锁名（按目标隔离）：同一目标的 submit 串行化，不同目标互不阻塞。 */
export function submitLockName(goalId: string): string {
  return `submit-${goalId}`;
}

/** 状态机的入边（进入 review 的合法来源；与 `core/domain/machine.ts` 的 EDGES 同口径）。 */
const ENTERS_REVIEW = new Set(["in_progress"]);

/**
 * 「在途目标」的唯一口径：状态为 `in_progress` 的目标。
 *
 * 为什么只取 in_progress（而不含 review）：重复 submit 一个已在 `review` 的目标必须是
 * **幂等、明确、零写入**的成功（判据 8），而「从在途目标推断」的语义是把**当前正在做的那一个**
 * 交出去。若把 review 也算在途，review 目标会与真正在做的那一个并列 ⇒ 推断必然歧义，
 * 幂等重跑一个不带 goal-id 的 submit 就再也不可能成功。`--json` 的 `in_flight` 字段同此口径。
 */
const IN_FLIGHT_STATUS = "in_progress";

/** 幂等重放候选的口径（见 {@link resolveGoalId}）：仅在**没有**在途目标时用作推断。 */
const IN_REVIEW_STATUS = "review";

/** 一次自检的结论（机器可读；**只有计数与退出码，没有测试输出正文**）。 */
export interface SelfCheckReport {
  /** 是否执行了自检（`--skip-tests` 时为 false）。 */
  ran: boolean;
  /** 实际执行的命令（相对仓库根）。 */
  command: string;
  /** 门禁的真实退出码；未运行或被杀为 null。 */
  exit_code: number | null;
  /** 信号（超时被杀等），无则 null。 */
  signal: string | null;
  duration_ms: number;
  /** 从门禁「自证行」解析出的计数（未解析到为 null）。 */
  tests: number | null;
  pass: number | null;
  fail: number | null;
  skipped: number | null;
  todo: number | null;
  cancelled: number | null;
  /** 结论：`pass` 可信通过 / `blocked` 阻断 / `unverified` 跳过自检 / `not-run` 未执行。 */
  verdict: "pass" | "blocked" | "unverified" | "not-run";
  /** 阻断原因（短行、可操作；仅 verdict=blocked 时非空）。 */
  reasons: string[];
  /**
   * 输出尾部（≤ {@link SELF_CHECK_TAIL_CHARS} 字符），**仅供人类可读简报**：
   * 绝不写入事件、绝不进 `--json`、绝不进看板字段。
   */
  tail: string;
}

/** 工作区变更统计（口径见 {@link collectGitChanges} 的文档与 `docs/dsh-graph-guide.md`）。 */
export interface ChangeStats {
  /** 工作区根（git 仓库根）绝对路径。 */
  repo: string;
  /** 当前分支（分离 HEAD 时为 `HEAD`）。 */
  branch: string;
  /** 基线 commit（HEAD 短 sha）。 */
  head: string;
  /** 已跟踪文件（含已暂存）的变更文件数：`git diff --numstat HEAD` 的行数。 */
  files_changed: number;
  /** 已跟踪文件的插入行数。 */
  insertions: number;
  /** 已跟踪文件的删除行数。 */
  deletions: number;
  /** 未跟踪文件数（`git ls-files --others --exclude-standard`；**不计入**增删行）。 */
  untracked_files: number;
  /** 是否 `git status --porcelain` 为空。 */
  clean: boolean;
}

/** submit 的完整结果（`--json` = 此结构的机器可读形态）。 */
export interface SubmitResult {
  goal: {
    id: string;
    title: string;
    type: string;
    version: string | null;
    status: string;
    file: string;
  };
  /** 本次是否真的发生迁移（false = 幂等命中，零写入）。 */
  changed: boolean;
  from: string;
  to: string;
  /** 目标 id 是否由「唯一在途目标」推断而来。 */
  inferred: boolean;
  /** 自检结论（**未验证**时 verdict=unverified，且 `verified=false`）。 */
  self_check: SelfCheckReport;
  /** 自检结论是否可信（verdict==="pass"）。降级提交时为 false。 */
  verified: boolean;
  /** Git 变更统计（非 git 工作区为 null，并在 `reasons` 里说明）。 */
  changes: ChangeStats | null;
  /** 本次写入的事件类型（顺序即写入顺序：`review.requested` 先于 `goal.transition`）。 */
  events: string[];
  /** 其它需要人类知道的边界提示（短行）。 */
  boundaries: string[];
  /** 看板根与仓库根（便于脚本定位）。 */
  root: string;
  /** 未验证/降级提交时为 true：调用方必须把「未验证」当真看待。 */
  unverified: boolean;
}

/** 输出尾部最大字符数（人类简报用；不落盘、不进事件）。 */
export const SELF_CHECK_TAIL_CHARS = 400;

/** 目录是否可写（`access(W_OK)`：只问权限，不落任何字节）。 */
function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 归档目标判定（与 core `isArchivedFile` 同口径：路径含 archived 段）。 */
function isArchivedRel(rel: string): boolean {
  return rel.includes("/archived/") || rel.includes("\\archived\\");
}

/**
 * 损坏的目标文件：`findGoalFile` **静默跳过**解析失败的文件（那是 validate 的职责），
 * 于是「goal.md 损坏」会伪装成「目标不存在」。这里先枚举拿到「确实存在但不可解析」的文件，
 * 并按 id 字面量在原始文本中的出现精确归属；只读、零副作用。（与 claim 同一诊断，不另立口径。）
 */
export function findCorruptGoalFiles(root: string, id: string): string[] {
  const out: string[] = [];
  for (const file of listGoalFiles(root, { includeArchived: true })) {
    try {
      loadGoal(file);
      continue; // 可解析：不是损坏候选（其 id 归属由 findGoalFile 负责）
    } catch {
      /* 不可解析 ⇒ 候选 */
    }
    try {
      // 只能在**原始文本**里找 id：损坏的正是解析路径，不能经 loadGoal 取 meta。
      if (readFileSync(file, "utf8").includes(id)) out.push(file);
    } catch {
      /* 读不到（EACCES 等）：不猜，交给 findGoalFile 的「目标不存在」口径 */
    }
  }
  return out;
}

/** 在途目标（只读；口径见 {@link IN_FLIGHT_STATUS}）。损坏的目标文件不致命但会作为 problem 报出。 */
export function listSubmitCandidates(root: string): {
  /** 状态为 `in_progress` 或 `review` 的目标（推断候选；调用方按状态选择）。 */
  goals: Array<{ id: string; title: string; file: string; status: string }>;
  problems: string[];
} {
  const goals: Array<{ id: string; title: string; file: string; status: string }> = [];
  const problems: string[] = [];
  for (const file of listGoalFiles(root)) {
    try {
      const doc = loadGoal(file);
      const meta = doc.meta ?? {};
      const status = String(meta.status ?? "");
      // 只枚举两种候选状态：in_progress（正常提交）与 review（幂等重放）——
      // 其余状态（draft/planning/collecting/ready/blocked/delivered）不参与推断。
      if (status !== IN_FLIGHT_STATUS && status !== IN_REVIEW_STATUS) continue;
      goals.push({
        id: String(meta.id ?? ""),
        title: String(meta.title ?? ""),
        file: relative(root, file),
        status,
      });
    } catch (e) {
      problems.push(`目标文件不可解析：${relative(root, file)}（${(e as Error).message}）`);
    }
  }
  goals.sort((a, b) => a.id.localeCompare(b.id));
  return { goals, problems };
}

// ---------------------------------------------------------------------------
// 自检（判据 2）
// ---------------------------------------------------------------------------

/**
 * 门禁失败行里「`✖ 自证失败：`」之后的**原因串**（run-tests.mjs 失败时打印的正是这一句）。
 *
 * 真实形态：`[run-tests] ✖ 自证失败：整套件自证闸门不达标 —— 有用例被**跳过**（skipped=1）`
 * —— **不含** `tests=` 等计数字段（计数只在成功行 `✔ 自证通过：tests=… skipped=…` 里）。
 * 故失败原因**不能**靠 {@link parseSelfCheckCounts} 得到，必须直接摘这一句。
 *
 * 返回 null 表示输出里**根本没有**失败自证行（测试未运行 / 空选集 / 输出被截断）。
 */
export function parseSelfCheckFailureReason(text: string): string | null {
  // 只认 `[run-tests]` 前缀 + `✖ 自证失败`：测试自己打印的同名文本没有前缀，伪造不进来。
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("[run-tests]") && l.includes("✖ 自证失败"));
  if (lines.length === 0) return null;
  const line = lines[lines.length - 1];
  // 取最后一个 `自证失败` 之后的全部文本（`：`/`:` 分隔符可选），再去掉 `[run-tests]` 前缀。
  const idx = line.lastIndexOf("自证失败");
  const rest = line.slice(idx + "自证失败".length).replace(/^\s*[：:]?\s*/, "").trim();
  return rest.length > 0 ? rest : "门禁报告自证失败，但未给出原因串";
}

/** 从门禁的**自证行**里解析计数（run-tests.mjs 的 `[run-tests] ✔ 自证通过：tests=… skipped=… …`）。 */
export function parseSelfCheckCounts(text: string): {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
  todo: number;
  cancelled: number;
} | null {
  // 只认自证行（`[run-tests]` 前缀 + 「自证通过」/「自证失败」），不认测试自己打印的 `ℹ tests …`
  // —— 那正是可伪造通道（run-tests.mjs 为此才用带类型事件通道做权威计数）。
  const lines = text.split("\n").filter((l) => l.includes("[run-tests]") && /自证(通过|失败)/.test(l));
  if (lines.length === 0) return null;
  const line = lines[lines.length - 1];
  const num = (key: string): number | null => {
    const m = new RegExp(`${key}=(-?\\d+)`).exec(line);
    return m ? Number(m[1]) : null;
  };
  const tests = num("tests");
  if (tests === null) return null;
  return {
    tests,
    pass: num("pass") ?? 0,
    fail: num("fail") ?? 0,
    skipped: num("skipped") ?? 0,
    todo: num("todo") ?? 0,
    cancelled: num("cancelled") ?? 0,
  };
}

/** 输出尾部：只留最后若干行且截断到 {@link SELF_CHECK_TAIL_CHARS}（人类简报用）。 */
function tailOf(stdout: string, stderr: string): string {
  const all = `${stdout}\n${stderr}`.trimEnd();
  if (all.length <= SELF_CHECK_TAIL_CHARS) return all;
  const clipped = all.slice(-SELF_CHECK_TAIL_CHARS);
  const nl = clipped.indexOf("\n");
  return nl >= 0 ? clipped.slice(nl + 1) : clipped;
}

/**
 * 判定一次自检运行是否**可信通过**（纯函数：便于穷举边界与反向变异对照）。
 *
 * 阻断线（判据 2）：退出码非 0；退出码非 0 却解析不到原因（自证不足）；输出点名
 * skipped/todo/cancelled；解析不到自证行（空选集/未运行）；`tests === 0`。
 */
export function evaluateSelfCheck(run: {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}): { verdict: "pass" | "blocked"; reasons: string[]; counts: ReturnType<typeof parseSelfCheckCounts> } {
  const reasons: string[] = [];
  const combined = `${run.stdout}\n${run.stderr}`;
  const counts = parseSelfCheckCounts(combined);
  // 门禁失败时打印的是 `✖ 自证失败：<原因串>`（**无计数**）；只有它才知道「为什么红」。
  const failureReason = parseSelfCheckFailureReason(combined);

  if (run.exitCode !== 0) {
    reasons.push(
      run.exitCode === null
        ? `自检被信号终止（signal=${run.signal ?? "未知"}）——不得视为通过`
        : `自检门禁退出码 ${run.exitCode}（非 0）`,
    );
    // 原因必须来自门禁自己那一句：真实形态只有原因串、没有计数，
    // 所以绝不能靠 parseSelfCheckCounts（它在失败行上恒为 null —— 旧实现据此形成了一个永不进入的死分支，
    // 结果把「有用例被跳过（skipped=1）」误述成「测试未运行」）。
    if (failureReason !== null) {
      reasons.push(`门禁原因：${failureReason}`);
    }
    // 防御：若某实现（或人工粘贴）把**带计数的成功行**用于失败场景，计数仍必须参与判定，
    // 不得因「退出码已非 0」就忽略 skip/todo/cancelled（阻断线只增不减）。
    if (counts) {
      for (const [key, label] of [
        ["skipped", "skip"],
        ["todo", "todo"],
        ["cancelled", "cancelled"],
      ] as const) {
        const v = counts[`${key}` as "skipped" | "todo" | "cancelled"];
        if (v > 0) reasons.push(`伪绿：${label} 用例 ${v} 条（非 0 即不可信）`);
      }
      if (counts.fail === 0 && counts.tests > 0) {
        reasons.push("退出码非 0 但 fail=0 —— 门禁判的不是「失败数」，必须人工排查");
      }
    }
  }
  // 「完全没有自证行」才报「未解析到」：失败行**存在**（只是没有计数）时不报这一句，
  // 否则会把「有用例被跳过」误述成「测试未运行」（评审 BLOCK 的正是这一点）。
  if (run.exitCode === 0 && !counts) {
    reasons.push("未解析到自检自证行（测试未运行 / 空选集 / 输出被截断）——不得视为通过");
  } else if (counts) {
    if (counts.tests === 0) reasons.push("tests=0（空选集）——没有跑任何用例，不得视为通过");
    for (const [key, label] of [
      ["skipped", "skip"],
      ["todo", "todo"],
      ["cancelled", "cancelled"],
    ] as const) {
      const v = counts[`${key}` as "skipped" | "todo" | "cancelled"];
      if (v > 0) reasons.push(`伪绿：${label} 用例 ${v} 条（非 0 即不可信）`);
    }
    if (run.exitCode === 0 && counts.fail > 0) {
      reasons.push(`退出码为 0 但 fail=${counts.fail} —— 计数自相矛盾，不得视为通过`);
    }
  }
  // 去重（同一原因可能从两条判定线各命中一次），保持顺序。
  const unique = [...new Set(reasons)];
  return { verdict: unique.length === 0 ? "pass" : "blocked", reasons: unique, counts };
}

/**
 * 运行自检门禁（**唯一**权威：`node scripts/run-tests.mjs`，不是 `node --test`）。
 *
 * 只取门禁退出码作权威；无 shell（argv 形态，跨平台）。**不经包管理器的脚本运行入口**：
 * 它的 `verifyDepsBeforeRun` 会在依赖不新鲜时隐式 install 并触发构建，是 AGENTS.md 的明令禁项。
 */
export async function runSelfCheck(params: {
  cwd: string;
  command?: readonly string[];
  timeoutMs?: number;
}): Promise<SelfCheckReport> {
  const command = [...(params.command ?? DEFAULT_SELF_CHECK_COMMAND)];
  const timeout = params.timeoutMs ?? SUBMIT_TEST_TIMEOUT_MS;
  const started = Date.now();
  const commandText = `${basename(process.execPath)} ${command.join(" ")}`;
  const res = await new Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }>(
    (done) => {
      const child = spawn(process.execPath, command, {
        cwd: params.cwd,
        env: cleanChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done({ stdout, stderr, code, signal });
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 进程可能已退出 */
        }
        finish(null, "SIGKILL(timeout)");
      }, timeout);
      child.stdout?.on("data", (d) => {
        // 只保留尾部：长输出不得在内存里无界增长，更不得落进看板。
        stdout = (stdout + String(d)).slice(-64_000);
      });
      child.stderr?.on("data", (d) => {
        stderr = (stderr + String(d)).slice(-64_000);
      });
      child.on("error", (e) => {
        stderr += `\n${(e as Error).message}`;
        finish(null, "spawn-error");
      });
      child.on("close", (code, signal) => finish(code, signal ?? null));
    },
  );
  const verdict = evaluateSelfCheck({
    exitCode: res.code,
    signal: res.signal,
    stdout: res.stdout,
    stderr: res.stderr,
  });
  return {
    ran: true,
    command: commandText,
    exit_code: res.code,
    signal: res.signal,
    duration_ms: Date.now() - started,
    ...(verdict.counts ?? {
      tests: null,
      pass: null,
      fail: null,
      skipped: null,
      todo: null,
      cancelled: null,
    }),
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    tail: tailOf(res.stdout, res.stderr),
  };
}

/** 子进程环境：摘除测试注入变量（父进程若在 `node --test` 里，子门禁会被静默 skip 成 exit 0）。 */
function cleanChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // run-tests.mjs 自己也会摘除，但若父进程带着 NODE_OPTIONS 选集开关，子门禁会 fail-closed 拒绝；
  // 这里只在**父进程处于测试上下文**时清理，保持正常 shell 用法下用户环境原样传递。
  if (env.NODE_TEST_CONTEXT !== undefined || env.NODE_TEST_WORKER_ID !== undefined) {
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Git 变更统计（判据 4）
// ---------------------------------------------------------------------------

/**
 * 收集 Git 变更统计（判据 4）。**口径写死在实现与文档里，两处必须一致**：
 *
 * - `files_changed` / `insertions` / `deletions` 全部取自 `git diff --numstat HEAD`：
 *   `HEAD` 是提交点，因此**已暂存与未暂存的改动一并计入**、且**不含**未跟踪文件
 *   （它对 HEAD 没有 diff）；
 * - `untracked_files` 取自 `git ls-files --others --exclude-standard`（已被 `.gitignore`
 *   忽略的文件不计入 —— 它们本来就不是会入库的改动）；
 * - 二进制文件在 `--numstat` 里是 `-\t-`，按 0 行计入（文件仍计 1 个）；
 * - `clean` 取 `git status --porcelain` 为空（即两种改动都没有）。
 *
 * 非 git 工作区（或 scratch 工作区）返回 null，**不**当作错误 —— 由调用方在边界里说明。
 */
export function collectGitChanges(workspace: string): ChangeStats | null {
  const git = (args: string[]): { code: number | null; out: string } => {
    const r = spawnSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: r.status, out: r.stdout ?? "" };
  };
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out.trim() !== "true") return null;
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || top.out.trim() === "") return null;
  const head = git(["rev-parse", "--short", "HEAD"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const numstat = git(["diff", "--numstat", "HEAD"]);
  if (numstat.code !== 0) return null;
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.out.split("\n")) {
    if (line.trim() === "") continue;
    const [add, del] = line.split("\t");
    filesChanged++;
    if (/^\d+$/.test(add ?? "")) insertions += Number(add);
    if (/^\d+$/.test(del ?? "")) deletions += Number(del);
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  if (untracked.code !== 0) return null;
  const untrackedCount = untracked.out.split("\n").filter((l) => l.trim() !== "").length;
  const porcelain = git(["status", "--porcelain"]);
  if (porcelain.code !== 0) return null;
  return {
    repo: resolve(top.out.trim()),
    branch: branch.code === 0 ? branch.out.trim() : "HEAD",
    head: head.code === 0 ? head.out.trim() : "",
    files_changed: filesChanged,
    insertions,
    deletions,
    untracked_files: untrackedCount,
    clean: porcelain.out.trim() === "",
  };
}

/**
 * 事件里携带的机器证据摘要（判据 4/6）：**只有计数**，没有测试输出、没有 diff 全文。
 * 作为 `review.requested` 事件的附加字段写入（既有字段 targetStage/what/snapshot 原样保留）。
 */
export function submitEvidenceSnapshot(params: {
  selfCheck: SelfCheckReport;
  changes: ChangeStats | null;
  verified: boolean;
}): Record<string, unknown> {
  const s = params.selfCheck;
  return {
    // 门禁标识（命令与退出码）—— 证明结论来自 run-tests.mjs 而非 node --test。
    command: s.command,
    exit_code: s.exit_code,
    verified: params.verified,
    tests: s.tests,
    pass: s.pass,
    fail: s.fail,
    skipped: s.skipped,
    todo: s.todo,
    cancelled: s.cancelled,
    changes: params.changes
      ? {
          files: params.changes.files_changed,
          insertions: params.changes.insertions,
          deletions: params.changes.deletions,
          untracked: params.changes.untracked_files,
          branch: params.changes.branch,
          head: params.changes.head,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// 主流程（判据 3/5/7/8）
// ---------------------------------------------------------------------------

/** 解析目标 id：显式给出就用它；否则从「唯一在途目标」推断（多个/没有 ⇒ 报错列候选，不猜）。 */
function resolveGoalId(root: string, explicit: string | null): { id: string; inferred: boolean } {
  if (explicit !== null) return { id: explicit, inferred: false };
  const { goals: candidates, problems } = listSubmitCandidates(root);
  if (problems.length > 0) {
    throw new SubmitError(
      "goal-file-corrupt",
      `无法枚举在途目标（存在不可解析的目标文件）：${problems.slice(0, 3).join("；")} —— 请先修复后再 submit`,
    );
  }
  const goals = candidates.filter((g) => g.status === IN_FLIGHT_STATUS);
  if (goals.length === 1) return { id: goals[0].id, inferred: true };
  if (goals.length > 1) {
    const listed = goals.map((g) => `  - ${g.id}\t${g.title}`).join("\n");
    throw new SubmitError(
      "goal-ambiguous",
      `有 ${goals.length} 个在途目标，无法推断要提交哪一个（不猜）——请显式给出目标 ID：\n${listed}`,
    );
  }
  // 没有 in_progress 目标：若「已在 review」的目标**恰好一个**，把它当作幂等重放的候选
  // （否则「刚提交完再跑一次不带 id 的 submit」会报「没有在途目标」，与判据 8 的幂等语义冲突）。
  // 多个 review 目标时依旧不猜 —— 列候选让用户挑。
  const alreadyReview = candidates.filter((g) => g.status === IN_REVIEW_STATUS);
  if (alreadyReview.length === 1) return { id: alreadyReview[0].id, inferred: true };
  if (alreadyReview.length > 1) {
    const listed = alreadyReview.map((g) => `  - ${g.id}\t${g.title}（已在 review）`).join("\n");
    throw new SubmitError(
      "goal-ambiguous",
      `没有在途目标，但有 ${alreadyReview.length} 个目标已在 review，无法推断要重复提交哪一个（不猜）——` +
        `请显式给出目标 ID：\n${listed}`,
    );
  }
  throw new SubmitError(
    "goal-none-in-flight",
    `没有在途目标（状态为 ${IN_FLIGHT_STATUS} 的目标为 0 个，已在 review 的也为 0 个）——` +
      `请显式给出目标 ID（goal-graph submit <goal-id>），或先 claim 目标`,
  );
}

/** submit 的可注入依赖（单测可替换自检与 Git 统计，生产默认即真实行为）。 */
export interface SubmitDeps {
  /** 自检运行器（默认 {@link runSelfCheck}）。 */
  runSelfCheck: (params: { cwd: string; timeoutMs: number }) => Promise<SelfCheckReport>;
  /** Git 统计（默认 {@link collectGitChanges}）。 */
  collectChanges: (workspace: string) => ChangeStats | null;
}

const DEFAULT_DEPS: SubmitDeps = {
  runSelfCheck: (p) => runSelfCheck({ cwd: p.cwd, timeoutMs: p.timeoutMs }),
  collectChanges: collectGitChanges,
};

/** `--skip-tests` 的替身结论（未验证，绝不伪装成通过）。 */
function skippedSelfCheck(): SelfCheckReport {
  return {
    ran: false,
    command: "(skipped)",
    exit_code: null,
    signal: null,
    duration_ms: 0,
    tests: null,
    pass: null,
    fail: null,
    skipped: null,
    todo: null,
    cancelled: null,
    verdict: "unverified",
    reasons: ["自检被 --skip-tests 显式跳过：本次提交**未验证**"],
    tail: "",
  };
}

/**
 * 提交一个目标：自检 → Git 统计 → 迁移到 review + review.requested。
 *
 * 顺序（判据 5：`review.requested` **先于** `goal.transition`）：
 * 1. 写入前预检（未初始化/只读看板、目标存在性/损坏/归档/状态）—— 零副作用；
 * 2. 解析 goal-id（省略时从唯一在途目标推断）；
 * 3. 自检（锁外，可能很慢）—— 不通过即 `self-check-blocked`，看板零改动；
 * 4. 取锁 → 锁内**重读**（CAS）：已被推进到 review ⇒ 幂等命中（零写入）；
 * 5. 写入前**再次**确认自检结论（判据 2/3：阻断时状态与事件零改动）；
 * 6. `review.requested`（core `requestAcceptReview`，含机器证据摘要）→ `goal.transition`（core）。
 */
export async function submitGoal(params: {
  root: string;
  workspace?: string;
  /** 显式 goal-id；null = 从唯一在途目标推断。 */
  id?: string | null;
  actor: string;
  /** `--skip-tests`：显式降级（未验证，零事件的 review.requested 之外**照常**迁移，见返回 `verified=false`）。 */
  skipTests?: boolean;
  timeoutMs?: number;
  deps?: Partial<SubmitDeps>;
}): Promise<SubmitResult> {
  const { root, actor } = params;
  const workspace = params.workspace ?? join(root, "..");
  const deps: SubmitDeps = { ...DEFAULT_DEPS, ...(params.deps ?? {}) };

  // ---- 写入前预检（零副作用）：未初始化 / 只读目录（先于取锁：取锁会创建 .lock.*）----
  if (!existsSync(join(root, "events.jsonl"))) {
    throw new SubmitError(
      "board-unwritable",
      `看板未初始化（缺少 events.jsonl）：${root} —— 请先初始化看板（goal-graph init）后再 submit`,
    );
  }
  if (!isWritableDir(root)) {
    throw new SubmitError(
      "board-unwritable",
      `看板目录不可写（只读）：${root} —— submit 需要写回 frontmatter 并追加事件，请检查目录权限后重试`,
    );
  }

  // ---- 目标解析（只读）：显式 id 时先把「存在/损坏/归档」判定做掉，避免白跑一次自检 ----
  const explicitId = params.id ?? null;
  if (explicitId !== null) {
    preflightGoal(root, explicitId);
  }

  // ---- 自检（锁外；判据 2 的唯一权威来源）----
  const selfCheck = params.skipTests
    ? skippedSelfCheck()
    : await deps.runSelfCheck({ cwd: workspace, timeoutMs: params.timeoutMs ?? SUBMIT_TEST_TIMEOUT_MS });
  if (selfCheck.verdict === "blocked") {
    throw new SubmitError(
      "self-check-blocked",
      `自检未通过（${selfCheck.reasons.join("；")}）—— 看板状态与事件均未改动`,
      { data: { self_check: selfCheck } },
    );
  }

  // ---- Git 变更统计（只读；非 git 工作区 → null，由边界说明）----
  const changes = deps.collectChanges(workspace);

  // ---- 取锁 → 锁内重读 → 事件先行提交 ----
  const run = (): SubmitResult => {
    const resolved = resolveGoalId(root, explicitId);
    const id = resolved.id;
    // 锁内重读即 CAS（一次读取同时给出文件、meta 与权威 status）。
    const stat = preflightGoal(root, id);
    const fileRel = relative(root, stat.file);
    if (isArchivedRel(fileRel)) {
      throw new SubmitError("goal-archived", `目标 ${id} 已归档，不能提交（归档目标不可迁移）`);
    }
    const status = stat.status;
    const boundaries: string[] = [];

    if (isScratchWorkspace(workspace)) {
      boundaries.push("工作区：scratch（无 git 跟踪），改动不会被版本控制记录。");
    }
    if (changes === null) {
      boundaries.push("变更统计：工作区不是 git 仓库（未收集变更统计，机器证据里 changes=null）。");
    } else if (changes.clean) {
      boundaries.push(`变更统计：工作区无任何改动（0 文件、0 行）—— 提交仍继续，但请确认成果确实已落地。`);
    } else {
      boundaries.push(
        `变更统计：已跟踪 ${changes.files_changed} 文件 +${changes.insertions}/-${changes.deletions} 行` +
          `（含暂存），未跟踪 ${changes.untracked_files} 文件；分支 ${changes.branch} @ ${changes.head}。`,
      );
    }
    if (!selfCheck.ran) {
      boundaries.push("⚠ 未验证：本次提交由 --skip-tests 降级，自检结论不可信（无测试证据）。");
    }

    // ---- 幂等（判据 8）：已在 review ⇒ 明确成功但零写入（不重复事件、不重复迁移）----
    if (status === "review") {
      boundaries.push(
        "状态：已在 review（幂等命中 —— 不再迁移、不再写 review.requested；本次自检结论仅供参考）。",
      );
      return {
        goal: goalSummary(root, stat, "review"),
        changed: false,
        from: "review",
        to: "review",
        inferred: resolved.inferred,
        self_check: stripTail(selfCheck),
        verified: selfCheck.verdict === "pass",
        changes,
        events: [],
        boundaries,
        root,
        unverified: selfCheck.verdict !== "pass",
      };
    }

    if (!ENTERS_REVIEW.has(status)) {
      throw new SubmitError(
        "state-not-allowed",
        `目标 ${id} 当前状态为 ${status || "(空)"}，不能提交到 review（仅 in_progress 可 submit；` +
          `review 视为幂等成功；blocked 请先解除阻塞；draft/planning/collecting/ready 请先 claim）`,
      );
    }

    // 写入前最后一次确认自检结论（判据 2/3 的硬约束：阻断时状态与事件零改动）。
    if (selfCheck.verdict === "blocked") {
      throw new SubmitError(
        "self-check-blocked",
        `自检未通过（${selfCheck.reasons.join("；")}）—— 看板状态与事件均未改动`,
        { data: { self_check: stripTail(selfCheck) } },
      );
    }

    const verified = selfCheck.verdict === "pass";
    boundaryLock(boundaries, root);

    const events: string[] = [];
    // ---- 6a. review.requested 先行（core 既有入口；details 含 targetStage/what/snapshot + 机器证据）----
    try {
      // core 的 appendEvent 是**单次** writeFileSync 追加：成功即恰好一条；失败即未写入。
      requestAcceptReview(root, id, actor, {
        extra: submitEvidenceSnapshot({ selfCheck, changes, verified }),
      });
      events.push("review.requested");
    } catch (e) {
      if (e instanceof SubmitError) throw e;
      // 事件已部分落盘的可能：core 的 appendEvent 是单次 write，失败即未写；这里如实标注为未写。
      throw new SubmitError(
        "review-request-failed",
        `写入 review.requested 失败（目标状态未变）：${(e as Error).message}`,
      );
    }

    // ---- 6b. 状态迁移（core transition：状态机校验 + 事件先行）----
    try {
      transition(root, id, "review", { actor });
      events.push("goal.transition");
    } catch (e) {
      if (e instanceof TxError) {
        if (e.phase === "event") {
          throw new SubmitError(
            "transition-event-failed",
            `状态迁移失败（事件阶段，goal.md 未改动；review.requested 已先行落盘）：${e.message}`,
            { eventsWritten: true, data: { events } },
          );
        }
        throw new SubmitError(
          "transition-persist-failed",
          `状态迁移失败（持久化阶段，事件已落盘、frontmatter 未更新；重试同一命令即可收敛）：${e.message}`,
          { eventsWritten: true, data: { events } },
        );
      }
      const msg = (e as Error).message;
      // core 的 GraphError（非法迁移）也走这里：review.requested 已落盘，必须如实说明。
      throw new SubmitError("transition-failed", `状态迁移被拒绝（review.requested 已先行落盘）：${msg}`, {
        eventsWritten: true,
        data: { events },
      });
    }

    boundaries.push(
      `状态：${status} → review（review.requested 先行，goal.transition 后行 —— 事件先于文件）。`,
    );
    return {
      goal: goalSummary(root, stat, "review"),
      changed: true,
      from: status,
      to: "review",
      inferred: resolved.inferred,
      self_check: stripTail(selfCheck),
      verified,
      changes,
      events,
      boundaries,
      root,
      unverified: !verified,
    };
  };

  try {
    // 临界区必须全同步（不得跨 await）—— 自检已在锁外 await 完成，本函数及其被调方均无 await。
    return withLocalLock(root, submitLockName(params.id ?? "auto"), run, { lockTimeoutMs: SUBMIT_LOCK_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof SubmitError) throw e;
    if (e instanceof TxError && /获取锁超时/.test(e.message)) {
      throw new SubmitError(
        "submit-lock-busy",
        `另一路 submit 正在处理（${e.message}）——同一目标不能并发提交，请稍后重试`,
      );
    }
    throw new SubmitError("transition-failed", `submit 失败：${(e as Error).message}`);
  }
}

/** 边界提示里补一行「锁观测」。锁文件在**取锁之后**必然含本进程的那个，故只报总数与其它锁。 */
function boundaryLock(boundaries: string[], root: string): void {
  let locks: string[] = [];
  try {
    locks = readdirSync(root)
      .filter((f) => f.startsWith(".lock."))
      .sort();
  } catch {
    return;
  }
  const others = locks.filter((f) => !f.startsWith(".lock.submit-"));
  if (others.length > 0) {
    boundaries.push(`锁：当前看板有 ${others.length} 个其它锁文件（${others.slice(0, 3).join("、")}）——可能有其它进程正在写入。`);
  }
}

/** 目标文件的定位（`findGoalFile` + 损坏诊断；与 claim 同口径）。 */
function locateGoal(root: string, id: string): string {
  try {
    return findGoalFile(root, id);
  } catch (e) {
    const corrupt = findCorruptGoalFiles(root, id);
    if (corrupt.length > 0) {
      const shown = corrupt.slice(0, 3).map((f) => relative(root, f)).join("、");
      throw new SubmitError(
        "goal-file-corrupt",
        `目标文件损坏（frontmatter 或结构不可解析）无法提交：${shown}` +
          `${corrupt.length > 3 ? ` 等 ${corrupt.length} 个` : ""} —— 请先修复该 goal.md（goal-graph status 可看细节）`,
      );
    }
    throw new SubmitError("goal-not-found", (e as Error).message);
  }
}

/** 只读目标并给出状态（损坏 ⇒ 明确码，不伪装成「不存在」）。`file` 为绝对路径。 */
function preflightGoal(root: string, id: string): { meta: Record<string, any>; status: string; file: string } {
  const file = locateGoal(root, id);
  let doc: GoalDoc;
  try {
    doc = loadGoal(file);
  } catch (e) {
    throw new SubmitError("goal-file-corrupt", `目标文件损坏：${relative(root, file)}（${(e as Error).message}）`);
  }
  const meta = doc.meta ?? {};
  return { meta, status: String(meta.status ?? ""), file };
}

/** 目标摘要（`file` 统一为**相对看板根**的路径，与 claim/`goal list` 同口径）。 */
function goalSummary(
  root: string,
  stat: { meta: Record<string, any>; file: string },
  status: string,
): SubmitResult["goal"] {
  const meta = stat.meta;
  return {
    id: String(meta.id ?? ""),
    title: String(meta.title ?? ""),
    type: String(meta.type ?? ""),
    version: meta.version == null ? null : String(meta.version),
    status,
    file: relative(root, stat.file),
  };
}

/** 返回给调用方的自检结论：剥掉仅供人读的输出尾部（判据 6：`--json` 里没有测试输出正文）。 */
function stripTail(report: SelfCheckReport): SelfCheckReport {
  return { ...report, tail: "" };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 渲染人类可读完成简报（判据 4：清晰、短、不倾倒长文本）。 */
export function renderSubmitBrief(result: SubmitResult): string {
  const g = result.goal;
  const out: string[] = [];
  const headline = result.changed
    ? `已提交 ${g.id}：${g.title}`
    : `已提交 ${g.id}：${g.title}（幂等命中，未改动看板）`;
  out.push(headline);
  out.push(`类型：${g.type}${g.version ? ` @${g.version}` : ""}\t状态：${result.from} → ${result.to}`);
  if (result.inferred) out.push(`目标：由唯一在途目标推断（未显式给出 goal-id）`);

  const s = result.self_check;
  out.push("");
  if (s.ran) {
    const counts =
      s.tests === null
        ? "（未解析到计数）"
        : `tests=${s.tests} pass=${s.pass} fail=${s.fail} skipped=${s.skipped} todo=${s.todo} cancelled=${s.cancelled}`;
    const verdictText = s.verdict === "pass" ? "✔ 可信通过" : "✖ 阻断";
    out.push(`自检（${verdictText}）：${s.command} exit=${s.exit_code} ${counts} ${s.duration_ms}ms`);
  } else {
    out.push("自检：⚠ 未验证（--skip-tests 显式跳过，本次提交没有测试证据）");
  }

  if (result.changes) {
    const c = result.changes;
    out.push(
      `变更统计：已跟踪 ${c.files_changed} 文件 +${c.insertions}/-${c.deletions} 行（含暂存），` +
        `未跟踪 ${c.untracked_files} 文件\t分支 ${c.branch} @ ${c.head}`,
    );
  } else {
    out.push("变更统计：（非 git 工作区，未收集）");
  }

  if (result.events.length > 0) out.push(`事件（按写入顺序）：${result.events.join(" → ")}`);
  if (result.boundaries.length > 0) {
    out.push("");
    out.push("边界提示：");
    for (const b of result.boundaries) out.push(`  - ${b}`);
  }
  if (result.unverified) {
    out.push("");
    out.push("⚠ 本次提交**未验证**：自检结论不可信，请勿据此判为完成。");
  }
  return `${out.join("\n")}\n`;
}

/** `--json` 的错误形态（稳定字段；`code` 供脚本分支）。 */
export function submitErrorPayload(e: SubmitError, root: string): Record<string, unknown> {
  return {
    ok: false,
    root,
    code: e.code,
    message: e.message,
    events_written: e.eventsWritten,
    ...e.data,
  };
}
