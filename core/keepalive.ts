/**
 * 主管会话上下文缓存智能保活（Supervisor Context Cache Keep-Alive，g-505）。
 *
 * 纯函数模块（无 IO、无定时器、无文件系统、无事件写入）：只做**两阶段状态机判定**、
 * **两级配置（profile 全局 / workspace 项目）分层解析**、**通道能力判定**与**只读投影**。
 * 结构照既有先例 `core/review-policy.ts`（策略纯函数 + 只读投影）与 `core/worktree.ts`。
 *
 * 背景：主管上下文常达 50k~150k tokens，而主流模型前缀缓存 TTL 通常仅 4~5 分钟：
 * ①子代理执行窗口 6~15 分钟刚好跨过死亡悬崖 ⇒ 交回成果时 1.0x 重算 + 数秒首字延迟；
 * ②负责人审阅窗口 3~8 分钟同样可能踩中过期，而负责人 AFK 时持续保活只会白烧 Token。
 *
 * 负责人 2026-10-27 裁定的实现边界（本模块据此设计，不得越界）：
 * 1. **A 方案**：只复用「最近观察到的正常 loop 请求」的公共内存快照；不承诺下一轮或最终
 *    wire 完全等价，无快照/已知失效即明确不可用。
 * 2. **无痕 = 不新增对话消息**，允许宿主正常 checkpoint 刷新；不得伪造
 *    `purpose` 或 loop marker、不读私有字段。
 * 3. **未知 TTL 按短缓存有界策略**：未知 TTL 一律标 `unknown`，不按模型名猜长 TTL 豁免，
 *    用有限次数 + 单次 Grace 界定成本上界，不宣称一定省钱。
 * 4. 失败不算续期成功；`max_tokens: 1` 不是「必然一 token 费用」的保证。
 *
 * 三条纪律：
 * - **fail-safe**：任一关键信号取不到（`null`）即不保活；拿不到证据绝不当作「可以 ping」。
 * - **有界**：阶段一连续保活封顶（熔断），阶段二只允许 1 次，未知 TTL 的 AFK 判定用短 TTL 假设。
 * - **不污染会话**：本模块不产生任何消息；真正调用由宿主接线完成（`dsh-graph-host/index.js`），
 *   宿主缺能力时如实投影 `missing` 原因，绝不 safe-noop 冒充成功。
 */

// ===== 一、配置：两级开关（profile 全局 + workspace 项目三态） =====

/**
 * 项目级三态取值（`project.yaml` 的 `supervisor.keep_alive`）：
 * - `inherit`：跟随全局设置（**默认**，字段缺失/显式 null 时归一到此）；
 * - `true`：显式开启（覆盖全局，即使全局为关）；
 * - `false`：显式关闭（覆盖全局，即使全局为开）。
 */
export const KEEP_ALIVE_MODES = ["inherit", "true", "false"] as const;
export type KeepAliveMode = (typeof KEEP_ALIVE_MODES)[number];

/** 读侧原始三态（`null` = 未配置）。 */
export type KeepAliveConfigValue = KeepAliveMode | null;

/** 生效值的**来源**（闭集，供机读与 UI 徽标）。 */
export type KeepAliveSource =
  | "project_explicit" // 项目显式 true/false —— 严格优先
  | "global_explicit" // 项目 inherit，全局显式配置
  | "global_default" // 项目 inherit，全局也未配置 ⇒ 落到受控默认
  | "project_invalid" // 项目取值畸形（fail-safe：按关闭处理，绝不猜「开」）
  | "global_invalid"; // 全局取值畸形（fail-safe：按关闭处理）

/**
 * 受控默认：全局未配置时保活是否默认开启。
 *
 * 取值 `true` 的理由：保活是**条件性省钱**能力——只在「本可命中缓存的前缀即将过期」时补一次
 * 极小请求，不改变任何功能语义；但其收益未经真实成本实测（负责人另行授权），故这里只声明
 * 「未配置时默认尝试」，不声明净收益。**畸形值一律按关闭**（见 `project_invalid`/`global_invalid`）。
 */
export const KEEP_ALIVE_DEFAULT_ENABLED = true;

