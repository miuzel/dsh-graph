import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { init, createGoal, setCriteria, goalDetail, findGoalFile, loadGoal } from "../ops.ts";
import { appendEvent } from "../events.ts";
import { prepareAttemptWorktree, readBoardOwner } from "../worktree.ts";
import { apply } from "../../dist/index.js";

/**
 * g-448：同一 Git 仓库内多块看板的 **worktree 归属保护**（跨看板同号误复用）。
 *
 * 已核实缺陷（本目标基线 `e3d98cf` 实拍，见 attempt 夹具与 attempt 记录）：
 * 默认看板 `<repo>/.dsh-graph` 与自定义看板 `<repo>/boards/board-n/.dsh-graph` 由真实 Git 发现
 * 解析出**同一主工作树** ⇒ `.worktrees/g-<goal>-att-<NN>` 路径与分支名逐字相同。修复前
 * `prepareAttemptWorktree` 只核路径/分支/编号即复用，并把 `canonical_root` 记为**当前调用方**
 * 的看板根 ⇒ B 板**静默**把 A 板的工作树当自己的执行目录，且覆盖 A 的绑定。
 *
 * 本目标的不变式（实现见 `core/worktree.ts` 的归属标记 + 事件 provenance）：
 *  1. 跨看板同号 ⇒ **明确拒绝**（GraphError、清晰理由、零副作用），绝不静默复用、绝不覆盖旧绑定；
 *  2. 同看板同 attempt ⇒ 幂等复用；默认单看板既有命名 `.worktrees/g-<goal>-att-<NN>` / 同名分支逐字不变；
 *  3. 无归属证明的孤儿/外部工作树 ⇒ 保守拒绝，不接管、不改名、不删除；
 *  4. 普通自定义根定位不回归；嵌套 Git 数据根「父仓库优先」歧义条件复现并如实列为未修/范围外。
 */

const REPO_ROOT = join(import.meta.dirname, "../..");
const WORKTREE_SOURCE = join(REPO_ROOT, "core/worktree.ts");
const DISPATCH_SOURCE = join(REPO_ROOT, "dsh-graph-host/index.js");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function canonical(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}
function registeredTrees(cwd: string): string[] {
  return git(cwd, "worktree", "list", "--porcelain")
    .split(/\r?\n/).filter((l) => l.startsWith("worktree "))
    .map((l) => canonical(l.slice("worktree ".length).trim()));
}
/** 私有夹具仓库：`.worktrees/` 与 `.dsh-graph/` 均被忽略（与真实仓库同构，不污染干净度判定）。 */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "g448-board-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README"), "x");
  writeFileSync(join(dir, ".gitignore"), ".worktrees/\n.dsh-graph/\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
}
function boardDir(ws: string, name: string): string {
  const dir = name === "default" ? join(ws, ".dsh-graph") : join(ws, "boards", name, ".dsh-graph");
  mkdirSync(dirname(dir), { recursive: true });
  init(dir);
  return dir;
}
function boardOwnerMarker(worktreePath: string): string | null {
  try {
    return join(git(worktreePath, "rev-parse", "--absolute-git-dir"), "dsh-graph-board-owner.json");
  } catch { return null; }
}

// ============================================================================
// 判据 2：同看板同 attempt 幂等复用 + 单看板既有命名/行为兼容
// ============================================================================

test("g-448 判据 2：同看板同 attempt 幂等复用，且默认单看板命名/分支逐字兼容", () => {
  const ws = repo(); const rootA = boardDir(ws, "default");
  const first = prepareAttemptWorktree(rootA, "g-448", "att-003", { enabled: true });
  assert.equal(first.created, true); assert.equal(first.reused, false);
  // 既有命名契约逐字不变（不接受任何「顺手改名」）
  assert.equal(first.worktree.relative_path, join(".worktrees", "g-448-att-03"));
  assert.equal(first.worktree.branch, "refs/heads/g-448-att-03");
  assert.equal(first.worktree.canonical_root, rootA);
  assert.equal(git(ws, "-C", first.worktree.path, "branch", "--show-current"), "g-448-att-03");

  const again = prepareAttemptWorktree(rootA, "g-448", "att-003", { enabled: true });
  assert.equal(again.reused, true); assert.equal(again.created, false);
  assert.equal(again.worktree.path, first.worktree.path);
  assert.equal(again.worktree.branch, first.worktree.branch);
  assert.equal(again.worktree.canonical_root, rootA);
  assert.equal(registeredTrees(ws).length, 2, "幂等复用不得新增注册工作树（仅主树 + 该树）");
});

