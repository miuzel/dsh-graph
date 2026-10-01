/** g-337：目标编号不复用（删除 / 归档 / 重启 / 创建失败 / 旧项目初始化 / 旧算法负向对照）。
 *
 *  被修 bug：旧 `nextGoalSeq` 只扫「现存 + 归档」frontmatter 的 meta.id 取 max+1；
 *  物理删除**最高号**目标后 max 回落 ⇒ 新目标复用旧编号，而旧事件/关系/卡片/记忆仍引用该编号，
 *  指向被替换的新对象。现高水位 = 现存+归档 frontmatter ∪ events.jsonl 中出现过的 g-NNNN
 *  ∪ root/next-seq.json 持久高水位。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GraphError,
  archiveGoal,
  createGoal,
  deleteGoal,
  init,
  listGoalFiles,
  loadGoal,
  nextGoalSeq,
  saveGoal,
  validate,
} from "../ops.ts";
import { appendEvent, readEvents } from "../events.ts";

const SEQ_FILE = "next-seq.json";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g337-"));
  init(dir);
  return dir;
}

function seqOf(id: string): number {
  return parseInt(id.slice(2), 10);
}

/** 读持久高水位文件（不存在 → 0）。 */
function floorOf(root: string): number {
  const f = join(root, SEQ_FILE);
  if (!existsSync(f)) return 0;
  return JSON.parse(readFileSync(f, "utf8")).max_seq;
}

/** deleteGoal 只接受已归档目标 ⇒ 测试统一走「归档 + 删除」。 */
function archiveAndDelete(root: string, id: string): void {
  archiveGoal(root, id, { actor: "test" });
  deleteGoal(root, id, { actor: "test" });
}

function aliveIds(root: string): string[] {
  return listGoalFiles(root).map((f) => String(loadGoal(f).meta.id)).sort();
}

// ---- 判据 1：删除最高号后新建，编号严格大于历史高水位 ----

test("g-337 判据 1：物理删除最高号目标后，新建编号严格大于历史高水位且不复用", () => {
  const root = tmpRoot();
  const ids = [1, 2, 3].map((i) => createGoal(root, { title: `t${i}`, actor: "test" }));
  assert.deepEqual(ids, ["g-001", "g-002", "g-003"]);

  archiveAndDelete(root, "g-003"); // 物理删除最高号（frontmatter 消失，事件流仍记着它）
  assert.ok(
    !existsSync(join(root, "backlog", "archived", "g-003.md")),
    "前置：最高号目标的文件/目录已被物理删除",
  );

  assert.equal(nextGoalSeq(root), "g-004", "删除最高号后水位不得回退到 g-003");
  const created = createGoal(root, { title: "after delete", actor: "test" });
  assert.equal(created, "g-004", "新建目标不得复用被删的 g-003");

  // 旧引用（事件流）仍指向已删编号，且未被改写
  const evs = readEvents(root);
  assert.ok(
    evs.some((e) => e.event === "goal.deleted" && e.goal === "g-003"),
    "被删目标的 goal.deleted 事件仍是历史证据",
  );
  assert.ok(
    !aliveIds(root).includes("g-003") && aliveIds(root).includes("g-004"),
    "g-003 未复活、g-004 已存在",
  );
  assert.deepEqual(validate(root), [], "全库无 ID 重复等不变式问题");
});

test("g-337 判据 1：连续删除与「非最高号」删除都不回退水位；归档同样不回退", () => {
  const root = tmpRoot();
  for (let i = 1; i <= 6; i++) createGoal(root, { title: `t${i}`, actor: "test" });

  archiveGoal(root, "g-006", { actor: "test" }); // 归档最高号（frontmatter 仍在，但不在存活列表）
  assert.equal(nextGoalSeq(root), "g-007", "归档不回退（g-234 既有行为保持）");
  deleteGoal(root, "g-006", { actor: "test" }); // 再物理删除已归档的最高号
  archiveAndDelete(root, "g-005"); // 连续删除：当前最高号
  archiveAndDelete(root, "g-002"); // 非最高号删除
  archiveAndDelete(root, "g-004"); // 再次删除当前最高号（现存最大仅 g-003）

  assert.equal(nextGoalSeq(root), "g-007", "水位来自事件流，仍为历史最大 6（现存最大只有 g-003）");
  assert.equal(createGoal(root, { title: "n", actor: "test" }), "g-007");
  assert.deepEqual(aliveIds(root), ["g-001", "g-003", "g-007"], "只向后分配，不补号也不改号");
  assert.deepEqual(validate(root), []);
});

