/**
 * g-499 判据套件：目标路径迁移后 `reviews/*.md` 的 `report_file` 不得成为死链。
 *
 * 缺陷形态（bug，负责人可在真机复现）：`settleReview` 把 `report_file` 写成**绝对路径**。目标被
 * `moveGoal`（跨版本 / 移至独立目录）、`archiveGoal`、`unarchiveGoal`（以及同形的 `postponeGoal`）
 * 整体搬迁目录后，该绝对路径仍指向老位置 ⇒ **死链**：记录自称报告在 `<老位置>/reviews/<id>.md`，
 * 物理文件却已随目录搬走。
 *
 * 断言面（每条对应主管给定的验收项）：
 *  1. **正确性**：archiveGoal / unarchiveGoal / moveGoal（→version / →standalone）之后，每条评审记录的
 *     `report_file` 都指向**真实存在**的文件，且等于该记录当前的绝对落盘路径；跨多次迁移仍成立。
 *  2. **兼容性与幂等**：已是正确路径的记录零写入（mtime + 字节不变）；无 `report_file` / `null` /
 *     非字符串的历史记录不被注入字段；目标没有 `reviews/` 时迁移照常成功；坏记录不影响其余记录与迁移。
 *  3. **负向对照**：把 `report_file` 人为改成老位置（模拟修复前已存在的历史死链）后再次迁移，
 *     必须被纠正为真实路径 —— 证明断言真的能抓到死链，而不是恒真。
 *
 * hermetic：全部在 tmp 目录的私有看板副本内进行，不触碰仓库数据、不建 git 仓库、不起子代理。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  init,
  createGoal,
  setCriteria,
  appendReviewDispatch,
  bindReviewChild,
  settleReview,
  reviewRecordFile,
  reviewsDir,
  reconcileReviewReportFiles,
  moveGoal,
  archiveGoal,
  unarchiveGoal,
  findGoalFile,
  loadGoal,
} from "../ops.ts";

const CANDIDATE = "a".repeat(40);

// =====================================================================================
// 夹具
// =====================================================================================

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g499-"));
  init(dir);
  return dir;
}

/** 在目标目录内造一个真实 attempt（`appendReviewDispatch` 的前置校验要求它存在）。 */
function seedAttempt(root: string, goalId: string, attempt = "att-001"): void {
  const dir = join(goalDirPath(root, goalId), "attempts", attempt);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "attempt.md"), `---\n${JSON.stringify({ id: attempt, goal: goalId })}\n---\n\n`);
}

/** 目标目录（目录形态）/ 文件所在目录（backlog 平铺形态）的绝对路径。 */
function goalDirPath(root: string, goalId: string): string {
  const file = findGoalFile(root, goalId);
  return file.slice(0, file.length - "goal.md".length || undefined).replace(/(\.md)$/, "");
}

/** 建一个目录形态目标（standalone），登记一条**已结算 PASS** 的评审记录，返回 goal / review_id。 */
function seedStandaloneWithReview(root: string, title = "g499"): { goal: string; reviewId: string } {
  const goal = createGoal(root, { title, actor: "t" });
  moveGoal(root, goal, { to: "standalone", actor: "t" }); // 目录形态才有 reviews/
  setCriteria(root, goal, ["判据一：占位 ✅已验"]);
  seedAttempt(root, goal);
  const { review_id } = appendReviewDispatch(root, {
    goalId: goal,
    sourceAttempt: "att-001",
    candidateSha: CANDIDATE,
    requestedBy: "agent:sess-t",
    actor: "t",
  });
  bindReviewChild(root, goal, review_id, "child-rev-1", "t");
  settleReview(root, goal, review_id, {
    text: "**总判**：PASS\n逐项结论：判据一 ✅ 证据：占位\n未验证项：无\n",
    stopReason: "completed",
    actor: "t",
  });
  return { goal, reviewId: review_id };
}

