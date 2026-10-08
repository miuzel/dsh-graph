/**
 * g-437：门禁③「Git 真源」测试夹具 —— **真 Git 仓库 + 真 attempt 工作树 + 真 attempt 记录**。
 *
 * 为什么必须真 Git：门禁③现在由引擎在 attempt 的**实际工作树**上跑
 * `git diff --numstat -z <baseline> HEAD` 与 `git status --porcelain=v1 -z` 并逐项对账。
 * 假 baseline（`"86b2c2b"`）/ 手写报告无法证明这一点，也测不出「缺失工作树必须拒绝、绝不回退主树」。
 *
 * 夹具自带「诚实报告」构造：`report()` 的 `changed_paths` 来自
 * `git diff --name-only -z <baseline> <head>`，产品码行数用**非 `-z`** 的
 * `git diff --numstat` 独立解析（分类仍复用 `isProductCodePath`——单一分类口径），
 * 未跟踪数来自**声明的用户文件**（插件自有目录必须由引擎自行排除，故不进报告）。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  createGoal,
  findGoalFile,
  init,
  loadGoal,
  saveGoal,
  setCriteria,
  startAttempt,
  writeProjectConfig,
} from "../../ops.ts";
import { isProductCodePath } from "../../review-policy.ts";
import { readEvents } from "../../events.ts";

export const FIXTURE_VERIFIED = "✅已验";

export interface FastTrackFixtureOptions {
  /** 目标类型（缺省 patch ⇒ 策略派生 auto）。 */
  type?: string;
  /** 判据文本（缺省两条已验判据）。 */
  criteria?: string[];
  /** attempt 树中**提交**的改动：路径 → 追加行数（缺省 `scripts/run.sh` 追加 3 行）。 */
  changed?: Array<{ path: string; lines: number }>;
  /** attempt 树中**提交**的改名（`git mv`，旧新两条路径都进 changed_paths）。 */
  renamed?: Array<{ from: string; to: string }>;
  /** attempt 树中**提交**的删除（相对仓库根）。 */
  deleted?: string[];
  /** attempt 树中**不提交**的真实用户未跟踪文件（相对仓库根）。 */
  untracked?: string[];
  /** 非隔离模式：attempt 记录 `worktree: false`，执行树 = 工作区仓库根。 */
  nonIsolated?: boolean;
  /** 报告里去掉 `attempt` 字段（负向对照）。 */
  omitAttempt?: boolean;
  /**
   * 报告里去掉 attempt 记录的 `baseline_commit`（负向对照：模拟「派发时未持久化基线」的
   * LEGACY/省略形态 —— 隔离 attempt 仍留有 `worktree.head` 这个引擎侧锚点）。
   */
  omitBaseline?: boolean;
  /** 覆盖报告 `baseline_commit`（负向对照：与 attempt 持久化基线不一致 / 不可解析）。 */
  reportBaseline?: string;
  /** 额外 `project.yaml` 配置（如 `review.non_product_prefixes`）。 */
  projectConfig?: Record<string, unknown>;
  /** 与 `projectConfig.review.non_product_prefixes` **同值**的有效排除前缀（诚实报告须按同一份配置算行数）。 */
  nonProductPrefixes?: string[];
}

export interface FastTrackFixture {
  /** 仓库根（= 工作区）。 */
  repo: string;
  /** 看板根（仓库内的 `.dsh-graph`，故意**不** gitignore ⇒ 归属语义真被测到）。 */
  root: string;
  goal: string;
  file: string;
  attempt: string;
  /** attempt 的实际执行树（隔离模式为工作树路径；非隔离为仓库根）。 */
  tree: string;
  baseline: string;
  head: string;
  /** 引擎应算出的产品码增删合计。 */
  productLines: number;
  /** 引擎应算出的全部变更路径（含 rename 旧新两条）。 */
  changedPaths: string[];
  /** 引擎应算出的未跟踪**用户**文件数（不含插件自有目录）。 */
  untrackedFiles: number;
  git: (cwd: string, args: string[]) => string;
  report: (over?: Record<string, unknown>) => Record<string, unknown>;
  events: () => ReturnType<typeof readEvents>;
  dispose: () => void;
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
}

