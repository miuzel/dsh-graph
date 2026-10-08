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
 * 「strict 必须派发独立评审子代理」在本插件层仍是**判定 + 指南约束**（判定见本模块的
 * `resolveReviewPolicy`；可见化见 `core/ops.ts` 的 `goalReviewState`）——派发入口**已接线**
 * （g-436）：工具 `graph_start_review(goal, attempt, candidate_commit)` 与 HTTP
 * `POST /api/dsh-graph/start-review`（host `dispatchReview` 是 `formatReviewPrompt` 的唯一生产
 * 调用点）；评审是**既有执行 attempt 的附属记录**——不新建 attempt、不迁移状态、不覆盖作者
 * `results-att-*.md`，未派独立评审只做可见化标注、**不阻断** accept。`delivered` 仍只能经既有
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
  // g-437：契约路径的归一化同样只有一个实现（effectiveContractPathsOf）——此前这里是第四份
  // 内联三分支，非法标量会直接喂给 `.some()` 抛 TypeError。
  const paths = effectiveContractPathsOf(contractPaths);
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
  // g-437：区域列的归一化**只有一个实现**（effectiveReviewRegionsOf）——策略解析、门禁③分类与
  // 设置面投影都必须取同一份有效值，此处不再内联第二份「数组/未配置/其它」三分支。
  const regions = effectiveReviewRegionsOf(configuredRegions);

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
  // g-437：同 regionOfPath —— 单一归一化入口（effectiveReviewRegionsOf）。
  const regions = effectiveReviewRegionsOf(configuredRegions);
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

// ---------------------------------------------------------------------------
// g-437 → g-442：有效值的**唯一真源**是上面的 `resolveReviewListInput`。
//
// 本目标曾自带一份「数组 / 未配置 / 其它」三分支归一化（当时把散落在 `resolveReviewPolicy`、
// `regionOfPath`、`regionsOfPaths`、`isProductCodePath`、`isContractPath` 的默认点收敛到它）。
// g-442 合入后 `diagnoseConfigList` → `isMalformedConfigList` → `resolveReviewListInput` 成为
// 引擎（`resolveReviewPolicy`）、设置面投影（`reviewEffectiveProjection`）与写侧校验共用的**同一条链**
// ⇒ 这里**删掉本体、改为一行委托**：`effective*Of` 只保留导出名与既有调用面（门禁③采集、四个匹配器、
// 键控分发），与投影是同一条表达式的产物，结构上不可能再分叉。
//
// 委托语义（= 引擎真正遍历的值；实测 48 组中 6 组值差异全部为「剔除非字符串项」，分类决策 0 差异）：
//  - 合法数组（含内容畸形）⇒ 原样（仅剔除对匹配无影响的非字符串项）；
//  - `null` / `undefined`（未配置）⇒ 该字段缺省值（`source: "default"`）；
//  - 其它原始值（标量 / 映射…）⇒ `[]` 且 `malformed: true`（绝不冒充「未配置」套默认放行）。
//  - **畸形判定不在本函数内**：唯一谓词是 {@link isMalformedConfigList}（`diagnoseConfigList` 的布尔投影），
//    且**只看原始值**（`[""]` / `["core/"]` / `["../core"]` / `["core","core"]` 的有效值仍是原数组，
//    由策略层据此升级 `policy_unrecognized`）——有效值与畸形标记必须一起用，缺一即口径不全。
// ---------------------------------------------------------------------------

/** 三项列表字段的键（与 `project.yaml` 的 `review.<key>` 同名；= g-442 的 `ReviewListFieldKey`）。 */
export type ReviewListFieldName = ReviewListFieldKey;

/** 字段 → SPEC（只读映射；SPEC 表是 g-442 的唯一真源，此处不另抄任何默认值）。 */
const REVIEW_LIST_SPEC: Record<ReviewListFieldKey, ReviewListFieldSpec> = Object.fromEntries(
  REVIEW_LIST_FIELDS.map((spec) => [spec.key, spec]),
) as Record<ReviewListFieldKey, ReviewListFieldSpec>;

