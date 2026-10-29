/** g-611：真实宿主夹具的**私有测试根**守卫（test-only helper；产品代码绝不 import 本文件）。
 *
 * 背景（真实污染，已实测）：`g507-http-auth-real-host.test.ts` 的 `startHost` 创建并初始化了私有
 * workspace，却没有把它放进返回对象 ⇒ `h.ws === undefined` ⇒ 业务请求拼出
 * `?workspace=undefined`。host 侧 `workspaceOf` 把它当**普通相对路径**（`resolve("undefined")`
 * = `<cwd>/undefined`），`resolveCanonicalRoot` 在「目录尚不存在」时回退 workspace-local（首跑建
 * 本地骨架），而在后续运行（目录已存在且 `undefined/` 未被 gitignore）时把它当作 linked worktree
 * 子目录**归一化到真实主工作树的 `.dsh-graph`** ⇒ 真实 owner POST 的静态标题写进真实看板。
 * 私有沙盒实测（嵌套 git primary + linked worktree）复现了这两阶段的 mode 变化，见
 * `g611-private-workspace-isolation.test.ts`。
 *
 * 本 helper 的职责（全部 fail-closed，且**只碰本进程自己创建**的路径）：
 *   1. `createPrivateTestRoot`：在仓库自有 `tmp/g611-tests/` 下用 `mkdtemp` 建独占目录；创建前
 *      **逐段验证**既有父目录都是真实目录（realpath === 自身，禁符号链接），创建后复查 base/目录
 *      realpath；成功即登记进**本进程 owned 集合**（只有集合内路径允许删除）。
 *   2. `assertPrivateTestRoot`：证明 `ws` 是「本次测试独占的私有根」——绝对路径、realpath 自身、
 *      位于唯一私有 base 之下、不是真实主工作树/真实看板/其他 worktree；plugin config 不得有绝对
 *      `root`（生产 `isAbsoluteConfig` 会绕过解析）；并用与生产 `rootForReq` **逐字相同**的
 *      `resolveCanonicalRoot(config, resolve(ws))`（默认 TTL）**与** `{ttlMs:0}` 双查，二者必须同为
 *      `workspace-fallback` 且 root 相同、恰为 `<ws>/<relRoot>`（排除跨运行/进程内缓存改变答案）。
 *      **调用方必须先 guard 后 `init()`** —— 写入之前就证明最终 realpath 归属。
 *   3. `removePrivateTestRoot`：只删 owned 集合内、且父目录**正好**是其创建时 base、realpath 自身的
 *      目录；名字像 `g611-` 但不在集合里的路径一律拒绝（绝不因名字清理用户/他人的 tmp）。
 *
 * 真实看板**不读正文**：本 helper 只做路径比较（`realMainWorktree` / `realBoardRoot`），不递归扫描
 * 用户看板/记忆/目标正文；隔离证明由「生产 resolver 返回私有根」+「私有 fake 主图对照」完成。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveCanonicalRoot } from "../root.ts";

/** 仓库根（canonical realpath；测试文件位于 `<repo>/core/tests/`）。 */
export const REPO_ROOT = realpathSync(resolve(import.meta.dirname, "../.."));

/** **唯一**私有测试 base：仓库自有、已 git-ignored 的 `tmp/`（AGENTS.md 纪律 + g-363 scratch 边界）。 */
export const PRIVATE_BASE = join(REPO_ROOT, "tmp", "g611-tests");

/** 真实宿主夹具实际传给 `apply(ctx, config)` 的 config（空对象 ⇒ 相对 root `.dsh-graph`）。 */
export const PLUGIN_CONFIG: { root?: string } = Object.freeze({});

export interface PrivateRootInfo {
  /** 已校验的私有 workspace（绝对 realpath）。 */
  workspace: string;
  /** 生产 resolver 对该 workspace 给出的 graph root（必须 `<workspace>/.dsh-graph`）。 */
  root: string;
  /** 真实主工作树根（只做路径比较，绝不读写）。 */
  mainWorktree: string;
  /** 真实看板根（只做路径比较，绝不读写其正文）。 */
  mainBoard: string;
}