test("g-448 判据 1/2：归属标记落盘在工作树自己的 git 管理目录，且不污染工作区", () => {
  const ws = repo(); const rootA = boardDir(ws, "default");
  const r = prepareAttemptWorktree(rootA, "g-1", "att-001", { enabled: true });
  const marker = boardOwnerMarker(r.worktree.path);
  assert.ok(marker && existsSync(marker), "建树时必须写归属标记");
  const parsed = JSON.parse(readFileSync(marker!, "utf8"));
  assert.equal(parsed.canonical_root, rootA);
  assert.equal(parsed.goal, "g-1"); assert.equal(parsed.attempt, "att-001");
  assert.deepEqual(readBoardOwner(r.worktree.path), parsed, "readBoardOwner 必须回读同一份真实元信息");
  assert.equal(git(r.worktree.path, "status", "--porcelain"), "", "归属标记不得让工作树变脏");
});

// ============================================================================
// 判据 1：跨看板同号不得误复用（负向）+ 旧看板绑定不被覆盖
// ============================================================================

test("g-448 判据 1：同仓库两看板同号 attempt ⇒ 明确拒绝（零副作用、旧绑定不被覆盖）", () => {
  const ws = repo(); const rootA = boardDir(ws, "default"); const rootB = boardDir(ws, "board-b");
  const a1 = prepareAttemptWorktree(rootA, "g-1", "att-001", { enabled: true });
  const a2 = prepareAttemptWorktree(rootA, "g-1", "att-001", { enabled: true });
  assert.equal(a2.worktree.canonical_root, rootA);
  const before = registeredTrees(ws);

  let refused: string | null = null;
  let leaked: any = null;
  try { leaked = prepareAttemptWorktree(rootB, "g-1", "att-001", { enabled: true }); }
  catch (e: any) { refused = String(e?.message ?? e); }

  // 修复前的可观测：静默复用 A 的路径并把 canonical_root 换成 B。该形态必须**绝不**出现。
  assert.equal(leaked, null, `跨看板同号不得返回复用结果，实际：${JSON.stringify(leaked)}`);
  assert.ok(refused, "跨看板同号必须明确拒绝");
  assert.match(refused!, /另一个看板|归属证明/);
  assert.match(refused!, /拒绝派发/);
  assert.ok(refused!.includes(rootA), "拒绝理由应点名所属看板，便于人工处置");
  // 零副作用：不新增/变更注册工作树，A 的绑定逐字不变
  assert.deepEqual(registeredTrees(ws), before);
  const a3 = prepareAttemptWorktree(rootA, "g-1", "att-001", { enabled: true });
  assert.equal(a3.worktree.path, a1.worktree.path);
  assert.equal(a3.worktree.branch, a1.worktree.branch);
  assert.equal(a3.worktree.canonical_root, rootA, "旧看板已有绑定不得被新看板的 canonical_root 覆盖");
  assert.equal(readBoardOwner(a1.worktree.path)!.canonical_root, rootA);
});

// ============================================================================
// 判据 3：孤儿/无归属证明工作树保守拒绝（不接管/改名/删除）
// ============================================================================