/** 有效契约路径（委托唯一归一化；语义见上）。 */
export function effectiveContractPathsOf(contractPaths?: unknown): readonly string[] {
  return resolveReviewListInput(REVIEW_LIST_SPEC.contract_paths, contractPaths).value;
}

/** 有效顶层区域列表（同 {@link effectiveContractPathsOf}）。 */
export function effectiveReviewRegionsOf(regions?: unknown): readonly string[] {
  return resolveReviewListInput(REVIEW_LIST_SPEC.regions, regions).value;
}

/** 有效产品码排除前缀（同 {@link effectiveContractPathsOf}）。 */
export function effectiveNonProductPrefixesOf(nonProductPrefixes?: unknown): readonly string[] {
  return resolveReviewListInput(REVIEW_LIST_SPEC.non_product_prefixes, nonProductPrefixes).value;
}

/**
 * 键控分发：`effectiveReviewListValue(key, raw)` ≡ 对应的 `effectiveXOf(raw)`。
 *
 * 供**投影/UI 等消费面**使用，避免它们各自再写一张「字段 → 默认值」表（与 g-442 同一条口径）。
 */
export function effectiveReviewListValue(field: ReviewListFieldName, raw: unknown): readonly string[] {
  switch (field) {
    case "regions": return effectiveReviewRegionsOf(raw);
    case "contract_paths": return effectiveContractPathsOf(raw);
    case "non_product_prefixes": return effectiveNonProductPrefixesOf(raw);
    default: return [];
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
  // g-437：产品码排除前缀的归一化同样只有一个实现（effectiveNonProductPrefixesOf）——
  // 门禁③的真源分类（summarizeProductLinesStrict）与策略层 M2/M3 必须取同一份有效值。
  const prefixes = effectiveNonProductPrefixesOf(nonProductPrefixes);
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
 *
 * **g-437：本函数是「非 `-z` 文本」的**遗留**解码器**（`parts.slice(2).join("\t")` 对
 * rename/引号路径会得到复合串，且非数字列静默计 0 —— 后者对 M2 是**放行方向**）。
 * `resolveAccept(fast_track=true)` 的门禁③**不再**使用它：真源用 {@link parseNumstatZ}
 * （NUL 分隔、rename 给两条路径）+ {@link summarizeProductLinesStrict}（解析不了即不放行）。
 * 保留本导出只为兼容既有调用方与断言，不得用于任何准入判定。
 */
export function countProductChangedLines(
  numstat: string,
  nonProductPrefixes?: readonly string[] | null,
): ProductLineCount {
  const entries: NumstatEntry[] = [];
  for (const raw of String(numstat ?? "").split("\n")) {
    const row = raw.trim();
    if (row === "") continue;
    const parts = row.split("\t");
    if (parts.length < 3) continue;
    const path = parts.slice(2).join("\t").trim();
    if (path === "") continue;
    entries.push({
      added: /^\d+$/.test(parts[0]) ? Number(parts[0]) : null,
      deleted: /^\d+$/.test(parts[1]) ? Number(parts[1]) : null,
      paths: [path],
    });
  }
  const strict = summarizeProductLinesStrict(entries, nonProductPrefixes);
  // 遗留语义：非数字列按 0 计（不计入 malformed），只回传 lines/files/skipped。
  return { lines: strict.lines, files: strict.files, skipped: strict.skipped };
}

// ---------------------------------------------------------------------------
// g-437：门禁③的 Git 真源解码（NUL 输出 + 严格计数）
//
// 为什么必须换解码器：
//  1. `git diff --numstat -z` 对 rename/copy 给出**两条**路径（旧/新），而非 `old => new`
//     复合串；按复合串做产品码分类会分类错，契约匹配也看不到旧路径（M1 漏判）。
//  2. 路径可能含制表符/空格/非 ASCII：`-z` 不做引号化，按 `\t` 切列后第 3 列起原样拼接，
//     不 trim、不按换行解析。
//  3. 非数字列（二进制 `-`）**不得静默计 0** —— 对「≥150 行即 strict」的 M2 那是放行方向。
//     严格口径下解析不了即进 `malformed`，由调用方**拒绝** fast_track。
// ---------------------------------------------------------------------------

/** `git diff --numstat -z` 的单条记录。 */
export interface NumstatEntry {
  /** `null` = 该列不是十进制数字（二进制 `-` 或不可解析）⇒ 严格口径下不放行。 */
  added: number | null;
  deleted: number | null;
  /** 涉及的仓库相对路径：普通记录 1 条；rename/copy 为 `[旧, 新]`（两条都参与分类与契约匹配）。 */
  paths: string[];
}

export interface NumstatParseResult {
  entries: NumstatEntry[];
  /** 不可解析记录的原因（空数组 = 全部可解析）。 */
  malformed: string[];
}

const describePath = (p: string) => (p.length > 120 ? `${p.slice(0, 117)}…` : p);

/**
 * 解析 `git diff --numstat -z` 输出（NUL 分隔，**绝不 trim、绝不按换行切分**）。
 * 记录形态：`<added>\t<deleted>\t<path>\0`；rename/copy：`<added>\t<deleted>\t\0<old>\0<new>\0`。
 */
export function parseNumstatZ(out: string): NumstatParseResult {
  const entries: NumstatEntry[] = [];
  const malformed: string[] = [];
  const tokens = String(out ?? "").split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const parts = token.split("\t");
    if (parts.length < 3) {
      malformed.push(`numstat 记录字段不足（应为 3 列）：${describePath(token)}`);
      continue;
    }
    const inlinePath = parts.slice(2).join("\t");
    let paths: string[];
    if (inlinePath === "") {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath === undefined || newPath === undefined) {
        malformed.push("numstat rename/copy 记录缺少旧/新路径");
        break;
      }
      i += 2;
      paths = [oldPath, newPath];
    } else {
      paths = [inlinePath];
    }
    if (paths.some((p) => p === "")) {
      malformed.push(`numstat 记录含空路径：${describePath(token)}`);
      continue;
    }
    entries.push({
      added: /^\d+$/.test(parts[0]) ? Number(parts[0]) : null,
      deleted: /^\d+$/.test(parts[1]) ? Number(parts[1]) : null,
      paths,
    });
  }
  return { entries, malformed };
}

