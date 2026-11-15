/**
 * dsh-cli claim（g-316）：认领一个目标 + 把质量判据内联注入到当前工作上下文。
 *
 * 价值：单兵工具写代码快但容易「需求走偏 / 遗漏非功能约束」。claim 在动手前把目标与判据
 * 摊在终端上，并把看板状态推进到 `in_progress`，让「先看判据再改代码」成为默认路径。
 *
 * 复用约束（判据 1/2）：
 * - frontmatter / 判据解析**全部来自 core**：`findGoalFile` + `loadGoal` 解析目标，
 *   `criteriaItems` / `sectionText` 解析判据与其小节原始文本；本模块**不手写任何 frontmatter、
 *   小节或判据解析**。
 * - 状态迁移**只调 core 的 `transition`**：它内部做状态机校验（`assertTransition`，含
 *   「进入 in_progress 前判据非空 + rules_snapshot + criteria.confirmed」三道门禁）与
 *   **事件先行**提交（`commitPrepared`：先 `appendEvent` 成功，再 `persist` 写 frontmatter；
 *   persist 失败补记 `tx.persist_failed`）。本模块**不拼 events 行、不自己写 goal.md**。
 * - 锁由 core 事务层提供：整个「读取 → 校验 → 迁移」在 `withLocalLock`（O_EXCL + PID 携带方
 *   身份）临界区内完成，临界区内**重读**目标即 CLI 侧的 CAS —— 锁内的 status 就是权威当前值。
 *   不叠加 `withTx`：`transition` 自己不持锁，再进 `withTx` 会构成同进程嵌套获取（core 判死锁）。
 *
 * 幂等（判据 5）：目标已是 `in_progress` ⇒ **幂等成功**（退出 0，`changed=false`，
 * **不产生任何事件**，也不建 attempt 目录）。并发两路 claim 同一目标时，后到者在锁内看到
 * `in_progress` 同样走幂等路径 ⇒ 只有一路真正迁移、只有一条 `goal.transition` 事件。
 *
 * 零副作用（判据 4/6）：所有拒绝判定（目标不存在、无/空判据、状态不允许、损坏 goal.md、
 * 非工作区、只读目录、并发冲突）都在**任何写入之前**完成；只读目录预检特意**先于**取锁
 * （取锁会创建 `.lock.*` 文件）。CLI 从不建 attempt 目录（claim 只做状态认领 + 任务单，不派发）。
 *
 * 任务单（判据 4）：短文本，只含目标 id/标题/状态、编号判据清单、以及由**实际观测到的边界**
 * 派生的提示行（锁发现 / scratch 工作区 / 旧规则基线 / 看板根）。绝不把正文或长文本写进事件或看板字段。
 */
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GraphError, findGoalFile, listGoalFiles, loadGoal, readRulesVersion, transition } from "../ops.ts";
import type { GoalDoc } from "../domain/model.ts";
import { criteriaItems, isCriterionVerified, sectionText } from "../domain/model.ts";
import { readEvents } from "../events.ts";
import { TxError, withLocalLock } from "../transaction.ts";
import { isScratchWorkspace } from "../root.ts";

/** claim 的可判定失败（`code` 供测试稳定断言，`message` 面向人类可读）。 */
export type ClaimProblemCode =
  | "goal-not-found"
  | "goal-file-corrupt"
  | "goal-archived"
  | "criteria-missing"
  | "criteria-unconfirmed"
  | "rules-version-missing"
  | "state-not-allowed"
  | "claim-lock-busy"
  | "board-unwritable"
  | "transition-event-failed"
  | "transition-persist-failed"
  | "transition-failed";

/** 拒绝/失败：一律非零退出，且（除 persist 阶段外）保证**未发生任何写入**。 */
export class ClaimError extends Error {
  readonly code: ClaimProblemCode;
  /** 事件先行语义下 persist 失败时事件**已经**落盘（仅 transition-persist-failed 为 true）。 */
  readonly eventsWritten: boolean;
  constructor(code: ClaimProblemCode, message: string, eventsWritten = false) {
    super(message);
    this.name = "ClaimError";
    this.code = code;
    this.eventsWritten = eventsWritten;
  }
}

/** 等待认领锁的上限（ms）：并发 claim 在「短临界区 + 快速失败」语义下给出明确拒绝。 */
export const CLAIM_LOCK_TIMEOUT_MS = 1500;

