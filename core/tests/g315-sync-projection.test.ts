/**
 * g-315：`dsh-graph sync` 上下文投影（稳定前缀 + 动态概览，受控区段替换 / 追加，原子写）测试。
 *
 * 覆盖判据（与目标 g-315 一一对应）：
 * - 判据 1：`sync` 命令生成/更新 `.claude/CLAUDE.md` 与 `AGENTS.md`，默认只读 `.dsh-graph` 资产；
 * - 判据 2：硬性常驻事实在前构成**字节稳定前缀**（两次运行 hash 相等），动态内容在后；
 * - 判据 3：复用 core 的记忆与目标读取（不另立真源、不手写 frontmatter/YAML 解析）；
 * - 判据 4：受控标记区段替换，区段外字节级无损；无标记时按明确规则追加、绝不覆盖；
 * - 判据 5：无变更不写（mtime 不变），有变更原子写（临时文件 + rename），失败不留半文件；
 * - 判据 6：空记忆 / 无 active 目标 / 缺文件 / 目录只读 / 损坏记忆 ⇒ 可读非零退出且**不部分写入**；
 * - 判据 7：含**反向变异**（真源码副本，改坏关键守卫 ⇒ 本套件断言必红）；
 * - 判据 8：不破坏既有 AGENTS.md 守卫（g350 / g353 / g408 / g415）。
 *
 * 夹具全部建在仓库 `tmp/` 下的私有 mkdtemp 目录（AGENTS.md 临时文件纪律），用后清理；
 * **绝不触碰真实看板数据**。写入位置一律显式用 `invokedWorkspace` 钉死在沙箱内。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { init, readMemory, recallMemory } from "../ops.ts";
import { memoryDiagnostics } from "../events.ts";
import { parseArgs } from "../cli/args.ts";
import { runCli, EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../cli/main.ts";
import {
  APPEND_RULE,
  SYNC_MARKERS,
  SYNC_TARGETS,
  SyncError,
  applySync,
  extractOutsideBlock,
  extractStablePrefix,
  hashOf,
  planSync,
  renderDocument,
  renderStablePrefix,
  renderSyncBlock,
  resolveWorkspaceForSync,
  syncTargets,
  type StandingFact,
} from "../cli/sync.ts";

const repoRoot = join(import.meta.dirname, "../..");
const tmpRoot = join(repoRoot, "tmp");
const cliSourceEntry = join(repoRoot, "bin", "goal-graph.mjs");

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function makeSandbox(prefix: string): { dir: string; cleanup: () => void } {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, `${prefix}-`));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不掩盖测试结论 */
      }
    },
  };
}

/** 已初始化的看板骨架（复用 core `init`，不手写骨架）。 */
function makeBoard(sandboxDir: string): { workspace: string; root: string } {
  const workspace = join(sandboxDir, "ws");
  const root = join(workspace, ".dsh-graph");
  mkdirSync(workspace, { recursive: true });
  init(root);
  return { workspace, root };
}

interface MemSpec {
  id: string;
  text: string;
  scope?: "standing" | "on_demand";
  kind?: "project" | "user";
  actor?: string;
  importance?: number;
}

/** 追加一条 `memory.added` 记录（只写**记录**，语义由 core 的 replayMemory 决定）。 */
function addMemory(root: string, spec: MemSpec): void {
  const rec = {
    ts: "2026-01-01T00:00:00+08:00",
    actor: spec.actor ?? "human:gui",
    event: "memory.added",
    details: {
      id: spec.id,
      kind: spec.kind ?? "project",
      scope: spec.scope ?? "standing",
      text: spec.text,
      created_at: "2026-01-01T00:00:00+08:00",
      updated_at: "2026-01-01T00:00:00+08:00",
      ...(spec.importance === undefined ? {} : { importance: spec.importance }),
    },
  };
  writeFileSync(join(root, "memory", "memory.jsonl"), `${JSON.stringify(rec)}\n`, { flag: "a" });
}

function writeVersion(root: string, slug: string, meta: Record<string, unknown>): void {
  const dir = join(root, "versions", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "version.md"), `---\n${JSON.stringify(meta, null, 2)}\n---\n\n## 范围\n\n测试版本。\n`, "utf8");
}

function writeGoal(root: string, rel: string, meta: Record<string, unknown>): void {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `---\n${JSON.stringify(meta, null, 2)}\n---\n\n## 目标描述\n\n测试目标。\n`, "utf8");
}

function read(p: string): string {
  return readFileSync(p, "utf8");
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 整棵树的快照（内容哈希 + mtime + inode）：用于「零写入 / 不部分写入」断言。 */
function snapshotTree(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        out.push(`${p}|d|${st.mtimeMs}|${st.ino}`);
        walk(p);
      } else {
        out.push(`${p}|f|${st.size}|${st.mtimeMs}|${st.ino}|${sha(read(p))}`);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.join("\n");
}

/** 一次默认配置的 sync（写入位置钉死在沙箱 workspace 内）。 */
function syncInBoard(workspace: string, extra: Record<string, unknown> = {}) {
  return syncTargets(join(workspace, ".dsh-graph"), { invokedWorkspace: workspace, ...extra });
}

function cliInProcess(argv: string[], cwd: string) {
  return runCli(argv, { version: "0.0.0-test", cwd });
}

function runCliProcess(entry: string, argv: string[], cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "NODE_OPTIONS"]) delete env[name];
  const res = spawnSync(process.execPath, [entry, ...argv], { cwd, encoding: "utf8", timeout: 120_000, env });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * 真源码副本沙箱：`core/` 全量（tests 除外）+ 入口 `bin/dsh-graph.mjs`。
 * 相对导入在沙箱内自洽 ⇒ 变异体是**真实生产代码**，只有被变异的那一行不同。
 */
