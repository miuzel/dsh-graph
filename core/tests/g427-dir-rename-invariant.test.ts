/**
 * g-427：Windows 上「**目录形态**目标移动/归档/取消归档**必然 EPERM**」的确定性缺陷 ——
 * 平台无关的不变量断言（Linux 上即可判定，无需 Windows）。
 *
 * 缺陷机制（负责人 Windows 真机实测，采信）：旧实现在目录形态站点先跑
 * `mkdirSync(dirname(targetFile), { recursive: true })` 再 `renameSync(srcDir, dirname(targetFile))`
 * ——对目录形态而言那就是把紧接着那次 rename 的**目标目录本身**建了出来。POSIX 允许
 * `rename(dir, emptyDir)` 替换空目录（本地 Linux 长期掩盖），Windows/NTFS（MoveFileEx）不允许
 * 用目录替换已存在目录 ⇒ EPERM（与权限无关），盘面留下「空目标目录 + 原位文件」且重试永不收敛。
 *
 * 本套件把修复后的契约钉成**可执行断言**（四条不变量）：
 *  ① 不变量：执行目录 rename 之前目标目录必须不存在（在 `fs.renameSync` 上装探针**实拍**观测，
 *     覆盖 moveGoal→version / moveGoal→standalone / archiveGoal / unarchiveGoal / postponeGoal）；
 *  ② 收敛：目标目录已存在且为空（旧缺陷遗留）⇒ 调用成功、不留双份（源已搬走、目标含完整内容）；
 *  ③ 冲突：目标目录已存在且非空 ⇒ 明确 `GraphError`（消息含路径与「已存在」），绝不冒平台
 *     EPERM / ENOTEMPTY；且源目录与预置阻碍物都不被破坏；
 *  ④ 负向对照：把顺序还原为旧写法（先 mkdir 目标目录、再 rename 目录）⇒ 同一探针**必判红**。
 *
 * 探针手法与 g-395 同源（改 `fs.renameSync` + `syncBuiltinESMExports()`），只观测不改变行为；
 * 真实源码回退做实拍负向对照另见本 target 的 attempt 记录（还原旧顺序 ⇒ ①③ 用例全红）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  addCard,
  moveGoal,
  archiveGoal,
  unarchiveGoal,
  postponeGoal,
  loadGoal,
  GraphError,
} from "../ops.ts";
import { readEvents } from "../events.ts";

const ACTOR = "agent:executor";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g427-"));
  init(dir);
  return dir;
}

interface RenameRecord {
  src: string;
  dest: string;
  /** rename **调用那一刻**目标路径是否已存在（不变量违反即 true）。 */
  destExisted: boolean;
}