test("g-448 判据 3：无归属标记且无 provenance 的孤儿树 ⇒ 保守拒绝且原样保留", () => {
  const ws = repo(); const rootA = boardDir(ws, "default");
  const orphan = join(ws, ".worktrees", "g-7-att-01");
  git(ws, "worktree", "add", "-q", "-b", "g-7-att-01", orphan, "HEAD"); // 手工建「同名同分支」树，无标记、无事件
  const headBefore = git(orphan, "rev-parse", "HEAD");

  assert.throws(
    () => prepareAttemptWorktree(rootA, "g-7", "att-001", { enabled: true }),
    /归属证明|拒绝派发/,
  );
  // 不接管：不得补写归属标记
  const marker = boardOwnerMarker(orphan);
  assert.ok(marker && !existsSync(marker), "孤儿树不得被自动接管（不得补写归属标记）");
  // 不改名/不删除/不改分支
  assert.ok(existsSync(orphan), "孤儿树目录不得被删除");
  assert.equal(git(ws, "-C", orphan, "branch", "--show-current"), "g-7-att-01", "孤儿树分支不得被改名");
  assert.equal(git(orphan, "rev-parse", "HEAD"), headBefore, "孤儿树不得被改写");
  assert.ok(registeredTrees(ws).includes(canonical(orphan)), "孤儿树必须仍注册在册（未被清理）");
});

test("g-448 判据 3：归属标记损坏/不可解析时按「无归属证明」保守处理（fail-closed）", () => {
  const ws = repo(); const rootA = boardDir(ws, "default"); const rootB = boardDir(ws, "board-b");
  const r = prepareAttemptWorktree(rootA, "g-2", "att-001", { enabled: true });
  writeFileSync(boardOwnerMarker(r.worktree.path)!, "{ not json");
  assert.equal(readBoardOwner(r.worktree.path), null, "损坏标记必须解析为「无归属证明」");
  assert.throws(() => prepareAttemptWorktree(rootB, "g-2", "att-001", { enabled: true }), /归属证明|拒绝派发/);
});

// ============================================================================
// 判据 2：旧树（本目标上线前创建、无标记）由本看板事件 provenance 兼容复用
// ============================================================================

test("g-448 判据 2：无标记旧树但有本看板 attempt.started provenance ⇒ 幂等复用并补写标记", () => {
  const ws = repo(); const rootA = boardDir(ws, "default"); const rootB = boardDir(ws, "board-b");
  const path = join(ws, ".worktrees", "g-9-att-01");
  git(ws, "worktree", "add", "-q", "-b", "g-9-att-01", path, "HEAD"); // 旧树：无归属标记
  // 本看板事件真源记录了这棵树的确切路径 + 同号 goal/attempt（与 g-443 同源口径）
  appendEvent(rootA, {
    actor: "core", event: "attempt.started", goal: "g-9",
    details: { attempt: "att-001", worktree: { path, relative_path: ".worktrees/g-9-att-01", branch: "refs/heads/g-9-att-01", canonical_root: rootA } },
  });
  const reused = prepareAttemptWorktree(rootA, "g-9", "att-001", { enabled: true });
  assert.equal(reused.reused, true);
  assert.equal(reused.worktree.path, path);
  assert.equal(reused.worktree.canonical_root, rootA);
  // 采纳时补写标记 ⇒ 此后他板必然被标记挡下（证明标记确实落盘）
  assert.equal(readBoardOwner(path)?.canonical_root, rootA);
  assert.throws(() => prepareAttemptWorktree(rootB, "g-9", "att-001", { enabled: true }), /另一个看板|归属证明/);
});

test("g-448 判据 3 负向对照：只有「别的看板」的事件 provenance 不构成本看板归属（不得借他板事件认领）", () => {
  const ws = repo(); const rootA = boardDir(ws, "default"); const rootB = boardDir(ws, "board-b");
  const path = join(ws, ".worktrees", "g-11-att-01");
  git(ws, "worktree", "add", "-q", "-b", "g-11-att-01", path, "HEAD");
  appendEvent(rootA, { actor: "core", event: "attempt.started", goal: "g-11", details: { attempt: "att-001", worktree: { path } } });
  // rootB 的事件流里没有该路径 ⇒ 不得认领
  assert.throws(() => prepareAttemptWorktree(rootB, "g-11", "att-001", { enabled: true }), /归属证明|拒绝派发/);
  assert.ok(existsSync(path));
});

