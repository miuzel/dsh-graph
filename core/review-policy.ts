/**
 * 分级评审机制与机器快速放行（Fast-Track Review Policy）。
 *
 * 纯函数模块（无 IO、无 git、无文件系统、无事件写入）：只做**策略解析**与**机器门禁判定**。
 * 结构照既有先例 `core/worktree.ts` 的 `defaultWorktreeForGoalType` /
 * `resolveWorktreeIsolationDecision`（显式 | 类型默认 | 安全侧兜底）。
 *
 * 两条与 `core/worktree.ts` 的 `clean=null` 同源的纪律：
 * 1. **fail-safe**——任一机器信号取不到即**不放行**，绝不把「拿不到证据」当作「证据为真」；
 * 2. **显式声明不得推翻安全侧**——`auto` 只是「允许走快速通道」，M1–M4 任一命中一律升级为
 *    `strict`，包括本目标自身（改 `core/schema.ts` 即 M1）。
 *
 * 边界（如实声明，不得声称引擎强制）：门禁是 `resolveAccept(fast_track=true)` 的**准入校验**；
 * 「strict 必须派发独立评审子代理」在本插件层只有**判定 + 指南约束**——reviewer 派发入口
 * 尚未接线（`formatReviewPrompt` 定义在 core、host 未接入）。`delivered` 仍只能经既有
 * accept / 人工路径达成，快速通道不新增任何绕过 Human Gate 的路径。
 */

/** 顶层 project.yaml 的 `review.policy` 合法三值（与 core/schema.ts 的 enum 同源真源）。 */
export const REVIEW_POLICIES = ["auto", "strict", "none"] as const;
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number];

/** 快速放行门禁的产品代码变更行数上限（**严格小于**该值）。 */
export const FAST_TRACK_MAX_PRODUCT_LINES = 150;

/** 机器门禁四项（固定顺序，事件与报告同序）。 */
export const FAST_TRACK_CHECKS = ["tests", "typecheck", "diff_size", "criteria_verified"] as const;
export type FastTrackCheckId = (typeof FAST_TRACK_CHECKS)[number];

/** M1：契约路径——变更命中即强制 strict（契约冻结不得走快速通道）。 */
export const CONTRACT_PATHS = ["core/schema.ts", "schema/SCHEMA.md"] as const;

/** M3 判定的顶层区域闭集（照规划补齐的枚举；未登记区域的路径不计入 M3）。 */
export const REVIEW_REGIONS = ["core", "dsh-graph-host", "lib/client", "prompts", "scripts"] as const;
export type ReviewRegion = (typeof REVIEW_REGIONS)[number];

/** 判为 strict 的闭合原因集（固定顺序输出，便于断言与审计）。 */
export const STRICT_REASONS = [
  "contract_change", // M1 变更路径含 core/schema.ts 或 schema/SCHEMA.md
  "product_size", // M2 产品代码变更 ≥ FAST_TRACK_MAX_PRODUCT_LINES 行
  "cross_region", // M3 变更跨 ≥3 个顶层区域
  "declared_strict", // M4 supervisor 显式声明 strict_required
  "type_or_policy_strict", // M5 type ∈ {feature,bug}（或派生为 strict）或项目 policy=strict
  "policy_unrecognized", // 显式值非三值：读路径本应归一为「未配置」，此处安全侧兜底
] as const;
export type StrictReason = (typeof STRICT_REASONS)[number];

/** 产品代码口径：这些前缀下的改动**不计入** `git diff --numstat` 行数（tests/生成物）。 */
const NON_PRODUCT_PREFIXES = [
  "core/tests/",
  "dist/",
  "core-dist/",
  "node_modules/",
  ".worktrees/",
] as const;

/** 产品代码口径：锁文件与文档同样不计入。 */
const NON_PRODUCT_EXACT = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"] as const;

// ---------------------------------------------------------------------------
// 策略解析
// ---------------------------------------------------------------------------

/** 归一化 `project.yaml` 读回的原始标量：仅三值合法，其余（空/null/未知）→ null（＝未配置）。 */
export function normalizeReviewPolicy(raw: unknown): ReviewPolicy | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  return (REVIEW_POLICIES as readonly string[]).includes(t) ? (t as ReviewPolicy) : null;
}

/** 原始值「提供了非空内容但不在三值内」——读路径已归一为 null，直接 API 调用则安全侧兜底。 */
export function isUnrecognizedReviewPolicy(raw: unknown): boolean {
  if (typeof raw !== "string") return raw !== null && raw !== undefined;
  const t = raw.trim();
  return t !== "" && normalizeReviewPolicy(t) === null;
}