/** 在 `fs.renameSync` 上装只读探针：记录每次 (src,dest) 与「dest 此刻是否存在」。 */
function withRenameProbe<T>(fn: () => T): { value?: T; err?: unknown; records: RenameRecord[] } {
  const records: RenameRecord[] = [];
  const orig = fs.renameSync;
  fs.renameSync = ((src: unknown, to: unknown, ...rest: unknown[]) => {
    let destExisted = true;
    try {
      lstatSync(String(to));
    } catch {
      destExisted = false;
    }
    records.push({ src: String(src), dest: String(to), destExisted });
    return (orig as (...a: unknown[]) => unknown)(src, to, ...rest);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    return { value: fn(), records };
  } catch (e) {
    return { err: e, records };
  } finally {
    fs.renameSync = orig;
    syncBuiltinESMExports();
  }
}

/** g-427 核心不变量：对 destDir 的目录 rename 恰好一次，且 **rename 时目标目录不存在**。 */
function assertDirRenameInvariant(records: RenameRecord[], srcDir: string, destDir: string): void {
  const hits = records.filter((r) => r.dest === destDir);
  assert.equal(hits.length, 1, `应恰好观测到一次 rename → ${destDir}（实际 ${hits.length} 次）`);
  assert.equal(hits[0].src, srcDir, "目录形态 rename 的源应为源目录本身");
  assert.equal(
    hits[0].destExisted,
    false,
    `不变量违反：rename 执行时目标目录已存在 → ${destDir}（Windows/NTFS 上即 EPERM）`,
  );
}

/** 目录形态独立目标（standalone 创建即目录）＋ 一张 goal 自有卡 ⇒ 目标目录含 cards/ 子目录。 */
function dirFormGoal(root: string, title: string, version: string | null = "standalone"): string {
  const id = createGoal(root, {
    title,
    ...(version ? { version } : {}),
    actor: ACTOR,
  });
  setCriteria(root, id, ["g-427 判据"], ACTOR);
  addCard(root, id, { title: "自有卡", scope: "goal", actor: ACTOR });
  return id;
}

function thrown(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

// ---------------------------------------------------------------------------
// ① 不变量：执行目录 rename 之前目标目录必须不存在（四处站点 + postponeGoal）
// ---------------------------------------------------------------------------

test("g-427①：moveGoal→version（目录形态）rename 前目标目录必须不存在，事件与盘面一致", () => {
  const root = tmpRoot();
  const id = dirFormGoal(root, "g427-move-version");
  const srcDir = join(root, "goals", id);
  const destDir = join(root, "versions", "v1", "goals", id);

  const { err, records } = withRenameProbe(() =>
    moveGoal(root, id, { to: "version", version: "v1", actor: ACTOR }),
  );
  assert.equal(err, undefined, `moveGoal→version 应成功：${String((err as Error)?.message ?? "")}`);
  assertDirRenameInvariant(records, srcDir, destDir);

  assert.ok(existsSync(join(destDir, "goal.md")), "目标应含 goal.md");
  assert.deepEqual(readdirSync(destDir).sort(), ["cards", "goal.md"], "cards/ 子目录应随目录整体搬迁");
  assert.ok(!existsSync(srcDir), "源目录应已搬走（不留双份）");

  const moved = readEvents(root).filter((e) => e.event === "goal.moved");
  assert.equal(moved.length, 1, "应恰有一条 goal.moved");
  assert.equal(moved[0].details.to, `versions/v1/goals/${id}/goal.md`);
  assert.ok(existsSync(join(root, String(moved[0].details.to))), "goal.moved.to 必须与实际盘面一致");
});

test("g-427②：moveGoal→standalone（目录形态）rename 前目标目录必须不存在", () => {
  const root = tmpRoot();
  const id = dirFormGoal(root, "g427-move-standalone", "v-t");
  const srcDir = join(root, "versions", "v-t", "goals", id);
  const destDir = join(root, "goals", id);

  const { err, records } = withRenameProbe(() =>
    moveGoal(root, id, { to: "standalone", actor: ACTOR }),
  );
  assert.equal(err, undefined, `moveGoal→standalone 应成功：${String((err as Error)?.message ?? "")}`);
  assertDirRenameInvariant(records, srcDir, destDir);
  assert.deepEqual(readdirSync(destDir).sort(), ["cards", "goal.md"]);
  assert.ok(!existsSync(srcDir), "源目录应已搬走（不留双份）");

  const ev = readEvents(root).filter((e) => e.event === "goal.moved");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.to, `goals/${id}/goal.md`);
});

test("g-427③：archiveGoal（目录形态）rename 前目标目录必须不存在", () => {
  const root = tmpRoot();
  const id = dirFormGoal(root, "g427-archive", "v-t");
  const srcDir = join(root, "versions", "v-t", "goals", id);
  const destDir = join(root, "versions", "v-t", "archived", id);

  const { err, records } = withRenameProbe(() => archiveGoal(root, id, { actor: ACTOR }));
  assert.equal(err, undefined, `archiveGoal 应成功：${String((err as Error)?.message ?? "")}`);
  assertDirRenameInvariant(records, srcDir, destDir);
  assert.deepEqual(readdirSync(destDir).sort(), ["cards", "goal.md"]);
  assert.ok(!existsSync(srcDir), "源目录应已搬走（不留双份）");
  assert.equal(loadGoal(join(destDir, "goal.md")).meta.archived, true);

  const ev = readEvents(root).filter((e) => e.event === "goal.archived");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.to, `versions/v-t/archived/${id}/goal.md`);
  assert.ok(existsSync(join(root, String(ev[0].details.to))), "goal.archived.to 必须与实际盘面一致");
});

