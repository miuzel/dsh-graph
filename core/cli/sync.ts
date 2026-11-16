/**
 * dsh-graph sync（g-315）：把 `.dsh-graph` 的**只读投影**写入 `.claude/CLAUDE.md` 与 `AGENTS.md`
 * 的受控标记区段，供 Claude Code / Codex 等单兵 CLI 工具作稳定前缀（Prompt Cache 命中）。
 *
 * 严格分层（判据 2）：
 * - **A 段 = 稳定前缀**：`standing` 常驻记忆（硬性事实与不可违背约束）。A 段**内部不含任何
 *   由动态数据派生的计数/时间/绝对路径**——若写「共 N 条」，增删一条滚动记忆就会让整段前缀失效，
 *   恰好抵消本目标的价值。跨次运行只要记忆集合不变，A 段字节恒定，且**永远位于**动态段之前。
 * - **B 段 = 动态概览**：版本与目标状态。它**可以**含计数，因为它本就在尾部；动态数据变化时
 *   **只有 B 段**的字节变化，前缀（及其缓存）不受影响。
 *
 * 输出是输入的**纯函数**：刻意不写生成时间 — 这两个文档是要入库的，时间戳会让每次 sync 都「有变更」
 * （提交噪音 + 判据 5 的「无变更不写」形同虚设）。
 *
 * 复用（判据 3）：记忆经 core `recallMemory`（= `readMemory` + `replayMemory` 的公开入口，与
 * `formatStandingMemorySection` 注入宿主时是**同一份**过滤逻辑）、来源权威判定经 core
 * `isHumanActor`、rag 版本/目标枚举经 core `boardProjection`（版本元信息与目标由它一处给出，
 * 本模块**不**再解析任何 frontmatter/YAML/JSONL）。
 *
 * 写入（判据 4/5/6）：
 * - **唯一写法是 `renderDocument(existing, block)` 的「前缀 + 受控区段 + 后缀」拼接**：区段外
 *   字节级沿用原文，**不重排、不重写行尾、不 trim**；无标记时按文档化规则（`APPEND_RULE`）追加，
 *   绝无整文件覆盖路径；
 * - 全部渲染与可写性预检都在**任何写操作之前**完成（规划 → 落地两段）⇒ 任一输入失败即整体失败、
 *   前序文件一个字节都不写；
 * - 无变更不写（内容逐字节比较）⇒ mtime 不变；
 * - 有变更走 core 的 `atomicWrite`（同目录临时文件 + fsync + rename）⇒ 失败不留半文件。
 */
import { accessSync, constants, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWrite, boardProjection, isHumanActor, readMemory, recallMemory, type BoardGoal } from "../ops.ts";
// 目标文件**可解析性预检**复用既有诊断入口（`listGoals` = `listGoalFiles` 枚举 + core `loadGoal` 解析），
// 本模块因此**不手写任何 frontmatter 解析**（判据 3）；与 `goal list` 的报错口径同源。
import { listGoals } from "./diagnostics.ts";
// 写入位置（workspace 解析）同样复用 core：`discoverGitWorktree` 给出 worktree 根与主树根，
// 本模块不自己实现任何 git 探查。
import { DEFAULT_GRAPH_DIR_NAME, discoverGitWorktree, isScratchWorkspace } from "../root.ts";

// ---------------------------------------------------------------------------
// 常量与文档化规则
// ---------------------------------------------------------------------------

/** sync 的输出文档（写入**发起调用的 workspace 根**，见 `resolveWorkspaceForSync`）。 */
export const SYNC_TARGETS = [".claude/CLAUDE.md", "AGENTS.md"] as const;
export type SyncTarget = (typeof SYNC_TARGETS)[number];

/** 受控区段标记（逐字；改它等于让既有区段失去归属 ⇒ 旧区段会被当作手写内容保留下来）。 */
export const SYNC_MARKERS = {
  begin: "<!-- dsh-graph:sync:begin -->",
  end: "<!-- dsh-graph:sync:end -->",
} as const;

/**
 * 无标记时的**追加规则**（判据 4「按明确规则追加而非覆盖」）：追加到文件**末尾**，原有字节逐字
 * 保留在最前面 ⇒ 用户手写内容零损失。三处细节都是确定性行为：
 *
 * 1. 空文件 / 文件缺失 ⇒ 直接从区段开始，**不**补前导空行；
 * 2. 原文已以换行结尾 ⇒ 直接拼接区段；否则**先补一个换行**（避免标记黏在用户最后一行上）；
 * 3. 补行尾时沿用原文末行的风格（原文以 `\r\n` 结尾则补 `\r\n`），不混行尾。
 */
