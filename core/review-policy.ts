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

/** M1：默认契约路径（普适默认为空；本项目显式校准在 project.yaml 中登记）。 */
export const CONTRACT_PATHS = ["core/schema.ts", "schema/SCHEMA.md"] as const;
export const DEFAULT_CONTRACT_PATHS: readonly string[] = [];

/** M3 判定的默认顶层区域（普适默认，不含本仓库专属 core/dsh-graph-host 闭集）。 */
export const DEFAULT_REVIEW_REGIONS: readonly string[] = [
  "src",
  "lib",
  "app",
  "packages",
  "server",
  "client",
  "scripts",
  "tests",
] as const;

/** 旧版 M3 判定的顶层区域闭集（兼容保留，已 deprecated，请使用 DEFAULT_REVIEW_REGIONS 或项目配置）。 */
export const REVIEW_REGIONS = ["core", "dsh-graph-host", "lib/client", "prompts", "scripts"] as const;
export type ReviewRegion = string;

/** 默认产品代码排除前缀（通用口径，不含本仓库 core/tests 等专属条件；无尾随斜杠）。 */
export const DEFAULT_NON_PRODUCT_PREFIXES: readonly string[] = [
  "dist",
  "node_modules",
  ".worktrees",
] as const;

// ---------------------------------------------------------------------------
// g-442：三项列表字段的描述 + **引擎同源归一化**（读侧投影 / 引擎消费 / 写侧校验共用一条真源）
// ---------------------------------------------------------------------------

export type ReviewListFieldKey = "regions" | "contract_paths" | "non_product_prefixes";

/** 单个列表字段的约束与缺省值（缺省值即策略层生效值，未配置时使用）。 */
export interface ReviewListFieldSpec {
  key: ReviewListFieldKey;
  /** 是否允许显式空列表。`regions: []` **不允许**（无可评估区域 ⇒ fail-closed 升级 strict，不提供该入口）；
   *  `contract_paths: []` / `non_product_prefixes: []` 合法，且必须与「未配置(null)」区分。 */
  allowEmpty: boolean;
  /** 未配置时策略层采用的普适缺省值（同源常量，绝不另抄一份）。 */
  defaultValues: readonly string[];
}

const REGIONS_SPEC: ReviewListFieldSpec = { key: "regions", allowEmpty: false, defaultValues: DEFAULT_REVIEW_REGIONS };
const CONTRACT_PATHS_SPEC: ReviewListFieldSpec = { key: "contract_paths", allowEmpty: true, defaultValues: DEFAULT_CONTRACT_PATHS };
const NON_PRODUCT_PREFIXES_SPEC: ReviewListFieldSpec = { key: "non_product_prefixes", allowEmpty: true, defaultValues: DEFAULT_NON_PRODUCT_PREFIXES };

export const REVIEW_LIST_FIELDS: readonly ReviewListFieldSpec[] = [
  REGIONS_SPEC,
  CONTRACT_PATHS_SPEC,
  NON_PRODUCT_PREFIXES_SPEC,
] as const;

/**
 * 列表取值问题的**唯一诊断**（g-442 收口）：引擎判定、读侧归因、写侧拒绝理由共用这一条实现。
 * 任何一处都**不得**另立第二套「畸形」谓词（副本必然漂移：早期读侧只查「非数组/非字符串」，
 * 引擎却把空串/绝对路径/尾随斜杠/`..`/重复一并判畸形 ⇒ 读侧会把非法值渲染成合法生效态）。
 * 返回**首个**问题的定位（下标 + 类别 + 原始条目），合法返回 null。
 */
export type ConfigListProblemKind =
  | "not_array"
  | "not_string"
  | "empty_string"
  | "reserved_prefix"
  | "absolute_path"
  | "trailing_slash"
  | "dotdot_segment"
  | "duplicate";

export interface ConfigListProblem {
  /** 问题条目下标；`not_array`（整体不是列表）为 -1。 */
  index: number;
  kind: ConfigListProblemKind;
  /** 原始条目（供人读报错引用；`not_array` 为未定义）。 */
  item?: unknown;
}

