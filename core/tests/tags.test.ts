import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { init, createGoal, setGoalTags, findGoalFile, loadGoal, boardProjection, GraphConflictError } from "../ops.ts";

function fixture() { const root = mkdtempSync(join(tmpdir(), "dsh-tags-")); init(root); const id = createGoal(root, { title: "tagged", actor: "test" }); return { root, id }; }

test("g-187 tags normalize, persist, project, and legacy missing defaults", async () => {
  const { root, id } = fixture();
  assert.deepEqual(setGoalTags(root, id, { tags: ["  alpha ", "alpha", "中文"], actor: "test" }).new_tags, ["alpha", "中文"]);
  assert.deepEqual(loadGoal(findGoalFile(root, id)).meta.tags, ["alpha", "中文"]);
  assert.deepEqual(boardProjection(root).backlog[0].tags, ["alpha", "中文"]);
  const file = findGoalFile(root, id);
  const legacy = loadGoal(file); delete legacy.meta.tags;
  const { serializeDoc } = await import("../model.ts");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, serializeDoc(legacy), "utf8");
  assert.deepEqual(boardProjection(root).backlog[0].tags, []);
  setGoalTags(root, id, { tags: ["restored"], base_tags: [], actor: "test" });
  assert.deepEqual(boardProjection(root).backlog[0].tags, ["restored"]);
});

test("g-187 tags reject invalid values without changing old file and detect conflicts", () => {
  const { root, id } = fixture(); setGoalTags(root, id, { tags: ["keep"], actor: "test" });
  const file = findGoalFile(root, id); const before = readFileSync(file, "utf8");
  assert.throws(() => setGoalTags(root, id, { tags: ["\u0000"], actor: "test" }), /控制字符/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.throws(() => setGoalTags(root, id, { tags: ["next"], base_tags: [], actor: "test" }), GraphConflictError);
  assert.throws(() => setGoalTags(root, id, { tags: ["next"], base_tags: [], force: "false" as unknown as boolean, actor: "test" }), /force.*布尔/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.throws(() => setGoalTags(root, id, { tags: ["x".repeat(33)], actor: "test" }), /32/);
  assert.throws(() => setGoalTags(root, id, { tags: Array.from({ length: 21 }, (_, i) => String(i)), actor: "test" }), /20/);
});

test("g-187 cross-process CAS: concurrent same-base writes yield one conflict", async () => {
  const { root, id } = fixture();
  const barrier = join(root, "barrier");
  const script = `import { writeFileSync, existsSync } from "node:fs"; import { setGoalTags } from "./core/ops.ts"; const [root,id,barrier,tag] = process.argv.slice(1); writeFileSync(barrier+tag, "ready"); while (!existsSync(barrier+"0") || !existsSync(barrier+"1")) {} try { setGoalTags(root,id,{tags:[tag],base_tags:[],actor:"child"}); process.stdout.write("ok") } catch(e) { if (e?.name === "GraphConflictError" || /已被其他人修改/.test(String(e?.message))) process.stdout.write("conflict"); else { console.error(e); process.exit(2); } }`;
  const run = (tag: string) => new Promise<string>((resolve, reject) => { const p = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, root, id, barrier, tag], { cwd: process.cwd() }); let out = ""; let err = ""; p.stdout.on("data", (d) => out += d); p.stderr.on("data", (d) => err += d); p.on("error", reject); p.on("close", (c) => c === 0 ? resolve(out) : reject(new Error(`child exit ${c}: ${out} ${err}`))); });
  const results = await Promise.all([run("0"), run("1")]);
  assert.equal(results.filter((x) => x === "ok").length, 1); assert.equal(results.filter((x) => x === "conflict").length, 1);
  const finalTags = boardProjection(root).backlog[0].tags; assert.equal(finalTags.length, 1); assert.ok(["0", "1"].includes(finalTags[0]));
});

test("g-187 event append failure rolls back goal file", () => {
  const { root, id } = fixture(); const file = findGoalFile(root, id); const before = readFileSync(file, "utf8");
  rmSync(join(root, "events.jsonl")); mkdirSync(join(root, "events.jsonl"));
  assert.throws(() => setGoalTags(root, id, { tags: ["must-not-stick"], actor: "test" }));
  assert.equal(readFileSync(file, "utf8"), before);
  rmSync(join(root, "events.jsonl"), { recursive: true, force: true });
});

test("g-187 lock timeout never reclaims another owner's lock", () => {
  const { root, id } = fixture(); const file = findGoalFile(root, id); const lock = `${file}.tags.lock`;
  mkdirSync(lock); writeFileSync(join(lock, "owner"), `${process.pid}:00000000-0000-4000-8000-000000000000`, "utf8");
  assert.throws(() => setGoalTags(root, id, { tags: ["x"], base_tags: [], actor: "test" }), /锁定/);
  assert.equal(readFileSync(join(lock, "owner"), "utf8"), `${process.pid}:00000000-0000-4000-8000-000000000000`);
  rmSync(lock, { recursive: true, force: true });
});