export const APPEND_RULE =
  "无标记时追加到文件末尾：原有字节逐字保留；原文不以换行结尾时先补一个与原文行尾风格一致的换行；文件缺失/为空时直接从区段开始。绝不覆盖原有内容。";

/**
 * B 段渲染口径上限：超出部分折叠成一行「其余 N 个目标」，并在输出里提示 `--full`。
 *
 * 为什么需要：本仓真实看板有 400+ 目标，全量内联会让动态段膨胀到几十 KiB，淹没前缀；而且
 * 任何目标状态变化都会改动动态段——体积越大，一次 diff 的 token 成本越高。折叠口径是**显式、
 * 确定性**的：先按状态顺序（in_progress → review → blocked → …），同状态按 id 字典序，取前 N 个。
 * `--full` 取消该上限。
 */
export const SYNC_MAX_GOALS = 40;

/** 状态枚举与顺序（与 core `STATUSES` 同源口径；此处只决定**展示顺序**，不做状态机判定）。 */
const STATUS_ORDER = ["in_progress", "review", "blocked", "ready", "collecting", "planning", "draft", "delivered"];

/** 可判定的失败（统一以非零退出 + 中文可读原因呈现；`code` 供测试稳定断言）。 */
export type SyncProblemCode =
  | "memory-corrupt"
  | "goal-unreadable"
  | "goal-file-corrupt"
  | "version-unreadable"
  | "event-log-corrupt"
  | "target-unwritable"
  | "target-unreadable"
  | "target-is-directory"
  | "marker-malformed"
  | "bad-option";