/** 严格计数结果：`malformed` 非空 ⇒ 调用方必须拒绝放行（绝不当作 0 行）。 */
export interface StrictProductLineCount extends ProductLineCount {
  malformed: string[];
}

/**
 * 按产品代码口径汇总 numstat 记录。**分类看两条路径**（rename/copy 的旧新都参与
 * 「产品码 / 非产品码」与契约匹配），但**行数按记录只计一次**（同一记录的两条路径不是两次改动，
 * 重复计会让 rename+edit 的行数翻倍）。非数字列计入 `malformed`（不静默计 0）。
 */
export function summarizeProductLinesStrict(
  entries: readonly NumstatEntry[],
  nonProductPrefixes?: readonly string[] | null,
): StrictProductLineCount {
  const files: string[] = [];
  const skipped: string[] = [];
  const malformed: string[] = [];
  let lines = 0;
  for (const e of entries) {
    let touchesProduct = false;
    for (const p of e.paths) {
      if (isProductCodePath(p, nonProductPrefixes)) {
        files.push(p);
        touchesProduct = true;
      } else {
        skipped.push(p);
      }
    }
    if (e.added === null || e.deleted === null) {
      malformed.push(`numstat 非数字列（二进制或不可解析，不得计 0）：${e.paths.map(describePath).join(" / ")}`);
      continue;
    }
    if (touchesProduct) lines += e.added + e.deleted;
  }
  return { lines, files: [...new Set(files)], skipped: [...new Set(skipped)], malformed };
}