test("g-427④：unarchiveGoal（目录形态）rename 前目标目录必须不存在", () => {
  const root = tmpRoot();
  const id = dirFormGoal(root, "g427-unarchive", "v-t");
  archiveGoal(root, id, { actor: ACTOR });
  const srcDir = join(root, "versions", "v-t", "archived", id);
  const destDir = join(root, "versions", "v-t", "goals", id);

  const { err, records } = withRenameProbe(() => unarchiveGoal(root, id, { actor: ACTOR }));
  assert.equal(err, undefined, `unarchiveGoal 应成功：${String((err as Error)?.message ?? "")}`);
  assertDirRenameInvariant(records, srcDir, destDir);
  assert.deepEqual(readdirSync(destDir).sort(), ["cards", "goal.md"]);
  assert.ok(!existsSync(srcDir), "源目录应已搬走（不留双份）");
  assert.equal(loadGoal(join(destDir, "goal.md")).meta.archived, false);

  const ev = readEvents(root).filter((e) => e.event === "goal.unarchived");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.to, `versions/v-t/goals/${id}/goal.md`);
});

test("g-427⑤：postponeGoal（目录形态，正确范式对照）同口径满足不变量", () => {
  const root = tmpRoot();
  const id = dirFormGoal(root, "g427-postpone", "v-t");
  const srcDir = join(root, "versions", "v-t", "goals", id);
  const destDir = join(root, "backlog", id);

  const { err, records } = withRenameProbe(() =>
    postponeGoal(root, id, { actor: ACTOR, reason: "g427" }),
  );
  assert.equal(err, undefined, `postponeGoal 应成功：${String((err as Error)?.message ?? "")}`);
  assertDirRenameInvariant(records, srcDir, destDir);
  assert.deepEqual(readdirSync(destDir).sort(), ["cards", "goal.md"]);
  assert.ok(!existsSync(srcDir), "源目录应已搬走（不留双份）");
});

// ---------------------------------------------------------------------------
// ② 收敛：残留空目标目录（旧缺陷遗留）⇒ 成功且不留双份
// ---------------------------------------------------------------------------

test("g-427⑥：moveGoal→version 遇残留空目标目录 ⇒ 自愈收敛、不留双份", () => {
  const root = tmpRoot();
  const id = dirFormGoal(root, "g427-converge-move");
  const srcDir = join(root, "goals", id);
  const destDir = join(root, "versions", "v1", "goals", id);
  mkdirSync(destDir, { recursive: true }); // 旧缺陷现场：空的目标目录 + 原位文件
  assert.deepEqual(readdirSync(destDir), [], "前置：残留目标目录为空");

  const { err, records } = withRenameProbe(() =>
    moveGoal(root, id, { to: "version", version: "v1", actor: ACTOR }),
  );
  assert.equal(err, undefined, `残留空目录应可自愈：${String((err as Error)?.message ?? "")}`);
  assertDirRenameInvariant(records, srcDir, destDir); // 空目录被先清理，rename 时目标不存在
  assert.deepEqual(readdirSync(destDir).sort(), ["cards", "goal.md"], "目标应含完整内容");
  assert.ok(!existsSync(srcDir), "源目录应已搬走（不留双份）");
  assert.equal(readEvents(root).filter((e) => e.event === "tx.persist_failed").length, 0);
});

test("g-427⑦：archiveGoal 遇残留空归档目录 ⇒ 自愈收敛、不留双份", () => {
  const root = tmpRoot();
  const id = dirFormGoal(root, "g427-converge-archive", "v-t");
  const srcDir = join(root, "versions", "v-t", "goals", id);
  const destDir = join(root, "versions", "v-t", "archived", id);
  mkdirSync(destDir, { recursive: true });

  const { err, records } = withRenameProbe(() => archiveGoal(root, id, { actor: ACTOR }));
  assert.equal(err, undefined, `残留空目录应可自愈：${String((err as Error)?.message ?? "")}`);
  assertDirRenameInvariant(records, srcDir, destDir);
  assert.deepEqual(readdirSync(destDir).sort(), ["cards", "goal.md"]);
  assert.ok(!existsSync(srcDir), "源目录应已搬走（不留双份）");
});

