import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, mkdirSync } from "node:fs";
import { resolve, relative, join, sep, dirname } from "node:path";
import { appendEvent, readEvents, nowIso } from "./events.js";
import { discoverGitWorktree } from "./root.js";
import { findGoalFile, loadGoal } from "./ops.js";
import { GraphError } from "./machine.js";
function git(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function trees(cwd) {
    const lines = git(cwd, ["worktree", "list", "--porcelain"]).split(/\r?\n/);
    const result = [];
    let current = null;
    for (const line of lines) {
        if (line.startsWith("worktree ")) {
            if (current)
                result.push(current);
            current = { path: resolve(line.slice(9).trim()), head: null, branch: null };
        }
        else if (current && line.startsWith("HEAD "))
            current.head = line.slice(5).trim() || null;
        else if (current && line.startsWith("branch "))
            current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "") || null;
    }
    if (current)
        result.push(current);
    return result;
}
function goalStatus(root, goal) {
    try {
        return String(loadGoal(findGoalFile(root, goal)).meta.status ?? "");
    }
    catch {
        return null;
    }
}
function isActive(root, goal, attempt) {
    try {
        const file = join(dirname(findGoalFile(root, goal)), "attempts", attempt, "attempt.md");
        if (!existsSync(file))
            return true;
        const meta = loadGoal(file).meta;
        const result = meta.result;
        if (typeof result !== "string")
            return true;
        if (result !== "pending" && !["completed", "failed", "selected", "merged", "rejected", "superseded"].includes(result))
            return true;
        if (result !== "pending")
            return false;
        // g-247: structured state is authoritative; legacy text parsing is fallback only.
        if (["working", "blocked", "done", "error"].includes(meta.status_state))
            return meta.status_state === "working";
        const line = String(meta.status_line ?? "").trim().toLowerCase();
        const terminal = /(完成|完毕|空闲|等待\s*review|待命|已提交|结束|completed|idle|done|waiting\s*review)/i.test(line);
        // pending 且非明确终态一律保守视为活跃，包括 child 启动失败/本地执行。
        return !terminal;
    }
    catch {
        return true;
    }
}
function ancestor(cwd, head, target) {
    if (!head || !target)
        return false;
    try {
        git(cwd, ["merge-base", "--is-ancestor", head, target]);
        return true;
    }
    catch {
        return false;
    }
}
function parseAssociation(tree) {
    const pathName = tree.path.split(/[\\/]/).pop() ?? "";
    const pathMatch = pathName.match(/^g-(\d+)-att-(\d{2,3})$/);
    const branchMatch = tree.branch?.match(/^g-(\d+)-att-(\d{2,3})$/) ?? null;
    // g-272 att-002：reason 一律为稳定枚举（客户端按枚举做 i18n 双语映射），不再下发中文句子。
    if (!pathMatch)
        return { assoc: null, reason: "path_not_canonical_name" };
    const assoc = { goal: `g-${pathMatch[1]}`, attempt: `att-${String(Number(pathMatch[2])).padStart(3, "0")}` };
    if (tree.branch && !branchMatch)
        return { assoc, reason: "branch_not_canonical_name" };
    if (branchMatch && (branchMatch[1] !== pathMatch[1] || branchMatch[2] !== pathMatch[2]))
        return { assoc, reason: "path_branch_mismatch" };
    return { assoc };
}
function candidateId(goal, attempt, path) { return `${goal}:${attempt}:${path}`; }
function resolveCodeWorkspace(root) {
    const resolved = resolve(root);
    // g-149 / 独立数据仓库支持：如果 root 名为 .dsh-graph，且其父目录是 Git 仓库，真正的工程代码库是父目录
    const parent = dirname(resolved);
    const parentInfo = discoverGitWorktree(parent);
    if (parentInfo)
        return parentInfo.mainWorktree;
    const directInfo = discoverGitWorktree(resolved);
    return directInfo ? directInfo.mainWorktree : null;
}
export function listWorktrees(root, goalId) {
    const mainWorktree = resolveCodeWorkspace(root);
    if (!mainWorktree)
        return [];
    let list;
    try {
        list = trees(mainWorktree);
    }
    catch {
        return [];
    }
    const main = resolve(mainWorktree);
    const target = list[0]?.branch ?? null;
    const out = [];
    const events = readEvents(root);
    for (const tree of list) {
        if (resolve(tree.path) === main)
            continue;
        const rel = relative(main, tree.path);
        let real = tree.path;
        try {
            real = realpathSync(tree.path);
        }
        catch { /* deleted/invalid path remains protected */ }
        const realRel = relative(main, real);
        const inside = rel.startsWith(`.worktrees${sep}`) && realRel.startsWith(`.worktrees${sep}`) && !realRel.startsWith(`..${sep}`);
        const parsed = parseAssociation(tree);
        const assoc = parsed.assoc;
        if (!assoc || (goalId && assoc.goal !== goalId))
            continue;
        const id = candidateId(assoc.goal, assoc.attempt, tree.path);
        const registrations = events.filter(e => e.event === "worktree.candidate_registered" && e.details?.id === id);
        const registered = registrations.at(-1)?.details;
        const reused = events.some(e => (e.event === "worktree.cleaned" || e.event === "worktree.external_removed") && e.details?.id === id);
        const snapshotDrift = registered && (registered.path !== tree.path || registered.head !== tree.head || registered.branch !== tree.branch);
        const delivered = goalStatus(root, assoc.goal) === "delivered";
        let attemptMeta = null;
        try {
            const gf = findGoalFile(root, assoc.goal);
            const af = join(dirname(gf), "attempts", assoc.attempt, "attempt.md");
            if (existsSync(af))
                attemptMeta = loadGoal(af).meta;
        }
        catch { /* evidence missing */ }
        let clean = false;
        try {
            clean = git(tree.path, ["status", "--porcelain"]) === "";
        }
        catch {
            clean = false;
        }
        const active = isActive(root, assoc.goal, assoc.attempt);
        const merged = ancestor(main, tree.head, target);
        let status = "protected";
        let reason = null;
        if (!inside) {
            status = "unknown";
            reason = "outside_canonical_worktrees";
        }
        else if (reused) {
            status = "unknown";
            reason = "reuse_suspected";
        }
        else if (snapshotDrift) {
            status = "unknown";
            reason = "snapshot_drift";
        }
        else if (parsed.reason) {
            status = "unknown";
            reason = parsed.reason;
        }
        else if (!attemptMeta || String(attemptMeta.goal ?? "") !== assoc.goal || String(attemptMeta.id ?? "") !== assoc.attempt) {
            status = "unknown";
            reason = "missing_attempt_evidence";
        }
        else if (!delivered)
            reason = "not_delivered";
        else if (active)
            reason = "attempt_active";
        else if (!clean)
            reason = "worktree_dirty";
        else if (!merged) {
            status = "unknown";
            reason = "not_merged";
        }
        else
            status = "candidate";
        out.push({ id, ...assoc, path: tree.path, branch: tree.branch, head: tree.head, target_branch: target, merged, clean, active, status, reason, discovered_at: nowIso() });
    }
    const seen = new Set(out.map(x => x.id));
    for (const e of events.filter(e => e.event === "worktree.candidate_registered")) {
        const d = e.details;
        if (!d?.id || seen.has(d.id) || (goalId && e.goal !== goalId))
            continue;
        const external = events.some(x => x.event === "worktree.external_removed" && x.details?.id === d.id);
        const cleaned = events.some(x => x.event === "worktree.cleaned" && x.details?.id === d.id);
        out.push({ ...d, status: cleaned ? "cleaned" : "unknown", reason: cleaned ? "user_cleaned" : "externally_removed" });
        if (!external && !cleaned)
            appendEvent(root, { actor: "core", event: "worktree.external_removed", goal: e.goal, details: { id: d.id, path: d.path, removed_at: nowIso() } });
    }
    return out;
}
export function registerWorktreeCandidates(root, goal, actor = "core") {
    const found = listWorktrees(root, goal);
    const ids = new Set(readEvents(root).filter(e => e.event === "worktree.candidate_registered").map(e => String(e.details?.id)));
    for (const c of found)
        if (!ids.has(c.id))
            appendEvent(root, { actor, event: "worktree.candidate_registered", goal, details: c });
    return found;
}
export function cleanWorktree(root, id, actor = "human:gui", confirm = false) {
    const c = listWorktrees(root).find(x => x.id === id);
    if (!confirm)
        return { ok: false, ...(c ? { candidate: c } : {}), reason: "confirm_required" };
    const block = (reason) => { appendEvent(root, { actor, event: "worktree.clean_blocked", goal: c?.goal, details: { id, reason, candidate: c ?? null } }); return { ok: false, ...(c ? { candidate: c } : {}), reason }; };
    if (!c)
        return block("unknown_candidate");
    // g-272 att-002：枚举等值判断（原为对中文 reason 的字符串包含判断），语义不变。
    if (c.status === "cleaned" || (c.status === "unknown" && c.reason === "externally_removed"))
        return { ok: true, candidate: c, reason: "already_cleaned" };
    if (c.status !== "candidate")
        return block(c.reason ?? "protected");
    const mainWorktree = resolveCodeWorkspace(root);
    if (!mainWorktree)
        return block("git_unavailable");
    const main = resolve(mainWorktree);
    const rel = relative(main, resolve(c.path));
    if (rel === "" || rel.startsWith(`..${sep}`) || !(rel.startsWith(`.worktrees${sep}`)))
        return block("outside_canonical_worktrees");
    let live;
    try {
        live = trees(main).find(x => resolve(x.path) === resolve(c.path));
    }
    catch {
        return block("git_worktree_list_unavailable");
    }
    if (!live || live.head !== c.head || live.branch !== c.branch)
        return block("live_record_drift");
    let realPath;
    try {
        realPath = realpathSync(live.path);
    }
    catch {
        return block("realpath_unavailable");
    }
    const realRel = relative(main, realPath);
    if (!realRel.startsWith(`.worktrees${sep}`) || realRel === ".worktrees" || realRel.startsWith(`..${sep}`))
        return block("realpath_escape");
    if (goalStatus(root, c.goal) !== "delivered" || isActive(root, c.goal, c.attempt))
        return block("state_changed");
    try {
        git(main, ["worktree", "remove", c.path]);
        appendEvent(root, { actor, event: "worktree.cleaned", goal: c.goal, details: { ...c, cleaned_at: nowIso() } });
        return { ok: true, candidate: c };
    }
    catch (error) {
        return block(String(error instanceof Error ? error.message : error));
    }
}
/**
 * g-283：根据目标类型计算是否默认隔离 worktree 的纯函数：
 * patch / chore / task 默认不勾选（false）；
 * 其余（feature / bug / improvement 等）默认勾选（true）。
 * 空值/非法类型按默认类型 task 处理（false）。
 */
