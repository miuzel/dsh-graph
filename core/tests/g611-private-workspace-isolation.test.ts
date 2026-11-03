/** g-611 隔离回归（独立测试文件，无真实宿主依赖）：
 *
 *  ① `_g611-private-root.ts` 的 guard 必须在**发出任何请求/写入之前** fail-closed（零请求、零副作用）；
 *  ② 私有根的创建必须逐段验证父链无符号链接（注入自有 fake tmp 子树做负向，断言**目录与事件零写**）；
 *  ③ 删除只允许**本进程 owned 集合**内的路径（名字像 `g611-` 的他人路径必须拒绝）；
 *  ④ 路径解析语义必须在**完全私有**的嵌套 Git 主仓 + linked worktree 里复核「工作区不存在 → 已存在」
 *     两阶段与跨运行缓存；旧代码路径（`undefined` 作为 workspace）在私有架构里只会写到**私有 fake 图**。
 *
 *  安全边界：所有写入都在 `<REPO_ROOT>/tmp/g611-tests/<mkdtemp>/`（仓库 git-ignored，g-363 scratch ⇒
 *  resolver workspace-fallback）；**不读取真实看板任何正文**，只做路径比较与自有 sandbox 内扫描；
 *  绝不删除既有 tmp/`undefined`/他人 worktree。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createGoal, init } from "../ops.ts";
import { _clearCanonicalRootCache, resolveCanonicalRoot } from "../root.ts";
import {
  PLUGIN_CONFIG,
  PRIVATE_BASE,
  REPO_ROOT,
  assertPrivateTestRoot,
  createPrivateTestRoot,
  isUnderOrEqual,
  realBoardRoot,
  realMainWorktree,
  removePrivateTestRoot,
  uniqueMarker,
  workspaceQuery,
} from "./_g611-private-root.ts";

const API = "/api/dsh-graph";

/** `git` 只在私有 sandbox 内操作（临时 user/email/无 GPG；无网络、无 credentials）。 */
function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=g611-test", "-c", "user.email=g611-test@invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** 完全私有的嵌套 Git 主仓 + linked worktree（与真实仓库无任何引用关系）。 */
function privateGitPair(tag: string) {
  const sandbox = createPrivateTestRoot(tag);
  const primary = join(sandbox, "fake-primary");
  const linked = join(sandbox, "fake-linked");
  mkdirSync(primary, { recursive: true });
  git(primary, ["init", "-q", "-b", "main"]);
  // 关键：`undefined` **不**被忽略（复现真实仓库的污染条件）；只有看板/工作树目录被忽略。
  writeFileSync(join(primary, ".gitignore"), ".dsh-graph/\n.worktrees/\n");
  writeFileSync(join(primary, "README.md"), "g611 private sandbox\n");
  git(primary, ["add", "-A"]);
  git(primary, ["commit", "-qm", "private baseline"]);
  git(primary, ["worktree", "add", "-q", "--detach", linked]);
  return { sandbox, primary, linked };
}

/** 只在**自有 sandbox** 内按 marker 定位文件（不触碰真实看板/用户资料；深度受限）。 */
function filesMentioning(root: string, marker: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string, depth = 0) => {
    if (depth > 6) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/\.(md|json|jsonl)$/.test(name)) {
        let text = "";
        try {
          text = readFileSync(p, "utf8");
        } catch {
          continue;
        }
        if (text.includes(marker)) hits.push(p);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return hits.sort();
}

