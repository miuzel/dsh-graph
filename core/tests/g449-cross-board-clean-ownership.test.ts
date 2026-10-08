import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { init, createGoal, startAttempt, findGoalFile } from "../ops.ts";
import { listWorktrees, cleanWorktree, prepareAttemptWorktree, readBoardOwner } from "../worktree.ts";
import { apply } from "../../dist/index.js";
import { readEvents } from "../events.ts";

/**
 * g-449：**清理面**的跨看板归属核验（跨板同号 g-<n>/att-<NN> 误删他人工作树）。
 *
 * 已核实缺陷（本目标基线 `7f164bb`，`tmp/g449-repro-baseline.log` 实拍；同基线对照逐字一致
 * ⇒ 既有缺陷、非 g-448 引入）：同仓库两块看板各持同号 g-001/att-001 时，板 A 建树并带 A 的
 * 归属标记；板 B 自身 g-001 已 delivered、att-001 已终态 ⇒ 板 B 的 `listWorktrees` 把 **A 的树**
 * 判为 `candidate`，`cleanWorktree` 返回 `ok:true` 并**真的删掉 A 的工作树**（git 注册同步消失）。
 * g-448 只收口了 `prepareAttemptWorktree` 的复用面，未触及清理面。
 *
 * 本目标的语义（实现见 `core/worktree.ts` 的 `foreignBoardOwnerRoot`，复用 g-448 的归属真源）：
 *  1. 该树已被**另一个**看板认领（归属标记指向他板）⇒ 列表判 `protected`、清理**拒绝**，
 *     理由点名归属看板根，且零副作用（不删目录、不迁状态、不留半清理残留、不接管/改名）；
 *  2. **无归属证明**（无标记 / 标记损坏不可读）⇒ 保持**既有可清理行为**，绝不保守化
 *     （`core/tests/worktree.test.ts` 既有断言即以「无标记 + 无 provenance 的树必须可清理」
 *     为真源；清理面保守拒绝只会把可用工作树永久锁死，与复用面「拒绝=不派发、零损失」不同）；
 *  3. 归属标记属**本板** ⇒ 照常可清理（单板行为零回退）；
 *  4. `listWorktrees` 的 status/reason **集合不新增**（复用 `protected`/`protected`），
 *     归属根经**加法式** `board_owner_root` 通道观测，自有树不出现该字段。
 */

const REPO_ROOT = join(import.meta.dirname, "../..");
const WORKTREE_SOURCE = join(REPO_ROOT, "core/worktree.ts");
const MODAL_SOURCE = join(REPO_ROOT, "dsh-graph-host/lib/client/goal-modal.js");

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
  const dir = mkdtempSync(join(tmpdir(), "g449-board-"));
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
function boardOwnerMarkerPath(worktreePath: string): string | null {
  try {
    return join(git(worktreePath, "rev-parse", "--absolute-git-dir"), "dsh-graph-board-owner.json");
  } catch { return null; }
}
/** 让某看板自己的 goal/attempt 达到「已交付 + attempt 终态」⇒ 该板的树可进入候选。 */
function deliverAndFinish(root: string, goal: string, attempt: string): void {
  const gf = findGoalFile(root, goal);
  const goalText = readFileSync(gf, "utf8").replace(/("status":\s*)"planning"/, '$1"delivered"');
  assert.match(goalText, /"status": "delivered"/, "夹具前置：goal 必须已置 delivered");
  writeFileSync(gf, goalText);
  const af = join(dirname(gf), "attempts", attempt, "attempt.md");
  const attText = readFileSync(af, "utf8").replace('"result": "pending"', '"result": "completed"');
  assert.match(attText, /"result": "completed"/, "夹具前置：attempt 必须已置终态");
  writeFileSync(af, attText);
}
/** 双板夹具：板 A 真实建树（带 A 的归属标记），板 B 持同号 goal/attempt 且已交付终态、无自有树。 */
function dualBoard() {
  const ws = repo();
  const rootA = boardDir(ws, "default");
  const rootB = boardDir(ws, "board-b");
  const created = prepareAttemptWorktree(rootA, "g-001", "att-001", { enabled: true });
  const goalA = createGoal(rootA, { title: "板 A", version: "v1.0", actor: "test" });
  const attA = startAttempt(rootA, goalA, { executor: "test", actor: "test" });
  deliverAndFinish(rootA, goalA, attA);
  const goalB = createGoal(rootB, { title: "板 B", version: "v1.0", actor: "test" });
  const attB = startAttempt(rootB, goalB, { executor: "test", actor: "test" });
  deliverAndFinish(rootB, goalB, attB);
  assert.equal(goalA, goalB, "两块看板各自从同一起点编号 ⇒ 同号前提成立");
  assert.equal(attA, attB, "同号 attempt 前提成立");
  return { ws, rootA, rootB, goalA, goalB, treePath: created.worktree.path, branch: created.worktree.branch };
}

