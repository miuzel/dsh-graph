import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { init, createGoal, startAttempt, findGoalFile } from "../ops.ts";
import { appendEvent } from "../events.ts";
import { cleanWorktree, listWorktrees, prepareAttemptWorktree, readBoardOwner } from "../worktree.ts";

/**
 * g-451：归属标记**写入原子化**（同目录临时文件 + rename）+ 损坏标记语义**只记录、不修改**。
 *
 * 缺陷（g-449 独立复核 P2①，本目标基线 `87a9218`）：`writeBoardOwner` 原先用非原子
 * `writeFileSync` 直写 `<git-common-dir>/worktrees/<name>/dsh-graph-board-owner.json`，
 * 崩溃/断电可留下**半文件或空文件**；而 g-449 清理面按「无归属证明即放行」处理损坏标记 ⇒
 * 「标记一旦被截断，跨板保护就静默失效」。本目标只消除**写入侧**的截断窗口。
 *
 * 明确记录（判据 2，只记录不改语义）：以下四种**损坏标记形态**仍一律是「无归属证明」，
 * 清理面**沿用 g-449 取舍放行**（绝不 fail-closed 锁死 legacy / 孤儿树）——
 *   ① 空文件；② 半 JSON；③ 缺 `canonical_root` 字段；④ `canonical_root` 为空白串。
 * 该取舍是 g-449 判据 2 强制的（清理面保守拒绝会把可用工作树永久锁死，且直接判红既有
 * `core/tests/worktree.test.ts` 断言）；本套件把「四形态 ⇒ 放行」与「完整有效标记 ⇒ 拒绝」
 * 两侧都钉住，确保修复写入侧时**没有**顺手把语义改成 fail-closed。
 *
 * 失败注入口径：两个「本板写标记失败」用例用 POSIX 权限/占位目录注入（与
 * `core/tests/shared-card.test.ts` / `core/tests/g394-badlock-recovery.test.ts` 的
 * chmod 注入同源）；原生 Windows 下 chmod 不阻止创建，该两例的结论由发布门禁的
 * Windows 真机 smoke 覆盖（与既有 chmod 注入用例的限制一致）。
 */

const REPO_ROOT = join(import.meta.dirname, "../..");
const WORKTREE_SOURCE = join(REPO_ROOT, "core/worktree.ts");
const OPS_SOURCE = join(REPO_ROOT, "core/ops.ts");
const MARKER = "dsh-graph-board-owner.json";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** 私有夹具仓库：`.worktrees/` 与 `.dsh-graph/` 均被忽略（与真实仓库同构，不污染干净度判定）。 */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "g451-marker-"));
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
function markerPath(worktreePath: string): string {
  return join(git(worktreePath, "rev-parse", "--absolute-git-dir"), MARKER);
}
function adminDir(worktreePath: string): string {
  return git(worktreePath, "rev-parse", "--absolute-git-dir");
}
/** 该树 Git 管理目录内的临时残留（原子写的 `.tmp-<uuid>` 以及任何 `.tmp` 形态）。 */
function tempResidue(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes(".tmp"));
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
/** 双板夹具：板 A 真实建树（带 A 的完整归属标记），板 B 持同号 goal/attempt 且已交付终态。 */
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
  return { ws, rootA, rootB, goalB, treePath: created.worktree.path };
}
/**
 * 旧树夹具：手工建「同号同分支」工作树（无标记），并在本板事件流写下 attempt.started
 * provenance ⇒ `prepareAttemptWorktree` 走 g-448 的「旧树兼容」复用分支，即**会尝试写标记**。
 * 这正是「本板写标记失败」注入所需的落点。
 */
function legacyTreeForReuse() {
  const ws = repo();
  const root = boardDir(ws, "default");
  const path = join(ws, ".worktrees", "g-1-att-01");
  git(ws, "worktree", "add", "-q", "-b", "g-1-att-01", path, "HEAD");
  appendEvent(root, {
    actor: "core", event: "attempt.started", goal: "g-1",
    details: { attempt: "att-001", worktree: { path, relative_path: ".worktrees/g-1-att-01", branch: "refs/heads/g-1-att-01", canonical_root: root } },
  });
  assert.ok(!existsSync(markerPath(path)), "夹具前置：旧树必须确实还没有归属标记");
  return { ws, root, path };
}

// ============================================================================
// 判据 1：写入原子化 —— 路径/字段/内容逐字不变 + 成功与失败路径都零残留
// ============================================================================

