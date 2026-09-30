/** g-380：关系标记工具（`graph_set_relation`）的语义、幂等、拒绝面与单一真源守卫。
 *
 * 真源纪律（不复制实现）：
 *  - 工具真源 = `apply(dist/index.js)` **实际注册**的 tool def（description 取自 server-i18n）；
 *  - 语义真源 = g-379 既有 core ops（addRelation/removeRelation/goalRelationViews/validate）；
 *  - 「工具集合 = schema」的计数与文档面守卫在 g342/g347/g371/plugin/root/guide-injection，本套件不重复。
 *
 * 判据映射：1（唯一新增工具 + 描述真源）·2（闭集/路由/自关联/不存在对端/环/幂等/事件/中文文案）·
 *          4（单一真源、无第二套关系写入与第二套环检测）·5（负向对照：拒绝后零残留）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  loadGoal,
  findGoalFile,
  archiveGoal,
  deleteGoal,
  validate,
  goalRelationViews,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { SERVER_I18N } from "../../dist/lib/server-i18n.js";
import { apply } from "../../dist/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const TOOL = "graph_set_relation";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g380-"));
  init(root);
  const registered: any[] = [];
  const ctx = {
    get: () => undefined,
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (def: any) => { registered.push(def); return () => {}; },
      get: () => ({}),
    },
  };
  apply(ctx as any, { root });
  const byName = new Map<string, any>(registered.map((d: any) => [d.name, d]));
  const call = async (args: Record<string, unknown>) =>
    await byName.get(TOOL)!.execute(args, { agent: { id: "agent-supervisor" }, signal: new AbortController().signal });
  return { root, registered, byName, call };
}

const makeGoal = (root: string, title: string) => createGoal(root, { title, actor: "test" });
const goalText = (root: string, id: string) => readFileSync(findGoalFile(root, id), "utf8");
const relEvents = (root: string) =>
  readEvents(root).filter((e) => e.event === "goal.relation.added" || e.event === "goal.relation.removed");

/** 断言一次调用抛 GraphError 且文案匹配（中文可操作文案）。
 *  注意：host 工具抛的是 `dist/core/machine.js` 的 GraphError，与 `core/machine.ts` 非同一声明身份，
 *  故按 `constructor.name` 判定（跨 .ts/.js 双份实现的既有事实），不写 `instanceof`。 */
async function rejects(fn: () => Promise<unknown>, re: RegExp): Promise<string> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, `应被拒绝（期望文案 ${re}）但调用成功`);
  assert.equal((caught as Error).constructor.name, "GraphError", `应抛 GraphError，实际 ${String(caught)}`);
  assert.match(String((caught as Error).message), re);
  return String((caught as Error).message);
}

// =====================================================================================
// 判据 1：唯一新增工具 + 描述真源（server-i18n，en 零 CJK）
// =====================================================================================

test("g-380 判据1：graph_set_relation 已注册且 description 取自 server-i18n（en 零 CJK）", () => {
  const { registered } = setup();
  const names = registered.map((d: any) => d.name);
  assert.ok(names.includes(TOOL), `${TOOL} 未注册`);
  assert.equal(new Set(names).size, names.length, "工具名重复");
  const def = registered.find((d: any) => d.name === TOOL)!;
  const key = `tool.${TOOL}`;
  const dict = SERVER_I18N as unknown as Record<"zh" | "en", Record<string, string>>;
  assert.ok(dict.zh[key] && dict.en[key], `SERVER_I18N 缺 ${key}`);
  assert.doesNotMatch(dict.en[key], /[\u3400-\u9fff]/, `${key} 的 en 含 CJK`);
  assert.equal(def.description, dict.zh[key], "运行时 description 必须取自 server-i18n");
  // 参数面：goal（源）/ action / type / target（对端）；全部必填 ⇒ 无模糊默认
  assert.deepEqual(Object.keys(def.parameters.properties).sort(), ["action", "goal", "target", "type"]);
  assert.deepEqual([...def.parameters.required].sort(), ["action", "goal", "target", "type"]);
});

// =====================================================================================
// 判据 2：add / remove 的写入语义、事件与派生视图
// =====================================================================================

test("g-380 判据2：add 写 meta.relations（单一真源）+ 事件 goal.relation.added，派生视图即时反映", async () => {
  const { root, call } = setup();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  const r = await call({ goal: a, action: "add", type: "supersedes", target: b });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.goal, a);
  assert.equal(r.target, b);
  assert.equal(r.type, "supersedes");

  const meta = loadGoal(findGoalFile(root, a)).meta;
  assert.deepEqual(meta.relations, [{ type: "supersedes", goal: b }], "关系只落在 meta.relations");
  assert.deepEqual(meta.depends_on ?? [], [], "不得顺手写 depends_on（非双真相）");
  // 派生镜像（入向 supersedes 唯一确定）由引擎维护，客户端/工具都不双写
  assert.equal(loadGoal(findGoalFile(root, b)).meta.superseded_by, a);

  const ev = relEvents(root);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event, "goal.relation.added");
  assert.equal(ev[0].goal, a);
  assert.deepEqual(ev[0].details, { type: "supersedes", target: b, conflicted: false });
  assert.equal(ev[0].actor, "agent:agent-supervisor");

  const out = goalRelationViews(root, a).outgoing;
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "supersedes");
  assert.equal(out[0].goal, b);
  const inc = goalRelationViews(root, b).incoming;
  assert.equal(inc[0].goal, a);
  assert.deepEqual(validate(root), [], "写入后全量不变式必须干净（不旁路 validate）");
});

