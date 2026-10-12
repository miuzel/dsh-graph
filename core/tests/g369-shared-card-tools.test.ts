/** g-369：共享卡挂载 / 解除 / 列举三个工具面暴露的语义测试。
 *
 * 真源纪律（不复制实现）：
 *  - 工具真源 = `apply(dist/index.js)` **实际注册**的 tool def（description 取自 server-i18n，逐字比对字典）；
 *  - 语义真源 = 真实 core ops（addSharedCardRef / removeSharedCardRef / referenceCount / sharedCards / resolveCard）；
 *  - 计数与帮助目录的「工具集合 = schema」守卫在 g342/g347/plugin/root/guide-injection，本套件不重复。
 *
 * human:* 分支说明：工具路径的 actor 恒为 `actorOf` 产出的 `agent:<id>`（无 caller 可传 human:*），
 * 故 human 放行分支打在 core 授权函数 `authorizeSharedCardLink` 上，并附「工具路径不可达」的反向断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  createSharedCard,
  addSharedCardRef,
  referenceCount,
  sharedCards,
  loadGoal,
  findGoalFile,
  resolveCard,
  authorizeSharedCardLink,
  GraphError,
  MODULE_TOOL_NAMES,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { SERVER_I18N } from "../../dist/lib/server-i18n.js";
import { apply } from "../../dist/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const NEW_TOOLS = ["graph_attach_shared_card", "graph_detach_shared_card", "graph_list_shared_cards"] as const;
const AUTH_REJECT = /无权挂载或解除共享卡引用/;

type Exec = { id: string; session?: { id: string } };

function setup(opts: { supervisorSession?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g369-"));
  init(root);
  if (opts.supervisorSession) {
    writeFileSync(join(root, "project.yaml"), `supervisor:\n  session: ${opts.supervisorSession}\n`, "utf8");
  }
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
  const call = async (name: string, args: Record<string, unknown>, agent?: Exec) =>
    await byName.get(name)!.execute(args, { agent, signal: new AbortController().signal });
  const as = (id: string): Exec => ({ id, session: { id } });
  return { root, registered, byName, call, as };
}

function goalCardIds(root: string, goalId: string): string[] {
  const doc = loadGoal(findGoalFile(root, goalId));
  return Array.isArray(doc.meta.context_cards) ? [...doc.meta.context_cards] : [];
}

// ===== 判据 1：注册 + 描述真源（server-i18n）+ 帮助条目 =====

test("g-369 判据1：三工具已注册，description 逐字取自 server-i18n（无字面量键名外泄）", () => {
  const { registered } = setup();
  const names = registered.map((d: any) => d.name);
  for (const n of NEW_TOOLS) assert.ok(names.includes(n), `${n} 未注册`);
  assert.equal(new Set(names).size, names.length, "工具名重复");
  for (const n of NEW_TOOLS) {
    const def = registered.find((d: any) => d.name === n)!;
    const key = `tool.${n}`;
    const dict = SERVER_I18N as unknown as Record<"zh" | "en", Record<string, string>>;
    const zh = dict.zh[key];
    const en = dict.en[key];
    assert.ok(zh, `SERVER_I18N.zh 缺 ${key}`);
    assert.ok(en, `SERVER_I18N.en 缺 ${key}`);
    assert.doesNotMatch(en, /[\u3400-\u9fff]/, `${key} 的 en 含 CJK`);
    // 运行时 description 由 sT() 覆盖 t.def.description ⇒ 必须等于字典值，且不能落回字面量键名
    assert.ok(
      [zh, en].includes(def.description),
      `${n} 的 description 未取自 server-i18n（实际 ${JSON.stringify(def.description)}）`,
    );
    assert.notEqual(def.description, key, `${n} 的 description 泄漏字面量键名`);
  }
  // 参数面（真源 = schema）：attach/detach 必填 (goal, card)，list 无参
  const paramsOf = (n: string) => registered.find((d: any) => d.name === n)!.parameters;
  for (const n of ["graph_attach_shared_card", "graph_detach_shared_card"] as const) {
    assert.deepEqual(paramsOf(n).required, ["goal", "card"], `${n} 必填参数面`);
    assert.deepEqual(Object.keys(paramsOf(n).properties), ["goal", "card"], `${n} 参数面`);
  }
  assert.deepEqual(Object.keys(paramsOf("graph_list_shared_cards").properties), [], "graph_list_shared_cards 无参");
  // 帮助资产（zh/en 成对）必须含三条新条目且形态合规（`- graph_xxx(`）
  // 帮助资产（zh/en 成对）（g-495 改判）：help 已不再逐条列工具（改判为功能模块清单 + 当前
  // 开关状态），故原「必须含三条 `- graph_xxx(` 条目」改判为「必须声明承载这三条工具的
  // **模块**（shared_cards）」—— agent 侧仍能据此知道该能力受哪个开关管辖。
  // 工具级真源改由上面的 schema/description 断言 + harness 注入承担。
  for (const lang of ["zh", "en"] as const) {
    const text = readFileSync(join(repoRoot, "dsh-graph-host", "prompts", `help.${lang}.md`), "utf8");
    assert.match(text, /\{shared_cards\}/, `help.${lang}.md 缺 shared_cards 模块行（三工具无归属模块）`);
    // 负向对照（内存变异）：模块占位被改坏时判据必红。
    assert.doesNotMatch(text.replace("{shared_cards}", "{shared_card}"), /\{shared_cards\}/, "模块占位改坏时判据必须变红");
  }
  // 三条工具确实归属 shared_cards 模块（真源 = 引擎模块注册表，非文案）。
  for (const n of NEW_TOOLS) {
    assert.ok(MODULE_TOOL_NAMES.shared_cards.includes(n), `${n} 必须归属 shared_cards 模块`);
  }
});

// ===== 判据 3：attach 成功 + 幂等 =====

test("g-369 判据3：主管身份挂载成功（refCount 1→2、actor=supervisor:<sid>）且重复挂载幂等", async () => {
  const { root, call, as } = setup({ supervisorSession: "sess-sup" });
  const sup = as("sess-sup");
  const { goal: goalA } = await call("graph_create_goal", { title: "持有卡的目标", version: "v-t" }, sup);
  const { card } = await call("graph_add_card", { goal: goalA, title: "共享卡" }, sup);
  assert.equal(referenceCount(root, card), 1, "建卡即挂到原目标（refCount=1）");
  // 目标 B 由另一身份创建 ⇒ B 的挂载只能靠 supervisor 分支放行（owner 不匹配）
  const { goal: goalB } = await call("graph_create_goal", { title: "复用目标", version: "v-t" }, as("other"));
  assert.equal(loadGoal(findGoalFile(root, goalB)).meta.created_by, "agent:other");

  const r = await call("graph_attach_shared_card", { goal: goalB, card }, sup);
  assert.deepEqual(r, { ok: true, card, refCount: 2 }, "返回 refCount 反映挂载后引用数");
  assert.ok(goalCardIds(root, goalB).includes(card), "目标 B 的 context_cards 含该卡");
  assert.equal(referenceCount(root, card), 2);
  const evs = readEvents(root).filter((e: any) => e.event === "card.shared_referenced" && e.goal === goalB);
  assert.equal(evs.length, 1, "恰记一次 card.shared_referenced");
  assert.equal(evs[0].actor, "supervisor:sess-sup", "事件 actor 为映射后的主管身份");
  assert.equal(evs[0].details.card, card);

  // 幂等：不重复 push、不重复记事件、refCount 不变
  const eventsAfterFirst = readEvents(root).length;
  const r2 = await call("graph_attach_shared_card", { goal: goalB, card }, sup);
  assert.equal(r2.refCount, 2, "重复挂载 refCount 不变");
  assert.equal(
    goalCardIds(root, goalB).filter((id) => id === card).length,
    1,
    "重复挂载不重复 push context_cards",
  );
  assert.equal(readEvents(root).length, eventsAfterFirst, "重复挂载不重复记事件");
});

// ===== 判据 4：detach 语义 + collecting 拒绝 =====

test("g-369 判据4：detach 移除引用、refCount 递减、零引用后卡仍在池中；collecting 卡被拒", async () => {
  const { root, call, as } = setup({ supervisorSession: "sess-sup" });
  const sup = as("sess-sup");
  const { goal } = await call("graph_create_goal", { title: "目标", version: "v-t" }, sup);
  const { card } = await call("graph_add_card", { goal, title: "共享卡" }, sup);
  const cardFile = join(root, "shared-cards", `${card}.md`);

  const r = await call("graph_detach_shared_card", { goal, card }, sup);
  assert.deepEqual(r, { ok: true, card, refCount: 0 });
  assert.ok(!goalCardIds(root, goal).includes(card), "解除后 context_cards 不含该卡");
  assert.equal(referenceCount(root, card), 0);
  assert.ok(existsSync(cardFile), "零引用后卡本体仍留在共享池");
  assert.equal(sharedCards(root).length, 1, "共享池仍列出该卡");
  const unref = readEvents(root).filter((e: any) => e.event === "card.shared_unreferenced" && e.details?.card === card);
  assert.equal(unref.length, 1, "恰记一次 card.shared_unreferenced");

  // collecting 拒绝：先重新挂载，再绑定收集子代理
  await call("graph_attach_shared_card", { goal, card }, sup);
  await call("graph_bind_collect_card", { goal, card, child_id: "child-collect" }, sup);
  assert.equal(loadGoal(cardFile).meta.status, "collecting");
  const eventsBefore = readEvents(root).length;
  const refsBefore = goalCardIds(root, goal);
  await assert.rejects(
    () => call("graph_detach_shared_card", { goal, card }, sup),
    (e: unknown) => e instanceof Error && /正在收集中/.test(e.message),
    "collecting 卡片必须拒绝解除引用",
  );
  assert.equal(referenceCount(root, card), 1, "拒绝后引用计数不变");
  assert.deepEqual(goalCardIds(root, goal), refsBefore, "拒绝后 context_cards 不变");
  assert.equal(readEvents(root).length, eventsBefore, "拒绝后事件流零新增");
});

// ===== 判据 5：授权与零副作用 =====

test("g-369 判据5：executor 身份调 attach/detach 被拒且零副作用；creator/human/supervisor 放行", async () => {
  const { root, call, as } = setup({ supervisorSession: "sess-sup" });
  const sup = as("sess-sup");
  const executor = as("child-1");
  const { goal } = await call("graph_create_goal", { title: "他人目标", version: "v-t" }, as("other"));
  const card = createSharedCard(root, { title: "池卡", actor: "test" });
  const goalFile = findGoalFile(root, goal);

  // ① executor attach 被拒（此时该卡未被目标引用 ⇒ 若鉴权失效会真的产生副作用）
  const goalBefore = readFileSync(goalFile, "utf8");
  const eventsBefore = readEvents(root).length;
  await assert.rejects(
    () => call("graph_attach_shared_card", { goal, card }, executor),
    (e: unknown) => e instanceof Error && AUTH_REJECT.test(e.message),
  );
  assert.equal(readFileSync(goalFile, "utf8"), goalBefore, "拒绝后目标 frontmatter 逐字节不变");
  assert.equal(readEvents(root).length, eventsBefore, "拒绝后事件流零新增");
  assert.equal(referenceCount(root, card), 0, "拒绝后引用计数不变");
  assert.ok(!goalCardIds(root, goal).includes(card), "拒绝后未被挂载");

  // ② creator 放行（created_by 精确匹配）
  const rCreator = await call("graph_attach_shared_card", { goal, card }, as("other"));
  assert.equal(rCreator.refCount, 1, "creator 挂载成功");

  // ③ executor detach 被拒（目标确已引用该卡 ⇒ 证明拒绝来自鉴权而非「未引用」）
  const goalMid = readFileSync(goalFile, "utf8");
  const eventsMid = readEvents(root).length;
  await assert.rejects(
    () => call("graph_detach_shared_card", { goal, card }, executor),
    (e: unknown) => e instanceof Error && AUTH_REJECT.test(e.message),
  );
  assert.equal(readFileSync(goalFile, "utf8"), goalMid, "拒绝后 frontmatter 逐字节不变");
  assert.equal(readEvents(root).length, eventsMid, "拒绝后事件流零新增");
  assert.equal(referenceCount(root, card), 1, "拒绝后引用计数不变");

  // ④ 工具路径不可达 human:*：即使 caller 自称 human:gui，actorOf 产出的仍是 agent:human:gui ⇒ 拒绝
  await assert.rejects(
    () => call("graph_detach_shared_card", { goal, card }, as("human:gui")),
    (e: unknown) => e instanceof Error && AUTH_REJECT.test(e.message),
    "工具路径无法产生 human:* 身份，故必须被拒",
  );
  assert.equal(referenceCount(root, card), 1);

  // ⑤ supervisor:<匹配 session> 放行（对非本目标的卡）
  const otherCard = createSharedCard(root, { title: "第二张池卡", actor: "test" });
  const rSup = await call("graph_attach_shared_card", { goal, card: otherCard }, sup);
  assert.equal(rSup.refCount, 1, "主管身份放行");
});

test("g-369 判据5：core 授权函数逐条规则（human 分支的测法：打在该函数上，工具路径不可达）", () => {
  const { root } = setup({ supervisorSession: "sess-sup" });
  // 放行：owner（精确 / 无前缀 agent: 形式）、human:*、匹配的 supervisor:*
  assert.doesNotThrow(() => authorizeSharedCardLink(root, "agent:other", "agent:other"));
  assert.doesNotThrow(() => authorizeSharedCardLink(root, "agent:creator", "creator"));
  assert.doesNotThrow(() => authorizeSharedCardLink(root, "human:gui", "agent:other"));
  assert.doesNotThrow(() => authorizeSharedCardLink(root, "supervisor:sess-sup", "agent:other"));
  // 拒绝：执行子代理（裸 child_id / agent:<child>）、不匹配的 supervisor、空 actor
  for (const actor of ["child-1", "agent:child-1", "supervisor:nope", "agent:dsh", ""]) {
    assert.throws(
      () => authorizeSharedCardLink(root, actor, "agent:other"),
      (e: unknown) => e instanceof Error && AUTH_REJECT.test(e.message),
      `${JSON.stringify(actor)} 必须被拒`,
    );
  }
  // 诊断保真（复核要求）：supervisor:<错误 session> 被拒时文案必须带**底层原因**，
  // 不得压成通用「无权」——主管会话换号是老问题，丢失该诊断会让人白跑。
  assert.throws(
    () => authorizeSharedCardLink(root, "supervisor:nope", "agent:other"),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, AUTH_REJECT);
      assert.match(e.message, /supervisor\.session/, "拒绝文案必须保留底层原因（supervisor.session 不匹配）");
      return true;
    },
  );
});

// ===== 判据 6：list =====

test("g-369 判据6：list 返回 { cards:[{id,title,status,refs}] }（多目标列全、不泄漏正文/绝对路径），空池为空数组", async () => {
  const { root, call } = setup();
  assert.deepEqual(await call("graph_list_shared_cards", {}), { cards: [] }, "空池返回空数组");

  const c1 = createSharedCard(root, { title: "卡一", actor: "t" });
  const c2 = createSharedCard(root, { title: "卡二", actor: "t" });
  const g1 = createGoal(root, { title: "G1", version: "v-t", actor: "agent:x" });
  const g2 = createGoal(root, { title: "G2", version: "v-t", actor: "agent:y" });
  addSharedCardRef(root, g1, c1, "t");
  addSharedCardRef(root, g2, c1, "t");

  const out = await call("graph_list_shared_cards", {});
  assert.equal(out.cards.length, 2, "池内两张卡");
  const item = out.cards.find((c: any) => c.id === c1);
  assert.deepEqual(Object.keys(item).sort(), ["id", "refs", "status", "title"], "只投影 id/title/status/refs");
  assert.equal(item.title, "卡一");
  assert.equal(item.status, "empty");
  assert.deepEqual([...item.refs].sort(), [g1, g2].sort(), "多目标引用时列出全部 goal id");
  assert.equal(out.cards.find((c: any) => c.id === c2).refs.length, 0, "零引用卡 refs 为空数组");
  // 不泄漏：sharedCards() 每项含 content（全文）、attachments 与 cardFile（绝对路径）
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes(root), "返回值不得含绝对路径");
  assert.ok(!/"cardFile"|"content"|"attachments"/.test(serialized), "返回值不得含 content/cardFile/attachments");
});

// ===== 判据 7：resolveCard 文案指向工具 =====

test("g-369 判据7：resolveCard 拒绝文案不再点名 addSharedCardRef，改为指向 graph_attach_shared_card", () => {
  const { root } = setup();
  const card = createSharedCard(root, { title: "未挂载", actor: "t" });
  const goal = createGoal(root, { title: "G", version: "v-t", actor: "agent:x" });
  assert.throws(
    () => resolveCard(root, goal, card),
    (e: unknown) => {
      assert.ok(e instanceof GraphError, "应抛 GraphError");
      assert.doesNotMatch((e as Error).message, /addSharedCardRef/, "不得再点名核心函数名");
      assert.match((e as Error).message, /graph_attach_shared_card/, "应指向工具名");
      return true;
    },
  );
  // 挂载后文案路径消失（同一守卫不再触发）
  addSharedCardRef(root, goal, card, "t");
  assert.equal(resolveCard(root, goal, card).scope, "shared");
});
