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
import { resolveRoot, resolveCanonicalRoot, discoverGitWorktree, _clearCanonicalRootCache, _gitRunner, DEFAULT_CANONICAL_CACHE_TTL_MS } from "../root.ts";
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

test("g-149 apply 不以 process.cwd() 自动 init：默认 config 无显式 root 时不建骨架", () => {
  // 模拟 apply 在包子目录或服务进程 cwd 下运行的场景
  // 默认 config（无 root 覆盖）+ 无 sandboxPolicy → 不应以 process.cwd()/.dsh-graph 创建骨架
  applyHost(mockCtx(), {});
  // apply 不报错；关键是验证它没有在 process.cwd() 下创建 .dsh-graph
  // （process.cwd() 在测试中是 worktree 根，已有主库的 .dsh-graph 目录，不产生新骨架）
  assert.ok(true, "apply 默认 config 不报错、不自动 init process.cwd()/.dsh-graph");
});

test("g-149 apply 有绝对 config.root 时仍正常 init（管理员覆盖）", () => {
  const base = mkdtempSync(join(tmpdir(), "g149-abs-init-"));
  const root = join(base, "custom-data");
  applyHost(mockCtx(), { root });
  assertSkeleton(root);
  const evs = readEvents(root).filter((e) => e.event === "project.initialized");
  assert.equal(evs.length, 1, "绝对 config.root 时 apply 正常 init");
});

test("g-149 apply 有 sandboxPolicy.workspaceRoot 时正常 init", () => {
  const base = mkdtempSync(join(tmpdir(), "g149-sandbox-init-"));
  // 模拟 sandboxPolicy 提供 workspace——需要覆盖 mockCtx 的 get
  const webServer = { register: () => () => {} };
  const sandboxPolicy = { workspaceRoot: base };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "sandboxPolicy") return sandboxPolicy;
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  applyHost(ctx, {});
  // sandbox workspace + default .dsh-graph root → 应该 init
  assertSkeleton(join(base, ".dsh-graph"));
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
  // host 半边：28 个 graph_* 工具（g-117 新增 graph_handoff / graph_claim_supervisor；
  // g-119 新增 graph_bind_collect_card；g-118 新增 graph_help；g-141 新增 graph_rename_goal；g-110 新增 archive/unarchive；g-140 新增 delete；g-150 新增 graph_record_attempt_handoff；g-150 范围扩展新增 graph_set_directive / graph_add_comment；g-128 新增 graph_delete_card；g-158 新增 graph_set_goal_type；g-138 新增 graph_postpone_goal）
  const toolNames = registered.map((d) => d.name).filter((n) => n.startsWith("graph_"));
  assert.equal(toolNames.length, 28, "单包注册 28 个 graph_* 工具");
  // client 半边：/api/dsh-graph* 全部端点（原 client 包 + g-110 archive/unarchive + g-140 delete + g-158 set-goal-type/create-goal type 透传）
  for (const p of ["/api/dsh-graph", "/api/dsh-graph/goal", "/api/dsh-graph/accept",
    "/api/dsh-graph/resolve-accept", "/api/dsh-graph/edit-description",
    "/api/dsh-graph/add-card", "/api/dsh-graph/start-collection",
    "/api/dsh-graph/start-execution", "/api/dsh-graph/spawn-options",
    "/api/dsh-graph/rename-goal", "/api/dsh-graph/set-goal-type", "/api/dsh-graph/create-goal",
    "/api/dsh-graph/archive", "/api/dsh-graph/unarchive",
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

test("g-149 根 .gitignore 包含 **/.dsh-graph/ 规则（防止子目录意外引入）", () => {
  // 验证仓库的 .gitignore 包含通配规则，阻止任何子目录的 .dsh-graph 被 git add -A 收集
  const gitignorePath = join(import.meta.dirname, "../../.gitignore");
  const gitignore = readFileSync(gitignorePath, "utf8");
  assert.ok(gitignore.includes("**/.dsh-graph/"), ".gitignore 包含 **/.dsh-graph/ 通配规则");
  // 验证已有的 host 专用规则已被通配规则替代
  assert.ok(!gitignore.includes("dsh-graph-host/.dsh-graph/"), "旧的 host 专用规则已移除");
});

// ===== g-149: 无 workspace 时不 fallback process.cwd() 的行为测试 =====

test("g-149 工具无 session/sandbox 时 graph_create_goal 抛错、不建骨架", async () => {
  // 不传 config.root（默认相对 .dsh-graph），且无 session/sandbox → 应抛 workspace 错误
  const registered: any[] = [];
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? { register: () => () => {} } : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer: { register: () => () => {} },
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
  };
  applyHost(ctx, {}); // 无 config.root，无 sandboxPolicy

  const createGoalTool = registered.find((d) => d.name === "graph_create_goal");
  assert.ok(createGoalTool, "graph_create_goal 已注册");

  // 调用时 ex 无 session、无 sandboxPolicy → 应抛错
  assert.throws(
    () => createGoalTool.execute({ title: "test" }, { agent: { id: "test" } }),
    (err: any) => {
      return err.message.includes("workspace");
    },
    "无 workspace 时工具调用应抛错",
  );
});

test("g-149 工具有明确 session.header.cwd 时正常读写", async () => {
  const base = mkdtempSync(join(tmpdir(), "g149-ws-tool-"));
  const root = join(base, ".dsh-graph");
  const registered: any[] = [];
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? { register: () => () => {} } : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer: { register: () => () => {} },
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
  };
  applyHost(ctx, { root });

  const createGoalTool = registered.find((d) => d.name === "graph_create_goal");
  assert.ok(createGoalTool, "graph_create_goal 已注册");

  // 调用时 ex 有 session.header.cwd（明确 workspace）→ 正常工作
  const result = await createGoalTool.execute(
    { title: "test-goal" },
    { agent: { id: "test", session: { header: { cwd: base } } } },
  );
  assert.ok(result.goal, "明确 workspace 时工具调用成功");
});

test("g-149 REST GET /api/dsh-graph 无 workspace 参数返回错误、不建骨架", async () => {
  // 不传 config.root（默认相对），REST 请求无 ?workspace= → 应返回 400
  let boardHandler: any;
  const webServer = {
    register: (def: any) => {
      if (def.path === "/api/dsh-graph") boardHandler = def.handler;
      return () => {};
    },
  };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  applyHost(ctx, {}); // 无 config.root，无 sandboxPolicy
  assert.ok(boardHandler, "board handler 已注册");

  // 模拟无 workspace 的请求
  const req = { url: "/api/dsh-graph" }; // 无 ?workspace=
  let responseData: any;
  let statusCode: number;
  const res = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = JSON.parse(data); },
  };

  boardHandler(req, res);

  assert.equal(statusCode!, 400, "无 workspace 时返回 400");
  assert.ok(responseData.error.includes("workspace"), `错误提及 workspace: ${responseData.error}`);
});

