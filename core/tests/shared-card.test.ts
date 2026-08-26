/** 共享上下文卡片（g-183）单元测试：node:test，零依赖。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "../ops.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-shared-"));
  init(dir);
  return dir;
}

test("创建共享卡：落共享池、scope=shared、零引用", () => {
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
  // 非法 kind 拒绝
  assert.throws(() => createSharedCard(root, { title: "x", kind: "video", actor: "test" }), GraphError);
});

test("共享卡多 goal 引用同一份权威；修改后各引用读一致（判据 #1）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "共享乙", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const b = createGoal(root, { title: "B", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  addSharedCardRef(root, b, sid, "test");
  assert.equal(referenceCount(root, sid), 2);
  fillCard(root, a, sid, { text: "权威内容 v1", by: "human:x", actor: "test" });
  reviewCard(root, a, sid, { by: "human:y", actor: "test" });
  // 两个 goal 的引用都读到同一份权威内容
  const ha = harvestedCards(root, a);
  const hb = harvestedCards(root, b);
  assert.equal(ha.length, 1);
  assert.equal(hb.length, 1);
  assert.equal(ha[0].content, "权威内容 v1");
  assert.equal(hb[0].content, "权威内容 v1");
  assert.equal(ha[0].scope, "shared");
  assert.equal(hb[0].scope, "shared");
  // 修改权威内容（经另一 goal 引用）→ 各引用读最新
  fillCard(root, b, sid, { text: "权威内容 v2", by: "agent:z", actor: "test" });
  assert.equal(harvestedCards(root, a)[0].content, "权威内容 v2");
  assert.equal(harvestedCards(root, b)[0].content, "权威内容 v2");
  // goalCards 在两侧均标记 scope=shared
  assert.equal(goalCards(root, a)[0].scope, "shared");
  assert.equal(goalCards(root, b)[0].scope, "shared");
  assert.deepEqual(validate(root), []);
});

test("addCard 默认 goal 自有（向后兼容）；scope=shared 创建共享并挂 goal", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  // 默认 goal 自有
  const oc = addCard(root, a, { title: "自有", kind: "text", actor: "test" });
  assert.ok(oc.startsWith("card-"));
  const ownFile = join(root, "versions", "v-t", "goals", a, "cards", `${oc}.md`);
  assert.ok(existsSync(ownFile), "默认应建为 goal 自有卡");
  assert.equal(loadGoal(ownFile).meta.scope, undefined, "自有卡不应带 scope 字段");
  // 显式 shared
  const sc = addCard(root, a, { title: "共享", kind: "text", scope: "shared", actor: "test" });
  assert.ok(sc.startsWith("shared-"));
  assert.ok(existsSync(join(root, "shared-cards", `${sc}.md`)), "scope=shared 应落共享池");
  assert.equal(referenceCount(root, sc), 1);
  const cards = goalCards(root, a);
  const owned = cards.find((c) => c.id === oc);
  const shared = cards.find((c) => c.id === sc);
  assert.equal(owned.scope, "goal");
  assert.equal(shared.scope, "shared");
  assert.deepEqual(validate(root), []);
});

test("own→shared 转换：内容不丢失、原 goal 保留引用、无半转换（判据 #3）", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, a, { title: "转换甲", kind: "text", actor: "test" });
  fillCard(root, a, oc, { text: "转换内容", by: "human:x", actor: "test" });
  reviewCard(root, a, oc, { by: "human:y", actor: "test" });
  convertOwnedToShared(root, a, oc, { actor: "test" });
  // 内容保留在共享池
  const sp = join(root, "shared-cards", `${oc}.md`);
  assert.ok(existsSync(sp), "转换后共享池应有权威内容");
  assert.equal(loadGoal(sp).meta.scope, "shared");
  assert.ok(loadGoal(sp).body.includes("转换内容"), "内容不丢失");
  // 原 goal 保留有效引用（解析到共享）
  assert.equal(resolveCard(root, a, oc).scope, "shared");
  // 自有副本应删除（不为 goal 复制）
  const ownFile = join(root, "versions", "v-t", "goals", a, "cards", `${oc}.md`);
  assert.ok(!existsSync(ownFile), "自有副本应删除");
  assert.equal(referenceCount(root, oc), 1);
  assert.deepEqual(validate(root), []);
  // 已是共享卡时再次转换应拒绝
  assert.throws(() => convertOwnedToShared(root, a, oc, { actor: "test" }), /已是共享卡/);
});

test("shared→own 转换：仅引用计数恰为 1 时成功，>1 拒绝且不部分修改（判据 #4）", () => {
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
  convertSharedToOwned(root, a, sid, { actor: "test" });
  const ownFile = join(root, "versions", "v-t", "goals", a, "cards", `${sid}.md`);
  assert.ok(existsSync(ownFile), "转换后应在 goal 自有目录");
  assert.equal(loadGoal(ownFile).meta.scope, "goal");
  assert.equal(loadGoal(ownFile).meta.goal, a);
  assert.ok(!existsSync(join(root, "shared-cards", `${sid}.md`)), "共享池副本应删除");
  assert.deepEqual(validate(root), []);
});

test("共享卡删除保护：被引用拒绝；解除全部引用后仅显式删除（判据 #5）", () => {
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

test("共享卡 collecting 单一权威收集者（判据 #6）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "收集甲", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  bindCardChild(root, a, sid, { childId: "child-1", actor: "test" });
  // 同一 child 重复绑定幂等（不抛错）
  bindCardChild(root, a, sid, { childId: "child-1", actor: "test" });
  // 换一个 child 并行收集 → 拒绝
  assert.throws(() => bindCardChild(root, a, sid, { childId: "child-2", actor: "test" }), /只允许一个权威收集者/);
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

test("boardProjection / goalDetail 下发共享卡 scope（判据 #2 部分）", () => {
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
});

test("deleteGoal / archiveGoal / moveGoal 不改变共享卡独立物理归属（判据 #5）", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "存活乙", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  const sp = join(root, "shared-cards", `${sid}.md`);
  // moveGoal：版本 → 独立，共享位置与引用不变
  moveGoal(root, a, { to: "standalone", actor: "test" });
  assert.ok(existsSync(sp), "moveGoal 后共享池应存活");
  assert.equal(resolveCard(root, a, sid).scope, "shared");
  assert.equal(referenceCount(root, sid), 1);
  // archive：共享池存活，且引用仍被计数（含归档）
  archiveGoal(root, a, { actor: "test" });
  assert.ok(existsSync(sp), "归档后共享池应存活");
  assert.equal(referenceCount(root, sid), 1);
  // deleteGoal：仅删该 goal，共享池存活、引用归零
  deleteGoal(root, a, { actor: "test" });
  assert.ok(existsSync(sp), "删除 goal 后共享池应存活");
  assert.equal(referenceCount(root, sid), 0);
});

test("共享卡引用保证 goal 卡片列表同处展示（自有+共享）且 validate 无悬空", () => {
  const root = tmpRoot();
  const sid = createSharedCard(root, { title: "混合展示", kind: "text", actor: "test" });
  const a = createGoal(root, { title: "A", version: "v-t", actor: "test" });
  const oc = addCard(root, a, { title: "自有卡", kind: "data", actor: "test" });
  addSharedCardRef(root, a, sid, "test");
  const cards = goalCards(root, a);
  assert.equal(cards.length, 2);
  assert.equal(cards.find((c) => c.id === oc).scope, "goal");
  assert.equal(cards.find((c) => c.id === sid).scope, "shared");
  assert.deepEqual(validate(root), []);
});