/** `git status --porcelain=v1 -z` 的单条记录。 */
export interface PorcelainEntry {
  /** 两字符状态码（`??` = 未跟踪）。 */
  status: string;
  /** 普通记录 1 条；rename/copy 为 `[新, 旧]`（git 的 `-z` 顺序）。 */
  paths: string[];
}

export interface PorcelainParseResult {
  entries: PorcelainEntry[];
  malformed: string[];
}

/**
 * 解析 `git status --porcelain=v1 -z --untracked-files=all` 输出。
 * 记录形态：`XY <path>\0`；rename/copy：`XY <new>\0<old>\0`（第二路径不得当独立状态记录）。
 */
export function parsePorcelainZ(out: string): PorcelainParseResult {
  const entries: PorcelainEntry[] = [];
  const malformed: string[] = [];
  const tokens = String(out ?? "").split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 3 || token[2] !== " ") {
      malformed.push(`status 记录形态非法（应形如 "XY <path>"）：${describePath(token)}`);
      continue;
    }
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (path === "") {
      malformed.push(`status 记录含空路径：${describePath(token)}`);
      continue;
    }
    const paths = [path];
    const renaming = status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C";
    if (renaming) {
      const other = tokens[i + 1];
      if (other === undefined) {
        malformed.push("status rename/copy 记录缺少原路径");
        break;
      }
      i += 1;
      paths.push(other);
    }
    entries.push({ status, paths });
  }
  return { entries, malformed };
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

// ---------------------------------------------------------------------------
// g-437：报告 ↔ Git 真源对账（纯函数，零 IO）
// ---------------------------------------------------------------------------

/** 引擎从实际 attempt 树采集到的门禁③真源事实（路径一律 repo-root-relative）。 */
export interface GitTruthFacts {
  changed_paths: string[];
  product_changed_lines: number;
  untracked_files: number;
}

const sortedNormalized = (paths: readonly string[]): string[] =>
  [...new Set(paths.map((p) => normalizePolicyPath(p)).filter((p) => p !== ""))].sort();

/**
 * 把调用方报告的门禁③值与引擎 Git 真源逐项对账，返回不一致项（空数组 = 一致）。
 *
 * 口径为**集合相等**（不是子集）：报告漏报会藏起契约路径/未知区域（M1/M3 漏判），
 * 多报则说明报告与真源不同源。任何一项不一致都必须拒绝放行。
 */
export function reconcileMachineReportWithGitTruth(
  evidence: FastTrackEvidence,
  truth: GitTruthFacts,
): string[] {
  const problems: string[] = [];
  const reportPaths = sortedNormalized(evidence.changed_paths);
  const truthPaths = sortedNormalized(truth.changed_paths);
  if (reportPaths.join("\n") !== truthPaths.join("\n")) {
    const missing = truthPaths.filter((p) => !reportPaths.includes(p));
    const extra = reportPaths.filter((p) => !truthPaths.includes(p));
    problems.push(
      `changed_paths 与 Git 真源不一致（引擎 ${truthPaths.length} 条 / 报告 ${reportPaths.length} 条` +
        `${missing.length ? `；报告漏报：${missing.slice(0, 5).map(describePath).join(" / ")}` : ""}` +
        `${extra.length ? `；报告多报：${extra.slice(0, 5).map(describePath).join(" / ")}` : ""}）`,
    );
  }
  if (evidence.product_changed_lines !== truth.product_changed_lines) {
    problems.push(
      `product_changed_lines 与 Git 真源不一致（引擎 ${truth.product_changed_lines} / 报告 ${
        evidence.product_changed_lines === null ? "缺失" : evidence.product_changed_lines
      }）`,
    );
  }
  if (evidence.untracked_files !== truth.untracked_files) {
    problems.push(
      `untracked_files 与 Git 真源不一致（引擎 ${truth.untracked_files} / 报告 ${
        evidence.untracked_files === null ? "缺失" : evidence.untracked_files
      }）`,
    );
  }
  return problems;
}