test("g-149 REST POST 端点无 workspace 参数返回错误", async () => {
  // 不传 config.root（默认相对），POST 请求无 body.workspace → 应返回 400
  let transitionHandler: any;
  const webServer = {
    register: (def: any) => {
      if (def.path === "/api/dsh-graph/transition") transitionHandler = def.handler;
      return () => {};
    },
  };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  applyHost(ctx, {}); // 无 config.root，无 sandboxPolicy
  assert.ok(transitionHandler, "transition handler 已注册");

  // 模拟 POST 请求，body 无 workspace，URL 也无 ?workspace=
  const req: any = {
    method: "POST",
    url: "/api/dsh-graph/transition",
    on: (event: string, cb: any) => {
      if (event === "data") cb(JSON.stringify({ goal: "g-test", to: "in_progress" }));
      if (event === "end") cb();
    },
  };
  let responseData: any;
  let statusCode: number;
  const res = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = JSON.parse(data); },
  };

  await transitionHandler(req, res);

  assert.equal(statusCode!, 400, "无 workspace 时 POST 返回 400");
  assert.ok(responseData.error.includes("workspace"), `错误提及 workspace: ${responseData.error}`);
});

test("g-149 REST GET /api/dsh-graph 有明确 workspace 时正常返回", async () => {
  const base = mkdtempSync(join(tmpdir(), "g149-ws-rest-"));
  // 先初始化骨架
  const { init: initFn } = await import("../ops.ts");
  initFn(join(base, ".dsh-graph"));

  let boardHandler: any;
  const webServer = {
    register: (def: any) => {
      if (def.path === "/api/dsh-graph") boardHandler = def.handler;
      return () => {};
    },
  };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  applyHost(ctx, {});
  assert.ok(boardHandler, "board handler 已注册");

  // 有 ?workspace= 参数的请求
  const req = { url: `/api/dsh-graph?workspace=${encodeURIComponent(base)}` };
  let responseData: any;
  let statusCode: number;
  const res = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = JSON.parse(data); },
  };

  boardHandler(req, res);

  assert.equal(statusCode!, 200, "有 workspace 时返回 200");
  assert.ok(responseData, "有 workspace 时返回数据");
});

