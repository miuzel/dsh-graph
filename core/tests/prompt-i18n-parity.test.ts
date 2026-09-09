import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SERVER_I18N, assertServerI18nParity } from "../../dsh-graph-host/lib/server-i18n.js";

const root = join(import.meta.dirname, "../../dsh-graph-host");
const prompts = join(root, "prompts");
const placeholders = (text: string) => [...text.matchAll(/\{\{?([A-Za-z0-9_.-]+)\}?\}/g)].map((m) => m[1]).sort();
const technicalTokens = (text: string) => [...text.matchAll(/(?:graph_[A-Za-z0-9_]+|@att\/[A-Za-z0-9_./<>-]+|worktree=false)/g)].map((m) => m[0]).sort();

test("prompt markdown zh/en assets keep heading and placeholder parity", () => {
  const names = readdirSync(prompts).filter((name) => name.endsWith(".zh.md")).map((name) => name.slice(0, -6));
  assert.ok(names.length > 0);
  for (const name of names) {
    const zh = readFileSync(join(prompts, `${name}.zh.md`), "utf8");
    const en = readFileSync(join(prompts, `${name}.en.md`), "utf8");
    assert.equal(zh.split("\n").length, en.split("\n").length, `${name} line parity`);
    assert.deepEqual((zh.match(/^#{1,6} /gm) ?? []).length, (en.match(/^#{1,6} /gm) ?? []).length, `${name} heading parity`);
    assert.deepEqual(placeholders(zh), placeholders(en), `${name} placeholder parity`);
    assert.deepEqual([...new Set(technicalTokens(zh))].sort(), [...new Set(technicalTokens(en))].sort(), `${name} technical token parity`);
  }
});

test("supervisor guide zh/en is complete and structurally equivalent", () => {
  const zh = readFileSync(join(root, "supervisor-guide.zh.md"), "utf8");
  const en = readFileSync(join(root, "supervisor-guide.en.md"), "utf8");
  assert.ok(zh.split("\n").length >= 287, "supervisor-guide.zh.md must retain at least 90% of the original 319 lines");
  for (const phrase of ["不可妥协", "判据先于执行", "信息收集", "graph_report_status", "worktree 隔离"]) assert.ok(zh.includes(phrase), `guide contract phrase missing: ${phrase}`);
  assert.equal(zh.split("\n").length, en.split("\n").length, "supervisor guide line parity");
  assert.deepEqual((zh.match(/^#{1,6} /gm) ?? []).map((h) => h[0]), (en.match(/^#{1,6} /gm) ?? []).map((h) => h[0]), "supervisor guide heading levels");
  assert.deepEqual([...new Set(technicalTokens(zh))].sort(), [...new Set(technicalTokens(en))].sort(), "supervisor guide technical token parity");
});

test("zh prompt assets are not stubs", () => {
  const minimums: Record<string, number> = { usage: 10, "guide-hint": 4, discipline: 7, help: 19, worktree: 4, "minor-task": 4 };
  for (const [name, min] of Object.entries(minimums)) {
    const text = readFileSync(join(prompts, `${name}.zh.md`), "utf8");
    assert.ok(text.split("\n").length >= min, `${name}.zh.md is unexpectedly short`);
  }
});

test("server i18n dictionaries are symmetric and English has no CJK text", () => {
  assert.equal(assertServerI18nParity(), true);
  assert.deepEqual(Object.keys(SERVER_I18N.zh).sort(), Object.keys(SERVER_I18N.en).sort());
  assert.doesNotMatch(Object.values(SERVER_I18N.en).join("\n"), /[\u3400-\u9fff]/);
});

test("server i18n has one symmetric key for every graph tool", () => {
  const indexSource = readFileSync(join(root, "index.js"), "utf8");
  const toolNames = [...indexSource.matchAll(/name: \"(graph_[A-Za-z0-9_]+)\"/g)].map((match) => match[1]);
  assert.equal(new Set(toolNames).size, toolNames.length);
  const expected = toolNames.map((name) => `tool.${name}`).sort();
  assert.deepEqual(Object.keys(SERVER_I18N.zh).filter((key) => key.startsWith("tool.")).sort(), expected);
  assert.deepEqual(Object.keys(SERVER_I18N.en).filter((key) => key.startsWith("tool.")).sort(), expected);
});
