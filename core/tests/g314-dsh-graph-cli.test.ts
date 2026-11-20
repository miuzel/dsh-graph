/**
 * g-314：dsh-graph 核心引擎测试（参数解析 / 路径定位 / 环境容错 / 错误退出码 / 零副作用）。
 *
 * 覆盖判据：
 * - 判据 1：bin 入口在 package.json 注册、可执行、无第三方 CLI 框架/网络/常驻服务依赖；
 * - 判据 3：解析资产复用 core（不复制 frontmatter/事件/状态机/锁逻辑）；
 * - 判据 4：未知命令、缺参、非法路径、非工作区、未初始化、损坏配置 ⇒ 可读非零退出且零副作用；
 * - 判据 5：默认向上查找 .dsh-graph、--root 绝对/相对、拒绝越界、不误用用户全局配置；
 * - 判据 6：info 报告 Node 版本 / root / 初始化状态 / 关键文件可读性，且不写任何文件；
 * - 判据 7：含**反向变异**对照（把关键守卫改坏 ⇒ 本套件断言必红）。
 *
 * 全部夹具建在仓库 `tmp/` 下的**私有 mkdtemp 目录**（AGENTS.md 规定的临时区），
 * 用后清理；绝不触碰真实看板数据。
 *
 * 反向变异口径（att-002 收口，按独立评审注记）：危险路径守卫与退出码这两条**不用本地闭包**
 * 伪造（闭包变异是**同义反复**——生产代码被改坏时它们照样通过），而是把**真实源码**（`core/cli/*.ts`
 * + 入口 `bin/dsh-graph.mjs`）复制进 `tmp/` 沙箱、就地改坏关键行，再用该副本的真进程执行断言。
 * 零副作用（内容哈希快照）与入口缺失两条原本即真变异，保留。
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
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { parseArgs } from "../cli/args.ts";
import { findGraphWorkspace, isPathWithin, locateGraphRoot, LocateError } from "../cli/locate.ts";
import { collectHealth, collectStatus, listGoals, showGoal } from "../cli/diagnostics.ts";
import { runCli, EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../cli/main.ts";
import { init } from "../ops.ts";

const repoRoot = join(import.meta.dirname, "../..");
const tmpRoot = join(repoRoot, "tmp");
const cliSourceEntry = join(repoRoot, "bin", "goal-graph.mjs");
const cliDistEntry = join(repoRoot, "dist", "bin", "goal-graph.mjs");

/** 在仓库 tmp/ 下建一个用后即删的私有目录。 */
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

/**
 * 仓库**之外**的沙箱：仅用于「非工作区」场景。
 *
 * 为什么不能复用仓库内 tmp/：向上查找会穿过 tmp/ → 工作树 → 仓库根，最终命中**真实**
 * 看板（.dsh-graph 在仓库根），于是「非工作区」永远不会成立。真实用户场景里被测目录
 * 通常也不在某个看板子树内，故这里用系统临时目录（os.tmpdir()，WSL2 下可写）精确复现
 * 「向上直到文件系统根都没有 .dsh-graph」。用后即删。
 */
function makeOutsideSandbox(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
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

/** 建一个**已初始化**的看板骨架（复用 core 的 init，不手写骨架）。 */
function makeBoard(sandboxDir: string): { workspace: string; root: string } {
  const workspace = join(sandboxDir, "ws");
  const root = join(workspace, ".dsh-graph");
  mkdirSync(workspace, { recursive: true });
  init(root);
  return { workspace, root };
}

/** 写一个最小合法目标文件（frontmatter 是 JSON，由 core 的 parseDoc 读取）。 */
function writeGoal(root: string, rel: string, meta: Record<string, unknown>, body = "\n## 目标描述\n\n测试目标。\n"): void {
  const file = join(root, rel);
  const text = `---\n${JSON.stringify(meta, null, 2)}\n---\n${body}`;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text, "utf8");
}

/**
 * 整棵目录树的快照（用于「零副作用」断言）。
 *
 * 必须含**内容哈希 + inode/mtime**：只比 size+mtime 会漏掉「写回与原内容相同的字节」这类
 * 副作用（反向变异实测：写 `index.json` 为 `{}` 时旧的 size/mtime 口径被判绿 —— 假阴性）。
 */
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
        const digest = createHash("sha256").update(readFileSync(p)).digest("hex");
        out.push(`${p}|f|${st.size}|${st.mtimeMs}|${st.ino}|${digest}`);
      }
    }
  };
  walk(dir);
  return out.join("\n");
}

function runCliInProcess(argv: string[], cwd: string, version = "0.0.0-test") {
  return runCli(argv, { version, cwd });
}
/** 同步 CLI 已异步化（惰性加载 diagnostics）：断言处统一 await。 */
const cli = runCliInProcess;