/** 阶段一（子代理运行期）默认参数。 */
export const KEEP_ALIVE_STAGE1_DEFAULTS = Object.freeze({
  /** 触发续期的空闲阈值（ms）：距上次主管 LLM 请求 ≥ 此值即保活一次（约 3.5 分钟）。 */
  intervalMs: 210_000,
  /** 连续保活次数上限（熔断）：约 4 次 × 3.5 分钟 ≈ 14 分钟封顶。 */
  maxPings: 4,
});

/** 阶段二（闲置等待负责人）默认参数。 */
export const KEEP_ALIVE_STAGE2_DEFAULTS = Object.freeze({
  /** 进入纯闲置后首保活的等待阈值（ms，约 4 分钟）。 */
  graceMs: 240_000,
  /** 阶段二允许的保活次数**硬上限**——恒为 1（单次试探保活）。 */
  maxPings: 1,
});

/**
 * 未知 TTL 的有界假设（**不是**对 provider 真实 TTL 的断言）。
 *
 * 公开模型元信息里没有 prefix cache TTL（0.2.1-rc.2 已核对），负责人裁定「未知按短缓存有界
 * 处理」。本常量只用于两件事：
 * 1. 阶段二单次 Grace 之后，等待「一个短 TTL 窗口」仍无交互即判 AFK（停止后续一切保活）；
 * 2. 投影里如实标注 `ttl: "unknown"` 与假设值，说明「按短缓存有界」而非「已知 5 分钟」。
 */
export const KEEP_ALIVE_SHORT_TTL_MS = 300_000;

/** 单次保活请求的**请求级**超时（只 abort 本插件控制器；不承诺不合作 adapter 的严格上界）。 */
export const KEEP_ALIVE_PING_TIMEOUT_MS = 45_000;

/** 显式长 TTL 豁免阈值：仅当**显式提供**的 TTL ≥ 此值才豁免（绝不按 provider/model 名字推断）。 */
export const KEEP_ALIVE_EXEMPT_TTL_MS = 600_000;

export interface KeepAliveProjectConfig {
  /** 读侧归一三态（`null` = 未配置）。 */
  mode: KeepAliveConfigValue;
  /** 读侧是否判定为畸形（原始值无法判定为三态之一）。 */
  malformed?: boolean;
}

export interface KeepAliveGlobalConfig {
  /** profile 级全局开关（`null`/`undefined` = 未配置）。 */
  enabled: boolean | null | undefined;
  /** 读侧是否判定为畸形（存在但非 on/off）。 */
  malformed?: boolean;
  /** 全局值是否可读（settings 能力缺失时为 false，但**不**因此判畸形）。 */
  available?: boolean;
}

/** 归一化后的生效决策（**唯一真源**：UI 投影、REST、宿主调度器都消费它）。 */
export interface KeepAliveResolution {
  /** 最终是否保活（唯一消费值）。 */
  enabled: boolean;
  /** 项目三态归一值。 */
  project_mode: KeepAliveMode;
  /** 全局开关归一值（`null` = 未配置）。 */
  global_enabled: boolean | null;
  /** 生效值来源（机读闭集）。 */
  source: KeepAliveSource;
  /** 是否畸形（项目或全局取值无法判定）—— UI 必须显示「非法/需修」。 */
  malformed: boolean;
}

/**
 * **三态归一**：把任意原始值折叠为 `inherit`/`true`/`false`。
 * 只认真布尔、字符串 `inherit`/`true`/`false`（大小写不敏感、允许首尾空白）与缺失/null。
 * 其它一切取值返回 `inherit`，畸形性由 `isKeepAliveModeMalformed` 单独判定。
 */
export function normalizeKeepAliveMode(raw: unknown): KeepAliveMode {
  if (raw === true) return "true";
  if (raw === false) return "false";
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "inherit") return "inherit";
    if (s === "true") return "true";
    if (s === "false") return "false";
  }
  return "inherit";
}

/** 原始取值是否为**无法判定**的畸形（合法形态：null/undefined/真布尔/"inherit"/"true"/"false"）。 */
export function isKeepAliveModeMalformed(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (raw === true || raw === false) return false;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    return !(s === "inherit" || s === "true" || s === "false");
  }
  return true; // 数字 / 映射 / 数组 …
}

