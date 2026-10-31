/**
 * 子代理长任务关照（Supervisor Long-Task Care，g-506）。
 *
 * 纯函数模块（无 IO、无定时器、无文件系统、无事件写入）：只做**关照调度判定**、
 * **两级配置（profile 全局 / workspace 项目）分层解析**、**巡检计数与人工升级判定**、
 * **暂停/继续/重置的组级调度状态机**与**只读投影**。
 * 结构照既有先例 `core/review-policy.ts`（策略纯函数 + 只读投影）与
 * `core/keepalive.ts`（两级三态分层 + fail-safe）。
 *
 * 背景：主管空闲、名下子代理持续工作超过阈值（默认 300s）时，插件定时**唤醒主管**发起关照任务，
 * 判断子代理是否因指令矛盾、不可实现目标、反复失败或重复路径陷入僵局。
 *
 * 与 g-505（缓存保活）的**本质区别**（判据 7，必须结构性区分）：
 *   · 保活是**成本优化**：无痕单发 `max_tokens: 1`，不进正常轮次、不产生判断；
 *   · 关照是**有意唤醒**：会产生真实轮次与 Token 成本，必须由主管做判断。
 *   二者共用同一「主管空闲 + 有活跃子代理」的采样面，但是**独立开关、独立计时、独立状态**；
 *   关照的唤醒**绝不**触发保活、保活也**绝不**投递关照 ⇒ 不可能互相唤醒成循环（见
 *   `CARE_WAKE_KINDS` 与 `assertNoMutualWake`）。
 *
 * 四条纪律（与 `clean=null` 同源）：
 * 1. **计时到期只是巡检触发器，不是卡死证据** —— 决策只产出「该巡检了」，绝不产出
 *    「子代理卡死了」；是否僵局由**主管基于可访问证据**判断（见 `CARE_STALL_SIGNALS`）。
 * 2. **有界** —— 连续无进展巡检封顶（默认 3 次）即请求人类裁决，绝不无限自动重试。
 * 3. **fail-safe** —— 任一运行态信号取不到即**不投递**（`unknown` 一律不触发），
 *    绝不把「拿不到证据」当作「子代理在跑」或「子代理卡死」。
 * 4. **不隐式越权** —— 自动唤醒**仅**授权关照检查，绝不绕过 rework=human、范围变更、
 *    开始执行、delivered 等既有人工 gate（见 `CARE_ALLOWED_ACTIONS`）。
 *
 * 边界（如实声明，不得声称引擎强制）：本模块只做**判定**与**投影**；真正唤醒主管由宿主接线完成
 * （`dsh-graph-host/index.js`），宿主缺能力时**如实标注能力缺口**（`CARE_CAPABILITIES`），
 * 绝不以静默无效代替功能完成。
 */

// ===== 一、配置：两级开关（profile 全局 + workspace 项目三态） =====

/**
 * 项目级三态取值（`project.yaml` 的 `supervisor.care`）：
 * - `inherit`：跟随全局设置（**默认**，字段缺失/显式为 null 时同样归一到此）；
 * - `true`：显式开启（覆盖全局，即使全局为关）；
 * - `false`：显式关闭（覆盖全局，即使全局为开）。
 */
export const CARE_MODES = ["inherit", "true", "false"] as const;
export type CareMode = (typeof CARE_MODES)[number];

/** 三态归一为**配置形态**（未配置/缺失/畸形 ⇒ `"inherit"`）。 */
export type CareConfigValue = CareMode | null;

/** 生效值的**来源**（闭集，供机读与 UI 徽标）。 */
export type CareSource =
  | "project_explicit" // 项目显式 true/false —— 严格优先
  | "global_explicit" // 项目 inherit，全局显式配置
  | "global_default" // 项目 inherit，全局也未配置 ⇒ 落到受控默认
  | "project_invalid" // 项目取值畸形（fail-safe：按关闭处理，绝不猜「开」）
  | "global_invalid"; // 全局取值畸形（fail-safe：按关闭处理）

/**
 * 受控默认：全局未配置时关照是否默认开启。
 *
 * 负责人已确认：**全局默认开启**，项目默认跟随全局。
 *
 * 与保活（纯省钱）不同，关照会产生真实成本，但它是**长任务可靠性的兜底**——
 * 负责人已明确拍板默认开启；关闭它等于放弃对僵局子代理的自动发现能力。
 * 但**畸形值一律按关闭**（见 `project_invalid`/`global_invalid`），绝不从坏值里猜「开」。
 */
export const CARE_DEFAULT_ENABLED = true;

/** 关照调度默认参数（负责人已确认的数值）。 */
export const CARE_DEFAULTS = Object.freeze({
  /**
   * 任务工作阈值（秒）：子代理持续工作 ≥ 此值且主管空闲 ⇒ 触发一次关照巡检。
   * 负责人确认默认 **300 秒**。
   */
  thresholdSeconds: 300,
  /**
   * 复查间隔（秒）：一次巡检未解决时，每隔此值复查一次。
   * 负责人确认默认 **300 秒**。
   */
  recheckSeconds: 300,
  /**
   * 连续无实质进展的巡检次数上限：达此值 ⇒ **请求负责人裁决**（不是自动返工授权）。
   * 负责人确认默认 **3 次**。有实质进展即**归零**（见 `decideCare`）。
   */
  maxStagnantRounds: 3,
});

/** g-506 返工：同一任务/attempt 连续**无有效结论**时最多自动提醒次数（达到后等待人工，静默）。 */
export const CARE_MAX_UNANSWERED_REMINDERS = 3;
/** g-506 返工：无有效结论的连续提醒之间的最小冷却（负责人明确 300 秒）。 */
export const CARE_NO_RESPONSE_COOLDOWN_MS = 300_000;

/** 阈值的合法范围（秒）：既拒绝「0 秒 = 每个扫描都触发」，也拒绝病态长值。 */
export const CARE_THRESHOLD_MIN_SECONDS = 30;
export const CARE_THRESHOLD_MAX_SECONDS = 24 * 60 * 60; // 24h 上界

export interface CareProjectConfig {
  /** 读侧原始三态（`null` = 未配置）。 */
  mode: CareConfigValue;
  /** 项目级阈值覆盖（秒；`null` = 继承全局）。 */
  thresholdSeconds: number | null;
  /** 项目级复查间隔覆盖（秒；`null` = 继承全局）。 */
  recheckSeconds: number | null;
}

export interface CareGlobalConfig {
  /** profile 级全局开关（`null`/`undefined` = 未配置）。 */
  enabled: boolean | null | undefined;
  /** profile 级全局阈值（秒；`null`/缺省 = 用受控默认）。 */
  thresholdSeconds?: number | null;
  /** profile 级全局复查间隔（秒；`null`/缺省 = 用受控默认）。 */
  recheckSeconds?: number | null;
}

/** 归一化后的生效决策（**唯一真源**：UI 投影、REST、宿主调度器都消费它）。 */
export interface CareResolution {
  /** 最终是否启用关照（唯一消费值）。 */
  enabled: boolean;
  /** 项目三态归一值（`inherit`/`true`/`false`）。 */
  project_mode: CareMode;
  /** 全局开关归一值（`null` = 未配置）。 */
  global_enabled: boolean | null;
  /** 生效值来源（机读闭集）。 */
  source: CareSource;
  /** 是否畸形（项目或全局取值无法判定）—— UI 必须显示「非法/需修」。 */
  malformed: boolean;
}

/**
 * **三态归一**（读侧唯一入口）：把任意原始值折叠为 `inherit`/`true`/`false`。
 *
 * 只认三种形态：真布尔 `true`/`false`；字符串 `"inherit"`（大小写不敏感、允许首尾空白）；
 * 缺失 / `null` / `undefined` ⇒ `inherit`。
 *
 * **其它一切取值**（数字、映射、数组、`"yes"`、`"on"`…）⇒ `inherit` 且由调用方标 `malformed`：
 * 绝不把畸形值猜成「强制开启」，也绝不猜成「强制关闭」——`inherit` 让决策退回上一层（全局），
 * 是唯一不会凭空引入语义的选择。
 */
export function normalizeCareMode(raw: unknown): CareMode {
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
export function isCareModeMalformed(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (raw === true || raw === false) return false;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    return !(s === "inherit" || s === "true" || s === "false");
  }
  return true; // 数字 / 映射 / 数组 …
}

/** 全局开关归一：只有真布尔算显式配置；其余（字符串/数字/映射/缺失）一律 `null` = 未配置。 */
export function normalizeCareGlobal(raw: unknown): boolean | null {
  return raw === true ? true : raw === false ? false : null;
}

/** 全局开关是否为畸形（存在但非真布尔、非 null/undefined）。 */
export function isCareGlobalMalformed(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  return raw !== true && raw !== false;
}

/**
 * 秒级配置值归一：只接受**有限正数**并在合法范围内；其余（含字符串数字、负数、NaN）⇒ `null`。
 *
 * 不做字符串→数字的隐式 coercion：手写 YAML 写 `threshold_seconds: "300"` 是配置错误，
 * 静默接受会掩盖「用户以为自己改了但其实没生效」的错觉。但**字符串数字**是常见手写形态，
 * 故明确接受（`"300"` ⇒ 300）——与既有多处 `scal()` 读侧行为一致。
 */
export function normalizeCareSeconds(raw: unknown): number | null {
  let n: number | null = null;
  if (typeof raw === "number" && Number.isFinite(raw)) n = raw;
  else if (typeof raw === "string") {
    const s = raw.trim();
    if (s !== "" && /^\d+(\.\d+)?$/.test(s)) {
      const parsed = Number(s);
      if (Number.isFinite(parsed)) n = parsed;
    }
  }
  if (n === null) return null;
  const v = Math.floor(n);
  if (v < CARE_THRESHOLD_MIN_SECONDS || v > CARE_THRESHOLD_MAX_SECONDS) return null;
  return v;
}

/**
 * **生效优先级**（单一真源）：项目覆盖全局，缺省继承全局。
 *
 * 判定顺序（严格按下表，无短路歧义）：
 * 1. 项目畸形 ⇒ `false` + `project_invalid`（fail-safe：坏值不当「开」）；
 * 2. 项目 `true` ⇒ `true` + `project_explicit`（压倒全局，哪怕全局关）；
 * 3. 项目 `false` ⇒ `false` + `project_explicit`（压倒全局，哪怕全局开）；
 * 4. 项目 `inherit`（含未配置）⇒ 看全局：
 *    - 全局畸形 ⇒ `false` + `global_invalid`；
 *    - 全局显式 ⇒ 该值 + `global_explicit`；
 *    - 全局未配置 ⇒ `CARE_DEFAULT_ENABLED` + `global_default`。
 */
export function resolveCare(
  project: CareProjectConfig | null | undefined,
  global: CareGlobalConfig | null | undefined,
): CareResolution {
  const projRaw = project?.mode;
  const globRaw = global?.enabled;
  const projectMalformed = isCareModeMalformed(projRaw);
  const globalMalformed = isCareGlobalMalformed(globRaw);
  const project_mode = normalizeCareMode(projRaw);
  const global_enabled = normalizeCareGlobal(globRaw);

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
    enabled: CARE_DEFAULT_ENABLED,
    project_mode,
    global_enabled,
    source: "global_default",
    malformed: false,
  };
}

/**
 * 生效**时间参数**解析（项目覆盖全局，缺省回落到受控默认）。
 * 与开关同优先级口径：项目有值即压倒全局；项目无值看全局；全局无值用默认。
 * 返回 `source` 供 UI **如实显示有效值来源**（判据 1 要求「UI 与服务端展示同一有效值及来源」）。
 */
export interface CareTimingResolution {
  thresholdSeconds: number;
  recheckSeconds: number;
  thresholdSource: CareSource;
  recheckSource: CareSource;
}

export function resolveCareTiming(
  project: CareProjectConfig | null | undefined,
  global: CareGlobalConfig | null | undefined,
): CareTimingResolution {
  const pick = (
    projRaw: unknown,
  ): { value: number; source: CareSource } => {
    const proj = normalizeCareSeconds(projRaw);
    if (proj !== null) return { value: proj, source: "project_explicit" };
    const glob = normalizeCareSeconds(global?.thresholdSeconds);
    if (glob !== null) return { value: glob, source: "global_explicit" };
    return { value: CARE_DEFAULTS.thresholdSeconds, source: "global_default" };
  };
  const pickRecheck = (projRaw: unknown): { value: number; source: CareSource } => {
    const proj = normalizeCareSeconds(projRaw);
    if (proj !== null) return { value: proj, source: "project_explicit" };
    const glob = normalizeCareSeconds(global?.recheckSeconds);
    if (glob !== null) return { value: glob, source: "global_explicit" };
    return { value: CARE_DEFAULTS.recheckSeconds, source: "global_default" };
  };
  const t = pick(project?.thresholdSeconds);
  const r = pickRecheck(project?.recheckSeconds);
  return {
    thresholdSeconds: t.value,
    recheckSeconds: r.value,
    thresholdSource: t.source,
    recheckSource: r.source,
  };
}

/**
 * 只读投影（REST GET/POST 与 `graph_get_settings` 同源下发）：
 * 把生效决策摊平成 UI 可直接渲染的形状 —— 项目三态、全局值、生效值、来源、时间参数与来源。
 * **客户端不自备默认值副本**，因此不可能与调度器漂移（判据 1/5 的单一真源要求）。
 */