test("g-451 判据 1：建树即原子写入归属标记——路径/字段/内容逐字不变且零临时残留", () => {
  const ws = repo();
  const root = boardDir(ws, "default");
  const created = prepareAttemptWorktree(root, "g-1", "att-001", { enabled: true });
  const tree = created.worktree.path;
  const admin = adminDir(tree);
  const file = markerPath(tree);

  // 路径不变：<git-common-dir>/worktrees/<name>/dsh-graph-board-owner.json
  const common = git(tree, "rev-parse", "--path-format=absolute", "--git-common-dir");
  assert.equal(basename(file), MARKER, "标记文件名逐字不变");
  assert.equal(dirname(admin), join(common, "worktrees"), "标记仍写在 <git-common-dir>/worktrees/<name>/ 下");
  assert.equal(file, join(admin, MARKER), "标记路径 = 该树 Git 管理目录 + 固定文件名（原子写不改变落点）");

  // 内容/字段不变：完整 JSON + 结尾换行，字段集合与取值逐字等同修复前
  const content = readFileSync(file, "utf8");
  assert.equal(content.endsWith("\n"), true, "标记仍以换行结尾");
  const parsed = JSON.parse(content) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["attempt", "branch", "canonical_root", "created_at", "goal"],
    "字段集合只增不减地逐字不变",
  );
  assert.equal(parsed.canonical_root, root);
  assert.equal(parsed.goal, "g-1");
  assert.equal(parsed.attempt, "att-001");
  assert.equal(parsed.branch, "g-1-att-01");
  assert.equal(typeof parsed.created_at, "string");
  assert.deepEqual(readBoardOwner(tree), parsed, "读回与写入逐字一致");

  // 零临时残留 + 标记不进工作区（不污染 git status）
  assert.deepEqual(tempResidue(admin), [], "成功路径不得留下 .tmp-<uuid>");
  assert.equal(git(tree, "status", "--porcelain"), "", "归属标记不进入工作区，不污染 git status");
});

test("g-451 判据 1（失败注入①）：标记写入失败（父目录不可写）⇒ 无半文件、零残留、派发不失败", () => {
  const { root, path } = legacyTreeForReuse();
  const admin = adminDir(path);
  const file = markerPath(path);
  const before = readdirSync(admin).sort();

  chmodSync(admin, 0o555); // 使临时文件创建失败（EACCES）：模拟「本板写标记失败」
  let reused: any = null;
  try {
    reused = prepareAttemptWorktree(root, "g-1", "att-001", { enabled: true });
  } finally {
    chmodSync(admin, 0o755); // 先恢复权限再断言/清理
  }
  assert.equal(reused.reused, true, "写标记失败不得让派发失败（best-effort 语义不变）");
  assert.equal(existsSync(file), false, "写失败不得留下半文件/空文件（截断窗口已消除）");
  assert.deepEqual(readdirSync(admin).sort(), before, "失败路径必须零残留（含临时文件）");
  assert.deepEqual(tempResidue(admin), [], "失败路径不得留下 .tmp-<uuid>");
  assert.equal(readBoardOwner(path), null, "无标记 ⇒ 「无归属证明」（与四种损坏形态同值）");

  // 恢复可写后再次复用即补写成功（失败不粘滞、无残影）
  prepareAttemptWorktree(root, "g-1", "att-001", { enabled: true });
  assert.equal(readBoardOwner(path)!.canonical_root, root, "父目录恢复可写后补写即成功");
  assert.deepEqual(tempResidue(admin), [], "补写成功同样零残留");
});

test("g-451 判据 1（失败注入②）：rename 替换失败（标记路径被占位）⇒ 占位物不被半文件顶掉、零残留", () => {
  const { root, path } = legacyTreeForReuse();
  const admin = adminDir(path);
  const file = markerPath(path);
  mkdirSync(file); // 用目录占位标记路径 ⇒ POSIX rename(file, dir) 必失败（EISDIR）
  const before = readdirSync(admin).sort();

  const reused = prepareAttemptWorktree(root, "g-1", "att-001", { enabled: true });
  assert.equal(reused.reused, true, "替换失败同样不得让派发失败");
  assert.ok(statSync(file).isDirectory(), "rename 失败时不得用半文件顶掉占位物");
  assert.deepEqual(readdirSync(admin).sort(), before, "替换失败路径必须零残留（临时文件已被清理）");
  assert.deepEqual(tempResidue(admin), [], "替换失败路径不得留下 .tmp-<uuid>");
  assert.equal(readBoardOwner(path), null, "占位/损坏一律视为「无归属证明」");

  // 占位物移除后重试即成功（原子替换不遗留中间态）
  rmSync(file, { recursive: true, force: true });
  prepareAttemptWorktree(root, "g-1", "att-001", { enabled: true });
  assert.equal(readBoardOwner(path)!.canonical_root, root, "占位移除后重试即补写成功");
  assert.deepEqual(tempResidue(admin), [], "重试后仍无残留");
});