/** 全局开关归一：只有真布尔算显式配置；缺失/null ⇒ `null`（未配置）。 */
export function normalizeKeepAliveGlobal(raw: unknown): boolean | null {
  return raw === true ? true : raw === false ? false : null;
}

/** 全局开关是否为畸形（存在但非真布尔、非 null/undefined）。 */
export function isKeepAliveGlobalMalformed(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  return raw !== true && raw !== false;
}

/**
 * **生效优先级**（单一真源）：项目覆盖全局，缺省继承全局。
 *
 * 判定顺序（严格，无短路歧义）：
 * 1. 项目畸形 ⇒ `false` + `project_invalid`（fail-safe：坏值不当「开」）；
 * 2. 项目 `true`/`false` ⇒ 项目显式值 + `project_explicit`（与全局取值无关）；
 * 3. 项目 `inherit`：全局畸形 ⇒ `false` + `global_invalid`；
 *    全局显式 ⇒ 该值 + `global_explicit`；全局未配置 ⇒ 受控默认 + `global_default`。
 */
export function resolveKeepAlive(
  project: KeepAliveProjectConfig | null | undefined,
  global: KeepAliveGlobalConfig | null | undefined,
): KeepAliveResolution {
  const projRaw = project?.mode;
  const globRaw = global?.enabled;
  const projectMalformed = project?.malformed === true || isKeepAliveModeMalformed(projRaw);
  const globalMalformed = global?.malformed === true || isKeepAliveGlobalMalformed(globRaw);
  const project_mode = normalizeKeepAliveMode(projRaw);
  const global_enabled = normalizeKeepAliveGlobal(globRaw);

  if (projectMalformed) {
    return { enabled: false, project_mode, global_enabled, source: "project_invalid", malformed: true };
  }
  if (project_mode === "true") {
    return { enabled: true, project_mode, global_enabled, source: "project_explicit", malformed: globalMalformed };
  }
  if (project_mode === "false") {
    return { enabled: false, project_mode, global_enabled, source: "project_explicit", malformed: globalMalformed };
  }
  if (globalMalformed) {
    return { enabled: false, project_mode, global_enabled, source: "global_invalid", malformed: true };
  }
  if (global_enabled !== null) {
    return { enabled: global_enabled, project_mode, global_enabled, source: "global_explicit", malformed: false };
  }
  return {
    enabled: KEEP_ALIVE_DEFAULT_ENABLED,
    project_mode,
    global_enabled,
    source: "global_default",
    malformed: false,
  };
}

/**
 * 只读投影（REST GET/POST、`graph_get_settings` 与设置弹窗同源下发）：
 * 项目三态、全局值、生效值、来源、畸形标记与三态闭集。
 */
export interface KeepAliveEffectiveProjection {
  mode: KeepAliveMode;
  /** 全局开关归一值（`null` = 未配置）。 */
  global: boolean | null;
  /** **实际生效**的保活开关（UI 必须可视化下发它）。 */
  effective: boolean;
  source: KeepAliveSource;
  malformed: boolean;
  /** 三态合法值清单（UI 下拉的唯一真源）。 */
  modes: readonly KeepAliveMode[];
}

export function keepAliveEffectiveProjection(
  project: KeepAliveProjectConfig | null | undefined,
  global: KeepAliveGlobalConfig | null | undefined,
): KeepAliveEffectiveProjection {
  const res = resolveKeepAlive(project, global);
  return {
    mode: res.project_mode,
    global: res.global_enabled,
    effective: res.enabled,
    source: res.source,
    malformed: res.malformed,
    modes: KEEP_ALIVE_MODES,
  };
}

/**
 * 从 `readProjectConfig(root).supervisor` + profile 全局开关得到**生效决策**。
 *
 * 读侧已把畸形值标记在 `keep_alive_malformed`；这里优先用该标记（而不是再次归一化），
 * 确保「坏值不得归一 inherit 后默认启用」在**整条链路**成立（读侧、调度器、REST/UI 同源）。
 */
