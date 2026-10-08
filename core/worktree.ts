import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, join, sep, dirname, isAbsolute } from "node:path";
import { appendEvent, readEvents, nowIso } from "./events.ts";
import { discoverGitWorktree, isScratchWorkspace } from "./root.ts";
import { findGoalFile, loadGoal } from "./ops.ts";
import { GraphError } from "./machine.ts";

export interface WorktreeCandidate {
  id: string; goal: string; attempt: string; path: string; branch: string | null;
  head: string | null; target_branch: string | null; merged: boolean; clean: boolean;
  active: boolean; status: "candidate" | "protected" | "unknown" | "cleaned";
  reason: string | null; discovered_at: string;
}

type GitTree = { path: string; head: string | null; branch: string | null };
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function trees(cwd: string): GitTree[] {
  const lines = git(cwd, ["worktree", "list", "--porcelain"]).split(/\r?\n/);
  const result: GitTree[] = []; let current: GitTree | null = null;
  for (const line of lines) {
    if (line.startsWith("worktree ")) { if (current) result.push(current); current = { path: resolve(line.slice(9).trim()), head: null, branch: null }; }
    else if (current && line.startsWith("HEAD ")) current.head = line.slice(5).trim() || null;
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "") || null;
  }
  if (current) result.push(current);
  return result;
}
function goalStatus(root: string, goal: string): string | null {
  try { return String(loadGoal(findGoalFile(root, goal)).meta.status ?? ""); } catch { return null; }
}
/**
 * g-329：attempt.md 中 `result` 的**终态取值**——命中即代表该 attempt 不再活跃。
 *
 * 该表必须与所有「结束 attempt」写入点的实际取值逐一核对，写入方新增取值时必须同步
 * 在此登记，否则 isActive 会保守地把已结束的 attempt 判为活跃，其 worktree 被
 * `protected / attempt_active` 永久锁死（放弃路径漏登记 `cancelled` 即此故障的成因）。
 * 写入点与对应事件（事件流为审计真源，见 events.ts 的追加语义）：
 *  - `abandonAttempt`（core/ops.ts）：`attempt.abandoned` → `result="cancelled"`
 *  - `unbindGoalChild` 正常解绑（core/ops.ts）：`attempt.unbound` → 原 pending 置 `result="detached"`
 *  - 解绑时被取代的旧 attempt（core/ops.ts, g-190）：`attempt.superseded` → `result="superseded"`
 *  - 评审/交付路径：`selected` / `merged` / `rejected` / `completed` / `failed`
 * 口径对齐：ops.ts 的 `attemptIsActive()`（暂缓/删除门禁）以 `detached === true || result !== "pending"`
 * 判非活跃，客户端 `hasActiveExecutionAttempt()` 亦以 `result !== "pending"` 收敛；
 * 本表是同一语义的工作树侧显式版本，只对已知终态放行，未知取值仍保守视为活跃。
 */
const ATTEMPT_TERMINAL_RESULTS = [
  "completed", "failed", "selected", "merged", "rejected", "superseded",
  "cancelled", "detached",
] as const;
function isActive(root: string, goal: string, attempt: string): boolean {
  try {
    const file = join(dirname(findGoalFile(root, goal)), "attempts", attempt, "attempt.md");
    if (!existsSync(file)) return true;
    const meta = loadGoal(file).meta as any;
    const result = meta.result;
    if (typeof result !== "string") return true;
    if (result !== "pending" && !(ATTEMPT_TERMINAL_RESULTS as readonly string[]).includes(result)) return true;
    if (result !== "pending") return false;
    // g-247: structured state is authoritative; legacy text parsing is fallback only.
    if (["working", "blocked", "done", "error"].includes(meta.status_state)) return meta.status_state === "working";
    const line = String(meta.status_line ?? "").trim().toLowerCase();
    const terminal = /(完成|完毕|空闲|等待\s*review|待命|已提交|结束|completed|idle|done|waiting\s*review)/i.test(line);
    // pending 且非明确终态一律保守视为活跃，包括 child 启动失败/本地执行。
    return !terminal;
  } catch { return true; }
}
function ancestor(cwd: string, head: string | null, target: string | null): boolean {
  if (!head || !target) return false;
  try { git(cwd, ["merge-base", "--is-ancestor", head, target]); return true; } catch { return false; }
}
function parseAssociation(tree: GitTree): { assoc: { goal: string; attempt: string } | null; reason?: string } {
  const pathName = tree.path.split(/[\\/]/).pop() ?? "";
  const pathMatch = pathName.match(/^g-(\d+)-att-(\d{2,3})$/);
  const branchMatch = tree.branch?.match(/^g-(\d+)-att-(\d{2,3})$/) ?? null;
  // g-272 att-002：reason 一律为稳定枚举（客户端按枚举做 i18n 双语映射），不再下发中文句子。
  if (!pathMatch) return { assoc: null, reason: "path_not_canonical_name" };
  const assoc = { goal: `g-${pathMatch[1]}`, attempt: `att-${String(Number(pathMatch[2])).padStart(3, "0")}` };
  if (tree.branch && !branchMatch) return { assoc, reason: "branch_not_canonical_name" };
  if (branchMatch && (branchMatch[1] !== pathMatch[1] || branchMatch[2] !== pathMatch[2])) return { assoc, reason: "path_branch_mismatch" };
  return { assoc };
}
function candidateId(goal: string, attempt: string, path: string): string { return `${goal}:${attempt}:${path}`; }

