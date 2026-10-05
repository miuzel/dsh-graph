/**
 * core/tests/g301-dry-run-doctor.test.ts
 *
 * g-301 守卫：现行 `scripts/dsh-test-web.sh` 的**最小只读 dry-run / doctor 预检**与
 * 「危险/无效输入在任何副作用之前拒绝」。
 *
 * 断言面（对应三条质量判据）：
 *  A. 只读预检复用启动路径自身的判定并**如实报告**：工具可用性/路径、候选与**实际 link 目标**
 *     （`link:<host-dir>`）、端口占用、DSH_HOME/workspace/cache/运行时/profile 的**缺项**
 *     （「目录存在 ≠ 环境正确」：不存在的目录报缺失，存在的非目录报 `非目录(!)`）。
 *  B. 零副作用：`--help` / `--dry-run` / 危险输入拒绝，前后**文件快照与进程快照逐项相同**；
 *     危险输入下**零 mkdir**（测试根始终不存在）、零 install（无日志/无 node_modules）、
 *     零配置写入、零启动。
 *  C. 危险/无效输入在 `mkdir`/install/配置写入/启动之前以 exit 2 拒绝：3080 与生产 HOME、
 *     看板路径先行拒绝；非法端口（越界/前导零/空值/危险字符）、非法 `--host`、空值、
 *     受管参数透传、未知参数。凭据（如 `NEWAPI_ASEIT_API_KEY`）一律不回显。
 *  D. 负向对照（本套件的核心）：把**基线脚本**（`385dc81:scripts/dsh-test-web.sh`）用同样的
 *     「危险输入 + --skip-install」跑一遍，它**会**在拒绝前建出目录 ⇒ 预检一旦被回退，
 *     本套件的「零副作用」断言必红。基线版本的插件安装不运行（`--skip-install` 在 mkdir 后、
 *     安装前就以非零退出），因此对照不失网络、不起服务。
 *
 * 平台范围：linux/WSL2（bash + GNU coreutils）；原生 Windows/macOS 不在本套件覆盖内（脚本自身
 * 也在 usage/预检里如实标注这一点）。真实安装 + 服务可达性不在本套件内（需要 registry 与长驻
 * 进程），见交付报文中的真实启动回归证据。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
const HOST_DIR = join(REPO_ROOT, "dsh-graph-host");
const TMP_ROOT = join(REPO_ROOT, "tmp");
/** 权威基线（本次 attempt 数据）：负向对照从这里取被取代的实现。 */
const BASELINE_COMMIT = "385dc81";
const BASELINE_SCRIPT = execFileSync("git", ["show", `${BASELINE_COMMIT}:scripts/dsh-test-web.sh`], {
  cwd: REPO_ROOT,
  encoding: "utf8",
});
const IS_WIN = process.platform === "win32";
const SKIP = IS_WIN ? "g-301 只读预检覆盖 linux/WSL2（bash + GNU coreutils）；原生 Windows 未验证" : false;
const BASH = existsSync("/usr/bin/bash") ? "/usr/bin/bash" : "bash";

type RunResult = { status: number | null; stdout: string; stderr: string };
type RunOpts = { env?: Record<string, string>; cwd?: string; path?: string };

mkdirSync(TMP_ROOT, { recursive: true });

/** 在仓库 tmp/ 下开一个一次性沙箱（用例结束即整目录删除，不碰 tmp/dsh-test 的既有 home）。 */
function mkSandbox(): string {
  return mkdtempSync(join(TMP_ROOT, ".g301-smoke-"));
}