test("g-380 判据2：remove 解除关系 + 事件 goal.relation.removed；删除的是唯一真源条目", async () => {
  const { root, call } = setup();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  await call({ goal: a, action: "add", type: "amends", target: b });
  const r = await call({ goal: a, action: "remove", type: "amends", target: b });
  assert.equal(r.changed, true);
  const meta = loadGoal(findGoalFile(root, a)).meta;
  assert.equal(meta.relations, undefined, "解除最后一条后 relations 字段被清空（不留空壳）");
  const ev = relEvents(root);
  assert.equal(ev.length, 2);
  assert.equal(ev[1].event, "goal.relation.removed");
  assert.equal(goalRelationViews(root, a).outgoing.length, 0);
  assert.deepEqual(validate(root), []);
});

test("g-380 判据2：add/remove 幂等——重复调用 changed=false、不写事件、文件逐字节不变", async () => {
  const { root, call } = setup();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  await call({ goal: a, action: "add", type: "related", target: b });
  const before = goalText(root, a);
  const eventsBefore = relEvents(root).length;
  const again = await call({ goal: a, action: "add", type: "related", target: b });
  assert.equal(again.changed, false, "重复 add 必须 no-op");
  assert.equal(goalText(root, a), before, "重复 add 不得改字节");
  assert.equal(relEvents(root).length, eventsBefore, "重复 add 不得重复写事件");

  await call({ goal: a, action: "remove", type: "related", target: b });
  const afterRemove = goalText(root, a);
  const eventsAfterRemove = relEvents(root).length;
  const removeAgain = await call({ goal: a, action: "remove", type: "related", target: b });
  assert.equal(removeAgain.changed, false, "重复 remove 必须 no-op");
  assert.equal(goalText(root, a), afterRemove, "重复 remove 不得改字节");
  assert.equal(relEvents(root).length, eventsAfterRemove, "重复 remove 不得重复写事件");
});

// =====================================================================================
// 判据 2/5：拒绝面（非法入参、depends_on 路由、自关联、不存在/已删除对端）+ 零残留
// =====================================================================================

test("g-380 判据2：action/type 非法被拒（中文可操作文案，零残留）", async () => {
  const { root, call } = setup();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  const before = goalText(root, a);
  const eventsBefore = relEvents(root).length;
  await rejects(() => call({ goal: a, action: "link", type: "related", target: b }), /action 非法.*add.*remove/);
  await rejects(() => call({ goal: a, action: "add", type: "replaces", target: b }), /type 非法.*supersedes \/ amends \/ extends \/ related/);
  assert.equal(goalText(root, a), before, "拒绝后文件逐字节不变");
  assert.equal(relEvents(root).length, eventsBefore, "拒绝后零事件");
  assert.equal(loadGoal(findGoalFile(root, a)).meta.relations, undefined, "拒绝后零半写残留");
});

test("g-380 判据2：depends_on 不得写进 relations——拒绝并指向 meta.depends_on（add/remove 都拒）", async () => {
  const { root, call } = setup();
  const a = makeGoal(root, "A");
  const b = makeGoal(root, "B");
  const msgAdd = await rejects(
    () => call({ goal: a, action: "add", type: "depends_on", target: b }),
    /不得承载 depends_on.*meta\.depends_on/,
  );
  assert.match(msgAdd, /meta\.depends_on/, "文案必须指向权威字段");
  await rejects(() => call({ goal: a, action: "remove", type: "depends_on", target: b }), /meta\.depends_on/);
  const meta = loadGoal(findGoalFile(root, a)).meta;
  assert.equal(meta.relations, undefined, "depends_on 绝不写进 relations");
  assert.deepEqual(meta.depends_on ?? [], [], "本工具也不得替写 meta.depends_on（无静默路由）");
  assert.equal(relEvents(root).length, 0);
});

