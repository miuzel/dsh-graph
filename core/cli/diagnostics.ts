/**
 * dsh-graph 只读诊断（g-314 判据 6）：只报告事实，**不写看板**。
 *
 * 复用约束（判据 3）：project.yaml 走 `readProjectConfig`、事件流走 core `readEvents`（经
 * `events-index.ts` 的增量索引快路径，未命中即回退 `readEvents` 全量校验）、
 * 目标文件走 `listGoalFiles` / `loadGoal` / `findGoalFile`、frontmatter 与状态机全部来自 core。
 *
 * 写入面（g-630，如实声明）：本模块**不写 `.dsh-graph`** —— 不 init、不 appendEvent、不建看板目录、
 * 不获取任何锁、不绕过任何 CAS。唯一新增的写入是**用户缓存目录**下的**纯缓存**索引
 * （`$XDG_CACHE_HOME/dsh-graph`，见 `events-index.ts`）：它可随时删除，只影响下次是否走快路径，
 * 不影响任何判定结果。
 */
// g-630：目标文件枚举/读取、rules.md 版本取自**轻量叶子模块**（唯一实现，ops 转调同一份），
// 不再为只读汇总急切加载 1.4 万行的 ops 单体（实测可省 ≈69ms 冷启动）。
import { findGoalFile, listGoalFiles, loadGoal, readRulesVersion, readProjectConfigHealth } from "./goal-files.ts";
import type { GoalDoc } from "../domain/model.ts";
import { collectHealth, probeFile, type FileProbe, type HealthReport } from "./health.ts";
// g-630：事件流摘要改走增量索引（截断/改写/替换/索引异常一律 fail-safe 回退 core 全量校验）。
import { readEventsSummary } from "./events-index.ts";

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
  /** 损坏配置/事件流时的可读问题列表（空 = 无问题）。非空 ⇒ status 非零退出。 */
  problems: string[];
  /**
   * 告警级说明（g-630）：如「事件索引失效，已退回全量校验」。**不**让 status 非零退出
   * —— 索引是纯缓存，失效不等于看板损坏；但必须如实显示，不得静默。
   */
  notices: string[];
}

/**
 * 汇总状态：健康信息 + 目标数 + 事件数 + 规则库版本 + 损坏配置可见性。
 *
 * **async**（g-630）：project.yaml 的畸形标志仍以 `ops.readProjectConfig` 为唯一真源，但改为
 * **按需加载** —— 否则只为一次只读汇总就急切加载 1.4 万行 ops 单体（实测 ≈69ms 冷启动），
 * 与判据 1 的 <100ms 直接冲突。事件计数不再因此回退：它走 `events-index.ts` 的 O(1) 索引。
 */
export async function collectStatus(params: {
  root: string;
  workspace: string;
  mode: string;
}): Promise<StatusReport> {
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

  // 事件流（g-630）：条数 + 最近事件改走 `events-index.ts` 的**增量索引 + O(1) 字节探测**
  // （不再整档 readFileSync + 逐行 JSON.parse，那在 18404 事件上实测 ≈36ms 且线性增长）。
  // 索引只存事件流派生物，未变/纯追加才给数；截断、就地改写、被替换、索引缺失/损坏/版本不匹配
  // 一律 fail-safe 回退到 core `readEvents` 做**全量校验**并给出**可读告警**（判据 3），
  // 语义仍只有 core 一份实现（判据 5）。
  const eventsSummary = readEventsSummary(root);
  const eventCount = eventsSummary.eventCount;
  const lastEvent = eventsSummary.lastEvent;
  const lastEventTs = eventsSummary.lastEventTs;
  for (const msg of eventsSummary.problems) problems.push(msg);
  const notices: string[] = [...eventsSummary.notices];

  let rulesVersion: string | null = null;
  try {
    rulesVersion = readRulesVersion(root);
  } catch (e) {
    problems.push(`rules.md 不可读：${(e as Error).message}`);
  }

  // project.yaml：语义仍以 ops 的 `readProjectConfig` 为真源（不重实现 YAML 解析）；只有这里
  // 才需要它 ⇒ 走懒加载，`goal list`/`goal show` 不为它付整张 ops 图与 yaml 的成本。
  const cfgHealth = await readProjectConfigHealth(root);
  if (!cfgHealth.ok) problems.push(...cfgHealth.errors);
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
    projectConfigOk: cfgHealth.ok,
    problems,
    notices,
  };
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