export function diagnoseConfigList(list: unknown, allowTrailingSlash = false): ConfigListProblem | null {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) return { index: -1, kind: "not_array", item: list };
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (typeof item !== "string") return { index: i, kind: "not_string", item };
    const trimmed = item.trim();
    if (trimmed === "") return { index: i, kind: "empty_string", item };
    if (trimmed.startsWith("invalid:")) return { index: i, kind: "reserved_prefix", item };
    const norm = trimmed.replace(/\\/g, "/");
    if (norm.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) return { index: i, kind: "absolute_path", item };
    if (!allowTrailingSlash && norm.endsWith("/")) return { index: i, kind: "trailing_slash", item };
    const segments = norm.split("/");
    if (segments.includes("..")) return { index: i, kind: "dotdot_segment", item };
    const canonical = norm.replace(/^\.\//, "").replace(/\/+$/, "");
    if (seen.has(canonical)) return { index: i, kind: "duplicate", item };
    seen.add(canonical);
  }
  return null;
}

/** 校验传入的配置列表是否合法（**唯一谓词**：`diagnoseConfigList` 的布尔投影）。若为非法类型、含有非字符串、空串、绝对路径、..段、尾随斜杠或重复项，返回 false。 */
export function isMalformedConfigList(list: unknown, allowTrailingSlash = false): boolean {
  return diagnoseConfigList(list, allowTrailingSlash) !== null;
}

/** 列表字段取值来源：显式登记 / 未配置(缺省) / 字段畸形(fail-closed 空列表)。 */
export type ReviewListSource = "explicit" | "default" | "malformed";

/** 单字段的**引擎同源归一化**结果（`resolveReviewPolicy` 与读侧投影的唯一取值路径）。 */
export interface ReviewListResolution {
  /**
   * 引擎实际消费的列表——与交给匹配器（`regionOfPath`/`isContractPath`/`isProductCodePath`）的值**等价**：
   * 数组原样透出，仅剔除对匹配**毫无影响**的非字符串项（匹配器本身 `typeof === "string"` 过滤）。
   */
  value: readonly string[];
  source: ReviewListSource;
  /** 引擎判定「字段存在但不可判定」⇒ 安全升级 strict（`policy_unrecognized`）。 */
  malformed: boolean;
  /** 显式空列表但该字段不允许空（`regions`）⇒ 写侧拒收 + 引擎 `cross_region` 升级 strict。 */
  illegal_empty: boolean;
}

/**
 * **单一真源**：列表输入 → 引擎消费值 / 来源 / 畸形 / 非法空。
 * 引擎（`resolveReviewPolicy`）、读侧投影（`reviewEffectiveProjection`）、写侧校验都经此派生；
 * 任何「投影宣称生效、引擎却不这么用」的分歧在结构上不可能出现。
 */
export function resolveReviewListInput(
  spec: ReviewListFieldSpec,
  raw: unknown,
  opts: { sectionMalformed?: boolean } = {},
): ReviewListResolution {
  const sectionMalformed = opts.sectionMalformed === true;
  if (Array.isArray(raw)) {
    return {
      value: raw.filter((item): item is string => typeof item === "string"),
      source: "explicit",
      malformed: isMalformedConfigList(raw, false) || sectionMalformed,
      illegal_empty: !spec.allowEmpty && raw.length === 0,
    };
  }
  if (raw === null || raw === undefined) {
    // 字段不存在 = 合法未配置 ⇒ 缺省值；整段不可解析（sectionMalformed）同样回落缺省，但如实标畸形
    return { value: [...spec.defaultValues], source: "default", malformed: sectionMalformed, illegal_empty: false };
  }
  // 字段存在但取值不是列表 ⇒ fail-closed：引擎消费**空列表**（绝不冒充缺省值生效）
  return { value: [], source: "malformed", malformed: true, illegal_empty: false };
}

/** 列表字段的只读投影：引擎消费值 + 来源 + 畸形态 + 写侧约束。 */
export interface ReviewListEffective {
  /** 引擎实际消费的列表（与 `resolveReviewListInput().value` 同源同值）。 */
  value: string[];
  source: ReviewListSource;
  /** 字段存在但无法判定（畸形）—— UI 必须显示「非法/需修 project.yaml」且不可回填提交。 */
  malformed: boolean;
  /** 写侧是否允许显式空列表（`regions` 为 false）。 */
  allow_empty: boolean;
  /** 显式空列表但规格不允许（`regions: []`）⇒ UI 必须显示为非法，不得渲染成合法「显式空列表」。 */
  illegal_empty: boolean;
}