export interface CareEffectiveProjection {
  /** 项目三态（`inherit` = 跟随全局）。 */
  mode: CareMode;
  /** 全局开关原始值（`null` = 未配置）。 */
  global: boolean | null;
  /** **实际生效**的关照开关（UI 必须可视化下发它）。 */
  effective: boolean;
  source: CareSource;
  malformed: boolean;
  /** 三态合法值清单（UI 下拉的唯一真源）。 */
  modes: readonly CareMode[];
  /** 生效的任务工作阈值（秒）。 */
  threshold_seconds: number;
  /** 生效的复查间隔（秒）。 */
  recheck_seconds: number;
  /** 阈值来源（UI 显示「有效值与来源」）。 */
  threshold_source: CareSource;
  /** 复查间隔来源。 */
  recheck_source: CareSource;
  /** 连续无进展巡检上限（达此值请求人类裁决）。 */
  max_stagnant_rounds: number;
  /** 受控默认（UI 显示「默认值」时引用，不另抄字面量）。 */
  defaults: { threshold_seconds: number; recheck_seconds: number; max_stagnant_rounds: number };
}

export function careEffectiveProjection(
  project: CareProjectConfig | null | undefined,
  global: CareGlobalConfig | null | undefined,
): CareEffectiveProjection {
  const res = resolveCare(project, global);
  const timing = resolveCareTiming(project, global);
  return {
    mode: res.project_mode,
    global: res.global_enabled,
    effective: res.enabled,
    source: res.source,
    malformed: res.malformed,
    modes: CARE_MODES,
    threshold_seconds: timing.thresholdSeconds,
    recheck_seconds: timing.recheckSeconds,
    threshold_source: timing.thresholdSource,
    recheck_source: timing.recheckSource,
    max_stagnant_rounds: CARE_DEFAULTS.maxStagnantRounds,
    defaults: {
      threshold_seconds: CARE_DEFAULTS.thresholdSeconds,
      recheck_seconds: CARE_DEFAULTS.recheckSeconds,
      max_stagnant_rounds: CARE_DEFAULTS.maxStagnantRounds,
    },
  };
}

// ===== 二、能力缺口（如实标注，绝不静默无效） =====

/**
 * 关照所需的宿主能力（判据 7：「真实宿主端到端验证空闲唤醒和干预通道，缺能力明确标注」）。
 *
 * 每一项都对应机制边界里的一条**真实能力要求**，缺任一项都必须在 UI/投影里如实显示，
 * 绝不用「静默无效」冒充「功能完成」。
 */
export const CARE_CAPABILITIES = [
  "idle_probe", // 能判定主管是否真实空闲
  "children_probe", // 能枚举主管名下关联子代理及其运行态
  "progress_read", // 能读取子代理近期消息/工具调用/进度（僵局判断的证据面）
  "wake_dispatch", // 能在主管空闲时投递一次关照任务（唤醒）
  "interrupt", // 能请求暂停执行中的子代理（干预 ①）
  "resume", // 能在暂停后**恢复或续轮**（宿主真实支持时；不支持则必须标注）
] as const;
export type CareCapability = (typeof CARE_CAPABILITIES)[number];

/** 能力缺口报告（宿主探测结果 → 机读缺口清单 + 人类可读原因）。 */
export interface CareCapabilityReport {
  /** 逐能力是否可用。 */
  available: Record<CareCapability, boolean>;
  /** 缺失能力清单（UI 必须显示；空数组 = 能力齐备）。 */
  missing: CareCapability[];
  /** 是否具备**端到端最小闭环**：采样 + 唤醒 + 证据面（没有它关照不可能有意义）。 */
  minimal: boolean;
  /** g-506 返工：宿主暴露了 seam、但插件未获授权/未验证其可用性的能力（绝不列 available）。 */
  unverified?: CareCapability[];
}

export function assessCareCapabilities(
  probe: Partial<Record<CareCapability, boolean>> | null | undefined,
): CareCapabilityReport {
  const available = {} as Record<CareCapability, boolean>;
  const missing: CareCapability[] = [];
  for (const cap of CARE_CAPABILITIES) {
    // fail-safe：未探测 ⇒ 视为**不可用**（宁可如实标注缺口，绝不假定能力存在）
    const ok = probe?.[cap] === true;
    available[cap] = ok;
    if (!ok) missing.push(cap);
  }
  // 最小闭环：能采样运行态 + 能投递唤醒。缺证据面（progress_read）时可读性受限但闭环仍在，
  // 故 `minimal` 只要求这三项存在（UI 仍会单独显示 progress_read 缺口）。
  const minimal = available.idle_probe && available.children_probe && available.wake_dispatch;
  return { available, missing, minimal };
}

// ===== 三、僵局判断的信号面（主管判断用，不由本模块自动定罪） =====

/**
 * 机制边界里列出的四类僵局成因（**主管判断的检查清单**，不是自动判定结果）。
 *
 * 本模块**绝不**自动宣称「发现逻辑死循环」——它只把这份清单随唤醒投递，由主管基于
 * **可访问的近期消息、工具调用/结果、进度与阻塞证据**逐条核对（判据 3）。
 */
export const CARE_STALL_SIGNALS = [
  "contradictory_instructions", // 指令矛盾
  "unachievable_goal", // 不可实现目标
  "repeated_failure", // 反复失败
  "repeated_path", // 重复路径
] as const;
export type CareStallSignal = (typeof CARE_STALL_SIGNALS)[number];

/**
 * 自动唤醒**唯一**被授权的动作（判据 4：不隐式绕过既有人工 gate）。
 * 任何超出此集合的动作都必须回到正常的人工 gate 流程。
 */
export const CARE_ALLOWED_ACTIONS = ["care_inspection"] as const;
export type CareAllowedAction = (typeof CARE_ALLOWED_ACTIONS)[number];

/** 自动唤醒**明确不绕过**的人工 gate（机读清单，供提示词与 UI 如实声明）。 */
export const CARE_PRESERVED_GATES = [
  "rework=human",
  "scope_change",
  "start_execution",
  "delivered",
] as const;

/**
 * 干预分三类（判据 4）。三类都要求**主管先取得真实证据**，且都必须遵守宿主真实能力。
 */
export const CARE_INTERVENTIONS = [
  // ① 有明确僵局证据 ⇒ 请求暂停，**确认停稳后**插入具体指导并恢复。
  //    绝不假定 `interrupt` 后仍可续 —— 宿主不支持续轮时必须如实标注能力缺口。
  "guide_and_resume",
  // ② 放弃重开：先停止并**确认旧 child 不运行**，再 abandon attempt、记录失败与修订指令/基线，
  //    按既有准入与负责人 rework 授权开新 attempt；禁止并发重复执行。
  "abandon_and_restart",
  // ③ 无法安全解决 / 涉及范围或判据冲突 ⇒ 停止相关执行并**报告人类裁决**，禁止无限自动重试。
  "stop_and_escalate",
] as const;
export type CareIntervention = (typeof CARE_INTERVENTIONS)[number];

/**
 * 干预可行性判定：把「想做的干预」与「宿主真实能力」对齐。
 *
 * 关键点（判据 4 的机器可验部分）：**`guide_and_resume` 必须同时具备
 * `interrupt` 与 `resume`**。只有 `interrupt` 而无 `resume` 时，暂停后无法安全恢复 ⇒
 * 如实判为不可行（`missing` 点名缺哪一项），**绝不**假定 `interrupt` 后仍可续。
 */
export function assessIntervention(
  intervention: CareIntervention,
  caps: CareCapabilityReport | null | undefined,
): { feasible: boolean; missing: CareCapability[] } {
  const a = caps?.available;
  if (!a) return { feasible: false, missing: ["idle_probe", "children_probe", "wake_dispatch"] };
  if (intervention === "guide_and_resume") {
    const need: CareCapability[] = ["interrupt", "resume"];
    const missing = need.filter((c) => a[c] !== true);
    return { feasible: missing.length === 0, missing };
  }
  if (intervention === "abandon_and_restart") {
    // 放弃重开要求「能确认旧执行已停止」——这由 children_probe（运行态重验）保证。
    const need: CareCapability[] = ["children_probe", "wake_dispatch"];
    const missing = need.filter((c) => a[c] !== true);
    return { feasible: missing.length === 0, missing };
  }
  // stop_and_escalate 只需要能报告（不依赖宿主执行能力）⇒ 恒可行。
  return { feasible: true, missing: [] };
}

// ===== 四、唤醒去重：与保活不互相唤醒成循环 =====

/** 唤醒种类（闭集）。关照与保活是**两条独立通道**，绝不相同。 */
export const CARE_WAKE_KINDS = ["care_inspection", "cache_keepalive"] as const;
export type CareWakeKind = (typeof CARE_WAKE_KINDS)[number];

/**
 * 唤醒通道的防御性一致性 helper（判据 7）。
 *
 * **真实机制**不是「投递前调用本函数」：关照与保活是两个独立 runtime/调度器，各自只构造自己
 * 的 source kind（`care_inspection` / `cache_keepalive`），且 g-506 已用双 runtime × 双 workspace
 * 实证互不唤醒（见 `core/tests/g506-care.test.ts` 的隔离用例与 g505 保活用例）。
 * 本函数只是可复用的防御性 helper，**当前生产投递路径并不调用它**；不得把「未调用的断言」
 * 宣称为运行时保证。保留它用于未来显式交叉检查，交叉调用会抛出。
 */
export function assertNoMutualWake(producer: CareWakeKind, emitted: CareWakeKind): void {
  if (producer !== emitted) {
    throw new Error(
      `唤醒通道交叉：${producer} 调度器不得投递 ${emitted} 唤醒（关照与缓存保活必须独立，禁止互相唤醒成循环）`,
    );
  }
}

/**
 * 去重键：同一「工作区 / 主管 / child / attempt」在冷却窗口内只允许一次投递（判据 2）。
 *
 * 组成即隔离边界：跨工作区、跨主管、跨 child、跨 attempt 天然不同键 ⇒ 状态互不串扰；
 * **换 attempt 必然换键** ⇒ 旧 attempt 的提醒不可能落到新 attempt 上（陈旧事件失效）。
 */
export function careDedupeKey(parts: {
  workspace: string;
  supervisor: string;
  child: string;
  attempt: string;
}): string {
  return [parts.workspace, parts.supervisor, parts.child, parts.attempt].join("\u0000");
}

// ===== 五、调度状态机（计时 / 暂停 / 继续 / 重置 / 巡检计数） =====

/**
 * 关照的**组级**调度阶段（判据 5/6）。
 *
 * - `idle`：启用中但**无运行中任务** ⇒ 无倒计时（UI 不得显示虚假倒计时）；
 * - `counting`：有运行中任务，倒计时进行中；
 * - `waiting_supervisor`：到期但**主管忙** ⇒ 延后（UI 显示「待主管空闲」，仍无倒计时）；
 * - `paused`：用户暂停（保留剩余时间）；
 * - `awaiting_human`：连续无进展达上限 ⇒ **等待人工裁决**（不再自动巡检，UI 如实显示）；
 * - `disabled`：配置关闭；
 * - `unavailable`：能力缺口（无法采样/唤醒）⇒ 如实显示不可用。
 */
export const CARE_PHASES = [
  "idle",
  "counting",
  "waiting_supervisor",
  "paused",
  "awaiting_human",
  "awaiting_outcome",
  "disabled",
  "unavailable",
] as const;
export type CarePhase = (typeof CARE_PHASES)[number];

/** 预算来源（goal 覆盖，或项目/全局/受控默认阈值）。 */
export type CareBudgetSource = "goal" | "project_explicit" | "global_explicit" | "global_default";

/** 一轮运行的**开始**证据来源（精确与否必须如实标注）。 */
export type CareRunStartSource = "attempt_record" | "agent_status" | "sample" | "unknown";
/** 一轮运行的**停止**证据来源。 */
export type CareRunStopSource = "agent_status" | "disposed" | "sample" | "unknown";

/** g-612：一次**生效预算变化**（只读历史；不是可编辑的第二个预算真源）。 */
export interface CareBudgetChange {
  /** 变化生效时刻（ms epoch）。 */
  at: number;
  seconds: number;
  source: CareBudgetSource;
}

/** g-612：同一 attempt 的一轮实际运行（自然墙钟，与关照倒计时无关）。 */
export interface CareRunRecord {
  /** 服务端生成的本轮 id（start 可证时由 child/attempt/start 稳定派生；start 未知时唯一派生）。 */
  id: string;
  goal: string;
  attempt: string;
  child: string;
  /** 本轮开始（ms epoch）；未知时 null（绝不伪造）。 */
  startedAt: number | null;
  startSource: CareRunStartSource;
  startExact: boolean;
  /** 本轮停止（ms epoch）；仍在运行/未知时 null。 */
  stoppedAt: number | null;
  stopSource: CareRunStopSource | null;
  stopExact: boolean;
  /**
   * 本轮**起始**生效预算与来源（历史快照，不随当前 goal 值回填）。
   * 运行中预算变化见 `budgetChanges`；停止时的 goal 值绝不冒充整轮预算。
   */
  budgetSeconds: number | null;
  budgetSource: CareBudgetSource | null;
  /** 本轮开始后**生效预算变化时间线**（不含起点；按发生顺序；有界，最多 31 条）。 */
  budgetChanges?: CareBudgetChange[];
  /** `budgetChanges` 是否因有界上限被截断（`true` = 中间有未展示的变化，起点不受影响）。 */
  budgetChangesTruncated?: boolean;
  /** 已停止时的自然经过时间（ms）；任一未知时 null。跨未观测空窗时仍为墙钟差，见 `naturalExact`。 */
  naturalMs: number | null;
  /** 自然经过时间 − **起始**预算（ms）；任一未知时 null（语义见 `deviationBasis`）。 */
  deviationMs: number | null;
  /** 是否超过**起始**预算；未知时 null。 */
  overBudget: boolean | null;
  /** 正常 runtime 重建等导致的**未观测空窗**（`true` = 该轮 elapsed 非全程连续可证）。 */
  observationInterrupted?: boolean;
  /** 可证的未观测区间（care 时钟；端点不可证时为空数组，绝不补造）。 */
  observationGaps?: Array<{ from: number; to: number }>;
  /** `naturalMs` 是否由连续观测 + 精确起止支撑；未知/跨空窗/非精确起止 ⇒ `false`/`null`。 */
  naturalExact?: boolean | null;
}