// ---- 判据 1/3：重启（新进程 / 新模块实例）后不复用 ----

test("g-337 判据 1/3：重启（新模块实例 + 真·新进程）后编号不复用", async () => {
  const root = tmpRoot();
  createGoal(root, { title: "a", actor: "test" }); // g-001
  createGoal(root, { title: "b", actor: "test" }); // g-002
  archiveAndDelete(root, "g-002");

  // (a) 新模块实例：模块级状态全部重新求值（等价于新进程的首次求值）
  const opsUrl = new URL("../ops.ts", import.meta.url).href;
  const fresh: any = await import(`${opsUrl}?restart=${Date.now()}`);
  assert.notEqual(fresh, undefined);
  assert.equal(fresh.nextGoalSeq(root), "g-003", "新模块实例不再复用 g-002");

  // (b) 真·新进程：子进程内独立分配一次编号
  const script =
    `const m = await import(${JSON.stringify(opsUrl)});` +
    `console.log(m.createGoal(${JSON.stringify(root)}, { title: "child", actor: "child" }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  assert.equal(out.trim(), "g-003", "新进程分配到的编号不复用被删的 g-002");

  // 重启后当前上下文继续分配：承接子进程已占用的编号
  assert.equal(createGoal(root, { title: "d", actor: "test" }), "g-004");
  assert.equal(floorOf(root), 4, "高水位随分配单调上升");
  assert.deepEqual(validate(root), []);
});

// ---- 判据 1/3：创建失败后不复用（编号在落盘前已预留） ----

test("g-337 判据 1/3：目标创建失败（落盘抛错）后，该编号已预留、不再复用", () => {
  const root = tmpRoot();
  // 制造创建失败：backlog/g-001.md 位置被同名目录占用 → 原子写的 rename 必失败（不改动其它路径）
  mkdirSync(join(root, "backlog", "g-001.md"), { recursive: true });
  assert.throws(
    () => createGoal(root, { title: "boom", actor: "test" }),
    "同名目录占用目标路径时创建必须失败",
  );

  assert.equal(nextGoalSeq(root), "g-002", "失败已占用 g-001：绝不回退复用");
  assert.equal(floorOf(root), 1, "失败也留下单调高水位（预留语义）");

  // 故障排除后创建：跳过失败时占用过的编号
  rmSync(join(root, "backlog", "g-001.md"), { recursive: true, force: true });
  assert.equal(createGoal(root, { title: "ok", actor: "test" }), "g-002");
  assert.deepEqual(validate(root), []);
});

// ---- 判据 2：旧项目初始化（无高水位文件）与异常处理 ----

test("g-337 判据 2：旧项目（无 next-seq.json）按现存/归档 + 事件流推导上界并自愈落盘", () => {
  const root = tmpRoot();
  // 手工构造「旧项目」：现存 g-001、已归档 g-004、已物理删除 g-006（只剩事件流记载）
  saveGoal(join(root, "backlog", "g-001.md"), {
    meta: { id: "g-001", title: "旧存活", status: "draft" },
    body: "",
  });
  mkdirSync(join(root, "backlog", "archived"), { recursive: true });
  saveGoal(join(root, "backlog", "archived", "g-004.md"), {
    meta: { id: "g-004", title: "旧归档", status: "draft" },
    body: "",
  });
  appendEvent(root, {
    actor: "test",
    event: "goal.created",
    goal: "g-006",
    details: { title: "已删除" },
  });
  appendEvent(root, { actor: "test", event: "goal.deleted", goal: "g-006", details: { id: "g-006" } });
  assert.ok(!existsSync(join(root, SEQ_FILE)), "前置：旧项目没有持久高水位文件");

  assert.equal(nextGoalSeq(root), "g-007", "上界取现存 g-001 ∪ 归档 g-004 ∪ 事件流 g-006");
  assert.equal(createGoal(root, { title: "新", actor: "test" }), "g-007");
  assert.equal(floorOf(root), 7, "首次分配时把历史高水位自愈落盘");
});

test("g-337 判据 2：全新项目（无任何历史）从 g-001 起，行为可解释", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g337-fresh-"));
  assert.equal(nextGoalSeq(root), "g-001", "无历史 ⇒ g-001（而非跳过或报错）");
  init(root);
  assert.ok(!existsSync(join(root, SEQ_FILE)), "全新项目不建高水位文件（无历史可存）");
  assert.equal(createGoal(root, { title: "first", actor: "test" }), "g-001");
});

test("g-337 判据 2：高水位文件损坏 / 版本不符 / 低于扫描值时自愈，不回退危险编号", () => {
  const root = tmpRoot();
  for (let i = 1; i <= 3; i++) createGoal(root, { title: `t${i}`, actor: "test" }); // g-001..g-003

  writeFileSync(join(root, SEQ_FILE), "{ 不是 JSON", "utf8");
  assert.equal(nextGoalSeq(root), "g-004", "损坏 ⇒ 回退到扫描推导");

  writeFileSync(join(root, SEQ_FILE), JSON.stringify({ version: 99, max_seq: 3 }), "utf8");
  assert.equal(nextGoalSeq(root), "g-004", "版本不符 ⇒ 回退到扫描推导");

  writeFileSync(join(root, SEQ_FILE), JSON.stringify({ version: 1, max_seq: 1 }), "utf8");
  assert.equal(nextGoalSeq(root), "g-004", "伪造过低水位不能降低上界（扫描值胜出）");
  assert.equal(createGoal(root, { title: "z", actor: "test" }), "g-004");
  assert.equal(floorOf(root), 4, "分配时自愈写回真实高水位（单调，只增不减）");

  // 即使有人把高水位文件改回 1，已删的 g-004 也不会复活（事件流仍给出历史上界）
  writeFileSync(join(root, SEQ_FILE), JSON.stringify({ version: 1, max_seq: 1 }), "utf8");
  archiveAndDelete(root, "g-004");
  assert.equal(nextGoalSeq(root), "g-005", "事件流给出历史上界，仍不复用 g-004");
});

test("g-337 判据 2：事件流不可读时 fail-closed（拒绝分配，不回退到危险编号）", () => {
  const root = tmpRoot();
  createGoal(root, { title: "a", actor: "test" }); // g-001
  archiveAndDelete(root, "g-001"); // 该编号只存在于事件流中
  rmSync(join(root, "events.jsonl"), { force: true });
  mkdirSync(join(root, "events.jsonl")); // 目录占位 → 读取必失败

  assert.throws(
    () => nextGoalSeq(root),
    (e: any) => e instanceof GraphError && /无法读取事件流/.test(e.message),
    "历史读不到 ⇒ 拒绝分配，而不是回退到 g-001",
  );
  assert.throws(
    () => createGoal(root, { title: "b", actor: "test" }),
    (e: any) => e instanceof GraphError && /无法读取事件流/.test(e.message),
  );
});

test("g-337 判据 2：init 只建骨架、不写编号状态（无关初始化不污染看板）", () => {
  const root = tmpRoot();
  createGoal(root, { title: "a", actor: "test" }); // g-001
  rmSync(join(root, SEQ_FILE), { force: true }); // 视为「旧项目」（升级前无高水位文件）

  init(root);
  assert.ok(
    !existsSync(join(root, SEQ_FILE)),
    "init 不写 next-seq.json（编号状态只在分配/删除时落盘，避免无关初始化改动看板）",
  );
  assert.equal(nextGoalSeq(root), "g-002", "旧项目仍按现存/归档 + 事件流推导上界");
});

test("g-337 判据 2：旧项目删除时落盘高水位——事件流被裁剪后仍不复用", () => {
  const root = tmpRoot();
  for (let i = 1; i <= 3; i++) createGoal(root, { title: `t${i}`, actor: "test" });
  rmSync(join(root, SEQ_FILE), { force: true }); // 视为「旧项目」

  archiveAndDelete(root, "g-003");
  assert.equal(floorOf(root), 3, "删除路径把历史高水位落盘（旧项目自此有持久兜底）");

  // 模拟事件流被裁剪：历史 g-003 的记载消失（此时仅靠 frontmatter 会退回 g-003）
  const kept = readFileSync(join(root, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => !l.includes("g-003"))
    .join("\n");
  writeFileSync(join(root, "events.jsonl"), kept, "utf8");

  assert.equal(nextGoalSeq(root), "g-004", "持久高水位兜底：事件流裁剪后仍不复用 g-003");
  assert.equal(createGoal(root, { title: "n", actor: "test" }), "g-004");
});

// ---- 判据 3：旧算法负向对照（本 bug 的复现被钉住） ----

test("g-337 判据 3 负向对照：旧算法（只扫现存/归档 frontmatter）确实复用被删编号", () => {
  const root = tmpRoot();
  // 旧实现（g-234）逐字复刻：只看现存 + 归档 frontmatter 取 max+1
  const legacyNextGoalSeq = (r: string): string => {
    let max = 0;
    for (const f of listGoalFiles(r, { includeArchived: true })) {
      let id = "";
      try {
        id = String(loadGoal(f).meta.id ?? "");
      } catch {
        continue;
      }
      const m = /^g-(\d{1,4})$/.exec(id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return "g-" + String(max + 1).padStart(3, "0");
  };

  for (let i = 1; i <= 3; i++) createGoal(root, { title: `t${i}`, actor: "test" });
  archiveAndDelete(root, "g-003");

  assert.equal(legacyNextGoalSeq(root), "g-003", "负向对照：旧算法复用已删编号（bug 复现）");
  assert.equal(nextGoalSeq(root), "g-004", "新算法以事件流为上界，不复用");
  assert.equal(createGoal(root, { title: "n", actor: "test" }), "g-004");
});

// ---- 判据 4：只向后分配；不改号、不重写旧引用；删除门禁不变 ----

test("g-337 判据 4：新建只追加，不改旧目标号、不重写旧事件；删除授权门禁不变", () => {
  const root = tmpRoot();
  const g1 = createGoal(root, { title: "a", actor: "test" });
  createGoal(root, { title: "b", actor: "test" });
  const g3 = createGoal(root, { title: "c", actor: "test" });
  archiveAndDelete(root, g3);

  const before: [string, string][] = listGoalFiles(root, { includeArchived: true }).map((f) => [
    f,
    readFileSync(f, "utf8"),
  ]);
  const eventsBefore = readFileSync(join(root, "events.jsonl"), "utf8");

  const created = createGoal(root, { title: "n", actor: "test" });
  assert.equal(created, "g-004", "新号 > 已删的 g-003");
  assert.equal(seqOf(created) > seqOf(g3), true);

  const eventsAfter = readFileSync(join(root, "events.jsonl"), "utf8");
  assert.ok(eventsAfter.startsWith(eventsBefore), "旧事件逐字不变，只在尾部追加新事件");
  for (const [f, text] of before) {
    assert.equal(readFileSync(f, "utf8"), text, `${f} 未被改写（不自动改号/不迁移引用）`);
  }

  // 删除门禁不变：未归档目标仍拒绝删除（授权/活跃 attempt 校验沿用既有实现）
  assert.throws(
    () => deleteGoal(root, g1, { actor: "test" }),
    /未归档/,
    "未归档目标仍不可删除（g-140 门禁不变）",
  );
  assert.throws(() => deleteGoal(root, created, { actor: "test" }), /未归档/);
});

test("g-337 判据 2/4：编号空间耗尽时拒绝分配（不产生不可表示的编号）", () => {
  const root = tmpRoot();
  // 直接伪造历史高水位到 g-9999（4 位编号空间上限）
  writeFileSync(join(root, SEQ_FILE), JSON.stringify({ version: 1, max_seq: 9999 }), "utf8");
  assert.throws(
    () => nextGoalSeq(root),
    (e: any) => e instanceof GraphError && /编号空间已耗尽/.test(e.message),
    "拒绝分配 g-10000（形态不符会导致后续扫描看不见它 ⇒ 撞号）",
  );
  assert.throws(() => createGoal(root, { title: "x", actor: "test" }), /编号空间已耗尽/);
});
