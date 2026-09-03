/**
 * 统一 root 解析（g-112）：host 与 client 两半共用同一函数，杜绝解析分叉。
 * g-113 修订：基准 = 会话 workspace（session.header.cwd），不再默认服务进程 process.cwd()——
 * dsh web 服务进程的 cwd 在 bwrap 沙箱里固定（≈ ~/.dsh/profiles/web），不是当前会话的 workspace，
 * 用它会读到 profile 本地空骨架而非项目自己的 .dsh-graph。
 *
 * 约定：resolveRoot(config, workspaceRoot) 的 workspaceRoot 必须由调用方显式注入——
 * host 工具侧传 ex.agent.session.header.cwd（或 sandboxPolicy.workspaceRoot），
 * client board 端点侧传请求携带的 workspace 参数；process.cwd() 仅作最后的兜底
 * （CLI/headless 等无会话上下文场景）。
 * 默认相对 `.dsh-graph`——git 友好、多项目各用各数据（第三方插件数据约定在工作区内，非 $DSH_HOME）。
 * config.root 仍可覆盖（用户层 patch / --patch overlay）：绝对路径原样返回，相对路径以 workspace 根为基准。
 *
 * g-149 扩展：Git linked-worktree canonicalization。
 * `resolveCanonicalRoot` 包装 `resolveRoot`，在 config.root 为相对路径时检测 workspace
 * 是否处于 Git linked worktree，若是则归一到主工作树的 canonical graph root。
 * 显式绝对 config.root 不做 Git 发现（管理员覆盖）；Git 发现失败时安全回退到普通 resolveRoot。
 */
import { resolve, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";

/** Default TTL for canonical root / git worktree cache: 30 seconds. */
export const DEFAULT_CANONICAL_CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  gitMtimeMs: number | null;
}

const worktreeInfoCache = new Map<string, CacheEntry<GitWorktreeInfo | null>>();
const canonicalRootCache = new Map<string, CacheEntry<CanonicalRootResult>>();

/**
 * Inspect .git path (directory or worktree pointer file) mtime for cache invalidation.
 * Returns null if .git is not found or stat fails.
 */
function getGitMtime(workspaceRoot: string): number | null {
  try {
    const gitPath = resolve(workspaceRoot, ".git");
    if (existsSync(gitPath)) {
      return statSync(gitPath).mtimeMs;
    }
  } catch {
    // Ignore stat failures
  }
  return null;
}

/** Clear all in-memory git worktree and canonical root caches (testing/debugging). */
export function _clearCanonicalRootCache(): void {
  worktreeInfoCache.clear();
  canonicalRootCache.clear();
}

/** Check whether a cache entry is still valid (TTL not expired and .git mtime unchanged). */
function isCacheEntryValid<T>(workspaceKey: string, entry: CacheEntry<T>, ttlMs: number): boolean {
  if (Date.now() - entry.timestamp > ttlMs) {
    return false;
  }
  const currentMtime = getGitMtime(workspaceKey);
  if (currentMtime !== entry.gitMtimeMs) {
    return false;
  }
  return true;
}
function rejectSymlinkRoot(root: string): string {
  try {
    let probe = resolve(root);
    while (!existsSync(probe)) { const parent = resolve(probe, ".."); if (parent === probe) break; probe = parent; }
    if (realpathSync(probe) !== probe) throw new Error("graph root symlink is not allowed");
  } catch (e: any) { if (e?.message === "graph root symlink is not allowed") throw e; }
  return root;
}
export function resolveRoot(
  config?: { root?: string } | null,
  workspaceRoot: string = process.cwd(),
): string {
  return rejectSymlinkRoot(resolve(workspaceRoot, config?.root ?? ".dsh-graph"));
}

/** Git discovery metadata returned by `discoverGitWorktree`. */
export interface GitWorktreeInfo {
  /** Absolute path to the primary/main worktree. */
  mainWorktree: string;
  /** Absolute path to the current workspace (the one that was inspected). */
  workspace: string;
  /** Whether the workspace is a linked worktree (vs. the main worktree itself). */
  isLinkedWorktree: boolean;
}

/** Options for discoverGitWorktree / resolveCanonicalRoot. */
export interface CanonicalRootOptions {
  /** Cache TTL in milliseconds (default: 30_000). Set to 0 to bypass/refresh cache. */
  ttlMs?: number;
}

/** Custom runner for git exec commands (overridable in tests/mocking). */
export const _gitRunner = {
  execSync: (cmd: string, options: any) => execSync(cmd, options),
};

/**
 * Discover Git worktree metadata for a workspace directory.
 * Uses `git worktree list --porcelain` whose first entry is always the main worktree.
 * Results are cached in memory per workspace with TTL and .git mtime validation.
 * Returns null if the workspace is not inside a Git repo, git is unavailable,
 * or the command fails for any reason (safe fallback).
 */