// ============================================================================
// 判据 4：普通自定义根定位不回归；嵌套 Git 数据根歧义如实为未修/范围外
// ============================================================================

test("g-448 判据 4：普通自定义图根（含嵌套目录）定位不回归，工作树仍落主工作树 .worktrees/", () => {
  const ws = repo(); const rootN = boardDir(ws, "board-n"); // <ws>/boards/board-n/.dsh-graph
  const r = prepareAttemptWorktree(rootN, "g-13", "att-001", { enabled: true });
  assert.equal(r.worktree.path, join(ws, ".worktrees", "g-13-att-01"));
  assert.equal(r.worktree.canonical_root, rootN);
  assert.equal(readBoardOwner(r.worktree.path)?.canonical_root, rootN, "自定义根的归属也必须落盘且正确");
});

test("g-448 判据 4（范围外·如实钉住）：嵌套 Git 数据根「父仓库优先」歧义条件复现，本目标不修", () => {
  const outerWs = repo();
  const innerWs = join(outerWs, "inner");
  mkdirSync(innerWs, { recursive: true });
  git(innerWs, "init", "-q", "-b", "main");
  writeFileSync(join(innerWs, "README"), "y");
  git(innerWs, "add", "-A");
  git(innerWs, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "inner");

  // resolveCodeWorkspace 的 dirname(root) 优先 ⇒ 内层 git 根仍落到**外层**工作树。
  // 这是既有的、独立于跨看板误复用的歧义；本目标只在条件复现后如实标注为未修/范围外，
  // 绝不冒称「所有自定义 root 定位错误」，也不为此重写工作区发现架构。
  const r = prepareAttemptWorktree(innerWs, "g-15", "att-001", { enabled: true });
  assert.equal(r.worktree.path, join(outerWs, ".worktrees", "g-15-att-01"),
    "已核实的既有歧义：嵌套 git 数据根落在外层工作树（未修，范围外）");
  // 直接 Git 发现内层仓库本身是正确的主工作树 ⇒ 证明问题只在「数据根的父目录优先」这一条歧义
  assert.equal(canonical(git(innerWs, "rev-parse", "--show-toplevel")), canonical(innerWs));
});

// ============================================================================
// 判据 1：真实入口（tool）双看板同仓库同号 —— 端到端核验路径/分支/图归属
// ============================================================================

const HOST_SOURCE = readFileSync(DISPATCH_SOURCE, "utf8");
const WT_SOURCE = readFileSync(WORKTREE_SOURCE, "utf8");

