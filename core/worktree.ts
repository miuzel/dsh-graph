import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve, relative, join, sep, dirname } from "node:path";
import { appendEvent, readEvents, nowIso } from "./events.ts";
import { discoverGitWorktree } from "./root.ts";
import { findGoalFile, loadGoal } from "./ops.ts";

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
  if (!pathMatch) return { assoc: null, reason: "worktree 路径不是规范 goal-attempt 名称" };
  const assoc = { goal: `g-${pathMatch[1]}`, attempt: `att-${String(Number(pathMatch[2])).padStart(3, "0")}` };
  if (tree.branch && !branchMatch) return { assoc, reason: "worktree 分支不是规范 goal-attempt 名称" };
  if (branchMatch && (branchMatch[1] !== pathMatch[1] || branchMatch[2] !== pathMatch[2])) return { assoc, reason: "路径与分支的 goal/attempt 不一致" };
  return { assoc };
}
function candidateId(goal: string, attempt: string, path: string): string { return `${goal}:${attempt}:${path}`; }

export function listWorktrees(root: string, goalId?: string): WorktreeCandidate[] {
  const info = discoverGitWorktree(resolve(root)); if (!info) return [];
  let list: GitTree[]; try { list = trees(info.mainWorktree); } catch { return []; }
  const main = resolve(info.mainWorktree); const target = list[0]?.branch ?? null; const out: WorktreeCandidate[] = [];
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
    if (!inside) { status = "unknown"; reason = "路径不在 canonical workspace/.worktrees"; }
    else if (reused) { status = "unknown"; reason = "路径/attempt 已有清理历史，疑似复用"; }
    else if (snapshotDrift) { status = "unknown"; reason = "登记后的 path/branch/HEAD 已漂移"; }
    else if (parsed.reason) { status = "unknown"; reason = parsed.reason; }
    else if (!attemptMeta || String(attemptMeta.goal ?? "") !== assoc.goal || String(attemptMeta.id ?? "") !== assoc.attempt) { status = "unknown"; reason = "缺少匹配的 attempt.md 证据"; }
    else if (!delivered) reason = "目标未交付";
    else if (active) reason = "attempt 活跃";
    else if (!clean) reason = "工作树有未提交改动";
    else if (!merged) { status = "unknown"; reason = "HEAD 未由目标分支祖先链证明合入"; }
    else status = "candidate";
    out.push({ id, ...assoc, path: tree.path, branch: tree.branch, head: tree.head, target_branch: target, merged, clean, active, status, reason, discovered_at: nowIso() });
  }
  const seen = new Set(out.map(x => x.id));
  for (const e of events.filter(e => e.event === "worktree.candidate_registered")) {
    const d = e.details as any; if (!d?.id || seen.has(d.id) || (goalId && e.goal !== goalId)) continue;
    const external = events.some(x => x.event === "worktree.external_removed" && x.details?.id === d.id);
    const cleaned = events.some(x => x.event === "worktree.cleaned" && x.details?.id === d.id);
    out.push({ ...d, status: cleaned ? "cleaned" : "unknown", reason: cleaned ? "已由用户清理" : "worktree 已从 Git 实时列表消失（外部删除）" });
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
  if (!confirm) return { ok: false, ...(c ? { candidate: c } : {}), reason: "需要用户明确确认" };
  const block = (reason: string) => { appendEvent(root, { actor, event: "worktree.clean_blocked", goal: c?.goal, details: { id, reason, candidate: c ?? null } }); return { ok: false, ...(c ? { candidate: c } : {}), reason }; };
  if (!c) return block("未知候选 id");
  if (c.status === "cleaned" || (c.status === "unknown" && c.reason?.includes("外部删除"))) return { ok: true, candidate: c, reason: "already_cleaned" };
  if (c.status !== "candidate") return block(c.reason ?? "候选受保护");
  const info = discoverGitWorktree(resolve(root)); if (!info) return block("Git 不可用");
  const main = resolve(info.mainWorktree); const rel = relative(main, resolve(c.path));
  if (rel === "" || rel.startsWith(`..${sep}`) || !(rel.startsWith(`.worktrees${sep}`))) return block("路径不在 canonical workspace/.worktrees");
  let live: GitTree | undefined; try { live = trees(main).find(x => resolve(x.path) === resolve(c.path)); } catch { return block("Git worktree 列表不可用"); }
  if (!live || live.head !== c.head || live.branch !== c.branch) return block("worktree 实时记录已漂移");
  let realPath: string; try { realPath = realpathSync(live.path); } catch { return block("worktree realpath 不可用"); }
  const realRel = relative(main, realPath);
  if (!realRel.startsWith(`.worktrees${sep}`) || realRel === ".worktrees" || realRel.startsWith(`..${sep}`)) return block("worktree realpath 越界或为符号链接");
  if (goalStatus(root, c.goal) !== "delivered" || isActive(root, c.goal, c.attempt)) return block("目标或 attempt 状态已变化");
  try { git(main, ["worktree", "remove", c.path]); appendEvent(root, { actor, event: "worktree.cleaned", goal: c.goal, details: { ...c, cleaned_at: nowIso() } }); return { ok: true, candidate: c }; }
  catch (error) { return block(String(error instanceof Error ? error.message : error)); }
}