/**
 * g-448：看板归属（board ownership）与**跨看板误复用**防护。
 *
 * 问题：同一 Git 仓库内的多块看板（默认 `<repo>/.dsh-graph` 与自定义 `<repo>/boards/board-n/.dsh-graph`）
 * 由真实 Git 发现解析出**同一个**主工作树 ⇒ 二者的 `.worktrees/g-<goal>-att-<NN>` 路径与分支名逐字相同。
 * 在 `prepareAttemptWorktree` 的复用分支里，只要路径/分支/目标编号匹配就复用，且把 `canonical_root`
 * 记为**当前调用方**的看板根 ⇒ B 板会静默把 A 板的工作树当成自己的执行目录，并覆盖旧看板的绑定。
 *
 * 归属真源分两级、**读已持久化的真实元信息**，不猜旧命名：
 *  1. **归属标记**（权威）：建树时写进该工作树自己的 Git 管理目录
 *     （`<git-common-dir>/worktrees/<name>/dsh-graph-board-owner.json`）。它不进工作区、
 *     不污染 `git status`、随 `git worktree remove` 一起消失，且**任何看板都能读到同一份**
 *     ⇒ 跨看板可核验，无需新增调度体系或跨看板共享状态。
 *  2. **事件 provenance**（仅旧树兼容）：本看板自己的 `attempt.started` 事件是否记录了这棵树的
 *     精确路径与同号 goal/attempt（与 g-443 `detectWorkspaceCleanliness` 同源口径）。本看板事件流
 *     读不到别的看板的记录 ⇒ 跨看板必然落空。
 *
 * 两者皆无 ⇒ 无归属证明的孤儿/外部工作树：**保守拒绝**，绝不自动接管、改名或删除。
 */
const BOARD_OWNER_MARKER = "dsh-graph-board-owner.json";
interface BoardOwnerMarker {
  canonical_root: string;
  goal: string;
  attempt: string;
  branch: string | null;
  created_at: string;
}
/** 符号链接稳健的路径归一（比较用；解析失败回落到字面绝对路径）。 */
function canonicalPath(p: string): string {
  const resolved = resolve(p);
  try { return realpathSync(resolved); } catch { return resolved; }
}
/** 该工作树自己的 Git 管理目录（link worktree 为 `<common>/worktrees/<name>`）；取不到返回 null。 */
function worktreeGitDir(worktreePath: string): string | null {
  try {
    const dir = git(worktreePath, ["rev-parse", "--absolute-git-dir"]);
    return dir ? dir : null;
  } catch { return null; }
}
/** 读取已持久化的看板归属标记；缺失/损坏/不可读一律返回 null（按「无归属证明」保守处理）。 */
export function readBoardOwner(worktreePath: string): BoardOwnerMarker | null {
  const dir = worktreeGitDir(worktreePath);
  if (!dir) return null;
  const file = join(dir, BOARD_OWNER_MARKER);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<BoardOwnerMarker>;
    if (!parsed || typeof parsed.canonical_root !== "string" || !parsed.canonical_root.trim()) return null;
    return parsed as BoardOwnerMarker;
  } catch { return null; }
}
/**
 * 写入看板归属标记（best-effort）。写失败**不**让派发失败：同看板仍可由事件 provenance 证明归属，
 * 跨看板仍因读不到本看板事件而被拒绝，故不引入「建树成功却因标记失败而半途硬失败」的副作用。
 */