/** 读取某条评审记录的 meta。 */
function metaOf(root: string, goal: string, reviewId: string): Record<string, any> {
  const file = reviewRecordFile(root, goal, reviewId);
  assert.ok(existsSync(file), `评审记录文件应存在：${file}`);
  return loadGoal(file).meta as Record<string, any>;
}

/**
 * 核心断言：当前目标的**每一条**评审记录，其 `report_file` 都必须指向真实存在的文件，
 * 且等于该记录当前的绝对落盘路径。返回该目标目录下评审记录的文件名列表（便于附带核验）。
 */
function assertAllReportFilesLive(root: string, goal: string, stage: string): string[] {
  const dir = reviewsDir(root, goal);
  assert.ok(existsSync(dir), `[${stage}] reviews/ 目录应存在：${dir}`);
  const names = readdirSync(dir).filter((n) => n.startsWith("rev-") && n.endsWith(".md"));
  assert.ok(names.length > 0, `[${stage}] 应至少有一条评审记录`);
  for (const name of names) {
    const reviewId = name.slice(0, -3);
    const expected = join(dir, name);
    let meta: Record<string, any>;
    try {
      meta = loadGoal(expected).meta as Record<string, any>;
    } catch {
      continue; // 坏记录（不可解析）不在本断言语义内：helper 明确跳过它们
    }
    assert.equal(
      meta.report_file,
      expected,
      `[${stage}] ${name} 的 report_file 应为当前绝对路径`,
    );
    assert.ok(
      existsSync(String(meta.report_file)),
      `[${stage}] ${name} 的 report_file 不得是死链：${String(meta.report_file)}`,
    );
    // 内容依然可读：正文与结论随文件一起搬迁，未损坏
    const doc = loadGoal(expected);
    assert.equal(doc.meta.conclusion, "PASS", `[${stage}] ${name} 结论应随记录保持`);
    assert.match(String(doc.body), /总判/, `[${stage}] ${name} 报告正文应可读`);
  }
  return names;
}

// =====================================================================================
// 判据 1：正确性 —— 三类迁移后 report_file 必须活链
// =====================================================================================

test("g-499 判据1：moveGoal（standalone → version）后 report_file 指向新位置且可读", () => {
  const root = tmpRoot();
  const { goal, reviewId } = seedStandaloneWithReview(root);
  const before = metaOf(root, goal, reviewId).report_file;
  assert.ok(existsSync(String(before)), "迁移前 report_file 应可读");

  moveGoal(root, goal, { to: "version", version: "v9", actor: "t" });

  const names = assertAllReportFilesLive(root, goal, "move→version");
  assert.deepEqual(names, [`${reviewId}.md`]);
  const after = metaOf(root, goal, reviewId).report_file;
  assert.notEqual(after, before, "迁移后 report_file 应随位置更新");
  assert.ok(
    String(after).includes(join("versions", "v9", "goals", goal, "reviews")),
    `迁移后 report_file 应指向版本目录：${String(after)}`,
  );
});

test("g-499 判据1：moveGoal（snapshot → standalone）后 report_file 指向新位置且可读", () => {
  const root = tmpRoot();
  const { goal, reviewId } = seedStandaloneWithReview(root);
  // standalone → version → standalone：两次迁移都必须收敛
  moveGoal(root, goal, { to: "version", version: "v3", actor: "t" });
  moveGoal(root, goal, { to: "standalone", actor: "t" });

  assertAllReportFilesLive(root, goal, "move→standalone");
  const meta = metaOf(root, goal, reviewId);
  assert.ok(
    String(meta.report_file).includes(join("goals", goal, "reviews")),
    `report_file 应指向独立目标目录：${String(meta.report_file)}`,
  );
});