/** 项目内历史保留的已停止运行上限（有界；完整事件仍在项目 events.jsonl）。 */
export const CARE_RUN_HISTORY_LIMIT = 50;

/** 单个被照料任务（child/attempt 粒度）的调度记录。 */
export interface CareTaskState {
  child: string;
  attempt: string;
  goal: string;
  /** 当前 attempt 的绑定版本（服务端记录；变化 ⇒ 旧提醒/旧结论失效）。 */
  bindingVersion: number;
  /** 任务开始工作的时刻（ms epoch）——阈值计时的基准。 */
  startedAt: number;
  /** 最近一次**有实质进展**的时刻（ms epoch）；`null` = 尚未观测到进展。 */
  lastProgressAt: number | null;
  /** 进度指纹（主管提交的**有界证据摘要**；不是 mtime/size）。 */
  lastProgressFingerprint: string | null;
  /** 连续无进展巡检次数（有进展即归零）。 */
  stagnantRounds: number;
  /**
   * **人工裁决锁**（sticky，判据 3/6）：连续 `maxStagnantRounds` 份新鲜 no-progress 结论后置真。
   * 之后即使主管提交有证据的 progress（计数归零），本锁**绝不自动解除**——只有该 attempt
   * 结束、被替换（换 attempt ⇒ 新任务键）或人类另行处理才会消失。
   */
  humanLocked: boolean;
  /** 上次投递关照的时刻（ms epoch；`null` = 从未）。 */
  lastCareAt: number | null;
  /** 暂停时冻结的**本任务**剩余 ms（`null` = 未冻结）；继续时按它恢复各自倒计时。 */
  frozenRemainingMs: number | null;
  /** g-506 返工 B16：续期后的**绝对调度锚点**（不覆盖真实 startedAt/lastCareAt 事实）。 */
  scheduleDueAt?: number | null;
  /** g-506 返工：连续**无有效结论**的自动提醒次数（progress/no-progress 有效结论归零；unknown 不归零）。 */
  remindersSent?: number;
  /** g-506 返工：最近一次提醒后是否尚未收到任何结论（含 unknown 视为已回复但无有效结论）。 */
  awaitingReply?: boolean;
  /** g-506 返工：进入人工裁决的原因（`null` = 未锁定）。 */
  humanReason?: "no_progress_limit" | "no_response_limit" | null;
  /** g-612：goal 级预算（秒；null = 继承项目/全局 care_threshold_seconds）。 */
  budgetSeconds?: number | null;
  /** g-612：预算倒计时的最近有效基准（ms epoch；派发/主管消息/goal 预算变更）。 */
  budgetBaseAt?: number | null;
  /** g-612：当前倒计时是否由预算/消息重置派生（false = 关照后按复查间隔）。 */
  budgetCountdown?: boolean;
  /** g-612：上次实际采用的生效预算（秒）与来源（用于识别项目/全局默认变更）。 */
  budgetEffectiveSeconds?: number | null;
  budgetEffectiveSource?: CareBudgetSource | null;
  /** g-612：本轮运行开始（ms epoch）；停止后清空。 */
  runStartedAt?: number | null;
  runStartSource?: CareRunStartSource | null;
  runStartExact?: boolean;
  /** g-612：本任务最近一次被真实采样/观察为运行中的时刻（care 时钟；用于如实标注观察空窗）。 */
  lastObservedAt?: number | null;
  /**
   * g-612：本轮生效预算历史（只读、有界）：`[0]` 恒为**真实起点**预算，其后为最近的有效变化
   * （至多 31 条，总计 32 条）。只在值/来源真正变化时追加；超出上限时淘汰最旧的**变化**而
   * 绝不淘汰起点，并在 `budgetHistoryTruncated` 如实标记。
   */
  budgetHistory?: CareBudgetChange[];
  /** g-612：`budgetHistory` 是否因上限淘汰过变化（`true` = 中间有断档，起点仍真实）。 */
  budgetHistoryTruncated?: boolean;
  /**
   * g-612：**调整后**的未有效结论冷却绝对截止（ms epoch；只读调度状态）。
   * 暂停/长停后冷却剩余必须在 resume 后继续有效，不能被 `lastCareAt+300s` 的旧绝对时刻吃掉；
   * `null`/缺省 ⇒ 回退到既有 `lastCareAt + CARE_NO_RESPONSE_COOLDOWN_MS` 口径。
   */
  cooldownDueAt?: number | null;
  /** g-612：暂停时冻结的**冷却分量剩余**（ms；与 `frozenRemainingMs` 的预算分量分开保存）。 */
  frozenCooldownRemainingMs?: number | null;
}

/**
 * **组级**调度状态（一个主管 + 一个工作区 = 一组；判据 6：多子代理时作用于整组，
 * 避免暂停最早任务后下一任务立即触发）。
 */
export interface CareGroupState {
  /** 该组的暂停状态（**整组**共享，不是单任务）。 */
  paused: boolean;
  /** 暂停发生时刻（ms epoch）；`null` = 未暂停。 */
  pausedAt: number | null;
  /** 暂停时冻结的剩余时间（ms）；`null` = 未暂停。 */
  pausedRemainingMs: number | null;
  /** 上次「重置」的时刻（ms epoch）；`null` = 从未重置。 */
  resetAt: number | null;
  /** 最近一次投递的**实际**巡检时刻（ms epoch）；`null` = 从未。 */
  lastDeliveryAt: number | null;
  /** 组内已有任务进入人工裁决（派生投影;见各任务的 `humanLocked`）。 */
  escalated: boolean;
  /**
   * 服务端调度版本号：暂停/继续/重置/投递/身份切换都会递增。
   * 投递临界区在 `runMaintenance` 回调内对比捕获的版本，变化即放弃本次投递
   * （避免「点击暂停」与「到期投递」竞争时越过用户控制）。
   */
  revision: number;
  /** 最近一次控制动作（机读；`null` = 从未）。 */
  lastControl: "pause" | "resume" | "reset" | null;
  /** 与最近一次 requestId 绑定的控制动作（同 id 重放/冲突判定）。 */
  lastControlAction?: "pause" | "resume" | "reset" | null;
  /** 最近一次控制动作时刻（ms epoch）。 */
  lastControlAt: number | null;
  /** g-506 返工：最近一次 `reset` 的唯一请求 id（重试幂等；不按秒猜重复）。 */
  lastControlRequestId?: string | null;
}

export interface CareInputs {
  /** 当前时刻（ms epoch）——显式注入 ⇒ 判定确定性、零 sleep、零 flake。 */
  now: number;
  /** 生效配置。 */
  enabled: boolean;
  thresholdSeconds: number;
  recheckSeconds: number;
  maxStagnantRounds: number;
  /** 主管是否真实空闲（`null` = 未知 ⇒ fail-safe 不投递）。 */
  idle: boolean | null;
  /** 组级调度状态。 */
  group: CareGroupState;
  /** 被照料任务（**仅运行中**的；已结束的由调用方剔除）。 */
  tasks: CareTaskState[];
  /** 本组是否已有**投递中的**调度（防止重复投递）。 */
  delivering?: boolean;
  /** g-506 返工：本组是否已有**未解决且未过期**的巡检（有则不得再投递，避免重复唤醒）。 */
  openInspection?: boolean;
}

/** 单个任务的到期判定结果。 */
export interface CareTaskSchedule {
  child: string;
  attempt: string;
  goal: string;
  /** 距下一次巡检到期的剩余 ms（`0` = 已到期；`null` = 该任务无倒计时）。 */
  dueInMs: number | null;
  /** 该任务的下一次到期绝对时刻（ms epoch）；`null` = 无。 */
  dueAt: number | null;
  /** 是否已达到自动巡检上限（应请求人类裁决，而非再巡检）。 */
  escalated: boolean;
}

/** 组级调度决策（单一真源：UI 倒计时与宿主调度器消费同一结果）。 */
export interface CareDecision {
  phase: CarePhase;
  /** **是否此刻投递一次关照唤醒**（唯一副作用开关）。 */
  deliver: boolean;
  /** 机读原因（闭集）。 */
  reason: CareReason;
  /** 全组**最早有效**的下一次巡检到期时刻（ms epoch）；`null` = 无有效倒计时。
   *  UI 倒计时**必须**由它派生（判据 5：「多个子代理取最早有效的下一次关照时间」）。 */
  nextDueAt: number | null;
  /** 距最早到期的剩余 ms（`null` = 无倒计时）。 */
  nextDueInMs: number | null;
  /** 逐任务调度（供诊断与逐 child 展示）。 */
  tasks: CareTaskSchedule[];
  /** 达到上限、需要人类裁决的任务（非空 ⇒ phase 至少为 awaiting_human）。 */
  escalateTasks: string[];
  /** g-506 返工：因**未回复/unknown 达 3 次**而需进入等待人工的任务（不得当作 no-progress）。 */
  noResponseTasks?: string[];
}

export type CareReason =
  | "disabled_by_config"
  | "capability_missing" // 能力缺口（如实标注，不静默）
  | "no_running_tasks" // 无运行中任务 ⇒ 无倒计时
  | "paused" // 整组暂停（保留剩余时间）
  | "awaiting_human" // 已达巡检上限，等待人类裁决
  | "no_progress_limit" // 连续 no-progress 达上限，等待人类裁决
  | "no_response_limit" // 连续未回复/unknown 达 3 次，停止自动提醒，等待人类
  | "inspection_open" // 已投递巡检，等待主管回传结论（不重发）
  | "delivery_failed_limit" // 连续投递失败达上限，等待宿主恢复/人工重置
  | "supervisor_busy" // 到期但主管忙 ⇒ 延后，不打断当前轮次
  | "delivering" // 已有投递在途 ⇒ 去重
  | "counting" // 倒计时进行中，未到期
  | "deliver"; // 到期且主管空闲 ⇒ 投递

/**
 * **调度状态机唯一判定入口**（纯函数、无副作用、确定性）。
 *
 * 判定顺序（严格按下表，fail-safe 优先）：
 * 0. 配置关闭 ⇒ `disabled`（无倒计时）；
 * 1. 能力缺口（调用方通过 `delivering` 语义外的 `capable=false` 传入）⇒ `unavailable`；
 * 2. 整组暂停 ⇒ `paused`（**保留剩余时间**，无倒计时推进）；
 * 3. 无运行中任务 ⇒ `idle`（无倒计时）；
 * 4. 存在达上限任务 ⇒ `awaiting_human`（**不再自动巡检**）；
 * 5. 未到期 ⇒ `counting`（给出 `nextDueAt`）；
 * 6. 到期但 `idle === null`（未知）⇒ fail-safe **不投递**，按 `counting` 保守处理；
 * 7. 到期但主管忙 ⇒ `waiting_supervisor`（延后，**不打断当前轮次**）；
 * 8. 到期、主管空闲、已有投递在途 ⇒ `delivering`（去重）；
 * 9. 到期、主管空闲 ⇒ `deliver`。
 *
 * **重要语义**：`deliver=true` 只表示「该做一次关照巡检」，**绝不**表示「子代理卡死」。
 * 到零只是巡检到期（判据 5 明确要求 UI 语义如此）。
 */
/**
 * 单任务的下一次到期绝对时刻（**唯一**计时口径，宿主投影/控制与 `decideCare` 共用）。
 *
 * - 从未关照 ⇒ 从任务开始工作时刻起算**阈值**；
 * - 已关照 ⇒ 从上次关照起算**复查间隔**；
 * - 组级 `resetAt` 晚于上述基准 ⇒ 从重置时刻按当前间隔重新计满。
 */
/** 生效预算：goal 覆盖 > 项目阈值 > 全局阈值 > 受控默认（由调用方 timing 提供）。 */
export function careEffectiveBudgetSeconds(task: Pick<CareTaskState, "budgetSeconds">, timing: {
  thresholdSeconds: number;
  thresholdSource?: CareSource;
}): { seconds: number; source: CareBudgetSource } {
  const goal = normalizeCareSeconds(task.budgetSeconds);
  if (goal !== null) return { seconds: goal, source: "goal" };
  const source: CareBudgetSource = timing.thresholdSource === "project_explicit"
    || timing.thresholdSource === "global_explicit"
    || timing.thresholdSource === "global_default"
    ? timing.thresholdSource
    : "global_default";
  return { seconds: Math.max(1, Math.floor(timing.thresholdSeconds)), source };
}

export function careTaskIntervalMs(task: CareTaskState, timing: {
  thresholdSeconds: number;
  recheckSeconds: number;
  thresholdSource?: CareSource;
}): number {
  const budget = careEffectiveBudgetSeconds(task, timing);
  const budgetMs = budget.seconds * 1000;
  const recheckMs = Math.max(1, Math.floor(timing.recheckSeconds)) * 1000;
  // 首次关照、或主管新消息/预算变更重置后：按生效预算计时（goal 覆盖项目/全局默认）。
  if (task.lastCareAt === null || task.budgetCountdown === true) return budgetMs;
  // 连续无有效结论的提醒至少间隔 300s（即使项目复查更短）——避免「短阈值 + 未回复」高频唤醒。
  const unanswered = (task.remindersSent ?? 0) > 0 || task.awaitingReply === true;
  return Math.max(recheckMs, unanswered ? CARE_NO_RESPONSE_COOLDOWN_MS : 0);
}

/** 当前实际可执行（未人类锁）任务的冻结剩余最小值；没有 ⇒ `null`（绝不回退阈值）。 */
export function carePausedRemainingMs(tasks: Array<Pick<CareTaskState, "humanLocked" | "frozenRemainingMs">>): number | null {
  const frozen = tasks
    .filter((t) => t.humanLocked !== true && typeof t.frozenRemainingMs === "number")
    .map((t) => t.frozenRemainingMs as number);
  return frozen.length > 0 ? Math.min(...frozen) : null;
}

/**
 * 该任务当前是否处于「连续无有效结论（未回复/unknown）」状态 ⇒ 需要 300s 最小冷却。
 * 唯一判据沿用 g506 既有字段：`remindersSent > 0` 或 `awaitingReply === true`
 *（progress/no-progress 有效结论会把两者归零；humanLock 不参与此判据）。
 */