function writeBoardOwner(worktreePath: string, root: string, goalId: string, attemptId: string, branch: string | null): boolean {
  const dir = worktreeGitDir(worktreePath);
  if (!dir) return false;
  try {
    const marker: BoardOwnerMarker = {
      canonical_root: resolve(root), goal: goalId, attempt: attemptId, branch, created_at: nowIso(),
    };
    writeFileSync(join(dir, BOARD_OWNER_MARKER), `${JSON.stringify(marker)}\n`, "utf8");
    return true;
  } catch { return false; }
}
/** 本看板事件流是否记录了这棵树（旧树兼容的唯一依据）；事件不可读 ⇒ fail-closed 返回 false。 */
function boardRecordedProvenance(root: string, worktreePath: string, goalId: string, attemptId: string): boolean {
  try {
    const target = canonicalPath(worktreePath);
    return readEvents(root).some((event) => {
      if (event.event !== "attempt.started" || event.goal !== goalId) return false;
      const details: any = event.details;
      if (details?.attempt !== attemptId) return false;
      const recorded = details?.worktree;
      const path = typeof recorded === "string" ? recorded : (typeof recorded?.path === "string" ? recorded.path : null);
      return !!path && canonicalPath(path) === target;
    });
  } catch { return false; }
}

function resolveCodeWorkspace(root: string): string | null {
  const resolved = resolve(root);
  // g-149 / 独立数据仓库支持：如果 root 名为 .dsh-graph，且其父目录是 Git 仓库，真正的工程代码库是父目录
  const parent = dirname(resolved);
  const parentInfo = discoverGitWorktree(parent);
  if (parentInfo) return parentInfo.mainWorktree;
  const directInfo = discoverGitWorktree(resolved);
  return directInfo ? directInfo.mainWorktree : null;
}