// ============================================================================
// 判据 2 / 3：四种损坏标记形态 —— 语义不变（无归属证明 ⇒ 沿用 g-449 取舍放行）
// ============================================================================

test("g-451 判据 2/3：四形态损坏标记仍视为「无归属证明」⇒ 清理面沿用 g-449 取舍放行（不 fail-closed）", () => {
  // 本用例名与断言即「显式记录该取舍」：损坏标记**不是**拒绝理由，清理面不得据此锁死 legacy/孤儿树。
  const shapes: Array<{ name: string; content: string }> = [
    { name: "① 空文件", content: "" },
    { name: "② 半 JSON（截断）", content: '{ "canonical_root": "/tmp/other-board", "goal": "g-001"' },
    { name: "③ 缺字段（无 canonical_root）", content: JSON.stringify({ goal: "g-001", attempt: "att-001", branch: null, created_at: "2026-01-01T00:00:00+08:00" }) },
    { name: "④ 空 root（canonical_root 为空白串）", content: JSON.stringify({ canonical_root: "   ", goal: "g-001", attempt: "att-001", branch: null, created_at: "2026-01-01T00:00:00+08:00" }) },
  ];

  for (const shape of shapes) {
    const { rootB, goalB, treePath } = dualBoard();
    writeFileSync(markerPath(treePath), shape.content);
    assert.equal(
      readBoardOwner(treePath), null,
      `${shape.name}：损坏标记必须解析为「无归属证明」（与标记缺失同值）`,
    );

    const row = listWorktrees(rootB, goalB).find((r) => r.path === treePath);
    assert.ok(row, `${shape.name}：板 B 必须仍能列出该树（不做静默隐藏）`);
    assert.notEqual(row!.status, "protected", `${shape.name}：损坏标记不得被当作他板归属证据`);
    assert.equal(row!.board_owner_root, undefined, `${shape.name}：无归属冲突时不得下发归属观测字段`);

    const res = cleanWorktree(rootB, row!.id, "human:test", true);
    assert.equal(
      res.ok, true,
      `${shape.name}：无归属证明 ⇒ 沿用 g-449 既有取舍放行（清理面不得 fail-closed 锁死遗留树）`,
    );
    assert.ok(!existsSync(treePath), `${shape.name}：放行路径确实完成清理（与既有语义一致）`);
  }
});

test("g-451 判据 3 反向边界：完整有效标记仍被跨板拒绝——修复写入侧不得放宽他板删除的边界", () => {
  const { rootA, rootB, goalB, treePath } = dualBoard();
  // 与上一条的唯一差别：标记是**完整有效**的（由 prepareAttemptWorktree 原子写入）
  assert.notEqual(readBoardOwner(treePath), null, "前置：该树持有一份完整有效标记");

  const row = listWorktrees(rootB, goalB).find((r) => r.path === treePath)!;
  assert.equal(row.status, "protected", "完整有效标记指向他板 ⇒ 必须保护（边界只增不减）");
  assert.equal(row.reason, "protected", "复用既有 reason 枚举，不新增取值");
  assert.equal(row.board_owner_root, rootA, "归属根经加法式通道如实下发");
  // 判据 4：跨板保护行的字段集合 = 单板既有字段 + 加法式 board_owner_root（只增不减）
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "active", "attempt", "board_owner_root", "branch", "clean", "discovered_at", "goal", "head",
      "id", "merged", "path", "reason", "status", "target_branch",
    ].sort(),
    "跨板保护行字段集合不得漂移（仅既有字段 + 加法式归属观测）",
  );

  const res = cleanWorktree(rootB, row.id, "human:test", true);
  assert.equal(res.ok, false, "完整有效标记 ⇒ 跨板清理必须仍被拒绝");
  assert.ok(String(res.reason).includes(rootA), "拒绝理由仍点名归属看板根");
  assert.ok(existsSync(treePath), "拒绝后该树必须原样存在");
});

// ============================================================================
// 判据 1/4：结构性钉住 —— 原子写入不得回退成非原子直写（含负向对照）
// ============================================================================

