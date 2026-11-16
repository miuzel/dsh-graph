/**
 * dsh-graph 路径定位（g-314 判据 5）：默认从 cwd 向上查找 `.dsh-graph`；`--root` 支持绝对/相对；
 * 拒绝越界与危险路径；隔离项目不误用用户全局配置。
 *
 * **复用**：最终 root 一律经 `core/root.ts` 的 `resolveCanonicalRoot` 收口（linked worktree
 * 归一、scratch 边界、symlink 拒收），本模块只负责「找到候选 workspace 起点」这一层，
 * 绝不重写 root 语义。
 *
 * 「不误用用户全局配置」（判据 5）：向上查找**只认 `.dsh-graph` 目录本体**，不读
 * `$DSH_HOME` / `~/.dsh` 下的任何东西；到达文件系统根仍无 `.dsh-graph` ⇒ 明确报「非工作区」，
 * **绝不**回落到用户全局目录。
 */
import { existsSync, lstatSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DEFAULT_GRAPH_DIR_NAME, relativeGraphDirName, resolveCanonicalRoot, type CanonicalRootResult } from "../root.ts";

/** 看板目录名（**默认值**；g-632 B 起按项目可配，见 `LocateOptions.dirName`）。 */
export const GRAPH_DIR_NAME = DEFAULT_GRAPH_DIR_NAME;

export interface LocateOptions {
  /** 起始目录（默认 process.cwd()）。 */
  cwd?: string;
  /** 显式 `--root` 值（绝对或相对起始目录）；null/undefined 表示向上查找。 */
  root?: string | null;
  /**
   * g-632 B：核心资料目录名（项目级自定义；工作区内相对路径，默认 `.dsh-graph`）。
   * 只在 `--root` 未给出时参与「向上查找」，以及 `--root` 指向 workspace（而非看板目录本身）时的补齐。
   */
  dirName?: string | null;
}

export interface LocateResult {
  /** 最终 canonical graph root（绝对路径）。 */
  root: string;
  /** 用于 root 解析的 workspace 起点。 */
  workspace: string;
  /** 解析模式（透传 core 的 mode，便于 info 展示）。 */
  mode: CanonicalRootResult["mode"];
  /** root 是否来自 `--root` 显式给出。 */
  explicit: boolean;
  /** core 给出的 worktree 告警（如有）。 */
  warning?: string;
}