export function keepAliveResolutionOf(
  supervisor: { keep_alive?: unknown; keep_alive_malformed?: unknown } | null | undefined,
  globalEnabled: boolean | null | undefined,
  globalMalformed = false,
  globalAvailable = true,
): KeepAliveResolution {
  const malformed = supervisor?.keep_alive_malformed === true || isKeepAliveModeMalformed(supervisor?.keep_alive);
  return resolveKeepAlive(
    { mode: normalizeKeepAliveMode(supervisor?.keep_alive), malformed },
    { enabled: globalEnabled, malformed: globalMalformed, available: globalAvailable },
  );
}

/** `keepAliveResolutionOf` 的投影形态（REST GET/POST 与设置面板消费）。 */
export function keepAliveEffectiveOf(
  supervisor: { keep_alive?: unknown; keep_alive_malformed?: unknown } | null | undefined,
  globalEnabled: boolean | null | undefined,
  globalMalformed = false,
  globalAvailable = true,
): KeepAliveEffectiveProjection {
  return keepAliveEffectiveProjection(
    {
      mode: normalizeKeepAliveMode(supervisor?.keep_alive),
      malformed: supervisor?.keep_alive_malformed === true || isKeepAliveModeMalformed(supervisor?.keep_alive),
    },
    { enabled: globalEnabled, malformed: globalMalformed, available: globalAvailable },
  );
}

/** 解析全局原始字符串（settings 读入形态）：`"on"`/`"off"`/`""` 合法；其余畸形。 */
export function resolveKeepAliveGlobalRaw(raw: unknown): { enabled: boolean | null; malformed: boolean; raw: string } {
  if (raw === null || raw === undefined) return { enabled: null, malformed: false, raw: "" };
  if (raw === true) return { enabled: true, malformed: false, raw: "on" };
  if (raw === false) return { enabled: false, malformed: false, raw: "off" };
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "" ) return { enabled: null, malformed: false, raw: "" };
    if (s === "on") return { enabled: true, malformed: false, raw: "on" };
    if (s === "off") return { enabled: false, malformed: false, raw: "off" };
    return { enabled: null, malformed: true, raw: String(raw) };
  }
  return { enabled: null, malformed: true, raw: String(raw) };
}

// ===== 二、通道：能力判定与未知 TTL 的有界策略 =====

/**
 * 通道种类：
 * - `host_prepare_stream`：宿主公开 `LlmRuntime.prepareCall` + `prepared.stream` 手工单次调用
 *   （**不**经 Agent 轮次、不新增对话消息）；
 * - `none`：没有可用通道（缺能力或显式长 TTL 豁免）⇒ 不保活。
 */
export const KEEP_ALIVE_CHANNELS = ["host_prepare_stream", "none"] as const;
export type KeepAliveChannel = (typeof KEEP_ALIVE_CHANNELS)[number];

/** 通道决策原因（闭集，供审计与机读）。 */
export type KeepAliveChannelReason =
  | "exempt_long_ttl" // 显式 TTL ≥ 阈值 ⇒ 免 ping（不按名字猜）
  | "host_channel" // 公开 prepareCall/stream 可用
  | "missing_capability"; // 缺少公开能力

export interface KeepAliveCapabilities {
  /** 公开 `llm.prepareCall` + `prepared.stream` 可用。 */
  llm?: boolean;
  /** live Agent 注册表 `get/list/isOwnedBy` 可用（真实所有权枚举）。 */
  agents?: boolean;
  /** Agent 公开 `status` 可用。 */
  status?: boolean;
  /** Agent 公开 `runMaintenance` 可用（真 idle 抢占 + 维护互斥）。 */
  maintenance?: boolean;
  /** 已有「最近正常 loop 请求」的内存快照（A 方案）。 */
  snapshot?: boolean;
}

/** 显式 TTL 画像（只有在宿主/配置**显式**提供时才不是 unknown）。 */
export interface KeepAliveTtlProfile {
  /** 显式前缀缓存 TTL（ms）；`null`/缺省 = 未知。 */
  cacheTtlMs?: number | null;
}

export interface KeepAliveChannelDecision {
  channel: KeepAliveChannel;
  reason: KeepAliveChannelReason;
  /** 免 ping 时为 true（调用方**绝不**发请求）。 */
  exempt: boolean;
  /** TTL 认知：`unknown`（默认）或 `explicit`。 */
  ttl: "unknown" | "explicit";
  /** 缺失的公开能力清单（空 = 无缺口）。 */
  missing: string[];
}