/** 三项列表字段的只读投影（设置面 GET/POST 与 graph_get_settings 同源下发）。 */
export function reviewEffectiveProjection(
  review: unknown,
): Record<ReviewListFieldKey, ReviewListEffective> {
  const rv = (review && typeof review === "object" ? review : {}) as Record<string, unknown>;
  const invalidRaw = rv.invalid_fields;
  const invalid = (invalidRaw && typeof invalidRaw === "object" ? invalidRaw : {}) as Record<string, unknown>;
  // 段级畸形（整档 YAML 不可解析 / review 段不是映射）⇒ 三个字段一并按畸形处理
  const sectionMalformed = Boolean(invalid.review);
  const out = {} as Record<ReviewListFieldKey, ReviewListEffective>;
  for (const spec of REVIEW_LIST_FIELDS) {
    const res = resolveReviewListInput(spec, rv[spec.key], { sectionMalformed });
    out[spec.key] = {
      value: [...res.value],
      source: res.source,
      // 读侧 invalid_fields 是本诊断的归因产物；取并集保证「元信息」与「投影」绝不互相打架
      malformed: res.malformed || Boolean(invalid[spec.key]),
      allow_empty: spec.allowEmpty,
      illegal_empty: res.illegal_empty,
    };
  }
  return out;
}

/** 判为 strict 的闭合原因集（固定顺序输出，便于断言与审计）。 */
export const STRICT_REASONS = [
  "contract_change", // M1 变更路径含契约文件
  "product_size", // M2 产品代码变更 ≥ FAST_TRACK_MAX_PRODUCT_LINES 行
  "cross_region", // M3 变更跨 ≥3 个顶层区域
  "declared_strict", // M4 supervisor 显式声明 strict_required
  "type_or_policy_strict", // M5 type ∈ {feature,bug}（或派生为 strict）或项目 policy=strict
  "policy_unrecognized", // 显式值非三值：读路径本应归一为「未配置」，此处安全侧兜底
  "unknown_region", // 产品代码落在未登记区域（追加在末尾，auto/none 也升级）
] as const;
export type StrictReason = (typeof STRICT_REASONS)[number];

/** 产品代码口径：这些前缀下的改动**不计入** `git diff --numstat` 行数（旧常量，兼容保留）。 */
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
export function normalizePolicyPath(p: unknown): string {
  if (typeof p !== "string") return "";
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 归一化路径列表。 */
function normalizePaths(raw: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const p = normalizePolicyPath(item);
    if (p !== "") out.push(p);
  }
  return out;
}

/** 检查路径是否命中某个区域前缀（完整目录段边界匹配，或完全相等）。 */
export function matchRegionSegment(path: string, region: string): boolean {
  const normPath = normalizePolicyPath(path).replace(/\\/g, "/");
  const normReg = normalizePolicyPath(region).replace(/\/+$/, "").replace(/\\/g, "/");
  if (!normPath || !normReg) return false;
  if (normPath === normReg) return true;
  return normPath.startsWith(normReg + "/");
}

/** 该路径是否命中契约路径（M1）。可传入项目配置的 contract_paths，缺省使用普适默认 DEFAULT_CONTRACT_PATHS（[]）。 */
export function isContractPath(path: string, contractPaths?: readonly string[] | null): boolean {
  const p = normalizePolicyPath(path);
  if (!p) return false;
  const paths = contractPaths !== undefined && contractPaths !== null ? contractPaths : DEFAULT_CONTRACT_PATHS;
  return paths.some((cp) => normalizePolicyPath(cp) === p);
}

/**
 * 路径 → 顶层区域；未登记区域返回 null。
 * 规则：最长前缀优先；同长度按配置顺序；完整段边界。
 * 缺省使用普适默认 DEFAULT_REVIEW_REGIONS。
 */