function makeMutationSandbox(sb: { dir: string }) {
  const binDir = join(sb.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  cpSync(join(repoRoot, "core"), join(sb.dir, "core"), {
    recursive: true,
    filter: (src) => !src.startsWith(join(repoRoot, "core", "tests")),
  });
  // `core/ops.ts` 在**模块加载期**就会读取 `prompts/` 下的资产（subagent-mode.*.md 等），
  // 缺了它副本会在 import 阶段直接崩（报 "prompt asset missing"），变异体根本不是可运行程序。
  cpSync(join(repoRoot, "prompts"), join(sb.dir, "prompts"), { recursive: true });
  cpSync(cliSourceEntry, join(binDir, "goal-graph.mjs"));
  return {
    entry: join(binDir, "goal-graph.mjs"),
    file(rel: string): string {
      return join(sb.dir, "core", "cli", rel);
    },
  };
}

/** 就地替换且断言**恰好命中 1 处**（命中 0/多 ⇒ 变异未落到位，对照不成立）。 */
function mutateSource(file: string, from: string, to: string): void {
  const src = read(file);
  const hits = src.split(from).length - 1;
  assert.equal(hits, 1, `变异锚点必须恰命中 1 处（${file} ← ${JSON.stringify(from)}），实际 ${hits}`);
  writeFileSync(file, src.replace(from, to), "utf8");
}

// ---------------------------------------------------------------------------
// 判据 1：命令存在、写两个文档、默认只读 .dsh-graph
// ---------------------------------------------------------------------------

test("g-315 判据1：sync 命令登记在参数解析中，且默认写 .claude/CLAUDE.md 与 AGENTS.md", () => {
  assert.deepEqual([...SYNC_TARGETS], [".claude/CLAUDE.md", "AGENTS.md"], "输出文档必须是这两个");
  const parsed = parseArgs(["sync"]);
  assert.equal(parsed.error, null, `sync 必须是已知命令：${parsed.error?.message ?? ""}`);
  assert.equal(parsed.args?.command, "sync");
  // 默认 = 不指定 --target 时两者都写
  const p2 = parseArgs(["sync", "--full", "--active-only"]);
  assert.equal(p2.error, null);
  assert.equal(p2.args?.full, true);
  assert.equal(p2.args?.activeOnly, true);
  // sync 专属选项出现在其它命令上 ⇒ 用法错误（不得被静默忽略）
  for (const argv of [["info", "--full"], ["status", "--active-only"], ["goal", "list", "--target", "AGENTS.md"]]) {
    const r = parseArgs(argv);
    assert.ok(r.error, `${argv.join(" ")} 必须被拒绝`);
    assert.match(r.error!.message, /只适用于 sync/);
  }
});

test("g-315 判据1：sync 生成两个文档，且只读 .dsh-graph（写前零改动）", () => {
  const sb = makeSandbox("g315-basic");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-0002", text: "第二条硬性事实：先写测试再改代码" });
    addMemory(root, { id: "mem-0001", text: "禁止在主树直接改代码", actor: "human:gui" });
    writeVersion(root, "v9.9", { id: "v-1", name: "v9.9", status: "planning", created_at: "2026-01-01T00:00:00+08:00" });
    writeGoal(root, "versions/v9.9/goals/g-901/goal.md", {
      id: "g-901",
      title: "示例目标",
      status: "in_progress",
      type: "feature",
      version: "v9.9",
    });

    // 写前：.dsh-graph 全树快照
    const before = snapshotTree(root);
    const r = syncInBoard(workspace);
    assert.deepEqual(r.problems, [], "健康看板不得报问题");
    assert.equal(r.written.length, 2, "两个文档都必须被创建");
    assert.equal(snapshotTree(root), before, "sync 不得改动 .dsh-graph 的任何字节（只读资产）");

    const agents = read(join(workspace, "AGENTS.md"));
    const claude = read(join(workspace, ".claude", "CLAUDE.md"));
    for (const doc of [agents, claude]) {
      assert.ok(doc.includes("mem-0001") && doc.includes("mem-0002"), "两条 standing 记忆都必须投影");
      assert.ok(doc.includes("g-901"), "版本内目标必须投影");
      assert.ok(doc.includes("v9.9"), "版本必须投影");
    }
    // on_demand 记忆不得出现在前缀（只投影 standing）
    addMemory(root, { id: "mem-ondemand", text: "按需记忆不应进前缀", scope: "on_demand" });
    syncInBoard(workspace);
    assert.ok(!read(join(workspace, "AGENTS.md")).includes("mem-ondemand"), "on_demand 记忆不得投影");
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据1：kind=user 的 standing 记忆同样投影（CLI 无身份 ⇒ 不按 owner 静默排除）", () => {
  const sb = makeSandbox("g315-user-mem");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-user", text: "用户常驻约束：中文回复", kind: "user", actor: "human:gui" });
    // 事实先行：core 的 host 路径（无 actor）确实看不到它 —— 这正是 sync 必须绕开的口径。
    assert.equal(recallMemory(root, { scope: "standing" }).matches.length, 0, "无 actor 时 core 不返回 user 条目");
    assert.equal(readMemory(root).filter((m) => m.scope === "standing").length, 1, "唯一真源里确实有这条 standing 记忆");

    syncInBoard(workspace);
    assert.ok(read(join(workspace, "AGENTS.md")).includes("mem-user"), "user 常驻约束必须进前缀");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 2：稳定前缀跨次字节恒定，动态内容在后
// ---------------------------------------------------------------------------

test("g-315 判据2：前缀只由 standing 记忆决定（两次运行 hash 相等；动态数据变化不影响前缀）", () => {
  const sb = makeSandbox("g315-prefix");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-b", text: "事实 B" });
    addMemory(root, { id: "mem-a", text: "事实 A" });
    writeVersion(root, "v1.0", { id: "v-1", name: "v1.0", status: "planning", created_at: "2026-01-01T00:00:00+08:00" });
    writeGoal(root, "versions/v1.0/goals/g-001/goal.md", { id: "g-001", title: "目标一", status: "planning", type: "task", version: "v1.0" });

    const first = syncInBoard(workspace);
    const doc1 = read(join(workspace, "AGENTS.md"));
    const prefix1 = extractStablePrefix(doc1);
    assert.ok(prefix1 && prefix1.length > 0, "必须能取出 A 段前缀");

    // 前缀必须在动态段之前
    assert.ok(doc1.indexOf("### A. 硬性事实") < doc1.indexOf("### B. 动态概览"), "A 段（硬性事实）必须在 B 段之前");

    // 再跑一次：字节相同、无写入
    const second = syncInBoard(workspace);
    assert.equal(second.written.length, 0, "第二次运行必须无变更");
    assert.equal(extractStablePrefix(read(join(workspace, "AGENTS.md"))), prefix1);
    assert.equal(first.block === null ? "" : hashOf(prefix1), hashOf(extractStablePrefix(doc1) ?? ""), "前缀 hash 稳定");

    // 动态数据变化（新增目标、改变状态）：前缀必须**逐字节不变**，只有 B 段变
    writeGoal(root, "versions/v1.0/goals/g-002/goal.md", { id: "g-002", title: "目标二", status: "in_progress", type: "bug", version: "v1.0" });
    const third = syncInBoard(workspace);
    const doc3 = read(join(workspace, "AGENTS.md"));
    assert.equal(third.written.length, 2, "动态数据变化必须触发两个文档写入");
    assert.equal(extractStablePrefix(doc3), prefix1, "动态数据变化不得影响前缀字节");
    assert.ok(doc3.includes("g-002"), "新目标必须出现在动态段");
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据2：前缀不含计数/时间/绝对路径，且顺序按 id 固定（修订一条记忆不重排）", () => {
  const sb = makeSandbox("g315-prefix-purity");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-z", text: "设想 Z 用的记忆" });
    addMemory(root, { id: "mem-a", text: "事实 A" });
    syncInBoard(workspace);
    const prefix = extractStablePrefix(read(join(workspace, "AGENTS.md")))!;
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(prefix), "前缀不得含时间戳");
    assert.ok(!prefix.includes(tmpRoot), "前缀不得含绝对路径");
    assert.ok(!/共\s*\d+\s*条|共 \d+ 条/.test(prefix), "前缀不得含条目计数");
    // 顺序 = id 字典序
    assert.ok(prefix.indexOf("mem-a") < prefix.indexOf("mem-z"), "前缀条目按 id 排序");
    // 采集不到 standing 的边界：空记忆 ⇒ 前缀仍是「无」说明而非空串
    const empty = renderStablePrefix([]);
    assert.match(empty, /没有常驻记忆/, "空记忆必须给出可读说明");
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据2：前缀 hash 与 --json 的 prefix_sha256 一致（机器可读证据同源）", () => {
  const sb = makeSandbox("g315-prefix-json");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-1", text: "事实" });
    const r = cliInProcessSync(workspace);
    assert.equal(r.exitCode, EXIT_OK, r.stdout + r.stderr);
    const body = JSON.parse(r.stdout) as { prefix_sha256: string };
    const prefix = extractStablePrefix(read(join(workspace, "AGENTS.md")))!;
    assert.equal(body.prefix_sha256, hashOf(prefix), "--json 的前缀 hash 必须与文档实际前缀一致");
  } finally {
    sb.cleanup();
  }
});

function cliInProcessSync(workspace: string) {
  const r = spawnSync(process.execPath, [cliSourceEntry, "sync", "--json"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 120_000,
    env: cleanEnv(),
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "NODE_OPTIONS"]) delete env[name];
  return env;
}

// ---------------------------------------------------------------------------
// 判据 3：复用 core（不另立真源、不手写 frontmatter/YAML 解析）
// ---------------------------------------------------------------------------

test("g-315 判据3：sync.ts 只经 core 公开入口读资产，不含第二套解析实现", () => {
  const src = read(join(repoRoot, "core", "cli", "sync.ts"));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const needed of ["recallMemory", "readMemory", "boardProjection", "isHumanActor", "atomicWrite", "discoverGitWorktree"]) {
    assert.ok(code.includes(`./ops.ts`) || code.includes(`../root.ts`), "必须从 core 导入");
    assert.ok(code.includes(needed), `sync 必须复用 core 的 ${needed}（不另立真源）`);
  }
  // 不得自己解析 frontmatter / YAML / 事件流
  assert.doesNotMatch(code, /frontmatter/i, "不得自行实现 frontmatter 解析");
  assert.doesNotMatch(code, /---\\n/, "不得自己拼 frontmatter 分隔符");
  assert.doesNotMatch(code, /events\.jsonl/, "不得自行读事件流（唯一真源之外的第二套来源）");
  assert.doesNotMatch(code, /readdirSync\(.*version/, "不得自己枚举版本目录（必须经 core boardProjection）");
  assert.doesNotMatch(code, /from "yaml"/, "不得引入 YAML 解析器");
  assert.doesNotMatch(code, /writeFileSync|createWriteStream|appendFileSync/, "写入必须只经 core atomicWrite");
});

test("g-315 判据3/6：损坏目标文件 ⇒ sync 非零退出、点名坏文件、两文档零写入（不静默丢弃目标）", () => {
  const sb = makeSandbox("g315-core-semantics");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    writeVersion(root, "v1.0", { id: "v-1", name: "v1.0", status: "planning", created_at: "2026-01-01T00:00:00+08:00" });
    // 一个**合法**目标 + 一个**损坏**目标（frontmatter 非 JSON）。这个组合是关键：
    // 只有合法目标时 sync 成功，只看「是否失败」区分不出「预检生效」还是「恰好没有合法目标」。
    writeGoal(root, join("versions", "v1.0", "goals", "g-1", "goal.md"), { id: "g-1", title: "合法目标", status: "draft" });
    const broken = join(root, "versions", "v1.0", "goals", "g-2", "goal.md");
    mkdirSync(join(root, "versions", "v1.0", "goals", "g-2"), { recursive: true });
    writeFileSync(broken, "---\nnot: [json\n---\n\n## 目标描述\n\n坏目标。\n", "utf8");

    const before = snapshotTree(workspace);
    const bad = runCliProcess(cliSourceEntry, ["sync"], workspace);
    // ① 可判定的非零退出（不是「安静成功」）
    assert.equal(bad.code, EXIT_FAILURE, `损坏目标文件必须非零退出；stdout=${bad.stdout} stderr=${bad.stderr}`);
    // ② 点名坏文件（可据此定位修复；不得只说「有错」）
    assert.match(bad.stdout + bad.stderr, /g-2[/\\]goal\.md/, "错误信息必须点名损坏的目标文件");
    assert.match(bad.stdout + bad.stderr, /无法解析/, "必须说明是「无法解析」，与 goal list 同口径");
    // ③ 两个文档零写入（整体失败，不产生部分写入）
    assert.equal(snapshotTree(workspace), before, "两个文档必须零写入（内容/mtime/inode 全不变）");
    assert.equal(existsSync(join(workspace, "AGENTS.md")), false, "AGENTS.md 不得被创建");
    assert.equal(existsSync(join(workspace, ".claude")), false, ".claude/CLAUDE.md 不得被创建");
    // ④ 不得把坏 frontmatter 的原文片段投影出来（原断言保留：即使有输出也不得伪造内容）
    assert.ok(!readdirSync(workspace).includes("AGENTS.md"), "无输出可投影");

    // ⑤ 同一份看板在 `goal list` 与 `sync` 下口径一致（都判失败并点名同一文件）
    const list = runCliProcess(cliSourceEntry, ["goal", "list"], workspace);
    assert.equal(list.code, EXIT_FAILURE, "goal list 同场景也必须非零退出（口径一致性基线）");
    assert.match(list.stdout + list.stderr, /g-2[/\\]goal\.md/);

    // ⑥ 修好坏目标后必须恢复成功（证明失败确实由该文件引起，而非夹具本身不可写）
    rmSync(broken, { recursive: true, force: true });
    const good = runCliProcess(cliSourceEntry, ["sync"], workspace);
    assert.equal(good.code, EXIT_OK, `移除坏目标后必须成功；stderr=${good.stderr}`);
    const doc = read(join(workspace, "AGENTS.md"));
    assert.ok(doc.includes("g-1"), "合法目标必须被投影");
    assert.ok(!doc.includes('"not"'), "不得把坏 frontmatter 的原文片段投影出来");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 4：区段替换无损 / 无标记追加
// ---------------------------------------------------------------------------

test("g-315 判据4：受控区段替换时，区段外字节级逐字不变（含用户手写内容与行尾）", () => {
  const sb = makeSandbox("g315-replace");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-1", text: "事实一" });
    const head = "# 我的工程约定\n\n- 手写内容 A\r\n- 手写内容 B\n\n\n";
    const tail = "\n\n## 附录（手写）\n\n保留结尾空白   \n\n";
    writeFileSync(join(workspace, "AGENTS.md"), `${head}${renderSyncBlock([{ id: "mem-x", text: "旧", human: true }], [])}${tail}`, "utf8");

    const outsideBefore = extractOutsideBlock(read(join(workspace, "AGENTS.md")))!;
    const r = syncInBoard(workspace);
    assert.equal(r.written.length, 2, "有变更必须写（AGENTS.md 替换区段、CLAUDE.md 新建）");
    const after = read(join(workspace, "AGENTS.md"));
    const outsideAfter = extractOutsideBlock(after)!;
    assert.equal(outsideAfter.prefix, outsideBefore.prefix, "区段之前必须逐字节不变");
    assert.equal(outsideAfter.suffix, outsideBefore.suffix, "区段之后必须逐字节不变");
    assert.equal(outsideBefore.prefix, head, "前缀必须就是用户原文（逐字）");
    assert.equal(outsideBefore.suffix, tail, "后缀必须就是用户原文（逐字）");
    assert.ok(after.includes("mem-1"), "新区段必须已写入");
    assert.ok(!after.includes("mem-x"), "旧区段必须被替换掉");
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据4：无标记时按文档化规则追加（绝不覆盖）；文件缺失/空文件从区段开始", () => {
  const block = renderSyncBlock([{ id: "mem-1", text: "事实", human: false }], []);
  // 缺失
  const none = renderDocument(null, block);
  assert.equal(none.found, false);
  assert.ok(none.text.startsWith(SYNC_MARKERS.begin), "缺失文件从区段开始");
  // 空文件
  const empty = renderDocument("", block);
  assert.ok(empty.text.startsWith(SYNC_MARKERS.begin), "空文件从区段开始");
  // 无尾随换行 ⇒ 补一个换行，绝不黏在用户最后一行上
  const noEol = renderDocument("手写最后一行", block);
  assert.ok(noEol.text.startsWith("手写最后一行\n"), "必须补换行");
  assert.ok(noEol.text.includes(block), "区段必须完整保留");
  // 已有尾随换行 ⇒ 不额外补空行
  const withEol = renderDocument("手写\n", block);
  assert.ok(withEol.text.startsWith("手写\n<!-- dsh-graph:sync:begin -->"), "不得插入额外空行");
  // CRLF 原文：补的行尾与原文一致
  const crlf = renderDocument("手写\r\n", block);
  assert.ok(crlf.text.startsWith("手写\r\n<!-- dsh-graph:sync:begin -->"));
  // 追加规则是**导出常量**（文档化 + 可被使用说明引用）
  assert.match(APPEND_RULE, /追加到文件末尾/);

  // 判据 9：使用说明必须记录写入位置与受控区段规则（否则用户无从判断「我的文件被改了什么」）
  const guide = read(join(repoRoot, "docs", "dsh-graph-guide.md"));
  for (const needed of ["goal-graph sync", "写入位置", "受控区段", "稳定前缀", "无变更不写", "原子写", "dsh-graph:sync:begin"]) {
    assert.ok(guide.includes(needed), `使用说明必须记录 sync 的：${needed}`);
  }
});

test("g-315 判据4：畸形标记（多个/单边/顺序颠倒）⇒ 可判定失败且零写入", () => {
  const cases: Array<[string, string]> = [
    ["双 BEGIN", `${SYNC_MARKERS.begin}\nA\n${SYNC_MARKERS.begin}\nB\n${SYNC_MARKERS.end}\n`],
    ["只有 BEGIN", `头\n${SYNC_MARKERS.begin}\n没有结束\n`],
    ["只有 END", `头\n${SYNC_MARKERS.end}\n`],
    ["顺序颠倒", `${SYNC_MARKERS.end}\n中间\n${SYNC_MARKERS.begin}\n`],
  ];
  for (const [label, text] of cases) {
    assert.throws(
      () => renderDocument(text, "BLOCK"),
      (e: unknown) => e instanceof SyncError && e.code === "marker-malformed",
      `${label} 必须被拒绝`,
    );
  }
  const sb = makeSandbox("g315-marker");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-1", text: "事实" });
    const bad = `手写\n${SYNC_MARKERS.begin}\n`;
    writeFileSync(join(workspace, "AGENTS.md"), bad, "utf8");
    const before = snapshotTree(workspace);
    const r = syncInBoard(workspace);
    assert.ok(r.problems.some((p) => p.code === "marker-malformed"), "必须报标记畸形");
    assert.equal(r.written.length, 0, "不得写任何文件");
    assert.equal(snapshotTree(workspace), before, "磁盘必须逐字节未变");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 5：无变更不写 / 原子写 / 失败不留半文件
// ---------------------------------------------------------------------------

test("g-315 判据5：无变更时 mtime 与 inode 都不变（不写文件）", () => {
  const sb = makeSandbox("g315-nochange");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-1", text: "事实" });
    syncInBoard(workspace);
    const agents = join(workspace, "AGENTS.md");
    const claude = join(workspace, ".claude", "CLAUDE.md");
    const st1 = statSync(agents);
    const st2 = statSync(claude);
    // 稍等，确保若有写入 mtime 一定变化（粗粒度文件系统上的假绿防护）
    const wait = spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1100)"]);
    assert.equal(wait.status, 0);
    const r = syncInBoard(workspace);
    assert.equal(r.written.length, 0, "不得写入");
    assert.equal(r.skipped.length, 2, "两个目标都应是 skipped");
    assert.equal(statSync(agents).mtimeMs, st1.mtimeMs, "AGENTS.md mtime 必须不变");
    assert.equal(statSync(agents).ino, st1.ino, "AGENTS.md inode 必须不变");
    assert.equal(statSync(claude).mtimeMs, st2.mtimeMs, ".claude/CLAUDE.md mtime 必须不变");
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据5：有变更时原子写（临时文件 rename；目录内不留 .tmp-* 残留）", () => {
  const sb = makeSandbox("g315-atomic");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-1", text: "事实一" });
    syncInBoard(workspace);
    const ino1 = statSync(join(workspace, "AGENTS.md")).ino;
    addMemory(root, { id: "mem-2", text: "事实二" });
    const r = syncInBoard(workspace);
    assert.equal(r.written.length, 2, "有变更必须写");
    // rename 语义：新 inode（不是就地覆写）
    assert.notEqual(statSync(join(workspace, "AGENTS.md")).ino, ino1, "必须经 rename 换 inode（原子替换，而非就地截断）");
    // 无半文件残留
    for (const dir of [workspace, join(workspace, ".claude")]) {
      const leftovers = readdirSync(dir).filter((f) => f.startsWith(".tmp-"));
      assert.deepEqual(leftovers, [], `${dir} 不得残留临时文件`);
    }
    assert.ok(read(join(workspace, "AGENTS.md")).includes("mem-2"));
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 6：边界 ⇒ 可读非零退出且不产生部分写入
// ---------------------------------------------------------------------------

test("g-315 判据6：空记忆 / 无 active 版本 ⇒ 退出 0 且给出可读「（无）」说明（不是失败）", () => {
  const sb = makeSandbox("g315-empty");
  try {
    const { workspace } = makeBoard(sb.dir);
    const r = syncInBoard(workspace);
    assert.deepEqual(r.problems, [], "空看板不是失败");
    assert.equal(r.written.length, 2);
    const doc = read(join(workspace, "AGENTS.md"));
    assert.match(doc, /没有常驻记忆/, "空记忆必须可读说明");
    assert.match(doc, /无未发布版本/, "无 active 版本必须可读说明");
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据6：损坏 memory.jsonl ⇒ 非零退出、可读原因，且两个目标一个字节都不写", () => {
  const sb = makeSandbox("g315-corrupt-mem");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-ok", text: "健康条目" });
    // 坏行：core 会静默跳过 ⇒ sync 必须升级为可判定失败
    writeFileSync(join(root, "memory", "memory.jsonl"), "{不是 JSON}\n", { flag: "a" });
    assert.ok(memoryDiagnostics(root).length > 0, "前提：core 的诊断确实识别出坏行");
    const before = snapshotTree(workspace);
    const r = syncInBoard(workspace);
    assert.ok(r.problems.some((p) => p.code === "memory-corrupt"), "必须报损坏记忆");
    assert.equal(r.written.length, 0, "不得写");
    assert.equal(snapshotTree(workspace), before, "必须零字节写入（不产生部分写入）");
    // 可读性：错误信息必须指明文件与行号
    assert.match(r.problems.map((p) => p.message).join("\n"), /memory\.jsonl.*第 2 行|第 2 行/);
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据6：目标目录只读 ⇒ 非零退出，且 AGENTS.md 与 .claude 都不写（不部分写入）", () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    // root 绕过权限位，该用例在 root 下无意义（如实跳过而不是假绿）
    return;
  }
  const sb = makeSandbox("g315-readonly");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-1", text: "事实" });
    writeFileSync(join(workspace, "AGENTS.md"), "手写\n", "utf8");
    chmodSync(workspace, 0o555);
    try {
      const before = snapshotTree(workspace);
      const r = syncInBoard(workspace);
      assert.ok(r.problems.some((p) => p.code === "target-unwritable"), `必须报目录不可写：${JSON.stringify(r.problems)}`);
      assert.equal(r.written.length, 0, "不得写任何文件");
      assert.equal(snapshotTree(workspace), before, "必须不产生部分写入");
    } finally {
      chmodSync(workspace, 0o755);
    }
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据6：目标是目录 / 目标不可读 ⇒ 可判定失败（绝不当作空文件覆盖）", () => {
  const sb = makeSandbox("g315-target-dir");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-1", text: "事实" });
    mkdirSync(join(workspace, "AGENTS.md"));
    const r = syncInBoard(workspace);
    assert.ok(r.problems.some((p) => p.code === "target-is-directory"), "AGENTS.md 是目录必须被拒绝");
    assert.equal(r.written.length, 0);
    assert.equal(existsSync(join(workspace, ".claude")), false, "失败时另一个目标也不得被创建（整体失败）");
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据6：CLI 层退出码（损坏输入 ⇒ 1；非法 --target ⇒ 2；健康 ⇒ 0）", () => {
  const sb = makeSandbox("g315-exit");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-1", text: "事实" });

    const badTarget = runCliProcess(cliSourceEntry, ["sync", "--target", "../evil.md"], workspace);
    assert.equal(badTarget.code, EXIT_USAGE, `非法 --target 必须是用法错误；stderr=${badTarget.stderr}`);
    assert.match(badTarget.stderr, /--target 只接受/);

    const ok = runCliProcess(cliSourceEntry, ["sync"], workspace);
    assert.equal(ok.code, EXIT_OK, `健康看板必须成功；stderr=${ok.stderr}`);
    assert.match(ok.stdout, /\.claude\/CLAUDE\.md\twritten/);
    assert.match(ok.stdout, /AGENTS\.md\twritten/);

    writeFileSync(join(root, "memory", "memory.jsonl"), "{坏行}\n", { flag: "a" });
    const before = snapshotTree(workspace);
    const bad = runCliProcess(cliSourceEntry, ["sync"], workspace);
    assert.equal(bad.code, EXIT_FAILURE, "损坏记忆必须非零退出");
    assert.match(bad.stdout + bad.stderr, /memory\.jsonl/, "必须给出可读原因");
    assert.equal(snapshotTree(workspace), before, "不得产生部分写入");
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据6：看板不属于调用方工作树 ⇒ 拒绝（不替用户猜写哪棵树）", () => {
  const sb = makeSandbox("g315-cross-tree");
  try {
    const a = makeBoardFor(sb.dir, "a");
    const b = makeBoardFor(sb.dir, "b");
    assert.throws(
      () => resolveWorkspaceForSync(b.workspace, a.root),
      (e: unknown) => e instanceof SyncError && e.code === "bad-option",
      "跨树必须拒绝",
    );
    // 同一棵树（连 --root 指向 <ws> 与 <ws>/.dsh-graph 两种写法）都必须解析回 <ws>
    assert.equal(resolveWorkspaceForSync(a.workspace, a.root), a.workspace);
  } finally {
    sb.cleanup();
  }
});

function makeBoardFor(sandboxDir: string, name: string): { workspace: string; root: string } {
  const workspace = join(sandboxDir, name);
  const root = join(workspace, ".dsh-graph");
  mkdirSync(workspace, { recursive: true });
  init(root);
  return { workspace, root };
}

// ---------------------------------------------------------------------------
// 判据 7：反向变异（真源码副本）
// ---------------------------------------------------------------------------

test("g-315 判据7（反向变异·真源码副本）：删掉「无变更不写」守卫 ⇒ 每次 sync 都重写（mtime 变）", () => {
  const sb = makeSandbox("g315-mut-nochange");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-1", text: "事实" });
    const mutation = makeMutationSandbox(sb);
    // 前置：未变异副本必须表现为「无变更不写」
    const pristine = runCliProcess(mutation.entry, ["sync", "--json"], workspace);
    assert.equal(pristine.code, EXIT_OK, pristine.stderr);
    const st0 = statSync(join(workspace, "AGENTS.md")).mtimeMs;
    const again = runCliProcess(mutation.entry, ["sync", "--json"], workspace);
    assert.equal(JSON.parse(again.stdout).changed, 0, "未变异时必须 changed=0");
    assert.equal(statSync(join(workspace, "AGENTS.md")).mtimeMs, st0, "未变异时 mtime 必须不变");

    // 变异：`changed` 恒为 true（等于「每次无脑重写」）
    mutateSource(mutation.file("sync.ts"), "changed: existing === null || rendered.text !== existing", "changed: true");
    const mutated = runCliProcess(mutation.entry, ["sync", "--json"], workspace);
    assert.equal(mutated.code, EXIT_OK, mutated.stderr);
    assert.equal(JSON.parse(mutated.stdout).changed, 2, "变异体应把两个目标都当变更");
    assert.notEqual(statSync(join(workspace, "AGENTS.md")).mtimeMs, st0, "变异体必须重写（⇒ 本套件的 mtime 断言在变异体上变红）");
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据7（反向变异·真源码副本）：关掉「逐字节比较」 ⇒ 前缀稳定性断言在变异体上变红", () => {
  const sb = makeSandbox("g315-mut-prefix");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-a", text: "事实 A" });
    addMemory(root, { id: "mem-b", text: "事实 B" });
    const mutation = makeMutationSandbox(sb);
    const pristine = runCliProcess(mutation.entry, ["sync", "--json"], workspace);
    assert.equal(pristine.code, EXIT_OK, pristine.stderr);
    const prefix1 = extractStablePrefix(read(join(workspace, "AGENTS.md")))!;
    const p2 = runCliProcess(mutation.entry, ["sync", "--json"], workspace);
    assert.equal(JSON.parse(p2.stdout).prefix_sha256, hashOf(prefix1), "未变异时前缀 hash 稳定");

    // 变异：把前缀里注入时间戳（「前缀混入动态数据」的典型退化）
    mutateSource(
      mutation.file("sync.ts"),
      'lines.push("### A. 硬性事实（稳定前缀，勿手改）");',
      'lines.push("### A. 硬性事实（稳定前缀，勿手改）", "", `生成@${Date.now()}`);',
    );
    const m1 = runCliProcess(mutation.entry, ["sync", "--json"], workspace);
    assert.equal(m1.code, EXIT_OK, m1.stderr);
    const prefixM = extractStablePrefix(read(join(workspace, "AGENTS.md")))!;
    assert.notEqual(hashOf(prefixM), hashOf(prefix1), "变异体前缀必须与基线不同（本套件的前缀断言随之变红）");
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据7（反向变异·真源码副本）：去掉「区段外逐字保留」 ⇒ 手写内容被吞（无损断言变红）", () => {
  const sb = makeSandbox("g315-mut-lossless");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-1", text: "事实" });
    const hand = "# 手写标题\n\n必须保留这一行。\n\n";
    writeFileSync(join(workspace, "AGENTS.md"), hand, "utf8");
    const mutation = makeMutationSandbox(sb);
    const pristine = runCliProcess(mutation.entry, ["sync"], workspace);
    assert.equal(pristine.code, EXIT_OK, pristine.stderr);
    assert.ok(read(join(workspace, "AGENTS.md")).startsWith(hand), "未变异时手写内容必须逐字保留");

    // 变异：无标记时「整文件覆盖」成区段（丢掉用户原文）
    mutateSource(
      mutation.file("sync.ts"),
      'return { found: false, text: `${src}${sep}${block}\\n`, previousBlock: null };',
      'return { found: false, text: `${block}\\n`, previousBlock: null };',
    );
    writeFileSync(join(workspace, "AGENTS.md"), hand, "utf8");
    const mutated = runCliProcess(mutation.entry, ["sync"], workspace);
    assert.equal(mutated.code, EXIT_OK, mutated.stderr);
    assert.ok(!read(join(workspace, "AGENTS.md")).startsWith(hand), "变异体必须吞掉手写内容（本套件无损断言变红）");
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据7（反向变异·真源码副本）：关掉「损坏记忆预检」 ⇒ 坏行被静默跳过（判据6 断言变红）", () => {
  const sb = makeSandbox("g315-mut-corrupt");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    addMemory(root, { id: "mem-1", text: "事实" });
    const mutation = makeMutationSandbox(sb);
    const pristine = runCliProcess(mutation.entry, ["sync", "--json"], workspace);
    assert.equal(pristine.code, EXIT_OK, pristine.stderr);

    writeFileSync(join(root, "memory", "memory.jsonl"), "{坏行}\n", { flag: "a" });
    const before = runCliProcess(mutation.entry, ["sync", "--json"], workspace);
    assert.equal(before.code, EXIT_FAILURE, "未变异时必须因坏行失败");

    // 变异：预检永远返回「无问题」
    mutateSource(mutation.file("sync.ts"), "const corrupt = memoryFileProblems(join(root, \"memory\", \"memory.jsonl\"));", "const corrupt: string[] = [];");
    const mutated = runCliProcess(mutation.entry, ["sync", "--json"], workspace);
    assert.equal(mutated.code, EXIT_OK, `变异体应静默成功；stderr=${mutated.stderr}`);
    assert.equal(JSON.parse(mutated.stdout).ok, true, "变异体把损坏输入判为 OK（本套件判据6 断言变红）");
  } finally {
    sb.cleanup();
  }
});

test("g-315 判据7（反向变异·真源码副本）：去掉「目标可解析性预检」 ⇒ 坏目标被静默跳过且 sync 退出 0（判据3/6 断言变红）", () => {
  const sb = makeSandbox("g315-mut-badgoal");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    writeVersion(root, "v1.0", { id: "v-1", name: "v1.0", status: "planning", created_at: "2026-01-01T00:00:00+08:00" });
    writeGoal(root, join("versions", "v1.0", "goals", "g-1", "goal.md"), { id: "g-1", title: "合法目标", status: "draft" });
    const brokenDir = join(root, "versions", "v1.0", "goals", "g-2");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "goal.md"), "---\nnot: [json\n---\n\n## 目标描述\n\n坏目标。\n", "utf8");

    const mutation = makeMutationSandbox(sb);
    // 前置：未变异副本必须先以「坏目标」失败（否则变异对照没有意义）
    const pristine = runCliProcess(mutation.entry, ["sync"], workspace);
    assert.equal(pristine.code, EXIT_FAILURE, `未变异时损坏目标必须非零退出；stdout=${pristine.stdout}`);
    assert.match(pristine.stdout + pristine.stderr, /g-2[/\\]goal\.md/);
    assert.equal(existsSync(join(workspace, "AGENTS.md")), false, "未变异时零写入");

    // 变异：把预检变成「永远无问题」——等价于回到「靠 boardProjection 静默跳过坏目标」的旧行为
    mutateSource(
      mutation.file("sync.ts"),
      "const corruptGoals = goalParseProblems(root);",
      "const corruptGoals: SyncError[] = [];",
    );
    const mutated = runCliProcess(mutation.entry, ["sync", "--json"], workspace);
    // 变异体必须复现评审指出的退化：exit 0 + 坏目标从投影里无声消失
    assert.equal(mutated.code, EXIT_OK, `变异体应静默成功（本套件判据3/6 断言变红）；stderr=${mutated.stderr}`);
    assert.equal(JSON.parse(mutated.stdout).ok, true, "变异体把损坏目标判为 OK");
    const doc = read(join(workspace, "AGENTS.md"));
    assert.ok(doc.includes("g-1"), "变异体仍投影合法目标");
    assert.ok(!doc.includes("g-2"), "变异体把坏目标静默丢弃（正是本预检要防的退化）");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 8：不破坏既有 AGENTS.md 守卫
// ---------------------------------------------------------------------------

test("g-315 判据8：仓库 AGENTS.md 的闸门字面量未被 sync 改动（g350/g353/g408/g415 消费同一文件）", () => {
  const agents = read(join(repoRoot, "AGENTS.md"));
  // 这些字面量由既有守卫断言；sync 若把它们重排/改写会让整套件闸门自证变红。
  for (const literal of [
    "node --test core/tests/*.test.ts",
    "scripts/run-tests.mjs",
    "todo == 0",
    "--test-shard",
    "完成事件",
    "g415-gate-hardening.test.ts",
    "process.exitCode",
    "bash scripts/build.sh",
    "check:dist",
    "node --test core/tests/dist-freshness-g312.test.ts",
  ]) {
    assert.ok(agents.includes(literal), `AGENTS.md 必须仍含既有字面量：${literal}`);
  }
  // 本目标**不**改写仓库自己的 AGENTS.md（写入位置与生成逻辑由测试证明，不靠改仓库文件取证）
  assert.ok(!agents.includes("dsh-graph:sync:begin"), "仓库根 AGENTS.md 不得被本目标提交带有投影区段");
});

test("g-315 判据8：运行在 linked worktree 时写入调用方自己的树，不写主树", () => {
  // 只做纯函数级断言：给定「调用方在 linked worktree、看板归一到主树」，写入位置必须是 worktree 根。
  const sb = makeSandbox("g315-linked");
  try {
    // 造一个真实 git 仓库 + linked worktree（本仓 own repo 太贵，且不能碰真实看板）
    const repo = join(sb.dir, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 60_000, env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    assert.equal(git("init", "-q", "-b", "main").status, 0, "git init 失败（环境不提供 git？）");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    init(join(repo, ".dsh-graph"));
    const wt = join(sb.dir, "wt");
    const added = spawnSync("git", ["-C", repo, "worktree", "add", "-q", wt, "-b", "g-test"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    assert.equal(added.status, 0, `git worktree add 失败：${added.stderr}`);
    mkdirSync(join(wt, ".dsh-graph"), { recursive: true }); // 空骨架（与派发建树的真实形态一致）

    // 看板根被 core 归一到主树时，写入位置仍必须是调用方 worktree。
    const resolved = resolveWorkspaceForSync(wt, join(repo, ".dsh-graph"));
    assert.equal(resolved, wt, "写入位置必须是调用方 worktree 根，而不是主树");
  } finally {
    sb.cleanup();
  }
});
