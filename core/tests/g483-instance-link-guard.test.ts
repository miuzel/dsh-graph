/**
 * core/tests/g483-instance-link-guard.test.ts
 *
 * g-483 守卫：同稳定版本的并行 dev 实例**不得静默改写**共享 `DSH_HOME` 里的插件 link。
 *
 * 真机事故（2026-10-12）：`scripts/dsh-test-web.sh` 的隔离边界是 `DSH_HOME`，但它按**稳定版本**
 * 共享（同一预发布族只装一次 profile，设计如此）。于是同稳定版本的两个并行实例用不同
 * `--host-dir` 启动时，后启动者会把 `$DSH_HOME/profiles/web/package.json` 的
 * `dsh-graph: link:<HOST_DIR>` 改写成自己解析出的目标 —— 实测 g-479 评审实例把 g-481 的 link
 * 改写掉，而当时 g-481 的实例正在运行。运行中的实例在重启插件/惰性解析插件时会读到被改写的
 * link ⇒ **并行目视证据可能指向错误构建**（上一轮 g-481 评审自查过 link，故证据有效；那是幸运，
 * 不是机制保证）。本套件把「不再静默」钉成机器可判的断言。
 *
 * 断言面（对应五条质量判据）：
 *  A. 判据 1/4：既有 link ≠ 本次 `--host-dir` ⇒ dry-run 报告给出检测结论、启动路径给出**醒目
 *     多行警告**（含共享 DSH_HOME 绝对路径、既有目标、本次目标、后果、出路），且警告**不改变
 *     成功路径退出码**（dry-run 仍 exit 0）；既有 `--skip-install` 拒绝报文逐字保留。
 *  B. 判据 1：另有存活实例状态文件（PID 仍活 + 记录目标 ≠ 本次目标）⇒ **fail-closed**：dry-run
 *     报阻塞（exit 1），启动路径 exit 2 拒绝，且发生在任何 mkdir / 安装 / 改写 / boot **之前**。
 *  C. 判据 2/4：link 一致 ⇒ 无警告，且 dry-run（以及就绪复用态的启动路径）输出与**基线脚本**
 *     （`5b99f0f:scripts/dsh-test-web.sh`）逐字节相同（仅新增检测段被滤除）⇒ 既有契约零回归。
 *  D. 判据 4（变异对照）：把检测改回静默 / 去掉活跃实例判定 ⇒ 本套件的正向断言**必红**。
 *  E. 判据 2（结构性）：检测早于就绪对账与 profile 改写；实例状态写入晚于 dry-run 提前 return
 *     ⇒ `--dry-run` 零副作用（另由文件树快照断言）。
 *
 * 边界：**绝不启动真实 `dsh web` 实例**（就绪复用态的启动探针用只应答 `--version`、`web --dump-config`
 * 故意失败的 stub `dsh`，在真实 dsh 之前就以 exit 2 停下）；不联网、不装包、不碰生产 HOME，
 * 全部夹具落在仓库 `tmp/` 的一次性沙箱内。平台范围：linux/WSL2（bash + GNU coreutils）；
 * 原生 Windows/macOS 未验证（脚本自身也在 usage/预检里如实标注）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(REPO_ROOT, "scripts", "dsh-test-web.sh");
const TMP_ROOT = join(REPO_ROOT, "tmp");
/** 权威基线（本次 attempt 数据 5b99f0f）：逐字回归对照与「改回静默」的来源。 */
const BASELINE_COMMIT = "5b99f0f";
const IS_WIN = process.platform === "win32";
const SKIP = IS_WIN ? "g-483 只覆盖 linux/WSL2（bash + GNU coreutils）；原生 Windows 未验证" : false;
const BASH = existsSync("/usr/bin/bash") ? "/usr/bin/bash" : "bash";
/** 预发布版本折叠到稳定版本 ⇒ DSH_HOME 落在 <testRoot>/v0.21.0/home，版本根另一处。 */
const FULL_VERSION = "v0.21.0-rc.1";
const STABLE_VERSION = "v0.21.0";
const STATE_FILE = ".dsh-test-web-instance.json";
const WARN_BANNER = "!! 警告：共享 DSH_HOME 里的 dsh-graph link 与本次目标不同（并行实例冲突）!!";
/**
 * 只应答 `--version` 的 stub dsh：`web --dump-config` 故意失败 ⇒ 启动路径在**真实 dsh 之前**
 * 以 exit 2 停下（不启动任何服务、不联网）。用于就绪复用态的「与基线逐字相同」对照。
 */
