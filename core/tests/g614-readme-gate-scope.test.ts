import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readme = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/README.md"), "utf8");
function problems(text: string): string[] {
  const zh = text.split("\n").find((line) => line.startsWith("**宿主兼容范围**")) ?? "";
  const en = text.split("\n").find((line) => line.startsWith("**Host compatibility range**")) ?? "";
  const checks: Array<[string, boolean]> = [
    ["zh-new", /已核实的 `0\.2\.1-rc\.5`、`0\.2\.2-alpha\.3` 和 `0\.2\.2-rc\.1`/.test(zh)],
    ["zh-peer", /在上述已核实的新实现中 peer 分支不会执行/.test(zh)],
    ["zh-old", /`0\.2\.0-rc\.2` 及更早则只读 peer/.test(zh)],
    ["en-new", /verified `0\.2\.1-rc\.5`, `0\.2\.2-alpha\.3` and `0\.2\.2-rc\.1` implementations/.test(en)],
    ["en-peer", /in those verified newer implementations the peer branch is never reached/.test(en)],
    ["en-old", /`0\.2\.0-rc\.2` and earlier read only peers/.test(en)],
    ["no-guessed-introduction", !/自 `0\.2\.1-rc\.5` 起|Since `0\.2\.1-rc\.5`/.test(zh + en)],
  ];
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
}
test("g-614 bilingual gate description scopes both behaviors to verified versions", () => {
  assert.deepEqual(problems(readme), []);
  assert.ok(problems(readme.replace("在上述已核实的新实现中 peer 分支不会执行", "peer 分支不会执行")).includes("zh-peer"));
  assert.ok(problems(readme.replace("in those verified newer implementations the peer branch is never reached", "the peer branch is never reached")).includes("en-peer"));
  assert.ok(problems(readme.replace("`0.2.0-rc.2` and earlier read only peers", "older versions ignore peers")).includes("en-old"));
});
