import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SERVER_I18N, assertServerI18nParity } from "../../dsh-graph-host/lib/server-i18n.js";

const root = join(import.meta.dirname, "../../dsh-graph-host");
const prompts = join(root, "prompts");
const placeholders = (text: string) => [...text.matchAll(/\{\{?([A-Za-z0-9_.-]+)\}?\}/g)].map((m) => m[1]).sort();

test("prompt markdown zh/en assets keep heading and placeholder parity", () => {
  const names = readdirSync(prompts).filter((name) => name.endsWith(".zh.md")).map((name) => name.slice(0, -6));
  assert.ok(names.length > 0);
  for (const name of names) {
    const zh = readFileSync(join(prompts, `${name}.zh.md`), "utf8");
    const en = readFileSync(join(prompts, `${name}.en.md`), "utf8");
    assert.deepEqual((zh.match(/^#{1,6} /gm) ?? []).length, (en.match(/^#{1,6} /gm) ?? []).length, `${name} heading parity`);
    assert.deepEqual(placeholders(zh), placeholders(en), `${name} placeholder parity`);
  }
});

test("server i18n dictionaries are symmetric and English has no CJK text", () => {
  assert.equal(assertServerI18nParity(), true);
  assert.deepEqual(Object.keys(SERVER_I18N.zh).sort(), Object.keys(SERVER_I18N.en).sort());
  assert.doesNotMatch(Object.values(SERVER_I18N.en).join("\n"), /[\u3400-\u9fff]/);
});