/** 真进程执行 CLI（入口形态验证用）：返回 { code, stdout, stderr }。 */
function runCliProcess(entry: string, argv: string[], cwd: string) {
  const res = spawnSync(process.execPath, [entry, ...argv], { cwd, encoding: "utf8", timeout: 60_000 });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** 变异体真进程执行：额外注入 env（用于 HOME / DSH_HOME 场景），并剔除测试继承的注入变量。 */
function runCliProcessEnv(entry: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "NODE_OPTIONS"]) delete childEnv[name];
  const res = spawnSync(process.execPath, [entry, ...argv], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...childEnv, ...env },
  });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * 在沙箱里铺一份**真实源码副本**（`core/` 全量 + 入口 `bin/dsh-graph.mjs`）。
 *
 * 为什么整套复制 `core`：CLI 的模块图是 `core/cli/{args,locate,health,diagnostics,main}.ts`，再经
 * `../root.ts` / `../ops.ts` / `../events.ts` / `../domain/*` 等**相对导入**展开成整个 core 模块图。
 * 只复制被变异的那一个文件会缺兄弟导入 —— 变异体根本不是可运行程序，结论无意义（实测报
 * `Cannot find module '…/core/root.ts'`）。复制整棵 `core/`（tests 除外，体积大且无关）后，
 * 相对导入在沙箱内自洽，且**被测行为仍来自真实生产源码**（仅变异行不同）。
 *
 * 入口按 `bin/dsh-graph.mjs` 的候选顺序（`../core/cli/main.js` → `../core/cli/main.ts`）加载，
 * 故沙箱布局必须是 `<sandbox>/bin/dsh-graph.mjs` + `<sandbox>/core/cli/*.ts`。
 */
