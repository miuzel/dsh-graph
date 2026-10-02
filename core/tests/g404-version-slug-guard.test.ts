/**
 * g-404：版本 slug 非法字符/路径逃逸的运行时常驻守卫（createGoal / moveGoal / version-lane 全入口）。
 *
 * 背景（本文件即为复现的自动化固化）：`version` 值曾被直接 `join(root,"versions",slug,...)`，
 * `../x`、`..`、`a/../../x` 会把目标写到 `versions/` 之外（实测 `<board>/x/goals/<id>/goal.md`），
 * `sub/dir`、`..\x`、控制字符会让 `meta.version` 与目录名/落点不一致，而 `validate` 看不见逃逸目录。
 * 既有 `core/schema.ts` 的 `versionSlugSchema` 当时只是文档（零引用、无 pattern）⇒ 运行时无门禁。
 *
 * 本测试为**负向对照**：删掉任一入口的守卫或让 `versionSlugSchema.pattern` 失效，相应断言即红。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  moveGoal,
  findGoalFile,
  loadGoal,
  validate,
  createVersion,
  renameVersion,
  deleteVersion,
  releaseVersion,
  setVersionStatus,
  versionDetail,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { validateSchema, versionSlugSchema, assertVersionSlug, isVersionSlug, VERSION_SLUG_PATTERN } from "../schema.ts";
import { apply } from "../../dist/index.js";

/** 会逃逸/破坏泳道不变式的 slug（每条都对应一个具体失败形态）。 */
const ILLEGAL: Array<{ slug: string; why: string }> = [
  { slug: "../escaped", why: "上跳段逃出 versions/" },
  { slug: "..", why: "纯上跳（落点变成 <board>/goals 或 <board>/version.md）" },
  { slug: "a/../../escaped", why: "多级上跳逃逸" },
  { slug: "sub/dir", why: "含 / 的嵌套段（泳道名与 meta.version 不一致）" },
  { slug: "..\\escaped", why: "反斜杠（Windows 上是分隔符）" },
  { slug: "/escaped-abs", why: "前导绝对路径" },
  { slug: "a//b", why: "空段" },
  { slug: "\u0001bad", why: "控制字符" },
  { slug: "bad\u0000x", why: "NUL" },
];

const LEGAL = ["v0.19.4", "v-001", "V0.19.3", "release.2024-01", "standalone"];

function fakeRequest(method: string) {
  const req: any = { method, url: "", _listeners: {} as Record<string, (v?: any) => void>, on(ev: string, cb: any) { req._listeners[ev] = cb; } };
  return req;
}
function emitBody(req: any, body: unknown) { req._listeners.data?.(JSON.stringify(body)); req._listeners.end?.(); }
function fakeResponse() { const res: any = { _code: 0, _body: null }; res.writeHead = (c: number) => { res._code = c; }; res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; }; return res; }