export class SyncError extends Error {
  readonly code: SyncProblemCode;
  constructor(code: SyncProblemCode, message: string) {
    super(message);
    this.name = "SyncError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 输入（只读 .dsh-graph）
// ---------------------------------------------------------------------------

/** 一条被投影的常驻记忆（渲染所需字段子集；正文已折叠成**一行**）。 */
export interface StandingFact {
  id: string;
  text: string;
  human: boolean;
  createdBy?: string;
  sourceGoal?: string;
}

export interface GoalFact {
  id: string;
  title: string;
  status: string;
  type: string;
}

export interface VersionFact {
  slug: string;
  name: string;
  status: string;
  goals: GoalFact[];
}

export interface SyncInputs {
  /** 常驻记忆（最终序按 id：见 `loadStanding`）。 */
  standing: StandingFact[];
  /** 未发布版本（`released` 属历史，不投影）。 */
  versions: VersionFact[];
  /** core 的 backlog 目标计数（lazy 投影给出；动态段只报计数不逐条列）。 */
  backlogCount: number;
  /** core 的独立（`goals/`）目标计数。 */
  standaloneCount: number;
  /** 载入过程的**可判定失败**（非空 ⇒ 整体失败、不写任何文件）。 */
  problems: SyncError[];
}

/** 空记忆 / 空看板都**不是**失败：渲染成带「（无）」说明的区段并退出 0（否则新仓库永远 sync 不成功）。 */
export function loadSyncInputs(root: string): SyncInputs {
  const problems: SyncError[] = [];
  // 目标可解析性预检须**先于**任何载入：`boardProjection` 对坏目标文件是 `catch { /* 坏目标文件跳过 */ }`
  // （core 有意如此，见 ops.ts / version-lane.ts），若只靠它，「一个合法目标 + 一个损坏目标」的看板会
  // **静默成功**且把坏目标从投影里丢掉 —— 而同样场景 `dsh-graph goal list` 报「目标文件不可解析」并非零退出。
  // sync 投影的是「当前在做什么」，静默少一个目标等于投影撒谎；故有坏目标即整体失败、零写入。
  const corruptGoals = goalParseProblems(root);
  problems.push(...corruptGoals);
  if (corruptGoals.length > 0) {
    return { standing: [], versions: [], backlogCount: 0, standaloneCount: 0, problems };
  }
  const standing = loadStanding(root, problems);
  const board = loadVersions(root, problems);
  return { standing, versions: board.versions, backlogCount: board.backlogCount, standaloneCount: board.standaloneCount, problems };
}

/**
 * 目标文件**可解析性预检**（只读，零写）。
 *
 * 复用 core 既有诊断入口 `listGoals`（= `listGoalFiles` 枚举 + `loadGoal` 解析），**不手写第二套
 * frontmatter 解析**；其 `problems` 文案与 `dsh-graph goal list` 完全同源（含 core `loadGoal` 给出的
 * 具体原因，如「frontmatter 不是合法 JSON」），因此两个命令对同一份损坏数据给出同一结论。
 *
 * 范围与 sync 的输入面严格对齐：`boardProjection`（版本内 / 独立 / backlog）与 `buildGoalIndex`
 * 都经 `listGoalFiles` 枚举，故这里用同一枚举（含归档）⇒ 不存在「预检看不到、投影却会读到」的文件。
 * 用 `includeArchived: true` 是为了与 `buildGoalIndex` 的面一致（它含归档对端），避免归档坏文件逃过预检。
 */
function goalParseProblems(root: string): SyncError[] {
  let problems: string[];
  try {
    problems = listGoals({ root, includeArchived: true }).problems;
  } catch (e) {
    return [new SyncError("goal-unreadable", `目标文件枚举失败：${(e as Error).message}`)];
  }
  if (problems.length === 0) return [];
  const head = problems.slice(0, 5).join("；");
  const more = problems.length > 5 ? `（另有 ${problems.length - 5} 处）` : "";
  return [
    new SyncError(
      "goal-file-corrupt",
      `发现 ${problems.length} 个无法解析的目标文件：${head}${more}。` +
        `core 的看板投影会静默跳过这些文件（目标会从投影里无声消失），故 sync 整体失败、不写任何文件；` +
        `请先修复上述文件（或用 dsh-graph goal list 复核）再 sync`,
    ),
  ];
}

/**
 * 常驻记忆：经 core `recallMemory({ scope: "standing" })`。
 *
 * 两个刻意取舍：
 * 1. **不过滤 kind**：`kind:"user"` 的记忆在 core 里按 owner 隔离（`graph_memory_add` 的 user 记忆
 *    只属于创建它的 actor）。CLI 无身份上下文，若照 host 路径（无 actor）过滤，用户亲手登记的
 *    user 常驻约束会被**静默**排除在前缀之外。sync 的输出写入的是**该工作区自己**的 AGENTS.md /
 *    CLAUDE.md（只有能读这个仓库的人能看到），故按「本工作区全部 standing 事实」投影；
 * 2. **坏行不静默跳过**：core 读取对损坏行容错跳过 —— 那会让一条硬性事实无声消失而 sync 仍报成功，
 *    正是判据 6 要求可判定失败的场景。故先做记录级预检，有坏行即整体失败。
 */
function loadStanding(root: string, problems: SyncError[]): StandingFact[] {
  const corrupt = memoryFileProblems(join(root, "memory", "memory.jsonl"));
  if (corrupt.length > 0) {
    const head = corrupt.slice(0, 3).join("；");
    const more = corrupt.length > 3 ? `（另有 ${corrupt.length - 3} 处）` : "";
    problems.push(
      new SyncError(
        "memory-corrupt",
        `memory/memory.jsonl 含 ${corrupt.length} 处无法解析的记录：${head}${more}。` +
          `损坏记录会被 core 静默跳过，导致硬性事实无声消失；请先修复该文件（或从备份恢复）再 sync`,
      ),
    );
    return [];
  }

  // 两条 core 公开入口，各取其所长（不复制过滤/重放逻辑）：
  // - `recallMemory({scope:"standing"})` = 宿主注入路径的**同一份**可见性口径（project 条目）；
  // - `readMemory()` = `readMemoryEvents` + `replayMemory` 的重放结果（唯一真源），
  //   用于补齐 `kind:"user"` 的 standing 条目 —— 见下方取舍说明。
  let projectMatches;
  let allEntries;
  try {
    projectMatches = recallMemory(root, { scope: "standing" }).matches;
    allEntries = readMemory(root);
  } catch (e) {
    problems.push(new SyncError("memory-corrupt", `常驻记忆不可读：${(e as Error).message}`));
    return [];
  }

  // 取舍（与 host 注入路径**有意不同**，README/docs 已记录）：`kind:"user"` 记忆按 owner 隔离，
  // 而 CLI 没有可信 actor ⇒ 若照 host 无身份路径过滤，用户亲手登记的常驻约束会被**静默**排除在
  // 前缀之外（实测：3 条 standing 只投影出 2 条）。sync 写的是**本工作区自己**的 AGENTS.md /
  // CLAUDE.md（只有能读这个仓库的人看得到），故按「本工作区全部 standing 事实」投影。
  const picked = new Map<string, (typeof allEntries)[number]>();
  for (const m of projectMatches) picked.set(m.id, m);
  for (const m of allEntries) {
    if (m.scope !== "standing") continue;
    if (picked.has(m.id)) continue;
    picked.set(m.id, m);
  }

  const facts: StandingFact[] = [];
  for (const m of picked.values()) {
    const text = collapseWhitespace(m.text);
    if (!text) {
      problems.push(new SyncError("memory-corrupt", `常驻记忆 ${m.id} 正文为空（无法投影，请用 graph_memory_remove 清理）`));
      continue;
    }
    facts.push({ id: m.id, text, human: isHumanActor(m.created_by), createdBy: m.created_by, sourceGoal: m.source_goal });
  }
  // 稳定序：core 的排序末级是 `updated_at`（修订即变化）⇒ 直接沿用会在修订一条记忆时重排整段前缀。
  // 改按 id 固定：集合不变 ⇒ 顺序不变 ⇒ 前缀字节不变。
  facts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return facts;
}

/**
 * memory.jsonl 记录级预检（判据 6「损坏记忆文件」）。口径与 core `memoryDiagnostics` 同源
 * （行 JSON 合法 + 事件名合法 + `event`/`actor` 必在），并与 core 的「静默容错跳过」行为交叉断言
 * （见 g315 测试）。只读；不存在 ⇒ 无问题。
 */
function memoryFileProblems(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SyncError("memory-corrupt", `memory/memory.jsonl 不可读：${(e as Error).message}`);
  }
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      out.push(`第 ${i + 1} 行不是合法 JSON`);
      continue;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec) || typeof rec.event !== "string" || typeof rec.actor !== "string") {
      out.push(`第 ${i + 1} 行字段缺失（需 event/actor）`);
      continue;
    }
    if (!["memory.added", "memory.replaced", "memory.removed"].includes(rec.event)) {
      out.push(`第 ${i + 1} 行事件类型非法：${rec.event}`);
    }
  }
  return out;
}