test("g-427⑧：unarchiveGoal 遇残留空目标目录 ⇒ 自愈收敛、不留双份", () => {
  const root = tmpRoot();
  const id = dirFormGoal(root, "g427-converge-unarchive", "v-t");
  archiveGoal(root, id, { actor: ACTOR });
  const srcDir = join(root, "versions", "v-t", "archived", id);
  const destDir = join(root, "versions", "v-t", "goals", id);
  mkdirSync(destDir, { recursive: true });

  const { err, records } = withRenameProbe(() => unarchiveGoal(root, id, { actor: ACTOR }));
  assert.equal(err, undefined, `残留空目录应可自愈：${String((err as Error)?.message ?? "")}`);
  assertDirRenameInvariant(records, srcDir, destDir);
  assert.deepEqual(readdirSync(destDir).sort(), ["cards", "goal.md"]);
  assert.ok(!existsSync(srcDir), "源目录应已搬走（不留双份）");
});

// ---------------------------------------------------------------------------
// ③ 冲突：目标目录已存在且非空 ⇒ 明确 GraphError（不是平台 EPERM/ENOTEMPTY）
// ---------------------------------------------------------------------------

test("g-427⑨：目标目录已存在且非空 ⇒ 明确 GraphError（含路径与「已存在」），源与阻碍物均不被破坏", () => {
  const root = tmpRoot();
  const id = dirFormGoal(root, "g427-conflict");
  const srcDir = join(root, "goals", id);
  const destDir = join(root, "versions", "v1", "goals", id);
  mkdirSync(join(destDir, "cards"), { recursive: true });
  writeFileSync(join(destDir, "cards", "leftover.md"), "阻碍物\n", "utf8");

  const err = thrown(() => moveGoal(root, id, { to: "version", version: "v1", actor: ACTOR }));
  assert.ok(err instanceof GraphError, `应为 GraphError，实际：${String(err)}`);
  const msg = (err as Error).message;
  assert.ok(msg.includes(destDir), `错误消息必须含路径：${msg}`);
  assert.ok(msg.includes("已存在"), `错误消息必须含「已存在」语义：${msg}`);
  assert.ok(!/EPERM|ENOTEMPTY/.test(msg), `不得把平台 EPERM/ENOTEMPTY 直接冒给用户：${msg}`);

  // 源目录完整留在原位；预置的非空目标目录及其内容未被破坏
  assert.ok(existsSync(join(srcDir, "goal.md")), "源目录仍在原位（未发生半迁移）");
  assert.deepEqual(readdirSync(srcDir).sort(), ["cards", "goal.md"]);
  assert.deepEqual(readdirSync(destDir), ["cards"], "预置的非空目标目录结构未被改动");
  assert.ok(existsSync(join(destDir, "cards", "leftover.md")), "预置阻碍物不应被删除");
  assert.ok(!existsSync(join(destDir, "goal.md")), "不得把目标写成半成品");

  // g-395 契约不变：persist 阶段失败仍留 tx.persist_failed 诊断（事件已先行）
  assert.equal(readEvents(root).filter((e) => e.event === "tx.persist_failed").length, 1);
  assert.equal(readEvents(root).filter((e) => e.event === "goal.moved").length, 1);
});

