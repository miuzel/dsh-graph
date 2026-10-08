import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, relative, join, sep, dirname, isAbsolute } from "node:path";
import { appendEvent, readEvents, nowIso } from "./events.ts";
import { discoverGitWorktree, isScratchWorkspace } from "./root.ts";
import { parseNumstatZ, parsePorcelainZ, summarizeProductLinesStrict } from "./review-policy.ts";
import { atomicWrite, findGoalFile, loadGoal } from "./ops.ts";
import { GraphError } from "./machine.ts";

export interface WorktreeCandidate {
  id: string; goal: string; attempt: string; path: string; branch: string | null;
  head: string | null; target_branch: string | null; merged: boolean; clean: boolean;
  active: boolean; status: "candidate" | "protected" | "unknown" | "cleaned";
  reason: string | null; discovered_at: string;
  /**
   * g-449：该树已被**另一个**看板认领时的归属根（跨板冲突的观测字段，可缺省）。
   * 只在确实读到「归属标记指向他板」时出现；无标记/标记属本板/标记不可读 ⇒ 不出现。
   * 注意状态与 reason 仍只用既有枚举（`status="protected"` / `reason="protected"`），
   * 本字段是**加法式**观测通道，不扩充任何枚举集合。
   */
  board_owner_root?: string | null;
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
/**
 * 归属标记的 schema（写入真源 `writeBoardOwner` 已改为**同目录临时文件 + `rename` 原子替换**，
 * 故磁盘上只可能出现「完整标记」或「根本没有标记」，不会再产出半份标记）。
 *
 * **损坏标记的既有语义（g-451 显式记录，只记录、不改语义）**：以下四种形态一律由 `readBoardOwner`
 * 返回 null，即「无归属证明」——
 *   ① 空文件（0 字节）；② 半 JSON（被截断 / 语法错）；③ 缺字段（无 `canonical_root`）；
 *   ④ 空 root（`canonical_root` 只有空白字符）。
 * 对**清理面**而言「无归属证明 ⇒ 沿用 g-449 既有取舍放行」（`foreignBoardOwnerRoot` 返回 null，
 * 不 fail-closed）：清理面保守拒绝会把 legacy / 孤儿工作树永久锁死（g-449 判据 2 的兼容约束，
 * 既有 `core/tests/worktree.test.ts` 即以「无标记树必须可清理」为真源）。
 * 因此本目标只消除**写入侧**的截断窗口（真实崩溃/断电不再产出 ①–④ 中的任何一种），
 * **不**把「标记损坏」升级成拒绝理由、**不**新增任何 fail-closed 门禁。
 */
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
/**
 * 读取已持久化的看板归属标记。
 *
 * 缺失 / 不可读 / 损坏一律返回 null（按「无归属证明」保守处理）——损坏的四种形态
 * （① 空文件、② 半 JSON、③ 缺 `canonical_root`、④ `canonical_root` 为空白串，见
 * `BoardOwnerMarker` 的 schema 注释）与「标记文件不存在」**同值**；复用面
 * （`prepareAttemptWorktree`）与清理面（`foreignBoardOwnerRoot`）各按已定语义处理。
 * g-451 只把**写入**改成原子替换（新写入的标记不会再退化成这四形态），读取侧语义逐字不变。
 */
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
 *
 * g-451：改用 `atomicWrite`（**同目录**临时文件 + fsync + `rename` 原子替换）——真实崩溃/断电
 * 只会留下「旧的完整标记」或「没有标记」，不再留下被截断的半文件/空文件（那会静默退化为
 * 「无归属证明」，让跨看板保护静默失效）。标记的**文件路径、字段集合与内容字节**
 * （`JSON.stringify(marker) + "\n"`）逐字不变；写失败时由 `atomicWrite` 自行清掉临时文件，
 * 本函数只回 false（零残留、不留半文件）。
 */
function writeBoardOwner(worktreePath: string, root: string, goalId: string, attemptId: string, branch: string | null): boolean {
  const dir = worktreeGitDir(worktreePath);
  if (!dir) return false;
  try {
    const marker: BoardOwnerMarker = {
      canonical_root: resolve(root), goal: goalId, attempt: attemptId, branch, created_at: nowIso(),
    };
    atomicWrite(join(dir, BOARD_OWNER_MARKER), `${JSON.stringify(marker)}\n`);
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

/**
 * g-449：**清理面**的跨看板归属核验（复用 g-448 的同一归属真源，不新造第二套解析）。
 *
 * 返回「该树已被**另一个**看板认领」的归属根；以下三种情况一律返回 null（即无跨板冲突）：
 *  1. **无归属标记**（本目标上线前的旧树、手工/外部建树）⇒ null。判据 2 的兼容约束要求这类
 *     树保持**既有可清理行为**（`core/tests/worktree.test.ts` 既有断言即以「无标记 + 无 provenance
 *     的树必须可被清理」为真源），故清理面**不得**把「无归属证明」保守升级为拒绝——否则遗留树
 *     将永久不可清理。这也正是清理面与 `prepareAttemptWorktree` 复用面的**有意差异**：
 *     复用面保守拒绝只是不派发（零损失），清理面保守拒绝则会把可用工作树锁死。
 *  2. **标记损坏/不可读** ⇒ `readBoardOwner` 返回 null ⇒ 与 1 同类（无归属证明），保持可清理。
 *  3. **标记归属就是本看板** ⇒ null（本板自己的树，照常可清理）。
 *
 * 归属标记是**权威**且跨看板可读（写在树自己的 Git 管理目录内）；本看板事件 provenance
 * 只是板内自证（`startAttempt` 无 worktree 选项时不会写入，且历史上被 g-448 误复用的板
 * 会用它覆盖他板路径），故**绝不**用它去推翻一份指向他板的真实标记。
 * 只读、无副作用；不自动接管、不改名、不删除任何树。
 */
function foreignBoardOwnerRoot(root: string, worktreePath: string): string | null {
  const owner = readBoardOwner(worktreePath);
  if (!owner) return null;
  return canonicalPath(owner.canonical_root) === canonicalPath(resolve(root)) ? null : owner.canonical_root;
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
    // g-449：跨看板归属核验——同仓库各看板的 `.worktrees/g-<n>-att-<NN>` 路径与分支逐字相同，
    // 只按路径名解析出的 goal/attempt 会把**别的看板**的树当成本看板的清理候选（实测 B 板据此
    // 删掉 A 板的树）。故先读该树自己的归属标记：明确指向他板 ⇒ 绝不作为本板候选（保护而非删除）。
    const foreignRoot = foreignBoardOwnerRoot(root, tree.path);
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
    // g-449：归属他板的树优先判为 protected（reuse 既有的 protected 状态与 reason 枚举，
    // **不扩充** status/reason 集合）；归属根经加法式 board_owner_root 通道下发供观测。
    if (foreignRoot) { status = "protected"; reason = "protected"; }
    else if (!inside) { status = "unknown"; reason = "outside_canonical_worktrees"; }
    else if (reused) { status = "unknown"; reason = "reuse_suspected"; }
    else if (snapshotDrift) { status = "unknown"; reason = "snapshot_drift"; }
    else if (parsed.reason) { status = "unknown"; reason = parsed.reason; }
    else if (!attemptMeta || String(attemptMeta.goal ?? "") !== assoc.goal || String(attemptMeta.id ?? "") !== assoc.attempt) { status = "unknown"; reason = "missing_attempt_evidence"; }
    else if (!delivered) reason = "not_delivered";
    else if (active) reason = "attempt_active";
    else if (!clean) reason = "worktree_dirty";
    else if (!merged) { status = "unknown"; reason = "not_merged"; }
    else status = "candidate";
    out.push({ id, ...assoc, path: tree.path, branch: tree.branch, head: tree.head, target_branch: target, merged, clean, active, status, reason, discovered_at: nowIso(), ...(foreignRoot ? { board_owner_root: foreignRoot } : {}) });
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
  // g-449：清理面的**权威**跨看板归属闸门（不依赖 listWorktrees 的状态判定，删除前再核验一次）——
  // 该树已被另一个看板认领 ⇒ 拒绝，零副作用（不删目录、不迁状态、不留半清理残留），
  // 且理由**点名归属看板根**，便于人工交由其所属看板处置。归属真源与 g-448 复用面同一份
  // （工作树自身 Git 管理目录内的归属标记 + canonicalPath 归一）。
  // 无标记 / 标记属本板 / 标记不可读 ⇒ 不拦（判据 2：既有与遗留树的可清理行为不得回归）。
  const foreignRoot = foreignBoardOwnerRoot(root, c.path);
  if (foreignRoot) {
    return block(
      `跨看板清理被拒绝：工作树 ${c.path} 已绑定看板 ${foreignRoot}，当前看板 ${resolve(root)} 无权清理；` +
      `请由所属看板处置（不自动删除、不接管、不改名）`,
    );
  }
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
    const { statusPathRoot, owned } = resolveOwnedUntrackedRoots(workspaceDir, graphRoot, runner);
    const out = runner(workspaceDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const entries = out.includes("\0")
      ? out.split("\0").filter(Boolean)
      : out.split(/\r?\n/).filter((entry) => entry.trim().length > 0);
    const remaining = entries.filter((entry) => {
      const status = entry.slice(0, 2);
      if (status !== "??" || owned.size === 0) return true;
      const path = entry.slice(3).replace(/[\\/]$/, "");
      return !isOwnedUntrackedPath(resolve(statusPathRoot, path), owned);
    });
    if (remaining.length === 0) return { clean: true };
    const summary = remaining.slice(0, 3).join("; ") + (remaining.length > 3 ? ` ... (+${remaining.length - 3} more)` : "");
    return { clean: false, dirtyReason: summary };
  } catch (err: any) {
    return { clean: null, error: String(err?.message ?? err) };
  }
}

/**
 * g-443/g-437：插件自有「未跟踪」根的**真实归属**解析——单一实现，两处消费
 * （{@link detectWorkspaceCleanliness} 的干净度探测；g-437 门禁③的 Git 真源采集）。
 *
 * 归属证据两级，都不靠目录名字猜：
 *  1. **配置的看板根自身**——且必须是本仓库的**严格后代**（防止把「项目根是看板根祖先」
 *     的误配置当成豁免，从而隐藏普通项目文件）；
 *  2. **Git 当前注册**且本看板 `attempt.started` 事件记录了**精确路径**的工作树。
 *
 * 两者皆不满足 ⇒ 不是插件自有 ⇒ 未跟踪即真实用户文件。
 * **tracked 状态永不豁免**（调用方按状态码分流，本函数只回答路径归属）。
 */
export function resolveOwnedUntrackedRoots(
  workspaceDir: string,
  graphRoot?: string | null,
  gitRunner?: (cwd: string, args: string[]) => string,
): { statusPathRoot: string; owned: Set<string> } {
  const runner = gitRunner ?? git;
  // Git's -z porcelain paths are always relative to the repository top level,
  // even when status is invoked from a nested workspace directory.
  const statusPathRoot = graphRoot
    ? resolve(String(runner(workspaceDir, ["rev-parse", "--show-toplevel"])).trim())
    : resolve(workspaceDir);
  const owned = new Set<string>();
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
    if (graphIsInsideRepo) owned.add(graphPath);

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
      for (const path of registered) if (recorded.has(path)) owned.add(path);
    } catch {
      // Missing or unreadable provenance fails closed: only graph-root data is exempt.
    }
  }
  return { statusPathRoot, owned };
}

/** 该绝对路径是否落在某个插件自有未跟踪根之内（含根自身）。 */
export function isOwnedUntrackedPath(absolutePath: string, owned: Iterable<string>): boolean {
  for (const root of owned) {
    const rel = relative(root, absolutePath);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return true;
  }
  return false;
}

/** g-437：**原始** git runner（返回 stdout 原文，绝不 trim——NUL 输出按字节解析）。 */
export type RawGitRunner = (cwd: string, args: string[]) => string;

function gitRaw(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * g-437 P1：读取某目录所属仓库当前的 `HEAD` commit（**引擎已知事实**，供派发端落盘区间锚点）。
 *
 * 非隔离 attempt（`worktree: false`）在工作区仓库根执行，其记录里没有 `worktree.head`，
 * 若不落盘锚点，门禁③的采集区间就只能由调用方报告给定（= 可把基线取到自己的 HEAD 自我归零）。
 * 故派发时用本函数取「派发那一刻的 HEAD」作为基线落盘；**只要有一个字节能证明它不是 Git
 * commit 就返回 null**（非 Git 仓库 / 无提交 / git 不可用）——调用方按「无锚点」处理（fail-closed），
 * 绝不猜测、绝不抛错中断派发。
 */
export function readRepoHead(dir: string, runner: RawGitRunner = gitRaw): string | null {
  try {
    const out = String(runner(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) ?? "").trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** g-437：门禁③真源采集绑定的执行树。 */
export interface AttemptGitTruthTree {
  /** 实际执行 git 的目录（绝对路径）。 */
  path: string;
  /** `git rev-parse --show-toplevel`（porcelain/numstat 路径的锚点，等于仓库根）。 */
  toplevel: string;
  /** 绑定来源：隔离 attempt 工作树 / 显式记录为非隔离的工作区仓库。 */
  isolation: "isolated_worktree" | "non_isolated_workspace";
}

/** g-437：引擎从实际 attempt 树采集到的门禁③真源事实（路径一律 repo-root-relative）。 */
export interface AttemptGitTruth {
  tree: AttemptGitTruthTree;
  /** **引擎侧**区间锚点原文（来自 attempt 记录，绝不来自报告；报告值只用于比对）。 */
  baseline_commit: string;
  /** 锚点解析出的 commit SHA。 */
  baseline_resolved: string;
  /** 锚点取自 attempt 记录的哪个字段（审计用；不接受「报告给的区间」）。 */
  anchor_source: "attempt_baseline" | "attempt_worktree_head";
  head: string;
  changed_paths: string[];
  product_changed_lines: number;
  product_files: string[];
  untracked_files: number;
  untracked_paths: string[];
}

export type AttemptGitTruthResult = { ok: true; truth: AttemptGitTruth } | { ok: false; reason: string };

const shortList = (paths: readonly string[], n = 3) =>
  paths.slice(0, n).map((p) => (p.length > 80 ? `${p.slice(0, 77)}…` : p)).join(" / ") +
  (paths.length > n ? ` … (+${paths.length - n})` : "");

/**
 * g-437：门禁③的 **Git 真源采集 + 绑定**（只读；不写事件、不改文件、不建目录）。
 *
 * 绑定规则（fail-safe，全部失败路径都返回 `{ok:false}`，绝不静默回退）：
 *  1. attempt 持久化了 `worktree.path` ⇒ 只在**该树**采集，并要求它此刻仍是 Git **实时注册**
 *     的工作树、且其 `--show-toplevel` 就是它自己；缺失/已删/未注册/指向主工作树 ⇒ 拒绝，
 *     **绝不回退主树**。
 *  2. attempt 显式记录 `worktree: false`（非隔离）⇒ 绑定其工作区仓库（那是该 attempt **实际**
 *     运行的位置，非回退），并在事件里标注 `non_isolated_workspace`。
 *  3. 记录形态未知（既非含 path 的对象也不是 false）⇒ 拒绝（不接受「猜测执行树」）。
 *  4. Git 不可用 / 基线不可解析 / numstat|porcelain 输出不可解析 ⇒ 拒绝。
 *  5. 存在**未提交 tracked 改动**（staged/unstaged/deleted/rename）⇒ 拒绝：`baseline..HEAD`
 *     看不到它们，只数未跟踪会漏。
 *  6. **区间锚点只来自 attempt 记录**（`baseline_commit`，其次 `worktree.head`）；报告里的
 *     `baseline_commit` 只用于比对，不一致或锚点缺失/不可解析一律拒绝（P1：否则调用方可把
 *     基线取到自己的 HEAD，使 diff 恒为空而必然放行）。
 */
export function collectAttemptGitTruth(opts: {
  /** 看板根所在的工作区（`dirname(boardRoot)`）。 */
  workspaceDir: string;
  /** 看板根（归属判定用，与 g-443 同一实现）。 */
  graphRoot: string;
  /** attempt 持久化的 `meta.worktree` 原值。 */
  attemptWorktree: unknown;
  /** 调用方报告的基线原文。 */
  baseline: string | null;
  /** attempt 持久化的基线（存在且可解析时用于绑定，防止「基线取 HEAD」自我归零）。 */
  attemptBaseline?: string | null;
  nonProductPrefixes?: readonly string[] | null;
  runner?: RawGitRunner;
}): AttemptGitTruthResult {
  const runner = opts.runner ?? gitRaw;
  const baseline = typeof opts.baseline === "string" ? opts.baseline.trim() : "";
  if (baseline === "") return { ok: false, reason: "机器报告缺少 baseline_commit（门禁③必填）" };
  const canonical = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

  const wt = opts.attemptWorktree as any;
  const recordedPath = wt && typeof wt === "object" && typeof wt.path === "string" && wt.path.trim() !== ""
    ? resolve(wt.path.trim())
    : null;

  let tree: string;
  let isolation: AttemptGitTruthTree["isolation"];
  if (recordedPath) {
    let realRecorded: string;
    try {
      realRecorded = realpathSync(recordedPath);
    } catch {
      return { ok: false, reason: `attempt 工作树不存在或不可读（${recordedPath}）——缺失/已删一律不放行，不回退主树` };
    }
    let listing: string;
    try {
      listing = runner(opts.workspaceDir, ["worktree", "list", "--porcelain"]);
    } catch (e: any) {
      return { ok: false, reason: `Git worktree 列表不可用（${String(e?.message ?? e)}）` };
    }
    const registered = listing.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter(Boolean);
    if (registered.length === 0) return { ok: false, reason: "Git worktree 列表为空（无法确认 attempt 树归属）" };
    const mainWorktree = canonical(registered[0]);
    if (canonical(realRecorded) === mainWorktree) {
      return { ok: false, reason: `attempt 记录的 worktree 指向主工作树（${recordedPath}）——门禁③只接受隔离 attempt 树` };
    }
    if (!registered.some((p) => canonical(p) === canonical(realRecorded))) {
      return { ok: false, reason: `attempt 工作树已不在 Git 注册列表中（${recordedPath}）——缺失/已删一律不放行，不回退主树` };
    }
    let toplevelRaw: string;
    try {
      toplevelRaw = runner(realRecorded, ["rev-parse", "--show-toplevel"]).trim();
    } catch (e: any) {
      return { ok: false, reason: `attempt 工作树不可用（${String(e?.message ?? e)}）` };
    }
    if (toplevelRaw === "" || canonical(toplevelRaw) !== canonical(realRecorded)) {
      return { ok: false, reason: `attempt 工作树的 Git 根与记录路径不一致（记录 ${recordedPath} / 实际 ${toplevelRaw || "未知"}）` };
    }
    tree = realRecorded;
    isolation = "isolated_worktree";
  } else if (wt === false) {
    try {
      const toplevelRaw = runner(opts.workspaceDir, ["rev-parse", "--show-toplevel"]).trim();
      if (toplevelRaw === "") return { ok: false, reason: "工作区不在 Git 仓库内（无法绑定非隔离 attempt 的执行树）" };
      tree = resolve(toplevelRaw);
    } catch (e: any) {
      return { ok: false, reason: `Git 不可用（${String(e?.message ?? e)}）` };
    }
    isolation = "non_isolated_workspace";
  } else {
    return {
      ok: false,
      reason: "attempt 记录缺少可绑定的执行树证据（worktree 既不是含 path 的对象，也不是显式的 false）——拒绝猜测",
    };
  }

  const revParse = (rev: string): string | null => {
    try {
      const out = runner(tree, ["rev-parse", "--verify", "--quiet", rev]).trim();
      return out === "" ? null : out;
    } catch {
      return null;
    }
  };

  // g-437 P1（修复「自我归零」旁路）：**区间锚点只能来自 attempt 记录，绝不来自报告** —— 否则
  // 调用方只要把报告的 baseline 取到自己的 HEAD，diff 就恒为空（0 行 0 未跟踪）必然放行。
  // 锚点优先级（都属「引擎已知/派发时落盘」的事实）：
  //   ① attempt.md 持久化的 `baseline_commit`（主管显式给出，或由派发端按引擎已知事实落盘）；
  //   ② attempt 记录里的 `worktree.head`（派发时该工作树的实际起点，兼容未持久化基线的旧记录）。
  // 报告里的 `baseline_commit` **只用于与锚点比对**，任何情况下都不用于确定采集区间。
  const attemptBaseline = typeof opts.attemptBaseline === "string" ? opts.attemptBaseline.trim() : "";
  const recordedHead = wt && typeof wt === "object" && typeof (wt as any).head === "string"
    ? String((wt as any).head).trim()
    : "";
  const anchorIsPersisted = attemptBaseline !== "";
  const anchorSource = anchorIsPersisted ? "attempt.baseline_commit" : "attempt.worktree.head";
  const engineAnchor = attemptBaseline !== "" ? attemptBaseline : recordedHead;
  if (engineAnchor === "") {
    return {
      ok: false,
      reason:
        "该 attempt 未记录任何引擎侧区间锚点（attempt.baseline_commit 与 worktree.head 均缺失）"
        + "——门禁③不接受由报告自选区间：请用显式 baseline_commit 重新派发该 attempt，或改走普通 accept 路径",
    };
  }
  const anchorResolved = revParse(`${engineAnchor}^{commit}`);
  if (anchorResolved === null) {
    return {
      ok: false,
      reason: `attempt 记录基线不可解析（${engineAnchor}，来源 ${anchorSource}）——fail-safe 不放行`,
    };
  }
  const baselineResolved = revParse(`${baseline}^{commit}`);
  if (baselineResolved === null) {
    return {
      ok: false,
      reason: `基线不可解析（机器报告 baseline_commit=${baseline}）——请给与该 attempt 记录一致、且本仓库可解析的 commit`,
    };
  }
  if (baselineResolved !== anchorResolved) {
    return {
      ok: false,
      reason:
        `机器报告 baseline_commit（${baseline}）与 attempt 持久化基线/工作树 head（${engineAnchor}，来源 ${anchorSource}）不一致`
        + "——区间锚点只能来自 attempt 记录，不接受把基线取到 HEAD 自我归零",
    };
  }
  const head = revParse("HEAD");
  if (head === null) return { ok: false, reason: "无法解析 HEAD（Git 不可用或工作树损坏）" };

  let numstatOut: string;
  let statusOut: string;
  try {
    numstatOut = runner(tree, ["diff", "--numstat", "-z", baselineResolved, head]);
    statusOut = runner(tree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  } catch (e: any) {
    return { ok: false, reason: `Git 采集命令失败（${String(e?.message ?? e)}）——fail-safe 不放行` };
  }

  const numstat = parseNumstatZ(numstatOut);
  if (numstat.malformed.length > 0) {
    return { ok: false, reason: `numstat 输出不可解析（${shortList(numstat.malformed)}）——解析不了即不放行` };
  }
  const status = parsePorcelainZ(statusOut);
  if (status.malformed.length > 0) {
    return { ok: false, reason: `status 输出不可解析（${shortList(status.malformed)}）——解析不了即不放行` };
  }

  const tracked = status.entries.filter((e) => e.status !== "??");
  if (tracked.length > 0) {
    const labels = tracked.map((e) => `${e.status} ${e.paths[0]}`);
    return {
      ok: false,
      reason: `存在未提交的 tracked 改动（${shortList(labels)}）——baseline..HEAD 看不到 staged/unstaged/deleted，必须先提交`,
    };
  }

  let ownership: { statusPathRoot: string; owned: Set<string> };
  try {
    ownership = resolveOwnedUntrackedRoots(tree, opts.graphRoot, runner as (cwd: string, args: string[]) => string);
  } catch (e: any) {
    return { ok: false, reason: `无法解析插件自有目录归属（${String(e?.message ?? e)}）——fail-safe 不放行` };
  }
  // 采集树**自身**不是「插件自有目录」：g-443 的归属清单里，本 attempt 的工作树既已注册、
  // 又在 attempt.started 里留痕，若原样沿用会把树内**全部**未跟踪文件当插件数据豁免
  // （真实用户文件随之漏计）。故这里只剔除采集树根；树内**嵌套**的其他插件工作树仍按归属排除。
  const treeRoot = canonical(tree);
  const ownedRoots = new Set<string>();
  for (const root of ownership.owned) if (canonical(root) !== treeRoot) ownedRoots.add(root);
  const untrackedPaths: string[] = [];
  for (const entry of status.entries) {
    if (entry.status !== "??") continue;
    const absolute = resolve(ownership.statusPathRoot, entry.paths[0].replace(/[\\/]$/, ""));
    if (isOwnedUntrackedPath(absolute, ownedRoots)) continue;
    untrackedPaths.push(entriesRelPath(ownership.statusPathRoot, absolute));
  }

  const strict = summarizeProductLinesStrict(numstat.entries, opts.nonProductPrefixes);
  if (strict.malformed.length > 0) {
    return { ok: false, reason: `产品码行数不可解析（${shortList(strict.malformed)}）——不得按 0 行放行` };
  }

  const changed = [...new Set(numstat.entries.flatMap((e) => e.paths))].sort();
  return {
    ok: true,
    truth: {
      tree: { path: tree, toplevel: ownership.statusPathRoot, isolation },
      baseline_commit: engineAnchor,
      baseline_resolved: anchorResolved,
      anchor_source: anchorIsPersisted ? "attempt_baseline" : "attempt_worktree_head",
      head,
      changed_paths: changed,
      product_changed_lines: strict.lines,
      product_files: strict.files,
      untracked_files: untrackedPaths.length,
      untracked_paths: untrackedPaths,
    },
  };
}

/** 绝对路径 → repo-root-relative（未跟踪路径报告口径与 numstat/porcelain 一致）。 */
function entriesRelPath(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel.split(sep).join("/");
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
