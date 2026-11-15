/**
 * dsh-cli 只读诊断（g-314 判据 6）：只报告事实，**不写任何文件**。
 *
 * 复用约束（判据 3）：project.yaml 走 `readProjectConfig`、事件流走 `readEvents`、
 * 目标文件走 `listGoalFiles` / `loadGoal` / `findGoalFile`、frontmatter 与状态机全部来自 core。
 * 本模块**零写操作**：不 init、不 appendEvent、不建目录、不获取锁 —— 因此不存在
 * 「读命令残留副作用」的风险；也不绕过任何 CAS（本模块根本不写）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findGoalFile,
  listGoalFiles,
  loadGoal,
  readProjectConfig,
  readRulesVersion,
  type ProjectConfig,
} from "../ops.ts";
import { readEvents, type GraphEvent } from "../events.ts";
import type { GoalDoc } from "../domain/model.ts";
import { collectHealth, probeFile, type FileProbe, type HealthReport } from "./health.ts";

// 轻量探针与类型由 health.ts 单点定义（info 走轻量模块图，status 复用同一实现）。
export { collectHealth, probeFile };
export type { FileProbe, HealthReport };

export interface StatusReport extends HealthReport {
  /** 目标文件数量（非归档）。 */
  goalCount: number;
  /** 含归档的目标文件数量。 */
  goalCountWithArchived: number;
  /** 事件条数。 */
  eventCount: number;
  /** 最近一条事件的 event 名。 */
  lastEvent: string | null;
  /** 最近一条事件时间。 */
  lastEventTs: string | null;
  /** 规则库版本。 */
  rulesVersion: string | null;
  /** project.yaml 是否可解析（损坏配置报 false）。 */
  projectConfigOk: boolean;
  /** 损坏配置/事件流时的可读问题列表（空 = 无问题）。 */
  problems: string[];
}

/**
 * 从 core 的 `ProjectConfig` 上读出**畸形标志**（`*_malformed` / `malformed`）。
 *
 * core 把「字段存在但不可解析」表达为标志位（fail-closed 信号源），而不是抛错；
 * CLI 只需如实转述，不重实现任何判定。返回可读问题列表（空 = 配置良好）。
 */