/** 本进程创建过的私有根 → 创建时的 base（删除许可的白名单）。 */
const OWNED = new Map<string, string>();

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=g611-guard", "-c", "user.email=g611-guard@invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** 真实主工作树根（在 linked worktree 内跑测试时，真实看板在它下面而非当前 worktree 下）。 */
export function realMainWorktree(): string {
  return resolve(git(REPO_ROOT, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "..");
}

/** 真实（生产）看板根 —— **只用于路径比较**，绝不读内容。 */
export function realBoardRoot(): string {
  return join(realMainWorktree(), ".dsh-graph");
}

/** `child` 是否位于 `parent` 之下或与之相等（调用方保证 realpath 已校验）。 */
export function isUnderOrEqual(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 本次运行唯一 marker（UUID）—— 仅用于本次自己的私有目录内定位，不用于扫描真实看板。 */
export function uniqueMarker(tag: string): string {
  return `g611-${tag}-${randomUUID()}`;
}

/**
 * 逐段验证 `target` 在 `root` 之内的**既有**父目录都是真实目录（realpath === 自身，非符号链接）。
 * 尚不存在的尾部由调用方 `mkdir` 之后再整体复查。
 */
function assertSegmentsRealWithin(root: string, target: string): void {
  if (!isUnderOrEqual(root, target)) throw new Error(`g611: 路径越出仓库根：${target}（root=${root}）`);
  const chain: string[] = [];
  for (let p = target; p !== root; p = dirname(p)) chain.push(p);
  for (const seg of chain.reverse()) {
    if (!existsSync(seg)) continue;
    const real = realpathSync(seg);
    if (real !== seg) throw new Error(`g611: 拒绝在符号链接路径下创建私有根：${seg} -> ${real}`);
    if (!statSync(seg).isDirectory()) throw new Error(`g611: 私有根父路径不是目录：${seg}`);
  }
}

/**
 * 在仓库自有 `tmp/g611-tests/` 下创建一个**本进程独占**目录（`mkdtemp`），并登记进 owned 集合。
 * 创建前后都验证 realpath（禁符号链接/越界）；失败即抛错且不留下已登记路径。
 *
 * `opts.repoRoot` 仅供**负向测试**自建 fake 仓库根（默认真实 REPO_ROOT）；无论哪种，写入都只可能
 * 落在该 root 的 `tmp/` 内。
 */
export function createPrivateTestRoot(tag: string, opts: { repoRoot?: string } = {}): string {
  const repoRoot = resolve(opts.repoRoot ?? REPO_ROOT);
  if (!existsSync(repoRoot)) throw new Error(`g611: 仓库根不存在：${repoRoot}`);
  if (realpathSync(repoRoot) !== repoRoot) throw new Error(`g611: 仓库根必须是 realpath：${repoRoot}`);
  if (!statSync(repoRoot).isDirectory()) throw new Error(`g611: 仓库根不是目录：${repoRoot}`);
  const base = join(repoRoot, "tmp", "g611-tests");
  assertSegmentsRealWithin(repoRoot, base); // 既有父目录（含 repoRoot/tmp）不得是符号链接
  mkdirSync(base, { recursive: true });
  if (realpathSync(base) !== base) throw new Error(`g611: 私有 base 必须是 realpath：${base}`);
  if (!statSync(base).isDirectory()) throw new Error(`g611: 私有 base 不是目录：${base}`);

  const safeTag = tag.replace(/[^a-zA-Z0-9._-]/g, "-") || "root";
  const dir = mkdtempSync(join(base, `g611-${safeTag}-`));
  try {
    if (realpathSync(dir) !== dir) throw new Error(`g611: 私有根必须是 realpath：${dir}`);
    if (dirname(dir) !== base) throw new Error(`g611: 私有根必须是私有 base 的直接子目录：${dir}`);
    if (!statSync(dir).isDirectory()) throw new Error(`g611: 私有根不是目录：${dir}`);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true }); // 只删刚由 mkdtemp 创建的本进程路径
    throw e;
  }
  OWNED.set(dir, base);
  return dir;
}

