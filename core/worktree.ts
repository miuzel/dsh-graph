import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, mkdirSync } from "node:fs";
import { resolve, relative, join, sep, dirname } from "node:path";
import { appendEvent, readEvents, nowIso } from "./events.ts";
import { discoverGitWorktree } from "./root.ts";
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
function isActive(root: string, goal: string, attempt: string): boolean {
  try {
    const file = join(dirname(findGoalFile(root, goal)), "attempts", attempt, "attempt.md");
    if (!existsSync(file)) return true;
    const meta = loadGoal(file).meta as any;
    const result = meta.result;
    if (typeof result !== "string") return true;
    if (result !== "pending" && !["completed", "failed", "selected", "merged", "rejected", "superseded"].includes(result)) return true;
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

export interface PrepareWorktreeResult {
  enabled: boolean;
  worktree: Record<string, string> | false;
  reason?: string;
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
      reason: opts.reason || "user_choice",
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
          canonical_root: resolve(root),
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