test("g-499 判据1：archiveGoal 后 report_file 指向 archived 目录且可读", () => {
  const root = tmpRoot();
  const { goal, reviewId } = seedStandaloneWithReview(root);
  moveGoal(root, goal, { to: "version", version: "v9", actor: "t" });

  archiveGoal(root, goal, { actor: "t" });

  const names = assertAllReportFilesLive(root, goal, "archive");
  assert.deepEqual(names, [`${reviewId}.md`], "归档不丢评审记录");
  const meta = metaOf(root, goal, reviewId);
  assert.ok(
    String(meta.report_file).includes(join("versions", "v9", "archived", goal, "reviews")),
    `归档后 report_file 应指向 archived 目录：${String(meta.report_file)}`,
  );
});

test("g-499 判据1：unarchiveGoal 后 report_file 指回原目录且可读", () => {
  const root = tmpRoot();
  const { goal, reviewId } = seedStandaloneWithReview(root);
  moveGoal(root, goal, { to: "version", version: "v9", actor: "t" });
  archiveGoal(root, goal, { actor: "t" });

  unarchiveGoal(root, goal, { actor: "t" });

  assertAllReportFilesLive(root, goal, "unarchive");
  const meta = metaOf(root, goal, reviewId);
  assert.ok(
    String(meta.report_file).includes(join("versions", "v9", "goals", goal, "reviews")),
    `取消归档后 report_file 应指回版本 goals/ 目录：${String(meta.report_file)}`,
  );
  assert.ok(!String(meta.report_file).includes("archived"), "取消归档后不得残留 archived 段");
});

test("g-499 判据1：standalone 目标归档→取消归档往返后 report_file 活链", () => {
  const root = tmpRoot();
  const { goal, reviewId } = seedStandaloneWithReview(root);

  archiveGoal(root, goal, { actor: "t" });
  assertAllReportFilesLive(root, goal, "standalone archive");
  unarchiveGoal(root, goal, { actor: "t" });
  assertAllReportFilesLive(root, goal, "standalone unarchive");

  const meta = metaOf(root, goal, reviewId);
  assert.ok(
    String(meta.report_file).includes(join("goals", goal, "reviews")),
    `往返后应回到 goals/<id>/reviews：${String(meta.report_file)}`,
  );
});

test("g-499 判据1：连续 6 次迁移（跨版本/归档/取消归档）后仍无死链", () => {
  const root = tmpRoot();
  const { goal, reviewId } = seedStandaloneWithReview(root);
  const stages: Array<[string, () => void]> = [
    ["→version v1", () => moveGoal(root, goal, { to: "version", version: "v1", actor: "t" })],
    ["archive", () => archiveGoal(root, goal, { actor: "t" })],
    ["unarchive", () => unarchiveGoal(root, goal, { actor: "t" })],
    ["→version v2", () => moveGoal(root, goal, { to: "version", version: "v2", actor: "t" })],
    ["→standalone", () => moveGoal(root, goal, { to: "standalone", actor: "t" })],
    ["archive", () => archiveGoal(root, goal, { actor: "t" })],
  ];
  for (const [label, run] of stages) {
    run();
    assertAllReportFilesLive(root, goal, label);
  }
  assert.equal(metaOf(root, goal, reviewId).conclusion, "PASS", "多轮迁移后结论不失真");
});

test("g-499 判据1：多条评审记录（不同 attempt）逐一更新，互不遗漏", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "multi", actor: "t" });
  moveGoal(root, goal, { to: "standalone", actor: "t" });
  setCriteria(root, goal, ["判据一：占位 ✅已验"]);
  const ids: string[] = [];
  for (const att of ["att-001", "att-002", "att-003"]) {
    seedAttempt(root, goal, att);
    const { review_id } = appendReviewDispatch(root, {
      goalId: goal, sourceAttempt: att, candidateSha: CANDIDATE,
      requestedBy: "agent:sess-t", actor: "t",
    });
    bindReviewChild(root, goal, review_id, `child-${att}`, "t");
    settleReview(root, goal, review_id, {
      text: "**总判**：PASS\n逐项结论：判据一 ✅\n未验证项：无\n", stopReason: "completed", actor: "t",
    });
    ids.push(review_id);
  }
  archiveGoal(root, goal, { actor: "t" });
  const names = assertAllReportFilesLive(root, goal, "3 records archive");
  assert.equal(names.length, 3, "三条记录一条都不能漏");
  for (const rid of ids) {
    assert.ok(names.includes(`${rid}.md`), `记录 ${rid} 应仍在`);
    assert.ok(!String(metaOf(root, goal, rid).report_file).includes("goals/" + goal + "/reviews"),
      `记录 ${rid} 的 report_file 不应仍指归档前位置`);
  }
});