function makeMutationSandbox(sb: { dir: string }) {
  const binDir = join(sb.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  cpSync(join(repoRoot, "core"), join(sb.dir, "core"), {
    recursive: true,
    filter: (src) => !src.startsWith(join(repoRoot, "core", "tests")),
  });
  cpSync(cliSourceEntry, join(binDir, "goal-graph.mjs"));
  return {
    entry: join(binDir, "goal-graph.mjs"),
    file(rel: string): string {
      return join(sb.dir, "core", "cli", rel);
    },
  };
}

/**
 * 把 `file` 中的 `from` **就地**替换成 `to`，并断言**恰好命中一处**。
 *
 * 命中数必须为 1：否则「变异」可能落在注释/无关分支上，或干脆没生效 —— 那样失败可能是别的原因
 * 造成的（假阳性对照）。
 */
function mutateSource(file: string, from: string, to: string): void {
  const src = readFileSync(file, "utf8");
  const hits = src.split(from).length - 1;
  assert.equal(hits, 1, `变异锚点必须恰命中 1 处（${file} ← ${JSON.stringify(from)}），实际命中 ${hits}`);
  writeFileSync(file, src.replace(from, to), "utf8");
}

// ---------------------------------------------------------------------------
// 判据 1：入口与 bin 注册（无第三方 CLI 框架 / 网络 / 常驻服务）
// ---------------------------------------------------------------------------

test("g-314 判据 1：bin 入口源码存在，dist 形态由 build.sh 复制且 package.json 注册 bin", async () => {
  assert.ok(existsSync(cliSourceEntry), "仓库根 bin/goal-graph.mjs 必须存在（源码形态入口）");
  const buildScript = readFileSync(join(repoRoot, "scripts", "build.sh"), "utf8");
  // 入口的发布形态必须由构建脚本生成（dist/ 是生成物，禁止手改）。
  assert.match(
    buildScript,
    /^cp bin\/goal-graph\.mjs dist\/bin\/goal-graph\.mjs$/m,
    "build.sh 必须把 bin/goal-graph.mjs 复制到 dist/bin/goal-graph.mjs（仓库相对字面形态，供 dist-freshness 逐字对账）",
  );
  assert.match(
    buildScript,
    /ln -s "\$REPO_ROOT\/bin" "\$STAGE_ROOT\/bin"/,
    "暂存根内必须有 bin/ 同构软链，使步骤 3 的相对源路径成立",
  );
  // bin 字段由**源** dsh-graph-host/package.json 提供（build 只复制入口文件，不新增顶层键）。
  const hostPkg = JSON.parse(readFileSync(join(repoRoot, "dsh-graph-host", "package.json"), "utf8"));
  assert.deepEqual(hostPkg.bin, { "goal-graph": "./bin/goal-graph.mjs" }, "源 dsh-graph-host/package.json 必须声明 bin.goal-graph");

  const distPkgPath = join(repoRoot, "dist", "package.json");
  assert.ok(existsSync(distPkgPath), "请先运行 bash scripts/build.sh");
  const distPkg = JSON.parse(readFileSync(distPkgPath, "utf8"));
  assert.deepEqual(distPkg.bin, { "goal-graph": "./bin/goal-graph.mjs" }, "dist/package.json 必须注册 bin.goal-graph");
  assert.ok(existsSync(cliDistEntry), "dist/bin/goal-graph.mjs 必须由构建产出");

  // 入口不得引入任何第三方 CLI 框架：只允许 node 内置 + 本仓 core。
  const entrySrcRaw = readFileSync(cliSourceEntry, "utf8");
  const entrySrc = entrySrcRaw.replace(/^#!.*\n/, "");
  // runAndPrint 是 async：入口若漏了 await，会把 Promise 赋给 process.exitCode
  // （实测 ERR_INVALID_ARG_TYPE + 「成功命令」退出 1），故把这一条钉成静态断言。
  assert.match(
    entrySrcRaw,
    /await mod\.runAndPrint\(/,
    "入口必须 await runAndPrint（async 签名，漏 await 会让成功命令退出 1）",
  );
  const bareImports = [...entrySrc.matchAll(/from\s+"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith("node:") && !spec.startsWith(".") && spec !== "node:fs");
  assert.deepEqual(bareImports, [], `入口不得引入第三方模块（第三方 CLI 框架/网络库），实际：${bareImports.join(", ")}`);

  // 无网络：CLI 源码不得出现 http/net/dns/fetch 等网络调用面。
  for (const rel of ["core/cli/args.ts", "core/cli/locate.ts", "core/cli/diagnostics.ts", "core/cli/main.ts"]) {
    const src = readFileSync(join(repoRoot, rel), "utf8");
    assert.doesNotMatch(src, /node:(http|https|net|dns|tls)["']|\bfetch\s*\(/, `${rel} 不得使用网络能力`);
  }
});

test("g-314 判据 1：dist 入口真进程可执行（version / help 退出 0，不依赖常驻服务）", async () => {
  assert.ok(existsSync(cliDistEntry), "请先运行 bash scripts/build.sh");
  const sb = makeSandbox("g314-entry");
  try {
    const v = runCliProcess(cliDistEntry, ["version"], sb.dir);
    assert.equal(v.code, EXIT_OK, `version 应退出 0，实际 ${v.code}；stderr=${v.stderr}`);
    assert.match(v.stdout, /^goal-graph \d+\.\d+\.\d+/, "version 输出应含版本号");
    const h = runCliProcess(cliDistEntry, ["help"], sb.dir);
    assert.equal(h.code, EXIT_OK);
    assert.match(h.stdout, /用法：/);
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

test("g-314 参数解析：命令 / 子命令 / 位置参数 / 选项（含 --root=x 与选项前置）", async () => {
  assert.equal(parseArgs(["info"]).args?.command, "info");
  assert.equal(parseArgs(["goal", "list"]).args?.subcommand, "list");
  assert.deepEqual(parseArgs(["goal", "show", "g-1"]).args?.positionals, ["g-1"]);
  assert.equal(parseArgs(["--root", "/a/b", "info"]).args?.root, "/a/b");
  assert.equal(parseArgs(["--root=/a/b", "info"]).args?.root, "/a/b");
  assert.equal(parseArgs(["info", "--root", "rel/path"]).args?.root, "rel/path");
  assert.equal(parseArgs(["--json", "status"]).args?.json, true);
  assert.equal(parseArgs(["goal", "list", "--all"]).args?.all, true);
  assert.equal(parseArgs(["goal", "list", "-a"]).args?.all, true);
  assert.equal(parseArgs(["--version"]).args?.command, "version", "--version 无命令时等价 version");
  assert.equal(parseArgs(["--help"]).args?.command, "help");
  // `--` 之后的 token 一律是位置参数（不当作选项）
  assert.equal(parseArgs(["goal", "list", "--", "--json"]).error?.code, "unexpected-argument");
});

test("g-314 参数解析（负向）：未知命令 / 未知选项 / 缺值 / 缺参 / 多余参数均给结构化错误", async () => {
  const cases: Array<[string[], string]> = [
    [[], "missing-command"],
    [["bogus"], "unknown-command"],
    [["info", "--bogus"], "unknown-option"],
    [["--root"], "missing-value"],
    [["--root="], "missing-value"],
    [["--root", "--json", "info"], "missing-value"],
    [["--root", "a", "--root", "b", "info"], "unexpected-argument"],
    [["goal"], "missing-argument"],
    [["goal", "bogus"], "unknown-command"],
    [["goal", "show"], "missing-argument"],
    [["goal", "list", "extra"], "unexpected-argument"],
    [["info", "extra"], "unexpected-argument"],
  ];
  for (const [argv, code] of cases) {
    const r = parseArgs(argv);
    assert.equal(r.args, null, `${JSON.stringify(argv)} 不应解析成功`);
    assert.equal(r.error?.code, code, `${JSON.stringify(argv)} 应报 ${code}，实际 ${r.error?.code}`);
    assert.ok((r.error?.message ?? "").length > 0, `${JSON.stringify(argv)} 错误信息不得为空`);
  }
});

// ---------------------------------------------------------------------------
// 路径定位（判据 5）
// ---------------------------------------------------------------------------

test("g-314 判据 5：默认从 cwd 向上查找 .dsh-graph（含多层嵌套子目录）", async () => {
  const sb = makeSandbox("g314-locate");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    const deep = join(workspace, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    assert.equal(findGraphWorkspace(deep), workspace);
    const located = locateGraphRoot({ cwd: deep });
    assert.equal(located.root, root);
    assert.equal(located.explicit, false);
  } finally {
    sb.cleanup();
  }
});

test("g-314 判据 5：--root 支持相对与绝对路径；相对以 cwd 为基准", async () => {
  const sb = makeSandbox("g314-root");
  try {
    const { workspace } = makeBoard(sb.dir);
    const abs = locateGraphRoot({ cwd: workspace, root: join(workspace, ".dsh-graph") });
    assert.equal(abs.explicit, true);
    assert.ok(abs.root.endsWith(".dsh-graph"));

    // 从 workspace 内的子目录用相对路径指回 .dsh-graph
    const sub = join(workspace, "a");
    mkdirSync(sub, { recursive: true });
    // `cd <ws>/a && dsh-graph --root ../.dsh-graph`：`.dsh-graph` 是 cwd 的**兄弟**，属典型合法用法
    // （过度设计的「必须包含关系」判据会把它误杀 —— 真实单测当场报红过，故这里是回归锚点）。
    const rel = locateGraphRoot({ cwd: sub, root: "../.dsh-graph" });
    assert.equal(rel.root, abs.root, "相对 --root 必须以 cwd 为基准解析（兄弟目录写法必须被接受）");

    // 相对路径指向上级 workspace 本身（core 的 canonical 解析补出 .dsh-graph）
    const up = locateGraphRoot({ cwd: sub, root: ".." });
    assert.equal(up.root, join(workspace, ".dsh-graph"), "指向 workspace 时 core 的 canonical 解析应给出其 .dsh-graph");

  } finally {
    sb.cleanup();
  }
});

test("g-314 判据 5（负向）：越界 / 不存在 / 非目录 / 空值 一律 LocateError，绝不回落到全局配置", async () => {
  const sb = makeSandbox("g314-escape");
  try {
    const { workspace } = makeBoard(sb.dir);
    // 「危险路径」红线（判据 5）：系统根 / 家目录根 / $DSH_HOME 全局配置目录。
    const forbid = (root: string) => {
      const saved = process.env.DSH_HOME;
      process.env.DSH_HOME = join(workspace, "global-home");
      mkdirSync(join(workspace, "global-home"), { recursive: true });
      try {
        locateGraphRoot({ cwd: workspace, root });
        return null;
      } catch (e) {
        return e as LocateError;
      } finally {
        if (saved === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = saved;
      }
    };

    const sysRoot = forbid("/");
    assert.ok(sysRoot instanceof LocateError, "文件系统根必须被拒绝");
    assert.equal(sysRoot?.code, "root-forbidden");
    assert.match(sysRoot.message, /系统根|家目录/);

    // 家目录：必须**真的改** process.env.HOME（att-002 前的用例只存不取，等于空转）。
    // 天然 HOME（沙箱内）与「HOME 指向 workspace」两种取值都要覆盖，且 finally 恢复原值。
    for (const label of ["沙箱内 artificial HOME", "HOME 指向 workspace（家目录即该目录）"] as const) {
      const homeDir = label.startsWith("HOME 指向") ? workspace : join(sb.dir, "home", "alice");
      mkdirSync(homeDir, { recursive: true });
      const savedHome = process.env.HOME;
      process.env.HOME = homeDir;
      try {
        assert.equal(process.env.HOME, homeDir, "必须真的改到 process.env.HOME（否则用例是空转）");
        const e = forbid(homeDir);
        assert.equal(e?.code, "root-forbidden", `${label}：家目录本身必须被拒绝，实际 ${e?.code}`);
        assert.match(e?.message ?? "", /家目录/, `${label}：错误文案必须点名家目录`);
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
      }
    }
    assert.notEqual(process.env.HOME, join(sb.dir, "home", "alice"), "HOME 必须在 finally 中恢复");

    // $DSH_HOME 全局配置目录（及其**子目录**）一律不得作为看板根 —— 子目录也要真建出来，
    // 否则会被 root-not-found 抢先命中（不是「被危险路径守卫拒绝」，断言就失真）。
    const cfgHome = join(workspace, "global-home");
    const cfgSub = join(cfgHome, "workspaces", "proj");
    mkdirSync(cfgSub, { recursive: true });
    for (const [label, target] of [
      ["$DSH_HOME 本身", cfgHome],
      ["$DSH_HOME 子目录", cfgSub],
    ] as const) {
      const e = forbid(target);
      assert.equal(e?.code, "root-forbidden", `${label} 必须被拒绝，实际 ${e?.code}`);
      assert.match(e?.message ?? "", /全局配置/, `${label} 的文案必须点名全局配置目录`);
      assert.ok(e?.message.includes(cfgHome), `${label} 的文案必须点名具体的 $DSH_HOME 路径`);
    }

    // 符号链接根：**运行期**断言（不只靠源码里那段 lstat）。指向该沙箱内的真实空目录，
    // 无论 fn 名是 `target/..` 两个分量，还是会解析成 `target`，空目录都不可能被当成合法看板。
    const symTarget = join(sb.dir, "sym-target");
    mkdirSync(symTarget, { recursive: true });
    const symPath = join(sb.dir, "sym-root");
    symlinkSync(symTarget, symPath, "dir");
    assert.ok(lstatSync(symPath).isSymbolicLink(), "夹具前置：sym-root 必须是符号链接");
    const symLinked = (() => {
      try {
        locateGraphRoot({ cwd: workspace, root: symPath });
        return null;
      } catch (e) {
        return e as LocateError;
      }
    })();
    assert.ok(symLinked instanceof LocateError, `符号链接根必须被拒绝，实际被接受`);
    assert.equal(symLinked.code, "root-symlink", `符号链接根必须报 root-symlink，实际 ${symLinked.code}`);
    assert.match(symLinked.message, /符号链接/);

    const notFound = (() => {
      try {
        locateGraphRoot({ cwd: workspace, root: join(workspace, "nope") });
        return null;
      } catch (e) {
        return e as LocateError;
      }
    })();
    assert.equal(notFound?.code, "root-not-found");

    const file = join(workspace, "file.txt");
    writeFileSync(file, "x");
    const notDir = (() => {
      try {
        locateGraphRoot({ cwd: workspace, root: file });
        return null;
      } catch (e) {
        return e as LocateError;
      }
    })();
    assert.equal(notDir?.code, "not-a-directory");

    const empty = (() => {
      try {
        locateGraphRoot({ cwd: workspace, root: "   " });
        return null;
      } catch (e) {
        return e as LocateError;
      }
    })();
    assert.equal(empty?.code, "empty-root");

    // 非工作区：向上直到根都没有 .dsh-graph ⇒ graph-not-found（**不**回落 ~/.dsh / $DSH_HOME）。
    // 夹具必须独立于 board 沙箱：同沙箱内的 `ws/.dsh-graph` 会被向上查找命中。
    const bareSb = makeOutsideSandbox("g314-nows");
    try {
      const noBoard = (() => {
        try {
          locateGraphRoot({ cwd: bareSb.dir });
          return null;
        } catch (e) {
          return e as LocateError;
        }
      })();
      assert.equal(noBoard?.code, "graph-not-found", "非工作区必须报 graph-not-found");
    } finally {
      bareSb.cleanup();
    }
  } finally {
    sb.cleanup();
  }
});

test("g-314 判据 5：isPathWithin 按路径段判定（前缀同名目录不算包含）", async () => {
  assert.equal(isPathWithin("/a/b", "/a/b/c"), true);
  assert.equal(isPathWithin("/a/b", "/a/b"), true);
  assert.equal(isPathWithin("/a/b", "/a/bc"), false, "/a/bc 不是 /a/b 的子路径");
  assert.equal(isPathWithin("/a/b", "/x/y"), false);
});

// ---------------------------------------------------------------------------
// 命令解析 + 状态诊断 + 错误退出码（判据 4）
// ---------------------------------------------------------------------------

test("g-314 判据 4：退出码分层（0 成功 / 1 运行期失败 / 2 用法错误）", async () => {
  const sb = makeSandbox("g314-exit");
  try {
    const { workspace } = makeBoard(sb.dir);
    writeGoal(join(workspace, ".dsh-graph"), "backlog/g-1.md", { id: "g-1", title: "甲", status: "draft", type: "task" });

    assert.equal((await runCliInProcess(["version"], sb.dir)).exitCode, EXIT_OK);
    assert.equal((await runCliInProcess(["info"], workspace)).exitCode, EXIT_OK);
    assert.equal((await runCliInProcess(["status"], workspace)).exitCode, EXIT_OK);
    assert.equal((await runCliInProcess(["goal", "list"], workspace)).exitCode, EXIT_OK);

    // 用法错误 ⇒ 2
    for (const argv of [["bogus"], [], ["goal"], ["goal", "show"], ["info", "--nope"]]) {
      const r = await runCliInProcess(argv, workspace);
      assert.equal(r.exitCode, EXIT_USAGE, `${JSON.stringify(argv)} 应退出 ${EXIT_USAGE}，实际 ${r.exitCode}`);
      assert.ok(r.stderr.length > 0, `${JSON.stringify(argv)} 必须有可读 stderr`);
      assert.equal(r.stdout, "", `${JSON.stringify(argv)} 用法错误不得写 stdout`);
    }

    // 非工作区夹具：**必须**在 board 沙箱之外，否则向上查找会命中沙箱内的 ws/.dsh-graph。
    const bare = makeOutsideSandbox("g314-bare");
    try {
      // 运行期失败 ⇒ 1
      for (const [argv, cwd] of [
        [["info"], bare.dir], // 非工作区（向上直到根都没有 .dsh-graph）
        [["goal", "show", "g-999"], workspace], // 目标不存在
        [["--root", "/", "info"], workspace], // 危险路径：系统根
      ] as Array<[string[], string]>) {
        const r = await runCliInProcess(argv, cwd);
        assert.equal(r.exitCode, EXIT_FAILURE, `${JSON.stringify(argv)} 应退出 ${EXIT_FAILURE}，实际 ${r.exitCode}`);
        assert.ok(r.stderr.length > 0);
      }
    } finally {
      bare.cleanup();
    }
  } finally {
    sb.cleanup();
  }
});

test("g-314 判据 4：未初始化 / 损坏配置 均可读非零退出", async () => {
  const sb = makeSandbox("g314-damaged");
  try {
    // 未初始化：只有空目录，没有 events.jsonl
    const emptyRoot = join(sb.dir, "emptyws", ".dsh-graph");
    mkdirSync(emptyRoot, { recursive: true });
    const notInit = await runCliInProcess(["status"], join(sb.dir, "emptyws"));
    assert.equal(notInit.exitCode, EXIT_FAILURE, "未初始化必须非零退出");
    assert.match(notInit.stdout, /initialized:\s+no/, "必须如实报告未初始化");

    // 损坏事件流：一行非法 JSON
    const { workspace, root } = makeBoard(sb.dir);
    writeFileSync(join(root, "events.jsonl"), '{"event":"x"}\nNOT-JSON\n', "utf8");
    const badEvents = await runCliInProcess(["status"], workspace);
    assert.equal(badEvents.exitCode, EXIT_FAILURE, "事件流损坏必须非零退出");
    assert.match(badEvents.stdout, /事件流不可解析/, "必须给出可读原因");

    // 损坏 project.yaml（YAML 结构性畸形）
    const { workspace: ws2, root: root2 } = makeBoard(join(sb.dir, "two"));
    writeFileSync(join(root2, "project.yaml"), "executor: {provider: [unclosed\n", "utf8");
    const badCfg = await runCliInProcess(["status"], ws2);
    assert.equal(badCfg.exitCode, EXIT_FAILURE, "损坏 project.yaml 必须非零退出");
    assert.match(`${badCfg.stdout}${badCfg.stderr}`, /project\.yaml/, "必须点名 project.yaml");
  } finally {
    sb.cleanup();
  }
});

test("g-314 判据 4：损坏的目标 frontmatter 不致命但被点名（goal list 非零且列出问题）", async () => {
  const sb = makeSandbox("g314-badgoal");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    writeGoal(root, "backlog/g-1.md", { id: "g-1", title: "好的", status: "draft", type: "task" });
    writeFileSync(join(root, "backlog", "g-2.md"), "没有 frontmatter\n", "utf8");
    const r = await runCliInProcess(["goal", "list"], workspace);
    assert.equal(r.exitCode, EXIT_FAILURE, "存在损坏目标文件时应非零退出");
    assert.match(r.stdout, /g-1/, "好的目标仍应列出");
    assert.match(r.stdout, /目标文件不可解析/);
  } finally {
    sb.cleanup();
  }
});

test("g-314 判据 4（零副作用）：所有失败路径与只读命令都不修改看板目录树", async () => {
  const sb = makeSandbox("g314-noside");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    writeGoal(root, "backlog/g-1.md", { id: "g-1", title: "甲", status: "draft", type: "task" });
    const before = snapshotTree(root);
    const commands: Array<[string[], string]> = [
      [["info"], workspace],
      [["status"], workspace],
      [["goal", "list"], workspace],
      [["goal", "show", "g-1"], workspace],
      [["version"], workspace],
      [["help"], workspace],
      [["bogus"], workspace],
      [["goal", "show"], workspace],
      [["info"], sb.dir],
      [["goal", "show", "nope"], workspace],
    ];
    for (const [argv, cwd] of commands) {
      await runCliInProcess(argv, cwd);
    }
    assert.equal(snapshotTree(root), before, "任何命令都不得修改看板目录（不 init、不记事件、不建目录）");
  } finally {
    sb.cleanup();
  }
});

test("g-314 判据 4：事件流**中间行**损坏同样判红（快路径不得跳过任何一行）", async () => {
  const sb = makeSandbox("g314-midline");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    // 首行合法、中间行非法、末行合法 —— 只校验首末行/抽样的实现会漏检。
    const good = (i: number) =>
      JSON.stringify({ ts: "2026-01-01T00:00:00+08:00", actor: "core", event: "goal.created", details: { i } });
    const lines = [good(1), good(2), "{ 这行不是 JSON", good(4), good(5)];
    writeFileSync(join(root, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
    const r = await runCliInProcess(["status"], workspace);
    assert.equal(r.exitCode, EXIT_FAILURE, "中间行损坏必须非零退出");
    assert.match(r.stdout, /事件流不可解析/, "必须给出可读原因");
    assert.match(r.stdout, /第 3 行/, "必须点名具体行号（交 core 权威解析）");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 6：环境自检
// ---------------------------------------------------------------------------

test("g-314 判据 6：info 报告 Node 版本 / root / 初始化状态 / 关键文件可读性", async () => {
  const sb = makeSandbox("g314-info");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    const before = snapshotTree(root);
    const r = await runCliInProcess(["info"], workspace);
    assert.equal(r.exitCode, EXIT_OK);
    assert.equal(snapshotTree(root), before, "info 不得写任何文件");
    assert.match(r.stdout, new RegExp(`node:\\s+${process.version.replace(/\./g, "\\.")}`));
    assert.match(r.stdout, new RegExp(`graph root:\\s+${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(r.stdout, /initialized:\s+yes/);
    for (const f of ["project.yaml", "events.jsonl", "index.json", "rules.md"]) {
      assert.ok(r.stdout.includes(f), `info 必须报告关键文件 ${f}`);
    }

    // --json 形态必须给出结构化字段
    const j = await runCliInProcess(["info", "--json"], workspace);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.nodeVersion, process.version);
    assert.equal(parsed.root, root);
    assert.equal(parsed.initialized, true);
    assert.ok(Array.isArray(parsed.files) && parsed.files.length >= 4);
  } finally {
    sb.cleanup();
  }
});

test("g-314 判据 6：关键文件不可读/缺失时如实标注（缺失=缺省，损坏=不可读+原因）", async () => {
  const sb = makeSandbox("g314-probe");
  try {
    const { root } = makeBoard(sb.dir);
    // index.json 损坏 ⇒ 不可读 + 原因
    writeFileSync(join(root, "index.json"), "{ broken", "utf8");
    const health = collectHealth({ root, workspace: sb.dir, mode: "main-tree" });
    const idx = health.files.find((f) => f.path === "index.json");
    assert.equal(idx?.exists, true);
    assert.equal(idx?.readable, false, "损坏的 index.json 必须被判不可读");
    assert.ok((idx?.error ?? "").length > 0, "不可读必须带原因");
    // project.yaml 缺失 ⇒ exists=false 但不算错误
    const cfg = health.files.find((f) => f.path === "project.yaml");
    assert.equal(cfg?.exists, false, "缺失的 project.yaml 按缺省处理（core init 不建该文件）");
    assert.equal(cfg?.readable, false);
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 3：复用 core（不复制 frontmatter / 事件 / 状态机 / 锁逻辑）
// ---------------------------------------------------------------------------

test("g-314 判据 3：CLI 模块只通过 core 的公开入口读资产，不自己实现 frontmatter/事件解析", async () => {
  const cliDir = join(repoRoot, "core", "cli");
  const files = ["args.ts", "locate.ts", "diagnostics.ts", "main.ts"];
  /** 剥掉注释（块注释与行注释），只对**可执行代码**做负向断言（注释里提名词不算复制实现）。 */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const rel of files) {
    const src = stripComments(readFileSync(join(cliDir, rel), "utf8"));
    // 不得自己解析 frontmatter（--- 分隔 + JSON）；不得自己读 events.jsonl 行
    assert.doesNotMatch(src, /frontmatter/i, `${rel} 的**可执行代码**不得自行实现 frontmatter 解析`);
    // 允许 `events.jsonl` 作为**文件路径**出现在 existsSync/探针里；禁止的是自行解析其行内容。
    assert.doesNotMatch(
      src,
      /readFileSync\(\s*join\([^)]*"events\.jsonl"[^)]*\)[^)]*\)[\s\S]{0,120}JSON\.parse/,
      `${rel} 不得自行解析 events.jsonl 的行（须经 core readEvents）`,
    );
    assert.doesNotMatch(src, /JSON\.parse\([^)]*frontmatter/, `${rel} 不得自行反序列化 frontmatter`);
    // 不得自带锁/CAS 语义
    assert.doesNotMatch(src, /withMemoryLock|CAS|compareAndSwap|flock|lockfile/i, `${rel} 不得复制锁/CAS 逻辑`);
    // 不得复制状态机
    assert.doesNotMatch(src, /assertTransition|\bSTATUSES\b/, `${rel} 不得复制状态机`);
  }
  // 正面断言：diagnostics 必须经由 core 的 ops/events 入口
  const diag = readFileSync(join(cliDir, "diagnostics.ts"), "utf8");
  for (const needed of ["listGoalFiles", "loadGoal", "findGoalFile", "readProjectConfig", "readEvents"]) {
    assert.ok(diag.includes(needed), `diagnostics 必须复用 core 的 ${needed}`);
  }
  const locateSrc = readFileSync(join(cliDir, "locate.ts"), "utf8");
  assert.ok(locateSrc.includes("resolveCanonicalRoot"), "root 解析必须经 core 的 resolveCanonicalRoot");
});

test("g-314 判据 3：frontmatter 与事件流语义由 core 决定（CLI 只是透传）", async () => {
  const sb = makeSandbox("g314-core");
  try {
    const { workspace, root } = makeBoard(sb.dir);
    // 用 core 的 init 建骨架后写一个 frontmatter 非 JSON 的文件：core 的 parseDoc 会拒绝
    writeGoal(root, "backlog/g-ok.md", { id: "g-ok", title: "合法", status: "draft", type: "task" });
    writeFileSync(join(root, "backlog", "g-bad.md"), "---\nnot: [json\n---\n\nbody\n", "utf8");
    const listed = listGoals({ root });
    assert.deepEqual(listed.goals.map((g) => g.id), ["g-ok"]);
    assert.equal(listed.problems.length, 1, "非 JSON frontmatter 必须由 core 判为不可解析");
    assert.match(listed.problems[0], /g-bad\.md/);

    const shown = showGoal({ root, id: "g-ok" });
    assert.equal(shown.goal.title, "合法");
    assert.match(shown.goal.body, /## 目标描述/);

    // status 的事件计数必须与 core readEvents 完全一致
    const status = await collectStatus({ root, workspace, mode: "main-tree" });
    assert.equal(status.eventCount, 1, "init 记一条 project.initialized 事件");
    assert.equal(status.lastEvent, "project.initialized");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 判据 7：反向变异（把关键守卫改坏 ⇒ 断言必红）
// ---------------------------------------------------------------------------

test("g-314 判据 7（反向变异·真源码副本）：拆掉危险路径守卫后，同一拒绝断言在变异体上实测变红", async () => {
  // 旧版是本地闭包 `mutatedGuardAccepts` 伪变异（同义反复：生产代码改坏照样通过）。现改为
  // **真实源码副本变异**：把 core/cli 拷进沙箱、就地删掉 assertSafeRoot 里的红线分支，
  // 再用真进程跑同一组断言。红 ⇒ 该断言确实能抓住「守卫被移除」。
  //
  // 变异手法：把 `isPathWithin(resolvedDshHome, abs) || isPathWithin(abs, resolvedDshHome)` 改成
  // `(false && …) || (false && …)` —— 保留 assertNotSymlinkedGraphRoot 与类型形状，只让红线上失效。
  // DSH_HOME 设为真实存在的 `~/.dsh`（非 main-tree）是为了**避免越界**：该值一旦在桩目录下，
  // worktree 归一可能把它改写成主树里真实存在的 `<repo>/.dsh-graph`，变异体就会「成功落地」在真实看板上。
  const sb = makeSandbox("g314-mut-danger");
  try {
    const { workspace } = makeBoard(sb.dir);
    const fakeHome = join(sb.dir, "home", "alice");
    mkdirSync(fakeHome, { recursive: true });
    // 真实 DSH_HOME 子目录：注入值必须「存在」才可能在变异体上成功落地。
    const realDshHome = join(fakeHome, ".dsh");
    const realDshSub = join(realDshHome, "workspaces", "proj");
    mkdirSync(realDshSub, { recursive: true });
    const env = { HOME: fakeHome, DSH_HOME: realDshHome };

    const mutation = makeMutationSandbox(sb);
    // 前置：未变异的副本必须与仓库实现逐字一致地拒绝（否则变异对照无意义）。
    const pristine = runCliProcessEnv(mutation.entry, ["--root", realDshSub, "info"], workspace, env);
    assert.equal(pristine.code, EXIT_FAILURE, `副本未变异时必须拒绝 $DSH_HOME 子目录；stderr=${pristine.stderr}`);
    assert.match(pristine.stderr, /全局配置/, "副本未变异时必须给出「全局配置」拒绝原因");

    mutateSource(
      mutation.file("locate.ts"),
      "if (isPathWithin(resolvedDshHome, abs) || isPathWithin(abs, resolvedDshHome)) {",
      "if ((false && isPathWithin(resolvedDshHome, abs)) || (false && isPathWithin(abs, resolvedDshHome))) {",
    );
    const mutated = runCliProcessEnv(mutation.entry, ["--root", realDshSub, "info"], workspace, env);
    assert.notEqual(mutated.code, EXIT_FAILURE, `变异体必须放行 $DSH_HOME 子目录（否则本对照不成立）；stderr=${mutated.stderr}`);
    assert.equal(mutated.code, EXIT_OK, `变异体应把该路径当合法看板；stderr=${mutated.stderr}`);
    // ⇒ 上面「$DSH_HOME 子目录必须 root-forbidden」的断言在变异体上必然失败。
  } finally {
    sb.cleanup();
  }
});

test("g-314 判据 7（反向变异·真源码副本）：退出码被吞成 0 后，分层断言在变异体上实测变红", async () => {
  // 旧版是本地闭包 `mutateExit = (code) => 0 * code`（同义反复）。现改为改坏真实源码：
  // 把 `failure()` 的退出码 1 改成 0（「静默成功」是最危险的退化），再跑真进程。
  const sb = makeSandbox("g314-mut-exit");
  try {
    const { workspace } = makeBoard(sb.dir);
    const mutation = makeMutationSandbox(sb);

    // 前置：未变异副本的退出码分层与仓库实现一致（用法错误 2 / 运行期失败 1）。
    const pristineUsage = runCliProcessEnv(mutation.entry, ["bogus"], workspace, {});
    const pristineFail = runCliProcessEnv(mutation.entry, ["goal", "show", "g-999"], workspace, {});
    assert.equal(pristineUsage.code, EXIT_USAGE, "副本未变异时用法错误必须退出 2");
    assert.equal(pristineFail.code, EXIT_FAILURE, "副本未变异时运行期失败必须退出 1");

    mutateSource(
      mutation.file("main.ts"),
      "return { exitCode: EXIT_FAILURE, stdout: \"\", stderr: `goal-graph: ${message}\\n` };",
      "return { exitCode: EXIT_OK, stdout: \"\", stderr: `goal-graph: ${message}\\n` };",
    );
    const mutatedUsage = runCliProcessEnv(mutation.entry, ["bogus"], workspace, {});
    const mutatedFail = runCliProcessEnv(mutation.entry, ["goal", "show", "g-999"], workspace, {});
    assert.equal(mutatedUsage.code, EXIT_USAGE, "`bogus` 走用法错误分支（EXIT_USAGE），本变异不动它");
    assert.equal(mutatedFail.code, EXIT_OK, `变异体必须把运行期失败吞成 0（否则本对照不成立）；stderr=${mutatedFail.stderr}`);
    assert.ok(mutatedFail.stderr.length > 0, "变异体仍产出可读 stderr（只是退出码被吞）");
    // ⇒ 上面「运行期失败必须退出 1」的断言在变异体上必然失败。
  } finally {
    sb.cleanup();
  }
});

test("g-314 判据 7（敏感性对照）：看板树被写入时，零副作用快照断言必红", async () => {
  // **口径如实**：这不是源码变异，而是「快照断言的敏感性」对照 —— 它在测试索引一个额外写入后，
  // 证明 snapshotTree（内容哈希 + inode + mtime）确实能抓住写入副作用。零副作用守卫（真实命令不写）
  // 由上面的「所有失败路径与只读命令都不修改看板目录树」用例承担。保留本对照，不做删弱。
  const sb = makeSandbox("g314-mut3");
  try {
    const { root } = makeBoard(sb.dir);
    const before = snapshotTree(root);
    // 真实命令：不写
    const { workspace } = { workspace: join(sb.dir, "ws") };
    await runCliInProcess(["status"], workspace);
    assert.equal(snapshotTree(root), before, "真实实现零副作用");
    // 写入一个文件（模拟「读命令顺手 init/记事件」的退化）⇒ 快照必须抓到
    writeFileSync(join(root, "index.json"), "{}\n", "utf8");
    assert.notEqual(snapshotTree(root), before, "写入必须被快照抓到 ⇒ 零副作用断言会失败");
  } finally {
    sb.cleanup();
  }
});

test("g-314 判据 7（反向变异·真源码副本）：入口缺失时入口报错而非静默成功", async () => {
  // 真变异：复制**真实入口源码**，但放到没有 ../core/cli 的位置 ⇒ 命中「找不到核心模块」分支。
  const sb = makeSandbox("g314-noentry");
  try {
    const orphanDir = join(sb.dir, "bin");
    mkdirSync(orphanDir, { recursive: true });
    const orphan = join(orphanDir, "goal-graph.mjs");
    writeFileSync(orphan, readFileSync(cliSourceEntry, "utf8"), "utf8");
    chmodSync(orphan, 0o755);
    const r = runCliProcess(orphan, ["version"], sb.dir);
    assert.notEqual(r.code, 0, "找不到核心模块时必须非零退出（绝不静默成功）");
    assert.match(r.stderr, /找不到可执行核心模块/, "必须给出可读错误");
  } finally {
    sb.cleanup();
  }
});