export function listWorktrees(root: string, goalId?: string): WorktreeCandidate[] {
  const mainWorktree = resolveCodeWorkspace(root); if (!mainWorktree) return [];
  let list: GitTree[]; try { list = trees(mainWorktree); } catch { return []; }
  const main = resolve(mainWorktree); const target = list[0]?.branch ?? null; const out: WorktreeCandidate[] = [];
  const events = readEvents(root);
  for (const tree of list) {
    if (resolve(tree.path) === main) continue;
    const rel = relative(main, tree.path);
    let real = tree.path; try { real = realpathSync(tree.path); } catch { /* deleted/invalid path remains protected */ }
    const realRel = relative(main, real);
    const inside = rel.startsWith(`.worktrees${sep}`) && realRel.startsWith(`.worktrees${sep}`) && !realRel.startsWith(`..${sep}`);
    const parsed = parseAssociation(tree); const assoc = parsed.assoc;
    if (!assoc || (goalId && assoc.goal !== goalId)) continue;
    const id = candidateId(assoc.goal, assoc.attempt, tree.path);
    const registrations = events.filter(e => e.event === "worktree.candidate_registered" && e.details?.id === id);
    const registered = registrations.at(-1)?.details as any;
    const reused = events.some(e => (e.event === "worktree.cleaned" || e.event === "worktree.external_removed") && e.details?.id === id);
    const snapshotDrift = registered && (registered.path !== tree.path || registered.head !== tree.head || registered.branch !== tree.branch);
    const delivered = goalStatus(root, assoc.goal) === "delivered";
    let attemptMeta: any = null;
    try { const gf = findGoalFile(root, assoc.goal); const af = join(dirname(gf), "attempts", assoc.attempt, "attempt.md"); if (existsSync(af)) attemptMeta = loadGoal(af).meta; } catch { /* evidence missing */ }
    let clean = false; try { clean = git(tree.path, ["status", "--porcelain"]) === ""; } catch { clean = false; }
    const active = isActive(root, assoc.goal, assoc.attempt); const merged = ancestor(main, tree.head, target);
    let status: WorktreeCandidate["status"] = "protected"; let reason: string | null = null;
    if (!inside) { status = "unknown"; reason = "outside_canonical_worktrees"; }
    else if (reused) { status = "unknown"; reason = "reuse_suspected"; }
    else if (snapshotDrift) { status = "unknown"; reason = "snapshot_drift"; }
    else if (parsed.reason) { status = "unknown"; reason = parsed.reason; }
    else if (!attemptMeta || String(attemptMeta.goal ?? "") !== assoc.goal || String(attemptMeta.id ?? "") !== assoc.attempt) { status = "unknown"; reason = "missing_attempt_evidence"; }
    else if (!delivered) reason = "not_delivered";
    else if (active) reason = "attempt_active";
    else if (!clean) reason = "worktree_dirty";
    else if (!merged) { status = "unknown"; reason = "not_merged"; }
    else status = "candidate";
    out.push({ id, ...assoc, path: tree.path, branch: tree.branch, head: tree.head, target_branch: target, merged, clean, active, status, reason, discovered_at: nowIso() });
  }
  const seen = new Set(out.map(x => x.id));
  for (const e of events.filter(e => e.event === "worktree.candidate_registered")) {
    const d = e.details as any; if (!d?.id || seen.has(d.id) || (goalId && e.goal !== goalId)) continue;
    const external = events.some(x => x.event === "worktree.external_removed" && x.details?.id === d.id);
    const cleaned = events.some(x => x.event === "worktree.cleaned" && x.details?.id === d.id);
    out.push({ ...d, status: cleaned ? "cleaned" : "unknown", reason: cleaned ? "user_cleaned" : "externally_removed" });
    if (!external && !cleaned) appendEvent(root, { actor: "core", event: "worktree.external_removed", goal: e.goal, details: { id: d.id, path: d.path, removed_at: nowIso() } });
  }
  return out;
}
export function registerWorktreeCandidates(root: string, goal: string, actor = "core"): WorktreeCandidate[] {
  const found = listWorktrees(root, goal); const ids = new Set(readEvents(root).filter(e => e.event === "worktree.candidate_registered").map(e => String(e.details?.id)));
  for (const c of found) if (!ids.has(c.id)) appendEvent(root, { actor, event: "worktree.candidate_registered", goal, details: c });
  return found;
}
export function cleanWorktree(root: string, id: string, actor = "human:gui", confirm = false): { ok: boolean; candidate?: WorktreeCandidate; reason?: string } {
  const c = listWorktrees(root).find(x => x.id === id);
  if (!confirm) return { ok: false, ...(c ? { candidate: c } : {}), reason: "confirm_required" };
  const block = (reason: string) => { appendEvent(root, { actor, event: "worktree.clean_blocked", goal: c?.goal, details: { id, reason, candidate: c ?? null } }); return { ok: false, ...(c ? { candidate: c } : {}), reason }; };
  if (!c) return block("unknown_candidate");
  // g-272 att-002：枚举等值判断（原为对中文 reason 的字符串包含判断），语义不变。
  if (c.status === "cleaned" || (c.status === "unknown" && c.reason === "externally_removed")) return { ok: true, candidate: c, reason: "already_cleaned" };
  if (c.status !== "candidate") return block(c.reason ?? "protected");
  const mainWorktree = resolveCodeWorkspace(root); if (!mainWorktree) return block("git_unavailable");
  const main = resolve(mainWorktree); const rel = relative(main, resolve(c.path));
  if (rel === "" || rel.startsWith(`..${sep}`) || !(rel.startsWith(`.worktrees${sep}`))) return block("outside_canonical_worktrees");
  let live: GitTree | undefined; try { live = trees(main).find(x => resolve(x.path) === resolve(c.path)); } catch { return block("git_worktree_list_unavailable"); }
  if (!live || live.head !== c.head || live.branch !== c.branch) return block("live_record_drift");
  let realPath: string; try { realPath = realpathSync(live.path); } catch { return block("realpath_unavailable"); }
  const realRel = relative(main, realPath);
  if (!realRel.startsWith(`.worktrees${sep}`) || realRel === ".worktrees" || realRel.startsWith(`..${sep}`)) return block("realpath_escape");
  if (goalStatus(root, c.goal) !== "delivered" || isActive(root, c.goal, c.attempt)) return block("state_changed");
  try { git(main, ["worktree", "remove", c.path]); appendEvent(root, { actor, event: "worktree.cleaned", goal: c.goal, details: { ...c, cleaned_at: nowIso() } }); return { ok: true, candidate: c }; }
  catch (error) { return block(String(error instanceof Error ? error.message : error)); }
}

/**
 * g-283：根据目标类型计算是否默认隔离 worktree 的纯函数：
 * patch / chore / task 默认不勾选（false）；
 * 其余（feature / bug / improvement 等）默认勾选（true）。
 * 空值/非法类型按默认类型 task 处理（false）。
 */