/** 认领锁名（按目标隔离）：同一目标的 claim 串行化，不同目标互不阻塞。 */
export function claimLockName(goalId: string): string {
  return `claim-${goalId}`;
}

/** 状态机的入边（进入 in_progress 的合法来源；与 `core/domain/machine.ts` 的 EDGES 同口径）。 */
const ENTERS_IN_PROGRESS = new Set(["planning", "collecting", "ready"]);

/** 一次 claim 的结果（`--json` 即此结构的机器可读形态）。 */
export interface ClaimResult {
  goal: {
    id: string;
    title: string;
    type: string;
    version: string | null;
    status: string;
    /** 相对 graph root 的目标文件路径。 */
    file: string;
  };
  /** 本次是否真的发生状态迁移（false = 幂等命中，无写入）。 */
  changed: boolean;
  from: string;
  to: string;
  criteria: string[];
  /** 由实际观测派生的边界提示（短行）。 */
  boundaries: string[];
  /** 本次写入的事件类型（同一次迁移只有 `goal.transition`；幂等时为空数组）。 */
  events: string[];
}

/** 目录是否可写（`access(W_OK)`：只问权限，不落任何字节）。 */
function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 归档目标判定（与 core `isArchivedFile` 同口径：路径含 archived 段）。 */
function isArchivedRel(rel: string): boolean {
  return rel.includes("/archived/") || rel.includes("\\archived\\");
}

/**
 * 损坏的目标文件（判据 6）：`findGoalFile` **静默跳过**解析失败的文件（那是 validate 的职责），
 * 于是「goal.md 损坏」会伪装成「目标不存在」。这里先枚举一遍拿到「确实存在但不可解析」的文件，
 * 并按 id 字面量在原始文本中的出现精确归属；只读、零副作用。
 */
export function findCorruptGoalFiles(root: string, id: string): string[] {
  const out: string[] = [];
  for (const file of listGoalFiles(root, { includeArchived: true })) {
    try {
      loadGoal(file);
      continue; // 可解析：不是损坏候选（其 id 归属由 findGoalFile 负责）
    } catch {
      /* 不可解析 ⇒ 候选 */
    }
    try {
      // 只能在**原始文本**里找 id：损坏的正是解析路径，不能经 loadGoal 取 meta。
      if (readFileSync(file, "utf8").includes(id)) out.push(file);
    } catch {
      /* 读不到（EACCES 等）：不猜，交给 findGoalFile 的「目标不存在」口径 */
    }
  }
  return out;
}

/**
 * 收集「实际观测到的边界」提示行（短、确定、只陈述观测到的事实）。
 */
function collectBoundaries(params: {
  root: string;
  workspace: string;
  changed: boolean;
  previousStatus: string;
  rulesVersion: string | null;
  rulesSnapshot: string | null;
  /** **取锁之前**观测到的看板锁文件（取锁后必然存在本进程自己的 .lock，不能那时数）。 */
  observedLocks: string[];
}): string[] {
  const lines: string[] = [
    params.changed
      ? `状态：${params.previousStatus} → in_progress（已写入一条 goal.transition 事件，事件先于文件）`
      : "状态：已是 in_progress（幂等命中，未写入任何事件）",
    "本次只做状态认领 + 任务单：不派发子代理、不建 attempt 目录、不改任何代码。",
  ];
  // 锁文件残留 = 可能有其他会话/进程正在同一看板上作业（如实转述，不推断结果）。
  const locks = params.observedLocks;
  if (locks.length > 0) {
    const shown = locks.slice(0, 3).join("、");
    lines.push(`锁：进入前看板已有 ${locks.length} 个锁文件（${shown}${locks.length > 3 ? "…" : ""}）——可能有其他进程正在写入。`);
  }
  if (isScratchWorkspace(params.workspace)) {
    lines.push("工作区：scratch（无 git 跟踪），改动不会被版本控制记录。");
  }
  if (params.rulesVersion && params.rulesSnapshot && params.rulesVersion !== params.rulesSnapshot) {
    lines.push(`规则：目标基线 rules_snapshot=${params.rulesSnapshot}，当前规则库=${params.rulesVersion}（判据口径以目标快照为准）。`);
  }
  lines.push(`看板根：${params.root}（本次写操作只落此目录）`);
  return lines;
}