export function careCooldownActive(task: Pick<CareTaskState, "remindersSent" | "awaitingReply">): boolean {
  return (task.remindersSent ?? 0) > 0 || task.awaitingReply === true;
}

/**
 * 未有效结论冷却截止（ms epoch）；不处于冷却或没有可证起点 ⇒ `null`
 *（绝不拿 now 伪造冷却起点）。`CARE_NO_RESPONSE_COOLDOWN_MS` 是唯一 300s 语义源。
 *
 * g-612 返工：暂停/长停后的**调整后**冷却截止优先（`cooldownDueAt`，只读调度状态），
 * 否则回退既有 `lastCareAt + 300s`。预算编辑/主管新消息不得用旧绝对时刻把这个剩余吃掉。
 */
export function careCooldownDueAt(task: Pick<CareTaskState, "remindersSent" | "awaitingReply" | "lastCareAt" | "cooldownDueAt">): number | null {
  if (!careCooldownActive(task)) return null;
  if (typeof task.cooldownDueAt === "number" && Number.isFinite(task.cooldownDueAt)) return task.cooldownDueAt;
  if (task.lastCareAt === null || !Number.isFinite(task.lastCareAt)) return null;
  return task.lastCareAt + CARE_NO_RESPONSE_COOLDOWN_MS;
}

/**
 * 预算目标截止（**不含**未有效结论冷却）：调度锚点 / 预算基准 + 生效区间（goal 或项目默认）。
 * 供投影区分「预算目标」与「最终可执行截止」。
 */
export function careTaskBudgetDueAt(task: CareTaskState, timing: {
  thresholdSeconds: number;
  recheckSeconds: number;
  resetAt: number | null;
  thresholdSource?: CareSource;
}): number {
  const resetAt = timing.resetAt;
  // B16：续期使用独立绝对锚点，绝不反推真实 startedAt/lastCareAt（避免工作耗时/cooldown 事实被篡改）。
  if (typeof task.scheduleDueAt === "number" && Number.isFinite(task.scheduleDueAt)) {
    if (resetAt !== null && resetAt > task.scheduleDueAt) {
      return resetAt + careTaskIntervalMs(task, timing);
    }
    return task.scheduleDueAt;
  }
  // 预算/消息重置使用独立基准；否则沿用 g506 的真实 lastCareAt/startedAt。
  const base = task.budgetCountdown === true
    ? (typeof task.budgetBaseAt === "number" && Number.isFinite(task.budgetBaseAt) ? task.budgetBaseAt : task.startedAt)
    : (task.lastCareAt === null ? task.startedAt : task.lastCareAt);
  const interval = careTaskIntervalMs(task, timing);
  return resetAt !== null && resetAt > base ? resetAt + interval : base + interval;
}

/**
 * **公开投影**口径的预算目标截止（`care/status.tasks[].budget_due_at`）——与调度口径
 * `careTaskBudgetDueAt`/`careTaskDueAt` 分开：调度永远消费「max(预算, 冷却)」的可执行截止
 *（本函数**不参与** `careTaskDueAt`/timer/投递门禁），只回答「能否从**现有持久状态**严格证明
 * 一个独立的纯预算目标」，证不了就返回 `null`（未知）。绝不把合并后的实际截止冒充预算截止，
 * 也不为此新增/改变任何计时状态。
 *
 * 不可证 ⇒ `null` 的场景：
 * ① **暂停中**：倒计时被整组冻结，未来的绝对预算时刻要等 resume 才能确定；任何绝对时间都是
 *    伪造的未来（真值在 `paused_remaining_ms`/`due_in_ms` 的冻结剩余里）。
 * ② **冷却活跃且锚点不早于冷却截止**：`resumeCare` 写 `scheduleDueAt = now + max(预算剩余,
 *    冷却剩余)`，同时写 `cooldownDueAt = now + 冷却剩余` ⇒ 恢复写入的锚点**永不早于**冷却截止。
 *    因此 `锚点 >= 冷却截止` 时，锚点可能是恢复写入的合并值（冷却分量更晚），也可能来自旧版
 *    快照/更旧 resume 的混合值 —— 无可读 provenance 时**无法严格区分**纯预算与混合 ⇒ `null`。
 * ③ **冷却活跃且无锚点 / 锚点被 reset 覆盖**：此时派生值 `base + 生效区间` 里的区间本身已是
 *    「复查 ∪ 300s 冷却」（`careTaskIntervalMs`），不是纯预算 ⇒ `null`。
 *
 * ④ **已关照后的复查阶段**（`lastCareAt !== null` 且未处于预算倒计时）：此时不存在独立的
 *    预算目标，下一次截止 = `lastCareAt + max(复查间隔, 300s 冷却)`，它只由 `next_due_at`/
 *    `due_at` 表达；把 `lastCare + recheck` 当 `budget_due_at` 会把「复查到期」冒称成
 *    「预算超时」。`budget_due_at = null` 的语义因此包含「当前不存在独立预算阶段」，而不是
 *    「预算已超时」。不能反过来对所有 `budgetCountdown !== true` 一律置空：旧快照/首次尚未
 *    任何关照（`lastCareAt === null`）仍按源码判为预算阶段，必须继续返回可证预算目标。
 *
 * 可证 ⇒ 数字：
 * · 冷却不活跃：没有可合并项（锚点或 `base + 预算` 都是纯预算目标）。
 * · 冷却活跃但**锚点严格早于冷却截止**：任何 resume 变体（含旧版）都写不出这种关系
 *   （旧版 pause 冻结 `>= lastCare+300-pauseAt`，旧版 resume 同理），故只可能来自纯预算写入者
 *   （派发/主管消息/goal 预算编辑）⇒ 锚点就是纯预算目标。
 */
export function careTaskBudgetDueAtReportable(task: CareTaskState, timing: {
  thresholdSeconds: number;
  recheckSeconds: number;
  resetAt: number | null;
  thresholdSource?: CareSource;
}, reportable: { paused?: boolean } = {}): number | null {
  if (reportable.paused === true) return null; // ① 冻结中：没有可证的未来预算时刻
  // ④ 复查阶段没有独立预算目标：`lastCareAt + 复查间隔` 只属于 next_due_at。
  // 首次未关照（lastCareAt === null）即使旧快照缺 budgetCountdown=true 也仍视为预算阶段。
  const inIndependentBudgetPhase = task.budgetCountdown === true || task.lastCareAt === null;
  if (!inIndependentBudgetPhase) return null;
  const cooldownDue = careCooldownDueAt(task);
  if (cooldownDue === null) return careTaskBudgetDueAt(task, timing); // 无冷却 ⇒ 纯
  const anchor = typeof task.scheduleDueAt === "number" && Number.isFinite(task.scheduleDueAt)
    ? task.scheduleDueAt
    : null;
  if (anchor === null) return null; // ③ 只有「复查∪冷却」的派生值
  const resetAt = timing.resetAt;
  if (resetAt !== null && resetAt > anchor) return null; // ③ reset 派生区间含冷却
  // ② 只有严格早于冷却截止的锚点能证明是纯预算（resume 变体写不出更早）。
  return anchor < cooldownDue ? anchor : null;
}

/**
 * **公开投影**口径的未有效结论冷却截止（`care/status.tasks[].cooldown_due_at`）。
 *
 * 与预算字段同一条原则：只报**可证**的时刻，证不了就 `null`（未知），绝不显示可能错误/过期的
 * 绝对时间。内部 `careCooldownDueAt`（含 `lastCareAt + 300s` 回退）与 `careTaskDueAt`/`next_due`/
 * timer 完全不受影响——本函数只决定公开字段。
 *
 * `null` 的情形：
 * ① 暂停中：冷却剩余被冻结，绝对时刻要 resume 才能确定（真值在冻结剩余里）。
 * ② 不处于冷却：没有冷却截止可言。
 * ③ **没有可靠的调整后截止**（`cooldownDueAt` 缺失）：此时唯一可用的是 `lastCareAt + 300s`
 *    回退值——它不含历史暂停偏移（合法旧快照/长停 resume 后可能早已过期或偏移），**即便仍在未来
 *    也不能当作已证明的冷却截止**。
 * ④ 值等于回退值（`lastCareAt + 300s`）：可能是 resume 在缺冻结冷却分量时写下的保守补值，
 *    与真值不可区分 ⇒ 只做「 withhold 」，不据此断言。
 * ⑤ 已过期（`<= now`）：它已不是「下一次冷却截止」。
 * 其余（有可靠调整后截止、且在未来）照旧返回。
 */
export function careCooldownDueAtReportable(task: CareTaskState, reportable: {
  paused?: boolean;
  now?: number;
} = {}): number | null {
  if (reportable.paused === true) return null; // ①
  if (!careCooldownActive(task)) return null; // ②
  const persisted = typeof task.cooldownDueAt === "number" && Number.isFinite(task.cooldownDueAt)
    ? task.cooldownDueAt
    : null;
  if (persisted === null) return null; // ③ 只剩不含暂停偏移的回退值 ⇒ 不可证
  if (typeof task.lastCareAt === "number" && Number.isFinite(task.lastCareAt)
    && persisted === task.lastCareAt + CARE_NO_RESPONSE_COOLDOWN_MS) {
    return null; // ④ 与回退补值不可区分 ⇒ 保守未知（只减不增，不据此断言）
  }
  if (typeof reportable.now === "number" && Number.isFinite(reportable.now) && persisted <= reportable.now) {
    return null; // ⑤ 已过期
  }
  return persisted;
}

/**
 * 最终可执行截止（单一调度真源）：预算目标与未有效结论冷却取**较晚者**。
 * 负责人裁定（2026-10-31）：预算编辑/主管新消息立即重算预算目标，但若任务仍处于
 * 未回复/unknown 冷却，下一次提醒不得早于 `lastCareAt + 300s`；无冷却时不额外强加 300s，
 * 预算目标更晚时也不会被截短。UI/`care/status` 与调度器共用本函数（无双真源）。
 */
export function careTaskDueAt(task: CareTaskState, timing: {
  thresholdSeconds: number;
  recheckSeconds: number;
  resetAt: number | null;
  thresholdSource?: CareSource;
}): number {
  const budgetDue = careTaskBudgetDueAt(task, timing);
  const cooldownDue = careCooldownDueAt(task);
  return cooldownDue === null ? budgetDue : Math.max(budgetDue, cooldownDue);
}

export function decideCare(inputs: CareInputs, capable = true): CareDecision {
  const emptyTasks: CareTaskSchedule[] = [];
  const noCountdown = (phase: CarePhase, reason: CareReason, escalateTasks: string[] = []): CareDecision => ({
    phase,
    deliver: false,
    reason,
    nextDueAt: null,
    nextDueInMs: null,
    tasks: emptyTasks,
    escalateTasks,
  });

  // ── 0. 配置关闭 ──────────────────────────────────────────────────────────
  if (inputs.enabled !== true) return noCountdown("disabled", "disabled_by_config");
  // ── 1. 能力缺口：如实标注，绝不静默无效 ───────────────────────────────────
  if (capable !== true) return noCountdown("unavailable", "capability_missing");

  const tasks = Array.isArray(inputs.tasks) ? inputs.tasks : [];
  // ── 3. 无运行中任务 ⇒ 无倒计时（UI 不得显示虚假倒计时）──────────────────
  if (tasks.length === 0) return noCountdown("idle", "no_running_tasks");

  const group = inputs.group;

  /**
   * 单任务下一次到期时刻（见 `careTaskDueAt`；重置只重设计时：不动 `stagnantRounds`、
   * 不动 `humanLocked`，判据 6）。
   */
  const dueAtOf = (task: CareTaskState): number =>
    careTaskDueAt(task, { thresholdSeconds: inputs.thresholdSeconds, recheckSeconds: inputs.recheckSeconds, resetAt: group.resetAt });

  const noResponseLimitReached = (task: CareTaskState): boolean => {
    if ((task.remindersSent ?? 0) < CARE_MAX_UNANSWERED_REMINDERS) return false;
    // 第三次提醒刚发出时仍在等回复；只有「已回复但无有效结论（unknown）」或至少一个 300s 冷却
    // 过去仍无结论，才判定「连续无有效结论」达上限。绝不把刚发出的第 3 次算成第 4 次。
    if (task.awaitingReply !== true) return true;
    return task.lastCareAt !== null && inputs.now >= task.lastCareAt + CARE_NO_RESPONSE_COOLDOWN_MS;
  };
  const schedules: CareTaskSchedule[] = tasks.map((task) => {
    const limit = noResponseLimitReached(task);
    const escalated = (task.stagnantRounds ?? 0) >= inputs.maxStagnantRounds || task.humanLocked === true || limit;
    const dueAt = dueAtOf(task);
    return {
      child: task.child,
      attempt: task.attempt,
      goal: task.goal,
      dueInMs: escalated ? null : Math.max(0, dueAt - inputs.now),
      dueAt: escalated ? null : dueAt,
      escalated,
    };
  });
  const noResponseTasks = tasks.filter((t) => noResponseLimitReached(t)).map((t) => t.child);

  // ── 2. 整组暂停 ⇒ 保留剩余时间（无倒计时推进）───────────────────────────
  if (group.paused === true) {
    // B15：暂停剩余的唯一真源是**当前实际任务**的冻结值（任务结束/新加/锁变化立刻反映），
    // 不读 group 缓存。暂停中逐任务 dueInMs 是冻结值或 null，绝不随墙钟递减。
    const remaining = carePausedRemainingMs(tasks);
    const pausedSchedules = schedules.map((s) => {
      const t = tasks.find((x) => x.child === s.child && x.attempt === s.attempt);
      const frozen = t && t.humanLocked !== true && typeof t.frozenRemainingMs === "number" ? t.frozenRemainingMs : null;
      return { ...s, dueAt: null, dueInMs: frozen };
    });
    return {
      phase: "paused",
      deliver: false,
      reason: "paused",
      nextDueAt: null,
      nextDueInMs: null,
      tasks: pausedSchedules,
      escalateTasks: schedules.filter((s) => s.escalated).map((s) => s.child),
      noResponseTasks,
      ...(remaining !== null ? { pausedRemainingMs: remaining } : {}),
    };
  }

  // ── 4. 存在达上限任务 ⇒ 等待人工裁决，不再自动巡检 ────────────────────────
  const escalateTasks = schedules.filter((s) => s.escalated).map((s) => s.child);
  const liveSchedules = schedules.filter((s) => !s.escalated);
  if (liveSchedules.length === 0) {
    return {
      phase: "awaiting_human",
      deliver: false,
      reason: noResponseTasks.length > 0 ? "no_response_limit" : "no_progress_limit",
      nextDueAt: null,
      nextDueInMs: null,
      tasks: schedules,
      escalateTasks,
      noResponseTasks,
    };
  }

  // 全组最早有效到期（判据 5：多个子代理取最早有效的下一次关照时间）
  const dueAts = liveSchedules.map((s) => s.dueAt as number);
  const nextDueAt = Math.min(...dueAts);
  const nextDueInMs = Math.max(0, nextDueAt - inputs.now);

  // ── 4b. 已有未解决巡检 ⇒ 等待结论，不重复唤醒 ─────────────────────────────
  if (inputs.openInspection === true) {
    return {
      phase: "awaiting_outcome",
      deliver: false,
      reason: "inspection_open",
      nextDueAt: null,
      nextDueInMs: null,
      tasks: schedules,
      escalateTasks,
      noResponseTasks,
    };
  }

  // ── 5. 未到期 ⇒ 倒计时进行中 ─────────────────────────────────────────────
  if (nextDueInMs > 0) {
    return {
      phase: "counting",
      deliver: false,
      reason: "counting",
      nextDueAt,
      nextDueInMs,
      tasks: schedules,
      escalateTasks,
      noResponseTasks,
    };
  }

  // ── 6. fail-safe：到期但主管空闲状态未知 ⇒ **不投递** ─────────────────────
  if (inputs.idle === null) {
    return {
      phase: "counting",
      deliver: false,
      reason: "counting",
      nextDueAt,
      nextDueInMs: 0,
      tasks: schedules,
      escalateTasks,
    };
  }
  // ── 7. 到期但主管忙 ⇒ 延后，不打断当前轮次 ───────────────────────────────
  if (inputs.idle !== true) {
    return {
      phase: "waiting_supervisor",
      deliver: false,
      reason: "supervisor_busy",
      nextDueAt,
      nextDueInMs: 0,
      tasks: schedules,
      escalateTasks,
    };
  }
  // ── 8. 已有投递在途 ⇒ 去重（重复扫描合并）────────────────────────────────
  if (inputs.delivering === true) {
    return {
      phase: "counting",
      deliver: false,
      reason: "delivering",
      nextDueAt,
      nextDueInMs: 0,
      tasks: schedules,
      escalateTasks,
    };
  }
  // ── 9. 到期且主管空闲 ⇒ 投递一次关照唤醒 ─────────────────────────────────
  return {
    phase: "counting",
    deliver: true,
    reason: "deliver",
    nextDueAt,
    nextDueInMs: 0,
    tasks: schedules,
    escalateTasks,
  };
}