/**
 * **通道判定**：只认公开能力，不认模型名字。
 *
 * 1. 显式 TTL ≥ `KEEP_ALIVE_EXEMPT_TTL_MS` ⇒ `exempt`（不按 provider/model 名推断）；
 * 2. LLM/agents/ownership/status/maintenance 全可用 **且** 有可用快照 ⇒ `host_prepare_stream`；
 * 3. 否则 `none` + 具体 `missing`（缺什么报什么，不 safe-noop）。
 *
 * `cacheTtlMs` 未知（`null`）**不**豁免：未知按短 TTL 有界策略处理（次数上限 + 单次 Grace +
 * 短 TTL 假设后的 AFK），并在投影里明确 `ttl: "unknown"`。
 */
export function resolveKeepAliveChannel(
  caps: KeepAliveCapabilities | null | undefined,
  ttlProfile?: KeepAliveTtlProfile | null,
): KeepAliveChannelDecision {
  const ttlRaw = ttlProfile?.cacheTtlMs;
  const explicitTtl = typeof ttlRaw === "number" && Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : null;
  if (explicitTtl !== null && explicitTtl >= KEEP_ALIVE_EXEMPT_TTL_MS) {
    return { channel: "none", reason: "exempt_long_ttl", exempt: true, ttl: "explicit", missing: [] };
  }
  const missing: string[] = [];
  if (caps?.llm !== true) missing.push("llm.prepareCall/stream");
  if (caps?.agents !== true) missing.push("agents.registry");
  if (caps?.status !== true) missing.push("agent.status");
  if (caps?.maintenance !== true) missing.push("agent.runMaintenance");
  if (caps?.snapshot !== true) missing.push("supervisor.loopSnapshot");
  if (missing.length > 0) {
    return { channel: "none", reason: "missing_capability", exempt: false, ttl: explicitTtl === null ? "unknown" : "explicit", missing };
  }
  return { channel: "host_prepare_stream", reason: "host_channel", exempt: false, ttl: explicitTtl === null ? "unknown" : "explicit", missing: [] };
}

// ===== 三、两阶段状态机 =====

/**
 * 阶段：
 * - `disabled`：保活未生效（配置关闭 / 无通道 / 模型豁免 / 快照不可用）；
 * - `stage1`：子代理运行期有界保活；
 * - `stage2`：全部子代理结束后的单次试探保活（AFK 判定）；
 * - `afk`：阶段二试探后短 TTL 窗口内仍无交互 ⇒ **判定负责人 AFK，彻底停止保活**（终态，
 *   直到下次主管活动/人类交互由调用方重置）。
 */
export const KEEP_ALIVE_PHASES = ["disabled", "stage1", "stage2", "afk"] as const;
export type KeepAlivePhase = (typeof KEEP_ALIVE_PHASES)[number];

export interface KeepAliveInputs {
  /** 当前时刻（ms epoch）。 */
  now: number;
  /** 主管上次 LLM 请求时刻（**观察到的正常 loop 请求**；`null` = 未观察到 ⇒ fail-safe 不保活）。 */
  lastLlmAt: number | null;
  /**
   * 名下**运行中**子代理数（真实 live registry + 所有权）。`null` = 无法判定 ⇒ fail-safe。
   */
  runningChildren: number | null;
  /** 主管是否 `status === "idle"`（`null` = 未知）。注意 idle 也可能在维护中，ping 前仍须 runMaintenance。 */
  idle: boolean | null;
  /** 本窗口连续保活次数（子代理回报/主管活动唤醒时由调用方归零）。 */
  pingsInWindow: number;
  /** 阶段二唯一一次机会是否已用。 */
  stage2Used: boolean;
  /** 最近一次**成功**保活时刻（`null` = 从未）。 */
  lastPingAt: number | null;
  /** 主管最近一次活动（正常 loop 请求 / 人类输入 / 子回报唤醒）时刻；`null` = 未知。 */
  lastActivityAt: number | null;
  /** 维护/请求是否在途（在途绝不叠加第二次）。 */
  inflight: boolean;
  /** 主管 inbox 是否已有待处理输入（有待处理输入时不插队 ping）。 */
  pendingInput: boolean;
}