export function discoverGitWorktree(
  workspaceRoot: string,
  options?: CanonicalRootOptions,
): GitWorktreeInfo | null {
  const workspaceKey = resolve(workspaceRoot);
  const ttlMs = options?.ttlMs ?? DEFAULT_CANONICAL_CACHE_TTL_MS;

  if (ttlMs > 0) {
    const cached = worktreeInfoCache.get(workspaceKey);
    if (cached && isCacheEntryValid(workspaceKey, cached, ttlMs)) {
      return cached.value;
    }
  }

  let info: GitWorktreeInfo | null = null;
  const gitMtimeMs = getGitMtime(workspaceKey);

  try {
    // First, verify this is a Git repo (any kind — main or linked worktree)
    _gitRunner.execSync("git rev-parse --is-inside-work-tree", {
      cwd: workspaceKey,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rawOutput = _gitRunner.execSync("git worktree list --porcelain", {
      cwd: workspaceKey,
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse the first worktree entry (always the main worktree)
    const output = typeof rawOutput === "string" ? rawOutput : String(rawOutput);
    const lines = output.split("\n");
    let mainPath: string | null = null;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        mainPath = line.slice("worktree ".length).trim();
        break;
      }
    }
    if (mainPath) {
      const resolvedWorkspace = workspaceKey;
      const isLinked = resolvedWorkspace !== resolve(mainPath);

      info = {
        mainWorktree: resolve(mainPath),
        workspace: resolvedWorkspace,
        isLinkedWorktree: isLinked,
      };
    }
  } catch {
    info = null; // not a git repo, git command failed, or git unavailable
  }

  if (ttlMs > 0) {
    worktreeInfoCache.set(workspaceKey, {
      value: info,
      timestamp: Date.now(),
      gitMtimeMs,
    });
  }

  return info;
}

/** Result metadata from `resolveCanonicalRoot`. */
export interface CanonicalRootResult {
  /** The resolved canonical graph root (absolute path). */
  root: string;
  /** The original workspace that was passed in. */
  workspace: string;
  /** The workspace that was used for resolution (may differ from workspace if canonicalized). */
  canonicalWorkspace: string;
  /**
   * Resolution mode:
   * - "absolute-config": explicit absolute config.root, no Git discovery
   * - "main-tree": workspace is the main worktree (or non-Git), normal resolution
   * - "canonicalized": workspace was a linked worktree, resolved to main worktree
   * - "workspace-fallback": Git discovery failed, fell back to workspace-local resolution
   */
  mode: "absolute-config" | "main-tree" | "canonicalized" | "workspace-fallback";
  /** Warning message when legacy worktree-local graph data is detected. */
  rootWarning?: string;
}

/**
 * Canonical graph root resolver (g-149, g-210 cached).
 *
 * Wraps `resolveRoot` with Git linked-worktree detection:
 * - Explicit absolute `config.root`: returns as-is, no Git discovery.
 * - Relative config.root (default `.dsh-graph`): if workspace is a Git linked worktree,
 *   canonicalizes to `<main-worktree>/<config.root>`. If discovery fails, falls back to
 *   normal `resolveRoot` with mode "workspace-fallback".
 * - Detects legacy worktree-local `.dsh-graph` directories and attaches warnings.
 * - Caches results in memory per (workspace, config.root) key to eliminate per-request
 *   synchronous git subprocess calls.
 *
 * The `init` function is NOT called here — callers decide whether/where to init.
 */
export function resolveCanonicalRoot(
  config?: { root?: string } | null,
  workspaceRoot: string = process.cwd(),
  options?: CanonicalRootOptions,
): CanonicalRootResult {
  const rawRoot = config?.root;
  const workspace = resolve(workspaceRoot);

  // Case 1: explicit absolute config.root — bypass Git discovery entirely
  if (rawRoot && isAbsolute(rawRoot)) {
    return {
      root: rejectSymlinkRoot(resolve(rawRoot)),
      workspace,
      canonicalWorkspace: workspace,
      mode: "absolute-config",
    };
  }

  const relRoot = rawRoot ?? ".dsh-graph";
  const ttlMs = options?.ttlMs ?? DEFAULT_CANONICAL_CACHE_TTL_MS;
  const cacheKey = `${workspace}::${relRoot}`;

  if (ttlMs > 0) {
    const cached = canonicalRootCache.get(cacheKey);
    if (cached && isCacheEntryValid(workspace, cached, ttlMs)) {
      return cached.value;
    }
  }

  const localRoot = rejectSymlinkRoot(resolve(workspace, relRoot));

  // Attempt Git discovery
  const gitInfo = discoverGitWorktree(workspace, { ttlMs });

  let result: CanonicalRootResult;

  if (!gitInfo) {
    // Not a Git repo or git unavailable — workspace-local fallback
    result = {
      root: localRoot,
      workspace,
      canonicalWorkspace: workspace,
      mode: "workspace-fallback",
    };
  } else if (!gitInfo.isLinkedWorktree) {
    // If workspace IS the main worktree, normal resolution
    result = {
      root: localRoot,
      workspace,
      canonicalWorkspace: workspace,
      mode: "main-tree",
    };
  } else {
    // Linked worktree — canonicalize to main worktree
    const canonicalRoot = rejectSymlinkRoot(resolve(gitInfo.mainWorktree, relRoot));
    let rootWarning: string | undefined;

    // Detect legacy worktree-local graph data
    if (existsSync(localRoot) && existsSync(resolve(localRoot, "events.jsonl"))) {
      rootWarning = `发现 worktree 本地旧看板 ${localRoot}；canonical graph root 为 ${canonicalRoot}。旧数据不会自动合并或删除，请手动迁移。`;
    }

    result = {
      root: canonicalRoot,
      workspace,
      canonicalWorkspace: gitInfo.mainWorktree,
      mode: "canonicalized",
      rootWarning,
    };
  }

  if (ttlMs > 0) {
    canonicalRootCache.set(cacheKey, {
      value: result,
      timestamp: Date.now(),
      gitMtimeMs: getGitMtime(workspace),
    });
  }

  return result;
}