/** writeBoardOwner 区域切片：以下一个顶层声明为边界（不依赖易漂移的注释文本）。 */
function writeRegionOf(source: string): string {
  const start = source.indexOf("function writeBoardOwner(");
  const end = source.indexOf("function boardRecordedProvenance(", start);
  return start < 0 ? "" : source.slice(start, end < 0 ? source.length : end);
}
/** atomicWrite 区域切片：以注释起点与下一个顶层导出为边界。 */
function atomicRegionOf(source: string): string {
  const start = source.indexOf("export function atomicWrite(");
  const end = source.indexOf("/** 附件存储", start);
  return start < 0 ? "" : source.slice(start, end < 0 ? source.length : end);
}
/** 判定器：标记写入必须走原子原语（同目录 temp + rename），且不得出现非原子直写。 */
function markerWriteViolation(source: string): string | null {
  const region = writeRegionOf(source);
  if (!region) return "缺少 writeBoardOwner";
  if (!/atomicWrite\(join\(dir, BOARD_OWNER_MARKER\), `\$\{JSON\.stringify\(marker\)\}\\n`\)/.test(region)) {
    return "标记写入未走 atomicWrite（同目录临时文件 + rename 原子替换）";
  }
  if (/writeFileSync\(/.test(region)) return "标记写入仍存在非原子直写 writeFileSync";
  if (!/catch \{ return false; \}/.test(region)) return "写失败未回 false（best-effort 语义丢失）";
  return null;
}
/** 判定器：原子原语必须是「同目录 temp + fsync + rename + 失败清理」。 */
function atomicPrimitiveViolation(source: string): string | null {
  const region = atomicRegionOf(source);
  if (!region) return "缺少 atomicWrite";
  if (!/const tmp = join\(dir, `\.tmp-\$\{randomUUID\(\)\}`\)/.test(region)) return "临时文件不再与目标同目录（rename 可能跨设备，失去原子性）";
  if (!/openSync\(tmp, "w"\)/.test(region) || !/fsyncSync\(fd\)/.test(region)) return "缺少写前 fsync（断电仍可能留下空文件）";
  if (!/replaceFileAtomic\(tmp, target\)/.test(region)) return "未用原子替换 replaceFileAtomic(tmp, target)";
  if (!/rmSync\(tmp, \{ force: true \}\)/.test(region)) return "失败路径未清理临时文件";
  return null;
}
/** 只在 writeBoardOwner 区域内做定点变异，避免命中文件内其它同名调用。 */
function mutateWriteRegion(source: string, replacer: (region: string) => string): string {
  const start = source.indexOf("function writeBoardOwner(");
  const end = source.indexOf("function boardRecordedProvenance(", start);
  if (start < 0 || end < 0) return source;
  return source.slice(0, start) + replacer(source.slice(start, end)) + source.slice(end);
}

test("g-451 判据 1 结构钉住：原子写入与「同目录 temp + fsync + rename」一经回退即判红", () => {
  const source = readFileSync(WORKTREE_SOURCE, "utf8");
  const ops = readFileSync(OPS_SOURCE, "utf8");
  assert.equal(markerWriteViolation(source), null, "当前实现必须走原子写入");
  assert.equal(atomicPrimitiveViolation(ops), null, "当前原子原语必须仍是同目录 temp + fsync + rename");

  // 定点变异①：改回修复前的非原子直写形态（逐字摘自基线 87a9218）⇒ 必须判红
  const preFix = mutateWriteRegion(source, (r) =>
    r.replace(
      "atomicWrite(join(dir, BOARD_OWNER_MARKER), `${JSON.stringify(marker)}\\n`);",
      'writeFileSync(join(dir, BOARD_OWNER_MARKER), `${JSON.stringify(marker)}\\n`, "utf8");',
    ));
  assert.notEqual(preFix, source, "变异①必须真实命中标记写入调用");
  assert.notEqual(markerWriteViolation(preFix), null, "非原子直写必须判红");

  // 定点变异②：临时文件挪出同目录（跨设备 rename 不再是原子替换）⇒ 必须判红
  const crossDevice = ops.replace(
    "const tmp = join(dir, `.tmp-${randomUUID()}`);",
    "const tmp = join(tmpdir(), `.tmp-${randomUUID()}`);",
  );
  assert.notEqual(crossDevice, ops, "变异②必须真实命中临时文件路径");
  assert.notEqual(atomicPrimitiveViolation(crossDevice), null, "跨目录临时文件必须判红");

  // 定点变异③：去掉写前 fsync（断电可留空文件）⇒ 必须判红
  const noFsync = ops.replace("    fsyncSync(fd);\n", "");
  assert.notEqual(noFsync, ops, "变异③必须真实命中 fsync");
  assert.notEqual(atomicPrimitiveViolation(noFsync), null, "缺少 fsync 必须判红");
});