// =====================================================================================
// 判据 2：兼容性与幂等
// =====================================================================================

test("g-499 判据2：重复迁移/重复调用 reconcile 是幂等的（字节与 mtime 均不变）", () => {
  const root = tmpRoot();
  const { goal, reviewId } = seedStandaloneWithReview(root);
  moveGoal(root, goal, { to: "version", version: "v4", actor: "t" });

  const file = reviewRecordFile(root, goal, reviewId);
  const bytes = readFileSync(file, "utf8");
  const mtime = statSync(file).mtimeMs;

  // ① 再次调用 helper：已是正确路径 ⇒ 零写入
  const rewritten = reconcileReviewReportFiles(root, goal);
  assert.deepEqual(rewritten, [], "已正确的记录不得被重写");
  assert.equal(readFileSync(file, "utf8"), bytes, "内容字节不变");
  assert.equal(statSync(file).mtimeMs, mtime, "mtime 不变（零写入，而非原样回写）");

  // ② no-op 迁移（已在目标位置）：helper 不被触发，同样零写入
  moveGoal(root, goal, { to: "version", version: "v4", actor: "t" });
  assert.equal(readFileSync(file, "utf8"), bytes, "no-op 迁移不得改动记录");
  assert.equal(statSync(file).mtimeMs, mtime, "no-op 迁移不得刷新 mtime");
  assertAllReportFilesLive(root, goal, "idempotent");
});

test("g-499 判据2：无 report_file 字段的历史记录不被注入字段，也不阻断迁移", () => {
  const root = tmpRoot();
  const { goal, reviewId } = seedStandaloneWithReview(root);
  const file = reviewRecordFile(root, goal, reviewId);
  // 模拟修复前更早的历史记录：完全没有 report_file 键
  const doc = loadGoal(file);
  delete (doc.meta as Record<string, any>).report_file;
  writeFileSync(file, serializeLike(doc));

  moveGoal(root, goal, { to: "version", version: "v5", actor: "t" });

  // 迁移必须成功，且记录仍可读
  const after = loadGoal(reviewRecordFile(root, goal, reviewId));
  assert.equal(after.meta.conclusion, "PASS", "迁移后记录仍可读");
  assert.equal(after.meta.report_file, reviewRecordFile(root, goal, reviewId),
    "缺失字段应被补为当前正确路径（而非留空/留旧值）");
});

test("g-499 判据2：report_file 为 null / 非字符串时被纠正为真实路径", () => {
  const root = tmpRoot();
  const { goal, reviewId } = seedStandaloneWithReview(root);
  const file = reviewRecordFile(root, goal, reviewId);

  for (const bogus of [null, 12345, { a: 1 }]) {
    const doc = loadGoal(file);
    (doc.meta as Record<string, any>).report_file = bogus;
    writeFileSync(file, serializeLike(doc));
    const rewritten = reconcileReviewReportFiles(root, goal);
    assert.ok(rewritten.includes(`${reviewId}.md`), `report_file=${JSON.stringify(bogus)} 应被纠正`);
    assert.equal(
      loadGoal(file).meta.report_file,
      reviewRecordFile(root, goal, reviewId),
      `report_file=${JSON.stringify(bogus)} 应被纠正为真实路径`,
    );
  }
});

