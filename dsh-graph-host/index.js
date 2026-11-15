/**
 * dsh-graph-host：单包双半（g-116 合并）——把 dsh-graph 核心层包装为 DSH cordis 插件。
 * npm 包名 = dsh-graph（负责人定案，g-116 命名更正）；内部 host 插件 id 保留 dsh-graph-host。
 *
 * 本包同时承载原 dsh-graph-host（graph_* 工具 + skill）与 dsh-graph-client
 * （/api/dsh-graph* REST 端点）两个半边，浏览器看板（lib/client.js，经 dsh.client
 * 声明 + exports["./client"] 加载进 conversation.view 槽）同包分发。
 *
 * 约定（实机验证的坑，docs/plugin-loading-recipe.md）：
 * - 具名导出 name/inject/apply，禁止 export default；
 * - 运行时零 @deepseek-ai/* import（类型只用 import type）；
 * - 副作用收进 ctx.effect。
 */
import { writeFileSync, readFileSync, realpathSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { relative, join, resolve, dirname, basename, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// rc.1 exposes enumeration; rc.3 exposes only named provider lookup.
export function probeContinuableProvider(subagents) {
  if (typeof subagents?.getProvider !== "function") return { provider: null, error: "无法确认 subagent provider：getProvider API 不可用" };
  let names;
  const enumerable = typeof subagents.list === "function";
  try {
    names = enumerable ? subagents.list() : ["spawn", "fork"];
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) throw new Error("list 返回非字符串数组");
    for (const name of names) {
      if (typeof subagents.getProvider(name)?.prepareContinuable === "function") return { provider: name, error: null };
    }
  } catch (error) {
    return { provider: null, error: `无法确认 subagent provider：查询异常（${String(error?.message ?? error)}）` };
  }
  if (!enumerable) return { provider: null, error: "无可用默认 subagent provider（已查询 spawn、fork；自定义 provider 无法枚举）" };
  return { provider: null, error: `无可用 subagent provider（需 prepareContinuable 能力，已注册：${names.join(",") || "无"}）` };
}
// g-454：读旧 settings.yaml 的 `dsh-graph` 节。`yaml` 是本包**已声明**的运行时依赖
// （package.json dependencies；core/ops.ts 早已在加载期 import 它，故非新增第三方依赖）。
import { parse as parseYaml } from "yaml";
import {
  createGoal,
  // g-618：纪律资产读取（公共层 `prompts/care-discipline.*.md`）。host 经 ops 取同一实现，
  // 缺资产时由 core 的 `resolveCareDisciplineText` **fail-open**，绝不中断巡检（g-346 教训）。
  readCorePromptAsset,
  normalizeGoalType,
  setCriteria,
  updateCriteria,
  setGoalTags,
  setGoalBudget,
  transition,
  validate,
  rebuild,
  addCard,
  deleteCard,
  fillCard,
  reviewCard,
  startAttempt,
  assertExecutionAdmission,
  ensureExecutionInProgress,
  defaultWorktreeForGoalType,
  detectWorkspaceCleanliness,
  resolveWorktreeIsolationDecision,
  prepareAttemptWorktree,
  // g-437 P1：非隔离 attempt 的引擎侧区间锚点（派发时的仓库 HEAD）
  readRepoHead,
  reportStatus,
  reportSupervisorStatus,
  readSupervisorStatus,
  readSupervisorStatusAt,
  generateHandoff,
  claimSupervisor,
  bindAttemptChild,
  settleAttemptDispatchInFlight,
  assertNoActiveExecutionChild,
  withLocalLock,
  moveGoal,
  amendGoal,
  // g-379：目标间关系（覆盖/调整/补充）写入/解除 + 单目标关系视图
  addRelation,
  removeRelation,
  goalRelationViews,
  // g-380：关系工具的入参闭集与写入前环探测（环检测复用 core 唯一 DFS，host 侧不另造实现）
  RELATIONS_FIELD_TYPES,
  dependsOnNotInRelationsError,
  relationCycleProblem,
  renameGoal,
  setGoalType,
  addMemory,
  replaceMemory,
  removeMemory,
  readMemory,
  recallMemory,
  isMemoryToolsEnabled,
  setMemoryToolsEnabled,
  formatStandingMemorySection,
  requestAcceptReview,
  resolveAccept,
  archiveGoal,
  unarchiveGoal,
  deleteGoal,
  postponeGoal,
  boardProjection,
  compareVersions,
  readSupervisorSession,
  readExecutorModel,
  findGoalFile,
  init,
  boardPayload,
  goalDetail,
  loadGoal,
  bindCardChild,
  assertCollectAdmission,
  harvestedCards,
  formatHarvestedCardsSection,
  formatCollectPrompt,
  createSharedCard,
  addSharedCardRef,
  deleteSharedCard,
  removeSharedCardRef,
  detachSharedCardRef,
  convertOwnedToShared,
  convertSharedToOwned,
  sharedCards,
  referenceCount,
  referencingGoals,
  storeAttachment,
  listAttachments,
  deleteAttachment,
  parseAttachmentRefs,
  attachmentInfo,
  readAttachment,
  attachmentContentType,
  MAX_ATTACHMENT_BYTES,
  attachmentsDir,
  sanitizeAttachmentPath,
  formatAttachmentRef,
  recordAttemptHandoff,
  harvestReviewedAttemptHandoffs,
  formatReviewedAttemptHandoffsSection,
  readGoalDirective,
  setGoalDirective,
  setGoalDescription,
  sectionText,
  readGoalComments,
  appendGoalComment,
  GraphError,
  GraphConflictError,
  createVersion,
  renameVersion,
  deleteVersion,
  releaseVersion,
  setVersionStatus,
  validateVersionRelease,
  versionDetail,
  resolveModelRoute,
  resolveSubagentPrompt,
  extractAgentTeamsContract,
  resolveAgentTeamsInjection,
  readProjectConfig,
  writeProjectConfig,
  // g-480：harness 模块可选开关（唯一映射表 + 纯判定函数都在 core，宿主不另抄一份字面量）
  HARNESS_MODULE_IDS,
  MODULE_TOOL_NAMES,
  moduleToolNames,
  resolveModuleSwitches,
  disabledModuleTools,
  stripModuleToolMentions,
  // g-480：角色档案自适应（模块关 ⇒ 该模块工具不再算必需/可用）的**唯一真源**在 core，
  // 这里只消费它算出的「受影响角色清单」用于 schema_hints 如实登记。
  rolesAdaptedByModule,
  REVIEW_POLICIES,
  REVIEW_LIST_FIELDS,
  DEFAULT_REVIEW_REGIONS,
  DEFAULT_CONTRACT_PATHS,
  DEFAULT_NON_PRODUCT_PREFIXES,
  listWorktrees,
  cleanWorktree,
  SUBAGENT_MODES,
  SUBAGENT_MODE_SPECS,
  DEFAULT_SUBAGENT_MODE,
  normalizeSubagentMode,
  SUBAGENT_MODE_PROMPTS,
  resolveSubagentMode,
  subagentSpawnErrorText,
  normalizeSubagentRole,
  toolFilterForRole,
  // g-473：harness 工具名依赖收口（shell 名按宿主探针解析 / 白名单求交 / 缺能力诊断且不派发）
  resolveShellTool,
  diagnoseDispatchCapability,
  appendDispatchCapabilityMissing,
  // g-613：复用已有子代理承接新目标（跨目标独占的只读扫描 + 复用/投递事件 + 持锁绑定变体）。
  bindAttemptChildLocked,
  findActiveExecutionBindings,
  appendAttemptReused,
  appendAttemptReuseFailed,
  formatPmPrompt,
  // g-436：独立评审接线（formatReviewPrompt 的**唯一生产调用点**在本文件的 dispatchReview；
  // 此前它是 core 侧零调用点的孤立实现。接线由 g-436 完成，相应前置守卫见
  // core/tests/role-contract-g253.test.ts 的「接线已完成」断言）。
  formatReviewPrompt,
  appendReviewDispatch,
  appendReviewReused,
  bindReviewChild,
  settleReview,
  failReviewDispatch,
  reviewRecordViews,
  goalReviewState,
  assertNotReviewerIdentity,
  formatSummaryPrompt,
  formatAttemptReportSkeleton,
  goalResultsDigest,
  renderGoalResultsDigest,
  validateSchema,
  schemaErrorResponse,
  settingsPostSchema,
  unbindPostSchema,
  unbindGoalChild,
  authorizeSharedCardLink,
  abandonAttemptPostSchema,
  abandonAttempt,
  getCachedBoardPayload,
  writeAttemptResults,
  refreshGoalResults,
  goalResultsSummaryFile,
  goalResultsCacheState,
  ATTEMPT_RESULTS_MAX_BYTES,
  versionGoals,
  backlogGoals,
  matchIfNoneMatch,
  invalidateBoardCache,
  closeWatchers,
  // g-505：主管上下文缓存保活（两阶段状态机 + 两级配置分层 + 公开宿主通道判定）。
  // 判定/投影的唯一真源在 core/keepalive.ts；宿主只做采样、抢占与真实调用。
  KEEP_ALIVE_MODES,
  KEEP_ALIVE_STAGE1_DEFAULTS,
  KEEP_ALIVE_SHORT_TTL_MS,
  KEEP_ALIVE_PING_TIMEOUT_MS,
  resolveKeepAliveChannel,
  resolveKeepAliveGlobalRaw,
  keepAliveResolutionOf,
  keepAliveEffectiveOf,
  keepAliveStatusProjection,
  decideKeepAlive,
  defaultKeepAliveConfig,
  makeKeepAliveAuditEntry,
  formatKeepAliveAudit,
  // g-506：子代理长任务关照（调度/巡检状态机 + 两级配置 + 只读投影）。
  // 判定唯一真源在 core/care.ts；宿主只做采样、维护临界区投递与窄工具身份/新鲜度校验。
  CARE_MODES,
  CARE_DEFAULTS,
  CARE_MAX_UNANSWERED_REMINDERS,
  CARE_OUTCOMES,
  CARE_CAPABILITIES,
  CARE_STALL_SIGNALS,
  CARE_PRESERVED_GATES,
  normalizeCareOutcome,
  normalizeCareSeconds,
  careResolutionOf,
  careEffectiveOf,
  assessCareCapabilities,
  careTaskDueAt,
  decideCare,
  applyCareDelivery,
  applyCareOutcome,
  applyNoResponseLimit,
  createCareInspection,
  careInspectionOpen,
  expireCareInspection,
  validateCareOutcome,
  applyCareInspectionOutcome,
  pauseCare,
  resumeCare,
  resetCare,
  newCareGroupState,
  isCareReminderStillValid,
  careStatusProjection,
  formatCareWakeMessage,
  // g-618：纪律资产解析（fail-open）与「首次全量、后续精简」的常量。
  CARE_DISCIPLINE_ASSET,
  resolveCareDisciplineText,
  makeCareAuditEntry,
  formatCareAudit,
} from "./core/ops.js";
import {
  careCooldownActive,
  careCooldownDueAt,
  careEffectiveBudgetSeconds,
  careTaskBudgetDueAt,
  careTaskIntervalMs,
  legacyPausedCooldownRemainingMs,
  CARE_NO_RESPONSE_COOLDOWN_MS,
  CARE_RUN_HISTORY_LIMIT,
  careCoalescedWakeAt,
  careCoalesceBatch,
  expireStaleInspectionTargets,
  CARE_COALESCE_WINDOW_MS,
} from "./core/care.js";
import { resolveRoot, resolveCanonicalRoot, _clearCanonicalRootCache } from "./core/root.js";
import { readEvents, appendEvent } from "./core/events.js";
import { sT, TOOL_CATEGORIES, TOOL_TAXONOMY, helpToolTaxonomyProblems } from "./lib/server-i18n.js";
// g-133：接入 DSH profile 级用户设置（dsh-settings）。为避免在 @deepseek-ai/* 不可解析的上下文
// （工作树 link、仅 headless、无 settings 供应商的组合）导致整个插件加载失败、拖垮 GUI，
// 这里不静态 import @deepseek-ai/*；改为在 apply() 内**守卫式动态 import** schemastery（仅 schema），
// settings 服务经 ctx.inject(["settings"]) 等待（参照已上线的 dsh-subagent-model-picker）。
// 解析失败或 settings 服务缺失时优雅降级：namespace 不注册、看板/工具/模型路由不受影响。
// g-351 / NB-2 措辞订正：这类降级**不是「静默」**——基线（96c29cb 起）在 schemastery 不可解析
// 时写 stderr `g-133: @deepseek-ai/schemastery 不可解析…`，在 register 抛错时写
// `g-133 settings 注册失败（降级…）`（负责人实测的 0.1.7 告警即后者）。真正「静默」的是
// **后果**：profile 全局默认不再生效（子代理派发回落默认路由），日志与用户可见状态脱节。
// g-351 的判据 3 要消灭的是这个后果（能力探测分流让值真正生效），而不是「补一条告警」。

// g-112：两半共用同一 root 解析函数（re-export 供验收/测试直接核对函数同一性）
export { resolveRoot } from "./core/root.js";
// g-149：canonical root 解析（Git linked-worktree 归一化）
export { resolveCanonicalRoot, _clearCanonicalRootCache } from "./core/root.js";
// g-111 B7：boardPayload 已移入 core（消除 client→host 跨包依赖），此处 re-export 保持兼容。
// board 载荷含 supervisorSession 字段（project.yaml 的 supervisor.session，g-108），由 host 端点 /api/dsh-graph 下发。
export { boardPayload, versionGoals, backlogGoals, compareVersions } from "./core/ops.js";

// g-495 返工项 B：把 `helpTopicText` 与点题**章节判定**导出为**测试钩子** —— 负向对照必须把
// 变异后的 help/usage 文本送进**真实实现**得出裁决，而不是用本地纯谓词自证（同义反复）。
// 导出的是**同一函数引用**（非副本），故经此入口的裁决与 `graph_help` 运行时逐字同源；
// 生产代码不消费这两个导出，注册面与行为均不变。
export { helpTopicText as _helpTopicText, isGraphEngineeringSectionTitle as _isGraphEngineeringSectionTitle };

/**
 * g-618：「本主管会话已收到过完整纪律」的持久标记归一（只认精确身份，绝不猜）。
 *
 * 记的是**发放首份全量正文时的主管会话 id**；缺失/形态不对一律 `null`（= 未知 = 按首次处理）。
 * 在 `syncIdentity` 里只比 `session === entry.supervisorId`，因此换会话 / 重启（新会话 id）
 * 都自然回落为首次 —— 不是「全局只看一次」，而是**每个主管会话的第一份**是全量。
 */
export function normalizeDisciplineSeen(raw) {
  if (!raw || typeof raw !== "object") return null;
  const session = typeof raw.session === "string" && raw.session ? raw.session : null;
  if (!session) return null;
  const at = Number(raw.at);
  return { session, at: Number.isFinite(at) ? at : null };
}

// g-183 返工 v4：流式上限（防无 header/伪造 Content-Length/chunked 的超大请求先进内存被拒）。
// JSON/base64 envelope 上限需容纳 50MB 二进制 base64 编码开销（~4/3）+ JSON 键，但拒绝更大。
export const MAX_ATTACHMENT_JSON_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES * 5 / 3) + 1024 * 1024;
// 普通 JSON REST（add-card/start-collection/unreference/转换/delete 等）统一 body 上限（1MB 足够管理类 payload）。
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

// ===== g-507：插件 HTTP 命名空间（唯一受保护入口）=====
// 本插件全部 HTTP 入口都在这个前缀之下。webServer 只注册**一个** `kind:"prefix"` 路由到这里
// （见 apply 内的 registerHttpRoutes），该入口每请求用宿主公开 `connection.admit(req)` + owner
// 判定先鉴权，通过后才在插件内部按显式 exact 元数据与两条资产 prefix 分发业务 handler。
export const API_NAMESPACE = "/api/dsh-graph";
// 认证后路径分发的尾斜杠策略（唯一真源，测试与实现共用）：
//   - 尾斜杠**不做重定向、不做等价改写**：`/api/dsh-graph` 是看板首屏 exact 端点，`/api/dsh-graph/`
//     不是它 ⇒ 分发按「规范路径逐字匹配」判定为未命中，认证后 404（与宿主 exact 表口径一致）；
//   - 两条资产 prefix（diagram / help/asset）**接受** `prefix/` 进入业务，由业务侧名额校验
//     返回 400（非法文件名），与逐条 exact 端点的 404 不同 —— 这是**有意的**差异：
//     prefix 端点自己不定义「尾斜杠 = 端点本身」，尾段为空时由业务给出 400 而不是伪造 404；
//   - query 不参与路径匹配（`?x=1` 不影响命中），认证后原样交给业务 handler 自行读取。
export const ROUTE_TABLE_TAIL_SLASH = "literal";

/**
 * 业务路由表：把路由定义按**宿主同款匹配规则**分成 exact 表与 prefix 表。
 *
 * 显式元数据是唯一依据（`kind: "exact"` 或缺省 = exact；`kind: "prefix"` = 边界 prefix），
 * 不靠字符串形状猜；baseline 只有两条 prefix（diagram / help/asset），其余 61 条一律 exact
 * （原先 61 条省略 kind 被宿主当 prefix，会让 `/<端点>/xxx` 等未知子路径误中看板业务）。
 * 重复 path 直接抛错（宿主 register 同款 fail-closed），避免后注册者静默覆盖前者。
 * @param {Array<{path: string, kind?: string, handler: Function}>} defs 路由定义
 * @returns {{exact: Map<string, object>, prefixes: Map<string, object>}} 路由表（每次调用新表，重载无残留）
 */
export const buildRouteTable = (defs) => {
  const exact = new Map();
  const prefixes = new Map();
  for (const def of defs) {
    // 命名空间根自身（看板首屏 `/api/dsh-graph`）与全体子路径都必须在命名空间内；
    // 越界 path 一律判错 ⇒ 不注册（fail-closed，绝不把业务路由裸挂到命名空间之外）。
    if (!def || typeof def.path !== "string" || !(def.path === API_NAMESPACE || def.path.startsWith(API_NAMESPACE + "/"))) {
      throw new Error(`HTTP 路由定义非法（必须在 ${API_NAMESPACE} 命名空间内）：${String(def?.path)}`);
    }
    if (typeof def.handler !== "function") throw new Error(`HTTP 路由缺少 handler：${def.path}`);
    const table = def.kind === "prefix" ? prefixes : exact;
    if (table.has(def.path)) throw new Error(`HTTP 重复路由 ${def.kind === "prefix" ? "prefix" : "exact"} "${def.path}"`);
    table.set(def.path, def);
  }
  return { exact, prefixes };
};

/**
 * 按**真实分发口径**在给定路由表里查一个 pathname（供测试断言「端点真的可达」）。
 *
 * 只做路径解析 + 表查找：**不调用 handler、不读 req 其它字段、不触达任何业务**。
 * 返回 `{defined:false}` 表示该路径在表里没有业务定义（认证后分发会落到 404）。
 * 这是纯查询（无副作用、不参与准入决策），不改变任何运行时行为。
 * @param {{exact: Map<string, object>, prefixes: Map<string, object>}} table 由 buildRouteTable 构建的表
 * @param {string} url 带 query 的完整 URL（query 不参与匹配）
 * @returns {{defined: boolean, def?: object, matchedPath?: string}}
 */
/** 测试用：注册瞬间的业务路由清单（只含 path + kind，**不含 handler** ⇒ 不是可绕过门禁的调用面）。 */
/**
 * 最近一次**真实注册**时快照的业务路由清单（仅 path + kind）。
 * 未注册（或已卸载/重载前）返回 `null`；它不是调用面，也不参与鉴权/分发。
 */
export const getRegisteredRoutes = () => (routeStateForReport.described ?? null);
const routeStateForReport = { described: null };

export const describeRoutes = (defs) =>
  defs.map((def) => Object.freeze({ path: def.path, kind: def.kind === "prefix" ? "prefix" : "exact" }));

export const lookupRoute = (table, url) => {
  const pathname = new URL(url, "http://dsh-graph.invalid").pathname;
  const exact = table.exact.get(pathname);
  if (exact !== undefined) return { defined: true, def: exact, matchedPath: pathname };
  // 段边界最长 prefix（与宿主 match 及 dispatchRequest 同口径）
  let best;
  for (const [prefix, def] of table.prefixes) {
    if (pathname !== prefix && !pathname.startsWith(prefix + "/")) continue;
    if (best === undefined || prefix.length > best[0].length) best = [prefix, def];
  }
  return best === undefined ? { defined: false } : { defined: true, def: best[1], matchedPath: best[0] };
};

// ===== g-462：设计哲学交互图的**只读** HTML 路由 =====
// 现有路由全部返回 JSON；这是第一条 text/html 路由。图的产物由 g-460 定稿在
// `dsh-graph-host/diagrams/`（自包含 HTML，随包发布到 `dist/diagrams/`）。
// 安全口径（单一路径入口，**无任何写路径**）：
//   ① 白名单是**唯一**入口：只有下面这两个文件名可被读取，其余一律拒绝；
//   ② 未知名 → 404；目录穿越（`../`、绝对路径）、反斜杠、URL 编码变体（`%2e%2e`、`%00`）、
//      非 `.html` 后缀 → 400。判定只看 **URL 归一化后的 pathname 尾段**，不做任何字符串拼接后
//      再就读（即使判定失误，也只会在 `diagrams/` 白名单目录里按白名单名读取）。
export const DESIGN_DIAGRAM_ROUTE = "/api/dsh-graph/diagram";
export const DESIGN_DIAGRAM_FILES = Object.freeze([
  "design-philosophy.lifecycle.html",
  "design-philosophy.workflow.html",
]);
/** 合法图名：小写字母/数字起头，只含 `[a-z0-9.-]`，`.html` 结尾。 */
const DESIGN_DIAGRAM_NAME_RE = /^[a-z0-9][a-z0-9.-]*\.html$/;

/**
 * 纯函数：把请求 URL 解析为「白名单图名」或一个可上报的拒绝结论。
 * 不触碰文件系统（只做 URL 归一化 + 白名单判定），故可被单测直接驱动。
 * @returns {{status: 200, name: string} | {status: 400|404, reason: string}}
 */
export function resolveDesignDiagramRequest(rawUrl) {
  let pathname;
  try {
    pathname = new URL(String(rawUrl ?? ""), "http://localhost").pathname;
  } catch {
    return { status: 400, reason: "malformed-url" };
  }
  if (pathname === DESIGN_DIAGRAM_ROUTE) return { status: 404, reason: "name-required" };
  if (!pathname.startsWith(DESIGN_DIAGRAM_ROUTE + "/")) return { status: 404, reason: "not-a-diagram" };
  const name = pathname.slice(DESIGN_DIAGRAM_ROUTE.length + 1);
  if (!DESIGN_DIAGRAM_NAME_RE.test(name) || name.includes("..")) return { status: 400, reason: "illegal-name" };
  if (!DESIGN_DIAGRAM_FILES.includes(name)) return { status: 404, reason: "unknown-diagram" };
  return { status: 200, name };
}

// ===== g-481：「使用说明」弹窗的**只读**提示词资产路由 + 帮助目录端点 =====
// 「提示词模板」页签把**随包发布**的 `prompts/*.md` 逐个只读展示给用户 —— 展示的内容与引擎
// 实际投递给 Agent 的资产是**同一份产物**（`dist/prompts/`），不复制、不改写、不新增第二份文案。
// 安全口径（与 g-462 图路由同一形状：单一路径入口、**无任何写路径**）：
//   ① 白名单是**唯一**入口：只有 `HELP_ASSET_REGISTRY` 登记的文件名（g-618 起 56 个 = 28 个资产
//      × zh/en）可被读取，其余一律拒绝；清单**不在此处硬编码**（注册表是唯一真源）；
//   ② 未知名 → 404；目录穿越（`../`、绝对路径）、反斜杠、URL 编码变体（`%2e%2e`、`%00`）、
//      非 `.md` 后缀 → 400。判定只看 **URL 归一化后的 pathname 尾段**，不做字符串拼接后再就读
//      （即使判定失误，也只会在 `prompts/` 白名单目录里按白名单名读取）。
export const HELP_ASSET_ROUTE = "/api/dsh-graph/help/asset";
/** g-496：帮助可达资产的**唯一 name → relativePath 注册**（冻结真源），并**携带所有权**。
 *
 *  发布布局（g-496 起）：**全部**提示词资产（公共层 + 宿主专属层）由 `build.sh` 合并进单一的
 *  包内 `prompts/` 目录 ⇒ 注册路径统一为 `prompts/<name>`。不再有根级资产。
 *  （此前 `supervisor-guide.{zh,en}.md` 位于包根，故注册需相对路径以表达两类位置；合并后
 *  该特例消失，但注册表作为**唯一 name → path 真源**的职责不变。）
 *
 *  注册同时是**白名单**、**目录投影**、**所有权归属**与**展示分类**的单一来源（g-496 返工 / g-498）：
 *  `HELP_PROMPT_ASSETS` 由它投影（顺序即展示顺序），处理器按 `relativePath` 读取，
 *  reader 按 `ownership` 决定源形态取根。**不持有第二份清单** —— 新增一份资产 = 在此加一行。
 *
 *  g-498：`category` 是按语义分组用的分类键（投影进 `/help/catalog` 的 `prompt_categories`），
 *  取值限 `HELP_PROMPT_CATEGORY_KEYS`。客户端只按投影分组、**不另抄文件名清单**；分类**可选** ——
 *  旧形态条目缺 `category` 也照常工作，缺/未登记即归入「未分类」并**仍然可见**（不静默丢项）。
 *  安全口径不变：`relativePath` 只允许**受控的两类形态**（`<name>` 或 `prompts/<name>`），
 *  且 `<name>` 仍须过 `HELP_ASSET_NAME_RE`；`..` / 绝对路径 / 反斜杠一律拒绝（结构性守卫断言）。 */
const HELP_ASSET_REGISTRY = Object.freeze([
  { name: "agent-teams-contract.en.md", ownership: "public", category: "subagents", relativePath: "prompts/agent-teams-contract.en.md" },
  { name: "agent-teams-contract.zh.md", ownership: "public", category: "subagents", relativePath: "prompts/agent-teams-contract.zh.md" },
  { name: "attempt-instructions.en.md", ownership: "public", category: "execution", relativePath: "prompts/attempt-instructions.en.md" },
  { name: "attempt-instructions.zh.md", ownership: "public", category: "execution", relativePath: "prompts/attempt-instructions.zh.md" },
  { name: "attempt-report-skeleton.en.md", ownership: "public", category: "reporting", relativePath: "prompts/attempt-report-skeleton.en.md" },
  { name: "attempt-report-skeleton.zh.md", ownership: "public", category: "reporting", relativePath: "prompts/attempt-report-skeleton.zh.md" },
  { name: "automation-guidance.en.md", ownership: "public", category: "supervisor", relativePath: "prompts/automation-guidance.en.md" },
  { name: "automation-guidance.zh.md", ownership: "public", category: "supervisor", relativePath: "prompts/automation-guidance.zh.md" },
  // g-618：关照唤醒正文外置的「纪律 + 检查清单」（公共层；三值定义不在此处）。
  { name: "care-discipline.en.md", ownership: "public", category: "supervisor", relativePath: "prompts/care-discipline.en.md" },
  { name: "care-discipline.zh.md", ownership: "public", category: "supervisor", relativePath: "prompts/care-discipline.zh.md" },
  { name: "collect-task.en.md", ownership: "public", category: "subagents", relativePath: "prompts/collect-task.en.md" },
  { name: "collect-task.zh.md", ownership: "public", category: "subagents", relativePath: "prompts/collect-task.zh.md" },
  { name: "discipline.en.md", ownership: "public", category: "supervisor", relativePath: "prompts/discipline.en.md" },
  { name: "discipline.zh.md", ownership: "public", category: "supervisor", relativePath: "prompts/discipline.zh.md" },
  { name: "executor-discipline.en.md", ownership: "public", category: "execution", relativePath: "prompts/executor-discipline.en.md" },
  { name: "executor-discipline.zh.md", ownership: "public", category: "execution", relativePath: "prompts/executor-discipline.zh.md" },
  { name: "guide-hint.en.md", ownership: "public", category: "help", relativePath: "prompts/guide-hint.en.md" },
  { name: "guide-hint.zh.md", ownership: "public", category: "help", relativePath: "prompts/guide-hint.zh.md" },
  // g-496：GUI 提示词模板（9 类 × zh/en）—— **宿主专属层**所有权：这些正文绑定 DSH 会话
  // `session.prompt` 载荷与看板 GUI 动作语义（发往主管/执行会话的提示词），跨宿主插件不复用。
  // 正文的唯一事实源是 `dsh-graph-host/prompts/gui-*.{zh,en}.md`（构建合并进包内 prompts/）。
  { name: "gui-accept-review-request.en.md", ownership: "host", category: "gui", relativePath: "prompts/gui-accept-review-request.en.md" },
  { name: "gui-accept-review-request.zh.md", ownership: "host", category: "gui", relativePath: "prompts/gui-accept-review-request.zh.md" },
  { name: "gui-backward-reason.en.md", ownership: "host", category: "gui", relativePath: "prompts/gui-backward-reason.en.md" },
  { name: "gui-backward-reason.zh.md", ownership: "host", category: "gui", relativePath: "prompts/gui-backward-reason.zh.md" },
  { name: "gui-batch-accept-review-request.en.md", ownership: "host", category: "gui", relativePath: "prompts/gui-batch-accept-review-request.en.md" },
  { name: "gui-batch-accept-review-request.zh.md", ownership: "host", category: "gui", relativePath: "prompts/gui-batch-accept-review-request.zh.md" },
  { name: "gui-criteria-feedback-executor.en.md", ownership: "host", category: "gui", relativePath: "prompts/gui-criteria-feedback-executor.en.md" },
  { name: "gui-criteria-feedback-executor.zh.md", ownership: "host", category: "gui", relativePath: "prompts/gui-criteria-feedback-executor.zh.md" },
  { name: "gui-criteria-feedback-supervisor.en.md", ownership: "host", category: "gui", relativePath: "prompts/gui-criteria-feedback-supervisor.en.md" },
  { name: "gui-criteria-feedback-supervisor.zh.md", ownership: "host", category: "gui", relativePath: "prompts/gui-criteria-feedback-supervisor.zh.md" },
  { name: "gui-define-polish-request.en.md", ownership: "host", category: "gui", relativePath: "prompts/gui-define-polish-request.en.md" },
  { name: "gui-define-polish-request.zh.md", ownership: "host", category: "gui", relativePath: "prompts/gui-define-polish-request.zh.md" },
  { name: "gui-deliver-notice.en.md", ownership: "host", category: "gui", relativePath: "prompts/gui-deliver-notice.en.md" },
  { name: "gui-deliver-notice.zh.md", ownership: "host", category: "gui", relativePath: "prompts/gui-deliver-notice.zh.md" },
  { name: "gui-help-takeover-example.en.md", ownership: "host", category: "help", relativePath: "prompts/gui-help-takeover-example.en.md" },
  { name: "gui-help-takeover-example.zh.md", ownership: "host", category: "help", relativePath: "prompts/gui-help-takeover-example.zh.md" },
  { name: "gui-reexecute.en.md", ownership: "host", category: "gui", relativePath: "prompts/gui-reexecute.en.md" },
  { name: "gui-reexecute.zh.md", ownership: "host", category: "gui", relativePath: "prompts/gui-reexecute.zh.md" },
  { name: "help.en.md", ownership: "public", category: "help", relativePath: "prompts/help.en.md" },
  { name: "help.zh.md", ownership: "public", category: "help", relativePath: "prompts/help.zh.md" },
  { name: "minor-task.en.md", ownership: "public", category: "execution", relativePath: "prompts/minor-task.en.md" },
  { name: "minor-task.zh.md", ownership: "public", category: "execution", relativePath: "prompts/minor-task.zh.md" },
  { name: "no-isolation.en.md", ownership: "public", category: "execution", relativePath: "prompts/no-isolation.en.md" },
  { name: "no-isolation.zh.md", ownership: "public", category: "execution", relativePath: "prompts/no-isolation.zh.md" },
  { name: "pm-task.en.md", ownership: "public", category: "subagents", relativePath: "prompts/pm-task.en.md" },
  { name: "pm-task.zh.md", ownership: "public", category: "subagents", relativePath: "prompts/pm-task.zh.md" },
  { name: "review-task.en.md", ownership: "public", category: "subagents", relativePath: "prompts/review-task.en.md" },
  { name: "review-task.zh.md", ownership: "public", category: "subagents", relativePath: "prompts/review-task.zh.md" },
  { name: "subagent-mode.en.md", ownership: "public", category: "subagents", relativePath: "prompts/subagent-mode.en.md" },
  { name: "subagent-mode.zh.md", ownership: "public", category: "subagents", relativePath: "prompts/subagent-mode.zh.md" },
  { name: "summary-task.en.md", ownership: "public", category: "reporting", relativePath: "prompts/summary-task.en.md" },
  { name: "summary-task.zh.md", ownership: "public", category: "reporting", relativePath: "prompts/summary-task.zh.md" },
  { name: "supervisor-guide.en.md", ownership: "public", category: "supervisor", relativePath: "prompts/supervisor-guide.en.md" },
  { name: "supervisor-guide.zh.md", ownership: "public", category: "supervisor", relativePath: "prompts/supervisor-guide.zh.md" },
  { name: "usage.en.md", ownership: "public", category: "help", relativePath: "prompts/usage.en.md" },
  { name: "usage.zh.md", ownership: "public", category: "help", relativePath: "prompts/usage.zh.md" },
  { name: "worktree.en.md", ownership: "public", category: "execution", relativePath: "prompts/worktree.en.md" },
  { name: "worktree.zh.md", ownership: "public", category: "execution", relativePath: "prompts/worktree.zh.md" },
]);

/** 白名单（名字清单，投影自注册表；**不是**第二份清单）。 */
export const HELP_PROMPT_ASSETS = Object.freeze(HELP_ASSET_REGISTRY.map((e) => e.name));

/** 纯函数：白名单资产名 → 其在包内的相对路径（未注册 ⇒ null）。 */
export function helpAssetRelativePath(name) {
  const hit = HELP_ASSET_REGISTRY.find((e) => e.name === name);
  return hit ? hit.relativePath : null;
}

/** g-496：白名单资产名 → 其**语义归属**（`"public"` | `"host"`）。
 *
 *  只读投影自 `HELP_ASSET_REGISTRY`（所有权唯一真源，**不新增第二份清单**）；未注册名按公共层
 *  口径返回 `"public"`（与内部 reader 的 `assetOwnership` 同语义）。供守卫与诊断使用：
 *  「资产标称归属」必须与「源码实际所在层」双向对齐，否则分层在注册表里已失真。 */
export function helpAssetOwnership(name) {
  return assetOwnership(name);
}
/** 合法资产名：小写字母/数字起头，只含 `[a-z0-9.-]`，`.md` 结尾。 */
const HELP_ASSET_NAME_RE = /^[a-z0-9][a-z0-9.-]*\.md$/;

/**
 * 纯函数：把请求 URL 解析为「白名单资产名」或一个可上报的拒绝结论。
 * 不触碰文件系统（只做 URL 归一化 + 白名单判定），故可被单测直接驱动。
 * @returns {{status: 200, name: string} | {status: 400|404, reason: string}}
 */
export function resolveHelpAssetRequest(rawUrl) {
  let pathname;
  try {
    pathname = new URL(String(rawUrl ?? ""), "http://localhost").pathname;
  } catch {
    return { status: 400, reason: "malformed-url" };
  }
  if (pathname === HELP_ASSET_ROUTE) return { status: 404, reason: "name-required" };
  if (!pathname.startsWith(HELP_ASSET_ROUTE + "/")) return { status: 404, reason: "not-a-help-asset" };
  const name = pathname.slice(HELP_ASSET_ROUTE.length + 1);
  if (!HELP_ASSET_NAME_RE.test(name) || name.includes("..")) return { status: 400, reason: "illegal-name" };
  if (!HELP_PROMPT_ASSETS.includes(name)) return { status: 404, reason: "unknown-asset" };
  return { status: 200, name };
}

/** g-481：帮助目录端点 —— 客户端「工具清单 / 提示词模板」两个页签的**服务端唯一真源**。
 *  工具名与说明取自**注册真源**（`apply` 内的 `tools` 数组 + lib/server-i18n.js 的 `tool.*` 键，
 *  zh/en 成对），资产清单取自上方白名单常量 ⇒ 引擎增删工具或资产改名时客户端清单自动跟随，
 *  客户端**不硬编码任何工具名/资产名**。只读投影，无参数、无写路径。 */
export const HELP_CATALOG_ROUTE = "/api/dsh-graph/help/catalog";

/** g-498：提示词资产的**语义分类键**（顺序即分组展示顺序；标签 zh/en 成对取自 server-i18n）。
 *  分类本身是**注册元数据**（`HELP_ASSET_REGISTRY` 每条目的 `category`）⇒ 客户端不新增文件清单，
 *  只按本表顺序把目录投影分组；未登记分类的条目落进「未分类」并**仍然可见**。 */
export const HELP_PROMPT_CATEGORY_KEYS = Object.freeze(["supervisor", "execution", "reporting", "subagents", "gui", "help"]);

/** g-498：提示词资产的分类投影（顺序即展示顺序；标签 zh/en 成对取自 server-i18n）。 */
export function helpPromptCategoryEntries() {
  return HELP_PROMPT_CATEGORY_KEYS.map((key) => ({
    key,
    label: { zh: sT(`promptCategory.${key}`, "zh"), en: sT(`promptCategory.${key}`, "en") },
  }));
}

/** 纯函数：某个资产条目的分类键 —— **未登记/未注册**时回退为空串（客户端据此归入「未分类」）。 */
export function helpPromptCategoryOf(base) {
  const hit = HELP_ASSET_REGISTRY.find((e) => e.name.startsWith(`${base}.`));
  return (hit && typeof hit.category === "string" && HELP_PROMPT_CATEGORY_KEYS.includes(hit.category)) ? hit.category : "";
}

/** 纯函数：白名单资产名 → `{name, base, lang, category}` 清单。
 *  `base` 供客户端配 i18n 展示标签（也是**选中的稳定身份**：切语言时基名不变）；
 *  `category` 是注册元数据投影，供客户端按语义分组（`""` = 未分类，仍须可见）。 */
export function helpPromptAssetEntries() {
  return HELP_PROMPT_ASSETS.map((name) => {
    const m = /^([a-z0-9][a-z0-9.-]*)\.(zh|en)\.md$/.exec(name);
    const base = m ? m[1] : name;
    return { name, base, lang: m ? m[2] : "zh", category: helpPromptCategoryOf(base) };
  });
}

/** g-489：工具清单的**分类**投影（顺序即展示顺序；标签 zh/en 成对取自 server-i18n）。 */
export function helpToolCategoryEntries() {
  return TOOL_CATEGORIES.map((key) => ({
    key,
    label: { zh: sT(`toolCategory.${key}`, "zh"), en: sT(`toolCategory.${key}`, "en") },
  }));
}

/** g-489：工具清单条目 = 注册真源名字 + 分类表归属 + `toolShort.*` 简称 + `tool.*` 用途。
 *  客户端只按这份投影渲染，**不硬编码任何工具名/分类名**（新增工具自动出现；漏配则被结构守卫判红）。 */
export function helpToolCatalogEntries(names) {
  return (Array.isArray(names) ? names : []).map((name) => ({
    name,
    category: TOOL_TAXONOMY[name] ?? "",
    short: { zh: sT(`toolShort.${name}`, "zh"), en: sT(`toolShort.${name}`, "en") },
    description: { zh: sT(`tool.${name}`, "zh"), en: sT(`tool.${name}`, "en") },
  }));
}

/** 超限时停止累积（pause/unpipe），但**不销毁 socket**——让 handler 能写出可读的 4xx 响应。
 *  真实 HTTP 下若不 pause 而 destroy，客户端会收到 ECONNRESET 而读不到响应（v6 复现）。 */
function stopOversized(req) {
  try { req.pause?.(); } catch { /* 忽略 */ }
  try { req.unpipe?.(); } catch { /* 忽略 */ }
}

/** 流式读取原始二进制 body，累计超过 maxBytes 立即停止累积并 reject（handler 回 4xx；不留半状态）。 */
export function readRawBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += b.length;
      if (total > maxBytes) { stopOversized(req); reject(new GraphError(`请求体超过 ${maxBytes} 字节上限`)); return; }
      chunks.push(b);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 流式读取 JSON body，累计超过 maxBytes 立即停止累积并 reject（handler 回 4xx）。
 *  按 Buffer 累积、最后一次性 toString 解码，避免跨 chunk 的 UTF-8 多字节字符被逐 chunk 解码损坏。 */
export function readBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf8");
      total += b.length;
      if (total > maxBytes) { stopOversized(req); reject(new GraphError(`请求体超过 ${maxBytes} 字节上限`)); return; }
      chunks.push(b);
    });
    req.on("end", () => {
      try {
        const text = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
        resolve(text ? JSON.parse(text) : {});
      } catch (e) { reject(new GraphError("请求 body JSON 格式无效")); }
    });
    req.on("error", reject);
  });
}

export const name = "dsh-graph-host";
// 只硬依赖 tools：webServer 由 web-app 行提供且可能在 apply 之后才激活，经 ctx.get 轮询注册
// （同 dsh-project-kanban 参考实现），保证 headless（仅工具）与 web（工具+端点+看板）两种组合都可用。
export const inject = ["tools"];

/**
 * g-469：宿主 subagent 派发 API 的**双版本兼容收口**（唯一入口）。
 *
 * 背景：DSH `0.2.1-alpha.2` 把 subagent 服务方法 `startContinuable(spec)` 改名为
 * `startActivation(spec)`（`0.2.0-rc.2` / `0.2.1-alpha.1` 只有旧名，`0.2.1-alpha.2` 只有新名）。
 * 不兼容直接表现为 5 处派发点全部 `subagents.startContinuable is not a function`
 * ——安装+启动可用、**派发完全不可用**。
 *
 * 收口要求：`dsh-graph-host/index.js` 内**所有**子代理启动都必须经本 helper，
 * 禁止任何调用点直连 `subagents.startActivation(...)` / `subagents.startContinuable(...)`。
 *   · 新宿主（≥ 0.2.1-alpha.2）具备 `startActivation` ⇒ 走新名；
 *   · 旧宿主（≤ 0.2.1-alpha.1）只具备 `startContinuable` ⇒ 走旧名；
 *   · 两者皆无 ⇒ **fail-closed**：抛出可追溯、可操作的错误。绝不静默回退到别的路径、
 *     绝不虚构 childId / 返回「无 child」冒充派发成功。
 *
 * g-624：收口点**同时**负责构建 `SubagentActivationSpec` 的形态。rc.3 起 spec 的
 * `request` 嵌套层被移除，本 helper 是唯一知道「哪种形态」的地方；5 个调用点只提交
 * **扁平 payload**（`provider` / `label` / `signal` + `prompt` / `parent` / 可选执行设置），
 * 不得各自拼形态。
 *
 * 形态判别（可核实的能力探测，不猜版本号）：
 *   · 嵌套形态（`{ provider, label, request: { prompt, parent, ... }, signal }`）：
 *     `typeof subagents.list === "function"`，或根本没有 `startActivation`。
 *     —— rc.3 在同一版删除了 `list()`（rc.3 自带 `docs/upgrade-guide/v0.2.1-rc.2/
 *     subagent-service-methods`），而所有嵌套形态的宿主（0.2.0-rc.2 / 0.2.1-alpha.1 /
 *     0.2.2-rc.1）都暴露 `list()`；只有 `startContinuable` 的宿主（≤ 0.2.1-alpha.1）
 *     全部早于扁平化（g469 夹具两版真实实现的 spec 读取面都只有 `spec.request.*`）。
 *   · 扁平形态（`{ provider, label, prompt, parent, ..., signal }`）：只剩 `startActivation`
 *     且无 `list()`（rc.3+）。官方迁移说明：`request: task` 换成 `...task`，label/signal
 *     保持在 spread 之后（`docs/upgrade-guide/v0.2.1-rc.2/subagent-activation-options`）。
 *
 * 两形态都显式传 `delivery: "parent"`：rc.1 与 rc.3 的声明都把 `delivery` 标为必填
 * （rc.1 未传时 `spec.delivery === "caller"` 恒假、恰好退化成 parent；显式传值把这条
 * 依赖不再成立），语义仍是「子代理结果通知父代理」，绝不改成 `caller`（不通知）。
 *
 * 返回契约（`childId` 必在）见 `core/tests/fixtures/g469-host-subagent-api.json`
 * （由 `core/tests/fixtures/g469-host-subagent-api.mjs` 从真实宿主包提取）。
 *
 * @param subagents 宿主 `ctx.get("subagents")` 服务（可能为 undefined）
 * @param spec 扁平派发 payload（见上；也兼容旧的 `{ request: {...} }` 分组形态）
 * @returns 宿主 receipt（含 `childId`）
 * @throws 两版 API 皆缺时抛错（交由既有 `subagentSpawnErrorText` 映射为可操作文案）
 */
function buildSubagentActivationSpec(subagents, payload, hasActivation) {
  const source = payload ?? {};
  const { provider, label, signal } = source;
  // 任务字段 = payload 去掉派发控制字段（provider/label/signal）。兼容旧调用方仍按
  // g-469 的 `request` 分组传入——只作为「任务包」使用，最终形态仍由本 helper 决定。
  let task;
  if (source.request !== undefined) {
    task = source.request;
  } else {
    task = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === "provider" || key === "label" || key === "signal" || key === "request") continue;
      if (value !== undefined) task[key] = value;
    }
  }
  const nested = typeof subagents?.list === "function" || !hasActivation;
  if (nested) return { provider, label, request: task, signal, delivery: "parent" };
  return { provider, label, ...task, signal, delivery: "parent" };
}

export async function startSubagentCompat(subagents, spec) {
  const hasActivation = subagents && typeof subagents.startActivation === "function";
  const hasContinuable = subagents && typeof subagents.startContinuable === "function";
  if (hasActivation) return subagents.startActivation(buildSubagentActivationSpec(subagents, spec, hasActivation));
  if (hasContinuable) return subagents.startContinuable(buildSubagentActivationSpec(subagents, spec, hasActivation));
  let registered = "未知";
  try {
    if (typeof subagents?.list === "function") {
      registered = (subagents.list() ?? []).join(",") || "无";
    } else if (typeof subagents?.getProvider === "function") {
      const known = ["spawn", "fork"].filter((n) => subagents.getProvider(n) !== undefined);
      // 注意：这里刻意用字符串拼接而非模板字面量 —— g469 结构守卫用「花括号配平」截取 helper 体，
      // 嵌套模板里的 `${…}` 会干扰该配平（历史实现只在末尾有一个 `${}`）。
      registered = known.length
        ? known.join(",") + "（无枚举 API，仅探测官方默认名）"
        : "无（无枚举 API，仅探测官方默认名 spawn/fork）";
    }
  } catch { /* 探测失败不影响 fail-closed 结论 */ }
  throw new Error(
    "subagents 服务缺少派发 API（需 startActivation（DSH ≥ 0.2.1-alpha.2）"
    + "或 startContinuable（DSH ≤ 0.2.1-alpha.1）之一，当前两者皆不可用）："
    + `无法启动子代理，已注册 provider：${registered}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// g-625：DSH 0.2.2-rc.3 删除的三个 subagent/agent 管理 API 的**双版本收口**
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// rc.3 自带升级指南（`docs/upgrade-guide/v0.2.1-rc.2/subagent-service-methods`、
// `.../v0.2.1-rc.2/subagent-user-controls`、`.../v0.2.1-rc.3/subagent-runtime-ownership`）删除：
//   1. `subagents.interruptByParent(childId, parentSessionId, 'continuable')` 被删除。rc.3 **本地**服务面是
//      `subagents.interrupt(targetSessionId, authority)`，authority = `{kind:"ancestor", agent}`（插件派出
//      child 时持有确切父 Agent）或 `{kind:"user"}`。`interruptByUser(childId)` 只是 **Remote face**
//      （Gateway 授权，user 语义），**不得**拿来冒充本地收敛；本收口只用 ancestor 身份；
//   2. `subagents.listChildren(parentSessionId)` → `ctx.sessionQuery.observeSession(parentSessionId)`
//      读 `observation.projections.values.subagentCatalog`（直接子级、catalog 事件序、排除 fork 继承）；
//      缺投影必须当**不可用/unknown**，不得当「无 child」；递归发现可用仍存在的 `listDescendants()`；
//   3. `agents.isOwnedBy(childId, owner)` → `ctx.subagents.rootOf(agent)`（比较 **Agent 对象**，
//      不是 id）+ `session.header.parentSession`（直接创建者）。
// rc.1（0.2.2-rc.1）**仍保留旧 API** ⇒ 一律「旧 API 优先、缺失才走新 API」，不得只为 rc.3 删旧路径；
// 旧 API 在位时行为与 v0.24.0 一致。g-626 候选在 rootOf 抛错时按历史 parentSession 回退；
// 创建关系能否证明实时归属尚未验证，不得将此回退当作已证实的授权边界。
//
// **使用点登记**（旧代码 19 处文本面 = 5 处真实调用 + 能力探测 + 注释；收敛为 8 个功能面）：
//   ① keepalive `sampleRunningChildren`：按归属过滤 live Agent 后计 running；
//   ② keepalive `capabilityOf`：agentsOk 能力探测；
//   ③ keepalive keepaliveStatusProjection：与 ② 同口径的能力探测；
//   ④ care `entryOfChildAgent`：child → care entry 归属；
//   ⑤ care `sampleTasks`：catalog ∩ live registry ∩ ownership ∩ running；
//   ⑥ care `capabilitiesOf`：children_probe；
//   ⑦ care `submitOutcome`：窄结果受理的 live/ownership 复核；
//   ⑧ g-613 `inspectReuseChild` → `callerOwnsChild`：复用准入。
// 结构守卫 `core/tests/g625-subagent-api-compat.test.ts` 禁止这三个方法名出现在 helper 之外。
/**
 * 归属探测的三种结论：`yes` / `no` / `unknown`（**不可确认**，调用方必须 fail-closed）。
 * @typedef {"yes" | "no" | "unknown"} OwnershipVerdict
 */
/**
 * 建立一次归属探测（g-625 唯一收口）。
 *
 * 旧宿主（有 `agents.isOwnedBy`）⇒ 原样调用，逐字保持 v0.24.0 语义（id + 精确 owner Agent）。
 * 新宿主（只有 `subagents.rootOf`）⇒ 两次 `rootOf` **比较 Agent 对象**判同树，再用公开
 * `session.header.parentSession` 收紧到「直接创建者」（rc.1 `isOwnedBy` 的语义是直接运行时子级）。
 * g-626 候选：rootOf 抛错时回退 parentSession；该历史证据的授权安全性尚待真宿主验证。
 *
 * @param agents 宿主 `agents` 注册表服务（可能为 undefined）
 * @param subagents 宿主 `subagents` 服务（可能为 undefined）
 * @returns {{ supported: boolean, mode: "isOwnedBy" | "rootOf" | "unavailable", reason: string | null,
 *   ownsAgent: (child: any, owner: any) => OwnershipVerdict,
 *   ownsId: (childId: string, owner: any) => OwnershipVerdict }}
 */
export function ownershipProbeOf(agents, subagents, options = null) {
  const oldSupported = !!agents && typeof agents.isOwnedBy === "function";
  const newSupported = !!subagents && typeof subagents.rootOf === "function";
  const mode = oldSupported ? "isOwnedBy" : (newSupported ? "rootOf" : "unavailable");
  const reason = oldSupported || newSupported
    ? null
    : "缺归属 API（agents.isOwnedBy 与 subagents.rootOf 皆不可用）";
  const sessionIdOf = (agent) => {
    const sid = agent?.session?.id ?? agent?.id;
    return sid === undefined || sid === null || sid === "" ? null : String(sid);
  };
  const parentSessionOf = (agent) => {
    try {
      const raw = agent?.session?.header?.parentSession;
      return raw === undefined || raw === null || raw === "" ? null : String(raw);
    } catch { return null; }
  };
  const ownsViaRootOf = (childAgent, ownerAgent) => {
    const ownerSid = sessionIdOf(ownerAgent);
    const parentSid = parentSessionOf(childAgent);
    let ownerRoot = null;
    let childRoot = null;
    // An unauthorized caller is not the exact live runtime object.  Its historical
    // session id cannot establish authority, even when the child's header matches.
    try { ownerRoot = subagents.rootOf(ownerAgent); } catch { return "unknown"; }
    let childRootFailed = false;
    try { childRoot = subagents.rootOf(childAgent); } catch { childRootFailed = true; }
    if (childRootFailed) {
      if (options?.requireLiveTree === true) return "unknown";
      if (ownerSid === null || parentSid === null) return "unknown";
      return parentSid === ownerSid ? "yes" : "no";
    }
    if (!ownerRoot || childRoot !== ownerRoot) return childRoot && ownerRoot ? "no" : "unknown";
    if (ownerSid === null || parentSid === null) return "unknown";
    return parentSid === ownerSid ? "yes" : "no";
  };
  const ownsAgent = (childAgent, ownerAgent) => {
    if (!oldSupported && !newSupported) return "unknown";
    if (!childAgent || !ownerAgent) return "unknown";
    if (oldSupported) {
      const childId = sessionIdOf(childAgent);
      if (childId === null) return "unknown";
      try { return agents.isOwnedBy(childId, ownerAgent) === true ? "yes" : "no"; } catch { return "unknown"; }
    }
    return ownsViaRootOf(childAgent, ownerAgent);
  };
  const ownsId = (childId, ownerAgent) => {
    if (!oldSupported && !newSupported) return "unknown";
    if (!ownerAgent || childId === undefined || childId === null || childId === "") return "unknown";
    if (oldSupported) {
      try { return agents.isOwnedBy(String(childId), ownerAgent) === true ? "yes" : "no"; } catch { return "unknown"; }
    }
    let childAgent = null;
    try { childAgent = typeof agents?.get === "function" ? agents.get(String(childId)) : null; } catch { return "unknown"; }
    // 已不在 live registry ⇒ 可确定「不是当前 live 归属」（与 rc.1 isOwnedBy 的 false 对齐）。
    if (!childAgent) return "no";
    return ownsViaRootOf(childAgent, ownerAgent);
  };
  return { supported: oldSupported || newSupported, mode, reason, ownsAgent, ownsId };
}

/**
 * 读取某父会话的**直接子级目录**（g-625 唯一收口）。
 *
 * 旧宿主（服务方法 `subagents.listChildren` 在位）⇒ 原样调用（rc.1 行为不变）。
 * 新宿主（rc.3 删除了服务方法）⇒ `sessionQuery.observeSession(parentSessionId)` 读
 * `projections.values.subagentCatalog`，读后立即释放观察（`Symbol.dispose`）。
 * **缺 catalog 投影 / observe 抛错 / 旧方法抛错 ⇒ `ok:false`**：调用方只能按 unknown 处理，
 * 绝不把「读不到」当成「没有 child」。
 *
 * @param services `{ subagents?, sessionQuery? }`（分别来自 `ctx.get("subagents")` / `ctx.get("sessionQuery")`）
 * @param parentSessionId 父（主管）会话 id
 * @param options `{ signal? }` 取消信号（观测结束时一并释放）
 * @returns {Promise<{ ok: boolean, mode: string, rows: any[], reason: string | null, detail?: string }>}
 */
export async function readChildCatalogCompat(services, parentSessionId, options) {
  const subagents = services?.subagents ?? null;
  const sessionQuery = services?.sessionQuery ?? null;
  const parentId = parentSessionId === undefined || parentSessionId === null || parentSessionId === ""
    ? null
    : String(parentSessionId);
  const fail = (mode, reason, detail) => ({ ok: false, mode, rows: [], reason, ...(detail ? { detail: String(detail) } : {}) });
  if (!parentId) return fail("unavailable", "no_parent_session");
  if (subagents && typeof subagents.listChildren === "function") {
    try {
      const rows = await subagents.listChildren(parentId);
      if (!Array.isArray(rows)) return fail("listChildren", "invalid_row_set");
      return { ok: true, mode: "listChildren", rows, reason: null };
    } catch (error) {
      return fail("listChildren", "listChildren_error", error?.message ?? error);
    }
  }
  if (!sessionQuery || typeof sessionQuery.observeSession !== "function") {
    return fail("unavailable", "session_query_unavailable");
  }
  let observation = null;
  try {
    const opts = {};
    if (options?.signal !== undefined) opts.signal = options.signal;
    observation = await sessionQuery.observeSession(parentId, opts);
    const rows = observation?.projections?.values?.subagentCatalog;
    // 缺投影 = 能力不可用（官方迁移口径明确要求如此），不能当空目录。
    if (rows === undefined) return fail("subagentCatalog", "catalog_projection_unavailable");
    if (!Array.isArray(rows)) return fail("subagentCatalog", "catalog_projection_invalid");
    return { ok: true, mode: "subagentCatalog", rows, reason: null };
  } catch (error) {
    return fail("subagentCatalog", "observe_session_error", error?.message ?? error);
  } finally {
    if (observation) {
      try {
        if (typeof observation[Symbol.dispose] === "function") observation[Symbol.dispose]();
        else if (typeof observation.dispose === "function") observation.dispose();
      } catch { /* 释放失败不改变读取结论（不吞掉已得到的 rows/reason） */ }
    }
  }
}

/**
 * 请求中断一个刚启动的 child（g-625 唯一收口）。
 *
 * 旧宿主（rc.1，`interruptByParent` 在位）：`interruptByParent(childId, parentSessionId, 'continuable')`
 * —— 逐字保持 v0.24.0 语义。
 * rc.3：`interruptByParent` 已删除，但**本地服务面**仍是
 * `subagents.interrupt(targetSessionId, authority: SubagentInterruptAuthority)`，
 * authority 为 `{ kind: "ancestor", agent: <确切 live 父 Agent> }`（模型/祖先侧中断）或
 * `{ kind: "user" }`（受信宿主操作）。本收口**只用 ancestor 身份**，因为插件确实持有派发时的
 * 父 Agent，且 `interrupt` 会校验「该 Agent 是目标的真实祖先」（不拥有 ⇒ 抛 `SubagentError` UNAUTHORIZED）。
 * 绝不使用 `interruptByUser`：它只是 **Remote face**（Gateway 授权，`{kind:"user"}` 语义），
 * 拿它冒充本地收敛会绕过归属校验。
 * 缺 API / 缺确切父 Agent / 调用抛错（含 UNAUTHORIZED）⇒ `requested:false` + 可读 note；
 * 调用方只能如实上报「未中断/不可确认」，不得虚称已停止。
 *
 * @param services `{ subagents? }`
 * @param params `{ childId?, parentSessionId?, parentAgent? }`（`parentAgent` 必须是派发时的确切 live Agent）
 * @returns {{ requested: boolean, mode: string, note: string }}
 */
export function interruptChildCompat(services, params) {
  const subagents = services?.subagents ?? null;
  const rawChild = params?.childId;
  const childId = rawChild === undefined || rawChild === null || rawChild === "" ? null : String(rawChild);
  const rawParent = params?.parentSessionId;
  const parentSessionId = rawParent === undefined || rawParent === null || rawParent === "" ? null : String(rawParent);
  const parentAgent = params?.parentAgent ?? services?.parentAgent ?? null;
  if (!childId) return { requested: false, mode: "unavailable", note: "无法中断该 child（缺少 child id）" };
  const hasOld = !!subagents && typeof subagents.interruptByParent === "function";
  // 旧宿主优先：`interruptByParent` 在位时按 v0.24.0 原路径，绝不被新 authority 形态替换。
  if (hasOld) {
    if (!parentSessionId) {
      return { requested: false, mode: "interruptByParent", note: "无法中断该 child（缺少 parent session）" };
    }
    try {
      subagents.interruptByParent(childId, parentSessionId, "continuable");
      return { requested: true, mode: "interruptByParent", note: "已请求中断该 child" };
    } catch (error) {
      return { requested: false, mode: "interruptByParent", note: `中断该 child 失败：${error?.message ?? error}` };
    }
  }
  if (subagents && typeof subagents.interrupt === "function") {
    if (!parentAgent) {
      // 没有确切父 Agent ⇒ 无法以 ancestor 身份中断；**不**退回 `{kind:"user"}`/`interruptByUser`。
      return { requested: false, mode: "interrupt", note: "无法中断该 child（缺少确切 live 父 Agent，无法以 ancestor 身份中断）" };
    }
    try {
      subagents.interrupt(childId, { kind: "ancestor", agent: parentAgent });
      return { requested: true, mode: "interrupt", note: "已请求中断该 child" };
    } catch (error) {
      const code = error?.code;
      // UNAUTHORIZED = 目标不属于该父 Agent（或父 Agent 非确切 live 实例）⇒ 归属不可确认、未中断。
      const detail = code === "UNAUTHORIZED"
        ? "归属不可确认（authority 不拥有该目标）"
        : `中断失败：${error?.message ?? error}`;
      return { requested: false, mode: "interrupt", note: `无法中断该 child（${detail}）` };
    }
  }
  return {
    requested: false,
    mode: "unavailable",
    note: "无法中断该 child（缺少 parent session / 确切父 Agent，或 subagents.interruptByParent、subagents.interrupt 能力）",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// g-505：主管会话上下文缓存的智能保活（宿主接线；判定真源在 core/keepalive.ts）
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// 目标：主管上下文常达 50k~150k tokens，而前缀缓存 TTL 通常仅 4~5 分钟 —— ①子代理执行窗口
// （6~15 分钟）刚好跨过死亡悬崖；②负责人审阅窗口（3~8 分钟）同样可能踩中过期，而负责人 AFK 时
// 持续保活只会白烧 Token。
//
// 负责人 2026-10-27 裁定的实现边界（本段逐条落实，不得越界）：
//   · **A 方案**：只复用「最近观察到的正常 loop 请求」的**公共内存快照**，不承诺下一轮或最终 wire
//     完全等价；无快照/已知失效 ⇒ 明确不可用，不猜。
//   · **无痕 = 不新增对话消息**；允许宿主正常 checkpoint 刷新（因此保留观察到的 `sessionId`）。
//   · 不伪造 `purpose`、不伪造 loop marker、不读私有字段、不调用 loop 内部函数。
//   · **未知 TTL 按短缓存有界策略**：不按 provider/model 名字猜长 TTL 豁免，用有限次数 + 单次 Grace
//     + 短 TTL 假设后的 AFK 界定成本上界；失败不算续期成功。
//
// 真源分工（**单一真源**，宿主不重写判定）：
//   · 状态机/熔断/AFK/两级配置/通道能力 全在 core/keepalive.ts（纯函数 + 完整单测）；
//   · 宿主只负责**采样真实运行态**、**runMaintenance 抢占真 idle**、**公开 prepareCall/stream 调用**。
//
// 采样口径（全部来自宿主公开面，绝不猜）：
//   · `runningChildren`：live Agent 注册表 `list()` + 归属探测（g-625：rc.1 `isOwnedBy` /
//     rc.3 `subagents.rootOf`，唯一收口 `ownershipProbeOf`）过滤出主管直接拥有的子代理，再按各自
//     公开 `status === "running"` 计数（**不**用 `Activity`/mtime 冒充运行；不可确认 ⇒ null，不谎称 0）。
//   · `idle`：主管 Agent 公开 `status === "idle"`。公开 idle 不等于「真 idle」⇒ ping 前仍必须
//     `runMaintenance()` 同步抢占（忙则同步 throw），并检查 `inbox.nextTurn/nextStep` 为空。
//   · `lastLlmAt`：**观察到的正常 loop 请求**（`agent/request` + `llm/stream` 关联）时刻；保活
//     成功也会推进它（缓存已被刷新）。不读 session.jsonl。
//   · `lastActivityAt`：主管 loop 请求 / 人类输入 / agent 状态转 running / 子回报唤醒。
//   · `lastHumanAt`：`agent/inbox/inserted` 中 `source.kind === "user"` 的消息（人类交互）。
//
// 有界与仲裁：
//   · 每个 board 有**独立真实 deadline timer**（阶段一 210s/阶段二 240s 精确唤醒）；配置变化检测
//     上界 60s；单次调度/尝试绝不并发（per-board in-flight guard）。失败按 30s→60s→120s 有界退避，
//     维护忙按 15s 有界重排 —— 绝不固定 105s 轮询、绝不 busy-spin。
//   · 阶段一连续尝试达上限即熔断；主管活动/子回报唤醒 ⇒ 计数归零、阶段二机会复原。
//   · 阶段二只允许 1 次尝试；其后一个短 TTL 窗口内无交互 ⇒ AFK 终态（不再产生任何成本）。
//   · 人类输入/子回报到达 ⇒ **只 abort 本插件自己的控制器**（绝不 `agent.cancel`、不清 inbox）。
//   · 请求级 timeout 只 abort 请求；不 race 提前释放维护（不合作 adapter 的严格上界**不承诺**）。
//   · 任何异常都被吞掉并留结构化 stderr，**绝不影响**工具、看板与既有生命周期事件。
//
// 出处：HOST-CONTRACT.md（0.2.1-rc.2 公共类型/实现交叉核对）与 shared-d3ae87c6 共享卡。
/**
 * 调度参数（B4/B6）：**不再做固定 105s 轮询**。每个 board 按真实 deadline 单独 setTimeout；
 * `CONFIG_RECHECK_MS` 只作为「无更快 deadline 时重读 project.yaml/全局配置」的有界检查，
 * 不参与 ping 到期精度（deadline 更早时按 deadline 精确唤醒；更晚时最多晚一个检查周期才看到
 * 配置变化，但**不会**推迟已到期的 ping）。
 */
export const KEEP_ALIVE_CONFIG_RECHECK_MS = 60_000;
/** 失败后的有界指数退避（首次 30s，逐次 ×2，封顶 120s）；不计作成功刷新。 */
export const KEEP_ALIVE_RETRY_BACKOFF_MS = 30_000;
export const KEEP_ALIVE_RETRY_BACKOFF_MAX_MS = 120_000;
/** runMaintenance 同步拒绝（真维护忙）后的有界重排；未发请求、不计预算。 */
export const KEEP_ALIVE_MAINTENANCE_RETRY_MS = 15_000;

/** 观察到的 loop 请求里，构成「可复用的完整公共请求」的字段（只读引用，深冻结对象可直接保留）。 */
function pickLoopSnapshot(options) {
  if (!options || typeof options !== "object") return null;
  return {
    provider: options.provider,
    model: options.model,
    messages: options.messages,
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.toolHistory === undefined ? {} : { toolHistory: options.toolHistory }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  };
}

/** 路由/controls 指纹（用于「已知失效」判定；不含正文）。 */
function routeFingerprint(config) {
  if (!config || typeof config !== "object") return null;
  return JSON.stringify({
    provider: config.provider ?? null,
    model: config.model ?? null,
    reasoningEffort: config.reasoningEffort ?? null,
    temperature: config.temperature ?? null,
    maxTokens: config.maxTokens ?? null,
    stop: Array.isArray(config.stop) ? config.stop : null,
  });
}

/** 从配置对象提取 LlmCallConfig 的六个字段（prepareCall 只认这些）。 */
function callConfigOf(config) {
  if (!config || typeof config !== "object") return null;
  const out = { provider: config.provider, model: config.model };
  if (config.reasoningEffort !== undefined) out.reasoningEffort = config.reasoningEffort;
  if (config.temperature !== undefined) out.temperature = config.temperature;
  if (config.maxTokens !== undefined) out.maxTokens = config.maxTokens;
  if (config.stop !== undefined) out.stop = config.stop;
  return out;
}

/** 从 chunk.usage 提取**仅元数据**（不含内容）。 */
function usageOf(usage) {
  if (!usage || typeof usage !== "object") return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { inputTokens: num(usage.inputTokens), outputTokens: num(usage.outputTokens), cacheReadTokens: num(usage.cacheReadTokens) };
}

// ── 路由核对（B1）：只核对 provider/model 与**调用方真正显式给出的控制项**。
//
// 真实 `LlmRuntime.prepareCall` 会用 adapter 的 `defaultMaxTokens` / 默认 reasoning 等填满
// `prepared.config`，随后 loop 用这份 resolved config 组装 options。`agent/request` 交付的
// proposed config 通常只含 provider/model（adapter 默认尚未填充），因此**全字段比较必然误判**。
// 这里允许 adapter 填充缺省，但显式控制项一旦给出就必须一致；provider/model 永远必须一致。
const KEEP_ALIVE_CONTROL_KEYS = ["reasoningEffort", "temperature", "maxTokens", "stop"];

function controlValueEquals(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** proposed（agent/request 交付的 config）与 observed（llm/stream 的 resolved options）是否同一请求。 */
function routeCompatible(proposed, observed) {
  if (!proposed || !observed || typeof proposed !== "object" || typeof observed !== "object") return false;
  if (proposed.provider !== observed.provider || proposed.model !== observed.model) return false;
  for (const key of KEEP_ALIVE_CONTROL_KEYS) {
    if (proposed[key] !== undefined && !controlValueEquals(proposed[key], observed[key])) return false;
  }
  return true;
}

/** 从**已观察到的 resolved options** 提取 route（只含实际存在的控制项；不补猜默认）。 */
function resolvedRouteOf(options) {
  if (!options) return null;
  const route = { provider: options.provider, model: options.model };
  for (const key of KEEP_ALIVE_CONTROL_KEYS) {
    if (options[key] !== undefined) route[key] = options[key];
  }
  return route;
}

/**
 * 创建保活运行时（宿主 apply 内使用；测试可注入假时钟/假定时器/假服务做离线验证）。
 *
 * 结构：**每个 board root 一份独立小状态**（`boards` Map）——配置、预算计数、阶段二机会、快照、
 * 在途控制器、审计序号、AFK 都按工作区隔离，避免「首次 bind 后永远忽略另一个工作区」。
 * 核心判定仍复用 core/keepalive.ts 的单 board 纯函数，不为多租户重写。
 *
 * @param options.ctx 插件上下文（读取 `agents`/`llm` 服务，注册事件）
 * @param options.readGlobal 返回 `{ enabled, malformed, available, raw }`（profile 全局开关）
 * @param options.resolveRoot `(workspace) => canonical graph root`（**唯一** workspace→root 边界；
 *   每个 workspace 恰好调用一次，返回的 graph root 绝不再当 workspace 传入）
 * @param options.defaultWorkspace `() => workspaceRoot|null`（宿主默认 **workspace**，不是 graph root；仅作候选之一）
 * @param options.now/setTimeoutFn/clearTimeoutFn/... 可注入时钟与定时器（生产用全局实现）
 * @param options.log 结构化审计输出（默认 stderr 单行；绝不携带正文）
 */
export function createKeepAliveRuntime(options = {}) {
  const {
    ctx,
    readGlobal = () => ({ enabled: null, malformed: false, available: false, raw: "" }),
    resolveRoot = null,
    defaultWorkspace = () => null,
    readProjectConfigFn = readProjectConfig,
    readSupervisorSessionFn = readSupervisorSession,
    now = () => Date.now(),
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (h) => clearTimeout(h),
    configRecheckMs = KEEP_ALIVE_CONFIG_RECHECK_MS,
    retryBaseMs = KEEP_ALIVE_RETRY_BACKOFF_MS,
    retryMaxMs = KEEP_ALIVE_RETRY_BACKOFF_MAX_MS,
    maintenanceRetryMs = KEEP_ALIVE_MAINTENANCE_RETRY_MS,
    pingTimeoutMs = KEEP_ALIVE_PING_TIMEOUT_MS,
    log = null,
  } = options;

  const offs = [];
  const ownPingOptions = new WeakSet();
  const boards = new Map(); // canonical root → board state（每 board 独立 deadline/timer）
  let started = false;
  let disposed = false;
  let generation = 0;

  const getService = (name) => {
    try { return typeof ctx?.get === "function" ? ctx.get(name) : null; } catch { return null; }
  };
  const emit = (entry) => {
    try {
      if (typeof log === "function") log(formatKeepAliveAudit(entry));
      else process.stderr.write(`[dsh-graph-host] ${formatKeepAliveAudit(entry)}\n`);
    } catch { /* 审计失败绝不影响主流程 */ }
  };
  /**
   * **显式边界（B4 root）**：`resolveRoot` 只在「workspace → canonical graph root」这一处调用，
   * 且每个 workspace **恰好一次**。返回的 graph root 之后不得再当 workspace 传给 resolver
   * （否则会叠 `.dsh-graph/.dsh-graph`，产生 phantom board / 读不到 project.yaml）。
   *
   * `boardRootKey` 是 graph root 的**纯键**：不做任何 canonical 解析、不猜 basename/project.yaml
   * 是否存在（自定义 root、真正名为 `.dsh-graph` 的 workspace、未初始化 root 均按原样作为边界值）。
   */
  const canonicalRootOfWorkspace = (workspace) => {
    if (!workspace || typeof workspace !== "string") return null;
    if (typeof resolveRoot !== "function") return null; // 无显式边界解析器 ⇒ fail-safe，不把 workspace 当 root
    try {
      const resolved = resolveRoot(workspace);
      return typeof resolved === "string" && resolved ? resolved : null;
    } catch {
      return null;
    }
  };
  // graph root 由 resolveRoot 产生，生产恒为绝对路径；只接受绝对键，避免误把相对 workspace 当 root
  // 创建 phantom board（相对 root 的解析必须走 canonicalRootOfWorkspace 边界）。
  const boardRootKey = (root) => (typeof root === "string" && root && isAbsolute(root) ? root : null);
  const rootOfAgent = (agent) => {
    try {
      const ws = agent?.session?.header?.cwd;
      if (!ws) return null;
      return canonicalRootOfWorkspace(ws);
    } catch {
      return null;
    }
  };
  const defaultRoot = () => {
    try {
      const ws = typeof defaultWorkspace === "function" ? defaultWorkspace() : null;
      return ws ? canonicalRootOfWorkspace(ws) : null;
    } catch {
      return null;
    }
  };

  const makeBoard = (root) => ({
    root,
    supervisorId: null,
    supervisorAgent: null,
    session: null,
    snapshot: null, // { messages/system/tools/toolHistory/sessionId/route/agent/session/at/fingerprint }
    snapshotStatus: "no_snapshot",
    pendingObservation: null, // { agent, session, config, at }
    lastProposedConfig: null,
    lastLlmAt: null,
    lastActivityAt: null,
    lastHumanAt: null,
    pingsInWindow: 0,
    stage2Used: false,
    lastPingAt: null, // 最近一次**成功**保活时刻（失败绝不推进）
    lastAttemptAt: null, // 最近一次**实际发出**尝试的时刻（成功/失败/取消都记，独立节流）
    lastSuccessAt: null,
    consecutiveFailures: 0,
    retryNotBefore: null, // 失败指数退避 / 维护忙重排的绝对时刻
    timer: null, // 本 board 的单次 deadline timer
    timerDueAt: null,
    lastAttempt: null,
    lastOutcome: null,
    lastReason: "disabled_by_config",
    lastDecision: null,
    seq: 0,
    inflight: false,
    controller: null,
    afk: false,
    windowEpoch: 0,
    sweeping: false,
    configError: false,
  });
  const boardForRoot = (root, create = true) => {
    // 这里只接受**已归一 graph root**（调用方必须来自 canonicalRootOfWorkspace 或宿主 rootFor）。
    const key = boardRootKey(root);
    if (!key) return null;
    let board = boards.get(key);
    if (!board && create) { board = makeBoard(key); boards.set(key, board); }
    return board ?? null;
  };
  const boardOfAgent = (agent) => {
    if (!agent) return null;
    const sid = agent.session?.id;
    for (const board of boards.values()) {
      if (board.supervisorAgent === agent) return board;
      if (sid && board.supervisorId === sid) return board;
    }
    const root = rootOfAgent(agent);
    return root ? boards.get(root) ?? null : null;
  };
  const ensureDefaultBoard = () => {
    const root = defaultRoot();
    return root ? boardForRoot(root) : null;
  };

  const clearBoardTimer = (board) => {
    if (!board || board.timer === null) return;
    try { clearTimeoutFn(board.timer); } catch { /* 忽略 */ }
    board.timer = null;
    board.timerDueAt = null;
  };
  const resetWindow = (board) => {
    board.windowEpoch += 1;
    board.pingsInWindow = 0;
    board.stage2Used = false;
    board.afk = false;
    board.consecutiveFailures = 0;
    board.retryNotBefore = null;
  };
  const abortInflight = (board, why) => {
    const ctrl = board?.controller;
    if (!ctrl || ctrl.signal.aborted) return;
    try { ctrl.abort(new Error(why || "keepalive-abort")); } catch { /* 忽略 */ }
  };
  const invalidateSnapshot = (board, reason, opts = {}) => {
    // 表面/身份变化后旧前缀不再可靠：在途保活也立即 abort（只动本插件控制器）。
    abortInflight(board, reason);
    board.snapshot = null;
    board.snapshotStatus = reason;
    board.pendingObservation = null;
    if (opts.resetWindow !== false) resetWindow(board);
  };
  const resetBoard = (board, why) => {
    clearBoardTimer(board);
    abortInflight(board, why || "board-reset");
    board.snapshot = null;
    board.snapshotStatus = why === "agent_replaced" ? "agent_replaced" : "no_snapshot";
    board.pendingObservation = null;
    board.lastProposedConfig = null;
    board.lastLlmAt = null;
    board.lastActivityAt = null;
    board.lastHumanAt = null;
    board.lastPingAt = null;
    board.lastAttemptAt = null;
    board.lastSuccessAt = null;
    board.consecutiveFailures = 0;
    board.retryNotBefore = null;
    board.configError = false;
    resetWindow(board);
  };

  const sampleRunningChildren = (supervisor) => {
    const agents = getService("agents");
    const ownership = ownershipProbeOf(agents, getService("subagents"), { requireLiveTree: true });
    if (!agents || typeof agents.list !== "function" || !ownership.supported) return null;
    try {
      const all = agents.list();
      if (!Array.isArray(all)) return null;
      let running = 0;
      for (const a of all) {
        if (!a || a === supervisor || a.id === supervisor?.id) continue;
        const owned = ownership.ownsAgent(a, supervisor);
        if (owned === "unknown") return null; // 归属不可确认 ⇒ fail-safe（绝不当成 0 个 child）
        if (owned !== "yes") continue;
        if (a.status === "running") running += 1;
        else if (a.status !== "idle") return null;
      }
      return running;
    } catch {
      return null;
    }
  };
  const sampleIdle = (agent) => {
    try {
      if (!agent) return null;
      if (agent.status === "idle") return true;
      if (agent.status === "running") return false;
      return null;
    } catch {
      return null;
    }
  };
  const hasPendingInput = (agent) => {
    try {
      const inbox = agent?.inbox;
      if (!inbox) return true;
      return (Array.isArray(inbox.nextTurn) && inbox.nextTurn.length > 0)
        || (Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0);
    } catch {
      return true;
    }
  };

  const snapshotProblemForBoard = (board, agent) => {
    if (disposed) return "disposed";
    if (!board) return "no_supervisor";
    if (board.configError) return "config_unavailable";
    if (board.snapshotStatus !== "ready") return board.snapshotStatus;
    const snap = board.snapshot;
    if (!snap) return "no_snapshot";
    if (!agent) return "no_supervisor";
    if (snap.agent !== agent) return "agent_replaced";
    if (snap.session !== agent.session) return "session_replaced";
    if (snap.sessionId !== agent.session?.id) return "session_replaced";
    // 与「最近一次正常请求的 proposed route」同口径（允许 adapter 填充缺省）：
    if (board.lastProposedConfig && !routeCompatible(board.lastProposedConfig, snap.route)) return "route_changed";
    if (snap.fingerprint !== routeFingerprint(snap.route)) return "config_changed";
    return null;
  };

  /** 对外：传入 Agent / **canonical graph root** / 省略（默认 board）得到该 board 的快照可用性。 */
  const snapshotProblem = (target) => {
    if (typeof target === "string") {
      const board = boards.get(boardRootKey(target)) ?? null;
      return snapshotProblemForBoard(board, board?.supervisorAgent ?? null);
    }
    if (target && typeof target === "object") {
      const board = boardOfAgent(target);
      if (!board) return "no_supervisor";
      return snapshotProblemForBoard(board, target);
    }
    const board = ensureDefaultBoard() ?? boards.values().next().value ?? null;
    return snapshotProblemForBoard(board, board?.supervisorAgent ?? null);
  };

  const readResolutionForBoard = (board) => {
    try {
      const cfg = readProjectConfigFn(board.root);
      const globalState = readGlobal() ?? {};
      const resolution = keepAliveResolutionOf(
        cfg?.supervisor,
        globalState.enabled ?? null,
        globalState.malformed === true,
        globalState.available !== false,
      );
      board.configError = false;
      return { cfg, globalState, resolution };
    } catch {
      board.configError = true;
      return null;
    }
  };

  /** 显式可信长 TTL 只对**完整 provider+model 精确匹配**的当前观察 route 生效。 */
  const routeMatchesTtl = (entry, route) => !!(entry && route
    && entry.provider === route.provider && entry.model === route.model);

  const capabilityOf = (board, agent, cfg = null) => {
    const llm = getService("llm");
    const agents = getService("agents");
    const ownership = ownershipProbeOf(agents, getService("subagents"), { requireLiveTree: true });
    const llmOk = !!(llm && typeof llm.prepareCall === "function" && typeof llm.stream === "function");
    // g-625：归属能力 = rc.1 `isOwnedBy` 或 rc.3 `rootOf`（唯一收口），缺 API 才判不具备。
    const agentsOk = !!(agents && typeof agents.get === "function" && typeof agents.list === "function" && ownership.supported);
    const statusOk = !!agent && (agent.status === "idle" || agent.status === "running");
    const maintenanceOk = !!agent && typeof agent.runMaintenance === "function";
    const snapProblem = snapshotProblemForBoard(board, agent);
    const caps = { llm: llmOk, agents: agentsOk, status: statusOk, maintenance: maintenanceOk, snapshot: snapProblem === null };
    // B5：只有显式配置且与**已观察 route** 完整匹配时才把 TTL 交给纯函数裁决；默认 null=unknown。
    const ttlEntry = cfg?.supervisor?.keep_alive_ttl ?? null;
    const matched = routeMatchesTtl(ttlEntry, board?.snapshot?.route) ? ttlEntry : null;
    let channel = resolveKeepAliveChannel(caps, matched ? { cacheTtlMs: matched.ttl_ms } : null);
    if (board.configError) {
      channel = { ...channel, channel: "none", reason: "missing_capability", exempt: false, missing: [...channel.missing, "project.config"] };
    }
    return { llmOk, agentsOk, statusOk, maintenanceOk, snapProblem, channel, llm, ttlEntry, ttlMatched: !!matched };
  };

  /** 发现候选 board roots：默认 workspace + 每个「自己就是该 root 主管」的 live Agent。 */
  const candidateRoots = () => {
    const roots = new Set();
    const dflt = defaultRoot();
    if (dflt) roots.add(dflt);
    const agents = getService("agents");
    if (agents && typeof agents.list === "function") {
      try {
        for (const agent of agents.list() ?? []) {
          const root = rootOfAgent(agent);
          if (!root) continue;
          let supId = null;
          try { supId = readSupervisorSessionFn(root); } catch { supId = null; }
          if (supId && agent?.session?.id === supId) roots.add(root);
        }
      } catch { /* registry 异常：至少保留默认 root */ }
    }
    for (const board of boards.values()) roots.add(board.root);
    return [...roots];
  };

  /** 只采样 + 判定（无副作用写 board 之外的状态），供 sweep 与 deadline 调度共用。 */
  const decisionOfBoard = (board) => {
    const resolved = readResolutionForBoard(board);
    if (!resolved) return { resolved: null, agent: null, caps: null, decision: null };
    let agent = null;
    try {
      const supId = readSupervisorSessionFn(board.root);
      const agents = getService("agents");
      agent = supId && agents?.get ? agents.get(supId) : null;
    } catch { agent = null; }
    if (!agent) return { resolved, agent: null, caps: null, decision: null };
    const caps = capabilityOf(board, agent, resolved.cfg);
    const decision = decideKeepAlive(
      {
        now: now(),
        lastLlmAt: board.lastLlmAt,
        runningChildren: sampleRunningChildren(agent),
        idle: sampleIdle(agent),
        pingsInWindow: board.pingsInWindow,
        stage2Used: board.stage2Used,
        lastPingAt: board.lastPingAt,
        lastAttemptAt: board.lastAttemptAt,
        retryNotBefore: board.retryNotBefore,
        lastActivityAt: board.lastActivityAt,
        inflight: board.inflight,
        pendingInput: hasPendingInput(agent),
      },
      defaultKeepAliveConfig(resolved.resolution.enabled),
      caps.channel,
    );
    return { resolved, agent, caps, decision };
  };

  const sweepBoard = async (root) => {
    const board = boardForRoot(root);
    if (!board || board.sweeping) return;
    board.sweeping = true;
    try {
      const resolved = readResolutionForBoard(board);
      if (!resolved) {
        board.lastReason = "state_unknown";
        board.lastDecision = null;
        return;
      }
      const supId = readSupervisorSessionFn(board.root);
      if (supId !== board.supervisorId) {
        board.supervisorId = supId;
        board.supervisorAgent = null;
        board.session = null;
        resetBoard(board, supId ? "supervisor_changed" : "no_supervisor");
        board.snapshotStatus = supId ? "no_snapshot" : "no_supervisor";
      }
      const agents = getService("agents");
      const agent = supId && agents?.get ? agents.get(supId) : null;
      if (agent && agent !== board.supervisorAgent) {
        if (board.supervisorAgent) resetBoard(board, "agent_replaced");
        board.supervisorAgent = agent;
        board.session = agent.session ?? null;
      }
      if (!agent) {
        board.supervisorAgent = null;
        board.session = null;
        board.snapshotStatus = "no_supervisor";
        board.lastReason = "state_unknown";
        board.lastDecision = null;
        return;
      }
      const caps = capabilityOf(board, agent, resolved.cfg);
      const decision = decideKeepAlive(
        {
          now: now(),
          lastLlmAt: board.lastLlmAt,
          runningChildren: sampleRunningChildren(agent),
          idle: sampleIdle(agent),
          pingsInWindow: board.pingsInWindow,
          stage2Used: board.stage2Used,
          lastPingAt: board.lastPingAt,
          lastAttemptAt: board.lastAttemptAt,
          retryNotBefore: board.retryNotBefore,
          lastActivityAt: board.lastActivityAt,
          inflight: board.inflight,
          pendingInput: hasPendingInput(agent),
        },
        defaultKeepAliveConfig(resolved.resolution.enabled),
        caps.channel,
      );
      board.lastDecision = decision;
      board.lastReason = decision.reason;
      board.afk = decision.afk === true;
      if (!decision.ping) return;
      await attemptPing({ board, agent, decision, channel: caps.channel, llm: caps.llm });
    } catch (e) {
      board.lastReason = "state_unknown";
      try { process.stderr.write(`[dsh-graph-host] 主管上下文缓存保活调度跳过: ${String(e?.message ?? e).slice(0, 120)}\n`); } catch { /* 忽略 */ }
    } finally {
      board.sweeping = false;
    }
  };

  const clearAllBoardTimers = () => { for (const board of boards.values()) clearBoardTimer(board); };

  /**
   * 单 board 的真实 deadline 调度（B4）：ping 到期精确唤醒；无更快事件时最多每
   * `configRecheckMs` 重读一次配置作为配置变化检测上界。绝不共享固定 105s 轮询相位。
   */
  const scheduleBoard = (board) => {
    if (!started || disposed || !board) return;
    clearBoardTimer(board);
    const computed = decisionOfBoard(board);
    if (computed?.decision) {
      board.lastDecision = computed.decision;
      board.lastReason = computed.decision.reason;
      board.afk = computed.decision.afk === true;
    }
    let delay = null;
    const decision = computed?.decision ?? null;
    if (decision?.ping) delay = 0;
    else if (decision && decision.nextEligibleInMs !== null && decision.nextEligibleInMs !== undefined) {
      delay = Math.max(0, decision.nextEligibleInMs);
    }
    // 无更快 deadline ⇒ 配置重读上界；有 deadline 也封顶到该检查周期（ping 到期仍是精确的，
    // 因为只会在 deadline 更早时按 deadline 唤醒）。
    delay = delay === null ? configRecheckMs : Math.min(delay, configRecheckMs);
    board.timerDueAt = now() + delay;
    let handle = null;
    try {
      handle = setTimeoutFn(async () => {
        board.timer = null;
        board.timerDueAt = null;
        await sweepBoard(board.root);
        scheduleBoard(board);
      }, delay);
      handle?.unref?.();
    } catch { handle = null; }
    board.timer = handle;
  };

  const sweep = async () => {
    if (disposed) return;
    const roots = candidateRoots();
    for (const root of roots) await sweepBoard(root);
    for (const board of boards.values()) scheduleBoard(board);
  };

  const snapshotForPing = (board) => {
    const snap = board.snapshot;
    return {
      provider: snap.route.provider,
      model: snap.route.model,
      route: snap.route,
      messages: snap.messages,
      system: snap.system,
      tools: snap.tools,
      toolHistory: snap.toolHistory,
      sessionId: snap.sessionId,
    };
  };

  const streamPing = async (snap, signal) => {
    const llm = getService("llm");
    if (!llm || typeof llm.prepareCall !== "function") return { outcome: "not_attempted", error: "llm-missing" };
    const callConfig = callConfigOf(snap.route);
    if (!callConfig || typeof callConfig.provider !== "string" || typeof callConfig.model !== "string") {
      return { outcome: "not_attempted", error: "route-missing" };
    }
    callConfig.maxTokens = 1;
    let prepared;
    try {
      prepared = await llm.prepareCall(callConfig, signal);
    } catch (e) {
      if (signal?.aborted) return { outcome: "aborted_input", error: String(e?.message ?? e).slice(0, 120) };
      return { outcome: "adapter_error", error: `prepareCall: ${String(e?.message ?? e).slice(0, 100)}` };
    }
    const route = prepared?.config ?? callConfig;
    const options = {
      provider: route.provider,
      model: route.model,
      maxTokens: route.maxTokens,
      messages: snap.messages,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      ...(route.temperature === undefined ? {} : { temperature: route.temperature }),
      ...(route.stop === undefined ? {} : { stop: route.stop }),
      ...(snap.system === undefined ? {} : { system: snap.system }),
      ...(snap.tools === undefined ? {} : { tools: snap.tools }),
      ...(snap.toolHistory === undefined ? {} : { toolHistory: snap.toolHistory }),
      ...(snap.sessionId === undefined ? {} : { sessionId: snap.sessionId }),
      signal,
    };
    ownPingOptions.add(options);
    let finish = null;
    let usage = null;
    try {
      const stream = typeof prepared?.stream === "function" ? prepared.stream(options) : llm.stream(options);
      for await (const chunk of stream) {
        if (chunk?.type === "usage") usage = usageOf(chunk.usage);
        else if (chunk?.type === "finish") finish = chunk.reason ?? null;
        // 其余 chunk 一律丢弃：不执行工具、不记录正文。
      }
    } catch (e) {
      const aborted = signal?.aborted === true;
      return { outcome: aborted ? "aborted_input" : "adapter_error", error: String(e?.message ?? e).slice(0, 120) };
    } finally {
      ownPingOptions.delete(options);
    }
    const kind = finish?.kind;
    if (kind === "stop" || kind === "max-tokens" || kind === "tool-calls") {
      return { outcome: "success", error: null, usage };
    }
    if (kind === "aborted") {
      return { outcome: signal?.aborted === true ? "aborted_input" : "aborted_adapter", error: "finish:aborted", usage };
    }
    return { outcome: "adapter_error", error: kind ? `finish:${kind}` : "finish:missing", usage };
  };

  const attemptPing = async ({ board, agent, decision, channel, llm }) => {
    if (!llm || typeof llm.prepareCall !== "function") return;
    const startedAt = now();
    const boardEpoch = board.windowEpoch;
    const gen = generation;
    let outcome = "not_attempted";
    let error = null;
    let usage = null;
    let attemptStarted = false;
    let maintenanceEntered = false;
    board.inflight = true;
    try {
      if (typeof agent.runMaintenance !== "function") {
        error = "maintenance-missing";
        return;
      }
      try {
        await agent.runMaintenance(async (maintenanceSignal) => {
          maintenanceEntered = true;
          if (disposed || generation !== gen) { outcome = "aborted_dispose"; return; }
          if (board.supervisorAgent !== agent) { outcome = "not_attempted"; error = "agent-replaced"; return; }
          if (snapshotProblemForBoard(board, agent) !== null) { outcome = "not_attempted"; error = "snapshot-invalid"; return; }
          let supIdNow = null;
          try { supIdNow = readSupervisorSessionFn(board.root); } catch { supIdNow = null; }
          if (supIdNow !== board.supervisorId) { outcome = "not_attempted"; error = "supervisor-changed"; return; }
          if (hasPendingInput(agent)) { outcome = "pending_input"; return; }
          const resolvedNow = readResolutionForBoard(board);
          if (!resolvedNow || !resolvedNow.resolution.enabled) { outcome = "not_attempted"; error = "config-disabled"; return; }
          // 配置可能在 deadline 与真正抢占之间变化：重查显式长 TTL/能力，绝不打穿豁免。
          const capsNow = capabilityOf(board, agent, resolvedNow.cfg);
          if (capsNow.channel.exempt) { outcome = "not_attempted"; error = "ttl-exempt"; return; }
          if (capsNow.channel.channel !== "host_prepare_stream") { outcome = "not_attempted"; error = "capability-missing"; return; }

          const ctrl = new AbortController();
          board.controller = ctrl;
          let timedOut = false;
          const onMaintenanceAbort = () => { try { ctrl.abort(maintenanceSignal?.reason ?? new Error("maintenance-abort")); } catch { /* 忽略 */ } };
          if (maintenanceSignal) {
            if (maintenanceSignal.aborted) onMaintenanceAbort();
            else maintenanceSignal.addEventListener?.("abort", onMaintenanceAbort, { once: true });
          }
          let timerHandle = null;
          try {
            timerHandle = setTimeoutFn(() => {
              timedOut = true;
              try { ctrl.abort(new Error("keepalive-timeout")); } catch { /* 忽略 */ }
            }, pingTimeoutMs);
            timerHandle?.unref?.();
          } catch { timerHandle = null; }

          attemptStarted = true;
          try {
            const result = await streamPing(snapshotForPing(board), ctrl.signal);
            outcome = result.outcome;
            error = result.error;
            usage = result.usage ?? null;
            if (timedOut && (outcome === "aborted_input" || outcome === "aborted_adapter")) outcome = "timeout";
          } catch (e) {
            if (ctrl.signal.aborted) {
              const reason = String(ctrl.signal.reason?.message ?? "");
              outcome = timedOut ? "timeout" : reason.includes("input") ? "aborted_input" : "aborted_dispose";
            } else {
              outcome = "adapter_error";
            }
            error = String(e?.message ?? e).slice(0, 120);
          } finally {
            if (timerHandle !== null) { try { clearTimeoutFn(timerHandle); } catch { /* 忽略 */ } }
            try { maintenanceSignal?.removeEventListener?.("abort", onMaintenanceAbort); } catch { /* 忽略 */ }
            if (board.controller === ctrl) board.controller = null;
          }
        });
      } catch (e) {
        if (!maintenanceEntered) {
          outcome = "maintenance_busy";
          error = "maintenance-claim-rejected";
        } else if (outcome === "not_attempted" || outcome === "pending_input") {
          if (outcome === "not_attempted") error = error ?? String(e?.message ?? e).slice(0, 120);
        } else if (outcome === "success") {
          outcome = "adapter_error";
          error = String(e?.message ?? e).slice(0, 120);
        }
      }
    } finally {
      board.inflight = false;
      if (disposed && outcome === "aborted_input") outcome = "aborted_dispose";
      const elapsed = now() - startedAt;
      if (attemptStarted) {
        board.lastAttemptAt = startedAt;
        if (board.windowEpoch === boardEpoch) board.pingsInWindow = decision.pingsInWindow;
        if (decision.phase === "stage2" && board.windowEpoch === boardEpoch) board.stage2Used = true;
        if (outcome === "success") {
          // 只有真正成功才刷新缓存时间；失败/取消只保留独立 lastAttemptAt。
          board.lastLlmAt = now();
          board.lastSuccessAt = now();
          board.lastPingAt = now();
          board.consecutiveFailures = 0;
          board.retryNotBefore = null;
        } else if (outcome === "adapter_error" || outcome === "timeout" || outcome === "aborted_adapter") {
          board.consecutiveFailures += 1;
          const backoff = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, board.consecutiveFailures - 1));
          board.retryNotBefore = now() + backoff;
        }
      }
      if (outcome === "maintenance_busy" || outcome === "not_attempted") {
        // 没发成请求（维护忙/配置竞态/快照失效）：不消耗 4 次预算；有界重排，避免 busy-spin。
        board.retryNotBefore = now() + maintenanceRetryMs;
      }
      board.seq += 1;
      const entry = makeKeepAliveAuditEntry(board.seq, decision, channel?.channel ?? "none", elapsed, outcome, error, now(), usage);
      board.lastAttempt = entry;
      board.lastOutcome = outcome;
      board.lastReason = decision.reason;
      emit(entry);
    }
  };

  // ── 事件接线（全部为宿主公开事件；每 board 独立状态）──
  const onEvent = (name, handler) => {
    if (typeof ctx?.on !== "function") return;
    try {
      const off = ctx.on(name, handler);
      if (typeof off === "function") offs.push(off);
    } catch { /* 事件面不被宿主支持 ⇒ 静默（特性探测） */ }
  };

  const observeLiveAgentForBoard = (agent) => {
    const root = rootOfAgent(agent);
    if (!root) return null;
    let supId = null;
    try { supId = readSupervisorSessionFn(root); } catch { supId = null; }
    if (!supId || agent?.session?.id !== supId) return null;
    const agents = getService("agents");
    if (agents && typeof agents.get === "function" && agents.get(supId) !== agent) return null;
    return { root, supId, board: boardForRoot(root) };
  };

  onEvent("agent/request", async (payload, next) => {
    const config = await next();
    try {
      const agent = payload?.agent;
      const live = observeLiveAgentForBoard(agent);
      if (!live) return config;
      const { board } = live;
      if (board.supervisorAgent && board.supervisorAgent !== agent) resetBoard(board, "agent_replaced");
      board.supervisorId = live.supId;
      board.supervisorAgent = agent;
      board.session = agent.session ?? null;
      board.lastActivityAt = now();
      board.lastProposedConfig = config ?? null;
      board.snapshotStatus = "pending_observation";
      board.pendingObservation = { agent, session: agent.session ?? null, config: config ?? null, at: now() };
      resetWindow(board);
      scheduleBoard(board);
    } catch { /* 观察失败：不影响请求本身 */ }
    return config;
  });

  onEvent("llm/stream", (options, next) => {
    try {
      if (options && typeof options === "object" && !ownPingOptions.has(options) && options.purpose === undefined) {
        // 找到同 session 的 pending 观察（每 board 一份；并发主管间互不串）
        for (const board of boards.values()) {
          const pending = board.pendingObservation;
          if (!pending || pending.session?.id === undefined || pending.session.id !== options.sessionId) continue;
          const agentsNow = getService("agents");
          const liveExact = !agentsNow || typeof agentsNow.get !== "function" ? false : agentsNow.get(pending.session.id) === pending.agent;
          if (!liveExact) {
            invalidateSnapshot(board, "agent_replaced", { resetWindow: false });
            continue;
          }
          // loop-built 请求是 deep-frozen（0.2.1-rc.2 公开契约：arrives deep-frozen）；
          // 手搓辅助请求/本插件 ping 都不是冻结对象 ⇒ 不作为快照来源。
          if (!Object.isFrozen(options)) continue;
          if (!routeCompatible(pending.config, options)) {
            const routeMismatch = !pending.config
              || pending.config.provider !== options.provider
              || pending.config.model !== options.model;
            invalidateSnapshot(board, routeMismatch ? "route_changed" : "config_changed");
            continue;
          }
          const route = resolvedRouteOf(options);
          board.snapshot = {
            provider: route.provider,
            model: route.model,
            messages: options.messages,
            ...(options.system === undefined ? {} : { system: options.system }),
            ...(options.tools === undefined ? {} : { tools: options.tools }),
            ...(options.toolHistory === undefined ? {} : { toolHistory: options.toolHistory }),
            sessionId: options.sessionId,
            route,
            agent: pending.agent,
            session: pending.session,
            at: now(),
            fingerprint: routeFingerprint(route),
          };
          board.snapshotStatus = "ready";
          board.pendingObservation = null;
          board.lastLlmAt = now();
          board.lastActivityAt = now();
          break;
        }
      }
    } catch { /* 观察失败不影响请求 */ }
    for (const board of boards.values()) scheduleBoard(board);
    return next();
  });

  onEvent("agent/created", (payload) => {
    try {
      const agent = payload?.agent;
      const live = observeLiveAgentForBoard(agent);
      if (!live) return;
      const { board } = live;
      const replaced = board.supervisorAgent && board.supervisorAgent !== agent;
      board.supervisorId = live.supId;
      board.supervisorAgent = agent;
      board.session = agent.session ?? null;
      if (replaced) resetBoard(board, "agent_replaced");
      else if (board.snapshotStatus === "ready") {
        // 同 Agent 的 clear/compact（agent/created source）：表面可能已被替换 ⇒ 失效并在途 abort。
        invalidateSnapshot(board, payload?.source === "startup" ? "no_snapshot" : "agent_replaced");
      } else if (payload?.source && payload.source !== "startup") {
        invalidateSnapshot(board, "agent_replaced");
      }
      resetWindow(board);
      scheduleBoard(board);
    } catch { /* 忽略 */ }
  });

  onEvent("agent/disposed", (payload) => {
    try {
      const agent = payload?.agent;
      if (!agent) return;
      for (const board of boards.values()) {
        if (board.supervisorAgent !== agent && board.supervisorId !== agent.session?.id) continue;
        board.supervisorAgent = null;
        board.session = null;
        resetBoard(board, "no_supervisor");
        board.snapshotStatus = "no_supervisor";
        scheduleBoard(board);
      }
    } catch { /* 忽略 */ }
  });

  onEvent("agent/status", (payload) => {
    try {
      const agent = payload?.agent;
      const board = boardOfAgent(agent);
      if (!board || board.supervisorAgent !== agent) return;
      if (payload?.status === "running") {
        board.lastActivityAt = now();
        resetWindow(board);
        abortInflight(board, "keepalive-activity");
      }
      // running/idle 都重排：维护结束后的 idle 事件让保活尽快继续（无需固定轮询）。
      scheduleBoard(board);
    } catch { /* 忽略 */ }
  });

  onEvent("agent/inbox/inserted", (payload) => {
    try {
      const agent = payload?.agent;
      const board = boardOfAgent(agent);
      if (!board || board.supervisorAgent !== agent) return;
      board.lastActivityAt = now();
      const source = payload?.message?.source;
      if (source && typeof source === "object" && source.kind === "user") board.lastHumanAt = now();
      resetWindow(board);
      abortInflight(board, "keepalive-input");
      scheduleBoard(board);
    } catch { /* 忽略 */ }
  });

  // 同 Agent 的 compaction/clear/surface 替换：会话可见表面被替换 ⇒ 旧前缀快照失效。
  onEvent("session/event", (session, event) => {
    try {
      // cordis 事件按位置参数派发：'session/event'(session, event)（不是单个 payload 对象）。
      if (!session?.id) return;
      const board = [...boards.values()].find((b) => b.supervisorId === session.id || b.session === session);
      if (!board) return;
      const surfaceOp = event?.surfaceOp;
      const isReplacement = !!surfaceOp && typeof surfaceOp === "object" && surfaceOp.op === "replace";
      const isCompactionOrClear = typeof event?.type === "string" && /(compact|clear)/i.test(event.type);
      if (isReplacement || isCompactionOrClear) {
        invalidateSnapshot(board, "surface_replaced");
        scheduleBoard(board);
      }
    } catch { /* 忽略 */ }
  });

  const start = () => {
    if (started || disposed) return;
    started = true;
    ensureDefaultBoard();
    // 先发现已有 live 主管 board（含默认 workspace），再逐 board 安排单次 deadline。
    for (const root of candidateRoots()) boardForRoot(root);
    for (const board of boards.values()) scheduleBoard(board);
  };

  const dispose = () => {
    if (disposed) return;
    generation += 1;
    disposed = true;
    for (const board of boards.values()) {
      abortInflight(board, "keepalive-dispose");
      board.snapshot = null;
      board.pendingObservation = null;
      board.snapshotStatus = "disposed";
      board.lastDecision = null;
      board.lastReason = "disabled_by_config";
      board.inflight = false;
      board.controller = null;
      clearBoardTimer(board);
    }
    for (const off of offs.splice(0)) { try { off?.(); } catch { /* 忽略 */ } }
  };

  const statusFor = (rootArg) => {
    // 对外契约：rootArg 是**已归一 graph root**（apply 的 rootFor / 测试的 canonical root）；
    // workspace→root 的换算是调用方的显式边界，statusFor 绝不再二次解析。
    const requested = rootArg ? boardRootKey(rootArg) : defaultRoot();
    let board = requested ? boards.get(requested) ?? null : null;
    if (!board && requested) board = boardForRoot(requested);
    if (!board) board = boards.values().next().value ?? null;
    let cfg = null;
    let globalState = { enabled: null, malformed: false, available: false, raw: "" };
    let resolution = keepAliveResolutionOf(null, null, false, false);
    let configError = false;
    if (disposed) {
      configError = true;
      resolution = { enabled: false, project_mode: "inherit", global_enabled: null, source: "project_invalid", malformed: true };
    } else if (board) {
      try {
        cfg = readProjectConfigFn(board.root);
        globalState = readGlobal() ?? globalState;
        resolution = keepAliveResolutionOf(
          cfg?.supervisor,
          globalState.enabled ?? null,
          globalState.malformed === true,
          globalState.available !== false,
        );
      } catch {
        // 读配置异常 ⇒ fail-closed：绝不投影 effective=true / 虚假可用。
        configError = true;
        resolution = { enabled: false, project_mode: "inherit", global_enabled: null, source: "project_invalid", malformed: true };
      }
    }
    if (!requested) {
      resolution = { enabled: false, project_mode: "inherit", global_enabled: null, source: "project_invalid", malformed: true };
      configError = true;
    }
    const agent = board?.supervisorAgent ?? null;
    const snapProblem = board ? snapshotProblemForBoard(board, agent) : "no_supervisor";
    const llm = getService("llm");
    const agents = getService("agents");
    // g-625：与调度器 capabilityOf 同一收口探测归属能力（rc.1 isOwnedBy / rc.3 rootOf）。
    const ownership = ownershipProbeOf(agents, getService("subagents"), { requireLiveTree: true });
    const ttlEntry = cfg?.supervisor?.keep_alive_ttl ?? null;
    const ttlMatched = routeMatchesTtl(ttlEntry, board?.snapshot?.route) ? ttlEntry : null;
    let channel = resolveKeepAliveChannel(
      {
        // 必须与调度器 capabilityOf 完全同口径（get/list + 归属探测 + prepareCall/stream），
        // 否则 status 会宣称 capable 而实际调度路径无法枚举/调用。
        llm: !!(llm && typeof llm.prepareCall === "function" && typeof llm.stream === "function"),
        agents: !!(agents && typeof agents.get === "function" && typeof agents.list === "function" && ownership.supported),
        status: !!agent && (agent.status === "idle" || agent.status === "running"),
        maintenance: !!agent && typeof agent.runMaintenance === "function",
        snapshot: snapProblem === null,
      },
      ttlMatched ? { cacheTtlMs: ttlMatched.ttl_ms } : null,
    );
    if (configError) {
      channel = { ...channel, channel: "none", reason: "missing_capability", exempt: false, missing: [...channel.missing, disposed ? "plugin.disposed" : "project.config"] };
    }
    const decision = board?.lastDecision;
    return keepAliveStatusProjection({
      resolution,
      projectMalformed: cfg?.supervisor?.keep_alive_malformed === true,
      globalRaw: globalState.raw ?? "",
      globalMalformed: globalState.malformed === true,
      globalAvailable: globalState.available !== false,
      configError,
      routeTtl: configError ? null : ttlEntry,
      routeTtlMalformed: cfg?.supervisor?.keep_alive_ttl_malformed === true,
      routeTtlMatched: !!ttlMatched,
      channel,
      active: {
        phase: board?.afk ? "afk" : (decision?.phase ?? "disabled"),
        reason: board?.lastReason ?? "disabled_by_config",
        afk: board?.afk === true,
        pings_in_window: board?.pingsInWindow ?? 0,
        stage2_used: board?.stage2Used === true,
        inflight: board?.inflight === true,
        supervisor_session: board?.supervisorId ?? null,
        children_running: agent ? sampleRunningChildren(agent) : null,
        idle: agent ? sampleIdle(agent) : null,
        snapshot: snapProblem === null ? "ready" : snapProblem,
        last_llm_at: board?.lastLlmAt ?? null,
        last_ping_at: board?.lastPingAt ?? null,
        last_attempt_at: board?.lastAttemptAt ?? null,
        last_success_at: board?.lastSuccessAt ?? null,
        last_activity_at: board?.lastActivityAt ?? null,
        last_attempt: board?.lastAttempt ?? null,
        seq: board?.seq ?? 0,
      },
    });
  };

  return {
    start,
    dispose,
    sweep,
    statusFor,
    snapshotProblem,
    stateFor: (root) => boards.get(boardRootKey(root)) ?? null,
    /** 显式 workspace→graph root 边界（供需要从 workspace 查询的调用方；内部不做二次解析）。 */
    rootOfWorkspace: (workspace) => canonicalRootOfWorkspace(workspace),
    stateForWorkspace: (workspace) => {
      const root = canonicalRootOfWorkspace(workspace);
      return root ? boards.get(root) ?? null : null;
    },
    stateOf: (agent) => boardOfAgent(agent),
    states: () => [...boards.values()],
    rootOfAgent,
    get state() { return ensureDefaultBoard() ?? boards.values().next().value ?? null; },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// g-506：子代理长任务关照（宿主接线；判定真源在 core/care.ts）
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// 真源分工（单一真源，宿主不重写判定）：
//   · 配置解析 / 调度状态机 / 巡检记录校验 / 计数与人工锁 / 暂停继续重置 全在 core/care.ts；
//   · 宿主只负责：采样真实运行态、`runMaintenance` 短临界区投递、窄工具身份/新鲜度校验、
//     以及把同一份投影下发给 REST/UI。
//
// 采样口径（全部公开面，绝不猜）：
//   · 主管：project.yaml 的 supervisor.session → `agents.get(sid)`（**必须**是同一 live Agent）；
//   · 子代理任务：catalog（board payload 的 attempt_binding）∩ live registry
//     （g-625：`agents.get(child)` + 归属探测收口 `ownershipProbeOf`（rc.1 `isOwnedBy` / rc.3
//     `rootOf`）+ `status === "running"`）；归属不可确认一律按 unknown fail-closed。
//   · **绝不**用 mtime/size、durable 目录、隐藏思维或 `listDescendants.activity` 冒充运行/进展。
//   · 进展证据只来自**主管**通过窄工具提交的有界证据摘要；`unknown`/未回复不计数。
//
// 投递边界（判据 2/7）：
//   · 到期不打断忙主管；`runMaintenance` 同步抢占**真 idle**（忙则同步 throw ⇒ 有界重排）；
//   · 回调内**不 await**：重验 generation/revision/身份/config/绑定后构造真实 UserMessage，
//     用独立 care source（禁冒充 human）调用 `agent.send(message, "next-turn", true)`，立即结束维护；
//   · `send` 返回 void ⇒ 只记为 queued；`agent/inbox/inserted` 才是 delivered，
//     `claimed` 才表示主管即将处理；工具回传结论才是 answered。绝不把 send 当处理完成。
//
// 有界与仲裁：
//   · 每组（workspace root + 主管）唯一 deadline/revision/paused/inspection 记录；
//   · 单次投递一个巡检覆盖**本轮全部到期任务**（有界成本），复核间隔默认 300s；
//   · 连续 3 份**新鲜且未解决**的 no-progress 结论 ⇒ 人工裁决锁（sticky，progress 不清锁）；
//   · 任何异常都被吞掉并留结构化 stderr，绝不影响工具/看板/既有生命周期。
//
// 自举（g-506 返工，3110 真实缺口：目标 workspace 不是启动默认根 + 主管晚 claim）：
//   · `armForRoot(root)`：claim 成功后由**事件链**显式布防该 canonical root（幂等：一 root 单 timer）；
//     布防前重验「project.yaml supervisor.session == registry 里同一 live Agent」且该 Agent 的
//     workspace 真解析到本 root（禁止给非主管/foreign agent 装错 root 的 timer）。
//   · `agent/status` / `agent/created`：先走已绑定快路径；未绑定时做**只读**身份校验后 idempotent 布防
//     （自然 turn-end 就是生产事件，不依赖用户打开设置页/手工 sweep/客户端 GET）。
//   · **有界后台发现**：仅当尚无任何 root 布防时启动，只在 registry 上做只读身份核对（零模型请求/
//     零投递），间隔与次数都有上界（默认 30s × 20 ≈ 10 分钟；可注入覆盖），一旦有 root 布防即停止。
//   · `statusFor` 保持**纯读**：读接口绝不装 timer（不以客户端 GET 作为自举真源）。

export const CARE_CONFIG_RECHECK_MS = 30_000;
export const CARE_BUSY_RECHECK_MS = 5_000;
export const CARE_MAINTENANCE_RETRY_MS = 10_000;
export const CARE_RETRY_MS = 30_000;
/**
 * g-613：复用投递的确认等待上限（ms）。超时即按「**不确定 = 未投递**」fail-closed 处理：
 * 宿主 `sendMessage` 正常在毫秒级返回 inbox id，长时间无回执意味着无法证明消息被受理。
 */
export const REUSE_DELIVERY_TIMEOUT_MS = 15_000;
/** 有界自举发现：检查间隔（只读 registry/project.yaml，无模型请求、无投递）。 */
export const CARE_ARM_DISCOVERY_INTERVAL_MS = 30_000;
/** 有界自举发现：最多尝试次数（≈ 10 分钟窗口；之后由 claim 事件与 agent 事件继续兜底）。 */
export const CARE_ARM_DISCOVERY_MAX_ATTEMPTS = 20;
export const CARE_OUTCOME_TOOL = "graph_care_outcome";

/**
 * 构造一条**真实宿主可接受**的 UserMessage（角色 user + 自定义 source kind）。
 *
 * 公开契约核实（0.2.1-rc.2）：
 *   · `MessageSourceMap` 是**可合并扩展**的 Sum Type（各 producer 声明自己的 kind，无 catch-all）；
 *   · `Session` 的 user/message 校验只要求 `source.kind` 为非空字符串 + content 数组；
 *   · `createUserMessage` 的公开实现只做 `{...input, role:"user"}` + 新 id + 深冻结。
 * 产品插件不静态 import `@deepseek-ai/*`，故这里按同一公开形状构造，并**深冻结**；
 * source kind 用插件独有 `dsh-graph-care`，绝不冒充 `user`/`model`/`tool`。
 */
export function createCareUserMessage(input, deps = {}) {
  const id = typeof deps.id === "string" && deps.id ? deps.id : randomUUID();
  const content = [Object.freeze({ type: "text", text: String(input.text ?? "") })];
  const source = Object.freeze({ ...input.source });
  return Object.freeze({
    id,
    role: "user",
    content: Object.freeze(content),
    source,
  });
}

/**
 * 创建关照运行时（宿主 apply 内使用；测试可注入真实宿主服务 + 假时钟/假定时器）。
 *
 * @param options.ctx 插件上下文（读取 `agents`/`subagents`；注册公开事件）
 * @param options.readGlobal `() => {enabled,thresholdSeconds,recheckSeconds,malformed,...}`
 * @param options.resolveRoot `(workspace) => canonical graph root`
 * @param options.defaultWorkspace `() => workspaceRoot|null`
 * @param options.readBoardPayload `(root) => board payload|null`（catalog；只读）
 * @param options.readSupervisorSessionFn / readProjectConfigFn 可注入（测试/降级）
 * @param options.now/setTimeoutFn/clearTimeoutFn 可注入时钟与定时器
 * @param options.appendEventFn 事件先行写入（默认真实 events.jsonl 追加）
 * @param options.makeInspectionId 服务端 inspection id 生成（默认 randomUUID）
 */
export function createCareRuntime(options = {}) {
  const {
    ctx,
    readGlobal = () => ({ enabled: null, thresholdSeconds: null, recheckSeconds: null, malformed: false, available: false, raw: "" }),
    resolveRoot = null,
    defaultWorkspace = () => null,
    readProjectConfigFn = readProjectConfig,
    readSupervisorSessionFn = readSupervisorSession,
    readBoardPayload = () => null,
    now = () => Date.now(),
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (h) => clearTimeout(h),
    appendEventFn = appendEvent,
    makeInspectionId = () => randomUUID(),
    configRecheckMs = CARE_CONFIG_RECHECK_MS,
    busyRecheckMs = CARE_BUSY_RECHECK_MS,
    maintenanceRetryMs = CARE_MAINTENANCE_RETRY_MS,
    retryMs = CARE_RETRY_MS,
    armDiscoveryIntervalMs = CARE_ARM_DISCOVERY_INTERVAL_MS,
    armDiscoveryMaxAttempts = CARE_ARM_DISCOVERY_MAX_ATTEMPTS,
    log = null,
  } = options;

  const offs = [];
  const entries = new Map(); // root → entry
  let started = false;
  let disposed = false;
  let generation = 0;
  // 有界自举发现（仅当没有任何 root 布防时使用；见文件头「自举」小节）。
  let discoveryTimer = null;
  let discoveryAttempts = 0;

  const getService = (name) => {
    try { return typeof ctx?.get === "function" ? ctx.get(name) : null; } catch { return null; }
  };
  const emitAudit = (entry) => {
    try {
      if (typeof log === "function") log(formatCareAudit(entry));
      else process.stderr.write(`[dsh-graph-host] ${formatCareAudit(entry)}\n`);
    } catch { /* 审计失败绝不影响主流程 */ }
  };

  const canonicalRootOfWorkspace = (workspace) => {
    if (!workspace || typeof workspace !== "string") return null;
    if (typeof resolveRoot !== "function") return null;
    try {
      const resolved = resolveRoot(workspace);
      return typeof resolved === "string" && resolved ? resolved : null;
    } catch { return null; }
  };
  const boardRootKey = (root) => (typeof root === "string" && root && isAbsolute(root) ? root : null);
  const rootOfAgent = (agent) => {
    try {
      const ws = agent?.session?.header?.cwd;
      return ws ? canonicalRootOfWorkspace(ws) : null;
    } catch { return null; }
  };
  const defaultRoot = () => {
    try {
      const ws = typeof defaultWorkspace === "function" ? defaultWorkspace() : null;
      return ws ? canonicalRootOfWorkspace(ws) : null;
    } catch { return null; }
  };

  const CARE_STATE_VERSION = 1;
  const makeEntry = (root) => ({
    root,
    startedAt: now(),
    supervisorId: null,
    supervisorAgent: null,
    group: newCareGroupState(),
    tasks: new Map(),
    inspections: new Map(),
    messageIndex: new Map(),
    /** g-612：已观察到的 supervisor→child message.id（幂等；有界）。 */
    seenMessageIds: new Map(),
    /** g-612：child 未在 tasks 中时先记录的主管消息基准（idle 唤醒路径）。 */
    pendingMessageBases: new Map(),
    /** g-612：child 未在 tasks 中时先观察到的 running 起点（status 事件精确时点）。 */
    pendingRunStarts: new Map(),
    /** g-612：已停止 run 的有界历史（项目内）。 */
    runs: [],
    /**
     * g-612：同一 child+attempt+bindingVersion **短暂停止（natural idle）后的计数**。
     * 键 `${child}\0${attempt}`；不是「任务仍在运行」的证据，也绝不参与调度/倒计时；
     * 只在该身份以同一 bindingVersion 重新 running 时恢复
     * `humanLocked/humanReason/stagnantRounds/remindersSent/awaitingReply`。
     * 人工锁条目只在真实绑定换代（bindingVersion 变化）或合法人类操作后消失，不被容量回收。
     */
    dormant: new Map(),
    timer: null,
    timerDueAt: null,
    retryNotBefore: null,
    sweeping: false,
    delivering: false,
    lastDecision: null,
    capabilities: null,
    configError: false,
    persistenceError: null,
    transportFailures: 0,
    lastOutcome: null,
    seq: 0,
    lastReason: "disabled_by_config",
    /**
     * g-618：「本主管会话已收到过完整纪律」的持久标记（随 care.* 事件快照落盘，重启可恢复）。
     * 粒度 = **主管会话**（keyed by supervisorId）：换主管会话 / 宿主重启（新会话 id）均视为首次。
     */
    disciplineSeen: null,
  });

  /** g-506 返工 B5：把一组 care 状态压成事件里的快照（只在 care.* 事件 details.care_state）。 */
  const careStateSnapshot = (entry, opts = {}) => {
    const group = opts.group ?? entry.group;
    const tasks = opts.tasks ?? [...entry.tasks.values()];
    const inspections = opts.inspections ?? [...entry.inspections.values()];
    const pending = inspections.filter((i) => i.status === "queued" || i.status === "delivered"
      || i.status === "claimed");
    const resolved = inspections.filter((i) => i.status === "resolved" || i.status === "expired"
      || i.status === "failed").slice(-8);
    return {
      version: CARE_STATE_VERSION,
      root: entry.root,
      supervisor: entry.supervisorId ?? null,
      group,
      tasks,
      /** g-612：idle 后保留的逐任务计数（同 bindingVersion 复跑时恢复；有界）。 */
      dormant: [...(opts.dormant ?? entry.dormant?.values?.() ?? [])].filter(Boolean),
      inspections: [...pending, ...resolved],
      runs: Array.isArray(entry.runs) ? entry.runs.slice(-CARE_RUN_HISTORY_LIMIT) : [],
      transportFailures: entry.transportFailures ?? 0,
      lastOutcome: entry.lastOutcome ?? null,
      seq: entry.seq ?? 0,
      // g-618（加法式字段，不升 version）：旧快照无此键 ⇒ null ⇒ 重启后按「首次」处理。
      // 必须支持 `opts` 覆盖：首发的那一份要在**同一份**快照里就把「本会话已看过纪律」落盘
      // （投递前entry 上还是旧值；漏读 opts 会让标记永远停在旧值 ⇒ 重启后误判为首次，纪律白省）。
      disciplineSeen: (opts.disciplineSeen ?? entry.disciplineSeen) ?? null,
    };
  };

  const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  /** 预算历史有界上限：1 条真实起点 + 最近 31 条变化（总计 32）。 */
  const BUDGET_HISTORY_LIMIT = 32;
  const BUDGET_CHANGE_LIMIT = BUDGET_HISTORY_LIMIT - 1;
  const BUDGET_SOURCES = ["goal", "project_explicit", "global_explicit", "global_default"];
  /** 只校验/归一，**不排序**：同毫秒的多次变化必须保留真实追加/事件顺序（不得按值猜）。 */
  const normalizeBudgetHistory = (raw) => {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const at = Number(entry.at);
      const seconds = normalizeCareSeconds(entry.seconds);
      const source = BUDGET_SOURCES.includes(String(entry.source)) ? entry.source : null;
      if (!Number.isFinite(at) || seconds === null || !source) continue;
      out.push({ at, seconds, source });
    }
    return out;
  };
  /** 上限裁剪：**恒保留首项（真实起点）**，只淘汰最旧的变化；返回截断标志。 */
  const capBudgetHistory = (history) => {
    const arr = Array.isArray(history) ? history : [];
    if (arr.length <= BUDGET_HISTORY_LIMIT) return { history: arr, truncated: false };
    return { history: [arr[0], ...arr.slice(1).slice(-BUDGET_CHANGE_LIMIT)], truncated: true };
  };
  /** run 只存变化时间线（起点另存 budgetSeconds/source）：超限时保留最近 31 条并标截断。 */
  const capBudgetChanges = (changes) => {
    const arr = Array.isArray(changes) ? changes : [];
    if (arr.length <= BUDGET_CHANGE_LIMIT) return { changes: arr, truncated: false };
    return { changes: arr.slice(-BUDGET_CHANGE_LIMIT), truncated: true };
  };
  /** 本轮**起始**预算（只读历史首项）；没有可信起点 ⇒ unknown（绝不拿当前值回填）。 */
  const budgetInitialOf = (task) => {
    const history = Array.isArray(task?.budgetHistory) ? task.budgetHistory : [];
    return history.length ? history[0] : null;
  };
  const budgetChangesOf = (task) => {
    const history = Array.isArray(task?.budgetHistory) ? task.budgetHistory : [];
    return history.length > 1 ? history.slice(1) : [];
  };
  /**
   * 只在**已存在可信起点**时追加一次生效预算变化；无起点（旧快照）保持 unknown。
   * 有界模型：起点恒保留 + 最近 31 条变化；淘汰过变化 ⇒ `truncated=true`（只增不减）。
   */
  const recordBudgetChange = (task, at, seconds, source) => {
    const history = Array.isArray(task?.budgetHistory) ? task.budgetHistory : null;
    const priorTruncated = task?.budgetHistoryTruncated === true;
    if (!history || history.length === 0) return { history: history ?? undefined, truncated: priorTruncated };
    const last = history[history.length - 1];
    if (last.seconds === seconds && last.source === source) return { history, truncated: priorTruncated };
    const capped = capBudgetHistory([...history, { at, seconds, source }]);
    return { history: capped.history, truncated: priorTruncated || capped.truncated };
  };
  /**
   * g-612 att011：**起点不可证**（旧快照/观察晚于 run 起点）的轮次里，真实 owner 通过公开入口
   * 修改 goal 预算仍然发生了（`notifyGoalBudgetChanged` 带真实生效时点）。不能因为 initial 未知
   * 就把这些真实变化全部丢掉并对外表现为「整轮未变更」：按真实时点/顺序单独记为**有界**观察列表
   * （最多 31 条 + truncated），run 上同时标 `budget_history_incomplete=true` 明示起点缺失。
   */
  const recordUnknownInitialBudgetChange = (task, at, seconds, source) => {
    const list = Array.isArray(task?.budgetUnknownChanges) ? task.budgetUnknownChanges : [];
    const priorTruncated = task?.budgetUnknownChangesTruncated === true;
    const last = list.length ? list[list.length - 1] : null;
    if (last && last.seconds === seconds && last.source === source) return null;
    const capped = capBudgetChanges([...list, { at, seconds, source }]);
    return { changes: capped.changes, truncated: priorTruncated || capped.truncated };
  };
  const normalizePersistedTask = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const child = String(raw.child ?? "");
    const attempt = String(raw.attempt ?? "");
    const goal = String(raw.goal ?? "");
    if (!child || !attempt || !goal) return null;
    const reason = raw.humanReason === "no_response_limit" || raw.humanReason === "no_progress_limit"
      ? raw.humanReason : null;
    const historyCap = capBudgetHistory(normalizeBudgetHistory(raw.budgetHistory));
    return {
      child,
      attempt,
      goal,
      bindingVersion: numberOr(raw.bindingVersion, 0),
      startedAt: numberOr(raw.startedAt, 0),
      lastProgressAt: raw.lastProgressAt === null || raw.lastProgressAt === undefined ? null : numberOr(raw.lastProgressAt, null),
      lastProgressFingerprint: typeof raw.lastProgressFingerprint === "string" ? raw.lastProgressFingerprint : null,
      stagnantRounds: Math.max(0, Math.floor(numberOr(raw.stagnantRounds, 0))),
      humanLocked: raw.humanLocked === true,
      lastCareAt: raw.lastCareAt === null || raw.lastCareAt === undefined ? null : numberOr(raw.lastCareAt, null),
      frozenRemainingMs: raw.frozenRemainingMs === null || raw.frozenRemainingMs === undefined ? null : Math.max(0, numberOr(raw.frozenRemainingMs, 0)),
      scheduleDueAt: raw.scheduleDueAt === null || raw.scheduleDueAt === undefined ? null : numberOr(raw.scheduleDueAt, null),
      remindersSent: Math.max(0, Math.floor(numberOr(raw.remindersSent, 0))),
      awaitingReply: raw.awaitingReply === true,
      humanReason: reason,
      // g-612：旧快照无这些字段 ⇒ null/undefined 继承，绝不伪造历史。
      budgetSeconds: normalizeCareSeconds(raw.budgetSeconds),
      budgetBaseAt: raw.budgetBaseAt === null || raw.budgetBaseAt === undefined ? null : numberOr(raw.budgetBaseAt, null),
      budgetCountdown: raw.budgetCountdown === true,
      budgetEffectiveSeconds: normalizeCareSeconds(raw.budgetEffectiveSeconds),
      budgetEffectiveSource: BUDGET_SOURCES.includes(String(raw.budgetEffectiveSource))
        ? raw.budgetEffectiveSource : null,
      runStartedAt: raw.runStartedAt === null || raw.runStartedAt === undefined ? null : numberOr(raw.runStartedAt, null),
      runStartSource: ["attempt_record", "agent_status", "sample", "unknown"].includes(String(raw.runStartSource))
        ? raw.runStartSource : null,
      runStartExact: raw.runStartExact === true,
      // g-612 返工：只读观察/预算历史/调整后冷却（旧快照缺省 ⇒ unknown，不回填）。
      lastObservedAt: raw.lastObservedAt === null || raw.lastObservedAt === undefined ? null : numberOr(raw.lastObservedAt, null),
      budgetHistory: historyCap.history,
      budgetHistoryTruncated: raw.budgetHistoryTruncated === true || historyCap.truncated,
      // g-612 att011：起点不可证时的真实可见预算变化（有界）与“历史不完整”标记。
      budgetUnknownChanges: capBudgetChanges(normalizeBudgetHistory(raw.budgetUnknownChanges)).changes,
      budgetUnknownChangesTruncated: raw.budgetUnknownChangesTruncated === true,
      budgetHistoryIncomplete: raw.budgetHistoryIncomplete === true,
      cooldownDueAt: raw.cooldownDueAt === null || raw.cooldownDueAt === undefined ? null : numberOr(raw.cooldownDueAt, null),
      frozenCooldownRemainingMs: raw.frozenCooldownRemainingMs === null || raw.frozenCooldownRemainingMs === undefined
        ? null : Math.max(0, numberOr(raw.frozenCooldownRemainingMs, 0)),
    };
  };
  const normalizePersistedRun = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id ?? "");
    const child = String(raw.child ?? "");
    const attempt = String(raw.attempt ?? "");
    const goal = String(raw.goal ?? "");
    if (!id || !child || !attempt || !goal) return null;
    const numOrNull = (v) => (v === null || v === undefined ? null : numberOr(v, null));
    const changesCap = capBudgetChanges(normalizeBudgetHistory(raw.budgetChanges));
    return {
      id,
      goal, attempt, child,
      startedAt: numOrNull(raw.startedAt),
      startSource: ["attempt_record", "agent_status", "sample", "unknown"].includes(String(raw.startSource))
        ? raw.startSource : "unknown",
      startExact: raw.startExact === true,
      stoppedAt: numOrNull(raw.stoppedAt),
      stopSource: ["agent_status", "disposed", "sample", "unknown"].includes(String(raw.stopSource))
        ? raw.stopSource : null,
      stopExact: raw.stopExact === true,
      budgetSeconds: normalizeCareSeconds(raw.budgetSeconds),
      budgetSource: BUDGET_SOURCES.includes(String(raw.budgetSource))
        ? raw.budgetSource : null,
      budgetChanges: changesCap.changes,
      budgetChangesTruncated: raw.budgetChangesTruncated === true || changesCap.truncated,
      budgetHistoryIncomplete: raw.budgetHistoryIncomplete === true || normalizeCareSeconds(raw.budgetSeconds) === null,
      naturalMs: numOrNull(raw.naturalMs),
      deviationMs: numOrNull(raw.deviationMs),
      overBudget: typeof raw.overBudget === "boolean" ? raw.overBudget : null,
      // g-612 返工：正常 runtime 重建的观察空窗/elapsed 可信度必须如实留档（不伪造连续）。
      observationInterrupted: raw.observationInterrupted === true,
      observationGaps: Array.isArray(raw.observationGaps)
        ? raw.observationGaps
          .map((g) => ({ from: numOrNull(g?.from), to: numOrNull(g?.to) }))
          .filter((g) => g.from !== null && g.to !== null && g.to >= g.from)
        : [],
      naturalExact: typeof raw.naturalExact === "boolean" ? raw.naturalExact : null,
    };
  };
  const normalizePersistedInspection = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id ?? "");
    if (!id || !Array.isArray(raw.targets)) return null;
    const status = ["queued", "delivered", "claimed", "resolved", "expired", "failed"].includes(String(raw.status))
      ? String(raw.status) : "failed";
    const targets = raw.targets.map((t) => ({
      goal: String(t?.goal ?? ""),
      attempt: String(t?.attempt ?? ""),
      child: String(t?.child ?? ""),
      bindingVersion: numberOr(t?.bindingVersion, 0),
      outcome: ["progress", "no-progress", "unknown"].includes(String(t?.outcome)) ? t.outcome : null,
      outcomeAt: t?.outcomeAt === null || t?.outcomeAt === undefined ? null : numberOr(t.outcomeAt, null),
      evidenceDigest: typeof t?.evidenceDigest === "string" ? t.evidenceDigest : null,
      // g-612：被后续事件取代的 target 标记（重启后晚到结论仍只作审计）。
      staleReason: ["superseded_by_message", "superseded_by_budget"].includes(String(t?.staleReason))
        ? t.staleReason : null,
      staleAt: t?.staleAt === null || t?.staleAt === undefined ? null : numberOr(t.staleAt, null),
      supersededBy: typeof t?.supersededBy === "string" && t.supersededBy ? t.supersededBy : null,
    })).filter((t) => t.goal && t.attempt && t.child);
    if (!targets.length) return null;
    return {
      id,
      root: String(raw.root ?? ""),
      supervisor: String(raw.supervisor ?? ""),
      createdAt: numberOr(raw.createdAt, 0),
      expiresAt: numberOr(raw.expiresAt, 0),
      revision: Math.floor(numberOr(raw.revision, 0)),
      status,
      messageId: typeof raw.messageId === "string" ? raw.messageId : null,
      targets,
      deliveredAt: raw.deliveredAt === null || raw.deliveredAt === undefined ? null : numberOr(raw.deliveredAt, null),
      claimedAt: raw.claimedAt === null || raw.claimedAt === undefined ? null : numberOr(raw.claimedAt, null),
      resolvedAt: raw.resolvedAt === null || raw.resolvedAt === undefined ? null : numberOr(raw.resolvedAt, null),
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    };
  };

  /** 事件真源恢复（最后一条 care_state 快照）。损坏/越界 ⇒ fail-closed，绝不重建错误的锁。 */
  const loadCareState = (entry) => {
    let events;
    try { events = readEvents(entry.root); } catch { entry.persistenceError = "events_unreadable"; return; }
    let state = null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (!ev || !String(ev.event ?? "").startsWith("care.")) continue;
      const candidate = ev?.details?.care_state;
      if (!candidate || typeof candidate !== "object") continue;
      state = candidate;
      break;
    }
    if (!state) return;
    if (state.version !== CARE_STATE_VERSION || String(state.root ?? "") !== entry.root) {
      entry.persistenceError = "state_scope_mismatch";
      return;
    }
    const g = state.group && typeof state.group === "object" ? state.group : {};
    entry.group = {
      ...newCareGroupState(),
      paused: g.paused === true,
      pausedAt: g.pausedAt === null || g.pausedAt === undefined ? null : numberOr(g.pausedAt, null),
      pausedRemainingMs: g.pausedRemainingMs === null || g.pausedRemainingMs === undefined ? null : Math.max(0, numberOr(g.pausedRemainingMs, 0)),
      resetAt: g.resetAt === null || g.resetAt === undefined ? null : numberOr(g.resetAt, null),
      lastDeliveryAt: g.lastDeliveryAt === null || g.lastDeliveryAt === undefined ? null : numberOr(g.lastDeliveryAt, null),
      escalated: g.escalated === true,
      revision: Math.max(0, Math.floor(numberOr(g.revision, 0))),
      lastControl: ["pause", "resume", "reset"].includes(String(g.lastControl)) ? g.lastControl : null,
      lastControlAction: ["pause", "resume", "reset"].includes(String(g.lastControlAction)) ? g.lastControlAction : null,
      lastControlAt: g.lastControlAt === null || g.lastControlAt === undefined ? null : numberOr(g.lastControlAt, null),
      lastControlRequestId: typeof g.lastControlRequestId === "string" ? g.lastControlRequestId : null,
    };
    entry.tasks = new Map();
    entry.runs = [];
    for (const raw of Array.isArray(state.runs) ? state.runs : []) {
      const run = normalizePersistedRun(raw);
      if (run) entry.runs.push(run);
    }
    for (const raw of Array.isArray(state.tasks) ? state.tasks : []) {
      let t = normalizePersistedTask(raw);
      if (!t) continue;
      // g-612 返工：快照里的「开放 run」属于**上一个宿主**。正常 dispose/recreate 后同一 child
      // 可能仍在 running ⇒ 继续关联**同一条** open run（不立即写「停止未知」再另起一条）。
      // 停机窗口未被观察：如实记录 observationInterrupted + 可证空窗，绝不伪称连续。
      // 真实 stop 仍由本宿主的公开 registry/agent/status 观测后收尾（同一 run id 幂等更新）。
      if (t.runStartedAt != null || t.runStartSource) {
        // start 可证 ⇒ 稳定 id；start 未知 ⇒ 复用同 child/attempt 的既有 open run（避免二次重启
        // 生成新 id 与已持久化的 open run 重复），否则才生成唯一 id。
        const runId = t.runStartedAt != null ? runIdOf(t, t.runStartedAt) : (openRunOf(entry, t)?.id ?? runIdOf(t, null));
        const observedFrom = typeof t.lastObservedAt === "number" && Number.isFinite(t.lastObservedAt)
          ? t.lastObservedAt : null;
        const observedTo = now();
        const gaps = observedFrom !== null && Number.isFinite(observedTo) && observedTo >= observedFrom
          ? [{ from: observedFrom, to: observedTo }]
          : [];
        const initial = budgetInitialOf(t);
        const run = {
          id: runId,
          goal: t.goal, attempt: t.attempt, child: t.child,
          startedAt: t.runStartedAt ?? null,
          startSource: t.runStartSource ?? "unknown",
          startExact: t.runStartExact === true,
          stoppedAt: null,
          // `null` = 仍是 open run（不是「已停止但时点未知」）；绝不在这里宣称已停止。
          stopSource: null,
          stopExact: false,
          budgetSeconds: initial ? initial.seconds : null,
          budgetSource: initial ? initial.source : null,
          budgetChanges: initial ? budgetChangesOf(t) : (Array.isArray(t.budgetUnknownChanges) ? t.budgetUnknownChanges : []),
          budgetChangesTruncated: initial ? t.budgetHistoryTruncated === true : t.budgetUnknownChangesTruncated === true,
          budgetHistoryIncomplete: !initial || t.budgetHistoryIncomplete === true,
          naturalMs: null, deviationMs: null, overBudget: null,
          observationInterrupted: true,
          observationGaps: gaps,
          naturalExact: null,
        };
        const at = entry.runs.findIndex((r) => r.id === run.id);
        if (at >= 0) entry.runs[at] = run;
        else entry.runs.push(run);
        // 保留 runStartedAt/runStartSource：下一轮 reconcile 以**同一 run id** 继续关联，
        // 真实 idle/gone 时才由 closeTaskRun 幂等收尾（绝不重复/拉长）。
      }
      entry.tasks.set(`${t.child}\u0000${t.attempt}`, t);
    }
    entry.dormant = new Map();
    for (const raw of Array.isArray(state.dormant) ? state.dormant : []) {
      const d = normalizePersistedTask(raw);
      if (!d) continue;
      entry.dormant.set(`${d.child}\u0000${d.attempt}`, {
        ...d, runStartedAt: null, runStartSource: null, runStartExact: false,
      });
    }
    trimDormant(entry);
    // g-612：从独立的 care.run 停止事件恢复历史（即使最后快照/后续无 care 事件也不丢）。
    const seenRunIds = new Set(entry.runs.map((r) => r.id));
    for (const ev of events) {
      if (!ev || ev.event !== "care.run") continue;
      const run = normalizePersistedRun(ev?.details?.run);
      if (!run || seenRunIds.has(run.id)) continue;
      seenRunIds.add(run.id);
      entry.runs.push(run);
    }
    entry.runs = entry.runs
      .sort((a, b) => (a.stoppedAt ?? a.startedAt ?? 0) - (b.stoppedAt ?? b.startedAt ?? 0))
      .slice(-CARE_RUN_HISTORY_LIMIT);
    // g-612：重启后同一 message.id 仍幂等（只存 id/时间，不存消息正文）。
    entry.seenMessageIds = new Map();
    for (const ev of events) {
      if (!ev || ev.event !== "care.message") continue;
      const mid = String(ev?.details?.message_id ?? "");
      if (!mid) continue;
      const at = numberOr(ev?.details?.at, numberOr(ev?.ts, 0));
      entry.seenMessageIds.set(mid, at);
      if (entry.seenMessageIds.size > 512) {
        const oldest = entry.seenMessageIds.keys().next().value;
        if (oldest !== undefined) entry.seenMessageIds.delete(oldest);
      }
    }
    entry.inspections = new Map();
    entry.messageIndex = new Map();
    for (const raw of Array.isArray(state.inspections) ? state.inspections : []) {
      const ins = normalizePersistedInspection(raw);
      if (!ins || ins.root !== entry.root) continue;
      // 重启前已发送但未收到结论：一律按 delivered 恢复，**绝不重发**同一条巡检；
      // 未解决会自然过期，随后按 3 次未回复预算继续（或进入等待人工）。
      if (ins.status === "queued") ins.status = "delivered";
      entry.inspections.set(ins.id, ins);
      if (ins.messageId) entry.messageIndex.set(ins.messageId, ins.id);
    }
    entry.supervisorId = typeof state.supervisor === "string" && state.supervisor ? state.supervisor : null;
    entry.disciplineSeen = normalizeDisciplineSeen(state.disciplineSeen);
    entry.transportFailures = Math.max(0, Math.floor(numberOr(state.transportFailures, 0)));
    entry.lastOutcome = state.lastOutcome && typeof state.lastOutcome === "object" ? state.lastOutcome : null;
    entry.seq = Math.max(0, Math.floor(numberOr(state.seq, 0)));
  };

  const appendCareEvent = (entry, event, details, state, actor = null) => appendEventFn(entry.root, {
    actor: actor ?? `supervisor:${entry.supervisorId ?? "unknown"}`,
    event,
    details: { ...details, care_state: state ?? careStateSnapshot(entry) },
  });

  const entryOfRoot = (root, create = true) => {
    const key = boardRootKey(root);
    if (!key) return null;
    let entry = entries.get(key);
    if (!entry && create) {
      entry = makeEntry(key);
      // g-506 返工 B5：事件真源恢复必须发生在任何采样/调度之前；损坏则 fail-closed 不投递。
      loadCareState(entry);
      entries.set(key, entry);
    }
    return entry ?? null;
  };
  const entryOfAgent = (agent) => {
    if (!agent) return null;
    const sid = agent?.session?.id ?? agent?.id ?? null;
    for (const entry of entries.values()) {
      if (entry.supervisorAgent === agent) return entry;
      if (sid && entry.supervisorId === sid) return entry;
    }
    return null;
  };

  const clearTimer = (entry) => {
    if (!entry || entry.timer === null) return;
    try { clearTimeoutFn(entry.timer); } catch { /* 忽略 */ }
    entry.timer = null;
    entry.timerDueAt = null;
  };
  const clearAllTimers = () => { for (const entry of entries.values()) clearTimer(entry); };

  const supervisorOf = (root) => {
    let sid = null;
    try { sid = readSupervisorSessionFn(root); } catch { sid = null; }
    if (!sid) return { sid: null, agent: null, live: false };
    const agents = getService("agents");
    let agent = null;
    try { agent = typeof agents?.get === "function" ? agents.get(sid) : null; } catch { agent = null; }
    const live = !!agent && (agent?.session?.id === sid || agent?.id === sid);
    return { sid, agent: live ? agent : null, live };
  };

  const statusOf = (agent) => {
    try {
      if (!agent) return null;
      if (agent.status === "idle") return "idle";
      if (agent.status === "running") return "running";
      return null;
    } catch { return null; }
  };

  /** g-612：按 child 身份定位所属 care entry（root + 主管 ownership 双重校验；g-625 归属探测收口）。 */
  const entryOfChildAgent = (agent) => {
    const childId = agent?.session?.id ?? agent?.id ?? null;
    if (!childId) return null;
    const agents = getService("agents");
    const ownership = ownershipProbeOf(agents, getService("subagents"), { requireLiveTree: true });
    if (!agents || !ownership.supported) return null;
    const root = rootOfAgent(agent);
    if (!root) return null;
    const entry = entries.get(root);
    if (!entry) return null;
    const sup = entry.supervisorAgent ?? supervisorOf(entry.root).agent;
    if (!sup) return null;
    // 旧 API 错误 ⇒ "unknown"；新旧两版都只接受能**确认**归属的 child（fail-closed）。
    if (ownership.ownsId(childId, sup) !== "yes") return null;
    if (!entry.supervisorId) entry.supervisorId = sup?.session?.id ?? sup?.id ?? null;
    return entry;
  };

  // ── g-506 返工：晚 claim / 晚加入 workspace 的自举布防（见文件头「自举」小节） ──────────
  /**
   * 该 root 的**可信 live 主管绑定**：project.yaml supervisor.session → registry live Agent，
   * 且该 Agent 的 workspace 真解析到本 root（绝对 root 配置下 rootOfAgent 恒等，符合既有口径）。
   * 任一不满足 ⇒ `ok:false`（**绝不**布防，避免给非主管/foreign agent 装错 root 的 timer）。
   */
  const supervisorBindingOf = (root) => {
    const sup = supervisorOf(root);
    if (!sup.sid || !sup.agent) return { ok: false, sid: sup.sid ?? null, agent: null };
    let agentRoot = null;
    try { agentRoot = rootOfAgent(sup.agent); } catch { agentRoot = null; }
    if (agentRoot !== root) return { ok: false, sid: sup.sid, agent: null };
    return { ok: true, sid: sup.sid, agent: sup.agent };
  };

  /**
   * 幂等布防一个 canonical root（**生产事件驱动**的唯一入口）：
   *  - 无 live/同 root 的可信主管 ⇒ 只返回（不装 timer；等 claim/事件/发现）；
   *  - 否则同步身份后 `scheduleEntry`（先 clearTimer ⇒ 一 root 单 timer，绝不双投递）；
   *  - 不重置 pause/人工锁/未答计数/事件提交点（只走既有 syncIdentity + schedule 语义）。
   */
  const armForRoot = (rootArg) => {
    if (disposed) return null;
    const root = boardRootKey(rootArg) ?? defaultRoot();
    if (!root) return null;
    const entry = entryOfRoot(root);
    if (!entry) return null;
    const binding = supervisorBindingOf(root);
    if (!binding.ok) return entry;
    if (disposed) return null;
    syncIdentity(entry);
    scheduleEntry(entry);
    // 已有可信 root 布防 ⇒ 有界发现没有意义，立即停止（不额外扫描、不额外 timer）。
    stopDiscovery();
    return entry;
  };

  /**
   * 从**真实 Agent**反查并布防它自己的 root（只读 project.yaml 校验，绝不写身份/不跨 root）：
   * 该 Agent 必须正是其 workspace canonical root 的已登记主管。否则返回 null（不动任何状态）。
   */
  const adoptAgentRoot = (agent) => {
    if (disposed || !agent) return null;
    const root = rootOfAgent(agent);
    if (!root) return null;
    const sid = agent?.session?.id ?? agent?.id ?? null;
    if (!sid) return null;
    let registered = null;
    try { registered = readSupervisorSessionFn(root); } catch { registered = null; }
    if (!registered || registered !== sid) return null;
    return armForRoot(root);
  };

  const anyArmedEntry = () => {
    for (const entry of entries.values()) if (entry.timer !== null) return true;
    return false;
  };
  const stopDiscovery = () => {
    if (discoveryTimer === null) return;
    try { clearTimeoutFn(discoveryTimer); } catch { /* 忽略 */ }
    discoveryTimer = null;
  };
  /** 一轮有界发现：只核对 registry 里每个 live Agent 是否正是其 root 的已登记主管。 */
  const discoverArmedRoots = () => {
    if (disposed || !started) return false;
    const agents = getService("agents");
    if (!agents || typeof agents.list !== "function") return false;
    let armed = false;
    try {
      for (const agent of agents.list() ?? []) {
        const entry = adoptAgentRoot(agent);
        if (entry && entry.timer !== null) armed = true;
      }
    } catch { /* registry 异常 ⇒ 本轮放弃，下一轮/事件再试 */ }
    return armed;
  };
  /**
   * 有界后台发现：间隔与次数都有上界；已有 root 布防即停止；**绝不**发模型请求或投递。
   * `reset:true` 用于「新建 Agent（可能是尚未 claim 的主管）/冷启动」重新开一个有界窗口。
   */
  const scheduleDiscovery = (reset = false) => {
    if (disposed || !started) return;
    if (reset) discoveryAttempts = 0;
    if (!(armDiscoveryMaxAttempts > 0)) { stopDiscovery(); return; }
    if (discoveryAttempts >= armDiscoveryMaxAttempts) { stopDiscovery(); return; }
    if (discoveryTimer !== null) return; // 已有一次待跑 ⇒ 不叠加
    const interval = Number.isFinite(Number(armDiscoveryIntervalMs))
      ? Math.max(0, Number(armDiscoveryIntervalMs))
      : CARE_ARM_DISCOVERY_INTERVAL_MS;
    let handle = null;
    try {
      handle = setTimeoutFn(() => {
        discoveryTimer = null;
        if (disposed || !started) return;
        discoveryAttempts += 1;
        if (discoverArmedRoots()) { stopDiscovery(); return; }
        scheduleDiscovery(false);
      }, interval);
      handle?.unref?.();
    } catch { handle = null; }
    discoveryTimer = handle;
  };

  /**
   * g-506 返工 B1：**生产看板载荷的唯一真实目标枚举**。
   *
   * `getCachedBoardPayload` 的真实结构是 `versions[].goals` + `standalone` + `backlog`；
   * 旧实现只看 `payload.goals`（测试虚构字段），生产上版本目标与独立目标都漏采样。
   * backlog 是未开始排期的目标，**明确排除**，避免把 draft 误计为运行任务。
   * 两条消费路径（采样、结论绑定）必须同用本函数，禁止各自枚举。
   */
  const enumerateBoardGoals = (payload) => {
    if (!payload || typeof payload !== "object") return null;
    const out = [];
    if (Array.isArray(payload.versions)) {
      for (const v of payload.versions) {
        if (v && Array.isArray(v.goals)) out.push(...v.goals);
      }
    }
    if (Array.isArray(payload.standalone)) out.push(...payload.standalone);
    return out;
  };

  /** g-612：从 board payload 的 attempt_binding 定位 child 的当前 goal/attempt（只读）。 */
  const bindingForChild = (entry, childId) => {
    if (!entry || !childId) return null;
    let payload = null;
    try { payload = typeof readBoardPayload === "function" ? readBoardPayload(entry.root) : null; } catch { payload = null; }
    const goals = enumerateBoardGoals(payload);
    if (!goals) return null;
    // g-613：跨目标复用时**同一 child 可能同时挂在多个目标上**（旧目标尚未交付、新目标已接手）。
    // 只按「第一个命中」会让投递/唤醒把关照记到旧目标上（A/att-001 与 B/att-001 同键时尤其危险）。
    // ⇒ 选择规则唯一且可解释：取**绑定时间最新**的一条（attempt_started_at 更晚者胜；同刻按 id 倒序），
    //    绝不同时返回两条、绝不猜测。
    let best = null;
    let bestAt = -Infinity;
    for (const g of goals) {
      const b = g?.attempt_binding;
      if (!b || String(b.child_id ?? "") !== String(childId)) continue;
      if (String(g?.status) !== "in_progress") continue;
      if (String(b.parent_session_id ?? "") !== String(entry.supervisorId ?? "")) continue;
      const at = Date.parse(String(g?.attempt_started_at ?? "")) || 0;
      const idKey = String(g?.id ?? "");
      const better = best === null || at > bestAt || (at === bestAt && idKey > String(best.goal));
      if (!better) continue;
      bestAt = at;
      best = {
        goal: idKey,
        attempt: String(b.attempt ?? ""),
        bindingVersion: Number(b.binding_version) || 0,
        budgetSeconds: normalizeCareSeconds(g?.budget_seconds),
      };
    }
    return best;
  };

  /**
   * g-612 att011：真实 `agent/status=running` 发生时**只读捕获当时** board 上每个 in_progress
   * goal 的生效预算/来源（goal 覆盖 > 项目 > 全局）。
   *
   * 为什么按 goal 维度而不是 binding：真实宿主在 spawn 之后才把 child_id 写入 attempt.md，故
   * running 事件当下 `attempt_binding` 往往仍为 null；但 goal 已 in_progress 且预算真源可读。
   * 这里只保留 `{goalId: {seconds, source}}` 极少 metadata（不存描述/标题/消息正文），
   * reconcile 时按 run 的真实 goal 取用；payload 不可读/无法解析 ⇒ null（起点未知，不猜）。
   */
  const captureStartBudgets = (entry) => {
    let payload = null;
    try { payload = typeof readBoardPayload === "function" ? readBoardPayload(entry.root) : null; } catch { payload = null; }
    if (!payload || typeof payload !== "object") return null;
    const goals = enumerateBoardGoals(payload);
    if (!goals) return null;
    let timing = null;
    try { timing = timingForEntry(entry); } catch { timing = null; }
    const out = new Map();
    for (const g of goals) {
      if (!g || String(g?.status) !== "in_progress" || g?.archived === true) continue;
      const id = String(g?.id ?? "");
      if (!id) continue;
      const budgetSeconds = normalizeCareSeconds(g?.budget_seconds);
      if (budgetSeconds !== null) {
        out.set(id, { seconds: budgetSeconds, source: "goal" });
      } else if (timing) {
        // 继承项目/全局默认：仍是**事件当时**的配置，不用稍后采样时的配置冒充。
        const eff = careEffectiveBudgetSeconds({ budgetSeconds: null }, timing);
        out.set(id, { seconds: eff.seconds, source: eff.source });
      }
    }
    return out;
  };

  /**
   * g-612 att011：新 run 的只读预算历史 = **起点事件时刻**捕获的生效预算 + 起跑后真实发生的
   * goal 预算编辑（真实通知时点、按事件顺序、有界 32）+ 首次采样发现的未观测差异。
   *
   * 无可证起点快照（payload 不可读 / goal 不在起点快照 / 采样 attempt 起点晚于该事件）⇒ 空历史：
   * initial/source 如实 unknown，绝不用首次采样时的当前值回填。首次采样发现「最后记录值 ≠ 当前
   * 生效值」（未观测到的生效变化，时点不可证）⇒ 不伪造条目，只把该轮 `budgetHistoryIncomplete`
   * 置 true 明示时间线不完整。
   */
  const historyForNewRun = (pendingRun, sampled, effAtSampling) => {
    const startBudgets = pendingRun?.startBudgets instanceof Map ? pendingRun.startBudgets : null;
    const goalId = String(sampled?.goal ?? "");
    const initial = startBudgets && goalId ? startBudgets.get(goalId) ?? null : null;
    if (!initial) return { history: [], truncated: false, incomplete: true };
    // 同一 child 的本次 running 事件：采样到的 attempt 起点（真实 attempt.started 时点）不能晚于它。
    const attemptStartedAt = Number(sampled?.startedAt);
    if (Number.isFinite(attemptStartedAt) && Number(pendingRun.at) < attemptStartedAt) {
      return { history: [], truncated: false, incomplete: true };
    }
    const rec = pendingRun.changes instanceof Map ? pendingRun.changes.get(goalId) : null;
    const changes = Array.isArray(rec?.list) ? rec.list.slice(-BUDGET_CHANGE_LIMIT) : [];
    let history = [{ at: pendingRun.at, seconds: initial.seconds, source: initial.source }, ...changes];
    let truncated = rec?.truncated === true;
    let incomplete = false;
    const last = history[history.length - 1];
    if (last.seconds !== effAtSampling.seconds || last.source !== effAtSampling.source) {
      // 存在未观测到的生效变化（例如绕过 goal 工具的本地改写）：真实生效时点不可证 ⇒
      // 不伪造一条 at=采样now 的变化，只如实把该轮预算历史标为不完整。
      incomplete = true;
    }
    const capped = capBudgetHistory(history);
    return { history: capped.history, truncated: truncated || capped.truncated, incomplete };
  };

  /**
   * 采样当前组的**真实运行中任务**（catalog ∩ live registry ∩ ownership ∩ running）。
   * `ok=false` ⇒ 运行态不可确认（fail-safe：不投递）。
   */
  const sampleTasks = (entry, agent) => {
    const agents = getService("agents");
    const ownership = ownershipProbeOf(agents, getService("subagents"), { requireLiveTree: true });
    if (!agent || !agents || typeof agents.list !== "function" || typeof agents.get !== "function"
      || !ownership.supported) {
      return { ok: false, reason: "registry_missing", tasks: [] };
    }
    let payload = null;
    try { payload = typeof readBoardPayload === "function" ? readBoardPayload(entry.root) : null; } catch { payload = null; }
    if (!payload || typeof payload !== "object") return { ok: false, reason: "catalog_unavailable", tasks: [] };
    const goals = enumerateBoardGoals(payload);
    if (!goals) return { ok: false, reason: "catalog_unavailable", tasks: [] };
    const tasks = [];
    const seenTasks = new Set();
    for (const g of goals) {
      const binding = g?.attempt_binding;
      if (!binding || !binding.child_id) continue;
      if (String(g?.status) !== "in_progress") continue;
      const childId = String(binding.child_id);
      const attempt = String(binding.attempt ?? "");
      if (!attempt) continue;
      const supSid = String(agent?.session?.id ?? agent?.id ?? "");
      if (String(binding.parent_session_id ?? "") !== supSid) continue;
      const dedupeKey = `${childId}\u0000${attempt}`;
      if (seenTasks.has(dedupeKey)) continue; // 同一 child/attempt 被重复投影 ⇒ 只计一次
      seenTasks.add(dedupeKey);
      let childAgent = null;
      try { childAgent = agents.get(childId); } catch { return { ok: false, reason: "registry_error", tasks: [] }; }
      if (!childAgent) continue; // 已结束/不 live ⇒ 陈旧任务不进清单
      const childStatus = statusOf(childAgent);
      if (childStatus === null) return { ok: false, reason: "child_status_unknown", tasks: [] };
      if (childStatus !== "running") continue;
      const owned = ownership.ownsId(childId, agent);
      if (owned === "unknown") return { ok: false, reason: "ownership_unknown", tasks: [] };
      if (owned !== "yes") continue;
      if (rootOfAgent(childAgent) !== entry.root) continue;
      const startedRaw = g?.attempt_started_at ? Date.parse(String(g.attempt_started_at)) : NaN;
      const startedAt = Number.isFinite(startedRaw) && startedRaw <= now() ? startedRaw : now();
      tasks.push({
        goal: String(g?.id ?? ""),
        attempt,
        child: childId,
        bindingVersion: Number(binding.binding_version) || 0,
        startedAt,
        budgetSeconds: normalizeCareSeconds(g?.budget_seconds),
      });
    }
    return { ok: true, tasks };
  };

  const taskKey = (t) => `${t.child}\u0000${t.attempt}`;

  // ── g-612：run 墙钟 / 主管消息 / 预算变更（均为纯状态更新 + 事件先行） ──────────────
  const snapshotWithTask = (entry, updated) => {
    const key = taskKey(updated);
    const tasks = [...entry.tasks.values()].map((t) => (taskKey(t) === key ? updated : t));
    if (!tasks.some((t) => taskKey(t) === key)) tasks.push(updated);
    return careStateSnapshot(entry, { tasks });
  };
  const pushRun = (entry, run) => {
    // g-612：run id 由 child/attempt/起点稳定派生 ⇒ 同一轮只能存在一条；
    // 后续观察（如未知停止）只更新同一条，绝不重复追加（B 的「重启后同 id 两条」）。
    const at = entry.runs.findIndex((r) => r.id === run.id);
    if (at >= 0) entry.runs[at] = run;
    else entry.runs.push(run);
    if (entry.runs.length > CARE_RUN_HISTORY_LIMIT) entry.runs.splice(0, entry.runs.length - CARE_RUN_HISTORY_LIMIT);
  };
  const DORMANT_LIMIT = 64;
  /**
   * g-612：dormant 容量回收**不得**吞掉用户明确的人工锁/未答计数。
   * 只回收未锁的陈旧条目；已锁条目只随真实绑定换代（reconcile 的 bindingVersion 分支）
   * 或合法人类/attempt 操作消失 —— 宁可少量内存也不静默解锁后自动重启巡检。
   */
  const trimDormant = (entry) => {
    if (!(entry.dormant instanceof Map) || entry.dormant.size <= DORMANT_LIMIT) return;
    for (const [key, d] of [...entry.dormant]) {
      if (entry.dormant.size <= DORMANT_LIMIT) break;
      if (d?.humanLocked === true) continue;
      entry.dormant.delete(key);
    }
  };
  const dormantOf = (task) => ({
    child: task.child,
    attempt: task.attempt,
    goal: task.goal,
    bindingVersion: Number(task.bindingVersion) || 0,
    startedAt: Number(task.startedAt) || 0,
    lastProgressAt: task.lastProgressAt ?? null,
    lastProgressFingerprint: task.lastProgressFingerprint ?? null,
    stagnantRounds: Math.max(0, Math.floor(Number(task.stagnantRounds) || 0)),
    humanLocked: task.humanLocked === true,
    humanReason: task.humanReason ?? null,
    lastCareAt: task.lastCareAt ?? null,
    frozenRemainingMs: null,
    scheduleDueAt: null,
    remindersSent: Math.max(0, Math.floor(Number(task.remindersSent) || 0)),
    awaitingReply: task.awaitingReply === true,
    budgetSeconds: task.budgetSeconds ?? null,
    budgetBaseAt: null,
    budgetCountdown: false,
    budgetEffectiveSeconds: task.budgetEffectiveSeconds ?? null,
    budgetEffectiveSource: task.budgetEffectiveSource ?? null,
    runStartedAt: null,
    runStartSource: null,
    runStartExact: false,
    lastObservedAt: task.lastObservedAt ?? null,
    // 新一轮开始会重建预算历史；dormant 只保留锁/计数/冷却剩余。
    budgetHistory: undefined,
    cooldownDueAt: task.cooldownDueAt ?? null,
    // g-612 att008：暂停时冻结的**冷却剩余**必须随 idle→dormant 一起保留（不是只留可能已被
    // 暂停墙钟耗尽的绝对 cooldownDueAt）；resume 再据此换回 resume 时刻的调整后 deadline。
    frozenCooldownRemainingMs: typeof task.frozenCooldownRemainingMs === "number" && Number.isFinite(task.frozenCooldownRemainingMs)
      ? Math.max(0, task.frozenCooldownRemainingMs)
      : null,
  });
  const rememberDormant = (entry, task) => {
    if (!task) return;
    entry.dormant.set(taskKey(task), dormantOf(task));
    trimDormant(entry);
  };
  const reviveFromDormant = (entry, key, bindingVersion) => {
    const d = entry.dormant.get(key);
    if (!d) return null;
    if ((Number(d.bindingVersion) || 0) !== (Number(bindingVersion) || 0)) {
      // 真实绑定已换代 ⇒ 旧任务的锁/计数不得继承给新任务。
      entry.dormant.delete(key);
      return null;
    }
    entry.dormant.delete(key);
    return d;
  };
  /** 公开 registry 对「该 child 现在是否仍在运行」的唯一证据；未知绝不当作已停止。 */
  const childRunEvidence = (childId) => {
    const agents = getService("agents");
    if (!agents || typeof agents.get !== "function") return "unknown";
    let child = null;
    try { child = agents.get(String(childId)); } catch { return "unknown"; }
    if (!child) return "gone"; // 本宿主 registry 已不存在该 child（停止时刻仍未知）
    const st = statusOf(child);
    if (st === "running") return "running";
    if (st === "idle") return "idle";
    return "unknown";
  };
  const runBudgetOf = (task, timing) => careEffectiveBudgetSeconds(task, timing);
  /**
   * 本轮 id：start 可证时由 child/attempt/start 稳定派生（同一轮只会有一条）；
   * start 未知时用**唯一**后缀，绝不把所有 unknown-start run 固定成同一个 id 互相覆盖。
   */
  const runIdOf = (task, startedAt) => (startedAt == null
    ? `care-run:${task.child}:${task.attempt}:unknown:${randomUUID().slice(0, 8)}`
    : `care-run:${task.child}:${task.attempt}:${startedAt}`);
  /** 同一 child/attempt 当前唯一 open run（用于 start 未知/重建恢复时复用同一身份）。 */
  const openRunOf = (entry, task) => entry.runs.find((r) => r.child === task.child
    && r.attempt === task.attempt && r.stoppedAt === null && r.stopSource === null) ?? null;
  const runIdForClose = (entry, task) => {
    if (task.runStartedAt != null) return runIdOf(task, task.runStartedAt);
    return openRunOf(entry, task)?.id ?? runIdOf(task, null);
  };
  /** elapsed 是否由**连续观测 + 精确起止**支撑（跨空窗/非精确起止 ⇒ false；未知 ⇒ null）。 */
  const naturalExactOf = (task, stoppedAt, observationInterrupted, stopExact) => {
    if (stoppedAt == null || task.runStartedAt == null) return null;
    return observationInterrupted !== true && task.runStartExact === true && stopExact === true;
  };
  const appendRunEvent = (entry, phase, run) => {
    try { appendCareEvent(entry, "care.run", { phase, run }); } catch { /* 历史事件失败不阻断调度 */ }
  };
  const appendRunStarted = (_entry, _task, _timing) => {
    // run 起止作为 care_state 的一部分随既有 care.* 事件持久化；
    // 不新增高频事件类型（避免打爆既有「无事件」断言与事件日志）。
  };

  /**
   * 关闭一轮运行并留档（事件先行；纯 metadata，不含消息正文）。
   * - `opts.stoppedAt` 省略 ⇒ now()；显式 `null` ⇒ **停止时点未知**（不伪造，natural/over 均为 null）。
   * - `opts.tasks` ⇒ 事件快照使用的任务表（对账路径用最新采样，避免把陈旧开放任务写进快照）。
   * - `opts.dormant` ⇒ 同时把该任务的锁/计数记入有界 dormant 表（同 bindingVersion 复跑时恢复）。
   */
  const closeTaskRun = (entry, task, opts) => {
    if (!task || (task.runStartedAt == null && !task.runStartSource)) return task;
    const startedAt = task.runStartedAt ?? null;
    const stoppedAt = Object.prototype.hasOwnProperty.call(opts, "stoppedAt") ? opts.stoppedAt : now();
    const id = runIdForClose(entry, task);
    const prior = entry.runs.find((r) => r.id === id) ?? null;
    // g-612 返工：run 预算历史 = **起始**预算/来源 + 运行中生效变化时间线；
    // 停止时的 goal 值绝不冒充整轮预算（旧快照无可信起点 ⇒ unknown）。
    const initial = budgetInitialOf(task);
    const budgetSeconds = initial ? initial.seconds : null;
    const budgetSource = initial ? initial.source : null;
    // g-612 att011：起点不可证 ⇒ 展示**真实观察到**的后续预算变化（有界），并标历史不完整；
    // 绝不因 initial 未知就把真实变化静默丢成“整轮未变更”。
    const budgetChanges = initial
      ? budgetChangesOf(task)
      : (Array.isArray(task.budgetUnknownChanges) ? task.budgetUnknownChanges : []);
    const budgetChangesTruncated = initial
      ? task.budgetHistoryTruncated === true
      : task.budgetUnknownChangesTruncated === true;
    const budgetHistoryIncomplete = budgetSeconds === null || task.budgetHistoryIncomplete === true;
    const naturalMs = startedAt == null || stoppedAt == null ? null : Math.max(0, stoppedAt - startedAt);
    const deviationMs = naturalMs == null || budgetSeconds == null ? null : naturalMs - budgetSeconds * 1000;
    const observationInterrupted = prior?.observationInterrupted === true;
    const observationGaps = Array.isArray(prior?.observationGaps) ? prior.observationGaps : [];
    const stopExact = opts.stopExact === true;
    const run = {
      id,
      goal: task.goal,
      attempt: task.attempt,
      child: task.child,
      startedAt,
      startSource: task.runStartSource ?? "unknown",
      startExact: task.runStartExact === true,
      stoppedAt,
      stopSource: opts.stopSource ?? "sample",
      stopExact,
      budgetSeconds,
      budgetSource,
      budgetChanges,
      budgetChangesTruncated,
      budgetHistoryIncomplete,
      naturalMs,
      deviationMs,
      overBudget: deviationMs == null ? null : deviationMs > 0,
      observationInterrupted,
      observationGaps,
      naturalExact: naturalExactOf(task, stoppedAt, observationInterrupted, stopExact),
    };
    pushRun(entry, run);
    const cleared = {
      ...task,
      runStartedAt: null,
      runStartSource: null,
      runStartExact: false,
      budgetHistory: undefined,
      budgetHistoryTruncated: false,
      budgetUnknownChanges: undefined,
      budgetUnknownChangesTruncated: false,
      budgetHistoryIncomplete: false,
      cooldownDueAt: task.cooldownDueAt ?? null,
      // g-612 att008：暂停中自然 idle ⇒ dormant 必须带走**暂停时冻结的冷却剩余**
      //（否则 resume 后只有早已被暂停墙钟耗掉的绝对时刻，冷却被静默丢失）。
      frozenCooldownRemainingMs: typeof task.frozenCooldownRemainingMs === "number" && Number.isFinite(task.frozenCooldownRemainingMs)
        ? Math.max(0, task.frozenCooldownRemainingMs)
        : null,
    };
    if (opts.dormant) rememberDormant(entry, cleared);
    // g-612：run 停止必须在正常重启前持久保存；未知时点如实标注 unknown（不补造 now）。
    const snapshot = Array.isArray(opts.tasks)
      ? careStateSnapshot(entry, { tasks: opts.tasks })
      : snapshotWithTask(entry, cleared);
    try {
      appendCareEvent(entry, "care.run", { phase: stoppedAt == null ? "ended_unknown" : "stopped", run }, snapshot);
    } catch { /* 事件失败仍保留内存历史，不阻断调度 */ }
    return cleared;
  };
  /**
   * 观察不可及的一轮运行：主管更替/ownership 变化/状态未知时**不能**声称 child 已停止。
   * 只把开放 run 留档为「仍在追踪但暂不可确认」（stoppedAt=null、stopSource=null），
   * 移出任务表（不参与调度/倒计时），并继续用公开 registry 观察；真停止但拿不到精确事件时
   * 才以 stopSource=unknown / stoppedAt=null 收尾（不伪造时刻、不算精确 elapsed）。
   */
  const unobservedTaskRun = (entry, task, opts) => {
    const at = opts.at ?? now();
    const id = runIdForClose(entry, task);
    const prior = entry.runs.find((r) => r.id === id) ?? null;
    const initial = budgetInitialOf(task);
    const observationInterrupted = prior?.observationInterrupted === true;
    const run = {
      id,
      goal: task.goal,
      attempt: task.attempt,
      child: task.child,
      startedAt: task.runStartedAt ?? null,
      startSource: task.runStartSource ?? "unknown",
      startExact: task.runStartExact === true,
      stoppedAt: null,
      stopSource: null,
      stopExact: false,
      budgetSeconds: initial ? initial.seconds : null,
      budgetSource: initial ? initial.source : null,
      budgetChanges: initial
        ? budgetChangesOf(task)
        : (Array.isArray(task.budgetUnknownChanges) ? task.budgetUnknownChanges : []),
      budgetChangesTruncated: initial
        ? task.budgetHistoryTruncated === true
        : task.budgetUnknownChangesTruncated === true,
      budgetHistoryIncomplete: !initial || task.budgetHistoryIncomplete === true,
      naturalMs: null,
      deviationMs: null,
      overBudget: null,
      observationInterrupted,
      observationGaps: Array.isArray(prior?.observationGaps) ? prior.observationGaps : [],
      naturalExact: null,
    };
    pushRun(entry, run);
    const cleared = {
      ...task,
      runStartedAt: null,
      runStartSource: null,
      runStartExact: false,
      budgetHistory: undefined,
      budgetHistoryTruncated: false,
      budgetUnknownChanges: undefined,
      budgetUnknownChangesTruncated: false,
      budgetHistoryIncomplete: false,
      frozenCooldownRemainingMs: null,
    };
    rememberDormant(entry, cleared);
    const snapshot = Array.isArray(opts.tasks)
      ? careStateSnapshot(entry, { tasks: opts.tasks })
      : careStateSnapshot(entry, { tasks: [...entry.tasks.values()].filter((t) => taskKey(t) !== taskKey(task)) });
    try {
      appendCareEvent(entry, "care.run", { phase: "unobserved", reason: opts.reason ?? "unobserved", run }, snapshot);
    } catch { /* 事件失败仍保留内存历史，不阻断调度 */ }
    return run;
  };
  /**
   * 对「开放 run」（stoppedAt/stopSource 均为 null）按公开 registry 继续观察：
   * - 仍 running ⇒ 保持开放（绝不因为主管更替/重启就宣称停止）；
   * - 本宿主明确 idle 或 registry 已无该 child ⇒ 可证「已不在运行」，但停止时点未知 ⇒
   *   stopSource=unknown / stoppedAt=null（不拿观察时刻冒充精确停止）；
   * - 状态未知（statusOf 无法判定）⇒ 保持开放，下一轮再试。
   * 同一 run id 只收尾一次（幂等）。
   */
  const observeOpenRuns = (entry, at) => {
    let changed = false;
    const activeRunIds = new Set(
      [...entry.tasks.values()].filter((t) => t.runStartedAt != null).map((t) => runIdOf(t, t.runStartedAt)),
    );
    for (const run of [...entry.runs]) {
      if (run.stoppedAt !== null || run.stopSource !== null) continue;
      if (activeRunIds.has(run.id)) continue;
      const evidence = childRunEvidence(run.child);
      if (evidence === "running" || evidence === "unknown") continue;
      const closed = { ...run, stoppedAt: null, stopSource: "unknown", stopExact: false, naturalMs: null, deviationMs: null, overBudget: null };
      pushRun(entry, closed);
      try {
        appendCareEvent(entry, "care.run", { phase: "ended_unknown", run: closed, observed_at: at });
      } catch { /* 事件失败仍保留内存历史 */ }
      changed = true;
    }
    return changed;
  };
  /**
   * g-612：显式新事件（主管→child 消息 / goal 预算编辑）发生后，把**仍在开放**的巡检 target
   * 标记为被取代（按 stable message id / 事件顺序，不做毫秒时间戳比较）。
   * 只标匹配的 target；同一巡检里其他 target 不受影响（一批多目标时绝不整批作废）。
   * 标记只写 metadata（reason/at/message id），不保存消息正文；晚到结论仅作审计、不改任务状态。
   */
  const markOpenInspectionTargetsStale = (entry, predicate, reason, at, supersededBy) => {
    const marked = [];
    for (const [id, ins] of entry.inspections) {
      if (ins.status === "resolved" || ins.status === "failed" || ins.status === "expired") continue;
      let changed = false;
      const targets = ins.targets.map((t) => {
        if (t.outcome !== null || t.staleReason != null || !predicate(t)) return t;
        changed = true;
        return { ...t, staleReason: reason, staleAt: at, supersededBy: String(supersededBy ?? "") };
      });
      if (!changed) continue;
      entry.inspections.set(id, { ...ins, targets });
      marked.push(id);
    }
    return marked;
  };
  /**
   * 暂停态：未有效结论冷却的**剩余**必须按暂停起点（不是暂停期间流逝的墙钟）计算；
   * 优先使用调整后冷却截止（`cooldownDueAt`，pause/resume 已保留剩余），
   * 没有可证截止 ⇒ 0（绝不伪造 now 作为冷却起点）。
   */
  const cooldownRemainingAt = (task, refAt) => {
    // g-612 att008：暂停冻结的剩余是**暂停那一刻**的真值（含 idle→dormant 带过来的分量），
    // 优先于可能已被暂停墙钟耗尽/偏移的绝对 cooldownDueAt。
    if (!careCooldownActive(task)) return 0;
    const frozen = typeof task.frozenCooldownRemainingMs === "number" && Number.isFinite(task.frozenCooldownRemainingMs)
      ? Math.max(0, task.frozenCooldownRemainingMs)
      : null;
    if (frozen !== null) return frozen;
    const due = careCooldownDueAt(task);
    if (due === null) return 0;
    return Math.max(0, due - refAt);
  };
  const applySupervisorMessageToTask = (entry, task, opts) => {
    const budget = runBudgetOf(task, opts.timing);
    const budgetMs = budget.seconds * 1000;
    // 先把该 child/attempt 的开放巡检标为 superseded（同一 message id 显式事件顺序），
    // 使随后（或重启后）到达的旧巡检结论只作审计，绝不覆盖这条消息建立的预算基准。
    const superseded = markOpenInspectionTargetsStale(
      entry,
      (t) => t.child === task.child && t.attempt === task.attempt,
      "superseded_by_message",
      opts.at,
      String(opts.messageId ?? ""),
    );
    const pausedRef = entry.group.pausedAt ?? opts.at;
    const cooldownRemaining = entry.group.paused === true ? cooldownRemainingAt(task, pausedRef) : 0;
    const budgetRecord = recordBudgetChange(task, opts.at, budget.seconds, budget.source);
    const updated = {
      ...task,
      budgetBaseAt: opts.at,
      budgetCountdown: true,
      budgetEffectiveSeconds: budget.seconds,
      budgetEffectiveSource: budget.source,
      budgetHistory: budgetRecord.history,
      budgetHistoryTruncated: budgetRecord.truncated,
      ...(entry.group.paused === true
        // 暂停中消息冻结「完整新预算」与既有冷却剩余中的较晚者：不得让暂停墙钟偷走冷却。
        ? { frozenRemainingMs: Math.max(budgetMs, cooldownRemaining), frozenCooldownRemainingMs: cooldownRemaining, scheduleDueAt: null }
        : { frozenRemainingMs: null, frozenCooldownRemainingMs: null, scheduleDueAt: opts.at + budgetMs }),
    };
    try {
      appendCareEvent(entry, "care.message", {
        message_id: String(opts.messageId ?? ""),
        goal: task.goal,
        attempt: task.attempt,
        child: task.child,
        at: opts.at,
        budget_seconds: budget.seconds,
        budget_source: budget.source,
        ...(superseded.length ? { superseded_inspections: superseded } : {}),
      }, snapshotWithTask(entry, updated));
    } catch { /* 事件失败不阻断基准更新 */ }
    return updated;
  };
  const applyBudgetChangeToTask = (entry, task, opts) => {
    const inBudgetPhase = task.budgetCountdown === true || task.lastCareAt === null;
    // owner 规则（g-612 返工）：运行中 goal 预算真正修改/清空 ⇒ 不论当前是首次倒计时还是
    // 关照后的复查间隔，都立即按最近一次派发/主管消息基准 + 新预算重算当前截止。
    // `forceCountdown` 由真实 goal 变更路径传入；项目默认扫描不得把目标任务当「新编辑」反复重置。
    const forced = opts.forceCountdown === true;
    const oldBudget = task.budgetEffectiveSeconds ?? runBudgetOf(task, opts.timing).seconds;
    const budget = runBudgetOf(task, opts.timing);
    // 显式 goal 预算变更才取代同 goal 的开放巡检（项目默认/全局扫描不算新编辑）。
    const superseded = forced
      ? markOpenInspectionTargetsStale(entry, (t) => t.goal === task.goal, "superseded_by_budget", opts.at, "goal_budget")
      : [];
    const budgetRecord = recordBudgetChange(task, opts.at, budget.seconds, budget.source);
    // g-612 att011：起点不可证（空历史）时，真实 owner 的显式 goal 编辑仍按真实时点/顺序留痕，
    // 供停止后的 run 如实展示“可观察到的变化 + 历史不完整”，而不是静默成 changes=[]。
    // 只接受**真实编辑通知**（notifyGoalBudgetChanged 的真实时点）；reconcile 采样发现的差异时点
    // 不可证 ⇒ 不伪称精确时点（该轮已由 budgetHistoryIncomplete 标为不完整）。
    const unknownRec = opts.observedEdit === true && forced === true
      && (!Array.isArray(task.budgetHistory) || task.budgetHistory.length === 0)
      ? recordUnknownInitialBudgetChange(task, opts.at, budget.seconds, budget.source)
      : null;
    let updated = {
      ...task,
      budgetEffectiveSeconds: budget.seconds,
      budgetEffectiveSource: budget.source,
      budgetHistory: budgetRecord.history,
      budgetHistoryTruncated: budgetRecord.truncated,
      ...(unknownRec
        ? {
          budgetUnknownChanges: unknownRec.changes,
          budgetUnknownChangesTruncated: unknownRec.truncated,
          budgetHistoryIncomplete: true,
        }
        : {}),
    };
    if (entry.group.paused === true) {
      if (forced || inBudgetPhase) {
        // 暂停中编辑预算：预算目标仍按「最近派发/消息 base + 新预算」，消耗按暂停起点折算
        //（暂停墙钟不进入倒计时）；最终冻结剩余再与未有效结论冷却剩余取较晚者。
        const pauseAt = entry.group.pausedAt ?? opts.at;
        const base = task.budgetBaseAt ?? task.runStartedAt ?? task.startedAt;
        const consumed = Math.max(0, pauseAt - base);
        const budgetRemaining = Math.max(0, budget.seconds * 1000 - consumed);
        const cooldownRemaining = cooldownRemainingAt(task, pauseAt);
        updated = {
          ...updated,
          budgetCountdown: true,
          budgetBaseAt: base,
          frozenRemainingMs: Math.max(budgetRemaining, cooldownRemaining),
          frozenCooldownRemainingMs: cooldownRemaining,
          scheduleDueAt: null,
        };
      }
    } else if (forced || inBudgetPhase) {
      const base = task.budgetBaseAt ?? task.runStartedAt ?? task.startedAt;
      updated = {
        ...updated,
        budgetCountdown: true,
        budgetBaseAt: base,
        scheduleDueAt: base + budget.seconds * 1000,
        frozenRemainingMs: null,
        frozenCooldownRemainingMs: null,
      };
    }
    try {
      appendCareEvent(entry, "care.budget", {
        goal: task.goal,
        attempt: task.attempt,
        child: task.child,
        at: opts.at,
        old_budget_seconds: oldBudget,
        budget_seconds: budget.seconds,
        budget_source: budget.source,
        paused: entry.group.paused === true,
        forced,
        budget_countdown: updated.budgetCountdown === true,
        due_at: updated.scheduleDueAt ?? null,
        ...(superseded.length ? { superseded_inspections: superseded } : {}),
      }, snapshotWithTask(entry, updated));
    } catch { /* 事件失败不阻断调度 */ }
    return updated;
  };

  /**
   * B15 补充：已投递巡检的目标结束/换绑 ⇒ 自动 expire，不阻塞其他仍活任务；
   * 不撤回已发消息，过期后的真实结果仍按 `inspection_not_open` 拒绝。
   *
   * g-616（返工 att-002）：**过期粒度不变** —— 任一 target 陈旧即整条 `expired`。
   * 上一轮曾改为「逐 target 作废」，判红了既有 `g506 B15 补充` / `g506 bootstrap HMR`；
   * 且**不需要**：本函数只作用于**已投递**的巡检，同批存活目标在过期后照常参与下一轮
   * 调度（`g506 B15 补充` 第二段即断言「仍活任务可在过时巡检过期后继续巡检」）。
   * 合并唤醒因此**不触碰**这条语义，纯函数化只为让判定可单测。
   */
  const expireStaleInspections = (entry, sampled) => {
    const live = new Map(sampled.map((t) => [taskKey(t), Number(t.bindingVersion) || 0]));
    const next = new Map(entry.inspections);
    const expired = [];
    const at = now();
    for (const ins of entry.inspections.values()) {
      const result = expireStaleInspectionTargets(ins, live, at);
      if (!result.changed) continue;
      next.set(ins.id, result.inspection);
      expired.push({ inspection: result.inspection, targets: result.expiredTargets });
    }
    if (expired.length === 0) return false;
    const snapshot = careStateSnapshot(entry, { inspections: [...next.values()] });
    try {
      appendCareEvent(entry, "care.inspection.expired", {
        inspections: expired.filter((e) => e.inspection.status === "expired").map((e) => e.inspection.id),
        // 判据 6 可观测性：点明本次触发陈旧的是哪些 target（便于事后核验过期来源）
        expired_targets: expired.flatMap((e) => e.targets.map((t) => ({
          inspection: e.inspection.id,
          goal: t.goal,
          attempt: t.attempt,
          child: t.child,
          binding_version: t.bindingVersion,
        }))),
        reason: "stale_target",
      }, snapshot);
    } catch { /* 事件失败仍要在内存解阻，避免整组被过时巡检卡死到过期 */ }
    entry.inspections = next;
    for (const e of expired) {
      if (e.inspection.status === "expired" && e.inspection.messageId) entry.messageIndex.delete(e.inspection.messageId);
    }
    return true;
  };

  /** 用最新采样对账任务表：结束/换 attempt ⇒ 移除；绑定换代 ⇒ 重置计数（新任务语义）。 */
  const reconcileTasks = (entry, sampled, timing, at = now()) => {
    const next = new Map();
    for (const s of sampled) {
      const key = taskKey(s);
      const prev = entry.tasks.get(key);
      const goalBudget = normalizeCareSeconds(s.budgetSeconds);
      const pendingRun = entry.pendingRunStarts.get(s.child);
      const pendingMsg = entry.pendingMessageBases.get(s.child);
      if (prev && prev.bindingVersion === s.bindingVersion) {
        const goalChanged = (prev.budgetSeconds ?? null) !== (goalBudget ?? null);
        let t = { ...prev, budgetSeconds: goalBudget, lastObservedAt: at };
        let newRun = false;
        if (t.runStartedAt == null && pendingRun) {
          t = { ...t, runStartedAt: pendingRun.at, runStartSource: "agent_status", runStartExact: pendingRun.exact !== false };
          entry.pendingRunStarts.delete(s.child);
          appendRunStarted(entry, t, timing);
          newRun = true;
        } else if (t.runStartedAt == null) {
          if (s.startedAt >= entry.startedAt) {
            t = { ...t, runStartedAt: s.startedAt, runStartSource: "attempt_record", runStartExact: false };
            appendRunStarted(entry, t, timing);
            newRun = true;
          } else {
            t = { ...t, runStartSource: "unknown", runStartExact: false };
            newRun = true;
          }
        }
        // g-612 返工：新一轮从**起点生效预算**开始记录只读历史；续跑轮保留既有起点/变化。
        // g-612 att010：只有**起点可证**（真实 agent_status / attempt_record）才允许建立初始预算。
        // g-612 att011：起点预算只能取真实 running 事件时刻的快照；采样当前值绝不冒充起点
        //（attempt_record 近似起点同样没有当时的预算证据 ⇒ 空历史/unknown）。
        if (newRun) {
          if (t.runStartedAt != null) {
            const seeded = historyForNewRun(pendingRun, s, runBudgetOf(t, timing));
            t = {
              ...t,
              budgetHistory: seeded.history,
              budgetHistoryTruncated: seeded.truncated,
              budgetHistoryIncomplete: seeded.incomplete === true,
            };
          } else {
            t = { ...t, budgetHistory: [], budgetHistoryTruncated: false, budgetHistoryIncomplete: true };
          }
        }
        if (pendingMsg && pendingMsg.attempt === s.attempt && pendingMsg.bindingVersion === s.bindingVersion) {
          t = applySupervisorMessageToTask(entry, t, { at: pendingMsg.at, messageId: pendingMsg.messageId, timing });
          entry.pendingMessageBases.delete(s.child);
        }
        if (t.budgetBaseAt == null) t = { ...t, budgetBaseAt: t.startedAt };
        const eff = runBudgetOf(t, timing);
        if (t.budgetEffectiveSeconds == null) {
          t = { ...t, budgetEffectiveSeconds: eff.seconds, budgetEffectiveSource: eff.source };
          if ((t.budgetCountdown === true || t.lastCareAt === null) && t.scheduleDueAt == null) {
            if (entry.group.paused === true) {
              if (t.frozenRemainingMs == null) t = { ...t, frozenRemainingMs: eff.seconds * 1000 };
            } else {
              t = { ...t, scheduleDueAt: (t.budgetBaseAt ?? t.startedAt) + eff.seconds * 1000 };
            }
          }
        } else if (t.budgetEffectiveSeconds !== eff.seconds || t.budgetEffectiveSource !== eff.source) {
          t = applyBudgetChangeToTask(entry, t, { at, timing, forceCountdown: goalChanged });
        }
        next.set(key, t);
      } else {
        let runStartedAt = pendingRun?.at ?? null;
        let runStartSource = pendingRun ? "agent_status" : null;
        let runStartExact = pendingRun ? pendingRun.exact !== false : false;
        if (runStartedAt == null) {
          if (s.startedAt >= entry.startedAt) {
            runStartedAt = s.startedAt;
            runStartSource = "attempt_record";
          } else {
            runStartSource = "unknown";
          }
          runStartExact = false;
        }
        if (pendingRun) entry.pendingRunStarts.delete(s.child);
        // g-612：同一 child+attempt+bindingVersion 在短暂 idle 后复跑 ⇒ 恢复既有锁/计数；
        // 绑定换代（bindingVersion 变化）⇒ 旧计数不继承（新任务语义）。
        const revived = reviveFromDormant(entry, key, s.bindingVersion);
        let t = {
          child: s.child,
          attempt: s.attempt,
          goal: s.goal,
          bindingVersion: s.bindingVersion,
          startedAt: s.startedAt,
          lastProgressAt: revived?.lastProgressAt ?? null,
          lastProgressFingerprint: revived?.lastProgressFingerprint ?? null,
          stagnantRounds: revived?.stagnantRounds ?? 0,
          humanLocked: revived?.humanLocked === true,
          humanReason: revived?.humanReason ?? null,
          remindersSent: revived?.remindersSent ?? 0,
          awaitingReply: revived?.awaitingReply === true,
          lastCareAt: revived?.lastCareAt ?? null,
          frozenRemainingMs: null,
          scheduleDueAt: null,
          // g-612 att008：idle→dormant 带走的冷却（resume 已换回调整后绝对截止）必须被续轮继承；
          // resume 之前的暂停冻结剩余（先消息再 resume 分支）也一并继承，由暂停/恢复逻辑消费。
          cooldownDueAt: revived?.cooldownDueAt ?? null,
          frozenCooldownRemainingMs: typeof revived?.frozenCooldownRemainingMs === "number"
            && Number.isFinite(revived.frozenCooldownRemainingMs)
            ? Math.max(0, revived.frozenCooldownRemainingMs)
            : null,
          budgetSeconds: goalBudget,
          budgetBaseAt: null,
          budgetCountdown: true,
          budgetEffectiveSeconds: null,
          budgetEffectiveSource: null,
          runStartedAt,
          runStartSource,
          runStartExact,
          lastObservedAt: at,
        };
        // g-612 att011：起点预算只来自**真实 running 事件时刻**捕获的快照（+ 之后真实发生的
        // goal 编辑），绝不用首次采样的当前值回填（owner 可能在 running 后、首采样前改预算）。
        // 无快照/不可证 ⇒ 空历史（initial/source unknown），保持 att010「不伪造既往起点」语义。
        const effAtSample = runBudgetOf(t, timing);
        if (t.runStartedAt != null) {
          const seeded = historyForNewRun(pendingRun, s, effAtSample);
          t = {
            ...t,
            budgetHistory: seeded.history,
            budgetHistoryTruncated: seeded.truncated,
            budgetHistoryIncomplete: seeded.incomplete === true,
          };
        } else {
          t = { ...t, budgetHistory: [], budgetHistoryTruncated: false, budgetHistoryIncomplete: true };
        }
        if (pendingMsg && pendingMsg.attempt === s.attempt && pendingMsg.bindingVersion === s.bindingVersion) {
          t = applySupervisorMessageToTask(entry, t, { at: pendingMsg.at, messageId: pendingMsg.messageId, timing });
          entry.pendingMessageBases.delete(s.child);
        }
        if (t.budgetBaseAt == null) {
          // 首次培训（同一 attempt 尚无已停止 run）：预算基准取 attempt 派发时刻（s.startedAt），
          // 与 g506 既有语义一致；cold resume 后的新 run 才用新 run 起点。主管消息已单独覆盖。
          const hadPriorRun = entry.runs.some((r) => r.child === s.child && r.attempt === s.attempt);
          t = { ...t, budgetBaseAt: hadPriorRun ? (t.runStartedAt ?? s.startedAt) : s.startedAt };
        }
        const eff = runBudgetOf(t, timing);
        t = { ...t, budgetEffectiveSeconds: eff.seconds, budgetEffectiveSource: eff.source };
        if (entry.group.paused === true) {
          // 新任务在暂停期间被采样：冻结「从预算基准起已消耗后的剩余」（g506 语义）；
          // 但若刚有主管消息（pending message 已置满额），保留消息重置后的完整预算。
          const base = t.budgetBaseAt ?? s.startedAt;
          const remaining = Math.max(0, eff.seconds * 1000 - Math.max(0, at - base));
          t = {
            ...t,
            frozenRemainingMs: typeof t.frozenRemainingMs === "number" ? t.frozenRemainingMs : remaining,
            scheduleDueAt: null,
          };
        } else if (t.scheduleDueAt == null) {
          t = { ...t, scheduleDueAt: (t.budgetBaseAt ?? s.startedAt) + eff.seconds * 1000 };
        }
        next.set(key, t);
        appendRunStarted(entry, t, timing);
      }
    }
    // 未再采样的任务（停止/换绑/消失/主管更替）：
    // - 有公开运行证据（仍在 running / 状态不可判）⇒ **绝不**声称已停止：开放 run 记「暂不可确认」，
    //   任务移出调度表但保留计数，待真实停止可见时再以未知时点收尾（B：主管更替 ≠ child 停止）；
    // - 本宿主可见结束（idle / registry 已无该 child）但没有精确事件 ⇒ 未知停止（不补造 now）；
    // - 计数一律进入 dormant（同 child+attempt+bindingVersion 复跑时恢复；A）。
    const sampledTasks = [...next.values()];
    for (const [key, old] of entry.tasks) {
      if (next.has(key)) continue;
      if (old.runStartedAt == null && !old.runStartSource) {
        rememberDormant(entry, old);
        continue;
      }
      const evidence = childRunEvidence(old.child);
      if (evidence === "running" || evidence === "unknown") {
        unobservedTaskRun(entry, old, {
          at, timing, tasks: sampledTasks,
          reason: evidence === "running" ? "ownership_or_binding_changed" : "status_unknown",
        });
      } else {
        closeTaskRun(entry, old, {
          stoppedAt: null, stopSource: "unknown", stopExact: false, timing, tasks: sampledTasks, dormant: true,
        });
      }
    }
    entry.tasks = next;
    observeOpenRuns(entry, at);
    return next;
  };

  const capabilitiesOf = (agent, tasks = []) => {
    const agents = getService("agents");
    const subagents = getService("subagents");
    // g-625：子级枚举/归属能力探测收口（rc.1 `isOwnedBy` / rc.3 `rootOf`），缺 API 才判不具备。
    const ownership = ownershipProbeOf(agents, subagents);
    // B7：进展读取必须来自**真实子代理 session**（不是主管自己的 session）。
    // 只有当前有可枚举的真实 child 且其 session 暴露消息/工具历史时才算可读。
    let progressRead = false;
    try {
      progressRead = (Array.isArray(tasks) ? tasks : []).some((t) => {
        const child = agents && typeof agents.get === "function" ? agents.get(String(t?.child)) : null;
        const session = child?.session;
        return !!session && (typeof session.deriveMessages === "function" || typeof session.toolHistory === "function");
      });
    } catch { progressRead = false; }
    // B7：`typeof subagents.interrupt === "function"` 只证明 seam **存在**，不等于已授权/已验证可用；
    // 不调用真实干预、不自动中断/abandon/restart ⇒ 只在 `unverified` 中如实标注，绝不列 available。
    const seamInterrupt = !!agent && typeof subagents?.interrupt === "function";
    const seamResume = !!agent && typeof subagents?.sendMessage === "function";
    const report = assessCareCapabilities({
      idle_probe: !!agent && statusOf(agent) !== null,
      children_probe: !!(agents && typeof agents.list === "function" && typeof agents.get === "function" && ownership.supported),
      progress_read: progressRead,
      // B9：可唤醒必须是**完整投递链路** —— `send` 与 `runMaintenance` 缺一不可。
      // 只有 send 的旧/不完整宿主若被判 capable，会进入 deliverNow 早退且 0ms 反复重排。
      wake_dispatch: !!agent && typeof agent.send === "function" && typeof agent.runMaintenance === "function",
      interrupt: false,
      resume: false,
    });
    const unverified = [];
    if (seamInterrupt) unverified.push("interrupt");
    if (seamResume) unverified.push("resume");
    return { ...report, unverified };
  };

  /**
   * 读配置并折叠为生效投影（项目半边 + 真实全局半边）。
   * 项目畸形 ⇒ 传**原始值**给 core 以得到 `project_invalid`（fail-closed），绝不归一后默认开启。
   */
  const readConfig = (entry) => {
    const cfg = readProjectConfigFn(entry.root);
    const global = readGlobal() ?? {};
    const projectHalf = {
      mode: cfg?.supervisor?.care_malformed === true
        ? (cfg.supervisor.care_raw ?? "invalid")
        : (cfg?.supervisor?.care ?? null),
      thresholdSeconds: cfg?.supervisor?.care_threshold_seconds ?? null,
      recheckSeconds: cfg?.supervisor?.care_recheck_seconds ?? null,
    };
    const globalHalf = {
      enabled: global.malformed === true ? "__invalid__" : (global.enabled ?? null),
      thresholdSeconds: global.thresholdSeconds ?? null,
      recheckSeconds: global.recheckSeconds ?? null,
    };
    const resolution = careResolutionOf(projectHalf, globalHalf);
    const projection = careEffectiveOf(projectHalf, globalHalf);
    entry.configError = false;
    return { cfg, global, resolution, projection };
  };

  /** CareEffectiveProjection（snake_case）→ core 计时函数所需的 camelCase timing。 */
  const timingOf = (projection) => ({
    thresholdSeconds: projection?.threshold_seconds ?? CARE_DEFAULTS.thresholdSeconds,
    recheckSeconds: projection?.recheck_seconds ?? CARE_DEFAULTS.recheckSeconds,
    thresholdSource: projection?.threshold_source,
  });
  const timingForEntry = (entry) => {
    try { return timingOf(readConfig(entry).projection); } catch {
      return timingOf({ threshold_seconds: CARE_DEFAULTS.thresholdSeconds, recheck_seconds: CARE_DEFAULTS.recheckSeconds, threshold_source: "global_default" });
    }
  };

  /**
   * g-618：「首次全量、后续精简」的生效开关。**默认开启**（未配置/null = true）；
   * 只有显式 `supervisor.care_wake_compact: false` 才逐字回退旧行为（每份都内联完整纪律）。
   * 取值面只认真布尔（写侧 schema 已拒 "false"/0 等隐式形态）⇒ 不做字符串猜测。
   */
  const compactWakeEnabledOf = (cfg) => cfg?.supervisor?.care_wake_compact !== false;

  const warningsOf = (cfg, global) => {
    const warnings = [];
    if (cfg?.supervisor?.care_malformed === true) warnings.push("project_care_malformed");
    if (cfg?.supervisor?.care_threshold_seconds_malformed === true) warnings.push("project_care_threshold_malformed");
    if (cfg?.supervisor?.care_recheck_seconds_malformed === true) warnings.push("project_care_recheck_malformed");
    if (global?.malformed === true) warnings.push("global_care_malformed");
    if (global?.thresholdMalformed === true) warnings.push("global_care_threshold_malformed");
    if (global?.recheckMalformed === true) warnings.push("global_care_recheck_malformed");
    return warnings;
  };

  /** 结算一次决策所需全部采样（无副作用写外部；只更新 entry 的任务表与缓存）。 */
  const decisionOf = (entry) => {
    if (entry.persistenceError) {
      entry.lastReason = "state_unreadable";
      return { error: "state_unreadable", agent: null, caps: null, decision: null };
    }
    let cfg;
    let global;
    let resolution;
    let projection;
    try {
      ({ cfg, global, resolution, projection } = readConfig(entry));
    } catch {
      entry.configError = true;
      return { error: "config_unavailable", agent: null, caps: null, decision: null };
    }
    const sup = supervisorOf(entry.root);
    const agent = sup.agent;
    let sampled = { ok: false, tasks: [] };
    if (agent) sampled = sampleTasks(entry, agent);
    if (sampled.ok) {
      reconcileTasks(entry, sampled.tasks, timingOf(projection));
      expireStaleInspections(entry, sampled.tasks);
    }
    const caps = capabilitiesOf(agent, sampled.ok ? sampled.tasks : []);
    entry.capabilities = caps;
    const idle = agent ? (statusOf(agent) === "idle" ? true : statusOf(agent) === "running" ? false : null) : null;
    let decision = decideCare({
      now: now(),
      enabled: resolution.enabled,
      thresholdSeconds: projection.threshold_seconds,
      recheckSeconds: projection.recheck_seconds,
      maxStagnantRounds: projection.max_stagnant_rounds,
      idle,
      group: entry.group,
      tasks: [...entry.tasks.values()],
      delivering: entry.delivering === true,
      openInspection: [...entry.inspections.values()].some((i) => careInspectionOpen(i, now())),
    }, caps.minimal && sampled.ok !== false && !entry.configError);
    // g-506 返工 B2：连续 3 次未回复/unknown ⇒ 事件先行置人工等待（不增加 no-progress）。
    if (Array.isArray(decision.noResponseTasks) && decision.noResponseTasks.length > 0) {
      const applied = applyNoResponseLimit(entry.group, [...entry.tasks.values()], now());
      if (applied.changed) {
        try {
          appendCareEvent(entry, "care.escalated", {
            reason: "no_response_limit",
            supervisor: entry.supervisorId,
            tasks: applied.locked,
            max_unanswered_reminders: CARE_MAX_UNANSWERED_REMINDERS,
            no_progress_counted: false,
          }, careStateSnapshot(entry, { group: applied.group, tasks: applied.tasks }));
          entry.group = applied.group;
          entry.tasks = new Map(applied.tasks.map((t) => [taskKey(t), t]));
          decision = decideCare({
            now: now(),
            enabled: resolution.enabled,
            thresholdSeconds: projection.threshold_seconds,
            recheckSeconds: projection.recheck_seconds,
            maxStagnantRounds: projection.max_stagnant_rounds,
            idle,
            group: entry.group,
            tasks: [...entry.tasks.values()],
            delivering: entry.delivering === true,
            openInspection: [...entry.inspections.values()].some((i) => careInspectionOpen(i, now())),
          }, caps.minimal && sampled.ok !== false && !entry.configError);
        } catch { /* 事件失败 ⇒ 不落地；下一轮重试，仍是 awaiting_human 显示 */ }
      }
    }
    if ((entry.transportFailures ?? 0) >= CARE_DELIVERY_FAILURE_LIMIT) {
      decision = { ...decision, phase: "unavailable", deliver: false, reason: "delivery_failed_limit", nextDueAt: null, nextDueInMs: null };
    }
    entry.lastDecision = decision;
    entry.lastReason = decision.reason;
    return { cfg, global, resolution, projection, agent, caps, sampled, decision, warnings: warningsOf(cfg, global) };
  };

  /**
   * g-616 方案 A（负责人裁定 2026-11-06）：**单条定时唤醒**。
   *
   * 只要有在途子代理，本 board 就只维持**一条**定时器，按全组**最早**到期触发
   * （`careCoalescedWakeAt`，等价于改造前的 `decision.nextDueAt`）；「合并」发生在
   * **触发之后选批**这一步：`dueTargetsOf` 用 `careCoalesceBatch` 把「已到期 + 宽限
   * `CARE_COALESCE_WINDOW_MS` 内刚过期的邻居」一次投进同一条巡检（现场：g-028 01:21:38
   * 与 g-029 01:22:33 的 55 秒相邻到期，合并后在 01:21:38 一次关照，g-029 顺延 55 秒）。
   *
   * 这里只决定**何时**触发；`deliver === true`（真的到期）⇒ 0ms，否则按最早到期排程
   * （再被 `configRecheckMs` 封顶为配置重读上界，重扫不投递）。**绝不提前唤醒**：
   * 上一轮把窗口加在唤醒时刻上（`最早 + 窗口`），连带推迟了 300s 冷却后的唤醒，
   * `g506 bootstrap HMR` 因此回归 —— 合并只收「已到期」的任务，不改变唤醒时机。
   *
   * 不改变任何关照**语义**（阈值/复查间隔/300s 冷却/上限/人工锁/暂停冻结/inspection_open）。
   */
  const coalescedWakeDelay = (entry, decision) => {
    const dueAts = [];
    for (const s of decision?.tasks ?? []) {
      if (s.escalated) continue;             // 已升人工：不参与合并，也不提前唤醒
      if (typeof s.dueAt === "number" && Number.isFinite(s.dueAt)) dueAts.push(s.dueAt);
    }
    const at = careCoalescedWakeAt(dueAts, now());
    return at === null ? null : Math.max(0, at - now());
  };

  const scheduleEntry = (entry) => {
    if (!started || disposed || !entry) return;
    clearTimer(entry);
    let computed = null;
    try { computed = decisionOf(entry); } catch { computed = null; }
    let delay = configRecheckMs;
    const decision = computed?.decision ?? null;
    if (decision?.deliver) delay = 0;
    else if (decision?.nextDueAt !== null && decision?.nextDueAt !== undefined) {
      // 与改造前逐字等价；`coalescedWakeDelay` 只是同一 `Math.min` 口径的具名封装。
      delay = coalescedWakeDelay(entry, decision) ?? Math.max(0, decision.nextDueAt - now());
    }
    if (decision?.phase === "waiting_supervisor" || decision?.reason === "delivering") delay = Math.min(delay, busyRecheckMs);
    if (decision?.deliver && entry.retryNotBefore !== null) {
      delay = Math.max(delay, entry.retryNotBefore - now());
    }
    // B9：能力缺口（尤其缺 runMaintenance）不得走 0ms 普通路径；即使 nextDueAt 已过，
    // 也按明确正阈值重采，等待能力恢复/配置变化。单次维护占用不是缺能力。
    if (computed?.caps && computed.caps.minimal === false) {
      delay = Math.max(delay, Math.max(1000, configRecheckMs));
    }
    if (decision?.reason === "capability_missing") {
      delay = Math.max(delay, Math.max(1000, configRecheckMs));
    }
    delay = Math.max(0, Math.min(delay, configRecheckMs));
    if (computed?.caps && computed.caps.minimal === false) delay = Math.max(delay, Math.min(1000, Math.max(1, configRecheckMs)));
    entry.timerDueAt = now() + delay;
    let handle = null;
    try {
      handle = setTimeoutFn(async () => {
        entry.timer = null;
        entry.timerDueAt = null;
        try { await sweepEntry(entry); } catch { /* 忽略 */ }
        scheduleEntry(entry);
      }, delay);
      handle?.unref?.();
    } catch { handle = null; }
    entry.timer = handle;
  };

  const dueTargetsOf = (entry, decision) => {
    const due = [];
    // g-616 方案 A：一次唤醒投递**一整批**——已到期（含宽限内刚过期的邻居）一次纳入，
    // 而不是只投最早那一个、55 秒后再为邻居投第二次（现场 01:21:38 / 01:22:33）。
    const inBatch = new Set(
      careCoalesceBatch(
        (decision?.tasks ?? []).filter((s) => !s.escalated),
        now(),
        CARE_COALESCE_WINDOW_MS,
      ).map((b) => `${b.child}\u0000${b.attempt}`),
    );
    for (const s of decision?.tasks ?? []) {
      if (s.escalated) continue;
      if (!inBatch.has(`${s.child}\u0000${s.attempt}`)) continue;
      const st = entry.tasks.get(`${s.child}\u0000${s.attempt}`);
      if (!st) continue;
      due.push({
        goal: s.goal,
        attempt: s.attempt,
        child: s.child,
        bindingVersion: st.bindingVersion,
        startedAt: st.startedAt,
        lastCareAt: st.lastCareAt,
        stagnantRounds: st.stagnantRounds,
        humanLocked: st.humanLocked === true,
        // g-616 可观测性（判据 6）：该目标在本次唤醒时是否**尚未到期**（true = 宽限内刚过期并入）。
        // 恒为 false 时本批就是「同一时刻一起到期」——合并也覆盖这种情形，不是漏合并。
        coalesced: (s.dueInMs ?? 0) > 0,
        dueAt: s.dueAt,
      });
    }
    return due;
  };

  const careSourceOf = (entry, inspection, targets) => ({
    kind: "dsh-graph-care",
    form: "notice",
    summary: `care inspection: ${targets.length} task(s)`, // ≤ 120 字符
    inspectionId: inspection.id,
    workspaceRoot: entry.root,
    supervisorSession: inspection.supervisor,
    targets: targets.map((t) => ({ goal: t.goal, attempt: t.attempt, child: t.child })),
  });

  const langOf = () => {
    try {
      const settings = readGraphSettings();
      return settings.promptLanguage === "en" ? "en" : "zh";
    } catch { return "zh"; }
  };

  /**
   * g-506 返工 B3：投递失败必须有非零、可解释的回退；连续失败 3 次停止自动尝试并等待人工
   * （`reset` 可清除）。维护占用/主管忙**不消耗**真实发送预算，也不写入「已投递」。
   */
  const CARE_DELIVERY_FAILURE_LIMIT = 3;
  const retryForDeliveryOutcome = (reason) => {
    if (reason === "maintenance_busy" || reason === "not_entered" || reason === "revision_changed"
      || reason === "identity_changed") return CARE_MAINTENANCE_RETRY_MS;
    if (reason === "disabled" || reason === "paused" || reason === "capability_missing") return CARE_CONFIG_RECHECK_MS;
    if (reason === "config_unavailable" || reason === "state_unknown" || reason === "stale_target"
      || reason === "no_due_target" || reason === "inspection_open") return CARE_RETRY_MS;
    return CARE_RETRY_MS;
  };
  const deliveryFailureCounts = (reason) => reason === "send_failed" || reason === "append_failed" || reason === "not_entered";

  const recordDeliveryFailure = (entry, reason, inspection, priorGroup, priorTasks) => {
    const nextFailures = (entry.transportFailures ?? 0) + 1;
    const failed = inspection ? { ...inspection, status: "failed", lastError: reason } : null;
    const nextInspections = new Map(entry.inspections);
    if (failed) nextInspections.set(failed.id, failed);
    const snapshot = careStateSnapshot(entry, {
      group: priorGroup ?? entry.group,
      tasks: priorTasks ?? [...entry.tasks.values()],
      inspections: [...nextInspections.values()],
    });
    snapshot.transportFailures = nextFailures;
    try {
      appendCareEvent(entry, "care.delivery_failed", {
        reason,
        inspection: failed?.id ?? null,
        transport_failures: nextFailures,
        failure_limit: CARE_DELIVERY_FAILURE_LIMIT,
      }, snapshot);
    } catch { return false; }
    if (failed) {
      entry.inspections.set(failed.id, failed);
      if (failed.messageId) entry.messageIndex.delete(failed.messageId);
    }
    entry.transportFailures = nextFailures;
    if (priorGroup) entry.group = priorGroup;
    if (priorTasks) entry.tasks = new Map(priorTasks.map((t) => [taskKey(t), t]));
    return true;
  };

  const deliverNow = async (entry, computed) => {
    const agent = computed?.agent;
    if (!agent || typeof agent.send !== "function" || typeof agent.runMaintenance !== "function") {
      // B9：能力缺失不是「投递失败」，不计 transportFailures、不写事件、不发消息；
      // 但必须给出非零有界重排，绝不让 scheduleEntry 在普通路径落成 0ms 忙等。
      entry.lastReason = "capability_missing";
      entry.retryNotBefore = now() + Math.max(1000, configRecheckMs);
      return false;
    }
    const sid = entry.supervisorId;
    if (!sid) return false;
    const revision = entry.group.revision;
    const gen = generation;
    let maintenanceEntered = false;
    let result = "not_entered";
    let priorGroup = entry.group;
    let priorTasks = [...entry.tasks.values()];
    let sentInspection = null;
    entry.delivering = true;
    try {
      const rawResult = await agent.runMaintenance(() => {
        maintenanceEntered = true;
        if (disposed || generation !== gen) return "aborted";
        const supNow = supervisorOf(entry.root);
        if (supNow.sid !== entry.supervisorId || supNow.agent !== agent) return "identity_changed";
        if (entry.group.revision !== revision) return "revision_changed";
        if (entry.group.paused === true) return "paused";
        let nowCfg;
        try { nowCfg = readConfig(entry); } catch { return "config_unavailable"; }
        if (!nowCfg.resolution.enabled) return "disabled";
        const sampledNow = sampleTasks(entry, agent);
        if (!sampledNow.ok) return "state_unknown";
        const capsNow = capabilitiesOf(agent, sampledNow.tasks);
        if (!capsNow.minimal) return "capability_missing";
        reconcileTasks(entry, sampledNow.tasks, timingOf(nowCfg.projection), now());
        expireStaleInspections(entry, sampledNow.tasks);
        const idleNow = statusOf(agent) === "idle" ? true : statusOf(agent) === "running" ? false : null;
        const openNow = [...entry.inspections.values()].some((i) => careInspectionOpen(i, now()));
        const decisionNow = decideCare({
          now: now(),
          enabled: nowCfg.resolution.enabled,
          thresholdSeconds: nowCfg.projection.threshold_seconds,
          recheckSeconds: nowCfg.projection.recheck_seconds,
          maxStagnantRounds: nowCfg.projection.max_stagnant_rounds,
          idle: idleNow,
          group: entry.group,
          tasks: [...entry.tasks.values()],
          delivering: false,
          openInspection: openNow,
        }, capsNow.minimal);
        if (Array.isArray(decisionNow.noResponseTasks) && decisionNow.noResponseTasks.length > 0) return "no_response_limit";
        if (!decisionNow.deliver) return decisionNow.reason;
        const due = dueTargetsOf(entry, decisionNow);
        if (due.length === 0) return "no_due_target";
        // 投递前再核一次：每个到期目标必须仍是 live + owned + running（陈旧提醒失效）。
        const liveNow = sampleTasks(entry, agent);
        if (!liveNow.ok) return "state_unknown";
        for (const target of due) {
          const live = liveNow.tasks.find((t) => t.child === target.child && t.attempt === target.attempt);
          if (!live || live.bindingVersion !== target.bindingVersion) return "stale_target";
          if (!isCareReminderStillValid(
            { child: target.child, attempt: target.attempt, bindingVersion: target.bindingVersion },
            { child: live.child, attempt: live.attempt, bindingVersion: live.bindingVersion, liveState: "running" },
          )) return "stale_target";
        }
        const at = now();
        const inspection = createCareInspection({
          id: makeInspectionId(),
          root: entry.root,
          supervisor: entry.supervisorId,
          now: at,
          revision,
          recheckSeconds: nowCfg.projection.recheck_seconds,
          targets: due.map((t) => ({ goal: t.goal, attempt: t.attempt, child: t.child, bindingVersion: t.bindingVersion })),
        });
        // g-618「首次全量、后续精简」：**默认开启**；`supervisor.care_wake_compact: false` 时逐字旧行为。
        // 首份 = 本**主管会话**还没收到过完整纪律（标记随 care_state 快照持久化，换会话/重启 ⇒ 首次）。
        // 纪律资产缺失/不可读 ⇒ fail-open 回退 inline 全文（degraded=true 记入事件），绝不中断巡检。
        const wakeLang = langOf();
        const compactEnabled = compactWakeEnabledOf(nowCfg.cfg);
        const earlierFull = entry.disciplineSeen && entry.disciplineSeen.session === entry.supervisorId;
        const compact = compactEnabled && !!earlierFull;
        const discipline = resolveCareDisciplineText({
          lang: wakeLang,
          load: (lang) => readCorePromptAsset(CARE_DISCIPLINE_ASSET, lang),
        });
        const wakeProvenance = { compact, full: !compact, source: compact ? "asset_ref" : discipline.source, degraded: discipline.degraded };
        const text = formatCareWakeMessage({
          inspectionId: inspection.id,
          targets: due.map((t) => ({
            goal: t.goal,
            attempt: t.attempt,
            child: t.child,
            elapsedMs: Math.max(0, at - t.startedAt),
            lastCareAgoMs: t.lastCareAt === null ? null : Math.max(0, at - t.lastCareAt),
            stagnantRounds: t.stagnantRounds,
            maxStagnantRounds: nowCfg.projection.max_stagnant_rounds,
            humanLocked: t.humanLocked,
          })),
          maxStagnantRounds: nowCfg.projection.max_stagnant_rounds,
          lang: wakeLang,
          mode: compact ? "compact" : "full",
          discipline: discipline.text,
        });
        const message = createCareUserMessage({
          text,
          source: careSourceOf(entry, inspection, due),
        });
        inspection.messageId = message.id;
        const planned = applyCareDelivery(entry.group, [...entry.tasks.values()], at, due.map((t) => ({ child: t.child, attempt: t.attempt })));
        const plannedGroup = { ...planned.group, revision: entry.group.revision + 1 };
        const plannedInspections = new Map(entry.inspections);
        plannedInspections.set(inspection.id, inspection);
        // g-618：首份全量正文后才承认「本会话已看过纪律」——它必须与**真实发出**的正文一致，
        // 因此随同一份 care_state 快照落盘（send 失败时按投递前状态回滚，标记一并回滚）。
        const disciplineSeen = wakeProvenance.full || !wakeProvenance.compact
          ? { session: entry.supervisorId, at }
          : (entry.disciplineSeen ?? null);
        // 事件先行：快照（含 pending 巡检与已推进的未答预算）先落盘，再 send。
        // 崩溃在 send 前：恢复端把 queued 视为已发，绝不重复发送（宁可漏一次，不双发）。
        try {
          appendCareEvent(entry, "care.inspection", {
            inspection: inspection.id,
            supervisor: entry.supervisorId,
            targets: due.map((t) => ({ goal: t.goal, attempt: t.attempt, child: t.child, binding_version: t.bindingVersion })),
            // g-616 判据 6：合并发生时留下可核验记录——本批共几个目标、其中几个是
            // 「宽限内到期并入」（唤醒时刻尚未到期）、并入窗口长度。
            coalesce: {
              batch_size: due.length,
              merged_ahead: due.filter((t) => t.coalesced === true).map((t) => ({ goal: t.goal, attempt: t.attempt, child: t.child })),
              window_ms: CARE_COALESCE_WINDOW_MS,
            },
            revision: plannedGroup.revision,
            max_stagnant_rounds: nowCfg.projection.max_stagnant_rounds,
            wake_kind: "care_inspection",
            message_id: message.id,
            // g-618：本份唤醒的投递形态与纪律来源（机读、可核验）；关闭开关时三字段恒定
            // full/config_off 且正文逐字等价于旧行为。
            wake_form: wakeProvenance.compact ? "compact" : "full",
            wake_discipline_source: wakeProvenance.source,
            wake_discipline_degraded: wakeProvenance.degraded,
          }, careStateSnapshot(entry, { group: plannedGroup, tasks: planned.tasks, inspections: [...plannedInspections.values()], disciplineSeen }));
        } catch { return "append_failed"; }
        entry.group = plannedGroup;
        entry.tasks = new Map(planned.tasks.map((t) => [taskKey(t), t]));
        entry.inspections.set(inspection.id, inspection);
        entry.messageIndex.set(message.id, inspection.id);
        entry.disciplineSeen = disciplineSeen;
        sentInspection = inspection;
        let sent;
        try {
          sent = agent.send(message, "next-turn", true);
        } catch { return "send_failed"; }
        // 公开契约：send 返回 void；只有显式 false 才判失败（绝不把 queued 当 answered）。
        if (sent === false) return "send_failed";
        entry.seq += 1;
        entry.lastDecision = { ...decisionNow, phase: "awaiting_outcome", deliver: false, reason: "inspection_open" };
        entry.lastReason = "queued";
        emitAudit(makeCareAuditEntry(entry.seq, decisionNow, entry.supervisorId, at));
        return "queued";
      });
      result = typeof rawResult === "string" ? rawResult : "not_entered";
    } catch (e) {
      result = maintenanceEntered ? "send_failed" : "maintenance_busy";
      try {
        process.stderr.write(`[dsh-graph-host] 关照投递失败（${result}）：${String(e?.message ?? e).slice(0, 120)}\n`);
      } catch { /* 忽略 */ }
    } finally {
      entry.delivering = false;
    }

    if (result === "queued") {
      entry.transportFailures = 0;
      entry.retryNotBefore = null;
      return true;
    }
    if (deliveryFailureCounts(result)) {
      // send/append/未进入维护：先恢复投递前状态（绝不推进计时/未答预算），再计数。
      const recorded = recordDeliveryFailure(entry, result, sentInspection, priorGroup, priorTasks);
      if (!recorded) {
        // 事件写失败：内存也保持投递前状态；下一轮仍按失败重试（不半更新）。
        entry.group = priorGroup;
        entry.tasks = new Map(priorTasks.map((t) => [taskKey(t), t]));
        if (sentInspection) {
          entry.inspections.delete(sentInspection.id);
          if (sentInspection.messageId) entry.messageIndex.delete(sentInspection.messageId);
        }
      }
      if ((entry.transportFailures ?? 0) >= CARE_DELIVERY_FAILURE_LIMIT) {
        entry.lastReason = "delivery_failed_limit";
      }
    } else {
      entry.lastReason = result;
    }
    entry.retryNotBefore = now() + Math.max(1000, retryForDeliveryOutcome(result));
    return false;
  };

  const syncIdentity = (entry) => {
    const sup = supervisorOf(entry.root);
    if (sup.sid !== entry.supervisorId) {
      // g-506 返工 B5：主管切换不得把旧 attempt 的锁错绑到新任务，也**不得**因重启/换主管
      // 丢掉用户 pause/人工锁/未答计数。保留组与逐任务状态（任务键含 child+attempt+binding），
      // 下一次采样会按真实绑定剔除/保留；旧 pending 巡检标 expired（身份不匹配的结论必被拒绝）。
      entry.group = { ...entry.group, revision: entry.group.revision + 1 };
      entry.retryNotBefore = null;
      for (const [id, ins] of entry.inspections) {
        if (ins.status !== "resolved" && ins.status !== "failed") {
          entry.inspections.set(id, { ...ins, status: "expired", lastError: "supervisor_changed" });
        }
      }
      entry.supervisorId = sup.sid;
      entry.supervisorAgent = sup.agent;
      // g-618：换主管会话（含宿主重启后的新会话）⇒ 该会话的新模型上下文没见过纪律 ⇒ 视为首次。
      // 旧标记不会「顺着」新会话继续生效（那会把纪律永久省掉）。
      if (entry.disciplineSeen && entry.disciplineSeen.session !== sup.sid) entry.disciplineSeen = null;
      return true;
    }
    if (sup.agent !== entry.supervisorAgent) {
      const firstAttach = entry.supervisorAgent === null || entry.supervisorAgent === undefined;
      entry.supervisorAgent = sup.agent;
      if (sup.agent && !firstAttach) {
        entry.group = { ...entry.group, revision: entry.group.revision + 1 };
        // Agent 实例替换（不是重启后的首次附着）：旧巡检不再可信。
        for (const [id, ins] of entry.inspections) {
          if (ins.status !== "resolved" && ins.status !== "failed") {
            entry.inspections.set(id, { ...ins, status: "expired", lastError: "agent_replaced" });
          }
        }
      }
      return true;
    }
    return false;
  };

  const sweepEntry = async (entry) => {
    if (disposed || !entry || entry.sweeping) return;
    entry.sweeping = true;
    try {
      syncIdentity(entry);
      let computed;
      try { computed = decisionOf(entry); } catch { computed = null; }
      if (!computed || computed.error) { entry.lastReason = "state_unknown"; return; }
      if (!computed.decision?.deliver) return;
      if (entry.retryNotBefore !== null && now() < entry.retryNotBefore) return;
      await deliverNow(entry, computed);
    } finally {
      entry.sweeping = false;
    }
  };

  const candidateRoots = () => {
    const roots = new Set();
    const dflt = defaultRoot();
    if (dflt) roots.add(dflt);
    const agents = getService("agents");
    if (agents && typeof agents.list === "function") {
      try {
        for (const agent of agents.list() ?? []) {
          const root = rootOfAgent(agent);
          if (!root) continue;
          let supId = null;
          try { supId = readSupervisorSessionFn(root); } catch { supId = null; }
          if (supId && (agent?.session?.id === supId || agent?.id === supId)) roots.add(root);
        }
      } catch { /* registry 异常：至少保留默认 root */ }
    }
    for (const entry of entries.values()) roots.add(entry.root);
    return [...roots];
  };

  const start = () => {
    if (started || disposed) return;
    started = true;
    for (const root of candidateRoots()) entryOfRoot(root);
    for (const entry of entries.values()) {
      syncIdentity(entry);
      scheduleEntry(entry);
    }
    // g-506 返工：启动时默认 workspace 为空/指向别的 root（3110 现场）⇒ 没有任何 root 布防。
    // 这里开一个**有界**的后台发现窗口（只读 registry/project.yaml，零模型请求），
    // 让晚 claim/晚加入的 workspace 无需用户打开设置页或手工 sweep 也能自举；事件链仍是主路径。
    try { if (!anyArmedEntry()) scheduleDiscovery(true); } catch { /* 发现机制失败绝不影响既有功能 */ }
  };

  const dispose = () => {
    if (disposed) return;
    generation += 1;
    disposed = true;
    stopDiscovery();
    for (const entry of entries.values()) {
      clearTimer(entry);
      entry.delivering = false;
      entry.sweeping = false;
      entry.lastReason = "disabled_by_config";
    }
    for (const off of offs.splice(0)) { try { off?.(); } catch { /* 忽略 */ } }
  };

  const sweep = async () => {
    if (disposed) return;
    for (const root of candidateRoots()) entryOfRoot(root);
    for (const entry of entries.values()) {
      syncIdentity(entry);
      await sweepEntry(entry);
      scheduleEntry(entry);
    }
  };

  const statusFor = (rootArg) => {
    const root = boardRootKey(rootArg) ?? defaultRoot();
    if (!root) {
      return {
        root: null,
        supervisor: null,
        supervisor_live: false,
        supervisor_idle: null,
        configured: careEffectiveOf({ mode: "inherit", thresholdSeconds: null, recheckSeconds: null }, { enabled: null }),
        capable: assessCareCapabilities({}),
        phase: "unavailable",
        reason: "capability_missing",
        next_due_at: null,
        next_due_in_ms: null,
        server_now: now(),
        paused: false,
        paused_remaining_ms: null,
        revision: 0,
        tasks: [],
        escalate_tasks: [],
        awaiting_human: false,
        pending_inspections: [],
        last_outcome: null,
        warnings: ["workspace_unresolved"],
      };
    }
    const entry = entryOfRoot(root);
    if (syncIdentity(entry)) { /* identity refreshed */ }
    // 过期巡检按时间自然失效（服务端唯一真源；绝不依赖客户端清理）。
    for (const [id, ins] of entry.inspections) {
      const expired = expireCareInspection(ins, now());
      if (expired !== ins) entry.inspections.set(id, expired);
    }
    let computed = null;
    try { computed = decisionOf(entry); } catch { computed = null; }
    if (!computed || computed.error) {
      return {
        root,
        supervisor: entry.supervisorId,
        supervisor_live: false,
        supervisor_idle: null,
        configured: careEffectiveOf(
          { mode: "inherit", thresholdSeconds: null, recheckSeconds: null },
          { enabled: "__invalid__" },
        ),
        capable: assessCareCapabilities({}),
        phase: "unavailable",
        reason: "capability_missing",
        next_due_at: null,
        next_due_in_ms: null,
        server_now: now(),
        paused: entry.group.paused === true,
        paused_remaining_ms: entry.group.pausedRemainingMs,
        revision: entry.group.revision,
        tasks: [],
        escalate_tasks: [],
        awaiting_human: false,
        pending_inspections: [],
        last_outcome: entry.lastOutcome,
        warnings: ["config_unavailable"],
      };
    }
    const pending = [...entry.inspections.values()].filter((i) => i.status !== "failed").slice(-8);
    return careStatusProjection({
      now: now(),
      root,
      supervisor: entry.supervisorId,
      supervisorLive: !!computed.agent,
      supervisorIdle: computed.agent ? statusOf(computed.agent) === "idle" : null,
      configured: computed.projection,
      capable: computed.caps,
      decision: computed.decision,
      group: entry.group,
      tasks: [...entry.tasks.values()],
      pendingInspections: pending,
      lastOutcome: entry.lastOutcome,
      runs: entry.runs,
      warnings: computed.warnings,
    });
  };

  /**
   * g-612 att008：整组暂停/继续必须同时作用**已 idle 的 dormant 任务**（它们不在调度表里）。
   * 只调整冷却剩余 metadata，绝不把 dormant 放回 `entry.tasks`（不采样、不投递、界面不出现假倒计时）。
   * - pause：把当前可证冷却截止折成「暂停起点剩余」；
   * - resume：把冻结剩余换回 `resume 时刻 + 剩余` 的可追溯调整后截止，供之后真实主管消息冷唤醒时
   *   与重算后的预算取较晚者；旧 1b 快照缺冻结分量时用可证 `pausedAt/lastCareAt` 重建（同 att007）。
   * 人工锁/无冷却条目原样保留（sticky，不重置、不清计数）。
   */
  const adjustDormantCooldown = (dormant, action, at, group) => {
    const next = new Map();
    let changed = false;
    for (const [key, d] of dormant) {
      if (!d || d.humanLocked === true || !careCooldownActive(d)) { next.set(key, d); continue; }
      if (action === "pause") {
        const due = careCooldownDueAt(d);
        if (due === null) { next.set(key, d); continue; }
        next.set(key, { ...d, frozenCooldownRemainingMs: Math.max(0, due - at) });
        changed = true;
        continue;
      }
      // resume
      const frozen = typeof d.frozenCooldownRemainingMs === "number" && Number.isFinite(d.frozenCooldownRemainingMs)
        ? Math.max(0, d.frozenCooldownRemainingMs)
        : (legacyPausedCooldownRemainingMs(d, group?.pausedAt ?? null, { now: at, resetAt: group?.resetAt ?? null })
          ?? CARE_NO_RESPONSE_COOLDOWN_MS);
      next.set(key, { ...d, cooldownDueAt: at + frozen, frozenCooldownRemainingMs: null });
      changed = true;
    }
    return { dormant: next, changed };
  };

  /**
   * 暂停/继续/重置（REST 控制入口；**只作用当前主管当前工作区整组**）。
   * 事件先行；幂等（重复 pause/resume 不递增 revision）；可选 expected_revision 防陈旧点击。
   */
  const control = (rootArg, action, opts = {}) => {
    const root = boardRootKey(rootArg);
    if (!root) return { ok: false, code: "workspace_unresolved" };
    if (!(action === "pause" || action === "resume" || action === "reset")) return { ok: false, code: "invalid_action" };
    const entry = entryOfRoot(root);
    if (syncIdentity(entry)) { /* identity refreshed */ }
    const sup = supervisorOf(root);
    if (!sup.sid || !sup.live) return { ok: false, code: "no_live_supervisor" };
    if (entry.supervisorId !== sup.sid) return { ok: false, code: "identity_changed" };
    // g-506 返工 B14：同一次 HTTP 重试必须先按 requestId 识别，再校验 expectedRevision；
    // 否则第一次 reset 已递增 revision，带原 revision 的网络重试会被误判 409。
    const requestId = typeof opts.requestId === "string" && opts.requestId.trim()
      ? opts.requestId.trim().slice(0, 100) : null;
    if (requestId !== null && entry.group.lastControlRequestId === requestId) {
      if (action !== "reset" || entry.group.lastControlAction !== "reset") {
        return { ok: false, code: "request_conflict" };
      }
      return { ok: true, idempotent: true, status: statusFor(root) };
    }
    // pause/resume 的目标状态已达成 ⇒ 同一次网络重试（携带旧 expectedRevision）也应幂等；
    // 无副作用，不应以 revision 过期误报 409。reset 仍必须靠 requestId 识别重放。
    if (action === "pause" && entry.group.paused === true) {
      return { ok: true, idempotent: true, status: statusFor(root) };
    }
    if (action === "resume" && entry.group.paused !== true) {
      return { ok: true, idempotent: true, status: statusFor(root) };
    }
    if (typeof opts.expectedRevision === "number" && opts.expectedRevision !== entry.group.revision) {
      return { ok: false, code: "revision_conflict", revision: entry.group.revision };
    }
    // 首次控制可能早于第一次状态查询：先做一次纯采样，保证暂停冻结的是真实任务的剩余，
    // 而不是「空组暂停 → 继续后立刻到期」。采样不投递、不写事件、不改 revision。
    try { decisionOf(entry); } catch { /* 采样失败按空组处理（下方 readConfig 仍会如实拒绝） */ }
    let computed;
    try { computed = readConfig(entry); } catch { return { ok: false, code: "config_unavailable" }; }
    const timing = { now: now(), thresholdSeconds: computed.projection.threshold_seconds, recheckSeconds: computed.projection.recheck_seconds, thresholdSource: computed.projection.threshold_source };
    const tasks = [...entry.tasks.values()];
    let nextGroup = entry.group;
    let nextTasks = tasks;
    if (action === "pause") {
      if (entry.group.paused === true) return { ok: true, idempotent: true, status: statusFor(root) };
      const r = pauseCare(entry.group, tasks, timing);
      nextGroup = r.group; nextTasks = r.tasks;
    } else if (action === "resume") {
      if (entry.group.paused !== true) return { ok: true, idempotent: true, status: statusFor(root) };
      const r = resumeCare(entry.group, tasks, timing);
      nextGroup = r.group; nextTasks = r.tasks;
    } else {
      const r = resetCare(entry.group, tasks, timing);
      nextGroup = { ...r.group, lastControlRequestId: requestId, lastControlAction: "reset" };
      nextTasks = r.tasks;
    }
    // g-612 att008：暂停/继续同样作用于**已 idle 的 dormant 任务**的冷却剩余 metadata。
    // 只改 dormant（不可调度），事件先行时把调整后的完整 dormant 快照一起提交；
    // 事件写失败 ⇒ 不应用（内存状态保持事件已提交的旧值）。
    let nextDormant = entry.dormant;
    let dormantCooldownChanged = false;
    if (action === "pause" || action === "resume") {
      const adjustedDormant = adjustDormantCooldown(entry.dormant, action, timing.now, entry.group);
      if (adjustedDormant.changed) {
        nextDormant = adjustedDormant.dormant;
        dormantCooldownChanged = true;
      }
    }
    // g-506 返工 B5：事件先行 + 完整状态快照（paused/剩余/reset/未答计数/人工锁/inflight）。
    const controlState = careStateSnapshot(entry, {
      group: nextGroup,
      tasks: nextTasks,
      dormant: [...nextDormant.values()],
    });
    if (action === "reset") controlState.transportFailures = 0;
    try {
      appendCareEvent(entry, "care.control", {
        action,
        supervisor: entry.supervisorId,
        revision: nextGroup.revision,
        paused: nextGroup.paused,
        paused_remaining_ms: nextGroup.pausedRemainingMs,
        request_id: requestId,
      }, controlState, `human:${opts.actor ?? "ui"}`);
    } catch (e) {
      return { ok: false, code: "event_append_failed", detail: String(e?.message ?? e).slice(0, 120) };
    }
    entry.group = nextGroup;
    entry.tasks = new Map(nextTasks.map((t) => [taskKey(t), t]));
    if (dormantCooldownChanged) entry.dormant = nextDormant;
    if (action === "reset") entry.transportFailures = 0;
    scheduleEntry(entry);
    return { ok: true, idempotent: false, status: statusFor(root) };
  };

  /**
   * 窄结果工具的服务端受理：精确主管/live/绑定/新鲜度/一次性校验 →
   * **事件先行** → 更新计数与人工锁。返回真实结果（不是「已收到」）。
   */
  const submitOutcome = (input) => {
    const root = boardRootKey(input?.root);
    if (!root) return { ok: false, code: "workspace_unresolved" };
    const entry = entryOfRoot(root);
    if (syncIdentity(entry)) { /* identity refreshed */ }
    const sup = supervisorOf(root);
    if (!sup.sid || !sup.live || sup.sid !== String(input?.supervisor ?? "")) {
      return { ok: false, code: "wrong_identity" };
    }
    if (entry.supervisorId !== sup.sid) return { ok: false, code: "identity_changed" };
    const inspection = entry.inspections.get(String(input?.inspection ?? "")) ?? null;
    const outcome = normalizeCareOutcome(input?.outcome);
    const evidence = String(input?.evidence ?? "").trim();
    if (!evidence) return { ok: false, code: "evidence_required" };
    // 当前 catalog 绑定（服务端真源）：goal/attempt/child/版本必须与结论完全一致。
    let payload = null;
    try { payload = typeof readBoardPayload === "function" ? readBoardPayload(root) : null; } catch { payload = null; }
    const goals = enumerateBoardGoals(payload) ?? [];
    const goal = goals.find((g) => String(g?.id) === String(input?.goal));
    const binding = goal?.attempt_binding ?? null;
    const bindingVersion = Number(binding?.binding_version) || 0;
    if (!goal || !binding
      || String(goal?.status) !== "in_progress"
      || String(binding.attempt) !== String(input?.attempt)
      || String(binding.child_id) !== String(input?.child)) {
      return { ok: false, code: "stale_binding" };
    }
    // g-506 返工 B4：结论新鲜性必须核对**真实 live 子代理**，不能只信 catalog 绑定。
    // 顺序：registry 可用 → child live/running/owned → canonical workspace → parent session 仍匹配。
    // 任一失败都在写事件/计数之前返回（0 事件/0 计数）。
    const agents = getService("agents");
    const ownership = ownershipProbeOf(agents, getService("subagents"), { requireLiveTree: true });
    if (!agents || typeof agents.get !== "function" || !ownership.supported) {
      return { ok: false, code: "registry_unavailable" };
    }
    let childAgent = null;
    try { childAgent = agents.get(String(input.child)); } catch { return { ok: false, code: "registry_unavailable" }; }
    if (!childAgent) return { ok: false, code: "child_not_live" };
    if (statusOf(childAgent) !== "running") return { ok: false, code: "child_not_running" };
    const ownedNow = ownership.ownsId(String(input.child), sup.agent);
    if (ownedNow === "unknown") return { ok: false, code: "ownership_unknown" };
    if (ownedNow !== "yes") return { ok: false, code: "child_not_owned" };
    if (rootOfAgent(childAgent) !== root) return { ok: false, code: "wrong_workspace" };
    if (String(binding.parent_session_id ?? "") !== sup.sid) return { ok: false, code: "stale_parent" };
    const digest = createHash("sha256").update(evidence).digest("hex").slice(0, 16);
    const validated = validateCareOutcome({
      inspection,
      now: now(),
      root,
      supervisor: sup.sid,
      goal: String(input?.goal),
      attempt: String(input?.attempt),
      child: String(input?.child),
      bindingVersion,
      outcome,
      evidenceDigest: digest,
    });
    if (!validated.ok) return { ok: false, code: validated.code };
    if (validated.idempotent) {
      return {
        ok: true,
        idempotent: true,
        inspection: inspection.id,
        goal: String(input.goal),
        attempt: String(input.attempt),
        child: String(input.child),
        outcome: validated.target.outcome,
        counted: false,
        // 晚到且已被新消息/预算编辑取代的旧巡检：只作审计，明确告知调用方未应用。
        stale: validated.stale === true,
        applied: validated.stale === true ? false : true,
        ...(validated.stale === true ? {
          stale_reason: validated.target.staleReason ?? null,
          stale_superseded_by: validated.target.supersededBy ?? null,
        } : {}),
      };
    }
    const at = now();
    let maxRounds = CARE_DEFAULTS.maxStagnantRounds;
    try { maxRounds = readConfig(entry).projection.max_stagnant_rounds; } catch { /* 用受控默认 */ }
    const preTask = entry.tasks.get(`${String(input.child)}\u0000${String(input.attempt)}`) ?? null;
    // g-612：该 target 已被之后的主管→child 新消息 / goal 预算编辑取代 ⇒ 受理为**审计记录**，
    // 但绝不改动新事件建立的任务状态（budgetCountdown/scheduleDueAt/计数/锁/提醒）。
    // 也不伪称撤回已投递的关照：巡检本身仍按一次性记 resolved/审计。
    const staleOutcome = validated.stale === true;
    // 先在**副本**上算出结果（事件先行：任何写入失败都不得留下半状态）。
    const applied = staleOutcome
      ? { group: entry.group, tasks: [...entry.tasks.values()], matched: preTask !== null, counted: false, humanLocked: entry.group.escalated === true }
      : applyCareOutcome(entry.group, [...entry.tasks.values()], {
          child: String(input.child),
          attempt: String(input.attempt),
        }, {
          kind: outcome,
          fingerprint: digest,
          now: at,
          maxStagnantRounds: maxRounds,
        });
    const nextInspection = applyCareInspectionOutcome(inspection, {
      goal: String(input.goal),
      attempt: String(input.attempt),
      child: String(input.child),
      kind: outcome,
      evidenceDigest: digest,
      now: at,
    });
    const targetTask = applied.tasks.find((t) => t.child === String(input.child) && t.attempt === String(input.attempt)) ?? null;
    const newlyLocked = staleOutcome ? false : targetTask?.humanLocked === true && preTask?.humanLocked !== true;
    // B15/B16 commit point：`care.outcome` append 成功即视为提交；之后**立即、不可回滚**应用
    // nextInspection/group/tasks/lastOutcome。升级事件只做 best-effort，失败也不能把已提交结果
    // 报成失败、更不能让后续 timer/reset/pause 用旧内存覆盖已落盘锁。
    const nextInspections = new Map(entry.inspections);
    nextInspections.set(inspection.id, nextInspection);
    const lastOutcomeRecord = {
      inspection: inspection.id,
      goal: String(input.goal),
      attempt: String(input.attempt),
      child: String(input.child),
      outcome,
      at,
      counted: applied.counted,
      idempotent: false,
      stale: staleOutcome,
      applied: !staleOutcome,
      stagnant_rounds: targetTask?.stagnantRounds ?? 0,
      human_locked: targetTask?.humanLocked === true,
    };
    const state = careStateSnapshot(entry, { group: applied.group, tasks: applied.tasks, inspections: [...nextInspections.values()] });
    state.lastOutcome = lastOutcomeRecord;
    try {
      appendCareEvent(entry, "care.outcome", {
        inspection: inspection.id,
        supervisor: sup.sid,
        goal: String(input.goal),
        attempt: String(input.attempt),
        child: String(input.child),
        outcome,
        evidence_digest: digest,
        binding_version: bindingVersion,
        // g-612：晚到旧巡检 ⇒ 只作审计；明确记录是否应用/是否 stale（不伪称撤回）。
        stale: staleOutcome,
        applied: !staleOutcome,
        stale_reason: staleOutcome ? (validated.target.staleReason ?? null) : null,
        stale_superseded_by: staleOutcome ? (validated.target.supersededBy ?? null) : null,
        // B16：升级信息随同一 commit point 持久化，避免依赖第二个事件是否存在。
        escalated: newlyLocked,
        escalation_reason: newlyLocked ? "fresh_no_progress_limit" : null,
        stagnant_rounds: targetTask?.stagnantRounds ?? 0,
        max_stagnant_rounds: maxRounds,
        human_locked: targetTask?.humanLocked === true,
        human_reason: targetTask?.humanReason ?? null,
      }, state, `supervisor:${sup.sid}`);
    } catch (e) {
      return { ok: false, code: "event_append_failed", detail: String(e?.message ?? e).slice(0, 120) };
    }
    // 提交成功：内存立即与落盘一致（不可等下一事件/下一次采样）。
    entry.inspections.set(inspection.id, nextInspection);
    entry.group = applied.group;
    entry.tasks = new Map(applied.tasks.map((t) => [taskKey(t), t]));
    entry.lastOutcome = lastOutcomeRecord;
    let escalationWarning = null;
    if (newlyLocked) {
      try {
        appendCareEvent(entry, "care.escalated", {
          inspection: inspection.id,
          supervisor: sup.sid,
          goal: String(input.goal),
          attempt: String(input.attempt),
          child: String(input.child),
          stagnant_rounds: targetTask?.stagnantRounds ?? maxRounds,
          max_stagnant_rounds: maxRounds,
          reason: "fresh_no_progress_limit",
          human_reason: targetTask?.humanReason ?? "no_progress_limit",
        }, state, `supervisor:${sup.sid}`);
      } catch (e) {
        escalationWarning = "escalation_event_failed";
        try { process.stderr.write(`[dsh-graph-host] care.escalated 审计事件写失败（care.outcome 已提交，锁保持）：${String(e?.message ?? e).slice(0, 120)}\n`); } catch { /* 忽略 */ }
      }
    }
    scheduleEntry(entry);
    return {
      ok: true,
      idempotent: false,
      inspection: inspection.id,
      goal: String(input.goal),
      attempt: String(input.attempt),
      child: String(input.child),
      outcome,
      counted: applied.counted,
      stale: staleOutcome,
      applied: !staleOutcome,
      ...(staleOutcome ? {
        stale_reason: validated.target.staleReason ?? null,
        stale_superseded_by: validated.target.supersededBy ?? null,
      } : {}),
      stagnant_rounds: targetTask?.stagnantRounds ?? 0,
      max_stagnant_rounds: maxRounds,
      human_locked: targetTask?.humanLocked === true,
      awaiting_human: applied.humanLocked,
      ...(escalationWarning ? { warning: escalationWarning, escalation_logged: false } : {}),
    };
  };

  // ── 事件接线（全部公开事件；HMR/晚到服务由 apply 的 effect 生命周期管理）──
  const onEvent = (name, handler) => {
    if (typeof ctx?.on !== "function") return;
    try {
      const off = ctx.on(name, handler);
      if (typeof off === "function") offs.push(off);
    } catch { /* 事件面不支持 ⇒ 静默（能力探测） */ }
  };

  onEvent("agent/inbox/inserted", (payload) => {
    try {
      const agent = payload?.agent;
      // g-612：目标 child 的 inbox 收到主管新消息（含 running steer / idle 唤醒）。
      const childEntry = entryOfChildAgent(agent);
      if (childEntry) {
        const msg = payload?.message;
        const mid = String(msg?.id ?? "");
        const src = msg?.source;
        if (!mid || !src || src.kind !== "agent-message"
          || String(src.senderSessionId ?? "") !== String(childEntry.supervisorId ?? "")) return;
        if (childEntry.seenMessageIds.has(mid)) return; // 同一 message.id 幂等
        childEntry.seenMessageIds.set(mid, now());
        if (childEntry.seenMessageIds.size > 512) {
          const oldest = childEntry.seenMessageIds.keys().next().value;
          if (oldest !== undefined) childEntry.seenMessageIds.delete(oldest);
        }
        const childId = String(agent?.session?.id ?? agent?.id ?? "");
        const binding = bindingForChild(childEntry, childId);
        if (binding && binding.goal && binding.attempt) {
          // g-613：care 任务键是 `goal\0attempt`（跨目标复用时同一 child 的不足够区分目标），
          // 旧写法 `child\0attempt` 在 A/att-001 与 B/att-001 并存时必然串账 ⇒ 改按绑定返回的 goal 取键。
          const key = `${binding.goal}\u0000${binding.attempt}`;
          const task = childEntry.tasks.get(key);
          if (task && task.bindingVersion === binding.bindingVersion) {
            childEntry.tasks.set(key, applySupervisorMessageToTask(childEntry, task, {
              at: now(), messageId: mid, timing: timingForEntry(childEntry),
            }));
          } else {
            childEntry.pendingMessageBases.set(childId, { at: now(), messageId: mid, ...binding });
            if (childEntry.pendingMessageBases.size > 64) {
              const oldest = childEntry.pendingMessageBases.keys().next().value;
              if (oldest !== undefined) childEntry.pendingMessageBases.delete(oldest);
            }
          }
          if (task || childEntry.timer !== null) scheduleEntry(childEntry);
        }
        return;
      }
      const entry = entryOfAgent(agent);
      if (!entry) return;
      const id = entry.messageIndex.get(payload?.message?.id);
      if (!id) return;
      const ins = entry.inspections.get(id);
      if (ins && ins.status === "queued") {
        entry.inspections.set(id, { ...ins, status: "delivered", deliveredAt: now() });
      }
      scheduleEntry(entry);
    } catch { /* 忽略 */ }
  });

  onEvent("agent/inbox/claimed", (payload) => {
    try {
      const entry = entryOfAgent(payload?.agent);
      if (!entry) return;
      const id = entry.messageIndex.get(payload?.message?.id);
      if (!id) return;
      const ins = entry.inspections.get(id);
      if (ins && (ins.status === "queued" || ins.status === "delivered")) {
        entry.inspections.set(id, { ...ins, status: "claimed", deliveredAt: ins.deliveredAt ?? now(), claimedAt: now() });
      }
      scheduleEntry(entry);
    } catch { /* 忽略 */ }
  });

  onEvent("agent/inbox/discarded", (payload) => {
    try {
      const entry = entryOfAgent(payload?.agent);
      if (!entry) return;
      const id = entry.messageIndex.get(payload?.message?.id);
      if (!id) return;
      const ins = entry.inspections.get(id);
      if (ins && ins.status !== "resolved") {
        entry.inspections.set(id, { ...ins, status: "expired", lastError: "inbox_discarded" });
      }
      scheduleEntry(entry);
    } catch { /* 忽略 */ }
  });

  onEvent("agent/status", (payload) => {
    try {
      const agent = payload?.agent;
      // g-612：目标 child 的 running/idle 是**本轮自然墙钟**的公开事件时点；
      // 只用于 run 起止/采样重排，绝不把它当成关照倒计时或把 idle 当成永久结束。
      const childEntry = entryOfChildAgent(agent);
      if (childEntry) {
        const childId = String(agent?.session?.id ?? agent?.id ?? "");
        const status = payload?.status;
        const at = now();
        const timing = timingForEntry(childEntry);
        let task = null;
        let key = null;
        for (const [k, t] of childEntry.tasks) {
          if (t.child === childId) { task = t; key = k; break; }
        }
        if (status === "running") {
          // g-612 att011：在**事件当时**捕获生效预算快照，作为该 child 本轮的可证起点预算；
          // 绝不等到首次采样时再拿当前值当起点（owner 可能在 running 后、首采样前改预算）。
          const startBudgets = captureStartBudgets(childEntry);
          if (task) {
            if (task.runStartedAt == null && !task.runStartSource) {
              // 上一轮已结束（runStartSource 被清空）⇒ 本次 running 是**新 run 的可证起点**。
              // 旧快照 runStartSource="unknown"（旧 05f 在途轮）不得把本次观察伪称起点。
              const initial = startBudgets?.get(String(task.goal ?? "")) ?? null;
              const base = { ...task, runStartedAt: at, runStartSource: "agent_status", runStartExact: true, lastObservedAt: at };
              const updated = {
                ...base,
                budgetHistory: initial ? [{ at, seconds: initial.seconds, source: initial.source }] : [],
                budgetHistoryTruncated: false,
                budgetHistoryIncomplete: !initial,
              };
              childEntry.tasks.set(key, updated);
              appendRunStarted(childEntry, updated, timing);
            } else {
              childEntry.tasks.set(key, { ...task, lastObservedAt: at });
            }
          } else {
            childEntry.pendingRunStarts.set(childId, { at, exact: true, startBudgets, changes: new Map() });
            if (childEntry.pendingRunStarts.size > 64) {
              const oldest = childEntry.pendingRunStarts.keys().next().value;
              if (oldest !== undefined) childEntry.pendingRunStarts.delete(oldest);
            }
          }
          if (task || childEntry.timer !== null) scheduleEntry(childEntry);
        } else if (status === "idle") {
          childEntry.pendingRunStarts.delete(childId);
          if (task) {
            // g-612：自然 idle = 本轮运行结束（精确时点来自公开 status），但任务计数必须留给
            // 同一 child+attempt+bindingVersion 的冷唤醒（A）；任务仍在快照 tasks 中，下一轮对账再移出调度。
            const closed = closeTaskRun(childEntry, task, {
              stoppedAt: at, stopSource: "agent_status", stopExact: true, timing, dormant: true,
            });
            childEntry.tasks.set(key, closed);
          }
          if (task || childEntry.timer !== null) scheduleEntry(childEntry);
        }
        return;
      }
      // 快路径：已绑定本 root 的主管 ⇒ 重排即可。
      const bound = entryOfAgent(agent);
      if (bound) { scheduleEntry(bound); return; }
      // 自举路径（3110 现场）：条目可能是 claim 前 statusFor 建的 dormant 条目，或根本不存在；
      // 这里做**只读**身份校验（该 Agent 正是其 workspace root 的已登记主管）后 idempotent 布防。
      // 自然 turn-end 就是生产事件 ⇒ 不依赖设置页 / 客户端 GET / 手工 sweep。
      const adopted = adoptAgentRoot(agent);
      if (adopted && adopted.timer !== null) return; // armForRoot 已排程（一 root 单 timer）
    } catch { /* 忽略 */ }
  });

  onEvent("agent/created", (payload) => {
    try {
      const agent = payload?.agent;
      if (!agent) return;
      // 已登记主管（含 HMR 后重建的 Agent 实例）⇒ 直接布防其真实 root。
      // 未 claim 时 adoptAgentRoot 只读校验后返回 null，绝不抢先绑定/装 timer。
      const adopted = adoptAgentRoot(agent);
      if (adopted && adopted.timer !== null) return;
      const bound = entryOfAgent(agent);
      if (bound) { scheduleEntry(bound); return; }
      // 新建 Agent 可能是尚未 claim 的主管 ⇒ **仅当它所在 root 确实没有登记主管**时，才重开一次
      // 有界发现窗口（否则已 claim 的工作区会因每个新 Agent 反复重置窗口 ⇒ 高频扫描）。
      const root = rootOfAgent(agent);
      if (!root) return;
      let registered = null;
      try { registered = readSupervisorSessionFn(root); } catch { registered = null; }
      if (registered) return;
      try { if (!anyArmedEntry()) scheduleDiscovery(true); } catch { /* 忽略 */ }
    } catch { /* 忽略 */ }
  });

  onEvent("agent/disposed", (payload) => {
    try {
      const agent = payload?.agent;
      const root = rootOfAgent(agent);
      const childEntry = root ? entries.get(root) : null;
      const childId = String(agent?.session?.id ?? agent?.id ?? "");
      if (childEntry && childId) {
        let task = null;
        let key = null;
        for (const [k, t] of childEntry.tasks) {
          if (t.child === childId) { task = t; key = k; break; }
        }
        childEntry.pendingRunStarts.delete(childId);
        childEntry.pendingMessageBases.delete(childId);
        if (task) {
          const closed = closeTaskRun(childEntry, task, {
            stoppedAt: now(), stopSource: "disposed", stopExact: true, timing: timingForEntry(childEntry), dormant: true,
          });
          childEntry.tasks.set(key, closed);
          scheduleEntry(childEntry);
        }
      }
      const entry = entryOfAgent(agent);
      if (!entry) return;
      entry.supervisorAgent = null;
      scheduleEntry(entry);
    } catch { /* 忽略 */ }
  });

  onEvent("session/event", (session, event) => {
    try {
      if (!session?.id) return;
      const entry = [...entries.values()].find((e) => e.supervisorId === session.id);
      if (!entry) return;
      const surfaceOp = event?.surfaceOp;
      const isReplacement = !!surfaceOp && typeof surfaceOp === "object" && surfaceOp.op === "replace";
      const isCompactionOrClear = typeof event?.type === "string" && /(compact|clear)/i.test(event.type);
      if (!isReplacement && !isCompactionOrClear) return;
      for (const [id, ins] of entry.inspections) {
        if (ins.status !== "resolved" && ins.status !== "failed") {
          entry.inspections.set(id, { ...ins, status: "expired", lastError: "surface_replaced" });
        }
      }
      scheduleEntry(entry);
    } catch { /* 忽略 */ }
  });

  /** g-612：goal 预算编辑后立即按最近有效基准重算；paused 时保留冻结口径。 */
  const notifyGoalBudgetChanged = (rootArg, goal, budgetSeconds) => {
    const root = boardRootKey(rootArg);
    if (!root) return { ok: false, code: "workspace_unresolved" };
    const entry = entries.get(root);
    if (!entry) return { ok: true, changed: false, reason: "no_entry" };
    const budget = normalizeCareSeconds(budgetSeconds);
    const timing = timingForEntry(entry);
    const at = now();
    let changed = false;
    for (const [key, task] of entry.tasks) {
      if (task.goal !== goal) continue;
      // 同值重复设置（goal 真源未变）不是「新编辑」：不得反复重置截止/重复标记巡检。
      if ((normalizeCareSeconds(task.budgetSeconds) ?? null) === (budget ?? null)) continue;
      const updated = applyBudgetChangeToTask(entry, { ...task, budgetSeconds: budget }, {
        at, timing, forceCountdown: true, observedEdit: true,
      });
      entry.tasks.set(key, updated);
      changed = true;
    }
    // g-612 att011：首次 care 采样**之前**发生的真实 goal 预算编辑必须进入 pending run 的起点
    // 时间线（真实通知时点 = 可证生效时点，按发生顺序），不得等首次采样把多次修改压成一条最终值。
    // 只记录到确实在起点快照里捕获过该 goal 的 pending run；同值不新增；有界 31 条 + truncated。
    const eff = careEffectiveBudgetSeconds({ budgetSeconds: budget }, timing);
    let pendingChanged = false;
    for (const pending of entry.pendingRunStarts.values()) {
      if (!(pending?.startBudgets instanceof Map)) continue;
      const start = pending.startBudgets.get(goal);
      if (!start || !(pending.changes instanceof Map)) continue;
      const rec = pending.changes.get(goal) ?? { list: [], truncated: false };
      const last = rec.list.length ? rec.list[rec.list.length - 1] : start;
      if (last && last.seconds === eff.seconds && last.source === eff.source) continue;
      let list = [...rec.list, { at, seconds: eff.seconds, source: eff.source }];
      let truncated = rec.truncated === true;
      if (list.length > BUDGET_CHANGE_LIMIT) {
        list = list.slice(-BUDGET_CHANGE_LIMIT);
        truncated = true;
      }
      pending.changes.set(goal, { list, truncated });
      pendingChanged = true;
    }
    if (changed || pendingChanged) scheduleEntry(entry);
    return { ok: true, changed };
  };

  /**
   * g-613：同一 child 被**复用**到新目标后的关照对账（复用与换 attempt 同一语义，不做例外）。
   *
   * 为什么必须显式做一次：care 的任务键是 `goal\0attempt`（不含绑定代际），而跨目标复用最常出现的 attempt id
   * 恰好都是 `att-001` ⇒ 旧目标 A/att-001 与 新目标 B/att-001 **同键**。若不清旧：
   *   · 旧任务的计时/锁/未答计数会被当成本任务的既有状态（沿用旧 attempt 的计时与 inactive 状态）；
   *   · 已投递的旧代际巡检在新绑定下 `bindingVersion` 已换代 ⇒ 结论必然 stale（不会误作用），
   *     但会把新任务「假装还在等一份已经不存在的结论」，因此这里直接按目标 retire 掉。
   * 新绑定从**此刻**重新计时（不继承旧自身状态）；旧目标的 dormant/人工锁条目随目标一起清除。
   */
  const notifyReusedBinding = (rootArg, input = {}) => {
    const root = boardRootKey(rootArg);
    if (!root) return { ok: false, code: "workspace_unresolved" };
    const entry = entries.get(root);
    if (!entry) return { ok: true, changed: false, reason: "no_entry" };
    const child = String(input.child ?? "");
    const attempt = String(input.attempt ?? "");
    const goal = String(input.goal ?? "");
    if (!child || !attempt || !goal) return { ok: false, code: "bad_target" };
    const at = now();
    const drop = new Set(); // `${goal}\0${attempt}`
    drop.add(`${goal}\u0000${attempt}`);
    const prior = input.prior ?? null;
    // 旧绑定：同一 child 的**全部**其它任务（含 A/att-001）都属旧代际，一并 retire。
    for (const t of entry.tasks.values()) {
      if (t.child !== child) continue;
      if (t.attempt === attempt && t.goal === goal) continue;
      drop.add(`${t.goal}\u0000${t.attempt}`);
    }
    if (prior?.goal && prior?.attempt) drop.add(`${prior.goal}\u0000${prior.attempt}`);
    let removedTasks = 0;
    for (const key of [...entry.tasks.keys()]) {
      const t = entry.tasks.get(key);
      if (!t) continue;
      if (drop.has(`${t.goal}\u0000${t.attempt}`) && !(t.goal === goal && t.attempt === attempt && input.accepted === true)) {
        // 不写 dormant：旧代际的锁/计数绝不复活到新绑定上。
        entry.tasks.delete(key);
        removedTasks += 1;
      }
    }
    for (const [key, d] of [...entry.dormant]) {
      if (!d || d.child !== child) continue;
      if (d.goal === goal && d.attempt === attempt) continue;
      entry.dormant.delete(key);
    }
    // 旧代际巡检：按目标 retire（已投递的照样过期，未投递的直接作废）。
    let removedInspections = 0;
    for (const [id, ins] of [...entry.inspections]) {
      if (ins.status === "resolved" || ins.status === "failed" || ins.status === "expired") continue;
      const hitsNew = ins.targets.some((t) => t.child === child && t.goal === goal && t.attempt === attempt);
      const hitsDropped = ins.targets.some((t) => drop.has(`${t.goal}\u0000${t.attempt}`));
      if (!hitsNew && !hitsDropped) continue;
      entry.inspections.set(id, { ...ins, status: "expired", lastError: "reused_child_new_binding" });
      if (ins.messageId) entry.messageIndex.delete(ins.messageId);
      removedInspections += 1;
    }
    // 新绑定的起点事实按本次复用"翻篇"：不继承任何旧轮观察值。
    entry.pendingRunStarts.delete(child);
    entry.pendingMessageBases.delete(child);
    const hadLegacy = removedTasks > 0 || removedInspections > 0;
    if (hadLegacy) {
      try {
        appendCareEvent(entry, "care.rebind", {
          goal, attempt, child,
          binding_version: Number(input.bindingVersion) || 0,
          prior: prior ? { goal: prior.goal, attempt: prior.attempt } : null,
          retired_tasks: removedTasks,
          retired_inspections: removedInspections,
          at,
        }, careStateSnapshot(entry));
      } catch { /* 事件失败不阻断调度 */ }
    }
    scheduleEntry(entry);
    return { ok: true, changed: hadLegacy, retired_tasks: removedTasks, retired_inspections: removedInspections };
  };

  return {
    start,
    dispose,
    sweep,
    statusFor,
    control,
    submitOutcome,
    notifyGoalBudgetChanged,
    // g-613：复用空闲子代理后按新绑定重算关照（retire 旧代际任务/巡检，不继承旧计时与锁）。
    notifyReusedBinding: (rootArg, input) => {
      try { return notifyReusedBinding(rootArg, input); } catch (e) { return { ok: false, code: "error", detail: String(e?.message ?? e) }; }
    },
    entryOfRoot,
    // g-506 返工：生产事件链（成功 claim / 真实主管事件）显式布防入口；幂等、只读校验、失败不抛。
    armForRoot,
    rootOfWorkspace: (workspace) => canonicalRootOfWorkspace(workspace),
    stateForWorkspace: (workspace) => {
      const root = canonicalRootOfWorkspace(workspace);
      return root ? entries.get(root) ?? null : null;
    },
    states: () => [...entries.values()],
  };
}

const text = (s) => [{ type: "text", text: s }];
const objOut = {
  schema: { type: "object" },
  render: (_a, v) => text(JSON.stringify(v, null, 2)),
};
const str = { type: "string" };
const strArr = { type: "array", items: { type: "string" } };
/** g-501：布尔参数的字面量简写（与 str/strArr 同风格；既有工具里 { type:"boolean" } 逐字等价）。 */
const bool = { type: "boolean" };

// supervisor attempt 的关键事实必须结构化传入，不从 brief/directive 的自然语言猜测。
const ATTEMPT_TASK_TYPE_LABELS = Object.freeze({ merge: "合入", rewrite: "重写", fix: "修复" });
const ATTEMPT_TASK_TYPE_VALUES = Object.freeze(Object.keys(ATTEMPT_TASK_TYPE_LABELS));
const ATTEMPT_TASK_TYPE_SCHEMA = {
  type: "string",
  enum: [...ATTEMPT_TASK_TYPE_VALUES],
  nullable: true,
  description: "枚举：merge=合入既有候选/集成，rewrite=重写实现，fix=修复现有实现。只传 ASCII 枚举值；不确定时传 null 或省略；不要传中文、自然语言或空字符串。",
};
const ATTEMPT_OPTIONAL_STRING_SCHEMA = {
  type: "string",
  minLength: 1,
  nullable: true,
  description: "由 supervisor 直接提供的当前事实；传 null 或省略表示未提供；不要传空字符串，不能从 brief/handoff 推断。",
};
/** g-613：复用空闲专家子代理（宿主 durable child session id）；不传/null = 全新 spawn（既有行为）。 */
const ATTEMPT_REUSE_CHILD_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  nullable: true,
  description: "可选：复用**已空闲**的专家子代理承接本目标（宿主 durable child session id，必须属于当前主管）。"
    + "运行中/不在 registry/被其它未交付目标占用 ⇒ 显式拒绝且零副作用。"
    + "复用不切换工作目录与工具权限（继承其创建时的父会话），也不创建 worktree。不传或 null = 全新派发子代理。",
};
const ATTEMPT_ACCEPTANCE_ITEMS_SCHEMA = {
  type: "array",
  items: { type: "string", minLength: 1 },
  nullable: true,
  description: "当前验收项数组，每项一个非空 string；传 [] 明确表示无单独验收项，传 null 或省略表示未提供；不要从 brief 猜测。",
};
const ATTEMPT_STATUS_STATE_SCHEMA = {
  type: "string",
  enum: ["working", "blocked", "done", "error"],
  nullable: true,
  description: "结构化状态枚举：working=进行中、blocked=阻塞、done=完成、error=错误；与 status 一起传入。旧调用可省略。",
};

// g-133：dsh-graph profile 级全局默认（DSH settings namespace「dsh-graph」）。
// 仅保留子代理 provider/model/补充提示词；主管提示词属于 workspace 配置（g-132）。
const GRAPH_SETTINGS_NS = "dsh-graph"; // 合法 namespace（[a-z][a-z0-9-]*）
// g-351：新宿主（0.1.7 线）的设置表单以 **profile 条目 id** 为键（`SettingsDescriptor.ns`），
// 即 cordis.patch.yml 的 insert id；插件自身 name 一并纳入匹配，容忍用户层 patch 改 id。
const GRAPH_SETTINGS_ENTRY_ID = "dsh-graph-host";
const GRAPH_SETTINGS_DEFAULTS = Object.freeze({
  subagentProvider: "",
  subagentModel: "",
  subagentMode: "",
  subagentReasoningEffort: "",
  subagentPrompt: "",
  promptLanguage: "follow",
  /**
   * g-505：主管上下文缓存保活的 **profile 级**全局开关（三态字符串）。
   *   ""    = 未配置（受控默认：尝试开启，见 core KEEP_ALIVE_DEFAULT_ENABLED）
   *   "on"  = 显式开启
   *   "off" = 显式关闭
   * 用三态字符串而非裸 boolean：可区分「未配置」与「显式关闭」，这正是 project.yaml 的
   * `inherit` 要继承的那个来源。**畸形值**（如手改 YAML 写 "yes"）由 readGlobalKeepAliveState
   * 如实标 malformed ⇒ fail-closed 关闭，绝不归一成「未配置 ⇒ 默认开启」。
   */
  supervisorKeepAlive: "",
  /**
   * g-506：子代理长任务关照的 **profile 级**全局开关（三态字符串；默认未配置 ⇒ 受控默认开启）。
   *   "" = 未配置；"on" = 显式开启；"off" = 显式关闭。
   * 畸形值（如手改 "yes"）由 readGlobalCareState 如实标 malformed ⇒ fail-closed 关闭。
   */
  supervisorCare: "",
  /** g-506：全局任务工作阈值（秒，字符串原值；"" = 未配置 ⇒ 300s）。 */
  supervisorCareThresholdSeconds: "",
  /** g-506：全局复查间隔（秒，字符串原值；"" = 未配置 ⇒ 300s）。 */
  supervisorCareRecheckSeconds: "",
});

// ── g-454：宿主代次迁移缺口（旧 settings.yaml 的 `dsh-graph` 节进不了新条目 `dsh-graph-host`）──
// 只读核实的宿主事实（0.2.0-rc.2，@deepseek-ai/dsh-settings/lib/index.js）：
//   · `LEGACY_SECTION_ENTRIES` 是该模块内的**模块私有 const 字面量**（:303-308），仅 3 条硬编码
//     映射（ui-developer-tools→ui-settings、ui-onboarding→ui-settings-general、shell→平台 shell 执行器）；
//     全模块唯一用法是 :354 `LEGACY_SECTION_ENTRIES[section] ?? section`。
//   · 该模块**只导出** SettingsForms / SettingsConflictError / redactSecrets（:544）——该表既不导出，
//     也没有别名、注册或扩展点（标识符全模块只出现 2 次：:303 定义、:354 使用，无 config 读取）。
//   ⇒ 插件与配置文件**都无法**影响该映射；节名映射不到活动条目时 :355-360 的 update 抛错被 catch 成
//    一条 warn，值**只留在 settings.yaml.imported** 中（宿主 README.md 亦如此记载）。
//   本插件 0.1.6 线的设置节名 = 历史 namespace `dsh-graph`，0.2.0 线的条目 id = `dsh-graph-host`
//   ⇒ 升级用户的旧全局设置（子代理 provider/model/mode/补充提示词、提示词语言）进不了新条目。
// 补偿（只在**新能力**分支生效，旧能力分支的 namespace 路径本来就按 `dsh-graph` 读，行为不变）：
//   把旧节的同名字段补进本条目**仅缺失**的字段——一次性、幂等、显式值优先、失败一律降级不阻断。
const GRAPH_LEGACY_SETTINGS_SECTION = GRAPH_SETTINGS_NS; // "dsh-graph"：旧节的节名
/** 旧文档的两个候选位置：宿主 rename 之前 / 之后（先命中者优先）。 */
const GRAPH_LEGACY_SETTINGS_FILES = Object.freeze(["settings.yaml", "settings.yaml.imported"]);
/** 一次性迁移标记（落 profile 目录，**迁移成功后**才写）：既保证只做一次，也是落盘留痕。 */
const GRAPH_LEGACY_SETTINGS_MARKER = ".dsh-graph-legacy-settings-migrated";
const GRAPH_SETTINGS_FIELD_KEYS = Object.freeze(Object.keys(GRAPH_SETTINGS_DEFAULTS));

/**
 * 只接受**已知字段**的合法非空字符串值；未知键、非字符串、非法枚举、空串一律丢弃（绝不猜测）。
 * @param section 旧文档里 `dsh-graph` 节的原始值。
 * @returns 归一化后的可补字段；无可补字段时返回 null。
 */
function coerceLegacyGraphSettings(section) {
  if (!section || typeof section !== "object" || Array.isArray(section)) return null;
  const out = {};
  for (const key of GRAPH_SETTINGS_FIELD_KEYS) {
    if (!Object.hasOwn(section, key)) continue;
    const value = section[key];
    if (typeof value !== "string" || value === "") continue;
    if (key === "subagentMode") {
      const mode = normalizeSubagentMode(value);
      if (!mode) continue;
      out[key] = mode;
      continue;
    }
    if (key === "promptLanguage" && !["follow", "zh", "en"].includes(value)) continue;
    // g-505：`supervisorKeepAlive` 是本版新字段，不属于旧节迁移范围 —— 当前全局值只认
    // 公开 settings 条目的显式值/当前 settings.yaml，绝不让迁移遗留（含 `.imported`）复活它。
    if (key === "supervisorKeepAlive") continue;
    // g-506：关照字段同为当前版本新字段，绝不从旧节复活（当前值只认活动条目/当前 settings.yaml）。
    if (key === "supervisorCare" || key === "supervisorCareThresholdSeconds" || key === "supervisorCareRecheckSeconds") continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 「缺失才补」的补丁计算：`user` 是宿主 describe() 给出的 **profile patch 显式值**视图，
 * 其中**已有该键**即视为用户显式设定（哪怕值是空串）⇒ 绝不覆盖；缺失才取旧值。
 * 这也是幂等的判定点：无缺失字段 ⇒ 返回 null ⇒ 零写入。
 * @param user descriptor.user（profile patch 里显式写下的键值）。
 * @param legacyValues 旧节归一化后的值。
 * @returns 需补写的字段；无缺失时返回 null。
 */
function graphSettingsMissingPatch(user, legacyValues) {
  if (!legacyValues || typeof legacyValues !== "object") return null;
  const explicit = user && typeof user === "object" && !Array.isArray(user) ? user : null;
  const patch = {};
  for (const [key, value] of Object.entries(legacyValues)) {
    if (explicit && Object.hasOwn(explicit, key)) continue;
    patch[key] = value;
  }
  return Object.keys(patch).length ? patch : null;
}

// schema 需 schemastery（@deepseek-ai/*），经守卫式动态 import 构建（见 buildGraphSettingsSchema）。
function buildGraphSettingsSchema(z) {
  return z.object({
    subagentProvider: z.string().default(""),
    subagentModel: z.string().default(""),
    subagentMode: z.union(["", "standard", "minimal"]).default(""),
    subagentReasoningEffort: z.string().default(""),
    subagentPrompt: z.string().default(""),
    promptLanguage: z.union(["follow", "zh", "en"]).default("follow"),
    // g-505：全局保活开关（"" = 未配置/跟随受控默认；"on"/"off" = 显式）。
    supervisorKeepAlive: z.union(["", "on", "off"]).default(""),
    // g-506：全局关照开关与时间参数（"" = 未配置；时间参数为字符串原值，非法值由读侧标 malformed）。
    supervisorCare: z.union(["", "on", "off"]).default(""),
    supervisorCareThresholdSeconds: z.string().default(""),
    supervisorCareRecheckSeconds: z.string().default(""),
  });
}

// g-351：profile 级全局默认在**新宿主**上的声明面。
// 旧宿主（0.1.6 线）的 settings 服务提供 namespace 注册 API（`settings.register`），值存于
// $DSH_HOME/settings.yaml；新宿主（0.1.7 线）移除了该 API，改为把插件 entry 的 Config schema
// 投影成设置表单、并把编辑写回 profile patch。故这里以命名导出 `Config` 声明**同一组字段**，
// 供新宿主生成表单；每个字段标记 volatile ⇒ 可在设置页热改而无需重挂载。
// 旧宿主上这份声明没有消费方（其值仍由 namespace 路径提供），故不改变 0.1.6 行为。
// schemastery 是可选 peer：同步解析失败时 `Config` 为 undefined（等价旧行为，插件照常加载）。
function buildGraphSettingsConfigSchema(z) {
  const live = (field) => (typeof field?.volatile === "function" ? field.volatile() : field);
  return z.object({
    subagentProvider: live(z.string().default("")),
    subagentMode: live(z.union(["", "standard", "minimal"]).default("")),
    subagentModel: live(z.string().default("")),
    subagentReasoningEffort: live(z.string().default("")),
    subagentPrompt: live(z.string().default("")),
    promptLanguage: live(z.union(["follow", "zh", "en"]).default("follow")),
    supervisorKeepAlive: live(z.union(["", "on", "off"]).default("")),
    supervisorCare: live(z.union(["", "on", "off"]).default("")),
    supervisorCareThresholdSeconds: live(z.string().default("")),
    supervisorCareRecheckSeconds: live(z.string().default("")),
  });
}
// g-351：schemastery 是**可选** peer，插件不得硬依赖它。宿主部署形态不同，可解析的基准也不同
// （插件自身相邻的 node_modules / 宿主 CLI 自身的 node_modules），故按基准依次尝试；
// 全部失败返回 null（等价旧行为：不声明 Config、namespace 路径跳过）。
function resolveSchemastery() {
  const bases = [];
  try { bases.push(import.meta.url); } catch { /* 无 import.meta */ }
  try {
    if (process.argv[1]) {
      bases.push(pathToFileURL(process.argv[1]).href);
      // 包管理器常以 symlink 启动 CLI（如 fnm 的 bin/dsh → lib/node_modules/.../bin.js），
      // 而 node_modules 查找要沿**真实路径**上行，故再补一个 realpath 基准。
      bases.push(pathToFileURL(realpathSync(process.argv[1])).href);
    }
  } catch { /* 无 argv[1] 或不可 realpath */ }
  for (const base of bases) {
    try {
      const loaded = createRequire(base)("@deepseek-ai/schemastery");
      const schema = loaded?.default ?? loaded;
      if (schema && typeof schema.object === "function") return schema;
    } catch { /* 该基准不可解析，试下一个 */ }
  }
  return null;
}
let graphSettingsConfig;
try {
  const z = resolveSchemastery();
  if (z) graphSettingsConfig = buildGraphSettingsConfigSchema(z);
} catch { /* 可选 peer 缺失：不声明 Config */ }
export { graphSettingsConfig as Config };

function params(properties, required) {
  // g-190（review P0）：工具参数严格白名单——拒绝未知/多余字段
  return { type: "object", properties, required, additionalProperties: false };
}

function losslessJson(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = typeof v === "object" && v !== null ? losslessJson(v) : v;
    }
  }
  return out;
}

function normalizePromptLanguage(value) {
  return value === "en" || value === "zh" ? value : "zh";
}

/** Resolve prompt language without making locale a hard dependency. */
export function resolvePromptLanguage(override = "follow", ctx = null) {
  if (override === "zh" || override === "en") return override;
  const pick = (value) => {
    if (typeof value !== "string") return null;
    const base = value.toLowerCase().split(/[-_]/)[0];
    return base === "en" || base === "zh" ? base : null;
  };
  try {
    // 首选：DSH settings 服务的 locale.preference（服务端可读的界面语言，
    // 由 dsh-client-locale 注册命名空间 "locale"、字段 "preference"）。
    // 兼容两代 Settings 服务：0.1.6 的 .get("locale") 与 0.2.x 的 .describe() 表单投影。
    const svc = ctx?.get?.("settings") ?? ctx?.settings;
    if (svc) {
      if (typeof svc.describe === "function") {
        try {
          const rows = svc.describe({ redactSecrets: true });
          const row = Array.isArray(rows) ? rows.find((r) => r?.ns === "locale") : null;
          const pref = pick(row?.value?.preference ?? row?.user?.preference);
          if (pref) return pref;
        } catch { /* describe 异常降级 */ }
      }
      const viaGet = pick(svc.get?.("locale")?.preference);
      if (viaGet) return viaGet;
    }
  } catch { /* settings 服务可选 */ }
  try {
    // 次选：直接暴露的 locale 服务（部分宿主组合）。
    // g-425：**顺序必须是 ctx.get 优先** —— locale 未注册为服务时 `ctx.locale` 裸访问会抛
    // `cannot get property "locale" without inject`（cordis 注入门禁），被本 try 吞掉后
    // `ctx.get("locale")` 这条兜底根本没机会执行（等于该分支永久失效）。反过来先 get：
    // 服务在时两者是同一实例（行为不变），不在时 get 返回 undefined ⇒ 才轮到受 try 保护的裸访问。
    const locale = ctx?.get?.("locale") ?? ctx?.locale;
    const snapshot = locale?.getLocale?.() ?? locale?.snapshot?.() ?? locale;
    const active = pick(snapshot?.active ?? snapshot?.locale ?? snapshot?.id ?? locale?.active);
    if (active) return active;
  } catch { /* locale service is optional */ }
  return "zh";
}

// ===== g-496：提示词资产读取（**按所有权分目录**，无跨目录静默回落）=====
// 负责人 2026-10-14 跨宿主资产所有权裁定，2026-10-15 返工细化：提示词按**语义归属**分层，
// 不按「谁当前投递」划分，也**不以任何资产/目录的存在性**推断当前形态。
//
//   · **公共层** `<repo>/prompts/` —— 跨宿主共用正文（目标/attempt 纪律、人工 gate、证据/报告
//     格式、Agent Teams 契约、模式策略、自动化指导、主管技能指南、通用 graph 模块说明）。
//     适配器（本插件、未来的 Claude / pi-ai / Codex 插件、独立 MCP）都依赖它，它**不反向依赖
//     任何宿主**。
//   · **宿主专属层** `dsh-graph-host/prompts/` —— 仅真正绑定 DSH 会话/section/GUI 模板语义的正文。
//
// **形态由显式布局标记决定**（`package.json` 的 `dsh.promptAssets.layout`，无新依赖）：
//   · `"source"`（`dsh-graph-host/package.json`，即仓库内直跑）—— 两层物理分离，按归属取根：
//     公共资产走 `publicDir`（`../prompts`）、宿主专属走 `hostDir`（`./prompts`）；
//   · `"merged"`（`build.sh` 生成到 `dist/package.json`）—— 两层已合并进包内单一 `dir`
//     （`./prompts`），**所有**资产都从该根读。
//
// ⚠️ 两条铁律（g-496 返工核心，均由回归用例钉住）：
//   ① **发布上下文绝不回读源码**：标记为 `merged` 时，包内缺文件、整个 `prompts/` 缺失、
//      乃至用于判别的文件缺失，都**只**导致读取失败 ⇒ 由 `requirePromptAsset` fail-closed 抛错；
//      绝不回落到邻接的源码树（把 `dist/` 放在仓库内时 `../prompts/` 会命中源码 ⇒ 曾把
//      「包内漏资产」伪装成「读到了」）。
//   ② **标记缺失或非法即明确失败**：解析不到（无清单 / 无 `dsh.promptAssets`）、`layout` 取值
//      非 `source`/`merged`、或该形态所需目录字段缺失 —— 一律视为**发布上下文中的配置损坏**，
//      抛错暴露，**绝不静默偷归 source**（否则删一个字段就能把发布形态降级成读源码）。
//
// 归属的**唯一真源**是 `HELP_ASSET_REGISTRY`（见下）—— 注册表按资产登记所有权，
// reader / catalog / HTTP 处理器全部从它取根取路径，**不存在第二份清单**。

/** 发布形态的**唯一合法资产根**（构建常量，与 `scripts/build.sh` 写出的 `dir` 一字不差）。
 *
 *  g-496 返工（运行态紧锁）：merged 分支**只接受这个确切值**，不做路径归一、不判定「是否在包内」、
 *  不提供任何通用路径框架 —— 任何其它取值（尤其 `../prompts` 这类误配置）一律 `layout invalid`。
 *  导出供守卫断言「运行时常量与构建常量一致」，避免两处漂移。 */
export const MERGED_PROMPT_ASSET_DIR = "./prompts";

/** 读取并校验布局标记；配置损坏 ⇒ 抛错（**不**静默回落 source）。
 *
 *  返回 `{ layout, dirs }`：`dirs` 提供**待拼接资产名的根**（相对 `import.meta.url`）。
 *  源形态按归属分层（public/host 两层），发布形态两层同为 `MERGED_PROMPT_ASSET_DIR`。 */
function resolvePromptAssetRoots() {
  const manifestUrl = new URL("./package.json", import.meta.url);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
  } catch (cause) {
    throw new Error(`dsh-graph prompt asset layout unreadable: package.json (${manifestUrl.href})`);
  }
  const marker = manifest?.dsh?.promptAssets;
  if (!marker || typeof marker !== "object") {
    throw new Error("dsh-graph prompt asset layout marker missing: dsh.promptAssets in package.json");
  }
  const { layout } = marker;
  if (layout === "merged") {
    const dir = marker.dir;
    // 发布形态：**唯一根必须等于构建常量 `./prompts`**（g-496 返工：运行态紧锁）。
    // 不解析、不归一、不做「包内判定」的通用路径框架 —— 只要不等于确切常量就判非法。
    // 理由：`dir` 是 build **写死**的包内常量，任何其它取值（尤其 `../prompts` 这类
    // 误配置）都会把发布态引回**包外源码**，直接破坏「发布态绝不回读源码」的铁律。
    // 因此这里不是「配置校验」，而是**发布形态的不可协商不变量**。
    if (dir !== MERGED_PROMPT_ASSET_DIR) {
      throw new Error(
        `dsh-graph prompt asset layout invalid: dsh.promptAssets.dir must be exactly ${JSON.stringify(MERGED_PROMPT_ASSET_DIR)} when layout is "merged" (got ${JSON.stringify(dir)})`,
      );
    }
    return { layout, dirs: { public: MERGED_PROMPT_ASSET_DIR, host: MERGED_PROMPT_ASSET_DIR } };
  }
  if (layout === "source") {
    const { publicDir, hostDir } = marker;
    if (typeof publicDir !== "string" || typeof hostDir !== "string" || !publicDir || !hostDir) {
      throw new Error('dsh-graph prompt asset layout invalid: dsh.promptAssets.publicDir/hostDir required when layout is "source"');
    }
    return { layout, dirs: { public: publicDir, host: hostDir } };
  }
  throw new Error(`dsh-graph prompt asset layout invalid: unknown layout ${JSON.stringify(layout)}`);
}

/** 资产根解析结果（进程内缓存——布局标记是**包级常量**，运行期不会变）。
 *  缓存使每次读取不必重解析 JSON；损坏标记仍会抛错（失败不被缓存掩盖）。 */
let _promptAssetRootsCache = null;
function promptAssetRoots() {
  if (_promptAssetRootsCache === null) _promptAssetRootsCache = resolvePromptAssetRoots();
  return _promptAssetRootsCache;
}

/** 某资产名在**当前形态**下的根目录（相对 `import.meta.url`）。
 *
 *  归属取自注册表（唯一真源）；未登记的名字按**公共层**处理（公共层是默认归属）。
 *  源形态下按归属选 `publicDir` / `hostDir`；发布形态下两层同根。 */
function promptAssetDirFor(name) {
  const roots = promptAssetRoots();
  if (roots.layout === "merged") return roots.dirs.public;
  return assetOwnership(name) === "host" ? roots.dirs.host : roots.dirs.public;
}

function readPromptAsset(name, language = "zh") {
  const lang = normalizePromptLanguage(language);
  // 单根、单候选：形态与归属共同决定唯一路径，**没有**「失败就换另一个根」的回落链
  // （那正是 fail-open 的来源）。
  const dir = promptAssetDirFor(name);
  const rel = `${dir.replace(/\/+$/, "")}/${name}.${lang}.md`;
  try {
    return readFileSync(new URL(rel, import.meta.url), "utf8");
  } catch {
    return ""; // 由 requirePromptAsset fail-closed 抛错（含包内缺资产 / 目录缺失）
  }
}

/** 某资产名的**所有权**（`"public"` | `"host"`）—— 取自**唯一注册表** `HELP_ASSET_REGISTRY`。
 *
 *  g-496 返工：所有权不再另持第二份清单（原 `HOST_OWNED_PROMPT_ASSETS` 已删除）——
 *  reader / catalog / HTTP 处理器与所有权**同源**，任何归属调整只改注册表一处，
 *  不可能出现「清单说 host、注册表说 public」的分裂。
 *
 *  未登记的名字一律视为**公共层**资产（公共层是默认归属，新增公共资产无需登记归属；
 *  只有真正绑定 DSH 宿主语义的资产才需要登记为 host）。
 *
 *  入参是资产的**基名**（不带 `.zh`/`.en` 后缀）——归属是资产的**跨语言**属性，两种语言同属一层。
 *
 *  当前 **host 归属 = 9 类 GUI 提示词模板**（g-496 att-007 迁入宿主专属层 `dsh-graph-host/prompts/`）：
 *  这些正文是 DSH 会话 `session.prompt` 载荷 / 看板 GUI 动作语义专属，跨宿主插件不复用。
 *  其余资产（含 `help`：通用 graph 模块说明，按负责人 2026-10-15 裁定）仍统一归**公共层**。 */
function assetOwnership(name) {
  const hit = HELP_ASSET_REGISTRY.find((e) => e.name === `${name}.zh.md` || e.name === `${name}.en.md`);
  return hit?.ownership === "host" ? "host" : "public";
}

function requirePromptAsset(name, language = "zh") {
  const content = readPromptAsset(name, language);
  if (!content) throw new Error(`dsh-graph prompt asset missing or unreadable: ${name}.${normalizePromptLanguage(language)}.md`);
  return content;
}

function localizedPrompt(name, language) {
  return requirePromptAsset(name, language);
}

/** g-496：执行者纪律的**模板正文**（看板协同块 + 测试力度分级 + 证据形式）唯一真源 =
 *  `prompts/executor-discipline.<lang>.md`（随构建拷入 `dist/prompts/`，运行期现读、无启动缓存）。
 *  正文中的动态 id 写成 `{goal}` / `{attempt}` 占位符，由调用方回填 ⇒ 模板只有一份、两语言对偶。
 *  读取失败 fail-closed（`requirePromptAsset` 抛错，绝不静默降级为内置文本或空串）。
 *
 *  ⚠️ 该资产与其对偶语言受 core/tests/prompt-i18n-parity.test.ts 的**四重相等**约束：
 *  行数 / `##` 标题数 / **占位符多重集** / 技术 token 集合。这正是「看板协同块」（含
 *  `graph_transition` 与 `{attempt}`）必须在**两种语言里都出现**的原因——只搬 zh 会让 en 侧缺
 *  3 个 `{goal}`、1 个 `{attempt}` 与 `graph_transition`，parity 立刻判红；故 en 资产自带对偶的
 *  看板协同块（英文重写）。代码只保留**标题 / 空行 / 前言**三类结构脚手架，使注入载荷的位点
 *  恰好落在资产**边界**上（zh 落在首行之前、en 落在末行之后），不需要任何行内哨兵标记。 */
function executorDisciplineTemplate(language = "zh") {
  return requirePromptAsset("executor-discipline", language).replace(/\n+$/, "").split("\n");
}

/** g-496：把模板里的 `{goal}` / `{attempt}` 回填为本次 attempt 的实际 id（其余花括号原样保留，
 *  不猜、不吞、不做通用插值）。占位符形态 `{name}` 与 parity 的识别口径同形，
 *  故两侧占位符**多重集**可被自动逐项比对。 */
function fillExecutorDisciplineTemplate(lines, { goal, attempt }) {
  return lines.map((line) => line.replace(/\{goal\}/g, goal).replace(/\{attempt\}/g, attempt));
}

/** g-496：attempt 定位固定正文的唯一真源 = `prompts/attempt-instructions.<lang>.md`。
 *
 *  该资产以 `<!-- dsh-graph:phrase:<key> -->` 定界注释把**同一条正文**切成若干命名片段，
 *  使代码可以**逐片段**取用（定位三行 / 覆盖声明的固定句 / 状态字段契约 / 通用纪律前言），
 *  而不必把整段拼装顺序搬进资产、也不必在代码里留第二份中文副本。
 *
 *  为什么用注释定界而不是整段模板：attempt prompt 的**区块顺序与条件逻辑**（哪些段有值、
 *  何时插入 modeStrategy / history / 骨架）是**装配逻辑**，按 brief 须留在代码；只有「措辞」
 *  下沉。定界注释对 prompt 产物**不可见**（读取时按标记切分并丢弃标记行）。
 *
 *  读取失败 fail-closed（`requirePromptAsset` 抛错，绝不静默降级为内置文本）。 */
function attemptInstructionsPhrases(language = "zh") {
  const lang = normalizePromptLanguage(language);
  if (_attemptInstructionPhrases[lang]) return _attemptInstructionPhrases[lang];
  const raw = requirePromptAsset("attempt-instructions", lang).replace(/\r\n/g, "\n");
  const phrases = {};
  const re = /^<!--\s*dsh-graph:phrase:([A-Za-z0-9_.-]+)\s*-->\s*$/gm;
  const marks = [...raw.matchAll(re)];
  if (marks.length === 0) throw new Error(`attempt-instructions.${lang}.md 缺少必需 phrase marker`);
  for (let i = 0; i < marks.length; i++) {
    const key = marks[i][1];
    if (Object.prototype.hasOwnProperty.call(phrases, key)) throw new Error(`attempt-instructions.${lang}.md phrase marker 重复：${key}`);
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : raw.length;
    const phrase = raw.slice(start, end).replace(/^\n+/, "").replace(/\n+$/, "");
    if (!phrase.trim()) throw new Error(`attempt-instructions.${lang}.md 必需 phrase 为空：${key}`);
    phrases[key] = phrase;
  }
  _attemptInstructionPhrases[lang] = phrases;
  return phrases;
}
const _attemptInstructionPhrases = {};

/** g-496：phrase 片段里的 `{{name}}` 回填（只认双花括号、不递归展开；缺键显性失败）。 */
function fillPhrase(text, vars) {
  if (typeof text !== "string" || !text.trim()) throw new Error("必需 attempt phrase 缺失或为空");
  return text.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (whole, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`attempt phrase 缺少必需变量：${name}`);
    return String(vars[name]);
  });
}

/** g-493 / g-495：`graph_help(topic)` 的主题抽取（纯函数，返回 null 表示该主题不存在）。
 *  主题口径（与 prompts/*.{zh,en}.md 的章节标题同源，不做第二份目录）：
 *   · `usage` / `使用说明`          ⇒ **整份 usage 资产全文**（含 `## 工具细则`，见下）；
 *   · `graph_engineering` / `图工程` ⇒ 「为什么叫 dsh-graph…」章节（**跨资产**查找，见下）；
 *   · 任一**功能模块名**            ⇒ 该模块那一行（`| <名> | … |` 表格行）。
 *  g-495：工具名主题**已删除**（负责人 2026-10-13 选 (c)：schema 注入已提供足够信息，
 *  没必要按工具名查）—— `topic` 只认 `usage` / `graph_engineering` / 模块名；未知名（含工具名）
 *  ⇒ `null` ⇒ 全文 + `found=false`。模块名真源 = `HARNESS_MODULE_IDS`（core/ops.ts 单一真源，
 *  此处不另抄一份字面量），别名走 `MODULE_TOPIC_ALIASES`。
 *  g-495 返工（负责人 2026-10-13 裁决·出路 1）：点题段已从 agent 面向的 `help.*.md` **迁到**
 *  按需面 `usage.*.md`（help 不再介绍项目背景与命名缘由）⇒ `graph_engineering` 分支改为
 *  **跨资产**查找：先在 help 正文里找该章节，找不到再到 usage 正文里找。两条路径共用同一
 *  章节判定（标题含 `dsh-graph` 且含「图工程 / Graph Engineering」），不另立第二套口径。
 *  章节名按 `## ` 切分 ⇒ 资产改标题时必须同步本函数（守卫 core/tests/g493-help-topic.test.ts 钉住）。
 *  `extraTexts` 为可选的**追加查找面**（缺省 `[]` 时行为与单资产版逐字一致）。
 *
 *  g-495 att-005 修（负责人 2026-10-15 真实 review 授权）：`usage` 主题原实现取 **help 正文**
 *  「文首到第一个 `## `」，而 help 资产首行只有一句 `共 5 个功能模块：` ⇒ `graph_help(topic="usage")`
 *  虽 `found:true` 却只返回 10 字符，**承诺的工具细则永远读不到**（死链）。usage 的真实面在
 *  **按需资产 `usage.*.md`**（含 `## 工具细则` / 签名 / 证据分层）—— 故该分支改为取
 *  **usage 资产全文**：`extraTexts[0]` 即调用方传入的 usage 正文（显式参数绑定，调用方唯一）。
 *  语义要点：① 只认 `extraTexts[0]`，**不**在多个追加面里挑一个 —— 避免「挑到哪个面」成为隐式行为；
 *  ② 追加面缺失/为空 ⇒ 返回 null（`found:false`，与「该面不存在」同口径，**不**回落 help 切片——
 *  回落等于把死链重新放回来）；③ 资产**不可读**由调用方 `localizedPrompt` **抛错**表达，
 *  本函数不 catch（fail-open 消除见 `graph_help` 的 run 与 D6）。
 *  ④ 与 `graph_engineering` 的「help 优先、usage 兜底」**语义独立**：本分支根本不看 help 面，
 *  故 help 首句戳不影响 usage 结果。 */

/** g-495 返工项 B/C：点题章节标题判定 —— **唯一真源**，被 `helpTopicText` 的跨资产查找与
 *  测试钩子 `_isGraphEngineeringSectionTitle` 共用（不另立第二套口径）。标题须同时含
 *  `dsh-graph` 与「图工程 / Graph Engineering」。 */
function isGraphEngineeringSectionTitle(title) {
  return /dsh-graph/.test(String(title)) && /图工程|Graph Engineering/i.test(String(title));
}

function helpTopicText(text, topic, extraTexts = []) {
  const src = typeof text === "string" ? text : "";
  const key = String(topic || "").trim().toLowerCase();
  if (!key) return null;
  const usageAlias = ["usage", "使用说明", "getting started", "使用指引"];
  const graphAlias = ["graph_engineering", "graph-engineering", "图工程", "graph engineering"];
  if (usageAlias.includes(key)) {
    // g-495 att-005：usage 主题 = **usage 资产全文**（含 `## 工具细则`），不再取 help 首句。
    // 追加面 `extraTexts[0]` 是 usage 正文的唯一来源（调用方显式绑定）；缺失/空 ⇒ null。
    const usageFace = Array.isArray(extraTexts) ? extraTexts[0] : "";
    if (typeof usageFace !== "string" || !usageFace) return null;
    // 返回**全文**（含各二级标题），只去尾部空白的差异 —— 不得只截到首个 `## ` 之前。
    return usageFace.trimEnd();
  }
  if (graphAlias.includes(key)) {
    // 跨资产：help 正文优先，其次各追加面（usage）。命中即返回，未命中一律 null。
    // g-495 返工项 C：**help 优先、usage 兜底**是本分支的既定优先级语义（两面都有同形章节时
    // 返回 help 版本）。该语义由守卫钉住，不留「未定义行为 + 无断言」。
    const faces = [src, ...(Array.isArray(extraTexts) ? extraTexts : [])];
    for (const face of faces) {
      if (typeof face !== "string" || !face) continue;
      for (const section of face.split(/\n(?=## )/)) {
        if (!section.startsWith("## ")) continue;
        if (isGraphEngineeringSectionTitle(section.split("\n")[0])) {
          return section.trimEnd();
        }
      }
    }
    return null;
  }
  if (!src) return null;
  // g-495：功能模块主题 —— 命中资产里该模块的表格行（含所属章节标题）。
  // 模块名之后**没有别的分支**：`usage` / `graph_engineering` / 模块名之外的一切名
  //（含**工具名**）一律 `null` ⇒ 调用方回落全文 + `found=false`（负责人 2026-10-13 裁定：
  //  schema 注入时已提供足够信息，没必要按工具名查）。负向钉住见 g493 D1/D2。
  const moduleId = helpTopicModuleId(key);
  if (moduleId) return helpModuleTopicText(src, moduleId);
  return null;
}

/** g-495：功能模块名 topic 的别名表（真源 = `HARNESS_MODULE_IDS`，此处只加人类可读别名）。
 *  键为 `HARNESS_MODULE_IDS` 的成员，值为额外可命中的别名（小写比较）。
 *  结构性约束由守卫 `core/tests/g493-help-topic.test.ts` 钉住：键集合必须**恰等于**
 *  `HARNESS_MODULE_IDS`（引擎加模块而此处漏登记 ⇒ 必红）。 */
const MODULE_TOPIC_ALIASES = {
  tags: ["标签", "tag", "goal_tags", "目标标签"],
  memory: ["记忆", "mem", "记忆管理"],
  shared_cards: ["共享卡", "共享卡片", "shared_cards", "shared-cards", "共享池"],
  automation_prompts: ["自动化提示词", "自动化", "automation", "automation_prompts", "automation-prompts"],
  attachments: ["附件", "attachment", "att"],
};

/** g-495：把 topic 归一成 `HARNESS_MODULE_IDS` 成员；非模块名返回 null。 */
function helpTopicModuleId(key) {
  for (const id of HARNESS_MODULE_IDS) {
    if (key === id) return id;
    const aliases = MODULE_TOPIC_ALIASES[id] ?? [];
    if (aliases.some((a) => String(a).toLowerCase() === key)) return id;
  }
  return null;
}

/** g-495：取资产里某模块的**单行**（连同所属二级章节标题与表头），供 `topic=<模块名>` 返回。
 *  解析口径与资产结构同源：模块表在 `## ` 章节内，每行形如 `| <显示名> | … |`。
 *  行的**定位**不依赖显示名（显示名是给人看的措辞，可能改），而依赖行内出现的
 *  `{moduleId}` 状态占位符 —— 那是渲染期才替换的稳定标记。
 *  只返回该模块自己的行（+ 章节标题 + 表头两行），**不**连带整张表 —— 否则 `topic=<模块>`
 *  与整份 help 的信息量几无差别，渐进式披露退化。 */
function helpModuleTopicText(src, moduleId) {
  const lines = String(src || "").split("\n");
  const rowIdx = lines.findIndex((l) => l.startsWith("|") && l.includes(`{${moduleId}}`));
  if (rowIdx < 0) return null;
  let headIdx = -1;
  for (let i = rowIdx; i >= 0; i--) {
    if (lines[i].startsWith("## ")) { headIdx = i; break; }
  }
  // 表头两行（`| 模块 | 作用 | 状态 |` + 分隔行）紧随章节标题。
  const tableHead = lines.slice(headIdx + 1, headIdx + 3).filter((l) => l.startsWith("|"));
  const title = headIdx < 0 ? [] : [lines[headIdx]];
  return [...title, ...tableHead, lines[rowIdx]].join("\n").trimEnd();
}

/** g-495：把 help 资产里的 `{moduleId}` 占位符渲染成当前生效开关。
 *
 *  - 资产里每个受管模块一行，行内以 `{<moduleId>}` 标记该行的状态列 ⇒ **资产与模块表同源**，
 *    引擎加模块而资产漏行时 `renderHelpModules` 会留下未替换的占位符（守卫据此判红）。
 *  - `switches` 为 null / 缺该模块 ⇒ 按**开启**（fail-safe，与 `resolveModuleSwitches` 同口径）。
 *  - 渲染结果只是文本；**不**改配置、**不**改注册面，也不删除任何数据。
 *  - 状态词按语言取（`language`）：zh 用「开启 / 关闭」，en 用「enabled / disabled」——
 *    与资产语言一致，避免英文资产里混入 CJK（prompt-i18n-parity 守卫会判红）。 */
function renderHelpModules(text, switches, language = "zh") {
  if (typeof text !== "string" || !text) return text;
  const zh = normalizePromptLanguage(language) === "zh";
  const onWord = zh ? "开启" : "enabled";
  const offWord = zh ? "关闭" : "disabled";
  let out = text;
  for (const id of HARNESS_MODULE_IDS) {
    const decision = switches?.switches?.[id];
    const on = decision ? decision.on !== false : true;
    out = out.split(`{${id}}`).join(on ? onWord : offWord);
  }
  return out;
}

const GUIDE = requirePromptAsset("supervisor-guide", "zh");

// g-113：普通 agent 的 dsh-graph 使用指引（按 locale 整体加载 prompts/*.md）

// g-118：简短引导提示词按 locale 整体加载 prompts/guide-hint.*.md

// g-131：主管纪律提醒按 locale 整体加载 prompts/discipline.*.md

// ==== g-439 automation guidance: extractable block begin ====
// g-439：`supervisor.automation` 六键 → 主管动作指导的唯一映射表（消费点 = 下方
// 「dsh-graph-supervisor-discipline」section）。只把当前 workspace 的 human/ai 选择渲染成
// **动作指导文本**：不新增工具/API 授权凭据、不新增审批凭据、不做轮次控制，也不新增任何引擎硬门禁。
// 六键与四类人工 gate **不是一一映射**：`scope_planning` / `integration_decision` 只管
// 范围排期与候选合入取舍，**不**等于首次 start 授权或 review verdict / delivered 授权；
// 「开始工作」与「审核」两类 gate **没有对应键**，其既有要求（含 review→delivered 必须等
// 负责人 verdict）原样保留。六键全 null/非法 ⇒ 渲染空串 ⇒ 该 section 输出与既有逐字一致。
// g-490 补充（**弱**关系，不改变上面任何不变式、更不写成「键 = gate」）：六键中只有两键的**动作**
// 落在既有某类人工 gate 的**范围**内——`scope_planning` 的动作落在「调整版本计划」范围内、
// `release` 的动作落在「发布」范围内；设置弹窗在这两键**未配置**时可显示「默认：human」，
// 但必须**同屏标注该口径来源**（见下方 `AUTOMATION_UNSET_SCOPE`），**不得**自称引擎解析默认值。
// 其余四键**不对应任何** gate（与「开始工作」「审核」两类 gate **没有对应键**同理）⇒ 未配置一律
// 显示「未配置：保持既有指导」。引擎侧六键仍是 `nullable` **且无 `default`**，未配置时
// `readProjectConfig` 返回 null、本块的渲染函数**不输出该键指导行** —— 与上面逐字一致。
// g-496：正文（header/confirm/autonomous/action/boundary/trailer）真源 = `prompts/automation-guidance.<lang>.md`，
// 代码只留**结构与门控**（键清单、行模板、human/ai 判断、空串语义、语言回落）。故本块**引用外部符号**
// `requirePromptAsset`（读取）与 `parseAutomationGuidanceAsset`（解析）—— 守卫据此断言「正文不在代码里」，
// 并对**真实资产读取 + 渲染输出 + 模块开关**做行为断言（不再用 `new Function` 抽块求值）。
const AUTOMATION_GUIDANCE_KEYS = ["scope_planning", "integration_decision", "rework", "memory_promotion", "skill_proposal", "release"];

/** g-496：把 `prompts/automation-guidance.<lang>.md` 的 `@@<字段>` 分块解析成正文表。
 *
 *  资产是**唯一真源**（正文不再在代码里留第二副本）；本函数只做**解析**，不含任何门控判断。
 *  fail-closed：资产缺失由 `requirePromptAsset` 抛错；**任一必需字段缺失/重复**同样抛错
 *  （绝不静默降级为空串 —— 否则「资产漏字段」会被伪装成「该键无指导」）。
 *  解析规则：行首 `@@<field>` 起一块，直到下一个 `@@` 行；HTML 注释与空行天然落在块外/块内被裁剪。 */
function parseAutomationGuidanceAsset(text, lang) {
  const fields = new Map();
  let current = null;
  for (const raw of String(text).split("\n")) {
    // 定界注释行（begin/end 标记）不是正文，遇到即结束当前块（避免尾部标记被并入最后一段）。
    if (/^\s*<!--/.test(raw) || /^\s*-->/.test(raw)) { current = null; continue; }
    const m = /^@@([A-Za-z0-9_.]+)\s*$/.exec(raw);
    if (m) {
      if (fields.has(m[1])) throw new Error(`dsh-graph automation guidance asset has duplicate field: ${m[1]} (${lang})`);
      current = m[1];
      fields.set(current, []);
      continue;
    }
    if (current) fields.get(current).push(raw);
  }
  const get = (field) => {
    const lines = fields.get(field);
    if (!lines) throw new Error(`dsh-graph automation guidance asset is missing field: ${field} (${lang})`);
    return lines.join("\n").trim();
  };
  const table = {
    header: get("header"),
    confirm: get("confirm"),
    autonomous: get("autonomous"),
    line: (key, value, action, clause, boundary) =>
      lang === "en"
        ? `- \`${key}\` = ${value}: ${action} — ${clause} (${boundary}).`
        : `- \`${key}\` = ${value}：${action}，${clause}（${boundary}）。`,
    actions: {},
    trailer: get("trailer"),
  };
  for (const key of AUTOMATION_GUIDANCE_KEYS) {
    table.actions[key] = { action: get(`action.${key}`), boundary: get(`boundary.${key}`) };
  }
  return table;
}

const AUTOMATION_GUIDANCE = {
  zh: parseAutomationGuidanceAsset(requirePromptAsset("automation-guidance", "zh"), "zh"),
  en: parseAutomationGuidanceAsset(requirePromptAsset("automation-guidance", "en"), "en"),
};
/** g-490：六键**未配置**时的**显示口径来源引用表** —— 这是「口径来源」，**不是**引擎解析默认值。
 *  引擎事实：六键在 `core/schema.ts` 里是 `nullable` 且**无 `default`**；未配置时 `readProjectConfig`
 *  仍返回 null、`renderAutomationGuidance` **不输出该键指导行**；权威口径是 `supervisor-guide.zh.md`
 *  「配置化的动作指导」段的「**未配置保持既有指导**」，本表**不**改变它。
 *  本表只登记「**某键的动作落在既有某类人工 gate 的范围之内**」这一**弱**关系（来源 =
 *  `supervisor-guide.zh.md`「人工 gate 停轮」的四类人工 gate，逐键可对照）：
 *    · `scope_planning` 的动作落在「调整版本计划」范围内、`release` 的动作落在「发布」范围内
 *      ⇒ GUI 在这两键**未配置**时可显示「默认：<该 gate 的既有要求>」，但必须**同屏标注该来源**，
 *      **不得**自称引擎解析默认值。`gate_requires` 记的是「该人工 gate 本身的要求」，不是本键的默认值。
 *  与上文「六键与四类人工 gate **不是一一映射**」**并存、不矛盾**：本表**不**写成「键 = gate」
 *  （字段名为 `gate_scope` = 动作所处范围，而非键的等价 gate）；「开始工作」「审核」两类 gate 仍然
 *  **没有对应键**；其余四键（`integration_decision` / `rework` / `memory_promotion` /
 *  `skill_proposal`）**没有**对应的 gate 范围 ⇒ **本表不含它们的任何 human/ai 值**，其未配置显示
 *  一律为「未配置：保持既有指导」（不编默认值、也不改四类 gate）。
 *  语义边界：本表**不**改变 `renderAutomationGuidance` 的输出（六键全未配置仍渲染空串、既有纪律文本
 *  逐字不变），不新增任何引擎硬门禁/审批凭据，也不改四类 gate 本身。 */
const AUTOMATION_UNSET_SCOPE = {
  scope_planning: { gate_scope: "version_plan", gate_requires: "human" },
  release: { gate_scope: "release", gate_requires: "human" },
};
/** 渲染六键动作指导：只有 human/ai 生效（其余按未配置处理）；无生效键 ⇒ 空串（保持既有文本逐字不变）。 */
function renderAutomationGuidance(automation, language) {
  const table = AUTOMATION_GUIDANCE[language === "en" ? "en" : "zh"];
  const lines = [];
  for (const key of AUTOMATION_GUIDANCE_KEYS) {
    const value = automation?.[key];
    if (value !== "human" && value !== "ai") continue;
    const spec = table.actions[key];
    lines.push(table.line(key, value, spec.action, value === "human" ? table.confirm : table.autonomous, spec.boundary));
  }
  if (!lines.length) return "";
  return `\n\n${table.header}\n${lines.join("\n")}\n\n${table.trailer}`;
}
// ==== g-439 automation guidance: extractable block end ====

// ==== g-480：模块在**提示词面**的裁剪位置（描述性元数据，随 schema_hints 下发给调用方）====
// 工具面的唯一真源是 core 的 `MODULE_TOOL_NAMES`（本表**不**重复任何工具名，避免第二份副本漂移）。
// 取值**闭集**（g480 用例把本表与真实注册 / 真实裁剪行为对账，写错即红）：
//   · `none` = 没有可达的提示词面（只有工具面）；
//   · `section:<name>` = 该模块关闭时，这个我们注册的 systemPrompt section **整体**不再注入；
//   · `section-part:<name>#<part>` = 只裁掉该 section 的**一段**（正文保留）；
//   · `tool-name-mentions:none` = 该模块关闭时其受管工具名会被从**所有**我们注册的 section 文本里
//     按行剔除（`stripModuleToolMentions`），且当前三个 section 的**静态**资产里没有它们的可达提及；
//   · `tool-name-mentions:dynamic-memory` = 同上机制，但可达提及只在**动态**正文里（常驻记忆逐条文本），
//     静态资产里没有；
//   · `role-prompt:<role>` = 可达提及只在该**子代理角色**的档案与派发提示词里（persona 文本 /
//     `requiredTools` / `allowedTools`）。模块关闭 ⇒ **角色档案自适应**（g-480 裁决，唯一真源
//     `core.moduleAwareRoleProfile`）：persona 文本按行剔除受管工具名、`requiredTools`/`allowedTools`
//     同步去掉该名，宿主再把 collector 的**派发提示词**按同一 `stripModuleToolMentions` 投影
//     ⇒ 该角色**照常可派发**，且档案面/提示词面不再引用该工具（不再用「拒绝派发」当裁剪手段）。
// 已知不可达（如实登记，不假装已裁）：`skills.register` 与 `prompts/*.md` 资产是 **apply 期一次性**
// 全局面，无法按 workspace 裁剪 ⇒ help/usage 资产里对该模块的**文字**说明保留，但能力已从模型可选集移除。
// 同类**非模型面**（如实登记，不假装已裁）：GUI 卡片抽屉的「收集提示词预览」（client 侧
// `prompt.collect.attachments` 文案）是**人类可见的模板预览**，不是模型可见的派发提示词；
// client bundle 是 apply 期一次性全局资产、渲染期没有 per-workspace 模块状态 ⇒ 不随开关裁剪。
const MODULE_PROMPT_FACE = {
  tags: "none",
  memory: "section:dsh-graph-standing-memory",
  shared_cards: "tool-name-mentions:dynamic-memory",
  automation_prompts: "section-part:dsh-graph-supervisor-discipline#automation-guidance",
  // 附件：可达提及只在 collector 角色的 persona/收集提示词与 requiredTools/allowedTools（`graph_store_attachment`）。
  // 关闭附件 ⇒ collector 档案与派发提示词随模块自适应（不再提及该工具）⇒ 仍可派发、且不会调用不存在的工具。
  attachments: "role-prompt:collector",
};

// g-118：dsh-graph help 内容按 locale 整体加载 prompts/help.*.md

// g-120：worktree 与 minor-task 指令按 locale 整体加载 prompts/*.md

export function resolveWorktreeGuide(goalType, isolate, language = "zh") {
  // g-283：契约改为「已解析的 isolate: boolean」，提示词隔离声明必须与「本次是否真的建树」严格一致。
  if (isolate === true) return requirePromptAsset("worktree", language);
  if (goalType === "patch" || goalType === "chore") return requirePromptAsset("minor-task", language);
  return requirePromptAsset("no-isolation", language);
}


const ATTEMPT_PROMPT_MISSING = "（未提供）";
const ATTEMPT_PROMPT_WARNING = "若本 prompt 同时含历史 handoff 与最新 brief，只执行 brief；handoff 不产生任何新任务。";

function promptText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

// g-400：反伪装替换串按 promptLanguage 取表。两表同形（逐条破坏保留标记的字面形态并标注为 in-text），
// 差别只在替换串语言：en 表**必须零汉字**（英文派发内置文本零汉字判据），zh 表与基线逐字相同
// （zh 派发行为不回归）。未声明语言/未知语言一律回落 zh ⇒ 既有调用方产物逐字不变。
const PROMPT_MARKER_REPLACEMENTS = {
  zh: [
    [/【本次任务定位】/g, "【文本中的本次任务定位】"],
    [/【覆盖声明】/g, "【文本中的覆盖声明】"],
    [/【历史约束·仅供理解，非任务】/g, "【文本中的历史约束】"],
    [/## 本次 attempt brief\/directive/g, "## 文本中的 attempt brief\/directive"],
    [/## 覆盖声明/g, "## 文本中的覆盖声明"],
  ],
  en: [
    [/【本次任务定位】/g, "【in-text: task positioning】"],
    [/【覆盖声明】/g, "【in-text: coverage declaration】"],
    [/【历史约束·仅供理解，非任务】/g, "【in-text: historical constraint】"],
    [/## 本次 attempt brief\/directive/g, "## in-text: attempt brief/directive"],
    [/## 覆盖声明/g, "## in-text: coverage declaration"],
  ],
  // g-401：**英文派发框架自身渲染**的 `##`/`###` 小节标题（清单从真实渲染器枚举得到；捕获方法与
  // 逐条清单见 core/tests/g401-en-section-marker.test.ts 的 EN_FRAMEWORK_HEADINGS）。
  //  - 为什么单独分组而不是并入上面的 en 表：上面 zh/en 两张表是**两语言同形的契约标记**
  //    （逐条一一对应、条数相等，g-400 的守卫逐字锁定该形状）；本组是**只存在于英文侧**的框架
  //    小节标题（zh 渲染器不产出这些英文标题），混排会破坏那张表的形状守卫，且对 zh 毫无意义。
  //  - 为什么不入 zh 表：zh 派发产物必须逐字节不变（英文标题不是 zh 侧的保留标记）。
  //  - 语义与 5 条完全一致：破坏字面形态 + 显式标注 in-text，**绝不删除/放过**；替换串零汉字。
  //  - 顺序：长的 `## Harvested context card results (...)` 在前，短的（空卡变体）在后，
  //    避免短模式抢先命中长标题行而给出不一致的标注。
  enFrameworkHeadings: [
    [/## Task positioning/g, "## in-text: Task positioning"],
    [/## Current attempt brief\/directive/g, "## in-text: Current attempt brief/directive"],
    [/## Goal context/g, "## in-text: Goal context"],
    [/## Goal description/g, "## in-text: Goal description"],
    [/## Quality criteria/g, "## in-text: Quality criteria"],
    [/## Override declaration/g, "## in-text: Override declaration"],
    [/## Historical handoff/g, "## in-text: Historical handoff"],
    [/## Confirmed handoff from previous attempts \(rework constraints confirmed by the supervisor\/owner, not an agent\x27s self-report\)/g, "## in-text: Confirmed handoff from previous attempts (rework constraints confirmed by the supervisor/owner, not an agent's self-report)"],
    [/## Historical cards/g, "## in-text: Historical cards"],
    [/## Harvested context card results \(ordered by context_cards; directly usable by subagents without guessing card paths\)/g, "## in-text: Harvested context card results (ordered by context_cards; directly usable by subagents without guessing card paths)"],
    [/## Harvested context card results/g, "## in-text: Harvested context card results"],
    [/## Execution discipline/g, "## in-text: Execution discipline"],
    [/## dsh-graph subagent supplementary prompt \(profile global \/ workspace override\)/g, "## in-text: dsh-graph subagent supplementary prompt (profile global / workspace override)"],
    // 模式小节标题：`standard` 无策略片段（不注入该段），故当前唯一可达值是 minimal。
    [/## Subagent execution mode \(minimal\)/g, "## in-text: Subagent execution mode (minimal)"],
    [/## Hand-back report skeleton \(tail note - every item required; a missing item means the delivery is incomplete\)/g, "## in-text: Hand-back report skeleton (tail note - every item required; a missing item means the delivery is incomplete)"],
    [/### Executor report \(6 required items\)/g, "### in-text: Executor report (6 required items)"],
    [/### Report length budget \(soft cap; exceeding it is not a failed delivery, but you must self-report\)/g, "### in-text: Report length budget (soft cap; exceeding it is not a failed delivery, but you must self-report)"],
  ],
};

/** 英文侧生效的完整反伪装表：两语言契约标记（en）+ 英文框架小节标题（g-401）。 */
const EN_PROMPT_MARKER_TABLE = PROMPT_MARKER_REPLACEMENTS.en.concat(PROMPT_MARKER_REPLACEMENTS.enFrameworkHeadings);

/** 防止注入文本中的保留标记伪装成当前 prompt 系统区块。
 *  反伪装语义与语言无关（伪造标记一律被破坏并标注为 in-text）；只有替换串按语言取值，
 *  使英文派发的替换结果零汉字。language 只认字面量 "en"，其余（含缺省/未知）回落 zh。
 *  g-401：英文侧的表 = 5 条两语言契约标记 + 英文框架小节标题（zh 表不动）。 */
function protectPromptMarkers(value, language = "zh") {
  const table = normalizePromptLanguage(language) === "en" ? EN_PROMPT_MARKER_TABLE : PROMPT_MARKER_REPLACEMENTS.zh;
  let text = String(value ?? "");
  for (const [pattern, replacement] of table) text = text.replace(pattern, replacement);
  return text;
}

/** g-401：保护「自带框架小节标题」的注入段——框架标题行逐字保留，只对正文做反伪装。
 *
 *  背景：卡片段（core/ops 的 `## Harvested context card results …`）、handoff 段
 *  （`## Confirmed handoff from previous attempts …`）、派发点拼装的子代理补充提示词段与模式段，
 *  都是 `<框架标题行>\n<用户材料…>` 的拼装体；目标背景段则是
 *  `<标题行><描述正文><标题行><判据正文>`。若整串过 protectPromptMarkers，g-401 新增的英文标题
 *  模式会把**框架自己的标题**也改写掉，违反「框架真实标题渲染逐字不变」。
 *
 *  两种保留口径，各自精确：
 *  - 缺省（卡片/handoff/子代理/模式段）：框架标题**恒为首行** ⇒ 只保留首行；正文里用户伪造的
 *    同名标题行照样被破坏（不放过）。无首行标题时整串保护。
 *  - 显式 keep（目标背景段）：标题行位于已知行 ⇒ 按**整行精确匹配**保留。该段正文在派发点已反
 *    伪装（本函数幂等），故真实链路里这些行只可能是框架自己渲染的；直接调用 formatAttemptPrompt
 *    的调用方其正文同样在此被逐行保护（不因本函数而失去保护）。 */
function protectSectionBody(section, language, keep = null) {
  const text = String(section ?? "");
  if (keep) {
    const set = new Set(keep);
    return text.split("\n").map((line) => (set.has(line) ? line : protectPromptMarkers(line, language))).join("\n");
  }
  const m = text.match(/^(#{2,3} [^\n]*)(\n?)/);
  if (!m) return protectPromptMarkers(text, language);
  return m[1] + m[2] + protectPromptMarkers(text.slice(m[0].length), language);
}

/** 英文侧目标背景段自身的两个框架小节标题（用于 protectSectionBody 的显式保留清单）。 */
const EN_TARGET_CONTEXT_HEADINGS = ["## Goal description", "## Quality criteria"];

function renderPromptValue(value, missingReason) {
  const text = promptText(value);
  if (!text) return [ATTEMPT_PROMPT_MISSING, "> 未提供原因：" + missingReason].join("\n");
  return text.split("\n").map((line) => "> " + protectPromptMarkers(line)).join("\n");
}

/** 归一化文本用于去重比较：trim 首尾空白，合并连续换行与空白行为单个换行。 */
function normalizeForDedup(text) {
  return text.replace(/\r\n?/g, "\n").replace(/(?:[ \t]*\n)+[ \t]*/g, "\n").trim();
}

/** brief/directive 去重：归一化后相等时，brief 保留全文，directive 标记为冗余。
 *  返回 [briefRendered, "", directiveRendered]（含标签行），可直接展开到 current 数组。
 *  renderFn(value, missingReason) 用于渲染单个值，缺省用 renderPromptValue。
 *  briefNote（g-251）：来源标注，插在 brief 正文之后、directive 标签之前——保证既有
 *  「标签行紧邻正文」的断言形态不变（如 `**attempt brief（当前数据）**\n（未提供）`）。 */
function dedupBriefDirective(briefText, directiveText, missingReasonBrief, missingReasonDirective, { isEn = false, briefLabel, directiveLabel, renderFn, briefNote } = {}) {
  const render = renderFn || renderPromptValue;
  const bLabel = briefLabel || (isEn ? "**Attempt brief (current data)**" : "**attempt brief（当前数据）**");
  const dLabel = directiveLabel || (isEn ? "**Directive (current data)**" : "**directive（当前数据）**");
  const b = promptText(briefText);
  const d = promptText(directiveText);
  const note = promptText(briefNote) ? [promptText(briefNote)] : [];

  // 两者均非空：归一化比较
  if (b && d) {
    const nb = normalizeForDedup(b);
    const nd = normalizeForDedup(d);
    if (nb === nd) {
      // 完全相同：brief 保留全文，directive 标记冗余
      return [
        bLabel,
        render(b, missingReasonBrief),
        ...note,
        "",
        dLabel,
        isEn
          ? "> (content identical to brief above after normalization; brief takes priority)"
          : "> （归一化后与上方 brief 完全相同；以 brief 为准）",
      ];
    }
  }

  // 不同或仅一方空：各自渲染
  return [
    bLabel,
    render(b, missingReasonBrief),
    ...note,
    "",
    dLabel,
    render(d, missingReasonDirective),
  ];
}

function compactPromptFact(value) {
  const text = promptText(value);
  return text ? protectPromptMarkers(text.replace(/\s*\n\s*/g, "；")) : ATTEMPT_PROMPT_MISSING;
}

function hasTaskType(value) {
  return typeof value === "string" && ATTEMPT_TASK_TYPE_VALUES.includes(value);
}

function taskTypeDisplay(value) {
  if (hasTaskType(value)) return ATTEMPT_TASK_TYPE_LABELS[value];
  if (value === null) return "未提供（task_type=null，明确表示未分类）";
  if (value === undefined) return "未提供（未传 task_type；允许值：merge=合入、rewrite=重写、fix=修复）";
  return "未提供（task_type 非法；允许值：merge=合入、rewrite=重写、fix=修复；不要传中文或自然语言）";
}

function taskTypeFact(value) {
  if (hasTaskType(value)) return value + "（" + ATTEMPT_TASK_TYPE_LABELS[value] + "）";
  return taskTypeDisplay(value);
}

function structuredStringMissingReason(value, field, nullMeaning) {
  if (value === undefined) return "未传 " + field + "（" + nullMeaning + "）";
  if (value === null) return field + "=null（" + nullMeaning + "）";
  return field + " 不是非空字符串；空值请传 null 或省略。";
}

function currentFactLine(label, value, field, nullMeaning) {
  const text = promptText(value);
  return [
    label + (text ? compactPromptFact(text) : ATTEMPT_PROMPT_MISSING),
    text ? "" : "  未提供原因：" + structuredStringMissingReason(value, field, nullMeaning),
  ].filter(Boolean).join("\n");
}

function formatAcceptanceItems(value) {
  if (value === undefined) return ATTEMPT_PROMPT_MISSING + "\n  未提供原因：未传 acceptance_items（supervisor 尚未提供当前验收项）。";
  if (value === null) return ATTEMPT_PROMPT_MISSING + "\n  未提供原因：acceptance_items=null（supervisor 明确表示当前没有可用验收项）。";
  if (!Array.isArray(value)) return ATTEMPT_PROMPT_MISSING + "\n  未提供原因：acceptance_items 不是 string[]；空值请传 null 或省略。";
  if (value.length === 0) return "（无）\n  说明：supervisor 明确传 acceptance_items=[]，表示本次无单独验收项。";
  if (value.some((item) => typeof item !== "string" || !item.trim())) {
    return ATTEMPT_PROMPT_MISSING + "\n  未提供原因：acceptance_items 含空值或非字符串；每项必须是非空 string。";
  }
  return value.map((item, index) => {
    const itemLines = protectPromptMarkers(item.trim()).split("\n");
    return "  " + (index + 1) + ". " + itemLines.join("\n     ");
  }).join("\n");
}

function acceptanceFactLine(value) {
  const rendered = formatAcceptanceItems(value);
  const validItems = Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim());
  if (!validItems) return "- 当前验收项（当前 attempt 数据）：" + rendered;
  return [
    "- 当前验收项（当前 attempt 数据）：acceptance_items（supervisor 直接传入）",
    rendered,
  ].join("\n");
}

function validateAttemptPromptFields({ taskType, baselineCommit, sourceAttempt, acceptanceItems } = {}) {
  if (taskType !== undefined && taskType !== null && !hasTaskType(taskType)) {
    return "task_type 必须是 merge、rewrite 或 fix；空值请传 null 或省略";
  }
  for (const [field, value] of [["baseline_commit", baselineCommit], ["source_attempt", sourceAttempt]]) {
    if (value !== undefined && value !== null && (typeof value !== "string" || !value.trim())) {
      return field + " 必须是非空 string；空值请传 null 或省略";
    }
  }
  if (acceptanceItems !== undefined && acceptanceItems !== null) {
    if (!Array.isArray(acceptanceItems)) return "acceptance_items 必须是 string[]；空值请传 null 或省略";
    if (acceptanceItems.some((item) => typeof item !== "string" || !item.trim())) {
      return "acceptance_items 的每项必须是非空 string；没有验收项请传 []，未知请传 null 或省略";
    }
  }
  return null;
}

// g-236：当 attempt_brief 和 directive 均为空时，从目标描述生成默认 action，
// 防止静默启动空任务。brief 优先于 directive（brief 是当前任务，directive 是背景指令）。
//
// g-251：本函数是 `brief_source` 的**唯一生产者**，取值闭集与真源见 core/ops.ts 的
// ATTEMPT_BRIEF_SOURCE_VALUES（brief / directive / auto_from_desc / fallback），
// 并且该值必须与实际用在 prompt 里、落进 attempt meta/事件的文本同源：
//   · auto_from_desc **完整承载目标描述全文**，不再截到 200 字。历史行为把长描述截断后，
//     目标全文只出现在「目标背景（…不产生 action）」区块，描述尾部要求可能沦为非任务
//     （判据 1：不得静默遗漏）。宁可与 targetContext 有一次冗余，也不让尾部要求丢失。
//   · fallback 仍是空描述路径的引擎兜底（g-378 门禁不在此处，见其注释），文案语义一字未变；
//     g-405 起该文案按 `promptLanguage` 取表（见 EMPTY_DESC_FALLBACK_BRIEF），zh 值逐字不变。
//
// g-402：合成 brief 的**前缀是插件内置文本**（不是用户材料），故必须按 `promptLanguage` 取表——
// 英文派发（`promptLanguage=en`）时汉字不得进入英文执行者的 action 切片（g-390/g-400 同族第三处残留）。
// zh 前缀与基线**逐字相同**（zh 派发产物逐字节不变）；英文表述与本文件 ATTEMPT_BRIEF_SOURCE_NOTES_EN
// 同风格。来源闭集/`brief_source` 四处同值契约、描述全文承载（不截断）均不受影响。
const AUTO_FROM_DESC_BRIEF_PREFIX = {
  zh: "执行目标描述中的任务：",
  en: "Execute the task from the goal description: ",
};

// g-405：空描述路径的**引擎兜底文案同样是插件内置文本**（不是用户材料），故与 g-402 的前缀表同风格
// 按 `promptLanguage` 取表——英文派发（`promptLanguage=en`）时汉字不得进入英文执行者的 action 切片
// （g-390/g-400/g-402 同族**第四处**残留；g-402 复核者已穷尽该函数体无其它内置汉字）。
// zh 文案与基线**逐字相同**（zh 派发产物逐字节不变，「执行目标描述和质量判据中的任务」）；兜底语义不变
// （仍指向「目标描述与质量判据」）。门禁语义不受影响：工具入口空描述仍在准入门禁处拒绝（g-378），
// 本分支只为 HTTP 等非门禁入口保留。来源闭集/`brief_source` 四处同值契约不变。
const EMPTY_DESC_FALLBACK_BRIEF = {
  zh: "执行目标描述和质量判据中的任务",
  en: "Execute the task in the goal description and quality criteria.",
};

function resolveEffectiveBrief(attemptBrief, directive, goalDesc, promptLanguage = "zh") {
  const b = promptText(attemptBrief);
  if (b) return { brief: b, source: "brief" };
  const d = promptText(directive);
  if (d) return { brief: d, source: "directive" };
  // 两者均空：从目标描述生成默认 action（完整承载，不截断）
  const desc = promptText(goalDesc);
  if (desc) {
    const prefix = AUTO_FROM_DESC_BRIEF_PREFIX[normalizePromptLanguage(promptLanguage)];
    return { brief: `${prefix}${desc}`, source: "auto_from_desc" };
  }
  // 目标描述也为空：最终兜底。
  // g-378 定位：这是**非门禁途径**（HTTP 入口：GUI 拖拽/执行按钮等既有人工强制启动路径）
  // 启动时的引擎兜底——工具入口 `graph_start_attempt` 已在准入门禁处拒绝空描述派发，
  // 因此本分支只为不设描述门禁的路径保留（门禁语义一字未改，g-236 断言的 zh 值不变）。
  // g-405：兜底文案按 promptLanguage 取表（en 零汉字、zh 逐字等于基线）。
  return {
    brief: EMPTY_DESC_FALLBACK_BRIEF[normalizePromptLanguage(promptLanguage)],
    source: "fallback",
  };
}

/**
 * g-251：派发 action 来源标注（判据 1：spawn prompt 里必须能区分显式 brief / directive / 合成来源）。
 * 静态文案，紧跟在 action 来源正文之后输出。英文表不得含汉字——英文派发路径只对**插件内置文本**
 * 断言零汉字（用户材料不在此限）。注：合成 brief 的中文前缀在 g-251 时属既有残留；
 * g-402 已把 auto_from_desc 前缀按 promptLanguage 取表（见 AUTO_FROM_DESC_BRIEF_PREFIX）；
 * g-405 又把空描述 fallback 文案并入同风格语言表（见 EMPTY_DESC_FALLBACK_BRIEF），
 * 故英文派发路径的 action 切片现无内置汉字（两处残留均已收敛）。
 */
const ATTEMPT_BRIEF_SOURCE_NOTES = {
  brief: "来源：显式 attempt_brief（supervisor 直接提供；原意保留，未截断、未合成）。",
  directive: "来源：directive（本次未传显式 attempt_brief，action 由目标文件「最近指令」小节承接）。",
  auto_from_desc: "来源：auto_from_desc（本次未传显式 attempt_brief 且目标无最近指令，由目标描述自动合成；目标描述**全文**已完整承载于上文，尾部要求与首部同等有效，下方「目标背景」仅供交叉核对）。",
  fallback: "来源：fallback（目标描述为空时的引擎兜底文案；具体任务以目标文件的目标描述与质量判据为准）。",
};
const ATTEMPT_BRIEF_SOURCE_NOTES_EN = {
  brief: "Source: explicit attempt_brief (supplied by the supervisor; carried verbatim, neither truncated nor synthesized).",
  directive: "Source: directive (no explicit attempt_brief this time; the action is taken over from the goal file's current-directive section).",
  auto_from_desc: "Source: auto_from_desc (no explicit attempt_brief and no directive: synthesized from the goal description. The **full** goal description is carried above, so trailing requirements are as authoritative as leading ones; the goal-context block below is only for cross-checking).",
  fallback: "Source: fallback (the goal description is empty, so the engine supplied this fallback action text; the real task is the goal file's description and criteria).",
};

/** 来源标注文本；未知/缺省来源返回 null（不猜、不伪造）。 */
function briefSourceNote(source, isEn = false) {
  const table = isEn ? ATTEMPT_BRIEF_SOURCE_NOTES_EN : ATTEMPT_BRIEF_SOURCE_NOTES;
  return (typeof source === "string" && table[source]) || null;
}

function historicalPromptBlock(title, section) {
  const text = promptText(section);
  if (!text) return "";
  return [
    title,
    "【历史约束·仅供理解，非任务】",
    "本段不改变本次任务，仅解释候选为何如此设计。",
    "",
    protectPromptMarkers(text),
  ].join("\n");
}

function formatAttemptDiscipline({ goal, attempt, worktreeBlock, subagentPromptSection }) {
  // g-496：本段「标题 + 空行 + 前言」的措辞唯一真源 = `prompts/attempt-instructions.zh.md`
  //（disciplineHeading / disciplinePreface 两个短语片段）；代码不再留第二份副本。
  const instructions = attemptInstructionsPhrases("zh");
  const lines = [
    instructions.disciplineHeading,
    "",
    instructions.disciplinePreface,
  ];
  const extra = promptText(subagentPromptSection);
  if (extra) {
    const body = extra.replace(/^## [^\n]*\n?/, "").trim();
    lines.push("", "【dsh-graph 子代理补充提示词·仅作背景，非任务】", body ? protectPromptMarkers(body) : ATTEMPT_PROMPT_MISSING);
  }
  const worktree = promptText(worktreeBlock);
  if (worktree) lines.push("", protectPromptMarkers(worktree));
  const goalValue = promptText(goal) || ATTEMPT_PROMPT_MISSING;
  const attemptValue = promptText(attempt) || ATTEMPT_PROMPT_MISSING;
  // g-496：纪律条目正文（看板协同块 + 分级规则 + 证据形式）唯一真源 = `prompts/executor-discipline.zh.md`，
  // 本次只保留「标题 / 空行 / 前言」三行结构脚手架 —— 载荷注入位点落在资产**首行之前**（zh 口径：
  // 前言之后、看板块之前），与搬迁前逐字节同位；动态 id 由模板 `{goal}`/`{attempt}` 占位符回填。
  // 正文仍逐行过反伪装（保护强度不因搬迁减弱）。
  // ⚠️ 后续再向纪律段新增内容，仍须在 core/tests/prompt-discipline-g239.test.ts 登记增量或做等量删减
  //（该测试按**渲染产物**中的稳定标记剔除，与正文存放位置无关）；四个收缩阈值一律未动。
  lines.push(
    "",
    ...fillExecutorDisciplineTemplate(executorDisciplineTemplate("zh"), { goal: goalValue, attempt: attemptValue })
      .map((line) => protectPromptMarkers(line)),
  );
  return lines.join("\n");
}

/** English counterpart of the execution prompt. User-provided brief/context remains verbatim. */
function formatAttemptPromptEnglish({ goal, attempt, goalRel, attemptBrief, briefSource, directive, taskType, baselineCommit, sourceAttempt, acceptanceItems, handoffSection, cardsSection, targetContext, subagentPromptSection, modeStrategySection, worktreeBlock } = {}) {
  // g-400：本渲染器即英文派发路径 ⇒ 本函数内**每一处** protectPromptMarkers 调用都必须显式传 "en"，
  // 使反伪装替换串走零汉字的英文表（回归守卫：core/tests/g400-marker-guard-i18n.test.ts）。
  const missing = "(not provided)";
  const value = (v, reason) => {
    const text = promptText(v);
    return text ? text.split("\n").map((line) => "> " + protectPromptMarkers(line, "en")).join("\n") : missing + "\n> Reason: " + reason;
  };
  const compact = (v) => promptText(v) ? protectPromptMarkers(promptText(v).replace(/\s*\n\s*/g, "; "), "en") : missing;
  const task = hasTaskType(taskType) ? taskType : taskType === null ? "not provided (task_type=null)" : "not provided (task_type missing or invalid; allowed: merge, rewrite, fix)";
  const items = Array.isArray(acceptanceItems) && acceptanceItems.length
    ? acceptanceItems.map((item, i) => `  ${i + 1}. ${protectPromptMarkers(String(item).trim(), "en")}`).join("\n")
    : acceptanceItems === null ? "(none; supervisor explicitly passed null)" : acceptanceItems === undefined ? missing : "(none)";
  const history = [];
  // g-401：卡片段/handoff 段自带框架小节标题（首行），必须逐字保留 ⇒ 走 protectSectionBody
  //（只保护正文）；被伪造的同名标题在正文里，照常被破坏。
  if (promptText(handoffSection)) history.push(["## Historical handoff", "[Background only; not an action source]", protectSectionBody(handoffSection, "en")].join("\n"));
  history.push(["## Historical cards", "[Background only; not an action source]", promptText(cardsSection) ? protectSectionBody(cardsSection, "en") : missing].join("\n"));
  const contextPath = promptText(goalRel) || missing;
  // g-496：英文定位段的**固定措辞**唯一真源 = `prompts/attempt-instructions.en.md`（与中文资产互为对偶）。
  // 本渲染器仍是**独立措辞**的英文路径（不共用中文资产的字面量），但固定正文不再内联在代码里。
  const instructions = attemptInstructionsPhrases("en");
  const position = [
    fillPhrase(instructions.positioningLine1, { taskTypeLabel: task }),
    fillPhrase(instructions.positioningLine2, { goal: promptText(goal) || missing, attempt: promptText(attempt) || missing }),
    fillPhrase(instructions.goalRelPlain, { goalRel: contextPath }),
  ].join("\n");
  const enRenderFn = (v, reason) => value(v, reason);
  const dedupedItems = dedupBriefDirective(
    attemptBrief, directive,
    "attempt_brief was not supplied",
    "no current directive was supplied",
    { isEn: true, renderFn: enRenderFn, briefNote: briefSourceNote(briefSource, true) },
  );
  const current = [
    instructions.briefHeading,
    "",
    ...dedupedItems,
  ].join("\n");
  // 基线英文渲染器**没有** override 段的前言/来源声明行（那是中文资产的条目）——纯抽取不得凭空补，
  // 故此处逐字保持基线英文形态：标题 → 字段行。
  const override = [
    instructions.overrideHeading,
    fillPhrase(instructions.overrideRule, {}),
    fillPhrase(instructions.overrideTaskType, { taskTypeLabel: task }),
    fillPhrase(instructions.overrideBaseline, { baselineFact: compact(baselineCommit) }),
    fillPhrase(instructions.overrideSourceAttempt, { sourceAttemptFact: compact(sourceAttempt) }),
    fillPhrase(instructions.overrideAcceptance, { acceptanceFact: items }),
  ].join("\n");
  const discipline = [
    instructions.disciplineHeading,
    // g-496: this single preamble line is the EN counterpart of the zh 前言 — the **structure scaffolding**
    // that keeps the injected payloads at the END of this section (below). It is fed from the
    // `disciplinePreface` phrase of `prompts/attempt-instructions.en.md`, so the wording has exactly one source.
    instructions.disciplinePreface,
    // g-496: the discipline template body (board coordination + tier rules + evidence form) has a single
    // source: `prompts/executor-discipline.en.md`, held in lockstep with the Chinese asset by
    // core/tests/prompt-i18n-parity.test.ts (line count / `##` headings / placeholder multiset /
    // technical-token set) — which is exactly why the English asset carries its own board block.
    // Only the heading / blank line / preamble scaffolding stays here, so the injected payloads below
    // keep their byte position at the END of this section. Keep both assets CJK-free: this render path
    // asserts the whole prompt contains no CJK. Still a registered g-239 increment
    // (DISCIPLINE_INCREMENT_MARKERS — subtracted from the **rendered** discipline slice, so relocating
    // the literal does not change the measurement).
    ...fillExecutorDisciplineTemplate(executorDisciplineTemplate("en"), {
      goal: promptText(goal) || missing,
      attempt: promptText(attempt) || missing,
    }).map((line) => protectPromptMarkers(line, "en")),
    promptText(subagentPromptSection) ? protectSectionBody(subagentPromptSection, "en") : "",
    promptText(modeStrategySection) ? protectSectionBody(modeStrategySection, "en") : "",
    promptText(worktreeBlock) ? protectSectionBody(worktreeBlock, "en") : "",
  ].filter(Boolean).join("\n");
  // g-374 F6：交回报文骨架 = 注入文本的**尾注**（单一真源 core/ops.ts；剥离本块后其余字节与基线全同）。
  // g-401：目标背景段的两个框架标题（`## Goal description` / `## Quality criteria`）必须逐字保留 ⇒
  // 走 protectSectionBody 的显式保留清单；该段正文在派发点已反伪装（幂等），此处逐行保护对直接
  // 调用方同样生效（现有 5 条契约标记的保护强度不因 g-401 减弱）。
  return [position, current, targetContext ? "## Goal context\n" + protectSectionBody(targetContext, "en", EN_TARGET_CONTEXT_HEADINGS) : "", override, ...history, discipline, "If a prompt contains a historical handoff and a current brief, execute only the current brief.", formatAttemptReportSkeleton("en")].filter(Boolean).join("\n\n");
}

/** 统一组装 supervisor 执行 attempt prompt，避免两处派发顺序漂移。 */
export function formatAttemptPrompt({
  goal,
  attempt,
  goalRel,
  attemptBrief,
  briefSource,
  directive,
  taskType,
  baselineCommit,
  sourceAttempt,
  acceptanceItems,
  handoffSection,
  cardsSection,
  targetContext,
  subagentPromptSection,
  modeStrategySection,
  worktreeBlock,
  promptLanguage = "zh",
} = {}) {
  if (normalizePromptLanguage(promptLanguage) === "en") {
    return formatAttemptPromptEnglish({ goal, attempt, goalRel, attemptBrief, briefSource, directive, taskType, baselineCommit, sourceAttempt, acceptanceItems, handoffSection, cardsSection, targetContext, subagentPromptSection, modeStrategySection, worktreeBlock });
  }
  const brief = promptText(attemptBrief);
  const currentDirective = promptText(directive);
  const handoff = promptText(handoffSection);
  const cards = promptText(cardsSection) || [
    "## 已收集上下文卡片成果",
    "",
    ATTEMPT_PROMPT_MISSING,
    "未提供原因：当前派发没有可注入的 filled/reviewed 卡片成果。",
  ].join("\n");
  const taskTypeLabel = taskTypeDisplay(taskType);
  const historyNotice = handoff ? "『前序 attempt 已确认 handoff』" : "『历史 handoff』";
  const goalValue = promptText(goal) || ATTEMPT_PROMPT_MISSING;
  const attemptValue = promptText(attempt) || ATTEMPT_PROMPT_MISSING;
  const context = promptText(targetContext);
  // g-496：attempt 定位段的**固定措辞**唯一真源 = `prompts/attempt-instructions.zh.md`；
  // 代码只注入变量（任务类型标签、history 提名、目标/attempt id、goalRel 与两种尾注）。
  const instructions = attemptInstructionsPhrases("zh");
  const positioning = [
    fillPhrase(instructions.positioningLine1, { taskTypeLabel, historyNotice }),
    fillPhrase(instructions.positioningLine2, { goal: goalValue, attempt: attemptValue }),
    fillPhrase(
      context ? instructions.goalRelInlined : instructions.goalRelPlain,
      { goalRel: promptText(goalRel) || ATTEMPT_PROMPT_MISSING },
    ),
  ].join("\n");

  const dedupedItems = dedupBriefDirective(
    attemptBrief, directive,
    "本次请求未传 attempt_brief，或该值不是非空字符串",
    "当前目标没有最近指令，或该值不是非空字符串",
    { briefNote: briefSourceNote(briefSource) },
  );
  const current = [
    instructions.briefHeading,
    "",
    instructions.briefOnlySource,
    instructions.briefPriority,
    "",
    ...dedupedItems,
  ];
  if (context) current.push("", instructions.briefContextLabel, protectPromptMarkers(context));

  const override = [
    instructions.overrideHeading,
    "",
    instructions.overrideRule,
    fillPhrase(instructions.overrideTaskType, { taskTypeLabel: taskTypeFact(taskType) }),
    fillPhrase(instructions.overrideBaseline, { baselineFact: factValue(currentFactLine("", baselineCommit, "baseline_commit", "没有可用基线 commit")) }),
    fillPhrase(instructions.overrideSourceAttempt, { sourceAttemptFact: factValue(currentFactLine("", sourceAttempt, "source_attempt", "没有可用的候选/来源 attempt；当前 attempt 不计为前序来源")) }),
    fillPhrase(instructions.overrideAcceptance, { acceptanceFact: factValue(acceptanceFactLine(acceptanceItems)) }),
    instructions.overrideProvenance,
    fillPhrase(instructions.overrideHandoff, { handoffState: handoff ? "已提供（下方仅作背景）" : "未提供（当前目标没有已确认 handoff，故不注入历史 handoff 区块）" }),
  ].join("\n");

  const history = [];
  const handoffBlock = historicalPromptBlock("## 历史 handoff", handoff);
  if (handoffBlock) history.push(handoffBlock);
  history.push(historicalPromptBlock("## 历史卡片", cards));
  const discipline = formatAttemptDiscipline({ goal, attempt, worktreeBlock, subagentPromptSection });
  const structuredStateInstruction = instructions.structuredState;
  // g-374 F6：交回报文骨架 = 注入文本的**尾注**（单一真源 core/ops.ts；剥离本块后其余字节与基线全同）。
  return [positioning, current.join("\n"), modeStrategySection, override, ...history, structuredStateInstruction, discipline, ATTEMPT_PROMPT_WARNING, formatAttemptReportSkeleton("zh")]
    .filter((section) => section && section.trim())
    .join("\n\n");
}

/** g-496：把 `currentFactLine` / `acceptanceFactLine` 渲染出的「标签 + 值」块拆成**纯值块**
 *  —— 标签措辞已下沉到资产（`{{baselineFact}}` 等占位符所在行自带标签），代码只提供事实值。
 *  行不存在（空串）时返回空串，占位符随之留空，不产生悬空标签。
 *
 *  **保留换行**：这两族渲染器的产物本就可含续行（`未提供原因：…`、逐条验收项），
 *  故只剥离首行标签、**原样保留**其余行与缩进 —— 不得压缩为单行。 */
function factValue(line) {
  const text = String(line ?? "");
  if (!text) return "";
  const nl = text.indexOf("\n");
  const head = nl >= 0 ? text.slice(0, nl) : text;
  const rest = nl >= 0 ? text.slice(nl + 1) : "";
  const idx = head.indexOf("：");
  const value = idx >= 0 ? head.slice(idx + 1) : head;
  return rest ? value + "\n" + rest : value;
}

// g-189：只读发现当前 canonical workspace 下约定的 attempt worktree。
// 结果附加到 goal detail，不写入任何 graph 数据；失败时返回明确降级状态。
export const worktreeCache = new Map();
export const WORKTREE_CACHE_TTL = 20_000;
export const WORKTREE_CACHE_CAP = 64;
export const _clearWorktreeCache = () => { worktreeCache.clear(); };

export const discoverAttemptWorktrees = (workspace, goalId, attempts, graphRoot = null) => {
  let canonicalKey;
  try { canonicalKey = realpathSync(resolve(workspace)); } catch { canonicalKey = resolve(workspace); }
  const cacheKey = `${canonicalKey}::${goalId}`;
  const now = Date.now();
  // Expired entries are removed on every lookup; Map insertion order supplies LRU.
  for (const [key, entry] of worktreeCache) {
    if (now - entry.ts >= WORKTREE_CACHE_TTL) worktreeCache.delete(key);
  }
  const cached = worktreeCache.get(cacheKey);
  if (cached) {
    worktreeCache.delete(cacheKey);
    worktreeCache.set(cacheKey, cached);
    return cached.value;
  }
  const result = { status: "ok", items: {} };
  try {
    const text = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: workspace, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    });
    const entries = text.split(/\n\s*\n/).map((block) => {
      const pathLine = block.split("\n").find((line) => line.startsWith("worktree "));
      if (!pathLine) return null;
      const branchLine = block.split("\n").find((line) => line.startsWith("branch "));
      const headLine = block.split("\n").find((line) => line.startsWith("HEAD "));
      return {
        path: resolve(pathLine.slice(9).trim()),
        branch: branchLine?.slice(7).trim() ?? null,
        head: headLine?.slice(5).trim() ?? null,
        locked: /(^|\n)locked(?: |$)/.test(block),
        prunable: /(^|\n)prunable(?: |$)/.test(block),
      };
    }).filter(Boolean);
    const canonical = realpathSync(resolve(workspace));
    const prefix = `${goalId}-att-`;
    const usedPaths = new Set();
    const seenAttemptIds = new Set();

    let goalEvents = [];
    const eventRoot = graphRoot || resolveCanonicalRoot(workspace);
    if (eventRoot) {
      try {
        goalEvents = readEvents(eventRoot).filter((e) => e.goal === goalId);
      } catch {}
    }

    for (const attempt of attempts ?? []) {
      const id = String(attempt?.id ?? "");
      if (!id || seenAttemptIds.has(id)) continue;
      seenAttemptIds.add(id);
      const match = id.match(/^att-(\d+)$/);
      if (!match) continue;
      const numeric = Number(match[1]);
      if (!Number.isSafeInteger(numeric)) continue;
      const raw = match[1];
      const names = [...new Set([
        `${prefix}${String(numeric).padStart(2, "0")}`,
        `${prefix}${String(numeric).padStart(3, "0")}`,
        `${prefix}${raw}`,
      ])];
      const evidence = attempt.worktree && typeof attempt.worktree === "object" ? attempt.worktree : null;
      if (evidence?.relative_path) {
        const evidenceName = basename(String(evidence.relative_path));
        if (evidenceName) names.push(evidenceName);
      }
      const matchEntry = names.map((name) => ({ name, branch: `refs/heads/${name}` }))
        .map(({ name, branch }) => ({ name, entry: entries.find((x) => basename(x.path) === name && x.branch === branch && !usedPaths.has(x.path)) }))
        .find(({ entry }) => entry);

      if (matchEntry) {
        const expected = matchEntry.name;
        const expectedBranch = `refs/heads/${expected}`;
        const entry = matchEntry.entry;

        // Evidence is optional for historical attempts, but any recorded fields must agree.
        if (evidence?.branch) {
          const evidenceBranch = basename(String(evidence.branch).replace(/^refs\/heads\//, ""));
          if (!names.includes(evidenceBranch)) continue;
        }

        // Cross-check both Git's live record and the attempt evidence. A same-named
        // nested/foreign path is never accepted: the relative form must be exact.
        let actual;
        try {
          actual = realpathSync(entry.path);
        } catch {
          if (entry.prunable) {
            actual = resolve(entry.path);
          } else {
            continue;
          }
        }
        const rel = relative(canonical, actual).replaceAll("\\", "/");
        if (rel !== `.worktrees/${expected}` || rel.startsWith("..") || isAbsolute(rel) || rel.includes("\0")) continue;

        // g-279: 放宽 HEAD 判定（相同或记录基线的后代；merge-base 不可用/非后代时退化为标记 HEAD 已推进）
        let headAdvanced = false;
        const baselineCommit = attempt?.baseline_commit ? String(attempt.baseline_commit).trim() : null;
        const evidenceHead = evidence?.head ? String(evidence.head).trim() : null;
        const baselineHead = baselineCommit || evidenceHead;

        if (entry.head && (evidenceHead || baselineCommit)) {
          const compareHead = evidenceHead || baselineCommit;
          const same = entry.head === compareHead ||
            (entry.head.startsWith(compareHead) && compareHead.length >= 7) ||
            (compareHead.startsWith(entry.head) && entry.head.length >= 7);

          if (!same) {
            try {
              execFileSync("git", ["merge-base", "--is-ancestor", compareHead, entry.head], {
                cwd: workspace, encoding: "utf8", timeout: 3000, stdio: ["ignore", "ignore", "ignore"],
              });
            } catch {
              // merge-base 不可用或返回非 0：退化为路径+分支匹配并标记 HEAD 已推进
            }
            headAdvanced = true;
          }
        }

        const headShort = entry.head ? entry.head.slice(0, 7) : null;
        const baselineShort = baselineHead ? baselineHead.slice(0, 7) : null;
        const cleanBranch = entry.branch ? entry.branch.replace(/^refs\/heads\//, "") : expected;
        const status = entry.locked ? "已锁定" : (entry.prunable ? "已移除" : "正常");

        usedPaths.add(entry.path);
        result.items[id] = {
          path: rel,
          branch: cleanBranch,
          head: headShort,
          baseline_head: baselineShort,
          head_advanced: headAdvanced,
          locked: Boolean(entry.locked),
          prunable: Boolean(entry.prunable),
          status,
        };
        continue;
      }

      // g-279: Git 实时列表不存在该 worktree 时，检查事件流是否有登记/清理历史
      const candidateRegEv = goalEvents.slice().reverse().find(
        (e) => e.event === "worktree.candidate_registered" && (e.details?.attempt === id || String(e.details?.id ?? "").includes(`:${id}:`))
      );
      const cleanedEv = goalEvents.find(
        (e) => e.event === "worktree.cleaned" && (e.details?.attempt === id || String(e.details?.id ?? "").includes(`:${id}:`))
      );
      const removedEv = goalEvents.find(
        (e) => e.event === "worktree.external_removed" && (e.details?.attempt === id || String(e.details?.id ?? "").includes(`:${id}:`))
      );

      if (cleanedEv || removedEv || candidateRegEv) {
        const histDetails = cleanedEv?.details || removedEv?.details || candidateRegEv?.details;
        let histPath = histDetails?.path || evidence?.relative_path || `.worktrees/${prefix}${raw}`;
        let rel;
        try {
          if (isAbsolute(histPath)) {
            rel = relative(canonical, resolve(histPath)).replaceAll("\\", "/");
          } else {
            rel = histPath.replaceAll("\\", "/");
          }
        } catch {
          rel = histPath;
        }

        const histBranch = histDetails?.branch || evidence?.branch || `${prefix}${raw}`;
        const cleanBranch = String(histBranch).replace(/^refs\/heads\//, "");
        const histHead = histDetails?.head ? String(histDetails.head).slice(0, 7) : (evidence?.head ? String(evidence.head).slice(0, 7) : null);
        const baselineCommit = attempt?.baseline_commit ? String(attempt.baseline_commit).trim() : null;
        const evidenceHead = evidence?.head ? String(evidence.head).trim() : null;
        const baselineHead = baselineCommit || evidenceHead;
        const baselineShort = baselineHead ? baselineHead.slice(0, 7) : null;
        const headAdvanced = Boolean(histHead && baselineShort && histHead !== baselineShort);
        const status = cleanedEv ? "已清理" : "已移除";

        result.items[id] = {
          path: rel,
          branch: cleanBranch,
          head: histHead,
          baseline_head: baselineShort,
          head_advanced: headAdvanced,
          locked: false,
          prunable: false,
          status,
          cleaned: Boolean(cleanedEv),
        };
      }
    }
  } catch (error) {
    result.status = "unavailable";
    result.error = "Git worktree 列表不可用";
  }
  worktreeCache.delete(cacheKey);
  worktreeCache.set(cacheKey, { ts: now, value: result });
  while (worktreeCache.size > WORKTREE_CACHE_CAP) worktreeCache.delete(worktreeCache.keys().next().value);
  return result;
};

export function apply(ctx, config) {
  // g-112：统一 root 解析 = resolve(workspaceRoot, config?.root ?? ".dsh-graph")
  // g-149 修复：apply 级别的 root 仅用于日志和 marker 自测——不调用 init()。
  // 无明确 workspace 的 apply 路径（process.cwd() 基准）不得创建骨架，
  // 避免在 package 子目录、子 Agent cwd 等非项目根意外 init。
  // 所有实际数据读写通过 rootFor(ex) / rootForReq(req, body) 走，
  // 它们有明确 session cwd 或 GUI request workspace 才 init。
  const root = resolveRoot(config); // 仅日志/marker 用
  // g-113 会话 workspace 跟随：session.header.cwd 优先（工具调用所在会话），
  // 缺失时兜底 sandboxPolicy.workspaceRoot（部署级 workspace 根）。
  // g-149 修复：不再兜底 process.cwd()——无明确 workspace 时返回 null，
  // 由 rootFor/rootForMeta 抛错，避免在服务进程 cwd 下意外 init .dsh-graph。
  // 绝对 config.root 时跳过 workspace 要求（root 完全由配置决定）。
  const isAbsoluteConfig = !!(config?.root && isAbsolute(config.root));
  const sessionWorkspace = (ex) => ex?.agent?.session?.header?.cwd ?? ctx.get?.("sandboxPolicy")?.workspaceRoot ?? null;
  // g-480：**真裁剪能力探测**（apply 期一次判定；同一结果同时驱动「监听器是否注册」与「设置状态面下发」，
  // 绝不两处各判一次而分歧）。语义：本版本宿主是否**同时**提供 `agent/created` 生命周期事件与
  // `tools.restrict()` ⇒ 模块开关能否把受管工具从模型可见面真正移除。
  //   · true  = 模块开关**真裁剪**生效（工具面 + 提示词面 + 角色档案面）；
  //   · false = 本版本 DSH 不支持真裁剪 ⇒ 模块开关**不生效**，只把配置记录下来（GUI 在「模块」页签
  //     如实显示一行提示）；插件绝不因此抛错、也不改注册面（51 个工具照常注册可见）。
  const moduleTrimSupported = typeof ctx?.on === "function" && typeof ctx?.tools?.restrict === "function";
  // g-480：派发路径（能力自检 / 工具过滤 / collector 提示词）读模块开关的入口 —— 与工具面监听器、
  // 三个 section **读同一份** `<board root>/project.yaml`；读失败一律按「全开」
  // （`resolveModuleSwitches(null)`），绝不因配置读取异常静默砍掉能力或提示词。
  const readModuleSwitchesForRoot = (rootForRead) => {
    try { return resolveModuleSwitches(readProjectConfig(rootForRead)); } catch { return resolveModuleSwitches(null); }
  };
  // g-133 起 profile 级全局默认由宿主 settings 服务承载；g-351 起改为**能力探测分流**
  // （零版本号字面量比较），因为该服务的形态在宿主上换过代：
  //   ① 旧能力：服务暴露 namespace 注册 API `settings.register(ns, schema, { base })`，
  //      值存于 $DSH_HOME/settings.yaml（0.1.6 线）。
  //   ② 新能力：该 API 已从服务上移除，改为「profile 条目 Config → 设置表单」投影
  //      （`describe` / `update` / `replace` / `mutate`，0.1.7 线）。此时 profile 级默认
  //      就是本插件 entry 的 Config（由本模块的 `Config` 命名导出声明），current 值以
  //      `describe()` 的 descriptor 读取。
  // 探测按「旧 → 新」依次尝试：首个可用且成功者胜出；两条能力都不在时才如实降级到
  // stderr —— 且措辞说明是**能力缺失**，不再是误导性的「注册失败」。
  // ctx.inject(["settings"], cb) 等待 settings 服务出现（同 dsh-subagent-model-picker 的已上线模式）；
  // settings 服务缺失（无 provider 组合）时不影响看板/工具/模型路由。
  let graphSettingsScope = null;
  // g-454：旧 `settings.yaml(.imported)` 的 `dsh-graph` 节里可补偿的字段（见模块顶部
  // 「宿主代次迁移缺口」注释）。仅在新能力（表单投影）分支填充。
  let legacyGraphSettings = null; // { values, sources, home, dir }
  /** 在设置表单投影里定位本插件条目行（entry id 优先，容忍用户层 patch 改 id）。 */
  const findGraphSettingsRow = (svc) => {
    try {
      if (typeof svc?.describe !== "function") return null;
      const rows = svc.describe({ redactSecrets: true });
      if (!Array.isArray(rows)) return null;
      return rows.find((r) => r?.ns === GRAPH_SETTINGS_ENTRY_ID || r?.ns === name) ?? null;
    } catch {
      return null;
    }
  };
  /**
   * g-454 的「显式值优先」判定点：descriptor 必须带 profile patch 视图（`user`）才允许补偿 ——
   * 拿不到该视图就无法区分「用户显式设定」与「schema 默认」⇒ 宁可不补（fail-safe，绝不蒙写）。
   */
  const legacyPatchForRow = (row) => {
    if (!legacyGraphSettings || !row || !Object.hasOwn(row, "user")) return null;
    return graphSettingsMissingPatch(row.user, legacyGraphSettings.values);
  };
  /** 新能力：从设置表单投影里读本插件 entry 的 current 值（缺失字段用旧节兜底；显式值优先）。 */
  const readGraphSettingsFromForms = (svc) => {
    try {
      const row = findGraphSettingsRow(svc);
      const value = row?.value ?? null;
      if (!value) return null;
      const patch = legacyPatchForRow(row);
      return patch ? { ...value, ...patch } : value;
    } catch {
      return null;
    }
  };
  /**
   * g-454：读旧 `dsh-graph` 设置节。位置与归属全部**能力探测**（profileContext.home/dir +
   * 标记文件存在性），不比较任何版本号字面量；无 home、文件缺失、解析失败都只是「没有旧值」。
   */
  const readLegacyGraphSettings = () => {
    const profile = (() => {
      try { return typeof ctx.get === "function" ? ctx.get("profileContext") : null; } catch { return null; }
    })();
    const home = typeof profile?.home === "string" && profile.home ? profile.home : null;
    if (!home) return null;
    const dir = typeof profile?.dir === "string" && profile.dir ? profile.dir : home;
    // 一次性：已成功迁移过（标记已落盘）就不再重读旧文档 ⇒ 用户日后在设置页显式「重置」也不会被复活。
    try { if (existsSync(join(dir, GRAPH_LEGACY_SETTINGS_MARKER))) return null; } catch { /* 探测失败按「未迁移」处理 */ }
    const values = {};
    const sources = [];
    for (const fileName of GRAPH_LEGACY_SETTINGS_FILES) {
      const file = join(home, fileName);
      try {
        if (!existsSync(file)) continue;
        const got = coerceLegacyGraphSettings(parseYaml(readFileSync(file, "utf8"))?.[GRAPH_LEGACY_SETTINGS_SECTION]);
        if (!got) continue;
        sources.push(file);
        for (const [key, value] of Object.entries(got)) if (!Object.hasOwn(values, key)) values[key] = value;
      } catch { /* 单文件不可读/不可解析：跳过，绝不阻断 */ }
    }
    return Object.keys(values).length ? { values, sources, home, dir } : null;
  };
  /**
   * g-454：把旧节的**缺失**字段写回本条目（与设置页同一入口：settings.update → profile patch）。
   * 幂等：写成功后这些键即成为 descriptor.user 的显式值 ⇒ 下次启动无缺失字段（且已落一次性标记）。
   * 安全：无 update 能力 / 无 user 视图 / 无缺失字段时不写；任何异常只降级告警，绝不阻断看板与工具。
   */
  const persistLegacyGraphSettings = async (svc) => {
    const legacy = legacyGraphSettings;
    if (!legacy) return;
    if (typeof svc?.update !== "function") return; // 能力探测：无写入 API ⇒ 只用内存兜底
    const row = findGraphSettingsRow(svc);
    if (!row || typeof row.ns !== "string" || row.ns === "") return;
    const patch = legacyPatchForRow(row);
    if (!patch) return; // 幂等：无缺失字段 ⇒ 零写入
    const fields = Object.keys(patch);
    try {
      // 带 revision：与用户在设置页的并发编辑冲突时，宿主抛 SettingsConflictError ⇒ 放弃本次写。
      await svc.update(row.ns, patch, row.revision);
    } catch (e) {
      process.stderr.write(`[dsh-graph-host] 设置迁移：旧设置未落盘（已用只读兜底，不影响看板与工具）：${e?.message ?? e}\n`);
      return;
    }
    const trace = `旧设置已迁移：${GRAPH_LEGACY_SETTINGS_SECTION} 节（来源 ${legacy.sources.join(", ")}）→ 条目 ${row.ns}；字段 ${fields.join(", ")}（均为此前缺失字段，显式值未被覆盖）`;
    process.stderr.write(`[dsh-graph-host] ${trace}\n`);
    try {
      writeFileSync(join(legacy.dir, GRAPH_LEGACY_SETTINGS_MARKER), `${new Date().toISOString()} ${trace}\n`);
    } catch { /* 标记写不进去：只是下次启动再判定一遍（值幂等 ⇒ 无重复写入） */ }
  };
  let registerGraphSkills = () => {};
  const setupGraphSettings = async () => {
    const z = resolveSchemastery();
    if (typeof ctx.inject !== "function") return; // 无 inject 的上下文（如部分 mock）降级
    ctx.inject(["settings"], (sctx) => {
      const svc = sctx?.settings;
      // 旧能力优先：只要服务上还有 namespace 注册 API，就绝不改走表单投影
      // （0.1.6 线的 SettingsProvider 同时暴露 register 与 describe，但后者的 ns 是
      //  namespace 而非 profile 条目 id —— 误走表单分支会**静默**退回默认值）。
      const registerCapable = typeof svc?.register === "function";
      if (registerCapable) {
        if (!z) {
          // schema 依赖 schemastery；解析不到时如实说明。
          // NB-2 措辞订正：基线（g-351 之前）此分支**也有**同形 stderr 告警
          //（`g-133: @deepseek-ai/schemastery 不可解析…`，见 96c29cb:dsh-graph-host/index.js:959），
          // 并非「无提示的默认值」；此处沿用同一如实告警口径，按中性功能描述留痕（不再带历史目标编号前缀）。
          process.stderr.write("[dsh-graph-host] 设置能力降级：@deepseek-ai/schemastery 不可解析，profile 全局默认降级（模型路由/提示词走 project.yaml/继承）\n");
          return;
        }
        try {
          graphSettingsScope = svc.register(GRAPH_SETTINGS_NS, buildGraphSettingsSchema(z), {
            base: { ...GRAPH_SETTINGS_DEFAULTS },
          });
          sctx.effect(() => () => { graphSettingsScope = null; });
          try { registerGraphSkills(); } catch { /* 静默 */ }
          return;
        } catch (e) {
          const reason = `register: ${e?.message ?? e}`;
          process.stderr.write(`[dsh-graph-host] 设置注册失败（降级，模型路由/提示词走默认）：${reason}\n`);
          return;
        }
      }
      // 新能力：profile 条目 Config 经设置表单投影（0.1.7 线）。值由 `Config` 声明，
      // `configure({ auto: true })` 声明该 entry 允许自动生成设置页（策略可选，失败不致命）。
      if (typeof svc?.describe === "function") {
        // g-454：宿主内建映射表不含 `dsh-graph` → `dsh-graph-host` 且宿主侧不可影响，故在此
        // 读旧节：先做**只读兜底**（写入落盘前/失败时读取同样正确），再异步做一次性幂等迁移。
        try { legacyGraphSettings = readLegacyGraphSettings(); } catch { legacyGraphSettings = null; }
        if (typeof svc.configure === "function") {
          try { sctx.effect(() => svc.configure({ auto: true })); } catch { /* 页面策略可选 */ }
        }
        graphSettingsScope = { get: () => readGraphSettingsFromForms(svc) };
        sctx.effect(() => () => { graphSettingsScope = null; });
        try { registerGraphSkills(); } catch { /* 静默 */ }
        // 监听设置文档热更新（如在线切换语言/配置），实时重新注册对应语言的 skills
        if (typeof sctx.on === "function") {
          try {
            sctx.on("settings/document-updated", () => {
              try { registerGraphSkills(); } catch { /* 静默 */ }
            });
          } catch { /* 事件监听失败静默 */ }
        }
        // 迁移失败不阻断（读取侧已有同源只读兜底），故不 await、只兜住异常。
        if (legacyGraphSettings) void persistLegacyGraphSettings(svc).catch(() => {});
        return;
      }
      // 两条能力都不可用：如实降级（读取走 project.yaml/继承），不伪装成注册异常。
      process.stderr.write("[dsh-graph-host] 设置能力不可用（降级，模型路由/提示词走 project.yaml/继承）：settings 服务未提供 namespace 注册或表单投影 API\n");
    });
  };
  setupGraphSettings();
  /** 读 dsh-graph profile 全局默认（settings service 缺失或未注册时返回默认空值）。 */
  const readGraphSettings = () => {
    try {
      const v = graphSettingsScope?.get?.() ?? null;
      if (!v) return { ...GRAPH_SETTINGS_DEFAULTS };
      const rawMode = v.subagentMode ?? "";
      const safeMode = normalizeSubagentMode(rawMode) ?? "";
      return {
        subagentProvider: v.subagentProvider ?? "",
        subagentModel: v.subagentModel ?? "",
        subagentReasoningEffort: v.subagentReasoningEffort ?? "",
        subagentMode: safeMode,
        subagentPrompt: v.subagentPrompt ?? "",
        promptLanguage: ["follow", "zh", "en"].includes(v.promptLanguage) ? v.promptLanguage : "follow",
        // g-505：**保留原始字符串**（不在这里归一成 ""）——畸形值必须能被下游判为 malformed。
        supervisorKeepAlive: typeof v.supervisorKeepAlive === "string" ? v.supervisorKeepAlive : "",
        // g-506：同上，保留原始字符串；非法值由 readGlobalCareState 标 malformed。
        supervisorCare: typeof v.supervisorCare === "string" ? v.supervisorCare : "",
        supervisorCareThresholdSeconds: typeof v.supervisorCareThresholdSeconds === "string" ? v.supervisorCareThresholdSeconds : "",
        supervisorCareRecheckSeconds: typeof v.supervisorCareRecheckSeconds === "string" ? v.supervisorCareRecheckSeconds : "",
      };
    } catch {
      return { ...GRAPH_SETTINGS_DEFAULTS };
    }
  };

  // ── g-505：profile 全局保活开关的**原始值**读取（raw + malformed 端到端闭锁）──────────
  //
  // settings 服务（新宿主）会按 schema 校验/回落，手改 settings.yaml 写入非法值（如 `yes`）时
  // 宿主可能直接回落到默认值 —— 那样我们只能看到「未配置 ⇒ 默认开启」，正是「坏值归一 inherit
  // 后默认启用」的漏洞。故这里**只读**解析 profile 的 settings.yaml(.imported) 中本插件条目
  // （`dsh-graph-host`，兼容旧节 `dsh-graph`）的 `supervisorKeepAlive` 原值：
  //   · 合法 on/off/"" ⇒ 正常分类；
  //   · 存在但非法 ⇒ malformed（fail-closed 关闭），并如实投影给 REST/UI；
  //   · 文件缺失/不可解析/无该键 ⇒ 不据此造 malformed（交给 settings 服务口径）。
  // 安全：只在内存里取这一个键，**绝不**记录/回传其他设置项或凭据；结果按文件 mtime 缓存。
  const rawGlobalKeepAliveCache = { at: -1, file: null, value: undefined };
  const readRawGlobalKeepAliveFromProfile = () => {
    let profile = null;
    try { profile = typeof ctx.get === "function" ? ctx.get("profileContext") : null; } catch { profile = null; }
    const home = typeof profile?.home === "string" && profile.home ? profile.home : null;
    if (!home) return { present: false, raw: undefined };
    // 只读**当前** settings.yaml：`settings.yaml.imported` 是宿主迁移遗留的只读快照，
    // 不是当前配置链的真源，绝不能用它覆盖现设置（review B 额外项）。
    const file = join(home, "settings.yaml");
    let stat = null;
    try { stat = statSync(file); } catch { return { present: false, raw: undefined }; }
    if (!stat?.isFile()) return { present: false, raw: undefined };
    const best = { file, mtimeMs: stat.mtimeMs };
    if (rawGlobalKeepAliveCache.file === best.file && rawGlobalKeepAliveCache.at === best.mtimeMs) {
      return rawGlobalKeepAliveCache.value;
    }
    let result = { present: false, raw: undefined };
    try {
      const doc = parseYaml(readFileSync(best.file, "utf8"));
      // 当前宿主条目 id 存在时只认它；只有文件里没有该条目（旧线）才回看历史 namespace，
      // 避免把旧节残留当成现真源（review 额外项）。
      const hasEntry = !!doc && typeof doc === "object" && Object.hasOwn(doc, GRAPH_SETTINGS_ENTRY_ID);
      const section = hasEntry ? doc[GRAPH_SETTINGS_ENTRY_ID] : (doc && typeof doc === "object" ? doc[GRAPH_SETTINGS_NS] : null);
      if (section && typeof section === "object" && Object.hasOwn(section, "supervisorKeepAlive")) {
        result = { present: true, raw: section.supervisorKeepAlive };
      }
    } catch { /* 不可读/不可解析：不据此造 malformed */ }
    rawGlobalKeepAliveCache.at = best.mtimeMs;
    rawGlobalKeepAliveCache.file = best.file;
    rawGlobalKeepAliveCache.value = result;
    return result;
  };

  /**
   * g-505：全局开关的读侧状态（供调度器/REST/UI 消费）。
   *
   * `available=false` 只在 settings 能力缺失时出现（等晚到服务，不因此判畸形）；
   * `malformed=true` 时 effective 一律关闭（fail-closed），绝不「归一 inherit ⇒ 默认开启」。
   */
  const readGlobalKeepAliveState = () => {
    let cooked = "";
    try { cooked = readGraphSettings().supervisorKeepAlive ?? ""; } catch { cooked = ""; }
    const fromSettings = resolveKeepAliveGlobalRaw(cooked);
    const rawFile = readRawGlobalKeepAliveFromProfile();
    // 公开 settings 服务返回**显式合法值**时它是实际配置链的最新真源（内存值可能领先落盘）；
    // 只有它「未配置/畸形」时才看当前 settings.yaml 的 raw 值（检出宿主 schema 回落前的坏值）。
    // 不读 `.imported`（迁移遗留快照），也不让旧节迁移影响本字段（见 coerceLegacyGraphSettings）。
    if (fromSettings.enabled !== null && !fromSettings.malformed) {
      return { enabled: fromSettings.enabled, malformed: false, available: true, raw: fromSettings.raw };
    }
    if (rawFile.present) {
      const fromRaw = resolveKeepAliveGlobalRaw(rawFile.raw);
      if (fromRaw.malformed) {
        return { enabled: null, malformed: true, available: true, raw: fromRaw.raw };
      }
      if (fromSettings.enabled === null || fromSettings.malformed) {
        return { enabled: fromRaw.enabled, malformed: false, available: true, raw: fromRaw.raw };
      }
    }
    return {
      enabled: fromSettings.enabled,
      malformed: fromSettings.malformed,
      available: graphSettingsScope != null,
      raw: fromSettings.raw,
    };
  };

  // ── g-506：profile 全局关照配置的**原始值**读取（raw + malformed 端到端闭锁）────────────
  // 与 keep_alive 同款：settings 服务的 cooked 值可能已被宿主 schema 回落；手改 settings.yaml
  // 写入坏值时只能从当前文件原值判定 malformed。绝不读 `.imported`，绝不读取/回传其它键。
  const rawGlobalCareCache = { at: -1, file: null, value: undefined };
  const readRawGlobalCareFromProfile = () => {
    let profile = null;
    try { profile = typeof ctx.get === "function" ? ctx.get("profileContext") : null; } catch { profile = null; }
    const home = typeof profile?.home === "string" && profile.home ? profile.home : null;
    if (!home) return { present: false };
    const file = join(home, "settings.yaml");
    let stat = null;
    try { stat = statSync(file); } catch { return { present: false }; }
    if (!stat?.isFile()) return { present: false };
    if (rawGlobalCareCache.file === file && rawGlobalCareCache.at === stat.mtimeMs) {
      return rawGlobalCareCache.value;
    }
    let result = { present: false };
    try {
      const doc = parseYaml(readFileSync(file, "utf8"));
      const hasEntry = !!doc && typeof doc === "object" && Object.hasOwn(doc, GRAPH_SETTINGS_ENTRY_ID);
      const section = hasEntry ? doc[GRAPH_SETTINGS_ENTRY_ID] : (doc && typeof doc === "object" ? doc[GRAPH_SETTINGS_NS] : null);
      if (section && typeof section === "object") {
        const pick = {};
        for (const key of ["supervisorCare", "supervisorCareThresholdSeconds", "supervisorCareRecheckSeconds"]) {
          if (Object.hasOwn(section, key)) pick[key] = section[key];
        }
        if (Object.keys(pick).length) result = { present: true, values: pick };
      }
    } catch { /* 不可读/不可解析：不据此造 malformed */ }
    rawGlobalCareCache.at = stat.mtimeMs;
    rawGlobalCareCache.file = file;
    rawGlobalCareCache.value = result;
    return result;
  };

  const parseCareGlobalSwitch = (raw) => {
    if (raw === undefined || raw === null || raw === "") return { enabled: null, malformed: false, raw: "" };
    if (raw === "on") return { enabled: true, malformed: false, raw: "on" };
    if (raw === "off") return { enabled: false, malformed: false, raw: "off" };
    let display = "";
    try { display = typeof raw === "string" ? raw : JSON.stringify(raw); } catch { display = ""; }
    return { enabled: null, malformed: true, raw: display.slice(0, 80) };
  };
  const parseCareGlobalSeconds = (raw) => {
    if (raw === undefined || raw === null || raw === "") return { value: null, malformed: false };
    const v = normalizeCareSeconds(raw);
    return { value: v, malformed: v === null };
  };

  /**
   * g-506：全局关照配置的读侧状态（调度器/REST/UI 同源）。
   * `available=false` 仅在 settings 能力缺失时出现；`malformed=true` ⇒ 决策 fail-closed 关闭。
   */
  const readGlobalCareState = () => {
    let cooked = { ...GRAPH_SETTINGS_DEFAULTS };
    try { cooked = readGraphSettings(); } catch { cooked = { ...GRAPH_SETTINGS_DEFAULTS }; }
    const sw = parseCareGlobalSwitch(cooked.supervisorCare);
    const th = parseCareGlobalSeconds(cooked.supervisorCareThresholdSeconds);
    const rc = parseCareGlobalSeconds(cooked.supervisorCareRecheckSeconds);
    const rawFile = readRawGlobalCareFromProfile();
    let enabled = sw.enabled;
    let malformed = sw.malformed;
    let raw = sw.raw;
    let thresholdSeconds = th.value;
    let thresholdMalformed = th.malformed;
    let recheckSeconds = rc.value;
    let recheckMalformed = rc.malformed;
    if (rawFile.present) {
      const rv = rawFile.values ?? {};
      if (Object.hasOwn(rv, "supervisorCare")) {
        const rawSw = parseCareGlobalSwitch(rv.supervisorCare);
        if (rawSw.malformed) { malformed = true; raw = rawSw.raw; enabled = null; }
        else if (sw.enabled === null || sw.malformed) { enabled = rawSw.enabled; raw = rawSw.raw; malformed = false; }
      }
      if (Object.hasOwn(rv, "supervisorCareThresholdSeconds")) {
        const rawTh = parseCareGlobalSeconds(rv.supervisorCareThresholdSeconds);
        if (rawTh.malformed) thresholdMalformed = true;
        else if (th.value === null || th.malformed) { thresholdSeconds = rawTh.value; thresholdMalformed = false; }
      }
      if (Object.hasOwn(rv, "supervisorCareRecheckSeconds")) {
        const rawRc = parseCareGlobalSeconds(rv.supervisorCareRecheckSeconds);
        if (rawRc.malformed) recheckMalformed = true;
        else if (rc.value === null || rc.malformed) { recheckSeconds = rawRc.value; recheckMalformed = false; }
      }
    }
    return {
      enabled,
      thresholdSeconds,
      recheckSeconds,
      malformed,
      thresholdMalformed,
      recheckMalformed,
      available: graphSettingsScope != null,
      raw,
    };
  };


  // ── g-505：保活运行时（effect 内 start，卸载即 dispose）与只读投影入口 ─────────────
  // 运行时只做采样/抢占/真实调用；「是否该保活」的唯一判定在 core/keepalive.ts。
  let keepAliveRuntime = null;
  /** workspace → board root（绝对 config.root 优先；否则 canonical 解析）。 */
  const keepAliveRootOfWorkspace = (ws) => {
    try {
      if (isAbsoluteConfig) return config.root;
      return resolveCanonicalRoot(config, ws).root;
    } catch {
      return null;
    }
  };
  /** 项目配置 + 真实全局值 → 生效投影（REST/UI/工具同源；绝不各自重算）。 */
  const keepAliveProjectionOf = (cfg) => {
    const g = readGlobalKeepAliveState();
    return keepAliveEffectiveOf(cfg?.supervisor, g.enabled, g.malformed, g.available);
  };
  /** 运行时状态投影（含 configured/effective/capable/active 四段；失败返回 null）。 */
  const keepAliveStatusOf = (rootForStatus) => {
    try { return keepAliveRuntime ? keepAliveRuntime.statusFor(rootForStatus) : null; } catch { return null; }
  };
  // ── g-506：关照运行时（effect 内 start，卸载即 dispose）与只读投影入口 ─────────────
  let careRuntime = null;
  /** 项目半边（原始 mode + 归一时间参数）；畸形 mode 保留原始值给 core 判 project_invalid。 */
  const careProjectHalfOf = (cfg) => ({
    mode: cfg?.supervisor?.care_malformed === true
      ? (cfg.supervisor.care_raw ?? "invalid")
      : (cfg?.supervisor?.care ?? null),
    thresholdSeconds: cfg?.supervisor?.care_threshold_seconds ?? null,
    recheckSeconds: cfg?.supervisor?.care_recheck_seconds ?? null,
  });
  /** 项目 + 真实全局 → 生效投影（REST/UI/调度器同源，绝不各自重算）。 */
  const careProjectionOf = (cfg) => {
    const g = readGlobalCareState();
    return careEffectiveOf(careProjectHalfOf(cfg), {
      enabled: g.malformed === true ? "__invalid__" : (g.enabled ?? null),
      thresholdSeconds: g.thresholdSeconds,
      recheckSeconds: g.recheckSeconds,
    });
  };
  /** 运行时状态投影（服务端唯一倒计时真源；失败返回 null）。 */
  const careStatusOf = (rootForStatus) => {
    try { return careRuntime ? careRuntime.statusFor(rootForStatus) : null; } catch { return null; }
  };
  /**
   * 设置面（REST GET/POST）下发的配置投影：在项目读值上补齐**真实全局值**算出的生效投影
   * 与运行时状态。GUI 只消费服务端下发的 `effective`，绝不自备默认值副本 ⇒ 不会与调度器漂移。
   */
  const settingsConfigForUi = (rootForUi) => {
    const cfg = readProjectConfig(rootForUi);
    try {
      const effective = keepAliveProjectionOf(cfg);
      const status = keepAliveStatusOf(rootForUi);
      // g-506：关照的生效投影与运行时状态（与调度器/REST 同源；GUI 不自备默认值副本）。
      const careEffective = careProjectionOf(cfg);
      const careStatus = careStatusOf(rootForUi);
      return {
        ...cfg,
        supervisor: {
          ...cfg.supervisor,
          keep_alive_effective: effective,
          ...(status ? { keep_alive_status: status } : {}),
          care_effective: careEffective,
          ...(careStatus ? { care_status: careStatus } : {}),
        },
      };
    } catch {
      return cfg; // 新功能异常绝不拖垮设置页
    }
  };
  // g-333：workspace 子代理补充提示词的**唯一消费者**——结构化三态 `prompt_overrides.subagent`
  //（core `resolveSubagentPrompt`，闭集优先级：override/disable/default；default 回落遗留
  // `defaults.subagent_prompt`，再回落 profile 全局 `subagentPrompt`）。
  // 旧实现直接用 core 的**遗留全文件正则读取器**扫 project.yaml 文本取键名 `subagent_prompt`：
  // 全文件匹配 + 只剥引号，与设置弹窗写入的 `prompt_overrides.subagent` **零交集**（配置改了不影响派发），
  // 且多行文本会把字面 `\n` 带进 prompt。该读取器调用点与本地包装已删除；
  // `defaults.subagent_prompt` 仅作 deprecated 兼容回落（由 core 结构化消费，不再是独立消费者）。
  // g-149：workspace 校验——无明确 workspace 且非绝对 config.root 时抛 GraphError
  const requireWorkspace = (ex) => {
    if (isAbsoluteConfig) return config.root; // 绝对 root 不需要 workspace
    const ws = sessionWorkspace(ex);
    if (!ws) throw new GraphError("graph_* 工具需要明确的会话 workspace（session.header.cwd 或 sandboxPolicy.workspaceRoot），当前无可用 workspace");
    return ws;
  };
  const rootFor = (ex) => {
    const ws = requireWorkspace(ex);
    const canonical = resolveCanonicalRoot(config, ws);
    init(canonical.root);
    // 如果发现遗留 worktree 本地 graph，记录警告到 stderr
    if (canonical.rootWarning) {
      process.stderr.write(`[dsh-graph-host] ⚠️ ${canonical.rootWarning}\n`);
    }
    return canonical.root;
  };
  // g-149：rootForMeta 返回带元数据的解析结果（诊断用）
  const rootForMeta = (ex) => {
    const ws = requireWorkspace(ex);
    const canonical = resolveCanonicalRoot(config, ws);
    init(canonical.root);
    if (canonical.rootWarning) {
      process.stderr.write(`[dsh-graph-host] ⚠️ ${canonical.rootWarning}\n`);
    }
    return canonical;
  };
  const actorOf = (exec) => `agent:${exec?.agent?.id ?? "dsh"}`;
  const memoryActorOf = (exec) => {
    const session = exec?.agent?.session?.id;
    if (!session) throw new GraphError("memory 工具需要可信 ex.agent.session 上下文");
    return `agent:${session}`;
  };
  // g-190：解绑的权威身份映射——当前会话若是已配置的 supervisor，映射为 supervisor:<sid>
  // （core authorizeUnbind 以 supervisor.session 匹配放行主管；普通会话保持 agent:<sid> 由 core 校验 owner）。
  const unbindActorOf = (ex, root) => {
    const sid = ex?.agent?.session?.id;
    if (sid && readSupervisorSession(root) === sid) return `supervisor:${sid}`;
    return actorOf(ex);
  };
  // g-369：owner 判定的唯一输入——目标创建者（meta.created_by）。只读；目标不存在时由 findGoalFile 抛错。
  const goalCreatedBy = (root, goalId) => loadGoal(findGoalFile(root, goalId)).meta.created_by;

  // ---- g-374 F1：attempt 完成摘要的零 token 截获（宿主生命周期事件，非 LLM / 非轮询 / 非 fs watcher）----
  // 数据源唯一正解：`ctx.on("subagent/end", info)` 的 `info.lastAssistantMessage`（ContentBlock[]，
  // 宿主已折好的「最后一条非空 assistant 消息」，纯函数选择规则，零 LLM）。`info.id` = durable childId
  // = attempt.md 的 meta.child_id ⇒ 用下面这个内存 Map 精确归因（**Map miss 绝不瞎猜归属**）。
  // 只在 executor 派发点登记；collect / spawn 派发点不登记（它们不是 attempt）。
  const childAttemptIndex = new Map();
  const CHILD_ATTEMPT_INDEX_CAP = 512;
  const indexChildAttempt = (childId, entry) => {
    if (!childId) return;
    // 重绑/重发指令 → 同一 childId 只保留最新归属；LRU 上界防长跑进程映射无界增长。
    childAttemptIndex.delete(childId);
    childAttemptIndex.set(childId, entry);
    while (childAttemptIndex.size > CHILD_ATTEMPT_INDEX_CAP) {
      const oldest = childAttemptIndex.keys().next().value;
      if (oldest === undefined) break;
      childAttemptIndex.delete(oldest);
    }
  };
  // Map miss 的留痕策略见 captureAttemptResults：**纯 stderr**，不写看板事件流
  // （F1 复核注记③：对所有非 attempt 子代理记账 ⇒ 事件流噪声无界增长且不可归因）。

  // ---- g-374 F5：LLM 详情摘要（专用 summarizer 子代理）----
  // 归因红线：summarizer 是**子代理**，但**绝不**进 childAttemptIndex（它不写 results-att-*.md），
  // 另外单独索引，用于：① child 结束时判断它是否已落盘 LLM 正文；② 未落盘 ⇒ 降级写 deterministic。
  const summarizerIndex = new Map();
  const SUMMARIZER_LABEL_PREFIX = "graph:summarize-results/";
  const indexSummarizerChild = (childId, entry) => {
    if (!childId) return;
    summarizerIndex.delete(childId);
    summarizerIndex.set(childId, { landed: false, spawnedAt: new Date().toISOString(), ...entry });
    while (summarizerIndex.size > CHILD_ATTEMPT_INDEX_CAP) {
      const oldest = summarizerIndex.keys().next().value;
      if (oldest === undefined) break;
      summarizerIndex.delete(oldest);
    }
  };

  /**
   * g-436：独立评审子代理的归因索引（与 summarizer 同款隔离，绝不进 childAttemptIndex）。
   *
   * 归因红线：reviewer 子代理**不是** attempt 执行者——它
   *  - 不写 `results-att-*.md`（那是作者结果，写入策略是 last-wins，覆盖即毁证）；
   *  - 不改 attempt.md 的 `child_id` / `binding_token` / `binding_version`（不得冒充执行绑定）；
   *  - 不写 `attempt.*` 事件。
   * 它只把报告正文写进 `<goalDir>/reviews/<review_id>.md`（独立落盘），并记 `review.*` 事件。
   * 结论只按**真实绑定的 child 身份**归因：Map miss ⇒ 归属未知 ⇒ 不写、不猜（stderr 留痕）。
   */
  const reviewerIndex = new Map();
  const REVIEW_LABEL_PREFIX = "graph:review/";
  const indexReviewerChild = (childId, entry) => {
    if (!childId) return;
    reviewerIndex.delete(childId);
    reviewerIndex.set(childId, entry);
    while (reviewerIndex.size > CHILD_ATTEMPT_INDEX_CAP) {
      const oldest = reviewerIndex.keys().next().value;
      if (oldest === undefined) break;
      reviewerIndex.delete(oldest);
    }
  };

  /**
   * g-374 F5（复核 BLOCK-1 返工）：把某目标下**全部仍待结束**的 summarizer 项标记为「已落盘正文」。
   *
   * 反例（复核实测）：summarizer 已成功落盘 LLM 正文，但在它结束前历史发生变化（例如一条
   * `attempt.status_reported` 就足以改变 `source_hash`）⇒ 用 `cache_hit` 判断「本次是否已落盘」
   * 会得出 false ⇒ child 结束时用 deterministic **覆盖刚产出的 LLM 正文**，并把 `fallback_reason`
   * 写成 `subagent-end: completed`，界面显示「LLM 摘要失败」——LLM 实际成功，是虚假失败提示。
   * 落盘路径都会调用本函数（无竞态：落盘与 child 结束都在事件/工具回调侧，按先后顺序执行）。
   *
   * **粒度说明（复核注记 2）**：按 **goal** 标记，因此会把该目标下**所有**仍待结束的项一起标记，
   * 而不只是刚落盘那个 child。选择 goal 粒度而非 child 精度的理由：①落盘路径（工具/REST）此时
   * 并不知道自己对应哪个 childId（正文由子代理经工具回传，工具参数里没有 child_id），要精确标记
   * 只能反查「哪个 child 正在写这个目标」，反而引入新的时序假设；②同一目标正常只有一个在飞
   * summarizer（再次点击会先命中缓存或由用户 force）；③越界标记的后果是**良性**的——同目标已经
   * 有了更新的外部正文，此时不降级是更安全的一侧（少一次覆盖、少一次浪费的调用），最坏情况是
   * 某个真正失败的 child 不再写 deterministic 兜底，而那份正文仍在、用户在 GUI 上仍可再次触发。
   */
  const markSummarizerLanded = (goal) => {
    if (!goal) return 0;
    let n = 0;
    for (const entry of summarizerIndex.values()) {
      if (entry?.goal !== goal || entry.landed === true) continue;
      entry.landed = true;
      entry.landedAt = new Date().toISOString();
      n += 1;
    }
    return n;
  };

  // 统一的 summarizer 派发（REST 与工具共用）：材料包零 LLM 生成 → role=summarizer 子代理 → 登记索引。
  // 模型通道：沿用宿主子代理机制与既有模型路由（resolveModelRoute：executor 覆盖 > project.yaml > 全局），
  // **不直连 HTTP、不自带凭据**。
  /** g-473：宿主能力探针上下文 —— core 不接触宿主对象，只消费「名字是否可用」这一个纯函数。
   *
   * 真源：`tools.get(name, agentScope)`。**必须传 agent scope**：DSH 把模型面向工具注册在
   * agent preset 平面（祖先层），无 scope 的 `get(name)` 只覆盖 global 层 ⇒ 会把 bash/pwsh/read/…
   * 全判为不可用。Agent 实例本身就是 scope key（dsh-agent-loop: createScope(loopCtx, this)），
   * dsh-subagent 又用 `composeFrom(childCtx, parent.ctx)` 把 child 绑到 parent 同一 preset scope
   * ⇒ 用 parent 探针得到的名字集合与 child 的 restrictableNames 一致，探针为真必被 restrict() 接受。
   * 拿不到 agent 或 tools 服务时不注入探针（core 按平台回落，保持 legacy 行为，绝不误阻断）。 */
  const toolCapabilityFor = (agentScope) => {
    const platform = (() => { try { return process.platform; } catch { return undefined; } })();
    // `ctx.tools` 可能整个服务未注入（测试夹具 / 精简宿主）——取值本身也要兜住，否则会抛在派发路径上。
    let tools;
    try { tools = ctx?.tools; } catch { tools = undefined; }
    if (!tools || typeof tools.get !== "function" || !agentScope) return { platform };
    return {
      platform,
      available: (name) => { try { return Boolean(tools.get(name, agentScope)); } catch { return false; } },
    };
  };

  /** g-473：派发前工具能力自检（事件先行，随后由调用方写进返回文案 / child_error）。
   *  返回 `null` = 通过；否则为可读诊断文本 ⇒ **调用方不得派发**（不启动能力残缺的子代理，
   *  也不让 dsh-tools 的 `names unknown global tool` 内部错误原样外泄）。 */
  const capabilityBlock = (rootForWrite, { goal, role, mode, agentScope, label }) => {
    // g-480：必需工具清单按**本 board root 的模块开关**自适应（模块关 ⇒ 其受管工具不再算必需，
    // 角色随模块自适应而**不再被拒派发**）；宿主真缺工具（探针 false）的 fail-closed 语义不变。
    const diag = diagnoseDispatchCapability(role, mode, toolCapabilityFor(agentScope), readModuleSwitchesForRoot(rootForWrite));
    if (diag.ok) return null;
    try {
      appendDispatchCapabilityMissing(rootForWrite, {
        goal: goal ?? null,
        role,
        mode: diag.mode,
        missing: diag.missing,
        shell: diag.shell,
        label: label ?? null,
        actor: "system:dispatch",
      });
    } catch { /* 事件写失败绝不改变「不派发」的结论 */ }
    return diag.message;
  };

  const startSummarizerChild = async (root, goal, { parent, signal }, opts = {}) => {
    const goalFile = findGoalFile(root, goal);
    if (basename(goalFile) !== "goal.md") {
      return { childId: null, error: `暂存目标（backlog）没有目标目录，无法生成完成摘要：${goal}` };
    }
    const ws = opts.workspace ?? dirname(root);
    const goalRel = relative(ws, goalFile);
    const digest = renderGoalResultsDigest(goalResultsDigest(goalDetail(root, goal)));
    const prompt = formatSummaryPrompt({
      goalId: goal, goalRel, digest,
      language: resolvePromptLanguage(readGraphSettings().promptLanguage, ctx),
    });
    const eff = resolveModelRoute(
      { provider: opts.provider, model: opts.model, reasoning_effort: opts.reasoning_effort },
      readExecutorModel(root),
      readGraphSettings(),
    );
    const subagents = ctx.get?.("subagents");
    if (!subagents || !parent) return { childId: null, error: "subagents 服务不可用或无调用 agent", digest };
    const { provider, error: providerError } = probeContinuableProvider(subagents);
    if (!provider) return { childId: null, error: providerError, digest };
    // g-473：能力自检（缺必需工具则不派发；summarizer 无 shell 槽位，白名单缺 web_* 时静默剔除）
    const summarizerCapBlock = capabilityBlock(root, { goal, role: "summarizer", mode: opts.mode, agentScope: parent, label: `${SUMMARIZER_LABEL_PREFIX}${goal}` });
    if (summarizerCapBlock) return { childId: null, error: summarizerCapBlock, digest };
    const toolFilter = toolFilterForRole("summarizer", opts.mode, toolCapabilityFor(parent), readModuleSwitchesForRoot(root));
    const agentOptions = {};
    if (eff.provider) agentOptions.provider = eff.provider;
    if (eff.model) agentOptions.model = eff.model;
    if (eff.reasoning_effort) agentOptions.reasoningEffort = eff.reasoning_effort;
    try {
      const started = await startSubagentCompat(subagents, {
        provider,
        label: `${SUMMARIZER_LABEL_PREFIX}${goal}`,
        parent,
        prompt: text(prompt),
        ...(toolFilter ? { toolFilter } : {}),
        ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
        signal,
      });
      indexSummarizerChild(started.childId, { kind: "summarizer", root, goal, actor: opts.actor ?? "system:summarizer" });
      return {
        childId: started.childId, error: null, digest,
        model_route: (eff.provider || eff.model) ? `${eff.provider ?? "继承"}/${eff.model ?? "继承"}` : null,
      };
    } catch (e) {
      return { childId: null, error: subagentSpawnErrorText(e), digest };
    }
  };

  /** child 结束但没落盘 LLM 正文 ⇒ 降级：写 deterministic + fallback_reason（界面据此提示已回退）。 */
  const summarizeFallbackWrite = (entry, reason) => {
    try {
      // ① 精确信号：本次 spawn 对应的 child 已落盘正文（markSummarizerLanded）⇒ 绝不降级。
      if (entry?.landed === true) return;
      const cache = goalResultsCacheState(entry.root, entry.goal);
      if (cache.cache_hit) return; // ② 历史未变且已是 LLM 版（也可能是并发成功）⇒ 不覆盖
      // ③ 兜底：历史在落盘**之后**又变化 ⇒ cache_hit=false，但当前文件确实是本次 spawn 之后产出的
      //    LLM 正文（写盘时间不早于 spawn 时间）⇒ 同样视为已落盘，不得覆盖成 deterministic。
      const spawnedAt = Date.parse(String(entry?.spawnedAt ?? ""));
      const generatedAt = Date.parse(String(cache.generated_at ?? ""));
      if (cache.exists && cache.source === "llm" && Number.isFinite(spawnedAt) && Number.isFinite(generatedAt)
        && generatedAt >= spawnedAt) return;
      refreshGoalResults(entry.root, entry.goal, {
        actor: entry.actor ?? "system:summarizer-fallback",
        fallbackReason: reason,
      });
    } catch { /* 降级失败也不影响结算 */ }
  };

  /**
   * g-374：`subagent/end` 回调——**必须在事件回调侧完成截获与写入**。
   * 实测（card-fe88f5ef §0）：事件在 spawn 后 1.5–4.3s 到达，父轮次先结束不会取消事件但会丢观测窗口
   * ⇒ 任何依赖父轮次存活的写入都会静默丢结果。本回调整体 try/catch：**绝不影响子代理结算**。
   *
   * g-613：在 attempt 归属分支上追加**防污染前置判定**（`isStaleOrUnconfirmedEnd`）——旧代际迟到
   * 或复用投递未确认的 end 一律不写结果、不改目标状态。评审/summarizer 分支的相对顺序**未变**。
   */
  const captureAttemptResults = (info) => {
    try {
      const childId = typeof info?.id === "string" && info.id ? info.id : null;
      // g-436 归因红线：独立评审子代理**先**在这里被截住——它不是 attempt 执行者：
      // 不写 results-att-*.md（作者结果）、不写 attempt.* 事件、不产生看板噪声；
      // 只按真实 child 身份把报告正文写进 <goalDir>/reviews/<review_id>.md 并结算 review.* 事件。
      // fail-closed：空输出 / 异常终止 / 载荷缺失一律记 UNVERIFIED（**绝不记 PASS**）。
      const revEntry = childId ? reviewerIndex.get(childId) : null;
      if (revEntry) {
        // g-613：**不再**在这里删除该索引项——被复用的专家后续还会产生 subagent/end（第二轮结束时）。
        // 若删掉，那次结束会被当成「未登记」，若此后又被复用做执行 attempt 就会被误当成执行者；
        // 保留则它能一直正确归因到评审、只在再次被登记为 reviewer 或容量回收时淘汰。
        const revStop = typeof info?.stopReason === "string" && info.stopReason ? info.stopReason : null;
        const revBlocks = Array.isArray(info?.lastAssistantMessage) ? info.lastAssistantMessage : null;
        const revText = revBlocks
          ? revBlocks.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
          : "";
        try {
          settleReview(revEntry.root, revEntry.goal, revEntry.reviewId, {
            text: revText,
            stopReason: revStop,
            actor: revEntry.actor ?? "system:subagent/end",
            childId,
          });
        } catch (e) {
          process.stderr.write(`[dsh-graph] 评审结算失败（已忽略，不影响子代理结算）: ${e?.message ?? e}\n`);
        }
        return;
      }
      // g-374 F5 归因红线：summarizer 子代理**先**在这里被截住——它绝不是 attempt 执行者：
      // 不写 results-att-*.md、不写 attempt.* 事件、不产生任何看板噪声；只在「没落盘 LLM 正文」时降级。
      const sumEntry = childId ? summarizerIndex.get(childId) : null;
      if (sumEntry) {
        summarizerIndex.delete(childId);
        const stop = typeof info?.stopReason === "string" ? info.stopReason : "?";
        summarizeFallbackWrite(sumEntry, `subagent-end: ${stop}`);
        return;
      }
      const entry = childId ? childAttemptIndex.get(childId) : null;
      if (!entry) {
        // 宿主重启后冷恢复的 child / 非 executor 派发的 child（收集/spawn/普通子代理）：归属未知
        // ⇒ 不写文件、不猜归属。
        // g-374 F3（F1 复核注记③）：**降为纯 stderr**——此前对**所有**非 attempt 子代理都记
        // `console.warn` + `attempt.results_skipped` 事件，事件流噪声无界增长；归属未知本就不可
        // 归因到具体目标，写进看板事件流只会污染负责人看板。保留 stderr 便于诊断。
        try {
          const stop = typeof info?.stopReason === "string" ? info.stopReason : "?";
          process.stderr.write(`[dsh-graph] subagent/end 未登记 child=${childId ?? "(none)"} stop=${stop} —— 跳过完成摘要（不猜归属，纯 stderr 留痕）\n`);
        } catch { /* 忽略 */ }
        return;
      }
      // g-613：复用后**旧代际**迟到的 end 不得写进当前目标（按代际观察值与投递确认状态判定）。
      if (isStaleOrUnconfirmedEnd(info, entry)) return;
      if (info?.local === false) return; // 本项目只用 continuable 子代理（local 恒 true）
      // 特性探测：payload 既无 lastAssistantMessage 也无 stopReason ⇒ 宿主未提供该 event 的 g-374 载荷，
      // 静默降级（不写文件、不抛错）。有 stopReason 但缺文本 ⇒ 是「子代理无输出」占位（可区分）。
      const hasField = Object.prototype.hasOwnProperty.call(info ?? {}, "lastAssistantMessage");
      const stopReason = typeof info?.stopReason === "string" && info.stopReason ? info.stopReason : null;
      if (!hasField && stopReason === null) return;
      const blocks = Array.isArray(info?.lastAssistantMessage) ? info.lastAssistantMessage : null;
      const text = blocks
        ? blocks.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
        : "";
      writeAttemptResults(entry.root, {
        goal: entry.goal,
        attempt: entry.attempt,
        source: "subagent/end",
        childId,
        stopReason,
        text,
        actor: entry.actor ?? "system:subagent/end",
      });
    } catch (e) {
      try { console.warn("[dsh-graph] 完成摘要截获失败（已忽略，不影响结算）:", e?.message ?? e); } catch { /* 忽略 */ }
    }
  };

  /** g-374：child_error 分支占位（无子代理 ⇒ 永远不会有 subagent/end 事件，必须在派发处补齐）。 */
  const writeChildErrorResults = (rootForWrite, goalId, attemptId, actor, note) => {
    try {
      writeAttemptResults(rootForWrite, {
        goal: goalId, attempt: attemptId, source: "child_error", childId: null,
        stopReason: null, text: null,
        reason: note ? `child-error: ${note}` : "child-error: subagents 服务不可用或无调用 agent",
        actor: actor || "system:dispatch",
      });
    } catch { /* 绝不打断派发 */ }
  };

  // g-190：子代理活跃度探测（live registry 权威）。
  // 返回 "running"（正运行）/ "idle"（已加载未运行）/ "gone"（不在 live registry）/ "unknown"（registry 不可用）。
  const childLiveState = (childId) => {
    const agents = ctx.get?.("agents");
    if (!agents || typeof agents.get !== "function") return "unknown";
    try {
      const a = agents.get(childId);
      if (!a) return "gone";
      // 尽力区分 running / idle：Agent 暴露 running 标志时精确判断，否则保守视为仍 live（idle）
      if (a?.running === true || a?.status === "running") return "running";
      return "idle";
    } catch {
      return "unknown";
    }
  };

  // ============================================================================
  // g-613：复用**空闲**专家子代理承接新目标（`graph_start_attempt(goal, child_id=...)`）
  // ============================================================================
  //
  // 为什么必须在派发入口做、且由引擎记归属：主管直接对专家发 `send_message` 派活会脱离看板
  // （目标无法进 in_progress、关照不纳管、成果不可审计）。复用路径把「同一 child → 另一目标/attempt」
  // 这一事实写进 attempt.md（child_id + binding_version）与事件流，从而让**既有**投影（看板「被复用」、
  // care 的 bindingVersion、请求归属表）都按同一真源工作 —— 不新造第二套状态机。
  //
  // 已实测的宿主边界（0.2.2-rc.1，见 g-613 结果日志）：
  //   · `agents.get(child).status` ∈ {running, idle}，`agent/status` 在每轮起止各发一次；**idle 的
  //     continuable child 仍常驻**（settlementState 在 inbox 有 pending 时 wait）⇒ idle 可直接复用；
  //   · `sendMessage` 对 running 是 **steer**（合入当前步），对 idle 才是新轮；**发送时不能改 cwd/
  //     模型/工具权限**（子会话 header.cwd 与工具限制沿用创建时继承的父值）；
  //   · 子代理沙箱根继承父会话 header.cwd ⇒ 复用**不能**缩小写入权限；worktree 只是工作位置隔离；
  //   · 另一父会话向该 child 发消息 ⇒ `UNAUTHORIZED ... belongs to another parent session`；
  //   · `subagent/end` 的 `runId` 由宿主每次 residency **随机生成**，插件无法预测/延续蒸发值
  //     ⇒ 代际只能记**不透明观察值**（零断言，仅用于「是否与当前代际同代」的比较）。
  //
  // 并发/竞态纪律：准入判定 → 状态迁移 → attempt 落盘 → 绑定 必须在**同一同步临界区**
  // （`withLocalLock(root, "execution-"+goal)`，内部无 await）内完成 ⇒ 两个并发复用请求不可能
  // 同时看到「空闲」；投递（唯一真实 await）放在绑定之后，失败即 fail-closed 如实上报。
  /** 读取 child 的 live Agent（只读；registry 缺失/抛错 ⇒ null，由调用方按 fail-closed 处理）。 */
  const liveChildAgent = (childId) => {
    const agents = ctx.get?.("agents");
    if (!agents || typeof agents.get !== "function") return { agents: null, agent: null, error: "agents 服务不可用" };
    try {
      return { agents, agent: agents.get(String(childId)) ?? null, error: null };
    } catch (e) {
      return { agents, agent: null, error: `agents.get 失败：${e?.message ?? e}` };
    }
  };
  /** 调用者（主管）是否**真的**拥有该 child（g-625 收口：rc.1 `isOwnedBy` / rc.3 `rootOf`；不看 child_id 自报）。 */
  const callerOwnsChild = (agents, callerAgent, childId) => {
    if (!callerAgent) return "unknown";
    return ownershipProbeOf(agents, ctx.get?.("subagents"), { requireLiveTree: true }).ownsId(String(childId), callerAgent);
  };

  /**
   * 复用准入预检（**零副作用**：只在 tool 入口最早执行一次；真正的准入仍在 dispatch 的同步临界区内
   * 用同一套判定重查）。返回 `null` = 通过；否则为可读拒绝原因（GraphError，直接抛给调用方）。
   */
  const inspectReuseChild = (root, childId, callerAgent, { goal, protectedAttempt }) => {
    const code = String(childId ?? "").trim();
    if (!code) return null;
    // ① 形状：child 身份是 durable session id（UUID 等）；拒绝空白/控制字符/超长自报值。
    if (code.length > 200 || /[\u0000-\u001f\u007f]/.test(code)) {
      throw new GraphError(`child_id 非法：必须是宿主 durable child session id（不含空白/控制字符且 ≤200 字符）`);
    }
    if (!callerAgent) {
      throw new GraphError("复用 child_id 需要真实调用 agent（无 ex.agent 上下文）——拒绝在无身份上下文里复用子代理");
    }
    // ② 存活：复用只针对 live registry 里**常驻**的子代理（冷态无法确认沙箱根/工具面/血缘）。
    const live = liveChildAgent(code);
    if (live.error) {
      throw new GraphError(`无法确认 child ${code} 的状态（${live.error}）：复用 fail-closed，不建 attempt、不迁移状态`);
    }
    if (!live.agent) {
      throw new GraphError(
        `child ${code} 不在 live registry（已结束/冷态）：复用只支持**已空闲且常驻**的子代理；`
        + `请在原会话继续或新建子代理（去掉 child_id 重新派发）`,
      );
    }
    // ③ 归属：必须属于当前调用者（主管）——只用宿主公开归属能力（g-625 收口，不看 child_id 自报）。
    const owned = callerOwnsChild(live.agents, callerAgent, code);
    if (owned === "unknown") {
      throw new GraphError(`无法确认 child ${code} 是否属于当前主管（isOwnedBy / subagents.rootOf 不可用或出错）：复用 fail-closed`);
    }
    if (owned !== "yes") {
      throw new GraphError(`child ${code} 不属于当前主管会话（跨主管复用被拒绝）：不建 attempt、不迁移状态`);
    }
    // ④ 只要空闲：运行中一律拒绝 —— sendMessage 对 running 是 **steer**，会把新目标混进旧任务的当前步。
    const status = (() => { try { return live.agent.status; } catch { return undefined; } })();
    if (status === "running") {
      throw new GraphError(
        `child ${code} 正在运行：复用只接受**空闲**子代理。向运行中的子代理投递会被宿主当作 steer 合入当前步，`
        + `新任务会与旧任务混杂 ⇒ 拒绝（不建 attempt、不迁移状态）。请等它空闲后重试`,
      );
    }
    if (status !== "idle") {
      throw new GraphError(`child ${code} 状态未知（status=${String(status)}）：复用 fail-closed，不建 attempt、不迁移状态`);
    }
    // ⑤ 跨目标独占：同一 child 不得同时绑定多个未交付目标的**活跃** attempt。
    let bindings = [];
    try {
      bindings = findActiveExecutionBindings(root, code);
    } catch (e) {
      throw new GraphError(`无法读取看板绑定（${e?.message ?? e}）：复用 fail-closed，避免跨目标抢占`);
    }
    const busy = bindings.filter((b) => b.active && !(goal && b.goal === goal && b.attempt === protectedAttempt));
    if (busy.length) {
      const where = busy.map((b) => `${b.goal}/${b.attempt}(result=${b.result})`).join("、");
      throw new GraphError(
        `child ${code} 已被其它未交付目标的活跃 attempt 占用：${where}。`
        + `同一子代理不得同时服务多个目标（归属/关照无法区分）⇒ 拒绝复用；请先完成或解绑旧 attempt`,
      );
    }
    return null;
  };

  /**
   * 取本块看板里该 child 的**唯一活跃绑定**（用于新目标复用时的「旧绑定 → 被复用」标注）。
   * 只看 active 且与本次新目标不同的绑定；没有就是 null（例如该 child 是主管自己的普通子代理）。
   */
  const priorActiveBindingFor = (root, childId, goal, protectedAttempt) => {
    try {
      const rows = findActiveExecutionBindings(root, childId)
        .filter((b) => !(b.goal === goal && b.attempt === protectedAttempt));
      if (!rows.length) return null;
      // 优先「仍然活跃」的绑定（跨目标抢占已由准入拒绝，这里通常为空）；否则取最近终结的那条
      //（bindingVersion 代表该 attempt 的绑定次数，越大越接近本轮使用）。没有可指向的旧绑定 ⇒ null。
      rows.sort((a, b) => (Number(b.active) - Number(a.active)) || (b.bindingVersion - a.bindingVersion));
      return rows[0];
    } catch {
      return null;
    }
  };

  /**
   * 子代理**代际**（residency epoch）观察值：`subagent/start` 的 `runId`（宿主每次随机、不透明）。
   * 插件**不**依赖它证明「谁在跑」，只把它当作「是否与当前代际同代」的比较键（零假设、零写盘）。
   */
  const childEpochs = new Map(); // childId → { runId, observedAt }
  const epochOf = (childId) => (childId ? childEpochs.get(String(childId))?.runId ?? null : null);
  const recordEpoch = (childId, runId) => {
    if (!childId) return;
    childEpochs.set(String(childId), { runId: runId ?? null, observedAt: Date.now() });
    while (childEpochs.size > 512) {
      const oldest = childEpochs.keys().next().value;
      if (oldest === undefined) break;
      if (oldest === childId) break; // 不淘汰刚写入的一项
      childEpochs.delete(oldest);
    }
  };

  /**
   * g-613 防污染判定：`subagent/end` 是否属于**当前代际**、且该代际的投递已被确认。
   *
   * 两条 fail-closed 规则（任一命中即**不写结果、不改目标状态**，纯 stderr 留痕）：
   *  ① **旧代际迟到**：缓存里该 child 已被观察到更新的代际（复用后新一轮的 `runId`），
   *     本次 end 的 runId 与之不同 ⇒ 它是复用前那一轮的迟到事件。`runId` 是宿主每次 residency
   *     随机生成的不透明值，插件**不**用它证明「谁在跑」，只用来比较「是否同代」（零假设）。
   *  ② **投递未确认**：复用投递尚在飞（delivering）或受理后尚未确认（awaited）时到达的 end，
   *     无法证明它承载的是新任务 ⇒ 丢弃（绝不把旧任务的结束当新任务的成果）。
   */
  const isStaleOrUnconfirmedEnd = (info, entry) => {
    const childId = typeof info?.id === "string" && info.id ? info.id : null;
    const runId = typeof info?.runId === "string" && info.runId ? info.runId : null;
    const stop = typeof info?.stopReason === "string" ? info.stopReason : "?";
    const current = epochOf(childId);
    if (runId && current && current !== runId) {
      staleEndNotes.push({ childId, runId, current, stop, at: Date.now() });
      if (staleEndNotes.length > 64) staleEndNotes.splice(0, staleEndNotes.length - 64);
      process.stderr.write(
        `[dsh-graph] subagent/end 属旧代际（child=${childId} run=${runId} 当前=${current} stop=${stop}）`
        + ` —— 不写结果、不改目标状态（当前归属 ${entry.goal}/${entry.attempt}）\n`,
      );
      return true;
    }
    if (entry.awaited === true || entry.delivering === true) {
      process.stderr.write(
        `[dsh-graph] subagent/end child=${childId} 到达时复用投递尚未确认（awaited/delivering）——`
        + `不写结果、不改目标状态（${entry.goal}/${entry.attempt}）\n`,
      );
      return true;
    }
    return false;
  };

  /** 被丢弃的迟到 end 的有界留痕（只用于诊断/测试断言，**不是**状态真源）。 */
  const staleEndNotes = [];

  /**
   * g-613：复用收据（**同步**构造，运行于 dispatch 的 `execution-<goal>` 临界区内）。
   *
   * 此刻 attempt 已落盘（dispatch_in_flight=true），这里再按**同一套判定**重查一次空闲/归属/独占
   * ——预检与临界区之间隔了建树/读上下文等步骤，child 可能已经开跑；不一致一律抛 GraphError，
   * 由 dispatch 的既有失败收敛把该 attempt 结算为 child_error（**零残留**：不投递、不迁移）。
   * 绑定成功后 closeFailure 失效，后续投递失败只改本 attempt 的记录与事件，绝不误伤别的目标。
   */
  const buildReuseIntake = (root, { goal, attempt, childId, actor, parentSessionId, callerAgent, prompt, promptHash, contextDigest, modelRoute, mode, modeSource, injectedCards, injectedHandoffs, brief, briefSource, baselineCommit, baselineInfo }) => {
    let closeFailure = true;
    const fail = (message) => {
      if (!closeFailure) return;
      closeFailure = false;
      // 先结算「首次启动未结算」窗口与 child_error 占位，再抛出（attempt 进入终态，门禁不会永久卡死）。
      try { settleAttemptDispatchInFlight(root, goal, attempt, { actor, error: message }); }
      catch (e) { process.stderr.write(`[dsh-graph-host] settle dispatch_in_flight 失败（保持拒绝）：${e?.message ?? e}\n`); }
      writeChildErrorResults(root, goal, attempt, actor, `子代理复用未通过：${message}`);
      throw new GraphError(message);
    };
    inspectReuseChild(root, childId, callerAgent, { goal, protectedAttempt: attempt });
    const prior = priorActiveBindingFor(root, childId, goal, attempt);
    // 绑定使该 child 的归属翻到本目标（attempt.bound + binding_version 递增）。
    try {
      // 复用路径**已持有** execution-<goal> 锁（withLocalLock 不可重入）⇒ 必须用调用方持锁变体。
      bindAttemptChildLocked(
        root, goal, attempt, childId, actor,
        parentSessionId ?? callerAgent?.session?.id ?? null,
        null, null, modelRoute ?? null,
        mode, modeSource,
        { dispatchInFlight: true, parentSessionId: parentSessionId ?? callerAgent?.session?.id ?? null },
      );
    } catch (bindErr) {
      closeFailure = false; // 绑定 CAS 冲突：attempt 已被取消/解绑，不再追加 child_error 覆盖真实状态
      throw new GraphError(`attempt 绑定失败（复用 child ${childId}，未投递任何消息）：${bindErr?.message ?? bindErr}`);
    }
    closeFailure = false;
    const bindingVersion = (() => {
      try {
        return Number(goalDetail(root, goal).attempts?.find((a) => a.id === attempt)?.binding_version) || 0;
      } catch { return 0; }
    })();
    // 「旧绑定 → 被复用」标注写进**旧目标**的事件流（看板既有投影只认 attempt.reused + reused_by）。
    if (prior) {
      try {
        appendAttemptReused(root, { goal: prior.goal, attempt: prior.attempt, childId, reusedBy: `${goal}/${attempt}`, actor });
      } catch (e) {
        process.stderr.write(`[dsh-graph] attempt.reused 事件写入失败（已忽略，看板仍按绑定兜底）：${e?.message ?? e}\n`);
      }
    }
    return {
      root, goal, attempt, childId, bindingVersion, prior, actor, callerAgent, prompt, promptHash, contextDigest,
      modelRoute, mode, modeSource, injectedCards, injectedHandoffs, brief, briefSource, baselineCommit, baselineInfo,
      closeFailure: () => closeFailure,
    };
  };

  /**
   * g-613：投递复用提示词并结算（`force=false` 时任何不确定都 fail-closed）。
   *
   * 三条硬纪律：
   *  ① 只有宿主**受理**（返回 message id / {messageId}）才算已派发；超时按**不确定 = 未投递**处理；
   *  ② 投递失败的收尾**不调用 interrupt**：这个 child 可能本来就在替别的目标干活（主管自建子代理），
   *     中断它会误杀无关工作；只把本 attempt 结算为 child_error 并记 `attempt.reuse_failed`；
   *  ③ 受理 ≠ 开跑：返回体用 `delivery`/`started` 两个字段如实区分，禁止把「已投递」说成「已开始工作」。
   */
  const settleReuseDispatch = async (r, { signal, force }) => {
    const subagents = ctx.get?.("subagents");
    const base = {
      ok: true,
      attempt: r.attempt,
      child_id: r.childId,
      reused: true,
      child_error: null,
      model_route: r.modelRoute ?? null,
      mode: r.mode ?? null,
      mode_source: r.modeSource ?? null,
      injected_cards: r.injectedCards ?? [],
      injected_handoffs: r.injectedHandoffs ?? [],
      // 复用**不**创建工作树：工作位置隔离只在全新 spawn 时发生；且子代理的 cwd/权限沿用其创建时
      // 继承的父会话值（宿主实测），复用方**不能**在发送时切换 —— 如实回传而不是编一个 worktree。
      worktree: false,
      isolated: false,
      worktree_reason: "reused_child",
      worktree_created: false,
      worktree_reused: false,
      baseline_commit: r.baselineCommit ?? null,
      baseline_source: r.baselineInfo?.baseline_source ?? null,
      baseline_ref: r.baselineInfo?.baseline_ref ?? null,
      baseline_version: r.baselineInfo?.baseline_version ?? null,
      baseline_fallback_reason: r.baselineInfo?.baseline_fallback_reason ?? null,
      brief: r.brief ?? null,
      brief_source: r.briefSource ?? null,
      prompt: r.prompt ?? null,
      prompt_hash: r.promptHash ?? null,
      context_digest: r.contextDigest ?? null,
      prior_attempt: r.prior ? { goal: r.prior.goal, attempt: r.prior.attempt } : null,
      delivery: "not_attempted",
      started: false,
    };
    if (!subagents || typeof subagents.sendMessage !== "function") {
      const msg = "subagents.sendMessage 不可用：无法向既有子代理投递任务（fail-closed，未声称已开始工作）";
      if (r.closeFailure()) blankAttemptResults(r, msg);
      return { ...base, child_error: msg, delivery: "unavailable", note: msg };
    }
    // 投递：模型可见内容 = 完整 attempt 提示词（与全新派发的提示词同源、同格式）。
    let timer = null;
    try {
      const pending = subagents.sendMessage(
        r.callerAgent,
        r.childId,
        [{ type: "text", text: r.prompt }],
        { signal: signal ?? new AbortController().signal },
      );
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("投递超时"), { code: "REUSE_DELIVERY_TIMEOUT" })), REUSE_DELIVERY_TIMEOUT_MS);
        timer?.unref?.();
      });
      const receipt = await Promise.race([pending, timeout]);
      const messageId = typeof receipt === "string" ? receipt
        : (receipt && typeof receipt.messageId === "string" ? receipt.messageId : null);
      if (!messageId) {
        // 受理形态无法识别 ⇒ 不确定 ⇒ fail-closed（绝不把未知回执当成功）。
        throw Object.assign(new Error(`sendMessage 回执无法确认受理（${String(JSON.stringify(receipt)).slice(0, 120)}）`), { code: "REUSE_DELIVERY_TIMEOUT" });
      }
      return { ...base, delivery: "accepted", message_id: messageId, started: true, started_basis: "delivery_accepted" };
    } catch (e) {
      const timedOut = e?.code === "REUSE_DELIVERY_TIMEOUT";
      const code = timedOut ? "delivery_timeout" : "delivery_rejected";
      const detail = String(e?.message ?? e);
      process.stderr.write(`[dsh-graph-host] 复用投递失败（${code}，本次 attempt 已按未派发处理）：${detail}\n`);
      // 投递失败 ⇒ 本次 attempt 永远不会有子代理输出（host 可能已为本次复用起了一轮，但它跑的不是我们的任务），
      // 必须补写 child_error 占位（g-374 既有不变式：无子代理输出的 attempt 由派发处补齐占位摘要），
      // 否则工作区里「有 attempt、无任何结果文件」的孤儿记录无法被看板/摘要按同一规则解释。
      blankAttemptResults(r, `复用投递失败（${code}）：${detail}`);
      try {
        appendAttemptReuseFailed(root, { goal: r.goal, attempt: r.attempt, childId: r.childId, bindingVersion: r.bindingVersion, code, detail, actor: "system:dispatch" });
      } catch (evtErr) {
        process.stderr.write(`[dsh-graph] attempt.reuse_failed 事件写入失败（已忽略）：${evtErr?.message ?? evtErr}\n`);
      }
      return {
        ...base,
        // force=true（既有强制启动语义）时如实保留绑定，但仍**不**声称已开始工作。
        child_id: force ? r.childId : null,
        child_error: `复用投递${timedOut ? "不确定（超时）" : "被拒绝"}：${detail}（未确认投递 ⇒ 按未派发处理，不声称已开始工作）`,
        delivery: timedOut ? "timeout" : "rejected",
        started: false,
        note: "复用投递未确认：attempt 已结算为 child_error；未改动目标状态机，也未中断该子代理（避免误杀其原有工作）",
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  /** 复用结算的「无正文」占位 —— 复用路径**不得**登记 attempt↔child 归属。 */
  const blankAttemptResults = (r, note) => {
    try {
      writeChildErrorResults(r.root, r.goal, r.attempt, "system:dispatch", note);
    } catch (err) {
      process.stderr.write(`[dsh-graph] 复用占位摘要写入失败（已忽略）：${err?.message ?? err}\n`);
    }
  };

  // GUI 派发的子代理需要真实 parent Agent：startContinuable 内部强解引用 parent
  // 取 project.yaml supervisor.session 对应的 live Agent（AgentRegistry.get）；无则降级为仅本地建 attempt。
  const resolveSpawnParent = (rootForReq) => {
    try {
      const supervisorId = readSupervisorSession(rootForReq);
      if (!supervisorId) return { supervisorId: null, parent: null, error: "未配置 supervisor.session（project.yaml）——请先在该 workspace 运行 graph_claim_supervisor() 完成主管会话接管，再派发执行" };
      const agents = ctx.get?.("agents");
      const parent = agents?.get?.(supervisorId) ?? null;
      if (!parent) return { supervisorId, parent: null, error: `主管会话 ${supervisorId} 无 live Agent（可能未在运行）——请确认该主管会话已开启/在运行，或重新 graph_claim_supervisor()` };
      return { supervisorId, parent, error: null };
    } catch (e) {
      return { supervisorId: null, parent: null, error: String(e?.message ?? e) };
    }
  };

  // g-241：统一执行派发服务（工具与 HTTP 共享核心契约、准入、快照、路由与绑定）
  const dispatchExecutionAttempt = async ({
    root,
    workspace,
    goal,
    entrypoint, // "tool" | "http"
    actor,
    executor,
    parentAgent,
    parentSessionId,
    signal,
    attempt_brief,
    directive,
    task_type,
    baseline_commit,
    source_attempt,
    acceptance_items,
    provider,
    model,
    reasoning_effort,
    mode,
    worktree,
    force = false,
    child_id,
  }) => {
    if (!goal) throw new GraphError("missing goal");
    // g-613：可选 `child_id` —— 复用**空闲**专家子代理承接本目标。
    // 未传（undefined/null/空串）时 **完全不进入** 复用分支 ⇒ 全新 spawn 行为与 g-613 之前逐字等价。
    const reuseChildId = typeof child_id === "string" && child_id.trim() ? child_id.trim() : null;
    // 1. 契约规范化与校验
    if (attempt_brief !== undefined && attempt_brief !== null && typeof attempt_brief !== "string") {
      throw new GraphError("attempt_brief 必须是 string 类型");
    }
    const structuredFieldError = validateAttemptPromptFields({
      taskType: task_type,
      baselineCommit: baseline_commit,
      sourceAttempt: source_attempt,
      acceptanceItems: acceptance_items,
    });
    if (structuredFieldError) throw new GraphError(structuredFieldError);
    if (mode !== undefined && mode !== null && mode !== "") {
      if (typeof mode !== "string" || !normalizeSubagentMode(mode)) {
        throw new GraphError(`mode 只允许 ${SUBAGENT_MODES.join("/")}`);
      }
    }

    // 2. 执行准入门禁校验（g-237/g-241 协同）：启动 child 之前完成状态/判据/授权准入。
    //    拒绝时零副作用（不建 attempt、不启动子代理、不迁移），绝不允许先启动再吞掉迁移失败。
    //    g-378：只有 `graph_start_attempt` 工具入口要求目标描述非空（补写后重试即可）；
    //    HTTP 入口（GUI 拖拽/执行按钮）是既有人工强制启动路径，保持原行为不受影响。
    const admission = assertExecutionAdmission(root, goal, { force, requireDescription: entrypoint === "tool" });
    const { goalFile, doc } = admission;

    // 2.4 g-613：复用准入预检（**零副作用**、最早定位）：未通过 ⇒ 抛可读 GraphError，
    //     此刻尚未建树、未迁移、未建 attempt、未启动/投递任何东西。
    if (reuseChildId) inspectReuseChild(root, reuseChildId, parentAgent, { goal });

    // 2.5 g-473：工具能力自检（**最早**定位，零副作用）。
    //     缺必需工具（解析后的 shell / read / write / edit / graph_*）时不建 attempt、不建工作树、
    //     不迁移状态、不启动子代理 —— 只记 dispatch.capability_missing 事件并回传可读诊断。
    //     放在隔离决策之前（而非 provider 分支旁）是有意的：那一分支的既有语义已先建树，
    //     本自检不做「建完树再拒」的重复（避免遗留孤立 worktree）。
    const executorToolCap = toolCapabilityFor(parentAgent);
    const executorCapBlock = capabilityBlock(root, { goal, role: "executor", mode, agentScope: parentAgent, label: `executor/${goal}` });
    if (executorCapBlock) {
      return {
        ok: true,
        attempt: null,
        child_id: null,
        child_error: executorCapBlock,
        note: "派发前工具能力自检未通过：未建 attempt、未建工作树、未迁移状态、未启动子代理",
        mode: normalizeSubagentMode(mode) ?? DEFAULT_SUBAGENT_MODE,
      };
    }

    // 3. 一次性上下文快照（保证注入清单与注入内容一致，零二次读取漂移）
    //    小节标签按提示词语言本地化（仅影响 prompt 展示，goal.md 解析仍用中文小节名）。
    const promptLanguage = resolvePromptLanguage(readGraphSettings().promptLanguage, ctx);
    const isEnPrompt = promptLanguage === "en";
    const descRaw = sectionText(doc.body, "目标描述");
    const critRaw = sectionText(doc.body, "质量判据");
    const desc = descRaw ? descRaw.trim() : "";
    const crit = critRaw ? critRaw.trim() : (isEnPrompt ? "(no criteria)" : "（无判据）");
    // g-401：英文侧的两个框架小节标题（`## Goal description` / `## Quality criteria`）与用户材料
    // （描述/判据正文）同处一段 ⇒ 标题由本处拼装（不经反伪装，逐字保留），只对正文做反伪装。
    // 渲染器 en 分支据此按显式保留清单逐行保护本段（标题行原样、其余再保护一遍，幂等），
    // 于是「框架标题逐字不变」与「正文仍受保护」同时成立。zh 侧维持原样（整段在渲染期保护），产物逐字节不变。
    const targetContext = isEnPrompt
      ? ["## Goal description", protectPromptMarkers(desc || "(no description)", "en"), "", "## Quality criteria", protectPromptMarkers(crit, "en")].join("\n")
      : ["## 目标描述", desc || "（无描述）", "", "## 质量判据", crit].join("\n");

    // 4. 任务动作规范化（g-236/g-241 协同：brief 优先于 directive，三级回退，禁止静默空 action）
    const currentDirective = directive ?? readGoalDirective(root, goal);
    // g-402：把本次派发的提示词语言传进合成器 ⇒ auto_from_desc 前缀随语言取值（zh 逐字不变）。
    const resolvedBrief = resolveEffectiveBrief(attempt_brief, currentDirective, desc, promptLanguage);

    // g-447：把 **解析该图根所用的同一个 workspace** 传下去 ⇒ 卡片「精确路径」以实际解析出的图根为基准
    //（默认根 `.dsh-graph/…`；相对自定义根 `board-a/…`；工作区内绝对根按 workspace 相对展开），
    // 与同一 prompt 里 goalRel = relative(workspace, goalFile) 同一基准；不再硬拼 .dsh-graph 而误指默认根同名卡。
    const cards = harvestedCards(root, goal, workspace);
    const injectedCards = cards.map((c) => c.id);
    const cardsSection = formatHarvestedCardsSection(root, goal, undefined, cards, promptLanguage, workspace);

    const confirmedHandoffs = harvestReviewedAttemptHandoffs(root, goal);
    const injectedHandoffRefs = confirmedHandoffs.map((h) => ({
      id: h.id,
      revision: h.revision,
      source_attempts: h.source_attempts,
    }));
    const handoffsSection = formatReviewedAttemptHandoffsSection(root, goal, undefined, confirmedHandoffs, promptLanguage);

    const contextPayload = JSON.stringify({
      goal,
      title: doc.meta.title,
      desc,
      crit,
      cards: cards.map((c) => ({ id: c.id, digest: c.digest })),
      handoffs: injectedHandoffRefs,
      directive: currentDirective ?? null,
    });
    const contextDigest = createHash("sha256").update(contextPayload).digest("hex").slice(0, 16);
    const templateVersion = "v1";
    const contextVersion = doc.meta.rules_snapshot ?? doc.meta.version ?? "v1";

    // 5. 模型路由与模式解析（优先级：单次调用 > project.yaml > profile 全局 > 继承）
    const projectExec = readExecutorModel(root);
    const globalSettings = readGraphSettings();
    const eff = resolveModelRoute(
      { provider, model, reasoning_effort },
      projectExec,
      globalSettings,
    );
    const effProvider = eff.provider;
    const effModel = eff.model;
    const effReasoningEffort = eff.reasoning_effort;
    const effRoute = (effProvider || effModel) ? `${effProvider ?? "继承"}/${effModel ?? "继承"}` : null;
    const effModeRes = resolveSubagentMode(mode, projectExec.mode, globalSettings.subagentMode, promptLanguage, executorToolCap);

    // 6. 统一校验 subagent prepareContinuable 能力（g-241 判据 4：禁止回退虚构 spawn）
    const subagents = ctx.get?.("subagents");
    let availableProvider = null;
    let providerError = null;
    if (subagents) {
      ({ provider: availableProvider, error: providerError } = probeContinuableProvider(subagents));
    }

    // 7. Prompt 组装与 Prompt Hash
    const goalRel = goalFile ? relative(workspace, goalFile) : null;
    let gType = "task";
    try { gType = normalizeGoalType(doc.meta.type); } catch {}
    // g-289：根据集成分支/主工作树干净度增强默认隔离策略。
    // 干净度三分：clean=true（干净）/ clean=false（脏，可靠信号）/ clean=null（探测不可靠=unknown）。
    // 关键纪律：探测不可靠（unknown）绝不静默伪称 clean=true，也不凭空翻转为强制隔离；
    // 而是记录 cleanliness=unknown 与回退原因（fallback_to_type_default），仅在「可靠确认脏」时升级隔离。
    const cleanliness = detectWorkspaceCleanliness(workspace, undefined, root);
    if (cleanliness.clean === null) {
      process.stderr.write(
        `[dsh-graph-host] ℹ️ 工作树干净度 cleanliness=unknown（探测不可靠，未伪称干净）：${cleanliness.error}；` +
        `回退按类型默认（fallback_to_type_default），不静默改变默认隔离行为\n`,
      );
    } else if (cleanliness.clean === false) {
      process.stderr.write(
        `[dsh-graph-host] ⚠️ 检测到集成分支存在未提交改动（cleanliness=dirty），patch/chore/task 也将默认隔离：${cleanliness.dirtyReason}\n`,
      );
    }
    const isolationDecision = resolveWorktreeIsolationDecision(gType, worktree, cleanliness);
    const isWorktree = !reuseChildId && isolationDecision.isolate;
    const worktreeBlock = resolveWorktreeGuide(gType, isWorktree, promptLanguage);
    const subagentPromptSection = (() => {
      // g-333：单一消费者（结构化三态 + 遗留回落 + 全局回落），见 resolveSubagentPrompt。
      // g-390：**小节标题是插件内置文本**，按 promptLanguage 本地化；正文 p 是用户材料，逐字不动。
      // g-440：Agent Teams 最小契约——**默认 off**。off 时第四个实参为 null ⇒ 与 g-440 之前逐字一致
      //（diff=0）；on 时才把**独立契约资产**里定界的契约段追加进**同一**「子代理补充提示词」槽位
      //（不新造提示词拼装通道）。g-496：契约正文真源 = `prompts/agent-teams-contract.<lang>.md`
      // （从 discipline 迁出，主管每 turn 注入面不再常驻该段；抽取函数与门控逻辑一字未动）。
      // 降级是**诚实**的：资产缺契约块 / 宿主不支持扇出 / 已知深度 < 2
      // ⇒ 不注入且不报错；harness 未暴露「扇出能力 / 子代理深度」查询 ⇒ 如实传 null（未知），
      // 既不伪称支持也不伪称不支持，深度 < 2 的降级由执行者按契约文本在结果中如实登记。
      const teamsContract = (() => {
        let enabled = false;
        try {
          enabled = readProjectConfig(root)?.supervisor?.agent_teams === true;
        } catch {
          return null; // 配置不可读 ⇒ 按「未配置（off）」处理：不注入、不阻断派发。
        }
        const decision = resolveAgentTeamsInjection({
          enabled,
          contract: extractAgentTeamsContract(readPromptAsset("agent-teams-contract", promptLanguage)),
          supportsFanout: null,
          subagentDepth: null,
        });
        return decision.inject ? decision.contract : null;
      })();
      const p = resolveSubagentPrompt(root, globalSettings.subagentPrompt, teamsContract);
      return p ? [isEnPrompt ? "## dsh-graph subagent supplementary prompt (profile global / workspace override)" : "## dsh-graph 子代理补充提示词（profile 全局 / workspace 覆盖）", "", p].join("\n") : null;
    })();
    // g-390：模式标题 + 模式策略片段按 promptLanguage 本地化（片段语言由 resolveSubagentMode 的第 4 参传入）。
    const modeStrategySection = effModeRes.prompt ? [(isEnPrompt ? "## Subagent execution mode (" + effModeRes.mode + ")" : "## 子代理执行模式（" + effModeRes.mode + "）"), "", effModeRes.prompt].join("\n") : null;

    // g-610：门禁重查 → 预测 → 建树 → 迁移 → attempt 落盘 必须在同一把同步短锁内完成。
    // `dispatch_in_flight` 在 startAttempt 中同步落盘：第二个请求/进程即使先通过外层准入，
    // 进入锁后也必然看到“首次启动未结算”而拒绝；不同 goal/workspace 锁名不同，可并行。
    const reservation = withLocalLock(root, "execution-" + goal, () => {
      assertNoActiveExecutionChild(root, goal, { liveCheck: childLiveState, action: "派发执行", includeLocalActive: true });
      // 预测下一 attempt ID（用于 prompt 中精准渲染 attempt 编号）
      // g-414：预测是**只读**的——容忍 attempts/ 不存在（首次派发等价于空目录计数 ⇒ 仍得 att-001），
      // 绝不为「预测」预建目录。计数口径与 core startAttempt 的 `count(att-*)+1` 逐字一致；
      // 「计数+1 未加锁」是既有语义（并发下可能撞号），本目标不改变也不扩大它。
      const attemptsDir = join(dirname(goalFile), "attempts");
      let attemptEntries = [];
      try {
        attemptEntries = readdirSync(attemptsDir);
      } catch (e) {
        // 仅「目录不存在」视为 0 项；EACCES/ENOTDIR 等其它错误照旧抛出（不静默吞错）。
        if (e?.code !== "ENOENT") throw e;
      }
      const seq = attemptEntries.filter((d) => d.startsWith("att-")).length + 1;
      const nextAttId = `att-${String(seq).padStart(3, "0")}`;

      // 真实创建 / 幂等复用 / 失败即停（在状态迁移与创建 attempt 之前执行，失败即停零副作用）
      const wtResult = prepareAttemptWorktree(root, goal, nextAttId, {
        enabled: reuseChildId ? false : isWorktree,
        baselineCommit: baseline_commit,
        version: doc.meta.version ?? null,
        validateMainHead: !(reuseChildId && doc.meta.version),
        reason: reuseChildId ? "reused_child" : isolationDecision.reason,
      });
      if (reuseChildId) {
        // Only the host's live working-directory projection can establish the child's default cwd.
        // `get`, unlike `ensure`, is read-only and never repairs a missing directory.
        inspectReuseChild(root, reuseChildId, parentAgent, { goal });
        const live = liveChildAgent(reuseChildId);
        let cwd;
        try {
          const service = ctx.get?.("workingDirectory");
          if (!live.agent?.session || typeof service?.get !== "function") throw new Error("工作目录服务或会话不可用");
          const reported = service.get(live.agent.session);
          if (typeof reported !== "string" || !isAbsolute(reported)) throw new Error("cwd 未知或非绝对路径");
          cwd = realpathSync(reported);
          if (!statSync(cwd).isDirectory()) throw new Error("cwd 不是目录");
          const gitRead = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
          const common = (dir) => realpathSync(resolve(dir, gitRead(dir, ["rev-parse", "--git-common-dir"])));
          if (common(cwd) !== common(workspace)) throw new Error("child cwd 不属于目标仓库");
          if (gitRead(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]) !== wtResult.baseline_commit) throw new Error("child cwd HEAD 与基线不一致");
        } catch (e) {
          throw new GraphError(`无法验证复用 child 的实际工作目录与基线一致（${e?.message ?? e}），拒绝派发`);
        }
      }

      // g-414：建树已成功（失败已于上一行抛 GraphError ⇒ 此刻未迁移状态、未建 attempt、未启动子代理，
      // 且 attempts/ 尚未被创建 = 真正零副作用可重试）⇒ 此时才为后续写入准备目标 attempts/ 目录。
      // 位置必须早于真正写入 attempt 目录的时机（startAttempt 的 persist）。
      mkdirSync(attemptsDir, { recursive: true });

      // g-437 P1：**门禁③的区间锚点必须由引擎在派发时落盘**（引擎只信 attempt 记录，绝不信报告）。
      // 否则「报告把 baseline 取到自己的 HEAD」就能让 diff 恒为空（0 行 0 未跟踪）必然放行。
      // g-474：解析器给出已校验 SHA；复用树仅用持久化的原锚点，不能以当前 HEAD 冒充。
      // 非隔离时解析基线须与主工作树 HEAD 一致；无版本且不可取 HEAD 时保留 null。
      const engineBaselineCommit = wtResult.baseline_commit;

      // g-406：派发返回必须**可据以判定隔离**，否则 `worktree:false` 会把两种完全不同的
      // 情形混成同一个值：①解析为「本次不建树」（显式 worktree=false / 干净工作区下
      // patch/chore/task 的类型默认豁免）②建树失败——后者不存在静默降级：prepareAttemptWorktree
      // 失败一律抛 GraphError，此时尚未迁移状态、未建 attempt、未启动子代理（零副作用可重试）。
      // 故返回三件套：isolated（是否真的建了隔离树并据此启动子代理）、worktree_reason（为何如此，
      // 与 attempt 记录 / attempt.started 事件的 worktree_reason 同值）、created/reused（创建结果）。
      // 该对象在**同一同步临界区**内由 wtResult 求得，且下面的子代理启动晚于此（见 g-406 结构性守卫）。
      const isolationReport = {
        isolated: Boolean(wtResult.worktree),
        worktree_reason: wtResult.reason ?? null,
        worktree_created: Boolean(wtResult.created),
        worktree_reused: Boolean(wtResult.reused),
        // g-437 P1：落盘的区间锚点（fast_track 的 `machine_report.baseline_commit` 必须与之相等）。
        // null = 取不到锚点（非 Git 仓库等）⇒ 该 attempt 走不了 fast_track，如实回传而不是编一个值。
        baseline_commit: engineBaselineCommit ?? null,
        baseline_source: wtResult.baseline_source ?? null,
        baseline_ref: wtResult.baseline_ref ?? null,
        baseline_version: wtResult.baseline_version ?? null,
        baseline_fallback_reason: wtResult.baseline_fallback_reason ?? null,
      };

      const prompt = formatAttemptPrompt({
        goal,
        attempt: nextAttId,
        goalRel,
        attemptBrief: resolvedBrief.brief,
        briefSource: resolvedBrief.source,
        directive: currentDirective,
        taskType: task_type,
        baselineCommit: engineBaselineCommit,
        sourceAttempt: source_attempt,
        acceptanceItems: acceptance_items,
        handoffSection: handoffsSection,
        cardsSection,
        targetContext,
        subagentPromptSection,
        modeStrategySection,
        worktreeBlock,
        promptLanguage,
      });
      const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);

      // 8. g-237：真实迁移先于 attempt 与 child——准入已在第 2 步用同一套不变式预演通过。
      //    迁移失败直接抛出（工具报错 / HTTP 400）：此时尚未创建 attempt、未启动 child，
      //    零副作用可安全重试；绝不先启动子代理再把迁移失败吞掉。
      //    ensureExecutionInProgress 只对“并发下已 in_progress”做幂等放行，其它拒绝原样抛出。
      if (admission.needsTransition) {
        ensureExecutionInProgress(root, goal, {
          reason: `attempt 派发（${entrypoint === "tool" ? "graph_start_attempt" : "GUI 执行"}）`,
          actor,
          force,
        });
      }

      // 9. 创建并持久化 attempt 记录与 attempt.started 事件
      // g-289：将探测状态摘要（clean/dirty/unknown）落盘到 attempt metadata，与 worktree_reason 互补实现完整可观测性。
      const probeSummary = cleanliness.clean === true ? { state: "clean" }
        : cleanliness.clean === false ? { state: "dirty" }
        : { state: "unknown", error: cleanliness.error };
      const attempt = startAttempt(root, goal, {
        executor: executor ?? (entrypoint === "http" ? "agent:executor" : actor),
        actor,
        injectedCards,
        injectedHandoffs: injectedHandoffRefs,
        attemptBrief: resolvedBrief.brief ?? undefined,
        // g-251：来源与实际用在 prompt 里的 brief 同源，落进 attempt meta 与 attempt.started 事件
        briefSource: resolvedBrief.source,
        injectedDirective: currentDirective ?? undefined,
        provider: effProvider,
        model: effModel,
        modelRoute: effRoute,
        reasoningEffort: effReasoningEffort,
        mode: effModeRes.mode,
        modeSource: effModeRes.source,
        taskType: task_type,
        baselineCommit: engineBaselineCommit,
        baselineSource: wtResult.baseline_source,
        baselineRef: wtResult.baseline_ref,
        baselineVersion: wtResult.baseline_version,
        baselineFallbackReason: wtResult.baseline_fallback_reason,
        sourceAttempt: source_attempt,
        acceptanceItems: acceptance_items,
        templateVersion,
        promptHash,
        contextDigest,
        contextVersion,
        worktree: wtResult.worktree,
        worktreeReason: wtResult.reason,
        worktreeProbe: probeSummary,
        dispatchInFlight: true,
      });

      // g-613：复用路径在**同一同步临界区**内完成「重查空闲 → 独占 → 迁移 → 落 attempt → 绑定」，
      // 之后才回到异步世界投递提示词。这里提前返回复用收据（复用意图确定后不再走 spawn 分支）。
      if (reuseChildId) {
        return {
          reuse: buildReuseIntake(root, {
            goal,
            attempt,
            childId: reuseChildId,
            actor,
            parentSessionId,
            callerAgent: parentAgent,
            prompt,
            promptHash,
            contextDigest,
            modelRoute: effRoute,
            mode: effModeRes.mode,
            modeSource: effModeRes.source,
            injectedCards,
            injectedHandoffs: injectedHandoffRefs,
            brief: resolvedBrief.brief,
            briefSource: resolvedBrief.source,
            baselineCommit: engineBaselineCommit ?? null,
            baselineInfo: isolationReport,
          }),
        };
      }
      return { attempt, wtResult, isolationReport, prompt };
    }, { lockTimeoutMs: 5000 });
    const { attempt, wtResult, isolationReport, prompt } = reservation;
    // g-613：复用分支在此提前返回一个 Promise，不进入下方「建树 → 启动子代理」的同步临界区。
    //（结构性约束：该临界区内不得出现异步等待关键字，见 g-406 守卫 A。）
    if (reservation.reuse) return finishReuseDispatch(reservation.reuse, { signal, force });

    // 9. 启动与绑定子代理
    if (providerError) {
      try { settleAttemptDispatchInFlight(root, goal, attempt, { actor, error: `provider 探测失败：${providerError}` }); }
      catch (settleErr) { process.stderr.write(`[dsh-graph-host] settle dispatch_in_flight 失败（保持拒绝）：${settleErr?.message ?? settleErr}\n`); }
      // g-374 F1：child_error 占位（无 provider ⇒ 无子代理 ⇒ 永不产生 subagent/end）。
      writeChildErrorResults(root, goal, attempt, actor, `provider 探测失败：${providerError}`);
      return {
        ok: true,
        attempt,
        child_id: null,
        child_error: providerError,
        note: `subagent 派发失败（attempt 已本地创建）：${providerError}`,
        model_route: effRoute,
        mode: effModeRes.mode,
        mode_source: effModeRes.source,
        injected_cards: injectedCards,
        injected_handoffs: injectedHandoffRefs,
        worktree: wtResult.worktree,
        ...isolationReport,
        brief: resolvedBrief.brief,
        brief_source: resolvedBrief.source,
        prompt,
      };
    }

    if (subagents && parentAgent && availableProvider) {
      let spawnReceipt = null;
      try {
        const roleToolFilter = toolFilterForRole("executor", effModeRes.mode, executorToolCap, readModuleSwitchesForRoot(root));
        const agentOptions = {};
        if (effProvider) agentOptions.provider = effProvider;
        if (effModel) agentOptions.model = effModel;
        if (effReasoningEffort) agentOptions.reasoningEffort = effReasoningEffort;

        const started = await startSubagentCompat(subagents, {
          provider: availableProvider,
          label: `graph:${goal}/${attempt}`,
          parent: parentAgent,
          prompt: text(prompt),
          ...(roleToolFilter ? { toolFilter: roleToolFilter } : {}),
          ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
          signal,
        });
        spawnReceipt = started;

        try {
          bindAttemptChild(
            root,
            goal,
            attempt,
            started.childId,
            actor,
            parentSessionId ?? started.parentSessionId ?? null,
            effProvider,
            effModel,
            effRoute,
            effModeRes.mode,
            effModeRes.source,
            // g-610 rev-02：派发专用 CAS——晚到 bind 不得复活已取消/已解绑/已结算的记录。
            { dispatchInFlight: true, parentSessionId: parentSessionId ?? null },
          );
        } catch (bindErr) {
          // 绑定 CAS 冲突不自动中断真实 child（用户未授权的 intervention）；普通绑定失败才保留
          // 既有「请求中断」收敛（fire-and-forget，不作为停稳结论）。
          let interruptNote = "";
          if (!(bindErr instanceof GraphConflictError)) {
            // g-625：中断能力收口（rc.1 interruptByParent / rc.3 interruptByUser）；能力缺失如实上报。
            const parentSessionIdForInterrupt = parentAgent?.session?.id ?? parentSessionId ?? started.parentSessionId ?? null;
            const interruptOutcome = interruptChildCompat({ subagents }, {
              childId: started.childId,
              parentSessionId: parentSessionIdForInterrupt,
              parentAgent,
            });
            interruptNote = `，${interruptOutcome.note}`;
          } else {
            interruptNote = "，CAS 冲突未自动中断该 child";
          }
          throw new GraphError(
            `attempt 绑定失败（child ${started.childId} 已启动${interruptNote}）：${bindErr?.message ?? bindErr}`,
          );
        }

        // g-374 F1：登记归因（childId → attempt）——只在此 executor 派发点登记。
        indexChildAttempt(started.childId, { root, goal, attempt, actor });

        return {
          ok: true,
          attempt,
          child_id: started.childId,
          child_error: null,
          model_route: effRoute,
          mode: effModeRes.mode,
          mode_source: effModeRes.source,
          injected_cards: injectedCards,
          injected_handoffs: injectedHandoffRefs,
          worktree: wtResult.worktree,
          ...isolationReport,
          brief: resolvedBrief.brief,
          brief_source: resolvedBrief.source,
          prompt,
        };
      } catch (e) {
        // g-610 rev-02：
        //  - 已拿到 receipt（child 已真实启动）⇒ 绝不清 dispatch_in_flight；晚到/绑定失败保持阻断。
        //  - 无 receipt ⇒ 用公开 durable 子代理目录（g-625 收口：rc.1 `listChildren` /
        //    rc.3 `sessionQuery.subagentCatalog`）+ label 判定：确认无 child 才结算；
        //    目录不可用/查询失败/缺 catalog 投影 ⇒ 保持阻断（不按异常文案猜测“未创建 child”）。
        if (spawnReceipt?.childId) {
          process.stderr.write(`[dsh-graph-host] spawn 已返回 child=${spawnReceipt.childId} 但后续失败，保留 dispatch_in_flight：${e?.message ?? e}\n`);
        } else {
          let catalog = "unknown";
          if (parentSessionId) {
            let sessionQuery = null;
            try { sessionQuery = typeof ctx.get === "function" ? ctx.get("sessionQuery") : null; } catch { sessionQuery = null; }
            const probe = await readChildCatalogCompat({ subagents, sessionQuery }, parentSessionId);
            if (probe.ok) {
              catalog = probe.rows.some((r) => String(r?.label ?? "") === `graph:${goal}/${attempt}`) ? "present" : "absent";
            } else {
              process.stderr.write(`[dsh-graph-host] 子级目录不可用（${probe.reason}${probe.detail ? `：${probe.detail}` : ""}），保持 dispatch_in_flight：${e?.message ?? e}\n`);
            }
          }
          if (catalog === "absent") {
            try { settleAttemptDispatchInFlight(root, goal, attempt, { actor, error: String(e?.message ?? e) }); }
            catch (settleErr) { process.stderr.write(`[dsh-graph-host] settle dispatch_in_flight 失败（保持拒绝）：${settleErr?.message ?? settleErr}\n`); }
          } else {
            process.stderr.write(`[dsh-graph-host] spawn 失败但无法证明无 child（catalog=${catalog}），保留 dispatch_in_flight：${e?.message ?? e}\n`);
          }
        }
        // g-374 F1：child_error 占位（含 g-237 绑定失败收敛路径）。
        writeChildErrorResults(root, goal, attempt, actor, `subagent 派发失败：${e?.message ?? e}`);
        return {
          ok: true,
          attempt,
          child_id: null,
          // g-321：0.1.6 并发槽位耗尽（ACTIVATION_LIMIT_REACHED）给出可操作提示
          child_error: subagentSpawnErrorText(e),
          note: `subagent 派发失败（attempt 已本地创建）：${e?.message ?? e}`,
          model_route: effRoute,
          mode: effModeRes.mode,
          mode_source: effModeRes.source,
          injected_cards: injectedCards,
          injected_handoffs: injectedHandoffRefs,
          worktree: wtResult.worktree,
          ...isolationReport,
          brief: resolvedBrief.brief,
          brief_source: resolvedBrief.source,
          prompt,
        };
      }
    } else {
      try { settleAttemptDispatchInFlight(root, goal, attempt, { actor, error: "subagents 服务不可用或无调用 agent" }); }
      catch (settleErr) { process.stderr.write(`[dsh-graph-host] settle dispatch_in_flight 失败（保持拒绝）：${settleErr?.message ?? settleErr}\n`); }
      // g-374 F1：subagents 服务不可用 / 无调用 agent（此分支 child_error 恒 null，最易漏）。
      writeChildErrorResults(root, goal, attempt, actor, "subagents 服务不可用或无调用 agent");
      return {
        ok: true,
        attempt,
        child_id: null,
        child_error: null,
        note: "subagents 服务不可用或无调用 agent，attempt 仅本地创建",
        model_route: effRoute,
        mode: effModeRes.mode,
        mode_source: effModeRes.source,
        injected_cards: injectedCards,
        injected_handoffs: injectedHandoffRefs,
        worktree: wtResult.worktree,
        ...isolationReport,
        brief: resolvedBrief.brief,
        brief_source: resolvedBrief.source,
        prompt,
      };
    }
  };

  /**
   * g-613：复用路径的收尾（归因登记 → 投递 → 关照对账）。
   *
   * **必须定义在 `dispatchExecutionAttempt` 之外**（结构性要求）：派发函数内的「建树 → 启动子代理」
   * 必须处于同一同步临界区、中间不得有 await（g-406 守卫 A 只取证派发函数区域）。复用分支在
   * 解构后**提前 return** 到这里，投递 await 因此落在该取证区域之外，也不会插进建树与启动之间。
   */
  const finishReuseDispatch = async (r, { signal, force }) => {
    // 归因登记：只有**绑定成功后**才把该 child 的当前归属翻到本目标，并进入「投递未确认」窗口
    //（此时到达的 end 一律丢弃，见 isStaleOrUnconfirmedEnd）。
    indexChildAttempt(r.childId, {
      kind: "attempt", root: r.root, goal: r.goal, attempt: r.attempt, actor: r.actor,
      awaited: true, delivering: true, epoch: epochOf(r.childId),
    });
    const out = await settleReuseDispatch(r, { signal, force });
    // 投递确认后：清 awaited/delivering（此后到达的 end 才被允许写结果）。
    if (out.delivery === "accepted") {
      indexChildAttempt(r.childId, {
        kind: "attempt", root: r.root, goal: r.goal, attempt: r.attempt, actor: r.actor,
        awaited: false, delivering: false, epoch: epochOf(r.childId),
      });
    }
    careRuntime?.notifyReusedBinding?.(r.root, {
      goal: r.goal, attempt: r.attempt, child: r.childId, bindingVersion: r.bindingVersion,
      prior: r.prior ? { goal: r.prior.goal, attempt: r.prior.attempt, bindingVersion: r.prior.bindingVersion } : null,
      accepted: out.delivery === "accepted",
    });
    return out;
  };

  // ---- g-436：独立评审的统一派发服务（工具 graph_start_review 与 REST start-review 共用一套）----
  //
  // 与 dispatchExecutionAttempt 的分工**刻意不同**——评审是「既有执行 attempt 的附属记录」：
  //  - 不新建 attempt、不迁移目标状态、不写作者的 child_id/binding_token、不写 results-att-*.md；
  //  - **不新建工作树**（复用作者 attempt 已持久化的 worktree 路径；无隔离树时用调用方 workspace）；
  //  - 结论只按真实绑定的 reviewer child 身份在 subagent/end 归因结算（空输出/异常 ⇒ 不记 PASS）。
  // 身份真源：requestedBy 由调用点从真实执行身份取得（工具侧 ex.agent.session.id），
  // **不接受**调用者自报的 actor/role/child_id。

  /** 同 attempt + 同候选、且未失败的记录直接复用（重复点击不重复派发）。 */
  const REVIEW_REUSE_STATUSES = ["started", "bound", "completed"];

  /** 评审范围最多记录多少条变更路径（记录体量上限）。 */
  const REVIEW_MAX_CHANGED_PATHS = 500;

  /** 解析 Git commit：评审必须绑定**明确 commit**，拿不到就拒绝（绝不把不可解析的字符串当候选）。 */
  const gitResolveCommit = (cwd, ref, label) => {
    const raw = String(ref ?? "").trim();
    if (!raw) throw new GraphError(`${label} 必填且非空`);
    try {
      return execFileSync("git", ["rev-parse", "--verify", `${raw}^{commit}`], {
        cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      throw new GraphError(`无法解析${label}「${raw}」为 Git commit（需要可解析的 SHA/引用与可用的 Git 工作区）`);
    }
  };

  /** 审查范围（基线→候选的变更路径）。取不到时返回空数组——绝不因此让派发失败或伪造范围。 */
  const gitChangedPaths = (cwd, baseline, candidate) => {
    try {
      return execFileSync("git", ["diff", "--name-only", baseline, candidate], {
        cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
      }).split("\n").map((s) => s.trim()).filter(Boolean).slice(0, REVIEW_MAX_CHANGED_PATHS);
    } catch { return []; }
  };

  // g-436：评审派发的统一返回构造。
  // 措辞如实（F5）：这里是**行为字段映射**（缺省值 + 条件展开），**不是**手写白名单裁剪 ——
  // 工具入口直通本函数的返回值，`output.schema = {type:"object"}` 不做字段裁剪；HTTP 入口
  // 另行手工挑字段（见 /api/dsh-graph/start-review）。
  // F1：`stale` / `reused_current` / `current_candidate_sha` / `independent_ok` /
  // `independent_missing` 让「工具返回值」与「看板投影 `goalDetail.review_state`」**同源一致**，
  // 主管不必自己比对两处（A→B→A 复用场景此前两边说法相反）。注意返回值是**调用时刻的快照**：
  // 刚派发（评审尚未结束）时 `independent_missing=true` 表示「此刻没有已完成的独立评审」——
  // 与同一时刻的投影一致；评审结束后再查投影才翻为 false。
  const reviewOutcome = (o) => ({
    review_id: o.review_id,
    reused: o.reused === true,
    reused_current: o.reused_current !== false,
    stale: o.stale === true,
    goal: o.goal,
    source_attempt: o.source_attempt,
    candidate_sha: o.candidate_sha,
    baseline_sha: o.baseline_sha ?? null,
    review_workspace: o.review_workspace ?? null,
    changed_paths: Array.isArray(o.changed_paths) ? o.changed_paths : [],
    current_candidate_sha: o.current_candidate_sha ?? null,
    independent_ok: o.independent_ok === true,
    independent_missing: o.independent_missing === true,
    reviewer_child_id: o.reviewer_child_id ?? null,
    child_error: o.child_error ?? null,
    ...(o.status ? { status: o.status } : {}),
    ...(o.conclusion ? { conclusion: o.conclusion } : {}),
    ...(o.model_route ? { model_route: o.model_route } : {}),
    prompt: o.prompt ?? null,
  });

  const dispatchReview = async ({
    root,
    workspace,
    goal,
    attempt,
    candidate_commit,
    baseline_commit,
    guidance,
    requestedBy,
    actor,
    parentAgent,
    parentSessionId,
    signal,
    provider,
    model,
    reasoning_effort,
    mode,
  }) => {
    if (!goal) throw new GraphError("missing goal");
    if (!attempt) throw new GraphError("missing attempt");
    if (!requestedBy) throw new GraphError("missing requestedBy（真实调用身份）");
    const goalFile = findGoalFile(root, goal);
    if (basename(goalFile) !== "goal.md") {
      throw new GraphError(`暂存目标（backlog）没有目标目录，不能登记独立评审：${goal}`);
    }
    const attFile = join(dirname(goalFile), "attempts", String(attempt), "attempt.md");
    if (!existsSync(attFile)) throw new GraphError(`attempt 不存在：${attempt}（目标 ${goal}）`);
    const attMeta = loadGoal(attFile).meta ?? {};
    if (String(attMeta.executor ?? "") === "agent:collect") {
      throw new GraphError(`收集 attempt（agent:collect）不是执行 attempt，不能作为独立评审对象：${attempt}`);
    }
    const authorChildId = attMeta.child_id ? String(attMeta.child_id) : null;
    // 评审工作区：复用作者既有工作树（绝不新建评审树）；无隔离树时用调用方 workspace。
    const wt = attMeta.worktree;
    const reviewWorkspace = (wt && typeof wt === "object" && typeof wt.path === "string" && wt.path)
      ? wt.path
      : (workspace ?? dirname(root));
    const candidateSha = gitResolveCommit(reviewWorkspace, candidate_commit, "候选 commit");
    const baselineRaw = baseline_commit ?? attMeta.baseline_commit ?? null;
    const baselineSha = baselineRaw ? gitResolveCommit(reviewWorkspace, baselineRaw, "基线 commit") : null;
    const changedPaths = baselineSha ? gitChangedPaths(reviewWorkspace, baselineSha, candidateSha) : [];

    // 幂等：同一 attempt + 同一候选的未失败记录直接复用（结果与已派发时逐字一致）。
    const existing = reviewRecordViews(root, goal).find(
      (r) => r.source_attempt === String(attempt) && r.candidate_sha === candidateSha && REVIEW_REUSE_STATUSES.includes(r.status),
    );
    if (existing) {
      // F1 语义裁决①：复用 = 一次**新的评审请求** ⇒ 追加 review.reused 把该候选重新置为当前，
      // 投影随之回落（旧候选的兄弟记录转为 stale）。事件先行，审计留痕，绝不静默复活旧 PASS。
      appendReviewReused(root, {
        goalId: goal,
        reviewId: existing.review_id,
        candidateSha,
        requestedBy,
        actor,
      });
      const after = goalReviewState(root, goal);
      const refreshed = after.reviews.find((r) => r.review_id === existing.review_id) ?? existing;
      return reviewOutcome({
        review_id: existing.review_id,
        reused: true,
        reused_current: after.current_candidate_sha === candidateSha,
        stale: refreshed.stale,
        goal,
        source_attempt: String(attempt),
        candidate_sha: candidateSha,
        baseline_sha: baselineSha,
        review_workspace: reviewWorkspace,
        changed_paths: changedPaths,
        current_candidate_sha: after.current_candidate_sha,
        independent_ok: after.independent_ok,
        independent_missing: after.independent_missing,
        reviewer_child_id: refreshed.reviewer_child_id,
        status: refreshed.status,
        conclusion: refreshed.conclusion,
      });
    }

    // 材料包：只含目标定义+负责人约束、判据原文、候选/基线 SHA、审查范围与报告骨架；
    // 不注入作者对话/结果/自报 PASS/评论/返工叙事（见 formatReviewPrompt 的「评审材料边界」）。
    const detail = goalDetail(root, goal);
    const reviewerToolCap = toolCapabilityFor(parentAgent);
    const prompt = formatReviewPrompt({
      goalId: goal,
      attemptId: String(attempt),
      goalRel: relative(workspace ?? dirname(root), goalFile),
      goalTitle: detail.meta?.title ?? null,
      goalDescription: detail.description ?? null,
      criteria: Array.isArray(detail.criteria_items) ? detail.criteria_items : [],
      guidance: guidance ?? null,
      candidateSha,
      baselineSha,
      reviewWorkspace,
      changedPaths,
      language: resolvePromptLanguage(readGraphSettings().promptLanguage, ctx),
      // g-473：评审只读 shell 权限点名「本组合实际解析出的 shell」，不硬编码 bash。
      shellTool: resolveShellTool(reviewerToolCap).name,
    });
    const eff = resolveModelRoute(
      { provider, model, reasoning_effort },
      readExecutorModel(root),
      readGraphSettings(),
    );
    const effProvider = eff.provider;
    const effModel = eff.model;
    const effReasoningEffort = eff.reasoning_effort;
    const effRoute = (effProvider || effModel) ? `${effProvider ?? "继承"}/${effModel ?? "继承"}` : null;
    const effMode = normalizeSubagentMode(mode) ?? DEFAULT_SUBAGENT_MODE;

    // 事件先行：先落 review.dispatched + <goalDir>/reviews/<review_id>.md，再启动子代理。
    // 之后任何失败路径都收敛为 review.failed（绝不留下「进行中」假象，也绝不记 PASS）。
    const { review_id: reviewId } = appendReviewDispatch(root, {
      goalId: goal,
      sourceAttempt: String(attempt),
      candidateSha,
      baselineSha,
      reviewWorkspace,
      changedPaths,
      requestedBy,
      authorChildId,
      actor,
      provider: effProvider,
      model: effModel,
      modelRoute: effRoute,
      mode: effMode,
    });
    const dispatchedState = goalReviewState(root, goal);
    const base = {
      review_id: reviewId,
      reused: false,
      reused_current: true,
      stale: false,
      goal,
      source_attempt: String(attempt),
      candidate_sha: candidateSha,
      baseline_sha: baselineSha,
      review_workspace: reviewWorkspace,
      changed_paths: changedPaths,
      current_candidate_sha: dispatchedState.current_candidate_sha,
      independent_ok: dispatchedState.independent_ok,
      independent_missing: dispatchedState.independent_missing,
      model_route: effRoute,
      prompt,
    };

    const subagents = ctx.get?.("subagents");
    if (!subagents || !parentAgent) {
      const err = "subagents 服务不可用或无调用 agent";
      failReviewDispatch(root, goal, reviewId, err, actor);
      return reviewOutcome({ ...base, reviewer_child_id: null, child_error: err });
    }
    // g-473：能力自检（reviewer 必需 read + shell）——缺则记 review.failed 且**不派发**，
    // 而不是让 restrict() 在 Windows 上抛 `names unknown global tool` 把评审变成不可诊断的失败。
    const reviewerCapBlock = capabilityBlock(root, { goal, role: "reviewer", mode: effMode, agentScope: parentAgent, label: `reviewer/${goal}/${attempt}` });
    if (reviewerCapBlock) {
      failReviewDispatch(root, goal, reviewId, reviewerCapBlock, actor);
      return reviewOutcome({ ...base, reviewer_child_id: null, child_error: reviewerCapBlock });
    }
    try {
      const { provider: providerName, error: providerError } = probeContinuableProvider(subagents);
      if (!providerName) throw new Error(providerError);
      const toolFilter = toolFilterForRole("reviewer", effMode, reviewerToolCap, readModuleSwitchesForRoot(root));
      const agentOptions = {};
      if (effProvider) agentOptions.provider = effProvider;
      if (effModel) agentOptions.model = effModel;
      if (effReasoningEffort) agentOptions.reasoningEffort = effReasoningEffort;
      const started = await startSubagentCompat(subagents, {
        provider: providerName,
        label: `${REVIEW_LABEL_PREFIX}${goal}/${attempt}/${reviewId}`,
        parent: parentAgent,
        prompt: text(prompt),
        ...(toolFilter ? { toolFilter } : {}),
        ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
        signal,
      });
      try {
        bindReviewChild(root, goal, reviewId, started.childId, actor, {
          parentSessionId: parentSessionId ?? started.parentSessionId ?? null,
          provider: effProvider,
          model: effModel,
          modelRoute: effRoute,
          mode: effMode,
        });
      } catch (bindErr) {
        // 绑定失败必须收敛：中断刚启动的 child（g-625 收口），并把记录如实结算为 failed。
        const psid = parentAgent?.session?.id ?? parentSessionId ?? started.parentSessionId ?? null;
        const interruptOutcome = interruptChildCompat({ subagents }, { childId: started.childId, parentSessionId: psid, parentAgent });
        const note = `，${interruptOutcome.note}`;
        const msg = `reviewer 绑定失败（child ${started.childId}${note}）：${bindErr?.message ?? bindErr}`;
        failReviewDispatch(root, goal, reviewId, msg, actor);
        return reviewOutcome({ ...base, reviewer_child_id: started.childId, child_error: msg });
      }
      // 归因登记：只在这里登记——结论结算以该真实 child 身份为唯一凭据。
      indexReviewerChild(started.childId, { kind: "reviewer", root, goal, reviewId, actor });
      return reviewOutcome({ ...base, reviewer_child_id: started.childId, child_error: null });
    } catch (e) {
      const err = subagentSpawnErrorText(e);
      failReviewDispatch(root, goal, reviewId, `reviewer 派发失败：${err}`, actor);
      return reviewOutcome({ ...base, reviewer_child_id: null, child_error: err });
    }
  };

  /** @type {Array<{def: object, run: (args: any, exec: any) => any}>} */
  const tools = [
    {
      def: {
        name: "graph_create_goal",
        description: "创建目标（默认进 backlog；带 version 则排期入版本）。可选 type 指定类型（feature/bug/task/improvement/patch/chore，默认 task；patch/chore 为微小改动快速通道）。返回目标 id。",
        parameters: params({ title: str, version: str, type: str }, ["title"]),
      },
      run: (a, ex) => ({ goal: createGoal(rootFor(ex), { title: a.title, version: a.version, type: a.type, actor: actorOf(ex) }) }),
    },
    {
      def: {
        name: "graph_set_criteria",
        description: "登记目标的质量判据（判据先于执行；自动快照规则库版本）。",
        parameters: params({ goal: str, criteria: strArr }, ["goal", "criteria"]),
      },
      run: (a, ex) => { setCriteria(rootFor(ex), a.goal, a.criteria, actorOf(ex)); return { ok: true }; },
    },
    {
      def: {
        name: "graph_transition",
        description: "目标状态迁移。状态机与不变式由核心层强制；进 blocked 必须给 reason。",
        parameters: params({ goal: str, to: str, reason: str }, ["goal", "to"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        // g-436：复核子代理身份不得把目标直接推进 delivered（Human Gate 归于主管/负责人）。
        if (String(a.to) === "delivered") {
          assertNotReviewerIdentity(r, [ex?.agent?.id, ex?.agent?.session?.id], "graph_transition(to=delivered)");
        }
        transition(r, a.goal, a.to, { reason: a.reason, actor: actorOf(ex) });
        return { ok: true };
      },
    },
    {
      def: {
        name: "graph_add_card",
        description: "为目标创建上下文卡片（empty 占位）。返回卡片 id。默认创建共享卡（scope=shared，落共享池并挂到该 goal）；goal 自有卡必须显式传 scope=\"goal\"。卡片统一为正文 + 可选附件引用（@att/<name>），kind 仅为兼容读取字段、可不传、不限定类型。",
        parameters: params(
          { goal: str, title: str, kind: str, scope: { type: "string", enum: ["goal", "shared"] } },
          ["goal", "title"],
        ),
      },
      run: (a, ex) => ({ card: addCard(rootFor(ex), a.goal, { title: a.title, kind: a.kind, scope: a.scope, actor: actorOf(ex) }) }),
    },
    {
      def: {
        name: "graph_store_attachment",
        description: "存储一个上下文附件到项目根 .dsh-graph/attachments/（可含安全子目录），返回稳定引用名（用 @att/<相对引用名> 在卡片正文/goal.md 引用）。文本用 content；二进制/图片/Excel 用 base64。name 拒绝绝对路径、./.. 穿越、反斜杠、NUL；目标已存在且内容不同会生成唯一名（不覆盖）；异常不留半文件。",
        parameters: params({ name: str, content: str, base64: str }, ["name"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        const name = storeAttachment(r, { name: a.name, content: a.content, base64: a.base64, actor: actorOf(ex) });
        return { name, ref: formatAttachmentRef(name), digest: attachmentInfo(r, name).digest ?? null };
      },
    },
    {
      def: {
        name: "graph_delete_attachment",
        description: "显式删除附件；仍被任何卡片/目标正文引用的附件禁止删除（解除/删除卡片不误删仍被引用的附件）。",
        parameters: params({ name: str }, ["name"]),
      },
      run: (a, ex) => { deleteAttachment(rootFor(ex), a.name, { actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_fill_card",
        description: "填充上下文卡片（正文 + 可选附件引用）。text 写卡片正文全文；正文与 goal.md 里用 @att/<相对引用名> 引用附件。summary 是一句话要点式摘要（≤100 字左右），细节写进 text。content_ref 仅为兼容读取字段。",
        parameters: params({ goal: str, card: str, text: str, content_ref: str, summary: str }, ["goal", "card"]),
      },
      run: (a, ex) => { fillCard(rootFor(ex), a.goal, a.card, { text: a.text, contentRef: a.content_ref, summary: a.summary, by: actorOf(ex), actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_review_card",
        description: "复核已填充的上下文卡片（filled → reviewed）。",
        parameters: params({ goal: str, card: str }, ["goal", "card"]),
      },
      run: (a, ex) => { reviewCard(rootFor(ex), a.goal, a.card, { by: actorOf(ex), actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      // g-128：删除上下文卡片（删文件 + 移除 context_cards 引用 + 记 card.deleted 事件，事件先行 R-02）
      // g-501：①零引用共享卡可直接删除（非零引用仍严格拒绝，避免删掉其他 goal 在用的实体）；
      //        ②本工具**不受任何 harness 模块开关管理** ⇒ 会话内 shared_cards:false 关闭时它仍在可见
      //          工具面内，故新增 detach_only 开关作为「保底解除引用」通道（不依赖被裁剪的共享池工具）。
      def: {
        name: "graph_delete_card",
        description: "删除目标的上下文卡片（删卡片文件 + context_cards 移除引用 + 记 card.deleted 事件，事件先行 R-02）。正在收集中的卡片（status=collecting）不可删除。零引用的共享卡可直接删除；非零引用共享卡严格拒绝（请先解除引用）。detach_only=true 时只解除引用不删除（卡本体保留共享池），用于 shared_cards 模块关闭、无共享池工具时的保底解引用。",
        parameters: params({ goal: str, card: str, detach_only: bool }, ["goal", "card"]),
      },
      run: (a, ex) => {
        const root = rootFor(ex);
        if (a.detach_only === true) {
          // g-501：保底解除引用——与 graph_detach_shared_card 同一 ops 路径与鉴权口径
          //（owner/主管；先鉴权后调用 ⇒ 拒绝零副作用），只是入口不被模块开关裁剪。
          const actor = unbindActorOf(ex, root);
          authorizeSharedCardLink(root, actor, goalCreatedBy(root, a.goal));
          const refCount = detachSharedCardRef(root, a.goal, a.card, actor);
          return { ok: true, card: a.card, detached: true, refCount };
        }
        const res = deleteCard(root, a.goal, a.card, { actor: actorOf(ex) });
        return { ok: true, card: res.card, scope: res.scope, refCount: res.refCount };
      },
    },
    {
      // g-304：将 goal 自有卡转换为共享卡（封装 convertOwnedToShared）。
      def: {
        name: "graph_convert_card_to_shared",
        description: sT("tool.graph_convert_card_to_shared"),
        parameters: params({ goal: str, card: str }, ["goal", "card"]),
      },
      run: (a, ex) => { convertOwnedToShared(rootFor(ex), a.goal, a.card, { actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      // g-304：将共享卡转换回 goal 自有卡（封装 convertSharedToOwned）。
      def: {
        name: "graph_convert_card_to_owned",
        description: sT("tool.graph_convert_card_to_owned"),
        parameters: params({ goal: str, card: str }, ["goal", "card"]),
      },
      run: (a, ex) => { convertSharedToOwned(rootFor(ex), a.goal, a.card, { actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      // g-369：把共享池中既有共享卡挂载到另一个目标（复用已收集的上下文，与「创建时即成共享」互补）。
      // 授权复用 authorizeSharedCardLink（与解绑同口径的 owner/主管模型），先鉴权后调用 ops ⇒ 拒绝零副作用；
      // 事件 actor 用 unbindActorOf 映射（主管会话 → supervisor:<sid>）。ops.addSharedCardRef 原生幂等。
      def: {
        name: "graph_attach_shared_card",
        description: sT("tool.graph_attach_shared_card"),
        parameters: params({ goal: str, card: str }, ["goal", "card"]),
      },
      run: (a, ex) => {
        const root = rootFor(ex);
        const actor = unbindActorOf(ex, root);
        authorizeSharedCardLink(root, actor, goalCreatedBy(root, a.goal));
        addSharedCardRef(root, a.goal, a.card, actor);
        return { ok: true, card: a.card, refCount: referenceCount(root, a.card) };
      },
    },
    {
      // g-369：解除目标对共享卡的引用（卡本体保留在共享池，零引用也不删除）。
      def: {
        name: "graph_detach_shared_card",
        description: sT("tool.graph_detach_shared_card"),
        parameters: params({ goal: str, card: str }, ["goal", "card"]),
      },
      run: (a, ex) => {
        const root = rootFor(ex);
        const actor = unbindActorOf(ex, root);
        authorizeSharedCardLink(root, actor, goalCreatedBy(root, a.goal));
        removeSharedCardRef(root, a.goal, a.card, actor);
        return { ok: true, card: a.card, refCount: referenceCount(root, a.card) };
      },
    },
    {
      // g-369：只读列出共享池（供主管组装新目标/并行目标时挑选可复用的共享卡）。
      // 只投影 id/title/status/refs——sharedCards() 每项含 content（全文正文）、attachments 与
      // cardFile（绝对路径），裸返会灌 token 并泄露绝对路径。不鉴权（只读）。
      def: {
        name: "graph_list_shared_cards",
        description: sT("tool.graph_list_shared_cards"),
        parameters: params({}, []),
      },
      run: (a, ex) => ({
        cards: sharedCards(rootFor(ex)).map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          refs: (c.referencingGoals ?? []).map((g) => g.id),
        })),
      }),
    },
    {
      // g-150：主管登记 attempt handoff（返工约束、前序失败、推荐基线、验收命令）。
      // 只有已 claim 的 supervisor 或负责人应调用；写入 handoff 文件 + 追加确认事件。
      def: {
        name: "graph_record_attempt_handoff",
        description: "主管/负责人登记前序 attempt 的返工 handoff：记录已核实失败、返工约束（禁止项）、推荐基线/保留项与验收命令。每个 goal 仅一个 handoff，新登记覆盖旧内容；旧历史由事件流保留。source_attempts 必须属于该 goal。",
        parameters: params(
          {
            goal: str,
            source_attempts: strArr,
            failures: str,
            constraints: str,
            baseline: str,
            verification: str,
          },
          ["goal", "source_attempts", "failures", "constraints", "baseline", "verification"],
        ),
      },
      run: (a, ex) => {
        // g-150 review 问题 1：确认身份必须由可信上下文推导，不可用 caller 提供的任意 actor
        // 优先使用 supervisor session id（如果已配置且当前会话是 supervisor），
        // 否则使用 human:gui（负责人 GUI 操作）或 agent:<id> 兜底
        const r = rootFor(ex);
        const supervisorSession = readSupervisorSession(r);
        const currentSessionId = ex?.agent?.session?.id;
        let confirmedBy;
        if (supervisorSession && currentSessionId === supervisorSession) {
          confirmedBy = `supervisor:${currentSessionId}`;
        } else if (currentSessionId) {
          // 非 supervisor 会话但有 session id——使用 agent 格式（core 层会校验）
          confirmedBy = `agent:${currentSessionId}`;
        } else {
          // 无 session 信息（如 GUI 操作无 agent）——默认 human:gui
          confirmedBy = "human:gui";
        }
        const hfId = recordAttemptHandoff(r, a.goal, {
          source_attempts: a.source_attempts,
          failures: a.failures,
          constraints: a.constraints,
          baseline: a.baseline,
          verification: a.verification,
          confirmed_by: confirmedBy,
          actor: actorOf(ex),
        });
        return { ok: true, handoff: hfId };
      },
    },
    {
      // g-150：设置/替换目标的「最近指令」——下一次 attempt 生效的补充任务、边界和验收。
      // 写入 goal.md 的 `## 最近指令` 小节 + 追加 goal.directive_set 事件（事件先行）。
      def: {
        name: "graph_set_directive",
        description: "设置/替换目标的「最近指令」：写下一次 attempt 生效的补充任务、边界和验收。写入 goal.md 的「最近指令」小节并追加事件；新 attempt 派发时自动读取注入初始 prompt。directive 为空字符串时清空指令。",
        parameters: params({ goal: str, directive: str }, ["goal", "directive"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        setGoalDirective(r, a.goal, a.directive, actorOf(ex));
        return { ok: true, goal: a.goal };
      },
    },
    {
      // g-260：设置/替换目标的「目标描述」——就地编辑描述内容。
      // 写入 goal.md 的 `## 目标描述` 小节 + 追加 goal.description_set 事件（事件先行）。
      def: {
        name: "graph_set_description",
        description: "设置/替换目标的「目标描述」：就地编辑目标描述内容。写入 goal.md 的「目标描述」小节并追加事件；仅改描述小节正文，frontmatter 与其他小节字节级不变。description 为空字符串时清空描述。",
        parameters: params({ goal: str, description: str }, ["goal", "description"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        setGoalDescription(r, a.goal, a.description, actorOf(ex));
        return { ok: true, goal: a.goal };
      },
    },
    {
      // g-380：目标间关系标记（可增可删）——本目标**唯一**新增的 graph_* 工具（计数 49 → 50）。
      // 内部复用 g-379 既有 addRelation/removeRelation（禁止第二套关系写入实现）：单一真源仍是
      // goal frontmatter 的 meta.relations，派生视图不双写、不旁路 validate。
      // type 闭集 = supersedes/amends/extends/related；depends_on 的权威存储是 meta.depends_on，
      // 本工具一律拒绝（中文文案指向 meta.depends_on），绝不写进 relations。
      // 写入前用 core 的唯一 DFS 做替代环探测（host 侧不另造环检测实现）。
      def: {
        name: "graph_set_relation",
        description: "标记/解除目标间关系：action=add|remove；type 限 supersedes/amends/extends/related；target 为对端目标 id。只写 goal frontmatter 的 meta.relations，幂等。depends_on 请改用 meta.depends_on（本工具拒绝）；会形成替代环的标记被拒绝。",
        parameters: params({ goal: str, action: str, type: str, target: str }, ["goal", "action", "type", "target"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        const from = String(a.goal ?? "").trim();
        const target = String(a.target ?? "").trim();
        const type = String(a.type ?? "").trim();
        const action = String(a.action ?? "").trim();
        if (action !== "add" && action !== "remove") {
          throw new GraphError(
            `graph_set_relation：action 非法（${JSON.stringify(a.action ?? null)}）——只能是 "add"（建立标记）或 "remove"（解除标记）`,
          );
        }
        // depends_on 的唯一权威存储是 meta.depends_on：先于闭集检查给出指向性文案
        if (type === "depends_on") throw new GraphError(dependsOnNotInRelationsError(from));
        if (!RELATIONS_FIELD_TYPES.includes(type)) {
          throw new GraphError(
            `graph_set_relation：type 非法（${JSON.stringify(a.type ?? null)}）——闭集：${RELATIONS_FIELD_TYPES.join(" / ")}；depends_on 请改用 meta.depends_on 字段`,
          );
        }
        // 环检测：复用 core 唯一 DFS（只用新增的 supersedes/amends 边判环；extends/related 允许互引）
        if (action === "add") {
          const cycle = relationCycleProblem(r, { from, type, goal: target });
          if (cycle) {
            throw new GraphError(
              `${cycle}——该标记会形成替代环，已拒绝写入；请先解除环上的一条 supersedes/amends，或改用 extends/related`,
            );
          }
        }
        const mutate = action === "add" ? addRelation : removeRelation;
        const result = mutate(r, { from, type, goal: target, actor: actorOf(ex) });
        return {
          ok: true, action, goal: result.from, type: result.type, target: result.goal,
          changed: result.changed, relations: result.relations,
        };
      },
    },
    {
      // g-150：向目标的「评论」小节追加一条可追溯的历史讨论/反馈。
      // 不自动注入 prompt，执行者可通过目标文件查看。事件先行。
      def: {
        name: "graph_add_comment",
        description: "向目标的「评论」小节追加一条可追溯的历史讨论/反馈。评论不自动注入执行 prompt，但执行者可通过 goal.md 查看历史。事件先行。",
        parameters: params({ goal: str, text: str }, ["goal", "text"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        appendGoalComment(r, a.goal, a.text, actorOf(ex));
        return { ok: true, goal: a.goal };
      },
    },
    {
      // g-374 F4：无子代理的轻量改动（chore/patch、一两行修改、文档/看板数据修订）必须也有结果面。
      // 主管自己做完成摘要 ⇒ 与 F1 自动截获**同一写入器**（同格式/同路径/同覆盖策略），零 LLM 调用。
      def: {
        name: "graph_write_results",
        description: "写入一次 attempt 的完成摘要（<goalDir>/results-att-<attempt>.md）：主管/用户在**无子代理**的轻量改动（chore/patch、文档或看板数据修订）后主动补写，避免结果真空。与自动截获同一写入器/路径/格式，零 LLM（纯文本落盘），文件头标注 source（默认 manual）与写入者；重复调用为 last-wins 覆盖。attempt 必须真实存在。",
        parameters: params({ goal: str, attempt: str, text: str, source: str, actor: str }, ["goal", "attempt", "text"]),
      },
      run: (a, ex) => {
        if (!a.goal || !a.attempt) throw new GraphError("graph_write_results 缺参：需要 goal/attempt/text");
        if (typeof a.text !== "string" || !a.text.trim()) throw new GraphError("graph_write_results：text 不能为空（空文本请改用自动截获的占位路径）");
        const r = rootFor(ex);
        // 一一对应不变式（判据 3）：`results-<attempt>.md` 只对**真实存在的 attempt** 写入，
        // 不制造孤儿结果文件；无 attempt 的轻量改动走 graph_refresh_results（results.md）。
        const goalFile = findGoalFile(r, a.goal);
        if (basename(goalFile) !== "goal.md") throw new GraphError(`暂存目标（backlog）没有目标目录，无法写完成摘要：${a.goal}`);
        if (!existsSync(join(dirname(goalFile), "attempts", a.attempt, "attempt.md"))) {
          throw new GraphError(`attempt 不存在：${a.goal}/${a.attempt}（不制造孤儿结果文件）；无 attempt 的轻量改动请用 graph_refresh_results 刷新 results.md`);
        }
        const res = writeAttemptResults(r, {
          goal: a.goal,
          attempt: a.attempt,
          source: typeof a.source === "string" && a.source.trim() ? a.source : "manual",
          childId: null,
          stopReason: null,
          text: a.text,
          actor: typeof a.actor === "string" && a.actor.trim() ? a.actor : actorOf(ex),
        });
        if (!res.written) throw new GraphError(`graph_write_results 写入失败：${res.reason ?? "unknown"}`);
        return { ok: true, ...res };
      },
    },
    {
      // g-374 F2/F3：从目标历史零 LLM 重写 results.md（旧版归档）+ 批量。UI「更新摘要」按钮走同一实现。
      def: {
        name: "graph_refresh_results",
        description: "重写 <goalDir>/results.md 完成摘要；旧版先归档为 results-archive-*.md（保留历史，不删不覆盖）。写入器自身零 LLM：①`llm:true` 派 summarizer 子代理写正文（source=llm，按 source_hash 缓存，`force:true` 强制重来，失败降级 source=deterministic）；②省略 content/llm 则零 LLM 从目标历史拼装；③传 content 用调用方正文（source=manual）；④支持单目标 goal 或批量 goals[]。**主管自做 chore/patch 等无子代理改动后应主动调用**。细则见 help(topic=\"usage\")。",
        parameters: params({ goal: str, goals: strArr, content: str, source: str, llm: { type: "boolean" }, force: { type: "boolean" }, actor: str }, []),
      },
      run: (a, ex) => {
        const list = [];
        if (typeof a.goal === "string" && a.goal.trim()) list.push(a.goal.trim());
        if (Array.isArray(a.goals)) for (const g of a.goals) if (typeof g === "string" && g.trim()) list.push(g.trim());
        const targets = [...new Set(list)];
        if (targets.length === 0) throw new GraphError("graph_refresh_results 缺参：需要 goal（单目标）或 goals[]（批量）");
        const r = rootFor(ex);
        const actor = typeof a.actor === "string" && a.actor.trim() ? a.actor.trim() : actorOf(ex);
        // g-374 F5：按需调用 LLM——只在调用方**显式** llm:true 时派 summarizer 子代理。
        // 绝不挂在派发/结算/截获路径上自动调用；批量逐目标独立，单目标失败/降级不牵连其它目标。
        if (a.llm === true) {
          if (typeof a.content === "string" && a.content.trim()) {
            throw new GraphError("graph_refresh_results：llm 与 content 不能同时使用（content 已是成品正文，不需要再调 LLM）");
          }
          // LLM 分支是唯一的异步路径：返回 Promise（宿主 await）；确定性路径保持同步返回，
          // 免得既有同步调用方（批量/测试/内部复用）被迫改成 async。
          return (async () => {
          const items = [];
          for (const g of targets) {
            try {
              const cache = goalResultsCacheState(r, g);
              if (cache.cache_hit && a.force !== true) {
                items.push({
                  goal: g, ok: true, status: "cached", source: cache.source, cached: true,
                  file: cache.file, source_hash: cache.source_hash, content_hash: cache.content_hash,
                });
                continue;
              }
              const spawned = await startSummarizerChild(r, g, { parent: ex?.agent, signal: ex?.signal }, { actor });
              if (spawned.error) {
                const fb = refreshGoalResults(r, g, { actor, fallbackReason: `llm-unavailable: ${spawned.error}` });
                items.push({
                  goal: g, ok: fb.written, status: fb.written ? "written" : "failed", fallback: true,
                  source: fb.source, fallback_reason: fb.fallback_reason, child_error: spawned.error,
                  file: fb.file, archive: fb.archive, reason: fb.reason,
                });
                continue;
              }
              items.push({
                goal: g, ok: true, status: "pending", source: "llm", child_id: spawned.childId,
                model_route: spawned.model_route ?? null, file: goalResultsSummaryFile(findGoalFile(r, g)),
              });
            } catch (e) {
              items.push({ goal: g, ok: false, status: "failed", reason: String(e?.message ?? e) });
            }
          }
          const n = (s) => items.filter((i) => i.status === s).length;
          return {
            ok: n("failed") === 0, total: items.length, llm: true,
            written: n("written"), pending: n("pending"), cached: n("cached"),
            skipped: n("skipped"), failed: n("failed"),
            items,
          };
          })();
        }
        // content：调用方（专用摘要子代理 / 人工）产出的正文；批量时同一份 content 用于所有目标无意义，
        // 故 content 只允许与单目标 goal 同用（批量必须逐目标各自调用，避免把同一正文写到多个目标）。
        const content = typeof a.content === "string" && a.content.trim() ? a.content : null;
        const source = typeof a.source === "string" && a.source.trim() ? a.source.trim() : null;
        if (content && targets.length > 1) {
          throw new GraphError("graph_refresh_results：content 只能与单目标 goal 同用（批量摘要请逐目标分别调用，避免同一正文覆盖多个目标）");
        }
        // 逐目标独立：任一目标失败/跳过都不影响其余目标（批量可审计）。
        const items = targets.map((g) => {
          try {
            const res = refreshGoalResults(r, g, { actor, content, source });
            // 外部正文（专用摘要子代理的 LLM 正文 / 人工手写）已落盘 ⇒ 标记，免得该 child 结束时降级覆盖。
            if (res.written && content) markSummarizerLanded(g);
            const reason = String(res.reason ?? "");
            const status = res.written
              ? "written"
              : (/^(error|tx-|write-failed)/.test(reason) ? "failed" : "skipped");
            return {
              goal: g, ok: res.written, status, source: res.source,
              file: res.file, archive: res.archive, reason: res.reason,
              bytes: res.bytes, truncated: res.truncated, source_hash: res.source_hash,
              generated_at: res.generated_at, sources: res.sources,
            };
          } catch (e) {
            return { goal: g, ok: false, status: "failed", file: "", reason: String(e?.message ?? e) };
          }
        });
        const count = (s) => items.filter((i) => i.status === s).length;
        return {
          ok: count("failed") === 0, total: items.length,
          written: count("written"), skipped: count("skipped"), failed: count("failed"),
          items,
        };
      },
    },
    {
      // g-119：supervisor 侧把已派发的收集子代理绑定到上下文卡片（此前只有 GUI 的
      // /api/dsh-graph/start-collection 端点走 bindCardChild，主管只能写 tmp 探针脚本 hack）
      def: {
        name: "graph_bind_collect_card",
        description: "把已派发的收集子代理绑定到上下文卡片：写 child_id/parent_session_id、置 status=collecting，并记 card.collecting 事件（事件先行，R-02）。parent_session_id 缺省取当前会话 id（子代理会话文件头 parentSession 为权威来源，需不一致时显式传入）；重复绑定同一 child 幂等（不重复记事件）。",
        parameters: params({ goal: str, card: str, child_id: str, parent_session_id: str, provider: str, model: str }, ["goal", "card", "child_id"]),
      },
      run: (a, ex) => {
        if (!a.goal || !a.card || !a.child_id) {
          throw new Error("graph_bind_collect_card 缺参：需要 goal/card/child_id（parent_session_id 可选）");
        }
        const parentSessionId = a.parent_session_id ?? ex?.agent?.session?.id ?? null;
        bindCardChild(rootFor(ex), a.goal, a.card, {
          childId: a.child_id,
          parentSessionId,
          actor: actorOf(ex),
          provider: a.provider ?? null,
          model: a.model ?? null,
        });
        const out = { ok: true, card: a.card, child_id: a.child_id, parent_session_id: parentSessionId };
        if (a.provider) out.provider = a.provider;
        if (a.model) out.model = a.model;
        return out;
      },
    },
    {
      // g-118：dsh-graph help 命令——输出**功能模块清单 + 当前开关状态** + supervisor 接管（claim）指引。
      // 与引导提示词（systemPrompt section GUIDE_HINT）呼应：提示词告知 help 命令存在，
      // help 给出模块清单与换会话步骤。不含主管守则（完整守则走 skill 显式调用）。
      // g-493：新增**可选** topic —— 让使用说明/图工程点题章节可被按名查询（也是可被守卫断言
      // 的机械真源）。省略 topic 时**逐字返回整份资产**（g-347 的端到端断言不变）。
      // g-495（负责人 2026-10-13 裁定）：help 改为 **agent 面向的渐进式披露** ——
      //   · 删去 51 条逐工具参数速查（与 harness 注入的工具定义重复），只留①一句用途
      //     ②功能模块清单（名/作用/**当前开关状态**）③接管指引；
      //   · `topic` 的工具名分支**删除**（选 (c)：schema 注入已提供足够信息，没必要按工具名查），
      //     `topic` 只认 `usage` / `graph_engineering` / **模块名**；未知名（含工具名）⇒ 全文 + `found=false`；
      //   · 「当前开启哪些模块」取**既有只读投影** `readModuleSwitchesForRoot`（g-480 的
      //     `resolveModuleSwitches` 单一真源），**不**另接 GUI 用的 `moduleSwitchPayload`；
      //     读失败一律按**全开**（fail-safe，与 g-480 同口径）。
      // 本工具仍是**只读**：开关状态只影响渲染文本，不写配置、不改注册面（51 个工具照常注册）。
      def: {
        name: "graph_help",
        description: "输出 dsh-graph 功能模块清单（各模块作用 + 当前开关状态）与 supervisor 接管（claim）指引（graph_handoff/graph_claim_supervisor 换会话步骤）；可选 topic 查询单个主题（usage / graph_engineering / 某个模块名）。topic=usage 返回完整使用说明（含工具细则、签名、证据分层），不只是文首一句。",
        parameters: params({ topic: str }, []),
      },
      run: (a, ex) => {
        const language = resolvePromptLanguage(readGraphSettings().promptLanguage, ctx);
        const raw = localizedPrompt("help", language);
        // g-495：把资产里的 `{moduleId}` 占位符渲染成当前生效开关（开 / 关）。
        // root 解析与其它工具同源（`rootFor`）；解析/读取失败一律按**全开** —— 与
        // `readModuleSwitchesForRoot` 的 fail-safe 同口径，绝不因读配置异常谎报「关闭」。
        let switches = null;
        try { switches = readModuleSwitchesForRoot(rootFor(ex)); } catch { switches = null; }
        const topic = typeof a?.topic === "string" ? a.topic.trim() : "";
        if (!topic) return { help: renderHelpModules(raw, switches, language) };
        // 主题抽取在**渲染前**的资产上做：模块行靠 `{moduleId}` 稳定标记定位，
        // 渲染后该标记已被替换成「开启/关闭」而无法定位 ⇒ 顺序不可颠倒。
        // g-495 返工（裁决·出路 1）：点题段已迁到按需面 `usage.*.md` ⇒ 把 usage 正文作为
        // **追加查找面**传入。两处 topic 的内存各自独立（见上）：
        //  · `graph_engineering`：help 正文优先、usage 兜底（`helpTopicText` 的 faces 顺序）；
        //  · `usage`：**只用** usage 追加面全文（att-005 修死链；不看 help 首句）。
        // g-495 返工项 A（**消除 fail-open**）：这里**不得** catch。`localizedPrompt` 在资产缺失/
        // 不可读时抛错（见 `requirePromptAsset`），若在此吞掉就等价于把「资产不可读」折叠成
        // 「该面不存在」⇒ `topic=graph_engineering` 会静默返回 `found:false`，把真实故障伪装成
        // 「没有这个主题」。故让异常**直接上抛**，故障显性可观察（选项 (a)，最小实现）。
        const usageRaw = localizedPrompt("usage", language);
        const topicText = helpTopicText(raw, topic, [usageRaw]);
        if (topicText === null) return { help: renderHelpModules(raw, switches, language), topic, found: false };
        return { help: renderHelpModules(topicText, switches, language), topic, found: true };
      },
    },
    {
      def: {
        name: "graph_move_goal",
        description: "排期移动目标：backlog ↔ 独立 goals/ ↔ 版本。文件移动即归属变更，记 goal.moved 事件。",
        parameters: params(
          { goal: str, to: { type: "string", enum: ["backlog", "standalone", "version"] }, version: str },
          ["goal", "to"],
        ),
      },
      run: (a, ex) => { moveGoal(rootFor(ex), a.goal, { to: a.to, version: a.version, actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_amend_goal",
        description: "记录对目标的修订/补充（人工反馈的一等记录）；可选把修订内容追加进目标描述，使目标内容体现最终修订。",
        parameters: params({ goal: str, note: str, append: str }, ["goal", "note"]),
      },
      run: (a, ex) => { amendGoal(rootFor(ex), a.goal, { note: a.note, appendDescription: a.append, actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_rename_goal",
        description: "重命名目标：更新 goal.md 的 meta.title，记 goal.renamed 事件（旧/新标题）。title 非空、去首尾空白；相同标题为 no-op。",
        parameters: params({ goal: str, title: str }, ["goal", "title"]),
      },
      run: (a, ex) => {
        const result = renameGoal(rootFor(ex), a.goal, { title: a.title, actor: actorOf(ex) });
        return { ok: true, ...result };
      },
    },
    {
      def: {
        name: "graph_set_goal_tags",
        description: "设置目标标签列表（最多20个，每个不超过32字，禁止控制字符）。支持基于 base_tags 的乐观并发，force=true 时强制覆盖。写入前事件先行。",
        parameters: params({ goal: str, tags: strArr, base_tags: strArr, force: { type: "boolean" } }, ["goal", "tags"]),
      },
      run: (a, ex) => {
        const result = setGoalTags(rootFor(ex), a.goal, {
          tags: a.tags,
          base_tags: a.base_tags,
          force: a.force,
          actor: actorOf(ex),
        });
        return { ok: true, ...result };
      },
    },
    {
      // g-612：goal 级预计任务预算（唯一可编辑真源 = goal meta.task_budget_seconds）。
      // 沿用现有目标更新权限/actor 规则：不额外限制为只有 live supervisor 可调用。
      def: {
        name: "graph_set_goal_budget",
        description: sT("tool.graph_set_goal_budget"),
        parameters: params({
          goal: str,
          budget_seconds: {
            type: "integer",
            minimum: 30,
            maximum: 86400,
            nullable: true,
            description: "目标级预算（整数秒，30–86400）；null = 清空并继承项目/全局 care_threshold_seconds。未设置时也继承。",
          },
        }, ["goal", "budget_seconds"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        const result = setGoalBudget(r, a.goal, { budget_seconds: a.budget_seconds, actor: actorOf(ex) });
        if (careRuntime && typeof careRuntime.notifyGoalBudgetChanged === "function") {
          try { careRuntime.notifyGoalBudgetChanged(r, a.goal, result.new_seconds); } catch { /* 关照运行时降级不影响写入 */ }
        }
        return { ok: true, ...result };
      },
    },
    {
      def: {
        name: "graph_set_goal_type",
        description: "设置目标类型（feature/bug/task/improvement/patch/chore；patch/chore 为微小改动快速通道），只更新 meta.type 并记 goal.type_changed 事件（old_type/new_type/actor）；不改 status/version/执行。非法类型安全回退 task；相同类型为 no-op。",
        parameters: params({ goal: str, type: str }, ["goal", "type"]),
      },
      run: (a, ex) => {
        const result = setGoalType(rootFor(ex), a.goal, { type: a.type, actor: actorOf(ex) });
        return { ok: true, ...result };
      },
    },
    {
      def: {
        name: "graph_validate",
        description: "全量不变式校验（状态、归属、判据、依赖环、卡片引用）。返回问题列表。",
        parameters: params({}, []),
      },
      run: (a, ex) => ({ problems: validate(rootFor(ex)) }),
    },
    {
      def: {
        name: "graph_rebuild",
        description: "从事件流重建各目标状态并与 frontmatter 对账。返回 drift 列表。",
        parameters: params({}, []),
      },
      run: (a, ex) => ({ drift: rebuild(rootFor(ex)) }),
    },
    {
      def: {
        name: "graph_report_status",
        description: sT("reportStatus"),
        parameters: params({ goal: str, attempt: str, status: str, state: ATTEMPT_STATUS_STATE_SCHEMA }, ["goal", "attempt", "status"]),
      },
      run: (a, ex) => { reportStatus(rootFor(ex), a.goal, a.attempt, a.status, actorOf(ex), a.state); return { ok: true }; },
    },
    {
      def: {
        name: "graph_report_supervisor_status",
        description: "supervisor 汇报自己的一句最新工作状态（显示在看板顶部状态栏，带运行动画）。status 要简短（一句人话）。",
        parameters: params({ status: str }, ["status"]),
      },
      run: (a, ex) => { reportSupervisorStatus(rootFor(ex), a.status, actorOf(ex)); return { ok: true }; },
    },
    {
      def: {
        name: "graph_handoff",
        description: "生成/更新 .dsh-graph/HANDOFF.md 换会话交接文档：board 投影 + 长期记忆 + 关键环境事实段自动拼接。产物不依赖会话上下文；返回交接全文。旧会话交接时调用。写盘前若旧 HANDOFF.md 存在且内容不同，先归档到 <root>/handoffs/HANDOFF-<时间戳>.md（归档目录不入 git）。",
        parameters: params({ query: str, memory_limit: { type: "number" } }, []),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        const content = generateHandoff(r, { write: true, query: a.query, memoryLimit: a.memory_limit, actor: actorOf(ex) });
        return { ok: true, path: join(r, "HANDOFF.md"), handoff: content };
      },
    },
    {
      def: {
        name: "graph_claim_supervisor",
        description: "新会话接手时调用：把 project.yaml 的 supervisor.session 更新为当前会话 id（ex.agent.session 链），记 supervisor.claimed 事件（幂等：重复调用不重复记），返回 HANDOFF 交接全文并同时落盘 HANDOFF.md（写盘统一走归档逻辑：旧版先归档到 <root>/handoffs/）。",
        parameters: params({}, []),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        const res = claimSupervisor(r, ex?.agent?.session?.id, actorOf(ex));
        // g-506 返工（3110 现场根因）：claim 只写 project.yaml，不产生 Cordis 事件。若关照运行时
        // 启动时的默认根不是本 root（或当时默认 workspace 还没就绪），无人布防 ⇒ 到阈值也永不投递。
        // 这里在**成功 claim 后**把 canonical root 显式交给运行时（内部重验 live 主管一致性，幂等），
        // 失败/无运行时一律静默：claim 的成功语义不受关照影响。
        try {
          if (careRuntime && typeof careRuntime.armForRoot === "function") careRuntime.armForRoot(r);
        } catch { /* 忽略 */ }
        return { supervisor_session: res.supervisor_session, handoff: res.handoff };
      },
    },
    // ===== g-105：记忆管理工具（add / replace / remove / recall） =====
    {
      def: {
        name: "graph_memory_add",
        description: "新增持久事实/记忆。scope 默认 on_demand（按需，不占常驻 Prompt）；仅「人类明确要求记为常驻/铁律」或「涉及工作区隔离/不可违背的安全禁令」才可设 standing（硬上限 200 字符，普通记忆上限 1000 字符）。可选 source_ref 是迁移来源键：提供时同来源重复 add 幂等（返回原 ID、不重复记事件）。",
        parameters: params({
          kind: { type: "string", enum: ["project", "user"] },
          scope: { type: "string", enum: ["standing", "on_demand"] },
          text: str,
          importance: { type: "number" },
          source_goal: str,
          source_ref: str,
        }, ["kind", "text"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        if (!isMemoryToolsEnabled(r)) throw new GraphError("记忆工具已被用户禁用，当前为纯手工管理模式，无法通过工具修改记忆");
        const res = addMemory(r, {
          scope: a.scope,
          kind: a.kind,
          text: a.text,
          importance: a.importance !== undefined ? Number(a.importance) : undefined,
          source_goal: a.source_goal,
          source_ref: a.source_ref,
          actor: memoryActorOf(ex),
        });
        return losslessJson({ ok: true, id: res.id, entry: res.entry, deduped: res.deduped, skipped: res.skipped, source_ref: res.source_ref, reason: res.reason });
      },
    },
    {
      def: {
        name: "graph_memory_replace",
        description: "修正或合并已有记忆条目（用短唯一 old 片段定位已有记忆，text 为新内容）。",
        parameters: params({
          old: str,
          text: str,
          kind: { type: "string", enum: ["project", "user"] },
          importance: { type: "number" },
          source_goal: str,
        }, ["old", "text"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        if (!isMemoryToolsEnabled(r)) throw new GraphError("记忆工具已被用户禁用，当前为纯手工管理模式，无法通过工具修改记忆");
        const res = replaceMemory(r, {
          old: a.old,
          text: a.text,
          kind: a.kind,
          importance: a.importance !== undefined ? Number(a.importance) : undefined,
          source_goal: a.source_goal,
          actor: memoryActorOf(ex),
        });
        return losslessJson({ ok: true, id: res.id, entry: res.entry });
      },
    },
    {
      def: {
        name: "graph_memory_remove",
        description: "删除记忆条目（仅负责人明确撤回或证实过时后才可删除；用短唯一 old 片段定位）。",
        parameters: params({
          old: str,
          reason: str,
        }, ["old"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        if (!isMemoryToolsEnabled(r)) throw new GraphError("记忆工具已被用户禁用，当前为纯手工管理模式，无法通过工具修改记忆");
        const res = removeMemory(r, {
          old: a.old,
          reason: a.reason,
          actor: memoryActorOf(ex),
        });
        return losslessJson({ ok: true, id: res.id, removed: res.removed });
      },
    },
    {
      def: {
        name: "graph_memory_recall",
        description: "按关键词/类型检索返回匹配的持久记忆条目（供 supervisor 及子代理引用）。",
        parameters: params({
          query: str,
          kind: { type: "string", enum: ["project", "user"] },
          limit: { type: "number" },
        }, []),
      },
      run: (a, ex) => {
        const res = recallMemory(rootFor(ex), {
          query: a.query,
          kind: a.kind,
          limit: a.limit !== undefined ? Number(a.limit) : undefined,
          actor: memoryActorOf(ex),
        });
        return losslessJson({ ok: true, total: res.total, matches: res.matches });
      },
    },

    {
      def: {
        name: "graph_start_attempt",
        description: sT("tool.graph_start_attempt"),
        parameters: params({ goal: str, card: str, executor: str, provider: str, model: str, reasoning_effort: str, mode: str, worktree: { type: "boolean" }, attempt_brief: str, task_type: ATTEMPT_TASK_TYPE_SCHEMA, baseline_commit: ATTEMPT_OPTIONAL_STRING_SCHEMA, source_attempt: ATTEMPT_OPTIONAL_STRING_SCHEMA, acceptance_items: ATTEMPT_ACCEPTANCE_ITEMS_SCHEMA, child_id: ATTEMPT_REUSE_CHILD_ID_SCHEMA }, ["goal"]),
      },
      run: async (a, ex) => {
        // 校验 attempt_brief 类型（g-150 review 问题 4）
        if (a.attempt_brief !== undefined && a.attempt_brief !== null && typeof a.attempt_brief !== "string") {
          throw new GraphError("attempt_brief 必须是 string 类型");
        }
        const structuredFieldError = validateAttemptPromptFields({
          taskType: a.task_type,
          baselineCommit: a.baseline_commit,
          sourceAttempt: a.source_attempt,
          acceptanceItems: a.acceptance_items,
        });
        if (structuredFieldError) throw new GraphError(structuredFieldError);
        if (a.mode !== undefined && a.mode !== null && a.mode !== "") {
          if (typeof a.mode !== "string" || !normalizeSubagentMode(a.mode)) {
            throw new GraphError(`mode 只允许 ${SUBAGENT_MODES.join("/")}`);
          }
        }
        // g-613：`child_id` 复用空闲专家子代理——类型校验最早（零副作用），真正的复用准入在
        // dispatchExecutionAttempt 的同步临界区内完成（同一套判定、可重用错误）。
        if (a.child_id !== undefined && a.child_id !== null && typeof a.child_id !== "string") {
          throw new GraphError("child_id 必须是 string 类型（宿主 durable child session id）");
        }
        if (a.child_id !== undefined && a.child_id !== null && a.card !== undefined && a.card !== null) {
          throw new GraphError("显式 child_id 仅用于承接目标执行；收集任务（card）请不传 child_id 以新建收集子代理");
        }
        const executor = a.executor ?? actorOf(ex);
        const r = rootFor(ex);
        // g-202：传 card 时统一走上下文收集派发，不创建 Goal execution attempt。
        // 先生成 prompt（同时校验 goal/card），再尝试启动；只有成功启动后才绑定卡片。
        if (a.card !== undefined && a.card !== null) {
          // g-480：collector 的**派发提示词面**随模块自适应——`attachments` 关闭时按行剔除
          // `graph_store_attachment` 的提及（`stripModuleToolMentions` 无可剔时返回**同一字符串**
          // ⇒ 未配置/全开路径逐字节不变）。注意只做**提示词投影**，`@att/` 既有资产不受影响（判据 5）。
          const fullPrompt = stripModuleToolMentions(formatCollectPrompt(r, a.goal, a.card, a.attempt_brief, resolvePromptLanguage(readGraphSettings().promptLanguage, ctx)), readModuleSwitchesForRoot(r).disabledTools);
          const eff = resolveModelRoute(
            { provider: a.provider, model: a.model, reasoning_effort: a.reasoning_effort },
            readExecutorModel(r),
            readGraphSettings(),
          );
          const effProvider = eff.provider;
          const effModel = eff.model;
           const effReasoningEffort = eff.reasoning_effort;
          const effRoute = (effProvider || effModel) ? `${effProvider ?? "继承"}/${effModel ?? "继承"}` : null;
          const result = { card: a.card, child_id: null, child_error: null };
          // g-388：spawn 前准入——共享卡已在 collecting 时直接拒绝，绝不启动 child。
          // （与 REST start-collection 共用同一判定；此处早于 provider 选择，保持零 spawn 副作用。）
          const admissionErr = collectAdmissionBlock(r, a.goal, a.card);
          if (admissionErr) {
            result.child_error = subagentSpawnErrorText(admissionErr);
            return result;
          }
          const subagents = ctx.get?.("subagents");
          if (!subagents || !ex?.agent) {
            result.child_error = "subagents 服务不可用或无调用 agent";
            return result;
          }
          try {
            const { provider, error: providerError } = probeContinuableProvider(subagents);
            if (!provider) throw new Error(providerError);
            const collectorCapBlock = capabilityBlock(r, { goal: a.goal, role: "collector", mode: a.mode, agentScope: ex.agent, label: `collector/${a.card}` });
          if (collectorCapBlock) {
            result.child_error = collectorCapBlock;
            return result;
          }
          const collectToolFilter = toolFilterForRole("collector", a.mode, toolCapabilityFor(ex.agent), readModuleSwitchesForRoot(r));
            const agentOptions = {};
            if (effProvider) agentOptions.provider = effProvider;
            if (effModel) agentOptions.model = effModel;
             if (effReasoningEffort) agentOptions.reasoningEffort = effReasoningEffort;
            const started = await startSubagentCompat(subagents, {
              provider,
              label: `graph:collect/${a.goal}/${a.card}`,
              parent: ex.agent,
              prompt: text(fullPrompt),
              ...(collectToolFilter ? { toolFilter: collectToolFilter } : {}),
              ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
              signal: ex.signal,
            });
            const bound = bindCollectWithConvergence(r, a.goal, a.card, {
              started,
              parentSessionId: started.parentSessionId ?? ex.agent?.session?.id ?? null,
              parentAgent: ex.agent,
              actor: actorOf(ex),
              provider: effProvider,
              model: effModel,
            });
            // g-388：绑定失败也不丢 child_id——收敛结果始终带回刚启动的 child（便于事后定位/中断核对）。
            result.child_id = bound.child_id;
            if (bound.child_error) result.child_error = bound.child_error;
            if (bound.interrupted) result.child_interrupted = true;
            if (effRoute) result.model_route = effRoute;
          } catch (e) {
            // g-321：收集子代理同样受 0.1.6 并发槽位约束，友好化 ACTIVATION_LIMIT_REACHED
            result.child_error = subagentSpawnErrorText(e);
          }
          return result;
        }
        const ws = sessionWorkspace(ex) ?? dirname(r);
        const execRes = await dispatchExecutionAttempt({
          root: r,
          workspace: ws,
          goal: a.goal,
          entrypoint: "tool",
          actor: actorOf(ex),
          executor,
          parentAgent: ex.agent,
          parentSessionId: ex.agent?.session?.id ?? null,
          signal: ex.signal,
          attempt_brief: a.attempt_brief,
          task_type: a.task_type,
          baseline_commit: a.baseline_commit,
          source_attempt: a.source_attempt,
          acceptance_items: a.acceptance_items,
          provider: a.provider,
          model: a.model,
          reasoning_effort: a.reasoning_effort,
          mode: a.mode,
          worktree: a.worktree,
          child_id: a.child_id,
        });
        const result = {
          attempt: execRes.attempt,
          child_id: execRes.child_id,
          injected_cards: execRes.injected_cards,
          injected_handoffs: execRes.injected_handoffs,
          mode: execRes.mode,
          mode_source: execRes.mode_source,
          worktree: execRes.worktree,
          // g-406：本层是**白名单构造**——凡不在此显式登记的字段都会在工具响应里消失，
          // 主管就无从判定隔离（事故里只看到 worktree:false，看不出「策略豁免」还是「建树失败」）。
          // 故隔离判定四件套必须一并登记（值来自 dispatchExecutionAttempt 的 isolationReport）。
          isolated: execRes.isolated,
          worktree_reason: execRes.worktree_reason ?? null,
          worktree_created: execRes.worktree_created === true,
          worktree_reused: execRes.worktree_reused === true,
          // g-437 P1：区间锚点也必须回传（与上面四件套同一理由——白名单漏登记主管就看不到）。
          // 主管据此填 `machine_report.baseline_commit`；null = 该 attempt 无锚点（走不了 fast_track）。
          baseline_commit: execRes.baseline_commit ?? null,
          baseline_source: execRes.baseline_source ?? null,
          baseline_ref: execRes.baseline_ref ?? null,
          baseline_version: execRes.baseline_version ?? null,
          baseline_fallback_reason: execRes.baseline_fallback_reason ?? null,
        };
        if (execRes.child_error) result.child_error = execRes.child_error;
        if (execRes.note) result.note = execRes.note;
        if (execRes.brief) result.brief = execRes.brief;
        // g-613：复用判定的可观测面（白名单构造——不在此登记主管就看不到「复用还是新开」以及
        // 「投递是否被受理」）。只有复用路径才出现这些字段 ⇒ 未传 child_id 的响应逐字不变。
        if (execRes.reused === true) {
          result.reused = true;
          result.delivery = execRes.delivery ?? null;
          // 提示词哈希/上下文摘要与全新派发同口径回传（复用不额外回显整份提示词，但审计锚点必须可查）。
          if (execRes.prompt_hash) result.prompt_hash = execRes.prompt_hash;
          if (execRes.context_digest) result.context_digest = execRes.context_digest;
          // started 只表示「宿主已受理投递」，**不是**「已开始工作」的证据。
          result.started = execRes.started === true;
          if (execRes.started_basis) result.started_basis = execRes.started_basis;
          if (execRes.message_id) result.message_id = execRes.message_id;
          result.prior_attempt = execRes.prior_attempt ?? null;
        }
        // g-251：来源闭集四值一律回传（含 "brief"）——显式 brief 也是一等来源，不再被吞成 undefined，
        // 保证工具响应对来源的表述与 attempt meta/事件/goalDetail 三处完全一致。
        if (execRes.brief_source) result.brief_source = execRes.brief_source;
        if (execRes.model_route) result.model_route = execRes.model_route;
        return result;
      },
    },
    {
      def: {
        name: "graph_start_review",
        description: "为**既有执行 attempt** 派发独立评审子代理（reviewer，只读审查）。评审是附属记录：不新建 attempt、不迁移状态、不覆盖作者 child_id 与结果文件；复用作者工作树；结论落盘 <goalDir>/reviews/<review_id>.md。同一 attempt + 同一候选幂等。reviewer 不得自行 accept/force/fast_track/delivered。",
        parameters: params({
          goal: str,
          attempt: str,
          candidate_commit: str,
          baseline_commit: str,
          guidance: str,
          provider: str,
          model: str,
          reasoning_effort: str,
          mode: str,
        }, ["goal", "attempt", "candidate_commit"]),
      },
      run: async (a, ex) => {
        const r = rootFor(ex);
        // 身份真源：只取真实执行身份（会话 id），不接受调用者自报的 actor/role/child_id。
        const requestedBy = ex?.agent?.session?.id ? `agent:${ex.agent.session.id}` : actorOf(ex);
        const res = await dispatchReview({
          root: r,
          workspace: sessionWorkspace(ex) ?? dirname(r),
          goal: a.goal,
          attempt: a.attempt,
          candidate_commit: a.candidate_commit,
          baseline_commit: a.baseline_commit,
          guidance: a.guidance,
          requestedBy,
          actor: actorOf(ex),
          parentAgent: ex?.agent ?? null,
          parentSessionId: ex?.agent?.session?.id ?? null,
          signal: ex?.signal,
          provider: a.provider,
          model: a.model,
          reasoning_effort: a.reasoning_effort,
          mode: a.mode,
        });
        return res;
      },
    },
    {
      def: {
        name: "graph_resolve_accept",
        // 注意（g-437 P3-b 措辞纠正）：注册处在 `...t.def` **之后**用 sT 取 i18n 字典值覆盖 `description`
        // ⇒ **生效面是 lib/server-i18n.js 的 tool.graph_resolve_accept（zh/en）**，本字面量只是**同步副本**
        // （可读性/兜底）。改文案必须两处同改；prompt-i18n-parity 要求「每个注册工具恰有一把 tool.* 键」⇒ 键不可删。
        description: "主管裁决目标的接受请求（review.requested 出现后调用）：verdict=accept 通过 / object 提出异议；force=true 强制接受并记理由。fast_track=true 走机器快速放行：须策略判定为 auto（patch/chore 派生；契约变更/跨 3 个顶层区域/≥150 行产品代码/显式 strict_required 一律升级 strict），且 ①tests（exit_code=0 且 fail=0）②typecheck（exit_code=0）为**调用方证据**（引擎不复跑，须留痕 command/collected_at/source）、③变更规模由**引擎 Git 自算**（machine_report.attempt 必填）、④全部判据以 ✅已验 结尾，四项全绿方可。详见 i18n tool.graph_resolve_accept。",
        parameters: params({
          goal: str,
          verdict: { type: "string", enum: ["accept", "object"] },
          objection: str,
          force: { type: "boolean" },
          reason: str,
          fast_track: { type: "boolean", description: "机器快速放行开关；缺省 false（默认路径逐字不变）。" },
          machine_report: {
            type: "object",
            description:
              "机器证据包：{ attempt, baseline_commit, changed_paths[], product_changed_lines, untracked_files, tests:{exit_code,fail,command,collected_at,source}, typecheck:{exit_code,command,collected_at,source}, strict_required? }。" +
              "attempt 必填（显式绑定实际执行树，引擎不猜）；`baseline_commit` 必填，且必须**等于**该 attempt 的引擎锚点（派发响应回传的 `baseline_commit`；隔离 attempt 的 `worktree.head` 亦可，短 SHA 亦可）——锚点只取自 attempt 记录，绝不取自报告；①② tests/typecheck 为调用方证据并须留痕命令原文/采集时间/来源（引擎不复跑）；" +
              "③ 由引擎在实际 attempt 工作树的 Git 真源自算并与报告逐项对账（报告必须与 `git diff --numstat -z`（rename 含旧新两条路径）及未跟踪用户文件数完全一致）；④ 由引擎自算（全部判据 ✅已验），报告不得自报。",
          },
        }, ["goal", "verdict"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        // g-436：复核子代理身份（正常工具通道）不得裁决接受——含 force 与 fast_track 两条旁路。
        // 匹配只按**持久化的精确 child 身份**（review.bound 事件），不凭报文自称是 reviewer。
        assertNotReviewerIdentity(
          r,
          [ex?.agent?.id, ex?.agent?.session?.id],
          a.force ? "graph_resolve_accept(force)" : a.fast_track ? "graph_resolve_accept(fast_track)" : "graph_resolve_accept",
        );
        const result = resolveAccept(r, a.goal, {
          actor: actorOf(ex),
          verdict: a.verdict,
          objection: a.objection,
          force: a.force,
          reason: a.reason,
          fast_track: a.fast_track,
          machine_report: a.machine_report,
        });
        return { ok: true, fast_track: result.fast_track === true };
      },
    },
    {
      def: {
        name: "graph_list_worktrees",
        description: "查询 Git worktree 清理候选（只读，不自动删除）。",
        parameters: params({ goal: str }, []),
      },
      run: (a, ex) => ({ worktrees: listWorktrees(rootFor(ex), a.goal) }),
    },
    {
      def: {
        name: "graph_clean_worktree",
        description: "用户明确选择后清理已实时验证的 worktree；默认不删除分支。支持安全清理已删除目标的残留孤儿工作树（消除 missing_attempt_evidence 阻断）。",
        parameters: params({ id: str, confirm: { type: "boolean" } }, ["id", "confirm"]),
      },
      run: (a, ex) => {
        const r = cleanWorktree(rootFor(ex), a.id, actorOf(ex), a.confirm === true, childLiveState);
        if (r.ok) _clearWorktreeCache();
        return r;
      },
    },
    {
      def: {
        name: "graph_archive_goal",
        description: "归档目标（仅 draft/planning/delivered 可归档）。移动到对应 archived 目录，记 goal.archived 事件。",
        parameters: params({ goal: str }, ["goal"]),
      },
      run: (a, ex) => { archiveGoal(rootFor(ex), a.goal, { actor: actorOf(ex), liveCheck: childLiveState }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_unarchive_goal",
        description: "取消归档目标（移回原位置，状态保持原样）。记 goal.unarchived 事件。",
        parameters: params({ goal: str }, ["goal"]),
      },
      run: (a, ex) => { unarchiveGoal(rootFor(ex), a.goal, { actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_delete_goal",
        description: "删除已归档目标（含其卡片/attempts 目录）。仅已归档目标可删除，且不能有活跃子代理；若目标仍有关联未清理的工作树则阻断并提示先清理。记 goal.deleted 事件。",
        parameters: params({ goal: str }, ["goal"]),
      },
      run: (a, ex) => { deleteGoal(rootFor(ex), a.goal, { actor: actorOf(ex), liveCheck: childLiveState }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_postpone_goal",
        description: "暂缓目标：将版本/独立目标移回 backlog 目录形态并置为 draft（保留 cards/attempts）。存在活跃 agent 时拒绝操作。",
        parameters: params({ goal: str, reason: str }, ["goal"]),
      },
      run: (a, ex) => { postponeGoal(rootFor(ex), a.goal, { actor: actorOf(ex), reason: a.reason, liveCheck: childLiveState }); return { ok: true }; },
    },
    {
      // g-190/g-282：从目标解绑执行子代理（安全 detach）——主管/目标 owner 专用。
      // 仅授权主管（project.yaml supervisor.session）或目标 owner 可执行；子代理不能自我解绑。
      // 遗留绑定缺失 binding_token 时支持显式声明 legacy: true 并给出 reason 进行受控解绑。
      def: {
        name: "graph_unbind_goal_child",
        description: "从目标安全解绑执行子代理：按 goal + 唯一 selector（attempt 或 child_id）+ 当前 binding token 定位；仅授权主管或目标 owner 可执行（子代理不能自我解绑）。只清理绑定，attempt/事件/日志保留可审计；幂等。遗留缺 token 的绑定可显式 legacy: true 并给 reason 受控解绑（若存在 token 则禁止绕过）。",
        parameters: params(
          { goal: str, attempt: str, child_id: str, token: str, reason: str, legacy: { type: "boolean" } },
          ["goal"],
        ),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        const hasAtt = typeof a.attempt === "string" && a.attempt.length > 0;
        const hasChild = typeof a.child_id === "string" && a.child_id.length > 0;
        if (hasAtt === hasChild) {
          throw new GraphError("必须且只能指定一个选择器：attempt 或 child_id");
        }
        const result = unbindGoalChild(r, a.goal, {
          actor: unbindActorOf(ex, r),
          token: typeof a.token === "string" ? a.token : null,
          legacy: a.legacy === true || a.legacy === "true",
          attempt: hasAtt ? a.attempt : null,
          childId: hasChild ? a.child_id : null,
          reason: typeof a.reason === "string" && a.reason.length ? a.reason : null,
          liveCheck: childLiveState,
        });
        return { ok: true, ...result };
      },
    },
    {
      // g-282：放弃陈旧/失联 attempt（标记 result=cancelled、detached=true）——主管/目标 owner 专用。
      def: {
        name: "graph_abandon_attempt",
        description: "放弃陈旧/失联 attempt：把指定 attempt 标记为已放弃（result=cancelled、detached=true），清除绑定；仅授权主管或目标 owner 可执行；子代理仍运行（live registry）或状态不可确认时拒绝；事件先行（attempt.abandoned 含 reason/actor）。放弃后该 attempt 不再被判为活跃，目标可正常暂缓/归档/删除。",
        parameters: params(
          { goal: str, attempt: str, reason: str },
          ["goal", "attempt", "reason"],
        ),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        const result = abandonAttempt(r, a.goal, {
          actor: unbindActorOf(ex, r),
          attempt: a.attempt,
          reason: a.reason,
          liveCheck: childLiveState,
        });
        return { ok: true, ...result };
      },
    },
    {
      // g-506：提交一次**关照巡检结论**（唯一窄回传入口；不是通用写接口）。
      // 身份 = ex.agent.session（真实主管）+ 服务端 inspection/attempt/binding；拒绝伪造 attempt/结论。
      def: {
        name: "graph_care_outcome",
        description: sT("tool.graph_care_outcome"),
        parameters: params({
          inspection: { type: "string", minLength: 1, maxLength: 128 },
          goal: { type: "string", minLength: 1, maxLength: 128 },
          attempt: { type: "string", minLength: 1, maxLength: 128 },
          child: { type: "string", minLength: 1, maxLength: 128 },
          outcome: { type: "string", enum: [...CARE_OUTCOMES] },
          evidence: { type: "string", minLength: 1, maxLength: 800 },
        }, ["inspection", "goal", "attempt", "child", "outcome", "evidence"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        const sid = ex?.agent?.session?.id;
        if (!sid) return { ok: false, code: "wrong_identity" };
        if (readSupervisorSession(r) !== sid) return { ok: false, code: "wrong_identity" };
        if (!careRuntime || typeof careRuntime.submitOutcome !== "function") {
          return { ok: false, code: "care_runtime_unavailable" };
        }
        return losslessJson(careRuntime.submitOutcome({
          root: r,
          supervisor: sid,
          inspection: a.inspection,
          goal: a.goal,
          attempt: a.attempt,
          child: a.child,
          outcome: a.outcome,
          evidence: a.evidence,
        }));
      },
    },
    {
      // g-310：读取当前 workspace 项目配置（只读查询 + schema/枚举元信息）
      def: {
        name: "graph_get_settings",
        description: sT("tool.graph_get_settings"),
        parameters: params({}, []),
      },
      run: (_a, ex) => {
        const r = rootFor(ex);
        const config = readProjectConfig(r);
        // 与 REST/GUI/调度器同一真源：项目读值上的 care_effective 必须用**真实全局值**重投影，
        // 不能把 core 的「项目半边默认值」当作生效值下发。
        try { config.supervisor = { ...config.supervisor, care_effective: careProjectionOf(config) }; } catch { /* 读取失败时保留项目半边 */ }
        return losslessJson({
          config,
          config_path: join(r, "project.yaml"),
          // g-505：保活的 **configured/effective/capable/active** 四段投影（与 REST/GUI/调度器同源）。
          // 明确区分「配置了什么」「实际生效什么」「宿主能力如何」「当前运行态如何」，
          // 缺能力/无快照时如实列出 missing 与 snapshot 原因，绝不把未保活显示成成功。
          supervisor_keep_alive: keepAliveStatusOf(r) ?? {
            effective: keepAliveProjectionOf(config),
            capable: { channel: "none", reason: "missing_capability", missing: ["keepalive.runtime"], ttl: "unknown", short_ttl_bound_ms: KEEP_ALIVE_SHORT_TTL_MS, host_channel: false },
          },
          // g-506：关照的 configured/effective/capable/active 投影（与 REST/GUI/调度器同源）。
          supervisor_care: careStatusOf(r) ?? {
            configured: careProjectionOf(config),
            capable: { available: {}, missing: [...CARE_CAPABILITIES], minimal: false },
            phase: "unavailable",
            reason: "capability_missing",
            next_due_at: null,
            next_due_in_ms: null,
            paused: false,
            warnings: ["care_runtime_unavailable"],
          },
          // g-480：**宿主真裁剪能力**如实下发（与监听器注册、GUI 提示同一判定，apply 期一次探测）：
          // true = 本版本 DSH 同时有 `agent/created` 与 `tools.restrict` ⇒ 模块开关真裁剪生效；
          // false = 不支持 ⇒ 模块开关只记录配置、不改变工具面（GUI「模块」页签显示一行提示）。
          trim_supported: moduleTrimSupported,
          // g-442：按当前项目目录结构的**只读**建议（绝不自动写入 project.yaml）
          review_suggested_regions: suggestedReviewRegions(r),
          schema_hints: {
            "supervisor.automation": {
              keys: ["scope_planning", "integration_decision", "rework", "memory_promotion", "skill_proposal", "release"],
              values: ["human", "ai"],
              // g-490：**未配置时的显示口径来源引用表**（与 `automation_unset_scope` 同一真源
              // `AUTOMATION_UNSET_SCOPE`）——**不是**解析默认值：只登记「哪两键的动作落在既有某类
              // 人工 gate 范围内」及其来源；表外键未配置即「保持既有指导」。GUI 据此在未配置项上
              // 显示「默认：<gate 要求>」并**同屏标注该来源**。
              unset_scope: AUTOMATION_UNSET_SCOPE,
            },
            "executor.mode": SUBAGENT_MODES,
            // g-440：Agent Teams 最小契约开关（负责人资格判定；默认未配置/null = off）
            "supervisor.agent_teams": {
              type: "boolean",
              default: false,
              values: [true, false, null],
            },
            // g-505：项目级保活三态（null/未配置 = inherit 跟随全局；true/false = 严格覆盖）。
            // 生效值另见 `supervisor_keep_alive.effective`（绝不与配置形态混为一谈）。
            "supervisor.keep_alive": {
              type: "string",
              scope: "workspace",
              default: null,
              values: [...KEEP_ALIVE_MODES, null],
            },
            // g-506：项目级关照三态与时间参数（null = inherit 跟随全局；生效值见 supervisor_care）。
            "supervisor.care": {
              type: "string",
              scope: "workspace",
              default: null,
              values: [...CARE_MODES, null],
            },
            "supervisor.care_threshold_seconds": {
              type: "integer",
              scope: "workspace",
              default: null,
              minimum: 30,
              maximum: 86400,
            },
            "supervisor.care_recheck_seconds": {
              type: "integer",
              scope: "workspace",
              default: null,
              minimum: 30,
              maximum: 86400,
            },
            // g-618：关照唤醒正文「首次全量、后续精简」开关（默认开启 = 未配置/null）。
            // 只控制**文案投递方式**；关闭 = 逐字回退「每份都内联完整纪律」的旧行为。
            "supervisor.care_wake_compact": {
              type: "boolean",
              scope: "workspace",
              default: true,
              values: [true, false, null],
            },
            "prompt_overrides.subagent": {
              states: ["default", "override", "disable"],
            },
            // g-480：harness 模块可选开关（workspace 级单层）。未配置/null = **开启**（与改造前一致）；
            // `tools` 与该模块绑定的受管工具名同源下发（MODULE_TOOL_NAMES 是唯一映射表，宿主不另抄）。
            // `scope` = "workspace"，`prompt_face` 说明该模块在提示词面的裁剪位置。
            // `roles` = 该模块关闭时**档案会自适应**的子代理角色（由 `rolesAdaptedByModule` 从真实
            // 角色档案 diff 推出，不是第二份副本）——空数组 = 只影响工具面、无角色档案被裁。
            "modules": {
              type: "boolean",
              scope: "workspace",
              default: true,
              values: [true, false, null],
              keys: [...HARNESS_MODULE_IDS],
              per_module: Object.fromEntries(
                HARNESS_MODULE_IDS.map((id) => [id, {
                  tools: [...MODULE_TOOL_NAMES[id]],
                  prompt_face: MODULE_PROMPT_FACE[id],
                  roles: rolesAdaptedByModule(id),
                }]),
              ),
            },
            // g-311/g-435：顶层 review 配置提示
            "review.policy": {
              values: [...REVIEW_POLICIES],
            },
            "review.defaults": {
              regions: [...DEFAULT_REVIEW_REGIONS],
              contract_paths: [...DEFAULT_CONTRACT_PATHS],
              non_product_prefixes: [...DEFAULT_NON_PRODUCT_PREFIXES],
            },
            // g-442：三项列表的写侧约束（与 core 的 REVIEW_LIST_FIELDS 同源，不是第二份副本）
            "review.lists": Object.fromEntries(
              REVIEW_LIST_FIELDS.map((spec) => [spec.key, { allow_empty: spec.allowEmpty, default: [...spec.defaultValues] }]),
            ),
          },
        });
      },
    },
    {
      // g-310：更新当前 workspace 项目配置（schema 校验 + 事件先行 + 原子写）
      def: {
        name: "graph_update_settings",
        description: sT("tool.graph_update_settings"),
        parameters: params({ patch: { type: "object", description: "配置 patch（部分字段，未传字段保持不变）：可包含 executor、defaults、supervisor.automation、supervisor.agent_teams、modules、prompt_overrides 等" } }, ["patch"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        writeProjectConfig(r, a.patch, actorOf(ex));
        return { ok: true };
      },
    },
  ];

  // ===== client 半边：/api/dsh-graph* REST 端点（原 dsh-graph-client/index.js，g-116 并入） =====
  // g-113 会话 workspace 跟随：HTTP 请求本身不带会话，workspace 由前端显式携带
  // （query 参数 ?workspace= / ?root=，或 POST body.workspace / body.root）——
  // 前端从当前会话 session.header.cwd 派生。两个参数名等价（brief 建议 root），
  // 语义都是「workspace 根」，传入 resolveRoot 的 workspaceRoot 参数（→ <ws>/.dsh-graph）。
  // g-149 修复：不再兜底 process.cwd()——无显式参数时返回 null，
  // 由 rootForReq 返回 GraphError，避免在服务进程 cwd 下意外 init .dsh-graph。
  const workspaceOf = (req, body) => {
    try {
      const sp = new URL(req?.url ?? "", "http://x").searchParams;
      return sp.get("workspace") || sp.get("root") || body?.workspace || body?.root || null;
    } catch {
      return body?.workspace || body?.root || null;
    }
  };
  // ===== g-442：评审条件的「按当前项目目录结构建议」——**只读提示，绝不自动写入 project.yaml** =====
  // 仅列出 workspace 根下的一级目录名（排除隐藏目录与生成物/依赖目录），供设置面板只读展示；
  // 任何写入都必须由用户在设置面板里显式登记。扫描失败（目录不可读等）返回 null，不阻断设置面。
  const REVIEW_SUGGEST_EXCLUDE = new Set(["node_modules", "dist", "core-dist", "tmp"]);
  const suggestedReviewRegions = (graphRoot) => {
    try {
      return readdirSync(dirname(graphRoot), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !REVIEW_SUGGEST_EXCLUDE.has(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      return null;
    }
  };
  // g-212 att-005：REST 不自建 auth/allowlist；显式 workspace/root 仅作为
  // 当前请求的 root 输入交给统一 resolver。sandboxPolicy 不参与显式请求判定。
  const requireWorkspaceOf = (req, body) => {
    if (isAbsoluteConfig) return config.root;
    const ws = workspaceOf(req, body);
    if (typeof ws !== "string" || !ws.trim()) {
      throw new GraphError("REST 端点需要明确的 workspace 参数（?workspace= 或 body.workspace），当前请求无可用 workspace");
    }
    return resolve(ws);
  };
  // 解析后幂等 init：端点首次触达某个 workspace 时确保其 .dsh-graph 骨架齐全（开箱即用，
  // 与 apply 期 init 同款；board/写端点不会因缺骨架半成品落盘）
  // g-149 扩展：使用 resolveCanonicalRoot 做 Git linked-worktree 归一化
  const rootForReq = (req, body) => {
    const ws = requireWorkspaceOf(req, body);
    const canonical = resolveCanonicalRoot(config, ws);
    init(canonical.root);
    if (canonical.rootWarning) {
      process.stderr.write(`[dsh-graph-host] ⚠️ ${canonical.rootWarning}\n`);
    }
    return canonical.root;
  };
  // g-149：带元数据的 REST root 解析（诊断用，board 响应附加 graphRoot/rootMode）
  const rootForReqMeta = (req, body) => {
    const ws = requireWorkspaceOf(req, body);
    const canonical = resolveCanonicalRoot(config, ws);
    init(canonical.root);
    if (canonical.rootWarning) {
      process.stderr.write(`[dsh-graph-host] ⚠️ ${canonical.rootWarning}\n`);
    }
    return canonical;
  };
  const json = (res, code, data, headers = {}) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(data));
  };
  // 所有普通 JSON REST 统一走 capped reader（防超大 JSON OOM；附件 endpoint 用更大的 MAX_ATTACHMENT_JSON_BYTES）
  const readBody = (req) => readBodyCapped(req, MAX_JSON_BODY_BYTES);
  // 返回 {childId, parentSessionId, error}；error 非空表示未派发成功。
  const spawnChild = async (label, promptText, req, rootForReq, overrides = {}) => {
    const subagents = ctx.get?.("subagents");
    if (!subagents) return { childId: null, parentSessionId: null, error: "subagents 服务不可用" };
    const { supervisorId, parent, error } = resolveSpawnParent(rootForReq);
    if (error) return { childId: null, parentSessionId: null, error };
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    try {
      // subagent provider（spawn/fork）与 LLM provider（模型路由）是两回事：
      // 这里自动挑选带 prepareContinuable 能力的 subagent provider，绝不把用户选的 LLM provider 当 subagent provider。
      const { provider, error: providerError } = probeContinuableProvider(subagents);
      if (!provider) return { childId: null, parentSessionId: null, error: providerError };
      const effRole = overrides.role ? normalizeSubagentRole(overrides.role) ?? "executor" : "executor";
      // g-473：能力自检（缺必需工具则不派发；error 非空即未派发，与既有 provider 失败同口径）
      const roleOverrideCapBlock = capabilityBlock(rootForReq, { goal: null, role: effRole, mode: overrides.mode, agentScope: parent, label: `${label}/${effRole}` });
      if (roleOverrideCapBlock) return { childId: null, parentSessionId: null, error: roleOverrideCapBlock };
      const roleToolFilter = toolFilterForRole(effRole, overrides.mode, toolCapabilityFor(parent), readModuleSwitchesForRoot(rootForReq));
      // g-133：模型路由合成（overrides > project.yaml > profile 全局默认 > 继承），核心逻辑在 core/ops.ts
      const eff = resolveModelRoute(
        { provider: overrides.provider, model: overrides.model, reasoning_effort: overrides.reasoning_effort },
        readExecutorModel(rootForReq),
        readGraphSettings(),
      );
      const agentOptions = {};
      const effProvider = eff.provider;
      const effModel = eff.model;
           const effReasoningEffort = eff.reasoning_effort;
      if (effProvider) agentOptions.provider = effProvider;
      if (effModel) agentOptions.model = effModel;
             if (effReasoningEffort) agentOptions.reasoningEffort = effReasoningEffort;
      const started = await startSubagentCompat(subagents, {
        provider,
        label,
        parent,
        prompt: [{ type: "text", text: promptText }],
        ...(roleToolFilter ? { toolFilter: roleToolFilter } : {}),
        ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
        signal: ac.signal,
      });
      return { childId: started.childId, parentSessionId: supervisorId, parent, error: null, model_route: `${effProvider ?? "继承"}/${effModel ?? "继承"}` };
    } catch (e) {
      // g-321：0.1.6 起 startContinuable 有并发槽位上限（默认 8），把 ACTIVATION_LIMIT_REACHED
      // 翻译成可操作提示；其余错误原样透出 message（保留既有可追溯性）。
      return { childId: null, parentSessionId: null, error: subagentSpawnErrorText(e) };
    }
  };

  // ---- g-388：收集派发的有限收敛策略（工具 graph_start_attempt+card 与 REST start-collection 共用一套）----
  // 修复「collecting 共享卡重试收集会孤儿化子代理并丢失 child_id」：
  //   ① spawn 前准入（collectAdmissionBlock）：冲突在启动 child 之前就被拒 ⇒ 不产生任何孤儿 worker；
  //   ② spawn 后 bind 失败（bindCollectWithConvergence）：请求中断该 child 并把 child_id 带进结果/错误；
  //      中断能力缺失或中断本身失败时如实上报，绝不虚称「已停止」。
  // 有限收敛：只处理这一张卡的绑定与这一个 child 的中断，不 detach/supersede/改状态其它 card/goal/attempt，
  // 也不引入分布式租约（冲突判定复用 core assertCollectAdmission 的同一条件）。

  /** spawn 前准入门禁：返回可上报的 Error（共享卡已在 collecting）或 null（放行）。 */
  const collectAdmissionBlock = (rootForCard, goal, card) => {
    try {
      assertCollectAdmission(rootForCard, goal, card);
      return null;
    } catch (e) {
      return e;
    }
  };

  /** spawn 成功后的绑定 + 有限收敛。返回 { child_id, child_error, interrupted }：
   *  成功 → child_id 已绑定、child_error=null；失败 → child_id 始终保留（可追溯），
   *  child_error 说明「已启动但绑定失败」以及中断是否被请求/为何没能中断。 */
  const bindCollectWithConvergence = (rootForCard, goal, card, { started, parentSessionId, parentAgent, actor, provider, model }) => {
    const childId = started?.childId ?? null;
    try {
      bindCardChild(rootForCard, goal, card, {
        childId,
        parentSessionId: parentSessionId ?? null,
        actor,
        provider,
        model,
      });
      return { child_id: childId, child_error: null, interrupted: false };
    } catch (bindErr) {
      // 与 executor 派发的 g-237 收敛同构：先请求中断刚启动的 child（g-625 收口），再抛出携带
      // child_id 的可追溯错误。中断能力缺失/失败一律如实上报，绝不虚称「已停止」。
      const subagents = ctx.get?.("subagents");
      const pid = parentSessionId ?? started?.parentSessionId ?? null;
      const outcome = interruptChildCompat({ subagents }, { childId, parentSessionId: pid, parentAgent });
      return {
        child_id: childId,
        child_error: `收集子代理已启动（child ${childId}）但卡片绑定失败：${bindErr?.message ?? bindErr}；${outcome.note}`,
        interrupted: outcome.requested,
      };
    }
  };
  // 枚举派发选项（重新执行选择器用）：LLM provider 分组模型目录（ctx.llm 注册表）+ 默认（project.yaml executor）。
  // 注意区分两个 provider 概念：subagent provider（spawn/fork，子代理创建方式，用户不可选）与
  // LLM provider（deepseek/kimi，模型路由，用户可选）。此处只暴露 LLM 目录，避免用户把 spawn/fork 当模型路由。
  const readSpawnOptions = async (rootForReq, ws = null) => {
    let modelGroups = null;
    try {
      const llm = ctx.get?.("llm");
      if (llm?.listProviders) {
        const providers = (await llm.listProviders()) ?? [];
        modelGroups = await Promise.all(providers.map(async (p) => {
          const pid = typeof p === "string" ? p : (p?.id ?? p);
          const pname = typeof p === "string" ? p : (p?.name ?? pid);
          let models = [];
          try { models = (await llm.listModels?.(pid)) ?? []; } catch { models = []; }
          // g-231：对每个模型调用 resolveModelInfo 获取 reasoning 元数据（efforts/defaultEffort），
          // 与 dsh-api-session-controller buildModelCatalog 同源；单个 resolve 失败不拖垮整组。
          const entries = await Promise.all(models.map(async (m) => {
            const mid = typeof m === "string" ? m : m.id;
            const mname = typeof m === "string" ? m : (m.name ?? mid);
            const base = { id: mid, name: mname };
            try {
              if (typeof llm.resolveModelInfo === "function") {
                const resolved = await llm.resolveModelInfo(pid, mid);
                if (resolved?.reasoning && Array.isArray(resolved.reasoning.efforts)) {
                  base.reasoning = {
                    efforts: resolved.reasoning.efforts.map((e) => ({
                      id: e.id,
                      name: e.name,
                      ...(e.description === undefined ? {} : { description: e.description }),
                    })),
                    ...(resolved.reasoning.defaultEffort === undefined ? {} : { defaultEffort: resolved.reasoning.defaultEffort }),
                  };
                }
              }
            } catch { /* 单模型 resolve 失败，保留 id/name 不含 reasoning */ }
            return base;
          }));
          return { id: pid, name: pname, models: entries };
        }));
        if (!modelGroups.length) modelGroups = null;
      }
    } catch { modelGroups = null; }
    const def = readExecutorModel(rootForReq);
    const globalSettings = readGraphSettings();
    // g-133：默认路由展示 = project.yaml executor/project（优先）+ profile 全局默认（缺省）
    const eff = resolveModelRoute(null, def, globalSettings);
    const effModeRes = resolveSubagentMode(null, def.mode, globalSettings.subagentMode);

    // g-289：探测工作区/主工作树干净度并下发给客户端，指导 GUI 复选框与提示文案
    const inspectDir = ws || dirname(rootForReq);
    const cleanliness = detectWorkspaceCleanliness(inspectDir, undefined, rootForReq);

    return {
      modelGroups,
      modes: SUBAGENT_MODES.map((id) => SUBAGENT_MODE_SPECS[id]),
      default: { provider: eff.provider, model: eff.model, mode: effModeRes.mode, mode_source: effModeRes.source },
      workspaceState: {
        clean: cleanliness.clean,
        dirtyReason: cleanliness.clean === false ? cleanliness.dirtyReason : undefined,
        error: cleanliness.clean === null ? cleanliness.error : undefined,
      },
    };
  };

  // ===== g-507：/api/dsh-graph 命名空间的唯一受保护入口 =====
  // 注册态（webServer 轮询注册 + 插件内部路由表）。**必须先于下方 dispatcher 定义**声明：
  // dispatcher 在请求期读 `routeState.table`，若声明在其后，handler 首调用会落进 TDZ（ReferenceError）。
  const routeState = { registered: false, timer: null, table: null, described: null };

  // 缺陷：g-505 之前 63 条业务路由逐条裸注册到宿主 webServer（61 条省略 kind ⇒ 宿主按 prefix 处理），
  // 任何能连到该端口的一方都可无凭证读取看板、写入目标、派发/清理子代理。本段只做一件事：
  // **把业务路由移到一个统一门禁之后**，业务 handler 本身不改（仍用原有 Node req/res、ETag、流式上传）。
  //
  // 真实宿主契约（0.2.1-rc.2 只读核实；对外口径见 dsh-graph-host/README.md「HTTP 鉴权（Web 看板的 REST 入口）」一节）：
  //   - `ctx.get("connection")` 只返回**当前 active** 的 client-connection 服务；它晚到/消失/被重载时
  //     同一入口自动开始拒绝/恢复，不依赖注册时刻的服务快照（无「裸路由升级窗口」）。
  //   - `connection.admit(req)` 是**同步**方法，用宿主自己的签名凭证 + Host/Origin fence + live Peer
  //     判定，返回 `{peer}` 或 `{rejection: 401|403}`；它读 `this`（isTrusted/browserAuth/peers），
  //     **必须保留调用绑定**（`connection.admit(req)`，不得解构后裸调）。
  //   - `admit` 通过只代表「某个已认证 Peer」；本插件全部端点只服务宿主 owner
  //     （与宿主自己的 Fetch 路由 `peer.principal.kind !== "owner" ⇒ 403` 同口径），故必须再核 owner。
  //   - 不读 cookie 名称/前缀/值形状，不依赖 private browserAuth，不自建签名算法（拒绝一切形状回退）。

  /** 从 admission 结果里取 Peer（结构不成立返回 null）。**只读结构判定，不复制宿主凭证语义**。 */
  const admissionPeer = (admission) => {
    if (!admission || typeof admission !== "object") return null;
    const peer = admission.peer;
    if (!peer || typeof peer !== "object") return null;
    return peer;
  };
  const peerIsOwner = (peer) => {
    const principal = peer?.principal;
    return !!principal && typeof principal === "object" && principal.kind === "owner";
  };

  /**
   * g-507 统一准入：每个请求只调一次宿主公开 admit，返回拒绝状态或放行。
   *
   * 拒绝语义（错误响应绝不回显凭证或宿主内部异常细节，仅在 stderr 留一条不含请求头的诊断）：
   *   - 宿主明确拒绝（admission.rejection ∈ {401,403}）⇒ **沿用宿主状态码**（401 无凭证/凭证无效，
   *     403 Host/Origin/信任边界拒绝）；
   *   - 无 active connection、缺公开 admit、admit 抛错、admission 结构不可判定
   *     ⇒ **503 fail-closed**（能力不可判定时绝不放行业务）；
   *   - admit 通过但 Peer 不是 owner ⇒ 403（有效凭证、无本插件业务权限）。
   *
   * @param {import("node:http").IncomingMessage} req 原始 Node 请求（只用 headers，不读 body）。
   * @returns {{status: number, reason: string} | {peer: object}}
   */
  const admitRequest = (req) => {
    const connection = ctx.get?.("connection");
    const service = connection && typeof connection === "object" ? connection : null;
    if (!service) {
      return { status: 503, reason: "connection-service-unavailable", detail: "宿主 connection 服务未就绪：fail-closed" };
    }
    if (typeof service.admit !== "function") {
      return { status: 503, reason: "connection-admit-unavailable", detail: "宿主未提供公开 admit 能力（无法判定凭证）：fail-closed" };
    }
    let admission;
    try {
      // 保留 this 绑定：admit 读本服务的 isTrusted/browserAuth/peers，解构调用会让 this 丢失 ⇒ 抛错 ⇒ 503。
      admission = service.admit({ headers: req?.headers ?? {} });
    } catch {
      return { status: 503, reason: "connection-admit-failed", detail: "宿主 admit 抛错（能力不可判定）：fail-closed" };
    }
    if (!admission || typeof admission !== "object") {
      return { status: 503, reason: "connection-admission-malformed", detail: "宿主 admission 结果不可判定：fail-closed" };
    }
    const rejection = admission.rejection;
    if (rejection !== undefined) {
      if (rejection === 401 || rejection === 403) {
        // 信任边界拒绝已在 admit 内部完成，这里同样走「未认证」口径：不解析 body、不触达业务。
        return { status: rejection, reason: rejection === 401 ? "unauthenticated" : "trust-boundary-rejected" };
      }
      return { status: 503, reason: "connection-admission-malformed", detail: "宿主 admission 返回不可判定的拒绝码：fail-closed" };
    }
    const peer = admissionPeer(admission);
    if (!peer) {
      return { status: 503, reason: "connection-admission-malformed", detail: "宿主 admission 既无拒绝码也无 Peer：fail-closed" };
    }
    if (!peerIsOwner(peer)) return { status: 403, reason: "not-owner" };
    return { peer };
  };

  /** 写入一条安全拒绝响应：固定 JSON 形状，无凭证、无宿主内部异常文本。 */
  const rejectRequest = (res, decision) => {
    try {
      if (!res.headersSent && !res.writableEnded) {
        const body = JSON.stringify({ error: decision.reason, authentication: "required" });
        const headers = {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        };
        // 401 与宿主 /api 面一致走 WWW-Authenticate 提示；503 明确「能力不可判定」。
        if (decision.status === 401) headers["www-authenticate"] = "DSH-Connection";
        res.writeHead(decision.status, headers);
        res.end(body);
      } else {
        res.end();
      }
    } catch { /* 响应已不可写：忽略，绝不因此触达业务 */ }
  };

  /**
   * 唯一受保护入口的 handler：**先准入，后分发**。
   *
   * 「先准入」意味着认证之前只读得到 `req.method` / `req.url` 与 host 给予的 headers：
   * 不解析 body、不调用 rootForReq（其内部 init() 会写盘）、不读资产、不派发、不触达任何业务副作用。
   * 拒绝路径对未知子路径同样生效 —— 攻击者无法用「猜路径」区分「认证失败」与「路径不存在」。
   *
   * 认证通过后的分发口径（路径与 method 错配一律在认证之后判定，绝不因此跳过认证）：
   *   - exact 表命中 ⇒ 调该路由 handler（自身再判 method ⇒ 405）；
   *   - 否则按**段边界**最长 prefix 命中（`p === path || p.startsWith(path + "/")`，与宿主 match 同口径；
   *     段边界保证 `/api/dsh-graph/diagramX` 不会误中 diagram prefix 路由）；
   *   - `/api/dsh-graph` 自身已作为 exact 路由登记（看板首屏），故不参与 prefix 匹配；
   *   - query 不参与路径匹配（原样交给业务 handler 自行读取）；尾斜杠策略见 ROUTE_TABLE_TAIL_SLASH；
   *   - 未知子路径 ⇒ 404（认证后才返回，避免向未认证方泄漏命名空间结构）；
 *     尾斜杠与 query 的精确口径见 ROUTE_TABLE_TAIL_SLASH（exact 端点 `/` ⇒ 404；资产 prefix `/` ⇒ 业务 400）。
   *
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  const dispatchRequest = (req, res) => {
    const decision = admitRequest(req);
    if (decision.status !== undefined) {
      // 每条拒绝在 stderr 留**一条**无敏感信息的诊断（不含 header/cookie/异常文本）。
      process.stderr.write(`[dsh-graph-host] HTTP 鉴权拒绝 ${decision.status} ${decision.reason}${decision.detail ? `（${decision.detail}）` : ""}\n`);
      rejectRequest(res, decision);
      return;
    }
    // 路由表由 registerHttpRoutes 在**注册时刻**构建（空表 = 未注册，此时不注册即不会走到这里）。
    const table = routeState.table;
    if (!table) return json(res, 503, { error: "route-table-unavailable" });
    let pathname;
    try {
      pathname = new URL(req?.url ?? "", "http://dsh-graph.invalid").pathname;
    } catch {
      return json(res, 404, { error: "unknown endpoint" });
    }
    const exact = table.exact.get(pathname);
    if (exact) return exact.handler(req, res);
    let best = null;
    for (const def of table.prefixes.values()) {
      if (pathname !== def.path && !pathname.startsWith(`${def.path}/`)) continue;
      if (!best || def.path.length > best.path.length) best = def;
    }
    if (best) return best.handler(req, res);
    return json(res, 404, { error: "unknown endpoint" });
  };

  // webServer 路由定义（惰性：webServer 服务出现后才注册；headless 组合下静默跳过）
  const httpRoutes = () => [
    {
      path: "/api/dsh-graph/supervisor-session",
      handler: (req, res) => {
        try {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          const workspace = workspaceOf(req);
          if (typeof workspace !== "string" || !workspace.trim()) return json(res, 400, { error: "missing workspace" });
          const canonical = resolveCanonicalRoot(config, resolve(workspace));
          const session = readSupervisorSession(canonical.root);
          return json(res, 200, { supervisorSession: session });
        } catch (e) {
          return json(res, e instanceof GraphError ? 400 : 500, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      // g-506：关照状态（服务端唯一倒计时真源；客户端只派生显示）。
      path: "/api/dsh-graph/care/status",
      handler: (req, res) => {
        try {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          const workspace = workspaceOf(req);
          if (typeof workspace !== "string" || !workspace.trim()) return json(res, 400, { error: "missing workspace" });
          const canonical = resolveCanonicalRoot(config, resolve(workspace));
          const status = careStatusOf(canonical.root);
          if (!status) return json(res, 503, { error: "care_runtime_unavailable" });
          return json(res, 200, { ...status, workspace });
        } catch (e) {
          return json(res, e instanceof GraphError ? 400 : 500, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      // g-506：暂停/继续/重置（只作用当前主管当前工作区整组；经 g507 admit+owner 门禁）。
      path: "/api/dsh-graph/care/control",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          let body = {};
          try { body = await readBody(req); } catch (e) { return json(res, 400, { error: String(e?.message ?? e) }); }
          const workspace = workspaceOf(req, body);
          if (typeof workspace !== "string" || !workspace.trim()) return json(res, 400, { error: "missing workspace" });
          const action = body?.action;
          if (!(action === "pause" || action === "resume" || action === "reset")) {
            return json(res, 400, { error: "invalid action" });
          }
          if (!careRuntime || typeof careRuntime.control !== "function") {
            return json(res, 503, { error: "care_runtime_unavailable" });
          }
          const canonical = resolveCanonicalRoot(config, resolve(workspace));
          const result = careRuntime.control(canonical.root, action, {
            expectedRevision: typeof body?.expected_revision === "number" ? body.expected_revision : undefined,
            requestId: typeof body?.request_id === "string" ? body.request_id : undefined,
            actor: "web-ui",
          });
          if (result?.ok !== true) {
            const code = result?.code ?? "control_failed";
            const status = code === "workspace_unresolved" || code === "invalid_action" ? 400
              : code === "config_unavailable" || code === "care_runtime_unavailable" ? 503
                : 409;
            return json(res, status, { error: code, revision: result?.revision ?? null });
          }
          return json(res, 200, result);
        } catch (e) {
          return json(res, e instanceof GraphError ? 400 : 500, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph",
      handler: (_req, res) => {
        try {
          const sp = new URL(_req?.url ?? "", "http://x").searchParams;
          const includeArchived = sp.get("includeArchived") === "1" || sp.get("includeArchived") === "true";
          const lazy = sp.get("lazy") === "1" || sp.get("lazy") === "true";
          const meta = rootForReqMeta(_req);
          const cached = getCachedBoardPayload(meta.root, { includeArchived, lazy });
          const payload = { ...cached.payload };
          payload._diagnostics = {
            workspace: meta.workspace, graphRoot: meta.root, rootMode: meta.mode,
            canonicalWorkspace: meta.canonicalWorkspace,
          };
          if (meta.rootWarning) payload._diagnostics.rootWarning = meta.rootWarning;
          const payloadJson = JSON.stringify(payload);
          const etagPayload = { ...payload };
          delete etagPayload.generated_at;
          const etagPayloadJson = JSON.stringify(etagPayload);
          const etag = 'W/"' + createHash("sha256").update(etagPayloadJson).digest("hex") + '"';
          const rawIfNoneMatch = _req?.headers?.["if-none-match"] ?? _req?.headers?.["If-None-Match"];
          const ifNoneMatch = Array.isArray(rawIfNoneMatch) ? rawIfNoneMatch.join(",") : typeof rawIfNoneMatch === "string" ? rawIfNoneMatch : null;
          if (ifNoneMatch && matchIfNoneMatch(ifNoneMatch, etag)) {
            res.writeHead(304, { etag, "cache-control": "no-cache" }); res.end(); return;
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", etag, "cache-control": "no-cache" });
          res.end(payloadJson);
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/goal",
      handler: (req, res) => {
        try {
          const id = new URL(req.url ?? "", "http://x").searchParams.get("id");
          if (!id) return json(res, 400, { error: "missing id" });
          const meta = rootForReqMeta(req);
          const detail = goalDetail(meta.root, id);
          const discoveryWorkspace = meta.mode === "absolute-config" ? dirname(meta.root) : meta.canonicalWorkspace;
          detail.worktrees = discoverAttemptWorktrees(discoveryWorkspace, id, detail.attempts, meta.root);
          json(res, 200, detail);
        } catch (e) {
          json(res, 404, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-374 F2/F3：重写 results.md（旧版归档）。
    // 两种来源，共用同一个 core 写入器（路径/归档/空态策略唯一真源），无需用户去命令行或会话下指令：
    //  ① `llm: true`（推荐，负责人反馈：重新摘要是用户主动触发的，可以用 LLM）⇒ 派发**专用摘要子代理**
    //     （role=summarizer，流程对齐产品经理润色 goal）去读目标详情并调用写入工具落盘（source=llm）；
    //     本端点立即返回 `{ok, child_id, pending:true}`，不阻塞、不等待子代理；
    //  ② 省略 `llm` ⇒ 零 LLM 确定性兜底正文同步写盘（子代理不可用/失败时前端自动回退到这条）。
    {
      path: "/api/dsh-graph/refresh-results",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, content, source } = body;
          if (!goal || typeof goal !== "string") return json(res, 400, { error: "missing goal" });
          // 工具面已拒绝 llm+content（content 已是成品正文）；REST 侧同样判 400，避免静默丢弃 content。
          if (body.llm === true && typeof content === "string" && content.trim()) {
            return json(res, 400, { error: "llm 与 content 不能同时使用（content 已是成品正文，不需要再调 LLM）" });
          }
          const rRoot = rootForReq(req, body);
          if (body.llm === true) {
            const goalFile = findGoalFile(rRoot, goal);
            if (basename(goalFile) !== "goal.md") {
              return json(res, 400, { error: `暂存目标（backlog）没有目标目录，无法生成完成摘要：${goal}` });
            }
            // 成本/防抖（F5 第 5 条）：历史未变且现有摘要已是 LLM 版 ⇒ 直接命中缓存，**不再调用 LLM**。
            const cache = goalResultsCacheState(rRoot, goal);
            if (cache.cache_hit && body.force !== true) {
              return json(res, 200, {
                ok: true, pending: false, cached: true, goal, source: cache.source,
                file: cache.file, source_hash: cache.source_hash, content_hash: cache.content_hash,
              });
            }
            const { parent, error: parentError } = resolveSpawnParent(rRoot);
            const ac = new AbortController();
            req.on("close", () => ac.abort());
            const spawned = parentError
              ? { childId: null, error: parentError }
              : await startSummarizerChild(rRoot, goal, { parent, signal: ac.signal }, {
                workspace: workspaceOf(req, body) ?? dirname(rRoot),
                actor: "human:gui",
              });
            if (spawned.error) {
              // 失败降级（F5 第 4 条）：不抛错、不空手而归 ⇒ 立刻写 deterministic 并把原因写进机器头。
              const fb = refreshGoalResults(rRoot, goal, {
                actor: "human:gui",
                fallbackReason: `llm-unavailable: ${spawned.error}`,
              });
              return json(res, 200, {
                ok: fb.written, pending: false, fallback: true, goal, source: fb.source,
                fallback_reason: fb.fallback_reason, child_error: spawned.error,
                file: fb.file, archive: fb.archive, reason: fb.reason, ...fb,
              });
            }
            return json(res, 200, {
              ok: true, pending: true, goal, child_id: spawned.childId,
              model_route: spawned.model_route ?? null,
              digest_bytes: Buffer.byteLength(spawned.digest ?? "", "utf8"),
            });
          }
          const result = refreshGoalResults(rRoot, goal, {
            actor: "human:gui",
            content: typeof content === "string" ? content : null,
            source: typeof source === "string" ? source : null,
          });
          // 外部正文落盘 ⇒ 标记该目标待结束的 summarizer 项，避免其 child 结束时降级覆盖（复核 BLOCK-1）。
          if (result.written && typeof content === "string" && content.trim()) markSummarizerLanded(goal);
          // written=false 不是 HTTP 错误（空态/已跳过都是可预期的业务结果），由前端按 reason 显示。
          json(res, 200, { ok: result.written, pending: false, ...result });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-170：判据编辑保存端点（方案 A）——trim/去重/1..N 重排/保留注释；
    // base_items 乐观并发 token 不一致 → 409；force=true 时以本地内容覆盖（D8）。
    {
      path: "/api/dsh-graph/set-criteria",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, items, base_items, force } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          if (!Array.isArray(items) || items.some((it) => typeof it !== "string")) {
            return json(res, 400, { error: "items 必须是字符串数组" });
          }
          const result = updateCriteria(rootForReq(req, body), goal, {
            items,
            base_items: Array.isArray(base_items) ? base_items.map(String) : null,
            force: force === true,
            actor: "human:gui",
          });
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          // 并发冲突 → 409（客户端据 D8 自动以本地内容覆盖重试）
          if (e instanceof GraphConflictError) {
            return json(res, 409, { error: String(e?.message ?? e) });
          }
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-379：目标关系写入/解除/查询端点（落法 A：不新增 status）
    //   POST {goal, target, type, action:"add"|"remove", base_relations?, force?} → 幂等；并发不一致 409
    //   GET  ?goal=g-xxx                                     → 派生关系视图（只读）
    {
      path: "/api/dsh-graph/relations",
      handler: async (req, res) => {
        try {
          const body = req.method === "GET"
            ? Object.fromEntries(new URL(req.url, "http://localhost").searchParams)
            : await readBody(req);
          const rRoot = rootForReq(req, body);
          if (req.method === "GET") {
            const goal = body.goal;
            if (!goal) return json(res, 400, { error: "missing goal" });
            return json(res, 200, { ok: true, goal, ...goalRelationViews(rRoot, String(goal)) });
          }
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const { goal, target, type, base_relations, force } = body;
          const action = body.action === "remove" ? "remove" : "add";
          if (!goal || !target || !type) return json(res, 400, { error: "missing goal/target/type" });
          const mutate = action === "remove" ? removeRelation : addRelation;
          const result = mutate(rRoot, {
            from: String(goal),
            type: String(type),
            goal: String(target),
            actor: "human:gui",
            base_relations: Array.isArray(base_relations) ? base_relations.map(String) : null,
            force: force === true,
          });
          json(res, 200, { ok: true, action, ...result });
        } catch (e) {
          // 并发冲突 → 409（客户端刷新后重试；force=true 可本地覆盖）
          if (e instanceof GraphConflictError) {
            return json(res, 409, { error: String(e?.message ?? e) });
          }
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-109 写操作端点（POST，事件先行）
    // accept：非 force → requestAcceptReview 写 review.requested；force → resolveAccept(force) 直接落地
    {
      path: "/api/dsh-graph/accept",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, force, reason } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          if (force) {
            resolveAccept(rootForReq(req, body), goal, { actor: "human:gui", verdict: "accept", force: true, reason });
            json(res, 200, { ok: true });
          } else {
            const result = requestAcceptReview(rootForReq(req, body), goal, "human:gui");
            json(res, 200, { pending: true, goal: result.goal });
          }
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-109：resolve-accept 端点（供主管工具或调试用）
    {
      path: "/api/dsh-graph/resolve-accept",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, verdict, objection, force, reason, fast_track, machine_report } = body;
          if (!goal || !verdict) return json(res, 400, { error: "missing goal or verdict" });
          resolveAccept(rootForReq(req, body), goal, { actor: "human:gui", verdict, objection, force, reason, fast_track, machine_report });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/worktrees",
      handler: async (req, res) => {
        try {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          const url = new URL(req.url, "http://localhost");
          json(res, 200, { worktrees: listWorktrees(rootForReq(req), url.searchParams.get("goal") || undefined) });
        } catch (e) { json(res, e instanceof GraphError ? 400 : 500, { error: String(e?.message ?? e) }); }
      },
    },
    {
      path: "/api/dsh-graph/worktrees/clean",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          if (!body.id || body.confirm !== true) return json(res, 400, { error: "missing id or confirmation" });
          const result = cleanWorktree(rootForReq(req, body), String(body.id), "human:gui", true, childLiveState);
          if (result.ok) _clearWorktreeCache();
          json(res, result.ok ? 200 : 409, result);
        } catch (e) { json(res, e instanceof GraphError ? 400 : 500, { error: String(e?.message ?? e) }); }
      },
    },
    // g-77647351：transition 端点（拖放跨列触发状态迁移）
    {
      path: "/api/dsh-graph/transition",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, to, reason, force } = body;
          if (!goal || !to) return json(res, 400, { error: "missing goal or to" });
          transition(rootForReq(req, body), goal, to, { reason, force, actor: "human:gui" });
          json(res, 200, { ok: true });
        } catch (e) {
          // GraphError → 400（参照 /accept 模式但用 400 而非 500）
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-77647351：order 端点（排序持久化）
    {
      path: "/api/dsh-graph/order",
      handler: async (req, res) => {
        try {
          if (req.method === "GET") {
            const r = rootForReq(req);
            const orderFile = join(r, "order.json");
            try {
              const data = JSON.parse(readFileSync(orderFile, "utf8"));
              json(res, 200, data);
            } catch {
              json(res, 200, {});
            }
          } else if (req.method === "POST") {
            const body = await readBody(req);
            const r = rootForReq(req, body);
            const orderFile = join(r, "order.json");
            // workspace/root are routing metadata, not part of the persisted order map.
            const { workspace: _workspace, root: _root, ...order } = body;
            writeFileSync(orderFile, JSON.stringify(order, null, 2), "utf8");
            invalidateBoardCache(r);
            json(res, 200, { ok: true });
          } else {
            json(res, 405, { error: "method not allowed" });
          }
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-77647351：move-goal 端点（跨 lane 拖放触发归属变更）
    {
      path: "/api/dsh-graph/move-goal",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, to, version } = body;
          if (!goal || !to) return json(res, 400, { error: "missing goal or to" });
          moveGoal(rootForReq(req, body), goal, { to, version, actor: "human:gui" });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          const message = String(e?.message ?? e);
          // g-352：给「带附件（cards/attempts）不能回 backlog」一个**语言中立**的稳定错误码，
          // 客户端据此给本地化失败态（旧实现用中文子串匹配永远匹配不上，且会把中文原文漏进英文界面）。
          const errCode = /附件/.test(message) && /backlog/i.test(message) ? "move-to-backlog-has-attachments" : null;
          json(res, code, errCode ? { error: message, code: errCode } : { error: message });
        }
      },
    },
    {
      path: "/api/dsh-graph/edit-description",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, text } = body;
          if (!goal || typeof text !== "string") return json(res, 400, { error: "missing goal or text" });
          amendGoal(rootForReq(req, body), goal, { note: "直接编辑目标描述", appendDescription: text, actor: "human:gui" });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/rename-goal",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, title } = body;
          if (!goal || !title || typeof title !== "string") return json(res, 400, { error: "missing goal or title" });
          const result = renameGoal(rootForReq(req, body), goal, { title, actor: "human:gui" });
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // ===== g-105：记忆管理 REST 端点（供 Web 记忆管理页面手工管理） =====
    {
      path: "/api/dsh-graph/memory/list",
      handler: async (req, res) => {
        try {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          const r = rootForReq(req);
          const url = new URL(req.url, "http://localhost");
          const query = url.searchParams.get("query")?.trim() || "";
          const scope = url.searchParams.get("scope") || undefined;
          const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
          const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("page_size") || "20", 10)));

          let entries = readMemory(r);
          if (scope) {
            entries = entries.filter((e) => (e.scope ?? "on_demand") === scope);
          }
          if (query) {
            const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
            entries = entries.filter((e) => {
              const haystack = `${e.text} ${e.id} ${e.source_goal ?? ""} ${e.source_ref ?? ""}`.toLowerCase();
              return tokens.every((tok) => haystack.includes(tok));
            });
          }
          // 倒序排列（最新优先）
          entries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

          const total = entries.length;
          const totalPages = Math.ceil(total / pageSize) || 1;
          const offset = (page - 1) * pageSize;
          const paginated = entries.slice(offset, offset + pageSize);
          const toolsEnabled = isMemoryToolsEnabled(r);

          json(res, 200, {
            ok: true,
            memory: paginated,
            total,
            page,
            page_size: pageSize,
            total_pages: totalPages,
            tools_enabled: toolsEnabled,
          });
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/memory/add",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const r = rootForReq(req, body);
          const resEntry = addMemory(r, {
            kind: body.kind ?? "project",
            scope: body.scope ?? "on_demand",
            text: body.text,
            importance: body.importance !== undefined ? Number(body.importance) : undefined,
            source_goal: body.source_goal,
            source_ref: body.source_ref,
            actor: "human:gui",
          });
          // g-445：source_ref 幂等命中（deduped/skipped）同样如实回传，供管理面显示「未新增」
          json(res, 200, {
            ok: true,
            id: resEntry.id,
            entry: resEntry.entry,
            ...(resEntry.deduped ? { deduped: true } : {}),
            ...(resEntry.skipped ? { skipped: true } : {}),
            ...(resEntry.source_ref ? { source_ref: resEntry.source_ref } : {}),
            ...(resEntry.reason ? { reason: resEntry.reason } : {}),
          });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/memory/delete",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const r = rootForReq(req, body);
          const resRem = removeMemory(r, {
            old: body.id || body.old,
            reason: body.reason ?? "用户在管理界面手工删除",
            actor: "human:gui",
          });
          json(res, 200, { ok: true, id: resRem.id });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/memory/toggle-tools",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const r = rootForReq(req, body);
          const enabled = body.enabled === true;
          setMemoryToolsEnabled(r, enabled, "human:gui");
          json(res, 200, { ok: true, tools_enabled: enabled });
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/set-goal-tags",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, tags, base_tags, force } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          if (!Array.isArray(tags)) return json(res, 400, { error: "tags 必须是数组" });
          const result = setGoalTags(rootForReq(req, body), goal, { tags, base_tags, force, actor: "human:gui" });
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          const code = e instanceof GraphConflictError ? 409 : (e instanceof GraphError ? 400 : 500);
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      // g-612：goal 级预算（唯一真源 = goal meta.task_budget_seconds；null 清空继承）。
      // 与既有目标写入口相同：经 g507 admit 门禁 + human:gui actor；无额外仅 supervisor 限制。
      path: "/api/dsh-graph/set-goal-budget",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          if (!Object.hasOwn(body, "budget_seconds")) return json(res, 400, { error: "missing budget_seconds" });
          const r = rootForReq(req, body);
          const result = setGoalBudget(r, goal, { budget_seconds: body.budget_seconds, actor: "human:gui" });
          if (careRuntime && typeof careRuntime.notifyGoalBudgetChanged === "function") {
            try { careRuntime.notifyGoalBudgetChanged(r, goal, result.new_seconds); } catch { /* 降级不阻断 */ }
          }
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      // g-158/g-232：设置目标类型（含 patch/chore 微小改动类型），记 goal.type_changed 事件
      path: "/api/dsh-graph/set-goal-type",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, type } = body;
          if (!goal || !type || typeof type !== "string") return json(res, 400, { error: "missing goal or type" });
          const result = setGoalType(rootForReq(req, body), goal, { type, actor: "human:gui" });
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/add-card",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, title, kind, scope } = body;
          // g-183 返工 #1：kind 真正可选（goal-actions 不再发送 kind）；仅 goal/title 必填
          if (!goal || !title || typeof title !== "string") return json(res, 400, { error: "missing goal/title" });
          if (kind !== undefined && kind !== null && typeof kind !== "string") return json(res, 400, { error: "kind 必须是字符串" });
          const card = addCard(rootForReq(req, body), goal, { title, kind, scope, actor: "human:gui" });
          json(res, 200, { ok: true, card });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-275: 按卡片 id 读取单张卡片详情（支持共享卡及目标自有卡，供上下文抽屉在无 goalId 时读取共享卡）
    {
      path: "/api/dsh-graph/card",
      handler: async (req, res) => {
        try {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          const url = new URL(req.url ?? "", "http://x");
          const cardId = url.searchParams.get("id");
          const goalId = url.searchParams.get("goal");
          if (!cardId) return json(res, 400, { error: "missing id" });
          const root = rootForReq(req);
          if (goalId) {
            const detail = goalDetail(root, goalId);
            const card = (detail.cards ?? []).find((c) => c.id === cardId);
            if (!card) return json(res, 404, { error: `卡片不存在：${cardId}（目标 ${goalId}）` });
            return json(res, 200, { ok: true, card, goal: { id: detail.meta?.id ?? goalId, title: detail.meta?.title } });
          }
          const list = sharedCards(root);
          const card = list.find((c) => c.id === cardId);
          if (!card) return json(res, 404, { error: `共享卡不存在：${cardId}` });
          return json(res, 200, { ok: true, card });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-183: 共享卡管理端点（面板 CRUD / 引用 / 转换）
    {
      path: "/api/dsh-graph/shared-cards",
      handler: async (req, res) => {
        try {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          json(res, 200, { cards: sharedCards(rootForReq(req)) });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/create-shared-card",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { title, kind } = body;
          if (!title) return json(res, 400, { error: "missing title" });
          const card = createSharedCard(rootForReq(req, body), { title, kind, actor: "human:gui" });
          json(res, 200, { ok: true, card });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/attach-shared-card",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, card } = body;
          if (!goal || !card) return json(res, 400, { error: "missing goal or card" });
          addSharedCardRef(rootForReq(req, body), goal, card, "human:gui");
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/unreference-shared-card",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, card } = body;
          if (!goal || !card) return json(res, 400, { error: "missing goal or card" });
          removeSharedCardRef(rootForReq(req, body), goal, card, "human:gui");
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/delete-shared-card",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { card } = body;
          if (!card) return json(res, 400, { error: "missing card" });
          deleteSharedCard(rootForReq(req, body), card, { actor: "human:gui" });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/convert-card-to-shared",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, card } = body;
          if (!goal || !card) return json(res, 400, { error: "missing goal or card" });
          convertOwnedToShared(rootForReq(req, body), goal, card, { actor: "human:gui" });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/convert-card-to-owned",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, card } = body;
          if (!goal || !card) return json(res, 400, { error: "missing goal or card" });
          convertSharedToOwned(rootForReq(req, body), goal, card, { actor: "human:gui" });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-128: 删除上下文卡片端点
    {
      path: "/api/dsh-graph/delete-card",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, card } = body;
          if (!goal || !card) return json(res, 400, { error: "missing goal or card" });
          deleteCard(rootForReq(req, body), goal, card, { actor: "human:gui" });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-183：附件管理端点（列出/读取下载/存储/删除；路径安全与引用守卫由 core 层强制）
    // g-462：设计哲学交互图只读服务（本插件唯一的 text/html 路由）。
    // prefix 路由：尾段由 resolveDesignDiagramRequest 按白名单裁决（见模块顶部常量）。
    // 只读 `readFileSync`，没有任何写路径；命中即内联返回（图是随包发布的静态资产）。
    {
      kind: "prefix",
      path: DESIGN_DIAGRAM_ROUTE,
      handler: (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
          const decision = resolveDesignDiagramRequest(req.url);
          if (decision.status !== 200) return json(res, decision.status, { error: decision.reason });
          let body;
          try {
            body = readFileSync(new URL(`./diagrams/${decision.name}`, import.meta.url));
          } catch {
            // 白名单名合法但产物未随包发布（构建漏拷）⇒ 404，绝不回落到别的路径。
            return json(res, 404, { error: "diagram not packaged" });
          }
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": String(body.length),
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff",
          });
          if (req.method === "HEAD") { res.end(); return; }
          res.end(body);
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-481：使用说明弹窗的只读服务（提示词资产 md）。本插件第二条非 JSON 路由。
    // prefix 路由：尾段由 resolveHelpAssetRequest 按白名单裁决（见模块顶部常量）。
    // 只读 `readFileSync`，没有任何写路径；命中即内联返回。
    // g-496：路径取自**冻结注册表**（`helpAssetRelativePath`）—— g-496 起两层提示词资产已由
    // build.sh 合并进包内单一 `prompts/`，故注册路径统一为 `prompts/<name>`。**不拼接请求内容**，
    // 路径只能来自注册表（未注册 ⇒ 白名单已在上一行拦掉 ⇒ 此处必非 null）。
    {
      kind: "prefix",
      path: HELP_ASSET_ROUTE,
      handler: (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
          const decision = resolveHelpAssetRequest(req.url);
          if (decision.status !== 200) return json(res, decision.status, { error: decision.reason });
          const relativePath = helpAssetRelativePath(decision.name);
          if (!relativePath) return json(res, 404, { error: "unknown-asset" });
          let body;
          try {
            body = readFileSync(new URL(`./${relativePath}`, import.meta.url));
          } catch {
            // 白名单名合法但产物未随包发布（构建漏拷）⇒ 404，绝不回落到别的路径。
            return json(res, 404, { error: "help asset not packaged" });
          }
          res.writeHead(200, {
            "content-type": "text/markdown; charset=utf-8",
            "content-length": String(body.length),
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff",
          });
          if (req.method === "HEAD") { res.end(); return; }
          res.end(body);
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-481：帮助目录（工具清单 + 提示词资产清单）—— 注册真源投影，客户端零硬编码。
    {
      path: HELP_CATALOG_ROUTE,
      handler: (req, res) => {
        try {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          // 工具名从注册真源 `tools` 枚举（不硬编码），分类/简称/说明全部由 server-i18n 投影（zh/en 成对）。
          const names = tools.map((t) => t.def.name);
          return json(res, 200, {
            prompt_language: resolvePromptLanguage(readGraphSettings().promptLanguage, ctx),
            prompts: helpPromptAssetEntries(),
            // g-498：提示词资产的语义分类投影（顺序 + zh/en 标签）——客户端分组只依据这一份
            // 注册真源投影，不另抄文件清单；条目上的 `category` 为空串即「未分类」（仍须可见）。
            prompt_categories: helpPromptCategoryEntries(),
            categories: helpToolCategoryEntries(),
            tools: helpToolCatalogEntries(names),
            // g-489 结构守卫的**运行期**投影：分类表 ≡ 注册真源被破坏时非空，前端据此把工具清单页签判红。
            taxonomy_problems: helpToolTaxonomyProblems(names),
          });
        } catch (e) {
          return json(res, e instanceof GraphError ? 400 : 500, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/attachments",
      handler: (req, res) => {
        try {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          const root = rootForReq(req);
          const names = listAttachments(root);
          json(res, 200, { attachments: names, infos: names.map((n) => attachmentInfo(root, n)) });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-183 返工 #2：安全读取/下载附件（canonical containment + content-type；HTML/Markdown/SVG 强制下载不内联）
    {
      path: "/api/dsh-graph/attachment",
      handler: (req, res) => {
        try {
          const sp = new URL(req.url ?? "", "http://x").searchParams;
          const name = sp.get("name");
          if (!name || typeof name !== "string" || name.length > 512 || name.trim() === "") return json(res, 400, { error: "missing/invalid name" });
          const info = readAttachment(rootForReq(req), name);
          const disp = info.inline ? "inline" : "attachment";
          res.writeHead(200, {
            "content-type": info.contentType,
            "content-length": String(info.size),
            "content-disposition": `${disp}; filename*=UTF-8''${encodeURIComponent(basename(name))}`,
            "cache-control": "no-store",
          });
          res.end(info.buffer);
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/store-attachment",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const ct = String(req.headers?.["content-type"] ?? "");
          const isRaw = ct.includes("application/octet-stream") || ct.includes("application/x-www-form-urlencoded");
          const maxBody = isRaw ? MAX_ATTACHMENT_BYTES : MAX_ATTACHMENT_JSON_BYTES;
          // content-length 仅作快速失败；真正防护是流式累计上限（防无 header/伪造/ chunked）
          const cl = Number(req.headers?.["content-length"] || 0);
          if (cl > maxBody) return json(res, 400, { error: "content-length 超过大小上限" });
          let stored;
          let rRoot;
          // 原始二进制上传：body 即文件字节，文件名走 query/header `x-attachment-name`
          if (isRaw) {
            const sp = new URL(req.url ?? "", "http://x").searchParams;
            const name = sp.get("name") ?? req.headers?.["x-attachment-name"];
            if (!name || typeof name !== "string" || name.length > 512 || name.trim() === "") return json(res, 400, { error: "missing/invalid name" });
            rRoot = rootForReq(req);
            const raw = await readRawBodyCapped(req, MAX_ATTACHMENT_BYTES);
            stored = storeAttachment(rRoot, { name, bytes: raw, actor: "human:gui" });
          } else {
            const body = await readBodyCapped(req, MAX_ATTACHMENT_JSON_BYTES);
            const { name, content, base64 } = body;
            if (!name || typeof name !== "string" || name.length > 512 || name.trim() === "") return json(res, 400, { error: "missing/invalid name" });
            rRoot = rootForReq(req, body);
            if (typeof base64 === "string") {
              // base64 大小预检（避免解码后超限）
              const approx = Math.floor(base64.length * 3 / 4);
              if (approx > MAX_ATTACHMENT_BYTES) return json(res, 400, { error: "base64 大小超过上限" });
              stored = storeAttachment(rRoot, { name, base64, actor: "human:gui" });
            } else if (typeof content === "string") {
              stored = storeAttachment(rRoot, { name, content, actor: "human:gui" });
            } else {
              return json(res, 400, { error: "需要 content 或 base64（或原始二进制上传）" });
            }
          }
          const digest = attachmentInfo(rRoot, stored).digest;
          json(res, 200, { ok: true, name: stored, ref: formatAttachmentRef(stored), digest });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/delete-attachment",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { name } = body;
          if (!name || typeof name !== "string" || name.length > 512 || name.trim() === "") return json(res, 400, { error: "missing/invalid name" });
          deleteAttachment(rootForReq(req, body), name, { actor: "human:gui" });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/start-collection",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, card, prompt, provider, model, reasoning_effort } = body;
          if (!goal || !card) return json(res, 400, { error: "missing goal or card" });
          const rRoot = rootForReq(req, body);
          const eff = resolveModelRoute(
            { provider, model, reasoning_effort },
            readExecutorModel(rRoot),
            readGraphSettings(),
          );
          const effProvider = eff.provider;
          const effModel = eff.model;
           const effReasoningEffort = eff.reasoning_effort;
          const effRoute = (effProvider || effModel) ? `${effProvider ?? "继承"}/${effModel ?? "继承"}` : null;
          // g-183 返工 F：先完整校验（resolveCard 成员关系/backlog/卡状态权限）生成提示词，
          //  再创建 attempt/子代理——校验失败不得留下 attempt/事件副作用。
          // g-480：同工具入口口径——collector 派发提示词面随模块自适应（attachments 关 ⇒ 剔除附件工具提及）
          const fullPrompt = stripModuleToolMentions(formatCollectPrompt(rRoot, goal, card, prompt, resolvePromptLanguage(readGraphSettings().promptLanguage, ctx)), readModuleSwitchesForRoot(rRoot).disabledTools);
          // g-388：spawn 前准入——共享卡已在 collecting 时直接拒绝，绝不启动 child（与工具入口同一判定）。
          const admissionErr = collectAdmissionBlock(rRoot, goal, card);
          if (admissionErr) {
            return json(res, 200, { ok: true, card, attempt: null, child_id: null, child_error: String(admissionErr?.message ?? admissionErr), model_route: effRoute });
          }
          const spawned = await spawnChild(
            `graph:collect/${goal}/${card}`,
            fullPrompt,
            req,
            rRoot,
            { provider: effProvider, model: effModel, reasoning_effort: effReasoningEffort, role: "collector" },
          );
          let childId = spawned.childId;
          let childError = spawned.error;
          if (spawned.error) {
            console.error("[dsh-graph-host] start-collection 子代理启动失败:", spawned.error);
          } else {
            // 事件先行：card.collecting（bindCardChild 写 child_id/parent_session_id）。
            // g-242：collector 依托卡片生命周期协作，不创建虚假 attempt
            // g-388：绑定失败走同一套有限收敛（请求中断 + 保留 child_id），不再让 child_id 丢失。
            const bound = bindCollectWithConvergence(rRoot, goal, card, {
              started: { childId: spawned.childId, parentSessionId: spawned.parentSessionId },
              parentSessionId: spawned.parentSessionId,
              parentAgent: spawned.parent ?? null,
              actor: "human:gui",
              provider: effProvider,
              model: effModel,
            });
            childId = bound.child_id;
            childError = bound.child_error;
            if (bound.child_error) console.error("[dsh-graph-host] start-collection 卡片绑定失败:", bound.child_error);
          }
          json(res, 200, { ok: true, card, attempt: null, child_id: childId, child_error: childError, model_route: effRoute });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-168：定义/润色交给固定产品经理 Agent；不创建 attempt、不修改目标状态
    {
      path: "/api/dsh-graph/define-polish",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, goal_path, guidance } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          const rRoot = rootForReq(req, body);
          const goalFile = findGoalFile(rRoot, goal);
          const ws = workspaceOf(req, body) ?? dirname(rRoot);
          const goalRel = relative(ws, goalFile);
          const cfg = readExecutorModel(rRoot);
          // g-168/g-242 PM 提示词契约：包含 goal.md 工作区相对路径，要求先用 read 工具读取上述 goal.md 并附带指导意见
          const prompt = formatPmPrompt({ goalId: goal, goalRel, guidance, language: resolvePromptLanguage(readGraphSettings().promptLanguage, ctx) });
          const spawned = await spawnChild(`graph:define-polish/${goal}`, prompt, req, rRoot, {
            ...cfg,
            role: "pm",
          });
          if (spawned.error) return json(res, 200, { ok: false, child_error: spawned.error });
          json(res, 200, { ok: true, child_id: spawned.childId, model_route: spawned.model_route ?? null });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-109 / g-241：start-execution 端点——通过共享执行服务派发执行子代理
    {
      path: "/api/dsh-graph/start-execution",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, provider, model, reasoning_effort, mode, worktree, attempt_brief, task_type, baseline_commit, source_attempt, acceptance_items } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          const rRoot = rootForReq(req, body);
          const ws = workspaceOf(req, body) ?? dirname(rRoot);
          const { supervisorId, parent, error: parentError } = resolveSpawnParent(rRoot);
          const ac = new AbortController();
          req.on("close", () => ac.abort());
          const execRes = await dispatchExecutionAttempt({
            root: rRoot,
            workspace: ws,
            goal,
            entrypoint: "http",
            actor: "human:gui",
            executor: "agent:executor",
            parentAgent: parent,
            parentSessionId: supervisorId,
            signal: ac.signal,
            attempt_brief,
            task_type,
            baseline_commit,
            source_attempt,
            acceptance_items,
            provider,
            model,
            reasoning_effort,
            mode,
            worktree,
            force: body.force === true,
            child_id: body.child_id,
          });
          json(res, 200, {
            ok: true,
            attempt: execRes.attempt,
            child_id: execRes.child_id,
            child_error: execRes.child_error ?? (parent ? null : parentError),
            brief: execRes.brief,
            brief_source: execRes.brief_source,
            model_route: execRes.model_route,
            mode: execRes.mode,
            mode_source: execRes.mode_source,
            injected_cards: execRes.injected_cards,
            injected_handoffs: execRes.injected_handoffs,
            worktree: execRes.worktree,
            // g-406：同工具入口——HTTP/GUI 入口也是白名单构造，隔离判定必须一并回传。
            isolated: execRes.isolated,
            worktree_reason: execRes.worktree_reason ?? null,
            worktree_created: execRes.worktree_created === true,
            worktree_reused: execRes.worktree_reused === true,
            // g-437 P1：同工具入口（白名单两处同时登记）。
            baseline_commit: execRes.baseline_commit ?? null,
          baseline_source: execRes.baseline_source ?? null,
          baseline_ref: execRes.baseline_ref ?? null,
          baseline_version: execRes.baseline_version ?? null,
          baseline_fallback_reason: execRes.baseline_fallback_reason ?? null,
            // g-613：复用面同样两处登记（同工具入口）。
            ...(execRes.reused === true ? {
              reused: true,
              delivery: execRes.delivery ?? null,
              prompt_hash: execRes.prompt_hash ?? null,
              context_digest: execRes.context_digest ?? null,
              started: execRes.started === true,
              started_basis: execRes.started_basis ?? null,
              message_id: execRes.message_id ?? null,
              prior_attempt: execRes.prior_attempt ?? null,
            } : {}),
          });
        } catch (e) {
          // g-610：同目标仍在运行/首次启动未结算 ⇒ 409；其余准入错误维持 400；
          // g-507 的 401/403/503 在鉴权层先发生（本 catch 不会先于鉴权执行）。
          if (e instanceof GraphConflictError) {
            return json(res, 409, { error: String(e?.message ?? e) });
          }
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-436：start-review 端点——独立评审派发（与工具 graph_start_review 共用同一实现）。
    // 身份说明（如实）：HTTP 侧沿用既有 `human:gui`，它**不证明真人**；越权守卫只覆盖
    // 「可判定真实子代理身份」的正常工具通道，本端点不声称覆盖其它绕行路径。
    {
      path: "/api/dsh-graph/start-review",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, attempt, candidate_commit, baseline_commit, guidance, provider, model, reasoning_effort, mode } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          if (!attempt) return json(res, 400, { error: "missing attempt" });
          if (!candidate_commit) return json(res, 400, { error: "missing candidate_commit" });
          const rRoot = rootForReq(req, body);
          const ws = workspaceOf(req, body) ?? dirname(rRoot);
          const { supervisorId, parent, error: parentError } = resolveSpawnParent(rRoot);
          const ac = new AbortController();
          req.on("close", () => ac.abort());
          const res2 = await dispatchReview({
            root: rRoot,
            workspace: ws,
            goal,
            attempt,
            candidate_commit,
            baseline_commit,
            guidance,
            requestedBy: "human:gui",
            actor: "human:gui",
            parentAgent: parent,
            parentSessionId: supervisorId,
            signal: ac.signal,
            provider,
            model,
            reasoning_effort,
            mode,
          });
          json(res, 200, {
            ok: true,
            review_id: res2.review_id,
            reused: res2.reused,
            // F1：与工具入口同源的可见性字段（含 reused_current / stale / current_candidate_sha /
            // independent_ok / independent_missing），使 HTTP 调用方也能一眼看出「复用的是否当前候选」。
            reused_current: res2.reused_current,
            stale: res2.stale,
            goal: res2.goal,
            source_attempt: res2.source_attempt,
            candidate_sha: res2.candidate_sha,
            baseline_sha: res2.baseline_sha,
            review_workspace: res2.review_workspace,
            changed_paths: res2.changed_paths,
            current_candidate_sha: res2.current_candidate_sha,
            independent_ok: res2.independent_ok,
            independent_missing: res2.independent_missing,
            reviewer_child_id: res2.reviewer_child_id,
            status: res2.status ?? null,
            conclusion: res2.conclusion ?? null,
            model_route: res2.model_route ?? null,
            child_error: res2.child_error ?? (parent ? null : parentError),
          });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-109 判据反馈：重新执行选择器用——枚举 providers + 模型分组 + project.yaml 默认 + g-289 工作树干净度状态
    {
      path: "/api/dsh-graph/spawn-options",
      handler: async (req, res) => {
        try {
          const r = rootForReq(req);
          const ws = workspaceOf(req) ?? dirname(r);
          json(res, 200, await readSpawnOptions(r, ws));
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-132：读取/写回当前 workspace 的 project.yaml 安全配置（settings 弹窗）
    // g-207：POST 走 schema 严格校验（拒绝未知字段、隐式 coercion、类型不匹配）
    {
      path: "/api/dsh-graph/settings",
      handler: async (req, res) => {
        try {
          if (req.method === "POST") {
            const body = await readBody(req);
            const r = rootForReq(req, body);
            // g-207：schema 校验入口——拒绝未知字段、隐式 coercion、类型不匹配
            const v = validateSchema(body, settingsPostSchema);
            if (!v.valid) {
              const resp = schemaErrorResponse(v.errors);
              return json(res, 400, { error: resp.error, details: resp.details });
            }
            writeProjectConfig(r, body, "human:gui");
            return json(res, 200, { ok: true, config: settingsConfigForUi(r), trim_supported: moduleTrimSupported, review_suggested_regions: suggestedReviewRegions(r), automation_unset_scope: AUTOMATION_UNSET_SCOPE });
          }
          if (req.method === "GET") {
            // att-002：下发当前 canonical workspace 的 .dsh-graph/project.yaml 绝对路径
            //（客户端只消费服务端路径，禁止自行拼接 graphRoot）
            const meta = rootForReqMeta(req);
            // g-480：`trim_supported` = 本版本宿主是否支持真裁剪（见 apply 期能力探测注释）。
            // GUI 据此在「模块」页签如实显示一行提示（不支持时）；支持时**不渲染该行**。
            // g-505：`supervisor.keep_alive_effective` / `keep_alive_status` 由服务端补齐
            //（真实全局值 + 运行时能力/状态），GUI 只消费，不自备默认值副本。
            return json(res, 200, { ...settingsConfigForUi(meta.root), configFile: join(meta.root, "project.yaml"), trim_supported: moduleTrimSupported, review_suggested_regions: suggestedReviewRegions(meta.root), automation_unset_scope: AUTOMATION_UNSET_SCOPE });
          }
          return json(res, 405, { error: "method not allowed" });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-129: 新增创建目标端点
    {
      path: "/api/dsh-graph/create-goal",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { title, version, description, type } = body;
          if (!title || typeof title !== "string" || !title.trim()) {
            return json(res, 400, { error: "missing title" });
          }
          const r = rootForReq(req, body);
          const goalId = createGoal(r, { title: title.trim(), version, description, type, actor: "human:gui" });
          json(res, 200, { ok: true, goal: goalId });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-150: 设置/替换目标的最近指令
    {
      path: "/api/dsh-graph/set-directive",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, directive } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          if (directive === undefined || directive === null) return json(res, 400, { error: "missing directive" });
          if (typeof directive !== "string") return json(res, 400, { error: "directive 必须是 string 类型" });
          const rRoot = rootForReq(req, body);
          setGoalDirective(rRoot, goal, directive, "human:gui");
          json(res, 200, { ok: true, goal });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-260: 设置/替换目标的描述（就地编辑）
    {
      path: "/api/dsh-graph/set-description",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, description } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          if (description === undefined || description === null) return json(res, 400, { error: "missing description" });
          if (typeof description !== "string") return json(res, 400, { error: "description 必须是 string 类型" });
          const rRoot = rootForReq(req, body);
          setGoalDescription(rRoot, goal, description, "human:gui");
          json(res, 200, { ok: true, goal });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-150: 向目标追加评论
    {
      path: "/api/dsh-graph/add-comment",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, text } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          if (!text || typeof text !== "string" || !text.trim()) return json(res, 400, { error: "评论内容不能为空" });
          const rRoot = rootForReq(req, body);
          appendGoalComment(rRoot, goal, text, "human:gui");
          json(res, 200, { ok: true, goal });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-150: 通过 GUI 登记 handoff（单文件简化，新覆盖旧）
    {
      path: "/api/dsh-graph/record-handoff",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, source_attempts, failures, constraints, baseline, verification } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          if (!Array.isArray(source_attempts) || !source_attempts.length) return json(res, 400, { error: "source_attempts 不能为空" });
          if (!failures || !constraints || !baseline || !verification) return json(res, 400, { error: "failures/constraints/baseline/verification 不能为空" });
          const rRoot = rootForReq(req, body);
          const hfId = recordAttemptHandoff(rRoot, goal, {
            source_attempts, failures, constraints, baseline, verification,
            confirmed_by: "human:gui", actor: "human:gui",
          });
          json(res, 200, { ok: true, handoff: hfId });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-110: 归档目标端点
    {
      path: "/api/dsh-graph/archive",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          archiveGoal(rootForReq(req, body), goal, { actor: "human:gui", liveCheck: childLiveState });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-138: 暂缓目标端点（由详情弹窗二次确认后调用）
    {
      path: "/api/dsh-graph/postpone",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, reason } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          postponeGoal(rootForReq(req, body), goal, { actor: "human:gui", reason, liveCheck: childLiveState });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-110: 取消归档目标端点
    {
      path: "/api/dsh-graph/unarchive",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          unarchiveGoal(rootForReq(req, body), goal, { actor: "human:gui" });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-140: 删除已归档目标端点
    {
      path: "/api/dsh-graph/delete",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          deleteGoal(rootForReq(req, body), goal, { actor: "human:gui", liveCheck: childLiveState });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-190: 从目标解绑执行子代理端点（GUI 确认 + reason + 错误反馈；严格 schema + 坏 JSON 400）
    // 授权：GUI 即负责人（human:gui，owner）；能力约束 = 当前 binding token（board/goalDetail 下发，
    // 未知/过期/并发 CAS 失败一律 409 拒绝且不改数据；子代理仍在运行或状态不可确认时拒绝）。
    // g-282：遗留绑定缺失 binding_token 时支持显式声明 legacy: true 并必填 reason。
    {
      path: "/api/dsh-graph/unbind",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          let body;
          try {
            body = await readBody(req);
          } catch {
            return json(res, 400, { error: "请求体不是合法 JSON" });
          }
          const v = validateSchema(body, unbindPostSchema);
          if (!v.valid) {
            return json(res, 400, schemaErrorResponse(v.errors));
          }
          const isLegacy = body.legacy === true;
          const token = typeof body.token === "string" ? body.token : "";
          if (!isLegacy && !token) {
            return json(res, 400, { error: "缺少 token（非 legacy 解绑必须提供 token）" });
          }
          if (isLegacy && (!body.reason || typeof body.reason !== "string" || !body.reason.trim())) {
            return json(res, 400, { error: "遗留解绑必须提供 reason 说明原因" });
          }
          const goal = String(body.goal);
          const attempt = typeof body.attempt === "string" && body.attempt.length ? body.attempt : null;
          const childId = typeof body.child_id === "string" && body.child_id.length ? body.child_id : null;
          if ((attempt === null) === (childId === null)) {
            return json(res, 400, { error: "必须且只能指定一个选择器：attempt 或 child_id" });
          }
          const rRoot = rootForReq(req, body);
          const result = unbindGoalChild(rRoot, goal, {
            actor: "human:gui",
            token: token || null,
            legacy: isLegacy,
            attempt,
            childId,
            reason: typeof body.reason === "string" && body.reason.length ? body.reason : null,
            liveCheck: childLiveState,
          });
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          const code = e instanceof GraphConflictError ? 409 : (e instanceof GraphError ? 400 : 500);
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-282: 放弃 attempt 端点
    {
      path: "/api/dsh-graph/abandon-attempt",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          let body;
          try {
            body = await readBody(req);
          } catch {
            return json(res, 400, { error: "请求体不是合法 JSON" });
          }
          const v = validateSchema(body, abandonAttemptPostSchema);
          if (!v.valid) {
            return json(res, 400, schemaErrorResponse(v.errors));
          }
          const goal = String(body.goal);
          const attempt = String(body.attempt);
          const reason = String(body.reason);
          const rRoot = rootForReq(req, body);
          const result = abandonAttempt(rRoot, goal, {
            actor: "human:gui",
            attempt,
            reason,
            liveCheck: childLiveState,
          });
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          const code = e instanceof GraphConflictError ? 409 : (e instanceof GraphError ? 400 : 500);
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-134: 创建版本泳道端点
    {
      path: "/api/dsh-graph/create-version",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { slug, name } = body;
          if (!slug || typeof slug !== "string" || !slug.trim()) {
            return json(res, 400, { error: "missing slug" });
          }
          // 严格校验 name
          if (name !== undefined && (typeof name !== "string" || !name.trim())) {
            return json(res, 400, { error: "name must be a non-empty string" });
          }
          const r = rootForReq(req, body);
          const result = createVersion(r, { slug: slug.trim(), name, actor: "human:gui" });
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-134: 重命名版本泳道端点
    {
      path: "/api/dsh-graph/rename-version",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { slug, newSlug, newName } = body;
          if (!slug || typeof slug !== "string" || !slug.trim()) {
            return json(res, 400, { error: "missing slug" });
          }
          // 严格校验 newSlug 和 newName
          if (newSlug !== undefined && (typeof newSlug !== "string" || !newSlug.trim())) {
            return json(res, 400, { error: "newSlug must be a non-empty string" });
          }
          if (newName !== undefined && (typeof newName !== "string" || !newName.trim())) {
            return json(res, 400, { error: "newName must be a non-empty string" });
          }
          const r = rootForReq(req, body);
          const result = renameVersion(r, { slug: slug.trim(), newSlug, newName, actor: "human:gui" });
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-134: 删除版本泳道端点
    {
      path: "/api/dsh-graph/delete-version",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { slug } = body;
          if (!slug || typeof slug !== "string" || !slug.trim()) {
            return json(res, 400, { error: "missing slug" });
          }
          const r = rootForReq(req, body);
          const result = deleteVersion(r, { slug: slug.trim(), actor: "human:gui" });
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-135: 版本详情端点（弹窗展示摘要/范围/阻塞清单）
    {
      path: "/api/dsh-graph/version-detail",
      handler: async (req, res) => {
        try {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          const url = new URL(req.url, "http://localhost");
          const slug = url.searchParams.get("slug");
          if (!slug || !slug.trim()) {
            return json(res, 400, { error: "missing slug" });
          }
          const r = rootForReq(req);
          const result = versionDetail(r, slug.trim());
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-258: 版本目标明细端点（首屏懒加载按需拉取）
    {
      path: "/api/dsh-graph/version-goals",
      handler: async (req, res) => {
        try {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          const url = new URL(req.url, "http://localhost");
          const slug = url.searchParams.get("slug");
          if (!slug || !slug.trim()) {
            return json(res, 400, { error: "missing slug" });
          }
          const includeArchived = url.searchParams.get("includeArchived") === "1" || url.searchParams.get("includeArchived") === "true";
          const r = rootForReq(req);
          const goals = versionGoals(r, slug.trim(), { includeArchived });
          json(res, 200, { ok: true, slug: slug.trim(), goals });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-258: backlog 目标明细端点（首屏懒加载按需拉取）
    {
      path: "/api/dsh-graph/backlog-goals",
      handler: async (req, res) => {
        try {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          const url = new URL(req.url, "http://localhost");
          const includeArchived = url.searchParams.get("includeArchived") === "1" || url.searchParams.get("includeArchived") === "true";
          const r = rootForReq(req);
          const goals = backlogGoals(r, { includeArchived });
          json(res, 200, { ok: true, goals });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-135: 发布版本端点（负责人确认 → released guard → 版本投影更新）
    {
      path: "/api/dsh-graph/release-version",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { slug } = body;
          if (!slug || typeof slug !== "string" || !slug.trim()) {
            return json(res, 400, { error: "missing slug" });
          }
          const r = rootForReq(req, body);
          const result = releaseVersion(r, { slug: slug.trim(), actor: "human:gui" });
          json(res, 200, result);
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-135: 设置版本状态端点（working → active 等）
    {
      path: "/api/dsh-graph/set-version-status",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { slug, status } = body;
          if (!slug || typeof slug !== "string" || !slug.trim()) {
            return json(res, 400, { error: "missing slug" });
          }
          if (!status || typeof status !== "string" || !status.trim()) {
            return json(res, 400, { error: "missing status" });
          }
          const r = rootForReq(req, body);
          setVersionStatus(r, { slug: slug.trim(), status: status.trim(), actor: "human:gui", confirmed: body.confirmed === true });
          json(res, 200, { ok: true });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
  ];

  return ctx.effect(() => {
    // g-149 修复：不再在 apply 时以 process.cwd() 基准 init 骨架。
    // 有明确 config.root（绝对路径或显式覆盖）时，init 到该路径；
    // 有 sandboxPolicy.workspaceRoot 时，以该 workspace + config.root 解析后 init；
    // 否则推迟到首次 rootFor(ex)/rootForReq(req,body) 有明确 workspace 时才 init。
    // 这防止在 package 子目录、子 Agent cwd 等非项目根意外创建 .dsh-graph 骨架。
    const explicitRoot = config?.root;
    const sandboxWs = ctx.get?.("sandboxPolicy")?.workspaceRoot;
    if (explicitRoot && resolve(explicitRoot) === explicitRoot) {
      // 绝对 config.root：apply 时 init（管理员显式指定了数据位置）
      init(root);
    } else if (sandboxWs) {
      // 有 sandboxPolicy workspace：以 canonical 解析后 init（无论 config.root 是否显式）
      init(resolveCanonicalRoot(config, sandboxWs).root);
    }
    // 无 sandboxPolicy 且无显式绝对 root：推迟 init，
    // 等工具/REST 端点有 session/request workspace 时再 init。
    // 注册 supervisor 工作指南与使用指引为运行时技能（可选服务，缺失时静默）。
    // 在 apply 期初次注册（确保同步上下文有值）；若 settings 就绪且 promptLanguage 发生变化，自动更新注册。
    let unregisterSkills = [];
    registerGraphSkills = () => {
      const skills = ctx.get?.('skills');
      if (!skills) return;
      for (const unreg of unregisterSkills) {
        try { unreg?.(); } catch { /* 静默 */ }
      }
      unregisterSkills = [];
      const lang = resolvePromptLanguage(readGraphSettings().promptLanguage, ctx);
      try {
        const unreg = skills.register({
          name: 'dsh-graph-supervisor',
          description: lang === "en" ? 'dsh-graph Supervisor Agent work guide' : 'dsh-graph 主管 Agent 工作指南',
          source: 'dsh-graph-host',
          content: localizedPrompt("supervisor-guide", lang),
        });
        if (typeof unreg === "function") unregisterSkills.push(unreg);
      } catch { /* 静默 */ }
      try {
        const unreg = skills.register({
          name: 'dsh-graph',
          description: lang === "en" ? 'dsh-graph goal board: manage goals, criteria, cards, execution' : 'dsh-graph 目标看板：用 graph_* 工具管理目标/判据/卡片/执行',
          source: 'dsh-graph-host',
          content: localizedPrompt("usage", lang),
        });
        if (typeof unreg === "function") unregisterSkills.push(unreg);
      } catch { /* 静默 */ }
    };
    registerGraphSkills();

    const toolLanguage = resolvePromptLanguage(readGraphSettings().promptLanguage, ctx);
    const disposers = tools.map((t) =>
      ctx.tools.register({
        ...t.def,
        description: sT(`tool.${t.def.name}`, toolLanguage),
        output: objOut,
        execute: (args, exec) => t.run(args, exec),
      }),
    );

    // g-374 F1：注册完成摘要截获（宿主生命周期事件；O(1) 回调，非轮询 / 非 fs watcher）。
    // 特性探测：宿主无 ctx.on（不支持该事件面的旧宿主）⇒ **不注册、静默降级**（不写文件、不抛错、
    // 不影响 attempt 生命周期与既有功能）。engines 下界维持 >=0.1.5-rc.2，**不得抬高**。
    if (typeof ctx?.on === "function") {
      try {
        const off = ctx.on("subagent/end", captureAttemptResults);
        if (typeof off === "function") disposers.push(off);
      } catch { /* 事件名不被宿主支持 ⇒ 静默（特性探测） */ }
      // g-613：记录每个 child 的**代际观察值**（`subagent/start` 的 `runId`，宿主每次随机、不透明）。
      // 只用于「该 end 是否属于当前代际」的比较，**不**用来证明谁在跑、不写盘。
      try {
        const offStart = ctx.on("subagent/start", (info) => {
          try { recordEpoch(info?.id, typeof info?.runId === "string" ? info.runId : null); } catch { /* 忽略 */ }
        });
        if (typeof offStart === "function") disposers.push(offStart);
      } catch { /* 事件名不被宿主支持 ⇒ 静默（特性探测） */ }
    }

    // ==== g-505：主管会话上下文缓存保活（两阶段状态机）====
    // 判定真源在 core/keepalive.ts；这里只创建运行时并 start（事件监听 + 每 board 真实 deadline
    // 单次定时；配置变化检测上界 60s，不再有固定 105s 全局轮询）。
    // 首次自举不依赖「启动时已有 supervisorId」：start/事件从 project.yaml 重新解析主管会话，
    // 因此冷启动、晚到服务、换主管、HMR 重载都由同一路径处理。
    try {
      keepAliveRuntime = createKeepAliveRuntime({
        ctx,
        readGlobal: readGlobalKeepAliveState,
        resolveRoot: keepAliveRootOfWorkspace,
        defaultWorkspace: () => (isAbsoluteConfig ? config.root : (ctx.get?.("sandboxPolicy")?.workspaceRoot ?? null)),
      });
      keepAliveRuntime.start();
    } catch (e) {
      // 能力/依赖异常绝不影响工具、看板与既有生命周期事件；如实留痕。
      keepAliveRuntime = null;
      try { process.stderr.write(`[dsh-graph-host] 主管上下文缓存保活运行时未启动（已降级，不影响看板与工具）：${String(e?.message ?? e).slice(0, 160)}\n`); } catch { /* 忽略 */ }
    }

    // ==== g-506：子代理长任务关照（到期巡检 + 真实维护临界区投递 + 窄工具结果回传）====
    // 判定真源在 core/care.ts；运行时只采样真实运行态、抢占真 idle 投递、校验结论身份/新鲜度。
    try {
      careRuntime = createCareRuntime({
        ctx,
        readGlobal: readGlobalCareState,
        resolveRoot: keepAliveRootOfWorkspace,
        defaultWorkspace: () => (isAbsoluteConfig ? config.root : (ctx.get?.("sandboxPolicy")?.workspaceRoot ?? null)),
        readBoardPayload: (root) => {
          try { return getCachedBoardPayload(root, { lazy: true })?.payload ?? null; } catch { return null; }
        },
      });
      careRuntime.start();
    } catch (e) {
      careRuntime = null;
      try { process.stderr.write(`[dsh-graph-host] 长任务关照运行时未启动（已降级，不影响看板与工具）：${String(e?.message ?? e).slice(0, 160)}\n`); } catch { /* 忽略 */ }
    }

    // ==== g-480：模块开关的**工具面真裁剪** ====
    // 目标：关闭某模块后，该模块的受管工具**从模型可见的工具清单里真正消失**（不是 UI 隐藏）。
    //
    // 机制（g-482 实证，已在真实 GUI 会话上量到 82→81）：
    //   `ctx.on("agent/created", ({ agent }) => agent.ctx.tools.restrict({ deny }))`
    //   —— `restrict` 的语义是「限制**调用 agent scope** 继承到的 global 工具」。它**不沿 scope 链继承**
    //   ⇒ 本插件在插件层注册一个 `agent/created` 监听即可覆盖**宿主创建的每一个会话**（含主管会话与
    //   `dsh-subagent` 派发的每个子代理会话，因为后者也是经 `agents.create({ setup })` 建的 agent）。
    //   量测口 = `ctx.tools.schemas(agent)`（criterion 2 的可验证面）。
    //
    // 三条硬约束（缺一即事故）：
    //   ① **作用域过滤**：deny 名单里出现**祖先层（agent 平面）自有**的工具名时，restrict 会抛
    //      `unknown global tool`；而 setup 抛错会让**整个会话创建回滚**。因此候选名必须逐个用
    //      `tools.get(name)`（**全局视图**）与 `tools.get(name, agent)`（**该 agent 视图**）双向确认：
    //      只有「全局存在且对该 agent 可见」的名字才放进 deny。作用域自有注册永不出现在全局视图 ⇒ 被排除。
    //   ② **特性探测 + 静默降级**：旧宿主（或测试夹具）没有 `ctx.on` / `tools.restrict` ⇒ **不注册监听**、
    //      不抛错、不改变任何东西（51 个工具照常注册可见）。engines 下界维持 >=0.1.5-rc.2，**不得抬高**。
    //   ③ **注册期无条件**：apply 期 51 个 `graph_*` 工具**照常全部注册**（判据 4 的 51 红线），
    //      裁剪只发生在**会话可见面**，绝不写成「按配置跳过注册」——否则工具计数会随配置漂移。
    //
    // 开关读的是**会话自己 workspace** 的 project.yaml（per-session 读，跨 workspace 不串）。
    //   ④ **workspace 口径唯一**：一律 `agent.session.header.cwd` —— 与工具侧 `sessionWorkspace()`
    //      （:1440）以及三个 section 的读法**同源**（g-113 会话 workspace 跟随）。无 header.cwd ⇒
    //      **不裁剪**，也不兜底 `sandboxPolicy.workspaceRoot` / `process.cwd()`：三个 section 在渲染期
    //      同样只认 header.cwd，兜底会造成「工具面裁了、提示词面没裁」的新分歧。实测（真机 e2e）：
    //      `dsh-subagent` 的 `cwd` 参数只改**有效工作目录**，不改子会话 header.cwd ⇒ 子会话的开关与
    //      其 graph_* 工具落在**同一个** board root，二者一致。
    if (moduleTrimSupported) {
      try {
        const off = ctx.on("agent/created", (info) => {
          try {
            const agent = info?.agent ?? (info?.ctx?.tools ? info : null);
            const at = agent?.ctx?.tools;
            if (!agent || !at || typeof at.restrict !== "function") return;
            // 会话 workspace：优先 session.header.cwd（其它 section 同源口径）
            const cwd = agent?.session?.header?.cwd;
            if (!cwd) return;
            let switches = null;
            try {
              switches = resolveModuleSwitches(readProjectConfig(resolveCanonicalRoot(config, cwd).root));
            } catch {
              return; // 配置不可读 ⇒ 不裁剪（fail-safe：与未配置全开一致）
            }
            if (!switches.disabledTools.length) return; // 全开：一次 restrict 都不调（行为逐字节不变）
            // 作用域过滤（约束①）：只保留「全局存在 且 对该 agent 可见」的名字
            const deny = switches.disabledTools.filter((name) => {
              try {
                return typeof at.get === "function" && at.get(name) !== undefined && at.get(name, agent) !== undefined;
              } catch {
                return false;
              }
            });
            if (!deny.length) return;
            const dispose = at.restrict({ deny });
            if (typeof dispose === "function" && typeof agent.ctx?.effect === "function") {
              // 会话结束即撤销限制（restrict 的 disposer 精确还原，g-482 实证）
              try { agent.ctx.effect(() => dispose); } catch { /* 无法挂载 ⇒ 由会话销毁兜底 */ }
            }
          } catch (e) {
            // 绝不因裁剪失败影响会话创建（deny 名单已作用域过滤；此处兜底并留痕）
            process.stderr.write(`[dsh-graph-host] 模块裁剪跳过: ${e?.message ?? e}\n`);
          }
        });
        if (typeof off === "function") disposers.push(off);
      } catch { /* 事件名/能力不被宿主支持 ⇒ 静默降级（特性探测，51 个工具不受影响） */ }
    }

    // g-118：supervisor 守则自动注入（不依赖显式 skill 调用）——
    // g-118（负责人 2026-08-22 设计转向）：在所有会话注入**简短引导提示词**（非完整守则）。
    // systemPrompt.section 注册一个恒定渲染 GUIDE_HINT 的提示词段落：所有会话（主管/普通/
    // 执行子代理）都看到「如何 claim 新 supervisor + graph_help 命令存在」，内容轻量无害，
    // 只告知「如何」接管、不授予主管角色——完整 supervisor 守则绝不自动注入（仍走显式
    // skill dsh-graph-supervisor 调用），避免临时会话被注入主管角色而争抢 supervisor。
    // 方案 A 机制复用（调研结论）：section.text 渲染进 system prompt；此处无空文本分支，
    // 恒渲染 GUIDE_HINT（简短，token 成本 ~120 字）。
    // systemPrompt 服务可能晚激活（dsh-base bundle 行，激活时序不保证）：轮询注册。
    //
    // g-389：本插件注册的 section 全部是**字面量**，必须显式 `interpolate: false`。
    // 宿主 `renderPrompt` 默认解释 `{{变量}}`：section 正文里出现合法的模板示例（最典型是
    // standing memory —— 人类授权/Agent 自述里可能写着 `{{customer_name}}` 这类模板）时，
    // 未注册变量会抛 `unknown prompt variable` 并**阻断该 workspace 的会话**；恰好同名已注册
    // 变量则被**静默替换**（用户数据被篡改）。置 false 后正文逐字保留，**不要求用户转义或
    // 删除合法的记忆模板**（这是修复的硬要求，不是可用选项）。
    // 依据：本插件从不注册 prompt 变量（无 `sp.variable(...)`），也不注册 context，故没有任何
    // section 是真模板；宿主与其它插件的真模板 section 未被本插件改动，仍按原契约插值。
    // 审计范围（本插件自有 section，共 3 个，全部字面量）：
    //   ① dsh-graph-guide-hint（order 10）—— 本地化资产 guide-hint.<lang>.md；
    //   ② dsh-graph-supervisor-discipline（order 11）—— 本地化资产 discipline.<lang>.md；
    //   ③ dsh-graph-standing-memory（order 92）—— **用户/Agent 动态文本**（记忆库正文）。
    // 宿主兼容性（实测各版本 @deepseek-ai/dsh-system-prompt 真实 renderPrompt；dsh 与
    // system-prompt 版本锁步，peerDependencies 精确同版）：
    //   · 0.2.0-rc.2 / 0.1.6-alpha.1：认 `interpolate: false` ⇒ 逐字保留（修复生效）；
    //   · 0.1.5-rc.2 / 0.1.5-rc.3（= engines 下界一侧）：**忽略**该字段（旧 renderPrompt 无条件
    //     插值）⇒ 旧宿主上本修复不生效，含 `{{...}}` 的记忆仍会抛错/被替换；传该字段本身无害
    //     （旧宿主 assemble 只取 name/text，多余键被丢弃，不报错）。
    // 未验证范围：0.1.6-alpha.2 / 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1 仅做源码特征核对
    // （renderPrompt 含 `interpolate === false` 分支），未逐一实跑。
    const sectionState = { registered: false, timer: null };
    const registerGuideSection = () => {
      if (sectionState.registered) return;
      const sp = ctx.get?.("systemPrompt");
      if (!sp) return;
      try {
        disposers.push(sp.section({
          name: "dsh-graph-guide-hint",
          order: 10,
          interpolate: false, // g-389：字面量 section（本地化资产），逐字保留、不参与 {{变量}} 插值
          // g-480：按会话 workspace 的模块开关做工具名剔除（无 cwd 时**原样返回**——所有会话仍照常
          // 注入引导，g-118 的「无 agent/无 session 也渲染」语义不变）。
          text: (context) => {
            const hint = localizedPrompt("guide-hint", resolvePromptLanguage(readGraphSettings().promptLanguage, ctx));
            try {
              const cwd = context?.agent?.session?.header?.cwd;
              if (!cwd) return hint;
              return moduleTrimmedText(resolveCanonicalRoot(config, cwd).root, hint);
            } catch {
              return hint;
            }
          },
        }));
        // g-238：system prompt 渲染纯读化——section.text 渲染路径绝不 init（不创建目录/文件、
        // 不追加事件、不改变 supervisor 绑定）；初始化仅保留在显式 apply/写操作路径。
        // 同时引入按文件 mtime+size 失效的轻量缓存：文件指纹未变时复用上次渲染结果，
        // 避免每次渲染全量无效读 I/O；指纹变化（含记忆新增/替换/撤回、project.yaml 变更）
        // 立即重算，绝不缓存错 workspace（缓存键含 canonical.root）。
        const sectionRenderCache = new Map();
        const fileStamp = (file) => {
          try {
            const s = statSync(file);
            return `${s.mtimeMs}:${s.size}`;
          } catch {
            return null; // 文件缺失/不可读：按无数据处理
          }
        };
        // render 为纯读函数；deps 为该渲染依赖的文件列表（相对 canonical.root）
        const cachedRender = (cacheKey, canonicalRoot, deps, render) => {
          const stamp = deps.map((d) => fileStamp(join(canonicalRoot, d))).join("|");
          const hit = sectionRenderCache.get(cacheKey);
          if (hit && hit.stamp === stamp) return hit.value;
          const value = render();
          sectionRenderCache.set(cacheKey, { stamp, value });
          return value;
        };
        disposers.push(() => sectionRenderCache.clear());
        // g-439：读本 workspace 的六键 automation 配置数据（纯读、白名单过滤）。
        // 只认 human/ai；其余（未配置/畸形/非法枚举）一律按 null 处理 ⇒ **fail-closed 不产生任何指导**，
        // 绝不把无法判定的取值当作授权。读失败同样按全 null（不让配置读取异常吞掉既有纪律注入）。
        const readAutomationConfig = (canonicalRoot) => {
          const out = {};
          let auto = null;
          try {
            auto = readProjectConfig(canonicalRoot)?.supervisor?.automation ?? null;
          } catch {
            auto = null;
          }
          for (const k of AUTOMATION_GUIDANCE_KEYS) {
            const v = auto?.[k];
            out[k] = v === "human" || v === "ai" ? v : null;
          }
          return out;
        };
        // g-480：按**当前会话 workspace** 读模块开关（纯读；按 project.yaml 指纹失效缓存 ⇒ 关/开即时
        // 生效、跨 workspace 不串）。读失败一律按「全开」（`resolveModuleSwitches(null)`）——
        // 绝不因配置读取异常静默砍掉能力或提示词。
        const readModuleSwitchesFor = (canonicalRoot) => cachedRender(
          `mod:${canonicalRoot}`, canonicalRoot, ["project.yaml"],
          () => {
            try { return resolveModuleSwitches(readProjectConfig(canonicalRoot)); } catch { return resolveModuleSwitches(null); }
          },
        );
        // 本插件自有 section 的**统一出口**：关闭模块的受管工具名按行剔除（对**动态**记忆正文里的
        // 提及同样生效）；全开时 `stripModuleToolMentions` 原样返回**同一字符串** ⇒ diff=0。
        const moduleTrimmedText = (canonicalRoot, text) =>
          stripModuleToolMentions(text, readModuleSwitchesFor(canonicalRoot).disabledTools);
        // g-131：主管会话每 turn 自动注入简短纪律提醒（仅主管会话）。
        // g-149：使用 resolveCanonicalRoot 确保 worktree 会话也能正确读到主树 project.yaml
        // text(context) 里取 sessionId=context?.agent?.session?.id；
        // 再取 cwd=context?.agent?.session?.header?.cwd（当前会话 workspace）；
        // 用 resolveCanonicalRoot(config, cwd) 得该项目 canonical .dsh-graph；readSupervisorSession(该项目root)；
        // supervisorId===sessionId 时返回 SUPERVISOR_DISCIPLINE，否则空。
        // cwd 缺失则不注入（避免误注入）。
        disposers.push(sp.section({
          name: "dsh-graph-supervisor-discipline",
          order: 11,
          interpolate: false, // g-389：字面量 section（本地化资产），逐字保留、不参与 {{变量}} 插值
          text: (context) => {
            try {
              const sessionId = context?.agent?.session?.id;
              if (!sessionId) return "";
              // 读当前会话 workspace 的项目 canonical .dsh-graph/project.yaml 的 supervisor.session
              const cwd = context?.agent?.session?.header?.cwd;
              if (!cwd) return ""; // cwd 缺失则不注入（避免误注入）
              const canonical = resolveCanonicalRoot(config, cwd);
              // g-238：纯读——不 init；.dsh-graph/project.yaml 不存在时 readSupervisorSession 返回 null
              // g-439：缓存的是**配置数据**（主管身份 + 六键 automation），语言渲染在缓存之外 ⇒
              // 同一份数据按当前语言现渲染（zh/en 切换立即生效，不冻结语言）；配置更新/删除后
              // project.yaml 指纹变化 ⇒ 缓存失效 ⇒ 六键回到 null 即恢复既有指导（逐字不变）。
              const supConfig = cachedRender(`sup:${canonical.root}`, canonical.root, ["project.yaml"],
                () => ({
                  supervisorId: readSupervisorSession(canonical.root),
                  automation: readAutomationConfig(canonical.root),
                }));
              if (!supConfig || !supConfig.supervisorId || supConfig.supervisorId !== sessionId) return "";
              const language = resolvePromptLanguage(readGraphSettings().promptLanguage, ctx);
              // g-480：`automation_prompts` 关闭 ⇒ **不追加**六键自动化指导段（纪律正文原样保留）；
              // 全开/未配置 ⇒ 拼接方式与改造前逐字相同（diff=0）。
              const automationOn = readModuleSwitchesFor(canonical.root).switches.automation_prompts.on !== false;
              return moduleTrimmedText(canonical.root,
                "\n" + localizedPrompt("discipline", language)
                + (automationOn ? renderAutomationGuidance(supConfig.automation, language) : ""));
            } catch {
              return "";
            }
          },
        }));
        // g-105：常驻记忆（standing）作为独立章节固定植入所有会话系统 Prompt
        // g-238：纯读 + 按 memory/memory.jsonl 指纹失效缓存（撤回/新增/替换立即生效）
        // g-389：**必须** interpolate:false —— 记忆正文是用户/Agent 动态文本，可能包含合法模板
        // 示例（{{customer_name}} 等）；默认插值会抛 unknown prompt variable 阻断会话，或静默
        // 替换同名变量。逐字保留，不要求用户转义/删除。
        ctx.effect(() => sp.section({
          name: "dsh-graph-standing-memory",
          order: 92,
          interpolate: false, // g-389：字面量 section（用户动态记忆正文），逐字保留
          text: (context) => {
            try {
              const cwd = context?.agent?.session?.header?.cwd;
              if (!cwd) return "";
              const canonical = resolveCanonicalRoot(config, cwd);
              // g-480：`memory` 关闭 ⇒ 常驻记忆段**整段不注入**（不删任何记忆数据；`graph_memory_*`
              // 工具同时已从模型可选集移除）。全开/未配置 ⇒ 与改造前逐字相同。
              if (readModuleSwitchesFor(canonical.root).switches.memory.on === false) return "";
              // g-252：此路径**不传 actor**（host 侧此处无可靠会话身份）⇒ recallMemory 会过滤掉
              // 全部 kind:"user" 条目（owner 隔离）：user 常驻记忆在本路径等价「仅按需 recall」，
              // 这是有意语义。若将来要按 actor 注入，必须同时把 actor 纳入下方 cachedRender 的
              // 缓存键（现在是 `mem:${root}`），否则同一 root 的不同 actor 会拿到同一份渲染结果 ⇒ 跨 actor 泄漏。
              return moduleTrimmedText(canonical.root, cachedRender(`mem:${canonical.root}`, canonical.root, ["memory/memory.jsonl"],
                () => formatStandingMemorySection(canonical.root) ?? ""));
            } catch {
              return "";
            }
          },
        }));
        sectionState.registered = true;
        process.stderr.write(`[dsh-graph-host] guide hint section 已注册（所有会话注入引导提示词，root=${root}）\n`);
        process.stderr.write(`[dsh-graph-host] supervisor discipline section 已注册（仅主管会话注入纪律提醒，按会话 workspace 解析）\n`);
      } catch (e) {
        console.error("[dsh-graph-host] guide hint section 注册失败:", e?.message ?? e);
      }
    };
    registerGuideSection();
    if (!sectionState.registered) {
      let sectionTicks = 0;
      const pollSection = () => {
        if (sectionState.registered) return;
        sectionTicks++;
        registerGuideSection();
        if (sectionState.registered) return;
        if (sectionTicks >= 40) return; // 20s 上限；无 systemPrompt 的组合静默跳过（skill 目录兜底）
        sectionState.timer = setTimeout(pollSection, 500);
        sectionState.timer.unref?.();
      };
      pollSection();
    }

    // webServer 由 web-app 行提供，可能在 apply 之后才激活：轮询注册（同参考实现）。
    // g-507：整个插件命名空间**只注册一个** prefix 入口（dispatchRequest 内含 admit + owner 门禁）；
    // 63 条业务定义只进插件内部路由表，**不再逐条注册** ⇒ 不可能存在绕过门禁的裸业务路由。
    const registerHttpRoutes = () => {
      if (routeState.registered) return;
      const webServer = ctx.get?.("webServer");
      if (!webServer) return;
      try {
        // 路由表在注册时刻构建一次（重复 path / 越界 path / 缺 handler 判错 ⇒ 不注册，见 catch）。
        const defs = httpRoutes();
        const table = buildRouteTable(defs);
        // 测试用的只读快照（仅 path + kind）：让「测试全集 ↔ 实现全集」可以双向对账，且不暴露 handler。
        // 必须放在真实注册之前 —— 若注册失败，快照也不会留下「看起来已注册」的状态。
        routeState.described = describeRoutes(defs);
        routeStateForReport.described = routeState.described;
        routeState.table = table;
        const disposer = webServer.register({ kind: "prefix", path: API_NAMESPACE, handler: dispatchRequest });
        disposers.push(disposer);
        routeState.registered = true;
        process.stderr.write(
          `[dsh-graph-host] apply: tools + ${API_NAMESPACE} 单一受保护入口已注册`
          + `（exact=${table.exact.size} prefix=${table.prefixes.size}；root=${root}）\n`,
        );
      } catch (e) {
        console.error("[dsh-graph-host] webServer 路由注册失败:", e?.message ?? e);
      }
    };
    registerHttpRoutes();
    if (!routeState.registered) {
      // webServer 由 web-app 行提供，可能在 apply 之后才激活：轮询注册（同参考实现）。
      // 首段用 100ms 密轮询（web 启动竞态：server 就绪时路由应已注册），10 次后转 500ms 疏轮询，20 秒兜底。
      // 链式 setTimeout（setInterval 延迟创建后不可变）；unref 不阻止进程退出（测试/CLI 场景）。
      let ticks = 0;
      const poll = () => {
        if (routeState.registered) return;
        ticks++;
        registerHttpRoutes();
        if (routeState.registered) return;
        if (ticks >= 40) return; // 10×100ms + 30×500ms ≈ 16s 上限；无 webServer 组合静默跳过
        routeState.timer = setTimeout(poll, ticks >= 10 ? 500 : 100);
        routeState.timer.unref?.();
      };
      poll();
    }

    // 加载自测（marker）：证明在 DSH 进程内 core 可用、工具已注册
    if (config?.marker) {
      const found = tools.map((t) => t.def.name).filter((n) => ctx.tools.get(n));
      let validateResult = "PASS";
      try {
        const problems = validate(root);
        if (problems.length > 0) validateResult = problems.join(" | ");
      } catch (e) {
        validateResult = `ERROR: ${e?.message ?? e}`;
      }
      writeFileSync(
        config.marker,
        JSON.stringify({ plugin: name, tools: found, validate: validateResult }, null, 2),
      );
    }
    return () => {
      closeWatchers();
      invalidateBoardCache();
      routeState.described = null;
      routeStateForReport.described = null;
      if (routeState.timer) clearTimeout(routeState.timer);
      if (sectionState.timer) clearTimeout(sectionState.timer);
      // g-505：卸载/HMR ⇒ 先停保活（clear timer、abort 在途、解绑事件、清内存快照），再释放其余。
      try { keepAliveRuntime?.dispose(); } catch { /* 卸载路径绝不抛 */ }
      try { careRuntime?.dispose(); } catch { /* 卸载路径绝不抛 */ }
      keepAliveRuntime = null;
      disposers.forEach((d) => d());
    };
  });
}