/**
 * 应用一次**投递**后的状态（纯函数：返回新状态，不修改入参）。
 *
 * 语义（判据 3）：
 * - 投递 **不** 增加 `stagnantRounds` —— 「无人应答」不等于「无进展」；
 * - 只有**本次巡检覆盖的目标**（`targets` 给出时）推进 `lastCareAt`；未到期的其他任务计时不变；
 * - `lastCareAt` 推进 ⇒ 下一轮按复查间隔计时。
 */
export function applyCareDelivery(group: CareGroupState, tasks: CareTaskState[], now: number, targets?: Array<{ child: string; attempt: string }>): {
  group: CareGroupState;
  tasks: CareTaskState[];
} {
  const keys = targets ? new Set(targets.map((t) => `${t.child}\u0000${t.attempt}`)) : null;
  return {
    group: { ...group, lastDeliveryAt: now },
    tasks: tasks.map((t) => {
      if (keys && !keys.has(`${t.child}\u0000${t.attempt}`)) return t;
      return {
        ...t,
        lastCareAt: now,
        scheduleDueAt: null, // 真实投递后由 lastCareAt + 有效区间重新计时
        budgetCountdown: false, // 关照已投递 ⇒ 回到复查间隔，直到下一条主管消息/预算变更
        // 每次实际投递都计入「连续无有效结论」预算；收到 progress/no-progress 有效结论后归零。
        remindersSent: (t.remindersSent ?? 0) + 1,
        awaitingReply: true,
        // 本次投递建立新的冷却起点（只读调度状态；后续暂停/重建保留剩余）。
        cooldownDueAt: now + CARE_NO_RESPONSE_COOLDOWN_MS,
        frozenCooldownRemainingMs: null,
      };
    }),
  };
}

/**
 * 巡检结论的三种合法取值（窄工具的唯一枚举）。
 * - `progress`：**有证据**的实质进展 ⇒ 计数归零（但**不**解除已有人工锁）；
 * - `no-progress`：**新鲜且未解决**的本次巡检没有实质进展 ⇒ 计数 +1；
 * - `unknown`：证据不足/无法判断/未回复 ⇒ **绝不递增、也绝不归零**。
 */
export const CARE_OUTCOMES = ["progress", "no-progress", "unknown"] as const;
export type CareOutcomeKind = (typeof CARE_OUTCOMES)[number];

/**
 * 结论**分类契约**（att-005 返工；来自一次真实误分类：child 只 sleep 300s、巡检前无新事件，
 * 主管以「仍 running + 预计静默」为依据回传 progress，reminders 1→0）。
 *
 * 该现场说明：只列 `progress|no-progress|unknown` 三个取值、不解释各自边界，接口说明是不充分的。
 * 这里把三值定义写成**单一真源**：`formatCareWakeMessage` 的唤醒正文与 `graph_care_outcome`
 * 的工具描述都必须逐条包含这些子句（由 `g506-care-outcome-contract.test.ts` 守卫）。
 *
 * 边界（不得越界声称）：
 * - 这是给**模型判断**的说明，不是机器语义校验：服务端仍只校验 evidence 非空等格式，
 *   不得据此宣称「所有模型永不误判」或「已机器验证 evidence 真实性」；
 * - 定义只描述**证据标准**，不按模型名/时间戳/sleep 等文本关键词自动判定；
 * - 计数规则（unknown 不增不清、3 份新鲜 no-progress 升级、progress 归零但不解人类锁）不变。
 */
export const CARE_OUTCOME_CONTRACT_ZH = [
  "progress = 自上次关照（或任务开始）以来**新增且可核实**的实质进展：具体完成的步骤、工具结果或产物/状态变化；证据必须指出这个新事实，重复或已报告过的旧进展不算新。",
  "no-progress = 有**新鲜证据**表明反复无实质推进或问题仍未解决；仅仅长时间没有新输出、或处于正常等待，不构成 no-progress，也不得据此宣称卡死。",
  "unknown = 证据不足/无法判断，或长时操作仍在正常等待（如 sleep、长构建/测试/网络）；按「未确认进展」处理，继续观察或询问子代理；只看根元数据无法知道进度时选 unknown。",
  "仅「仍在 running」、仅时间经过、符合预期的静默都**不是** progress；progress 归零计数但不解除人类锁，unknown 不递增也不归零，只有达到上限份数（默认 3）的新鲜 no-progress 才升级人工。",
] as const;

/** {@link CARE_OUTCOME_CONTRACT_ZH} 的英文对称版本（en 描述不得含 CJK）。 */
export const CARE_OUTCOME_CONTRACT_EN = [
  "progress = NEW and verifiable substantive progress since the last care round (or task start): a concrete completed step, tool result, or artifact/state change; the evidence must point at that new fact, and repeated or already-reported progress is not new.",
  "no-progress = FRESH evidence of repeated lack of substantive advance or an unresolved problem; a long silence with no new output, or a normal wait, is not no-progress and is never grounds for claiming a stall.",
  "unknown = evidence is insufficient/unverifiable, or a long operation is still normally waiting (sleep, long build/test/network); treat it as unconfirmed progress, keep observing or ask the child; if only root-level metadata is available, choose unknown.",
  "Merely \"still running\", merely elapsed time, and expected silence are NOT progress; progress resets the counter but never clears an existing human lock, unknown neither increases nor resets it, and only the configured limit (default 3) of fresh no-progress results escalates to the human.",
] as const;

export function normalizeCareOutcome(raw: unknown): CareOutcomeKind | null {
  return raw === "progress" || raw === "no-progress" || raw === "unknown" ? raw : null;
}

/**
 * 记录一次**巡检结论**（主管判断后回写）——判据 3 的计数规则：
 *
 * - `progress`（有实质进展）⇒ `stagnantRounds` **归零**，更新证据摘要与时刻；
 *   **但绝不解除 `humanLocked`**（人工裁决锁只能随 attempt 结束/替换消失）。
 * - `no-progress`（无实质进展）⇒ `stagnantRounds` **递增**（封顶 `maxStagnantRounds`），
 *   达到上限即置 `humanLocked = true`（请求负责人裁决，**不是**自动返工授权）。
 * - `unknown` ⇒ **完全不变**（未回复/证据不足不等于无进展）。
 *
 * 「有进展的计数重置规则」在此**明确且可测试**（判据 3 要求）。
 */
export function applyCareOutcome(
  group: CareGroupState,
  tasks: CareTaskState[],
  target: { child: string; attempt: string },
  outcome: { kind: CareOutcomeKind; fingerprint?: string | null; now: number; maxStagnantRounds: number },
): {
  group: CareGroupState;
  tasks: CareTaskState[];
  matched: boolean;
  counted: boolean;
  humanLocked: boolean;
} {
  const maxRounds = Math.max(1, Math.floor(outcome.maxStagnantRounds));
  let matched = false;
  let counted = false;
  const nextTasks = tasks.map((t) => {
    if (t.child !== target.child || t.attempt !== target.attempt) return t;
    matched = true;
    // 任何回传都表示本轮巡检已有回复（即使 unknown 没有有效结论）；unknown 不递增/不归零无进展计数，
    // 但保留 remindersSent，供「连续无有效结论」预算在下一轮继续累计。
    if (outcome.kind === "unknown") return { ...t, awaitingReply: false, scheduleDueAt: null, budgetCountdown: false };
    if (outcome.kind === "progress") {
      counted = true;
      return {
        ...t,
        lastProgressAt: outcome.now,
        lastProgressFingerprint: outcome.fingerprint ?? t.lastProgressFingerprint,
        stagnantRounds: 0, // 有进展 ⇒ 归零
        remindersSent: 0, // 有效结论 ⇒ 未回复预算归零
        awaitingReply: false,
        scheduleDueAt: null,
        budgetCountdown: false,
        // 有效结论 ⇒ 冷却结束；不得把旧调整后截止留给下一轮（下一轮投递会重建）。
        cooldownDueAt: null,
        frozenCooldownRemainingMs: null,
        // humanLocked / humanReason 原样保留：progress 绝不解除已有人工锁
      };
    }
    counted = true;
    const rounds = Math.min(maxRounds, (t.stagnantRounds ?? 0) + 1);
    const locked = t.humanLocked === true || rounds >= maxRounds;
    return {
      ...t,
      stagnantRounds: rounds,
      humanLocked: locked,
      humanReason: locked ? (t.humanReason === "no_response_limit" ? "no_response_limit" : "no_progress_limit") : (t.humanReason ?? null),
      remindersSent: 0, // no-progress 是有效结论 ⇒ 未回复预算归零（无进展预算独立累计）
      awaitingReply: false,
      scheduleDueAt: null,
      budgetCountdown: false,
      cooldownDueAt: null,
      frozenCooldownRemainingMs: null,
    };
  });
  const anyLocked = nextTasks.some((t) => t.humanLocked === true || (t.stagnantRounds ?? 0) >= maxRounds);
  return {
    group: { ...group, escalated: anyLocked },
    tasks: nextTasks,
    matched,
    counted,
    humanLocked: anyLocked,
  };
}

/**
 * g-506 返工：把「连续无有效结论达 3 次」的任务置入人工等待（**不是** no-progress 卡死）。
 *
 * - `remindersSent >= 3` 且（unknown 已回复无有效结论 或 300s 冷却已过仍无回复）；
 * - 保持 `stagnantRounds` 不变（绝不伪称卡死），`humanReason="no_response_limit"`；
 * - 与 no-progress 锁一样 sticky：progress/暂停/重置/过期都不自动解除；
 * - 返回 `changed`，宿主只在 changed 时事件先行落盘。
 */
export function applyNoResponseLimit(
  group: CareGroupState,
  tasks: CareTaskState[],
  now: number,
): { group: CareGroupState; tasks: CareTaskState[]; changed: boolean; locked: string[] } {
  let changed = false;
  const locked: string[] = [];
  const nextTasks = tasks.map((t) => {
    if (t.humanLocked === true) return t;
    if ((t.remindersSent ?? 0) < CARE_MAX_UNANSWERED_REMINDERS) return t;
    if (t.awaitingReply === true && (t.lastCareAt === null || now < t.lastCareAt + CARE_NO_RESPONSE_COOLDOWN_MS)) return t;
    changed = true;
    locked.push(t.child);
    return { ...t, humanLocked: true, humanReason: "no_response_limit" as const };
  });
  return {
    group: changed ? { ...group, escalated: true } : group,
    tasks: nextTasks,
    changed,
    locked,
  };
}

// ===== 六、暂停 / 继续 / 重置（判据 6） =====

