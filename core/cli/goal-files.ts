/**
 * 目标文件的**只读枚举与读取**（g-630）：`dsh-graph status` 冷启动的轻量叶子模块。
 *
 * ## 为什么独立成模块
 * `ops.ts` 是 1.4 万行单体，`import("./ops.ts")` 会**急切**加载整张依赖图（实测冷启动 ≈69ms，
 * 其中 `worktree.ts` ≈38ms、`yaml` ≈18ms）；而 `status` 只需要「枚举目标文件 + 读 frontmatter +
 * 读 project.yaml 的畸形标志」这三件事。把这三件事下沉到本叶子模块后，`diagnostics.ts` 不必
 * 为一次只读汇总付整张 ops 图的代价（判据 1）。
 *
 * ## 真源纪律（不做第二套实现）
 * - `listGoalFiles` / `loadGoal`：**唯一实现就在本文件**，`ops.ts` 改为从本文件 re-export 并复用；
 *   语义、排序、归档布局判定与既有 `ops.ts` 版本逐条一致（既有单测继续覆盖同一条代码路径）。
 * - `readProjectConfig`：语义仍以 `ops.ts` 为真源 —— 本模块**不重实现** YAML 解析，而是
 *   动态 `import("./ops.ts")` 后转调它。只有在「调用方明确只要畸形标志」时才会触发
 *   这份开销（见 `readProjectConfigHealth`）。
 * - 事件流：不在本模块（见 `events-index.ts`，权威实现仍是 core `readEvents`）。
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseDoc, type GoalDoc } from "../domain/model.ts";
import { GraphError } from "../machine.ts";

/**
 * 拒绝经由 symlink 读写目标文件（与 `ops.ts` 的 `assertNoSymlinkPath` 同一语义）。
 * 读路径上任何非 `GraphError` 的异常（如文件已消失导致的 realpath 失败）一律放过 ——
 * 与既有实现一致：真正的读错误会在随后的 `readFileSync` 上以可读形态暴露。
 */
export function assertNoSymlinkPath(file: string, forWrite = false): void {
  try {
    const resolved = resolve(file);
    const actual = realpathSync(forWrite && !existsSync(resolved) ? dirname(resolved) : resolved);
    const expected = forWrite && !existsSync(resolved) ? dirname(resolved) : resolved;
    if (actual !== expected) throw new GraphError("拒绝访问 symlink 路径");
  } catch (e) {
    if (e instanceof GraphError) throw e;
  }
}

/** 归档路径判定（`/archived/` 段）。 */
function isArchivedFile(file: string): boolean {
  return file.includes("/archived/") || file.includes("\\archived\\");
}

/**
 * 扫描图根下全部目标文件：backlog/*.md、backlog/<id>/goal.md、
 * goals/<id>/goal.md、versions/<v>/goals/<id>/goal.md。
 * opts.includeArchived=true 时也扫描 archived 目录下的目标。返回按路径排序的列表。
 */
export function listGoalFiles(root: string, opts?: { includeArchived?: boolean }): string[] {
  const out: string[] = [];
  const includeArchived = opts?.includeArchived ?? false;
  const backlog = join(root, "backlog");
  if (existsSync(backlog)) {
    for (const f of readdirSync(backlog)) {
      if (f === "archived") {
        if (includeArchived) {
          const backlogArchived = join(backlog, "archived");
          for (const af of readdirSync(backlogArchived)) {
            if (af.endsWith(".md")) out.push(join(backlogArchived, af));
            const nested = join(backlogArchived, af, "goal.md");
            if (existsSync(nested)) out.push(nested);
          }
        }
        continue;
      }
      // 扁平 backlog/<id>.md
      if (f.endsWith(".md")) {
        const fp = join(backlog, f);
        if (!includeArchived && isArchivedFile(fp)) continue;
        out.push(fp);
        continue;
      }
      // 目录形态 backlog/<id>/goal.md（暂缓后迁移落点）
      const nested = join(backlog, f, "goal.md");
      if (existsSync(nested)) out.push(nested);
    }
  }
  const goals = join(root, "goals");
  if (existsSync(goals)) {
    for (const d of readdirSync(goals)) {
      if (d === "archived") {
        if (includeArchived) {
          const archivedDir = join(goals, "archived");
          for (const ad of readdirSync(archivedDir)) {
            const p = join(archivedDir, ad, "goal.md");
            if (existsSync(p)) out.push(p);
          }
        }
        continue;
      }
      const p = join(goals, d, "goal.md");
      if (existsSync(p)) out.push(p);
    }
  }
  const versions = join(root, "versions");
  if (existsSync(versions)) {
    for (const v of readdirSync(versions)) {
      const gdir = join(versions, v, "goals");
      if (existsSync(gdir)) {
        for (const d of readdirSync(gdir)) {
          const p = join(gdir, d, "goal.md");
          if (existsSync(p)) out.push(p);
        }
      }
      // versions/vX/archived/ 目录
      if (includeArchived) {
        const archivedDir = join(versions, v, "archived");
        if (existsSync(archivedDir)) {
          for (const d of readdirSync(archivedDir)) {
            const p = join(archivedDir, d, "goal.md");
            if (existsSync(p)) out.push(p);
          }
        }
      }
    }
  }
  return out.sort();
}

