/** g-112 root 通用化验收测试（g-116 合并后修订）：
 *  1. resolveRoot 统一解析（workspace 根 = process.cwd() 基准，默认 .dsh-graph，config.root 可覆盖）；
 *  2. 单包 index.js 与 core 的 resolveRoot 函数行为一致（re-export，模块同一性）+ 包内 core 产物同步校验；
 *  3. 单包 apply 幂等调 core init()：root 不存在自动建骨架，重复 apply 不重复建、不重复记事件。
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

function mockCtx(extra: Record<string, unknown> = {}) {
  const webServer = { register: () => () => {} };
  return {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
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

test("单包 index.js 与 core 的 resolveRoot 行为一致（g-116：合并后单包 re-export + 产物同步）", async () => {
  const coreRoot = resolveRoot;
  const hostMod = await import("../../dsh-graph-host/index.js");
  // 行为等价：相同输入 → 相同输出（防分叉的实质）
  const cases = [undefined, null, {}, { root: undefined }, { root: ".dsh-graph" }, { root: "data/g" }, { root: "/abs/g" }];
  for (const c of cases) {
    assert.equal(hostMod.resolveRoot(c, "/base"), coreRoot(c, "/base"), `host resolveRoot(${JSON.stringify(c)}) 与 core 一致`);
  }
  // 产物同步：包内 core/root.js 为根 core/root.ts 的编译产物（sync-core.sh 强制，防副本漂移）
  // 校验方式：产物包含根源码的关键逻辑（resolve 调用 + 默认 .dsh-graph），且无 .ts 引用
  const hostJs = readFileSync(new URL("../../dsh-graph-host/core/root.js", import.meta.url), "utf8");
  assert.match(hostJs, /resolve\(workspaceRoot/, "产物包含统一解析逻辑");
  assert.match(hostJs, /\.dsh-graph/, "产物保留默认 .dsh-graph");
  assert.ok(!hostJs.includes(".ts\""), "产物无 .ts 引用（node_modules 下 .ts 不可加载）");
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

test("单包 apply 幂等调 core init：root 不存在自动建骨架，重复 apply 不重复建", () => {
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

test("g-116 单包 apply 同时注册 host（tools）与 client（webServer 路由）两个半边", () => {
  const registered: any[] = [];
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
  };
  applyHost(ctx, { root: join(mkdtempSync(join(tmpdir(), "dsh-graph-dual-")), "g") });
  // host 半边：16 个 graph_* 工具（g-117 新增 graph_handoff / graph_claim_supervisor）
  const toolNames = registered.map((d) => d.name).filter((n) => n.startsWith("graph_"));
  assert.equal(toolNames.length, 16, "单包注册 16 个 graph_* 工具");
  // client 半边：/api/dsh-graph* 全部端点（原 client 包 9 条路由）
  for (const p of ["/api/dsh-graph", "/api/dsh-graph/goal", "/api/dsh-graph/accept",
    "/api/dsh-graph/resolve-accept", "/api/dsh-graph/edit-description",
    "/api/dsh-graph/add-card", "/api/dsh-graph/start-collection",
    "/api/dsh-graph/start-execution", "/api/dsh-graph/spawn-options"]) {
    assert.ok(routes.has(p), `路由 ${p} 已注册`);
  }
});