// ============================================================================
// 判据 1 / 3：清理面归属闸门（核心语义 + 零副作用）
// ============================================================================

test("g-449 判据 1/3：板 B 清理板 A 的树被拒绝、点名归属看板根、树零变化", () => {
  const { ws, rootA, rootB, goalB, treePath } = dualBoard();
  const markerFile = boardOwnerMarkerPath(treePath)!;
  const markerBefore = readFileSync(markerFile, "utf8");
  const headBefore = git(treePath, "rev-parse", "HEAD");
  const treesBefore = registeredTrees(ws);
  const eventsBefore = readEvents(rootB).length;

  const row = listWorktrees(rootB, goalB).find((r) => r.path === treePath);
  assert.ok(row, "板 B 必须能看到该树（拒绝理由需要可点名，故不做静默隐藏）");
  // 缺陷现场：修复前这里是 status=candidate / reason=null ⇒ cleanWorktree ok:true 并真删树。
  assert.equal(row!.status, "protected", "归属他板的树不得被判为可清理候选");
  assert.equal(row!.reason, "protected", "归属保护复用既有 reason 枚举，不新增值");
  assert.equal(row!.board_owner_root, rootA, "归属根必须经加法式通道如实下发");

  const res = cleanWorktree(rootB, row!.id, "human:test", true);
  assert.equal(res.ok, false, "跨板清理必须被拒绝");
  assert.ok(String(res.reason).includes(rootA), `拒绝理由必须点名归属看板根 ${rootA}：${res.reason}`);
  assert.ok(String(res.reason).includes(treePath), "拒绝理由应点名该树路径");

  // 零副作用：目录 / Git 注册 / HEAD / 归属标记 / 归属板事件全部逐字不变
  assert.ok(existsSync(treePath), "A 的工作树目录不得被删除");
  assert.deepEqual(registeredTrees(ws), treesBefore, "Git 工作树注册集合不得变化");
  assert.equal(git(treePath, "rev-parse", "HEAD"), headBefore, "不得改写该树");
  assert.equal(readFileSync(markerFile, "utf8"), markerBefore, "不得改写归属标记（不接管）");
  assert.equal(git(ws, "-C", treePath, "branch", "--show-current"), "g-001-att-01", "不得改名/换分支");
  // 板 B 只允许留下「被拒绝」的审计事件；不得出现 worktree.cleaned
  const bEvents = readEvents(rootB);
  assert.equal(bEvents.filter((e) => e.event === "worktree.cleaned").length, 0, "不得产生清理事件");
  const blocked = bEvents.filter((e) => e.event === "worktree.clean_blocked");
  assert.ok(blocked.length >= 1, "拒绝必须留可审计的 clean_blocked 事件");
  assert.equal(bEvents.length - eventsBefore, blocked.length, "板 B 本次只允许新增 clean_blocked 事件（不得迁状态/留半清理残留）");
  assert.ok(String((blocked.at(-1)!.details as any).reason).includes(rootA), "事件中同样点名归属看板根");

  // 同板（板 A 自己的树）仍可清理 ⇒ 闸门不是无差别封锁
  const rowA = listWorktrees(rootA, "g-001").find((r) => r.path === treePath)!;
  assert.equal(rowA.status, "candidate");
  assert.equal(cleanWorktree(rootA, rowA.id, "human:test", true).ok, true, "板 A 清理自己的树必须成功");
  assert.ok(!existsSync(treePath), "板 A 清理后目录消失（清理能力未被削弱）");
});