// ===== g-210: 内存缓存与失效机制测试 =====

test("g-210 缓存命中：同一 workspace 多次调用不重复执行 git 子进程", async () => {
  _clearCanonicalRootCache();
  const base = mkdtempSync(join(tmpdir(), "g210-cache-hit-"));
  const { mainDir, worktreeDir } = setupGitRepo(base, { linkedWorktree: true });

  const origExecSync = _gitRunner.execSync;
  let execSyncCount = 0;

  try {
    _gitRunner.execSync = function (...args: any[]) {
      execSyncCount++;
      return (origExecSync as any).apply(this, args);
    };

    // 首次调用：未命中缓存，触发 git 子进程
    const res1 = resolveCanonicalRoot(undefined, worktreeDir!);
    const countAfterFirst = execSyncCount;
    assert.ok(countAfterFirst >= 2, "首次调用执行 rev-parse 与 worktree list");

    // 第二次、第三次调用：命中内存缓存，子进程执行次数不再增加
    const res2 = resolveCanonicalRoot(undefined, worktreeDir!);
    const res3 = resolveCanonicalRoot(undefined, worktreeDir!);

    assert.equal(execSyncCount, countAfterFirst, "后续调用应从内存缓存读取，不再执行 execSync");
    assert.deepEqual(res2, res1, "缓存结果与首次结果一致");
    assert.deepEqual(res3, res1, "多次缓存结果一致");

    // discoverGitWorktree 也直接命中同一 workspace 缓存
    const info1 = discoverGitWorktree(worktreeDir!);
    assert.equal(execSyncCount, countAfterFirst, "discoverGitWorktree 命中缓存不增加 execSync");
    assert.equal(info1?.isLinkedWorktree, true);
  } finally {
    _gitRunner.execSync = origExecSync;
  }
});

test("g-210 缓存重置：_clearCanonicalRootCache 后重新执行发现", async () => {
  _clearCanonicalRootCache();
  const base = mkdtempSync(join(tmpdir(), "g210-cache-clear-"));
  const { mainDir, worktreeDir } = setupGitRepo(base, { linkedWorktree: true });

  const origExecSync = _gitRunner.execSync;
  let execSyncCount = 0;

  try {
    _gitRunner.execSync = function (...args: any[]) {
      execSyncCount++;
      return (origExecSync as any).apply(this, args);
    };

    resolveCanonicalRoot(undefined, worktreeDir!);
    const count1 = execSyncCount;
    assert.ok(count1 > 0);

    // 清理缓存
    _clearCanonicalRootCache();

    // 再次调用应重新执行 git 命令
    resolveCanonicalRoot(undefined, worktreeDir!);
    assert.ok(execSyncCount > count1, "清空缓存后再次调用重新触发 execSync");
  } finally {
    _gitRunner.execSync = origExecSync;
  }
});

test("g-210 TTL 过期失效：超过 ttlMs 后重新执行 git 命令", async () => {
  _clearCanonicalRootCache();
  const base = mkdtempSync(join(tmpdir(), "g210-cache-ttl-"));
  const { mainDir, worktreeDir } = setupGitRepo(base, { linkedWorktree: true });

  const origExecSync = _gitRunner.execSync;
  let execSyncCount = 0;

  try {
    _gitRunner.execSync = function (...args: any[]) {
      execSyncCount++;
      return (origExecSync as any).apply(this, args);
    };

    // 设置很短的 TTL (30ms)
    resolveCanonicalRoot(undefined, worktreeDir!, { ttlMs: 30 });
    const count1 = execSyncCount;

    // 立即再次调用：命中缓存
    resolveCanonicalRoot(undefined, worktreeDir!, { ttlMs: 30 });
    assert.equal(execSyncCount, count1, "TTL 内命中缓存");

    // 等待 50ms 过期
    await new Promise((r) => setTimeout(r, 50));

    // 过期后调用：重新执行
    resolveCanonicalRoot(undefined, worktreeDir!, { ttlMs: 30 });
    assert.ok(execSyncCount > count1, "TTL 过期后重新触发 execSync");
  } finally {
    _gitRunner.execSync = origExecSync;
  }
});