/**
 * 按目标类型派生默认策略（未配置 `review.policy` 时）：
 * `patch` / `chore` → `auto`；`feature` / `bug` / `task` / `improvement` → `strict`；
 * 空值 / 非法 / 未登记类型 → `strict`（安全侧兜底，与 worktree 的「其余默认隔离」同向）。
 */
export function typeDefaultReviewPolicy(rawType: unknown): ReviewPolicy {
  if (rawType === null || rawType === undefined || rawType === "") return "strict";
  const t = String(rawType).trim().toLowerCase();
  if (t === "patch" || t === "chore") return "auto";
  if (t === "feature" || t === "bug" || t === "task" || t === "improvement") return "strict";
  return "strict";
}

/** 归一化路径：去空白、去 `./` 前缀、Windows 分隔符转 `/`、丢空串。 */
function normalizePaths(raw: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const p = item.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (p !== "") out.push(p);
  }
  return out;
}

/** 该路径是否命中契约路径（M1）。 */
export function isContractPath(path: string): boolean {
  const p = String(path ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return (CONTRACT_PATHS as readonly string[]).includes(p);
}

/** 路径 → 顶层区域；未登记区域返回 null（不计入 M3，但契约路径另有 M1 兜底捕获）。 */
export function regionOfPath(path: string): ReviewRegion | null {
  const p = String(path ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.startsWith("core/")) return "core";
  if (p.startsWith("dsh-graph-host/lib/client/")) return "lib/client";
  if (p.startsWith("dsh-graph-host/prompts/")) return "prompts";
  if (p.startsWith("dsh-graph-host/")) return "dsh-graph-host";
  if (p.startsWith("scripts/")) return "scripts";
  return null;
}

/** 变更路径覆盖的顶层区域集合（固定顺序，去重）。 */
export function regionsOfPaths(paths: readonly string[]): ReviewRegion[] {
  const seen = new Set<ReviewRegion>();
  for (const p of paths) {
    const r = regionOfPath(p);
    if (r) seen.add(r);
  }
  return REVIEW_REGIONS.filter((r) => seen.has(r));
}

function normalizeLines(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.floor(raw);
}

export interface ReviewPolicyInput {
  /** `project.yaml` 顶层 `review.policy` 原始值（未配置 → null/undefined）。 */
  policy?: unknown;
  /** 目标类型（meta.type）。 */
  type?: unknown;
  /** 变更路径（`git diff --name-only <baseline> HEAD`）；缺省视为「取不到」→ 不触发 M1/M3。 */
  changedPaths?: readonly unknown[] | null;
  /** 产品代码变更行数合计（`countProductChangedLines` 口径）；缺省 → 不触发 M2。 */
  productChangedLines?: number | null;
  /** M4：supervisor 显式声明强制 strict（覆盖「核心层重写」等无法用路径/行数表达的场景）。 */
  strictRequired?: boolean | null;
}

export interface ReviewPolicyDecision {
  /** 最终策略：命中任一 strict 原因即 `strict`。 */
  policy: ReviewPolicy;
  /** 基础策略来源：显式配置 vs 按目标类型派生。 */
  source: "explicit" | "type_default";
  /** 判为 strict 的原因（闭集，固定顺序）；`auto`/`none` 时为空数组。 */
  strictReasons: StrictReason[];
  /** 人读解释（逐条对应 strictReasons）。 */
  reasons: string[];
}

const STRICT_REASON_TEXT: Record<StrictReason, string> = {
  contract_change: `M1 变更路径含契约文件（${CONTRACT_PATHS.join(" / ")}）——契约冻结必须独立评审`,
  product_size: `M2 产品代码变更 ≥ ${FAST_TRACK_MAX_PRODUCT_LINES} 行——超出快速通道安全阈值`,
  cross_region: "M3 变更跨 ≥3 个顶层区域——跨模块改动必须独立评审",
  declared_strict: "M4 supervisor 显式声明 strict_required（核心层重写等）",
  type_or_policy_strict: "M5 目标类型（feature/bug 等）或项目 policy 本身要求 strict",
  policy_unrecognized: `显式 policy 值不在 ${REVIEW_POLICIES.join("/")} 内——安全侧按 strict 处理`,
};

/**
 * 解析目标应走的评审策略（单一可单测入口）。
 *
 * 规则（自上而下）：
 * - 基础策略：显式 `review.policy` 命中三值 → 用它（source=explicit）；未配置/空 → 按类型派生
 *   （source=type_default）；显式值非三值 → `strict` 兜底（source=type_default）。
 * - 升级闭集 M1–M4：命中**任一**即 `policy="strict"`，对显式 `auto`/`none` 同样生效——
 *   这是「显式声明不得推翻安全侧」的落点，也是本目标自洽代价的来源（本目标改 core/schema.ts）。
 * - 未提供 `changedPaths` / `productChangedLines` 时相应触发条件视为「不命中」——它们只用于
 *   **升级**，缺失不会把 strict 降级为 auto；真正的放行判定在 `evaluateFastTrackGate`（fail-safe）。
 */
export function resolveReviewPolicy(input: ReviewPolicyInput = {}): ReviewPolicyDecision {
  const reasons: StrictReason[] = [];
  const explicit = normalizeReviewPolicy(input.policy);
  let base: ReviewPolicy;
  let source: "explicit" | "type_default";

  if (isUnrecognizedReviewPolicy(input.policy)) {
    base = "strict";
    source = "type_default";
    reasons.push("policy_unrecognized");
  } else if (explicit !== null) {
    base = explicit;
    source = "explicit";
    if (explicit === "strict") reasons.push("type_or_policy_strict");
  } else {
    base = typeDefaultReviewPolicy(input.type);
    source = "type_default";
    if (base === "strict") reasons.push("type_or_policy_strict");
  }

  const paths = normalizePaths(input.changedPaths);
  if (paths.some(isContractPath)) reasons.push("contract_change");
  const lines = normalizeLines(input.productChangedLines);
  if (lines !== null && lines >= FAST_TRACK_MAX_PRODUCT_LINES) reasons.push("product_size");
  if (regionsOfPaths(paths).length >= 3) reasons.push("cross_region");
  if (input.strictRequired === true) reasons.push("declared_strict");

  const strictReasons = STRICT_REASONS.filter((r) => reasons.includes(r));
  const policy: ReviewPolicy = strictReasons.length > 0 ? "strict" : base;
  return {
    policy,
    source,
    strictReasons,
    reasons: strictReasons.map((r) => STRICT_REASON_TEXT[r]),
  };
}

// ---------------------------------------------------------------------------
// 产品代码口径（门禁 ③ 的「可执行定义」，替代散文口径）
// ---------------------------------------------------------------------------

/**
 * `git diff --numstat` 口径下该路径是否计入**产品代码**行数。
 * 排除：`core/tests/**`、`*.md`、生成物（`dist/`、`core-dist/`、锁文件）与 worktree 副本。
 */
export function isProductCodePath(path: string): boolean {
  const p = String(path ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (p === "") return false;
  if ((NON_PRODUCT_EXACT as readonly string[]).includes(p)) return false;
  if (NON_PRODUCT_PREFIXES.some((prefix) => p.startsWith(prefix))) return false;
  if (p.toLowerCase().endsWith(".md")) return false;
  return true;
}

export interface ProductLineCount {
  /** 计入产品代码的增删合计。 */
  lines: number;
  /** 计入的文件（有序，去重）。 */
  files: string[];
  /** 被口径排除的文件。 */
  skipped: string[];
}

/**
 * 解析 `git diff --numstat <baseline> HEAD` 输出，按产品代码口径汇总增删行数。
 * 二进制行（`-\t-\t<path>`）计入文件但贡献 0 行；无法解析的行按 0 行计入其路径
 * （fail-safe：宁可少算行数也要如实列出文件，避免静默丢弃变更）。
 */
export function countProductChangedLines(numstat: string): ProductLineCount {
  const files: string[] = [];
  const skipped: string[] = [];
  let lines = 0;
  for (const raw of String(numstat ?? "").split("\n")) {
    const row = raw.trim();
    if (row === "") continue;
    const parts = row.split("\t");
    if (parts.length < 3) continue;
    const path = parts.slice(2).join("\t").trim();
    if (path === "") continue;
    if (!isProductCodePath(path)) {
      skipped.push(path);
      continue;
    }
    files.push(path);
    const added = /^\d+$/.test(parts[0]) ? Number(parts[0]) : 0;
    const deleted = /^\d+$/.test(parts[1]) ? Number(parts[1]) : 0;
    lines += added + deleted;
  }
  return { lines, files: [...new Set(files)], skipped: [...new Set(skipped)] };
}

// ---------------------------------------------------------------------------
// 机器快速放行门禁（四项，fail-safe）
// ---------------------------------------------------------------------------

/** 归一化后的机器证据（取不到的信号一律为 null / 空数组，绝不猜值）。 */
export interface FastTrackEvidence {
  baseline_commit: string | null;
  changed_paths: string[];
  product_changed_lines: number | null;
  untracked_files: number | null;
  tests_exit_code: number | null;
  tests_fail: number | null;
  typecheck_exit_code: number | null;
  criteria_all_verified: boolean | null;
}

export interface FastTrackCheck {
  id: FastTrackCheckId;
  /** 该门禁是否满足；**取不到信号即为 false**。 */
  ok: boolean;
  /** 证据摘要或不满足的具体原因。 */
  detail: string;
}

export interface FastTrackGateResult {
  /** 四项全绿才为 true。 */
  allowed: boolean;
  checks: FastTrackCheck[];
  evidence: FastTrackEvidence;
  /** 未满足的门禁 id（fail-safe：信号缺失同样计入）。 */
  failed: FastTrackCheckId[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return value;
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 把不可信的 `machine_report` 归一化为证据；结构不符的字段一律为 null（不抛错、不猜值）。 */
export function normalizeMachineReport(report: unknown): FastTrackEvidence {
  const r = asRecord(report);
  const tests = asRecord(r?.tests);
  const typecheck = asRecord(r?.typecheck);
  const criteria = asRecord(r?.criteria);
  const paths = normalizePaths(Array.isArray(r?.changed_paths) ? (r!.changed_paths as unknown[]) : null);
  return {
    baseline_commit: asString(r?.baseline_commit),
    changed_paths: paths,
    product_changed_lines: asInt(r?.product_changed_lines),
    untracked_files: asInt(r?.untracked_files),
    tests_exit_code: asInt(tests?.exit_code),
    tests_fail: asInt(tests?.fail),
    typecheck_exit_code: asInt(typecheck?.exit_code),
    criteria_all_verified: typeof criteria?.all_verified === "boolean" ? criteria.all_verified : null,
  };
}

const NO_SIGNAL = "机器报告缺少该信号（fail-safe：取不到即不放行）";

/**
 * 判定机器快速放行门禁四项（可执行命令见指南「分级评审与机器快速放行」）：
 * ① 全量测试：`node --test core/tests/*.test.ts` → `exit_code === 0` **且** `fail === 0`（双条件）；
 * ② 类型检查：`tsc --noEmit -p tsconfig.json` → `exit_code === 0`（**仅覆盖 core 层**，缺口已在指南如实标注）；
 * ③ 变更规模：`git diff --numstat <baseline_commit> HEAD` 产品代码增删合计 < 150，
 *    且 `baseline_commit` 非空、`untracked_files === 0`（未跟踪新文件不计入 numstat，须先提交）；
 * ④ 判据已验：`criteria.all_verified === true`（由调用方以 `allCriteriaVerified(goal.md)` 的
 *    **权威结果**填入，绝不采信调用方自报的其它值）。
 *
 * 任一项信号缺失 → 该项 `ok=false`（fail-safe），`allowed=false`。
 */
export function evaluateFastTrackGate(report: unknown): FastTrackGateResult {
  const e = normalizeMachineReport(report);
  const checks: FastTrackCheck[] = [];

  const testsOk = e.tests_exit_code === 0 && e.tests_fail === 0;
  checks.push({
    id: "tests",
    ok: testsOk,
    detail:
      e.tests_exit_code === null || e.tests_fail === null
        ? `① 全量测试：${NO_SIGNAL}`
        : `① node --test core/tests/*.test.ts → exit_code=${e.tests_exit_code}, fail=${e.tests_fail}（要求 exit_code=0 且 fail=0）`,
  });

  const typecheckOk = e.typecheck_exit_code === 0;
  checks.push({
    id: "typecheck",
    ok: typecheckOk,
    detail:
      e.typecheck_exit_code === null
        ? `② 类型检查：${NO_SIGNAL}`
        : `② ./node_modules/.bin/tsc --noEmit -p tsconfig.json → exit_code=${e.typecheck_exit_code}（要求 0；仅覆盖 core 层）`,
  });

  const sizeOk =
    e.baseline_commit !== null &&
    e.product_changed_lines !== null &&
    e.product_changed_lines < FAST_TRACK_MAX_PRODUCT_LINES &&
    e.untracked_files === 0;
  checks.push({
    id: "diff_size",
    ok: sizeOk,
    detail:
      e.baseline_commit === null
        ? `③ 变更规模：${NO_SIGNAL}（baseline_commit 必填）`
        : e.product_changed_lines === null
          ? `③ 变更规模：${NO_SIGNAL}（product_changed_lines 必填）`
          : e.untracked_files === null
            ? `③ 变更规模：${NO_SIGNAL}（untracked_files 必填：未跟踪新文件不计入 numstat）`
            : `③ git diff --numstat ${e.baseline_commit} HEAD → 产品代码 ${e.product_changed_lines} 行（要求 < ${FAST_TRACK_MAX_PRODUCT_LINES}），未跟踪新文件 ${e.untracked_files} 个（要求 0）`,
  });

  const criteriaOk = e.criteria_all_verified === true;
  checks.push({
    id: "criteria_verified",
    ok: criteriaOk,
    detail:
      e.criteria_all_verified === null
        ? `④ 判据已验：${NO_SIGNAL}`
        : `④ 全部判据文本以 ✅已验 结尾 → ${e.criteria_all_verified}`,
  });

  const failed = checks.filter((c) => !c.ok).map((c) => c.id);
  return { allowed: failed.length === 0, checks, evidence: e, failed };
}