/**
 * **暂停**：停止该主管当前工作区**整组**关照倒计时与自动巡检。
 *
 * 边界（判据 6，逐条对应）：
 * - 只停关照 ⇒ **不暂停子代理、不关闭缓存保活**（本函数只动关照调度状态）；
 * - **保留剩余时间** ⇒ 逐任务冻结剩余 ms（`frozenRemainingMs`），继续时按各自剩余恢复；
 * - 整组生效 ⇒ 暂停最早任务后，**下一任务不会立即触发**（组级 `paused` 短路所有任务）；
 * - **不撤回已投递巡检** ⇒ 本函数不碰 pending inspection（宿主侧记录独立保留）。
 *
 * 幂等：已是暂停态时重复调用返回**等价状态**（不重算剩余、不漂移、不递增 revision）。
 */
export function pauseCare(group: CareGroupState, tasks: CareTaskState[], inputs: {
  now: number;
  thresholdSeconds: number;
  recheckSeconds: number;
}): { group: CareGroupState; tasks: CareTaskState[] } {
  if (group.paused === true) return { group: { ...group }, tasks: tasks.map((t) => ({ ...t })) };
  const nextTasks = tasks.map((t) => {
    if (t.humanLocked === true) {
      return { ...t, frozenRemainingMs: null, frozenCooldownRemainingMs: null }; // 人工锁任务本无倒计时
    }
    const due = careTaskDueAt(t, {
      thresholdSeconds: inputs.thresholdSeconds,
      recheckSeconds: inputs.recheckSeconds,
      resetAt: group.resetAt,
    });
    // 冷却分量单独冻结：resume 后即使 goal 预算/主管消息重算预算目标，冻结剩余冷却也不能被
    // 暂停墙钟悄悄吃掉（reviewer 实测：长暂停后 lastCareAt+300s 绝对时刻早已过去）。
    const cooldownDue = careCooldownDueAt(t);
    const cooldownRemaining = cooldownDue === null ? null : Math.max(0, cooldownDue - inputs.now);
    return {
      ...t,
      frozenRemainingMs: Math.max(0, due - inputs.now),
      frozenCooldownRemainingMs: cooldownRemaining,
      scheduleDueAt: null,
    };
  });
  // 没有任何可执行（未锁）任务 ⇒ 如实无倒计时，绝不回退 threshold 伪造数字。
  const remaining = carePausedRemainingMs(nextTasks);
  return {
    group: {
      ...group,
      paused: true,
      pausedAt: inputs.now,
      pausedRemainingMs: remaining,
      revision: group.revision + 1,
      lastControl: "pause",
      lastControlAt: inputs.now,
    },
    tasks: nextTasks,
  };
}

/**
 * 旧版（g506/05f）**合法暂停快照**里未有效结论冷却的冻结剩余（ms）。
 *
 * 旧版 `pauseCare` 没有 `frozenCooldownRemainingMs` 字段，但它真实写下了 `group.pausedAt` 与
 * 任务的 `lastCareAt`（两者都是**事实**，不能被 resume 反推）。据此可严格重建暂停那一刻的剩余：
 * `max(0, lastCareAt + 300s - pausedAt)`。绝不把旧 `frozenRemainingMs`（可能由更长复查间隔主导，
 * 独立 review 实测 3590s）当作冷却，也绝不用 `now` 吃掉暂停期间流逝的墙钟。
 *
 * 边界（不可证 ⇒ `null`，调用方按**保守完整 300s** 处理，绝不提前）：
 * - `pausedAt`/`lastCareAt` 缺失或非有限数（正常旧版 pause 必写两者；仅缺字段/损坏快照会缺）；
 * - 时序不合理：`pausedAt < lastCareAt` 或 `pausedAt > now`。
 *
 * 暂停中发生过 reset（`resetAt >= lastCareAt`）时，按既有「暂停中 reset 刷新满 300s」语义把该
 * 候选纳入并 clip 到 300s —— 只会更长（绝不提前），也不会无限延长。
 */
export function legacyPausedCooldownRemainingMs(
  task: Pick<CareTaskState, "lastCareAt">,
  pausedAt: number | null,
  inputs: { now?: number; resetAt?: number | null } = {},
): number | null {
  if (typeof pausedAt !== "number" || !Number.isFinite(pausedAt)) return null;
  const now = inputs.now;
  if (typeof now === "number" && Number.isFinite(now) && pausedAt > now) return null;
  const lastCareAt = task.lastCareAt;
  if (typeof lastCareAt !== "number" || !Number.isFinite(lastCareAt)) return null;
  if (pausedAt < lastCareAt) return null;
  const remainingFrom = (from: number): number => Math.max(0, from + CARE_NO_RESPONSE_COOLDOWN_MS - pausedAt);
  let remaining = remainingFrom(lastCareAt);
  const resetAt = inputs.resetAt;
  if (typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt >= lastCareAt) {
    remaining = Math.max(remaining, Math.min(CARE_NO_RESPONSE_COOLDOWN_MS, remainingFrom(resetAt)));
  }
  return Math.min(CARE_NO_RESPONSE_COOLDOWN_MS, remaining);
}

/**
 * **继续**：从**各自冻结的剩余时间**计时（不是重新计满）。
 *
 * 实现：写独立每任务 `scheduleDueAt = now + frozenRemaining` 绝对锚点，**不修改**
 * `startedAt`/`lastCareAt` 真实事实（工作耗时、未回复 cooldown、REST 投影保持真实）。
 * 重置（暂停中发生）已被冻结进 `frozenRemainingMs`，故继续后 `resetAt` 归零（避免二次叠加）。
 */
export function resumeCare(group: CareGroupState, tasks: CareTaskState[], inputs: {
  now: number;
  thresholdSeconds: number;
  recheckSeconds: number;
  thresholdSource?: CareSource;
}): { group: CareGroupState; tasks: CareTaskState[] } {
  if (group.paused !== true) {
    return { group: { ...group }, tasks: tasks.map((t) => ({ ...t })) }; // 幂等
  }
  const nextTasks = tasks.map((t) => {
    const frozen = t.frozenRemainingMs;
    if (frozen === null || t.humanLocked === true) {
      return { ...t, frozenRemainingMs: null, frozenCooldownRemainingMs: null, scheduleDueAt: null };
    }
    // g-612：预算变更后需要「已消耗关照时间（不含暂停段）」；resume 时把基准推进到
    // now - 已消耗量，使暂停期间的真实墙钟绝不进入关照倒计时。
    const nominal = careTaskIntervalMs(t, inputs);
    const consumed = Math.max(0, nominal - Math.max(0, frozen));
    // g-612 返工：暂停冻结的**冷却分量**在 resume 后按新 now 恢复为调整后绝对截止；
    // 即使随后 goal 预算编辑/主管新消息重算预算目标，也无法把这段冻结剩余提前丢弃。
    const frozenCooldown = typeof t.frozenCooldownRemainingMs === "number" && Number.isFinite(t.frozenCooldownRemainingMs)
      ? Math.max(0, t.frozenCooldownRemainingMs)
      : null;
    const active = careCooldownActive(t);
    // g-612 att007：旧快照没有冻结冷却分量时，用**可证** `pausedAt`/`lastCareAt` 重建暂停前剩余；
    // 不可证 ⇒ 保守按完整 300s（绝不提前、也不把复查主导的 frozenRemaining 当冷却）。
    const adjustedCooldownDue = active
      ? inputs.now + (frozenCooldown !== null
        ? frozenCooldown
        : (legacyPausedCooldownRemainingMs(t, group.pausedAt, { now: inputs.now, resetAt: group.resetAt })
          ?? CARE_NO_RESPONSE_COOLDOWN_MS))
      : null;
    // B16：只写独立调度锚点，真实 startedAt/lastCareAt 永不反推。
    return {
      ...t,
      frozenRemainingMs: null,
      frozenCooldownRemainingMs: null,
      scheduleDueAt: inputs.now + Math.max(0, frozen),
      budgetBaseAt: inputs.now - consumed,
      cooldownDueAt: adjustedCooldownDue,
    };
  });
  return {
    group: {
      ...group,
      paused: false,
      pausedAt: null,
      pausedRemainingMs: null,
      resetAt: null,
      revision: group.revision + 1,
      lastControl: "resume",
      lastControlAt: inputs.now,
    },
    tasks: nextTasks,
  };
}

/**
 * **重置**：按当前生效的关照间隔**重新计满**。
 *
 * 边界（判据 6，逐条对应）：
 * - **只重设计时**：绝不清除 `stagnantRounds`（连续无进展记录保留）；
 * - 绝不解除 `humanLocked` / `escalated`（**不绕过等待人工裁决状态**）；
 * - 绝不隐式恢复已停任务（本函数不碰任务集合）；
 * - **暂停状态下重置仍保持暂停**（`paused` 保留；各任务冻结剩余刷新为满额）。
 */
export function resetCare(group: CareGroupState, tasks: CareTaskState[], inputs: {
  now: number;
  thresholdSeconds: number;
  recheckSeconds: number;
}): { group: CareGroupState; tasks: CareTaskState[] } {
  const nextTasks = tasks.map((t) => {
    if (group.paused !== true) return { ...t, frozenRemainingMs: null, scheduleDueAt: null };
    if (t.humanLocked === true) return { ...t, frozenRemainingMs: null, frozenCooldownRemainingMs: null, scheduleDueAt: null };
    // 暂停中重置按「生效区间」计满：未有效结论冷却存在时不得低于 300s（预算更晚则取预算）。
    const nominal = careCooldownActive(t)
      ? Math.max(careTaskIntervalMs(t, inputs), CARE_NO_RESPONSE_COOLDOWN_MS)
      : careTaskIntervalMs(t, inputs);
    return {
      ...t,
      frozenRemainingMs: nominal,
      // 重置也刷新冷却分量：resume 后调整后截止不得沿用重置前的旧冻结剩余。
      frozenCooldownRemainingMs: careCooldownActive(t) ? CARE_NO_RESPONSE_COOLDOWN_MS : null,
      scheduleDueAt: null,
    };
  });
  const remaining = group.paused === true ? carePausedRemainingMs(nextTasks) : group.pausedRemainingMs;
  return {
    group: {
      ...group,
      resetAt: inputs.now,
      pausedRemainingMs: remaining,
      revision: group.revision + 1,
      lastControl: "reset",
      lastControlAction: "reset",
      lastControlAt: inputs.now,
    },
    tasks: nextTasks,
  };
}

/** 新建一个空的组级状态（首次见到该组时使用）。 */
export function newCareGroupState(): CareGroupState {
  return {
    paused: false,
    pausedAt: null,
    pausedRemainingMs: null,
    resetAt: null,
    lastDeliveryAt: null,
    escalated: false,
    revision: 0,
    lastControl: null,
    lastControlAction: null,
    lastControlAt: null,
  };
}

// ===== 六之一：巡检记录与一次性/新鲜度/绑定校验（服务端唯一真源） =====

/**
 * 一次关照巡检的生命周期（服务端记录；客户端**不**维护第二套调度真源）。
 *
 * 关键语义：
 * - `queued`：消息已由 `Agent.send(message,"next-turn",true)` 入队，但**尚未观察**到 inbox 事件；
 *   `queued` **不是**「已投递成功」——宿主 `send` 返回 void，只有 `agent/inbox/inserted`
 *   才是 delivered 证据。
 * - `delivered`：观察到 `agent/inbox/inserted`（消息确实进入主管 inbox）。
 * - `claimed`：观察到 `agent/inbox/claimed`（主管即将处理该消息）。
 * - `resolved`：至少一份结论已受理（逐 target 一次性；全部 target 受理才算整体 resolved）。
 * - `expired`：超过新鲜度窗口仍无结论 ⇒ 旧记录拒绝回写（新周期会另发巡检）。
 * - `failed`：投递抛错（明确失败，不作为 delivered/answered）。
 */
export const CARE_INSPECTION_STATUSES = [
  "queued",
  "delivered",
  "claimed",
  "resolved",
  "expired",
  "failed",
] as const;
export type CareInspectionStatus = (typeof CARE_INSPECTION_STATUSES)[number];

export interface CareInspectionTarget {
  goal: string;
  attempt: string;
  child: string;
  /** 服务端记录的绑定版本（与 attempt meta 的 binding_version 同源；变化 ⇒ 陈旧）。 */
  bindingVersion: number;
  /** 一次性结论（`null` = 尚未回写）。 */
  outcome: CareOutcomeKind | null;
  outcomeAt: number | null;
  /** 证据摘要（有界字符串的稳定摘要；用于同结论幂等判定）。 */
  evidenceDigest: string | null;
  /**
   * g-612：该 target 的巡检已被**更新的事件**（主管→child 新消息 / goal 预算编辑）取代。
   * 只按显式事件顺序标记（消息 id / 预算编辑时刻），绝不靠「毫秒时间戳大小」猜；
   * 标记后仍可受理晚到结论做审计，但**不得**再改动任务状态（预算/计数/锁/提醒）。
   */
  staleReason?: "superseded_by_message" | "superseded_by_budget" | null;
  staleAt?: number | null;
  /** 取代它的稳定事件标识（消息 id；预算编辑写 "goal_budget"）——不含任何消息正文。 */
  supersededBy?: string | null;
}

export interface CareInspection {
  /** 服务端生成的 inspection id（随唤醒正文下发；**不由用户提供**）。 */
  id: string;
  /** canonical graph root（服务端真源）。 */
  root: string;
  /** 已配置且 live 的主管 session id（服务端真源）。 */
  supervisor: string;
  createdAt: number;
  /** 新鲜度截止时刻（超过即拒绝回写）。 */
  expiresAt: number;
  /** 创建时的组调度 revision（控制/投递竞争判定）。 */
  revision: number;
  status: CareInspectionStatus;
  /** `Agent.send` 构造的 UserMessage.id（观察 inbox 事件用）。 */
  messageId: string | null;
  targets: CareInspectionTarget[];
  deliveredAt: number | null;
  claimedAt: number | null;
  resolvedAt: number | null;
  lastError: string | null;
}