test("g-449 判据 1 行为负向对照：闸门承重——抹掉归属标记后同一调用即可删除（缺陷形态）", () => {
  const { ws, rootB, goalB, treePath } = dualBoard();
  const row = listWorktrees(rootB, goalB).find((r) => r.path === treePath)!;
  assert.equal(cleanWorktree(rootB, row.id, "human:test", true).ok, false);
  assert.ok(existsSync(treePath));
  // 反向对照：移除「他板归属」这一唯一差别 ⇒ 板 B 立刻恢复删除能力
  //（证明被拦住的原因确实是他板归属，而不是别的分支；同时钉住判据 2 的边界语义）
  rmSync(boardOwnerMarkerPath(treePath)!, { force: true });
  const row2 = listWorktrees(rootB, goalB).find((r) => r.path === treePath)!;
  assert.notEqual(row2.status, "protected", "无标记树不得被归属闸门当作他板树保护");
  assert.equal(cleanWorktree(rootB, row2.id, "human:test", true).ok, true, "无归属证明的树保持既有可清理行为");
  assert.ok(!existsSync(treePath));
  assert.deepEqual(registeredTrees(ws).filter((p) => p.includes("g-001-att-01")), [], "已删除");
});

// ============================================================================
// 判据 2：无归属证明的既有 / 遗留树不回归（不得保守化）
// ============================================================================

test("g-449 判据 2：本板无标记 legacy 树仍可清理（无 provenance 与有 provenance 两条路径）", () => {
  // 路径 1：原始 git 建树、无标记、事件流无 worktree provenance —— 与既有 worktree.test.ts 同构
  {
    const ws = repo();
    const root = boardDir(ws, "default");
    const goal = createGoal(root, { title: "legacy", version: "v1.0", actor: "test" });
    const att = startAttempt(root, goal, { executor: "test", actor: "test" });
    const path = join(ws, ".worktrees", `${goal}-att-01`);
    git(ws, "worktree", "add", "-q", "-b", `${goal}-att-01`, path);
    deliverAndFinish(root, goal, att);
    const row = listWorktrees(root, goal).find((r) => r.path === path)!;
    assert.equal(row.status, "candidate", `无标记旧树必须仍可进入候选（reason=${row.reason}）`);
    assert.equal(row.board_owner_root, undefined, "无归属冲突时不得出现归属观测字段");
    assert.equal(cleanWorktree(root, row.id, "human:test", true).ok, true, "遗留无标记树必须仍可被其所属板清理");
    assert.ok(!existsSync(path));
  }
  // 路径 2：同上看板，但事件流记有该路径的 attempt.started provenance（g-448 口径的旧树）
  {
    const ws = repo();
    const root = boardDir(ws, "default");
    const goal = createGoal(root, { title: "legacy-prov", version: "v1.0", actor: "test" });
    const path = join(ws, ".worktrees", `${goal}-att-01`);
    git(ws, "worktree", "add", "-q", "-b", `${goal}-att-01`, path); // 旧树：无归属标记
    // 本看板事件真源记录该树的确切路径（与 g-448 判据 2 的兼容口径同源）
    const att = startAttempt(root, goal, {
      executor: "test", actor: "test",
      worktree: { relative_path: `.worktrees/${goal}-att-01`, branch: `refs/heads/${goal}-att-01`, canonical_root: root, path },
    });
    assert.ok(!existsSync(boardOwnerMarkerPath(path)!), "该旧树此时必须仍无归属标记");
    deliverAndFinish(root, goal, att);
    const repaired = prepareAttemptWorktree(root, goal, att, { enabled: true });
    assert.equal(repaired.reused, true, "本板 provenance 证明的旧树仍可幂等复用（g-448 面不回退）");
    assert.equal(readBoardOwner(path)!.canonical_root, root, "复用即补写本板归属标记");
    const row = listWorktrees(root, goal).find((r) => r.path === path)!;
    assert.equal(row.status, "candidate", "补写标记后仍属本板 ⇒ 候选不回退");
    assert.equal(cleanWorktree(root, row.id, "human:test", true).ok, true, "补写本板标记后仍可清理");
    assert.ok(!existsSync(path));
  }
});