export interface KeepAliveConfig {
  enabled: boolean;
  stage1IntervalMs: number;
  stage1MaxPings: number;
  stage2GraceMs: number;
}

export type KeepAliveReason =
  | "disabled_by_config"
  | "channel_exempt"
  | "capability_missing"
  | "state_unknown"
  | "busy"
  | "pending_input"
  | "inflight"
  | "active_children_wait"
  | "stage1_ping"
  | "stage1_fused"
  | "stage2_wait"
  | "stage2_ping"
  | "stage2_afk"
  | "stage2_exhausted";

export interface KeepAliveDecision {
  /** 是否**此刻**应发起保活请求。 */
  ping: boolean;
  /** 决策时处于（或迁移到的）阶段。 */
  phase: KeepAlivePhase;
  /** 机读原因（闭集）。 */
  reason: KeepAliveReason;
  /** 距下次可保活还需等待的 ms（`null` = 不再保活/无意义）。 */
  nextEligibleInMs: number | null;
  /** 决策后本窗口的连续保活次数（调用方回写）。 */
  pingsInWindow: number;
  /** 是否已判 AFK（终态）。 */
  afk: boolean;
}

/**
 * 状态机**唯一**判定入口（纯函数、无副作用、确定性）。
 *
 * 顺序：配置 → 通道 → 未知信号 → 非 idle → 在途/待处理 → 阶段一（子代理在跑）→ 阶段二。
 */
export function decideKeepAlive(
  inputs: KeepAliveInputs,
  config: KeepAliveConfig,
  channel: KeepAliveChannelDecision | null | undefined,
): KeepAliveDecision {
  const pings = Number.isFinite(inputs.pingsInWindow) && inputs.pingsInWindow > 0 ? Math.floor(inputs.pingsInWindow) : 0;
  const base = { ping: false, pingsInWindow: pings, afk: false } as const;

  if (config.enabled !== true) {
    return { ...base, phase: "disabled", reason: "disabled_by_config", nextEligibleInMs: null };
  }
  if (channel?.exempt === true) {
    return { ...base, phase: "disabled", reason: "channel_exempt", nextEligibleInMs: null };
  }
  if (channel?.channel !== "host_prepare_stream") {
    return { ...base, phase: "disabled", reason: "capability_missing", nextEligibleInMs: null };
  }
  if (inputs.idle === null || inputs.runningChildren === null || inputs.lastLlmAt === null) {
    return { ...base, phase: "disabled", reason: "state_unknown", nextEligibleInMs: null };
  }
  if (inputs.idle !== true) {
    // 轮次进行中本就是一次真实请求，缓存必然新鲜，无需保活。
    return { ...base, phase: "disabled", reason: "busy", nextEligibleInMs: null };
  }
  if (inputs.inflight) {
    return { ...base, phase: inputs.runningChildren > 0 ? "stage1" : "stage2", reason: "inflight", nextEligibleInMs: null };
  }
  if (inputs.pendingInput) {
    return { ...base, phase: inputs.runningChildren > 0 ? "stage1" : "stage2", reason: "pending_input", nextEligibleInMs: null };
  }

  const sinceLlm = inputs.now - inputs.lastLlmAt;

  // ── 阶段一：有活跃子代理 ─────────────────────────────────────────────
  if (inputs.runningChildren > 0) {
    if (pings >= config.stage1MaxPings) {
      // 熔断：子代理疑似卡死，停止无限续费（子代理回报唤醒主管时由调用方归零）
      return { ...base, phase: "stage1", reason: "stage1_fused", nextEligibleInMs: null };
    }
    if (sinceLlm < config.stage1IntervalMs) {
      return {
        ...base,
        phase: "stage1",
        reason: "active_children_wait",
        nextEligibleInMs: config.stage1IntervalMs - sinceLlm,
      };
    }
    return {
      ...base,
      ping: true,
      phase: "stage1",
      reason: "stage1_ping",
      nextEligibleInMs: config.stage1IntervalMs,
      pingsInWindow: pings + 1,
    };
  }

  // ── 阶段二：全部子代理结束后的单次试探保活（AFK 判定）─────────────────
  if (inputs.stage2Used) {
    // 唯一机会已用：若此后**没有任何主管活动/人类交互**，等满一个短 TTL 窗口即判 AFK，
    // 彻底停止后续保活（成本上界 = 1 次 0.1x 试探）。
    const lastPing = inputs.lastPingAt;
    const lastActivity = inputs.lastActivityAt;
    const pingBeforeActivity = lastPing !== null && (lastActivity === null || lastActivity <= lastPing);
    if (pingBeforeActivity && inputs.now - (lastPing as number) >= KEEP_ALIVE_SHORT_TTL_MS) {
      return { ...base, phase: "afk", reason: "stage2_afk", nextEligibleInMs: null, afk: true };
    }
    // 有交互 ⇒ 正常对话已刷新缓存，阶段二机会由调用方重置（这里只等待）。
    const baseTime = lastActivity !== null && lastActivity > (lastPing ?? 0) ? lastActivity : (lastPing ?? inputs.lastLlmAt);
    const waited = inputs.now - baseTime;
    return {
      ...base,
      phase: "stage2",
      reason: "stage2_exhausted",
      nextEligibleInMs: Math.max(0, config.stage2GraceMs - waited),
    };
  }

  if (sinceLlm < config.stage2GraceMs) {
    return {
      ...base,
      phase: "stage2",
      reason: "stage2_wait",
      nextEligibleInMs: config.stage2GraceMs - sinceLlm,
    };
  }
  return {
    ...base,
    ping: true,
    phase: "stage2",
    reason: "stage2_ping",
    nextEligibleInMs: null,
    pingsInWindow: 1,
  };
}