test("g-499 判据2：目标没有 reviews/ 目录时迁移照常成功（零副作用）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "no-reviews", actor: "t" });
  moveGoal(root, goal, { to: "standalone", actor: "t" });
  setCriteria(root, goal, ["判据一：占位 ✅已验"]);
  assert.deepEqual(reconcileReviewReportFiles(root, goal), [], "无 reviews/ 时返回空数组且不抛错");

  // 目录形态 → 版本 → 归档 → 取消归档：全程不得因 helper 抛错
  moveGoal(root, goal, { to: "version", version: "v6", actor: "t" });
  archiveGoal(root, goal, { actor: "t" });
  unarchiveGoal(root, goal, { actor: "t" });
  assert.ok(existsSync(findGoalFile(root, goal)), "目标应已收敛回可定位位置");
});

test("g-499 判据2：坏记录（不可解析）被跳过，不影响其余记录与迁移", () => {
  const root = tmpRoot();
  const { goal, reviewId } = seedStandaloneWithReview(root);
  const dir = reviewsDir(root, goal);
  // 一条损坏的评审记录 + 一个无关文件：都不得阻断迁移
  writeFileSync(join(dir, "rev-att-001-99.md"), "这不是合法 frontmatter");
  writeFileSync(join(dir, "notes.txt"), "无关文件");

  moveGoal(root, goal, { to: "version", version: "v7", actor: "t" });

  assertAllReportFilesLive(root, goal, "bad record tolerated");
  const meta = metaOf(root, goal, reviewId);
  assert.ok(String(meta.report_file).includes(join("versions", "v7")), "好记录仍被正确更新");
  const dirAfter = reviewsDir(root, goal); // 迁移后重新解析（老 dir 已随目录搬走）
  assert.equal(readFileSync(join(dirAfter, "notes.txt"), "utf8"), "无关文件", "非评审文件不得被改写");
  assert.equal(readFileSync(join(dirAfter, "rev-att-001-99.md"), "utf8"), "这不是合法 frontmatter",
    "坏记录不得被 helper 覆盖");
});

// =====================================================================================
// 判据 3：负向对照 —— 断言必须真的能抓到死链
// =====================================================================================

test("g-499 判据3（负向对照）：人为植入老位置死链后，迁移必须纠正它", () => {
  const root = tmpRoot();
  const { goal, reviewId } = seedStandaloneWithReview(root);
  const stalePath = String(metaOf(root, goal, reviewId).report_file);

  // 先迁移，再把 report_file 人为改回**老位置**（模拟修复前已存在的历史死链）
  moveGoal(root, goal, { to: "version", version: "v8", actor: "t" });
  const file = reviewRecordFile(root, goal, reviewId); // 迁移**之后**才解析新位置
  const doc = loadGoal(file);
  (doc.meta as Record<string, any>).report_file = stalePath;
  writeFileSync(file, serializeLike(doc));
  assert.ok(!existsSync(stalePath), "负向对照前提：老位置确实是死链");

  // 迁移必须把它纠正回来（否则本套件就是恒真的空断言）
  archiveGoal(root, goal, { actor: "t" });
  assertAllReportFilesLive(root, goal, "negative control repaired");
});

test("g-499 判据3（负向对照）：断言本身能识别死链（对未修复形态判红）", () => {
  const root = tmpRoot();
  const { goal, reviewId } = seedStandaloneWithReview(root);
  const file = reviewRecordFile(root, goal, reviewId);
  // 人为制造「记录自称报告在不存在处」——即修复前的真实形态
  const doc = loadGoal(file);
  (doc.meta as Record<string, any>).report_file = join(root, "goals", "g-999", "reviews", `${reviewId}.md`);
  writeFileSync(file, serializeLike(doc));

  assert.throws(
    () => assertAllReportFilesLive(root, goal, "negative control self-check"),
    /report_file 应为当前绝对路径/,
    "断言必须对死链形态判红（证明断言非恒真）",
  );
});

// =====================================================================================
// helper：序列化为看板 frontmatter 形态（与 loadGoal 对偶，供测试直写记录）
// =====================================================================================

function serializeLike(doc: { meta: Record<string, any>; body: string }): string {
  return `---\n${JSON.stringify(doc.meta, null, 2)}\n---\n${doc.body}`;
}