/** 与 g-406 同构的私有板副本 + 子代理桩；每个看板一份 ctx/tools（双子代理启动实拍）。 */
function boardHarness(ws: string, root: string) {
  const spawnedAt: Array<{ label: string; trees: string[] }> = [];
  const tools: any[] = [];
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return { register: () => () => {} };
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "subagents") {
        return {
          list: () => ["spawn"],
          getProvider: () => ({ prepareContinuable: () => {} }),
          startContinuable: async (opts: any) => {
            spawnedAt.push({ label: opts.label, trees: registeredTrees(ws) });
            return { childId: "child-" + Math.random().toString(36).slice(2, 8), parentSessionId: "sess-super" };
          },
        };
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    tools: { register: (def: any) => { tools.push(def); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  return {
    spawnedAt,
    dispatch: (args: any) =>
      new Map(tools.map((t) => [t.name, t])).get("graph_start_attempt").execute(args, {
        agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-exec" } },
        signal: new AbortController().signal,
      }),
  };
}
function mkGoal(root: string, title: string, type: string): string {
  const goal = createGoal(root, { title, version: "v1.0", type, actor: "human:gui" });
  setCriteria(root, goal, ["判据"], "human:gui");
  return goal;
}
/** 工作树目录名契约：`.worktrees/<goal>-att-<NN>`（两位序号，与既有命名一致）。 */
function wtPath(ws: string, goalId: string, attemptId: string): string {
  const seq = Number(attemptId.replace(/^att-/, ""));
  return join(ws, ".worktrees", `${goalId}-att-${String(seq).padStart(2, "0")}`);
}
function attemptMeta(root: string, goalId: string, attemptId: string): any {
  return loadGoal(join(dirname(findGoalFile(root, goalId)), "attempts", attemptId, "attempt.md")).meta;
}

test("g-448 判据 1（真实入口）：tool 入口同号跨板派发必须明确拒绝，板 A 绑定不变且板 B 零副作用", async () => {
  const ws = repo(); const rootA = boardDir(ws, "default"); const rootB = boardDir(ws, "board-b");
  const hA = boardHarness(ws, rootA); const hB = boardHarness(ws, rootB);
  const goalA = mkGoal(rootA, "板 A 目标", "feature");
  const goalB = mkGoal(rootB, "板 B 目标", "feature");
  assert.equal(goalA, goalB, "两块看板各自从同一起点编号 ⇒ 同号前提成立");

  const resA: any = await hA.dispatch({ goal: goalA, attempt_brief: "板 A 派发" });
  assert.equal(resA.isolated, true, "feature 在 git 仓库内默认隔离");
  assert.equal(resA.worktree.path, wtPath(ws, goalA, resA.attempt));
  assert.equal(resA.worktree.branch, `refs/heads/${goalA}-att-01`);
  assert.equal(resA.worktree.canonical_root, rootA, "返回归属必须是板 A");

  const treesBefore = registeredTrees(ws);
  await assert.rejects(
    () => hB.dispatch({ goal: goalB, attempt_brief: "板 B 同号派发" }),
    /另一个看板|归属证明|拒绝派发/,
    "板 B 同号派发必须被明确拒绝（不得静默复用板 A 的工作树）",
  );
  // 零副作用：板 B 未建 attempt、未启动子代理、未新增/变更工作树
  assert.equal(existsSync(join(dirname(findGoalFile(rootB, goalB)), "attempts")), false, "板 B 不得留下 attempt 目录");
  assert.equal(goalDetail(rootB, goalB).attempts.length, 0, "板 B 不得留下 attempt 记录");
  assert.equal(hB.spawnedAt.length, 0, "板 B 不得启动子代理");
  assert.deepEqual(registeredTrees(ws), treesBefore, "注册工作树集合不得变化");

  // 板 A 的持久化绑定（attempt.md 真源 + 事件 worktree 证据）仍指向板 A 的树与归属
  const aMeta = attemptMeta(rootA, goalA, resA.attempt);
  assert.equal(aMeta.worktree.path, resA.worktree.path);
  assert.equal(aMeta.worktree.canonical_root, rootA);

  // 同板重派仍幂等复用（真实入口，不因新增归属核验而回退）
  const resA2: any = await hA.dispatch({ goal: goalA, attempt_brief: "板 A 重派" });
  assert.equal(resA2.attempt, "att-002", "新 attempt 编号 ⇒ 另建新树，不影响 att-001 归属");
  assert.equal(resA2.worktree.canonical_root, rootA);
});

// ============================================================================
// 结构性负向对照：把归属核验「改回旧模式」必须判红
// ============================================================================

/**
 * 判定器：复用分支内必须存在**看板归属核验**（读已持久化标记 → 归属不符即明确拒绝 →
 * 无标记时以本板事件 provenance 兼容旧树）。返回 null 表示通过，否则返回违约说明。
 */
function crossBoardGuardViolation(source: string): string | null {
  const start = source.indexOf("const owner = readBoardOwner(matchedTree.path);");
  if (start < 0) return "复用分支未核验看板归属（缺少 readBoardOwner）";
  const end = guardRegionEnd(source, start);
  if (end < start) return "无法定位复用分支的归属核验块（结构已变，请同步更新本守卫）";
  const region = source.slice(start, end);
  if (!/canonicalPath\(owner\.canonical_root\)\s*!==\s*canonicalPath\(callerRoot\)/.test(region)) return "缺少「归属根 ≠ 调用方根」判定";
  if (!/throw new GraphError/.test(region)) return "归属不符时未明确拒绝（缺 throw GraphError）";
  if (!/boardRecordedProvenance\(/.test(region)) return "缺少无标记旧树的 provenance 兼容判定";
  if (/canonical_root:\s*resolve\(root\)/.test(region)) return "复用分支仍无条件用调用方 canonical_root 覆盖绑定";
  return null;
}
/** 归属核验块的边界：从归属读取起，到复用分支结束（下一段「候选路径占用」检查之前）。 */
function guardRegionEnd(source: string, start: number): number {
  const end = source.indexOf("// 2. 检查候选路径是否被文件系统占用", start);
  return end < 0 ? source.indexOf('let head = "";', start) : end;
}
/** 只在归属核验块内做定点变异（避免误改文件其它 GraphError / canonical_root）。 */
function mutateGuardRegion(source: string, replacer: (region: string) => string): string {
  const start = source.indexOf("const owner = readBoardOwner(matchedTree.path);");
  if (start < 0) return source;
  const end = guardRegionEnd(source, start);
  if (end < start) return source;
  return source.slice(0, start) + replacer(source.slice(start, end)) + source.slice(end);
}

test("g-448 负向对照：复用分支缺失归属核验 / 恢复「无条件覆盖 canonical_root」必被判红", () => {
  assert.equal(crossBoardGuardViolation(WT_SOURCE), null, "当前实现必须通过归属核验判定器");
  // 修复前的真实形态（逐字摘自基线 e3d98cf 的复用分支）：必须判红
  const preFix = `
    if (actualBranch === expectedBranch && assoc.assoc?.goal === goalId && assoc.assoc?.attempt === attemptId) {
      let head = "";
      try { head = git(matchedTree.path, ["rev-parse", "HEAD"]); } catch { head = matchedTree.head ?? baseline; }
      return { enabled: true, created: false, reused: true, worktree: {
        path: matchedTree.path, relative_path: relative(mainWorktree, matchedTree.path),
        branch: \`refs/heads/\${expectedBranch}\`, canonical_root: resolve(root), head } };
`;
  assert.notEqual(crossBoardGuardViolation(preFix), null, "旧（无归属核验）形态必须判红");
  // 定点变异①：删掉拒绝分支（只读标记但不拒绝）
  const noThrow = mutateGuardRegion(WT_SOURCE, (r) => r.replace(/throw new GraphError\(/g, "void ("));
  assert.notEqual(crossBoardGuardViolation(noThrow), null, "删掉拒绝分支必须判红");
  // 定点变异②：恢复「无条件用调用方 canonical_root 覆盖绑定」
  const overwrite = mutateGuardRegion(WT_SOURCE, (r) => r.replace("owner ? owner.canonical_root : callerRoot", "resolve(root)"));
  assert.notEqual(crossBoardGuardViolation(overwrite), null, "恢复无条件覆盖 canonical_root 必须判红");
  // 定点变异③：删掉旧树 provenance 兼容
  const noProv = mutateGuardRegion(WT_SOURCE, (r) => r.replace(/boardRecordedProvenance\(/g, "("));
  assert.notEqual(crossBoardGuardViolation(noProv), null, "删掉 provenance 兼容必须判红");
});

test("g-448 判据 1（入口覆盖）：tool 与 HTTP 两入口共用同一处 prepare 调用 ⇒ 修复对两入口同时生效", () => {
  const prepares = HOST_SOURCE.split("prepareAttemptWorktree(").length - 1;
  assert.equal(prepares, 1, `host 内 prepareAttemptWorktree 调用点应恰好 1 处，实际 ${prepares}`);
  const call = HOST_SOURCE.indexOf("prepareAttemptWorktree(root, goal, nextAttId");
  assert.ok(call >= 0, "该唯一调用点必须传入**看板根** root（而不是主工作树/猜出的路径）");
  // 两个入口都经 dispatchExecutionAttempt 派发（无旁路建树）
  const dispatches = HOST_SOURCE.split("await dispatchExecutionAttempt(").length - 1;
  assert.equal(dispatches, 2, `tool/HTTP 两入口应各有 1 处 dispatchExecutionAttempt 调用，实际 ${dispatches}`);
});