/** 巡检新鲜度窗口（ms）：默认一个复查间隔，并有下限/上限，避免病态短/长值。 */
export const CARE_INSPECTION_MIN_FRESHNESS_MS = 60_000;
export const CARE_INSPECTION_MAX_FRESHNESS_MS = 60 * 60 * 1000;

export function careInspectionFreshnessMs(recheckSeconds: number): number {
  const raw = Math.max(1, Math.floor(recheckSeconds)) * 1000;
  return Math.min(CARE_INSPECTION_MAX_FRESHNESS_MS, Math.max(CARE_INSPECTION_MIN_FRESHNESS_MS, raw));
}

/** 创建巡检记录（纯函数；id/时间由宿主提供）。 */
export function createCareInspection(input: {
  id: string;
  root: string;
  supervisor: string;
  now: number;
  revision: number;
  recheckSeconds: number;
  targets: Array<{ goal: string; attempt: string; child: string; bindingVersion: number }>;
}): CareInspection {
  return {
    id: input.id,
    root: input.root,
    supervisor: input.supervisor,
    createdAt: input.now,
    expiresAt: input.now + careInspectionFreshnessMs(input.recheckSeconds),
    revision: input.revision,
    status: "queued",
    messageId: null,
    targets: input.targets.map((t) => ({
      goal: t.goal,
      attempt: t.attempt,
      child: t.child,
      bindingVersion: t.bindingVersion,
      outcome: null,
      outcomeAt: null,
      evidenceDigest: null,
    })),
    deliveredAt: null,
    claimedAt: null,
    resolvedAt: null,
    lastError: null,
  };
}

/** 巡检是否仍可回写（未过期、未失败、未整体解决、至少一个 target 未解决）。 */
export function careInspectionOpen(inspection: CareInspection | null | undefined, now: number): boolean {
  if (!inspection) return false;
  if (inspection.status === "failed" || inspection.status === "expired") return false;
  if (now > inspection.expiresAt) return false;
  return inspection.targets.some((t) => t.outcome === null);
}

/** 把巡检状态推进为「按时间自然过期」（纯函数；只作用于未整体解决的记录）。 */
export function expireCareInspection(inspection: CareInspection, now: number): CareInspection {
  if (inspection.status === "resolved" || inspection.status === "failed") return inspection;
  if (now <= inspection.expiresAt) return inspection;
  return { ...inspection, status: "expired", lastError: inspection.lastError ?? "freshness_expired" };
}

export type CareOutcomeRejection =
  | "inspection_unknown"
  | "wrong_root"
  | "wrong_identity"
  | "inspection_not_open"
  | "expired"
  | "target_not_in_inspection"
  | "stale_binding"
  | "already_resolved"
  | "invalid_outcome";

/**
 * 服务端校验一份巡检结论（纯函数；**不修改**任何状态）。
 *
 * 顺序（fail-closed）：
 * 1. 记录存在 ⇒ 2. root 匹配 ⇒ 3. **精确 live 主管**匹配 ⇒ 4. 记录仍开放/新鲜 ⇒
 * 5. target 三元组在本次巡检内 ⇒ 6. 绑定版本与**当前** attempt 一致 ⇒ 7. 一次性/幂等判定。
 *
 * 同一 target 的**完全相同结论 + 相同证据摘要**重复提交 ⇒ `idempotent`（不重复计数/不重复记事件）；
 * 任何不同的第二份结论 ⇒ `already_resolved`（**拒绝**，绝不二次计数）。
 */
export function validateCareOutcome(input: {
  inspection: CareInspection | null | undefined;
  now: number;
  root: string;
  supervisor: string;
  goal: string;
  attempt: string;
  child: string;
  bindingVersion: number;
  outcome: CareOutcomeKind | null;
  evidenceDigest: string;
}): { ok: true; target: CareInspectionTarget; idempotent: boolean; stale: boolean } | { ok: false; code: CareOutcomeRejection } {
  const { inspection } = input;
  if (!inspection) return { ok: false, code: "inspection_unknown" };
  if (inspection.root !== input.root) return { ok: false, code: "wrong_root" };
  if (inspection.supervisor !== input.supervisor) return { ok: false, code: "wrong_identity" };
  if (inspection.status === "failed" || inspection.status === "expired") {
    return { ok: false, code: "inspection_not_open" };
  }
  const target = inspection.targets.find(
    (t) => t.goal === input.goal && t.attempt === input.attempt && t.child === input.child,
  );
  if (!target) return { ok: false, code: "target_not_in_inspection" };
  if (target.bindingVersion !== input.bindingVersion) return { ok: false, code: "stale_binding" };
  if (!input.outcome) return { ok: false, code: "invalid_outcome" };
  // g-612：目标已被**之后**的主管→child 消息 / goal 预算编辑取代（显式事件标记，非毫秒比较）。
  // 晚到结论仍可受理以便审计/一次性幂等，但调用方必须**只记历史、不改任务状态**。
  const stale = target.staleReason != null;
  // B17：已 resolved 的同值重试必须幂等（即使巡检 freshness 已过期）；只有**新的**结果
  // 才受 expiresAt 约束，过期后不得再接受。
  if (target.outcome !== null) {
    const same = target.outcome === input.outcome && target.evidenceDigest === input.evidenceDigest;
    return same ? { ok: true, target, idempotent: true, stale } : { ok: false, code: "already_resolved" };
  }
  if (input.now > inspection.expiresAt) return { ok: false, code: "expired" };
  return { ok: true, target, idempotent: false, stale };
}

/** 受理一份结论后的巡检记录（纯函数；调用方须在**事件先行**成功后再应用）。 */
export function applyCareInspectionOutcome(
  inspection: CareInspection,
  outcome: { goal: string; attempt: string; child: string; kind: CareOutcomeKind; evidenceDigest: string; now: number },
): CareInspection {
  const targets = inspection.targets.map((t) =>
    t.goal === outcome.goal && t.attempt === outcome.attempt && t.child === outcome.child && t.outcome === null
      ? { ...t, outcome: outcome.kind, outcomeAt: outcome.now, evidenceDigest: outcome.evidenceDigest }
      : t,
  );
  const allResolved = targets.every((t) => t.outcome !== null);
  return {
    ...inspection,
    targets,
    status: allResolved ? "resolved" : inspection.status,
    resolvedAt: allResolved ? outcome.now : inspection.resolvedAt,
  };
}

// ===== 六之二：主机侧取用入口（单一真源：调度器与 REST/UI 投影消费同一结果） =====

/**
 * 宿主侧入口：把「**项目半边**配置（来自 project.yaml）+ **真实全局开关**（来自 profile settings）」
 * 折叠成生效决策。`project.yaml` 里没有全局值，故读侧 core 只能给项目半边，全局半边由宿主补齐。
 */
export function careResolutionOf(
  project: CareProjectConfig | null | undefined,
  global: CareGlobalConfig | null | undefined,
): CareResolution {
  return resolveCare(project, global);
}

/**
 * 宿主侧入口：下发给 UI/REST 的**生效投影**（项目三态 + 全局值 + 实际生效值 + 来源 + 时间参数）。
 *
 * UI 与调度器消费**同一条**调用 ⇒ 「界面展示的有效值」与「宿主真实行为」结构上不可能分歧
 * （判据 1「UI 与服务端展示同一有效值及来源」的落地形态）。
 */
export function careEffectiveOf(
  project: CareProjectConfig | null | undefined,
  global: CareGlobalConfig | null | undefined,
): CareEffectiveProjection {
  return careEffectiveProjection(project, global);
}

// ===== 六之三：状态投影与唤醒正文（UI/REST/调度器同源） =====

/** 一次已受理结论的轻量记录（供状态投影显示「最后结果」；绝不含会话正文）。 */
export interface CareOutcomeRecord {
  inspection: string;
  goal: string;
  attempt: string;
  child: string;
  outcome: CareOutcomeKind;
  at: number;
  counted: boolean;
  idempotent: boolean;
  stagnant_rounds: number;
  human_locked: boolean;
}

/** 下发给 REST/GUI 的关照状态（**服务端唯一真源**；客户端只做显示派生）。 */
export interface CareStatusProjection {
  root: string;
  supervisor: string | null;
  supervisor_live: boolean;
  supervisor_idle: boolean | null;
  configured: CareEffectiveProjection;
  capable: CareCapabilityReport;
  phase: CarePhase;
  reason: CareReason;
  /** 全组最早有效巡检到期**绝对时刻**（ms epoch）；`null` = 无倒计时。 */
  next_due_at: number | null;
  next_due_in_ms: number | null;
  /** 服务端采样时刻：客户端据此校正时钟偏移，不另立调度真源。 */
  server_now: number;
  paused: boolean;
  paused_remaining_ms: number | null;
  revision: number;
  tasks: Array<CareTaskSchedule & {
    started_at: number;
    stagnant_rounds: number;
    human_locked: boolean;
    human_reason: "no_progress_limit" | "no_response_limit" | null;
    reminders_sent: number;
    awaiting_reply: boolean;
    last_care_at: number | null;
    last_progress_at: number | null;
    /** goal 级预算（秒；null = 继承默认）。 */
    budget_seconds: number | null;
    /** 本任务当前生效预算（goal 或项目/全局/默认阈值）。 */
    effective_budget_seconds: number;
    budget_source: CareBudgetSource;
    budget_base_at: number | null;
    budget_countdown: boolean;
    /**
     * 预算目标截止（不含 300s 未有效结论冷却；用于清楚区分两个口径）。
     * `null` = **无法从现有状态可靠证明**这个独立时刻，不是「没有预算」：
     * 暂停中（倒计时冻结，未来绝对时刻未定），或暂停恢复后 `scheduleDueAt` 已被
     * `max(预算剩余, 冷却剩余)` 合并、纯预算分量不可还原。预算时长仍见
     * `budget_seconds`/`effective_budget_seconds`，真实可执行截止见 `next_due_at`。
     */
    budget_due_at: number | null;
    /**
     * 未有效结论冷却截止；`null` = **没有可证的冷却截止**：不处于冷却、暂停中（剩余被冻结）、
     * 只有不含暂停偏移的 `lastCareAt+300s` 回退值（旧快照/长停 resume 后不可证）、值等于该回退
     * 补值、或该时刻已过期。绝不显示会提前/虚假触发的谎值；真实可执行截止始终看 `next_due_at`。
     */
    cooldown_due_at: number | null;
    /** 本轮运行（自然墙钟；与关照倒计时分开）。 */
    run_started_at: number | null;
    run_start_source: CareRunStartSource | null;
    run_start_exact: boolean;
    run_natural_ms: number | null;
  }>;
  /** 最近有界运行历史（仅本项目；旧快照/未观测为已知空/未知，不伪造）。 */
  runs: Array<{
    id: string;
    goal: string;
    attempt: string;
    child: string;
    started_at: number | null;
    start_source: CareRunStartSource;
    start_exact: boolean;
    stopped_at: number | null;
    stop_source: CareRunStopSource | null;
    stop_exact: boolean;
    budget_seconds: number | null;
    budget_source: CareBudgetSource | "unknown";
    /** 起始预算之后的变化时间线（只读；起点见 started_at/budget_seconds）。 */
    budget_changes: CareBudgetChange[];
    /** 变化时间线是否因有界上限被截断（true = 中间有未展示变化；起始值不受影响）。 */
    budget_changes_truncated: boolean;
    natural_ms: number | null;
    deviation_ms: number | null;
    /** 偏差口径（当前仅 `initial`：相对起始预算）；null = 偏差不可算。 */
    deviation_basis: "initial" | null;
    over_budget: boolean | null;
    /** 正常 runtime 重建造成的未观测空窗（elapsed 非全程连续可证）。 */
    observation_interrupted: boolean;
    /** 可证空窗区间（端点不可证时为空，不补造）。 */
    observation_gaps: Array<{ from: number; to: number }>;
    /** elapsed 是否由连续观测 + 精确起止支撑；未知 ⇒ null。 */
    natural_exact: boolean | null;
  }>;
  /** 已停止运行的历史保留上限。 */
  run_history_limit: number;
  escalate_tasks: string[];
  awaiting_human: boolean;
  pending_inspections: Array<{
    id: string;
    status: CareInspectionStatus;
    created_at: number;
    expires_at: number;
    message_id: string | null;
    delivered_at: number | null;
    claimed_at: number | null;
    targets: Array<{ goal: string; attempt: string; child: string; outcome: CareOutcomeKind | null }>;
  }>;
  last_outcome: CareOutcomeRecord | null;
  /** 配置告警（畸形/越界；UI 必须如实显示，绝不静默归一）。 */
  warnings: string[];
}