test("g-611 G1：guard 在请求之前拒绝一切非私有根 workspace（零请求、零副作用）", () => {
  assert.equal(PLUGIN_CONFIG.root, undefined, "真实宿主夹具必须用空 config（无绝对 root 绕过）");
  let requests = 0;
  /** 计数「请求发送」：guard 抛错时 URL 参数尚未求值 ⇒ 计数必须保持 0。 */
  const send = (path: string) => {
    requests += 1;
    return path;
  };

  const hostile: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["数字", 42],
    ["对象", {}],
    ["空字符串", ""],
    ["纯空白", "   "],
    ["字面量 \"undefined\"", "undefined"],
    ["带空白的 undefined", " undefined "],
    ["相对路径", "tmp/not-private"],
    ["/tmp 下非私有目录", join("/tmp", "g611-not-private")],
    ["真实主看板", realBoardRoot()],
    ["真实主工作树 .worktrees", join(realMainWorktree(), ".worktrees")],
    ["cwd 下的 undefined 路径", join(process.cwd(), "undefined")],
    ["仓库根", REPO_ROOT],
  ];
  for (const [label, badWs] of hostile) {
    assert.throws(
      () => send(`${API}/create-goal${workspaceQuery(badWs, { where: `G1 ${label}`, config: PLUGIN_CONFIG })}`),
      /拒绝使用该测试 workspace/,
      `${label}：必须在请求之前 fail-closed`,
    );
  }
  assert.equal(requests, 0, "任何非私有根都不得真正发出请求");

  // 正向：本次自建私有根 —— **先 guard（未初始化）→ 再 init → 再确认已初始化**。
  const root = createPrivateTestRoot("g1-positive");
  try {
    assert.throws(
      () => assertPrivateTestRoot(root, { where: "G1 未初始化", requireInitialized: true }),
      /尚未由 init\(\) 初始化/,
      "未初始化的私有根不得被当成可用 workspace",
    );
    // 写入之前先证明归属：guard 通过（此时 events.jsonl 尚不存在 ⇒ 目录零写）。
    const preInit = assertPrivateTestRoot(root, { where: "G1 init 前", requireInitialized: false });
    assert.equal(existsSync(join(root, ".dsh-graph")), false, "guard 本身不得创建任何目录（零写）");
    init(preInit.root);
    const info = assertPrivateTestRoot(root, { where: "G1 正向", requireInitialized: true });
    assert.equal(info.workspace, root, "guard 必须回传已校验的私有根");
    assert.equal(info.root, join(root, ".dsh-graph"), "graph root 必须落在私有根下");
    assert.equal(workspaceQuery(root), `?workspace=${encodeURIComponent(root)}`, "query 必须编码携带私有绝对路径");
    assert.ok(!workspaceQuery(root).includes("undefined"), "正向 query 不得出现 undefined");
    // 显式绝对 config.root 会绕过 workspace→root 解析（生产 isAbsoluteConfig）⇒ 必须拒绝。
    assert.throws(
      () => assertPrivateTestRoot(root, { where: "G1 绝对 root 绕过", config: { root: resolve("/tmp", "bypass") } }),
      /绝对路径/,
      "绝对 config.root 必须被拒绝（否则 workspace 校验形同虚设）",
    );
    // 相对 config.root：guard 与生产同一 resolver 调用 ⇒ 期望 root 随之改变（仍必须 workspace-fallback）。
    const rel = assertPrivateTestRoot(root, { where: "G1 相对 root", config: { root: "board-b" } });
    assert.equal(rel.root, join(root, "board-b"), "相对 config.root 的期望值必须与生产 resolver 一致");
  } finally {
    removePrivateTestRoot(root);
  }

  // 删除白名单：只有本进程 owned 集合内、父目录正好是创建 base 的路径才可删。
  const lookalike = join(PRIVATE_BASE, `g611-lookalike-${Date.now()}-${process.pid}`);
  mkdirSync(lookalike, { recursive: true });
  try {
    assert.throws(() => removePrivateTestRoot(lookalike), /owned 集合/, "名字像 g611- 但非本进程自建 ⇒ 必须拒绝");
  } finally {
    rmSync(lookalike, { recursive: true, force: true }); // 测试自己建的对照，测试自己按绝对路径销毁
  }
  assert.throws(() => removePrivateTestRoot(PRIVATE_BASE), /owned 集合|拒绝删除/, "不得删除私有 base 自身");
  assert.throws(() => removePrivateTestRoot(join(REPO_ROOT, "tmp")), /owned 集合|拒绝删除/, "不得删除上层 tmp");
  assert.throws(() => removePrivateTestRoot(realBoardRoot()), /owned 集合|拒绝删除/, "绝不得删除真实看板");
});