/** 夹具自带的 `-z` numstat 解码（与引擎的 `parseNumstatZ` 互为独立实现）。 */
function parseNumstatZOwn(
  out: string,
  nonProductPrefixes: readonly string[] | null,
): { lines: number; paths: string[] } {
  const tokens = out.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  let lines = 0;
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const parts = tokens[i].split("\t");
    if (parts.length < 3) continue;
    let entryPaths: string[];
    if (parts[2] === "") {
      if (tokens[i + 1] === undefined || tokens[i + 2] === undefined) break;
      entryPaths = [tokens[i + 1], tokens[i + 2]];
      i += 2;
    } else {
      entryPaths = [parts.slice(2).join("\t")];
    }
    paths.push(...entryPaths);
    const added = /^\d+$/.test(parts[0]) ? Number(parts[0]) : 0;
    const deleted = /^\d+$/.test(parts[1]) ? Number(parts[1]) : 0;
    // 分类看两条路径，行数按记录只计一次（与引擎口径一致）。
    if (entryPaths.some((p) => isProductCodePath(p, nonProductPrefixes))) lines += added + deleted;
  }
  return { lines, paths };
}

/** `git diff --name-status -z` 的 rename/copy 感知解码（旧新两条路径都要进集合）。 */
function parseNameStatusZOwn(out: string): string[] {
  const tokens = out.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (/^[RC][0-9]*$/.test(status)) {
      if (tokens[i + 1] !== undefined) paths.push(tokens[i + 1]);
      if (tokens[i + 2] !== undefined) paths.push(tokens[i + 2]);
      i += 2;
    } else if (status !== "") {
      if (tokens[i + 1] !== undefined) paths.push(tokens[i + 1]);
      i += 1;
    }
  }
  return [...new Set(paths)].sort();
}

