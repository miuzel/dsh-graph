/** g-379：目标间「覆盖/调整/补充」关系与单一真源标记（落法 A）。
 *  判据 1–9 逐条覆盖；含负向对照与既有语义回归钉。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import {
  init,
  createGoal,
  setCriteria,
  transition,
  deleteGoal,
  archiveGoal,
  validate,
  loadGoal,
  saveGoal,
  findGoalFile,
  boardProjection,
  boardPayload,
  addRelation,
  removeRelation,
  goalRelationViews,
  relationsToken,
  deriveGoalRelations,
  RELATION_TYPES,
  GraphError,
  GraphConflictError,
  sectionText,
} from "../ops.ts";
import { STATUSES } from "../machine.ts";
import { readEvents } from "../events.ts";
import { validateVersionRelease } from "../version-lane.ts";
import { apply } from "../../dist/index.js";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g379-"));
  init(dir);
  return dir;
}

function makeGoal(root: string, title: string, version?: string): string {
  return createGoal(root, { title, version, actor: "test" });
}

function addr(root: string, id: string) {
  return String(loadGoal(findGoalFile(root, id)).meta.id);
}

const REQ = (root: string, from: string, type: string, goal: string, extra: any = {}) => ({
  from, type, goal, actor: "test", ...extra,
});

// ---- 判据 1：schema 闭集 / 自关联 / 不存在 id / 跨版本行为 ----

test("g-379 判据1：关系类型为封闭五元集（supersedes/amends/extends/depends_on/related）", () => {
  assert.deepEqual([...RELATION_TYPES], ["supersedes", "amends", "extends", "depends_on", "related"]);
});

test("g-379 判据1：未知关系类型被拒（含 depends 拼写近似值）", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  for (const bad of ["overrides", "supersede", "DEPENDS_ON", "depends", "", "related_to"]) {
    assert.throws(
      () => addRelation(root, REQ(root, a, bad, b)),
      (e: any) => e instanceof GraphError && /非法关系类型/.test(e.message),
      `类型 ${JSON.stringify(bad)} 应被拒绝`,
    );
  }
  // 拒绝必须零副作用（不建关系、不记事件）
  assert.equal(relationsToken(loadGoal(findGoalFile(root, a)).meta).length, 0);
  assert.equal(readEvents(root).filter((e) => e.event.startsWith("goal.relation")).length, 0);
});

test("g-379 判据1：自关联被拒且零副作用", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A");
  assert.throws(
    () => addRelation(root, REQ(root, a, "supersedes", a)),
    (e: any) => e instanceof GraphError && /自关联/.test(e.message),
  );
  assert.equal(validate(root).filter((p) => p.includes("自关联")).length, 0);
  assert.equal(readEvents(root).filter((e) => e.event.startsWith("goal.relation")).length, 0);
});

test("g-379 判据1：指向不存在 / 已删除 goal id 被拒", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A");
  const gone = makeGoal(root, "将被删除");
  archiveGoal(root, gone, { actor: "test" });
  deleteGoal(root, gone, { actor: "test" });
  assert.throws(
    () => addRelation(root, REQ(root, a, "supersedes", gone)),
    (e: any) => e instanceof GraphError && /目标不存在/.test(e.message),
  );
  assert.throws(
    () => addRelation(root, REQ(root, a, "related", "g-9999")),
    (e: any) => e instanceof GraphError && /目标不存在/.test(e.message),
  );
});

test("g-379 判据1：跨版本引用放行并标注 cross_version（不拒绝）", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "新目标", "v-new");
  const b = makeGoal(root, "旧目标", "v-old");
  const r = addRelation(root, REQ(root, a, "supersedes", b));
  assert.equal(r.changed, true);
  assert.deepEqual(validate(root), [], "跨版本引用不应产生校验问题");
  const views = goalRelationViews(root, a);
  assert.equal(views.outgoing[0].cross_version, true, "应标注跨版本");
  const bViews = goalRelationViews(root, b);
  assert.equal(bViews.incoming[0].cross_version, true);
  assert.equal(bViews.superseded_by, addr(root, a));
});

// ---- 判据 2：环检测复用既有 DFS ----

test("g-379 判据2：supersedes/amends 环被检出且报错含环路径", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  addRelation(root, REQ(root, a, "supersedes", b));
  addRelation(root, REQ(root, b, "supersedes", a));
  const problems = validate(root);
  const cycle = problems.find((p) => p.includes("关系替代环"));
  assert.ok(cycle, `应报告关系替代环，实际：${JSON.stringify(problems)}`);
  assert.match(cycle!, new RegExp(`${a} → ${b} → ${a}`), "环路径应含完整节点链");

  const root2 = tmpRoot();
  const c = makeGoal(root2, "C");
  const d = makeGoal(root2, "D");
  addRelation(root2, REQ(root2, c, "amends", d));
  addRelation(root2, REQ(root2, d, "amends", c));
  assert.ok(validate(root2).some((p) => p.includes("关系替代环")), "amends 环同样应检出");
});

test("g-379 判据2：extends/related 允许互引（不误报环）", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  addRelation(root, REQ(root, a, "extends", b));
  addRelation(root, REQ(root, b, "extends", a));
  addRelation(root, REQ(root, a, "related", b));
  assert.deepEqual(validate(root), []);
});

test("g-379 判据2：环检测只有一套 DFS 实现（结构性负向守卫）", () => {
  const src = readFileSync(join(import.meta.dirname, "../ops.ts"), "utf8");
  const occurrences = src.split("stack.indexOf(dep)").length - 1;
  assert.equal(occurrences, 1, "环路径拼接必须只有一处实现（复用同一 DFS）");
  assert.ok(/function dfsCycleProblems\(/.test(src), "共享 DFS 必须存在");
  assert.ok(/dfsCycleProblems\(deps, "依赖"\)/.test(src), "依赖边必须复用共享 DFS");
  assert.ok(/dfsCycleProblems\(relEdges, "关系替代"\)/.test(src), "关系替代边必须复用共享 DFS");
});

test("g-379 判据2/9：depends_on 环报错文案与语义不回归", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  addRelation(root, REQ(root, a, "depends_on", b));
  addRelation(root, REQ(root, b, "depends_on", a));
  const problems = validate(root);
  const dep = problems.find((p) => p.startsWith("依赖环："));
  assert.ok(dep, `depends_on 环应沿用既有文案，实际：${JSON.stringify(problems)}`);
  assert.equal(dep, `依赖环：${addr(root, a)} → ${addr(root, b)} → ${addr(root, a)}`);
});

// ---- 判据 3：落法 A（不新增 status） ----

test("g-379 判据3：不新增状态；被取代语义用 meta.superseded_by + 关系条目表达", () => {
  assert.deepEqual(
    [...STATUSES],
    ["draft", "planning", "collecting", "ready", "in_progress", "review", "delivered", "blocked"],
    "状态机不得因本目标新增状态",
  );
  const root = tmpRoot();
  const a = makeGoal(root, "新方案", "v-x");
  const b = makeGoal(root, "旧方案", "v-x");
  setCriteria(root, b, ["旧判据"], "test");
  transition(root, b, "in_progress", { actor: "test" });
  const before = loadGoal(findGoalFile(root, b)).meta.status;
  addRelation(root, REQ(root, a, "supersedes", b));
  const bMeta = loadGoal(findGoalFile(root, b)).meta;
  assert.equal(bMeta.status, before, "被取代目标 status 必须原样不动");
  assert.equal(bMeta.superseded_by, addr(root, a), "被取代语义写入 meta.superseded_by");
  const aMeta = loadGoal(findGoalFile(root, a)).meta;
  assert.deepEqual(aMeta.relations, [{ type: "supersedes", goal: addr(root, b) }]);
});

test("g-379 判据3：superseded_by 是派生镜像——手工篡改会被 validate 判为双真相", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A", "v-x");
  const b = makeGoal(root, "B", "v-x");
  addRelation(root, REQ(root, a, "supersedes", b));
  // 手工把 B 的派生字段改成不存在的来源
  const bFile = findGoalFile(root, b);
  const doc = loadGoal(bFile);
  doc.meta.superseded_by = "g-4242";
  saveGoal(bFile, doc);
  assert.ok(
    validate(root).some((p) => p.includes("meta.superseded_by=g-4242") && p.includes("不一致")),
    "派生字段漂移必须被 validate 捕获",
  );
});

test("g-379 判据3：depends_on 复用既有 meta.depends_on（不搬到 relations）", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  addRelation(root, REQ(root, a, "depends_on", b));
  const meta = loadGoal(findGoalFile(root, a)).meta;
  assert.equal(meta.relations, undefined, "depends_on 不得写入 relations（避免双真相）");
  assert.deepEqual(meta.depends_on, [{ goal: addr(root, b) }]);
  assert.deepEqual(relationsToken(meta), [`depends_on:${addr(root, b)}`]);
});

// ---- 判据 4：单一真源 + 其余派生 ----

test("g-379 判据4：A supersedes B ⇒ 双向视图可见（前端/正文同源）", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A", "v-x");
  const b = makeGoal(root, "B", "v-x");
  addRelation(root, REQ(root, a, "supersedes", b));
  const av = goalRelationViews(root, a);
  assert.deepEqual(av.outgoing.map((r) => `${r.type}:${r.goal}`), [`supersedes:${addr(root, b)}`]);
  assert.deepEqual(av.incoming, []);
  const bv = goalRelationViews(root, b);
  assert.deepEqual(bv.incoming.map((r) => `${r.type}:${r.goal}`), [`supersedes:${addr(root, a)}`]);
  assert.equal(bv.superseded_by, addr(root, a));

  const board = boardProjection(root);
  const go = (id: string) => [...board.versions.flatMap((v) => v.goals), ...board.standalone, ...board.backlog,
    ...board.versions.flatMap((v) => v.goals)].find((g) => g.id === id)!;
  assert.deepEqual(go(addr(root, a)).relations!.outgoing.map((r) => `${r.type}:${r.goal}`), [`supersedes:${addr(root, b)}`]);
  assert.deepEqual(go(addr(root, b)).relations!.incoming.map((r) => `${r.type}:${r.goal}`), [`supersedes:${addr(root, a)}`]);
  assert.equal(go(addr(root, b)).superseded_by, addr(root, a));
});

test("g-379 判据4：视图纯派生——手工写 frontmatter 即生效，无需事件", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A", "v-x");
  const b = makeGoal(root, "B", "v-x");
  const relEventsBefore = readEvents(root).filter((e) => e.event.startsWith("goal.relation")).length;
  // 直接改 frontmatter（单一真源），不调用 addRelation、不记事件
  const aFile = findGoalFile(root, a);
  const doc = loadGoal(aFile);
  doc.meta.relations = [{ type: "amends", goal: addr(root, b) }];
  saveGoal(aFile, doc);
  assert.equal(readEvents(root).filter((e) => e.event.startsWith("goal.relation")).length, relEventsBefore, "手工写入不应产生事件");
  assert.equal(goalRelationViews(root, b).amended_by, undefined as any);
  assert.equal(goalRelationViews(root, b).incoming[0].type, "amends", "看板/反向视图必须由 frontmatter 派生");
  assert.deepEqual(validate(root), []);
});

test("g-379 判据4：重复 add 幂等——不重复写入、不重复记事件", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  const first = addRelation(root, REQ(root, a, "supersedes", b));
  const second = addRelation(root, REQ(root, a, "supersedes", b));
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(loadGoal(findGoalFile(root, a)).meta.relations.length, 1);
  assert.equal(readEvents(root).filter((e) => e.event === "goal.relation.added").length, 1);
  const bytes1 = readFileSync(findGoalFile(root, a), "utf8");
  addRelation(root, REQ(root, a, "supersedes", b));
  assert.equal(readFileSync(findGoalFile(root, a), "utf8"), bytes1, "幂等调用不得改写文件");
});

// ---- 判据 5：标记可见性（防误读） ----

test("g-379 判据5：被覆盖目标 goal.md 正文含人类可读说明（取代/调整 + 能力可能已移除）", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A", "v-x");
  const b = makeGoal(root, "B", "v-x");
  const c = makeGoal(root, "C", "v-x");
  addRelation(root, REQ(root, a, "supersedes", b));
  addRelation(root, REQ(root, c, "amends", b));
  const body = loadGoal(findGoalFile(root, b)).body;
  const section = sectionText(body, "目标关系");
  assert.ok(section, "被覆盖目标正文必须有「目标关系」小节");
  assert.match(section!, new RegExp(`本目标已被 \`${addr(root, a)}\` 取代（supersedes）`));
  assert.match(section!, /能力可能已移除/);
  assert.match(section!, new RegExp(`本目标已被 \`${addr(root, c)}\` 调整（amends）`));
});

test("g-379 判据5：无关系时不渲染空壳（不新建「目标关系」小节）", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "孤立目标", "v-x");
  assert.equal(sectionText(loadGoal(findGoalFile(root, a)).body, "目标关系"), null);
  const card = boardProjection(root).versions[0].goals[0];
  assert.deepEqual(card.relations, { outgoing: [], incoming: [] });
  assert.equal(card.superseded_by, null);
});

test("g-379 判据5：解除关系后受管小节被移除（不留空壳）", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A", "v-x");
  const b = makeGoal(root, "B", "v-x");
  addRelation(root, REQ(root, a, "supersedes", b));
  assert.ok(sectionText(loadGoal(findGoalFile(root, b)).body, "目标关系"));
  removeRelation(root, REQ(root, a, "supersedes", b));
  assert.equal(sectionText(loadGoal(findGoalFile(root, b)).body, "目标关系"), null);
  assert.equal(loadGoal(findGoalFile(root, b)).meta.superseded_by, undefined);
  assert.equal(validate(root).length, 0);
});

test("g-379 判据5：指向已归档对端显示「已归档」而非崩溃/误报", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A", "v-x");
  const b = makeGoal(root, "B", "v-x");
  archiveGoal(root, b, { actor: "test" });
  const r = addRelation(root, REQ(root, a, "supersedes", b));
  assert.equal(r.changed, true, "已归档对端应放行");
  const views = goalRelationViews(root, a);
  assert.equal(views.outgoing[0].archived, true);
  assert.equal(views.outgoing[0].missing, false);
  assert.deepEqual(validate(root), [], "已归档引用不是悬空引用");
});

test("g-379 判据5/8：悬空引用（对端被删除）标注 missing 且不崩", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A", "v-x");
  const b = makeGoal(root, "B", "v-x");
  const bId = addr(root, b);
  addRelation(root, REQ(root, a, "supersedes", b));
  archiveGoal(root, b, { actor: "test" });
  deleteGoal(root, b, { actor: "test" });
  // 投影不得抛错；对端标记 missing
  const board = boardProjection(root);
  const card = board.versions[0].goals.find((g) => g.id === addr(root, a))!;
  assert.equal(card.relations!.outgoing[0].missing, true);
  assert.equal(card.relations!.outgoing[0].goal, bId);
  // 悬空引用必须被 validate 报告
  assert.ok(validate(root).some((p) => p.includes(`关系指向不存在的目标 ${bId}`)), "悬空关系应被 validate 报告");
  // 对端已删除时仍允许清理悬空关系（否则无法收敛）
  const rm = removeRelation(root, REQ(root, a, "supersedes", b));
  assert.equal(rm.changed, true, "悬空关系应可被清理");
  assert.deepEqual(validate(root), [], "清理后校验干净");
});

test("g-379 判据5：add 悬空对端被拒，但既有悬空关系可解除（清理路径）", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A", "v-x");
  const b = makeGoal(root, "B", "v-x");
  const c = makeGoal(root, "C", "v-x");
  addRelation(root, REQ(root, a, "supersedes", b));
  archiveGoal(root, b, { actor: "test" });
  deleteGoal(root, b, { actor: "test" });
  // add 到已删除对端 → 拒绝
  assert.throws(() => addRelation(root, REQ(root, c, "supersedes", b)), (e: any) => e instanceof GraphError);
  // 清理悬空关系（手工 frontmatter 与工具两条路径都可）
  const rm = removeRelation(root, REQ(root, a, "supersedes", b));
  assert.equal(rm.changed, true);
  assert.deepEqual(validate(root), []);
});

test("g-379 判据5：客户端卡片渲染——徽标可见、可跳转对端、无关系返回 null、悬空不抛错", () => {
  const cardSrc = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/card.js"), "utf8");
  const start = cardSrc.indexOf("    function relationIncoming(g) {");
  const end = cardSrc.indexOf("    function Card(g, onOpen");
  assert.ok(start > 0 && end > start, "关系渲染辅助函数必须存在");
  const fragment = cardSrc.slice(start, end);
  const h = (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children });
  const calls: string[] = [];
  const sandbox: any = {
    h,
    S: { meta: {} },
    dgT: (key: string, vars?: any) => `${key}${vars && vars.id ? "|" + vars.id : ""}`,
    React: {},
  };
  vm.runInNewContext(
    fragment + "; this.RelationBadges = RelationBadges; this.RelationList = RelationList;",
    sandbox,
  );
  const { RelationBadges, RelationList } = sandbox;

  // 有 supersedes 入向 → 徽标存在且点击跳转对端
  const g = {
    id: "g-1",
    relations: {
      outgoing: [],
      incoming: [{ type: "supersedes", goal: "g-2", title: "旧", status: "delivered", archived: false, missing: false, cross_version: false }],
    },
  };
  const badge = RelationBadges({ g, onOpen: (id: string) => calls.push(id) });
  assert.ok(badge, "被取代必须有徽标");
  badge.children[0][0].props.onClick({ stopPropagation() {} });
  assert.deepEqual(calls, ["g-2"], "徽标点击应跳转对端目标");

  // 无关系 → 不渲染空壳
  assert.equal(RelationBadges({ g: { id: "g-1", relations: { outgoing: [], incoming: [] } }, onOpen: () => {} }), null);
  assert.equal(RelationBadges({ g: { id: "g-1" }, onOpen: () => {} }), null);
  assert.equal(RelationList({ g: { id: "g-1" }, onOpen: () => {} }), null);

  // 悬空 + 已归档：不抛错，文案降级
  const gMiss = { id: "g-1", relations: { outgoing: [{ type: "supersedes", goal: "g-x", title: "g-x", status: "unknown", archived: false, missing: true, cross_version: false }], incoming: [] } };
  const missBadge = RelationBadges({ g: { ...gMiss, relations: { incoming: [{ type: "supersedes", goal: "g-x", title: "g-x", status: "unknown", archived: false, missing: true, cross_version: false }], outgoing: [] } }, onOpen: (id: string) => calls.push("miss:" + id) });
  assert.ok(missBadge, "悬空也应显示提示徽标");
  missBadge.children[0][0].props.onClick({ stopPropagation() {} });
  assert.equal(calls.filter((c) => c.startsWith("miss:")).length, 0, "悬空对端不可跳转");
  const list = RelationList({ g: gMiss, onOpen: () => {} });
  assert.ok(list, "展开态关系清单应渲染");
  assert.ok(JSON.stringify(list).includes("card.relationMissing"), "悬空显示「未知 id」文案");
  // 异常输入不得抛错
  assert.equal(RelationBadges({ g: { relations: { incoming: null } }, onOpen: () => {} }), null);
});

test("g-379 判据5/9：i18n zh/en 对称、en 零 CJK、含关系键", () => {
  const i18nSrc = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/i18n.js"), "utf8");
  const sandbox: any = { React: {} };
  vm.runInNewContext(i18nSrc + "; this.zh = zh; this.en = en;", sandbox);
  const zhKeys = Object.keys(sandbox.zh).sort();
  assert.deepEqual(zhKeys, Object.keys(sandbox.en).sort(), "zh/en 键必须完全对称");
  const relationKeys = [
    "card.superseded", "card.amended", "card.relationsTitle", "card.relationMissing",
    "card.relationArchived", "card.relationJump", "card.relType.supersedes", "card.relType.amends",
    "card.relType.extends", "card.relType.depends_on", "card.relType.related",
  ];
  for (const k of relationKeys) assert.ok(zhKeys.includes(k), `缺 i18n 键 ${k}`);
  // en 新增词条必须零 CJK（全角标点也计入）
  const cjk = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
  for (const k of relationKeys) {
    assert.ok(!cjk.test(String(sandbox.en[k])), `en 词条含 CJK：${k}=${sandbox.en[k]}`);
  }
});

// ---- 判据 6：delivered guard 不动 ----

test("g-379 判据6：被覆盖目标仍计入 validateVersionRelease（不得开旁路）", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "新", "v-gate");
  const b = makeGoal(root, "旧", "v-gate");
  // a 先行交付，b 停在 in_progress → 阻塞清单必须恰好是 b（被覆盖者仍计入）
  setCriteria(root, a, ["新判据"], "test");
  transition(root, a, "in_progress", { actor: "test" });
  transition(root, a, "review", { actor: "test" });
  transition(root, a, "delivered", { actor: "test" });
  setCriteria(root, b, ["旧判据"], "test");
  transition(root, b, "in_progress", { actor: "test" });
  addRelation(root, REQ(root, a, "supersedes", b));
  const blocking = validateVersionRelease(root, "v-gate");
  assert.deepEqual(blocking.map((x) => x.id), [addr(root, b)], "被覆盖但非 delivered 的目标仍必须计入阻塞清单");
  // 被覆盖目标交付后放行（guard 口径不变，无 supersedes 旁路）
  transition(root, b, "review", { actor: "test" });
  transition(root, b, "delivered", { actor: "test" });
  assert.deepEqual(validateVersionRelease(root, "v-gate"), [], "全部 delivered（含被覆盖者）即放行");
});

test("g-379 判据6：发布 guard 源码不得出现 supersedes/relations 旁路（负向守卫）", () => {
  const src = readFileSync(join(import.meta.dirname, "../version-lane.ts"), "utf8");
  assert.ok(!/supersede/i.test(src), "发布 guard 不得读取 supersedes（禁止为覆盖关系开旁路）");
  assert.ok(!/meta\.relations/.test(src), "发布 guard 不得读取 relations");
  assert.ok(/doc\.meta\.status !== "delivered"/.test(src), "原有 delivered 口径必须保留");
});

// ---- 判据 7：不做处置功能 ----

test("g-379 判据7：建立覆盖关系不自动归档、不自动改状态、不记处置事件", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "新", "v-x");
  const b = makeGoal(root, "旧", "v-x");
  setCriteria(root, b, ["判据"], "test");
  transition(root, b, "in_progress", { actor: "test" });
  const before = readFileSync(findGoalFile(root, b), "utf8");
  addRelation(root, REQ(root, a, "supersedes", b));
  const after = loadGoal(findGoalFile(root, b));
  assert.equal(after.meta.status, "in_progress", "不得自动改状态");
  assert.equal(after.meta.archived, undefined, "不得自动归档");
  assert.ok(existsSync(join(root, "versions", "v-x", "goals", b.replace(/^g-/, "g-"), "goal.md")) || after.meta.status === "in_progress");
  assert.equal(readEvents(root).filter((e) => e.event === "goal.archived").length, 0, "不得产生归档事件");
  // goal.md 仅在受管小节/派生字段上有差异，非受管内容（如判据）保持逐字不变
  assert.ok(before.includes("## 质量判据"), "既有正文存在");
  assert.ok(after.body.split("## 目标关系")[0].includes("判据"), "非受管正文未被破坏");
});

// ---- 判据 8：兼容 / 留痕 / 并发 ----

test("g-379 判据8：无 relations 字段的既有 goal.md 读取不报错且 round-trip 稳定", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "旧目标", "v-x");
  const file = findGoalFile(root, a);
  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes("\"relations\""), "旧 goal.md 不应含 relations 字段");
  const doc = loadGoal(file);
  assert.equal(doc.meta.relations, undefined);
  assert.deepEqual(validate(root), []);
  // round-trip：连续两次 save 字节完全一致
  saveGoal(file, doc);
  const once = readFileSync(file, "utf8");
  saveGoal(file, loadGoal(file));
  assert.equal(readFileSync(file, "utf8"), once, "round-trip 序列化必须稳定");
});

test("g-379 判据8：关系新增/解除写 events.jsonl，事件名与幂等语义明确", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  addRelation(root, REQ(root, a, "supersedes", b));
  addRelation(root, REQ(root, a, "supersedes", b)); // 幂等：不重复记
  removeRelation(root, REQ(root, a, "supersedes", b));
  removeRelation(root, REQ(root, a, "supersedes", b)); // 幂等：不重复记
  const evs = readEvents(root).filter((e) => e.event.startsWith("goal.relation"));
  assert.deepEqual(evs.map((e) => e.event), ["goal.relation.added", "goal.relation.removed"]);
  assert.equal(evs[0].goal, addr(root, a));
  assert.deepEqual(evs[0].details, { type: "supersedes", target: addr(root, b), conflicted: false });
  assert.equal(evs[1].details.type, "supersedes");
});

test("g-379 判据8：并发 base_relations 不一致 → GraphConflictError（REST 409）", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  const c = makeGoal(root, "C");
  addRelation(root, REQ(root, a, "related", b));
  // 陈旧 base（缺少已存在的条目）→ 冲突
  assert.throws(
    () => addRelation(root, REQ(root, a, "related", c, { base_relations: [] })),
    (e: any) => e instanceof GraphConflictError,
  );
  // 冲突必须零副作用
  assert.deepEqual(loadGoal(findGoalFile(root, a)).meta.relations, [{ type: "related", goal: addr(root, b) }]);
  assert.equal(readEvents(root).filter((e) => e.event === "goal.relation.added").length, 1);
  // 正确的 base → 放行，conflicted=false
  const ok = addRelation(root, REQ(root, a, "related", c, { base_relations: relationsToken(loadGoal(findGoalFile(root, a)).meta) }));
  assert.equal(ok.changed, true);
  assert.equal(ok.conflicted, false);
  // force=true → 以本地内容覆盖并记 conflicted=true（可审计）
  const forced = addRelation(root, REQ(root, a, "extends", b, { base_relations: [], force: true }));
  assert.equal(forced.conflicted, true);
  const forcedEv = readEvents(root).filter((e) => e.event === "goal.relation.added").pop()!;
  assert.equal(forcedEv.details.conflicted, true);
});

// ---- 判据 9：不引入图库 + depends_on 语义回归 ----

test("g-379 判据9：未引入任何图可视化库", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const banned of ["mermaid", "cytoscape", "d3", "d3-dag", "dagre", "elkjs", "vis-network", "react-flow", "reactflow"]) {
    assert.ok(!(banned in deps), `不得引入图可视化库：${banned}`);
  }
  const cardSrc = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/card.js"), "utf8");
  assert.ok(!/mermaid|cytoscape|d3-dag/.test(cardSrc), "客户端不得引入图库");
  assert.ok(/RelationList/.test(cardSrc) && /RelationBadges/.test(cardSrc), "必须用列表/徽标式展示");
});

test("g-379 判据9：depends_on 排序/投影语义不因新关系类型改变（回归钉住）", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A", "v-x");
  const b = makeGoal(root, "B", "v-x");
  const c = makeGoal(root, "C", "v-x");
  addRelation(root, REQ(root, a, "depends_on", b));
  const beforeOrder = boardProjection(root).versions[0].goals.map((g) => g.id);
  const beforeDeps = boardProjection(root).versions[0].goals.map((g) => [...g.depends_on]);
  // 新增一批非 depends_on 关系：不得改变 depends_on 字段与看板顺序
  addRelation(root, REQ(root, a, "supersedes", c));
  addRelation(root, REQ(root, c, "amends", b));
  addRelation(root, REQ(root, b, "related", a));
  const after = boardProjection(root).versions[0].goals;
  assert.deepEqual(after.map((g) => g.id), beforeOrder, "看板目标顺序不得改变");
  assert.deepEqual(after.map((g) => [...g.depends_on]), beforeDeps, "depends_on 字段不得被新关系类型污染");
  // 下游（反向索引）只反映 depends_on
  assert.deepEqual(goalRelationViews(root, b).downstream, [addr(root, a)]);
  assert.deepEqual(goalRelationViews(root, c).downstream, []);
  // depends_on token 仍可作为并发基准（a 自身只有 depends_on + supersedes）
  assert.deepEqual(relationsToken(loadGoal(findGoalFile(root, a)).meta), [
    `depends_on:${addr(root, b)}`, `supersedes:${addr(root, c)}`,
  ].sort());
  assert.deepEqual(relationsToken(loadGoal(findGoalFile(root, b)).meta), [`related:${addr(root, a)}`]);
});

test("g-379 判据9：反向视图「依赖我的下游」小节为派生维护", () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A", "v-x");
  const b = makeGoal(root, "B", "v-x");
  assert.equal(sectionText(loadGoal(findGoalFile(root, b)).body, "依赖我的下游")!.trim(), "（暂无）");
  addRelation(root, REQ(root, a, "depends_on", b));
  const ds = sectionText(loadGoal(findGoalFile(root, b)).body, "依赖我的下游")!;
  assert.match(ds, new RegExp(`- ${addr(root, a)}`), "下游段应由 depends_on 派生");
  removeRelation(root, REQ(root, a, "depends_on", b));
  assert.equal(sectionText(loadGoal(findGoalFile(root, b)).body, "依赖我的下游")!.trim(), "（暂无）");
});

// ---- 附加：deriveGoalRelations 纯函数契约（供宿主/其他目标复用） ----

test("g-379：deriveGoalRelations 在空索引/缺目标时安全降级", () => {
  const empty = deriveGoalRelations(new Map() as any, "g-1");
  assert.deepEqual(empty, { outgoing: [], incoming: [], superseded_by: null, downstream: [] });
});

// ---- REST 端点：/api/dsh-graph/relations（写入 / 解除 / 查询 / 409） ----

function restHarness(root: string) {
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) =>
      name === "webServer" ? webServer : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined,
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, { root });
  return routes;
}

function fakeReq(method: string, url: string) {
  const req: any = { method, url, _listeners: {} as Record<string, (v?: any) => void>, on(ev: string, cb: (v?: any) => void) { req._listeners[ev] = cb; } };
  return req;
}

async function callRoute(routes: Map<string, any>, method: string, path: string, body?: unknown) {
  const bare = path.split("?")[0];
  const handler = routes.get(bare);
  assert.ok(handler, `路由 ${bare} 应已注册`);
  const req = fakeReq(method, path);
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  const p = handler(req, res);
  if (method === "POST") {
    req._listeners.data?.(JSON.stringify(body));
    req._listeners.end?.();
  }
  await p;
  return { code: res._code, body: res._body };
}

test("g-379 REST：POST /relations 写入 + 幂等 + 并发 409 + GET 派生视图", async () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A", "v-r");
  const b = makeGoal(root, "B", "v-r");
  const routes = restHarness(root);
  const path = "/api/dsh-graph/relations";

  const ok = await callRoute(routes, "POST", path, { goal: a, target: b, type: "supersedes" });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.changed, true);
  assert.equal(ok.body.action, "add");

  const again = await callRoute(routes, "POST", path, { goal: a, target: b, type: "supersedes" });
  assert.equal(again.code, 200);
  assert.equal(again.body.changed, false, "重复写入必须幂等");

  const conflict = await callRoute(routes, "POST", path, {
    goal: a, target: b, type: "supersedes", base_relations: [],
  });
  assert.equal(conflict.code, 409, "并发 base_relations 不一致必须 409");
  assert.match(String(conflict.body.error), /并发冲突/);

  const badType = await callRoute(routes, "POST", path, { goal: a, target: b, type: "overrides" });
  assert.equal(badType.code, 400, "未知类型 → 400");

  const missing = await callRoute(routes, "POST", path, { goal: a, target: "g-9999", type: "related" });
  assert.equal(missing.code, 400, "不存在对端 → 400");

  const got = await callRoute(routes, "GET", path + "?goal=" + b);
  assert.equal(got.code, 200);
  assert.equal(got.body.superseded_by, addr(root, a));
  assert.equal(got.body.incoming[0].type, "supersedes");

  const removed = await callRoute(routes, "POST", path, { goal: a, target: b, type: "supersedes", action: "remove" });
  assert.equal(removed.code, 200);
  assert.equal(removed.body.changed, true);
  assert.deepEqual(validate(root), []);
});

test("g-379 REST：关系接口失败不得让看板白屏（boardPayload 仍可用）", async () => {
  const root = tmpRoot();
  const a = makeGoal(root, "A", "v-r");
  const routes = restHarness(root);
  const bad = await callRoute(routes, "POST", "/api/dsh-graph/relations", { goal: a, target: a, type: "supersedes" });
  assert.equal(bad.code, 400);
  const payload = boardPayload(root);
  assert.ok(payload && Array.isArray(payload.versions), "关系写入失败后看板数据仍可投影");
  assert.equal(validate(root).length, 0, "失败请求不得留下半写状态");
});