/** 默认配置（由生效决策 + 内置默认装配）。 */
export function defaultKeepAliveConfig(enabled: boolean): KeepAliveConfig {
  return {
    enabled,
    stage1IntervalMs: KEEP_ALIVE_STAGE1_DEFAULTS.intervalMs,
    stage1MaxPings: KEEP_ALIVE_STAGE1_DEFAULTS.maxPings,
    stage2GraceMs: KEEP_ALIVE_STAGE2_DEFAULTS.graceMs,
  };
}

// ===== 四、审计与状态投影 =====

/** 单次尝试的结局（闭集；失败**绝不**按成功续期）。 */
export type KeepAliveOutcome =
  | "success" // 收到 finish 且非 aborted/error（含 max-tokens / tool-calls；不执行工具）
  | "not_attempted" // 未发请求（配置/能力/状态原因）
  | "maintenance_busy" // runMaintenance 同步拒绝（主管已被轮次/维护占用）
  | "pending_input" // 维护临界区内发现待处理输入 ⇒ 主动放弃
  | "aborted_input" // 人类输入/子回报到达 ⇒ abort 本插件控制器
  | "aborted_dispose" // 插件卸载/重载 ⇒ abort
  | "timeout" // 请求级超时已 abort（不承诺不合作 adapter 的严格上界）
  | "adapter_error" // finish.kind = error 或 prepareCall/stream 抛错
  | "aborted_adapter"; // finish.kind = aborted（非本插件原因）

/** 保活审计记录（结构化、可机读；只含元数据，**不含**正文/提示词/凭据）。 */
export interface KeepAliveAuditEntry {
  seq: number;
  at: number;
  phase: KeepAlivePhase;
  reason: KeepAliveReason;
  /** 结局（未发请求为 `not_attempted`）。 */
  outcome: KeepAliveOutcome;
  channel: KeepAliveChannel;
  elapsedMs: number | null;
  /** 失败/取消的简短机读原因（成功/未发请求为 null）。 */
  error: string | null;
  /** 请求 token 元数据（可选；不含内容）。 */
  usage: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null } | null;
}

/**
 * 构造审计记录（**只**含机读字段；绝不携带会话正文/提示词/prompt 片段）。
 * 这条纪律保证「审计留痕」与「无痕保活」不互相矛盾：留的是**行为元数据**，不是对话内容。
 */
export function makeKeepAliveAuditEntry(
  seq: number,
  decision: KeepAliveDecision,
  channel: KeepAliveChannel,
  elapsedMs: number | null,
  outcome: KeepAliveOutcome,
  error: string | null,
  at: number,
  usage: KeepAliveAuditEntry["usage"] = null,
): KeepAliveAuditEntry {
  return { seq, at, phase: decision.phase, reason: decision.reason, outcome, channel, elapsedMs, error, usage };
}