test("g-449 判据 2（边界如实钉住）：无标记 + 无 provenance 的孤儿树按既有语义仍可被清理", () => {
  // 明确取舍：清理面**不**复制复用面的「无归属证明 ⇒ 保守拒绝」。原因：
  //  - 既有断言（core/tests/worktree.test.ts 判据行 36-39）以「无标记 + 无 provenance 的树
  //    必须可被清理」为真源 ⇒ 保守化会直接判红既有断言、并让遗留树永久不可清理（判据 2 禁止）；
  //  - 树内再无任何可分辨「谁建的」信号（`attemptWorktreeEvidence` 是**按命名猜**的路径，
  //    每个同号看板都会写下同一条猜测，不构成归属证明）。
  // 故此处如实钉住边界：仅「标记指向他板」可判归属；无标记 = 无归属证明 = 沿用既有行为。
  const ws = repo();
  const rootB = boardDir(ws, "board-b");
  const goalB = createGoal(rootB, { title: "B", version: "v1.0", actor: "test" });
  const attB = startAttempt(rootB, goalB, { executor: "test", actor: "test" });
  const orphan = join(ws, ".worktrees", `${goalB}-att-01`);
  git(ws, "worktree", "add", "-q", "-b", `${goalB}-att-01`, orphan, "HEAD"); // 手工建树：无标记、无事件
  deliverAndFinish(rootB, goalB, attB);
  assert.ok(!existsSync(boardOwnerMarkerPath(orphan)!), "孤儿树必须确实没有归属标记");
  const row = listWorktrees(rootB, goalB).find((r) => r.path === orphan)!;
  assert.equal(row.status, "candidate", "无归属证明的孤儿树仍按既有规则进入候选（不回退）");
  assert.equal(cleanWorktree(rootB, row.id, "human:test", true).ok, true, "既有可清理行为如实保留（残余风险已登记）");
  assert.ok(!existsSync(orphan));
});

// ============================================================================
// 判据 4：单板语义与 listWorktrees 枚举结构不回退
// ============================================================================