/** 看板里已存在的锁文件名（只读；在取锁**之前**调用，否则会数到本进程自己的锁）。 */
function readExistingLocks(root: string): string[] {
  try {
    return readdirSync(root).filter((f) => f.startsWith(".lock.")).sort();
  } catch {
    return [];
  }
}

/** 读取规则库版本（复用 core；规则缺失/损坏时不致命，只少一行提示）。 */
function rulesVersionOrNull(root: string): string | null {
  try {
    return readRulesVersion(root);
  } catch {
    return null;
  }
}

/**
 * 认领目标（唯一写路径 = core `transition`）。
 *
 * @throws ClaimError 全部可判定拒绝。半迁移防护：
 *   - 事件写入失败 ⇒ core 抛 `TxError(phase="event")`，goal.md **未被改动**（磁盘保持原值）；
 *   - frontmatter 写入失败 ⇒ core 已补记 `tx.persist_failed` 并抛 `TxError(phase="persist")`；
 *     此时**如实报告「事件已落盘」**并以 `eventsWritten=true` 标出（事件先行的固有窗口，重试即收敛）。
 */
export function claimGoal(params: { root: string; id: string; actor: string }): ClaimResult {
  const { root, id, actor } = params;
  const workspace = join(root, "..");

  // ---- 写入前预检（零副作用）：未初始化 / 只读目录 ----
  // 顺序刻意在取锁之前：取锁会创建 `.lock.<name>` 文件，那已经是一次写。
  // 「未初始化」必须先判：目录不存在时 access(W_OK) 同样失败，会误报成「只读」。
  if (!existsSync(join(root, "events.jsonl"))) {
    throw new ClaimError(
      "board-unwritable",
      `看板未初始化（缺少 events.jsonl）：${root} —— 请先初始化看板（dsh-graph init）后再 claim`,
    );
  }
  if (!isWritableDir(root)) {
    throw new ClaimError(
      "board-unwritable",
      `看板目录不可写（只读）：${root} —— claim 需要追加事件并写回 frontmatter，请检查目录权限后重试`,
    );
  }

  // 并发观测：取锁**之前**的锁快照（取锁后 `.lock.claim-<id>` 必然存在，不能再数）。
  const observedLocks = readExistingLocks(root);

  const run = (): ClaimResult => {
    // ---- 锁内：读取 → 校验 → 迁移（CAS = 锁内重读） ----
    let file: string;
    try {
      file = findGoalFile(root, id);
    } catch (e) {
      const corrupt = findCorruptGoalFiles(root, id);
      if (corrupt.length > 0) {
        const shown = corrupt.slice(0, 3).map((f) => relative(root, f)).join("、");
        throw new ClaimError(
          "goal-file-corrupt",
          `目标文件损坏（frontmatter 或结构不可解析）无法认领：${shown}` +
            `${corrupt.length > 3 ? ` 等 ${corrupt.length} 个` : ""} —— 请先修复该 goal.md（dsh-cli status 可看细节）`,
        );
      }
      throw new ClaimError("goal-not-found", (e as Error).message);
    }

    let doc: GoalDoc;
    try {
      doc = loadGoal(file);
    } catch (e) {
      throw new ClaimError("goal-file-corrupt", `目标文件损坏：${file}（${(e as Error).message}）`);
    }

    const meta = doc.meta ?? {};
    const status = String(meta.status ?? "");
    const fileRel = relative(root, file);
    const criteria = criteriaItems(doc.body);

    if (isArchivedRel(fileRel)) {
      throw new ClaimError(
        "goal-archived",
        `目标 ${id} 已归档，不能认领（归档目标不可迁移）——如需继续工作请先取消归档`,
      );
    }
    // 判据：空/缺判据一律拒绝 —— claim 的全部价值就是先注入判据，判据为空时拒绝认领。
    if (criteria.length === 0) {
      const missingSection = sectionText(doc.body, "质量判据") === null;
      throw new ClaimError(
        "criteria-missing",
        `目标 ${id} 没有质量判据（${missingSection ? "缺少「质量判据」小节" : "「质量判据」小节为空或只有模板占位"}）——` +
          `请先登记判据（graph_set_criteria）再 claim`,
      );
    }
    // core 状态机的进入门禁（存在 criteria.confirmed 事件）；提前给出可读原因而非裸「非法迁移」。
    const confirmed = readEvents(root).some((e) => e.goal === id && e.event === "criteria.confirmed");
    if (!confirmed) {
      throw new ClaimError(
        "criteria-unconfirmed",
        `目标 ${id} 的判据尚未确认（缺少 criteria.confirmed 事件）——请先确认判据再 claim`,
      );
    }
    if (!meta.rules_snapshot) {
      throw new ClaimError(
        "rules-version-missing",
        `目标 ${id} 未记录 rules_snapshot，不满足进入 in_progress 的前置条件——请先确认判据（会快照规则库版本）`,
      );
    }
    // 状态允许：in_progress 走幂等（下文），其余按状态机入边判定。
    if (status !== "in_progress" && !ENTERS_IN_PROGRESS.has(status)) {
      throw new ClaimError(
        "state-not-allowed",
        `目标 ${id} 当前状态为 ${status || "(空)"}，不能认领到 in_progress（仅 planning / collecting / ready 可认领；` +
          `in_progress 视为幂等成功；blocked 请先解除阻塞；review / delivered 请走对应流转）`,
      );
    }

    let changed = false;
    if (status !== "in_progress") {
      try {
        transition(root, id, "in_progress", { actor });
        changed = true;
      } catch (e) {
        if (e instanceof TxError) {
          if (e.phase === "event") {
            throw new ClaimError("transition-event-failed", `状态迁移失败（事件阶段，goal.md 未改动）：${e.message}`);
          }
          throw new ClaimError(
            "transition-persist-failed",
            `状态迁移失败（持久化阶段，事件已落盘、frontmatter 未更新；重试同一命令即可收敛）：${e.message}`,
            true,
          );
        }
        if (e instanceof GraphError) {
          throw new ClaimError("state-not-allowed", `状态迁移被拒绝：${e.message}`);
        }
        throw new ClaimError("transition-failed", `状态迁移异常：${(e as Error).message}`);
      }
    }

    const rulesSnapshot = meta.rules_snapshot == null ? null : String(meta.rules_snapshot);
    return {
      goal: {
        id: String(meta.id ?? id),
        title: String(meta.title ?? ""),
        type: String(meta.type ?? ""),
        version: meta.version == null ? null : String(meta.version),
        status: "in_progress",
        file: fileRel,
      },
      changed,
      from: status,
      to: "in_progress",
      criteria,
      boundaries: collectBoundaries({
        root,
        workspace,
        changed,
        previousStatus: status,
        rulesVersion: rulesVersionOrNull(root),
        rulesSnapshot,
        observedLocks,
      }),
      events: changed ? ["goal.transition"] : [],
    };
  };

  try {
    // 临界区必须全同步（不得跨 await）——本函数及其被调方均无 await。
    return withLocalLock(root, claimLockName(id), run, { lockTimeoutMs: CLAIM_LOCK_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof ClaimError) throw e;
    if (e instanceof TxError && /获取锁超时/.test(e.message)) {
      throw new ClaimError(
        "claim-lock-busy",
        `另一路 claim 正在处理目标 ${id}（${e.message}）——同一目标不能并发认领，请稍后重试`,
      );
    }
    throw new ClaimError("transition-failed", `claim 失败：${(e as Error).message}`);
  }
}

/** 渲染人类可读任务单（判据 4：轻量、短、不倾倒正文）。 */
export function renderClaimSheet(result: ClaimResult): string {
  const g = result.goal;
  const out: string[] = [];
  out.push(`已认领 ${g.id}：${g.title}`);
  const transition = result.changed ? `${result.from} → ${result.to}` : `${result.to}（幂等）`;
  out.push(`类型：${g.type}${g.version ? ` @${g.version}` : ""}\t状态：${transition}`);
  out.push("");
  out.push(`质量判据（${result.criteria.length} 项，逐条自检后再声明完成）：`);
  result.criteria.forEach((c, i) => {
    const line = c.trim();
    // 判据项原样保留（含已有序号）；无序号时补 1..N，保证终端里可逐条勾对。
    // 「已验」标记复用 core 的单一判定（不另立正则）。
    const label = /^\d+[.、]\s/.test(line) ? line : `${i + 1}. ${line}`;
    // 已验判据在终端里显式标出（「已验」判定复用 core 的单一实现，不另立正则）。
    out.push(`  ${isCriterionVerified(line) ? "√" : "·"} ${label}`);
  });
  out.push("");
  out.push("边界提示：");
  for (const b of result.boundaries) out.push(`  - ${b}`);
  return `${out.join("\n")}\n`;
}