function runScript(args: string[], opts: RunOpts = {}): RunResult {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DSH_TEST_MODE: "1",
    ...(opts.env ?? {}),
  };
  if (opts.path !== undefined) env.PATH = opts.path;
  const r = spawnSync(BASH, [SCRIPT, ...args], { cwd: opts.cwd ?? REPO_ROOT, env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 文件快照：整棵树的相对路径 + 类型/大小/mtime（symlink 记目标）；不存在记 `<absent>`。 */
function snapshot(root: string): string {
  if (!existsSync(root)) return "<absent>";
  const lines: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) lines.push(`${rel}|link->${readlinkSync(abs)}`);
      else if (st.isDirectory()) lines.push(`${rel}|dir`);
      else lines.push(`${rel}|file:${st.size}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(abs);
    }
  };
  walk(root);
  return lines.length > 0 ? lines.join("\n") : "<empty>";
}

/** 进程快照：只取 cmdline 含本次沙箱唯一路径的进程（避免误伤同机其它 dsh/测试进程）。 */
function processesMatching(marker: string): string[] {
  const r = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return (r.stdout ?? "")
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) => line.trim())
    .sort();
}

/** 一个当前空闲的端口（先 bind(0) 取值再释放）；仅用于「端口空闲」用例。 */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
}

/** 一个「已就绪」的隔离根：运行时 + web profile（link 指向 dsh-graph-host，与启动判定一致）。 */
function makeReadyRoot(sb: string, version = "v0.19.4"): string {
  const root = join(sb, "root");
  const vroot = join(root, version);
  for (const d of ["workspace", "cache/npm", "cache/xdg", "pnpm-store", "node_modules/.bin", "home/profiles/web/node_modules"]) {
    mkdirSync(join(vroot, d), { recursive: true });
  }
  const stub = join(vroot, "node_modules/.bin/dsh");
  writeFileSync(stub, '#!/bin/sh\necho "stub dsh"\n');
  chmodSync(stub, 0o755);
  symlinkSync(HOST_DIR, join(vroot, "home/profiles/web/node_modules/dsh-graph"));
  writeFileSync(
    join(vroot, "home/profiles/web/package.json"),
    `${JSON.stringify(
      {
        name: "dsh-profile-web",
        private: true,
        dependencies: { "dsh-graph": `link:${HOST_DIR}` },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-graph"] } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(vroot, "home/profiles/web/pnpm-workspace.yaml"), "packages:\n  - .\nautoInstallPeers: true\n");
  return root;
}

/** 只读预检的一次「干净」调用：全新隔离根 + 空闲端口 + 现存 host-dir。 */
async function doctorFresh(sb: string, extra: string[] = []): Promise<RunResult> {
  const port = await freePort();
  return runScript(["v0.19.4", "--dry-run", "--port", String(port), "--host-dir", HOST_DIR, ...extra], {
    env: { DSH_TEST_ROOT: join(sb, "root") },
    cwd: sb,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// A/B. 帮助与预检：如实报告 + 零副作用
// ────────────────────────────────────────────────────────────────────────────

test("g-301 帮助零副作用：--help 独立可用、声明 dry-run/退出码/平台范围，且不建任何文件", { skip: SKIP }, () => {
  const sb = mkSandbox();
  try {
    const before = snapshot(sb);
    const r = runScript(["--help"], { env: { DSH_TEST_ROOT: join(sb, "root") }, cwd: sb });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("--dry-run"), "usage 必须声明 --dry-run");
    assert.ok(r.stdout.includes("只读预检"), "usage 必须说明只读预检");
    assert.ok(r.stdout.includes("退出码"), "usage 必须声明退出码语义");
    assert.ok(r.stdout.includes("平台范围"), "usage 必须如实登记平台范围");
    assert.equal(snapshot(sb), before, "--help 不得产生任何文件/目录");
    assert.deepEqual(processesMatching(sb), [], "--help 不得留下进程");
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("g-301 只读预检如实报告：工具/候选/实际 link/端口/缺项，且隔离根仍不存在（零 mkdir）", { skip: SKIP }, async () => {
  const sb = mkSandbox();
  try {
    const root = join(sb, "root");
    const before = snapshot(sb);
    const procs = processesMatching(sb);
    const r = await doctorFresh(sb);
    assert.equal(r.status, 0, `预检应可启动（阻塞项 0）：\n${r.stdout}\n${r.stderr}`);
    for (const must of ["候选 host-dir", `实际 link 目标：link:${HOST_DIR}`, "TEST_ROOT", "DSH_HOME", "WORKSPACE"]) {
      assert.ok(r.stdout.includes(must), `预检必须报告「${must}」`);
    }
    assert.ok(/pnpm\s+.*（可用）/.test(r.stdout), "必须如实报告 pnpm 可用性");
    assert.ok(/端口 \d+：空闲/.test(r.stdout), "必须报告端口探测结果");
    assert.ok(r.stdout.includes("缺项（启动时将创建/安装）"), "必须报告缺项");
    assert.ok(r.stdout.includes(root), "缺项必须点名实际路径");
    assert.ok(r.stdout.includes("未验证：web 有效配置"), "预检必须如实声明未验证项（不跑 --dump-config）");
    // 隔离边界：报告的三个路径都必须落在仓库 tmp/ 内
    for (const label of ["TEST_ROOT", "DSH_HOME", "WORKSPACE"]) {
      const m = r.stdout.match(new RegExp(`^${label}\\s+(\\S+)`, "m"));
      assert.ok(m, `预检必须打印 ${label} 路径`);
      assert.ok(m![1].startsWith(`${TMP_ROOT}/`), `${label} 必须落在项目 tmp 内：${m![1]}`);
    }
    assert.equal(snapshot(sb), before, "只读预检不得创建目录/文件（零 mkdir）");
    assert.deepEqual(processesMatching(sb), procs, "只读预检不得留下进程");
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("g-301 预检复用启动判定：已就绪 profile → 缺项 0，且整棵树逐字节不变", { skip: SKIP }, async () => {
  const sb = mkSandbox();
  try {
    const root = makeReadyRoot(sb);
    const before = snapshot(root);
    const r = await doctorFresh(sb);
    assert.equal(r.status, 0, `已就绪环境应 exit 0：\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.stdout.includes("profile 判定 ：就绪"), "必须报告 profile 就绪（依赖/link/name/bundle.patch）");
    assert.ok(r.stdout.includes("缺项：0"), "就绪环境下不得再报缺项");
    assert.equal(snapshot(root), before, "预检不得改动已就绪环境的任何字节");
    const hasDsh = spawnSync("bash", ["-lc", "command -v dsh"], { encoding: "utf8" }).status === 0;
    const skip = await doctorFresh(sb, ["--skip-install"]);
    assert.equal(skip.status, hasDsh ? 0 : 1, "--skip-install 预检必须复用启动路径的 profile 门禁");
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("g-301 预检如实报告阻塞项：--skip-install 而 profile 未就绪 → exit 1（仍零副作用）", { skip: SKIP }, async () => {
  const sb = mkSandbox();
  try {
    const root = join(sb, "root");
    const before = snapshot(sb);
    const r = await doctorFresh(sb, ["--skip-install"]);
    assert.equal(r.status, 1, `缺项场景必须非零退出：\n${r.stdout}`);
    assert.ok(r.stdout.includes("阻塞项："), "必须报告阻塞项");
    assert.ok(r.stdout.includes("--skip-install 要求目标 DSH_HOME 已有可复用的 dsh-graph profile"));
    assert.ok(r.stdout.includes("只读预检结论：阻塞"), "结论行必须明确阻塞");
    assert.equal(snapshot(sb), before, "报阻塞也不得产生副作用");
    assert.ok(!existsSync(root), "阻塞场景不得 mkdir");
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// C. 危险/无效输入：在 mkdir/install/配置写入/启动之前拒绝（exit 2，零副作用）
// ────────────────────────────────────────────────────────────────────────────

test("g-301 四类调用（正常/缺工具/端口占用/危险输入）前后文件与进程快照不变", { skip: SKIP }, async () => {
  const sb = mkSandbox();
  try {
    const root = join(sb, "root");
    const before = snapshot(sb);
    const procs = processesMatching(sb);

    // ① 正常参数：只读预检（可启动）
    const ok = await doctorFresh(sb);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(snapshot(sb), before, "正常参数预检不得产生副作用");

    // ② 缺工具：PATH 中没有 pnpm ⇒ 启动路径的同一门禁先拒绝（工具检查早于任何 mkdir）
    const noTool = runScript(["v0.19.4", "--port", "3099", "--host-dir", HOST_DIR], {
      env: { DSH_TEST_ROOT: root },
      path: "/usr/bin:/bin",
      cwd: sb,
    });
    assert.equal(noTool.status, 2, "缺工具必须 exit 2");
    assert.ok(noTool.stderr.includes("缺少 pnpm"), `缺工具必须如实报错：${noTool.stderr}`);
    assert.equal(snapshot(sb), before, "缺工具拒绝不得产生副作用");

    // ③ 端口被占用：先占住端口，再让脚本拒绝
    const srv = createServer();
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
    const busy = (srv.address() as AddressInfo).port;
    try {
      const occupied = runScript(["v0.19.4", "--port", String(busy), "--host-dir", HOST_DIR], {
        env: { DSH_TEST_ROOT: root },
        cwd: sb,
      });
      assert.equal(occupied.status, 2, "占用端口必须 exit 2");
      assert.ok(occupied.stderr.includes(`端口已占用：${busy}`), occupied.stderr);
      const occupiedDry = runScript(["v0.19.4", "--dry-run", "--port", String(busy), "--host-dir", HOST_DIR], {
        env: { DSH_TEST_ROOT: root },
        cwd: sb,
      });
      assert.equal(occupiedDry.status, 1, "预检下占用端口必须如实报为阻塞项");
      assert.ok(occupiedDry.stdout.includes(`端口 ${busy}：已占用(!)`), occupiedDry.stdout);
    } finally {
      await new Promise<void>((res) => srv.close(() => res()));
    }

    // ④ 危险输入：逐条拒绝
    for (const args of [
      ["v0.19.4", "--port", "3080", "--host-dir", HOST_DIR],
      ["v0.19.4", "--dry-run", "--port", "3080", "--host-dir", HOST_DIR],
    ]) {
      const r = runScript(args, { env: { DSH_TEST_ROOT: root }, cwd: sb });
      assert.equal(r.status, 2, `${args.join(" ")} 必须拒绝`);
      assert.ok(r.stderr.includes("拒绝端口 3080"), r.stderr);
    }

    assert.equal(snapshot(sb), before, "四类调用前后文件快照必须逐项相同");
    assert.deepEqual(processesMatching(sb), procs, "四类调用前后进程快照必须相同");
    assert.ok(!existsSync(root), "任何一类都不得 mkdir 测试根");
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("g-301 危险/无效参数表：mkdir/install/配置写入/启动之前 exit 2，零副作用、零凭据回显", { skip: SKIP }, () => {
  const sb = mkSandbox();
  const canary = "sk-live-CANARY-4b1d9f0a-NEVER-ECHO";
  try {
    const root = join(sb, "root");
    const before = snapshot(sb);
    const homeDsh = join(process.env.HOME ?? "/nonexistent-home", ".dsh");
    const cases: Array<[string, string[]]> = [
      ["越界端口", ["--port", "65536"]],
      ["零端口", ["--port", "0"]],
      ["负端口", ["--port", "-1"]],
      ["前导零端口（八进制陷阱）", ["--port", "0300"]],
      ["空端口值", ["--port", ""]],
      ["非数字端口", ["--port", "3082x"]],
      ["端口含换行", ["--port", "3099\n3080"]],
      ["3080（生产）", ["--port", "3080"]],
      ["空 --host", ["--host", ""]],
      ["--host 危险字符", ["--host", "a;b"]],
      ["--host 命令替换形态", ["--host", "$(touch pwned)"]],
      ["--host 前导短横线", ["--host", "-x"]],
      ["--host 空白", ["--host", "a b"]],
      ["空 --host-dir", ["--host-dir", ""]],
      ["--host-dir 指向生产 HOME", ["--host-dir", homeDsh]],
      ["--host-dir 越界", ["--host-dir", join(REPO_ROOT, "tmp")]],
      ["--host-dir 不存在", ["--host-dir", join(REPO_ROOT, "dist-does-not-exist")]],
      ["受管参数透传", ["--profile", "evil"]],
      ["参数终止符透传", ["--", "--port", "3080"]],
      ["未知参数", ["--unknown-flag"]],
    ];
    for (const [label, extra] of cases) {
      const r = runScript(["v0.19.4", ...extra], { env: { DSH_TEST_ROOT: root, NEWAPI_ASEIT_API_KEY: canary }, cwd: sb });
      assert.equal(r.status, 2, `${label} 必须 exit 2（stdout=${r.stdout} stderr=${r.stderr}）`);
      assert.ok(r.stderr.trim().length > 0, `${label} 必须给出错误说明`);
      assert.ok(!r.stdout.includes(canary) && !r.stderr.includes(canary), `${label} 不得回显凭据值`);
      assert.ok(!r.stdout.includes("NEWAPI_ASEIT_API_KEY") && !r.stderr.includes("NEWAPI_ASEIT_API_KEY"), `${label} 不得回显凭据变量名`);
      assert.equal(snapshot(sb), before, `${label} 拒绝前后快照必须不变（零 mkdir）`);
      assert.deepEqual(processesMatching(sb), [], `${label} 不得留下进程`);
      assert.ok(!existsSync(join(sb, "pwned")), `${label} 不得执行注入内容`);
    }
    const emptyVersion = runScript([""], { env: { DSH_TEST_ROOT: root, NEWAPI_ASEIT_API_KEY: canary }, cwd: sb });
    assert.equal(emptyVersion.status, 2, "空版本必须 exit 2");
    assert.ok(!emptyVersion.stderr.includes(canary), "空版本报错不得回显凭据");
    assert.ok(!existsSync(root), "危险输入共 21 例均不得 mkdir 测试根");
    assert.ok(!existsSync(homeDsh) || !existsSync(join(homeDsh, "dsh-test")), "不得在生产 HOME 下建测试根");
    const misplaced = runScript(["v0.19.4", "--dry-run"], { env: { DSH_TEST_ROOT: homeDsh }, cwd: sb });
    assert.equal(misplaced.status, 2, "预检同样必须先拒绝生产 HOME 测试根");
    assert.ok(misplaced.stderr.includes("拒绝把测试根指向生产 HOME"), misplaced.stderr);
    // 真实看板路径（主树承载看板）：只断言「确实被拦」，**不**拿它的既有状态做存在性判据 ——
    // 主树里 `.dsh-graph` 本就存在，以仓库根为判据的「不存在」断言在那里会退化为空断言（g-426 根因）。
    const kanban = runScript(["v0.19.4", "--dry-run"], { env: { DSH_TEST_ROOT: join(REPO_ROOT, ".dsh-graph") }, cwd: sb });
    assert.equal(kanban.status, 2, "预检同样必须先拒绝看板数据测试根");
    assert.ok(kanban.stderr.includes("拒绝把测试根指向看板数据"), kanban.stderr);
    // 「不得创建看板目录」判据落在**私有沙箱**路径：守卫谓词是纯语法 `*/.dsh-graph`（与是否在仓库根
    // 无关）⇒ 同样 exit 2 + 同一拒绝文案；而沙箱内「不存在」恒可真检（任何创建都会被抓到），
    // 并与用例末尾的 `snapshot(sb)` 前后全量对照互为双重证据。
    const boardInSb = join(sb, ".dsh-graph");
    assert.ok(!existsSync(boardInSb), "沙箱内看板形态路径在调用前必须不存在（否则本条空转）");
    const kanbanInSb = runScript(["v0.19.4", "--dry-run"], { env: { DSH_TEST_ROOT: boardInSb }, cwd: sb });
    assert.equal(kanbanInSb.status, 2, "预检同样必须先拒绝沙箱内的看板形态测试根");
    assert.ok(kanbanInSb.stderr.includes("拒绝把测试根指向看板数据"), kanbanInSb.stderr);
    assert.ok(!existsSync(boardInSb), "不得创建看板目录");
    for (const bad of ["/tmp/g301-outside", join(TMP_ROOT, "..", "escape"), "relative/root"]) {
      const r = runScript(["v0.19.4", "--dry-run"], { env: { DSH_TEST_ROOT: bad }, cwd: sb });
      assert.equal(r.status, 2, `DSH_TEST_ROOT=${bad} 必须拒绝`);
      assert.equal(snapshot(sb), before, `DSH_TEST_ROOT=${bad} 不得产生副作用`);
    }
    assert.equal(snapshot(sb), before, "预检危险输入拒绝后沙箱必须与初始快照一致");
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// D. 负向对照：回退预检（基线脚本）即红
// ────────────────────────────────────────────────────────────────────────────

test("g-301 负向对照：基线脚本在拒绝前会 mkdir（回退预检 ⇒ 零副作用断言必红）", { skip: SKIP }, async () => {
  const sb = mkSandbox();
  try {
    // 自足的「假仓库」：基线脚本按自身位置解析 REPO_ROOT，故 scripts/ + tmp/ + dsh-graph-host/ 齐备。
    const fake = join(sb, "fake");
    const host = join(fake, "dsh-graph-host");
    mkdirSync(join(fake, "scripts"), { recursive: true });
    mkdirSync(join(fake, "tmp"), { recursive: true });
    mkdirSync(host, { recursive: true });
    writeFileSync(
      join(host, "package.json"),
      `${JSON.stringify({ name: "dsh-graph", version: "0.0.0-baseline", dsh: { bundle: { patch: "./cordis.patch.yml" } } })}\n`,
    );
    const baseline = join(fake, "scripts", "dsh-test-web.sh");
    writeFileSync(baseline, BASELINE_SCRIPT);
    chmodSync(baseline, 0o755);
    const baselineRoot = join(fake, "tmp", "root");
    const port = await freePort();

    // 基线对「空 --host」「--host 危险字符」都不拒绝：mkdir(...) 先发生，随后 --skip-install 门禁才退出。
    for (const badHost of ["", "x;y"]) {
      const r = spawnSync(BASH, [baseline, "v0.19.4", "--skip-install", "--host", badHost, "--port", String(port), "--host-dir", host], {
        cwd: sb,
        env: { ...(process.env as Record<string, string>), DSH_TEST_MODE: "1", DSH_TEST_ROOT: baselineRoot },
        encoding: "utf8",
      });
      assert.equal(r.status, 2, `基线自身也会非零退出：${r.stderr}`);
      assert.ok(
        existsSync(baselineRoot),
        `负向对照失效：基线（--host ${JSON.stringify(badHost)}）没有产生副作用，本套件将无法发现「预检被回退」`,
      );
      rmSync(baselineRoot, { recursive: true, force: true });
    }

    // 同一批危险输入在新实现下：先拒绝、零 mkdir。
    for (const badHost of ["", "x;y"]) {
      const r = runScript(["v0.19.4", "--host", badHost, "--port", String(port), "--host-dir", HOST_DIR], {
        env: { DSH_TEST_ROOT: join(sb, "root") },
        cwd: sb,
      });
      assert.equal(r.status, 2, `新实现必须拒绝 --host ${JSON.stringify(badHost)}`);
      assert.ok(!existsSync(join(sb, "root")), `新实现在 --host ${JSON.stringify(badHost)} 下不得 mkdir`);
    }
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// D2. g-426：看板存在性判据的判别力与防回退守卫
// ────────────────────────────────────────────────────────────────────────────

/** 内联变异（负向对照专用，不改产品脚本）：在看板守卫**之前**插入一次 mkdir ——
 *  退出码与拒绝文案逐字不变，唯一差别是「被拒绝的路径上已被创建」⇒ 存在性断言必红。 */
function mutateKanbanGuardToCreateFirst(text: string): string {
  const anchor = `case "$TEST_ROOT" in\n  */.dsh-graph|*/.dsh-graph/*) die "拒绝把测试根指向看板数据：$TEST_ROOT";;\nesac`;
  assert.ok(text.includes(anchor), "负向对照夹具必须找到看板守卫原文（否则用例空转）");
  const mutated = text.replace(anchor, `mkdir -p "$TEST_ROOT"\n${anchor}`);
  assert.notEqual(mutated, text, "负向对照必须真的改写了脚本（否则用例空转）");
  assert.ok(mutated.includes(`mkdir -p "$TEST_ROOT"\ncase "$TEST_ROOT" in`), "创建必须插在拒绝之前");
  return mutated;
}

test("g-426 负向对照：看板守卫若在拒绝前创建目录，「不得创建看板目录」断言必红", { skip: SKIP }, () => {
  const sb = mkSandbox();
  try {
    const fake = join(sb, "fake");
    mkdirSync(join(fake, "scripts"), { recursive: true });
    mkdirSync(join(fake, "tmp"), { recursive: true });
    const mutated = join(fake, "scripts", "dsh-test-web.sh");
    writeFileSync(mutated, mutateKanbanGuardToCreateFirst(readFileSync(SCRIPT, "utf8")));
    chmodSync(mutated, 0o755);
    const boardInSb = join(fake, "tmp", ".dsh-graph");
    assert.ok(!existsSync(boardInSb), "夹具起点必须没有看板目录");
    const r = spawnSync(BASH, [mutated, "v0.19.4", "--dry-run"], {
      cwd: sb,
      env: { ...(process.env as Record<string, string>), DSH_TEST_MODE: "1", DSH_TEST_ROOT: boardInSb },
      encoding: "utf8",
    });
    // 与真实脚本逐字相同的退出码 + 拒绝文案，唯一差别是目录已被创建 ⇒ 判别力只落在存在性断言上。
    assert.equal(r.status, 2, `变异脚本仍以 exit 2 拒绝：${r.stderr ?? ""}`);
    assert.ok((r.stderr ?? "").includes("拒绝把测试根指向看板数据"), r.stderr ?? "");
    assert.ok(existsSync(boardInSb), "负向对照：变异脚本确实在被拒绝的看板路径上创建了目录（否则对照失效）");
    // 实拍变红：把新断言原样跑一遍，此刻必须抛出（证明它能抓到创建）。
    assert.throws(
      () => assert.ok(!existsSync(boardInSb), "不得创建看板目录"),
      /不得创建看板目录/,
      "负向对照：目录一被创建，新断言必红（本套件具备判别力）",
    );
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("g-426 防回退守卫：看板存在性判据必须绑定私有沙箱，不得以仓库根既有状态为判据", { skip: SKIP }, () => {
  const src = readFileSync(join(import.meta.dirname, "g301-dry-run-doctor.test.ts"), "utf8");
  // 禁形：以仓库根既有状态为判据的存在性断言（主树里看板目录本就存在 ⇒ 断言退化为恒真）。
  assert.ok(
    !/!\s*existsSync\(\s*join\(\s*REPO_ROOT\s*,\s*"\.dsh-graph"\s*\)\s*\)/.test(src),
    "回退警报：不得以仓库根既有状态判定「不得创建看板目录」",
  );
  assert.ok(src.includes(`const boardInSb = join(sb, ".dsh-graph")`), "存在性判据必须落在私有沙箱路径 boardInSb");
  assert.ok(
    /assert\.ok\(!existsSync\(boardInSb\),\s*"不得创建看板目录"\)/.test(src),
    "必须保留「不得创建看板目录」断言并绑定沙箱路径（不得 skip/todo 或删除）",
  );
});

// ────────────────────────────────────────────────────────────────────────────
// E. 边界守恒：不恢复旧体系、不加缓存/环境管理器（结构性守卫）
// ────────────────────────────────────────────────────────────────────────────

test("g-301 边界守恒：脚本仍是启动路径本体，未引入 install 缓存/环境管理器/旧 launcher", { skip: SKIP }, () => {
  const text = readFileSync(SCRIPT, "utf8");
  for (const banned of ["dev-dsh-instance", "golden", "--profile-registry", "install-cache", "env-manager"]) {
    assert.ok(!text.includes(banned), `不得恢复旧体系/引入安装缓存或环境管理器：${banned}`);
  }
  assert.ok(!existsSync(join(REPO_ROOT, "scripts", "dev-dsh-instance.sh")), "旧 launcher 必须留在 archived/ 下");
  assert.ok(existsSync(join(REPO_ROOT, "scripts", "archived", "dev-dsh-instance.sh")), "归档件不得复活到顶层");
  // 预检段必须仍复用启动路径的判定函数（同一份 profile_ready），而不是另写一套
  assert.ok(text.includes("profile_ready()"), "必须保留启动路径的 profile_ready 判定");
  assert.ok(text.includes("if profile_ready; then pr_ready=1; fi"), "预检必须复用 profile_ready 做裁决");
  // 启动路径的关键动作必须仍在预检段之后（预检提前 return，不可能走到 mkdir/install）
  const dryReturn = text.indexOf('if doctor; then exit 0; else exit 1; fi');
  const mkdirIdx = text.indexOf('mkdir -p "$DSH_HOME"');
  assert.ok(dryReturn > 0 && mkdirIdx > dryReturn, "预检必须早于 mkdir/install/启动返回");
});
