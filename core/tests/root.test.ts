/** g-112 root 通用化验收测试：
 *  1. resolveRoot 统一解析（workspace 根 = process.cwd() 基准，默认 .dsh-graph，config.root 可覆盖）；
 *  2. host/client 两半 re-export 同一 resolveRoot 函数（模块同一性）；
 *  3. host apply 幂等调 core init()：root 不存在自动建骨架，重复 apply 不重复建、不重复记事件；
 *  4. client apply 同样幂等建骨架（任一半边先加载即可用）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { init, listGoalFiles } from "../ops.ts";
import { resolveRoot } from "../root.ts";
import { readEvents } from "../events.ts";
import { apply as applyHost } from "../../dsh-graph-host/index.js";
import { apply as applyClient } from "../../dsh-graph-client/index.js";

function mockCtx(extra: Record<string, unknown> = {}) {
  return {
    get: () => undefined,
    effect: (fn: () => unknown) => fn(),
    webServer: {
      register: () => () => {},
    },
    tools: {
      register: () => () => {},
      get: () => ({}),
    },
    ...extra,
  } as any;
}

const SKELETON_DIRS = ["backlog", "goals", "versions", "memory/long-term"];
const SKELETON_FILES = ["events.jsonl", "index.json", "rules.md"];

function assertSkeleton(root: string) {
  for (const d of SKELETON_DIRS) assert.ok(existsSync(join(root, d)), `目录 ${d} 已建`);
  for (const f of SKELETON_FILES) assert.ok(existsSync(join(root, f)), `文件 ${f} 已建`);
  // 不建 project.yaml、不带 demo 数据（无任何目标）
  assert.ok(!existsSync(join(root, "project.yaml")), "project.yaml 不建");
  assert.deepEqual(listGoalFiles(root), [], "无 demo 目标");
}

test("resolveRoot：默认 workspace 根（process.cwd()）基准 + .dsh-graph，config.root 可覆盖", () => {
  const cwd = process.cwd();
  assert.equal(resolveRoot(undefined), resolve(cwd, ".dsh-graph"));
  assert.equal(resolveRoot(null), resolve(cwd, ".dsh-graph"));
  assert.equal(resolveRoot({}), resolve(cwd, ".dsh-graph"));
  assert.equal(resolveRoot({ root: undefined }), resolve(cwd, ".dsh-graph"));
  // 相对 root：以 workspace 根为基准
  assert.equal(resolveRoot({ root: ".dsh-graph" }, "/base"), "/base/.dsh-graph");
  assert.equal(resolveRoot({ root: "data/g" }, "/base"), "/base/data/g");
  // 绝对 root：原样返回
  assert.equal(resolveRoot({ root: "/abs/g" }, "/base"), "/abs/g");
});

test("host/client 两半与 core 共用同一 resolveRoot 函数（模块同一性）", async () => {
  const coreRoot = resolveRoot;
  const hostMod = await import("../../dsh-graph-host/index.js");
  const clientMod = await import("../../dsh-graph-client/index.js");
  assert.equal(hostMod.resolveRoot, coreRoot, "host re-export 同一函数");
  assert.equal(clientMod.resolveRoot, coreRoot, "client re-export 同一函数");
});

test("init 幂等：重复调用不重复建骨架、不重复记 project.initialized", () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-init-"));
  const root = join(base, "g");
  init(root);
  assertSkeleton(root);
  init(root);
  init(root);
  assertSkeleton(root);
  const evs = readEvents(root).filter((e) => e.event === "project.initialized");
  assert.equal(evs.length, 1, "重复 init 只记一次 project.initialized");
  // 骨架文件内容不变（rules.md 骨架存在且版本 r-init）
  assert.match(readFileSync(join(root, "rules.md"), "utf8"), /"version": "r-init"/);
});

test("host apply 幂等调 core init：root 不存在自动建骨架，重复 apply 不重复建", () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-host-"));
  const root = join(base, "g"); // 不存在的子目录 → 触发自动建骨架
  applyHost(mockCtx(), { root });
  assertSkeleton(root);
  // 重复 apply（模拟 hot-reload 重载）不重复建、不重复记事件
  applyHost(mockCtx(), { root });
  applyHost(mockCtx(), { root });
  assertSkeleton(root);
  const evs = readEvents(root).filter((e) => e.event === "project.initialized");
  assert.equal(evs.length, 1, "重复 apply 只记一次 project.initialized");
});

test("client apply 幂等调 init：任一半边先加载即自动建骨架", () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-client-"));
  const root = join(base, "g");
  applyClient(mockCtx(), { root });
  assertSkeleton(root);
  applyClient(mockCtx(), { root });
  const evs = readEvents(root).filter((e) => e.event === "project.initialized");
  assert.equal(evs.length, 1, "重复 apply 只记一次 project.initialized");
});