export function careStatusProjection(args: {
  now: number;
  root: string;
  supervisor: string | null;
  supervisorLive: boolean;
  supervisorIdle: boolean | null;
  configured: CareEffectiveProjection;
  capable: CareCapabilityReport;
  decision: CareDecision;
  group: CareGroupState;
  tasks: CareTaskState[];
  pendingInspections: CareInspection[];
  lastOutcome: CareOutcomeRecord | null;
  runs?: CareRunRecord[];
  warnings?: string[];
}): CareStatusProjection {
  const byKey = new Map(args.tasks.map((t) => [`${t.child}\u0000${t.attempt}`, t]));
  const tasks = args.decision.tasks.map((s) => {
    const st = byKey.get(`${s.child}\u0000${s.attempt}`);
    const budget = careEffectiveBudgetSeconds(st ?? { budgetSeconds: null }, {
      thresholdSeconds: args.configured.threshold_seconds,
      thresholdSource: args.configured.threshold_source,
    });
    const runStartedAt = st?.runStartedAt ?? null;
    const dueTiming = {
      thresholdSeconds: args.configured.threshold_seconds,
      recheckSeconds: args.configured.recheck_seconds,
      resetAt: args.group.resetAt,
      thresholdSource: args.configured.threshold_source,
    };
    return {
      ...s,
      started_at: st?.startedAt ?? args.now,
      stagnant_rounds: st?.stagnantRounds ?? 0,
      human_locked: st?.humanLocked === true,
      human_reason: st?.humanReason ?? null,
      reminders_sent: st?.remindersSent ?? 0,
      awaiting_reply: st?.awaitingReply === true,
      last_care_at: st?.lastCareAt ?? null,
      last_progress_at: st?.lastProgressAt ?? null,
      budget_seconds: typeof st?.budgetSeconds === "number" && Number.isFinite(st.budgetSeconds) ? st.budgetSeconds : null,
      effective_budget_seconds: budget.seconds,
      budget_source: budget.source,
      budget_base_at: typeof st?.budgetBaseAt === "number" && Number.isFinite(st.budgetBaseAt) ? st.budgetBaseAt : null,
      budget_countdown: st?.budgetCountdown === true,
      // 投影只报「可证」的独立预算目标；暂停中或恢复后的合并锚点 ⇒ null（未知），
      // 绝不把 max(预算,冷却) 冒充纯预算。调度口径不受影响（见 careTaskDueAt）。
      budget_due_at: st ? careTaskBudgetDueAtReportable(st, dueTiming, { paused: args.group.paused === true }) : null,
      // 只报可证/未来的冷却截止：暂停中冻结、已过期或旧快照回退补值 ⇒ null（不谎报）。
      cooldown_due_at: st ? careCooldownDueAtReportable(st, { paused: args.group.paused === true, now: args.now }) : null,
      // `due_at`（来自 decision，唯一可执行口径）= max(预算目标, 冷却截止)
      // —— 调度与 UI 永远消费同一个值，不存在更早的隐藏 deadline；`next_due_at` 始终可信。
      run_started_at: typeof runStartedAt === "number" && Number.isFinite(runStartedAt) ? runStartedAt : null,
      run_start_source: st?.runStartSource ?? null,
      run_start_exact: st?.runStartExact === true,
      run_natural_ms: typeof runStartedAt === "number" && Number.isFinite(runStartedAt)
        ? Math.max(0, args.now - runStartedAt)
        : null,
    };
  });
  return {
    root: args.root,
    supervisor: args.supervisor,
    supervisor_live: args.supervisorLive,
    supervisor_idle: args.supervisorIdle,
    configured: args.configured,
    capable: args.capable,
    phase: args.decision.phase,
    reason: args.decision.reason,
    next_due_at: args.decision.nextDueAt,
    next_due_in_ms: args.decision.nextDueInMs,
    server_now: args.now,
    paused: args.group.paused === true,
    paused_remaining_ms: args.group.paused === true ? carePausedRemainingMs(args.tasks) : args.group.pausedRemainingMs,
    revision: args.group.revision,
    tasks,
    runs: (Array.isArray(args.runs) ? args.runs.slice(-CARE_RUN_HISTORY_LIMIT) : []).map((r) => ({
      id: r.id,
      goal: r.goal,
      attempt: r.attempt,
      child: r.child,
      started_at: r.startedAt,
      start_source: r.startSource,
      start_exact: r.startExact,
      stopped_at: r.stoppedAt,
      stop_source: r.stopSource,
      stop_exact: r.stopExact,
      // 起始预算/来源（历史快照）；变化时间线见 budget_changes；停止时 goal 值不回填。
      budget_seconds: r.budgetSeconds,
      budget_source: r.budgetSource ?? "unknown",
      budget_changes: (Array.isArray(r.budgetChanges) ? r.budgetChanges : []).map((c) => ({
        at: c.at, seconds: c.seconds, source: c.source,
      })),
      budget_changes_truncated: r.budgetChangesTruncated === true,
      natural_ms: r.naturalMs,
      // 偏差语义显式：相对**起始**预算；预算变化时间线单独给出，绝不冒充整轮单值。
      deviation_ms: r.deviationMs,
      deviation_basis: r.deviationMs === null ? null : "initial",
      over_budget: r.overBudget,
      observation_interrupted: r.observationInterrupted === true,
      observation_gaps: (Array.isArray(r.observationGaps) ? r.observationGaps : []).map((g) => ({ from: g.from, to: g.to })),
      natural_exact: r.naturalExact === null || r.naturalExact === undefined ? null : r.naturalExact === true,
    })),
    run_history_limit: CARE_RUN_HISTORY_LIMIT,
    escalate_tasks: args.decision.escalateTasks,
    awaiting_human: args.decision.escalateTasks.length > 0 || args.tasks.some((t) => t.humanLocked === true),
    pending_inspections: args.pendingInspections.map((i) => ({
      id: i.id,
      status: i.status,
      created_at: i.createdAt,
      expires_at: i.expiresAt,
      message_id: i.messageId,
      delivered_at: i.deliveredAt,
      claimed_at: i.claimedAt,
      targets: i.targets.map((t) => ({ goal: t.goal, attempt: t.attempt, child: t.child, outcome: t.outcome })),
    })),
    last_outcome: args.lastOutcome,
    warnings: Array.isArray(args.warnings) ? args.warnings : [],
  };
}

/**
 * 关照唤醒正文（**有界**；只含机读标识与检查清单，不含会话正文/隐藏思维）。
 *
 * 纪律逐条落在正文里：到期不是卡死证据；证据不足不得伪称死循环；三类干预遵守真实能力与人工 gate；
 * 必须用专用窄工具回传**本次** inspectionId + 任务绑定 + progress/no-progress/unknown + 证据。
 */
export function formatCareWakeMessage(input: {
  inspectionId: string;
  targets: Array<{
    goal: string;
    attempt: string;
    child: string;
    elapsedMs: number;
    lastCareAgoMs: number | null;
    stagnantRounds: number;
    maxStagnantRounds: number;
    humanLocked: boolean;
  }>;
  maxStagnantRounds: number;
  lang?: "zh" | "en";
}): string {
  const zh = input.lang !== "en";
  const id = String(input.inspectionId).slice(0, 80);
  const targets = input.targets; // g-506 返工：不得只显示前 8 个而让第 9+ 个任务无法回传
  const lines: string[] = [];
  if (zh) {
    lines.push("【dsh-graph 长任务关照巡检】（计时到期**不是**卡死证据）");
    lines.push(`inspection: ${id}`);
    lines.push("关联运行中任务：");
    for (const t of targets) {
      const elapsed = Math.max(0, Math.round(t.elapsedMs / 60000));
      const since = t.lastCareAgoMs === null ? "首次" : `约 ${Math.max(0, Math.round(t.lastCareAgoMs / 60000))} 分钟前`;
      lines.push(
        `  · goal=${t.goal} attempt=${t.attempt} child=${t.child} 已持续约 ${elapsed} 分钟；距上次关照 ${since}；连续无进展 ${t.stagnantRounds}/${t.maxStagnantRounds}${t.humanLocked ? "（已待人）" : ""}`,
      );
    }
    lines.push("请基于**可访问的近期消息、工具调用/结果、进度与阻塞证据**逐条核对是否僵局：");
    lines.push(`  · ${CARE_STALL_SIGNALS.join(" / ")}`);
    lines.push("纪律：");
    lines.push("- 正常长耗时构建/测试/网络等待、有实质进展的任务不得仅因超时被中断；");
    lines.push("- 证据不足 ⇒ 继续观察或直接询问子代理，不要伪称已发现逻辑死循环；");
    lines.push("- 干预须遵守宿主真实能力与既有人工 gate：" + CARE_PRESERVED_GATES.join(" / ") + "；");
    lines.push("- 本插件**不会**自动中断/放弃/重启子代理；宿主干预 seam 若未验证，只作提醒，由主管按授权流程处理。");
    lines.push("- 有明确僵局证据才请求暂停并确认停稳；放弃重开须先确认旧 child 不运行并按既有准入与返工授权开新 attempt；");
    lines.push("- 无法安全解决 / 范围或判据冲突 ⇒ 停止相关执行并报告人类裁决，禁止无限自动重试。");
    lines.push("结论分类（按定义判断，不得凭 elapsed/预期静默推断）：");
    for (const clause of CARE_OUTCOME_CONTRACT_ZH) lines.push(`  · ${clause}`);
    lines.push(
      `- **必须**用工具 ${"graph_care_outcome"} 回传本次结论：inspection=${id} + 每个目标的 goal/attempt/child + outcome=progress|no-progress|unknown + 证据。未回复/unknown **不增加无进展计数**；同一任务连续 ${CARE_MAX_UNANSWERED_REMINDERS} 次无有效结论（含未回复）即停止自动提醒并等待人工；连续 ${input.maxStagnantRounds} 份新鲜 no-progress 才升级待人。`,
    );
  } else {
    lines.push("[dsh-graph long-task care inspection] (Reaching the timer is NOT evidence of a stall.)");
    lines.push(`inspection: ${id}`);
    lines.push("Associated running tasks:");
    for (const t of targets) {
      const elapsed = Math.max(0, Math.round(t.elapsedMs / 60000));
      const since = t.lastCareAgoMs === null ? "first inspection" : `about ${Math.max(0, Math.round(t.lastCareAgoMs / 60000))} min ago`;
      lines.push(
        `  · goal=${t.goal} attempt=${t.attempt} child=${t.child} running for about ${elapsed} min; last care ${since}; no-progress ${t.stagnantRounds}/${t.maxStagnantRounds}${t.humanLocked ? " (awaiting human)" : ""}`,
      );
    }
    lines.push("Check for a stall using the accessible recent messages, tool calls/results, and progress/blocking evidence:");
    lines.push(`  · ${CARE_STALL_SIGNALS.join(" / ")}`);
    lines.push("Discipline:");
    lines.push("- Long builds/tests/network waits with real progress must not be interrupted merely for taking time;");
    lines.push("- If evidence is insufficient, keep observing or ask the child; never claim a proven infinite loop;");
    lines.push("- Interventions must respect real host capabilities and existing human gates: " + CARE_PRESERVED_GATES.join(" / ") + ";");
    lines.push("- This plugin NEVER auto-interrupts/abandons/restarts a child; unverified host intervention seams are advisory only and must go through authorized human gates.");
    lines.push("- Request a pause only with clear stall evidence, and confirm the child has stopped; abandoning/restarting requires the existing admission and rework authorization;");
    lines.push("- If it cannot be resolved safely or scope/criteria conflict, stop the execution and report to the human; never retry infinitely.");
    lines.push("Outcome definitions (judge by these definitions; never infer from elapsed time or expected silence):");
    for (const clause of CARE_OUTCOME_CONTRACT_EN) lines.push(`  · ${clause}`);
    lines.push(
      `- You MUST report this inspection via the ${"graph_care_outcome"} tool: inspection=${id} + each goal/attempt/child + outcome=progress|no-progress|unknown + evidence. No reply/unknown does NOT increase no-progress; ${CARE_MAX_UNANSWERED_REMINDERS} consecutive reminders without a valid conclusion stop automatic reminders and wait for a human; only ${input.maxStagnantRounds} fresh no-progress results escalate.`,
    );
  }
  return lines.join("\n");
}

// ===== 七、陈旧事件失效（判据 2） =====

/**
 * 投递前**重验运行态**：把「生成提醒时的候选」与「投递时刻的真实运行态」对账。
 *
 * 已结束、取消、换 attempt、child 消失、运行态不可确认 ⇒ 提醒**失效**（返回 `false`）。
 * fail-safe：`liveState === "unknown"` 同样失效（宁可漏一次巡检，绝不把过期提醒投给已结束的任务）。
 */
export function isCareReminderStillValid(candidate: {
  child: string;
  attempt: string;
  bindingVersion?: number;
}, live: {
  child: string;
  attempt: string;
  bindingVersion?: number;
  liveState: "running" | "idle" | "gone" | "unknown";
} | null | undefined): boolean {
  if (!live) return false; // 无法重验 ⇒ 失效
  if (live.child !== candidate.child) return false;
  if (live.attempt !== candidate.attempt) return false; // 换 attempt ⇒ 旧提醒失效
  if (candidate.bindingVersion !== undefined && live.bindingVersion !== undefined
    && candidate.bindingVersion !== live.bindingVersion) return false; // 绑定换代 ⇒ 陈旧
  return live.liveState === "running"; // 只有**确实在跑**才有效
}

// ===== 八、审计（只含机读元数据，绝无会话正文） =====

export interface CareAuditEntry {
  seq: number;
  at: number;
  phase: CarePhase;
  deliver: boolean;
  reason: CareReason;
  /** 主管会话 id（机读标识，非正文）。 */
  supervisor: string | null;
  /** 本次涉及的任务（child/attempt 标识）。 */
  targets: Array<{ child: string; attempt: string; goal: string }>;
  /** 全组最早下一次到期（ms epoch）。 */
  nextDueAt: number | null;
  /** 触发本次决策的僵局信号清单（判断线索，非结论）。 */
  signals: readonly CareStallSignal[];
}

export function makeCareAuditEntry(
  seq: number,
  decision: CareDecision,
  supervisor: string | null,
  at: number,
): CareAuditEntry {
  return {
    seq,
    at,
    phase: decision.phase,
    deliver: decision.deliver,
    reason: decision.reason,
    supervisor,
    targets: decision.tasks.map((t) => ({ child: t.child, attempt: t.attempt, goal: t.goal })),
    nextDueAt: decision.nextDueAt,
    signals: CARE_STALL_SIGNALS,
  };
}

/** 单行审计文本（写入 stderr；**只含机读元数据**）。 */
export function formatCareAudit(entry: CareAuditEntry): string {
  const targets = entry.targets.map((t) => `${t.goal}/${t.child}@${t.attempt}`).join(",") || "-";
  const due = entry.nextDueAt === null ? "-" : new Date(entry.nextDueAt).toISOString();
  return `care #${entry.seq} phase=${entry.phase} deliver=${entry.deliver ? "yes" : "no"} reason=${entry.reason} supervisor=${entry.supervisor ?? "-"} due=${due} targets=${targets}`;
}