/** 定位失败：`code` 供测试稳定断言，`message` 面向人类可读。 */
export class LocateError extends Error {
  readonly code:
    | "root-forbidden"
    | "root-symlink"
    | "root-not-found"
    | "graph-not-found"
    | "not-a-directory"
    | "empty-root";
  constructor(code: LocateError["code"], message: string) {
    super(message);
    this.name = "LocateError";
    this.code = code;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 严格包含判定：`child` 是否等于 `parent` 或位于其下（按路径段，不受前缀同名目录影响）。 */
export function isPathWithin(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * 从 `start` 向上查找最近含 `.dsh-graph` 目录的祖先（含 `start` 自身）。
 * 返回该祖先目录（workspace 起点）；未找到返回 null。
 */
export function findGraphWorkspace(start: string, dirName: string = GRAPH_DIR_NAME): string | null {
  let cur = resolve(start);
  for (;;) {
    if (isDir(join(cur, dirName))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null; // 已到文件系统根
    cur = parent;
  }
}

/**
 * 拒绝「危险路径」（判据 5）。
 *
 * 注意：**不能**用「必须位于 cwd 之内/祖先」这种包含关系来判定越界 —— 它是过度设计且会
 * 误伤正常用法：`cd src && dsh-graph --root ../.dsh-graph` 里的 `.dsh-graph` 是 `cwd` 的
 * **兄弟**，正是最典型的合法写法（真实单测当场报红）。危险边界只取两类**客观红线**：
 *
 * 1. 文件系统根 `/` 与各级家目录根本身（`/`、`~`、`$HOME`）——把整机/整个家目录当看板根
 *    必然造成不可控读写，一律拒绝；
 * 2. **用户全局配置目录**（`$DSH_HOME`，默认 `~/.dsh`）及其子目录 —— 判据 5 明确要求
 *    「隔离项目时不得误用用户全局配置」，这是全局配置与项目数据之间的隔离红线。
 */
function assertSafeRoot(abs: string): void {
  const forbidden = new Set<string>([resolve(sep)]);
  const home = process.env.HOME ?? "";
  if (home) forbidden.add(resolve(home));
  if (abs === resolve(sep) || forbidden.has(abs)) {
    throw new LocateError(
      "root-forbidden",
      `--root 拒绝使用系统根或家目录本身作为看板根：${abs}（请指向具体的项目看板目录）`,
    );
  }
  // 全局配置目录：$DSH_HOME（缺省 ~/.dsh）。隔离项目绝不得读写它。
  const dshHome = process.env.DSH_HOME?.trim() || (home ? join(home, ".dsh") : "");
  if (dshHome) {
    const resolvedDshHome = resolve(dshHome);
    if (isPathWithin(resolvedDshHome, abs) || isPathWithin(abs, resolvedDshHome)) {
      throw new LocateError(
        "root-forbidden",
        `--root 拒绝指向用户全局配置目录 ${resolvedDshHome}（隔离项目不得误用全局配置）：${abs}`,
      );
    }
  }
  assertNotSymlinkedGraphRoot(abs);
}

/** 看板根自身不得是符号链接（core 的 rejectSymlinkRoot 会抛裸 Error；这里提前给出可读结构错误）。 */
function assertNotSymlinkedGraphRoot(abs: string): void {
  try {
    if (lstatSync(abs).isSymbolicLink()) {
      throw new LocateError("root-symlink", `--root 拒绝符号链接目录（防越界）：${abs}`);
    }
  } catch (e) {
    if (e instanceof LocateError) throw e;
    /* lstat 失败（竞态）交回 core 处理 */
  }
}

/**
 * 解析 graph root。
 *
 * 1. `--root` 显式给出：相对值以 cwd 为基准解析为绝对路径；路径不存在 / 不是目录 ⇒ 报错。
 *    危险路径拒绝（见 `assertSafeRoot`）：系统根/家目录根、以及 `$DSH_HOME` 全局配置目录。
 * 2. 未给出：从 cwd 向上查找 `.dsh-graph`；找不到 ⇒ 「非工作区」错误（**不**回落全局配置）。
 * 3. 两种情况都经 `resolveCanonicalRoot({root: <绝对>}, workspace)` 归一（worktree/scratch/symlink）。
 */
export function locateGraphRoot(opts: LocateOptions = {}): LocateResult {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const rawRoot = opts.root ?? null;
  // g-632 B：目录名先过越界校验（`..` / 绝对路径一律拒绝，避免自定义名把根移出工作区）。
  let dirName: string;
  try {
    dirName = relativeGraphDirName({ root: opts.dirName ?? undefined });
  } catch (e) {
    throw new LocateError("root-forbidden", `核心资料目录名非法：${(e as Error).message}`);
  }

  if (rawRoot !== null) {
    const trimmed = rawRoot.trim();
    if (trimmed === "") throw new LocateError("empty-root", "选项 --root 的路径不能为空");
    // 显式 --root 的基准是 cwd（与 shell 的相对路径语义一致）
    const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
    if (!existsSync(abs)) {
      throw new LocateError("root-not-found", `--root 指向的路径不存在：${abs}`);
    }
    if (!isDir(abs)) {
      throw new LocateError("not-a-directory", `--root 必须指向目录：${abs}`);
    }
    assertSafeRoot(abs);
    // `--root` 语义：既接受「看板目录本身」（.../ws/.dsh-graph），也接受「看板所在 workspace」
    // （.../ws）。后者按 core 的默认相对 root 约定补齐 `.dsh-graph`——否则用户写
    // `--root <项目根>` 会得到一个不含事件流的空目录（静默误读），是难以察觉的错误。
    // 判定「本身就是看板目录」= 目录名恰为 `.dsh-graph` **且**其父目录里没有同名子目录
    // （不能只看 `existsSync(abs/.dsh-graph)`：任何带 `.dsh-graph` 子目录的 workspace 都满足它）。
    // g-632 B：判定口径按目录名首段推广到自定义名（`board-a` / `boards/main`）。
    const firstSeg = dirName.split("/")[0];
    const isGraphDirItself = isDir(abs) && (basename(abs) === firstSeg || abs.endsWith(`/${dirName}`));
    const effectiveRoot = isGraphDirItself ? abs : join(abs, dirName);
    const result = resolveCanonicalRoot({ root: effectiveRoot }, cwd);
    return {
      root: result.root,
      workspace: result.workspace,
      mode: result.mode,
      explicit: true,
      warning: result.rootWarning,
    };
  }

  const workspace = findGraphWorkspace(cwd, dirName);
  if (workspace === null) {
    throw new LocateError(
      "graph-not-found",
      `当前目录 ${cwd} 及其所有祖先目录都没有 ${dirName}（非 dsh-graph 工作区）；` +
        `请在项目根运行，或用 --root 指定看板目录`,
    );
  }
  // g-632 B：向上查找按目录名完成，但 root **仍**交给 core 统一解析（worktree 归一/scratch/symlink），
  // 只在目录名非默认时把相对名显式传下去 —— 默认路径沿用 `null`（与 g-149 旧调用逐字一致）。
  const result = dirName === GRAPH_DIR_NAME ? resolveCanonicalRoot(null, workspace) : resolveCanonicalRoot({ root: dirName }, workspace);
  return {
    root: result.root,
    workspace: result.workspace,
    mode: result.mode,
    explicit: false,
    warning: result.rootWarning,
  };
}