/** 同时提供工具面（graph_* execute）与 REST 面（真实 route handler）的 harness。 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g404-"));
  init(root);
  const registered: any[] = [];
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (n: string) => (n === "webServer" ? webServer : n === "sandboxPolicy" ? { workspaceRoot: root } : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  const byName = new Map(registered.map((d: any) => [d.name, d]));
  const exec = { agent: undefined, signal: new AbortController().signal };
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = byName.get(name);
    assert.ok(t, `工具 ${name} 已注册`);
    try {
      return { ok: true as const, value: await t.execute(args, exec) };
    } catch (e: any) {
      return { ok: false as const, error: String(e?.message ?? e) };
    }
  };
  const post = async (path: string, body: unknown) => {
    const h = routes.get(path);
    assert.ok(h, `路由 ${path} 已注册`);
    const req = fakeRequest("POST");
    const res = fakeResponse();
    const p = h(req, res);
    emitBody(req, body);
    await p;
    return { code: res._code, body: res._body };
  };
  return { root, call, post };
}

const topLevel = (root: string) => readdirSync(root).sort();
const lanes = (root: string) => (existsSync(join(root, "versions")) ? readdirSync(join(root, "versions")).sort() : []);

// ===== ① 统一规则本身：versionSlugSchema 是真规则（不是文档） =====

test("g-404 规则同源：versionSlugSchema.pattern 参与 validateSchema（旧版仅有 minLength+description）", () => {
  assert.equal(versionSlugSchema.pattern, VERSION_SLUG_PATTERN, "pattern 与导出的单一真源一致");
  const probe = (v: unknown) =>
    validateSchema({ version: v }, { type: "object", properties: { version: versionSlugSchema }, required: ["version"], additionalProperties: false });
  // 旧版唯一约束是 minLength=1：`../x` 曾被判合法 ⇒ 此断言就是负向对照
  assert.equal(probe("../x").valid, false, "schema 必须拒绝路径分隔符（旧版会通过）");
  assert.deepEqual(probe("../x").errors.map((e) => e.code), ["pattern"]);
  assert.equal(probe("v0.19.4").valid, true);
  for (const { slug } of ILLEGAL) assert.equal(probe(slug).valid, false, `schema 拒绝 ${JSON.stringify(slug)}`);
  for (const s of LEGAL) assert.equal(probe(s).valid, true, `schema 放行合法 ${s}`);
  // 非字符串与缺失同样拒绝（REST body 可传 number）
  assert.equal(probe(123).valid, false);
  assert.equal(probe(undefined).valid, false);
  // isVersionSlug / assertVersionSlug 与 schema 同判（诊断用只读判定不得抛错）
  for (const { slug } of ILLEGAL) {
    assert.equal(isVersionSlug(slug), false);
    assert.throws(() => assertVersionSlug(slug), /非法版本 slug/);
  }
  for (const s of LEGAL) {
    assert.equal(isVersionSlug(s), true);
    assert.equal(assertVersionSlug(s), s);
  }
});

test("g-404 错误信息含磁盘实际 slug（控制字符/NUL 转义可见）与泳道路径提示", () => {
  for (const { slug } of ILLEGAL) {
    try {
      assertVersionSlug(slug);
      assert.fail(`应拒绝 ${JSON.stringify(slug)}`);
    } catch (e: any) {
      assert.match(e.message, /非法版本 slug/);
      assert.ok(e.message.includes(JSON.stringify(slug)), `错误信息回显磁盘实际 slug ${JSON.stringify(slug)}`);
      assert.match(e.message, /versions\//, "错误信息给出 will-be 磁盘路径提示");
    }
  }
});

// ===== ② 工具面 / REST 面：create 与 move 全拒绝且零副作用 =====

test("g-404 createGoal：工具面 graph_create_goal 拒绝全部非法 version 且零副作用（含 g-337 高水位未动）", async () => {
  for (const { slug, why } of ILLEGAL) {
    const { root, call } = setup();
    const before = topLevel(root);
    const seqBefore = existsSync(join(root, "next-seq.json")) ? readFileSync(join(root, "next-seq.json"), "utf8") : null;
    const r = await call("graph_create_goal", { title: "t", version: slug });
    assert.equal(r.ok, false, `工具面应拒绝 ${JSON.stringify(slug)}（${why}）`);
    assert.match((r as any).error, /非法版本 slug/);
    assert.deepEqual(topLevel(root), before, `${JSON.stringify(slug)} 拒绝后顶层零改动（无逃逸目录）`);
    const seqAfter = existsSync(join(root, "next-seq.json")) ? readFileSync(join(root, "next-seq.json"), "utf8") : null;
    assert.equal(seqAfter, seqBefore, "拒绝发生在高水位预留之前（g-337 不空耗编号）");
    assert.equal(readEvents(root).filter((e: any) => e.event === "goal.created").length, 0, "未记 goal.created");
  }
  // REST 面同口径
  for (const { slug } of ILLEGAL) {
    const { root, post } = setup();
    const before = topLevel(root);
    const r = await post("/api/dsh-graph/create-goal", { title: "t", version: slug });
    assert.equal(r.code, 400, `REST 面应 400 拒绝 ${JSON.stringify(slug)}`);
    assert.match(String(r.body.error), /非法版本 slug/);
    assert.deepEqual(topLevel(root), before, "REST 拒绝后顶层零改动");
  }
});

test("g-404 moveGoal：工具面 graph_move_goal 拒绝全部非法 version，目标留在原位且无 goal.moved 幽灵事件", async () => {
  for (const { slug, why } of ILLEGAL) {
    const { root, call } = setup();
    const created = await call("graph_create_goal", { title: "m" });
    assert.equal(created.ok, true);
    const goal = (created as any).value.goal as string;
    const fileBefore = findGoalFile(root, goal)!;
    const before = topLevel(root);
    const r = await call("graph_move_goal", { goal, to: "version", version: slug });
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(slug)}（${why}）`);
    assert.match((r as any).error, /非法版本 slug/);
    assert.deepEqual(topLevel(root), before, "拒绝后顶层零改动");
    assert.equal(findGoalFile(root, goal), fileBefore, "目标未被移动");
    assert.equal(loadGoal(fileBefore).meta.version, null, "meta.version 未被改写");
    assert.equal(readEvents(root).filter((e: any) => e.event === "goal.moved").length, 0, "未记幽灵 goal.moved");
  }
  // REST 面同口径（含 NUL 值：旧实现事件先行落盘后 persist 才失败，留下幽灵 goal.moved）
  for (const { slug } of ILLEGAL) {
    const { root, call, post } = setup();
    const created = await call("graph_create_goal", { title: "m" });
    const goal = (created as any).value.goal as string;
    const r = await post("/api/dsh-graph/move-goal", { goal, to: "version", version: slug });
    assert.equal(r.code, 400, `REST 面应 400 拒绝 ${JSON.stringify(slug)}`);
    assert.equal(readEvents(root).filter((e: any) => e.event === "goal.moved").length, 0);
  }
});

// ===== ③ version-lane 各入口统一守卫（不只 create/move-goal） =====

test("g-404 version-lane：create/rename/delete/release/setStatus/detail 六个入口全部守卫", () => {
  for (const { slug } of ILLEGAL) {
    const root = mkdtempSync(join(tmpdir(), "dsh-graph-g404-lane-"));
    init(root);
    createVersion(root, { slug: "v-base", actor: "test" });
    const before = lanes(root);
    // create
    assert.throws(() => createVersion(root, { slug, actor: "test" }), /非法版本 slug/, `createVersion 拒绝 ${JSON.stringify(slug)}`);
    // rename（旧 slug 与新 slug 两处都要拦）
    assert.throws(() => renameVersion(root, { slug, newSlug: "v-new", actor: "test" }), /非法版本 slug/, "renameVersion 拒绝非法旧 slug");
    assert.throws(() => renameVersion(root, { slug: "v-base", newSlug: slug, actor: "test" }), /非法版本 slug/, "renameVersion 拒绝非法新 slug");
    // delete / release / setStatus / detail
    assert.throws(() => deleteVersion(root, { slug, actor: "test" }), /非法版本 slug/);
    assert.throws(() => releaseVersion(root, { slug, actor: "human:gui" }), /非法版本 slug/);
    assert.throws(() => setVersionStatus(root, { slug, status: "active", actor: "test" }), /非法版本 slug/);
    assert.throws(() => versionDetail(root, slug), /非法版本 slug/);
    // 零副作用：泳道集合不变，版本事件只有建立 v-base 那一条
    assert.deepEqual(lanes(root), before, "拒绝后泳道目录零改动");
    const versionEvents = readEvents(root).filter((e: any) => String(e.event).startsWith("version.") && e.event !== "version.created");
    assert.equal(versionEvents.length, 0, "未记任何 version.renamed/deleted/released/status_changed");
    // rename 必须失败在写事件之前（不得留下假 version.renamed 事件）
    assert.equal(readEvents(root).filter((e: any) => e.event === "version.renamed").length, 0);
  }
});

test("g-404 version-lane：createVersion 此前对 `..`/控制字符只是偶然拒绝（错提示）或无门禁", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g404-lane2-"));
  init(root);
  // `..` 旧实现会命中 existsSync(join(root,"versions",".."))=root ⇒ 误报「版本 .. 已存在」
  assert.throws(() => createVersion(root, { slug: "..", actor: "test" }), /非法版本 slug/);
  assert.throws(() => createVersion(root, { slug: "..", actor: "test" }), (e: any) => !/已存在/.test(e.message));
  // 控制字符旧实现完全放行 ⇒ 会建出脏目录
  assert.throws(() => createVersion(root, { slug: "\u0001bad", actor: "test" }), /非法版本 slug/);
  assert.deepEqual(lanes(root), []);
});

// ===== ④ 合法路径不回归 =====

test("g-404 合法 slug 正常路径不回归：工具面/REST 面 create+move 均成功且落点正确", async () => {
  for (const slug of LEGAL) {
    // 工具面
    const { root, call } = setup();
    const c = await call("graph_create_goal", { title: "ok", version: slug });
    assert.equal(c.ok, true, `合法 ${slug} 应成功`);
    const goal = (c as any).value.goal as string;
    if (slug === "standalone") {
      assert.equal(findGoalFile(root, goal), join(root, "goals", goal, "goal.md"), "standalone 落独立泳道");
      assert.equal(loadGoal(findGoalFile(root, goal)!).meta.version, null);
    } else {
      assert.equal(findGoalFile(root, goal), join(root, "versions", slug, "goals", goal, "goal.md"), `${slug} 落版本泳道`);
      assert.equal(loadGoal(findGoalFile(root, goal)!).meta.version, slug);
      assert.deepEqual(validate(root).filter((p) => !/但 version=/.test(p)), [], `${slug} 建后 validate 无问题`);
    }
    // REST 面
    const { root: root2, post } = setup();
    const r = await post("/api/dsh-graph/create-goal", { title: "ok", version: slug });
    assert.equal(r.code, 200, `REST 合法 ${slug} 应 200`);
    // 合法 move（backlog → version）
    const { root: root3, call: call3 } = setup();
    const mk = await call3("graph_create_goal", { title: "mv" });
    const g3 = (mk as any).value.goal as string;
    const target = slug === "standalone" ? "standalone" : "version";
    const mv = await call3("graph_move_goal", { goal: g3, to: target, version: slug });
    assert.equal(mv.ok, true, `合法 move 到 ${slug} 应成功`);
    if (target === "version") {
      assert.equal(findGoalFile(root3, g3), join(root3, "versions", slug, "goals", g3, "goal.md"));
      assert.deepEqual(validate(root3).filter((p) => !/但 version=/.test(p)), []);
    }
  }
});

// ===== ⑤ 旧非法数据：只读诊断，不自动改名/迁移 =====

test("g-404 旧非法数据只读诊断：validate 报出逃逸/嵌套目标，但一个字节都不改", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g404-old-"));
  init(root);
  // 形态 A：逃出 versions/ 的目标目录（旧 bug 的产物）
  mkdirSync(join(root, "escaped-1", "goals", "g-001"), { recursive: true });
  const escapedFile = join(root, "escaped-1", "goals", "g-001", "goal.md");
  const escapedBytes = "---\n{\"id\":\"g-001\",\"title\":\"esc\",\"status\":\"draft\",\"version\":\"../escaped-1\"}\n---\n\n## 质量判据\n\n- x\n";
  writeFileSync(escapedFile, escapedBytes, "utf8");
  // 形态 B：versions/ 下非规范嵌套落点
  mkdirSync(join(root, "versions", "sub", "dir", "goals", "g-002"), { recursive: true });
  writeFileSync(join(root, "versions", "sub", "dir", "goals", "g-002", "goal.md"), "---\n{\"id\":\"g-002\",\"title\":\"nest\",\"status\":\"draft\",\"version\":\"sub/dir\"}\n---\n\n## 质量判据\n\n- x\n", "utf8");
  // 形态 C：合法的历史全局归档位置（versions/archived/<id>/goal.md）不得误报
  mkdirSync(join(root, "versions", "archived", "g-003"), { recursive: true });
  writeFileSync(join(root, "versions", "archived", "g-003", "goal.md"), "---\n{\"id\":\"g-003\",\"title\":\"arch\",\"status\":\"draft\",\"version\":\"v0.1\"}\n---\n\n## 质量判据\n\n- x\n", "utf8");

  const problems = validate(root);
  assert.ok(problems.some((p) => /escaped-1\/goals\/g-001\/goal\.md/.test(p) && /逃出 versions\//.test(p) && /只读诊断/.test(p)), `应报逃逸目标：${problems.join(" | ")}`);
  assert.ok(problems.some((p) => /versions\/sub\/dir\/goals\/g-002\/goal\.md/.test(p) && /非规范版本位置/.test(p)), `应报嵌套落点：${problems.join(" | ")}`);
  assert.ok(!problems.some((p) => /g-003/.test(p)), `合法的 versions/archived/<id>/goal.md 不得误报：${problems.join(" | ")}`);

  // 只读：诊断后磁盘逐字节不变，且未新建/改名任何泳道
  assert.equal(readFileSync(escapedFile, "utf8"), escapedBytes, "逃逸目标文件未被改写");
  assert.deepEqual(lanes(root).sort(), ["archived", "sub"], "未自动改名/迁移/新建泳道");
  assert.equal(readEvents(root).filter((e: any) => String(e.event).startsWith("version.")).length, 0, "诊断不产生任何版本事件");
  // 诊断不阻断合法写入
  assert.doesNotThrow(() => createGoal(root, { title: "ok", version: "v0.19.4-ok", actor: "test" }));
});

test("g-404 非法 version 字段的既有目标被只读报出（validate 不抛错，历史数据不阻断整轮校验）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g404-old2-"));
  init(root);
  const id = createGoal(root, { title: "ok", actor: "test" });
  const file = findGoalFile(root, id)!;
  const before = readFileSync(file, "utf8");
  // 直接伪造历史数据：写一个非法 version 字段（模拟旧 bug 留下的 meta）
  writeFileSync(file, before.replace('"version": null', '"version": "../x"'), "utf8");
  const forged = readFileSync(file, "utf8");
  let problems: string[] = [];
  assert.doesNotThrow(() => { problems = validate(root); }, "validate 不得因历史非法数据抛错");
  assert.ok(problems.some((p) => /非法 slug/.test(p) && /只读诊断/.test(p)), `应报非法 version 字段：${problems.join(" | ")}`);
  assert.equal(readFileSync(file, "utf8"), forged, "只读诊断不改写目标文件");
});