test("g-380 判据2：拒自关联 / 拒不存在对端 / 拒已删除对端（零残留）", async () => {
  const { root, call } = setup();
  const a = makeGoal(root, "A");
  const before = goalText(root, a);
  await rejects(() => call({ goal: a, action: "add", type: "supersedes", target: a }), /自关联被拒/);
  await rejects(() => call({ goal: a, action: "add", type: "supersedes", target: "g-not-exist" }), /不存在|找不到|no such/i);
  const gone = makeGoal(root, "GONE");
  archiveGoal(root, gone, { actor: "test" });
  deleteGoal(root, gone, { actor: "test" });
  await rejects(() => call({ goal: a, action: "add", type: "supersedes", target: gone }), /不存在|找不到|no such/i);
  assert.equal(goalText(root, a), before, "三种拒绝都不改字节");
  assert.equal(relEvents(root).length, 0, "三种拒绝都零事件");
});

// =====================================================================================
// 判据 2：替代环（复用唯一 DFS、报错含环路径）
// =====================================================================================

test("g-380 判据2：会形成替代环的标记被拒，报错含完整环路径；拒绝零残留", async () => {
  const { root, call } = setup();
  const a = makeGoal(root, "GA");
  const b = makeGoal(root, "GB");
  await call({ goal: a, action: "add", type: "supersedes", target: b });
  const beforeA = goalText(root, a);
  const beforeB = goalText(root, b);
  const eventsBefore = relEvents(root).length;
  const msg = await rejects(
    () => call({ goal: b, action: "add", type: "supersedes", target: a }),
    /关系替代环/,
  );
  assert.match(msg, new RegExp(`${a} → ${b} → ${a}`), "环路径必须含完整节点链");
  assert.match(msg, /已拒绝写入/, "文案须说明已拒绝且可操作");
  assert.equal(goalText(root, b), beforeB, "拒绝后对端文件不变");
  assert.equal(goalText(root, a), beforeA, "拒绝后源文件不变");
  assert.equal(relEvents(root).length, eventsBefore, "拒绝后零新事件");
  // 反向自证：该环若真被写入，validate 会报同一问题 —— 证明工具与 validate 同一口径
  assert.deepEqual(validate(root), [], "拒绝后图仍无环");
});

test("g-380 判据2/对照：amends 环同样被拒；extends/related 互引放行（不误报）", async () => {
  const { root, call } = setup();
  const a = makeGoal(root, "GA");
  const b = makeGoal(root, "GB");
  await call({ goal: a, action: "add", type: "amends", target: b });
  await rejects(() => call({ goal: b, action: "add", type: "amends", target: a }), /关系替代环/);

  const c = makeGoal(root, "GC");
  const d = makeGoal(root, "GD");
  await call({ goal: c, action: "add", type: "extends", target: d });
  await call({ goal: d, action: "add", type: "extends", target: c });
  await call({ goal: c, action: "add", type: "related", target: d });
  await call({ goal: d, action: "add", type: "related", target: c });
  assert.deepEqual(validate(root), [], "extends/related 互引是合法图");
});

// =====================================================================================
// 判据 4：单一真源 / 无第二套写入 / 无第二套环检测（结构性负向守卫）
// =====================================================================================

test("g-380 判据4：工具复用既有 addRelation/removeRelation，host 侧无第二套关系写入实现", () => {
  const host = readFileSync(join(repoRoot, "dsh-graph-host", "index.js"), "utf8");
  assert.match(host, /const mutate = action === "add" \? addRelation : removeRelation/, "必须分派到既有 ops");
  assert.match(host, /relationCycleProblem\(/, "环探测必须调用 core 的共享实现");
  // 第二套写入的特征：host 侧直接改写 frontmatter 关系字段 / 自己拼 relations 条目
  assert.doesNotMatch(host, /meta\.relations\s*=/, "host 不得直接写 meta.relations");
  assert.doesNotMatch(host, /\.relations\.push\(/, "host 不得自行拼装关系条目");
  assert.doesNotMatch(host, /goal\.relation\.(added|removed)/, "事件由 core ops 写，host 不得自己 appendEvent");
});

test("g-380 判据4：环检测仍只有一套 DFS（不新增第二套实现）", () => {
  const ops = readFileSync(join(repoRoot, "core", "ops.ts"), "utf8");
  assert.equal(ops.split("stack.indexOf(dep)").length - 1, 1, "环路径拼接必须仍只有一处");
  assert.ok(/function dfsCycleProblems\(/.test(ops), "共享 DFS 必须存在");
  assert.ok(
    /return dfsCycleProblems\(edges, "关系替代"\)/.test(ops),
    "关系工具写前探测必须复用同一 DFS（关系替代 label）",
  );
});

test("g-380 判据4：工具写入路径不旁路 validate —— 写入后不变式干净，且派生视图与 frontmatter 一致", async () => {
  const { root, call } = setup();
  const a = makeGoal(root, "GA");
  const b = makeGoal(root, "GB");
  await call({ goal: a, action: "add", type: "supersedes", target: b });
  assert.deepEqual(validate(root), []);
  // 受管小节（目标关系）由 core 派生维护，工具不手写
  const text = goalText(root, a);
  assert.match(text, /## 目标关系/);
  assert.match(text, new RegExp(`supersedes.*${b}`), "派生小节反映唯一真源");
});
