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
import { resolveRoot, resolveCanonicalRoot, discoverGitWorktree } from "../root.ts";
import { readEvents } from "../events.ts";
import { execSync } from "node:child_process";
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
  // host 半边：25 个 graph_* 工具（g-117 新增 graph_handoff / graph_claim_supervisor；
  // g-119 新增 graph_bind_collect_card；g-118 新增 graph_help；g-141 新增 graph_rename_goal；g-110 新增 archive/unarchive；g-140 新增 delete；g-150 新增 graph_record_attempt_handoff；g-150 范围扩展新增 graph_set_directive / graph_add_comment）
  const toolNames = registered.map((d) => d.name).filter((n) => n.startsWith("graph_"));
  assert.equal(toolNames.length, 25, "单包注册 25 个 graph_* 工具");
  // client 半边：/api/dsh-graph* 全部端点（原 client 包 + g-110 archive/unarchive + g-140 delete）
  for (const p of ["/api/dsh-graph", "/api/dsh-graph/goal", "/api/dsh-graph/accept",
    "/api/dsh-graph/resolve-accept", "/api/dsh-graph/edit-description",
    "/api/dsh-graph/add-card", "/api/dsh-graph/start-collection",
    "/api/dsh-graph/start-execution", "/api/dsh-graph/spawn-options",
    "/api/dsh-graph/rename-goal", "/api/dsh-graph/archive", "/api/dsh-graph/unarchive",
    "/api/dsh-graph/delete"]) {
    assert.ok(routes.has(p), `路由 ${p} 已注册`);
  }
});

// ===== g-149: Git linked-worktree canonicalization tests =====

/** Helper: create a temporary Git repo with optional linked worktree. */
function setupGitRepo(base: string, opts?: { linkedWorktree?: boolean }) {
  const mainDir = join(base, "main-repo");
  execSync(`git init -b main "${mainDir}"`, { stdio: "pipe" });
  execSync(`git -C "${mainDir}" config user.email "test@test.com"`, { stdio: "pipe" });
  execSync(`git -C "${mainDir}" config user.name "Test"`, { stdio: "pipe" });
  // Need at least one commit for worktree to work
  execSync(`git -C "${mainDir}" commit --allow-empty -m "init"`, { stdio: "pipe" });

  let worktreeDir: string | null = null;
  if (opts?.linkedWorktree) {
    worktreeDir = join(base, "linked-worktree");
    execSync(`git -C "${mainDir}" worktree add "${worktreeDir}"`, { stdio: "pipe" });
  }

  return { mainDir, worktreeDir };
}

test("g-149 discoverGitWorktree：主工作树返回正确信息", () => {
  const base = mkdtempSync(join(tmpdir(), "g149-discover-main-"));
  const { mainDir } = setupGitRepo(base);

  const info = discoverGitWorktree(mainDir);
  assert.ok(info !== null, "主工作树应返回 Git info");
  assert.equal(info!.mainWorktree, resolve(mainDir), "mainWorktree = 主目录");
  assert.equal(info!.workspace, resolve(mainDir), "workspace = 主目录");
  assert.equal(info!.isLinkedWorktree, false, "主工作树不是 linked worktree");
});

test("g-149 discoverGitWorktree：linked worktree 正确识别主工作树", () => {
  const base = mkdtempSync(join(tmpdir(), "g149-discover-linked-"));
  const { mainDir, worktreeDir } = setupGitRepo(base, { linkedWorktree: true });

  const info = discoverGitWorktree(worktreeDir!);
  assert.ok(info !== null, "linked worktree 应返回 Git info");
  assert.equal(info!.mainWorktree, resolve(mainDir), "mainWorktree 指向主工作树");
  assert.equal(info!.workspace, resolve(worktreeDir!), "workspace = linked worktree 目录");
  assert.equal(info!.isLinkedWorktree, true, "识别为 linked worktree");
});

test("g-149 discoverGitWorktree：非 Git 目录返回 null", () => {
  const base = mkdtempSync(join(tmpdir(), "g149-discover-nongit-"));
  const info = discoverGitWorktree(base);
  assert.equal(info, null, "非 Git 目录返回 null");
});

test("g-149 resolveCanonicalRoot：绝对 config.root 跳过 Git 发现", () => {
  const base = mkdtempSync(join(tmpdir(), "g149-abs-config-"));
  const { mainDir, worktreeDir } = setupGitRepo(base, { linkedWorktree: true });

  const result = resolveCanonicalRoot({ root: "/custom/graph" }, worktreeDir!);
  assert.equal(result.root, "/custom/graph", "绝对 root 原样返回");
  assert.equal(result.mode, "absolute-config", "mode = absolute-config");
  assert.equal(result.workspace, resolve(worktreeDir!), "workspace 保持原值");
});