function collectConfigMalformed(cfg: ProjectConfig): string[] {
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

/** 汇总状态：健康信息 + 目标数 + 事件数 + 规则库版本 + 损坏配置可见性。 */
export function collectStatus(params: {
  root: string;
  workspace: string;
  mode: string;
}): StatusReport {
  const health = collectHealth(params);
  const { root } = params;
  const problems: string[] = [];

  let goalCount = 0;
  let goalCountWithArchived = 0;
  try {
    goalCount = listGoalFiles(root).length;
  } catch (e) {
    problems.push(`无法枚举目标文件：${(e as Error).message}`);
  }
  try {
    goalCountWithArchived = listGoalFiles(root, { includeArchived: true }).length;
  } catch (e) {
    problems.push(`无法枚举归档目标文件：${(e as Error).message}`);
  }

  // 事件流：**条数 + 最近事件**可经「按行切分 + 只解析末行」得到（18404 行实测 ≈38ms，
  // 全量逐行 JSON 解析 ≈72ms）。但**损坏检出**不能因此变弱：一旦快路径发现任何结构可疑
  // （末行不可解析 / 缺 event·actor），立即回退到 core 的 `readEvents` 做**全量**校验并报错
  // —— 事件流语义仍只有 core 一份实现，本模块只做「省一次全量解析」的快速路径。
  let eventCount = 0;
  let lastEvent: string | null = null;
  let lastEventTs: string | null = null;
  const fast = summarizeEventsFast(root);
  if (fast.ok) {
    eventCount = fast.count;
    lastEvent = fast.lastEvent;
    lastEventTs = fast.lastTs;
  } else {
    try {
      const events: GraphEvent[] = readEvents(root);
      eventCount = events.length;
      const last = events[events.length - 1];
      lastEvent = last?.event ?? null;
      lastEventTs = last?.ts ?? null;
    } catch (e) {
      problems.push(`事件流不可解析：${(e as Error).message}`);
    }
  }

  let rulesVersion: string | null = null;
  try {
    rulesVersion = readRulesVersion(root);
  } catch (e) {
    problems.push(`rules.md 不可读：${(e as Error).message}`);
  }

  let projectConfigOk = true;
  let projectConfigErrors: string[] = [];
  try {
    const cfg: ProjectConfig = readProjectConfig(root);
    // core 的畸形判定是 **fail-closed 标志**（不抛错）：整档 YAML 不可解析时会置位
    // `*_malformed`。判据 4 要求「损坏配置」可读且非零退出，故必须读这些标志，
    // 不能只 try/catch（实测：任何畸形 YAML 下 readProjectConfig 都不抛）。
    projectConfigErrors = collectConfigMalformed(cfg);
    if (projectConfigErrors.length > 0) projectConfigOk = false;
  } catch (e) {
    projectConfigOk = false;
    projectConfigErrors = [`project.yaml 解析异常：${(e as Error).message}`];
  }
  for (const msg of projectConfigErrors) problems.push(msg);
  // 文件级探针也会报告损坏（project.yaml 为空等），这里合并去重成问题列表。
  for (const f of health.files) {
    if (f.exists && !f.readable) {
      const msg = `关键文件不可读：${f.path}${f.error ? `（${f.error}）` : ""}`;
      if (!problems.some((p) => p.includes(f.path))) problems.push(msg);
    }
  }

  return {
    ...health,
    goalCount,
    goalCountWithArchived,
    eventCount,
    lastEvent,
    lastEventTs,
    rulesVersion,
    projectConfigOk,
    problems,
  };
}

/**
 * 事件流**摘要**：逐行切分并逐行校验（与 core `readEvents` 同口径的 JSON + `event`/`actor` 契约），
 * 但**不构建结果数组**、不触发缓存失效（实测 18404 行 ≈34ms，readEvents ≈68ms）。
 *
 * 损坏检出**不弱化**：任何一行不合法即返回 `ok:false`，由调用方交给 core 的 `readEvents`
 * 做权威的全量解析并给出**准确行号**的可读错误（事件流语义仍只有 core 一份实现）。
 * 这里只做「省掉对象数组与缓存失效」的快速路径，绝不把任何一行跳过。
 */
function summarizeEventsFast(root: string): {
  ok: boolean;
  count: number;
  lastEvent: string | null;
  lastTs: string | null;
} {
  const file = join(root, "events.jsonl");
  let text: string;
  try {
    if (!existsSync(file)) return { ok: true, count: 0, lastEvent: null, lastTs: null };
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, count: 0, lastEvent: null, lastTs: null };
  }
  const lines = text.split("\n");
  let count = 0;
  let last: Record<string, unknown> | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const rec = tryParseEventLine(line);
    if (rec === null) return { ok: false, count: 0, lastEvent: null, lastTs: null };
    count++;
    last = rec;
  }
  if (last === null) return { ok: true, count: 0, lastEvent: null, lastTs: null };
  return {
    ok: true,
    count,
    lastEvent: String(last.event),
    lastTs: typeof last.ts === "string" ? last.ts : null,
  };
}

/** 解析单行事件并按 core 的最小契约校验（event/actor 必在）；不合格返回 null。 */
function tryParseEventLine(line: string): Record<string, unknown> | null {
  try {
    const rec = JSON.parse(line);
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
    if (!rec.event || !rec.actor) return null;
    return rec as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 目标摘要（`goal list` 用）。 */
export interface GoalSummary {
  id: string;
  title: string;
  status: string;
  type: string;
  version: string | null;
  /** 相对 graph root 的文件路径。 */
  file: string;
}

function toSummary(doc: GoalDoc, file: string, root: string): GoalSummary {
  const meta = doc.meta ?? {};
  return {
    id: String(meta.id ?? ""),
    title: String(meta.title ?? ""),
    status: String(meta.status ?? ""),
    type: String(meta.type ?? ""),
    version: meta.version == null ? null : String(meta.version),
    file: file.startsWith(root) ? file.slice(root.length).replace(/^[/\\]/, "") : file,
  };
}

/** 列出目标（只读）；损坏的目标文件不致命，但会作为 problem 报出。 */
export function listGoals(params: { root: string; includeArchived?: boolean }): {
  goals: GoalSummary[];
  problems: string[];
} {
  const { root, includeArchived = false } = params;
  const goals: GoalSummary[] = [];
  const problems: string[] = [];
  for (const file of listGoalFiles(root, { includeArchived })) {
    try {
      goals.push(toSummary(loadGoal(file), file, root));
    } catch (e) {
      problems.push(`目标文件不可解析：${file}（${(e as Error).message}）`);
    }
  }
  return { goals, problems };
}

/** 读取单个目标（只读，经 core 的 findGoalFile/loadGoal）。 */
export function showGoal(params: { root: string; id: string }): {
  goal: GoalSummary & { body: string };
  problems: string[];
} {
  const file = findGoalFile(params.root, params.id);
  const doc = loadGoal(file);
  return {
    goal: { ...toSummary(doc, file, params.root), body: doc.body },
    problems: [],
  };
}