export function defaultWorktreeForGoalType(rawType) {
    if (rawType === null || rawType === undefined || rawType === "") {
        return false;
    }
    const t = String(rawType).trim().toLowerCase();
    if (t === "patch" || t === "chore" || t === "task") {
        return false;
    }
    return true;
}
/**
 * g-289：探测工作区/主工作树 Git 干净度（git status --porcelain）。
 * - clean=true：集成分支工作树干净，无未提交改动；
 * - clean=false：集成分支存在未提交改动（dirtyReason 记录 porcelain 摘要或状态）；
 * - clean=null：探测不可靠（非 git 仓库 / git 不可用 / 命令超时或执行失败）。
 *
 * 注：clean=null 只表示「拿不到可靠的干净度信号」。是否据此改变默认隔离，交由
 * {@link resolveWorktreeIsolationDecision} 结合可靠性语义裁定，见其注释。
 */
export function detectWorkspaceCleanliness(workspaceDir, gitRunner) {
    const runner = gitRunner ?? git;
    try {
        const out = runner(workspaceDir, ["status", "--porcelain"]);
        if (out.trim() === "") {
            return { clean: true };
        }
        const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const summary = lines.slice(0, 3).join("; ") + (lines.length > 3 ? ` ... (+${lines.length - 3} more)` : "");
        return { clean: false, dirtyReason: summary };
    }
    catch (err) {
        return { clean: null, error: String(err?.message ?? err) };
    }
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
export function resolveWorktreeIsolationDecision(rawType, explicitIsolate, probeState) {
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
    // 干净工作树、或探测不可靠（clean=null）/无 probe：按类型默认
    const byType = defaultWorktreeForGoalType(rawType);
    return {
        isolate: byType,
        reason: "type_default",
        ...(probeState ? { probeState } : {}),
    };
}
/**
 * g-283：派发前准备工作树（真实创建 / 幂等复用 / 失败即停）。
 * - enabled=false：不创建，返回 worktree=false 与原因；
 * - enabled=true：
 *   - 目标路径与分支已存在且匹配 → 复用（reused=true），不报错；
 *   - 路径被占用但归属/分支不匹配、非 git 仓库、git 不可用、创建失败 → 抛出 GraphError 拒绝派发；
 *   - 绝不静默降级为主树执行。
 */
export function prepareAttemptWorktree(root, goalId, attemptId, opts) {
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
    }
    catch (e) {
        throw new GraphError(`Git 不可用或仓库无效（${e?.message ?? e}），无法创建隔离工作树（拒绝派发）`);
    }
    let baseline = "";
    if (opts.baselineCommit && opts.baselineCommit.trim()) {
        try {
            baseline = git(mainWorktree, ["rev-parse", "--verify", `${opts.baselineCommit.trim()}^{commit}`]);
        }
        catch {
            throw new GraphError(`基线 commit 无效或不存在（${opts.baselineCommit}），无法创建隔离工作树（拒绝派发）`);
        }
    }
    else {
        try {
            baseline = git(mainWorktree, ["rev-parse", "HEAD"]);
        }
        catch {
            throw new GraphError("仓库当前无有效提交（HEAD 不存在），无法创建隔离工作树（拒绝派发）");
        }
    }
    const seqMatch = attemptId.match(/^att-(\d+)$/);
    const seqNum = seqMatch ? Number(seqMatch[1]) : 1;
    const name2 = `${goalId}-att-${String(seqNum).padStart(2, "0")}`;
    const name3 = `${goalId}-att-${String(seqNum).padStart(3, "0")}`;
    const targetPath2 = resolve(mainWorktree, ".worktrees", name2);
    const targetPath3 = resolve(mainWorktree, ".worktrees", name3);
    let liveTrees = [];
    try {
        liveTrees = trees(mainWorktree);
    }
    catch (e) {
        throw new GraphError(`无法读取 Git worktree 列表：${e?.message ?? e}`);
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
            }
            catch {
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
        }
        else {
            throw new GraphError(`工作树路径已存在但归属/分支不匹配（路径: ${matchedTree.path}, 分支: ${actualBranch ?? "无"}, 目标: ${goalId}, attempt: ${attemptId}），拒绝派发`);
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
    }
    catch {
        branchExists = false;
    }
    try {
        mkdirSync(resolve(mainWorktree, ".worktrees"), { recursive: true });
        if (branchExists) {
            git(mainWorktree, ["worktree", "add", chosenPath, chosenName]);
        }
        else {
            git(mainWorktree, ["worktree", "add", "-b", chosenName, chosenPath, baseline]);
        }
    }
    catch (e) {
        throw new GraphError(`创建隔离工作树失败（路径: ${chosenPath}, 分支: ${chosenName}, 基线: ${baseline}）：${e?.message ?? e}`);
    }
    let head = "";
    try {
        head = git(chosenPath, ["rev-parse", "HEAD"]);
    }
    catch {
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