export function makeFastTrackFixture(opts: FastTrackFixtureOptions = {}): FastTrackFixture {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-g437-"));
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "fixture@test.local"]);
  git(repo, ["config", "user.name", "g437 fixture"]);
  git(repo, ["config", "commit.gpgsign", "false"]);

  // 基线内容：产品码脚本 + 一个 .md（口径排除项）+ 一个契约占位文件（契约/改名用例用）。
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "core"), { recursive: true });
  writeFileSync(join(repo, "scripts", "run.sh"), "#!/bin/sh\necho baseline\n");
  writeFileSync(join(repo, "core", "schema.ts"), "export const SCHEMA_VERSION = 1;\n");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "baseline"]);
  const baseline = git(repo, ["rev-parse", "HEAD"]).trim();

  const root = join(repo, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "g437 fixture", version: "v-test", type: opts.type ?? "patch", actor: "t" });
  setCriteria(root, goal, opts.criteria ?? [`全量测试全绿 ${FIXTURE_VERIFIED}`, `无回归 ${FIXTURE_VERIFIED}`], "t");
  const file = findGoalFile(root, goal);
  const doc = loadGoal(file);
  saveGoal(file, { meta: { ...doc.meta, status: "review" }, body: doc.body });
  if (opts.projectConfig) writeProjectConfig(root, opts.projectConfig, "human:gui");

  const branch = `${goal}-att-001`;
  const tree = opts.nonIsolated ? repo : join(repo, ".worktrees", branch);
  if (!opts.nonIsolated) {
    mkdirSync(dirname(tree), { recursive: true });
    git(repo, ["worktree", "add", "-q", "-b", branch, tree]);
  }

  // attempt 树上的真实提交（产品码行数来自这里）。
  const changed =
    opts.changed ?? (opts.renamed || opts.deleted ? [] : [{ path: "scripts/run.sh", lines: 3 }]);
  for (const c of changed) {
    const abs = join(tree, c.path);
    mkdirSync(dirname(abs), { recursive: true });
    let existing = "";
    try {
      existing = loadText(abs);
    } catch {
      existing = "";
    }
    writeFileSync(abs, existing + Array.from({ length: c.lines }, (_, i) => `echo line-${i + 1}`).join("\n") + "\n");
  }
  for (const r of opts.renamed ?? []) {
    mkdirSync(dirname(join(tree, r.to)), { recursive: true });
    if (r.from !== r.to) git(tree, ["mv", r.from, r.to]);
  }
  for (const rel of opts.deleted ?? []) rmSync(join(tree, rel), { force: true });
  const stagedPaths = [
    ...changed.map((c) => c.path),
    ...(opts.deleted ?? []),
    // 改名只 add 目标路径：`git mv` 已把改名入暂存区，旧路径此时已不存在
    // （`git add -- <旧路径>` 会以 "pathspec did not match" 失败）。
    ...(opts.renamed ?? []).map((r) => r.to),
  ];
  if (stagedPaths.length > 0) {
    // 只 add 本次声明的改动路径：非隔离模式下仓库根还有看板的未跟踪文件，
    // `git add -A` 会把它们一并提交，使「插件自有未跟踪目录」的归属语义测不到。
    git(tree, ["add", "--", ...stagedPaths]);
    git(tree, ["commit", "-q", "-m", "attempt change"]);
  }
  const head = git(tree, ["rev-parse", "HEAD"]).trim();

  // 真实用户未跟踪文件（不进报告以外的任何地方）。
  for (const rel of opts.untracked ?? []) {
    const abs = join(tree, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "user scratch\n");
  }

  const attempt = startAttempt(root, goal, {
    executor: "fixture",
    actor: "t",
    // 忠实于真实派发：`worktree.head` 是**建树那一刻**的 HEAD（= 基线，执行者尚未提交），
    // 不是 attempt 提交后的 tip —— 它也是 g-437 P1 的引擎侧区间锚点回退值。
    worktree: opts.nonIsolated ? false : { path: tree, relative_path: relative(repo, tree), branch, head: baseline },
    baselineCommit: baseline,
    taskType: "fix",
  });
  if (opts.omitBaseline) {
    // 抹掉 attempt 记录的持久化基线（保留 worktree.head），复现「锚点只能来自报告」的旧形态。
    const attFile = join(dirname(file), "attempts", attempt, "attempt.md");
    const attDoc = loadGoal(attFile);
    const meta = { ...(attDoc.meta as Record<string, unknown>) };
    delete meta.baseline_commit;
    saveGoal(attFile, { meta, body: attDoc.body });
  }

  const numstatOut = git(tree, ["diff", "--numstat", "-z", baseline, head]);
  const counted = parseNumstatZOwn(numstatOut, opts.nonProductPrefixes ?? null);
  const changedPaths = parseNameStatusZOwn(git(tree, ["diff", "--name-status", "-z", baseline, head]));
  const productLines = counted.lines;
  const untrackedFiles = (opts.untracked ?? []).length;

  const trace = { command: "fixture command", collected_at: "2026-01-01T00:00:00.000Z", source: "fixture:executor" };
  const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...(opts.omitAttempt ? {} : { attempt }),
    baseline_commit: opts.reportBaseline ?? baseline,
    changed_paths: [...changedPaths],
    product_changed_lines: productLines,
    untracked_files: untrackedFiles,
    tests: { exit_code: 0, fail: 0, ...trace },
    typecheck: { exit_code: 0, ...trace },
    ...over,
  });

  return {
    repo,
    root,
    goal,
    file,
    attempt,
    tree,
    baseline,
    head,
    productLines,
    changedPaths,
    untrackedFiles,
    git,
    report,
    events: () => readEvents(root),
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}

function loadText(path: string): string {
  return readFileSync(path, "utf8");
}