/**
 * 清理**本进程自己创建**的私有根：必须①在 owned 集合内 ②父目录正好是创建时的 base
 * ③realpath 与自身一致。其他路径（既有 tmp、既有 `undefined`、他人 worktree、真实看板）一律拒绝。
 */
export function removePrivateTestRoot(dir: unknown): void {
  assert.equal(typeof dir, "string", "removePrivateTestRoot 只接受字符串路径");
  const path = dir as string;
  assert.ok(isAbsolute(path), `removePrivateTestRoot 只接受绝对路径：${path}`);
  const d = resolve(path);
  const base = OWNED.get(d);
  if (!base) {
    throw new Error(`g611: 拒绝删除非本进程自建路径（不在 owned 集合）：${d}`);
  }
  assert.equal(dirname(d), base, `g611: 拒绝删除父目录非创建 base 的路径：${d}（base=${base}）`);
  assert.ok(basename(d).startsWith("g611-"), `g611: 拒绝删除非本次自建命名：${d}`);
  if (!existsSync(d)) {
    OWNED.delete(d); // 已被本测试自身提前清理：幂等
    return;
  }
  assert.equal(realpathSync(d), d, `g611: 拒绝删除 realpath 不一致的路径（可能是符号链接）：${d}`);
  rmSync(d, { recursive: true, force: true });
  OWNED.delete(d);
}

/**
 * 证明 `ws` 是本次测试独占的私有根（fail-closed）。**调用方必须先调用本函数、再 `init()`。**
 * 失败信息点名原因（旧夹具的 `undefined` 因此一眼判红，而不是悄悄写主图）。
 */
