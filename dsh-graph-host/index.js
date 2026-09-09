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
import { createHash } from "node:crypto";
import { relative, join, resolve, dirname, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGoal,
  normalizeGoalType,
  setCriteria,
  updateCriteria,
  setGoalTags,
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
  reportStatus,
  reportSupervisorStatus,
  readSupervisorStatus,
  readSupervisorStatusAt,
  generateHandoff,
  claimSupervisor,
  bindAttemptChild,
  moveGoal,
  amendGoal,
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
  formatTargetContext,
  requestAcceptReview,
  resolveAccept,
  archiveGoal,
  unarchiveGoal,
  deleteGoal,
  postponeGoal,
  boardProjection,
  readSupervisorSession,
  readExecutorModel,
  findGoalFile,
  init,
  boardPayload,
  goalDetail,
  loadGoal,
  bindCardChild,
  harvestedCards,
  formatHarvestedCardsSection,
  formatCollectPrompt,
  createSharedCard,
  addSharedCardRef,
  deleteSharedCard,
  removeSharedCardRef,
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
  resolvePromptOverride,
  readPromptOverrideValue,
  readProjectConfig,
  writeProjectConfig,
  listWorktrees,
  cleanWorktree,
  SUBAGENT_MODES,
  SUBAGENT_MODE_SPECS,
  DEFAULT_SUBAGENT_MODE,
  normalizeSubagentMode,
  SUBAGENT_MODE_PROMPTS,
  resolveSubagentMode,
  toolFilterForMode,
  SUBAGENT_ROLES,
  normalizeSubagentRole,
  toolFilterForRole,
  getRoleProfile,
  formatPmPrompt,
  formatReviewPrompt,
  validateSchema,
  schemaErrorResponse,
  settingsPostSchema,
  unbindPostSchema,
  unbindGoalChild,
  getCachedBoardPayload,
  matchIfNoneMatch,
  invalidateBoardCache,
  closeWatchers,
} from "./core/ops.js";
import { resolveRoot, resolveCanonicalRoot, _clearCanonicalRootCache } from "./core/root.js";
import { sT } from "./lib/server-i18n.js";
// g-133：接入 DSH profile 级用户设置（dsh-settings）。为避免在 @deepseek-ai/* 不可解析的上下文
// （工作树 link、仅 headless、无 settings 供应商的组合）导致整个插件加载失败、拖垮 GUI，
// 这里不静态 import @deepseek-ai/*；改为在 apply() 内**守卫式动态 import** schemastery（仅 schema），
// settings 服务经 ctx.inject(["settings"]) 等待（参照已上线的 dsh-subagent-model-picker）。
// 解析失败或 settings 服务缺失时优雅降级：namespace 不注册、看板/工具/模型路由不受影响。

// g-112：两半共用同一 root 解析函数（re-export 供验收/测试直接核对函数同一性）
export { resolveRoot } from "./core/root.js";
// g-149：canonical root 解析（Git linked-worktree 归一化）
export { resolveCanonicalRoot, _clearCanonicalRootCache } from "./core/root.js";
// g-111 B7：boardPayload 已移入 core（消除 client→host 跨包依赖），此处 re-export 保持兼容。
// board 载荷含 supervisorSession 字段（project.yaml 的 supervisor.session，g-108），由 host 端点 /api/dsh-graph 下发。
export { boardPayload } from "./core/ops.js";

// g-183 返工 v4：流式上限（防无 header/伪造 Content-Length/chunked 的超大请求先进内存被拒）。
// JSON/base64 envelope 上限需容纳 50MB 二进制 base64 编码开销（~4/3）+ JSON 键，但拒绝更大。
export const MAX_ATTACHMENT_JSON_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES * 5 / 3) + 1024 * 1024;
// 普通 JSON REST（add-card/start-collection/unreference/转换/delete 等）统一 body 上限（1MB 足够管理类 payload）。
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

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

const text = (s) => [{ type: "text", text: s }];
const objOut = {
  schema: { type: "object" },
  render: (_a, v) => text(JSON.stringify(v, null, 2)),
};
const str = { type: "string" };
const strArr = { type: "array", items: { type: "string" } };

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
const GRAPH_SETTINGS_DEFAULTS = Object.freeze({
  subagentProvider: "",
  subagentModel: "",
  subagentMode: "",
  subagentReasoningEffort: "",
  subagentPrompt: "",
  promptLanguage: "follow",
});
// schema 需 schemastery（@deepseek-ai/*），经守卫式动态 import 构建（见 buildGraphSettingsSchema）。
function buildGraphSettingsSchema(z) {
  return z.object({
    subagentProvider: z.string().default(""),
    subagentModel: z.string().default(""),
    subagentMode: z.union(["", "standard", "minimal"]).default(""),
    subagentReasoningEffort: z.string().default(""),
    subagentPrompt: z.string().default(""),
    promptLanguage: z.union(["follow", "zh", "en"]).default("follow"),
  });
}

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
  try {
    const locale = ctx?.locale ?? ctx?.get?.("locale");
    const snapshot = locale?.getLocale?.() ?? locale?.snapshot?.() ?? locale;
    const active = snapshot?.active ?? snapshot?.locale ?? snapshot?.id ?? locale?.active;
    if (typeof active === "string") {
      const base = active.toLowerCase().split(/[-_]/)[0];
      if (base === "en") return "en";
      if (base === "zh") return "zh";
    }
  } catch { /* locale service is optional */ }
  return "zh";
}

function readPromptAsset(name, language = "zh") {
  const lang = normalizePromptLanguage(language);
  for (const candidate of [`./prompts/${name}.${lang}.md`, `./prompts/${name}.zh.md`, `./${name}.${lang}.md`, `./${name}.zh.md`]) {
    try { return readFileSync(new URL(candidate, import.meta.url), "utf8"); } catch { /* fallback */ }
  }
  return "";
}

function localizedPrompt(name, language, legacy) {
  return readPromptAsset(name, language) || legacy;
}

const GUIDE = readPromptAsset("supervisor-guide", "zh");

// g-113：普通 agent 的 dsh-graph 使用指引（精简，非主管繁文）
const USAGE = [
  "dsh-graph 是把工作组织成「目标看板」的插件。你有 graph_* 工具可用：",
  "- graph_create_goal(title[, version]) 建目标（进 backlog，带 version 则排期）；",
  "- graph_set_criteria(goal, criteria[]) 先登记质量判据（判据先于执行，硬规则）；",
  "- graph_transition(goal, to[, reason]) 迁移状态；生命周期 draft→planning→collecting→ready→in_progress→review→delivered，另有 blocked（进 blocked 必须 reason）；",
  "- graph_add_card / graph_fill_card / graph_review_card / graph_delete_card 管理目标下的上下文卡片（信息收集）；",
  "- graph_start_attempt(goal) 派发执行子代理；graph_report_status(goal, attempt, status) 用一句 ≤20 字的话自报进展（看板卡片显示这句）；",
  "- graph_record_attempt_handoff(goal, source_attempts, failures, constraints, baseline, verification) 主管登记返工 handoff；",
  "- graph_archive_goal(goal) 归档目标（仅 draft/planning/delivered 可归档）；graph_unarchive_goal(goal) 取消归档；",
  "- graph_amend_goal(goal, note) 记录修订/人工反馈；graph_validate / graph_rebuild 校验与对账。",
  "原则：状态不是证据、产出物才是；关键阶段主动迁移卡片、自报状态；长任务节流心跳；不确定先问。",
].join("\n");