test("g-149 resolveCanonicalRoot：主工作树正常解析", () => {
  const base = mkdtempSync(join(tmpdir(), "g149-canonical-main-"));
  const { mainDir } = setupGitRepo(base);

  const result = resolveCanonicalRoot(undefined, mainDir);
  assert.equal(result.root, resolve(mainDir, ".dsh-graph"), "root = main/.dsh-graph");
  assert.equal(result.mode, "main-tree", "mode = main-tree");
  assert.equal(result.canonicalWorkspace, resolve(mainDir), "canonicalWorkspace = mainDir");
  assert.equal(result.rootWarning, undefined, "无警告");
});

test("g-149 resolveCanonicalRoot：linked worktree 归一到主工作树", () => {
  const base = mkdtempSync(join(tmpdir(), "g149-canonical-linked-"));
  const { mainDir, worktreeDir } = setupGitRepo(base, { linkedWorktree: true });

  const result = resolveCanonicalRoot(undefined, worktreeDir!);
  assert.equal(result.root, resolve(mainDir, ".dsh-graph"), "root = 主工作树/.dsh-graph");
  assert.equal(result.mode, "canonicalized", "mode = canonicalized");
  assert.equal(result.canonicalWorkspace, resolve(mainDir), "canonicalWorkspace = 主工作树");
  assert.equal(result.rootWarning, undefined, "无旧数据时无警告");
});

test("g-149 resolveCanonicalRoot：linked worktree 有遗留本地 graph 时附带警告", () => {
  const base = mkdtempSync(join(tmpdir(), "g149-canonical-legacy-"));
  const { mainDir, worktreeDir } = setupGitRepo(base, { linkedWorktree: true });

  // Create legacy worktree-local graph data
  const localGraph = join(worktreeDir!, ".dsh-graph");
  init(localGraph); // creates skeleton with events.jsonl

  const result = resolveCanonicalRoot(undefined, worktreeDir!);
  assert.equal(result.root, resolve(mainDir, ".dsh-graph"), "root = 主工作树/.dsh-graph");
  assert.equal(result.mode, "canonicalized", "mode = canonicalized");
  assert.ok(result.rootWarning !== undefined, "有旧数据时有警告");
  assert.match(result.rootWarning!, /worktree 本地旧看板/, "警告提及旧看板");
});

test("g-149 resolveCanonicalRoot：自定义相对 root 也做 canonicalization", () => {
  const base = mkdtempSync(join(tmpdir(), "g149-canonical-custom-"));
  const { mainDir, worktreeDir } = setupGitRepo(base, { linkedWorktree: true });

  const result = resolveCanonicalRoot({ root: "data/my-graph" }, worktreeDir!);
  assert.equal(result.root, resolve(mainDir, "data/my-graph"), "自定义相对 root 也归一到主树");
  assert.equal(result.mode, "canonicalized", "mode = canonicalized");
});

test("g-149 resolveCanonicalRoot：非 Git workspace 回退到 workspace-local", () => {
  const base = mkdtempSync(join(tmpdir(), "g149-canonical-fallback-"));

  const result = resolveCanonicalRoot(undefined, base);
  assert.equal(result.root, resolve(base, ".dsh-graph"), "root = workspace/.dsh-graph");
  assert.equal(result.mode, "workspace-fallback", "mode = workspace-fallback");
  assert.equal(result.canonicalWorkspace, resolve(base), "canonicalWorkspace = workspace");
  assert.equal(result.rootWarning, undefined, "无警告");
});

test("g-149 resolveCanonicalRoot 返回值可直接传入 init（init 幂等兼容）", () => {
  const base = mkdtempSync(join(tmpdir(), "g149-canonical-init-"));
  const { mainDir, worktreeDir } = setupGitRepo(base, { linkedWorktree: true });

  const result = resolveCanonicalRoot(undefined, worktreeDir!);
  // Should not throw
  init(result.root);
  assertSkeleton(result.root);
  // The init happened on the main tree, not the worktree
  assert.ok(!existsSync(join(worktreeDir!, ".dsh-graph")), "worktree 下未创建 .dsh-graph");
});

test("g-149 host re-export 也暴露 resolveCanonicalRoot（模块同步）", async () => {
  const hostMod = await import("../../dsh-graph-host/index.js");
  assert.equal(typeof hostMod.resolveCanonicalRoot, "function", "host 模块导出 resolveCanonicalRoot");
  // 行为等价测试
  const base = mkdtempSync(join(tmpdir(), "g149-host-export-"));
  const { mainDir, worktreeDir } = setupGitRepo(base, { linkedWorktree: true });

  const coreResult = resolveCanonicalRoot(undefined, worktreeDir!);
  const hostResult = hostMod.resolveCanonicalRoot(undefined, worktreeDir!);
  assert.equal(hostResult.root, coreResult.root, "host 与 core 结果一致");
  assert.equal(hostResult.mode, coreResult.mode, "host 与 core mode 一致");
});