export function defaultWorktreeForGoalType(rawType: unknown): boolean {
  if (rawType === null || rawType === undefined || rawType === "") {
    return false;
  }
  const t = String(rawType).trim().toLowerCase();
  if (t === "patch" || t === "chore" || t === "task") {
    return false;
  }
  return true;
}

export type GitCleanlinessResult =
  | { clean: true }
  | { clean: false; dirtyReason: string }
  | { clean: null; error: string };

/**
 * g-289：探测工作区/主工作树 Git 干净度（git status --porcelain）。
 * - clean=true：集成分支工作树干净，无未提交改动；
 * - clean=false：集成分支存在未提交改动（dirtyReason 记录 porcelain 摘要或状态）；
 * - clean=null：探测不可靠（非 git 仓库 / git 不可用 / 命令超时或执行失败）。
 *
 * 注：clean=null 只表示「拿不到可靠的干净度信号」。是否据此改变默认隔离，交由
 * {@link resolveWorktreeIsolationDecision} 结合可靠性语义裁定，见其注释。
 *
 * g-363：workspaceDir 若是**仓库内被 git 忽略的 scratch 目录**（仓库 `tmp/` 下的测试夹具、
 * `tmp/dsh-test/<版本>/workspace` 隔离实例），它不属于任何仓库项目 —— `git status` 给出的是
 * **外层仓库**的干净度，属于答非所问，一律按 clean=null（探测不可靠）返回，绝不伪称干净。
 */