test("g-611 G2：私有嵌套主仓 + linked worktree —— 不存在/已存在两阶段、跨运行缓存、旧变异只落私有 fake 图", () => {
  const { sandbox, primary, linked } = privateGitPair("g2-paths");
  const marker = uniqueMarker("g2-old-mutant");
  try {
    // 自有 root 自证：在唯一私有 base 下、realpath 自身；fake 图与真实主图只是**路径不同**（不读内容）。
    assert.ok(resolve(sandbox).startsWith(`${PRIVATE_BASE}/`), "sandbox 必须位于唯一私有 base 之下");
    assert.equal(resolve(sandbox), sandbox, "sandbox 必须是 realpath");

    // 私有架构自证：git 真的认为这是 primary + linked（不涉及真实仓库的 .git）。
    const list = git(linked, ["worktree", "list", "--porcelain"]);
    assert.match(list, new RegExp(`worktree ${primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "primary 在私有 worktree 列表里");
    assert.match(list, new RegExp(`worktree ${linked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "linked 在私有 worktree 列表里");
    assert.equal(git(linked, ["rev-parse", "--show-toplevel"]), linked, "linked 的 toplevel 是它自己");
    const fakeBoard = join(primary, ".dsh-graph");
    assert.equal(existsSync(fakeBoard), false, "前置：私有 fake 图尚未创建");
    assert.notEqual(resolve(fakeBoard), resolve(realBoardRoot()), "前置：fake 图绝不是真实主图");
    assert.ok(isUnderOrEqual(primary, fakeBoard) && isUnderOrEqual(sandbox, primary), "fake 图与 primary 都在自有 sandbox 内");

    // 旧代码形态：workspace = `<linked>/undefined`（host 把字面量 "undefined" 当相对路径）。
    const oldWs = join(linked, "undefined");
    _clearCanonicalRootCache();

    // 阶段 A（首次运行，目录不存在）⇒ git 发现失败 ⇒ workspace-local 回退（仍在私有树内）。
    const a = resolveCanonicalRoot(PLUGIN_CONFIG, oldWs, { ttlMs: 0 });
    assert.equal(a.mode, "workspace-fallback", "目录不存在 ⇒ workspace-local 回退");
    assert.equal(a.root, join(oldWs, ".dsh-graph"), "回退骨架落在私有 linked 树内");
    // 同进程 TTL 缓存先记住 A（模拟同一进程内的先后两次解析）。
    assert.equal(resolveCanonicalRoot(PLUGIN_CONFIG, oldWs).mode, "workspace-fallback", "首次默认 TTL 调用缓存回退");

    // 阶段 B（后续运行，目录已存在）⇒ 同进程缓存仍是 A；新进程/缓存失效后归一到 **私有 fake 主图**。
    mkdirSync(oldWs, { recursive: true });
    assert.equal(resolveCanonicalRoot(PLUGIN_CONFIG, oldWs).mode, "workspace-fallback", "同进程 TTL 内命中旧缓存（stale）");
    _clearCanonicalRootCache();
    const b = resolveCanonicalRoot(PLUGIN_CONFIG, oldWs);
    assert.equal(b.mode, "canonicalized", "目录已存在且未被 ignore ⇒ linked worktree 归一");
    assert.equal(b.root, fakeBoard, "归一目标是私有 fake 主仓的看板");
    assert.notEqual(resolve(b.root), resolve(realBoardRoot()), "归一目标绝不是真实主看板（仅路径比较）");
    assert.ok(isUnderOrEqual(sandbox, b.root), "所有解析结果都落在私有 sandbox 内");

    // 旧夹具行为在私有架构内的等价复现（真实 init/createGoal）：只写进私有 fake 图。
    init(b.root);
    const fakeGoalId = createGoal(b.root, { title: `B3 目标 ${marker}`, actor: "human:gui" });
    assert.ok(existsSync(join(fakeBoard, "backlog", `${fakeGoalId}.md`)), "旧行为的写入落在私有 fake 图");
    const hits = filesMentioning(sandbox, marker);
    assert.ok(hits.length > 0, "私有 fake 图内必须能定位到本次 marker");
    assert.ok(hits.every((h) => isUnderOrEqual(fakeBoard, h)), `marker 只能出现在私有 fake 图内（实得 ${hits.join(", ")}）`);
    assert.ok(hits.every((h) => !isUnderOrEqual(linked, h)), "marker 不得出现在 linked 工作区（旧行为没有写那里）");

    // guard 必须拒绝这条**会被归一**的 workspace（新夹具在这里 fail-closed，而不是悄悄写主图）。
    assert.throws(
      () => assertPrivateTestRoot(oldWs, { where: "G2 旧变异", config: PLUGIN_CONFIG }),
      /workspace-fallback/,
      "guard 必须拒绝会归一到主图的 workspace",
    );
    assert.throws(() => workspaceQuery(oldWs, { config: PLUGIN_CONFIG }), /拒绝使用该测试 workspace/);
  } finally {
    _clearCanonicalRootCache();
    removePrivateTestRoot(sandbox);
  }
});

test("g-611 G3：realpath 不可越界 —— 指向真实看板/外部目录的符号链接一律拒绝", () => {
  const sandbox = createPrivateTestRoot("g3-link");
  try {
    const toBoard = join(sandbox, "link-to-real-board");
    symlinkSync(realBoardRoot(), toBoard);
    assert.throws(
      () => assertPrivateTestRoot(toBoard, { where: "G3 链接真实看板" }),
      /realpath|拒绝使用该测试 workspace/,
      "指向真实看板的符号链接必须被拒绝（realpath 越界）",
    );
    const toTmp = join(sandbox, "link-to-tmp");
    symlinkSync("/tmp", toTmp);
    assert.throws(
      () => assertPrivateTestRoot(toTmp, { where: "G3 链接 /tmp" }),
      /realpath|拒绝使用该测试 workspace/,
      "指向私有 base 之外的符号链接必须被拒绝",
    );
    // 正常私有目录仍通过（不误伤）。
    assert.doesNotThrow(() => assertPrivateTestRoot(sandbox, { where: "G3 正向" }));
  } finally {
    removePrivateTestRoot(sandbox);
  }
});

test("g-611 G4：私有根的父链若是符号链接 ⇒ 创建被拒绝且目录/事件零写（本地负向对照）", () => {
  const fakeRoot = createPrivateTestRoot("g4-fake-root");
  try {
    // 自建 fake 仓库根：`tmp` 是符号链接（指向自有 target），模拟「私有 base 父链被换掉」。
    const target = join(fakeRoot, "target");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(fakeRoot, "tmp"));
    assert.throws(
      () => createPrivateTestRoot("mutant", { repoRoot: fakeRoot }),
      /符号链接/,
      "父链含符号链接时必须在任何写入之前拒绝",
    );
    assert.equal(existsSync(join(target, "g611-tests")), false, "symlink 目标下不得创建私有 base（目录零写）");
    assert.deepEqual(readdirSync(target), [], "symlink 目标目录必须保持空（零写/零事件）");
    assert.equal(existsSync(join(fakeRoot, "tmp", "g611-tests")), false, "经 symlink 也看不到任何 base");

    // 对照：无符号链接的自建 fake root 仍能创建并只删自己 owned 的目录。
    const okFake = join(fakeRoot, "ok");
    mkdirSync(okFake);
    const created = createPrivateTestRoot("ok", { repoRoot: okFake });
    assert.ok(created.startsWith(`${join(okFake, "tmp", "g611-tests")}/`), "对照目录落在自建 fake root 的 tmp 内");
    removePrivateTestRoot(created);
    assert.equal(existsSync(created), false, "owned 对照目录必须被删除");
  } finally {
    removePrivateTestRoot(fakeRoot);
  }
});