test("g-427⑩：目标路径已存在但**不是目录** ⇒ 同样明确 GraphError，不冒平台错误", () => {
  const root = tmpRoot();
  const id = dirFormGoal(root, "g427-conflict-file");
  const destDir = join(root, "versions", "v1", "goals", id);
  mkdirSync(join(root, "versions", "v1", "goals"), { recursive: true });
  writeFileSync(destDir, "占位文件\n", "utf8"); // 目标路径是文件而非目录

  const err = thrown(() => moveGoal(root, id, { to: "version", version: "v1", actor: ACTOR }));
  assert.ok(err instanceof GraphError, `应为 GraphError，实际：${String(err)}`);
  const msg = (err as Error).message;
  assert.ok(msg.includes(destDir) && msg.includes("已存在"), `消息须含路径与「已存在」：${msg}`);
  assert.ok(!/EPERM|ENOTEMPTY|ENOTDIR/.test(msg), `不得冒平台错误码：${msg}`);
  assert.ok(existsSync(join(root, "goals", id, "goal.md")), "源目录仍在原位");
});

// ---------------------------------------------------------------------------
// ④ 负向对照：旧顺序（先 mkdir 目标目录、再 rename 目录）被同一探针判红
// ---------------------------------------------------------------------------

test("g-427⑪负向对照：旧顺序（先建目标目录再 rename）⇒ 不变量断言必红（证明用例能鉴别缺陷）", () => {
  const root = tmpRoot();
  const srcDir = join(root, "legacy-src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "goal.md"), "x\n", "utf8");
  const destDir = join(root, "versions", "v1", "goals", "g-999");

  const { records } = withRenameProbe(() => {
    // 旧写法（g-427 缺陷形态）：先 `mkdirSync(dirname(targetFile), {recursive:true})` == 建出目标目录，再 rename
    mkdirSync(destDir, { recursive: true });
    fs.renameSync(srcDir, destDir);
  });

  const hit = records.find((r) => r.dest === destDir);
  assert.ok(hit, "应观测到对目标目录的 rename");
  assert.equal(hit!.destExisted, true, "旧顺序下 rename 时目标目录已存在（Windows 上即 EPERM）");
  assert.throws(
    () => assertDirRenameInvariant(records, srcDir, destDir),
    /不变量违反/,
    "同一不变量断言必须判红——证明它能鉴别本缺陷，而非只测源码文本",
  );
});

// ---------------------------------------------------------------------------
// 回归：扁平文件形态不受影响（其目标目录仍必须由调用方建好）
// ---------------------------------------------------------------------------

test("g-427⑫：扁平文件形态（backlog .md → standalone/version）不受影响，目标目录仍被建好", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "g427-flat", actor: ACTOR }); // backlog 平铺（无 version）
  const destDir = join(root, "goals", id);
  const destFile = join(destDir, "goal.md");

  const { err, records } = withRenameProbe(() =>
    moveGoal(root, id, { to: "standalone", actor: ACTOR }),
  );
  assert.equal(err, undefined, `扁平形态迁移应成功：${String((err as Error)?.message ?? "")}`);
  assert.ok(existsSync(destFile), "扁平文件应落到目标目录");
  const hit = records.find((r) => r.dest === destFile);
  assert.ok(hit, "应观测到文件形态 rename（src → dest/goal.md）");
  assert.equal(hit!.src, join(root, "backlog", `${id}.md`), "扁平形态 rename 源应是 .md 文件");
  assert.equal(hit!.destExisted, false, "目标文件此前不存在（目录由 mkdirSync 建好，合法）");
  assert.ok(!existsSync(join(root, "backlog", `${id}.md`)), "原位文件应已搬走");
});

test("g-427⑬：moveGoal→backlog（目录→扁平，无卡片时收拢为 .md）不回归", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "g427-to-backlog", version: "v-t", actor: ACTOR });
  // 不带 cards/：目录形态源（goal.md 独占）可移回 backlog 平铺
  const srcDir = join(root, "versions", "v-t", "goals", id);
  const { err } = withRenameProbe(() => moveGoal(root, id, { to: "backlog", actor: ACTOR }));
  assert.equal(err, undefined, `移回 backlog 应成功：${String((err as Error)?.message ?? "")}`);
  assert.ok(existsSync(join(root, "backlog", `${id}.md`)), "应落为平铺 .md");
  assert.ok(!existsSync(srcDir), "空源目录应被收拢移除");
});
