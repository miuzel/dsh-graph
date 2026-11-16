/**
 * g-623 共用测试夹具：私有隔离工作区 + 整个 graph 树的**内容快照**（零副作用断言的基础）。
 *
 * 为什么需要「整树快照」：安全负向矩阵的每一项都要求比较**拒绝前后**的
 * 目录、文件、事件、锁、配置与初始化状态 —— 只看响应码无法证明「零持久副作用」。
 * 快照按相对路径记录 `type + mode + sha256(content) + mtimeMs`，任何新增目录、新增事件、
 * 被改写的文件、被 chmod 的凭据都会体现为差异。
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, lstatSync, rmSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import http from "node:http";
import { init, createGoal, setCriteria, setGoalDescription, addCard, storeAttachment, writeAttemptResults, startAttempt, transition } from "../../ops.ts";

export interface TreeEntry {
  type: "file" | "dir" | "symlink";
  mode?: number;
  size?: number;
  hash?: string;
  mtimeMs?: number;
}

/** 递归快照一个目录（不存在时返回空映射）。 */
export function snapshotTree(root: string, opts: { withMtime?: boolean } = {}): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      const rel = relative(root, abs) || ".";
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        let target = "";
        try { target = readFileSync(abs, "utf8"); } catch { target = ""; }
        out.set(rel, { type: "symlink", size: target.length, hash: createHash("sha256").update(target).digest("hex") });
        continue;
      }
      if (st.isDirectory()) {
        out.set(rel, { type: "dir", mode: st.mode & 0o777, mtimeMs: opts.withMtime ? st.mtimeMs : undefined });
        walk(abs);
        continue;
      }
      const buf = readFileSync(abs);
      out.set(rel, {
        type: "file",
        mode: st.mode & 0o777,
        size: buf.length,
        hash: createHash("sha256").update(buf).digest("hex"),
        mtimeMs: opts.withMtime ? st.mtimeMs : undefined,
      });
    }
  };
  walk(root);
  return out;
}

/** 两份快照的差异（人类可读；空数组 = 完全一致）。 */
export function diffTrees(before: Map<string, TreeEntry>, after: Map<string, TreeEntry>): string[] {
  const diffs: string[] = [];
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of [...keys].sort()) {
    const a = before.get(key);
    const b = after.get(key);
    if (!a) { diffs.push(`新增：${key}`); continue; }
    if (!b) { diffs.push(`删除：${key}`); continue; }
    if (a.type !== b.type) { diffs.push(`类型变化：${key} ${a.type}→${b.type}`); continue; }
    if (a.hash !== b.hash) diffs.push(`内容变化：${key}`);
    if (a.mode !== undefined && b.mode !== undefined && a.mode !== b.mode) diffs.push(`权限变化：${key} ${(a.mode).toString(8)}→${(b.mode).toString(8)}`);
    if (a.size !== undefined && b.size !== undefined && a.size !== b.size) diffs.push(`大小变化：${key}`);
  }
  return diffs;
}

/** 一个隔离的私有工作区：`tmp/g623-<随机>/` 下的 home / state / graph / workspace / 外站 sentinel。 */
export interface PrivateWorkspace {
  base: string;
  home: string;
  stateDir: string;
  graphRoot: string;
  executionWorkspace: string;
  outsideSentinel: string;
  cleanup(): void;
}