const STUB_DSH_FAIL_DUMP = `#!/bin/sh
case "\${1:-}" in
  --version) printf '0.0.0-g483-stub\\n'; exit 0;;
esac
printf 'g483-stub: dump-config disabled\\n' >&2
exit 1
`;

type RunResult = { status: number | null; stdout: string; stderr: string };
type Repo = {
  root: string;
  script: string;
  hostDir: string;
  otherHostDir: string;
  testRoot: string;
  home: string;
  profileDir: string;
  versionRoot: string;
};

mkdirSync(TMP_ROOT, { recursive: true });

/** 在仓库 tmp/ 下开一个一次性沙箱（用例结束即整目录删除，不碰 tmp/dsh-test 的既有 home）。 */
function mkSandbox(): string {
  return mkdtempSync(join(TMP_ROOT, ".g483-smoke-"));
}

/** 被取代的静默实现（权威基线）：逐字回归对照 + 负向/变异对照的来源。 */
function baselineScript(): string {
  return execFileSync("git", ["show", `${BASELINE_COMMIT}:scripts/dsh-test-web.sh`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

/** 合成 host 包：满足脚本的 link/name/`dsh.bundle.patch` 判定（不真正加载插件）。 */
function writeSyntheticHost(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      { name: "dsh-graph", version: "0.0.0-g483", main: "index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n    - id: dsh-graph-host\n      name: dsh-graph\n");
}

/**
 * 最小假仓库骨架（脚本的 `REPO_ROOT` 由**自身位置**推导 ⇒ 私有副本自带独立的 `tmp/dsh-test`）：
 *   <root>/scripts/dsh-test-web.sh   （当前实现 / 基线 / 变异体）
 *   <root>/dsh-graph-host/           （允许的 host-dir 落点 A）
 *   <root>/.worktrees/g-999-att-01/dist/（允许的 host-dir 落点 B ⇒ 「别处」）
 *   <root>/tmp/dsh-test/             （DSH_HOME 骨架）
 */
function makeFakeRepo(sb: string, name: string, scriptText: string): Repo {
  const root = join(sb, name);
  mkdirSync(join(root, "scripts"), { recursive: true });
  const script = join(root, "scripts", "dsh-test-web.sh");
  writeFileSync(script, scriptText);
  chmodSync(script, 0o755);
  const hostDir = join(root, "dsh-graph-host");
  const otherHostDir = join(root, ".worktrees", "g-999-att-01", "dist");
  writeSyntheticHost(hostDir);
  writeSyntheticHost(otherHostDir);
  mkdirSync(join(root, "tmp"), { recursive: true });
  const testRoot = join(root, "tmp", "dsh-test");
  const home = join(testRoot, STABLE_VERSION, "home");
  const profileDir = join(home, "profiles", "web");
  mkdirSync(join(profileDir, "node_modules"), { recursive: true });
  return {
    root,
    script,
    hostDir,
    otherHostDir,
    testRoot,
    home,
    profileDir,
    versionRoot: join(testRoot, FULL_VERSION),
  };
}

/** 写入 profile manifest（`link:` 指向给定目标）+ `node_modules/dsh-graph` 符号链接（与脚本判定同形）。 */
function writeProfile(repo: Repo, linkTarget: string): void {
  const linkPath = join(repo.profileDir, "node_modules", "dsh-graph");
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(linkTarget, linkPath);
  writeFileSync(
    join(repo.profileDir, "package.json"),
    `${JSON.stringify(
      {
        name: "dsh-profile-web",
        private: true,
        dependencies: { "dsh-graph": `link:${linkTarget}` },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-graph"] } },
      },
      null,
      2,
    )}\n`,
  );
}

/** 写入「上一次启动留下的实例状态文件」（g-483 的活跃实例判定数据来源）。 */
function writeState(repo: Repo, rec: Record<string, unknown>): void {
  writeFileSync(join(repo.home, STATE_FILE), `${JSON.stringify(rec)}\n`);
}

function runScript(repo: Repo, args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DSH_TEST_MODE: "1",
    DSH_TEST_ROOT: repo.testRoot,
    ...extraEnv,
  };
  const r = spawnSync(BASH, [repo.script, ...args], { cwd: repo.root, env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function dryArgs(repo: Repo, port: number): string[] {
  return [FULL_VERSION, "--dry-run", "--port", String(port), "--host-dir", repo.hostDir];
}

function reuseArgs(repo: Repo, port: number): string[] {
  return [FULL_VERSION, "--skip-install", "--port", String(port), "--host-dir", repo.hostDir];
}

function launchArgs(repo: Repo, port: number): string[] {
  return [FULL_VERSION, "--port", String(port), "--host-dir", repo.hostDir];
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
}

/**
 * 假实例（**不是** dsh web）：一个 `sh dsh-web-stub.sh --port N` 的短命进程，只用来让
 * 「状态文件里的 PID 仍存活」可判定（其 cmdline 含 `dsh`…`web`，与脚本的 PID 复用兜底同形）。
 */
function spawnFakeInstance(sb: string, port: number): { pid: number; dispose: () => void } {
  const stub = join(sb, "dsh-web-stub.sh");
  writeFileSync(stub, "#!/bin/sh\nsleep 30\n");
  chmodSync(stub, 0o755);
  const child = spawn("sh", [stub, "--port", String(port)], { stdio: "ignore", detached: true });
  assert.ok(child.pid, "假实例必须拿到 PID");
  const pid = child.pid as number;
  return {
    pid,
    dispose: () => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    },
  };
}

/** 文件树快照：相对路径 + 类型/大小/mtime（symlink 记目标）；不存在记 `<absent>`。 */
function snapshotTree(root: string): string[] {
  if (!existsSync(root)) return ["<absent>"];
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) lines.push(`${rel}|link->${readlinkSync(abs)}`);
      else if (st.isDirectory()) {
        lines.push(`${rel}|dir`);
        walk(abs);
      } else lines.push(`${rel}|file|${st.size}|${Math.round(st.mtimeMs)}`);
    }
  };
  walk(root);
  return lines;
}

/** 判据 1（dry-run 面）：检测结论必须出现，且含共享 DSH_HOME、既有目标、本次目标。 */
function assertConflictConclusion(text: string, repo: Repo): void {
  assert.ok(text.includes("共享 DSH_HOME 的 link 冲突检测"), "dry-run 必须给出 link 冲突检测结论段");
  assert.ok(text.includes(repo.home), "检测结论必须含共享 DSH_HOME 绝对路径");
  assert.ok(text.includes(repo.otherHostDir), "检测结论必须含既有 link 目标");
  assert.ok(text.includes(repo.hostDir), "检测结论必须含本次 link 目标");
  assert.ok(text.includes("≠ 本次目标"), "检测结论必须点明「既有目标 ≠ 本次目标」");
}

/** 判据 1（启动路径面）：醒目多行警告必须出现，且含四项要素 + 后果 + 出路。 */
function assertLoudWarning(stderr: string, repo: Repo): void {
  assert.ok(stderr.includes(WARN_BANNER), "启动路径必须给出醒目警告横幅");
  assert.ok(stderr.includes(repo.home), "警告必须含共享 DSH_HOME 绝对路径");
  assert.ok(stderr.includes(repo.otherHostDir), "警告必须含既有 link 目标");
  assert.ok(stderr.includes(repo.hostDir), "警告必须含本次 link 目标");
  assert.ok(stderr.includes("目视证据") && stderr.includes("错误构建"), "警告必须说明并行实例目视可能读到错误构建");
  assert.ok(stderr.includes("worktree"), "警告必须给出「在目标 worktree 内运行以获得独立 DSH_HOME」的出路");
}

/** 判据 1（fail-closed 面）：必须拒绝启动并给出可执行出路。 */
function assertRefused(stderr: string, repo: Repo): void {
  assert.ok(stderr.includes("拒绝启动"), "疑似活跃实例指向别处时必须 fail-closed 拒绝启动");
  assert.ok(
    stderr.includes(repo.home) && stderr.includes(repo.otherHostDir) && stderr.includes(repo.hostDir),
    "拒绝报文必须含共享 DSH_HOME / 既有目标 / 本次目标",
  );
  assert.ok(stderr.includes("状态文件"), "拒绝报文必须点名判定依据（实例状态文件）");
  assert.ok(stderr.includes("worktree"), "拒绝报文必须给出可执行出路");
}

/** 判据 1：dry-run 必须把「疑似仍有活跃实例指向别处」报成阻塞项。 */
function assertActiveElsewhereBlocker(stdout: string): void {
  assert.ok(stdout.includes("疑似仍有活跃实例指向别处(!)"), "dry-run 必须点名「疑似仍有活跃实例指向别处」");
  assert.match(stdout, /阻塞项：1/, "必须计入 1 个阻塞项");
}

/** g-483 新增检测段的行前缀：逐字回归对照时滤掉（基线脚本没有这些行）。 */
const NEW_SECTION_PREFIXES = [
  "--- 共享 DSH_HOME 的 link 冲突检测",
  "共享 DSH_HOME  ：",
  "既有 link 目标 ：",
  "本次 link 目标 ：",
  "活跃实例冲突   ：",
];

function stripNewSection(text: string): string {
  return text
    .split("\n")
    .filter((line) => !NEW_SECTION_PREFIXES.some((p) => line.startsWith(p)))
    .join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// 判据 1/4：冲突 ⇒ 检测结论 + 醒目警告（且不改变成功路径退出码）
// ────────────────────────────────────────────────────────────────────────────

test(
  "g-483 判据 1/4：既有 link ≠ 本次 --host-dir ⇒ dry-run 检测结论 + 启动路径醒目警告（退出码不因警告而变）",
  { skip: SKIP },
  async () => {
    const sb = mkSandbox();
    try {
      const repo = makeFakeRepo(sb, "conflict", readFileSync(SCRIPT, "utf8"));
      writeProfile(repo, repo.otherHostDir);
      const port = await freePort();

      const before = snapshotTree(repo.testRoot);
      const dry = runScript(repo, dryArgs(repo, port));
      assert.equal(dry.status, 0, `冲突但无活跃实例时 dry-run 仍应 exit 0（警告不改变退出码）：\n${dry.stdout}\n${dry.stderr}`);
      assert.equal(dry.stderr, "", `dry-run 不把警告写进 stderr（检测结论在报告段）：${dry.stderr}`);
      assertConflictConclusion(dry.stdout, repo);
      assert.deepEqual(snapshotTree(repo.testRoot), before, "dry-run 必须零副作用");
      assert.ok(!existsSync(join(repo.home, STATE_FILE)), "dry-run 不得写实例状态文件");
      assert.equal(
        JSON.parse(readFileSync(join(repo.profileDir, "package.json"), "utf8")).dependencies["dsh-graph"],
        `link:${repo.otherHostDir}`,
        "dry-run 不得改写既有 link",
      );

      const launch = runScript(repo, reuseArgs(repo, port));
      assert.equal(launch.status, 2, `启动路径仍只在既有 --skip-install 检查处拒绝：\n${launch.stdout}\n${launch.stderr}`);
      assertLoudWarning(launch.stderr, repo);
      assert.match(
        launch.stderr,
        /--skip-install 要求目标 DSH_HOME 已有可复用的 dsh-graph profile/,
        "既有 --skip-install 拒绝报文必须逐字保留",
      );
      assert.ok(!existsSync(join(repo.versionRoot, "profile-install.log")), "警告路径不得跑插件安装");
      assert.ok(!existsSync(join(repo.versionRoot, "runtime-install.log")), "警告路径不得跑运行时安装");
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// 判据 2/4：link 一致 ⇒ 无警告 + 与基线逐字相同
// ────────────────────────────────────────────────────────────────────────────

test(
  "g-483 判据 2/4：link 一致 ⇒ 无警告，dry-run 输出与基线逐字相同（仅滤除新增检测段）+ 零副作用",
  { skip: SKIP },
  async () => {
    const sb = mkSandbox();
    try {
      const current = readFileSync(SCRIPT, "utf8");
      const repo = makeFakeRepo(sb, "consistent", current);
      writeProfile(repo, repo.hostDir);
      const port = await freePort();

      const before = snapshotTree(repo.testRoot);
      const dry = runScript(repo, dryArgs(repo, port));
      assert.equal(dry.status, 0, `link 一致必须 exit 0：\n${dry.stdout}\n${dry.stderr}`);
      assert.equal(dry.stderr, "", "link 一致时不得有任何警告输出");
      assert.ok(!dry.stdout.includes(WARN_BANNER), "link 一致时不得出现警告横幅");
      assert.ok(dry.stdout.includes(`既有 link 目标 ：${repo.hostDir}（与本次一致`), "检测段必须如实报「与本次一致」");
      assert.ok(dry.stdout.includes("profile 判定 ：就绪"), "守卫不得空跑：夹具必须是就绪 profile");
      assert.deepEqual(snapshotTree(repo.testRoot), before, "dry-run 必须零副作用");

      // 逐字回归对照：同一个假仓库路径上跑基线脚本，滤掉 g-483 新增检测段后必须逐字节相同。
      writeFileSync(repo.script, baselineScript());
      let baseRun: RunResult;
      try {
        baseRun = runScript(repo, dryArgs(repo, port));
      } finally {
        writeFileSync(repo.script, current);
      }
      assert.equal(baseRun.status, 0, `基线脚本在一致场景必须 exit 0：\n${baseRun.stderr}`);
      assert.ok(!baseRun.stdout.includes("共享 DSH_HOME 的 link 冲突检测"), "基线脚本不应有 g-483 检测段（对照成立）");
      assert.equal(
        stripNewSection(dry.stdout),
        stripNewSection(baseRun.stdout),
        "除 g-483 新增检测段外，dry-run 输出必须与基线逐字相同",
      );
      assert.ok(stripNewSection(dry.stdout).includes("profile 判定 ：就绪"), "过滤后必须仍有实质内容（对照不得空跑）");
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  },
);

test(
  "g-483 判据 2：link 一致时启动路径（就绪复用 ⇒ stub dsh 处停下）输出与基线逐字相同",
  { skip: SKIP },
  async () => {
    const sb = mkSandbox();
    try {
      const current = readFileSync(SCRIPT, "utf8");
      const repo = makeFakeRepo(sb, "launch-same", current);
      writeProfile(repo, repo.hostDir);
      const port = await freePort();
      const binDir = join(sb, "bin");
      mkdirSync(binDir, { recursive: true });
      const stubDsh = join(binDir, "dsh");
      writeFileSync(stubDsh, STUB_DSH_FAIL_DUMP);
      chmodSync(stubDsh, 0o755);
      const env = { PATH: `${binDir}:${process.env.PATH ?? ""}` };

      const cur = runScript(repo, reuseArgs(repo, port), env);
      assert.equal(cur.status, 2, `stub 的 dump-config 失败必须非零退出（绝不启动真实 dsh web）：\n${cur.stdout}\n${cur.stderr}`);
      assert.ok(cur.stderr.includes("无法读取 web effective config"), "必须在真实 dsh 之前停下");
      assert.ok(!cur.stderr.includes(WARN_BANNER), "link 一致时启动路径不得警告");
      assert.ok(cur.stdout.includes("跳过 dsh-graph 插件安装（复用已有 profile）"), "必须先走到既有就绪复用分支");

      writeFileSync(repo.script, baselineScript());
      let baseRun: RunResult;
      try {
        baseRun = runScript(repo, reuseArgs(repo, port), env);
      } finally {
        writeFileSync(repo.script, current);
      }
      assert.equal(baseRun.status, cur.status, "退出码必须与基线一致");
      assert.equal(cur.stdout, baseRun.stdout, "link 一致时启动路径 stdout 必须与基线逐字相同");
      assert.equal(cur.stderr, baseRun.stderr, "link 一致时启动路径 stderr 必须与基线逐字相同");
      assert.ok(!existsSync(join(repo.versionRoot, "profile-install.log")), "就绪复用路径不得安装");
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// 判据 1：疑似活跃实例指向别处 ⇒ fail-closed
// ────────────────────────────────────────────────────────────────────────────

test(
  "g-483 判据 1：疑似仍有活跃实例指向别处 ⇒ fail-closed 拒绝启动（dry-run 报阻塞；launch 零 mkdir/零安装/零 boot）",
  { skip: SKIP },
  async () => {
    const sb = mkSandbox();
    try {
      const repo = makeFakeRepo(sb, "active", readFileSync(SCRIPT, "utf8"));
      writeProfile(repo, repo.otherHostDir);
      const port = await freePort();
      const fake = spawnFakeInstance(sb, port);
      try {
        writeState(repo, { pid: fake.pid, host_dir: repo.otherHostDir, port });

        const dry = runScript(repo, dryArgs(repo, port));
        assert.equal(dry.status, 1, `检出活跃实例冲突时 dry-run 必须报阻塞（exit 1）：\n${dry.stdout}\n${dry.stderr}`);
        assertActiveElsewhereBlocker(dry.stdout);

        const launch = runScript(repo, launchArgs(repo, port));
        assert.equal(launch.status, 2, `必须 fail-closed 拒绝启动：\n${launch.stdout}\n${launch.stderr}`);
        assertLoudWarning(launch.stderr, repo);
        assertRefused(launch.stderr, repo);
        assert.ok(!existsSync(repo.versionRoot), "拒绝启动必须发生在任何 mkdir 之前（版本根不得被创建）");
        assert.ok(
          !existsSync(join(repo.versionRoot, "profile-install.log")) && !existsSync(join(repo.versionRoot, "runtime-install.log")),
          "拒绝启动不得安装任何东西",
        );
        assert.ok(!launch.stdout.includes("STUB-BOOT"), "拒绝启动不得 boot");
        assert.ok(
          readFileSync(join(repo.profileDir, "package.json"), "utf8").includes(`link:${repo.otherHostDir}`),
          "拒绝启动不得改写既有 link",
        );
      } finally {
        fake.dispose();
      }
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// 判据 4：变异对照（改回静默 ⇒ 必红）
// ────────────────────────────────────────────────────────────────────────────

test("g-483 判据 4：变异对照 —— 检测改回静默 / 去掉活跃实例判定 ⇒ 本套件的正向断言必红", { skip: SKIP }, async () => {
  const sb = mkSandbox();
  try {
    const current = readFileSync(SCRIPT, "utf8");

    // M1：link 冲突检测改回静默（恒判「无冲突」）⇒ 冲突场景下不应再有结论/警告。
    const m1Anchor = '    [ "$EXISTING_HOST_DIR" = "$HOST_DIR" ] || LINK_CONFLICT=1';
    assert.equal(current.split(m1Anchor).length - 1, 1, `变异锚点 M1 必须唯一存在：${m1Anchor}`);
    const repo1 = makeFakeRepo(sb, "mut-silent", current.replace(m1Anchor, "    LINK_CONFLICT=0  # g-483 变异：检测静默"));
    writeProfile(repo1, repo1.otherHostDir);
    const port1 = await freePort();

    const dry1 = runScript(repo1, dryArgs(repo1, port1));
    assert.equal(dry1.status, 0, "变异体仍能跑完 dry-run（差异只在缺少冲突结论）");
    assert.throws(() => assertConflictConclusion(dry1.stdout, repo1), "检测静默后「dry-run 必须给出冲突结论」的断言必须红");

    const launch1 = runScript(repo1, reuseArgs(repo1, port1));
    assert.equal(launch1.status, 2, "变异体仍走既有 --skip-install 拒绝（流程未被破坏）");
    assert.throws(() => assertLoudWarning(launch1.stderr, repo1), "检测静默后「启动路径必须醒目警告」的断言必须红");

    // M2：去掉「疑似活跃实例指向别处」判定 ⇒ fail-closed 断言必红（只跑 dry-run 面：变异体会走向重装）。
    const m2Anchor = '  [ "$host" != "$HOST_DIR" ] || return 1';
    assert.equal(current.split(m2Anchor).length - 1, 1, `变异锚点 M2 必须唯一存在：${m2Anchor}`);
    const repo2 = makeFakeRepo(sb, "mut-active", current.replace(m2Anchor, "  return 1  # g-483 变异：不判定活跃实例"));
    writeProfile(repo2, repo2.otherHostDir);
    const port2 = await freePort();
    const fake = spawnFakeInstance(sb, port2);
    try {
      writeState(repo2, { pid: fake.pid, host_dir: repo2.otherHostDir, port: port2 });
      const dry2 = runScript(repo2, dryArgs(repo2, port2));
      assert.equal(dry2.status, 0, "去掉活跃判定后 dry-run 不再报阻塞（这正是要钉住的退化）");
      assert.throws(() => assertActiveElsewhereBlocker(dry2.stdout), "去掉活跃判定后「必须报活跃实例冲突阻塞」的断言必须红");
    } finally {
      fake.dispose();
    }
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 判据 2：结构性守卫（检测顺序 / dry-run 零写入）
// ────────────────────────────────────────────────────────────────────────────

test("g-483 判据 2：结构性守卫 —— 检测早于就绪对账/改写，状态写入晚于 dry-run 提前 return", () => {
  const text = readFileSync(SCRIPT, "utf8");
  const at = (needle: string, label: string): number => {
    const count = text.split(needle).length - 1;
    assert.equal(count, 1, `${label} 锚点必须唯一存在：${needle}`);
    return text.indexOf(needle);
  };
  const detect = at('    [ "$EXISTING_HOST_DIR" = "$HOST_DIR" ] || LINK_CONFLICT=1', "冲突检测");
  const readiness = at('if [ -f "$PROFILE_MANIFEST" ] && profile_ready; then needs_install=0; fi', "就绪对账");
  const rewrite = at(
    'install_step "$PROFILE_DIR" "$VERSION_ROOT/profile-install.log" "$RUNTIME_DSH" plugin --profile web add "$HOST_LINK"',
    "profile 改写",
  );
  const dryReturn = at('if doctor; then exit 0; else exit 1; fi', "dry-run 提前 return");
  const failClosed = at('if [ "$LINK_ACTIVE_ELSEWHERE" -eq 1 ]; then die_shared_link_conflict; fi', "fail-closed");
  const mkdir = at('[ -d "$TMP_PATH" ] || mkdir -p "$TMP_PATH"', "首个 mkdir");
  const stateWrite = at('writeFileSync(process.argv[1],JSON.stringify({pid:Number(process.argv[2])', "状态写入");

  assert.ok(detect < readiness && detect < rewrite, "link 冲突检测必须早于就绪对账与 profile 改写");
  assert.ok(failClosed < mkdir, "fail-closed 必须早于任何 mkdir");
  assert.ok(stateWrite > dryReturn, "实例状态写入必须在 dry-run 提前 return 之后（dry-run 零副作用）");
  assert.ok(text.includes('INSTANCE_STATE="$DSH_HOME/.dsh-test-web-instance.json"'), "状态文件必须位于本 DSH_HOME 内");
});
