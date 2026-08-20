/** 插件工具输出的无损 JSON 回归测试（防止 undefined 字段这类问题再现）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../ops.ts";
import { apply } from "../../dsh-graph-host/index.js";

function assertLossless(v: unknown): void {
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v, "输出必须是无损 JSON");
}

test("全部 graph_* 工具在 mock ctx 下可执行且输出无损 JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-plugin-"));
  init(root);
  const registered: any[] = [];
  const ctx = {
    get: () => undefined, // 无 subagents 服务 → 走降级分支
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (def: any) => {
        registered.push(def);
        return () => {};
      },
      get: () => ({}),
    },
  };
  apply(ctx as any, { root });
  assert.equal(registered.length, 11);

  const byName = new Map(registered.map((d) => [d.name, d]));
  const exec = { agent: undefined, signal: new AbortController().signal };
  const call = async (name: string, args: Record<string, unknown>) => {
    const out = await byName.get(name)!.execute(args, exec);
    assertLossless(out);
    return out as any;
  };

  const { goal } = await call("graph_create_goal", { title: "t", version: "v-t" });
  await call("graph_set_criteria", { goal, criteria: ["通过"] });
  await call("graph_transition", { goal, to: "planning" });
  const { card } = await call("graph_add_card", { goal, title: "c", kind: "text" });
  await call("graph_fill_card", { goal, card, text: "内容" });
  await call("graph_review_card", { goal, card });
  const att = await call("graph_start_attempt", { goal });
  assert.equal(att.child_id, null); // 无 subagents → 降级
  assert.ok(typeof att.note === "string");
  await call("graph_report_status", { goal, attempt: att.attempt, status: "测试中" });
  await call("graph_move_goal", { goal, to: "standalone" });
  const v = await call("graph_validate", {});
  assert.deepEqual(v.problems, []);
  const r = await call("graph_rebuild", {});
  assert.deepEqual(r.drift, []);
});