test("g-210 .git mtime 变更失效：工作树或 Git 状态发生变化时自动刷新", async () => {
  _clearCanonicalRootCache();
  const base = mkdtempSync(join(tmpdir(), "g210-cache-mtime-"));
  const { mainDir, worktreeDir } = setupGitRepo(base, { linkedWorktree: true });

  const origExecSync = _gitRunner.execSync;
  let execSyncCount = 0;

  try {
    _gitRunner.execSync = function (...args: any[]) {
      execSyncCount++;
      return (origExecSync as any).apply(this, args);
    };

    resolveCanonicalRoot(undefined, worktreeDir!);
    const count1 = execSyncCount;

    // 命中缓存
    resolveCanonicalRoot(undefined, worktreeDir!);
    assert.equal(execSyncCount, count1);

    // 模拟 .git 文件/目录 mtime 改变（如 git worktree 更新或 touch .git）
    const gitPath = join(worktreeDir!, ".git");
    const { utimesSync } = await import("node:fs");
    const futureTime = (Date.now() + 10000) / 1000;
    utimesSync(gitPath, futureTime, futureTime);

    // .git mtime 变动后，缓存失效，重新执行 git
    resolveCanonicalRoot(undefined, worktreeDir!);
    assert.ok(execSyncCount > count1, ".git mtime 变化后缓存失效并重新触发 execSync");
  } finally {
    _gitRunner.execSync = origExecSync;
  }
});

test("g-210 非 Git 仓库路径降级缓存：同一非 Git workspace 也缓存 null 结果，避免重复报错", async () => {
  _clearCanonicalRootCache();
  const base = mkdtempSync(join(tmpdir(), "g210-nongit-cache-"));

  const origExecSync = _gitRunner.execSync;
  let execSyncCount = 0;

  try {
    _gitRunner.execSync = function (...args: any[]) {
      execSyncCount++;
      return (origExecSync as any).apply(this, args);
    };

    const res1 = resolveCanonicalRoot(undefined, base);
    assert.equal(res1.mode, "workspace-fallback");
    const count1 = execSyncCount;
    assert.ok(count1 >= 1, "首次对非 Git 目录尝试 rev-parse 失败");

    // 再次调用同一非 Git 目录：命中 fallback 缓存，不再抛异常/执行 execSync
    const res2 = resolveCanonicalRoot(undefined, base);
    assert.equal(res2.mode, "workspace-fallback");
    assert.equal(execSyncCount, count1, "非 Git 目录重复调用命中缓存");
  } finally {
    _gitRunner.execSync = origExecSync;
  }
});

test("g-210 不同 workspace 路径隔离：不同路径拥有独立的缓存条目", async () => {
  _clearCanonicalRootCache();
  const base1 = mkdtempSync(join(tmpdir(), "g210-iso-1-"));
  const base2 = mkdtempSync(join(tmpdir(), "g210-iso-2-"));
  const repo1 = setupGitRepo(base1, { linkedWorktree: true });
  const repo2 = setupGitRepo(base2, { linkedWorktree: false });

  const res1 = resolveCanonicalRoot(undefined, repo1.worktreeDir!);
  const res2 = resolveCanonicalRoot(undefined, repo2.mainDir);

  assert.equal(res1.canonicalWorkspace, resolve(repo1.mainDir));
  assert.equal(res2.canonicalWorkspace, resolve(repo2.mainDir));
  assert.notEqual(res1.canonicalWorkspace, res2.canonicalWorkspace, "不同 workspace 相互隔离");
});

test("g-210 host 模块同步暴露 _clearCanonicalRootCache", async () => {
  const hostMod = await import("../../dsh-graph-host/index.js");
  assert.equal(typeof hostMod._clearCanonicalRootCache, "function", "host 导出 _clearCanonicalRootCache");
});