/** 读取单个目标文件（symlink 拒收 + frontmatter 解析，与 ops 同语义）。 */
export function loadGoal(file: string): GoalDoc {
  assertNoSymlinkPath(file);
  return parseDoc(readFileSync(file, "utf8"));
}

/** 按 id 定位目标文件（先非归档、再归档；解析失败的条目跳过，与 ops 同语义）。 */
export function findGoalFile(root: string, id: string): string {
  for (const f of listGoalFiles(root)) {
    try {
      if (loadGoal(f).meta.id === id) return f;
    } catch {
      // 解析失败的文件由 validate 报告，这里跳过
    }
  }
  for (const f of listGoalFiles(root, { includeArchived: true })) {
    try {
      if (loadGoal(f).meta.id === id) return f;
    } catch {
      // 同上
    }
  }
  throw new GraphError(`目标不存在：${id}`);
}

/**
 * 读取 rules.md 的版本号（frontmatter `version`；非 JSON frontmatter 退化为行扫描。
 * 与 `ops.ts` 的 `readRulesVersion` 逐字同语义 —— 两处都需要它，故实现只留这一份，
 * `ops.ts` 转调本函数）。
 */
export function readRulesVersion(root: string): string | null {
  const file = join(root, "rules.md");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  try {
    const meta = parseDoc(text).meta;
    if (typeof meta.version === "string") return meta.version;
  } catch {
    // 非 JSON frontmatter：退化为行扫描
  }
  const m = text.match(/^version:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

/**
 * project.yaml 的**畸形标志**（只读、只取标志，不返回整档投影）。
 *
 * 真源仍是 `ops.ts` 的 `readProjectConfig`（含完整 YAML 解析与其 fail-closed 标志位）——
 * 本函数**不重实现**任何解析，只做「调用 + 转录标志」。ops 图与 yaml 的加载成本因此
 * 只落在**真正需要判定 project.yaml 的调用方**身上（`status`；`goal list` / `goal show` 不付）。
 */
export async function readProjectConfigHealth(root: string): Promise<{
  ok: boolean;
  errors: string[];
}> {
  const { readProjectConfig } = await import("../ops.ts");
  try {
    const cfg = readProjectConfig(root);
    const errors = collectConfigMalformed(cfg as unknown as Record<string, unknown>);
    return { ok: errors.length === 0, errors };
  } catch (e) {
    return { ok: false, errors: [`project.yaml 解析异常：${(e as Error).message}`] };
  }
}

/**
 * 从 core 的 `ProjectConfig` 上读出**畸形标志**（`*_malformed` / `malformed`）。
 *
 * core 把「字段存在但不可解析」表达为标志位（fail-closed 信号源），而不是抛错；
 * 这里只如实转述，不重实现任何判定。返回可读问题列表（空 = 配置良好）。
 */
export function collectConfigMalformed(cfg: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > 4 || value === null || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      if (k.endsWith("_malformed") || k === "malformed") {
        if (v === true) out.push(`project.yaml 字段不可解析（畸形）：${here.replace(/\.?_?malformed$/, "") || "(整档)"}`);
        continue;
      }
      walk(v, here, depth + 1);
    }
  };
  walk(cfg, "", 0);
  return out;
}