export function makePrivateWorkspace(tag: string): PrivateWorkspace {
  const base = mkdtempSync(join(process.cwd(), "tmp", `g623-${tag}-`));
  const home = join(base, "home");
  const stateDir = join(base, "state", "dsh-graph-service");
  const graphRoot = join(base, "graph", ".dsh-graph");
  const executionWorkspace = join(base, "workspace");
  const outsideSentinel = join(base, "outside", "secret.txt");
  for (const d of [home, join(base, "graph"), executionWorkspace, join(base, "outside")]) mkdirSync(d, { recursive: true });
  writeFileSync(outsideSentinel, "OUTSIDE-SENTINEL-CONTENT\n", "utf8");
  return {
    base,
    home,
    stateDir,
    graphRoot,
    executionWorkspace,
    outsideSentinel,
    cleanup() {
      try { chmodSync(base, 0o755); } catch { /* ignore */ }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/** 便捷：把某目录权限收紧/放宽（负向「权限过宽」用）。 */
export function chmodPath(p: string, mode: number): void {
  chmodSync(p, mode);
}

/** 便捷：在给定父目录创建一个指向 target 的 symlink。 */
export function makeSymlink(linkPath: string, target: string): void {
  symlinkSync(target, linkPath);
}

/** 是否存在某个目录（导出以便断言「没有自动创建」）。 */
export function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 一段不带任何 HTTP 框架依赖的最小请求器（原始 http.request，便于伪造 Host/头）。 */
export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: any;
}

export function rawRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** 覆盖实际连接目标（默认 127.0.0.1；用于伪造 peer 之外的场景）。 */
  host?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: opts.host ?? "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
        setHost: false,
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try { json = body ? JSON.parse(body) : null; } catch { json = null; }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("request timeout")); });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** 预先构造一个绑定到 127.0.0.1 的占用端口（端口占用负向用）。 */
export async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end("occupied"); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    release: () => new Promise<void>((resolve) => { server.close(() => resolve()); (server as any).closeAllConnections?.(); }),
  };
}

/** 夹具看板的内容（用 core **写**入口准备数据：夹具只准备前置条件，被测的是服务只读路径）。 */
export interface FixtureBoard {
  root: string;
  goalId: string;
  versionSlug: string;
  attachmentName: string;
  attemptId: string;
}

/**
 * 在 `root` 下用 core 公开写入口准备一个**已初始化**的看板：
 * 版本 v1.0.0 + 一个 version 内目标（含判据/描述）+ 一个 backlog 目标 + 卡片 + 附件 + attempt 结果。
 */
export function seedFixtureBoard(root: string): FixtureBoard {
  mkdirSync(root, { recursive: true });
  init(root);
  const versionSlug = "v1.0.0";
  mkdirSync(join(root, "versions", versionSlug, "goals"), { recursive: true });
  writeFileSync(
    join(root, "versions", versionSlug, "version.md"),
    `---\n${JSON.stringify({ id: versionSlug, name: "1.0.0", status: "planning" }, null, 2)}\n---\n\n# 1.0.0\n`,
    "utf8",
  );
  const goalId = createGoal(root, { title: "夹具目标", version: versionSlug, type: "feature", actor: "human:test" });
  setCriteria(root, goalId, ["判据一：只读查询可用", "判据二：安全边界生效"], "human:test");
  setGoalDescription(root, goalId, "夹具目标描述：用于验证只读查询与安全边界。", "human:test");
  createGoal(root, { title: "backlog 目标", type: "task", actor: "human:test" });
  addCard(root, goalId, { title: "夹具卡片", scope: "goal", actor: "human:test" });
  const attachmentName = storeAttachment(root, { name: "evidence/note.txt", content: "attachment-body\n", actor: "human:test" });
  const attempt = startAttempt(root, goalId, { executor: "test", actor: "agent:test" } as any);
  const attemptId = String((attempt as any).attempt ?? (attempt as any).attemptId ?? "att-001");
  const written = writeAttemptResults(root, {
    goal: goalId,
    attempt: attemptId,
    text: "夹具完成摘要：只读服务验证用。",
    source: "manual",
    actor: "human:test",
  } as any);
  if (!written.written) {
    // 占位写入器要求 goal 目录形态；失败时退回手工写入 results-att 文件（仍只是夹具数据）。
    const dir = join(root, "versions", versionSlug, "goals", goalId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `results-${attemptId}.md`), `---\n${JSON.stringify({ attempt: attemptId, source: "manual" }, null, 2)}\n---\n\n夹具完成摘要：只读服务验证用。\n`, "utf8");
  }
  return { root, goalId, versionSlug, attachmentName, attemptId };
}