export function assertPrivateTestRoot(
  ws: unknown,
  opts: { where?: string; config?: { root?: string } | null; requireInitialized?: boolean } = {},
): PrivateRootInfo {
  const where = opts.where ?? "g611 私有测试根";
  const config = opts.config ?? PLUGIN_CONFIG;
  const refuse = (why: string): never => {
    throw new Error(`${where}: 拒绝使用该测试 workspace（fail-closed，未发出任何请求）—— ${why}`);
  };

  if (typeof ws !== "string") refuse(`workspace 必须是字符串（实得 ${ws === null ? "null" : typeof ws}）`);
  const candidate = ws as string;
  if (!candidate.trim()) refuse("workspace 为空字符串");
  if (candidate.trim() === "undefined") refuse('workspace 是字面量 "undefined"（旧 startHost 漏返回 ws 的典型症状）');
  if (!isAbsolute(candidate)) refuse(`workspace 必须是绝对路径（实得 ${candidate}）`);
  if (candidate !== resolve(candidate)) refuse(`workspace 必须已规范化（实得 ${candidate}）`);

  let realWs: string;
  try {
    realWs = realpathSync(candidate);
  } catch {
    // 不存在或不可解析：连同「首跑本地回退」一起拒绝（私有根必须由 createPrivateTestRoot 建好）
    return refuse(`workspace 不存在或不可解析（实得 ${candidate}）`);
  }
  if (realWs !== candidate) refuse(`workspace 必须是 realpath（禁止符号链接/.. 越界）：${candidate} -> ${realWs}`);
  if (!statSync(candidate).isDirectory()) refuse(`workspace 不是目录：${candidate}`);

  // 生产 `isAbsoluteConfig` 会完全绕过 workspace 解析 ⇒ 夹具不得使用绝对 config.root。
  if (config && typeof config.root === "string" && isAbsolute(config.root)) {
    refuse(`plugin config.root 是绝对路径 ${config.root}（会绕过 workspace→root 解析，夹具不得使用）`);
  }

  // 唯一私有 base（逐段 realpath 校验：既有父目录不得是符号链接）。
  if (candidate === PRIVATE_BASE || !isUnderOrEqual(PRIVATE_BASE, candidate)) {
    refuse(`workspace 必须位于唯一私有 base ${PRIVATE_BASE} 之下（实得 ${candidate}）`);
  }
  try {
    assertSegmentsRealWithin(PRIVATE_BASE, candidate);
  } catch (e: any) {
    refuse(String(e?.message ?? e));
  }
  if (isUnderOrEqual(REPO_ROOT, candidate) && relative(REPO_ROOT, candidate).split(sep).includes(".worktrees")) {
    refuse(`workspace 不得位于 .worktrees 之下（实得 ${candidate}）`);
  }

  // 受保护路径（真实主工作树/真实看板/其他 worktree）：只做路径比较。
  // 测试本身可能就跑在 linked worktree 里（`<main>/.worktrees/g-…-att-…`），此时**本 worktree**
  // 的 `tmp/` 落在 `<main>/.worktrees` 之下是合法的；只拒绝**别的** worktree（不在 REPO_ROOT 内）。
  const mainWorktree = realMainWorktree();
  const mainBoard = join(mainWorktree, ".dsh-graph");
  const ownWorktree = isUnderOrEqual(REPO_ROOT, candidate);
  const hitsProtectedTree = (p: string): string | null => {
    if (isUnderOrEqual(mainBoard, p)) return mainBoard;
    if (isUnderOrEqual(join(mainWorktree, ".worktrees"), p) && !ownWorktree) return join(mainWorktree, ".worktrees");
    return null;
  };
  for (const protectedExact of [mainWorktree, REPO_ROOT]) {
    if (candidate === protectedExact) refuse(`workspace 命中受保护路径 ${protectedExact}`);
  }
  const protectedHit = hitsProtectedTree(candidate);
  if (protectedHit) refuse(`workspace 命中受保护路径树 ${protectedHit}`);

  // 与生产 rootForReq 同一调用形态：默认 TTL（逐字一致）+ ttl=0（强制新发现），两者必须一致。
  const relRoot = typeof config?.root === "string" && config.root ? config.root : ".dsh-graph";
  const expectedRoot = resolve(candidate, relRoot);
  const asServerCalls = resolveCanonicalRoot(config, resolve(candidate));
  const freshDiscovery = resolveCanonicalRoot(config, resolve(candidate), { ttlMs: 0 });
  if (asServerCalls.mode !== "workspace-fallback" || freshDiscovery.mode !== "workspace-fallback") {
    refuse(
      `生产 resolver 的 mode=${asServerCalls.mode}/${freshDiscovery.mode}（期望 workspace-fallback；`
      + `canonicalized 意味着会被归一到真实看板 ${asServerCalls.root ?? "?"}）`,
    );
  }
  if (resolve(asServerCalls.root) !== expectedRoot || resolve(freshDiscovery.root) !== expectedRoot) {
    refuse(`生产 resolver 的 root=${asServerCalls.root}/${freshDiscovery.root}（期望 ${expectedRoot}）`);
  }
  const rootProtectedHit = hitsProtectedTree(expectedRoot);
  if (rootProtectedHit) refuse(`resolver root 命中受保护路径树 ${rootProtectedHit}`);
  if (opts.requireInitialized && !existsSync(join(expectedRoot, "events.jsonl"))) {
    refuse(`${expectedRoot} 尚未由 init() 初始化（缺 events.jsonl）`);
  }

  return { workspace: candidate, root: expectedRoot, mainWorktree, mainBoard };
}

/**
 * 业务请求的 workspace 查询串：**先** fail-closed 校验私有根，**再**拼 query。
 * 因此「ws 缺失 / 字面量 undefined / 相对路径 / 主图 / 其他 worktree」在**请求发出之前**就抛错，
 * 绝不生成 `?workspace=undefined` 这类可被 host 当相对路径解析的 URL。
 */
export function workspaceQuery(
  ws: unknown,
  opts: { where?: string; config?: { root?: string } | null; requireInitialized?: boolean } = {},
): string {
  const info = assertPrivateTestRoot(ws, opts);
  const query = `?workspace=${encodeURIComponent(info.workspace)}`;
  assert.ok(query.includes(encodeURIComponent(info.workspace)), "query 必须携带编码后的私有 workspace");
  assert.ok(!/workspace=(undefined|null|true|false|\d+)(&|$)/.test(query), `query 不得是 undefined/非路径值：${query}`);
  return query;
}