// g-118（负责人 2026-08-22 设计转向）：注入**简短引导提示词**（非完整守则）——
// 完整 supervisor 守则（supervisor-guide.md）不自动注入，仍走显式 skill 调用
// （dsh-graph-supervisor），避免临时会话被注入主管角色而争抢 supervisor。
// 注入内容只告知「如何」接管：claim 新 supervisor 的用法 + dsh-graph help 命令存在。
const GUIDE_HINT = [
  "dsh-graph 是把工作组织成「目标看板」的插件。本会话可用 graph_* 工具管理目标/判据/卡片/执行。",
  "【重要】本会话默认是普通会话，**不要自动接管 supervisor**（graph_claim_supervisor 只在负责人明确要求你接管时调用——自动接管会让临时会话争抢主管角色）。",
  "查看 dsh-graph 使用说明与 claim 指引：调用 graph_help。",
  "（完整 supervisor 工作守则不自动注入；如需，显式调用 skill dsh-graph-supervisor 加载。）",
].join("\n");

// g-131：主管会话每 turn 自动注入简短纪律提醒（仅主管会话）。
// 提醒内容强调主管铁律：只做规划/派发/把关/复核、实现交子代理、阶段变化与关键节点
// graph_report_supervisor_status、review→delivered 必须等负责人 verdict。
// token 成本约 80 字，简短精炼。
const SUPERVISOR_DISCIPLINE = [
  "⚠️ **主管纪律提醒**（每 turn 自动注入）：",
  "1. **只做规划、派发、把关、复核**——绝不自己实现常规功能大任务、一律派发子代理；",
  "2. **轻量改动自主特权**：一句话决策与低风险微小改动（patch / chore 类目标、一两行修改），主管可直接在当前会话使用 edit/write 执行，无需繁琐派发子代理；",
  "3. **阶段变化与关键节点自报进展**：调用 graph_report_supervisor_status（看板实时显示状态，常规细微动作无需机械汇报）；",
  "4. **记忆管理纪律**：自发总结默认记 on_demand；仅人类钦定或隔离禁令才记 standing（≤200字）；remove 仅限明确撤回/证实过时；",
  "5. **review→delivered 必须等负责人 verdict**——绝不自行 delivered；",
  "6. 完整守则见 skill dsh-graph-supervisor（显式调用加载）。",
].join("\n");


// g-118：dsh-graph help 命令内容源（graph_help 工具输出 + 引导提示词指向它）。
// 使用说明 + claim 指引；不含主管守则（完整守则仍在 supervisor-guide.md / skill）。
const HELP_TEXT = [
  "dsh-graph 是把工作组织成「目标看板」的插件。可用 graph_* 工具：",
  "- graph_create_goal(title[, version]) 建目标（进 backlog，带 version 则排期）；",
  "- graph_set_criteria(goal, criteria[]) 先登记质量判据（判据先于执行，硬规则）；",
  "- graph_transition(goal, to[, reason]) 迁移状态；生命周期 draft→planning→collecting→ready→in_progress→review→delivered，另有 blocked（进 blocked 必须 reason）；",
  "- graph_add_card / graph_fill_card / graph_review_card / graph_delete_card 管理目标下的上下文卡片（信息收集）；",
  "- graph_bind_collect_card(goal, card, child_id) 把收集子代理绑定到卡片；",
  "- graph_start_attempt(goal) 派发执行子代理；graph_report_status(goal, attempt, status) 用一句 ≤20 字的话自报进展；",
  "- graph_record_attempt_handoff(goal, source_attempts, failures, constraints, baseline, verification) 主管登记返工 handoff；",
  "- graph_amend_goal(goal, note) 记录修订/人工反馈；graph_validate / graph_rebuild 校验与对账；",
  "- graph_archive_goal(goal) 归档目标（仅 draft/planning/delivered 可归档）；graph_unarchive_goal(goal) 取消归档；",
  "- graph_report_supervisor_status(status) 主管自报状态（看板顶部状态栏）；graph_resolve_accept 评审裁决；",
  "- graph_handoff() / graph_claim_supervisor() 换会话交接。",
  "",
  "## 接管 supervisor",
  "**仅在负责人明确要求你接管 supervisor 时执行**——默认任何会话都不得自动 claim（避免临时会话争抢主管角色）：",
  "1. 旧会话：graph_handoff() —— 生成/更新 .dsh-graph/HANDOFF.md（board 投影 + 长期记忆 + 环境事实）；",
  "2. 新会话：graph_claim_supervisor() —— 把 project.yaml 的 supervisor.session 更新为当前会话 id，记 supervisor.claimed 事件（幂等），并返回 HANDOFF 全文。",
  "",
  "完整 supervisor 工作守则（阶段推进/信息收集/执行规范/环境事实等）见 skill dsh-graph-supervisor，显式调用加载。",
  "原则：状态不是证据、产出物才是；关键阶段主动迁移卡片、自报状态；长任务节流心跳；不确定先问。",
].join("\n");

// g-120：worktree 隔离指令（Supervisor 强制默认）——与 supervisor-guide.md 执行规范保持一致。
// graph_start_attempt / start-execution 默认注入本段；只有 supervisor 明确 override 才能跳过。
const WORKTREE_GUIDE = `【强制 worktree 隔离】本次任务默认必须在独立 worktree 中完成：专属 worktree 由 supervisor 预创建并登记（命名约定为 .worktrees/g-<goal-number>-att-<NN>，分支同名，基于当前版本集成分支）；子代理直接在给定工作树内工作，**绝不自行拉树、建分支、切分支、改分支**；未给定预登记树时按 brief 说明在当前指定工作区执行，不得自行补建。代码改动、测试及生成文件只能发生在该 worktree；**main 为只读已发布分支，禁止直接修改 main 或其他目标分支，也禁止自行以「简单改动」为理由绕过隔离**。完成后在 worktree 提交，等待 supervisor 复核；由 supervisor 合并到当前版本集成分支（如 <version>-test）。
【唯一例外】仅当 supervisor 在本次派发的 attempt brief 中明确写出 \`worktree=false\` 与理由时，才允许豁免独立 worktree；文档/长期记忆等小修改由 supervisor 自己处理，子代理不得擅自套用例外。即便 worktree=false，main 分支仍绝对只读，禁止直接修改 main。
【worktree 命名约定】supervisor 预创建并登记的 attempt 工作树统一遵循 .worktrees/g-<goal-number>-att-<NN> 规范，分支使用相同后缀（例如 g-125-att-03、g-163-att-03），消除歧义与分支冲突。
数据分工：代码改动在 worktree；看板数据 .dsh-graph/ 仍在主工作树写（graph_* 工具写的是主工作树的看板/事件流，不被 worktree 分支隔离，避免状态漂移）。`;

const MINOR_TASK_GUIDE = `【微小改动/轻量任务快速通道】当前目标属于 patch / chore 类型（低风险微改/轻量任务）：
- 豁免独立 worktree 隔离：允许直接在当前工作区与版本集成分支执行代码或文档修改，无需创建 .worktrees/ 隔离分支；
- 改动边界：严格限定于声明的微小改动范围，禁止产生无关副作用、禁止私自扩大破坏面；
- 验证与自报：改动后针对性跑通单测与校验，使用 graph_report_status 汇报并在完成后迁至 review 等待复核。`;

export function resolveWorktreeGuide(goalType, explicitWorktree, language = "zh") {
  if (explicitWorktree === false) return "";
  if (language === "en") {
    if (goalType === "patch" || goalType === "chore") return readPromptAsset("minor-task", "en") || MINOR_TASK_GUIDE;
    return readPromptAsset("worktree", "en") || WORKTREE_GUIDE;
  }
  if (explicitWorktree === true) return WORKTREE_GUIDE;
  if (goalType === "patch" || goalType === "chore") return MINOR_TASK_GUIDE;
  return WORKTREE_GUIDE;
}


const ATTEMPT_PROMPT_MISSING = "（未提供）";
const ATTEMPT_PROMPT_WARNING = "若本 prompt 同时含历史 handoff 与最新 brief，只执行 brief；handoff 不产生任何新任务。";