export function regionOfPath(path: string, configuredRegions?: readonly string[] | null): ReviewRegion | null {
  const p = normalizePolicyPath(path);
  if (!p) return null;
  const regions = Array.isArray(configuredRegions)
    ? configuredRegions
    : configuredRegions === null || configuredRegions === undefined
      ? DEFAULT_REVIEW_REGIONS
      : [];

  // 筛选出所有匹配的区域
  const matched = regions.filter((r) => typeof r === "string" && matchRegionSegment(p, r));
  if (matched.length === 0) return null;
  if (matched.length === 1) return matched[0];

  // 最长前缀优先；同长度保留原配置顺序（稳定的 sort）
  let best = matched[0];
  let bestLen = normalizePolicyPath(best).replace(/\/+$/, "").length;
  for (let i = 1; i < matched.length; i++) {
    const r = matched[i];
    const len = normalizePolicyPath(r).replace(/\/+$/, "").length;
    if (len > bestLen) {
      best = r;
      bestLen = len;
    }
  }
  return best;
}

/** 变更路径覆盖的顶层区域集合（按配置顺序，去重）。缺省使用普适默认 DEFAULT_REVIEW_REGIONS。 */
export function regionsOfPaths(paths: readonly string[], configuredRegions?: readonly string[] | null): ReviewRegion[] {
  const regions = Array.isArray(configuredRegions)
    ? configuredRegions
    : configuredRegions === null || configuredRegions === undefined
      ? DEFAULT_REVIEW_REGIONS
      : [];
  const seen = new Set<ReviewRegion>();
  for (const p of paths) {
    const r = regionOfPath(p, regions);
    if (r) seen.add(r);
  }
  return regions.filter((r) => seen.has(r));
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
  /**
   * 项目自定义的区域列表：`string[]`（合法）/ `null`（未配置）/**其它原始值（字段存在但无法判定 ⇒ 畸形）**。
   * 读侧畸形时**原样透出文件取值**（绝不使用 `invalid:*` 内部哨兵），此处统一按 `unknown` 接收，
   * 由 `isMalformedConfigList` fail-closed 判为畸形 → 安全升级 strict（g-435 F1/F2）。
   */
  regions?: unknown;
  /** 项目自定义的契约路径列表（同上：合法 string[] / 未配置 null / 其它原始值 ⇒ 畸形）。 */
  contractPaths?: unknown;
  /** 项目自定义的产品排除前缀列表（同上：合法 string[] / 未配置 null / 其它原始值 ⇒ 畸形）。 */
  nonProductPrefixes?: unknown;
  /** 外部配置解析是否出现结构/格式损坏（整档 YAML 损坏或 review 结构无法解析），损坏时 fail-closed。 */
  configMalformed?: boolean;
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

export function formatStrictReasonText(
  reason: StrictReason,
  effectiveContractPaths?: readonly string[],
): string {
  switch (reason) {
    case "contract_change": {
      const paths = effectiveContractPaths && effectiveContractPaths.length > 0
        ? effectiveContractPaths.join(" / ")
        : CONTRACT_PATHS.join(" / ");
      return `M1 变更路径含契约文件（${paths}）——契约冻结必须独立评审`;
    }
    case "product_size":
      return `M2 产品代码变更 ≥ ${FAST_TRACK_MAX_PRODUCT_LINES} 行——超出快速通道安全阈值`;
    case "cross_region":
      return "M3 变更跨 ≥3 个顶层区域——跨模块改动必须独立评审";
    case "declared_strict":
      return "M4 supervisor 显式声明 strict_required（核心层重写等）";
    case "type_or_policy_strict":
      return "M5 目标类型（feature/bug 等）或项目 policy 本身要求 strict";
    case "policy_unrecognized":
      return `显式配置不合法（非允许值或非法路径列表）——安全侧按 strict 处理`;
    case "unknown_region":
      return "产品代码变更落在未登记区域——安全升级为 strict";
  }
}

/**
 * 解析目标应走的评审策略（单一可单测入口）。
 */
export function resolveReviewPolicy(input: ReviewPolicyInput = {}): ReviewPolicyDecision {
  const reasons: StrictReason[] = [];
  const explicit = normalizeReviewPolicy(input.policy);
  let base: ReviewPolicy;
  let source: "explicit" | "type_default";

  // 三项列表的**唯一归一化**：引擎消费值 / 畸形 / 非法空全部由 resolveReviewListInput 派生
  //（与读侧投影、写侧校验同一条真源；此处不再自持谓词或 fallback 分支）。
  const regionsInput = resolveReviewListInput(REGIONS_SPEC, input.regions);
  const contractPathsInput = resolveReviewListInput(CONTRACT_PATHS_SPEC, input.contractPaths);
  const nonProductPrefixesInput = resolveReviewListInput(NON_PRODUCT_PREFIXES_SPEC, input.nonProductPrefixes);

  // 检查是否有非法配置输入（非法输入安全升级为 strict，policy_unrecognized）
  const hasMalformedConfig =
    input.configMalformed === true ||
    isUnrecognizedReviewPolicy(input.policy) ||
    regionsInput.malformed ||
    contractPathsInput.malformed ||
    nonProductPrefixesInput.malformed;

  if (hasMalformedConfig) {
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

  // 三项列表的生效值 = 上面那条归一化的结果（引擎与投影**同源同值**）
  const effectiveContractPaths = contractPathsInput.value;
  const effectiveRegions = regionsInput.value;
  const effectiveNonProductPrefixes = nonProductPrefixesInput.value;

  // 规则 5：regions 为显式空列表 [] 时无可评估区域，fail-closed 安全升级 strict
  if (regionsInput.illegal_empty) {
    reasons.push("cross_region");
  }

  const paths = normalizePaths(input.changedPaths);
  if (paths.some((p) => isContractPath(p, effectiveContractPaths))) {
    reasons.push("contract_change");
  }
  const lines = normalizeLines(input.productChangedLines);
  if (lines !== null && lines >= FAST_TRACK_MAX_PRODUCT_LINES) {
    reasons.push("product_size");
  }
  // 负责人裁决：M3 跨区域判定只计产品代码覆盖的区域，纯文档/生成物不计入 M3
  const productPaths = paths.filter((p) => isProductCodePath(p, effectiveNonProductPrefixes));
  if (regionsOfPaths(productPaths, effectiveRegions).length >= 3) {
    reasons.push("cross_region");
  }
  if (input.strictRequired === true) {
    reasons.push("declared_strict");
  }

  // unknown_region 判定：仅当提供了 changedPaths 时评估产品代码文件
  // 若包含非契约产品代码且未匹配到任何登记区域，追加 unknown_region（排在 STRICT_REASONS 末尾）
  if (input.changedPaths !== undefined && input.changedPaths !== null && paths.length > 0) {
    const hasUnknown = paths.some((p) => {
      if (isContractPath(p, effectiveContractPaths)) return false; // 契约路径已有 M1 专门负责，不作为未知区域产品码
      if (!isProductCodePath(p, effectiveNonProductPrefixes)) return false; // 非产品代码（文档、生成物等）中性
      return regionOfPath(p, effectiveRegions) === null; // 产品代码未登记到任何区域
    });
    if (hasUnknown) {
      reasons.push("unknown_region");
    }
  }

  const strictReasons = STRICT_REASONS.filter((r) => reasons.includes(r));
  const policy: ReviewPolicy = strictReasons.length > 0 ? "strict" : base;
  return {
    policy,
    source,
    strictReasons,
    reasons: strictReasons.map((r) => formatStrictReasonText(r, effectiveContractPaths)),
  };
}

// ---------------------------------------------------------------------------
// 产品代码口径（门禁 ③ 的「可执行定义」，替代散文口径）
// ---------------------------------------------------------------------------

/**
 * `git diff --numstat` 口径下该路径是否计入**产品代码**行数。
 * 排除：`*.md`、通用生成物锁文件，以及配置的 nonProductPrefixes。
 */
export function isProductCodePath(
  path: string,
  nonProductPrefixes?: readonly string[] | null,
): boolean {
  const p = normalizePolicyPath(path).replace(/\\/g, "/");
  if (p === "") return false;
  if ((NON_PRODUCT_EXACT as readonly string[]).includes(p)) return false;
  const prefixes = nonProductPrefixes !== undefined && nonProductPrefixes !== null
    ? nonProductPrefixes
    : DEFAULT_NON_PRODUCT_PREFIXES;
  if (prefixes.some((prefix) => {
    const normPre = normalizePolicyPath(prefix).replace(/\/+$/, "").replace(/\\/g, "/");
    if (normPre === "") return false;
    // 完整段边界匹配：自身或子路径
    return p === normPre || p.startsWith(normPre + "/");
  })) {
    return false;
  }
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
export function countProductChangedLines(
  numstat: string,
  nonProductPrefixes?: readonly string[] | null,
): ProductLineCount {
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
    if (!isProductCodePath(path, nonProductPrefixes)) {
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
