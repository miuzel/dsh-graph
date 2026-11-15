/**
 * dsh-cli 环境自检的**轻量**实现（g-314 判据 6）：只读、零写、零重依赖。
 *
 * 为什么单独成文件（冷启动判据 2）：`info` 只需要「文件存在性 + 可读性」，
 * 而 `diagnostics.ts` 为汇总状态必须引入 `core/ops.ts` ⇒ 连带 `yaml`（实测约 40ms）
 * 与整条 ops 加载图（约 65ms）。把探针放在这里，`info` 的模块图就只有 node 内置 +
 * `core/root.ts`，从而在大看板上也稳定低于 100ms。
 *
 * 语义边界（不重复实现 core 的一切）：
 * - 这里**只**做文件级可读性判定与 JSON 语法校验，不解释任何看板语义；
 * - project.yaml 的**结构性畸形判定**仍由 core 的 `readProjectConfig` 的 `*_malformed` 标志给出，
 *   在 `diagnostics.collectStatus` 中完成（`info` 只报「可读/不可读」，不冒充语义校验结论）。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** 关键文件的可读性结论。 */
export interface FileProbe {
  /** 相对 graph root 的路径。 */
  path: string;
  exists: boolean;
  readable: boolean;
  /** 读失败/校验失败原因（可读）。 */
  error?: string;
}

export interface HealthReport {
  nodeVersion: string;
  /** graph root（绝对路径）。 */
  root: string;
  /** 用于 root 解析的 workspace。 */
  workspace: string;
  /** root 解析模式（core 口径）。 */
  mode: string;
  /** 是否已初始化：以 `events.jsonl` 存在为标志（与 core `init()` 的 fresh 判定同口径）。 */
  initialized: boolean;
  files: FileProbe[];
}

/**
 * 逐个探针：存在性 → 目录判定 → 读取 → 可选语法校验。任何异常都转成可读结论。
 * `validate` 省略时**只做 stat 级检查**（存在 + 不是目录 + 可读权限位），不读全文。
 */
function readOneByte(abs: string): void {
  const fd = openSync(abs, "r");
  try {
    readSync(fd, Buffer.alloc(1), 0, 1, 0);
  } finally {
    closeSync(fd);
  }
}

export function probeFile(root: string, rel: string, validate?: (text: string) => void): FileProbe {
  const abs = join(root, rel);
  if (!existsSync(abs)) return { path: rel, exists: false, readable: false };
  try {
    const st = statSync(abs);
    if (st.isDirectory()) {
      return { path: rel, exists: true, readable: false, error: "是个目录，不是文件" };
    }
    // 无校验器 ⇒ 只需「可读」：走权限位判定，避免为大文件（如 events.jsonl）白读全文。
    if (!validate) {
      if (typeof process.getuid === "function" && process.getuid() === 0) return { path: rel, exists: true, readable: true };
      const mode = st.mode & 0o444;
      if (mode === 0) return { path: rel, exists: true, readable: false, error: "文件不可读（权限位 0）" };
      // 权限位允许读，但当前用户可能不是属主：做一次最小读取确认（只读 1 字节）。
      readOneByte(abs);
      return { path: rel, exists: true, readable: true };
    }
    const text = readFileSync(abs, "utf8");
    if (validate) validate(text);
    return { path: rel, exists: true, readable: true };
  } catch (e) {
    return { path: rel, exists: true, readable: false, error: (e as Error).message };
  }
}

/**
 * 环境自检：Node 版本 + graph root + 初始化状态 + 关键文件可读性。
 * 只读；不抛错（每个文件的可读性结论都落在 `files[]` 里）。
 */
export function collectHealth(params: {
  root: string;
  workspace: string;
  mode: string;
}): HealthReport {
  const { root, workspace, mode } = params;
  const files: FileProbe[] = [
    // project.yaml：只做「文件可读 + 非空」探针；**YAML 结构性畸形**由 collectStatus 里的
    // readProjectConfig 标志单次判定（这里再调一次会重复解析，白付一份 yaml 解析成本）。
    probeFile(root, "project.yaml", (text) => {
      if (text.trim() === "") throw new Error("project.yaml 为空文件");
    }),
    // events.jsonl：**可读性**探针只做文件级检查；逐行 JSON 语义校验由 collectStatus 的
    // `readEvents` 单次完成（大看板上全量解析 18404 行 ≈ 70ms，不该由 info 白付）。
    probeFile(root, "events.jsonl"),
    probeFile(root, "index.json", (text) => {
      JSON.parse(text);
    }),
    probeFile(root, "rules.md"),
  ];
  return {
    nodeVersion: process.version,
    root,
    workspace,
    mode,
    initialized: existsSync(join(root, "events.jsonl")),
    files,
  };
}