function promptText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** 防止注入文本中的保留标记伪装成当前 prompt 系统区块。 */
function protectPromptMarkers(value) {
  return String(value ?? "")
    .replace(/【本次任务定位】/g, "【文本中的本次任务定位】")
    .replace(/【覆盖声明】/g, "【文本中的覆盖声明】")
    .replace(/【历史约束·仅供理解，非任务】/g, "【文本中的历史约束】")
    .replace(/## 本次 attempt brief\/directive/g, "## 文本中的 attempt brief\/directive")
    .replace(/## 覆盖声明/g, "## 文本中的覆盖声明");
}

function renderPromptValue(value, missingReason) {
  const text = promptText(value);
  if (!text) return [ATTEMPT_PROMPT_MISSING, "> 未提供原因：" + missingReason].join("\n");
  return text.split("\n").map((line) => "> " + protectPromptMarkers(line)).join("\n");
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
function resolveEffectiveBrief(attemptBrief, directive, goalDesc) {
  const b = promptText(attemptBrief);
  if (b) return { brief: b, source: "brief" };
  const d = promptText(directive);
  if (d) return { brief: d, source: "directive" };
  // 两者均空：从目标描述生成默认 action
  const desc = promptText(goalDesc);
  if (desc) {
    // 截取目标描述前 200 字符作为默认 action，避免过长
    const truncated = desc.length > 200 ? desc.slice(0, 200) + "…" : desc;
    return { brief: `执行目标描述中的任务：${truncated}`, source: "auto_from_desc" };
  }
  // 目标描述也为空：最终兜底
  return { brief: "执行目标描述和质量判据中的任务", source: "fallback" };
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
  const lines = [
    "## 通用执行纪律",
    "",
    "以下内容是通用纪律与环境约束，不产生本次任务 action；本次 action 只来自当前 brief/directive。",
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
  lines.push(
    "",
    "【看板协同与状态流转】",
    "1. 泳道迁移（Human Gate）：",
    "   - 开工调用 graph_transition(goal=\"" + goalValue + "\", to=\"in_progress\")；阻塞调用 to=blocked 并说明原因；完成调用 to=review 停轮。",
    "   - 【禁区】绝不自行 graph_transition 到 \"delivered\"——delivered 是负责人/supervisor 的 human gate。",
    "2. 状态汇报（有限阶段触发，严禁每动作机械追加）：",
    "   - 仅在【开始开工】、【阶段转变/转向新任务】、【遇到阻塞】、【本轮完成待命】调用 graph_report_status(goal=\"" + goalValue + "\", attempt=\"" + attemptValue + "\", status=<简短状态>, state=working|blocked|done|error)。",
    "   - 长任务节流心跳；不再要求每个 read/bash 动作机械调用状态。",
    "   - 迁移被引擎拒绝时不得继续实现，立即上报停止。",
  );
  return lines.join("\n");
}

/** English counterpart of the execution prompt. User-provided brief/context remains verbatim. */
function formatAttemptPromptEnglish({ goal, attempt, goalRel, attemptBrief, directive, taskType, baselineCommit, sourceAttempt, acceptanceItems, handoffSection, cardsSection, targetContext, subagentPromptSection, modeStrategySection, worktreeBlock } = {}) {
  const missing = "(not provided)";
  const value = (v, reason) => {
    const text = promptText(v);
    return text ? text.split("\\n").map((line) => "> " + protectPromptMarkers(line)).join("\\n") : missing + "\\n> Reason: " + reason;
  };
  const compact = (v) => promptText(v) ? protectPromptMarkers(promptText(v).replace(/\\s*\\n\\s*/g, "; ")) : missing;
  const task = hasTaskType(taskType) ? taskType : taskType === null ? "not provided (task_type=null)" : "not provided (task_type missing or invalid; allowed: merge, rewrite, fix)";
  const items = Array.isArray(acceptanceItems) && acceptanceItems.length
    ? acceptanceItems.map((item, i) => `  ${i + 1}. ${protectPromptMarkers(String(item).trim())}`).join("\\n")
    : acceptanceItems === null ? "(none; supervisor explicitly passed null)" : acceptanceItems === undefined ? missing : "(none)";
  const history = [];
  if (promptText(handoffSection)) history.push(["## Historical handoff", "[Background only; not an action source]", protectPromptMarkers(handoffSection)].join("\\n"));
  history.push(["## Historical cards", "[Background only; not an action source]", promptText(cardsSection) ? protectPromptMarkers(cardsSection) : missing].join("\\n"));
  const contextPath = promptText(goalRel) || missing;
  const position = [
    `## Task positioning\\nThis is a ${task} task. Only the current attempt brief/directive below is an action source; history is background only.`,
    `You are execution attempt ${promptText(attempt) || missing} for goal ${promptText(goal) || missing}.`,
    `Goal file (workspace-relative): ${contextPath}`,
  ].join("\\n");
  const current = [
    "## Current attempt brief/directive",
    "",
    "**Attempt brief (current data)**",
    value(attemptBrief, "attempt_brief was not supplied"),
    "",
    "**Directive (current data)**",
    value(directive, "no current directive was supplied"),
  ].join("\\n");
  const override = [
    "## Override declaration",
    "The supervisor-provided structured fields below override any historical context; never infer them from natural language.",
    `- Task type: ${task}`,
    `- Baseline commit: ${compact(baselineCommit)}`,
    `- Source attempt: ${compact(sourceAttempt)}`,
    "- Acceptance items:", items,
  ].join("\\n");
  const discipline = [
    "## Execution discipline",
    "Use the assigned worktree only; main is read-only. Report state with graph_report_status using state=working, blocked, done, or error.",
    `At start migrate ${promptText(goal) || missing} to in_progress; on a blocker use blocked with a reason; when done migrate to review and stop. Never migrate to delivered.`,
    promptText(subagentPromptSection) ? protectPromptMarkers(subagentPromptSection) : "",
    promptText(modeStrategySection) ? protectPromptMarkers(modeStrategySection) : "",
    promptText(worktreeBlock) ? protectPromptMarkers(worktreeBlock) : "",
  ].filter(Boolean).join("\\n");
  return [position, current, targetContext ? "## Goal context\\n" + protectPromptMarkers(targetContext) : "", override, ...history, discipline, "If a prompt contains a historical handoff and a current brief, execute only the current brief."].filter(Boolean).join("\\n\\n");
}

/** 统一组装 supervisor 执行 attempt prompt，避免两处派发顺序漂移。 */
export function formatAttemptPrompt({
  goal,
  attempt,
  goalRel,
  attemptBrief,
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
    return formatAttemptPromptEnglish({ goal, attempt, goalRel, attemptBrief, directive, taskType, baselineCommit, sourceAttempt, acceptanceItems, handoffSection, cardsSection, targetContext, subagentPromptSection, modeStrategySection, worktreeBlock });
  }
  const brief = promptText(attemptBrief);
  const currentDirective = promptText(directive);
  const handoff = promptText(handoffSection);
  const cards = promptText(cardsSection) || [
    "## 已收集上下文卡片成果（g-120 注入）",
    "",
    ATTEMPT_PROMPT_MISSING,
    "未提供原因：当前派发没有可注入的 filled/reviewed 卡片成果。",
  ].join("\n");
  const taskTypeLabel = taskTypeDisplay(taskType);
  const historyNotice = handoff ? "『前序 attempt 已确认 handoff』" : "『历史 handoff』";
  const goalValue = promptText(goal) || ATTEMPT_PROMPT_MISSING;
  const attemptValue = promptText(attempt) || ATTEMPT_PROMPT_MISSING;
  const context = promptText(targetContext);
  const positioning = [
    "【本次任务定位】这是一次 " + taskTypeLabel + " 任务；以下仅『本次 attempt brief/directive』为唯一 action 来源；" + historyNotice + "为约束/背景，仅供理解候选设计与禁项，不产生新任务。",
    "你是 dsh-graph 目标 " + goalValue + " 的执行 attempt " + attemptValue + "。",
    context
      ? "目标文件精确路径（工作目录相对）：" + (promptText(goalRel) || ATTEMPT_PROMPT_MISSING) + "（目标描述与质量判据已在下方基于当前快照内联，请直接依据执行；如需历史评论/台账可按需查阅，无需无条件重读全文）。"
      : "目标文件精确路径（工作目录相对）：" + (promptText(goalRel) || ATTEMPT_PROMPT_MISSING) + "——用 read 工具读它，不要自己猜路径。",
  ].join("\n");

  const current = [
    "## 本次 attempt brief/directive",
    "",
    "唯一 action 来源：以下两项当前数据；历史 handoff、卡片和通用纪律均不产生新任务。",
    "brief 优先于 directive：brief 是当前任务的直接描述，directive 是目标文件中的背景指令；两者冲突以 brief 为准。",
    "",
    "**attempt brief（当前数据）**",
    renderPromptValue(brief, "本次请求未传 attempt_brief，或该值不是非空字符串"),
    "",
    "**directive（当前数据）**",
    renderPromptValue(currentDirective, "当前目标没有最近指令，或该值不是非空字符串"),
  ];
  if (context) current.push("", "目标背景（来自当前 goal.md，仅供理解，不产生 action）", protectPromptMarkers(context));

  const override = [
    "## 覆盖声明",
    "",
    "覆盖声明：本段与上文 handoff 不一致处，一律以本段为准（列出覆盖点：task_type、baseline_commit、source_attempt、acceptance_items）。",
    "- 任务类型（当前 attempt 数据）：" + taskTypeFact(taskType),
    currentFactLine("- 权威基线 commit（当前 attempt 数据）：", baselineCommit, "baseline_commit", "没有可用基线 commit"),
    currentFactLine("- 真正前序 attempt 身份（当前 attempt 数据）：", sourceAttempt, "source_attempt", "没有可用的候选/来源 attempt；当前 attempt 不计为前序来源"),
    acceptanceFactLine(acceptanceItems),
    "以上字段由 supervisor 通过独立参数直接传入；不从 brief/directive、handoff 或卡片截取/推断。",
    "- 历史 handoff：" + (handoff ? "已提供（下方仅作背景）" : "未提供（当前目标没有已确认 handoff，故不注入历史 handoff 区块）"),
  ].join("\n");

  const history = [];
  const handoffBlock = historicalPromptBlock("## 历史 handoff", handoff);
  if (handoffBlock) history.push(handoffBlock);
  history.push(historicalPromptBlock("## 历史卡片", cards));
  const discipline = formatAttemptDiscipline({ goal, attempt, worktreeBlock, subagentPromptSection });
  return [positioning, current.join("\n"), modeStrategySection, override, ...history, discipline, ATTEMPT_PROMPT_WARNING]
    .filter((section) => section && section.trim())
    .join("\n\n");
}

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
  // g-133：注册 dsh-graph settings namespace（profile 级全局默认）。
  // 守卫式动态 import schemastery（@deepseek-ai/*），失败/缺失时优雅降级（plugin 始终可加载）。
  // ctx.inject(["settings"], cb) 等待 settings 服务出现（同 dsh-subagent-model-picker 的已上线模式）；
  // settings 服务缺失（无 provider 组合）时 namespace 不注册、看板/工具/模型路由不受影响。
  // owner scope 的 get() 读当前 resolved 值（用户改 profile 设置后实时反映），watch() 可订阅变化。
  let graphSettingsScope = null;
  const setupGraphSettings = async () => {
    let z;
    try {
      z = (await import("@deepseek-ai/schemastery")).default;
      if (!z) return; // 解析到空：降级
    } catch {
      process.stderr.write("[dsh-graph-host] g-133: @deepseek-ai/schemastery 不可解析，profile 全局默认降级（模型路由/提示词走 project.yaml/继承）\n");
      return;
    }
    const schema = buildGraphSettingsSchema(z);
    if (typeof ctx.inject !== "function") return; // 无 inject 的上下文（如部分 mock）降级
    ctx.inject(["settings"], (sctx) => {
      try {
        graphSettingsScope = sctx.settings.register(GRAPH_SETTINGS_NS, schema, {
          base: { ...GRAPH_SETTINGS_DEFAULTS },
        });
        sctx.effect(() => () => { graphSettingsScope = null; });
      } catch (e) {
        // duplicate registration 或存储段非法：降级（读取走默认/继承）
        process.stderr.write(`[dsh-graph-host] g-133 settings 注册失败（降级，模型路由/提示词走默认）：${e?.message ?? e}\n`);
      }
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
      };
    } catch {
      return { ...GRAPH_SETTINGS_DEFAULTS };
    }
  };
  // g-133：workspace 子代理补充提示词覆盖字段读取（与 g-132 三态语义对齐，核心逻辑在 core/ops.ts）。
  // project.yaml 的对应字段三种取值：`default`/缺失 → 继承全局；非空文本 → 覆盖；
  // 显式空值（'' 或 ""）→ 禁用全局提示词。字段名为 `defaults.subagent_prompt`。
  const readPromptOverride = (rootFor, key) => {
    try {
      const file = join(rootFor, "project.yaml");
      if (!existsSync(file)) return "default";
      return readPromptOverrideValue(readFileSync(file, "utf8"), key);
    } catch {
      return "default";
    }
  };
  // 把「全局提示词 + workspace 覆盖值」合成最终注入值（三态，核心逻辑在 core/ops.ts）。
  const effectivePrompt = (globalPrompt, override) =>
    resolvePromptOverride(globalPrompt, override);
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

  // GUI 派发的子代理需要真实 parent Agent：startContinuable 内部强解引用 parent
  // （parent.options / childSessionMeta / captureDelegatedPolicyOverrides），传 null 必然失败。
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
  }) => {
    if (!goal) throw new GraphError("missing goal");
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
    const admission = assertExecutionAdmission(root, goal, { force });
    const { goalFile, doc } = admission;

    // 3. 一次性上下文快照（保证注入清单与注入内容一致，零二次读取漂移）
    const descMatch = doc.body.match(/## 目标描述\n([\s\S]*?)(?=\n## |$)/);
    const critMatch = doc.body.match(/## 质量判据\n([\s\S]*?)(?=\n## |$)/);
    const desc = descMatch ? descMatch[1].trim() : "";
    const crit = critMatch ? critMatch[1].trim() : "（无判据）";
    const targetContext = [
      "## 目标描述",
      desc || "（无描述）",
      "",
      "## 质量判据",
      crit,
    ].join("\n");

    // 4. 任务动作规范化（g-236/g-241 协同：brief 优先于 directive，三级回退，禁止静默空 action）
    const currentDirective = directive ?? readGoalDirective(root, goal);
    const resolvedBrief = resolveEffectiveBrief(attempt_brief, currentDirective, desc);

    const cards = harvestedCards(root, goal);
    const injectedCards = cards.map((c) => c.id);
    const cardsSection = formatHarvestedCardsSection(root, goal, undefined, cards);

    const confirmedHandoffs = harvestReviewedAttemptHandoffs(root, goal);
    const injectedHandoffRefs = confirmedHandoffs.map((h) => ({
      id: h.id,
      revision: h.revision,
      source_attempts: h.source_attempts,
    }));
    const handoffsSection = formatReviewedAttemptHandoffsSection(root, goal, undefined, confirmedHandoffs);

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
    const effModeRes = resolveSubagentMode(mode, projectExec.mode, globalSettings.subagentMode);

    // 6. 统一校验 subagent prepareContinuable 能力（g-241 判据 4：禁止回退虚构 spawn）
    const subagents = ctx.get?.("subagents");
    let availableProvider = null;
    let providerError = null;
    if (subagents) {
      availableProvider = (subagents.list?.() ?? []).find((n) => {
        try { return typeof subagents.getProvider(n)?.prepareContinuable === "function"; } catch { return false; }
      });
      if (!availableProvider) {
        providerError = `无可用 subagent provider（需 prepareContinuable 能力，已注册：${(subagents.list?.() ?? []).join(",") || "无"}）`;
      }
    }

    // 7. Prompt 组装与 Prompt Hash
    const goalRel = goalFile ? relative(workspace, goalFile) : null;
    let gType = "task";
    try { gType = normalizeGoalType(doc.meta.type); } catch {}
    const promptLanguage = resolvePromptLanguage(globalSettings.promptLanguage, ctx);
    const worktreeBlock = resolveWorktreeGuide(gType, worktree, promptLanguage);
    const subagentPromptSection = (() => {
      const p = effectivePrompt(globalSettings.subagentPrompt, readPromptOverride(root, "subagent_prompt"));
      return p ? ["## dsh-graph 子代理补充提示词（profile 全局 / workspace 覆盖）", "", p].join("\n") : null;
    })();
    const modeStrategySection = effModeRes.prompt ? ["## 子代理执行模式（" + effModeRes.mode + "）", "", effModeRes.prompt].join("\n") : null;

    // 预测下一 attempt ID（用于 prompt 中精准渲染 attempt 编号）
    const attemptsDir = join(dirname(goalFile), "attempts");
    mkdirSync(attemptsDir, { recursive: true });
    const seq = readdirSync(attemptsDir).filter((d) => d.startsWith("att-")).length + 1;
    const nextAttId = `att-${String(seq).padStart(3, "0")}`;

    const prompt = formatAttemptPrompt({
      goal,
      attempt: nextAttId,
      goalRel,
      attemptBrief: resolvedBrief.brief,
      directive: currentDirective,
      taskType: task_type,
      baselineCommit: baseline_commit,
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
    const attempt = startAttempt(root, goal, {
      executor: executor ?? (entrypoint === "http" ? "agent:executor" : actor),
      actor,
      injectedCards,
      injectedHandoffs: injectedHandoffRefs,
      attemptBrief: resolvedBrief.brief ?? undefined,
      injectedDirective: currentDirective ?? undefined,
      provider: effProvider,
      model: effModel,
      modelRoute: effRoute,
      reasoningEffort: effReasoningEffort,
      mode: effModeRes.mode,
      modeSource: effModeRes.source,
      taskType: task_type,
      baselineCommit: baseline_commit,
      sourceAttempt: source_attempt,
      acceptanceItems: acceptance_items,
      templateVersion,
      promptHash,
      contextDigest,
      contextVersion,
    });

    // 9. 启动与绑定子代理
    if (providerError) {
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
        brief: resolvedBrief.brief,
        brief_source: resolvedBrief.source,
        prompt,
      };
    }

    if (subagents && parentAgent && availableProvider) {
      try {
        const modeToolFilter = toolFilterForMode(effModeRes.mode);
        const request = {
          parent: parentAgent,
          prompt: text(prompt),
          ...(modeToolFilter ? { toolFilter: modeToolFilter } : {}),
        };
        const agentOptions = {};
        if (effProvider) agentOptions.provider = effProvider;
        if (effModel) agentOptions.model = effModel;
        if (effReasoningEffort) agentOptions.reasoningEffort = effReasoningEffort;
        if (Object.keys(agentOptions).length) request.agentOptions = agentOptions;

        const started = await subagents.startContinuable({
          provider: availableProvider,
          label: `graph:${goal}/${attempt}`,
          request,
          signal,
        });

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
          );
        } catch (bindErr) {
          // g-237：绑定失败必须收敛——先请求中断刚启动的 child，避免留下无主运行 child，
          // 再抛出携带 child_id 的可追溯错误（外层 catch 会上报 child_error）。
          let interruptNote = "";
          try {
            const parentSessionIdForInterrupt = parentAgent?.session?.id ?? parentSessionId ?? started.parentSessionId ?? null;
            if (parentSessionIdForInterrupt && typeof subagents.interruptByParent === "function") {
              subagents.interruptByParent(started.childId, parentSessionIdForInterrupt, "continuable");
              interruptNote = "，已请求中断该 child";
            } else {
              interruptNote = "，无法中断该 child（缺少 parent session 或服务能力）";
            }
          } catch (interruptErr) {
            interruptNote = `，中断该 child 失败：${interruptErr?.message ?? interruptErr}`;
          }
          throw new GraphError(
            `attempt 绑定失败（child ${started.childId} 已启动${interruptNote}）：${bindErr?.message ?? bindErr}`,
          );
        }

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
          brief: resolvedBrief.brief,
          brief_source: resolvedBrief.source,
          prompt,
        };
      } catch (e) {
        return {
          ok: true,
          attempt,
          child_id: null,
          child_error: String(e?.message ?? e),
          note: `subagent 派发失败（attempt 已本地创建）：${e?.message ?? e}`,
          model_route: effRoute,
          mode: effModeRes.mode,
          mode_source: effModeRes.source,
          injected_cards: injectedCards,
          injected_handoffs: injectedHandoffRefs,
          brief: resolvedBrief.brief,
          brief_source: resolvedBrief.source,
          prompt,
        };
      }
    } else {
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
        brief: resolvedBrief.brief,
        brief_source: resolvedBrief.source,
        prompt,
      };
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
      run: (a, ex) => { transition(rootFor(ex), a.goal, a.to, { reason: a.reason, actor: actorOf(ex) }); return { ok: true }; },
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
      def: {
        name: "graph_delete_card",
        description: "删除目标的上下文卡片（删卡片文件 + context_cards 移除引用 + 记 card.deleted 事件，事件先行 R-02）。正在收集中的卡片（status=collecting）不可删除。",
        parameters: params({ goal: str, card: str }, ["goal", "card"]),
      },
      run: (a, ex) => { deleteCard(rootFor(ex), a.goal, a.card, { actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      // g-150：主管登记 attempt handoff（返工约束、前序失败、推荐基线、验收命令）。
      // 只有已 claim 的 supervisor 或负责人应调用；写入 handoff 文件 + 追加确认事件。
      def: {
        name: "graph_record_attempt_handoff",
        description: "主管/负责人登记前序 attempt 的返工 handoff（g-150，单文件简化）：记录已核实失败、返工约束（禁止项）、推荐基线/保留项与验收命令。每个 goal 仅一个 handoff，新登记覆盖旧内容；旧历史由事件流保留。source_attempts 必须属于该 goal。",
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
        description: "设置/替换目标的「最近指令」（g-150）：写下一次 attempt 生效的补充任务、边界和验收。写入 goal.md 的「最近指令」小节并追加事件；新 attempt 派发时自动读取注入初始 prompt。directive 为空字符串时清空指令。",
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
        description: "设置/替换目标的「目标描述」（g-260）：就地编辑目标描述内容。写入 goal.md 的「目标描述」小节并追加事件；仅改描述小节正文，frontmatter 与其他小节字节级不变。description 为空字符串时清空描述。",
        parameters: params({ goal: str, description: str }, ["goal", "description"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        setGoalDescription(r, a.goal, a.description, actorOf(ex));
        return { ok: true, goal: a.goal };
      },
    },
    {
      // g-150：向目标的「评论」小节追加一条可追溯的历史讨论/反馈。
      // 不自动注入 prompt，执行者可通过目标文件查看。事件先行。
      def: {
        name: "graph_add_comment",
        description: "向目标的「评论」小节追加一条可追溯的历史讨论/反馈（g-150）。评论不自动注入执行 prompt，但执行者可通过 goal.md 查看历史。事件先行。",
        parameters: params({ goal: str, text: str }, ["goal", "text"]),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        appendGoalComment(r, a.goal, a.text, actorOf(ex));
        return { ok: true, goal: a.goal };
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
      // g-118：dsh-graph help 命令——输出使用说明 + supervisor 接管（claim）指引。
      // 与引导提示词（systemPrompt section GUIDE_HINT）呼应：提示词告知 help 命令存在，
      // help 给出完整工具清单与换会话步骤。不含主管守则（完整守则走 skill 显式调用）。
      def: {
        name: "graph_help",
        description: "输出 dsh-graph 使用说明与 supervisor 接管（claim）指引：graph_* 工具清单、graph_handoff/graph_claim_supervisor 换会话步骤。",
        parameters: params({}, []),
      },
      run: () => ({ help: localizedPrompt("help", resolvePromptLanguage(readGraphSettings().promptLanguage, ctx), HELP_TEXT) }),
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
        description: "生成/更新 .dsh-graph/HANDOFF.md 换会话交接文档（g-117）：board 投影 + 长期记忆 + 关键环境事实段自动拼接。产物不依赖会话上下文；返回交接全文。旧会话交接时调用。写盘前若旧 HANDOFF.md 存在且内容不同，先归档到 <root>/handoffs/HANDOFF-<时间戳>.md（g-121，归档目录不入 git）。",
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
        description: "新会话接手时调用：把 project.yaml 的 supervisor.session 更新为当前会话 id（ex.agent.session 链），记 supervisor.claimed 事件（幂等：重复调用不重复记），返回 HANDOFF 交接全文并同时落盘 HANDOFF.md（写盘统一走归档逻辑：旧版先归档到 <root>/handoffs/，g-121）。",
        parameters: params({}, []),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        const res = claimSupervisor(r, ex?.agent?.session?.id, actorOf(ex));
        return { supervisor_session: res.supervisor_session, handoff: res.handoff };
      },
    },
    // ===== g-105：记忆管理工具（add / replace / remove / recall） =====
    {
      def: {
        name: "graph_memory_add",
        description: "新增持久事实/记忆。\n【scope 决策铁律】：\n1. 默认法则：一切自发总结、技术经验、方案决策 100% 默认 scope=\"on_demand\"（按需记忆，不占常驻 Prompt）；\n2. 常驻特权法则：仅在「人类明确要求记为常驻/铁律」或「涉及工作区隔离/不可违背的安全禁令」时，才允许设 scope=\"standing\"（硬上限 200 字符，超过拒绝；普通记忆上限 500 字符）。事件先行。",
        parameters: params({
          kind: { type: "string", enum: ["project", "user"] },
          scope: { type: "string", enum: ["standing", "on_demand"] },
          text: str,
          importance: { type: "number" },
          source_goal: str,
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
          actor: memoryActorOf(ex),
        });
        return losslessJson({ ok: true, id: res.id, entry: res.entry });
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
        description: "为目标派发一个 attempt：派发前先执行准入门禁（backlog/draft/blocked/delivered 及无判据/未确认判据/状态不允许的目标直接拒绝，零副作用：不建 attempt、不启动子代理）；准入通过后先落地 in_progress 迁移，再创建 attempt 目录与记录并启动可续轮子 agent 并绑定 childId。provider/model 指定执行子代理的模型（缺省读 project.yaml 的 executor.provider/model，再无则继承父会话）。默认强制注入独立 worktree 隔离提示；仅 supervisor 明确传 worktree=false 并说明理由时才关闭。attempt_brief 是当前 action 原文；task_type 必须传 merge（合入）、rewrite（重写）或 fix（修复）之一，baseline_commit/source_attempt 是 supervisor 直接提供的当前事实，acceptance_items 是当前验收项 string[]；这些字段不从 brief/handoff 截取。task_type/baseline_commit/source_attempt 的空值传 null 或省略表示未提供；acceptance_items=[] 表示明确无单独验收项，null 或省略表示未提供；空字符串非法。",
        parameters: params({ goal: str, card: str, executor: str, provider: str, model: str, reasoning_effort: str, mode: str, worktree: { type: "boolean" }, attempt_brief: str, task_type: ATTEMPT_TASK_TYPE_SCHEMA, baseline_commit: ATTEMPT_OPTIONAL_STRING_SCHEMA, source_attempt: ATTEMPT_OPTIONAL_STRING_SCHEMA, acceptance_items: ATTEMPT_ACCEPTANCE_ITEMS_SCHEMA }, ["goal"]),
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
        const executor = a.executor ?? actorOf(ex);
        const r = rootFor(ex);
        // g-202：传 card 时统一走上下文收集派发，不创建 Goal execution attempt。
        // 先生成 prompt（同时校验 goal/card），再尝试启动；只有成功启动后才绑定卡片。
        if (a.card !== undefined && a.card !== null) {
          const fullPrompt = formatCollectPrompt(r, a.goal, a.card, a.attempt_brief, resolvePromptLanguage(readGraphSettings().promptLanguage, ctx));
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
          const subagents = ctx.get?.("subagents");
          if (!subagents || !ex?.agent) {
            result.child_error = "subagents 服务不可用或无调用 agent";
            return result;
          }
          try {
            const provider = (subagents.list?.() ?? []).find((n) => {
              try { return typeof subagents.getProvider(n)?.prepareContinuable === "function"; } catch { return false; }
            });
            if (!provider) throw new Error(`无可用 subagent provider（需 prepareContinuable 能力，已注册：${(subagents.list?.() ?? []).join(",") || "无"}）`);
            const collectToolFilter = toolFilterForRole("collector", a.mode);
            const request = {
              parent: ex.agent,
              prompt: text(fullPrompt),
              ...(collectToolFilter ? { toolFilter: collectToolFilter } : {}),
            };
            const agentOptions = {};
            if (effProvider) agentOptions.provider = effProvider;
            if (effModel) agentOptions.model = effModel;
             if (effReasoningEffort) agentOptions.reasoningEffort = effReasoningEffort;
            if (Object.keys(agentOptions).length) request.agentOptions = agentOptions;
            const started = await subagents.startContinuable({
              provider,
              label: `graph:collect/${a.goal}/${a.card}`,
              request,
              signal: ex.signal,
            });
            bindCardChild(r, a.goal, a.card, {
              childId: started.childId,
              parentSessionId: started.parentSessionId ?? ex.agent?.session?.id ?? null,
              actor: actorOf(ex),
              provider: effProvider,
              model: effModel,
            });
            result.child_id = started.childId;
            if (effRoute) result.model_route = effRoute;
          } catch (e) {
            result.child_error = String(e?.message ?? e);
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
        });
        const result = {
          attempt: execRes.attempt,
          child_id: execRes.child_id,
          injected_cards: execRes.injected_cards,
          injected_handoffs: execRes.injected_handoffs,
          mode: execRes.mode,
          mode_source: execRes.mode_source,
        };
        if (execRes.child_error) result.child_error = execRes.child_error;
        if (execRes.note) result.note = execRes.note;
        if (execRes.brief) result.brief = execRes.brief;
        if (execRes.brief_source && execRes.brief_source !== "brief") result.brief_source = execRes.brief_source;
        if (execRes.model_route) result.model_route = execRes.model_route;
        return result;
      },
    },
    {
      def: {
        name: "graph_resolve_accept",
        description: "主管裁决目标的接受请求（review.requested 出现后调用）。verdict=accept 通过，verdict=object 提出异议；force=true 强制接受并记录理由。",
        parameters: params({
          goal: str,
          verdict: { type: "string", enum: ["accept", "object"] },
          objection: str,
          force: { type: "boolean" },
          reason: str,
        }, ["goal", "verdict"]),
      },
      run: (a, ex) => {
        resolveAccept(rootFor(ex), a.goal, {
          actor: actorOf(ex),
          verdict: a.verdict,
          objection: a.objection,
          force: a.force,
          reason: a.reason,
        });
        return { ok: true };
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
        description: "用户明确选择后清理已实时验证的 worktree；默认不删除分支。",
        parameters: params({ id: str, confirm: { type: "boolean" } }, ["id", "confirm"]),
      },
      run: (a, ex) => cleanWorktree(rootFor(ex), a.id, actorOf(ex), a.confirm === true),
    },
    {
      def: {
        name: "graph_archive_goal",
        description: "归档目标（仅 draft/planning/delivered 可归档）。移动到对应 archived 目录，记 goal.archived 事件。",
        parameters: params({ goal: str }, ["goal"]),
      },
      run: (a, ex) => { archiveGoal(rootFor(ex), a.goal, { actor: actorOf(ex) }); return { ok: true }; },
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
        description: "删除已归档目标（含其卡片/attempts 目录）。仅已归档目标可删除，且不能有活跃子代理。记 goal.deleted 事件。",
        parameters: params({ goal: str }, ["goal"]),
      },
      run: (a, ex) => { deleteGoal(rootFor(ex), a.goal, { actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_postpone_goal",
        description: "暂缓目标：将版本/独立目标移回 backlog 目录形态并置为 draft（保留 cards/attempts）。存在活跃 agent 时拒绝操作。",
        parameters: params({ goal: str, reason: str }, ["goal"]),
      },
      run: (a, ex) => { postponeGoal(rootFor(ex), a.goal, { actor: actorOf(ex), reason: a.reason }); return { ok: true }; },
    },
    {
      // g-190：从目标解绑执行子代理（安全 detach）——主管/目标 owner 专用，需当前 binding token。
      // 仅授权主管（project.yaml supervisor.session）或目标 owner 可执行；子代理不能自我解绑。
      def: {
        name: "graph_unbind_goal_child",
        description: "从目标解绑执行子代理（g-190，安全 detach）：按 goal + 唯一 selector（attempt 或 child_id）+ 当前 binding token 精确定位；仅授权主管或目标 owner 可执行；子代理不能自我解绑。解绑只清理绑定（attempt/事件/日志保留可审计），解绑后目标可暂缓/转移/重新派发；子代理仍运行（live registry）或状态不可确认时拒绝；token 未知/过期/并发冲突拒绝且不改数据；重复解绑幂等。",
        parameters: params(
          { goal: str, attempt: str, child_id: str, token: str, reason: str },
          ["goal", "token"],
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
          token: a.token,
          attempt: hasAtt ? a.attempt : null,
          childId: hasChild ? a.child_id : null,
          reason: typeof a.reason === "string" && a.reason.length ? a.reason : null,
          liveCheck: childLiveState,
        });
        return { ok: true, ...result };
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
      const available = (subagents.list?.() ?? []).filter((n) => {
        try { return typeof subagents.getProvider(n)?.prepareContinuable === "function"; } catch { return false; }
      });
      const provider = available[0];
      if (!provider) {
        return { childId: null, parentSessionId: null, error: `无可用 subagent provider（需 prepareContinuable 能力，已注册：${(subagents.list?.() ?? []).join(",") || "无"}）` };
      }
      const effRole = overrides.role ? normalizeSubagentRole(overrides.role) ?? "executor" : "executor";
      const roleToolFilter = toolFilterForRole(effRole, overrides.mode);
      const request = {
        parent,
        prompt: [{ type: "text", text: promptText }],
        ...(roleToolFilter ? { toolFilter: roleToolFilter } : {}),
      };
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
      if (Object.keys(agentOptions).length) request.agentOptions = agentOptions;
      const started = await subagents.startContinuable({ provider, label, request, signal: ac.signal });
      return { childId: started.childId, parentSessionId: supervisorId, error: null, model_route: `${effProvider ?? "继承"}/${effModel ?? "继承"}` };
    } catch (e) {
      return { childId: null, parentSessionId: null, error: String(e?.message ?? e) };
    }
  };
  // 枚举派发选项（重新执行选择器用）：LLM provider 分组模型目录（ctx.llm 注册表）+ 默认（project.yaml executor）。
  // 注意区分两个 provider 概念：subagent provider（spawn/fork，子代理创建方式，用户不可选）与
  // LLM provider（deepseek/kimi，模型路由，用户可选）。此处只暴露 LLM 目录，避免用户把 spawn/fork 当模型路由。
  const readSpawnOptions = async (rootForReq) => {
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
    return {
      modelGroups,
      modes: SUBAGENT_MODES.map((id) => SUBAGENT_MODE_SPECS[id]),
      default: { provider: eff.provider, model: eff.model, mode: effModeRes.mode, mode_source: effModeRes.source },
    };
  };

  // g-189：只读发现当前 canonical workspace 下约定的 attempt worktree。
  // 结果附加到 goal detail，不写入任何 graph 数据；失败时返回明确降级状态。
  const worktreeCache = new Map();
  const WORKTREE_CACHE_TTL = 20_000;
  const WORKTREE_CACHE_CAP = 64;
  const discoverAttemptWorktrees = (workspace, goalId, attempts, graphRoot = null) => {
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
        return { path: resolve(pathLine.slice(9).trim()), branch: branchLine?.slice(7).trim() ?? null, head: headLine?.slice(5).trim() ?? null, locked: /(^|\n)locked(?: |$)/.test(block), prunable: /(^|\n)prunable(?: |$)/.test(block) };
      }).filter(Boolean);
      const canonical = realpathSync(resolve(workspace));
      const prefix = `${goalId}-att-`;
      const usedPaths = new Set();
      const seenAttemptIds = new Set();
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
        if (!matchEntry) continue;
        const expected = matchEntry.name;
        const expectedBranch = `refs/heads/${expected}`;
        const entry = matchEntry.entry;
        if (entry.prunable || !entry.head) continue;
        // Evidence is optional for historical attempts, but any recorded fields must agree.
        if (evidence?.branch) {
          const evidenceBranch = basename(String(evidence.branch).replace(/^refs\/heads\//, ""));
          if (!names.includes(evidenceBranch)) continue;
        }
        if (evidence?.head && evidence.head !== entry.head) continue;
        // Cross-check both Git's live record and the attempt evidence. A same-named
        // nested/foreign path is never accepted: the relative form must be exact.
        let actual;
        try { actual = realpathSync(entry.path); } catch { continue; }
        const rel = relative(canonical, actual).replaceAll("\\", "/");
        if (rel !== `.worktrees/${expected}` || rel.startsWith("..") || isAbsolute(rel) || rel.includes("\0")) continue;
        usedPaths.add(entry.path);
        result.items[id] = { path: rel, status: entry.locked ? "已锁定" : "正常" };
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
      path: "/api/dsh-graph",
      handler: (_req, res) => {
        try {
          const sp = new URL(_req?.url ?? "", "http://x").searchParams;
          const includeArchived = sp.get("includeArchived") === "1" || sp.get("includeArchived") === "true";
          const meta = rootForReqMeta(_req);
          const cached = getCachedBoardPayload(meta.root, { includeArchived });
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
          const { goal, verdict, objection, force, reason } = body;
          if (!goal || !verdict) return json(res, 400, { error: "missing goal or verdict" });
          resolveAccept(rootForReq(req, body), goal, { actor: "human:gui", verdict, objection, force, reason });
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
          const result = cleanWorktree(rootForReq(req, body), String(body.id), "human:gui", true);
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
          json(res, code, { error: String(e?.message ?? e) });
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
              const haystack = `${e.text} ${e.id} ${e.source_goal ?? ""}`.toLowerCase();
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
            actor: "human:gui",
          });
          json(res, 200, { ok: true, id: resEntry.id, entry: resEntry.entry });
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
          const fullPrompt = formatCollectPrompt(rRoot, goal, card, prompt, resolvePromptLanguage(readGraphSettings().promptLanguage, ctx));
          const spawned = await spawnChild(
            `graph:collect/${goal}/${card}`,
            fullPrompt,
            req,
            rRoot,
            { provider: effProvider, model: effModel, reasoning_effort: effReasoningEffort, role: "collector" },
          );
          if (spawned.error) {
            console.error("[dsh-graph-host] start-collection 子代理启动失败:", spawned.error);
          } else {
            // 事件先行：card.collecting（bindCardChild 写 child_id/parent_session_id）。
            // g-242：collector 依托卡片生命周期协作，不创建虚假 attempt
            bindCardChild(rRoot, goal, card, { childId: spawned.childId, parentSessionId: spawned.parentSessionId, actor: "human:gui", provider: effProvider, model: effModel });
          }
          json(res, 200, { ok: true, card, attempt: null, child_id: spawned.childId, child_error: spawned.error, model_route: effRoute });
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
          });
        } catch (e) {
          const code = e instanceof GraphError ? 400 : 500;
          json(res, code, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-109 判据反馈：重新执行选择器用——枚举 providers + 模型分组 + project.yaml 默认
    {
      path: "/api/dsh-graph/spawn-options",
      handler: async (req, res) => {
        try {
          json(res, 200, await readSpawnOptions(rootForReq(req)));
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
            return json(res, 200, { ok: true, config: readProjectConfig(r) });
          }
          if (req.method === "GET") {
            // att-002：下发当前 canonical workspace 的 .dsh-graph/project.yaml 绝对路径
            //（客户端只消费服务端路径，禁止自行拼接 graphRoot）
            const meta = rootForReqMeta(req);
            return json(res, 200, { ...readProjectConfig(meta.root), configFile: join(meta.root, "project.yaml") });
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
          archiveGoal(rootForReq(req, body), goal, { actor: "human:gui" });
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
          postponeGoal(rootForReq(req, body), goal, { actor: "human:gui", reason });
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
          deleteGoal(rootForReq(req, body), goal, { actor: "human:gui" });
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
          const goal = String(body.goal);
          const token = String(body.token);
          const attempt = typeof body.attempt === "string" && body.attempt.length ? body.attempt : null;
          const childId = typeof body.child_id === "string" && body.child_id.length ? body.child_id : null;
          if ((attempt === null) === (childId === null)) {
            return json(res, 400, { error: "必须且只能指定一个选择器：attempt 或 child_id" });
          }
          const rRoot = rootForReq(req, body);
          const result = unbindGoalChild(rRoot, goal, {
            actor: "human:gui",
            token,
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
    // 注册 supervisor 工作指南为运行时技能（可选服务，缺失时静默）
    const skills = ctx.get?.('skills');
    if (skills) { try { skills.register({ name: 'dsh-graph-supervisor', description: 'dsh-graph 主管 Agent 工作指南', source: 'dsh-graph-host', content: localizedPrompt("supervisor-guide", resolvePromptLanguage(readGraphSettings().promptLanguage, ctx), GUIDE) }); } catch { /* 静默 */ } }
    // g-113：普通 agent 的 dsh-graph 使用指引（新会话开箱即用）
    if (skills) { try { skills.register({ name: 'dsh-graph', description: 'dsh-graph 目标看板：用 graph_* 工具管理目标/判据/卡片/执行', source: 'dsh-graph-host', content: localizedPrompt("usage", resolvePromptLanguage(readGraphSettings().promptLanguage, ctx), USAGE) }); } catch { /* 静默 */ } }

    const disposers = tools.map((t) =>
      ctx.tools.register({ ...t.def, output: objOut, execute: (args, exec) => t.run(args, exec) }),
    );

    // g-118：supervisor 守则自动注入（不依赖显式 skill 调用）——
    // g-118（负责人 2026-08-22 设计转向）：在所有会话注入**简短引导提示词**（非完整守则）。
    // systemPrompt.section 注册一个恒定渲染 GUIDE_HINT 的提示词段落：所有会话（主管/普通/
    // 执行子代理）都看到「如何 claim 新 supervisor + graph_help 命令存在」，内容轻量无害，
    // 只告知「如何」接管、不授予主管角色——完整 supervisor 守则绝不自动注入（仍走显式
    // skill dsh-graph-supervisor 调用），避免临时会话被注入主管角色而争抢 supervisor。
    // 方案 A 机制复用（调研结论）：section.text 渲染进 system prompt；此处无空文本分支，
    // 恒渲染 GUIDE_HINT（简短，token 成本 ~120 字）。
    // systemPrompt 服务可能晚激活（dsh-base bundle 行，激活时序不保证）：轮询注册。
    const sectionState = { registered: false, timer: null };
    const registerGuideSection = () => {
      if (sectionState.registered) return;
      const sp = ctx.get?.("systemPrompt");
      if (!sp) return;
      try {
        disposers.push(sp.section({
          name: "dsh-graph-guide-hint",
          order: 10,
          text: () => localizedPrompt("guide-hint", resolvePromptLanguage(readGraphSettings().promptLanguage, ctx), GUIDE_HINT),
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
          text: (context) => {
            try {
              const sessionId = context?.agent?.session?.id;
              if (!sessionId) return "";
              // 读当前会话 workspace 的项目 canonical .dsh-graph/project.yaml 的 supervisor.session
              const cwd = context?.agent?.session?.header?.cwd;
              if (!cwd) return ""; // cwd 缺失则不注入（避免误注入）
              const canonical = resolveCanonicalRoot(config, cwd);
              // g-238：纯读——不 init；.dsh-graph/project.yaml 不存在时 readSupervisorSession 返回 null
              const supervisorId = cachedRender(`sup:${canonical.root}`, canonical.root, ["project.yaml"],
                () => readSupervisorSession(canonical.root));
              if (!supervisorId || supervisorId !== sessionId) return "";
              return "\n" + (localizedPrompt("discipline", resolvePromptLanguage(readGraphSettings().promptLanguage, ctx), SUPERVISOR_DISCIPLINE));
            } catch {
              return "";
            }
          },
        }));
        // g-105：常驻记忆（standing）作为独立章节固定植入所有会话系统 Prompt
        // g-238：纯读 + 按 memory/memory.jsonl 指纹失效缓存（撤回/新增/替换立即生效）
        ctx.effect(() => sp.section({
          name: "dsh-graph-standing-memory",
          order: 92,
          text: (context) => {
            try {
              const cwd = context?.agent?.session?.header?.cwd;
              if (!cwd) return "";
              const canonical = resolveCanonicalRoot(config, cwd);
              return cachedRender(`mem:${canonical.root}`, canonical.root, ["memory/memory.jsonl"],
                () => formatStandingMemorySection(canonical.root) ?? "");
            } catch {
              return "";
            }
          },
        }));
        sectionState.registered = true;
        process.stderr.write(`[dsh-graph-host] g-118: guide hint section 已注册（所有会话注入引导提示词，root=${root}）\n`);
        process.stderr.write(`[dsh-graph-host] g-131: supervisor discipline section 已注册（仅主管会话注入纪律提醒，按会话 workspace 解析）\n`);
      } catch (e) {
        console.error("[dsh-graph-host] g-118 guide hint section 注册失败:", e?.message ?? e);
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
    const routeState = { registered: false, timer: null };
    const registerHttpRoutes = () => {
      if (routeState.registered) return;
      const webServer = ctx.get?.("webServer");
      if (!webServer) return;
      try {
        for (const r of httpRoutes()) disposers.push(webServer.register(r));
        routeState.registered = true;
        process.stderr.write(`[dsh-graph-host] apply: tools + /api/dsh-graph(+goal+write) registered (root=${root})\n`);
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
      if (routeState.timer) clearTimeout(routeState.timer);
      if (sectionState.timer) clearTimeout(sectionState.timer);
      disposers.forEach((d) => d());
    };
  });
}