/** 单行审计摘要（≤160 字符，供 stderr 与看板状态行消费；格式稳定便于断言）。 */
export function formatKeepAliveAudit(entry: KeepAliveAuditEntry): string {
  const err = entry.error ? ` err=${String(entry.error).slice(0, 40)}` : "";
  const ms = entry.elapsedMs === null ? "" : ` ms=${entry.elapsedMs}`;
  return `keepalive seq=${entry.seq} phase=${entry.phase} reason=${entry.reason} outcome=${entry.outcome} channel=${entry.channel}${ms}${err}`;
}

/** 快照不可用原因（闭集；用于如实投影「为什么现在不能保活」）。 */
export type KeepAliveSnapshotUnavailable =
  | "no_supervisor" // project.yaml 未配置 supervisor.session / 无 live Agent
  | "no_snapshot" // 尚未观察到正常 loop 请求
  | "pending_observation" // 新请求已开始但尚未观察到完整 options（旧快照已失效）
  | "agent_replaced" // supervisor Agent 对象被替换（clear/compact/resume）
  | "session_replaced" // session 对象被替换
  | "route_changed" // 观察到的 route 与当前已知选择不一致
  | "config_changed" // 模型/工具/提示词指纹变化
  | "generation_changed" // 插件卸载/重载代际变化
  | "disposed"; // 已卸载

/**
 * 运行时状态投影（REST/`graph_get_settings`/GUI 消费；**不含**正文）。
 *
 * 明确区分 `configured`（原始配置）/ `effective`（解析结果）/ `capable`（公开能力）/
 * `active`（真实运行态）。缺口逐项列出，绝不把「未保活」显示成「成功」。
 */
export interface KeepAliveStatusProjection {
  configured: {
    project_mode: KeepAliveMode;
    project_malformed: boolean;
    global_raw: string;
    global_malformed: boolean;
    global_available: boolean;
  };
  effective: KeepAliveEffectiveProjection;
  capable: {
    channel: KeepAliveChannel;
    reason: KeepAliveChannelReason;
    missing: string[];
    ttl: "unknown" | "explicit";
    /** 未知 TTL 的有界假设值（ms）；`ttl === "explicit"` 时为 null。 */
    short_ttl_bound_ms: number | null;
    /** 是否具备「真实宿主公开 prepareCall/stream」通道。 */
    host_channel: boolean;
  };
  active: {
    phase: KeepAlivePhase;
    reason: KeepAliveReason;
    afk: boolean;
    pings_in_window: number;
    stage2_used: boolean;
    inflight: boolean;
    supervisor_session: string | null;
    children_running: number | null;
    idle: boolean | null;
    snapshot: "ready" | KeepAliveSnapshotUnavailable;
    last_llm_at: number | null;
    last_ping_at: number | null;
    last_activity_at: number | null;
    last_attempt: KeepAliveAuditEntry | null;
    seq: number;
  };
}

export function keepAliveStatusProjection(args: {
  resolution: KeepAliveResolution;
  projectRaw?: unknown;
  projectMalformed: boolean;
  globalRaw: string;
  globalMalformed: boolean;
  globalAvailable: boolean;
  channel: KeepAliveChannelDecision;
  active: KeepAliveStatusProjection["active"];
}): KeepAliveStatusProjection {
  const { resolution, channel, active } = args;
  return {
    configured: {
      project_mode: resolution.project_mode,
      project_malformed: args.projectMalformed,
      global_raw: args.globalRaw,
      global_malformed: args.globalMalformed,
      global_available: args.globalAvailable,
    },
    effective: {
      mode: resolution.project_mode,
      global: resolution.global_enabled,
      effective: resolution.enabled,
      source: resolution.source,
      malformed: resolution.malformed,
      modes: KEEP_ALIVE_MODES,
    },
    capable: {
      channel: channel.channel,
      reason: channel.reason,
      missing: channel.missing,
      ttl: channel.ttl,
      short_ttl_bound_ms: channel.ttl === "unknown" ? KEEP_ALIVE_SHORT_TTL_MS : null,
      host_channel: channel.channel === "host_prepare_stream",
    },
    active,
  };
}
