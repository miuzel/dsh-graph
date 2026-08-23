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
import { existsSync, readFileSync } from "node:fs";

export function resolveRoot(
  config?: { root?: string } | null,
  workspaceRoot: string = process.cwd(),
): string {
  return resolve(workspaceRoot, config?.root ?? ".dsh-graph");
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

/**
 * Discover Git worktree metadata for a workspace directory.
 * Uses `git worktree list --porcelain` whose first entry is always the main worktree.
 * Returns null if the workspace is not inside a Git repo, git is unavailable,
 * or the command fails for any reason (safe fallback).
 */
export function discoverGitWorktree(
  workspaceRoot: string,
): GitWorktreeInfo | null {
  try {
    // First, verify this is a Git repo (any kind — main or linked worktree)
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: workspaceRoot,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null; // not a git repo or git unavailable
  }

  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: workspaceRoot,
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse the first worktree entry (always the main worktree)
    const lines = output.split("\n");
    let mainPath: string | null = null;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        mainPath = line.slice("worktree ".length).trim();
        break;
      }
    }
    if (!mainPath) return null;

    // Resolve the workspace to an absolute canonical path for comparison
    const resolvedWorkspace = resolve(workspaceRoot);
    const isLinked = resolvedWorkspace !== resolve(mainPath);

    return {
      mainWorktree: resolve(mainPath),
      workspace: resolvedWorkspace,
      isLinkedWorktree: isLinked,
    };
  } catch {
    return null; // git worktree command failed
  }
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
 * Canonical graph root resolver (g-149).
 *
 * Wraps `resolveRoot` with Git linked-worktree detection:
 * - Explicit absolute `config.root`: returns as-is, no Git discovery.
 * - Relative config.root (default `.dsh-graph`): if workspace is a Git linked worktree,
 *   canonicalizes to `<main-worktree>/<config.root>`. If discovery fails, falls back to
 *   normal `resolveRoot` with mode "workspace-fallback".
 * - Detects legacy worktree-local `.dsh-graph` directories and attaches warnings.
 *
 * The `init` function is NOT called here — callers decide whether/where to init.
 */
export function resolveCanonicalRoot(
  config?: { root?: string } | null,
  workspaceRoot: string = process.cwd(),
): CanonicalRootResult {
  const rawRoot = config?.root;
  const workspace = resolve(workspaceRoot);

  // Case 1: explicit absolute config.root — bypass Git discovery entirely
  if (rawRoot && isAbsolute(rawRoot)) {
    return {
      root: resolve(rawRoot),
      workspace,
      canonicalWorkspace: workspace,
      mode: "absolute-config",
    };
  }

  // Case 2: relative config.root (including default ".dsh-graph")
  const relRoot = rawRoot ?? ".dsh-graph";
  const localRoot = resolve(workspace, relRoot);

  // Attempt Git discovery
  const gitInfo = discoverGitWorktree(workspace);

  if (!gitInfo) {
    // Not a Git repo or git unavailable — workspace-local fallback
    return {
      root: localRoot,
      workspace,
      canonicalWorkspace: workspace,
      mode: "workspace-fallback",
    };
  }

  // If workspace IS the main worktree, normal resolution
  if (!gitInfo.isLinkedWorktree) {
    return {
      root: localRoot,
      workspace,
      canonicalWorkspace: workspace,
      mode: "main-tree",
    };
  }

  // Linked worktree — canonicalize to main worktree
  const canonicalRoot = resolve(gitInfo.mainWorktree, relRoot);
  let rootWarning: string | undefined;

  // Detect legacy worktree-local graph data
  if (existsSync(localRoot) && existsSync(resolve(localRoot, "events.jsonl"))) {
    rootWarning = `发现 worktree 本地旧看板 ${localRoot}；canonical graph root 为 ${canonicalRoot}。旧数据不会自动合并或删除，请手动迁移。`;
  }

  return {
    root: canonicalRoot,
    workspace,
    canonicalWorkspace: gitInfo.mainWorktree,
    mode: "canonicalized",
    rootWarning,
  };
}