test("g-449 判据 4：单板候选行字段/语义逐字不回退，且 reason 枚举集合零新增", () => {
  const ws = repo();
  const root = boardDir(ws, "default");
  const goal = createGoal(root, { title: "single", version: "v1.0", actor: "test" });
  const att = startAttempt(root, goal, { executor: "test", actor: "test" });
  const created = prepareAttemptWorktree(root, goal, att, { enabled: true });
  deliverAndFinish(root, goal, att);
  const row = listWorktrees(root, goal).find((r) => r.path === created.worktree.path)!;
  assert.equal(row.status, "candidate");
  assert.equal(row.reason, null);
  // 字段集合逐字钉住：自有树不得因本次改动多出任何字段
  assert.deepEqual(
    Object.keys(row).sort(),
    ["active", "attempt", "branch", "clean", "discovered_at", "goal", "head", "id", "merged", "path", "reason", "status", "target_branch"].sort(),
    "单板候选行字段集合不得漂移",
  );

  // 客户端 i18n 侧的唯一 reason 枚举清单（goal-modal.js WORKTREE_REASON_ENUMS）不得新增值：
  // 归属保护复用既有 `protected`，故清单长度与内容逐字不变。
  const modal = readFileSync(MODAL_SOURCE, "utf8");
  const match = modal.match(/const WORKTREE_REASON_ENUMS = \[([\s\S]*?)\];/);
  assert.ok(match, "goal-modal.js 必须仍持有 WORKTREE_REASON_ENUMS 清单");
  const enums = [...match![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.equal(enums.length, 22, `既有 reason 枚举数量不得变化（实际 ${enums.length}）`);
  assert.ok(enums.includes("protected"), "归属保护必须复用既有 protected 枚举");
  // 基线（7f164bb）清理/列表面全部 reason 字面量的并集：客户端 i18n 枚举清单 + 未入 i18n
  // 清单的既有权值（already_cleaned，既有 worktree.test.ts 已断言）。**只增不减**，本目标不得新增。
  const BASELINE_REASONS = new Set([...enums, "already_cleaned"]);

  // 清理/列表面源码内出现的 reason 字面量必须全部落在既有枚举内（禁止悄悄新增枚举值）
  const source = readFileSync(WORKTREE_SOURCE, "utf8");
  const region = listRegionOf(source) + cleanRegionOf(source);
  const literals = [...region.matchAll(/(?:reason = |reason: |block\(|\?\? )"([a-z_]+)"/g)].map((m) => m[1]);
  // 归属保护的唯一取值必须来自既有清单
  assert.ok(literals.includes("protected"), "跨板归属保护应复用 protected");
  for (const lit of literals) assert.ok(BASELINE_REASONS.has(lit), `worktree.ts 出现新增 reason 枚举：${lit}`);
});

// ============================================================================
// 判据 5：真实入口（tool / HTTP）跨板删除被拒
// ============================================================================

/** 与 g-406/g-448 同构的私有板副本：绝对 config.root ⇒ 该实例的一切入口都落在本板。 */
function boardHarness(ws: string, root: string) {
  const tools: any[] = [];
  const routes: any[] = [];
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return { register: (r: any) => { routes.push(r); return () => {}; } };
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    tools: { register: (def: any) => { tools.push(def); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  const ex = { agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-exec" } }, signal: new AbortController().signal };
  return {
    routes,
    run: (name: string, args: any) => new Map(tools.map((t) => [t.name, t])).get(name)!.execute(args, ex),
  };
}

test("g-449 判据 5（tool 入口）：graph_clean_worktree 跨板删除被拒且零副作用", async () => {
  const { ws, rootA, rootB, goalB, treePath } = dualBoard();
  const hB = boardHarness(ws, rootB);
  const listed: any = await hB.run("graph_list_worktrees", { goal: goalB });
  const row = listed.worktrees.find((x: any) => x.path === treePath);
  assert.ok(row, "tool 列表必须仍可点名该树（拒绝理由可读）");
  const treesBefore = registeredTrees(ws);
  const out: any = await hB.run("graph_clean_worktree", { id: row.id, confirm: true });
  assert.equal(out.ok, false, "tool 入口必须拒绝跨板清理");
  assert.ok(String(out.reason).includes(rootA), `tool 入口理由必须点名归属看板根：${out.reason}`);
  assert.ok(existsSync(treePath), "tool 入口拒绝后树必须原样存在");
  assert.deepEqual(registeredTrees(ws), treesBefore, "tool 入口拒绝必须零副作用");
  // 归属板 A 经同一 tool 入口仍可清理自己的树
  const hA = boardHarness(ws, rootA);
  const listedA: any = await hA.run("graph_list_worktrees", { goal: "g-001" });
  const rowA = listedA.worktrees.find((x: any) => x.path === treePath);
  assert.equal(rowA.status, "candidate");
  const outA: any = await hA.run("graph_clean_worktree", { id: rowA.id, confirm: true });
  assert.equal(outA.ok, true, "归属板经 tool 入口清理自己的树必须成功");
});

test("g-449 判据 5（HTTP 入口）：POST /api/dsh-graph/worktrees/clean 跨板删除返回 409 且点名归属板", async () => {
  const { ws, rootA, rootB, goalB, treePath } = dualBoard();
  const hB = boardHarness(ws, rootB);
  const route = hB.routes.find((r: any) => r.path === "/api/dsh-graph/worktrees/clean");
  assert.ok(route, "HTTP 清理路由必须已注册");
  const listed: any = await hB.run("graph_list_worktrees", { goal: goalB });
  const row = listed.worktrees.find((x: any) => x.path === treePath)!;

  const req: any = Readable.from([JSON.stringify({ id: row.id, confirm: true })]);
  req.method = "POST";
  req.url = "/api/dsh-graph/worktrees/clean";
  const res: any = { code: 0, text: "", writeHead(code: number) { this.code = code; }, end(t: string) { this.text = t; } };
  await route.handler(req, res);
  assert.equal(res.code, 409, "HTTP 入口必须以 409 拒绝（而非 200 删除成功）");
  const payload = JSON.parse(res.text);
  assert.equal(payload.ok, false);
  assert.ok(String(payload.reason).includes(rootA), `HTTP 入口理由必须点名归属看板根：${payload.reason}`);
  assert.ok(existsSync(treePath), "HTTP 入口拒绝后树必须原样存在");
  assert.equal(git(ws, "worktree", "list", "--porcelain").includes(treePath), true, "Git 注册必须保留");
});

// ============================================================================
// 结构性负向对照：把清理面的归属闸门「改回旧模式」必须判红
// ============================================================================

/** 源码区域切片：以下一个顶层声明为边界（不依赖易漂移的注释文本）。 */
function listRegionOf(source: string): string {
  const start = source.indexOf("export function listWorktrees(");
  const end = source.indexOf("export function registerWorktreeCandidates(", start);
  return start < 0 ? "" : source.slice(start, end < 0 ? source.length : end);
}
function cleanRegionOf(source: string): string {
  const start = source.indexOf("export function cleanWorktree(");
  const end = source.indexOf("export function defaultWorktreeForGoalType(", start);
  return start < 0 ? "" : source.slice(start, end < 0 ? source.length : end);
}
/** 只在 cleanWorktree 区域内做定点变异（listWorktrees 内有同形的 `if (foreignRoot) {` 单行分支）。 */
function mutateCleanRegion(source: string, replacer: (region: string) => string): string {
  const start = source.indexOf("export function cleanWorktree(");
  const end = source.indexOf("export function defaultWorktreeForGoalType(", start);
  if (start < 0) return source;
  return source.slice(0, start) + replacer(source.slice(start, end < 0 ? source.length : end)) + source.slice(end < 0 ? source.length : end);
}
/** 判定器：cleanWorktree 内必须存在跨看板归属闸门（读同一归属真源 → 指向他板即拒绝；点名归属根）。 */
function cleanGuardViolation(source: string): string | null {
  const region = cleanRegionOf(source);
  if (!region) return "缺少 cleanWorktree";
  if (!/foreignBoardOwnerRoot\(root, c\.path\)/.test(region)) return "清理面未核验跨看板归属（缺少 foreignBoardOwnerRoot）";
  const gate = region.match(/if \(foreignRoot\) \{([\s\S]*?)\n  \}/);
  if (!gate) return "缺少「归属他板 ⇒ 拒绝」分支";
  if (!/return block\(/.test(gate[1])) return "归属他板时未走 block() 拒绝（可能静默继续删除）";
  if (!/foreignRoot/.test(gate[1])) return "拒绝理由未引用归属看板根（无法点名归属）";
  return null;
}
/** 归属真源必须仍是 g-448 的那一份（不得新造第二套解析）。 */
function ownershipSourceViolation(source: string): string | null {
  if (!/function foreignBoardOwnerRoot\(root: string, worktreePath: string\): string \| null \{/.test(source)) return "缺少唯一的归属解析入口 foreignBoardOwnerRoot";
  const start = source.indexOf("function foreignBoardOwnerRoot(");
  const end = source.indexOf("function resolveCodeWorkspace(", start);
  if (start < 0 || end < 0) return "归属解析入口结构已变（无法定位比对区域）";
  const body = source.slice(start, end);
  if (!/readBoardOwner\(worktreePath\)/.test(body)) return "未复用 g-448 的 readBoardOwner";
  if (!/canonicalPath\(owner\.canonical_root\)/.test(body)) return "未复用 g-448 的 canonicalPath 归一";
  return null;
}

test("g-449 负向对照：清理面缺失跨板归属闸门 / 新造第二套归属解析 必被判红", () => {
  const source = readFileSync(WORKTREE_SOURCE, "utf8");
  assert.equal(cleanGuardViolation(source), null, "当前实现必须通过清理面闸门判定器");
  assert.equal(ownershipSourceViolation(source), null, "当前实现必须复用 g-448 的归属真源");

  // 修复前的真实形态（逐字摘自基线 7f164bb 的 cleanWorktree）：必须判红
  const preFix = `
export function cleanWorktree(root: string, id: string, actor = "human:gui", confirm = false) {
  const c = listWorktrees(root).find(x => x.id === id);
  if (!confirm) return { ok: false, ...(c ? { candidate: c } : {}), reason: "confirm_required" };
  const block = (reason: string) => { appendEvent(root, { actor, event: "worktree.clean_blocked", goal: c?.goal, details: { id, reason, candidate: c ?? null } }); return { ok: false, ...(c ? { candidate: c } : {}), reason }; };
  if (!c) return block("unknown_candidate");
  if (c.status === "cleaned" || (c.status === "unknown" && c.reason === "externally_removed")) return { ok: true, candidate: c, reason: "already_cleaned" };
  if (c.status !== "candidate") return block(c.reason ?? "protected");
`;
  assert.notEqual(cleanGuardViolation(preFix), null, "旧（无归属闸门）形态必须判红");

  // 定点变异①：删掉拒绝分支的生效条件（读了归属却不拒绝）——只在 cleanWorktree 区域内变异
  const noThrow = mutateCleanRegion(source, (r) => r.replace("if (foreignRoot) {", "if (false && foreignRoot) {"));
  assert.notEqual(noThrow, source, "变异①必须真实命中 cleanWorktree 的闸门分支");
  assert.notEqual(cleanGuardViolation(noThrow), null, "删掉拒绝分支必须判红");
  // 定点变异②：拒绝理由不再引用归属看板根
  const noName = mutateCleanRegion(source, (r) => r.replace("已绑定看板 ${foreignRoot}", "已绑定看板（未知）"));
  assert.notEqual(noName, source, "变异②必须真实命中拒绝理由");
  assert.notEqual(cleanGuardViolation(noName), null, "拒绝理由不点名归属看板根必须判红");
  // 定点变异③：新造第二套归属解析（不使用 readBoardOwner）
  const ownScheme = source.replace("const owner = readBoardOwner(worktreePath);", "const owner = null as any;");
  assert.notEqual(ownScheme, source, "变异③必须真实命中归属解析");
  assert.notEqual(ownershipSourceViolation(ownScheme), null, "绕过 readBoardOwner 自造解析必须判红");
});
