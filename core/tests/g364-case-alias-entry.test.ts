/**
 * core/tests/g364-case-alias-entry.test.ts
 *
 * g-364：**真实命名入口**在「大小写不敏感卷」上的别名与引用一致性守卫。
 *
 * 为什么需要（真实缺口，不是理论风险）：
 *   大小写不敏感卷（APFS 默认、WSL 的 drvfs `/mnt/*`、部分网络挂载）把仅大小写不同的名字
 *   折叠到同一实体。此前的入口按**请求拼写**读写并回填，于是：
 *     ① 附件同内容幂等存储会返回一个**磁盘上并不存在的拼写**（`Report.md` 而磁盘是 `report.md`）
 *        ⇒ 该 `@att/` 引用搬到大小写敏感卷（Linux ext4）上直接悬空；
 *     ② 删除守卫按**字面相等**计数引用 ⇒ 别名拼写的引用被漏计，删除会把仍被引用的文件删掉（悬空）；
 *     ③ 版本泳道写入口（createVersion / createGoal --version / moveGoal / renameVersion）在
 *        `mkdir`/`existsSync` 上静默复用别名泳道 ⇒ 写出 `meta.version` 与目录名不一致的目标
 *        （validate 的 locationProblems 必报错）、并在事件流里记下磁盘上不存在的 slug。
 *
 * 本套件的钉法：
 *   A. **卷语义可注入**（`withCaseInsensitiveVolumeForTesting`）：大小写敏感性由注入决定，
 *      不依赖真实不敏感挂载，也**不往生产看板写探针**；
 *   B. **精确名优先**：逐字节同名永远不是别名——大小写**敏感**卷上只有异名条目时不得判为别名
 *      （这是「敏感卷 + 精确名正常路径不得误伤」的正向回归）；敏感卷与不敏感卷两向都有断言；
 *   C. **负向对照**：把修复前的「按请求拼写 / 按字面相等」语义逐条复刻在同一注入卷上，
 *      断言旧语义必然给出磁盘上不存在的名字或漏计引用（回退修复即红）。
 *
 * 平台边界（如实标注）：本套件在 Linux/WSL2 的 **ext4（大小写敏感）** 上运行，不敏感卷行为
 *   全部由注入复现；**原生 Windows / macOS 真机未实测**（分别在 README 平台状态表与
 *   `docs/case-alias-naming.md` 中标注为未验证）。Unicode 规范化（macOS NFD/NFC）只覆盖了
 *   `foldEntryName` 的折叠键，未做真机验证。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  addCard,
  attachmentProblems,
  attachmentReferenceCount,
  attachmentsDir,
  createGoal,
  deleteAttachment,
  deleteCard,
  fillCard,
  findGoalFile,
  init,
  isCaseInsensitiveVolumeInjected,
  listAttachments,
  listGoalFiles,
  loadGoal,
  moveGoal,
  parseAttachmentRefs,
  resolveExistingEntry,
  storeAttachment,
  validate,
  withCaseInsensitiveVolumeForTesting,
} from "../ops.ts";
import { caseAliasVersionSlug, createVersion, renameVersion } from "../version-lane.ts";
import { readEvents } from "../events.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "g364-"));
  init(dir);
  return dir;
}

/** 非隐藏的 attachments 根条目（磁盘真实拼写）。 */
function attEntries(root: string): string[] {
  return readdirSync(attachmentsDir(root)).filter((n) => !n.startsWith(".")).sort();
}

function cardBody(root: string, goalId: string, cardId: string): string {
  const cardFile = join(dirname(findGoalFile(root, goalId)), "cards", `${cardId}.md`);
  return readFileSync(cardFile, "utf8");
}

// ---------------------------------------------------------------------------
// A. 卷语义解析器（纯语义）
// ---------------------------------------------------------------------------

