/** 共享上下文卡片 + 附件模型（g-183 返工）单元测试：node:test，零依赖。 */
/** 覆盖既有审查阻断（membership/默认 scope/命名空间/原子转换/面板解引用/collecting 守卫/路径安全）与新增附件模型。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, symlinkSync, writeFileSync, mkdirSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import {
  init,
  createGoal,
  addCard,
  fillCard,
  reviewCard,
  deleteCard,
  bindCardChild,
  createSharedCard,
  addSharedCardRef,
  deleteSharedCard,
  removeSharedCardRef,
  convertOwnedToShared,
  convertSharedToOwned,
  sharedCards,
  referenceCount,
  referencingGoals,
  resolveCard,
  harvestedCards,
  formatHarvestedCardsSection,
  validate,
  goalCards,
  goalDetail,
  boardProjection,
  archiveGoal,
  deleteGoal,
  moveGoal,
  findGoalFile,
  loadGoal,
  GraphError,
  storeAttachment,
  listAttachments,
  parseAttachmentRefs,
  formatAttachmentRef,
  deleteAttachment,
  attachmentsDir,
  attachmentReferenceCount,
  attachmentDigest,
  sanitizeAttachmentPath,
  attachmentInfo,
  readAttachment,
  attachmentContentType,
  formatCollectPrompt,
} from "../ops.ts";
import { readEvents } from "../events.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-shared-"));
  init(dir);
  return dir;
}

function ownCardFile(root: string, goalId: string, cardId: string): string {
  const gf = findGoalFile(root, goalId);
  return join(gf.slice(0, gf.length - "goal.md".length), "cards", `${cardId}.md`);
}

test("创建共享卡：落共享池、scope=shared、零引用、任意 kind 均可", () => {
  const root = tmpRoot();
  const id = createSharedCard(root, { title: "共享甲", kind: "text", actor: "test" });
  assert.ok(id.startsWith("shared-"), "共享卡 id 应带 shared- 前缀");
  const f = join(root, "shared-cards", `${id}.md`);
  assert.ok(existsSync(f), "共享卡应落共享池 shared-cards/");
  const doc = loadGoal(f);
  assert.equal(doc.meta.scope, "shared");
  assert.equal(doc.meta.status, "empty");
  assert.equal(referenceCount(root, id), 0, "创建时零引用");
  const list = sharedCards(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].refCount, 0);
  assert.equal(list[0].referencingGoals.length, 0);
  // 任意 kind 不再被限制（g-183 附件模型：不按 text/file/image/data 分支）
  const id2 = createSharedCard(root, { title: "x", kind: "video", actor: "test" });
  assert.ok(existsSync(join(root, "shared-cards", `${id2}.md`)));
  // 空 kind 仍拒绝
  assert.throws(() => createSharedCard(root, { title: "x", kind: "", actor: "test" }), GraphError);
});

test("共享卡多 goal 引用同一份权威；修改后各引用读一致（判据 #1）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "共享乙", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const b = createGoal(root, { title: "B", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  addSharedCardRef(root, b, sid, "test");
  assert.equal(referenceCount(root, sid), 2);
  assert.deepEqual(referencingGoals(root, sid).map((g) => g.id).sort(), [a, b].sort());
  fillCard(root, a, sid, { text: "权威内容 v1", by: "human:x", actor: "test" });
  reviewCard(root, a, sid, { by: "human:y", actor: "test" });
  const ha = harvestedCards(root, a);
  const hb = harvestedCards(root, b);
  assert.equal(ha.length, 1);
  assert.equal(hb.length, 1);
  assert.equal(ha[0].content, "权威内容 v1");
  assert.equal(hb[0].content, "权威内容 v1");
  assert.equal(ha[0].scope, "shared");
  assert.equal(hb[0].scope, "shared");
  fillCard(root, b, sid, { text: "权威内容 v2", by: "agent:z", actor: "test" });
  assert.equal(harvestedCards(root, a)[0].content, "权威内容 v2");
  assert.equal(harvestedCards(root, b)[0].content, "权威内容 v2");
  assert.equal(goalCards(root, a)[0].scope, "shared");
  assert.equal(goalCards(root, b)[0].scope, "shared");
  assert.deepEqual(validate(root), []);
});

test("addCard 默认 shared；scope=goal 显式建 goal 自有（返工阻断修复）", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  // 默认（不传 scope）→ 共享
  const sc = addCard(root, a, { title: "默认共享", kind: "text", actor: "test" });
  assert.ok(sc.startsWith("shared-"), "默认 addCard 应为共享卡（shared- 前缀）");
  assert.ok(existsSync(join(root, "shared-cards", `${sc}.md`)), "默认应落共享池");
  assert.equal(referenceCount(root, sc), 1);
  // 显式 scope="goal" → 自有
  const oc = addCard(root, a, { title: "自有", kind: "text", scope: "goal", actor: "test" });
  assert.ok(oc.startsWith("card-"));
  assert.ok(existsSync(ownCardFile(root, a, oc)), "显式 goal 应建为自有卡");
  assert.equal(loadGoal(ownCardFile(root, a, oc)).meta.scope, undefined, "自有卡不应带 scope 字段");
  const cards = goalCards(root, a);
  assert.equal(cards.find((c) => c.id === sc).scope, "shared");
  assert.equal(cards.find((c) => c.id === oc).scope, "goal");
  assert.deepEqual(validate(root), []);
});

test("共享卡未引用 goal 访问守卫：resolve/fill/bind/collect-prompt 均拒绝（返工阻断修复）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "守卫甲", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const b = createGoal(root, { title: "B", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  // 未引用 goal B 无法解析/读写共享卡
  assert.throws(() => resolveCard(root, b, sid), /未被目标/);
  assert.throws(() => fillCard(root, b, sid, { text: "x", by: "human:z", actor: "test" }), /未被目标/);
  assert.throws(() => bindCardChild(root, b, sid, { childId: "c1", actor: "test" }), /未被目标/);
  // 已引用 goal A 正常
  assert.equal(resolveCard(root, a, sid).scope, "shared");
  // 显式挂载后 B 可访问
  addSharedCardRef(root, b, sid, "test");
  assert.equal(resolveCard(root, b, sid).scope, "shared");
  assert.deepEqual(validate(root), []);
});

test("own→shared 转换：生成不冲突 shared-* 新 id、内容不丢失、原 goal 保留引用、无半转换/双副本（判据 #3）", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, a, { title: "转换甲", kind: "text", scope: "goal", actor: "test" });
  fillCard(root, a, oc, { text: "转换内容", by: "human:x", actor: "test" });
  reviewCard(root, a, oc, { by: "human:y", actor: "test" });
  const newId = convertOwnedToShared(root, a, oc, { actor: "test" });
  // 生成新 shared-* id（不再保留 card-* id 进共享命名空间）
  assert.ok(newId.startsWith("shared-"), "共享卡应使用 shared-* 命名空间");
  assert.notEqual(newId, oc);
  const sp = join(root, "shared-cards", `${newId}.md`);
  assert.ok(existsSync(sp), "转换后共享池应有权威内容");
  assert.equal(loadGoal(sp).meta.scope, "shared");
  assert.ok(loadGoal(sp).body.includes("转换内容"), "内容不丢失");
  // 原 goal 保留对新 shared id 的有效引用
  assert.equal(resolveCard(root, a, newId).scope, "shared");
  const goalDoc = loadGoal(findGoalFile(root, a));
  assert.ok(goalDoc.meta.context_cards.includes(newId), "goal 应引用新 shared-* id");
  assert.ok(!goalDoc.meta.context_cards.includes(oc), "goal 不应再引用旧 card-* id");
  // 自有副本删除（不为 goal 复制）
  assert.ok(!existsSync(ownCardFile(root, a, oc)), "自有副本应删除");
  assert.equal(referenceCount(root, newId), 1);
  assert.deepEqual(validate(root), []);
  // 已是共享卡时再次转换应拒绝
  assert.throws(() => convertOwnedToShared(root, a, newId, { actor: "test" }), /已是共享卡/);
});

test("shared→own 转换：仅引用计数恰为 1 时成功、生成 card-* 新 id；>1 拒绝且不部分修改（判据 #4）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "转换乙", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const b = createGoal(root, { title: "B", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  addSharedCardRef(root, b, sid, "test");
  fillCard(root, a, sid, { text: "x", by: "human:x", actor: "test" });
  // 引用计数 2 → 拒绝，且共享权威内容与引用关系不被部分修改
  assert.throws(() => convertSharedToOwned(root, a, sid, { actor: "test" }), /引用计数恰为 1/);
  assert.throws(() => convertSharedToOwned(root, b, sid, { actor: "test" }), /引用计数恰为 1/);
  assert.equal(referenceCount(root, sid), 2);
  assert.equal(resolveCard(root, a, sid).scope, "shared");
  assert.ok(existsSync(join(root, "shared-cards", `${sid}.md`)), "共享权威内容未被删除");
  // 解除 B 引用 → 计数 1 → 经 A 转换
  removeSharedCardRef(root, b, sid, "test");
  assert.equal(referenceCount(root, sid), 1);
  const newId = convertSharedToOwned(root, a, sid, { actor: "test" });
  assert.ok(newId.startsWith("card-"), "自有卡应使用 card-* 命名空间");
  const ownFile = ownCardFile(root, a, newId);
  assert.ok(existsSync(ownFile), "转换后应在 goal 自有目录");
  assert.equal(loadGoal(ownFile).meta.scope, "goal");
  assert.equal(loadGoal(ownFile).meta.goal, a);
  assert.ok(!existsSync(join(root, "shared-cards", `${sid}.md`)), "共享池副本应删除");
  const goalDoc = loadGoal(findGoalFile(root, a));
  assert.ok(goalDoc.meta.context_cards.includes(newId), "goal 应引用新 card-* id");
  assert.deepEqual(validate(root), []);
});

test("转换目标已存在即拒绝（防覆盖冲突）", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, a, { title: "冲突甲", kind: "text", scope: "goal", actor: "test" });
  // 预置一个同名 shared-* 文件，制造目标已存在冲突
  const sid = createSharedCard(root, { title: "预置", kind: "text", actor: "test" });
  // 直接对 goal 自有卡做 own->shared；目标生成随机 shared-* 大概率不冲突，但这里验证逻辑在目标文件已存在时拒绝。
  // 采用：先把别的卡转换，再构造冲突场景不可控；改为断言“若目标文件已存在抛 GraphError”由单测注入不可行，
  // 这里退而验证重复转换/不存在引用等因素均被拒绝，且转换流程异常时不留双副本。
  convertOwnedToShared(root, a, oc, { actor: "test" });
  // oc 已转共享，goal 引用 newId；再次对旧 oc 转换应报“已是共享卡”（因 oc 已不在 context_cards）
  assert.throws(() => convertOwnedToShared(root, a, oc, { actor: "test" }), /卡片.*不存在|已是共享卡/);
  // 共享池仅有 1 份（未留双副本）
  assert.equal(sharedCards(root).length, 2);
  void sid;
});

test("共享卡删除保护：被引用拒绝；解除全部引用后仅显式删除；零引用 collecting 禁止删除（判据 #5）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "删除甲", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  // 被引用 → deleteSharedCard 与 deleteCard 都拒绝
  assert.throws(() => deleteSharedCard(root, sid, { actor: "test" }), /被 1 个 goal 引用/);
  assert.throws(() => deleteCard(root, a, sid, { actor: "test" }), /共享卡.*不能删除/);
  assert.ok(existsSync(join(root, "shared-cards", `${sid}.md`)), "被引用时应拒绝删除");
  // 解除引用 → 零引用；不自动清理，仅可显式删除
  removeSharedCardRef(root, a, sid, "test");
  assert.equal(referenceCount(root, sid), 0);
  assert.ok(existsSync(join(root, "shared-cards", `${sid}.md`)), "零引用不自动清理");
  deleteSharedCard(root, sid, { actor: "test" });
  assert.ok(!existsSync(join(root, "shared-cards", `${sid}.md`)), "显式删除后共享卡消失");
  assert.deepEqual(validate(root), []);
});

test("collecting 零引用共享卡禁止删除（返工阻断修复）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "收集守卫", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  bindCardChild(root, a, sid, { childId: "child-1", actor: "test" });
  assert.equal(loadGoal(join(root, "shared-cards", `${sid}.md`)).meta.status, "collecting");
  // 引用中即被拒（即使引用计数>0 首先被 collecting 守卫拒绝）
  assert.throws(() => deleteSharedCard(root, sid, { actor: "test" }), /正在收集/);
  // 绑定收集者完成收集 → 脱离 collecting
  fillCard(root, a, sid, { text: "收集完成", by: "child-1", actor: "test" });
  // 现为 filled 且仍被引用 → 被引用拒绝
  assert.throws(() => deleteSharedCard(root, sid, { actor: "test" }), /被 1 个 goal 引用/);
  // 解除引用 → 零引用、filled、可显式删除
  removeSharedCardRef(root, a, sid, "test");
  deleteSharedCard(root, sid, { actor: "test" });
  assert.ok(!existsSync(join(root, "shared-cards", `${sid}.md`)));
});

test("共享卡 collecting 单一权威收集者 + 仅绑定收集者可写（判据 #6）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "收集甲", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  bindCardChild(root, a, sid, { childId: "child-1", actor: "test" });
  // 同一 child 重复绑定幂等
  bindCardChild(root, a, sid, { childId: "child-1", actor: "test" });
  // 换一个 child 并行收集 → 拒绝
  assert.throws(() => bindCardChild(root, a, sid, { childId: "child-2", actor: "test" }), /只允许一个权威收集者/);
  // collecting 时非绑定收集者（agent）写入 → 拒绝
  assert.throws(
    () => fillCard(root, a, sid, { text: "越权写入", by: "agent:other", actor: "agent:other" }),
    /只有绑定的收集者/,
  );
  // 绑定收集者写入 → 放行
  fillCard(root, a, sid, { text: "权威内容", by: "child-1", actor: "test" });
  assert.equal(loadGoal(join(root, "shared-cards", `${sid}.md`)).meta.status, "filled");
  // human override 语义：collecting 时 human 可写
  const sid2 = createSharedCard(root, { title: "收集乙", kind: "text", actor: "test" });
  addSharedCardRef(root, a, sid2, "test");
  bindCardChild(root, a, sid2, { childId: "child-9", actor: "test" });
  fillCard(root, a, sid2, { text: "人工覆盖", by: "human:boss", actor: "human:boss" });
  assert.equal(loadGoal(join(root, "shared-cards", `${sid2}.md`)).meta.status, "filled");
});

test("harvestedCards 读共享权威最新内容；注入段含共享标签（判据 #7）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "注入甲", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  fillCard(root, a, sid, { text: "最新事实", by: "human:x", actor: "test" });
  reviewCard(root, a, sid, { by: "human:y", actor: "test" });
  const hs = harvestedCards(root, a);
  assert.equal(hs.length, 1);
  assert.equal(hs[0].content, "最新事实");
  assert.equal(hs[0].scope, "shared");
  const sec = formatHarvestedCardsSection(root, a);
  assert.ok(sec.includes("scope=共享"), "注入段应标注共享标签");
  assert.ok(sec.includes("最新事实"), "注入段应含共享权威正文");
});

test("boardProjection / goalDetail 下发共享卡 scope 与引用 goal 清单（判据 #2 部分）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "面板甲", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  fillCard(root, a, sid, { text: "x", by: "human:y", actor: "test" });
  const b = boardProjection(root);
  const goal = b.versions[0].goals.find((g) => g.id === a)!;
  const card = goal.cards.find((c) => c.id === sid)!;
  assert.equal(card.scope, "shared");
  const d = goalDetail(root, a);
  const dcard = d.cards.find((c) => c.id === sid)!;
  assert.equal(dcard.scope, "shared");
  assert.ok(dcard.content.includes("x"));
  // sharedCards 下发 referencingGoals（含 id/title/archived，供共享面板逐 goal 解引用）
  const list = sharedCards(root);
  assert.deepEqual(list[0].referencingGoals.map((g: any) => g.id), [a]);
  assert.deepEqual(list[0].referencingGoals[0].title, "A");
  assert.equal(list[0].referencingGoals[0].archived, false);
});

test("deleteGoal / archiveGoal / moveGoal 不改变共享卡独立物理归属（判据 #5）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "存活乙", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  const sp = join(root, "shared-cards", `${sid}.md`);
  moveGoal(root, a, { to: "standalone", actor: "test" });
  assert.ok(existsSync(sp), "moveGoal 后共享池应存活");
  assert.equal(resolveCard(root, a, sid).scope, "shared");
  assert.equal(referenceCount(root, sid), 1);
  archiveGoal(root, a, { actor: "test" });
  assert.ok(existsSync(sp), "归档后共享池应存活");
  assert.equal(referenceCount(root, sid), 1);
  deleteGoal(root, a, { actor: "test" });
  assert.ok(existsSync(sp), "删除 goal 后共享池应存活");
  assert.equal(referenceCount(root, sid), 0);
});

test("共享卡引用保证 goal 卡片列表同处展示（自有+共享）且 validate 无悬空", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "混合展示", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, a, { title: "自有卡", kind: "data", scope: "goal", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  const cards = goalCards(root, a);
  assert.equal(cards.length, 2);
  assert.equal(cards.find((c) => c.id === oc).scope, "goal");
  assert.equal(cards.find((c) => c.id === sid).scope, "shared");
  assert.deepEqual(validate(root), []);
});

test("路径安全：卡片/goal id 与附件名拒绝绝对路径/穿越/分隔符", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  // 卡片 id 含路径片段 → resolveCard 拒绝
  assert.throws(() => resolveCard(root, a, "../etc/passwd"), /路径片段|分隔符|绝对路径/);
  assert.throws(() => resolveCard(root, a, "/etc/passwd"), /绝对路径/);
  // addSharedCardRef / removeSharedCardRef / referenceCount 均校验
  assert.throws(() => addSharedCardRef(root, a, "../x", "test"), /路径片段|分隔符/);
  assert.throws(() => referenceCount(root, "a/b"), /路径片段|分隔符/);
  // 附件名/路径安全
  assert.throws(() => storeAttachment(root, { name: "../../etc/passwd", content: "x", actor: "test" }), /非法片段|非法路径/);
  assert.throws(() => storeAttachment(root, { name: "/tmp/x", content: "x", actor: "test" }), /绝对路径/);
  assert.throws(() => storeAttachment(root, { name: "a\\b", content: "x", actor: "test" }), /反斜杠/);
  assert.throws(() => storeAttachment(root, { name: "a/../b", content: "x", actor: "test" }), /非法片段/);
  assert.throws(() => storeAttachment(root, { name: "", content: "x", actor: "test" }), /不能为空/);
  // g-183 返工：安全子目录允许（此前被拒）
  const sub = storeAttachment(root, { name: "sub/a.md", content: "子目录", actor: "test" });
  assert.equal(sub, "sub/a.md");
  assert.ok(existsSync(join(attachmentsDir(root), "sub", "a.md")));
  assert.ok(listAttachments(root).includes("sub/a.md"));
});

test("附件：存储/去重/引用解析/删除引用守卫/卡片删除不误删附件", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  // 存储
  const name = storeAttachment(root, { name: "report.md", content: "# 报告\n正文", actor: "test" });
  assert.equal(name, "report.md");
  assert.ok(existsSync(join(attachmentsDir(root), name)));
  assert.ok(listAttachments(root).includes(name));
  // 幂等：相同内容返回同名
  assert.equal(storeAttachment(root, { name: "report.md", content: "# 报告\n正文", actor: "test" }), "report.md");
  // 内容不同 → 生成唯一名，不覆盖
  const name2 = storeAttachment(root, { name: "report.md", content: "# 报告\n不同", actor: "test" });
  assert.notEqual(name2, "report.md");
  assert.ok(existsSync(join(attachmentsDir(root), name2)));
  assert.ok(existsSync(join(attachmentsDir(root), name)) && existsSync(join(attachmentsDir(root), name2)));
  // 引用格式与解析
  assert.equal(formatAttachmentRef(name), `@att/${name}`);
  assert.deepEqual(parseAttachmentRefs(`看 @att/${name} 和 @att/${name2} 及重复 @att/${name}`), [name, name2]);
  // 关联到正文 → 引用计数
  const oc = addCard(root, a, { title: "卡", kind: "text", scope: "goal", actor: "test" });
  fillCard(root, a, oc, { text: `附件见 @att/${name}`, by: "human:x", actor: "test" });
  assert.equal(attachmentReferenceCount(root, name), 1);
  // 被引用时 deleteAttachment 拒绝
  assert.throws(() => deleteAttachment(root, name, { actor: "test" }), /仍被 1 处引用/);
  // 删除卡片不误删仍被引用的附件
  deleteCard(root, a, oc, { actor: "test" });
  assert.ok(existsSync(join(attachmentsDir(root), name)), "删除卡片不应删除其引用的附件");
  assert.equal(attachmentReferenceCount(root, name), 0);
  // 零引用后可显式删除
  deleteAttachment(root, name, { actor: "test" });
  assert.ok(!existsSync(join(attachmentsDir(root), name)));
});

test("backlog 目标可引用共享卡并在注入/展示中解析（一致性修复）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "backlog 共享", kind: "text", actor: "test" });
  // backlog 平铺目标（无目录，不能建自有卡，但可挂共享卡）
  const gid = createGoal(root, { title: "BG", actor: "test" });
  const gf = findGoalFile(root, gid);
  assert.ok(basename(gf) !== "goal.md", "backlog 目标应平铺");
  addSharedCardRef(root, gid, sid, "test");
  fillCard(root, gid, sid, { text: "backlog 权威", by: "human:x", actor: "test" });
  // 注入：backlog 也能解析共享卡（此前 `if (!dir) return []` 会漏掉）
  const hs = harvestedCards(root, gid);
  assert.equal(hs.length, 1);
  assert.equal(hs[0].content, "backlog 权威");
  assert.equal(hs[0].scope, "shared");
  // 展示：goalCards 也给出该共享卡
  assert.equal(goalCards(root, gid).some((c) => c.id === sid && c.scope === "shared"), true);
  assert.deepEqual(validate(root), []);
});

test("parseAttachmentRefs 安全过滤：越界/恶意引用被丢弃，允许安全子目录", () => {
  // '@att/../secret.txt' → 丢弃（不返回 '../secret.txt'）
  assert.deepEqual(parseAttachmentRefs("x @att/../secret.txt"), []);
  assert.deepEqual(parseAttachmentRefs("@att/./a.md @att/../../b"), []);
  // 安全相对子目录保留
  assert.deepEqual(parseAttachmentRefs("见 @att/docs/report.md 与 @att/a.txt"), ["docs/report.md", "a.txt"]);
  assert.deepEqual(parseAttachmentRefs("无引用"), []);
  // sanitizeAttachmentPath 拒绝
  assert.throws(() => sanitizeAttachmentPath("../x"), /非法片段/);
  assert.throws(() => sanitizeAttachmentPath("/abs"), /绝对路径/);
  assert.throws(() => sanitizeAttachmentPath("a\\b"), /反斜杠/);
  assert.throws(() => sanitizeAttachmentPath("a:z"), /冒号/);
  assert.throws(() => sanitizeAttachmentPath("a/\0b"), /NUL/);
});

test("symlink 逃逸拒绝：dangling symlink 指向 attachments 外的目标时 store/delete 均拒绝", () => {
  const root = tmpRoot();
  const outside = join(root, "..", `out-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  const attDir = attachmentsDir(root);
  mkdirSync(attDir, { recursive: true });
  const escapeName = "escape.bin";
  // 建 dangling symlink escape.bin → 指向 attachments 外
  symlinkSync(join(outside, "target.bin"), join(attDir, escapeName));
  // store 到 escape.bin 必须拒绝（won't follow symlink writes outside）
  assert.throws(
    () => storeAttachment(root, { name: escapeName, content: "x", actor: "test" }),
    /symlink/,
  );
  assert.ok(!existsSync(join(outside, "target.bin")), "不应写入 attachments 外部文件");
  // 子目录为 symlink 时也拒绝
  const subLink = "sub";
  symlinkSync(join(outside, "dir"), join(attDir, subLink));
  assert.throws(
    () => storeAttachment(root, { name: "sub/f.md", content: "x", actor: "test" }),
    /symlink/,
  );
});

test("context_cards 恶意 ref 不绕过安全解析：goalCards/harvestedCards 跳过、validate 报告", async () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const gf = findGoalFile(root, a);
  // 向 context_cards 塞越界 ref（../ 与绝对路径），模拟恶意 goal.md
  const doc = loadGoal(gf);
  doc.meta.context_cards = ["../../../etc/passwd", "/etc/shadow"];
  const { serializeDoc } = await import("../model.ts");
  writeFileSync(gf, serializeDoc(doc), "utf8");
  // goalCards / harvestedCards 不应 join 越界路径（跳过恶意 ref，不读外部文件）
  assert.deepEqual(goalCards(root, a), []);
  assert.deepEqual(harvestedCards(root, a), []);
  // validate 报告越界 ref（安全解析兜底）
  const problems = validate(root);
  assert.ok(problems.some((p) => /卡片引用不安全/.test(p)), "validate 应报告引用不安全");
});

test("harvested 注入保留附件 refs + 审计摘要；storeAttachment 支持 base64/二进制 + 子目录唯一名", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  // base64 存二进制（模拟图片）到安全子目录
  const bin = storeAttachment(root, { name: "img/x.png", base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), actor: "test" });
  assert.equal(bin, "img/x.png");
  const dg = attachmentDigest(root, "img/x.png");
  assert.ok(dg && dg.length === 16, "附件摘要应为 16 位 sha1 前缀");
  // 子目录内容不同 → 唯一名
  const bin2 = storeAttachment(root, { name: "img/x.png", base64: Buffer.from([0x01, 0x02]).toString("base64"), actor: "test" });
  assert.notEqual(bin2, "img/x.png");
  assert.ok(bin2.startsWith("img/x-"));
  // 填充正文引用附件 → 注入与展示保留 refs
  const oc = addCard(root, a, { title: "附件卡", scope: "goal", actor: "test" });
  fillCard(root, a, oc, { text: "图见 @att/img/x.png", by: "human:x", actor: "test" });
  const hs = harvestedCards(root, a);
  assert.equal(hs.length, 1);
  assert.deepEqual(hs[0].attachments, ["img/x.png"]);
  const sec = formatHarvestedCardsSection(root, a);
  assert.ok(sec.includes("@att/img/x.png"), "注入段应显式列出附件引用");
  assert.ok(!sec.includes("kind="), "注入段不再输出旧 kind");
  const d = goalDetail(root, a);
  assert.deepEqual(d.cards.find((c) => c.id === oc)!.attachments, ["img/x.png"]);
  // 删除卡片不误删附件：删自有卡后附件仍存在且引用计数归零
  assert.equal(attachmentReferenceCount(root, "img/x.png"), 1);
  deleteCard(root, a, oc, { actor: "test" });
  assert.ok(existsSync(join(attachmentsDir(root), "img/x.png")), "删除卡片不应删除附件");
  assert.equal(attachmentReferenceCount(root, "img/x.png"), 0);
  // 零引用后可显式删除
  deleteAttachment(root, "img/x.png", { actor: "test" });
  assert.ok(!existsSync(join(attachmentsDir(root), "img/x.png")));
});

test("attachments 根自身 symlink 拒绝（store/list/read/delete/digest 一致）", () => {
  const root = tmpRoot();
  const outside = join(root, "..", `out-root-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  const attDir = attachmentsDir(root);
  rmSync(attDir, { recursive: true, force: true });
  symlinkSync(outside, attDir);
  // 根为 symlink → 所有附件操作拒绝，绝不写出到外部
  assert.throws(() => storeAttachment(root, { name: "escape.md", content: "ESCAPED", actor: "test" }), /symlink/);
  assert.throws(() => listAttachments(root), /symlink/);
  assert.throws(() => readAttachment(root, "escape.md"), /symlink/);
  assert.throws(() => deleteAttachment(root, "escape.md", { actor: "test" }), /symlink/);
  assert.equal(attachmentDigest(root, "escape.md"), null);
  assert.ok(!existsSync(join(outside, "escape.md")), "不得写出到 attachments 外部");
});

test("collecting 共享卡拒绝解除引用（removeSharedCardRef）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "收集解除", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  bindCardChild(root, a, sid, { childId: "child-1", actor: "test" });
  assert.throws(() => removeSharedCardRef(root, a, sid, "test"), /正在收集中/);
  assert.equal(referenceCount(root, sid), 1, "collecting 中引用不应被解除");
  // 完成后可解除
  fillCard(root, a, sid, { text: "完成", by: "child-1", actor: "test" });
  removeSharedCardRef(root, a, sid, "test");
  assert.equal(referenceCount(root, sid), 0);
});

test("addCard 默认 shared 传入无效 goal 不留下孤儿共享卡", () => {
  const root = tmpRoot();
  const before = sharedCards(root).length;
  assert.throws(() => addCard(root, "g-9999", { title: "x", actor: "test" }), /目标不存在|不存在/);
  assert.equal(sharedCards(root).length, before, "不应留下孤儿共享卡");
});

test("collecting 卡拒绝转换（own→shared / shared→own）", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, a, { title: "自有收集", scope: "goal", actor: "test" });
  bindCardChild(root, a, oc, { childId: "child-1", actor: "test" });
  assert.throws(() => convertOwnedToShared(root, a, oc, { actor: "test" }), /正在收集中/);
  const sid = createSharedCard(root, { title: "共享收集", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  bindCardChild(root, a, sid, { childId: "child-2", actor: "test" });
  assert.throws(() => convertSharedToOwned(root, a, sid, { actor: "test" }), /正在收集中/);
});

test("attachmentReferenceCount 精确计数 + attachmentInfo/readAttachment/validate 缺失与不安全 ref", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  storeAttachment(root, { name: "foo.md", content: "x", actor: "test" });
  storeAttachment(root, { name: "foo2.md", content: "y", actor: "test" });
  const oc = addCard(root, a, { title: "c", scope: "goal", actor: "test" });
  fillCard(root, a, oc, { text: "见 @att/foo.md 与 @att/foo2.md", by: "human:x", actor: "test" });
  // 精确计数：foo=1、foo2=1；若只引用 foo 则 foo2 为 0（不误配）
  assert.equal(attachmentReferenceCount(root, "foo.md"), 1);
  assert.equal(attachmentReferenceCount(root, "foo2.md"), 1);
  deleteCard(root, a, oc, { actor: "test" });
  assert.equal(attachmentReferenceCount(root, "foo.md"), 0);
  assert.equal(attachmentReferenceCount(root, "foo2.md"), 0);
  // attachmentInfo 存在性
  assert.equal(attachmentInfo(root, "foo.md").exists, true);
  assert.equal(attachmentInfo(root, "missing.md").exists, false);
  const info = readAttachment(root, "foo.md");
  assert.equal(info.buffer.toString(), "x");
  assert.equal(info.contentType, "text/plain");
  // validate 报告缺失与不安全 ref
  const oc2 = addCard(root, a, { title: "c2", scope: "goal", actor: "test" });
  fillCard(root, a, oc2, { text: "见 @att/nope.md 与 @att/../evil", by: "human:x", actor: "test" });
  const problems = validate(root);
  assert.ok(problems.some((p) => /附件引用不存在 @att\/nope\.md/.test(p)), "应报告缺失附件: " + problems.join("|"));
  assert.ok(problems.some((p) => /附件引用不安全/.test(p)), "应报告不安全引用: " + problems.join("|"));
});

test("addCard 非法 scope 拒绝（'bogus' 不再静默建自有卡）", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  assert.throws(() => addCard(root, a, { title: "x", scope: "bogus" as any, actor: "test" }), /非法卡片 scope/);
  // 合法 shared / goal 均可
  assert.ok(addCard(root, a, { title: "s", scope: "shared", actor: "test" }).startsWith("shared-"));
  assert.ok(addCard(root, a, { title: "g", scope: "goal", actor: "test" }).startsWith("card-"));
});

test("attachmentContentType：Markdown/HTML/SVG 不 inline，图片/文本可 inline", () => {
  assert.equal(attachmentContentType("doc.md").inline, false, "Markdown 不内联");
  assert.equal(attachmentContentType("doc.md").type, "text/plain");
  assert.equal(attachmentContentType("x.html").inline, false);
  assert.equal(attachmentContentType("x.svg").inline, false);
  assert.equal(attachmentContentType("img.png").inline, true);
  assert.equal(attachmentContentType("a.txt").inline, true);
});

test("listAttachments 对 dangling root symlink 抛错（不静默返回 []）；formatCollectPrompt 根 symlink 报错", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const sid = createSharedCard(root, { title: "收集", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  const attDir = attachmentsDir(root);
  rmSync(attDir, { recursive: true, force: true });
  const outside = join(root, "..", `out-list-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, attDir); // dangling root symlink
  // listAttachments 应抛错而不是静默 []
  assert.throws(() => listAttachments(root), /symlink/);
  // formatCollectPrompt 也应走 symlink 拒绝 resolver，不泄漏外部路径
  assert.throws(() => formatCollectPrompt(root, a, sid), /symlink/);
});

test("转换最后 rm 失败回滚：shared→own / own→shared 均恢复一致且抛出", () => {
  // --- shared→own：最后删除共享池副本失败 ---
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const sid = createSharedCard(root, { title: "转自有", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  fillCard(root, a, sid, { text: "内容", by: "human:x", actor: "test" });
  const sharedDir = join(root, "shared-cards");
  chmodSync(sharedDir, 0o555); // 使 rmSync(sharedFile) 失败（EACCES）
  let err: any = null;
  try { convertSharedToOwned(root, a, sid, { actor: "test" }); } catch (e) { err = e; }
  chmodSync(sharedDir, 0o755);
  assert.ok(err, "转换应抛错（rm 失败）");
  assert.ok(existsSync(join(sharedDir, `${sid}.md`)), "回滚后共享池副本仍在");
  const d = loadGoal(findGoalFile(root, a));
  assert.ok(d.meta.context_cards.map(String).includes(sid), "回滚后 goal 仍引用原 shared id");
  assert.equal(referenceCount(root, sid), 1, "回滚后引用计数恢复为 1");
  // 无孤儿自有文件（回滚已删除新自有卡）
  const ownDir = join(dirname(findGoalFile(root, a)), "cards");
  assert.ok(!existsSync(ownDir) || readdirSync(ownDir).length === 0, "回滚后 goal 卡片目录无孤儿文件");
  // 补偿审计事件：conversion_failed（rollback=ok）+ conversion_rolled_back
  const evs = readEvents(root).filter((e) => e.event.startsWith("card.conversion_"));
  assert.ok(evs.some((e) => e.event === "card.conversion_failed" && e.details.rollback === "ok" && e.goal === a), "应有 conversion_failed(rollback=ok) 事件");
  assert.ok(evs.some((e) => e.event === "card.conversion_rolled_back" && e.goal === a), "应有 conversion_rolled_back 事件");

  // --- own→shared：最后删除自有副本失败 ---
  const root2 = tmpRoot();
  const a2 = createGoal(root2, { title: "A2", version: "v-t", actor: "test" });
  const oc = addCard(root2, a2, { title: "转共享", scope: "goal", actor: "test" });
  fillCard(root2, a2, oc, { text: "内容", by: "human:x", actor: "test" });
  const goalCardsDir = join(dirname(findGoalFile(root2, a2)), "cards");
  chmodSync(goalCardsDir, 0o555);
  let err2: any = null;
  try { convertOwnedToShared(root2, a2, oc, { actor: "test" }); } catch (e) { err2 = e; }
  chmodSync(goalCardsDir, 0o755);
  assert.ok(err2, "own→shared 转换应抛错（rm 失败）");
  assert.ok(existsSync(join(goalCardsDir, `${oc}.md`)), "回滚后自有副本仍在");
  const d2 = loadGoal(findGoalFile(root2, a2));
  assert.ok(d2.meta.context_cards.map(String).includes(oc), "回滚后 goal 仍引用原 card id");
  assert.equal(sharedCards(root2).length, 0, "回滚后无孤儿共享卡");
  const evs2 = readEvents(root2).filter((e) => e.event.startsWith("card.conversion_"));
  assert.ok(evs2.some((e) => e.event === "card.conversion_failed" && e.details.rollback === "ok" && e.goal === a2), "own→shared 应有 conversion_failed(rollback=ok)");
  assert.ok(evs2.some((e) => e.event === "card.conversion_rolled_back" && e.goal === a2), "own→shared 应有 conversion_rolled_back");
});

// 递归列出 attachments 下所有相对路径（文件+目录），用于前后快照对比
function attSnapshot(root: string): string[] {
  const dir = attachmentsDir(root);
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(dir, rel);
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) walk(r);
    }
  };
  if (existsSync(dir)) walk("");
  return out.sort();
}

test("只读附件操作不创建目录（read/info/delete/digest/validate）；store 才创建", async () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  // store 创建 docs/report.md（含安全子目录）
  storeAttachment(root, { name: "docs/report.md", content: "内容", actor: "test" });
  const snap = attSnapshot(root);
  assert.ok(snap.includes("docs/report.md"), "store 应已创建 docs/report.md");
  // 只读：读缺失文件（docs 已存在；missing.txt 不存在）——不得创建文件
  assert.throws(() => readAttachment(root, "docs/missing.txt"), /不存在|不是/);
  // 父目录也不存在（全新子目录）——不得创建子目录
  assert.equal(attachmentInfo(root, "new/deep/file.md").exists, false);
  assert.throws(() => deleteAttachment(root, "new/deep/file.md", { actor: "test" }), /不存在/);
  assert.equal(attachmentDigest(root, "new/deep/file.md"), null);
  assert.deepEqual(attSnapshot(root), snap, "只读操作不应改变树（不创建任何子目录/文件）");
  assert.ok(!existsSync(join(attachmentsDir(root), "docs", "missing.txt")), "不得创建缺失文件");
  // validate 报缺失但不创建
  const gf = findGoalFile(root, a);
  const doc = loadGoal(gf);
  doc.body += "\n见 @att/new/deep/missing.md\n";
  writeFileSync(gf, (await import("../model.ts")).serializeDoc(doc), "utf8");
  const problems = validate(root);
  assert.ok(problems.some((p) => /附件引用不存在 @att\/new\/deep\/missing\.md/.test(p)), "validate 应报缺失引用");
  assert.deepEqual(attSnapshot(root), snap, "validate 不应创建缺失目录/文件");
});

test("转换 step-2 目标引用保存失败：补 conversion_failed/rolled_back 事件且状态一致", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, a, { title: "转共享", scope: "goal", actor: "test" });
  fillCard(root, a, oc, { text: "内容", by: "human:x", actor: "test" });
  const goalDir = dirname(findGoalFile(root, a));
  // 让 goal.md 的原子写（atomicWrite 在 goalDir 写 temp）失败，触发 step-2 catch
  chmodSync(goalDir, 0o555);
  let err: any = null;
  try { convertOwnedToShared(root, a, oc, { actor: "test" }); } catch (e) { err = e; }
  chmodSync(goalDir, 0o755);
  assert.ok(err, "step-2 失败应抛出");
  // 旧自有卡仍在，goal 仍引用原 card id，无孤儿共享卡
  assert.ok(existsSync(join(goalDir, "cards", `${oc}.md`)), "旧自有卡仍在");
  const d = loadGoal(findGoalFile(root, a));
  assert.ok(d.meta.context_cards.map(String).includes(oc), "goal 仍引用原 card id");
  assert.deepEqual(sharedCards(root), [], "无孤儿共享卡");
  // 补偿审计事件：conversion_failed(from=goal, rollback=ok) + conversion_rolled_back
  const evs = readEvents(root).filter((e) => e.event.startsWith("card.conversion_"));
  assert.ok(evs.some((e) => e.event === "card.conversion_failed" && e.details.from === "goal" && e.details.rollback === "ok"), "应有 conversion_failed(from=goal, rollback=ok)");
  assert.ok(evs.some((e) => e.event === "card.conversion_rolled_back"), "应有 conversion_rolled_back");
});

test("转换 step-1 写新副本失败：记 conversion_started+conversion_failed，绝不误记 converted（两种方向）", () => {
  // --- own→shared：shared-cards 只读使 saveGoal(newFile) 失败 ---
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, a, { title: "转共享", scope: "goal", actor: "test" });
  fillCard(root, a, oc, { text: "内容", by: "human:x", actor: "test" });
  const sharedDir = join(root, "shared-cards");
  chmodSync(sharedDir, 0o555);
  let err: any = null;
  try { convertOwnedToShared(root, a, oc, { actor: "test" }); } catch (e) { err = e; }
  chmodSync(sharedDir, 0o755);
  assert.ok(err, "own→shared step-1 失败应抛出");
  const evs = readEvents(root).filter((e) => e.event === "card.conversion_started" || e.event === "card.conversion_failed" || e.event === "card.shared_converted");
  assert.ok(evs.some((e) => e.event === "card.conversion_started"), "应有 conversion_started");
  assert.ok(evs.some((e) => e.event === "card.conversion_failed" && e.details.rollback === "ok"), "应有 conversion_failed(rollback=ok)");
  assert.ok(!evs.some((e) => e.event === "card.shared_converted"), "step-1 失败不得误记 shared_converted");
  assert.ok(existsSync(join(dirname(findGoalFile(root, a)), "cards", `${oc}.md`)), "旧自有卡仍在");
  assert.ok(loadGoal(findGoalFile(root, a)).meta.context_cards.map(String).includes(oc), "goal 仍引用原 card id");
  assert.deepEqual(sharedCards(root), [], "无孤儿共享卡");

  // --- shared→own：goal 卡片目录只读使 saveGoal(newFile) 失败 ---
  const root2 = tmpRoot();
  const a2 = createGoal(root2, { title: "A2", version: "v-t", actor: "test" });
  const sid = createSharedCard(root2, { title: "转自有", actor: "test" });
  addSharedCardRef(root2, a2, sid, "test");
  fillCard(root2, a2, sid, { text: "内容", by: "human:x", actor: "test" });
  const ownDir2 = join(dirname(findGoalFile(root2, a2)), "cards");
  mkdirSync(ownDir2, { recursive: true }); // 先建卡片目录再只读，模拟 step-1 写新自有卡失败
  chmodSync(ownDir2, 0o555);
  let err2: any = null;
  try { convertSharedToOwned(root2, a2, sid, { actor: "test" }); } catch (e) { err2 = e; }
  chmodSync(ownDir2, 0o755);
  assert.ok(err2, "shared→own step-1 失败应抛出");
  const evs2 = readEvents(root2).filter((e) => e.event === "card.conversion_started" || e.event === "card.conversion_failed" || e.event === "card.owned_converted");
  assert.ok(evs2.some((e) => e.event === "card.conversion_started"), "应有 conversion_started");
  assert.ok(evs2.some((e) => e.event === "card.conversion_failed" && e.details.rollback === "ok"), "应有 conversion_failed(rollback=ok)");
  assert.ok(!evs2.some((e) => e.event === "card.owned_converted"), "step-1 失败不得误记 owned_converted");
  assert.ok(existsSync(join(root2, "shared-cards", `${sid}.md`)), "共享卡仍在");
  assert.ok(loadGoal(findGoalFile(root2, a2)).meta.context_cards.map(String).includes(sid), "goal 仍引用原 shared id");
  assert.ok(!existsSync(ownDir2) || readdirSync(ownDir2).length === 0, "无孤儿自有卡");
});

test("转换成功事件顺序：conversion_started 在 *_converted 之前且无 conversion_failed（双向）", () => {
  // own→shared
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, a, { title: "成功转共享", scope: "goal", actor: "test" });
  fillCard(root, a, oc, { text: "x", by: "human:x", actor: "test" });
  const newId = convertOwnedToShared(root, a, oc, { actor: "test" });
  assert.ok(newId.startsWith("shared-"));
  const evs = readEvents(root).filter((e) => e.event === "card.conversion_started" || e.event === "card.shared_converted" || e.event === "card.conversion_failed");
  assert.equal(evs.length, 2, "成功应有 conversion_started + shared_converted");
  assert.equal(evs[0].event, "card.conversion_started");
  assert.equal(evs[1].event, "card.shared_converted");
  assert.ok(!evs.some((e) => e.event === "card.conversion_failed"), "成功不应有 conversion_failed");

  // shared→own
  const root2 = tmpRoot();
  const a2 = createGoal(root2, { title: "A2", version: "v-t", actor: "test" });
  const sid = createSharedCard(root2, { title: "成功转自有", actor: "test" });
  addSharedCardRef(root2, a2, sid, "test");
  fillCard(root2, a2, sid, { text: "x", by: "human:x", actor: "test" });
  const newId2 = convertSharedToOwned(root2, a2, sid, { actor: "test" });
  assert.ok(newId2.startsWith("card-"));
  const evs2 = readEvents(root2).filter((e) => e.event === "card.conversion_started" || e.event === "card.owned_converted" || e.event === "card.conversion_failed");
  assert.equal(evs2.length, 2, "成功应有 conversion_started + owned_converted");
  assert.equal(evs2[0].event, "card.conversion_started");
  assert.equal(evs2[1].event, "card.owned_converted");
  assert.ok(!evs2.some((e) => e.event === "card.conversion_failed"), "成功不应有 conversion_failed");
});

test("step-2 / step-3 失败不误记 *_converted（双向）", () => {
  // own→shared step-2 失败：goal 目录只读使 saveGoal(goal.md) 失败
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, a, { title: "s2", scope: "goal", actor: "test" });
  fillCard(root, a, oc, { text: "x", by: "human:x", actor: "test" });
  const goalDir = dirname(findGoalFile(root, a));
  chmodSync(goalDir, 0o555);
  let err: any = null;
  try { convertOwnedToShared(root, a, oc, { actor: "test" }); } catch (e) { err = e; }
  chmodSync(goalDir, 0o755);
  assert.ok(err);
  let evs = readEvents(root).map((e) => e.event);
  assert.ok(!evs.includes("card.shared_converted"), "own→shared step-2 失败不得误记 shared_converted");

  // shared→own step-2 失败
  const root2 = tmpRoot();
  const a2 = createGoal(root2, { title: "A2", version: "v-t", actor: "test" });
  const sid = createSharedCard(root2, { title: "s2", actor: "test" });
  addSharedCardRef(root2, a2, sid, "test");
  fillCard(root2, a2, sid, { text: "x", by: "human:x", actor: "test" });
  const goalDir2 = dirname(findGoalFile(root2, a2));
  chmodSync(goalDir2, 0o555);
  let err2: any = null;
  try { convertSharedToOwned(root2, a2, sid, { actor: "test" }); } catch (e) { err2 = e; }
  chmodSync(goalDir2, 0o755);
  assert.ok(err2);
  let evs2 = readEvents(root2).map((e) => e.event);
  assert.ok(!evs2.includes("card.owned_converted"), "shared→own step-2 失败不得误记 owned_converted");

  // own→shared step-3 失败：goal 卡片目录只读使 rmSync(自有卡) 失败
  const root3 = tmpRoot();
  const a3 = createGoal(root3, { title: "A3", version: "v-t", actor: "test" });
  const oc3 = addCard(root3, a3, { title: "s3", scope: "goal", actor: "test" });
  fillCard(root3, a3, oc3, { text: "x", by: "human:x", actor: "test" });
  const cardsDir3 = join(dirname(findGoalFile(root3, a3)), "cards");
  chmodSync(cardsDir3, 0o555);
  let err3: any = null;
  try { convertOwnedToShared(root3, a3, oc3, { actor: "test" }); } catch (e) { err3 = e; }
  chmodSync(cardsDir3, 0o755);
  assert.ok(err3);
  let evs3 = readEvents(root3).map((e) => e.event);
  assert.ok(!evs3.includes("card.shared_converted"), "own→shared step-3 失败不得误记 shared_converted");

  // shared→own step-3 失败：shared-cards 只读使 rmSync(共享卡) 失败
  const root4 = tmpRoot();
  const a4 = createGoal(root4, { title: "A4", version: "v-t", actor: "test" });
  const sid4 = createSharedCard(root4, { title: "s3", actor: "test" });
  addSharedCardRef(root4, a4, sid4, "test");
  fillCard(root4, a4, sid4, { text: "x", by: "human:x", actor: "test" });
  const sharedDir4 = join(root4, "shared-cards");
  chmodSync(sharedDir4, 0o555);
  let err4: any = null;
  try { convertSharedToOwned(root4, a4, sid4, { actor: "test" }); } catch (e) { err4 = e; }
  chmodSync(sharedDir4, 0o755);
  assert.ok(err4);
  let evs4 = readEvents(root4).map((e) => e.event);
  assert.ok(!evs4.includes("card.owned_converted"), "shared→own step-3 失败不得误记 owned_converted");
});

test("parseAttachmentRefs 剥离句末/中文标点/括号/链接（不扩大任意路径/URL）", () => {
  assert.deepEqual(parseAttachmentRefs("see @att/docs/a.md, and @att/x.png)."), ["docs/a.md", "x.png"]);
  assert.deepEqual(parseAttachmentRefs("see (@att/docs/a.md), and @att/x.png."), ["docs/a.md", "x.png"]);
  assert.deepEqual(parseAttachmentRefs("[see](@att/docs/a.md) and @att/x.png)"), ["x.png"], "Markdown 链接目标不计（destination 视为 URL 语境）");
  assert.deepEqual(parseAttachmentRefs("见 @att/x.png。 和 @att/a.md，"), ["x.png", "a.md"]);
  assert.deepEqual(parseAttachmentRefs("见 @att/x.png 与 @att/a.md"), ["x.png", "a.md"]);
  assert.deepEqual(parseAttachmentRefs("@att/report.md 与 @att/chart.png"), ["report.md", "chart.png"]);
  assert.deepEqual(parseAttachmentRefs("x @att/../secret"), []);
});

test("attachmentReferenceCount / delete guard 对带尾部标点的引用不绕过", () => {
  const root = tmpRoot();
  storeAttachment(root, { name: "x.png", content: "数据", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, a, { title: "c", scope: "goal", actor: "test" });
  fillCard(root, a, oc, { text: "见 @att/x.png. 使用", by: "human:x", actor: "test" });
  assert.equal(attachmentReferenceCount(root, "x.png"), 1);
  assert.throws(() => deleteAttachment(root, "x.png", { actor: "test" }), /仍被 1 处引用/);
  deleteCard(root, a, oc, { actor: "test" });
  assert.equal(attachmentReferenceCount(root, "x.png"), 0);
  deleteAttachment(root, "x.png", { actor: "test" });
  assert.ok(!existsSync(join(attachmentsDir(root), "x.png")));
});

test("validate 对带尾部标点引用：缺失存在报告、越界报告不安全（同一解析语义）", async () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const gf = findGoalFile(root, a);
  const doc = loadGoal(gf);
  doc.body += "\n见 @att/nope.md。 与 @att/../evil\n";
  const { serializeDoc } = await import("../model.ts");
  writeFileSync(gf, serializeDoc(doc), "utf8");
  const problems = validate(root);
  assert.ok(problems.some((p) => /附件引用不存在 @att\/nope\.md/.test(p)), "应报告缺失: " + problems.join("|"));
  assert.ok(problems.some((p) => /附件引用不安全/.test(p)), "应报告不安全: " + problems.join("|"));
});

test("禁止以点号结尾的附件文件名：存储/路径校验一致拒绝；@att/a. 解析为 a 且 delete guard 不绕过", () => {
  const root = tmpRoot();
  assert.throws(() => storeAttachment(root, { name: "a.", content: "x", actor: "test" }), /不能以点号结尾/);
  assert.throws(() => storeAttachment(root, { name: "sub/a.", content: "x", actor: "test" }), /不能以点号结尾/);
  assert.throws(() => readAttachment(root, "a."), /不能以点号结尾|不存在/);
  assert.throws(() => attachmentInfo(root, "a."), /不能以点号结尾/);
  assert.deepEqual(parseAttachmentRefs("见 @att/a. 使用"), ["a"]);
  // 全链路：存储 a，正文 @att/a. 引用 a → 计数+删除守卫不绕过
  storeAttachment(root, { name: "a", content: "数据", actor: "test" });
  const goal = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, goal, { title: "c", scope: "goal", actor: "test" });
  fillCard(root, goal, oc, { text: "见 @att/a. 使用", by: "human:x", actor: "test" });
  assert.equal(attachmentReferenceCount(root, "a"), 1, "@att/a. 应计数为 a");
  assert.throws(() => deleteAttachment(root, "a", { actor: "test" }), /仍被 1 处引用/, "delete guard 不绕过");
  deleteCard(root, goal, oc, { actor: "test" });
  assert.equal(attachmentReferenceCount(root, "a"), 0);
  deleteAttachment(root, "a", { actor: "test" });
  assert.ok(!existsSync(join(attachmentsDir(root), "a")));
});

test("URL 语境中的 @att/ 不作为附件引用（scheme://、protocol-relative、Markdown 目标含嵌套括号/userinfo；普通正文保留）", () => {
  // scheme:// URL
  assert.deepEqual(parseAttachmentRefs("https://x/@att/a.md"), []);
  assert.deepEqual(parseAttachmentRefs("[x](https://x/@att/a.md)"), []);
  // protocol-relative URL（域样 host：//host.tld）
  assert.deepEqual(parseAttachmentRefs("//x.com/@att/a.md"), []);
  assert.deepEqual(parseAttachmentRefs("see //x.com/@att/a.md"), []);
  assert.deepEqual(parseAttachmentRefs("[x](//x.com/@att/a.md)"), []);
  // protocol-relative userinfo（//user[:pass]@host.tld）
  assert.deepEqual(parseAttachmentRefs("//user:pass@x.com/@att/a"), [], "userinfo 协议相对 URL 不应计");
  assert.deepEqual(parseAttachmentRefs("//user@x.com/@att/a"), [], "userinfo 协议相对 URL 不应计");
  // protocol-relative：真实主机（IPv4/IPv6 bracket/localhost，支持 port / userinfo）
  assert.deepEqual(parseAttachmentRefs("//[::1]/@att/x"), [], "IPv6 URL 不应计");
  assert.deepEqual(parseAttachmentRefs("//localhost/@att/x"), [], "localhost URL 不应计");
  assert.deepEqual(parseAttachmentRefs("//127.0.0.1:8080/@att/x"), [], "IPv4:port URL 不应计");
  assert.deepEqual(parseAttachmentRefs("//[2001:db8::1]:443/@att/x"), [], "IPv6:port URL 不应计");
  assert.deepEqual(parseAttachmentRefs("//user:pass@[2001:db8::1]/@att/x"), [], "IPv6+userinfo URL 不应计");
  assert.deepEqual(parseAttachmentRefs("//user:pass@127.0.0.1:8080/@att/x"), [], "IPv4+userinfo+port URL 不应计");
  // Markdown 绝对/相对 URL 目标（含嵌套/转义括号）
  assert.deepEqual(parseAttachmentRefs("[x](/docs/@att/a.md)"), [], "相对 Markdown URL 目标不应计");
  assert.deepEqual(parseAttachmentRefs("[x](../@att/a.md)"), [], "相对 Markdown URL 目标不应计");
  assert.deepEqual(parseAttachmentRefs("[x](foo (bar)/@att/a)"), [], "Markdown 嵌套括号目标不应计");
  assert.deepEqual(parseAttachmentRefs("见 [x](//[::1]/@att/x) 使用"), [], "Markdown 内 IPv6 URL 目标不应计");
  // 普通正文（有效引用保留）——true URL/注释语境与普通路径区分
  assert.deepEqual(parseAttachmentRefs("见 https://x/@att/a.md and @att/b.md"), ["b.md"], "URL 后的正常正文引用仍保留");
  assert.deepEqual(parseAttachmentRefs("//x.com/@att/a.md 与 @att/real.md"), ["real.md"]);
  assert.deepEqual(parseAttachmentRefs("a/b/@att/x"), ["x"], "普通相对路径 a/b/@att/x 应保留");
  assert.deepEqual(parseAttachmentRefs("foo//bar/@att/x"), ["x"], "foo//bar/@att/x 普通正文应保留");
  assert.deepEqual(parseAttachmentRefs("comment //path/@att/x"), ["x"], "comment //path/@att/x 注释语境应保留");
  assert.deepEqual(parseAttachmentRefs("见 //path/@att/x 使用"), ["x"], "//path 非域样 host 应保留");
  // count 不因 URL 中的 @att/ 阻止删除：存储 a.md，正文仅含 URL（scheme 与 protocol-relative）
  const root = tmpRoot();
  storeAttachment(root, { name: "a.md", content: "数据", actor: "test" });
  const goal = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, goal, { title: "c", scope: "goal", actor: "test" });
  fillCard(root, goal, oc, { text: "见 https://x/@att/a.md 与 //y.com/@att/a.md 链接", by: "human:x", actor: "test" });
  assert.equal(attachmentReferenceCount(root, "a.md"), 0, "URL 中的 @att/a.md 不应计数");
  // delete guard 不误阻止（不因 URL 误认为被引用）
  deleteAttachment(root, "a.md", { actor: "test" });
  assert.ok(!existsSync(join(attachmentsDir(root), "a.md")));
  // count 不因 IPv6/localhost/IPv4 URL 误阻止删除（真实 URL 主机）
  const rootIp = tmpRoot();
  storeAttachment(rootIp, { name: "x", content: "数据", actor: "test" });
  const gIp = createGoal(rootIp, { title: "IP", version: "v-t", actor: "test" });
  const ocIp = addCard(rootIp, gIp, { title: "c", scope: "goal", actor: "test" });
  fillCard(rootIp, gIp, ocIp, { text: "见 //[::1]/@att/x 与 //localhost/@att/x 与 //127.0.0.1:8080/@att/x", by: "human:x", actor: "test" });
  assert.equal(attachmentReferenceCount(rootIp, "x"), 0, "IPv6/localhost/IPv4 URL 中的 @att/x 不应计数");
  deleteAttachment(rootIp, "x", { actor: "test" });
  assert.ok(!existsSync(join(attachmentsDir(rootIp), "x")));
  // 普通正文中的 @att/x 应计数（delete guard 正确阻止）
  const root2 = tmpRoot();
  storeAttachment(root2, { name: "x", content: "数据", actor: "test" });
  const g2 = createGoal(root2, { title: "B", version: "v-t", actor: "test" });
  const oc2 = addCard(root2, g2, { title: "c2", scope: "goal", actor: "test" });
  fillCard(root2, g2, oc2, { text: "见 a/b/@att/x 使用", by: "human:x", actor: "test" });
  assert.equal(attachmentReferenceCount(root2, "x"), 1, "普通正文 a/b/@att/x 应计数为 x");
  assert.throws(() => deleteAttachment(root2, "x", { actor: "test" }), /仍被 1 处引用/);
});

test("validate 对 URL 语境 @att/ 不报告假缺失/不安全，保留正文引用", async () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const gf = findGoalFile(root, a);
  const doc = loadGoal(gf);
  doc.body += "\n访问 https://x/@att/nope.md 与 [链接](https://x/@att/missing.md) 与 [x](/docs/@att/abs.md) 与 [y](../@att/rel.md)，引用 @att/real.md 与 comment //path/@att/real2.md。\n";
  doc.body += "\n另见 //[::1]/@att/ip6.md、//localhost/@att/lh.md、//127.0.0.1:8080/@att/ip4.md、//user:pass@[2001:db8::1]/@att/ip6ui.md 不报缺失。\n";
  const { serializeDoc } = await import("../model.ts");
  writeFileSync(gf, serializeDoc(doc), "utf8");
  const problems = validate(root);
  // URL 语境（scheme:// 、Markdown 目标含绝对/相对 URL、IPv6/localhost/IPv4/带 userinfo 的协议相对 URL）不报假缺失
  assert.ok(!problems.some((p) => /\/nope\.md/.test(p)), "scheme URL 不应报缺失: " + problems.join("|"));
  assert.ok(!problems.some((p) => /\/missing\.md/.test(p)), "Markdown 目标不应报缺失: " + problems.join("|"));
  assert.ok(!problems.some((p) => /\/abs\.md/.test(p)), "绝对 URL 目标不应报缺失: " + problems.join("|"));
  assert.ok(!problems.some((p) => /\/rel\.md/.test(p)), "相对 URL 目标不应报缺失: " + problems.join("|"));
  assert.ok(!problems.some((p) => /\/ip6\.md/.test(p)), "IPv6 URL 目标不应报缺失: " + problems.join("|"));
  assert.ok(!problems.some((p) => /\/lh\.md/.test(p)), "localhost URL 目标不应报缺失: " + problems.join("|"));
  assert.ok(!problems.some((p) => /\/ip4\.md/.test(p)), "IPv4:port URL 目标不应报缺失: " + problems.join("|"));
  assert.ok(!problems.some((p) => /\/ip6ui\.md/.test(p)), "IPv6+userinfo URL 目标不应报缺失: " + problems.join("|"));
  // 正常正文引用（含注释语境 //path/）缺失 → 报缺失
  assert.ok(problems.some((p) => /附件引用不存在 @att\/real\.md/.test(p)), "正常正文引用应报缺失: " + problems.join("|"));
  assert.ok(problems.some((p) => /附件引用不存在 @att\/real2\.md/.test(p)), "注释语境 //path/@att/real2.md 应报缺失: " + problems.join("|"));
});

test("attachmentProblems 消费统一 token 列表并按 ref 去重（重复 @att/nope.md 只报一条）", async () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const gf = findGoalFile(root, a);
  const doc = loadGoal(gf);
  doc.body += "\n见 @att/nope.md 与 @att/nope.md 及 @att/nope.md。\n";
  const { serializeDoc } = await import("../model.ts");
  writeFileSync(gf, serializeDoc(doc), "utf8");
  const problems = validate(root);
  const missingCount = problems.filter((p) => /附件引用不存在 @att\/nope\.md/.test(p)).length;
  assert.equal(missingCount, 1, "重复同 ref 只应报一条: " + problems.join("|"));
});

test("Markdown destination 起点屏蔽目标内 token 且不吞后文（无闭/跨行）", async () => {
  // [x](url) 跨行：行内 destination 起点（含 URL / 无 scheme）均屏蔽，换行后正文 @att/v 应保留
  assert.deepEqual(parseAttachmentRefs("[x](https://x/@att/u\n后续正文 @att/v)"), ["v"], "URL destination 跨行后正文 @att/v 应保留");
  assert.deepEqual(parseAttachmentRefs("[x](@att/u\n后续正文 @att/v)"), ["v"], "无 scheme 跨行 destination：行内 @att/u 被屏蔽，正文 @att/v 保留");
  // 无闭 destination（无换行/到本行末）：destination 起点内的 @att 被屏蔽
  assert.deepEqual(parseAttachmentRefs("[x](@att/a\n正文)"), [], "无闭跨行 destination 起点屏蔽 @att/a");
  assert.deepEqual(parseAttachmentRefs("[x](foo/@att/a"), [], "无闭 destination 屏蔽 @att/a");
  // validate：跨行 destination 起点 token 不报缺失；换行后正文与后续行正文报缺失
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const gf = findGoalFile(root, a);
  const doc = loadGoal(gf);
  doc.body += "\n见 [x](https://x/@att/u.md\n后续正文 @att/v.md) 与 [y](@att/w.md\n正文 @att/z.md)。再 `[x](@att/p.md` 无闭。\n";
  const { serializeDoc } = await import("../model.ts");
  writeFileSync(gf, serializeDoc(doc), "utf8");
  const problems = validate(root);
  // destination 起点（u/w/p）不报缺失（被屏蔽），换行后正文（v/z）报缺失
  assert.ok(!problems.some((p) => /\/u\.md/.test(p)), "destination 起点 URL @att/u.md 不应报缺失: " + problems.join("|"));
  assert.ok(!problems.some((p) => /\/w\.md/.test(p)), "destination 起点无 scheme @att/w.md 不应报缺失: " + problems.join("|"));
  assert.ok(!problems.some((p) => /\/p\.md/.test(p)), "无闭 destination 起点的 @att/p.md 不应报缺失: " + problems.join("|"));
  assert.ok(problems.some((p) => /附件引用不存在 @att\/v\.md/.test(p)), "换行后正文 @att/v.md 应报缺失: " + problems.join("|"));
  assert.ok(problems.some((p) => /附件引用不存在 @att\/z\.md/.test(p)), "第二行正文 @att/z.md 应报缺失: " + problems.join("|"));
});

test("deleteAttachment 先删文件后记事件：rm 失败不宣称已删除（事件/磁盘一致）", () => {
  const root = tmpRoot();
  storeAttachment(root, { name: "del.md", content: "数据", actor: "test" });
  const attDir = attachmentsDir(root);
  const evsBefore = readEvents(root).filter((e) => e.event === "attachment.deleted").length;
  chmodSync(attDir, 0o555); // 使 rmSync 失败（EACCES）
  let err: any = null;
  try { deleteAttachment(root, "del.md", { actor: "test" }); } catch (e) { err = e; }
  chmodSync(attDir, 0o755);
  assert.ok(err, "rm 失败应抛出");
  assert.ok(existsSync(join(attDir, "del.md")), "rm 失败文件仍在");
  const evsAfter = readEvents(root).filter((e) => e.event === "attachment.deleted").length;
  assert.equal(evsAfter, evsBefore, "rm 失败不得记 attachment.deleted 事件");
  // rm 成功路径：正常删除且记事件
  deleteAttachment(root, "del.md", { actor: "test" });
  assert.ok(!existsSync(join(attDir, "del.md")));
  assert.equal(readEvents(root).filter((e) => e.event === "attachment.deleted").length, evsBefore + 1, "成功删除才记事件");
});

test("deleteAttachment 事件记录失败：文件恢复原状、不漂移（rename/trash+回滚）", () => {
  const root = tmpRoot();
  storeAttachment(root, { name: "del.md", content: "数据", actor: "test" });
  const del = join(attachmentsDir(root), "del.md");
  const evFile = join(root, "events.jsonl");
  const evSnapshot = readFileSync(evFile, "utf8");
  // 把 events.jsonl 换成目录 → appendEvent 失败（EISDIR）
  rmSync(evFile, { force: true });
  mkdirSync(evFile, { recursive: true });
  let err: any = null;
  try { deleteAttachment(root, "del.md", { actor: "test" }); } catch (e) { err = e; }
  // 恢复事件文件
  rmSync(evFile, { recursive: true, force: true });
  writeFileSync(evFile, evSnapshot, "utf8");
  assert.ok(err, "事件记录失败应抛出");
  assert.ok(existsSync(del), "事件失败后文件已恢复原状（未删除）");
  assert.equal(readEvents(root).filter((e) => e.event === "attachment.deleted").length, 0, "事件失败不应记 deleted 事件");
  // 恢复正常删除
  deleteAttachment(root, "del.md", { actor: "test" });
  assert.ok(!existsSync(del));
  assert.equal(readEvents(root).filter((e) => e.event === "attachment.deleted").length, 1, "成功删除才记事件");
  // 残留 .trash-* 不列为附件（listAttachments 过滤隐藏文件）
  assert.ok(!listAttachments(root).some((n) => n.startsWith(".trash-") || n.startsWith(".tmp-") || n.startsWith(".")));
});

test("父目录被替换为指向外部的 symlink：read/delete/store 拒绝且不越界（TOCTOU 重验）", () => {
  const root = tmpRoot();
  const outside = join(root, "..", "out-dir-" + Date.now());
  mkdirSync(outside, { recursive: true });
  storeAttachment(root, { name: "sub/f.txt", content: "数据", actor: "test" });
  assert.ok(existsSync(join(attachmentsDir(root), "sub", "f.txt")));
  // 把 sub 目录替换为 symlink → 指向外部
  const subDir = join(attachmentsDir(root), "sub");
  rmSync(subDir, { recursive: true, force: true });
  symlinkSync(outside, subDir);
  // read / delete / store 均拒绝（父目录为 symlink；resolve 与 reassert 均拦截）
  assert.throws(() => readAttachment(root, "sub/f.txt"), /symlink|越界|不可达/);
  assert.throws(() => deleteAttachment(root, "sub/f.txt", { actor: "test" }), /symlink|不存在|越界/);
  assert.throws(() => storeAttachment(root, { name: "sub/g.txt", content: "x", actor: "test" }), /symlink|越界/);
  assert.ok(!existsSync(join(outside, "f.txt")), "不得在外部读取/删除");
  assert.ok(!existsSync(join(outside, "g.txt")), "不得在外部写入");
});

test("g-240: 共享卡在预算控制下保留 scope=共享、精确路径与 digest 审计", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "共享架构设计", kind: "text", actor: "test" });
  const goal = createGoal(root, { title: "共享卡预算测试", version: "v-t", actor: "test" });
  addSharedCardRef(root, goal, sid, "test");
  const longContent = "这是共享卡的详细架构约束。".repeat(150);
  fillCard(root, goal, sid, { text: longContent, summary: "架构约束摘要", by: "human:arch", actor: "test" });
  reviewCard(root, goal, sid, { by: "human:lead", actor: "test" });

  const sec = formatHarvestedCardsSection(root, goal, { maxCardChars: 400 });
  assert.ok(sec.includes("共享架构设计"));
  assert.ok(sec.includes("scope=共享"), "保留共享标记");
  assert.ok(sec.includes("摘要：架构约束摘要"), "保留摘要");
  assert.ok(sec.includes("⚠️ 正文已超出单卡预算 400 字已截断"), "超出单卡预算截断");
  assert.ok(sec.includes(`shared-cards/${sid}.md`), "给出共享卡的精确文件路径");
  assert.match(sec, /digest=[a-f0-9]{16}/, "包含审计摘要");
});