/** 折叠内部换行与连续空白：一条记忆必须是前缀里的**一行**（否则前缀结构随正文长度漂移）。 */
function collapseWhitespace(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 版本与目标：经 core `boardProjection({ lazy: true })`——版本元信息（`loadGoal(version.md)` 的
 * frontmatter）、版本内目标与独立/backlog 目标都由 core 一处给出，本模块不碰 frontmatter。
 *
 * - 只投影**未 released** 的版本（`planning` / `active` 等）：本目标要的是「当前在做什么」，
 *   把整条发布史塞进动态段只会让它每次全量变化；
 * - 目标**不按状态过滤**：`delivered` / `blocked` 同样是真实状态，静默过滤会让投影显得比看板干净
 *   （本仓就有目标处于 review、若干被暂缓）。过滤由调用方以 `--active-only` 显式选择。
 * - `lazy: true` 让 core 跳过 backlog/standalone 的逐文件装载（它们的数量足够大，且状态已由
 *   `backlog_count` 另行给出）——动态段只需要「版本 + 版本内目标」与一个 backlog 计数。
 */
function loadVersions(
  root: string,
  problems: SyncError[],
): { versions: VersionFact[]; backlogCount: number; standaloneCount: number } {
  let projection;
  try {
    projection = boardProjection(root, { lazy: true });
  } catch (e) {
    const msg = (e as Error).message;
    const code: SyncProblemCode = /events\.jsonl|事件/.test(msg) ? "event-log-corrupt" : "version-unreadable";
    problems.push(new SyncError(code, `看板投影不可读：${msg}`));
    return { versions: [], backlogCount: 0, standaloneCount: 0 };
  }
  const versions: VersionFact[] = [];
  for (const v of projection.versions) {
    if (v.status === "released") continue;
    versions.push({
      slug: v.slug,
      name: v.name,
      status: v.status,
      goals: sortGoals(v.goals),
    });
  }
  versions.sort((a, b) => {
    const ra = rank(a.status);
    const rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  // backlog / 独立目标的数量由 core 的 lazy 计数与板上列表给出（不逐条装载，只看规模）。
  return {
    versions,
    backlogCount: projection.backlog_count ?? 0,
    standaloneCount: projection.standalone.length,
  };
}

function rank(status: string): number {
  const i = STATUS_ORDER.indexOf(status);
  return i < 0 ? STATUS_ORDER.length : i;
}

function sortGoals(goals: readonly BoardGoal[]): GoalFact[] {
  return goals
    .map((g) => ({ id: g.id, title: g.title, status: g.status, type: g.type }))
    .sort((a, b) => {
      const ra = rank(a.status);
      const rb = rank(b.status);
      if (ra !== rb) return ra - rb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

// ---------------------------------------------------------------------------
// 渲染：A 段（稳定前缀）+ B 段（动态概览）
// ---------------------------------------------------------------------------

/**
 * 渲染 A 段（稳定前缀）。硬约束：**不含**任何计数、时间、绝对路径或历史派生字段。
 * 同一条记忆的渲染行只由该记忆自身字段决定 ⇒ 前缀只随记忆**集合**变化。
 */
export function renderStablePrefix(standing: readonly StandingFact[]): string {
  const lines: string[] = [];
  lines.push("### A. 硬性事实（稳定前缀，勿手改）");
  lines.push("");
  lines.push(
    "以下由 `dsh-graph sync` 从 `.dsh-graph/memory/` 的**常驻（standing）记忆**投影而来，是项目不可违背的硬性与环境约束。",
  );
  lines.push("本区段是**稳定前缀**：不含计数、时间与任何派生状态 —— 记忆不变则逐字节不变，便于 Prompt 缓存命中。");
  lines.push("");
  if (standing.length === 0) {
    lines.push('（当前没有常驻记忆；用 `graph_memory_add(scope="standing")` 登记硬性约束后重新 sync。）');
    return lines.join("\n");
  }
  for (const f of standing) {
    const auth = f.human
      ? `人类授权${f.createdBy ? `:${f.createdBy}` : ""}`
      : `Agent自述${f.createdBy ? `:${f.createdBy}` : ""}，参考`;
    const goal = f.sourceGoal ? `，目标:${f.sourceGoal}` : "";
    lines.push(`- **[${f.id}]**（${auth}${goal}）${f.text}`);
  }
  return lines.join("\n");
}

function statusTally(goals: readonly GoalFact[]): string {
  const counts = new Map<string, number>();
  for (const g of goals) counts.set(g.status, (counts.get(g.status) ?? 0) + 1);
  if (counts.size === 0) return "（无）";
  const ordered = STATUS_ORDER.filter((s) => counts.has(s));
  for (const [s] of counts) if (!STATUS_ORDER.includes(s)) ordered.push(s);
  return ordered.map((s) => `${s} ${counts.get(s)}`).join(" / ");
}

export interface DynamicRenderOptions {
  /** `--full`：不折叠目标列表。 */
  full?: boolean;
  /** `--active-only`：只列出不处于这些终态的目标。 */
  closedStates?: readonly string[];
  maxGoals?: number;
  /** core 的 backlog 计数（lazy 投影给出）；缺省 0。 */
  backlogCount?: number;
  /** core 的独立目标计数；缺省 0。 */
  standaloneCount?: number;
}

/** 渲染 B 段（动态概览）。允许含计数与时间：它永远在稳定前缀之后。 */
export function renderDynamicSection(versions: readonly VersionFact[], opts: DynamicRenderOptions = {}): string {
  const max = opts.full ? Number.POSITIVE_INFINITY : opts.maxGoals && opts.maxGoals > 0 ? opts.maxGoals : SYNC_MAX_GOALS;
  const closed = opts.closedStates && opts.closedStates.length > 0 ? new Set(opts.closedStates) : null;
  const visible = (g: GoalFact): boolean => (closed ? !closed.has(g.status) : true);
  const allGoals = versions.flatMap((v) => v.goals);

  const lines: string[] = [];
  lines.push("### B. 动态概览（目标状态，可随时变化）");
  lines.push("");
  lines.push("以下随看板变化，位于稳定前缀之后；内容变化只影响本区段，不影响上文前缀。");
  lines.push("");
  lines.push(
    `- 版本：${versions.length === 0 ? "（无未发布版本）" : versions.map((v) => `${v.slug}（${v.status}）`).join("、")}`,
  );
  lines.push(
    `- 版本内目标：${allGoals.length === 0 ? "（无）" : statusTally(allGoals)}；backlog ${opts.backlogCount ?? 0} / 独立 ${opts.standaloneCount ?? 0}`,
  );

  let shown = 0;
  const folded: GoalFact[] = [];
  for (const v of versions) {
    const list = v.goals.filter(visible);
    const pick: GoalFact[] = [];
    for (const g of list) {
      if (shown < max) {
        pick.push(g);
        shown++;
      } else {
        folded.push(g);
      }
    }
    if (pick.length === 0 && list.length === 0) {
      // 版本存在但无可列目标：显式说明，绝不静默消失（否则「版本不见了」无从解释）。
      lines.push("");
      lines.push(`#### ${v.name}（${v.status}）`);
      lines.push("");
      lines.push(v.goals.length === 0 ? "（该版本暂无目标）" : "（目标已按 --active-only 过滤）");
      continue;
    }
    if (pick.length === 0) continue;
    lines.push("");
    lines.push(`#### ${v.name}（${v.status}）`);
    lines.push("");
    for (const g of pick) lines.push(`- ${g.id} [${g.status}] ${g.title}`);
  }
  if (folded.length > 0) {
    lines.push("");
    lines.push(
      `- （其余 ${folded.length} 个目标已折叠：单次最多列 ${max} 个，用 \`dsh-graph sync --full\` 展开；完整清单用 \`dsh-graph goal list\`）`,
    );
  }
  return lines.join("\n");
}

/** 渲染完整受控区段（含 BEGIN/END 标记）。 */
export function renderSyncBlock(
  standing: readonly StandingFact[],
  versions: readonly VersionFact[],
  opts: DynamicRenderOptions = {},
): string {
  return [
    SYNC_MARKERS.begin,
    "",
    "<!-- 本区段由 `dsh-graph sync`（g-315）自动生成，禁止手改：手改会在下次 sync 时被覆盖。 -->",
    "<!-- 区段之外的内容由你维护，sync 永不触碰。投影来源：.dsh-graph 的常驻记忆与版本目标。 -->",
    "",
    renderStablePrefix(standing),
    "",
    renderDynamicSection(versions, opts),
    "",
    SYNC_MARKERS.end,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 文档拼接：受控标记区段替换 / 无标记追加（区段外字节级不变）
// ---------------------------------------------------------------------------

export interface RenderOutcome {
  /** 是否命中受控区段（false ⇒ 走了追加规则）。 */
  found: boolean;
  /** 完整新文本。 */
  text: string;
  /** 原有区段原文（未命中为 null）。 */
  previousBlock: string | null;
}

/**
 * 拼接：`前缀 + 新区段 + 后缀`，区段外**逐字节**沿用原文（不重写行尾、不 trim、不增删空行）。
 *
 * 畸形标记（BEGIN/END 各需恰好 1 处；END 不得早于 BEGIN）一律**拒绝**而非猜测：猜错会把用户手写
 * 内容夹进受控区段里，下次 sync 直接吞掉。拒绝是判据 6 要求的那类可读失败，且零写入。
 */
export function renderDocument(existing: string | null, block: string): RenderOutcome {
  if (existing === null) return { found: false, text: `${block}\n`, previousBlock: null };
  const src = existing;
  const countOf = (marker: string): number => src.split(marker).length - 1;
  const begins = countOf(SYNC_MARKERS.begin);
  const ends = countOf(SYNC_MARKERS.end);

  if (begins === 0 && ends === 0) {
    if (src === "") return { found: false, text: `${block}\n`, previousBlock: null };
    const eol = detectEol(src);
    const sep = src.endsWith("\n") ? "" : eol;
    return { found: false, text: `${src}${sep}${block}\n`, previousBlock: null };
  }
  if (begins !== 1 || ends !== 1) {
    throw new SyncError(
      "marker-malformed",
      `受控标记不唯一：BEGIN × ${begins}、END × ${ends}（必须各 1 处）。请先手工清理多余标记再 sync` +
        ` —— 不猜哪一段是受控区段，以免吞掉手写内容`,
    );
  }
  const begin = src.indexOf(SYNC_MARKERS.begin);
  const end = src.indexOf(SYNC_MARKERS.end);
  if (end < begin) {
    throw new SyncError("marker-malformed", "受控标记顺序颠倒（END 出现在 BEGIN 之前），请先手工修正再 sync");
  }
  const blockEnd = end + SYNC_MARKERS.end.length;
  // 区段之后若紧跟原文：原文若不以换行开头，标记会黏到后文的下一行上 ⇒ 补一个区段侧换行。
  // 这一换行属于**区段侧**（`renderSyncBlock` 的收尾），不改变后缀原文的任何字节。
  const tail = src.slice(blockEnd);
  const glue = tail !== "" && !tail.startsWith("\n") && !tail.startsWith("\r\n") ? "\n" : "";
  return {
    found: true,
    text: `${src.slice(0, begin)}${block}${glue}${tail}`,
    previousBlock: src.slice(begin, blockEnd),
  };
}

/** 原文的行尾风格（以最后出现的 `\r\n` / `\n` 为准；无换行视为 `\n`）。 */
function detectEol(src: string): string {
  const lf = src.lastIndexOf("\n");
  if (lf > 0 && src[lf - 1] === "\r") return "\r\n";
  if (lf >= 0 && src.includes("\r\n")) return "\r\n";
  return "\n";
}

/** 取完整文本里的 A 段（稳定前缀）字节 —— 「前缀跨次运行稳定」的可执行断言口径。 */
export function extractStablePrefix(doc: string): string | null {
  const begin = doc.indexOf(SYNC_MARKERS.begin);
  const end = doc.indexOf(SYNC_MARKERS.end);
  if (begin < 0 || end < 0 || end < begin) return null;
  const block = doc.slice(begin, end);
  const aStart = block.indexOf("### A. 硬性事实");
  const bStart = block.indexOf("### B. 动态概览");
  if (aStart < 0) return null;
  return bStart < 0 ? block.slice(aStart) : block.slice(aStart, bStart);
}

/** 区段外字节（前缀 + 后缀）—— 「无损」断言的可执行口径。 */
export function extractOutsideBlock(doc: string): { prefix: string; suffix: string } | null {
  const begin = doc.indexOf(SYNC_MARKERS.begin);
  const end = doc.indexOf(SYNC_MARKERS.end);
  if (begin < 0 || end < 0 || end < begin) return null;
  return { prefix: doc.slice(0, begin), suffix: doc.slice(end + SYNC_MARKERS.end.length) };
}

/** 稳定前缀的 sha256（`--json` 与测试共用：两次运行相等即前缀稳定）。 */
export function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// 目标定位、规划与落地
// ---------------------------------------------------------------------------

export interface SyncTargetPlan {
  rel: SyncTarget;
  abs: string;
  existing: string | null;
  rendered: RenderOutcome;
  changed: boolean;
}

/**
 * 写入位置 = **发起调用的 workspace 根**。
 *
 * 为什么不能直接取 `dirname(graph root)`（这是最容易踩的坑）：在 Git **linked worktree**
 * 里跑任何 dsh-graph 命令时，core 的 `resolveCanonicalRoot` 会把看板根**归一到主树**
 * （`mode: "canonicalized"`，见 `core/root.ts`）——由 `dirname(root)` 推出的 workspace 会是
 * **主树**，于是「在 worktree 里 sync」会静默改写主树的 AGENTS.md，而 worktree 自己的
 * AGENTS.md 纹丝不动（g-315 实测复现：从 worktree 根 sync 后 `git status` 干净，主树文件却变了）。
 *
 * 故写入位置按「调用方 workspace」独立解析，并在两处把歧义显式化：
 * 1. 若 `--root` 指向的看板**不属于**调用方 workspace 所属的工作树（跨树）⇒ **拒绝**（可读非零退出），
 *    绝不替用户猜「想写哪棵树」；
 * 2. 写入位置落在 git-ignored scratch 目录（如 `tmp/` 下的夹具）时仍按该目录写 —— 它是自己的项目根。
 *
 * 非 git 目录（普通文件夹）⇒ 注释为 workspace 根本身，行为与 `dirname(root)` 一致。
 */
function resolveGraphDirNameForOwnership(dirName: string | null | undefined, graphRoot: string): string {
  if (typeof dirName === "string" && dirName.trim() !== "") return dirName.trim();
  // 未显式给出：默认名下的历史调用行为完全不变（只看 `<parent>/.dsh-graph`）；
  // 看板根自身目录名非默认时按实际名判定（自定义根目录形态）。
  const base = basename(graphRoot);
  return base === "" ? DEFAULT_GRAPH_DIR_NAME : base;
}

export function resolveWorkspaceForSync(invokedWorkspace: string, root: string, dirName?: string | null): string {
  const invoked = resolve(invokedWorkspace);
  const graphRoot = resolve(root);
  // g-632 B：归属判定按**实际目录名**（自定义名下 `<ws>/board-a` 仍必须是「本工作树自己的看板」），
  // 而不是硬编码默认名。未给出时从 graphRoot 反推（见 `graphDirNameFromRoot`）——
  // 默认名路径逐字等价于旧写法。
  const name = resolveGraphDirNameForOwnership(dirName, graphRoot);
  const localRoot = join(invoked, name);

  // 写法 A：看板就在调用方 workspace 里（`<ws>/<name>`，普通目录或仓库根）。
  if (localRoot === graphRoot) return invoked;

  // 写法 B：看板被 core 归一到别处（linked worktree → 主树）。此时只有两种合法情形：
  // 调用方 workspace 属于同一个仓库，且看板属于该仓库的主工作树。
  const info = isScratchWorkspace(invoked) ? null : discoverGitWorktree(invoked);
  if (info && resolve(join(info.mainWorktree, name)) === graphRoot) {
    // 调用方在 linked worktree 里、根被归一到主树 ⇒ 写入**调用方自己的** worktree 根。
    return info.worktreeRoot;
  }
  throw new SyncError(
    "bad-option",
    `看板 ${graphRoot} 与当前工作目录所属的工作树不一致（调用方：${invoked}）。` +
      `sync 只把投影写进「发起调用的那棵树」的 .claude/CLAUDE.md 与 AGENTS.md —— ` +
      `请在目标树根运行，或用 --root 指向该树自己的 ${name}`,
  );
}

/** 解析目标（`--target` 只接受两个已知相对路径，拒绝绝对/越界）。 */
export function resolveTargets(only?: string | null): SyncTarget[] {
  if (!only) return [...SYNC_TARGETS];
  if (!(SYNC_TARGETS as readonly string[]).includes(only)) {
    throw new SyncError("bad-option", `--target 只接受 ${SYNC_TARGETS.join(" 或 ")}（收到：${only}）`);
  }
  return [only as SyncTarget];
}

/** 读原文：缺失 ⇒ null；是目录 / 不可读一律**可判定失败**（绝不把「读不到」当空文件覆盖）。 */
function readTarget(abs: string): string | null {
  try {
    statSync(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new SyncError("target-unreadable", `${abs} 不可访问：${(e as Error).message}`);
  }
  if (statSync(abs).isDirectory()) {
    throw new SyncError("target-is-directory", `${abs} 是目录而不是文件（拒绝写入）`);
  }
  try {
    return readFileSync(abs, "utf8");
  } catch (e) {
    throw new SyncError("target-unreadable", `${abs} 读取失败：${(e as Error).message}（拒绝当作空文件覆盖）`);
  }
}

/** 目录可写性预检（判据 6「目录只读」）：在**任何写之前**做，保证不产生部分写入。 */
function assertWritableDir(dir: string): void {
  const probe = nearestExistingDir(dir);
  try {
    accessSync(probe, constants.W_OK);
  } catch (e) {
    throw new SyncError("target-unwritable", `目标目录不可写：${probe}（${(e as Error).message}）`);
  }
}

function nearestExistingDir(dir: string): string {
  let cur = dir;
  for (;;) {
    try {
      if (statSync(cur).isDirectory()) return cur;
    } catch {
      /* 继续向上 */
    }
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

export interface SyncPlan {
  root: string;
  workspace: string;
  inputs: SyncInputs;
  targets: SyncTargetPlan[];
  changedCount: number;
  /** 非空 ⇒ 不写任何文件、非零退出。 */
  problems: SyncError[];
  /** 渲染出的完整区段（供 `--json` 与测试核对前缀哈希）。 */
  block: string | null;
}

/**
 * 规划：**只读**。完成全部载入、渲染、原文读取与可写性预检；任何问题只返回、不落盘。
 * 「先全部成功、再逐个写」由这个两段式结构保证，而不是靠写入阶段的自律。
 */
export function planSync(
  root: string,
  opts: { targets?: string | null; closedStates?: readonly string[]; invokedWorkspace?: string } & DynamicRenderOptions = {},
): SyncPlan {
  const inputs = loadSyncInputs(root);
  const problems = [...inputs.problems];
  let workspace: string;
  try {
    workspace = resolveWorkspaceForSync(opts.invokedWorkspace ?? process.cwd(), root);
  } catch (e) {
    problems.push(e instanceof SyncError ? e : new SyncError("bad-option", (e as Error).message));
    return { root, workspace: "", inputs, targets: [], changedCount: 0, problems, block: null };
  }

  const renderOpts: DynamicRenderOptions = {
    ...opts,
    backlogCount: inputs.backlogCount,
    standaloneCount: inputs.standaloneCount,
  };

  let targets: SyncTargetPlan[] = [];
  let block: string | null = null;
  try {
    block = renderSyncBlock(inputs.standing, inputs.versions, renderOpts);
    for (const rel of resolveTargets(opts.targets)) {
      const abs = join(workspace, rel);
      const existing = readTarget(abs);
      const rendered = renderDocument(existing, block);
      targets.push({ rel, abs, existing, rendered, changed: existing === null || rendered.text !== existing });
    }
    for (const t of targets) if (t.changed) assertWritableDir(dirname(t.abs));
  } catch (e) {
    problems.push(e instanceof SyncError ? e : new SyncError("target-unwritable", (e as Error).message));
    targets = [];
  }

  return {
    root,
    workspace,
    inputs,
    targets,
    changedCount: targets.filter((t) => t.changed).length,
    problems,
    block,
  };
}

export interface SyncApplyResult extends SyncPlan {
  written: SyncTargetPlan[];
  skipped: SyncTargetPlan[];
}

/** 落地：仅当规划无问题才写；每个文件各自原子写（失败由 core `atomicWrite` 清理临时文件）。 */
export function applySync(plan: SyncPlan): SyncApplyResult {
  if (plan.problems.length > 0) return { ...plan, written: [], skipped: plan.targets };
  const written: SyncTargetPlan[] = [];
  const skipped: SyncTargetPlan[] = [];
  for (const t of plan.targets) {
    if (!t.changed) {
      skipped.push(t);
      continue;
    }
    mkdirSync(dirname(t.abs), { recursive: true });
    atomicWrite(t.abs, Buffer.from(t.rendered.text, "utf8"));
    written.push(t);
  }
  return { ...plan, written, skipped };
}

/** 一次性执行（plan → apply）。 */
export function syncTargets(
  root: string,
  opts: { targets?: string | null; closedStates?: readonly string[]; invokedWorkspace?: string } & DynamicRenderOptions = {},
): SyncApplyResult {
  return applySync(planSync(root, opts));
}