test("g-364 解析器：精确名优先；敏感卷不产生假别名；注入不敏感语义才折叠", () => {
  const dir = mkdtempSync(join(tmpdir(), "g364-entry-"));
  try {
    // 默认**不注入**：生产路径的判定完全来自真实文件系统（此断言钉住「默认即真实卷语义」）
    assert.equal(isCaseInsensitiveVolumeInjected(), false);
    writeFileSync(join(dir, "foo.md"), "a", "utf8");
    // 敏感卷（默认，无注入）：请求仅大小写不同 ⇒ 不认为命中既有条目（**不产生假别名**）
    assert.equal(resolveExistingEntry(dir, "Foo.md"), null);
    // 精确名永远命中且不是别名
    assert.deepEqual(resolveExistingEntry(dir, "foo.md"), { actual: "foo.md", aliased: false });
    // 注入不敏感卷语义：折叠命中并返回磁盘实际拼写
    assert.deepEqual(
      withCaseInsensitiveVolumeForTesting(true, () => resolveExistingEntry(dir, "Foo.md")),
      { actual: "foo.md", aliased: true },
    );
    assert.equal(isCaseInsensitiveVolumeInjected(), false, "注入必须被还原（不泄漏到其它用例/生产路径）");
    // 注入模式下精确名仍是精确名（**不得被降级为别名**）
    assert.deepEqual(
      withCaseInsensitiveVolumeForTesting(true, () => resolveExistingEntry(dir, "foo.md")),
      { actual: "foo.md", aliased: false },
    );
    // 两个拼写同时在磁盘上（矛盾状态）：精确名优先，不做歧义折叠
    writeFileSync(join(dir, "Foo.md"), "b", "utf8");
    assert.deepEqual(
      withCaseInsensitiveVolumeForTesting(true, () => resolveExistingEntry(dir, "Foo.md")),
      { actual: "Foo.md", aliased: false },
    );
    // 不存在的父目录/名字：保守返回 null（不抛错、不猜测）
    assert.equal(resolveExistingEntry(join(dir, "nope"), "whatever.md"), null);
    assert.equal(
      withCaseInsensitiveVolumeForTesting(true, () => resolveExistingEntry(dir, "other.md")),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B. 附件入口：不敏感卷（注入）
// ---------------------------------------------------------------------------

test("g-364 附件：不敏感卷别名同内容 → 返回磁盘实际名（不覆盖、不新增条目、不悬空）", () => {
  const root = tmpRoot();
  try {
    withCaseInsensitiveVolumeForTesting(true, () => {
      assert.equal(storeAttachment(root, { name: "report.md", content: "A", actor: "t" }), "report.md");
      // 请求仅大小写不同、内容相同 → 幂等返回**磁盘实际名**（修复前返回请求拼写 "Report.md"）
      assert.equal(storeAttachment(root, { name: "Report.md", content: "A", actor: "t" }), "report.md");
      assert.equal(storeAttachment(root, { name: "REPORT.md", content: "A", actor: "t" }), "report.md");
    });
    assert.deepEqual(attEntries(root), ["report.md"], "别名请求不得新增第二个条目");
    assert.deepEqual(listAttachments(root), ["report.md"]);
    assert.equal(readFileSync(join(attachmentsDir(root), "report.md"), "utf8"), "A");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("g-364 附件：不敏感卷别名异内容 → 唯一名（不覆盖）；重复存储幂等不误报已存在", () => {
  const root = tmpRoot();
  try {
    let unique = "";
    withCaseInsensitiveVolumeForTesting(true, () => {
      storeAttachment(root, { name: "report.md", content: "A", actor: "t" });
      unique = storeAttachment(root, { name: "Report.md", content: "B", actor: "t" });
      // 唯一名以**磁盘实际基名**为基准（保持目录既有拼写约定），且绝不覆盖原文件
      assert.match(unique, /^report-[0-9a-f]{8}\.md$/);
      assert.equal(readFileSync(join(attachmentsDir(root), "report.md"), "utf8"), "A", "原文件不得被覆盖");
      // 同内容再存（含第三种拼写）→ 幂等返回同一实际名；修复前此处会误报「唯一名目标已存在」
      assert.equal(storeAttachment(root, { name: "Report.md", content: "B", actor: "t" }), unique);
      assert.equal(storeAttachment(root, { name: "REPORT.md", content: "B", actor: "t" }), unique);
    });
    assert.deepEqual(attEntries(root), ["report.md", unique].sort());
    assert.equal(listAttachments(root).length, 2, "别名请求不得生成额外副本");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("g-364 附件：不敏感卷目录段别名 → 落到同一真实目录，返回磁盘实际路径", () => {
  const root = tmpRoot();
  try {
    withCaseInsensitiveVolumeForTesting(true, () => {
      assert.equal(storeAttachment(root, { name: "Docs/a.md", content: "1", actor: "t" }), "Docs/a.md");
      // `docs/` 折叠到既有 `Docs/` → 返回磁盘实际路径 `Docs/b.md`（修复前返回 `docs/b.md`，磁盘无此路径）
      assert.equal(storeAttachment(root, { name: "docs/b.md", content: "2", actor: "t" }), "Docs/b.md");
    });
    assert.deepEqual(attEntries(root), ["Docs"], "不得生成第二个大小写不同的目录");
    assert.deepEqual(listAttachments(root), ["Docs/a.md", "Docs/b.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C. 敏感卷正向回归：精确名与异名互不干扰（不误伤）
// ---------------------------------------------------------------------------

test("g-364 敏感卷正向回归：精确名照常幂等；仅大小写不同的新名照常独立成文件", () => {
  const root = tmpRoot();
  try {
    assert.equal(storeAttachment(root, { name: "foo.md", content: "A", actor: "t" }), "foo.md");
    assert.equal(storeAttachment(root, { name: "foo.md", content: "A", actor: "t" }), "foo.md");
    // 敏感卷上 `Foo.md` 是**另一个文件**，不得被判为别名、不得复用 `foo.md`
    assert.equal(storeAttachment(root, { name: "Foo.md", content: "B", actor: "t" }), "Foo.md");
    assert.deepEqual(attEntries(root), ["Foo.md", "foo.md"]);
    assert.equal(readFileSync(join(attachmentsDir(root), "foo.md"), "utf8"), "A");
    assert.equal(readFileSync(join(attachmentsDir(root), "Foo.md"), "utf8"), "B");
    // 子目录同理：`sub/` 与 `Sub/` 是两个目录
    assert.equal(storeAttachment(root, { name: "sub/x.md", content: "1", actor: "t" }), "sub/x.md");
    assert.equal(storeAttachment(root, { name: "Sub/y.md", content: "2", actor: "t" }), "Sub/y.md");
    assert.deepEqual(attEntries(root), ["Foo.md", "Sub", "foo.md", "sub"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D. 删除守卫：引用计数按「同一实体」（不悬空）
// ---------------------------------------------------------------------------

test("g-364 删除守卫：别名拼写的引用仍被计入（不因拼写差异删掉仍被引用的附件）", () => {
  const root = tmpRoot();
  try {
    const gid = createGoal(root, { title: "G", version: "v-t", actor: "t" });
    const cid = addCard(root, gid, { title: "旧别名引用", scope: "goal", actor: "t" });
    withCaseInsensitiveVolumeForTesting(true, () => {
      storeAttachment(root, { name: "report.md", content: "A", actor: "t" });
      // 模拟**历史遗留**的别名引用（修复前的 storeAttachment 正是返回请求拼写）
      fillCard(root, gid, cid, { text: "见 @att/Report.md", by: "human:x", actor: "t" });
      assert.equal(attachmentReferenceCount(root, "report.md"), 1);
      assert.equal(attachmentReferenceCount(root, "REPORT.md"), 1, "任一别名校验都应计入同一实体");
      assert.throws(() => deleteAttachment(root, "report.md", { actor: "t" }), /仍被 1 处引用/);
      assert.throws(() => deleteAttachment(root, "Report.md", { actor: "t" }), /仍被 1 处引用/);
    });
    // 解除引用（删卡）后按别名删除：删的是真实条目，事件记录磁盘实际名
    deleteCard(root, gid, cid, { actor: "t" });
    withCaseInsensitiveVolumeForTesting(true, () => {
      assert.equal(attachmentReferenceCount(root, "REPORT.md"), 0);
      deleteAttachment(root, "Report.md", { actor: "t" });
    });
    assert.equal(existsSync(join(attachmentsDir(root), "report.md")), false);
    const deleted = readEvents(root).filter((e) => e.event === "attachment.deleted");
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].details?.name, "report.md", "账本记磁盘实际名，不记请求拼写");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E. 只读诊断：依赖卷别名的引用被报告，且不自动改名/迁移
// ---------------------------------------------------------------------------

test("g-364 只读诊断：依赖卷别名的引用被报告为可移植性问题（正文/文件零改动）", () => {
  const root = tmpRoot();
  try {
    const gid = createGoal(root, { title: "G", version: "v-t", actor: "t" });
    const cid = addCard(root, gid, { title: "旧别名引用", scope: "goal", actor: "t" });
    withCaseInsensitiveVolumeForTesting(true, () => {
      storeAttachment(root, { name: "report.md", content: "A", actor: "t" });
      fillCard(root, gid, cid, { text: "见 @att/Report.md", by: "human:x", actor: "t" });
      const probs = attachmentProblems(root);
      assert.ok(
        probs.some((p) => p.includes("@att/Report.md") && p.includes("report.md") && p.includes("大小写")),
        `应报告别名依赖：${probs.join(" | ")}`,
      );
    });
    // 只读：卡片正文与附件文件都没被动过（不自动改名、不删数据、不迁移引用）
    assert.match(cardBody(root, gid, cid), /@att\/Report\.md/);
    assert.ok(existsSync(join(attachmentsDir(root), "report.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("g-364 只读诊断：敏感卷上异名引用仍按「引用不存在」报错（不误报成别名）", () => {
  const root = tmpRoot();
  try {
    const gid = createGoal(root, { title: "G", version: "v-t", actor: "t" });
    const cid = addCard(root, gid, { title: "悬空引用", scope: "goal", actor: "t" });
    storeAttachment(root, { name: "report.md", content: "A", actor: "t" });
    fillCard(root, gid, cid, { text: "见 @att/Report.md", by: "human:x", actor: "t" });
    const probs = attachmentProblems(root);
    assert.ok(probs.some((p) => p.includes("附件引用不存在 @att/Report.md")), probs.join(" | "));
    assert.ok(!probs.some((p) => p.includes("依赖卷的大小写别名")), "敏感卷不得报「依赖别名」");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F. 版本泳道写入口：不敏感卷明确拒绝（不静默复用/不误关联）
// ---------------------------------------------------------------------------

test("g-364 版本入口：不敏感卷别名 slug 明确拒绝且零副作用（不静默复用、不误关联）", () => {
  const root = tmpRoot();
  try {
    createVersion(root, { slug: "v-t", actor: "t" });
    const goalsBefore = listGoalFiles(root).length;
    const eventsBefore = readEvents(root).length;
    const standalone = createGoal(root, { title: "S", version: "standalone", actor: "t" });
    const goalsAfterSetup = listGoalFiles(root).length;
    const eventsAfterSetup = readEvents(root).length;
    assert.ok(goalsAfterSetup > goalsBefore && eventsAfterSetup > eventsBefore, "前置目标应正常创建");
    withCaseInsensitiveVolumeForTesting(true, () => {
      assert.equal(caseAliasVersionSlug(root, "V-T"), "v-t");
      assert.throws(() => createVersion(root, { slug: "V-T", actor: "t" }), /仅大小写不同/);
      assert.throws(() => createGoal(root, { title: "X", version: "V-T", actor: "t" }), /仅大小写不同/);
      assert.throws(() => renameVersion(root, { slug: "v-t", newSlug: "V-T", actor: "t" }), /仅大小写不同/);
      assert.throws(
        () => moveGoal(root, standalone, { to: "version", version: "V-T", actor: "t" }),
        /仅大小写不同/,
      );
      // 目标未被移动、meta.version 未被改写
      assert.equal(loadGoal(findGoalFile(root, standalone)).meta.version, null);
    });
    assert.deepEqual(readdirSync(join(root, "versions")).sort(), ["v-t"], "不得新增别名目录");
    assert.equal(listGoalFiles(root).length, goalsAfterSetup, "不得新增目标");
    assert.equal(readEvents(root).length, eventsAfterSetup, "拒绝路径零副作用（不写事件）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("g-364 版本入口：敏感卷正向回归——仅大小写不同的泳道名照常独立创建", () => {
  const root = tmpRoot();
  try {
    createVersion(root, { slug: "v-t", actor: "t" });
    assert.equal(caseAliasVersionSlug(root, "V-T"), null, "敏感卷上不是别名");
    assert.equal(createVersion(root, { slug: "V-T", actor: "t" }).slug, "V-T");
    const gid = createGoal(root, { title: "X", version: "V-T", actor: "t" });
    assert.equal(loadGoal(findGoalFile(root, gid)).meta.version, "V-T");
    assert.deepEqual(readdirSync(join(root, "versions")).sort(), ["V-T", "v-t"]);
    // 位置/归属校验：meta.version 与目录名一致（无「不一致」问题）
    assert.deepEqual(validate(root).filter((p) => /不一致|但 version/.test(p)), []);
    // 精确名重命名仍可用（不误伤）
    const renamed = renameVersion(root, { slug: "v-t", newSlug: "v-u", actor: "t" });
    assert.equal(renamed.new_slug, "v-u");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G. 负向对照：回退到修复前的语义必红
// ---------------------------------------------------------------------------

test("g-364 负向对照：修复前的「按请求拼写 / 按字面相等」在同一注入卷上必红", () => {
  const root = tmpRoot();
  try {
    const gid = createGoal(root, { title: "G", version: "v-t", actor: "t" });
    const cid = addCard(root, gid, { title: "旧别名引用", scope: "goal", actor: "t" });
    withCaseInsensitiveVolumeForTesting(true, () => {
      storeAttachment(root, { name: "report.md", content: "A", actor: "t" });
      const diskActual = listAttachments(root)[0];

      // ① 复刻修复前的路径解析：只按**请求拼写** lstat，不做条目解析
      const preFixResolve = (dir: string, requested: string): string | null =>
        existsSync(join(dir, requested)) ? requested : null;
      assert.equal(preFixResolve(attachmentsDir(root), "Report.md"), null,
        "旧语义在别名卷上看不到既有条目 ⇒ 会把别名请求当成新文件");
      // 现语义：解析到磁盘实际名（同内容时 storeAttachment 即返回它）
      assert.deepEqual(resolveExistingEntry(attachmentsDir(root), "Report.md"), { actual: "report.md", aliased: true });
      assert.equal(storeAttachment(root, { name: "Report.md", content: "A", actor: "t" }), diskActual);

      // ② 复刻修复前的引用计数：按**字面相等**计数，别名拼写被漏计（⇒ 删除会留下悬空引用）
      fillCard(root, gid, cid, { text: "见 @att/Report.md", by: "human:x", actor: "t" });
      const preFixCount = parseAttachmentRefs("见 @att/Report.md").includes("report.md") ? 1 : 0;
      assert.equal(preFixCount, 0, "旧计数漏掉别名引用");
      assert.equal(attachmentReferenceCount(root, "report.md"), 1, "现计数按同一实体计入");
      assert.throws(() => deleteAttachment(root, "report.md", { actor: "t" }), /仍被 1 处引用/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