export function detectWorkspaceCleanliness(
  workspaceDir: string,
  gitRunner?: (cwd: string, args: string[]) => string,
  graphRoot?: string,
): GitCleanlinessResult {
  const runner = gitRunner ?? git;
  try {
    if (isScratchWorkspace(resolve(workspaceDir))) {
      return {
        clean: null,
        error: `workspace 是仓库内 git-ignored 的 scratch 目录（${workspaceDir}），不属于该仓库项目，无法判定干净度`,
      };
    }
  } catch {
    // 发现失败不影响原有探测路径（下面按原逻辑走 git status）
  }
  try {
    // Git's -z porcelain paths are always relative to the repository top level,
    // even when status is invoked from a nested workspace directory.
    const statusPathRoot = graphRoot
      ? resolve(runner(workspaceDir, ["rev-parse", "--show-toplevel"]))
      : resolve(workspaceDir);
    const out = runner(workspaceDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const entries = out.includes("\0")
      ? out.split("\0").filter(Boolean)
      : out.split(/\r?\n/).filter((entry) => entry.trim().length > 0);
    const ownedUntracked = new Set<string>();
    if (graphRoot) {
      const graphPath = resolve(graphRoot);
      // Do not let a misconfigured graph root that is an ancestor of the project hide
      // ordinary project files. The graph root must be a strict descendant of this repo.
      const repoRoot = statusPathRoot;
      const graphRel = relative(repoRoot, graphPath);
      const graphIsInsideRepo = graphRel !== "" && graphRel !== ".." &&
        !graphRel.startsWith(`..${sep}`) && !isAbsolute(graphRel);
      // Only untracked plugin data under the actual configured graph root is ignored.
      // Tracked modifications are never exempted, even when they live there.
      if (graphIsInsideRepo) ownedUntracked.add(graphPath);

      // A nested worktree is plugin-owned only when Git currently registers it and
      // this graph's attempt.started event records that exact path. A name or location
      // under .worktrees alone is not sufficient evidence of ownership.
      try {
        const registered = new Set(runner(workspaceDir, ["worktree", "list", "--porcelain"])
          .split(/\r?\n/).filter((line) => line.startsWith("worktree "))
          .map((line) => resolve(line.slice("worktree ".length).trim())));
        const recorded = new Set(readEvents(graphRoot)
          .filter((event) => event.event === "attempt.started")
          .map((event) => {
            const worktree = (event.details as any)?.worktree;
            return typeof worktree === "string" ? resolve(worktree) :
              typeof worktree?.path === "string" ? resolve(worktree.path) : null;
          }).filter((path): path is string => !!path));
        for (const path of registered) if (recorded.has(path)) ownedUntracked.add(path);
      } catch {
        // Missing or unreadable provenance fails closed: only graph-root data is exempt.
      }
    }

    const remaining = entries.filter((entry) => {
      const status = entry.slice(0, 2);
      if (status !== "??" || ownedUntracked.size === 0) return true;
      const path = entry.slice(3).replace(/[\\/]$/, "");
      const absolute = resolve(statusPathRoot, path);
      for (const owned of ownedUntracked) {
        const rel = relative(owned, absolute);
        if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return false;
      }
      return true;
    });
    if (remaining.length === 0) return { clean: true };
    const summary = remaining.slice(0, 3).join("; ") + (remaining.length > 3 ? ` ... (+${remaining.length - 3} more)` : "");
    return { clean: false, dirtyReason: summary };
  } catch (err: any) {
    return { clean: null, error: String(err?.message ?? err) };
  }
}

export interface WorktreeIsolationDecision {
  isolate: boolean;
  /** 区分四种决策来源：显式 / 脏工作区 / 干净时类型默认 / 探测失败回退按类型默认 */
  reason: "explicit" | "dirty_workspace" | "type_default" | "type_default_unknown";
  probeState?: GitCleanlinessResult;
  userMessage?: {
    zh: string;
    en: string;
  };
}

/**
 * g-289：根据目标类型与工作区干净度综合决策是否默认启用 worktree 隔离（单一可单测函数）。
 *
 * 规则（自上而下短路求值）：
 * - 规则 1（显式覆盖优先级最高）：explicitIsolate 非 undefined/null 时尊重显式参数，reason="explicit"。
 *   探测只影响默认值，永远不推翻显式选择。
 * - 规则 2（脏工作树防御，核心增量）：探测拿到「可靠」的不干净信号（clean === false）时，
 *   即使 patch/chore/task 也默认隔离（isolate=true），reason="dirty_workspace" 并附中英提示。
 *   这正是 g-280/281/282 串扰事故的防护点——事故发生在「真实 git 仓库且有未提交改动」，恰是可可靠探测到的情形。
 * - 规则 3（干净基线）：探测拿到干净的信号（clean === true）或未传入 probe 时，按类型默认：
 *   patch/chore/task=false，其余=true，reason="type_default"。
 * - 规则 4（探测不可靠的回退）：clean === null（非 git / git 不可用 / 超时等）时，
 *   「拿不到可靠信号」≠「一定不安全」，且此时也无法真正创建 worktree（准备阶段会失败即停），
 *   为避免凭空翻转默认值造成可预测性损失与误伤，回退到按类型默认，reason="type_default"。
 *   这是刻意选择的「探测不可靠 ⇒ 回退按类型默认」而非「一律强制隔离」的降级策略；
 *   真正的 fail-closed 保护体现在：一旦探测到真实脏工作树（规则 2）必升级隔离，
 *   以及显式/默认要求隔离时 prepareAttemptWorktree 在非 git 环境下仍会「失败即停」拒绝派发。
 */
export function resolveWorktreeIsolationDecision(
  rawType: unknown,
  explicitIsolate?: boolean | null,
  probeState?: GitCleanlinessResult | null,
): WorktreeIsolationDecision {
  if (explicitIsolate !== undefined && explicitIsolate !== null) {
    return {
      isolate: Boolean(explicitIsolate),
      reason: "explicit",
      ...(probeState ? { probeState } : {}),
    };
  }

  // 工作树脏：即便是 patch/chore/task 也默认启用隔离（核心增量）
  if (probeState && probeState.clean === false) {
    return {
      isolate: true,
      reason: "dirty_workspace",
      probeState,
      userMessage: {
        zh: "⚠️ 集成工作区存在未提交改动，已默认启用隔离以防串扰",
        en: "⚠️ Integration workspace has uncommitted changes; isolation enabled by default to prevent crosstalk",
      },
    };
  }

  // 探测不可靠（clean=null）：记录 unknown 回退，不伪称干净
  if (probeState && probeState.clean === null) {
    const byType = defaultWorktreeForGoalType(rawType);
    return {
      isolate: byType,
      reason: "type_default_unknown",
      probeState,
    };
  }

  // 干净工作树或无 probe：按类型默认
  const byType = defaultWorktreeForGoalType(rawType);
  return {
    isolate: byType,
    reason: "type_default",
    ...(probeState ? { probeState } : {}),
  };
}

export interface PrepareWorktreeResult {
  enabled: boolean;
  worktree: Record<string, string> | false;
  reason?: string | null;
  created?: boolean;
  reused?: boolean;
}

/**
 * g-283：派发前准备工作树（真实创建 / 幂等复用 / 失败即停）。
 * - enabled=false：不创建，返回 worktree=false 与原因；
 * - enabled=true：
 *   - 目标路径与分支已存在且匹配 → 复用（reused=true），不报错；
 *   - 路径被占用但归属/分支不匹配、非 git 仓库、git 不可用、创建失败 → 抛出 GraphError 拒绝派发；
 *   - 绝不静默降级为主树执行。
 */
export function prepareAttemptWorktree(
  root: string,
  goalId: string,
  attemptId: string,
  opts: {
    enabled: boolean;
    baselineCommit?: string | null;
    reason?: string | null;
  },
): PrepareWorktreeResult {
  if (!opts.enabled) {
    return {
      enabled: false,
      worktree: false,
      // g-289：不再臆造 "user_choice" 兜底——未启用隔离的真实原因（explicit/type_default/
      // dirty 豁免等）由调用方解析后经 reason 透传，保证 attempt 记录可观测「为何没建树」。
      reason: opts.reason || null,
      created: false,
      reused: false,
    };
  }

  const mainWorktree = resolveCodeWorkspace(root);
  if (!mainWorktree) {
    throw new GraphError("当前工作区不是 Git 仓库或 git 不可用，无法创建隔离工作树（拒绝派发）");
  }

  try {
    git(mainWorktree, ["rev-parse", "--git-dir"]);
  } catch (e) {
    throw new GraphError(`Git 不可用或仓库无效（${(e as any)?.message ?? e}），无法创建隔离工作树（拒绝派发）`);
  }

  let baseline = "";
  if (opts.baselineCommit && opts.baselineCommit.trim()) {
    try {
      baseline = git(mainWorktree, ["rev-parse", "--verify", `${opts.baselineCommit.trim()}^{commit}`]);
    } catch {
      throw new GraphError(`基线 commit 无效或不存在（${opts.baselineCommit}），无法创建隔离工作树（拒绝派发）`);
    }
  } else {
    try {
      baseline = git(mainWorktree, ["rev-parse", "HEAD"]);
    } catch {
      throw new GraphError("仓库当前无有效提交（HEAD 不存在），无法创建隔离工作树（拒绝派发）");
    }
  }

  const seqMatch = attemptId.match(/^att-(\d+)$/);
  const seqNum = seqMatch ? Number(seqMatch[1]) : 1;
  const name2 = `${goalId}-att-${String(seqNum).padStart(2, "0")}`;
  const name3 = `${goalId}-att-${String(seqNum).padStart(3, "0")}`;

  const targetPath2 = resolve(mainWorktree, ".worktrees", name2);
  const targetPath3 = resolve(mainWorktree, ".worktrees", name3);

  let liveTrees: GitTree[] = [];
  try {
    liveTrees = trees(mainWorktree);
  } catch (e) {
    throw new GraphError(`无法读取 Git worktree 列表：${(e as any)?.message ?? e}`);
  }

  // 1. 检查是否存在已登记的匹配 worktree（支持两位或三位数字后缀）
  const existing2 = liveTrees.find((t) => resolve(t.path) === targetPath2);
  const existing3 = liveTrees.find((t) => resolve(t.path) === targetPath3);
  const matchedTree = existing2 || existing3;

  if (matchedTree) {
    const expectedBranch = matchedTree === existing2 ? name2 : name3;
    const actualBranch = matchedTree.branch?.replace(/^refs\/heads\//, "");
    const assoc = parseAssociation(matchedTree);
    if (actualBranch === expectedBranch && assoc.assoc?.goal === goalId && assoc.assoc?.attempt === attemptId) {
      // g-448：复用前必须核验**看板归属**——同仓库不同看板的 g-<n>/att-<NN> 路径与分支逐字相同，
      // 只凭路径/分支/编号匹配就复用会把别的看板的工作树当成本看板执行目录，并用本看板
      // canonical_root 覆盖旧看板已有绑定。归属只认已持久化的真实元信息，绝不猜旧命名。
      const callerRoot = resolve(root);
      const owner = readBoardOwner(matchedTree.path);
      if (owner) {
        if (canonicalPath(owner.canonical_root) !== canonicalPath(callerRoot)) {
          throw new GraphError(
            `工作树路径已被另一个看板占用（路径: ${matchedTree.path}, 分支: ${actualBranch}）` +
            `：该树已绑定看板 ${owner.canonical_root}，当前看板 ${callerRoot} 不得跨看板复用同号 worktree；` +
            `请由所属看板清理该树，或改用独立的代码仓库，拒绝派发`,
          );
        }
      } else if (!boardRecordedProvenance(root, matchedTree.path, goalId, attemptId)) {
        // 无归属标记且本看板事件流无 provenance ⇒ 无归属证明的孤儿/外部工作树：保守拒绝，
        // 绝不自动接管、改名或删除（可能是其他看板或用户手工创建的在用目录）。
        throw new GraphError(
          `工作树 ${matchedTree.path}（分支: ${actualBranch ?? "无"}）缺少可核验的看板归属证明` +
          `（既无归属标记，本看板事件流也无对应 attempt.started 记录）；` +
          `按保守策略拒绝复用与接管（不自动改名、不删除），拒绝派发`,
        );
      } else {
        // 旧树兼容：本目标上线前创建、无标记，但 provenance 证明属本看板 ⇒ 补写标记后幂等复用。
        writeBoardOwner(matchedTree.path, callerRoot, goalId, attemptId, expectedBranch);
      }
      let head = "";
      try {
        head = git(matchedTree.path, ["rev-parse", "HEAD"]);
      } catch {
        head = matchedTree.head ?? baseline;
      }
      return {
        enabled: true,
        created: false,
        reused: true,
        worktree: {
          path: matchedTree.path,
          relative_path: relative(mainWorktree, matchedTree.path),
          branch: `refs/heads/${expectedBranch}`,
          // 归属已核验：回传**已持久化**的归属根（与调用方一致），而不是无条件用调用方覆盖绑定。
          canonical_root: owner ? owner.canonical_root : callerRoot,
          head,
        },
      };
    } else {
      throw new GraphError(
        `工作树路径已存在但归属/分支不匹配（路径: ${matchedTree.path}, 分支: ${actualBranch ?? "无"}, 目标: ${goalId}, attempt: ${attemptId}），拒绝派发`,
      );
    }
  }

  // 2. 检查候选路径是否被文件系统占用（非有效 worktree 目录或残留）
  if (existsSync(targetPath2)) {
    throw new GraphError(`工作树路径已被文件系统占用且非有效工作树（路径: ${targetPath2}），拒绝派发`);
  }
  if (existsSync(targetPath3)) {
    throw new GraphError(`工作树路径已被文件系统占用且非有效工作树（路径: ${targetPath3}），拒绝派发`);
  }

  // 3. 检查分支是否已被其他 worktree 检出
  const checkedOut2 = liveTrees.find((t) => t.branch === name2 || t.branch === `refs/heads/${name2}`);
  if (checkedOut2) {
    throw new GraphError(`分支 ${name2} 已在其他工作树（${checkedOut2.path}）检出，无法创建工作树（拒绝派发）`);
  }
  const checkedOut3 = liveTrees.find((t) => t.branch === name3 || t.branch === `refs/heads/${name3}`);
  if (checkedOut3) {
    throw new GraphError(`分支 ${name3} 已在其他工作树（${checkedOut3.path}）检出，无法创建工作树（拒绝派发）`);
  }

  // 4. 真实创建 worktree（优先规范的 2 位序号后缀）
  const chosenName = name2;
  const chosenPath = targetPath2;

  let branchExists = false;
  try {
    git(mainWorktree, ["rev-parse", "--verify", `refs/heads/${chosenName}`]);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  try {
    mkdirSync(resolve(mainWorktree, ".worktrees"), { recursive: true });
    if (branchExists) {
      git(mainWorktree, ["worktree", "add", chosenPath, chosenName]);
    } else {
      git(mainWorktree, ["worktree", "add", "-b", chosenName, chosenPath, baseline]);
    }
  } catch (e) {
    throw new GraphError(
      `创建隔离工作树失败（路径: ${chosenPath}, 分支: ${chosenName}, 基线: ${baseline}）：${(e as any)?.message ?? e}`,
    );
  }

  let head = "";
  try {
    head = git(chosenPath, ["rev-parse", "HEAD"]);
  } catch {
    head = baseline;
  }

  // g-448：建树即写归属标记（该工作树自己的 Git 管理目录内）——后续任何看板的复用核验都以它为准。
  writeBoardOwner(chosenPath, root, goalId, attemptId, chosenName);

  return {
    enabled: true,
    created: true,
    reused: false,
    worktree: {
      path: chosenPath,
      relative_path: relative(mainWorktree, chosenPath),
      branch: `refs/heads/${chosenName}`,
      canonical_root: resolve(root),
      head,
    },
  };
}
